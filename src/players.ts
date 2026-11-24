/**
 * 认播放器：哪一场会话算"他在听的歌"。
 *
 * 系统里可能同时有 QQ音乐、网易云、浏览器里的网页播放器、甚至游戏内的音轨。
 * 这一层的职责只是"按使用者的偏好挑一场"，不猜、不合并。
 */
import type { SessionSnapshot } from './nowplaying.ts';

export type PlayerPref = 'auto' | 'qq' | 'netease';

interface KnownPlayer {
  key: 'qq' | 'netease';
  pattern: RegExp;
  label: string;
}

/**
 * 认识的播放器。
 *
 * **正则要同时覆盖三种写法**，因为两个平台的「app 名」不是一回事：
 * - Windows 的 SMTC 给的是**可执行文件名**：`QQMusic.exe` / `CloudMusic.exe`；
 * - mac 的 MediaRemote 给的是**本地化显示名**（`client.displayName`），中文系统上就是
 *   「QQ音乐」「网易云音乐」；
 * - QQ音乐 mac 版的 bundle 自身叫 `QQ.app`，显示名也可能只落到 `QQ`。
 *
 * 2026-11-24 之前这里只有 `/qqmusic/i`，mac 上「QQ音乐」三个中文字匹配不上，于是
 * 会话被当成「不认识的播放器」整场丢掉 —— 读得到歌、却挑不出会话。这一条是拿截图
 * 里的真实名字补的，不是猜的。
 */
const KNOWN_PLAYERS: readonly KnownPlayer[] = [
  { key: 'qq', pattern: /qqmusic|qq音乐|^qq$/i, label: 'QQ音乐' },
  { key: 'netease', pattern: /cloudmusic|netease|网易云/i, label: '网易云音乐' },
];

/** 播放器的显示名。认不出来就给 AUMID 本身，不编一个名字。 */
export function playerLabel(app: string, extraPlayers: string): string {
  for (const p of KNOWN_PLAYERS) {
    if (p.pattern.test(app)) return p.label;
  }
  for (const frag of splitExtra(extraPlayers)) {
    if (app.toLowerCase().includes(frag.toLowerCase())) return app.replace(/\.exe$/i, '');
  }
  return app.replace(/\.exe$/i, '') || '播放器';
}

/** 逗号/分号/空格分隔的额外播放器 AUMID 片段。 */
export function splitExtra(extraPlayers: string): string[] {
  return (extraPlayers || '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

export function isRecognized(app: string, extraPlayers: string): boolean {
  if (KNOWN_PLAYERS.some((p) => p.pattern.test(app))) return true;
  const lower = app.toLowerCase();
  return splitExtra(extraPlayers).some((frag) => lower.includes(frag.toLowerCase()));
}

export interface PickResult {
  session: SessionSnapshot | null;
  label: string;
  /** 为什么没挑到——给工具回执用，别让模型自己猜。 */
  reason?: string;
}

/**
 * 挑一场会话。顺序：
 * 1. 先按"认识的播放器"过滤（QQ/网易云，加使用者填的额外播放器）
 * 2. 指定了 player 就只留那一家
 * 3. 优先正在放的，其次排在前面的
 */
export function pickSession(
  sessions: readonly SessionSnapshot[],
  opts: { player: PlayerPref; extraPlayers: string },
): PickResult {
  const recognized = sessions.filter((s) => isRecognized(s.app, opts.extraPlayers));
  if (recognized.length === 0) {
    const others = [...new Set(sessions.map((s) => s.app))];
    return {
      session: null,
      label: '',
      reason: others.length
        ? `系统里有 ${others.length} 个媒体会话，但都不是认识的播放器（${others.join('、')}）`
        : '系统里现在没有任何媒体会话',
    };
  }

  let pool = recognized;
  if (opts.player !== 'auto') {
    const want = KNOWN_PLAYERS.find((p) => p.key === opts.player);
    const filtered = want ? recognized.filter((s) => want.pattern.test(s.app)) : recognized;
    if (filtered.length === 0) {
      return {
        session: null,
        label: '',
        reason: `设定只听${want?.label ?? opts.player}，但那一场现在没有会话`,
      };
    }
    pool = filtered;
  }

  const session = pool.find((s) => s.status === 'playing') ?? pool[0] ?? null;
  return { session, label: session ? playerLabel(session.app, opts.extraPlayers) : '' };
}
