// T12：小智 ESP32 网关（OTA + WebSocket v1）
//
// 职责（契约见 lib/esp32/contracts.js）：
// - HTTP：GET/POST /xiaozhi/ota/（兼容无尾斜杠），返回固件可解析的 OTA JSON；
//   不含 mqtt/activation，token 放在 websocket.token（固件会写入 NVS）。
// - WS：/xiaozhi/v1/ upgrade，Authorization: Bearer <token> 必填且 timing-safe 比较；
//   10 秒内未收到 hello 关闭连接；mcp 等未知消息忽略且不报错；非法 JSON 只关当前连接。
// - token：配置为空时生成 ≥16 字节随机 token，经 saveEsp32Config({ esp32: { token } }) 写回；
//   token 绝不写入日志，HTTP 错误响应不回显 token。
// - publicHost：按 docs/spikes.md §A3 选网卡（见 ./gateway/public-host.js），显式配置优先。
// - 生命周期：start()/stop() 幂等；端口占用给出明确错误；stop() 释放端口并关闭全部连接。
//
// T13 会话状态机通过 options.createSession 注入：
//   createSession({ deviceId, clientId, sessionId, remoteAddress, sendJson, sendBinary, close, hello })
// 会话对象可实现 handleJson(json) / handleAudio(buffer) / abort(reason) / close()。
import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import {
  AUDIO,
  DEFAULT_PORT,
  HELLO_TIMEOUT_MS,
  OTA_PATH,
  WS_PATH,
  mergeEsp32Config,
} from './contracts.js'
import { config, saveEsp32Config } from '../../tools/lib/config.mjs'
import { collectWindowsNetworkInfo, selectPublicHost } from './gateway/public-host.js'

export const WS_CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  INVALID_JSON: 1007,
  SESSION_ERROR: 1011,
  HELLO_TIMEOUT: 4000,
  DEVICE_NOT_ALLOWED: 4003,
})

const OTA_PATH_COMPAT = OTA_PATH.replace(/\/$/, '')
const WS_PATH_COMPAT = WS_PATH.replace(/\/$/, '')
const STATUS_TEXT = Object.freeze({ 401: 'Unauthorized', 404: 'Not Found' })
const MAX_HTTP_BODY_BYTES = 64 * 1024
const MAX_WS_PAYLOAD_BYTES = 1 * 1024 * 1024

function isOtaPath(pathname) {
  return pathname === OTA_PATH || pathname === OTA_PATH_COMPAT
}

function isWsPath(pathname) {
  return pathname === WS_PATH || pathname === WS_PATH_COMPAT
}

function normalizeLogger(logger) {
  const noop = () => {}
  if (!logger) {
    return {
      debug: noop,
      info: (...args) => console.log('[esp32-gateway]', ...args),
      warn: (...args) => console.warn('[esp32-gateway]', ...args),
      error: (...args) => console.error('[esp32-gateway]', ...args),
    }
  }
  const pick = (name, fallback = noop) => (typeof logger[name] === 'function'
    ? logger[name].bind(logger)
    : fallback)
  return {
    debug: pick('debug'),
    info: pick('info'),
    warn: pick('warn'),
    error: pick('error'),
  }
}

function headerString(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : ''
  return value == null ? '' : String(value)
}

/**
 * 校验 Authorization: Bearer <token>。
 * 先比较长度（长度不等直接拒绝），再用 crypto.timingSafeEqual 定长比较。
 */
export function verifyBearerToken(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || token.length === 0) return false
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match) return false
  const provided = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}

function sendJsonResponse(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function readJsonBody(req, limit = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0
    let done = false
    const chunks = []
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        req.removeAllListeners('data')
        req.resume()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
      if (!raw.trim()) return finish(null)
      try {
        finish(JSON.parse(raw))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  const body = `${message}\n`
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
    '',
    body,
  ]
  try {
    socket.end(lines.join('\r\n'))
  } catch {
    try { socket.destroy() } catch {}
  }
}

/**
 * 创建 ESP32 网关。
 * @param {object} [options]
 * @param {string} [options.host='0.0.0.0'] 监听地址（测试用 127.0.0.1）
 * @param {number} [options.port] 监听端口，默认 config().esp32.port
 * @param {object} [options.esp32] 覆盖 esp32 配置（测试注入，避免读真实配置）
 * @param {Function} [options.getConfig] 返回完整配置，默认 tools/lib/config.mjs 的 config()
 * @param {Function} [options.saveConfig] token 写回函数，默认 saveEsp32Config
 * @param {object} [options.logger] { debug, info, warn, error }
 * @param {object} [options.interfaces] 覆盖 os.networkInterfaces()（测试）
 * @param {object[]} [options.routes] 覆盖 Windows 默认路由（测试）
 * @param {Record<string, number>} [options.addressIndexes] 覆盖 IP → InterfaceIndex（测试）
 * @param {number} [options.helloTimeoutMs] hello 超时，默认 HELLO_TIMEOUT_MS
 * @param {Function} [options.createSession] 会话工厂（T13 注入）
 * @param {Function} [options.now] 时间源，默认 Date.now
 * @returns {{ start: Function, stop: Function, address: Function, publicHost: Function, publicHostInfo: Function }}
 */
export function createGateway(options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : config
  const saveConfig = typeof options.saveConfig === 'function' ? options.saveConfig : saveEsp32Config
  const logger = normalizeLogger(options.logger)
  const host = options.host ?? '0.0.0.0'
  const esp32 = mergeEsp32Config(options.esp32 ?? (getConfig()?.esp32 ?? {}))
  const portValue = options.port != null ? Number(options.port) : Number(esp32.port)
  const port = Number.isFinite(portValue) ? portValue : DEFAULT_PORT
  const helloTimeoutMs = Number.isFinite(Number(options.helloTimeoutMs))
    ? Number(options.helloTimeoutMs)
    : HELLO_TIMEOUT_MS
  const createSession = typeof options.createSession === 'function' ? options.createSession : null
  const now = typeof options.now === 'function' ? options.now : Date.now

  let server = null
  let wss = null
  let startPromise = null
  let stopPromise = null
  let hostSelection = null
  const connections = new Map()
  const sockets = new Set()

  async function ensureToken() {
    if (esp32.token) return false
    const token = crypto.randomBytes(24).toString('hex')
    // 先更新内存，保证即使写回失败，本次运行 OTA/WS 也使用同一个 token。
    esp32.token = token
    try {
      await saveConfig({ esp32: { token } })
    } catch (error) {
      // 注意：错误信息里不能带 token。
      logger.error('esp32 token 写回配置失败（本次运行使用内存 token）：', error?.message ?? String(error))
    }
    return true
  }

  async function resolveHostSelection() {
    const interfaces = options.interfaces ?? os.networkInterfaces()
    const explicit = String(esp32.publicHost ?? '').trim()
    if (explicit) {
      return selectPublicHost({ interfaces, routes: [], addressIndexes: {}, override: explicit })
    }

    let routes = options.routes
    let addressIndexes = options.addressIndexes
    if (routes == null) {
      const info = await collectWindowsNetworkInfo()
      routes = info.routes
      addressIndexes = info.addressIndexes
      if (info.error) {
        logger.warn('读取 Windows 默认路由失败，按 RFC1918 规则兜底：', info.error)
      }
    }
    return selectPublicHost({
      interfaces,
      routes: routes ?? [],
      addressIndexes: addressIndexes ?? {},
      override: '',
    })
  }

  function address() {
    const info = server?.address()
    return info && typeof info === 'object' ? info : null
  }

  function publicHost() {
    if (hostSelection?.address) return hostSelection.address
    const explicit = String(esp32.publicHost ?? '').trim()
    return explicit || null
  }

  function publicHostInfo() {
    if (hostSelection) return { ...hostSelection }
    const explicit = String(esp32.publicHost ?? '').trim()
    return explicit
      ? { address: explicit, interfaceName: null, method: 'explicit', route: null, candidates: [], eligibleAddresses: [], defaultRoutes: [] }
      : null
  }

  function listenError(cause) {
    const code = cause?.code || 'ERROR'
    const detail = code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请关闭占用该端口的程序或修改 esp32.port`
      : (cause?.message ?? String(cause))
    const error = new Error(`esp32 gateway 无法监听 ${host}:${port}（${code}）：${detail}`)
    error.code = code
    error.cause = cause
    return error
  }

  function handleOta(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      sendJsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return Promise.resolve()
    }
    return (async () => {
      let deviceVersion = ''
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const version = body?.application?.version
        if (typeof version === 'string') deviceVersion = version
      }
      const bound = address()
      const boundPort = bound ? bound.port : port
      const otaHost = publicHost() || '127.0.0.1'
      sendJsonResponse(res, 200, {
        firmware: {
          // 首版不做 OTA 升级：url 为空字符串，force=0，固件不会触发下载。
          version: deviceVersion || '0.0.0',
          force: 0,
          url: '',
        },
        websocket: {
          url: `ws://${otaHost}:${boundPort}${WS_PATH}`,
          token: esp32.token,
        },
        server_time: {
          timestamp: now(),
          timezone_offset: -new Date().getTimezoneOffset(),
        },
      })
    })()
  }

  function handleRequest(req, res) {
    try {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      if (isOtaPath(pathname)) {
        handleOta(req, res).catch((error) => {
          logger.error('处理 OTA 请求失败：', error?.message ?? String(error))
          try { sendJsonResponse(res, 500, { ok: false, error: 'internal error' }) } catch {}
        })
        return
      }
      sendJsonResponse(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      logger.error('处理 HTTP 请求失败：', error?.message ?? String(error))
      try { sendJsonResponse(res, 500, { ok: false, error: 'internal error' }) } catch {}
    }
  }

  function handleUpgrade(req, socket, head) {
    try {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      if (!isWsPath(pathname)) {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }
      if (!verifyBearerToken(req.headers?.authorization, esp32.token)) {
        logger.warn('WS upgrade 拒绝：Bearer token 缺失或不匹配', { remote: socket.remoteAddress })
        rejectUpgrade(socket, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } catch (error) {
      logger.error('WS upgrade 处理失败：', error?.message ?? String(error))
      try { socket.destroy() } catch {}
    }
  }

  function sendJsonToConn(conn, obj) {
    const { ws } = conn
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch (error) {
      logger.warn('向设备发送 JSON 失败：', { deviceId: conn.deviceId, error: error?.message ?? String(error) })
      return false
    }
  }

  function sendBinaryToConn(conn, buffer) {
    const { ws } = conn
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(buffer, { binary: true })
      return true
    } catch (error) {
      logger.warn('向设备发送音频失败：', { deviceId: conn.deviceId, error: error?.message ?? String(error) })
      return false
    }
  }

  function closeConn(conn, code = WS_CLOSE.NORMAL, reason = '') {
    if (conn.closed) return
    conn.closed = true
    clearTimeout(conn.helloTimer)
    try {
      conn.ws.close(code, reason)
    } catch {
      try { conn.ws.terminate() } catch {}
    }
  }

  function callSession(conn, method, arg) {
    const fn = conn.session?.[method]
    if (typeof fn !== 'function') return
    try {
      fn.call(conn.session, arg)
    } catch (error) {
      logger.error('设备会话处理异常，关闭该连接：', {
        deviceId: conn.deviceId,
        method,
        error: error?.message ?? String(error),
      })
      closeConn(conn, WS_CLOSE.SESSION_ERROR, 'session error')
    }
  }

  function normalizeAllowedDevices(value) {
    if (!Array.isArray(value)) return []
    return value
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter(Boolean)
  }

  function handleHello(conn, json) {
    if (conn.helloReceived) {
      logger.debug('重复 hello，忽略', { remote: conn.remote, deviceId: conn.deviceId })
      return
    }
    conn.helloReceived = true
    clearTimeout(conn.helloTimer)

    const allowed = normalizeAllowedDevices(esp32.allowDevices)
    if (allowed.length > 0) {
      const deviceId = String(conn.deviceId || '').trim().toLowerCase()
      if (!deviceId || !allowed.includes(deviceId)) {
        logger.warn('设备不在 allowDevices 白名单，关闭连接', {
          deviceId: conn.deviceId || null,
          remote: conn.remote,
        })
        closeConn(conn, WS_CLOSE.DEVICE_NOT_ALLOWED, 'device not allowed')
        return
      }
    }

    sendJsonToConn(conn, {
      type: 'hello',
      transport: 'websocket',
      session_id: conn.sessionId,
      audio_params: {
        format: 'opus',
        sample_rate: AUDIO.downlink.sampleRate,
        channels: AUDIO.downlink.channels,
        frame_duration: AUDIO.downlink.frameMs,
      },
    })
    logger.info('设备 hello 完成', {
      deviceId: conn.deviceId,
      clientId: conn.clientId,
      remote: conn.remote,
      sessionId: conn.sessionId,
    })

    if (!createSession) return
    try {
      conn.session = createSession({
        deviceId: conn.deviceId,
        clientId: conn.clientId,
        sessionId: conn.sessionId,
        remoteAddress: conn.remote,
        sendJson: (obj) => sendJsonToConn(conn, obj),
        sendBinary: (buffer) => sendBinaryToConn(conn, buffer),
        close: (code = WS_CLOSE.NORMAL, reason = '') => closeConn(conn, code, reason),
        hello: json,
      })
    } catch (error) {
      logger.error('创建设备会话失败，关闭该连接：', {
        deviceId: conn.deviceId,
        error: error?.message ?? String(error),
      })
      closeConn(conn, WS_CLOSE.SESSION_ERROR, 'session error')
      return
    }
    callSession(conn, 'handleJson', json)
  }

  function handleText(conn, data) {
    const text = data.toString('utf8')
    let json
    try {
      json = JSON.parse(text)
    } catch {
      logger.warn('收到非法 JSON，关闭该连接', {
        remote: conn.remote,
        deviceId: conn.deviceId,
        bytes: Buffer.byteLength(text),
      })
      closeConn(conn, WS_CLOSE.INVALID_JSON, 'invalid json')
      return
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      logger.debug('忽略非对象 JSON 消息', { remote: conn.remote })
      return
    }

    const type = typeof json.type === 'string' ? json.type : ''
    if (type === 'hello') {
      handleHello(conn, json)
      return
    }
    if (!conn.helloReceived) {
      logger.debug('hello 之前收到其他消息，忽略', { remote: conn.remote, type })
      return
    }
    if (type === 'mcp') {
      // 首版不做设备端 MCP：协议兼容 = 忽略且不报错。
      logger.debug('忽略 mcp 消息', { remote: conn.remote })
      return
    }
    if (type === 'listen' || type === 'abort') {
      if (!conn.session) {
        logger.debug('未接会话，忽略消息', { type })
        return
      }
      callSession(conn, 'handleJson', json)
      return
    }
    logger.debug('忽略未知消息类型', { remote: conn.remote, type })
  }

  function handleBinary(conn, data) {
    if (!conn.session) return
    callSession(conn, 'handleAudio', data)
  }

  function cleanupConn(conn, code, reason) {
    if (conn.cleaned) return
    conn.cleaned = true
    clearTimeout(conn.helloTimer)
    connections.delete(conn.ws)
    if (conn.session && typeof conn.session.close === 'function') {
      try {
        conn.session.close()
      } catch (error) {
        logger.warn('关闭设备会话失败：', error?.message ?? String(error))
      }
    }
    logger.debug('WS 连接关闭', {
      remote: conn.remote,
      deviceId: conn.deviceId,
      code,
      reason: reason?.toString?.() ?? '',
    })
  }

  function handleConnection(ws, req) {
    const remote = req.socket?.remoteAddress ?? 'unknown'
    const conn = {
      ws,
      remote,
      deviceId: headerString(req.headers?.['device-id']),
      clientId: headerString(req.headers?.['client-id']),
      sessionId: crypto.randomUUID(),
      helloReceived: false,
      session: null,
      closed: false,
      cleaned: false,
      helloTimer: null,
    }
    connections.set(ws, conn)
    logger.debug('WS 连接建立', { remote, deviceId: conn.deviceId })

    conn.helloTimer = setTimeout(() => {
      if (conn.closed || conn.helloReceived) return
      logger.warn('等待 hello 超时，关闭连接', { remote, deviceId: conn.deviceId })
      closeConn(conn, WS_CLOSE.HELLO_TIMEOUT, 'hello timeout')
    }, helloTimeoutMs)
    conn.helloTimer.unref?.()

    ws.on('message', (data, isBinary) => {
      try {
        if (conn.closed) return
        if (isBinary) handleBinary(conn, data)
        else handleText(conn, data)
      } catch (error) {
        logger.error('处理设备消息失败，关闭该连接：', {
          remote,
          deviceId: conn.deviceId,
          error: error?.message ?? String(error),
        })
        closeConn(conn, WS_CLOSE.SESSION_ERROR, 'internal error')
      }
    })
    ws.on('close', (code, reason) => cleanupConn(conn, code, reason))
    ws.on('error', (error) => {
      logger.warn('WS 连接错误：', { remote, deviceId: conn.deviceId, error: error?.message ?? String(error) })
      try { ws.terminate() } catch {}
    })
  }

  async function doStart() {
    await ensureToken()
    hostSelection = await resolveHostSelection()
    if (hostSelection?.address) {
      logger.info('publicHost 选择结果：', {
        address: hostSelection.address,
        interface: hostSelection.interfaceName,
        method: hostSelection.method,
      })
    } else {
      logger.warn('未找到可用的局域网 IPv4（已排除 loopback/169.254/198.18/虚拟网卡），请在设置中配置 esp32.publicHost；当前 OTA 暂用 127.0.0.1，设备无法连接')
    }

    const httpServer = http.createServer(handleRequest)
    const wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    })
    server = httpServer
    wss = wsServer

    wsServer.on('connection', (ws, req) => handleConnection(ws, req))
    httpServer.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head))
    httpServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening)
          try { wsServer.close() } catch {}
          try { httpServer.close() } catch {}
          server = null
          wss = null
          reject(listenError(error))
        }
        const onListening = () => {
          httpServer.off('error', onError)
          resolve()
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(port, host)
      })
    } catch (error) {
      hostSelection = null
      throw error
    }

    httpServer.on('error', (error) => {
      logger.error('esp32 gateway HTTP 服务错误：', error?.message ?? String(error))
    })
    logger.info('ESP32 网关已监听', {
      host,
      port: address()?.port,
      otaPath: OTA_PATH,
      wsPath: WS_PATH,
    })
    return address()
  }

  async function start() {
    if (server?.listening) return address()
    if (startPromise) return startPromise
    startPromise = doStart().finally(() => { startPromise = null })
    return startPromise
  }

  async function doStop() {
    if (startPromise) {
      try { await startPromise } catch { /* 启动失败则无需再停 */ }
    }
    const httpServer = server
    const wsServer = wss
    if (!httpServer && !wsServer) return

    logger.info('正在停止 ESP32 网关')
    for (const conn of connections.values()) {
      clearTimeout(conn.helloTimer)
      try { conn.ws.terminate() } catch {}
    }
    connections.clear()

    if (wsServer) {
      try { wsServer.close() } catch {}
    }
    if (httpServer) {
      await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          httpServer.close(done)
        } catch {
          done()
        }
        // 关闭 keep-alive / 尚未升级的裸连接，确保端口立即释放。
        for (const socket of sockets) {
          try { socket.destroy() } catch {}
        }
        sockets.clear()
      })
    }

    server = null
    wss = null
    hostSelection = null
    logger.info('ESP32 网关已停止')
  }

  async function stop() {
    if (stopPromise) return stopPromise
    if (!server && !startPromise) return undefined
    stopPromise = doStop().finally(() => { stopPromise = null })
    return stopPromise
  }

  return {
    start,
    stop,
    address,
    publicHost,
    publicHostInfo,
  }
}
