// ESP32 通道 · T23「管线工厂 + 通道日志」接线测试
//
// 覆盖：
// 1. createChannelLog：空文本跳过、role 归一、容量淘汰、跨设备合并排序、
//    metrics（turns/lastAt/latency/eventLoopMaxMs）、clear；
// 2. normalizePipelineId：合法值原样、非法/空回落 qa；
// 3. sovitsOptions：esp32.tts.ref > voice.ref_audio_path > {}；
// 4. createEsp32PipelineFactory 分派：
//    echo → 回声管线；asr 且 ASR 不可用 → 降级回声 + warn；
//    asr 且 ASR 可用 → ASR 管线（有 stats）；qa 且依赖齐全 → 问答管线（有 drain）；
//    qa 且 TTS provider 非法 → 降级回声；pipeline 非法值 → 按 qa 处理；
//    读配置抛错 → 按默认（qa）且不崩。
//
// 全部 fake；不联网、不写真实 ~/.dsh 配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：必须在 import 业务模块之前设置（paths.mjs 在导入时读取） ─────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-wiring-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const { createChannelLog } = await import('../lib/esp32/channel-log.js')
const {
  createEsp32PipelineFactory,
  normalizePipelineId,
  sovitsOptions,
  PIPELINE_IDS,
  DEFAULT_PIPELINE_ID,
} = await import('../lib/esp32/pipeline/index.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 工具 ────────────────────────────────────────────────────────────────────

function makeLogger() {
  const warns = []
  return {
    warns,
    debug() {},
    info() {},
    warn(message, meta) { warns.push({ message: String(message ?? ''), meta }) },
    error() {},
  }
}

/** 最小会话 ctx：只满足管线构造与下发所需。 */
function makeCtx(deviceId = 'wiring-dev') {
  const sent = []
  return {
    sent,
    sendJson: (json) => { sent.push({ kind: 'json', json }); return true },
    sendBinary: (buffer) => { sent.push({ kind: 'binary', buffer }); return true },
    getState: () => 'listening',
    transition: () => true,
    sendStt: (text) => { sent.push({ kind: 'stt', text }); return true },
    sendTts: (args) => { sent.push({ kind: 'tts', ...args }); return true },
    sendLlm: (args) => { sent.push({ kind: 'llm', ...args }); return true },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    getSignal: () => null,
    logger: makeLogger(),
    deviceId,
    clientId: 'wiring-cli',
    sessionId: 'wiring-sess',
    remoteAddress: '127.0.0.1',
  }
}

/** fake speechToText：满足 sensevoice provider 的 resolve/transcribe 形状。 */
function makeFakeStt() {
  return {
    async resolve() { return { id: 'spec' } },
    async transcribe() { return { text: '你好' } },
  }
}

function makeFactory({ esp32 = {}, voice = {}, stt = null, logger = makeLogger() } = {}) {
  return {
    logger,
    createPipeline: createEsp32PipelineFactory({
      getConfig: () => ({ esp32, voice }),
      getSpeechToText: () => stt,
      logger,
    }),
  }
}

// ── 1. createChannelLog ─────────────────────────────────────────────────────

test('channelLog：空文本/空白文本不记录', () => {
  const log = createChannelLog()
  log.append({ deviceId: 'd1', role: 'user', text: '' })
  log.append({ deviceId: 'd1', role: 'user', text: '   ' })
  log.append({ deviceId: 'd1', role: 'user' })
  assert.deepEqual(log.recent('d1'), [])
  assert.equal(log.metrics('d1').turns, 0)
})

test('channelLog：role 归一（未知角色按 user）', () => {
  const log = createChannelLog()
  log.append({ deviceId: 'd1', role: 'assistant', text: 'a' })
  log.append({ deviceId: 'd1', role: 'system', text: 's' })
  log.append({ deviceId: 'd1', role: 'weird', text: 'u' })
  log.append({ deviceId: 'd1', text: 'no-role' })
  assert.deepEqual(log.recent('d1').map((r) => r.role), ['assistant', 'system', 'user', 'user'])
})

test('channelLog：容量淘汰最旧记录', () => {
  const log = createChannelLog({ capacity: 3 })
  for (let i = 0; i < 5; i++) log.append({ deviceId: 'd1', role: 'user', text: `t${i}` })
  assert.deepEqual(log.recent('d1').map((r) => r.text), ['t2', 't3', 't4'])
  // 淘汰不影响累计轮次
  assert.equal(log.metrics('d1').turns, 5)
})

test('channelLog：recent 按设备取尾部、limit 生效', () => {
  const log = createChannelLog()
  for (let i = 0; i < 5; i++) log.append({ deviceId: 'd1', role: 'user', text: `a${i}` })
  for (let i = 0; i < 3; i++) log.append({ deviceId: 'd2', role: 'user', text: `b${i}` })
  assert.deepEqual(log.recent('d1', 2).map((r) => r.text), ['a3', 'a4'])
  assert.deepEqual(log.recent('d2').map((r) => r.text), ['b0', 'b1', 'b2'])
  assert.deepEqual(log.recent('nope'), [])
})

test('channelLog：recent("") 合并所有设备并按时间排序', () => {
  let clock = 0
  const log = createChannelLog({ now: () => ++clock })
  log.append({ deviceId: 'd1', role: 'user', text: 'first' })
  log.append({ deviceId: 'd2', role: 'user', text: 'second' })
  log.append({ deviceId: 'd1', role: 'assistant', text: 'third' })
  assert.deepEqual(log.recent('').map((r) => r.text), ['first', 'second', 'third'])
  assert.deepEqual(log.recent('', 2).map((r) => r.text), ['second', 'third'])
})

test('channelLog：metrics 汇总 turns/lastAt/latency/eventLoopMaxMs', () => {
  let clock = 100
  const log = createChannelLog({ now: () => clock })
  log.append({ deviceId: 'd1', role: 'user', text: 'q1' })
  clock = 200
  log.append({
    deviceId: 'd1',
    role: 'assistant',
    text: 'a1',
    meta: { latency: { totalMs: 900, llmFirstMs: 300 }, eventLoopMaxMs: 12 },
  })
  clock = 300
  log.append({ deviceId: 'd1', role: 'user', text: 'q2' })
  clock = 400
  log.append({
    deviceId: 'd1',
    role: 'assistant',
    text: 'a2',
    meta: { latency: { totalMs: 700 }, eventLoopMaxMs: 5 },
  })

  const m = log.metrics('d1')
  assert.equal(m.turns, 2)
  assert.equal(m.lastAt, 400)
  assert.deepEqual(m.latency, { totalMs: 700 }) // 取最近一条带 latency 的记录
  assert.equal(m.eventLoopMaxMs, 12) // 取历史最大值

  // 未指定设备：turns 求和、lastAt 取最大
  const all = log.metrics('')
  assert.equal(all.turns, 2)
  assert.equal(all.lastAt, 400)
  assert.equal(all.eventLoopMaxMs, 12)
})

test('channelLog：clear 单设备 / 全部', () => {
  const log = createChannelLog()
  log.append({ deviceId: 'd1', role: 'user', text: 'a' })
  log.append({ deviceId: 'd2', role: 'user', text: 'b' })
  log.clear('d1')
  assert.deepEqual(log.recent('d1'), [])
  assert.equal(log.recent('d2').length, 1)
  log.clear()
  assert.deepEqual(log.recent(''), [])
})

test('channelLog：recent 返回副本，外部修改不污染内部', () => {
  const log = createChannelLog()
  log.append({ deviceId: 'd1', role: 'user', text: 'a' })
  const rows = log.recent('d1')
  rows[0].text = 'hacked'
  assert.equal(log.recent('d1')[0].text, 'a')
})

// ── 2. normalizePipelineId ─────────────────────────────────────────────────

test('normalizePipelineId：合法值原样、大小写/空白容错、非法回落默认', () => {
  for (const id of PIPELINE_IDS) assert.equal(normalizePipelineId(id), id)
  assert.equal(normalizePipelineId('  ECHO '), 'echo')
  assert.equal(normalizePipelineId('nope'), DEFAULT_PIPELINE_ID)
  assert.equal(normalizePipelineId(''), DEFAULT_PIPELINE_ID)
  assert.equal(normalizePipelineId(undefined), DEFAULT_PIPELINE_ID)
  assert.equal(normalizePipelineId(null), DEFAULT_PIPELINE_ID)
})

// ── 3. sovitsOptions ───────────────────────────────────────────────────────

test('sovitsOptions：esp32.tts.ref 优先于 voice.ref_audio_path', () => {
  const out = sovitsOptions(
    { tts: { ref: { ref_audio_path: ' D:\\a.wav ', prompt_text: '甲' } } },
    { ref_audio_path: 'D:\\b.wav', prompt_text: '乙' },
  )
  assert.deepEqual(out, { ref: { ref_audio_path: 'D:\\a.wav', prompt_text: '甲' } })
})

test('sovitsOptions：esp32.tts.ref 为空时用 voice.ref_audio_path', () => {
  const out = sovitsOptions(
    { tts: { ref: { ref_audio_path: '   ', prompt_text: '甲' } } },
    { ref_audio_path: 'D:\\b.wav', prompt_text: '乙' },
  )
  assert.deepEqual(out, { ref: { ref_audio_path: 'D:\\b.wav', prompt_text: '乙' } })
})

test('sovitsOptions：两者都空返回 {}（不伪造路径）', () => {
  assert.deepEqual(sovitsOptions({}, {}), {})
  assert.deepEqual(sovitsOptions(undefined, undefined), {})
  assert.deepEqual(sovitsOptions({ tts: { ref: { ref_audio_path: 123 } } }, { ref_audio_path: '' }), {})
})

// ── 4. 管线分派 ────────────────────────────────────────────────────────────

test('factory：pipeline=echo → 回声管线（无 stats/drain）', () => {
  const { createPipeline } = makeFactory({ esp32: { pipeline: 'echo' } })
  const pipeline = createPipeline(makeCtx())
  assert.equal(typeof pipeline.onAudio, 'function')
  assert.equal(pipeline.stats, undefined)
  assert.equal(pipeline.drain, undefined)
})

test('factory：pipeline=asr 且 ASR 不可用 → 降级回声 + warn', () => {
  const logger = makeLogger()
  const { createPipeline } = makeFactory({ esp32: { pipeline: 'asr' }, stt: null, logger })
  const pipeline = createPipeline(makeCtx())
  assert.equal(pipeline.stats, undefined)
  assert.ok(logger.warns.some((w) => w.message.includes('ASR 不可用')))
})

test('factory：pipeline=asr 且 ASR 可用 → ASR 管线（有 stats）', () => {
  const { createPipeline } = makeFactory({ esp32: { pipeline: 'asr' }, stt: makeFakeStt() })
  const pipeline = createPipeline(makeCtx())
  assert.equal(typeof pipeline.stats, 'object')
  assert.equal(typeof pipeline.onAudio, 'function')
})

test('factory：pipeline=qa 且依赖齐全 → 问答管线（有 drain）', () => {
  const { createPipeline } = makeFactory({
    esp32: { pipeline: 'qa', tts: { provider: 'sovits-sentence' } },
    stt: makeFakeStt(),
  })
  const pipeline = createPipeline(makeCtx())
  assert.equal(typeof pipeline.drain, 'function')
  assert.equal(typeof pipeline.onVad, 'function')
})

test('factory：pipeline=qa 但 TTS provider 非法 → 降级回声 + warn', () => {
  const logger = makeLogger()
  const { createPipeline } = makeFactory({
    esp32: { pipeline: 'qa', tts: { provider: 'no-such-provider' } },
    stt: makeFakeStt(),
    logger,
  })
  const pipeline = createPipeline(makeCtx())
  assert.equal(pipeline.drain, undefined)
  assert.ok(logger.warns.some((w) => w.message.includes('TTS provider 构造失败')))
  assert.ok(logger.warns.some((w) => w.message.includes('降级为回声管线')))
})

test('factory：pipeline 非法值 → 按 qa 处理', () => {
  const { createPipeline } = makeFactory({
    esp32: { pipeline: 'bogus', tts: { provider: 'sovits-sentence' } },
    stt: makeFakeStt(),
  })
  assert.equal(typeof createPipeline(makeCtx()).drain, 'function')
})

test('factory：读配置抛错 → 按默认管线且不崩（无 ASR → 回声）', () => {
  const logger = makeLogger()
  const createPipeline = createEsp32PipelineFactory({
    getConfig: () => { throw new Error('config boom') },
    getSpeechToText: () => null,
    logger,
  })
  const pipeline = createPipeline(makeCtx())
  assert.equal(typeof pipeline.onAudio, 'function')
  assert.ok(logger.warns.some((w) => w.message.includes('读取配置失败')))
})

test('factory：getSpeechToText 抛错 → 按不可用处理（降级回声）', () => {
  const logger = makeLogger()
  const createPipeline = createEsp32PipelineFactory({
    getConfig: () => ({ esp32: { pipeline: 'qa' } }),
    getSpeechToText: () => { throw new Error('stt boom') },
    logger,
  })
  const pipeline = createPipeline(makeCtx())
  assert.equal(pipeline.drain, undefined)
  assert.ok(logger.warns.some((w) => w.message.includes('解析 speechToText 失败')))
})

test('factory：依赖按配置签名缓存，配置不变复用同一实例', () => {
  const stt = makeFakeStt()
  const esp32 = { pipeline: 'qa', tts: { provider: 'sovits-sentence' } }
  const { createPipeline } = makeFactory({ esp32, stt })
  const a = createPipeline(makeCtx('dev-a'))
  const b = createPipeline(makeCtx('dev-b'))
  // 两个会话各自拿到独立管线对象，但内部 ASR/TTS/brain 是同一份缓存
  assert.notEqual(a, b)
  assert.equal(typeof a.drain, 'function')
  assert.equal(typeof b.drain, 'function')
})
