// T15：SenseVoice ASR provider（contracts.js → AsrProvider）
//
// 形状：
//   createSensevoiceProvider({ speechToText | ctx.speechToText, language? })
//     → { id: 'sensevoice', transcribe({ wav, sampleRate, language?, signal? }) → { text, ms } }
//
// 依据 G0 / Spike B：
//   · 模型与推理 worker 由 DSH voice-input bundle 托管，本文件**绝不** import sherpa-onnx-node；
//   · 复用 ctx.speechToText：resolve({ audio, language }) → spec，transcribe(spec, signal) → { text, ... }；
//   · voice-input 未启用（ctx.speechToText 缺失）→ 创建时立即抛清晰错误，避免“静默不出字”；
//   · 输入是完整 16k/mono/PCM16 WAV（非流式），见设计 §3；
//   · 结果只 trim；空字符串是合法结果（静音/无语音），由上层决定丢弃；
//   · AbortError 原样抛出（同一对象），不包装、不吞掉。
import { abortErrorOf, assertWavInput, normalizeLanguage } from './util.js'

export const SENSEVOICE_PROVIDER_ID = 'sensevoice'
export const DEFAULT_ASR_LANGUAGE = 'zh'

/**
 * @param {object} [options]
 * @param {{resolve: Function, transcribe: Function}} [options.speechToText]
 * @param {{speechToText?: {resolve: Function, transcribe: Function}}} [options.ctx]
 * @param {string} [options.language] 默认识别语言（默认 zh）
 * @returns {import('../contracts.js').AsrProvider}
 */
export function createSensevoiceProvider(options = {}) {
  const speechToText = options.speechToText ?? options.ctx?.speechToText
  assertSpeechToText(speechToText)
  const defaultLanguage = normalizeLanguage(options.language ?? DEFAULT_ASR_LANGUAGE)

  async function transcribe({ wav, sampleRate, language, signal } = {}) {
    assertWavInput(wav, SENSEVOICE_PROVIDER_ID)
    if (signal?.aborted) throw abortErrorOf(signal)

    const lang = normalizeLanguage(language ?? defaultLanguage)
    const resolveArgs = { audio: wav }
    if (lang) resolveArgs.language = lang

    const t0 = Date.now()
    let spec
    try {
      spec = await speechToText.resolve(resolveArgs)
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      if (signal?.aborted) throw abortErrorOf(signal)
      throw e
    }
    if (signal?.aborted) throw abortErrorOf(signal)
    if (spec === undefined || spec === null) {
      throw new Error('sensevoice：ctx.speechToText.resolve 未返回可用 spec')
    }

    const result = await speechToText.transcribe(spec, signal)
    if (signal?.aborted) throw abortErrorOf(signal)
    if (!result || typeof result.text !== 'string') {
      throw new Error('sensevoice：ctx.speechToText.transcribe 返回结果缺少字符串字段 text')
    }
    return { text: result.text.trim(), ms: Date.now() - t0 }
  }

  return { id: SENSEVOICE_PROVIDER_ID, transcribe }
}

// ── 内部 ────────────────────────────────────────────────────────────────────

function assertSpeechToText(speechToText) {
  if (
    !speechToText ||
    typeof speechToText.resolve !== 'function' ||
    typeof speechToText.transcribe !== 'function'
  ) {
    throw new Error(
      'sensevoice ASR 不可用：ctx.speechToText 缺失（DSH voice-input / 语音输入 bundle 未启用）。' +
      '请先在 DSH 插件中启用 voice-input 并重启宿主。',
    )
  }
}
