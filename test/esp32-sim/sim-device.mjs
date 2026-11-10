// ESP32 模拟设备（T14）——无硬件时复用的小智 WebSocket 设备端。
//
// 能力：
// - createSimDevice({ url, token, deviceId, clientId, ... })：用 ws 连接，
//   完成 hello 握手（Authorization: Bearer <token>；token 为 null 时不带该头）；
// - sendListen / sendAbort / sendHello / sendJson：设备 → 服务端 JSON；
// - sendPcm：PCM16 → 16k/60ms/960 点 Opus 上行帧（OpusEncoder）；
// - 按到达顺序记录下行 JSON 与二进制帧（含时间戳），24k 下行帧解码并统计采样点数；
// - waitFor(predicate, timeoutMs) / waitForJson / waitForClose / close。
//
// 设计给 T20-T22 复用：不依赖任何测试框架；不读写真实配置；失败时错误信息里带
// 收到的消息序列（transcript），便于定位时序问题。
import { WebSocket } from 'ws'
import { OpusDecoder, OpusEncoder } from '../../lib/esp32/audio/opus.js'
import { AUDIO, LISTEN_MODES, LISTEN_STATES, WS_PATH } from '../../lib/esp32/contracts.js'

const noop = () => {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

function normalizeLogger(logger) {
  const pick = (name) => (logger && typeof logger[name] === 'function' ? logger[name].bind(logger) : noop)
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
}

/** 模拟设备错误：transcript 是截至失败时收到的下行消息序列。 */
export class SimDeviceError extends Error {
  constructor(message, { transcript = null, cause = null } = {}) {
    super(cause ? `${message}（cause: ${cause?.message ?? cause}）` : message)
    this.name = 'SimDeviceError'
    this.transcript = transcript
    if (cause) this.cause = cause
  }
}

/** 由网关 address() 结果或端口号拼出设备侧 WS 地址。 */
export function wsUrlFor(address, options = {}) {
  const host = options.host ?? '127.0.0.1'
  const path = options.path ?? WS_PATH
  const port = typeof address === 'object' && address !== null ? address.port : address
  const numeric = Number(port)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new TypeError(`wsUrlFor: 需要端口号或 address() 对象（收到 ${JSON.stringify(address)}）`)
  }
  return `ws://${host}:${numeric}${path}`
}

/** 小智固件风格的 hello 消息（上行音频参数 16k/60ms/opus）。 */
export function defaultHello(overrides = {}) {
  const base = {
    type: 'hello',
    version: 1,
    transport: 'websocket',
    features: { mcp: true },
    audio_params: {
      format: 'opus',
      sample_rate: AUDIO.uplink.sampleRate,
      channels: AUDIO.uplink.channels,
      frame_duration: AUDIO.uplink.frameMs,
    },
  }
  return {
    ...base,
    ...overrides,
    features: { ...base.features, ...(overrides.features ?? {}) },
    audio_params: { ...base.audio_params, ...(overrides.audio_params ?? {}) },
  }
}

/** 生成单声道 PCM16 正弦波（测试语音/音效的最简素材）。 */
export function sinePcm(samples, options = {}) {
  const {
    sampleRate = AUDIO.uplink.sampleRate,
    frequency = 440,
    amplitude = 0.2,
    phase = 0,
  } = options
  if (!Number.isInteger(samples) || samples < 0) {
    throw new RangeError(`sinePcm: samples 必须是非负整数（收到 ${samples}）`)
  }
  if (!(sampleRate > 0)) throw new RangeError(`sinePcm: 非法采样率 ${sampleRate}`)
  const peak = Math.max(0, Math.min(1, Number(amplitude) || 0)) * 32767
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(peak * Math.sin((2 * Math.PI * frequency * (i + phase)) / sampleRate))
  }
  return pcm
}

/**
 * 尝试建立 WS：断言 upgrade 被拒绝（例如 token 缺失/错误时的 HTTP 401）。
 * 成功“被拒绝”时 resolve { statusCode, headers, opened:false }；
 * 连接意外建立、超时或无法取得响应时 reject。
 */
export function expectUpgradeRejected(options = {}) {
  const {
    url,
    token = null,
    headers = {},
    timeoutMs = 3000,
    deviceId = 'sim-reject-device',
    clientId = 'sim-reject-client',
  } = options
  if (typeof url !== 'string' || !url) throw new TypeError('expectUpgradeRejected: 需要 url')
  const requestHeaders = {
    'Device-Id': deviceId,
    'Client-Id': clientId,
    'Protocol-Version': '1',
    ...headers,
  }
  if (token != null) requestHeaders.Authorization = `Bearer ${token}`

  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    const ws = new WebSocket(url, { headers: requestHeaders })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.terminate() } catch {}
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      finish(new SimDeviceError(`等待 upgrade 响应超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()

    ws.on('open', () => {
      opened = true
      finish(new SimDeviceError('连接意外建立（预期 upgrade 被拒绝）'))
    })
    ws.on('unexpected-response', (req, res) => {
      res.resume()
      finish(null, { statusCode: res.statusCode, headers: res.headers, opened })
    })
    ws.on('error', (error) => {
      // 某些 ws 版本在 abortHandshake 时也会 emit error；优先让 unexpected-response 生效。
      finish(new SimDeviceError(`WS upgrade 失败：${error?.message ?? error}`, { cause: error }))
    })
    ws.on('close', () => {
      if (!settled && !opened) {
        finish(new SimDeviceError('连接在 upgrade 响应前关闭（服务端未返回状态码）'))
      }
    })
  })
}

/**
 * 模拟设备。一般通过 createSimDevice() 使用。
 *
 * @param {Object} options
 * @param {string} options.url 完整 WS 地址（ws://127.0.0.1:<port>/xiaozhi/v1/）
 * @param {string|null} [options.token] Bearer token；null 表示不带 Authorization
 * @param {string} [options.deviceId='sim-device-01']
 * @param {string} [options.clientId='sim-client-01']
 * @param {object} [options.headers] 额外请求头
 * @param {object} [options.hello] hello 字段覆盖（默认见 defaultHello）
 * @param {boolean} [options.autoHello=true] 连接后自动发 hello 并等待服务端 hello
 * @param {number} [options.connectTimeoutMs=5000]
 * @param {number} [options.helloTimeoutMs=5000]
 * @param {object} [options.logger]
 */
export class SimDevice {
  constructor(options = {}) {
    const {
      url,
      token = null,
      deviceId = 'sim-device-01',
      clientId = 'sim-client-01',
      headers = {},
      hello = null,
      autoHello = true,
      connectTimeoutMs = 5000,
      helloTimeoutMs = 5000,
      logger = null,
    } = options
    if (typeof url !== 'string' || url.length === 0) {
      throw new TypeError('createSimDevice: 需要 url（完整 ws:// 地址）')
    }
    this.url = url
    this.token = token
    this.deviceId = String(deviceId)
    this.clientId = String(clientId)
    this.extraHeaders = { ...headers }
    this.helloOverrides = hello
    this.autoHello = autoHello
    this.connectTimeoutMs = Number(connectTimeoutMs)
    this.helloTimeoutMs = Number(helloTimeoutMs)
    this.logger = normalizeLogger(logger)

    /** 收到的下行消息（json / binary / json-error），按到达顺序。 */
    this.messages = []
    /** 已发送的消息（json / binary），按发送顺序。 */
    this.sent = []
    /** 传输事件（open / error / close）。 */
    this.events = []
    this.serverHello = null
    this.sessionId = null
    this.connectedAt = null
    this.helloReceivedAt = null
    this.closeInfo = null

    this._ws = null
    this._encoder = null
    this._decoder = null
    this._closed = false
    this._waiters = new Set()
    this._closedResolve = null
    this._closedPromise = new Promise((resolve) => { this._closedResolve = resolve })
  }

  /** 连接（含 hello 握手）；失败时会清理连接并抛出带 transcript 的 SimDeviceError。 */
  async connect() {
    if (this._ws) throw new SimDeviceError('connect() 只能调用一次')
    const headers = {
      'Device-Id': this.deviceId,
      'Client-Id': this.clientId,
      'Protocol-Version': '1',
      ...this.extraHeaders,
    }
    if (this.token != null) headers.Authorization = `Bearer ${this.token}`

    const ws = new WebSocket(this.url, { headers })
    this._ws = ws
    ws.on('message', (data, isBinary) => this._handleMessage(data, isBinary))
    ws.on('close', (code, reason) => this._handleClose(code, reason))
    ws.on('error', (error) => {
      const message = error?.message ?? String(error)
      this.events.push({ type: 'error', at: Date.now(), error: message })
      this.logger.warn('模拟设备 WS 错误：', message)
    })

    try {
      await this._waitOpen()
      this.connectedAt = Date.now()
      this.events.push({ type: 'open', at: this.connectedAt })
      this.logger.debug('模拟设备已连接', { url: this.url, deviceId: this.deviceId })
      if (this.autoHello) {
        await this.sendHello()
        await this.waitForServerHello(this.helloTimeoutMs)
      }
      return this
    } catch (error) {
      await this.close({ reason: 'connect failed' }).catch(noop)
      throw error
    }
  }

  _waitOpen() {
    const ws = this._ws
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new SimDeviceError(`WS 连接超时（${this.connectTimeoutMs}ms）`, {
          transcript: this.transcript(),
        }))
      }, this.connectTimeoutMs)
      timer.unref?.()
      const cleanup = () => {
        clearTimeout(timer)
        ws.off('open', onOpen)
        ws.off('error', onError)
        ws.off('close', onClose)
      }
      const onOpen = () => { cleanup(); resolve() }
      const onError = (error) => {
        cleanup()
        reject(new SimDeviceError(`WS 连接失败：${error?.message ?? error}`, {
          transcript: this.transcript(),
          cause: error,
        }))
      }
      const onClose = (code, reason) => {
        cleanup()
        reject(new SimDeviceError(`WS 在握手前关闭（code=${code}, reason=${reason?.toString?.() ?? ''}）`, {
          transcript: this.transcript(),
        }))
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
      ws.once('close', onClose)
    })
  }

  // ── 发送 ──────────────────────────────────────────────────────────────────

  _sendRaw(data, options) {
    return new Promise((resolve, reject) => {
      const ws = this._ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new SimDeviceError('WS 未连接，无法发送', { transcript: this.transcript() }))
        return
      }
      ws.send(data, options, (error) => {
        if (error) {
          reject(new SimDeviceError(`WS 发送失败：${error?.message ?? error}`, {
            transcript: this.transcript(),
            cause: error,
          }))
          return
        }
        resolve()
      })
    })
  }

  async sendJson(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new TypeError('sendJson: 需要普通对象')
    }
    await this._sendRaw(JSON.stringify(obj))
    this.sent.push({ kind: 'json', at: Date.now(), json: obj })
    this.logger.debug('→', JSON.stringify(obj))
    return obj
  }

  /** 发送 hello（默认自动调用一次；重复调用由服务端忽略）。 */
  sendHello(overrides = {}) {
    const base = defaultHello(this.helloOverrides ?? {})
    const hello = { ...base, ...overrides }
    hello.features = { ...base.features, ...(overrides.features ?? {}) }
    hello.audio_params = { ...base.audio_params, ...(overrides.audio_params ?? {}) }
    return this.sendJson(hello)
  }

  /** 发送 listen：state 为 start / stop / detect；start/detect 可带 mode。 */
  sendListen(args = {}) {
    const { state, mode, text } = args
    if (!LISTEN_STATES.includes(state)) {
      throw new RangeError(`sendListen: 非法 state ${JSON.stringify(state)}（支持 ${LISTEN_STATES.join('/')}）`)
    }
    const message = { type: 'listen', state }
    if (state === 'start' || state === 'detect') {
      message.mode = LISTEN_MODES.includes(mode) ? mode : 'auto'
    }
    if (typeof text === 'string' && text.length > 0) message.text = text
    return this.sendJson(message)
  }

  /** 发送 abort（固件 BOOT 键打断）。 */
  sendAbort(reason = 'abort') {
    return this.sendJson({ type: 'abort', reason: String(reason) })
  }

  /** 发送单个 Opus 包（二进制帧）。 */
  async sendBinary(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      throw new TypeError('sendBinary: 需要 Buffer/Uint8Array 类型的 Opus 包')
    }
    if (buffer.byteLength === 0) throw new RangeError('sendBinary: 空包')
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    await this._sendRaw(bytes, { binary: true })
    this.sent.push({ kind: 'binary', at: Date.now(), bytes: bytes.length })
    return bytes
  }

  /**
   * PCM16 → 16k/60ms/960 点 Opus 帧并逐帧发送。
   * 不足一帧时默认补零（pad=false 则抛错）。
   * @returns {Promise<Buffer[]>} 已发送的 Opus 包
   */
  async sendPcm(pcm, options = {}) {
    const { frameSamples = AUDIO.uplink.samplesPerFrame, pad = true } = options
    if (!(pcm instanceof Int16Array)) throw new TypeError('sendPcm: 需要 Int16Array（单声道 PCM16）')
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new RangeError(`sendPcm: 非法 frameSamples ${frameSamples}`)
    }
    if (!this._encoder) this._encoder = new OpusEncoder(AUDIO.uplink.sampleRate)
    const packets = []
    for (let offset = 0; offset < pcm.length; offset += frameSamples) {
      let frame = pcm.subarray(offset, Math.min(offset + frameSamples, pcm.length))
      if (frame.length < frameSamples) {
        if (!pad) {
          throw new RangeError(`sendPcm: 末帧只有 ${frame.length} 点（需要 ${frameSamples} 点，pad=false）`)
        }
        const padded = new Int16Array(frameSamples)
        padded.set(frame)
        frame = padded
      }
      const packet = this._encoder.encode(frame)
      await this.sendBinary(packet)
      packets.push(packet)
    }
    return packets
  }

  // ── 接收 ──────────────────────────────────────────────────────────────────

  _handleMessage(data, isBinary) {
    const at = Date.now()
    if (isBinary) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      let pcm = null
      let error = null
      try {
        if (!this._decoder) this._decoder = new OpusDecoder(AUDIO.downlink.sampleRate)
        pcm = this._decoder.decode(bytes)
      } catch (decodeError) {
        error = decodeError
      }
      this._push({
        kind: 'binary',
        at,
        bytes: bytes.length,
        samples: pcm ? pcm.length : 0,
        pcm,
        error,
      })
      return
    }

    const text = data.toString('utf8')
    let json
    try {
      json = JSON.parse(text)
    } catch (error) {
      this._push({ kind: 'json-error', at, raw: text, error })
      return
    }
    if (json && json.type === 'hello' && !this.serverHello) {
      this.serverHello = json
      this.sessionId = typeof json.session_id === 'string' ? json.session_id : null
      this.helloReceivedAt = at
    }
    this._push({ kind: 'json', at, json })
    this.logger.debug('←', JSON.stringify(json))
  }

  _push(entry) {
    this.messages.push(entry)
    for (const waiter of [...this._waiters]) {
      let matched
      try {
        matched = Boolean(waiter.predicate(entry, this))
      } catch (error) {
        this._waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.reject(new SimDeviceError(`waitFor 谓词抛错：${error?.message ?? error}`, {
          transcript: this.transcript(),
          cause: error,
        }))
        continue
      }
      if (!matched) continue
      this._waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(entry)
    }
  }

  _handleClose(code, reason) {
    const text = reason?.toString?.() ?? ''
    this._closed = true
    this.closeInfo = { code, reason: text, at: Date.now() }
    this.events.push({ type: 'close', at: this.closeInfo.at, code, reason: text })
    for (const waiter of [...this._waiters]) {
      this._waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.reject(new SimDeviceError(`连接已关闭（code=${code}），等待被取消`, {
        transcript: this.transcript(),
      }))
    }
    this._disposeCodecs()
    this._closedResolve(this.closeInfo)
  }

  // ── 等待与查询 ────────────────────────────────────────────────────────────

  /**
   * 等待满足 predicate(message, device) 的消息；先扫描已收到的消息。
   * 超时抛 SimDeviceError（带 transcript）。
   */
  waitFor(predicate, timeoutMs = 3000) {
    if (typeof predicate !== 'function') throw new TypeError('waitFor: 需要谓词函数')
    for (const message of this.messages) {
      let matched
      try {
        matched = predicate(message, this)
      } catch (error) {
        return Promise.reject(new SimDeviceError(`waitFor 谓词抛错：${error?.message ?? error}`, {
          transcript: this.transcript(),
          cause: error,
        }))
      }
      if (matched) return Promise.resolve(message)
    }
    if (this._closed) {
      return Promise.reject(new SimDeviceError('连接已关闭，无法继续等待', {
        transcript: this.transcript(),
      }))
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this._waiters.delete(waiter)
        reject(new SimDeviceError(
          `waitFor 超时（${timeoutMs}ms）：${predicate.name || '匿名谓词'}`,
          { transcript: this.transcript() },
        ))
      }, timeoutMs)
      waiter.timer.unref?.()
      this._waiters.add(waiter)
    })
  }

  /** 等待指定 type 的 JSON（或谓词命中的 JSON），resolve 为 JSON 对象。 */
  waitForJson(match, timeoutMs = 3000) {
    const predicate = typeof match === 'string'
      ? (message) => message.kind === 'json' && message.json?.type === match
      : (message) => message.kind === 'json' && Boolean(match(message.json, message))
    return this.waitFor(predicate, timeoutMs).then((message) => message.json)
  }

  /** 等待服务端 hello（握手时自动调用）。 */
  waitForServerHello(timeoutMs = this.helloTimeoutMs) {
    if (this.serverHello) return Promise.resolve(this.serverHello)
    return this.waitForJson('hello', timeoutMs).then((hello) => {
      this.serverHello = hello
      this.sessionId = typeof hello.session_id === 'string' ? hello.session_id : null
      return hello
    })
  }

  /** 等待连接关闭；连接已关闭时立即 resolve。 */
  waitForClose(timeoutMs = 3000) {
    if (this._closed) return Promise.resolve(this.closeInfo)
    return Promise.race([
      this._closedPromise,
      sleep(timeoutMs).then(() => {
        throw new SimDeviceError(`等待连接关闭超时（${timeoutMs}ms）`, { transcript: this.transcript() })
      }),
    ])
  }

  /** 记录当前消息位置，配合 messagesSince / jsonMessages(since) 使用。 */
  mark() {
    return this.messages.length
  }

  messagesSince(index) {
    return this.messages.slice(Math.max(0, Number(index) || 0))
  }

  /** 自 since 起收到的 JSON 对象（不含时间戳）。 */
  jsonMessages(since = 0) {
    return this.messagesSince(since)
      .filter((message) => message.kind === 'json')
      .map((message) => message.json)
  }

  /** 自 since 起收到的二进制帧条目（含 samples / pcm / 时间戳）。 */
  binaryMessages(since = 0) {
    return this.messagesSince(since).filter((message) => message.kind === 'binary')
  }

  /** 收到的下行消息序列（排错用；时间相对于连接建立）。 */
  transcript(since = 0) {
    const base = this.connectedAt ?? Date.now()
    const entries = this.messagesSince(since).map((message, offset) => {
      const index = Math.max(0, Number(since) || 0) + offset
      const relative = Math.max(0, message.at - base)
      if (message.kind === 'json') {
        return `#${index} +${relative}ms json ${JSON.stringify(message.json)}`
      }
      if (message.kind === 'binary') {
        const error = message.error ? ` (decode error: ${message.error?.message ?? message.error})` : ''
        return `#${index} +${relative}ms binary ${message.bytes}B -> ${message.samples}pts${error}`
      }
      return `#${index} +${relative}ms ${message.kind} ${String(message.raw ?? '').slice(0, 200)}`
    })
    return entries.length > 0 ? entries.join('\n') : '(无下行消息)'
  }

  /** 关闭连接并释放 Opus WASM 内存；幂等。 */
  async close(options = {}) {
    const { code = 1000, reason = 'sim device closed', timeoutMs = 1000 } = options
    if (this._closed) {
      this._disposeCodecs()
      return this.closeInfo
    }
    const ws = this._ws
    if (!ws) {
      this._closed = true
      this._disposeCodecs()
      return this.closeInfo
    }
    try { ws.close(code, reason) } catch {}
    await Promise.race([this._closedPromise, sleep(timeoutMs)])
    if (!this._closed) {
      try { ws.terminate() } catch {}
      await Promise.race([this._closedPromise, sleep(200)])
    }
    if (!this._closed) {
      this._closed = true
      this.closeInfo = { code, reason: String(reason), at: Date.now(), synthetic: true }
      this._closedResolve(this.closeInfo)
    }
    this._disposeCodecs()
    return this.closeInfo
  }

  _disposeCodecs() {
    if (this._encoder) {
      try { this._encoder.close() } catch {}
      this._encoder = null
    }
    if (this._decoder) {
      try { this._decoder.close() } catch {}
      this._decoder = null
    }
  }
}

/** 连接并完成 hello 握手，resolve 为可用的 SimDevice。 */
export async function createSimDevice(options = {}) {
  const device = new SimDevice(options)
  await device.connect()
  return device
}
