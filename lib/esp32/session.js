// T13：ESP32 会话状态机（协议入口 + 状态机 + 注入式管线 seam）
//
// 职责（契约见 lib/esp32/contracts.js）：
// - 接收 T12 网关转发的 hello / listen / abort JSON 与 Opus 上行二进制帧；
// - 维护 idle → listening → recognizing → thinking → speaking 状态机；
// - 解码 16k/60ms Opus 上行帧（Int16Array），交给注入管线（T20-T22 在其上接
//   VAD/ASR/brain/TTS），也可选地喂给注入的 VAD；
// - 提供稳定的下发 helper：sendStt / sendTts / sendLlm / sendJson / sendBinary；
// - abort / close / 空闲断开 / 管线异常隔离。
//
// ── 同步入口约束（T12 网关）────────────────────────────────────────────────
// gateway.js 的 callSession 只捕获同步异常；handleJson / handleAudio 若返回
// rejected Promise，会变成宿主的 unhandledRejection。因此本模块：
//   1) handleJson / handleAudio 是同步函数，内部 catch 所有同步异常；
//   2) 管线回调返回的 Promise 一律挂 rejection handler；
//   3) 任何未捕获的管线错误只关闭本会话（注入的 close(1011, ...)），不向调用方抛。
//
// ── 状态机语义 ──────────────────────────────────────────────────────────────
// * 合法迁移：idle → listening；任意非 idle 状态 → listening；只能向前推进
//   （listening → recognizing → thinking → speaking），允许跳过中间态（如
//   listening → speaking 用于唤醒问候）。非法迁移记 warn 并保持原状态，不抛。
// * 每设备同一时刻只有一个活动轮次（turn），listen start / detect 会取消旧轮次：
//   abort 旧 AbortController、丢弃其后续下发、幂等补发 tts stop。
// * abort 有活动轮次时：取消轮次 + 收尾 tts + 状态回落到 listening（设备在 auto
//   模式下继续监听，等待下一次 listen start）；无活动轮次时是完整 no-op，
//   因此重复 abort 幂等。close 后状态固定为 idle。
// * tts stop 只在同一轮 sendTts({state:'start'}) 之后发一次；abort / close /
//   transition 到 listening 都会幂等收尾。
//
// ── 注入式管线 seam（T20-T22 使用；接口保持稳定）──────────────────────────
// 两种注入方式（二选一，pipeline 优先）：
//   createEsp32Session({ pipeline })
//   createEsp32Session({ createPipeline: (ctx) => pipeline })
//
// ctx（会话能力，均做了关闭/中断保护）：
//   sendJson(json)                     → boolean  任意 JSON（关闭后丢弃）
//   sendBinary(buffer)                 → boolean  下行音频（无活动轮次/已 abort 时丢弃）
//   getState()                         → SessionState
//   transition(state, meta?)           → boolean  非法迁移记日志并保持原状态
//   sendStt(text)                      → boolean  {type:'stt', text}
//   sendTts({state, text?})            → boolean  {type:'tts', state:'start'|'sentence_start'|'stop', text?}
//                                                   stop 只在 start 之后发，且只发一次
//   sendLlm({emotion, text})           → boolean  {type:'llm', emotion, text}
//   now()                              → number   注入的时间源
//   setTimer(fn, ms) / clearTimer(h)           注入的定时器；close 时自动清理
//   getSignal()                        → AbortSignal|null  当前轮次的取消信号
//   logger                             { debug, info, warn, error }
//   deviceId / clientId / sessionId / remoteAddress  （只读元数据，无凭据）
//
// pipeline 回调（全部可省略；返回 Promise 时 rejection 会被捕获）：
//   onOpen({hello})                     hello 到达（网关构造时传入 hello 也算）
//   onListenStart({mode})               listen start；detect 时为
//                                       {mode, detect:true, text}（唤醒问候 seam，
//                                       本会话不会因此进入 ASR）
//   onListenStop()                      manual 模式（或 listening 状态下收到 stop）
//                                       —— 此前所有上行帧已经通过 onAudio 交付，
//                                       「整段音频」由管线自行缓冲
//   onAudio(frame, {sampleRate, samples})  Int16Array 上行帧（16k）
//   onVad(event, {signal})              注入 VAD 的事件（speech_start / speech_end）
//   onAbort({reason})                   轮次被取消（abort / listen start / close）
//   onClose()                           会话关闭（幂等，只调一次）
//
// 默认不传管线时会话仍可安全运行：只做状态机与协议回执，音频解码后丢弃，
// 供 T14 模拟设备使用。本模块不访问真实 provider、不打印 token。

import { OpusUplinkDecoder } from './audio/opus.js'
import {
  AUDIO,
  DEFAULT_ESP32_CONFIG,
  LISTEN_MODES,
  TTS_STATES,
  isSessionState,
} from './contracts.js'
import { config as defaultConfig } from '../../tools/lib/config.mjs'

const DEFAULT_IDLE_DISCONNECT_MS = DEFAULT_ESP32_CONFIG.idleDisconnectMs
const STATE_RANK = Object.freeze({ idle: 0, listening: 1, recognizing: 2, thinking: 3, speaking: 4 })
const noop = () => {}

function normalizeLogger(logger) {
  const prefix = '[esp32-session]'
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

const messageOf = (error) => (error && typeof error.message === 'string' ? error.message : String(error))

function createAbortError(reason) {
  const error = new Error(`ESP32 会话轮次已取消：${String(reason ?? 'abort')}`)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  error.reason = reason
  return error
}

const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function'

/** 状态迁移是否合法：只允许向前推进 + 任意状态回落到 listening。 */
function isLegalTransition(from, to) {
  if (from === to) return true
  if (from === 'idle') return to === 'listening'
  if (to === 'listening') return true
  return STATE_RANK[to] > STATE_RANK[from]
}

/**
 * @typedef {Object} Esp32SessionContext
 * @property {(json: object) => boolean} sendJson
 * @property {(buffer: Uint8Array) => boolean} sendBinary
 * @property {() => import('./contracts.js').SessionState} getState
 * @property {(state: import('./contracts.js').SessionState, meta?: object) => boolean} transition
 * @property {(text: string) => boolean} sendStt
 * @property {(args: {state: 'start'|'sentence_start'|'stop', text?: string}) => boolean} sendTts
 * @property {(args: {emotion?: string, text?: string}) => boolean} sendLlm
 * @property {() => number} now
 * @property {(fn: Function, ms: number) => unknown} setTimer
 * @property {(handle: unknown) => void} clearTimer
 * @property {() => AbortSignal|null} getSignal
 * @property {object} logger
 * @property {string} deviceId
 * @property {string} clientId
 * @property {string} sessionId
 * @property {string} remoteAddress
 */

/**
 * @typedef {Object} Esp32SessionPipeline
 * @property {(args: {hello: object}) => void|Promise<void>} [onOpen]
 * @property {(args: {mode: string, detect?: boolean, text?: string}) => void|Promise<void>} [onListenStart]
 * @property {() => void|Promise<void>} [onListenStop]
 * @property {(frame: Int16Array, meta: {sampleRate: number, samples: number}) => void|Promise<void>} [onAudio]
 * @property {(event: object, meta: {signal: AbortSignal|null}) => void|Promise<void>} [onVad]
 * @property {(args: {reason: string}) => void|Promise<void>} [onAbort]
 * @property {() => void|Promise<void>} [onClose]
 */

/**
 * 创建单个 ESP32 设备的会话。
 *
 * @param {Object} [options]
 * @param {string} [options.deviceId]
 * @param {string} [options.clientId]
 * @param {string} [options.sessionId]
 * @param {string} [options.remoteAddress]
 * @param {object} [options.hello] 网关在 createSession 时传入的 hello JSON
 * @param {(obj: object) => unknown} [options.sendJson]
 * @param {(buffer: Uint8Array) => unknown} [options.sendBinary]
 * @param {(code?: number, reason?: string) => unknown} [options.close] 网关的连接关闭函数
 * @param {Esp32SessionPipeline} [options.pipeline] 预构造的管线
 * @param {(ctx: Esp32SessionContext) => Esp32SessionPipeline} [options.createPipeline] 管线工厂
 * @param {{push(frame: Int16Array): object[], close?: Function}} [options.vad] 预构造的 VAD
 * @param {(ctx: Esp32SessionContext) => object} [options.createVad] VAD 工厂（T11 createVad）
 * @param {object} [options.logger] { debug, info, warn, error }
 * @param {() => number} [options.now] 时间源，默认 Date.now
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer] 定时器，默认 setTimeout
 * @param {(handle: unknown) => void} [options.clearTimer] 清定时器，默认 clearTimeout
 * @param {() => object} [options.getConfig] 配置源，默认 tools/lib/config.mjs 的 config()
 * @param {number} [options.idleDisconnectMs] 覆盖 esp32.idleDisconnectMs（测试用毫秒级）
 * @returns {import('./contracts.js').Session}
 */
export function createEsp32Session(options = {}) {
  if (options === null || typeof options !== 'object') options = {}

  const {
    deviceId = '',
    clientId = '',
    sessionId = '',
    remoteAddress = '',
    hello = null,
    sendJson: sendJsonRaw,
    sendBinary: sendBinaryRaw,
    close: closeRaw,
    pipeline: providedPipeline = null,
    createPipeline: createPipelineOption,
    vad: providedVad = null,
    createVad: createVadOption,
    logger: loggerOption,
    now: nowOption,
    setTimer: setTimerOption,
    clearTimer: clearTimerOption,
    getConfig: getConfigOption,
    idleDisconnectMs: idleDisconnectMsOption,
  } = options

  const log = normalizeLogger(loggerOption)
  const now = typeof nowOption === 'function' ? nowOption : Date.now
  const setTimer = typeof setTimerOption === 'function'
    ? setTimerOption
    : (fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return handle
    }
  const clearTimer = typeof clearTimerOption === 'function'
    ? clearTimerOption
    : (handle) => clearTimeout(handle)
  const getConfig = typeof getConfigOption === 'function' ? getConfigOption : defaultConfig

  const meta = Object.freeze({
    deviceId: String(deviceId ?? ''),
    clientId: String(clientId ?? ''),
    sessionId: String(sessionId ?? ''),
    remoteAddress: String(remoteAddress ?? ''),
  })

  let pipeline = null
  let vad = providedVad ?? null
  let vadBroken = false
  let currentState = 'idle'
  let currentTurn = null
  let turnSeq = 0
  let decoder = null
  let opened = false
  let closed = false
  let idleTimer = null
  const pipelineTimers = new Set()
  const idleDisconnectMs = resolveIdleDisconnectMs()

  // ── 下发通道 ──────────────────────────────────────────────────────────────

  /** 发给设备（内部收尾用：即使已进入 closing 也尽量把 tts stop 发出去）。 */
  function emitJson(obj) {
    if (typeof sendJsonRaw !== 'function') return false
    try {
      sendJsonRaw(obj)
      return true
    } catch (error) {
      log.warn('向设备发送 JSON 失败', { deviceId: meta.deviceId, type: obj?.type, error: messageOf(error) })
      return false
    }
  }

  function canSendTurn() {
    return !closed && currentTurn !== null && !currentTurn.signal.aborted
  }

  function contextSendJson(obj) {
    if (closed) return false
    return emitJson(obj)
  }

  function contextSendBinary(buffer) {
    if (!canSendTurn()) return false
    if (typeof sendBinaryRaw !== 'function') return false
    try {
      sendBinaryRaw(buffer)
      return true
    } catch (error) {
      log.warn('向设备发送音频失败', { deviceId: meta.deviceId, error: messageOf(error) })
      return false
    }
  }

  function sendStt(text) {
    if (!canSendTurn()) return false
    return emitJson({ type: 'stt', text: text == null ? '' : String(text) })
  }

  function sendTts(args) {
    if (!canSendTurn()) return false
    const { state, text } = args ?? {}
    if (!TTS_STATES.includes(state)) {
      log.warn('sendTts: 非法的 tts state', { deviceId: meta.deviceId, state: String(state) })
      return false
    }
    if (state === 'stop') {
      if (!currentTurn.ttsActive) {
        log.debug('sendTts: 未 start 的 stop 已忽略', { deviceId: meta.deviceId })
        return false
      }
      currentTurn.ttsActive = false
      return emitJson(text == null ? { type: 'tts', state: 'stop' } : { type: 'tts', state: 'stop', text })
    }
    if (state === 'start') currentTurn.ttsActive = true
    return emitJson(text == null ? { type: 'tts', state } : { type: 'tts', state, text })
  }

  function sendLlm(args) {
    if (!canSendTurn()) return false
    const { emotion = 'neutral', text = '' } = args ?? {}
    return emitJson({ type: 'llm', emotion, text })
  }

  /** 幂等收尾：同一轮只在 ttsActive 时发一次 stop。 */
  function flushTtsStop(turn) {
    if (!turn || !turn.ttsActive) return false
    turn.ttsActive = false
    return emitJson({ type: 'tts', state: 'stop' })
  }

  // ── 状态机 ────────────────────────────────────────────────────────────────

  function transition(nextState, transitionMeta = {}) {
    if (closed) {
      log.warn('会话已关闭，忽略状态迁移', { deviceId: meta.deviceId, to: String(nextState) })
      return false
    }
    if (!isSessionState(nextState)) {
      log.warn('非法会话状态，保持原状态', { deviceId: meta.deviceId, to: String(nextState) })
      return false
    }
    const previous = currentState
    if (previous === nextState) return true
    if (!isLegalTransition(previous, nextState)) {
      log.warn('非法状态迁移，保持原状态', {
        deviceId: meta.deviceId,
        from: previous,
        to: nextState,
        reason: transitionMeta?.reason,
      })
      return false
    }
    currentState = nextState
    log.debug('会话状态迁移', {
      deviceId: meta.deviceId,
      from: previous,
      to: nextState,
      reason: transitionMeta?.reason,
    })
    // 正常说完 / 回落监听时补一次 tts stop（管线显式发过则已是 no-op）。
    if (nextState === 'listening' && currentTurn) flushTtsStop(currentTurn)
    return true
  }

  // ── 管线调用与异常隔离 ────────────────────────────────────────────────────

  function failSession(error, source) {
    const message = messageOf(error)
    if (closed) {
      log.debug('会话关闭后管线回调仍失败（已忽略）', { deviceId: meta.deviceId, source, error: message })
      return
    }
    log.error('管线回调异常，关闭该设备会话', { deviceId: meta.deviceId, source, error: message })
    finishClosed(1011, 'session error', true)
  }

  function guardPromiseResult(result, source) {
    if (!isThenable(result)) return
    try {
      const handled = result.then(undefined, (error) => {
        try {
          failSession(error, source)
        } catch { /* 隔离：异常处理本身绝不外抛 */ }
      })
      if (handled && typeof handled.catch === 'function') handled.catch(noop)
    } catch (error) {
      failSession(error, source)
    }
  }

  function invokePipeline(name, ...args) {
    if (!pipeline || typeof pipeline[name] !== 'function') return
    try {
      guardPromiseResult(pipeline[name](...args), name)
    } catch (error) {
      failSession(error, name)
    }
  }

  // ── 定时器 ────────────────────────────────────────────────────────────────

  function resolveIdleDisconnectMs() {
    let value = idleDisconnectMsOption
    if (value == null) {
      try {
        value = getConfig()?.esp32?.idleDisconnectMs
      } catch (error) {
        log.warn('读取 esp32.idleDisconnectMs 失败，使用默认值', {
          deviceId: meta.deviceId,
          error: messageOf(error),
        })
      }
    }
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_IDLE_DISCONNECT_MS
  }

  function clearIdleTimer() {
    if (idleTimer != null) {
      try {
        clearTimer(idleTimer)
      } catch { /* 注入的 clearTimer 不应影响会话 */ }
      idleTimer = null
    }
  }

  function armIdleTimer() {
    clearIdleTimer()
    if (closed || !(idleDisconnectMs > 0)) return
    try {
      idleTimer = setTimer(() => {
        idleTimer = null
        if (closed) return
        log.info('设备空闲超时，关闭会话', { deviceId: meta.deviceId, idleDisconnectMs })
        finishClosed(1000, 'idle timeout', true)
      }, idleDisconnectMs)
    } catch (error) {
      idleTimer = null
      log.warn('设置空闲定时器失败，空闲断开已禁用', {
        deviceId: meta.deviceId,
        error: messageOf(error),
      })
    }
  }

  function touchIdle() {
    if (closed) return
    armIdleTimer()
  }

  function clearPipelineTimers() {
    for (const handle of pipelineTimers) {
      try {
        clearTimer(handle)
      } catch { /* 忽略 */ }
    }
    pipelineTimers.clear()
  }

  function contextSetTimer(fn, ms) {
    if (closed || typeof fn !== 'function') return null
    let handle
    const run = () => {
      pipelineTimers.delete(handle)
      if (closed) return
      try {
        guardPromiseResult(fn(), 'timer')
      } catch (error) {
        failSession(error, 'timer')
      }
    }
    try {
      handle = setTimer(run, ms)
    } catch (error) {
      log.warn('注册管线定时器失败', { deviceId: meta.deviceId, error: messageOf(error) })
      return null
    }
    pipelineTimers.add(handle)
    return handle
  }

  function contextClearTimer(handle) {
    pipelineTimers.delete(handle)
    try {
      clearTimer(handle)
    } catch { /* 忽略 */ }
  }

  // ── 轮次管理 ──────────────────────────────────────────────────────────────

  function cancelTurn(reason, { notify = true } = {}) {
    const turn = currentTurn
    if (!turn) return false
    currentTurn = null
    try {
      turn.controller.abort(createAbortError(reason))
    } catch { /* AbortController.abort 不应抛 */ }
    flushTtsStop(turn)
    if (notify) invokePipeline('onAbort', { reason: String(reason) })
    return true
  }

  function normalizeMode(mode) {
    if (typeof mode === 'string' && LISTEN_MODES.includes(mode)) return mode
    if (mode !== undefined) {
      log.debug('未知 listen.mode，按 auto 处理', { deviceId: meta.deviceId, mode: String(mode) })
    }
    return 'auto'
  }

  function beginTurn({ mode, detect = false, text = '' }) {
    if (closed) return null
    // 新轮次取消旧轮次（abort signal + tts 收尾 + onAbort 通知）。
    cancelTurn(detect ? 'listen_detect' : 'listen_start', { notify: true })
    const turn = {
      id: ++turnSeq,
      mode,
      detect,
      controller: new AbortController(),
      signal: null,
      ttsActive: false,
      frames: 0,
      samples: 0,
      startedAt: now(),
    }
    turn.signal = turn.controller.signal
    currentTurn = turn
    transition('listening', { reason: detect ? 'listen_detect' : 'listen_start' })
    invokePipeline('onListenStart', detect ? { mode, detect: true, text } : { mode })
    touchIdle()
    return turn
  }

  // ── 协议入口 ──────────────────────────────────────────────────────────────

  function openSession(helloJson) {
    if (opened || closed) return
    opened = true
    invokePipeline('onOpen', { hello: helloJson })
  }

  function handleListenStop() {
    const turn = currentTurn
    if (!turn) {
      log.debug('listen stop：当前没有活动轮次', { deviceId: meta.deviceId })
      return
    }
    if (currentState !== 'listening') {
      log.debug('listen stop：非监听状态，忽略', { deviceId: meta.deviceId, state: currentState })
      return
    }
    if (turn.detect) {
      // 唤醒检测阶段结束：不进 ASR，也不进入 recognizing，直接结束本轮。
      cancelTurn('listen_stop', { notify: true })
      if (!closed) currentState = 'idle'
      touchIdle()
      return
    }
    // manual 模式以 stop 为整段结束；auto 模式收到 stop 也按结束处理（容错）。
    // 此前所有音频帧都已通过 onAudio 交付，管线自行保留整段缓冲。
    invokePipeline('onListenStop')
    if (!closed && currentTurn && currentState === 'listening') {
      transition('recognizing', { reason: 'listen_stop' })
    }
  }

  function handleListen(json) {
    const listenState = typeof json.state === 'string' ? json.state : ''
    if (listenState === 'start') {
      beginTurn({ mode: normalizeMode(json.mode), detect: false })
      return
    }
    if (listenState === 'detect') {
      beginTurn({
        mode: normalizeMode(json.mode),
        detect: true,
        text: typeof json.text === 'string' ? json.text : '',
      })
      return
    }
    if (listenState === 'stop') {
      handleListenStop()
      return
    }
    log.debug('忽略未知 listen.state', { deviceId: meta.deviceId, state: listenState })
  }

  function abort(reason = 'abort') {
    if (closed) return false
    touchIdle()
    if (!currentTurn) {
      log.debug('abort：当前没有活动轮次', { deviceId: meta.deviceId, reason: String(reason) })
      return false
    }
    const normalized = reason == null || reason === '' ? 'abort' : String(reason)
    cancelTurn(normalized, { notify: true })
    // 回落 listening：设备在 auto 模式下继续走下一轮；无轮次时重复 abort 是 no-op。
    transition('listening', { reason: 'abort' })
    return true
  }

  function handleJson(json) {
    if (closed) return
    touchIdle()
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      log.debug('忽略非对象 JSON 消息', { deviceId: meta.deviceId })
      return
    }
    const type = typeof json.type === 'string' ? json.type : ''
    if (type === 'hello') {
      openSession(json)
      return
    }
    if (type === 'listen') {
      handleListen(json)
      return
    }
    if (type === 'abort') {
      abort(typeof json.reason === 'string' && json.reason.trim() ? json.reason.trim() : 'abort')
      return
    }
    // mcp / 未知类型：忽略且不报错（协议兼容）。
    log.debug('忽略未知消息类型', { deviceId: meta.deviceId, type })
  }

  function handleVadEvent(event) {
    if (closed || !currentTurn) return
    const signal = currentTurn.signal
    invokePipeline('onVad', event, { signal })
    // VAD 判定整段结束：会话负责进入 recognizing；后续 ASR/LLM 由管线推进。
    if (event?.type === 'speech_end' && !closed && currentTurn && currentState === 'listening') {
      transition('recognizing', { reason: typeof event.reason === 'string' ? event.reason : 'vad' })
    }
  }

  function handleAudio(chunk) {
    if (closed) return
    touchIdle()
    let packet = chunk
    if (packet instanceof ArrayBuffer) packet = new Uint8Array(packet)
    if (!(packet instanceof Uint8Array)) {
      log.warn('handleAudio: 需要 Buffer/Uint8Array，已丢弃', {
        deviceId: meta.deviceId,
        received: typeof chunk,
      })
      return
    }

    const turn = currentTurn
    if (!turn || currentState !== 'listening' || turn.detect) {
      log.debug('非监听状态音频已丢弃', {
        deviceId: meta.deviceId,
        state: currentState,
        detect: turn?.detect === true,
      })
      return
    }

    let frame
    try {
      if (!decoder) decoder = new OpusUplinkDecoder()
      frame = decoder.decode(packet)
    } catch (error) {
      // 解码失败只丢该包：不抛给网关，也不关闭连接。
      log.warn('Opus 上行解码失败，丢弃该包', {
        deviceId: meta.deviceId,
        bytes: packet.byteLength,
        error: messageOf(error),
      })
      return
    }

    turn.frames += 1
    turn.samples += frame.length
    const wasListening = currentState === 'listening'
    // 先交付音频帧，再跑 VAD，保证管线在 speech_end 前已收到尾帧。
    invokePipeline('onAudio', frame, { sampleRate: AUDIO.uplink.sampleRate, samples: frame.length })

    if (
      wasListening
      && !closed
      && currentTurn === turn
      && vad
      && !vadBroken
      && turn.mode !== 'manual'
      && !turn.detect
      && typeof vad.push === 'function'
    ) {
      try {
        const events = vad.push(frame)
        if (Array.isArray(events)) {
          for (const event of events) handleVadEvent(event)
        }
      } catch (error) {
        // VAD 是会话内组件：出错后停用 VAD，但不因此关闭设备连接。
        vadBroken = true
        log.error('VAD 处理失败，本会话后续不再使用 VAD', {
          deviceId: meta.deviceId,
          error: messageOf(error),
        })
      }
    }
  }

  // ── 关闭 ──────────────────────────────────────────────────────────────────

  /**
   * 统一关闭路径。
   * @param {number} code 传给网关 close 的关闭码
   * @param {string} reason 关闭原因
   * @param {boolean} callInjectedClose 是否调用网关注入的 close（idle/异常需要，连接清理本身不需要）
   */
  function finishClosed(code, reason, callInjectedClose) {
    if (closed) return false
    closed = true
    clearIdleTimer()
    clearPipelineTimers()

    const turn = currentTurn
    currentTurn = null
    if (turn) {
      try {
        turn.controller.abort(createAbortError(reason))
      } catch { /* 忽略 */ }
      flushTtsStop(turn)
      invokePipeline('onAbort', { reason: String(reason) })
    }

    currentState = 'idle'
    if (decoder) {
      try {
        decoder.close()
      } catch (error) {
        log.warn('关闭 Opus 解码器失败', { deviceId: meta.deviceId, error: messageOf(error) })
      }
      decoder = null
    }
    if (vad && typeof vad.close === 'function') {
      try {
        vad.close()
      } catch (error) {
        log.debug('关闭 VAD 失败', { deviceId: meta.deviceId, error: messageOf(error) })
      }
    }

    invokePipeline('onClose')

    if (callInjectedClose && typeof closeRaw === 'function') {
      try {
        closeRaw(code, reason)
      } catch (error) {
        log.warn('关闭设备连接失败', { deviceId: meta.deviceId, error: messageOf(error) })
      }
    }
    return true
  }

  function close() {
    return finishClosed(1000, 'session closed', false)
  }

  // ── 组装 ctx / 初始化 ─────────────────────────────────────────────────────

  const ctx = Object.freeze({
    ...meta,
    logger: log,
    sendJson: contextSendJson,
    sendBinary: contextSendBinary,
    getState: () => currentState,
    transition,
    sendStt,
    sendTts,
    sendLlm,
    now,
    setTimer: contextSetTimer,
    clearTimer: contextClearTimer,
    getSignal: () => (closed ? null : currentTurn?.signal ?? null),
  })

  if (providedPipeline) {
    pipeline = providedPipeline
  } else if (typeof createPipelineOption === 'function') {
    try {
      pipeline = createPipelineOption(ctx)
    } catch (error) {
      failSession(error, 'createPipeline')
    }
  }
  if (pipeline && typeof pipeline !== 'object') {
    log.warn('createPipeline 未返回对象，按无管线运行', { deviceId: meta.deviceId })
    pipeline = null
  }

  if (!closed) {
    if (vad && typeof vad.push !== 'function') {
      log.warn('注入的 VAD 缺少 push()，已忽略', { deviceId: meta.deviceId })
      vad = null
    } else if (!vad && typeof createVadOption === 'function') {
      try {
        vad = createVadOption(ctx)
        if (vad && typeof vad.push !== 'function') {
          log.warn('createVad 未返回带 push() 的对象，已忽略', { deviceId: meta.deviceId })
          vad = null
        }
      } catch (error) {
        log.error('创建 VAD 失败，本会话不跑 VAD', { deviceId: meta.deviceId, error: messageOf(error) })
        vad = null
      }
    }
  }

  if (hello !== null && hello !== undefined) openSession(hello)
  if (!closed) armIdleTimer()

  return {
    get state() {
      return currentState
    },
    handleJson,
    handleAudio,
    abort,
    close,
  }
}
