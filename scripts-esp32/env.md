# T01 环境拉起 · 环境记录（env.md）

- 生成时间：2026-11-10（本地时区 UTC+8）
- 执行位置：`D:\AI_Code\小智机器人\dsh-feiyu\.claude\worktrees\agent-af703fe15683e50ad`（分支 `worktree-agent-af703fe15683e50ad`）
- 主机：Windows 11 Home China 10.0.26200，PowerShell 7.6.9，系统 Node v24.14.1（DSH 内置 Electron Node v24.21.0）
- 范围：DSH 桌面版（`D:\DSH桌面版`）、dsh-feiyu 插件、GPT-SoVITS `:9880`、ESP-IDF `≥ v6.0.1`
- 安全约束：本文件不包含任何 Wi-Fi 密码、API Key、token、cookie 或口令；DSH 的访问 token 未被读取、打印或保存。

## 0. 一句话结论

| 项目 | 结论 |
| --- | --- |
| DSH 桌面版 | 已安装并在运行：`D:\DSH桌面版\DeepSeek Harness.exe`，版本 `0.2.2-rc.1`，Electron `44.7.0` |
| dsh-feiyu 插件 | 已安装到 desktop profile（`link:D:/AI_Code/小智机器人/dsh-feiyu`），bundles 已启用，运行标记证明本次启动已挂载 |
| voice-input bundle | 已启用（在 `dsh.profile.bundles` 中），SenseVoice 本地模型已缓存到 `~/.dsh/speech-to-text` |
| 127.0.0.1:3080 API | 桌面版**不使用固定 3080**，而是动态端口（本次 `59737`）；所有请求需 per-process token/cookie，未鉴权返回 401，外部 agent 不能直接调用 `/dsh-feiyu/api/*` |
| 插件重载 | desktop profile 无 HMR；链接插件代码变更需**重启桌面版**；bundle 启用/禁用可由插件管理器热应用，直接改 package.json 后需重启 |
| GPT-SoVITS :9880 | **已就绪（2026-11-11 实测）**：安装于 `D:\AI_Code\小智机器人\GPT-SoVITS`（21 GB，venv Python 3.10.11 + torch 2.7.1+cu128，CUDA 可用），参考音 `models\feiyu\feiyu.wav` 就位；`GET /docs` 200，`POST /tts` 返回有效 WAV，`streaming_mode:2` 为 44 字节头 + 32 kHz PCM16LE 单声道 |
| ESP-IDF | **已完成**：v6.0.1 克隆并安装到 `D:\AI_Code\小智机器人\tools\esp-idf`（工具目录 `D:\Espressif`），`export.ps1` 与版本验证通过 |

## 1. DSH 桌面版

### 1.1 位置、版本、进程

| 项 | 值 |
| --- | --- |
| 安装目录 | `D:\DSH桌面版` |
| 可执行文件 | `D:\DSH桌面版\DeepSeek Harness.exe` |
| 桌面版版本 | `0.2.2-rc.1`（`resources/app.asar` 内 `dsh/package.json`） |
| Electron 版本 | `44.7.0`（`D:\DSH桌面版\version`） |
| 内置 Node | `v24.21.0`（`ELECTRON_RUN_AS_NODE=1` 下测得） |
| 主进程 PID（本次） | `24076` |
| Web 宿主 PID（本次） | `37848`（命令行含 `dsh-desktop-host\lib\index.js`） |
| Web 宿主启动时间 | `2026-11-10 15:01:49`（本地） |
| Web 监听 | `127.0.0.1:59737`（动态端口） |
| desktop profile | `C:\Users\20323\.dsh\profiles\desktop` |
| 数据目录 | `C:\Users\20323\.dsh` |

说明：PID/端口是本次记录值，重启后会变化；脚本均动态探测，不写死。

### 1.2 启动方式

直接启动桌面版：

```powershell
Start-Process -FilePath 'D:\DSH桌面版\DeepSeek Harness.exe'
```

推荐使用本目录的 `start-dsh.ps1`（幂等，自动等待 Web 宿主和动态端口）：

```powershell
pwsh -File .\start-dsh.ps1
```

桌面版主进程会在内部拉起：

```text
D:\DSH桌面版\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js
  --no-open --host 127.0.0.1 --port 0
```

`--port 0` 表示由操作系统分配动态端口。**3080 只是 `dsh web` CLI 的默认端口，不是桌面版端口**；本次实际端口为 `59737`。

### 1.3 CLI（`dsh` 不在 PATH）

`dsh` / `dsh.cmd` 均不在 PATH。可用桌面版自带的 Electron-as-Node 方式调用：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$cli = 'D:\DSH桌面版\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
& 'D:\DSH桌面版\DeepSeek Harness.exe' --expose-internals $cli --version
# 输出：0.2.2-rc.1
```

插件安装/查询（`plugin` 子命令可用）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$cli = 'D:\DSH桌面版\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
& 'D:\DSH桌面版\DeepSeek Harness.exe' --expose-internals $cli plugin --profile desktop list
& 'D:\DSH桌面版\DeepSeek Harness.exe' --expose-internals $cli plugin --profile desktop add "link:D:\AI_Code\小智机器人\dsh-feiyu"
```

注意：desktop profile 由 Electron 独占管理，`dsh --profile desktop --dump-config` 会被拒绝（提示 “profile desktop is managed exclusively by the Electron application”）；这不影响 `plugin` 子命令。

### 1.4 插件安装状态（已核实）

profile `package.json` 关键内容：

```json
{
  "dependencies": {
    "dsh-feiyu": "link:D:/AI_Code/小智机器人/dsh-feiyu"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "@deepseek-ai/dsh-experimental-voice-input-bundle",
        "dsh-feiyu"
      ]
    }
  }
}
```

- 依赖：`dsh-feiyu@link:D:/AI_Code/小智机器人/dsh-feiyu`（`dsh plugin --profile desktop list` 输出为 `dsh-feiyu@link:D:/AI_Code/小智机器人/dsh-feiyu`）。
- `node_modules\dsh-feiyu` 是 **Junction**，Target 为 `D:\AI_Code\小智机器人\dsh-feiyu`。
- `dsh.profile.bundles` 同时包含 `dsh-feiyu` 与 `@deepseek-ai/dsh-experimental-voice-input-bundle`。
- 运行证据：`C:\Users\20323\.dsh\feiyu-night.json` 的 `createdAt = 2026-11-10T07:01:55.086Z`（本地 `15:01:55`），比 Web 宿主启动（`15:01:49`）晚约 6 秒；探活时文件仍在持续更新（如 `15:42:55`）；`C:\Users\20323\.dsh\feiyu-work` 存在。这说明本次 DSH 启动时 dsh-feiyu 已实际挂载并运行了 scheduler。
- 插件自身挂载日志格式（代码中）：`[feiyu] 已挂载：/dsh-feiyu/api/* · 配置 ... · 工作目录 ...`。
- 注意：`link:` 指向**主目录** `D:\AI_Code\小智机器人\dsh-feiyu`（当前分支 `feat/esp32-channel`；HEAD 会随各泳道推进，本次记录时为 `0c24f46`），不是本 worktree。T01 的脚本只写在本 worktree 的 `scripts-esp32/`，不会改动主目录。

### 1.5 三项核实结论

#### ① voice-input bundle 如何启用（无 GUI）

**当前状态：已启用，且模型已缓存。**

- 内置 bundle `@deepseek-ai/dsh-experimental-voice-input-bundle@0.2.2-rc.1` 位于 `app.asar` 内，其 `cordis.patch.yml` 会插入：
  - `speech-to-text`（默认 `defaultProvider: sensevoice-local`）
  - `speech-to-text-sensevoice`（数据目录 `dshHomePath('speech-to-text','sensevoice')`）
  - `api-speech-to-text`
  - `ui-voice-input`（浏览器麦克风控件）
- desktop profile 的 `dsh.profile.bundles` 中已列出该 bundle，等于启用。
- 用户 patch 层（`cordis.patch.yml`）进一步覆盖了 `speech-to-text`：
  ```yaml
  - id: speech-to-text
    name: "@deepseek-ai/dsh-experimental-speech-to-text"
    config:
      defaultProvider: sensevoice-local
      language: zh
  ```
- 模型缓存已存在：
  - `C:\Users\20323\.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\model.int8.onnx`（239,233,841 字节）
  - `tokens.txt`（315,894 字节）
  - `silero\silero_vad.onnx`（1,807,522 字节）
  因此不需要再走首次 “下载并准备”。
- **无 GUI 启用/禁用方法**：编辑 `C:\Users\20323\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组，加入/移除 `@deepseek-ai/dsh-experimental-voice-input-bundle`，然后重启桌面版。插件管理器 README 说明“选择/启用”类操作可以热应用，但直接改文件不属于插件管理器操作，需重启后生效。
- **模型“下载并准备”是 GUI 动作**：当前缓存完整；若清空缓存，需要桌面版插件管理页点“下载并准备”，没有找到对应 CLI。

#### ② 桌面版是否暴露 `127.0.0.1:3080`，agent 能否直接调用 `/dsh-feiyu/api/*`

**结论：没有固定 3080；桌面版监听动态回环端口，且所有请求需 per-process 鉴权；外部 agent 不能直接调用。**

- 桌面版宿主固定参数 `--port 0`，本次实际 `127.0.0.1:59737`。`3080` 仅出现在 `dsh web` CLI 的默认值中；实测本机当前**没有进程监听 3080**。
- 鉴权实现（`@deepseek-ai/dsh-client-connection`）：
  - 查询参数名 `token`；
  - 每个进程生成 32 字节随机 base64url “launch token”，只保存在内存 `WeakMap`；
  - 通过 `GET /` 或 `GET /connect` 用 token 换取 HMAC 签名的 HttpOnly cookie（前缀 `dsh-auth-`）；
  - 无有效 token/cookie 时返回 401。
- 实测（未带 token/cookie）：
  - `GET http://127.0.0.1:59737/` → **401**
  - `GET http://127.0.0.1:59737/dsh-feiyu/api/status` → **401**
- token 由桌面宿主通过 IPC 交给 Electron 渲染进程，不落盘；本任务**没有**读取或写入 token。
- 因此：外部脚本/Agent 直接请求 `/dsh-feiyu/api/*` 不可行（除非获得当前进程的 token 或 cookie）。记录的是鉴权方式，不是可复用的凭据。若后续自动化必须访问，建议由桌面版 UI 驱动，或在插件侧另行提供受控的本地端口；不要从日志/进程中提取 token。

#### ③ 最小插件重载方式

- desktop profile **没有启用 HMR**：`cordis.yml` 为空入口列表，`cordis.patch.yml` 中没有 `hmr`/watch 配置。
- 链接包（`link:`）的代码变更：需要重新构建（若包有构建步骤）并**重启桌面版**。dsh-feiyu 是纯 ESM、无构建步骤，改完源码后重启桌面版即可。
- bundle 安装/启用/禁用：插件管理器的“选择/启用”类操作可以热应用；移除正在运行的 bundle 需要重启（见 `dsh-plugin-manager/README.zh.md`）。
- 最小重启方式（优雅退出优先）：
  ```powershell
  # 优先从桌面版窗口/托盘退出；需要脚本化时：
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process
  pwsh -File .\start-dsh.ps1
  ```
  重启后 `start-dsh.ps1` 会重新探测动态端口；`probe.ps1` 会用 `feiyu-night.json` 的更新时间确认插件是否在新进程中挂载。

## 2. GPT-SoVITS（:9880）

### 2.1 预期安装与启动方式（来自 dsh-feiyu 代码/文档）

| 项 | 值 |
| --- | --- |
| 根目录 | `D:\AI_Code\小智机器人\GPT-SoVITS` |
| Python | `D:\AI_Code\小智机器人\GPT-SoVITS\.venv\Scripts\python.exe`（插件默认） |
| 入口 | `D:\AI_Code\小智机器人\GPT-SoVITS\api_v2.py` |
| 启动参数 | `api_v2.py -a 127.0.0.1 -p 9880` |
| TTS 接口 | `POST http://127.0.0.1:9880/tts` |
| 参考音 | `D:\AI_Code\小智机器人\GPT-SoVITS\models\<音色>\<音色>.wav` + 同名 `.txt` |
| 插件自动拉起 | `ensureSovits()` 每 60s 检查；仅当 QQ 进程在跑或 `qq.startWithDsh=true` 时拉起 |

### 2.2 本次探测结果（2026-11-11 复测）

| 检查 | 结果 |
| --- | --- |
| `D:\AI_Code\小智机器人\GPT-SoVITS` | **存在**（21 GB；由旧 `D:\GPT-SoVITS` 整体迁移而来，新装副本暂存为 `GPT-SoVITS-new-py312`） |
| `.venv\Scripts\python.exe` | **可用**：Python 3.10.11，torch 2.7.1+cu128，`torch.cuda.is_available()=True` |
| 参考音 | **存在**：`models\feiyu\feiyu.wav`（302,126 B）+ `feiyu.txt` |
| `127.0.0.1:9880` 监听 | **有**（uvicorn） |
| `GET /docs` | **200** |
| `POST /tts`（普通） | **200 / audio/wav**，462,124 B；32 kHz / 16 bit / 单声道，约 7.2 s（首次含模型预热 18.5 s） |
| `POST /tts`（`streaming_mode:2`） | **200 / audio/wav**；首字节 4.8 ms；44 字节 WAV 头（`data` size=0）+ 32 kHz PCM16LE，全文件仅 1 个 RIFF 头 |
| `C:\Users\20323\.dsh\feiyu.config.json` | **存在**（仅含 esp32 token 段） |
| `C:\Users\20323\.feiyu-ai` | **存在**（空目录） |

### 2.3 状态：已就绪

2026-11-10 首轮探测曾判定 BLOCKED-USER（当时本机没有安装）。2026-11-11 已完成安装与迁移：

1. 旧的 `D:\GPT-SoVITS`（21 GB，含工作 venv 与参考音）整体移动到 `D:\AI_Code\小智机器人\GPT-SoVITS`；新装副本先改名为 `GPT-SoVITS-new-py312`（14 GB，Python 3.12，**不含 `models/`**）暂存。
2. venv 内 7 个含旧绝对路径的文件已修正，插件内 23 个文件共 64 处硬编码路径同步更新（`git diff --stat` 可查），`npm test` 309/309 通过。
3. 启动方式不变：`pwsh -File .\start-sovits.ps1`，等价于在根目录执行
   `.venv\Scripts\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`（`tts_infer.yaml` 内全部为相对路径，cwd 必须是仓库根）。
4. **通过标准（已达成）**：`/docs` 返回 200；`/tts` 返回有效 WAV（RIFF/WAVE，> 2 KB）；`streaming_mode:2` 为 44 字节头 + 裸 PCM。

> 注：`GPT-SoVITS-new-py312` 只是备份，确认稳定后可删除以回收 14 GB。

## 3. ESP-IDF（要求 ≥ v6.0.1）

### 3.1 初始探测

| 检查 | 结果 |
| --- | --- |
| `idf.py` / `idf.py.exe` in PATH | **不在 PATH** |
| `IDF_PATH` | 空 |
| `IDF_TOOLS_PATH` | `D:\Espressif`（环境变量已设置，但目录原本不存在） |
| `C:\Espressif` / `C:\Users\20323\.espressif` / `D:\Espressif` | 均 **MISSING** |
| `D:\AI_Code\小智机器人\tools\esp-idf` | 原本 **MISSING** |

### 3.2 已执行的安装

在用户授权下，已把 ESP-IDF **v6.0.1** 克隆到 `D:\AI_Code\小智机器人\tools\esp-idf`：

```powershell
git clone --depth 1 --branch v6.0.1 --recursive --shallow-submodules `
  https://github.com/espressif/esp-idf.git `
  'D:\AI_Code\小智机器人\tools\esp-idf'
```

结果：克隆成功（`git describe` 为 `v6.0.1`，21 个 submodule 已 checkout）。

工具链安装（最终成功）：

```powershell
$env:IDF_TOOLS_PATH = 'D:\Espressif'
pwsh -NoProfile -ExecutionPolicy Bypass -File `
  'D:\AI_Code\小智机器人\tools\esp-idf\install.ps1' esp32s3
```

首次直连 GitHub 下载 `xtensa-esp-elf` 时在 22% 处长时间停滞（文件约 86 MB / 总计约 389 MB）。已停止后改用 Espressif 官方镜像重跑（`xtensa-esp-elf-gdb` 会跳过，已安装）：

```powershell
$env:IDF_TOOLS_PATH = 'D:\Espressif'
# 国内网络首选 .cn 镜像；实测 5 MB Range 约 6 MB/s（.com 约 1.3 MB/s）
$env:IDF_GITHUB_ASSETS = 'dl.espressif.cn/github_assets'
pwsh -NoProfile -ExecutionPolicy Bypass -File `
  'D:\AI_Code\小智机器人\tools\esp-idf\install.ps1' esp32s3
```

镜像地址由 `idf_tools.py` 自动把 `https://github.com/...` 替换为
`https://<IDF_GITHUB_ASSETS>/...`；`dl.espressif.com/github_assets` 同样可用，但本次实测较慢。

最终结果：`INSTALL_EXIT=0`。`D:\Espressif\tools` 下已安装
`ccache`、`cmake`、`dfu-util`、`esp-rom-elfs`、`esp32ulp-elf`、`idf-exe`、`ninja`、
`openocd-esp32`、`riscv32-esp-elf`、`xtensa-esp-elf`、`xtensa-esp-elf-gdb`；
Python 虚拟环境为 `D:\Espressif\python_env\idf6.0_py3.12_env`（Python 3.12.10），
`export.ps1` 自检 “python dependencies ... OK / no outdated tools found”。

### 3.3 版本验证与日常使用

安装完成后，在 `D:\AI_Code\小智机器人\tools\esp-idf` 下：

```powershell
# 每个新 shell 先激活，之后同一会话内可直接用 idf.py
. 'D:\AI_Code\小智机器人\tools\esp-idf\export.ps1'
```

注意：v6 的 `idf.py` 是 `idf-exe` 启动器（本次 1.0.3），它会拦截 `--version` 并打印
**启动器自己的版本**（`v1.0.3`），不是 ESP-IDF 版本。查真实版本要用虚拟环境 Python
直接执行 `tools/idf.py`：

```powershell
& 'D:\Espressif\python_env\idf6.0_py3.12_env\Scripts\python.exe' `
  'D:\AI_Code\小智机器人\tools\esp-idf\tools\idf.py' --version
# 实测输出：ESP-IDF v6.0.1
```

旁证：`tools/cmake/version.cmake` 为 `6.0.1`；`git describe --tags --always` 为 `v6.0.1`。

固件编译（在 `D:\AI_Code\小智机器人\xiaozhi-esp32-2.5.2`）：

```powershell
idf.py set-target esp32s3
idf.py build
```

> 说明：上游 README 建议 ESP-IDF 5.4+；本任务按协议/固件要求使用 ≥ v6.0.1，v6.0.1 满足。

### 3.4 状态

- 克隆：**完成**（`v6.0.1`，21 个 submodule）。
- `install.ps1 esp32s3`：**完成**（`INSTALL_EXIT=0`，工具链 + Python 依赖均就绪）。
- 版本验证：**完成**（`python tools/idf.py --version` → `ESP-IDF v6.0.1`）。
- 若以后工具链损坏或换机：重跑 §3.2 的镜像命令即可（`install.ps1` 幂等）；通过标准为上面的 `ESP-IDF v6.0.1`。

## 4. 脚本清单

| 文件 | 作用 | 幂等 | 退出码 |
| --- | --- | --- | --- |
| `start-dsh.ps1` | 启动/确认 DSH 桌面版，等待 Web 宿主动态端口 | 是（已运行则直接报告） | 0 成功；1 失败 |
| `start-sovits.ps1` | 启动/确认 GPT-SoVITS `api_v2.py`（默认 9880） | 是（端口已通则直接报告） | 0 成功；1 失败；2 BLOCKED-USER |
| `probe.ps1` | 探活 DSH 在线、dsh-feiyu 已加载、GPT-SoVITS 可合成 | 只读 | 0 全 PASS；1 有 FAIL；2 有 BLOCKED |

常用命令：

```powershell
pwsh -File .\start-dsh.ps1
pwsh -File .\start-sovits.ps1
pwsh -File .\probe.ps1
```

`probe.ps1` 在 GPT-SoVITS 已安装后会自动找参考音；也可以显式传：

```powershell
pwsh -File .\probe.ps1 -RefAudio 'D:\AI_Code\小智机器人\GPT-SoVITS\models\yinlang\yinlang.wav' -PromptText '参考音的原话'
```

## 5. 本次探活真实输出

```text
=== 小智 ESP32 第五通道 · T01 环境探活 ===
时间：2026-11-10 15:58:31

[PASS] DSH 在线：宿主 PID=37848，端口=59737；未鉴权请求返回 401（符合预期）
[PASS] dsh-feiyu 路由：/dsh-feiyu/api/status 返回 401（鉴权拦截；外部脚本无 token，不能直接调用）
[PASS] dsh-feiyu 安装：依赖=link:D:/AI_Code/小智机器人/dsh-feiyu；bundles 含 dsh-feiyu=True
[PASS] dsh-feiyu 链接：LinkType=Junction；Target=D:\AI_Code\小智机器人\dsh-feiyu
[PASS] dsh-feiyu 运行标记：createdAt=2026-11-10 07:01:55Z；文件更新=2026-11-10 07:57:55Z；宿主启动=2026-11-10 07:01:49Z；feiyu-work=True
[BLOCKED] GPT-SoVITS：127.0.0.1:9880 无监听；本机未安装/未启动 GPT-SoVITS（见 env.md）
[BLOCKED] GPT-SoVITS 合成：服务不可达，无法做真实合成

=== 总结：PASS=5 FAIL=0 BLOCKED=2 WARN=0 SKIP=0 ===
存在 BLOCKED 项：需要人工安装/配置后重跑（见 env.md 的“未完成/人工步骤”）。
```

> 说明：以上为 **2026-11-10 15:58:31 的历史实测输出**（退出码 2，当时 GPT-SoVITS 尚未安装）。`createdAt` 的时区偏移问题已修复（改用 `[datetimeoffset]$night.createdAt`），探活结论不受影响。**2026-11-11 复测**：GPT-SoVITS 两项已由 BLOCKED 转为 PASS——`/docs` 200，`/tts` 普通模式与 `streaming_mode:2` 均返回有效 WAV（详见 §2.2 / §2.3）。

## 6. 未完成 / 人工步骤

1. ~~**GPT-SoVITS 未安装**~~ → **已完成（2026-11-11）**：安装/迁移完毕，参考音就位，`:9880` 合成实测通过（§2.2）。
2. **DSH API 外部调用**：桌面版使用动态端口 + per-process token，外部 agent 无法直接调用 `/dsh-feiyu/api/*`。如果后续任务需要自动调用，需另行设计受控入口（不要提取/落盘 token）。
3. **voice-input**：当前已启用且模型已缓存，无需人工操作；若以后清空 `~/.dsh/speech-to-text`，需在桌面版插件管理页重新“下载并准备”。
4. **可选清理**：确认稳定后删除 `D:\AI_Code\小智机器人\GPT-SoVITS-new-py312`（14 GB，Python 3.12 新装副本，无参考音）。

说明：ESP-IDF（§3）与 GPT-SoVITS（§2）均已不再阻塞。

## 7. 安全记录

- 未读取、未打印、未写入 DSH 的 launch token 或 `dsh-auth-*` cookie。
- 未读取、未写入任何 Wi-Fi 密码、API Key、模型 Provider 密钥或口令。
- `probe.ps1` 只做未鉴权请求（预期 401）和 GPT-SoVITS 公开 `/docs`、`/tts` 请求；不包含凭据。
