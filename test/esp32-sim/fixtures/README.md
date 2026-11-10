# ESP32 第五通道测试语音素材（T09）

由 `test/esp32-sim/gen-fixtures.ps1` 生成。请勿手工修改 WAV；改文本后重跑脚本即可。

## 格式

- 采样率：16000 Hz
- 声道：1（mono）
- 位深：16 bit PCM 小端（`pcm_s16le`）
- WAV 头：标准 44 字节 RIFF/WAVE，`fmt ` chunk 16 字节，`data` 从偏移 44 开始
- 语音合成：Windows SAPI（System.Speech），语音 `Microsoft Huihui Desktop`

## 清单

| 文件 | 期望文本 | 时长 (ms) | 字节数 | 用途 |
| --- | --- | ---: | ---: | --- |
| `wake-dafeiyu.wav` | 大肥鱼 | 1665 | 53324 | 唤醒/问候词（hello→listen→stt 基线） |
| `qa-weather.wav` | 今天天气怎么样 | 2455 | 78604 | 日常问答：天气（T14 模拟设备 STT 断言） |
| `qa-joke.wav` | 给我讲个笑话 | 2235 | 71564 | 日常问答：讲笑话（T22 E2E 输入） |
| `long-sentence.wav` | 今天天气真不错我们一起去公园散步吧 | 5010 | 160364 | 长句 ≥15 字（句切分/TTS 分块/T21 长句转写） |
| `emotion-happy.wav` | 太棒了我太开心了 | 1897 | 60732 | 带情绪短句（高兴，SSML 快语速/高音调） |
| `silence.wav` | — | 2000 | 64044 | ≥2s 数字静音（VAD 负样本/打断基线） |
| `noise.wav` | — | 2000 | 64044 | ≥2s 低幅白噪声（VAD 噪声底，幅度 ±300） |

## SHA-256

```text
aebaaf84666aaf8c9aecb4eb78e10b581d45e93739bcccdeb46fc6befccb44ee  wake-dafeiyu.wav
034ae594a1f31f7d3d38ca70d058c5b2bdbebb5f5e024bdec6019590375ac790  qa-weather.wav
0545458b8282a75edc3b7203f4e549c911e7ae5ea7c16e41d4f94cfc3ccf804e  qa-joke.wav
ee9aed37e866ec8da10ead8e0251b6b48a77c99ef5564a7798f038f79e163ff3  long-sentence.wav
5aca317a5e700933bf674f62abc691b0c71d3f8e0f055e1078e4ef5adcc73acc  emotion-happy.wav
20eaebffe1816e0ffa6f7f854f5ef4ea80d5349faaf0ce1fec1b713e7fde58fa  silence.wav
aaae5227b05129f22a0d2a7952934d5911c8cce2ca610a0e4945586279b0dab8  noise.wav
```

## manifest.json

顶层对象为 `{ version, generatedBy, voice, format, fixtures }`；`fixtures` 是数组，每条包含：

`file`、`text`（期望文本）、`durationMs`、`sampleRate`、`channels`、`bitsPerSample`、`purpose`。

- `text` 是去标点的归一化期望文本（SAPI 实际输入可能带标点/SSML，用于自然停顿与情绪）；
  STT 断言建议先对识别结果做同样的去标点/空白归一化，再做包含或相等比较。
- `silence.wav` / `noise.wav` 没有期望文本，`text` 为空字符串。
- `noise.wav` 为固定种子（20261110）的均匀白噪声，幅度 ±300（约 -40.8 dBFS 峰值）。
- `durationMs` 由 `data` 字节数换算：`Math.round(dataSize / 32)`（四舍五入，与 Node 的 `Math.round` 一致）。

## 重新生成 / 校验

```powershell
# 生成（幂等，重复执行结果一致）
powershell -NoProfile -ExecutionPolicy Bypass -File test/esp32-sim/gen-fixtures.ps1

# 只校验（不依赖 SAPI）
powershell -NoProfile -ExecutionPolicy Bypass -File test/esp32-sim/gen-fixtures.ps1 -CheckOnly
```

## 生成运行输出（最近一次成功运行）

```text
[gen] 输出目录：test/esp32-sim/fixtures
[voice] Microsoft Huihui Desktop (zh-CN)
[gen] wake-dafeiyu.wav <- SAPI: 大肥鱼
[gen]   wake-dafeiyu.wav  1665 ms  53324 bytes
[gen] qa-weather.wav <- SAPI: 今天天气怎么样？
[gen]   qa-weather.wav  2455 ms  78604 bytes
[gen] qa-joke.wav <- SAPI: 给我讲个笑话
[gen]   qa-joke.wav  2235 ms  71564 bytes
[gen] long-sentence.wav <- SAPI: 今天天气真不错，我们一起去公园散步吧。
[gen]   long-sentence.wav  5010 ms  160364 bytes
[gen] emotion-happy.wav <- SAPI: <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody rate="fast" pitch="high">太棒了，我太开心了！</prosody></speak>
[gen]   emotion-happy.wav  1897 ms  60732 bytes
[gen] silence.wav  2000 ms  64044 bytes
[gen] noise.wav  2000 ms  64044 bytes
[gen] manifest.json 已写入（7 条）
[check] wake-dafeiyu.wav  1665ms  53324B  maxAbs=30839  rms=2641.2  -> PASS
[check] qa-weather.wav  2455ms  78604B  maxAbs=14341  rms=1255.9  -> PASS
[check] qa-joke.wav  2235ms  71564B  maxAbs=23483  rms=2209.5  -> PASS
[check] long-sentence.wav  5010ms  160364B  maxAbs=16433  rms=1467.2  -> PASS
[check] emotion-happy.wav  1897ms  60732B  maxAbs=24804  rms=2320.5  -> PASS
[check] silence.wav  2000ms  64044B  maxAbs=0  rms=0  -> PASS
[check] noise.wav  2000ms  64044B  maxAbs=300  rms=173.3  -> PASS
[check] 全部通过：7 个 WAV + manifest.json
```

