// ESP32 通道 · 管线工厂（T23 宿主接线的最后一根线）
//
// host.js 只认一个注入点：createPipeline(sessionCtx, { getSpeechToText, getConfig })。
// 本文件把「配置 → 选哪条管线 → 构造依赖」收在一处，宿主侧只负责传进来。
//
// 三条管线（见 ./echo.js / ./asr.js / ./qa.js）：
//   echo —— 上行原样回放，验证音频链路，不依赖任何外部服务
//   asr  —— VAD 切段 → ASR → stt 下发，不接大脑
//   qa   —— 完整问答：ASR → 大脑 → 句级 TTS → 24k Opus 下发（默认）
//
// 降级策略（宁可出声也不静默）：
//   · esp32.pipeline 配成 qa/asr 但 ASR 不可用（voice-input bundle 未启用）→ 回声管线 + warn
//   · qa 但 TTS provider 构造失败 → 回声管线 + warn
//   · 任何构造异常都不抛出到会话层（会话会 failSession），这里自己兜住
//
// 依赖缓存：ASR/TTS/brain 按「配置签名」缓存，配置改了自动重建；TTS 的 9880 串行
// 队列本身是模块级单例，多会话共享，不会并发打爆 GPT-SoVITS。

import { createEchoPipeline } from './echo.js'
import { createAsrPipeline } from './asr.js'
import { createQaPipeline } from './qa.js'
import { createAsrProviderFromConfig } from '../asr/fallback.js'
import { createTtsProviderFromConfig } from '../tts/fallback.js'
import { createBrainBridge } from '../brain-bridge.js'
import { mergeEsp32Config } from '../contracts.js'
import { apiKey as defaultApiKey } from '../../../tools/lib/llm.mjs'

export const PIPELINE_IDS = Object.freeze(['qa', 'asr', 'echo'])
export const DEFAULT_PIPELINE_ID = 'qa'

const messageOf = (error) =>
  error && typeof error.message === 'string' ? error.message : String(error ?? '')

/** 非法/空值一律回落默认管线（配置写错不该让通道哑掉）。 */
export function normalizePipelineId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  return PIPELINE_IDS.includes(id) ? id : DEFAULT_PIPELINE_ID
}

/**
 * GPT-SoVITS 参考段：优先 esp32.tts.ref，其次 voice.ref_audio_path。
 * 两者都空时返回 {} —— provider 会走 refPool，若仍为空则 9880 返回 400，
 * 这是配置问题，不该由这里伪造一个路径。
 */
export function sovitsOptions(esp32, voice) {
  const refCfg = esp32?.tts?.ref
  if (refCfg && typeof refCfg.ref_audio_path === 'string' && refCfg.ref_audio_path.trim()) {
    return {
      ref: {
        ref_audio_path: refCfg.ref_audio_path.trim(),
        prompt_text: String(refCfg.prompt_text ?? ''),
      },
    }
  }
  if (typeof voice?.ref_audio_path === 'string' && voice.ref_audio_path.trim()) {
    return {
      ref: {
        ref_audio_path: voice.ref_audio_path.trim(),
        prompt_text: String(voice.prompt_text ?? ''),
      },
    }
  }
  return {}
}

/**
 * @param {{
 *   getConfig?: () => object,
 *   getSpeechToText?: () => object|null,
 *   apiKey?: () => string,
 *   channelLog?: import('../contracts.js').ChannelLog,
 *   logger?: object,
 * }} [options]
 * @returns {(sessionCtx: import('../contracts.js').Esp32SessionContext, hostDeps?: {reportError?: Function}) => import('../contracts.js').Esp32SessionPipeline}
 */
export function createEsp32PipelineFactory(options = {}) {
  const readConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({})
  const resolveStt = typeof options.getSpeechToText === 'function' ? options.getSpeechToText : () => null
  const resolveApiKey = typeof options.apiKey === 'function' ? options.apiKey : defaultApiKey
  const channelLog = options.channelLog ?? null
  const log = options.logger ?? {}

  /** @type {{key: string, asr: object|null, tts: object|null, brain: object|null}|null} */
  let cache = null
  /** 空 Key 告警按配置签名去重：同一配置只在首次构造问答管线时提醒一次。 */
  let keyWarnedFor = null

  /** 缺 Key 不阻断构造（失败会在对话时暴露），但要明确告警一次，别让设备静默卡住。 */
  function warnMissingKeyOnce(esp32) {
    let key = ''
    try { key = String(resolveApiKey() ?? '') } catch { key = '' }
    if (key) return
    const signature = JSON.stringify(esp32 ?? {})
    if (keyWarnedFor === signature) return
    keyWarnedFor = signature
    log.warn?.('LLM API Key 未配置：问答管线会在对话时失败（请配置 llm.api_key 或环境变量 DEEPSEEK_API_KEY）')
  }

  function readAll() {
    try {
      const cfg = readConfig() ?? {}
      // 与默认值合并：配置文件里没写的字段（如 tts.provider）走契约默认值，
      // 否则 provider 会拿到空 id 直接抛「未配置 TTS provider」。
      return { esp32: mergeEsp32Config(cfg.esp32 ?? {}), voice: cfg.voice ?? {} }
    } catch (error) {
      log.warn?.('读取配置失败，按默认管线运行：' + messageOf(error))
      return { esp32: mergeEsp32Config({}), voice: {} }
    }
  }

  function buildDeps(esp32, voice) {
    const stt = (() => {
      try { return resolveStt() } catch (error) {
        log.warn?.('解析 speechToText 失败，按不可用处理：' + messageOf(error))
        return null
      }
    })()
    const sovits = sovitsOptions(esp32, voice)
    const key = JSON.stringify([
      Boolean(stt),
      esp32?.asr?.primary ?? '',
      esp32?.asr?.fallback ?? '',
      esp32?.tts?.provider ?? '',
      esp32?.tts?.fallback ?? '',
      sovits.ref?.ref_audio_path ?? '',
    ])
    if (cache && cache.key === key) return cache

    let asr = null
    if (stt) {
      try {
        // 显式传 primary/fallback：本工厂读到的 esp32 配置就是唯一事实源，
        // 不让 provider 再去读一遍配置文件（否则注入的配置与真实文件可能不一致）。
        asr = createAsrProviderFromConfig({
          speechToText: stt,
          primary: esp32?.asr?.primary,
          fallback: esp32?.asr?.fallback,
          openai: esp32?.asr?.openai,
        })
      } catch (error) {
        log.warn?.('ASR provider 构造失败：' + messageOf(error))
      }
    }

    let tts = null
    try {
      tts = createTtsProviderFromConfig({
        provider: esp32?.tts?.provider,
        fallback: esp32?.tts?.fallback,
        cloud: esp32?.tts?.cloud,
        sovits,
        sovitsStream: sovits,
      })
    } catch (error) {
      log.warn?.('TTS provider 构造失败：' + messageOf(error))
    }

    let brain = null
    try {
      brain = createBrainBridge()
    } catch (error) {
      log.warn?.('大脑桥构造失败：' + messageOf(error))
    }

    cache = { key, asr, tts, brain }
    return cache
  }

  return function createPipeline(sessionCtx, hostDeps = {}) {
    const { esp32, voice } = readAll()
    const id = normalizePipelineId(esp32.pipeline)
    const echo = () => createEchoPipeline({ ctx: sessionCtx, logger: log })

    if (id === 'echo') return echo()

    const deps = buildDeps(esp32, voice)

    if (id === 'asr') {
      if (!deps.asr) {
        log.warn?.('ASR 不可用（voice-input bundle 未启用？），降级为回声管线', { deviceId: sessionCtx?.deviceId })
        return echo()
      }
      return createAsrPipeline({ ctx: sessionCtx, asr: deps.asr, config: esp32, logger: log })
    }

    // qa
    if (!deps.asr) {
      log.warn?.('ASR 不可用（voice-input bundle 未启用？），降级为回声管线', { deviceId: sessionCtx?.deviceId })
      return echo()
    }
    if (!deps.tts || !deps.brain) {
      log.warn?.('TTS/大脑不可用，降级为回声管线', { deviceId: sessionCtx?.deviceId })
      return echo()
    }
    warnMissingKeyOnce(esp32)
    return createQaPipeline({
      ctx: sessionCtx,
      asr: deps.asr,
      tts: deps.tts,
      brain: deps.brain,
      config: esp32,
      channelLog,
      logger: log,
      chatId: `esp32:${sessionCtx?.deviceId ?? ''}`,
      onError: typeof hostDeps?.reportError === 'function' ? hostDeps.reportError : undefined,
    })
  }
}
