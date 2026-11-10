// ESP32 通道 · 通道日志（ChannelLog 的生产实现）
//
// 契约见 lib/esp32/contracts.js（ChannelLog）：append / recent / metrics。
// 用途：设置页的对话气泡（recent）与耗时 chips（metrics），以及 /api/esp32/log。
//
// 设计：
//   · 纯内存、按 deviceId 分桶、每桶固定容量环形缓冲（默认 200 条），写满丢最旧；
//   · 不落盘 —— 对话正文已经由 brain 写进共享记忆，这里只是「最近发生了什么」的窗口；
//   · recent('') 返回所有设备合并后的时间序（设置页未选设备时用）；
//   · metrics 的 latency 取最近一条带 meta.latency 的记录，turns 统计 user 轮次。
//
// 线程安全：Node 单线程，append/recent 都是同步操作，无需加锁。

const DEFAULT_CAPACITY = 200

/**
 * @param {{capacity?: number, now?: () => number}} [options]
 * @returns {import('../contracts.js').ChannelLog & {clear: Function}}
 */
export function createChannelLog(options = {}) {
  const capacity = Number.isFinite(options.capacity) && options.capacity > 0
    ? Math.trunc(options.capacity)
    : DEFAULT_CAPACITY
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** @type {Map<string, {rows: object[], turns: number, lastAt: number, latency: object, eventLoopMaxMs: number}>} */
  const buckets = new Map()

  function bucketOf(deviceId) {
    const key = String(deviceId ?? '')
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { rows: [], turns: 0, lastAt: 0, latency: {}, eventLoopMaxMs: 0 }
      buckets.set(key, bucket)
    }
    return bucket
  }

  function append(row = {}) {
    const text = String(row.text ?? '').trim()
    if (!text) return
    const role = row.role === 'assistant' || row.role === 'system' ? row.role : 'user'
    const at = now()
    const bucket = bucketOf(row.deviceId)
    const entry = {
      deviceId: String(row.deviceId ?? ''),
      role,
      text,
      at,
      ...(row.meta && typeof row.meta === 'object' ? { meta: row.meta } : {}),
    }
    bucket.rows.push(entry)
    if (bucket.rows.length > capacity) bucket.rows.splice(0, bucket.rows.length - capacity)
    bucket.lastAt = at
    if (role === 'user') bucket.turns += 1
    const latency = row.meta?.latency
    if (latency && typeof latency === 'object') bucket.latency = { ...latency }
    const loopMax = Number(row.meta?.eventLoopMaxMs)
    if (Number.isFinite(loopMax) && loopMax > bucket.eventLoopMaxMs) bucket.eventLoopMaxMs = loopMax
  }

  function recent(deviceId = '', limit = 50) {
    const n = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 50
    const key = String(deviceId ?? '')
    if (key) {
      const bucket = buckets.get(key)
      if (!bucket) return []
      return bucket.rows.slice(-n).map((r) => ({ ...r }))
    }
    // 未指定设备：合并所有桶，按时间排序后取最近 n 条
    const all = []
    for (const bucket of buckets.values()) all.push(...bucket.rows)
    all.sort((a, b) => a.at - b.at)
    return all.slice(-n).map((r) => ({ ...r }))
  }

  function metrics(deviceId = '') {
    const key = String(deviceId ?? '')
    if (key) {
      const bucket = buckets.get(key)
      if (!bucket) return { turns: 0, lastAt: 0, latency: {}, eventLoopMaxMs: 0 }
      return {
        turns: bucket.turns,
        lastAt: bucket.lastAt,
        latency: { ...bucket.latency },
        eventLoopMaxMs: bucket.eventLoopMaxMs,
      }
    }
    let turns = 0
    let lastAt = 0
    let eventLoopMaxMs = 0
    let latency = {}
    for (const bucket of buckets.values()) {
      turns += bucket.turns
      if (bucket.lastAt > lastAt) { lastAt = bucket.lastAt; latency = { ...bucket.latency } }
      if (bucket.eventLoopMaxMs > eventLoopMaxMs) eventLoopMaxMs = bucket.eventLoopMaxMs
    }
    return { turns, lastAt, latency, eventLoopMaxMs }
  }

  function clear(deviceId) {
    if (deviceId === undefined) buckets.clear()
    else buckets.delete(String(deviceId ?? ''))
  }

  return { append, recent, metrics, clear }
}
