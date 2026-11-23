/**
 * 「正在播放」的桥：按平台挑实现。
 *
 * 业务层（world / tools / webui）只认这个文件导出的 `createMediaBridge()` 与 `MediaBridge`
 * 接口，**不认具体是哪一个类**。这样加一个平台不用去改四处调用点，也不会有人在业务代码里
 * 写 `if (process.platform === 'darwin')`。
 *
 * 两个实现的形状必须一致：`start / stop / snapshot / health`。这条不是设计洁癖 ——
 * mac 侧当初就是照着 `NowPlayingBridge` 已有的形状写的（做平台层时定下的判据：
 * 平台层写完，业务侧调用点应该一行都不用改）。
 */
import { NowPlayingBridge, type BridgeHealth, type TickPayload } from './nowplaying.ts';
import { DarwinMediaBridge, DEFAULT_DARWIN_INTERVAL_MS } from './darwin-media.ts';
import { mediaBridgeKind, type Platform } from './platform.ts';

/** 两种实现共同满足的接口。 */
export interface MediaBridge {
  start(): void;
  stop(): void;
  snapshot(): TickPayload | null;
  health(): BridgeHealth;
}

export interface MediaBridgeOptions {
  /** 采样间隔（毫秒）。mac 上会被抬到不低于 1.5 秒 —— 每一跳都是一个新进程。 */
  intervalMs?: number;
  onTick?: (payload: TickPayload) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** 注入用：测试可以点名平台，不必真跑在 mac 上。 */
  platform?: Platform;
}

/**
 * mac 上每跳要起一个 osascript，比 Windows 读一次文件贵得多。
 *
 * 配置里给的 `intervalMs` 在 Windows 上是一秒一跳；照搬到 mac 就是每秒一个进程，
 * 长期跑没必要。这里只给下限，不覆盖用户调大。
 */
const DARWIN_MIN_INTERVAL_MS = 1_500;

export function createMediaBridge(opts: MediaBridgeOptions = {}): MediaBridge {
  const platform = opts.platform ?? process.platform;
  const log = opts.log;

  if (mediaBridgeKind(platform) === 'smtc') {
    return new NowPlayingBridge({
      intervalMs: opts.intervalMs,
      onTick: opts.onTick,
      log,
    });
  }

  const wanted = opts.intervalMs ?? DEFAULT_DARWIN_INTERVAL_MS;
  return new DarwinMediaBridge({
    intervalMs: Math.max(DARWIN_MIN_INTERVAL_MS, wanted),
    onTick: opts.onTick,
    log,
  });
}
