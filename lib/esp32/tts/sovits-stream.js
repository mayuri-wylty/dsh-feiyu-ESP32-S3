// T18：GPT-SoVITS 流式 TTS provider（contracts.js → TtsProvider）
//
// 形状：
//   { id: 'sovits-stream', stream(text, { emotion?, signal? }) }
//   stream 返回 AsyncIterable<{ pcm: Int16Array, sampleRate }>；每块都是已下混为
//   mono 的 PCM16LE 帧，采样率以 WAV 头为准。下游（A 道会话）仍按 chunk.sampleRate
//   重采样到 24k 后再组 60ms 帧。
//
// ── 真实 9880 语义（2026-11-10 核对 D:\GPT-SoVITS\api_v2.py + 实测）──────────
//   POST /tts body: streaming_mode 必须是整数 2（True == 1 会走 return_fragment，
//   是另一条“定长片段”路径）。api_v2 的 `tts_handle` 对 2 的处理是：
//     streaming_mode = True, return_fragment = False
//   响应头是 Content-Type: audio/wav，但 body 实际是：
//     · 开头**一次性** 44 字节 wave 头（wave_header_chunk：mono / 16bit，
//       data chunk 的 size 字段为 0，因为长度未知）；
//     · 之后全部是裸 PCM16LE（pack_audio(media_type='raw')），chunk 边界任意，
//       没有逐块头，也不会再出现 RIFF 头。
//   服务端错误（空文本、合成失败等）返回非 2xx JSON。
//   2026-11-10 真实 9880 实测（32k mono，6.38s 音频；同一脚本跑两次）：
//     第 1 次：响应头 38.5ms；首网络字节 1084.8ms；首 PCM 块 1085.6ms；总耗时 4470.8ms；
//     第 2 次：响应头 51.0ms；首网络字节 596.9ms；首 PCM 块 598.1ms；总耗时 3151.8ms；
//     两次均 8 个网络 chunk / 7 个 PCM chunk；204160 samples / 408320 PCM 字节；
//     RIFF、WAVE 各只出现 1 次；data size 字段为 0；残量 0 字节。
//
// ── 队列 ────────────────────────────────────────────────────────────────────
// 整条流（从发请求到最后一块）占用 getTtsQueue() 的串行槽位：queue.enqueue 的
// task Promise 在底层 HTTP 流真正结束后才结算。网络读取跑在 task 里，通过内部
// channel 把已解码 chunk 推给 async generator；消费方提前 break 或 signal abort
// 时会 abort 内部 fetch（并让排队中的任务直接出队），保证不会出现第二个 9880
// 请求与这条流重叠。
//
// ── 超时 ────────────────────────────────────────────────────────────────────
// timeoutMs 是**空闲超时**，不是整条流的总时长：从请求开始计时，每收到一段网络
// 数据重新计时；只有连续 timeoutMs 没有任何数据才报 TimeoutError。它覆盖连接建立、
// 等待响应头、首字节，以及流中途卡死；长句只要持续出数据就不会被总时长误杀。
//
// ── abort ───────────────────────────────────────────────────────────────────
// signal abort 后：立即终止 fetch、立即停止 yield（内部 channel 直接以 AbortError
// 失败并清空缓存），队列槽位在底层任务结束后释放（与 T16 队列语义一致）。

import { buildSovitsRequest } from '../../../tools/lib/tts.mjs'
import { config } from '../../../tools/lib/config.mjs'
import { abortErrorOf, getTtsQueue, TTS_PRIORITY } from './queue.js'

export const SOVITS_STREAM_ID = 'sovits-stream'
export const DEFAULT_SOVITS_URL = 'http://127.0.0.1:9880/tts'
export const DEFAULT_TIMEOUT_MS = 30_000

const EMPTY = Buffer.alloc(0)
const STDERR_BODY_CHARS = 300

/**
 * 创建流式 provider。默认使用进程内共享队列，保证与批量合成互斥 9880。
 *
 * @param {object} [options]
 * @param {import('./queue.js').TtsQueue} [options.queue] 自定义队列（测试隔离用）
 * @param {object} [options.voice] 覆盖 config().voice（sovits_url/text_lang/top_k…）
 * @param {object} [options.override] 请求覆盖项（text_split_method/temperature…）
 * @param {{ref_audio_path:string, prompt_text:string, from?:string}} [options.ref] 固定参考段
 * @param {object} [options.profile] 固定情绪参数（跳过 emotionProfile）
 * @param {string} [options.url] 直接指定 9880 端点
 * @param {number} [options.timeoutMs] 空闲超时（默认 30s；每收到数据重新计时）
 * @param {typeof fetch} [options.fetch] 注入 fetch（测试用）
 * @param {'realtime'|'normal'} [options.priority] 队列优先级，默认 realtime
 * @param {(message: string) => void} [options.warn] 非致命告警（如流末尾残字节）
 * @returns {import('../contracts.js').TtsProvider}
 */
export function createSovitsStreamProvider(options = {}) {
  const queue = options.queue ?? getTtsQueue()
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('createSovitsStreamProvider 需要可用的 fetch')

  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const priority = options.priority === TTS_PRIORITY.NORMAL ? TTS_PRIORITY.NORMAL : TTS_PRIORITY.REALTIME
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn

  /** @type {import('../contracts.js').TtsStreamFn} */
  async function* stream(text, opts = {}) {
    const { emotion, signal } = opts ?? {}
    if (signal?.aborted) throw abortErrorOf(signal)

    const voice = options.voice ?? config().voice ?? {}
    const req = buildSovitsRequest(text, {
      emotion,
      voice,
      override: options.override,
      ref: options.ref,
      profile: options.profile,
      url: options.url || voice.sovits_url || DEFAULT_SOVITS_URL,
      mediaType: 'wav',
      streamingMode: 2, // 整数 2：真流式、非定长（true 会变成 return_fragment）
    })

    // 消费方主动结束（break）时也要能取消底层请求，所以单独一个 controller；
    // 它和用户 signal 合并后交给队列：排队中取消 → 队列直接移除，不会白占槽位。
    const stopCtl = new AbortController()
    const queueSignal = combineSignals(signal, stopCtl.signal)
    const channel = createChunkChannel()

    const onAbort = () => {
      // 立即让生成器停止产出（不等 fetch/队列的异步收尾）
      channel.fail(abortErrorOf(signal))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    let completed = false
    try {
      const task = queue.enqueue(
        (jobSignal) => pumpStream(req, {
          fetchImpl,
          signal: jobSignal,
          timeoutMs,
          warn,
          onChunk: (chunk) => { channel.push(chunk) },
        }),
        { priority, signal: queueSignal },
      )
      // 任务结束/失败 → 关闭 channel。注意 queue 在调用方 abort 时会先结算
      // caller promise（但底层任务仍继续），这里把 AbortError 传给消费方即可。
      task.then(
        () => channel.end(),
        (e) => channel.fail(e),
      )

      for await (const chunk of channel) {
        // abort 与 yield 之间的最后一道闸：abort 后绝不再吐 chunk
        if (signal?.aborted) throw abortErrorOf(signal)
        yield chunk
      }
      completed = true
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (!completed) {
        // 消费方提前 break / 抛错 / abort：终止 fetch，让队列槽位尽快释放。
        // 注意不能只看 channel.closed：inner for-await 退出时会先关闭 channel，
        // 但底层任务还在读网络，必须显式 abort 才会结束。
        try { stopCtl.abort() } catch {}
        channel.cancel()
      }
    }
  }

  return { id: SOVITS_STREAM_ID, stream }
}

/** 默认 provider（使用进程内共享队列；首次 import 时创建，不读配置）。 */
export const sovitsStreamProvider = createSovitsStreamProvider()

// ── 网络流 → 解码后的 PCM chunk ─────────────────────────────────────────────

async function pumpStream(req, { fetchImpl, signal, timeoutMs, warn, onChunk }) {
  if (signal?.aborted) throw abortErrorOf(signal)

  const timeoutCtl = new AbortController()
  let timeoutHit = false
  let timer = null

  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timeoutHit = true
      try { timeoutCtl.abort() } catch {}
    }, timeoutMs)
    timer.unref?.()
  }
  const disarm = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  const combined = combineSignals(signal, timeoutCtl.signal)
  let reader = null
  arm()
  try {
    let res
    try {
      res = await raceSignal(
        fetchImpl(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
          signal: combined,
        }),
        combined,
        () => timeoutHit ? timeoutError(timeoutMs) : abortErrorOf(signal),
      )
    } catch (e) {
      throw normalizeStreamError(e, { signal, timeoutHit, timeoutMs })
    }

    arm() // 响应头到达也算一次活动（首字节计时单独从此刻重新开始）

    if (!res.ok) {
      let detail = ''
      try {
        detail = await readTextPrefix(res, STDERR_BODY_CHARS, {
          signal: combined,
          makeError: () => timeoutHit ? timeoutError(timeoutMs) : abortErrorOf(signal),
        })
      } catch (e) {
        throw normalizeStreamError(e, { signal, timeoutHit, timeoutMs })
      }
      if (timeoutHit) throw timeoutError(timeoutMs)
      if (signal?.aborted) throw abortErrorOf(signal)
      throw streamError(`GPT-SoVITS 流式 HTTP ${res.status}${detail ? `：${detail}` : ''}`, { status: res.status })
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      throw streamError('GPT-SoVITS 流式响应没有可读的 body（需要 Node 18+ 的 fetch）')
    }

    reader = res.body.getReader()
    const decoder = createWavStreamDecoder({ warn })

    while (true) {
      let step
      try {
        step = await raceSignal(
          reader.read(),
          combined,
          () => timeoutHit ? timeoutError(timeoutMs) : abortErrorOf(signal),
        )
      } catch (e) {
        throw normalizeStreamError(e, { signal, timeoutHit, timeoutMs })
      }
      if (step.done) break

      if (signal?.aborted) throw abortErrorOf(signal)
      arm() // 每收到一段网络数据重新计时（空闲超时）

      const chunk = decoder.push(step.value)
      if (chunk) {
        if (signal?.aborted) throw abortErrorOf(signal)
        onChunk(chunk)
      }
    }

    const stats = decoder.flush()
    if (!stats.totalSamples) {
      throw streamError('GPT-SoVITS 流式响应没有 PCM 数据（可能合成失败）')
    }
    return stats
  } finally {
    disarm()
    if (reader) {
      try { await reader.cancel() } catch {}
      try { reader.releaseLock?.() } catch {}
    }
  }
}

// ── 增量 WAV 头解析 + PCM16 解码 ───────────────────────────────────────────

/**
 * 创建一个流式 WAV 解码器：接受任意边界的网络 chunk，先拼出 WAV 头（可能是
 * 44 字节标准头，也兼容 fmt/data 前带其它 chunk / WAVE_FORMAT_EXTENSIBLE），
 * 之后把裸 PCM16LE 转成 Int16Array。
 *
 * 语义与 wav.js 的 parseWavToPcm 一致：
 *   · 只支持 16bit PCM（format 1；EXTENSIBLE 取其 SubFormat）；
 *   · channels !== 1 时按帧平均下混成 mono；
 *   · 数据按“帧”切分，不足一帧的尾巴留到下一块；流结束时仍剩字节则丢弃并 warn。
 *
 * @param {{warn?: (message:string)=>void}} [opts]
 */
export function createWavStreamDecoder(opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : defaultWarn

  let headerBuf = EMPTY
  let headerDone = false
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let remainder = EMPTY
  let bytes = 0
  let pcmBytes = 0
  let totalSamples = 0

  function decodePcm(buf) {
    const frameBytes = channels * 2
    const all = remainder.length ? Buffer.concat([remainder, buf]) : buf
    const frames = Math.floor(all.length / frameBytes)
    const used = frames * frameBytes
    remainder = used < all.length ? Buffer.from(all.subarray(used)) : EMPTY
    if (!frames) return null

    const pcm = new Int16Array(frames)
    if (channels === 1) {
      for (let i = 0; i < frames; i++) pcm[i] = all.readInt16LE(i * 2)
    } else {
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += all.readInt16LE((i * channels + c) * 2)
        const avg = Math.round(sum / channels)
        pcm[i] = avg > 32767 ? 32767 : avg < -32768 ? -32768 : avg
      }
    }
    pcmBytes += used
    totalSamples += frames
    return { pcm, sampleRate }
  }

  function push(input) {
    const buf = toBuffer(input)
    bytes += buf.length
    if (headerDone) return decodePcm(buf)

    headerBuf = headerBuf.length ? Buffer.concat([headerBuf, buf]) : Buffer.from(buf)
    const parsed = parseWavHeader(headerBuf)
    if (!parsed) return null

    headerDone = true
    sampleRate = parsed.sampleRate
    channels = parsed.channels
    bits = parsed.bits
    const rest = headerBuf.subarray(parsed.headerBytes)
    headerBuf = EMPTY
    return rest.length ? decodePcm(rest) : null
  }

  function flush() {
    if (!headerDone) {
      if (!bytes) throw streamError('GPT-SoVITS 流式响应为空（0 字节）')
      throw streamError(`GPT-SoVITS 流式响应在 WAV 头完成前结束（已收 ${bytes} 字节）`)
    }
    let discardedBytes = 0
    if (remainder.length) {
      discardedBytes = remainder.length
      warn(`GPT-SoVITS 流式 PCM 末尾残量 ${discardedBytes} 字节（不足一帧 ${channels * 2} 字节），已丢弃`)
      remainder = EMPTY
    }
    return {
      sampleRate,
      channels,
      bits,
      totalBytes: bytes,
      pcmBytes,
      totalSamples,
      discardedBytes,
    }
  }

  return { push, flush }
}

/**
 * 尝试从缓冲区解析 WAV 头。
 * @returns {{headerBytes:number, sampleRate:number, channels:number, bits:number}|null}
 *   返回 null 表示数据还不够，需要继续收；
 *   返回对象表示 data chunk 的 8 字节头已完整，headerBytes 之后即裸 PCM。
 */
function parseWavHeader(buf) {
  if (buf.length < 12) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw notWavError(buf)
  }

  let off = 12
  let fmt = null
  while (true) {
    if (off + 8 > buf.length) return null
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8

    if (id === 'fmt ') {
      if (size < 16) throw streamError('WAV fmt 段过短，无法解析')
      if (start + size > buf.length) return null
      let format = buf.readUInt16LE(start)
      const ch = buf.readUInt16LE(start + 2)
      const sr = buf.readUInt32LE(start + 4)
      const b = buf.readUInt16LE(start + 14)
      if (format === 0xfffe) {
        // WAVE_FORMAT_EXTENSIBLE：真实格式在 SubFormat GUID 前 4 字节
        if (size < 40) throw streamError('WAV EXTENSIBLE fmt 段过短，无法解析')
        format = buf.readUInt32LE(start + 24)
      }
      if (format !== 1) throw streamError(`WAV 编码格式 ${format} 不支持（只支持 PCM 16bit）`)
      if (b !== 16) throw streamError(`WAV 位深 ${b} 不支持（只支持 PCM 16bit）`)
      if (!ch || !sr) throw streamError('WAV fmt 参数无效（声道数/采样率为 0）')
      fmt = { channels: ch, sampleRate: sr, bits: b }
      off = start + size + (size % 2)
      continue
    }

    if (id === 'data') {
      if (!fmt) throw streamError('WAV data 段出现在 fmt 段之前')
      // 流式响应里 data size 是 0（长度未知）或垃圾值：忽略它，之后全是裸 PCM。
      return { headerBytes: start, ...fmt }
    }

    // 其它 chunk（fact/list…）跳过；按 RIFF 规范偶数字节对齐
    if (start + size > buf.length) return null
    off = start + size + (size % 2)
  }
}

/** 非 RIFF/WAVE：尽量把服务端 JSON 错误翻译成清晰的中文错误。 */
function notWavError(buf) {
  const prefix = decodePrefix(buf, 300)
  const trimmed = prefix.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(trimmed)
      const detail = String(j?.Exception || j?.message || j?.error || trimmed)
      return streamError(`GPT-SoVITS 流式返回错误（不是音频）：${sanitizeErrorText(detail, STDERR_BODY_CHARS)}`)
    } catch {
      return streamError(`GPT-SoVITS 流式返回的不是 WAV（JSON 错误）：${sanitizeErrorText(trimmed, STDERR_BODY_CHARS)}`)
    }
  }
  const snippet = prefix.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '·').slice(0, 80)
  return streamError(`GPT-SoVITS 流式返回的不是 WAV（开头：${sanitizeErrorText(snippet, 80) || '空'}）`)
}

// ── 错误 / 脱敏 / 信号工具 ─────────────────────────────────────────────────

function streamError(message, extra = {}) {
  const e = new Error(message)
  e.code = extra.status ? `HTTP_${extra.status}` : 'SOVITS_STREAM'
  e.__sovitsStream = true
  if (extra.status) e.status = extra.status
  return e
}

function timeoutError(ms) {
  const e = new Error(`GPT-SoVITS 流式请求超时（${ms}ms 无数据）`)
  e.name = 'TimeoutError'
  e.code = 'ETIMEDOUT'
  e.__sovitsStream = true
  return e
}

function normalizeStreamError(e, { signal, timeoutHit, timeoutMs }) {
  if (timeoutHit) return timeoutError(timeoutMs)
  if (signal?.aborted) return abortErrorOf(signal)
  if (e && e.__sovitsStream) return e
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return e
  const msg = e?.cause?.message || e?.message || String(e)
  const wrapped = streamError(`GPT-SoVITS 流式请求失败：${sanitizeErrorText(msg, STDERR_BODY_CHARS)}`)
  wrapped.cause = e
  return wrapped
}

/**
 * 错误信息脱敏：最多保留 limit 字符；先截断再脱敏，避免长 body 放大日志。
 * 覆盖 apiKey/token/Authorization 与绝对路径（错误里可能回显参考音频路径）。
 */
export function sanitizeErrorText(input, limit = STDERR_BODY_CHARS) {
  let s = String(input ?? '').slice(0, limit)
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
  s = s.replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\s*[:=]\s*)(["']?)([^"'\s,;}\]]+)/gi, '$1$2***')
  // Windows 绝对路径：C:\Users\alice\... / D:/GPT-SoVITS/... → <path>
  // 负向前瞻排除 http:// 这类协议里的 "p:/"（否则会把 URL 打成 htt<path>）
  s = s.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s"'`，。；:]+[\\/])*[^\s"'`，。；:]*/g, '<path>')
  // POSIX 私有路径
  s = s.replace(/\/(?:home|Users|root)\/[^\s"'`，。；]+/g, '<path>')
  return s
}

/** 读取响应 body 的前 maxChars 个字符（不把整个错误页面读进内存）。 */
async function readTextPrefix(res, maxChars, { signal, makeError } = {}) {
  const body = res?.body
  if (!body || typeof body.getReader !== 'function') {
    try {
      const text = await raceSignal(Promise.resolve().then(() => res.text()), signal, makeError)
      return sanitizeErrorText(text, maxChars)
    } catch {
      return ''
    }
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const onAbort = () => {
    // 先让挂起的 read() 结束，避免错误响应 body 卡死时无限等待。
    // fetch 也被同一个 signal 取消时，body 可能已经 errored，cancel() 会异步拒绝。
    try {
      const p = reader.cancel()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {}
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let text = ''
  try {
    while (text.length < maxChars) {
      const { value, done } = await raceSignal(reader.read(), signal, makeError)
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.length >= maxChars * 2) break
    }
    text += decoder.decode()
  } catch (e) {
    // 超时/取消必须让上层看见；其它读错误（连接被重置等）只返回已读部分
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e
  } finally {
    try { signal?.removeEventListener('abort', onAbort) } catch {}
    try { await reader.cancel() } catch {}
    try { reader.releaseLock?.() } catch {}
  }
  return sanitizeErrorText(text, maxChars)
}

function decodePrefix(buf, maxBytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, maxBytes))
  } catch {
    return ''
  }
}

function combineSignals(...signals) {
  const list = signals.filter(Boolean)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const ctl = new AbortController()
  for (const s of list) {
    if (s.aborted) { ctl.abort(s.reason); break }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true })
  }
  return ctl.signal
}

/**
 * 让 promise 在 signal abort 时立即失败（不依赖 fetch 实现是否响应 signal）。
 * 原 promise 的后续结果由 race 的处理器吞掉，不会产生 unhandled rejection。
 */
function raceSignal(promise, signal, makeError) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(makeError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  throw new TypeError('createWavStreamDecoder 需要 Buffer / Uint8Array / ArrayBuffer')
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function defaultWarn(message) {
  try { console.warn(`[sovits-stream] ${message}`) } catch {}
}

// ── 内部 channel：task 线程推、async generator 拉 ──────────────────────────

function createChunkChannel() {
  const values = []
  const waiters = []
  let state = 'open' // open | ended | failed
  let failure = null

  function settleWaiters() {
    while (waiters.length) {
      const w = waiters.shift()
      if (failure) w.reject(failure)
      else w.resolve({ value: undefined, done: true })
    }
  }

  return {
    get closed() { return state !== 'open' },
    push(value) {
      if (state !== 'open') return false
      const w = waiters.shift()
      if (w) w.resolve({ value, done: false })
      else values.push(value)
      return true
    },
    end() {
      if (state !== 'open') return
      state = 'ended'
      settleWaiters()
    },
    fail(error) {
      if (state !== 'open') return
      state = 'failed'
      failure = error
      values.length = 0
      settleWaiters()
    },
    cancel() {
      if (state !== 'open') return
      state = 'ended'
      values.length = 0
      settleWaiters()
    },
    next() {
      // 先看失败：abort/错误后即使缓存里还有 chunk 也不再吐
      if (state === 'failed') return Promise.reject(failure)
      if (values.length) return Promise.resolve({ value: values.shift(), done: false })
      if (state === 'ended') return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
    },
    return() {
      this.cancel()
      return Promise.resolve({ value: undefined, done: true })
    },
    throw(error) {
      this.fail(error)
      return Promise.reject(error)
    },
    [Symbol.asyncIterator]() { return this },
  }
}
