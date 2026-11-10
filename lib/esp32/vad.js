// ESP32 通道 VAD（T11）：能量阈值 + 自适应噪声底 + 双阈值迟滞 + hangover + 最长语音。
//
// 设计依据：docs/2026-11-10-esp32-feiyu-channel-design.md §6.4（工作区 docs/）。
// 契约默认值来自 lib/esp32/contracts.js 的 DEFAULT_ESP32_CONFIG.vad。
//
// ── 对外契约 ────────────────────────────────────────────────────────────────
// createVad(options?) → {
//   push(pcm: Int16Array) → VadEvent[],   // 16k 单声道 PCM16，长度任意
//   flush() → VadEvent[],                 // 结束仍在进行的语音段（reason:'flush'）
//   reset() → void,                       // 清空全部状态（含时间轴、噪声底）
//   state: 'silence'|'candidate'|'speech',
//   isSpeech: boolean,                    // state === 'speech'（含 hangover 静音）
//   noiseFloor: number,                   // 当前自适应噪声底（RMS，Int16 幅度）
//   thresholds: {start,end},              // 当前起/止阈值（调试/日志用）
//   stats: {frames,voicedFrames,segments},
//   config: 只读配置（默认值 + options 覆盖 + 派生帧长）
// }
//
// 事件：
//   {type:'speech_start', atMs}
//   {type:'speech_end', atMs, reason:'silence'|'max'|'flush'}
// atMs 是**累计输入时间**（毫秒），与 chunk 切分无关。speech_start 回溯到首个
// 过阈帧的帧首；speech_end(silence) 的时间点包含 silenceMs（默认 700ms）尾静音。
//
// ── 算法要点 ────────────────────────────────────────────────────────────────
// * 内部固定按 frameMs（默认 20ms = 320 点）处理，碎片与整帧可任意混喂。
// * 噪声底：预热窗口（默认 200ms）取帧能量最小值（设上限，避免开口即语音时
//   把阈值抬死）；之后仅在非语音段（silence，无候选）用 EMA 更新。
// * 双阈值迟滞：起始阈值 = max(minRms, noiseFloor×startFactor)（带上限保护），
//   结束阈值更低。短于 minSpeechMs 的脉冲只进入 candidate，不会产生事件。
// * hangover：语音段内连续静音达到 silenceMs 才发 speech_end(silence)。
// * maxSpeechMs：段长达到上限强制 speech_end(max)；若当前帧仍有语音能量，
//   立即以截断点为新候选段起点，继续正常判定（可再次 speech_start）。
// * 内存有界：只保留当前 20ms 帧缓冲与帧级统计，不累积 PCM。
//
// ── A 道（会话）接入注意 ────────────────────────────────────────────────────
// 1. VAD 不缓存 PCM。speech_start 需等 minSpeechMs 确认后才发出，atMs 会回溯到
//    真实起点；A 道需自留 ≥minSpeechMs 的预滚环形缓冲，按 atMs 裁剪 WAV。
// 2. isSpeech 为 true 期间持续累积 PCM（含 hangover 静音）；speech_end 后用
//    [speech_start.atMs, speech_end.atMs) 的音频送 ASR。
// 3. 单次 push 可能返回多个事件（如 max 截断后重新触发），按数组顺序处理。
// 4. listen mode=manual 时以 listen stop 为结束，不跑 VAD（由 A 道决定）。

import { DEFAULT_ESP32_CONFIG } from './contracts.js'

/** 内部状态取值（对外通过 state 暴露）。 */
export const VAD_STATES = Object.freeze(['silence', 'candidate', 'speech'])

/** 可调参数默认值；silenceMs/minSpeechMs/maxSpeechMs 以 contracts 为准。 */
const TUNING_DEFAULTS = Object.freeze({
  sampleRate: 16000, // 上行固定 16k
  frameMs: 20, // 内部分析帧长
  startFactor: 3, // 起始阈值 = noiseFloor × startFactor
  endFactor: 1.5, // 结束阈值 = noiseFloor × endFactor（迟滞）
  minRms: 100, // 绝对下限（RMS，Int16 幅度），纯静音不触发
  noiseFloorMin: 8,
  noiseFloorMax: 6000,
  initialNoiseFloor: 60,
  noiseFloorPreheatFrames: 10, // 200ms 预热窗口
  preheatFloorCap: 1500, // 预热噪声底上限：开口即语音时不把阈值抬死
  startThresholdCeil: 4000, // 起始阈值上限：极响底噪/预热污染时仍可被正常语音触发
  endThresholdCeil: 3000,
  noiseAdaptUp: 0.02, // 非语音段噪声底上升（慢，避免瞬态抬高）
  noiseAdaptDown: 0.1, // 非语音段噪声底下降（稍快，适应安静环境）
})

const OPTION_KEYS = Object.freeze([
  ...Object.keys(TUNING_DEFAULTS),
  'silenceMs',
  'minSpeechMs',
  'maxSpeechMs',
])

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function resolveConfig(options) {
  if (options === undefined || options === null) options = {}
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createVad: options 必须是对象')
  }

  const cfg = { ...DEFAULT_ESP32_CONFIG.vad, ...TUNING_DEFAULTS }
  for (const key of OPTION_KEYS) {
    if (options[key] !== undefined) cfg[key] = options[key]
  }

  const assertNumber = (key, { min = 0, integer = false, exclusive = false } = {}) => {
    const v = cfg[key]
    const ok =
      typeof v === 'number' &&
      Number.isFinite(v) &&
      (exclusive ? v > min : v >= min) &&
      (!integer || Number.isInteger(v))
    if (!ok) {
      const bound = exclusive ? `> ${min}` : `>= ${min}`
      throw new RangeError(
        `createVad: ${key} 必须是${integer ? '整数' : '数字'}且 ${bound}，收到 ${String(v)}`,
      )
    }
  }

  assertNumber('sampleRate', { min: 0, integer: true, exclusive: true })
  assertNumber('frameMs', { min: 0, exclusive: true })
  assertNumber('silenceMs', { min: 0, exclusive: true })
  assertNumber('minSpeechMs', { min: 0 })
  assertNumber('maxSpeechMs', { min: 0, exclusive: true })
  assertNumber('startFactor', { min: 0, exclusive: true })
  assertNumber('endFactor', { min: 0, exclusive: true })
  assertNumber('minRms', { min: 0, exclusive: true })
  assertNumber('noiseFloorMin', { min: 0 })
  assertNumber('noiseFloorMax', { min: 0, exclusive: true })
  assertNumber('initialNoiseFloor', { min: 0 })
  assertNumber('noiseFloorPreheatFrames', { min: 0, integer: true })
  assertNumber('preheatFloorCap', { min: 0, exclusive: true })
  assertNumber('startThresholdCeil', { min: 0, exclusive: true })
  assertNumber('endThresholdCeil', { min: 0, exclusive: true })
  assertNumber('noiseAdaptUp', { min: 0 })
  assertNumber('noiseAdaptDown', { min: 0 })

  if (cfg.noiseFloorMin > cfg.noiseFloorMax) {
    throw new RangeError('createVad: noiseFloorMin 不能大于 noiseFloorMax')
  }
  if (cfg.noiseAdaptUp > 1 || cfg.noiseAdaptDown > 1) {
    throw new RangeError('createVad: noiseAdaptUp/noiseAdaptDown 必须在 [0,1]')
  }

  const frameSamples = Math.round((cfg.sampleRate * cfg.frameMs) / 1000)
  if (frameSamples < 1) {
    throw new RangeError(`createVad: frameMs=${cfg.frameMs} 在 ${cfg.sampleRate} Hz 下不足 1 点`)
  }

  Object.assign(cfg, {
    frameSamples,
    silenceSamples: Math.round((cfg.sampleRate * cfg.silenceMs) / 1000),
    minSpeechSamples: Math.round((cfg.sampleRate * cfg.minSpeechMs) / 1000),
    maxSpeechSamples: Math.round((cfg.sampleRate * cfg.maxSpeechMs) / 1000),
  })
  return Object.freeze(cfg)
}

/** 单帧 RMS 能量（Int16 幅度）。n 为当前帧实际点数（flush 残余可能不足一帧）。 */
function frameRms(pcm, n) {
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = pcm[i]
    sum += x * x
  }
  return Math.sqrt(sum / n)
}

const samplesToMs = (samples, sampleRate) => (samples * 1000) / sampleRate

class EnergyVad {
  constructor(config) {
    this.config = config
    this._frame = new Int16Array(config.frameSamples)
    this.reset()
  }

  reset() {
    this._filled = 0
    this._frameStartSample = 0
    this._totalSamples = 0
    this._state = 'silence'
    this._candidateStartSample = 0
    this._segmentStartSample = 0
    this._silenceRunSamples = 0
    this._preheatRemaining = this.config.noiseFloorPreheatFrames
    this._preheatMin = Infinity
    this._noiseFloor = this.config.initialNoiseFloor
    this._frames = 0
    this._voicedFrames = 0
    this._segments = 0
    this._frame.fill(0)
  }

  get state() {
    return this._state
  }

  get isSpeech() {
    return this._state === 'speech'
  }

  get noiseFloor() {
    return this._noiseFloor
  }

  get thresholds() {
    return this._thresholds()
  }

  get stats() {
    return Object.freeze({
      frames: this._frames,
      voicedFrames: this._voicedFrames,
      segments: this._segments,
    })
  }

  _thresholds() {
    const c = this.config
    const start = Math.min(
      Math.max(c.minRms, this._noiseFloor * c.startFactor),
      c.startThresholdCeil,
    )
    // 结束阈值的绝对下限贴近 minRms：若预热只见到数字静音（noiseFloor 落到下限），
    // 低幅环境底噪（RMS 低于 minRms）仍应被判为静音，否则 hangover 永远计不满。
    const end = Math.min(
      Math.max(c.minRms * 0.8, this._noiseFloor * c.endFactor),
      c.endThresholdCeil,
      start,
    )
    return { start, end }
  }

  /**
   * 喂入任意长度的 16k 单声道 PCM16。
   * @param {Int16Array} pcm
   * @returns {Array<{type:'speech_start',atMs:number}|{type:'speech_end',atMs:number,reason:'silence'|'max'|'flush'}>}
   */
  push(pcm) {
    if (!(pcm instanceof Int16Array)) {
      throw new TypeError('Vad.push: 需要 Int16Array（16k 单声道 PCM16）')
    }
    const events = []
    const frameSamples = this.config.frameSamples

    let offset = 0
    while (offset < pcm.length) {
      if (this._filled === 0) this._frameStartSample = this._totalSamples
      const take = Math.min(frameSamples - this._filled, pcm.length - offset)
      this._frame.set(pcm.subarray(offset, offset + take), this._filled)
      this._filled += take
      this._totalSamples += take
      offset += take

      if (this._filled === frameSamples) {
        this._processFrame(this._frame, frameSamples, this._frameStartSample, events)
        this._filled = 0
      }
    }
    return events
  }

  /** 结束当前语音段；残余不足一帧的 PCM 先按实际长度参与判定。 */
  flush() {
    const events = []
    if (this._filled > 0) {
      this._processFrame(
        this._frame.subarray(0, this._filled),
        this._filled,
        this._frameStartSample,
        events,
      )
      this._filled = 0
    }
    if (this._state === 'speech') {
      events.push({
        type: 'speech_end',
        atMs: samplesToMs(this._totalSamples, this.config.sampleRate),
        reason: 'flush',
      })
    }
    this._state = 'silence'
    this._silenceRunSamples = 0
    return events
  }

  /**
   * 处理一个内部帧。startSample 是该帧首采样在累计时间轴上的位置。
   * 事件时间一律由采样数换算，因此与外部 chunk 切分无关。
   */
  _processFrame(buf, n, startSample, events) {
    const c = this.config
    const endSample = startSample + n
    this._frames += 1

    const rms = frameRms(buf, n)

    // 预热：取帧能量最小值作为初始噪声底（设上限，避免开口即语音时阈值被抬死）。
    if (this._preheatRemaining > 0) {
      this._preheatRemaining -= 1
      if (rms < this._preheatMin) this._preheatMin = rms
      this._noiseFloor = clamp(
        Math.min(this._preheatMin, c.preheatFloorCap),
        c.noiseFloorMin,
        c.noiseFloorMax,
      )
    }

    const { start: startThreshold, end: endThreshold } = this._thresholds()

    if (this._state === 'silence' && rms >= startThreshold) {
      this._state = 'candidate'
      this._candidateStartSample = startSample
    }

    if (this._state === 'candidate') {
      // 迟滞：候选段内只需高于结束阈值即可延续。
      if (rms >= endThreshold) {
        if (endSample - this._candidateStartSample >= c.minSpeechSamples) {
          this._state = 'speech'
          this._segmentStartSample = this._candidateStartSample
          this._silenceRunSamples = 0
          this._segments += 1
          events.push({
            type: 'speech_start',
            atMs: samplesToMs(this._segmentStartSample, c.sampleRate),
          })
        }
      } else {
        // minSpeechMs 内的短促脉冲：不产生 speech_start，直接撤销候选。
        this._state = 'silence'
      }
    }

    if (this._state === 'speech') {
      this._voicedFrames += rms >= endThreshold ? 1 : 0

      if (rms >= endThreshold) {
        this._silenceRunSamples = 0
      } else {
        this._silenceRunSamples += n
      }

      // 自然结束：hangover 静音计满 silenceMs（这段时间包含在语音段内）。
      if (this._silenceRunSamples >= c.silenceSamples) {
        events.push({
          type: 'speech_end',
          atMs: samplesToMs(endSample, c.sampleRate),
          reason: 'silence',
        })
        this._state = 'silence'
        this._silenceRunSamples = 0
        return
      }

      // 最长语音：硬截断，并立即开始新的判定段。
      if (endSample - this._segmentStartSample >= c.maxSpeechSamples) {
        const cutSample = this._segmentStartSample + c.maxSpeechSamples
        events.push({
          type: 'speech_end',
          atMs: samplesToMs(cutSample, c.sampleRate),
          reason: 'max',
        })
        this._silenceRunSamples = 0
        if (rms >= endThreshold) {
          // 当前帧末尾仍在说话：从截断点起算新候选段，满 minSpeechMs 后再次触发。
          this._state = 'candidate'
          this._candidateStartSample = cutSample
        } else {
          this._state = 'silence'
          this._adaptNoise(rms)
        }
      }
      return
    }

    // 仅非语音段更新噪声底；candidate 可能是语音，保持冻结。
    if (this._state === 'silence') this._adaptNoise(rms)
  }

  _adaptNoise(rms) {
    if (this._preheatRemaining > 0) return
    const c = this.config
    const alpha = rms > this._noiseFloor ? c.noiseAdaptUp : c.noiseAdaptDown
    this._noiseFloor = clamp(
      this._noiseFloor + alpha * (rms - this._noiseFloor),
      c.noiseFloorMin,
      c.noiseFloorMax,
    )
  }
}

/**
 * 创建一个串行、无全局状态的 VAD 实例（每设备一个）。
 * @param {Partial<{
 *   sampleRate:number, frameMs:number, silenceMs:number, minSpeechMs:number,
 *   maxSpeechMs:number, startFactor:number, endFactor:number, minRms:number,
 *   noiseFloorMin:number, noiseFloorMax:number, initialNoiseFloor:number,
 *   noiseFloorPreheatFrames:number, preheatFloorCap:number,
 *   startThresholdCeil:number, endThresholdCeil:number,
 *   noiseAdaptUp:number, noiseAdaptDown:number
 * }>} [options]
 */
export function createVad(options) {
  return new EnergyVad(resolveConfig(options))
}
