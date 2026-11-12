/**
 * client.js 渲染测试 —— 用一个极小的 hooks 运行时 + 假 fetch，
 * 把「大肥鱼」设置页真正渲染一遍（含数据回来后的一次重渲染），
 * 目的是在没起 DSH 的情况下抓出 TypeError / 白屏这类问题。
 *
 * 跑法：node test/client-render.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 假数据：和真实 /api/* 返回同形状 ──────────────────────────────────────
const CONFIG = {
  platforms: { bilibili: true, qq: true, wechat: false, douyin: true },
  owner: { qq: '3082864371', name: '友利奈绪', mid: '3493288510228945', wechat: '' },
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 2 }] },
  quota: { shareDaily: 3 },
  douyin: { maxPerRun: 2 },
  qq: { voice_chance: 0.5 },
  voice: { ref_audio_path: 'D:/AI_Code/小智机器人/GPT-SoVITS/models/sunshine_girl/sunshine_girl.wav' },
  // 后端 /config 对 llm 段脱敏：删 api_key，加 hasKey
  llm: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: false },
}
const VOICES = [
  { name: 'sunshine_girl', ref_audio_path: 'D:/AI_Code/小智机器人/GPT-SoVITS/models/sunshine_girl/sunshine_girl.wav', prompt_text: '参考文本', has_prompt: true },
  { name: 'mute', ref_audio_path: 'D:/AI_Code/小智机器人/GPT-SoVITS/models/mute/mute.wav', prompt_text: '', has_prompt: false },
]
const RESPONSES = {
  '/dsh-feiyu/api/config': { ok: true, config: CONFIG, voices: VOICES, configPath: 'C:/Users/x/.dsh/feiyu.config.json' },
  '/dsh-feiyu/api/persona': { ok: true, text: '我是大肥鱼。' },
  '/dsh-feiyu/api/memory': {
    ok: true,
    stats: { episodes: 12, lore: 3, facts: 4 },
    recent: [
      { role: 'user', text: '在吗', chatId: 'qq:3082864371', platform: 'qq' },
      { role: 'assistant', text: '在的，主人。', chatId: 'qq:3082864371', platform: 'qq' },
    ],
  },
  '/dsh-feiyu/api/status': {
    ok: true, today: '2026-10-24', scheduler: { ok: true, reason: '已启动' },
    sharesToday: 1, sharesMax: 3, commentsToday: 4, mood: { value: 62, hunger: 12 },
    dryRun: false, selftestPassed: true, ownerSet: true, configPath: 'C:/Users/x/.dsh/feiyu.config.json',
  },
  '/dsh-feiyu/api/services': { ok: true, services: { qq: { running: true, pid: 1234 }, wechat: { running: false, pid: null } } },
  '/dsh-feiyu/api/esp32/status': {
    ok: true, enabled: true, running: true,
    address: { address: '192.168.1.20', family: 'IPv4', port: 8765 },
    publicHost: '192.168.1.20',
    otaUrl: 'http://192.168.1.20:8765/xiaozhi/ota/',
    tokenSet: true,
    asrAvailable: true,
    devices: [{
      deviceId: 'aa:bb:cc', clientId: 'c1', sessionId: 's1', state: 'listening',
      connectedAt: Date.now() - 60_000, lastSeenAt: Date.now() - 3_000, remoteAddress: '192.168.1.50',
    }],
    lastError: 'connect ECONNREFUSED 127.0.0.1:8765',
  },
  '/dsh-feiyu/api/esp32/log?device=aa%3Abb%3Acc&limit=20': {
    ok: true, device: 'aa:bb:cc', limit: 20,
    rows: [
      { deviceId: 'aa:bb:cc', role: 'user', text: '你好小智', meta: {} },
      { deviceId: 'aa:bb:cc', role: 'assistant', text: '我在呢', meta: { latency: { vadMs: 120, asrMs: 340, llmFirstMs: 500, ttsFirstMs: 200, totalMs: 1400 } } },
    ],
  },
}

// ── 极小 React ────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  const flat = []
  for (const c of children.flat(Infinity)) flat.push(c)
  const merged = Object.assign({}, props || {})
  if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
  // 函数组件就地展开（Card / Row / Switch 都不带 hooks，展开是安全的）
  if (typeof type === 'function') return type(merged)
  return { type, props: merged, children: flat }
}

const state = []
const effects = []
let hookIndex = 0
let dirty = false

const reactStub = {
  createElement,
  useState(init) {
    const i = hookIndex++
    if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
    return [state[i], (v) => {
      const next = typeof v === 'function' ? v(state[i]) : v
      if (next !== state[i]) { state[i] = next; dirty = true }
    }]
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = effects[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (!changed) return
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    const cleanup = fn()
    effects[i] = { deps, cleanup }
  },
  useCallback(fn, deps) {
    const i = hookIndex++
    const prev = state[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (changed) state[i] = { deps, fn }
    return state[i].fn
  },
  useRef(v) { const i = hookIndex++; if (!(i in state)) state[i] = { current: v }; return state[i] },
}

// ── 环境桩 ────────────────────────────────────────────────────────────────
globalThis.window = { __ModuleLoader__: { load(spec) { globalThis.__spec = spec } } }
const styleTags = []
globalThis.document = {
  head: { appendChild: (el) => styleTags.push(el) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
}
let fetchCalls = []
let fetchPosts = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push(url)
  if (init && init.method === 'POST') {
    fetchPosts.push({ url, body: init.body })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
  }
  const data = RESPONSES[url]
  if (!data) return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: 'no fixture: ' + url }) }
  return { ok: true, status: 200, text: async () => JSON.stringify(data) }
}
globalThis.setTimeout = ((orig) => (fn, ms) => (ms > 500 ? 0 : orig(fn, ms)))(globalThis.setTimeout)

// ── 装载 client.js，取出注册的组件 ────────────────────────────────────────
require(path.join(root, 'client.js'))
const spec = globalThis.__spec
assert.ok(spec, 'client.js 没有调用 __ModuleLoader__.load')

let Component = null
const mod = spec.factory((n) => {
  if (n === 'react') return reactStub
  throw new Error('未预期的 require：' + n)
})
mod.apply({
  slots: {
    inject: (_slot, fn) => fn(),
    register: (_opts, C) => { Component = C; return () => {} },
  },
})
assert.equal(typeof Component, 'function', '没拿到注册的组件')

// ── 渲染直到稳定（数据回来后会有一次重渲染）────────────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0))
let tree = null
for (let pass = 0; pass < 12; pass++) {
  hookIndex = 0
  dirty = false
  tree = Component({ close: () => {} })
  await flush()
  await flush()
  if (!dirty) break
}

const dump = JSON.stringify(tree)
const textOf = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const kids = (node.children || []).map(textOf).join(' ')
  const inner = node.props && node.props.children != null ? ' ' + String(node.props.children) : ''
  return kids + inner
}
const allText = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const own = node.props ? Object.entries(node.props)
    .filter(([k, v]) => typeof v === 'string' && k !== 'className' && k !== 'style')
    .map(([, v]) => v).join(' ') : ''
  return own + ' ' + (node.children || []).map(allText).join(' ')
}

assert.ok(!dump.includes('载入失败'), '不该走到错误态：' + allText(tree).slice(0, 200))
const text = allText(tree)
for (const must of ['大肥鱼', '运行状态', '平台开关', '主人', '音色', '微信', '作息与限额', '角色设定', '记忆库']) {
  assert.ok(text.includes(must), '缺少区块：' + must)
}
for (const must of ['3082864371', 'sunshine_girl', '20:00', '在的，主人。', '运行中']) {
  assert.ok(text.includes(must), '缺少数据：' + must)
}
// 四个平台开关（在 .fy-grid 里），另外微信卡片还有一个「自己判断该不该接」的开关
const collect = (node, predicate, acc = []) => {
  if (!node || typeof node !== 'object') return acc
  if (node.props && predicate(node)) acc.push(node)
  for (const k of node.children || []) collect(k, predicate, acc)
  return acc
}
const platforms = collect(tree, (n) => n.props.className === 'fy-grid')
assert.equal(platforms.length, 1, '平台开关网格应该只有一个')
const switches = collect(platforms[0], (n) => String(n.props.className || '').includes('fy-switch'))
assert.equal(switches.length, 4, '平台开关数量应为 4，实际 ' + switches.length)
assert.equal(switches.filter((n) => n.props.className.includes('on')).length, 3, '默认应有 3 个平台开启')
const allSwitches = collect(tree, (n) => String(n.props.className || '').includes('fy-switch'))
assert.equal(allSwitches.length, 31, '全页开关应为 31 个（28 + 完全自由 + 干跑总闸 + 私信随DSH自启）')

assert.ok(fetchCalls.includes('/dsh-feiyu/api/config'), '没有请求 /config')
assert.ok(styleTags.length >= 1, '样式没注入')

// ── ESP32 卡片（T24）：有设备 + 有 lastError 的正常态 ────────────────────────
for (const must of ['小智 ESP32 通道', 'OTA URL', '在线设备', '最近对话', '已配置', '可用']) {
  assert.ok(text.includes(must), 'ESP32 卡片缺少：' + must)
}
for (const must of ['192.168.1.20:8765', 'http://192.168.1.20:8765/xiaozhi/ota/', 'aa:bb:cc', 'listening', '你好小智', '我在呢']) {
  assert.ok(text.includes(must), 'ESP32 卡片缺少数据：' + must)
}
assert.ok(text.includes('ECONNREFUSED'), 'lastError 应展示出来')
assert.ok(text.includes('1400ms'), '耗时指标应展示 totalMs')
assert.ok(!text.includes('secret-token-xyz'), '状态里即使混进 token 明文也不能渲染进 DOM')
assert.ok(!/"token"\s*:/.test(JSON.stringify(tree)), '渲染树不得携带 token 字段')
assert.ok(fetchCalls.some((u) => u.startsWith('/dsh-feiyu/api/esp32/log?device=')), '没有请求 esp32/log')

// ── 大脑（LLM）卡片：DSH 面板内置（主人 ↔ 音色之间）──────────────────────────
const rerender = async () => {
  for (let pass = 0; pass < 12; pass++) {
    hookIndex = 0
    dirty = false
    tree = Component({ close: () => {} })
    await flush()
    await flush()
    if (!dirty) break
  }
}
const collect2 = (node, predicate, acc = []) => collect(node, predicate, acc)
const inputsOf = (root) => collect2(root, (n) => n.type === 'input')

assert.ok(text.includes('大脑（LLM）'), 'DSH 面板缺少「大脑（LLM）」卡片（应在主人与音色之间）')
assert.ok(text.includes('接口地址') && text.includes('模型'), '大脑卡片缺少接口地址/模型')
const keyInput = inputsOf(tree).find((n) => n.props.type === 'password')
assert.ok(keyInput, '应有 password 类型的 API Key 输入')
assert.equal(keyInput.props.value, '', 'Key 不得回显（保存后后端也不回传明文）')
assert.ok(String(keyInput.props.placeholder).includes('未配置'), '未配置时 placeholder 应提示未配置')
assert.ok(inputsOf(tree).some((n) => n.props.value === 'https://api.deepseek.com/v1'), '接口地址应从配置回填')
assert.ok(inputsOf(tree).some((n) => n.props.value === 'deepseek-chat'), '模型应从配置回填')

// 输入 Key → 点「保存 Key」→ POST { llm: { api_key } } → 输入框清空、状态变已配置
keyInput.props.onChange({ target: { value: ' sk-test ' } })
await rerender()
const saveKeyBtn = collect2(tree, (n) => n.type === 'button')
  .find((n) => (n.children || []).includes('保存 Key'))
assert.ok(saveKeyBtn, '应有「保存 Key」按钮')
await saveKeyBtn.props.onClick()
await rerender()
const post = fetchPosts.find((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('api_key'))
assert.ok(post, '保存 Key 应 POST /config')
assert.deepEqual(JSON.parse(post.body), { llm: { api_key: 'sk-test' } }, 'Key 应 trim 后只放 llm.api_key')
assert.ok(!JSON.stringify(tree).includes('sk-test'), 'Key 不得留在渲染树/面板状态里')
const keyAfter = inputsOf(tree).find((n) => n.props.type === 'password')
assert.equal(keyAfter.props.value, '', '保存后 Key 输入框应清空')
assert.ok(String(keyAfter.props.placeholder).includes('已配置'), '保存后应显示已配置')

// ── ESP32 卡片空状态：未启用 + 无设备，不能崩 ───────────────────────────────
RESPONSES['/dsh-feiyu/api/esp32/status'] = {
  ok: true, enabled: false, running: false, address: null, publicHost: null,
  otaUrl: 'http://127.0.0.1:8765/xiaozhi/ota/', tokenSet: false, asrAvailable: false,
  devices: [], lastError: null,
}
state.length = 0
effects.length = 0
fetchCalls = []
let emptyTree = null
for (let pass = 0; pass < 12; pass++) {
  hookIndex = 0
  dirty = false
  emptyTree = Component({ close: () => {} })
  await flush()
  await flush()
  if (!dirty) break
}
const emptyText = allText(emptyTree)
assert.ok(!JSON.stringify(emptyTree).includes('载入失败'), '空状态不该走到错误态')
for (const must of ['ESP32 通道未启用', '未配置', '通道未启用，暂无设备', '还没有对话记录']) {
  assert.ok(emptyText.includes(must), 'ESP32 空状态缺少：' + must)
}

console.log('client-render ✓  渲染通过：9 个区块 · 4 个平台开关 · 大脑（LLM）卡片 · ESP32 卡片（正常态 + 空状态）· 请求', fetchCalls.length, '次')
