// 设置页「大脑（LLM）」卡片契约测试（T24 补充）
//
// settings.html 没有可注入的模块边界，但内联脚本里的 buildLlmPatch() 是纯函数：
// 从 HTML 里抽出函数源码，在 vm 里真实执行它，验证「Key 留空不覆盖」等行为；
// 其余断言只针对页面契约（元素 id、事件绑定、POST 负载形状）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const html = fs.readFileSync(new URL('../lib/settings.html', import.meta.url), 'utf8')
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''

/** 从内联脚本里抽出顶层函数源码（到行首的 `}` 为止）。 */
function extractFn(name) {
  const start = script.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `settings.html 内联脚本里应有 ${name}()`)
  const end = script.indexOf('\n}', start)
  assert.notEqual(end, -1, `${name}() 应正常闭合`)
  return script.slice(start, end + 2)
}

function loadFn(name) {
  const src = extractFn(name)
  return vm.runInNewContext(`${src}; ${name}`)
}

// ── 页面结构 ──────────────────────────────────────────────────────────────

test('设置页有大脑（LLM）卡片：Key 密码框 + base_url + model + 保存按钮', () => {
  assert.match(html, /id="llm_key"[^>]*type="password"|type="password"[^>]*id="llm_key"/,
    'llm_key 必须是 password 输入（别把 Key 明文显示在屏幕上）')
  assert.match(html, /id="llm_base_url"/)
  assert.match(html, /id="llm_model"/)
  assert.match(html, /id="save_llm"/)
  assert.match(html, /id="llm_key_state"/)
})

test('设置页从 GET /config 的 llm 段回显，并用 hasKey 表示 Key 是否已配置', () => {
  assert.match(script, /const l = c\.llm \|\| \{\}/, 'fillForm 应读取 c.llm')
  assert.match(script, /\$\('llm_base_url'\)\.value\s*=/, 'fillForm 应回填 base_url')
  assert.match(script, /\$\('llm_model'\)\.value\s*=/, 'fillForm 应回填 model')
  assert.match(script, /hasKey/, 'Key 状态应来自后端脱敏后的 hasKey')
})

test('保存按钮把 llm 补丁 POST 到 /config，且 Key 输入框保存后清空', () => {
  const handler = script.slice(script.indexOf("$('save_llm').addEventListener"))
  assert.ok(handler, 'save_llm 应绑定 click')
  const body = handler.slice(0, handler.indexOf('\n  });') + 6)
  assert.match(body, /api\('\/config',\s*\{[^}]*method:\s*'POST'/, '应 POST /config')
  assert.match(body, /\{ llm: /, '负载必须是 { llm: ... } 段')
  assert.match(body, /\$\('llm_key'\)\.value = ''/, '保存后应清空 Key 输入框')
})

// ── buildLlmPatch 行为 ────────────────────────────────────────────────────

test('buildLlmPatch：Key 留空时不带 api_key（不覆盖已保存的 Key）', () => {
  const buildLlmPatch = loadFn('buildLlmPatch')
  const patch = buildLlmPatch({ base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: '' })
  assert.deepEqual({ ...patch }, { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
})

test('buildLlmPatch：填了 Key 才带 api_key，且去掉首尾空格', () => {
  const buildLlmPatch = loadFn('buildLlmPatch')
  const patch = buildLlmPatch({ base_url: ' https://x/v1 ', model: ' m ', api_key: ' sk-abc ' })
  assert.deepEqual({ ...patch }, { base_url: 'https://x/v1', model: 'm', api_key: 'sk-abc' })
})

test('buildLlmPatch：base_url / model 留空时不覆盖已有值', () => {
  const buildLlmPatch = loadFn('buildLlmPatch')
  assert.deepEqual({ ...buildLlmPatch({ base_url: '', model: '', api_key: '' }) }, {})
})
