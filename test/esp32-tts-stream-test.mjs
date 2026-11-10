// ESP32 第五通道 · T18「GPT-SoVITS 流式 TTS」测试
//
// 覆盖：
// 1. 请求组装：重复用 buildSovitsRequest，streaming_mode 必须是整数 2、media_type=wav；
// 2. 增量解码：44 字节头只出现一次 + 裸 PCM16LE、头跨网络 chunk、奇数字节余量、
//    多声道下混、WAV_FORMAT_EXTENSIBLE；
// 3. 首块尽早产出：头一到就开始 yield，不等整句；
// 4. 失败：HTTP 400 JSON（脱敏/截断）、200 非 WAV（JSON/HTML/空 body/只有头）；
// 5. 超时：空闲超时覆盖首字节与中途卡死，但持续有数据的长句不误杀；
// 6. abort：停止产出、立即终止 fetch、释放队列；排队中 abort 不请求 9880；
// 7. 队列：整条流占用串行槽位，两条并发流的最大并发数 = 1；消费方提前 break 也释放。
//
// 全部使用 fake fetch / 本地 node:http，不连真实 9880，不读真实配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// config.mjs 的 paths.mjs 在 import 时解析路径，必须先隔离环境再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-tts-stream-'))
process.env.FEIYU_DATA_DIR = path.join(TMP, 'data')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.writeFileSync(process.env.FEIYU_CONFIG, '{}')

const {
  createSovitsStreamProvider,
  sovitsStreamProvider,
  SOVITS_STREAM_ID,
  createWavStreamDecoder,
  sanitizeErrorText,
} = await import('../lib/esp32/tts/sovits-stream.js')
const { createTtsQueue } = await import('../lib/esp32/tts/queue.js')
const { TTS_PROVIDER_IDS } = await import('../lib/esp32/contracts.js')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ── 测试工具 ───────────────────────────────────────────────────────────────

const REF = { ref_audio_path: 'C:/fake/emo.wav', prompt_text: '情绪参考', from: 'test' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs = 3000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await sleep(5)
  }
}

function pcmBuf(samples) {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2)
  return buf
}

/** 44 字节 WAV 头；默认与 api_v2 的 wave_header_chunk 一致（mono/16bit/data size=0）。 */
function wavHeader({
  sampleRate = 32000,
  channels = 1,
  bits = 16,
  format = 1,
  dataSize = 0,
  dataChunk = true,
  extensible = false,
} = {}) {
  const fmtSize = extensible ? 40 : 16
  const h = Buffer.alloc(12 + 8 + fmtSize + (dataChunk ? 8 : 0))
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(4 + 8 + fmtSize + 8, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(fmtSize, 16)
  h.writeUInt16LE(extensible ? 0xfffe : format, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(bits, 34)
  if (extensible) {
    h.writeUInt16LE(22, 36)
    h.writeUInt16LE(bits, 38)
    h.writeUInt32LE(4, 40)
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(h, 44)
  }
  if (dataChunk) {
    const off = 20 + fmtSize
    h.write('data', off, 'ascii')
    h.writeUInt32LE(dataSize, off + 4)
  }
  return h
}

const toU8 = (b) => (Buffer.isBuffer(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b)

/** 用预置 chunk 生成一个 Response；chunk 边界 = 网络 chunk 边界。 */
function streamResponse(chunks, { status = 200, contentType = 'audio/wav', delayMs = 0, onCancel } = {}) {
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const c of chunks) {
          if (delayMs) await sleep(delayMs)
          controller.enqueue(toU8(c))
        }
        controller.close()
      } catch (e) {
        try { controller.error(e) } catch {}
      }
    },
    cancel(reason) { onCancel?.(reason) },
  })
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

/** 注入 fake fetch：记录每次请求；respond 可返回 Response 或 Promise。 */
function captureFetch(respond) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init, calls.length)
  }
  return { calls, fetch }
}

function fakeProvider({ fetch, queue = createTtsQueue(), timeoutMs, warn } = {}) {
  return createSovitsStreamProvider({
    url: 'http://fake.local/tts',
    queue,
    ref: REF,
    voice: {},
    fetch,
    timeoutMs,
    warn,
  })
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

function concatPcm(chunks) {
  const length = chunks.reduce((n, c) => n + c.pcm.length, 0)
  const out = new Int16Array(length)
  let off = 0
  for (const c of chunks) { out.set(c.pcm, off); off += c.pcm.length }
  return out
}

async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/tts`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

// ── 1. 请求 / 契约 ─────────────────────────────────────────────────────────

test('provider 契约：id=sovits-stream，请求 streaming_mode 为整数 2', async () => {
  assert.equal(SOVITS_STREAM_ID, 'sovits-stream')
  assert.ok(TTS_PROVIDER_IDS.includes(SOVITS_STREAM_ID))
  assert.equal(sovitsStreamProvider.id, 'sovits-stream')

  const wav = Buffer.concat([wavHeader({ sampleRate: 24000 }), pcmBuf([0, 1, -1])])
  const capture = captureFetch(() => streamResponse([wav]))
  const provider = fakeProvider({ fetch: capture.fetch })

  const chunks = await collect(provider.stream('[[开心]] 你好呀 (・_・;) 🐟', { emotion: 'happy' }))
  assert.equal(capture.calls.length, 1)
  const init = capture.calls[0].init
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['Content-Type'], 'application/json')
  const body = JSON.parse(init.body)
  assert.equal(body.streaming_mode, 2)
  assert.equal(typeof body.streaming_mode, 'number')
  assert.notEqual(body.streaming_mode, true) // bool True 在 Python 里 == 1，会走 return_fragment
  assert.equal(body.media_type, 'wav')
  assert.equal(body.text, '你好呀')
  assert.equal(body.ref_audio_path, REF.ref_audio_path)
  assert.equal(body.temperature, 1.45) // happy 的情绪参数仍然生效

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].sampleRate, 24000)
  assert.deepEqual([...chunks[0].pcm], [0, 1, -1])
})

test('空文本：不请求 9880，直接给出清晰中文错误', async () => {
  let calls = 0
  const provider = fakeProvider({
    fetch: async () => { calls += 1; throw new Error('不该发请求') },
  })
  await assert.rejects(collect(provider.stream(' (・_・;) 🐟 ')), /可念|GBK/)
  assert.equal(calls, 0)
})

test('signal 已取消：不请求 9880', async () => {
  let calls = 0
  const provider = fakeProvider({
    fetch: async () => { calls += 1; throw new Error('不该发请求') },
  })
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(collect(provider.stream('你好', { signal: ctrl.signal })), (e) => e.name === 'AbortError')
  assert.equal(calls, 0)
})

// ── 2. 增量解码 ────────────────────────────────────────────────────────────

test('解码：一整个网络 chunk（头 + 裸 PCM）', async () => {
  const wav = Buffer.concat([wavHeader({ sampleRate: 32000 }), pcmBuf([100, -200, 300])])
  const provider = fakeProvider({ fetch: async () => streamResponse([wav]) })
  const chunks = await collect(provider.stream('你好'))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].sampleRate, 32000)
  assert.deepEqual([...chunks[0].pcm], [100, -200, 300])
})

test('解码：头跨多个 chunk 拼接 + 裸 PCM 任意分块，头只出现一次', async () => {
  const header = wavHeader({ sampleRate: 24000 })
  const pcm = pcmBuf([1, 2, 3, 4, 5, 6])
  const chunksIn = [
    header.subarray(0, 7),
    header.subarray(7, 19),
    header.subarray(19, 32),
    header.subarray(32, 44),
    pcm.subarray(0, 2),
    pcm.subarray(2, 7),
    pcm.subarray(7, 12),
  ]
  const provider = fakeProvider({ fetch: async () => streamResponse(chunksIn) })
  const chunks = await collect(provider.stream('你好'))
  assert.ok(chunks.length >= 2, '应边收边产出多块')
  assert.equal(chunks[0].sampleRate, 24000)
  assert.deepEqual([...concatPcm(chunks)], [1, 2, 3, 4, 5, 6])
})

test('解码：奇数字节余量跨 chunk 拼接，流末尾 1 字节残量丢弃并告警', async () => {
  const header = wavHeader({ sampleRate: 32000 })
  const pcm = pcmBuf([1000, -1000, 2000]) // 6 字节
  const warnings = []
  const provider = fakeProvider({
    warn: (m) => warnings.push(m),
    fetch: async () => streamResponse([
      header,
      pcm.subarray(0, 1), // 半个 sample
      pcm.subarray(1, 5), // 再半个 + 一个半
      pcm.subarray(5, 6),
      Buffer.from([0x7f]), // 流末孤立 1 字节：不足一帧，丢弃
    ]),
  })
  const chunks = await collect(provider.stream('你好'))
  assert.deepEqual([...concatPcm(chunks)], [1000, -1000, 2000])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /残量 1 字节/)
})

test('解码：多声道按帧平均下混为 mono，帧可能跨 chunk', async () => {
  const header = wavHeader({ sampleRate: 32000, channels: 2 })
  // 帧： [100,300] → 200；[-1000,0] → -500；[1,2] → round(1.5)=2
  const pcm = pcmBuf([100, 300, -1000, 0, 1, 2])
  const provider = fakeProvider({
    fetch: async () => streamResponse([
      header,
      pcm.subarray(0, 3), // 第 1 帧只到了一半
      pcm.subarray(3, 8),
      pcm.subarray(8, 12),
    ]),
  })
  const chunks = await collect(provider.stream('你好'))
  assert.deepEqual([...concatPcm(chunks)], [200, -500, 2])
  assert.equal(chunks[0].sampleRate, 32000)
})

test('解码：WAVE_FORMAT_EXTENSIBLE（SubFormat=PCM）', async () => {
  const header = wavHeader({ sampleRate: 24000, extensible: true })
  const provider = fakeProvider({
    fetch: async () => streamResponse([header, pcmBuf([7, -7])]),
  })
  const chunks = await collect(provider.stream('你好'))
  assert.deepEqual([...concatPcm(chunks)], [7, -7])
})

test('解码器：同一 chunk 内头 + 多帧只产出一次；flush 统计正确', () => {
  const decoder = createWavStreamDecoder({ warn: () => {} })
  const header = wavHeader({ sampleRate: 16000 })
  const pcm = pcmBuf([11, 22, 33, 44])
  const first = decoder.push(Buffer.concat([header, pcm]))
  assert.deepEqual([...first.pcm], [11, 22, 33, 44])
  assert.equal(decoder.push(Buffer.alloc(0)), null)
  const stats = decoder.flush()
  assert.equal(stats.sampleRate, 16000)
  assert.equal(stats.channels, 1)
  assert.equal(stats.bits, 16)
  assert.equal(stats.totalSamples, 4)
  assert.equal(stats.discardedBytes, 0)
})

// ── 3. 首块尽早产出 ────────────────────────────────────────────────────────

test('首块：头 + 2 个样本一到就 yield，不等整句结束', async () => {
  let releaseRest
  const restGate = new Promise((resolve) => { releaseRest = resolve })
  const header = wavHeader({ sampleRate: 24000 })
  let cancelled = false
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(toU8(header))
      controller.enqueue(toU8(pcmBuf([42, -42])))
      await restGate
      controller.enqueue(toU8(pcmBuf([1, 2, 3, 4])))
      controller.close()
    },
    cancel() { cancelled = true },
  })
  const provider = fakeProvider({ fetch: async () => new Response(body, { status: 200 }) })

  const it = provider.stream('你好')[Symbol.asyncIterator]()
  const t0 = Date.now()
  const first = await it.next()
  const firstMs = Date.now() - t0
  assert.equal(first.done, false)
  assert.deepEqual([...first.value.pcm], [42, -42])
  assert.ok(firstMs < 150, `首块耗时 ${firstMs}ms，应远小于整句结束`)

  releaseRest()
  const rest = []
  for (;;) {
    const step = await it.next()
    if (step.done) break
    rest.push(step.value)
  }
  assert.deepEqual([...concatPcm(rest)], [1, 2, 3, 4])
  assert.equal(cancelled, false)
})

// ── 4. 失败路径 ────────────────────────────────────────────────────────────

test('HTTP 400 JSON：带出服务端信息，但 apiKey / 绝对路径被脱敏、只取前 300 字符', async () => {
  const longTail = 'TAIL_MARKER_SHOULD_NOT_APPEAR'
  const errorBody = JSON.stringify({
    message: 'tts failed',
    Exception:
      'ref_audio_path is C:\\Users\\alice\\private\\feiyu.wav api_key=sk-SECRET123 ' +
      'Bearer abc.def.ghi ' + 'x'.repeat(400) + longTail,
  })
  const srv = await startServer(async (req, res) => {
    await readBody(req)
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(errorBody)
  })
  try {
    const provider = createSovitsStreamProvider({
      url: srv.url, queue: createTtsQueue(), ref: REF, voice: {},
    })
    await assert.rejects(collect(provider.stream('你好')), (e) => {
      assert.match(e.message, /GPT-SoVITS 流式 HTTP 400/)
      assert.match(e.message, /tts failed/)
      assert.doesNotMatch(e.message, /SECRET123/)
      assert.doesNotMatch(e.message, /alice|private|feiyu\.wav/)
      assert.doesNotMatch(e.message, /TAIL_MARKER_SHOULD_NOT_APPEAR/)
      assert.ok(e.message.length < 500, `错误信息过长：${e.message.length}`)
      return true
    })
  } finally {
    await srv.close()
  }
})

test('HTTP 400 但错误 body 卡住：空闲超时仍能结束，不无限挂起', async () => {
  const srv = await startServer((req, res) => {
    req.resume()
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.write('{"message":"tts failed"') // 故意不 end，模拟错误 body 卡死
  })
  try {
    const q = createTtsQueue()
    const provider = createSovitsStreamProvider({
      url: srv.url, queue: q, ref: REF, voice: {}, timeoutMs: 80,
    })
    const t0 = Date.now()
    await assert.rejects(collect(provider.stream('你好')), (e) => e.name === 'TimeoutError')
    assert.ok(Date.now() - t0 < 2000, '错误 body 卡死也应快速超时')
    await waitFor(() => q.stats().running === 0)
    assert.equal(q.size(), 0)
    assert.equal(await q.enqueue(async () => 'ok'), 'ok')
  } finally {
    await srv.close()
  }
})

test('HTTP 503 无 body：仍然给出清晰错误', async () => {
  const provider = fakeProvider({
    fetch: async () => new Response(null, { status: 503 }),
  })
  await assert.rejects(collect(provider.stream('你好')), /HTTP 503/)
})

test('200 但返回 JSON（非 WAV）：翻译成中文错误并带出服务端信息', async () => {
  const provider = fakeProvider({
    fetch: async () => streamResponse([Buffer.from(JSON.stringify({
      message: 'tts failed',
      Exception: 'stream produced no PCM audio',
    }))], { contentType: 'application/json' }),
  })
  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.match(e.message, /不是音频|不是 WAV/)
    assert.match(e.message, /stream produced no PCM audio/)
    return true
  })
})

test('200 但返回 HTML/空 body/只有头：分别给出清晰错误', async () => {
  {
    const provider = fakeProvider({
      fetch: async () => streamResponse([Buffer.from('<html><body>bad gateway</body></html>')], { contentType: 'text/html' }),
    })
    await assert.rejects(collect(provider.stream('你好')), /不是 WAV/)
  }
  {
    const provider = fakeProvider({ fetch: async () => streamResponse([]) })
    await assert.rejects(collect(provider.stream('你好')), /为空|WAV 头完成前结束/)
  }
  {
    const provider = fakeProvider({ fetch: async () => streamResponse([wavHeader()]) })
    await assert.rejects(collect(provider.stream('你好')), /没有 PCM 数据/)
  }
})

test('非 PCM16 头：明确报错', async () => {
  {
    const provider = fakeProvider({
      fetch: async () => streamResponse([wavHeader({ format: 3, bits: 32 }), Buffer.alloc(8)]),
    })
    await assert.rejects(collect(provider.stream('你好')), /编码格式 3 不支持/)
  }
  {
    const provider = fakeProvider({
      fetch: async () => streamResponse([wavHeader({ bits: 8 }), Buffer.alloc(8)]),
    })
    await assert.rejects(collect(provider.stream('你好')), /位深 8 不支持/)
  }
})

test('sanitizeErrorText：脱敏 token / Bearer / Windows 与 POSIX 路径', () => {
  const out = sanitizeErrorText(
    'Authorization: Bearer sk-abc.def token=secret C:\\Users\\bob\\x.wav /home/bob/y.wav',
  )
  assert.doesNotMatch(out, /sk-abc|secret|bob/)
  assert.match(out, /<path>/)
  // 不能把 http:// 里的 "p:/" 当成 Windows 盘符
  assert.equal(
    sanitizeErrorText('POST http://127.0.0.1:9880/tts failed'),
    'POST http://127.0.0.1:9880/tts failed',
  )
})

// ── 5. 超时（空闲语义） ────────────────────────────────────────────────────

test('超时：首字节迟迟不到 → TimeoutError，队列释放', async () => {
  let cancelled = 0
  const q = createTtsQueue()
  // 永不 enqueue、永不 close：模拟连接建立后首字节迟迟不到
  const provider = fakeProvider({
    queue: q,
    timeoutMs: 80,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled += 1 } }), { status: 200 }),
  })

  const t0 = Date.now()
  await assert.rejects(collect(provider.stream('你好')), (e) => {
    assert.equal(e.name, 'TimeoutError')
    assert.match(e.message, /超时/)
    return true
  })
  assert.ok(Date.now() - t0 < 2000)
  await waitFor(() => q.stats().running === 0)
  assert.equal(q.size(), 0)
  assert.ok(cancelled >= 1, '超时后应取消底层 body')
  assert.equal(await q.enqueue(async () => 'ok'), 'ok')
})

test('超时：中途卡死 → 已经产出的 chunk 保留，随后 TimeoutError', async () => {
  const header = wavHeader({ sampleRate: 24000 })
  const q = createTtsQueue()
  const provider = fakeProvider({
    queue: q,
    timeoutMs: 80,
    fetch: async () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(toU8(header))
          controller.enqueue(toU8(pcmBuf([1, 2])))
          await sleep(400) // 卡住；超时由 provider 的空闲计时器兜底
          try { controller.enqueue(toU8(pcmBuf([3, 4]))); controller.close() } catch {}
        },
      })
      return new Response(body, { status: 200 })
    },
  })
  const seen = []
  await assert.rejects(async () => {
    for await (const c of provider.stream('你好')) seen.push(c)
  }, (e) => e.name === 'TimeoutError' && /超时/.test(e.message))
  assert.deepEqual([...concatPcm(seen)], [1, 2])
  await waitFor(() => q.stats().running === 0)
  assert.equal(q.size(), 0)
})

test('空闲超时不是总时长：持续有数据的长流不报错', async () => {
  const header = wavHeader({ sampleRate: 24000 })
  const q = createTtsQueue()
  const provider = fakeProvider({
    queue: q,
    timeoutMs: 80,
    fetch: async () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(toU8(header))
          for (let i = 0; i < 8; i++) { // 8 × 25ms = 200ms > timeoutMs
            await sleep(25)
            controller.enqueue(toU8(pcmBuf([i, -i])))
          }
          controller.close()
        },
      })
      return new Response(body, { status: 200 })
    },
  })
  const chunks = await collect(provider.stream('你好'))
  assert.equal(concatPcm(chunks).length, 16)
  assert.equal(chunks[0].sampleRate, 24000)
  await waitFor(() => q.stats().running === 0)
})

// ── 6. abort ───────────────────────────────────────────────────────────────

test('abort：立即停止产出、终止 fetch、释放队列；abort 后不再 yield', async () => {
  const header = wavHeader({ sampleRate: 24000 })
  const q = createTtsQueue()
  let cancelled = 0
  const provider = fakeProvider({
    queue: q,
    timeoutMs: 5000,
    fetch: async () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(toU8(header))
          for (let i = 0; i < 200; i++) {
            await sleep(10)
            controller.enqueue(toU8(pcmBuf([i])))
          }
          controller.close()
        },
        cancel() { cancelled += 1 },
      })
      return new Response(body, { status: 200 })
    },
  })

  const ctrl = new AbortController()
  const seen = []
  const p = (async () => {
    for await (const c of provider.stream('你好', { signal: ctrl.signal })) seen.push(c)
  })()
  await waitFor(() => seen.length >= 2)
  ctrl.abort()
  await assert.rejects(p, (e) => e.name === 'AbortError')

  const frozen = seen.length
  await sleep(80)
  assert.equal(seen.length, frozen, 'abort 后不得再产出')
  await waitFor(() => q.stats().running === 0)
  assert.equal(q.size(), 0)
  assert.ok(cancelled >= 1, 'abort 应取消底层 body')
})

test('abort：排队中取消 → 不请求 9880，且不堵后续任务', async () => {
  const q = createTtsQueue()
  let release
  const blocker = q.enqueue(() => new Promise((resolve) => { release = resolve }))
  let fetchCalls = 0
  const provider = fakeProvider({
    queue: q,
    fetch: async () => { fetchCalls += 1; return streamResponse([Buffer.concat([wavHeader(), pcmBuf([1])])]) },
  })
  const ctrl = new AbortController()
  const p = collect(provider.stream('你好', { signal: ctrl.signal }))
  await waitFor(() => q.stats().queued === 1)
  ctrl.abort()
  await assert.rejects(p, (e) => e.name === 'AbortError')
  assert.equal(fetchCalls, 0)
  release()
  await blocker
  await waitFor(() => q.size() === 0)
  assert.equal(await q.enqueue(async () => 'next'), 'next')
})

test('消费方提前 break：abort 底层请求并释放队列槽位', async () => {
  const header = wavHeader({ sampleRate: 24000 })
  const q = createTtsQueue()
  let cancelled = 0
  const provider = fakeProvider({
    queue: q,
    timeoutMs: 5000,
    fetch: async () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(toU8(header))
          for (let i = 0; i < 100; i++) {
            await sleep(10)
            controller.enqueue(toU8(pcmBuf([i])))
          }
          controller.close()
        },
        cancel() { cancelled += 1 },
      })
      return new Response(body, { status: 200 })
    },
  })

  const seen = []
  for await (const c of provider.stream('你好')) {
    seen.push(c)
    break // 下游被打断（例如设备说 abort）
  }
  assert.equal(seen.length, 1)
  await waitFor(() => q.stats().running === 0)
  assert.equal(q.size(), 0)
  await waitFor(() => cancelled >= 1)
})

// ── 7. 队列串行 ────────────────────────────────────────────────────────────

test('队列：两条并发流不会让 9880 请求重叠（最大并发 = 1）', async () => {
  let active = 0
  let maxActive = 0
  const srv = await startServer(async (req, res) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    res.write(wavHeader({ sampleRate: 24000 }))
    for (let i = 0; i < 3; i++) {
      await sleep(20)
      res.write(pcmBuf([i + 1]))
    }
    res.end()
    active -= 1
  })
  try {
    const q = createTtsQueue() // 同一队列：模拟进程内共享 9880
    const a = createSovitsStreamProvider({ url: srv.url, queue: q, ref: REF, voice: {} })
    const b = createSovitsStreamProvider({ url: srv.url, queue: q, ref: REF, voice: {} })
    const [ca, cb] = await Promise.all([collect(a.stream('第一句')), collect(b.stream('第二句'))])
    assert.equal(maxActive, 1)
    assert.deepEqual([...concatPcm(ca)], [1, 2, 3])
    assert.deepEqual([...concatPcm(cb)], [1, 2, 3])
    assert.equal(q.size(), 0)
  } finally {
    await srv.close()
  }
})

test('队列：一条流期间槽位一直被占用（另一条任务不会插进来）', async () => {
  const header = wavHeader({ sampleRate: 24000 })
  let releaseTail
  const tailGate = new Promise((resolve) => { releaseTail = resolve })
  const q = createTtsQueue()
  const provider = fakeProvider({
    queue: q,
    timeoutMs: 5000,
    fetch: async () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(toU8(header))
          controller.enqueue(toU8(pcmBuf([1])))
          await tailGate
          controller.enqueue(toU8(pcmBuf([2])))
          controller.close()
        },
      })
      return new Response(body, { status: 200 })
    },
  })

  let secondStarted = false
  const it = provider.stream('你好')[Symbol.asyncIterator]()
  const first = await it.next()
  assert.equal(first.done, false)

  const second = q.enqueue(async () => { secondStarted = true })
  await sleep(30)
  assert.equal(secondStarted, false, '流未结束，队列不得启动下一条')
  assert.equal(q.stats().running, 1)
  assert.equal(q.stats().queued, 1)

  releaseTail()
  for (;;) { const step = await it.next(); if (step.done) break }
  await second
  assert.equal(secondStarted, true)
  await waitFor(() => q.size() === 0)
})
