// 连接中心 · 抖音（契约 docs/2026-11-12-connection-center-contract.md §1/§2/§4）
// 只做抖音：扫码登录会话、廉价探测、真实 self-info 检测。绝不在返回值里放 cookie 值/绝对路径。
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOGIN_TIMEOUT_MS = 180000
const DEFAULT_PY = 'D:/social-auto-upload/.venv/Scripts/python.exe'
const DEFAULT_SCRIPT = 'D:/social-auto-upload/douyin_interact.py'
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function createDouyinConnection({
  readConfig,
  spawnImpl = childProcess.spawn,
  now = Date.now,
  fsImpl = fs,
  cookiePath,
  homedir,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
} = {}) {
  const home = homedir || os.homedir()
  const dc = () => { try { return ((readConfig && readConfig()) || {}).douyin || {} } catch { return {} } }
  const cookieFile = () => cookiePath || dc().cookie || path.join(home, '.feiyu-ai', 'douyin-cookies.json')
  const pyPath = () => dc().python || DEFAULT_PY
  const scriptPath = () => dc().script || DEFAULT_SCRIPT

  const children = new Set()
  let session = { state: 'idle', startedAt: 0, error: null }
  let loginChild = null
  let loginTimer = null
  let checking = false
  let cache = { nickname: '', secUid: '', checkedAt: 0, error: null }

  function env() {
    const e = { ...process.env, PYTHONIOENCODING: 'utf-8' }
    if (!e.PLAYWRIGHT_BROWSERS_PATH) {
      const b = path.join(PLUGIN_ROOT, 'deps', 'douyin', 'browsers')
      try { if (fsImpl.existsSync(b)) e.PLAYWRIGHT_BROWSERS_PATH = b } catch {}
    }
    return e
  }

  function killTree(child) {
    if (!child) return
    try {
      if (process.platform === 'win32' && child.pid) {
        const k = spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
        try { k && k.on && k.on('error', () => {}) } catch {}
      }
    } catch {}
    try { child.kill() } catch {}
  }

  // 读 cookie 文件：只返回结构化摘要，不含值
  function readCookies() {
    const f = cookieFile()
    let raw
    let st
    try {
      st = fsImpl.statSync(f)
      raw = fsImpl.readFileSync(f, 'utf8')
    } catch { return { exists: false, loggedIn: false, ageSec: null } }
    let arr = []
    try { const j = JSON.parse(raw); arr = Array.isArray(j) ? j : [] } catch {}
    const t = now()
    const alive = arr.some((c) => {
      if (!c || !(c.name === 'sessionid' || c.name === 'sessionid_ss') || !c.value) return false
      const exp = Number(c.expires)
      return !(Number.isFinite(exp) && exp > 0 && exp * 1000 <= t)
    })
    return { exists: true, loggedIn: alive, ageSec: Math.max(0, Math.round((t - st.mtimeMs) / 1000)) }
  }

  function loginStatus() {
    const s = session
    const remaining = s.state === 'waiting' ? Math.max(0, Math.ceil((s.startedAt + loginTimeoutMs - now()) / 1000)) : 0
    const out = { ok: true, state: s.state, startedAt: s.startedAt, remainingSec: remaining }
    if (s.state === 'error' && s.error) out.error = s.error
    return out
  }

  function finish(state, error) {
    if (loginTimer) { clearTimeout(loginTimer); loginTimer = null }
    session = { ...session, state, error: error || null }
    loginChild = null
  }

  function loginStart() {
    if (session.state === 'waiting') return loginStatus()
    const args = [scriptPath(), 'login', '--cookie', cookieFile()]
    let mtime0 = 0
    try { mtime0 = fsImpl.statSync(cookieFile()).mtimeMs } catch {}
    let child
    try {
      child = spawnImpl(pyPath(), args, { windowsHide: false, env: env(), stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      session = { state: 'error', startedAt: now(), error: '无法启动抖音登录脚本，请检查 Python 路径配置' }
      return loginStatus()
    }
    session = { state: 'waiting', startedAt: now(), error: null }
    loginChild = child
    children.add(child)
    let done = false
    const settle = (code, spawnErr) => {
      if (done) return
      done = true
      children.delete(child)
      if (loginChild !== child) return // 已被 cancel/timeout 处理
      if (spawnErr) return finish('error', '无法启动抖音登录脚本，请检查 Python 路径配置')
      let fresh = true
      try { fresh = fsImpl.statSync(cookieFile()).mtimeMs > mtime0 } catch { fresh = false }
      if (fresh && readCookies().loggedIn) return finish('ok')
      finish('error', code === 0 ? '登录窗口已关闭，未检测到登录凭据' : `登录脚本异常退出（${code ?? '?'}）`)
    }
    child.on('error', () => settle(null, true))
    child.on('exit', (code) => settle(code))
    loginTimer = setTimeout(() => {
      if (loginChild !== child) return
      done = true
      children.delete(child)
      finish('timeout')
      killTree(child)
    }, loginTimeoutMs)
    if (loginTimer.unref) loginTimer.unref()
    return loginStatus()
  }

  function loginCancel() {
    if (session.state === 'waiting' && loginChild) {
      const c = loginChild
      children.delete(c)
      finish('idle')
      killTree(c)
    }
    return loginStatus()
  }

  function probeCheap() {
    const c = readCookies()
    return {
      configured: c.exists,
      loggedIn: c.loggedIn,
      nickname: cache.nickname,
      secUid: cache.secUid,
      cookieAgeSec: c.ageSec,
      checkedAt: cache.checkedAt,
      error: cache.error,
      login: { state: session.state, ...(session.state === 'waiting' ? { remainingSec: loginStatus().remainingSec } : {}) },
    }
  }

  function checkReal({ timeoutMs = 40000 } = {}) {
    if (checking) return Promise.resolve({ ok: false, code: 'E_BUSY', error: '检测正在进行中' })
    checking = true
    return new Promise((resolve) => {
      let child
      let out = ''
      let settled = false
      let timer = null
      const done = (r) => {
        if (settled) return
        settled = true
        checking = false
        if (timer) clearTimeout(timer)
        if (child) children.delete(child)
        resolve(r)
      }
      try {
        child = spawnImpl(pyPath(), [scriptPath(), 'self-info', '--cookie', cookieFile(), '--out', '-'],
          { windowsHide: true, env: env(), stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return done({ ok: false, code: 'E_SPAWN', error: '无法启动抖音脚本' })
      }
      children.add(child)
      if (child.stdout && child.stdout.on) child.stdout.on('data', (d) => { if (out.length < 200000) out += String(d) })
      timer = setTimeout(() => {
        killTree(child)
        done({ ok: false, code: 'E_TIMEOUT', error: '抖音检测超时' })
      }, timeoutMs)
      child.on('error', () => done({ ok: false, code: 'E_SPAWN', error: '无法启动抖音脚本' }))
      child.on('close', () => {
        let j = null
        const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
        for (const l of lines.reverse()) { try { j = JSON.parse(l); break } catch {} }
        if (j && j.ok && j.sec_uid) {
          cache = { nickname: String(j.nickname || ''), secUid: String(j.sec_uid), checkedAt: now(), error: null }
        } else {
          cache = { ...cache, checkedAt: now(), error: '未读到账号信息，cookie 可能已失效' }
        }
        done({ ok: true, result: probeCheap() })
      })
    })
  }

  function dispose() {
    if (loginTimer) { clearTimeout(loginTimer); loginTimer = null }
    for (const c of [...children]) killTree(c)
    children.clear()
    loginChild = null
    if (session.state === 'waiting') session = { ...session, state: 'idle' }
  }

  return { loginStart, loginCancel, loginStatus, probeCheap, checkReal, dispose }
}
