// T17：TTS 主备回退（contracts.js → TtsProvider）
//
// 形状：
//   createFallbackProvider({ primary, fallback, onFallback? }) → { id: 'fallback', stream }
//   createTtsProviderFromConfig(options?) → 按 config().esp32.tts.{provider,fallback} 创建
//
// 回退规则（避免重复/拼接音频）：
//   · 主在**未 yield 任何 chunk** 时失败（抛错或空流）→ 才调用 fallback；
//   · 主已 yield 过 chunk 后失败 → 不回退，原样抛错；
//   · 用户 signal 中止（AbortError）→ 不回退；
//   · fallback 也失败 → AggregateError，message 同时包含 primary:/fallback:；
//   · 主成功 → fallback 永不调用；
//   · 空白文本 → 空流，两个 provider 都不调用。
//
// 外层包装 id 为 'fallback'；onFallback 里的 from/to 使用 provider 真实 id。
import { config } from '../../../tools/lib/config.mjs'
import { abortErrorOf } from './queue.js'
import { createCloudProvider } from './cloud.js'
import { createSovitsSentenceProvider, SOVITS_SENTENCE_ID } from './sovits-sentence.js'

export const FALLBACK_PROVIDER_ID = 'fallback'

/**
 * @param {object} args
 * @param {import('../contracts.js').TtsProvider|null} [args.primary]
 * @param {import('../contracts.js').TtsProvider|null} [args.fallback]
 * @param {(info: {from: string, to: string, error: Error}) => void} [args.onFallback]
 * @returns {import('../contracts.js').TtsProvider}
 */
export function createFallbackProvider({ primary = null, fallback = null, onFallback } = {}) {
  if (!primary && !fallback) {
    throw new TypeError('createFallbackProvider 至少需要一个 provider（primary 或 fallback）')
  }
  const notify = typeof onFallback === 'function' ? onFallback : null

  /** @type {import('../contracts.js').TtsStreamFn} */
  async function* stream(text, opts = {}) {
    const input = String(text ?? '')
    if (!input.trim()) return // 空白文本：两个 provider 都不请求

    if (!primary) {
      yield* fallback.stream(input, opts)
      return
    }

    let yielded = 0
    let primaryError = null
    let primaryEmpty = false
    try {
      for await (const chunk of primary.stream(input, opts)) {
        yielded += 1
        yield chunk
      }
      if (yielded === 0) primaryEmpty = true
    } catch (e) {
      throwIfAborted(e, opts.signal)
      if (yielded > 0) throw e // 已经出过音频：绝不回退（会重复/拼接）
      primaryError = e
    }
    if (opts.signal?.aborted) throw abortErrorOf(opts.signal) // provider 忽略 signal 但用户已取消

    if (yielded > 0) return

    if (!fallback) {
      if (primaryError) throw primaryError
      return // 主 provider 空流、且没有备选：安静地返回空流
    }

    // 主失败（抛错或空流）→ 尝试 fallback
    const triggerError = primaryError ?? emptyStreamError(primary)
    let fallbackYielded = 0
    try {
      for await (const chunk of fallback.stream(input, opts)) {
        fallbackYielded += 1
        yield chunk
      }
    } catch (e) {
      throwIfAborted(e, opts.signal)
      throw combinedError(triggerError, e)
    }

    if (fallbackYielded === 0) {
      throw combinedError(triggerError, emptyStreamError(fallback))
    }

    if (notify) {
      // 通知只用于观测/日志，回调自身的 bug 不能把已经合成的语音搞崩
      try {
        notify({ from: primary.id, to: fallback.id, error: triggerError })
      } catch { /* ignore */ }
    }
  }

  return { id: FALLBACK_PROVIDER_ID, stream }
}

/**
 * 按配置创建 provider，并按需包上主备回退。
 *
 * options 可覆盖配置（测试/调用方显式指定用）：
 *   { provider?, fallback?, sovits?, cloud?, onFallback? }
 *   sovits → createSovitsSentenceProvider(options.sovits)
 *   cloud  → createCloudProvider(options.cloud)
 *
 * fallback 为空或与 primary 相同 → 直接返回 primary（不包无意义的 fallback）。
 *
 * @param {object} [options]
 * @returns {import('../contracts.js').TtsProvider}
 */
export function createTtsProviderFromConfig(options = {}) {
  const tts = config().esp32?.tts ?? {}
  const primaryId = normalizeId(options.provider ?? tts.provider)
  const fallbackId = normalizeId(options.fallback ?? tts.fallback)

  const build = (id) => {
    if (id === SOVITS_SENTENCE_ID) return createSovitsSentenceProvider(options.sovits ?? {})
    if (id === 'cloud') return createCloudProvider(options.cloud ?? {})
    throw new Error(`未知的 TTS provider：${id}（支持 ${SOVITS_SENTENCE_ID} / cloud）`)
  }

  const primary = primaryId ? build(primaryId) : null
  const fallback = fallbackId && fallbackId !== primaryId ? build(fallbackId) : null

  if (!primary) {
    if (fallback) return fallback
    throw new Error('未配置 TTS provider（请设置 esp32.tts.provider）')
  }
  if (!fallback) return primary

  return createFallbackProvider({ primary, fallback, onFallback: options.onFallback })
}

// ── 内部 ────────────────────────────────────────────────────────────────────

function normalizeId(value) {
  return String(value ?? '').trim()
}

/** 用户取消（或 provider 报 AbortError）→ 规范成 AbortError；绝不回退。 */
function throwIfAborted(error, signal) {
  if (error?.name === 'AbortError') {
    throw signal?.aborted ? abortErrorOf(signal) : error
  }
  if (signal?.aborted) throw abortErrorOf(signal)
}

function emptyStreamError(provider) {
  const e = new Error(`TTS provider ${provider?.id ?? 'unknown'} 未返回音频`)
  e.name = 'EmptyStreamError'
  return e
}

function combinedError(primaryError, fallbackError) {
  const message = `TTS 主备均失败（primary: ${primaryError?.message ?? primaryError}；fallback: ${fallbackError?.message ?? fallbackError}）`
  const err = new AggregateError([primaryError, fallbackError], message)
  err.primaryError = primaryError
  err.fallbackError = fallbackError
  return err
}
