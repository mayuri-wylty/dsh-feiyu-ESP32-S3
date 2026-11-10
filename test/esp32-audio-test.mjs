// T10 音频核心测试：Opus 16k/960 解码、24k/1440 编码、WAV、32k→24k 多相 FIR 重采样。
//
// ── opusscript 0.1.1 语义钉死（package.json 精确锁版本；以下均由本文件断言）──
//
// 1) encode(buffer, frameSize)
//    - frameSize 单位 = **每声道采样点数（samples per channel）**，不是字节。
//      libopus 的 opus_encode() 直接把它当采样数；16k/60ms → 960，24k/60ms → 1440。
//    - buffer 必须是 **PCM16 little-endian 字节** 的 Buffer/Uint8Array，长度
//      = frameSize × channels × 2。wasm 胶水层把 buffer.length 当“字节数”传给
//      C++，C++ 再把这些字节重排成 int16。传 Int16Array 会被 TypedArray.set
//      逐元素复制成 Uint16 元素、长度又被当字节数，编码结果是噪声（开发期实测）。
//
// 2) decode(packet) —— 0.1.1 的签名**没有 frameSize 参数**（多传的第二个参数被
//    JS 静默忽略，本文件用 decode(pkt, 12345) 断言这一点）。
//    返回 Buffer，其 length 单位是**字节** = 解码采样点数 × channels × 2。
//    已知线索“16k 编码 960 点得到 20 字节包，用 24k 解码器请求 1440 时返回 2880”：
//      - 20 字节包：新编码器编码 960 点静音（VOIP/AUDIO 默认码率）即 20 字节；
//      - 2880 是**字节数**，不是采样点数：2880 B ÷ 2 B/点 = 1440 点，正好是
//        24k × 60ms。本文件用 Int16Array 长度 = 1440 把语义钉死。
//
// 3) 有损编解码不去断言逐点相等：往返用最佳滞后对齐后的归一化相关 + SNR。

import test from 'node:test'
import assert from 'node:assert/strict'
import OpusScript from 'opusscript'

import { AUDIO } from '../lib/esp32/contracts.js'
import {
  OpusDecoder,
  OpusEncoder,
  OpusUplinkDecoder,
  OpusDownlinkEncoder,
  decodeUplinkPacket,
  encodeDownlinkFrame,
} from '../lib/esp32/audio/opus.js'
import { parsePcmWav, writePcmWav } from '../lib/esp32/audio/wav.js'
import { resamplePcm } from '../lib/esp32/audio/resample.js'
import * as audioIndex from '../lib/esp32/audio/index.js'

// ── 测试工具 ────────────────────────────────────────────────────────────────

function pcmSine(samples, sampleRate, freqHz, amplitude = 8000) {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate))
  }
  return pcm
}

/** Int16Array → PCM16 little-endian 字节 Buffer（opusscript.encode 要求的输入格式） */
function pcmToLeBuffer(pcm) {
  const buf = Buffer.allocUnsafe(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], i * 2)
  return buf
}

/** PCM16 little-endian 字节 Buffer → Int16Array */
function leBufferToPcm(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = new Int16Array(u8.byteLength >> 1)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

function rms(pcm, start = 0, end = pcm.length) {
  let sum = 0
  for (let i = start; i < end; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / Math.max(1, end - start))
}

/** 在 ±maxLag 内找最佳对齐滞后，返回归一化相关与滞后（Opus 有编解码器时延） */
function bestLagCorrelation(a, b, maxLag, edge = 0) {
  const lo = edge
  const hi = Math.min(a.length, b.length) - edge
  let best = { lag: 0, corr: -Infinity }
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0
    let da = 0
    let db = 0
    for (let i = lo; i < hi; i++) {
      const j = i + lag
      if (j < 0 || j >= b.length) continue
      num += a[i] * b[j]
      da += a[i] * a[i]
      db += b[j] * b[j]
    }
    const corr = num / Math.sqrt(da * db)
    if (corr > best.corr) best = { lag, corr }
  }
  return best
}

/** 按最佳滞后计算 SNR（dB），避开首尾不完整区域 */
function alignedSnrDb(ref, out, lag, edge = 0) {
  let signal = 0
  let error = 0
  const lo = edge
  const hi = Math.min(ref.length, out.length) - edge
  for (let i = lo; i < hi; i++) {
    const j = i + lag
    if (j < 0 || j >= out.length) continue
    signal += ref[i] * ref[i]
    const d = ref[i] - out[j]
    error += d * d
  }
  return 10 * Math.log10(signal / Math.max(error, 1e-9))
}

/** 迭代式 radix-2 FFT（原地） */
function fftInPlace(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (-2 * Math.PI) / len
    const wLenRe = Math.cos(ang)
    const wLenIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half]
        const bIm = im[i + k + half]
        const vRe = bRe * wRe - bIm * wIm
        const vIm = bRe * wIm + bIm * wRe
        re[i + k] = aRe + vRe
        im[i + k] = aIm + vIm
        re[i + k + half] = aRe - vRe
        im[i + k + half] = aIm - vIm
        const nextWRe = wRe * wLenRe - wIm * wLenIm
        wIm = wRe * wLenIm + wIm * wLenRe
        wRe = nextWRe
      }
    }
  }
}

/**
 * 用 radix-2 FFT 取 targetHz 附近的峰值幅度（±1 bin，抵消栅栏效应）。
 * N=32768 时 1kHz 与 10kHz 的分数 bin 偏移相同（.3333），两者可比。
 */
function fftPeakMagnitude(samples, fftSize, targetHz, sampleRate) {
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const n = Math.min(samples.length, fftSize)
  for (let i = 0; i < n; i++) re[i] = samples[i]
  fftInPlace(re, im)
  const center = Math.round((targetHz * fftSize) / sampleRate)
  let peak = 0
  for (let k = center - 1; k <= center + 1; k++) {
    if (k >= 0 && k < fftSize) peak = Math.max(peak, Math.hypot(re[k], im[k]))
  }
  return peak
}

function ascii(bytes, off, len) {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i])
  return s
}

// ── Opus：opusscript 语义钉死 ────────────────────────────────────────────────

test('opusscript 0.1.1：encode frameSize 是采样数，decode 返回字节长度', () => {
  // 新编码器 + 960 点静音 → 20 字节 Opus 包（已知线索复现）。
  // 若这条断言失败，说明 opusscript 版本/编解码器默认码率变了，必须重新核对语义。
  const enc16 = new OpusScript(16000, 1, OpusScript.Application.VOIP)
  const silencePacket = enc16.encode(Buffer.alloc(AUDIO.uplink.samplesPerFrame * 2), 960)
  assert.equal(silencePacket.length, 20, '16k/960 点静音应编码为 20 字节包')

  // 同一个包用 24k 解码器解：返回 Buffer 长度 2880 = **字节** = 1440 点 × 1ch × 2B。
  const dec24 = new OpusScript(24000, 1)
  const decoded = dec24.decode(silencePacket)
  assert.equal(decoded.length, 2880, 'decode 返回的是 PCM16 字节数')
  assert.equal(decoded.length / 2, 1440, '2880 字节 ÷ 2 = 1440 采样点')
  assert.equal(decoded.length / 2, AUDIO.downlink.samplesPerFrame, '24k × 60ms = 1440 点')
  assert.equal(leBufferToPcm(decoded).length, 1440, '按 LE 解析后 Int16Array 长度 1440')

  // 0.1.1 的 decode 没有 frameSize 参数：多传一个参数被忽略，结果不变。
  const withExtraArg = dec24.decode(silencePacket, 12345)
  assert.equal(withExtraArg.length, 2880, 'decode(pkt, frameSize) 的第二个参数被忽略')

  // 16k 解码器解 60ms 包：1920 字节 = 960 点（同样是字节长度）。
  const dec16 = new OpusScript(16000, 1)
  const decoded16 = dec16.decode(silencePacket)
  assert.equal(decoded16.length, 1920)
  assert.equal(decoded16.length / 2, AUDIO.uplink.samplesPerFrame)

  enc16.delete()
  dec24.delete()
  dec16.delete()
})

test('Opus 24k/1440 下行：encode → decode 长度 1440，相关性与 SNR 达标', () => {
  const pcm = pcmSine(AUDIO.downlink.samplesPerFrame, 24000, 440, 8000)
  const encoder = new OpusDownlinkEncoder()
  const decoder = new OpusDecoder(24000)
  const packet = encoder.encode(pcm)

  assert.ok(packet instanceof Uint8Array, 'encode 返回 Opus 包（Buffer/Uint8Array）')
  assert.ok(packet.length > 0 && packet.length < pcm.length * 2, 'Opus 包应小于原始 PCM 字节')

  const out = decoder.decode(packet)
  assert.ok(out instanceof Int16Array, 'decode 必须返回 Int16Array')
  assert.equal(out.length, 1440, '24k/60ms 解码后 1440 点')

  const { lag, corr } = bestLagCorrelation(pcm, out, 400, 300)
  const snr = alignedSnrDb(pcm, out, lag, 300)
  assert.ok(corr > 0.95, `最佳滞后 ${lag} 的归一化相关应 > 0.95，实测 ${corr.toFixed(4)}`)
  assert.ok(snr > 18, `对齐后 SNR 应 > 18dB，实测 ${snr.toFixed(1)}dB`)

  encoder.close()
  decoder.close()
})

test('Opus 16k/960 上行：设备包 decode → 960 点，相关性与 SNR 达标', () => {
  const pcm = pcmSine(AUDIO.uplink.samplesPerFrame, 16000, 440, 8000)
  // 模拟设备端：用 opusscript 裸 API 按正确语义（LE 字节 Buffer + 采样数）编码。
  const deviceEncoder = new OpusScript(16000, 1, OpusScript.Application.VOIP)
  const packet = deviceEncoder.encode(pcmToLeBuffer(pcm), AUDIO.uplink.samplesPerFrame)

  const decoder = new OpusUplinkDecoder()
  const out = decoder.decode(packet)
  assert.ok(out instanceof Int16Array)
  assert.equal(out.length, 960)

  const { lag, corr } = bestLagCorrelation(pcm, out, 400, 300)
  const snr = alignedSnrDb(pcm, out, lag, 300)
  assert.ok(corr > 0.95, `相关应 > 0.95，实测 ${corr.toFixed(4)}`)
  assert.ok(snr > 18, `SNR 应 > 18dB，实测 ${snr.toFixed(1)}dB`)

  // 通用入口也应可用（共享实例）。
  assert.equal(decodeUplinkPacket(packet).length, 960)
  assert.ok(encodeDownlinkFrame(pcmSine(1440, 24000, 440)).length > 0)

  deviceEncoder.delete()
  decoder.close()
})

test('Opus 参数校验：非法 PCM 类型/帧长、坏包应抛错', () => {
  const encoder = new OpusDownlinkEncoder()
  assert.throws(() => encoder.encode(Buffer.alloc(2880)), TypeError)
  assert.throws(() => encoder.encode(new Int16Array(1000)), RangeError)
  assert.throws(() => encoder.encode(new Int16Array(0)), RangeError)
  encoder.close()

  const decoder = new OpusDecoder(24000)
  assert.throws(() => decoder.decode(new Uint8Array(0)), /packet|packet 为空|empty/i)
  assert.throws(() => decoder.decode(new Uint8Array([0xff, 0xff, 0xff, 0xff])), /Opus|decode/i)
  decoder.close()

  assert.throws(() => new OpusEncoder(12345), RangeError, '应拒绝非法采样率')
})

test('Opus 编码器支持 24k 的合法帧长（20/40/60ms），拒绝 90ms', () => {
  const encoder = new OpusDownlinkEncoder()
  for (const samples of [480, 960, 1440]) {
    const packet = encoder.encode(pcmSine(samples, 24000, 440))
    assert.ok(packet.length > 0)
  }
  assert.throws(() => encoder.encode(new Int16Array(2160)), RangeError)
  encoder.close()
})

test('Opus 多实例并存：PCM 视图锚定 malloc 块，互不串扰且可安全 close', () => {
  // 回归 opusscript 0.1.1 的指针错位：未修正时 inPCM/outPCM 的 byteOffset 是
  // malloc 指针的 2 倍，多实例并存会写到分配块之外，delete() 偶发 WASM OOB。
  const encoders = [new OpusDownlinkEncoder(), new OpusDownlinkEncoder()]
  const decoders = [new OpusDecoder(24000), new OpusDecoder(24000)]

  for (const codec of [...encoders, ...decoders]) {
    assert.equal(codec._codec.inPCM.byteOffset, codec._codec.inPCMPointer, 'inPCM 应锚定 malloc 指针')
    assert.equal(codec._codec.outPCM.byteOffset, codec._codec.outPCMPointer, 'outPCM 应锚定 malloc 指针')
    assert.equal(codec._codec.inPCM.length * 2, codec._codec.inPCMLength)
    assert.equal(codec._codec.outPCM.length * 2, codec._codec.outPCMLength)
  }

  const pcms = [pcmSine(1440, 24000, 330, 8000), pcmSine(1440, 24000, 660, 8000)]
  const packets = pcms.map((pcm, i) => encoders[i].encode(pcm))
  const outs = packets.map((pkt, i) => decoders[i].decode(pkt))

  outs.forEach((out, i) => {
    assert.equal(out.length, 1440)
    const { corr } = bestLagCorrelation(pcms[i], out, 400, 300)
    assert.ok(corr > 0.9, `实例 ${i} 自身往返相关应 > 0.9，实测 ${corr.toFixed(4)}`)
  })
  // 两个实例输入频率不同，若缓冲区被串写输出会趋于一致。
  assert.notDeepEqual(Array.from(outs[0]), Array.from(outs[1]))

  for (const e of encoders) e.close()
  for (const d of decoders) d.close()
})

// ── WAV ─────────────────────────────────────────────────────────────────────

test('writePcmWav：RIFF/fmt/data 头字段正确且可往返', () => {
  const pcm = pcmSine(1600, 16000, 440, 6000)
  const wav = writePcmWav(pcm, 16000)
  assert.ok(wav instanceof Uint8Array)
  assert.equal(wav.byteLength, 44 + pcm.length * 2)

  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(ascii(wav, 0, 4), 'RIFF')
  assert.equal(dv.getUint32(4, true), wav.byteLength - 8)
  assert.equal(ascii(wav, 8, 4), 'WAVE')
  assert.equal(ascii(wav, 12, 4), 'fmt ')
  assert.equal(dv.getUint32(16, true), 16)
  assert.equal(dv.getUint16(20, true), 1, 'PCM format tag')
  assert.equal(dv.getUint16(22, true), 1, 'mono')
  assert.equal(dv.getUint32(24, true), 16000)
  assert.equal(dv.getUint32(28, true), 32000, 'byteRate')
  assert.equal(dv.getUint16(32, true), 2, 'blockAlign')
  assert.equal(dv.getUint16(34, true), 16, 'bits per sample')
  assert.equal(ascii(wav, 36, 4), 'data')
  assert.equal(dv.getUint32(40, true), pcm.length * 2)

  const parsed = parsePcmWav(wav)
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.ok(parsed.pcm instanceof Int16Array)
  assert.deepEqual(Array.from(parsed.pcm), Array.from(pcm))
  assert.equal(parsed.frames, pcm.length)
})

test('parsePcmWav：容忍 LIST 等附加块（含奇数长度 padding）', () => {
  const pcm = pcmSine(320, 16000, 880, 5000)
  const base = writePcmWav(pcm, 16000)
  // 在 "data" 前插入 LIST 块：payload 3 字节 + 1 字节 pad。
  const listChunk = new Uint8Array(12)
  listChunk.set([0x4c, 0x49, 0x53, 0x54], 0) // 'LIST'
  new DataView(listChunk.buffer).setUint32(4, 3, true)
  listChunk.set([0x49, 0x4e, 0x46], 8) // 'INF' 随意 3 字节
  listChunk[11] = 0 // pad

  const out = new Uint8Array(base.byteLength + listChunk.byteLength)
  out.set(base.subarray(0, 36), 0)
  out.set(listChunk, 36)
  out.set(base.subarray(36), 36 + listChunk.byteLength)
  new DataView(out.buffer).setUint32(4, out.byteLength - 8, true)

  const parsed = parsePcmWav(out)
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.deepEqual(Array.from(parsed.pcm), Array.from(pcm))
})

test('parsePcmWav：立体声 PCM16 解析', () => {
  const frames = 240
  const pcm = new Int16Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    pcm[i * 2] = i * 10
    pcm[i * 2 + 1] = -i * 10
  }
  const wav = writePcmWav(pcm, 16000, 2)
  const parsed = parsePcmWav(wav)
  assert.equal(parsed.channels, 2)
  assert.equal(parsed.frames, frames)
  assert.deepEqual(Array.from(parsed.pcm), Array.from(pcm))
})

test('parsePcmWav：拒绝非 PCM、非 16bit、截断文件', () => {
  const wav = writePcmWav(pcmSine(64, 16000, 440), 16000)

  const floatWav = wav.slice()
  new DataView(floatWav.buffer).setUint16(20, 3, true) // IEEE float
  assert.throws(() => parsePcmWav(floatWav), /PCM|format|不支持/i)

  const eightBit = wav.slice()
  new DataView(eightBit.buffer).setUint16(34, 8, true)
  assert.throws(() => parsePcmWav(eightBit), /16|bits|不支持/i)

  assert.throws(() => parsePcmWav(wav.subarray(0, 30)), /chunk|short|截断|too/i)
  assert.throws(() => parsePcmWav(new Uint8Array([1, 2, 3])), /RIFF|WAV|short|too/i)
})

// ── 重采样 ──────────────────────────────────────────────────────────────────

test('resamplePcm：32k→24k 长度正确，1kHz 通带幅度保持', () => {
  const input = pcmSine(32000, 32000, 1000, 10000)
  const out = resamplePcm(input, 32000, 24000)
  assert.equal(out.length, Math.round((32000 * 24000) / 32000))
  assert.equal(out.length, 24000)

  // 1kHz 在通带内，输出 RMS 应与输入 RMS 接近（多相 FIR 直流增益归一）。
  const ratio = rms(out, 200, out.length - 200) / rms(input, 200, input.length - 200)
  assert.ok(Math.abs(ratio - 1) < 0.05, `通带 RMS 比应在 1±5%，实测 ${ratio.toFixed(4)}`)
})

test('resamplePcm：32k→24k 抗混叠，14kHz 输入在 10kHz 镜像 ≤ −40dB', () => {
  const FFT_SIZE = 32768
  // 通带参考：同幅度 1kHz 正弦。
  const refOut = resamplePcm(pcmSine(32000, 32000, 1000, 10000), 32000, 24000)
  // 14kHz 超过 24k 的 Nyquist(12k)，会镜像到 |14000−24000| = 10kHz。
  const aliasOut = resamplePcm(pcmSine(32000, 32000, 14000, 10000), 32000, 24000)

  const refAmp = fftPeakMagnitude(refOut, FFT_SIZE, 1000, 24000)
  const aliasAmp = fftPeakMagnitude(aliasOut, FFT_SIZE, 10000, 24000)
  assert.ok(refAmp > 0, '通带参考幅度必须非零')

  const attenuationDb = 20 * Math.log10(aliasAmp / refAmp)
  console.log(`[resample] 32k→24k 10kHz 镜像衰减 ${attenuationDb.toFixed(1)} dB`)
  assert.ok(attenuationDb < -40, `10kHz 镜像应 ≤ −40dB，实测 ${attenuationDb.toFixed(1)}dB`)
})

test('resamplePcm：32k→16k（2:1）14kHz 镜像到 2kHz 亦被抑制', () => {
  const FFT_SIZE = 32768
  const refOut = resamplePcm(pcmSine(32000, 32000, 1000, 10000), 32000, 16000)
  const aliasOut = resamplePcm(pcmSine(32000, 32000, 14000, 10000), 32000, 16000)
  assert.equal(refOut.length, 16000)

  const refAmp = fftPeakMagnitude(refOut, FFT_SIZE, 1000, 16000)
  const aliasAmp = fftPeakMagnitude(aliasOut, FFT_SIZE, 2000, 16000)
  const attenuationDb = 20 * Math.log10(aliasAmp / refAmp)
  console.log(`[resample] 32k→16k 2kHz 镜像衰减 ${attenuationDb.toFixed(1)} dB`)
  assert.ok(attenuationDb < -40, `2kHz 镜像应 ≤ −40dB，实测 ${attenuationDb.toFixed(1)}dB`)
})

test('resamplePcm：同采样率直通不重采样；24k→16k 通用路径长度正确', () => {
  const p16 = pcmSine(960, 16000, 440)
  const p24 = pcmSine(1440, 24000, 440)
  assert.equal(resamplePcm(p16, 16000, 16000), p16, '16k→16k 应原样返回')
  assert.equal(resamplePcm(p24, 24000, 24000), p24, '24k→24k 应原样返回')

  const down = resamplePcm(p24, 24000, 16000)
  assert.equal(down.length, 960)
  const { corr } = bestLagCorrelation(pcmSine(960, 16000, 440), down, 0, 50)
  assert.ok(corr > 0.95, `24k→16k 幅度包络一致，corr=${corr.toFixed(4)}`)
})

test('音频模块统一出口导出全部 API', () => {
  for (const name of [
    'OpusDecoder',
    'OpusEncoder',
    'OpusUplinkDecoder',
    'OpusDownlinkEncoder',
    'decodeUplinkPacket',
    'encodeDownlinkFrame',
    'parsePcmWav',
    'writePcmWav',
    'resamplePcm',
  ]) {
    assert.equal(typeof audioIndex[name], 'function', `index.js 应导出 ${name}`)
  }
})

// ── 性能记录（每帧 ≤ 几 ms；断言只设很宽的上限防病态回归）──────────────────

test('性能：Opus 60ms 帧编解码与 1s 重采样耗时', () => {
  const pcm24 = pcmSine(1440, 24000, 440)
  const encoder = new OpusDownlinkEncoder()
  const decoder24 = new OpusDecoder(24000)
  const packets = []
  for (let i = 0; i < 5; i++) packets.push(encoder.encode(pcm24))
  const pkt = packets[0]
  for (let i = 0; i < 5; i++) decoder24.decode(pkt)

  const ITER = 50
  let t0 = process.hrtime.bigint()
  for (let i = 0; i < ITER; i++) encoder.encode(pcm24)
  let t1 = process.hrtime.bigint()
  const encodeMs = Number(t1 - t0) / 1e6 / ITER

  t0 = process.hrtime.bigint()
  for (let i = 0; i < ITER; i++) decoder24.decode(pkt)
  t1 = process.hrtime.bigint()
  const decode24Ms = Number(t1 - t0) / 1e6 / ITER

  // 16k 上行解码耗时（用 24k 包测同一解码路径规模接近，另造 16k 包更准确）。
  // 设备端行为用 OpusEncoder(VOIP) 模拟；走封装而非裸 OpusScript，顺带覆盖 16k 编码。
  const devEnc = new OpusEncoder(16000, { application: OpusScript.Application.VOIP })
  const pkt16 = devEnc.encode(pcmSine(960, 16000, 440))
  const decoder16 = new OpusUplinkDecoder()
  for (let i = 0; i < 5; i++) decoder16.decode(pkt16)
  t0 = process.hrtime.bigint()
  for (let i = 0; i < ITER; i++) decoder16.decode(pkt16)
  t1 = process.hrtime.bigint()
  const decode16Ms = Number(t1 - t0) / 1e6 / ITER

  // 重采样：1 秒 32k PCM → 24k（首次含滤波器设计，循环里取缓存后均值）。
  const sec = pcmSine(32000, 32000, 1000, 8000)
  resamplePcm(sec, 32000, 24000)
  t0 = process.hrtime.bigint()
  const RESAMPLE_ITER = 10
  for (let i = 0; i < RESAMPLE_ITER; i++) resamplePcm(sec, 32000, 24000)
  t1 = process.hrtime.bigint()
  const resampleMs = Number(t1 - t0) / 1e6 / RESAMPLE_ITER

  console.log(
    `[perf] 24k encode ${encodeMs.toFixed(3)} ms/60ms帧；` +
      `24k decode ${decode24Ms.toFixed(3)} ms/帧；` +
      `16k decode ${decode16Ms.toFixed(3)} ms/帧；` +
      `32k→24k 1s 重采样 ${resampleMs.toFixed(2)} ms（≈${(resampleMs / 16.67).toFixed(3)} ms/60ms帧）`,
  )

  // 宽松上限：只防止实现退化成不可用（真实值预期 encode ~1ms、decode <0.2ms）。
  assert.ok(encodeMs < 15, `encode 每帧应 <15ms，实测 ${encodeMs.toFixed(2)}ms`)
  assert.ok(decode24Ms < 5, `24k decode 每帧应 <5ms，实测 ${decode24Ms.toFixed(2)}ms`)
  assert.ok(decode16Ms < 5, `16k decode 每帧应 <5ms，实测 ${decode16Ms.toFixed(2)}ms`)
  assert.ok(resampleMs < 100, `1s 重采样应 <100ms，实测 ${resampleMs.toFixed(2)}ms`)

  encoder.close()
  decoder24.close()
  decoder16.close()
  devEnc.close()
})
