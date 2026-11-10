// T16：GPT-SoVITS 句级 TTS provider（contracts.js → TtsProvider）
//
// 形状：
//   { id: 'sovits-sentence', stream(text, { emotion?, signal? }) }
//   stream 每句只发一次 /tts 请求（candidates=1，不做择优），返回一条
//   { pcm: Int16Array, sampleRate }。上游（A 道会话）按句调用，自己决定何时插话/打断。
//
// 与旧聊天链的关系：请求组装复用 tools/lib/tts.mjs 的 buildSovitsRequest —— 情绪标签、
// GBK 清洗、参考段选择、PASS_THROUGH 参数与 synth() 完全同源，避免两套请求体漂移。
//
// ── 24k 输出结论（2026-11-10 核对）───────────────────────────────────────────
// GPT-SoVITS 上游 api_v2.py 的 TTS_Request 没有“输出采样率”字段；本地
// xiaozhi-esp32-server 的 gpt_sovits_v2.py 同样不做重采样。返回 wav 的 sr 由服务端
// tts_infer.yaml / 模型决定（v2 常见 32000，也可能 24000）。
// 因此：不请求、不伪造 24k —— 一律读 WAV 头 fmt.sampleRate 原样上报。
// ESP32 下行协议固定 24000；若拿到 32k，需要由下行侧（A/B 道）按 chunk.sampleRate
// 重采样后，再按 60ms/1440 样本组帧。
import { buildSovitsRequest } from '../../../tools/lib/tts.mjs'
import { config } from '../../../tools/lib/config.mjs'
import { abortErrorOf, getTtsQueue, TTS_PRIORITY } from './queue.js'
import { parseWavToPcm } from './wav.js'

export const SOVITS_SENTENCE_ID = 'sovits-sentence'
export const DEFAULT_SOVITS_URL = 'http://127.0.0.1:9880/tts'
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MIN_BYTES = 1000

/**
 * 创建句级 provider。默认使用进程内共享队列，保证与批量合成互斥 9880。
 *
 * @param {object} [options]
 * @param {import('./queue.js').TtsQueue} [options.queue] 自定义队列（测试隔离用）
 * @param {object} [options.voice] 覆盖 config().voice（sovits_url/text_lang/top_k…）
 * @param {object} [options.override] 请求覆盖项（text_split_method/temperature…）
 * @param {{ref_audio_path:string, prompt_text:string, from?:string}} [options.ref] 固定参考段
 * @param {string} [options.url] 直接指定 9880 端点
 * @param {number} [options.timeoutMs] 单次请求超时（默认 30s；不走旧链的 120s×3 重试）
 * @param {number} [options.minBytes] 返回音频最小字节数（默认 1000）
 * @param {typeof fetch} [options.fetch] 注入 fetch（测试用）
 * @param {'realtime'|'normal'} [options.priority] 队列优先级，默认 realtime
 */
export function createSovitsSentenceProvider(options = {}) {
  const queue = options.queue ?? getTtsQueue()
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('createSovitsSentenceProvider 需要可用的 fetch')

  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const minBytes = positiveNumber(options.minBytes, DEFAULT_MIN_BYTES)
  const priority = options.priority === TTS_PRIORITY.NORMAL ? TTS_PRIORITY.NORMAL : TTS_PRIORITY.REALTIME

  /** @type {import('../contracts.js').TtsStreamFn} */
  async function* stream(text, opts = {}) {
    const { emotion, signal } = opts
    const voice = options.voice ?? config().voice ?? {}
    const req = buildSovitsRequest(text, {
      emotion,
      voice,
      override: options.override,
      ref: options.ref,
      profile: options.profile,
      url: options.url || voice.sovits_url || DEFAULT_SOVITS_URL,
      mediaType: 'wav',
      streamingMode: false,
    })
    const wav = await queue.enqueue(
      () => requestWav(req, { fetchImpl, signal, timeoutMs, minBytes }),
      { priority, signal },
    )
    // 非流式 api_v2：一次请求就是完整一句，作为单块 PCM 交给下游
    yield { pcm: wav.pcm, sampleRate: wav.sampleRate }
  }

  return { id: SOVITS_SENTENCE_ID, stream }
}

/** 默认 provider（使用进程内共享队列；首次 import 时创建，不读配置）。 */
export const sovitsSentenceProvider = createSovitsSentenceProvider()

async function requestWav(req, { fetchImpl, signal, timeoutMs, minBytes }) {
  if (signal?.aborted) throw abortErrorOf(signal)

  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs)
  timer.unref?.()
  const combined = combineSignals(signal, timeoutCtl.signal)

  try {
    let res
    try {
      res = await fetchImpl(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: combined,
      })
    } catch (e) {
      throw normalizeFetchError(e, signal, timeoutCtl.signal, timeoutMs)
    }

    if (!res.ok) {
      const detail = await readErrorBody(res)
      if (signal?.aborted) throw abortErrorOf(signal)
      if (timeoutCtl.signal.aborted) throw timeoutError(timeoutMs)
      throw new Error(`GPT-SoVITS HTTP ${res.status}${detail ? `：${detail}` : ''}`)
    }

    let buf
    try {
      buf = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      throw normalizeFetchError(e, signal, timeoutCtl.signal, timeoutMs)
    }
    if (signal?.aborted) throw abortErrorOf(signal)
    if (timeoutCtl.signal.aborted) throw timeoutError(timeoutMs)
    if (buf.length < minBytes) {
      throw new Error(`GPT-SoVITS 返回音频过短（${buf.length} 字节，可能合成失败）`)
    }
    return parseWavToPcm(buf)
  } finally {
    clearTimeout(timer)
  }
}

function combineSignals(...signals) {
  const list = signals.filter(Boolean)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  // 老 Node 兜底（Node < 20.3）；事件监听只在本次请求生命周期内有意义
  const ctl = new AbortController()
  for (const s of list) {
    if (s.aborted) {
      ctl.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true })
  }
  return ctl.signal
}

function normalizeFetchError(e, userSignal, timeoutSignal, timeoutMs) {
  if (userSignal?.aborted) return abortErrorOf(userSignal)
  if (timeoutSignal?.aborted) return timeoutError(timeoutMs)
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return abortErrorOf(userSignal)
  return e
}

function timeoutError(ms) {
  const e = new Error(`GPT-SoVITS 请求超时（${ms}ms）`)
  e.name = 'TimeoutError'
  e.code = 'ETIMEDOUT'
  return e
}

async function readErrorBody(res) {
  try {
    const text = await res.text()
    if (!text) return ''
    try {
      const j = JSON.parse(text)
      return String(j.Exception || j.message || text).slice(0, 300)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return ''
  }
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
