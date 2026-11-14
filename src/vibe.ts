/**
 * 听感层：判断"这首歌是什么路数"和"现在放到哪一段"，据此给不同的反应。
 *
 * 拆成两件事，因为它们的数据来源完全不同：
 *
 * - **相位（现在在歌的哪个位置）** —— 代码算得出来。系统媒体会话给播放位置和总长，
 *   按比例切就行。但它只能算"位置"，算不出"高潮在哪"：真正的副歌位置因曲而异，
 *   我们手上没有波形。所以这里给出的是"按比例估的大致段落"，对外措辞也必须这么写，
 *   不能吹成"我知道高潮来了"。
 *
 * - **曲风（这首歌什么路数）** —— 代码算不出来。媒体会话里没有 genre 字段，
 *   靠歌名关键词猜只在"钢琴版""live""remix"这类字面上有效，真正判断得靠她。
 *   所以这一层的分工是：代码给一个弱判作为起点，她可以用 music_tag 覆盖，
 *   覆盖结果落盘（music-tags.jsonl），下一次同一首歌直接读档案，不用再想。
 *
 * 不做的事：不猜"这首歌表达什么情绪"。那是她的活，代码越界只会产出一堆
 * 看起来很聪明、实际每首都不准的标签。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sameDir } from './storage.ts';
import type { Track } from './tracker.ts';

/** 听感档：不描述曲风，只描述"该怎么反应"。曲风有几十种，反应只有这几档。 */
export type Feel = 'hard' | 'soft' | 'old' | 'odd' | 'plain';

/** 一首歌内部的段落。位置按播放比例估，不是真波形。 */
export type Phase = 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro';

export const FEEL_TEXT: Record<Feel, string> = {
  hard: '烈',
  soft: '柔',
  old: '旧',
  odd: '怪',
  plain: '淡',
};

export const PHASE_TEXT: Record<Phase, string> = {
  intro: '开场',
  verse: '主歌',
  chorus: '副歌',
  bridge: '桥段',
  outro: '尾声',
};

/**
 * 这一档听感该怎么说话。
 *
 * 为什么把语气也交给代码：实测她拿到"表情就用【思考】"之后，写的却是"这套我吃"配【开心】——
 * 句子往暖里走，脸就跟着暖，表情池等于作废。真正的原因是"你吃不吃这一套"这句问话本身
 * 在邀夸奖。光在提示词里写"旧的要揶揄"不管用，得让语气和脸在同一行里一起给她，
 * 她照着一个语气写句子，脸才对得上。
 */
export const FEEL_TONE: Record<Feel, string> = {
  hard: '短、冲，句子可以不完整，别客气',
  soft: '轻、慢、字少，别分析',
  old: '端着，带点揶揄，可以损两句，但别说"土"',
  odd: '皱着眉，老实说听不懂，别装懂',
  plain: '直说有感觉没感觉，别硬夸',
};

/**
 * 超过这个长度就不按"主歌副歌"说事了。
 *
 * 实测踩到过：十五分钟的《Gymnopédie No.1》放到 5:45，按比例正落在 0.38 之后，
 * 被标成"副歌一带，这一首的高点"。古典没有副歌，而且"高点"是编的——
 * 她照着说出去就是硬伤。长曲只报"前段/中段/后段"，不假装知道结构。
 */
export const LONGFORM_SEC = 360;

export const isLongform = (durSec: number | null): boolean =>
  !!durSec && Number.isFinite(durSec) && durSec > LONGFORM_SEC;

/** 长曲的位置说法。只有"大致前后"，没有段落名。 */
export const LONGFORM_NOTE: Record<Phase, string> = {
  intro: '开头一段',
  verse: '前半段',
  chorus: '中段',
  bridge: '后半段',
  outro: '收尾段',
};

/** 相位压成四组，用来选表情——五个相位对表情没意义，位置感只有"低/高/转/收"。 */
type Slot = 'low' | 'high' | 'mid' | 'end';

const SLOT_OF: Record<Phase, Slot> = {
  intro: 'low',
  verse: 'low',
  chorus: 'high',
  bridge: 'mid',
  outro: 'end',
};

/**
 * 每个「听感 × 位置」该用哪些表情。
 *
 * 词只从当前形象的表里取（coo：19 个表情 + 18 个动作）。写错会被静默丢掉，
 * 而失败是看不见的——所以她拿到的是一个小池子，不是"随便挑一个"。
 * 每格 1–2 个表情，最多再带一个动作：三个以上她就会全写上去，气泡变成杂耍。
 *
 * 【listen.28】池子里一律只放**表情**，不放动作。原来混着 nod / flap / dance，
 * 事件文案就会写成「表情就用【认真】（顶多换成【点头】）」——把她照抄的"点头"
 * 叫成表情，她自然就往 `pet_say` 首括号里塞动作（实测 21:07 `【点头, 蹦迪】`、
 * 21:10 `【晕, 转圈】`，人没蹦，气泡里却写着蹦）。动作的活交给 moveCue，两不相干。
 *
 * 同理 `soft.low` 原来给的是【犯困】——那是"听柔歌会睡着"的根子，用户明确否掉了。
 * 柔歌的开头要的是【平静】，不是打瞌睡。
 */
const POOL: Record<Feel, Record<Slot, readonly string[]>> = {
  hard: {
    low: ['determined', 'thinking'],
    high: ['excited', 'surprised'],
    mid: ['determined', 'smug'],
    end: ['smug', 'pout'],
  },
  soft: {
    low: ['neutral', 'love'],
    high: ['love', 'shy'],
    mid: ['thinking', 'love'],
    end: ['neutral', 'happy'],
  },
  old: {
    low: ['thinking', 'smug'],
    high: ['happy', 'smug'],
    mid: ['pout', 'thinking'],
    end: ['smug', 'pout'],
  },
  odd: {
    low: ['confused', 'surprised'],
    high: ['surprised', 'excited'],
    mid: ['thinking', 'confused'],
    end: ['confused', 'pout'],
  },
  plain: {
    low: ['thinking', 'neutral'],
    high: ['happy', 'love'],
    mid: ['thinking', 'happy'],
    end: ['neutral'],
  },
};

/**
 * 词 id → 写进脚本的中文名。
 *
 * 为什么不直接写 id：实测三轮，她看到 `【thinking】` 时推理里出现过
 * "whale vocab doesn't have thinking, use happy" —— 词表里明明有（中英文都认），
 * 是英文 id 让她不确定。带中文释义也没用：她照抄的是括号里的词，还是会犹豫。
 *
 * 换成中文名就成了"照抄她词表里那一列"。用哪个别名是挑过的，不是取第一个：
 * `excited` 的正式名是「期待」，可用在一块摇滚副歌上语气不对，「星星眼」才是那张脸的样子。
 * 这些名字都来自鲸鱼形象 figure.json 的 names.zh，改词表要跟着改，test 里有对照。
 */
const WORD_TEXT: Record<string, string> = {
  neutral: '平静', happy: '开心', wink: '眨眼', love: '喜欢', shy: '害羞',
  surprised: '惊讶', angry: '生气', sad: '难过', sleepy: '犯困', thinking: '思考',
  smug: '得意', pout: '嘟嘴', worried: '担心', determined: '认真', flustered: '慌张',
  scared: '害怕', excited: '星星眼', cry: '大哭', confused: '疑惑',
  nod: '点头', shake: '摇头', dance: '跳舞', flap: '扑腾', hop: '小跳',
  sit: '坐下', sleep: '睡觉', jump: '跳', look: '张望', wave: '招手', bow: '鞠躬',
};

/** 这个位置用哪几个表情/动作，直接能贴进脚本（形如 `【思考】 或 【得意】`）。 */
export function emojiPool(feel: Feel, phase: Phase): string {
  return POOL[feel][SLOT_OF[phase]]
    .map((w) => `【${WORD_TEXT[w] ?? w}】`)
    .join(' 或 ');
}

/** 词 id 的中文名，给测试和文档用。 */
export const wordText = (w: string): string => WORD_TEXT[w] ?? w;

/** 这一格用的原始词 id，给测试对照形象词表用。 */
export function poolIds(feel: Feel, phase: Phase): readonly string[] {
  return POOL[feel][SLOT_OF[phase]];
}

/**
 * 现在放到歌的哪一段。按播放比例估。
 *
 * 比例是经验值：流行歌 3–4 分钟，副歌一般第一次进在四成左右，桥段在七成半，
 * 最后 12% 交给尾声（尾奏响着的时候不该有人说话）。古典、组曲这些比例完全不适用，
 * 所以调用方在"不知道曲长"或"曲子很短"时必须当成没有相位——宁可不说，也别报错位置。
 */
export function phaseOf(posSec: number | null, durSec: number | null): Phase | null {
  if (!durSec || !Number.isFinite(durSec) || durSec < 60) return null;
  if (posSec === null || !Number.isFinite(posSec) || posSec < 0) return null;
  const r = Math.min(1, posSec / durSec);
  if (r < 0.1) return 'intro';
  if (r < 0.38) return 'verse';
  if (r < 0.7) return 'chorus';
  if (r < 0.88) return 'bridge';
  return 'outro';
}

/* ---------- 弱判：从歌名/专辑/歌手的关键词猜个大概 ---------- */

interface Rule {
  re: RegExp;
  feel: Feel;
  genre: string;
}

/**
 * 顺序有意义：先判"版本"（live / remix / 钢琴版），再判"曲种"。
 * 一首摇滚的 live 版，说出来是"现场"，比"摇滚"更接近他此刻听到的东西。
 */
const RULES: readonly Rule[] = [
  { re: /live|现场|演唱会|concert/i, feel: 'hard', genre: '现场版' },
  { re: /remix|dj|club|house|techno|电音|混音/i, feel: 'hard', genre: '电子' },
  { re: /rock|metal|punk|grunge|摇滚|金属|朋克/i, feel: 'hard', genre: '摇滚' },
  { re: /rap|hip.?hop|trap|说唱/i, feel: 'hard', genre: '说唱' },
  { re: /戏曲|京剧|越剧|黄梅|昆曲|评弹|曲艺/i, feel: 'odd', genre: '戏曲' },
  { re: /实验|avant|noise|即兴|improv/i, feel: 'odd', genre: '实验' },
  { re: /古典|sonata|symphon|nocturne|prelude|concerto|协奏|奏鸣|交响|肖邦|chopin|bach|巴赫|debussy|德彪西/i, feel: 'soft', genre: '古典' },
  { re: /piano|钢琴|纯音乐|instrumental|bgm|ost|原声|配乐|轻音乐|八音盒/i, feel: 'soft', genre: '器乐' },
  { re: /民谣|folk|acoustic|不插电|吉他/i, feel: 'soft', genre: '民谣' },
  { re: /老歌|金曲|怀旧|经典|年代|民歌|红歌/i, feel: 'old', genre: '老歌' },
];

export interface Guess {
  feel: Feel;
  /** 猜出来的曲风名；猜不出就是空串。 */
  genre: string;
  /** 是不是有字面依据。false 时 feel 一定是 plain，调用方要按"未知"处理。 */
  sure: boolean;
}

/** 只看字面，不猜内容。命中不了的，一律承认不知道。 */
export function guessFeel(track: Pick<Track, 'title' | 'album' | 'artist'>): Guess {
  const hay = `${track.title} ${track.album} ${track.artist}`;
  for (const rule of RULES) {
    if (rule.re.test(hay)) return { feel: rule.feel, genre: rule.genre, sure: true };
  }
  return { feel: 'plain', genre: '', sure: false };
}

/* ---------- 档案：她标过的曲风，落盘复用 ---------- */

export interface VibeTag {
  /** trackKey(track) 的原样值。 */
  key: string;
  genre: string;
  feel: Feel;
  /** 最后一次标记时间（epoch ms）。 */
  ts: number;
  /** 旧档案没有这些字段；新标签用来学习同专辑、同歌手与声音近邻。 */
  title?: string;
  artist?: string;
  album?: string;
  features?: { bpm: number; rms: number; bass: number; mid: number; high: number };
}

const FEELS: readonly Feel[] = ['hard', 'soft', 'old', 'odd', 'plain'];

export const isFeel = (v: unknown): v is Feel => typeof v === 'string' && (FEELS as readonly string[]).includes(v);

/**
 * 曲风档案。一首歌一行 JSONL，后写的覆盖先写的（内存里只留最新一条）。
 *
 * 为什么要落盘而不是每轮让她重新判断：同一首歌一天能听三遍，段事件一天能推几十条，
 * 每条都让她重新想"这是什么路数"，既费又飘——同一首歌两段之间换个说法，
 * 反应就前后不一致了。标一次，之后按档案走。
 */
export class VibeStore {
  /** 写入落点与读取时要合并的目录，写入目录排第一。 */
  private readonly paths: string[];
  private readonly path: string;
  private readonly cache = new Map<string, VibeTag>();
  private fellBack = false;

  /**
   * @param memoryDir 记忆写入目录（可能是自定义目录，也可能是宿主默认目录）
   * @param localDir  宿主默认目录：只参与读取，本机旧档案照样能用
   */
  constructor(memoryDir: string, localDir?: string) {
    this.path = join(memoryDir, 'music-tags.jsonl');
    this.paths = localDir && !sameDir(memoryDir, localDir)
      ? [this.path, join(localDir, 'music-tags.jsonl')]
      : [this.path];
    this.load();
  }

  /** 是否已经退到本机兜底写过。 */
  get degraded(): boolean {
    return this.fellBack;
  }

  /**
   * 两处合并读。同一个 key 出现两次（本机旧档案 + 同步目录新档案）时**取时间新的那个**：
   * 曲风是会改的，她重新标过一次，就不该再按去年那次的老标签换表情。
   */
  private load(): void {
    for (const file of this.paths) {
      if (!existsSync(file)) continue;
      let raw = '';
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as VibeTag;
          if (!row?.key || !isFeel(row.feel)) continue;   // 坏行跳过，不整份报废
          // 旧 key 本来就含 app/title/artist：补出歌手供学习，不伪造专辑或音频特征。
          const parts = row.key.split('\u0001');
          row.title ??= parts[1] ?? '';
          row.artist ??= parts[2] ?? '';
          const cur = this.cache.get(row.key);
          if (cur && cur.ts > row.ts) continue;
          this.cache.set(row.key, row);
        } catch {
          // 一行坏了只坏一行
        }
      }
    }
  }

  get(key: string): VibeTag | null {
    return this.cache.get(key) ?? null;
  }

  /** 当前每首歌的最新标签，供学习器建立歌手/专辑/声音映射。 */
  all(): VibeTag[] {
    return [...this.cache.values()];
  }

  /** 记一条。空 genre 也收——"我认得这首，但说不出是什么"本身是有效信息。 */
  set(
    key: string,
    genre: string,
    feel: Feel,
    ts: number,
    meta: Partial<Pick<VibeTag, 'title' | 'artist' | 'album' | 'features'>> = {},
  ): VibeTag {
    const tag: VibeTag = { ...meta, key, genre: genre.trim().slice(0, 40), feel, ts };
    this.cache.set(key, tag);
    const line = `${JSON.stringify(tag)}\n`;
    if (this.writeLine(this.path, line)) return tag;
    // 记忆目录不可用：落到本机，读取合并，档案不会因为拔了个盘就断档。
    const spare = this.paths.length > 1 ? this.paths[this.paths.length - 1] : null;
    if (spare && this.writeLine(spare, line)) this.fellBack = true;
    return tag;
  }

  private writeLine(file: string, text: string): boolean {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 多少首标过——给 music_taste 用。 */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 清空全部曲风档案 —— 给设置页的「清除」用。
   *
   * 内存和文件一起清。只删文件不清内存是常见的假清除：设置页显示已清空，
   * 这一场还按旧档案换表情，要等重启才真的干净。两处目录都删，否则清完
   * 另一处还会被重新读回来。
   */
  clear(): number {
    const n = this.cache.size;
    this.cache.clear();
    for (const file of this.paths) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch { /* 删不掉也认了，内存已清；下一次 set 会重建文件 */ }
    }
    return n;
  }

  /** 按听感统计，多的在前。 */
  tally(): Array<{ feel: Feel; count: number }> {
    const counts = new Map<Feel, number>();
    for (const tag of this.cache.values()) counts.set(tag.feel, (counts.get(tag.feel) ?? 0) + 1);
    return [...counts.entries()]
      .map(([feel, count]) => ({ feel, count }))
      .sort((a, b) => b.count - a.count);
  }
}
