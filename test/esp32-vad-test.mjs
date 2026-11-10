// T11 VAD 测试：自适应噪声底 / 双阈值迟滞 / hangover / 最长语音 / 任意 chunk 切分。
//
// 声音素材全部为合成信号（低幅白噪、正弦、静音），不依赖 T09 fixtures
// （T09 尚在另一个 worktree 开发，未合并）。
//
// 时间断言容差：VAD 内部按 20ms 帧处理，事件时间以累计输入采样数换算（16k）。
// 测试信号边界尽量落在帧边界上，因此多数事件可精确到毫秒；统一留 1 帧（20ms）
// 容差，覆盖帧内起音/收音等边界情况。

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_ESP32_CONFIG } from '../lib/esp32/contracts.js'
import { createVad } from '../lib/esp32/vad.js'

const SR = 16000
const FRAME_MS = 20
const TOL = FRAME_MS

// ── 合成音频 ────────────────────────────────────────────────────────────────

/** 确定性 PRNG（mulberry32），避免白噪随机性导致测试抖动。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 均匀白噪，幅度 ∈ [-amp, amp]；RMS ≈ amp/√3。 */
function noise(samples, amp = 100, seed = 1) {
  const rand = mulberry32(seed)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) pcm[i] = Math.round((rand() * 2 - 1) * amp)
  return pcm
}

/** 正弦「语音」，默认振幅 8000（RMS ≈ 5657）。 */
function sine(samples, freq = 440, amp = 8000) {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / SR))
  }
  return pcm
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** 低幅底噪，模拟麦克风静音段（RMS ≈ 58，低于 minRms 绝对阈值）。 */
function quiet(samples, seed = 7) {
  return noise(samples, 100, seed)
}

function feed(vad, pcm, chunkSize = 960) {
  const events = []
  for (let i = 0; i < pcm.length; i += chunkSize) {
    events.push(...vad.push(pcm.subarray(i, Math.min(i + chunkSize, pcm.length))))
  }
  return events
}

/** 按给定分片模式循环切分整段 PCM，覆盖 960 / 320 / 777 / 1 点等碎片。 */
function feedPattern(vad, pcm, pattern) {
  const events = []
  let i = 0
  let k = 0
  while (i < pcm.length) {
    const n = pattern[k++ % pattern.length]
    events.push(...vad.push(pcm.subarray(i, Math.min(i + n, pcm.length))))
    i += n
  }
  return events
}

function assertNear(actual, expected, tol = TOL, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label} 期望 ${expected}±${tol}ms，实测 ${actual}ms`,
  )
}

// ── 基础行为 ────────────────────────────────────────────────────────────────

test('默认参数取自 contracts.DEFAULT_ESP32_CONFIG.vad；静音无事件且噪声底稳定', () => {
  const vad = createVad()
  assert.equal(vad.config.silenceMs, DEFAULT_ESP32_CONFIG.vad.silenceMs)
  assert.equal(vad.config.minSpeechMs, DEFAULT_ESP32_CONFIG.vad.minSpeechMs)
  assert.equal(vad.config.maxSpeechMs, DEFAULT_ESP32_CONFIG.vad.maxSpeechMs)
  assert.equal(vad.state, 'silence')
  assert.equal(vad.isSpeech, false)

  assert.deepEqual(feed(vad, quiet(SR * 2)), [])
  assert.equal(vad.state, 'silence')
  assert.equal(vad.isSpeech, false)

  const floor1 = vad.noiseFloor
  assert.ok(floor1 > 5 && floor1 < 300, `静音噪声底应落在合理范围，实测 ${floor1.toFixed(1)}`)

  assert.deepEqual(feed(vad, quiet(SR, 11)), [])
  const floor2 = vad.noiseFloor
  assert.ok(
    Math.abs(floor2 - floor1) < 30,
    `稳态噪声底应稳定：${floor1.toFixed(1)} → ${floor2.toFixed(1)}`,
  )
  assert.deepEqual(vad.flush(), [])
})

test('200ms 短促语音（< minSpeechMs=250）不产生语音段', () => {
  const vad = createVad()
  const pcm = concat([quiet(SR / 2), sine(Math.round(SR * 0.2)), quiet(SR)])
  assert.deepEqual(feed(vad, pcm), [])
  assert.equal(vad.state, 'silence')
  assert.equal(vad.isSpeech, false)
  assert.deepEqual(vad.flush(), [])
})

test('500ms 语音 + 1000ms 静音：一对 start/end(silence)，边界误差 ≤1 帧', () => {
  const vad = createVad()
  const pcm = concat([quiet(SR), sine(SR / 2), quiet(SR)])
  const events = feed(vad, pcm)

  assert.equal(events.length, 2)
  const [start, end] = events
  assert.equal(start.type, 'speech_start')
  assertNear(start.atMs, 1000, TOL, 'speech_start')
  assert.equal(end.type, 'speech_end')
  assert.equal(end.reason, 'silence')
  assertNear(end.atMs, 2200, TOL, 'speech_end(silence)')
  assert.equal(vad.isSpeech, false)
})

test('预热只见到数字静音时，低幅环境底噪仍能被判为静音', () => {
  // 回归：noiseFloor 被估到下限时，end 阈值绝对下限若低于低幅底噪（RMS≈58），
  // 语音后的 hangover 会永远计不满，只能等 30s 强制截断。
  const vad = createVad()
  const pcm = concat([new Int16Array(SR), sine(SR / 2), quiet(SR)])
  const events = feed(vad, pcm)

  assert.equal(events.length, 2)
  assertNear(events[0].atMs, 1000, TOL, 'speech_start')
  assert.equal(events[1].reason, 'silence')
  assertNear(events[1].atMs, 2200, TOL, 'speech_end')
})

test('语音中 300ms 停顿（< silenceMs=700）不切段', () => {
  const vad = createVad()
  const pcm = concat([
    quiet(SR),
    sine(SR / 2),
    quiet(Math.round(SR * 0.3)),
    sine(SR / 2),
    quiet(SR),
  ])
  const events = feed(vad, pcm)

  assert.equal(events.length, 2, '300ms 停顿不应产生额外的 start/end')
  assert.equal(events[0].type, 'speech_start')
  assertNear(events[0].atMs, 1000, TOL, 'speech_start')
  assert.equal(events[1].reason, 'silence')
  assertNear(events[1].atMs, 3000, TOL, 'speech_end')
})

// ── 最长语音 ────────────────────────────────────────────────────────────────

test('连续 31s 语音：30s 强制 speech_end(max)，随后可再次 speech_start', () => {
  const vad = createVad()
  const events = feed(vad, sine(SR * 31))

  const maxEnds = events.filter((e) => e.type === 'speech_end' && e.reason === 'max')
  assert.equal(maxEnds.length, 1, '应恰好出现一次 max 强制结束')
  assertNear(maxEnds[0].atMs, 30000, TOL, 'speech_end(max)')

  const starts = events.filter((e) => e.type === 'speech_start')
  assert.equal(starts.length, 2, '30s 截断后应重新触发 speech_start')
  assertNear(starts[0].atMs, 0, TOL, '首次 speech_start')
  assertNear(starts[1].atMs, 30000, TOL, 'max 后的 speech_start')

  assert.deepEqual(
    events.map((e) => `${e.type}:${e.reason ?? ''}`),
    ['speech_start:', 'speech_end:max', 'speech_start:'],
  )

  const tail = vad.flush()
  assert.equal(tail.length, 1)
  assert.equal(tail[0].type, 'speech_end')
  assert.equal(tail[0].reason, 'flush')
  assertNear(tail[0].atMs, 31000, TOL, 'flush')
})

// ── 自适应噪声底 ────────────────────────────────────────────────────────────

test('自适应噪声底：2s 大底噪下仍能触发；转安静后不误触发', () => {
  const vad = createVad()

  assert.deepEqual(feed(vad, noise(SR * 2, 800, 3)), [], '大底噪不应误触发')
  const floorLoud = vad.noiseFloor
  assert.ok(floorLoud > 300, `大底噪下 noiseFloor 应 >300，实测 ${floorLoud.toFixed(1)}`)

  const speechEvents = feed(vad, sine(SR))
  assert.equal(speechEvents.length, 1, '大底噪之后仍应检测到语音')
  assert.equal(speechEvents[0].type, 'speech_start')
  assertNear(speechEvents[0].atMs, 2000, TOL, '大底噪后的 speech_start')
  assert.equal(vad.noiseFloor, floorLoud, '语音段内噪声底不应更新')

  const endEvents = feed(vad, quiet(SR))
  assert.equal(endEvents.length, 1)
  assert.equal(endEvents[0].reason, 'silence')
  assertNear(endEvents[0].atMs, 3700, TOL, 'speech_end(silence)')

  assert.deepEqual(feed(vad, noise(SR * 2, 100, 99)), [], '切换到更安静底噪后不应误触发')
  assert.ok(
    vad.noiseFloor < floorLoud / 2,
    `噪声底应随安静环境下降：${floorLoud.toFixed(1)} → ${vad.noiseFloor.toFixed(1)}`,
  )
  assert.ok(vad.noiseFloor < 200, `安静环境噪声底应 <200，实测 ${vad.noiseFloor.toFixed(1)}`)
})

// ── 任意 chunk 切分 ─────────────────────────────────────────────────────────

test('任意 chunk 切分一致性：960 点与 320/777/1 点碎片的事件完全一致', () => {
  const pcm = concat([
    noise(SR, 200, 5),
    sine(SR * 0.6),
    quiet(Math.round(SR * 0.3)),
    sine(SR * 0.4),
    quiet(SR),
    sine(SR / 2),
    quiet(777), // 总长度不是 20ms 帧的整数倍，flush 需处理残余
  ])

  const collect = (pattern) => {
    const vad = createVad()
    return [...feedPattern(vad, pcm, pattern), ...vad.flush()]
  }

  const whole = collect([960])
  const shredded = collect([320, 777, 123, 1, 960])

  assert.ok(whole.length >= 3, `事件数应足够覆盖一次完整会话，实测 ${whole.length}`)
  assert.deepEqual(whole, shredded, '不同 chunk 切分应产生完全相同的事件序列与时间')
})

// ── reset / flush / 参数校验 ────────────────────────────────────────────────

test('reset() 清空状态与时间轴；reset 后可正常再次检测', () => {
  const vad = createVad()
  feed(vad, concat([quiet(SR / 2), sine(SR)]))
  assert.equal(vad.isSpeech, true)

  vad.reset()
  assert.equal(vad.state, 'silence')
  assert.equal(vad.isSpeech, false)
  assert.ok(vad.noiseFloor < 300, 'reset 后噪声底回到初始值附近')

  assert.deepEqual(vad.push(quiet(SR / 2)), [])
  const events = vad.push(sine(SR / 2))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'speech_start')
  assertNear(events[0].atMs, 500, TOL, 'reset 后的时间轴')

  const tail = vad.flush()
  assert.equal(tail.length, 1)
  assert.equal(tail[0].reason, 'flush')
  assertNear(tail[0].atMs, 1000, TOL, 'reset 后的 flush 时间')
})

test('flush() 以 reason=flush 结束进行中的语音段，且幂等', () => {
  const vad = createVad()
  const events = feed(vad, concat([quiet(SR / 2), sine(Math.round(SR * 0.8))]))
  assert.equal(events.length, 1)

  const tail = vad.flush()
  assert.equal(tail.length, 1)
  assert.equal(tail[0].type, 'speech_end')
  assert.equal(tail[0].reason, 'flush')
  assertNear(tail[0].atMs, 1300, TOL, 'flush atMs')
  assert.equal(vad.isSpeech, false)
  assert.deepEqual(vad.flush(), [], '重复 flush 不应重复产生事件')
})

test('非法输入：非 Int16Array 抛 TypeError，非法参数抛 RangeError', () => {
  const vad = createVad()
  const badInputs = [
    null,
    undefined,
    42,
    'pcm',
    [1, 2, 3],
    new Uint8Array(320),
    Buffer.alloc(320),
    new Float32Array(320),
  ]
  badInputs.forEach((bad, i) => {
    assert.throws(() => vad.push(bad), TypeError, `第 ${i} 个非法输入应抛 TypeError`)
  })
  assert.throws(() => vad.push(), TypeError, '缺省输入应抛 TypeError')

  assert.throws(() => createVad({ silenceMs: -1 }), RangeError)
  assert.throws(() => createVad({ minSpeechMs: -1 }), RangeError)
  assert.throws(() => createVad({ maxSpeechMs: 0 }), RangeError)
  assert.throws(() => createVad({ sampleRate: 0 }), RangeError)
  assert.throws(() => createVad('options'), TypeError)

  // 空 Int16Array 是合法 no-op。
  assert.deepEqual(vad.push(new Int16Array(0)), [])
})

test('options 覆盖默认参数：自定义 silenceMs/minSpeechMs 生效', () => {
  const vad = createVad({ silenceMs: 300, minSpeechMs: 100 })
  assert.equal(vad.config.silenceMs, 300)
  assert.equal(vad.config.minSpeechMs, 100)

  const events = feed(vad, concat([quiet(SR / 2), sine(SR / 2), quiet(SR)]))
  assert.equal(events.length, 2)
  assertNear(events[0].atMs, 500, TOL, '自定义 minSpeechMs 的 speech_start')
  assert.equal(events[1].reason, 'silence')
  assertNear(events[1].atMs, 1300, TOL, '自定义 silenceMs 的 speech_end')
})
