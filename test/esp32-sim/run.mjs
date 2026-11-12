// T14：ESP32 模拟设备 · 无硬件 E2E 运行器
//
// 用法：node test/esp32-sim/run.mjs
//
// 进程内启动真实网关（createGateway，127.0.0.1 + 随机端口），用真实会话状态机
// （createEsp32Session）配每场景独立的 fake pipeline（不接 ASR/LLM/TTS），
// 再用 test/esp32-sim/sim-device.mjs 的模拟固件走完整 WS 协议：
//   1. hello          握手字段与首条消息
//   2. token 拒绝     无 token / 错误 token 均 401，连接不建立
//   3. listen → stt   listen start + 16k Opus 帧 + stop 后收到 stt，状态轨迹合法
//   4. 完整下行时序   tts start → sentence_start → 3×24k 帧 → llm → tts stop
//   5. 打断           tts 播放中 abort：轮次 signal 中止、tts stop、abort 后无音频，且可再监听
//
// 任一场景失败 → 退出码 1；全部通过 → 退出码 0。
// 仅本机回环通信，无外部网络、无真实 TTS/ASR/LLM；token 为进程内固定测试值。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 在动态 import 业务模块之前隔离配置目录（静态 import 会被提升，不能用于业务模块）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-sim-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const { createGateway } = await import('../../lib/esp32/gateway.js')
const { createEsp32Session } = await import('../../lib/esp32/session.js')
const { encodeDownlinkFrame, closeSharedOpus } = await import('../../lib/esp32/audio/opus.js')
const { AUDIO } = await import('../../lib/esp32/contracts.js')
const { createMockVolc } = await import('./mock-volc.mjs')
const { createVolcScenarios } = await import('./volc-scenarios.mjs')
const {
  createSimDevice,
  expectUpgradeRejected,
  sinePcm,
  wsUrlFor,
} = await import('./sim-device.mjs')

// ── 固定测试常量 ─────────────────────────────────────────────────────────────

// 进程内固定测试 token（非真实凭据，不写入仓库/日志）。
const TOKEN = 'sim-e2e-token-0123456789abcdef'
const DEVICE_ID = 'SIM:AA:BB:CC:DD:EE:01'
const CLIENT_ID = 'sim-e2e-client'
const STT_TEXT = '你好，我是大肥鱼'
const SENTENCE_TEXT = '从前有座山，山里有座庙。'
const LLM_TEXT = '我来给你讲个故事'
const DOWNLINK_FRAMES = 3
const STATE_RANK = Object.freeze({ idle: 0, listening: 1, recognizing: 2, thinking: 3, speaking: 4 })
const PIPELINE_HOOKS = [
  'onOpen',
  'onListenStart',
  'onListenStop',
  'onAudio',
  'onVad',
  'onAbort',
  'onClose',
]

// ── 通用小工具 ───────────────────────────────────────────────────────────────

function indent(text, prefix) {
  return String(text ?? '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function formatValue(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 收集会话日志（失败时打印尾部，成功时不刷屏）。
 * 同时从会话日志中提取真实状态迁移轨迹（transition() 每次成功迁移都会 debug 记录
 * { from, to, reason }），用于断言状态机行为而不侵入 lib/esp32/session.js。
 */
function createLogSink() {
  const lines = []
  const transitions = []
  const illegalTransitions = []
  const push = (level) => (...args) => {
    lines.push(`[${level}] ${args.map(formatValue).join(' ')}`)
    if (lines.length > 200) lines.shift()
    const meta = args.find(
      (arg) => arg !== null
        && typeof arg === 'object'
        && typeof arg.from === 'string'
        && typeof arg.to === 'string',
    )
    if (!meta) return
    const entry = { from: meta.from, to: meta.to, reason: meta.reason ?? '' }
    if (level === 'debug') transitions.push(entry)
    else if (level === 'warn') illegalTransitions.push(entry)
  }
  return {
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
    transitions,
    illegalTransitions,
    tail(count = 20) {
      return lines.length > 0 ? lines.slice(-count).join('\n') : '(无日志)'
    },
  }
}

/** 各阶段耗时（相对上一标记）。 */
function createTrace() {
  const startedAt = performance.now()
  let last = startedAt
  const stages = []
  return {
    mark(name) {
      const now = performance.now()
      stages.push({ name, ms: now - last })
      last = now
    },
    total() {
      return performance.now() - startedAt
    },
    summary() {
      if (stages.length === 0) return '无阶段'
      return stages.map((stage) => `${stage.name} ${stage.ms.toFixed(0)}ms`).join(' | ')
    },
  }
}

/**
 * 管线 harness：包装全部回调以便记录调用，并暴露 createPipeline 注入会话。
 * hooks 里的回调签名为 (ctx, ...args)。
 */
function createPipelineHarness(hooks = {}) {
  const calls = []
  const errors = []
  let ctx = null
  const pipeline = {}
  for (const name of PIPELINE_HOOKS) {
    pipeline[name] = (...args) => {
      calls.push({ name, args })
      const hook = hooks[name]
      if (typeof hook !== 'function') return undefined
      try {
        return hook(ctx, ...args)
      } catch (error) {
        errors.push({ name, error })
        throw error
      }
    }
  }
  return {
    pipeline,
    calls,
    errors,
    createPipeline: (value) => {
      ctx = value
      return pipeline
    },
    callsOf(name) {
      return calls.filter((call) => call.name === name)
    },
  }
}

function isLegalStateTransition(from, to) {
  if (from === to) return true
  if (from === 'idle') return to === 'listening'
  if (to === 'listening') return true
  return STATE_RANK[to] > STATE_RANK[from]
}

/**
 * 从会话日志还原状态轨迹，逐跳断言轨迹连续且迁移合法。
 * 会话从 idle 开始；任何 warn 级别的非法迁移尝试都会让断言失败。
 */
function stateTraceOf(logSink) {
  const states = ['idle']
  for (const transition of logSink.transitions) {
    const previous = states[states.length - 1]
    assert.equal(
      transition.from,
      previous,
      `状态轨迹不连续：日志 from=${transition.from}，上一条状态为 ${previous}`,
    )
    assert.ok(
      isLegalStateTransition(transition.from, transition.to),
      `非法状态迁移 ${transition.from} → ${transition.to}（reason=${transition.reason}）`,
    )
    states.push(transition.to)
  }
  assert.equal(
    logSink.illegalTransitions.length,
    0,
    `会话出现非法迁移尝试：${JSON.stringify(logSink.illegalTransitions)}`,
  )
  return states
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

// ── 网关 / 会话装配 ──────────────────────────────────────────────────────────

function makeSessionFactory(scope) {
  return (args) => createEsp32Session({
    ...args,
    createPipeline: scope.createPipelineOverride ?? scope.harness.createPipeline,
    logger: scope.logSink.logger,
    idleDisconnectMs: 60_000,
  })
}

function makeGateway(scope) {
  return createGateway({
    host: '127.0.0.1',
    port: 0,
    esp32: {
      port: 0,
      token: TOKEN,
      publicHost: '127.0.0.1',
      allowDevices: [],
    },
    saveConfig: async (patch) => patch,
    logger: scope.logSink.logger,
    // publicHost 显式指定后不会探测网卡；为稳妥仍注入空覆盖，避免读本机网络。
    interfaces: {},
    routes: [],
    addressIndexes: {},
    createSession: makeSessionFactory(scope),
  })
}

/**
 * 起网关 → 执行用例 → 清理（关闭模拟设备、停网关）。
 * connect(overrides) 返回完成 hello 握手的模拟设备。
 */
async function withGateway(scope, fn) {
  const gw = makeGateway(scope)
  scope.gw = gw
  try {
    await gw.start()
    scope.trace.mark('gateway.start')
    const connect = async (overrides = {}) => {
      const address = gw.address()
      const device = await createSimDevice({
        url: wsUrlFor(address),
        token: TOKEN,
        deviceId: DEVICE_ID,
        clientId: CLIENT_ID,
        helloTimeoutMs: 3000,
        ...overrides,
      })
      scope.devices.push(device)
      return device
    }
    return await fn({ ...scope, gw, connect })
  } finally {
    for (const device of scope.devices) {
      try {
        await device.close({ timeoutMs: 500 })
      } catch { /* 清理失败不影响断言结果 */ }
    }
    try {
      await gw.stop()
    } catch { /* 同上 */ }
  }
}

// ── 场景 1：hello 握手 ───────────────────────────────────────────────────────

const helloScenario = {
  name: 'hello 握手',
  hooks: {},
  async run(scope) {
    await withGateway(scope, async ({ connect, trace }) => {
      const device = await connect()
      trace.mark('ws.connect+hello')

      const hello = device.serverHello
      assert.ok(hello, `未收到服务端 hello。下行消息：\n${device.transcript()}`)
      assert.equal(hello.type, 'hello')
      assert.equal(hello.transport, 'websocket')
      assert.equal(typeof hello.session_id, 'string')
      assert.ok(hello.session_id.length > 0, 'session_id 不能为空')
      assert.deepEqual(hello.audio_params, {
        format: 'opus',
        sample_rate: 24000,
        channels: 1,
        frame_duration: 60,
      })
      assert.equal(hello.audio_params.sample_rate, AUDIO.downlink.sampleRate)
      assert.equal(hello.audio_params.frame_duration, AUDIO.downlink.frameMs)
      assert.equal(device.sessionId, hello.session_id)

      const firstDownlink = device.messages[0]
      assert.ok(
        firstDownlink?.kind === 'json' && firstDownlink.json.type === 'hello',
        '服务端第一条下行消息必须是 hello',
      )
      assert.equal(device.sent[0]?.json?.type, 'hello', '设备第一条上行消息必须是 hello')
      trace.mark('assertions')
    })
  },
}

// ── 场景 2：token 拒绝 ───────────────────────────────────────────────────────

const tokenScenario = {
  name: 'token 拒绝（401）',
  hooks: {},
  async run(scope) {
    await withGateway(scope, async ({ gw, trace }) => {
      const url = wsUrlFor(gw.address())

      const withoutToken = await expectUpgradeRejected({ url, token: null })
      assert.equal(withoutToken.statusCode, 401, `无 token 应返回 401（实际 ${withoutToken.statusCode}）`)
      assert.equal(withoutToken.opened, false, '无 token 时连接不能建立')
      trace.mark('reject:no-token')

      const wrongToken = await expectUpgradeRejected({ url, token: 'sim-wrong-token-000000' })
      assert.equal(wrongToken.statusCode, 401, `错误 token 应返回 401（实际 ${wrongToken.statusCode}）`)
      assert.equal(wrongToken.opened, false, '错误 token 时连接不能建立')
      assert.equal(
        String(wrongToken.headers?.['www-authenticate'] ?? '').toLowerCase(),
        'bearer',
        '401 应带 WWW-Authenticate: Bearer',
      )
      trace.mark('reject:wrong-token')
    })
  },
}

// ── 场景 3：listen → stt ─────────────────────────────────────────────────────

function createListenSttScenario() {
  const state = { audio: [] }
  const hooks = {
    onAudio(ctx, frame, meta) {
      state.audio.push({
        samples: frame.length,
        sampleRate: meta.sampleRate,
        state: ctx.getState(),
      })
    },
    onListenStop(ctx) {
      ctx.sendStt(STT_TEXT)
    },
  }
  return {
    name: 'listen → stt',
    hooks,
    async run(scope) {
      await withGateway(scope, async ({ connect, trace, harness, logSink }) => {
        const device = await connect()
        trace.mark('ws.connect+hello')

        // 监听开始前的上行音频必须被会话丢弃。
        await device.sendPcm(sinePcm(AUDIO.uplink.samplesPerFrame * 2, { frequency: 300 }))
        await device.sendListen({ state: 'start', mode: 'manual' })
        await device.sendPcm(sinePcm(AUDIO.uplink.samplesPerFrame * 5, { frequency: 660 }))
        await device.sendListen({ state: 'stop' })
        trace.mark('listen.start+5帧+stop')

        const stt = await device.waitForJson('stt', 3000)
        trace.mark('stt')

        assert.equal(stt.text, STT_TEXT)
        assert.equal(harness.callsOf('onAudio').length, 5, 'listen start 之前的帧不得交付管线')
        assert.equal(state.audio.length, 5)
        for (const frame of state.audio) {
          assert.equal(frame.samples, AUDIO.uplink.samplesPerFrame, '每帧 960 点（16k/60ms）')
          assert.equal(frame.sampleRate, AUDIO.uplink.sampleRate)
          assert.equal(frame.state, 'listening')
        }
        assert.equal(
          device.jsonMessages().filter((json) => json.type === 'tts').length,
          0,
          '本场景不应出现 tts 消息',
        )
        assert.deepEqual(stateTraceOf(logSink), ['idle', 'listening', 'recognizing'])
        trace.mark('assertions')
      })
    },
  }
}

// ── 场景 4：完整下行时序 ─────────────────────────────────────────────────────

function createDownlinkScenario() {
  const downlinkPcm = Array.from({ length: DOWNLINK_FRAMES }, (_, index) => sinePcm(
    AUDIO.downlink.samplesPerFrame,
    {
      sampleRate: AUDIO.downlink.sampleRate,
      frequency: 440 + index * 110,
      phase: index * 97,
    },
  ))
  const state = { uplinkFrames: 0 }
  const hooks = {
    onAudio() {
      state.uplinkFrames += 1
    },
    onListenStop(ctx) {
      ctx.transition('thinking', { reason: 'sim-downlink' })
      ctx.transition('speaking', { reason: 'sim-downlink' })
      ctx.sendTts({ state: 'start' })
      ctx.sendTts({ state: 'sentence_start', text: SENTENCE_TEXT })
      for (const pcm of downlinkPcm) ctx.sendBinary(encodeDownlinkFrame(pcm))
      ctx.sendLlm({ emotion: 'happy', text: LLM_TEXT })
      ctx.sendTts({ state: 'stop' })
    },
  }
  return {
    name: '完整下行时序',
    hooks,
    async run(scope) {
      await withGateway(scope, async ({ connect, trace, logSink }) => {
        const device = await connect()
        trace.mark('ws.connect+hello')

        await device.sendListen({ state: 'start', mode: 'manual' })
        await device.sendPcm(sinePcm(AUDIO.uplink.samplesPerFrame * 3))
        trace.mark('uplink')

        const mark = device.mark()
        await device.sendListen({ state: 'stop' })
        await device.waitForJson(
          (json) => json.type === 'tts' && json.state === 'stop',
          3000,
        )
        trace.mark('downlink burst')

        const downlink = device.messagesSince(mark)
        const sequence = downlink.map((message) => {
          if (message.kind === 'binary') return 'binary'
          if (message.kind === 'json' && message.json?.type === 'tts') {
            return `tts:${message.json.state}`
          }
          return message.kind === 'json' ? message.json?.type : message.kind
        })
        assert.deepEqual(sequence, [
          'tts:start',
          'tts:sentence_start',
          'binary',
          'binary',
          'binary',
          'llm',
          'tts:stop',
        ], `下行消息顺序不符：${sequence.join(' → ')}`)

        const binaries = downlink.filter((message) => message.kind === 'binary')
        assert.equal(binaries.length, DOWNLINK_FRAMES)
        for (const [index, frame] of binaries.entries()) {
          assert.equal(frame.error, null, `第 ${index + 1} 帧解码失败：${frame.error?.message ?? frame.error}`)
          assert.equal(frame.samples, AUDIO.downlink.samplesPerFrame, `第 ${index + 1} 帧应解码为 1440 点`)
          assert.equal(frame.samples, 1440)
          assert.ok(frame.pcm instanceof Int16Array, '下行帧应解码为 Int16Array')
        }

        const llm = downlink.find((message) => message.kind === 'json' && message.json?.type === 'llm')
        assert.ok(llm, '缺少 llm 消息')
        assert.equal(llm.json.emotion, 'happy')
        assert.equal(llm.json.text, LLM_TEXT)

        const ttsMessages = device.jsonMessages().filter((json) => json.type === 'tts')
        assert.equal(ttsMessages.filter((json) => json.state === 'start').length, 1, 'tts start 只出现一次')
        assert.equal(ttsMessages.filter((json) => json.state === 'stop').length, 1, 'tts stop 只出现一次')
        const startIndex = downlink.findIndex(
          (message) => message.kind === 'json' && message.json?.type === 'tts' && message.json.state === 'start',
        )
        const stopIndex = downlink.findIndex(
          (message) => message.kind === 'json' && message.json?.type === 'tts' && message.json.state === 'stop',
        )
        assert.ok(startIndex >= 0, 'tts start 应在 listen stop 之后收到')
        assert.ok(stopIndex > startIndex, 'tts stop 应在 tts start 之后收到')

        assert.equal(state.uplinkFrames, 3, '管线应收到 3 帧上行音频')
        assert.deepEqual(
          stateTraceOf(logSink),
          ['idle', 'listening', 'thinking', 'speaking'],
        )
        trace.mark('assertions')
      })
    },
  }
}

// ── 场景 5：打断 ────────────────────────────────────────────────────────────

function createAbortScenario() {
  const firstPcm = sinePcm(AUDIO.downlink.samplesPerFrame, {
    sampleRate: AUDIO.downlink.sampleRate,
    frequency: 523,
  })
  const latePcm = sinePcm(AUDIO.downlink.samplesPerFrame, {
    sampleRate: AUDIO.downlink.sampleRate,
    frequency: 659,
  })
  const state = {
    signals: [],
    abortEvents: [],
    abortCalls: [],
    sendsAfterAbort: [],
    lateTimerSends: [],
    listenStarts: 0,
    listenStops: 0,
  }
  const hooks = {
    onListenStart(ctx) {
      state.listenStarts += 1
      const signal = ctx.getSignal()
      if (!signal) return
      state.signals.push(signal)
      signal.addEventListener('abort', () => {
        state.abortEvents.push({
          reason: signal.reason?.reason ?? signal.reason?.message ?? 'abort',
        })
      }, { once: true })
    },
    onListenStop(ctx) {
      state.listenStops += 1
      if (state.listenStops > 1) {
        ctx.sendStt(STT_TEXT)
        return
      }
      ctx.transition('thinking', { reason: 'sim-abort' })
      ctx.transition('speaking', { reason: 'sim-abort' })
      ctx.sendTts({ state: 'start' })
      ctx.sendTts({ state: 'sentence_start', text: '很久很久以前，山里住着一只大肥鱼。' })
      ctx.sendBinary(encodeDownlinkFrame(firstPcm))
      ctx.sendBinary(encodeDownlinkFrame(latePcm))
    },
    onAbort(ctx, { reason }) {
      state.abortCalls.push({ reason })
      // 打断后管线仍尝试下发：必须被会话拒绝。
      state.sendsAfterAbort.push({
        tts: ctx.sendTts({ state: 'sentence_start', text: '迟到的句子' }),
        binary: ctx.sendBinary(encodeDownlinkFrame(firstPcm)),
      })
      // 模拟迟到的生产者（定时器在 abort 之后才触发）。
      ctx.setTimer(() => {
        state.lateTimerSends.push(ctx.sendBinary(encodeDownlinkFrame(latePcm)))
      }, 30)
    },
  }
  return {
    name: '打断（abort）',
    hooks,
    async run(scope) {
      await withGateway(scope, async ({ connect, trace, logSink }) => {
        const device = await connect()
        trace.mark('ws.connect+hello')

        await device.sendListen({ state: 'start', mode: 'manual' })
        await device.sendPcm(sinePcm(AUDIO.uplink.samplesPerFrame * 2))
        await device.sendListen({ state: 'stop' })
        await device.waitFor(() => device.binaryMessages().length >= 2, 3000)
        trace.mark('tts playing')

        await device.sendAbort('user')
        await device.waitForJson(
          (json) => json.type === 'tts' && json.state === 'stop',
          3000,
        )
        trace.mark('abort roundtrip')

        await waitUntil(
          () => state.lateTimerSends.length >= 1,
          2000,
          'abort 之后迟到定时器的下发尝试',
        )
        trace.mark('late send attempt')

        assert.equal(state.signals.length, 1, '第一轮应有且只有一个 AbortSignal')
        assert.equal(state.signals[0].aborted, true, '轮次 AbortSignal 必须被 abort')
        assert.deepEqual(state.abortEvents, [{ reason: 'user' }])
        assert.deepEqual(state.abortCalls, [{ reason: 'user' }])
        assert.deepEqual(
          state.sendsAfterAbort,
          [{ tts: false, binary: false }],
          'abort 之后管线的下发必须被会话拒绝',
        )
        assert.deepEqual(
          state.lateTimerSends,
          [false],
          'abort 之后迟到定时器的音频下发必须被拒绝',
        )

        const stopIndex = device.messages.findIndex(
          (message) => message.kind === 'json' && message.json?.type === 'tts' && message.json.state === 'stop',
        )
        assert.ok(stopIndex >= 0, '缺少 tts stop')
        const binaryAfterStop = device.messages.slice(stopIndex + 1).filter(
          (message) => message.kind === 'binary',
        )
        assert.equal(
          binaryAfterStop.length,
          0,
          `tts stop 之后不得再有音频帧：\n${device.transcript(stopIndex)}`,
        )
        assert.equal(
          device.jsonMessages().filter((json) => json.type === 'tts' && json.state === 'stop').length,
          1,
          'tts stop 只能出现一次',
        )
        assert.deepEqual(
          stateTraceOf(logSink),
          ['idle', 'listening', 'thinking', 'speaking', 'listening'],
        )

        // 打断后会话仍可开始新一轮监听。
        await device.sendListen({ state: 'start', mode: 'manual' })
        await device.sendPcm(sinePcm(AUDIO.uplink.samplesPerFrame * 2, { frequency: 520 }))
        await device.sendListen({ state: 'stop' })
        const stt = await device.waitForJson('stt', 3000)
        trace.mark('resume listen')

        assert.equal(stt.text, STT_TEXT)
        assert.equal(state.listenStarts, 2, '打断后新轮次应再次触发 onListenStart')
        assert.equal(state.listenStops, 2, '打断后新轮次应再次触发 onListenStop')
        assert.equal(state.abortEvents.length, 1, '新轮次不得再触发 abort')
        assert.deepEqual(stateTraceOf(logSink), [
          'idle',
          'listening',
          'thinking',
          'speaking',
          'listening',
          'recognizing',
        ])
        trace.mark('assertions')
      })
    },
  }
}

// ── 运行器 ──────────────────────────────────────────────────────────────────

// 火山 mock 服务全程共用一个实例（场景内 mock.reset() 隔离状态）。
const mockVolc = await createMockVolc()
const scenarios = [
  helloScenario,
  tokenScenario,
  createListenSttScenario(),
  createDownlinkScenario(),
  createAbortScenario(),
  ...createVolcScenarios({ withGateway, mock: mockVolc, sinePcm, AUDIO }),
]

async function runScenario(entry) {
  const trace = createTrace()
  const logSink = createLogSink()
  const scope = {
    trace,
    logSink,
    devices: [],
    harness: createPipelineHarness(entry.hooks),
    gw: null,
  }
  try {
    await entry.run(scope)
    console.log(`PASS ${entry.name} (${trace.total().toFixed(0)}ms) [${trace.summary()}]`)
    return true
  } catch (error) {
    console.error(`FAIL ${entry.name}: ${error?.message ?? error}`)
    if (error?.stack) {
      console.error(indent(error.stack.split('\n').slice(1, 6).join('\n'), '  '))
    }
    if (scope.harness.errors.length > 0) {
      console.error('  管线回调异常：')
      for (const item of scope.harness.errors) {
        console.error(indent(`${item.name}: ${item.error?.stack ?? item.error}`, '    '))
      }
    }
    for (const device of scope.devices) {
      console.error(`  模拟设备 ${device.deviceId} 下行消息：`)
      console.error(indent(device.transcript(), '    '))
    }
    console.error(`  阶段耗时：[${trace.summary()}]`)
    console.error('  日志尾部：')
    console.error(indent(logSink.tail(20), '    '))
    return false
  }
}

async function main() {
  console.log(`ESP32 模拟设备 E2E（无硬件，Node ${process.version}）`)
  let failures = 0
  for (const entry of scenarios) {
    const ok = await runScenario(entry)
    if (!ok) failures += 1
  }
  console.log(`\n结果：${scenarios.length - failures}/${scenarios.length} 场景通过`)
  return failures
}

let failures = 1
try {
  failures = await main()
} catch (error) {
  console.error('E2E 运行器异常：', error?.stack ?? error)
} finally {
  try {
    await mockVolc.close()
  } catch { /* mock 关闭失败不影响退出码 */ }
  try {
    closeSharedOpus()
  } catch { /* WASM 释放失败不影响退出码 */ }
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch { /* 临时目录清理失败不影响退出码 */ }
}
process.exitCode = failures === 0 ? 0 : 1
