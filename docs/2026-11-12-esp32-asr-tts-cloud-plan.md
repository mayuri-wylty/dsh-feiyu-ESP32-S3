# ESP32 通道：云端 ASR/TTS 可配置 — 执行计划（DAG + Agent Teams）

设计见 `2026-11-12-esp32-asr-tts-cloud-design.md`。

## 5. DAG 与任务

```
T0 ─┬─ T1 ─┬─ T6 ─ T7 ─┬─ T8 ─┐
    │      │           └─ T9 ─┤
    ├─ T2 ─┼──────────────────┼─ T10 ─┐
    ├─ T3 ─┤                  │       ├─ T13
    └─ T5 ─┘        T11(T2,T3) ┘ T12(T1)┘
```

| id | 目标 | 文件（★Lead独占 ▲上游共享，仅最小改） | 前置 | 组 | 验收 | 规模 |
|---|---|---|---|---|---|---|
| T0 | ids/默认值/API 形状/fixture；`package.json` 加 `smoke:volc` | ★`lib/esp32/contracts.js`、★`package.json`、`test/esp32-contract-test.mjs` | — | — | `node --test test/esp32-contract-test.mjs` | S |
| T1 | registry + mask/strip + 预设 | `lib/esp32/providers/registry.js`、`test/esp32-providers-registry-test.mjs` | T0 | G1 | 同名测试 | M |
| T2 | 火山 ASR + 工厂分支 + openai 补字段 | `lib/esp32/asr/*`、`test/esp32-asr-volc-test.mjs` | T0 | G1 | 同名 + 既有 asr 测试 | M |
| T3 | 火山 TTS 流式 + 工厂分支 + cloud 补字段 | `lib/esp32/tts/*`、`test/esp32-tts-volc-test.mjs`（分块/奇数字节/取消/错误码/回退） | T0 | G1 | 同名 + 既有 tts 测试 | L |
| T5 | 管线解耦+签名+健康+status | `lib/esp32/pipeline/index.js`、`lib/esp32/host.js`、▲`lib/index.js`(注入)、wiring/host 测试 | T0 | G1 | wiring/host 测试 | M |
| T6 | 测试连接 handler（注入假工厂） | `lib/esp32/providers/test.js` + 测试 | T1 | G2 | 同名测试 | M |
| T7 | 路由+脱敏+hasKey+自动主备 | `lib/esp32/providers/http.js`、▲`lib/index.js`(接线)、`test/esp32-providers-api-test.mjs` | T1,T6 | G2 | `npm test` | M |
| T8 | settings.html 动态表单 | `lib/settings.html`、`test/settings-esp32-test.mjs` | T0 fixture（联调需 T7） | G3 | 同名测试 | M |
| T9 | client.js 同步 | ▲`client.js`、client-smoke/render 测试 | 同 T8 | G3 | `npm test` | M |
| T10 | e2e + 本地 mock 火山服务 | `test/esp32-sim/*` | T2,T3,T5,T7 | G4 | `npm run test:e2e` | M |
| T11 | 冒烟脚本（TTS 合成→重采样→ASR 回环；仅读 env） | `scripts/esp32-volc-smoke.mjs` | T2,T3 | G4 | 手动：`VOLC_API_KEY=… npm run smoke:volc` | S |
| T12 | 设计/计划入库 + 新增 provider 开发指南 | ★`docs/*` | T1 | G4 | 评审 | S |
| T13 | 集成评审 + 全量回归 + 密钥扫描 | Lead | 全部 | — | `npm test` + e2e + `/code-review` | M |

关键路径：T0→T1→T6→T7→T8/T9→T10→T13；T3 最长但与 T1/T6/T7 并行；T6 用注入的假工厂开发，真实适配器联调放 T10。

## 6. Agent Teams 执行

- **角色/泳道/所有权（互不重叠）**：
  - Lead：`contracts.js`、`package.json`、`docs/*`、合并、T0/T12/T13。
  - `asr` 队员：`lib/esp32/asr/*`（T2），随后 T10 的 `test/esp32-sim/*`。
  - `tts` 队员：`lib/esp32/tts/*`（T3），随后 T11 `scripts/*`。
  - `core` 队员：`providers/*`、`pipeline/index.js`、`host.js`、`lib/index.js`（T1→T5→T6→T7）。
  - `ui` 队员：`settings.html`、`client.js`（T8、T9），T7 前用 fixture/mock 开发。
- **worktree**：Lead 完成并提交 T0 后，在 `dsh-feiyu\.worktrees\<lane>` 建 4 个 worktree（各自 `npm install`），分支 `esp32/asr-volc`、`esp32/tts-volc`、`esp32/core-providers`、`esp32/ui-providers`；越权改文件须先报 Lead。
- **合并顺序**：T0 → asr/tts/core(T1、T5) → core(T6、T7) → ui → T10/T11；每次 `--no-ff`，合并后跑 `npm test`。
- **质量闸门**：每任务先过自己的 `node --test <子集>`；合并后全量 `npm test`；G3 后加 `npm run test:e2e`；密钥扫描 `git diff`/`git log -p` 匹配 `(apiKey|X-Api-Key)\W*[:=]\W*['"][A-Za-z0-9-]{16,}`，并 grep 日志/快照；冒烟输出只含状态/耗时/字节数。
- **回滚**：每泳道一个合并提交，可单独 `git revert`；新增字段均有默认值，回滚后旧配置仍可读。
- **派给队员的任务说明**：自包含（目标、文件所有权、本文件对应小节、验收命令、禁止项：不改 `contracts.js`、不 push、不写入任何密钥）。

## 9. 端到端验证

1. `npm test`（含新增 `test/esp32-*.mjs`）全绿。
2. `npm run test:e2e`：模拟设备 + 本地 mock 火山服务，覆盖云主→本地回退、改配置后 provider 重建。
3. `VOLC_API_KEY=… npm run smoke:volc`：真实 TTS 流式首包延迟、PCM 24k 校验、TTS→ASR 回环文本一致。
4. 浏览器打开 `/dsh-feiyu/` 设置页与 DSH 宿主面板：填火山配置→测试连接→自动设为主；确认 `GET /api/config` 响应无明文 key/token；故意填错 key，状态区应显示降级原因。
5. 真机（`bread-compact-wifi-lcd`）：说「大肥鱼」完成一轮完整对话，确认走云 ASR/TTS，断网/错 key 时回退本地。
6. 密钥扫描无命中。
