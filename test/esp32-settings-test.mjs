// 设置页 / DSH 面板「ESP32 云端 ASR/TTS」配置块契约测试（T8/T9）
//
// client.js 没有可注入的模块边界（settings.html 已废弃），但其中的纯函数
// （buildProviderTestBody / provInitForm / describeTestResult / describePipeline）可抽出来在 vm 里真跑；
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function extract(src, name, indent) {
  const start = src.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `应有 ${name}()`)
  const close = src.indexOf(`\n${indent}}`, start)
  assert.notEqual(close, -1, `${name}() 应正常闭合`)
  return src.slice(start, close + 2 + indent.length)
}

const NAMES = ['provInitForm', 'buildProviderTestBody', 'describeTestResult', 'describePipeline']
function load(src, indent) {
  const code = NAMES.map((n) => extract(src, n, indent)).join('\n')
  return vm.runInNewContext(`${code}; ({ ${NAMES.join(', ')} })`)
}

const impls = {
  'client.js': load(clientSrc, '\t\t'),
}

const META = {
  id: 'volcengine',
  fields: [
    { key: 'apiKey', type: 'password', secret: true },
    { key: 'resourceId', type: 'string', default: 'seed-tts-2.0' },
    { key: 'speaker', type: 'string' },
    { key: 'speechRate', type: 'number', default: 0 },
  ],
}

for (const [where, fns] of Object.entries(impls)) {
  test(`[${where}] 密钥字段初始为空，非密字段取已存值，其次默认值`, () => {
    const form = fns.provInitForm(META, { apiKey: 'must-not-appear', speaker: 'zh_f', hasKey: true })
    assert.equal(form.apiKey, '')
    assert.equal(form.speaker, 'zh_f')
    assert.equal(form.resourceId, 'seed-tts-2.0')
    assert.equal(form.speechRate, '0')
  })

  test(`[${where}] 测试 body：留空字段不带（密钥留空=保持不变），number 转数字，空白裁剪`, () => {
    const body = fns.buildProviderTestBody('tts', META, { apiKey: '', resourceId: ' seed-tts-1.0 ', speaker: '', speechRate: '10' }, true)
    assert.deepEqual(JSON.parse(JSON.stringify(body)), {
      kind: 'tts', id: 'volcengine', values: { resourceId: 'seed-tts-1.0', speechRate: 10 }, persist: true,
    })
    const withKey = fns.buildProviderTestBody('tts', META, { apiKey: 'test-key' }, false)
    assert.equal(withKey.values.apiKey, 'test-key')
    assert.equal(withKey.persist, false)
  })

  test(`[${where}] 测试结果文案：成功含延迟/首包/主备，失败含错误`, () => {
    assert.match(fns.describeTestResult({ ok: true, ms: 321, ttsFirstMs: 180, persisted: true, primary: 'volcengine', fallback: 'sovits-stream' }),
      /321ms.*首包 180ms.*已启用为主.*volcengine.*sovits-stream/)
    assert.match(fns.describeTestResult({ ok: true, ms: 50 }), /^连接成功 · 50ms$/)
    assert.match(fns.describeTestResult({ ok: false, error: '鉴权失败' }), /测试失败：鉴权失败/)
    assert.match(fns.describeTestResult(null), /测试失败/)
  })

  test(`[${where}] 管线状态：展示实际生效 provider 与降级原因`, () => {
    assert.deepEqual({ ...fns.describePipeline(null) }, { text: '—', warn: '' })
    const d = fns.describePipeline({
      asr: { primary: 'openai-compatible', fallback: 'sensevoice', ready: false, error: 'x' },
      tts: { primary: 'volcengine', fallback: 'sovits-stream', ready: true },
      degraded: true, reason: 'ASR 云端不可用',
    })
    assert.match(d.text, /ASR openai-compatible（兜底 sensevoice） ✗/)
    assert.match(d.text, /TTS volcengine（兜底 sovits-stream）/)
    assert.equal(d.warn, '已降级：ASR 云端不可用')
    assert.equal(fns.describePipeline({ asr: { primary: 'a', ready: true }, degraded: false }).warn, '')
  })
}

// ── 页面契约 ──────────────────────────────────────────────────────────────
test('client.js：Esp32Providers 挂进 ESP32 卡片', () => {
  assert.match(clientSrc, /h\(Esp32Providers,/)
  assert.match(clientSrc, /apiRetry\("\/esp32\/providers"\)/)
  assert.match(clientSrc, /api\("\/esp32\/providers\/test",\s*\{\s*method:\s*"POST"/)
  assert.match(clientSrc, /已保存，留空保持不变/)
  assert.match(clientSrc, /auto: true/, '自动启用默认开')
})

test('不回显密钥：密钥输入初始值恒为空串', () => {
  assert.match(clientSrc, /if \(f\.secret\) \{ out\[f\.key\] = ""; continue; \}/)
})
