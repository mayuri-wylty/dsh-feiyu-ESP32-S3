// ESP32 通道：大脑桥 + persona/config/llm signal + 情绪流解析（T19 / E 道）
//
// 全部用内存 fake（memory / brain / persona / guard / llm），不连真实 LLM、不开网络。
// 唯一接触的文件系统是 os.tmpdir() 下的临时配置/记忆目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：必须在 import 业务模块之前设置（paths.mjs 在导入时读取） ─────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-esp32-brain-'))
process.env.USERPROFILE = TMP
process.env.HOME = TMP
process.env.DSH_HOME = path.join(TMP, '.dsh')
process.env.FEIYU_CONFIG = path.join(TMP, 'feiyu.config.json')
process.env.FEIYU_DATA_DIR = path.join(TMP, '.feiyu-ai')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })

const BASE_USER_CONFIG = {
  identity: { name: '大肥鱼', ownerTitle: '主人', selfClaim: '我' },
  llm: { base_url: 'http://127.0.0.1:9/v1', model: 'fake-model', api_key: 'test-only' },
}
const writeUserConfig = (obj = BASE_USER_CONFIG) => {
  fs.writeFileSync(process.env.FEIYU_CONFIG, JSON.stringify(obj), 'utf8')
}
writeUserConfig()

const contracts = await import('../lib/esp32/contracts.js')
const configMod = await import('../tools/lib/config.mjs')
const persona = await import('../tools/lib/persona.mjs')
const llm = await import('../tools/lib/llm.mjs')
const emotion = await import('../tools/lib/emotion.mjs')
const emotionMap = await import('../lib/esp32/emotion-map.js')
const brainBridge = await import('../lib/esp32/brain-bridge.js')
const { splitSentences } = await import('../lib/esp32/sentence.js')

// ── fake 工具 ────────────────────────────────────────────────────────────────
function fakeMemory() {
  const calls = []
  return {
    calls,
    remember(platform, chatId, userId, role, text, extra) {
      calls.push({ platform, chatId, userId, role, text, extra })
    },
    recent(chatId, n = 10) {
      return calls
        .filter((c) => c.chatId === chatId && (c.role === 'user' || c.role === 'assistant'))
        .slice(-n)
        .map((c) => ({ role: c.role, content: c.text }))
    },
  }
}

function fakeBrain({ mode = 'ok', messages = [{ role: 'system', content: 'assembled' }] } = {}) {
  const calls = { assembleFor: [], onSent: [] }
  return {
    calls,
    assembleFor(opts) {
      calls.assembleFor.push(opts)
      if (mode === 'throw') throw new Error('assemble boom')
      if (mode === 'null') return null
      return { messages, chars: 12, dropped: [], ids: [] }
    },
    onSent(row) {
      calls.onSent.push(row)
      return { hash: 'fake-hash' }
    },
  }
}

function fakePersona(messages = [{ role: 'system', content: 'fallback' }]) {
  const calls = []
  return {
    calls,
    buildMessages(opts) {
      calls.push(opts)
      return messages
    },
  }
}

function fakeGuard(clean) {
  const calls = []
  return {
    calls,
    clean(text, cfg) {
      calls.push(String(text))
      return clean(String(text), cfg)
    },
  }
}

async function collect(iterable) {
  const out = []
  for await (const ev of iterable) out.push(ev)
  return out
}

// ── 配置：与契约同源 ────────────────────────────────────────────────────────
test('DEFAULTS.esp32 与 contracts.DEFAULT_ESP32_CONFIG 完全一致（同源克隆）', () => {
  assert.deepEqual(configMod.DEFAULTS.esp32, JSON.parse(JSON.stringify(contracts.DEFAULT_ESP32_CONFIG)))
  assert.notEqual(configMod.DEFAULTS.esp32, contracts.DEFAULT_ESP32_CONFIG)
  assert.notEqual(configMod.DEFAULTS.esp32.vad, contracts.DEFAULT_ESP32_CONFIG.vad)
})

test('saveEsp32Config：深合并、保留他人配置、数组替换、原子写、返回全量配置', async () => {
  writeUserConfig({
    ...BASE_USER_CONFIG,
    esp32: { token: 'old-token' },
  })
  const before = fs.readdirSync(process.env.DSH_HOME)
  const cfg = await configMod.saveEsp32Config({
    esp32: { token: 'tok-123', vad: { silenceMs: 500 }, allowDevices: ['aa:bb'], greetings: ['嗨'] },
  })
  // 返回值 = 默认值 + 用户文件（含刚写入的 patch）
  assert.equal(cfg.esp32.token, 'tok-123')
  assert.equal(cfg.esp32.vad.silenceMs, 500)
  assert.equal(cfg.esp32.vad.minSpeechMs, 250)
  assert.equal(cfg.esp32.port, 8765)
  assert.deepEqual(cfg.esp32.allowDevices, ['aa:bb'])
  assert.deepEqual(cfg.esp32.greetings, ['嗨'])
  assert.equal(cfg.identity.name, '大肥鱼')

  // 文件里只应写用户配置 + patch，不把全部 DEFAULTS 抄进去
  const file = JSON.parse(fs.readFileSync(process.env.FEIYU_CONFIG, 'utf8'))
  assert.equal(file.esp32.token, 'tok-123')
  assert.equal(file.esp32.vad.silenceMs, 500)
  assert.equal(file.esp32.vad.minSpeechMs, undefined)
  assert.equal(file.identity.name, '大肥鱼')
  assert.equal(file.__hasUserFile, undefined)

  // 原子写：目录里不留下临时文件
  const after = fs.readdirSync(process.env.DSH_HOME)
  assert.deepEqual(after.filter((f) => f.endsWith('.tmp')), [])
  assert.ok(after.length >= before.length)

  // 再写一次别的区段，esp32 改动不被覆盖
  await configMod.saveEsp32Config({ llm: { temperature: 0.5 } })
  const cfg2 = configMod.config()
  assert.equal(cfg2.esp32.token, 'tok-123')
  assert.equal(cfg2.llm.temperature, 0.5)
  assert.equal(cfg2.identity.name, '大肥鱼')
})

// ── persona ─────────────────────────────────────────────────────────────────
test('persona：esp32 平台提示与 RECENT_N，且支持 config 覆盖', async () => {
  assert.match(persona.PLATFORM_HINTS.esp32, /语音对话/)
  assert.match(persona.PLATFORM_HINTS.esp32, /1–3 句/)
  assert.match(persona.PLATFORM_HINTS.esp32, /markdown/)
  assert.equal(persona.RECENT_N.esp32, 16)

  const base = { platform: 'esp32', userText: '你好', chatId: 'esp32:dev1', userId: 'owner', turnsToday: 0 }

  await configMod.saveEsp32Config({ esp32: { personaHint: '' } })
  const dflt = persona.buildMessages(base)
  assert.match(dflt[0].content, /语音对话/)

  await configMod.saveEsp32Config({ esp32: { personaHint: '自定义：只说一句话。' } })
  const custom = persona.buildMessages(base)
  assert.match(custom[0].content, /自定义：只说一句话/)
  assert.doesNotMatch(custom[0].content, /语音对话：口语化/)
})

// ── llm：外部 signal 与超时合并 ──────────────────────────────────────────────
test('llm.chat / chatStream：外部 signal 与超时同时生效', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  try {
    // chat：外部 signal 必须能中止请求（不是被默认超时 signal 顶掉）
    globalThis.fetch = async (url, init) => {
      seen.push(init.signal)
      return { ok: true, json: async () => ({ choices: [{ message: { content: '好' } }] }) }
    }
    const ac = new AbortController()
    assert.equal(await llm.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal }), '好')
    const chatSignal = seen.at(-1)
    assert.ok(chatSignal instanceof AbortSignal)
    assert.equal(chatSignal.aborted, false)
    ac.abort()
    assert.equal(chatSignal.aborted, true, '外部 signal 中止后请求 signal 必须跟着中止')

    // 不传外部 signal：仍然有超时兜底
    assert.equal(await llm.chat([{ role: 'user', content: 'hi' }]), '好')
    assert.ok(seen.at(-1) instanceof AbortSignal)
    assert.equal(seen.at(-1).aborted, false)

    // chatStream：同样合并
    const enc = new TextEncoder()
    globalThis.fetch = async (url, init) => {
      seen.push(init.signal)
      let sent = false
      return {
        ok: true,
        body: {
          getReader: () => ({
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return {
                done: false,
                value: enc.encode('data: {"choices":[{"delta":{"content":"嗨"}}]}\n\ndata: [DONE]\n\n'),
              }
            },
          }),
        },
      }
    }
    const ac2 = new AbortController()
    const chunks = await collect(llm.chatStream([{ role: 'user', content: 'hi' }], { signal: ac2.signal }))
    assert.equal(chunks.join(''), '嗨')
    const streamSignal = seen.at(-1)
    assert.equal(streamSignal.aborted, false)
    ac2.abort()
    assert.equal(streamSignal.aborted, true, 'chatStream 的外部 signal 也必须生效')

    // 已中止的外部 signal：请求必须真的中止
    globalThis.fetch = async (url, init) => {
      if (init.signal?.aborted) throw init.signal.reason
      throw new Error('不该走到这里')
    }
    const dead = new AbortController()
    dead.abort()
    await assert.rejects(llm.chat([{ role: 'user', content: 'hi' }], { signal: dead.signal }), { name: 'AbortError' })
    await assert.rejects(
      collect(llm.chatStream([{ role: 'user', content: 'hi' }], { signal: dead.signal })),
      { name: 'AbortError' },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 情绪：映射从契约派生 + 流式标签缓冲 ─────────────────────────────────────
test('emotion-map：映射表与契约是同一个对象（不复制第二份）', () => {
  assert.equal(emotionMap.EMOTION_TO_FIRMWARE, contracts.EMOTION_TO_FIRMWARE)
  assert.equal(emotionMap.firmwareEmotionOf('coquettish'), 'kissy')
  assert.equal(emotionMap.firmwareEmotionOf('wronged'), 'sad')
  assert.equal(emotionMap.firmwareEmotionOf('不存在'), 'neutral')
})

test('emotion-map：跨 chunk 的标签能拼起来，首个句末即解析', () => {
  const s = emotionMap.createEmotionTagStream()
  let r = s.push('[[撒')
  assert.equal(r.resolved, false)
  assert.equal(r.text, '')
  r = s.push('娇]]你好。')
  assert.equal(r.resolved, true)
  assert.equal(r.emotion, 'coquettish')
  assert.equal(r.text, '你好。')
  // 解析后原样透传
  r = s.push('后面。')
  assert.equal(r.resolved, true)
  assert.equal(r.text, '后面。')
})

test('emotion-map：40 字仍无标签视为无标签；flush 解析剩余', () => {
  const s = emotionMap.createEmotionTagStream({ maxChars: 10 })
  const r = s.push('一二三四五六七八九十')
  assert.equal(r.resolved, true)
  assert.equal(r.emotion, '')
  assert.equal(r.text, '一二三四五六七八九十')

  const s2 = emotionMap.createEmotionTagStream()
  assert.equal(s2.push('[[温柔]]').resolved, false)
  const f = s2.flush()
  assert.equal(f.resolved, true)
  assert.equal(f.emotion, 'tender')
  assert.equal(f.text, '')
})

test('emotion-map：首句之后才出现的标签按约定忽略（不再回看）', () => {
  const s = emotionMap.createEmotionTagStream()
  const first = s.push('你好。')
  assert.equal(first.resolved, true)
  assert.equal(first.emotion, '')
  const late = s.push('[[撒娇]]')
  assert.equal(late.text, '[[撒娇]]')
})

test('emotion-map：前导空白/换行不提前触发解析', () => {
  const s = emotionMap.createEmotionTagStream()
  assert.equal(s.push('\n\n').resolved, false)
  const r = s.push('[[撒娇]]嗨。')
  assert.equal(r.resolved, true)
  assert.equal(r.emotion, 'coquettish')
  assert.equal(r.text, '嗨。')
})

// ── 大脑桥：正常流 ──────────────────────────────────────────────────────────
test('handleUtterance：memory(user) → assembleFor → 逐句 + 情绪 + 记忆/onSent', async () => {
  const mem = fakeMemory()
  const brain = fakeBrain()
  const personaFake = fakePersona()
  const guard = fakeGuard((t) => t)
  const llmCalls = []
  const llmStream = (messages, opts) => {
    llmCalls.push({ messages, opts })
    return (async function* () {
      yield '[[撒娇]]'
      yield '你好呀。'
      yield '今天也开心！'
    })()
  }
  const bridge = brainBridge.createBrainBridge({
    llmStream, memory: mem, brain, persona: personaFake, guard, emotion,
  })

  const events = await collect(bridge.handleUtterance({
    deviceId: 'dev1', chatId: 'esp32:dev1', userId: 'owner', text: '在吗',
  }))

  assert.deepEqual(events.map((e) => e.type), ['emotion', 'sentence', 'sentence', 'done'])
  // 大脑桥只吐 feiyu 原始情绪键；固件表情名由 qa.js 单次映射（避免二次映射成 neutral）
  assert.deepEqual(events[0], { type: 'emotion', emotion: 'coquettish' })
  assert.deepEqual(events[1], { type: 'sentence', text: '你好呀。', index: 0 })
  assert.deepEqual(events[2], { type: 'sentence', text: '今天也开心！', index: 1 })
  assert.equal(events[3].fullText, '你好呀。今天也开心！')

  // 记忆：先 user，后 assistant；会话/平台/用户正确
  assert.equal(mem.calls.length, 2)
  assert.equal(mem.calls[0].platform, 'esp32')
  assert.equal(mem.calls[0].chatId, 'esp32:dev1')
  assert.equal(mem.calls[0].userId, 'owner')
  assert.equal(mem.calls[0].role, 'user')
  assert.equal(mem.calls[0].text, '在吗')
  assert.equal(mem.calls[1].role, 'assistant')
  assert.equal(mem.calls[1].text, '你好呀。今天也开心！')

  // 装配：走脑，不走 persona 回退
  assert.equal(personaFake.calls.length, 0)
  assert.equal(brain.calls.assembleFor.length, 1)
  assert.equal(brain.calls.assembleFor[0].platform, 'esp32')
  assert.equal(brain.calls.assembleFor[0].userText, '在吗')
  assert.equal(brain.calls.assembleFor[0].chatId, 'esp32:dev1')
  assert.equal(brain.calls.assembleFor[0].userId, 'owner')
  assert.deepEqual(llmCalls[0].messages, [{ role: 'system', content: 'assembled' }])

  // 完成：onSent 一次，带全文
  assert.equal(brain.calls.onSent.length, 1)
  assert.equal(brain.calls.onSent[0].platform, 'esp32')
  assert.equal(brain.calls.onSent[0].chat, 'esp32:dev1')
  assert.equal(brain.calls.onSent[0].text, '你好呀。今天也开心！')
})

test('handleUtterance：assembleFor 返回 null 或抛错都回退 persona.buildMessages', async () => {
  for (const mode of ['null', 'throw']) {
    const mem = fakeMemory()
    const brain = fakeBrain({ mode })
    const personaFake = fakePersona([{ role: 'system', content: 'from-fallback' }])
    const bridge = brainBridge.createBrainBridge({
      llmStream: () => (async function* () { yield '好。' })(),
      memory: mem, brain, persona: personaFake, guard: fakeGuard((t) => t), emotion,
    })
    const out = []
    for await (const ev of bridge.handleUtterance({ deviceId: 'd', text: '你好' })) out.push(ev)
    assert.equal(personaFake.calls.length, 1, `${mode}: 应回退 persona`)
    assert.equal(personaFake.calls[0].platform, 'esp32')
    assert.deepEqual(out.map((e) => e.type), ['emotion', 'sentence', 'done'])
    assert.equal(out[1].text, '好。')
  }
})

test('handleUtterance：空文本不调 LLM、不写记忆，只收 done', async () => {
  const mem = fakeMemory()
  const bridge = brainBridge.createBrainBridge({
    llmStream: () => { throw new Error('不该调 LLM') },
    memory: mem, brain: fakeBrain(), persona: fakePersona(),
    guard: fakeGuard((t) => t), emotion,
  })
  const events = await collect(bridge.handleUtterance({ deviceId: 'd', text: '   ' }))
  assert.deepEqual(events, [{ type: 'done', fullText: '' }])
  assert.equal(mem.calls.length, 0)
})

// ── 句级 guard 对照 ─────────────────────────────────────────────────────────
test('句级 guard：无跨句状态的清洗，逐句拼接 === 整段清洗', async () => {
  const raw = '你好，敏感词。敏感词再见。'
  const clean = (t) => t.split('敏感词').join('')
  const guard = fakeGuard(clean)
  const bridge = brainBridge.createBrainBridge({
    llmStream: () => (async function* () { yield '你好，敏感词。'; yield '敏感词再见。' })(),
    memory: fakeMemory(), brain: fakeBrain(), persona: fakePersona(),
    guard, emotion,
  })
  const events = await collect(bridge.handleUtterance({ deviceId: 'd', text: '讲个话' }))
  const sentences = events.filter((e) => e.type === 'sentence').map((e) => e.text)
  assert.deepEqual(guard.calls, ['你好，敏感词。', '敏感词再见。'], 'guard 必须逐句调用')
  assert.equal(sentences.join(''), clean(raw), '逐句清洗应与整段清洗一致')
})

test('句级 guard：有状态的去重与整段去重结果一致（bridge 只保证按序逐句调用）', async () => {
  const raw = '重复句。重复句。新句子。'
  const dedupe = (() => {
    const seen = new Set()
    return (t) => {
      const key = String(t).replace(/[。！？；…，、\s]/g, '')
      if (seen.has(key)) return ''
      seen.add(key)
      return String(t)
    }
  })()
  const guard = fakeGuard(dedupe)
  const bridge = brainBridge.createBrainBridge({
    llmStream: () => (async function* () { yield '重复句。'; yield '重复句。'; yield '新句子。' })(),
    memory: fakeMemory(), brain: fakeBrain(), persona: fakePersona(),
    guard, emotion,
  })
  const events = await collect(bridge.handleUtterance({ deviceId: 'd', text: '再说一次' }))
  const sentences = events.filter((e) => e.type === 'sentence').map((e) => e.text)
  assert.deepEqual(sentences, ['重复句。', '新句子。'])

  // 整段口径：同样切句后逐句去重
  const seen = new Set()
  const whole = splitSentences(raw)
    .filter((s) => {
      const key = s.replace(/[。！？；…，、\s]/g, '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join('')
  assert.equal(sentences.join(''), whole, '句级去重与整段去重应一致（guard 自带状态即可）')
  assert.equal(guard.calls.length, 3, '每一句都要经过 guard（包括被去重丢弃的）')
})

// ── 打断 ────────────────────────────────────────────────────────────────────
test('打断：只记已 yield 的句子 +（被打断），不再调 LLM 后续、不 onSent', async () => {
  const mem = fakeMemory()
  const brain = fakeBrain()
  const ac = new AbortController()
  const bridge = brainBridge.createBrainBridge({
    llmStream: (messages, { signal }) => (async function* () {
      yield '[[撒娇]]第一句。'
      await new Promise((resolve) => {
        if (!signal) return resolve()
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', resolve, { once: true })
      })
      if (!signal?.aborted) yield '第二句。'
    })(),
    memory: mem, brain, persona: fakePersona(), guard: fakeGuard((t) => t), emotion,
  })

  const it = bridge.handleUtterance({ deviceId: 'd', chatId: 'esp32:d', text: '说点什么', signal: ac.signal })
  const got = []
  got.push((await it.next()).value) // emotion
  got.push((await it.next()).value) // sentence 1
  const pending = it.next()
  ac.abort()
  let r = await pending
  while (!r.done) { got.push(r.value); r = await it.next() }

  assert.deepEqual(got.map((e) => e.type), ['emotion', 'sentence', 'done'])
  assert.equal(got[1].text, '第一句。')
  assert.equal(got[2].fullText, '第一句。', 'done 只含已产出的句子')

  const assistant = mem.calls.filter((c) => c.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0].text, '第一句。（被打断）')
  assert.equal(brain.calls.onSent.length, 0, '被打断不算完整发送')
})

test('打断：未 yield 任何句子时不写 assistant 记忆', async () => {
  const mem = fakeMemory()
  const brain = fakeBrain()
  const ac = new AbortController()
  ac.abort()
  const bridge = brainBridge.createBrainBridge({
    llmStream: () => (async function* () { yield '不该出现。' })(),
    memory: mem, brain, persona: fakePersona(), guard: fakeGuard((t) => t), emotion,
  })
  const events = await collect(bridge.handleUtterance({
    deviceId: 'd', chatId: 'esp32:d', text: '还没开始就被打断', signal: ac.signal,
  }))
  assert.deepEqual(events, [{ type: 'done', fullText: '' }])
  assert.equal(mem.calls.filter((c) => c.role === 'assistant').length, 0)
  assert.equal(mem.calls.filter((c) => c.role === 'user').length, 1, '用户这句话仍然入记忆')
  assert.equal(brain.calls.onSent.length, 0)
})

// ── 唤醒问候 ────────────────────────────────────────────────────────────────
test('pickGreeting：随机取（可注入），空数组/缺失返回 null', () => {
  assert.equal(brainBridge.pickGreeting({ esp32: { greetings: [] } }), null)
  assert.equal(brainBridge.pickGreeting({}), null)
  assert.equal(brainBridge.pickGreeting(undefined), null)
  assert.equal(brainBridge.pickGreeting({ esp32: { greetings: '不是数组' } }), null)

  const cfg = { esp32: { greetings: [' 我在呢 ', '嗯？怎么啦'] } }
  assert.equal(brainBridge.pickGreeting(cfg, () => 0), '我在呢')
  assert.equal(brainBridge.pickGreeting(cfg, () => 0.999), '嗯？怎么啦')
})

test('listen detect 问候：不写记忆、不调 LLM', async () => {
  const mem = fakeMemory()
  const brain = fakeBrain()
  const bridge = brainBridge.createBrainBridge({
    llmStream: () => { throw new Error('问候不该调 LLM') },
    memory: mem, brain, persona: fakePersona(), guard: fakeGuard((t) => t), emotion,
    config: () => ({ esp32: { greetings: ['我在呢'] } }),
  })
  const events = await collect(bridge.handleUtterance({
    deviceId: 'd', chatId: 'esp32:d', text: '', isWakeGreeting: true,
  }))
  assert.deepEqual(events.map((e) => e.type), ['emotion', 'sentence', 'done'])
  assert.deepEqual(events[0], { type: 'emotion', emotion: '' }, '问候固定中性（空键）')
  assert.equal(events[1].text, '我在呢')
  assert.equal(mem.calls.length, 0, '问候不写记忆')
  assert.equal(brain.calls.onSent.length, 0)
})

// ── chatId / userId 默认值 ─────────────────────────────────────────────────
test('handleUtterance：chatId 默认 esp32:<deviceId>，userId 默认 owner', async () => {
  const mem = fakeMemory()
  const bridge = brainBridge.createBrainBridge({
    llmStream: () => (async function* () { yield '好。' })(),
    memory: mem, brain: fakeBrain(), persona: fakePersona(),
    guard: fakeGuard((t) => t), emotion,
  })
  await collect(bridge.handleUtterance({ deviceId: 'aa:bb:cc', text: '喂' }))
  assert.equal(mem.calls[0].chatId, 'esp32:aa:bb:cc')
  assert.equal(mem.calls[0].userId, 'owner')
})
