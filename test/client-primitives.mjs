/**
 * client.js UI 原语测试（T2）—— Field / NumberField / Toggle / Segmented / StatusDot /
 * ChannelCard / DangerZone / FreeBrowse / useSave / normNum。
 *
 * 极小 hooks 运行时（同 client-render.mjs 风格），函数组件就地展开，不依赖 react-dom。
 * 跑法：node test/client-primitives.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(root, 'client.js')

// ── 极小 React ────────────────────────────────────────────────────────────
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
const effects = []
let hookIndex = 0
const reactStub = {
  createElement,
  Fragment,
  useState(init) {
    const i = hookIndex++
    if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
    return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
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
  useRef(v) { const i = hookIndex++; if (!(i in state)) state[i] = { current: v }; return state[i] },
}
const resetHooks = () => { state.length = 0; effects.length = 0; hookIndex = 0 }
const render = (fn) => { hookIndex = 0; return fn() }   // 同一组 state 上重渲染

// ── 环境桩 + 装载 ─────────────────────────────────────────────────────────
globalThis.window = { __ModuleLoader__: { load(spec) { globalThis.__spec = spec } } }
globalThis.document = {
  head: { appendChild() {} }, getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
}
require(clientPath)
const mod = globalThis.__spec.factory((n) => {
  if (n === 'react') return reactStub
  throw new Error('未预期的 require：' + n)
})
const P = mod.__test
for (const k of ['normNum', 'Field', 'NumberField', 'Toggle', 'Segmented', 'StatusDot', 'ChannelCard', 'DangerZone', 'FreeBrowse', 'useSave']) {
  assert.equal(typeof P[k], 'function', 'exports.__test 应暴露 ' + k)
}

// ── 树工具 ────────────────────────────────────────────────────────────────
const classes = (n) => String((n && n.props && n.props.className) || '').split(/\s+/).filter(Boolean)
const collect = (node, pred, acc = []) => {
  if (!node || typeof node !== 'object') return acc
  if (node.props && pred(node)) acc.push(node)
  for (const k of node.children || []) collect(k, pred, acc)
  return acc
}
const byClass = (node, c) => collect(node, (n) => classes(n).includes(c))
const texts = (node, acc = []) => {
  if (node == null || node === false) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  for (const k of node.children || []) texts(k, acc)
  return acc
}

// ── normNum ───────────────────────────────────────────────────────────────
{
  const n = P.normNum
  assert.equal(n('', 5), 5, '空串 → 默认')
  assert.equal(n('   ', 5), 5, '空白 → 默认')
  assert.equal(n(undefined, 2), 2, 'undefined 视作空')
  assert.equal(n(null, 2), 2, 'null 视作空')
  assert.equal(n('', undefined), 0, '默认缺省为 0')
  assert.equal(n('0', 5), 0, '"0" 是 0 不是空')
  assert.equal(n('12', 5), 12)
  assert.equal(n(' 7.5 ', 5), 7.5)
  assert.equal(n('-3', 5), 0, '负数夹到 0')
  assert.equal(n('abc', 5), 0, '非数字 → 0（沿用旧语义，不是默认）')
  assert.equal(n(NaN, 5), 0)
  assert.equal(n(3, 5), 3, '数字入参')
}

// ── Field ─────────────────────────────────────────────────────────────────
{
  const t = render(() => createElement(P.Field, { label: '条数', suffix: '条/天' }, createElement('input', { className: 'ctl' })))
  assert.ok(classes(t).includes('fy-row') && classes(t).includes('fy-field'))
  const kids = t.children
  assert.equal(classes(kids[0]).join(), 'fy-label')
  assert.equal(kids[1].type, 'input')
  assert.equal(classes(kids[2]).join(), 'fy-suffix', '后缀紧跟控件，在同一行里，类 fy-suffix')
  assert.equal(kids[2].type, 'span')
  assert.ok(!classes(kids[2]).includes('fy-hint'), '后缀不是灰色说明段')
  const t2 = render(() => createElement(P.Field, { label: 'x' }, createElement('input')))
  assert.equal(byClass(t2, 'fy-suffix').length, 0, '无 suffix 不渲染后缀')
}

// ── Toggle ────────────────────────────────────────────────────────────────
{
  let got = null
  const on = render(() => createElement(P.Toggle, { label: 'a', on: true, onChange: (v) => { got = v } }))
  assert.deepEqual(classes(on), ['fy-switch', 'on'])
  assert.equal(on.props['aria-checked'], 'true')
  on.props.onClick()
  assert.equal(got, false, '点击取反')
  const off = render(() => createElement(P.Toggle, { label: 'a', on: false, onChange() {} }))
  assert.deepEqual(classes(off), ['fy-switch'])
  const dg = render(() => createElement(P.Toggle, { label: 'a', on: true, danger: true, onChange() {} }))
  assert.deepEqual(classes(dg), ['fy-switch', 'on', 'fy-danger'])
}

// ── NumberField ───────────────────────────────────────────────────────────
{
  resetHooks()
  let unl = null
  const commits = []
  const props = (over) => Object.assign({
    label: '最大条数', value: 5, suffix: '条', unlimited: false,
    onUnlimited: (v) => { unl = v }, onCommit: (v) => commits.push(v), min: 0, max: 50,
  }, over)
  let t = render(() => createElement(P.NumberField, props()))
  const input = () => collect(t, (n) => n.type === 'input')[0]
  assert.equal(input().props.disabled, false)
  assert.equal(input().props.value, 5)
  assert.equal(byClass(t, 'fy-suffix')[0].children[0], '条', '单位后缀在同一行')
  const sw = collect(t, (n) => n.type === 'button' && n.props['aria-label'] === '不限')
  assert.equal(sw.length, 1, '同行有"不限"小开关')
  sw[0].props.onClick()
  assert.equal(unl, true)
  // 本地缓冲 + 失焦归一化提交
  input().props.onChange({ target: { value: '99' } })
  t = render(() => createElement(P.NumberField, props()))
  assert.equal(input().props.value, '99', '输入中显示缓冲值')
  assert.equal(commits.length, 0, '未失焦不提交')
  input().props.onBlur()
  assert.deepEqual(commits, [50], '失焦提交，并夹到 max')
  t = render(() => createElement(P.NumberField, props()))
  assert.equal(input().props.value, 5, '提交后回到受控 value')
  input().props.onBlur()
  assert.equal(commits.length, 1, '没改过就不提交')
  input().props.onChange({ target: { value: 'abc' } })
  t = render(() => createElement(P.NumberField, props()))
  input().props.onBlur()
  assert.equal(commits[1], 0, '非数字 → 0')
  input().props.onChange({ target: { value: '' } })
  t = render(() => createElement(P.NumberField, props({ dflt: 3 })))
  input().props.onBlur()
  assert.equal(commits[2], 3, '空串 → dflt')
  // 不限开启 → 数值框 disabled
  t = render(() => createElement(P.NumberField, props({ unlimited: true })))
  assert.equal(input().props.disabled, true, '"不限"开启时数值框 disabled')
  assert.equal(collect(t, (n) => n.type === 'button' && n.props['aria-label'] === '不限')[0].props['aria-checked'], 'true')
  // 没传 onUnlimited → 无开关
  t = render(() => createElement(P.NumberField, props({ onUnlimited: undefined })))
  assert.equal(collect(t, (n) => n.type === 'button').length, 0)
}

// ── Segmented ─────────────────────────────────────────────────────────────
{
  let got = null
  const opts = [{ value: 'dry', label: '演练' }, { value: 'real', label: '真发', danger: true }]
  let t = render(() => createElement(P.Segmented, { options: opts, value: 'dry', onChange: (v) => { got = v } }))
  assert.ok(classes(t).includes('fy-seg'))
  let btns = collect(t, (n) => n.type === 'button')
  assert.equal(btns.length, 2)
  assert.deepEqual(classes(btns[0]), ['fy-seg-opt', 'on'])
  assert.deepEqual(classes(btns[1]), ['fy-seg-opt', 'danger'])
  assert.equal(btns[0].props['aria-checked'], 'true')
  btns[1].props.onClick()
  assert.equal(got, 'real')
  t = render(() => createElement(P.Segmented, { options: opts, value: 'real', onChange() {} }))
  btns = collect(t, (n) => n.type === 'button')
  assert.deepEqual(classes(btns[1]), ['fy-seg-opt', 'on', 'danger'], 'danger 选中 → .danger.on')
  assert.deepEqual(classes(btns[0]), ['fy-seg-opt'])
}

// ── StatusDot ─────────────────────────────────────────────────────────────
{
  for (const s of ['ok', 'warn', 'off']) {
    assert.deepEqual(classes(render(() => createElement(P.StatusDot, { state: s }))), ['fy-dot-' + s])
  }
  assert.deepEqual(classes(render(() => createElement(P.StatusDot, { state: 'weird' }))), ['fy-dot-off'])
  assert.ok(!classes(render(() => createElement(P.StatusDot, { state: 'ok' }))).includes('fy-dot'), '不复用旧 fy-dot')
}

// ── ChannelCard ───────────────────────────────────────────────────────────
{
  const action = createElement('button', { className: 'act' }, '登录')
  const t = render(() => createElement(P.ChannelCard, { id: 'ch-qq', title: 'QQ', state: 'warn', action }, createElement('div', { className: 'body' }, 'x')))
  assert.equal(t.type, 'section')
  assert.equal(t.props.id, 'ch-qq', 'root 带 id 供锚点')
  assert.deepEqual(classes(t), ['fy-card', 'fy-channel'])
  const head = byClass(t, 'fy-card-head')[0]
  assert.ok(head, '有卡头')
  assert.ok(texts(head).includes('QQ'))
  assert.equal(byClass(head, 'fy-dot-warn').length, 1, '卡头里有状态点')
  assert.equal(byClass(head, 'act').length, 1, '主动作在卡头')
  assert.equal(byClass(t, 'body').length, 1)
  assert.equal(byClass(t, 'fy-hint').length, 0, '无 hint 槽')
  assert.equal(byClass(t, 'fy-card-act').length, 0, '没有 toggle 时 action 不包裹')
  // T7：启用开关槽 —— 卡头右侧 = toggle + action（同一个 fy-card-act 容器，toggle 在前）
  const toggle = createElement('button', { className: 'tg', role: 'switch' })
  const t2 = render(() => createElement(P.ChannelCard, { id: 'ch-bili', title: 'B站', state: 'ok', toggle, action }, createElement('div', { className: 'body' }, 'x')))
  const act = byClass(byClass(t2, 'fy-card-head')[0], 'fy-card-act')[0]
  assert.ok(act, 'toggle 存在时卡头右侧有 fy-card-act 容器')
  assert.deepEqual(act.children.map((c) => c.props.className), ['tg', 'act'], 'toggle 在 action 之前')
  assert.equal(byClass(byClass(t2, 'fy-card-head')[0], 'fy-card-title')[0].children.some((c) => c && c.props && c.props.className === 'tg'), false, 'toggle 不在标题块里')
}

// ── DangerZone ────────────────────────────────────────────────────────────
{
  resetHooks()
  let t = render(() => createElement(P.DangerZone, { title: '高危', summary: '已开 2 项' }, createElement('i', null, 'inner')))
  assert.ok(classes(t).includes('fy-zone'))
  assert.ok(texts(byClass(t, 'fy-zone-head')[0]).includes('已开 2 项'), '折叠头显示 summary')
  assert.equal(byClass(t, 'fy-zone-head')[0].props['aria-expanded'], 'false')
  assert.equal(byClass(t, 'fy-zone-body')[0].props.style.display, 'none', '默认折叠')
  assert.equal(texts(byClass(t, 'fy-zone-body')[0]).join(''), 'inner', '折叠时内容仍挂在树里')
  byClass(t, 'fy-zone-head')[0].props.onClick()
  t = render(() => createElement(P.DangerZone, { title: '高危', summary: '已开 2 项' }, createElement('i', null, 'inner')))
  assert.equal(byClass(t, 'fy-zone-body')[0].props.style.display, 'flex', '点击展开')
  resetHooks()
  t = render(() => createElement(P.DangerZone, { title: '高危', defaultOpen: true }, 'x'))
  assert.equal(byClass(t, 'fy-zone-body')[0].props.style.display, 'flex', 'defaultOpen')
  assert.equal(byClass(t, 'fy-zone-summary').length, 0)
}

// ── useSave ───────────────────────────────────────────────────────────────
{
  resetHooks()
  const calls = []
  let timerFn = null
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { if (ms === 900) { timerFn = fn; return 1 } return realSetTimeout(fn, ms) }
  try {
    const save = async (patch, msg) => { calls.push([patch, msg]); return true }
    const useIt = () => P.useSave({ save }).commitProps('douyin.freeRoam.maxVideos', '条数已保存', { className: 'fy-input fy-w-sm', parse: (v) => Number(v) || 0 })
    let cp = render(useIt)
    assert.equal(cp.className, 'fy-input fy-w-sm')
    await cp.onBlur({ target: { value: '8' } })
    assert.deepEqual(calls, [[{ douyin: { freeRoam: { maxVideos: 8 } } }, '条数已保存']], 'onBlur 按路径生成嵌套补丁')
    cp = render(useIt)
    assert.ok(cp.className.split(' ').includes('fy-flash'), '保存成功后短暂加 fy-flash')
    assert.equal(typeof timerFn, 'function', '用 setTimeout 移除')
    timerFn()
    cp = render(useIt)
    assert.ok(!cp.className.includes('fy-flash'), '定时后移除 fy-flash')
    // 保存失败不闪
    resetHooks()
    const bad = () => P.useSave({ save: async () => false }).commitProps('a.b', 'm')
    cp = render(bad)
    await cp.onBlur({ target: { value: 'x' } })
    cp = render(bad)
    assert.ok(!cp.className.includes('fy-flash'), '保存失败不闪')
    // 不带"已保存"文字：commitProps 只返回 onBlur/className
    assert.deepEqual(Object.keys(cp).sort(), ['className', 'onBlur'])
  } finally { globalThis.setTimeout = realSetTimeout }
}

// ── FreeBrowse 与旧两处（DouyinCard / BiliCard 内的自由刷代码）字段集合一致 ────
{
  // 旧代码来自 T4 重排前的冻结副本（test/fixtures/client-old-cards.txt = 171d079 的 DouyinCard + BiliCard）
  const src = fs.readFileSync(path.join(root, 'test', 'fixtures', 'client-old-cards.txt'), 'utf8')
  const fnBody = (name) => {
    const a = src.indexOf('function ' + name + '(')
    assert.ok(a >= 0, '找不到旧组件 ' + name)
    const b = src.indexOf('// ===== ', a)
    return src.slice(a, b < 0 ? src.length : b)
  }
  const HEAD = '自由刷 · 大肥鱼自己逛'
  const oldSection = (name, endMark) => {
    const body = fnBody(name)
    const a = body.indexOf(HEAD)
    assert.ok(a >= 0, name + ' 里找不到自由刷段')
    const b = endMark ? body.indexOf(endMark, a + 1) : body.length
    return body.slice(a + HEAD.length + 1, b < 0 ? body.length : b)
  }
  const OLD = {
    douyin: oldSection('DouyinCard', null),
    bili: oldSection('BiliCard', 'title: "活人感'),
  }
  const CJK = /[一-鿿]/
  const literals = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((x) => CJK.test(x))
  const uniq = (a) => [...new Set(a)].sort()

  for (const platform of ['douyin', 'bili']) {
    const pre = platform
    const keys = ['FreeRoam', 'Unlimited', 'MaxVideos', 'MaxMinutes'].map((k) => pre + k)
    const old = OLD[platform]
    const oldRead = uniq([...old.matchAll(/draft\.(\w+)/g)].map((m) => m[1]))
    const oldWrite = uniq([...old.matchAll(/setDraft\(Object\.assign\(\{\}, draft, \{ (\w+):/g)].map((m) => m[1]))
    const oldPaths = uniq([...old.matchAll(/save\(\{ (\w+): \{ freeRoam: \{ (\w+):/g)].map((m) => m[1] + '.freeRoam.' + m[2]))
    const oldToggle = uniq([...old.matchAll(/toggleFreeRoam\("(\w+)", v\)/g)].map((m) => m[1]))
    const oldText = uniq(literals(old))
    assert.equal(oldRead.length, 4, '旧代码应读 4 个 draft 键：' + oldRead)

    // 新：Proxy 记录渲染期读取的 draft 键
    const reads = new Set()
    const base = { [keys[0]]: true, [keys[1]]: true, [keys[2]]: 3, [keys[3]]: 4, unrelated: 'x' }
    const draft = new Proxy(base, { get(t, k) { if (typeof k === 'string') reads.add(k); return t[k] } })
    const writes = new Set()
    const savedPaths = []
    const msgs = []
    const toggles = []
    const props = {
      platform, draft,
      setDraft: (d) => { for (const k of keys) if (d[k] !== base[k]) writes.add(k) },
      save: (patch, msg) => {
        let p = [], cur = patch
        while (cur && typeof cur === 'object') { const k = Object.keys(cur)[0]; p.push(k); cur = cur[k] }
        savedPaths.push(p.join('.')); msgs.push(msg)
      },
      toggleFreeRoam: (pl, v) => toggles.push(pl),
    }
    resetHooks()
    const t = render(() => createElement(P.FreeBrowse, props))
    const renderReads = [...reads].filter((k) => k !== 'unrelated').sort()
    // 触发所有处理器：开关各按两个方向，输入框 onChange + onBlur
    const switches = collect(t, (n) => n.type === 'button' && n.props.role === 'switch')
    assert.equal(switches.length, 2)
    const newText = texts(t).filter((x) => CJK.test(x))
    assert.deepEqual(switches.map((s) => s.props['aria-label']), [keys[0], keys[1]], '开关 aria-label = draft 键名（同旧代码）')
    for (const sw of switches) sw.props.onClick()   // on=true → onChange(false)
    base[keys[0]] = false; base[keys[1]] = false
    for (const sw of collect(render(() => createElement(P.FreeBrowse, props)), (n) => n.type === 'button' && n.props.role === 'switch')) sw.props.onClick()   // on=false → onChange(true)
    // 数值框（NumberField）本地缓冲：onChange 后需重渲染才能让 onBlur 看到输入值
    const nInputs = collect(t, (n) => n.type === 'input').length
    for (let i = 0; i < nInputs; i++) {
      collect(render(() => createElement(P.FreeBrowse, props)), (n) => n.type === 'input')[i].props.onChange({ target: { value: '7' } })
      collect(render(() => createElement(P.FreeBrowse, props)), (n) => n.type === 'input')[i].props.onBlur()
    }
    const rows = collect(t, (n) => classes(n).includes('fy-row'))
    assert.equal(rows.length, 4, 'FreeBrowse 渲染 4 行')

    assert.deepEqual(renderReads, oldRead, platform + '：读取的 draft 键集合应等于旧代码')
    assert.deepEqual(uniq([...writes]), oldWrite, platform + '：setDraft 写入的键集合应等于旧代码')
    assert.deepEqual(uniq(savedPaths), oldPaths, platform + '：save 路径集合应等于旧代码')
    assert.deepEqual(uniq(toggles), oldToggle, platform + '：toggleFreeRoam 平台参数应等于旧代码')
    // T4 重排：删掉所有灰字说明与旧"自由刷"行标签（改名"启用"），新增单位后缀「条」「分钟」；其余文案（保存提示语等）与旧代码一致
    const newAll = uniq([...newText, ...msgs.filter((m) => CJK.test(String(m)))])
    const removed = oldText.filter((x) => !newAll.includes(x))
    const added = newAll.filter((x) => !oldText.includes(x))
    assert.deepEqual(added, ['分钟', '启用', '条'], platform + '：新增文案只应是「启用」与单位后缀')
    const hintRe = /开着就一直刷|自由选项|0 = 不限/
    assert.deepEqual(removed.filter((x) => !hintRe.test(x)), ['自由刷'], platform + '：删掉的只应是说明句与旧行标签「自由刷」，实际：' + removed)
    assert.ok(collect(t, (n) => classes(n).some((c) => c === 'fy-hint' || c === 'fy-sub' || c === 'fy-sw-desc')).length === 0, platform + '：FreeBrowse 不再产出灰字说明')
  }
}

console.log('client-primitives ✓  原语：normNum / Field / Toggle / NumberField / Segmented / StatusDot / ChannelCard / DangerZone / useSave / FreeBrowse(douyin+bili)')
