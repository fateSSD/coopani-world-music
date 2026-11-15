/**
 * 一起听歌 —— World 实现。
 *
 * 三件事各归各的层：
 *   nowplaying.ts  从系统媒体会话里读出"在放什么"（常驻子进程）
 *   tracker.ts     把每秒的采样收敛成"值得开口的时刻"（纯逻辑，可测）
 *   history.ts     把收尾的歌落成按天的 JSONL（可 grep）
 * 这里只做接线：把 signal 变成事件、把状态变成工具回执和提示词变量。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  Logger, StoragePart, ToolDef, World, WorldHost, WorldWebUiDecl, WorldLamp,
} from 'cortico/core/types.ts';
import { MUSIC_ID, musicConfigGroups, type MusicConfigSection } from './config.ts';
import { isPeerRunning } from './peer.ts';
import { resolveLayout, sameDir, stillWritable, type StorageLayout } from './storage.ts';
import { NowPlayingBridge, findConHost, findPowerShell, isProcessAlive, type TickPayload } from './nowplaying.ts';
import { pickSession, playerLabel, type PickResult } from './players.ts';
import { ListenStore, summarize, type ListenRecord, type WantItem } from './history.ts';
import { LyricStore, linesAt, linesFrom, quoteLines, segmentLines, type LyricInput } from './lyrics.ts';
import { runControl, statusText, type ControlAction } from './control.ts';
import {
  describeTrack, pickBest, playAttempt, searchAll, sourceLabel, bareTitle,
  type Track as SearchTrack,
} from './picker.ts';
import {
  ListeningTracker, clockOf, humanDuration, localClock, localDay, trackKey,
  type FinishedTrack, type Signal, type Track,
} from './tracker.ts';
import {
  EMPTY_RELAY, RELAY_MAX_CHAIN, relayArm, relayHolds, relayMarkFired, relayShouldFire, sanitizeRelay,
  type RelayPick, type RelayState,
} from './relay.ts';
import {
  SOUL_FILE, addSoulLine, dropSoulLine, ensureSoul, isSoulSection,
  readSoul, resetSoul, soulForPrompt, soulGapNote, soulLineCount, soulPath,
} from './soul.ts';
import {
  FEEL_TEXT, FEEL_TONE, LONGFORM_NOTE, VibeStore, guessFeel, isFeel, isLongform, phaseOf, poolIds, wordText,
  type Feel, type Phase,
} from './vibe.ts';
import { AudioFeatureAverages, audioFeaturesOf, describeAudioFeatures, suggestGenre, type AudioFeatures } from './genre.ts';
import {
  HearingStore, MIN_SLICE_SEC, cloudListen, hearingModeOf, hearingNotice, hearingStatusText, hearingUsable,
  sheetShort, sheetText,
  type HearingMode, type HearingSlice, type HearingStatus,
} from './hearing.ts';

/** 构建标记。每次改行为都改一下——"改了没效果"和"改了改错了"靠它两秒分开。 */
const BUILD_TAG = 'b2026-10-31.listen.91';

/**
 * 等歌词的上限。超时就不给词，抓取在后台继续。
 *
 * 实测一次「搜 + 取词」0.9–1.6 秒（单源取词）。原来定 1.8 秒，理论上够，实际上不够：
 * 2026-10-29 21:21 那次换歌《ハルモニア》，单独跑同一个接口只要 0.9 秒，
 * 但事件链上同时还有炉石在跑，1.8 秒没等到 —— 于是那一句永久没词，
 * 而「刚换歌」恰恰是最想评词的时候。十几分钟里这个窗口漏了 1/3。
 *
 * 提到 2.6 秒。代价是换歌推送最多晚 0.8 秒（她打字本身还要几秒，用户感知不到），
 * 收益是这条窗口基本不再漏 —— 这个交换划算。
 * 再往上就不值了：等久了换歌那句会迟到，「换歌必说一句」的时效性优先。
 */
const LYRIC_WAIT_MS = 2600;

/** 自己的提示词模板，按本文件位置定位。绝不能用 ctx.packageDir（那是 bot 的代码包目录）。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
/** 系统声音的采集脚本与独立启动器（WASAPI 回环，往 TEMP 写 coopani-audio.json）。 */
const AUDIO_PROBE_FILE = fileURLToPath(new URL('../assets/audio/probe.ps1', import.meta.url));
const AUDIO_OUT_FILE = join(tmpdir(), 'coopani-audio.json');
/** 本地深听：分析器、Python 环境与模型都在本机，不经过云端。 */
const HEARING_ANALYZER_FILE = fileURLToPath(new URL('../assets/hearing/analyze.py', import.meta.url));
/**
 * 本机深听环境装在哪。
 *
 * 必须**每台机器一个默认位置**，不能写死某一台的盘符——写死之后别人装上就是"找不到分析器"，
 * 而那句话说起来像扩展坏了。装在 `%LOCALAPPDATA%\CoopaniMusic\hearing`（和设置页推荐的记忆目录同源），
 * 一条安装脚本就能落到这个位置；老机器上已经在别处装好的，仍然认那两处旧路径。
 */
const HEARING_HOME = (process.env.COOPANI_HEARING_HOME ?? '').trim()
  || join(process.env.LOCALAPPDATA || homedir(), 'CoopaniMusic', 'hearing');
/** 这个仓库最早在自己机器上装的那两处（2026-10-31）。只做兼容，不再写进文档。 */
const LEGACY_HEARING_PYTHON = 'E:/Coopanion/data/hearing-venv/Scripts/python.exe';
const LEGACY_HEARING_MODELS = 'E:/Coopanion/data/hearing/models';
const pickExisting = (preferred: string, legacy: string): string => {
  if (existsSync(preferred)) return preferred;
  return existsSync(legacy) ? legacy : preferred;
};
const HEARING_PYTHON = (process.env.COOPANI_HEARING_PYTHON ?? '').trim()
  || pickExisting(join(HEARING_HOME, 'venv', 'Scripts', 'python.exe'), LEGACY_HEARING_PYTHON);
const HEARING_MODELS_DIR = (process.env.COOPANI_HEARING_MODELS ?? '').trim()
  || pickExisting(join(HEARING_HOME, 'models'), LEGACY_HEARING_MODELS);
const HEARING_CACHE_DIR = join(HEARING_MODELS_DIR, 'demucs');
/**
 * 换歌之后多久自动听第一段，也是两次分析之间的硬下限。
 *
 * 30 秒的理由：短于这个，切出来的常常还是上一首的尾巴；长于这个，一首三分钟的歌就只能听
 * 一段，走向（多了什么声部、调性动没动）永远拼不出来。这个数是照着"一首歌至少两段"倒推的。
 */
const FIRST_HEAR_SEC = 30;

/**
 * 她回一条事件的窗口：推送之后这么久内说的话，才算「对这条事件的回应」。
 *
 * 复读检测要用它把音乐场景的句子从混场里挑出来。段事件间隔 40–50 秒，50 秒够覆盖她的回复
 * （实测她的 pet_say 都在推送后几秒内），又不至于把隔壁牌桌的话卷进来。
 */
const SAY_WINDOW_MS = 50_000;

/**
 * 能量变化到多少就算「歌在动」，值得凑近听一段。
 *
 * `AudioFeatureAverages.drift()` 的返回值，五维归一化后的欧氏距离。
 *
 * **0.17 是量出来的，不是拍的。** 2026-11-10 18:59–19:04 在真机上采了 19 个样本
 * （15 个来自每 15 秒一条的诊断行，4 个来自触发行，跨三首歌），排序后：
 * 0.019 / 0.062 / 0.070 / 0.081 / 0.082 / 0.083 / 0.089 / 0.099 / 0.099 / 0.107 /
 * 0.112 / 0.116 / 0.126 / 0.164 / 0.169 / 0.173 / 0.195 / 0.210 / 0.223
 * 中位 0.107，P75 = 0.169，P90 = 0.195 —— 取 0.17，落在 P75 上，约四分之一的时间会提前听。
 *
 * 初值 0.08 的教训写在这里：那时几乎每个采样都超阈值，自动深听退化成每 30 秒跑一次的
 * 定时器，比原来的 120 秒还费，而且一点「听得出变化」的意思都没有。
 *
 * ⚠️ 另外得承认：8 个采样（约 7 秒）对 8 个采样这个窗口，量得出「这一段比上一段吵」，
 * 量不出「鼓在第 47 秒进来了」。这个数是动态响度的代理，不是编曲分析。
 */
export const HEAR_DRIFT = 0.17;

/**
 * 两次「因为声音在变」的深听之间，至少隔这么久。
 *
 * 没有这条，硬下限 30 秒一到、drift 又还高，就会连着跑 —— 实测 18:56:05 和 18:56:39
 * 两次分析几乎首尾相接，那一段 CPU 是被吃满的。
 */
const HEAR_DRIFT_SEC = 60;

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


/** 本机分轨的英文轨名 → 中文。事件和回执里说人话。 */
const STEM_ZH: Record<string, string> = {
  drums: '鼓', bass: '贝斯', other: '其他乐器', vocals: '人声', guitar: '吉他', piano: '钢琴',
};

const STATE_FILE = 'music-state.json';

/** 本机分析器吐出来的那份 JSON。常驻和一次性两条路都按这个形状收。 */
interface LocalAnalysis {
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
const speechNorm = (s: string): string =>
  (s || '').replace(/[\s。、，,.!?！？…・「」『』()（）\[\]【】ー~～\-—:：;；'"’”‘“]/g, '').toLowerCase();

function speechSim(heard: string, lyric: string): number {
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

export interface MusicWorldOptions {
  cfg: MusicConfigSection;
  dataDir: string;
  timezone: string;
  botName: string;
}

/** 事件声明（describe.json 与 pushEvent 共用一份，别写两处）。 */
export const EVENT_DECLS = [
  { kind: 'start', type: 'music.start', trigger: 'flush' as const, zh: '从静默里开始放歌。', en: 'Playback started after a silence.' },
  { kind: 'track', type: 'music.track', trigger: 'debounce' as const, zh: '换歌了。', en: 'The track changed.' },
  { kind: 'loop', type: 'music.loop', trigger: 'flush' as const, zh: '同一首歌在这次收听里第 N 遍。', en: 'The same track came round again.' },
  { kind: 'fidget', type: 'music.fidget', trigger: 'flush' as const, zh: '短时间内连续跳歌。', en: 'Several tracks skipped in a row.' },
  { kind: 'night', type: 'music.night', trigger: 'flush' as const, zh: '深夜仍在听。', en: 'Still listening late at night.' },
  { kind: 'long', type: 'music.long', trigger: 'flush' as const, zh: '连续听满一档时长。', en: 'A long stretch of listening.' },
  { kind: 'segment', type: 'music.segment', trigger: 'debounce' as const, zh: '这一首又走完一段（每首最多 3 段，短歌约一分钟一段，长曲按曲长拉开），可以就这一段说一句。', en: 'Another passage of the current track went by (at most three per track); a cue to comment on this stretch.' },
  { kind: 'relay', type: 'music.relay', trigger: 'flush' as const, zh: '她自己点的那一首快放完了，该把下一首递过去。', en: 'The track she picked is nearly over; time to hand over the next one.' },
  // 环境没准备好：Coopani 太旧、动作补丁打不上、或找不到宿主包。
  // 存在的理由：简介里写了版本要求他不一定读，设置页的红灯他不一定看 ——
  // 桌宠开口，是唯一一定会被注意到的渠道。
  { kind: 'setup', type: 'music.setup', trigger: 'flush' as const, zh: '这台机器的环境不对：Coopani 太旧、动作补丁打不上，或者找不到宿主包。附一句该怎么跟他说。', en: 'Something about this machine is off: Coopani too old, host patch blocked, or host pack missing. Carries what to tell the operator.' },
  // 深听状态：**能用也要说一次**——宿主重启不重建 system 前缀，老会话里的人手里还是旧提示词，
  // 她连"有深听"都不知道，被问「你听得清吗」只能答听不清。事件是唯一每轮必达的通道。
  { kind: 'hearing', type: 'music.hearing', trigger: 'flush' as const, zh: '深听状态变了：刚能用（每个版本说一次），或者用不了（云端没密钥 / 本机没装本地环境，一天一次）。正文含怎么用、以及它优先于旧提示词里"不许描述具体声音"那句。', en: 'Deep-listening status changed: newly usable (once per build), or unusable (missing cloud key / local engine not installed, at most daily). The text says how to use it and that it overrides the older "never describe specific sound" rule.' },
] as const;

const EVENT_BY_KIND = new Map(EVENT_DECLS.map((e) => [e.kind, e]));

/**
 * 每一段该说什么。按段号取，最后一项兜底（配置把段数调到 4 以上时也够用）。
 *
 * 为什么写在事件正文里而不只写在提示词里：实测过三轮。同一句提示推到三段，她就把
 * 上一段的话复述一遍（连推理文本都一模一样）。提示词是背景，事件正文才是她每轮真正
 * 在读的那一行。
 */
/**
 * 相位的中文说法。一律带"一带"两个字——这是按播放比例切出来的，不是波形分析出来的。
 * 写成"现在是副歌"就是吹牛：一首歌真正的高潮在哪，我们手上没有数据；写成"副歌一带"，
 * 她说话时就不会把话说死，说错了也不至于下不来台。
 */
const PHASE_NOTE: Record<Phase, string> = {
  intro: '开场一带，还没进正题',
  verse: '主歌一带，力气还没上来',
  chorus: '副歌一带，这一首的高点',
  bridge: '桥段一带，下面要变',
  // 原本是「尾声一带，尾奏快了」。那个「快了」是个钩子：她每首到这儿都说一句「快到头了」，
  // 一晚上十次，八次的措辞只差一个字。段位是事实，催不催是她自己的事。
  outro: '尾声一带',
};

const SEGMENT_ASK = [
  // 第 1 段只在长曲时才会推到（短曲的那一段在 onTick 里被跳过了）。
  '回一句：这首往后听下来的感觉。歌名和态度换歌时已经讲过了，别重复。',
  // 段 2（"说他"）不在这里——它按本场第几首轮换，见 TALK_ANGLES。
  '',
  // 原来这里写的是「或者一句收尾就停」。实测她理解成「给这首收场」：每首第 3 段都宣告
  // 「快完了」，还配一句「我不吵你」——那是把陪听说成噪音，Mr.Q 的原话是「她也没吵我啊」。
  // 所以「收」的意思要说清是**收这句话**，不是替这首谢幕。
  //
  // 2026-11-10：同一件事他说了第二遍，换成「她老说不催我，问题是她也没催我啊」——
  // 上次只堵了「我不吵你」「我道歉」，她换个词继续说「我不催你」（6829 条台词里 81 次）。
  // 这次把「说完就收」改成能检验的说法：**句子讲完就停，末尾不补保证**。
  '回一句：往后——下一首、还要听多久。句子讲完就停，别在末尾补一句保证（"我不催你""你随意""都行"这一类不算内容）。别只说"继续放""接着来"，那三个字你已经用过好几遍了；别宣告这首快完了，也别为自己的存在道歉。',
];

/**
 * 段 2 说哪一样，按"这一场第几首"轮换。
 *
 * 为什么非轮换不可：原来 SEGMENT_ASK[1] 写的是「说他——第几首、连着多久、几点」，
 * 等于给了她一张填空表。实测 19:53–20:22 连续 9 首，9 次全是同一个格式：
 *
 *   第 27 首，七点五十三 / 第 28 首，快八点了 / 第 30 首了，八点零一
 *   第 34 首，八点十二 / 第 35 首，八点十六 / 第 36 首，八点二十一
 *
 * 她抄的是格式，不是内容——和"吃不吃这一套"变成"我吃"是同一个毛病，我这是第二次犯。
 * 根子在"一次给四样事实"：给一张表她就填表，给一样她才说话。
 *
 * 所以现在一次只给一样实据，四首一循环，其中一首完全不给数字（逼她说点别的）。
 * 末位 % 4 保证相邻两首一定不同——同一天里连着两首拿到同一样事实的情况不会出现。
 */
/** 隔多少首才许说一次"总共听了多少"。Mr.Q 要的是"一二十首"，取 18。 */
export const COUNT_MILESTONE = 18;

export const TALK_ANGLES = [
  // 注意别写成"别报第几首"——这一格恰恰给了她"这一场第 N 首"，一边给一边禁会让她两头不是。
  // 禁的是那个格式，不是数字本身。
  '说今晚的量。数字可以用，但别写成"第 N 首，几点"这种并列报账，说成一句人话——他的耐性、他今晚没打算停。',
  '说过了多久。别报钟点，说"一个多小时"这种粗的，或者干脆只说你的感受。',
  '说人。他认准了谁、连着放同一个嗓子的样子，或者你注意到他手上的动作。',
];

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
 * 这一段该配哪个动作。
 *
 * 【律动】【打拍子】【闭眼听】三个是新加到鲸鱼形象里的（宿主补丁
 * `coopani/patch-whale-bounce.mjs`），加原来的【跳舞】（原地踩点）和
 * 【蹦迪】（离地 + 横穿一段），一共五种，情绪分得开了。
 *
 * 配的原则是**跟着情绪走，不跟着节拍走**：烈的歌在副歌该蹦，抒情歌到收尾该闭嘴听，
 * 淡的歌不给动作——那首连话都没什么好说的，还动就不对了。
 */
/**
 * 动作的中文名。**只给名字，不给整句。**
 *
 * 原来这里是整句「动作配【蹦迪】，别用【跳舞】。」，写在事件正文最后，让她单独发一条
 * `pet_act`。实测四条里有就一条她忘了发（21:44:39 只说了话，人站着没动）。所以改成
 * 把动作名并进表情那个括号——宿主的 parseScript（src/script.ts:84）会把
 * `【星星眼, 蹦迪】` 拆成 actions=[excited, bounce]，客户端 pet-app.js:461 先执行动作
 * 再打字，一条 `pet_say` 里全办完，不用她再记一次调用。
 */
const MOVE_WORD: Record<string, string> = {
  bounce: '蹦迪',
  dance: '跳舞',
  groove: '律动',
  tap: '打拍子',
  enjoy: '闭眼听',
  // 2026-10-28 新增六个：把「被词戳中」「听不下去」「跟着哼」「应援」「余韵」「凑近听」
  // 这六种真实反应补上。原来四个动作只按"烈/柔/老"三档分，同一个档里换首还是同一个动画。
  stunned: '怔住',
  recoil: '退半步',
  hum: '跟着哼',
  // 原名「应援」。2026-10-28 三首摇滚实测：给了 5 次机会（3 次是首选），她一次都没选，
  // 全挑了蹦迪或打拍子。「应援」是给台上的人加油，她在陪听、没有台上的人，这个词在她那儿没有位置。
  // 改成「跟拍挥」——名字只描述动作本身，不带「为谁」的意思。
  cheer: '跟拍挥',
  sigh: '余韵',
  peek: '凑近听',
  // 坐下哼：柔歌的可选姿态。不设首选——坐姿比较特殊，什么时候坐下来听完由她自己定。
  humsit: '坐着哼',
  // 坐着、两手捂耳、头跟着摇。
  // 和「坐着哼」的分界：坐着哼是**跟着词哼**（低头），这个是**不想听别的、只想听这一首**（手把耳朵堵上）。
  // 2026-10-30 Mr.Q 点名要的。
  earcover: '捂耳朵听',
  // 下面三个是宿主原生动作，只在"没打补丁的宿主"上作为降级目标出现。
  // 不补上的话降级白做：id 换对了，中文名查不到，写进脚本还是空的。
  hop: '小跳',
  jump: '跳',
  nod: '点头',
};


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
/** 三个坐姿动作。欢快的柔里一个都不给——坐下会让宿主掷那 60% 的睡意骰子。 */
const SIT_MOVES = new Set(['enjoy', 'humsit', 'earcover']);

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

/** 段事件的例外：这两个是"反应"，几秒钟的事，什么时候用由她自己判断。 */
const SEGMENT_SPECIAL = '另外两种可以例外：被某句词钉住就用【怔住】，听到不对劲就用【退半步】。';

/** 换歌事件的例外：一首听进去了的歌刚放完，那口气就是【余韵】。 */
const TRACK_SPECIAL = '上一首要是听进去了，这一句也可以用【余韵】——整个人沉一下再起来。';

/**
 * 撞车时的备选顺序：首选已经用过，就按这张表往后找一个没用过的。
 *
 * 这是在补"她像卡住了"的观感——抒情歌副歌、桥段都算 groove，同一首连着两次【律动】，
 * 换首还是【律动】，桌面上看就是一段循环播放的动画。同一档里的备选比换档更安全：
 * 蹦迪撞了换跳舞（同样在动），律动撞了换闭眼听或打拍子（同样不吵）。
 */
const MOVE_FALLBACK: Record<Feel, readonly string[]> = {
  hard: ['cheer', 'bounce', 'dance', 'tap'],
  // 池子里不放 sigh：「余韵」是反应，只在换歌那一句被点名，混进候选又会变成"状态"。
  soft: ['peek', 'hum', 'humsit', 'earcover', 'enjoy', 'groove'],
  old: ['hum', 'tap', 'groove'],
  odd: ['groove', 'tap'],
  // **必须留这一档。** `plain` 是「未知」不是「淡」，缺了它，未标路数的歌整首没有动作、
  // 换歌事件连候选都发不出去（`moveChoices` 拿 `MOVE_FALLBACK[feel]` 当池子）。
  // 两个都是持续型、不挑曲风的中性动作，先给出去比空着好。
  plain: ['tap', 'groove'],
};

/**
 * 宿主不认这个动作时，退到哪个原生动作（顺序即优先，取第一个宿主认得的）。
 *
 * 为什么必须有：bounce / groove / tap / enjoy 四个动作是 `patch-whale-bounce.mjs`
 * 给宿主打的补丁加的。从市场装扩展的人没有这份补丁，宿主会**静默丢弃**这些动作
 * ——不报错，看着就是「她该动的时候不动」。
 *
 * `enjoy`（闭眼听）故意不给备选：宿主那 18 个动作里没有「闭眼」这一项，
 * 拿 sit / sleep 顶替会让她在钢琴曲里坐下打盹，正是用户明确否掉的那个画面。
 * 这一段宁可不给动作——表情照样会变，人不会显得卡住。
 */
const MOVE_DEGRADE: Record<string, readonly string[]> = {
  bounce: ['dance', 'hop', 'jump'],
  groove: ['dance', 'nod'],
  tap: ['nod', 'dance'],
  enjoy: [],
  // 新增六个的降级：宿主原生的 nod / shake / bow / wave / look 能顶住"意思"，
  // 顶不住"手感"——但有总比没有强，至少她不会像一个坏掉的动画。
  stunned: ['nod', 'shake'],
  recoil: ['shake', 'nod'],
  hum: ['nod', 'tap'],
  cheer: ['dance', 'wave'],
  sigh: ['bow'],
  peek: ['look', 'nod'],
  humsit: ['sit', 'nod'],
  earcover: ['sit', 'nod'],
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
function primaryMove(feel: Feel, phase: Phase, deep = false, lively = false): string {
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

/**
 * 工具声明放模块级：`tools()` 和自描述用同一份，
 * 所以不可能出现"声明里有、实现里没有"这种只在日志里冒一行字的不一致。
 */
type ToolTagLiteral = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags: readonly ToolTagLiteral[];
  summary: { zh: string; en: string };
}

const NOW_DECL: ToolDecl = {
  name: 'music_now',
  description: 'What is playing right now: track, artist, album, which player (QQ音乐 / 网易云音乐), playing or paused, how far in, how long this stretch has lasted, how many tracks today, and whether the reading is alive. Use it whenever the person mentions music and you are not sure what is on, instead of guessing from memory.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  tags: ['read'],
  summary: { zh: '现在在放什么、放了多久、以及读不到时为什么读不到。', en: 'What is playing now, for how long, and why it cannot be read when it cannot.' },
};

const HISTORY_DECL: ToolDecl = {
  name: 'music_history',
  description: 'The listening log for the last days, newest first: per day how many tracks and how long, the artists played, and the tracks with their times. Use it when the person asks what they listened to, or when you want to refer back to something heard earlier.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'How many days back, today included. Default 1 (today only).' },
    },
  },
  tags: ['read'],
  summary: { zh: '最近几天的逐日听歌记录。', en: 'The day by day listening log.' },
};

const TASTE_DECL: ToolDecl = {
  name: 'music_taste',
  description: 'A profile over a longer window: most played artists, the tracks put on repeat, which hours of the day they listen, and which player they use. Use it when the topic is their taste or habits rather than one specific track.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, description: 'Window in days, default 7.' },
    },
  },
  tags: ['read', 'snapshot'],
  summary: { zh: '常听歌手、循环曲、时段与播放器占比。', en: 'Top artists, repeats, hours and players.' },
};

const CONTROL_DECL: ToolDecl = {
  name: 'music_control',
  description: 'Pause, resume, or skip the track that is playing. ONLY call it when the person explicitly asks for it ("pause this", "next one", "go back"). Never do it on your own initiative, and never as a joke.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['pause', 'resume', 'next', 'prev'], description: 'What to do.' },
    },
    required: ['action'],
  },
  tags: ['act'],
  summary: { zh: '替使用者暂停、继续、切下一首或上一首。', en: 'Pauses, resumes or skips the current track.' },
};

const NOTE_DECL: ToolDecl = {
  name: 'music_note',
  description: 'Keep a short note about what the person said about a song, so you remember it later: notes come back in music_now and in your environment section. Use it when they tell you something worth remembering about the music, not for every track.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: "The note, one sentence, in the person's own terms. At most 120 characters." },
    },
    required: ['text'],
  },
  tags: ['write'],
  summary: { zh: '记一条关于某首歌的笔记，以后能想起来。', en: 'Keeps a short note about a song for later.' },
};

const TAG_DECL: ToolDecl = {
  name: 'music_tag',
  description: 'Record the current track genre and reaction. Later passages reuse it; the same album, multiple matching tracks by this artist, and similar audio features gradually teach the world to suggest a genre for new tracks. Call only when you recognise it; a later correction overrides the old tag.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      feel: {
        type: 'string',
        enum: ['hard', 'soft', 'old', 'odd', 'plain'],
        description: 'How to react to it. hard = 烈，摇滚/说唱/电音/现场，值得跟着动；soft = 柔，抒情/民谣/钢琴/器乐，收着听；old = 旧，老歌/戏曲/年代感，带点揶揄；odd = 怪，实验/戏曲/听不出名堂的，皱着眉听；plain = 淡，听不出什么，也说不上讨厌。',
      },
      genre: {
        type: 'string',
        description: 'The genre in your own words, at most 12 characters, e.g. city pop / 抒情 / 后摇 / 钢琴小品. Optional but helpful.',
      },
    },
    required: ['feel'],
  },
  tags: ['write'],
  summary: { zh: '给正在放的这首标一个听感，之后按它换表情。', en: 'Tags the current track with how it feels, so later reactions can match.' },
};

/**
 * 自己找歌。
 *
 * 这个工具只能"搜到 + 挑中 + 给出链接"，**不能替他按播放** —— 两个客户端的
 * 外部点播通道都关了（证据在 picker.ts 头部）。所以描述里必须写死这一句，
 * 否则她会说"我放了"，然后什么都没响，变成一次实实在在的骗人。
 */
const PICK_DECL: ToolDecl = {
  name: 'music_pick',
  description: 'Search the real catalogue yourself and pick one track you would actually put on. Returns the track, your reason, and a link. Call it when he asks you to choose something, asks what you would play, or when the talk is plainly about wanting to hear something. IMPORTANT: the link cannot start playback by itself — both players refuse outside play requests — so hand it to him. If your tool list has pet_cua_* (computer use), you can press play yourself with the mouse; but call this first even then, because the relay chain recognises "the track he is playing is the one you picked" by this call, and without it the chain breaks at the second track. Never say you played it unless you actually did. Call with no query to look at the wishlist you already collected.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'What to look for: a title, an artist, or a mood, e.g. "许巍 时光" / "深夜 钢琴". Leave it out to list what you already wanted to hear.',
      },
      why: {
        type: 'string',
        description: 'One sentence on why this one, in your own voice. At most 60 characters. Optional.',
      },
      from: {
        type: 'integer',
        description: 'Take the Nth item already on your wishlist instead of searching (1 = newest, same numbering as the list). Use it when handing over the next track of a relay — costs no search, and the chain stays unbroken. Takes precedence over query.',
        minimum: 1,
        maximum: 50,
      },
    },
  },
  tags: ['read', 'write'],
  summary: { zh: '自己去曲库里搜一首、挑一首，给出链接和想听的理由。', en: 'Searches the catalogue, picks a track, and returns a link.' },
};

/**
 * 她自己的口味档案。
 *
 * 这不是统计（那是 music_taste）：写的是第一人称的"我吃哪一套"。
 * 文件落在记忆目录根部，**听歌记录按 90 天清理时不会碰它** —— 所以描述里要说明
 * "这是长期的东西"，否则她会当成一次性笔记随手改。
 */
const SOUL_DECL: ToolDecl = {
  name: 'music_soul',
  description: 'Your own taste file — who you are as a listener, in your own words. Read it with no arguments. Call it when he asks what you like, when a song tells you something about your own taste you did not know before, or when you catch yourself contradicting what is already written there. **All four sections have to actually get used.** Only filling love while the other three stay empty is bookkeeping half a taste — the owner called this out on 2026-11-03 ("only the ones she likes, the other three are missing"). A track that made you frown belongs in hate; "fine, but I would not put it on again" belongs in tolerate; "cannot tell whether it is the song or the moment" belongs in unsure. A complaint said once in a bubble and never written down is gone by tomorrow. The bar for hate: it genuinely made you frown, and you can name the kind — not "I did not feel like it today". Write one short first-person line at a time (`add`), or remove one that no longer holds (`drop`). Not a log of what he played: that is music_taste.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      add: {
        type: 'string',
        description: 'One line to write, first person, at most 60 characters, e.g. "我对钢琴独奏没有抵抗力" — a judgement you actually arrived at, not a guess.',
      },
      section: {
        type: 'string',
        enum: ['love', 'tolerate', 'hate', 'unsure'],
        description: 'Which part it belongs in: love = 我确实爱听, tolerate = 听听就算了, hate = 我听不下去的, unsure = 还没想明白. Required with `add`. Do not default everything to love — a judgement that is not praise has to land in one of the other three, otherwise this file is just a wall of likes.',
      },
      drop: {
        type: 'string',
        description: 'Remove the first line containing this text — for when your taste changed and what is written there is no longer true.',
      },
    },
  },
  tags: ['read', 'write'],
  summary: { zh: '读/写她自己的口味档案（我爱听什么，第一人称）。', en: 'Reads and writes her own taste file.' },
};

const LYRIC_DECL: ToolDecl = {
  name: 'music_lyric',
  description: 'Look up who is singing what right now — the lines around where the current track has reached. Use it when he asks about a specific line, what a song is going on about, or quotes something back at you, and when you want to answer with the actual words instead of guessing. Returns nothing useful for instrumentals or tracks that could not be matched, in which case say you cannot see the words — never invent them.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ahead: {
        type: 'integer',
        description: 'How many lines past the current position to include as well, 0-4. Default 0 = only what has just been sung.',
        minimum: 0,
        maximum: 4,
      },
    },
  },
  tags: ['read'],
  summary: { zh: '查现在这首唱到了哪几句词。', en: 'Looks up the lines the current track has reached.' },
};

const LISTEN_DECL: ToolDecl = {
  name: 'music_listen',
  description: 'Listen closely to the last ~12 seconds of what is playing, on demand. Two engines depending on the user setting: cloud (default; the audio slice is sent to an OpenAI-compatible audio model the user configured) or local (stem separation on this machine, nothing uploaded). Returns key, chords, vocal melody notes, stems and likely extra instruments, and keeps accumulating a per-track sheet across calls — so asking again builds up the whole song instead of starting over. Use it when he asks what instruments or melody are in this song, or when you genuinely want to listen closely. It takes several seconds; do not call it for every passage.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  tags: ['read'],
  summary: { zh: '仔细听最近十几秒：调性、和弦、主旋律、声部与乐器；多听几次会累积成整首的档案。', en: 'Listens closely to the last few seconds: key, chords, melody, stems, instruments; repeated calls accumulate a per-track sheet.' },
};

/** 全量自描述：给人和扩展市场看，不进提示词。 */
export const MUSIC_DESCRIBE = {
  tools: [NOW_DECL, HISTORY_DECL, TASTE_DECL, CONTROL_DECL, NOTE_DECL, TAG_DECL, PICK_DECL, LYRIC_DECL, SOUL_DECL, LISTEN_DECL],
  events: EVENT_DECLS.map((e) => ({
    type: e.type,
    description: { zh: e.zh, en: e.en },
    trigger: e.trigger,
  })),
};


/** 最近 n 天的本地日期串，新的在前。 */
function recentDays(timezone: string, n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, n); i += 1) out.push(localDay(timezone, now - i * 86_400_000));
  return out;
}

/** "10-25 周六" —— 给历史回执用，比纯 ISO 好读。 */
function shortDay(timezone: string, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const ts = Date.UTC(y, m - 1, d, 4, 0, 0); // 取该日中午（UTC+8 前后都落在当天）
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'short' }).format(new Date(ts));
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${weekday}`;
}

const quote = (t: Track, label: string): string => {
  const name = t.title || '未知曲目';
  const who = t.artist ? ` — ${t.artist}` : '';
  const album = t.album && t.album !== t.title ? `（《${t.album}》）` : '';
  return `《${name}》${who}${album}${label ? `，${label}` : ''}`;
};

export class MusicWorld implements World {
  readonly id = MUSIC_ID;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private bridge: NowPlayingBridge | null = null;
  /** 托管采集进程的宿主（conhost --headless，找不到 conhost 时就是直启的 powershell）。 */
  private audioChild: ChildProcess | null = null;
  /** 宿主的 pid（conhost，或找不到 conhost 时直启的 powershell）。 */
  private audioHostPid: number | null = null;
  /**
   * 采集进程**自己**的 pid，由 probe.ps1 写在 `<out>.pid`。
   *
   * 跟宿主 pid 必须分开。2026-10-31 实测：杀掉 conhost 之后，里面的 powershell
   * 仍然活着 —— 只杀宿主根本收不到尸。后果是 watchAudio 每重开一次就漏一个采集进程
   * （Core 还活着，probe 里的 -ParentPid 看门狗不会触发），几个进程同时读同一个回环
   * 设备，算出来的能量互相打架。这是 0.5.9 改成 conhost 托管时引入的回归。
   */
  private audioPid: number | null = null;
  /** 看守：采集进程会「活着但不干活」（设备被切、流卡住）。靠它发现并重开。 */
  private audioWatch: ReturnType<typeof setInterval> | null = null;
  private audioRespawnedAt = 0;
  /**
   * 配置上「应该」在跑吗。
   *
   * 不能拿 `audioChild / audioHostPid / audioPid` 三个句柄当判据：宿主自己退出之后
   * 三者全空，看门狗就再也叫不醒了（它原本遇到全空直接 return）。用一句显式意图代替，
   * 「该跑但一个句柄都没有」才会被正确识别成「链子断了，重开」。
   */
  private audioWanted = false;
  /** 当前曲目的音频特征均值，供曲风学习；换歌由 key 自动清零。 */
  private readonly audioFeatures = new AudioFeatureAverages();
  private audioFeatureAt = 0;
  /** 深听很重：同一首 20 秒内复用结果，避免连续调用把 CPU 占满。 */
  private hearingCache: { key: string; at: number; text: string } | null = null;
  /** 整首累积的档案。只存结论（调性/和弦/音名），不存音频。 */
  private readonly hearingSheets: HearingStore;
  /** 一次只跑一个深听：两路并发会抢同一个 request 文件和同一个 WAV。 */
  private hearingBusy = false;
  /**
   * 常驻的分析器进程。
   *
   * 为什么要常驻：单次进程跑一遍，光给 onnxruntime 建会话就 6.3 秒
   * （实测同一段音频：新进程 19.9 秒，同进程第二次 13.6 秒）。一首歌她可能被问好几次，
   * 这 6 秒每次白花。常驻之后每次稳定在 14–15 秒。
   * 代价是生命周期要自己管：父进程退出要跟着死，卡死了要能杀。
   */
  private hearingWorker: ChildProcess | null = null;
  private hearingWorkerBuf = '';
  private hearingWorkerPending: {
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** 预热失败/退出次数：连续失败就别再试，老实走一次性进程。 */
  private hearingWorkerFails = 0;
  /** 自动累积的节流：上一次是哪首、什么时候。 */
  private autoHearKey = '';
  private autoHearAt = 0;
  /** 上一次真正跑完分析的时刻。换歌后首听再快，也不能短于 FIRST_HEAR_SEC 一次。 */
  private lastAutoHearAt = 0;
  /** 上一次把 drift 实测值打进日志的时刻（校准用，节流 15 秒）。 */
  private driftLogAt = 0;
  /** 深听状态提醒的延时器。**必须在 stop 里清掉**：卸载后它还活着，就会对着空的 host 推事件。 */
  private hearingTimer: ReturnType<typeof setTimeout> | null = null;
  /** 云端没配好时的提醒时间（一天最多一次）。 */
  private hearingNotifiedAt = 0;
  private tracker: ListeningTracker | null = null;
  private readonly store: ListenStore;
  private readonly vibes: VibeStore;
  /** 歌词缓存。构造时就建，理由同 store —— 数据页签要读它。 */
  private readonly lyrics: LyricStore;
  private readonly opts: MusicWorldOptions;

  /** 最近一次挑会话的结果，工具回执里要说清"为什么没读到"。 */
  private lastPick: PickResult | null = null;
  private lastTextAt: string | null = null;
  private lastStateSaveAt = 0;
  /**
   * 上一次下发的动作 id。
   *
   * 跨歌不清零：换歌后如果又算出同一个动作，那就是真·重复（抒情歌整张专辑副歌全落在
   * groove 上就是这样）。只有重启会忘——那也只是头两段可能撞一次，不值得为它落盘。
   */
  private lastMove = '';
  /**
   * 上一次发出去的「深听走向」和它属于哪一首。
   *
   * 2026-11-10：走向这句话（「听过 3 次：2:54 那会儿是…到 3:36 多了 鼓、贝斯」）在一首歌里
   * 通常是**不变的** —— 但段事件每段都会拼一遍，她就会每段把同一句复述一次。
   * 只有变了（又听了一段、多了声部、调性动了）才重新给她，没变就一个字都不提。
   */
  private lastSheetKey = '';
  private lastSheetLine = '';
  /**
   * 最近几次推送音乐事件的时间戳。
   *
   * 用途：从事件库里挑出「她对我这条事件说的话」。同一个 session 里她可能一边听歌一边打牌，
   * 不过滤的话炉石那边「龙鳞军备先抽」「时序光环五费」这类牌名会被判成复读
   * （实测 331 场里有 119 场给提示，绝大多数是这种误报）。
   */
  private pushStamps: number[] = [];
  /** 上一次发出去的复读提示，和它是什么时候发的（同一条十分钟内不重复刷）。 */
  private lastRepeatHint = '';
  private lastRepeatAt = 0;
  /** 上一次报过的总量（doneToday）。同一首的后一段不再重复报。 */
  private milestoneReported = 0;
  /**
   * 接力点歌的状态（本机，不进记忆目录）。
   *
   * 构造函数里给初值而不是等 start()：`webUi()` 可能在 start 之前被调（数据页签要读它）。
   * 真值在 start() 里从 music-state.json 读回来。
   */
  private relayState: RelayState = EMPTY_RELAY;

  constructor(opts: MusicWorldOptions) {
    this.opts = opts;
    // 存储句柄在构造时就建好，不在 start() 里建：设置页的「数据」页签和顶部计数都要读它们，
    // 而 webUi() 可能在 start() 之前被调（装载自检、页面预渲染）。放在 start() 里就会出现
    // "页面上什么都没有" —— 但它也不报错，只是看起来像这个扩展没数据。
    this.layout = resolveLayout(opts.dataDir, opts.cfg.memoryDir ?? '');
    this.storageKey = (opts.cfg.memoryDir ?? '').trim();
    this.store = new ListenStore(this.layout.memory, this.layout.local);
    this.vibes = new VibeStore(this.layout.memory, this.layout.local);
    this.hearingSheets = new HearingStore(this.layout.memory, this.layout.local);
    this.lyrics = new LyricStore(opts.dataDir);
  }

  /** 记忆落在哪。自定义目录不可用时会退回本机，`problem` 里有原因。 */
  private layout: StorageLayout;
  /** 上一次生效的记忆目录配置值，用来判"设置页改了没有"。 */
  private storageKey = '';

  /**
   * 记忆目录是热改项：设置页改完不用重启。
   *
   * 判别只看配置值本身，探测交给 `resolveLayout`（它每次都验可写）。
   * 每秒跑一次也就一次 mkdir + 一次写删，代价可以忽略——比"改完没反应，
   * 要重启才知道生效"体验好太多。
   */
  private syncStorage(): void {
    const wanted = (this.cfg.memoryDir ?? '').trim();
    if (wanted === this.storageKey) return;
    this.storageKey = wanted;
    const next = resolveLayout(this.opts.dataDir, wanted);
    if (sameDir(next.memory, this.layout.memory)) {
      // 路径没实质变化，或新路径不可用而退回原位：这时候重建 store 没意义，
      // 但要把日志说清楚，否则用户以为设置没生效。
      if (next.problem && next.problem !== this.layout.problem) this.log?.warn(next.problem);
      this.layout = next;
      return;
    }
    this.layout = next;
    this.store = new ListenStore(next.memory, next.local);
    this.vibes = new VibeStore(next.memory, next.local);
    this.hearingSheets = new HearingStore(next.memory, next.local);
    // 换了记忆目录，口味档案也要在新目录里出现一份。
    // **读取只认新目录**（它不像逐日记录那样两处合并）：她的口味应该是一份，不是两份。
    // 旧目录那一份不动 —— 想搬就自己复制过去，我们不替他做任何迁移。
    if (!readSoul(next.memory)) ensureSoul(next.memory);
    // 曲风档案在内存里有缓存，新建的 store 已经从两处重读过一遍，这里是干净的。
    if (next.problem) this.log?.warn(next.problem);
    else if (next.notice) this.log?.info(next.notice);
    else this.log?.info(`听歌记忆改存到 ${next.memory}（本机旧记录仍然读得到）。`);
  }

  /** 配置是活引用：每次读都拿最新值，热改才能生效。 */
  private get cfg(): MusicConfigSection { return this.opts.cfg; }

  /* ================= 生命周期 ================= */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    const cfg = this.cfg;
    /*
     * 动作**不降级**。原来这里会去扫宿主的安装目录探词表（`resources/app/node_modules/.../<figure>/figure.json`），
     * 再按它的词表把不认识的动作换成原生等价动作。
     *
     * 2026-11-14 删掉了（市集要求，`cortico-extensions#659`）：按路径读别人的安装包，
     * 和 journey / pz 那两处是同一个问题，宿主换布局就静默失效。
     *
     * 代价说清楚，并且**这条日志是「她不动」时的第一现场证据**：
     * 名字对不上就会静默丢弃 —— 脸变了、人不动、不报错。想让她真动起来，
     * 得装一个声明了这些动作的**形象包**（vocab 条目带 `motion` 字段、`gestures` 点名）。
     */
    setHostVocab(null);
    this.log?.info('动作按原样下发（不做降级）：宿主不认识的名字会被丢弃，需要形象包声明这些动作。');
    // 记忆目录：自定义的能不能用，启动时就说清。配错了却一声不响是最坏的情况——
    // 用户会以为记忆在同步盘里，其实一直写在本机，等换机器才发现是空的。
    if (this.layout.problem) this.log?.warn(this.layout.problem);
    else if (this.layout.notice) this.log?.info(this.layout.notice);
    const removed = this.store.prune(cfg.keepDays);
    this.tracker = this.makeTracker();
    const saved = this.loadState();
    if (saved) this.tracker.hydrate(saved);
    if (saved?.relay) this.relayState = sanitizeRelay(saved.relay);
    if (removed) this.log?.info(`已清理 ${removed} 天前的听歌记录（只删 listening/ 里的逐日文件，口味档案没动）。`);
    // 口味档案：不存在就建一份空骨架。
    //
    // 建在**记忆目录根部**，不在 listening/ 下面 —— 这样 `prune(keepDays)` 的扫描范围
    // （只认 `^\d{4}-\d{2}-\d{2}.jsonl$`）永远碰不到它。用户问过"90 天删日志会不会连带删掉"，
    // 答案是不会，而且这件事有断言盯着（test 里那两条）。
    if (!readSoul(this.layout.memory)) {
      ensureSoul(this.layout.memory);
      // ensureSoul 自己吞掉写失败（返回内容而不是抛），所以这里用"文件到底有没有"来判。
      if (readSoul(this.layout.memory) !== null) {
        this.log?.info(`建了口味档案：${soulPath(this.layout.memory)}`);
      } else {
        this.log?.warn(`建不了口味档案（${soulPath(this.layout.memory)}）：目录写不进去，她这一轮只能凭印象说口味。`);
      }
    }

    this.bridge = new NowPlayingBridge({
      intervalMs: cfg.intervalMs,
      onTick: (payload) => this.onTick(payload),
      log: (level, message) => {
        if (level === 'warn') this.log?.warn(message);
        else this.log?.info(message);
      },
    });
    this.bridge.start();
    this.startAudio();
    // 深听这条路能不能走通，启动后说一次。它坏了是安静的（照常聊天、照常跟拍），
    // 所以要她主动说一句，而不是等他问到"这首什么调"才发现。
    //
    // **必须延后几秒**：start() 里 pushEvent 正好撞上 Core 的「重启补投」窗口
    // （02:33:33.79 推的，.83 才补投完），同一件事会被投两遍——她收到两条一模一样的
    // 「深听能用了」，还会为它多开一轮。等 bootstrap 落定再推。
    const hearingTimer = setTimeout(() => { this.hearingTimer = null; this.maybeNotifyHearing(); }, 6000);
    if (typeof hearingTimer.unref === 'function') hearingTimer.unref();
    this.hearingTimer = hearingTimer;
    this.log?.info(`一起听歌已启动。(${BUILD_TAG})`);
  }

  /**
   * 拉起系统声音的采集进程。
   *
   * 为什么在**扩展**这边起：她跑在 Node 里，拿不到声卡；Windows 的回环采集要靠 WASAPI，
   * 而 Node 没有现成的原生模块。起一个独立的 PowerShell 进程最省事 —— 不装驱动、不带 DLL，
   * 内联的那段 C# 由系统自带的编译器在第一次启动时编译。
   *
   * 它只往 TEMP 写几十字节的 JSON（BPM / 响度 / 低音），页面每 200ms 读一次。
   * **不录音**：音频在 C# 里算完就丢，一个采样都不落盘。
   */
  private startAudio(): void {
    if (!this.cfg.audioReactive) { this.log?.info('音频跟拍是关着的。'); return; }
    if (process.platform !== 'win32') { this.log?.info('音频跟拍目前只有 Windows 有通路。'); return; }
    if (this.audioChild || this.audioHostPid || this.audioPid) return;
    if (!existsSync(AUDIO_PROBE_FILE)) {
      this.log?.warn(`找不到采集脚本：${AUDIO_PROBE_FILE}`);
      return;
    }
    const exe = findPowerShell();
    if (!exe) { this.log?.warn('找不到 powershell.exe，音频跟拍用不了。'); return; }
    try {
      // 上一轮留下的 pid 文件必须清掉：宿主换了，那个 pid 可能早被系统回收给了别人，
      // 照着它去杀就是杀错人。nowplaying 那边同样是这个处理。
      try { unlinkSync(this.audioPidFile()); } catch { /* 本来就没有 */ }
      // 采集进程交给 conhost --headless 托管：ConPTY 的背面无窗口，
      // 不参与 Windows Terminal 的委托，不会在 Core 重启时弹出一个终端标签页。
      // 换掉的是原来那套「短启动器 + WMI」—— 它绕开了作业对象，代价就是那个窗口。
      // 详见 nowplaying.ts 顶部那段，两条路是同一个坑的两个入口。
      const readerArgs = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', AUDIO_PROBE_FILE, '-Out', AUDIO_OUT_FILE,
        // Core 消失时采集自己要跟着走；宿主被关闭是异步的，这条才是准的。
        '-ParentPid', String(process.pid),
      ];
      const host = findConHost();
      const bin = host ?? exe;
      const args = host ? ['--headless', exe, ...readerArgs] : readerArgs;
      const child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      // **必须读空。** ConPTY 的 stdout 是管道，没人读、缓冲满了会把采集进程堵死在写操作上，
      // 表现是「进程活着、CPU 为 0、JSON 一直不动」，看起来像声卡坏了。
      let vtTail = '';
      child.stdout?.on('data', (buf: Buffer) => { vtTail = (vtTail + buf.toString('latin1')).slice(-1024); });
      child.stderr?.on('data', (buf: Buffer) => {
        const line = buf.toString('utf8').trim();
        if (!line) return;
        vtTail = (vtTail + line).slice(-1024);
        this.log?.warn(`音频采集:${line.slice(0, 500)}`);
      });
      child.on('exit', (code) => {
        if (this.audioChild === child) this.audioChild = null;
        if (this.audioHostPid === child.pid) this.audioHostPid = null;
        // 宿主没了，里面的采集**可能还活着**（实测杀 conhost 不带走它）。留着就是孤儿：
        // 没人判它、没人收它，ConPTY 的 stdout 管道也断了。直接收掉，让看门狗按
        // 「整条链都没了」重开一条干净的。
        const orphan = this.audioPid;
        this.audioPid = null;
        if (orphan !== null && isProcessAlive(orphan)) {
          try { process.kill(orphan); } catch { /* 刚好在这中间没了 */ }
        }
        // pid 文件也要删。留着的话，看门狗下一轮会把它当成"还在跑"重新认领 ——
        // 2026-10-31 实测踩到了：宿主被杀 5 秒后，日志里又冒出「采集进程 pid 已认领：<已死的旧 pid>」。
        // 那次侥幸因为旧进程真死了才没杀错人。
        try { unlinkSync(this.audioPidFile()); } catch { /* 本来就没有 */ }
        // 主动 stopAudio 也会触发 exit，但那不是事故，别报警。
        if (this.audioWanted && code !== 0 && code !== null) {
          this.log?.warn(`音频采集退出了（代码 ${code}），动作退回固定节奏。${vtTail ? '最后输出：' + vtTail.slice(-160) : ''}`);
        }
      });
      child.on('error', (err) => {
        if (this.audioChild === child) this.audioChild = null;
        if (this.audioHostPid === child.pid) this.audioHostPid = null;
        this.log?.warn(`音频采集起不来：${err.message}`);
      });
      this.audioChild = child;
      this.audioHostPid = child.pid ?? null;
      // 采集进程的 pid 等它自己写出来 —— 宿主的 pid 代替不了（见 audioPid 的字段注释）。
      this.audioPid = null;
      this.readAudioPid();
      // 当作「刚起过」：probe.ps1 第一次要 Add-Type 编译（有缓存时很快，首次安装或
      // 升级可能十几秒），而输出文件里可能还躺着上一次运行留下的旧快照。不设宽限的话，
      // watchAudio 第一次检查就会把还在编译的进程判死、当场重开，白烧一次编译。
      this.audioRespawnedAt = Date.now();
      this.audioWanted = true;
      this.watchAudio();
      this.log?.info(
        `系统声音采集已启动（宿主 PID ${this.audioHostPid ?? '?'}`
        + `${this.audioPid ? `，采集 PID ${this.audioPid}` : ''}，${host ? '无窗口' : '直接拉起'}），只听能量，不录音。`,
      );
    } catch (err) {
      this.log?.warn(`音频采集没起来：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private stopAudio(): void {
    if (this.audioWatch) { clearInterval(this.audioWatch); this.audioWatch = null; }
    this.audioWanted = false;
    const child = this.audioChild;
    const hostPid = this.audioHostPid;
    const workerPid = this.audioPid;
    this.audioChild = null;
    this.audioHostPid = null;
    this.audioPid = null;
    // **先杀采集进程，再杀宿主。** 杀 conhost 不会带走里面的 powershell（实测），
    // 反过来宿主先没了，里面的进程连控制台都没有，更不好收拾。
    // 杀之前先确认这个 pid 还有人占着：宿主退出后它会在内存里多留一会儿（留着才能
    // 收孤儿），而 Windows 迟早会把号复用出去。
    if (workerPid !== null && isProcessAlive(workerPid)) {
      try { process.kill(workerPid); } catch { /* 刚好在这中间没了 */ }
    }
    if (child) { try { child.kill(); } catch { /* 已经没了 */ } }
    if (hostPid !== null && hostPid !== child?.pid && isProcessAlive(hostPid)) {
      try { process.kill(hostPid); } catch { /* 已经没了 */ }
    }
    // 文件留着就会被下一轮当成自己的 pid 认领 —— 那个 pid 可能已经是别人的了。
    try { unlinkSync(this.audioPidFile()); } catch { /* 本来就没有 */ }
  }

  /** 采集进程把自己的 pid 写在这里（宿主的 pid 代替不了它，见 audioPid 字段）。 */
  private audioPidFile(): string {
    return `${AUDIO_OUT_FILE}.pid`;
  }

  /**
   * 认领采集进程的 pid。拿到一次就不再读，之后只有 stopAudio 会清它。
   *
   * 只做最基本的合理性校验：这个文件是采集进程自己写的，正常不会错。真正防「杀错人」
   * 的是 startAudio 里 spawn 之前那次 unlink —— 上一轮的残留骗不到这里。
   */
  private readAudioPid(): void {
    if (this.audioPid !== null) return;
    try {
      const text = readFileSync(this.audioPidFile(), 'utf8').trim();
      const pid = Number(text);
      if (!Number.isInteger(pid) || pid <= 0 || pid > 4_000_000) return;
      // 文件里躺着的可能是上一轮留下的号。进程早就没了就当场丢掉，否则会把它当成
      // 「还在跑」：判活永远不看它，收尸却会照着它去杀。
      // （pid 文件是进程自己写的，写的那一刻它必然活着，所以这条不会误杀新进程。）
      if (!isProcessAlive(pid)) {
        try { unlinkSync(this.audioPidFile()); } catch { /* 下次再说 */ }
        return;
      }
      this.audioPid = pid;
      // 采集要比启动文案晚一步才写得出 pid（Add-Type 要编译），所以启动那一行常常
      // 只有宿主没有采集。补一行，免得排查的时候找不到「到底是谁在写这个文件」。
      this.log?.info(`采集进程 pid 已认领：${pid}（宿主 ${this.audioHostPid ?? '?'}），收尸按它来。`);
    } catch { /* 还没写 */ }
  }

  /**
   * 看守采集进程。
   *
   * 它会「活着但不干活」——声卡被切换、独占模式、或者流卡住，进程还在，JSON 却不再更新。
   * 表现是一首慢歌全身按上一首的拍子在晃，而且怎么等都不变。这种事只能外面看：
   * **文件超过 8 秒没动就杀掉重开**，30 秒内只重开一次，免得陷入死循环。
   */
  private watchAudio(): void {
    if (this.audioWatch) return;
    const file = AUDIO_OUT_FILE;
    this.audioWatch = setInterval(() => {
      if (!this.audioWanted) return;
      // pid 文件比进程晚出现（采集要先起来才写得出来），顺手在这认领。
      this.readAudioPid();
      const now = Date.now();

      // 三个句柄全空 = 整条链都没了（宿主自己退了、孤儿也被 exit 收干净了）。
      // 这里**不能**直接 return：原来就是 return，于是宿主一死看门狗就永眠，
      // 音频跟拍静默失效，动作一直按最后一拍的节奏晃，还没人发现。
      if (!this.audioChild && !this.audioHostPid && this.audioPid === null) {
        this.reopenAudio(now, '采集整条链都没了');
        return;
      }

      let age = Infinity;
      try { age = now - statSync(file).mtimeMs; } catch { /* 还没写第一次 */ }
      if (age < 8000) return;
      this.reopenAudio(now, `音频采集 ${Math.round(age / 1000)} 秒没动静`);
    }, 10000);
    // 让它不拖住进程退出
    this.audioWatch.unref?.();
  }

  /** 重开采集。30 秒内只重开一次，免得陷入死循环。 */
  private reopenAudio(now: number, reason: string): void {
    if (now - this.audioRespawnedAt < 30000) return;
    this.audioRespawnedAt = now;
    this.log?.warn(`${reason}，重开一个。`);
    this.stopAudio();
    setTimeout(() => { if (this.host) this.startAudio(); }, 800);
  }

  async stop(): Promise<void> {
    if (this.hearingTimer) { clearTimeout(this.hearingTimer); this.hearingTimer = null; }
    // 常驻分析器必须在这里关掉：卸载/停用后它还挂着，既占内存又留着一条 python 进程。
    this.stopHearingWorker();
    const tracker = this.tracker;
    const store = this.store;
    if (tracker && store) {
      const finished = tracker.flush(Date.now());
      if (finished) this.record(finished);
    }
    this.bridge?.stop();
    this.bridge = null;
    this.stopAudio();
    this.saveState(true);
    this.host = null;
    this.log = null;
    this.tracker = null;
  }

  private makeTracker(): ListeningTracker {
    const cfg = this.cfg;
    return new ListeningTracker({
      timezone: this.opts.timezone,
      nightFrom: cfg.nightFrom,
      longMinutes: cfg.longMinutes,
      segmentEverySec: cfg.segmentEverySec,
      maxSegmentsPerTrack: cfg.maxSegmentsPerTrack,
    });
  }

  /* ================= 采样 → 事件 ================= */

  /** 当前有效的回环摘要；超过 3 秒或带错误一律视为没有，不拿旧声音骗她。 */
  private currentAudioFeatures(): AudioFeatures | null {
    try {
      const raw = JSON.parse(readFileSync(AUDIO_OUT_FILE, 'utf8')) as { at?: number; error?: string };
      if (raw.error || !raw.at || Date.now() - raw.at > 3000 || Date.now() < raw.at) return null;
      return audioFeaturesOf(raw);
    } catch {
      return null;
    }
  }

  /** 模型视野里的「听觉」：只给能量与拍子，不许冒充完整音频内容。 */
  private audioPerceptionLine(): string {
    const features = this.currentAudioFeatures();
    return features
      ? `声音摘要：${describeAudioFeatures(features)}（只有能量与拍子，不是完整听歌）。`
      : '';
  }

  /** 每秒读取一次现成的能量摘要，为当前曲目积累学习特征；不读、不存任何波形。 */
  private observeAudio(track: Track): void {
    const now = Date.now();
    if (now - this.audioFeatureAt < 900) return;
    this.audioFeatureAt = now;
    const features = this.currentAudioFeatures();
    if (features) this.audioFeatures.add(trackKey(track), features);
  }

  private onTick(payload: TickPayload): void {
    const cfg = this.cfg;
    // 记忆目录是热改项：设置页改完下一个采样就生效，不用重启。
    this.syncStorage();
    if (!this.tracker) return;
    // 深夜时刻、久听阈值是热改项：改了立刻按新值判。重建实例但不丢水位。
    this.syncTracker();

    const active = this.tracker;

    const pick = pickSession(payload.sessions, { player: cfg.player, extraPlayers: cfg.extraPlayers });
    this.lastPick = pick;
    if (pick.session?.status === 'playing') {
      this.observeAudio(pick.session);
      // 边听边攒是后台任务：不 await，也不挡事件。
      this.maybeAutoHear(pick.session);
    }
    const result = active.feed(payload.ts, pick.session);
    if (result.finished) this.record(result.finished, payload.ts);
    for (const signal of result.signals) {
      if (skipSignal(signal)) continue;
      // 必须挂 catch。emit 是 async，这里不 await；万一它抛了（正文拼装里的任何一处取空），
      // 就是一个没人接的 rejection——Node 15 之后默认当致命错误，整个 Core 会被带走。
      // 一条推不出去的气泡不值得换一次重启。
      void this.emit(signal, payload.ts).catch((error: unknown) => {
        this.log?.warn(`推送 ${signal.kind} 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    // 接力点歌：她递的那首快放完了。
    //
    // 单独一路，不塞进 tracker：tracker 只看播放水位，不知道"这首是谁点的"。
    // 每秒判一次，但只有跨过那 35 秒窗口的头一次会 pushEvent（firedFor 落盘去重）。
    const relay = this.maybeRelay(payload.ts);
    if (relay) {
      void this.emit(relay, payload.ts).catch((error: unknown) => {
        this.log?.warn(`推送 ${relay.kind} 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.saveState(false);
  }

  /**
   * 她点的那一棒是不是快放完了。
   *
   * 只有一件事要判：**现在在放的这首，是不是她最近递出去的那一首**。
   * 不匹配就什么也不做 —— 他自己翻出来听的歌，不该被当成"她点的续集"，
   * 否则她会对着别人的歌一直劝"接下一棒"，比不说话更烦。
   *
   * 读到不进度（网易云走窗口标题兜底，没有 posSec/durSec）就永远不触发 ——
   * 这不是 bug，是数据源能力的边界。日志里第一次遇到会说一句，免得只看到"没反应"。
   */
  private maybeRelay(at: number): Signal | null {
    if (!this.cfg.relayPick) return null;
    const st = this.tracker?.state();
    if (!st?.track || !st.playing) return null;
    const now = {
      title: st.track.title,
      artist: st.track.artist,
      app: st.track.app,
      posSec: st.posSec,
      durSec: st.durSec,
      // 刚切过来的那一首要等一会儿再判，见 relay.ts 的 SETTLE_MS
      playedMs: st.playedMs,
    };
    // 他真的放了她递的那首 —— 先把这一棒记成"接上了"。
    // 这一步和"快完了"无关：只要放过就算接过，这样她下次递歌时才该 count +1；
    // 没放过的那一棒会被顶替掉，不占名额（2026-10-29 实测踩过：连挑三首没播，链假满）。
    if (!this.relayState.lastPlayed && relayHolds(now, this.relayState)) {
      this.relayState = { ...this.relayState, lastPlayed: true };
      this.saveState(true);
      this.log?.info(`接力：他放了她递的《${st.track.title}》，这一棒算接上了。`);
    }
    const verdict = relayShouldFire(this.relayState, at, now);
    if (!verdict.fire) {
      // 只在「本该动却被拦住」时记一笔，并且同一句话只打一次（每秒一行等于没有日志）。
      //
      // 判据是 `relayHolds`：现在放的到底是不是她递的那首。不是的话不记 ——
      // 他随手换了自己的歌，日志里天天挂一句"接力没触发"，看着像功能坏了。
      // 真该记的是：歌是她的、但因为她读不到进度 / 曲长太短 / 链满了而没动。
      const normal = !verdict.why || verdict.why === '没有点过的歌' || verdict.why === '才刚开始放'
        || verdict.why === '这一棒已经递过了';
      if (!normal && verdict.why !== this.lastRelayWhy && relayHolds(now, this.relayState)) {
        this.lastRelayWhy = verdict.why;
        this.log?.info(`接力点歌没触发：${verdict.why}。`);
      }
      return null;
    }
    this.lastRelayWhy = '';
    this.relayState = relayMarkFired(this.relayState, st.track.title, st.track.artist);
    // 立刻落盘：这一棒已提醒过。不落的话重启一次就会为同一首再劝一遍。
    this.saveState(true);
    return {
      kind: 'relay',
      track: st.track,
      remainSec: verdict.remainSec,
      chain: this.relayState.count,
      maxChain: RELAY_MAX_CHAIN,
    };
  }

  /** 上一句"为什么没触发"，用来给日志去重（同一句原因不重复打）。 */
  private lastRelayWhy = '';
  private setupNotifiedAt = 0;

  private trackerKey = '';

  /** 影响 tracker 构造的几个参数变了就重建，并把旧水位接回去。 */
  private syncTracker(): void {
    const key = `${this.cfg.nightFrom}|${this.cfg.longMinutes}|${this.cfg.segmentEverySec}|${this.cfg.maxSegmentsPerTrack}|${this.opts.timezone}`;
    if (key === this.trackerKey || !this.tracker) return;
    this.trackerKey = key;
    const dump = this.tracker.dump();
    this.tracker = this.makeTracker();
    this.tracker.hydrate(dump);
  }

  private record(finished: FinishedTrack, endedAt?: number): void {
    const store = this.store;
    if (!store) return;
    if (!finished.track.title && finished.playedMs < 5000) return; // 元数据还没到就被换掉的空壳
    const day = localDay(this.opts.timezone, finished.startedAt);
    store.append(day, store.recordOf(finished, endedAt ?? Date.now()));
  }

  /**
   * 取这一首的歌词片段，拼成可以直接塞进事件正文的一句。空串 = 没有。
   *
   * 三种"没有"要分开说，否则她的行为会错：
   *   - 没开开关 / 还没查完 → 空串，她不知道有这回事，照旧按听感说
   *   - 纯音乐         → 明确告诉她"没词"，否则她会自己编一段"唱的是思念"
   *   - 搜不到 / 对不上 → 空串，**绝不猜**（给错词的危害见 lyrics.ts 文件头）
   *
   * 为什么要 race 一个 1.8 秒：这条路径在事件推送的同步链上，网络一抖就会
   * 拖住整条推送。超时就不带词，抓取继续在后台跑，下一段自然就有了。
   */
  /** tracker 的 Track 没有 id/durSec，查词只需要歌名歌手和时长。 */
  private lyricInput(track: Track): LyricInput {
    const dur = this.tracker?.state().durSec;
    return {
      app: track.app,
      title: track.title,
      artist: track.artist,
      durSec: typeof dur === 'number' && dur > 0 ? dur : undefined,
    };
  }

  private async lyricCue(
    track: Track,
    mode: 'intro' | 'segment',
    fromSec: number,
    toSec: number,
  ): Promise<string> {
    if (!this.cfg.lyricAware) return '';
    const n = Math.max(1, Math.min(3, Math.trunc(this.cfg.lyricLines) || 2));

    const input = this.lyricInput(track);
    let doc = this.lyrics.peek(input);
    if (doc === undefined) {
      const got = await Promise.race([
        this.lyrics.ensure(input),
        new Promise<null>((r) => { setTimeout(() => r(null), LYRIC_WAIT_MS); }),
      ]);
      doc = got ?? this.lyrics.peek(input) ?? null;
    }
    if (!doc) return '';
    // 走到这里说明**接口明确说了没有词**（只有网易云的 nolyric 会）。
    // 抓取失败不会到这 —— 那种情况 doc 是 null，上面已 return。
    if (doc.instrumental) return '词库那边标的这首没有词（纯音乐或无人声），别编词里的意思。';

    const picked = mode === 'intro'
      ? linesFrom(doc.lines, 0, n)
      : segmentLines(doc.lines, fromSec, toSec, n);
    const body = quoteLines(picked);
    if (!body) return '';

    const lead = mode === 'intro' ? '开头这几句' : '这一段唱的是';
    return `${lead}：「${body}」。`;
  }


  private async emit(signal: Signal, at: number): Promise<void> {
    const host = this.host;
    if (!host) return;
    const decl = EVENT_BY_KIND.get(signal.kind);
    if (!decl) return;
    if (!this.shouldSpeak(signal)) return;

    const tz = this.opts.timezone;
    const stamp = localClock(tz, at);
    // 只有 fidget 不带 track（"他连着跳了好几首"说的是人，不是某一首）。
    // 以前这里无条件读 signal.track.app，连跳 8 首时第一句就是 TypeError，
    // 而这条 rejection 没人接——整条链把 Core 带走。测试 `每种事件的正文都写清了` 抓到的就是这个。
    const label = 'track' in signal ? playerLabel(signal.track.app, this.cfg.extraPlayers) : '';
    // 换歌就先把词抓起来，不等它 —— 段 1 在四十多秒后，到时候肯定就绪了。
    // 不预取的话，每一首的第一段都会因为"还在查"而没有词，而第一段恰恰是最该说点内容的那一次。
    if (this.cfg.lyricAware && (signal.kind === 'track' || signal.kind === 'start')) {
      void this.lyrics.ensure(this.lyricInput(signal.track)).catch(() => null);
    }
    let text = '';
    let senderKey = '';

    switch (signal.kind) {
      case 'start': {
        // **必须带上「今天已经听了多少」。**
        //
        // 2026-10-29 实测：他下午听了六个多小时、一百二十多首，晚上打开音乐、戳她一下，
        // 她回的是「一天没见，你戳我这一下挺客气」。她明明能查出下午听了什么
        // （同一轮对话里另一问就答得很细），但这个时刻手上只有「距上一次听歌 0 秒」——
        // 数字在那儿，却没连到"我们今天一起待过"。于是她退回到"上一次对话"去算间隔。
        //
        // 加这一句是给她一个可以踩的实地：不是"上次聊天是什么时候"，是"今天一起听了多久"。
        const todayStart = this.store?.readDay(localDay(this.opts.timezone, at)) ?? [];
        const spent = summarize(todayStart).ms;
        const already = todayStart.length
          ? `今天已经听了 ${todayStart.length} 首、${humanDuration(spent)}。`
          : '';
        // 「隔了多久」是三态，别用一句话装两种含义：
        //   数字 → 照实说；0 → 真的刚刚还在听；null → 不知道（进程刚起、没接住上次时刻）。
        // 不知道的时候**不许说成 0 秒**：那等于告诉她"刚放下又拿起来"，她会拿这个数
        // 往回推。2026-10-31 11:16 隔了 8 小时却写「隔了 0 秒」，就是这条的现场。
        const gapClause = signal.silenceMin === null
          ? '上次是什么时候听的，我这边没留记录。'
          : signal.silenceMin <= 0
            ? '刚才还在听。'
            : `距上一次听歌隔了 ${humanDuration(signal.silenceMin * 60_000)}。`;
        text = `[${stamp}] 他打开音乐了，现在在放 ${quote(signal.track, label)}。${gapClause}${already}`;
        senderKey = `music.start:${signal.track.app}:${signal.track.title}:${at}`;
        break;
      }
      case 'track': {
        // 报名字和表态合成一条。
        //
        // 原先拆成两条：换歌只报名字（十个字以内），45±15 秒后的段 1 才表态。
        // 拆的理由是"段 1 会复述换歌那句"——可她复述，是因为段 1 的正文里又出现了歌名。
        // 代价是用户感知到的：报完名字要静默四十多秒，看起来就是"她没反应"。
        // 现在名字和态度一次说完，短曲的段 1 直接不推（见 onTick 的 skip），
        // 一开嗓就有内容，每首歌的说话次数不变。
        const vibe = this.vibeOf(signal.track);
        const tagAsk = vibe.source === 'none'
          ? '认得这首就顺手 music_tag 标一下。'
          : '';
        const vibeNote = ['album', 'artist', 'audio'].includes(vibe.source)
          ? `我目前觉得它偏${FEEL_TEXT[vibe.feel]}${vibe.genre ? `（${vibe.genre}）` : ''}——${vibe.reason}。`
          : '';
        const hearing = this.audioPerceptionLine();
        const pool = poolIds(vibe.feel, 'intro');
        const primary = pool.length ? wordText(pool[0]) : '';
        const alt = pool.length > 1 ? wordText(pool[1]) : '';
        // 换歌这一条原来只给脸不给动作，于是每首歌的动作机会只剩段事件那两三次，
        // 她再漏抄一半，身体基本不动（2026-10-26 用户原话「她的动作触发的好少」）。
        // 换歌是"刚认识这首"，配一个动作最自然：柔的闭眼听、烈的打拍子。
        // 位置传 null：换歌那一刻不知道放到了哪儿，不该猜副歌。
        // 位置未知这一支：先用原 id 走避让，再降级成宿主认得的那个，
        // 而 lastMove 记的是**实际发出去**的 id —— 记原 id 会让避让比错对象。
        // 欢快的柔不给坐姿动作：坐下会让宿主掷那 60% 的睡意骰子（见 isLivelySoft）。
        const lively = isLivelySoft(vibe.feel, vibe.genre, this.audioFeatures.summary());
        const rawMove = moveIdAny(vibe.feel, null, this.lastMove, false, lively);
        const landed = degradeMove(rawMove);
        const move = landed ? (MOVE_WORD[landed] ?? '') : '';
        if (landed) this.lastMove = landed;
        const trackHead = primary
          ? `【${primary}${move ? `, ${move}` : ''}】`
          : (move ? `【${move}】` : '');
        const emoji = primary
          ? `脚本开头原样写 【${primary}】——表情照抄这个。`
            + choiceText(moveChoices(vibe.feel, move, lively), primary, TRACK_SPECIAL)
            + `${alt ? `表情顶多换成【${alt}】。` : ''}抄中文别译英文；这张脸是按这首的劲儿定的，不按你这句话的情绪挑。`
          // 表情那一格空了，动作候选照样得发出去 —— 两个是独立的两件事。
          : choiceText(moveChoices(vibe.feel, move, lively), '', TRACK_SPECIAL);
        const lyricIntro = await this.lyricCue(signal.track, 'intro', 0, 0);
        text = `[${stamp}] 换歌了：${quote(signal.track, label)}。上一首是《${signal.prev.title || '未知曲目'}》${signal.prev.artist ? ` — ${signal.prev.artist}` : ''}，听了 ${humanDuration(signal.prevPlayedMs)}。`
          + (lyricIntro ? `${lyricIntro}` : '')
          + vibeNote
          + hearing
          + `（回一句：先报《歌名》和歌手，紧跟着一句实话——这一首哪儿好听、哪儿烦，挑一样具体的说（鼓点、贝斯、唱腔、编曲、词，挑一个）。`
          + `别写"我吃""这个跳"这种套话，也别每首都夸；上一首夸过的角度这一首换掉。两句加起来别超过三十个字。`
          + `${lyricIntro && !lyricIntro.startsWith('这首的') ? '词已经给你了，能接上就点一句词，别照念；接不上就说音色。' : ''}`
          + `${emoji}${tagAsk ? ` ${tagAsk}` : ''}）`;
        senderKey = `music.track:${trackKey(signal.track)}:${at}`;
        break;
      }
      case 'loop':
        text = `[${stamp}] 《${signal.track.title}》${signal.track.artist ? ` — ${signal.track.artist}` : ''}，这是这次收听里的第 ${signal.count} 遍。`;
        senderKey = `music.loop:${trackKey(signal.track)}:${signal.count}`;
        break;
      case 'fidget':
        text = `[${stamp}] 最近 ${signal.windowMin} 分钟他连跳了 ${signal.skipped} 首，每首都不到 45 秒。`;
        senderKey = `music.fidget:${at}`;
        break;
      case 'night':
        // 时间戳已经在正文开头了，这里再写一遍就会变成"[23:40] 已经 23:40 了"。
        text = `[${stamp}] 已经这个点了，他还在听 ${quote(signal.track, label)}。`;
        senderKey = `music.night:${localDay(tz, at)}`;
        break;
      case 'long':
        text = `[${stamp}] 他已经连着听了 ${humanDuration(signal.minutes * 60_000)}，现在在放 ${quote(signal.track, label)}。`;
        senderKey = `music.long:${signal.track.app}:${signal.minutes}`;
        break;
      case 'relay': {
        // 这是"连续点歌"唯一的时机，所以正文要把三件事一次说清：
        //   1. 这首是**她点的** —— 不然她以为那是他自己翻出来听的
        //   2. 接着点 / 不接，两条路都给（不给句子，只给方向）
        //   3. 没接就别追问 —— 接力最讨人嫌的形态是每隔半分钟催一次
        //
        // 「想替他按播放」那句按宿主的规矩写死：别的 World 推来的消息**不能**成为用电脑的理由，
        // 必须先 pet_ask 拿到他这一侧的明确回答。不这么写她会直接去动鼠标，然后被拒绝，
        // 表现成"她说了要放，但什么都没发生"。
        const cand = this.relayCandidatesText(signal.track);
        text = `[${stamp}] 他放的是你点的那首 ${quote(signal.track, label)}，还剩约 ${signal.remainSec} 秒。`
          + '（这一条要的就是下一首，别只评一句这首歌就走 —— 那半分钟过去，播放器自己进下一首，你以为接上了，其实断了。'
          + '接着点：用 music_pick 再挑一首递给他，别重复这一首。'
          + (cand ? `${cand} —— 想从里面拿，就用 from 那个编号取，不用重搜。` : '')
          + '挑好一句话说完，带链接。'
          + '想自己按：先 pet_ask 问一句，他答应了再动手；而且**先 pick 再按** —— 不 pick，下一棒我认不出来。'
          + '不接着点：说一句你听完了就停，别硬凑。他没接，就别问第二遍。）';
        senderKey = `music.relay:${trackKey(signal.track)}:${signal.chain}`;
        break;
      }
      case 'segment': {
        // 段事件是"陪听"的节拍器：她每段都该说一句，所以这条要带上
        // 这一段落在歌曲的哪个位置、是第几段、共几段——否则几条一模一样的歌名
        // 会让她把同一句话说几遍。
        //
        // 还带上"今天的量"和"这一场多久"：这不是装饰。实测第 2 段她只动了个表情不说话，
        // 因为除了歌名她手上没有任何新事实。"这一场第 3 首、连着 12 分钟、今天 5 首"
        // 就是她"说他"那一段唯一能踩的实地。
        const total = this.cfg.maxSegmentsPerTrack > 0
          ? `，这一首最多 ${this.cfg.maxSegmentsPerTrack} 段`
          : '';
        const posText = signal.posSec !== null
          ? `${clockOf(signal.posSec)}${signal.durSec ? ` / ${clockOf(signal.durSec)}` : ''}`
          : clockOf(signal.toSec);
        const st = this.tracker?.state();
        const today = this.store?.readDay(localDay(this.opts.timezone, at)) ?? [];
        const doneToday = today.length;
        const artist = signal.track.artist;
        const artistTimes = artist ? today.filter((r) => r.artist === artist).length + 1 : 0;
        const angle = talkAngle(signal.indexInSession, doneToday);
        // 里程碑：只有这一刻才许说"今天多少首"。
        // talkAngle 已经把"报总量"那一格锁在里程碑上，但**事实本身还在无节制地喂**——
        // 实测 listen.27 跑下来，她仍然是「九首了」「八首了」「第五首了」「十三首」，
        // 那些数全是从 index>=3 那支的"这个歌手今天第 N 首"里抠出来的。
        // 角度管住了"问什么"，管不住"手上有什么"，所以还得把料一起掐断。
        const milestone = doneToday > 0 && doneToday % COUNT_MILESTONE === 0;
        // 里程碑只报一次：一首歌三段，段 2 报完段 3 又报，等于把"隔十几首说一次"变回"每段都说"。
        const freshMilestone = milestone && this.milestoneReported !== doneToday;
        if (freshMilestone) this.milestoneReported = doneToday;
        // 段 2 一次只给一样实据（四首一循环），其余段照旧全给。
        // 差别不是"少说点字"，是"少给一张可抄的表"：四样并排摆出来，她必然抄成
        // 「第 N 首，八点二十一」这种台账。给一样，她才不得不自己组织一句话。
        //
        // 分派必须和数据"是一路的"：第一版让角度 2（说人）在没重复歌手时去拿
        // 「今天已收尾 38 首」兜底，结果问题问她"他认准了谁"，数据给的是个量——
        // 她只能拿这个量硬凑。现在每格只拿配得上的那样，拿不到就明说没有。
        const context = signal.index === 2
          ? ([
            freshMilestone ? `今天已收尾 ${doneToday} 首` : '',
            st ? `连着听了 ${humanDuration(st.sessionPlayedMs)}` : '',
            // "说他"这一格的实据不是"第几首"，是"他今天一直在放这一个嗓子"。
            // 数量只在里程碑给一次，平时给描述——她要的是能接话的细节，不是一个计数。
            artistTimes > 1
              ? (freshMilestone ? `这个歌手今天第 ${artistTimes} 首` : `他今天一直在放 ${artist}`)
              : '',
            '',
          // 兜底原来写的是"这一次没有数字可报"，但落在"说人"那格时她认成
          // "没数字所以随便说"——21:47 她说的是"换了好几把嗓子"，其实还行，
          // 但措辞暗示了"这一句本该有数字"。改成明说这一句不要实据。
          ][angle] || '这一句不用实据，说你自己看到的就行')
          : freshMilestone
            // 里程碑那一段只给这一件。21:37:36 实测过：场次 + 时长 + 总量 + 歌手计数
            // 四样一起摆出来，她立刻又排成一行账。给一件，她才得自己组织一句话。
            ? `今天已收尾 ${doneToday} 首`
            : [
              // 场次计数只在前两首有意义（刚起场，"这是这一场第 1 首"），之后就是台账。
              signal.indexInSession <= 2 ? `这一场第 ${signal.indexInSession} 首` : '',
              st ? `连着听了 ${humanDuration(st.sessionPlayedMs)}` : '',
            ].filter(Boolean).join('、');
        // 这一段是什么路数、落在歌的哪个位置——这两个一起决定表情和语气。
        // 路数三档来源：她标过 → 字面弱判 → 未标。未标时明确写"还没标"，
        // 不能默认成"柔"：那会让她对着一首金属说"这首很温柔"。
        const vibe = this.vibeOf(signal.track);
        const phase = signal.phase;
        // 长曲（古典、现场、组曲）只报前后，不报"副歌"——那套段落名对它们不成立。
        const longform = isLongform(signal.durSec);
        const where = phase
          ? `，${longform ? LONGFORM_NOTE[phase] : PHASE_NOTE[phase]}`
          : '，位置未知';
        // 欢快的柔：曲风名认得出来就是欢快的，认不出看 BPM。它同时决定三件事——
        // 不给坐姿动作、不许说困、候选里剔掉坐姿。声明必须在 ask 之前，stateAngle 要用。
        const lively = isLivelySoft(vibe.feel, vibe.genre, this.audioFeatures.summary());
        const ask = signal.index === 2
          // 第 4 格按曲风分版：柔歌里可以困，其余照旧不许。见 stateAngle()。
          ? (angle === 3 ? stateAngle(vibe.feel, lively) : TALK_ANGLES[angle])
          : SEGMENT_ASK[Math.min(SEGMENT_ASK.length, Math.max(1, signal.index)) - 1];
        // 表情这句以前写的是"你要是没有，换成最接近的一张，别不发"——这句是个坑：
        // 它等于允许她改词，而她一旦不确定（"鲸鱼词表里有思考吗"）就会真的去换，
        // 换上来的永远是【开心】，五档听感全塌成一张脸。现在改成不许换、不许译。
        //
        // "别译成英文"是 listen.16 补的：给了中文名，她还是把【开心】写成【happy】。
        // 英文 id 词表里其实认（figure.json 的 id 就是英文），但只要她一边写英文一边
        // 怀疑"鲸鱼有没有这张脸"，就会退回【开心】。让她原样抄，这条岔路直接堵死。
        //
        // "第一张是定的"是 listen.17 补的：listen.16 跑下来，柔/副歌给了【喜欢】她照抄了，
        // 旧/主歌给了【思考】或【得意】，她写"这歌我吃，想起小时候的下午"配【happy】——
        // 她是按句子的情绪挑脸，不是按路数。所以现在把第一张写成硬要求，第二张降成"顶多换"。
        // 位置不明时表情退到中段那一格（不报高低点，但至少有一张脸）。
        // 不空着的原因同 fallbackMove()：网易云的古典全没有位置，空着就等于整首歌都没有脸。
        const pool = poolIds(vibe.feel, phase ?? 'verse');
        const primary = pool.length ? wordText(pool[0]) : '';
        const alt = pool.length > 1 ? wordText(pool[1]) : '';
        // 动作按"路数 × 位置"配。为什么要写进事件正文而不是只写 ENV_PROMPT：
        // 实测过，光写在提示词里她不照着做，正文里点了名她才用。
        //
        // 第三个参数是"上一次下发的动作"：抒情歌的副歌和桥段都落在 groove 上，
        // 一首歌连着两段【律动】、换首歌还是【律动】，身体看上去像卡住了
        // （实测 21:20 / 21:23 / 21:24 连着三次）。撞了就换同档的备选。
        //
        // 现在是把它**并进表情那个括号**，而不是另起一句"动作配【蹦迪】"让她再发一条
        // pet_act —— 后者她漏过一次（21:44:39 只说了话，人站着没动）。
        // 同上：避让用原 id，发出去和记下来的都是降级后的实际 id。
        // 「坐得住」由场合判，不由她判。两个条件都只有 World 知道，她的句子里永远不会提到：
        //   1. 已经连着听了 20 分钟以上 —— 听得够久，坐下来听完是自然的；
        //   2. 深夜（23 点后或 5 点前）—— 这个点还在放柔歌，本来就是坐下来听的场合。
        //
        // 只认第 1 条不够：core 一重启，sessionPlayedMs 归零，规则要再等二十分钟才生效，
        // 而"深夜"这个条件不因为重启而消失。2026-10-29 00:29 实测踩到的就是这个——
        // 刚重启完，连听时长是 0，明明该坐下却还站着。
        const DEEP_MS = 20 * 60_000;
        const nightNow = (() => { const h = new Date().getHours(); return h >= 23 || h < 5; })();
        const deep = (!!st && st.sessionPlayedMs >= DEEP_MS) || nightNow;
        const rawMove = moveIdAny(vibe.feel, phase, this.lastMove, deep, lively);
        const landed = degradeMove(rawMove);
        const move = landed ? (MOVE_WORD[landed] ?? '') : '';
        // ⚠ 这里记的是**我们算出来的首选**，不是她最后挑的那个 —— 候选制下她可以在四个里换，
        // 而她的 `pet_say` 走的是 Core 的工具通道，World 收不到，所以拿不到实际动作。
        // 后果：避让对"上一次首选"有效，对"上一次实际动作"失效。实测 23:18 首选应援、她挑蹦迪，
        // 下一轮就按应援来避让，可能连着给她同一个实际动作。
        // 不修是因为改不了（架构上拿不到她的输出），且候选制本身已经让变化发生。
        if (landed) this.lastMove = landed;
        const emoji = primary
          ? `脚本开头原样写 【${primary}】——表情照抄这个。`
            + choiceText(moveChoices(vibe.feel, move, lively), primary, SEGMENT_SPECIAL)
            + `${alt ? `表情顶多换成【${alt}】。` : ''}`
            + `抄中文别译英文；这张脸是按这首的劲儿定的，不按你这句话的情绪挑。`
          // 同上：表情空了不能把动作一起吞掉。
          : choiceText(moveChoices(vibe.feel, move, lively), '', SEGMENT_SPECIAL);
        void move;
        // 第 1 段顺带请她标一下：这一段她本来就要认这首歌。标一次，后面两段和以后
        // 同一首都不用再想，表情也就不会再前后打架。
        // 措辞里不放"路数"两个字——她抄一个词，下一句气泡里就多一个术语。
        const tagAsk = vibe.source === 'none' && signal.index === 1
          ? '认得这首就顺手 music_tag 标一下。'
          : '';
        // 一次性纠偏，见 vocabHint() 的注释。
        const hint = this.vocabHint();
        // 段 2 要防的第二件事是"抄时间戳"。正文开头那个 [20:21] 是给她对表用的，
        // 她直接念成"八点二十一"，于是九首歌九次「第 N 首，八点二十一」。
        // 角度 1 允许说"一个多小时"这种粗的时长，但不许报钟点。
        const noClock = signal.index === 2
          ? '开头那个 [时:分] 是给你对表用的，别念进话里。'
          : '';
        // 歌词：这一段落里刚唱过的几句。她"陪听"能说出内容全靠这一行料。
        // 只给这一段区间，不给"此刻那一句"——见 lyrics.ts 的 segmentLines 注释。
        const lyricSeg = await this.lyricCue(signal.track, 'segment', signal.fromSec, signal.toSec);
        const hasWords = !!lyricSeg && !lyricSeg.startsWith('这首的');
        // 这一段之前攒下的深听档案。没有就不提——她不该以为自己分析过。
        // 走向没变就不重复给她：同一首歌的后两段会拿到一模一样的一句话，她会照抄两遍。
        const sheetNow = sheetShort(this.hearingSheets.get(trackKey(signal.track)));
        const sheetKey = trackKey(signal.track);
        const sheetLine = sheetNow && (sheetKey !== this.lastSheetKey || sheetNow !== this.lastSheetLine)
          ? sheetNow
          : '';
        if (sheetNow) { this.lastSheetKey = sheetKey; this.lastSheetLine = sheetNow; }
        // 复读检测：把她这一场自己说过的原话拿回来做骨架比对（见 repeatHint 的注释）。
        // 没有重复就返回空串，正文不多一个字。同一条提示十分钟内只给一次——她要是没改，
        // 每段都刷一遍反成了噪音；她改过之后提示内容会变，会重新出现。
        const sayHintRaw = repeatHint(this.recentSays());
        const sayHint = sayHintRaw
          && (sayHintRaw !== this.lastRepeatHint || at - this.lastRepeatAt > 10 * 60_000)
          ? sayHintRaw
          : '';
        if (sayHint) { this.lastRepeatHint = sayHintRaw; this.lastRepeatAt = at; }
        // 留痕：这条链路（事件库 → 骨架比对 → 事件正文）如果断了，日志里会一条都没有。
        // 「她怎么又复读了」先查这里有没有打出来。
        if (sayHint) this.log?.info(`复读提示：${sayHint}`);
        // 2026-11-08：正文原来写「路数：柔（华语流行）。语气：轻、慢，字少」，她会
        // 把「路数」「这一档」原样搬进气泡（实测 10-27「软了一档」、10-30 与 11-08
        // 两次「这一档…」、10-26/11-04「这个路数」）。根源在输入这一端：我给的是表格，
        // 她自然按表格说话。改成自然句，她拿到手的就已经是能说出口的说法。
        text = `[${stamp}] ${quote(signal.track, label)} 放到 ${posText}${where}。`
          + (vibe.source === 'none'
            ? '这首还没标。'
            : `这首偏${FEEL_TEXT[vibe.feel]}${vibe.genre ? `（${vibe.genre}）` : ''}`
              + `${['album', 'artist', 'audio'].includes(vibe.source) ? `——${vibe.reason}` : ''}。`
              + `说话${FEEL_TONE[vibe.feel]}。`)
          + this.audioPerceptionLine()
          + (sheetLine ? `${sheetLine}` : '')
          + `这一首走到第 ${signal.index} 段（${clockOf(signal.fromSec)} → ${clockOf(signal.toSec)}${total}）${context ? `，${context}` : ''}`
          + `${signal.loopCount >= 2 ? `，这次收听里的第 ${signal.loopCount} 遍` : ''}。`
          + (lyricSeg ? `${lyricSeg}` : '')
          + `（${ask}${noClock ? ` ${noClock}` : ''}${hasWords ? ' 词在上面：要评就落到那一句上，挑一句用，别把两句都念出来。' : ''}${emoji ? ` ${emoji}` : ''}${tagAsk ? ` ${tagAsk}` : ''}）`
          + (sayHint ? `\n${sayHint}` : '')
          + (hint ? `\n${hint}` : '');
        // 同一场、同一首、同一段只该出现一次。带场次起点是为了让"第 3 段"在另一场里不被当成同一条。
        senderKey = `music.segment:${trackKey(signal.track)}:${st?.sessionStartedAt ?? 0}:${signal.index}`;
        break;
      }
    }
    if (!text) return;

    // 让路：开关打开、并且炉石在跑，就不主动开口。
    //
    // 让的是「主动播报」这一层 —— 被戳时的回答走工具调用，不经过这里，所以照样会答。
    // 默认关：两件事同时进行、各说各的，很多人就喜欢那样，不该由我们替他们决定。
    // 顺带记一行日志：以后有人说「她怎么不说话了」，先看这里是不是让路了。
    if (this.cfg.yieldToHearthstone && await isPeerRunning(['Hearthstone.exe'])) {
      this.log?.info(`炉石在跑，${decl.type} 让路（不主动开口）。`);
      return;
    }

    try {
      await host.pushEvent({
        type: decl.type,
        source: this.id,
        senderKey,
        ts: new Date(at).toISOString(),
        text,
      }, { trigger: decl.trigger });
      this.lastTextAt = stamp;
      this.pushStamps.push(Date.now());
      if (this.pushStamps.length > 6) this.pushStamps.shift();
      this.log?.info(`推送 ${decl.type}：${text.slice(0, 80)}`);
    } catch (error) {
      this.log?.warn(`推送 ${decl.type} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 该不该为这一条开口。
   *
   * 现在的规则只有一条：**安静档之外，来什么就推什么**。
   * 换歌不再看"是不是换了歌手"，也不再有十分钟冷却——上一版那两道闸是为了防"合集里
   * 每首都不同歌手"把源变成弹幕，但使用者的要求恰好相反：每一首他都要听她说一句。
   * 噪音控制交给段长（`segmentEverySec`）和提示词里的"别重复自己"，不再在推送侧截流，
   * 否则他会发现明明换了歌她却装没看见。
   */
  private shouldSpeak(signal: Signal): boolean {
    if (this.cfg.chatiness === 'quiet') {
      return signal.kind === 'night' || signal.kind === 'long';
    }
    return true;
  }

  /* ================= 工具 ================= */

  tools(): ToolDef[] {
    return [
      { ...NOW_DECL, handler: async () => ({ text: this.nowText() }) },
      { ...HISTORY_DECL, handler: async (args) => ({ text: this.historyText(Number(args.days) || 1) }) },
      { ...TASTE_DECL, handler: async (args) => ({ text: this.tasteText(Number(args.days) || 7) }) },
      {
        ...CONTROL_DECL,
        barrierAfter: true,
        handler: async (args) => ({ text: await this.controlText(String(args.action ?? '')) }),
      },
      { ...NOTE_DECL, handler: async (args) => ({ text: this.noteText(String(args.text ?? '')) }) },
      {
        ...TAG_DECL,
        handler: async (args) => ({ text: this.tagText(String(args.feel ?? ''), String(args.genre ?? '')) }),
      },
      {
        ...PICK_DECL,
        handler: async (args) => ({
          text: await this.pickText(
            String(args.query ?? ''),
            String(args.why ?? ''),
            Number(args.from) || 0,
          ),
        }),
      },
      { ...SOUL_DECL, handler: async (args) => ({ text: this.soulText(args) }) },
      {
        ...LYRIC_DECL,
        handler: async (args) => ({ text: await this.lyricText(Number(args.ahead ?? 0)) }),
      },
      { ...LISTEN_DECL, handler: async () => ({ text: await this.hearingText() }) },
    ];
  }

  /**
   * music_lyric 的回执。
   *
   * 回执里刻意**不写秒数**，只写"第几行 / 共几行"。写秒数她会念成"一分二十三秒"，
   * 那跟她自己的段报时叠在一起，就成了在报进度条。她要的是"唱到哪一句"。
   */
  private async lyricText(ahead: number): Promise<string> {
    const st = this.tracker?.state();
    const track = st?.track;
    if (!track) return '现在没在放，没词可看。';
    if (!this.cfg.lyricAware) return '你这边关掉了「让她看歌词」，我拿不到词。要开的话在设置 → World → 一起听歌 → 歌词。';

    const input = this.lyricInput(track);
    const doc = this.lyrics.peek(input) ?? await this.lyrics.ensure(input);
    if (!doc) return `《${track.title}》的词我没查到——曲库里按歌名歌手没匹配到这一版，我不猜。`;
    if (doc.instrumental) return `《${doc.title}》在词库里标的是纯音乐，没有词。`;

    const pos = typeof st?.posSec === 'number' && st.posSec > 0
      ? st.posSec
      : Math.round((st?.playedMs ?? 0) / 1000);
    const back = Math.max(1, Math.min(3, Math.trunc(this.cfg.lyricLines) || 2));
    const pool = linesAt(doc.lines, Math.max(0, pos), back + Math.max(0, Math.min(4, Math.trunc(ahead) || 0)));
    const body = quoteLines(pool);
    if (!body) return `《${doc.title}》有词，但这一刻对不上一句（可能还在前奏）。`;

    const at = doc.lines.findIndex((l) => l.t > pos);
    const lineNo = at < 0 ? doc.lines.length : at;
    return `《${doc.title}》 — ${doc.artist || '未知歌手'}：现在约第 ${lineNo}/${doc.lines.length} 句。词：「${body}」。`
      + `（这是查到的词，来源 ${doc.source === 'qq' ? 'QQ音乐' : '网易云'}，已按歌名+歌手+时长核过。`
      + `引用一两句够用，别整段贴。）`;
  }

  /**
   * 这首歌按什么路数处理，优先级从高到低：
   * 同曲标签 → 同专辑/同歌手学习 → 字面弱判 → 声音近邻 → 未知。
   *
   * "她自己标的"永远优先：她认得出的歌，比"标题里有'钢琴'两个字"可靠得多。
   * 而且这样她改主意也有效——再标一次就覆盖。
   */
  private vibeOf(track: Track): {
    feel: Feel; genre: string;
    source: 'tag' | 'album' | 'artist' | 'guess' | 'audio' | 'none';
    reason?: string;
  } {
    const tagged = this.vibes?.get(trackKey(track));
    if (tagged) return { feel: tagged.feel, genre: tagged.genre, source: 'tag' };
    const tags = this.vibes?.all() ?? [];
    // 元数据学习先于标题弱判；声音近邻放在字面之后，避免弱特征盖过明确版本信息。
    const learned = suggestGenre(track, tags, null);
    if (learned) return learned;
    const guess = guessFeel(track);
    if (guess.sure) return { feel: guess.feel, genre: guess.genre, source: 'guess' };
    const byAudio = suggestGenre(track, tags, this.audioFeatures.summary());
    if (byAudio) return byAudio;
    return { feel: 'plain', genre: '', source: 'none' };
  }

  /* ---------- 工具回执正文 ---------- */

  private healthLine(): string {
    const bridge = this.bridge;
    if (!bridge) return '数据源：还没启动。';
    const h = bridge.health();
    if (!h.exe) return '数据源：这台机器找不到 powershell，读不到播放器。';
    if (!h.running) return `数据源：读取进程没有在跑${h.lastError ? `（${h.lastError}）` : ''}。`;
    if (h.lastLineAt === null) return '数据源：读取进程刚起来，还没拿到第一份数据。';
    const lag = Math.round((Date.now() - h.lastLineAt) / 1000);
    if (lag > 20) return `数据源：数据停在 ${lag} 秒前，可能播放器刚被关掉或系统媒体组件重启了。`;
    return `数据源正常（${lag} 秒前的采样${h.restarts ? `，重启过 ${h.restarts} 次` : ''}）。`;
  }

  private nowText(): string {
    const tracker = this.tracker;
    if (!tracker) return '听歌扩展还没启动，现在读不到播放器。';
    const st = tracker.state();
    const tz = this.opts.timezone;
    const now = Date.now();
    const today = localDay(tz, now);
    const todayRecords = this.store?.readDay(today) ?? [];
    const todayMs = todayRecords.reduce((sum: number, r: ListenRecord) => sum + (Number(r.ms) || 0), 0);

    const lines: string[] = [];
    if (st.track && st.playing) {
      const label = playerLabel(st.track.app, this.cfg.extraPlayers);
      lines.push(`现在：${label} 正在放${quote(st.track, '')}`);
      const progress = st.posSec !== null && st.durSec ? `${clockOf(st.posSec)}/${clockOf(st.durSec)}` : '进度未知';
      lines.push(`进度 ${progress}；这次收听里第 ${Math.max(1, st.loopCount)} 遍。`);
      // 路数和位置也报出来：她查"现在什么情况"时，往往正是要决定用什么表情说话。
      // 2026-11-08：措辞改成自然句（原来是「路数：柔。位置：副歌一带」），
      // 回执里的标签词是第二个抄袭源——她查一次 music_now，下一句气泡就带一个术语。
      const vibe = this.vibeOf(st.track);
      const phase = phaseOf(st.posSec, st.durSec);
      const where = phase
        ? (isLongform(st.durSec) ? LONGFORM_NOTE[phase] : PHASE_NOTE[phase])
        : '位置未知';
      const vibeText = vibe.source === 'none'
        ? '还没标（你觉得够劲、软、旧、怪、还是没感觉，可以直接 music_tag 标上）'
        : `偏${FEEL_TEXT[vibe.feel]}${vibe.genre ? `（${vibe.genre}）` : ''}${
          vibe.source === 'guess' ? '，按标题字面猜的'
            : vibe.source === 'tag' ? '，你自己标过'
              : `——${vibe.reason}`
        }`;
      // 表情也一起报出来：她问"现在什么情况"往往就是为了决定下一句用什么脸。
      // 只给第一张——和段事件里的硬要求保持一致，两处说两张脸她会来回挑。
      const face = phase ? wordText(poolIds(vibe.feel, phase)[0]) : '';
      lines.push(`${vibeText}，${where}${face ? `，表情用【${face}】` : ''}。`);
      const hearing = this.audioPerceptionLine();
      if (hearing) lines.push(hearing);
      const sheet = sheetShort(this.hearingSheets.get(trackKey(st.track)));
      if (sheet) lines.push(sheet);
      if (st.segmentsSaid > 0) lines.push(`这一首你已经说过 ${st.segmentsSaid} 段。`);
      lines.push(`这一场连续听：${humanDuration(st.sessionPlayedMs)}（从我留意到算），已过 ${st.indexInSession} 首。`);
    } else if (st.track) {
      lines.push(`没在放，暂停在${quote(st.track, playerLabel(st.track.app, this.cfg.extraPlayers))}。`);
    } else {
      const last = todayRecords[0] ?? this.store?.readDay(localDay(tz, now - 86_400_000))[0];
      lines.push(last
        ? `现在没在放。最后一首是 ${localClock(tz, last.end)} 的${quote({ app: last.app, title: last.title, artist: last.artist, album: last.album }, '')}，听了 ${humanDuration(last.ms)}。`
        : '现在没在放，今天还没有记录。');
    }

    lines.push(todayRecords.length
      ? `今天：已收尾 ${todayRecords.length} 首、${humanDuration(todayMs)}${st.track && st.playing ? '（另加正在放的这一首）' : ''}。`
      : '今天：还没听完一首。');

    const notes = this.store?.notes(3) ?? [];
    if (notes.length) {
      lines.push(`你记过的笔记（最近 ${notes.length} 条）：`);
      for (const n of notes) lines.push(`  · ${n.text}${n.title ? `（${n.title}）` : ''}`);
    }

    if (this.lastPick && !this.lastPick.session) lines.push(`挑会话：${this.lastPick.reason ?? '没有可用的播放器'}。`);
    lines.push(this.healthLine());
    return lines.join('\n');
  }

  private historyText(days: number): string {
    const store = this.store;
    if (!store) return '听歌扩展还没启动，没有记录可读。';
    const n = Math.min(30, Math.max(1, Math.trunc(days) || 1));
    const tz = this.opts.timezone;
    const now = Date.now();
    const lines: string[] = [];
    let grand = 0;
    let grandMs = 0;

    for (const day of recentDays(tz, n, now)) {
      const records = store.readDay(day);
      if (!records.length) {
        if (n <= 3) lines.push(`${shortDay(tz, day)}：没有记录。`);
        continue;
      }
      const s = summarize(records);
      grand += s.tracks;
      grandMs += s.ms;
      lines.push(`${shortDay(tz, day)}：${s.tracks} 首 / ${humanDuration(s.ms)}`);
      const artists = s.artists.slice(0, 3).map((a) => `${a.name} ${a.count}`).join('、');
      if (artists) lines.push(`  歌手：${artists}`);
      const shown = s.list.slice(0, n === 1 ? 12 : 6);
      for (const r of shown) {
        const mark = r.ms < 20_000 ? '（没听完）' : '';
        lines.push(`  ${localClock(tz, r.end)} ${r.title || '未知曲目'}${r.artist ? ` — ${r.artist}` : ''} ${humanDuration(r.ms)}${mark}`);
      }
      if (s.list.length > shown.length) lines.push(`  …还有 ${s.list.length - shown.length} 首`);
    }

    if (!lines.length) return `最近 ${n} 天没有任何听歌记录。`;
    lines.push('');
    lines.push(`合计 ${grand} 首 / ${humanDuration(grandMs)}。`);
    return lines.join('\n');
  }

  private tasteText(days: number): string {
    const store = this.store;
    if (!store) return '听歌扩展还没启动，读不到口味。';
    const n = Math.min(90, Math.max(1, Math.trunc(days) || 7));
    const tz = this.opts.timezone;
    const now = Date.now();
    const daysList = recentDays(tz, n, now);
    const records = store.readDays(daysList);
    if (!records.length) return `最近 ${n} 天没有任何听歌记录。`;

    const s = summarize(records);
    const lines: string[] = [];
    const activeDays = new Set(records.map((r) => localDay(tz, r.end))).size;
    lines.push(`最近 ${n} 天：${s.tracks} 首 / ${humanDuration(s.ms)}，有 ${activeDays} 天在听。`);
    if (s.artists.length) {
      lines.push(`常听歌手：${s.artists.slice(0, 6).map((a) => `${a.name}（${a.count} 首 / ${humanDuration(a.ms)}）`).join('、')}`);
    }
    if (s.replays.length) {
      lines.push(`反复听的：${s.replays.slice(0, 5).map((r) => `《${r.title}》${r.count} 遍`).join('、')}`);
    } else {
      lines.push('反复听的：没有，这个窗口里每首基本只出现一次。');
    }

    const buckets = { 清晨: 0, 白天: 0, 傍晚: 0, 深夜: 0 } as Record<string, number>;
    for (const r of records) {
      const hour = Number(localClock(tz, r.end).slice(0, 2)) % 24;
      if (hour >= 5 && hour < 9) buckets['清晨'] += 1;
      else if (hour >= 9 && hour < 17) buckets['白天'] += 1;
      else if (hour >= 17 && hour < 22) buckets['傍晚'] += 1;
      else buckets['深夜'] += 1;
    }
    lines.push(`时段：${Object.entries(buckets).map(([k, v]) => `${k} ${v} 首`).join('、')}`);

    const byPlayer = new Map<string, number>();
    for (const r of records) {
      const label = playerLabel(r.app, this.cfg.extraPlayers);
      byPlayer.set(label, (byPlayer.get(label) ?? 0) + 1);
    }
    lines.push(`播放器：${[...byPlayer.entries()].map(([k, v]) => `${k} ${v} 首`).join('、')}`);
    return lines.join('\n');
  }

  private async controlText(action: string): Promise<string> {
    if (!this.cfg.controlAllowed) {
      return '使用者关掉了「允许她代为暂停/切歌」，所以没有按。需要的话让他在设置里打开。';
    }
    const allowed: ControlAction[] = ['pause', 'resume', 'next', 'prev'];
    if (!allowed.includes(action as ControlAction)) {
      return '没有指定动作。可用：pause（暂停）、resume（继续）、next（下一首）、prev（上一首）。';
    }
    const pick = this.lastPick;
    const match = pick?.session?.app ?? '';
    const result = await runControl(action as ControlAction, match);
    if (!result.ok) {
      return `没能按下去：${result.error ?? '播放器拒绝了这次操作'}。${result.app ? `（${result.app}）` : ''}`;
    }
    const label = playerLabel(result.app ?? '', this.cfg.extraPlayers);
    const verb = { pause: '暂停', resume: '继续', next: '切到下一首', prev: '退回上一首' }[action as ControlAction];
    const now = result.title
      ? `现在 ${quote({ app: result.app ?? '', title: result.title, artist: result.artist ?? '', album: '' }, '')}，${statusText(result.status)}。`
      : `${statusText(result.status)}。`;
    return `已经在 ${label} 上${verb}了。${now}`;
  }

  /**
   * 自己找歌：搜、挑、记清单，然后如实说明"放不了"。
   *
   * 回执里那句"放不了"不能省。省了她就会顺着上下文说"放上了"，而这一侧
   * 根本没响——那是骗人，比什么都不做更糟。
   *
   * 两条来路：
   *   - 给了 `from`：从想听清单里认领第 N 首，不联网、秒回。接力点歌走这条。
   *   - 给了 `query`：真的去两个曲库搜一遍再挑（实测 0.9–1.6 秒）。
   *
   * 两条都要 `armRelay` 记一棒。不记的话，"现在放的是不是她点的那首"就无从判断，
   * 连续点歌到第二首就断了 —— 而表现不是报错，是"她不再接下一棒"。
   */
  private async pickText(query: string, why: string, from = 0): Promise<string> {
    if (!this.cfg.selfPick) {
      return '使用者关掉了「允许她自己去搜歌挑歌」，所以没去搜。要开的话让他在设置里打开。';
    }
    const cleanQuery = query.trim().slice(0, 60);
    const cleanWhy = why.trim().slice(0, 60);
    if (!cleanQuery && from <= 0) return this.wishlistText();

    // 从清单里认领：接力时优先走这条。搜一次要一两秒，而"快完了"那个窗口只有三十几秒，
    // 能省的联网就省掉；清单里的歌也是她当初真挑过的，比现搜一版更算"她点的"。
    if (from > 0) {
      const wants = this.store.wants(10);
      const w = wants[from - 1];
      if (!w) {
        return `想听清单里没有第 ${from} 首（现在共 ${wants.length} 首，编号从 1 开始，1 是最新的）。`;
      }
      const arm = this.armRelay({ title: w.title, artist: w.artist, source: w.source, url: w.url, durSec: w.durSec });
      const track: SearchTrack = {
        source: w.source === 'qq' ? 'qq' : 'netease',
        id: w.id,
        mid: w.mid,
        title: w.title,
        artist: w.artist,
        album: w.album,
        durSec: w.durSec,
        url: w.url,
      };
      return `接着点 ${describeTrack(track)}（${sourceLabel(track.source)}）。${arm}`
        + `还是放不了 —— 链接在这儿，你点一下：${w.url}`;
    }

    let tracks: SearchTrack[] = [];
    let problems: string[] = [];
    try {
      const r = await searchAll(cleanQuery, { source: this.cfg.pickSource, limit: 8 });
      tracks = r.tracks;
      problems = r.problems;
    } catch (e) {
      return `搜索没连上：${String((e as Error)?.message ?? e).slice(0, 80)}。`;
    }
    if (tracks.length === 0) {
      const extra = problems.length ? `（${problems.join('；')}）` : '';
      return `没搜到「${cleanQuery}」${extra}。换个说法再试——歌名带不带书名号都行，歌手名也能当关键词。`;
    }
    const best = pickBest(tracks, cleanQuery);
    if (!best) return `搜到 ${tracks.length} 首，但没有一首是完整的歌（都太短），没挑。`;

    const attempt = await playAttempt(best);
    const saved = this.store.addWant({
      source: best.source,
      id: best.id,
      mid: best.mid,
      title: best.title,
      artist: best.artist,
      album: best.album,
      durSec: best.durSec,
      url: best.url,
      why: cleanWhy,
    }, Date.now());
    const arm = this.armRelay({
      title: best.title, artist: best.artist, source: best.source, url: best.url, durSec: best.durSec,
    });

    const parts: string[] = [`挑了 ${describeTrack(best)}（${sourceLabel(best.source)}）。`];
    parts.push(saved.added ? `已记进想听清单，第 ${saved.total} 首。` : '这首之前就记过了。');
    parts.push(arm);
    if (attempt.ok) parts.push(`已经在 ${sourceLabel(best.source)} 上放了。`);
    else parts.push(`${attempt.reason}。链接在这里，点开就能放：${best.url}`);
    if (problems.length) parts.push(`（${problems.join('；')}）`);
    return parts.join('');
  }

  /**
   * 记一棒：这一首是她递出去的。
   *
   * 落盘是**立刻**的（saveState(true)）。接力状态一丢，下一首快完时她就不会开口，
   * 而用户看到的是"连续点歌只连了一首就不动了"——这种错很难归到"状态没存住"上。
   */
  private armRelay(pick: RelayPick): string {
    if (!this.cfg.relayPick) return '接力点歌关着，所以我不会跟着接下一棒。';
    const before = this.relayState;
    const next = relayArm(before, pick, Date.now(), RELAY_MAX_CHAIN);
    this.relayState = next;
    this.saveState(true);
    const fresh = next.startedAt !== before.startedAt;
    if (fresh) return `这一轮第一棒（最多 ${RELAY_MAX_CHAIN} 首）。`;
    return `这一轮第 ${next.count} 棒（最多 ${RELAY_MAX_CHAIN} 首）。`;
  }

  /**
   * 想听清单里还能接的几首，带编号。
   *
   * 编号不是装饰：`music_pick` 的 `from` 就是按这个号取的。让她对着清单文字自己数，
   * 数错一位就递了别的歌 —— 而这类错没有任何报错，只有"她忽然换了首无关的"。
   */
  private relayCandidatesText(cur: Track): string {
    const wants = this.store?.wants(10) ?? [];
    if (!wants.length) return '';
    const skip = new Set(
      [bareTitle(cur.title), bareTitle(this.relayState.last?.title ?? '')]
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    );
    const picked: string[] = [];
    for (let i = 0; i < wants.length && picked.length < 3; i += 1) {
      const w = wants[i];
      const key = bareTitle(w.title).trim().toLowerCase();
      if (!key || skip.has(key)) continue;
      picked.push(`第 ${i + 1} 首《${w.title}》${w.artist ? ` — ${w.artist}` : ''}`);
    }
    return picked.length ? `想听清单里现成的还有 ${picked.join('、')}` : '';
  }

  /** 想听清单的文本版。没给关键词时走这条——比回一句"请给个关键词"有用。 */
  private wishlistText(): string {
    const wants: WantItem[] = this.store.wants(10);
    if (wants.length === 0) return '想听清单还是空的。给我一个关键词，我去搜一首。';
    const lines = [`想听清单（${this.store.wantCount()} 首，新的在前）：`];
    wants.forEach((w, i) => {
      const who = w.artist ? ` — ${w.artist}` : '';
      const why = w.why ? `｜${w.why}` : '';
      lines.push(`${i + 1}. 《${w.title}》${who}${why}`);
      if (w.url) lines.push(`   ${w.url}`);
    });
    return lines.join('\n');
  }

  /**
   * `music_soul` 的回执。
   *
   * 默认动作是读（不给参数）。写必须显式给 `add` + `section`，或者 `drop`。
   * **故意不提供"整篇覆写"**：这是全扩展唯一一个不可恢复的文件（逐日记录坏了只坏一行，
   * 笔记是追加），覆写一次就把她攒了几个月的东西抹平了。一条一条加，够用且安全。
   */
  private soulText(args: Record<string, unknown>): string {
    const dir = this.layout.memory;
    const add = typeof args.add === 'string' ? args.add.trim() : '';
    const drop = typeof args.drop === 'string' ? args.drop.trim() : '';

    if (!add && !drop) {
      // 读的时候允许建骨架 —— 骨架是容器，不是内容，所以不受 soulWritable 管。
      const text = readSoul(dir) ?? ensureSoul(dir);
      const n = soulLineCount(text);
      // 只记了「爱听」那一头时，回执末尾催一句（见 soul.ts 的 soulGapNote）。
      // 这一句比提示词管用：它是她这一轮真读到的那段文字。
      const gap = soulGapNote(text);
      const tail = gap ? `\n\n（${gap}）` : '';
      return n
        ? `我的口味档案（${n} 条）：\n\n${text}${tail}`
        : `我的口味档案还一条没写（${SOUL_FILE}）。\n\n${text}`;
    }

    if (!this.cfg.soulWritable) {
      return '使用者关掉了「允许你改自己的口味档案」，所以没写。要写的话让他在设置里打开。';
    }

    if (drop) return dropSoulLine(dir, drop).message;

    if (!isSoulSection(args.section)) {
      return '要给 section：love（我确实爱听）/ tolerate（听听就算了）/ hate（我听不下去的）/ unsure（还没想明白）。';
    }
    return addSoulLine(dir, args.section, add).message;
  }

  private tagText(feel: string, genre: string): string {
    if (!this.vibes) return '听歌扩展还没启动，没标上。';
    const track = this.tracker?.state().track;
    if (!track) return '现在没在放，没标。';
    if (!isFeel(feel)) {
      return `这个参数只认 hard / soft / old / odd / plain，你给的是「${feel || '空'}」，没标上。`;
    }
    const before = this.vibes.get(trackKey(track));
    const clean = genre.trim().slice(0, 12);
    const name = `《${track.title || '未知曲目'}》`;
    const label = `${FEEL_TEXT[feel]}${clean ? `（${clean}）` : ''}`;
    const features = this.audioFeatures.summary() ?? undefined;
    const meta = { title: track.title, artist: track.artist, album: track.album, features };
    if (before && before.feel === feel && (before.genre ?? '') === clean) {
      // 老档案只有 key/feel：同标签重复标记时补齐学习字段，但不改变用户判断。
      if (!before.title || !before.artist || (!before.features && features)) {
        this.vibes.set(trackKey(track), clean, feel, Date.now(), meta);
      }
      return `${name}本来就是 ${label}，没变。`;
    }
    this.vibes.set(trackKey(track), clean, feel, Date.now(), meta);
    return `${before ? '改了' : '记下了'}：${name} → ${label}。这一首后面的段按这个换表情；同专辑、同歌手与相似声音会逐步参考它。`;
  }

  /* ================= 深听：两条路，一份档案 ================= */

  private hearingMode(): HearingMode { return hearingModeOf(this.cfg.hearingMode); }

  /** 本机那条路装好了没有。没装是「要下载约 500MB」，不是「坏了」。 */
  private localHearingReady(): boolean {
    return existsSync(HEARING_PYTHON) && existsSync(HEARING_ANALYZER_FILE);
  }

  /** 给提示词用：现在走哪条路、能不能用、不能用时他该动哪里。 */
  private hearingStatusLine(): string {
    return hearingStatusText(this.hearingStatus());
  }

  /** 切片真实长度。读 WAV 头，不按 48k 硬算——设备采样率不一定是 48k。 */
  private wavSeconds(file: string): number {
    try {
      const head = readFileSync(file).subarray(0, 44);
      const rate = head.readUInt32LE(24);
      const channels = head.readUInt16LE(22);
      const bits = head.readUInt16LE(34);
      const perSec = rate * channels * (bits / 8);
      const sec = perSec > 0 ? (statSync(file).size - 44) / perSec : 0;
      return sec > 0 ? Math.round(sec * 10) / 10 : 12;
    } catch {
      return 12;
    }
  }

  /**
   * 让探针切一段。
   *
   * 请求文件是门控：探针平时一个字节都不写，看到这个文件才从环形缓冲里切 12 秒出来。
   * 9 秒等不到就放弃——多半是采集刚重启，干等只会让气泡更慢。
   */
  private async captureWav(): Promise<{ ok: true; wav: string } | { ok: false; reason: string }> {
    const dir = dirname(AUDIO_OUT_FILE);
    const request = join(dir, 'coopani-hearing.request');
    const wav = join(dir, 'coopani-hearing.wav');
    const quietRemove = (f: string) => { try { if (existsSync(f)) unlinkSync(f); } catch { /* 下次再清 */ } };
    quietRemove(request); quietRemove(wav);
    try {
      writeFileSync(request, '', 'utf8');
      const started = Date.now();
      while (Date.now() - started < 9000) {
        try {
          // 请求被消费、WAV 完整落盘，才算就绪。
          if (!existsSync(request) && existsSync(wav) && statSync(wav).size > 20_000) return { ok: true, wav };
        } catch { /* 文件正在换手 */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { ok: false, reason: '没等到声音切片（采集可能刚重启，或者这会儿没在输出声音）' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 本地那条路（兜底）：起一次性 Python 进程分轨，结果写文件再读回来。 */
  private async localSliceOneShot(
    wav: string,
    resultFile: string,
    ctx: { at: number; posSec: number | null; seconds: number },
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string }> {
    const run = await new Promise<{ err: string; timedOut: boolean }>((resolve) => {
      // 唱词转写只在两件事同时成立时才加 --asr：配置里开了，且走的是本地这条路。
      // `!== false` 是有意的：老配置文件里没有这个键，缺省必须是「开」，
      // 写成 truthy 判断的话，升级完所有人的 ASR 会静默不生效。
      const asrOn = this.cfg.asrEnabled !== false;
      const asrArgs = asrOn ? ['--asr'] : [];
      if (asrOn && this.cfg.asrCrossCheck) {
        const tier = this.cfg.asrWhisperTier || 'medium';
        asrArgs.push('--asr-cross', tier);
      }
      const child = spawn(HEARING_PYTHON, [
        HEARING_ANALYZER_FILE, '--wav', wav, '--out', resultFile,
        '--models-dir', HEARING_MODELS_DIR, '--cache-dir', HEARING_CACHE_DIR,
        ...asrArgs,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '', settled = false;
      // 结果走文件，stdout 不解析；但必须接住，不然出错时是静默失败。
      child.stdout?.on('data', () => { /* 分析器的 stdout 是同一份 JSON，用不上 */ });
      child.stderr?.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-4000); });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.killHearingTree(child);
        resolve({ err, timedOut: true });
      }, 55_000);
      child.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ err: `${err}\n${e.message}`, timedOut: false });
      });
      child.on('exit', () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ err, timedOut: false });
      });
    });

    if (run.timedOut) return { ok: false, reason: '本机分析超过 55 秒还没跑完，已经停掉' };
    if (!existsSync(resultFile)) {
      return { ok: false, reason: `本机分析没产出结果${run.err ? `：${run.err.trim().slice(0, 160)}` : ''}` };
    }
    let data: LocalAnalysis;
    try {
      data = JSON.parse(readFileSync(resultFile, 'utf8')) as LocalAnalysis;
    } catch (error) {
      return { ok: false, reason: `本机分析的结果读不出来：${error instanceof Error ? error.message : String(error)}` };
    }
    return this.localDataToSlice(data, ctx);
  }

  /**
   * 本地深听：优先用常驻进程，失败再退回一次性进程。
   *
   * 常驻省掉每次约 6 秒的会话初始化（实测 19.9 秒 → 同进程 13.6 秒）；
   * 一次性那条留着当保险——预热崩了也不能让她听不了歌。
   */
  private async localSlice(
    wav: string,
    resultFile: string,
    ctx: { at: number; posSec: number | null; seconds: number },
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string }> {
    const viaWorker = await this.localSliceViaWorker(wav, ctx);
    if (viaWorker) return viaWorker;
    return this.localSliceOneShot(wav, resultFile, ctx);
  }

  /** 常驻进程那条路。返回 null = 这条走不通，让上层去兜底。 */
  private async localSliceViaWorker(
    wav: string,
    ctx: { at: number; posSec: number | null; seconds: number },
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string } | null> {
    if (this.hearingWorkerFails >= 3) return null;
    const asrOn = this.cfg.asrEnabled !== false;
    const data = await this.askHearingWorker({
      wav,
      asr: asrOn,
      asr_cross: asrOn && this.cfg.asrCrossCheck ? (this.cfg.asrWhisperTier || 'medium') : '',
    });
    if (!data) return null;
    this.hearingWorkerFails = 0;
    return this.localDataToSlice(data as LocalAnalysis, ctx);
  }

  private ensureHearingWorker(): ChildProcess | null {
    if (this.hearingWorker && this.hearingWorker.exitCode === null) return this.hearingWorker;
    if (this.hearingWorkerFails >= 3) return null;
    try {
      // PYTHONUTF8/PYTHONIOENCODING 是第二道保险：分析器自己也 reconfigure 了 stdout，
      // 但这条管道一旦按 GBK 走，「G# 小调」就会变成问号，而且是**静默**的（JSON 结构不坏）。
      const child = spawn(HEARING_PYTHON, [
        HEARING_ANALYZER_FILE, '--serve',
        '--models-dir', HEARING_MODELS_DIR, '--cache-dir', HEARING_CACHE_DIR,
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      this.hearingWorkerBuf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.onHearingWorkerData(chunk));
      child.stderr?.on('data', (b: Buffer) => {
        const msg = b.toString('utf8').trim();
        if (msg) this.log?.warn(`唱词分析器：${msg.slice(-200)}`);
      });
      child.on('exit', (code) => {
        if (this.hearingWorker === child) this.hearingWorker = null;
        this.failHearingWorker(new Error(`分析器退出（code ${code ?? '?'}）`));
      });
      child.on('error', (error) => {
        if (this.hearingWorker === child) this.hearingWorker = null;
        this.failHearingWorker(error);
      });
      this.hearingWorker = child;
      return child;
    } catch (error) {
      this.hearingWorkerFails += 1;
      this.log?.warn(`分析器起不来：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private onHearingWorkerData(chunk: string): void {
    this.hearingWorkerBuf += chunk;
    let idx = this.hearingWorkerBuf.indexOf('\n');
    while (idx >= 0) {
      const line = this.hearingWorkerBuf.slice(0, idx).trim();
      this.hearingWorkerBuf = this.hearingWorkerBuf.slice(idx + 1);
      idx = this.hearingWorkerBuf.indexOf('\n');
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (msg?.ready) {
        this.hearingWorkerFails = 0;
        this.log?.info('唱词分析器已预热（模型常驻，单次深听少约 6 秒）');
        continue;
      }
      const pending = this.hearingWorkerPending;
      if (!pending) continue;
      this.hearingWorkerPending = null;
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  }

  /** 一次请求一个应答。超时或进程死了都返回 null，让上层退回一次性进程。 */
  private askHearingWorker(
    req: Record<string, unknown>,
    timeoutMs = 90_000,
  ): Promise<Record<string, unknown> | null> {
    const child = this.ensureHearingWorker();
    if (!child?.stdin) return Promise.resolve(null);
    if (this.hearingWorkerPending) this.failHearingWorker(new Error('上一个请求还没回来'));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.hearingWorkerPending = null;
        this.killHearingTree(child);
        if (this.hearingWorker === child) this.hearingWorker = null;
        this.hearingWorkerFails += 1;
        this.log?.warn(`分析器 ${Math.round(timeoutMs / 1000)} 秒没回，已杀掉重启`);
        resolve(null);
      }, timeoutMs);
      this.hearingWorkerPending = { resolve, reject: () => resolve(null), timer };
      try {
        child.stdin!.write(`${JSON.stringify(req)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.hearingWorkerPending = null;
        this.log?.warn(`给分析器发请求失败：${error instanceof Error ? error.message : String(error)}`);
        resolve(null);
      }
    });
  }

  private failHearingWorker(error: Error): void {
    const pending = this.hearingWorkerPending;
    if (!pending) return;
    this.hearingWorkerPending = null;
    clearTimeout(pending.timer);
    this.log?.warn(`分析器请求失败：${error.message}`);
    pending.reject(error);
  }

  /**
   * 杀整棵进程树。
   *
   * 这台机器上 venv 的 python.exe 是个壳（36352），真正的解释器是它拉起来的子进程（36188）。
   * 只 kill 壳的话解释器会变成孤儿继续跑——实测两个进程并存，一个 4MB、一个 718MB。
   * 所以 Windows 上统一走 taskkill /T。
   */
  private killHearingTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        return;
      } catch { /* 退化成普通 kill */ }
    }
    try { child.kill(); } catch { /* 已经退出 */ }
  }

  /** 关掉常驻进程。stop/dispose 里必须调，否则卸载扩展后它还挂在那儿吃内存。 */
  private stopHearingWorker(): void {
    const child = this.hearingWorker;
    this.hearingWorker = null;
    this.hearingWorkerPending = null;
    if (!child) return;
    try { child.stdin?.write('{"exit":1}\n'); } catch { /* 管道已经断了 */ }
    this.killHearingTree(child);
  }

  /**
   * 趁有歌在放的时候把模型热起来。
   *
   * 预热要 17 秒（读 131MB 权重 + 建 onnxruntime 会话）。放在启动瞬间会让开机更卡，
   * 放在第一次深听会让第一次回答多等 17 秒——都不对。有歌在放的时候机器本来就在忙，
   * 而且那正是她可能被问「仔细听听」的时刻，此时预热最划算。
   */
  private warmHearingWorker(): void {
    if (this.hearingWorker || this.hearingWorkerFails > 0) return;
    if (this.hearingMode() !== 'local') return;
    if (!this.localHearingReady()) return;
    this.ensureHearingWorker();
  }

  /** 分析器 JSON → 统一的切片结论。常驻和一次性两条路共用这一份，免得两处走样。 */
  private localDataToSlice(
    data: LocalAnalysis,
    ctx: { at: number; posSec: number | null; seconds: number },
  ): { ok: true; slice: HearingSlice } | { ok: false; reason: string } {
    if (!data.ok) return { ok: false, reason: `本机分析失败：${data.error || '没有给出原因'}` };
    const voices = Object.entries(data.stem_share ?? {})
      .filter(([, v]) => Number(v) >= 0.08)
      .map(([k]) => STEM_ZH[k] ?? k);
    return {
      ok: true,
      slice: {
        at: ctx.at,
        posSec: ctx.posSec,
        seconds: Number(data.duration_sec) || ctx.seconds,
        tonic: data.key || '不明确',
        // 「不明确」是分析器在置信度不够时的占位，不是和弦名。留着会拼出
        // 「和弦走向：不明确–F#–不明确」这种句子，她照着念就露馅了。
        chords: (data.chords ?? [])
          .map((c) => (c.chord ?? '').trim())
          .filter((c) => c && c !== '不明确'),
        melody: (data.melody?.notes ?? []).map((n) => n.note ?? '').filter(Boolean),
        voices,
        instruments: data.instruments ?? [],
        speech: data.speech?.ok && data.speech.text
          ? {
            text: data.speech.text,
            lang: data.speech.lang ?? '',
            langZh: data.speech.lang_zh ?? '',
            confident: data.speech.confident !== false,
            alt: data.speech.alt,
          }
          : null,
        summary: data.summary || '',
        source: 'local',
        latencySec: Number(data.elapsed_sec) || 0,
        loose: false,
      },
    };
  }

  /**
   * 听一次，拿一条切片结论。
   *
   * 两条路在这里分叉，上层不用知道走的是哪条。`hearingBusy` 是全局单飞锁：
   * 云端和本地共用同一个 request 文件和同一个 WAV，并发只会互相踩。
   */
  private async listenOnce(
    ctx: { at: number; posSec: number | null },
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string }> {
    const mode = this.hearingMode();
    if (mode === 'off') return { ok: false, reason: '深听关着（设置 → 一起听歌 → 深听方式）' };
    if (mode === 'local' && !this.localHearingReady()) {
      return {
        ok: false,
        reason: '本地深听还没装好（找不到本机分析器）。要么按 README 装一遍，约 500MB；'
          + '要么把「深听方式」切成云端，填个密钥就能用',
      };
    }
    // 云端没密钥就别去要切片了：要等探针切 12 秒（最多 9 秒）才轮到 cloudListen 说没 key，
    // 用户体感是"问一句卡十秒，然后说没配"。这一句必须放在最前面。
    if (mode === 'cloud' && !(this.cfg.hearingCloudKey ?? '').trim()) {
      return {
        ok: false,
        reason: '云端深听还没填密钥，所以听不了。要么填一个（设置 → 一起听歌 → 深听方式），'
          + '要么切成「本地」——本地要下约 500MB，但之后完全在本机跑、不联网',
      };
    }
    if (this.hearingBusy) return { ok: false, reason: '上一段还没分析完' };
    this.hearingBusy = true;
    const dir = dirname(AUDIO_OUT_FILE);
    const resultFile = join(dir, 'coopani-hearing.json');
    try {
      let cap = await this.captureWav();
      if (!cap.ok) return cap;
      let seconds = this.wavSeconds(cap.wav);
      if (seconds < MIN_SLICE_SEC) {
        // 采集进程刚重启时环形缓冲是空的，切出来只有两三秒 —— 拿这个算调性纯属瞎猜。
        // 宁可多等四秒重切一次：她这一句晚几秒，比说出一个错调子好。
        await new Promise((resolve) => setTimeout(resolve, 4500));
        const again = await this.captureWav();
        if (again.ok) {
          const longer = this.wavSeconds(again.wav);
          if (longer > seconds) { cap = again; seconds = longer; }
        }
      }
      if (mode === 'cloud') {
        return await cloudListen(cap.wav, {
          base: (this.cfg.hearingCloudBase ?? '').trim(),
          model: (this.cfg.hearingCloudModel ?? '').trim() || 'qwen-omni-turbo',
          key: (this.cfg.hearingCloudKey ?? '').trim(),
        }, { ...ctx, seconds });
      }
      return await this.localSlice(cap.wav, resultFile, { ...ctx, seconds });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      // **不留录音。** 云端上传完就删；本地那条路分析器自己删，这里再兜一次。
      for (const f of [join(dir, 'coopani-hearing.request'), join(dir, 'coopani-hearing.wav'), resultFile]) {
        try { if (existsSync(f)) unlinkSync(f); } catch { /* 下次再清 */ }
      }
      this.hearingBusy = false;
    }
  }

  /**
   * 拿这一句转写去和歌词对位。
   *
   * 只查内存里的歌词缓存（peek），**不触发抓取**：这条路径在回答链路上，
   * 不能为了校验去等一次网络。没有缓存就当「没词可对」，不作判断。
   *
   * 对不上不一定是她听错了——可能是时间轴偏了、也可能是抓到的歌词是另一个版本。
   * 但「当成原句引用」的风险比「说得含糊」大得多，所以对不上就降级成「不确定」。
   */
  private checkSpeechMatch(track: Track, slice: HearingSlice): void {
    const sp = slice.speech;
    if (!sp?.text) return;
    let doc: ReturnType<LyricStore['peek']> = undefined;
    try { doc = this.lyrics.peek(this.lyricInput(track)); } catch { doc = undefined; }
    if (!doc) {
      // 内存里还没有这首的词——**不等于这首没词**（2026-11-07 实测：同一首《后来》
      // 连续几条都 match，中间却冒出一条 no-lyric，就是这一下缓存没命中）。
      // 顺手把抓取排上队，下一段就能对上；这一条按「没法判断」处理，别下结论。
      if (this.cfg.lyricAware) void this.lyrics.ensure(this.lyricInput(track)).catch(() => null);
      sp.match = 'no-lyric';
      sp.confident = false;
      return;
    }
    if (doc.instrumental || !doc.lines?.length) {
      // 词库明确说这首没词。转写没人校对过，中英文唱段实测只有七成字准，
      // 拿它当原句引用等于替她编词。所以只许「隐约听到」。
      sp.match = 'no-lyric';
      sp.confident = false;
      return;
    }
    const pos = slice.posSec ?? 0;
    if (speechNorm(sp.text).length < 4) {
      // 三五个字判不了对位，宁可不判。
      sp.match = 'no-lyric';
      sp.confident = false;
      return;
    }
    // 切片是「此刻往前 12 秒」，所以真正唱过的词在 [pos-15, pos+3] 这段里。
    const near = doc.lines.filter((l) => {
      const d = Number(l.t) - pos;
      return d >= -15 && d <= 3;
    });
    let best: { text: string; score: number } | null = null;
    for (const l of near) {
      const score = speechSim(sp.text, String(l.text ?? ''));
      if (!best || score > best.score) best = { text: String(l.text ?? ''), score };
    }
    if (best && best.score >= 0.35) {
      // 对上了：这说明**时间轴没偏，她确实听到的正是这一句**。
      // 但转写本身的字是歪的（实测相似度 0.7 左右），所以引用时给歌词原文，
      // 转写原样留在 heard 里备查——「听到」这件事她负责，「写对字」交给歌词。
      sp.match = 'match';
      sp.heard = sp.text;
      sp.text = best.text.trim();
      sp.fromLyric = true;
      sp.confident = true;
    } else {
      sp.match = 'differ';
      sp.confident = false;
    }
  }

  /** 一条切片的正文：先说结论，再说结构，最后说这不是总谱。 */
  private sliceText(slice: HearingSlice, tail: string): string {
    const lines: string[] = [];
    lines.push(`深听结果（这一段）：${slice.summary || '分析器没给摘要，只有下面这些数'}`);
    const bits: string[] = [];
    if (slice.tonic && slice.tonic !== '不明确') bits.push(`调性 ${slice.tonic}`);
    // 「不明确」是占位不是和弦；云端也可能把这个词原样回过来。
    const chords = slice.chords.filter((c) => c && c !== '不明确');
    if (chords.length) bits.push(`和弦 ${chords.slice(0, 6).join('–')}`);
    if (slice.melody.length) bits.push(`主旋律 ${slice.melody.slice(0, 10).join('–')}`);
    if (slice.voices.length) bits.push(`声部 ${slice.voices.join('、')}`);
    const inst = slice.instruments.filter((i) => Number(i.score) >= 0.15).slice(0, 2);
    if (inst.length) bits.push(`乐器倾向 ${inst.map((i) => `${i.name}(${Number(i.score).toFixed(2)})`).join('、')}`);
    if (bits.length) lines.push(`· ${bits.join('｜')}`);
    const sp = slice.speech;
    if (sp?.text) {
      const marks = [sp.langZh || '语种不明'];
      if (sp.fromLyric) marks.push('听到的位置与歌词对上，引用的是歌词原文');
      else if (sp.match === 'differ') marks.push('与歌词对不上');
      else marks.push('无歌词可校对，转写会错字');
      lines.push(`· 人声轨转写（${marks.join('，')}）：「${sp.text}」`);
      if (sp.heard && sp.heard !== sp.text) lines.push(`· （转写原样：${sp.heard}）`);
    }
    if (slice.loose) lines.push('（云端没按格式答，只有一句描述，当参考）');
    lines.push(`（${tail}）`);
    return lines.join('\n');
  }

  /**
   * 按需深听。
   *
   * 探针内存里始终有最近 12 秒，收到 request 才写一个临时 WAV，读完即删。
   * 结果会并进这首的档案——所以每问一次，她的理解往前进一段，不是从头再来。
   */
  private async hearingText(): Promise<string> {
    if (!this.cfg.audioReactive) return '音频感知关着，深听听不到。开开「跟随系统声音」再用。';
    const st = this.tracker?.state();
    const track = st?.track;
    if (!track || !st?.playing) return '现在没在放，没得深听。';
    const key = trackKey(track);
    if (this.hearingCache && this.hearingCache.key === key && Date.now() - this.hearingCache.at < 20_000) {
      return `${this.hearingCache.text}（20 秒内刚听过，直接复用这次结果）`;
    }

    const res = await this.listenOnce({ at: Date.now(), posSec: st.posSec });
    if (!res.ok) {
      const before = this.hearingSheets.get(key);
      return `这次深听没做成：${res.reason}。${before ? `\n\n${sheetText(before)}` : ''}`;
    }
    this.checkSpeechMatch(track, res.slice);
    const sheet = this.hearingSheets.add(
      { trackKey: key, title: track.title ?? '', artist: track.artist ?? '' },
      res.slice,
    );
    const how = res.slice.source === 'cloud'
      ? `云端分析 ${res.slice.latencySec} 秒，音频没有落盘`
      : `本机分析 ${res.slice.latencySec} 秒，音频没有离开这台机器`;
    const lines = [this.sliceText(res.slice, `${how}；只有十几秒切片，不是整首总谱`)];
    const whole = sheetText(sheet);
    if (whole) lines.push(whole);
    if (res.slice.instruments.length && res.slice.instruments[0].score < 0.5) {
      lines.push('乐器分类置信度偏低，只说「倾向」，别当鉴定。');
    }
    const text = lines.join('\n\n');
    this.hearingCache = { key, at: Date.now(), text };
    return text;
  }

  /**
   * 边听边攒。
   *
   * 只有显式打开（`hearingEverySec > 0`）才跑：云端每段都是一次计费调用，
   * 默认不能悄悄替他花钱。跑在后台，不挡事件，也不挡跟拍。
   */
  /**
   * 这一场她说过的原话。
   *
   * 从桌宠自己的存档事件里读：每说一句 `pet_say`，桌宠写一条 `desktop-pet.self`，
   * `meta.kind === 'say'`，`text` 就是原话。这类事件**存储但不投递**，所以会话上下文里看不到，
   * 只能从事件库里捞——而这正好够用：判复读不需要她知道，只需要世界知道。
   *
   * 拿不到（老版本宿主、测试环境、事件被清）就返回空数组，调用方按「没重复」处理。
   */
  private recentSays(limit = 60): string[] {
    const store = this.host?.store;
    if (!store) return [];
    try {
      const since = this.tracker?.state().sessionStartedAt ?? 0;
      const rows = store.range({ senderKey: 'desktop-pet.self', limit });
      const out: string[] = [];
      for (const e of rows) {
        if (e.type !== 'desktop-pet.self') continue;
        if ((e.meta as { kind?: string } | undefined)?.kind !== 'say') continue;
        const at = e.ts ? Date.parse(e.ts) : 0;
        if (!at) continue;
        if (since && at < since) continue; // 只算这一场
        // 只算「对我这条事件说的话」：落在最近几次音乐推送之后 50 秒内的才算。
        // 不同场景混在同一场里（一边听歌一边打牌），不过滤的话牌名会被判成复读。
        // 还没推过任何事件时（刚启动）不过滤，全收。
        if (this.pushStamps.length && !this.pushStamps.some((t) => at >= t && at <= t + SAY_WINDOW_MS)) continue;
        if (typeof e.text === 'string' && e.text.trim()) out.push(e.text);
      }
      return out;
    } catch {
      return [];
    }
  }

  private maybeAutoHear(track: Track): void {
    this.warmHearingWorker();
    const every = Math.trunc(Number(this.cfg.hearingEverySec) || 0);
    if (every <= 0) return;
    // 用同一个判据：没密钥 / 本机没装，就别每分钟白跑一次（那一次要先等 9 秒切片）。
    if (!hearingUsable(this.hearingStatus())) return;
    if (!this.cfg.audioReactive) return;
    if (this.hearingBusy) return;
    const now = Date.now();
    const key = trackKey(track);
    // 能量变化量：这一首内部最近一段和前一段比。换歌时采样会清空，拿不到就 null。
    const drift = this.audioFeatures.drift();
    // 校准用：不管触不触发，每 15 秒记一次实测值。HEAR_DRIFT 是拍的，靠这个分布才能定。
    // 攒够几首之后按实际分位数改阈值（比如取 80 分位），然后把这条日志降成 debug。
    if (drift !== null && (!this.driftLogAt || now - this.driftLogAt >= 15_000)) {
      this.driftLogAt = now;
      this.log?.info(`能量变化量 drift ${drift.toFixed(3)}`);
    }
    const gate = autoHearDue(
      { key: this.autoHearKey, at: this.autoHearAt, lastAt: this.lastAutoHearAt },
      now,
      key,
      every,
      drift,
    );
    this.autoHearKey = gate.key;
    this.autoHearAt = gate.at;
    this.lastAutoHearAt = gate.lastAt;
    if (!gate.due) return;
    this.log?.info(
      `自动深听触发：${gate.why === 'drift' ? '声音在变' : '兜底到点'}（drift ${drift === null ? '未知' : drift.toFixed(3)}）`,
    );
    const posSec = this.tracker?.state().posSec ?? null;
    void this.listenOnce({ at: now, posSec })
      .then((res) => {
        if (!res.ok) {
          this.log?.info(`自动深听跳过：${res.reason}`);
          return;
        }
        this.checkSpeechMatch(track, res.slice);
        this.hearingSheets.add({ trackKey: key, title: track.title ?? '', artist: track.artist ?? '' }, res.slice);
        this.log?.info(`自动深听记了一段（${res.slice.source}）：${res.slice.tonic}／${res.slice.voices.join('、') || '声部不明'}`);
      })
      .catch((error: unknown) => {
        this.log?.warn(`自动深听出错：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private noteText(text: string): string {
    const trimmed = (text || '').trim();
    if (!trimmed) return '没有内容可记。';
    const clipped = trimmed.slice(0, 120);
    const st = this.tracker?.state() ?? null;
    this.store?.addNote(clipped, Date.now(), st?.track ?? null);
    return `记下了：${clipped}${st?.track ? `（贴着《${st.track.title}》）` : ''}`;
  }

  /* ================= 提示词与设置页 ================= */

  envPromptVars(): Record<string, string> {
    const tz = this.opts.timezone;
    const now = Date.now();
    const st = this.tracker?.state() ?? null;
    const today = localDay(tz, now);
    const records = this.store?.readDay(today) ?? [];
    const liveMs = st?.playing ? st.playedMs : 0;
    const notes = this.store?.notes(3) ?? [];

    let status: string;
    if (!this.tracker) {
      status = '听歌扩展还没启动。';
    } else if (st?.track && st.playing) {
      const label = playerLabel(st.track.app, this.cfg.extraPlayers);
      const loop = st.loopCount >= 2 ? `，这次收听里的第 ${st.loopCount} 遍` : '';
      status = `现在在放${quote(st.track, label)}${loop}。这一场已经连着听了 ${humanDuration(st.sessionPlayedMs)}`;
      if (st.segmentsSaid > 0) status += `，这一首你已经说过 ${st.segmentsSaid} 段`;
      if (this.lastTextAt) status += `（最后一次因此开口是 ${this.lastTextAt}）`;
      status += '。';
      status += this.audioPerceptionLine();
    } else if (st?.track) {
      status = `暂停中：${quote(st.track, playerLabel(st.track.app, this.cfg.extraPlayers))}。`;
    } else if (this.lastPick && !this.lastPick.session) {
      status = `现在没在放歌。${this.lastPick.reason ?? ''}。`;
    } else {
      status = '现在没在放歌。';
    }

    const todayLine = records.length
      ? `今天：已收尾 ${records.length} 首、${humanDuration(records.reduce((s, r) => s + (Number(r.ms) || 0), 0))}${liveMs ? '（另加正在放的这一首）' : ''}。`
      : (liveMs ? '今天：还没听完一首，现在这首在放。' : '今天：还没听完一首。');

    const wants = this.store.wants(5);
    const wantTotal = this.store.wantCount();
    const wantLine = !this.cfg.selfPick
      ? '（她自己挑歌的功能关着，清单不用管）'
      : (wants.length
        ? `想听清单（共 ${wantTotal} 首，新的在前）：\n${wants.map((w) => `· 《${w.title}》${w.artist ? ` — ${w.artist}` : ''}${w.why ? `｜${w.why}` : ''}`).join('\n')}`
        : '（想听清单还空着）');

    return {
      'music.status': status,
      'music.today': todayLine,
      'music.notes': notes.length
        ? notes.map((n) => `· ${n.text}${n.title ? `（${n.title}）` : ''}`).join('\n')
        : '（还没记过笔记）',
      'music.wants': wantLine,
      'music.pick': !this.cfg.selfPick
        ? '（现在不让你自己去搜歌挑歌，只评价他在放的）'
        : (this.cfg.pickWhen === 'idle'
          ? '你可以自己挑：没歌在放的时候，你也能主动去搜一首想听的，不用等他开口。'
          : '只在他说想听什么、或问你想听什么的时候去挑，别自己插播。'),
      'music.lyric': this.cfg.lyricAware
        ? '**歌词你看得到。** 事件里会附上这一段刚唱过的一两句，`music_lyric` 能现查更多。见下一节「歌词」。'
        : '**歌词你看不到。** 他关掉了「让她看歌词」这一项。关于词里讲了什么、哪一句怎么写——一个字都别说，那全是你编的。',
      // 她自己的口味档案：全文注入，限长在 soul.ts 里收。
      // 为什么整篇塞进系统前缀、而不是让她每次去调工具读：她"说不喜欢某类"这件事
      // 得在开口之前就在脑子里，等她想起来去查，那句话已经说出去了。
      'music.soul': soulForPrompt(readSoul(this.layout.memory)),
      // 深听这条路走不走得通，必须在开口之前就知道：不然她要么装作听得见，
      // 要么在他问"这首什么调"时临时扑空。
      'music.hearing': this.hearingStatusLine(),
    };
  }

  webUi(): WorldWebUiDecl {
    const lamps: WorldLamp[] = [];
    const bridge = this.bridge;
    const st = this.tracker?.state() ?? null;
    if (!bridge) {
      lamps.push({ label: '播放器', state: 'offline', hint: '还没启动过 —— 不用管，开个播放器放首歌它就会连上。' });
    } else {
      const h = bridge.health();
      const lag = h.lastLineAt === null ? null : Math.round((Date.now() - h.lastLineAt) / 1000);
      if (!h.exe) lamps.push({ label: '播放器', state: 'error', hint: '找不到系统自带的命令行宿主，读不到播放器。' });
      else if (!h.running) lamps.push({ label: '播放器', state: 'error', hint: h.lastError ?? '读取进程没有在跑。' });
      else if (lag === null) lamps.push({ label: '播放器', state: 'loading', hint: '正在连上系统媒体会话。' });
      else if (lag > 20) lamps.push({ label: '播放器', state: 'error', hint: `数据停在 ${lag} 秒前。` });
      else if (st?.playing && st.track) {
        lamps.push({ label: '播放器', state: 'online', hint: `${playerLabel(st.track.app, this.cfg.extraPlayers)} 在放《${st.track.title}》` });
      } else {
        lamps.push({ label: '播放器', state: 'online', hint: '在跑，现在没在放。' });
      }
      lamps.push(this.sourceLamp());
    }
    lamps.push(this.hearingLamp());
    /**
     * 形象包。这盏灯不报状态，是**说明**。
     *
     * 音乐这边比别处更该说：**她是跟着拍子动的**，而「跟着拍子动」不在宿主里 ——
     * 律动、蹦迪、打拍子、捂耳朵摇，全写在形象包的 `figure.js` 里。
     * 宿主 `act()` 碰到不认识的词只 `return false`：脸变、人不动、不报错。
     *
     * 为什么不放面板：宿主的 WebUI 是预构建的（`dist/web/`），面板 id 必须在前端源码里
     * 有对应组件、跑过 `pnpm build:web` 才算数。扩展声明一个前端没有的 id，
     * 界面上就是「面板产物中没有 figure」/「缺少面板构建产物」。
     * 灯的 `hint` 是悬停就能看全的纯文本 —— 这是首页上唯一能放长句、又不用动宿主前端的地方。
     */
    lamps.push({
      label: '形象包',
      state: 'online',
      hint: '她会跟着拍子摇头、蹦迪、捂着耳朵听 —— 那些动作不在宿主里，在形象包里，宿主认不出就丢掉。'
        + '装法：换装页「导入形象包」选 zip，或者把文件夹解压到 data/figures/<名字>/ 再在列表里选中它。'
        + '**装和用是两步**，只装不选等于没装。',
    });

    const tz = this.opts.timezone;
    const todayRecords = this.store?.readDay(localDay(tz, Date.now())) ?? [];
    const todayMs = todayRecords.reduce((sum, r) => sum + (Number(r.ms) || 0), 0);
    const days = this.store?.days() ?? [];
    const wantCount = this.store.wantCount();
    const badges = [
      { label: '今天', value: `${todayRecords.length} 首`, tone: todayRecords.length ? 'on' as const : 'off' as const },
      { label: '听了', value: todayMs > 0 ? humanDuration(todayMs) : '还没开始', tone: todayMs > 0 ? 'plain' as const : 'off' as const },
      { label: '想听', value: wantCount ? `${wantCount} 首` : '空的', tone: wantCount ? 'on' as const : 'plain' as const },
      { label: '记录', value: days.length ? `${days.length} 天` : '空的', tone: 'plain' as const },
    ];

    return {
      label: '一起听歌',
      lamps,
      badges,
      config: musicConfigGroups(),
      // 装形象包的入口。上面那盏灯说的是「装什么、为什么」，这里给「去哪儿装」——
      // 光有说明没有入口，等于让人自己找。`#/dress` 是应用内换装页。
      links: [{ label: '装形象包 → 换装页', href: '#/dress', inheritTheme: true }],
      storage: this.storageParts(),
      promptDocs: [{
        key: `worlds.${MUSIC_ID}.envPrompt`,
        title: '一起听歌提示词',
        description: '她怎么用播放器状态、七种事件和七个工具；改完不用重启，重建前缀即生效。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'music.status', description: '现在在放什么，或为什么读不到。' },
          { name: 'music.today', description: '今天的听歌量。' },
          { name: 'music.notes', description: '她之前记下的听歌笔记。' },
          { name: 'music.wants', description: '她自己搜出来、想听还没放的歌。' },
          { name: 'music.lyric', description: '歌词这一项开没开，以及看得到时该怎么用。' },
          { name: 'music.pick', description: '现在允许她挑歌到什么程度。' },
          { name: 'music.soul', description: '她自己的口味档案全文（四节：爱听 / 听听就算了 / 听不下去 / 还没想明白），不含统计；只记了爱听那一头时会带一句催办。' },
          { name: 'music.hearing', description: '深听走云端还是本地、能不能用、不能用时他该动哪里。' },
        ],
      }],
    };
  }

  /**
   * 数据源状态灯。
   *
   * 单独一个灯，因为"读得到"和"读得准"是两件事：QQ音乐走系统媒体会话，有进度、
   * 分得清暂停；网易云不注册会话，只能读窗口标题——同样在响，一个知道放到第几秒，
   * 一个不知道。这个差别以前只写在日志里，用户看不到，出问题时只能猜。
   */
  /**
   * 深听状态灯。
   *
   * 这一项的失败是**无声的**：她照常说话、照常跟拍，只是被问到「什么调」时只能回
   * 「听不了」。用户看到的差别只有一句话，所以必须有一盏灯说清是没配、还是没装。
   */
  private hearingLamp(): WorldLamp {
    const mode = this.hearingMode();
    if (mode === 'off') {
      return { label: '深听', state: 'offline', hint: '关着。只有拍子和响度，没有调性、和弦、旋律和乐器。' };
    }
    if (mode === 'local') {
      return this.localHearingReady()
        ? { label: '深听', state: 'online', hint: '本地：本机分轨，音频不出这台机器，也不联网。' }
        : {
          label: '深听',
          state: 'error',
          hint: `选了本地，但这台机器还没装好（找不到 ${HEARING_PYTHON}）。装一遍约 500MB，或者把「走哪条路」切成云端。`,
        };
    }
    const keySet = Boolean((this.cfg.hearingCloudKey ?? '').trim());
    return keySet
      ? {
        label: '深听',
        state: 'online',
        hint: `云端：${(this.cfg.hearingCloudModel ?? '').trim() || 'qwen-omni-turbo'}。十几秒的切片会上传到这个服务，分析完即删；不占本机空间。`,
      }
      : {
        label: '深听',
        state: 'error',
        hint: '云端还没填密钥，现在用不了。填一个，或者切成「本地」——本地要下载约 500MB，但之后完全在本机跑、不联网。',
      };
  }

  private sourceLamp(): WorldLamp {
    const sessions = this.bridge?.snapshot()?.sessions ?? [];
    const fallback = sessions.find((s) => s.via === 'title');
    if (fallback) {
      return {
        label: '数据源',
        state: 'online',
        hint: `${playerLabel(fallback.app, this.cfg.extraPlayers)} 不上报系统媒体会话，读的是窗口标题：没有进度，暂停靠推断。`,
      };
    }
    if (!sessions.length) {
      return { label: '数据源', state: 'online', hint: '系统媒体会话。现在没有任何播放器在放。' };
    }
    return { label: '数据源', state: 'online', hint: '系统媒体会话（有进度与播放状态）。' };
  }

  /**
   * 宿主动作补丁的状态灯。
   *
   * 这个补丁改的是**别人的包**，装到新机器上最常见的结局是静默失败：找不到宿主目录、
   * 锚点对不上、补了但要重启。三种在桌面上看起来一模一样 —— 她会开口，身体不动。
   * 所以在设置页给一盏灯，别让人去翻日志。
   */
  /**
   * 深听用不了时，让她自己说一句。
   *
   * 这一项的坏法是**安静**的：她照常聊歌、照常跟拍，只有被问到「什么调、什么乐器」时
   * 才扑空一句「听不了」。用户不会去看设置页那盏灯，所以得让桌宠开口。
   *
   * 四条限制，和动作补丁那条一样：
   * 1. **一天最多一次**；2. 不说成「坏了」；3. 说清两条路各要付什么代价；
   * 4. 推不出去也不能崩。
   */
  private hearingStatus(): HearingStatus {
    return {
      mode: this.hearingMode(),
      keySet: Boolean((this.cfg.hearingCloudKey ?? '').trim()),
      localReady: this.localHearingReady(),
      model: (this.cfg.hearingCloudModel ?? '').trim() || 'qwen-omni-turbo',
      asrReady: this.asrReady(),
    };
  }

  /** 唱词转写能不能用：本地这条路 + 配置里开着 + SenseVoice 模型在盘上。 */
  private asrReady(): boolean {
    if (this.cfg.asrEnabled === false) return false;
    if (this.hearingMode() !== 'local') return false;
    return existsSync(join(HEARING_MODELS_DIR, 'asr', 'sensevoice', 'model.int8.onnx'));
  }

  /**
   * 深听状态的事件：**能用也要说一次**。
   *
   * 宿主重启只恢复磁盘上的 system 消息，不重建前缀；所以升级完扩展、重启完 Core，
   * 老会话里的人手上还是旧提示词——她连"有深听"都不知道。2026-10-31 02:25 她答
   * 「还不算听清」，就是拿着 0.4.x 的提示词在诚实回答。
   *
   * 事件是唯一每轮必达的通道，所以：
   * 1. **能力变了就说**（模式切换、装好没装好），立刻；
   * 2. **能力没变就一天最多一次**——用来兜"换了新前缀之外的老会话"，不是说给新版听的。
   *    以前按构建号去重，等于每发一版就播一遍，纯噪音，已改；
   * 3. 说成「坏了」是错的，推不出去也不能崩。
   */
  private maybeNotifyHearing(): void {
    const status = this.hearingStatus();
    if (status.mode === 'off') return;
    const usable = hearingUsable(status);
    // 签名只描述"能不能听"，不含构建号：能力没变，发版不该让她再念一遍。
    const signature = `${status.mode}|${usable ? 'ok' : 'no'}`;
    const now = Date.now();
    const file = join(this.layout.local, 'music-hearing-notice.json');

    let saved: { lastAt?: number; announced?: string } = {};
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as { lastAt?: number; announced?: string };
    } catch { /* 没有记录，照常判 */ }
    const lastAt = Number(saved.lastAt) || this.hearingNotifiedAt;

    const changed = saved.announced !== signature;
    if (!changed && now - lastAt < 24 * 60 * 60 * 1000) return;

    const body = hearingNotice(status, BUILD_TAG);
    if (!body) return;

    this.hearingNotifiedAt = now;
    try {
      // 两种状态都记同一个签名：不记的话，不可用状态下每次启动都会判"变了"，
      // 于是绕过"一天一次"，重启三次就说三次。写签名才是让 24 小时那条成立的唯一办法。
      writeFileSync(file, JSON.stringify({ lastAt: now, announced: signature }, null, 2), 'utf8');
    } catch { /* 记不住也不阻塞这次提醒 */ }

    const host = this.host;
    if (!host) return;
    void host.pushEvent({
      type: 'music.hearing',
      ts: new Date(now).toISOString(),
      source: MUSIC_ID,
      text: `[${localClock(this.opts.timezone, now)}] ${body}`,
    }).catch((err: unknown) => {
      this.log?.warn(`深听提醒没推出去：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * 数据页签顶部那句「记忆存在哪」。
   *
   * 不写死"本机"两个字：这类设置最容易给人一个错误印象——他以为记忆已经在同步盘里，
   * 换台机器打开却是空的。所以三种状态分别说清：没配、配了能用、配了不能用。
   */
  private memoryWhereText(): string {
    const { memory, local, custom, problem } = this.layout;
    if (problem) return `⚠ ${problem}`;
    if (!custom) return '';
    return `记忆存在 ${memory}；本机旧记录（${local}）也一起读，不会因为换了位置就看不到以前的。`;
  }

  private storageParts(): StoragePart[] {
    const store = this.store;
    const vibes = this.vibes;
    // 记忆类文件的路径跟「记忆位置」走；歌词缓存与状态永远在本机（见 storage.ts 的头注释）。
    const mem = this.layout.memory;
    const where = this.memoryWhereText();
    const parts: StoragePart[] = [];
    if (store) {
      parts.push({
        key: 'listening',
        label: '听歌记录',
        kind: 'disk',
        location: join(mem, 'listening'),
        danger: true,
        note: [
          '每首听完的歌一行，一天一个文件。「最近听了什么」和「口味」都从这里读，清掉就查不到以前的。',
          where,
          store.degraded ? '⚠ 刚才有一次没写进去，已落到本机兜底：记忆位置这会儿可能连不上。' : '',
        ].filter(Boolean).join(' '),
        stat: () => {
          const days = store.days();
          if (!days.length) return '还没有记录。';
          const kb = Math.max(1, Math.round(store.sizeBytes() / 1024));
          return `${days.length} 天，合计约 ${kb} KB（含笔记）。`;
        },
        clear: () => {
          const n = store.clearDays();
          return n ? `删掉了 ${n} 天的记录。` : '本来就没有记录。';
        },
      });
      parts.push({
        key: 'notes',
        label: '听歌笔记',
        kind: 'disk',
        location: join(mem, 'music-notes.jsonl'),
        note: '她记下的、关于某首歌的句子。清掉之后她就不记得你说过什么了。',
        stat: () => {
          const n = store.noteCount();
          return n ? `${n} 条。` : '还没有笔记。';
        },
        clear: () => (store.clearNotes() ? '笔记已清空。' : '文件删不掉，可能被别的程序占着。'),
      });
      parts.push({
        key: 'wants',
        label: '想听清单',
        kind: 'disk',
        location: join(mem, 'music-wants.jsonl'),
        note: '她自己搜出来、想听还没放的歌，带上当时的原因和链接。清掉之后她就不记得欠你哪几首了。',
        stat: () => {
          const n = store.wantCount();
          return n ? `${n} 首。` : '还是空的。';
        },
        clear: () => (store.clearWants() ? '想听清单已清空。' : '文件删不掉，可能被别的程序占着。'),
      });
      parts.push({
        key: 'soul',
        label: '口味档案',
        kind: 'disk',
        location: soulPath(mem),
        // 不可恢复：清掉之后她就不"认识自己"了 —— 但它是可以重建的（听一阵再写回去），
        // 所以要和「听歌记录」区分开，note 里说清这两件事的差别。
        danger: true,
        note: [
          '她自己写的「我爱听什么」，第一人称，会整篇读进提示词 —— 她说话时的偏好就从这儿来。',
          // 用户问的就是这一条，所以写死在这里，而不是只写在 README 里：
          '**「听歌记录保留 90 天」那条清理只删 `listening/` 里的逐日文件，不会动这个文件。**',
          '它不在 listening/ 下面，也不按天存 —— 是长期的东西，不是日志。想改可以直接编辑它，她下次开口就按新的来。',
          where,
        ].filter(Boolean).join(' '),
        stat: () => {
          const n = soulLineCount(readSoul(mem));
          return n ? `${n} 条。` : '还一条没写。';
        },
        clear: () => resetSoul(mem).message,
      });
    }
    if (vibes) {
      parts.push({
        key: 'tags',
        label: '曲风档案',
        kind: 'disk',
        location: join(mem, 'music-tags.jsonl'),
        note: '她给听过的歌标的「路数」，标一次以后都按它换表情。清掉之后下一段会重新判断。',
        stat: () => (vibes.size ? `${vibes.size} 首标过。` : '还没标过。'),
        clear: () => {
          const n = vibes.clear();
          return n ? `清掉了 ${n} 首的标注。` : '本来就没标过。';
        },
      });
    }
    // 歌词缓存：**只标 danger: false**。
    // 它跟别的数据不是一类东西——听歌记录和笔记是她"记住的东西"，删了就是失忆；
    // 歌词是从公网随时能再抓一次的副本，删掉只影响下一段要不要重新联网。
    const lyricDir = join(this.opts.dataDir, 'lyrics');
    parts.push({
      key: 'lyrics',
      label: '歌词缓存',
      kind: 'disk',
      location: lyricDir,
      danger: false,
      note: '按这首歌查到的词，本机存一份免得每段都联网。删掉不会丢任何东西——下一段会重新去曲库取。',
      stat: () => {
        const { files, bytes } = this.lyrics.stat();
        if (!files) return '还没有缓存。';
        const kb = Math.max(1, Math.round(bytes / 1024));
        return `${files} 首，约 ${kb} KB。`;
      },
      clear: () => {
        const { files } = this.lyrics.clear();
        return files ? `清掉了 ${files} 首的词。` : '本来就没有缓存。';
      },
    });
    return parts;
  }

  /* ================= 状态落盘 ================= */

  private get statePath(): string {
    return join(this.opts.dataDir, STATE_FILE);
  }

  /**
   * 一次性纠偏：她以为鲸鱼只有八张脸。
   *
   * 来路查到了。这一节会话早先换形象时，系统发过一条"这些词用不了了 / 新增了以下"的变更通知，
   * 她的推理里留了一句"the figure changed to whale; vocabulary lacks thinking"，还自己整理出
   * "Available: happy, love, sad, nod, shake, wave, bow, flap"。从此她挑脸只在这八个里选，
   * 段事件写【思考】她回【开心】——五档曲风全塌成一张脸。ENV_PROMPT 里写清楚没用：她信的是
   * 那条"系统通知"。所以这里用同样的口吻发一条系统更正，一个数据目录只发一次。
   * 想再发一次，删掉 data 目录下的 vocab-hint.done 即可。
   */
  private vocabHint(): string {
    const flag = join(this.opts.dataDir, 'vocab-hint.done');
    if (existsSync(flag)) return '';
    try {
      writeFileSync(flag, new Date().toISOString(), 'utf8');
    } catch {
      return '';
    }
    return '（系统更正：你的词表不止八张脸。换形象时那条"这些词用不了了、新增了以下"，说的是'
      + '被换下去的那个形象，不是现在这张。现在这张鲸鱼的表里 19 个表情 + 18 个动作全在：'
      + '思考、得意、嘟嘴、疑惑、认真、星星眼、慌张、害怕、大哭、平静、眨眼都算数，写上去就会做。）';
  }

  private loadState(): {
    nightPushedDay?: string | null;
    longPushedSessionAt?: number | null;
    lastPlayingAt?: number | null;
    relay?: unknown;
  } | null {
    const file = this.statePath;
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  /** 去重水位落盘：重启后不该把"已经说过的深夜"再说一遍。节流写，别每秒一次。 */
  private saveState(force: boolean): void {
    const tracker = this.tracker;
    if (!tracker) return;
    const now = Date.now();
    if (!force && now - this.lastStateSaveAt < 15_000) return;
    this.lastStateSaveAt = now;
    try {
      writeFileSync(this.statePath, JSON.stringify({
        ...tracker.dump(),
        // 接力状态一起存：它是本机状态（"这根链子在哪一棒"），不是记忆。
        // 单独一个文件也行，但 state.json 已经存在、已经有节流写，多一个文件只多一处坏的机会。
        relay: this.relayState,
        savedAt: now,
      }, null, 2), 'utf8');
    } catch { /* 写不进去不影响听歌 */ }
  }
}
