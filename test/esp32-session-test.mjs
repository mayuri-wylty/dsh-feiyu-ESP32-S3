// ESP32 第五通道 · T13「会话状态机」测试
//
// 覆盖：
// 1. 完整状态序列 idle → listening → recognizing → thinking → speaking → listening；
// 2. listen start / stop / detect 语义（manual 不跑 VAD、detect 不进 ASR）；
// 3. abort 幂等、AbortSignal 取消、tts stop 收尾、状态回落 listening；
// 4. Opus 解码异常只丢包、不抛给网关；
// 5. 管线同步/异步异常只关闭本会话（close(1011)），不影响其他会话；
// 6. 空闲超时（可配置、活动重置、注入 close(1000, 'idle timeout')）；
// 7. close 幂等、清理定时器、不重复调用注入的 close；
// 8. 新轮次打断旧轮次（旧 signal 取消 + tts stop）；
// 9. hello 容错、未知消息忽略、非法状态迁移不抛；
// 10. 无管线时仍可安全运行（T14 模拟设备）。
//
// 全部使用 fake 管线 / fake VAD / 假定时器；不联网、不写真实 ~/.dsh 配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：必须在 import 业务模块之前设置（paths.mjs 在导入时读取） ─────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-session-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const { createEsp32Session } = await import('../lib/esp32/session.js')
const { OpusEncoder } = await import('../lib/esp32/audio/opus.js')
const { AUDIO, SESSION_STATES } = await import('../lib/esp32/contracts.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 测试工具 ────────────────────────────────────────────────────────────────
const encoder = new OpusEncoder(AUDIO.uplink.sampleRate)
test.after(() => encoder.close())

/** 生成一个合法的 16k/60ms/960 点 Opus 上行包（静音）。 */
function opusPacket() {
  return Buffer.from(encoder.encode(new Int16Array(AUDIO.uplink.samplesPerFrame)))
}

/** 可控时钟：setTimer/clearTimer/now 注入会话，advance 按到期时间顺序执行。 */
function createClock() {
  let current = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = ++seq
      const delay = Number.isFinite(Number(ms)) && Number(ms) >= 0 ? Number(ms) : 0
      timers.set(id, { id, at: current + delay, fn })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms
      for (;;) {
        let next = null
        for (const timer of timers.values()) {
          if (timer.at > target) continue
          if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer
        }
        if (!next) break
        timers.delete(next.id)
        current = next.at
        next.fn()
      }
      current = target
    },
  }
}

function flattenLogs(logs) {
  return logs
    .map((row) => row.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
    .join('\n')
}

/**
 * 组装一个带 fake 管线 / fake 传输层 / 假时钟的会话。
 * pipeline hooks 通过 overrides.pipeline 覆盖；会话选项通过 overrides.session 覆盖。
 */
function createHarness(overrides = {}) {
  const clock = overrides.clock ?? createClock()
  const sentJson = []
  const sentBinary = []
  const closes = []
  const logs = []
  const calls = []
  const hooks = overrides.pipeline ?? {}
  let ctx = null

  const logger = {
    debug: (...args) => logs.push(['debug', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  }

  const pipeline = {}
  for (const name of ['onOpen', 'onListenStart', 'onListenStop', 'onAudio', 'onVad', 'onAbort', 'onClose']) {
    pipeline[name] = (...args) => {
      calls.push({ name, args })
      if (typeof hooks[name] === 'function') return hooks[name](...args)
      return undefined
    }
  }

  const session = createEsp32Session({
    deviceId: 'dev-1',
    clientId: 'cli-1',
    sessionId: 'sess-1',
    remoteAddress: '127.0.0.1',
    sendJson: (obj) => { sentJson.push(obj); return true },
    sendBinary: (buffer) => { sentBinary.push(buffer); return true },
    close: (code, reason) => { closes.push({ code, reason }) },
    logger,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    idleDisconnectMs: 60_000,
    createPipeline: (value) => { ctx = value; return pipeline },
    ...overrides.session,
  })

  return {
    session,
    clock,
    sentJson,
    sentBinary,
    closes,
    logs,
    calls,
    pipeline,
    get ctx() { return ctx },
    callsOf(name) { return calls.filter((call) => call.name === name) },
  }
}

// ── 1. 完整状态序列 ─────────────────────────────────────────────────────────
test('完整状态序列：hello → listening → recognizing → thinking → speaking → listening', () => {
  const h = createHarness()
  assert.equal(h.session.state, 'idle')

  const hello = { type: 'hello', version: 1, audio_params: { format: 'opus' } }
  h.session.handleJson(hello)
  h.session.handleJson(hello) // 重复 hello 容忍
  assert.equal(h.callsOf('onOpen').length, 1)
  assert.deepEqual(h.callsOf('onOpen')[0].args[0], { hello })
  assert.equal(h.session.state, 'idle')

  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  assert.equal(h.session.state, 'listening')
  assert.deepEqual(h.callsOf('onListenStart')[0].args[0], { mode: 'auto' })
  assert.ok(h.ctx.getSignal() instanceof AbortSignal)

  h.session.handleAudio(opusPacket())
  const audioCalls = h.callsOf('onAudio')
  assert.equal(audioCalls.length, 1)
  const [frame, meta] = audioCalls[0].args
  assert.ok(frame instanceof Int16Array)
  assert.equal(frame.length, AUDIO.uplink.samplesPerFrame)
  assert.deepEqual(meta, { sampleRate: AUDIO.uplink.sampleRate, samples: AUDIO.uplink.samplesPerFrame })

  assert.equal(h.ctx.transition('recognizing'), true)
  assert.equal(h.session.state, 'recognizing')
  assert.equal(h.ctx.transition('thinking'), true)
  assert.equal(h.session.state, 'thinking')
  assert.equal(h.ctx.transition('speaking'), true)
  assert.equal(h.session.state, 'speaking')
  assert.equal(h.ctx.sendTts({ state: 'start' }), true)
  assert.equal(h.ctx.sendTts({ state: 'sentence_start', text: '你好' }), true)
  assert.equal(h.ctx.sendStt('你好'), true)
  assert.equal(h.ctx.sendLlm({ emotion: 'happy', text: '在呢' }), true)
  assert.equal(h.ctx.transition('listening'), true)
  assert.equal(h.session.state, 'listening')

  // transition 到 listening 自动补一次 tts stop（管线显式发过则 no-op）。
  assert.deepEqual(h.sentJson.filter((json) => json.type === 'tts'), [
    { type: 'tts', state: 'start' },
    { type: 'tts', state: 'sentence_start', text: '你好' },
    { type: 'tts', state: 'stop' },
  ])
  assert.deepEqual(h.sentJson.filter((json) => json.type === 'stt'), [{ type: 'stt', text: '你好' }])
  assert.deepEqual(h.sentJson.filter((json) => json.type === 'llm'), [
    { type: 'llm', emotion: 'happy', text: '在呢' },
  ])
  assert.ok(SESSION_STATES.includes(h.session.state))
})

// ── 2. listen start / stop / detect ─────────────────────────────────────────
test('manual：listen start/stop 结束整段，VAD 不参与', () => {
  const vadPushes = []
  const vad = {
    push(frame) {
      vadPushes.push(frame)
      return []
    },
  }
  const h = createHarness({ session: { vad } })
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'manual' })
  h.session.handleAudio(opusPacket())
  h.session.handleAudio(opusPacket())
  assert.equal(h.callsOf('onAudio').length, 2)
  assert.equal(vadPushes.length, 0, 'manual 模式不得跑 VAD')
  assert.equal(h.session.state, 'listening')

  h.session.handleJson({ type: 'listen', state: 'stop' })
  assert.equal(h.callsOf('onListenStop').length, 1)
  assert.equal(h.session.state, 'recognizing')

  // 重复 stop 不再触发回调、不改变状态。
  h.session.handleJson({ type: 'listen', state: 'stop' })
  assert.equal(h.callsOf('onListenStop').length, 1)
  assert.equal(h.session.state, 'recognizing')
})

test('auto：VAD speech_end 自动进入 recognizing，事件按顺序交付管线', () => {
  let emitted = false
  const vad = {
    push() {
      if (emitted) return []
      emitted = true
      return [
        { type: 'speech_start', atMs: 0 },
        { type: 'speech_end', atMs: 700, reason: 'silence' },
      ]
    },
  }
  const h = createHarness({ session: { vad } })
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  h.session.handleAudio(opusPacket())
  const vadCalls = h.callsOf('onVad')
  assert.equal(vadCalls.length, 2)
  assert.deepEqual(vadCalls.map((call) => call.args[0].type), ['speech_start', 'speech_end'])
  assert.ok(vadCalls[0].args[1].signal instanceof AbortSignal)
  assert.equal(h.session.state, 'recognizing')
})

test('listen detect：进入 listening、把 mode 传给管线、不走向 ASR', () => {
  const vadPushes = []
  const vad = {
    push(frame) {
      vadPushes.push(frame)
      return [{ type: 'speech_end', atMs: 0, reason: 'silence' }]
    },
  }
  const h = createHarness({ session: { vad } })
  h.session.handleJson({ type: 'listen', state: 'detect', mode: 'auto', text: '大肥鱼' })
  assert.equal(h.session.state, 'listening')
  assert.deepEqual(h.callsOf('onListenStart')[0].args[0], {
    mode: 'auto',
    detect: true,
    text: '大肥鱼',
  })

  h.session.handleAudio(opusPacket())
  assert.equal(h.callsOf('onAudio').length, 0, 'detect 阶段音频不得进入 ASR 管线')
  assert.equal(vadPushes.length, 0, 'detect 阶段不跑 VAD')
  assert.equal(h.callsOf('onVad').length, 0)
  assert.equal(h.session.state, 'listening')
})

test('listen start 之前的音频被丢弃', () => {
  const h = createHarness()
  h.session.handleAudio(opusPacket())
  assert.equal(h.callsOf('onAudio').length, 0)
  assert.equal(h.session.state, 'idle')
})

// ── 3. abort ────────────────────────────────────────────────────────────────
test('abort：signal 取消、tts stop 幂等、状态回落 listening', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  assert.equal(h.ctx.transition('recognizing'), true)
  assert.equal(h.ctx.transition('thinking'), true)
  assert.equal(h.ctx.transition('speaking'), true)
  assert.equal(h.ctx.sendTts({ state: 'start' }), true)

  const signal = h.ctx.getSignal()
  assert.ok(signal instanceof AbortSignal)
  assert.equal(h.ctx.sendBinary(Buffer.from([1, 2, 3])), true)
  assert.equal(h.sentBinary.length, 1)

  assert.equal(h.session.abort('user said stop'), true)
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason.name, 'AbortError')
  assert.equal(h.session.state, 'listening')
  assert.equal(h.callsOf('onAbort').length, 1)
  assert.deepEqual(h.callsOf('onAbort')[0].args[0], { reason: 'user said stop' })
  assert.deepEqual(h.sentJson.filter((json) => json.type === 'tts'), [
    { type: 'tts', state: 'start' },
    { type: 'tts', state: 'stop' },
  ])

  // abort 后新的下行音频被丢弃。
  assert.equal(h.ctx.sendBinary(Buffer.from([4])), false)
  assert.equal(h.sentBinary.length, 1)

  // 重复 abort：完整 no-op（不再 onAbort / tts stop，状态不抖动）。
  assert.equal(h.session.abort('again'), false)
  assert.equal(h.callsOf('onAbort').length, 1)
  assert.equal(h.sentJson.filter((json) => json.type === 'tts').length, 2)
  assert.equal(h.session.state, 'listening')
})

test('idle 状态 abort 是完整 no-op', () => {
  const h = createHarness()
  assert.equal(h.session.abort('nothing'), false)
  assert.equal(h.session.state, 'idle')
  assert.equal(h.callsOf('onAbort').length, 0)
  assert.equal(h.sentJson.length, 0)
})

test('abort JSON 消息：trim reason 并取消轮次', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start' })
  const signal = h.ctx.getSignal()
  h.session.handleJson({ type: 'abort', reason: '  barge-in  ' })
  assert.equal(signal.aborted, true)
  assert.deepEqual(h.callsOf('onAbort')[0].args[0], { reason: 'barge-in' })
  assert.equal(h.session.state, 'listening')
})

// ── 4. Opus 解码异常 ────────────────────────────────────────────────────────
test('Opus 解码失败只丢包，不抛出、不关闭连接', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'manual' })
  assert.doesNotThrow(() => h.session.handleAudio(Buffer.alloc(0)))
  assert.equal(h.callsOf('onAudio').length, 0)
  assert.equal(h.callsOf('onClose').length, 0)
  assert.equal(h.closes.length, 0)
  const text = flattenLogs(h.logs)
  assert.match(text, /dev-1/)
  assert.match(text, /Opus 上行解码失败/)

  // 后续合法包仍能正常处理。
  h.session.handleAudio(opusPacket())
  assert.equal(h.callsOf('onAudio').length, 1)
})

test('handleAudio 收到非 Buffer 只记日志', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'manual' })
  assert.doesNotThrow(() => h.session.handleAudio('not-a-buffer'))
  assert.equal(h.callsOf('onAudio').length, 0)
})

// ── 5. 管线异常隔离 ─────────────────────────────────────────────────────────
test('管线异步异常：只关闭本会话（1011），不影响其他会话', async () => {
  const bad = createHarness({ pipeline: { onAudio: () => Promise.reject(new Error('boom-audio')) } })
  const good = createHarness({ session: { deviceId: 'dev-2' } })

  bad.session.handleJson({ type: 'listen', state: 'start', mode: 'manual' })
  bad.session.handleAudio(opusPacket())
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(bad.closes, [{ code: 1011, reason: 'session error' }])
  assert.equal(bad.callsOf('onClose').length, 1)
  assert.equal(bad.session.state, 'idle')
  assert.match(flattenLogs(bad.logs), /dev-1/)
  assert.match(flattenLogs(bad.logs), /onAudio/)

  // 其他会话不受影响。
  assert.equal(good.closes.length, 0)
  assert.equal(good.callsOf('onClose').length, 0)

  // 已关闭后再次 close 不产生副作用。
  bad.session.close()
  assert.equal(bad.callsOf('onClose').length, 1)
  assert.equal(bad.closes.length, 1)
})

test('管线同步抛错不冒泡，关闭本会话', () => {
  const h = createHarness({
    pipeline: {
      onListenStart: () => {
        throw new Error('sync-fail')
      },
    },
  })
  assert.doesNotThrow(() => h.session.handleJson({ type: 'listen', state: 'start' }))
  assert.deepEqual(h.closes, [{ code: 1011, reason: 'session error' }])
  assert.equal(h.callsOf('onClose').length, 1)
  assert.equal(h.session.state, 'idle')
})

test('onOpen 异步抛错只关闭本会话', async () => {
  const h = createHarness({ pipeline: { onOpen: () => Promise.reject(new Error('open-fail')) } })
  h.session.handleJson({ type: 'hello' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.closes, [{ code: 1011, reason: 'session error' }])
  assert.equal(h.callsOf('onClose').length, 1)
})

test('createPipeline 同步抛错：关闭本会话且不再创建 VAD', () => {
  const closes = []
  let vadCreated = 0
  const session = createEsp32Session({
    deviceId: 'dev-x',
    sendJson: () => {},
    close: (code, reason) => closes.push({ code, reason }),
    createPipeline: () => {
      throw new Error('pipeline-create-fail')
    },
    createVad: () => {
      vadCreated += 1
      return { push: () => [] }
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    idleDisconnectMs: 60_000,
  })
  assert.deepEqual(closes, [{ code: 1011, reason: 'session error' }])
  assert.equal(vadCreated, 0, '会话已关闭时不得再创建 VAD')
  assert.equal(session.state, 'idle')
})

// ── 6. 空闲超时 ─────────────────────────────────────────────────────────────
test('空闲超时：注入 close(1000, "idle timeout")，活动会重置计时', () => {
  const h = createHarness({ session: { idleDisconnectMs: 50 } })
  h.clock.advance(49)
  assert.equal(h.closes.length, 0)
  h.clock.advance(1)
  assert.deepEqual(h.closes, [{ code: 1000, reason: 'idle timeout' }])
  assert.equal(h.callsOf('onClose').length, 1)
  assert.equal(h.session.state, 'idle')

  // 超时后定时器不再重复触发。
  h.clock.advance(1000)
  assert.equal(h.closes.length, 1)

  // 任意入站消息都会重置空闲计时。
  const h2 = createHarness({ session: { idleDisconnectMs: 50 } })
  h2.clock.advance(30)
  h2.session.handleJson({ type: 'mcp' })
  h2.clock.advance(30)
  assert.equal(h2.closes.length, 0)
  h2.clock.advance(20)
  assert.deepEqual(h2.closes, [{ code: 1000, reason: 'idle timeout' }])
})

test('idleDisconnectMs：读取 config，options 覆盖优先', () => {
  const fromConfig = createHarness({
    session: {
      idleDisconnectMs: undefined,
      getConfig: () => ({ esp32: { idleDisconnectMs: 10 } }),
    },
  })
  fromConfig.clock.advance(10)
  assert.deepEqual(fromConfig.closes, [{ code: 1000, reason: 'idle timeout' }])

  const overridden = createHarness({
    session: {
      idleDisconnectMs: 100,
      getConfig: () => ({ esp32: { idleDisconnectMs: 10 } }),
    },
  })
  overridden.clock.advance(10)
  assert.equal(overridden.closes.length, 0)
  overridden.clock.advance(90)
  assert.deepEqual(overridden.closes, [{ code: 1000, reason: 'idle timeout' }])
})

// ── 7. close 幂等 ───────────────────────────────────────────────────────────
test('close：幂等、收尾 tts、清理定时器、不重复调用注入 close', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  assert.equal(h.ctx.transition('speaking'), true)
  assert.equal(h.ctx.sendTts({ state: 'start' }), true)
  assert.ok(h.clock.pending() > 0)

  h.session.close()
  assert.equal(h.session.state, 'idle')
  assert.equal(h.callsOf('onClose').length, 1)
  assert.deepEqual(h.sentJson.filter((json) => json.type === 'tts'), [
    { type: 'tts', state: 'start' },
    { type: 'tts', state: 'stop' },
  ])
  assert.equal(h.closes.length, 0, '连接清理路径不应再调用注入的 close')
  assert.equal(h.clock.pending(), 0, '关闭后不得残留定时器')

  // 再次 close / 协议消息 / 音频均无副作用、不抛。
  h.session.close()
  h.session.handleJson({ type: 'listen', state: 'start' })
  assert.doesNotThrow(() => h.session.handleAudio(opusPacket()))
  assert.equal(h.callsOf('onClose').length, 1)
  assert.equal(h.callsOf('onListenStart').length, 1)
  assert.equal(h.session.state, 'idle')
})

// ── 8. 新轮次打断旧轮次 ─────────────────────────────────────────────────────
test('新轮次打断旧轮次：旧 signal 取消、tts stop、音频丢弃', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  const oldSignal = h.ctx.getSignal()
  assert.equal(h.ctx.transition('speaking'), true)
  assert.equal(h.ctx.sendTts({ state: 'start' }), true)
  assert.equal(h.ctx.sendBinary(Buffer.from([1])), true)

  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })

  assert.equal(oldSignal.aborted, true)
  assert.equal(h.callsOf('onAbort').length, 1)
  assert.deepEqual(h.callsOf('onAbort')[0].args[0], { reason: 'listen_start' })
  assert.equal(h.sentJson.filter((json) => json.type === 'tts' && json.state === 'stop').length, 1)
  assert.equal(h.callsOf('onListenStart').length, 2)
  assert.equal(h.sentBinary.length, 1, '旧轮次 abort 后不得再有下行音频')

  const newSignal = h.ctx.getSignal()
  assert.ok(newSignal instanceof AbortSignal)
  assert.notEqual(newSignal, oldSignal)
  assert.equal(newSignal.aborted, false)
  assert.equal(h.session.state, 'listening')
})

test('listen detect 也能打断正在说话的旧轮次', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  const oldSignal = h.ctx.getSignal()
  assert.equal(h.ctx.transition('speaking'), true)
  assert.equal(h.ctx.sendTts({ state: 'start' }), true)

  h.session.handleJson({ type: 'listen', state: 'detect', text: '大肥鱼' })
  assert.equal(oldSignal.aborted, true)
  assert.deepEqual(h.callsOf('onAbort')[0].args[0], { reason: 'listen_detect' })
  assert.equal(h.sentJson.filter((json) => json.type === 'tts' && json.state === 'stop').length, 1)
  assert.equal(h.session.state, 'listening')
})

// ── 9. 协议容错与非法迁移 ───────────────────────────────────────────────────
test('协议容错：hello 不报错、未知类型忽略、非对象消息不抛', () => {
  const h = createHarness()
  assert.doesNotThrow(() => h.session.handleJson({ type: 'hello', version: 1 }))
  assert.equal(h.callsOf('onOpen').length, 1)
  assert.doesNotThrow(() => h.session.handleJson({ type: 'hello', version: 1 }))
  assert.equal(h.callsOf('onOpen').length, 1, '重复 hello 只 onOpen 一次')

  for (const message of [
    { type: 'mcp' },
    { type: 'listen' },
    { type: 'listen', state: 'bogus' },
    null,
    [],
    'x',
    42,
  ]) {
    assert.doesNotThrow(() => h.session.handleJson(message))
  }
  assert.equal(h.session.state, 'idle')
})

test('非法状态迁移：记日志并保持原状态，不抛', () => {
  const h = createHarness()
  assert.equal(h.ctx.transition('speaking'), false) // idle → speaking 非法
  assert.equal(h.session.state, 'idle')

  h.session.handleJson({ type: 'listen', state: 'start' })
  assert.equal(h.ctx.transition('speaking'), true) // 允许前跳（唤醒问候）
  assert.equal(h.ctx.transition('recognizing'), false) // 不能倒退
  assert.equal(h.session.state, 'speaking')
  assert.match(flattenLogs(h.logs), /非法状态迁移/)

  assert.equal(h.ctx.transition('bogus'), false)
  assert.equal(h.session.state, 'speaking')
})

// ── 10. 下发 helper 形状 ────────────────────────────────────────────────────
test('下发 helper 形状 与 tts stop 门槛', () => {
  const h = createHarness()
  h.session.handleJson({ type: 'listen', state: 'start' })

  assert.equal(h.ctx.sendTts({ state: 'stop' }), false, '未 start 的 stop 不得下发')
  assert.equal(h.ctx.sendTts({ state: 'sentence_start', text: '先句' }), true)
  assert.equal(h.ctx.sendTts({ state: 'start' }), true)
  assert.equal(h.ctx.sendTts({ state: 'stop' }), true)
  assert.equal(h.ctx.sendTts({ state: 'stop' }), false, '同一轮 stop 只发一次')
  assert.equal(h.ctx.sendTts({ state: 'bad' }), false)
  assert.equal(h.ctx.sendStt('你好'), true)
  assert.equal(h.ctx.sendLlm({ emotion: 'happy', text: '嗯' }), true)

  assert.deepEqual(h.sentJson.slice(-2), [
    { type: 'stt', text: '你好' },
    { type: 'llm', emotion: 'happy', text: '嗯' },
  ])
  assert.deepEqual(h.sentJson.filter((json) => json.type === 'tts'), [
    { type: 'tts', state: 'sentence_start', text: '先句' },
    { type: 'tts', state: 'start' },
    { type: 'tts', state: 'stop' },
  ])
})

// ── 11. 无管线安全运行 ──────────────────────────────────────────────────────
test('无管线也能安全运行（T14 模拟设备）', () => {
  const sent = []
  const closes = []
  const session = createEsp32Session({
    deviceId: 'sim-device',
    sendJson: (obj) => sent.push(obj),
    sendBinary: () => {},
    close: (code, reason) => closes.push({ code, reason }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    idleDisconnectMs: 60_000,
  })

  assert.equal(session.state, 'idle')
  assert.doesNotThrow(() => session.handleJson({ type: 'hello' }))
  session.handleJson({ type: 'listen', state: 'start', mode: 'auto' })
  assert.equal(session.state, 'listening')
  assert.doesNotThrow(() => session.handleAudio(opusPacket()))
  assert.doesNotThrow(() => session.handleAudio(Buffer.alloc(0)))
  session.abort('test')
  assert.equal(session.state, 'listening')
  session.handleJson({ type: 'listen', state: 'stop' })
  session.close()
  assert.equal(session.state, 'idle')
  assert.equal(closes.length, 0)
})
