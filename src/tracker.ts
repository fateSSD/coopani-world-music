/**
 * 听歌状态机：把每秒一次的采样，收敛成"值得开口的时刻"。
 *
 * 这一层不碰文件、不碰宿主，只吃 tick、吐 signal，所以可以拿假时钟把"连续三首都能说上话"
 * "跨天了水位要清零""重启后不重放"这类事写成测试，而不必真去听两个小时歌。
 *
 * 四条自缚规则（每条都是踩过的坑）：
 * 1. 只在**变化**时出声。同一首歌播四十遍不该出四十条事件。
 * 2. 水位（这首第几遍、这一场听多久）必须能在"换了一场"时归零。判据不靠框架的"开始"信号，
 *    靠**时间断层**：超过 15 分钟没有在放，就是新的一场。
 * 3. 播放进度不可信（有的播放器 pos 常年不动、或直接等于时长），所以"听了多久"一律用墙钟累加，
 *    单跳增量设上限，防止休眠唤醒后被算成一小时。
 * 4. 重启后的第一跳只认状态、不出声：那一跳分不清"刚打开"还是"已经放了三小时"，
 *    这时候说"他开始听歌了"有一半是错的。
 */
import type { SessionSnapshot } from './nowplaying.ts';
import { phaseOf, type Phase } from './vibe.ts';

export interface Track {
  app: string;
  title: string;
  artist: string;
  album: string;
}

/** 一首歌收尾时的结算记录，交给世界层落库。 */
export interface FinishedTrack {
  track: Track;
  startedAt: number;
  playedMs: number;
}

export type Signal =
  /**
   * 从静默（≥15 分钟）里重新开始放。
   *
   * `silenceMin` 三态：数字 = 真的知道隔了多久；`null` = 不知道（进程刚起、手上
   * 没有上一次的播放时刻）。**不能用 0 冒充 null** —— 0 的意思是"刚刚还在听"，
   * 两者说出来的话正好相反。删掉这个区别的后果实测过：2026-10-31 11:16 隔了
   * 8 小时，事件正文写的是「距上一次听歌隔了 0 秒」，她照着这个数往回推，
   * 得出的结论是"刚放下又拿起来"。
   */
  | { kind: 'start'; track: Track; silenceMin: number | null }
  /** 换歌。 */
  | { kind: 'track'; track: Track; prev: Track; indexInSession: number; artistChanged: boolean; prevPlayedMs: number }
  /** 同一首（同歌名同歌手）在这一次连续收听里第 count 遍（count ≥ 3 才算循环）。 */
  | { kind: 'loop'; track: Track; count: number }
  /** 短时间内连续跳歌。 */
  | { kind: 'fidget'; skipped: number; windowMin: number }
  /** 深夜仍在听。 */
  | { kind: 'night'; track: Track; hour: number }
  /** 连续听满一档时长。 */
  | { kind: 'long'; track: Track; minutes: number }
  /**
   * 这一首又走完了一段（段长 = base ± 33%，默认 45 ± 15 秒）。
   * 这是"陪听"的主节拍：她没有耳朵，只能一段一段地说，所以段边界必须带上播放位置。
   */
  | {
    kind: 'segment'; track: Track;
    index: number; fromSec: number; toSec: number;
    posSec: number | null; durSec: number | null;
    /**
     * 这一段落在歌的哪个位置（开场/主歌/副歌/桥段/尾声），按播放比例估。
     * 曲长未知或太短时是 null——那时候报"现在在副歌"是编的。
     */
    phase: Phase | null;
    indexInSession: number; loopCount: number;
  }
  /**
   * 她点的那一首快放完了，可以递下一棒。
   *
   * **这条不由 tracker 产出。** tracker 只看播放水位，不知道"这首是谁点的"；
   * 它由 world.ts 的 `maybeRelay()` 生成。放进同一个 union 是为了共用那条 emit 通道
   * （让路、shouldSpeak、日志、senderKey 都在那边，另写一份必然漂移）。
   */
  | { kind: 'relay'; track: Track; remainSec: number; chain: number; maxChain: number };

export interface FeedResult {
  signals: Signal[];
  /** 本次结算掉的一首（换歌、或暂停超过一场、或停止）。没有就是 null。 */
  finished: FinishedTrack | null;
}

export interface TrackerOptions {
  /** IANA 时区，判"深夜"和"今天"用。 */
  timezone: string;
  /** 深夜起点的小时（0–23）。窗口是 [起点, 05:00)。 */
  nightFrom: number;
  /** 连续听多少分钟算"久听"。 */
  longMinutes: number;
  /** 多久没在放就算新的一场。 */
  newSessionGapMs?: number;
  /** 一首歌切成多长一段（秒）。0 = 不切段，也就没有"每段评论"。这是段长的**下限**。 */
  segmentEverySec?: number;
  /** 每首最多说几段。短歌靠它压次数，长曲靠它把段长拉开。 */
  maxSegmentsPerTrack?: number;
}

export interface NowState {
  track: Track | null;
  playing: boolean;
  startedAt: number | null;
  playedMs: number;
  sessionPlayedMs: number;
  sessionStartedAt: number | null;
  indexInSession: number;
  loopCount: number;
  posSec: number | null;
  durSec: number | null;
  lastPlayingAt: number | null;
  /** 这一首已经说过的段数。 */
  segmentsSaid: number;
}

const DEFAULT_GAP_MS = 15 * 60_000;
/**
 * 单跳最多算这么多毫秒。防的是休眠唤醒：醒来第一跳的间隔可能是几小时，
 * 但那段人没在听。取 5 分钟是折中——正常的进程卡顿（GC、磁盘慢）不会漏记，
 * 真正的睡眠会被"时间断层"判成新的一场。
 */
const MAX_STEP_MS = 5 * 60_000;
/** 一首歌听了不到这么久就被换掉，算"跳歌"。 */
const SKIP_UNDER_MS = 45_000;
const FIDGET_WINDOW_MS = 5 * 60_000;
const FIDGET_MIN_SKIPS = 4;

const formatters = new Map<string, Intl.DateTimeFormat>();

function clockParts(timezone: string, ts: number): { day: string; hour: number; minute: number } {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    formatters.set(timezone, fmt);
  }
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ts))) out[part.type] = part.value;
  const hour = Number(out.hour ?? '0') % 24;
  return { day: `${out.year}-${out.month}-${out.day}`, hour, minute: Number(out.minute ?? '0') };
}

/** 本地日（YYYY-MM-DD），写历史文件和判"今天"都用它。 */
export function localDay(timezone: string, ts: number): string {
  return clockParts(timezone, ts).day;
}

/** 本地时钟 HH:MM。 */
export function localClock(timezone: string, ts: number): string {
  const p = clockParts(timezone, ts);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function isNightHour(hour: number, nightFrom: number): boolean {
  // 窗口跨午夜：[23, 05)。起点落在清晨时按不跨午夜解释，避免填 2 变成"全天深夜"。
  if (nightFrom >= 5) return hour >= nightFrom || hour < 5;
  return hour >= nightFrom && hour < 5;
}

export const trackKey = (t: Track): string => `${t.app}\u0001${t.title}\u0001${t.artist}`;

/** 默认段长（秒）。这是下限，不是硬值。 */
export const DEFAULT_SEGMENT_SEC = 45;
/** 默认每首最多说几段。 */
export const DEFAULT_MAX_SEGMENTS = 3;

/**
 * 段长抖动：-amp..+amp 秒，按「曲目 + 第几段」做确定性哈希。
 *
 * 用哈希而不是 Math.random，是为了两件事：一是可测（同样的输入永远同样的段长，
 * 测试不会随机红）；二是同一首歌来回听的时候段边界稳定，她的第 2 段不会这次在 0:48
 * 下次在 0:33——时间感一变，她就更容易重复自己。
 */
function segmentJitter(key: string, index: number, amp: number): number {
  if (amp <= 0) return 0;
  let h = 2166136261;
  const seed = `${key}#${index}`;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = amp * 2 + 1;
  return ((h >>> 0) % span) - amp;
}

/**
 * 用播放器报的进度估"这一首已经放了多久"。
 * 只在这一场的第一首用：那一首可能是听到一半才被看见的。进度不合理（负数、超过总时长、
 * 刚好等于总时长——有的播放器暂停时就这么报）时返回 0，宁可少算。
 */
export function seedPlayedMs(s: { posSec: number | null; durSec: number | null }): number {
  const pos = s.posSec;
  const dur = s.durSec;
  if (pos === null || !Number.isFinite(pos) || pos < 5) return 0;
  if (dur !== null && Number.isFinite(dur) && dur > 0 && pos >= dur - 1) return 0;
  return Math.round(pos * 1000);
}

/** 秒 → "m:ss"。 */
export function clockOf(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 毫秒 → "1 小时 12 分" / "37 分钟" / "40 秒"。 */
export function humanDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  if (m > 0) return `${m} 分钟`;
  return `${totalSec} 秒`;
}

export class ListeningTracker {
  private readonly opts: Required<TrackerOptions>;
  private track: Track | null = null;
  private startedAt: number | null = null;
  private playedMs = 0;
  private sessionStartedAt: number | null = null;
  private sessionPlayedMs = 0;
  private indexInSession = 0;
  private lastPlayingAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastKey: string | null = null;
  private loopCounts = new Map<string, number>();
  private skips: Array<{ ts: number; playedMs: number }> = [];
  private posSec: number | null = null;
  private durSec: number | null = null;
  private nightPushedDay: string | null = null;
  private longPushedSessionAt: number | null = null;
  private primed = false;
  /** 本首已经说过几段。 */
  private segIndex = 0;
  /** 当前这一段的起点（这一首已播放的毫秒数）。 */
  private segStartMs = 0;
  /** 下一段该在这一首播到第几毫秒时触发。 */
  private segCursorMs = Number.POSITIVE_INFINITY;

  constructor(options: TrackerOptions) {
    this.opts = {
      newSessionGapMs: DEFAULT_GAP_MS,
      segmentEverySec: DEFAULT_SEGMENT_SEC,
      maxSegmentsPerTrack: DEFAULT_MAX_SEGMENTS,
      ...options,
    };
  }

  /**
   * 从落盘状态里恢复"已经报过深夜""这一场已经报过久听"，避免重启后重放同一件事。
   *
   * 还接一样东西：**上一次"还在播"的时刻**。它不恢复的后果是重启后第一次见到播放
   * 就把 `lastPlayingAt` 判成 null，gap 变成 Infinity，于是「隔了多久」这条信息
   * 永远作废（渲染成 0 秒）。而重启是常态——升级、改配置、改代码都重启。
   */
  hydrate(state: {
    nightPushedDay?: string | null;
    longPushedSessionAt?: number | null;
    lastPlayingAt?: number | null;
  }): void {
    if (state.nightPushedDay) this.nightPushedDay = state.nightPushedDay;
    if (typeof state.longPushedSessionAt === 'number' && state.longPushedSessionAt > 0) {
      this.longPushedSessionAt = state.longPushedSessionAt;
    }
    // 只接"合理"的值：将来的时刻、或者 0/负数，都是坏数据，宁可不接（→ 未知）。
    if (typeof state.lastPlayingAt === 'number' && state.lastPlayingAt > 0 && state.lastPlayingAt <= Date.now()) {
      this.lastPlayingAt = state.lastPlayingAt;
    }
  }

  dump(): {
    nightPushedDay: string | null;
    longPushedSessionAt: number | null;
    lastPlayingAt: number | null;
  } {
    return {
      nightPushedDay: this.nightPushedDay,
      longPushedSessionAt: this.longPushedSessionAt,
      lastPlayingAt: this.lastPlayingAt,
    };
  }

  state(): NowState {
    const recentlyPlaying = this.lastPlayingAt !== null
      && this.lastTickAt !== null
      && this.lastTickAt - this.lastPlayingAt < 5000;
    return {
      track: this.track,
      playing: recentlyPlaying,
      startedAt: this.startedAt,
      playedMs: Math.round(this.playedMs),
      sessionPlayedMs: Math.round(this.sessionPlayedMs),
      sessionStartedAt: this.sessionStartedAt,
      indexInSession: this.indexInSession,
      loopCount: this.lastKey ? (this.loopCounts.get(this.lastKey) ?? 1) : 0,
      posSec: this.posSec,
      durSec: this.durSec,
      lastPlayingAt: this.lastPlayingAt,
      segmentsSaid: this.segIndex,
    };
  }

  /**
   * 这一段的长度。
   *
   * 不按"固定 45 秒"切，因为歌长差得太远：3 分半的流行歌 45 秒一段是 4 段，还行；
   * 15 分钟的古典曲同一把尺子会切出 20 条——那不是陪听，那是弹幕，而且是会被
   * 整体静音掉的那种噪音。所以换个算法：**先定每首最多说几段，段长再跟着时长走**。
   *
   *   len(1)    = segmentEverySec
   *   len(i>1)  = (曲长 − segmentEverySec) / maxSegments   ← 只在长曲时启用
   *
   * 分母用 maxSegments 而不是 maxSegments−1：多出来那一份是留给结尾的空位，
   * 否则最后一段的触发点会正好落在"歌曲结束的那一秒"，永远赶不上。尾奏响着的
   * 时候本来也不该有人说话。
   *
   * 几个实例（默认 45 秒下限 / 3 段）：
   *   3:30 → 0:45 / 1:40 / 2:35，最后 55 秒留白
   *   3:00 → 0:45 / 1:30 / 2:15
   *   2:00 → 0:45 / 1:30，第三段落在歌外，不触发
   *   15:00（古典）→ 0:45 / 5:30 / 10:15，最后 4:45 留白
   *
   * 第 1 段固定用下限，不参与均分：换歌之后要尽快表态。古典曲动辄一个乐章十分钟，
   * 如果第 1 段也按均分走，他要等四分钟才听见第一句话——那不叫陪着听，那叫失联。
   * 之后几段再按"剩余时长 / 段数"拉开。
   */
  segLen(index: number, durSec: number | null = this.durSec): number {
    const base = this.opts.segmentEverySec;
    if (!base || base <= 0) return Number.POSITIVE_INFINITY;
    const maxSeg = Math.max(1, Math.trunc(this.opts.maxSegmentsPerTrack));
    if (index > maxSeg) return Number.POSITIVE_INFINITY;

    let seconds = base;
    const dur = durSec && Number.isFinite(durSec) && durSec > 0 ? durSec : null;
    // 短曲（按 base 切不超过它自己的段数上限）就老老实实一段一段来；
    // 长曲才把剩下几段摊开，否则 15 分钟的歌会被切成 20 条。
    if (index > 1 && dur && dur > base * maxSeg) {
      // 分母仍是 maxSeg 而不是 maxSeg-1：多出来那一份是留给结尾的空位。
      seconds = (dur - base) / maxSeg;
    }
    // 抖动幅度跟着段长走（±1/3，封顶 15 秒）：短歌 ±15 秒，五分钟一段的长曲也就 ±15 秒。
    // 15 分钟一段还抖 15 秒等于没抖，但那本来就不需要"随机感"。
    const amp = Math.min(15, Math.max(1, Math.round(Math.min(base, seconds) / 3)));
    return Math.max(15, seconds + segmentJitter(this.lastKey ?? '', index, amp)) * 1000;
  }

  /**
   * 重新起算段位。
   *
   * 正常换歌时 `playedMs` 是 0，段号从第 1 段开始，没毛病。
   * 但"这一首是听到一半才被看见的"（Core 重启、扩展刚装上、刚落盘恢复）时，
   * `playedMs` 是按播放进度补的。这时候还从第 1 段数，就会推出
   * "第 1 段（0:00 → 0:52）"——而歌其实已经放到 3:10 了。
   *
   * 实测后果比"不精确"严重得多：她看到同一首歌反复冒出"第 1 段"、位置还每次不同，
   * 推理成"这个源在重复推已经发生的事"，然后整体静音。所以这里把已经走过的时间
   * 按段长折算成段号：该是第 3 段就标第 3 段。
   */
  private resetSegments(durSec: number | null): void {
    const maxSeg = Math.max(1, Math.trunc(this.opts.maxSegmentsPerTrack));
    this.segIndex = 0;
    this.segStartMs = 0;
    this.segCursorMs = this.segLen(1, durSec);
    while (this.segIndex < maxSeg && this.playedMs >= this.segCursorMs) {
      const next = this.segLen(this.segIndex + 2, durSec);
      if (!Number.isFinite(next)) break;
      this.segIndex += 1;
      this.segStartMs = this.segCursorMs;
      this.segCursorMs += next;
    }
    // 说到上限了：后面不再切，把游标推到无穷，免得 15 分钟的曲子在末尾又冒出一段。
    if (this.segIndex >= maxSeg) this.segCursorMs = Number.POSITIVE_INFINITY;
  }

  /** 吃一跳。snapshot 为选中的那一场会话（没有播放器就是 null）。 */
  feed(ts: number, snapshot: SessionSnapshot | null): FeedResult {
    const signals: Signal[] = [];
    let finished: FinishedTrack | null = null;
    const wasPrimed = this.primed;
    this.primed = true;
    const playing = !!snapshot && snapshot.status === 'playing' && !!snapshot.title;

    if (playing && snapshot) {
      const next: Track = {
        app: snapshot.app,
        title: snapshot.title,
        artist: snapshot.artist || '',
        album: snapshot.album || '',
      };
      const key = trackKey(next);
      const gap = this.lastPlayingAt === null ? Infinity : ts - this.lastPlayingAt;

      if (this.sessionStartedAt !== null && gap > this.opts.newSessionGapMs) {
        // 时间断层 = 新的一场。水位全部归零，否则第二场会一直被第一场的水位压着不出声。
        this.resetSession();
      }
      if (this.sessionStartedAt === null) {
        this.sessionStartedAt = ts;
        this.sessionPlayedMs = 0;
        this.indexInSession = 0;
        this.loopCounts.clear();
        this.skips = [];
        // 时间断层之后，上一段的计时一律作废。这一步不只清水位：进程可能被挂起过，
        // 那一跳的间隔是假的（人没在听），照它累加会让段游标一醒来就越过好几段、
        // 立刻补发一条"这一段"——正是最蠢的那种效果。所以这里把这一首从头算，
        // 并把 lastTickAt 置空，让后面那一跳的步长为 0。
        this.playedMs = 0;
        this.resetSegments(snapshot.durSec);
        this.lastTickAt = null;
        if (wasPrimed) {
          signals.push({
            kind: 'start',
            track: next,
            // Infinity = 手上没有上一次的播放时刻 → null（未知），不是 0。
            // 0 留着表示"真的刚刚还在听"，两者不能混。
            silenceMin: Number.isFinite(gap) ? Math.round(gap / 60_000) : null,
          });
        }
      }

      if (key !== this.lastKey) {
        const prev = this.track;
        const prevPlayed = Math.round(this.playedMs);
        if (prev && this.startedAt !== null) {
          finished = { track: prev, startedAt: this.startedAt, playedMs: prevPlayed };
          if (this.playedMs < SKIP_UNDER_MS) this.skips.push({ ts, playedMs: prevPlayed });
        }
        this.track = next;
        this.lastKey = key;
        this.startedAt = ts;
        // 这一场的第一首可能是听到一半才被我们看见的：用播放器给的进度把"已经放了多久"
        // 补上（只在这一场还没累计过时补，之后的每一首都是从 0 开始，墙钟就准了）。
        // 进度不可信时补 0 而已，不会算出负数。
        this.playedMs = this.sessionPlayedMs === 0 ? seedPlayedMs(snapshot) : 0;
        this.indexInSession += 1;
        // 第一首可能已经放到一半了：段号按进度折算，别让"第 1 段"出现在 3:10 的地方。
        this.resetSegments(snapshot.durSec);
        const count = (this.loopCounts.get(key) ?? 0) + 1;
        this.loopCounts.set(key, count);

        if (prev) {
          signals.push({
            kind: 'track',
            track: next,
            prev,
            indexInSession: this.indexInSession,
            artistChanged: (prev.artist || '') !== (next.artist || ''),
            prevPlayedMs: prevPlayed,
          });
        }
        if (count >= 3) signals.push({ kind: 'loop', track: next, count });
      } else {
        const step = this.lastTickAt === null ? 0 : Math.max(0, Math.min(ts - this.lastTickAt, MAX_STEP_MS));
        this.playedMs += step;
        this.sessionPlayedMs += step;
      }

      // 段节拍。用"这一首累计播放了多少毫秒"判，不用墙钟：暂停期间 playedMs 不动，
      // 所以恢复播放不会立刻补发一堆段。只发一条——真断了（休眠、长时间卡顿）后来补发
      // 一串"这一段"是最蠢的效果，宁可把游标直接追到当前。
      if (this.playedMs >= this.segCursorMs) {
        if (wasPrimed) {
          // 正常到这里：这一首这一段确实走完了，出声。
          this.segIndex += 1;
          signals.push({
            kind: 'segment',
            track: next,
            index: this.segIndex,
            fromSec: Math.round(this.segStartMs / 1000),
            toSec: Math.round(this.playedMs / 1000),
            posSec: snapshot.posSec,
            durSec: snapshot.durSec,
            // 相位用播放器报的位置算；报的位置缺失时退回"这一首累计放了多少"。
            phase: phaseOf(snapshot.posSec, snapshot.durSec)
              ?? phaseOf(Math.round(this.playedMs / 1000), snapshot.durSec),
            indexInSession: this.indexInSession,
            loopCount: this.loopCounts.get(key) ?? 1,
          });
        }
        // else：起来的第一跳只对账，不出声。这一跳的间隔可能是假的（进程刚拉起、
        // 机器刚唤醒），这时候推一条"这一段刚放完"，在她眼里就是"扩展一重启就冒一条"。
        // 注意不能在这儿 return —— 下面的 posSec / durSec / lastPlayingAt 还必须写，
        // 漏了 lastPlayingAt 会让下一跳把 gap 判成 Infinity，把整场重置掉。
        this.segStartMs = this.playedMs;
        this.segCursorMs = this.playedMs + this.segLen(this.segIndex + 1, snapshot.durSec);
      }

      this.posSec = snapshot.posSec;
      this.durSec = snapshot.durSec;
      this.lastPlayingAt = ts;

      this.skips = this.skips.filter((s) => ts - s.ts <= FIDGET_WINDOW_MS);
      if (this.skips.length >= FIDGET_MIN_SKIPS) {
        const skipped = this.skips.length;
        this.skips = [];
        signals.push({ kind: 'fidget', skipped, windowMin: Math.round(FIDGET_WINDOW_MS / 60_000) });
      }

      const clock = clockParts(this.opts.timezone, ts);
      if (isNightHour(clock.hour, this.opts.nightFrom) && this.nightPushedDay !== clock.day) {
        this.nightPushedDay = clock.day;
        signals.push({ kind: 'night', track: next, hour: clock.hour });
      }

      const longMs = Math.max(10, this.opts.longMinutes) * 60_000;
      if (this.sessionPlayedMs >= longMs && this.longPushedSessionAt !== this.sessionStartedAt) {
        this.longPushedSessionAt = this.sessionStartedAt;
        signals.push({ kind: 'long', track: next, minutes: Math.round(this.sessionPlayedMs / 60_000) });
      }

      this.lastTickAt = ts;
      return { signals, finished };
    }

    /* ---- 没在放 ---- */
    const silentFor = this.lastPlayingAt === null ? Infinity : ts - this.lastPlayingAt;
    if (this.track && silentFor > this.opts.newSessionGapMs) {
      // 停了很久：这一首就此收尾，下一首算新的一场。
      finished = this.flush(ts);
    }
    this.lastTickAt = ts;
    return { signals, finished };
  }

  /**
   * 结算当前曲目并从内存里清掉，返回它供落库。
   * 换歌、停机、停太久都走这一个出口，避免"第几遍""听了多久"在多处各算一遍。
   */
  flush(at: number): FinishedTrack | null {
    const track = this.track;
    if (!track || this.startedAt === null) {
      this.resetSession();
      return null;
    }
    const rec: FinishedTrack = { track, startedAt: this.startedAt, playedMs: Math.round(this.playedMs) };
    this.track = null;
    this.lastKey = null;
    this.startedAt = null;
    this.playedMs = 0;
    this.posSec = null;
    this.durSec = null;
    this.lastPlayingAt = null;
    this.lastTickAt = at;
    this.segIndex = 0;
    this.segStartMs = 0;
    this.segCursorMs = Number.POSITIVE_INFINITY;
    this.resetSession();
    return rec;
  }

  /** 新的一场：只清水位，不动"已经报过深夜"这类按天/按场去重的持久标记之外的东西。 */
  private resetSession(): void {
    this.sessionStartedAt = null;
    this.sessionPlayedMs = 0;
    this.indexInSession = 0;
    this.loopCounts.clear();
    this.skips = [];
    this.longPushedSessionAt = null;
  }
}
