/**
 * 连接中心 · QQ（NapCat）探测。只导出工厂；所有结果不含 token / 文件路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

export const DEFAULT_NAPCAT_DIR = 'D:/NapCatOld/napcat'
export const DEFAULT_NAPCAT_HTTP = 'http://127.0.0.1:3000'
const QR_MAX_BYTES = 512 * 1024
const QR_EXPIRE_MS = 2 * 60_000

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const s = net.connect({ host, port })
    const fin = (v) => { if (done) return; done = true; try { s.destroy() } catch {} resolve(v) }
    s.setTimeout(timeoutMs, () => fin(false))
    s.once('connect', () => fin(true))
    s.once('error', () => fin(false))
  })
}

export function createQqConnection({ readConfig, now = Date.now, fetchImpl = fetch, fsImpl = fs } = {}) {
  const qqCfg = () => { try { return (readConfig && readConfig().qq) || {} } catch { return {} } }

  function resolveNapcatDir() {
    const d = String(qqCfg().napcat_dir || '').trim()
    return d || DEFAULT_NAPCAT_DIR
  }

  function readQrcode({ withData = true } = {}) {
    const none = { ok: true, exists: false, ageSec: null, expired: false, dataUrl: null }
    try {
      const file = path.join(resolveNapcatDir(), 'cache', 'qrcode.png')
      const st = fsImpl.statSync(file)
      if (!st.isFile() || st.size > QR_MAX_BYTES) return none
      let buf = null
      if (withData) {
        buf = fsImpl.readFileSync(file)
        if (buf.length > QR_MAX_BYTES) return none
      }
      const age = Math.max(0, now() - st.mtimeMs)
      return {
        ok: true,
        exists: true,
        ageSec: Math.round(age / 1000),
        expired: age > QR_EXPIRE_MS,
        dataUrl: buf ? 'data:image/png;base64,' + Buffer.from(buf).toString('base64') : null,
      }
    } catch { return none }
  }

  async function probe({ timeoutMs = 1500 } = {}) {
    const cfg = qqCfg()
    const url = String(cfg.napcat_http || DEFAULT_NAPCAT_HTTP).replace(/\/+$/, '')
    const token = String(cfg.napcat_token || '').trim()
    const q = readQrcode({ withData: false })
    const out = {
      gateway: { ok: false, url },
      loggedIn: null,
      uin: null,
      nickname: '',
      qr: { exists: q.exists, ageSec: q.ageSec, expired: q.expired },
      error: null,
    }
    let host = '127.0.0.1'
    let port = 3000
    try {
      const u = new URL(url)
      host = u.hostname || host
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    } catch {}
    const open = await tcpOpen(host, port, timeoutMs)
    if (!open) { out.error = '网关未监听'; return out }
    out.gateway.ok = true
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = 'Bearer ' + token
      const r = await fetchImpl(url + '/get_login_info', { method: 'POST', headers, body: '{}', signal: ac.signal })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j || (j.retcode != null && j.retcode !== 0) || j.status === 'failed') {
        out.loggedIn = false
        out.error = !r.ok ? 'HTTP ' + r.status : '网关返回错误 retcode=' + (j && j.retcode)
      } else {
        const d = j.data || {}
        const uin = d.user_id != null ? String(d.user_id) : ''
        out.loggedIn = !!uin
        out.uin = uin || null
        out.nickname = String(d.nickname || '')
      }
    } catch (e) {
      out.error = e && e.name === 'AbortError' ? '查询超时' : '查询失败'
    } finally {
      clearTimeout(timer)
    }
    return out
  }

  return { resolveNapcatDir, readQrcode: (o) => readQrcode(o), probe }
}
