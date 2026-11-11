// T16：GPT-SoVITS / 云 TTS 返回 WAV → 单声道 PCM16
//
// 解析逻辑已合并到 lib/esp32/audio/wav.js（parsePcmWav + downmixToMono），
// 本文件只保留 TTS 侧需要的适配形状：{pcm, sampleRate, channels, bits}，
// 且 pcm 为**下混后的单声道**（ESP32 下行固定单声道）。

import { parsePcmWav, downmixToMono } from '../audio/wav.js'

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} input 完整 wav 字节
 * @returns {{pcm: Int16Array, sampleRate: number, channels: number, bits: number}}
 *   channels 为**源文件**声道数；pcm 已下混为单声道。
 */
export function parseWavToPcm(input) {
  const { pcm, sampleRate, channels, bits } = parsePcmWav(input)
  return { pcm: downmixToMono(pcm, channels), sampleRate, channels, bits }
}
