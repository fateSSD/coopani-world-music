/**
 * 「我爱听什么」——她自己的口味档案，一份人也能直接改的 Markdown。
 *
 * 和 `music_taste` 的区别必须分清楚，否则这东西会退化成第二张统计表：
 *   music_taste  → 他听得多的是谁、哪首被循环、哪个时段在听。**数字，算出来的。**
 *   这份文件     → 我吃哪一套、哪一类我听两遍就烦。**第一人称，她写的。**
 *
 * 为什么落在记忆目录（跟着人走），而不是本机：
 * 它是"她是谁"的一部分，不是"现在怎么样"。公司那台和家里那台应该认出同一个她。
 * 而逐日听歌记录会被 `store.prune(keepDays)` 按天删掉（默认 90 天）——
 * **本文件在记忆目录根部、不在 listening/ 子目录下，prune 的扫描范围碰不到它**，
 * 这条由 test 里的断言钉住，别改成"顺手也清理一下旧文件"。
 *
 * 为什么她自己写、而不是我们从历史里归纳一版：
 * 归纳出来的第一版再准，也是"他的口味"，不是"她的"。她听出来什么就往里添什么，
 * 这份东西才有作为人格的分量；一开始空着不丢人。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOUL_FILE = 'music-soul.md';

/** 小节键 → 标题。键是给工具参数用的（模型填英文更稳），标题是文件里人看到的那行。 */
export const SOUL_SECTIONS = {
  love: '我确实爱听',
  tolerate: '听听就算了',
  hate: '我听不下去的',
  unsure: '还没想明白',
} as const;

export type SoulSection = keyof typeof SOUL_SECTIONS;

export function isSoulSection(v: unknown): v is SoulSection {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SOUL_SECTIONS, v);
}

/** 一条最多多少字。她爱写长句，写长了这份文件下次自己都不想读。 */
export const SOUL_LINE_MAX = 60;

/** 每一节最多几条。超了不是报错，是提示她先删 —— 否则三个月后就是一篇散文。 */
export const SOUL_SECTION_MAX = 12;

/** 注入提示词时的上限。超了截断并告诉她去看全文，别把系统前缀撑爆。 */
export const SOUL_INJECT_MAX = 1600;

export function soulPath(memoryDir: string): string {
  return join(memoryDir, SOUL_FILE);
}

/**
 * 空骨架。
 *
 * 刻意写成"小节 + 一句怎么写"，不写示范句子：给了示范她就会照抄，
 * 最后这份文件里全是我们的措辞，不是她的（同一个坑在段位文案上踩过三次）。
 */
export function soulSkeleton(): string {
  const parts = [
    '# 我爱听什么',
    '',
    '这是我自己的口味，不是统计。谁听得多、哪首被循环，那是 `music_taste` 的事。',
    '这里只写一件事：**我**吃哪一套。',
    '',
  ];
  for (const title of Object.values(SOUL_SECTIONS)) {
    parts.push(`## ${title}`, '');
  }
  parts.push(
    '---',
    '',
    `写的时候：用第一人称，一条一行，不超过 ${SOUL_LINE_MAX} 个字。`,
    '**同类听到第二遍就可以写下来了**——不用等到第三遍。拿不准的写进「还没想明白」，那也是一条。',
    '**四节都要用，不是只记好听的那一头。** 皱眉的那一刻进「我听不下去的」；"行，但不想再放一次"进「听听就算了」；分不清是歌不对还是这会儿不对，进「还没想明白」。',
    '**只剩「我确实爱听」有字、另外三节全空，那不是挑剔，是只记了一半。**',
    '这份一直空着，不是谨慎，是没在听。',
    '',
  );
  return parts.join('\n');
}

/** 读全文。文件不在就返回 null（这时候别自作聪明替她造一份，交给 ensureSoul）。 */
export function readSoul(memoryDir: string): string | null {
  const file = soulPath(memoryDir);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 文件不存在就建骨架，返回当前全文。
 *
 * 建骨架**不算她写东西**：它是容器，不是内容。所以这一步不受「允许她改口味档案」那个开关限制。
 */
export function ensureSoul(memoryDir: string): string {
  const existing = readSoul(memoryDir);
  if (existing !== null) return existing;
  const text = soulSkeleton();
  writeSoul(memoryDir, text);
  return text;
}

/**
 * 原子写：先写临时文件再改名。
 *
 * 直接覆盖的话，写到一半断电/盘满/网盘锁文件，留下的就是半份口味 ——
 * 而这份文件没有备份、也没有第二处能读回来（它不是逐日追加的）。
 * 临时名带 pid，两台机器同时写也不会互相踩。
 */
export function writeSoul(memoryDir: string, text: string): boolean {
  const file = soulPath(memoryDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      writeFileSync(file, text, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

interface Span {
  head: number;
  /** 插入点：这一节的正文末尾（尾部空行之前）。 */
  insertAt: number;
}

/** 找某一节的范围。认 `## 标题`，也容忍前后多打的空格。 */
function findSpan(lines: string[], title: string): Span | null {
  const want = `## ${title}`;
  const head = lines.findIndex((l) => l.trim() === want);
  if (head < 0) return null;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('## ') || t === '---') {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt - 1 > head && lines[insertAt - 1].trim() === '') insertAt -= 1;
  return { head, insertAt };
}

export interface SoulWriteResult {
  ok: boolean;
  /** 给工具回执的一句话。成功了也要说清"加在哪一节"。 */
  message: string;
}

/**
 * 往某一节里加一条。
 *
 * 去重按"包含"：她已经写过「肖邦的夜曲」，再写「肖邦夜曲」不该多出一条 —— 换个词就重复，
 * 这份文件很快就没人看了。上限满了不加，但要明说为什么，让她自己去删。
 */
export function addSoulLine(memoryDir: string, section: SoulSection, raw: string): SoulWriteResult {
  const line = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^[-·•]\s*/, '');
  if (!line) return { ok: false, message: '没有内容可写。' };
  const clipped = line.length > SOUL_LINE_MAX ? `${line.slice(0, SOUL_LINE_MAX)}…` : line;

  const text = ensureSoul(memoryDir);
  const lines = text.split(/\r?\n/);
  const title = SOUL_SECTIONS[section];
  const span = findSpan(lines, title);
  if (!span) {
    // 用户可能把这一节删了。补回来，别默默丢她这一条。
    const next = [...lines, '', `## ${title}`, '', `- ${clipped}`, ''];
    return writeSoul(memoryDir, next.join('\n'))
      ? { ok: true, message: `「${title}」这一节原来不在文件里，我补上了，写进第一条：${clipped}` }
      : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
  }

  const body = lines.slice(span.head + 1, span.insertAt);
  const items = body.filter((l) => l.trim().startsWith('- '));
  const dup = items.find((l) => {
    const t = l.trim().replace(/^-\s*/, '');
    return t === clipped || t.includes(clipped) || clipped.includes(t);
  });
  if (dup) {
    return { ok: true, message: `「${title}」里已经有这条了（${dup.trim().replace(/^-\s*/, '')}），没重复写。` };
  }
  if (items.length >= SOUL_SECTION_MAX) {
    return {
      ok: false,
      message: `「${title}」已经有 ${items.length} 条，装不下了。先删一条再加 —— 这一节留的是最硬的几条，不是流水账。`,
    };
  }

  lines.splice(span.insertAt, 0, `- ${clipped}`);
  return writeSoul(memoryDir, lines.join('\n'))
    ? { ok: true, message: `写进「${title}」：${clipped}（这一节现在 ${items.length + 1} 条）。` }
    : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
}

/** 删掉第一条包含 `find` 的条目。改主意、口味变了都靠它。 */
export function dropSoulLine(memoryDir: string, find: string): SoulWriteResult {
  const needle = String(find ?? '').trim();
  if (!needle) return { ok: false, message: '没说删哪一条。' };
  const text = readSoul(memoryDir);
  if (text === null) return { ok: false, message: '这份文件还不存在，没有可删的。' };

  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().startsWith('- ') && l.includes(needle));
  if (at < 0) return { ok: false, message: `没找到含「${needle}」的那一条。` };
  const removed = lines[at].trim().replace(/^-\s*/, '');
  lines.splice(at, 1);
  return writeSoul(memoryDir, lines.join('\n'))
    ? { ok: true, message: `删掉了：${removed}` }
    : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
}

/** 条目数（只数 `- ` 开头的行）——给设置页显示规模，别把标题行算进去。 */
export function soulLineCount(text: string | null): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).length;
}

/** 每节各几条。按 `## 标题` 认节，认不出的节不算进任何一节。 */
export function soulSectionCounts(text: string | null): Record<SoulSection, number> {
  const out: Record<SoulSection, number> = { love: 0, tolerate: 0, hate: 0, unsure: 0 };
  if (!text) return out;
  const byTitle = new Map<string, SoulSection>(
    (Object.keys(SOUL_SECTIONS) as SoulSection[]).map((k) => [SOUL_SECTIONS[k], k]),
  );
  let cur: SoulSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith('## ')) {
      cur = byTitle.get(t.slice(3).trim()) ?? null;
      continue;
    }
    if (cur && t.startsWith('- ')) out[cur] += 1;
  }
  return out;
}

/**
 * 「只记了好的那一半」的催办。返回空串＝不用催。
 *
 * 2026-11-03 Mr.Q 的原话：「她的听歌清单里只有喜欢的，没有其他三种，要把规则收紧一点」。
 * 实测 `music-soul.md`：love 2 条，另外三节全空。原因是这套文案一直在强调"我爱听什么"，
 * 她就把这份文件当成了点赞墙 —— 而"嫌弃"只发生在气泡里，说完就散，第二天什么都不剩。
 *
 * 门槛写死在代码里，不靠她自觉：
 *   - love < 2 不催（一条的时候还看不出偏向，催了像逼她交作业）；
 *   - 三节里有任何一条就不催（说明她知道有这三节）；
 *   - 催办只提醒"该记哪一类"，**绝不提供现成的负面判断** —— 给了她就会编一条来交差。
 */
export function soulGapNote(text: string | null): string {
  const c = soulSectionCounts(text);
  if (c.hate + c.tolerate + c.unsure > 0) return '';
  if (c.love < 2) return '';
  return [
    '另外三节还全空着：好听的一直在记，听不下去的和拿不准的一条没落。',
    '嫌过的那首、说过"还行但不想再放"的那首，本来就该进这里——光在气泡里说一遍等于没说过。',
    '但别为了填满编：真皱过眉、说得出是哪一类，才写。',
  ].join('');
}

/**
 * 清空内容、只留骨架 —— 设置页的「清除」用。
 *
 * 不是 `unlink`：删掉文件下次启动又会长出一份空的，两者看起来一样，但"删文件"会让
 * 用户的编辑器停在已删除的路径上（下次保存又写回来一份旧的）。写回骨架的语义更干净。
 * 这条不可恢复，所以调用方给的是 `danger: true`。
 */
export function resetSoul(memoryDir: string): SoulWriteResult {
  const before = soulLineCount(readSoul(memoryDir));
  if (!before) return { ok: false, message: '本来就是空的，没动。' };
  return writeSoul(memoryDir, soulSkeleton())
    ? { ok: true, message: `清掉了 ${before} 条，只剩空骨架。` }
    : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
}

/**
 * 给提示词用的正文。
 *
 * 三个状态分开说：没写过 / 写了一点 / 从来没建过文件。
 * 混成一句"（空）"的话，她分不清是"我还没写"还是"文件丢了"，前者她会去写，后者她会去猜。
 */
export function soulForPrompt(text: string | null): string {
  if (text === null) return '（这份文件还没建。下次启动会自动建一份空的；现在别凭印象说自己的口味。）';
  if (soulLineCount(text) === 0) {
    return '（还一条没写。听出点什么再用 `music_soul` 往上添，别为了填满而编。）';
  }
  // 催办跟在正文后面，不写进文件 —— 文件是她写的东西，这是系统在提醒她怎么用它。
  const gap = soulGapNote(text);
  const tail = gap ? `\n\n（${gap}）` : '';
  if (text.length <= SOUL_INJECT_MAX) return `${text}${tail}`;
  return `${text.slice(0, SOUL_INJECT_MAX)}\n…（后面还有，太长没放进来；要全文用 \`music_soul\` 不带参数读。）${tail}`;
}
