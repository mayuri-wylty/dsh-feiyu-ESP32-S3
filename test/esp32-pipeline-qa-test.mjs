// ESP32 通道 · T22「完整问答管线」测试
//
// 用 fake brain（固定事件流）+ fake tts（固定 PCM）+ fake ctx，断言：
//   1. 消息顺序：stt → llm(emotion) → tts start → sentence_start → 音频帧 → tts stop；
//   2. 下行 Opus 帧可解码，样本数 1440，内容与 TTS 输入相关；
//   3. 多句严格串行：前一句的帧全部发完才发下一句；
//   4. tts stop 是最后一条 tts 消息，之后回落 listening；
//   5. abort 后不再有任何下发；
//   6. channelLog 收到 user / assistant 两条记录；
//   7. 记忆不由本管线写入（brain 内部负责）。
//
// 不联网、不写配置目录。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createQaPipeline } = await import('../lib/esp32/pipeline/qa.js')
const { OpusDecoder } = await import('../lib/esp32/audio/opus.js')
const { resamplePcm } = await import('../lib/esp32/audio/resample.js')
const { AUDIO } = await import('../lib/esp32/contracts.js')

const UPLINK = AUDIO.uplink.sampleRate
const DOWNLINK = AUDIO.downlink.sampleRate
const FRAME = AUDIO.downlink.samplesPerFrame
const UPLINK_FRAME = AUDIO.uplink.samplesPerFrame

// ── 工具 ────────────────────────────────────────────────────────────────────

function sine(samples, { sampleRate = UPLINK, frequency = 440, amplitude = 12000 } = {}) {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate))
  }
  return pcm
}

function rms(pcm) {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / Math.max(1, pcm.length))
}

function bestCorrelation(a, b, maxLag = 400) {
  let best = 0
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < b.length; i++) {
      const j = i + lag
      if (j < 0 || j >= a.length) continue
      dot += a[j] * b[i]
      na += a[j] * a[j]
      nb += b[i] * b[i]
    }
    if (na === 0 || nb === 0) continue
    const c = dot / Math.sqrt(na * nb)
    if (c > best) best = c
  }
  return best
}

/** 记录所有下发事件的 fake ctx；events 保留全局顺序。 */
function createFakeCtx() {
  const events = []
  const sentBinary = []
  const sentJson = []
  const transitions = []
  let state = 'listening'
  let closed = false
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const push = (entry) => {
    if (closed) return false
    events.push(entry)
    return true
  }
  return {
    events,
    sentBinary,
    sentJson,
    transitions,
    get state() {
      return state
    },
    sendJson(json) {
      return push({ kind: 'json', json })
    },
    sendBinary(buffer) {
      if (!push({ kind: 'binary', buffer })) return false
      sentBinary.push(buffer)
      return true
    },
    getState: () => state,
    transition(next) {
      if (closed) return false
      transitions.push(next)
      state = next
      return true
    },
    sendStt(text) {
      if (!push({ kind: 'stt', text })) return false
      sentJson.push({ type: 'stt', text })
      return true
    },
    sendTts(args) {
      if (!push({ kind: 'tts', ...args })) return false
      sentJson.push({ type: 'tts', ...args })
      return true
    },
    sendLlm(args) {
      if (!push({ kind: 'llm', ...args })) return false
      sentJson.push({ type: 'llm', ...args })
      return true
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    getSignal: () => null,
    logger,
    deviceId: 'qa-dev',
    clientId: 'qa-cli',
    sessionId: 'qa-sess',
    remoteAddress: '127.0.0.1',
    close() {
      closed = true
    },
  }
}

function createScriptedVad(script) {
  let index = 0
  return {
    push() {
      if (index >= script.length) return []
      const step = script[index++]
      return Array.isArray(step) ? step : [step]
    },
    flush: () => [],
    reset() {},
    state: 'silence',
    isSpeech: false,
    noiseFloor: 0,
    thresholds: { start: 0, end: 0 },
    stats: { frames: 0, voicedFrames: 0, segments: 0 },
    config: {},
  }
}

function scriptOf(frames, events) {
  const script = Array.from({ length: frames }, () => [])
  for (const [index, event] of Object.entries(events)) {
    script[Number(index)] = Array.isArray(event) ? event : [event]
  }
  return script
}

function createFakeAsr({ text = '讲个笑话', error = null } = {}) {
  const calls = []
  return {
    calls,
    async transcribe(args) {
      calls.push(args)
      if (error) throw error
      return { text, ms: 8 }
    },
  }
}

/** fake TTS：每句固定吐 2 块 24k PCM（每块 1000 点，非整帧）。 */
function createFakeTts({ chunksPerSentence = 2, chunkSamples = 1000, error = null } = {}) {
  const calls = []
  return {
    calls,
    async *stream(text, options) {
      calls.push({ text, options })
      if (error) throw error
      for (let i = 0; i < chunksPerSentence; i++) {
        if (options?.signal?.aborted) return
        yield { pcm: sine(chunkSamples, { sampleRate: DOWNLINK, frequency: 400 + i * 100 }), sampleRate: DOWNLINK }
      }
    },
  }
}

/** fake brain：固定事件流，记录调用参数。 */
function createFakeBrain({ sentences = ['第一句话。', '第二句话。'], emotion = 'happy', error = null } = {}) {
  const calls = []
  return {
    calls,
    async *handleUtterance(args) {
      calls.push(args)
      if (error) throw error
      yield { type: 'emotion', emotion }
      for (const [index, text] of sentences.entries()) {
        if (args.signal?.aborted) return
        yield { type: 'sentence', text, index }
      }
      yield { type: 'done', fullText: sentences.join('') }
    },
  }
}

function createFakeChannelLog() {
  const entries = []
  return {
    entries,
    append(entry) {
      entries.push(entry)
    },
  }
}

const decoder = new OpusDecoder(DOWNLINK)
test.after(() => decoder.close())

const ttsEvents = (ctx) => ctx.events.filter((e) => e.kind === 'tts')
const kinds = (ctx) => ctx.events.map((e) => e.kind)

/** 喂一段语音并触发 speech_end，跑完一轮问答。 */
async function runOneTurn(pipeline, { frames = 14 } = {}) {
  for (let i = 0; i < frames; i++) {
    const frame = sine(UPLINK_FRAME)
    pipeline.onAudio(frame, { sampleRate: UPLINK, samples: frame.length })
  }
  await pipeline.drain()
}

// ── 1. 完整一轮：顺序与内容 ─────────────────────────────────────────────────
test('一轮问答：stt → llm(emotion) → tts start → sentence_start → 音频 → tts stop', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '讲个笑话' })
  const tts = createFakeTts()
  const brain = createFakeBrain({ sentences: ['第一句话。', '第二句话。'], emotion: 'happy' })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })

  await runOneTurn(pipeline)

  // 状态迁移：recognizing → thinking → speaking → listening
  assert.deepEqual(ctx.transitions, ['recognizing', 'thinking', 'speaking', 'listening'])

  // 消息顺序
  const seq = kinds(ctx)
  assert.equal(seq[0], 'llm', '第一条应是 llm(emotion)')
  assert.deepEqual(ctx.events[0], { kind: 'llm', emotion: 'happy' })

  const ttsSeq = ttsEvents(ctx).map((e) => e.state)
  assert.deepEqual(ttsSeq, ['start', 'sentence_start', 'sentence_start', 'stop'])

  // 音频帧在 sentence_start 之后、stop 之前
  const firstSentenceIdx = ctx.events.findIndex((e) => e.kind === 'tts' && e.state === 'sentence_start')
  const stopIdx = ctx.events.findIndex((e) => e.kind === 'tts' && e.state === 'stop')
  const binaryIdxs = ctx.events.map((e, i) => (e.kind === 'binary' ? i : -1)).filter((i) => i >= 0)
  assert.ok(binaryIdxs.length > 0, '应有下行音频帧')
  assert.ok(binaryIdxs[0] > firstSentenceIdx, '音频帧应在 sentence_start 之后')
  assert.ok(binaryIdxs.at(-1) < stopIdx, '音频帧应在 tts stop 之前')

  // 每句 2 块 × 1000 点 = 2000 点 @24k → 1 帧 1440 + 残余 560；两句共 4000 点 → 2 帧 + 残余 1120
  // 结束时 flush 补一帧 → 共 3 帧
  assert.equal(ctx.sentBinary.length, 3, `下行帧数应为 3，实际 ${ctx.sentBinary.length}`)
  for (const [index, packet] of ctx.sentBinary.entries()) {
    const pcm = decoder.decode(packet)
    assert.equal(pcm.length, FRAME, `第 ${index + 1} 帧应解码为 1440 点`)
    assert.ok(rms(pcm) > 500, `第 ${index + 1} 帧能量过低：${rms(pcm).toFixed(1)}`)
  }

  // 内容近似：第一帧对应第一块 TTS PCM
  const reference = resamplePcm(sine(1000, { sampleRate: DOWNLINK, frequency: 400 }), DOWNLINK, DOWNLINK)
  const corr = bestCorrelation(reference, decoder.decode(ctx.sentBinary[0]))
  assert.ok(corr > 0.8, `下行音频与 TTS 输入相关性过低：${corr.toFixed(3)}`)

  // tts stop 是最后一条 tts 消息
  assert.equal(ttsEvents(ctx).at(-1).state, 'stop')
  pipeline.onClose()
})

// ── 2. 多句严格串行 ─────────────────────────────────────────────────────────
test('多句串行：前一句的帧全部发完才发下一句的 sentence_start', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts({ chunksPerSentence: 3, chunkSamples: 1440 })
  const brain = createFakeBrain({ sentences: ['甲。', '乙。', '丙。'] })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await runOneTurn(pipeline)

  // 每句 3 块 × 1440 点 = 3 帧，三句共 9 帧，无残余
  assert.equal(ctx.sentBinary.length, 9, `应为 9 帧，实际 ${ctx.sentBinary.length}`)

  // 检查每个 sentence_start 之前，上一句的帧已全部发完：
  // 事件序列中，sentence_start 之间应恰好夹着 3 个 binary。
  const seq = ctx.events
  const starts = seq.map((e, i) => (e.kind === 'tts' && e.state === 'sentence_start' ? i : -1)).filter((i) => i >= 0)
  assert.equal(starts.length, 3)
  for (let s = 1; s < starts.length; s++) {
    const between = seq.slice(starts[s - 1], starts[s]).filter((e) => e.kind === 'binary').length
    assert.equal(between, 3, `第 ${s} 句与第 ${s + 1} 句之间应有 3 帧，实际 ${between}`)
  }
  pipeline.onClose()
})

// ── 3. abort ────────────────────────────────────────────────────────────────
test('abort 后不再有任何下发', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts({ chunksPerSentence: 5, chunkSamples: 1440 })
  const brain = createFakeBrain({ sentences: ['甲。', '乙。', '丙。'] })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })

  // 喂完语音后立刻 abort（转写/合成还在队列里）
  for (let i = 0; i < 14; i++) {
    const frame = sine(UPLINK_FRAME)
    pipeline.onAudio(frame, { sampleRate: UPLINK, samples: frame.length })
  }
  pipeline.onAbort()
  const countAtAbort = ctx.events.length
  await pipeline.drain()

  assert.equal(ctx.events.length, countAtAbort, 'abort 后不得再有任何下发')
  assert.equal(ctx.sentBinary.length, 0, 'abort 后不得下发音频')
  pipeline.onClose()
})

test('abort 发生在播放中途：后续句子不再下发', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  // 第一句吐 2 块后 abort
  let aborted = false
  const tts = {
    async *stream(text, options) {
      yield { pcm: sine(1440, { sampleRate: DOWNLINK }), sampleRate: DOWNLINK }
      yield { pcm: sine(1440, { sampleRate: DOWNLINK }), sampleRate: DOWNLINK }
      if (text === '甲。') {
        aborted = true
        pipeline.onAbort()
      }
    },
  }
  const brain = createFakeBrain({ sentences: ['甲。', '乙。'] })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await runOneTurn(pipeline)

  assert.ok(aborted, '测试应触发 abort')
  const sentenceStarts = ttsEvents(ctx).filter((e) => e.state === 'sentence_start')
  assert.equal(sentenceStarts.length, 1, 'abort 后第二句不应开始')
  assert.equal(sentenceStarts[0].text, '甲。')
  pipeline.onClose()
})

// ── 4. channelLog ───────────────────────────────────────────────────────────
test('channelLog 收到 user / assistant 两条记录', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '你好' })
  const tts = createFakeTts()
  const brain = createFakeBrain({ sentences: ['你好呀。', '很高兴见到你。'] })
  const channelLog = createFakeChannelLog()
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({
    ctx,
    asr,
    tts,
    brain,
    vad,
    channelLog,
    config: { vad: { minSpeechMs: 250 } },
  })
  await runOneTurn(pipeline)

  assert.equal(channelLog.entries.length, 2, `应有 2 条日志，实际 ${channelLog.entries.length}`)
  const [user, assistant] = channelLog.entries
  assert.equal(user.role, 'user')
  assert.equal(user.text, '你好')
  assert.equal(user.deviceId, 'qa-dev')
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.text, '你好呀。很高兴见到你。')
  assert.equal(assistant.meta.sentences, 2)
  pipeline.onClose()
})

// ── 5. 记忆不由本管线写入 ───────────────────────────────────────────────────
test('记忆由 brain 内部写入：管线不额外调用任何记忆接口', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts()
  const brain = createFakeBrain({ sentences: ['好。'] })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await runOneTurn(pipeline)

  assert.equal(brain.calls.length, 1)
  const call = brain.calls[0]
  assert.equal(call.text, '讲个笑话')
  assert.equal(call.deviceId, 'qa-dev')
  assert.equal(call.userId, 'owner')
  assert.ok(call.chatId, '应传 chatId')
  // 管线对象上不应暴露记忆写入
  assert.equal(pipeline.memory, undefined)
  pipeline.onClose()
})

// ── 6. 异常路径 ─────────────────────────────────────────────────────────────
test('brain 抛错：不崩，已开始的 TTS 收尾（stop），回落 listening', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts()
  // 先吐一句，再抛错：验证已开始的播放能正常收尾
  const brain = {
    calls: [],
    async *handleUtterance(args) {
      this.calls.push(args)
      yield { type: 'emotion', emotion: 'happy' }
      yield { type: 'sentence', text: '甲。', index: 0 }
      throw new Error('llm 502')
    },
  }
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await assert.doesNotReject(() => runOneTurn(pipeline))

  assert.equal(ctx.transitions.at(-1), 'listening')
  assert.equal(ttsEvents(ctx).at(-1).state, 'stop', '已开始的播放必须收尾')
  pipeline.onClose()
})

test('brain 首事件即抛错：不崩，不下发 tts，回落 listening', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts()
  const brain = createFakeBrain({ error: new Error('llm 502') })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await assert.doesNotReject(() => runOneTurn(pipeline))

  assert.equal(ctx.transitions.at(-1), 'listening')
  assert.equal(ttsEvents(ctx).length, 0, '未开始播放时不应下发 tts')
  pipeline.onClose()
})

test('TTS 抛错：跳过该句，不崩，仍收尾', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts({ error: new Error('tts 503') })
  const brain = createFakeBrain({ sentences: ['甲。', '乙。'] })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await assert.doesNotReject(() => runOneTurn(pipeline))

  assert.equal(ctx.transitions.at(-1), 'listening')
  assert.equal(ttsEvents(ctx).at(-1).state, 'stop')
  pipeline.onClose()
})

test('ASR 失败：不进入 thinking，不下发任何 tts', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ error: new Error('asr 500') })
  const tts = createFakeTts()
  const brain = createFakeBrain()
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr, tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await runOneTurn(pipeline)

  assert.equal(brain.calls.length, 0, 'ASR 失败不应调用 brain')
  assert.equal(ttsEvents(ctx).length, 0, 'ASR 失败不应下发 tts')
  assert.equal(ctx.transitions.at(-1), 'listening')
  pipeline.onClose()
})

// ── 7. 连续对话开关 ─────────────────────────────────────────────────────────
test('continuous=false 时结束后回落 idle', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const tts = createFakeTts()
  const brain = createFakeBrain({ sentences: ['好。'] })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({
    ctx,
    asr,
    tts,
    brain,
    vad,
    continuous: false,
    config: { vad: { minSpeechMs: 250 } },
  })
  await runOneTurn(pipeline)
  assert.equal(ctx.transitions.at(-1), 'idle')
  pipeline.onClose()
})

// ── 8. 构造校验 ─────────────────────────────────────────────────────────────
test('缺少 ctx / tts / brain 时抛 TypeError', () => {
  const ctx = createFakeCtx()
  assert.throws(() => createQaPipeline({}), TypeError)
  assert.throws(() => createQaPipeline({ ctx, asr: createFakeAsr(), brain: createFakeBrain() }), TypeError)
  assert.throws(() => createQaPipeline({ ctx, asr: createFakeAsr(), tts: createFakeTts() }), TypeError)
})

test('llm{emotion} 下发固件表情名（feiyu 情绪 → 固件名）', async () => {
  const ctx = createFakeCtx()
  const tts = createFakeTts()
  const brain = createFakeBrain({ sentences: ['好。'], emotion: 'coquettish' })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createQaPipeline({ ctx, asr: createFakeAsr(), tts, brain, vad, config: { vad: { minSpeechMs: 250 } } })
  await runOneTurn(pipeline)

  const llm = ctx.events.find((e) => e.kind === 'llm')
  assert.equal(llm.emotion, 'kissy', 'coquettish 应映射为固件表情 kissy')
  pipeline.onClose()
})

// ── 9. listen detect 唤醒问候（T25）─────────────────────────────────────────
/** 可控制时机的 brain：问候分支可被 gate 卡住，用于模拟「被 listen start 取消」。 */
function createGreetingBrain({ greeting = '我在呢', gate = null } = {}) {
  const calls = []
  return {
    calls,
    async *handleUtterance(args) {
      calls.push(args)
      if (args.isWakeGreeting) {
        if (gate) await gate
        if (args.signal?.aborted) return
        yield { type: 'emotion', emotion: '' }
        if (greeting) yield { type: 'sentence', text: greeting, index: 0 }
        yield { type: 'done', fullText: greeting }
        return
      }
      yield { type: 'emotion', emotion: 'happy' }
      yield { type: 'sentence', text: '回答。', index: 0 }
      yield { type: 'done', fullText: '回答。' }
    },
  }
}

test('listen detect：播固定问候，不写记忆、不调 LLM', async () => {
  const ctx = createFakeCtx()
  const tts = createFakeTts()
  const brain = createGreetingBrain({ greeting: '我在呢' })
  const channelLog = createFakeChannelLog()
  const pipeline = createQaPipeline({ ctx, asr: createFakeAsr(), tts, brain, channelLog })

  pipeline.onListenStart({ mode: 'auto', detect: true, text: '大肥鱼' })
  await pipeline.drain()

  assert.equal(brain.calls.length, 1)
  assert.equal(brain.calls[0].isWakeGreeting, true, '应走唤醒问候分支')
  assert.equal(brain.calls[0].text, '', '问候不带用户文本')
  assert.deepEqual(ttsEvents(ctx).map((e) => e.state), ['start', 'sentence_start', 'stop'])
  assert.equal(ttsEvents(ctx)[1].text, '我在呢')
  assert.ok(ctx.sentBinary.length > 0, '问候应下发音频')
  assert.equal(channelLog.entries.length, 0, '问候不写通道日志（不写记忆）')
  assert.equal(ctx.transitions.at(-1), 'listening', '问候播完应回落 listening')
  pipeline.onClose()
})

test('listen detect：greetings 为空时不播任何 TTS', async () => {
  const ctx = createFakeCtx()
  const tts = createFakeTts()
  const brain = createGreetingBrain({ greeting: '' })
  const pipeline = createQaPipeline({ ctx, asr: createFakeAsr(), tts, brain })

  pipeline.onListenStart({ mode: 'auto', detect: true, text: '大肥鱼' })
  await pipeline.drain()

  assert.equal(ttsEvents(ctx).length, 0, '空问候不应下发 tts')
  assert.equal(ctx.sentBinary.length, 0)
  pipeline.onClose()
})

test('listen detect 被 listen start 取消且未出声：在下一轮补播一次', async () => {
  const ctx = createFakeCtx()
  const tts = createFakeTts()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const brain = createGreetingBrain({ greeting: '我在呢', gate })
  const pipeline = createQaPipeline({ ctx, asr: createFakeAsr(), tts, brain })

  pipeline.onListenStart({ mode: 'auto', detect: true, text: '大肥鱼' })
  // 固件紧接着发 listen start：会话取消 detect 轮次
  pipeline.onAbort()
  pipeline.onListenStart({ mode: 'auto' })
  release()
  await pipeline.drain()

  const greetings = brain.calls.filter((c) => c.isWakeGreeting)
  assert.equal(greetings.length, 2, 'detect 一次 + 补播一次')
  const starts = ttsEvents(ctx).filter((e) => e.state === 'sentence_start')
  assert.equal(starts.length, 1, '只应真正播一次问候')
  assert.equal(starts[0].text, '我在呢')
  pipeline.onClose()
})

test('listen detect 已出声后被取消：不再补播', async () => {
  const ctx = createFakeCtx()
  const tts = createFakeTts()
  const brain = createGreetingBrain({ greeting: '我在呢' })
  const pipeline = createQaPipeline({ ctx, asr: createFakeAsr(), tts, brain })

  pipeline.onListenStart({ mode: 'auto', detect: true, text: '大肥鱼' })
  await pipeline.drain()
  // 用户开始说话：listen start 取消 detect 轮次
  pipeline.onAbort()
  pipeline.onListenStart({ mode: 'auto' })
  await pipeline.drain()

  const starts = ttsEvents(ctx).filter((e) => e.state === 'sentence_start')
  assert.equal(starts.length, 1, '已出声的问候不应重复')
  pipeline.onClose()
})
