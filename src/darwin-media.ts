/**
 * macOS 的「正在播放」读侧。
 *
 * ## 为什么不是「照着 Windows 那套换个 api 名」
 *
 * Windows 上读的是 SMTC，Node 调不到 WinRT，所以那边是「PowerShell 常驻 + 文件桥」。
 * mac 上原本以为可以直接 dlopen MediaRemote 调 `MRMediaRemoteGetNowPlayingInfo`，
 * **但这条路 macOS 15.4 起就封了**：该框架只把「正在播放」交给带 Apple 平台签名的进程，
 * 第三方进程（哪怕是已签名、有 bundle id 的 .app）调用只会拿到一个空字典，而且不报错。
 *
 * 这不是听说 —— 有人在**同一版系统（macOS 26.6.2 / 25G83，正是报障用户的机器）**上
 * 实测记录过：控制中心显示着正在播放的歌、那一侧的播放/暂停按钮也能用，而进程内直连
 * `MRMediaRemoteGetNowPlayingInfo` 返回空（vorssaint-utils issue #1280 / #1282；
 * 另有 Lyrix 的 `docs/DESIGN.md` 记录 26.5.2 上同样为空）。**所以「用户截图里控制中心
 * 有歌名」证明不了我们能读** —— 这两件事走的是不同的门。
 *
 * ## 那读什么
 *
 * 借一个 **Apple 签名的系统二进制**去做读取。系统自带的 `/usr/bin/osascript` 就是，
 * 而且它带 Objective-C 桥，可以直接加载私有框架、调 ObjC 类方法：
 *
 *     $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/').load
 *     $.NSClassFromString('MRNowPlayingRequest').localNowPlayingItem.nowPlayingInfo
 *
 * 走的是 `MRNowPlayingRequest` 这个类，不是上面那个被封的 C 函数。这条路在 15.4 与
 * 26 beta 上都有人验证过。
 *
 * 为什么不用另外两条路：
 * - **mediaremote-adapter / perl 那一套**：确实可行（DockDoor、Music Presence、
 *   playback-popup 都在用），但要编译一个自定义 framework 再让 `/usr/bin/perl`
 *   DynaLoader 加载。多一个二进制、多一次架构与签名处理，而 osascript 这条路零编译。
 * - **AppleScript 直连某个播放器**（`tell application "Spotify"`）：只对内置字典的
 *   App 有效，QQ音乐 / 网易云都没有，一开始就不通。
 *
 * ## 已验证 / 未验证
 *
 * **2026-11-24 真机验通（macOS 26.6.2 / 25G83 / Apple M4）**，两条都是用户当场跑的：
 * - **读**：`MRNowPlayingRequest` 这个类在这版系统上存在，`localNowPlayingItem
 *   .nowPlayingInfo.valueForKey("kMRMediaRemoteNowPlayingInfoTitle")` 直接拿到了
 *   正在放的歌名。所以「控制中心有歌名」之外的第二个证据也齐了 —— 我们这一侧能读到。
 * - **控**：`MRNowPlayingController.localRouteController.sendCommandOptionsCompletion(2, …)`
 *   发出去之后**播放器真的暂停了**。这不是「命令没报错」，是他看着界面停下来的。
 *   本文件用的是 0/1/4/5（play/pause/next/prev）而非 2（toggle），同一个入口、同一套枚举。
 *
 * 还没验的（现在也不影响用）：
 * - **字段齐不齐**：真机只验了 title 一个键。artist / album / duration / elapsed /
 *   playbackRate 在这版系统上是否都给，等装上一版看日志。缺哪个就退到 `null` 处理，
 *   不会崩 —— 但「进度条不准」这种软毛病要从这里查起。
 * - **封面**（`ArtworkData` 在 osascript 里拿不到，实测为 null）。这个扩展不用封面。
 * - **播放器显示名**：MediaRemote 给的是本地化显示名（中文系统上应是「QQ音乐」
 *   「网易云音乐」），真机没抓这一项，所以 `players.ts` 的正则三种写法都留了。
 */

import { execFile } from 'node:child_process';
import type { BridgeHealth, PlaybackStatus, SessionSnapshot, TickPayload } from './nowplaying.ts';
import type { ControlAction, ControlResult } from './control.ts';
import type { ProbeCommand } from './platform.ts';

/** 系统自带，不需要安装也不需要签名。 */
export const OSASCRIPT_PATH = '/usr/bin/osascript';

/**
 * 单次读取的超时。
 *
 * 别人的实测是 M 系列上一次往返 20–30ms，但那是 perl；osascript 还要算上解释器冷启动，
 * 而且第一次加载框架会慢。给 4 秒是「宁可慢一轮，也不要误判成读不到」。
 */
const READ_TIMEOUT_MS = 4_000;

/** 控制命令要等播放器消化，给宽一点。 */
const CONTROL_TIMEOUT_MS = 6_000;

/**
 * 采样间隔。
 *
 * Windows 那边是 1 秒，因为常驻进程只是读文件。这里每一跳都要起一个 osascript，
 * 一秒一次太费；歌曲不会两秒换一首，2 秒足够。改小之前先量 CPU。
 */
export const DEFAULT_DARWIN_INTERVAL_MS = 2_000;

/** 超过这么久没读到东西，就算「读侧不在工作」。与 Windows 那边的 STALE_MS 同量级。 */
const STALE_MS = 20_000;

/**
 * 读取脚本。
 *
 * 只做「取事实 + 打一行 JSON」，不做判断 —— 判断（状态映射、进度推算、去重）全留在 Node，
 * 这样那些逻辑在 Windows 上就能测，不用等 mac。
 */
const JXA_READ = `ObjC.import('Foundation');
(function () {
  var MR = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
  if (!MR) return JSON.stringify({ error: '找不到 MediaRemote.framework' });
  MR.load;
  var Req = $.NSClassFromString('MRNowPlayingRequest');
  if (!Req) return JSON.stringify({ error: '这个系统上 MediaRemote 没有 MRNowPlayingRequest' });
  var app = '';
  try {
    var pp = Req.localNowPlayingPlayerPath;
    if (pp && !pp.isNil()) app = String(ObjC.unwrap(pp.client.displayName) || '');
  } catch (e) { app = ''; }
  var item = null;
  try { item = Req.localNowPlayingItem; } catch (e) { item = null; }
  if (!item || item.isNil()) return JSON.stringify({ app: app, empty: true });
  var info = null;
  try { info = item.nowPlayingInfo; } catch (e) { info = null; }
  if (!info || info.isNil()) return JSON.stringify({ app: app, empty: true });
  function str(k) {
    try {
      var v = info.valueForKey(k);
      if (!v || v.isNil()) return '';
      return String(ObjC.unwrap(v) || '');
    } catch (e) { return ''; }
  }
  function num(k) {
    try {
      var v = info.valueForKey(k);
      if (!v || v.isNil()) return null;
      var x = Number(v.js);
      return isFinite(x) ? x : null;
    } catch (e) { return null; }
  }
  var out = {
    app: app,
    title: str('kMRMediaRemoteNowPlayingInfoTitle'),
    artist: str('kMRMediaRemoteNowPlayingInfoArtist'),
    album: str('kMRMediaRemoteNowPlayingInfoAlbum'),
    rate: num('kMRMediaRemoteNowPlayingInfoPlaybackRate'),
    duration: num('kMRMediaRemoteNowPlayingInfoDuration'),
    elapsed: num('kMRMediaRemoteNowPlayingInfoElapsedTime'),
    ts: null,
    pos: null
  };
  try {
    var d = info.valueForKey('kMRMediaRemoteNowPlayingInfoTimestamp');
    if (d && !d.isNil()) out.ts = d.timeIntervalSince1970 * 1000;
  } catch (e) {}
  try {
    var md = item.metadata;
    if (md && !md.isNil()) {
      var p = md.calculatedPlaybackPosition;
      if (typeof p === 'number' && isFinite(p)) out.pos = p;
    }
  } catch (e) {}
  return JSON.stringify(out);
})();`;

/**
 * 控制命令的数值。
 *
 * 取自 `MRMediaRemoteCommand`，在 AppleScript 社区文档与 mediaremote-adapter 的枚举里一致。
 * 2026-11-24 真机验证了这套枚举本身：用户发 2（toggle）后播放器确实停了 —— 说明
 * 「这个入口 + 这套编号」是对的，0/1/4/5 与之同源。
 * 这里**不用 toggle**：`resume` 就发 play(0)、`pause` 就发 pause(1)。toggle 在两个方向
 * 都不是幂等的，一旦状态与预期错开就会反向操作，很难排查。
 */
const COMMAND_VALUES: Record<ControlAction, number> = {
  resume: 0,
  pause: 1,
  next: 4,
  prev: 5,
};

/** 生成控制脚本。命令值以数字注入，不做字符串拼接。 */
export function controlJxa(action: ControlAction): string {
  const value = COMMAND_VALUES[action];
  return `ObjC.import('Foundation');
(function () {
  var MR = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
  if (!MR) return 'error: 找不到 MediaRemote.framework';
  MR.load;
  var C = $.NSClassFromString('MRNowPlayingController');
  if (!C) return 'error: 这个系统上 MediaRemote 没有 MRNowPlayingController';
  var c = null;
  try { c = C.localRouteController; } catch (e) { c = null; }
  if (!c || c.isNil()) return 'error: 拿不到本机播放控制器';
  try {
    c.sendCommandOptionsCompletion(${value}, $.NSDictionary.alloc.init, null);
  } catch (e) {
    return 'error: ' + String(e);
  }
  return 'ok';
})();`;
}

/** 读一次的命令行。参数走 execFile，不经 shell，脚本里的引号与空格不用再转义。 */
export function readCommand(osascriptPath: string = OSASCRIPT_PATH): ProbeCommand {
  return { command: osascriptPath, args: ['-l', 'JavaScript', '-e', JXA_READ] };
}

/** 控制一次的命令行。 */
export function controlCommand(action: ControlAction, osascriptPath: string = OSASCRIPT_PATH): ProbeCommand {
  return { command: osascriptPath, args: ['-l', 'JavaScript', '-e', controlJxa(action)] };
}

/** 脚本打出来的一行原始字段。 */
export interface DarwinRaw {
  app?: string;
  empty?: boolean;
  error?: string;
  title?: string;
  artist?: string;
  album?: string;
  rate?: number | null;
  duration?: number | null;
  elapsed?: number | null;
  ts?: number | null;
  pos?: number | null;
}

/**
 * 从输出里挑出 JSON 行。
 *
 * osascript 有时会在 stdout 前面掺别的东西（语言环境警告之类），所以不能整体 parse，
 * 得找最后一个以 `{` 开头的行 —— 那才是脚本的返回值。
 */
export function pickJsonLine(stdout: string): string | null {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) return lines[i];
  }
  return null;
}

/**
 * 播放速率 → 状态。
 *
 * MediaRemote 不给「Playing/Paused」这种枚举，只给 rate：>0 在放、=0 暂停。
 * 拿不到 rate 时算 `unknown` —— 不猜「大概在放」，猜错会让她为一段静音编一句话。
 */
export function rateToStatus(rate: number | null | undefined): PlaybackStatus {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'unknown';
  return rate > 0 ? 'playing' : 'paused';
}

/**
 * 推算当前位置。
 *
 * `ElapsedTime` 是**上报那一刻**的进度，不是「现在」。所以在播放时要加上
 * `(now - timestamp) × rate`。三种情况退回原值：
 * - 暂停（rate 为 0 或没有）→ 原值就是位置；
 * - 没有 timestamp → 没法外推；
 * - 时钟明显不对（负数或超过一小时）→ 宁可用原值，也不给一个荒唐的进度。
 */
export function estimatePosition(
  elapsed: number | null | undefined,
  reportedAt: number | null | undefined,
  rate: number | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return null;
  if (typeof rate !== 'number' || !(rate > 0)) return elapsed;
  if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt)) return elapsed;
  const drift = (now - reportedAt) / 1000;
  if (!Number.isFinite(drift) || drift < 0 || drift > 3_600) return elapsed;
  return elapsed + drift * rate;
}

/** 进度不许超过总长（播放器自己的四舍五入会让它超一点点）。 */
export function clampPosition(pos: number | null, dur: number | null): number | null {
  if (pos === null) return null;
  if (dur !== null && dur > 0 && pos > dur) return dur;
  return pos >= 0 ? pos : 0;
}

/**
 * 解析一跳。
 *
 * 三种返回，与 Windows 的 `parseTickLine` 对齐：
 * - `null`：输出读不懂（半截、乱码）——下一跳再说，不算错误；
 * - `{ error }`：脚本明确报错（找不到框架、类名变了）——这是真问题，要写日志；
 * - `{ ts, sessions }`：正常。**没有在放歌时 sessions 为空数组**，不是错误。
 */
export function parseDarwinTick(
  stdout: string,
  now: number = Date.now(),
): { ts: number; sessions: SessionSnapshot[] } | { ts: number; error: string } | null {
  const line = pickJsonLine(stdout);
  if (!line) return null;
  let raw: DarwinRaw;
  try {
    raw = JSON.parse(line) as DarwinRaw;
  } catch {
    return null;
  }
  if (typeof raw?.error === 'string' && raw.error) return { ts: now, error: raw.error };

  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  // 空字典 / 没标题都当「没在放」：没标题的会话对上层没有意义（串词、查歌词都要标题）。
  if (raw?.empty === true || !title) return { ts: now, sessions: [] };

  const dur = typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : null;
  const rate = typeof raw.rate === 'number' && Number.isFinite(raw.rate) ? raw.rate : null;
  const reportedAt = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : null;
  // 优先用框架算好的位置；没有就自己按「上报时刻 + 速率」外推。
  const pos = typeof raw.pos === 'number' && Number.isFinite(raw.pos)
    ? raw.pos
    : estimatePosition(raw.elapsed, reportedAt, rate, now);

  const app = (typeof raw.app === 'string' ? raw.app.trim() : '') || '未知播放器';
  const session: SessionSnapshot = {
    app,
    via: 'mediaremote',
    status: rateToStatus(rate),
    title,
    artist: typeof raw.artist === 'string' ? raw.artist.trim() : '',
    album: typeof raw.album === 'string' ? raw.album.trim() : '',
    posSec: clampPosition(pos, dur),
    durSec: dur,
    // MediaRemote 不告诉我们「这个会话接受哪些命令」。本机播放控制器支持全部四类，
    // 但有没有反应取决于播放器本身 —— 所以四个都给 true，按「发了再看回读」处理。
    canPlay: true,
    canPause: true,
    canNext: true,
    canPrev: true,
  };
  return { ts: now, sessions: [session] };
}

/** 跑一条命令，永不抛。 */
export interface RunOutcome {
  stdout: string;
  stderr: string;
  failed: boolean;
  message?: string;
}

const execFileAsync = (command: string, args: string[], timeoutMs: number): Promise<RunOutcome> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        failed: !!error,
        message: error ? error.message : undefined,
      });
    });
  });

export interface DarwinBridgeOptions {
  intervalMs?: number;
  onTick?: (payload: TickPayload) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** 注入用：默认 `/usr/bin/osascript`。 */
  osascriptPath?: string;
  /** 注入用：替换真实执行器。测试靠它，不碰真机。 */
  run?: (command: string, args: string[], timeoutMs: number) => Promise<RunOutcome>;
}

/**
 * mac 的桥。
 *
 * 与 Windows 的 `NowPlayingBridge` **同形状**（start / stop / snapshot / health），
 * 所以业务层换实现时不用改一处调用 —— 这是做平台层时就定下的判据。
 *
 * 与 Windows 不同的两处，都是有意的：
 * 1. **没有常驻进程、没有文件桥。** 每次读取就是起一个 osascript 读一行 JSON 再退。
 *    Windows 那套复杂结构是为了规避「powershell 冷启动 1–1.5 秒」，这边一次几百毫秒、
 *    两秒一跳，没有必要常驻。
 * 2. **pid 恒为 null。** 没有常驻进程可认领，`health().pid` 保留字段只为形状一致。
 */
export class DarwinMediaBridge {
  private readonly opts: DarwinBridgeOptions;
  private readonly osascriptPath: string;
  private readonly intervalMs: number;
  private readonly run: (command: string, args: string[], timeoutMs: number) => Promise<RunOutcome>;

  private timer: NodeJS.Timeout | null = null;
  private latest: TickPayload | null = null;
  private lastLineAt: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private stopped = true;
  private busy = false;
  private ticks = 0;

  constructor(opts: DarwinBridgeOptions = {}) {
    this.opts = opts;
    this.osascriptPath = opts.osascriptPath ?? OSASCRIPT_PATH;
    this.intervalMs = Math.max(500, opts.intervalMs ?? DEFAULT_DARWIN_INTERVAL_MS);
    this.run = opts.run ?? execFileAsync;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log('info', `mac 播放器读取已启动：每 ${this.intervalMs}ms 问一次系统。`);
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): TickPayload | null {
    return this.latest;
  }

  /**
   * 立刻读一次，不等下一跳。
   *
   * 控制命令发完之后要回读 —— 缓存最多两秒，拿它验证「刚按下的这一下」会验到按之前
   * 的状态，看上去像「命令被吞了」。上一跳还没回来时先让一让，最多等 1.2 秒。
   */
  async readNow(): Promise<TickPayload | null> {
    for (let waited = 0; this.busy && waited < 1_200 && !this.stopped; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.stopped && !this.busy) await this.tick();
    return this.latest;
  }

  health(): BridgeHealth {
    const now = Date.now();
    const fresh = this.lastLineAt !== null && now - this.lastLineAt < STALE_MS;
    return {
      // 「活着」= 最近还能读到东西。没有常驻进程可判，所以不看 pid。
      running: fresh,
      pid: null,
      lastLineAt: this.lastLineAt,
      restarts: this.failures,
      lastError: this.lastError,
      // 复用这个字段报「用的是什么在读」，mac 上就是 osascript 的路径。
      exe: this.osascriptPath,
    };
  }

  /** 读一次。上一跳还没回来就跳过 —— osascript 卡住时不许堆积进程。 */
  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const cmd = readCommand(this.osascriptPath);
      const out = await this.run(cmd.command, cmd.args, READ_TIMEOUT_MS);
      this.ticks += 1;

      if (!out.stdout.trim()) {
        // 脚本没吐东西：把 stderr 第一行带出来，否则日志里只剩「失败了」。
        const why = out.stderr.trim().split(/\r?\n/)[0] || out.message || '没有输出';
        this.fail('读不到系统播放信息：' + why.slice(0, 200));
        return;
      }

      const parsed = parseDarwinTick(out.stdout, Date.now());
      if (!parsed) {
        this.fail('系统播放信息读不懂（返回的不是 JSON）');
        return;
      }
      if ('error' in parsed) {
        // 明确报错也是「进程活着」的证据，但功能是坏的：记错误、不刷新 lastLineAt。
        this.fail(parsed.error);
        return;
      }

      this.lastLineAt = Date.now();
      this.lastError = null;
      this.failures = 0;
      this.latest = { ts: parsed.ts, sessions: parsed.sessions };
      // 第一跳成功才说一句，别每两秒刷日志。
      if (this.ticks === 1) this.log('info', 'mac 播放器读取已就绪。');
      this.opts.onTick?.(this.latest);
    } catch (error) {
      this.fail('读取出错：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      this.busy = false;
    }
  }

  private fail(message: string): void {
    this.failures += 1;
    // 同一条错误不重复刷屏：只在内容变了或连续失败跨过阈值时记一条。
    const changed = this.lastError !== message;
    this.lastError = message;
    if (changed || this.failures === 5) this.log('warn', message);
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.opts.log?.(level, message);
  }
}

export interface DarwinControlOptions {
  osascriptPath?: string;
  run?: (command: string, args: string[], timeoutMs: number) => Promise<RunOutcome>;
  /** 发完命令等多久再回读。默认 700ms。 */
  verifyDelayMs?: number;
  /** 回读用；不传就跳过验证，只报「已发送」。 */
  readBack?: () => Promise<TickPayload | null>;
}

/**
 * 把 mac 的小写状态写成 SMTC 那套首字母大写的写法。
 *
 * 理由只有一个：`statusText()` 是按 SMTC 的枚举（`Playing` / `Paused` …）做的映射，
 * 也是工具回执唯一的出口。这里不改那一份，而是把 mac 的值对齐过去 —— 否则回执会把
 * 英文小写 `playing` 原样甩出来，那正是 2026-11-20 修过的那类毛病。
 */
export function statusLabel(status: string | undefined): string | undefined {
  if (status === 'playing') return 'Playing';
  if (status === 'paused') return 'Paused';
  return status;
}

/**
 * 发一条控制命令。
 *
 * **不回读就不算成功。** 有人在 macOS 26.1 上报告过「读得到、命令被吞掉」的情况，
 * 而命令发出去是不会报错的 —— 所以这里默认发完等一会儿再读一次，把真实状态带回去。
 * 调用方看到 `ok: true` + 一个 `status`，才是「确实变了」。
 */
export async function runDarwinControl(
  action: ControlAction,
  opts: DarwinControlOptions = {},
): Promise<ControlResult> {
  const osascriptPath = opts.osascriptPath ?? OSASCRIPT_PATH;
  const run = opts.run ?? execFileAsync;
  const cmd = controlCommand(action, osascriptPath);
  const out = await run(cmd.command, cmd.args, CONTROL_TIMEOUT_MS);
  const verdict = pickVerdict(out.stdout);
  if (verdict !== 'ok') {
    const detail = verdict.startsWith('error:') ? verdict.slice(6).trim() : (out.stderr.trim() || out.message || '没有回应');
    return { ok: false, error: detail.slice(0, 200) };
  }

  if (!opts.readBack) return { ok: true, error: undefined };
  await new Promise((r) => setTimeout(r, opts.verifyDelayMs ?? 700));
  let after: TickPayload | null = null;
  try {
    after = await opts.readBack();
  } catch {
    after = null;
  }
  const s = after?.sessions?.[0];
  if (!s) return { ok: true, error: '已发送，但回读不到播放状态（可能播放器没响应）' };
  return { ok: true, app: s.app, status: statusLabel(s.status), title: s.title, artist: s.artist };
}

/** 从控制脚本的输出里取结论行：脚本只返回 `ok` 或 `error: ...`。 */
export function pickVerdict(stdout: string): string {
  const text = String(stdout ?? '').trim();
  if (!text) return '';
  // 有可能夹着别的行；结论是最后一行非空内容。
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}
