/**
 * 一次性控制播放器（暂停/继续/下一首/上一首）。
 *
 * 控制是低频的（一次点击），所以按次拉起脚本、读完就退；读侧才常驻。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findPowerShell } from './nowplaying.ts';

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

/** 播放器状态 → 人话。 */
export function statusText(status: string | undefined): string {
  switch (status) {
    case 'Playing': return '在放';
    case 'Paused': return '已暂停';
    case 'Stopped': return '已停止';
    case 'Closed': return '已关闭';
    default: return status ? String(status) : '状态未知';
  }
}

/**
 * 跑一次控制脚本。任何失败都以 {ok:false,error} 返回，不抛——
 * 工具回执要让模型看见"为什么没按下去"，而不是让调用直接失败。
 */
export function runControl(action: ControlAction, match: string, timeoutMs = 10_000): Promise<ControlResult> {
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
