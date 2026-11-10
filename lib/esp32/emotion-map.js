// feiyu 情绪 → 小智固件表情（T19 / E 道）
//
// 映射表不在这里复制第二份：直接复用 lib/esp32/contracts.js 的
// EMOTION_TO_FIRMWARE / firmwareEmotionOf，保证契约是唯一事实源。
//
// 另提供"流式情绪标签解析"：模型通常把 [[撒娇]] 写在回复最前面，
// 但流式 chunk 可能把它切开。这里先缓冲，等首句句末出现（或缓冲到 40 字）
// 再交给 parseEmotionTag 解析；期间不向下游吐文本。

import {
  EMOTION_TO_FIRMWARE,
  firmwareEmotionOf,
} from './contracts.js'
import { parseEmotionTag as defaultParseEmotionTag } from '../../tools/lib/emotion.mjs'

export { EMOTION_TO_FIRMWARE, firmwareEmotionOf }

/** 标签缓冲上限：超过这么多字还没见到句末，就按"没有标签"处理。 */
export const DEFAULT_EMOTION_TAG_MAX_CHARS = 40

const SENTENCE_END = /[。！？；…!?;\n\r]/

/** 缓冲是否已经足够判断情绪标签（跳过纯空白）。 */
export function shouldResolveEmotionBuffer(buffer, maxChars = DEFAULT_EMOTION_TAG_MAX_CHARS) {
  const text = String(buffer ?? '')
  if (!text.trim()) return false
  return SENTENCE_END.test(text) || text.length >= maxChars
}

/**
 * 创建流式情绪标签解析器。
 * push(chunk) → { resolved, emotion, text }
 *   resolved=false 时 text 恒为 ''（还在缓冲）；
 *   resolved=true 后所有文本原样透传，emotion 只在首次解析时返回。
 * flush() → 结束缓冲（用于流结束仍没等到句末的情况）。
 *
 * @param {{maxChars?: number, parse?: (text: string) => {emotion?: string, text?: string}}} [opts]
 */
export function createEmotionTagStream({
  maxChars = DEFAULT_EMOTION_TAG_MAX_CHARS,
  parse = defaultParseEmotionTag,
} = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_EMOTION_TAG_MAX_CHARS
  const parseTag = typeof parse === 'function' ? parse : defaultParseEmotionTag
  let buffer = ''
  let resolved = false

  const resolve = () => {
    // 前导空白不影响标签识别（换行开头的回复很常见），解析前去掉
    const parsed = parseTag(buffer.replace(/^\s+/, ''))
    buffer = ''
    resolved = true
    return {
      resolved: true,
      emotion: String(parsed?.emotion || ''),
      text: String(parsed?.text ?? ''),
    }
  }

  return {
    push(chunk) {
      const text = String(chunk ?? '')
      if (resolved) return { resolved: true, emotion: '', text }
      buffer += text
      if (!shouldResolveEmotionBuffer(buffer, limit)) {
        return { resolved: false, emotion: '', text: '' }
      }
      return resolve()
    },
    flush() {
      if (resolved) return { resolved: true, emotion: '', text: '' }
      return resolve()
    },
    get resolved() { return resolved },
    get buffered() { return buffer },
  }
}
