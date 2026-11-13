// 连接中心聚合层 + 路由测试（假 qq/douyin/fetch，不碰网络与真进程）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConnections, registerConnectionRoutes } from '../lib/connections.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-'))
const credentialsPath = path.join(tmp, 'credentials.json')
const wechatBeatPath = path.join(tmp, 'beat.json')
let t = 1_000_000
const now = () => t
const SECRET = 'SESSDATA_SECRET_VALUE_1234567890'

const qq = {
  probe: async () => ({ gateway: { ok: true, url: 'http://127.0.0.1:3000' }, loggedIn: true, uin: '10001', nickname: 'bot', qr: { exists: false, ageSec: null, expired: false }, error: null }),
  readQrcode: () => ({ ok: true, exists: false, ageSec: null, expired: false, dataUrl: null }),
}
let loginState = { ok: true, state: 'idle' }
const douyin = {
  probeCheap: () => ({ configured: false, loggedIn: false, nickname: '', secUid: '', cookieAgeSec: null, checkedAt: 0, error: null, login: { state: loginState.state } }),
  checkReal: async () => ({ ok: false, code: 'E_TIMEOUT', error: 'self-info 超时' }),
  loginStatus: () => loginState,
  loginStart: () => (loginState = { ok: true, state: 'waiting', remainingSec: 180 }),
  loginCancel: () => (loginState = { ok: true, state: 'idle' }),
  dispose: () => {},
}
let navReply = { code: 0, data: { isLogin: true, mid: 42, uname: 'tester' } }
let navCalls = 0
const fetchImpl = async () => { navCalls++; return { json: async () => navReply } }

const c = createConnections({ readConfig: () => ({}), credentialsPath, wechatBeatPath, esp32Status: () => ({ running: true }), fetchImpl, now, qq, douyin })

// 路由注册表
const routes = {}
const route = (p, h) => { routes[p] = h }
const json = (res, code, obj) => { res.code = code; res.body = obj }
const readBody = async (req) => req.body || ''
registerConnectionRoutes({ route, json, readBody, connections: c })
const call = async (p, method, body) => { const res = {}; await routes[p]({ method, body: body ? JSON.stringify(body) : '' }, res); return res }

// 1. 无凭据：unconfigured，loggedIn:null
let r = await call('/dsh-feiyu/api/connections', 'GET')
assert.equal(r.code, 200)
assert.equal(r.body.bilibili.configured, false)
assert.equal(r.body.bilibili.loggedIn, null)
assert.equal(r.body.wechat.alive, false)
assert.deepEqual(r.body.esp32, { running: true })
assert.equal(r.body.qq.uin, '10001')

// 2. 写入凭据后 GET 仍是未知（不自动探测），check 后才有结果
fs.writeFileSync(credentialsPath, JSON.stringify({ sessdata: SECRET, bili_jct: 'a'.repeat(32), buvid3: 'x' }))
r = await call('/dsh-feiyu/api/connections', 'GET')
assert.equal(r.body.bilibili.configured, true)
assert.equal(r.body.bilibili.loggedIn, null)
assert.equal(navCalls, 0)
r = await call('/dsh-feiyu/api/connections/check', 'POST', { target: 'bilibili' })
assert.equal(r.code, 200); assert.equal(r.body.result.loggedIn, true); assert.equal(r.body.result.name, 'tester')
r = await call('/dsh-feiyu/api/connections', 'GET')
assert.equal(r.body.bilibili.mid, '42')
t += 6 * 60_000 // TTL 过期 → 回到未知
r = await call('/dsh-feiyu/api/connections', 'GET')
assert.equal(r.body.bilibili.loggedIn, null)

// 3. nav 未登录
navReply = { code: -101, message: '账号未登录', data: {} }
r = await call('/dsh-feiyu/api/connections/check', 'POST', { target: 'bilibili' })
assert.equal(r.body.result.loggedIn, false); assert.match(r.body.result.error, /-101/)

// 4. noteBiliWrite
c.noteBiliWrite({ mid: '7', name: 'w' })
r = await call('/dsh-feiyu/api/connections', 'GET')
assert.equal(r.body.bilibili.loggedIn, true)

// 5. 抖音 check 失败透传错误码；坏 target / 坏 JSON
r = await call('/dsh-feiyu/api/connections/check', 'POST', { target: 'douyin' })
assert.equal(r.code, 504); assert.equal(r.body.code, 'E_TIMEOUT')
r = await call('/dsh-feiyu/api/connections/check', 'POST', { target: 'nope' })
assert.equal(r.code, 400); assert.equal(r.body.code, 'E_BAD_REQUEST')
const bad = {}; await routes['/dsh-feiyu/api/connections/check']({ method: 'POST', body: '{x' }, bad)
assert.equal(bad.code, 400)
r = await call('/dsh-feiyu/api/connections/check', 'GET'); assert.equal(r.code, 405)

// 6. qq check / qrcode / 抖音登录流转
r = await call('/dsh-feiyu/api/connections/check', 'POST', { target: 'qq' }); assert.equal(r.body.result.loggedIn, true)
r = await call('/dsh-feiyu/api/qq/qrcode', 'GET'); assert.equal(r.body.exists, false)
r = await call('/dsh-feiyu/api/douyin/login', 'POST', { action: 'start' }); assert.equal(r.body.state, 'waiting')
r = await call('/dsh-feiyu/api/douyin/login', 'GET'); assert.equal(r.body.state, 'waiting')
r = await call('/dsh-feiyu/api/douyin/login', 'POST', { action: 'cancel' }); assert.equal(r.body.state, 'idle')
r = await call('/dsh-feiyu/api/douyin/login', 'POST', { action: 'x' }); assert.equal(r.code, 400)

// 7. 微信心跳
fs.writeFileSync(wechatBeatPath, JSON.stringify({ ts: t - 5000, state: 'connected' }))
r = await call('/dsh-feiyu/api/connections', 'GET'); assert.equal(r.body.wechat.alive, true)

// 8. 任何响应不含密钥 / 路径
const all = JSON.stringify([await c.snapshot(), await c.check('bilibili')])
assert.ok(!all.includes(SECRET)); assert.ok(!all.includes(tmp))

fs.rmSync(tmp, { recursive: true, force: true })
console.log('connections-test: all passed')
