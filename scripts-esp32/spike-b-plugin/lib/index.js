/**
 * T03 Spike B —— 临时插件（验证后必须从 desktop profile 卸载）。
 *
 * 目的：
 *   1. 在插件启动后的定时器里调用 ctx.speechToText.resolve/transcribe，
 *      使用一段预录的 16 kHz mono PCM16 中文 WAV，记录耗时与返回文本；
 *   2. 验证 feiyu 插件环境内能否 import('sherpa-onnx-node')；
 *   3. 额外验证从 DSH app.asar 的 sensevoice provider 锚点 require 原生模块，
 *      判断宿主进程能否直接加载 sherpa-onnx（不写 token，不访问网络）。
 *
 * 结果写入 %TEMP%\\dsh-spike-b-result.json，日志写入 %TEMP%\\dsh-spike-b.log。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const NAME = 'dsh-spike-b-speech-probe'
const START_DELAY_MS = Number(process.env.DSH_SPIKE_B_START_DELAY_MS || 8000)
const PROVIDER_ID = process.env.DSH_SPIKE_B_PROVIDER || 'sensevoice-local'
const LANGUAGE = process.env.DSH_SPIKE_B_LANGUAGE || 'zh'
const RESULT_PATH = process.env.DSH_SPIKE_B_RESULT
  || path.join(os.tmpdir(), 'dsh-spike-b-result.json')
const LOG_PATH = process.env.DSH_SPIKE_B_LOG
  || path.join(os.tmpdir(), 'dsh-spike-b.log')
const ALLOW_DOWNLOAD = process.env.DSH_SPIKE_B_ALLOW_DOWNLOAD === '1'
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.DSH_SPIKE_B_TIMEOUT_MS || 180000)
const PREPARE_WAIT_MS = Number(process.env.DSH_SPIKE_B_PREPARE_WAIT_MS || 120000)

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const WAV_CANDIDATES = [
  process.env.DSH_SPIKE_B_WAV,
  path.resolve(moduleDir, '../../spike-b-fixtures/zh-test.wav'),
  path.resolve(process.cwd(), 'scripts-esp32/spike-b-fixtures/zh-test.wav'),
].filter(Boolean)

const report = {
  spike: 'B',
  plugin: NAME,
  pid: process.pid,
  hostProcessPid: process.pid,
  startedAt: new Date().toISOString(),
  done: false,
  pass: false,
  wav: null,
  service: {
    available: false,
    providerId: PROVIDER_ID,
    language: LANGUAGE,
    snapshotBefore: null,
    snapshotAfterPrepare: null,
    prepare: null,
    resolve: null,
    transcribe: null,
  },
  directImport: null,
  anchoredRequire: null,
  error: null,
  finishedAt: null,
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
  try { fs.appendFileSync(LOG_PATH, line + '\n') } catch {}
  console.log('[spike-b] ' + line)
}

function flush() {
  try {
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true })
    fs.writeFileSync(RESULT_PATH, JSON.stringify(report, null, 2), 'utf8')
  } catch (e) {
    log('failed to write result', String(e?.message ?? e))
  }
}

function errorInfo(e) {
  return {
    name: e?.name ?? null,
    code: e?.code ?? null,
    message: String(e?.message ?? e),
    stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 8).join('\n') : null,
  }
}

function findWav() {
  for (const candidate of WAV_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  throw new Error('找不到测试 WAV：' + WAV_CANDIDATES.join(' | '))
}

// 与 DSH validateWave 相同的 canonical 校验，提前在插件侧确认输入合法。
function validateWave(audio) {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (data.length < 46 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE' || data.toString('ascii', 12, 16) !== 'fmt '
    || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1
    || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000
    || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16
    || data.toString('ascii', 36, 40) !== 'data' || data.readUInt32LE(4) !== data.length - 8
    || data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 2 !== 0) {
    throw new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording')
  }
  return (data.length - 44) / 32000
}

function providerState(service, id) {
  const snapshot = service.snapshot()
  const provider = snapshot.providers.find((p) => p.id === id) ?? null
  return {
    snapshot,
    providerId: provider?.id ?? null,
    phase: provider?.preparation?.phase ?? null,
    preparation: provider?.preparation ?? null,
  }
}

async function waitForReady(service, id, waitMs) {
  const deadline = Date.now() + waitMs
  let last = null
  while (Date.now() < deadline) {
    last = providerState(service, id)
    if (last.phase === 'ready' || last.phase === 'standby') return last
    if (last.phase === 'failed' || last.phase === 'cancelled') return last
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return last
}

async function testDirectImport() {
  const entry = { specifier: 'sherpa-onnx-node' }
  try {
    entry.resolved = import.meta.resolve('sherpa-onnx-node')
  } catch (e) {
    entry.resolveError = errorInfo(e)
  }
  try {
    const mod = await import('sherpa-onnx-node')
    entry.ok = true
    entry.version = mod.version ?? null
    entry.onnxruntimeVersion = mod.onnxruntimeVersion ?? null
    entry.gitSha1 = mod.gitSha1 ?? null
    entry.exportKeys = Object.keys(mod).slice(0, 20)
  } catch (e) {
    entry.ok = false
    entry.error = errorInfo(e)
  }
  return entry
}

function readWaveWith(mod, wavPath) {
  try {
    const wave = mod.readWave(wavPath)
    return {
      ok: true,
      sampleRate: wave?.sampleRate ?? null,
      samples: wave?.samples?.length ?? null,
      seconds: wave?.sampleRate && wave?.samples ? wave.samples.length / wave.sampleRate : null,
    }
  } catch (e) {
    return { ok: false, error: errorInfo(e) }
  }
}

function testAnchoredRequire(wavPath) {
  const appRoot = path.dirname(process.execPath)
  const asarAnchor = path.join(
    appRoot, 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-experimental-speech-to-text-sensevoice', 'package.json',
  )
  const extractedAnchor = path.join(
    os.tmpdir(), 'dsh-asar-full', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-experimental-speech-to-text-sensevoice', 'package.json',
  )
  const attempts = [
    { kind: 'dsh-asar-provider', anchor: asarAnchor },
    { kind: 'extracted-asar-provider', anchor: extractedAnchor },
  ]
  const results = []
  for (const attempt of attempts) {
    const entry = { ...attempt }
    try {
      const req = createRequire(attempt.anchor)
      entry.resolved = req.resolve('sherpa-onnx-node')
      const mod = req('sherpa-onnx-node')
      entry.ok = true
      entry.version = mod.version ?? null
      entry.onnxruntimeVersion = mod.onnxruntimeVersion ?? null
      entry.gitSha1 = mod.gitSha1 ?? null
      entry.exportKeys = Object.keys(mod).slice(0, 20)
      entry.readWave = readWaveWith(mod, wavPath)
      results.push(entry)
      return { ok: true, attempts: results }
    } catch (e) {
      entry.ok = false
      entry.error = errorInfo(e)
      results.push(entry)
    }
  }
  return { ok: false, attempts: results }
}

async function run(ctx) {
  log('run start', { pid: process.pid, resultPath: RESULT_PATH, wavCandidates: WAV_CANDIDATES })
  flush()

  const wavPath = findWav()
  const wavBuffer = fs.readFileSync(wavPath)
  const audio = new Uint8Array(wavBuffer)
  const seconds = validateWave(audio)
  report.wav = {
    path: wavPath,
    bytes: audio.byteLength,
    seconds,
    canonical: true,
  }
  log('wav ready', report.wav)
  flush()

  const service = ctx.speechToText
  report.service.available = Boolean(service)
  if (!service) throw new Error('ctx.speechToText 不可用')

  report.service.snapshotBefore = service.snapshot()
  let state = providerState(service, PROVIDER_ID)
  log('provider snapshot', { phase: state.phase, providerId: state.providerId })
  flush()

  if (state.phase !== 'ready' && state.phase !== 'standby') {
    if (state.phase === 'unprepared' && !ALLOW_DOWNLOAD) {
      throw new Error('SenseVoice provider unprepared；模型缓存未就绪，且未开启 DSH_SPIKE_B_ALLOW_DOWNLOAD')
    }
    const prepareStart = Date.now()
    try {
      service.prepare(PROVIDER_ID, {})
      report.service.prepare = { requested: true, ok: true, phaseBefore: state.phase }
    } catch (e) {
      report.service.prepare = { requested: true, ok: false, phaseBefore: state.phase, error: errorInfo(e) }
      throw e
    }
    state = await waitForReady(service, PROVIDER_ID, PREPARE_WAIT_MS)
    report.service.prepare.phaseAfter = state.phase
    report.service.prepare.durationMs = Date.now() - prepareStart
    report.service.prepare.ok = state.phase === 'ready' || state.phase === 'standby'
    log('prepare settled', report.service.prepare)
    flush()
    if (!report.service.prepare.ok) throw new Error(`SenseVoice provider 未就绪：${state.phase}`)
  }
  report.service.snapshotAfterPrepare = state.snapshot
  flush()

  // 1) resolve：服务是同步 API，仍用 await 兼容 Promise 返回。
  const resolveStart = performance.now()
  let spec = null
  try {
    spec = await service.resolve({ audio, language: LANGUAGE })
    report.service.resolve = {
      ok: true,
      durationMs: performance.now() - resolveStart,
      providerId: spec?.provider?.info?.id ?? null,
      language: spec?.language ?? null,
      audioBytes: spec?.audio?.byteLength ?? null,
    }
  } catch (e) {
    report.service.resolve = {
      ok: false,
      durationMs: performance.now() - resolveStart,
      error: errorInfo(e),
    }
    log('resolve failed', report.service.resolve)
    flush()
    throw e
  }
  log('resolve ok', report.service.resolve)
  flush()

  // 2) transcribe：记录完整耗时与服务返回的音频/推理耗时。
  const transcribeStart = performance.now()
  try {
    const result = await service.transcribe(spec, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS))
    report.service.transcribe = {
      ok: true,
      durationMs: performance.now() - transcribeStart,
      text: result?.text ?? null,
      audioSeconds: result?.audioSeconds ?? null,
      inferenceSeconds: result?.inferenceSeconds ?? null,
    }
    report.pass = true
  } catch (e) {
    report.service.transcribe = {
      ok: false,
      durationMs: performance.now() - transcribeStart,
      error: errorInfo(e),
    }
    log('transcribe failed', report.service.transcribe)
  }
  log('transcribe settled', report.service.transcribe)
  flush()

  // 3) 直接 import：模拟 dsh-feiyu 插件自身的模块解析环境。
  report.directImport = await testDirectImport()
  log('direct import', report.directImport)
  flush()

  // 4) 从 DSH 已安装的 sensevoice provider 锚点 require 原生模块。
  report.anchoredRequire = testAnchoredRequire(wavPath)
  log('anchored require', report.anchoredRequire)
  flush()

  report.done = true
  report.finishedAt = new Date().toISOString()
  flush()
  log('run done', { pass: report.pass })
}

export default {
  name: NAME,
  inject: ['speechToText'],
  apply(ctx) {
    let timer = null
    let disposed = false
    log('plugin applied', { startDelayMs: START_DELAY_MS })
    timer = setTimeout(() => {
      if (disposed) return
      run(ctx).catch((e) => {
        report.error = errorInfo(e)
        report.done = true
        report.finishedAt = new Date().toISOString()
        flush()
        log('run failed', report.error)
      })
    }, START_DELAY_MS)

    ctx.effect(() => () => {
      disposed = true
      if (timer) clearTimeout(timer)
      log('plugin disposed')
    })
  },
}
