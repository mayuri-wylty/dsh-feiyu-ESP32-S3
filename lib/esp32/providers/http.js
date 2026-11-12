// ESP32 通道 · providers HTTP 层（纯函数；路由接线在 lib/index.js）
//
// 全部不碰文件系统/网络：配置读取、写入、测试器都由调用方注入，便于单测。
// 安全：任何返回体都不含 apiKey/token 明文（经 maskEsp32）。

import { mergeEsp32Config } from '../contracts.js'
import {
  KINDS, getProvider, schemaView, maskEsp32, stripBlankSecrets, nullSecretsToBlank,
  LOCAL_ASR_ID, LOCAL_TTS_DEFAULT_ID,
} from './registry.js'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** 深合并（数组整体替换）：返回新对象，不改入参。 */
export function deepMerge(base, over) {
  const out = { ...(isObj(base) ? base : {}) }
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isObj(v) ? deepMerge(out[k], v) : v
  }
  return out
}

/** GET /providers 响应体：schema + 非密当前值（含 hasKey）+ 主备 + 管线健康。 */
export function buildProvidersView({ esp32 = {}, health = null } = {}) {
  const merged = mergeEsp32Config(esp32)
  const masked = maskEsp32(merged)
  return {
    ok: true,
    providers: schemaView(),
    current: {
      asr: { primary: masked.asr.primary, fallback: masked.asr.fallback, values: { openai: masked.asr.openai, volcengine: masked.asr.volcengine } },
      tts: { primary: masked.tts.provider, fallback: masked.tts.fallback, values: { cloud: masked.tts.cloud, volcengine: masked.tts.volcengine } },
    },
    pipeline: health ?? null,
  }
}

/** GET /api/config：整份配置的 esp32 段脱敏（修复 token 与各 apiKey 明文泄露）。不改入参。 */
export function maskConfigForGet(cfg) {
  const safe = JSON.parse(JSON.stringify(cfg ?? {}))
  if (isObj(safe.esp32)) safe.esp32 = maskEsp32(safe.esp32)
  return safe
}

/** POST /api/config：把前端回写的 esp32 段整理成可深合并的 patch（密钥空串保持/null 清除/丢弃 hasKey 与 token）。 */
export function prepareEsp32Patch(patch) {
  return nullSecretsToBlank(stripBlankSecrets(patch))
}

/** 持久化时的主备：云为 primary，本地为 fallback。 */
export function planFailover(kind, id, stored) {
  if (kind === 'asr') return { primary: id, fallback: LOCAL_ASR_ID }
  const isLocal = (pid) => Boolean(pid) && getProvider('tts', pid)?.local === true
  const oldPrimary = stored.tts.provider
  const oldFallback = stored.tts.fallback
  const local = isLocal(oldPrimary) ? oldPrimary : isLocal(oldFallback) ? oldFallback : LOCAL_TTS_DEFAULT_ID
  return { primary: id, fallback: local }
}

/** 构造一次性原子写所需的 esp32 patch：provider 配置 + 主备。 */
export function buildPersistPatch(kind, id, values, stored) {
  const meta = getProvider(kind, id)
  const { primary, fallback } = planFailover(kind, id, stored)
  return kind === 'asr'
    ? { asr: { primary, fallback, [meta.configKey]: values } }
    : { tts: { provider: primary, fallback, [meta.configKey]: values } }
}

/**
 * POST /providers/test。
 * @param {{
 *   body: {kind?: string, id?: string, values?: object, persist?: boolean},
 *   getStored: () => object,                    // 当前 esp32 配置（可未合并默认值）
 *   test: (args: {kind: string, id: string, values: object}) => Promise<object>,
 *   persist?: (patch: {esp32: object}) => (void|Promise<void>),   // 快照 + 原子写，由调用方实现
 * }} args
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleProvidersTest({ body, getStored, test, persist }) {
  const kind = String(body?.kind ?? '')
  const id = String(body?.id ?? '')
  if (!KINDS.includes(kind)) return { status: 400, body: { ok: false, error: 'kind 必须是 asr 或 tts' } }
  const meta = getProvider(kind, id)
  if (!meta) return { status: 400, body: { ok: false, error: `未知的 ${kind} provider：${id}` } }

  const stored = mergeEsp32Config(getStored() ?? {})
  const saved = stored[kind][meta.configKey] ?? {}
  // 密钥（及任何字段）留空 = 用已存值；只接受 registry 声明过的字段
  const values = { ...saved }
  for (const f of meta.fields) {
    const v = body?.values?.[f.key]
    if (!isBlank(v)) values[f.key] = v
  }

  const result = await test({ kind, id, values })
  const out = { ok: result.ok === true, ms: result.ms, persisted: false }
  if (result.ttsFirstMs !== undefined) out.ttsFirstMs = result.ttsFirstMs
  if (result.error) out.error = result.error

  if (out.ok && body?.persist === true && typeof persist === 'function') {
    const patch = buildPersistPatch(kind, id, values, stored)
    try {
      await persist({ esp32: patch })
      out.persisted = true
      const { primary, fallback } = planFailover(kind, id, stored)
      out.primary = primary
      out.fallback = fallback
    } catch (error) {
      out.persistError = '写入配置失败：' + String(error?.message ?? error).slice(0, 200)
    }
  }
  return { status: 200, body: out }
}
