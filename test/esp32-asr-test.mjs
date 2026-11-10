// ESP32 第五通道 · T15「ASR provider 与主备回退」测试
//
// 覆盖：
// 1. sensevoice：ctx.speechToText 包装、resolve/transcribe 调用形状、trim、ms、AbortError 原样；
// 2. openai-compatible：URL、multipart 字段（file/model/language/response_format）、Authorization、
//    30s 超时（可覆盖）、AbortSignal.any、非 2xx 截断与 key 脱敏、JSON 格式校验；
// 3. 主备回退：主失败才回退、空文本不回退、AbortError 不回退、双失败 AggregateError、懒构造；
// 4. createAsrProviderFromConfig：配置读取/options 覆盖/未知 id/主备都空/懒 fallback。
//
// 全部注入 fake ctx.speechToText 与 fake fetch；文件顶部把 globalThis.fetch 换成哨兵，
// 任何“忘记注入”的路径都会立刻失败，保证不访问真实网络。测试里没有真实 API Key。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.mjs 的 paths.mjs 在 import 时解析配置路径，必须先隔离环境再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-asr-'))
process.env.FEIYU_DATA_DIR = path.join(TMP, 'data')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })

const writeConfig = (obj) => fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify(obj))
writeConfig({})

// 真实网络哨兵：未注入 fetch 的代码路径会立即抛错，而不是打到外网
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('测试禁止访问真实网络')
}

const { createSensevoiceProvider, SENSEVOICE_PROVIDER_ID } =
  await import('../lib/esp32/asr/sensevoice.js')
const {
  createOpenAICompatibleProvider, normalizeTranscriptionUrl, OPENAI_COMPATIBLE_PROVIDER_ID,
  DEFAULT_ASR_TIMEOUT_MS,
} = await import('../lib/esp32/asr/openai.js')
const { createFallbackAsrProvider, createAsrProviderFromConfig } =
  await import('../lib/esp32/asr/fallback.js')

test.after(() => {
  globalThis.fetch = realFetch
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 测试工具（全部本地构造，不连网） ────────────────────────────────────────

/** 构造一条合法 16bit 单声道 WAV。默认 16k、16 帧 = 76 字节。 */
function makeWav({ sampleRate = 16000, frames = 16, samples } = {}) {
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

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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

/** 把 FormData 读成普通对象；文件项含 name/type/bytes。 */
async function readForm(form) {
  const out = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value
    else out[key] = { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) }
  }
  return out
}

function fakeSpeechToText({ text = '你好', error = null, result, onTranscribe } = {}) {
  const calls = { resolve: [], transcribe: [] }
  const specs = []
  return {
    calls,
    specs,
    async resolve(args) {
      calls.resolve.push(args)
      const spec = { providerId: 'sensevoice-local', audio: args.audio, language: args.language }
      specs.push(spec)
      return spec
    },
    async transcribe(spec, signal) {
      calls.transcribe.push({ spec, signal })
      onTranscribe?.(spec, signal)
      if (error) throw error
      if (result !== undefined) return result
      return { text, audioSeconds: 1, inferenceSeconds: 0.1 }
    },
  }
}

function fakeAsrProvider(id, { text = 'ok', error = null } = {}) {
  const provider = {
    id,
    calls: 0,
    async transcribe() {
      provider.calls += 1
      if (error) throw error
      return { text }
    },
  }
  return provider
}

function abortError() {
  const e = new Error('请求已取消')
  e.name = 'AbortError'
  return e
}

function timeoutError() {
  const e = new Error('请求超时')
  e.name = 'TimeoutError'
  return e
}

async function waitFor(fn, timeoutMs = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ── 1. sensevoice ──────────────────────────────────────────────────────────

test('sensevoice：resolve/transcribe 调用形状、结果 trim 与 ms', async () => {
  const wav = makeWav()
  const stt = fakeSpeechToText({ text: '  今天天气怎么样？\n' })
  const provider = createSensevoiceProvider({ speechToText: stt })

  assert.equal(provider.id, SENSEVOICE_PROVIDER_ID)
  const r = await provider.transcribe({ wav, sampleRate: 16000 })
  assert.equal(r.text, '今天天气怎么样？')
  assert.equal(typeof r.ms, 'number')
  assert.ok(r.ms >= 0)

  assert.equal(stt.calls.resolve.length, 1)
  assert.equal(stt.calls.resolve[0].audio, wav)
  assert.equal(stt.calls.resolve[0].language, 'zh')
  assert.equal(stt.calls.transcribe.length, 1)
  assert.equal(stt.calls.transcribe[0].spec, stt.specs[0])
  assert.equal(stt.calls.transcribe[0].signal, undefined)
})

test('sensevoice：language 调用参数优先于创建默认值', async () => {
  const stt = fakeSpeechToText()
  const provider = createSensevoiceProvider({ speechToText: stt, language: 'ja' })

  await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(stt.calls.resolve[0].language, 'ja')

  await provider.transcribe({ wav: makeWav(), sampleRate: 16000, language: 'en' })
  assert.equal(stt.calls.resolve[1].language, 'en')
})

test('sensevoice：ctx.speechToText 缺失或形状不对立即报清晰错误（G0）', () => {
  assert.throws(() => createSensevoiceProvider({}), (e) => {
    assert.match(e.message, /speechToText/)
    assert.match(e.message, /voice-input/)
    return true
  })
  assert.throws(() => createSensevoiceProvider({ speechToText: { resolve() {} } }), /speechToText/)
  assert.throws(() => createSensevoiceProvider({ speechToText: null }), /speechToText/)
  assert.throws(() => createSensevoiceProvider({ speechToText: {} }), /speechToText/)
})

test('sensevoice：ctx 抛出的 AbortError 原样保留（同一对象）', async () => {
  const err = abortError()
  const stt = fakeSpeechToText({ error: err })
  const provider = createSensevoiceProvider({ speechToText: stt })
  await assert.rejects(
    provider.transcribe({ wav: makeWav(), sampleRate: 16000 }),
    (e) => e === err,
  )
})

test('sensevoice：signal 已中止时不调用 ctx，抛 AbortError', async () => {
  const stt = fakeSpeechToText()
  const provider = createSensevoiceProvider({ speechToText: stt })
  const ctrl = new AbortController()
  ctrl.abort()

  await assert.rejects(
    provider.transcribe({ wav: makeWav(), sampleRate: 16000, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  )
  assert.equal(stt.calls.resolve.length, 0)
  assert.equal(stt.calls.transcribe.length, 0)
})

test('sensevoice：用户 signal 透传给 ctx.transcribe', async () => {
  let seen = null
  const stt = fakeSpeechToText({ onTranscribe: (spec, signal) => { seen = signal } })
  const provider = createSensevoiceProvider({ speechToText: stt })
  const ctrl = new AbortController()

  await provider.transcribe({ wav: makeWav(), sampleRate: 16000, signal: ctrl.signal })
  assert.equal(seen, ctrl.signal)
})

test('sensevoice：ctx 返回缺 text 时清晰报错', async () => {
  for (const result of [{}, { text: 42 }, null]) {
    const stt = fakeSpeechToText({ result })
    const provider = createSensevoiceProvider({ speechToText: stt })
    await assert.rejects(
      provider.transcribe({ wav: makeWav(), sampleRate: 16000 }),
      /text/,
      `result=${JSON.stringify(result)} 应报 text 错误`,
    )
  }
})

test('sensevoice：空白识别结果是合法结果（空字符串，不报错）', async () => {
  const stt = fakeSpeechToText({ text: '   \n\t' })
  const provider = createSensevoiceProvider({ speechToText: stt })
  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '')
})

test('sensevoice：wav 缺失/为空时清晰报错', async () => {
  const provider = createSensevoiceProvider({ speechToText: fakeSpeechToText() })
  await assert.rejects(provider.transcribe({}), /wav/i)
  await assert.rejects(provider.transcribe({ wav: new Uint8Array() }), /wav/i)
})

// ── 2. openai-compatible ───────────────────────────────────────────────────

test('openai：baseUrl 拼接 /audio/transcriptions（尾斜杠/完整端点）', () => {
  assert.equal(
    normalizeTranscriptionUrl('http://asr.local/v1'),
    'http://asr.local/v1/audio/transcriptions',
  )
  assert.equal(
    normalizeTranscriptionUrl('http://asr.local/v1/'),
    'http://asr.local/v1/audio/transcriptions',
  )
  assert.equal(
    normalizeTranscriptionUrl('http://asr.local/v1/audio/transcriptions'),
    'http://asr.local/v1/audio/transcriptions',
  )
  assert.equal(
    normalizeTranscriptionUrl('http://asr.local'),
    'http://asr.local/audio/transcriptions',
  )
  assert.throws(() => normalizeTranscriptionUrl(''), /baseUrl/)
  assert.throws(() => normalizeTranscriptionUrl('not a url'), /baseUrl|URL/)
  assert.throws(() => createOpenAICompatibleProvider({ baseUrl: '  ' }), /baseUrl/)
})

test('openai：multipart 字段/URL/Authorization 正确，结果 trim', async () => {
  const wav = makeWav({ frames: 23 })
  const { calls, fetch } = captureFetch(() => jsonResponse({ text: '  你好  ' }))
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local/v1/',
    apiKey: 'sk-test-only',
    model: 'whisper-1',
    fetch,
  })

  assert.equal(provider.id, OPENAI_COMPATIBLE_PROVIDER_ID)
  const r = await provider.transcribe({ wav, sampleRate: 16000 })
  assert.equal(r.text, '你好')
  assert.equal(typeof r.ms, 'number')
  assert.ok(r.ms >= 0)

  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'http://asr.local/v1/audio/transcriptions')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer sk-test-only')
  // FormData 由 fetch 自动补 multipart/form-data; boundary=...，不能手动写死
  assert.equal(
    Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type'),
    false,
    'Content-Type 应由 fetch 根据 FormData 自动生成（含 boundary）',
  )
  assert.ok(init.body instanceof FormData)
  assert.ok(init.signal instanceof AbortSignal)

  const form = await readForm(init.body)
  assert.ok(form.file.name.endsWith('.wav'), `filename 应以 .wav 结尾：${form.file.name}`)
  assert.equal(form.file.type, 'audio/wav')
  assert.deepEqual(form.file.bytes, Buffer.from(wav))
  assert.equal(form.model, 'whisper-1')
  assert.equal(form.language, 'zh')
  assert.equal(form.response_format, 'json')
})

test('openai：apiKey 为空不带 Authorization；language 可覆盖、空串不发送', async () => {
  const { calls, fetch } = captureFetch(() => jsonResponse({ text: 'x' }))
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local',
    apiKey: '',
    model: 'm',
    fetch,
  })

  await provider.transcribe({ wav: makeWav(), sampleRate: 16000, language: 'en' })
  assert.equal('Authorization' in calls[0].init.headers, false)
  assert.equal((await readForm(calls[0].init.body)).language, 'en')

  await provider.transcribe({ wav: makeWav(), sampleRate: 16000, language: '' })
  assert.equal((await readForm(calls[1].init.body)).language, undefined)
})

test('openai：空文本是合法结果', async () => {
  const { fetch } = captureFetch(() => jsonResponse({ text: '   ' }))
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local', model: 'm', fetch,
  })
  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '')
})

test('openai：非 2xx 带状态与前 300 字符，且脱敏 API Key、不重试', async () => {
  const detail = `bad key sk-live-secret ${'x'.repeat(1000)}`
  const { calls, fetch } = captureFetch(() =>
    new Response(detail, { status: 401, headers: { 'content-type': 'text/plain' } }))
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local',
    apiKey: 'sk-live-secret',
    model: 'm',
    fetch,
  })

  await assert.rejects(provider.transcribe({ wav: makeWav(), sampleRate: 16000 }), (e) => {
    assert.match(e.message, /HTTP 401/)
    assert.match(e.message, /bad key/)
    assert.ok(!e.message.includes('sk-live-secret'), '错误信息不得泄露 API Key')
    assert.ok(e.message.length < 450, `错误信息应截断到 300 字符左右，实际 ${e.message.length}`)
    return true
  })
  assert.equal(calls.length, 1)
})

test('openai：响应不是 JSON / 缺 text 时清晰报错', async () => {
  const cases = [
    ['not json', /JSON/],
    [JSON.stringify({ result: 'x' }), /text/],
    [JSON.stringify({ text: 42 }), /text/],
  ]
  for (const [body, re] of cases) {
    const { fetch } = captureFetch(() => new Response(body, { status: 200 }))
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://asr.local', model: 'm', fetch })
    await assert.rejects(
      provider.transcribe({ wav: makeWav(), sampleRate: 16000 }),
      re,
      `body=${body} 应按 ${re} 报错`,
    )
  }
})

test('openai：默认 30s 超时，可覆盖；超时抛 TimeoutError 且只请求一次', async () => {
  assert.equal(DEFAULT_ASR_TIMEOUT_MS, 30_000)

  let calls = 0
  const fetch = (url, init) => new Promise((resolve, reject) => {
    calls += 1
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local',
    model: 'm',
    fetch,
    timeoutMs: 50,
  })

  const t0 = Date.now()
  await assert.rejects(provider.transcribe({ wav: makeWav(), sampleRate: 16000 }), (e) => {
    assert.equal(e.name, 'TimeoutError')
    assert.match(e.message, /超时/)
    return true
  })
  assert.ok(Date.now() - t0 < 2000, '超时应远小于测试等待上限')
  assert.equal(calls, 1)
})

test('openai：用户 AbortSignal 中止在途请求（AbortSignal.any 合并超时）', async () => {
  let signalSeen = null
  const fetch = (url, init) => new Promise((resolve, reject) => {
    signalSeen = init.signal
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local',
    model: 'm',
    fetch,
    timeoutMs: 5000,
  })

  const ctrl = new AbortController()
  const pending = provider.transcribe({
    wav: makeWav(),
    sampleRate: 16000,
    signal: ctrl.signal,
  })
  await waitFor(() => signalSeen)
  ctrl.abort()
  await assert.rejects(pending, (e) => e.name === 'AbortError')
})

test('openai：signal 已中止时不发请求', async () => {
  let calls = 0
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local',
    model: 'm',
    fetch: async () => { calls += 1; return jsonResponse({ text: 'x' }) },
  })
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(
    provider.transcribe({ wav: makeWav(), sampleRate: 16000, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  )
  assert.equal(calls, 0)
})

test('openai：wav 缺失/为空时清晰报错', async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://asr.local',
    model: 'm',
    fetch: async () => jsonResponse({ text: 'x' }),
  })
  await assert.rejects(provider.transcribe({}), /wav/i)
  await assert.rejects(provider.transcribe({ wav: new Uint8Array() }), /wav/i)
})

test('openai：失败路径不向 console 输出 API Key', async () => {
  const outputs = []
  const orig = { log: console.log, error: console.error, warn: console.warn }
  console.log = console.error = console.warn = (...args) => outputs.push(args.map(String).join(' '))
  try {
    const { fetch } = captureFetch(() => new Response('nope', { status: 500 }))
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'http://asr.local',
      apiKey: 'sk-console-secret',
      model: 'm',
      fetch,
    })
    await assert.rejects(provider.transcribe({ wav: makeWav(), sampleRate: 16000 }))
  } finally {
    console.log = orig.log
    console.error = orig.error
    console.warn = orig.warn
  }
  assert.ok(
    outputs.every((line) => !line.includes('sk-console-secret')),
    `console 输出泄露了 API Key：${outputs.join('\n')}`,
  )
})

// ── 3. 主备回退 ────────────────────────────────────────────────────────────

test('fallback：主失败 → 备成功并通知；wrapper id 沿用主 provider id', async () => {
  const primary = fakeAsrProvider('sensevoice', { error: new Error('primary boom') })
  const fallback = fakeAsrProvider('openai-compatible', { text: '备选你好' })
  const notices = []
  const provider = createFallbackAsrProvider({
    primary,
    fallback,
    onFallback: (info) => notices.push(info),
  })

  assert.equal(provider.id, 'sensevoice')
  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '备选你好')
  assert.equal(primary.calls, 1)
  assert.equal(fallback.calls, 1)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].from, 'sensevoice')
  assert.equal(notices[0].to, 'openai-compatible')
  assert.match(notices[0].error.message, /primary boom/)
})

test('fallback：空文本是合法结果（静音/无语音）→ 不回退', async () => {
  const primary = fakeAsrProvider('sensevoice', { text: '' })
  const fallback = fakeAsrProvider('openai-compatible', { text: '不该出现' })
  const notices = []
  const provider = createFallbackAsrProvider({
    primary,
    fallback,
    onFallback: (info) => notices.push(info),
  })

  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '')
  assert.equal(fallback.calls, 0)
  assert.equal(notices.length, 0)
})

test('fallback：超时（TimeoutError）视为主失败 → 回退', async () => {
  const primary = fakeAsrProvider('openai-compatible', { error: timeoutError() })
  const fallback = fakeAsrProvider('sensevoice', { text: '本地结果' })
  const provider = createFallbackAsrProvider({ primary, fallback })

  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '本地结果')
  assert.equal(fallback.calls, 1)
})

test('fallback：AbortError 绝不回退，原样抛出', async () => {
  const err = abortError()
  const primary = fakeAsrProvider('sensevoice', { error: err })
  const fallback = fakeAsrProvider('openai-compatible', { text: '不该出现' })
  const provider = createFallbackAsrProvider({ primary, fallback })

  await assert.rejects(
    provider.transcribe({ wav: makeWav(), sampleRate: 16000 }),
    (e) => e === err,
  )
  assert.equal(fallback.calls, 0)
})

test('fallback：用户 signal 已中止且主抛普通错误 → 不回退，抛 AbortError', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const primary = fakeAsrProvider('sensevoice', { error: new Error('network died') })
  const fallback = fakeAsrProvider('openai-compatible', { text: '不该出现' })
  const provider = createFallbackAsrProvider({ primary, fallback })

  await assert.rejects(
    provider.transcribe({ wav: makeWav(), sampleRate: 16000, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  )
  assert.equal(fallback.calls, 0)
})

test('fallback：主备都失败 → AggregateError 含 primary:/fallback: 与两条错误', async () => {
  const primaryErr = new Error('primary boom')
  const fallbackErr = new Error('fallback boom')
  const provider = createFallbackAsrProvider({
    primary: fakeAsrProvider('sensevoice', { error: primaryErr }),
    fallback: fakeAsrProvider('openai-compatible', { error: fallbackErr }),
  })

  await assert.rejects(provider.transcribe({ wav: makeWav(), sampleRate: 16000 }), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.message, /primary:.*primary boom/s)
    assert.match(e.message, /fallback:.*fallback boom/s)
    assert.equal(e.primaryError, primaryErr)
    assert.equal(e.fallbackError, fallbackErr)
    assert.deepEqual(e.errors, [primaryErr, fallbackErr])
    return true
  })
})

test('fallback：备选在回退中抛 AbortError → 不聚合，原样抛 AbortError', async () => {
  const err = abortError()
  const provider = createFallbackAsrProvider({
    primary: fakeAsrProvider('sensevoice', { error: new Error('p down') }),
    fallback: fakeAsrProvider('openai-compatible', { error: err }),
  })
  await assert.rejects(
    provider.transcribe({ wav: makeWav(), sampleRate: 16000 }),
    (e) => e === err,
  )
})

test('fallback：onFallback 回调抛错不影响已成功的回退结果', async () => {
  const provider = createFallbackAsrProvider({
    primary: fakeAsrProvider('sensevoice', { error: new Error('p down') }),
    fallback: fakeAsrProvider('openai-compatible', { text: 'ok' }),
    onFallback: () => { throw new Error('log boom') },
  })
  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, 'ok')
})

test('fallback：仅备选 → 直接使用备选；两个都没有 → TypeError', async () => {
  const fallback = fakeAsrProvider('openai-compatible', { text: 'ok' })
  const provider = createFallbackAsrProvider({ fallback })
  assert.equal(provider.id, 'openai-compatible')
  assert.equal((await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })).text, 'ok')
  assert.throws(() => createFallbackAsrProvider({}), TypeError)
})

// ── 4. createAsrProviderFromConfig ─────────────────────────────────────────

test('config：默认 sensevoice（配置 primary）+ 注入 speechToText', async () => {
  writeConfig({})
  const stt = fakeSpeechToText({ text: '配置默认' })
  const provider = createAsrProviderFromConfig({ speechToText: stt })

  assert.equal(provider.id, 'sensevoice')
  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '配置默认')
  assert.equal(stt.calls.resolve.length, 1)
})

test('config：读取配置文件 openai 参数；options.primary 覆盖配置', async () => {
  writeConfig({
    esp32: {
      asr: {
        primary: 'openai-compatible',
        fallback: '',
        openai: { baseUrl: 'http://cfg.local/v1', apiKey: 'cfg-key', model: 'cfg-model' },
      },
    },
  })
  const { calls, fetch } = captureFetch(() => jsonResponse({ text: 'cfg' }))
  const fromCfg = createAsrProviderFromConfig({ fetch })
  assert.equal(fromCfg.id, 'openai-compatible')

  const r = await fromCfg.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, 'cfg')
  assert.equal(calls[0].url, 'http://cfg.local/v1/audio/transcriptions')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cfg-key')
  assert.equal((await readForm(calls[0].init.body)).model, 'cfg-model')

  const overridden = createAsrProviderFromConfig({
    primary: 'sensevoice',
    speechToText: fakeSpeechToText({ text: 'sv' }),
    fetch,
  })
  assert.equal(overridden.id, 'sensevoice')
  assert.equal(
    (await overridden.transcribe({ wav: makeWav(), sampleRate: 16000 })).text,
    'sv',
  )
})

test('config：options.openai 逐字段覆盖配置', async () => {
  writeConfig({
    esp32: {
      asr: {
        primary: 'openai-compatible',
        openai: { baseUrl: 'http://cfg.local', apiKey: 'cfg-key', model: 'cfg-model' },
      },
    },
  })
  const { calls, fetch } = captureFetch(() => jsonResponse({ text: 'x' }))
  const provider = createAsrProviderFromConfig({
    fetch,
    openai: { baseUrl: 'http://override.local/v1', apiKey: '', model: 'ov-model' },
  })
  await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })

  assert.equal(calls[0].url, 'http://override.local/v1/audio/transcriptions')
  assert.equal('Authorization' in calls[0].init.headers, false)
  assert.equal((await readForm(calls[0].init.body)).model, 'ov-model')
})

test('config：未知 provider id 立即报错（主/备都一样）', () => {
  writeConfig({ esp32: { asr: { primary: 'no-such-asr', fallback: '' } } })
  assert.throws(() => createAsrProviderFromConfig(), /未知的 ASR provider/)

  writeConfig({ esp32: { asr: { primary: 'sensevoice', fallback: 'also-unknown' } } })
  assert.throws(
    () => createAsrProviderFromConfig({ speechToText: fakeSpeechToText() }),
    /未知的 ASR provider/,
  )
})

test('config：fallback 为空或与 primary 相同 → 直接返回 primary', () => {
  writeConfig({ esp32: { asr: { primary: 'sensevoice', fallback: 'sensevoice' } } })
  const provider = createAsrProviderFromConfig({ speechToText: fakeSpeechToText() })
  assert.equal(provider.id, 'sensevoice')
})

test('config：primary 为空时 fallback 充当主 provider；都为空则清晰报错', () => {
  writeConfig({ esp32: { asr: { primary: '', fallback: 'sensevoice' } } })
  const provider = createAsrProviderFromConfig({ speechToText: fakeSpeechToText() })
  assert.equal(provider.id, 'sensevoice')

  writeConfig({ esp32: { asr: { primary: '', fallback: '' } } })
  assert.throws(() => createAsrProviderFromConfig(), /未配置 ASR provider/)
})

test('config：fallback 懒构造——主成功不构建错误配置的 fallback', async () => {
  writeConfig({
    esp32: {
      asr: {
        primary: 'sensevoice',
        fallback: 'openai-compatible',
        openai: { baseUrl: '', model: 'm' }, // fallback 配置错误，但只要不回退就不该暴露
      },
    },
  })
  const provider = createAsrProviderFromConfig({
    speechToText: fakeSpeechToText({ text: '主成功' }),
  })
  assert.equal(provider.id, 'sensevoice')

  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '主成功')
})

test('config：主失败才构建 fallback，构建错误按 fallback 失败聚合', async () => {
  writeConfig({
    esp32: {
      asr: {
        primary: 'sensevoice',
        fallback: 'openai-compatible',
        openai: { baseUrl: '', model: 'm' },
      },
    },
  })
  const provider = createAsrProviderFromConfig({
    speechToText: fakeSpeechToText({ error: new Error('stt boom') }),
  })

  await assert.rejects(provider.transcribe({ wav: makeWav(), sampleRate: 16000 }), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.message, /primary:.*stt boom/s)
    assert.match(e.message, /fallback:.*baseUrl/s)
    assert.match(e.fallbackError.message, /baseUrl/)
    return true
  })
})

test('config：主失败 → fallback 真实链路成功，onFallback 带真实 id', async () => {
  writeConfig({
    esp32: {
      asr: {
        primary: 'sensevoice',
        fallback: 'openai-compatible',
        openai: { baseUrl: 'http://asr.local/v1', model: 'whisper-1' },
      },
    },
  })
  const { calls, fetch } = captureFetch(() => jsonResponse({ text: '云端结果' }))
  const notices = []
  const provider = createAsrProviderFromConfig({
    speechToText: fakeSpeechToText({ error: new Error('sensevoice down') }),
    fetch,
    onFallback: (info) => notices.push(info),
  })

  const r = await provider.transcribe({ wav: makeWav(), sampleRate: 16000 })
  assert.equal(r.text, '云端结果')
  assert.equal(calls.length, 1)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].from, 'sensevoice')
  assert.equal(notices[0].to, 'openai-compatible')
})

test('config：sensevoice 作为 fallback 且 ctx 缺失 → 按 fallback 失败聚合，不拖垮主', async () => {
  writeConfig({
    esp32: {
      asr: {
        primary: 'openai-compatible',
        fallback: 'sensevoice',
        openai: { baseUrl: 'http://asr.local', model: 'm' },
      },
    },
  })
  const { fetch } = captureFetch(() =>
    new Response('primary down', { status: 500, headers: { 'content-type': 'text/plain' } }))
  const provider = createAsrProviderFromConfig({ fetch }) // 故意不注入 speechToText

  await assert.rejects(provider.transcribe({ wav: makeWav(), sampleRate: 16000 }), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.message, /primary:.*HTTP 500/s)
    assert.match(e.message, /fallback:.*speechToText/s)
    assert.match(e.fallbackError.message, /voice-input/)
    return true
  })
})
