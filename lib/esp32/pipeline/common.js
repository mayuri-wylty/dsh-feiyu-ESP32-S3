// ESP32 通道 · 管线公共件（T20-T22）
//
// 三个管线（echo / asr / qa）共用的底层工具，全部无全局状态、每会话一份：
//   · createPrerollBuffer   固定容量环形预滚缓冲（VAD 只给时间点，音频要自己留）
//   · createDownlinkFramer  重采样 → 1440 点切帧 → Opus 编码 → ctx.sendBinary
//   · createSerialQueue     串行 async 队列（保证音频帧/句子不并发打乱顺序）
//   · createTurnController  每轮 AbortController，转发会话轮次 signal
//
// 契约见 lib/esp32/contracts.js（AUDIO / Esp32SessionContext / Esp32SessionPipeline）。

import { AUDIO } from '../contracts.js'
import { OpusDownlinkEncoder } from '../audio/opus.js'
import { resamplePcm } from '../audio/resample.js'

export const UPLINK_RATE = AUDIO.uplink.sampleRate
export const DOWNLINK_RATE = AUDIO.downlink.sampleRate
export const DOWNLINK_FRAME_SAMPLES = AUDIO.downlink.samplesPerFrame

export const messageOf = (error) =>
  error && typeof error.message === 'string' ? error.message : String(error ?? '')

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

export const msToSamples = (ms, sampleRate) =>
  Math.round(((Number(ms) || 0) * sampleRate) / 1000)

export const samplesToMs = (samples, sampleRate) => (samples * 1000) / sampleRate

/**
 * 固定容量环形 PCM 缓冲。
 *
 * VAD 只报告 speech_start / speech_end 的时间点，不保存音频；管线必须自己留一段
 * 预滚音频，才能在 speech_end 时按 atMs 裁出完整语音。容量固定（默认 maxSpeechMs
 * + 余量），写满后覆盖最旧样本，内存有界。
 *
 * 绝对样本序号从 0 开始单调递增；`slice(start, end)` 用绝对序号取区间，
 * 超出保留窗口的部分自动裁剪。
 *
 * @param {{sampleRate?: number, capacityMs?: number}} [options]
 */
export function createPrerollBuffer({ sampleRate = UPLINK_RATE, capacityMs = 32_000 } = {}) {
  const rate = Number(sampleRate)
  const capacity = Math.max(1, Math.ceil((rate * Math.max(1, Number(capacityMs) || 1)) / 1000))
  const buf = new Int16Array(capacity)
  let write = 0 // 下一个写入位置（= total % capacity）
  let total = 0 // 累计写入样本数

  return {
    get capacity() {
      return capacity
    },
    get totalSamples() {
      return total
    },
    /** 当前保留窗口的起始绝对序号。 */
    get oldestSample() {
      return Math.max(0, total - capacity)
    },
    push(pcm) {
      if (!(pcm instanceof Int16Array) || pcm.length === 0) return
      for (let i = 0; i < pcm.length; i++) {
        buf[write] = pcm[i]
        write = (write + 1) % capacity
        total += 1
      }
    },
    /**
     * 取绝对序号区间 [startSample, endSample) 的 PCM 副本。
     * 区间被裁剪到当前保留窗口内；空区间返回空数组。
     */
    slice(startSample, endSample) {
      const oldest = Math.max(0, total - capacity)
      const s = Math.max(Math.floor(startSample), oldest)
      const e = Math.min(Math.floor(endSample), total)
      if (!(e > s)) return new Int16Array(0)
      const out = new Int16Array(e - s)
      for (let a = s; a < e; a++) out[a - s] = buf[a % capacity]
      return out
    },
    clear() {
      write = 0
      total = 0
      buf.fill(0)
    },
  }
}

/**
 * 下行组帧器：任意采样率/长度的 PCM → 24k/1440 点 Opus 帧 → ctx.sendBinary。
 *
 * 跨调用保留不足一帧的残余样本（重采样器输出长度可能不是 1440 的整数倍，
 * TTS 的 chunk 边界也任意）。`flush()` 把残余补零成完整帧下发，避免丢尾音。
 *
 * @param {{
 *   ctx: import('../contracts.js').Esp32SessionContext,
 *   encoder?: {encode: Function, close?: Function},
 *   frameSamples?: number,
 *   sampleRate?: number,
 *   logger?: object,
 * }} options
 */
export function createDownlinkFramer({
  ctx,
  encoder,
  frameSamples = DOWNLINK_FRAME_SAMPLES,
  sampleRate = DOWNLINK_RATE,
  logger,
} = {}) {
  if (!ctx || typeof ctx.sendBinary !== 'function') {
    throw new TypeError('createDownlinkFramer: 需要带 sendBinary 的 ctx')
  }
  const enc = encoder ?? new OpusDownlinkEncoder()
  const ownsEncoder = !encoder
  const frameSize = Math.max(1, Math.floor(frameSamples))
  let pending = new Int16Array(0)
  let sentFrames = 0
  let closed = false

  function append(pcm) {
    if (pcm.length === 0) return
    const next = new Int16Array(pending.length + pcm.length)
    next.set(pending, 0)
    next.set(pcm, pending.length)
    pending = next
  }

  function emit(frame) {
    if (closed) return false
    let packet
    try {
      packet = enc.encode(frame)
    } catch (error) {
      logger?.warn?.('下行 Opus 编码失败，丢弃该帧', { error: messageOf(error) })
      return false
    }
    const ok = ctx.sendBinary(packet)
    if (ok) sentFrames += 1
    return ok
  }

  function drain() {
    while (pending.length >= frameSize) {
      const frame = pending.subarray(0, frameSize)
      pending = pending.subarray(frameSize)
      emit(frame)
    }
  }

  return {
    /**
     * 追加一块 PCM。fromRate 与目标采样率不同时先做多相 FIR 重采样。
     * @returns {number} 本次重采样后的样本数
     */
    push(pcm, fromRate = sampleRate) {
      if (closed || !(pcm instanceof Int16Array) || pcm.length === 0) return 0
      const rate = Number(fromRate) || sampleRate
      const resampled = rate === sampleRate ? pcm : resamplePcm(pcm, rate, sampleRate)
      append(resampled)
      drain()
      return resampled.length
    },
    /** 把残余样本补零成完整帧下发（pad=false 时直接丢弃）。 */
    flush({ pad = true } = {}) {
      if (closed || pending.length === 0) return 0
      if (!pad) {
        pending = new Int16Array(0)
        return 0
      }
      const frame = new Int16Array(frameSize)
      frame.set(pending)
      pending = new Int16Array(0)
      emit(frame)
      return 1
    },
    /** 丢弃残余样本（打断/新轮次）。 */
    reset() {
      pending = new Int16Array(0)
    },
    close() {
      if (closed) return
      closed = true
      pending = new Int16Array(0)
      if (ownsEncoder) {
        try {
          enc.close?.()
        } catch { /* 释放失败不影响会话 */ }
      }
    },
    get pendingSamples() {
      return pending.length
    },
    get sentFrames() {
      return sentFrames
    },
  }
}

/**
 * 串行 async 队列：同一时刻只跑一个任务，按入队顺序执行。
 * 任务抛错只影响该任务的返回 promise，不阻塞后续任务。
 */
export function createSerialQueue() {
  let tail = Promise.resolve()
  let pending = 0
  return {
    enqueue(fn) {
      pending += 1
      const run = tail.then(() => fn())
      tail = run.then(
        () => {
          pending -= 1
        },
        () => {
          pending -= 1
        },
      )
      return run
    },
    get pending() {
      return pending
    },
    async drain() {
      await tail
    },
  }
}

/**
 * 每轮一个 AbortController，并把会话轮次 signal 的 abort 转发进来。
 * 这样管线既能响应设备 abort，也能在 onClose / 新轮次时主动取消在途任务。
 */
export function createTurnController() {
  let controller = null
  let detach = null

  function release() {
    if (detach) {
      try {
        detach()
      } catch { /* 忽略 */ }
      detach = null
    }
  }

  return {
    /** 开始新一轮；externalSignal 为会话轮次 signal（可为 null）。 */
    begin(externalSignal) {
      this.end('superseded')
      controller = new AbortController()
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason)
        } else {
          const onAbort = () => controller?.abort(externalSignal.reason)
          externalSignal.addEventListener('abort', onAbort, { once: true })
          detach = () => externalSignal.removeEventListener('abort', onAbort)
        }
      }
      return controller.signal
    },
    /** 结束当前轮次（幂等）。 */
    end(reason = 'turn_end') {
      release()
      if (controller && !controller.signal.aborted) {
        try {
          controller.abort(reason)
        } catch { /* 忽略 */ }
      }
      controller = null
    },
    get signal() {
      return controller?.signal ?? null
    },
    get aborted() {
      return controller ? controller.signal.aborted : true
    },
  }
}
