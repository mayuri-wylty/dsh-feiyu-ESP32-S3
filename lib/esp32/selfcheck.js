// ESP32 通道「网关连通性自检」：gateway / token / ota / ws 四项，顺序固定。
//
// 纯函数 + 依赖注入（status / token / fetch / WebSocket），便于测试。
// 探测只打本机回环：OTA 一次带 Bearer 的 POST，WS 只做握手（不发 hello）。
// 网关在收到 hello 之后才校验白名单并创建会话，所以探测连接既不会被白名单拒绝，
// 也不会进入 host 的在线设备列表；握手成功后立即 close。
// 安全：token 只在本进程内用于请求头，不进入返回值/日志；错误文本统一过 sanitizeError。
import { WebSocket as DefaultWebSocket } from 'ws'
import { OTA_PATH, WS_PATH } from './contracts.js'
import { WS_CLOSE } from './gateway.js'
import { sanitizeError } from './host.js'

export const SELFCHECK_DEVICE_ID = 'selfcheck'
const DEFAULT_TIMEOUT_MS = 3000
const LOOPBACK = '127.0.0.1'
const SKIPPED = '跳过'

const brief = (text) => String(text).slice(0, 80)

function failText(prefix, error, token) {
  return brief(`${prefix}：${sanitizeError(error, token)}`)
}

async function probeOta({ port, token, fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetchImpl(`http://${LOOPBACK}:${port}${OTA_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: controller.signal,
    })
    if (!res || !res.ok) return { ok: false, detail: `OTA 返回 HTTP ${res?.status ?? '?'}` }
    let body
    try { body = await res.json() } catch { return { ok: false, detail: 'OTA 响应不是合法 JSON' } }
    if (typeof body?.websocket?.url !== 'string' || !body.websocket.url) {
      return { ok: false, detail: 'OTA 响应缺少 websocket 地址' }
    }
    return { ok: true, detail: 'OTA 响应正常' }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return { ok: false, detail: 'OTA 请求超时' }
    return { ok: false, detail: failText('OTA 请求失败', error, token) }
  } finally {
    clearTimeout(timer)
  }
}

function probeWs({ port, token, WebSocketImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false
    let opened = false
    let ws = null
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws?.terminate?.() } catch { /* 探测连接清理失败忽略 */ }
      resolve(result)
    }
    const allowedNote = { ok: true, detail: '探测设备被白名单拒绝（正常）' }
    try {
      ws = new WebSocketImpl(`ws://${LOOPBACK}:${port}${WS_PATH}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Device-Id': SELFCHECK_DEVICE_ID,
          'Client-Id': SELFCHECK_DEVICE_ID,
        },
        handshakeTimeout: timeoutMs,
      })
    } catch (error) {
      resolve({ ok: false, detail: failText('WS 连接失败', error, token) })
      return
    }
    timer = setTimeout(() => {
      finish(opened ? { ok: true, detail: 'WS 握手正常' } : { ok: false, detail: 'WS 握手超时' })
    }, timeoutMs)
    timer.unref?.()
    ws.on('open', () => {
      opened = true
      // 不发 hello：网关不会创建会话；立即关闭，等 close 事件（拿到可能的 4003）后收尾。
      try { ws.close(WS_CLOSE.NORMAL, 'selfcheck') } catch { finish({ ok: true, detail: 'WS 握手正常' }) }
    })
    ws.on('unexpected-response', (_req, res) => {
      const status = res?.statusCode
      try { res?.resume?.() } catch { /* ignore */ }
      finish({ ok: false, detail: status === 401 ? 'WS 鉴权失败（token 不匹配）' : `WS 握手被拒绝（HTTP ${status ?? '?'}）` })
    })
    ws.on('close', (code) => {
      if (code === WS_CLOSE.DEVICE_NOT_ALLOWED) { finish(allowedNote); return }
      finish(opened ? { ok: true, detail: 'WS 握手正常' } : { ok: false, detail: 'WS 连接被关闭' })
    })
    ws.on('error', (error) => {
      if (opened) return
      finish({ ok: false, detail: failText('WS 连接失败', error, token) })
    })
  })
}

/**
 * @param {object} deps
 * @param {() => object} deps.getStatus host.status()
 * @param {() => string} deps.getToken 读取配置里的 token（仅用于探测请求头）
 * @param {Function} [deps.fetchImpl] 默认 globalThis.fetch
 * @param {Function} [deps.WebSocketImpl] 默认 ws 包的 WebSocket
 * @param {number} [deps.timeoutMs] 单项探测超时，默认 3000
 * @returns {() => Promise<{ok:boolean, checks:Array<{id:string, ok:boolean, detail?:string}>}>}
 */
export function createSelfcheck(deps = {}) {
  const { getStatus, getToken } = deps
  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const WebSocketImpl = deps.WebSocketImpl ?? DefaultWebSocket
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(deps.timeoutMs, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS

  return async function runSelfcheck() {
    const status = getStatus() ?? {}
    const port = Number(status.address?.port)
    const listening = status.enabled === true && status.running === true && Number.isFinite(port) && port > 0
    const token = String(getToken?.() ?? '')

    const gateway = listening
      ? { id: 'gateway', ok: true, detail: `网关监听中（端口 ${port}）` }
      : { id: 'gateway', ok: false, detail: '网关未启动' }
    const tokenCheck = status.tokenSet === true
      ? { id: 'token', ok: true, detail: '已配置 token' }
      : { id: 'token', ok: false, detail: '未配置 token' }

    let ota = { ok: false, detail: SKIPPED }
    let ws = { ok: false, detail: SKIPPED }
    if (listening) {
      ota = await probeOta({ port, token, fetchImpl, timeoutMs })
      ws = token
        ? await probeWs({ port, token, WebSocketImpl, timeoutMs })
        : { ok: false, detail: SKIPPED }
    }

    const checks = [gateway, { id: 'ota', ...ota }, { id: 'ws', ...ws }, tokenCheck]
    return { ok: checks.every((c) => c.ok), checks }
  }
}
