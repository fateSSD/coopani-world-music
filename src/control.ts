/**
 * 一次性控制播放器（暂停/继续/下一首/上一首）。
 *
 * 控制是低频的（一次点击），所以按次拉起脚本、读完就退；读侧才常驻。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findPowerShell, type TickPayload } from './nowplaying.ts';
import { runDarwinControl } from './darwin-media.ts';
import { mediaBridgeKind } from './platform.ts';

export const CONTROL_SCRIPT = fileURLToPath(new URL('../scripts/control.ps1', import.meta.url));

export type ControlAction = 'pause' | 'resume' | 'next' | 'prev';

export interface ControlResult {
  ok: boolean;
  app?: string;
  status?: string;
  title?: string;
  artist?: string;
  error?: string;
}

/**
 * 播放器状态 → 人话。
 *
 * `Opened` / `Changing` 是 SMTC 的真实枚举值（`GlobalSystemMediaTransportControlsSessionPlaybackStatus`），
 * 不是异常：从 Closed/Stopped 按「继续」时，回执先落在 `Opened`，一两秒后才变 `Playing`。
 * 2026-11-20 实测 QQ音乐 resume 就回 `Opened`——漏了这两档，工具回执里会直接甩英文给模型。
 */
export function statusText(status: string | undefined): string {
  switch (status) {
    case 'Playing': return '在放';
    case 'Paused': return '已暂停';
    case 'Stopped': return '已停止';
    case 'Closed': return '已关闭';
    case 'Opened': return '刚起播';
    case 'Changing': return '切换中';
    default: return status ? String(status) : '状态未知';
  }
}

/**
 * 跑一次控制脚本。任何失败都以 {ok:false,error} 返回，不抛——
 * 工具回执要让模型看见"为什么没按下去"，而不是让调用直接失败。
 *
 * **mac 不走这里。** 那边没有 PowerShell、也没有 SMTC，走的是
 * `darwin-media.ts` 里的 `runDarwinControl()`（osascript 发 MediaRemote 命令）。
 * 分发按 `mediaBridgeKind()` 判，与读侧同一个判据 —— 加平台时只改一处。
 *
 * `readBack`：mac 上发完命令要立刻重读一次才知道按没按下去（命令发出去是不报错的）。
 * Windows 侧由脚本自己回读，用不到这个参数。
 */
export function runControl(
  action: ControlAction,
  match: string,
  timeoutMs = 10_000,
  readBack?: () => Promise<TickPayload | null>,
): Promise<ControlResult> {
  if (mediaBridgeKind() === 'mediaremote') {
    return runDarwinControl(action, { readBack });
  }
  return new Promise((resolve) => {
    const exe = findPowerShell();
    if (!exe) return resolve({ ok: false, error: '找不到 powershell.exe' });
    if (!existsSync(CONTROL_SCRIPT)) return resolve({ ok: false, error: '控制脚本不存在' });
    execFile(
      exe,
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', CONTROL_SCRIPT,
        '-Action', action,
        ...(match ? ['-Match', match] : []),
      ],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error && !stdout) return resolve({ ok: false, error: error.message.slice(0, 200) });
        const line = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
        if (!line) return resolve({ ok: false, error: '播放器没有回应' });
        try {
          const parsed = JSON.parse(line) as ControlResult;
          return resolve({
            ok: parsed.ok === true,
            app: parsed.app,
            status: parsed.status,
            title: parsed.title,
            artist: parsed.artist,
            error: parsed.error,
          });
        } catch {
          return resolve({ ok: false, error: '播放器的回应读不懂' });
        }
      },
    );
  });
}
