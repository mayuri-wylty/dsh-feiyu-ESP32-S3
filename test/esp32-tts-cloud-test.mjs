// ESP32 第五通道 · T17「云 TTS 与主备回退」测试
//
// 覆盖：
// 1. OpenAI 兼容 /audio/speech：URL 归一化、method/headers/body、apiKey 可空；
// 2. 响应：WAV（RIFF / Content-Type）、24k mono PCM16LE、过短、不支持格式；
// 3. 失败语义：HTTP 错误、超时（TimeoutError）、用户 AbortSignal；
// 4. fallback：主失败未出块才回退、已出块不回退、Abort 不回退、双失败聚合、主成功不调 fallback；
// 5. createTtsProviderFromConfig：sovits-sentence / cloud / 未知 id / fallback 去重。
//
// 全部注入 fake fetch，不访问真实网络；测试里没有真实 API Key。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.mjs 的 paths.mjs 在 import 时解析配置路径，必须先隔离环境再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-tts-cloud-'))
process.env.FEIYU_DATA_DIR = path.join(TMP, 'data')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })

const writeConfig = (obj) => fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify(obj))
writeConfig({})

const { createCloudProvider, normalizeSpeechUrl, CLOUD_PROVIDER_ID } =
  await import('../lib/esp32/tts/cloud.js')
const { createFallbackProvider, createTtsProviderFromConfig, FALLBACK_PROVIDER_ID } =
  await import('../lib/esp32/tts/fallback.js')
const { createTtsQueue } = await import('../lib/esp32/tts/queue.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 测试工具（全部本地构造，不连网） ────────────────────────────────────────

const REF = { ref_audio_path: 'C:/fake/emo.wav', prompt_text: '测试参考', from: 'test' }

/** 构造一条合法 16bit 单声道 WAV。默认 600 帧 = 1244 字节，高于默认 1000 字节下限。 */
function makeWav({ sampleRate = 24000, frames = 600, samples } = {}) {
  const arr = samples ?? new Array(frames).fill(0)
  const data = Buffer.alloc(arr.length * 2)
  for (let i = 0; i < arr.length; i++) data.writeInt16LE(arr[i], i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)  // PCM
  h.writeUInt16LE(1, 22)  // mono
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

function pcmBytes(samples) {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2)
  return buf
}

function httpResponse(body, { status = 200, contentType = 'audio/wav' } = {}) {
  const headers = contentType ? { 'content-type': contentType } : {}
  return new Response(body, { status, headers })
}

/** 记录每次 fetch 的 url/init，并交给 respond 返回 Response。 */
function captureFetch(respond) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  return { calls, fetch }
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

async function waitFor(fn, timeoutMs = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function chunk(value = 1) {
  return { pcm: Int16Array.from([value]), sampleRate: 24000 }
}

function fakeProvider(id, { chunks = [], error = null, onStream } = {}) {
  const provider = {
    id,
    calls: 0,
    async *stream(text, opts) {
      provider.calls += 1
      onStream?.(text, opts)
      for (const c of chunks) yield c
      if (error) throw error
    },
  }
  return provider
}

function abortError() {
  const e = new Error('请求已取消')
  e.name = 'AbortError'
  return e
}

// ── 1. URL 归一化 ──────────────────────────────────────────────────────────

test('cloud：baseUrl 归一化（/audio/speech、/v1、纯 origin/带路径）', () => {
  assert.equal(
    normalizeSpeechUrl('http://127.0.0.1:9000/audio/speech'),
    'http://127.0.0.1:9000/audio/speech',
  )
  assert.equal(
    normalizeSpeechUrl('http://127.0.0.1:9000/v1'),
    'http://127.0.0.1:9000/v1/audio/speech',
  )
  assert.equal(
    normalizeSpeechUrl('http://127.0.0.1:9000'),
    'http://127.0.0.1:9000/v1/audio/speech',
  )
  assert.equal(
    normalizeSpeechUrl('https://api.example.com/v1/'),
    'https://api.example.com/v1/audio/speech',
  )
  assert.equal(
    normalizeSpeechUrl('https://api.example.com/openai'),
    'https://api.example.com/openai/v1/audio/speech',
  )
  assert.throws(() => normalizeSpeechUrl(''), /baseUrl/)
  assert.throws(() => createCloudProvider({ baseUrl: '  ' }), /baseUrl/)
})

// ── 2. 请求形状 ────────────────────────────────────────────────────────────

test('cloud：POST /audio/speech，headers/body 字段正确（apiKey 存在）', async () => {
  const wav = makeWav({ sampleRate: 24000, samples: [0, 100, -100, ...new Array(597).fill(0)] })
  const { calls, fetch } = captureFetch(() => httpResponse(wav))
  const provider = createCloudProvider({
    baseUrl: 'http://tts.local/v1',
    apiKey: 'sk-test',
    model: 'tts-1',
    voice: 'alloy',
    speed: 1.25,
    fetch,
  })
  assert.equal(provider.id, CLOUD_PROVIDER_ID)

  const chunks = await collect(provider.stream('你好呀', { emotion: 'happy' }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://tts.local/v1/audio/speech')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'tts-1',
    input: '你好呀',
    voice: 'alloy',
    response_format: 'wav',
    speed: 1.25,
  })

  assert.equal(chunks.length, 1)
  assert.ok(chunks[0].pcm instanceof Int16Array)
  assert.equal(chunks[0].pcm.length, 600)
  assert.deepEqual([...chunks[0].pcm.slice(0, 3)], [0, 100, -100])
  assert.equal(chunks[0].sampleRate, 24000)
})

test('cloud：apiKey 为空时不带 Authorization，未给 speed 时不发 speed', async () => {
  const { calls, fetch } = captureFetch(() => httpResponse(makeWav({ frames: 600 })))
  const provider = createCloudProvider({
    baseUrl: 'http://tts.local',
    apiKey: '',
    model: 'tts-1',
    voice: 'alloy',
    fetch,
  })
  await collect(provider.stream('你好'))
  assert.equal('Authorization' in calls[0].init.headers, false)
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'response_format', 'voice'])
})

// ── 3. 响应解析 ────────────────────────────────────────────────────────────

test('cloud：WAV 响应按 WAV 头采样率解析（32k 原样上报）', async () => {
  const { fetch } = captureFetch(() => httpResponse(makeWav({ sampleRate: 32000, samples: [7, -7] })))
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch, minBytes: 0 })
  const chunks = await collect(provider.stream('你好'))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].sampleRate, 32000)
  assert.deepEqual([...chunks[0].pcm], [7, -7])
})

test('cloud：Content-Type 缺失但 body 以 RIFF 开头也按 WAV 解析', async () => {
  const { fetch } = captureFetch(() => httpResponse(makeWav({ samples: [11, -11] }), { contentType: '' }))
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch, minBytes: 0 })
  const chunks = await collect(provider.stream('你好'))
  assert.equal(chunks[0].sampleRate, 24000)
  assert.deepEqual([...chunks[0].pcm], [11, -11])
})

test('cloud：raw PCM（audio/pcm 与 application/octet-stream）按 24k/mono/PCM16LE 解析', async () => {
  const samples = [0, 1, -1, 258, -258, 4660, -4660, 32767, -32768, 12345, -12345]
  for (const contentType of ['audio/pcm', 'application/octet-stream']) {
    const { fetch } = captureFetch(() => httpResponse(pcmBytes(samples), { contentType }))
    const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch, minBytes: 0 })
    const chunks = await collect(provider.stream('你好'))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].sampleRate, 24000)
    assert.deepEqual([...chunks[0].pcm], samples, `${contentType} 的 PCM 解析/端序错误`)
  }
})

test('cloud：HTTP 500 错误信息带状态与服务端前 300 字符，且不重试', async () => {
  const longText = 'server exploded: '.repeat(60) // 1020 字符，必然被截断
  const { calls, fetch } = captureFetch(() =>
    httpResponse(longText, { status: 500, contentType: 'text/plain' }))
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch })
  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.match(e.message, /HTTP 500/)
    assert.match(e.message, /server exploded/)
    assert.ok(e.message.length < 400, `错误信息应截断到 300 字符左右，实际 ${e.message.length}`)
    return true
  })
  assert.equal(calls.length, 1) // 不做重试（重试属于回退层/上层）
})

test('cloud：返回音频过短（默认 <1000 字节）报错', async () => {
  const { fetch } = captureFetch(() =>
    httpResponse(pcmBytes(new Array(100).fill(0)), { contentType: 'audio/pcm' }))
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch })
  await assert.rejects(collect(provider.stream('你好')), /过短/)
})

test('cloud：mp3 等不支持格式明确报错（不尝试解码）', async () => {
  const { fetch } = captureFetch(() =>
    httpResponse(Buffer.alloc(2000, 0x55), { contentType: 'audio/mpeg' }))
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch })
  await assert.rejects(collect(provider.stream('你好')), /不支持的音频格式/)
})

// ── 4. 超时与取消 ──────────────────────────────────────────────────────────

test('cloud：超时抛 TimeoutError（不是 AbortError），且只请求一次', async () => {
  let calls = 0
  const fetch = (url, init) => new Promise((resolve, reject) => {
    calls += 1
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch, timeoutMs: 40 })
  const t0 = Date.now()
  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.equal(e.name, 'TimeoutError')
    assert.match(e.message, /超时/)
    return true
  })
  assert.ok(Date.now() - t0 < 2000, '超时应远小于测试等待上限')
  assert.equal(calls, 1)
})

test('cloud：用户 AbortSignal 中止在途请求（AbortError）', async () => {
  let signalSeen = null
  const fetch = (url, init) => new Promise((resolve, reject) => {
    signalSeen = init.signal
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const provider = createCloudProvider({ baseUrl: 'http://tts.local', fetch, timeoutMs: 5000 })
  const ctrl = new AbortController()
  const pending = collect(provider.stream('你好', { signal: ctrl.signal }))
  await waitFor(() => signalSeen)
  ctrl.abort()
  await assert.rejects(pending, (e) => e.name === 'AbortError')
})

test('cloud：signal 已取消时不发请求', async () => {
  let calls = 0
  const provider = createCloudProvider({
    baseUrl: 'http://tts.local',
    fetch: async () => { calls += 1; return httpResponse(makeWav()) },
  })
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(collect(provider.stream('你好', { signal: ctrl.signal })), (e) => e.name === 'AbortError')
  assert.equal(calls, 0)
})

test('cloud：空白文本不发请求、返回空流', async () => {
  let calls = 0
  const provider = createCloudProvider({
    baseUrl: 'http://tts.local',
    fetch: async () => { calls += 1; return httpResponse(makeWav()) },
  })
  assert.deepEqual(await collect(provider.stream('')), [])
  assert.deepEqual(await collect(provider.stream('   \n\t')), [])
  assert.equal(calls, 0)
})

// ── 5. fallback 语义 ───────────────────────────────────────────────────────

test('fallback：主 provider 未出块就失败 → 回退成功并通知', async () => {
  const primary = fakeProvider('cloud', { error: new Error('primary boom') })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(7), chunk(8)] })
  const notices = []
  const provider = createFallbackProvider({
    primary,
    fallback,
    onFallback: (info) => notices.push(info),
  })
  assert.equal(provider.id, FALLBACK_PROVIDER_ID)

  const chunks = await collect(provider.stream('你好'))
  assert.deepEqual(chunks.map((c) => c.pcm[0]), [7, 8])
  assert.equal(primary.calls, 1)
  assert.equal(fallback.calls, 1)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].from, 'cloud')
  assert.equal(notices[0].to, 'sovits-sentence')
  assert.match(notices[0].error.message, /primary boom/)
})

test('fallback：主 provider 空流也视为失败 → 回退', async () => {
  const primary = fakeProvider('cloud', { chunks: [] })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(3)] })
  const notices = []
  const provider = createFallbackProvider({ primary, fallback, onFallback: (i) => notices.push(i) })
  const chunks = await collect(provider.stream('你好'))
  assert.deepEqual(chunks.map((c) => c.pcm[0]), [3])
  assert.equal(fallback.calls, 1)
  assert.equal(notices.length, 1)
  assert.match(notices[0].error.message, /未返回音频/)
})

test('fallback：主已出块后失败 → 不得回退，原样抛给调用方', async () => {
  const primary = fakeProvider('cloud', { chunks: [chunk(1)], error: new Error('late boom') })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(2)] })
  const provider = createFallbackProvider({ primary, fallback })

  const it = provider.stream('你好')[Symbol.asyncIterator]()
  const first = await it.next()
  assert.equal(first.done, false)
  assert.equal(first.value.pcm[0], 1)
  await assert.rejects(it.next(), /late boom/)
  assert.equal(fallback.calls, 0)
})

test('fallback：AbortError 不回退', async () => {
  const primary = fakeProvider('cloud', { error: abortError() })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(2)] })
  const provider = createFallbackProvider({ primary, fallback })
  await assert.rejects(collect(provider.stream('你好')), (e) => e.name === 'AbortError')
  assert.equal(fallback.calls, 0)
})

test('fallback：用户 signal 已中止时（即使主 provider 抛普通错误）也不回退', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const primary = fakeProvider('cloud', { error: new Error('network died') })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(2)] })
  const provider = createFallbackProvider({ primary, fallback })
  await assert.rejects(
    collect(provider.stream('你好', { signal: ctrl.signal })),
    (e) => e.name === 'AbortError',
  )
  assert.equal(fallback.calls, 0)
})

test('fallback：主备都失败 → AggregateError 含两条错误信息', async () => {
  const primary = fakeProvider('cloud', { error: new Error('primary boom') })
  const fallback = fakeProvider('sovits-sentence', { error: new Error('fallback boom') })
  const provider = createFallbackProvider({ primary, fallback })
  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.message, /primary:.*primary boom/)
    assert.match(e.message, /fallback:.*fallback boom/)
    assert.equal(e.errors.length, 2)
    return true
  })
  assert.equal(primary.calls, 1)
  assert.equal(fallback.calls, 1)
})

test('fallback：fallback 也返回空流 → 聚合报错', async () => {
  const primary = fakeProvider('cloud', { error: new Error('primary boom') })
  const fallback = fakeProvider('sovits-sentence', { chunks: [] })
  const provider = createFallbackProvider({ primary, fallback })
  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.message, /fallback:.*未返回音频/)
    return true
  })
})

test('fallback：主成功 → fallback 从不调用、不通知', async () => {
  const primary = fakeProvider('cloud', { chunks: [chunk(1), chunk(2)] })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(9)] })
  const notices = []
  const provider = createFallbackProvider({ primary, fallback, onFallback: (i) => notices.push(i) })
  const chunks = await collect(provider.stream('你好'))
  assert.deepEqual(chunks.map((c) => c.pcm[0]), [1, 2])
  assert.equal(fallback.calls, 0)
  assert.equal(notices.length, 0)
})

test('fallback：空白文本不调用任何 provider', async () => {
  const primary = fakeProvider('cloud', { chunks: [chunk(1)] })
  const fallback = fakeProvider('sovits-sentence', { chunks: [chunk(2)] })
  const provider = createFallbackProvider({ primary, fallback })
  assert.deepEqual(await collect(provider.stream('  ')), [])
  assert.equal(primary.calls, 0)
  assert.equal(fallback.calls, 0)
})

test('fallback：onFallback 的 from/to 使用真实 provider id（外层 id 为 fallback）', async () => {
  const primary = fakeProvider('sovits-sentence', { error: new Error('boom') })
  const fallback = fakeProvider('cloud', { chunks: [chunk(5)] })
  const notices = []
  const provider = createFallbackProvider({ primary, fallback, onFallback: (i) => notices.push(i) })
  await collect(provider.stream('你好'))
  assert.equal(provider.id, 'fallback')
  assert.equal(notices[0].from, 'sovits-sentence')
  assert.equal(notices[0].to, 'cloud')
})

// ── 6. createTtsProviderFromConfig ─────────────────────────────────────────

test('createTtsProviderFromConfig：按配置创建 sovits-sentence', () => {
  writeConfig({ esp32: { tts: { provider: 'sovits-sentence', fallback: '' } } })
  const provider = createTtsProviderFromConfig()
  assert.equal(provider.id, 'sovits-sentence')
  assert.equal(typeof provider.stream, 'function')
})

test('createTtsProviderFromConfig：按配置创建 cloud', () => {
  writeConfig({
    esp32: { tts: { provider: 'cloud', fallback: '', cloud: { baseUrl: 'http://tts.local/v1' } } },
  })
  const provider = createTtsProviderFromConfig()
  assert.equal(provider.id, 'cloud')
})

test('createTtsProviderFromConfig：未知 id 抛清晰错误（主/备都一样）', () => {
  writeConfig({ esp32: { tts: { provider: 'no-such-tts', fallback: '' } } })
  assert.throws(() => createTtsProviderFromConfig(), /未知的 TTS provider/)

  writeConfig({ esp32: { tts: { provider: 'sovits-sentence', fallback: 'also-unknown' } } })
  assert.throws(() => createTtsProviderFromConfig(), /未知的 TTS provider/)
})

test('createTtsProviderFromConfig：fallback 为空或与 primary 相同 → 直接返回 primary', () => {
  const base = { provider: 'cloud', cloud: { baseUrl: 'http://tts.local' } }
  const same = createTtsProviderFromConfig({ ...base, fallback: 'cloud' })
  assert.equal(same.id, 'cloud') // 不包一层无意义 fallback

  const empty = createTtsProviderFromConfig({ ...base, fallback: '' })
  assert.equal(empty.id, 'cloud')
})

test('createTtsProviderFromConfig：primary + 不同 fallback → 包装为 fallback', () => {
  const provider = createTtsProviderFromConfig({
    provider: 'cloud',
    fallback: 'sovits-sentence',
    cloud: { baseUrl: 'http://tts.local' },
    sovits: { queue: createTtsQueue(), ref: REF, voice: {} },
  })
  assert.equal(provider.id, 'fallback')
  assert.equal(typeof provider.stream, 'function')
})

test('createTtsProviderFromConfig：fallback 懒构造，cloud baseUrl 为空不影响 primary 成功', async () => {
  writeConfig({ esp32: { tts: { provider: 'sovits-sentence', fallback: 'cloud', cloud: { baseUrl: '' } } } })
  let cloudCalls = 0
  const provider = createTtsProviderFromConfig({
    sovits: {
      url: 'http://sovits.local/tts',
      queue: createTtsQueue(),
      ref: REF,
      voice: {},
      fetch: async () => httpResponse(makeWav({ frames: 1200 })),
    },
    cloud: {
      fetch: async () => {
        cloudCalls += 1
        throw new Error('懒构造的 fallback 不该被创建/请求')
      },
    },
  })
  assert.equal(provider.id, 'fallback') // 包装层照旧
  const chunks = await collect(provider.stream('你好'))
  assert.equal(chunks.length, 1)
  assert.deepEqual([...chunks[0].pcm.slice(0, 1)], [0])
  assert.equal(cloudCalls, 0) // 主成功：云端连 fetch 都没碰过
})

test('createTtsProviderFromConfig：primary 失败才构建 fallback，配置错误按 fallback 失败聚合', async () => {
  writeConfig({ esp32: { tts: { provider: 'sovits-sentence', fallback: 'cloud', cloud: { baseUrl: '' } } } })
  const provider = createTtsProviderFromConfig({
    sovits: {
      url: 'http://sovits.local/tts',
      queue: createTtsQueue(),
      ref: REF,
      voice: {},
      fetch: async () => httpResponse('primary down', { status: 500, contentType: 'text/plain' }),
    },
    cloud: { baseUrl: '' }, // fallback 的配置错误，只在真正回退时暴露
  })
  assert.equal(provider.id, 'fallback')

  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.message, /primary:.*HTTP 500/)
    assert.match(e.message, /fallback:.*baseUrl/)
    assert.match(e.fallbackError.message, /baseUrl/)
    return true
  })
})

test('createTtsProviderFromConfig：懒 fallback 的 id 仍为配置的真实 id', async () => {
  writeConfig({ esp32: { tts: { provider: 'cloud', fallback: 'sovits-sentence' } } })
  const notices = []
  const provider = createTtsProviderFromConfig({
    provider: 'cloud',
    fallback: 'sovits-sentence',
    cloud: {
      baseUrl: 'http://tts.local',
      fetch: async () => httpResponse('primary down', { status: 500, contentType: 'text/plain' }),
    },
    sovits: {
      url: 'http://sovits.local/tts',
      queue: createTtsQueue(),
      ref: REF,
      voice: {},
      fetch: async () => httpResponse(makeWav({ frames: 1200 })),
    },
    onFallback: (info) => notices.push(info),
  })

  const chunks = await collect(provider.stream('你好'))
  assert.equal(chunks.length, 1)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].from, 'cloud')
  assert.equal(notices[0].to, 'sovits-sentence') // 懒包装 id 没被写成 'fallback'
})

test('createTtsProviderFromConfig：options 覆盖配置文件里的 provider', () => {
  writeConfig({ esp32: { tts: { provider: 'cloud', fallback: '' } } })
  const provider = createTtsProviderFromConfig({ provider: 'sovits-sentence', fallback: '' })
  assert.equal(provider.id, 'sovits-sentence')
})
