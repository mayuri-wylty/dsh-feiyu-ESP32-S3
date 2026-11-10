// T15：OpenAI 兼容 ASR provider（contracts.js → AsrProvider）
//
// 形状：
//   createOpenAICompatibleProvider({ baseUrl, apiKey?, model, language?, timeoutMs?, fetch? })
//     → { id: 'openai-compatible', transcribe({ wav, sampleRate, language?, signal? }) → { text, ms } }
//
// 请求（设计 §6.5）：
//   POST <baseUrl>/audio/transcriptions
//   multipart/form-data：file=<wav bytes，filename 以 .wav 结尾，Content-Type audio/wav>、
//                        model、language、response_format=json
//   apiKey 非空才带 Authorization: Bearer（空串/未配置则完全不带）
//
// 超时与取消：
//   默认 30s（DEFAULT_ASR_TIMEOUT_MS），AbortSignal.any 合并用户 signal；
//   超时 → TimeoutError（回退层视为可回退的主失败）；用户取消 → AbortError（绝不回退）。
//
// 错误：
//   非 2xx 只带状态码 + 服务端前 300 字符，且对 apiKey 脱敏；绝不重试；
//   本文件不 console 输出任何请求细节，API Key 不进入日志/错误信息。
import {
  abortErrorOf, assertWavInput, combineSignals, normalizeLanguage, timeoutError,
} from './util.js'

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'
export const DEFAULT_ASR_TIMEOUT_MS = 30_000
const DEFAULT_LANGUAGE = 'zh'
const MAX_ERROR_DETAIL = 300
const TRANSCRIPTIONS_PATH = '/audio/transcriptions'

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] 形如 https://api.openai.com/v1（可带或不带尾斜杠）
 * @param {string} [options.apiKey]
 * @param {string} [options.model]
 * @param {string} [options.language] 默认识别语言（默认 zh）
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetch] 测试注入用
 * @returns {import('../contracts.js').AsrProvider}
 */
export function createOpenAICompatibleProvider(options = {}) {
  const endpoint = normalizeTranscriptionUrl(options.baseUrl)
  const apiKey = String(options.apiKey ?? '')
  const model = String(options.model ?? '').trim()
  if (!model) {
    throw new Error('OpenAI 兼容 ASR 未配置 model（请填写 esp32.asr.openai.model）')
  }
  const defaultLanguage = normalizeLanguage(options.language ?? DEFAULT_LANGUAGE)
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_ASR_TIMEOUT_MS)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createOpenAICompatibleProvider 需要可用的 fetch')
  }

  async function transcribe({ wav, sampleRate, language, signal } = {}) {
    assertWavInput(wav, OPENAI_COMPATIBLE_PROVIDER_ID)
    if (signal?.aborted) throw abortErrorOf(signal)

    const lang = normalizeLanguage(language ?? defaultLanguage)
    const body = buildMultipartBody({ wav, model, language: lang })
    const headers = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const timeoutCtl = new AbortController()
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs)
    timer.unref?.()
    const combinedSignal = combineSignals(signal, timeoutCtl.signal)
    const t0 = Date.now()

    try {
      let res
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: combinedSignal,
        })
      } catch (e) {
        throw normalizeFetchError(e, signal, timeoutCtl.signal, timeoutMs)
      }

      if (!res.ok) {
        const detail = await readErrorDetail(res, apiKey)
        if (signal?.aborted) throw abortErrorOf(signal)
        if (timeoutCtl.signal.aborted) throw timeoutError(timeoutMs)
        throw new Error(
          `OpenAI 兼容 ASR HTTP ${res.status}${detail ? `：${detail}` : ''}`,
        )
      }

      let raw
      try {
        raw = await res.text()
      } catch (e) {
        throw normalizeFetchError(e, signal, timeoutCtl.signal, timeoutMs)
      }
      if (signal?.aborted) throw abortErrorOf(signal)
      if (timeoutCtl.signal.aborted) throw timeoutError(timeoutMs)

      const payload = parsePayload(raw, apiKey)
      if (!payload || typeof payload.text !== 'string') {
        throw new Error('OpenAI 兼容 ASR 返回格式不合法：缺少字符串字段 text')
      }
      return { text: payload.text.trim(), ms: Date.now() - t0 }
    } finally {
      clearTimeout(timer)
    }
  }

  return { id: OPENAI_COMPATIBLE_PROVIDER_ID, transcribe }
}

/**
 * 归一化转写端点：去尾斜杠后补 /audio/transcriptions；
 * 已经以该路径结尾则保持不变（允许直接填完整端点）。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeTranscriptionUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) {
    throw new Error('OpenAI 兼容 ASR 未配置 baseUrl（请填写 esp32.asr.openai.baseUrl）')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`OpenAI 兼容 ASR baseUrl 不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`OpenAI 兼容 ASR baseUrl 必须是 http(s) URL：${raw}`)
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith(TRANSCRIPTIONS_PATH)
    ? pathname
    : `${pathname}${TRANSCRIPTIONS_PATH}`
  return url.toString()
}

// ── 内部 ────────────────────────────────────────────────────────────────────

function buildMultipartBody({ wav, model, language }) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  if (language) form.append('language', language)
  form.append('response_format', 'json')
  return form
}

function normalizeFetchError(error, userSignal, timeoutSignal, timeoutMs) {
  if (userSignal?.aborted) return abortErrorOf(userSignal)
  if (timeoutSignal?.aborted) return timeoutError(timeoutMs)
  if (error?.name === 'AbortError') return abortErrorOf(userSignal)
  const message = error?.message ? `OpenAI 兼容 ASR 请求失败：${error.message}` : 'OpenAI 兼容 ASR 请求失败'
  const wrapped = new Error(message)
  if (error?.cause !== undefined) wrapped.cause = error.cause
  return wrapped
}

async function readErrorDetail(res, apiKey) {
  try {
    const raw = await res.text()
    return truncate(redact(raw, apiKey))
  } catch {
    return ''
  }
}

function parsePayload(raw, apiKey) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(
      `OpenAI 兼容 ASR 返回不是合法 JSON（前 ${MAX_ERROR_DETAIL} 字符：${truncate(redact(raw, apiKey))}）`,
    )
  }
}

function redact(text, secret) {
  const s = String(text ?? '')
  if (!secret) return s
  return s.split(secret).join('***')
}

function truncate(text) {
  return String(text ?? '').slice(0, MAX_ERROR_DETAIL)
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
