// 火山云端 ASR/TTS e2e 场景（配合 mock-volc.mjs；全部走回环，密钥为假值）。
//
// 由 run.mjs 在隔离的 FEIYU_CONFIG 环境下加载。deps 由 run.mjs 注入：
//   { withGateway, mock, sinePcm, AUDIO }
// 场景对象形状与 run.mjs 一致：{ name, hooks, run(scope) }。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { sineBytes } from './mock-volc.mjs'
import { createEsp32PipelineFactory } from '../../lib/esp32/pipeline/index.js'
import { createTtsProviderFromConfig } from '../../lib/esp32/tts/fallback.js'
import { createAsrProviderFromConfig } from '../../lib/esp32/asr/fallback.js'
import { createProviderTester } from '../../lib/esp32/providers/test.js'
import {
  buildProvidersView, handleProvidersTest, maskConfigForGet, deepMerge,
} from '../../lib/esp32/providers/http.js'
import { writePcmWav } from '../../lib/esp32/audio/wav.js'
import { config as readToolConfig } from '../../tools/lib/config.mjs'

// 假密钥（非真实凭据）：只验证请求头透传与「不回显」，端点全指向本地 mock。
export const FAKE_VOLC_KEY = 'mock-volc-key-0000-not-a-real-secret'

const CFG_PATH = process.env.FEIYU_CONFIG
const writeUserConfig = (obj) => fs.writeFileSync(CFG_PATH, JSON.stringify(obj))
const readUserConfig = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8') || '{}')

function volcCfg(mock) {
  return {
    esp32: {
      pipeline: 'asr',
      asr: {
        primary: 'volcengine',
        fallback: '',
        volcengine: { apiKey: FAKE_VOLC_KEY, endpoint: mock.origin, modelName: 'bigmodel' },
      },
      tts: {
        provider: 'volcengine',
        fallback: 'sovits-sentence',
        volcengine: {
          apiKey: FAKE_VOLC_KEY, speaker: 'mock_speaker', endpoint: mock.origin,
          connectTimeoutMs: 300, idleTimeoutMs: 300,
        },
      },
    },
    voice: { sovits_url: mock.sovitsUrl, text_lang: 'zh' },
  }
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

export function createVolcScenarios({ withGateway, mock, sinePcm, AUDIO }) {
  /** 一次「listen start → ~1s 音频 → stop」，返回 stt 文本。 */
  async function speakOnce(connect, trace) {
    const device = await connect()
    await device.sendListen({ state: 'start', mode: 'manual' })
    await device.sendPcm(sinePcm(AUDIO.uplink.samplesPerFrame * 17, { frequency: 440 }))
    await device.sendListen({ state: 'stop' })
    const stt = await device.waitForJson('stt', 4000)
    trace.mark('stt')
    await device.close({ timeoutMs: 500 })
    return stt.text
  }

  const asrNoStt = {
    name: '云 ASR 为主且无 stt 仍可识别 + 改配置后 provider 重建',
    hooks: {},
    async run(scope) {
      mock.reset()
      writeUserConfig(volcCfg(mock))
      const factory = createEsp32PipelineFactory({
        getConfig: readToolConfig,
        getSpeechToText: () => null, // voice-input 未启用
        logger: scope.logSink.logger,
      })
      scope.createPipelineOverride = (ctx) => factory(ctx)
      await withGateway(scope, async ({ connect, trace }) => {
        mock.setAsr({ text: '第一次云端识别' })
        const first = await speakOnce(connect, trace)
        assert.equal(first, '第一次云端识别', '无 stt 时云 ASR 作主应能识别（不降级为回声）')
        const reqs = mock.of('asr')
        assert.equal(reqs.length, 1)
        assert.equal(reqs[0].headers['x-api-key'], FAKE_VOLC_KEY)
        assert.equal(reqs[0].headers['x-api-resource-id'], 'volc.bigasr.auc_turbo')
        assert.equal(reqs[0].body.request.model_name, 'bigmodel')
        assert.ok(reqs[0].body.audio.data.length > 100, '应带 base64 WAV')
        const health = factory.getPipelineHealth()
        assert.equal(health.asr.ready, true)
        assert.equal(health.asr.primary, 'volcengine')
        assert.ok(!JSON.stringify(health).includes(FAKE_VOLC_KEY), '健康快照不得含密钥')

        // 只改 volcengine.modelName（配置签名变化）→ 下一连接应按新配置重建 provider
        const cfg = volcCfg(mock)
        cfg.esp32.asr.volcengine.modelName = 'model-changed'
        writeUserConfig(cfg)
        mock.setAsr({ text: '改配置后识别' })
        const second = await speakOnce(connect, trace)
        assert.equal(second, '改配置后识别')
        assert.equal(mock.of('asr').length, 2)
        assert.equal(
          mock.of('asr')[1].body.request.model_name,
          'model-changed',
          '改配置后 provider 应按新签名重建',
        )
        trace.mark('assertions')
      })
    },
  }

  const ttsFallback = {
    name: '云 TTS 主：首块前失败回退本地 / 首块后失败不回退 / 分块解析',
    hooks: {},
    async run(scope) {
      mock.reset()
      writeUserConfig(volcCfg(mock))
      const { trace } = scope

      // 1) 正常：JSON 按 7 字节任意切块 + 奇数字节余量顺延
      mock.setTts({ chunks: [sineBytes(1201), sineBytes(1200)], splitAt: 7 })
      let tts = createTtsProviderFromConfig({})
      let chunks = await collect(tts.stream('你好'))
      assert.equal(mock.of('tts').length, 1)
      assert.equal(mock.of('sovits').length, 0, '云主成功时不得触碰本地')
      assert.ok(chunks.every((c) => c.sampleRate === 24_000 && c.pcm instanceof Int16Array))
      assert.equal(chunks.reduce((n, c) => n + c.pcm.length, 0), 2401, '总样本数不丢')
      const req = mock.of('tts')[0]
      assert.equal(req.headers['x-api-key'], FAKE_VOLC_KEY)
      assert.equal(req.headers['x-api-resource-id'], 'seed-tts-2.0')
      assert.equal(req.body.req_params.speaker, 'mock_speaker')
      assert.equal(req.body.req_params.audio_params.format, 'pcm')
      trace.mark('stream-ok')

      // 2) 首块前返回错误码 → 回退本地
      mock.reset()
      mock.setTts({ errorCode: 45000000 })
      let fellBack = null
      tts = createTtsProviderFromConfig({ onFallback: (info) => { fellBack = info } })
      chunks = await collect(tts.stream('你好'))
      assert.ok(chunks.length >= 1 && chunks[0].pcm.length > 0, '应拿到本地兜底音频')
      assert.equal(mock.of('tts').length, 1)
      assert.equal(mock.of('sovits').length, 1, '回退到本地 sovits')
      assert.equal(fellBack?.from, 'volcengine')
      assert.equal(fellBack?.to, 'sovits-sentence')
      assert.ok(!String(fellBack?.error?.message).includes(FAKE_VOLC_KEY))
      trace.mark('fallback-errcode')

      // 3) 首包超时（延迟 > connectTimeoutMs=300）→ 回退本地
      mock.reset()
      mock.setTts({ delayMs: 1200 })
      tts = createTtsProviderFromConfig({})
      chunks = await collect(tts.stream('你好'))
      assert.ok(chunks.length >= 1)
      assert.equal(mock.of('sovits').length, 1, '首包超时应回退')
      trace.mark('fallback-timeout')

      // 4) 首块后出错 → 抛出，不回退
      mock.reset()
      mock.setTts({ errorAfter: 1, errorAfterCode: 55000000 })
      tts = createTtsProviderFromConfig({})
      const got = []
      await assert.rejects(async () => { for await (const c of tts.stream('你好')) got.push(c) }, /火山/)
      assert.equal(got.length, 1, '出错前的首块已交付')
      assert.equal(mock.of('sovits').length, 0, '首块后错误不得回退')
      trace.mark('no-fallback-after-first')

      // 5) 首块后断流 → 抛出，不回退
      mock.reset()
      mock.setTts({ dropAfter: 1 })
      tts = createTtsProviderFromConfig({})
      const got2 = []
      await assert.rejects(async () => { for await (const c of tts.stream('你好')) got2.push(c) })
      assert.equal(got2.length, 1)
      assert.equal(mock.of('sovits').length, 0)
      trace.mark('drop-after-first')

      // 6) 块间挂起（idleTimeoutMs=300）→ 超时抛错，不回退
      mock.reset()
      mock.setTts({ stallAfter: 1 })
      tts = createTtsProviderFromConfig({})
      const got3 = []
      await assert.rejects(async () => { for await (const c of tts.stream('你好')) got3.push(c) }, /超时/)
      assert.equal(got3.length, 1)
      assert.equal(mock.of('sovits').length, 0)
      trace.mark('assertions')
    },
  }

  const asrFallback = {
    name: '云 ASR 主：失败回退本地；静音状态码不回退',
    hooks: {},
    async run(scope) {
      mock.reset()
      writeUserConfig(volcCfg(mock))
      const wav = Buffer.from(writePcmWav(new Int16Array(16_000), 16_000, 1))
      let localCalls = 0
      const speechToText = {
        resolve: async () => ({}),
        transcribe: async () => { localCalls += 1; return { text: '本地兜底识别' } },
      }
      const make = () => createAsrProviderFromConfig({
        speechToText, primary: 'volcengine', fallback: 'sensevoice',
        volcengine: { apiKey: FAKE_VOLC_KEY, endpoint: mock.origin },
      })

      mock.setAsr({ statusCode: '20000003' }) // 静音：合法空结果
      assert.equal((await make().transcribe({ wav, sampleRate: 16_000 })).text, '')
      assert.equal(localCalls, 0, '20000003 是合法结果，不得回退')

      mock.setAsr({ statusCode: '55000031', message: 'busy' })
      assert.equal((await make().transcribe({ wav, sampleRate: 16_000 })).text, '本地兜底识别')
      assert.equal(localCalls, 1, '服务忙应回退本地')
      scope.trace.mark('assertions')
    },
  }

  const testPersist = {
    name: '测试连接 persist：primary/fallback 原子写入，失败不写、不回显密钥',
    hooks: {},
    async run(scope) {
      mock.reset()
      writeUserConfig({ esp32: { asr: { primary: 'sensevoice' }, tts: { provider: 'sovits-stream' } } })

      // 与 lib/index.js 路由接线一致（该文件需要完整 DSH ctx，不在 e2e 内实例化）
      const tester = createProviderTester({
        createAsr: ({ id, config }) => createAsrProviderFromConfig({ primary: id, fallback: '', openai: config, volcengine: config }),
        createTts: ({ id, config }) => createTtsProviderFromConfig({ provider: id, fallback: '', cloud: config, volcengine: config }),
      })
      const persist = ({ esp32 }) => {
        const raw = fs.readFileSync(CFG_PATH, 'utf8')
        fs.writeFileSync(CFG_PATH + '.esp32-providers.bak', raw)
        const cfg = JSON.parse(raw)
        cfg.esp32 = deepMerge(cfg.esp32 ?? {}, esp32)
        fs.writeFileSync(CFG_PATH, JSON.stringify(cfg))
      }
      const call = (body) => handleProvidersTest({ body, getStored: () => readToolConfig().esp32, test: tester, persist })

      // 1) 失败的测试：不写任何内容
      mock.setAsr({ statusCode: '45000001', message: 'bad param' })
      const before = fs.readFileSync(CFG_PATH, 'utf8')
      const bad = await call({ kind: 'asr', id: 'volcengine', persist: true, values: { apiKey: FAKE_VOLC_KEY, endpoint: mock.origin } })
      assert.equal(bad.body.ok, false)
      assert.equal(bad.body.persisted, false)
      assert.equal(fs.readFileSync(CFG_PATH, 'utf8'), before, '失败时配置文件必须保持不变')
      assert.ok(!JSON.stringify(bad.body).includes(FAKE_VOLC_KEY), '错误响应不得回显密钥')

      // 2) ASR 通过 + persist → primary=volcengine，fallback=sensevoice
      mock.setAsr({ text: '连通' })
      const asr = await call({ kind: 'asr', id: 'volcengine', persist: true, values: { apiKey: FAKE_VOLC_KEY, endpoint: mock.origin } })
      assert.equal(asr.status, 200)
      assert.equal(asr.body.ok, true, JSON.stringify(asr.body))
      assert.equal(asr.body.persisted, true)
      assert.equal(asr.body.primary, 'volcengine')
      assert.equal(asr.body.fallback, 'sensevoice')
      assert.ok(!JSON.stringify(asr.body).includes(FAKE_VOLC_KEY))
      let saved = readUserConfig().esp32
      assert.equal(saved.asr.primary, 'volcengine')
      assert.equal(saved.asr.fallback, 'sensevoice')
      assert.equal(saved.asr.volcengine.endpoint, mock.origin)
      assert.ok(fs.existsSync(CFG_PATH + '.esp32-providers.bak'), '写前应留快照')

      // 3) TTS 通过 + persist → provider=volcengine，fallback=原本地主 sovits-stream
      const tts = await call({ kind: 'tts', id: 'volcengine', persist: true, values: { apiKey: FAKE_VOLC_KEY, speaker: 'mock_speaker', endpoint: mock.origin } })
      assert.equal(tts.body.ok, true, JSON.stringify(tts.body))
      assert.equal(typeof tts.body.ttsFirstMs, 'number')
      assert.equal(tts.body.primary, 'volcengine')
      assert.equal(tts.body.fallback, 'sovits-stream')
      saved = readUserConfig().esp32
      assert.equal(saved.tts.provider, 'volcengine')
      assert.equal(saved.tts.fallback, 'sovits-stream')
      assert.equal(saved.tts.volcengine.speaker, 'mock_speaker')
      assert.equal(saved.asr.primary, 'volcengine', 'TTS 持久化不得动 ASR 主备')

      // 4) 密钥留空 = 沿用已存值；视图与 GET /api/config 脱敏
      const reuse = await call({ kind: 'asr', id: 'volcengine', values: { apiKey: '' } })
      assert.equal(reuse.body.ok, true, '密钥留空应使用已存值')
      assert.equal(reuse.body.persisted, false)
      const view = buildProvidersView({ esp32: readToolConfig().esp32 })
      assert.ok(!JSON.stringify(view).includes(FAKE_VOLC_KEY), 'providers 视图不得含密钥')
      assert.equal(view.current.asr.primary, 'volcengine')
      assert.ok(!JSON.stringify(maskConfigForGet(readToolConfig())).includes(FAKE_VOLC_KEY), 'GET /api/config 不得含密钥')
      scope.trace.mark('assertions')
    },
  }

  return [asrNoStt, ttsFallback, asrFallback, testPersist]
}
