// ESP32 第五通道 · T16「TTS 句级」测试
//
// 覆盖：
// 1. 从 tools/lib/tts.mjs 抽取的请求组装（prepareSovits / buildSovitsRequest）行为；
// 2. sovits-sentence provider：每句一次请求、wav→PCM16、采样率按 WAV 头如实上报；
// 3. 失败路径：HTTP 非 2xx、超时、AbortSignal 取消（含排队中取消）；
// 4. 进程内串行优先队列：realtime 插队到 normal 之前，同一时刻最多一个 9880 请求。
//
// 全部使用 node:http 假 GPT-SoVITS，不连真实 9880。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// tts.mjs 依赖的 paths.mjs 在 import 时解析 dataDir，必须先设环境再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-tts-'))
process.env.FEIYU_DATA_DIR = path.join(TMP, 'data')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })

const { prepareSovits, buildSovitsRequest, sanitizeForTts, PASS_THROUGH, synth } =
  await import('../tools/lib/tts.mjs')
const { createTtsQueue, getTtsQueue, TTS_PRIORITY } = await import('../lib/esp32/tts/queue.js')
const { parseWavToPcm } = await import('../lib/esp32/tts/wav.js')
const { createSovitsSentenceProvider, sovitsSentenceProvider, SOVITS_SENTENCE_ID } =
  await import('../lib/esp32/tts/sovits-sentence.js')
const { TTS_PROVIDER_IDS } = await import('../lib/esp32/contracts.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 测试工具 ───────────────────────────────────────────────────────────────

const REF = { ref_audio_path: 'C:/fake/emo.wav', prompt_text: '情绪参考', from: 'test' }

/** 组装一条合法 WAV（默认 16bit PCM）。samples 按“帧 × 声道”交错排列。 */
function makeWav({ sampleRate = 32000, channels = 1, samples = [], extensible = false } = {}) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2)
  const fmtSize = extensible ? 40 : 16
  const h = Buffer.alloc(12 + 8 + fmtSize + 8)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(4 + 8 + fmtSize + 8 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(fmtSize, 16)
  h.writeUInt16LE(extensible ? 0xfffe : 1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(16, 34)
  if (extensible) {
    h.writeUInt16LE(22, 36) // cbSize
    h.writeUInt16LE(16, 38) // validBits
    h.writeUInt32LE(4, 40)  // channelMask：front center
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(h, 44) // PCM SubFormat GUID
  }
  h.write('data', 20 + fmtSize, 'ascii')
  h.writeUInt32LE(data.length, 24 + fmtSize)
  return Buffer.concat([h, data])
}

/** >2000 字节的默认测试音频（ttsOnce 的过短阈值是 2000 字节）。 */
function makeTestWav({ sampleRate = 32000, channels = 1, frames = 1200, samples } = {}) {
  const arr = samples ?? new Array(frames * channels).fill(0)
  return makeWav({ sampleRate, channels, samples: arr })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/tts`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(fn, timeoutMs = 3000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** provider 的公共测试参数：显式 voice/ref，避免读用户配置、避免参考段体检。 */
function providerOpts(url, extra = {}) {
  return { url, queue: createTtsQueue(), ref: REF, voice: {}, ...extra }
}

// ── 1. tools/lib/tts.mjs 抽取出的请求组装 ──────────────────────────────────

test('抽取：prepareSovits 解析情绪标签、清洗文本、选定参考段', () => {
  const p = prepareSovits('[[撒娇]] 你回来啦 (・_・;) 🐟', { ref: REF })
  assert.equal(p.speak, '你回来啦')
  assert.equal(p.emotion, 'coquettish')
  assert.equal(p.profile.label, '撒娇')
  assert.equal(p.ref, REF)

  // 显式 emotion 优先于文本标签
  const explicit = prepareSovits('[[撒娇]] 你回来啦', { emotion: 'happy', ref: REF })
  assert.equal(explicit.emotion, 'happy')
  assert.equal(explicit.profile.temperature, 1.45)

  assert.equal(sanitizeForTts('(・_・;) 🐟'), '')
  assert.throws(() => prepareSovits('(・_・;) 🐟', { ref: REF }), /GBK/)
})

test('抽取：buildSovitsRequest 请求体字段（PASS_THROUGH 与 override 优先级）', () => {
  const voice = {
    sovits_url: 'http://127.0.0.1:9880/tts',
    text_lang: 'zh',
    prompt_lang: 'zh',
    text_split_method: 'cut0',
    top_k: 5,
    seed: 42,
    batch_size: 2,
  }
  const req = buildSovitsRequest('[[开心]] 主人，晚上好 (・_・;) 🐟', {
    voice,
    ref: REF,
    override: { top_k: 9, temperature: 1.11 },
  })
  assert.equal(req.url, 'http://127.0.0.1:9880/tts')
  assert.equal(req.text, '主人，晚上好')
  assert.equal(req.emotion, 'happy')
  assert.equal(req.body.text, '主人，晚上好')
  assert.equal(req.body.text_lang, 'zh')
  assert.equal(req.body.media_type, 'wav')
  assert.equal(req.body.streaming_mode, false)
  assert.equal(req.body.ref_audio_path, 'C:/fake/emo.wav')
  assert.equal(req.body.prompt_text, '情绪参考')
  assert.equal(req.body.prompt_lang, 'zh')
  assert.equal(req.body.text_split_method, 'cut0')
  assert.equal(req.body.temperature, 1.11)   // override 赢过情绪默认值
  assert.equal(req.body.speed_factor, 1.05)  // happy 默认语速
  assert.equal(req.body.fragment_interval, 0.22)
  assert.equal(req.body.top_k, 9)            // override 赢过配置
  assert.equal(req.body.seed, 42)            // 配置透传
  assert.equal(req.body.batch_size, 2)
  assert.ok(PASS_THROUGH.includes('seed'))
})

test('抽取：override.ref_audio_path 优先于配置参考段', () => {
  const req = buildSovitsRequest('你好', {
    voice: { sovits_url: 'http://x/tts', ref_audio_path: 'C:/fake/base.wav', prompt_text: '基础' },
    override: { ref_audio_path: 'C:/fake/override.wav' },
  })
  assert.equal(req.body.ref_audio_path, 'C:/fake/override.wav')
  // 没有同名 .txt 且 override 未给 prompt_text → 留空，不能沿用别的参考文本
  assert.equal(req.body.prompt_text, '')
})

// ── 2. WAV → PCM16 ─────────────────────────────────────────────────────────

test('wav→PCM：16bit 单声道原样取出', () => {
  const r = parseWavToPcm(makeWav({ sampleRate: 24000, samples: [0, 32767, -32768, 1234] }))
  assert.equal(r.sampleRate, 24000)
  assert.equal(r.channels, 1)
  assert.equal(r.bits, 16)
  assert.deepEqual([...r.pcm], [0, 32767, -32768, 1234])
})

test('wav→PCM：立体声下混成单声道', () => {
  const r = parseWavToPcm(makeWav({ sampleRate: 32000, channels: 2, samples: [100, 300, -1000, 0] }))
  assert.equal(r.channels, 2)
  assert.deepEqual([...r.pcm], [200, -500])
})

test('wav→PCM：WAVE_FORMAT_EXTENSIBLE（soundfile 常见）', () => {
  const r = parseWavToPcm(makeWav({ sampleRate: 32000, samples: [7, -7], extensible: true }))
  assert.equal(r.sampleRate, 32000)
  assert.deepEqual([...r.pcm], [7, -7])
})

test('wav→PCM：非 WAV / 非 16bit / 缺 data 明确报错', () => {
  assert.throws(() => parseWavToPcm(Buffer.from('not a wav at all')), /WAV/)
  const badBits = makeWav({ samples: [1] })
  badBits.writeUInt16LE(8, 34)
  assert.throws(() => parseWavToPcm(badBits), /16bit/)
  assert.throws(() => parseWavToPcm(makeWav({ samples: [1] }).subarray(0, 36)), /data/)
})

// ── 3. sovits-sentence provider ────────────────────────────────────────────

test('sovits-sentence：每句一次请求、字段正确、wav→PCM16、采样率如实上报', async () => {
  const seen = []
  const srv = await startServer(async (req, res) => {
    seen.push(JSON.parse((await readBody(req)).toString('utf8')))
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    res.end(makeTestWav({ sampleRate: 32000, samples: [0, 100, -100, ...new Array(1197).fill(0)] }))
  })
  try {
    const provider = createSovitsSentenceProvider(providerOpts(srv.url, {
      voice: { text_lang: 'zh', prompt_lang: 'zh', text_split_method: 'cut0', top_k: 7 },
    }))
    assert.equal(provider.id, SOVITS_SENTENCE_ID)
    assert.ok(TTS_PROVIDER_IDS.includes(provider.id))
    assert.equal(sovitsSentenceProvider.id, 'sovits-sentence')

    const chunks = await collect(provider.stream('[[开心]] 你好呀 (・_・;) 🐟', { emotion: 'happy' }))
    assert.equal(seen.length, 1) // 一句话一次请求（句级，candidates=1）
    assert.equal(seen[0].text, '你好呀')
    assert.equal(seen[0].streaming_mode, false)
    assert.equal(seen[0].media_type, 'wav')
    assert.equal(seen[0].top_k, 7)
    assert.equal(seen[0].temperature, 1.45)
    assert.equal(seen[0].ref_audio_path, REF.ref_audio_path)

    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].pcm instanceof Int16Array)
    assert.equal(chunks[0].pcm.length, 1200)
    assert.deepEqual([...chunks[0].pcm.slice(0, 3)], [0, 100, -100])
    // 24k 结论：api_v2 没有输出采样率参数，WAV 头是什么就报什么（这里故意给 32k）
    assert.equal(chunks[0].sampleRate, 32000)
  } finally {
    await srv.close()
  }
})

test('sovits-sentence：HTTP 500 带出服务端错误信息', async () => {
  const srv = await startServer(async (req, res) => {
    await readBody(req)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'tts failed', Exception: "'gbk' codec can't encode character" }))
  })
  try {
    const provider = createSovitsSentenceProvider(providerOpts(srv.url))
    await assert.rejects(collect(provider.stream('你好')), (e) => {
      assert.match(e.message, /HTTP 500/)
      assert.match(e.message, /gbk/)
      return true
    })
  } finally {
    await srv.close()
  }
})

test('sovits-sentence：超时报错、释放队列且队列还能继续用', async () => {
  let hits = 0
  const srv = await startServer((req) => {
    hits += 1
    req.resume() // 收下请求但永不响应
  })
  try {
    const q = createTtsQueue()
    const provider = createSovitsSentenceProvider(providerOpts(srv.url, { queue: q, timeoutMs: 80 }))
    const t0 = Date.now()
    await assert.rejects(collect(provider.stream('你好')), /超时/)
    assert.ok(Date.now() - t0 < 3000, '超时应远小于请求超时上限')
    assert.equal(hits, 1)
    await waitFor(() => q.stats().running === 0)
    assert.equal(q.size(), 0)
    assert.equal(await q.enqueue(async () => 'ok'), 'ok')
  } finally {
    await srv.close()
  }
})

test('sovits-sentence：AbortSignal 取消在途请求（AbortError）', async () => {
  let hits = 0
  const srv = await startServer((req) => {
    hits += 1
    req.resume()
  })
  try {
    const q = createTtsQueue()
    const provider = createSovitsSentenceProvider(providerOpts(srv.url, { queue: q, timeoutMs: 5000 }))
    const ctrl = new AbortController()
    const p = collect(provider.stream('你好', { signal: ctrl.signal }))
    await waitFor(() => hits === 1)
    ctrl.abort()
    await assert.rejects(p, (e) => e.name === 'AbortError')
    await waitFor(() => q.stats().running === 0)
    assert.equal(q.size(), 0)
  } finally {
    await srv.close()
  }
})

test('sovits-sentence：signal 已取消时连 9880 都不请求', async () => {
  let calls = 0
  const provider = createSovitsSentenceProvider({
    ...providerOpts('http://127.0.0.1:1/tts'),
    fetch: async () => {
      calls += 1
      throw new Error('不该发请求')
    },
  })
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(collect(provider.stream('你好', { signal: ctrl.signal })), (e) => e.name === 'AbortError')
  assert.equal(calls, 0)
})

test('sovits-sentence：并发两句串行，任意时刻只有一个 9880 请求', async () => {
  let active = 0
  let maxActive = 0
  const srv = await startServer(async (req, res) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await readBody(req)
    await new Promise((resolve) => setTimeout(resolve, 25))
    active -= 1
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    res.end(makeTestWav({ sampleRate: 24000 }))
  })
  try {
    const provider = createSovitsSentenceProvider(providerOpts(srv.url))
    const [a, b] = await Promise.all([
      collect(provider.stream('第一句')),
      collect(provider.stream('第二句')),
    ])
    assert.equal(maxActive, 1)
    assert.equal(a[0].sampleRate, 24000)
    assert.equal(b[0].sampleRate, 24000)
  } finally {
    await srv.close()
  }
})

// ── 4. 串行优先队列 ────────────────────────────────────────────────────────

test('队列：串行执行，realtime 插队到 normal 之前', async () => {
  const q = createTtsQueue()
  const events = []
  const gate = {}
  gate.p = new Promise((resolve) => { gate.release = resolve })
  const p1 = q.enqueue(async () => {
    events.push('start:1')
    await gate.p
    events.push('end:1')
  }, { priority: TTS_PRIORITY.NORMAL })
  const p2 = q.enqueue(async () => { events.push('start:2') }, { priority: TTS_PRIORITY.NORMAL })
  const p3 = q.enqueue(async () => { events.push('start:3') }, { priority: TTS_PRIORITY.REALTIME })

  await tick()
  assert.deepEqual(events, ['start:1'])
  assert.equal(q.stats().running, 1)
  assert.equal(q.stats().queued, 2)
  assert.equal(q.size(), 3)

  gate.release()
  await Promise.all([p1, p2, p3])
  assert.deepEqual(events, ['start:1', 'end:1', 'start:3', 'start:2'])
  assert.equal(q.stats().running, 0)
  assert.equal(q.size(), 0)
  assert.equal(q.stats().done, 3)
  assert.equal(q.stats().failed, 0)
})

test('队列：排队中 abort 立即拒绝且永不执行', async () => {
  const q = createTtsQueue()
  const gate = {}
  gate.p = new Promise((resolve) => { gate.release = resolve })
  const p1 = q.enqueue(() => gate.p, { priority: TTS_PRIORITY.NORMAL })
  const ctrl = new AbortController()
  let ran = false
  const p2 = q.enqueue(async () => { ran = true }, { priority: TTS_PRIORITY.REALTIME, signal: ctrl.signal })

  await tick()
  assert.equal(q.stats().queued, 1)
  const rejected = assert.rejects(p2, (e) => e.name === 'AbortError')
  ctrl.abort()
  await rejected
  gate.release()
  await p1
  assert.equal(ran, false)
  assert.equal(q.size(), 0)
  assert.equal(q.stats().aborted, 1)
})

test('队列：signal 已取消的 enqueue 直接拒绝，不执行任务', async () => {
  const q = createTtsQueue()
  const ctrl = new AbortController()
  ctrl.abort()
  let ran = false
  await assert.rejects(q.enqueue(() => { ran = true }, { signal: ctrl.signal }), (e) => e.name === 'AbortError')
  assert.equal(ran, false)
})

test('队列：运行中 abort 后要等任务真正结束才启动下一条（严格串行）', async () => {
  const q = createTtsQueue()
  const events = []
  const ctrl = new AbortController()
  let finish
  const running = q.enqueue(
    (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => events.push('abort-signal'))
      finish = () => resolve('late')
    }),
    { priority: TTS_PRIORITY.REALTIME, signal: ctrl.signal },
  )
  const next = q.enqueue(async () => { events.push('next-start') }, { priority: TTS_PRIORITY.NORMAL })

  await tick()
  ctrl.abort()
  await assert.rejects(running, (e) => e.name === 'AbortError')
  await tick()
  assert.deepEqual(events, ['abort-signal']) // 底层任务没结束，下一条不许开始
  assert.equal(q.stats().running, 1)

  finish()
  await next
  assert.deepEqual(events, ['abort-signal', 'next-start'])
})

test('队列：任务失败不堵住后续任务', async () => {
  const q = createTtsQueue()
  const p1 = q.enqueue(async () => { throw new Error('boom') })
  const p2 = q.enqueue(async () => 'next')
  await assert.rejects(p1, /boom/)
  assert.equal(await p2, 'next')
  await waitFor(() => q.size() === 0)
  assert.equal(q.stats().failed, 1)
  assert.equal(q.stats().done, 1)
})

test('队列：getTtsQueue 在进程内是同一个实例', () => {
  assert.equal(getTtsQueue(), getTtsQueue())
  assert.equal(typeof getTtsQueue().enqueue, 'function')
})

// ── 5. 旧 synth() 回归：抽取后行为不变（fake 9880，不发真实请求） ──────────

test('synth() 回归：抽取请求组装后仍能走完整合成链', async () => {
  const bodies = []
  const srv = await startServer(async (req, res) => {
    bodies.push(JSON.parse((await readBody(req)).toString('utf8')))
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    res.end(makeTestWav({ sampleRate: 32000 }))
  })
  try {
    fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify({
      voice: {
        sovits_url: srv.url,
        ref_audio_path: 'C:/fake/base.wav',
        prompt_text: '基础参考',
        candidates: 1,
        pick: 'first',
        chunkChars: 80,
        chunkGapSec: 0,
      },
    }))
    const out = path.join(TMP, 'synth-out.wav')
    const file = await synth('[[开心]] 回归测试，你好', out)
    assert.equal(file, out)
    assert.ok(fs.existsSync(out))
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].text, '回归测试，你好')
    assert.equal(bodies[0].temperature, 1.45)
    assert.equal(bodies[0].speed_factor, 1.05)
    assert.equal(bodies[0].streaming_mode, false)
    assert.equal(bodies[0].ref_audio_path, 'C:/fake/base.wav')
    assert.equal(bodies[0].prompt_text, '基础参考')
  } finally {
    await srv.close()
  }
})
