/**
 * T4 字段保真：B站卡 / 抖音卡 重排前后，读写的 draft 键、save 路径、服务回调集合必须一致。
 *
 * 做法：不靠正则读源码，而是"行为比对"——把重排前的 DouyinCard / BiliCard（冻结副本
 * test/fixtures/client-old-cards.txt，= 171d079）和现版一起用同一套驱动跑一遍：
 *   渲染期读取的 draft 键 / setDraft 写入的键 / save(...) 的叶子路径 / restartService·toggleFreeRoam·startWatch 回调，
 * 再逐集合比较。另断言：现版卡片代码里不再出现 fy-hint / fy-sw-desc / fy-sub / 卡片级 hint，toDraft 键数仍为 60。
 *
 * 跑法：node test/client-bili-douyin.mjs
 * （未登记到 package.json / tools/run-tests.mjs，由 Lead 统一登记）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(root, 'client.js')
const src = fs.readFileSync(clientPath, 'utf8')

// ── 极小 React（同 client-primitives.mjs）────────────────────────────────
const Fragment = Symbol.for('fragment')
function createElement(type, props, ...children) {
  const flat = []
  for (const c of children.flat(Infinity)) flat.push(c)
  const merged = Object.assign({}, props || {})
  if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
  if (typeof type === 'function') return type(merged)
  return { type, props: merged, children: flat }
}
const state = []
let hookIndex = 0
const reactStub = {
  createElement, Fragment,
  useState(init) {
    const i = hookIndex++
    if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
    return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
  },
  useEffect() { hookIndex++ },
  useCallback(fn) { hookIndex++; return fn },
  useRef(v) { const i = hookIndex++; if (!(i in state)) state[i] = { current: v }; return state[i] },
}
const resetHooks = () => { state.length = 0; hookIndex = 0 }
const render = (fn) => { hookIndex = 0; return fn() }

globalThis.window = { __ModuleLoader__: { load(spec) { globalThis.__spec = spec } } }
globalThis.document = { head: { appendChild() {} }, getElementById: () => null, createElement: () => ({ dataset: {}, textContent: '', remove() {} }) }
require(clientPath)
const mod = globalThis.__spec.factory((n) => { if (n === 'react') return reactStub; throw new Error('未预期的 require：' + n) })
const P = mod.__test
assert.equal(typeof P.DouyinCard, 'function', 'exports.__test 应暴露 DouyinCard')
assert.equal(typeof P.BiliCard, 'function', 'exports.__test 应暴露 BiliCard')

// ── 旧版卡片：用冻结副本 + 最小旧原语桩求值 ───────────────────────────────
const oldSrc = fs.readFileSync(path.join(root, 'test', 'fixtures', 'client-old-cards.txt'), 'utf8')
const Card = (p) => createElement('section', { className: 'fy-card' }, p.title, p.children, p.hint ? createElement('div', { className: 'fy-hint' }, p.hint) : null)
const Row = (p) => createElement('div', { className: 'fy-row' }, p.label, p.children)
const Switch = (p) => createElement('button', { role: 'switch', 'aria-label': p.label, onClick: () => p.onChange(!p.on) })
const Group = (p) => createElement('div', { className: 'fy-group' }, p.title, p.children)   // 折叠组：全部展开
const OLD = new Function('h', 'react', 'Card', 'Row', 'Switch', 'Group', oldSrc + '\nreturn { DouyinCard, BiliCard };')(createElement, reactStub, Card, Row, Switch, Group)

// ── 树工具 ────────────────────────────────────────────────────────────────
const classes = (n) => String((n && n.props && n.props.className) || '').split(/\s+/).filter(Boolean)
const collect = (node, pred, acc = []) => {
  if (!node || typeof node !== 'object') return acc
  if (node.props && pred(node)) acc.push(node)
  for (const k of node.children || []) collect(k, pred, acc)
  return acc
}
const texts = (node, acc = []) => {
  if (node == null || node === false) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  for (const k of node.children || []) texts(k, acc)
  return acc
}
const switchesOf = (t) => collect(t, (n) => n.type === 'button' && n.props.role === 'switch')
const inputsOf = (t) => collect(t, (n) => n.type === 'input')
const buttonsOf = (t) => collect(t, (n) => n.type === 'button' && n.props.role !== 'switch')
const leaves = (o, pre = []) => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, [...pre, k]) : [[...pre, k].join('.')]))
const uniq = (a) => [...new Set(a)].sort()

// ── 驱动：渲染 + 触发全部开关 / 输入框 / 按钮，记录读写集合 ────────────────
async function drive(Comp, fill, extra = {}) {
  const reads = new Set(), setKeys = new Set(), paths = [], calls = []
  const store = {}
  let recording = false
  const draft = new Proxy(store, {
    get(t, k) { if (typeof k !== 'string') return undefined; if (recording) reads.add(k); return k in t ? t[k] : fill },
  })
  const props = Object.assign({
    draft,
    setDraft: (d) => { for (const k of Object.keys(d)) { setKeys.add(k); store[k] = d[k] } },
    save: async (patch) => { paths.push(...leaves(patch)); return true },
    busy: '',
    startWatch: () => calls.push('startWatch'),
    startBiliWatch: () => calls.push('startBiliWatch'),
    restartService: (n, a) => calls.push('restart:' + n + ':' + a),
    toggleFreeRoam: (n, v) => calls.push('freeRoam:' + n + ':' + v),
  }, extra)
  const r = () => { recording = true; try { return render(() => createElement(Comp, props)) } finally { recording = false } }
  resetHooks()
  const first = r()
  const nSw = switchesOf(first).length, nIn = inputsOf(first).length, nBtn = buttonsOf(first).length
  for (let i = 0; i < nSw; i++) await switchesOf(r())[i].props.onClick()
  for (let i = 0; i < nIn; i++) {
    inputsOf(r())[i].props.onChange({ target: { value: '7' } })
    await inputsOf(r())[i].props.onBlur()
  }
  for (let i = 0; i < nBtn; i++) await buttonsOf(r())[i].props.onClick()
  return { reads: [...reads], setKeys: [...setKeys], paths, calls, tree: first }
}

const norm = (rs) => ({
  reads: uniq(rs.flatMap((x) => x.reads)),
  setKeys: uniq(rs.flatMap((x) => x.setKeys)),
  paths: uniq(rs.flatMap((x) => x.paths)),
  calls: uniq(rs.flatMap((x) => x.calls)),
})

for (const name of ['DouyinCard', 'BiliCard']) {
  // fill=3：开关全为 on；fill=0：全为 off / 数值 0（覆盖"不限"开关两个方向）
  const o = norm([await drive(OLD[name], 3), await drive(OLD[name], 0)])
  const n = norm([await drive(P[name], 3), await drive(P[name], 0)])
  assert.ok(o.paths.length >= 8, name + '：旧版 save 路径应有若干条：' + o.paths.length)
  assert.deepEqual(n.reads, o.reads, name + '：渲染期读取的 draft 键集合应与旧版一致')
  assert.deepEqual(n.setKeys, o.setKeys, name + '：setDraft 写入的键集合应与旧版一致')
  assert.deepEqual(n.paths, o.paths, name + '：save 路径集合应与旧版一致')
  assert.deepEqual(n.calls, o.calls, name + '：服务回调（启停/刷视频）应与旧版一致')
  console.log(`${name} ✓ reads=${n.reads.length} setKeys=${n.setKeys.length} savePaths=${n.paths.length} calls=${n.calls.length}`)
}

// ── 新版结构断言 ──────────────────────────────────────────────────────────
{
  const sec = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, '找不到段 ' + a); return src.slice(i, j) }
  const code = sec('// ===== FreeBrowse =====', '// ── 连接中心') + sec('// ===== QuotaRow', '// ===== FeiyuSection =====')
  assert.ok(!/fy-hint|fy-sw-desc|fy-sub|hint:/.test(code), 'B站/抖音卡与 FreeBrowse 代码里不应再有 fy-hint / fy-sw-desc / fy-sub / 卡片级 hint')
  assert.ok(!/0\s*=\s*不限/.test(code), '"0 = 不限" 句子应全部删除')

  // toDraft 键集合不变：60 个
  const td = src.slice(src.indexOf('const toDraft = (c) => {'), src.indexOf('// proactive 保存'))
  assert.equal([...td.matchAll(/^\s+(\w+): /gm)].length, 60, 'toDraft 键数应仍为 60')

  const full = { dykDanmaku: true, dykDyn: true, dykLike: false, dykCoin: true, dykImg: false, dykReplies: false, dykFish: false, dykFollow: true }
  const mk = (extra) => ({ draft: Object.assign({ shareOn: true, shareMinScore: 13, shareDaily: 3, douyinAt: false, douyinCount: 2, douyinShareDaily: 5 }, full, extra), setDraft() {}, save() {}, busy: '' })
  const biliTree = render(() => createElement(P.BiliCard, Object.assign(mk(), { state: 'ok', action: createElement('button', { className: 'act' }, '扫码登录') })))
  const cls = (t, c) => collect(t, (x) => classes(x).includes(c))
  assert.equal(cls(biliTree, 'fy-channel').length, 1, 'B站卡是 ChannelCard')
  assert.equal(cls(biliTree, 'act').length, 1, 'action 槽原样渲染')
  assert.equal(cls(biliTree, 'fy-dot-ok').length, 1, 'state=ok → StatusDot')
  assert.equal(cls(biliTree, 'fy-zone').length, 1, '活人感是 DangerZone')
  assert.equal(cls(biliTree, 'fy-zone-summary')[0].children.join(''), '已开 4/8', '活人感组头计数 = draft 里开着的开关数 / 总数')
  assert.equal(cls(biliTree, 'fy-hint').length + cls(biliTree, 'fy-sub').length + cls(biliTree, 'fy-sw-desc').length, 0, 'B站卡无灰字说明')
  assert.equal(cls(biliTree, 'fy-group').filter((x) => classes(x).includes('sub')).length, 1, '自由刷子组与活人感并列（自由刷 = Group sub，活人感 = DangerZone）')
  const dangerOn = collect(biliTree, (x) => x.type === 'button' && classes(x).includes('fy-danger'))
  assert.deepEqual(dangerOn.map((x) => x.props['aria-label']), ['dykCoin'], '投币是唯一危险开关')

  const dyTree = render(() => createElement(P.DouyinCard, mk({ douyinAt: true })))
  assert.equal(cls(dyTree, 'fy-channel').length, 1, '抖音卡是 ChannelCard')
  assert.equal(cls(dyTree, 'fy-dot-off').length, 1, 'state 缺省 → off')
  assert.deepEqual(collect(dyTree, (x) => x.type === 'button' && classes(x).includes('fy-danger')).map((x) => x.props['aria-label']), ['douyinAt'], '评论 @ 是危险开关')
  assert.equal(cls(dyTree, 'fy-zone-summary')[0].children.join(''), '已开 1/1')
  assert.equal(cls(dyTree, 'fy-hint').length + cls(dyTree, 'fy-sub').length + cls(dyTree, 'fy-sw-desc').length, 0, '抖音卡无灰字说明')
  assert.ok(!texts(dyTree).some((t) => /0\s*=\s*不限/.test(t)), '抖音卡无 "0 = 不限" 句子')
}

console.log('client-bili-douyin ✓  B站/抖音卡：读写键 / save 路径 / 回调集合与重排前一致；无灰字说明；活人感计数；危险开关')
