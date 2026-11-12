// ESP32 · 火山 TTS 流式 provider 测试（fake fetch + 手造 ReadableStream，不连网）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-tts-volc-'))
process.env.FEIYU_DATA_DIR = path.join(TMP, 'data')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const { createVolcengineTts } = await import('../lib/esp32/tts/volcengine.js')
const { createFallbackProvider } = await import('../lib/esp32/tts/fallback.js')

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

const KEY = 'test-key-SECRET123'
const enc = new TextEncoder()

const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const audioObj = (bytes) => JSON.stringify({ code: 0, message: '', data: b64(bytes) })
const endObj = JSON.stringify({ code: 20000000, message: 'ok', usage: { text_words: 3 } })

/** 手造流：chunks 为 Uint8Array 列表；最后可挂起(hang)；暴露 cancelled 计数。 */
function makeStream(chunks, { hang = false, delayFirstMs = 0 } = {}) {
  const state = { cancelled: 0 }
  let i = 0
  let release
  const body = new ReadableStream({
    async pull(ctl) {
      if (i === 0 && delayFirstMs) await new Promise((r) => setTimeout(r, delayFirstMs))
      if (i < chunks.length) { ctl.enqueue(chunks[i++]); return }
      if (hang) await new Promise((r) => { release = r })
      else ctl.close()
    },
    cancel() { state.cancelled += 1; release?.() },
  })
  return { body, state }
}

function makeFetch(build) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return build(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const okRes = (body) => ({ ok: true, status: 200, body, text: async () => '' })
const mk = (fetchImpl, extra = {}) =>
  createVolcengineTts({ apiKey: KEY, resourceId: 'seed-tts-2.0', speaker: 'spk', fetchImpl, ...extra })

async function collect(provider, text = '你好', opts = {}) {
  const out = []
  for await (const c of provider.stream(text, opts)) out.push(c)
  return out
}
const flat = (chunks) => chunks.flatMap((c) => Array.from(c.pcm))

const PCM_A = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])

test('请求形状：url / headers / body', async () => {
  const { body } = makeStream([enc.encode(audioObj(PCM_A) + endObj)])
  const f = makeFetch(() => okRes(body))
  const chunks = await collect(mk(f, { speechRate: 5, loudnessRate: -3 }))
  assert.deepEqual(flat(chunks), [1, 2, 3, 4])
  assert.equal(chunks[0].sampleRate, 24000)
  const { url, init } = f.calls[0]
  assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['X-Api-Key'], KEY)
  assert.equal(init.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
  assert.match(init.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/)
  const b = JSON.parse(init.body)
  assert.equal(b.user.uid, 'feiyu')
  assert.equal(b.req_params.text, '你好')
  assert.equal(b.req_params.speaker, 'spk')
  assert.deepEqual(b.req_params.audio_params, { format: 'pcm', sample_rate: 24000, speech_rate: 5, loudness_rate: -3 })
  assert.equal(typeof b.req_params.additions, 'string')
  assert.equal(JSON.parse(b.req_params.additions).disable_markdown_filter, true)
})

test('JSON 逐字节喂入（含多字节字符、字符串内括号与引号转义）', async () => {
  const sentence = JSON.stringify({ code: 0, sentence: { text: '含}花括号{和"引号"\\的句子：你好' } })
  const all = enc.encode(sentence + '\n' + audioObj(PCM_A) + audioObj(Buffer.from([9, 0])) + endObj)
  const chunks = Array.from(all, (b) => new Uint8Array([b]))
  const { body } = makeStream(chunks)
  const out = await collect(mk(makeFetch(() => okRes(body))))
  assert.deepEqual(flat(out), [1, 2, 3, 4, 9])
})

test('任意边界切块结果一致', async () => {
  const all = enc.encode(audioObj(PCM_A) + audioObj(Buffer.from([7, 0, 8, 0])) + endObj)
  for (const size of [1, 2, 3, 5, 7, 13, 40]) {
    const chunks = []
    for (let i = 0; i < all.length; i += size) chunks.push(all.slice(i, i + size))
    const { body } = makeStream(chunks)
    const out = await collect(mk(makeFetch(() => okRes(body))))
    assert.deepEqual(flat(out), [1, 2, 3, 4, 7, 8], `size=${size}`)
  }
})

test('奇数字节 PCM 余量带入下一块（小端对齐）', async () => {
  const bytes = Buffer.from([0x01, 0x00, 0x34, 0x12, 0xff, 0x7f]) // 1, 0x1234, 0x7fff
  const body1 = audioObj(bytes.subarray(0, 3)) // 1, 余 0x34
  const body2 = audioObj(bytes.subarray(3, 6)) // 0x12 接上 → 0x1234；0xff 0x7f
  const { body } = makeStream([enc.encode(body1 + body2 + endObj)])
  const out = await collect(mk(makeFetch(() => okRes(body))))
  assert.deepEqual(flat(out), [1, 0x1234, 0x7fff])
  for (const c of out) assert.ok(c.pcm instanceof Int16Array)
})

test('sentence 包被忽略，不产出音频', async () => {
  const s = JSON.stringify({ code: 0, sentence: { text: 'x' } })
  const { body } = makeStream([enc.encode(s + endObj)])
  assert.deepEqual(await collect(mk(makeFetch(() => okRes(body)))), [])
})

test('错误码映射为中文错误且不含 key', async () => {
  const cases = [
    [45000000, /音色未授权|资源ID/],
    [40402003, /文本超长/],
    [55000000, /服务端错误/],
    [45000292, /并发超限/],
  ]
  for (const [code, re] of cases) {
    const { body } = makeStream([enc.encode(JSON.stringify({ code, message: `bad ${KEY}` }))])
    await assert.rejects(collect(mk(makeFetch(() => okRes(body)))), (e) => {
      assert.match(e.message, re)
      assert.ok(!e.message.includes(KEY))
      return true
    })
  }
})

test('HTTP 错误：脱敏 key', async () => {
  const f = makeFetch(() => ({ ok: false, status: 401, text: async () => `invalid ${KEY}` }))
  await assert.rejects(collect(mk(f)), (e) => {
    assert.match(e.message, /HTTP 401/)
    assert.ok(!e.message.includes(KEY))
    return true
  })
})

test('首包超时：TimeoutError 并释放 reader', async () => {
  const { body, state } = makeStream([], { hang: true })
  const p = mk(makeFetch(() => okRes(body)), { connectTimeoutMs: 40 })
  await assert.rejects(collect(p), (e) => e.name === 'TimeoutError')
  assert.equal(state.cancelled, 1)
})

test('fetch 本身挂起也按首包超时', async () => {
  const f = makeFetch((url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
  await assert.rejects(collect(mk(f, { connectTimeoutMs: 40 })), (e) => e.name === 'TimeoutError')
})

test('块间超时：首块后挂起 → TimeoutError，已出块', async () => {
  const { body, state } = makeStream([enc.encode(audioObj(PCM_A))], { hang: true })
  const p = mk(makeFetch(() => okRes(body)), { connectTimeoutMs: 1000, idleTimeoutMs: 40 })
  const got = []
  await assert.rejects(async () => { for await (const c of p.stream('你好')) got.push(c) }, (e) => e.name === 'TimeoutError')
  assert.equal(got.length, 1)
  assert.equal(state.cancelled, 1)
})

test('外部取消：AbortError、释放 reader、不是 TimeoutError', async () => {
  const { body, state } = makeStream([enc.encode(audioObj(PCM_A))], { hang: true })
  const ctl = new AbortController()
  const p = mk(makeFetch(() => okRes(body)))
  const got = []
  await assert.rejects(async () => {
    for await (const c of p.stream('你好', { signal: ctl.signal })) {
      got.push(c)
      setTimeout(() => ctl.abort(), 10)
    }
  }, (e) => e.name === 'AbortError')
  assert.equal(got.length, 1)
  assert.equal(state.cancelled, 1)
})

test('已取消的 signal 不发请求', async () => {
  const f = makeFetch(() => { throw new Error('不应调用') })
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(collect(mk(f), '你好', { signal: ctl.signal }), (e) => e.name === 'AbortError')
  assert.equal(f.calls.length, 0)
})

test('消费者提前 return 也释放 reader', async () => {
  const { body, state } = makeStream([enc.encode(audioObj(PCM_A) + audioObj(PCM_A))], { hang: true })
  const p = mk(makeFetch(() => okRes(body)))
  for await (const _ of p.stream('你好')) break
  assert.equal(state.cancelled, 1)
})

test('结束码 20000000 后释放 reader', async () => {
  const { body, state } = makeStream([enc.encode(audioObj(PCM_A) + endObj)], { hang: true })
  await collect(mk(makeFetch(() => okRes(body))))
  assert.equal(state.cancelled, 1)
})

test('回退：首块前失败 → 走备选；首块后失败 → 不回退', async () => {
  const fb = { id: 'cloud', calls: 0, async *stream() { this.calls++; yield { pcm: new Int16Array([5]), sampleRate: 24000 } } }

  const errBody = makeStream([enc.encode(JSON.stringify({ code: 45000000, message: 'x' }))]).body
  const early = createFallbackProvider({ primary: mk(makeFetch(() => okRes(errBody))), fallback: fb })
  assert.deepEqual(flat(await collect(early)), [5])
  assert.equal(fb.calls, 1)

  const mid = makeStream([enc.encode(audioObj(PCM_A) + JSON.stringify({ code: 55000000, message: 'x' }))]).body
  const late = createFallbackProvider({ primary: mk(makeFetch(() => okRes(mid))), fallback: fb })
  const got = []
  await assert.rejects(async () => { for await (const c of late.stream('你好')) got.push(c) }, /服务端错误/)
  assert.equal(got.length, 1)
  assert.equal(fb.calls, 1)
})
