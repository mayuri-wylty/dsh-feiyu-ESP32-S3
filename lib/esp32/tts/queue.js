// T16：进程内 TTS 串行优先队列
//
// 为什么要队列：GPT-SoVITS api_v2 是单实例 Python 服务，同一时刻只能吃一个 /tts 请求。
// ESP32 实时通道（一句接一句）和我们自己的批量合成（视频/长文本）如果在同一进程里
// 各发各的，就会互相排队在 9880 里，实时语音的首包延迟完全不可控。
//
// 规则：
//   · 全进程同一时刻最多 1 个任务在跑（严格串行，不并发 9880）；
//   · 两条 FIFO 泳道：realtime 优先于 normal；只有当前任务结束后才取下一个；
//   · 排队中 abort → 立即从泳道移除并拒绝，任务永不执行；
//   · 运行中 abort → 调用方立即收到 AbortError，但队列**不会**提前启动下一条，
//     必须等底层任务真正结束（fetch 收到 abort 后会自行退出），保持“最多一个请求在途”；
//   · 任务失败不影响后续任务。
//
// 用法：
//   import { getTtsQueue, TTS_PRIORITY } from './queue.js'
//   const q = getTtsQueue()
//   await q.enqueue(() => synthBatch(), { priority: TTS_PRIORITY.NORMAL })
//   await q.enqueue(() => synthRealtime(), { priority: TTS_PRIORITY.REALTIME, signal })

export const TTS_PRIORITY = Object.freeze({
  REALTIME: 'realtime',
  NORMAL: 'normal',
})

/** 把 AbortSignal.reason 规范成带 name === 'AbortError' 的异常。 */
export function abortErrorOf(signal) {
  const reason = signal?.reason
  if (reason && typeof reason === 'object' && typeof reason.name === 'string') return reason
  const e = new Error('TTS 任务已取消')
  e.name = 'AbortError'
  e.code = 'ABORT_ERR'
  return e
}

/**
 * 创建一个串行优先队列。一般用 getTtsQueue() 拿进程内单例；
 * 测试/独立子系统可以自己 createTtsQueue() 隔离。
 */
export function createTtsQueue() {
  const lanes = { [TTS_PRIORITY.REALTIME]: [], [TTS_PRIORITY.NORMAL]: [] }
  let current = null
  let done = 0
  let failed = 0
  let aborted = 0

  const queuedCount = () => lanes[TTS_PRIORITY.REALTIME].length + lanes[TTS_PRIORITY.NORMAL].length
  const size = () => (current ? 1 : 0) + queuedCount()

  function stats() {
    return {
      running: current ? 1 : 0,              // 0 | 1：全队列最多一个
      queued: queuedCount(),
      size: size(),                          // running + queued
      realtime: lanes[TTS_PRIORITY.REALTIME].length,
      normal: lanes[TTS_PRIORITY.NORMAL].length,
      done,                                  // 正常完成（未被调用方 abort）
      failed,                                // 任务抛错（未被调用方 abort）
      aborted,                               // 调用方取消（排队中或运行中）
    }
  }

  function detach(job) {
    if (job.signal && job.onAbort) {
      try { job.signal.removeEventListener('abort', job.onAbort) } catch {}
    }
    job.onAbort = null
  }

  /** 只结束“调用方那一侧”的 promise；底层任务状态由 pump 的 finally 收尾。 */
  function settleCaller(job, err, value) {
    if (job.callerSettled) return false
    job.callerSettled = true
    detach(job)
    if (err) job.reject(err)
    else job.resolve(value)
    return true
  }

  function removeQueued(job) {
    for (const lane of [lanes[TTS_PRIORITY.REALTIME], lanes[TTS_PRIORITY.NORMAL]]) {
      const i = lane.indexOf(job)
      if (i >= 0) {
        lane.splice(i, 1)
        return true
      }
    }
    return false
  }

  function onAbort(job) {
    if (job.callerSettled) return
    // 运行中的任务不在这里出队/启动下一条：等它自己结束，严格保证同一时刻只有一个请求
    if (!job.running) removeQueued(job)
    aborted += 1
    settleCaller(job, abortErrorOf(job.signal))
  }

  async function pump() {
    if (current) return
    const job = lanes[TTS_PRIORITY.REALTIME].shift() || lanes[TTS_PRIORITY.NORMAL].shift()
    if (!job) return
    current = job
    job.running = true
    try {
      const value = await job.task(job.signal)
      if (settleCaller(job, null, value)) done += 1
    } catch (e) {
      if (settleCaller(job, e)) failed += 1
    } finally {
      job.running = false
      current = null
      detach(job)
      void pump()
    }
  }

  /**
   * @template T
   * @param {(signal: AbortSignal|undefined) => T|Promise<T>} task
   * @param {{priority?: 'realtime'|'normal', signal?: AbortSignal}} [opts]
   * @returns {Promise<T>}
   */
  function enqueue(task, opts = {}) {
    if (typeof task !== 'function') throw new TypeError('TTS 队列任务必须是函数')
    const signal = opts.signal
    if (signal?.aborted) {
      aborted += 1
      return Promise.reject(abortErrorOf(signal))
    }

    const job = {
      task,
      signal: signal ?? null,
      priority: opts.priority === TTS_PRIORITY.REALTIME ? TTS_PRIORITY.REALTIME : TTS_PRIORITY.NORMAL,
      running: false,
      callerSettled: false,
      onAbort: null,
      resolve: null,
      reject: null,
    }
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    if (signal) {
      job.onAbort = () => onAbort(job)
      signal.addEventListener('abort', job.onAbort, { once: true })
    }
    lanes[job.priority].push(job)
    void pump()
    return promise
  }

  return { enqueue, size, stats }
}

let sharedQueue = null

/** 进程内共享队列：ESP32 实时通道与批量合成都必须拿这一个，才能互斥 9880。 */
export function getTtsQueue() {
  if (!sharedQueue) sharedQueue = createTtsQueue()
  return sharedQueue
}
