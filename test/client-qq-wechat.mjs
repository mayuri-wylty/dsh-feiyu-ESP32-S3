// T5 字段保真：QqCard / WechatCard 的 draft 读取键 + save 路径集合 与旧版（171d079）一致。
// 用法：node test/client-qq-wechat.mjs [旧版 client.js 路径]（缺省用 git show 171d079:client.js）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const newSrc = readFileSync(path.join(root, 'client.js'), 'utf8')
const oldSrc = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : execFileSync('git', ['show', '171d079:client.js'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })

const block = (src, name) => {
  const a = src.indexOf('function ' + name + '(')
  assert.ok(a >= 0, '找不到 ' + name)
  const rest = src.slice(a + 10)
  const m = rest.search(/\n\t\t\/\/ ===== /)
  return src.slice(a, m < 0 ? undefined : a + 10 + m)
}
const draftKeys = (code) => new Set([...code.matchAll(/draft\.(\w+)/g)].map((m) => m[1]))
const setDraftKeys = (code) => new Set([...code.matchAll(/setDraft\(Object\.assign\(\{\}, draft, \{ (\w+):/g)].map((m) => m[1]))
const savePaths = (code) => {
  const out = new Set()
  for (const m of code.matchAll(/saveProactive\(\{\s*(\w+):/g)) out.add('qq.proactive.' + m[1])
  for (const m of code.matchAll(/\bsave\(\{\s*(\w+):\s*\{\s*(\w+):/g)) out.add(m[1] + '.' + m[2])
  return out
}
const same = (a, b, what) => assert.deepEqual([...a].sort(), [...b].sort(), what)

for (const name of ['QqCard', 'WechatCard']) {
  const o = block(oldSrc, name)
  const n = block(newSrc, name)
  same(draftKeys(n), draftKeys(o), name + ' draft 读取键')
  same(setDraftKeys(n), setDraftKeys(o), name + ' setDraft 写入键')
  same(savePaths(n), savePaths(o), name + ' save 路径')
  assert.ok(savePaths(n).size >= 1, name + ' 应有 save 路径')
  for (const bad of ['fy-hint', 'fy-sw-desc', 'fy-sub', '0 = 不限', '风控风险高', '点运行状态']) {
    assert.ok(!n.includes(bad), name + ' 不应含：' + bad)
  }
}
assert.ok(block(newSrc, 'WechatCard').includes('danger: true'), '微信 off 档应为 danger')
console.log('client-qq-wechat ✓  QqCard/WechatCard 字段保真（draft 键 / setDraft 键 / save 路径与 171d079 一致）')
