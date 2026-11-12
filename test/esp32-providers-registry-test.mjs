import test from 'node:test'
import assert from 'node:assert/strict'
import { ASR_PROVIDER_IDS, TTS_PROVIDER_IDS, mergeEsp32Config } from '../lib/esp32/contracts.js'
import {
  PROVIDERS, providerIds, getProvider, secretPaths, maskEsp32, stripBlankSecrets, nullSecretsToBlank,
} from '../lib/esp32/providers/registry.js'

test('registry ids 与 contracts ids 一致', () => {
  assert.deepEqual([...providerIds('asr')].sort(), [...ASR_PROVIDER_IDS].sort())
  assert.deepEqual([...providerIds('tts')].sort(), [...TTS_PROVIDER_IDS].sort())
})

test('字段 schema 形状合法，云端字段与契约默认值一致', () => {
  const types = ['string', 'number', 'select', 'password']
  const defaults = mergeEsp32Config({})
  for (const p of PROVIDERS) {
    assert.ok(['asr', 'tts'].includes(p.kind))
    assert.equal(p.local, !p.testable)
    for (const f of p.fields) {
      assert.ok(types.includes(f.type), `${p.id}.${f.key}`)
      assert.equal(f.secret, f.type === 'password')
      const section = defaults[p.kind][p.configKey]
      assert.ok(section && f.key in section, `${p.id}.${f.key} 不在契约默认值里`)
      if (!f.secret) assert.deepEqual(f.default, section[f.key])
    }
  }
})

test('预设只含 baseUrl+model', () => {
  for (const p of PROVIDERS) for (const s of p.presets) {
    assert.deepEqual(Object.keys(s.values).sort(), ['baseUrl', 'model'])
  }
  assert.equal(getProvider('asr', 'openai-compatible').presets.length, 4)
  assert.equal(getProvider('tts', 'cloud').presets.length, 2)
})

test('secretPaths 覆盖四个 apiKey', () => {
  const s = secretPaths().map((x) => x.join('.')).sort()
  assert.deepEqual(s, ['asr.openai.apiKey', 'asr.volcengine.apiKey', 'tts.cloud.apiKey', 'tts.volcengine.apiKey'])
})

test('maskEsp32：删密钥置 hasKey，token→tokenSet，不改入参', () => {
  const cfg = mergeEsp32Config({ token: 'tok', asr: { openai: { apiKey: 'test-key' } } })
  const m = maskEsp32(cfg)
  assert.equal(m.asr.openai.hasKey, true)
  assert.equal(m.asr.volcengine.hasKey, false)
  assert.equal(m.tokenSet, true)
  assert.ok(!JSON.stringify(m).includes('test-key'))
  assert.ok(!('token' in m))
  assert.equal(cfg.asr.openai.apiKey, 'test-key')
})

test('stripBlankSecrets：空串保持、null 清除、丢弃 hasKey/token', () => {
  const p = stripBlankSecrets({
    token: 'x', tokenSet: true,
    asr: { openai: { apiKey: '', hasKey: true, model: 'm' }, volcengine: { apiKey: null } },
    tts: { cloud: { apiKey: 'test-key', hasKey: false } },
  })
  assert.ok(!('apiKey' in p.asr.openai))
  assert.ok(!('hasKey' in p.asr.openai))
  assert.equal(p.asr.openai.model, 'm')
  assert.equal(p.asr.volcengine.apiKey, null)
  assert.equal(p.tts.cloud.apiKey, 'test-key')
  assert.ok(!('token' in p) && !('tokenSet' in p))
  nullSecretsToBlank(p)
  assert.equal(p.asr.volcengine.apiKey, '')
})
