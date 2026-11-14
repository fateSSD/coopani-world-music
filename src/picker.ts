/**
 * 自己找歌：搜、挑、给链接。
 *
 * 这里有搜和挑，**故意没有放**。理由不是没做，是做不到 —— 2026-10-26 在本机
 * 逐条实测过，两个客户端都把外部点播通道关了：
 *
 *   网易云 3.1.42   orpheus:// 连 URL Protocol 都没注册；补上 HKCU 声明后
 *                   Start-Process 能把 `cloudmusic.exe --webcmd="orpheus://song/<id>/?autoplay=1"`
 *                   拉起来（进程号都抓到了，退出码 0），主实例静默丢弃。
 *                   换 --webcmd / -webcmd / --startup-url / --orpheus-startup 组合、
 *                   连 orpheus://radio（私人 FM）都不动。
 *   QQ 音乐 22.76   qqmusic:// 同样没注册；补注册表指向 QQMusicExternal.exe 后无反应。
 *                   保留的 QQMusicSvr.QQMusicPlayer COM 接口能实例化，但
 *                   Play/GetPlayItemCount/GetCurrentPlaySongID 全部返回 0——空壳。
 *
 * 所以 playAttempt() 现在恒返回 false。**别删这个函数**：它是唯一的口子，
 * 哪天哪个播放器把协议放回来，改这里一个函数就能复活，上层不用动。
 *
 * 能做的两件事都是真能做的（也实测过）：
 *   网易云搜索  music.163.com/api/search/get/web          通
 *   QQ  搜索    c.y.qq.com/soso/fcgi-bin/client_search_cp  通
 */
import type { PlayerPref } from './players.ts';

export type TrackSource = 'netease' | 'qq';

/** 一首搜到的歌。字段全用原始值，不做"美化"——歌名带书名号、歌手带斜杠都是常态。 */
export interface Track {
  source: TrackSource;
  /** 网易云是数字歌曲 id，QQ 音乐是数字 songid。统一成字符串，省得判类型。 */
  id: string;
  /** QQ 音乐的 songmid。网易云没有，空着。 */
  mid: string;
  title: string;
  artist: string;
  album: string;
  /** 时长（秒）。0 表示接口没给。 */
  durSec: number;
  url: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NETEASE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  // appver 这个 cookie 不给的话，接口会退化成精简结构（没有 album）。
  Cookie: 'appver=2.0.2',
};

const QQ_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Referer: 'https://y.qq.com/',
};

/** 搜索超时。走的是公网接口，别让一次网络抖动卡住整轮对话。 */
const SEARCH_TIMEOUT_MS = 6000;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 去掉书名号，好让「时光」和「《时光》」算同一首。 */
export function bareTitle(title: string): string {
  return title.replace(/^[《「【\[]+|[》」】\]]+$/g, '').trim();
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function searchNetease(kw: string, limit = 8, timeoutMs = SEARCH_TIMEOUT_MS): Promise<Track[]> {
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(kw)}&type=1&offset=0&limit=${limit}`;
  const data = await fetchJson(url, NETEASE_HEADERS, timeoutMs);
  // code 非 200 要**抛错**，不能当成"没搜到"返回空数组。
  //
  // 实测：短时间连续搜索会返回 `code: 405`（风控），响应 200、几十毫秒就回来。
  // 第一版直接 `if (!Array.isArray(songs)) return []`，于是上层看到的是
  // "网易云没有这首" —— 而真相是"网易云不让问了"。这两件事必须分开：
  // 前者会让人以为曲库里没有，后者等一会儿重试就好。
  if (data?.code !== undefined && Number(data.code) !== 200) {
    throw new Error(`网易云返回 ${data.code}${Number(data.code) === 405 ? '（搜太频，被限流）' : ''}`);
  }
  const songs = data?.result?.songs;
  if (!Array.isArray(songs)) return [];
  const out: Track[] = [];
  for (const s of songs) {
    const title = str(s?.name);
    if (!title) continue;
    const id = String(s?.id ?? '');
    if (!id) continue;
    const artists = Array.isArray(s?.artists) ? s.artists.map((a: any) => str(a?.name)).filter(Boolean) : [];
    out.push({
      source: 'netease',
      id,
      mid: '',
      title,
      artist: artists.join('/'),
      album: str(s?.album?.name),
      durSec: Math.round(Number(s?.duration ?? 0) / 1000) || 0,
      url: `https://music.163.com/song?id=${id}`,
    });
  }
  return out;
}

export async function searchQQ(kw: string, limit = 8, timeoutMs = SEARCH_TIMEOUT_MS): Promise<Track[]> {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=${limit}&p=1&w=${encodeURIComponent(kw)}&new_json=1&cr=1&t=0`;
  const data = await fetchJson(url, QQ_HEADERS, timeoutMs);
  const list = data?.data?.song?.list;
  if (!Array.isArray(list)) return [];
  const out: Track[] = [];
  for (const s of list) {
    const title = str(s?.name) || str(s?.title);
    if (!title) continue;
    const mid = str(s?.mid);
    const id = String(s?.id ?? '');
    const singers = Array.isArray(s?.singer) ? s.singer.map((a: any) => str(a?.name)).filter(Boolean) : [];
    out.push({
      source: 'qq',
      id,
      mid,
      title,
      artist: singers.join('/'),
      album: str(s?.album?.name),
      durSec: Number(s?.interval ?? 0) || 0,
      // 有 mid 就落到歌曲详情页，没有就退回搜索页——两个链接都能在浏览器里直接播。
      url: mid
        ? `https://y.qq.com/n/ryqq/songDetail/${mid}`
        : `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(title)}`,
    });
  }
  return out;
}

/**
 * 按偏好把两边都搜一遍。
 *
 * `auto` 不是"随便挑一个源"，是两个源都搜、结果并起来再挑——两个库的覆盖面不一样，
 * 有些老歌只有一边有。某一边超时或报错不算失败，只要有另一边有结果就继续，
 * 但错误会带回去，让人知道是"两边都没有"还是"有一边没连上"。
 */
export async function searchAll(
  kw: string,
  opts: { source: PlayerPref; limit?: number; timeoutMs?: number },
): Promise<{ tracks: Track[]; problems: string[] }> {
  const limit = opts.limit ?? 8;
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const want = opts.source;
  const jobs: Array<Promise<Track[]>> = [];
  const labels: string[] = [];
  if (want === 'auto' || want === 'qq') {
    jobs.push(searchQQ(kw, limit, timeoutMs));
    labels.push('QQ音乐');
  }
  if (want === 'auto' || want === 'netease') {
    jobs.push(searchNetease(kw, limit, timeoutMs));
    labels.push('网易云音乐');
  }
  const settled = await Promise.allSettled(jobs);
  const tracks: Track[] = [];
  const problems: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') tracks.push(...r.value);
    else problems.push(`${labels[i]}没连上（${String((r.reason as Error)?.message ?? r.reason).slice(0, 60)}）`);
  });
  return { tracks, problems };
}

/**
 * 从候选里挑一首。规则故意简单，因为解释得清比"聪明"重要：
 *   1. 太短的不要（30 秒以下基本是铃声/试听片段，点进去不是完整的一首）
 *   2. 标题跟搜的词一模一样的优先
 *   3. 其次标题包含关系（「时光」命中「时光(Live)」）
 *   4. 都没有就用第一条
 */
export function pickBest(tracks: readonly Track[], query: string): Track | null {
  const usable = tracks.filter((t) => t.durSec === 0 || t.durSec >= 30);
  if (usable.length === 0) return null;
  const q = bareTitle(query).toLowerCase();
  if (q) {
    const exact = usable.find((t) => bareTitle(t.title).toLowerCase() === q);
    if (exact) return exact;
    const loose = usable.find((t) => {
      const title = bareTitle(t.title).toLowerCase();
      return title.includes(q) || q.includes(title);
    });
    if (loose) return loose;
  }
  return usable[0];
}

export interface PlayAttempt {
  ok: boolean;
  /** 没放成的原因。必须具体到"试了什么"，不然会变成一句空话。 */
  reason?: string;
}

/**
 * 尝试真的把这首放出来。
 *
 * 恒 false —— 原因见文件头。留这个函数是为了让上层（world.ts 的 pickText）
 * 不用关心"未来某天能放了"这件事：真有那天，改这里就够了。
 */
export async function playAttempt(track: Track): Promise<PlayAttempt> {
  const who = track.source === 'qq' ? 'QQ 音乐' : '网易云音乐';
  return {
    ok: false,
    reason: `${who}这一版不接受从外部点播（协议试过，客户端不理），所以只能把歌找出来给你`,
  };
}

/** 一首歌的一行描述，工具回执和笔记都用它。 */
export function describeTrack(t: Track): string {
  const head = t.artist ? `《${t.title}》 — ${t.artist}` : `《${t.title}》`;
  const extra: string[] = [];
  if (t.album) extra.push(`专辑《${t.album}》`);
  if (t.durSec > 0) extra.push(formatDur(t.durSec));
  return extra.length ? `${head}（${extra.join('，')}）` : head;
}

export function formatDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

export function sourceLabel(source: TrackSource): string {
  return source === 'qq' ? 'QQ音乐' : '网易云音乐';
}
