// ESP32 通道：流式句切分（T19 / E 道）
//
// 把 LLM 的增量文本切成可以立刻送 TTS 的句子：
//   · 硬句界：。！？；… ! ? ; 与换行；
//   · 引号/括号内的句末不切（「」『』“”‘’（）()【】[]《》〈〉）；
//     引号闭合时，如果引号里最后是句末标点，则在闭合引号后切；
//   · 超长软上限（默认 60 字）：优先在逗号/顿号/冒号/空格处断，
//     不把 [表情:…] 之类的括号标签切成两半，也不把 emoji 的代理对劈开。
//
// 纯函数，无网络、无时钟依赖；流式与整段走同一套扫描逻辑。

export const DEFAULT_SENTENCE_SOFT_LIMIT = 60

const TERMINATORS = new Set(['。', '！', '？', '；', '…', '!', '?', ';'])
const SOFT_BREAKS = new Set(['，', '、', '：', ',', ':', ' ', '\t', '　'])

// 开括号 → 闭括号。只列成对且不会被当成普通标点的符号。
const OPENERS = new Map([
  ['「', '」'], ['『', '』'],
  ['“', '”'], ['‘', '’'],
  ['（', '）'], ['(', ')'],
  ['【', '】'], ['[', ']'],
  ['《', '》'], ['〈', '〉'],
  ['{', '}'],
])
const CLOSERS = new Set(OPENERS.values())

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff

/** 从 endIdx 往前看，跳过连续闭括号后是否为句末标点（“他说。”」 这种）。 */
function endsWithTerminator(buf, endIdx) {
  let i = endIdx
  while (i >= 0 && CLOSERS.has(buf[i])) i--
  return i >= 0 && TERMINATORS.has(buf[i])
}

/**
 * 找下一个硬句界。
 * @returns {number} 切点（不含首尾空白由调用方 trim）；-1 表示还没出现句界。
 */
function nextBoundary(buf) {
  const stack = [] // 待匹配的闭括号
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (stack.length) {
      if (c === stack[stack.length - 1]) {
        stack.pop()
        // 引号/括号闭合到最外层：若里面最后是句末标点，在闭括号后成句
        if (!stack.length && endsWithTerminator(buf, i - 1)) return i + 1
      } else if (OPENERS.has(c)) {
        stack.push(OPENERS.get(c))
      }
      // 引号内的句末/换行一律不切
      continue
    }

    if (c === '\n' || c === '\r') return i + 1
    if (TERMINATORS.has(c)) {
      let j = i + 1
      while (j < buf.length && TERMINATORS.has(buf[j])) j++
      return j
    }
    if (OPENERS.has(c)) stack.push(OPENERS.get(c))
  }
  return -1
}

/**
 * 超长时挑一个软切点。
 * 规则：优先最后一个软分隔符；若切点落在一个未闭合的括号标签里，则退到标签开头。
 * @returns {number} 切点下标（[0, cut) 为一段）；-1 表示暂不切（等待标签闭合）。
 */
function chooseSoftCut(buf, softLimit) {
  const limit = Math.min(softLimit, buf.length)
  const stack = []
  let lastSoft = -1
  const half = Math.floor(limit / 2)

  for (let i = 0; i < limit; i++) {
    const c = buf[i]
    if (stack.length) {
      if (c === stack[stack.length - 1].closer) stack.pop()
      else if (OPENERS.has(c)) stack.push({ closer: OPENERS.get(c), index: i })
      continue
    }
    if (OPENERS.has(c)) {
      stack.push({ closer: OPENERS.get(c), index: i })
      continue
    }
    if (SOFT_BREAKS.has(c) && i + 1 >= half) lastSoft = i
  }

  let cut
  if (stack.length) {
    const protectStart = stack[0].index
    // 标签在句首且还没闭合：等它闭合（flush 兜底），别切出空段
    if (protectStart <= 0) return -1
    cut = Math.min(protectStart, lastSoft >= 0 ? lastSoft + 1 : protectStart)
  } else {
    cut = lastSoft >= 0 ? lastSoft + 1 : limit
  }

  if (!Number.isFinite(cut) || cut <= 0) return -1
  // 不劈开 emoji 的代理对：切点前是高位代理 → 连同低位一起带走
  if (cut < buf.length && isHighSurrogate(buf.charCodeAt(cut - 1)) && isLowSurrogate(buf.charCodeAt(cut))) cut++
  return cut
}

/**
 * 流式句切分器。
 * @param {{softLimit?: number}} [opts]
 */
export function createSentenceSplitter({ softLimit = DEFAULT_SENTENCE_SOFT_LIMIT } = {}) {
  const limit = Number.isFinite(softLimit) && softLimit > 0 ? Math.floor(softLimit) : DEFAULT_SENTENCE_SOFT_LIMIT
  let buf = ''

  const take = (cut, out) => {
    const text = buf.slice(0, cut).trim()
    if (text) out.push(text)
    buf = buf.slice(cut)
  }

  return {
    push(chunk) {
      buf += String(chunk ?? '')
      const out = []
      while (buf) {
        const boundary = nextBoundary(buf)
        if (boundary >= 0) {
          take(boundary, out)
          continue
        }
        if (buf.length < limit) break
        const cut = chooseSoftCut(buf, limit)
        if (cut <= 0) break
        take(cut, out)
      }
      return out
    },
    flush() {
      const out = []
      const text = buf.trim()
      if (text) out.push(text)
      buf = ''
      return out
    },
  }
}

/** 一次性切分整段文本（等价于 push + flush）。 */
export function splitSentences(text, opts) {
  const s = createSentenceSplitter(opts)
  const out = s.push(text)
  out.push(...s.flush())
  return out
}
