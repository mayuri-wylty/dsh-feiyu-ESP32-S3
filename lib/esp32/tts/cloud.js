// T17：OpenAI 兼容云 TTS provider（contracts.js → TtsProvider）
//
// 形状：
//   { id: 'cloud', stream(text, { emotion?, signal? }) }
//   stream 每次调用返回一条 { pcm: Int16Array, sampleRate }（云 TTS 整句返回）。
//
// 协议：POST <baseUrl>/audio/speech，OpenAI 兼容 body：
//   { model, input, voice, response_format: 'wav', speed? }
// 响应：
//   · WAV（Content-Type 含 wav，或 body 以 RIFF 开头）→ tts/wav.js 解析，采样率读 WAV 头；
//   · raw PCM（audio/pcm / application/octet-stream 且非 RIFF）→ 24k/mono/PCM16LE；
//   · 其它（mp3 等）→ 明确报错，不做解码。
//
// 失败语义：不做重试；超时抛 TimeoutError；用户 signal 取消抛 AbortError。
// 错误信息最多带服务端前 300 字符；绝不打印 API Key。
import { config } from '../../../tools/lib/config.mjs'
import { abortErrorOf } from './queue.js'
import { parseWavToPcm } from './wav.js'

export const CLOUD_PROVIDER_ID = 'cloud'
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MIN_BYTES = 1000
export const DEFAULT_PCM_SAMPLE_RATE = 24_000

/**
 * 归一化 OpenAI 兼容 TTS 端点：
 *   · 已以 /audio/speech 结尾 → 原样；
 *   · 以 /v1 结尾 → 拼 /audio/speech；
 *   · 其它（纯 origin 或带自定义路径）→ 拼 /v1/audio/speech。
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeSpeechUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) {
    throw new Error('云 TTS 未配置 baseUrl（请填写 esp32.tts.cloud.baseUrl，如 https://api.openai.com/v1）')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`云 TTS baseUrl 不是合法 URL：${raw}`)
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  if (/\/audio\/speech$/.test(pathname)) {
    url.pathname = pathname
  } else if (/\/v1$/.test(pathname)) {
    url.pathname = `${pathname}/audio/speech`
  } else {
    url.pathname = `${pathname}/v1/audio/speech`
  }
  return url.toString()
}

/**
 * 创建云 TTS provider。配置优先级：显式 options > config().esp32.tts.cloud。
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]  OpenAI 兼容 base URL（空则抛错）
 * @param {string} [options.apiKey]   Bearer token（空则不带 Authorization）
 * @param {string} [options.model]    如 tts-1 / gpt-4o-mini-tts
 * @param {string} [options.voice]    如 alloy / nova
 * @param {number} [options.speed]    可选语速（>0 才发送）
 * @param {number} [options.timeoutMs] 单次请求超时（默认 30s）
 * @param {number} [options.minBytes]  返回音频最小字节数（默认 1000）
 * @param {typeof fetch} [options.fetch] 注入 fetch（测试用）
 * @returns {import('../contracts.js').TtsProvider}
 */
export function createCloudProvider(options = {}) {
  const cfg = config().esp32?.tts?.cloud ?? {}
  const pick = (key) => (options[key] !== undefined ? options[key] : (cfg[key] ?? ''))

  const endpoint = normalizeSpeechUrl(pick('baseUrl'))
  const apiKey = String(pick('apiKey') ?? '')
  const model = String(pick('model') ?? '')
  const voice = String(pick('voice') ?? '')
  const speedRaw = normalizeSpeed(options.speed !== undefined ? options.speed : cfg.speed)
  const speed = speedRaw === 1 && options.speed === undefined ? undefined : speedRaw // 配置默认 1 视为未设置，不发送
  const timeoutMs = positiveNumber(options.timeoutMs !== undefined ? options.timeoutMs : cfg.timeoutMs, DEFAULT_TIMEOUT_MS)
  const minBytes = nonNegativeNumber(options.minBytes, DEFAULT_MIN_BYTES)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('createCloudProvider 需要可用的 fetch')

  /** @type {import('../contracts.js').TtsStreamFn} */
  async function* stream(text, opts = {}) {
    const input = String(text ?? '')
    if (!input.trim()) return // 空白文本不发请求

    const audio = await requestSpeech({
      endpoint,
      apiKey,
      model,
      voice,
      speed,
      input,
      signal: opts.signal,
      fetchImpl,
      timeoutMs,
      minBytes,
    })
    // 云 TTS 通常整句返回；保持单块，避免下游处理顺序/sampleRate 不一致
    yield { pcm: audio.pcm, sampleRate: audio.sampleRate }
  }

  return { id: CLOUD_PROVIDER_ID, stream }
}

// ── 请求 ────────────────────────────────────────────────────────────────────

async function requestSpeech({
  endpoint,
  apiKey,
  model,
  voice,
  speed,
  input,
  signal,
  fetchImpl,
  timeoutMs,
  minBytes,
}) {
  if (signal?.aborted) throw abortErrorOf(signal)

  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs)
  timer.unref?.()
  const combined = combineSignals(signal, timeoutCtl.signal)

  try {
    let res
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(buildBody({ model, input, voice, speed })),
        signal: combined,
      })
    } catch (e) {
      throw normalizeFetchError(e, signal, timeoutCtl.signal, timeoutMs)
    }

    if (!res.ok) {
      const detail = await readErrorText(res)
      if (signal?.aborted) throw abortErrorOf(signal)
      if (timeoutCtl.signal.aborted) throw timeoutError(timeoutMs)
      throw new Error(`云 TTS HTTP ${res.status}${detail ? `：${detail}` : ''}`)
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
      throw new Error(`云 TTS 返回音频过短（${buf.length} 字节，至少 ${minBytes} 字节，可能合成失败）`)
    }

    return decodeAudio(buf, contentTypeOf(res))
  } finally {
    clearTimeout(timer)
  }
}

function buildHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function buildBody({ model, input, voice, speed }) {
  const body = { model, input, voice, response_format: 'wav' }
  if (speed !== undefined) body.speed = speed
  return body
}

// ── 响应解码 ────────────────────────────────────────────────────────────────

function decodeAudio(buf, contentType) {
  const isRiff = buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF'
  if (isRiff || contentType.includes('wav')) {
    const wav = parseWavToPcm(buf)
    return { pcm: wav.pcm, sampleRate: wav.sampleRate }
  }
  if (contentType === 'audio/pcm' || contentType === 'application/octet-stream') {
    // OpenAI pcm 格式固定 24k/mono/PCM16LE；逐点 DataView 读取，不依赖宿主端序
    return { pcm: pcm16leToInt16(buf), sampleRate: DEFAULT_PCM_SAMPLE_RATE }
  }
  throw new Error(`云 TTS 返回不支持的音频格式：${contentType || '未知'}（只支持 wav / pcm16）`)
}

function pcm16leToInt16(buf) {
  const frames = Math.floor(buf.length / 2)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const pcm = new Int16Array(frames)
  for (let i = 0; i < frames; i++) pcm[i] = view.getInt16(i * 2, true)
  return pcm
}

function contentTypeOf(res) {
  const headers = res?.headers
  let raw = ''
  if (headers && typeof headers.get === 'function') raw = headers.get('content-type') || ''
  else if (headers && typeof headers === 'object') raw = headers['content-type'] || headers['Content-Type'] || ''
  return String(raw).toLowerCase().split(';')[0].trim()
}

// ── 错误与信号 ──────────────────────────────────────────────────────────────

function combineSignals(...signals) {
  const list = signals.filter(Boolean)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  // 老 Node 兜底（Node < 20.3）；当前项目要求 Node ≥ 20.3
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
  const e = new Error(`云 TTS 请求超时（${ms}ms）`)
  e.name = 'TimeoutError'
  e.code = 'ETIMEDOUT'
  return e
}

async function readErrorText(res) {
  try {
    const text = await res.text()
    return String(text ?? '').slice(0, 300)
  } catch {
    return ''
  }
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function normalizeSpeed(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
