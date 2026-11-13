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
for (const must of ['ESP32 通道未启用', '未配置', '通道未启用，暂无设备', '还没有对话记录']) {
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

// ── 连接中心（T4）：以 test/fixtures/connections.json 四种状态为准 ─────────────
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

// loggedOut：全部「未检测/未登录」，有二维码图，有扫码登录按钮
let ct = await renderConn(FX.loggedOut)
let ctext = allText(ct)
for (const must of ['连接中心', '未检测（还没填 cookie）', '网关未启动', '未运行', '重新检测', '扫码登录', '刷新二维码', '保存 cookie']) {
  assert.ok(ctext.includes(must), '连接中心(loggedOut)缺少：' + must)
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
const saveCk = collect(tree, (n) => n.type === 'button').find((n) => (n.children || []).includes('保存 cookie'))
await saveCk.props.onClick()
await rerender()
const ckPost = fetchPosts.find((p) => p.url === '/dsh-feiyu/api/cookie')
assert.ok(ckPost && JSON.parse(ckPost.body).sessdata === 'sess-SECRET', '应 POST /cookie')
assert.ok(ckInputs(tree).every((n) => n.props.value === ''), '提交后 cookie 输入应清空')
assert.ok(!JSON.stringify(tree).includes('SECRET'), 'cookie 不得留在渲染树')

// 重新检测：POST /connections/check {target}
const recheckQq = collect(tree, (n) => n.type === 'button' && (n.children || []).includes('重新检测'))[2]
await recheckQq.props.onClick()
assert.deepEqual(JSON.parse(fetchPosts.find((p) => p.url.endsWith('/connections/check')).body), { target: 'qq' })

// loggedIn
ct = await renderConn(FX.loggedIn)
ctext = allText(ct)
for (const must of ['已登录：测试用户（123456）', '已登录：抖音测试', '已登录：机器人（10001）', '运行中']) {
  assert.ok(ctext.includes(must), '连接中心(loggedIn)缺少：' + must)
}
assert.equal(collect(ct, (n) => n.type === 'img').length, 0, '无二维码时不渲染 img')

// probeFailed：错误原因可见，二维码过期提示
ct = await renderConn(FX.probeFailed)
ctext = allText(ct)
for (const must of ['nav: -101 账号未登录', 'self-info 超时', '二维码已过期', '登录失败：Chrome 未能启动', 'get_login_info 超时']) {
  assert.ok(ctext.includes(must), '连接中心(probeFailed)缺少：' + must)
}

// douyinWaiting：等待提示 + 取消按钮
ct = await renderConn(FX.douyinWaiting)
ctext = allText(ct)
assert.ok(ctext.includes('请在弹出的 Chrome 里扫码，剩余 150 秒'), '应显示扫码倒计时')
assert.ok(btnsOf(ct).includes('取消') && !btnsOf(ct).includes('扫码登录'), '等待中应显示取消而非扫码登录')

// 后端未提供（404）→ 降级提示，不崩
delete RESPONSES['/dsh-feiyu/api/connections']
state.length = 0
effects.length = 0
await rerender()
assert.ok(allText(tree).includes('后端未提供，请重启 DSH'), '404 应降级提示')
assert.ok(!JSON.stringify(tree).includes('载入失败'), '连接中心 404 不得拖垮整页')

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

// ── T5：分组折叠 + 主动搭话迁移 + 状态 chip 读 /connections ────────────────────
{
  const gt = await renderConn(FX.loggedIn)
  const groups = collect(gt, (n) => n.props.className === 'fy-group')
  const heads = collect(gt, (n) => n.type === 'button' && String(n.props.className || '') === 'fy-group-head').map((n) => (n.children || []).join(''))
  assert.ok(heads.some((x) => x.includes('基础') && x.startsWith('▾')), '基础默认展开')
  assert.ok(heads.some((x) => x.includes('平台') && x.startsWith('▾')), '平台默认展开')
  assert.ok(heads.some((x) => x.includes('高级') && x.startsWith('▸')), '高级默认折叠')
  assert.equal(collect(gt, (n) => String(n.props.className || '').includes('fy-switch')).length, 31, '折叠不影响开关总数')
  assert.ok(allText(groups.find((g) => allText(g).includes('平台') && allText(g).includes('微信'))).includes('QQ 主动搭话'), '主动搭话应在平台组')
  assert.ok(!allText(groups.find((g) => allText(g).includes('当前音色'))).includes('主动搭话') || allText(groups.find((g) => allText(g).includes('当前音色'))).indexOf('QQ 主动搭话') === -1, '主动搭话不应在音色卡')
  assert.ok(!allText(gt).includes('NapCat\\cache'), '不再写死二维码路径')
  delete RESPONSES['/dsh-feiyu/api/connections']
  state.length = 0
  effects.length = 0
  await rerender()
  const noConn = allText(tree)
  assert.ok(noConn.includes('未检测') && !noConn.includes('已接入'), '拿不到 /connections 时显示未检测')
}

console.log('client-render ✓  渲染通过：9 个区块 · 4 个平台开关 · 大脑（LLM）卡片 · ESP32 卡片（正常态 + 空状态）· 连接中心（4 夹具 + 降级 + 登录状态机）· 请求', fetchCalls.length, '次')
