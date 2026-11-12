import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderTester } from '../lib/esp32/providers/test.js'

const ASR_VALUES = { baseUrl: 'http://x/v1', apiKey: 'test-key', model: 'm' }
const TTS_VALUES = { apiKey: 'test-key', resourceId: 'seed-tts-2.0', speaker: 'spk' }

test('ASR：发 1s 16k 静音 WAV，空文本也算连通', async () => {
  let seen
  const t = createProviderTester({
    createAsr: ({ id, config }) => ({ id, transcribe: async (a) => { seen = { id, config, a }; return { text: '' } } }),
  })
  const r = await t({ kind: 'asr', id: 'openai-compatible', values: ASR_VALUES })
  assert.equal(r.ok, true)
  assert.equal(seen.id, 'openai-compatible')
  assert.equal(seen.a.sampleRate, 16000)
  assert.equal(seen.a.wav.length, 44 + 32000)
})

test('ASR 错误脱敏：不回显 apiKey', async () => {
  const t = createProviderTester({
    createAsr: () => ({ transcribe: async () => { throw new Error('401 bad key test-key sent') } }),
  })
  const r = await t({ kind: 'asr', id: 'openai-compatible', values: ASR_VALUES })
  assert.equal(r.ok, false)
  assert.ok(!r.error.includes('test-key'))
  assert.ok(r.error.includes('401'))
})

test('TTS：取首块即 abort，返回 ttsFirstMs', async () => {
  let aborted = false, finalized = false, clock = 0
  const t = createProviderTester({
    now: () => (clock += 10),
    createTts: () => ({
      stream: async function* (text, { signal }) {
        assert.equal(text, '你好')
        signal.addEventListener('abort', () => { aborted = true })
        try {
          yield { pcm: new Int16Array(240), sampleRate: 24000 }
          yield { pcm: new Int16Array(240), sampleRate: 24000 }
        } finally { finalized = true }
      },
    }),
  })
  const r = await t({ kind: 'tts', id: 'volcengine', values: TTS_VALUES })
  assert.equal(r.ok, true)
  assert.ok(r.ttsFirstMs > 0)
  assert.equal(aborted, true)
  assert.equal(finalized, true)
})

test('TTS 无音频 → 失败', async () => {
  const t = createProviderTester({ createTts: () => ({ stream: async function* () {} }) })
  const r = await t({ kind: 'tts', id: 'volcengine', values: TTS_VALUES })
  assert.equal(r.ok, false)
})

test('超时：挂起的 provider 按 timeoutMs 失败', async () => {
  const t = createProviderTester({
    timeoutMs: 30,
    createAsr: () => ({ transcribe: () => new Promise(() => {}) }),
  })
  const r = await t({ kind: 'asr', id: 'volcengine', values: { apiKey: 'test-key', resourceId: 'r' } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('超时'))
})

test('校验：未知/本地/缺必填/工厂抛错', async () => {
  const t = createProviderTester({ createAsr: () => { throw new Error('构造失败 test-key') } })
  assert.equal((await t({ kind: 'asr', id: 'nope' })).ok, false)
  assert.match((await t({ kind: 'asr', id: 'sensevoice' })).error, /本地/)
  assert.match((await t({ kind: 'asr', id: 'openai-compatible', values: { baseUrl: 'x' } })).error, /缺少必填项/)
  const r = await t({ kind: 'asr', id: 'openai-compatible', values: ASR_VALUES })
  assert.equal(r.ok, false)
  assert.ok(!r.error.includes('test-key'))
})
