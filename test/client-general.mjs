/**
 * T6 字段保真：GeneralCards / FreedomZone 重排前后，读写的 draft 键、save 路径、api 路径集合必须一致。
 * 旧版取自 git 提交 171d079:client.js（ui/panel-refactor 基线），新版取工作区 client.js。
 * 跑法：node test/client-general.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '171d079'
const oldSrc = execFileSync('git', ['show', `${BASE}:client.js`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
const newSrc = readFileSync(path.join(root, 'client.js'), 'utf8')

const slice = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  assert.ok(a >= 0 && b > a, `找不到区段 ${from} → ${to}`)
  return src.slice(a, b)
}
const parts = (src) => ({
  general: slice(src, '// ===== GeneralCards =====', '// ===== QqCard ====='),
  freedom: slice(src, '// ===== FreedomZone =====', '// ===== DouyinCard ====='),
})

const uniq = (arr) => [...new Set(arr)].sort()
// save({ a: { b: { c: ...  → "a.b.c"（取到第一个非嵌套对象的值为止）；commitProps("a.b.c", ...) → 同形
const savePaths = (code) => {
  const out = []
  for (const m of code.matchAll(/\bsave\(\s*((?:\{\s*\w+\s*:\s*)+)/g)) {
    out.push([...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]).join('.'))
  }
  for (const m of code.matchAll(/commitProps\(\s*"([\w.]+)"/g)) out.push(m[1])
  // textProps("draftKey", draft.draftKey, "a.b.c", ...) 内部转 commitProps(path)
  for (const m of code.matchAll(/textProps\(\s*"\w+"\s*,\s*draft\.\w+\s*,\s*"([\w.]+)"/g)) out.push(m[1])
  return uniq(out)
}
const draftReads = (code) => uniq([...code.matchAll(/\bdraft\.(\w+)/g)].map((m) => m[1]))
const draftWrites = (code) => uniq([
  ...[...code.matchAll(/setDraft\(Object\.assign\(\{\}, draft, \{ (\w+):/g)].map((m) => m[1]),
  ...[...code.matchAll(/textProps\(\s*"(\w+)"/g)].map((m) => m[1]),
])
const apiPaths = (code) => uniq([...code.matchAll(/\bapi\(\s*"([^"]+)"/g)].map((m) => m[1]))
const toDraftKeys = (src) => {
  const body = slice(src, 'const toDraft', 'proactive 保存')
  return uniq([...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]))
}

const O = parts(oldSrc)
const N = parts(newSrc)
for (const name of ['general', 'freedom']) {
  assert.deepEqual(savePaths(N[name]), savePaths(O[name]), `${name}: save 路径集合变了`)
  assert.deepEqual(draftReads(N[name]), draftReads(O[name]), `${name}: draft 读取键集合变了`)
  assert.deepEqual(draftWrites(N[name]), draftWrites(O[name]), `${name}: setDraft 写入键集合变了`)
  assert.deepEqual(apiPaths(N[name]), apiPaths(O[name]), `${name}: api 路径集合变了`)
  // 设计规则：这两块里不再有灰字说明 / 卡片 hint
  for (const bad of ['fy-hint', 'fy-sw-desc', 'fy-sub', 'hint:']) {
    assert.ok(!N[name].includes(bad), `${name}: 不应再出现 ${bad}`)
  }
}
const a = toDraftKeys(oldSrc)
const b = toDraftKeys(newSrc)
assert.equal(b.length, 60, 'toDraft 键数应为 60，实际 ' + b.length)
assert.deepEqual(b, a, 'toDraft 键集合变了')

console.log('client-general ✓  save 路径 ' + savePaths(N.general).length + '+' + savePaths(N.freedom).length +
  ' · draft 读取 ' + draftReads(N.general).length + '+' + draftReads(N.freedom).length + ' · toDraft ' + b.length + ' 键 · 无灰字说明')
