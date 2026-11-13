/**
 * 连接中心 · 聚合层（契约见 docs/2026-11-12-connection-center-contract.md）。
 * 路由注册集中在 registerConnectionRoutes()，lib/index.js 只需一行调用。
 * 任何响应不含 cookie / token / 绝对路径。
 */
import fs from 'node:fs'
import { createQqConnection } from './connections-qq.js'
import { createDouyinConnection } from './connections-douyin.js'

const BILI_TTL_MS = 5 * 60_000
const WECHAT_ALIVE_MS = 90_000

export function createConnections({
  readConfig, credentialsPath, wechatBeatPath, esp32Status, fetchImpl = fetch, now = Date.now,
  qq, douyin,
} = {}) {
  qq = qq || createQqConnection({ readConfig })
  douyin = douyin || createDouyinConnection({ readConfig })
  let bili = null // { loggedIn, mid, name, checkedAt, error }
  let biliBusy = false
  let qqBusy = false

  function readCred() {
    try {
      const j = JSON.parse(String(fs.readFileSync(credentialsPath, 'utf8')).replace(/^﻿/, ''))
      const c = (v) => String(v ?? '').trim()
      return { sessdata: c(j.sessdata), bili_jct: c(j.bili_jct), buvid3: c(j.buvid3) }
    } catch { return null }
  }

  function biliView() {
    const cred = readCred()
    const configured = !!(cred && cred.sessdata && cred.bili_jct)
    const fresh = bili && now() - bili.checkedAt < BILI_TTL_MS
    if (!configured) return { configured: false, loggedIn: null, mid: '', name: '', checkedAt: 0, error: null }
    return {
      configured,
      loggedIn: fresh ? bili.loggedIn : null,
      mid: fresh ? bili.mid : '',
      name: fresh ? bili.name : '',
      checkedAt: bili?.checkedAt || 0,
      error: fresh ? bili.error : null,
    }
  }

  /** POST /api/cookie 写入成功后调用，刷新缓存（self 形状同 nav 解析结果）。 */
  function noteBiliWrite(self) {
    // nav 失败/超时时 self 为空：无法区分「cookie 无效」与「网络抖动」，清缓存回到未知，交给「重新检测」
    bili = self
      ? { loggedIn: true, mid: String(self.mid || ''), name: String(self.name || ''), checkedAt: now(), error: null }
      : null
  }

  async function checkBili() {
    const cred = readCred()
    if (!cred || !cred.sessdata) return { ok: false, code: 'E_NOT_CONFIGURED', error: '还没有 B站 凭据' }
    if (biliBusy) return { ok: false, code: 'E_BUSY', error: '正在检测，请稍候' }
    biliBusy = true
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 8000)
      let r
      try {
        const res = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', {
          signal: ac.signal,
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` },
        })
        const j = await res.json().catch(() => ({}))
        if (j?.data?.isLogin && j.data.mid) r = { loggedIn: true, mid: String(j.data.mid), name: String(j.data.uname ?? ''), error: null }
        else r = { loggedIn: false, mid: '', name: '', error: `nav: ${j?.code ?? '?'} ${j?.message ?? '未登录'}` }
      } catch (e) {
        if (e?.name === 'AbortError') return { ok: false, code: 'E_TIMEOUT', error: 'nav 超时' }
        r = { loggedIn: null, mid: '', name: '', error: String(e?.message ?? e).slice(0, 120) }
      } finally { clearTimeout(t) }
      bili = { ...r, checkedAt: now() }
      return { ok: true, result: biliView() }
    } finally { biliBusy = false }
  }

  function wechatView() {
    try {
      const b = JSON.parse(fs.readFileSync(wechatBeatPath, 'utf8'))
      const age = Math.max(0, now() - Number(b.ts || 0))
      return { alive: Number.isFinite(age) && age < WECHAT_ALIVE_MS && b.state !== 'stopped', ageSec: Math.round(age / 1000) }
    } catch { return { alive: false, ageSec: null } }
  }

  async function snapshot() {
    const [qqv] = await Promise.all([qq.probe().catch((e) => ({
      gateway: { ok: false, url: '' }, loggedIn: null, uin: '', nickname: '', qr: { exists: false, ageSec: null, expired: false }, error: String(e?.message ?? e).slice(0, 120),
    }))])
    let esp32 = {}
    try { esp32 = (esp32Status && esp32Status()) || {} } catch {}
    return {
      ok: true,
      checkedAt: now(),
      bilibili: biliView(),
      douyin: douyin.probeCheap(),
      qq: qqv,
      wechat: wechatView(),
      esp32,
    }
  }

  async function check(target) {
    if (target === 'bilibili') return { target, ...(await checkBili()) }
    if (target === 'douyin') {
      const r = await douyin.checkReal()
      return { target, ...(r.ok ? { ok: true, result: douyin.probeCheap() } : r) }
    }
    if (target === 'qq') {
      if (qqBusy) return { target, ok: false, code: 'E_BUSY', error: '正在检测，请稍候' }
      qqBusy = true
      try { return { target, ok: true, result: await qq.probe() } } finally { qqBusy = false }
    }
    return { target, ok: false, code: 'E_BAD_REQUEST', error: 'target 只能是 bilibili / douyin / qq' }
  }

  return { snapshot, check, noteBiliWrite, qrcode: () => qq.readQrcode({ withData: true }), douyin, qq, dispose: () => douyin.dispose() }
}

const STATUS = { E_BAD_REQUEST: 400, E_NOT_CONFIGURED: 400, E_BUSY: 409, E_TIMEOUT: 504, E_SPAWN: 500, E_GATEWAY_DOWN: 502 }

export function registerConnectionRoutes({ route, json, readBody, connections }) {
  const parse = async (req) => {
    try { return JSON.parse((await readBody(req)) || '{}') } catch { return null }
  }
  route('/dsh-feiyu/api/connections', async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method', code: 'E_BAD_REQUEST' }); return }
    json(res, 200, await connections.snapshot())
  })
  route('/dsh-feiyu/api/connections/check', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method', code: 'E_BAD_REQUEST' }); return }
    const b = await parse(req)
    if (!b) { json(res, 400, { ok: false, error: '请求体不是合法 JSON', code: 'E_BAD_REQUEST' }); return }
    const out = await connections.check(String(b.target || ''))
    json(res, out.ok ? 200 : (STATUS[out.code] || 500), out)
  })
  route('/dsh-feiyu/api/qq/qrcode', async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method', code: 'E_BAD_REQUEST' }); return }
    json(res, 200, connections.qrcode())
  })
  route('/dsh-feiyu/api/douyin/login', async (req, res) => {
    const d = connections.douyin
    if (req.method === 'GET') { json(res, 200, d.loginStatus()); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method', code: 'E_BAD_REQUEST' }); return }
    const b = await parse(req)
    const action = b && String(b.action || '')
    if (action !== 'start' && action !== 'cancel') { json(res, 400, { ok: false, error: 'action 只能是 start / cancel', code: 'E_BAD_REQUEST' }); return }
    const out = action === 'start' ? await d.loginStart() : await d.loginCancel()
    json(res, out && out.ok === false && out.code ? (STATUS[out.code] || 500) : 200, out)
  })
}
