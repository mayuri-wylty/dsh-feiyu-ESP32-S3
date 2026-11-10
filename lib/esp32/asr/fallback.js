// T15：ASR 主备回退 + 按配置创建 provider（contracts.js → AsrProvider）
//
// 形状：
//   createFallbackAsrProvider({ primary, fallback, onFallback? }) → AsrProvider
//   createAsrProviderFromConfig(options?) → 按 config().esp32.asr.{primary,fallback,openai} 创建
//
// 回退规则（对齐 T17 lib/esp32/tts/fallback.js 的语义，针对单次非流式转写）：
//   · 主成功（含空文本）→ fallback 永不调用；
//   · 空文本是合法结果（静音/无语音，见设计 §5）→ 不回退；
//   · 主抛错/超时 → 才使用 fallback；
//   · AbortError（用户取消）→ 绝不回退，原样抛出；
//   · 两边都失败 → AggregateError，message 同时含 primary:/fallback:，
//     并附 primaryError / fallbackError；
//   · fallback 懒构造：创建阶段只校验 id，首次真正回退才 build；
//     构建错误按「fallback 失败」聚合，不会拖垮本来可用的 primary（T17 教训）。
//
// wrapper 的 id 沿用主 provider 的真实 id：contracts.js 的 AsrProvider.id 必须是
// ASR_PROVIDER_IDS 之一，契约没有 ASR 专用的 wrapper id；真实身份由 onFallback(from/to) 暴露。
import { config } from '../../../tools/lib/config.mjs'
import { ASR_PROVIDER_IDS } from '../contracts.js'
import { abortErrorOf } from './util.js'
import { createSensevoiceProvider, SENSEVOICE_PROVIDER_ID } from './sensevoice.js'
import { createOpenAICompatibleProvider, OPENAI_COMPATIBLE_PROVIDER_ID } from './openai.js'

/**
 * @param {object} args
 * @param {import('../contracts.js').AsrProvider|null} [args.primary]
 * @param {import('../contracts.js').AsrProvider|null} [args.fallback]
 * @param {(info: {from: string, to: string, error: Error}) => void} [args.onFallback]
 * @returns {import('../contracts.js').AsrProvider}
 */
export function createFallbackAsrProvider({ primary = null, fallback = null, onFallback } = {}) {
  if (!primary && !fallback) {
    throw new TypeError('createFallbackAsrProvider 至少需要一个 provider（primary 或 fallback）')
  }
  if (!primary) return fallback

  const notify = typeof onFallback === 'function' ? onFallback : null

  async function transcribe(args = {}) {
    let primaryError
    try {
      return await primary.transcribe(args)
    } catch (e) {
      throwIfAborted(e, args.signal)
      primaryError = e
    }
    if (args.signal?.aborted) throw abortErrorOf(args.signal)

    if (!fallback) throw primaryError

    let result
    try {
      result = await fallback.transcribe(args)
    } catch (e) {
      throwIfAborted(e, args.signal)
      throw combinedError(primaryError, e)
    }
    if (args.signal?.aborted) throw abortErrorOf(args.signal)

    if (notify) {
      // 通知只用于观测/日志，回调自身的 bug 不能影响已经成功的识别结果
      try {
        notify({ from: primary.id, to: fallback.id, error: primaryError })
      } catch { /* ignore */ }
    }
    return result
  }

  return { id: primary.id, transcribe }
}

/**
 * 按配置创建 provider，并按需包上主备回退。
 *
 * options 可覆盖配置（测试/调用方显式指定用）：
 *   { primary?, fallback?, openai?, speechToText?, ctx?, language?, timeoutMs?, fetch?, onFallback? }
 *   openai → { baseUrl?, apiKey?, model?, language?, timeoutMs?, fetch? }（逐字段覆盖配置）
 *
 * fallback 为空或与 primary 相同 → 直接返回 primary（不包无意义的回退）。
 * primary 为空时 fallback 充当主 provider，照常急切构建。
 *
 * @param {object} [options]
 * @returns {import('../contracts.js').AsrProvider}
 */
export function createAsrProviderFromConfig(options = {}) {
  const asr = config().esp32?.asr ?? {}
  const primaryId = normalizeId(options.primary ?? asr.primary)
  const fallbackId = normalizeId(options.fallback ?? asr.fallback)
  const openaiCfg = asr.openai ?? {}
  const openaiOverride = options.openai ?? {}

  const openaiOptions = {
    baseUrl: pick(openaiOverride, openaiCfg, 'baseUrl'),
    apiKey: pick(openaiOverride, openaiCfg, 'apiKey'),
    model: pick(openaiOverride, openaiCfg, 'model'),
    language: options.language ?? pick(openaiOverride, openaiCfg, 'language'),
    timeoutMs: options.timeoutMs ?? pick(openaiOverride, openaiCfg, 'timeoutMs'),
    fetch: options.fetch ?? openaiOverride.fetch,
  }

  const build = (id) => {
    assertKnownAsrId(id)
    if (id === SENSEVOICE_PROVIDER_ID) {
      return createSensevoiceProvider({
        speechToText: options.speechToText ?? options.ctx?.speechToText,
        language: options.language,
      })
    }
    return createOpenAICompatibleProvider(openaiOptions)
  }

  const primary = primaryId ? build(primaryId) : null
  if (!primary) {
    if (fallbackId) return build(fallbackId) // 没有 primary：fallback 就是主，照常急切构建
    throw new Error('未配置 ASR provider（请设置 esp32.asr.primary）')
  }
  if (!fallbackId || fallbackId === primaryId) return primary

  // 先校验 id（拼错要立刻报错），但真正的 provider 等首次回退再构造
  assertKnownAsrId(fallbackId)
  const lazyFallback = createLazyProvider(fallbackId, () => build(fallbackId))
  return createFallbackAsrProvider({
    primary,
    fallback: lazyFallback,
    onFallback: options.onFallback,
  })
}

// ── 内部 ────────────────────────────────────────────────────────────────────

function normalizeId(value) {
  return String(value ?? '').trim()
}

function assertKnownAsrId(id) {
  if (ASR_PROVIDER_IDS.includes(id)) return
  throw new Error(`未知的 ASR provider：${id}（支持 ${ASR_PROVIDER_IDS.join(' / ')}）`)
}

function pick(overrides, base, key) {
  return overrides?.[key] !== undefined ? overrides[key] : base?.[key]
}

/** 懒构造包装：id 立即暴露为真实 id，transcribe 首次调用时才执行 build（失败即抛给回退层）。 */
function createLazyProvider(id, build) {
  let instance = null
  async function transcribe(args) {
    if (!instance) instance = build()
    return instance.transcribe(args)
  }
  return { id, transcribe }
}

/** 用户取消（或 provider 报 AbortError）→ 规范化中止；绝不回退。 */
function throwIfAborted(error, signal) {
  if (error?.name === 'AbortError') throw error
  if (signal?.aborted) throw abortErrorOf(signal)
}

function combinedError(primaryError, fallbackError) {
  const message =
    `ASR 主备均失败（primary: ${primaryError?.message ?? primaryError}；` +
    `fallback: ${fallbackError?.message ?? fallbackError}）`
  const err = new AggregateError([primaryError, fallbackError], message)
  err.primaryError = primaryError
  err.fallbackError = fallbackError
  return err
}
