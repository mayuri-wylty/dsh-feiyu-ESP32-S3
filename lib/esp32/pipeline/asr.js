// ESP32 通道 · T21 ASR 链
//
// 把「上行 PCM → VAD 切段 → 预滚缓冲裁剪 → WAV → ASR → stt 下发」串成一条管线。
//
// 数据流：
//   onAudio(16k PCM) ──┬─→ vad.push() → speech_start / speech_end 事件
//                      └─→ preroll 环形缓冲（固定容量，覆盖 maxSpeechMs + 余量）
//   speech_end(atMs) → preroll.slice(startSample, endSample) → writePcmWav(16k/mono)
//                    → asr.transcribe({wav, sampleRate:16000, signal})
//                    → ctx.sendStt(text) → 回落 listening
//
// 关键设计：
//   · VAD 只给时间点、不存音频（见 lib/esp32/vad.js 文件头），所以预滚缓冲是必须的；
//     容量 = maxSpeechMs + silenceMs + 2s 余量，写满覆盖最旧样本，内存有界。
//   · 转写任务走串行队列：一次只跑一个 ASR，避免设备连续说话时并发请求打乱顺序。
//   · 空转写 / 超时 / ASR 抛错只记日志，不 sendStt、不崩会话。
//   · manual 模式（listen stop 结束整段）没有 VAD 事件时，用 [listenStart, now) 整段转写。
//
// 契约见 lib/esp32/contracts.js（Esp32SessionPipeline / AsrProvider / AUDIO）。

import { writePcmWav } from '../audio/wav.js'
import { createVad } from '../vad.js'
import {
  UPLINK_RATE,
  createPrerollBuffer,
  createSerialQueue,
  createTurnController,
  isAbortError,
  messageOf,
  msToSamples,
} from './common.js'

const DEFAULT_PREROLL_MARGIN_MS = 2_000

/**
 * @param {{
 *   ctx: import('../contracts.js').Esp32SessionContext,
 *   asr: import('../contracts.js').AsrProvider,
 *   vad?: object,
 *   config?: {vad?: {silenceMs?: number, minSpeechMs?: number, maxSpeechMs?: number}},
 *   logger?: object,
 *   prerollMarginMs?: number,
 *   language?: string,
 *   onTranscript?: (text: string, meta: {signal: AbortSignal|null, reason: string}) => unknown,
 * }} options
 * @returns {import('../contracts.js').Esp32SessionPipeline & {
 *   stats: {segments: number, transcribed: number, empty: number, failed: number, skipped: number},
 *   preroll: object,
 * }}
 */
export function createAsrPipeline({
  ctx,
  asr,
  vad,
  config,
  logger,
  prerollMarginMs = DEFAULT_PREROLL_MARGIN_MS,
  language,
  onTranscript,
} = {}) {
  if (!ctx) throw new TypeError('createAsrPipeline: 需要会话 ctx')
  if (!asr || typeof asr.transcribe !== 'function') {
    throw new TypeError('createAsrPipeline: 需要带 transcribe() 的 asr provider')
  }
  const log = logger ?? ctx.logger ?? {}
  const vadConfig = config?.vad ?? {}
  const silenceMs = positive(vadConfig.silenceMs, 700)
  const minSpeechMs = positive(vadConfig.minSpeechMs, 250)
  const maxSpeechMs = positive(vadConfig.maxSpeechMs, 30_000)

  // VAD 归属：默认由管线自己持有并从 onAudio 喂帧（宿主没有给会话注入 VAD）。
  // 显式传 vad:null 表示「会话已注入 VAD，事件走 onVad」，此时管线不再自己跑 VAD。
  const vadImpl = vad === null ? null : (vad ?? createVad({ silenceMs, minSpeechMs, maxSpeechMs }))
  // 只有管线自建的 VAD 才能被我们 reset（时间轴归零）；外部注入的 VAD 归会话所有。
  const ownsVad = vad === undefined
  const preroll = createPrerollBuffer({
    sampleRate: UPLINK_RATE,
    capacityMs: maxSpeechMs + silenceMs + prerollMarginMs,
  })
  const queue = createSerialQueue()
  const turn = createTurnController()

  const stats = { segments: 0, transcribed: 0, empty: 0, failed: 0, skipped: 0 }
  const handledEvents = new WeakSet()

  let closed = false
  let aborted = false
  let segmentStartSample = -1 // 当前语音段起点（绝对样本序号）
  let listenStartSample = 0 // 本轮 listen 起点（manual 模式整段转写用）
  let manualSegmentUsed = false
  // VAD 时间轴与预滚缓冲的对齐：abort/close 会清空 preroll（totalSamples 归零），
  // 外部注入的 VAD 时间轴却是累计的（不归本管线管）。此时记录已丢弃的样本数，
  // 把事件 atMs 换算回当前缓冲时间轴；自建 VAD 则直接 reset() 让时间轴归零。
  let vadSampleOffset = 0

  function resetSegment() {
    segmentStartSample = -1
  }

  /** VAD 累计时间点 → 当前预滚缓冲的样本序号。 */
  function eventSampleAt(atMs) {
    return msToSamples(atMs, UPLINK_RATE) - vadSampleOffset
  }

  /**
   * 清空缓冲并重置时间轴：自建 VAD 一并 reset（时间轴归零）；
   * 外部注入的 VAD 不能由我们重置，改为记录已丢弃样本数做偏移修正。
   */
  function recycleBuffer() {
    const dropped = preroll.totalSamples
    preroll.clear()
    listenStartSample = 0
    if (!ownsVad) {
      vadSampleOffset += dropped
      return
    }
    vadSampleOffset = 0
    try {
      vadImpl.reset?.()
    } catch (error) {
      log.warn?.('VAD 重置失败', { deviceId: ctx.deviceId, error: messageOf(error) })
    }
  }

  /** 裁剪 + 打包 WAV + 转写 + 下发。串行执行。 */
  function transcribeRange(startSample, endSample, reason) {
    const start = Math.max(0, Math.floor(startSample))
    const end = Math.min(Math.floor(endSample), preroll.totalSamples)
    const samples = end - start
    if (samples < msToSamples(minSpeechMs, UPLINK_RATE)) {
      stats.skipped += 1
      log.debug?.('ASR 段过短，跳过', { deviceId: ctx.deviceId, samples, reason })
      return Promise.resolve(null)
    }
    const pcm = preroll.slice(start, end)
    if (pcm.length === 0) {
      stats.skipped += 1
      return Promise.resolve(null)
    }
    stats.segments += 1
    const wav = writePcmWav(pcm, UPLINK_RATE, 1)
    const signal = turn.signal

    return queue.enqueue(async () => {
      if (closed || aborted || signal?.aborted) return null
      ctx.transition('recognizing', { reason: `asr:${reason}` })
      let result
      try {
        result = await asr.transcribe({ wav, sampleRate: UPLINK_RATE, language, signal })
      } catch (error) {
        if (isAbortError(error) || signal?.aborted || aborted) {
          log.debug?.('ASR 转写被取消', { deviceId: ctx.deviceId, reason })
          return null
        }
        stats.failed += 1
        log.warn?.('ASR 转写失败', { deviceId: ctx.deviceId, error: messageOf(error) })
        fallbackToListening()
        return null
      }
      if (closed || aborted || signal?.aborted) return null

      const text = String(result?.text ?? '').trim()
      if (!text) {
        stats.empty += 1
        log.debug?.('ASR 返回空文本', { deviceId: ctx.deviceId, ms: result?.ms })
        fallbackToListening()
        return null
      }
      stats.transcribed += 1
      if (typeof onTranscript === 'function') {
        // 上层（T22 问答管线）接管后续：自己决定状态迁移与下发。
        try {
          await onTranscript(text, { signal, reason })
        } catch (error) {
          if (!isAbortError(error) && !signal?.aborted) {
            log.warn?.('转写后续处理失败', { deviceId: ctx.deviceId, error: messageOf(error) })
          }
        }
        return text
      }
      ctx.sendStt(text)
      fallbackToListening()
      return text
    })
  }

  function fallbackToListening() {
    if (closed) return
    if (ctx.getState() === 'recognizing') {
      ctx.transition('listening', { reason: 'asr:done' })
    }
  }

  function handleVadEvent(event, meta) {
    if (closed || aborted || !event || typeof event !== 'object') return
    if (handledEvents.has(event)) return
    handledEvents.add(event)
    const signal = meta?.signal ?? turn.signal

    if (event.type === 'speech_start') {
      segmentStartSample = eventSampleAt(event.atMs)
      manualSegmentUsed = true
      return
    }
    if (event.type !== 'speech_end') return

    const endSample = eventSampleAt(event.atMs)
    const startSample = segmentStartSample >= 0 ? segmentStartSample : listenStartSample
    resetSegment()
    if (signal?.aborted) return
    void transcribeRange(startSample, endSample, event.reason ?? 'vad')
  }

  return {
    onAudio(frame, meta) {
      if (closed || !(frame instanceof Int16Array) || frame.length === 0) return
      preroll.push(frame)
      if (!vadImpl || typeof vadImpl.push !== 'function') return
      let events
      try {
        events = vadImpl.push(frame)
      } catch (error) {
        log.warn?.('VAD 处理失败，本段不再切分', { deviceId: ctx.deviceId, error: messageOf(error) })
        return
      }
      if (!Array.isArray(events)) return
      for (const event of events) handleVadEvent(event, { signal: turn.signal })
    },

    onVad(event, meta) {
      // 会话自带 VAD 时由会话回调进来；与 onAudio 内部 VAD 用 WeakSet 去重。
      handleVadEvent(event, meta)
    },

    onListenStart() {
      aborted = false
      turn.begin(ctx.getSignal())
      listenStartSample = preroll.totalSamples
      manualSegmentUsed = false
      resetSegment()
    },

    onListenStop() {
      if (closed) return
      // manual 模式：没有 VAD 事件时把整段（listen start 至今）送 ASR。
      if (!manualSegmentUsed && segmentStartSample < 0) {
        const end = preroll.totalSamples
        if (end > listenStartSample) {
          void transcribeRange(listenStartSample, end, 'listen_stop')
        }
        return
      }
      // auto 模式：把仍在进行的语音段收尾（VAD 未及发 speech_end 就 stop）。
      if (segmentStartSample >= 0) {
        const start = segmentStartSample
        resetSegment()
        void transcribeRange(start, preroll.totalSamples, 'listen_stop')
      }
    },

    onAbort() {
      aborted = true
      turn.end('abort')
      resetSegment()
      recycleBuffer()
    },

    onClose() {
      closed = true
      aborted = true
      turn.end('close')
      resetSegment()
      recycleBuffer()
    },

    stats,
    preroll,
    /** 等待所有在途转写结束（测试用）。 */
    async drain() {
      await queue.drain()
    },
  }
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
