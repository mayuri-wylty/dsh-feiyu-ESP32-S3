// ESP32 通道：大脑桥（T19 / E 道）
//
// 设计 §5 步骤 6–9：一轮语音输入 → 记忆 → 装配 → 流式 LLM → 逐句清洗 → 事件流。
// 上行只有一句话，下行是给终端的状态机：
//   { type: 'emotion', emotion }        固件表情（整轮一次，在首句前）
//   { type: 'sentence', text, index }   可直接送 TTS 的句子
//   { type: 'done', fullText }          本轮结束（含被打断的收尾）
//
// 关键语义（与设计/测试对齐）：
//   · guard 是**逐句**调用的 —— 下游 TTS 本来就一句一句念；整段只在 done 里做记录。
//   · 打断（signal abort）：只记录**已经 yield 出去**的句子；一句都没有就不写 assistant 记忆；
//     不调用 brain.onSent（没发完整条回复）。用户那句仍然先入记忆。
//   · 唤醒问候（listen detect）不进 LLM、不写记忆，直接播 esp32.greetings。

import * as realLlm from '../../tools/lib/llm.mjs'
import * as realMemory from '../../tools/lib/memory.mjs'
import * as realBrain from '../../tools/brain/index.mjs'
import * as realPersona from '../../tools/lib/persona.mjs'
import * as realGuard from '../../tools/lib/guard.mjs'
import * as realEmotion from '../../tools/lib/emotion.mjs'
import { config as realConfig } from '../../tools/lib/config.mjs'
import { createSentenceSplitter } from './sentence.js'
import { createEmotionTagStream } from './emotion-map.js'

const PLATFORM = 'esp32'
const INTERRUPTED_SUFFIX = '（被打断）'

/** 从配置里随机挑一句唤醒问候；不是数组 / 全空 → null。random 可注入（测试用）。 */
export function pickGreeting(cfg, random = Math.random) {
  const list = cfg?.esp32?.greetings
  if (!Array.isArray(list)) return null
  const items = list.map((g) => String(g ?? '').trim()).filter(Boolean)
  if (!items.length) return null
  const r = Number(random())
  const idx = Math.min(items.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * items.length)))
  return items[idx]
}

function safeReturn(iterator) {
  try {
    const r = iterator?.return?.()
    if (r && typeof r.then === 'function') r.then(undefined, () => {})
  } catch { /* 中断时清理失败不冒泡 */ }
}

/**
 * 带外部 signal 的 iterator.next()：
 * 返回 { kind: 'next'|'error'|'abort', ... }。abort 时主动 return() 释放上游流。
 * 不依赖 AbortSignal.any，避免旧 Node。
 */
function nextWithAbort(iterator, signal) {
  if (!signal) return Promise.resolve(iterator.next()).then(
    (value) => ({ kind: 'next', value }),
    (error) => ({ kind: 'error', error }),
  )
  if (signal.aborted) {
    safeReturn(iterator)
    return Promise.resolve({ kind: 'abort' })
  }
  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      safeReturn(iterator)
      resolve({ kind: 'abort' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(iterator.next()).then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ kind: 'next', value })
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ kind: 'error', error })
      },
    )
  })
}

/**
 * 创建大脑桥。所有依赖可注入（测试用内存 fake）；默认接真实模块。
 * @param {{
 *   llmStream?: (messages: object[], opts: object) => AsyncIterable<string>,
 *   memory?: object, brain?: object, persona?: object, guard?: object,
 *   emotion?: object, config?: (() => object) | object,
 * }} [deps]
 */
export function createBrainBridge(deps = {}) {
  const llmStream = deps.llmStream ?? realLlm.chatStream
  const memory = deps.memory ?? realMemory
  const brain = deps.brain ?? realBrain
  const persona = deps.persona ?? realPersona
  const guard = deps.guard ?? realGuard
  const emotion = deps.emotion ?? realEmotion
  const configDep = deps.config ?? realConfig
  const readConfig = typeof configDep === 'function' ? configDep : () => configDep

  function cleanSentence(raw, cfg) {
    let text
    try {
      text = guard?.clean ? guard.clean(raw, cfg) : raw
    } catch {
      text = raw
    }
    return String(text ?? '').trim()
  }

  function turnsOf(chatId) {
    try {
      const rows = memory.recent?.(chatId)
      return Array.isArray(rows) ? rows.length : 0
    } catch {
      return 0
    }
  }

  async function buildMessages({ userText, chatId, userId, cfg }) {
    const turnsToday = turnsOf(chatId)
    const opts = { platform: PLATFORM, userText, chatId, userId, turnsToday, isGroup: false }
    try {
      const assembled = await brain?.assembleFor?.(opts)
      if (assembled && Array.isArray(assembled.messages) && assembled.messages.length) {
        return assembled.messages
      }
    } catch { /* 脑装配失败 → persona 兜底 */ }
    return persona.buildMessages(opts)
  }

  /**
   * 一轮用户发言 → 事件流。
   * @param {{deviceId?: string, chatId?: string, userId?: string, text?: string,
   *          signal?: AbortSignal, isWakeGreeting?: boolean}} input
   * @returns {AsyncGenerator<object>}
   */
  async function* handleUtterance(input = {}) {
    const { deviceId = '', signal } = input
    const chatId = input.chatId || `${PLATFORM}:${deviceId}`
    const userId = input.userId || 'owner'
    const cfg = readConfig() ?? {}

    // 唤醒问候：只听一声唤醒，没有 ASR 文本，也不该进上下文/记忆。
    if (input.isWakeGreeting === true) {
      const greeting = pickGreeting(cfg)
      if (!greeting) {
        yield { type: 'done', fullText: '' }
        return
      }
      // 问候固定中性：吐空键，由 qa.js 统一映射成固件 neutral。
      yield { type: 'emotion', emotion: '' }
      yield { type: 'sentence', text: greeting, index: 0 }
      yield { type: 'done', fullText: greeting }
      return
    }

    const userText = String(input.text ?? '').trim()
    if (!userText) {
      yield { type: 'done', fullText: '' }
      return
    }

    memory.remember(PLATFORM, chatId, userId, 'user', userText)
    const messages = await buildMessages({ userText, chatId, userId, cfg })

    const emotionStream = createEmotionTagStream(
      typeof emotion?.parseEmotionTag === 'function' ? { parse: emotion.parseEmotionTag } : undefined,
    )
    const splitter = createSentenceSplitter()

    let fullText = ''
    let index = 0
    let emotionEmitted = false
    let pendingEmotion = ''
    let aborted = signal?.aborted === true

    function* emitSentence(rawSentence) {
      if (aborted || signal?.aborted) {
        aborted = true
        return
      }
      const cleaned = cleanSentence(rawSentence, cfg)
      if (!cleaned) return
      if (!emotionEmitted) {
        // 只吐 feiyu 原始情绪键（如 'coquettish'）：固件表情名由消费方 qa.js 单次映射，
        // TTS 参考音色也要用原始键。这里再映射一次会让 qa.js 二次映射成 neutral。
        yield { type: 'emotion', emotion: pendingEmotion }
        emotionEmitted = true
        // 消费者可能正好在 emotion 之后打断：恢复时再确认一次
        if (aborted || signal?.aborted) {
          aborted = true
          return
        }
      }
      fullText += cleaned
      yield { type: 'sentence', text: cleaned, index: index++ }
    }

    function* drain(chunk) {
      if (aborted) return
      for (const rawSentence of splitter.push(chunk)) {
        if (aborted) return
        yield* emitSentence(rawSentence)
      }
    }

    if (!aborted) {
      const iterator = llmStream(messages, { signal })[Symbol.asyncIterator]()
      while (true) {
        const step = await nextWithAbort(iterator, signal)
        if (step.kind === 'abort') { aborted = true; break }
        if (step.kind === 'error') throw step.error
        if (step.value.done) break
        const rawDelta = step.value.value
        if (rawDelta == null) continue

        const emo = emotionStream.push(rawDelta)
        if (emo.resolved && !pendingEmotion && emo.emotion) pendingEmotion = emo.emotion
        if (emo.text) yield* drain(emo.text)
        if (aborted) break
      }
    }

    if (!aborted && signal?.aborted) aborted = true

    // 正常收尾：把情绪标签缓冲与句切分器里剩的尾巴吐完（被打断则丢弃未说出的部分）
    if (!aborted) {
      const tail = emotionStream.flush()
      if (tail.text) yield* drain(tail.text)
    }
    if (!aborted) {
      for (const rawSentence of splitter.flush()) {
        if (aborted) break
        yield* emitSentence(rawSentence)
      }
    }
    if (!aborted && signal?.aborted) aborted = true

    if (aborted) {
      if (index > 0 && fullText) {
        memory.remember(PLATFORM, chatId, userId, 'assistant', fullText + INTERRUPTED_SUFFIX)
      }
    } else if (fullText) {
      memory.remember(PLATFORM, chatId, userId, 'assistant', fullText)
      try {
        brain?.onSent?.({
          chat: chatId,
          platform: PLATFORM,
          text: fullText,
          msgId: '',
          kind: 'reply',
          at: Date.now(),
        })
      } catch { /* 投递记录失败不影响本轮 */ }
    }

    yield { type: 'done', fullText }
  }

  return { handleUtterance }
}
