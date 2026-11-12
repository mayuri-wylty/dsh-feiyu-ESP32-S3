// ESP32 通道 · Provider 注册表（纯数据 + 辅助函数）
//
// 供设置页动态渲染表单、供 HTTP 层做密钥脱敏/回写保护。
// 不 import 任何适配器实现（asr/*、tts/*），只依赖契约默认值。
//
// 条目形状：
//   { kind:'asr'|'tts', id, label, configKey, local, testable, fields:[Field], presets:[Preset] }
//   Field  = { key, label, type:'string'|'number'|'select'|'password', required, secret, default,
//              placeholder?, options?:[{value,label}], advanced?, hint? }
//   Preset = { id, label, values:{ baseUrl, model } }
// configKey：该 provider 在 esp32.<kind>.<configKey> 下的配置节名（openai-compatible 对应 openai）。

import { DEFAULT_ESP32_CONFIG } from '../contracts.js'

const D = DEFAULT_ESP32_CONFIG

const field = (key, label, type, extra = {}) => ({
  key,
  label,
  type,
  required: false,
  secret: type === 'password',
  default: '',
  ...extra,
})

const endpointField = (def) => field('endpoint', '接入点', 'string', { default: def, advanced: true })

const ASR_OPENAI_PRESETS = [
  { id: 'siliconflow', label: 'SiliconFlow', values: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' } },
  { id: 'groq', label: 'Groq', values: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' } },
  { id: 'openai', label: 'OpenAI', values: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' } },
  { id: 'self-whisper', label: '自建 whisper', values: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1' } },
]

const TTS_CLOUD_PRESETS = [
  { id: 'siliconflow', label: 'SiliconFlow', values: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' } },
  { id: 'openai', label: 'OpenAI', values: { baseUrl: 'https://api.openai.com/v1', model: 'tts-1' } },
]

export const PROVIDERS = Object.freeze([
  {
    kind: 'asr', id: 'sensevoice', label: '本地 SenseVoice', configKey: 'sensevoice',
    local: true, testable: false, fields: [], presets: [],
  },
  {
    kind: 'asr', id: 'openai-compatible', label: 'OpenAI 兼容云 ASR', configKey: 'openai',
    local: false, testable: true,
    fields: [
      field('baseUrl', 'Base URL', 'string', { required: true, placeholder: 'https://api.example.com/v1' }),
      field('apiKey', 'API Key', 'password', { required: true }),
      field('model', '模型', 'string', { required: true, placeholder: 'whisper-1' }),
      field('language', '语言', 'string', { default: D.asr.openai.language, placeholder: 'zh', advanced: true }),
      field('timeoutMs', '超时(ms)', 'number', { default: D.asr.openai.timeoutMs, advanced: true }),
    ],
    presets: ASR_OPENAI_PRESETS,
  },
  {
    kind: 'asr', id: 'volcengine', label: '火山豆包语音 ASR', configKey: 'volcengine',
    local: false, testable: true,
    fields: [
      field('apiKey', 'API Key', 'password', { required: true }),
      field('resourceId', '资源 ID', 'string', { required: true, default: D.asr.volcengine.resourceId }),
      field('modelName', '模型名', 'string', { default: D.asr.volcengine.modelName, advanced: true }),
      endpointField(D.asr.volcengine.endpoint),
      field('timeoutMs', '超时(ms)', 'number', { default: D.asr.volcengine.timeoutMs, advanced: true }),
    ],
    presets: [],
  },
  {
    kind: 'tts', id: 'sovits-sentence', label: '本地 GPT-SoVITS（句级）', configKey: 'sovits-sentence',
    local: true, testable: false, fields: [], presets: [],
  },
  {
    kind: 'tts', id: 'sovits-stream', label: '本地 GPT-SoVITS（流式）', configKey: 'sovits-stream',
    local: true, testable: false, fields: [], presets: [],
  },
  {
    kind: 'tts', id: 'cloud', label: 'OpenAI 兼容云 TTS', configKey: 'cloud',
    local: false, testable: true,
    fields: [
      field('baseUrl', 'Base URL', 'string', { required: true, placeholder: 'https://api.example.com/v1' }),
      field('apiKey', 'API Key', 'password', { required: true }),
      field('model', '模型', 'string', { required: true, placeholder: 'tts-1' }),
      field('voice', '音色', 'string', { required: true, placeholder: 'alloy' }),
      field('speed', '语速', 'number', { default: D.tts.cloud.speed, advanced: true }),
      field('timeoutMs', '超时(ms)', 'number', { default: D.tts.cloud.timeoutMs, advanced: true }),
    ],
    presets: TTS_CLOUD_PRESETS,
  },
  {
    kind: 'tts', id: 'volcengine', label: '火山豆包语音 TTS（流式）', configKey: 'volcengine',
    local: false, testable: true,
    fields: [
      field('apiKey', 'API Key', 'password', { required: true }),
      field('resourceId', '资源 ID', 'string', {
        required: true,
        default: D.tts.volcengine.resourceId,
        hint: 'seed-tts-2.0 仅配 2.0 音色，seed-tts-1.0 仅配 1.0 音色，须与音色版本匹配',
      }),
      field('speaker', '音色', 'string', { required: true, hint: '2.0/1.0 音色需与资源 ID 匹配' }),
      field('speechRate', '语速(-50~100)', 'number', { default: D.tts.volcengine.speechRate, advanced: true }),
      field('loudnessRate', '音量(-50~100)', 'number', { default: D.tts.volcengine.loudnessRate, advanced: true }),
      endpointField(D.tts.volcengine.endpoint),
      field('connectTimeoutMs', '首包超时(ms)', 'number', { default: D.tts.volcengine.connectTimeoutMs, advanced: true }),
      field('idleTimeoutMs', '块间超时(ms)', 'number', { default: D.tts.volcengine.idleTimeoutMs, advanced: true }),
    ],
    presets: [],
  },
])

export const KINDS = Object.freeze(['asr', 'tts'])

export const providerIds = (kind) => PROVIDERS.filter((p) => p.kind === kind).map((p) => p.id)

export function getProvider(kind, id) {
  return PROVIDERS.find((p) => p.kind === kind && p.id === id) ?? null
}

/** 本地兜底：ASR 固定 sensevoice；TTS 优先原本地主，否则 sovits-stream。 */
export const LOCAL_ASR_ID = 'sensevoice'
export const LOCAL_TTS_DEFAULT_ID = 'sovits-stream'

/** 所有密钥字段在 esp32 配置内的路径（段数组），如 ['asr','openai','apiKey']。 */
export function secretPaths() {
  const out = []
  for (const p of PROVIDERS) {
    for (const f of p.fields) if (f.secret) out.push([p.kind, p.configKey, f.key])
  }
  return out
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => JSON.parse(JSON.stringify(v ?? {}))

function parentOf(root, segs) {
  let cur = root
  for (const s of segs.slice(0, -1)) {
    if (!isObj(cur?.[s])) return null
    cur = cur[s]
  }
  return cur
}

/** 返回脱敏副本：各 apiKey 删除并置 hasKey；token 删除并置 tokenSet。 */
export function maskEsp32(cfg) {
  const out = clone(cfg)
  for (const segs of secretPaths()) {
    const parent = parentOf(out, segs)
    if (!parent) continue
    const k = segs[segs.length - 1]
    parent.hasKey = typeof parent[k] === 'string' && parent[k].length > 0
    delete parent[k]
  }
  if ('token' in out) {
    out.tokenSet = typeof out.token === 'string' && out.token.length > 0
    delete out.token
  }
  return out
}

/**
 * 处理前端回写的 esp32 patch：密钥为空串/缺省 = 保持不变（删掉该键）；
 * null 保留（表示清除，由 nullSecretsToBlank 落为 ''）；丢弃 hasKey / tokenSet；token 一律丢弃。
 */
export function stripBlankSecrets(patch) {
  const out = clone(patch)
  for (const segs of secretPaths()) {
    const parent = parentOf(out, segs)
    if (!parent) continue
    const k = segs[segs.length - 1]
    const v = parent[k]
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) delete parent[k]
  }
  const scrub = (o) => {
    if (!isObj(o)) return
    delete o.hasKey
    delete o.tokenSet
    for (const v of Object.values(o)) scrub(v)
  }
  scrub(out)
  delete out.token
  return out
}

/** 把 patch 里的密钥 null 落成 ''（清除）。原地修改并返回。 */
export function nullSecretsToBlank(patch) {
  for (const segs of secretPaths()) {
    const parent = parentOf(patch, segs)
    const k = segs[segs.length - 1]
    if (parent && parent[k] === null) parent[k] = ''
  }
  return patch
}

/** UI 用的 schema 视图（深拷贝，可序列化）。 */
export function schemaView() {
  return JSON.parse(JSON.stringify(PROVIDERS))
}
