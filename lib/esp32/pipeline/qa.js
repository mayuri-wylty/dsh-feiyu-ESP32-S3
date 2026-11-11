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
  // 唤醒问候（T25）：固件在 `listen detect` 之后会立刻发 `listen start`，
  // 后者会取消 detect 轮次（onAbort）。因此 detect 轮次里先尝试播问候
  // （AutoStop 模式下固件会因播放未排空而推迟 `listen start`）；若在出声前
  // 就被取消，则保留 pendingGreeting，在下一个非 detect 轮次补播一次。
  let pendingGreeting = false
  let greetingEmitted = false
  let greetingTask = null
  const pendingTasks = new Set()
  let listenSeq = 0

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
  function speakSentence(text, emotion, signal, onFirstChunk) {
    return audioQueue.enqueue(async () => {
      if (isStopped(signal)) return false
      beginSpeaking()
      ctx.sendTts({ state: 'sentence_start', text })
      try {
        for await (const chunk of tts.stream(text, { emotion, signal })) {
          if (isStopped(signal)) return false
          const pcm = chunk?.pcm
          if (!(pcm instanceof Int16Array) || pcm.length === 0) continue
          onFirstChunk?.()
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

  /** 唤醒问候：走 brain 的 isWakeGreeting 分支（不写记忆、不调 LLM），只播 TTS。
   *  返回是否真的下发过音频（用于判断是否需要补播）。
   *  `seq` 用于识别过期轮次：被新一轮取代后不再收尾（避免误发 tts stop）。 */
  async function runGreeting(signal, seq) {
    if (isStopped(signal)) return false
    const stale = () => seq !== listenSeq
    let emitted = false
    try {
      for await (const event of brain.handleUtterance({
        deviceId: ctx.deviceId,
        chatId: resolvedChatId(),
        userId,
        text: '',
        isWakeGreeting: true,
        signal,
      })) {
        if (isStopped(signal) || stale()) break
        if (!event || typeof event !== 'object') continue
        if (event.type === 'emotion') {
          currentEmotion = String(event.emotion ?? '')
          ctx.sendLlm({ emotion: firmwareEmotionOf(currentEmotion) })
          continue
        }
        if (event.type === 'sentence') {
          const sentence = String(event.text ?? '').trim()
          if (!sentence) continue
          const completed = await speakSentence(sentence, currentEmotion, signal, () => {
            emitted = true
          })
          if (!completed) break
          continue
        }
        if (event.type === 'done') break
      }
    } catch (error) {
      if (!isAbortError(error) && !isStopped(signal)) {
        log.warn?.('唤醒问候失败', { deviceId: ctx.deviceId, error: messageOf(error) })
      }
    }
    if (stale()) return emitted
    if (closed || aborted) {
      speaking = false
      framer.reset()
      return emitted
    }
    endSpeaking()
    // 问候播完回落 listening：否则后续 ASR 的 recognizing 迁移会被状态机拒绝
    // （speaking 的 rank 高于 recognizing，只能回落）。
    ctx.transition('listening', { reason: 'qa:greeting' })
    return emitted
  }

  /** 启动一次问候并记录在途任务，供后续轮次等待/补播。 */
  function startGreeting(signal, seq) {
    const task = runGreeting(signal, seq).then((emitted) => {
      if (emitted) {
        greetingEmitted = true
        pendingGreeting = false
      }
      return emitted
    })
    greetingTask = task
    pendingTasks.add(task)
    void task.finally(() => pendingTasks.delete(task)).catch(() => {})
    return task
  }

  /** 一轮完整问答：brain 事件流 → 逐句 TTS。 */
  async function runTurn(text, signal) {
    if (isStopped(signal)) return
    const turnStart = ctx.now()
    let llmFirstMs
    let ttsFirstMs
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
          if (llmFirstMs === undefined) llmFirstMs = ctx.now() - turnStart
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
          const completed = await speakSentence(sentence, currentEmotion, signal, () => {
            if (ttsFirstMs === undefined) ttsFirstMs = ctx.now() - turnStart
          })
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
    if (fullText) {
      // 耗时 chips（设置页）：只写有值的字段，缺项由前端显示为「—」
      const latency = { totalMs: ctx.now() - turnStart }
      if (llmFirstMs !== undefined) latency.llmFirstMs = llmFirstMs
      if (ttsFirstMs !== undefined) latency.ttsFirstMs = ttsFirstMs
      appendLog('assistant', fullText, { sentences: sentenceCount, latency })
    }
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
      listenSeq += 1
      const seq = listenSeq

      if (args?.detect) {
        // 唤醒：先尝试在 detect 轮次里播问候。固件在 AutoStop 模式下若播放未排空
        // 会推迟 `listen start`，问候有机会播完；若被随后的 start 取消且尚未出声，
        // 保留 pendingGreeting，在下一个非 detect 轮次补播一次。
        pendingGreeting = true
        greetingEmitted = false
        void startGreeting(ctx.getSignal(), seq)
        return
      }

      asrPipeline.onListenStart?.(args)
      if (pendingGreeting && !greetingEmitted) {
        // 等 detect 轮次的问候先收尾：它若已出声就不再补播，避免重复问候。
        const previous = greetingTask
        const task = (async () => {
          if (previous) await previous.catch(() => {})
          if (greetingEmitted || !pendingGreeting || seq !== listenSeq) return false
          pendingGreeting = false
          return startGreeting(ctx.getSignal(), seq)
        })()
        pendingTasks.add(task)
        void task.finally(() => pendingTasks.delete(task)).catch(() => {})
      }
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
      while (pendingTasks.size > 0) {
        await Promise.allSettled([...pendingTasks])
      }
    },
  }
}
