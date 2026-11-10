// 最小 RIFF/WAVE PCM16 读写。
//
// 用途：ASR（ctx.speechToText）通常要求 16k/mono/PCM16 WAV；本模块负责把
// Int16Array 打包成 WAV，以及解析上游返回的 WAV（容忍 LIST/JUNK 等附加块）。
//
// 格式约束：仅支持 RIFF/WAVE、PCM format=1、16-bit。data 块允许出现在任意
// 位置（fmt 之后即可），块大小为奇数时按 RIFF 规范跳过 1 字节 padding。

const RIFF_HEADER_BYTES = 44
const WAVE_FORMAT_PCM = 1
const BITS_PER_SAMPLE = 16

function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes // Buffer 也是 Uint8Array
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  throw new TypeError('WAV: 需要 Buffer/Uint8Array/ArrayBuffer')
}

function readAscii(bytes, offset, length) {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i])
  return s
}

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) & 0xff
}

/**
 * 解析 PCM16 WAV。
 *
 * @param {Uint8Array|ArrayBuffer} bytes WAV 文件内容
 * @returns {{sampleRate: number, channels: number, pcm: Int16Array, frames: number}}
 *   pcm 为交织的 PCM16 采样（立体声时 L/R 交替），frames = 每声道采样帧数。
 */
export function parsePcmWav(bytes) {
  const u8 = toUint8(bytes)
  if (u8.byteLength < 12) {
    throw new Error(`WAV: 文件过短（${u8.byteLength} 字节）`)
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (readAscii(u8, 0, 4) !== 'RIFF' || readAscii(u8, 8, 4) !== 'WAVE') {
    throw new Error('WAV: 不是 RIFF/WAVE 文件')
  }

  let fmt = null
  let dataOffset = -1
  let dataLength = 0

  let offset = 12
  while (offset + 8 <= u8.byteLength) {
    const chunkId = readAscii(u8, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + chunkSize > u8.byteLength) {
      throw new Error(`WAV: chunk "${chunkId}" 超出文件长度（截断文件）`)
    }
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error(`WAV: fmt chunk 过短（${chunkSize} 字节）`)
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (chunkId === 'data' && dataOffset < 0) {
      dataOffset = body
      dataLength = chunkSize
    }
    // 奇数长度 chunk 后面有 1 字节 padding。
    offset = body + chunkSize + (chunkSize & 1)
  }

  if (!fmt) throw new Error('WAV: 缺少 fmt chunk')
  if (dataOffset < 0) throw new Error('WAV: 缺少 data chunk')
  if (fmt.audioFormat !== WAVE_FORMAT_PCM) {
    throw new Error(`WAV: 仅支持 PCM 格式（format=1），当前 format=${fmt.audioFormat}`)
  }
  if (fmt.bitsPerSample !== BITS_PER_SAMPLE) {
    throw new Error(`WAV: 仅支持 16-bit PCM，当前 ${fmt.bitsPerSample} bit`)
  }
  if (!Number.isInteger(fmt.channels) || fmt.channels < 1) {
    throw new Error(`WAV: 非法声道数 ${fmt.channels}`)
  }
  if (fmt.sampleRate <= 0) {
    throw new Error(`WAV: 非法采样率 ${fmt.sampleRate}`)
  }

  const bytesPerFrame = fmt.channels * 2
  if (dataLength % bytesPerFrame !== 0) {
    throw new Error(
      `WAV: data 长度 ${dataLength} 不是完整采样帧（channels=${fmt.channels}, 16-bit）`,
    )
  }

  const sampleCount = dataLength >> 1
  const pcm = new Int16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(dataOffset + i * 2, true)
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    pcm,
    frames: sampleCount / fmt.channels,
  }
}

/**
 * 生成 PCM16 WAV（标准 44 字节头）。
 *
 * @param {Int16Array} pcm 交织的 PCM16 采样（默认单声道）
 * @param {number} sampleRate 采样率（ASR 场景通常是 16000）
 * @param {number} [channels=1] 声道数
 * @returns {Uint8Array} WAV 文件内容
 */
export function writePcmWav(pcm, sampleRate, channels = 1) {
  if (!(pcm instanceof Int16Array)) {
    throw new TypeError('writePcmWav: 需要 Int16Array')
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`writePcmWav: 非法采样率 ${sampleRate}`)
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new RangeError(`writePcmWav: 非法声道数 ${channels}`)
  }
  if (pcm.length % channels !== 0) {
    throw new RangeError(`writePcmWav: 采样数 ${pcm.length} 不是声道数 ${channels} 的整数倍`)
  }

  const dataBytes = pcm.length * 2
  if (RIFF_HEADER_BYTES - 8 + dataBytes > 0xffffffff) {
    throw new RangeError('writePcmWav: 数据过大，超出 RIFF 32-bit 长度上限')
  }

  const out = new Uint8Array(RIFF_HEADER_BYTES + dataBytes)
  const view = new DataView(out.buffer)
  const blockAlign = channels * 2

  writeAscii(out, 0, 'RIFF')
  view.setUint32(4, RIFF_HEADER_BYTES - 8 + dataBytes, true)
  writeAscii(out, 8, 'WAVE')

  writeAscii(out, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk 大小
  view.setUint16(20, WAVE_FORMAT_PCM, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byteRate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)

  writeAscii(out, 36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(RIFF_HEADER_BYTES + i * 2, pcm[i], true)

  return out
}
