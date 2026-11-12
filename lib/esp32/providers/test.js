// ESP32 通道 · 云端 ASR/TTS「测试连接」handler
//
// 工厂全部注入（createAsr / createTts），本文件不 import 任何适配器，便于假实现测试。
//   createAsr({ id, config }) → AsrProvider        config = 该 provider 的配置节（含密钥）
//   createTts({ id, config }) → TtsProvider
//
// ASR：发 1s 16k 静音 WAV；能走通（不抛错，哪怕 text 为空）即视为连通。
// TTS：合成「你好」，拿到首块音频即 abort，返回 ttsFirstMs。
// 全程 15s 超时；错误文本脱敏，绝不回显 apiKey。

import { writePcmWav } from '../audio/wav.js'
import { sanitizeError } from '../host.js'
import { getProvider } from './registry.js'

export const TEST_TIMEOUT_MS = 15_000
const TTS_TEST_TEXT = '你好'

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** 脱敏：sanitizeError + 抹掉本次 values 里出现的所有字符串密钥。 */
export function redactError(error, values = {}) {
  let text = sanitizeError(error)
  for (const [k, v] of Object.entries(values ?? {})) {
    if (/key|token|secret/i.test(k) && typeof v === 'string' && v.length >= 4) text = text.split(v).join('[redacted]')
  }
  return text
}

/**
 * @param {{
 *   createAsr?: Function, createTts?: Function,
 *   timeoutMs?: number, now?: () => number,
 * }} [deps]
 * @returns {(args: {kind: 'asr'|'tts', id: string, values?: object}) => Promise<{ok: boolean, ms: number, error?: string, ttsFirstMs?: number, text?: string}>}
 */
export function createProviderTester(deps = {}) {
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : TEST_TIMEOUT_MS
  const now = typeof deps.now === 'function' ? deps.now : Date.now

  return async function testProvider({ kind, id, values = {} } = {}) {
    const started = now()
    const fail = (error) => ({ ok: false, ms: now() - started, error: String(error).slice(0, 300) })

    const meta = getProvider(kind, id)
    if (!meta) return fail(`未知的 ${kind} provider：${id}`)
    if (!meta.testable) return fail(`${meta.label} 是本地 provider，不支持测试连接`)
    const missing = meta.fields.filter((f) => f.required && isBlank(values[f.key])).map((f) => f.label)
    if (missing.length) return fail(`缺少必填项：${missing.join('、')}`)

    const factory = kind === 'asr' ? deps.createAsr : deps.createTts
    if (typeof factory !== 'function') return fail('测试工厂未注入')

    const controller = new AbortController()
    let timedOut = false
    let onTimeout
    const timeoutPromise = new Promise((_, reject) => { onTimeout = reject })
    const timer = setTimeout(() => { timedOut = true; controller.abort(); onTimeout(new Error('timeout')) }, timeoutMs)
    try {
      const provider = factory({ id, config: values })
      const run = kind === 'asr'
        ? runAsr(provider, controller.signal)
        : runTts(provider, controller, now)
      const extra = await Promise.race([run, timeoutPromise])
      return { ok: true, ms: now() - started, ...extra }
    } catch (error) {
      if (timedOut) return fail(`测试超时（${Math.round(timeoutMs / 1000)}s）`)
      return fail(redactError(error, values))
    } finally {
      clearTimeout(timer)
    }
  }
}

async function runAsr(provider, signal) {
  const wav = writePcmWav(new Int16Array(16_000), 16_000, 1)
  const result = await provider.transcribe({ wav, sampleRate: 16_000, signal })
  return { text: String(result?.text ?? '') }
}

async function runTts(provider, controller, now) {
  const t0 = now()
  const iterator = provider.stream(TTS_TEST_TEXT, { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || !first.value?.pcm?.length) throw new Error('TTS 未返回任何音频')
    const ttsFirstMs = now() - t0
    controller.abort() // 拿到首块即停，不白烧后续合成
    return { ttsFirstMs, sampleRate: first.value.sampleRate }
  } finally {
    try { await iterator.return?.() } catch { /* 取消产生的错误不重要 */ }
  }
}
