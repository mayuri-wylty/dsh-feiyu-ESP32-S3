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
for (const must of ['大肥鱼', '演练', '真发', '体检', '主人', '音色', '微信', '作息', '角色设定', '记忆库']) {
  assert.ok(text.includes(must), '缺少区块：' + must)
}
for (const must of ['3082864371', 'sunshine_girl', '20:00', '在的，主人。', '生物钟 运行中']) {
  assert.ok(text.includes(must), '缺少数据：' + must)
}
// T7：旧的「运行状态 / 平台开关 / 连接中心」三张卡与 基础/平台/高级 分组已删除
for (const gone of ['运行状态', '平台开关', '连接中心', '跑一次体检', '干跑（总闸）']) {
  assert.ok(!text.includes(gone), 'T7 后不应再有：' + gone)
}
const collect = (node, predicate, acc = []) => {
  if (!node || typeof node !== 'object') return acc
  if (node.props && predicate(node)) acc.push(node)
  for (const k of node.children || []) collect(k, predicate, acc)
  return acc
}
const hasCls = (n, c) => String((n.props && n.props.className) || '').split(/\s+/).includes(c)
const byCls = (root, c) => collect(root, (n) => hasCls(n, c))
const byId = (root, id) => collect(root, (n) => n.props.id === id)[0]
assert.equal(byCls(tree, 'fy-group').filter((n) => !hasCls(n, 'sub')).length, 0, '不应再有顶层折叠分组（基础/平台/高级）')
assert.ok(!/fy-hint|fy-sw-desc|fy-sub|fy-grid/.test(dump), '整页不得出现灰字说明类 fy-hint / fy-sw-desc / fy-sub / 旧开关网格')

// ── T7 布局：状态条 → 5 通道卡（B站、抖音、QQ、微信、小智ESP32）→ 通用区 → 自由度区 ──
const CH_IDS = ['fy-ch-bili', 'fy-ch-douyin', 'fy-qq', 'fy-wechat', 'fy-esp32']
const flatKids = (kids) => kids.flatMap((n) => (n && typeof n === 'object' ? (n.type === undefined ? flatKids(n.children || []) : [n]) : []))
const panelKids = flatKids(tree.children || [])
const kidIdx = (pred) => panelKids.findIndex(pred)
const chans = byCls(tree, 'fy-channel')
assert.deepEqual(chans.map((n) => n.props.id), CH_IDS, '通道卡顺序应为 B站、抖音、QQ、微信、小智ESP32')
for (const c of chans) {
  assert.ok(byCls(byCls(c, 'fy-card-head')[0], 'fy-card-title')[0].children.some((k) => k && k.props && /^fy-dot-(ok|warn|off|idle)$/.test(k.props.className)), c.props.id + ' 卡头应有 StatusDot')
}
const sbIdx = kidIdx((n) => hasCls(n, 'fy-statusbar'))
const order = CH_IDS.map((id) => kidIdx((n) => n.props.id === id))
assert.ok(sbIdx >= 0 && sbIdx < order[0], '状态条在通道卡之前（置顶）')
assert.deepEqual(order, [...order].sort((a, b) => a - b), '通道卡按序排列')
const idxOfTitle = (t) => kidIdx((n) => byCls(n, 'fy-card-title').some((x) => (x.children || []).includes(t)))
const gen = ['主人', '大脑（LLM）', '音色', '角色设定', '记忆库'].map(idxOfTitle)
assert.ok(gen.every((i) => i > order[4]), '通用区在通道卡之后：' + gen)
assert.deepEqual(gen, [...gen].sort((a, b) => a - b), '通用区顺序：主人、大脑、音色、角色设定、记忆库')
const zoneIdx = kidIdx((n) => byCls(n, 'fy-zone-head').some((x) => allText(x).includes('完全自由与进化')))
const restIdx = idxOfTitle('作息')
assert.ok(zoneIdx > gen[4] && restIdx > zoneIdx, '自由度区：完全自由与进化（DangerZone）在前，作息在后，都在通用区之后')
const zone = byCls(tree, 'fy-zone').find((z) => allText(z).includes('完全自由与进化'))
assert.equal(byCls(zone, 'fy-zone-head')[0].props['aria-expanded'], 'false', '完全自由与进化默认折叠')
assert.ok(allText(byCls(zone, 'fy-zone-head')[0]).includes('完全自由与进化'))

// 状态条：5 个通道点 + 演练|真发 Segmented + 体检
const bar = byCls(tree, 'fy-statusbar')[0]
const sbDots = byCls(bar, 'fy-sb-dot')
assert.deepEqual(sbDots.map((n) => n.props['data-conn']), ['bilibili', 'douyin', 'qq', 'wechat', 'esp32'])
assert.deepEqual(sbDots.map((n) => (n.children || []).filter((c) => typeof c === 'string').join('')), ['B站', '抖音', 'QQ', '微信', '小智ESP32'])
assert.ok(sbDots.every((n) => byCls(n, 'fy-dot-off').length + byCls(n, 'fy-dot-ok').length + byCls(n, 'fy-dot-warn').length + byCls(n, 'fy-dot-idle').length === 1), '每个点一个 StatusDot')
const seg = byCls(bar, 'fy-seg')[0]
assert.deepEqual(byCls(seg, 'fy-seg-opt').map((n) => (n.children || []).join('')), ['演练', '真发'])
assert.ok(hasCls(byCls(seg, 'fy-seg-opt')[1], 'danger'), '真发是 danger 选项')
assert.ok(hasCls(byCls(seg, 'fy-seg-opt')[1], 'on') && !hasCls(byCls(seg, 'fy-seg-opt')[0], 'on'), 'status.dryRun=false → 真发选中')
assert.ok(byCls(bar, 'fy-btn').some((n) => (n.children || []).join('') === '体检'), '状态条右端有「体检」')

// 平台启用开关：在各自通道卡头（键 / 初始态同旧「平台开关」卡）；ESP32 卡头没有
const headSwitch = (id) => byCls(byCls(byId(tree, id), 'fy-card-head')[0], 'fy-switch')
for (const [id, label, on] of [['fy-ch-bili', 'B站', true], ['fy-ch-douyin', '抖音', true], ['fy-qq', 'QQ', true], ['fy-wechat', '微信', false]]) {
  const sw = headSwitch(id)
  assert.equal(sw.length, 1, label + ' 卡头应有 1 个平台启用开关')
  assert.equal(sw[0].props['aria-label'], label)
  assert.equal(hasCls(sw[0], 'on'), on, label + ' 初始态')
}
assert.equal(headSwitch('fy-esp32').length, 0, 'ESP32 卡头不加平台开关')
const allSwitches = collect(tree, (n) => String(n.props.className || '').includes('fy-switch'))
assert.equal(allSwitches.length, 31 + 8 + 1 - 1, '全页开关 39 个（旧 40：31 + 8 个「不限」+ QQ 日上限「不限」；干跑开关换成 演练|真发 Segmented 少 1）')

assert.ok(fetchCalls.includes('/dsh-feiyu/api/config'), '没有请求 /config')
assert.ok(styleTags.length >= 1, '样式没注入')

// ── ESP32 卡片（T24）：有设备 + 有 lastError 的正常态 ────────────────────────
for (const must of ['小智 ESP32 通道', 'OTA URL', '在线设备', '最近对话', '已配置']) {
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
const keyInput = inputsOf(tree).find((n) => n.props.type === 'password' && !['SESSDATA', 'bili_jct', 'buvid3'].includes(n.props.placeholder))
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
const keyAfter = inputsOf(tree).find((n) => n.props.type === 'password' && !['SESSDATA', 'bili_jct', 'buvid3'].includes(n.props.placeholder))
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
for (const must of ['未启用', '未配置']) {
  assert.ok(emptyText.includes(must), 'ESP32 空状态缺少：' + must)
}

// ── ESP32 云端 ASR/TTS 配置块：有 providers 数据时动态渲染 ───────────────────
const F = (key, label, type, extra = {}) => ({ key, label, type, required: false, secret: type === 'password', ...extra })
RESPONSES['/dsh-feiyu/api/esp32/providers'] = {
  ok: true,
  providers: [
    { kind: 'asr', id: 'sensevoice', label: '本地 SenseVoice', configKey: 'sensevoice', local: true, testable: false, fields: [], presets: [] },
    { kind: 'asr', id: 'openai-compatible', label: 'OpenAI 兼容云 ASR', configKey: 'openai', local: false, testable: true,
      fields: [F('baseUrl', 'Base URL', 'string'), F('apiKey', 'API Key', 'password', { required: true }), F('model', '模型', 'string')],
      presets: [{ id: 'groq', label: 'Groq', values: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' } }] },
    { kind: 'tts', id: 'sovits-stream', label: '本地 GPT-SoVITS（流式）', configKey: 'sovits-stream', local: true, testable: false, fields: [], presets: [] },
    { kind: 'tts', id: 'volcengine', label: '火山豆包语音 TTS（流式）', configKey: 'volcengine', local: false, testable: true,
      fields: [F('apiKey', 'API Key', 'password', { required: true }), F('speaker', '音色', 'string', { hint: '2.0/1.0 音色需与资源 ID 匹配' })], presets: [] },
  ],
  current: {
    asr: { primary: 'sensevoice', fallback: '', values: { openai: { baseUrl: 'https://x/v1', model: 'm', hasKey: true } } },
    tts: { primary: 'sovits-stream', fallback: '', values: { volcengine: { speaker: 'zh_female', hasKey: false } } },
  },
  pipeline: { asr: { primary: 'openai-compatible', fallback: 'sensevoice', ready: false, error: 'boom' }, tts: { primary: 'volcengine', ready: true }, degraded: true, reason: 'ASR 云端不可用' },
}
state.length = 0
effects.length = 0
let provTree = null
for (let pass = 0; pass < 12; pass++) {
  hookIndex = 0
  dirty = false
  provTree = Component({ close: () => {} })
  await flush()
  await flush()
  if (!dirty) break
}
const provText = allText(provTree)
for (const must of ['语音识别（ASR）', '语音合成（TTS）', '测试连接', '仅保存', '通过后自动启用为主', '已保存，留空保持不变', 'Groq', '2.0/1.0 音色需与资源 ID 匹配', '已降级：ASR 云端不可用', 'https://x/v1']) {
  assert.ok(provText.includes(must), 'ESP32 providers 块缺少：' + must)
}
assert.ok(!/"apiKey"\s*:/.test(JSON.stringify(provTree)), '渲染树不得携带 apiKey 字段')

// ── ESP32 卡片交互（T3）：自检 / 设备白名单 / 在线设备一键加入 ─────────────────
RESPONSES['/dsh-feiyu/api/esp32/status'] = {
  ok: true, enabled: true, running: true, address: null, publicHost: '192.168.1.20',
  otaUrl: 'http://192.168.1.20:8765/xiaozhi/ota/', tokenSet: true, asrAvailable: true,
  devices: [
    { deviceId: 'aa:bb:cc', sessionId: 's1', state: 'listening', lastSeenAt: Date.now() - 3_000 },
    { deviceId: 'aa:bb:dd', sessionId: 's2', state: 'idle', lastSeenAt: Date.now() - 30_000 },
  ],
  lastError: null,
}
RESPONSES['/dsh-feiyu/api/config'].config.esp32 = { allowDevices: ['aa:bb:dd'] }
RESPONSES['/dsh-feiyu/api/esp32/selfcheck'] = {
  ok: false,
  checks: [{ id: 'gateway', ok: true }, { id: 'ota', ok: true }, { id: 'ws', ok: false, detail: '握手超时' }, { id: 'token', ok: true }],
}
state.length = 0
effects.length = 0
fetchCalls = []
await rerender()
const btnByText = (t) => collect2(tree, (n) => n.type === 'button' && (n.children || []).includes(t))[0]
const titleDot = () => collect2(collect2(tree, (n) => n.props.id === 'fy-esp32')[0], (n) => n.props.className === 'fy-card-title' && (n.children || []).some((c) => c && c.props && /^fy-dot-/.test(c.props.className || '')))
  .map((n) => n.children.find((c) => c.props && /^fy-dot-/.test(c.props.className || '')).props.className)[0]
const chkItems = () => collect2(tree, (n) => n.props['data-chk'])
assert.equal(titleDot(), 'fy-dot-ok', '运行中 + Token + ASR 可用 → 卡头状态点为 ok')
assert.ok(!allText(tree).includes('通道 已启用'), '不应再有重复的状态 chip')
assert.ok(btnByText('自检'), '卡头应有「自检」按钮')

await btnByText('自检').props.onClick()
await rerender()
assert.ok(fetchCalls.includes('/dsh-feiyu/api/esp32/selfcheck'), '点击自检应请求 /esp32/selfcheck')
assert.equal(chkItems().length, 4, '自检分项应渲染 4 个点')
assert.deepEqual(chkItems().map((n) => n.props['data-chk']), ['gateway', 'ota', 'ws', 'token'])
assert.equal(chkItems().find((n) => n.props['data-chk'] === 'ws').props.title, '握手超时', '失败项 detail 放 title')
assert.equal(titleDot(), 'fy-dot-warn', '有失败项 → 卡头状态点降为 warn')

// 自检请求失败（api 抛错）→ err 状态点
delete RESPONSES['/dsh-feiyu/api/esp32/selfcheck']
await btnByText('自检').props.onClick()
await rerender()
assert.equal(titleDot(), 'fy-dot-off', '自检失败（接口抛错）→ 状态点为 off')

// 白名单：回车添加（trim + 小写），POST { esp32: { allowDevices } }
const allowInput = () => inputsOf(tree).find((n) => n.props['aria-label'] === 'allow-device')
assert.equal(allowInput().props.placeholder, '添加 Device-Id')
allowInput().props.onChange({ target: { value: ' AA:BB:EE ' } })
await rerender()
fetchPosts.length = 0
await allowInput().props.onKeyDown({ key: 'Enter', preventDefault() {} })
await rerender()
const wlPost = fetchPosts.find((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('allowDevices'))
assert.ok(wlPost, '添加设备应 POST /config')
assert.deepEqual(JSON.parse(wlPost.body), { esp32: { allowDevices: ['aa:bb:dd', 'aa:bb:ee'] } })
// 重复添加不再请求
fetchPosts.length = 0
allowInput().props.onChange({ target: { value: 'AA:BB:EE' } })
await rerender()
await allowInput().props.onKeyDown({ key: 'Enter', preventDefault() {} })
assert.equal(fetchPosts.length, 0, '重复 Device-Id 不应再次保存')
// 删除
const removeBtn = collect2(tree, (n) => n.props['aria-label'] === '移除 aa:bb:dd')[0]
assert.ok(removeBtn, '已加入的 Device-Id 应有可删除 chip')
fetchPosts.length = 0
await removeBtn.props.onClick()
await rerender()
assert.deepEqual(JSON.parse(fetchPosts[0].body), { esp32: { allowDevices: ['aa:bb:ee'] } })
// 在线设备一键加入：aa:bb:cc 可加入，aa:bb:dd 已被移出（可加入），aa:bb:ee 不在线
const joinBtns = collect2(tree, (n) => String(n.props.className || '').includes('fy-esp32-join'))
assert.equal(joinBtns.length, 2, '每个在线设备一行加入按钮')
fetchPosts.length = 0
await joinBtns[0].props.onClick()
await rerender()
assert.deepEqual(JSON.parse(fetchPosts[0].body), { esp32: { allowDevices: ['aa:bb:ee', 'aa:bb:cc'] } })
const joinedBtn = collect2(tree, (n) => String(n.props.className || '').includes('fy-esp32-join'))[0]
assert.ok(joinedBtn.props.className.includes('added') && joinedBtn.props.disabled, '已在白名单的设备显示已加入态')

// ── 连接状态（T4 → T7 迁入各通道卡）：以 test/fixtures/connections.json 四种状态为准 ─────────────
const fs = await import('node:fs')
const FX = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/connections.json'), 'utf8'))
const CT = mod.__test
assert.ok(CT && CT.CONN_API && CT.deriveConnections && CT.createLoginFlow, 'client.js 应通过 exports.__test 暴露连接中心纯函数')
const renderConn = async (fx) => {
  RESPONSES['/dsh-feiyu/api/connections'] = fx
  RESPONSES['/dsh-feiyu/api/qq/qrcode'] = { ok: true, exists: true, ageSec: fx.qq.qr.ageSec, expired: fx.qq.qr.expired, dataUrl: 'data:image/png;base64,AAAA' }
  state.length = 0
  effects.length = 0
  fetchCalls = []
  fetchPosts = []
  await rerender()
  return tree
}
const btnsOf = (t) => collect(t, (n) => n.type === 'button').map((n) => (n.children || []).join(''))
const ckInputs = (t) => inputsOf(t).filter((n) => ['SESSDATA', 'bili_jct', 'buvid3'].includes(n.props.placeholder))
const cardText = (t, id) => allText(byId(t, id))
const cardBtns = (t, id) => collect(byId(t, id), (n) => n.type === 'button').map((n) => (n.children || []).join(''))
const headBtns = (t, id) => collect(byCls(byId(t, id), 'fy-card-head')[0], (n) => n.type === 'button' && !hasCls(n, 'fy-switch')).map((n) => (n.children || []).join(''))
const textBtn = (t, id, label) => collect(byId(t, id), (n) => n.type === 'button' && (n.children || []).join('') === label)[0]

// loggedOut：全部「未检测/未登录」，有二维码图，有扫码登录按钮
let ct = await renderConn(FX.loggedOut)
let ctext = allText(ct)
for (const must of ['未检测（还没填 cookie）', '网关未启动', '未运行', '重新检测', '扫码登录', '刷新二维码', '保存 cookie']) {
  assert.ok(ctext.includes(must), '连接状态(loggedOut)缺少：' + must)
}
// 各内容落在对应通道卡内
assert.ok(cardText(ct, 'fy-ch-bili').includes('未检测（还没填 cookie）') && cardBtns(ct, 'fy-ch-bili').includes('保存 cookie') && headBtns(ct, 'fy-ch-bili').includes('Cookie 登录'), 'B站卡：状态摘要 + cookie 表单 + 头部「Cookie 登录」')
assert.ok(cardText(ct, 'fy-ch-douyin').includes('未登录') && headBtns(ct, 'fy-ch-douyin').includes('扫码登录'), '抖音卡：状态 + 头部「扫码登录」')
assert.ok(cardText(ct, 'fy-qq').includes('网关未启动') && cardBtns(ct, 'fy-qq').includes('刷新二维码'), 'QQ 卡：状态 + 刷新二维码')
assert.ok(cardText(ct, 'fy-wechat').includes('未运行') && !cardBtns(ct, 'fy-wechat').includes('重新检测'), '微信卡：摘要，无重新检测')
assert.equal(collect(byId(ct, 'fy-qq'), (n) => n.type === 'img' && n.props.src === 'data:image/png;base64,AAAA').length, 1, '二维码 <img> 在 QQ 卡内（不是浮层）')
assert.ok(hasCls(byCls(byId(ct, 'fy-ch-bili'), 'fy-conn-ck')[0], 'fy-row') && byCls(byId(ct, 'fy-ch-bili'), 'fy-conn-ck')[0].props.style.display === 'none', 'cookie 表单默认收起（仍挂在树里）')
// 状态条的点来自 deriveConnections：unknown → 灰点(idle)，off → 红点，没有绿/黄
{
  const dots = byCls(byCls(ct, 'fy-statusbar')[0], 'fy-sb-dot').map((n) => (n.children[0].props.className))
  assert.deepEqual(dots, ['fy-dot-idle', 'fy-dot-off', 'fy-dot-off', 'fy-dot-off', 'fy-dot-idle'])
}
assert.ok(fetchCalls.includes('/dsh-feiyu/api/connections'), '面板打开应拉一次 /connections')
assert.ok(!fetchCalls.some((u) => u.includes('/connections/check')), '打开面板不得自动触发 check')
assert.ok(collect(ct, (n) => n.type === 'img' && n.props.src === 'data:image/png;base64,AAAA').length === 1, '应渲染二维码 <img>')
const cks = ckInputs(ct)
assert.equal(cks.length, 3, 'cookie 应有三个输入')
assert.ok(cks.every((n) => n.props.type === 'password' && n.props.value === ''), 'cookie 输入必须 password 且为空')

// 提交 cookie：POST /cookie，成功后输入清空且不回显
cks[0].props.onChange({ target: { value: 'sess-SECRET' } })
await rerender()
ckInputs(tree)[1].props.onChange({ target: { value: 'jct-SECRET' } })
await rerender()
assert.ok(!JSON.stringify(tree).includes('SECRET') || ckInputs(tree).every((n) => n.props.type === 'password'), 'cookie 仅存在于 password 输入')
const ckOpenBtn = textBtn(tree, 'fy-ch-bili', 'Cookie 登录')
await ckOpenBtn.props.onClick()
await rerender()
assert.equal(byCls(byId(tree, 'fy-ch-bili'), 'fy-conn-ck')[0].props.style.display, 'flex', '点「Cookie 登录」展开表单')
assert.ok(textBtn(tree, 'fy-ch-bili', '收起 Cookie'), '展开后头部按钮变「收起 Cookie」')
const saveCk = textBtn(tree, 'fy-ch-bili', '保存 cookie')
await saveCk.props.onClick()
await rerender()
const ckPost = fetchPosts.find((p) => p.url === '/dsh-feiyu/api/cookie')
assert.ok(ckPost && JSON.parse(ckPost.body).sessdata === 'sess-SECRET', '应 POST /cookie')
assert.ok(ckInputs(tree).every((n) => n.props.value === ''), '提交后 cookie 输入应清空')
assert.equal(byCls(byId(tree, 'fy-ch-bili'), 'fy-conn-ck')[0].props.style.display, 'none', '保存成功后表单收起')
assert.ok(allText(tree).includes('B站 cookie 已保存'), '保存成功提示')
assert.ok(!JSON.stringify(tree).includes('SECRET'), 'cookie 不得留在渲染树')

// 重新检测：POST /connections/check {target}
const recheckQq = textBtn(tree, 'fy-qq', '重新检测')
await recheckQq.props.onClick()
assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url.endsWith('/connections/check')).body), { target: 'qq' })

// loggedIn
ct = await renderConn(FX.loggedIn)
ctext = allText(ct)
for (const must of ['已登录：测试用户（123456）', '已登录：抖音测试', '已登录：机器人（10001）', '运行中']) {
  assert.ok(ctext.includes(must), '连接状态(loggedIn)缺少：' + must)
}
assert.ok(cardText(ct, 'fy-ch-bili').includes('已登录：测试用户（123456）'), 'B站摘要在 B站卡')
assert.ok(cardText(ct, 'fy-ch-douyin').includes('已登录：抖音测试'), '抖音摘要在抖音卡')
assert.ok(cardText(ct, 'fy-qq').includes('已登录：机器人（10001）'), 'QQ 摘要在 QQ 卡')
assert.ok(cardText(ct, 'fy-wechat').includes('运行中'), '微信摘要在微信卡')
assert.equal(collect(ct, (n) => n.type === 'img').length, 0, '无二维码时不渲染 img')
{
  const dots = byCls(byCls(ct, 'fy-statusbar')[0], 'fy-sb-dot').map((n) => (n.children[0].props.className))
  assert.deepEqual(dots.slice(0, 4), ['fy-dot-ok', 'fy-dot-ok', 'fy-dot-ok', 'fy-dot-ok'], 'loggedIn：前 4 个通道点为绿')
  const cardDots = ['fy-ch-bili', 'fy-ch-douyin', 'fy-qq', 'fy-wechat'].map((id) => byCls(byId(ct, id), 'fy-card-title')[0].children.find((k) => k && k.props && /^fy-dot-/.test(k.props.className)).props.className)
  assert.deepEqual(cardDots, ['fy-dot-ok', 'fy-dot-ok', 'fy-dot-ok', 'fy-dot-ok'], '卡头状态点同样来自 deriveConnections')
}

// probeFailed：错误原因可见，二维码过期提示
ct = await renderConn(FX.probeFailed)
ctext = allText(ct)
for (const must of ['nav: -101 账号未登录', 'self-info 超时', '二维码已过期', '登录失败：Chrome 未能启动', 'get_login_info 超时']) {
  assert.ok(ctext.includes(must), '连接状态(probeFailed)缺少：' + must)
}
assert.ok(cardText(ct, 'fy-qq').includes('二维码已过期'), '二维码过期提示在 QQ 卡')
assert.ok(cardText(ct, 'fy-ch-douyin').includes('登录失败：Chrome 未能启动'), '抖音登录失败提示在抖音卡')
assert.ok(cardText(ct, 'fy-ch-bili').includes('nav: -101 账号未登录'), 'B站失败原因在 B站卡')

// douyinWaiting：等待提示 + 取消按钮
ct = await renderConn(FX.douyinWaiting)
ctext = allText(ct)
assert.ok(ctext.includes('请在弹出的 Chrome 里扫码，剩余 150 秒'), '应显示扫码倒计时')
assert.ok(btnsOf(ct).includes('取消') && !btnsOf(ct).includes('扫码登录'), '等待中应显示取消而非扫码登录')
assert.ok(cardText(ct, 'fy-ch-douyin').includes('请在弹出的 Chrome 里扫码，剩余 150 秒'), '扫码倒计时在抖音卡内')
assert.deepEqual(headBtns(ct, 'fy-ch-douyin'), ['取消'], '抖音卡头动作 = 取消')
{
  const dotOf = (id) => byCls(byId(ct, id), 'fy-card-title')[0].children.find((k) => k && k.props && /^fy-dot-/.test(k.props.className)).props.className
  assert.equal(dotOf('fy-ch-douyin'), 'fy-dot-warn', '等待扫码 → 抖音点为黄')
}

// 后端未提供（404）→ 降级提示，不崩
delete RESPONSES['/dsh-feiyu/api/connections']
state.length = 0
effects.length = 0
await rerender()
assert.ok(allText(tree).includes('后端未提供，请重启 DSH'), '404 应降级提示')
assert.ok(!JSON.stringify(tree).includes('载入失败'), '连接状态 404 不得拖垮整页')
assert.equal(byCls(byCls(tree, 'fy-statusbar')[0], 'fy-sb-dot').length, 5, '404 时状态条仍有 5 个点')

// deriveConnections 纯函数
const dv = CT.deriveConnections(FX.loggedOut)
assert.deepEqual(dv.map((x) => x.id), ['bilibili', 'douyin', 'qq', 'wechat', 'esp32'])
assert.equal(dv[0].state, 'unknown')
assert.equal(dv[0].summary.startsWith('未检测'), true)
assert.equal(CT.deriveConnections(FX.loggedIn).filter((x) => x.state === 'ok').length, 4)
assert.equal(CT.deriveConnections(FX.probeFailed)[2].state, 'warn')
assert.equal(CT.deriveConnections(null).length, 5, '空输入不抛错')

// 抖音登录状态机：start 后轮询，ok 即停；stop 即停；cancel
{
  const calls = []
  const seq = [{ state: 'waiting', remainingSec: 170 }, { state: 'waiting', remainingSec: 168 }, { state: 'ok' }, { state: 'ok' }]
  const states = []
  const timers = []
  const flow = CT.createLoginFlow({
    call: async (p, init) => { calls.push((init && init.method) || 'GET'); return p === CT.CONN_API.douyinLogin && init ? { state: 'waiting', remainingSec: 180 } : seq.shift() },
    onState: (s) => states.push(s.state),
    schedule: (fn) => { timers.push(fn); return timers.length },
    clear: () => {},
  })
  await flow.start()
  assert.deepEqual(calls, ['POST'])
  for (let i = 0; i < 5 && timers.length; i++) { await timers.shift()() }
  assert.deepEqual(states, ['waiting', 'waiting', 'waiting', 'ok'], '轮询到 ok 应停止')
  assert.equal(timers.length, 0, 'ok 后不再排下一次')
  const f2 = CT.createLoginFlow({ call: async () => ({ state: 'waiting' }), onState: () => states.push('x'), schedule: (fn) => { timers.push(fn); return 1 }, clear: () => {} })
  await f2.start()
  const pending = timers.shift()
  f2.stop()
  const before = states.length
  await pending()
  assert.equal(states.length, before, '卸载后不得再回调')
}

// ── T7：状态条交互 / 平台启用开关迁入卡头 / 卡头动作 ──────────────────────────────
{
  const gt = await renderConn(FX.loggedIn)
  assert.equal(collect(gt, (n) => String(n.props.className || '').includes('fy-switch')).length, 39, '开关总数不受重排影响（39）')
  assert.ok(allText(byId(gt, 'fy-ch-bili')).includes('主动搭话') === false && allText(byId(gt, 'fy-qq')).includes('主动搭话'), '主动搭话在 QQ 卡')
  assert.ok(!allText(gt).includes('NapCat\\cache'), '不再写死二维码路径')

  // 点击状态条的点 → scrollIntoView 到对应卡 id
  const scrolled = []
  const origGet = document.getElementById
  document.getElementById = (id) => ({ scrollIntoView: (o) => scrolled.push([id, o && o.behavior]) })
  for (const d of byCls(byCls(gt, 'fy-statusbar')[0], 'fy-sb-dot')) d.props.onClick()
  document.getElementById = origGet
  assert.deepEqual(scrolled.map((x) => x[0]), CH_IDS, '5 个点依次滚到 5 张通道卡')

  // 演练|真发：与旧总闸同一条保存路径 { guard: { dryRun } }，toast 文案不变，成功后状态条跟随
  const segOpt = (label) => byCls(byCls(tree, 'fy-statusbar')[0], 'fy-seg-opt').find((n) => (n.children || []).join('') === label)
  fetchPosts.length = 0
  await segOpt('演练').props.onClick()
  await rerender()
  const dryPost = fetchPosts.find((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('dryRun'))
  assert.deepEqual(JSON.parse(dryPost.body), { guard: { dryRun: true } })
  assert.ok(allText(tree).includes('已切干跑：所有对外动作只演练不发送'), '切演练 toast')
  assert.ok(hasCls(segOpt('演练'), 'on') && !hasCls(segOpt('真发'), 'on'), '保存成功后「演练」选中')
  fetchPosts.length = 0
  await segOpt('真发').props.onClick()
  await rerender()
  assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('dryRun')).body), { guard: { dryRun: false } }, '点「真发」POST 同一条保存路径')
  assert.ok(allText(tree).includes('已切真发：弹幕/动态/点赞/评论/群聊/说说/音频都会真的发出去'), '切真发 toast')
  assert.ok(hasCls(segOpt('真发'), 'on'))

  // 平台启用开关（卡头）：同旧开关的保存 + 重启语义
  fetchPosts.length = 0
  await headSwitch('fy-wechat')[0].props.onClick()
  await rerender()
  const platPost = fetchPosts.find((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('platforms'))
  assert.deepEqual(JSON.parse(platPost.body), { platforms: { bilibili: true, qq: true, wechat: true, douyin: true } }, '微信开关 POST platforms 整段')
  assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url === '/dsh-feiyu/api/services').body), { target: 'wechat', action: 'start' }, '微信开 → 启动服务')
  assert.ok(allText(tree).includes('已开启：微信') || fetchPosts.length >= 2, '开启 toast')
  fetchPosts.length = 0
  await headSwitch('fy-ch-bili')[0].props.onClick()
  await rerender()
  assert.ok(fetchPosts.some((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('"bilibili":false')), 'B站开关写 platforms.bilibili=false')
  assert.ok(!fetchPosts.some((p) => p.url === '/dsh-feiyu/api/services'), 'B站/抖音开关不重启服务')

  // 卡头动作：QQ 网关 / 重启 QQ / 重启微信（走 /services）
  assert.deepEqual(headBtns(tree, 'fy-qq'), ['安装并启动 QQ 网关', '重启 QQ'], 'QQ 头：网关不通 → 安装并启动 + 重启')
  assert.deepEqual(headBtns(tree, 'fy-wechat'), ['重启微信'])
  fetchPosts.length = 0
  await textBtn(tree, 'fy-wechat', '重启微信').props.onClick()
  assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url === '/dsh-feiyu/api/services').body), { target: 'wechat', action: 'restart' })
  fetchPosts.length = 0
  await textBtn(tree, 'fy-qq', '重启 QQ').props.onClick()
  assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url === '/dsh-feiyu/api/services').body), { target: 'qq', action: 'restart' })
  fetchPosts.length = 0
  await textBtn(tree, 'fy-qq', '安装并启动 QQ 网关').props.onClick()
  assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url === '/dsh-feiyu/api/services').body), { target: 'napcat', action: 'install' })
  fetchPosts.length = 0
  await textBtn(tree, 'fy-ch-douyin', '扫码登录').props.onClick()
  assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url === '/dsh-feiyu/api/douyin/login').body), { action: 'start' })

  // 体检：POST /selftest，明细（fy-check）出现在状态条下方
  RESPONSES['/dsh-feiyu/api/selftest'] = { ok: false, items: [{ name: '配置可读', ok: true }, { name: 'LLM Key', ok: false, detail: '未配置' }] }
  const origPost = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST' && url === '/dsh-feiyu/api/selftest') { fetchPosts.push({ url, body: init.body }); return { ok: true, status: 200, text: async () => JSON.stringify(RESPONSES[url]) } }
    return origPost(url, init)
  }
  fetchPosts.length = 0
  await byCls(byCls(tree, 'fy-statusbar')[0], 'fy-btn').find((n) => (n.children || []).join('') === '体检').props.onClick()
  await rerender()
  globalThis.fetch = origPost
  assert.ok(fetchPosts.some((p) => p.url === '/dsh-feiyu/api/selftest'), '体检 POST /selftest')
  const chk = byCls(tree, 'fy-check')[0]
  assert.ok(chk, '体检结果区 fy-check 在状态条下')
  assert.ok(allText(chk).includes('配置可读') && allText(chk).includes('LLM Key') && allText(chk).includes('未配置'), '体检明细')
  { const ks = flatKids(tree.children || []); assert.equal(ks.findIndex((n) => hasCls(n, 'fy-check')), ks.findIndex((n) => hasCls(n, 'fy-statusbar')) + 1, 'fy-check 紧贴状态条') }

  delete RESPONSES['/dsh-feiyu/api/connections']
  state.length = 0
  effects.length = 0
  await rerender()
  const noConn = allText(tree)
  assert.ok(noConn.includes('未检测') && !noConn.includes('已接入'), '拿不到 /connections 时显示未检测')
  assert.ok(!JSON.stringify(tree).includes('fy-hint'), '整页没有 fy-hint')
}

// ── T7 评审修复：白名单（失焦/竞态/读失败/保存失败）· 刷新入口 · 未加载灰点 · QQ 间隔回写 · 无障碍 ───────────
{
  const origST = globalThis.setTimeout
  const origFetch = globalThis.fetch
  const settle = () => new Promise((r) => origST(r, 25))
  const resetAll = async () => {
    state.length = 0; effects.length = 0; fetchCalls = []; fetchPosts = []
    await rerender(); await settle(); await rerender()
  }
  const esp = () => byId(tree, 'fy-esp32')
  const alInput = () => inputsOf(esp()).find((n) => n.props['aria-label'] === 'allow-device')
  const addBtn = () => collect(esp(), (n) => n.props['aria-label'] === '添加到白名单')[0]
  const joinBtns = () => collect(esp(), (n) => String(n.props.className || '').includes('fy-esp32-join'))
  const rmBtns = () => collect(esp(), (n) => String(n.props.className || '').includes('fy-esp32-wl-x'))
  const wlPosts = () => fetchPosts.filter((p) => p.url === '/dsh-feiyu/api/config' && String(p.body).includes('allowDevices')).map((p) => JSON.parse(p.body).esp32.allowDevices)
  const savedCfg = JSON.stringify(RESPONSES['/dsh-feiyu/api/config'].config.esp32)

  // 2：失焦既不加入也不清空；回车 / 「＋」才加入
  RESPONSES['/dsh-feiyu/api/config'].config.esp32 = { allowDevices: [] }
  await resetAll()
  assert.equal(alInput().props.onBlur, undefined, '白名单输入框不再挂 onBlur')
  alInput().props.onChange({ target: { value: ' AA:BB:99 ' } })
  await rerender()
  assert.ok(addBtn(), '输入框旁有「＋」按钮')
  assert.equal(alInput().props.value, ' AA:BB:99 ')
  assert.equal(wlPosts().length, 0, '输入但未回车/点＋：不保存')
  await addBtn().props.onClick()
  await rerender()
  assert.deepEqual(wlPosts(), [['aa:bb:99']], '点「＋」加入（trim + 小写）')
  assert.equal(alInput().props.value, '', '加入成功后输入框清空')
  assert.ok(addBtn().props.disabled, '输入为空时「＋」禁用')

  // 3a：连续两次「加入」不互相吞掉（不等第一个返回就点第二个）
  RESPONSES['/dsh-feiyu/api/config'].config.esp32 = { allowDevices: [] }
  await resetAll()
  fetchPosts.length = 0
  const [j0, j1] = joinBtns()
  const pa = j0.props.onClick()
  const pb = j1.props.onClick()
  await Promise.all([pa, pb])
  await rerender()
  assert.deepEqual(wlPosts(), [['aa:bb:cc'], ['aa:bb:cc', 'aa:bb:dd']], '第二次保存基于第一次落盘后的最新名单')
  assert.equal(rmBtns().length, 2, '界面两个 chip 都在')

  // 3b：白名单读取失败 → 禁用增删 + err 点，不当成空名单
  RESPONSES['/dsh-feiyu/api/config'].config.esp32 = { allowDevices: ['aa:bb:ee'] }
  let cfgGets = 0
  globalThis.fetch = async (url, init) => {
    if (url === '/dsh-feiyu/api/config' && !(init && init.method === 'POST')) {
      cfgGets++
      if (cfgGets > 1) return { ok: false, status: 500, text: async () => JSON.stringify({ ok: false, error: 'boom' }) }
    }
    return origFetch(url, init)
  }
  await resetAll()
  assert.ok(alInput().props.disabled, '白名单没读到：输入框禁用')
  assert.ok(addBtn().props.disabled, '白名单没读到：「＋」禁用')
  assert.ok(joinBtns().length > 0 && joinBtns().every((b) => b.props.disabled), '白名单没读到：「加入白名单」禁用')
  assert.ok(collect(byCls(esp(), 'fy-esp32-allow')[0], (n) => n.props.className === 'fy-dot-off').length === 1, '白名单读失败：err 点')
  fetchPosts.length = 0
  await joinBtns()[0].props.onClick()
  await addBtn().props.onClick()
  assert.equal(wlPosts().length, 0, '没读到之前点了也不保存（不会把空名单写回）')
  // 恢复后点 ESP32 卡头刷新 → 读到并解禁
  globalThis.fetch = origFetch
  await collect(byCls(esp(), 'fy-card-head')[0], (n) => n.props['aria-label'] === '刷新')[0].props.onClick()
  await settle(); await rerender()
  assert.ok(!alInput().props.disabled, '刷新后读到白名单：解禁')
  assert.equal(rmBtns().length, 1)

  // 3c：保存失败 → 输入框红边框，不写进 ESP32 状态读取失败文案，也不加前缀句子
  globalThis.fetch = async (url, init) => {
    if (url === '/dsh-feiyu/api/config' && init && init.method === 'POST' && String(init.body).includes('allowDevices')) {
      return { ok: false, status: 500, text: async () => JSON.stringify({ ok: false, error: 'disk full' }) }
    }
    return origFetch(url, init)
  }
  alInput().props.onChange({ target: { value: 'aa:bb:fe' } })
  await rerender()
  await addBtn().props.onClick()
  await rerender()
  globalThis.fetch = origFetch
  assert.ok(String(alInput().props.className).includes('fy-input-err'), '保存失败：输入框红边框')
  assert.ok(!allText(esp()).includes('ESP32 状态读取失败') && !allText(esp()).includes('白名单保存失败'), '保存失败不混进状态读取失败，也无前缀句')
  assert.equal(alInput().props.value, 'aa:bb:fe', '保存失败不清空输入')
  assert.equal(rmBtns().length, 1, '保存失败名单不变')
  alInput().props.onChange({ target: { value: 'aa:bb:f' } })
  await rerender()
  assert.ok(!String(alInput().props.className).includes('fy-input-err'), '继续输入后红边框消失')
  RESPONSES['/dsh-feiyu/api/config'].config.esp32 = JSON.parse(savedCfg)

  // 4：状态条刷新 + /status、/services 读失败的 err 点；status 没读到时演练|真发无选中
  const sbar = () => byCls(tree, 'fy-statusbar')[0]
  const savedStatus = RESPONSES['/dsh-feiyu/api/status']
  const savedSvc = RESPONSES['/dsh-feiyu/api/services']
  delete RESPONSES['/dsh-feiyu/api/status']
  delete RESPONSES['/dsh-feiyu/api/services']
  globalThis.setTimeout = (fn, ms) => origST(fn, ms > 500 ? 5 : ms)
  await resetAll()
  await settle(); await settle(); await rerender()
  assert.ok(byCls(sbar(), 'fy-seg-opt').every((n) => !hasCls(n, 'on')), 'status 未读到：演练|真发都不选中（真发不是红的）')
  const errDot = byCls(sbar(), 'fy-dot-off').find((n) => /读取失败/.test(n.props.title || ''))
  assert.ok(errDot && /运行状态读取失败/.test(errDot.props.title) && /服务读取失败/.test(errDot.props.title), '状态条 err 点的 title 带失败原因')
  assert.ok(!allText(tree).includes('点「刷新」'), '读失败提示不再提及不存在的按钮')
  // 刷新：重读 /status /services /connections，成功后 err 点消失、选中态出现
  RESPONSES['/dsh-feiyu/api/status'] = savedStatus
  RESPONSES['/dsh-feiyu/api/services'] = savedSvc
  fetchCalls = []
  const refreshBtn = collect(sbar(), (n) => n.props['aria-label'] === '刷新')[0]
  assert.ok(refreshBtn, '状态条右端有「刷新」图标按钮')
  await refreshBtn.props.onClick()
  await settle(); await rerender()
  for (const u of ['/dsh-feiyu/api/status', '/dsh-feiyu/api/services', '/dsh-feiyu/api/connections']) assert.ok(fetchCalls.includes(u), '刷新应重读 ' + u)
  assert.ok(!byCls(sbar(), 'fy-dot-off').some((n) => /读取失败/.test(n.props.title || '')), '刷新成功后 err 点消失')
  assert.ok(hasCls(byCls(sbar(), 'fy-seg-opt')[1], 'on'), 'status 读到后：dryRun=false → 真发选中')
  assert.ok(collect(byCls(esp(), 'fy-card-head')[0], (n) => n.props['aria-label'] === '刷新').length === 1, 'ESP32 卡头有刷新图标')
  globalThis.setTimeout = origST

  // 5：/connections 没读到 → 状态条与卡头全灰点，不是红点「网关未启动 / 未运行」
  const savedConn = RESPONSES['/dsh-feiyu/api/connections']
  delete RESPONSES['/dsh-feiyu/api/connections']
  await resetAll()
  assert.deepEqual(byCls(sbar(), 'fy-sb-dot').map((n) => n.children[0].props.className), Array(5).fill('fy-dot-idle'), '未加载：状态条 5 点全灰')
  for (const id of ['fy-ch-bili', 'fy-ch-douyin', 'fy-qq', 'fy-wechat']) {
    assert.ok(byCls(byCls(byId(tree, id), 'fy-card-title')[0], 'fy-dot-idle').length === 1, id + ' 卡头灰点')
  }
  assert.ok(!allText(tree).includes('网关未启动') && !allText(tree).includes('未运行'), '未加载时不显示「网关未启动 / 未运行」')
  assert.equal(CT.deriveConnections({}).filter((x) => x.state === 'unknown').length, 5, '空对象 = 全 unknown')
  assert.equal(CT.deriveConnections({ qq: {}, wechat: { alive: false } }).filter((x) => x.id === 'qq' || x.id === 'wechat').map((x) => x.state).join(), 'off,off', '已加载的 qq/wechat 仍可为 off')
  if (savedConn) RESPONSES['/dsh-feiyu/api/connections'] = savedConn

  // 6：QQ 最小间隔输 0 → 落盘 150，draft/输入框同步成 150
  await resetAll()
  const qqNums = () => inputsOf(byId(tree, 'fy-qq')).filter((n) => n.props.type === 'number')
  fetchPosts.length = 0
  qqNums()[1].props.onChange({ target: { value: '0' } })
  await rerender()
  await qqNums()[1].props.onBlur()
  await rerender()
  const gapPost = fetchPosts.find((p) => String(p.body).includes('minGapMin'))
  assert.deepEqual(JSON.parse(gapPost.body), { qq: { proactive: { minGapMin: 150 } } }, '输入 0 保存 150')
  assert.equal(String(qqNums()[1].props.value), '150', '输入框显示与落盘值一致（150，不是 0）')

  // 7：无障碍 —— 开关 aria-label 是可读中文标签（键名走 data-key），「不限」带所属标签，StatusDot 有 title/aria-label
  const sws = collect(tree, (n) => n.type === 'button' && n.props.role === 'switch')
  assert.ok(sws.length >= 39)
  const readable = (n) => /[一-龥]/.test(n.props['aria-label'] || '') || n.props['aria-label'] === 'QQ'
  assert.ok(sws.every(readable), '所有开关 aria-label 可读：' + sws.filter((n) => !readable(n)).map((n) => n.props['aria-label']))
  assert.ok(sws.every((n) => !/^[a-z][A-Za-z]+$/.test(n.props['aria-label'] || '')), '不得是 draft 键名')
  const qqSw = collect(byId(tree, 'fy-qq'), (n) => n.type === 'button' && n.props.role === 'switch')
  assert.deepEqual(qqSw.map((n) => n.props['aria-label']), ['QQ', 'QQ 主动搭话', '每日上限 不限'])
  assert.equal(qqSw[1].props['data-key'], 'qqProactive')
  assert.ok(sws.filter((n) => /不限/.test(n.props['aria-label'])).every((n) => n.props['aria-label'] !== '不限'), '「不限」开关带所属标签')
  const dots = collect(tree, (n) => /^fy-dot-(ok|warn|off|idle)$/.test(String(n.props.className || '')))
  assert.ok(dots.length > 0 && dots.every((n) => n.props.title && n.props['aria-label'] && n.props.role === 'img'), '每个 StatusDot 都有 title + aria-label')
  const css = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  assert.ok(/select\.fy-input\{[^}]*min-width:0[^}]*max-width:100%/.test(css), '下拉框窄屏 min-width:0;max-width:100%')
  assert.ok(!/\.fy-field\{flex-wrap:nowrap\}/.test(css), '.fy-field 允许换行')
}

console.log('client-render ✓  渲染通过：状态条 + 5 通道卡（卡头平台开关/动作）· 通用区 · 自由度区 · 大脑（LLM）卡片 · ESP32 卡片（正常态 + 空状态）· 连接状态（4 夹具 + 降级 + 登录状态机）· 请求', fetchCalls.length, '次')
