# dsh-feiyu 改进需求清单

> 来源：[2026-11-18 插件功能设计评估](2026-11-18-plugin-feature-design-review.md)
> 日期：2026-11-18　｜　分支：feat/esp32-channel（HEAD c95955e）
> 范围：把评估报告中的 100 条发现归并为 20 项可验收的改进需求；不含新功能。
> 原则：先收口安全与数据边界，再补 live 记忆与成本治理，最后做架构与工程演进。

## 0. 优先级与工作量定义

| 级别 | 含义 | 时间窗 |
| --- | --- | --- |
| **P0** | 安全、数据完整性或整体可用性的阻断项；未完成前不再扩大功能面 | 本周（M1） |
| **P1** | 显著影响 live 记忆、成本或数据可靠性的治理项 | 2–4 周（M2） |
| **P2** | 架构、可维护性与工程质量演进 | 1–2 个月（M3） |

工作量：**S** ≤ 0.5 天｜**M** 1–3 天｜**L** 1–2 周｜**XL** > 2 周。
验收：每条需求至少包含一个可自动化的测试或可复现的检查；无测试手段的项必须给出可观测证据。

## 1. 需求总览

| ID | 需求 | 优先级 | 类型 | 工作量 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| R-01 | ESP32 网关安全模型重构 | P0 | 安全/架构 | L | — |
| R-02 | 配置单一权威与原子存储 | P0 | 可靠性/架构 | M | — |
| R-03 | 密钥集中与脱敏审计 | P0 | 安全 | M | R-02 |
| R-04 | 外发统一闸门与本地控制面鉴权 | P0 | 安全/一致性 | L | — |
| R-05 | 宿主生命周期与自愈 | P0 | 可靠性 | M | — |
| R-06 | 调度仲裁与提交语义 | P0 | 可靠性 | M | R-02 |
| R-07 | 大脑 live 隐私隔离与装配完整性 | P1 | 架构/隐私 | L | R-04 |
| R-08 | 记忆账本正确性与并发一致性 | P1 | 正确性 | M | — |
| R-09 | 记忆性能、保留与归档可检索 | P1 | 性能/数据 | L | R-08 |
| R-10 | 成本计量与硬预算闸门 | P1 | 成本/可观测 | M | — |
| R-11 | 备份、导出与恢复演练 | P1 | 数据安全 | M | R-03 |
| R-12 | 提示注入与不可信内容边界 | P1 | 安全 | M | — |
| R-13 | ESP32 音频节流与 TTS 韧性 | P1 | 性能/可靠性 | L | — |
| R-14 | ESP32 会话状态机与契约治理 | P2 | 可靠性/架构 | M | R-01 |
| R-15 | 多通道一致性收敛 | P2 | 架构/一致性 | L | R-04 |
| R-16 | 设置面板可维护性与交互修复 | P2 | 可维护性/UX | L | R-03 |
| R-17 | 测试治理与 CI | P2 | 工程质量 | M | — |
| R-18 | 宿主壳模块化 | P2 | 架构 | L | R-05 |
| R-19 | 可观测性与诊断 | P2 | 可运维性 | M | R-01/R-05 |
| R-20 | 自我升级与发布治理 | P2 | 治理 | S | R-11 |

## 2. 里程碑与发布门槛

### M1 · 治理与安全收口（本周，R-01～R-06）
**G1 发布门槛：**
- [ ] 新安装默认不在 `0.0.0.0` 暴露 ESP32 网关；未配对设备无法取得 token。
- [ ] 坏 JSON 配置无法被面板保存覆盖；并发写入不丢键；原文件有 `.bak`。
- [ ] `guard.dryRun=true` 时任何外发路径（含唱歌/语音/表情）都不会真正发送。
- [ ] `GET /api/config` 响应体不含任何密钥值。
- [ ] 插件卸载后无残留 timer/子进程；网关失败可自愈或手工重启。
- [ ] 调度器单 tick 最多投递一次唤醒；投递失败可重试。

### M2 · live 记忆与成本/数据治理（2–4 周，R-07～R-13）
**G2 发布门槛：**
- [ ] live 切换检查表通过：群聊/陌生人无主人隐私；旧层槽位齐全；ESP32 事件入库。
- [ ] 账本覆盖 QQ/抖音/ESP32 与流式调用；硬预算可拦截。
- [ ] 备份包含 `~/.feiyu-ai` 数据且可恢复演练通过；导出/导入/校验命令可用。
- [ ] 10 万条合成情景下，单条消息的装配/召回延迟在预算内。
- [ ] 音频链路长句发送节奏符合 60ms/帧；坏 provider 会熔断。

### M3 · 通道与工程质量（1–2 个月，R-14～R-20）
**G3 发布门槛：**
- [ ] `npm run test:all` 单一清单驱动全部套件，发现文件与登记文件一致。
- [ ] Windows CI/夜间任务绿；宿主路由 403/503/异常分支有行为测试。
- [ ] `client.js` 拆分完成；保存失败回滚；关键交互有测试。
- [ ] `doctor` 能报告配置/运行时/双自我源/测试清单的一致性。

---

## 3. P0 详细需求

### R-01 ESP32 网关安全模型重构

- **优先级**：P0｜**类型**：安全/架构｜**工作量**：L｜**依赖**：—
- **问题**：OTA 端点无鉴权直接下发 Bearer token；网关默认 `0.0.0.0` 且 `enabled:true`；白名单为空且 Device-Id 可伪造；ws 明文；配置快照化导致热更新不生效；token 写回失败时状态不一致。
- **需求**：
  1. 默认 `esp32.enabled:false`，监听地址默认 `127.0.0.1`；开启局域网暴露必须显式选择网卡并二次确认。
  2. OTA 引入一次性配对码/首次绑定窗口：只有完成配对的设备才能拿到 token；配对码限时、限次、可撤销。
  3. 设备身份改为服务端签发的凭据（或预共享密钥），`allowDevices` 不再信任可伪造的 `Device-Id` 请求头；可选 IP/MAC 绑定。
  4. 增加设备数/连接数上限与每设备速率限制；同一 Device-Id 只保留一个会话。
  5. 保存 `esp32` 配置后触发热应用或明确提示重启；`status` 报告“配置 vs 运行态”差异与 token 来源。
  6. 文档明确局域网信任边界；条件允许时支持 wss 或反代，并标注明文 ws 风险。
- **验收标准**：
  - [ ] 新安装启动后 `netstat` 无 `0.0.0.0:8765` 监听（除非显式开启）。
  - [ ] 未配对请求 `GET /xiaozhi/ota/` 返回 401/403；配对后首次成功、重放失败。
  - [ ] 伪造 Device-Id 但无凭据的 WS upgrade 被拒绝。
  - [ ] `test/esp32-gateway-test.mjs` 覆盖未配对/配对/重放/白名单/连接上限。
  - [ ] 手册与 `DEPLOY.md` 更新配对流程与风险说明。
- **涉及代码**：`lib/esp32/gateway.js`、`lib/esp32/contracts.js`、`lib/esp32/host.js`、`lib/index.js`、`client.js`、`docs/esp32-channel-manual.md`、`DEPLOY.md`
- **对应发现**：OTA 无鉴权向任意局域网客户端下发 WS token；ESP32 网关默认监听 0.0.0.0；网关配置快照化与热更新不对称；token 写回失败时状态不一致。

### R-02 配置单一权威与原子存储

- **优先级**：P0｜**类型**：可靠性/架构｜**工作量**：M｜**依赖**：—
- **问题**：宿主读配置失败返回 `{}`，面板保存以空对象为基底深合并，坏 JSON 会把整份配置静默清空；`focus`/`voice`/`mood` 等直接非原子写；无 schema/版本；深合并三处实现；单实例锁是 TOCTOU。
- **需求**：
  1. 抽出唯一配置服务，宿主与 CLI 共用：严格读（解析失败抛错）、schema 校验、临时文件 + fsync + rename、`.bak` 轮转、读改写文件锁。
  2. `POST /api/config` 遇坏 JSON 返回 409 并提示先修复，禁止以 `{}` 继续写；写前统一生成 `.bak`。
  3. 为关键段（`guard`/`esp32`/`llm`/`qq`）定义轻量 schema（类型、范围、枚举），非法值回退安全默认并在 `selftest` 报红。
  4. 增加 `configVersion` 与 `migrate()`；示例配置由 DEFAULTS/contracts 生成并校验一致。
  5. 替换 `focus`/`voice`/`mood`/调度状态等直写为非原子路径；损坏文件先备份为 `.corrupt-<ts>` 并记日志。
  6. 单实例锁改为 `O_EXCL` 原子创建 + pid/nonce/心跳/超时回收；统一深合并实现。
- **验收标准**：
  - [ ] 写入坏 JSON 后 POST 保存返回 409，原文件字节不变。
  - [ ] 两个进程并发读改写 100 次，无键丢失；`.bak` 存在且可回滚。
  - [ ] 非法 `guard.dryRun` 类型回退为 `true`，selftest 报红。
  - [ ] `configVersion` 迁移测试通过；示例文件与默认值一致。
  - [ ] 单实例锁并发启动测试只有一个实例获得锁。
- **涉及代码**：`lib/index.js`、`tools/lib/config.mjs`、`tools/lib/paths.mjs`、`tools/lib/mood.mjs`、`tools/commands/focus.mjs`、`tools/commands/voice.mjs`、`lib/scheduler.js`
- **对应发现**：配置持久化多写入者与非原子路径；面板保存把坏 JSON 当空配置；配置无 schema/版本；深合并三处实现；单实例锁 TOCTOU；mood 并发覆盖（盲区补充）。

### R-03 密钥集中与脱敏审计

- **优先级**：P0｜**类型**：安全｜**工作量**：M｜**依赖**：R-02
- **问题**：`GET /api/config` 只脱敏 `llm/imageGen/vision.api_key` 与 esp32 段，`ledger.apiKey`、`video.animate.apiKey` 仍明文返回；密钥明文落配置并被备份滚动复制；TTS 错误文本脱敏不一致。
- **需求**：
  1. 建立全局 `SECRET_PATHS` 注册表（路径 → 类型），GET/POST 统一按它脱敏与保留；新增密钥字段必须登记。
  2. 密钥迁移到独立 secrets 文件（Windows ACL/0600），配置只存引用；支持环境变量覆盖。
  3. 备份排除或加密 secrets；`.gitignore` 与手册列出敏感文件清单。
  4. 抽出共享错误清洗函数（key、Authorization、路径、URL query），所有 ASR/TTS/LLM provider 共用。
  5. 面板只显示“已配置/未配置”，不回显值。
- **验收标准**：
  - [ ] 响应体递归检查不含任何已知密钥字段的值；为每条 `SECRET_PATHS` 加单测。
  - [ ] secrets 文件权限检查通过；备份清单无 secrets。
  - [ ] 错误日志脱敏测试覆盖 key/Authorization/URL/path。
- **涉及代码**：`lib/index.js`、`lib/esp32/providers/http.js`、`tools/lib/config.mjs`、`tools/lib/cred.mjs`、`tools/commands/selfup.mjs`、TTS/ASR provider
- **对应发现**：GET /config 把未在脱敏名单里的密钥原样返回；密钥明文落配置并被备份复制；TTS 错误文本脱敏不一致。

### R-04 外发统一闸门与本地控制面鉴权

- **优先级**：P0｜**类型**：安全/一致性｜**工作量**：L｜**依赖**：—
- **问题**：QQ 唱歌分支在 dryRun 检查之前直接发送；本地控制面 `/onebot` `/event` `/task` 无 token/Origin 校验；微信对任意私聊以主人身份自动回复；B站主动向陌生人搭话默认启发式；断言闸门只在 QQ 生效；配额 check-then-write 跨进程无锁；宿主回环判断信任 Host 头。
- **需求**：
  1. 建立唯一 `outbound.send()`：统一执行 dryRun、联系人白名单、`guard.clean`、复读/间隔检查与审计；聊天、唱歌、语音、表情、图片、群聊全部走它。
  2. 本地控制面加 per-process Bearer token，校验 `Origin`/`Content-Type`；`/task` 必须鉴权；事件入口校验来源白名单。
  3. 微信回复白名单默认空（空=不回复），非白名单只出草稿/通知；B站陌生搭话独立开关且默认关。
  4. 把 `craftReply`/声称-证据闸提升为发送前统一钩子，QQ/抖音/ESP32 共用。
  5. “检查配额 + 发送 + 记账”放进同一临界区（复用 `tools/lib/lock.mjs`）；水位文件 tmp+rename。
  6. 回环判断改用 `req.socket.remoteAddress`，正确处理 IPv6 映射；策略可配置。
- **验收标准**：
  - [ ] `dryRun=true` 时对唱歌/语音/表情路径断言 `send` 从未被调用。
  - [ ] 控制面缺 token 401、错误 Origin 403；`/task` 未授权不可入队。
  - [ ] 微信非白名单联系人不产生自动回复。
  - [ ] 配额并发测试不超发；回环伪造 Host 测试被拒绝。
- **涉及代码**：`tools/commands/qq-server.mjs`、`tools/lib/outbox.mjs`、`tools/lib/guard.mjs`、`tools/lib/share-policy.mjs`、`tools/lib/reply-style.mjs`、`lib/index.js`、`wechat/wechat_bot.py`、`tools/commands/bili-watch.mjs`
- **对应发现**：QQ 唱歌绕过 dryRun；QQ 本地控制端无鉴权；微信对任意私聊自动回复；B站主动搭话启发式；断言闸门仅 QQ 生效；配额 check-then-write；回环校验只看 Host 头。

### R-05 宿主生命周期与自愈

- **优先级**：P0｜**类型**：可靠性｜**工作量**：M｜**依赖**：—
- **问题**：多个 `setTimeout` 未保存句柄，卸载后仍可能拉起 NapCat/SoVITS；ESP32 网关无看门狗/重启端点；SoVITS 拉起绑定 QQ 生命周期；端口清理按端口杀任意 node.exe；ESP32 模块静态 import，加载失败拖垮全部通道。
- **需求**：
  1. 统一 timer 注册表与 `disposed` 标志；disposer 中 clearTimeout/clearInterval，并 `await esp32Host.stop()`。
  2. ESP32 网关 60s 健康 tick + 限频退避重启；暴露 `POST /api/esp32/restart`；配置变更触发。
  3. `sovitsWanted` 纳入 `esp32.enabled`/网关 running；首次 TTS 前 `ensureSovits`；状态接口暴露 `sovitsAvailable`。
  4. 端口清理前用 CIM/wmic 校验命令行归属；非本项目占用时返回可操作错误，不误杀。
  5. ESP32 模块改为 `apply` 内动态 import + try/catch，失败置 `unavailable`，其余通道继续。
- **验收标准**：
  - [ ] 卸载/热重载测试后无残留 timer、无孤儿进程、端口释放。
  - [ ] 模拟网关启动失败，健康 tick 在限定次数内恢复或返回明确错误。
  - [ ] 纯 ESP32 部署（qq 关闭）首次语音时 SoVITS 自动可用。
  - [ ] 外来 node 进程占用 8080/8095 时不会被杀，面板显示占用来源。
  - [ ] ESP32 模块导入失败时其他通道仍可用。
- **涉及代码**：`lib/index.js`、`lib/esp32/host.js`、`lib/scheduler.js`
- **对应发现**：卸载清理未清 setTimeout；ESP32 无看门狗/重启；SoVITS 绑定 QQ；端口清理误杀；ESP32 静态 import。

### R-06 调度仲裁与提交语义

- **优先级**：P0｜**类型**：可靠性｜**工作量**：M｜**依赖**：R-02
- **问题**：单 tick 依次投递回顾/进化/自由/B站多条 prompt；完成标记先于投递，失败永久跳过；忙闲检测依赖 DSH 私有会话文件布局并同步遍历；时间用字符串比较、无补跑上限。
- **需求**：
  1. 建立单一唤醒仲裁：子 tick 只返回“想投递的事件”，仲裁器按优先级每分钟最多投递一条。
  2. 完成标记改为投递成功后提交（或 pending + 短重试窗口）；失败回滚并记录原因。
  3. 忙闲检测优先用 `sessionController` 状态/活动时间 API；兜底用宿主自记的最后活动时间；禁止每 tick 同步全树扫描。
  4. `HH:MM` 解析为分钟数并校验；补跑限制在 30–60 分钟窗口，加抖动与幂等键；补跨午夜/睡眠恢复测试。
  5. 调度状态文件使用 R-02 的原子写工具。
- **验收标准**：
  - [ ] fake controller 抛错时标记不提交，下个 tick 重试；同一 tick 最多一次 prompt。
  - [ ] 跨午夜、非法时间格式、睡眠 8 小时后恢复的单元测试通过。
  - [ ] 忙闲检测不再每 tick 递归扫描 sessions 目录。
- **涉及代码**：`lib/scheduler.js`、`tools/brain/clock.mjs`、`tools/lib/night-plan.mjs`
- **对应发现**：调度器单 tick 多唤醒；标记先于投递；忙闲检测依赖内部布局；定时字符串比较与集中补发（盲区补充）。

---

## 4. P1 详细需求

### R-07 大脑 live 隐私隔离与装配完整性

- **优先级**：P1｜**类型**：架构/隐私｜**工作量**：L｜**依赖**：R-04
- **问题**：`assemble` 无条件注入【你自己】、facts、intents、欠债；`ownerIds: []` 语义是“私聊一律当主人”；live 丢失 recallAll/画像/worldBlock/mood 等旧层；ESP32 只写旧记忆不发 brain 事件；注意力/工作记忆槽位未接线；自我快照双源不同步。
- **需求**：
  1. 在 `assemble` 按 `userId ∈ ownerIds` 判定主人；群聊跳过 facts/intents/debts/self；陌生人私聊跳过 owner-only 内容；`ownerIds` 默认不再“全部当主人”。
  2. 把 `recallAll`、`qqMemory` 画像/摘要、`worldBlock`、`mood.stateBlock` 作为过渡槽接回，并设预算优先级。
  3. 所有通道双写 brain 事件：ESP32 在用户发言与完整回复处调用 `brain.onEvent`；被打断只记已下发部分。
  4. 接线 attention.claim→next→done 与 working.refresh；未用槽位删除或显式标注。
  5. 自我快照确定单一权威（建议 `self/me.md` 管内容、`persona.md` 管文风），doctor 校验一致性。
  6. live 切换门槛：逐块对照测试、群聊/陌生人隐私测试、事件覆盖测试全部通过后才允许 `mode=live`。
- **验收标准**：
  - [ ] live 群聊/陌生人 system prompt 不含主人 facts/debts/self；主人私聊包含。
  - [ ] 旧层槽位在 live 下有对应内容；预算超限时有确定裁剪顺序。
  - [ ] ESP32 一轮对话产生 user/assistant 两条 brain 事件。
  - [ ] live 切换检查表作为测试套件运行，失败即阻止切换。
- **涉及代码**：`tools/brain/assemble.mjs`、`tools/brain/index.mjs`、`tools/brain/attention.mjs`、`tools/brain/working.mjs`、`tools/lib/persona.mjs`、`tools/lib/config.mjs`、`lib/esp32/brain-bridge.js`
- **对应发现**：群聊/陌生私聊注入主人事实；live 丢失旧层；ESP32 不发脑事件；注意力/工作记忆未接线；自我快照双源。

### R-08 记忆账本正确性与并发一致性

- **优先级**：P1｜**类型**：正确性｜**工作量**：M｜**依赖**：—
- **问题**：facts/intents 全量读改写无锁，盲覆盖；事实键把对象纳入 `keyOf`，冲突裁决恒不可达；自动巩固 spawn 不带 `--llm` 却标记 done；inbox 游标先推进后落库；租约 `settle/complete` 不校验 fencing；记忆强度反馈空转。
- **需求**：
  1. facts/intents 读改写放入 `tools/brain/store.mjs` 的 `withLock`，锁内重新 load 后合并写出；或改为追加 JSONL + 派生索引。
  2. 事实键改为 `s|p` 或显式 slot；同主谓不同对象进入 rivals，按时间/来源裁决；迁移现网数据并补“改口/矛盾”测试。
  3. `--llm` 做成配置开关并由定时任务显式传入；规则抽取与 LLM 抽取使用不同 done 游标；低置信片段保留待重跑。
  4. inbox 先 durable ingest 再推进游标；启动时按 episode id 去重重放，保证至少一次消费。
  5. `settle/complete` 必须校验 fencing/holder，不匹配返回 stale 并拒绝写入。
  6. 记忆强度与命中反馈要么接线（`touchStrength` → salience），要么从评测权重中移除。
- **验收标准**：
  - [ ] 两个进程并发写 facts 100 次无丢失；锁过期可回收。
  - [ ] 矛盾事实测试产生 superseded/rivals，而不是叠加。
  - [ ] 定时巩固命令包含 `--llm`（可配置），游标分离。
  - [ ] 崩溃注入测试不丢事件；过期租约写入被拒绝。
- **涉及代码**：`tools/brain/facts.mjs`、`tools/brain/intents.mjs`、`tools/brain/store.mjs`、`tools/brain/consolidate.mjs`、`tools/brain/event.mjs`、`tools/brain/claim.mjs`、`tools/brain/recall.mjs`、`tools/commands/qq-server.mjs`
- **对应发现**：facts/intents 无锁；事实冲突裁决不可达；巩固不调 LLM；inbox 游标先推进；租约 fencing 未校验；记忆强度空转。

### R-09 记忆性能、保留与归档可检索

- **优先级**：P1｜**类型**：性能/数据｜**工作量**：L｜**依赖**：R-08
- **问题**：每条消息 `onEvent` 先 ingest 后 `allEpisodes`，写入后清空缓存导致再次全读；倒排索引按 size/mtime 全量重建；inbox 历史文件无清理；旧库 `.archive.jsonl` 从不读取，月度分片又不 sweep，记忆能否召回取决于轮转位置。
- **需求**：
  1. 情景按月分片 + 每片行偏移/尾增量索引；`onEvent` 只追加新事件，不再全量 `allEpisodes`。
  2. inbox 按 cursor 从上次偏移读取并清理已消费文件；每轮心跳不全量扫。
  3. 统一 archive 与 shard 的读取语义：归档数据按需可检索（只读），明确保留/压缩策略。
  4. 用 10 万行合成数据建立延迟预算测试，纳入回归。
  5. 把 `brain.mode=live` 的切换条件与数据量门槛写进设计文档。
- **验收标准**：
  - [ ] 10 万条情景下，单条消息装配/召回 p95 在预算内（基线由基准测试固定）。
  - [ ] 归档记忆可通过 `recall`/`mem grep` 检索到。
  - [ ] inbox 消费后文件被清理或归档，磁盘不再单调增长。
  - [ ] 延迟基准在 CI 或夜间任务中可重复。
- **涉及代码**：`tools/brain/index.mjs`、`tools/brain/episode.mjs`、`tools/brain/index-inv.mjs`、`tools/brain/event.mjs`、`tools/brain/recall.mjs`、`tools/lib/memory.mjs`
- **对应发现**：长期记忆全量重扫且保留规则分裂；inbox 无清理；归档不可召回。

### R-10 成本计量与硬预算闸门

- **优先级**：P1｜**类型**：成本/可观测｜**工作量**：M｜**依赖**：—
- **问题**：`llm.chat/chatStream` 丢弃 `usage`；账本只扫 DSH 会话日志，QQ/抖音/ESP32 直连调用不入账；ASR/TTS/生图/视频不计费；`dailyBudget` 只写进提示词，无调用前拦截。
- **需求**：
  1. 在 `llm.chat/chatStream` 单一出口读取并累计 `usage`（含流式最后一帧、fallback、重试）；按通道/功能/日期落账。
  2. 账本接入 QQ/抖音/ESP32 直连调用与云 ASR/TTS、生图、视频。
  3. 请求前硬预算闸门：软阈值提醒，硬阈值拒绝或降级本地模型；阈值可配置。
  4. 提供按通道/功能的成本归因接口与面板展示；区分实际账单与估算。
- **验收标准**：
  - [ ] fake LLM 返回 usage 时账本准确累加（含流式）。
  - [ ] QQ/抖音/ESP32 各发起一次调用后，账本均出现记录。
  - [ ] 硬阈值下调用被拒绝或降级，并有审计日志。
  - [ ] 面板显示各通道成本占比。
- **涉及代码**：`tools/lib/llm.mjs`、`tools/lib/ledger.mjs`、`tools/lib/ledger_usage.py`、`lib/scheduler.js`、`lib/esp32/brain-bridge.js`、`lib/esp32/asr/*`、`lib/esp32/tts/*`
- **对应发现**：付费 LLM 调用绕过账本；ASR/TTS 未计量；dailyBudget 只提示不拦截。

### R-11 备份、导出与恢复演练

- **优先级**：P1｜**类型**：数据安全｜**工作量**：M｜**依赖**：R-03
- **问题**：`selfup` 备份 2.3GB 可重装依赖并保留 10 份，却不备份 `episodes/brain/facts/lore`；自动备份 `catch {}` 静默失败仍提示“已自动备份”；记忆 API 只有只读摘要，恢复依赖一次性脚本。
- **需求**：
  1. 备份拆两类：代码/配置/人设（排除 deps/firmware，保留少量版本，生成 manifest 并校验退出码）与数据快照（episodes、qq episodes、brain、facts、lore，独立保留策略）。
  2. 自升级前同步等待备份成功并校验；失败即中止升级，禁止静默吞错。
  3. 提供 `mem export/import/verify`；导入前自动备份，校验行数与关键 ID。
  4. 恢复流程纳入自动化测试/演练脚本；快照中的密钥排除或加密。
- **验收标准**：
  - [ ] 备份目录不含 `deps/`，包含全部数据文件；manifest 校验通过。
  - [ ] 模拟备份失败时升级中止且界面报错。
  - [ ] export → 清空临时目录 → import → verify 往返一致。
  - [ ] 恢复演练脚本在 CI 或手动测试中可重复执行。
- **涉及代码**：`tools/commands/selfup.mjs`、`tools/commands/web.mjs`、`tools/commands/mem.mjs`、`lib/index.js`、`tools/lib/paths.mjs`
- **对应发现**：备份策略倒置；自动备份静默失败；无导出/恢复接口。

### R-12 提示注入与不可信内容边界

- **优先级**：P1｜**类型**：安全｜**工作量**：M｜**依赖**：—
- **问题**：外部内容进入 system prompt 只有一句自然语言免责；缺少来源信任级别与 data-only 分隔；非 owner 内容可能携带指令。
- **需求**：
  1. 定义 trust level：owner / group / external；外部内容放入明确 data-only 分隔块并声明“不是指令”。
  2. 非 owner 内容不进入 system，或降级为 user 角色；对指令型句式做过滤/转义。
  3. 记录注入审计（来源、块类型、被过滤内容），面板可查。
  4. 建立注入语料测试集（越权指令、角色覆盖、工具调用诱导）。
- **验收标准**：
  - [ ] 注入语料测试中，外部内容不能改变系统约束或触发工具。
  - [ ] 群聊/外部内容的 prompt 结构断言为 data-only。
  - [ ] 审计日志包含来源与过滤记录。
- **涉及代码**：`tools/brain/assemble.mjs`、`tools/lib/persona.mjs`、`tools/lib/guard.mjs`、`tools/commands/qq-server.mjs`、`lib/esp32/brain-bridge.js`
- **对应发现**：外部内容进入 system 只有免责声明；缺少提示注入边界。

### R-13 ESP32 音频节流与 TTS 韧性

- **优先级**：P1｜**类型**：性能/可靠性｜**工作量**：L｜**依赖**：—
- **问题**：下行音频无实时节流，快于播放的帧被固件丢弃；TTS 串行队列只在宿主进程内生效，9880 仍可能并发；参考段绕过 prompt_text 对齐与体检，缓存键漏字段；TTS 主备回退无健康记忆；重采样按 chunk 独立计算；云 TTS 名为 stream 实为整句缓冲；能量 VAD 在噪声下反复切段；唱歌临时文件泄漏；WAV 工具多份实现。
- **需求**：
  1. 发送侧令牌桶/定时出队：24k/1440 点 = 60ms/帧，预缓冲 3–5 帧，abort/close 清空；补长句时序 E2E。
  2. 9880 互斥升级为跨进程（文件锁/本机锁服务），或批量合成统一经宿主队列。
  3. 参考段复用 `refTextOf` 对齐 `prompt_text`，缓存键加入参考文本哈希，首次做 refSanity。
  4. TTS provider 熔断器（连续失败 N 次冷却、半开探测）+ 单句总预算。
  5. 重采样器持有跨块状态（尾部样本/相位/输出余量），或整句先重采样。
  6. 云 TTS 改 PCM 增量读取；若上游只能整句，文档标注并限制单句长度。
  7. VAD 增加谱平坦度/过零率/语音占比门槛与切段退避。
  8. 唱歌临时文件 try/finally 清理；WAV 统一到 `lib/esp32/audio/wav.js`。
- **验收标准**：
  - [ ] 长句 E2E 断言发送节奏为 60ms/帧、无突发丢帧。
  - [ ] 坏主 provider 在 N 次失败后熔断，后续句子直接走备且不重复付超时。
  - [ ] 参考段对齐/缓存键/refSanity 单测通过。
  - [ ] 重采样连续性测试（跨块正弦波）无明显不连续。
  - [ ] 噪声 VAD 测试不产生连续 max-cut。
- **涉及代码**：`lib/esp32/tts/*`、`lib/esp32/audio/*`、`lib/esp32/vad.js`、`lib/esp32/pipeline/*`、`tools/lib/tts.mjs`、`tools/lib/sing.mjs`
- **对应发现**：下行音频无实时节流；9880 跨进程并发；参考段对齐/缓存键；TTS 回退无健康记忆；重采样无跨块状态；云 TTS 整句缓冲；VAD 噪声切段；唱歌临时文件；WAV 多实现。

---

## 5. P2 详细需求

### R-14 ESP32 会话状态机与契约治理

- **优先级**：P2｜**类型**：可靠性/架构｜**工作量**：M｜**依赖**：R-01
- **问题**：manual（BOOT 键）语义只落在会话层，管线 VAD 仍会截断整段；状态机无阶段级超时，ASR 可长时间挂起；同一 Device-Id 可并存多个会话共享记忆；会话 VAD 与管线 VAD 两套归属模型；记忆按“已 yield 句子”而非“已下发音频”写入；TTS 失败静默；问候补播与新轮次共用 framer 无互斥；契约“Lead 独占”只是注释。
- **需求**：
  1. 把 listen mode 透传到管线；manual 模式不跑 VAD，只听 stop 后整段转写；补 E2E。
  2. 为每个阶段加 turn deadline（ASR 60s、整轮 120s），超时回 listening 并上报错误。
  3. 设备注册表以 Device-Id 为唯一键；新会话先 abort + close 旧会话；设备数/连接数上限。
  4. 收敛为一套 VAD 归属模型（建议管线持有，会话消费），删除另一套与测试分支。
  5. 记忆写入改为“句子音频完整发送后回执”，或修正契约注释并补测试。
  6. TTS 失败聚合到 `onError({stage:'tts'})`，状态页可见；连续失败降级。
  7. 问候与轮次互斥，旧轮次 token 不得结束新轮次。
  8. 契约增加 `CONTRACT_VERSION` 输出到 status；增加 import 图测试禁止跨泳道实现 import；provider id 校验。
- **验收标准**：
  - [ ] manual 模式说完整段才转写；E2E 通过。
  - [ ] 模拟 ASR 挂起 60s 后回 listening 并记录错误。
  - [ ] 同 Device-Id 第二次 hello 会替换旧会话；记忆不串。
  - [ ] TTS 连续失败触发降级且 lastError 可见。
  - [ ] 架构测试拒绝跨泳道 import；status 含契约版本。
- **涉及代码**：`lib/esp32/session.js`、`lib/esp32/pipeline/*`、`lib/esp32/host.js`、`lib/esp32/contracts.js`、`lib/esp32/tts/queue.js`
- **对应发现**：manual 语义只到会话层；阶段无超时；同 Device-Id 多会话；VAD 双归属；记忆按 yield 句子；TTS 失败静默；问候互斥；契约无机制保障。

### R-15 多通道一致性收敛

- **优先级**：P2｜**类型**：架构/一致性｜**工作量**：L｜**依赖**：R-04
- **问题**：微信自建记忆/LLM 绕过共享内核（属文档明示 I7，但配置与实现重复）；B站 CDP 硬编码仓库外脚本；配额配置键漂移；通道开关语义不一致、自治子开关默认偏开；抖音三个入口 chatId 割裂；QQ 单文件承载六种职责；微信记忆隔离双开关；抖音私信水位只按文本指纹；图片生成 `execFileSync` 阻塞；唱歌/换声硬编码绝对路径。
- **需求**：
  1. 建立通道身份注册表：platform/chatId/userId/scope 由一处映射生成，抖音评论/私信统一命名。
  2. 定义唯一通道开关矩阵：父开关被所有入口检查；自治子开关默认 false；设置页显示开启后的连带能力。
  3. 抽取共享 quota descriptor（key → 文件 → 上限），ledger/produce/act 共用并加一致性测试。
  4. 微信显式化：选择“纯传输层走 brain API”或“显式独立 brain profile”，只保留一个配置块；回复白名单默认空。
  5. QQ server 按 transport/chat/proactive/promises/group/qzone/task 拆分，`qq-server.mjs` 只做装配与生命周期。
  6. B站 CDP 助手 vendored 或配置化并在启动时自检；唱歌/RVC 外部路径配置化 + 安装自检；图片生成改异步。
- **验收标准**：
  - [ ] 身份注册表单测覆盖五通道；chatId 不再由各入口各自拼装。
  - [ ] 开关矩阵测试：父开关关闭时所有入口不工作；子开关默认 false。
  - [ ] quota descriptor 与 DEFAULTS 一致性测试通过。
  - [ ] 微信模式只由一处配置决定，面板显示是否写入共享记忆。
  - [ ] QQ 拆分后原测试全绿，单文件行数显著下降。
- **涉及代码**：`lib/connections*.js`、`tools/commands/qq-server.mjs`、`tools/commands/douyin*.mjs`、`tools/lib/bili-api.mjs`、`tools/lib/ledger.mjs`、`tools/lib/config.mjs`、`wechat/wechat_bot.py`
- **对应发现**：微信双实现；B站 CDP 硬编码；配额键漂移；开关语义不一致；抖音 chatId 割裂；QQ 单文件；微信双开关；抖音水位；图片生成阻塞；外部路径硬编码。

### R-16 设置面板可维护性与交互修复

- **优先级**：P2｜**类型**：可维护性/UX｜**工作量**：L｜**依赖**：R-03
- **问题**：2141 行单文件、手写 60 键 draft 映射、默认值三处维护；保存失败不回滚；数值框清空保存 0 导致额度变不限；状态/日志无轮询；多设备只展示第一台；表单标签未关联；B站 cookie 丢弃后端校验结果；测试连接必然切换主 provider；登录流程 stop 后永久 dead；registry 声明了未实现的 UI 类型。
- **需求**：
  1. 拆分面板为子模块（目标单文件 <500 行），或改为 schema 驱动；`GET /config` 返回服务端合并后的有效值与字段 schema，前端不再抄默认。
  2. 保存失败回滚 draft 或按保存成功后的 cfg 刷新；数值框空串拒绝提交；安全阈值/额度显式默认值。
  3. 面板可见时轮询 status/log（5–10s，复用 429 退避）；多设备选择器或气泡标注 deviceId。
  4. Field 生成稳定 id 并关联 label；状态摘要可聚焦/展开；补 reduced-motion 与窄屏断点。
  5. B站 cookie 保存后用返回的 self/detail 提示；测试连接增加“通过后设为默认”选项。
  6. 登录流程在 effect 内创建/销毁，支持 StrictMode 重建；统一清理定时器。
  7. 实现 select/advanced 或删除声明并用测试锁定支持的 type。
- **验收标准**：
  - [ ] `client.js` 拆分后各模块有独立测试；保存失败状态不变。
  - [ ] 空数值不提交 0；阈值/额度回显安全默认。
  - [ ] 状态/日志自动刷新；多设备可切换。
  - [ ] a11y 检查（label 关联、键盘可达）通过。
  - [ ] 测试连接不改变主 provider（除非勾选）。
- **涉及代码**：`client.js`、`lib/esp32/providers/registry.js`、`lib/esp32/channel-log.js`、`docs/frontend-manual.md`
- **对应发现**：2141 行单文件/60 键映射；保存失败不回滚；空数值变 0；无轮询；多设备展示；a11y；cookie 校验丢失；测试连接切换；登录流程 dead；registry 未实现类型。

### R-17 测试治理与 CI

- **优先级**：P2｜**类型**：工程质量｜**工作量**：M｜**依赖**：—
- **问题**：三套手工测试清单双向漂移；`run-tests.mjs` 声称与 `npm test` 等价但实际不等价；主回归入口因硬编码外部 Python 路径当前必然失败；`&&` 串行首败即停；无超时；E2E 只覆盖 fake 管线；UI 三套机制并行；无 CI；性能阈值混在功能测试；E2E 依赖日志形状；文档计数漂移。
- **需求**：
  1. 单一清单/目录约定驱动 `npm test`、`run-tests.mjs`、E2E；提供 `test:all`；运行时断言“已发现文件 = 已登记文件”。
  2. 每个套件设超时（如 180s）与 killSignal；聚合失败列表并继续执行；输出耗时。
  3. 为宿主 `rejected()`/`route()` 与配置/凭据路由补 403/503/异常/脱敏行为测试。
  4. 外部依赖统一 skip 机制（`FEIYU_PY`/`deps/...` 探测，缺失打印 SKIP 退出 0）；card-match 纯逻辑改 JS 或无依赖。
  5. 增加 Windows CI 或夜间任务：`npm ci` + `npm test` + `test:e2e`。
  6. E2E 增加真实 VAD/真实 pipeline + fake HTTP 场景；UI 测试收敛为一套；性能阈值移到 bench；用结构化 `stateTrace()` 替代日志解析。
- **验收标准**：
  - [ ] `test:all` 一条命令跑完全部套件；发现/登记差异为 0。
  - [ ] 本机无 `D:/social-auto-upload` 时测试 SKIP 而非失败。
  - [ ] 宿主路由 403/503/异常/脱敏测试通过。
  - [ ] CI/夜间任务绿；单套件挂起会被超时终止并报失败。
- **涉及代码**：`package.json`、`tools/run-tests.mjs`、`test/**`、`test/esp32-sim/**`、`.github/workflows/*`（新增）
- **对应发现**：三套清单漂移；宿主路由零行为测试；硬编码 Python 路径；串行首败即停；无超时；E2E 只覆盖 fake；UI 三套机制；无 CI；性能阈值假红；日志形状依赖；文档计数漂移。

### R-18 宿主壳模块化

- **优先级**：P2｜**类型**：架构｜**工作量**：L｜**依赖**：R-05
- **问题**：`apply()` 约 1170 行，路由、进程监管、调度、配置、网关、连接中心全部内联；可选模块静态 import。
- **需求**：
  1. 按职责拆分：`routes/`（配置、状态、记忆、服务、esp32）、`services/`（进程监管、端口、备份）、`scheduler` 装配、`esp32` 装配；`apply()` 只做组装与生命周期。
  2. 路由表集中注册并导出，便于行为测试；依赖通过参数注入（已有 providers 先例）。
  3. 顶层只保留无副作用依赖；重模块动态 import。
- **验收标准**：
  - [ ] `apply()` 降至可读规模（目标 <300 行）；路由表可独立测试。
  - [ ] 可选模块失败不影响其他通道。
  - [ ] 现有测试全绿。
- **涉及代码**：`lib/index.js`
- **对应发现**：apply 上帝对象；可选模块静态 import。

### R-19 可观测性与诊断

- **优先级**：P2｜**类型**：可运维性｜**工作量**：M｜**依赖**：R-01/R-05
- **问题**：状态/日志分散；配置与运行态不一致；自我快照双源；测试计数漂移；无日志轮转与按通道指标；DSH 升级兼容未知。
- **需求**：
  1. 统一 status 输出：网关运行态与配置差异、provider 健康、调度器状态、最近错误、token 是否配置（不暴露值）。
  2. `doctor` 增加一致性检查：双自我源、配置键/默认值、测试清单、网关运行态、secrets 路径。
  3. 日志轮转与按通道指标（消息数、失败率、成本、延迟）；阈值告警。
  4. 记录 DSH 插件 API 兼容基线；升级时运行兼容自检。
- **验收标准**：
  - [ ] `doctor` 能检出并报告至少五类不一致。
  - [ ] 日志按大小/日期轮转；指标接口可读。
  - [ ] status 能显示“配置与运行态不一致”。
- **涉及代码**：`lib/index.js`、`lib/esp32/selfcheck.js`、`tools/commands/selftest.mjs`、`tools/brain/doctor.mjs`、`lib/esp32/host.js`
- **对应发现**：配置/运行态不对称；双自我源；测试计数漂移；无可观测性。

### R-20 自我升级与发布治理

- **优先级**：P2｜**类型**：治理｜**工作量**：S｜**依赖**：R-11
- **问题**：自我升级的权限提示与执行开关相反；强制备份/测试只是提示词约定；`package.json` 仍为 0.4.0，未记录上游基线；示例配置与默认值手工同步会漂移；文档写死测试数量。
- **需求**：
  1. 用同一个解析后的布尔量同时驱动提示词与执行闸门；关闭时不注入任何授权句。
  2. 备份、测试、日志改为宿主强制的 pre/post hook：备份校验通过才允许改，测试退出码 0 才允许提交，日志由宿主写入。
  3. `package.json` 使用 fork 版本号或记录 upstream base commit；发布前做上游 diff 审查。
  4. 示例配置由 DEFAULTS/contracts 生成并在 CI 校验；文档只描述入口，不写固定数量。
- **验收标准**：
  - [ ] 开关关闭时提示词不含授权句；执行路径也拒绝升级。
  - [ ] 备份失败或测试失败时升级被阻断。
  - [ ] 上游基线可查询；示例配置一致性检查通过。
- **涉及代码**：`lib/scheduler.js`、`tools/lib/persona.mjs`、`tools/commands/selfup.mjs`、`tools/commands/web.mjs`、`package.json`、`feiyu.config.example.json`
- **对应发现**：权限提示与开关相反；备份/测试仅提示词；版本/上游基线缺失；示例配置漂移；文档计数漂移。

---

## 6. 覆盖矩阵

| 报告维度 | 发现数 | 对应需求 |
| --- | --- | --- |
| 宿主壳与插件集成 | 12 | R-01、R-02、R-05、R-06、R-16、R-18 |
| 大脑与记忆系统 | 12 | R-07、R-08、R-09、R-12 |
| 多平台社交通道 | 12 | R-04、R-15 |
| ESP32 语音通道 | 12 | R-01、R-05、R-13、R-14 |
| 音频链路与多媒体 | 12 | R-03、R-13 |
| 配置、安全与隐私 | 11 | R-01、R-02、R-03、R-04、R-12 |
| 设置面板与前端 | 12 | R-03、R-16、R-17 |
| 测试与工程质量 | 11 | R-17 |
| 盲区补充 | 6 | R-02、R-06、R-09、R-10、R-11、R-20 |

说明：同一发现可能被多项需求覆盖（例如 OTA token 同时属于 R-01/R-03）；报告中被判定为 refuted 的“微信绕过共享内核”不作为缺陷修复，而是转化为 R-15 的“显式化配置”需求。

## 7. 开放问题与决策点

1. **网关默认策略**：默认关闭还是只绑回环？关闭更安全，但需要首次配对流程；建议默认关闭 + 显式开启。
2. **密钥存储**：独立 secrets 文件（0600/ACL）还是系统凭据库？建议先文件 + 环境变量覆盖，后续再接系统凭据库。
3. **live 记忆目标**：本轮是否承诺切到 live？若承诺，R-07/R-08 为发布阻断项；若不承诺，先完成隔离与对照测试。
4. **预算硬闸门行为**：拒绝调用、降级本地模型，还是排队到次日？需要产品取舍。
5. **微信通道**：合并为纯传输层，还是保留 I7 独立 profile？两者都可，但必须只保留一个显式配置。
6. **归档记忆语义**：归档后是否允许召回？建议允许只读按需检索，避免“越用越失忆”。
7. **上游合并策略**：继续 fork 增量还是定期 rebase？决定 `client.js` 拆分与版本号方案。

## 8. 建议执行顺序

```
M1（本周）      R-02 → R-01 → R-03 → R-04 → R-05 → R-06
M2（2–4 周）    R-08 → R-07 → R-10 → R-11 → R-12 → R-13 → R-09
M3（1–2 月）    R-17 → R-15 → R-16 → R-14 → R-18 → R-19 → R-20
```

依赖提示：R-03 依赖 R-02 的配置服务；R-06 依赖 R-02 的原子写；R-07 依赖 R-04 的外发闸门；R-11 依赖 R-03 的密钥处理；R-14 依赖 R-01 的网关模型。

---

## 9. 开源选型（复核后可直接落地）

> 复核时间：2026-11-18。仅列入**当前代码与运行时约束下可直接引入**的项目；需 spike 的（`sqlite-vec`、`@napi-rs/keyring`、`XState`、`p-queue`、`restic`、`LiteLLM`）与仅作参考的项目不写入本节。

**复核基线**：`package.json` 为 ESM、`engines.node >= 24`、运行时依赖仅 `opusscript` / `ws`；本机 Node `24.14.1`，`node:sqlite` 可用（SQLite `3.51.2`，`loadExtension` 存在）；`client.js` 只能 `require("react")` 与 DSH 注入模块；宿主路由为 `ctx.webServer.register({ kind: 'exact' })`。

### 9.1 可直接落地清单

| 需求 | 项目 | 版本 / 许可 | 用法 | 约束 |
| --- | --- | --- | --- | --- |
| R-01 | `selfsigned` | 5.5.0 / MIT | 网关自签 TLS 证书，配合只绑回环或局域网 | 纯 JS；TLS 不能替代鉴权，必须在 R-01 的 token/设备模型之后 |
| R-01 | `bonjour-service` | 1.4.4 / MIT | 局域网 mDNS 发现，减少手填 IP | 纯 JS；只广播已启用且已配对的设备 |
| R-02 | `proper-lockfile` | 4.1.2 / MIT | 配置与 JSONL 的跨进程写锁 | CJS，可默认导入；2023 后无更新但稳定；与内部 `writeJsonAtomic()` 配合，不替代原子写 |
| R-06 | `croner` | 11.0.1 / MIT | 解析 `consolidateAt`、`nightly.at`、`socialDigest.at`、`dynamic.times` | 零依赖、ESM、Node >=18；只做时间解析，不替代调度仲裁 |
| R-08 | `node:sqlite`（内置） | Node 24.14.1 / SQLite 3.51.2 | 新建账本/队列表，WAL + 条件更新做认领 | 仅 `tools/` 侧；带 ExperimentalWarning；`lib/` 的 Electron Node 版本未确认，不要用 |
| R-09 | `node:sqlite` FTS5 | 同上 | 归档记忆全文检索 | 与 `minisearch` 二选一，不要双索引；迁移前先做 JSONL → SQLite 导入脚本 |
| R-09 | `minisearch` | 7.2.0 / MIT | 纯 JS 全文索引；不迁 SQLite 时的归档检索 | ESM、纯 JS；索引需自行持久化；近期更新放缓 |
| R-12 / R-17 | `promptfoo` | 0.125.1 / MIT | 注入红队、提示回归、渠道一致性评测 | 仅 `devDependencies`，不进运行时；需要单独配置 provider |

### 9.2 引入原则

1. 随对应需求引入，不预装；每项都必须在验收标准里有对应测试。
2. 当前运行时依赖只有 `opusscript` 和 `ws`，新增依赖要计入上游合并成本；能用内部 helper 就不加库。
3. 原生模块（N-API/ONNX）一律先 spike，再决定是否进入 `dependencies`。
4. dev-only 工具（`promptfoo`、`c8`、`knip` 等）只进 `devDependencies`，不进入插件运行时。

### 9.3 与需求的落地顺序

```text
R-02  proper-lockfile + 内部 writeJsonAtomic()
R-01  selfsigned + bonjour-service（在鉴权模型之后）
R-06  croner
R-08  node:sqlite（账本/认领）
R-09  node:sqlite FTS5 或 minisearch（二选一）
R-12  promptfoo 红队用例
R-17  promptfoo 回归用例接入 run-tests
```

**明确不写入本轮**：`llm-guard`（已归档）、`bottleneck`（停更）、`hono` / `fastify`（宿主路由不支持）、`react-hook-form` / `@rjsf/core` / `Storybook`（客户端加载器不支持）、`write-file-atomic`（v8 要求 Node >=24.15，本机 24.14.1 不满足）。
