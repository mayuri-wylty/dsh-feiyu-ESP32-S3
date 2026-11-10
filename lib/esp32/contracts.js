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
 * @property {string} id             // TTS_PROVIDER_IDS 之一
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
 * @typedef {Object} Session
 * @property {SessionState} state
 * @property {(json: Record<string, unknown>) => void} handleJson
 * @property {(chunk: Buffer) => void} handleAudio
 * @property {(reason?: string) => void} abort
 * @property {() => void} close
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
