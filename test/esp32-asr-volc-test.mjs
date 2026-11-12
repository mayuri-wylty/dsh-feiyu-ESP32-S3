// 火山 ASR provider 测试：全部注入 fake fetch，不访问真实网络；key 用假值 test-key。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-asr-volc-'))
process.env.FEIYU_DATA_DIR = path.join(TMP, 'data')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
const writeConfig = (obj) => fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify(obj))
writeConfig({})

globalThis.fetch = async () => {
  throw new Error('测试禁止访问真实网络')
}

const { createVolcengineAsr, VOLCENGINE_ASR_PROVIDER_ID } = await import('../lib/esp32/asr/volcengine.js')
const { createAsrProviderFromConfig } = await import('../lib/esp32/asr/fallback.js')

const KEY = 'test-key'
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])

function reply(code, body = {}, { message, status = 200 } = {}) {
  const headers = new Headers({ 'X-Api-Status-Code': String(code) })
  if (message) headers.set('X-Api-Message', message)
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

function makeFetch(handler) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  fn.calls = calls
  return fn
}

const make = (fetchImpl, extra = {}) => createVolcengineAsr({ apiKey: KEY, fetchImpl, ...extra })

test('成功：返回 trim 后的 result.text 与 ms，id 为 volcengine', async () => {
  const f = makeFetch(() => reply('20000000', { result: { text: ' 你好 ' } }))
  const p = make(f)
  assert.equal(p.id, VOLCENGINE_ASR_PROVIDER_ID)
  const r = await p.transcribe({ wav: WAV, sampleRate: 16000 })
  assert.equal(r.text, '你好')
  assert.equal(typeof r.ms, 'number')
})

test('请求形状：URL、headers、body', async () => {
  const f = makeFetch(() => reply('20000000', { result: { text: 'x' } }))
  await make(f, { endpoint: 'https://example.test/', resourceId: 'rid', modelName: 'm1' }).transcribe({ wav: WAV })
  const { url, init } = f.calls[0]
  assert.equal(url, 'https://example.test/api/v3/auc/bigmodel/recognize/flash')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['X-Api-Key'], KEY)
  assert.equal(init.headers['X-Api-Resource-Id'], 'rid')
  assert.match(init.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/)
  assert.equal(init.headers['X-Api-Sequence'], '-1')
  assert.equal(init.headers['Content-Type'], 'application/json')
  const body = JSON.parse(init.body)
  assert.deepEqual(body.user, { uid: 'feiyu' })
  assert.equal(body.audio.data, Buffer.from(WAV).toString('base64'))
  assert.deepEqual(body.request, { model_name: 'm1' })
})

test('默认值：官方 endpoint 与 resourceId/model', async () => {
  const f = makeFetch(() => reply('20000000', { result: { text: 'x' } }))
  await make(f).transcribe({ wav: WAV })
  assert.match(f.calls[0].url, /^https:\/\/openspeech\.bytedance\.com\/api\/v3\/auc\/bigmodel\/recognize\/flash$/)
  assert.equal(f.calls[0].init.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo')
  assert.equal(JSON.parse(f.calls[0].init.body).request.model_name, 'bigmodel')
})

test('静音码 20000003 与空码 45000002 → 空文本，不抛错', async () => {
  for (const code of ['20000003', '45000002']) {
    const r = await make(makeFetch(() => reply(code, {}))).transcribe({ wav: WAV })
    assert.equal(r.text, '')
  }
})

test('鉴权/忙/未知状态码 → 抛中文错误，且不含 key', async () => {
  for (const [code, msg] of [['45000010', `invalid key ${KEY}`], ['55000031', 'server busy'], ['', '']]) {
    const f = makeFetch(() => reply(code, `body ${KEY}`, { message: msg, status: code ? 200 : 500 }))
    await assert.rejects(make(f).transcribe({ wav: WAV }), (e) => {
      assert.match(e.message, /火山 ASR 识别失败/)
      assert.ok(!e.message.includes(KEY), e.message)
      return true
    })
  }
  const busy = makeFetch(() => reply('55000031', {}, { message: 'busy' }))
  await assert.rejects(make(busy).transcribe({ wav: WAV }), /55000031.*繁忙/)
})

test('错误文本截断到 300 字', async () => {
  const f = makeFetch(() => reply('45000010', 'x'.repeat(2000)))
  await assert.rejects(make(f).transcribe({ wav: WAV }), (e) => e.message.length < 400)
})

test('成功码但格式不合法 → 抛错', async () => {
  await assert.rejects(make(makeFetch(() => reply('20000000', {}))).transcribe({ wav: WAV }), /result\.text/)
  await assert.rejects(make(makeFetch(() => reply('20000000', 'not json'))).transcribe({ wav: WAV }), /合法 JSON/)
})

test('网络错误信息脱敏 key', async () => {
  const f = makeFetch(() => { throw new Error(`connect failed ${KEY}`) })
  await assert.rejects(make(f).transcribe({ wav: WAV }), (e) => !e.message.includes(KEY) && /请求失败/.test(e.message))
})

const hang = () => makeFetch((url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
}))

test('超时 → TimeoutError', async () => {
  await assert.rejects(make(hang(), { timeoutMs: 30 }).transcribe({ wav: WAV }), (e) => e.name === 'TimeoutError')
})

test('外部取消 → AbortError（含已取消的 signal）', async () => {
  const ctl = new AbortController()
  const pr = make(hang(), { timeoutMs: 5000 }).transcribe({ wav: WAV, signal: ctl.signal })
  setTimeout(() => ctl.abort(), 20)
  await assert.rejects(pr, (e) => e.name === 'AbortError')
  const pre = new AbortController()
  pre.abort()
  await assert.rejects(make(hang()).transcribe({ wav: WAV, signal: pre.signal }), (e) => e.name === 'AbortError')
})

test('构造校验：缺 apiKey / 空 wav', async () => {
  assert.throws(() => createVolcengineAsr({ fetchImpl: async () => {} }), /apiKey/)
  await assert.rejects(make(makeFetch(() => reply('20000000'))).transcribe({ wav: new Uint8Array() }), /wav/)
})

test('工厂：volcengine 主 + openai 兜底，主失败回退；静音不回退', async () => {
  writeConfig({ esp32: { asr: { primary: 'volcengine', fallback: 'openai-compatible',
    volcengine: { apiKey: KEY },
    openai: { baseUrl: 'https://oa.test/v1', model: 'whisper' } } } })
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (String(url).includes('openspeech')) return reply('55000031', {}, { message: 'busy' })
    return new Response(JSON.stringify({ text: '备用' }), { status: 200 })
  }
  const p = createAsrProviderFromConfig({ fetch: fetchImpl })
  assert.equal(p.id, 'volcengine')
  const r = await p.transcribe({ wav: WAV, sampleRate: 16000 })
  assert.equal(r.text, '备用')
  assert.equal(urls.length, 2)

  urls.length = 0
  const silent = async (url) => { urls.push(String(url)); return reply('20000003', {}) }
  const r2 = await createAsrProviderFromConfig({ fetch: silent }).transcribe({ wav: WAV })
  assert.equal(r2.text, '')
  assert.equal(urls.length, 1)
})

test('工厂：volcengine 配置透传（resourceId/modelName/endpoint）', async () => {
  writeConfig({ esp32: { asr: { primary: 'volcengine', volcengine: {
    apiKey: KEY, resourceId: 'r2', modelName: 'm2', endpoint: 'https://e.test' } } } })
  const f = makeFetch(() => reply('20000000', { result: { text: 'ok' } }))
  await createAsrProviderFromConfig({ fetch: f }).transcribe({ wav: WAV })
  assert.equal(f.calls[0].url, 'https://e.test/api/v3/auc/bigmodel/recognize/flash')
  assert.equal(f.calls[0].init.headers['X-Api-Resource-Id'], 'r2')
  assert.equal(JSON.parse(f.calls[0].init.body).request.model_name, 'm2')
})
