// ESP32 通道 · T22 完整问答管线
//
// 把 T21 的 ASR 链与大脑桥 / TTS 串成一轮完整对话：
//
//   speech_end → ASR → stt 下发 → thinking → llm(emotion) → 逐句 TTS → 24k Opus 帧
//              → tts stop → listening（连续对话）
//
// 事件流（brain.handleUtterance 的 AsyncIterable）：
//   {type:'emotion', emotion}        → ctx.sendLlm({emotion: firmwareEmotionOf(emotion)})
//   {type:'sentence', text, index}   → ctx.sendTts({state:'sentence_start', text})
//                                    → tts.stream(text, {emotion, signal})
//                                    → 每块 PCM 重采样 24k → 1440 点 → Opus → sendBinary
//   {type:'done', fullText}          → ctx.sendTts({state:'stop'}) → 回落 listening
//
// 关键设计：
//   · 音频下发严格串行：一个句子的帧发完才发下一句（createSerialQueue），
//     避免并发 sendBinary 打乱顺序。
//   · 打断：onAbort 结束本轮 AbortController（转发给 ASR/TTS/LLM 的 signal），
//     清空组帧器残余与待发队列；之后所有下发都会被会话拒绝（ctx 层已保证）。
//   · 记忆由 brain.handleUtterance 内部写入；本管线只写 channelLog（user/assistant）。
//   · 状态迁移：recognizing → thinking → speaking → listening。会话状态机只允许
//     单调前进或回落 listening，因此这里不做多余迁移。

import { firmwareEmotionOf } from '../contracts.js'
import { createAsrPipeline } from './asr.js'
import {
  createDownlinkFramer,
  createSerialQueue,
  isAbortError,
  messageOf,
} from './common.js'

/**
 * @param {{
 *   ctx: import('../contracts.js').Esp32SessionContext,
 *   asr: import('../contracts.js').AsrProvider,
 *   tts: import('../contracts.js').TtsProvider,
 *   brain: {handleUtterance: Function},
 *   vad?: object,
 *   config?: object,
 *   channelLog?: import('../contracts.js').ChannelLog,
 *   logger?: object,
 *   encoder?: {encode: Function, close?: Function},
 *   chatId?: string,
 *   userId?: string,
 *   continuous?: boolean,
 *   sendLlmText?: boolean,
 * }} options
 * @returns {import('../contracts.js').Esp32SessionPipeline}
 */
export function createQaPipeline({
  ctx,
  asr,
  tts,
  brain,
  vad,
  config,
  channelLog,
  logger,
  encoder,
  chatId,
  userId = 'owner',
  continuous = true,
  sendLlmText = false,
} = {}) {
  if (!ctx) throw new TypeError('createQaPipeline: 需要会话 ctx')
  if (!tts || typeof tts.stream !== 'function') {
    throw new TypeError('createQaPipeline: 需要带 stream() 的 tts provider')
  }
  if (!brain || typeof brain.handleUtterance !== 'function') {
    throw new TypeError('createQaPipeline: 需要带 handleUtterance() 的 brain')
  }
  const log = logger ?? ctx.logger ?? {}
  const audioQueue = createSerialQueue()
  const framer = createDownlinkFramer({ ctx, encoder, logger: log })

  let closed = false
  let aborted = false
  let speaking = false
  let currentEmotion = ''

  const isStopped = (signal) => closed || aborted || Boolean(signal?.aborted)

  const resolvedChatId = () => chatId || `esp32:${ctx.deviceId || ''}`

  function appendLog(role, text, meta) {
    if (!channelLog || typeof channelLog.append !== 'function') return
    const value = String(text ?? '').trim()
    if (!value) return
    try {
      channelLog.append({ deviceId: ctx.deviceId, role, text: value, meta })
    } catch (error) {
      log.debug?.('写通道日志失败', { deviceId: ctx.deviceId, error: messageOf(error) })
    }
  }

  function beginSpeaking() {
    if (speaking) return
    speaking = true
    ctx.transition('speaking', { reason: 'qa:tts' })
    ctx.sendTts({ state: 'start' })
  }

  function endSpeaking() {
    if (!speaking) return
    speaking = false
    framer.flush({ pad: true })
    ctx.sendTts({ state: 'stop' })
  }

  /** 把一句 TTS 的 PCM 流串行下发。返回该句是否完整播完。 */
  function speakSentence(text, emotion, signal) {
    return audioQueue.enqueue(async () => {
      if (isStopped(signal)) return false
      beginSpeaking()
      ctx.sendTts({ state: 'sentence_start', text })
      try {
        for await (const chunk of tts.stream(text, { emotion, signal })) {
          if (isStopped(signal)) return false
          const pcm = chunk?.pcm
          if (!(pcm instanceof Int16Array) || pcm.length === 0) continue
          framer.push(pcm, Number(chunk.sampleRate) || 24000)
        }
      } catch (error) {
        if (isAbortError(error) || isStopped(signal)) return false
        log.warn?.('TTS 合成失败，跳过该句', { deviceId: ctx.deviceId, error: messageOf(error) })
        return false
      }
      return !isStopped(signal)
    })
  }

  /** 一轮完整问答：brain 事件流 → 逐句 TTS。 */
  async function runTurn(text, signal) {
    if (isStopped(signal)) return
    ctx.transition('thinking', { reason: 'qa:asr' })
    appendLog('user', text, { source: 'asr' })

    let fullText = ''
    let sentenceCount = 0
    let emotionSent = false

    try {
      for await (const event of brain.handleUtterance({
        deviceId: ctx.deviceId,
        chatId: resolvedChatId(),
        userId,
        text,
        signal,
      })) {
        if (isStopped(signal)) break
        if (!event || typeof event !== 'object') continue

        if (event.type === 'emotion') {
          currentEmotion = String(event.emotion ?? '')
          if (!emotionSent) {
            emotionSent = true
            ctx.sendLlm({ emotion: firmwareEmotionOf(currentEmotion) })
          }
          continue
        }

        if (event.type === 'sentence') {
          const sentence = String(event.text ?? '').trim()
          if (!sentence) continue
          sentenceCount += 1
          if (sendLlmText) ctx.sendLlm({ emotion: firmwareEmotionOf(currentEmotion), text: sentence })
          const completed = await speakSentence(sentence, currentEmotion, signal)
          if (!completed) break
          fullText += sentence
          continue
        }

        if (event.type === 'done') {
          if (!fullText) fullText = String(event.fullText ?? '')
          break
        }
      }
    } catch (error) {
      if (!isAbortError(error) && !isStopped(signal)) {
        log.warn?.('大脑事件流失败', { deviceId: ctx.deviceId, error: messageOf(error) })
      }
    }

    if (closed) return
    // 打断后不再下发任何消息（含 tts stop）：会话层在 abort 时自行收尾，
    // 且 ctx 会拒绝已中止轮次的下发。
    if (aborted) {
      speaking = false
      framer.reset()
      return
    }
    endSpeaking()
    if (fullText) appendLog('assistant', fullText, { sentences: sentenceCount })
    if (isStopped(signal)) return
    ctx.transition(continuous ? 'listening' : 'idle', { reason: 'qa:done' })
  }

  const asrPipeline = createAsrPipeline({
    ctx,
    asr,
    vad,
    config,
    logger: log,
    onTranscript: (text, { signal }) => runTurn(text, signal),
  })

  return {
    onOpen: (args) => asrPipeline.onOpen?.(args),

    onListenStart(args) {
      aborted = false
      framer.reset()
      speaking = false
      currentEmotion = ''
      asrPipeline.onListenStart?.(args)
    },

    onListenStop() {
      asrPipeline.onListenStop?.()
    },

    onAudio(frame, meta) {
      asrPipeline.onAudio?.(frame, meta)
    },

    onVad(event, meta) {
      asrPipeline.onVad?.(event, meta)
    },

    onAbort() {
      aborted = true
      speaking = false
      framer.reset()
      asrPipeline.onAbort?.()
    },

    onClose() {
      closed = true
      aborted = true
      speaking = false
      framer.close()
      asrPipeline.onClose?.()
    },

    /** 等待在途音频/转写结束（测试用）。 */
    async drain() {
      await asrPipeline.drain?.()
      await audioQueue.drain()
    },
  }
}
