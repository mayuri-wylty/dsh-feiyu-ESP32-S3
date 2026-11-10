# 小智 ESP32 第五通道 · Spike 记录（G 道）

> 执行分支：`worktree-agent-af703fe15683e50ad`（本地提交，不 push）。
> 记录日期：2026-11-10。
> 本文只记录 Spike 结论、可复现命令与输出；**不包含任何 DSH token、Wi-Fi 口令、API Key 或其他凭据**。
> 临时插件源码保留在 `scripts-esp32/spike-a-plugin/`（Spike B 完成后同理保存在 `scripts-esp32/spike-b-plugin/`）供 T12 参考，但**不挂载**到 desktop profile。

## 结论摘要

| 编号 | Spike | 结论 | 对 T12 / G0 的影响 |
| --- | --- | --- | --- |
| T02a | 宿主内 HTTP + WebSocket 监听（`0.0.0.0:8765`） | **PASS** | 插件可在 DSH 宿主进程内直接 listen，T12 网关可以走宿主内实现；`publicHost` 必须按本文规则排除虚拟/VPN 网卡，否则会选到 Mihomo 的 `198.18.0.1` |
| T03 | 宿主内 `ctx.speechToText` + `sherpa-onnx-node` | **PASS**（服务调用）/ `sherpa-onnx-node` 直接 import **FAIL** | ASR 优先复用 `ctx.speechToText`（voice-input bundle 的 SenseVoice，模型已在缓存）；不需要为 ASR 拆网关子进程。feiyu 插件内直接 `import('sherpa-onnx-node')` 不可用，直载需自行加依赖并在 Node worker（`ELECTRON_RUN_AS_NODE=1`）中运行 |

## 环境基线

- DSH 桌面版：`D:\DSH桌面版\DeepSeek Harness.exe`，宿主入口 `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`。
- 宿主 Web 端口：动态端口（`--port 0`），每次重启变化；T01 脚本 `start-dsh.ps1` 只报告端口，不读取/打印 token。
- 宿主 Node：`v24.21.0`（插件内 `process.version`）。
- 当前网络：WLAN `192.168.10.39/24`，网关 `192.168.10.1`；Mihomo TUN `198.18.0.1/30`；WSL `vEthernet 172.28.176.1/20`。
- 运行身份：`MAYURI\20323`，Medium Mandatory Level，`IS_ELEVATED=False`（非管理员提权）。

---

## T02a Spike A —— 宿主内 HTTP + WS 监听

### A0. 方法与临时插件

临时插件包：`scripts-esp32/spike-a-plugin/`（包名 `dsh-spike-a-gateway-probe`）。

- `package.json` 声明 `dsh.bundle.patch = ./cordis.patch.yml`。
- `cordis.patch.yml` 向 profile 插入：
  ```yaml
  - insert:
      - id: dsh-spike-a-gateway-probe
        name: dsh-spike-a-gateway-probe
  ```
- `lib/index.js`：
  - `http.createServer(...).listen(8765, '0.0.0.0')`；
  - OTA：`GET/POST /xiaozhi/ota/`（兼容 `/ota/`）返回最小 JSON；
  - WS upgrade：`/ws`、`/spike-a/ws`、`/xiaozhi/v1/`；使用 dsh-feiyu 已安装的 `ws` 8.22.2；
  - 状态：`GET /spike-a/status`，返回监听信息、计数器、网卡候选/排除原因/默认路由；
  - 日志：`%TEMP%\dsh-spike-a.log`。

安装方式（重要）：

- DSH CLI 明确拒绝 desktop profile：
  ```text
  error: profile "desktop" is managed exclusively by the Electron application
  ```
- 因此在 DSH 停止时，直接在 profile 目录用 pnpm 安装本地 link：
  ```powershell
  Set-Location 'C:\Users\20323\.dsh\profiles\desktop'
  $env:CI='1'
  pnpm.cmd add 'link:D:/AI_Code/小智机器人/dsh-feiyu/.claude/worktrees/agent-af703fe15683e50ad/scripts-esp32/spike-a-plugin'
  ```
- 再把 `dsh-spike-a-gateway-probe` 追加到 profile `package.json` 的 `dsh.profile.bundles`，用 `start-dsh.ps1` 启动。
- 测试结束后反向操作（见 A5）。

### A1. 宿主进程内 listen：PASS

启动后 DSH 宿主 PID=`33092`，监听结果：

```text
PS> Get-NetTCPConnection -LocalPort 8765 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
LocalAddress LocalPort OwningProcess
------------ --------- --------- -------------
0.0.0.0           8765         33092
```

插件日志（UTC）：

```json
[2026-11-10T08:11:44.537Z] listening {
  "address":"0.0.0.0","family":"IPv4","port":8765,"listening":true,
  "argv0":"D:\\DSH桌面版\\DeepSeek Harness.exe",
  "execPath":"D:\\DSH桌面版\\DeepSeek Harness.exe",
  "nodeVersion":"v24.21.0","pid":33092,"hostProcessPid":33092
}
```

结论：

- 插件可以在 DSH **宿主进程内**正常 `listen(8765, '0.0.0.0')`，不需要额外子进程。
- 端口 8765 高于 1024，当前用户非提权（Medium integrity）即可绑定；无 EACCES/EADDRINUSE。
- 监听 PID 与 DSH 宿主 PID 一致，确认监听发生在宿主进程，而不是 pnpm/Electron 其他进程。

### A2. 本机回环 + 本机局域网 IP 的 OTA/WS：PASS

测试客户端：`scripts-esp32/spike-a-client.mjs`，同时访问 `127.0.0.1` 与 `192.168.10.39`。

```powershell
node scripts-esp32/spike-a-client.mjs --port 8765 127.0.0.1 192.168.10.39
```

汇总结果：

| 类型 | 地址 | 路径 | 结果 |
| --- | --- | --- | --- |
| HTTP | 127.0.0.1 | `/xiaozhi/ota/` | 200，返回最小 OTA JSON |
| HTTP | 127.0.0.1 | `/spike-a/echo` | 200 |
| HTTP | 127.0.0.1 | `/spike-a/status` | 200 |
| WS | 127.0.0.1 | `/ws` | 握手成功，收到 `hello`，`ping` → `pong` |
| WS | 127.0.0.1 | `/xiaozhi/v1/` | 握手成功，收到 `hello`，`ping` → `pong` |
| HTTP | 192.168.10.39 | `/xiaozhi/ota/` | 200 |
| HTTP | 192.168.10.39 | `/spike-a/echo` | 200 |
| HTTP | 192.168.10.39 | `/spike-a/status` | 200 |
| WS | 192.168.10.39 | `/ws` | 握手成功，`hello` + `pong` |
| WS | 192.168.10.39 | `/xiaozhi/v1/` | 握手成功，`hello` + `pong` |

客户端整体 `pass: true`，退出码 0。OTA 返回示例（无凭据）：

```json
{
  "ok": true,
  "spike": "A",
  "firmware": { "version": "0.0.0-spike-a", "force": 0 },
  "websocket": { "url": "ws://192.168.10.39:8765/ws", "path": "/ws" },
  "server_time": { "timestamp": 1794298331587, "timezone_offset": 480 }
}
```

结论：同一台机器通过回环地址和局域网 IP 都能访问 OTA 与 WS。**外部设备（ESP32）是否能穿过 Windows 防火墙不在本任务内**，由 T02b 由用户实测；本机局域网 IP 可达说明绑定与路由正确，但 T02b 很可能需要放行 8765 入站规则。

### A3. `publicHost` 选网卡规则与实测：PASS

实测候选（`os.networkInterfaces()` + Windows `Get-NetIPAddress` / `Get-NetRoute`）：

| 网卡 | IPv4 | 接口索引 | 排除原因 | 默认路由 |
| --- | --- | --- | --- | --- |
| Mihomo | `198.18.0.1/30` | 54 | `198.18.0.0/15` 代理 TUN 段；名称命中 Mihomo | `0.0.0.0/0 → 198.18.0.2`，TotalMetric=0（被排除） |
| WLAN | `192.168.10.39/24` | 10 | —（合格） | `0.0.0.0/0 → 192.168.10.1`，TotalMetric=30（选中） |
| Loopback Pseudo-Interface 1 | `127.0.0.1/8` | 1 | internal/loopback | — |
| vEthernet (WSL (Hyper-V firewall)) | `172.28.176.1/20` | 42 | 名称命中 vEthernet/WSL | — |

最终选择：

```json
{
  "selectedAddress": "192.168.10.39",
  "selectedInterface": "WLAN",
  "method": "eligible-default-route",
  "selectedRoute": {
    "InterfaceIndex": 10,
    "NextHop": "192.168.10.1",
    "RouteMetric": 0,
    "InterfaceMetric": 30,
    "TotalMetric": 30
  }
}
```

**规则（T12 可直接照做）：**

1. 枚举 `os.networkInterfaces()` 的 IPv4，排除：
   - `internal` / `127.0.0.0/8`；
   - `169.254.0.0/16`（APIPA/未连接）；
   - `198.18.0.0/15`（常见 Clash/Mihomo/Sing-box TUN 基准段）；
   - 名称命中虚拟/VPN/隧道正则：`vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Loopback|Tailscale|ZeroTier|WireGuard|OpenVPN|SoftEther|TAP|TUN|utun|Mihomo|Clash|Sing-box|VPN|虚拟|蓝牙`。
2. 在剩余合格网卡中，取拥有 `0.0.0.0/0` 默认路由且 `TotalMetric = RouteMetric + InterfaceMetric` 最小的网卡地址。
3. 若默认路由全部落在被排除的虚拟/VPN 网卡上（本例 Mihomo 的 metric=0 本来会赢），退回合格网卡中的 RFC1918 私网地址，优先级 `192.168/16 > 10/8 > 172.16/12`。
4. **不做公网地址兜底**；允许显式配置覆盖（Spike 用 `DSH_SPIKE_A_PUBLIC_HOST`）。

**关键坑：** 只看默认路由 metric 会选到 Mihomo `198.18.0.1`，ESP32 根本不可达；必须先排除虚拟/VPN 网卡，再在合格网卡里按默认路由/metric 选。`os.networkInterfaces()` 本身不提供路由 metric，需要配合 Windows `Get-NetRoute` / `Get-NetIPInterface`（或等价 API）。建议 T12 在启动时计算一次并缓存，网络变化时重算，同时提供 `publicHost` 配置覆盖。

### A4. 重启恢复：PASS

- 停止 DSH 后：`PORT_8765_RELEASED`（无监听）。
- 重新运行 `start-dsh.ps1`：新宿主 PID=`12720`，端口 `0.0.0.0:8765` 再次出现。
- 重启后重新运行客户端：10 项检查全部通过（`PASS=True`，退出码 0）。
- 结论：插件随宿主重启自动恢复监听，无需手工重启插件或额外授权。

### A5. 卸载与清理：PASS

停止 DSH 后执行：

1. 从 `dsh.profile.bundles` 移除 `dsh-spike-a-gateway-probe`；
2. `pnpm remove dsh-spike-a-gateway-probe`；
3. 检查发现 **pnpm 11.24.0（hoisted linker）移除依赖后仍留下 junction**，已手动删除：
   `node_modules\dsh-spike-a-gateway-probe` → `spike-a-plugin`；
4. 用测试前备份对比：`package.json` 与 `pnpm-lock.yaml` 的 SHA-256 均与备份完全一致；
5. 重新启动 DSH：`PORT_8765_RELEASED_AFTER_CLEANUP`（8765 无监听，临时插件未加载）；
6. 运行 `probe.ps1`：`PASS=5 FAIL=0 BLOCKED=2 WARN=0 SKIP=0`，`dsh-feiyu` 路由/安装/链接/运行标记均正常，仅 GPT-SoVITS 仍为 BLOCKED（与 T01 基线一致）。

清理后 profile 状态：

- 依赖恢复为 `dsh-feiyu: link:D:/AI_Code/小智机器人/dsh-feiyu`，bundles 末尾仍是 `dsh-feiyu`，无 `spike-a` 残留；
- 8765 无监听；
- `probe.ps1` 确认原 dsh-feiyu 正常挂载。

### A6. 对 T12 网关方案的影响

1. **宿主内监听可行**：T12 不必为了“能监听 8765”而强制拆子进程；OTA + WS 可以直接在插件/宿主内实现。若 T12 另有崩溃隔离、原生依赖或独立升级需求，子进程仍是可选架构，但不再是端口绑定层面的硬约束。
2. **`publicHost` 必须用 A3 规则**：尤其本机有 Mihomo/Clash TUN 时，naive 默认路由会选到 `198.18.0.1`。T12 应内置排除表 + 合格默认路由 + RFC1918 兜底 + 显式覆盖，并在 UI/日志中显示最终地址。
3. **路径对齐**：Spike 验证了 `/xiaozhi/ota/`、`/ws`、`/xiaozhi/v1/` 均可路由；T12 需按固件实际 OTA/WS 路径统一（本项目固件默认走 `/xiaozhi/ota/` 与 `/xiaozhi/v1/`，以固件源码为准）。
4. **防火墙是 T02b 的剩余风险**：本机访问局域网 IP 成功不等于外部 ESP32 可入站。T02b 需在 Windows 防火墙放行 TCP 8765（或按安装时提示允许），并由用户用真实设备验证。
5. **安全**：Spike 的 8765 无鉴权，仅用于临时验证；T12 生产网关必须加设备鉴权/握手校验，不能直接照搬 Spike 的裸 HTTP/WS。

---

## T03 Spike B —— 宿主内 `speechToText` 与 `sherpa-onnx-node`

### B0. 方法与临时插件

临时插件包：`scripts-esp32/spike-b-plugin/`（包名 `dsh-spike-b-speech-probe`）。

- `package.json` 声明 `dsh.bundle.patch = ./cordis.patch.yml`，patch 插入同名插件。
- `lib/index.js` 在 `apply(ctx)` 中用 `setTimeout`（默认 8 秒，**不在任何协议请求里**）触发探测：
  1. `ctx.speechToText.snapshot()` 读取 provider 状态；
  2. `ctx.speechToText.resolve({ audio, language: 'zh' })`；
  3. `ctx.speechToText.transcribe(spec, AbortSignal.timeout(180000))`；
  4. `import('sherpa-onnx-node')` + `import.meta.resolve`；
  5. 额外从 DSH app.asar 的 SenseVoice provider 锚点 `createRequire(...)('sherpa-onnx-node')`，并尝试 `readWave`。
- 结果写入 `%TEMP%\dsh-spike-b-result.json`，日志写入 `%TEMP%\dsh-spike-b.log`。
- 测试音频：Windows SAPI 音色 `Microsoft Huihui Desktop` 生成
  `小智小智，今天天气怎么样？请帮我打开客厅的灯。`
  SAPI 原始文件 fmt 块为 18 字节，DSH `validateWave` 要求 44 字节 canonical 头；
  用 `scripts-esp32/spike-b-fixtures/normalize-wav.mjs` 重整为 16 kHz mono PCM16：
  ```json
  { "bytes": 209164, "seconds": 6.535, "canonical": true }
  ```
- 安装/卸载方式与 Spike A 相同：停止 DSH 后在 desktop profile 用 `pnpm add link:...` 安装，
  把 `dsh-spike-b-speech-probe` 追加到 `dsh.profile.bundles`；测试结束后恢复 profile（见 B5）。

### B1. `ctx.speechToText` 与所需服务：PASS

voice-input bundle 已在 desktop profile 启用，插件内 `ctx.speechToText` 可用，无需额外安装：

- profile `cordis.patch.yml` 中 `speech-to-text` 的 `defaultProvider: sensevoice-local`、`language: zh`；
- `speech-to-text-sensevoice` 的 `dataRoot` 指向 `C:\Users\20323\.dsh\speech-to-text\sensevoice`；
- 探测前 provider 快照为 `sensevoice-local` / `preparation.phase = "standby"`，
  说明模型缓存已就绪（T01 已确认 `model.int8.onnx` 等文件存在），**不需要下载，也没有触发 prepare**。

结论：T03 所需服务完全由 voice-input bundle 提供，feiyu 通道只需 `inject: ['speechToText']`。

### B2. `resolve` / `transcribe` 调用：PASS

从插件定时器回调内调用，完整结果（`%TEMP%\dsh-spike-b-result.json`）：

| 阶段 | 结果 | 耗时 |
| --- | --- | --- |
| `snapshot` | provider `sensevoice-local`，phase `standby` | — |
| `resolve` | 成功，provider `sensevoice-local`，language `zh`，audio 209164 字节 | **0.245 ms** |
| `transcribe` | 成功 | **2913.3 ms**（`audioSeconds=6.535`，`inferenceSeconds=0.2901`） |

返回文本（与生成文本一致）：

```text
小智小智，今天天气怎么样？ 请帮我打开客厅的灯。
```

说明：

- 首次 `transcribe` 的 2.9 s 包含唤醒/队列等待；服务自报推理时间仅 **0.29 s**，模型本身很快。
- 调用发生在插件启动后的定时器中，不依赖 Web 请求/WS 会话，符合“通道内后台调用 ASR”的场景。
- 进程树确认调用由 DSH 托管的 SenseVoice worker 执行：
  `宿主 PID 15136 → dsh-subprocess-local/lib/runner.js PID 2352 → sensevoice/lib/worker.js PID 17820`；
  worker 配置含 `dataRoot=C:\Users\20323\.dsh\speech-to-text\sensevoice`、`precision=int8`，
  命令行中**没有 token**。

### B3. feiyu 插件环境直接 `import('sherpa-onnx-node')`：FAIL

`import.meta.resolve` 与 `import()` 均失败：

```json
{
  "ok": false,
  "error": {
    "name": "Error",
    "code": "ERR_MODULE_NOT_FOUND",
    "message": "Cannot find package 'sherpa-onnx-node' imported from D:\\AI_Code\\小智机器人\\dsh-feiyu\\.claude\\worktrees\\agent-af703fe15683e50ad\\scripts-esp32\\spike-b-plugin\\lib\\index.js"
  }
}
```

原因：`sherpa-onnx-node` 只存在于 DSH 的 `app.asar\dsh\node_modules` 依赖树中，
不是 dsh-feiyu 的依赖，通过 feiyu 插件的正常模块解析不可见。
因此“在通道内直接 `import` SenseVoice”不能零配置实现；若要走这条路，必须把
`sherpa-onnx-node` 加为 feiyu 的依赖，并自行管理模型路径/worker 生命周期。

### B4. 额外验证：宿主内锚点 require 与 Electron 限制

从 DSH app.asar 的 provider 包锚点可以加载原生模块：

```text
anchor:  D:\DSH桌面版\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-speech-to-text-sensevoice\package.json
resolved: ...\dsh\node_modules\sherpa-onnx-node\sherpa-onnx.js
version: 1.13.8
onnxruntimeVersion: 1.28.2
gitSha1: 11afbd00
```

但 `readWave(wavPath)` 在宿主（Electron 进程）内失败：

```text
Error: External buffers are not allowed
```

这是 Electron 对宿主 Node 外部 buffer 的限制，不是模块加载失败。DSH 自己不受影响：
它把 ASR 放进 `ELECTRON_RUN_AS_NODE=1` 的 worker，且 worker 不调用 `readWave`，
而是直接从 WAV 字节的 offset 44 解析 PCM（`worker.js` 中
`new DataView(audio.buffer, audio.byteOffset + 44, ...)`）。

结论：**不要在 Electron 宿主里直接跑 sherpa-onnx 的音频读取/推理**；如确需直载，
应放进 Node worker 或子进程（`ELECTRON_RUN_AS_NODE=1`），否则会踩外部 buffer 限制。
本次 Spike 的服务调用路径已由 DSH 的托管 worker 验证可用，无需自己处理该限制。

### B5. 卸载清理与对 G0 的影响

清理步骤与结果：

1. 停止全部 DSH 进程（含宿主与 worker）；
2. 从 profile `package.json` 的 `dsh.profile.bundles` 移除 `dsh-spike-b-speech-probe`，删除 link 依赖；
3. `pnpm remove dsh-spike-b-speech-probe` 后仍残留 junction，
   已手动删除 `node_modules\dsh-spike-b-speech-probe`；
4. `package.json` / `pnpm-lock.yaml` 的 SHA-256 与测试前备份完全一致
   （`00D247EA…FFE0` / `3399316B…59B5`），profile 内无 `spike-b` 残留；
5. `start-dsh.ps1` 重启成功：新宿主 PID=`25376`，端口 `58753`；
   `%TEMP%\dsh-spike-b.log` 的最后写入时间仍为测试时的 `16:23:22`，
   新宿主启动于 `16:26:39`，**证明临时插件未被加载**；
6. 8765 无监听；`probe.ps1` 结果 `PASS=5 FAIL=0 BLOCKED=2 WARN=0 SKIP=0`（退出码 2），
   dsh-feiyu 路由/安装/链接/运行标记全部 PASS，仅 GPT-SoVITS 仍 BLOCKED（与 T01 基线一致）。

对 G0（通道内 ASR 方案）的影响：

- **ASR 走 `ctx.speechToText` 可行且推荐**：voice-input bundle 已提供 SenseVoice，
  模型缓存已就绪，插件启动后即可后台调用，耗时满足交互（推理 0.29 s / 首调 2.9 s）。
- **不需要为 ASR 拆网关子进程**：Spike A 已证明宿主内可监听 8765，Spike B 证明宿主内可调用
  `speechToText`。G0 可以保持“单宿主插件 + 复用 voice-input 服务”的架构；
  仅当需要崩溃隔离/独立原生依赖/独立升级时再考虑子进程。
- **不建议通道内直载 SenseVoice 作为首选**：`import('sherpa-onnx-node')` 当前不可用；
  即使补依赖，也必须放进 `ELECTRON_RUN_AS_NODE=1` 的 worker/子进程，避免
  `External buffers are not allowed`。这会重复 DSH 已做好的 worker 管理。
- **前置条件**：T12 需确认 voice-input bundle 处于启用状态（`speech-to-text` +
  `sensevoice-local`）；若用户禁用该 bundle，通道应给出明确错误/降级提示，
  而不是假设模型一定可用。
- **安全**：本次未读取/打印 DSH token；ASR 调用全部在本机进程内完成，未访问外部网络。

