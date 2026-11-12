#!/usr/bin/env node
// 火山 TTS→ASR 回环冒烟。仅读环境变量；不打印 key / headers。
//   VOLC_API_KEY(必填) VOLC_TTS_SPEAKER(必填)
//   VOLC_TTS_RESOURCE_ID(默认 seed-tts-2.0) VOLC_ASR_RESOURCE_ID(默认 volc.bigasr.auc_turbo)
//   --dry：不联网，仅校验环境变量并输出配置状态
import { createVolcengineTts } from '../lib/esp32/tts/volcengine.js'
import { createVolcengineAsr } from '../lib/esp32/asr/volcengine.js'
import { resamplePcm, writePcmWav } from '../lib/esp32/audio/index.js'

const TEXT = '你好，今天天气不错'
const KEYWORDS = ['你好', '天气']
const USAGE = `用法：VOLC_API_KEY=... VOLC_TTS_SPEAKER=... node scripts/esp32-volc-smoke.mjs [--dry]
  VOLC_API_KEY            必填
  VOLC_TTS_SPEAKER        必填（音色，需与资源ID版本匹配）
  VOLC_TTS_RESOURCE_ID    默认 seed-tts-2.0
  VOLC_ASR_RESOURCE_ID    默认 volc.bigasr.auc_turbo
  --dry                   不联网，仅检查配置`

const env = process.env
const dry = process.argv.includes('--dry')
const apiKey = (env.VOLC_API_KEY ?? '').trim()
const speaker = (env.VOLC_TTS_SPEAKER ?? '').trim()
const ttsRes = (env.VOLC_TTS_RESOURCE_ID ?? '').trim() || 'seed-tts-2.0'
const asrRes = (env.VOLC_ASR_RESOURCE_ID ?? '').trim() || 'volc.bigasr.auc_turbo'

if (!apiKey || !speaker) {
  const missing = [!apiKey && 'VOLC_API_KEY', !speaker && 'VOLC_TTS_SPEAKER'].filter(Boolean)
  console.error(`缺少环境变量：${missing.join(', ')}\n${USAGE}`)
  process.exit(2)
}
if (dry) {
  console.log(`[dry] 配置完整（key 已设置，未显示） speaker=${speaker} tts=${ttsRes} asr=${asrRes}，未联网`)
  process.exit(0)
}

const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1) }
const norm = (s) => String(s).replace(/[\s，。,.!！?？]/g, '')

try {
  const tts = createVolcengineTts({ apiKey, speaker, resourceId: ttsRes })
  const t0 = Date.now()
  let first = null
  const chunks = []
  let bytes = 0
  let odd = false
  for await (const c of tts.stream(TEXT)) {
    if (first === null) first = Date.now() - t0
    if (c.sampleRate !== 24000) fail(`采样率异常 ${c.sampleRate}`)
    const n = c.pcm.byteLength
    if (n % 2) odd = true
    bytes += n
    chunks.push(c.pcm)
  }
  const total = Date.now() - t0
  console.log(`TTS 首包=${first ?? '-'}ms 总耗时=${total}ms 总字节=${bytes} 分块=${chunks.length}`)
  if (!bytes) fail('TTS 无音频')
  if (odd || bytes % 2) fail('PCM 字节数非偶数')

  const pcm24 = new Int16Array(bytes / 2)
  let off = 0
  for (const p of chunks) { pcm24.set(p, off); off += p.length }
  const wav = writePcmWav(resamplePcm(pcm24, 24000, 16000), 16000)
  console.log(`WAV 16k 字节=${wav.byteLength}`)

  const asr = createVolcengineAsr({ apiKey, resourceId: asrRes })
  const r = await asr.transcribe({ wav, sampleRate: 16000, language: 'zh' })
  console.log(`ASR 耗时=${r.ms}ms 文本=${r.text}`)
  const hit = KEYWORDS.filter((k) => norm(r.text).includes(k))
  if (!hit.length) fail(`未命中关键词 ${KEYWORDS.join('/')}`)
  console.log(`OK 命中关键词：${hit.join(',')}`)
} catch (e) {
  const msg = String(e?.message ?? e).split(apiKey).join('***')
  fail(`${e?.name ?? 'Error'}: ${msg}`)
}
