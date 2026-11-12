// T23：ESP32 通道宿主接线（网关生命周期 + 状态/日志路由的数据源）
//
// 职责（契约见 lib/esp32/contracts.js）：
// - 按配置 esp32.enabled 决定是否启动 T12 网关；启动/停止幂等，异常只记录不抛出，
//   绝不拖垮宿主插件；
// - 用 T13 会话工厂包装网关的 createSession：透传 deviceId/clientId/sessionId/
//   remoteAddress/sendJson/sendBinary/close/hello，并维护设备注册表；
// - 为宿主路由提供 status() / log()：地址、OTA URL、token 是否已配置、
//   ASR 可用性、在线设备与最近错误；
// - 预留 T22 管线注入点：options.createPipeline(sessionCtx, { getSpeechToText, getConfig })，
//   缺省返回 null（会话仍可安全运行，只做状态机与协议回执）。
//
// 安全：token 只在本机进程内读用（校验/脱敏），绝不写日志、绝不出现在任何 HTTP 响应里；
// 状态接口只暴露 tokenSet 布尔值。错误文本统一脱敏。
import { config as defaultConfig, saveEsp32Config as defaultSaveConfig } from '../../tools/lib/config.mjs'
import { apiKey as defaultApiKey } from '../../tools/lib/llm.mjs'
import { createGateway as defaultCreateGateway } from './gateway.js'
import { createEsp32Session as defaultCreateSession } from './session.js'
import { DEFAULT_PORT, OTA_PATH } from './contracts.js'

const noop = () => {}

function normalizeLogger(logger) {
  const prefix = '[esp32-host]'
  if (!logger) {
    return {
      debug: noop,
      info: (...args) => console.log(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    }
  }
  const pick = (name) => (typeof logger[name] === 'function' ? logger[name].bind(logger) : noop)
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
}

const messageOf = (error) => (error && typeof error.message === 'string' ? error.message : String(error ?? ''))

/**
 * 错误文本脱敏：抹掉已知 token、Bearer 凭据与 token=/api_key= 形式的值。
 * 结果截断到 300 字符，避免把整段堆栈塞进状态接口。
 */
export function sanitizeError(error, token = '') {
  let text = messageOf(error)
  if (token) text = text.split(String(token)).join('[redacted]')
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  text = text.replace(/((?:token|api[_-]?key|authorization)\s*[=:]\s*)["']?[^\s"',;}]+/gi, '$1[redacted]')
  return text.slice(0, 300)
}

/**
 * 创建 ESP32 宿主接线。
 *
 * @param {Object} [options]
 * @param {object} [options.ctx] 宿主插件上下文（保留，当前不直接使用）
 * @param {() => object} [options.getConfig] 配置源，默认 tools/lib/config.mjs 的 config()
 * @param {Function} [options.saveConfig] token 写回，默认 saveEsp32Config
 * @param {Function} [options.createGateway] 网关工厂，默认 createGateway（测试注入）
 * @param {Function} [options.createSession] 会话工厂，默认 createEsp32Session（测试注入）
 * @param {(sessionCtx: object, deps: object) => object|null} [options.createPipeline]
 *        管线工厂（T22 注入）；缺省返回 null
 * @param {{recent: Function}} [options.channelLog] 通道日志（T22 注入）
 * @param {object} [options.logger] { debug, info, warn, error }
 * @param {() => object|null} [options.getSpeechToText] 懒解析 ASR 服务
 * @param {() => string} [options.getLlmApiKey] LLM Key 解析（默认 tools/lib/llm.mjs 的 apiKey；测试注入）
 * @param {() => number} [options.now] 时间源，默认 Date.now（测试注入）
 * @returns {{ start: Function, stop: Function, status: Function, log: Function, address: Function }}
 */
export function createEsp32Host(options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : defaultConfig
  const saveConfig = typeof options.saveConfig === 'function' ? options.saveConfig : defaultSaveConfig
  const createGatewayImpl = typeof options.createGateway === 'function' ? options.createGateway : defaultCreateGateway
  const createSessionImpl = typeof options.createSession === 'function' ? options.createSession : defaultCreateSession
  const resolvePipeline = typeof options.createPipeline === 'function' ? options.createPipeline : null
  const channelLog = options.channelLog ?? null
  const logger = normalizeLogger(options.logger)
  const getSpeechToText = typeof options.getSpeechToText === 'function' ? options.getSpeechToText : () => null
  const getLlmApiKey = typeof options.getLlmApiKey === 'function' ? options.getLlmApiKey : defaultApiKey
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** sessionId → { deviceId, clientId, sessionId, remoteAddress, state, connectedAt, lastSeenAt, session } */
  const devices = new Map()
  let gateway = null
  let running = false
  let enabled = false
  let lastError = null
  let startPromise = null
  let stopPromise = null
  let sessionSeq = 0

  function readEsp32Config() {
    try {
      return getConfig()?.esp32 ?? {}
    } catch (error) {
      logger.warn('读取 esp32 配置失败：', messageOf(error))
      return {}
    }
  }

  function currentToken() {
    const token = readEsp32Config().token
    return typeof token === 'string' ? token : ''
  }

  function asrAvailable() {
    try {
      return Boolean(getSpeechToText())
    } catch (error) {
      logger.warn('解析 speechToText 失败，按不可用处理：', messageOf(error))
      return false
    }
  }

  /** LLM Key 是否已配置（只回布尔，绝不回明文）。 */
  function llmKeySet() {
    try {
      return Boolean(getLlmApiKey())
    } catch {
      return false
    }
  }

  /**
   * 管线错误上报（qa.js 的 onError 注入点）：写 status.lastError（脱敏）并记一条 warn。
   * 交给 logger 的只能是脱敏后的字符串 —— 原始 error 可能带 Authorization 头或 token。
   */
  function reportError(error, meta = {}) {
    const text = sanitizeError(error, currentToken())
    lastError = text
    logger.warn(
      `ESP32 管线错误（${meta?.stage || 'unknown'}）：${text}`,
      meta?.deviceId ? { deviceId: meta.deviceId } : undefined,
    )
    return text
  }

  function address() {
    try {
      return gateway?.address?.() ?? null
    } catch {
      return null
    }
  }

  function publicHost() {
    try {
      return gateway?.publicHost?.() ?? null
    } catch {
      return null
    }
  }

  function deviceKey(args) {
    const sessionId = String(args?.sessionId ?? '')
    if (sessionId) return sessionId
    sessionSeq += 1
    return `${String(args?.deviceId ?? '')}:${sessionSeq}`
  }

  /**
   * 包装网关的 createSession：登记设备、包装 sendJson/sendBinary 刷新 lastSeenAt、
   * 包装 close 注销设备（保持原 close 的幂等语义）。
   */
  function sessionFactory(args = {}) {
    const key = deviceKey(args)
    const connectedAt = now()
    const entry = {
      deviceId: String(args.deviceId ?? ''),
      clientId: String(args.clientId ?? ''),
      sessionId: String(args.sessionId ?? ''),
      remoteAddress: String(args.remoteAddress ?? ''),
      state: 'idle',
      connectedAt,
      lastSeenAt: connectedAt,
      session: null,
    }

    const touch = () => { entry.lastSeenAt = now() }
    const sendJson = (obj) => {
      touch()
      return typeof args.sendJson === 'function' ? args.sendJson(obj) : false
    }
    const sendBinary = (buffer) => {
      touch()
      return typeof args.sendBinary === 'function' ? args.sendBinary(buffer) : false
    }

    const session = createSessionImpl({
      deviceId: entry.deviceId,
      clientId: entry.clientId,
      sessionId: entry.sessionId,
      remoteAddress: entry.remoteAddress,
      sendJson,
      sendBinary,
      close: args.close,
      hello: args.hello,
      getConfig,
      createPipeline: (sessionCtx) => (resolvePipeline
        ? resolvePipeline(sessionCtx, { getSpeechToText, getConfig, reportError })
        : null),
      logger,
    })

    entry.session = session
    devices.set(key, entry)

    // 网关只依赖 state / handleJson / handleAudio / abort / close 这几个成员；
    // 用包装对象而不是改写原对象，避免依赖会话实现是否可写。
    return {
      get state() {
        return session?.state ?? entry.state
      },
      handleJson: (json) => session?.handleJson?.(json),
      handleAudio: (chunk) => session?.handleAudio?.(chunk),
      abort: (reason) => session?.abort?.(reason),
      close: () => {
        devices.delete(key)
        try {
          return session?.close?.()
        } catch (error) {
          logger.warn('关闭设备会话失败：', messageOf(error))
          return undefined
        }
      },
    }
  }

  async function doStart() {
    const esp32 = readEsp32Config()
    enabled = esp32.enabled === true
    if (!enabled) {
      running = false
      return { started: false, enabled: false }
    }
    if (running && gateway) return { started: true, already: true, address: address() }

    try {
      gateway = createGatewayImpl({
        getConfig,
        saveConfig,
        logger,
        createSession: sessionFactory,
      })
      await gateway.start()
      running = true
      lastError = null
      logger.info('ESP32 网关已启动', { address: address() })
      return { started: true, enabled: true, address: address() }
    } catch (error) {
      running = false
      lastError = sanitizeError(error, currentToken())
      logger.warn('ESP32 网关启动失败（插件继续运行）：', lastError)
      const failed = gateway
      gateway = null
      try { await failed?.stop?.() } catch { /* 启动失败后的清理失败不再上报 */ }
      return { started: false, enabled: true, lastError }
    }
  }

  function start() {
    if (startPromise) return startPromise
    startPromise = doStart().finally(() => { startPromise = null })
    return startPromise
  }

  async function doStop() {
    for (const entry of devices.values()) {
      try { entry.session?.close?.() } catch { /* 单个会话关闭失败不影响整体停止 */ }
    }
    devices.clear()
    const current = gateway
    gateway = null
    running = false
    if (!current) return
    try {
      await current.stop?.()
      logger.info('ESP32 网关已停止')
    } catch (error) {
      lastError = sanitizeError(error, currentToken())
      logger.warn('ESP32 网关停止失败：', lastError)
    }
  }

  function stop() {
    if (stopPromise) return stopPromise
    stopPromise = doStop().finally(() => { stopPromise = null })
    return stopPromise
  }

  function status() {
    const esp32 = readEsp32Config()
    const addr = address()
    const host = publicHost() || '127.0.0.1'
    const port = Number(addr?.port ?? esp32.port ?? DEFAULT_PORT)
    const rows = []
    for (const entry of devices.values()) {
      // 状态查询是只读的：lastSeenAt 只由 sendJson/sendBinary（touch）刷新，
      // 否则前端轮询状态就会把所有设备伪装成「刚刚在线」。
      entry.state = entry.session?.state ?? entry.state
      rows.push({
        deviceId: entry.deviceId,
        clientId: entry.clientId,
        sessionId: entry.sessionId,
        remoteAddress: entry.remoteAddress,
        state: entry.state,
        connectedAt: entry.connectedAt,
        lastSeenAt: entry.lastSeenAt,
      })
    }
    return {
      ok: true,
      enabled: esp32.enabled === true,
      running,
      address: addr,
      publicHost: publicHost(),
      otaUrl: `http://${host}:${port}${OTA_PATH}`,
      // 安全：只暴露「是否已配置」，绝不把明文 token 交给任何 HTTP 响应。
      tokenSet: typeof esp32.token === 'string' && esp32.token.length > 0,
      llmKeySet: llmKeySet(),
      asrAvailable: asrAvailable(),
      devices: rows,
      lastError,
    }
  }

  function log({ device = '', limit = 50 } = {}) {
    if (!channelLog || typeof channelLog.recent !== 'function') return []
    try {
      const rows = channelLog.recent(device, limit)
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      logger.warn('读取通道日志失败：', messageOf(error))
      return []
    }
  }

  return { start, stop, status, log, address }
}
