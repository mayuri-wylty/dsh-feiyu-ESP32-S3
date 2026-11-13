import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDouyinConnection } from '../lib/connections-douyin.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-conn-'))
const cookieFile = path.join(tmp, 'douyin-cookies.json')
const SECRET = 'SECRET_SESSION_VALUE_123'
const cfg = { douyin: { python: 'py.exe', script: 'dy.py' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function writeCookie(arr) { fs.writeFileSync(cookieFile, JSON.stringify(arr)) }
const goodCookie = (exp) => [{ name: 'sessionid', value: SECRET, expires: exp }, { name: 'x', value: 'y' }]

function makeSpawn() {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const c = new EventEmitter()
    c.pid = 1000 + calls.length
    c.stdout = new EventEmitter()
    c.killed = false
    c.kill = () => { c.killed = true }
    c.cmd = cmd; c.args = args; c.opts = opts
    calls.push(c)
    return c
  }
  spawn.calls = calls
  spawn.main = () => calls.filter((c) => c.cmd !== 'taskkill')
  return spawn
}
const mk = (spawn, extra = {}) => createDouyinConnection({ readConfig: () => cfg, spawnImpl: spawn, cookiePath: cookieFile, homedir: tmp, ...extra })

// probeCheap
{
  const d = mk(makeSpawn())
  let p = d.probeCheap()
  assert.equal(p.configured, false); assert.equal(p.loggedIn, false); assert.equal(p.cookieAgeSec, null)
  writeCookie([{ name: 'other', value: 'a' }])
  p = d.probeCheap(); assert.equal(p.configured, true); assert.equal(p.loggedIn, false)
  writeCookie(goodCookie(Math.floor(Date.now() / 1000) - 100))
  assert.equal(d.probeCheap().loggedIn, false, 'expired')
  writeCookie(goodCookie(Math.floor(Date.now() / 1000) + 9999))
  p = d.probeCheap(); assert.equal(p.loggedIn, true); assert.ok(p.cookieAgeSec >= 0)
  assert.equal(p.login.state, 'idle')
  assert.ok(!JSON.stringify(p).includes(SECRET))
  d.dispose()
}

// login ok + idempotent start
{
  fs.rmSync(cookieFile, { force: true })
  const sp = makeSpawn(); const d = mk(sp)
  const s1 = d.loginStart(); assert.equal(s1.state, 'waiting'); assert.ok(s1.remainingSec > 170)
  const s2 = d.loginStart(); assert.equal(s2.state, 'waiting')
  assert.equal(sp.main().length, 1, 'idempotent')
  const c = sp.main()[0]
  assert.deepEqual(c.args, ['dy.py', 'login', '--cookie', cookieFile]); assert.equal(c.opts.windowsHide, false)
  writeCookie(goodCookie(Math.floor(Date.now() / 1000) + 9999))
  c.emit('exit', 0)
  const st = d.loginStatus(); assert.equal(st.state, 'ok')
  assert.equal(d.loginStatus().state, 'ok', 'stays ok')
  assert.ok(!JSON.stringify([st, d.probeCheap()]).includes(SECRET))
  d.loginStart(); assert.equal(sp.main().length, 2, 'new session after ok')
  d.dispose()
}

// login error: exit without cookie
{
  fs.rmSync(cookieFile, { force: true })
  const sp = makeSpawn(); const d = mk(sp)
  d.loginStart(); sp.main()[0].emit('exit', 3)
  const st = d.loginStatus(); assert.equal(st.state, 'error'); assert.ok(st.error && !st.error.includes(tmp))
  d.dispose()
}

// login spawn error event
{
  const sp = makeSpawn(); const d = mk(sp)
  d.loginStart(); sp.main()[0].emit('error', new Error('ENOENT ' + tmp))
  const st = d.loginStatus(); assert.equal(st.state, 'error'); assert.ok(!st.error.includes(tmp))
  d.dispose()
}

// login timeout kills
{
  fs.rmSync(cookieFile, { force: true })
  const sp = makeSpawn(); const d = mk(sp, { loginTimeoutMs: 40 })
  d.loginStart(); await sleep(120)
  assert.equal(d.loginStatus().state, 'timeout')
  assert.ok(sp.main()[0].killed)
  if (process.platform === 'win32') assert.ok(sp.calls.some((c) => c.cmd === 'taskkill' && c.args.includes('/T') && c.args.includes('/F')))
  d.dispose()
}

// cancel
{
  const sp = makeSpawn(); const d = mk(sp)
  d.loginStart(); const st = d.loginCancel()
  assert.equal(st.state, 'idle'); assert.ok(sp.main()[0].killed)
  sp.main()[0].emit('exit', 1)
  assert.equal(d.loginStatus().state, 'idle', 'late exit ignored')
  d.dispose()
}

// dispose kills
{
  const sp = makeSpawn(); const d = mk(sp)
  d.loginStart(); d.dispose()
  assert.ok(sp.main()[0].killed)
}

// checkReal success + busy
{
  writeCookie(goodCookie(Math.floor(Date.now() / 1000) + 9999))
  const sp = makeSpawn(); const d = mk(sp)
  const p1 = d.checkReal()
  const busy = await d.checkReal(); assert.equal(busy.code, 'E_BUSY'); assert.equal(busy.ok, false)
  const c = sp.main()[0]
  assert.deepEqual(c.args, ['dy.py', 'self-info', '--cookie', cookieFile, '--out', '-'])
  c.stdout.emit('data', '[self-info] log line\n' + JSON.stringify({ ok: true, nickname: '昵称', sec_uid: 'MS4w', uid: '1' }) + '\n')
  c.emit('exit', 0)
  const r = await p1
  assert.equal(r.ok, true); assert.equal(r.result.nickname, '昵称'); assert.equal(r.result.secUid, 'MS4w'); assert.equal(r.result.error, null)
  assert.ok(r.result.checkedAt > 0)
  assert.equal(d.probeCheap().nickname, '昵称', 'cached')
  assert.ok(!JSON.stringify(r).includes(SECRET))
  // not busy anymore; failure path keeps no crash
  const p2 = d.checkReal(); sp.main()[1].stdout.emit('data', '{"ok": false}\n'); sp.main()[1].emit('exit', 1)
  const r2 = await p2; assert.equal(r2.ok, true); assert.ok(r2.result.error)
  d.dispose()
}

// checkReal timeout + spawn failure
{
  const sp = makeSpawn(); const d = mk(sp)
  const r = await d.checkReal({ timeoutMs: 40 })
  assert.equal(r.ok, false); assert.equal(r.code, 'E_TIMEOUT'); assert.ok(sp.main()[0].killed)
  const d2 = mk(() => { throw new Error('boom') })
  assert.equal((await d2.checkReal()).code, 'E_SPAWN')
  const sp3 = makeSpawn(); const d3 = mk(sp3)
  const p = d3.checkReal(); sp3.main()[0].emit('error', new Error('x'))
  assert.equal((await p).code, 'E_SPAWN')
  d.dispose(); d2.dispose(); d3.dispose()
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('connections-douyin-test: all passed')
