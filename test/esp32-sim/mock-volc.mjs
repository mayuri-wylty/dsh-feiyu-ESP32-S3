// 本地 mock 火山豆包语音服务（仅回环，无外部网络；密钥均为测试假值）。
//   POST /api/v3/auc/bigmodel/recognize/flash   ASR 极速版：状态码在响应头 X-Api-Status-Code
//   POST /api/v3/tts/unidirectional             TTS 单向流式：分块 JSON {code:0,data:b64}…，末尾 code 20000000
//   POST /tts                                   GPT-SoVITS 风格本地 TTS（返回 WAV），供「回退本地」场景
// 可注入：状态码 / 延迟 / 首块前错误码 / 中途错误码 / 断流 / 挂起不结束 / JSON 任意切块。
import http from 'node:http'
import { writePcmWav } from '../../lib/esp32/audio/wav.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 24k 正弦 PCM16 → Buffer（小端）。 */
export function sineBytes(samples, { frequency = 440, sampleRate = 24_000 } = {}) {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 8000), i * 2)
  }
  return buf
}

const defaultAsr = () => ({ statusCode: '20000000', text: '云端识别结果', delayMs: 0, message: '' })
const defaultTts = () => ({
  chunks: [sineBytes(2400), sineBytes(2400, { frequency: 550 })], // Buffer[]，每个一块
  delayMs: 0,        // 首块前延迟
  errorCode: 0,      // 首块前直接返回该错误码（非 0 时不发任何音频）
  errorAfter: 0,     // >0：发完前 N 块后返回 errorAfterCode
  errorAfterCode: 55000000,
  dropAfter: 0,      // >0：发完前 N 块后直接销毁 socket（断流）
  stallAfter: 0,     // >0：发完前 N 块后挂起不结束
  splitAt: 0,        // >0：把整个响应体按该字节数任意切块写出（验证括号深度扫描）
  chunkDelayMs: 0,
})

export async function createMockVolc() {
  const state = { asr: defaultAsr(), tts: defaultTts(), sovits: { status: 200, delayMs: 0 } }
  /** @type {{kind:string, headers:object, body:any}[]} */
  const requests = []
  const sockets = new Set()

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = null
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { body = null }

    if (req.method === 'POST' && req.url === '/api/v3/auc/bigmodel/recognize/flash') {
      requests.push({ kind: 'asr', headers: req.headers, body })
      const a = state.asr
      if (a.delayMs) await sleep(a.delayMs)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Api-Status-Code': String(a.statusCode),
        'X-Api-Message': a.message || (a.statusCode === '20000000' ? 'OK' : 'error'),
      })
      res.end(JSON.stringify(a.statusCode === '20000000' ? { result: { text: a.text } } : {}))
      return
    }

    if (req.method === 'POST' && req.url === '/api/v3/tts/unidirectional') {
      requests.push({ kind: 'tts', headers: req.headers, body })
      const t = state.tts
      if (t.delayMs) await sleep(t.delayMs)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const frames = []
      if (t.errorCode) {
        frames.push(JSON.stringify({ code: t.errorCode, message: 'mock error' }))
      } else {
        t.chunks.forEach((buf, i) => {
          frames.push(JSON.stringify({ code: 0, message: '', data: buf.toString('base64') }))
          frames.push(JSON.stringify({ code: 0, message: '', data: null, sentence: { text: `s${i}` } }))
        })
        frames.push(JSON.stringify({ code: 20000000, message: 'OK', data: null, usage: { text_words: 2 } }))
      }
      // 分块写出：每个 JSON 对象之间故意不换行；可再按 splitAt 任意切。
      const writeParts = async (text) => {
        if (!t.splitAt) { res.write(text); return }
        for (let i = 0; i < text.length; i += t.splitAt) {
          res.write(text.slice(i, i + t.splitAt))
          if ((i / t.splitAt) % 16 === 0) await sleep(2) // 隔几段让出一次，促使 TCP 真正分段
        }
      }
      let audioSent = 0
      for (const frame of frames) {
        const isAudio = frame.includes('"data":"')
        await writeParts(frame)
        if (t.chunkDelayMs) await sleep(t.chunkDelayMs)
        if (isAudio) audioSent += 1
        if (isAudio && t.errorAfter > 0 && audioSent === t.errorAfter) {
          await writeParts(JSON.stringify({ code: t.errorAfterCode, message: 'mock mid-stream error' }))
          break
        }
        if (isAudio && t.dropAfter > 0 && audioSent === t.dropAfter) {
          await sleep(5)
          req.socket.destroy()
          return
        }
        if (isAudio && t.stallAfter > 0 && audioSent === t.stallAfter) return // 不 end，保持连接
      }
      res.end()
      return
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/tts') {
      requests.push({ kind: 'sovits', headers: req.headers, body })
      if (state.sovits.delayMs) await sleep(state.sovits.delayMs)
      if (state.sovits.status !== 200) { res.writeHead(state.sovits.status); res.end('mock sovits error'); return }
      const pcm = new Int16Array(sineBytes(4800, { frequency: 330 }).buffer.slice(0))
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(Buffer.from(writePcmWav(pcm, 24_000, 1)))
      return
    }

    res.writeHead(404)
    res.end()
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    sovitsUrl: `${origin}/tts`,
    requests,
    of: (kind) => requests.filter((r) => r.kind === kind),
    setAsr(patch) { state.asr = { ...defaultAsr(), ...patch } },
    setTts(patch) { state.tts = { ...defaultTts(), ...patch } },
    setSovits(patch) { state.sovits = { ...state.sovits, ...patch } },
    reset() { state.asr = defaultAsr(); state.tts = defaultTts(); state.sovits = { status: 200, delayMs: 0 }; requests.length = 0 },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
