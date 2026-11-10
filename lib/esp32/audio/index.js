// ESP32 第五通道音频模块统一出口。
//
// 子模块：
// - opus.js     Opus 编解码（上行 16k/960 解码，下行 24k/1440 编码）
// - wav.js      PCM16 WAV 读写（ASR 的 16k/mono WAV）
// - resample.js 多相 FIR 重采样（32k→24k 等）
//
// 所有 PCM 入参/出参均为 Int16Array（单声道，交织规则见 wav.js）。

export {
  OpusDecoder,
  OpusEncoder,
  OpusUplinkDecoder,
  OpusDownlinkEncoder,
  decodeUplinkPacket,
  encodeDownlinkFrame,
  closeSharedOpus,
} from './opus.js'

export { parsePcmWav, writePcmWav } from './wav.js'

export { resamplePcm } from './resample.js'
