<#
  安装「本地深听」环境（约 500MB，全程不联网上传你的音乐）。

  用法（普通权限的 PowerShell 里跑，不需要管理员）：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-hearing.ps1

  它会做四件事：
    1. 在 %LOCALAPPDATA%\CoopaniMusic\hearing 建一个 Python 虚拟环境（用系统里现成的 Python 3.10+）
    2. 装 numpy / scipy / soundfile / onnxruntime / demucs-onnx
    3. 预下载六轨分离模型 htdemucs_6s（约 136MB）
    4. 下载乐器分类模型（约 91MB）

  装完回设置页：一起听歌 → 深听方式 → 选「本地」。
  想装到别处：-Root D:\somewhere\hearing，然后把环境变量 COOPANI_HEARING_HOME 指到那里。
#>
param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'CoopaniMusic\hearing'),
  [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS 5.1 的进度条会让下载慢十倍

function Say($msg) { Write-Host "[深听] $msg" }

function Find-Python {
  if ($Python) {
    if (-not (Test-Path $Python)) { throw "指定的 Python 不存在：$Python" }
    return @{ Exe = $Python; Args = @() }
  }
  foreach ($cand in @(
    @{ Exe = 'py';      Args = @('-3') },
    @{ Exe = 'python';  Args = @() },
    @{ Exe = 'python3'; Args = @() }
  )) {
    try {
      $out = & $cand.Exe @($cand.Args + @('-c', 'import sys; print(sys.version_info[0], sys.version_info[1])')) 2>$null
      if ($LASTEXITCODE -eq 0 -and $out) {
        $parts = "$out".Trim().Split(' ')
        if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) { return $cand }
      }
    } catch { }
  }
  throw '找不到 Python 3.10+。先装一个（python.org 或 Microsoft Store 都行），再重跑这条命令。'
}

$py = Find-Python
Say "用 $($py.Exe) $($py.Args -join ' ') 建环境，目标目录 $Root"
New-Item -ItemType Directory -Force -Path $Root | Out-Null

$venv = Join-Path $Root 'venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Say '建虚拟环境…'
  & $py.Exe @($py.Args + @('-m', 'venv', $venv))
  if ($LASTEXITCODE -ne 0) { throw "建虚拟环境失败（退出码 $LASTEXITCODE）" }
} else {
  Say '虚拟环境已经在了，跳过。'
}

Say '装依赖（几分钟，别关窗口）…'
& $venvPy -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) { throw 'pip 升级失败' }
& $venvPy -m pip install numpy scipy soundfile onnxruntime demucs-onnx --quiet
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，往上翻看 pip 的报错' }

$models = Join-Path $Root 'models'
$cache = Join-Path $models 'demucs'
New-Item -ItemType Directory -Force -Path $models | Out-Null

Say '预下载六轨分离模型 htdemucs_6s（约 136MB）…'
$prewarm = Join-Path $venv 'Scripts\demucs-onnx.exe'
& $prewarm prewarm --models htdemucs_6s --precision fp16weights --cache-dir $cache
if ($LASTEXITCODE -ne 0) { throw '分离模型下载失败（网络？）' }

$instModel = Join-Path $models 'instrument-classification.onnx'
$instCfg = Join-Path $models 'instrument-config.json'
if (-not (Test-Path $instModel)) {
  Say '下载乐器分类模型（约 91MB）…'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/onnx-community/Musical-Instrument-Classification-ONNX/resolve/main/onnx/model_quantized.onnx' -OutFile $instModel
}
if (-not (Test-Path $instCfg)) {
  Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/onnx-community/Musical-Instrument-Classification-ONNX/resolve/main/config.json' -OutFile $instCfg
}

$size = [math]::Round(((Get-ChildItem $Root -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 0)
Say "装好了，占用约 $size MB。"
Say "分析器：$venvPy"
Say '回设置页 → 一起听歌 → 深听方式，选「本地」；然后重启一次 Core。'
Say '（如果换过安装位置，先设 COOPANI_HEARING_HOME 指到这个目录。）'
