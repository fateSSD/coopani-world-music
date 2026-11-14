/**
 * 系统媒体会话（SMTC）桥。
 *
 * Windows 10/11 上，QQ音乐、网易云音乐、Spotify 这类播放器都会把当前曲目交给系统的
 * GlobalSystemMediaTransportControlsSessionManager。Node 直接调不到 WinRT，所以由
 * scripts/nowplaying.ps1 常驻拉取、每跳写一份 JSON，这一层只负责：拉起、解析、健康度、重连。
 *
 * 设计取舍：
 * - 常驻而非逐次 spawn：powershell 启动 + WinRT 初始化约 1 秒，逐次拉会吃掉一成 CPU。
 * - 每一跳都输出（不等变化）：把"变化判定"留在 Node，PowerShell 只管取事实。
 * - 桥挂了不等于播放器挂了：health 里分开记"进程在不在"和"最后一次收到数据的时间"。
 * - **数据走文件，不走管道；宿主用 conhost --headless。**
 *   Windows 11 把默认终端设成 Windows Terminal 之后，任何「新建控制台」的子进程都会被它
 *   用 COM 接管、开出一个标签页。`windowsHide`（CREATE_NO_WINDOW）和 `-WindowStyle Hidden`
 *   都拦不住那一层：前者仍然会建控制台，后者只是把窗口挪到屏幕外（实测 (-21333,-21333)），
 *   任务栏里留着条目，而且 Terminal 新建 tab 时会把主窗口抢到前台 —— 重启一次跳一次。
 *   正解是**根本不建窗口化的控制台**：`conhost.exe --headless` 开的是 ConPTY，
 *   背面无窗口，不参与 Terminal 的委托。实测它的 `MainWindowHandle` 为 0，
 *   也不产生新的 WindowsTerminal 进程。
 *   这条路还比之前的 WMI 方案少两层（不需要 .vbs 中转、不需要 WMI 创建），
 *   而且常驻进程就是 Core 的子进程，Core 一退它跟着退，不留僵尸。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** scripts/nowplaying.ps1 的绝对路径；按本文件位置定位，与 CWD 无关。 */
export const DEFAULT_SCRIPT = fileURLToPath(new URL('../scripts/nowplaying.ps1', import.meta.url));

/**
 * 无窗口宿主：用 ConPTY 装一个控制台，背面没有窗口。
 *
 * `conhost.exe --headless <程序> <参数...>` 是 Windows 10 1809 起就有的用法
 * （OpenSSH 那条路在用）。它给被托管进程一个**没有窗口**的控制台，
 * 因此不触发 Windows Terminal 的委托 —— 这是一个「不存在的窗口」，
 * 而不是「藏起来的窗口」。
 *
 * 2026-10-31 实测：托管下的 nowplaying.ps1 正常写文件（中文完好），
 * conhost 与 OpenConsole 的 MainWindowHandle 都是 0，没有新建 WindowsTerminal。
 *
 * 有两点必须照顾到：
 * ① ConPTY 的 stdout 是管道，**不消费会把它自己堵死**（缓冲区满 → 被托管进程卡在写）。
 *    所以拿到 child 之后立刻把 stdout/stderr 读空丢弃。
 * ② Core 拿到的是 conhost 的 pid，不是读取进程的 pid。判活要看后者，
 *    由 nowplaying.ps1 自己把 $PID 写进 `<out>.pid`（见那边的注释）。
 */

/**
 * 读取进程写快照的地方。
 *
 * 路径要在这里算、再**显式**传给两边：WMI 创建出来的进程拿到的是 WmiPrvSE 的环境，
 * TEMP 和 Core 的不是同一个（probe.ps1 开头记着这个坑）。指望两边各自 `$env:TEMP`
 * 会得到两个不同的文件，表现是文件永远不更新。
 */
export const DEFAULT_OUT_FILE = join(tmpdir(), 'coopani-nowplaying.json');

/** 轮询输出文件的间隔。脚本每秒写一次，250ms 足够跟上，也不会让 stat 成为负担。 */
const POLL_MS = 250;

/** 超过这么久没有任何新数据就判定读取进程卡死。 */
const STALE_MS = 20_000;

/**
 * 首跳宽限：WMI 创建 + powershell 启动 + WinRT 初始化约 1.5–3 秒。
 * 没有这个的话，刚起来就被上面那条判死，会陷入「起来→杀掉→再起来」的循环。
 */
const STARTUP_GRACE_MS = 8_000;

/**
 * 文件里数据的时间戳超过这么久就当它是上一次运行留下的残骸，不喂给世界层。
 *
 * 为什么要有这条：Core 重启时，磁盘上可能躺着一个几小时前的快照。只看 mtime 变了
 * 就推送的话，她一开机就会收到一条"几小时前在听某首歌"，还会为它说一句话。
 * 脚本每跳都刷新 ts（暂停时也刷），所以 ts 老 = 确实没在写，不存在误杀。
 */
const STALE_PAYLOAD_MS = 30_000;

export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'closed' | 'changing' | 'unknown';

/** 一次系统会话的原始快照。title 可能为空（播放器还没把元数据交出来）。 */
export interface SessionSnapshot {
  app: string;
  /**
   * 这条会话从哪来。
   * - `smtc`：系统媒体会话，有真实进度与播放状态。
   * - `title`：脚本用主窗口标题合成的兜底（播放器不上报 SMTC 时），没有进度，暂停靠猜。
   */
  via: 'smtc' | 'title';
  status: PlaybackStatus;
  title: string;
  artist: string;
  album: string;
  posSec: number | null;
  durSec: number | null;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrev: boolean;
}

export interface TickPayload {
  ts: number;
  sessions: SessionSnapshot[];
}
export interface BridgeHealth {
  /** 常驻读取进程是否活着（以 pid 为准，不以启动器为准）。 */
  running: boolean;
  /** WMI 起的读取进程 pid；没起来或是 null。 */
  pid: number | null;
  /** 最后一次收到可解析数据的时间（epoch ms）；从没收到过是 null。 */
  lastLineAt: number | null;
  /** 重启过几次（含崩溃与卡死）。 */
  restarts: number;
  /** 最后一次错误：脚本报错、解析失败、启动失败。 */
  lastError: string | null;
  /** powershell 可用的全路径；找不到是 null。 */
  exe: string | null;
}

const STATUS_MAP: Record<string, PlaybackStatus> = {
  Playing: 'playing',
  Paused: 'paused',
  Stopped: 'stopped',
  Closed: 'closed',
  Opened: 'stopped',
  Changing: 'changing',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 把脚本的一行 JSON 解析成快照。字段缺失一律给安全默认值，绝不抛。 */
export function parseTickLine(line: string): { ts: number; sessions: SessionSnapshot[] } | { ts: number; error: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const ts = num(raw?.ts) ?? Date.now();
  if (typeof raw?.error === 'string' && raw.error) return { ts, error: raw.error };
  const list = Array.isArray(raw?.sessions) ? raw.sessions : [];
  const sessions: SessionSnapshot[] = [];
  for (const s of list) {
    const app = str(s?.app);
    if (!app) continue;
    sessions.push({
      app,
      via: str(s?.via) === 'title' ? 'title' : 'smtc',
      status: STATUS_MAP[str(s?.status)] ?? 'unknown',
      title: str(s?.title).trim(),
      artist: str(s?.artist).trim(),
      album: str(s?.album).trim(),
      posSec: num(s?.pos),
      durSec: num(s?.dur),
      canPlay: bool(s?.canPlay),
      canPause: bool(s?.canPause),
      canNext: bool(s?.canNext),
      canPrev: bool(s?.canPrev),
    });
  }
  return { ts, sessions };
}

/** 找 powershell.exe。装的是 PowerShell 7 而没 5.1 的机器极少，但设了 AppLocker 拦 5.1 的情况存在。 */
export function findPowerShell(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ].filter((v): v is string => !!v);
  for (const c of candidates) {
    if (c === 'powershell.exe') return c;
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 找 conhost.exe。
 *
 * 找不到就说明这是一台很老的 Windows（ConPTY headless 是 Windows 10 1809 起才有的），
 * 那种机器上默认终端也还不是 Windows Terminal，直接 spawn 反而没有窗口问题。
 */
export function findConHost(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'conhost.exe') : undefined,
    'C:\\Windows\\System32\\conhost.exe',
  ].filter((v): v is string => !!v);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 这个 pid 现在还有没有活着的进程。
 *
 * 只用来防一件事：**照着旧 pid 去杀，结果那个号已经被系统分配给别人了。** Windows 迟早
 * 会复用 pid，而收尸是异步的（宿主先退出、进程表后更新），中间拿着一份旧值直接杀有风险。
 * 注意它只能证明「有个进程占着这个号」，证明不了「还是原来那一个」——所以判活还得靠
 * 文件 mtime 和脚本自己写出来的 pid，别把这个函数当身份校验。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在，只是没权限动它；ESRCH = 真没了。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface BridgeOptions {
  scriptPath?: string;
  /** 读取进程写快照的绝对路径；必须和传给它的一致。 */
  outFile?: string;
  /** 采样间隔；改这个要重启脚本进程，不是热改项。 */
  intervalMs?: number;
  /** 收到一跳（已过滤掉 error 行之外的解析失败）。 */
  onTick?: (payload: TickPayload) => void;
  /** 桥的内部事件，写 core.log 用。 */
  log?: (level: 'info' | 'warn', message: string) => void;
  exe?: string;
  /** 无窗口宿主 conhost.exe 的路径；不传就自己找。 */
  conhostPath?: string;
}

export class NowPlayingBridge {
  /** 短启动器进程。它活着只说明"正在起"，不代表读取进程活着。 */
  private child: ChildProcessWithoutNullStreams | null = null;
  /** 宿主的 pid（conhost，或降级时直启的 powershell）。只用于日志，判活不看它。 */
  private hostPid: number | null = null;
  /** 读取进程的 pid，由 nowplaying.ps1 写进 `<out>.pid`。判活以它为准。 */
  private workerPid: number | null = null;
  private stopped = true;
  private restarts = 0;
  private lastLineAt: number | null = null;
  private lastError: string | null = null;
  private latest: TickPayload | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 文件最后一次被处理过的 mtime。相同就跳过，避免每秒重复解析同一份内容。 */
  private lastMtimeMs = 0;
  /** 本轮拉起的时刻，给 watchdog 一个"还没有数据"时的计时起点。 */
  private startingAt = 0;
  private readonly opts: Required<Omit<BridgeOptions, 'exe' | 'onTick' | 'conhostPath'>> & Pick<BridgeOptions, 'onTick'>;
  private exe: string | null = null;
  /** 无窗口宿主 conhost.exe；null = 这台机器没有，直接 spawn（会带窗口，但老系统本来就没这问题）。 */
  private conhost: string | null = null;
  /** 已经放弃无窗口宿主了吗（conhost 起不来时降级为直启 powershell）。 */
  private useFallback = false;

  constructor(options: BridgeOptions = {}) {
    this.opts = {
      scriptPath: options.scriptPath ?? DEFAULT_SCRIPT,
      outFile: options.outFile ?? DEFAULT_OUT_FILE,
      intervalMs: options.intervalMs ?? 1000,
      log: options.log ?? (() => {}),
      onTick: options.onTick,
    };
    this.exe = findPowerShell(options.exe);
    this.conhost = findConHost(options.conhostPath);
    if (!this.conhost) {
      this.useFallback = true;
      this.lastError = '这台机器找不到 conhost.exe，读取进程直接由 Core 拉起——Windows 11 上可能带出一个终端标签页。';
    }
  }

  /** 最近一次成功的采样。桥刚起或卡住时为 null。 */
  snapshot(): TickPayload | null {
    return this.latest;
  }

  health(): BridgeHealth {
    let alive = false;
    if (this.workerPid !== null) {
      try {
        // 信号 0 只探活，不投递。进程被别人（父进程看门狗）收走了这里就会抛。
        process.kill(this.workerPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    return {
      running: alive,
      pid: this.workerPid,
      lastLineAt: this.lastLineAt,
      restarts: this.restarts,
      lastError: this.lastError,
      exe: this.exe,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawn();

    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.pollTimer.unref?.();

    // 卡死判定：**20 秒没有新数据就重启**（睡眠唤醒、系统组件重启后 WinRT 会话失效、
    // 或者 WMI 压根没把进程起来）。计时起点是 lastLineAt，首跳还没来时退回 startingAt——
    // 原来只认 lastLineAt，于是「从头就没起来」这种最该管的情况反而不判死，一直空转。
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      const sinceStart = Date.now() - this.startingAt;
      // 无窗口宿主这条路走不通：Windows 10 1809 之前没有 --headless，个别安全软件
      // 也会拦 conhost 带子进程。表现是宿主起来了、里面什么都没跑（拿不到 pid、
      // 也没有数据）。宽限期一过就换成直启，别让它一直空转。
      if (!this.useFallback && this.workerPid === null && !this.lastLineAt && sinceStart > STARTUP_GRACE_MS) {
        this.killHost();
        this.switchToFallback('无窗口宿主在宽限期内没有拉起读取进程');
        this.restarts += 1;
        this.scheduleRestart(500);
        return;
      }
      const base = this.lastLineAt ?? this.startingAt;
      if (!base) return;
      // 刚起来那段给足时间，别让宽限期被"启动慢"消耗成误杀。
      if (!this.lastLineAt && sinceStart < STARTUP_GRACE_MS) return;
      if (Date.now() - base <= STALE_MS) return;
      this.log('warn', `读取进程 ${Math.round((Date.now() - base) / 1000)} 秒没有新数据，重启它。`);
      this.killWorker();
      this.killHost();
      this.restarts += 1;
      this.scheduleRestart(500);
    }, 10_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.killWorker();
    this.killHost();
  }

  /* ---------- 内部 ---------- */

  private log(level: 'info' | 'warn', message: string): void {
    this.opts.log(level, message);
  }

  private spawn(): void {
    if (this.stopped) return;
    // 这一步放在最前面：脚本本身不存在的话，起什么宿主都没意义，也不该起。
    if (!existsSync(this.opts.scriptPath)) {
      this.lastError = `读取脚本不存在：${this.opts.scriptPath}`;
      this.log('warn', this.lastError);
      return;
    }
    const exe = this.exe;
    if (!exe) {
      this.lastError = '找不到 powershell.exe，无法读取播放器。';
      this.log('warn', this.lastError);
      return;
    }

    this.startingAt = Date.now();
    this.lastMtimeMs = 0;
    // 上一轮留下的 pid 必须清掉。不清的话会把一个早就不在的 pid（甚至被系统回收后
    // 分配给别人的 pid）当成自己的读取进程——判活会永远"活着"，收尸会杀错人。
    try { unlinkSync(this.pidFile()); } catch { /* 本来就没有 */ }

    const interval = String(Math.max(200, Math.min(10_000, this.opts.intervalMs)));
    const readerArgs = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', this.opts.scriptPath,
      '-Out', this.opts.outFile,
      // Core 被强杀时宿主会跟着消失，但读进程未必；把 pid 交给脚本，它自己看父进程还在不在。
      '-ParentPid', String(process.pid),
      '-IntervalMs', interval,
    ];
    // 有宿主就让宿主托管（零窗口）；没有就直启 powershell（老系统上本来就没有 Terminal 委托）。
    const host = this.useFallback ? null : this.conhost;
    const bin = host ?? exe;
    const args = host ? ['--headless', exe, ...readerArgs] : readerArgs;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.lastError = `拉起读取进程失败：${error instanceof Error ? error.message : String(error)}`;
      this.log('warn', this.lastError);
      this.scheduleRestart(5000);
      return;
    }
    this.child = child;
    this.hostPid = child.pid ?? null;

    // **必须把 stdout 读空。** ConPTY 的背面是管道，没人读的话缓冲区满了会把被托管的
    // powershell 堵死在写操作上，表现是"进程活着但文件不再更新"。
    // 这里的内容是 VT 序列加 UTF-8 乱码（ConPTY 按 UTF-16 转码），除了排障没用；
    // 只留最后一小段，在崩溃时能看出它最后喊了什么。
    let tail = '';
    child.stdout?.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString('latin1')).slice(-2048);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      tail = (tail + text).slice(-2048);
      // PowerShell 的进度条、Add-Type 的杂音都会到这里；只在不像噪音时记一条。
      if (/Exception|错误|无法|Error/i.test(text)) this.lastError = text.split(/\r?\n/)[0].slice(0, 200);
    });

    child.on('error', (error) => {
      this.lastError = `读取进程出错：${error.message}`;
    });

    child.on('exit', (code) => {
      const wasStopped = this.stopped;
      this.child = null;
      this.hostPid = null;
      if (wasStopped) return;
      // 现在宿主和读取进程是同一条命：ConPTY 一关，里面的 powershell 跟着走；
      // powershell 自己退了，宿主也没事可做。所以退出就是退出，没有"正常收工"这回事。
      // （上一版是 WMI 起的短启动器，它干完活就该退，才需要单独区分，那套逻辑随它一起删了。）
      this.readWorkerPid();
      if (this.workerPid) {
        // 读到过 pid 说明里面确实跑过；现在它没了，按重启处理。
        this.killWorker();
      }
      if (!this.useFallback) {
        // conhost 起不来：老系统没有 --headless，或者被安全软件拦了。
        this.switchToFallback(`无窗口宿主退出，代码 ${code}`);
        this.restarts += 1;
        this.scheduleRestart(500);
        return;
      }
      this.lastError = code !== 0 && code !== null
        ? `读取进程退出，代码 ${code}。${tail ? '最后输出：' + tail.slice(-160) : ''}`
        : '读取进程退出了。';
      this.log('warn', this.lastError);
      this.restarts += 1;
      // 退避重试，别把 CPU 烧在重启上。
      this.scheduleRestart(Math.min(30_000, 1000 * 2 ** Math.min(5, this.restarts - 1)));
    });
  }

  /** 降级只能发生一次：不然会在两条路之间来回弹，日志也会被刷满。 */
  private switchToFallback(reason: string): void {
    if (this.useFallback) return;
    this.useFallback = true;
    this.lastError = `${reason}。读取进程改为直接由 Core 拉起——Windows 11 上可能带出一个终端标签页，读取功能不受影响。`;
    this.log('warn', this.lastError);
  }

  /** 读取进程把自己的 pid 写在这里（Core 拿到的宿主 pid 不等于它）。 */
  private pidFile(): string {
    return `${this.opts.outFile}.pid`;
  }

  /** 尽量从 pid 文件里认出读取进程。认不出就返回，等下一轮。 */
  private readWorkerPid(): void {
    if (this.workerPid !== null) return;
    let text = '';
    try {
      text = readFileSync(this.pidFile(), 'utf8').trim();
    } catch {
      return; // 启动器还没写完
    }
    const pid = Number(text);
    // 0 / NaN / 荒谬的大数都不认。pid 上限给宽一点，不同 Windows 版本的位宽不一样。
    if (!Number.isInteger(pid) || pid <= 0 || pid > 4_000_000) return;
    // 文件里躺着的可能是上一轮留下的死号。认下来有两个后果：exit 分支看到
    // `workerPid` 有值就当成"读取进程还活着"直接 return（不重启，功能静默失效），
    // 而收尸又会照着这个号去 kill —— 号一旦被系统复用，就是杀错人。
    // 死号当场丢掉，等下一轮再看。
    if (!isProcessAlive(pid)) {
      try { unlinkSync(this.pidFile()); } catch { /* 下次再说 */ }
      return;
    }
    this.workerPid = pid;
    this.startingAt = Date.now();
    // 注意 pid 和宿主不是同一个：宿主是 conhost.exe，正经的读取进程在它里面。
    // 判活、收尸都认这个 pid，别去用 child.pid。
    this.log('info', `播放器读取进程已就绪（PID ${pid}${this.hostPid ? `，宿主 ${this.hostPid}` : ''}）${this.useFallback ? '，无窗口宿主不可用，直接由 Core 拉起' : ''}。`);
  }

  /**
   * 读一次输出文件。mtime 没变就什么都不做 —— 脚本每秒重写，两次写入之间可能被调用四次。
   */
  private poll(): void {
    if (this.stopped) return;
    // pid 落在文件里。顺带在这里认领：250ms 一次，
    // 比另外开一个定时器简单，而且天然会重试。
    this.readWorkerPid();
    const file = this.opts.outFile;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return; // 还没写第一次
    }
    if (mtimeMs <= this.lastMtimeMs) return;
    this.lastMtimeMs = mtimeMs;

    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return; // 正被替换/占用；下一轮再来
    }
    // 半截 JSON 是正常现象：写入方是覆盖写，读者可能正好读到只写了一半的时刻。
    // 下一跳会重新写一份完整的，这里丢掉就好，不算错误。
    const parsed = parseTickLine(text);
    if (!parsed) return;

    if ('error' in parsed) {
      this.lastError = parsed.error;
      // 报错也是"活着"的证据：脚本还在跑，只是在某一步拿到了异常。刷新时间戳，
      // 否则读到 error 反而会被 watchdog 当成卡死。
      this.lastLineAt = Date.now();
      return;
    }

    // 陈旧快照：Core 重启后读到的上一次运行留下的文件。丢掉，别让她说
    // "几小时前在听某首歌"。
    // **有意不刷新 lastLineAt** —— 陈旧说明读取进程没在写，正是该让 watchdog 判死的情况。
    // 进程正常时，下一跳（1 秒内）就会写进新 ts，这条分支根本走不到第二次。
    if (parsed.ts < Date.now() - STALE_PAYLOAD_MS) {
      this.lastError = `输出文件里的数据是 ${Math.round((Date.now() - parsed.ts) / 1000)} 秒前的，等它更新。`;
      return;
    }

    this.lastLineAt = Date.now();
    this.lastError = null;
    const payload: TickPayload = { ts: parsed.ts, sessions: parsed.sessions };
    this.latest = payload;
    this.opts.onTick?.(payload);
  }

  private scheduleRestart(delayMs: number): void {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  /** 关掉宿主（conhost 或直启的 powershell）。ConPTY 一关，里面的读进程也会跟着退。 */
  private killHost(): void {
    const child = this.child;
    this.child = null;
    this.hostPid = null;
    if (!child) return;
    try {
      child.kill();
    } catch { /* 已经退了 */ }
  }

  private killWorker(): void {
    const pid = this.workerPid;
    this.workerPid = null;
    if (pid === null) return;
    // 宿主先退出的时候，这个 pid 会在内存里多留一会儿（留着才能收孤儿），
    // 但那段时间里号可能已经换人了。先问一句再动手。
    if (!isProcessAlive(pid)) return;
    try {
      // 读进程在宿主的控制台里，`child.kill()` 只杀得掉宿主；按 pid 收它自己更干净，
      // 否则 ConPTY 关闭是"异步消失"的，这中间它还会往文件里写一跳。
      process.kill(pid);
    } catch { /* 已经没了，或宿主关闭时已经带走了 */ }
  }
}
