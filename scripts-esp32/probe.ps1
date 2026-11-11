#requires -Version 7.0
<#
.SYNOPSIS
    小智 ESP32 第五通道 T01 环境探活：DSH 在线、dsh-feiyu 已加载、GPT-SoVITS 可合成。

.DESCRIPTION
    依次检查：
      1) DSH 桌面版 Web 宿主是否在线（动态端口，127.0.0.1），未鉴权请求应返回 401；
      2) dsh-feiyu 是否安装并挂载到 desktop profile（link 依赖、bundles、junction、
         ~/.dsh/feiyu-night.json 运行标记）；
      3) GPT-SoVITS 9880 是否可达，并在有参考音时做一次真实 /tts 合成。

    本脚本不会读取、打印或保存 DSH 的访问 token / cookie。
    退出码：0=全部 PASS；1=存在 FAIL；2=无 FAIL 但有 BLOCKED（需人工处理）。

.PARAMETER DshInstallDir
    DSH 桌面版安装目录，默认 D:\DSH桌面版。

.PARAMETER ProfileDir
    DSH desktop profile 目录，默认 %USERPROFILE%\.dsh\profiles\desktop。

.PARAMETER DshHome
    DSH 数据目录，默认 %USERPROFILE%\.dsh。

.PARAMETER SovitsRoot
    GPT-SoVITS 根目录，默认 D:\GPT-SoVITS（用于自动找参考音）。

.PARAMETER SovitsUrl
    GPT-SoVITS api_v2 地址，默认 http://127.0.0.1:9880。

.PARAMETER RefAudio
    参考音频路径；不传则读 ~/.dsh/feiyu.config.json 的 voice.ref_audio_path，
    再从 <SovitsRoot>\models\<音色>\ 里找 .wav + 同名 .txt。

.PARAMETER PromptText
    参考音频对应的文本；不传则读同名 .txt。

.PARAMETER SynthText
    合成测试文本，默认“你好，我是小智，语音合成测试。”。

.PARAMETER SkipSynthesis
    只探端口/HTTP，不做真实 /tts 合成。

.EXAMPLE
    pwsh -File .\probe.ps1

.EXAMPLE
    pwsh -File .\probe.ps1 -RefAudio 'D:\GPT-SoVITS\models\yinlang\yinlang.wav' -PromptText '参考音的原话'
#>
[CmdletBinding()]
param(
    [string]$DshInstallDir = 'D:\DSH桌面版',
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$SovitsRoot = 'D:\GPT-SoVITS',
    [string]$SovitsUrl = 'http://127.0.0.1:9880',
    [string]$RefAudio = '',
    [string]$PromptText = '',
    [string]$PromptLang = 'zh',
    [string]$SynthText = '你好，我是小智，语音合成测试。',
    [string]$TextLang = 'zh',
    [switch]$SkipSynthesis
)

$ErrorActionPreference = 'Stop'

$script:checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [string]$Status, [string]$Detail)
    $script:checks.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
    $color = switch ($Status) {
        'PASS' { 'Green' }
        'BLOCKED' { 'Yellow' }
        'FAIL' { 'Red' }
        'WARN' { 'Yellow' }
        default { 'Gray' }
    }
    Write-Host ("[{0}] {1}：{2}" -f $Status, $Name, $Detail) -ForegroundColor $color
}

function Get-HttpStatus {
    param([string]$Url, [int]$TimeoutSec = 6)
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return [int]$response.StatusCode
    }
    catch {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return $null
    }
}

function Get-DshHostProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match 'dsh-desktop-host' -and
            $_.CommandLine -match 'lib[\\/]index\.js'
        } |
        Select-Object -First 1
}

function Get-DshWebPort {
    param([int]$HostProcessId, [int]$ExcludePort = 8765)
    # 宿主进程同时监听 DSH 自己的 HTTP 与 feiyu 的 ESP32 网关（默认 8765），
    # 不能随便取第一个 loopback 端口。先排除网关端口，再按 HTTP 探活挑出
    # 真正回 200/401/403 的那个（DSH 对未鉴权请求回 401）。
    $candidates = Get-NetTCPConnection -State Listen -OwningProcess $HostProcessId -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') -and $_.LocalPort -ne $ExcludePort } |
        Select-Object -ExpandProperty LocalPort -Unique
    if (-not $candidates) { return $null }
    foreach ($port in $candidates) {
        $status = Get-HttpStatus -Url "http://127.0.0.1:$port/" -TimeoutSec 2
        if ($status -in @(200, 401, 403)) { return [int]$port }
    }
    return [int]($candidates | Select-Object -First 1)
}

Write-Host '=== 小智 ESP32 第五通道 · T01 环境探活 ===' -ForegroundColor Cyan
Write-Host "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ''

# ---------------------------------------------------------------- DSH 在线
$dshHostProcess = Get-DshHostProcess
$dshPort = $null
$dshOnline = $false

if ($null -eq $dshHostProcess) {
    if (Test-Path -LiteralPath (Join-Path $DshInstallDir 'DeepSeek Harness.exe')) {
        Add-Check 'DSH 在线' 'FAIL' '未发现 Web 宿主进程；请先运行 start-dsh.ps1'
    }
    else {
        Add-Check 'DSH 在线' 'FAIL' "未找到安装目录 $DshInstallDir，且未发现 Web 宿主进程"
    }
}
else {
    $dshPort = Get-DshWebPort -HostProcessId $dshHostProcess.ProcessId
    if ($null -eq $dshPort) {
        Add-Check 'DSH 在线' 'FAIL' "Web 宿主 PID=$($dshHostProcess.ProcessId) 未监听 127.0.0.1 端口"
    }
    else {
        $rootStatus = Get-HttpStatus -Url "http://127.0.0.1:$dshPort/"
        if ($rootStatus -eq 401) {
            Add-Check 'DSH 在线' 'PASS' "宿主 PID=$($dshHostProcess.ProcessId)，端口=$dshPort；未鉴权请求返回 401（符合预期）"
            $dshOnline = $true
        }
        elseif ($rootStatus -eq 200) {
            Add-Check 'DSH 在线' 'PASS' "宿主 PID=$($dshHostProcess.ProcessId)，端口=$dshPort；根路径返回 200"
            $dshOnline = $true
        }
        elseif ($null -eq $rootStatus) {
            Add-Check 'DSH 在线' 'FAIL' "宿主 PID=$($dshHostProcess.ProcessId)，端口=$dshPort，但 HTTP 连接失败"
        }
        else {
            Add-Check 'DSH 在线' 'FAIL' "宿主 PID=$($dshHostProcess.ProcessId)，端口=$dshPort，根路径返回 HTTP $rootStatus"
        }
    }
}

if ($null -ne $dshPort) {
    $apiStatus = Get-HttpStatus -Url "http://127.0.0.1:$dshPort/dsh-feiyu/api/status"
    if ($apiStatus -eq 401) {
        Add-Check 'dsh-feiyu 路由' 'PASS' '/dsh-feiyu/api/status 返回 401（鉴权拦截；外部脚本无 token，不能直接调用）'
    }
    elseif ($apiStatus -eq 200) {
        Add-Check 'dsh-feiyu 路由' 'WARN' '/dsh-feiyu/api/status 未鉴权即可访问（请确认是否符合预期）'
    }
    elseif ($null -eq $apiStatus) {
        Add-Check 'dsh-feiyu 路由' 'FAIL' '/dsh-feiyu/api/status 连接失败'
    }
    else {
        Add-Check 'dsh-feiyu 路由' 'FAIL' "/dsh-feiyu/api/status 返回 HTTP $apiStatus（预期 401）"
    }
}
else {
    Add-Check 'dsh-feiyu 路由' 'FAIL' '没有 DSH 端口，无法探测 /dsh-feiyu/api/status'
}

# ------------------------------------------------------------ 插件安装/挂载
$packagePath = Join-Path $ProfileDir 'package.json'
$linkOk = $false
$bundleOk = $false
$junctionOk = $false
$markerOk = $false
$markerDetail = '未找到运行标记'

if (-not (Test-Path -LiteralPath $packagePath)) {
    Add-Check 'dsh-feiyu 安装' 'FAIL' "缺少 profile 清单：$packagePath"
}
else {
    try {
        $profilePackage = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $dependency = $profilePackage.dependencies.'dsh-feiyu'
        $linkOk = ($dependency -is [string]) -and $dependency.StartsWith('link:')
        $bundles = @($profilePackage.dsh.profile.bundles)
        $bundleOk = $bundles -contains 'dsh-feiyu'
        Add-Check 'dsh-feiyu 安装' $(if ($linkOk -and $bundleOk) { 'PASS' } else { 'FAIL' }) `
            "依赖=$dependency；bundles 含 dsh-feiyu=$bundleOk"
    }
    catch {
        Add-Check 'dsh-feiyu 安装' 'FAIL' "profile package.json 解析失败：$($_.Exception.Message)"
    }
}

$junctionPath = Join-Path $ProfileDir 'node_modules\dsh-feiyu'
try {
    $junction = Get-Item -LiteralPath $junctionPath -Force -ErrorAction Stop
    $junctionOk = ($junction.LinkType -eq 'Junction') -or ($junction.LinkType -eq 'SymbolicLink')
    Add-Check 'dsh-feiyu 链接' $(if ($junctionOk) { 'PASS' } else { 'FAIL' }) `
        "LinkType=$($junction.LinkType)；Target=$($junction.Target)"
}
catch {
    Add-Check 'dsh-feiyu 链接' 'FAIL' "缺少 node_modules 链接：$junctionPath"
}

$nightPath = Join-Path $DshHome 'feiyu-night.json'
$workPath = Join-Path $DshHome 'feiyu-work'
if (-not (Test-Path -LiteralPath $nightPath)) {
    $markerDetail = "缺少运行标记 $nightPath"
}
else {
    try {
        $night = Get-Content -LiteralPath $nightPath -Raw -Encoding UTF8 | ConvertFrom-Json
        # PowerShell 7.6 的 ConvertFrom-Json 会把 ISO 时间转成 DateTime；
        # 直接 Parse 会丢失 Z/UTC 语义，这里用类型转换保留 Kind/Offset。
        $createdAt = [datetimeoffset]$night.createdAt
        $lastWriteUtc = (Get-Item -LiteralPath $nightPath).LastWriteTimeUtc
        $workOk = Test-Path -LiteralPath $workPath

        $hostStartUtc = $null
        if ($null -ne $dshHostProcess) {
            try { $hostStartUtc = (Get-Process -Id $dshHostProcess.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime() }
            catch { $hostStartUtc = $null }
        }

        if ($null -ne $hostStartUtc) {
            $markerOk = ($lastWriteUtc -ge $hostStartUtc.AddSeconds(-5)) -or ($createdAt.UtcDateTime -ge $hostStartUtc.AddSeconds(-30))
            $markerDetail = "createdAt=$($createdAt.ToString('u'))；文件更新=$($lastWriteUtc.ToString('u'))；宿主启动=$($hostStartUtc.ToString('u'))；feiyu-work=$workOk"
        }
        else {
            $markerOk = $workOk
            $markerDetail = "createdAt=$($night.createdAt)；文件更新=$($lastWriteUtc.ToString('u'))；无法读取宿主启动时间；feiyu-work=$workOk"
        }

        Add-Check 'dsh-feiyu 运行标记' $(if ($markerOk) { 'PASS' } else { 'FAIL' }) $markerDetail
    }
    catch {
        Add-Check 'dsh-feiyu 运行标记' 'FAIL' "feiyu-night.json 解析失败：$($_.Exception.Message)"
    }
}

# ------------------------------------------------------------- GPT-SoVITS
$sovitsUri = [Uri]$SovitsUrl
$sovitsHost = $sovitsUri.Host
$sovitsPort = $sovitsUri.Port
$sovitsListener = Get-NetTCPConnection -LocalPort $sovitsPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
$sovitsReachable = $false

if ($null -eq $sovitsListener) {
    Add-Check 'GPT-SoVITS' 'BLOCKED' "127.0.0.1:$sovitsPort 无监听；本机未安装/未启动 GPT-SoVITS（见 env.md）"
}
else {
    $docsStatus = Get-HttpStatus -Url "$SovitsUrl/docs"
    if ($docsStatus -eq 200) {
        Add-Check 'GPT-SoVITS' 'PASS' "$SovitsUrl/docs 返回 200（监听 PID=$($sovitsListener.OwningProcess)）"
        $sovitsReachable = $true
    }
    elseif ($null -ne $docsStatus) {
        Add-Check 'GPT-SoVITS' 'WARN' "$SovitsUrl/docs 返回 HTTP $docsStatus（端口有服务，但 /docs 非 200）"
        $sovitsReachable = $true
    }
    else {
        Add-Check 'GPT-SoVITS' 'FAIL' "端口 $sovitsPort 在监听，但 HTTP 连接失败（PID=$($sovitsListener.OwningProcess)）"
    }
}

if ($SkipSynthesis) {
    Add-Check 'GPT-SoVITS 合成' 'SKIP' '按 -SkipSynthesis 跳过真实 /tts'
}
elseif (-not $sovitsReachable) {
    Add-Check 'GPT-SoVITS 合成' 'BLOCKED' '服务不可达，无法做真实合成'
}
else {
    $resolvedRefAudio = $RefAudio
    $resolvedPromptText = $PromptText

    $feiyuConfigPath = Join-Path $DshHome 'feiyu.config.json'
    if ([string]::IsNullOrWhiteSpace($resolvedRefAudio) -and (Test-Path -LiteralPath $feiyuConfigPath)) {
        try {
            $feiyuConfig = Get-Content -LiteralPath $feiyuConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace($feiyuConfig.voice.ref_audio_path)) {
                $resolvedRefAudio = $feiyuConfig.voice.ref_audio_path
            }
            if ([string]::IsNullOrWhiteSpace($resolvedPromptText) -and -not [string]::IsNullOrWhiteSpace($feiyuConfig.voice.prompt_text)) {
                $resolvedPromptText = $feiyuConfig.voice.prompt_text
            }
        }
        catch { }
    }

    if ([string]::IsNullOrWhiteSpace($resolvedRefAudio)) {
        $modelsDir = Join-Path $SovitsRoot 'models'
        if (Test-Path -LiteralPath $modelsDir) {
            $candidate = Get-ChildItem -LiteralPath $modelsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                $wav = Get-ChildItem -LiteralPath $_.FullName -Filter '*.wav' -File -ErrorAction SilentlyContinue |
                    Sort-Object Length -Descending | Select-Object -First 1
                if ($null -ne $wav) {
                    $txt = [IO.Path]::ChangeExtension($wav.FullName, '.txt')
                    if (Test-Path -LiteralPath $txt) {
                        [pscustomobject]@{ Wav = $wav.FullName; Txt = $txt }
                    }
                }
            } | Select-Object -First 1
            if ($null -ne $candidate) {
                $resolvedRefAudio = $candidate.Wav
                if ([string]::IsNullOrWhiteSpace($resolvedPromptText)) {
                    $resolvedPromptText = (Get-Content -LiteralPath $candidate.Txt -Raw -Encoding UTF8).Trim()
                }
            }
        }
    }
    elseif ([string]::IsNullOrWhiteSpace($resolvedPromptText)) {
        $sameNameTxt = [IO.Path]::ChangeExtension($resolvedRefAudio, '.txt')
        if (Test-Path -LiteralPath $sameNameTxt) {
            $resolvedPromptText = (Get-Content -LiteralPath $sameNameTxt -Raw -Encoding UTF8).Trim()
        }
    }

    if ([string]::IsNullOrWhiteSpace($resolvedRefAudio) -or -not (Test-Path -LiteralPath $resolvedRefAudio)) {
        Add-Check 'GPT-SoVITS 合成' 'BLOCKED' "缺少参考音频（-RefAudio 或 $SovitsRoot\models\<音色>\*.wav + .txt）"
    }
    elseif ([string]::IsNullOrWhiteSpace($resolvedPromptText)) {
        Add-Check 'GPT-SoVITS 合成' 'BLOCKED' "缺少参考文本（-PromptText 或与参考音同名的 .txt）"
    }
    else {
        $requestBody = @{
            text = $SynthText
            text_lang = $TextLang
            ref_audio_path = ($resolvedRefAudio -replace '\\', '/')
            prompt_text = $resolvedPromptText
            prompt_lang = $PromptLang
            text_split_method = 'cut5'
            batch_size = 1
            media_type = 'wav'
            streaming_mode = $false
        } | ConvertTo-Json -Depth 6

        $tempWav = Join-Path $env:TEMP ("probe-tts-" + [Guid]::NewGuid().ToString('N') + '.wav')
        try {
            $response = Invoke-WebRequest -Uri "$SovitsUrl/tts" -Method Post `
                -ContentType 'application/json; charset=utf-8' `
                -Body ([Text.Encoding]::UTF8.GetBytes($requestBody)) `
                -OutFile $tempWav -PassThru -SkipHttpErrorCheck -TimeoutSec 120

            $statusCode = [int]$response.StatusCode
            if ($statusCode -ne 200) {
                $errorText = ''
                try { $errorText = [string]$response.Content } catch { }
                if ($errorText.Length -gt 300) { $errorText = $errorText.Substring(0, 300) }
                Add-Check 'GPT-SoVITS 合成' 'FAIL' "POST /tts 返回 HTTP $statusCode；$errorText"
            }
            else {
                $wavInfo = Get-Item -LiteralPath $tempWav -ErrorAction Stop
                $headerOk = $false
                if ($wavInfo.Length -ge 44) {
                    $stream = [IO.File]::OpenRead($tempWav)
                    try {
                        $header = New-Object byte[] 12
                        [void]$stream.Read($header, 0, 12)
                        $riff = [Text.Encoding]::ASCII.GetString($header, 0, 4)
                        $wave = [Text.Encoding]::ASCII.GetString($header, 8, 4)
                        $headerOk = ($riff -eq 'RIFF') -and ($wave -eq 'WAVE')
                    }
                    finally { $stream.Dispose() }
                }
                if ($headerOk) {
                    Add-Check 'GPT-SoVITS 合成' 'PASS' "POST /tts 成功，返回 WAV $($wavInfo.Length) 字节（参考音 $resolvedRefAudio）"
                }
                else {
                    Add-Check 'GPT-SoVITS 合成' 'FAIL' "POST /tts 返回 200，但响应不是有效 WAV（$($wavInfo.Length) 字节）"
                }
            }
        }
        catch {
            Add-Check 'GPT-SoVITS 合成' 'FAIL' "POST /tts 失败：$($_.Exception.Message)"
        }
        finally {
            Remove-Item -LiteralPath $tempWav -Force -ErrorAction SilentlyContinue
        }
    }
}

# ------------------------------------------------------------------ 汇总
Write-Host ''
$passCount = @($script:checks | Where-Object { $_.Status -eq 'PASS' }).Count
$failCount = @($script:checks | Where-Object { $_.Status -eq 'FAIL' }).Count
$blockedCount = @($script:checks | Where-Object { $_.Status -eq 'BLOCKED' }).Count
$warnCount = @($script:checks | Where-Object { $_.Status -eq 'WARN' }).Count
$skipCount = @($script:checks | Where-Object { $_.Status -eq 'SKIP' }).Count

$summaryColor = if ($failCount -gt 0) { 'Red' } elseif ($blockedCount -gt 0) { 'Yellow' } else { 'Green' }
Write-Host "=== 总结：PASS=$passCount FAIL=$failCount BLOCKED=$blockedCount WARN=$warnCount SKIP=$skipCount ===" -ForegroundColor $summaryColor

if ($failCount -gt 0) {
    Write-Host '存在 FAIL 项：请按上面提示修复后重跑。' -ForegroundColor Red
    exit 1
}
if ($blockedCount -gt 0) {
    Write-Host '存在 BLOCKED 项：需要人工安装/配置后重跑（见 env.md 的“未完成/人工步骤”）。' -ForegroundColor Yellow
    exit 2
}
Write-Host '全部探活通过。' -ForegroundColor Green
exit 0
