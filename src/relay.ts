/**
 * 接力点歌：她递一首，你按下播放，剩最后一段时她把下一首递过来。
 *
 * 为什么要有「状态」这个东西：她能搜、能挑，唯独按不了播放（实测记录在 picker.ts 头部）。
 * 所以"连续"只能做成接力 —— 每一棒都得你点一下。而代码这一侧必须记住两件事：
 *   1. 现在在放的这首，是不是**她点的**那首（不然她一晚上都在替别人的歌接话）
 *   2. 这一链已经递到第几棒了（不然她整晚霸着点歌台）
 *
 * 状态留本机（dataDir），**不进记忆目录**：它描述的是「现在这根链子在哪一棒」，
 * 不是「发生过的事」。两台机器共写一份只会互相把对方那一棒盖掉 —— 同 storage.ts 的分工。
 *
 * 纯逻辑，不碰文件、不碰网络；落盘由 world.ts 负责。这样判定能被单测钉住。
 */
import { matchScore } from './lyrics.ts';
import { bareTitle, type TrackSource } from './picker.ts';

/** 她递出去的那一棒。字段只留"以后还要用到"的：匹配靠歌名歌手，递链接靠 url。 */
export interface RelayPick {
  title: string;
  artist: string;
  source: string;
  url: string;
  durSec: number;
}

export interface RelayState {
  /** 这一链什么时候开的（epoch ms）。 */
  startedAt: number;
  /** 已经递出去几首（含当前这一首）。连满上限就不再提醒。 */
  count: number;
  /** 最近一次递出去的歌。判"现在放的是不是她点的"靠它。 */
  last: RelayPick | null;
  /** 最近一次递出去的时刻。用来判这条链是不是已经凉了。 */
  lastAt: number;
  /** 已经提醒过的那一棒。同一首只提醒一次，不跟着采样反复劝。 */
  firedFor: string;
  /**
   * 这一棒他到底播了没有。
   *
   * 为什么要有它：`count` 原来在每次"她递一首"时就 +1，于是**递了没播的也算一棒**。
   * 2026-10-29 实测：23:05 她挑了《钟》、他没放（自己开了电脑操作另找了一首），
   * 23:12 又挑《No. 2》，链已经数到 2 —— 连挑三首没播就满了 6，之后再也不提醒，
   * 而用户看不到任何报错，只知道"连续点歌忽然不灵了"。
   * 现在：上一棒没播过，新的这一首**替换**它，不占名额。
   */
  lastPlayed: boolean;
}

export const EMPTY_RELAY: RelayState = {
  startedAt: 0, count: 0, last: null, lastAt: 0, firedFor: '', lastPlayed: false,
};

/**
 * 一条链多久不用就作废。半小时：够连着听五六首，也够他中途去干别的再回来。
 * 定太短会在"接了个电话回来接着听"时把链子掐断；定太长，第二天早上她还在劝你接下一棒。
 */
export const RELAY_IDLE_MS = 30 * 60_000;

/**
 * 剩多少秒递下一棒。35 秒是算过的：
 *   - 她搜一次实测 0.9–1.6 秒（见 picker.ts），加上打字说话，10 秒内能说完；
 *   - 剩 35 秒说"快完了"是实话，不会变成催促（段位文案里"尾奏快了"那个坑的教训）；
 *   - 留 25 秒给他决定接不接 —— 太短就成了"你必须现在决定"。
 */
export const RELAY_LEAD_SEC = 35;

/** 一链最多递几首。连满就自己收，第二天想点会重新开一条链。 */
export const RELAY_MAX_CHAIN = 6;

/**
 * 播出这么多秒之后才认"他真的在听这首"。
 * 刚点开两秒就判"快完了"是荒唐的 —— 那多半是上一首的尾巴或者播放器在预载。
 */
const MIN_PLAYED_SEC = 20;

/**
 * 匹配阈值。歌词那边用 65（对不上就宁可不给词），这里放宽到 55：
 * 他放的可能是个现场版、合集版，标题尾巴不一样，但**是同一首**。
 */
const MATCH_MIN = 55;

/** 指纹：同一首歌的两个版本按"摘掉书名号和版本尾巴的歌名"算同一棒。 */
function keyOf(title: string, artist: string): string {
  return `${bareTitle(title).trim().toLowerCase()}\u0001${artist.trim().toLowerCase()}`;
}

/**
 * 她递出一棒。已经是旧链、或者连满了，就开一条新的。
 *
 * 连满 6 首之后再点，count 从 1 重新数 —— 也就是"他主动又要了一轮"，
 * 而不是"第 7 棒"。这两种语义不一样：前者说明他还想听，后者只是数字变大。
 *
 * **上一棒没播过就不累加**（见 `lastPlayed`）：她连着挑、他一直没放，
 * 那不是"接了六棒"，是"挑了六次"。按替换算，链才不会假满。
 */
export function relayArm(
  prev: RelayState | null,
  pick: RelayPick,
  at: number,
  maxChain = RELAY_MAX_CHAIN,
): RelayState {
  const stale =
    !prev ||
    !prev.last ||
    at - prev.lastAt > RELAY_IDLE_MS ||
    prev.count >= maxChain;
  if (stale) {
    return { startedAt: at, count: 1, last: pick, lastAt: at, firedFor: '', lastPlayed: false };
  }
  // 上一棒他没点开：这一首顶替它。count 不涨 —— 涨了就是在数"她说了几次"，不是"他听了几首"。
  const count = prev.lastPlayed ? prev.count + 1 : Math.max(1, prev.count);
  return { ...prev, count, last: pick, lastAt: at, firedFor: '', lastPlayed: false };
}

/**
 * 一首歌被切过来之后至少过这么久才判"快完了"。
 *
 * 两个理由，都在 2026-10-29 撞到过：
 *
 * 1. **顺序。** 同一个采样里，`music.track` 要等歌词（最多 2.6 秒），`music.relay` 不用等，
 *    于是 relay 会**抢在 track 前面**推出去 —— 他收到的是"你这首快完了"，然后才是
 *    "换歌了：这是《No. 2》"。实测 23:12:38.555 relay、23:12:39.217 track，差 0.66 秒。
 * 2. **续播。** 他点开一首上次听到一半的歌，播放器直接从 3:54 接上，剩 32 秒。
 *    这时候 position 一上来就满足"剩 ≤ 35 秒"，她会立刻说"快完了"——技术上没错，
 *    但听起来像她根本没听。等 5 秒，至少让那句"换歌了"先落地。
 */
const SETTLE_MS = 5000;

export interface PlayingNow {
  title: string;
  artist: string;
  app: string;
  posSec: number | null;
  durSec: number | null;
  /**
   * 这一首被看到多久了（tracker 的 `playedMs`，本次收听累计）。
   * 缺省当 0 —— 保守，宁可晚一轮也不抢在换歌事件前面。
   */
  playedMs?: number;
}

export interface RelayVerdict {
  fire: boolean;
  /** 还剩多少秒。只有 fire 时才有意义。 */
  remainSec: number;
  /** 不触发的原因，只给日志和排障用。正常"还没到时候"是空串，不当成错误。 */
  why: string;
}

/**
 * 该不该现在递下一棒。
 *
 * `why` 的空串是"还没到时候"（正常），非空是"这条链现在不该动"（异常或已用完）。
 * 分这两种是因为排障时要看的是后者 —— 每秒一次采样，正常的空串不该刷屏。
 */
export function relayShouldFire(
  state: RelayState | null,
  at: number,
  now: PlayingNow,
  opts: { leadSec?: number; maxChain?: number } = {},
): RelayVerdict {
  const lead = opts.leadSec ?? RELAY_LEAD_SEC;
  const max = opts.maxChain ?? RELAY_MAX_CHAIN;
  const no = (why: string): RelayVerdict => ({ fire: false, remainSec: 0, why });

  if (!state || !state.last) return no('没有点过的歌');
  if (at - state.lastAt > RELAY_IDLE_MS) return no('这条链已经隔太久了');
  if (state.count >= max) return no(`已经连了 ${max} 首，该收了`);
  // 先等它落地：这一首刚被切过来时，换歌那条事件可能还在等歌词没发出去。
  if ((now.playedMs ?? 0) < SETTLE_MS) return no('');

  const { posSec, durSec } = now;
  if (posSec === null || durSec === null) return no('读不到进度');
  if (!Number.isFinite(posSec) || !Number.isFinite(durSec)) return no('进度不是个正常的数');
  // 短于 60 秒没有"最后一段"这个窗口：铃声、试听片段，判了也是瞎判。
  if (durSec < 60) return no('这首太短，没有"快完了"这一段');

  const score = matchScore(
    {
      title: state.last.title,
      artist: state.last.artist,
      source: (state.last.source === 'qq' ? 'qq' : 'netease') as TrackSource,
      durSec: state.last.durSec,
    },
    { title: now.title, artist: now.artist, app: now.app, durSec },
  );
  if (score < MATCH_MIN) return no('现在放的这首不是她递的');
  if (state.firedFor === keyOf(now.title, now.artist)) return no('这一棒已经递过了');
  if (posSec < MIN_PLAYED_SEC) return no('才刚开始放');

  const remainSec = Math.round(durSec - posSec);
  if (remainSec <= 0) return no('已经放完了');
  if (remainSec > lead) return no('');
  return { fire: true, remainSec, why: '' };
}

/**
 * 记下「这一棒已经提醒过」。
 *
 * 单独一个函数、而不是让上层自己拼指纹：`firedFor` 的算法必须和 `relayShouldFire`
 * 里比对的那一套**逐字一致**（都用摘掉版本尾巴的歌名），两边各写一份迟早会错开，
 * 症状就是"同一首歌被劝两遍"——而这类错没有报错，只有重复。
 */
export function relayMarkFired(state: RelayState, title: string, artist: string): RelayState {
  return { ...state, firedFor: keyOf(title, artist) };
}

/**
 * 现在这一棒是不是她点的那首。
 *
 * **不要求进度。** 它判的是"他到底放没放这首"，不是"放到哪了"——所以网易云（走窗口标题、
 * 没有 posSec/durSec）也能判。判得出来才好记账（`lastPlayed`），否则那条链在网易云那边
 * 永远算"没播过"。
 */
export function relayHolds(now: PlayingNow, state: RelayState | null): boolean {
  if (!state?.last) return false;
  return matchScore(
    {
      title: state.last.title,
      artist: state.last.artist,
      source: (state.last.source === 'qq' ? 'qq' : 'netease') as TrackSource,
      durSec: state.last.durSec,
    },
    { title: now.title, artist: now.artist, app: now.app, durSec: now.durSec ?? 0 },
  ) >= MATCH_MIN;
}

/** 落盘前收一下：字段可能被旧版本写成别的东西，读回来时一律按现在的形状取。 */
export function sanitizeRelay(raw: unknown): RelayState {
  const o = (raw ?? {}) as Partial<RelayState>;
  const last = o.last && typeof o.last === 'object' ? (o.last as Partial<RelayPick>) : null;
  const kept = last && typeof last.title === 'string' && last.title ? last : null;
  // 没有 `lastPlayed` 这个字段 = 0.4.0 之前写下的状态。那时候的 count 数的是
  // "她递了几次"（递了没播也算），直接拿来做上限判断会假满。所以旧数据一律退回 1。
  const hasFlag = Object.prototype.hasOwnProperty.call(o, 'lastPlayed');
  const rawCount = Number(o.count);
  return {
    startedAt: Number.isFinite(Number(o.startedAt)) ? Number(o.startedAt) : 0,
    count: hasFlag
      ? (Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0)
      : (kept ? 1 : 0),
    last: kept
      ? {
        title: String(kept.title),
        artist: String(kept.artist ?? ''),
        source: String(kept.source ?? ''),
        url: String(kept.url ?? ''),
        durSec: Number(kept.durSec) || 0,
      }
      : null,
    lastAt: Number.isFinite(Number(o.lastAt)) ? Number(o.lastAt) : 0,
    firedFor: typeof o.firedFor === 'string' ? o.firedFor : '',
    lastPlayed: o.lastPlayed === true,
  };
}
