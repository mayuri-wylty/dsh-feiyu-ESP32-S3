// Opus 编解码封装（opusscript 0.1.1，libopus 1.4 WASM）。
//
// ── 底层语义（已在 test/esp32-audio-test.mjs 中用断言钉死）──────────────────
//
// opusscript.encode(buffer, frameSize)
//   * frameSize 的单位是**每声道采样点数**，不是字节。libopus 的 opus_encode()
//     直接把它当采样数：16k/60ms → 960，24k/60ms → 1440。
//   * buffer 必须是 **PCM16 little-endian 字节**（Buffer/Uint8Array），长度 =
//     frameSize × channels × 2。wasm 胶水层把 buffer.length 当字节数传给 C++，
//     C++ 再把字节重排回 int16；若直接传 Int16Array，会被逐元素复制成 Uint16
//     元素、长度又被当成字节数，编码结果是噪声。本模块在内部完成
//     Int16Array → LE Buffer 的转换，对外只收 Int16Array。
//
// opusscript.decode(packet)
//   * 0.1.1 的签名**没有 frameSize 参数**（多传的参数被 JS 静默忽略），输出
//     帧长由 Opus 包头决定。
//   * 返回 Buffer，length 的单位是**字节** = 采样点数 × channels × 2。
//     16k/60ms → 1920 B = 960 点；24k/60ms → 2880 B = 1440 点。
//     “请求 1440 返回 2880”中的 2880 是字节数，不是采样点数。
//   * 本模块把返回的 LE 字节流解析为 Int16Array 再交给调用方。
//
// ── 对接契约（lib/esp32/contracts.js 的 AUDIO）──────────────────────────────
//   上行：设备发送 16k/mono/60ms Opus 包 → OpusUplinkDecoder → 960 点 Int16Array。
//   下行：TTS 输出 24k/mono/60ms PCM → OpusDownlinkEncoder → Opus 包。
//
// 注意：opusscript 的 WASM 内存需要显式 delete() 释放；本模块的 close() 做了
// 幂等封装，长生命周期对象（每设备一个）应在断开时调用。

import OpusScript from 'opusscript'

import { AUDIO } from '../contracts.js'

// libopus 合法帧长：2.5/5/10/20/40/60 ms（某些采样率下 2.5ms 不是整数点）。
const FRAME_DURATIONS_MS = [2.5, 5, 10, 20, 40, 60]

const OPUS_RESET_STATE = 4022
const OPUS_SET_BITRATE = 4002

const validFrameSamplesCache = new Map()

function validFrameSamplesFor(sampleRate) {
  let set = validFrameSamplesCache.get(sampleRate)
  if (!set) {
    set = new Set(
      FRAME_DURATIONS_MS.map((ms) => (sampleRate * ms) / 1000).filter((n) => Number.isInteger(n)),
    )
    validFrameSamplesCache.set(sampleRate, set)
  }
  return set
}

function assertSampleRate(sampleRate) {
  if (!OpusScript.VALID_SAMPLING_RATES.includes(sampleRate)) {
    throw new RangeError(
      `Opus: 非法采样率 ${sampleRate}（支持 ${OpusScript.VALID_SAMPLING_RATES.join(', ')} Hz）`,
    )
  }
}

function normalizePacket(packet) {
  if (packet instanceof Uint8Array) return packet // Node Buffer 也是 Uint8Array
  if (packet instanceof ArrayBuffer) return new Uint8Array(packet)
  throw new TypeError('Opus decode: 需要 Buffer/Uint8Array 类型的 Opus 包')
}

/**
 * 修正 opusscript 0.1.1 的 PCM 视图指针错位（不改 node_modules，只调整实例）。
 *
 * index.js 用 `HEAPU16.subarray(ptr, ptr + len)` 建 PCM 视图，并把
 * `view.byteOffset` 传给 C++ 当字节地址；但 subarray 的索引单位是 Uint16
 * 元素，于是 `view.byteOffset === ptr * 2`。结果 JS 与 C++ 都使用 2*ptr 处的
 * 内存，而 `delete()` 里 `_free(ptr)` 释放的是 ptr 处。单实例、堆空间充足时
 * 2*ptr 仍落在空闲区，问题不易暴露；多实例并存时 2*ptr 可能落进别的实例的
 * 分配块，开发期在多实例编解码后调用 delete() 曾稳定观察到
 * “RuntimeError: memory access out of bounds”。
 *
 * 这里把 inPCM/outPCM 重新锚定到 malloc 返回的真实字节地址，元素数取
 * 字节数/2（恰好覆盖分配块），JS 与 C++ 从此读写同一块内存，语义不变。
 * 该修正也让 encode 的输入重排和 decode 的输出不再写到分配块之外。
 */
function anchorPcmViewsToAllocation(codec) {
  const memory = codec.inPCM.buffer
  codec.inPCM = new Uint16Array(memory, codec.inPCMPointer, codec.inPCMLength / 2)
  codec.outPCM = new Uint16Array(memory, codec.outPCMPointer, codec.outPCMLength / 2)
}

/** opusscript.decode 返回的 LE PCM16 字节流 → Int16Array（单声道） */
function pcmBytesToInt16(bytes) {
  const samples = new Int16Array(bytes.byteLength >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true)
  return samples
}

/** Int16Array → opusscript.encode 要求的 LE PCM16 字节 Buffer（显式写入，不依赖宿主端序） */
function int16ToPcmBytes(pcm) {
  const bytes = Buffer.allocUnsafe(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], i * 2)
  return bytes
}

/** 通用 Opus 解码器：输入 Opus 包，输出单声道 Int16Array（采样率由构造参数决定）。 */
export class OpusDecoder {
  constructor(sampleRate) {
    assertSampleRate(sampleRate)
    this.sampleRate = sampleRate
    this.channels = 1
    this._codec = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP)
    anchorPcmViewsToAllocation(this._codec)
  }

  /**
   * @param {Uint8Array|ArrayBuffer} packet Opus 包
   * @returns {Int16Array} 解码后的 PCM16 采样（长度由包内帧长决定）
   */
  decode(packet) {
    this._assertOpen()
    const bytes = normalizePacket(packet)
    if (bytes.byteLength === 0) {
      throw new Error('Opus decode: packet 为空（0 字节）')
    }
    if (bytes.byteLength > OpusScript.MAX_PACKET_SIZE) {
      throw new Error(
        `Opus decode: packet 长度 ${bytes.byteLength} 超过上限 ${OpusScript.MAX_PACKET_SIZE}`,
      )
    }
    // 注意：opusscript 0.1.1 的 decode 无 frameSize 参数；返回值长度单位是字节。
    const pcmBytes = this._codec.decode(bytes)
    return pcmBytesToInt16(pcmBytes)
  }

  /** 重置解码器状态（丢包/打断后可用，避免 PLC 历史串扰）。 */
  reset() {
    this._assertOpen()
    this._codec.decoderCTL(OPUS_RESET_STATE, 0)
  }

  /** 释放 WASM 内存；幂等。 */
  close() {
    if (this._codec) {
      this._codec.delete()
      this._codec = null
    }
  }

  _assertOpen() {
    if (!this._codec) throw new Error('OpusDecoder 已关闭')
  }
}

/** 通用 Opus 编码器：输入单声道 Int16Array 帧，输出 Opus 包。 */
export class OpusEncoder {
  /**
   * @param {number} sampleRate 8000/12000/16000/24000/48000
   * @param {{application?: number, bitrate?: number}} [options]
   */
  constructor(sampleRate, options = {}) {
    assertSampleRate(sampleRate)
    this.sampleRate = sampleRate
    this.channels = 1
    this._validFrameSamples = validFrameSamplesFor(sampleRate)
    this._codec = new OpusScript(
      sampleRate,
      1,
      options.application === undefined ? OpusScript.Application.AUDIO : options.application,
    )
    anchorPcmViewsToAllocation(this._codec)
    if (options.bitrate !== undefined) this.setBitrate(options.bitrate)
  }

  /**
   * @param {Int16Array} pcm 单声道 PCM16，帧长必须是该采样率下的合法 Opus 帧长
   * @returns {Buffer} Opus 包
   */
  encode(pcm) {
    this._assertOpen()
    if (!(pcm instanceof Int16Array)) {
      throw new TypeError('Opus encode: 需要 Int16Array（单声道 PCM16）')
    }
    if (pcm.length === 0) {
      throw new RangeError('Opus encode: 帧不能为空')
    }
    if (!this._validFrameSamples.has(pcm.length)) {
      throw new RangeError(
        `Opus encode: 非法帧长 ${pcm.length} 点（${this.sampleRate} Hz 支持 ` +
          `${[...this._validFrameSamples].join('/')} 点，即 2.5–60ms）`,
      )
    }
    // frameSize 传采样点数；输入必须是 LE 字节流（见文件头说明）。
    return this._codec.encode(int16ToPcmBytes(pcm), pcm.length)
  }

  /** 设置目标码率（bps），例如 24000。 */
  setBitrate(bps) {
    this._assertOpen()
    if (!Number.isInteger(bps) || bps <= 0) {
      throw new RangeError(`Opus setBitrate: 非法码率 ${bps}`)
    }
    this._codec.encoderCTL(OPUS_SET_BITRATE, bps)
  }

  /** 重置编码器状态。 */
  reset() {
    this._assertOpen()
    this._codec.encoderCTL(OPUS_RESET_STATE, 0)
  }

  /** 释放 WASM 内存；幂等。 */
  close() {
    if (this._codec) {
      this._codec.delete()
      this._codec = null
    }
  }

  _assertOpen() {
    if (!this._codec) throw new Error('OpusEncoder 已关闭')
  }
}

/** 上行专用：16k/mono 解码器（设备 → 云）。 */
export class OpusUplinkDecoder extends OpusDecoder {
  constructor() {
    super(AUDIO.uplink.sampleRate)
  }
}

/** 下行专用：24k/mono 编码器（云 → 设备）。 */
export class OpusDownlinkEncoder extends OpusEncoder {
  constructor(options) {
    super(AUDIO.downlink.sampleRate, options)
  }
}

// 便捷单例：会话层只处理一条上下行流时可直接调用，省去手动管理生命周期。
let sharedUplinkDecoder = null
let sharedDownlinkEncoder = null

/** 解码设备上行包（16k/mono/60ms → 960 点 Int16Array）。 */
export function decodeUplinkPacket(packet) {
  if (!sharedUplinkDecoder) sharedUplinkDecoder = new OpusUplinkDecoder()
  return sharedUplinkDecoder.decode(packet)
}

/** 编码下行帧（24k/mono/60ms 的 1440 点 Int16Array → Opus 包）。 */
export function encodeDownlinkFrame(pcm) {
  if (!sharedDownlinkEncoder) sharedDownlinkEncoder = new OpusDownlinkEncoder()
  return sharedDownlinkEncoder.encode(pcm)
}

/** 释放便捷单例占用的 WASM 内存（测试/热重载用）。 */
export function closeSharedOpus() {
  if (sharedUplinkDecoder) {
    sharedUplinkDecoder.close()
    sharedUplinkDecoder = null
  }
  if (sharedDownlinkEncoder) {
    sharedDownlinkEncoder.close()
    sharedDownlinkEncoder = null
  }
}
