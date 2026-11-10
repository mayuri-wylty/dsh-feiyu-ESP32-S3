#!/usr/bin/env node
// T29：GPT-SoVITS 两个 ESP32 TTS provider 的对比基准（sovits-sentence vs sovits-stream）
//
// 目的：用同一批语料、同一条串行队列，量出「首包延迟 / 总时长 / 失败率 / 实时率」，
// 给 ESP32 实时通道选默认 provider 提供数据（用户等的是第一声，首包最重要）。
//
// 用法：
//   node test/esp32-tts-bench.mjs            # 真实跑（需要 9880 在线 + 参考音频）
//   node test/esp32-tts-bench.mjs --fake     # 不连 9880，用 fake fetch 自检脚本逻辑
//   node test/esp32-tts-bench.mjs --json     # 机器可读结果（stdout 只有 JSON）
//   node test/esp32-tts-bench.mjs --fake-429 # 只验证 429 指数退避重试路径
//
// 参考音频来源（按优先级）：
//   1. 环境变量 FEIYU_TTS_REF_AUDIO / FEIYU_TTS_PROMPT_TEXT
//   2. config().voice.ref_audio_path / prompt_text（~/.dsh/feiyu.config.json）
// 两者都没有时：打印提示，自动降级为 --fake，退出码 0（不让环境缺失变成失败）。
//
// ⚠️ 本文件**不**进 npm test 的语义范围：package.json 的 glob `test/esp32-*.mjs` 会扫到它，
//   所以文件开头检测 NODE_TEST_CONTEXT，在 node --test 下直接跳过（退出码 0）。
//   它依赖真实 9880，只能手动跑。
//
// ⚠️ 不写任何绝对路径/凭据进仓库：参考音频路径只从配置或环境变量读，输出里只打 basename。

import { config } from '../tools/lib/config.mjs'
import { createSovitsSentenceProvider } from '../lib/esp32/tts/sovits-sentence.js'
import { createSovitsStreamProvider } from '../lib/esp32/tts/sovits-stream.js'
import { getTtsQueue } from '../lib/esp32/tts/queue.js'

// ── node --test 下直接跳过（npm test 的 glob 会扫到这个文件）─────────────────
if (process.env.NODE_TEST_CONTEXT) {
  console.log('[tts-bench] skipped under node --test（需要真实 GPT-SoVITS，手动运行）')
  process.exit(0)
}

// ── 20 句测试语料（硬编码；5~40 字，覆盖短句/长句/标点/情绪词）──────────────
export const CORPUS = Object.freeze([
  '你好呀，我是大肥鱼。',
  '今天也要好好吃饭哦。',
  '嗯，我在听。',
  '主人，你回来啦！',
  '这个嘛……让我想想。',
  '哇，真的假的？太厉害了吧！',
  '我有点困了，想睡觉。',
  '别担心，一切都会好起来的。',
  '哼，你都不理我。',
  '今天的天气真不错，我们出去走走吧。',
  '你知道吗，鲸鱼其实是用肺呼吸的。',
  '好开心呀，终于等到这一天了！',
  '那个……我是不是说错话了？',
  '请把窗户关上，风有点大。',
  '如果明天不下雨，我们就去海边看日出吧。',
  '这道菜看起来好好吃，我能尝一口吗？',
  '唉，时间过得真快，一转眼就天黑了。',
  '我觉得吧，这件事还得从长计议，不能太着急。',
  '你听，外面好像下雨了，滴滴答答的。',
  '不管发生什么，我都会一直陪在你身边的，所以别怕。',
])

const PROVIDERS = Object.freeze(['sovits-sentence', 'sovits-stream'])
const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]) // 429 指数退避，最多 5 次重试
const PROBE_TIMEOUT_MS = 3000
const SENTENCE_GAP_MS = 100

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = new Set(process.argv.slice(2))
if (argv.has('--help') || argv.has('-h')) {
  console.log(`用法: node test/esp32-tts-bench.mjs [--fake] [--json] [--fake-429]

  --fake      不连 9880，用 fake fetch 返回固定 WAV，只验证脚本自身逻辑
  --json      stdout 只输出机器可读 JSON（进度日志走 stderr）
  --fake-429  只跑一次 429 退避重试自检（不连 9880）

参考音频：环境变量 FEIYU_TTS_REF_AUDIO / FEIYU_TTS_PROMPT_TEXT，
或 config().voice.ref_audio_path / prompt_text。`)
  process.exit(0)
}
const wantJson = argv.has('--json')
const forceFake = argv.has('--fake')
const check429 = argv.has('--fake-429')

/** 进度/诊断一律走 stderr，保证 --json 时 stdout 干净。 */
function log(msg) {
  process.stderr.write(`${msg}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 参考音频解析（不落盘、不打印绝对路径）──────────────────────────────────
function resolveRef() {
  const v = config().voice ?? {}
  const audio = String(process.env.FEIYU_TTS_REF_AUDIO || v.ref_audio_path || '').trim()
  const prompt = String(process.env.FEIYU_TTS_PROMPT_TEXT || v.prompt_text || '').trim()
  if (!audio) return null
  return { ref_audio_path: audio, prompt_text: prompt, from: process.env.FEIYU_TTS_REF_AUDIO ? 'env' : 'config' }
}

function basenameOf(p) {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

// ── 9880 可达性探测 ────────────────────────────────────────────────────────
async function probeSovits(url) {
  const base = String(url || '').replace(/\/tts\/?$/, '') || 'http://127.0.0.1:9880'
  try {
    // 任何 HTTP 响应（含 404）都说明服务在线；只有连接失败才算不可达
    await fetch(base, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return true
  } catch {
    return false
  }
}

// ── fake fetch：固定 WAV，按 streaming_mode 决定整包还是分块 ────────────────
function makeFakeFetch() {
  return async function fakeFetch(_url, init) {
    const body = JSON.parse(init?.body || '{}')
    const streaming = body.streaming_mode === 2
    const chars = String(body.text || '').length
    const seconds = Math.min(4, Math.max(0.6, 0.6 + chars * 0.12))
    const sampleRate = 32000
    const frames = Math.round(sampleRate * seconds)
    const pcm = Buffer.alloc(frames * 2)
    for (let i = 0; i < frames; i++) {
      pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)), i * 2)
    }
    if (!streaming) {
      return new Response(wavWithData(pcm, sampleRate), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    }
    // 流式：44 字节头（data size = 0）+ 裸 PCM16LE，分 4 块、每块间隔 30ms
    const header = wavHeader({ sampleRate, dataSize: 0 })
    const parts = splitEven(pcm, 4)
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(header))
        for (const part of parts) {
          await sleep(30)
          controller.enqueue(new Uint8Array(part))
        }
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
  }
}

function wavHeader({ sampleRate = 32000, channels = 1, bits = 16, dataSize = 0 } = {}) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataSize, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * (bits / 8), 28)
  h.writeUInt16LE(channels * (bits / 8), 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataSize, 40)
  return h
}

function wavWithData(pcm, sampleRate) {
  return Buffer.concat([wavHeader({ sampleRate, dataSize: pcm.length }), pcm])
}

function splitEven(buf, n) {
  const out = []
  const size = Math.ceil(buf.length / n)
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size))
  return out
}

// ── 单句测量 ───────────────────────────────────────────────────────────────
async function measureOnce(provider, text) {
  const t0 = performance.now()
  let firstChunkMs = null
  let chunks = 0
  let samples = 0
  let sampleRate = 0
  for await (const chunk of provider.stream(text)) {
    if (firstChunkMs === null) firstChunkMs = performance.now() - t0
    chunks += 1
    samples += chunk.pcm.length
    sampleRate = chunk.sampleRate
  }
  const totalMs = performance.now() - t0
  if (!chunks) throw new Error('provider 没有产出任何 chunk')
  return {
    firstChunkMs: round1(firstChunkMs),
    totalMs: round1(totalMs),
    audioSeconds: round3(sampleRate ? samples / sampleRate : 0),
    chunks,
    sampleRate,
    samples,
  }
}

function is429(e) {
  return e?.status === 429 || /HTTP\s*429/.test(String(e?.message || ''))
}

/** 429 指数退避：1s,2s,4s,8s,16s，最多 5 次重试；其它错误直接抛出。 */
async function measureWithRetry(provider, text, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await measureOnce(provider, text)
    } catch (e) {
      if (is429(e) && attempt < BACKOFF_MS.length) {
        const wait = BACKOFF_MS[attempt]
        log(`  [429] ${label} 被限流，${wait}ms 后重试（${attempt + 1}/${BACKOFF_MS.length}）`)
        await sleep(wait)
        continue
      }
      throw e
    }
  }
}

// ── 统计 ───────────────────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (!sorted.length) return 0
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function summarize(rows) {
  const ok = rows.filter((r) => r.ok)
  const firsts = ok.map((r) => r.firstChunkMs).sort((a, b) => a - b)
  const totals = ok.map((r) => r.totalMs).sort((a, b) => a - b)
  const rtfs = ok.map((r) => (r.totalMs > 0 ? r.audioSeconds / (r.totalMs / 1000) : 0))
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const sampleRates = [...new Set(ok.map((r) => r.sampleRate))]
  return {
    total: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    failureRate: rows.length ? round3((rows.length - ok.length) / rows.length) : 0,
    firstChunkMs: {
      p50: round1(percentile(firsts, 0.5)),
      p90: round1(percentile(firsts, 0.9)),
      mean: round1(mean(firsts)),
      min: round1(firsts[0] ?? 0),
      max: round1(firsts[firsts.length - 1] ?? 0),
    },
    totalMs: {
      p50: round1(percentile(totals, 0.5)),
      p90: round1(percentile(totals, 0.9)),
      mean: round1(mean(totals)),
      min: round1(totals[0] ?? 0),
      max: round1(totals[totals.length - 1] ?? 0),
    },
    // 实时率 = 音频秒数 / 墙钟秒数；>1 表示比实时快，<1 表示跟不上
    realtimeFactor: round3(mean(rtfs)),
    audioSecondsMean: round3(mean(ok.map((r) => r.audioSeconds))),
    sampleRates,
  }
}

// ── 跑一个 provider 的全部语料（严格串行）──────────────────────────────────
async function runProvider(id, { fake, ref }) {
  const queue = getTtsQueue() // 与生产同一条进程内串行队列
  const options = { queue, ref }
  if (fake) options.fetch = makeFakeFetch()
  const provider = id === 'sovits-sentence'
    ? createSovitsSentenceProvider(options)
    : createSovitsStreamProvider(options)

  const rows = []
  for (let i = 0; i < CORPUS.length; i++) {
    const text = CORPUS[i]
    const label = `${id} #${i + 1}`
    try {
      const m = await measureWithRetry(provider, text, label)
      rows.push({ index: i + 1, text, ok: true, ...m })
      log(`  ${label} ok  first=${m.firstChunkMs}ms total=${m.totalMs}ms audio=${m.audioSeconds}s chunks=${m.chunks}`)
    } catch (e) {
      rows.push({ index: i + 1, text, ok: false, error: String(e?.message || e).slice(0, 200) })
      log(`  ${label} FAIL ${String(e?.message || e).slice(0, 160)}`)
    }
    if (i < CORPUS.length - 1) await sleep(SENTENCE_GAP_MS)
  }
  return { id, rows, summary: summarize(rows) }
}

// ── 429 退避自检 ───────────────────────────────────────────────────────────
async function selfCheck429() {
  let calls = 0
  const fakeFetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return makeFakeFetch()('http://fake/tts', { body: JSON.stringify({ text: '自检', streaming_mode: false }) })
  }
  const provider = createSovitsSentenceProvider({
    queue: getTtsQueue(),
    ref: { ref_audio_path: 'fake://ref.wav', prompt_text: 'fake' },
    fetch: fakeFetch,
  })
  const t0 = Date.now()
  const m = await measureWithRetry(provider, '自检一下。', 'self-check-429')
  const elapsed = Date.now() - t0
  const pass = calls === 2 && elapsed >= BACKOFF_MS[0] - 50
  console.log(`429 退避自检：${pass ? 'PASS' : 'FAIL'}（请求 ${calls} 次，耗时 ${elapsed}ms，首包 ${m.firstChunkMs}ms）`)
  return pass ? 0 : 1
}

// ── 输出 ───────────────────────────────────────────────────────────────────
function printText(report) {
  const out = []
  out.push('')
  out.push(`=== GPT-SoVITS TTS 基准（${report.mode === 'fake' ? 'fake 自检' : '真实 9880'}）===`)
  out.push(`node ${report.node} · 语料 ${report.corpusSize} 句 · 串行队列 · 参考音频 ${report.ref.hasRef ? `已配置（${report.ref.basename}）` : '未配置'}`)
  out.push('')
  for (const id of PROVIDERS) {
    const r = report.providers[id]
    const s = r.summary
    out.push(`── ${id} ──`)
    out.push(`  首包 ms   P50 ${s.firstChunkMs.p50}  P90 ${s.firstChunkMs.p90}  均值 ${s.firstChunkMs.mean}  (min ${s.firstChunkMs.min} / max ${s.firstChunkMs.max})`)
    out.push(`  总时长 ms P50 ${s.totalMs.p50}  P90 ${s.totalMs.p90}  均值 ${s.totalMs.mean}  (min ${s.totalMs.min} / max ${s.totalMs.max})`)
    out.push(`  失败率    ${s.failed}/${s.total} (${(s.failureRate * 100).toFixed(1)}%)`)
    out.push(`  实时率    ${s.realtimeFactor}x（音频秒数 / 墙钟秒数，>1 比实时快）`)
    out.push(`  采样率    ${s.sampleRates.join(', ') || '-'} · 平均音频 ${s.audioSecondsMean}s`)
    out.push('')
    out.push('  #  首包ms  总ms  音频s  块  文本')
    for (const row of r.rows) {
      if (!row.ok) {
        out.push(`  ${String(row.index).padStart(2)}  FAIL  ${row.error}`)
        continue
      }
      out.push(`  ${String(row.index).padStart(2)}  ${String(row.firstChunkMs).padStart(6)}  ${String(row.totalMs).padStart(5)}  ${String(row.audioSeconds).padStart(5)}  ${String(row.chunks).padStart(2)}  ${row.text}`)
    }
    out.push('')
  }
  process.stdout.write(out.join('\n') + '\n')
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  if (check429) return selfCheck429()

  const ref = resolveRef()
  let fake = forceFake
  let mode = fake ? 'fake' : 'real'

  if (!fake) {
    if (!ref) {
      log('[tts-bench] 未配置参考音频：config().voice.ref_audio_path 为空，且未设置 FEIYU_TTS_REF_AUDIO。')
      log('[tts-bench] 真实合成需要显式 ref（否则 9880 返回 400 ref_audio_path is required）。')
      log('[tts-bench] 自动降级为 --fake 自检。设置方式：')
      log('  $env:FEIYU_TTS_REF_AUDIO="<参考音频绝对路径>"; $env:FEIYU_TTS_PROMPT_TEXT="<参考音频对应文本>"')
      fake = true
      mode = 'fake'
    } else {
      const url = config().voice?.sovits_url
      const up = await probeSovits(url)
      if (!up) {
        log(`[tts-bench] 9880 不可达（${url || 'http://127.0.0.1:9880/tts'}），自动降级为 --fake 自检。`)
        fake = true
        mode = 'fake'
      }
    }
  }

  const effectiveRef = fake
    ? { ref_audio_path: 'fake://ref.wav', prompt_text: 'fake' }
    : ref

  log(`[tts-bench] 模式=${mode} 语料=${CORPUS.length} 句 × ${PROVIDERS.length} provider（串行）`)
  if (!fake) log(`[tts-bench] 参考音频=${basenameOf(ref.ref_audio_path)} 参考文本=${ref.prompt_text.length} 字`)

  const providers = {}
  for (const id of PROVIDERS) {
    log(`[tts-bench] 开始 ${id}`)
    providers[id] = await runProvider(id, { fake, ref: effectiveRef })
  }

  const report = {
    mode,
    node: process.version,
    corpusSize: CORPUS.length,
    ref: {
      hasRef: Boolean(ref),
      basename: ref ? basenameOf(ref.ref_audio_path) : '',
      promptChars: ref ? ref.prompt_text.length : 0,
      source: ref?.from ?? '',
    },
    providers,
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printText(report)
  }
  return 0
}

function round1(n) { return Math.round(Number(n) * 10) / 10 }
function round3(n) { return Math.round(Number(n) * 1000) / 1000 }

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    log(`[tts-bench] 失败：${e?.stack || e}`)
    process.exit(1)
  },
)
