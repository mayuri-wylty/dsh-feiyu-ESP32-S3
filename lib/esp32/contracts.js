// ESP32 通道契约（T00，Lead 独占文件）
//
// 目的：所有泳道只依赖本文件的常量与 JSDoc 形状，互不 import 对方的实现，
// 从而可以用 fake 实现并行开发。改动本文件 = 改契约，必须先由 Lead 更新并通知各道。
//
// 设计依据：docs/2026-11-10-esp32-feiyu-channel-design.md（工作区 docs/）

export const CONTRACT_VERSION = 1

// ── 协议常量（小智 WebSocket 协议） ─────────────────────────────────────────
export const PROTOCOL_VERSION = 1
export const OTA_PATH = '/xiaozhi/ota/'
export const WS_PATH = '/xiaozhi/v1/'
export const DEFAULT_PORT = 8765
export const HELLO_TIMEOUT_MS = 10_000

/** 设备 → 服务端 的 JSON 消息类型（未知类型必须忽略且不报错） */
export const DEVICE_MESSAGE_TYPES = Object.freeze(['hello', 'listen', 'abort', 'mcp'])
/** 服务端 → 设备 的 JSON 消息类型 */
export const SERVER_MESSAGE_TYPES = Object.freeze(['hello', 'stt', 'tts', 'llm'])
/** tts 消息的 state */
export const TTS_STATES = Object.freeze(['start', 'sentence_start', 'stop'])
/** listen 消息的 state / mode */
export const LISTEN_STATES = Object.freeze(['start', 'stop', 'detect'])
export const LISTEN_MODES = Object.freeze(['auto', 'manual', 'realtime'])

/** 音频参数（协议固定值，勿改） */
export const AUDIO = Object.freeze({
  uplink: Object.freeze({ sampleRate: 16000, channels: 1, frameMs: 60, samplesPerFrame: 960 }),
  downlink: Object.freeze({ sampleRate: 24000, channels: 1, frameMs: 60, samplesPerFrame: 1440 }),
})

// ── 会话状态机 ──────────────────────────────────────────────────────────────
/** @typedef {'idle'|'listening'|'recognizing'|'thinking'|'speaking'} SessionState */
export const SESSION_STATES = Object.freeze(['idle', 'listening', 'recognizing', 'thinking', 'speaking'])
export const isSessionState = (s) => SESSION_STATES.includes(s)

// ── 大脑桥事件流 ────────────────────────────────────────────────────────────
/**
 * @typedef {{type:'emotion', emotion:string}} BrainEmotionEvent
 * @typedef {{type:'sentence', text:string, index:number}} BrainSentenceEvent
 * @typedef {{type:'done', fullText:string}} BrainDoneEvent
 * @typedef {BrainEmotionEvent|BrainSentenceEvent|BrainDoneEvent} BrainEvent
 */
export const BRAIN_EVENT_TYPES = Object.freeze(['emotion', 'sentence', 'done'])

/**
 * 大脑桥：一个用户整句 → 情绪事件 + 逐句事件 + 完成事件。
 * 记忆写入、persona 装配、guard、情绪解析都在实现内部完成；调用方只消费事件。
 * 被打断时调用方 abort signal；实现必须只把「已下发音频的句子」记入记忆。
 * @typedef {(args: {
 *   deviceId: string, chatId: string, userId: string, text: string,
 *   isWakeGreeting?: boolean, signal?: AbortSignal
 * }) => AsyncIterable<BrainEvent>} HandleUtteranceFn
 */

// ── Provider 契约 ───────────────────────────────────────────────────────────
export const ASR_PROVIDER_IDS = Object.freeze(['sensevoice', 'openai-compatible'])
export const TTS_PROVIDER_IDS = Object.freeze(['sovits-sentence', 'sovits-stream', 'cloud'])
/** 包装型 provider：不是可配置的后端，而是对真实 provider 的组合（主备回退等）。 */
export const TTS_WRAPPER_PROVIDER_IDS = Object.freeze(['fallback'])

/**
 * @typedef {(args: {
 *   wav: Uint8Array, sampleRate: number, language?: string, signal?: AbortSignal
 * }) => Promise<{text: string, ms?: number}>} TranscribeFn
 *
 * @typedef {Object} AsrProvider
 * @property {string} id             // ASR_PROVIDER_IDS 之一
 * @property {TranscribeFn} transcribe
 */

/**
 * @typedef {(text: string, opts: {
 *   emotion?: string, signal?: AbortSignal
 * }) => AsyncIterable<{pcm: Int16Array, sampleRate: number}>} TtsStreamFn
 *
 * @typedef {Object} TtsProvider
 * @property {string} id             // TTS_PROVIDER_IDS 或 TTS_WRAPPER_PROVIDER_IDS 之一
 * @property {TtsStreamFn} stream
 */

// ── 通道日志 / 指标 ─────────────────────────────────────────────────────────
/**
 * @typedef {Object} ChannelLog
 * @property {(row: {
 *   deviceId: string, role: 'user'|'assistant'|'system', text: string,
 *   meta?: Record<string, unknown>
 * }) => void} append
 * @property {(deviceId: string, limit?: number) => Array<Record<string, unknown>>} recent
 * @property {(deviceId: string) => {
 *   turns: number, lastAt: number,
 *   latency: { vadMs?: number, asrMs?: number, llmFirstMs?: number, ttsFirstMs?: number, totalMs?: number },
 *   eventLoopMaxMs?: number
 * }} metrics
 */

/**
 * 会话（网关 ↔ 状态机之间的唯一 seam）。
 *
 * 语义约定（T13 裁决）：
 * - abort()：有活动轮次时取消并回落 listening，返回 true；无轮次/已关闭时完整
 *   no-op，返回 false（因此可重复调用）；`listen start` / `listen detect` 也会
 *   隐式取消旧轮次。
 * - close()：幂等；关闭后状态固定 idle，不再接受任何消息。公共 close 不回调
 *   网关注入的连接关闭函数，避免网关清理路径重入。
 * - handleJson 收到的 hello 也会透传（网关在 createSession 时同时注入 hello）。
 * - detect 模式：会话进入 listening 但上行音频全部丢弃，不跑 VAD/ASR；
 *   `listen stop` 取消并回到 idle（唤醒问候由管线 onListenStart 处理）。
 *
 * @typedef {Object} Session
 * @property {SessionState} state
 * @property {(json: Record<string, unknown>) => void} handleJson
 * @property {(chunk: Buffer) => void} handleAudio
 * @property {(reason?: string) => boolean} abort
 * @property {() => void} close
 */

// ── 会话管线 seam（T20-T22 使用）────────────────────────────────────────────
/**
 * 会话能力对象：管线通过它下发协议消息/音频。关闭或轮次被取消后，
 * 下发方法返回 false 并丢弃数据。
 * @typedef {Object} Esp32SessionContext
 * @property {(json: object) => boolean} sendJson
 * @property {(buffer: Uint8Array) => boolean} sendBinary
 * @property {() => SessionState} getState
 * @property {(state: SessionState, meta?: object) => boolean} transition
 * @property {(text: string) => boolean} sendStt
 * @property {(args: {state: 'start'|'sentence_start'|'stop', text?: string}) => boolean} sendTts
 * @property {(args: {emotion?: string, text?: string}) => boolean} sendLlm
 * @property {() => number} now
 * @property {(fn: Function, ms: number) => unknown} setTimer
 * @property {(handle: unknown) => void} clearTimer
 * @property {() => AbortSignal|null} getSignal
 * @property {object} logger
 * @property {string} deviceId
 * @property {string} clientId
 * @property {string} sessionId
 * @property {string} remoteAddress
 */

/**
 * 管线回调（全部可省略；返回 Promise 时 rejection 会被捕获，不影响会话）。
 * @typedef {Object} Esp32SessionPipeline
 * @property {(args: {hello: object}) => void|Promise<void>} [onOpen]
 * @property {(args: {mode: string, detect?: boolean, text?: string}) => void|Promise<void>} [onListenStart]
 * @property {() => void|Promise<void>} [onListenStop]
 * @property {(frame: Int16Array, meta: {sampleRate: number, samples: number}) => void|Promise<void>} [onAudio]
 * @property {(event: object, meta: {signal: AbortSignal|null}) => void|Promise<void>} [onVad]
 * @property {(args: {reason: string}) => void|Promise<void>} [onAbort]
 * @property {() => void|Promise<void>} [onClose]
 */

// ── 配置 ────────────────────────────────────────────────────────────────────
/** 配置默认值（config.mjs DEFAULTS.esp32 必须与此一致；本对象是唯一事实源） */
export const DEFAULT_ESP32_CONFIG = Object.freeze({
  enabled: true,
  port: DEFAULT_PORT,
  publicHost: '',
  token: '',
  allowDevices: [],
  idleDisconnectMs: 5 * 60_000,
  // 管线选择：qa=完整问答（默认）｜asr=只转写｜echo=上行原样回放（联调用）
  pipeline: 'qa',
  vad: Object.freeze({ silenceMs: 700, minSpeechMs: 250, maxSpeechMs: 30_000 }),
  asr: Object.freeze({
    primary: 'sensevoice',
    fallback: '',
    openai: Object.freeze({ baseUrl: '', apiKey: '', model: '' }),
  }),
  tts: Object.freeze({
    provider: 'sovits-sentence',
    fallback: '',
    cloud: Object.freeze({ baseUrl: '', apiKey: '', model: '', voice: '' }),
  }),
  personaHint: '',
  greetings: Object.freeze(['我在呢', '嗯？怎么啦']),
})

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 深合并 esp32 配置：override 覆盖默认值；数组整体替换。 */
export function mergeEsp32Config(override = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_ESP32_CONFIG))
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (isPlainObject(v) && isPlainObject(dst[k])) merge(dst[k], v)
      else if (v !== undefined) dst[k] = v
    }
    return dst
  }
  return merge(base, override)
}

/**
 * token 写回接口：把 patch 深合并进配置文件（~/.dsh/feiyu.config.json）并返回新配置。
 * 由 E 道在 tools/lib/config.mjs 实现；A 道只在需要写回自动生成的 token 时调用。
 * @typedef {(patch: {esp32?: Record<string, unknown>} & Record<string, unknown>) => Promise<Record<string, unknown>>} SaveEsp32ConfigFn
 */

// ── 情绪 → 固件表情名 ───────────────────────────────────────────────────────
/** 固件 SetEmotion 接受的名称（小智默认表情集合，见 xiaozhi-esp32-server textUtils.py） */
export const FIRMWARE_EMOTIONS = Object.freeze([
  'neutral', 'happy', 'laughing', 'funny', 'sad', 'angry', 'crying', 'loving',
  'embarrassed', 'surprised', 'shocked', 'thinking', 'winking', 'cool', 'relaxed',
  'delicious', 'kissy', 'confident', 'sleepy', 'silly', 'confused',
])

/** feiyu 情绪 key（tools/lib/emotion.mjs EMOTIONS）→ 固件表情名 */
export const EMOTION_TO_FIRMWARE = Object.freeze({
  calm: 'relaxed',
  happy: 'happy',
  coquettish: 'kissy',
  wronged: 'sad',
  angry: 'angry',
  sleepy: 'sleepy',
  shy: 'embarrassed',
  tender: 'loving',
  surprise: 'surprised',
})

/** 未知/空 → neutral（固件微信风格下 neutral 不显示表情，是安全兜底） */
export function firmwareEmotionOf(name) {
  return EMOTION_TO_FIRMWARE[String(name ?? '').trim()] || 'neutral'
}
