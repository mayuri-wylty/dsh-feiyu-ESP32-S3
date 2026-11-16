/**
 * ui-shots 静态服务：只提供 test/ui-shots/out/（根路径）与 test/ui-shots/before/（/before/）下的 .html/.png，
 * 固定端口 4173（可用 UI_SHOTS_PORT 覆盖），仅监听 127.0.0.1。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.UI_SHOTS_PORT) || 4173
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' }
const MOUNTS = [['/before/', path.join(here, 'before')], ['/', path.join(here, 'out')]]

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const rel = decodeURIComponent(url.pathname)
  for (const [prefix, dir] of MOUNTS) {
    if (!rel.startsWith(prefix)) continue
    const name = path.basename(rel.slice(prefix.length) || 'current.html')
    const ext = path.extname(name)
    const file = path.join(dir, name)
    if (!MIME[ext] || !fs.existsSync(file)) continue
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store' })
    return fs.createReadStream(file).pipe(res)
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found: ' + rel)
}).listen(port, '127.0.0.1', () => console.log(`ui-shots serving http://127.0.0.1:${port}/  (out/ 根路径, before/ 在 /before/)`))
