// ESP32 网关连通性自检（lib/esp32/selfcheck.js）测试
// 覆盖：网关未启动（ota/ws 跳过）、token 缺失、全部正常、ota 超时、白名单拒绝探测（视为 ok）、
// 响应不含 token；外加真实 createGateway + createEsp32Host 的本机回环集成用例。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-selfcheck-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const { createSelfcheck, SELFCHECK_DEVICE_ID } = await import('../lib/esp32/selfcheck.js')
const { createGateway } = await import('../lib/esp32/gateway.js')
const { createEsp32Host } = await import('../lib/esp32/host.js')

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

const TOKEN = 'secret-token-0123456789abcdef'
const upStatus = (over = {}) => ({ ok: true, enabled: true, running: true, address: { port: 8765 }, tokenSet: true, ...over })

const okFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ websocket: { url: 'ws://192.168.1.2:8765/xiaozhi/v1/', token: TOKEN } }),
})

/** 假 WebSocket：按 script 决定握手结果。 */
function fakeWs(script) {
  const instances = []
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super()
      this.url = url
      this.opts = opts
      this.closedWith = null
      instances.push(this)
      setImmediate(() => script(this))
    }
    close(code) { this.closedWith = code; setImmediate(() => this.emit('close', code, Buffer.alloc(0))) }
    terminate() { this.terminated = true }
  }
  FakeWs.instances = instances
  return FakeWs
}
const openWs = fakeWs((ws) => ws.emit('open'))

const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]))

test('契约形状：四项固定顺序，全部正常', async () => {
  const run = createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl: okFetch, WebSocketImpl: openWs })
  const r = await run()
  assert.equal(r.ok, true)
  assert.deepEqual(r.checks.map((c) => c.id), ['gateway', 'ota', 'ws', 'token'])
  assert.ok(r.checks.every((c) => c.ok && typeof c.detail === 'string'))
  const ws = openWs.instances.at(-1)
  assert.equal(ws.opts.headers['Device-Id'], SELFCHECK_DEVICE_ID)
  assert.equal(ws.closedWith, 1000)
  assert.equal(JSON.stringify(r).includes(TOKEN), false)
})

test('网关未启动：ota/ws 标记跳过且不探测', async () => {
  let fetched = 0
  let constructed = 0
  const W = fakeWs(() => {})
  const run = createSelfcheck({
    getStatus: () => upStatus({ running: false, address: null }),
    getToken: () => TOKEN,
    fetchImpl: async () => { fetched++; return okFetch() },
    WebSocketImpl: class extends W { constructor(...a) { super(...a); constructed++ } },
  })
  const r = await run()
  const c = byId(r)
  assert.equal(r.ok, false)
  assert.deepEqual([c.gateway.ok, c.gateway.detail], [false, '网关未启动'])
  assert.deepEqual([c.ota.ok, c.ota.detail], [false, '跳过'])
  assert.deepEqual([c.ws.ok, c.ws.detail], [false, '跳过'])
  assert.equal(fetched + constructed, 0)
})

test('enabled=false 同样视为网关未启动', async () => {
  const run = createSelfcheck({ getStatus: () => upStatus({ enabled: false }), getToken: () => TOKEN, fetchImpl: okFetch, WebSocketImpl: openWs })
  assert.equal(byId(await run()).gateway.detail, '网关未启动')
})

test('token 缺失：token 项失败', async () => {
  const run = createSelfcheck({ getStatus: () => upStatus({ tokenSet: false }), getToken: () => '', fetchImpl: okFetch, WebSocketImpl: openWs })
  const r = await run()
  const c = byId(r)
  assert.equal(r.ok, false)
  assert.deepEqual([c.token.ok, c.token.detail], [false, '未配置 token'])
  assert.equal(c.gateway.ok, true)
  assert.equal(c.ws.ok, false)
})

test('ota 超时：≤3s 内返回失败，其余项不受影响', async () => {
  const hang = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const run = createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl: hang, WebSocketImpl: openWs, timeoutMs: 50 })
  const t0 = Date.now()
  const r = await run()
  assert.ok(Date.now() - t0 < 1500)
  const c = byId(r)
  assert.deepEqual([c.ota.ok, c.ota.detail], [false, 'OTA 请求超时'])
  assert.equal(c.ws.ok, true)
  assert.equal(r.ok, false)
})

test('ota 非 2xx / 无 websocket 地址 / 抛错带 token 时脱敏', async () => {
  const mk = (fetchImpl) => createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl, WebSocketImpl: openWs })
  assert.match(byId(await mk(async () => ({ ok: false, status: 500 }))()).ota.detail, /HTTP 500/)
  assert.match(byId(await mk(async () => ({ ok: true, status: 200, json: async () => ({}) }))()).ota.detail, /websocket/)
  const r = await mk(async () => { throw new Error(`connect failed Bearer ${TOKEN} token=${TOKEN}`) })()
  assert.equal(JSON.stringify(r).includes(TOKEN), false)
  assert.equal(byId(r).ota.ok, false)
})

test('白名单拒绝探测设备（close 4003）视为握手可达', async () => {
  const W = fakeWs((ws) => { ws.emit('open') })
  class Rejecting extends W {
    close() { setImmediate(() => this.emit('close', 4003, Buffer.alloc(0))) }
  }
  const run = createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl: okFetch, WebSocketImpl: Rejecting })
  const r = await run()
  assert.deepEqual([byId(r).ws.ok, byId(r).ws.detail], [true, '探测设备被白名单拒绝（正常）'])
  assert.equal(r.ok, true)
})

test('ws 401 与握手失败', async () => {
  const W401 = fakeWs((ws) => ws.emit('unexpected-response', {}, { statusCode: 401, resume() {} }))
  let r = await createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl: okFetch, WebSocketImpl: W401 })()
  assert.match(byId(r).ws.detail, /鉴权失败/)
  const Werr = fakeWs((ws) => ws.emit('error', new Error(`ECONNREFUSED Bearer ${TOKEN}`)))
  r = await createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl: okFetch, WebSocketImpl: Werr })()
  assert.equal(byId(r).ws.ok, false)
  assert.equal(JSON.stringify(r).includes(TOKEN), false)
})

test('ws 握手超时 ≤ timeoutMs', async () => {
  const Wsilent = fakeWs(() => {})
  const t0 = Date.now()
  const r = await createSelfcheck({ getStatus: () => upStatus(), getToken: () => TOKEN, fetchImpl: okFetch, WebSocketImpl: Wsilent, timeoutMs: 50 })()
  assert.ok(Date.now() - t0 < 1500)
  assert.deepEqual([byId(r).ws.ok, byId(r).ws.detail], [false, 'WS 握手超时'])
})

// ── 集成：真实 gateway + host，本机随机端口，白名单非空 ─────────────────────
test('集成：真实网关自检全部通过，探测设备不残留、不建会话', async () => {
  const esp32 = { enabled: true, port: 0, publicHost: '', token: TOKEN, allowDevices: ['some-real-device'] }
  const sessions = []
  const host = createEsp32Host({
    getConfig: () => ({ esp32 }),
    saveConfig: async () => ({}),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    createGateway: (opts) => createGateway({ ...opts, host: '127.0.0.1', routes: [], addressIndexes: {} }),
    createSession: (args) => { sessions.push(args.deviceId); return { state: 'idle', close() {} } },
  })
  await host.start()
  try {
    assert.equal(host.status().running, true)
    const run = createSelfcheck({ getStatus: () => host.status(), getToken: () => esp32.token })
    const r = await run()
    assert.deepEqual(r.checks.map((c) => c.id), ['gateway', 'ota', 'ws', 'token'])
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(JSON.stringify(r).includes(TOKEN), false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(host.status().devices.length, 0)
    assert.deepEqual(sessions, [])

    // token 不匹配 → ws 项失败
    const bad = await createSelfcheck({ getStatus: () => host.status(), getToken: () => 'wrong-token' })()
    assert.equal(byId(bad).ws.ok, false)
    assert.equal(bad.ok, false)
  } finally {
    await host.stop()
  }
  const down = await createSelfcheck({ getStatus: () => host.status(), getToken: () => TOKEN })()
  assert.equal(byId(down).gateway.detail, '网关未启动')
})
