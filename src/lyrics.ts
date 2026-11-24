/**
 * 歌词：让她知道这一句唱的是什么。
 *
 * 为什么值得单独一个模块：她能读到的只有「歌名 — 歌手」（网易云连进度都没有），
 * 而歌词是唯一能让她在**歌的内容**这一层说话的原材料。没有它，一段四十五秒里
 * 她能说的只有"鼓点不错""这首挺吵"——那不是陪听，那是在描述音色。
 *
 * 链路（每一环都实测过，2026-10-26）：
 *
 *   1. 反查 id   手上只有歌名+歌手，没有 id。所以拿歌名+歌手去搜一次，
 *                从候选里挑最像的那条 —— **这一步必须严**，见 matchScore()。
 *   2. 取词      netease  music.163.com/api/song/lyric?id=<id>&lv=1&tv=-1      通
 *                qq       c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg      通
 *                两家都返回带时间轴的 LRC，网易云的词更干净（没有隔行空标记）。
 *   3. 对齐      按当前播放位置取"刚唱过的那一两句"。
 *
 * 三条硬规矩，写在这里免得以后被"优化"掉：
 *
 *   - **对不上就不给。** 搜索接口按歌名模糊匹配，返回的第一条经常是翻唱、
 *     伴奏、同名不同曲。给错歌词比不给糟得多：她会对着 A 歌的词评 B 歌，
 *     而且听上去毫无破绽，用户根本发现不了是数据的错。所以打分低于阈值宁可返回 null。
 *   - **"没有词"只能由接口的明确标记下结论。** 只有网易云回 `nolyric` / `uncollected`
 *     才算这首没有词（instrumental: true），她会照实说；QQ 那边从不给这种标记，
 *     所以一律只区分"拿到"和"没拿到"。**抓取失败绝不能被说成"这首没词"** ——
 *     2026-10-29 就栽在这上面：接口回 -1901 拿回空串，解析出 0 行标成纯音乐，
 *     她对着有词的《雪の華》说"这首没词"。宁可这一句不带词，也不能说假话。
 *   - **歌词是版权内容。** 只取当前一两行用于评论（引用），不整段落地给人看。
 *     落盘的缓存只为本机复用，数据页签可以一键清。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bareTitle, searchNetease, searchQQ, type Track, type TrackSource } from './picker.ts';

/**
 * 查歌词需要的最小信息。
 *
 * 故意不收 picker 的 Track：调用方是世界层，手上只有 tracker 的 Track
 * （app/title/artist/album，没有 id 也没有 durSec）。要 id 是为了播放，查词不需要。
 */
export interface LyricInput {
  app: string;
  title: string;
  artist: string;
  /** 时长（秒）。有就拿来卡"同一版录音"，没有就只凭歌名歌手。 */
  durSec?: number;
}

export interface LyricLine {
  /** 这首歌播到第几秒时这一句开始。 */
  t: number;
  text: string;
}

export interface LyricDoc {
  source: TrackSource;
  /** 网易云的 id 或 QQ 音乐的 mid。 */
  id: string;
  title: string;
  artist: string;
  lines: LyricLine[];
  /** 纯音乐、或词库没有这首的词。lines 必为空。 */
  instrumental: boolean;
  fetchedAt: number;
}

/** 单行歌词在事件正文里的长度上限。有的一行能从主歌一路唱到副歌。 */
const MAX_LINE_CHARS = 46;

/** 匹配阈值。低于它的候选一律不要——见文件头「对不上就不给」。 */
const MIN_SCORE = 70;

/** 一次歌词抓取的总预算。超时就算没有，别让一次网络抖动拖住事件推送。 */
const FETCH_TIMEOUT_MS = 4000;

/**
 * 网易云限流后的冷却时间。
 *
 * 实测：短时间连续搜索会返回 code 405，响应 200、几十毫秒就回来，而且**要等好几分钟**才恢复
 * （我用十几次手测把本机封了将近十分钟）。既然封就是一段时间，撞上去再撞第二次没有任何收益，
 * 只会让恢复更晚 —— 所以记住这个窗口，期间直接走另一家。
 *
 * 进程级变量，重启扩展就清空。重启本来就不频繁，够用。
 */
let neteaseCooldownUntil = 0;
const NETEASE_COOLDOWN_MS = 5 * 60_000;

const NETEASE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Cookie: 'appver=2.0.2',
};

const QQ_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/portal/player.html',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 归一化：只留字，去掉空格和所有标点。
 *
 * 目的是让这些算同一首：
 *   「是但求其爱」/「是但求其爱 (The Search)」/「《是但求其爱》」
 * 但不能让「是但求其爱（翻唱完整版）」算成 100 分 —— 所以打分里还有惩罚项。
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()【】\[\]《》「」‘’“”"'’,，.。、!！?？\-—_·~～:：;；/\\|]/g, '');
}

/**
 * 去掉标题**尾部**的版本标记：「(Live)」「（伴奏）」「[Remastered]」，可连续好几段。
 *
 * 2026-10-29 实测：《初恋 (First Love) (エンディング Ver.9.0|フルコーラス)》查不到词 ——
 * 曲库里那条叫「初恋」，而拿整串去比只能靠 includes 得 70 分，再被扣 10 就死了。
 * 播放器给的是「这一版」的标题，曲库里是「这首歌」的标题：比的时候要把版本尾巴摘掉。
 *
 * 只摘尾部、只摘括号块，不碰中间的词 —— 有些歌名本身带括号（「(sic)」那种），摘错了更糟。
 */
const stripTail = (t: string): string =>
  t.replace(/(?:\s*[（(\[][^（()）\[\]]{1,40}[)）\]])+\s*$/g, '').trim() || t;

/**
 * 歌手拆成单个再比。
 *
 * 为什么要拆：norm() 把「、」「/」「&」全删了，于是「早見沙織、高垣彩陽」变成一整串
 * `早見沙織高垣彩陽`。只要有一点点对不上（实测是繁简「阳/陽」），
 * `includes` 两边都不成立 → 直接 −60，整首歌唱不了词。
 * 拆开以后「早見沙織」这一段两边都有，就认得出来。
 */
function artistParts(s: string): string[] {
  return s
    .split(/[、,，/&／]|\bfeat\.?\b|\bft\.?\b/i)
    .map((x) => norm(x))
    .filter(Boolean);
}

/** 这些后缀意味着"不是原唱那一版"，歌词可能完全不同（改编、纯伴奏）。 */
const SUSPECT_SUFFIX = /(伴奏|纯音乐|instrumental|karaoke|remix|dj|翻唱|cover|片段|铃声|试听)/i;

/**
 * 进程名 / 显示名 → 曲库标识。认不出来的（Spotify 之类）返回 null，不参与源偏好。
 *
 * 两个平台的 app 名不是一回事：Windows 给 `cloudmusic.exe` / `QQMusic.exe`，
 * mac 给的是本地化显示名「网易云音乐」/「QQ音乐」（也可能是 `QQ`）。只认英文的话，
 * mac 上这个偏好永远不成立 —— 表现是「在网易云听歌、却拿 QQ 的词」这种软错误。
 */
export function sourceOfApp(app?: string): TrackSource | null {
  if (!app) return null;
  const a = app.toLowerCase();
  if (a.includes('cloudmusic') || a.includes('netease') || a.includes('网易云')) return 'netease';
  if (a.includes('qqmusic') || a.includes('qq音乐') || a === 'qq') return 'qq';
  return null;
}

/**
 * 给一个搜索结果打分。分数同时表达"像不像"和"敢不敢用"。
 *
 * 歌名占大头，歌手是硬门槛：歌名对上了但歌手完全不是一个人，那不是版本差异，
 * 那是同名不同曲（「月光」这种歌名一搜一大把）。所以歌手不匹配直接扣到阈值以下。
 */
export function matchScore(
  cand: { title: string; artist: string; source: TrackSource; durSec: number },
  want: { title: string; artist: string; app?: string; durSec?: number },
): number {
  // **两边都要摘版本尾巴。** 只摘自己那边的话，两边标题一模一样却各带「(Live)」时会
  // 变成「一个摘了、一个没摘」，反而不匹配 —— 这个错是写测试时抓出来的。
  const ct = norm(bareTitle(stripTail(cand.title)));
  const wt = norm(bareTitle(stripTail(want.title)));
  if (!ct || !wt) return 0;

  let score = 0;
  if (ct === wt) score = 100;
  else if (ct.includes(wt) || wt.includes(ct)) score = 70;
  else return 0;

  // 歌名带括号后缀的（Live / 现场 / 某年某版）扣一点：词可能改了。
  if (ct !== wt && SUSPECT_SUFFIX.test(cand.title)) score -= 45;
  else if (ct !== wt) score -= 10;

  // 歌手：拆成单个再比，**只要有一个歌手对得上就算**。
  // 原来是把两串各自 norm 后互相 includes —— 一旦分隔符或某个字（繁简、错字）对不上，
  // 整串就不互相包含，直接 −60 判死。实测《初恋》就是这么丢的：
  // 我们这边「早見沙織、高垣彩陽」，曲库那边「早見沙織/高垣彩阳」，差一个「阳」。
  const ca = artistParts(cand.artist);
  const wa = artistParts(want.artist);
  if (!ca.length || !wa.length) score -= 10; // 有一边没有歌手信息，只能凭歌名，降级
  else if (ca.some((a) => wa.some((w) => a.includes(w) || w.includes(a)))) score += 25;
  else score -= 60;

  // 时长能对上（±8 秒）说明是同一版录音。
  if (want.durSec && cand.durSec && Math.abs(cand.durSec - want.durSec) <= 8) score += 15;

  // 沾了"伴奏/翻唱/DJ版"就压到阈值以下，不管别的项加了多少分。
  //
  // 光靠上面那 -45 是不够的：歌名+歌手+时长全对时，其余加分能把它顶回 73 分
  // （实测「是但求其爱 (伴奏)」正好卡在这），而伴奏版是没有词的 —— 硬用就是给错词。
  // 这类后缀是"这一条不能用来查词"的硬信号，不是"稍微没那么像"。
  if (SUSPECT_SUFFIX.test(cand.title)) score = Math.min(score, 40);

  // 当前播放器对应的源优先：他在网易云听的，多半就该用网易云那版（词也干净些）。
  //
  // 注意左边是**进程名**（cloudmusic.exe / QQMusic.exe），右边是曲库标识（netease / qq）。
  // 第一版直接把两者比，条件永远不成立，于是永远先遍历到谁就用谁（QQ）。
  const wantSrc = sourceOfApp(want.app);
  if (wantSrc) score += cand.source === wantSrc ? 10 : -6;

  return score;
}

/**
 * 一次抓取的结果，三态。
 *
 * `null` 的含义是**没拿到**（网络、限流、接口拒绝、空响应），和「这首没有词」
 * 是两件完全不同的事。把它俩混成一个是本文件历史上最贵的错：
 * 用户听到的是她对着有词的歌说「这首没词」。
 */
type LyricFetch = { kind: 'ok'; raw: string } | { kind: 'none' } | null;

/**
 * 解析结果只给「行」。
 *
 * **原来这里还有个 `instrumental`，由 `out.length === 0` 推出来——那是错的。**
 * 「解析出 0 行」有四种可能：真的是纯音乐、词库给的是纯文本没有时间戳、
 * 格式我们不认识、以及抓取其实失败了拿回空字符串。前一种能说「这首没词」，
 * 后三种不行 —— 而 2026-10-29 实测到的正是第四种：QQ 接口回 `retcode: -1901`
 * （请求被拒），我们拿回空串，`parseLrc('')` 就把它标成纯音乐，
 * 于是事件正文写「这首的词库里没有词」，她照着对一首有词的歌说「这首没词」。
 *
 * 所以「有没有词」这个判断只能由**抓取层**下：接口明确回 `nolyric` 才算没有。
 * 解析层只负责把文本变成行，解析不出就是解析不出，不是事实。
 */
export interface ParsedLyric {
  lines: LyricLine[];
}

const META_LINE = /^(作词|作曲|编曲|制作人|监制|混音|母带|录音|和声|合声|吉他|贝斯|鼓|弦乐|出品|发行|唱片|词|曲|op|sp|Lyricist|Composer|Arranger|Producer|Written\s*by|Music\s*by)\s*[:：]/i;

/**
 * 宽松版：标签（1–32 个非冒号字符）后跟冒号。
 *
 * 只用在一首歌的**头几行**。词库（尤其 QQ 音乐的）会把制作名单整段挂在开头：
 * `合声：周杰伦` / `Rap：周杰伦` / `监制：某某` —— 逐个穷举永远漏一个，
 * 而歌词里"某某：内容"这种句式几乎不会出现在开头十行。宁可错杀开头的制作行。
 *
 * **2026-11-01 放宽过一次**：原来只许「汉字/字母 + 空白与间隔点」共 1–9 字，
 * 于是「混音&母带：赵靖 JING ZHAO」里的 `&` 直接把它顶掉，成了漏网之鱼。
 * 现在除冒号以外什么都收，长度到 32 —— 「制作助理 Production Assistant：」这种也吃得下。
 */
const EARLY_META = /^[\u4e00-\u9fa5A-Za-z][^:：]{1,31}\s*[:：]/;

/** 扫描开头几行时套用宽松规则。 */
const META_SCAN_LINES = 12;

/**
 * 开头「制作名单块」整块剔除 —— 不靠穷举标签，靠结构。
 *
 * 为什么不能再靠标签穷举：2026-11-01 实测《天气预报》（梁静茹）的 QQ 歌词开头是
 *   `编曲 Arrangement：黄中岳 Ray Huang`
 *   `录音师 Recording Engineer：马一宁 Yi Ning Ma@Show Music Studio`
 *   `混音录音室 Mixing Studio：小公园 ThePark`
 * 标签后面拖着英文，长度十几二十字，`^(编曲|录音|混音)\s*[:：]` 一类全匹配不上；
 * 《无名的人》还有「混音&母带：赵靖」这种带 `&` 的。于是整段漏进 lines，
 * 换歌那一刻 linesFrom(0) 取头两行正好取到名单 —— 她说「词这次只捞到制作名单」。
 *
 * 结构上的特征很稳：名单是**从第一行起连续若干行都是「标签：值」**，而且行间隔极密
 * （0.2–3 秒，都在前奏里一口气打完），到正文第一行会突然拉开到七八秒以上。
 * 真歌词连续三行都带冒号、还都挤在 3.5 秒内，基本不存在。
 *
 * 三条保险，宁可少删不可错删：
 *   - 只从 index 0 起算，遇到第一行不带冒号的立刻停；
 *   - run 长度 ≥ 3 才动，一两行的交给 META_LINE / EARLY_META；
 *   - run 内相邻时间差 > 3.5 秒就断 —— 名单不会隔四秒才写下一行。
 */
const CREDIT_LINE = /^[^:：]{1,24}[:：]\s*\S/;
const CREDIT_MIN_RUN = 3;
const CREDIT_MAX_GAP = 3.5;

function dropCreditHead(lines: LyricLine[]): LyricLine[] {
  let end = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!CREDIT_LINE.test(lines[i].text)) break;
    if (i > 0 && lines[i].t - lines[i - 1].t > CREDIT_MAX_GAP) break;
    end = i + 1;
  }
  if (end < CREDIT_MIN_RUN) return lines;
  return lines.slice(end);
}

/**
 * 解析 LRC。容忍：一行多个时间戳（`[00:01][00:31]词`）、毫秒两位或三位、
 * 网易云的元信息行（作词/作曲/编曲…）、QQ 音乐那种隔行的空文本标记，
 * 以及词库挂在最前面的「歌名 - 歌手 (英文名)」标题行。
 *
 * `meta` 两个字段只用来滤标题行 —— 不给也能跑，只是开头会多一句没用的。
 */
export function parseLrc(raw: string, meta?: { title?: string; artist?: string }): ParsedLyric {
  const text = str(raw);
  // 空文本 = 没拿到内容，不是"这首没有词"。见 ParsedLyric 的注释。
  if (!text) return { lines: [] };

  let offset = 0;
  const om = text.match(/\[offset:\s*(-?\d+)\s*\]/i);
  if (om) {
    const v = Number(om[1]);
    // 离谱的 offset 一律不信（有的词库塞了 -100000 这种）。
    if (Number.isFinite(v) && Math.abs(v) <= 10_000) offset = v / 1000;
  }

  const wantTitle = norm(meta?.title ?? '');
  const wantArtist = norm(meta?.artist ?? '');
  const out: LyricLine[] = [];
  let scanned = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    let rest = rawLine;
    const stamps: number[] = [];
    for (;;) {
      const m = rest.match(/^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
      if (!m) break;
      const fracStr = m[3] ?? '0';
      const frac = Number(fracStr) / 10 ** fracStr.length;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac + offset);
      rest = rest.slice(m[0].length);
    }
    // 没有时间戳的行是元信息（[ti:] [ar:]）或纯文本说明，都不是歌词。
    if (!stamps.length) continue;
    const line = rest.trim();
    if (!line) continue;
    if (META_LINE.test(line)) continue;

    // 头几行的额外过滤：宽松制作信息 + 标题行。
    if (scanned < META_SCAN_LINES) {
      scanned += 1;
      if (EARLY_META.test(line)) continue;
      const plain = norm(line);
      const isHeader = wantTitle
        && plain.includes(wantTitle)
        && (!wantArtist || plain.includes(wantArtist))
        && stamps.every((t) => t <= 3); // 标题行一定贴在 0 秒
      if (isHeader) continue;
    }

    for (const t of stamps) out.push({ t: Math.max(0, t), text: line });
  }

  out.sort((a, b) => a.t - b.t);
  // 解析出 0 行**不**等于纯音乐：可能是纯文本词、格式不认识、或者抓了个空壳。
  // 头条名单独整块剔掉，见 dropCreditHead（2026-11-01）。
  return { lines: dropCreditHead(out) };
}

/** 相邻重复去掉（副歌连着重复、或 LRC 里一句挂两个时间戳时会撞上）。 */
function dedupe(lines: readonly LyricLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const l of lines) {
    if (out.length && out[out.length - 1].text === l.text) continue;
    out.push(l);
  }
  return out;
}

/**
 * 这一秒**及之前**最近的 n 行 —— "刚唱过什么"。工具查询用这个。
 *
 * 和 linesFrom() 分开写，是因为混在一起会出错：换歌那一刻 sec=0，
 * "往前取"只会拿到第一行，而她想知道的是"接下来这几句"。
 */
export function linesAt(lines: readonly LyricLine[], sec: number, count: number): LyricLine[] {
  const sorted = dedupe(lines);
  if (!sorted.length) return [];
  const n = Math.max(1, Math.trunc(count));
  let idx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].t <= sec) idx = i;
    else break;
  }
  if (idx < 0) return sorted.slice(0, n); // 前奏还没开口，给开头几句
  return sorted.slice(Math.max(0, idx - n + 1), idx + 1);
}

/** 这一秒**起往后**的 n 行 —— "接下来唱什么"。换歌时用这个。 */
export function linesFrom(lines: readonly LyricLine[], sec: number, count: number): LyricLine[] {
  const sorted = dedupe(lines);
  if (!sorted.length) return [];
  const n = Math.max(1, Math.trunc(count));
  let idx = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].t >= sec) { idx = i; break; }
    idx = i + 1;
  }
  return sorted.slice(idx, idx + n);
}

/**
 * 段事件要的那几行：优先"这一段区间里唱过的"，不够再往前补。
 *
 * 为什么要这段区间而不是"此刻那一句"：段事件的语义是"这一段你听完了，说说"。
 * 只给此刻那一句，她会把整个四十五秒的评价压在一句上，听起来像在解说歌词；
 * 给这一段唱过的，她才在说"这一段"。
 *
 * 延迟渲染切到新相位时传 `backfill = false`：那是当前位置的实时窗口，不是入队时的
 * 历史段，窗口里有几句就只能给几句，绝不能拿旧段的歌词凑满。
 */
export function segmentLines(
  lines: readonly LyricLine[],
  fromSec: number,
  toSec: number,
  count: number,
  backfill = true,
): LyricLine[] {
  const sorted = dedupe(lines);
  if (!sorted.length) return [];
  const n = Math.max(1, Math.trunc(count));
  if (!backfill) return sorted.filter((l) => l.t >= fromSec && l.t <= toSec).slice(-n);
  const upTo = sorted.filter((l) => l.t <= toSec);
  // 整段都落在前奏里（还没开口）：给开头几句，别让她以为没词。
  if (!upTo.length) return sorted.slice(0, n);
  const inSeg = upTo.filter((l) => l.t >= fromSec);
  const pick = inSeg.length >= n ? inSeg.slice(-n) : upTo.slice(-n);
  return pick;
}

/**
 * 把歌词行拼成可以直接塞进事件正文的一段。
 *
 * **必须清掉 `【】<>`**：桌宠脚本里 `【】` 是表情/动作块、`<>` 是行内标记。
 * 歌词里出现（虽然少见），她照抄就会变成一条动作指令，或者整句被解析器吃掉。
 * 这是从"她偶尔冒出奇怪表情"那类事故里学来的：喂进去的原文也要当不可信输入。
 */
export function quoteLines(lines: readonly LyricLine[]): string {
  return lines
    .map((l) => {
      const t = l.text
        .replace(/[【】<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t.length <= MAX_LINE_CHARS) return t;
      return `${t.slice(0, MAX_LINE_CHARS)}…`;
    })
    .filter(Boolean)
    .join(' / ');
}

/** 内存 + 磁盘两层缓存。磁盘只为本机复用，不参与任何上报。 */
export class LyricStore {
  private readonly dir: string;
  /** trackKey → doc（null = 本进程里确认过没有，别再搜）。 */
  private readonly memo = new Map<string, LyricDoc | null>();
  /** trackKey → 正在进行的抓取，避免同一首并发搜两遍。 */
  private readonly inflight = new Map<string, Promise<LyricDoc | null>>();

  constructor(private readonly dataDir: string) {
    this.dir = join(dataDir, 'lyrics');
  }

  private fileFor(doc: { source: TrackSource; id: string }): string {
    return join(this.dir, `${doc.source}-${doc.id.replace(/[^\w.-]/g, '_')}.json`);
  }

  private static keyOf(track: { app: string; title: string; artist: string }): string {
    return `${track.app}\u0001${track.title}\u0001${track.artist}`;
  }

  /**
   * 同步取。
   *   `undefined` = 这首还没查过（跑 ensure 就有了）
   *   `null`      = 查过了，确定没有（别再试）
   *   LyricDoc    = 有词
   * 三态而不是两态：把"没查过"和"查过没有"混成 null，第一段会误判成"纯音乐"，
   * 于是她对着有词的歌唱"这首没词"。
   */
  peek(track: LyricInput): LyricDoc | null | undefined {
    return this.memo.get(LyricStore.keyOf(track));
  }

  /**
   * 异步确保。同一首并发调用只搜一次。
   * 失败也返回 null，并把 null 记进进程内 memo（同一首歌不反复试）。
   */
  ensure(track: LyricInput): Promise<LyricDoc | null> {
    const k = LyricStore.keyOf(track);
    if (this.memo.has(k)) return Promise.resolve(this.memo.get(k) ?? null);
    const running = this.inflight.get(k);
    if (running) return running;

    const job = this.fetchLyric(track)
      .catch(() => null)
      .then((doc) => {
        this.memo.set(k, doc);
        return doc;
      })
      .finally(() => {
        this.inflight.delete(k);
      });
    this.inflight.set(k, job);
    return job;
  }

  private async fetchLyric(track: LyricInput): Promise<LyricDoc | null> {
    const title = str(track.title);
    if (!title) return null;
    // 幽灵标题（桌面歌词、应用名本身）不该拿去搜：搜出来的一定是别的歌。
    if (/^(桌面歌词|迷你播放器|网易云音乐|QQ音乐|CloudMusic|QQMusic)$/i.test(title)) return null;

    const want = {
      title,
      artist: str(track.artist),
      app: track.app,
      durSec: track.durSec && track.durSec > 0 ? track.durSec : undefined,
    };
    const kw = [bareTitle(title), want.artist].filter(Boolean).join(' ');

    // 先搜当前播放器对应的那一家，够好就不再问另一家。
    //
    // 为什么不像"自己找歌"那样一次搜两个源：那边是用户点一下才发生，多搜一个源没代价；
    // 这边是**每换一首歌就自动跑一次**，两个源就是两倍请求，很容易撞上网易云的限流
    // （实测确实撞了）。而他正在听的那一家，本来就是最可能有这一版的。
    const prefer = sourceOfApp(track.app);
    const order: TrackSource[] = prefer === 'netease' ? ['netease', 'qq'] : ['qq', 'netease'];

    let best: Track | null = null;
    let bestScore = 0;
    for (const src of order) {
      if (src === 'netease' && Date.now() < neteaseCooldownUntil) continue;
      let list: Track[] = [];
      try {
        list = src === 'netease'
          ? await searchNetease(kw, 6, FETCH_TIMEOUT_MS)
          : await searchQQ(kw, 6, FETCH_TIMEOUT_MS);
      } catch (e) {
        // 405 = 被限流。记下来，接下来几分钟别再撞它。
        if (src === 'netease' && /405|限流/.test(String((e as Error)?.message ?? ''))) {
          neteaseCooldownUntil = Date.now() + NETEASE_COOLDOWN_MS;
        }
        continue;
      }
      for (const cand of list) {
        const sc = matchScore(
          { title: cand.title, artist: cand.artist, source: cand.source, durSec: cand.durSec },
          want,
        );
        if (sc > bestScore) {
          bestScore = sc;
          best = cand;
        }
      }
      // 已经过了阈值就收工：再问另一家也几乎不会更高分，而每一次都多一份限流风险。
      if (best && bestScore >= MIN_SCORE) break;
    }
    if (!best || bestScore < MIN_SCORE) return null;

    const got = best.source === 'netease'
      ? await this.fetchNetease(best.id)
      : await this.fetchQQ(best.mid);

    // **没拿到 ≠ 没有。** 抓取失败（网络、限流、接口回 -1901）一律返回 null，
    // 不造 doc、不落盘、更不在正文里说「这首没词」。
    // 2026-10-29 实测：QQ 对《風のアルペジオ》回 retcode -1901，我们拿回空串，
    // 解析出 0 行就标成「纯音乐」，于是她对着有词的歌说「这首没词」。
    if (!got) return null;

    if (got.kind === 'none') {
      // 只有接口**明确**说没有（网易云的 nolyric / uncollected）才算数。
      // 这条可以落盘：它是确定的事实，下次不用再问一遍。
      const doc: LyricDoc = {
        source: best.source,
        id: best.source === 'netease' ? best.id : best.mid,
        title: best.title,
        artist: best.artist,
        lines: [],
        instrumental: true,
        fetchedAt: Date.now(),
      };
      this.write(doc);
      return doc;
    }

    const parsed = parseLrc(got.raw, { title: best.title, artist: best.artist });
    // 有文本却解析不出行：纯文本词、格式不认识、或者半个空壳。**当作没拿到**，
    // 不落盘也不断言"没有词" —— 宁可这一句不带词，也不能对用户说假话。
    if (!parsed.lines.length) return null;

    const doc: LyricDoc = {
      source: best.source,
      id: best.source === 'netease' ? best.id : best.mid,
      title: best.title,
      artist: best.artist,
      lines: parsed.lines,
      instrumental: false,
      fetchedAt: Date.now(),
    };
    this.write(doc);
    return doc;
  }

  /** 抓取结果三态：拿到词 / 明确没有词 / 没拿到（null）。 */
  private async fetchNetease(id: string): Promise<LyricFetch> {
    const u = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`;
    const res = await fetch(u, { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    // 这两个字段是网易云自己给的「这首歌没有词」，可以当真。
    if (j?.nolyric || j?.uncollected) return { kind: 'none' };
    const raw = str(j?.lrc?.lyric);
    return raw ? { kind: 'ok', raw } : null;
  }

  /**
   * QQ 音乐不返回「这首没词」这种明确标记，只给 `retcode`。
   * 所以这里**只区分「拿到了」和「没拿到」**，一律不给 `none` —— 保守。
   *
   * 实测（2026-10-29）：`retcode: -1901` 就是这个接口拒了请求（签名/参数问题），
   * 不是"这首歌没有词"。《風のアルペジオ》《雪の華》《長い間》这些明明有词的歌，
   * 全被回成 -1901，然后被我们误判成纯音乐。
   */
  private async fetchQQ(mid: string): Promise<LyricFetch> {
    if (!mid) return null;
    const u = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`;
    const res = await fetch(u, { headers: QQ_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const txt = await res.text();
    try {
      const j = JSON.parse(txt) as any;
      const code = Number(j?.retcode ?? 0);
      if (code !== 0) return null;             // 请求被拒，不是"没有词"
      const raw = str(j?.lyric);
      return raw ? { kind: 'ok', raw } : null; // 空 lyric 也不当"没有词"：可能只是这次没给
    } catch {
      return null;
    }
  }

  private write(doc: LyricDoc): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.fileFor(doc), JSON.stringify(doc), 'utf8');
    } catch {
      /* 缓存写不进去不影响功能 */
    }
  }

  /** 从磁盘读一份（重启后第一首不用重新搜）。目前只在清理统计时用。 */
  read(source: TrackSource, id: string): LyricDoc | null {
    try {
      const f = this.fileFor({ source, id });
      if (!existsSync(f)) return null;
      return JSON.parse(readFileSync(f, 'utf8')) as LyricDoc;
    } catch {
      return null;
    }
  }

  /** 数据页签用：缓存了几份、占多大。 */
  stat(): { files: number; bytes: number } {
    try {
      if (!existsSync(this.dir)) return { files: 0, bytes: 0 };
      let files = 0;
      let bytes = 0;
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        const p = join(this.dir, name);
        try {
          const st = statSync(p);
          if (st.isFile()) {
            files += 1;
            bytes += st.size;
          }
        } catch { /* 跳过读不到的 */ }
      }
      return { files, bytes };
    } catch {
      return { files: 0, bytes: 0 };
    }
  }

  /** 一键清。内存里记住的 null/文档一起清，清完立刻生效。 */
  clear(): { files: number; bytes: number } {
    const before = this.stat();
    try {
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          if (!name.endsWith('.json')) continue;
          try { unlinkSync(join(this.dir, name)); } catch { /* 占着就算了 */ }
        }
      }
    } catch { /* 目录都没了 */ }
    this.memo.clear();
    return before;
  }

  /** 测试与排障用：当前记住多少首。 */
  get size(): number {
    return this.memo.size;
  }
}
