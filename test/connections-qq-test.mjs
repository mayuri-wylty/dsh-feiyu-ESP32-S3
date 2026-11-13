/**
 * 连接中心 · QQ 探测测试（临时目录 + 假 fetch + 本地临时端口，不碰真 NapCat）。
 * 跑法：node test/connections-qq-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createQqConnection } from '../lib/connections-qq.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-connqq-'))
const cacheDir = path.join(tmp, 'cache')
fs.mkdirSync(cacheDir)
const qrFile = path.join(cacheDir, 'qrcode.png')

// 本地临时端口：开着的 server 代表「网关在监听」
const srv = net.createServer((s) => s.destroy())
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const openPort = srv.address().port
const closedPort = await new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)) }) })

const mk = (qq, extra = {}) => createQqConnection({ readConfig: () => ({ qq }), ...extra })

// 1) 目录解析
assert.equal(createQqConnection({ readConfig: () => ({}) }).resolveNapcatDir(), 'D:/NapCatOld/napcat')
assert.equal(createQqConnection({ readConfig: () => { throw new Error('x') } }).resolveNapcatDir(), 'D:/NapCatOld/napcat')
assert.equal(mk({ napcat_dir: '  ' }).resolveNapcatDir(), 'D:/NapCatOld/napcat')
assert.equal(mk({ napcat_dir: tmp }).resolveNapcatDir(), tmp)

// 2) 二维码：缺失
const conn = mk({ napcat_dir: tmp })
let q = conn.readQrcode()
assert.deepEqual(q, { ok: true, exists: false, ageSec: null, expired: false, dataUrl: null })

// 正常
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
fs.writeFileSync(qrFile, png)
const mtime = fs.statSync(qrFile).mtimeMs
let clock = mtime + 20_000
const c2 = mk({ napcat_dir: tmp }, { now: () => clock })
q = c2.readQrcode()
assert.equal(q.exists, true)
assert.equal(q.expired, false)
assert.equal(q.ageSec, 20)
assert.equal(q.dataUrl, 'data:image/png;base64,' + png.toString('base64'))
assert.ok(!JSON.stringify(q).includes(tmp), '不得返回路径')

// 过期
clock = mtime + 121_000
q = c2.readQrcode()
assert.equal(q.exists, true)
assert.equal(q.expired, true)

// 超大
fs.writeFileSync(qrFile, Buffer.alloc(512 * 1024 + 1))
q = c2.readQrcode()
assert.equal(q.exists, false)
assert.equal(q.dataUrl, null)
fs.writeFileSync(qrFile, png)

// 3) probe：端口关
let called = 0
const never = async () => { called++; throw new Error('should not call') }
let p = await mk({ napcat_http: `http://127.0.0.1:${closedPort}` }, { fetchImpl: never }).probe({ timeoutMs: 500 })
assert.equal(p.gateway.ok, false)
assert.equal(p.loggedIn, null)
assert.equal(called, 0)
assert.ok(p.error)

// token 带头 + 正常返回
let seen = null
const okFetch = async (url, init) => {
  seen = { url, init }
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 1523578516, nickname: 'bot' } }) }
}
const cfg = { napcat_http: `http://127.0.0.1:${openPort}/`, napcat_token: 'SECRET-TOKEN', napcat_dir: tmp }
p = await mk(cfg, { fetchImpl: okFetch }).probe()
assert.equal(seen.url, `http://127.0.0.1:${openPort}/get_login_info`)
assert.equal(seen.init.method, 'POST')
assert.equal(seen.init.headers.Authorization, 'Bearer SECRET-TOKEN')
assert.equal(p.gateway.ok, true)
assert.equal(p.loggedIn, true)
assert.equal(p.uin, '1523578516')
assert.equal(p.nickname, 'bot')
assert.equal(p.qr.exists, true)
const dump = JSON.stringify(p)
assert.ok(!dump.includes('SECRET-TOKEN'), '结果不得含 token')
assert.ok(!dump.includes(tmp) && !dump.includes('dataUrl'), '结果不得含路径/二维码数据')

// 无 token 不带头
await mk({ napcat_http: cfg.napcat_http }, { fetchImpl: okFetch }).probe()
assert.equal(seen.init.headers.Authorization, undefined)

// retcode != 0
p = await mk(cfg, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1403 }) }) }).probe()
assert.equal(p.gateway.ok, true)
assert.equal(p.loggedIn, false)
assert.ok(p.error.includes('1403'))
assert.ok(!JSON.stringify(p).includes('SECRET-TOKEN'))

// 超时（fetch 听 abort 信号）
const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
const t0 = Date.now()
p = await mk(cfg, { fetchImpl: hang }).probe({ timeoutMs: 200 })
assert.ok(Date.now() - t0 < 1500)
assert.equal(p.gateway.ok, true)
assert.equal(p.loggedIn, null)
assert.equal(p.error, '查询超时')

// 抛错信息不得泄露 token
p = await mk(cfg, { fetchImpl: async () => { throw new Error('boom SECRET-TOKEN') } }).probe()
assert.ok(!JSON.stringify(p).includes('SECRET-TOKEN'))
assert.equal(p.loggedIn, null)

srv.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('connections-qq-test: all passed')
