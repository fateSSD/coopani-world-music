/**
 * 听歌历史与笔记的落盘。
 *
 * 一天一个 JSONL 文件放在 dataDir/listening/ 下，一行一首已收尾的歌。
 * 选 JSONL 而不是数据库：这个量级（一天几十行）用不着索引，坏了也只坏一行，
 * 而且人能直接 grep。
 *
 * 一条记录只在"一首歌收尾"时写一次（换歌、停止、退出）。正在听的那一首不进文件，
 * 由世界层实时算给工具看——否则同一首歌会随着轮询被写几十遍。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sameDir } from './storage.ts';
import type { FinishedTrack, Track } from './tracker.ts';

export interface ListenRecord {
  /** 曲目开始时间（epoch ms）。 */
  ts: number;
  /** 曲目结束时间（epoch ms）。 */
  end: number;
  app: string;
  title: string;
  artist: string;
  album: string;
  /** 实际在放的毫秒。 */
  ms: number;
}

export interface ArtistTally {
  name: string;
  count: number;
  ms: number;
}

export interface ReplayTally {
  title: string;
  artist: string;
  count: number;
  ms: number;
}

export interface ListenSummary {
  tracks: number;
  ms: number;
  firstTs: number | null;
  lastTs: number | null;
  artists: ArtistTally[];
  replays: ReplayTally[];
  /** 按收尾时间倒序的全部曲目。 */
  list: ListenRecord[];
}

/**
 * 一天一个文件。
 *
 * **也要认网盘冲突副本。** 两台机器同一天各写过，OneDrive / 坚果云会生成
 * `2026-10-28-我的电脑.jsonl`、`2026-10-28 (1).jsonl` 这类名字。只认精确名的话，
 * 这些行会被**静默忽略**——而"两台机器写同一份记忆"正是这个功能存在的理由。
 * 冲突副本里的行由 `readDay` 按内容去重，重复的自然消失，不重复的正是不该丢的那些。
 */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:[-_ (][^/\\]*)?\.jsonl$/;

export class ListenStore {
  /** 写入落点（记忆目录）。 */
  private readonly memoryDir: string;
  /** 读取时要合并的全部目录，写入目录排第一。 */
  private readonly roots: string[];
  private readonly dir: string;
  private readonly notesPath: string;
  private readonly wantsPath: string;
  /** 写入目录不可用、已经落到本机兜底过。设置页要如实说，别让人以为在同步盘里。 */
  private fellBack = false;

  /**
   * @param memoryDir 记忆写入目录（可能是自定义目录，也可能是宿主默认目录）
   * @param localDir  宿主默认目录：只参与读取，不参与写入
   */
  constructor(memoryDir: string, localDir?: string) {
    this.memoryDir = memoryDir;
    this.roots = localDir && !sameDir(memoryDir, localDir) ? [memoryDir, localDir] : [memoryDir];
    this.dir = join(memoryDir, 'listening');
    this.notesPath = join(memoryDir, 'music-notes.jsonl');
    this.wantsPath = join(memoryDir, 'music-wants.jsonl');
  }

  /** 写入目录 + 兜底目录（两者相同时只有一个）。 */
  private get spareRoot(): string | null {
    const last = this.roots[this.roots.length - 1];
    return sameDir(last, this.memoryDir) ? null : last;
  }

  /** 是否已经退到本机兜底写过。 */
  get degraded(): boolean {
    return this.fellBack;
  }

  /** 记忆实际写在哪 —— 给设置页显示，跟宿主默认目录可能不是一回事。 */
  get writeDir(): string {
    return this.memoryDir;
  }

  pathFor(day: string): string {
    return join(this.dir, `${day}.jsonl`);
  }

  /** 写一行。父目录现建（自定义目录可能被用户删了）。 */
  private writeLine(file: string, text: string): boolean {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 追加一条已收尾的曲目。
   *
   * 记忆目录写不进去（移动硬盘拔了、网盘掉线、盘满）时**落到本机兜底**，
   * 而不是把这一行丢掉：读取本来就合并两处，所以她查历史时仍然看得见。
   * 丢的只是"它不在你以为的地方"，这一点由 `degraded` 报到设置页。
   */
  append(day: string, record: ListenRecord): boolean {
    const line = `${JSON.stringify(record)}\n`;
    if (this.writeLine(this.pathFor(day), line)) return true;
    const spare = this.spareRoot;
    if (!spare) return false;
    if (!this.writeLine(join(spare, 'listening', `${day}.jsonl`), line)) return false;
    this.fellBack = true;
    return true;
  }

  recordOf(finished: FinishedTrack, endedAt: number): ListenRecord {
    return {
      ts: finished.startedAt,
      end: endedAt,
      app: finished.track.app,
      title: finished.track.title,
      artist: finished.track.artist,
      album: finished.track.album,
      ms: finished.playedMs,
    };
  }

  /**
   * 读某一天。**两处目录合并**。
   *
   * 合并是为了支持"换位置"这个动作：把记忆目录指到同步盘那天，本机旧目录里还有
   * 之前几天几周的记录。只读新目录的话，用户看到的是"记忆搬完就不见了"。
   * 去重按「开始时间 + 结束时间 + 歌名 + 歌手 + 时长」——同一首歌听两遍时间不同，
   * 不会误合；只有真的一行被两处都收到（手动拷过、或从兜底目录又同步回来）才会重。
   */
  readDay(day: string): ListenRecord[] {
    const seen = new Set<string>();
    const out: ListenRecord[] = [];
    for (const root of this.roots) {
      for (const r of this.readDayFrom(root, day)) {
        const key = `${r.ts}|${r.end}|${r.title}\u0001${r.artist}|${r.ms}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * 某一天在某个根下的**全部**文件（精确名 + 网盘冲突副本）。
   * 目录扫不出来就当没有——盘掉线时 readdir 会抛，不该把整次查询带挂。
   */
  private filesFor(root: string, day: string): string[] {
    const dir = join(root, 'listening');
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => DAY_FILE.exec(n)?.[1] === day)
      .map((n) => join(dir, n));
  }

  private readDayFrom(root: string, day: string): ListenRecord[] {
    const out: ListenRecord[] = [];
    for (const file of this.filesFor(root, day)) {
      let raw = '';
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const r = JSON.parse(trimmed) as ListenRecord;
          if (typeof r.ts === 'number' && typeof r.title === 'string') out.push(r);
        } catch { /* 坏行跳过 */ }
      }
    }
    return out;
  }

  /** 最近 n 天（含今天），days 按本地日倒序给出。 */
  readDays(days: string[]): ListenRecord[] {
    const out: ListenRecord[] = [];
    for (const day of days) out.push(...this.readDay(day));
    return out.sort((a, b) => a.end - b.end);
  }

  /** 列出现有的日期文件，倒序。两处目录的并集。 */
  days(): string[] {
    const set = new Set<string>();
    for (const root of this.roots) {
      try {
        for (const name of readdirSync(join(root, 'listening'))) {
          const day = DAY_FILE.exec(name)?.[1];
          if (day) set.add(day);
        }
      } catch { /* 这个根还没建，跳过 */ }
    }
    return [...set].sort().reverse();
  }

  /** 删掉超过 keepDays 的旧文件；启动时跑一次就够。两处目录都裁。 */
  prune(keepDays: number): number {
    if (!Number.isFinite(keepDays) || keepDays <= 0) return 0;
    const all = this.days();
    const drop = all.slice(Math.max(0, Math.trunc(keepDays)));
    let removed = 0;
    for (const day of drop) {
      for (const root of this.roots) {
        for (const file of this.filesFor(root, day)) {
          try {
            unlinkSync(file);
            removed += 1;
          } catch { /* 不在就不在 */ }
        }
      }
    }
    return removed;
  }

  /**
   * 清空全部逐日记录 —— 给设置页的「清除」用。
   *
   * 内存里没有记录缓存（`readDay` 每次都读文件），所以删完立刻就是空的，
   * 不需要重启扩展。正在听的那一首本来就没落盘，不受影响。
   *
   * 两处都清：用户点的是"清除听歌记录"，不是"清除这个目录里的记录"。
   * 只清一处的话，被清掉的日子会从另一个目录继续冒出来，看着像没生效。
   */
  clearDays(): number {
    const all = this.days();
    let removed = 0;
    for (const day of all) {
      for (const root of this.roots) {
        for (const file of this.filesFor(root, day)) {
          try {
            unlinkSync(file);
            removed += 1;
          } catch { /* 删不掉的留着 */ }
        }
      }
    }
    return removed;
  }

  /** 记录文件占用的字节数 —— 给设置页显示规模。两处相加。 */
  sizeBytes(): number {
    let total = 0;
    for (const root of this.roots) {
      for (const day of this.days()) {
        try {
          total += readFileSync(join(root, 'listening', `${day}.jsonl`)).length;
        } catch { /* 读不到就当 0 */ }
      }
      try {
        const f = join(root, 'music-notes.jsonl');
        if (existsSync(f)) total += readFileSync(f).length;
      } catch { /* 同上 */ }
    }
    return total;
  }

  /* ---------- 笔记 ---------- */

  addNote(text: string, at: number, track: Track | null): void {
    const line = `${JSON.stringify({
      ts: at,
      text,
      title: track?.title ?? '',
      artist: track?.artist ?? '',
    })}\n`;
    if (this.writeLine(this.notesPath, line)) return;
    // 同 append：记忆目录不可用就落到本机，读取合并，笔记不会凭空消失。
    const spare = this.spareRoot;
    if (spare && this.writeLine(join(spare, 'music-notes.jsonl'), line)) this.fellBack = true;
  }

  /** 合并两处目录里的笔记原文，去重后按时间排。 */
  private notesAll(): Array<{ ts: number; text: string; title: string; artist: string }> {
    const seen = new Set<string>();
    const all: Array<{ ts: number; text: string; title: string; artist: string }> = [];
    for (const root of this.roots) {
      const file = join(root, 'music-notes.jsonl');
      if (!existsSync(file)) continue;
      let raw = '';
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const n = JSON.parse(trimmed);
          if (typeof n?.text !== 'string' || !n.text) continue;
          const key = `${Number(n.ts) || 0}|${n.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push({ ts: Number(n.ts) || 0, text: n.text, title: String(n.title ?? ''), artist: String(n.artist ?? '') });
        } catch { /* 坏行跳过 */ }
      }
    }
    return all.sort((a, b) => a.ts - b.ts);
  }

  /** 最近的笔记，新的在前。 */
  notes(limit = 5): Array<{ ts: number; text: string; title: string; artist: string }> {
    return this.notesAll().slice(-Math.max(1, limit)).reverse();
  }

  /** 一共记了多少条笔记 —— 给设置页显示规模。 */
  noteCount(): number {
    return this.notesAll().length;
  }

  /** 清空笔记。读笔记每次都读文件，所以删掉即刻生效。两处都删。 */
  clearNotes(): boolean {
    let ok = true;
    for (const root of this.roots) {
      const file = join(root, 'music-notes.jsonl');
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /* ---------- 想听清单 ---------- */

  /**
   * 记一首"她想听"的歌。
   *
   * 为什么需要它：她能搜、能挑，但放不出来（原因见 picker.ts 头部的实测记录）。
   * 只丢一句话，过五分钟就散了；落到清单里，下次还能接着说"上次那首你还没放"。
   * 同一首（同源 + 歌名 + 歌手）只留一条 —— 不然她能一天提十遍。
   */
  addWant(item: Omit<WantItem, 'ts'>, at: number): { added: boolean; total: number } {
    const existing = this.wants(500);
    const dup = existing.find(
      (w) => w.title === item.title && w.artist === item.artist && w.source === item.source,
    );
    if (dup) return { added: false, total: existing.length };
    const line = `${JSON.stringify({ ts: at, ...item })}\n`;
    if (!this.writeLine(this.wantsPath, line)) {
      const spare = this.spareRoot;
      if (!spare || !this.writeLine(join(spare, 'music-wants.jsonl'), line)) {
        return { added: false, total: existing.length };
      }
      this.fellBack = true;
    }
    return { added: true, total: existing.length + 1 };
  }

  /** 想听清单，新的在前。两处目录合并（查重也跨两处，不会重复记同一首）。 */
  wants(limit = 10): WantItem[] {
    const seen = new Set<string>();
    const all: WantItem[] = [];
    for (const root of this.roots) {
      const file = join(root, 'music-wants.jsonl');
      if (!existsSync(file)) continue;
      let raw = '';
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const w = JSON.parse(trimmed);
          const title = String(w?.title ?? '').trim();
          if (!title) continue;
          const key = `${Number(w.ts) || 0}|${String(w.source ?? '')}|${title}\u0001${String(w.artist ?? '')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push({
            ts: Number(w.ts) || 0,
            source: String(w.source ?? ''),
            id: String(w.id ?? ''),
            mid: String(w.mid ?? ''),
            title,
            artist: String(w.artist ?? ''),
            album: String(w.album ?? ''),
            durSec: Number(w.durSec) || 0,
            url: String(w.url ?? ''),
            why: String(w.why ?? ''),
          });
        } catch { /* 坏行跳过 */ }
      }
    }
    return all.slice(-Math.max(1, limit)).reverse();
  }

  /** 清单一共几首 —— 给设置页和徽章用。 */
  wantCount(): number {
    return this.wants(1000).length;
  }

  /** 清空想听清单。也是读时现读，删掉即刻生效。两处都删。 */
  clearWants(): boolean {
    let ok = true;
    for (const root of this.roots) {
      const file = join(root, 'music-wants.jsonl');
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        ok = false;
      }
    }
    return ok;
  }
}

/** 想听清单里的一条。字段跟 picker.ts 的 Track 对齐，但那边不依赖这边。 */
export interface WantItem {
  ts: number;
  source: string;
  id: string;
  mid: string;
  title: string;
  artist: string;
  album: string;
  durSec: number;
  url: string;
  /** 她当时为什么想听。一句话。 */
  why: string;
}

/** 汇总一组记录。歌手、循环榜按次数排，同次数按听的时间排。 */
export function summarize(records: readonly ListenRecord[]): ListenSummary {
  const byArtist = new Map<string, ArtistTally>();
  const byTrack = new Map<string, ReplayTally>();
  let ms = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const r of records) {
    ms += Number.isFinite(r.ms) ? r.ms : 0;
    if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
    if (lastTs === null || r.end > lastTs) lastTs = r.end;

    const artistName = (r.artist || '').trim() || '未知歌手';
    const a = byArtist.get(artistName) ?? { name: artistName, count: 0, ms: 0 };
    a.count += 1;
    a.ms += Number.isFinite(r.ms) ? r.ms : 0;
    byArtist.set(artistName, a);

    const title = (r.title || '').trim();
    if (!title) continue;
    const k = `${title}\u0001${artistName}`;
    const t = byTrack.get(k) ?? { title, artist: artistName, count: 0, ms: 0 };
    t.count += 1;
    t.ms += Number.isFinite(r.ms) ? r.ms : 0;
    byTrack.set(k, t);
  }

  const artists = [...byArtist.values()].sort((x, y) => y.count - x.count || y.ms - x.ms);
  const replays = [...byTrack.values()]
    .filter((t) => t.count >= 2)
    .sort((x, y) => y.count - x.count || y.ms - x.ms);

  return {
    tracks: records.length,
    ms,
    firstTs,
    lastTs,
    artists,
    replays,
    list: [...records].sort((a, b) => b.end - a.end),
  };
}
