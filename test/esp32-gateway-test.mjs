// ESP32 第五通道 · T12「网关（OTA + WS）」测试
//
// 覆盖：
// 1. OTA：GET/POST、带/不带尾斜杠，firmware/websocket/server_time，无 mqtt/activation；
// 2. WS 鉴权：缺 Bearer / 错 token / 长度不等 → upgrade 阶段 401，错误响应不回显 token；
// 3. hello：服务端 hello 形状；超时未收到 hello 关闭连接；
// 4. 消息容错：未知类型（含 mcp）忽略且不报错，非法 JSON 只关当前连接，会话异常只关当前连接；
// 5. token 自动生成（≥16 字节）+ saveEsp32Config 写回 + 日志不泄露；
// 6. allowDevices：hello 后校验，白名单外关闭并记录（日志不含 token）；
// 7. publicHost 纯函数：Mihomo/默认路由/RFC1918 兜底/显式覆盖/虚拟网卡排除；
// 8. 生命周期：start/stop 幂等、端口占用清晰报错、stop 释放端口并关闭全部连接。
//
// 全部走本机回环（127.0.0.1）与端口 0；不访问外网；
// FEIYU_CONFIG 指向临时目录，绝不读写真实 ~/.dsh 配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { WebSocket } from 'ws'

// ── 隔离：必须在 import 业务模块之前设置（paths.mjs 在导入时读取） ─────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-gateway-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
const CONFIG_FILE = process.env.FEIYU_CONFIG
fs.writeFileSync(CONFIG_FILE, '{}')

const { createGateway, verifyBearerToken } = await import('../lib/esp32/gateway.js')
const { selectPublicHost } = await import('../lib/esp32/gateway/public-host.js')
const { WS_PATH } = await import('../lib/esp32/contracts.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 常量与测试工具 ──────────────────────────────────────────────────────────
const TOKEN = 'test-token-0123456789abcdef'
const CLIENT_HELLO = Object.freeze({
  type: 'hello',
  version: 1,
  features: { mcp: true },
  transport: 'websocket',
  audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
})

const ETHERNET = {
  Ethernet: [{
    address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4',
    mac: '00:11:22:33:44:55', internal: false, cidr: '192.168.1.10/24',
  }],
}

function baseEsp32(over = {}) {
  return {
    enabled: true,
    port: 0,
    publicHost: '',
    token: TOKEN,
    allowDevices: [],
    ...over,
  }
}

/** 创建网关并注入测试 logger / saveConfig / 网卡信息（不触发真实 PowerShell / 配置写入）。 */
function makeGateway(options = {}) {
  const { esp32: esp32Override = {}, ...rest } = options
  const logs = []
  const logger = {
    debug: (...args) => logs.push(['debug', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  }
  const saves = []
  const gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    esp32: baseEsp32(esp32Override),
    saveConfig: async (patch) => { saves.push(patch); return {} },
    logger,
    interfaces: ETHERNET,
    routes: [],
    addressIndexes: { '192.168.1.10': 1 },
    ...rest,
  })
  return { gw, logs, saves, logsText: () => JSON.stringify(logs) }
}

async function withGateway(options, fn) {
  const ctx = makeGateway(options)
  try {
    await ctx.gw.start()
    return await fn(ctx)
  } finally {
    await ctx.gw.stop()
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function openClient(port, opts = {}) {
  const headers = {
    'Device-Id': opts.deviceId ?? 'AA:BB:CC:DD:EE:01',
    'Client-Id': opts.clientId ?? 'client-test',
    'Protocol-Version': '1',
  }
  const token = Object.prototype.hasOwnProperty.call(opts, 'token') ? opts.token : TOKEN
  if (token != null) headers.Authorization = `Bearer ${token}`
  const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? WS_PATH}`, { headers })
  ws.on('error', () => {}) // 防止未处理的 error 事件；具体断言用 once 监听器
  return ws
}

function waitOpen(ws, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    const timer = setTimeout(() => { cleanup(); reject(new Error('WS open timeout')) }, ms)
    const onOpen = () => { cleanup(); resolve() }
    const onError = (err) => { cleanup(); reject(err) }
    const cleanup = () => { clearTimeout(timer); ws.off('open', onOpen); ws.off('error', onError) }
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

function waitClose(ws, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WS close timeout')) }, ms)
    const onClose = (code, reason) => { cleanup(); resolve({ code, reason: reason?.toString?.() ?? '' }) }
    const cleanup = () => { clearTimeout(timer); ws.off('close', onClose) }
    ws.once('close', onClose)
  })
}

function nextJson(ws, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WS message timeout')) }, ms)
    const onMsg = (data, isBinary) => {
      if (isBinary) return
      cleanup()
      try { resolve(JSON.parse(data.toString('utf8'))) } catch (e) { reject(e) }
    }
    const onErr = (err) => { cleanup(); reject(err) }
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMsg); ws.off('error', onErr) }
    ws.on('message', onMsg)
    ws.once('error', onErr)
  })
}

/** ms 内收到的第一条服务端消息（没有则 null），用于断言“服务端保持沉默”。 */
function collectNoMessage(ws, ms) {
  return new Promise((resolve) => {
    let got = null
    const onMsg = (data, isBinary) => { if (!isBinary) got = data.toString('utf8') }
    ws.on('message', onMsg)
    setTimeout(() => { ws.off('message', onMsg); resolve(got) }, ms)
  })
}

function unexpectedResponse(ws, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('unexpected-response timeout')) }, ms)
    const onRes = (req, res) => { cleanup(); resolve(res) }
    const onOpen = () => { cleanup(); reject(new Error('WS 未按预期被拒绝')) }
    const onErr = (err) => { cleanup(); reject(err) }
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('unexpected-response', onRes)
      ws.off('open', onOpen)
      ws.off('error', onErr)
    }
    ws.once('unexpected-response', onRes)
    ws.once('open', onOpen)
    ws.once('error', onErr)
  })
}

/** 直接发裸 HTTP upgrade 请求，用于测试 ws 客户端无法构造的畸形 Authorization 头。 */
function rawUpgrade(port, path, headers, ms = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error('raw upgrade timeout'))
    }, ms)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onData = (chunk) => { data += chunk.toString('utf8') }
    const onError = (err) => { cleanup(); reject(err) }
    const onClose = () => {
      cleanup()
      const statusLine = data.split('\r\n')[0] || ''
      const match = /^HTTP\/1\.1 (\d{3})/.exec(statusLine)
      resolve({ statusCode: match ? Number(match[1]) : null, raw: data })
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      '',
      '',
    ].join('\r\n'))
  })
}

async function readResponseBody(res) {
  let body = ''
  for await (const chunk of res) body += chunk.toString('utf8')
  return body
}

async function openAndHello(port, opts = {}) {
  const ws = openClient(port, opts)
  await waitOpen(ws)
  const helloPromise = nextJson(ws)
  ws.send(JSON.stringify(CLIENT_HELLO))
  return { ws, hello: await helloPromise }
}

function listenOn(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(port, host, () => resolve(srv))
  })
}

function closeServer(srv) {
  return new Promise((resolve) => srv.close(() => resolve()))
}

// ── OTA ─────────────────────────────────────────────────────────────────────
test('OTA：GET/POST、带/不带尾斜杠返回可解析 JSON，不含 mqtt/activation', async () => {
  await withGateway({}, async ({ gw }) => {
    const { port } = gw.address()
    assert.ok(port > 0)
    const base = `http://127.0.0.1:${port}`

    for (const p of ['/xiaozhi/ota/', '/xiaozhi/ota']) {
      const res = await fetch(base + p)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') || '', /application\/json/)
      const json = await res.json()
      assert.deepEqual(json.firmware, { version: '0.0.0', force: 0, url: '' })
      assert.equal(json.websocket.token, TOKEN)
      assert.equal(json.websocket.url, `ws://192.168.1.10:${port}/xiaozhi/v1/`)
      assert.equal(json.mqtt, undefined)
      assert.equal(json.activation, undefined)
      assert.equal(typeof json.server_time.timestamp, 'number')
      assert.equal(json.server_time.timezone_offset, -new Date().getTimezoneOffset())
    }

    const res = await fetch(base + '/xiaozhi/ota', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ application: { version: '2.5.2' } }),
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.firmware.version, '2.5.2')
    assert.equal(json.firmware.force, 0)
  })
})

test('HTTP：未知路径 404，OTA 非 GET/POST 返回 405', async () => {
  await withGateway({}, async ({ gw }) => {
    const base = `http://127.0.0.1:${gw.address().port}`
    const notFound = await fetch(base + '/nope')
    assert.equal(notFound.status, 404)
    assert.match(notFound.headers.get('content-type') || '', /application\/json/)

    const put = await fetch(base + '/xiaozhi/ota/', { method: 'PUT', body: '{}' })
    assert.equal(put.status, 405)
    assert.equal(put.headers.get('allow'), 'GET, POST')
  })
})

test('publicHost：显式配置优先，OTA URL 使用它', async () => {
  await withGateway({ esp32: { publicHost: '10.9.8.7' } }, async ({ gw }) => {
    assert.equal(gw.publicHost(), '10.9.8.7')
    const json = await (await fetch(`http://127.0.0.1:${gw.address().port}/xiaozhi/ota/`)).json()
    assert.equal(json.websocket.url, `ws://10.9.8.7:${gw.address().port}/xiaozhi/v1/`)
  })
})

// ── WS 鉴权 / hello ─────────────────────────────────────────────────────────
test('WS 鉴权：缺 Bearer / 错 token / 长度不等 / 裸 token 均 401，响应不回显 token', async () => {
  await withGateway({}, async ({ gw }) => {
    const { port } = gw.address()
    const cases = [
      { label: '缺 Authorization', token: null },
      { label: '长度相同但内容错误', token: 'x'.repeat(TOKEN.length) },
      { label: '长度不等', token: 'short' },
    ]
    for (const c of cases) {
      const ws = openClient(port, { token: c.token })
      const res = await unexpectedResponse(ws)
      assert.equal(res.statusCode, 401, c.label)
      const body = await readResponseBody(res)
      assert.match(body, /Unauthorized/)
      assert.ok(!body.includes(TOKEN), `${c.label}：401 响应不得回显正确 token`)
      if (c.token) assert.ok(!body.includes(c.token), `${c.label}：401 响应不得回显尝试的 token`)
      ws.terminate()
    }

    // 无 Bearer 前缀的裸 token：ws 客户端无法构造该头，直接发裸 HTTP upgrade。
    const raw = await rawUpgrade(port, WS_PATH, {
      'Device-Id': 'AA:BB:CC:DD:EE:01',
      'Client-Id': 'client-test',
      'Protocol-Version': '1',
      Authorization: TOKEN,
    })
    assert.equal(raw.statusCode, 401, '无 Bearer 前缀')
    assert.match(raw.raw, /Unauthorized/)
    assert.ok(!raw.raw.includes(TOKEN), '401 响应不得回显 token')
  })
})

test('verifyBearerToken：Bearer 必填、长度不等先拒绝', () => {
  assert.equal(verifyBearerToken(`Bearer ${TOKEN}`, TOKEN), true)
  assert.equal(verifyBearerToken(`bearer ${TOKEN}`, TOKEN), true)
  assert.equal(verifyBearerToken(TOKEN, TOKEN), false)
  assert.equal(verifyBearerToken(`Bearer ${TOKEN}x`, TOKEN), false)
  assert.equal(verifyBearerToken(`Bearer ${'x'.repeat(TOKEN.length)}`, TOKEN), false)
  assert.equal(verifyBearerToken('Bearer ', TOKEN), false)
  assert.equal(verifyBearerToken(`Bearer ${TOKEN}`, ''), false)
  assert.equal(verifyBearerToken(undefined, TOKEN), false)
  assert.equal(verifyBearerToken(null, TOKEN), false)
})

test('hello：服务端下发 websocket/opus 24k 参数', async () => {
  await withGateway({}, async ({ gw }) => {
    const { ws, hello } = await openAndHello(gw.address().port)
    assert.equal(hello.type, 'hello')
    assert.equal(hello.transport, 'websocket')
    assert.equal(typeof hello.session_id, 'string')
    assert.ok(hello.session_id.length > 0)
    assert.deepEqual(hello.audio_params, {
      format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60,
    })
    ws.close()
    await waitClose(ws)
  })
})

test('hello：超时未收到 hello 关闭连接', async () => {
  await withGateway({ helloTimeoutMs: 120 }, async ({ gw }) => {
    const ws = openClient(gw.address().port)
    await waitOpen(ws)
    const started = Date.now()
    const { code } = await waitClose(ws)
    const elapsed = Date.now() - started
    assert.equal(code, 4000)
    assert.ok(elapsed >= 80, `关闭过快：${elapsed}ms`)
    assert.ok(elapsed < 3000, `关闭过慢：${elapsed}ms`)
  })
})

// ── 消息容错 / 会话接线 ─────────────────────────────────────────────────────
test('消息容错：mcp 忽略且不报错，listen/abort 转交会话', async () => {
  const seen = []
  const createSession = () => ({
    state: 'idle',
    handleJson(json) { seen.push(json.type) },
    handleAudio() {},
    abort() {},
    close() { seen.push('closed') },
  })
  await withGateway({ createSession }, async ({ gw, logs }) => {
    const { ws } = await openAndHello(gw.address().port)
    const silent = collectNoMessage(ws, 150)
    ws.send(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1 } }))
    ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    ws.send(JSON.stringify({ type: 'abort' }))
    assert.equal(await silent, null, 'mcp/未知消息不应得到任何下行响应')
    // hello 会交给会话初始化；mcp 不得出现在会话回调里
    assert.deepEqual(seen.filter((t) => t !== 'closed'), ['hello', 'listen', 'abort'])
    assert.equal(ws.readyState, WebSocket.OPEN)
    assert.ok(!logs.some(([level]) => level === 'error'), 'mcp 不应产生错误日志')
    ws.close()
    await waitClose(ws)
  })
})

test('非法 JSON 只关闭当前连接，其他连接与服务不受影响', async () => {
  await withGateway({}, async ({ gw }) => {
    const port = gw.address().port
    const a = await openAndHello(port)
    const b = await openAndHello(port)

    const closedB = waitClose(b.ws)
    b.ws.send('{not valid json')
    const { code } = await closedB
    assert.equal(code, 1007)

    await delay(100)
    assert.equal(a.ws.readyState, WebSocket.OPEN, '另一条连接必须保持可用')
    const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`)
    assert.equal(res.status, 200, '服务本身不受影响')
    a.ws.close()
    await waitClose(a.ws)
  })
})

test('会话处理抛错只关闭该连接，其他连接与 OTA 不受影响', async () => {
  const THROW_ID = 'FF:FF:FF:FF:FF:FF'
  const createSession = (ctx) => ({
    state: 'idle',
    handleJson(json) {
      if (json.type === 'listen' && ctx.deviceId === THROW_ID) throw new Error('boom')
    },
    handleAudio() {},
    abort() {},
    close() {},
  })
  await withGateway({ createSession }, async ({ gw }) => {
    const port = gw.address().port
    const bad = await openAndHello(port, { deviceId: THROW_ID })
    const good = await openAndHello(port, { deviceId: 'AA:AA:AA:AA:AA:AA' })

    const closed = waitClose(bad.ws)
    bad.ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    assert.equal((await closed).code, 1011)

    await delay(100)
    assert.equal(good.ws.readyState, WebSocket.OPEN)
    const res = await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`)
    assert.equal(res.status, 200)
    good.ws.close()
    await waitClose(good.ws)
  })
})

// ── token 生成与 allowDevices ───────────────────────────────────────────────
test('token 为空：自动生成 ≥16 字节、saveEsp32Config 写回、日志不泄露', async () => {
  await withGateway({ esp32: { token: '' } }, async ({ gw, saves, logsText }) => {
    const { port } = gw.address()
    const json = await (await fetch(`http://127.0.0.1:${port}/xiaozhi/ota/`)).json()
    const token = json.websocket.token

    assert.match(token, /^[0-9a-f]+$/)
    assert.ok(Buffer.byteLength(token, 'utf8') >= 16, `token 太短：${token.length}`)
    assert.equal(saves.length, 1)
    assert.deepEqual(saves[0], { esp32: { token } })
    assert.ok(!logsText().includes(token), '日志不得包含 token')

    // 生成的 token 可用于 WS
    const { ws, hello } = await openAndHello(port, { token })
    assert.equal(hello.type, 'hello')
    ws.close()
    await waitClose(ws)
  })
})

test('token 写回失败：网关仍启动并使用内存 token，日志不含 token', async () => {
  const logs = []
  const logger = {
    debug: (...a) => logs.push(['debug', ...a]),
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
  }
  const gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    esp32: baseEsp32({ token: '' }),
    saveConfig: async () => { throw new Error('disk full') },
    logger,
    interfaces: ETHERNET,
    routes: [],
    addressIndexes: {},
  })
  await gw.start()
  try {
    const json = await (await fetch(`http://127.0.0.1:${gw.address().port}/xiaozhi/ota/`)).json()
    const token = json.websocket.token
    assert.match(token, /^[0-9a-f]+$/)
    assert.ok(logs.some(([level]) => level === 'error'))
    assert.ok(!JSON.stringify(logs).includes(token))
  } finally {
    await gw.stop()
  }
})

test('allowDevices：白名单外设备 hello 后关闭，日志不含 token', async () => {
  await withGateway({ esp32: { allowDevices: ['aa:bb:cc:dd:ee:01'] } }, async ({ gw, logsText }) => {
    const port = gw.address().port

    const allowed = await openAndHello(port, { deviceId: 'AA:BB:CC:DD:EE:01' })
    assert.equal(allowed.hello.type, 'hello')

    const deniedWs = openClient(port, { deviceId: '11:22:33:44:55:66' })
    await waitOpen(deniedWs)
    const closed = waitClose(deniedWs)
    deniedWs.send(JSON.stringify(CLIENT_HELLO))
    assert.equal((await closed).code, 4003)

    assert.ok(logsText().includes('11:22:33:44:55:66'), '应记录被拒绝的 device id')
    assert.ok(!logsText().includes(TOKEN), '日志不得包含 token')

    allowed.ws.close()
    await waitClose(allowed.ws)
  })
})

// ── 生命周期 ────────────────────────────────────────────────────────────────
test('生命周期：start/stop 幂等、stop 关闭连接并释放端口、可重启', async () => {
  const { gw } = makeGateway()
  assert.equal(gw.address(), null)

  const a1 = await gw.start()
  const a2 = await gw.start()
  assert.equal(a1.port, a2.port)

  const { ws } = await openAndHello(a1.port)
  const closed = waitClose(ws)
  await gw.stop()
  await closed
  assert.equal(gw.address(), null)
  await gw.stop()

  // 端口已释放：可以重新绑定
  const rebind = await listenOn(a1.port)
  await closeServer(rebind)

  // 可再次启动
  const a3 = await gw.start()
  assert.ok(a3.port > 0)
  await gw.stop()
  assert.equal(gw.address(), null)
})

test('端口占用：start 明确报错（含端口号与 EADDRINUSE），stop 安全', async () => {
  const blocker = await listenOn(0)
  const port = blocker.address().port
  const { gw } = makeGateway({ port })
  try {
    await assert.rejects(gw.start(), (err) => {
      assert.match(err.message, /EADDRINUSE/)
      assert.ok(err.message.includes(String(port)), `错误信息应包含端口 ${port}：${err.message}`)
      return true
    })
    await gw.stop()
    assert.equal(gw.address(), null)
  } finally {
    await closeServer(blocker)
  }
})

test('端口默认取 config().esp32.port；token 来自配置文件', async () => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ esp32: { port: 0, token: 'config-token-abcdef' } }))
  const gw = createGateway({
    host: '127.0.0.1',
    interfaces: ETHERNET,
    routes: [],
    addressIndexes: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  try {
    await gw.start()
    assert.ok(gw.address().port > 0)
    const json = await (await fetch(`http://127.0.0.1:${gw.address().port}/xiaozhi/ota/`)).json()
    assert.equal(json.websocket.token, 'config-token-abcdef')
  } finally {
    await gw.stop()
    fs.writeFileSync(CONFIG_FILE, '{}')
  }
})

// ── publicHost 纯函数（docs/spikes.md §A3） ─────────────────────────────────
const MIHOMO_INTERFACES = {
  Mihomo: [{
    address: '198.18.0.1', netmask: '255.255.255.252', family: 'IPv4',
    mac: '00:00:00:00:00:54', internal: false, cidr: '198.18.0.1/30',
  }],
  WLAN: [{
    address: '192.168.10.39', netmask: '255.255.255.0', family: 'IPv4',
    mac: '00:00:00:00:00:10', internal: false, cidr: '192.168.10.39/24',
  }],
  'Loopback Pseudo-Interface 1': [{
    address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4',
    mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8',
  }],
  'vEthernet (WSL (Hyper-V firewall))': [{
    address: '172.28.176.1', netmask: '255.255.240.0', family: 'IPv4',
    mac: '00:00:00:00:00:42', internal: false, cidr: '172.28.176.1/20',
  }],
}
const MIHOMO_ROUTES = [
  { InterfaceIndex: 54, InterfaceAlias: 'Mihomo', NextHop: '198.18.0.2', RouteMetric: 0, InterfaceMetric: 0, TotalMetric: 0 },
  { InterfaceIndex: 10, InterfaceAlias: 'WLAN', NextHop: '192.168.10.1', RouteMetric: 0, InterfaceMetric: 30, TotalMetric: 30 },
]
const MIHOMO_INDEXES = { '198.18.0.1': 54, '192.168.10.39': 10, '127.0.0.1': 1, '172.28.176.1': 42 }

test('selectPublicHost：Mihomo 198.18 与 WLAN 192.168 共存时选 WLAN 默认路由', () => {
  const sel = selectPublicHost({
    interfaces: MIHOMO_INTERFACES,
    routes: MIHOMO_ROUTES,
    addressIndexes: MIHOMO_INDEXES,
  })
  assert.equal(sel.address, '192.168.10.39')
  assert.equal(sel.interfaceName, 'WLAN')
  assert.equal(sel.method, 'eligible-default-route')
  assert.equal(sel.route.InterfaceIndex, 10)

  const mihomo = sel.candidates.find((c) => c.address === '198.18.0.1')
  assert.equal(mihomo.eligible, false)
  assert.ok(mihomo.excluded.length > 0)
  const wlan = sel.candidates.find((c) => c.address === '192.168.10.39')
  assert.equal(wlan.eligible, true)
})

test('selectPublicHost：默认路由全在虚拟网卡时按 RFC1918 兜底（192.168 > 10）', () => {
  const interfaces = {
    ...MIHOMO_INTERFACES,
    Ethernet: [{
      address: '10.1.2.3', netmask: '255.0.0.0', family: 'IPv4',
      mac: '00:00:00:00:00:20', internal: false, cidr: '10.1.2.3/8',
    }],
  }
  const sel = selectPublicHost({
    interfaces,
    routes: [MIHOMO_ROUTES[0]], // 只有 Mihomo 的默认路由（合格网卡上没有默认路由）
    addressIndexes: { ...MIHOMO_INDEXES, '10.1.2.3': 20 },
  })
  assert.equal(sel.address, '192.168.10.39')
  assert.equal(sel.method, 'private-lan-fallback')
  assert.equal(sel.route, null)
})

test('selectPublicHost：无合格 RFC1918 时返回 null（不做公网兜底）', () => {
  const interfaces = {
    Ethernet: [{
      address: '8.8.8.8', netmask: '255.255.255.0', family: 'IPv4',
      mac: '00:00:00:00:00:30', internal: false, cidr: '8.8.8.8/24',
    }],
  }
  const sel = selectPublicHost({ interfaces, routes: [], addressIndexes: { '8.8.8.8': 30 } })
  assert.equal(sel.address, null)
  assert.equal(sel.method, null)
  assert.equal(sel.candidates.find((c) => c.address === '8.8.8.8').eligible, true)
})

test('selectPublicHost：显式覆盖优先（即使不在本机网卡列表）', () => {
  const sel = selectPublicHost({
    interfaces: ETHERNET,
    routes: [],
    addressIndexes: {},
    override: '10.1.2.3',
  })
  assert.equal(sel.address, '10.1.2.3')
  assert.equal(sel.method, 'explicit')
  assert.equal(sel.route, null)
})

test('selectPublicHost：排除 169.254 / loopback / 虚拟网卡，全部不合格时返回 null', () => {
  const interfaces = {
    'Loopback Pseudo-Interface 1': MIHOMO_INTERFACES['Loopback Pseudo-Interface 1'],
    'vEthernet (WSL (Hyper-V firewall))': MIHOMO_INTERFACES['vEthernet (WSL (Hyper-V firewall))'],
    Clash: [{
      address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4',
      mac: '00:00:00:00:00:60', internal: false, cidr: '10.0.0.1/24',
    }],
    'Ethernet 2': [{
      address: '169.254.10.20', netmask: '255.255.0.0', family: 'IPv4',
      mac: '00:00:00:00:00:70', internal: false, cidr: '169.254.10.20/16',
    }],
  }
  const sel = selectPublicHost({ interfaces, routes: [], addressIndexes: {} })
  assert.equal(sel.address, null)
  for (const address of ['127.0.0.1', '172.28.176.1', '10.0.0.1', '169.254.10.20']) {
    const c = sel.candidates.find((x) => x.address === address)
    assert.ok(c, `${address} 应出现在候选里`)
    assert.equal(c.eligible, false, `${address} 不应合格`)
    assert.ok(c.excluded.length > 0, `${address} 应有排除原因`)
  }
})

test('selectPublicHost：无合格地址时 OTA 使用 127.0.0.1 且 publicHost() 为 null', async () => {
  const loopbackOnly = {
    'Loopback Pseudo-Interface 1': MIHOMO_INTERFACES['Loopback Pseudo-Interface 1'],
  }
  await withGateway({ interfaces: loopbackOnly, routes: [], addressIndexes: {} }, async ({ gw }) => {
    assert.equal(gw.publicHost(), null)
    const json = await (await fetch(`http://127.0.0.1:${gw.address().port}/xiaozhi/ota/`)).json()
    assert.equal(json.websocket.url, `ws://127.0.0.1:${gw.address().port}/xiaozhi/v1/`)
  })
})
