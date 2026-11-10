/**
 * T02a Spike A —— 临时插件（验证后必须从 desktop profile 卸载）。
 *
 * 目的：
 *   1. 在 DSH 宿主进程内 bind 0.0.0.0:8765，验证插件能否正常 listen；
 *   2. 提供最小 OTA JSON 路径 + WebSocket upgrade/echo 路径（ws 用 dsh-feiyu 已安装的包）；
 *   3. 实测 publicHost 选网卡规则，输出候选/排除原因/默认路由，供 T12 直接照做。
 *
 * 本文件只写日志到 %TEMP%\\dsh-spike-a.log，不读取、不打印任何 DSH token。
 */
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const HOST = '0.0.0.0'
const PORT = Number(process.env.DSH_SPIKE_A_PORT || 8765)
const LOG_PATH = process.env.DSH_SPIKE_A_LOG || path.join(os.tmpdir(), 'dsh-spike-a.log')
const PUBLIC_HOST_OVERRIDE = String(process.env.DSH_SPIKE_A_PUBLIC_HOST || '').trim()
const FEIYU_ROOTS = [
  process.env.DSH_FEIYU_ROOT,
  'D:\\AI_Code\\小智机器人\\dsh-feiyu',
].filter(Boolean)

function log(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
  try { fs.appendFileSync(LOG_PATH, line + '\n') } catch {}
  console.log('[spike-a] ' + line)
}

function resolveWs() {
  const errors = []
  for (const root of FEIYU_ROOTS) {
    try {
      const req = createRequire(path.join(root, 'package.json'))
      const resolved = req.resolve('ws')
      const mod = req('ws')
      log('ws resolved', { root, resolved })
      return mod
    } catch (e) {
      errors.push(`${root}: ${e?.message ?? e}`)
    }
  }
  throw new Error('无法从 dsh-feiyu 安装目录解析 ws: ' + errors.join(' | '))
}

function runPowerShell(script) {
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
}

function parseJsonLoose(text) {
  const t = String(text || '').trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { return null }
}

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function listWindowsIpv4() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
  $rows += [pscustomobject]@{
    InterfaceIndex = [int]$_.InterfaceIndex
    Alias = [string]$_.InterfaceAlias
    Address = [string]$_.IPAddress
    PrefixLength = [int]$_.PrefixLength
    AddressState = [string]$_.AddressState
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
`
  try {
    return asArray(parseJsonLoose(runPowerShell(script)))
  } catch (e) {
    log('Get-NetIPAddress failed', String(e?.message ?? e))
    return []
  }
}

function listDefaultRoutes() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object {
  $r = $_
  $iface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex
  $rows += [pscustomobject]@{
    InterfaceIndex = [int]$r.InterfaceIndex
    NextHop = [string]$r.NextHop
    RouteMetric = [int]$r.RouteMetric
    InterfaceMetric = [int]$iface.InterfaceMetric
    TotalMetric = ([int]$r.RouteMetric + [int]$iface.InterfaceMetric)
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
`
  try {
    return asArray(parseJsonLoose(runPowerShell(script)))
  } catch (e) {
    log('Get-NetRoute failed', String(e?.message ?? e))
    return []
  }
}

// 虚拟/VPN/隧道网卡名称黑名单。中文系统额外排除“虚拟/蓝牙”字样；
// Mihomo/Clash/Sing-box 是常见 TUN 代理，必须排除，否则 publicHost 会选到 198.18.x.x。
const VIRTUAL_NAME_RE = /(vEthernet|WSL|Hyper-?V|VMware|VirtualBox|Docker|Loopback|Tailscale|ZeroTier|WireGuard|OpenVPN|SoftEther|TAP(?:[-\s]?Windows)?|TUN|utun|Mihomo|Clash|Sing-?box|VPN|虚拟|蓝牙)/i

function buildCandidates() {
  const nodeIfaces = os.networkInterfaces()
  const winIps = listWindowsIpv4()
  const winByAddress = new Map(
    winIps.filter((x) => x && x.Address).map((x) => [String(x.Address), x]),
  )

  const candidates = []
  for (const [name, entries] of Object.entries(nodeIfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string'
        ? entry.family
        : entry.family === 4 ? 'IPv4' : 'IPv6'
      if (family !== 'IPv4') continue

      const win = winByAddress.get(String(entry.address))
      const alias = win?.Alias || name
      const interfaceIndex = win?.InterfaceIndex ?? null
      const excluded = []

      if (entry.internal) excluded.push('internal/loopback')
      if (/^127\./.test(entry.address)) excluded.push('127.0.0.0/8 loopback')
      if (/^169\.254\./.test(entry.address)) excluded.push('169.254.0.0/16 link-local/APIPA')
      if (/^198\.(18|19)\./.test(entry.address)) excluded.push('198.18.0.0/15 benchmark/proxy TUN range')
      if (/^(0|255)\./.test(entry.address)) excluded.push('reserved address')
      if (VIRTUAL_NAME_RE.test(String(name)) || VIRTUAL_NAME_RE.test(String(alias))) {
        excluded.push(`virtual adapter name: ${name} / ${alias}`)
      }

      candidates.push({
        name,
        alias,
        address: entry.address,
        netmask: entry.netmask,
        cidr: entry.cidr,
        mac: entry.mac,
        interfaceIndex,
        addressState: win?.AddressState ?? null,
        excluded: [...new Set(excluded)],
        eligible: excluded.length === 0,
      })
    }
  }
  return candidates
}

function isRfc1918(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
}

function rfc1918Score(address) {
  if (/^192\.168\./.test(address)) return 0
  if (/^10\./.test(address)) return 1
  if (/^172\./.test(address)) return 2
  return 3
}

function selectPublicHost() {
  const candidates = buildCandidates()
  const routes = listDefaultRoutes()
  const eligible = candidates.filter((c) => c.eligible)
  const eligibleIndexes = new Set(
    eligible.map((c) => c.interfaceIndex).filter((x) => x != null),
  )

  const eligibleRoutes = routes
    .filter((r) => eligibleIndexes.has(r.InterfaceIndex))
    .sort((a, b) => Number(a.TotalMetric) - Number(b.TotalMetric))

  let selected = null
  let method = null
  let route = null

  if (PUBLIC_HOST_OVERRIDE) {
    selected = candidates.find((c) => c.address === PUBLIC_HOST_OVERRIDE) || {
      alias: '(env override, 不在本机网卡列表)',
      address: PUBLIC_HOST_OVERRIDE,
      eligible: true,
      excluded: [],
    }
    method = 'env-override'
  } else if (eligibleRoutes.length > 0) {
    route = eligibleRoutes[0]
    const matched = eligible.find((c) => c.interfaceIndex === route.InterfaceIndex)
    if (matched) {
      selected = matched
      method = 'eligible-default-route'
    }
  }

  if (!selected && eligible.length > 0) {
    const privatePool = eligible.filter((c) => isRfc1918(c.address))
    const pool = privatePool.length > 0 ? privatePool : eligible
    pool.sort((a, b) => rfc1918Score(a.address) - rfc1918Score(b.address)
      || String(a.address).localeCompare(String(b.address)))
    selected = pool[0]
    method = privatePool.length > 0 ? 'private-lan-fallback' : 'eligible-address-fallback'
  }

  const defaultRoutes = routes.map((r) => ({
    ...r,
    interfaceEligible: eligibleIndexes.has(r.InterfaceIndex),
    selected: selected != null && r.InterfaceIndex === selected.interfaceIndex,
  }))

  return {
    selectedAddress: selected?.address ?? null,
    selectedInterface: selected?.alias ?? selected?.name ?? null,
    method,
    selectedRoute: route,
    eligibleInterfaceIndexes: [...eligibleIndexes],
    candidates,
    defaultRoutes,
    rule: [
      '1) 枚举 os.networkInterfaces() 的 IPv4，排除 internal/127/169.254/198.18-19 与虚拟/VPN/隧道网卡（按名称正则）。',
      '2) 在剩余合格网卡中，取 0.0.0.0/0 默认路由且 TotalMetric（RouteMetric+InterfaceMetric）最小者。',
      '3) 若默认路由全在虚拟/VPN 网卡上（例如 Mihomo/Clash TUN），退回合格网卡中的 RFC1918 私网地址（192.168 > 10 > 172.16/12）。',
      '4) 不做公网地址兜底；可用 DSH_SPIKE_A_PUBLIC_HOST 显式覆盖。',
    ],
  }
}

export default {
  name: 'dsh-spike-a-gateway-probe',
  apply(ctx) {
    const startedAt = new Date().toISOString()
    const pid = process.pid
    let hostSelection = null
    let hostSelectionError = null
    try {
      hostSelection = selectPublicHost()
      log('publicHost selection', hostSelection)
    } catch (e) {
      hostSelectionError = String(e?.message ?? e)
      log('publicHost selection failed', hostSelectionError)
    }

    const counters = { httpRequests: 0, otaHits: 0, wsConnections: 0, wsMessages: 0 }
    const activeSockets = new Set()
    let listenInfo = null
    let listenError = null

    let WebSocketServer
    try {
      const WebSocket = resolveWs()
      WebSocketServer = WebSocket.WebSocketServer || WebSocket.Server
      if (typeof WebSocketServer !== 'function') {
        throw new Error('ws 包未导出 WebSocketServer/Server')
      }
    } catch (e) {
      listenError = String(e?.message ?? e)
      log('ws load failed', listenError)
    }

    function json(res, code, obj) {
      const body = JSON.stringify(obj)
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    function status() {
      return {
        spike: 'A',
        pid,
        startedAt,
        host: HOST,
        port: PORT,
        logPath: LOG_PATH,
        listenInfo,
        listenError,
        wsLoaded: Boolean(WebSocketServer),
        counters,
        activeWs: activeSockets.size,
        publicHost: hostSelection,
        publicHostError: hostSelectionError,
        publicHostOverride: PUBLIC_HOST_OVERRIDE || null,
        wsPath: '/ws',
        otaPath: '/xiaozhi/ota/',
      }
    }

    const server = http.createServer((req, res) => {
      counters.httpRequests++
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const pathname = url.pathname
      log('http', req.method, pathname, { remote: req.socket.remoteAddress, host: req.headers.host })

      if (pathname === '/xiaozhi/ota/' || pathname === '/xiaozhi/ota'
        || pathname === '/ota/' || pathname === '/ota') {
        counters.otaHits++
        const publicHost = hostSelection?.selectedAddress || '127.0.0.1'
        json(res, 200, {
          ok: true,
          spike: 'A',
          firmware: {
            version: '0.0.0-spike-a',
            force: 0,
          },
          websocket: {
            url: `ws://${publicHost}:${PORT}/ws`,
            path: '/ws',
          },
          server_time: {
            timestamp: Date.now(),
            timezone_offset: -new Date().getTimezoneOffset(),
          },
        })
        return
      }

      if (pathname === '/spike-a/status') {
        json(res, 200, status())
        return
      }

      if (pathname === '/spike-a/echo') {
        json(res, 200, {
          ok: true,
          method: req.method,
          path: pathname,
          remote: req.socket.remoteAddress,
          headers: {
            host: req.headers.host ?? null,
            userAgent: req.headers['user-agent'] ?? null,
          },
          at: new Date().toISOString(),
        })
        return
      }

      json(res, 404, { ok: false, error: 'not found', path: pathname })
    })

    let wss = null
    if (WebSocketServer) {
      wss = new WebSocketServer({ noServer: true })
      wss.on('connection', (ws, req) => {
        counters.wsConnections++
        activeSockets.add(ws)
        const remote = req.socket.remoteAddress
        log('ws connected', { remote, url: req.url, host: req.headers.host })
        ws.send(JSON.stringify({
          type: 'hello',
          spike: 'A',
          pid,
          remote,
          at: new Date().toISOString(),
        }))
        ws.on('message', (data, isBinary) => {
          counters.wsMessages++
          if (!isBinary) {
            const text = data.toString('utf8')
            log('ws message', { remote, text })
            let parsed = null
            try { parsed = JSON.parse(text) } catch {}
            ws.send(JSON.stringify({
              type: parsed?.type === 'ping' ? 'pong' : 'echo',
              echo: parsed ?? text,
              pid,
              at: new Date().toISOString(),
            }))
            return
          }
          log('ws binary', { remote, bytes: data.length })
          ws.send(data, { binary: true })
        })
        ws.on('close', (code, reason) => {
          activeSockets.delete(ws)
          log('ws closed', { remote, code, reason: reason?.toString?.() ?? '' })
        })
        ws.on('error', (err) => log('ws error', { remote, message: String(err?.message ?? err) }))
      })

      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
        const accepted = url.pathname === '/ws'
          || url.pathname === '/spike-a/ws'
          || url.pathname === '/xiaozhi/v1/'
          || url.pathname === '/xiaozhi/v1'
        log('upgrade', { path: url.pathname, remote: socket.remoteAddress, accepted })
        if (!accepted) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      })
    }

    server.on('error', (err) => {
      listenError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
      log('http server error', listenError)
    })

    server.listen(PORT, HOST, () => {
      listenInfo = {
        ...server.address(),
        listening: server.listening,
        argv0: process.argv0,
        execPath: process.execPath,
        nodeVersion: process.version,
        pid,
        hostProcessPid: pid,
      }
      log('listening', listenInfo)
      log('publicHost selected', {
        address: hostSelection?.selectedAddress ?? null,
        iface: hostSelection?.selectedInterface ?? null,
        method: hostSelection?.method ?? null,
      })
    })

    ctx.effect(() => () => {
      log('disposing spike-a listener')
      try { wss?.close() } catch {}
      for (const ws of activeSockets) { try { ws.terminate() } catch {} }
      try { server.close() } catch {}
    })
  },
}
