// T12：publicHost 选网卡（规则见 docs/spikes.md §A3，G0 裁决）
//
// 选网卡必须是纯函数，便于单测：
//   selectPublicHost({ interfaces, routes, addressIndexes, override })
// - interfaces：os.networkInterfaces() 形状（可注入）
// - routes：0.0.0.0/0 默认路由数组，字段对齐 Windows Get-NetRoute/Get-NetIPInterface
// - addressIndexes：{ '192.168.10.39': 10 }，Windows 下 IP → InterfaceIndex 映射
// - override：显式配置的 publicHost（最高优先级，允许不在本机网卡列表）
//
// 规则：
// 1. 排除 internal/127/169.254/198.18-19 与名称命中虚拟/VPN/隧道正则的网卡；
// 2. 合格网卡中选默认路由 TotalMetric 最小者；
// 3. 默认路由全在虚拟网卡上时，按 RFC1918 兜底（192.168 > 10 > 172.16/12）；
// 4. 不做公网地址兜底。
import os from 'node:os'
import { execFile } from 'node:child_process'

export const VIRTUAL_INTERFACE_RE = /(vEthernet|WSL|Hyper-?V|VMware|VirtualBox|Docker|Loopback|Tailscale|ZeroTier|WireGuard|OpenVPN|SoftEther|TAP(?:[-\s]?Windows)?|TUN|utun|Mihomo|Clash|Sing-?box|VPN|虚拟|蓝牙)/i

const DEFAULT_ROUTE_PREFIX = '0.0.0.0/0'

export function isRfc1918(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
}

export function rfc1918Score(address) {
  if (/^192\.168\./.test(address)) return 0
  if (/^10\./.test(address)) return 1
  if (/^172\./.test(address)) return 2
  return 3
}

function isIpv4Entry(entry) {
  if (!entry) return false
  const family = typeof entry.family === 'string'
    ? entry.family
    : entry.family === 4 ? 'IPv4' : 'IPv6'
  return family === 'IPv4'
}

function exclusionReasons(name, alias, entry) {
  const address = String(entry.address || '')
  const reasons = []
  if (entry.internal) reasons.push('internal/loopback')
  if (/^127\./.test(address)) reasons.push('127.0.0.0/8 loopback')
  if (/^169\.254\./.test(address)) reasons.push('169.254.0.0/16 link-local/APIPA')
  if (/^198\.(18|19)\./.test(address)) reasons.push('198.18.0.0/15 proxy TUN range')
  if (/^(0|255)\./.test(address)) reasons.push('reserved address')
  if (VIRTUAL_INTERFACE_RE.test(String(name)) || VIRTUAL_INTERFACE_RE.test(String(alias))) {
    reasons.push(`virtual adapter name: ${name}${alias && alias !== name ? ` / ${alias}` : ''}`)
  }
  return [...new Set(reasons)]
}

function buildCandidates(interfaces, addressIndexes) {
  const candidates = []
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!isIpv4Entry(entry) || typeof entry.address !== 'string' || entry.address.length === 0) continue
      const interfaceIndex = addressIndexes?.[entry.address] ?? entry.interfaceIndex ?? null
      const alias = entry.alias || name
      const excluded = exclusionReasons(name, alias, entry)
      candidates.push({
        name,
        alias,
        address: entry.address,
        netmask: entry.netmask ?? null,
        cidr: entry.cidr ?? null,
        mac: entry.mac ?? null,
        interfaceIndex,
        excluded,
        eligible: excluded.length === 0,
      })
    }
  }
  return candidates
}

function routeTotalMetric(route) {
  const total = Number(route.TotalMetric)
  if (Number.isFinite(total)) return total
  return (Number(route.RouteMetric) || 0) + (Number(route.InterfaceMetric) || 0)
}

function routeMatchesCandidate(route, candidate) {
  if (route.InterfaceIndex != null && candidate.interfaceIndex != null
    && Number(route.InterfaceIndex) === Number(candidate.interfaceIndex)) {
    return true
  }
  const routeAlias = route.InterfaceAlias
  return Boolean(routeAlias) && (routeAlias === candidate.alias || routeAlias === candidate.name)
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) return []
  return routes
    .filter((route) => route
      && (route.DestinationPrefix == null || route.DestinationPrefix === DEFAULT_ROUTE_PREFIX))
    .map((route) => ({ ...route, totalMetric: routeTotalMetric(route) }))
    .sort((a, b) => a.totalMetric - b.totalMetric)
}

/**
 * 纯函数：按 spikes.md §A3 选出网关对外公布的 IPv4。
 * @returns {{
 *   address: string|null,
 *   interfaceName: string|null,
 *   method: 'explicit'|'eligible-default-route'|'private-lan-fallback'|null,
 *   route: object|null,
 *   candidates: object[],
 *   eligibleAddresses: string[],
 *   defaultRoutes: object[],
 * }}
 */
export function selectPublicHost({
  interfaces = os.networkInterfaces(),
  routes = [],
  addressIndexes = {},
  override = '',
} = {}) {
  const candidates = buildCandidates(interfaces, addressIndexes)
  const eligible = candidates.filter((c) => c.eligible)
  const defaultRoutes = normalizeRoutes(routes)
  const explicit = String(override ?? '').trim()

  let selected = null
  let method = null
  let route = null

  if (explicit) {
    selected = candidates.find((c) => c.address === explicit) || {
      name: null,
      alias: null,
      address: explicit,
      netmask: null,
      cidr: null,
      mac: null,
      interfaceIndex: null,
      excluded: [],
      eligible: true,
      external: true,
    }
    method = 'explicit'
  } else {
    for (const candidateRoute of defaultRoutes) {
      const matched = eligible.find((c) => routeMatchesCandidate(candidateRoute, c))
      if (matched) {
        selected = matched
        method = 'eligible-default-route'
        route = candidateRoute
        break
      }
    }

    // 默认路由全在虚拟/VPN 网卡（如 Mihomo/Clash TUN）上：按 RFC1918 兜底，不碰公网地址。
    if (!selected) {
      const privatePool = eligible.filter((c) => isRfc1918(c.address))
      if (privatePool.length > 0) {
        privatePool.sort((a, b) => rfc1918Score(a.address) - rfc1918Score(b.address)
          || a.address.localeCompare(b.address))
        selected = privatePool[0]
        method = 'private-lan-fallback'
      }
    }
  }

  return {
    address: selected?.address ?? null,
    interfaceName: selected ? (selected.alias || selected.name || null) : null,
    method,
    route,
    candidates,
    eligibleAddresses: eligible.map((c) => c.address),
    defaultRoutes,
  }
}

const POWERSHELL_NETWORK_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ips = @()
Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
  $ips += [pscustomobject]@{
    InterfaceIndex = [int]$_.InterfaceIndex
    Address = [string]$_.IPAddress
    Alias = [string]$_.InterfaceAlias
  }
}
$routes = @()
Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object {
  $r = $_
  $iface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex
  $routes += [pscustomobject]@{
    InterfaceIndex = [int]$r.InterfaceIndex
    InterfaceAlias = [string]$iface.InterfaceAlias
    NextHop = [string]$r.NextHop
    RouteMetric = [int]$r.RouteMetric
    InterfaceMetric = [int]$iface.InterfaceMetric
    TotalMetric = ([int]$r.RouteMetric + [int]$iface.InterfaceMetric)
  }
}
ConvertTo-Json -InputObject @{ ips = @($ips); routes = @($routes) } -Depth 4 -Compress
`

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function parsePowerShellJson(text) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!cleaned) return {}
  return JSON.parse(cleaned)
}

/**
 * 读取 Windows IPv4 地址表与默认路由表（失败由调用方按 RFC1918 兜底）。
 * 非 Windows 平台直接返回空路由，selectPublicHost 会走 RFC1918 兜底。
 * @returns {Promise<{routes: object[], addressIndexes: Record<string, number>, error: string|null}>}
 */
export function collectWindowsNetworkInfo({ timeoutMs = 15000 } = {}) {
  const empty = { routes: [], addressIndexes: {}, error: null }
  if (process.platform !== 'win32') return Promise.resolve(empty)

  return new Promise((resolve) => {
    const fallback = (error) => resolve({ routes: [], addressIndexes: {}, error: String(error) })
    try {
      execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        POWERSHELL_NETWORK_SCRIPT,
      ], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout) => {
        if (error) return fallback(error.message || error)
        try {
          const parsed = parsePowerShellJson(stdout)
          const addressIndexes = {}
          for (const ip of asArray(parsed?.ips)) {
            if (ip && ip.Address != null && ip.InterfaceIndex != null) {
              addressIndexes[String(ip.Address)] = Number(ip.InterfaceIndex)
            }
          }
          resolve({ routes: asArray(parsed?.routes), addressIndexes, error: null })
        } catch (parseError) {
          fallback(parseError?.message ?? parseError)
        }
      })
    } catch (error) {
      fallback(error?.message ?? error)
    }
  })
}
