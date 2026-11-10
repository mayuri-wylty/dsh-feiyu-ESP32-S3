// ESP32 通道契约自检（T00）
// 只校验 lib/esp32/contracts.js 自身的形状与默认值，不依赖任何泳道实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTRACT_VERSION, PROTOCOL_VERSION, OTA_PATH, WS_PATH, DEFAULT_PORT,
  DEVICE_MESSAGE_TYPES, SERVER_MESSAGE_TYPES, TTS_STATES, LISTEN_STATES, LISTEN_MODES,
  SESSION_STATES, isSessionState, AUDIO, BRAIN_EVENT_TYPES,
  ASR_PROVIDER_IDS, TTS_PROVIDER_IDS,
  DEFAULT_ESP32_CONFIG, mergeEsp32Config,
  FIRMWARE_EMOTIONS, EMOTION_TO_FIRMWARE, firmwareEmotionOf,
} from '../lib/esp32/contracts.js'
import { EMOTIONS } from '../tools/lib/emotion.mjs'

test('契约版本与协议常量', () => {
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(OTA_PATH, '/xiaozhi/ota/')
  assert.equal(WS_PATH, '/xiaozhi/v1/')
  assert.equal(DEFAULT_PORT, 8765)
})

test('消息类型与状态集合符合小智协议', () => {
  assert.deepEqual([...DEVICE_MESSAGE_TYPES], ['hello', 'listen', 'abort', 'mcp'])
  assert.deepEqual([...SERVER_MESSAGE_TYPES], ['hello', 'stt', 'tts', 'llm'])
  assert.deepEqual([...TTS_STATES], ['start', 'sentence_start', 'stop'])
  assert.deepEqual([...LISTEN_STATES], ['start', 'stop', 'detect'])
  assert.deepEqual([...LISTEN_MODES], ['auto', 'manual', 'realtime'])
  assert.deepEqual([...BRAIN_EVENT_TYPES], ['emotion', 'sentence', 'done'])
})

test('会话状态集合可判定', () => {
  assert.deepEqual([...SESSION_STATES], ['idle', 'listening', 'recognizing', 'thinking', 'speaking'])
  for (const s of SESSION_STATES) assert.equal(isSessionState(s), true)
  assert.equal(isSessionState('talking'), false)
})

test('音频参数：上行 16k/960，下行 24k/1440', () => {
  assert.deepEqual({ ...AUDIO.uplink }, { sampleRate: 16000, channels: 1, frameMs: 60, samplesPerFrame: 960 })
  assert.deepEqual({ ...AUDIO.downlink }, { sampleRate: 24000, channels: 1, frameMs: 60, samplesPerFrame: 1440 })
  assert.equal(AUDIO.uplink.sampleRate * AUDIO.uplink.frameMs / 1000, AUDIO.uplink.samplesPerFrame)
  assert.equal(AUDIO.downlink.sampleRate * AUDIO.downlink.frameMs / 1000, AUDIO.downlink.samplesPerFrame)
})

test('provider id 集合非空且唯一', () => {
  for (const list of [ASR_PROVIDER_IDS, TTS_PROVIDER_IDS]) {
    assert.ok(list.length > 0)
    assert.equal(new Set(list).size, list.length)
  }
  assert.ok(ASR_PROVIDER_IDS.includes('sensevoice'))
  assert.ok(TTS_PROVIDER_IDS.includes('sovits-sentence'))
  assert.ok(TTS_PROVIDER_IDS.includes('sovits-stream'))
  assert.ok(TTS_PROVIDER_IDS.includes('cloud'))
})

test('默认 esp32 配置形状', () => {
  const c = DEFAULT_ESP32_CONFIG
  assert.equal(c.enabled, true)
  assert.equal(c.port, 8765)
  assert.equal(c.token, '')
  assert.deepEqual([...c.allowDevices], [])
  assert.equal(c.vad.silenceMs, 700)
  assert.equal(c.vad.maxSpeechMs, 30000)
  assert.equal(c.asr.primary, 'sensevoice')
  assert.equal(c.tts.provider, 'sovits-sentence')
  assert.ok(Array.isArray([...c.greetings]))
})

test('mergeEsp32Config 深合并、数组整体替换、返回可变副本', () => {
  const merged = mergeEsp32Config({
    port: 9000,
    vad: { silenceMs: 500 },
    greetings: ['嗨'],
  })
  assert.equal(merged.port, 9000)
  assert.equal(merged.vad.silenceMs, 500)
  assert.equal(merged.vad.minSpeechMs, 250) // 未覆盖的保留默认
  assert.deepEqual(merged.greetings, ['嗨']) // 数组整体替换
  assert.notEqual(merged, DEFAULT_ESP32_CONFIG)
  merged.vad.silenceMs = 1 // 默认值不被污染
  assert.equal(DEFAULT_ESP32_CONFIG.vad.silenceMs, 700)
})

test('每个 feiyu 情绪都映射到合法固件表情', () => {
  const keys = Object.keys(EMOTIONS)
  assert.ok(keys.length >= 9)
  for (const k of keys) {
    assert.ok(EMOTION_TO_FIRMWARE[k], `缺少 feiyu 情绪映射: ${k}`)
    assert.ok(FIRMWARE_EMOTIONS.includes(EMOTION_TO_FIRMWARE[k]), `映射目标非法: ${k} -> ${EMOTION_TO_FIRMWARE[k]}`)
  }
})

test('未知情绪回落 neutral', () => {
  assert.equal(firmwareEmotionOf('calm'), 'relaxed')
  assert.equal(firmwareEmotionOf('happy'), 'happy')
  assert.equal(firmwareEmotionOf('nonexistent'), 'neutral')
  assert.equal(firmwareEmotionOf(''), 'neutral')
  assert.equal(firmwareEmotionOf(null), 'neutral')
  assert.equal(firmwareEmotionOf(undefined), 'neutral')
})
