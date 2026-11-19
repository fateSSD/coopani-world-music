import { localDay, type Signal, type Track } from './tracker.ts';
import { isLongform, type Feel, type Phase } from './vibe.ts';
import type { AudioFeatures } from './genre.ts';
import {
  FIRST_HEAR_SEC, HEAR_DRIFT, HEAR_DRIFT_SEC, COUNT_MILESTONE,
  MOVE_WORD, SIT_MOVES, MOVE_FALLBACK, MOVE_DEGRADE,
} from './constants.ts';

/**
 * 自动深听该不该跑。抽成纯函数是为了能测 —— 时间窗这种东西，不测就等着上线才发现
 * 「一首歌只来得及听一段」。
 *
 * 五条规则，按顺序：
 * 1. `every <= 0` 一律不跑（默认关，云端每段都是钱）。
 * 2. 换歌：**只等 FIRST_HEAR_SEC**，不是等满一个整间隔。等满等于短歌只听得见一段。
 * 3. 两次分析之间不短于 FIRST_HEAR_SEC —— 硬下限，能量再怎么跳也不许连跑。
 * 4. **声音在变就提前听**（drift ≥ HEAR_DRIFT），但两次之间至少隔 HEAR_DRIFT_SEC。
 * 5. 兜底：距上次够 `every` 就听。省不掉 —— 一首歌要是从头到尾一个响度，
 *    光靠 drift 她一句都说不出来。
 */
export function autoHearDue(
  prev: { key: string; at: number; lastAt: number },
  now: number,
  key: string,
  every: number,
  drift: number | null = null,
): { due: boolean; key: string; at: number; lastAt: number; why: 'switch' | 'drift' | 'fallback' } {
  if (every <= 0) return { due: false, ...prev, why: 'fallback' };
  if (key !== prev.key) {
    return {
      due: false, key, at: now - Math.max(0, every - FIRST_HEAR_SEC) * 1000, lastAt: prev.lastAt, why: 'switch',
    };
  }
  if (prev.lastAt && now - prev.lastAt < FIRST_HEAR_SEC * 1000) return { due: false, ...prev, why: 'fallback' };
  if (drift !== null && drift >= HEAR_DRIFT && now - prev.at >= HEAR_DRIFT_SEC * 1000) {
    return { due: true, key, at: now, lastAt: now, why: 'drift' };
  }
  if (now - prev.at < every * 1000) return { due: false, ...prev, why: 'fallback' };
  return { due: true, key, at: now, lastAt: now, why: 'fallback' };
}

/* ================= 复读检测：把「她说过什么」还给代码 ================= */

/**
 * 一句话的骨架指纹。
 *
 * 2026-11-10 量过：6833 条台词里有 17.8% 跟同一场前面的某句共享 ≥6 字片段，而最高频的不是词，
 * 是**句式**——`」——这` 644 次、`。下一首` 159 次、句尾「库」300 多次。
 * 所以判重要落在骨架上：
 *
 * - **lead**：去掉表情标记和开头的标点之后的前 6 个字。抓「这个点了」「一开口就」这种开口定型。
 * - **quoted**：这一句有没有引词（`「`）。她引词评点用了 644 次，是最大的一类骨架。
 * - **dash**：有没有用破折号接评语（`——`）。
 *
 * 不用相似度算法：这活儿要的是**能说清理由**，不是 0.83 这个数。她拿到的是「你已经用过这个开头」，
 * 不是「相似度 0.72」。
 */
export interface SayShape {
  /** 去掉表情标记之后的第一小句（到第一个标点为止，最长 12 字）。 */
  lead: string;
  /** 去掉末尾标点后的最后 4 个字。「我不催你」这类定型落在这一头。 */
  tail: string;
  quoted: boolean;
  dash: boolean;
}

const STRIP_MARKS = (s: string): string => s.replace(/【[^】]*】/g, '').replace(/<[^>]*>/g, '');

/**
 * 她的人格语气词：库、啦、呢、喔、哦……
 *
 * **这是设定，不是复读。** 2026-11-10 Mr.Q 明确说过：「库正常这是她原人格用的句末语气词」。
 * 所以取句尾指纹之前先把它们剥掉，否则「…我一点儿没走神，库」和「…唱得挺平静，库」会被判成
 * 同一个收尾 —— 那等于拿人格当缺陷修。剥完还剩什么才拿去比。
 */
const PERSONA_TAIL = /(?:库|啦|呢|喔|哦|呀|嘛|嘿|诶|欸|嗯)+$/;

/** 句末标点，含英文句点（`……，库...` 这种混着英文点的写法实测见过）。 */
const TAIL_PUNCT = /[\s，。！？、…—\-·~～.,]+$/;

/** 去掉句末标点 → 剥掉人格语气词 → 再去一次标点（「库，」这种）。 */
const trimTail = (s: string): string => s.replace(TAIL_PUNCT, '').replace(PERSONA_TAIL, '').replace(TAIL_PUNCT, '');

export function sayShape(text: string): SayShape {
  const raw = String(text ?? '');
  const body = STRIP_MARKS(raw).replace(/^[\s，。！？、…—\-·~～]+/, '');
  // 取到第一个标点就停：「这个点了还在放。」和「这个点了，窗外没声了。」的起手都是「这个点了」，
  // 用固定长度去截会把它们截成两个不一样的东西（6 字一个卡在「还」一个卡在逗号上）。
  const m = /^[^，。！？、；：…—\s]{2,12}/.exec(body);
  return {
    lead: m ? m[0] : body.slice(0, 6),
    tail: trimTail(body).slice(-4),
    quoted: /[「『]/.test(raw),
    dash: /——/.test(raw),
  };
}

/** 两段的公共前缀长度。 */
const lcp = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/** 专名不是句式。《歌名》、「引文」、英文型号、数字编号都可能在不同场合合法地重复。 */
const isProper = (s: string): boolean => /[《》「」『』]/.test(s);

/**
 * 这一场她说过的话，能总结出什么「别再这样」。
 *
 * 只在真检测到重复时才说话——没重复就返回空串，事件正文一个字都不多。
 *
 * **门槛是「三次」不是「两次」**：2026-11-10 用真实数据试过，两次的阈值把炉石卡牌名
 * （「龙鳞军备先抽」「誓缚光环先下」——不同对局里的不同牌）判成了复读。同一场里出现三次以上
 * 才算定型，牌名几乎不可能。
 *
 * 四条判据：
 * 1. 两个开口的公共前缀 ≥6 字，且 ≥3 次。
 * 2. 句尾 4 字完全相同，且 ≥3 次（「我不催你」这类落在这一头，开头漏得掉，句尾漏不掉）。
 * 3. 六成以上在引词评点（骨架定型）。
 * 4. 六成以上用破折号接评语（标点定型）。
 *
 * 注意这里**不给她原句**。给原句等于给示范，她会照着改一个字再写一遍。
 */
export function repeatHint(says: readonly string[]): string {
  const list = says.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (list.length < 3) return '';
  const shapes = list.map(sayShape);

  const leadGroups: Array<{ s: string; n: number }> = [];
  for (const sh of shapes) {
    // 前缀门槛 6 字：4 字太松，实测把「龙鳞军备先抽」和「龙鳞军备先留」（同一张牌打两次）
    // 判成了复读。6 字以上还能撞上的，基本就是同一句话换了个尾巴。
    if (sh.lead.length < 6 || isProper(sh.lead)) continue;
    const g = leadGroups.find((x) => lcp(x.s, sh.lead) >= 6);
    if (g) g.n += 1;
    else leadGroups.push({ s: sh.lead, n: 1 });
  }
  const leads = leadGroups.filter((g) => g.n >= 3).sort((a, b) => b.n - a.n);

  const tailCount = new Map<string, number>();
  for (const sh of shapes) {
    if (sh.tail.length < 4 || isProper(sh.tail)) continue;
    tailCount.set(sh.tail, (tailCount.get(sh.tail) ?? 0) + 1);
  }
  const tails = [...tailCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);

  const quoted = shapes.filter((s) => s.quoted).length;
  const dashed = shapes.filter((s) => s.dash).length;

  const bits: string[] = [];
  if (leads.length) {
    bits.push(`这一场你已经用过这些开头：${leads.slice(0, 3).map((g) => `「${g.s.slice(0, 6)}」`).join('、')}——这一句别再这么开`);
  }
  if (tails.length) {
    bits.push(`「${tails[0][0]}」这个收尾用过 ${tails[0][1]} 次了，这一句换个说法收`);
  }
  if (quoted / list.length >= 0.6) {
    bits.push(`这一场 ${list.length} 句里 ${quoted} 句都是先引一句词再评，这一句别引词，直接说你听到的`);
  } else if (dashed / list.length >= 0.6) {
    bits.push(`这一场 ${list.length} 句里 ${dashed} 句都拿破折号接评语，这一句把话说完整`);
  }
  if (!bits.length) return '';
  return `（${bits.join('；')}。）`;
}


/** 本机分析器吐出来的那份 JSON。常驻和一次性两条路都按这个形状收。 */
export interface LocalAnalysis {
  ok?: boolean;
  summary?: string;
  duration_sec?: number;
  key?: string;
  elapsed_sec?: number;
  error?: string;
  chords?: Array<{ chord?: string }>;
  melody?: { notes?: Array<{ note?: string }> };
  stem_share?: Record<string, number>;
  instruments?: Array<{ name: string; score: number }>;
  speech?: {
    ok?: boolean; text?: string; lang?: string; lang_zh?: string;
    confident?: boolean; alt?: string; error?: string; skipped?: boolean;
    cross?: string; agree?: number; elapsed_sec?: number;
  };
}

/**
 * 比「她听到的」和「歌词原文」像不像。
 *
 * 只留下字：标点、空格、全半角都不该影响判断。**分母取两边较小的那个**——
 * 转写常常多带半句、歌词一行也常常比听到的长，只按转写算会把对得上的判成对不上。
 * 逐行比，不要拼接窗口：±25 秒拼成一整段之后，「一」「情」「流水」这类公共二字词
 * 会让任何一句都拿到 0.3，等于没有区分度（2026-11-06 实测踩到）。
 */
export const speechNorm = (s: string): string =>
  (s || '').replace(/[\s。、，,.!?！？…・「」『』()（）\[\]【】ー~～\-—:：;；'"’”‘“]/g, '').toLowerCase();

export function speechSim(heard: string, lyric: string): number {
  const a = speechNorm(heard);
  const b = speechNorm(lyric);
  if (!a || !b) return 0;
  if (b.includes(a) || a.includes(b)) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (const [g, n] of grams) {
    if (b.includes(g)) hit += n;
  }
  return hit / Math.min(a.length - 1, b.length - 1);
}

/**
 * 第 4 格「说你自己的状态」，按曲风分两版。**不放进 TALK_ANGLES，因为它不是一句话。**
 *
 * 这一格原来一律写死"不许说困"——因为《曹操》那种烈歌上她真睡过去过（20:53 补一句就睡了，
 * 21:23 listen.27 又来一次）。但 Mr.Q 后来把话改清楚了：「听现在这种曲子的时候，
 * 孩子困了就让她睡会吧」——所以判据从来不是"听歌不许困"，是**这首曲子该不该困**：
 * 柔的（抒情 / 民谣 / 钢琴 / 器乐）允许困，烈 / 旧 / 怪 / 淡照旧不许。
 *
 * 只改嘴、不改身体：坐不坐下、睡不睡，是 body.js 的 dozeOk() 按「闭眼听」自己判的，
 * 这里的文案管不到它，也不该管。柔歌版要额外堵一句【睡觉】——那个词是永久睡下，
 * 得等人点她才醒，绝不能让她自己写。
 */
export function stateAngle(feel: Feel | null, lively = false): string {
  // 欢快的柔不许困：这一档本来是为「抒情/钢琴/民谣」写的，欢快的流行歌混进来就会让她打盹，
  // 而打盹是宿主那边坐下后的真实行为（60% 概率），不是演出来的。
  if (feel === 'soft' && !lively) {
    // 原来这里给了两个现成句子：「"眼皮往下掉""听着听着就不想动了"都说得出口」。
    // 结果她照抄 —— 21:43:18 一字不差地说了「眼皮往下掉」。给示范是为了让她敢说困，
    // 但只要给了句子，她就会当台词念（SEGMENT_ASK 那张填空表、和「吃不吃这一套」变「我吃」，
    // 同一个毛病，这是第三次）。所以只留许可，不给措辞。
    return '这一句不许出现任何数字、也不许出现任何钟点。说你自己的状态——这种曲子可以困，'
      + '别硬撑着装精神，直说你现在什么样子（但别写【睡觉】这个词）。或者问他一句。';
  }
  return '这一句不许出现任何数字、也不许出现任何钟点。说你自己的状态——但必须是醒着的状态'
    + '（听出了什么、身体跟着动了、心里怎么想）；不许说困、不许说想睡、不许说要眯一会儿，'
    + '你是在陪他听，不是被他哄睡。或者问他一句。';
}

/**
 * 段 2 落在哪一格（0–3）。纯函数，测试能单独打。
 *
 * 分两层：
 * - **0 是"报总量"专用格，只在里程碑开**。Mr.Q 原话「别让她每一首都数听歌首数了，
 *   有点烦，隔个一二十首再说吧」——四格轮转时它每 4 首就冒一次，密度太高。
 * - 其余按 1/2/3 三格轮转：说时长 / 说人 / 完全不给数字。
 *
 * 种子只取**一个**单调量。早先写的是 `(indexInSession - 1 + doneToday) % 4`，看着更稳，
 * 实际是坏的：每换一首这两个数同时 +1，总数 +2，模 4 只在 0 和 2 之间跳，
 * 角度 1 和 3 永远轮不到。实测 20:36–20:52 七段全是 0 或 2，才把它逼出来。
 * 两个同步递增的量不能相加当种子。
 */
export function talkAngle(indexInSession: number, doneToday = 0): number {
  const seed = doneToday > 0 ? doneToday : Math.max(1, indexInSession);
  if (doneToday > 0 && doneToday % COUNT_MILESTONE === 0) return 0;
  return 1 + (seed % 3);
}

/**
 * 这一首虽然是柔的，但算不算「欢快的柔」。
 *
 * **为什么需要这一刀**：柔占标签库 59%（735/1245），而柔的动作用的是【闭眼听】【坐着哼】。
 * 宿主 `body.js:396` 写着 `setMode('sit', { willSleep: Math.random() < .6 })` ——
 * **「坐下」有 60% 概率直接睡着**，坐 6–9 秒后进 sleep 8–12 秒。于是欢快的流行歌只要被判成柔，
 * 她就会坐下、然后打盹。Mr.Q 的原话：「播欢快的曲目时能够让她少进入睡眠模式嘛」。
 *
 * **判据只能看曲风名，不能看能量。** 实测标签库（119 条带 features 的 soft / 32 条 hard）：
 * 柔的 BPM 中位 94.3、烈 94.5，P75 分别 102 / 108，分布几乎完全重叠；rms 也一样。
 * 拿 BPM 或响度分「欢快」和「激烈」是分不开的。曲风名才是她自己的判断，也是「欢快」这个词的真实来源。
 */
export function isLivelySoft(feel: Feel | null, genre: string | undefined, features: AudioFeatures | null): boolean {
  if (feel !== 'soft') return false;
  const g = String(genre ?? '');
  // 慢的、容易困的那一类先认出来，它们占着也确实是该困的
  if (/抒情|民谣|钢琴|器乐|情歌|慢|安静|摇篮|古典|弦乐|指弹|夜曲/.test(g)) return false;
  // 明确活泼的
  if (/流行|摇滚|舞曲|电子|欢快|合唱|说唱|爵士|bossa|city ?pop|disco|funk|soul|R&B/i.test(g)) return true;
  // 曲风名看不出快慢时才用 BPM 弱判：105 落在柔的 P80 附近，只有明显偏快的才够
  return !!features && features.bpm >= 105;
}

/**
 * 这一档可以用的动作名（首选 + 同档备选，最多四个）。
 *
 * **为什么要给候选而不是给唯一答案**：2026-10-28 实测两回 —— 给了「凑近听」她写成
 * 「闭眼听」，给了「应援」她写成「蹦迪」，两次都是拿新词换成熟词。补了一句
 * 「照写，别换成别的动作名」照样换。
 *
 * 原因不是不听指令，是她的执行顺序和我们相反：**她先想好这句话，再挑配得上这句话的动作**。
 * 我们按"环境→动作"设计，她按"这句话→动作"执行，两个方向撞在一起，她当然选那个
 * 更贴自己刚写下的句子的。
 *
 * 所以改成给一个**受控的候选集**：范围仍由路数定（不会跑到别的档），但挑哪个由她按这句话来。
 * 这样两件事同时成立：变化还在，配得上话也在。
 */
export const moveChoices = (feel: Feel | null, move: string, lively = false): string[] => {
  const pool = (MOVE_FALLBACK[feel ?? 'plain'] ?? [])
    .filter((id) => !(lively && SIT_MOVES.has(id)))
    .map((id) => MOVE_WORD[id])
    .filter(Boolean);
  const out: string[] = [];
  if (move) out.push(move);
  for (const m of pool) if (!out.includes(m)) out.push(m);
  return out.slice(0, 4);
};

/**
 * 候选集拼成一句话。空了就不提动作。
 *
 * **`special` 那一句不能省。** 候选制说「别用这几个以外的」，而「怔住」「退半步」「余韵」
 * 本来就在这几个以外 —— 实测 2026-10-28 一晚上这三个一次都没出现过，因为规则把她框死了。
 * 它们是「反应」不是「状态」，本来就不该进候选表，但必须**在正文里点名给个时机**，
 * 否则等于白加。
 */
// 导出是为了能单独验「表情空了动作还在」这条路径 —— 正常业务里走不到，
// 但它是两个东西解耦的保证，不该只靠注释。纯函数，导出没有副作用。
export const choiceText = (choices: readonly string[], face: string, special = ''): string => {
  if (!choices.length) return '';
  const list = choices.map((c) => `【${c}】`).join('');
  // **face 允许为空。** 没有表情可用时（未标路数、字面也猜不出，POOL 那一格是空的），
  // 原来整句候选会被一起吞掉 —— 另一台机器上「换歌事件正文一个候选都没有」就是这么来的。
  // 动作和表情是两件事，缺一样不该连累另一样：没表情就只能单写动作。
  const example = face
    ? `两个词写在同一个括号里，比如【${face}, ${choices[0]}】；只写表情等于没动（实测你这么漏过好几次）。`
    : `这一句没有表情可给，就直接写【${choices[0]}】。`;
  return `动作从这几个里挑一个最贴这句话的：${list}。`
    + (special ? `${special}` : '')
    + `除此之外别用别的动作。${example}`;
};

/** 宿主实际认得的 id 集合。null = 没探到，按原样发，一点不降级。 */
let hostVocab: Set<string> | null = null;

/** 装载时调一次。传 null 等于「不知道」，恢复原行为。 */
export function setHostVocab(vocab: Set<string> | null): void {
  hostVocab = vocab;
}

/**
 * 把动作 id 降成宿主认得的那个；降不出来返回空串（这一段就不给动作）。
 *
 * 只在 hostVocab 非 null 时判定「不认识」——「没探测到」和「宿主没有这个动作」
 * 是两回事，混起来会把有补丁的机器也一起降级，那等于白装补丁。
 */
export function degradeMove(id: string): string {
  if (!id || !hostVocab) return id;
  if (hostVocab.has(id)) return id;
  for (const cand of MOVE_DEGRADE[id] ?? []) {
    if (hostVocab.has(cand)) return cand;
  }
  return '';
}

/** 这一档这一格首选哪个动作。纯查表，方便单独打。 */
export function primaryMove(feel: Feel, phase: Phase, deep = false, lively = false): string {
  switch (feel) {
    // 这是「路数 + 段位 → 动作」的映射表，越像查表越好。
    // 让她自由挑的结果是：柔歌上应援、怪歌上跟着哼——十个动作里她只会挑最顺手的那个。
    case 'hard':
      // 副歌蹦、桥段挥、其余打拍。
      //
      // 原来是反的（副歌挥、桥段蹦），依据是「副歌最激烈」。2026-10-28 三首摇滚实测推翻了它：
      // 副歌给挥她三次全改成蹦，桥段给蹦她也照蹦 —— 她按情绪走，不按段位走，
      // 而副歌就是她最想蹦的地方。**按数据显示的行为排，不按我的推断排。**
      if (phase === 'chorus') return 'bounce';
      if (phase === 'bridge') return 'cheer';
      return 'tap';
    case 'soft':
      // 开头和收尾都闭眼听——收尾这一个不能换成「余韵」：`enjoy` 是身体的睡意开关
      // （body.js 的 dozeOk 拿它判"这首曲子该困"），换成 3 秒的 sigh 之后，
      // 钢琴曲放到最后一段她就再也困不起来了。余韵留给她自己在换歌那句里用。
      // 中间：副歌跟着哼（气声那种），正段身子前倾凑近听。
      // 欢快的那一类（流行/摇滚/合唱…）不坐：坐下会掷那 60% 的睡意骰子。
      if (phase === 'intro' || phase === 'outro') return lively ? 'tap' : 'enjoy';
      // 坐下来听：**按「已经连着听了多久」排，不靠她自己想到。**
      //
      // 2026-10-29 实测：柔档 7 个段位给了它 7 次机会，**一次都没被挑中**。
      // 原因和「应援」当时一样——它的差别是「坐着」，而这是**姿势**、不是一句话会说的事，
      // 她的句子永远不会提到坐，所以它永远竞争不过「跟着哼」。
      // 这类「代码知道、她想不到」的信息，就得由代码直接排第一，别指望她自己发现。
      // 连听二十分钟还在放柔歌，坐下来听完是自然的，不是特殊动作。
      if (deep && phase === 'chorus') return lively ? 'hum' : 'humsit';
      if (phase === 'chorus') return 'hum';
      return 'peek';
    case 'old':
      // 老歌副歌容易跟着哼，其余打拍子。原来一律 tap，一晚上四首老歌四遍同一个动画。
      return phase === 'chorus' ? 'hum' : 'tap';
    case 'odd':
      // 怪歌：副歌还能摇两下，其余只打拍。
      //
      // **这里不能用「退半步」**：它只有 2.2 秒，而一段有四十到六十秒。
      // 拿一个 2.2 秒的反应去当整段的状态，演完之后的五十几秒她就那么僵站着，比不动更难看。
      // 段落动作必须是持续型的（有循环振荡、dur 10 秒以上）；退半步、怔住、余韵这三个
      // 是**反应**，只在某个瞬间用，不进这张表。
      return phase === 'chorus' ? 'groove' : 'tap';
    default:
      // **`plain` 的语义是「未知」，不是「这首淡」。**
      //
      // 这里原来 return ''，等于把「没标路数、字面也猜不出」判成「不该动」——
      // 一首歌整首一个动作都没有，用户看到的是「桌宠坏了」。
      // 2026-10-29 另一台机器上他原话就是「我的桌宠直接不做动作了」。
      //
      // 而且空值还有连带伤害：`lastMove` 不更新，避让机制整条链路跟着失效
      // （下一段仍然按同一个首选给，因为"上一次"一直是空）。
      //
      // 打拍子是最中性的持续动作，不挑路数、不冒犯任何曲风，未知就先给它。
      return 'tap';
  }
}

/**
 * 这一次实际用哪个动作 id。`last` 是上一次真下发的那个。
 * 首选撞了上一次，就在同档备选里挑一个既不是首选、也不是上一次的。
 */
export function moveIdOf(feel: Feel | null, phase: Phase | null, last = '', deep = false, lively = false): string {
  if (!phase || !feel) return '';
  const primary = primaryMove(feel, phase, deep, lively);
  if (!primary) return '';
  if (primary !== last) return primary;
  const alt = (MOVE_FALLBACK[feel] ?? []).find((m) => m !== primary && m !== last);
  return alt ?? primary;
}

/**
 * 位置不明时（网易云的 SMTC 常年报 pos:0 / dur:0，实测 22:59 放拉二第三乐章时
 * 拿到的就是 `{"app":"cloudmusic.exe","pos":0,"dur":0}`，古典全走这条路）
 * 按路数给一个**不依赖段落**的动作。
 *
 * 为什么不能空着：位置一未知，表情和动作就一起没了，事件只剩一段干话让她自己编——
 * 而 Mr.Q 最常放的古典恰恰全是这种。更要紧的是柔歌的睡意：身体靠「闭眼听」判定
 * "这首曲子该困"（body.js 的 swoonAt / dozeOk），不给这个动作，她永远不会在钢琴曲里打盹。
 *
 * 兜底动作挑的是与位置无关的那几个（闭眼听、打拍子、律动），所以不违反"位置未知时不该猜"
 * ——那条禁的是猜段落强度（副歌才蹦、其余只打拍），不是禁掉整个人。
 */
export function fallbackMove(feel: Feel | null, lively = false): string {
  switch (feel) {
    // 欢快的柔不给「闭眼听」：那个动作会让身体坐下，坐下就有 60% 概率睡着。
    case 'soft': return lively ? 'tap' : 'enjoy';
    case 'hard': return 'tap';
    case 'old': return 'tap';
    case 'odd': return 'groove';
    // plain（未知）同样要有一个：返回空会让 lastMove 停更，避让一起废掉。
    default: return 'tap';
  }
}

/**
 * 动作 id，位置未知时退到 fallbackMove()。避让逻辑不变：同一路数连着两段不给同一个动作。
 * 单独一层是因为 moveIdOf() 的判据（"不知道在副歌还是开头"）本身是对的，
 * 不该为了兜底去松它——测试里那条断言还要留着。
 */
export function moveIdAny(feel: Feel | null, phase: Phase | null, last = '', deep = false, lively = false): string {
  if (phase) return moveIdOf(feel, phase, last, deep, lively);
  const id = fallbackMove(feel, lively);
  if (!id) return '';
  if (id !== last) return id;
  return (MOVE_FALLBACK[feel] ?? []).find((m) => m !== id && m !== last) ?? id;
}

/** 这一段该配哪个动作，返回中文名（贴进脚本括号用）；空了就别给。 */
export function moveCue(feel: Feel | null, phase: Phase | null, last = '', deep = false): string {
  const id = degradeMove(moveIdOf(feel, phase, last, deep));
  return id ? (MOVE_WORD[id] ?? '') : '';
}

/** 同 moveCue，但位置未知时走 fallbackMove()，不把整段动作丢掉。 */
export function moveCueAny(feel: Feel | null, phase: Phase | null, last = ''): string {
  const id = degradeMove(moveIdAny(feel, phase, last));
  return id ? (MOVE_WORD[id] ?? '') : '';
}

/**
 * 短曲（< 6 分钟）的第 1 段不推。换歌那条已经把"名字 + 态度"一次说完了，
 * 45 秒后再来一句"你吃不吃这一套"就是把同一句话说两遍。
 * 长曲例外——15 分钟的曲子只在开头说一句太少，段 1 留着当"接着说"。
 *
 * 抽成导出的纯函数只为一个原因：这条判据要能被测试单独打，不然它埋在 onTick 里，
 * 下次谁改段算法都没人知道它还在不在。
 */
export const skipSignal = (signal: Signal): boolean =>
  signal.kind === 'segment' && signal.index === 1 && !isLongform(signal.durSec);

/** 最近 n 天的本地日期串，新的在前。 */
export function recentDays(timezone: string, n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, n); i += 1) out.push(localDay(timezone, now - i * 86_400_000));
  return out;
}

/** "10-25 周六" —— 给历史回执用，比纯 ISO 好读。 */
export function shortDay(timezone: string, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const ts = Date.UTC(y, m - 1, d, 4, 0, 0); // 取该日中午（UTC+8 前后都落在当天）
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'short' }).format(new Date(ts));
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${weekday}`;
}

export const quote = (t: Track, label: string): string => {
  const name = t.title || '未知曲目';
  const who = t.artist ? ` — ${t.artist}` : '';
  const album = t.album && t.album !== t.title ? `（《${t.album}》）` : '';
  return `《${name}》${who}${album}${label ? `，${label}` : ''}`;
};
