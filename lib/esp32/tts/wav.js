// T16：GPT-SoVITS 返回 WAV → PCM16
//
// 只做句级 TTS 需要的最小解析：RIFF/WAVE、fmt/data chunk、16bit PCM、
// 多声道下混单声道、WAVE_FORMAT_EXTENSIBLE（soundfile 写 wav 时常见）。
//
// TODO(B 道)：B 道正在做 lib/esp32/audio/wav.js（下行/重采样/播放缓冲）。
//   本文件是为了让 T16 不被 B 道阻塞的私有实现；等 B 道落地后合并/替换，
//   保留 parseWavToPcm 的名称与返回形状（{pcm, sampleRate, channels, bits}）即可。

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  throw new TypeError('parseWavToPcm 需要 Buffer / Uint8Array / ArrayBuffer')
}

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} input 完整 wav 字节
 * @returns {{pcm: Int16Array, sampleRate: number, channels: number, bits: number}}
 */
export function parseWavToPcm(input) {
  const buf = toBuffer(input)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 数据（缺 RIFF/WAVE 头）')
  }

  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8
    const end = Math.min(start + size, buf.length)
    if (id === 'fmt ') {
      if (end - start < 16) throw new Error('WAV fmt 段过短')
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      }
      if (fmt.format === 0xfffe) {
        // WAVE_FORMAT_EXTENSIBLE：真实格式在 SubFormat GUID 前 4 字节（fmt 体偏移 24）
        if (end - start < 40) throw new Error('WAV EXTENSIBLE fmt 段过短')
        fmt.format = buf.readUInt32LE(start + 24)
      }
    } else if (id === 'data') {
      data = buf.subarray(start, end)
    }
    off = start + size + (size % 2) // chunk 按偶数字节对齐
  }

  if (!fmt) throw new Error('WAV 缺 fmt 段')
  if (!data) throw new Error('WAV 缺 data 段')
  if (fmt.format !== 1) throw new Error(`WAV 编码格式 ${fmt.format} 不支持（只支持 PCM 16bit）`)
  if (fmt.bits !== 16) throw new Error(`WAV 位深 ${fmt.bits} 不支持（只支持 PCM 16bit）`)
  if (!fmt.channels || !fmt.sampleRate) throw new Error('WAV fmt 参数无效（声道数/采样率为 0）')

  const channels = fmt.channels
  const frameBytes = channels * 2
  const frames = Math.floor(data.length / frameBytes)
  const pcm = new Int16Array(frames)
  if (channels === 1) {
    for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * 2)
  } else {
    // 下行固定单声道；立体声按帧平均下混（ESP32 播放不了多声道）
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2)
      const avg = Math.round(sum / channels)
      pcm[i] = avg > 32767 ? 32767 : avg < -32768 ? -32768 : avg
    }
  }

  return { pcm, sampleRate: fmt.sampleRate, channels, bits: fmt.bits }
}
