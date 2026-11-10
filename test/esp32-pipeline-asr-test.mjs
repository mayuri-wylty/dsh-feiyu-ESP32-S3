// ESP32 通道 · T21「ASR 链」测试
//
// 用 fake VAD（直接吐事件）+ fake ASR（校验 WAV 头与样本数）+ fake ctx，断言：
//   1. speech_start/speech_end 之间按 atMs 从预滚缓冲裁出完整语音，WAV 头正确；
//   2. 转写成功 → sendStt(text)，状态 recognizing → listening；
//   3. 空转写 / ASR 抛错 / 超时：不 sendStt、不崩会话、状态回落；
//   4. 预滚缓冲容量有界（超长语音只保留窗口内样本）；
//   5. manual 模式（无 VAD 事件）以 listen stop 整段转写；
//   6. abort 后不再转写。
//
// 不联网、不写配置目录。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createAsrPipeline } = await import('../lib/esp32/pipeline/asr.js')
const { createPrerollBuffer } = await import('../lib/esp32/pipeline/common.js')
const { parsePcmWav } = await import('../lib/esp32/audio/wav.js')
const { AUDIO } = await import('../lib/esp32/contracts.js')

const RATE = AUDIO.uplink.sampleRate
const FRAME = AUDIO.uplink.samplesPerFrame

// ── 工具 ────────────────────────────────────────────────────────────────────

function sine(samples, { frequency = 440, amplitude = 12000 } = {}) {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE))
  }
  return pcm
}

function createFakeCtx() {
  const sentJson = []
  const transitions = []
  let state = 'listening'
  let closed = false
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  return {
    sentJson,
    transitions,
    get state() {
      return state
    },
    sendJson(json) {
      if (closed) return false
      sentJson.push(json)
      return true
    },
    sendBinary() {
      return !closed
    },
    getState: () => state,
    transition(next) {
      if (closed) return false
      transitions.push(next)
      state = next
      return true
    },
    sendStt(text) {
      if (closed) return false
      sentJson.push({ type: 'stt', text })
      return true
    },
    sendTts(args) {
      if (closed) return false
      sentJson.push({ type: 'tts', ...args })
      return true
    },
    sendLlm(args) {
      if (closed) return false
      sentJson.push({ type: 'llm', ...args })
      return true
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    getSignal: () => null,
    logger,
    deviceId: 'asr-dev',
    clientId: 'asr-cli',
    sessionId: 'asr-sess',
    remoteAddress: '127.0.0.1',
    close() {
      closed = true
    },
  }
}

/** 可编程 fake VAD：push 时按脚本吐事件，不真正分析音频。 */
function createScriptedVad(script) {
  let index = 0
  return {
    push() {
      if (index >= script.length) return []
      const step = script[index++]
      return Array.isArray(step) ? step : [step]
    },
    flush() {
      return []
    },
    reset() {},
    state: 'silence',
    isSpeech: false,
    noiseFloor: 0,
    thresholds: { start: 0, end: 0 },
    stats: { frames: 0, voicedFrames: 0, segments: 0 },
    config: {},
  }
}

/**
 * 构造与帧数对齐的 VAD 脚本：events 是 {帧序号: 事件} 映射，其余帧返回空数组。
 * 事件必须落在实际喂帧的范围内，否则 speech_end 时缓冲里还没有足够音频。
 */
function scriptOf(frames, events) {
  const script = Array.from({ length: frames }, () => [])
  for (const [index, event] of Object.entries(events)) {
    script[Number(index)] = Array.isArray(event) ? event : [event]
  }
  return script
}

function createFakeAsr({ text = '你好，我是大肥鱼', delayMs = 0, error = null } = {}) {
  const calls = []
  return {
    id: 'sensevoice',
    calls,
    async transcribe(args) {
      calls.push(args)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (error) throw error
      return { text, ms: 12 }
    },
  }
}

const sttOf = (ctx) => ctx.sentJson.filter((json) => json.type === 'stt')

// ── 1. 预滚缓冲单元 ─────────────────────────────────────────────────────────
test('预滚缓冲：固定容量、覆盖最旧样本、按绝对序号裁剪', () => {
  const buf = createPrerollBuffer({ sampleRate: 1000, capacityMs: 10 }) // 10 点
  assert.equal(buf.capacity, 10)
  buf.push(Int16Array.from([1, 2, 3, 4, 5, 6]))
  assert.equal(buf.totalSamples, 6)
  assert.deepEqual(Array.from(buf.slice(0, 6)), [1, 2, 3, 4, 5, 6])

  buf.push(Int16Array.from([7, 8, 9, 10, 11, 12, 13, 14]))
  assert.equal(buf.totalSamples, 14)
  assert.equal(buf.oldestSample, 4)
  // 窗口 [4,14) 保留 10 点
  assert.deepEqual(Array.from(buf.slice(0, 14)), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  assert.deepEqual(Array.from(buf.slice(10, 14)), [11, 12, 13, 14])
  assert.equal(buf.slice(0, 2).length, 0, '窗口外区间应裁剪为空')

  buf.clear()
  assert.equal(buf.totalSamples, 0)
  assert.equal(buf.slice(0, 10).length, 0)
})

// ── 2. VAD 切段 → WAV → ASR → stt ───────────────────────────────────────────
test('speech_start/speech_end 裁出完整语音，WAV 头正确，sendStt 收到文本', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '今天天气不错' })
  // 16 帧：第 0 帧 speech_start(0ms)，最后一帧 speech_end(1000ms)
  const vad = createScriptedVad(
    scriptOf(16, {
      0: { type: 'speech_start', atMs: 0 },
      15: { type: 'speech_end', atMs: 1000, reason: 'silence' },
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })

  // 喂 1 秒音频（16 帧 × 960 点 = 15360 点 = 960ms，接近 1000ms）
  for (let i = 0; i < 16; i++) {
    const frame = sine(FRAME, { frequency: 300 + i * 20 })
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await pipeline.drain()

  assert.equal(asr.calls.length, 1, '应调用一次 ASR')
  const call = asr.calls[0]
  assert.equal(call.sampleRate, RATE)
  assert.ok(call.wav instanceof Uint8Array)

  const parsed = parsePcmWav(call.wav)
  assert.equal(parsed.sampleRate, RATE, 'WAV 采样率必须是 16k')
  assert.equal(parsed.channels, 1, 'WAV 必须是单声道')
  // 1000ms @16k = 16000 点；实际只喂了 15360 点，裁剪到可用范围
  assert.equal(parsed.pcm.length, 15360, `WAV 样本数应为 15360，实际 ${parsed.pcm.length}`)
  assert.ok(parsed.pcm.length >= 0.9 * 16000, '样本数应在预期范围（≥90% 的 1 秒）')

  assert.deepEqual(sttOf(ctx), [{ type: 'stt', text: '今天天气不错' }])
  assert.deepEqual(ctx.transitions, ['recognizing', 'listening'])
  assert.equal(pipeline.stats.transcribed, 1)
  pipeline.onClose()
})

test('speech_start 回溯到真实起点：预滚缓冲包含起点前的音频', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '嗯' })
  // 25 帧：第 8 帧 speech_start(500ms)，最后一帧 speech_end(1500ms)
  const vad = createScriptedVad(
    scriptOf(25, {
      8: { type: 'speech_start', atMs: 500 },
      24: { type: 'speech_end', atMs: 1500, reason: 'silence' },
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })
  for (let i = 0; i < 25; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await pipeline.drain()

  assert.equal(asr.calls.length, 1)
  const parsed = parsePcmWav(asr.calls[0].wav)
  // [500ms, 1500ms) = 16000 点；实际喂了 25×960=24000 点，足够
  assert.equal(parsed.pcm.length, 16000, `应裁出 1 秒（16000 点），实际 ${parsed.pcm.length}`)
  pipeline.onClose()
})

// ── 3. 空转写 / 抛错 / 超时 ─────────────────────────────────────────────────
test('空转写：不 sendStt，状态回落 listening，不崩', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '   ' })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })
  for (let i = 0; i < 14; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await pipeline.drain()

  assert.equal(asr.calls.length, 1)
  assert.equal(sttOf(ctx).length, 0, '空文本不得下发 stt')
  assert.equal(pipeline.stats.empty, 1)
  assert.deepEqual(ctx.transitions, ['recognizing', 'listening'])
  pipeline.onClose()
})

test('ASR 抛错：不 sendStt、不崩会话、状态回落 listening', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ error: new Error('sensevoice 500') })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })
  for (let i = 0; i < 14; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await assert.doesNotReject(() => pipeline.drain())

  assert.equal(asr.calls.length, 1)
  assert.equal(sttOf(ctx).length, 0, 'ASR 失败不得下发 stt')
  assert.equal(pipeline.stats.failed, 1)
  assert.deepEqual(ctx.transitions, ['recognizing', 'listening'])
  pipeline.onClose()
})

test('ASR 超时（TimeoutError）：按失败处理，不崩', async () => {
  const ctx = createFakeCtx()
  const timeout = new Error('ASR 请求超时（100ms）')
  timeout.name = 'TimeoutError'
  const asr = createFakeAsr({ error: timeout })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })
  for (let i = 0; i < 14; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await pipeline.drain()
  assert.equal(sttOf(ctx).length, 0)
  assert.equal(pipeline.stats.failed, 1)
  pipeline.onClose()
})

// ── 4. 过短段跳过 ───────────────────────────────────────────────────────────
test('短于 minSpeechMs 的段不送 ASR', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr()
  const vad = createScriptedVad(
    scriptOf(5, {
      0: { type: 'speech_start', atMs: 0 },
      4: { type: 'speech_end', atMs: 100, reason: 'silence' }, // 100ms < 250ms
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })
  for (let i = 0; i < 5; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await pipeline.drain()
  assert.equal(asr.calls.length, 0, '过短段不应调用 ASR')
  assert.equal(pipeline.stats.skipped, 1)
  pipeline.onClose()
})

// ── 5. 预滚缓冲有界 ─────────────────────────────────────────────────────────
test('超长语音：预滚缓冲容量有界，WAV 不超过 maxSpeechMs + 余量', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '很长的一段话' })
  const vad = createScriptedVad(
    scriptOf(84, {
      0: { type: 'speech_start', atMs: 0 },
      83: { type: 'speech_end', atMs: 5000, reason: 'max' },
    }),
  )
  const pipeline = createAsrPipeline({
    ctx,
    asr,
    vad,
    config: { vad: { minSpeechMs: 250, maxSpeechMs: 2000, silenceMs: 700 } },
    prerollMarginMs: 500,
  })
  // 喂 5 秒音频（远超 2s 上限）
  for (let i = 0; i < 84; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  await pipeline.drain()

  assert.equal(asr.calls.length, 1)
  const parsed = parsePcmWav(asr.calls[0].wav)
  const capacitySamples = Math.ceil(((2000 + 700 + 500) * RATE) / 1000)
  assert.ok(
    parsed.pcm.length <= capacitySamples,
    `WAV 样本数 ${parsed.pcm.length} 不应超过缓冲容量 ${capacitySamples}`,
  )
  assert.ok(parsed.pcm.length > 0)
  pipeline.onClose()
})

// ── 6. manual 模式 ──────────────────────────────────────────────────────────
test('manual 模式：无 VAD 事件时以 listen stop 整段转写', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '手动模式' })
  const vad = createScriptedVad([]) // 永不吐事件
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })

  pipeline.onListenStart({ mode: 'manual' })
  for (let i = 0; i < 20; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  pipeline.onListenStop()
  await pipeline.drain()

  assert.equal(asr.calls.length, 1, 'manual 模式应在 listen stop 时转写整段')
  const parsed = parsePcmWav(asr.calls[0].wav)
  assert.equal(parsed.pcm.length, 20 * FRAME, '整段 20 帧应全部进入 WAV')
  assert.deepEqual(sttOf(ctx), [{ type: 'stt', text: '手动模式' }])
  pipeline.onClose()
})

// ── 7. abort ────────────────────────────────────────────────────────────────
test('abort 后不再转写，预滚缓冲清空', async () => {
  const ctx = createFakeCtx()
  const asr = createFakeAsr({ text: '不该出现' })
  const vad = createScriptedVad(
    scriptOf(14, {
      0: { type: 'speech_start', atMs: 0 },
      13: { type: 'speech_end', atMs: 800, reason: 'silence' },
    }),
  )
  const pipeline = createAsrPipeline({ ctx, asr, vad, config: { vad: { minSpeechMs: 250 } } })
  for (let i = 0; i < 14; i++) {
    const frame = sine(FRAME)
    pipeline.onAudio(frame, { sampleRate: RATE, samples: frame.length })
  }
  pipeline.onAbort()
  await pipeline.drain()
  assert.equal(sttOf(ctx).length, 0, 'abort 后不得下发 stt')
  assert.equal(pipeline.preroll.totalSamples, 0, 'abort 应清空预滚缓冲')
  pipeline.onClose()
})

// ── 8. 构造校验 ─────────────────────────────────────────────────────────────
test('缺少 asr / ctx 时抛 TypeError', () => {
  assert.throws(() => createAsrPipeline({}), TypeError)
  assert.throws(() => createAsrPipeline({ ctx: createFakeCtx() }), TypeError)
  assert.throws(
    () => createAsrPipeline({ ctx: createFakeCtx(), asr: { id: 'x' } }),
    TypeError,
  )
})
