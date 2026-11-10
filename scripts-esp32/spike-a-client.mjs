/**
 * T02a Spike A 客户端探针：验证 OTA HTTP 与 WebSocket 在
 * 127.0.0.1 和本机局域网 IP 上均可达。
 *
 * 用法：
 *   node spike-a-client.mjs 127.0.0.1 192.168.10.39
 *   node spike-a-client.mjs --port 8765 127.0.0.1 192.168.10.39
 */
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'

const FEIYU_ROOTS = [
  process.env.DSH_FEIYU_ROOT,
  'D:\\AI_Code\\小智机器人\\dsh-feiyu',
].filter(Boolean)

function resolveWs() {
  const errors = []
  for (const root of FEIYU_ROOTS) {
    try {
      const req = createRequire(path.join(root, 'package.json'))
      return req('ws')
    } catch (e) {
      errors.push(`${root}: ${e?.message ?? e}`)
    }
  }
  throw new Error('无法解析 ws: ' + errors.join(' | '))
}

const WebSocket = resolveWs()

const args = process.argv.slice(2)
let port = 8765
const hosts = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') { port = Number(args[++i]); continue }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('用法: node spike-a-client.mjs [--port 8765] <host> [host...]')
    process.exit(0)
  }
  hosts.push(args[i])
}
if (hosts.length === 0) hosts.push('127.0.0.1')

function httpGetJson(host, pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathname, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body = null
        try { body = JSON.parse(text) } catch {}
        resolve({ host, path: pathname, status: res.statusCode, body, text })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
  })
}

function wsProbe(host, pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const url = `ws://${host}:${port}${pathname}`
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs })
    const result = { host, path: pathname, url, hello: null, reply: null, open: false }
    const timer = setTimeout(() => {
      try { ws.terminate() } catch {}
      reject(new Error(`ws timeout: ${url}`))
    }, timeoutMs)
    ws.on('open', () => {
      result.open = true
      ws.send(JSON.stringify({ type: 'ping', nonce: Date.now(), spike: 'A-client' }))
    })
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? `<binary ${data.length}B>` : data.toString('utf8')
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      if (parsed?.type === 'hello' && !result.hello) {
        result.hello = parsed
        return
      }
      result.reply = parsed ?? text
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(result)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const report = { port, hosts, pass: true, checks: [] }
for (const host of hosts) {
  for (const pathname of ['/xiaozhi/ota/', '/spike-a/echo', '/spike-a/status']) {
    try {
      const r = await httpGetJson(host, pathname)
      const ok = r.status === 200 && r.body?.ok !== false
      if (!ok) report.pass = false
      report.checks.push({ kind: 'http', host, path: pathname, status: r.status, ok, body: r.body })
    } catch (e) {
      report.pass = false
      report.checks.push({ kind: 'http', host, path: pathname, ok: false, error: String(e?.message ?? e) })
    }
  }
  for (const pathname of ['/ws', '/xiaozhi/v1/']) {
    try {
      const r = await wsProbe(host, pathname)
      const ok = r.open && r.hello?.type === 'hello' && r.reply?.type === 'pong'
      if (!ok) report.pass = false
      report.checks.push({ kind: 'ws', host, path: pathname, ok, ...r })
    } catch (e) {
      report.pass = false
      report.checks.push({ kind: 'ws', host, path: pathname, ok: false, error: String(e?.message ?? e) })
    }
  }
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.pass ? 0 : 1)
