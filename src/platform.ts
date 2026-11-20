/**
 * 平台差异集中在这里。
 *
 * 这个扩展原来是 Windows-only 的，五条能力各自压在一条 Windows 专有通道上：
 * 读「正在播放」走系统媒体会话（SMTC，靠常驻 PowerShell 桥）、暂停切歌同样走 SMTC、
 * 判断播放器在不在跑靠 `tasklist`、抓系统音频走 WASAPI 回环、本机深听环境装在
 * `%LOCALAPPDATA%`。macOS 上这五条全都要换，而且换法各不一样。
 *
 * 三条规矩（与炉石扩展 2026-11-12 那份同源，那边真机验过）：
 *
 * 1. **平台判断只在这个文件里。** 别的模块不许再自己写 `process.platform === '...'`。
 * 2. **平台参数可注入。** 每个函数第一个参数默认 `process.platform`；路径按「传入的平台」
 *    用 `path.win32` / `path.posix` 拼，**不按跑代码的机器**拼 —— 所以 Windows 上也能单测
 *    mac 分支。
 * 3. **分支显式点名 `win32` / `darwin`，不写「非 A 即 B」。** 认不出来的平台两边都不进，
 *    最坏是「什么都没做」，不是「做错」。
 *
 * 只依赖 node 内置，`node src/platform.ts` 能直跑，拆这块时不用起宿主。
 *
 * ## 哪些是实测过的，哪些是推的
 *
 * - **Windows 一栏是 v1.0.0 的原文，一字未改**：`LOCALAPPDATA` 缺失时回落 `homedir()`
 *   （不是 `AppData\Local`，别"顺手修正"）、`tasklist /NH /FO CSV` 的**带引号整名匹配**、
 *   `venv\Scripts\python.exe`。改这里之前先看 `test/platform.test.mjs` 钉住的期望值。
 * - **macOS 一栏目前只有一条真机结论**：`ps -Ao comm=` 输出的是可执行文件全路径、末段是
 *   不带后缀的进程名，且要容忍 `X.app` / `X Helper` 这类派生进程（2026-11-12 炉石扩展
 *   mac 真机验证）。其余按 macOS 惯例推：`~/Library/Application Support` 落点、
 *   播放器进程名（`QQMusic` / `NeteaseMusic` 两个名字尚未真机确认）。
 * - **`mediaReady: false` 是诚实的现状**：mac 的读侧要走 MediaRemote（自研，BSD-3），
 *   还没接。在它接上之前，mac 上装了也只能聊——不能装作能读。
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** 平台标识。只区分 win32 / darwin，其余按 POSIX 兜底但**不假装支持**。 */
export type Platform = 'win32' | 'darwin' | (string & {});

/** 平台参数注入点：默认全取当前进程，测试时整组替换。 */
export interface PlatformContext {
  platform?: Platform;
  home?: string;
  env?: Record<string, string | undefined>;
}

/** 取该平台对应的 path 实现：按「传入的平台」拼，不按跑代码的机器。 */
const pathOf = (platform: Platform) => (platform === 'win32' ? win32 : posix);

/**
 * 本机数据根目录。
 *
 * - win32：`%LOCALAPPDATA%`，**缺了回落 `homedir()`** —— v1.0.0 就是这么写的，
 *   改成 `AppData\Local` 会让极少数环境里的落点变掉，属于「为了整洁改坏行为」。
 * - darwin：`~/Library/Application Support`（Coopani 自己的数据目录也在这下面）。
 */
export function localDataRoot(
  platform: Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  const P = pathOf(platform);
  if (platform === 'win32') return env.LOCALAPPDATA || home;
  if (platform === 'darwin') return P.join(home, 'Library', 'Application Support');
  return home;
}

/**
 * 本机深听环境的默认安装位置。
 *
 * 必须每台机器一个位置，不能写死某一台的盘符 —— 写死之后别人装上就是「找不到分析器」，
 * 而那句话说起来像扩展坏了。
 */
export function defaultHearingHome(
  platform: Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  return pathOf(platform).join(localDataRoot(platform, home, env), 'CoopaniMusic', 'hearing');
}

/**
 * 深听用的解释器。
 *
 * - win32：`venv\Scripts\python.exe`。
 * - darwin：`venv/bin/python3`。PyPI 的 arm64 wheel 齐全，装法一样，只是目录布局不同。
 */
export function hearingPythonPath(hearingHome: string, platform: Platform = process.platform): string {
  const P = pathOf(platform);
  if (platform === 'win32') return P.join(hearingHome, 'venv', 'Scripts', 'python.exe');
  if (platform === 'darwin') return P.join(hearingHome, 'venv', 'bin', 'python3');
  return P.join(hearingHome, 'venv', 'bin', 'python3');
}

/** 列进程要跑什么命令。 */
export interface ProbeCommand {
  command: string;
  args: string[];
}

/**
 * 列进程的命令。
 *
 * - win32：`tasklist /NH /FO CSV`（v1.0.0 原文）。
 * - darwin：系统自带的 `/bin/ps`，`-Ao comm=` 每行一个可执行文件全路径。
 *   不要用 `pgrep -f`：它按整条命令行匹配，编辑器里开着同名文件也会命中。
 */
export function peerProbeCommand(platform: Platform = process.platform): ProbeCommand {
  if (platform === 'win32') return { command: 'tasklist', args: ['/NH', '/FO', 'CSV'] };
  if (platform === 'darwin') return { command: '/bin/ps', args: ['-Ao', 'comm='] };
  return { command: '/bin/ps', args: ['-Ao', 'comm='] };
}

/**
 * 进程名的平台写法。
 *
 * 调用方继续按 Windows 习惯传 `Hearthstone.exe`，由这一层翻译成该平台的样子 ——
 * 这样调用点不用改，也不会有人在业务代码里写 `.replace('.exe','')`。
 *
 * - win32：原样（缺后缀补上）。
 * - darwin：去后缀（`ps` 的 `comm` 末段不带 `.exe`）。
 */
export function processName(base: string, platform: Platform = process.platform): string {
  if (platform === 'win32') return /\.exe$/i.test(base) ? base : `${base}.exe`;
  if (platform === 'darwin') return base.replace(/\.exe$/i, '');
  return base;
}

/**
 * 在进程列表输出里找名单里的进程。
 *
 * - win32：`tasklist /FO CSV` 一行一个进程，形如 `"QQMusic.exe","1234","Console",...`，
 *   所以按**带引号的名字**整名匹配 —— 这一条是原逻辑的隐含前提：`foo.exe` 不能命中
 *   `oo.exe`。重写时最容易丢的就是它。
 * - darwin：`ps -Ao comm=` 每行一个全路径，取末段比；同时容忍 `X.app` 与 `X Helper`
 *   这类派生进程名。
 *
 * 名单按 Windows 习惯给（带 `.exe`），内部按平台归一。
 */
export function matchesPeerNames(
  stdout: string,
  names: readonly string[],
  platform: Platform = process.platform,
): boolean {
  const wanted = names.map((n) => processName(n, platform).toLowerCase());
  if (platform === 'win32') {
    const lower = stdout.toLowerCase();
    return wanted.some((name) => lower.includes(`"${name}"`));
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .some((line) => {
      const base = line.slice(line.lastIndexOf('/') + 1);
      return wanted.some((w) => base === w || base === `${w}.app` || base.startsWith(`${w} `));
    });
}

/**
 * 杀整棵进程树的命令。
 *
 * - win32：`taskkill /PID <pid> /T /F`。理由不是"顺手"：这台机器上 venv 的 python.exe
 *   是个壳，真正的解释器是它拉起来的子进程；只 kill 壳会留下一个 718MB 的孤儿。
 * - darwin：返回 null，调用方退回 `child.kill()`。**这是有意的现状**，不是遗漏 ——
 *   要杀进程组得让 spawn 时 `detached: true`（子进程自成组长），改的是启动参数，
 *   属于音频/深听那一档的活，P0 不动它，免得把 Windows 的收尸逻辑带歪。
 */
export function killTreeSpec(pid: number, platform: Platform = process.platform): ProbeCommand | null {
  if (platform === 'win32') return { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return null;
}

/** 本版本在某个平台上接通了哪些通道。 */
export interface Channels {
  /** 读「正在播放」该走哪条路。 */
  media: 'smtc' | 'mediaremote';
  /** 这条路**在本版本里接通了没有**。false = 装了也读不到播放器。 */
  mediaReady: boolean;
  /** 能不能暂停 / 切歌。 */
  control: boolean;
  /** 能不能抓系统音频（跟拍跳舞要用）。 */
  systemAudio: boolean;
  /** 能不能在本地跑深听模型。 */
  localHearing: boolean;
}

/**
 * 本版本的通道清单。
 *
 * mac 的 `mediaReady: false` 会在接上 MediaRemote 之后改 true；在那之前所有上层判断
 * 都靠这一处，不要散在别处写平台判断。
 */
export function channels(platform: Platform = process.platform): Channels {
  if (platform === 'win32') {
    return { media: 'smtc', mediaReady: true, control: true, systemAudio: true, localHearing: true };
  }
  if (platform === 'darwin') {
    return { media: 'mediaremote', mediaReady: false, control: false, systemAudio: false, localHearing: false };
  }
  return { media: 'mediaremote', mediaReady: false, control: false, systemAudio: false, localHearing: false };
}

/**
 * 通道没接通时给使用者的一句话。
 *
 * 宁可写清楚"现在读不到"，也不要让她对着播放器胡说 —— 静默降级是最难排查的那类故障。
 */
export function unavailableHint(platform: Platform = process.platform): string {
  const c = channels(platform);
  if (c.mediaReady) return '';
  if (platform === 'darwin') {
    return 'macOS 版的播放器读取还在做：现在能装、能聊，但还认不出你在放什么歌。';
  }
  return '这个系统还没有接通播放器读取。';
}
