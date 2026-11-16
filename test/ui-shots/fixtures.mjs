/**
 * ui-shots 假数据：和真实 /dsh-feiyu/api/* 返回同形状（参考 test/client-render.mjs 的 RESPONSES，
 * 但尽量铺满全部卡片）。全部是编造数据：没有密钥 / SSID / 真实局域网 IP
 * （IP 用 RFC 5737 文档段 192.0.2.x，MAC 用 02:00:5e:... 本地管理段）。
 *
 * 所有时间都相对 NOW 计算，而 render-html.mjs 会把 Date.now() 钉死成 NOW，因此输出可逐字节复现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOW = Date.UTC(2026, 10, 16, 12, 0, 0) // 2026-11-16T12:00:00Z

const here = path.dirname(fileURLToPath(import.meta.url))
const connFixtures = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'connections.json'), 'utf8'))
export const CONN_VARIANTS = Object.keys(connFixtures)

const DEVICE_A = '02:00:5e:10:00:01'
const DEVICE_B = '02:00:5e:10:00:02'

const F = (key, label, type, extra = {}) => ({ key, label, type, required: false, secret: type === 'password', ...extra })

export function buildResponses({ conn = 'loggedIn' } = {}) {
  const fx = connFixtures[conn]
  if (!fx) throw new Error(`未知的 --conn：${conn}（可选：${CONN_VARIANTS.join(' / ')}）`)

  const CONFIG = {
    platforms: { bilibili: true, qq: true, wechat: false, douyin: true },
    owner: { qq: '10001', name: '测试主人', mid: '20002', wechat: 'wxid_test_owner' },
    night: { windows: [{ start: '20:00', end: '24:00', wakes: 2 }] },
    quota: { shareDaily: 3 },
    share: { enabled: true, minScore: 13 },
    douyin: {
      maxPerRun: 2, shareDaily: 5, atMention: true, shareToOwner: false, autoComment: true,
      owner: { name: '抖音测试主人' },
      dm: { enabled: true, startWithDsh: false },
      watch: { silent: true },
      freeRoam: { enabled: true, unlimited: false, maxVideos: 10, maxMinutes: 30 },
    },
    bilibili: {
      freeRoam: { enabled: false, unlimited: true, maxVideos: 0, maxMinutes: 0 },
      danmaku: { enabled: true, dailyMax: 5 },
      dynamic: { enabled: false, dailyMax: 2 },
      react: { like: true, coin: false, coinDaily: 1 },
      imageComment: { enabled: true, dailyMax: 2 },
      replies: { enabled: true, dailyMax: 10 },
      fishCircle: { enabled: false },
      follow: { enabled: true },
    },
    qq: { voice_chance: 0.3, stickerChance: 0.5, proactive: { enabled: true, dailyMax: 3, minGapMin: 150 } },
    imageGen: { enabled: true },
    web: { roam: { enabled: true, restMin: 2 }, selfUpgrade: { enabled: false } },
    personality: { evolve: { enabled: true, days: 2 } },
    freedom: { enabled: false },
    esp32: { allowDevices: [DEVICE_A] },
    wechat: { rhythm: 'fast', merge_window_sec: 3, context_n: 12, smart_skip: true },
    voice: { ref_audio_path: 'D:/voices/sunshine_girl/sunshine_girl.wav', prompt_text: '参考文本示例' },
    // 后端 /config 对 llm 段脱敏：删 api_key，加 hasKey
    llm: { base_url: 'https://api.example.com/v1', model: 'example-chat', hasKey: true },
  }

  const VOICES = [
    { name: 'sunshine_girl', ref_audio_path: 'D:/voices/sunshine_girl/sunshine_girl.wav', prompt_text: '参考文本示例', has_prompt: true },
    { name: 'mute', ref_audio_path: 'D:/voices/mute/mute.wav', prompt_text: '', has_prompt: false },
  ]

  const R = {
    '/dsh-feiyu/api/config': { ok: true, config: CONFIG, voices: VOICES, configPath: 'C:/Users/demo/.dsh/feiyu.config.json' },
    '/dsh-feiyu/api/persona': { ok: true, text: '我是大肥鱼，一条住在桌面上的小鱼。\n说话轻松、爱接梗，不装腔。' },
    '/dsh-feiyu/api/memory': {
      ok: true,
      stats: { episodes: 128, lore: 9, facts: 21, byPlatform: { web: 10, qq: 80, douyin: 18, bilibili: 20 } },
      recent: [
        { role: 'user', text: '在吗', chatId: 'qq:10001', platform: 'qq' },
        { role: 'assistant', text: '在的，主人。', chatId: 'qq:10001', platform: 'qq' },
        { role: 'user', text: '今天刷到一个很有意思的视频', chatId: 'douyin:demo', platform: 'douyin' },
        { role: 'assistant', text: '发我看看呀。', chatId: 'douyin:demo', platform: 'douyin' },
      ],
    },
    '/dsh-feiyu/api/status': {
      ok: true, today: '2026-11-16', scheduler: { ok: true, reason: '已启动' },
      sharesToday: 1, sharesMax: 3, commentsToday: 4, mood: { value: 62, hunger: 12 },
      rvcVoice: 'fish-sing-v1',
      qqChannel: { napcat: { ok: true } },
      wxBeat: { ts: NOW - 15_000 },
      dryRun: false, selftestPassed: true, ownerSet: true, configPath: 'C:/Users/demo/.dsh/feiyu.config.json',
    },
    '/dsh-feiyu/api/services': {
      ok: true,
      services: { qq: { running: true, pid: 1234 }, wechat: { running: false, pid: null } },
    },
    '/dsh-feiyu/api/connections': fx,
    '/dsh-feiyu/api/qq/qrcode': {
      ok: true, exists: !!fx.qq.qr.exists, ageSec: fx.qq.qr.ageSec, expired: !!fx.qq.qr.expired,
      // 1x1 透明 PNG：占位二维码，保证字节确定
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    },
    '/dsh-feiyu/api/esp32/status': {
      ok: true, enabled: true, running: true,
      address: { address: '192.0.2.10', family: 'IPv4', port: 8765 },
      publicHost: '192.0.2.10',
      otaUrl: 'http://192.0.2.10:8765/xiaozhi/ota/',
      tokenSet: true,
      asrAvailable: true,
      devices: [
        { deviceId: DEVICE_A, clientId: 'c1', sessionId: 's1', state: 'listening', connectedAt: NOW - 60_000, lastSeenAt: NOW - 3_000, remoteAddress: '192.0.2.50' },
        { deviceId: DEVICE_B, clientId: 'c2', sessionId: 's2', state: 'idle', connectedAt: NOW - 600_000, lastSeenAt: NOW - 125_000, remoteAddress: '192.0.2.51' },
      ],
      lastError: 'connect ECONNREFUSED 127.0.0.1:9880',
    },
    [`/dsh-feiyu/api/esp32/log?device=${encodeURIComponent(DEVICE_A)}&limit=20`]: {
      ok: true, device: DEVICE_A, limit: 20,
      rows: [
        { deviceId: DEVICE_A, role: 'user', text: '你好小智', meta: {} },
        { deviceId: DEVICE_A, role: 'assistant', text: '我在呢，今天想聊点什么？', meta: { latency: { vadMs: 120, asrMs: 340, llmFirstMs: 500, ttsFirstMs: 200, totalMs: 1400 } } },
        { deviceId: DEVICE_A, role: 'user', text: '讲个笑话', meta: {} },
        { deviceId: DEVICE_A, role: 'assistant', text: '为什么小鱼不爱上网？因为怕被网住。', meta: { latency: { vadMs: 110, asrMs: 310, llmFirstMs: 480, ttsFirstMs: 190, totalMs: 1320 } } },
      ],
    },
    '/dsh-feiyu/api/esp32/selfcheck': {
      ok: false,
      checks: [{ id: 'gateway', ok: true }, { id: 'ota', ok: true }, { id: 'ws', ok: false, detail: '握手超时' }, { id: 'token', ok: true }],
    },
    '/dsh-feiyu/api/esp32/providers': {
      ok: true,
      providers: [
        { kind: 'asr', id: 'sensevoice', label: '本地 SenseVoice', configKey: 'sensevoice', local: true, testable: false, fields: [], presets: [] },
        {
          kind: 'asr', id: 'openai-compatible', label: 'OpenAI 兼容云 ASR', configKey: 'openai', local: false, testable: true,
          fields: [F('baseUrl', 'Base URL', 'string'), F('apiKey', 'API Key', 'password', { required: true }), F('model', '模型', 'string')],
          presets: [{ id: 'groq', label: 'Groq', values: { baseUrl: 'https://api.example.com/openai/v1', model: 'whisper-demo' } }],
        },
        { kind: 'tts', id: 'sovits-stream', label: '本地 GPT-SoVITS（流式）', configKey: 'sovits-stream', local: true, testable: false, fields: [], presets: [] },
        {
          kind: 'tts', id: 'volcengine', label: '火山豆包语音 TTS（流式）', configKey: 'volcengine', local: false, testable: true,
          fields: [F('apiKey', 'API Key', 'password', { required: true }), F('speaker', '音色', 'string', { hint: '2.0/1.0 音色需与资源 ID 匹配' })],
          presets: [],
        },
      ],
      current: {
        asr: { primary: 'sensevoice', fallback: '', values: { openai: { baseUrl: 'https://api.example.com/v1', model: 'whisper-demo', hasKey: true } } },
        tts: { primary: 'sovits-stream', fallback: '', values: { volcengine: { speaker: 'zh_female_demo', hasKey: false } } },
      },
      pipeline: {
        asr: { primary: 'openai-compatible', fallback: 'sensevoice', ready: false, error: 'demo: 云端 ASR 超时' },
        tts: { primary: 'volcengine', ready: true },
        degraded: true, reason: 'ASR 云端不可用',
      },
    },
  }
  return R
}
