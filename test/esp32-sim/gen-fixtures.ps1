#requires -Version 5.1
<#
.SYNOPSIS
生成 ESP32 第五通道测试用固定中文语音素材（T09）。

.DESCRIPTION
- 用 Windows SAPI（System.Speech）合成 5 句中文，直接请求 16000 Hz / mono / 16-bit PCM
  （SpeechAudioFormatInfo，不做二次重采样）。
- SAPI 实际写出的是 18 字节 fmt chunk（46 字节头）；脚本会解析并归一化为标准 44 字节
  RIFF/WAVE PCM16 头，便于 Node 侧按固定偏移校验。
- 直接生成 2 秒数字静音和 2 秒低幅白噪声（固定随机种子，可重复）。
- 写出 fixtures/manifest.json（UTF-8 无 BOM，Node JSON.parse 可直接读取）。
- 末尾自检：RIFF/WAVE、fmt=PCM、16000 Hz、1 声道、16 bit、44 字节头、时长与 manifest
  一致，并用 System.Media.SoundPlayer 实际加载每个 WAV；失败退出码非 0。
- 没有中文 SAPI 语音时以退出码 2 明确失败，绝不回退英文语音冒充中文素材。

.PARAMETER OutputDir
输出目录，默认 <脚本目录>/fixtures。

.PARAMETER CheckOnly
只校验现有文件，不重新生成（CI/合并前检查用）。

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File test/esp32-sim/gen-fixtures.ps1

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File test/esp32-sim/gen-fixtures.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
  [string]$OutputDir,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

# 便于在 Git Bash / CI 等重定向场景下正确显示中文日志（不影响写盘编码）。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:SampleRate = 16000
$script:Channels = 1
$script:BitsPerSample = 16
$script:BlockAlign = 2
$script:ByteRate = 32000
$script:NoiseAmplitude = 300        # 满量程 32767 的 ~0.9%，约 -40.8 dBFS 峰值
$script:NoiseSeed = 20261110
$script:SilenceMs = 2000
$script:NoiseMs = 2000

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $PSScriptRoot 'fixtures'
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$script:ManifestPath = Join-Path $OutputDir 'manifest.json'
$script:ReadmePath = Join-Path $OutputDir 'README.md'

$script:RunLines = New-Object 'System.Collections.Generic.List[string]'
$script:Errors = New-Object 'System.Collections.Generic.List[string]'

# 固定素材定义（顺序即 manifest 顺序）。
# Text 为期望文本（去标点归一化，供 STT 断言）；Speech 为实际送入 SAPI 的文本
# （可带标点/SSML，用于获得更自然的停顿和情绪）。
$script:Fixtures = @(
  [pscustomobject]@{
    File = 'wake-dafeiyu.wav'; Kind = 'speech'; Text = '大肥鱼'; Speech = '大肥鱼'; Ssml = $false
    Purpose = '唤醒/问候词（hello→listen→stt 基线）'; MinDurationMs = 500; MinTextLength = 1
  },
  [pscustomobject]@{
    File = 'qa-weather.wav'; Kind = 'speech'; Text = '今天天气怎么样'; Speech = '今天天气怎么样？'; Ssml = $false
    Purpose = '日常问答：天气（T14 模拟设备 STT 断言）'; MinDurationMs = 800; MinTextLength = 1
  },
  [pscustomobject]@{
    File = 'qa-joke.wav'; Kind = 'speech'; Text = '给我讲个笑话'; Speech = '给我讲个笑话'; Ssml = $false
    Purpose = '日常问答：讲笑话（T22 E2E 输入）'; MinDurationMs = 800; MinTextLength = 1
  },
  [pscustomobject]@{
    File = 'long-sentence.wav'; Kind = 'speech'; Text = '今天天气真不错我们一起去公园散步吧'
    Speech = '今天天气真不错，我们一起去公园散步吧。'; Ssml = $false
    Purpose = '长句 ≥15 字（句切分/TTS 分块/T21 长句转写）'; MinDurationMs = 1500; MinTextLength = 15
  },
  [pscustomobject]@{
    File = 'emotion-happy.wav'; Kind = 'speech'; Text = '太棒了我太开心了'; Ssml = $true
    Speech = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody rate="fast" pitch="high">太棒了，我太开心了！</prosody></speak>'
    Purpose = '带情绪短句（高兴，SSML 快语速/高音调）'; MinDurationMs = 800; MinTextLength = 1
  },
  [pscustomobject]@{
    File = 'silence.wav'; Kind = 'silence'; Text = ''; Speech = ''; Ssml = $false
    Purpose = '≥2s 数字静音（VAD 负样本/打断基线）'; MinDurationMs = 2000; MinTextLength = 0
  },
  [pscustomobject]@{
    File = 'noise.wav'; Kind = 'noise'; Text = ''; Speech = ''; Ssml = $false
    Purpose = '≥2s 低幅白噪声（VAD 噪声底，幅度 ±300）'; MinDurationMs = 2000; MinTextLength = 0
  }
)

function Write-Run {
  param([string]$Line)
  Write-Host $Line
  $script:RunLines.Add($Line)
}

function Add-CheckError {
  param([string]$Message)
  $script:Errors.Add($Message)
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Text, $enc)
}

# 用标准 44 字节头写 PCM16 WAV（先写 .tmp，再原子替换，避免半截文件）。
function Write-Pcm16Wav {
  param(
    [string]$Path,
    [Int16[]]$Samples,
    [int]$SampleRate = 16000
  )

  $dataSize = [int]($Samples.Length * 2)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  try {
    $ascii = [Text.Encoding]::ASCII
    $bw.Write($ascii.GetBytes('RIFF'))
    $bw.Write([UInt32](36 + $dataSize))
    $bw.Write($ascii.GetBytes('WAVE'))
    $bw.Write($ascii.GetBytes('fmt '))
    $bw.Write([UInt32]16)
    $bw.Write([UInt16]1)                              # PCM
    $bw.Write([UInt16]$script:Channels)
    $bw.Write([UInt32]$SampleRate)
    $bw.Write([UInt32]($SampleRate * $script:BlockAlign))
    $bw.Write([UInt16]$script:BlockAlign)
    $bw.Write([UInt16]$script:BitsPerSample)
    $bw.Write($ascii.GetBytes('data'))
    $bw.Write([UInt32]$dataSize)
    for ($i = 0; $i -lt $Samples.Length; $i++) {
      $bw.Write([Int16]$Samples[$i])
    }
    $bw.Flush()
    $bytes = $ms.ToArray()
  } finally {
    $bw.Dispose()
    $ms.Dispose()
  }

  $tmp = $Path + '.tmp'
  [IO.File]::WriteAllBytes($tmp, $bytes)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
  Move-Item -LiteralPath $tmp -Destination $Path
}

# 解析 WAV（容忍附加 chunk），返回头字段、data 位置、时长与幅度统计。
function Read-WavFile {
  param([string]$Path)

  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 44) {
    throw "WAV 文件过短：$Path（$($bytes.Length) 字节）"
  }
  $ascii = [Text.Encoding]::ASCII
  if ($ascii.GetString($bytes, 0, 4) -ne 'RIFF') {
    throw "缺少 RIFF 标识：$Path"
  }
  if ($ascii.GetString($bytes, 8, 4) -ne 'WAVE') {
    throw "缺少 WAVE 标识：$Path"
  }

  $riffSize = [BitConverter]::ToUInt32($bytes, 4)
  $fmt = $null
  $dataOffset = -1
  $dataSize = 0
  $offset = 12
  while ($offset + 8 -le $bytes.Length) {
    $chunkId = $ascii.GetString($bytes, $offset, 4)
    $chunkSize = [BitConverter]::ToUInt32($bytes, $offset + 4)
    $body = $offset + 8
    if (([int64]$body + [int64]$chunkSize) -gt [int64]$bytes.Length) {
      throw "chunk '$chunkId' 越界（文件可能被截断）：$Path"
    }
    if ($chunkId -eq 'fmt ') {
      if ($chunkSize -lt 16) {
        throw "fmt chunk 过短（$chunkSize 字节）：$Path"
      }
      $fmt = [pscustomobject]@{
        ChunkSize     = [int]$chunkSize
        AudioFormat   = [BitConverter]::ToUInt16($bytes, $body)
        Channels      = [BitConverter]::ToUInt16($bytes, $body + 2)
        SampleRate    = [BitConverter]::ToUInt32($bytes, $body + 4)
        ByteRate      = [BitConverter]::ToUInt32($bytes, $body + 8)
        BlockAlign    = [BitConverter]::ToUInt16($bytes, $body + 12)
        BitsPerSample = [BitConverter]::ToUInt16($bytes, $body + 14)
      }
    } elseif ($chunkId -eq 'data' -and $dataOffset -lt 0) {
      $dataOffset = $body
      $dataSize = [int]$chunkSize
    }
    $offset = $body + [int]$chunkSize + ([int]$chunkSize % 2)
  }

  if ($null -eq $fmt) { throw "缺少 fmt chunk：$Path" }
  if ($dataOffset -lt 0) { throw "缺少 data chunk：$Path" }
  if (($dataSize % 2) -ne 0) { throw "PCM16 data 长度不是 2 的倍数：$Path" }

  $frames = [int]($dataSize / 2)
  $durationMs = 0
  if ($fmt.SampleRate -gt 0) {
    # 与 JS Math.round 一致的四舍五入（.NET 的 Round 是银行家舍入）。
    $durationMs = [int][math]::Floor($frames * 1000.0 / $fmt.SampleRate + 0.5)
  }

  $maxAbs = 0
  $sumSq = 0.0
  for ($i = 0; $i -lt $dataSize; $i += 2) {
    $v = [int][BitConverter]::ToInt16($bytes, $dataOffset + $i)
    $a = [math]::Abs($v)
    if ($a -gt $maxAbs) { $maxAbs = $a }
    $sumSq += [double]$v * $v
  }
  $rms = 0.0
  if ($frames -gt 0) { $rms = [math]::Sqrt($sumSq / $frames) }

  return [pscustomobject]@{
    Path          = $Path
    Bytes         = $bytes
    Length        = $bytes.Length
    RiffSize      = $riffSize
    FmtChunkSize  = $fmt.ChunkSize
    AudioFormat   = $fmt.AudioFormat
    Channels      = $fmt.Channels
    SampleRate    = $fmt.SampleRate
    ByteRate      = $fmt.ByteRate
    BlockAlign    = $fmt.BlockAlign
    BitsPerSample = $fmt.BitsPerSample
    DataOffset    = $dataOffset
    DataSize      = $dataSize
    Frames        = $frames
    DurationMs    = $durationMs
    MaxAbs        = $maxAbs
    Rms           = [math]::Round($rms, 1)
  }
}

# 只用中文（zh-*）SAPI 语音；优先 Huihui/Yaoyao 等常见中文音色。
function Select-ChineseVoice {
  param([System.Speech.Synthesis.SpeechSynthesizer]$Synth)

  $installed = @($Synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  $zh = @($installed | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' })
  if ($zh.Count -eq 0) {
    $names = @($installed | ForEach-Object { '{0} ({1})' -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture.Name }) -join ', '
    if ([string]::IsNullOrWhiteSpace($names)) { $names = '（无已启用语音）' }
    throw (New-Object System.OperationCanceledException(
      "未找到中文 SAPI 语音（已安装：$names）。请安装 Microsoft Huihui/Yaoyao 后重试；脚本不会用非中文语音冒充中文素材。"))
  }

  $preferred = @('Huihui', 'Yaoyao', 'Xiaoxiao', 'Kangkang', 'Xiaoyi', 'Huihui Desktop')
  foreach ($pattern in $preferred) {
    $hit = @($zh | Where-Object { $_.VoiceInfo.Name -like "*$pattern*" })
    if ($hit.Count -gt 0) { return $hit[0] }
  }
  return $zh[0]
}

function Convert-SapiWavToCanonical {
  param([string]$Source, [string]$Destination)

  $src = Read-WavFile -Path $Source
  if ($src.AudioFormat -ne 1 -or $src.Channels -ne 1 -or
      $src.SampleRate -ne $script:SampleRate -or $src.BitsPerSample -ne $script:BitsPerSample) {
    throw ("SAPI 输出格式不符合 16k/mono/PCM16：format={0} ch={1} sr={2} bits={3}（{4}）" -f
      $src.AudioFormat, $src.Channels, $src.SampleRate, $src.BitsPerSample, $Source)
  }

  $samples = New-Object 'Int16[]' $src.Frames
  for ($i = 0; $i -lt $samples.Length; $i++) {
    $samples[$i] = [BitConverter]::ToInt16($src.Bytes, $src.DataOffset + $i * 2)
  }
  Write-Pcm16Wav -Path $Destination -Samples $samples -SampleRate $script:SampleRate
}

# 逐个文件校验头字段、时长与 manifest 一致性；失败返回 $false。
function Test-Fixtures {
  param(
    [string]$ManifestPath,
    [object[]]$Definitions
  )

  if (-not (Test-Path -LiteralPath $ManifestPath)) {
    Add-CheckError "缺少 manifest.json：$ManifestPath"
    return $false
  }

  # manifest 必须是 UTF-8 无 BOM，否则 Node JSON.parse 会因 U+FEFF 失败。
  $raw = [IO.File]::ReadAllBytes($ManifestPath)
  if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
    Add-CheckError 'manifest.json 带 UTF-8 BOM（Node JSON.parse 会失败）'
  }
  $jsonText = [Text.Encoding]::UTF8.GetString($raw)
  try {
    $manifest = ConvertFrom-Json -InputObject $jsonText
  } catch {
    Add-CheckError "manifest.json 不是合法 JSON：$($_.Exception.Message)"
    return $false
  }

  foreach ($prop in @('version', 'voice', 'format', 'fixtures')) {
    if ($null -eq $manifest.PSObject.Properties[$prop]) {
      Add-CheckError "manifest.json 缺少顶层字段：$prop"
    }
  }
  if ($null -eq $manifest.fixtures) {
    Add-CheckError 'manifest.json 缺少 fixtures 数组'
    return $false
  }

  $expected = @{}
  foreach ($d in $Definitions) { $expected[$d.File] = $d }
  $seen = @{}

  foreach ($item in @($manifest.fixtures)) {
    $name = [string]$item.file
    if (-not $expected.ContainsKey($name)) {
      Add-CheckError "manifest 含未知条目：$name"
      continue
    }
    if ($seen.ContainsKey($name)) {
      Add-CheckError "manifest 条目重复：$name"
      continue
    }
    $seen[$name] = $true
    $def = $expected[$name]

    foreach ($key in @('file', 'text', 'durationMs', 'sampleRate', 'channels', 'bitsPerSample', 'purpose')) {
      if ($null -eq $item.PSObject.Properties[$key]) {
        Add-CheckError "$name 缺少 manifest 字段：$key"
      }
    }

    if ([string]$item.text -ne [string]$def.Text) {
      Add-CheckError ("{0} 的 text 与脚本定义不一致：manifest='{1}' 期望='{2}'" -f $name, $item.text, $def.Text)
    }
    if ([int]$def.MinTextLength -gt 0 -and ([string]$item.text).Length -lt [int]$def.MinTextLength) {
      Add-CheckError ("{0} 的 text 长度 {1} 小于要求 {2}" -f $name, ([string]$item.text).Length, $def.MinTextLength)
    }
    if ([int]$item.sampleRate -ne $script:SampleRate) {
      Add-CheckError ("{0} 的 manifest sampleRate={1}，期望 {2}" -f $name, $item.sampleRate, $script:SampleRate)
    }
    if ([int]$item.channels -ne $script:Channels) {
      Add-CheckError ("{0} 的 manifest channels={1}，期望 {2}" -f $name, $item.channels, $script:Channels)
    }
    if ([int]$item.bitsPerSample -ne $script:BitsPerSample) {
      Add-CheckError ("{0} 的 manifest bitsPerSample={1}，期望 {2}" -f $name, $item.bitsPerSample, $script:BitsPerSample)
    }
    if ([string]::IsNullOrWhiteSpace([string]$item.purpose)) {
      Add-CheckError "$name 的 purpose 为空"
    }

    $path = Join-Path $OutputDir $name
    if (-not (Test-Path -LiteralPath $path)) {
      Add-CheckError "缺少 WAV 文件：$name"
      continue
    }

    try {
      $info = Read-WavFile -Path $path
    } catch {
      Add-CheckError "$name 解析失败：$($_.Exception.Message)"
      continue
    }

    # 标准 44 字节头（fmt chunk 16 字节，data 紧随其后）。
    if ($info.FmtChunkSize -ne 16) {
      Add-CheckError "$name 的 fmt chunk 为 $($info.FmtChunkSize) 字节，期望 16（44 字节头）"
    }
    if ($info.DataOffset -ne 44) {
      Add-CheckError "$name 的 data 起始偏移为 $($info.DataOffset)，期望 44"
    }
    if ($info.Length -ne (44 + $info.DataSize)) {
      Add-CheckError "$name 的文件长度 $($info.Length) != 44 + dataSize $($info.DataSize)"
    }
    if ([int64]$info.RiffSize -ne [int64]($info.Length - 8)) {
      Add-CheckError "$name 的 RIFF size $($info.RiffSize) != 文件长度-8 $($info.Length - 8)"
    }

    # 头字段。
    if ($info.AudioFormat -ne 1) {
      Add-CheckError "$name 的 audioFormat=$($info.AudioFormat)，期望 1（PCM）"
    }
    if ($info.Channels -ne 1) {
      Add-CheckError "$name 的声道数=$($info.Channels)，期望 1"
    }
    if ($info.SampleRate -ne $script:SampleRate) {
      Add-CheckError "$name 的采样率=$($info.SampleRate)，期望 $($script:SampleRate)"
    }
    if ($info.BitsPerSample -ne 16) {
      Add-CheckError "$name 的位深=$($info.BitsPerSample)，期望 16"
    }
    if ($info.BlockAlign -ne 2) {
      Add-CheckError "$name 的 blockAlign=$($info.BlockAlign)，期望 2"
    }
    if ($info.ByteRate -ne 32000) {
      Add-CheckError "$name 的 byteRate=$($info.ByteRate)，期望 32000"
    }

    # WAV 头时长与 manifest 一致（允许 1 ms 舍入误差）。
    if ([math]::Abs([double]$info.DurationMs - [double]$item.durationMs) -gt 1.0) {
      Add-CheckError ("{0} 的 WAV 时长 {1}ms 与 manifest {2}ms 不一致" -f $name, $info.DurationMs, $item.durationMs)
    }
    if ($info.DurationMs -lt [int]$def.MinDurationMs) {
      Add-CheckError ("{0} 的时长 {1}ms 小于要求 {2}ms" -f $name, $info.DurationMs, $def.MinDurationMs)
    }

    switch ($def.Kind) {
      'silence' {
        if ($info.MaxAbs -ne 0) {
          Add-CheckError "$name 应为数字静音，但 maxAbs=$($info.MaxAbs)"
        }
      }
      'noise' {
        if ($info.MaxAbs -lt 50) {
          Add-CheckError "$name 的白噪声幅度过低（maxAbs=$($info.MaxAbs)），可能已被静音"
        }
        if ($info.MaxAbs -gt 1000) {
          Add-CheckError "$name 的白噪声幅度过高（maxAbs=$($info.MaxAbs)），要求低幅（≤1000）"
        }
      }
      default {
        if ($info.MaxAbs -le 1000) {
          Add-CheckError "$name 几乎无声（maxAbs=$($info.MaxAbs)），疑似 SAPI 合成失败"
        }
      }
    }

    # 用 SoundPlayer 实际加载，验证 Windows 音频栈认可该 WAV。
    try {
      $player = New-Object System.Media.SoundPlayer($path)
      $player.Load()
    } catch {
      Add-CheckError "$name 无法被 System.Media.SoundPlayer 加载：$($_.Exception.Message)"
    }

    Write-Run (("[check] {0}  {1}ms  {2}B  maxAbs={3}  rms={4}  -> PASS" -f
      $name, $info.DurationMs, $info.Length, $info.MaxAbs, $info.Rms))
  }

  foreach ($d in $Definitions) {
    if (-not $seen.ContainsKey($d.File)) {
      Add-CheckError "manifest 缺少条目：$($d.File)"
    }
  }

  # 目录里不应有 manifest 未覆盖的 WAV（防止陈旧素材混入）。
  $known = @{}
  foreach ($d in $Definitions) { $known[$d.File] = $true }
  foreach ($wav in @(Get-ChildItem -LiteralPath $OutputDir -Filter '*.wav' -File)) {
    if (-not $known.ContainsKey($wav.Name)) {
      Add-CheckError "fixtures 目录存在 manifest 未登记的 WAV：$($wav.Name)"
    }
  }

  return ($script:Errors.Count -eq 0)
}

function Write-FixturesReadme {
  param(
    [string]$Path,
    [string]$VoiceName,
    [object[]]$Definitions
  )

  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.Add('# ESP32 第五通道测试语音素材（T09）')
  $lines.Add('')
  $lines.Add('由 `test/esp32-sim/gen-fixtures.ps1` 生成。请勿手工修改 WAV；改文本后重跑脚本即可。')
  $lines.Add('')
  $lines.Add('## 格式')
  $lines.Add('')
  $lines.Add('- 采样率：16000 Hz')
  $lines.Add('- 声道：1（mono）')
  $lines.Add('- 位深：16 bit PCM 小端（`pcm_s16le`）')
  $lines.Add('- WAV 头：标准 44 字节 RIFF/WAVE，`fmt ` chunk 16 字节，`data` 从偏移 44 开始')
  $lines.Add("- 语音合成：Windows SAPI（System.Speech），语音 ``$VoiceName``")
  $lines.Add('')
  $lines.Add('## 清单')
  $lines.Add('')
  $lines.Add('| 文件 | 期望文本 | 时长 (ms) | 字节数 | 用途 |')
  $lines.Add('| --- | --- | ---: | ---: | --- |')
  foreach ($def in $Definitions) {
    $info = Read-WavFile -Path (Join-Path $OutputDir $def.File)
    $text = [string]$def.Text
    if ([string]::IsNullOrEmpty($text)) { $text = '—' }
    $lines.Add(('| `{0}` | {1} | {2} | {3} | {4} |' -f
      $def.File, $text, $info.DurationMs, $info.Length, $def.Purpose))
  }
  $lines.Add('')
  $lines.Add('## SHA-256')
  $lines.Add('')
  $lines.Add('```text')
  foreach ($def in $Definitions) {
    $filePath = Join-Path $OutputDir $def.File
    $hash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines.Add(('{0}  {1}' -f $hash, $def.File))
  }
  $lines.Add('```')
  $lines.Add('')
  $lines.Add('## manifest.json')
  $lines.Add('')
  $lines.Add('顶层对象为 `{ version, generatedBy, voice, format, fixtures }`；`fixtures` 是数组，每条包含：')
  $lines.Add('')
  $lines.Add('`file`、`text`（期望文本）、`durationMs`、`sampleRate`、`channels`、`bitsPerSample`、`purpose`。')
  $lines.Add('')
  $lines.Add('- `text` 是去标点的归一化期望文本（SAPI 实际输入可能带标点/SSML，用于自然停顿与情绪）；')
  $lines.Add('  STT 断言建议先对识别结果做同样的去标点/空白归一化，再做包含或相等比较。')
  $lines.Add('- `silence.wav` / `noise.wav` 没有期望文本，`text` 为空字符串。')
  $lines.Add('- `noise.wav` 为固定种子（20261110）的均匀白噪声，幅度 ±300（约 -40.8 dBFS 峰值）。')
  $lines.Add('- `durationMs` 由 `data` 字节数换算：`Math.round(dataSize / 32)`（四舍五入，与 Node 的 `Math.round` 一致）。')
  $lines.Add('')
  $lines.Add('## 重新生成 / 校验')
  $lines.Add('')
  $lines.Add('```powershell')
  $lines.Add('# 生成（幂等，重复执行结果一致）')
  $lines.Add('powershell -NoProfile -ExecutionPolicy Bypass -File test/esp32-sim/gen-fixtures.ps1')
  $lines.Add('')
  $lines.Add('# 只校验（不依赖 SAPI）')
  $lines.Add('powershell -NoProfile -ExecutionPolicy Bypass -File test/esp32-sim/gen-fixtures.ps1 -CheckOnly')
  $lines.Add('```')
  $lines.Add('')
  $lines.Add('## 生成运行输出（最近一次成功运行）')
  $lines.Add('')
  $lines.Add('```text')
  foreach ($line in $script:RunLines) { $lines.Add($line) }
  $lines.Add('```')
  $lines.Add('')

  Write-Utf8NoBom -Path $Path -Text (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
}

function Write-ManifestJson {
  param(
    [string]$Path,
    [string]$VoiceName,
    [object[]]$Definitions
  )

  # 固定字段顺序与缩进，避免不同 PowerShell 版本 ConvertTo-Json 排版差异。
  $q = { param($s) ConvertTo-Json -InputObject ([string]$s) -Compress }
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.Add('{')
  $lines.Add('  "version": 1,')
  $lines.Add(('  "generatedBy": {0},' -f (& $q 'test/esp32-sim/gen-fixtures.ps1')))
  $lines.Add(('  "voice": {0},' -f (& $q $VoiceName)))
  $lines.Add('  "format": {')
  $lines.Add('    "sampleRate": 16000,')
  $lines.Add('    "channels": 1,')
  $lines.Add('    "bitsPerSample": 16,')
  $lines.Add('    "encoding": "pcm_s16le"')
  $lines.Add('  },')
  $lines.Add('  "fixtures": [')

  for ($i = 0; $i -lt $Definitions.Length; $i++) {
    $def = $Definitions[$i]
    $info = Read-WavFile -Path (Join-Path $OutputDir $def.File)
    $isLast = ($i -eq $Definitions.Length - 1)
    $lines.Add('    {')
    $lines.Add(('      "file": {0},' -f (& $q $def.File)))
    $lines.Add(('      "text": {0},' -f (& $q $def.Text)))
    $lines.Add(('      "durationMs": {0},' -f $info.DurationMs))
    $lines.Add(('      "sampleRate": {0},' -f $info.SampleRate))
    $lines.Add(('      "channels": {0},' -f $info.Channels))
    $lines.Add(('      "bitsPerSample": {0},' -f $info.BitsPerSample))
    $lines.Add(('      "purpose": {0}' -f (& $q $def.Purpose)))
    if ($isLast) {
      $lines.Add('    }')
    } else {
      $lines.Add('    },')
    }
  }

  $lines.Add('  ]')
  $lines.Add('}')
  Write-Utf8NoBom -Path $Path -Text (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
}

# ── 主流程 ──────────────────────────────────────────────────────────────────

$outputDisplay = $OutputDir
$defaultOutputDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'fixtures'))
if ($OutputDir -eq $defaultOutputDir) {
  $outputDisplay = 'test/esp32-sim/fixtures'
}

Write-Run "[gen] 输出目录：$outputDisplay"
if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$voiceName = $null

if (-not $CheckOnly) {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    try {
      $voice = Select-ChineseVoice -Synth $synth
    } catch [System.OperationCanceledException] {
      Write-Run ("[error] " + $_.Exception.Message)
      exit 2
    }

    $voiceName = $voice.VoiceInfo.Name
    $synth.SelectVoice($voiceName)
    $synth.Rate = 0
    $synth.Volume = 100
    Write-Run ("[voice] {0} ({1})" -f $voiceName, $voice.VoiceInfo.Culture.Name)

    # 直接请求 16k / mono / 16bit，避免后续重采样。
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
      $script:SampleRate,
      [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
      [System.Speech.AudioFormat.AudioChannel]::Mono)

    foreach ($def in $script:Fixtures) {
      if ($def.Kind -ne 'speech') { continue }
      $tmp = Join-Path $OutputDir ('.sapi-' + $def.File)
      $dest = Join-Path $OutputDir $def.File
      Write-Run ("[gen] {0} <- SAPI: {1}" -f $def.File, $def.Speech)
      $synth.SetOutputToWaveFile($tmp, $fmt)
      try {
        if ($def.Ssml) {
          $synth.SpeakSsml($def.Speech)
        } else {
          $synth.Speak($def.Speech)
        }
      } finally {
        $synth.SetOutputToNull()
      }
      Convert-SapiWavToCanonical -Source $tmp -Destination $dest
      Remove-Item -LiteralPath $tmp -Force
      $wav = Read-WavFile -Path $dest
      Write-Run ("[gen]   {0}  {1} ms  {2} bytes" -f $def.File, $wav.DurationMs, $wav.Length)
    }
  } catch {
    Write-Run ("[error] 生成失败：" + $_.Exception.Message)
    exit 3
  } finally {
    if ($null -ne $synth) { $synth.Dispose() }
  }

  # 数字静音（全零采样）。
  $silenceSamples = New-Object 'Int16[]' ([int]($script:SilenceMs * 16))
  Write-Pcm16Wav -Path (Join-Path $OutputDir 'silence.wav') -Samples $silenceSamples -SampleRate $script:SampleRate
  $silenceInfo = Read-WavFile -Path (Join-Path $OutputDir 'silence.wav')
  Write-Run ("[gen] silence.wav  {0} ms  {1} bytes" -f $silenceInfo.DurationMs, $silenceInfo.Length)

  # 低幅白噪声（固定种子，可重复）。
  $noiseSamples = New-Object 'Int16[]' ([int]($script:NoiseMs * 16))
  $rng = New-Object System.Random($script:NoiseSeed)
  for ($i = 0; $i -lt $noiseSamples.Length; $i++) {
    $noiseSamples[$i] = [Int16]$rng.Next(-$script:NoiseAmplitude, $script:NoiseAmplitude + 1)
  }
  Write-Pcm16Wav -Path (Join-Path $OutputDir 'noise.wav') -Samples $noiseSamples -SampleRate $script:SampleRate
  $noiseInfo = Read-WavFile -Path (Join-Path $OutputDir 'noise.wav')
  Write-Run ("[gen] noise.wav  {0} ms  {1} bytes" -f $noiseInfo.DurationMs, $noiseInfo.Length)

  # 写 manifest（UTF-8 无 BOM，固定字段顺序）。
  Write-ManifestJson -Path $script:ManifestPath -VoiceName $voiceName -Definitions $script:Fixtures
  Write-Run ("[gen] manifest.json 已写入（{0} 条）" -f $script:Fixtures.Count)
} else {
  Write-Run '[gen] -CheckOnly：跳过生成，仅校验现有文件'
}

# 自检。Write-Run 已实时打印每一行（含 [check] 行），这里只处理结果。
$ok = Test-Fixtures -ManifestPath $script:ManifestPath -Definitions $script:Fixtures

if (-not $ok) {
  foreach ($err in $script:Errors) {
    Write-Host ("[FAIL] " + $err) -ForegroundColor Red
  }
  Write-Host ("[check] 自检失败：{0} 项" -f $script:Errors.Count) -ForegroundColor Red
  exit 1
}

Write-Run ("[check] 全部通过：{0} 个 WAV + manifest.json" -f $script:Fixtures.Count)

if (-not $CheckOnly) {
  Write-FixturesReadme -Path $script:ReadmePath -VoiceName $voiceName -Definitions $script:Fixtures
  Write-Host ("[gen] README.md 已写入：{0}" -f (Join-Path $outputDisplay 'README.md'))
}

exit 0
