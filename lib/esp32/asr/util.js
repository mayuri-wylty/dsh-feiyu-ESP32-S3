// T15：ASR provider 共用的输入校验/取消/超时工具。
// 说明：本文件不 import 其他泳道（如 lib/esp32/tts/*），避免跨道耦合。

/** 把 signal 的中止原因规范成 AbortError；用户取消必须原样可识别。 */
export function abortErrorOf(signal) {
  const reason = signal?.reason
  if (reason && typeof reason === 'object' && reason.name === 'AbortError') return reason
  const e = new Error('ASR 请求已取消')
  e.name = 'AbortError'
  e.code = 'ABORT_ERR'
  return e
}

/** 超时错误：name 固定 TimeoutError，回退层据此视为主失败（可回退）。 */
export function timeoutError(timeoutMs) {
  const e = new Error(`ASR 请求超时（${timeoutMs}ms）`)
  e.name = 'TimeoutError'
  e.code = 'ETIMEDOUT'
  return e
}

/** 输入必须是完整 WAV 字节；缺失/空数组属于调用方 bug，直接清晰报错。 */
export function assertWavInput(wav, providerLabel) {
  if (!(wav instanceof Uint8Array) || wav.length === 0) {
    throw new Error(
      `${providerLabel}：ASR 输入 wav 缺失或为空（需要完整 16k/mono/PCM16 WAV 字节）`,
    )
  }
}

/** 语言标签归一化：去空白；空串表示不指定。 */
export function normalizeLanguage(value) {
  return String(value ?? '').trim()
}

/** 合并用户 signal 与超时 signal（Node 20+ 有 AbortSignal.any；老运行时逐级兜底）。 */
export function combineSignals(userSignal, timeoutSignal) {
  if (!userSignal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([userSignal, timeoutSignal])
  const ctrl = new AbortController()
  const forward = (signal) => {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  }
  forward(userSignal)
  forward(timeoutSignal)
  return ctrl.signal
}
