# 常驻读取 Windows 系统媒体会话（SMTC），每个间隔输出一行 JSON。
#
# 为什么是常驻而不是每次探一次：powershell.exe 启动 + WinRT 初始化约 0.8–1.2 秒，
# 每秒拉一次会吃掉一成 CPU；常驻之后单次取会话是微秒级。
#
# 输出（一条 JSON 对象，UTF-8）：
#   {"ts":1792922413000,"sessions":[{"app":"QQMusic.exe","status":"Playing",
#    "title":"今宵多珍重","artist":"崔萍","album":"今宵多珍重",
#    "pos":150.2,"dur":150.0,"canNext":true,...}]}
#   {"ts":...,"error":"..."}   取会话失败（播放器被关、系统不给权限等），下一跳继续试
#
# 写到哪由 `-Out` 决定：给了就是覆盖写那个文件（Core 轮询 mtime），
# 不给就是每行一条写 stdout（排障用）。
#
# 生产由 conhost.exe --headless 托管（见 src/nowplaying.ts）；
# 不要单独拿去当守护进程用。

param(
  [int]$IntervalMs = 1000,
  # Core 进程的 pid。Core 被强杀（计划内重启、崩溃）时子进程不会跟着退，
  # 不查这个就会留下一个永远占着每秒一次的僵尸读取进程。
  [int]$ParentPid = 0,
  # 只跑这么多跳就退，0 = 常驻。给排障用（`-MaxTicks 3` 看一眼现在读到了什么），
  # 扩展从来不传它。
  #
  # 名字里带 Max 不是啰嗦：PowerShell 变量名不区分大小写，叫 $Ticks 就会和下面
  # 每秒自增的计数器 $ticks 变成同一个变量——第一跳刚跑完，`$Ticks -gt 0` 就成立了，
  # 脚本于是安静退出，桥每 30 秒重启它一次。（2026-10-26 当场踩到，生产环境同一条路。）
  [int]$MaxTicks = 0,
  # 写文件的绝对路径。给了就是**文件模式**，不给就是**管道模式**（写 stdout）。
  #
  # 为什么要有文件模式：管道模式必须由 Core 直接 spawn，而 Windows 11 把默认终端
  # 设成 Windows Terminal 时，任何申请控制台的子进程都会被它用 COM 接管并开出标签页 ——
  # Node 的 `windowsHide` 和 PowerShell 的 `-WindowStyle Hidden` 都拦不住那一层。
  # 结果是每秒轮询的常驻进程在屏幕上（或任务栏里）留一个黑窗口，自己用能忍，给别人用不行。
  #
  # 改成写文件之后，常驻进程由 conhost.exe --headless 托管（ConPTY 的背面无窗口），
  # 不触发 Windows Terminal 的委托 —— 这才是彻底没有窗口，而不是把窗口藏起来。
  # 路径仍然由调用方给绝对值：多一层进程就多一层环境差异，别指望两边 $env:TEMP 一致
  # （probe.ps1 第 12 行的注释记着这个坑，当年就是这么丢的数据）。
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

# 管道另一头是 Node，读的是 UTF-8。不设这个，中文歌名会变成问号。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

$script:outPath = $Out

# 常驻读取进程由 conhost.exe --headless 托管，那个宿主窗口是不存在的（不是隐藏，
# 是压根没有）——所以它不是 Windows 上一个可见的「终端」，只是 ConPTY 的背面。
# 好处是不经过 Windows Terminal 的委托，不会开标签页、不会把已有终端窗口抢到前台。
# 代价是 Core 拿到的是 conhost 的 pid，不是本进程的：
#   判活只看 conhost 是不准的（conhost 可以活着而里面这个已经死了），
#   收尸也会杀错对象，所以 pid 必须由本进程自己交出去。
# 写失败不致命：Core 那边拿不到 pid 只是判活退回看文件 mtime，功能不受影响。
if ($script:outPath) {
  try {
    [System.IO.File]::WriteAllText("$($script:outPath).pid", [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

$script:outWarned = 0

function Write-Line($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4

  # 管道模式（排障：`-MaxTicks 3` 手动跑，直接看屏幕）。
  if (-not $script:outPath) {
    # 管道另一头没了还继续跑，就是僵尸；写失败直接退。
    try {
      [Console]::Out.WriteLine($json)
      [Console]::Out.Flush()
    } catch {
      exit 0
    }
    return
  }

  # 文件模式：**原地覆盖写，不删不搬。**
  # 删了再改名（tmp → 正式）在 Windows 上行不通：读者正开着文件时删不掉，
  # 重试几次仍失败就整轮跳过，表现是「进程活着、CPU 为 0、文件不再更新」。
  # probe.ps1 已经踩过一次，这里照它的做法：一次写完一条一百多字节的 JSON，
  # 读者最多读到半截，下一跳就补上 —— 比停死强。
  # FileShare 必须放开读写和删除，否则读者开着的时候写不进去。
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $fs = $null
    try {
      $fs = [System.IO.File]::Open($script:outPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, $share)
      $fs.Write($bytes, 0, $bytes.Length)
      $fs.Flush()
      $fs.Close()
      return
    } catch {
      if ($null -ne $fs) { try { $fs.Close() } catch { } }
      if ($attempt -lt 3) { Start-Sleep -Milliseconds 30 }
    }
  }

  # 三次都没写进去：目录被清了、或者没权限。
  # **不退出。** 该不该收工由父进程决定（Test-ParentAlive 每 10 跳查一次），
  # 环境出问题让 Core 的看门狗去判 —— 我这边一退，Core 会当成崩溃走退避重连，
  # 反而把"写不进文件"伪装成"进程不稳定"。
  $script:outWarned++
  if ($script:outWarned -le 3 -or ($script:outWarned % 100) -eq 0) {
    Trace ("写文件失败 " + $script:outWarned + " 次: " + $script:outPath)
  }
}

# 排障追踪：只在环境变量 NP_TRACE 指向一个文件时启用，正常跑一行也不写。
# 加这个是因为 2026-10-26 遇到"脚本输出两三行就没了、桥每 30 秒重启一次"，
# 光看管道只能知道它停了，不知道停在哪一步。
function Trace($msg) {
  if (-not $env:NP_TRACE) { return }
  try {
    Add-Content -Path $env:NP_TRACE -Value ("[" + (Get-Date -Format 'HH:mm:ss.fff') + "] " + $msg) -Encoding UTF8
  } catch { }
}

# 父进程没了就退。管道被关掉时写也会抛，两种都要当成"该走了"。
function Test-ParentAlive {
  if ($ParentPid -le 0) { return $true }
  try {
    $null = [System.Diagnostics.Process]::GetProcessById($ParentPid)
    return $true
  } catch {
    return $false
  }
}

# ── 兜底：读窗口标题 ────────────────────────────────────────────────
#
# 网易云 3.1.42 的启动参数里写死了
#   --disable-features=...,HardwareMediaKeyHandling,...,MediaSessionService,...
# 它压根不向 Windows SMTC 注册会话，GetSessions() 里连影子都没有。
# 2026-10-26 实测：进程在放《喜洋洋（民乐合奏曲）》，系统会话数 = 0，
# 于是扩展一秒一秒地读到空数组，安静得像没装。QQ音乐那条路没这问题。
#
# 退路是它主窗口的标题，格式就是「歌名 - 歌手」。代价两条，都得认：
#   ① 拿不到 pos/dur —— 段落感没有了，世界层会走"位置未知"那条路（表情和保底动作都在）；
#   ② 分不清暂停 —— 靠 CPU 时间增量猜。真在解码时每秒至少几毫秒，停住了只剩界面动画。
#      猜错的后果是"暂停后多陪聊一两句"，比一句话都不说强得多。
$script:fbTitle = ''
$script:fbCpu = 0
$script:fbCpuAt = 0
$script:fbQuiet = 0

# 枚举进程的顶层窗口，拿「类名 \t 标题」。
#
# 为什么不能只用 Get-Process 的 MainWindowTitle：
# 2026-10-26 实测，网易云开着桌面歌词时，它的"主窗口"会变成 DesktopLyrics|桌面歌词，
# MainWindowTitle 返回的就是「桌面歌词」——于是她以为你在听一首叫《桌面歌词》的歌，
# 歌手空着，段评论和表情全按一首幽灵曲目走。这个错误不报错，只是悄悄错。
# 歌名其实在另一个窗口上：class=OrpheusBrowserHost，标题才是「歌名 - 歌手」，
# 而它偏偏不是"主窗口"，所以只能自己枚举。
if (-not ('CnbgWinTitle' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CnbgWinTitle {
  delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Proc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] Pairs(int[] pids) {
    var res = new List<string>();
    var set = new HashSet<uint>();
    foreach (int p in pids) { set.Add((uint)p); }
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p)) {
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        if (sb.Length > 0) {
          var cn = new StringBuilder(256); GetClassName(h, cn, 256);
          res.Add(cn.ToString() + (char)9 + sb.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return res.ToArray();
  }
}
"@
}

# 从一堆窗口里挑最像"正在放的歌"的那个标题。挑不到就返回空串。
function Get-SongWindowTitle {
  $procs = @(Get-Process cloudmusic -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return '' }
  $pairs = [CnbgWinTitle]::Pairs([int[]]($procs | ForEach-Object { $_.Id }))

  $best = ''
  $bestScore = 0
  foreach ($pair in $pairs) {
    $tab = $pair.IndexOf([char]9)
    if ($tab -lt 0) { continue }
    $cls = $pair.Substring(0, $tab)
    $text = $pair.Substring($tab + 1)
    # 输入法、搜索提示这类窗口的标题跟歌没关系。
    switch ($cls) {
      'IME' { continue }
      'MSCTFIME UI' { continue }
      'SoPY_Hint' { continue }
      'Sogou_TSF_UI' { continue }
      'GDI+ Hook Window Class' { continue }
    }
    # 固定标题的辅助窗口：桌面歌词窗体、迷你播放器、应用名本身。
    # 桌面歌词排第一是因为它最容易抢到"主窗口"的位置。
    if ($text -match '^(桌面歌词|迷你播放器|网易云音乐|CloudMusic|NetEase Cloud Music|HintWnd|Default IME)') { continue }

    $score = 0
    if ($cls -eq 'OrpheusBrowserHost') { $score += 100 }
    if ($text -match '\s+[-\u2013\u2014]\s+') { $score += 10 }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $text }
  }
  return $best
}

function Get-TitleFallbackSession {
  $procs = @(Get-Process cloudmusic -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return $null }

  $raw = (Get-SongWindowTitle -replace '\s+', ' ').Trim()
  # 没歌在放的时候标题就是应用名本身，这种不能当成一首歌报出去。
  if (-not $raw) { return $null }
  if ($raw -match '^(网易云音乐|CloudMusic|NetEase Cloud Music)$') { return $null }

  # 歌名和歌手之间是「 - 」，破折号有全角有半角，两边留空格才算分隔符。
  # 只切一刀：歌名里带「 - 」的情况比歌手名里多。
  $parts = $raw -split '\s+[-\u2013\u2014]\s+', 2
  $title = $parts[0].Trim()
  if (-not $title) { return $null }
  $artist = ''
  if ($parts.Count -gt 1) { $artist = $parts[1].Trim() }

  # 暂停判定：标题没变的情况下看进程吃了多少 CPU。
  #
  # 这个信号很糙，2026-10-26 实测过：网易云正常播放时，单秒采样有一半是 0ms
  # （TotalProcessorTime 的更新粒度约 15.6ms，一秒内经常读到同一个值），
  # 偶尔才跳 15–60ms。所以窗口必须拉长、阈值必须压低：
  #   · 5 秒窗口 + 3ms/s 会把"正在放的长曲"判成暂停 —— 于是 playedMs 不涨、
  #     段游标永远追不上，她一句话都不说。实测第一段晚了 50 秒，就是这个原因。
  #     正好是这次要修的症状，不能自己再造一遍。
  #   · 30 秒窗口里，播放中累计能到 150–250ms（约 5–8ms/s），阈值 0.3 留了十几倍余量；
  #     真暂停时界面静止，30 秒通常连 6ms 都不到。
  # 判错的代价不对称：多陪聊一两句是轻的，整首歌不出声是重的。所以往"猜它在放"那边偏。
  # CPU 时间跨实例求和：解码在主进程里做，另外几个是 GPU/渲染子进程。
  # 求和之后"播放中"的总增量比单看主进程更稳，暂停时一样会平。
  $cpu = 0.0
  foreach ($p in $procs) {
    try { $cpu += $p.TotalProcessorTime.TotalMilliseconds } catch { }
  }
  $now = [DateTime]::UtcNow
  $status = 'Playing'

  if ($script:fbTitle -ne $raw) {
    # 换歌了。新的一首肯定在放，基准跟着重置。
    $script:fbTitle = $raw
    $script:fbCpu = $cpu
    $script:fbCpuAt = $now
    $script:fbQuiet = 0
  } else {
    $dt = ($now - $script:fbCpuAt).TotalSeconds
    if ($dt -ge 30) {
      $rate = ($cpu - $script:fbCpu) / $dt
      if ($rate -lt 0.3) { $script:fbQuiet++ } else { $script:fbQuiet = 0 }
      $script:fbCpu = $cpu
      $script:fbCpuAt = $now
    }
    if ($script:fbQuiet -ge 1) { $status = 'Paused' }
  }

  return [ordered]@{
    app     = 'cloudmusic.exe'
    # 标出来源：这条不是系统媒体会话，是窗口标题合成的。
    # 世界层靠它给设置页显示"数据源"，也靠它决定要不要说"进度未知"。
    via     = 'title'
    status  = $status
    title   = $title
    artist  = $artist
    album   = ''
    pos     = $null
    dur     = $null
    canPlay = $true
    canPause = $true
    canNext = $false
    canPrev = $false
  }
}

$manager = $null
$sinceRestart = 0
$ticks = 0

while ($true) {
  $started = [DateTime]::UtcNow

  $ticks++
  Trace ("tick " + $ticks + " 开始")
  if (($ticks % 10) -eq 1 -and -not (Test-ParentAlive)) { exit 0 }

  try {
    if ($null -eq $manager) {
      $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }

    $list = @()
    foreach ($s in $manager.GetSessions()) {
      $row = [ordered]@{
        app    = $s.SourceAppUserModelId
        status = "$($s.GetPlaybackInfo().PlaybackStatus)"
      }
      try {
        $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
        $row.title = $p.Title
        $row.artist = $p.Artist
        $row.album = $p.AlbumTitle
      } catch {
        $row.title = ''
        $row.artist = ''
        $row.album = ''
      }
      try {
        $ctrl = $s.GetPlaybackInfo().Controls
        $row.canPlay = [bool]$ctrl.IsPlayEnabled
        $row.canPause = [bool]$ctrl.IsPauseEnabled
        $row.canNext = [bool]$ctrl.IsNextEnabled
        $row.canPrev = [bool]$ctrl.IsPreviousEnabled
      } catch {
        $row.canPlay = $false; $row.canPause = $false; $row.canNext = $false; $row.canPrev = $false
      }
      try {
        $tl = $s.GetTimelineProperties()
        $row.pos = [math]::Round($tl.Position.TotalSeconds, 1)
        $row.dur = [math]::Round($tl.EndTime.TotalSeconds, 1)
      } catch {
        $row.pos = $null
        $row.dur = $null
      }
      $list += $row
    }

    # 网易云不注册 SMTC，系统里读不到它的会话，这里补一条窗口标题合成的。
    # 有真会话时不用兜底 —— 真会话有 pos/dur，段落感和表情都靠它。
    Trace ("SMTC 会话 " + @($list).Count + " 条")
    if (-not ($list | Where-Object { $_.app -match 'cloudmusic' })) {
      $fb = Get-TitleFallbackSession
      if ($null -ne $fb) { $list += $fb }
      Trace ("兜底后 " + @($list).Count + " 条")
    }

    Write-Line ([ordered]@{
        ts       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        sessions = $list
      })
    Trace "已写出"
    $sinceRestart = 0
  } catch {
    Trace ("异常: " + $_.Exception.GetType().Name + " :: " + $_.Exception.Message)
    Write-Line ([ordered]@{
        ts    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        error = "$($_.Exception.Message)"
      })
    # 会话管理器失效（系统组件重启、播放器进程换掉）时重建一次，别死在一个坏对象上。
    $manager = $null
    $sinceRestart++
    if ($sinceRestart -gt 5) { Start-Sleep -Milliseconds 2000; $sinceRestart = 0 }
  }

  $elapsed = ([DateTime]::UtcNow - $started).TotalMilliseconds
  $wait = $IntervalMs - [int]$elapsed
  if ($wait -lt 50) { $wait = 50 }
  Trace ("tick " + $ticks + " 睡 " + $wait + "ms")
  Start-Sleep -Milliseconds $wait

  # 排障模式（扩展不传 -MaxTicks，常驻不受影响）。
  if ($MaxTicks -gt 0 -and $ticks -ge $MaxTicks) { Trace "到达跳数上限，退出"; exit 0 }
}
