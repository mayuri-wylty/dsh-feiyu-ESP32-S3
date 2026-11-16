/**
 * client.js 设置面板 → 静态 HTML（无桌面版、无浏览器）。
 *
 * 做法：用真 React + react-dom/server 的 renderToStaticMarkup 渲染 FeiyuSection。
 * 难点是数据都在 useEffect 里 fetch，而 SSR 不跑 effect —— 所以这里给 client.js 一个
 * "包装版 react"：hooks 把状态存进外部仓库（按「组件名#第几个实例#第几个 hook」定位），
 * 每轮 SSR 之后手动跑 effect、等假 fetch 落地，再重渲染，直到稳定；最后一轮的静态 HTML 就是产物。
 * 这样：输出是真 React 的序列化结果（不是自写的树转字符串）、卡片内容完整、无需 jsdom、纯 Node 可复现。
 *
 * 用法：node test/ui-shots/render-html.mjs [--out <name>] [--dir <outDir>] [--conn loggedIn|loggedOut|probeFailed|douyinWaiting] [--expand]
 *   --out     输出文件名（不含 .html），默认 current
 *   --dir     输出目录，默认 test/ui-shots/out
 *   --expand  额外塞一段 CSS 展开所有折叠分组（只影响截图观感，不改 DOM 结构）
 *   React 位置：环境变量 UI_SHOTS_REACT_DIR（含 node_modules/react 的目录，或 node_modules 本身）；
 *   未设置时回退到仓库外的 D:\AI_Code\_tmp_react。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { NOW, buildResponses, CONN_VARIANTS } from './fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

// ── 参数 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const outName = opt('out', 'current')
const outDir = path.resolve(opt('dir', path.join(here, 'out')))
const conn = opt('conn', 'loggedIn')
const expand = args.includes('--expand')
if (!/^[\w.-]+$/.test(outName)) throw new Error('--out 只能是简单文件名：' + outName)
if (!CONN_VARIANTS.includes(conn)) throw new Error(`--conn 可选：${CONN_VARIANTS.join(' / ')}`)

// ── 找 React ──────────────────────────────────────────────────────────────
function findReactBase() {
  const cands = [process.env.UI_SHOTS_REACT_DIR, path.resolve(root, '..', '..', '_tmp_react')].filter(Boolean)
  for (const c of cands) {
    for (const base of [c, path.join(c, 'node_modules')]) {
      if (fs.existsSync(path.join(base, 'react', 'package.json')) && fs.existsSync(path.join(base, 'react-dom', 'package.json'))) return base
    }
  }
  throw new Error('找不到 react / react-dom。请设置 UI_SHOTS_REACT_DIR（见 test/ui-shots/README.md）。已试：' + cands.join(' ; '))
}
const reactBase = findReactBase()
const req = createRequire(path.join(reactBase, 'noop.js'))
const realReact = req('react')
const { renderToStaticMarkup } = req('react-dom/server')

// ── 环境桩 ────────────────────────────────────────────────────────────────
Date.now = () => NOW                                  // 钉死时间 → "x 秒前" 之类文案确定
const origSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...rest) => (ms > 500 ? 0 : origSetTimeout(fn, ms, ...rest)) // 退避/提示淡出等长定时器不执行

const styleTags = []
globalThis.window = { __ModuleLoader__: { load(spec) { globalThis.__spec = spec } } }
globalThis.document = {
  head: { appendChild: (el) => styleTags.push(el) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
}

const RESPONSES = buildResponses({ conn })
let inflight = 0
const missing = []
globalThis.fetch = async (url, init) => {
  inflight++
  try {
    if (init && init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    const data = RESPONSES[url]
    if (!data) { missing.push(url); return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: 'no fixture: ' + url }) } }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  } finally {
    // 让调用方 await 完 text()/JSON.parse 之后再递减：放到宏任务里
    origSetTimeout(() => { inflight-- }, 0)
  }
}

// ── 状态仓库 + 包装版 react ────────────────────────────────────────────────
const slots = new Map()          // key -> { v } | { deps, fn } | { deps, cleanup }
let dirty = false
let counters = new Map()         // 组件名 -> 本轮已出现的实例数
let cur = null                   // 当前正在渲染的组件 { id, idx }
let pendingEffects = []
let ranEffects = 0

const wrapped = new WeakMap()
function wrap(type) {
  let w = wrapped.get(type)
  if (!w) {
    const nm = type.displayName || type.name || 'anon'
    w = function Wrapped(props) {
      const n = counters.get(nm) || 0
      counters.set(nm, n + 1)
      const prev = cur
      cur = { id: nm + '#' + n, idx: 0 }
      try { return type(props) } finally { cur = prev }
    }
    wrapped.set(type, w)
  }
  return w
}
const slotKey = () => cur.id + ':' + (cur.idx++)
const depsChanged = (prev, deps) => !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])

const react = {
  ...realReact,
  createElement(type, ...rest) {
    return realReact.createElement(typeof type === 'function' ? wrap(type) : type, ...rest)
  },
  useState(init) {
    const key = slotKey()
    if (!slots.has(key)) slots.set(key, { v: typeof init === 'function' ? init() : init })
    const s = slots.get(key)
    return [s.v, (v) => {
      const next = typeof v === 'function' ? v(s.v) : v
      if (next !== s.v) { s.v = next; dirty = true }
    }]
  },
  useRef(v) {
    const key = slotKey()
    if (!slots.has(key)) slots.set(key, { current: v })
    return slots.get(key)
  },
  useCallback(fn, deps) {
    const key = slotKey()
    const prev = slots.get(key)
    if (depsChanged(prev, deps)) slots.set(key, { deps, fn })
    return slots.get(key).fn
  },
  useEffect(fn, deps) {
    const key = slotKey()
    const prev = slots.get(key)
    if (!depsChanged(prev, deps)) return
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    const rec = { deps, cleanup: undefined }
    slots.set(key, rec)
    pendingEffects.push(() => { rec.cleanup = fn() })
  },
}

// ── 装载 client.js ────────────────────────────────────────────────────────
const requireCjs = createRequire(import.meta.url)
requireCjs(path.join(root, 'client.js'))
const spec = globalThis.__spec
if (!spec) throw new Error('client.js 没有调用 __ModuleLoader__.load')
let Component = null
const mod = spec.factory((n) => {
  if (n === 'react') return react
  throw new Error('未预期的 require：' + n)
})
mod.apply({ slots: { inject: (_s, fn) => fn(), register: (_o, C) => { Component = C; return () => {} } } })
if (typeof Component !== 'function') throw new Error('没拿到注册的组件')

// ── 渲染到稳定 ────────────────────────────────────────────────────────────
const tick = () => new Promise((r) => setImmediate(r))
let html = ''
let passes = 0
for (; passes < 25; passes++) {
  counters = new Map()
  cur = null
  dirty = false
  pendingEffects = []
  html = renderToStaticMarkup(react.createElement(Component, { close() {} }))
  const effs = pendingEffects
  pendingEffects = []
  for (const run of effs) { ranEffects++; run() }
  for (let i = 0; i < 6; i++) await tick()
  for (let i = 0; i < 200 && inflight > 0; i++) await tick()
  for (let i = 0; i < 6; i++) await tick()
  if (!dirty) break
}
if (passes >= 25) throw new Error('渲染 25 轮仍未稳定')
if (html.includes('载入失败') || html.includes('读取大肥鱼配置')) throw new Error('渲染停在加载/错误态，数据没喂进去')
if (!styleTags.length) throw new Error('没捕获到 client.js 注入的样式')
const css = String(styleTags[0].textContent)

// ── 页面外壳 ──────────────────────────────────────────────────────────────
const THEME_CSS = `
:root{color-scheme:light;
  --dsw-alias-bg-l1:#f7f8fa;--dsw-alias-bg-l2:#eef0f4;--dsw-alias-border-l2:#dcdfe6;
  --dsw-alias-label-primary:#1f2329;--dsw-alias-label-secondary:#5f6b7a;--dsw-alias-label-tertiary:#8a94a3;
  --dsw-alias-brand-primary:#3b6cf6;--page-bg:#ffffff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;
  --dsw-alias-bg-l1:#23262d;--dsw-alias-bg-l2:#2c3038;--dsw-alias-border-l2:#3a3f49;
  --dsw-alias-label-primary:#e6e8ec;--dsw-alias-label-secondary:#a3acba;--dsw-alias-label-tertiary:#7d8794;
  --dsw-alias-brand-primary:#5b8cff;--page-bg:#17191d}}
html[data-theme=dark]{color-scheme:dark;
  --dsw-alias-bg-l1:#23262d;--dsw-alias-bg-l2:#2c3038;--dsw-alias-border-l2:#3a3f49;
  --dsw-alias-label-primary:#e6e8ec;--dsw-alias-label-secondary:#a3acba;--dsw-alias-label-tertiary:#7d8794;
  --dsw-alias-brand-primary:#5b8cff;--page-bg:#17191d}
html,body{margin:0;background:var(--page-bg);color:var(--dsw-alias-label-primary);
  font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.ui-shot-shell{max-width:760px;margin:0 auto;padding:20px 16px}
`
const EXPAND_CSS = expand ? '\n.fy-group-body{display:flex !important}\n' : ''

const page = '<!doctype html>\n'
  + '<html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>dsh-feiyu settings (static)</title>'
  + '<style data-ui-shots="theme">' + THEME_CSS + '</style>'
  + '<style data-plugin-css="dsh-feiyu/client">' + css + EXPAND_CSS + '</style>'
  + '<script>var t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.setAttribute("data-theme",t);addEventListener("load",function(){document.documentElement.setAttribute("data-h",String(document.documentElement.scrollHeight))})</script>'
  + '</head><body><div class="ui-shot-shell" id="root">' + html + '</div></body></html>\n'

fs.mkdirSync(outDir, { recursive: true })
const file = path.join(outDir, outName + '.html')
fs.writeFileSync(file, page, 'utf8')

const cards = (html.match(/class="fy-card"/g) || []).length
console.log(`ui-shots ✓ ${path.relative(process.cwd(), file) || file}  (${page.length} 字符 · ${cards} 张卡片 · ${passes + 1} 轮 · ${ranEffects} 个 effect · conn=${conn}${expand ? ' · expand' : ''})`)
if (missing.length) console.log('  提示：以下 GET 无夹具（404）：' + [...new Set(missing)].join(', '))
