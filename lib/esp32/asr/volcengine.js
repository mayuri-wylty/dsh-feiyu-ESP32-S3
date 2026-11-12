// 火山引擎豆包语音「录音文件极速版」ASR provider（contracts.js → AsrProvider）
//
//   createVolcengineAsr({ apiKey, resourceId, modelName, endpoint, timeoutMs, fetchImpl })
//     → { id: 'volcengine', transcribe({ wav, sampleRate, language, signal }) → { text, ms } }
//
// POST {endpoint}/api/v3/auc/bigmodel/recognize/flash，状态码在响应头 X-Api-Status-Code：
//   20000000 → result.text；20000003（静音）/45000002（空音频）→ 空文本（合法结果，不回退）；
//   其他（含 55000031 服务忙）→ 抛错交回退层。
// 超时 → TimeoutError（可回退）；用户取消 → AbortError（绝不回退）。
// apiKey 不进入任何错误信息；错误细节截断 300 字。
import crypto from 'node:crypto'
import { abortErrorOf, assertWavInput, combineSignals, timeoutError } from './util.js'

export const VOLCENGINE_ASR_PROVIDER_ID = 'volcengine'
export const DEFAULT_VOLC_ASR_ENDPOINT = 'https://openspeech.bytedance.com'
export const DEFAULT_VOLC_ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo'
export const DEFAULT_VOLC_ASR_MODEL = 'bigmodel'
export const DEFAULT_VOLC_ASR_TIMEOUT_MS = 30_000
const MAX_ERROR_DETAIL = 300
const RECOGNIZE_PATH = '/api/v3/auc/bigmodel/recognize/flash'

const STATUS_HINTS = {
  45000001: '请求参数无效',
  45000151: '音频格式不正确',
  55000031: '服务器繁忙，请稍后重试',
}

export function createVolcengineAsr(options = {}) {
  const apiKey = String(options.apiKey ?? '').trim()
  if (!apiKey) throw new Error('火山 ASR 未配置 apiKey（请填写 esp32.asr.volcengine.apiKey）')
  const resourceId = String(options.resourceId || DEFAULT_VOLC_ASR_RESOURCE_ID).trim()
  const modelName = String(options.modelName || DEFAULT_VOLC_ASR_MODEL).trim()
  const url = buildUrl(options.endpoint || DEFAULT_VOLC_ASR_ENDPOINT)
  const n = Number(options.timeoutMs)
  const timeoutMs = Number.isFinite(n) && n > 0 ? n : DEFAULT_VOLC_ASR_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('createVolcengineAsr 需要可用的 fetch')

  async function transcribe({ wav, signal } = {}) {
    assertWavInput(wav, VOLCENGINE_ASR_PROVIDER_ID)
    if (signal?.aborted) throw abortErrorOf(signal)

    const body = JSON.stringify({
      user: { uid: 'feiyu' },
      audio: { data: Buffer.from(wav).toString('base64') },
      request: { model_name: modelName },
    })
    const timeoutCtl = new AbortController()
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs)
    timer.unref?.()
    const combined = combineSignals(signal, timeoutCtl.signal)
    const t0 = Date.now()

    const fail = (error) => {
      if (signal?.aborted) return abortErrorOf(signal)
      if (timeoutCtl.signal.aborted) return timeoutError(timeoutMs)
      if (error?.name === 'AbortError') return abortErrorOf(signal)
      const wrapped = new Error(`火山 ASR 请求失败${error?.message ? `：${redact(error.message)}` : ''}`)
      if (error?.cause !== undefined) wrapped.cause = error.cause
      return wrapped
    }
    const redact = (text) => truncate(String(text ?? '').split(apiKey).join('***'))

    try {
      let res
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'X-Api-Key': apiKey,
            'X-Api-Resource-Id': resourceId,
            'X-Api-Request-Id': crypto.randomUUID(),
            'X-Api-Sequence': '-1',
            'Content-Type': 'application/json',
          },
          body,
          signal: combined,
        })
      } catch (e) {
        throw fail(e)
      }

      let raw = ''
      try {
        raw = await res.text()
      } catch (e) {
        throw fail(e)
      }
      if (signal?.aborted) throw abortErrorOf(signal)
      if (timeoutCtl.signal.aborted) throw timeoutError(timeoutMs)

      const code = String(res.headers?.get?.('X-Api-Status-Code') ?? '').trim()
      const message = String(res.headers?.get?.('X-Api-Message') ?? '').trim()

      if (code === '20000000') {
        let payload
        try {
          payload = JSON.parse(raw)
        } catch {
          throw new Error(`火山 ASR 返回不是合法 JSON（前 ${MAX_ERROR_DETAIL} 字符：${redact(raw)}）`)
        }
        const text = payload?.result?.text
        if (typeof text !== 'string') throw new Error('火山 ASR 返回格式不合法：缺少字符串字段 result.text')
        return { text: text.trim(), ms: Date.now() - t0 }
      }
      if (code === '20000003' || code === '45000002') {
        return { text: '', ms: Date.now() - t0 }
      }

      const hint = STATUS_HINTS[code]
      const detail = redact(message || raw)
      const head = code ? `状态码 ${code}` : `HTTP ${res.status}（无状态码）`
      throw new Error(`火山 ASR 识别失败（${head}）${hint ? `：${hint}` : ''}${detail ? `；${detail}` : ''}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return { id: VOLCENGINE_ASR_PROVIDER_ID, transcribe }
}

function buildUrl(endpoint) {
  const raw = String(endpoint).trim()
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`火山 ASR endpoint 不是合法 URL：${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`火山 ASR endpoint 必须是 http(s) URL：${raw}`)
  }
  return `${raw.replace(/\/+$/, '')}${RECOGNIZE_PATH}`
}

function truncate(text) {
  return String(text ?? '').slice(0, MAX_ERROR_DETAIL)
}
