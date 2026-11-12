# ESP32 通道：云端 ASR/TTS 可配置 — 设计

> 仓库 dsh-feiyu，分支 feat/esp32-channel。绝不 push origin。

## 1. Context

ESP32 通道已有 ASR/TTS provider 抽象（`contracts.js`）、OpenAI 兼容云端客户端、主备回退、设置页 LLM 卡片，但：
- 设置页 ESP32 卡片只读，**没有 ASR/TTS 配置表单、没有"测试连接"**（LLM 卡片也没有，需从零做）。
- 云 ASR 被误绑 voice-input：`pipeline/index.js:130` `if (stt)` 为空即不建 ASR，云 ASR 配成 primary 也降级回声。
- 配置签名（`pipeline/index.js:119-126`）不含 `openai.*`/`cloud.*`，改配置不重建 provider。
- `GET /api/config`（`lib/index.js:346-351`）明文返回 `esp32.asr.openai.apiKey`、`esp32.tts.cloud.apiKey`、`esp32.token`。
- 云 TTS 仅 wav/pcm 整句返回；缺 `language/timeoutMs/speed` 配置字段；配置错误只静默降级，UI 看不到原因。

目标：用户在设置页（`settings.html` + `client.js`）选择/填写云端 ASR、TTS，一键测试，通过后自动设为主选、本地兜底；并原生支持火山豆包语音（流式 TTS），其余厂商走 OpenAI 兼容预设。

## 2. 已确认决策（用户）

| 项 | 决定 |
|---|---|
| 渠道 | 火山豆包语音做原生适配器 + OpenAI 兼容**预设模板**（SiliconFlow/Groq/OpenAI/自建 whisper）；**不做第二家原生**，只预留扩展点+开发指南 |
| 流式 | 只做**流式 TTS**；ASR 保持「VAD 切段→整句识别」 |
| 前端 | `settings.html` 与 `client.js` 两处同步；ASR/TTS 各一个「测试连接」；**不做**主备可视化/多方案切换，只选主 provider |
| 默认行为 | 配好云端且测试通过后，**自动云端为 primary、本地为 fallback** |
| 验收 | mock 测试（fake fetch）+ 火山真实冒烟 + 模拟设备 e2e（`npm run test:e2e`） |
| 协作 | DAG 串并混排 + Claude Code Agent Teams；多代理改同仓用 worktree；`contracts.js` Lead 独占 |

我的决定（可改）：配置沿用 camelCase；旧配置靠深合并兼容、无需迁移；`emotion` 先忽略；音色名/资源 ID 由用户填（不预设）；本期**不加** 30s 熔断（首包超时压到 5s 缓解），记为后续项。

## 3. 参考与复用

- 复用：`asr/openai.js`（30s 超时/取消超时区分/错误截断 300+key 脱敏）、`asr/util.js`、`tts/cloud.js` 的解码与 `normalizeSpeechUrl/normalizeTranscriptionUrl`、`asr|tts/fallback.js` 工厂与懒构造回退、`POST /api/config` 白名单深合并+token 保留、LLM 卡片 Key 输入+`hasKey` 交互、`lib/esp32/audio/{resample,wav}.js`、测试风格（`node:test`、临时 `FEIYU_CONFIG`、注入 fake fetch、`globalThis.fetch` 哨兵）。
- 借鉴 `xiaozhi-esp32-server`（只借思路）：provider 元数据含 `fields` schema→前端动态表单、password 脱敏、`{type,...fields}`+选中指针、`custom` HTTP 适配器（本期不做，仅预留）。

## 4. 设计

### 4.1 配置 schema（`contracts.js`，T0，Lead）
- `ASR_PROVIDER_IDS`、`TTS_PROVIDER_IDS` 各加 `volcengine`。
- `asr.openai` 补 `language:''`、`timeoutMs:30000`、`preset:''`。
- 新增 `asr.volcengine`：`apiKey`、`resourceId='volc.bigasr.auc_turbo'`、`modelName='bigmodel'`、`endpoint`(默认官方)、`timeoutMs`。
- `tts.cloud` 补 `speed`、`timeoutMs`、`preset`。
- 新增 `tts.volcengine`：`apiKey`、`resourceId='seed-tts-2.0'`、`speaker`、`speechRate`、`loudnessRate`、`endpoint`、`connectTimeoutMs=5000`（首包）、`idleTimeoutMs`（块间）。
- 全为加字段；`config.mjs` 克隆契约默认值，**无需改**。

### 4.2 Provider registry（`lib/esp32/providers/registry.js`，T1，纯数据，不 import 适配器）
`{kind, id, label, local, testable, fields:[{key,label,type:string|number|select|password,required,secret,default,placeholder,options,advanced}], presets:[{id,label,values}]}`。
预设仅填 `baseUrl`+`model`：ASR（SiliconFlow/Groq/OpenAI/自建 whisper）、TTS（SiliconFlow/OpenAI）。
辅助：`secretPaths()`、`maskEsp32(cfg)`（删密钥置 `hasKey`、删 `token` 置 `tokenSet`）、`stripBlankSecrets(patch)`。
契约测试断言 `contracts ids = registry ids = 工厂已知 ids`。

### 4.3 后端接口（`providers/http.js` 纯函数；`lib/index.js` 仅接线）
- `GET /dsh-feiyu/api/esp32/providers`：schema、预设、非密当前值、`hasKey`、primary/fallback、`pipeline` 健康。
- `POST /dsh-feiyu/api/esp32/providers/test`：`{kind,id,values,persist}`；密钥留空用已存值；15s 超时；错误脱敏、绝不回显 key。
  - ASR：发 1s 静音 WAV；成功/`20000003`/`45000002` 视为连通，鉴权类失败为不通。
  - TTS：合成「你好」，拿到首块即 abort，返回 `ttsFirstMs`。
  - `persist:true` 且通过 → **同一次原子写**：provider 配置 + `primary=云` + `fallback=本地`（ASR 本地=`sensevoice`；TTS 本地=原本地主，无则 `sovits-stream`）；失败不写任何内容；写前留快照。
- `GET /api/config`：`esp32` 段经 `maskEsp32`（同时修复 token 泄露）。
- `POST /api/config`：密钥空串/缺省=保持不变，`null`=清除，丢弃前端回传的 `hasKey`。

### 4.4 火山适配器（官方文档已核实）
- ASR `asr/volcengine.js`：`POST {endpoint}/api/v3/auc/bigmodel/recognize/flash`；headers `X-Api-Key`、`X-Api-Resource-Id`、`X-Api-Request-Id`(uuid)、`X-Api-Sequence:-1`；body `{user:{uid},audio:{data:<b64 wav>},request:{model_name}}`；状态读响应头 `X-Api-Status-Code`：`20000000`→`result.text`；`20000003`/`45000002`→`{text:''}`；`55000031`/其他→抛错交回退层。
- TTS `tts/volcengine.js`：`POST …/api/v3/tts/unidirectional`；headers `X-Api-Key`、`X-Api-Resource-Id`(`seed-tts-2.0` 仅 2.0 音色 / `seed-tts-1.0` 仅 1.0 音色，决定计费)；body `{user,req_params:{text,speaker,audio_params:{format:'pcm',sample_rate:24000,speech_rate,loudness_rate},additions}}`。
  - 解析：`res.body.getReader()` + 括号深度扫描（感知字符串内引号）切 JSON 对象，不依赖换行；`code:0&&data`→base64→对齐 `Int16Array`（奇数字节余量带入下一块）→`{pcm,sampleRate:24000}`；`sentence` 忽略；`20000000` 结束；其他 code 映射中文错误（`45000000` 音色未授权/资源ID与音色版本不匹配、`40402003` 文本超长、并发超限、`55000000`）。
  - 取消/超时：区分 AbortError/TimeoutError，取消时 `reader.cancel()`；首包 `connectTimeoutMs`、块间 `idleTimeoutMs`，不设总时长。
  - 回退配合：首块前错误抛出→回退；首块后错误抛出不回退（沿用 `tts/fallback.js:56` 语义）。
- 工厂 `asr/fallback.js:102-111`、`tts/fallback.js:116,142` 各加 `volcengine` 分支；`openai.js`/`cloud.js` 补读新增配置字段。

### 4.5 管线修复（T5）
- 去掉 `pipeline/index.js:130` 的 `if (stt)`，始终调用 `createAsrProviderFromConfig`；sensevoice 缺 `stt` 抛错被捕获 → `asr=null`（行为同现状）；云 ASR 为主时不再依赖 voice-input。
- 工厂选项透传 `esp32.asr.volcengine`/`esp32.tts.volcengine`；签名加入 `asr`/`tts` 全量配置 sha1（不记明文，保留 `Boolean(stt)`）。
- 工厂记录健康 `{asr:{primary,fallback,ready,error}, tts:{…}, degraded, reason}`（错误已脱敏）；`host.status()` 经可选依赖 `getPipelineHealth`（`lib/index.js` 注入）输出 `pipeline`；`asrAvailable`（`host.js:105-111`）改为"配置的 ASR 可构造或 `stt` 存在"，未注入保持旧行为不破坏 `esp32-host-test`。UI 状态页展示降级原因。

### 4.6 前端（T8/T9）
`settings.html:160-179` 与 `client.js:215-312` 的 ESP32 卡片新增 ASR、TTS 两块：provider 下拉 → 预设下拉（仅 openai 兼容）→ 按 registry `fields` 动态渲染 → 密钥「留空保持不变」+`hasKey` 标签 → 「测试连接」（显示延迟/错误）→「通过后自动启用为主」勾选（默认开）+「仅保存」按钮 → 状态区显示实际生效 provider 与降级原因。火山 TTS 的 resourceId/speaker 旁提示"2.0/1.0 音色需与资源 ID 匹配"。

## 7. 密钥与安全

- 用户提供的火山 API Key 只通过环境变量 `VOLC_API_KEY`（及 `VOLC_TTS_SPEAKER`、`VOLC_TTS_RESOURCE_ID`）给冒烟脚本，运行时落在 `~/.dsh/feiyu.config.json`（不入库）；**不得写入计划、测试、快照、日志**。该 key 已出现在本次对话记录中，冒烟完成后建议在火山控制台轮换。
- `scripts-esp32/*.log` 含 SSID/内网 IP，保持 `.gitignore` 排除。

## 8. 风险

1. 火山 TTS JSON 分块边界不可预期 → 括号深度扫描+奇数字节处理重点单测。
2. `resourceId` 与音色版本不匹配直接 `45000000` → UI 提示+测试连接给出明确错误。
3. 自动切主备会改写用户配置 → 原子写+写前快照，测试失败不写。
4. `lib/index.js`/`client.js` 为上游共享文件 → 最小接线，便于合并上游。
5. 云故障时每句先等主 provider 失败 → 首包超时 5s；熔断列为后续项。
6. 需用户在火山控制台确认：已开通 ASR 极速版（`volc.bigasr.auc_turbo`）与 TTS 资源，并提供要用的 `speaker`（2.0 或 1.0 音色，影响计费）。


## 10. 新增 provider 开发指南

1. `lib/esp32/contracts.js`：在 `ASR_PROVIDER_IDS` / `TTS_PROVIDER_IDS` 加 id，并在 `DEFAULT_ESP32_CONFIG.asr|tts.<id>` 加默认配置（密钥默认空串）。
2. 适配器：`lib/esp32/asr|tts/<id>.js`，实现 `AsrProvider` / `TtsProvider` 契约；错误要脱敏 key，TTS 首块前失败才会触发回退。
3. 工厂：在 `asr/fallback.js`、`tts/fallback.js` 加分支。
4. `lib/esp32/providers/registry.js`：加 `fields` schema（密钥字段 `type:'password',secret:true`）；前端表单自动生成。
5. 测试：fake fetch 单测 + registry/contract 一致性测试自动覆盖 id 对齐。
