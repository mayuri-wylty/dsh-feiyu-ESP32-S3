import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProvidersView, handleProvidersTest, maskConfigForGet, prepareEsp32Patch, deepMerge, buildPersistPatch,
} from '../lib/esp32/providers/http.js'

const STORED = {
  token: 'secret-token',
  asr: { openai: { apiKey: 'test-key', baseUrl: 'http://x/v1', model: 'm' } },
  tts: { provider: 'sovits-sentence', fallback: '', volcengine: { apiKey: 'test-key', speaker: 'spk' } },
}

test('providers 视图：含 schema、hasKey，无任何密钥明文', () => {
  const v = buildProvidersView({ esp32: STORED, health: { degraded: false } })
  const text = JSON.stringify(v)
  assert.ok(!text.includes('test-key') && !text.includes('secret-token'))
  assert.equal(v.current.asr.values.openai.hasKey, true)
  assert.equal(v.current.asr.values.volcengine.hasKey, false)
  assert.equal(v.current.tts.primary, 'sovits-sentence')
  assert.ok(v.providers.some((p) => p.kind === 'tts' && p.id === 'volcengine'))
  assert.deepEqual(v.pipeline, { degraded: false })
})

test('GET /api/config：esp32.token 与各 apiKey 不泄露，其他段保持', () => {
  const cfg = { llm: { model: 'x' }, esp32: STORED }
  const safe = maskConfigForGet(cfg)
  const text = JSON.stringify(safe)
  assert.ok(!text.includes('test-key') && !text.includes('secret-token'))
  assert.equal(safe.esp32.tokenSet, true)
  assert.equal(safe.llm.model, 'x')
  assert.equal(cfg.esp32.token, 'secret-token', '不改入参')
})

test('POST /api/config：空串保持、null 清除、丢弃 hasKey/token', () => {
  const stored = { asr: { openai: { apiKey: 'test-key', model: 'old' } }, tts: { cloud: { apiKey: 'test-key' }, volcengine: { apiKey: 'test-key' } } }
  const patch = prepareEsp32Patch({
    token: 'evil', tokenSet: true,
    asr: { openai: { apiKey: '', hasKey: true, model: 'new' } },
    tts: { cloud: { apiKey: null }, volcengine: { hasKey: true } },
  })
  const merged = deepMerge(stored, patch)
  assert.equal(merged.asr.openai.apiKey, 'test-key')
  assert.equal(merged.asr.openai.model, 'new')
  assert.equal(merged.tts.cloud.apiKey, '')
  assert.equal(merged.tts.volcengine.apiKey, 'test-key')
  assert.ok(!('hasKey' in merged.asr.openai) && !('hasKey' in merged.tts.volcengine))
  assert.ok(!('token' in merged) && !('tokenSet' in merged))
})

function harness({ stored = STORED, result = { ok: true, ms: 5 }, persistThrows = false } = {}) {
  const calls = { test: [], persist: [] }
  return {
    calls,
    args: {
      getStored: () => stored,
      test: async (a) => { calls.test.push(a); return result },
      persist: async (p) => { calls.persist.push(p); if (persistThrows) throw new Error('disk full') },
    },
  }
}

test('测试：密钥留空用已存值，只接受 registry 字段', async () => {
  const h = harness()
  const r = await handleProvidersTest({ ...h.args, body: { kind: 'asr', id: 'openai-compatible', values: { apiKey: '', model: 'new', evil: 1 } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const v = h.calls.test[0].values
  assert.equal(v.apiKey, 'test-key')
  assert.equal(v.model, 'new')
  assert.ok(!('evil' in v))
  assert.equal(h.calls.persist.length, 0)
  assert.ok(!JSON.stringify(r.body).includes('test-key'))
})

test('persist：ASR 通过 → 云为 primary、sensevoice 为 fallback，一次写入', async () => {
  const h = harness()
  const r = await handleProvidersTest({ ...h.args, body: { kind: 'asr', id: 'openai-compatible', persist: true, values: {} } })
  assert.equal(r.body.persisted, true)
  assert.equal(h.calls.persist.length, 1)
  const e = h.calls.persist[0].esp32
  assert.equal(e.asr.primary, 'openai-compatible')
  assert.equal(e.asr.fallback, 'sensevoice')
  assert.equal(e.asr.openai.apiKey, 'test-key')
})

test('persist：TTS 本地兜底取原本地主；无则 sovits-stream', async () => {
  const h = harness()
  await handleProvidersTest({ ...h.args, body: { kind: 'tts', id: 'volcengine', persist: true, values: { speaker: 'spk' } } })
  assert.equal(h.calls.persist[0].esp32.tts.provider, 'volcengine')
  assert.equal(h.calls.persist[0].esp32.tts.fallback, 'sovits-sentence')
  const stored2 = { tts: { provider: 'cloud', fallback: '' } }
  assert.equal(buildPersistPatch('tts', 'volcengine', {}, { tts: { provider: 'cloud', fallback: '' } }).tts.fallback, 'sovits-stream')
  assert.equal(stored2.tts.provider, 'cloud')
})

test('persist：测试失败不写；写失败报告 persisted=false 且不含密钥', async () => {
  const bad = harness({ result: { ok: false, ms: 1, error: '401' } })
  const r1 = await handleProvidersTest({ ...bad.args, body: { kind: 'asr', id: 'openai-compatible', persist: true } })
  assert.equal(r1.body.ok, false)
  assert.equal(r1.body.persisted, false)
  assert.equal(bad.calls.persist.length, 0)

  const broken = harness({ persistThrows: true })
  const r2 = await handleProvidersTest({ ...broken.args, body: { kind: 'asr', id: 'openai-compatible', persist: true } })
  assert.equal(r2.body.persisted, false)
  assert.match(r2.body.persistError, /disk full/)
})

test('请求校验：非法 kind / id → 400', async () => {
  const h = harness()
  assert.equal((await handleProvidersTest({ ...h.args, body: { kind: 'x', id: 'y' } })).status, 400)
  assert.equal((await handleProvidersTest({ ...h.args, body: { kind: 'asr', id: 'nope' } })).status, 400)
})
