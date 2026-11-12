// ESP32 第五通道 · T23「宿主接线」测试
//
// 覆盖：
// 1. enabled=false 不启动；enabled=true 启动并拿到地址；
// 2. 启动抛错 → status.ok=true、running=false、lastError 脱敏且不含 token；
// 3. 设备注册 / 实时 state / close 注销；stop 幂等；
// 4. status 字段形状（otaUrl、token、asrAvailable 真假两例）；
// 5. log 无 channelLog 返回空、有 channelLog 时透传 device/limit。
//
// 全部使用 fake gateway / fake session / fake 配置；不联网、不写真实 ~/.dsh 配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：必须在 import 业务模块之前设置（paths.mjs 在导入时读取） ─────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-host-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const { createEsp32Host, sanitizeError } = await import('../lib/esp32/host.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 测试工具 ────────────────────────────────────────────────────────────────
const TOKEN = 'test-token-0123456789abcdef'

function makeConfig(esp32 = {}) {
  return () => ({ esp32: { enabled: true, port: 8765, publicHost: '', token: TOKEN, ...esp32 } })
}

/** fake 网关：记录 start/stop 次数，暴露 createSession 供测试模拟设备接入。 */
function makeFakeGateway({ failStart = null, port = 8765, publicHost = '192.168.1.20' } = {}) {
  const state = { starts: 0, stops: 0, createSession: null, options: null }
  const gateway = {
    async start() {
      state.starts += 1
      if (failStart) throw failStart
      return { address: '0.0.0.0', family: 'IPv4', port }
    },
    async stop() { state.stops += 1 },
    address() { return state.starts > 0 && !failStart ? { address: '0.0.0.0', family: 'IPv4', port } : null },
    publicHost() { return publicHost },
    publicHostInfo() { return { address: publicHost, method: 'test' } },
  }
  const factory = (options) => {
    state.options = options
    state.createSession = options.createSession
    return gateway
  }
  return { factory, state }
}

/** fake 会话：state 可外部改写，close 记录调用次数；模拟 session.js 调用 createPipeline。 */
function makeFakeSessionFactory() {
  const created = []
  const factory = (args) => {
    const session = {
      state: 'idle',
      closes: 0,
      args,
      pipeline: null,
      handleJson() {},
      handleAudio() {},
      abort() { return false },
      close() { session.closes += 1 },
    }
    if (typeof args.createPipeline === 'function') {
      session.pipeline = args.createPipeline({ deviceId: args.deviceId, sessionId: args.sessionId })
    }
    created.push(session)
    return session
  }
  return { factory, created }
}

function makeLogger() {
  const rows = []
  const push = (level) => (...args) => rows.push([level, ...args])
  return { rows, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } }
}

// ── 1. enabled=false 不启动 ─────────────────────────────────────────────────
test('enabled=false：不创建网关、不启动', async () => {
  const { factory, state } = makeFakeGateway()
  const host = createEsp32Host({
    getConfig: makeConfig({ enabled: false }),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
  })
  const result = await host.start()
  assert.deepEqual(result, { started: false, enabled: false })
  assert.equal(state.starts, 0)
  const status = host.status()
  assert.equal(status.ok, true)
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  assert.deepEqual(status.devices, [])
  await host.stop()
})

// ── 2. enabled=true 启动并拿到地址 ──────────────────────────────────────────
test('enabled=true：启动网关并暴露地址 / OTA URL', async () => {
  const { factory, state } = makeFakeGateway({ port: 9123, publicHost: '192.168.1.20' })
  const host = createEsp32Host({
    getConfig: makeConfig({ port: 9123 }),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
  })
  const result = await host.start()
  assert.equal(result.started, true)
  assert.equal(result.enabled, true)
  assert.equal(state.starts, 1)
  assert.equal(typeof state.createSession, 'function')

  const status = host.status()
  assert.equal(status.running, true)
  assert.equal(status.publicHost, '192.168.1.20')
  assert.equal(status.otaUrl, 'http://192.168.1.20:9123/xiaozhi/ota/')
  assert.deepEqual(status.address, { address: '0.0.0.0', family: 'IPv4', port: 9123 })
  assert.equal(status.lastError, null)
  await host.stop()
})

// ── 3. 启动抛错：不抛出、lastError 脱敏且不含 token ─────────────────────────
test('启动抛错：status.ok=true、running=false、lastError 脱敏且不含 token', async () => {
  const leaky = new Error(`listen failed: token=${TOKEN} Authorization: Bearer ${TOKEN}`)
  const { factory } = makeFakeGateway({ failStart: leaky })
  const { logger, rows } = makeLogger()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    logger,
  })
  const result = await host.start()
  assert.equal(result.started, false)
  assert.equal(result.enabled, true)
  assert.ok(result.lastError)

  const status = host.status()
  assert.equal(status.ok, true)
  assert.equal(status.running, false)
  assert.ok(status.lastError)
  assert.ok(!status.lastError.includes(TOKEN), 'lastError 不得包含 token')
  assert.ok(!JSON.stringify(rows).includes(TOKEN), '日志不得包含 token')
  await host.stop()
})

test('sanitizeError：抹掉 token / Bearer / api_key 形式的值', () => {
  const text = sanitizeError(new Error(`boom token=${TOKEN} api_key: sk-123 Bearer ${TOKEN}`), TOKEN)
  assert.ok(!text.includes(TOKEN))
  assert.ok(!text.includes('sk-123'))
  assert.ok(text.includes('[redacted]'))
})

// ── 4. 设备注册 / 实时 state / close 注销 ───────────────────────────────────
test('设备注册、实时 state、close 注销', async () => {
  const { factory, state } = makeFakeGateway()
  const sessions = makeFakeSessionFactory()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: sessions.factory,
  })
  await host.start()

  const sent = []
  const session = state.createSession({
    deviceId: 'aa:bb:cc:dd:ee:ff',
    clientId: 'client-1',
    sessionId: 'sess-1',
    remoteAddress: '192.168.1.50',
    sendJson: (obj) => { sent.push(obj); return true },
    sendBinary: () => true,
    close: () => {},
    hello: { type: 'hello' },
  })
  assert.equal(sessions.created.length, 1)

  let status = host.status()
  assert.equal(status.devices.length, 1)
  assert.equal(status.devices[0].deviceId, 'aa:bb:cc:dd:ee:ff')
  assert.equal(status.devices[0].sessionId, 'sess-1')
  assert.equal(status.devices[0].state, 'idle')
  assert.equal(typeof status.devices[0].connectedAt, 'number')
  assert.equal(typeof status.devices[0].lastSeenAt, 'number')

  // 实时 state：会话内部状态变化立刻反映到 status
  sessions.created[0].state = 'listening'
  status = host.status()
  assert.equal(status.devices[0].state, 'listening')

  // 网关回调（sendJson）刷新 lastSeenAt
  const before = status.devices[0].lastSeenAt
  await new Promise((r) => setTimeout(r, 5))
  sessions.created[0].args.sendJson({ type: 'hello' })
  status = host.status()
  assert.ok(status.devices[0].lastSeenAt >= before)
  assert.equal(sent.length, 1)

  // close 注销设备，且保持幂等（重复 close 不抛）
  session.close()
  session.close()
  assert.equal(sessions.created[0].closes, 2)
  assert.equal(host.status().devices.length, 0)

  await host.stop()
})

// ── 5. stop 幂等 ────────────────────────────────────────────────────────────
test('stop 幂等：重复调用只停一次网关', async () => {
  const { factory, state } = makeFakeGateway()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
  })
  await host.start()
  await host.stop()
  await host.stop()
  assert.equal(state.stops, 1)
  assert.equal(host.status().running, false)
})

test('stop 会关闭已注册设备', async () => {
  const { factory, state } = makeFakeGateway()
  const sessions = makeFakeSessionFactory()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: sessions.factory,
  })
  await host.start()
  state.createSession({ deviceId: 'dev-1', sessionId: 'sess-1', sendJson: () => true, sendBinary: () => true, close: () => {} })
  assert.equal(host.status().devices.length, 1)
  await host.stop()
  assert.equal(sessions.created[0].closes, 1)
  assert.equal(host.status().devices.length, 0)
})

// ── 6. status 字段形状 + asrAvailable 真假两例 ──────────────────────────────
test('status 字段形状：otaUrl / tokenSet / asrAvailable', async () => {
  const { factory } = makeFakeGateway({ port: 8765, publicHost: '' })
  const host = createEsp32Host({
    getConfig: makeConfig({ port: 8765 }),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    getSpeechToText: () => null,
  })
  await host.start()
  const status = host.status()
  for (const key of ['ok', 'enabled', 'running', 'address', 'publicHost', 'otaUrl', 'tokenSet', 'llmKeySet', 'asrAvailable', 'devices', 'lastError']) {
    assert.ok(key in status, `status 缺少字段 ${key}`)
  }
  assert.equal(status.tokenSet, true)
  // 安全：状态接口不得回传明文 token
  assert.equal('token' in status, false, 'status 不得包含明文 token 字段')
  assert.equal(JSON.stringify(status).includes(TOKEN), false, 'status 序列化后不得出现 token 明文')
  assert.equal(status.asrAvailable, false)
  // publicHost 为空时 OTA 回落到 127.0.0.1
  assert.equal(status.otaUrl, 'http://127.0.0.1:8765/xiaozhi/ota/')
  await host.stop()
})

test('status 只读：查询状态不刷新 lastSeenAt', async () => {
  let clock = 1000
  const { factory, state } = makeFakeGateway()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    now: () => clock,
  })
  await host.start()
  state.createSession({
    deviceId: 'dev-1', sessionId: 'sess-1',
    sendJson: () => true, sendBinary: () => true, close: () => {},
  })
  const first = host.status().devices[0].lastSeenAt
  clock = 60_000
  assert.equal(host.status().devices[0].lastSeenAt, first, '轮询状态不得伪装成设备活跃')
  await host.stop()
})

test('asrAvailable=true：getSpeechToText 返回服务对象', async () => {
  const { factory } = makeFakeGateway()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    getSpeechToText: () => ({ resolve: () => {}, transcribe: () => {} }),
  })
  await host.start()
  assert.equal(host.status().asrAvailable, true)
  await host.stop()
})

test('asrAvailable：getSpeechToText 抛错按不可用处理', async () => {
  const { factory } = makeFakeGateway()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    getSpeechToText: () => { throw new Error('service missing') },
  })
  await host.start()
  assert.equal(host.status().asrAvailable, false)
  await host.stop()
})

// ── 7. log：无 channelLog 返回空；有则透传 device/limit ─────────────────────
test('log：无 channelLog 返回空数组', async () => {
  const host = createEsp32Host({
    getConfig: makeConfig({ enabled: false }),
    createGateway: makeFakeGateway().factory,
    createSession: makeFakeSessionFactory().factory,
  })
  assert.deepEqual(host.log({ device: 'dev-1', limit: 10 }), [])
})

test('log：有 channelLog 时透传 device/limit', async () => {
  const calls = []
  const channelLog = {
    recent(device, limit) {
      calls.push([device, limit])
      return [{ role: 'user', text: '你好' }]
    },
  }
  const host = createEsp32Host({
    getConfig: makeConfig({ enabled: false }),
    createGateway: makeFakeGateway().factory,
    createSession: makeFakeSessionFactory().factory,
    channelLog,
  })
  const rows = host.log({ device: 'dev-1', limit: 7 })
  assert.deepEqual(calls, [['dev-1', 7]])
  assert.deepEqual(rows, [{ role: 'user', text: '你好' }])
})

test('log：channelLog 抛错时返回空数组', async () => {
  const host = createEsp32Host({
    getConfig: makeConfig({ enabled: false }),
    createGateway: makeFakeGateway().factory,
    createSession: makeFakeSessionFactory().factory,
    channelLog: { recent() { throw new Error('boom') } },
  })
  assert.deepEqual(host.log({ device: 'dev-1' }), [])
})

// ── 8. 管线注入点：缺省 null，注入时透传 sessionCtx ─────────────────────────
test('createPipeline：缺省不传管线；注入时收到 sessionCtx 与依赖', async () => {
  const { factory, state } = makeFakeGateway()
  const sessions = makeFakeSessionFactory()
  const seen = []
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: sessions.factory,
    createPipeline: (sessionCtx, deps) => {
      seen.push({ sessionCtx, deps })
      return { onOpen() {} }
    },
    getSpeechToText: () => null,
  })
  await host.start()
  state.createSession({ deviceId: 'dev-1', sessionId: 'sess-1', sendJson: () => true, sendBinary: () => true, close: () => {} })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionCtx.deviceId, 'dev-1')
  assert.equal(typeof seen[0].deps.getSpeechToText, 'function')
  assert.equal(typeof seen[0].deps.getConfig, 'function')
  assert.equal(typeof seen[0].deps.reportError, 'function', '管线需拿到 reportError 记录 lastError')
  await host.stop()
})

// ── 9. llmKeySet：状态页可见「Key 是否已配置」（不回传明文）──────────────────
test('status.llmKeySet：有 Key 为 true、无 Key 为 false，且不回传明文', async () => {
  const { factory } = makeFakeGateway()
  const withKey = createEsp32Host({
    getConfig: makeConfig({ enabled: false }),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    getLlmApiKey: () => 'sk-test-abcdef',
  })
  assert.equal(withKey.status().llmKeySet, true)
  assert.equal(JSON.stringify(withKey.status()).includes('sk-test-abcdef'), false, 'status 不得回传 Key 明文')

  const withoutKey = createEsp32Host({
    getConfig: makeConfig({ enabled: false }),
    createGateway: factory,
    createSession: makeFakeSessionFactory().factory,
    getLlmApiKey: () => '',
  })
  assert.equal(withoutKey.status().llmKeySet, false)
})

// ── 10. reportError：管线异常写入 lastError（脱敏）───────────────────────────
test('deps.reportError：错误写入 status.lastError 且脱敏 token', async () => {
  const { factory, state } = makeFakeGateway()
  const sessions = makeFakeSessionFactory()
  const { logger, rows } = makeLogger()
  const host = createEsp32Host({
    getConfig: makeConfig(),
    createGateway: factory,
    createSession: sessions.factory,
    createPipeline: (sessionCtx, deps) => {
      deps.reportError(new Error(`LLM HTTP 401 token=${TOKEN}`), { deviceId: sessionCtx.deviceId, stage: 'brain' })
      return { onOpen() {} }
    },
    getSpeechToText: () => null,
    logger,
  })
  await host.start()
  state.createSession({ deviceId: 'dev-1', sessionId: 'sess-1', sendJson: () => true, sendBinary: () => true, close: () => {} })

  const status = host.status()
  assert.ok(status.lastError, '应记录管线错误')
  assert.match(status.lastError, /LLM HTTP 401/)
  assert.ok(!status.lastError.includes(TOKEN), 'lastError 不得包含 token')
  assert.ok(!JSON.stringify(rows).includes(TOKEN), '日志不得包含 token')
  assert.ok(rows.some(([level, message]) => level === 'warn' && String(message).includes('LLM HTTP 401')), '应记录 warn 日志')
  await host.stop()
})
