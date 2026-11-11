/**
 * client.js 冒烟测试 —— 不需要 DSH 起前端，也能验证：
 *   1. 文件能被 __ModuleLoader__ 正常装载；
 *   2. 导出了 name / inject / apply；
 *   3. apply 注册的槽位是 settings.section（id、label、组件都对）；
 *   4. 组件第一次渲染（loading 态）不抛错。
 *
 * 跑法：node test/client-smoke.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(root, 'client.js')

// —— 极简 React：能建树、能跑 hooks、能展开函数组件（ESP32 卡片是子组件）——
function createElement(type, props, ...children) {
  const flat = []
  for (const c of children.flat(Infinity)) flat.push(c)
  const merged = Object.assign({}, props || {})
  if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
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
    effects[i] = { deps, cleanup: fn() }
  },
  useCallback(fn, deps) {
    const i = hookIndex++
    const prev = state[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (changed) state[i] = { deps, fn }
    return state[i].fn
  },
  useRef: (v) => ({ current: v }),
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, remove() {} }),
}
// 假后端：只给 ESP32 状态/日志，其余 404（冒烟测试不关心）
const ESP32_STATUS = {
  ok: true, enabled: true, running: true,
  address: { address: '192.168.1.20', port: 8765 }, publicHost: '192.168.1.20',
  otaUrl: 'http://192.168.1.20:8765/xiaozhi/ota/', tokenSet: true, asrAvailable: true,
  devices: [{ deviceId: 'aa:bb:cc', sessionId: 's1', state: 'listening', lastSeenAt: Date.now() }],
  lastError: null,
}
globalThis.fetch = async (url) => {
  if (url === '/dsh-feiyu/api/config') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, config: {}, voices: [], configPath: 'x' }) }
  if (url === '/dsh-feiyu/api/esp32/status') return { ok: true, status: 200, text: async () => JSON.stringify(ESP32_STATUS) }
  if (url.startsWith('/dsh-feiyu/api/esp32/log')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rows: [] }) }
  return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: 'no fixture: ' + url }) }
}

require(clientPath)

assert.ok(loaded, 'client.js 没有调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-feiyu', '模块 id 必须是包名 dsh-feiyu')

const mod = loaded.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('未预期的 require：' + name)
})

assert.equal(mod.name, 'dsh-feiyu')
assert.deepEqual(mod.inject, ['slots'], 'inject 只要 slots（不要再加不存在的服务）')
assert.equal(typeof mod.apply, 'function')

// —— 模拟 ctx.slots ——
const registered = []
const ctx = {
  slots: {
    inject(slotName, fn) {
      assert.equal(slotName, 'settings.section')
      return fn()
    },
    register(spec, Component) {
      registered.push({ spec, Component })
      return () => {}
    },
  },
}

mod.apply(ctx)
assert.equal(registered.length, 1, '应该只注册一个槽位')

const { spec, Component } = registered[0]
assert.equal(spec.name, 'settings.section')
assert.equal(spec.id, 'dsh-feiyu', '二建插件的槽位 id 必须全局唯一')
assert.equal(typeof spec.label, 'function')
assert.equal(spec.label(), '大肥鱼')
assert.equal(typeof spec.order, 'number')

// —— 首次渲染（loading 态，不发请求）——
const firstTree = Component({ close: () => {} })
assert.ok(firstTree && firstTree.type === 'div', '首渲染应返回一个 div')
assert.ok(JSON.stringify(firstTree).includes('读取大肥鱼配置'), '首渲染应显示读取提示')

// —— 渲染到稳定（假 fetch 只喂 ESP32 状态/日志；/config 404 → 面板停在错误态，
//    但 ESP32 卡片是独立子组件，仍应完整渲染）——
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

// —— ESP32 卡片（T24）：卡片存在 + 关键字段渲染出来 ——
const collect = (node, predicate, acc = []) => {
  if (!node || typeof node !== 'object') return acc
  if (node.props && predicate(node)) acc.push(node)
  for (const k of node.children || []) collect(k, predicate, acc)
  return acc
}
const cards = collect(tree, (n) => n.props.className === 'fy-card')
const esp32Card = cards.find((c) => JSON.stringify(c).includes('小智 ESP32 通道'))
assert.ok(esp32Card, 'ESP32 卡片应渲染出来')
const esp32Text = JSON.stringify(esp32Card)
for (const must of ['小智 ESP32 通道', 'OTA URL', '在线设备', '最近对话', 'Token', 'ASR', '已配置']) {
  assert.ok(esp32Text.includes(must), 'ESP32 卡片缺少关键字段：' + must)
}
// 设备列表容器 + 设备行
assert.equal(collect(esp32Card, (n) => n.props.className === 'fy-dev-list').length, 1, '设备列表容器应存在')
assert.ok(esp32Text.includes('aa:bb:cc'), '设备列表应渲染 deviceId')
assert.ok(esp32Text.includes('http://192.168.1.20:8765/xiaozhi/ota/'), 'OTA URL 应渲染')
// token 明文绝不出现（状态接口只给 tokenSet 布尔值）
assert.ok(!esp32Text.includes('"tok"') && !esp32Text.includes('>tok<'), 'ESP32 卡片不应包含 token 明文')

// —— 包清单契约：dsh-client-modules 只认 exports["./client"] + dsh.client ——
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.ok(pkg.dsh && pkg.dsh.client, 'package.json 必须声明 dsh.client，否则宿主不会去装浏览器半边')
assert.equal(typeof pkg.exports['./client'], 'string', 'exports["./client"] 必须是字符串路径')
const clientOnDisk = path.resolve(root, pkg.exports['./client'])
assert.ok(fs.existsSync(clientOnDisk), 'exports["./client"] 指向的文件必须存在：' + clientOnDisk)
assert.equal(clientOnDisk, clientPath, 'exports["./client"] 应指向仓库根的 client.js')
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 必须是数组')

console.log('client-smoke ✓  槽位已注册：', spec.name, '/', spec.id, 'order=', spec.order)

