// 火山引擎 TTS 单向流式 provider（TtsProvider，id: 'volcengine'）
// POST {endpoint}/api/v3/tts/unidirectional；响应为分块 JSON 流（不保证换行分隔）。
// 回退语义由 tts/fallback.js 负责：首块前抛错→回退；首块后抛错→不回退。
import { randomUUID } from 'node:crypto'
import { abortErrorOf } from './queue.js'

export const VOLCENGINE_PROVIDER_ID = 'volcengine'
export const VOLC_SAMPLE_RATE = 24_000
const END_CODE = 20000000

const CODE_MESSAGES = {
  45000000: '音色未授权，或资源ID与音色版本不匹配（seed-tts-2.0 仅限 2.0 音色，seed-tts-1.0 仅限 1.0 音色）',
  40402003: '文本超长，请缩短单句文本',
  55000000: '火山服务端错误，请稍后重试',
}

function messageForCode(code, raw) {
  if (CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  const c = String(code)
  if (c === '45000292' || c === '45000293' || /concurr|exceed|quota|too many|并发/i.test(String(raw ?? ''))) {
    return '并发超限，请降低并发或稍后重试'
  }
  if (c.startsWith('55')) return '火山服务端错误，请稍后重试'
  return '火山 TTS 返回错误'
}

export function createVolcengineTts(options = {}) {
  const apiKey = String(options.apiKey ?? '')
  const resourceId = String(options.resourceId || 'seed-tts-2.0')
  const speaker = String(options.speaker ?? '')
  const speechRate = Number(options.speechRate ?? 0) || 0
  const loudnessRate = Number(options.loudnessRate ?? 0) || 0
  const endpoint = String(options.endpoint || 'https://openspeech.bytedance.com').replace(/\/+$/, '')
  const connectTimeoutMs = pos(options.connectTimeoutMs, 5000)
  const idleTimeoutMs = pos(options.idleTimeoutMs, 15_000)
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('createVolcengineTts 需要可用的 fetch')

  const scrub = (s) => {
    let out = String(s ?? '')
    if (apiKey) out = out.split(apiKey).join('***')
    return out
  }
  const fail = (msg, name = 'Error', extra = {}) => {
    const e = new Error(scrub(msg))
    e.name = name
    Object.assign(e, extra)
    return e
  }

  async function* stream(text, opts = {}) {
    const input = String(text ?? '')
    if (!input.trim()) return
    const signal = opts.signal
    if (signal?.aborted) throw abortErrorOf(signal)
    if (!apiKey) throw fail('火山 TTS 未配置 apiKey')
    if (!speaker) throw fail('火山 TTS 未配置音色 speaker')

    const ctl = new AbortController()
    let reader = null
    let timer = null
    let timedOut = false
    let rejectWait = null
    const waiter = new Promise((_, rej) => { rejectWait = rej })
    waiter.catch(() => {})
    const arm = (ms) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        ctl.abort()
        rejectWait(fail(`火山 TTS 超时（${ms}ms 内无数据）`, 'TimeoutError', { code: 'ETIMEDOUT' }))
      }, ms)
      timer.unref?.()
    }
    const onUserAbort = () => { ctl.abort(); rejectWait(abortErrorOf(signal)) }
    signal?.addEventListener('abort', onUserAbort, { once: true })
    const race = (p) => Promise.race([p, waiter])
    const normalize = (e) => {
      if (signal?.aborted) return abortErrorOf(signal)
      if (e?.name === 'TimeoutError') return e
      if (timedOut) return fail('火山 TTS 超时', 'TimeoutError', { code: 'ETIMEDOUT' })
      if (e?.name === 'AbortError') return e
      return fail(e?.message ?? e)
    }

    try {
      arm(connectTimeoutMs)
      let res
      try {
        res = await race(fetchImpl(`${endpoint}/api/v3/tts/unidirectional`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey,
            'X-Api-Resource-Id': resourceId,
            'X-Api-Request-Id': randomUUID(),
          },
          body: JSON.stringify({
            user: { uid: 'feiyu' },
            req_params: {
              text: input,
              speaker,
              audio_params: { format: 'pcm', sample_rate: VOLC_SAMPLE_RATE, speech_rate: speechRate, loudness_rate: loudnessRate },
              additions: JSON.stringify({ disable_markdown_filter: true }),
            },
          }),
          signal: ctl.signal,
        }))
      } catch (e) {
        throw normalize(e)
      }
      if (!res.ok) {
        let detail = ''
        try { detail = String(await race(res.text())).slice(0, 300) } catch { /* ignore */ }
        throw fail(`火山 TTS HTTP ${res.status}${detail ? `：${detail}` : ''}`)
      }
      if (!res.body?.getReader) throw fail('火山 TTS 响应没有可读流')
      reader = res.body.getReader()

      const decoder = new TextDecoder('utf-8')
      const scanner = createJsonScanner()
      let leftover = null // 奇数字节余量
      let done = false
      while (!done) {
        let r
        try {
          r = await race(reader.read())
        } catch (e) {
          throw normalize(e)
        }
        arm(idleTimeoutMs)
        if (r.done) break
        for (const raw of scanner.push(decoder.decode(r.value, { stream: true }))) {
          let obj
          try { obj = JSON.parse(raw) } catch { throw fail('火山 TTS 返回了无法解析的数据') }
          if (obj?.sentence !== undefined && !obj?.data) continue
          const code = Number(obj?.code)
          if (code === END_CODE) { done = true; break }
          if (code !== 0) {
            throw fail(`火山 TTS 错误 ${obj?.code}：${messageForCode(obj?.code, obj?.message)}`, 'Error', { volcCode: obj?.code })
          }
          if (!obj.data) continue
          let bytes = Buffer.from(String(obj.data), 'base64')
          if (leftover) { bytes = Buffer.concat([leftover, bytes]); leftover = null }
          if (bytes.length % 2) {
            leftover = bytes.subarray(bytes.length - 1)
            bytes = bytes.subarray(0, bytes.length - 1)
          }
          if (!bytes.length) continue
          const pcm = new Int16Array(bytes.length / 2)
          for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2)
          yield { pcm, sampleRate: VOLC_SAMPLE_RATE }
        }
      }
      if (signal?.aborted) throw abortErrorOf(signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onUserAbort)
      if (reader) { try { await reader.cancel() } catch { /* ignore */ } }
      ctl.abort()
    }
  }

  return { id: VOLCENGINE_PROVIDER_ID, stream }
}

/** 括号深度扫描：感知字符串内引号与转义，跨块保持状态。 */
function createJsonScanner() {
  let depth = 0
  let inStr = false
  let esc = false
  let cur = ''
  return {
    push(text) {
      const out = []
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (depth === 0) {
          if (ch === '{') { depth = 1; cur = '{' }
          continue
        }
        cur += ch
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') inStr = true
        else if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) { out.push(cur); cur = '' }
        }
      }
      return out
    },
  }
}

function pos(v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
