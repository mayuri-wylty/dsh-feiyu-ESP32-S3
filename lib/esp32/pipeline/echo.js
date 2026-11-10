// ESP32 通道 · T20 回声管线
//
// 最小可用的 Esp32SessionPipeline：把设备上行 16k PCM 原样回放成 24k Opus 下行。
// 用途是打通「上行解码 → 重采样 → 组帧 → Opus 编码 → 下发」整条音频链路，
// 不接 ASR/LLM/TTS，便于无硬件时验证协议与音频参数。
//
// 数据流：
//   onAudio(16k/960 点) → resamplePcm(16k→24k) → 1440 点切帧 → Opus → ctx.sendBinary
//
// 关键点：
//   · 重采样按 chunk 独立进行（无跨 chunk 滤波器状态），因此输出长度可能不是
//     1440 的整数倍；createDownlinkFramer 负责跨调用缓冲残余样本。
//   · 回声只在 listening 轮次内下发；abort/close 时清空残余并释放编码器。
//
// 契约见 lib/esp32/contracts.js（Esp32SessionPipeline / AUDIO）。

import { createDownlinkFramer, messageOf } from './common.js'

/**
 * @param {{
 *   ctx: import('../contracts.js').Esp32SessionContext,
 *   encoder?: {encode: Function, close?: Function},
 *   logger?: object,
 * }} options
 * @returns {import('../contracts.js').Esp32SessionPipeline}
 */
export function createEchoPipeline({ ctx, encoder, logger } = {}) {
  if (!ctx) throw new TypeError('createEchoPipeline: 需要会话 ctx')
  const log = logger ?? ctx.logger ?? {}
  const framer = createDownlinkFramer({ ctx, encoder, logger: log })
  let closed = false

  return {
    onAudio(frame, meta) {
      if (closed) return
      if (!(frame instanceof Int16Array) || frame.length === 0) return
      const sampleRate = Number(meta?.sampleRate) || 16000
      try {
        framer.push(frame, sampleRate)
      } catch (error) {
        // 单帧失败只丢该帧，不关闭会话。
        log.warn?.('回声管线处理音频失败', { error: messageOf(error) })
      }
    },

    onListenStart() {
      // 新一轮：丢弃上一轮残余，避免把旧尾音拼到新轮次开头。
      framer.reset()
    },

    onAbort() {
      framer.reset()
    },

    onClose() {
      closed = true
      framer.close()
    },
  }
}
