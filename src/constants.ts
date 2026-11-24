import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultHearingHome, hearingPythonPath } from './platform.ts';
import type { Feel, Phase } from './vibe.ts';

/**
 * 面板上显示 / 反馈诊断里带的版本号。
 *
 * ⚠ **发版时跟 `package.json` 一起改。** 两处不一致会让人拿着错版本报障。
 * （life / journey / pz / 炉石都是这么做的 —— 同一个隐患，运行时读 package.json
 * 在打包后的路径里不可靠，暂时没有更好的办法。）
 */
export const PANEL_VERSION = '1.1.0';

/**
 * 随包带的形象包（`assets/figure-groove`）。
 *
 * 按本文件位置定位，理由和 `definition.ts` 里的 ENV_PROMPT 一样：用 `ctx.packageDir` 拼会
 * 指到 bot 的代码包去，不是这个扩展的目录。
 */
export const FIGURE_PACK_SOURCE = fileURLToPath(new URL('../assets/figure-groove', import.meta.url));

/** 构建标记。每次改行为都改一下——"改了没效果"和"改了改错了"靠它两秒分开。 */
export const BUILD_TAG = 'b2026-11-24.mac.93';

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
export const LYRIC_WAIT_MS = 2600;

/** 自己的提示词模板，按本文件位置定位。绝不能用 ctx.packageDir（那是 bot 的代码包目录）。 */
export const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
/** 系统声音的采集脚本与独立启动器（WASAPI 回环，往 TEMP 写 coopani-audio.json）。 */
export const AUDIO_PROBE_FILE = fileURLToPath(new URL('../assets/audio/probe.ps1', import.meta.url));
export const AUDIO_OUT_FILE = join(tmpdir(), 'coopani-audio.json');
/** 本地深听：分析器、Python 环境与模型都在本机，不经过云端。 */
export const HEARING_ANALYZER_FILE = fileURLToPath(new URL('../assets/hearing/analyze.py', import.meta.url));
/**
 * 本机深听环境装在哪。
 *
 * 必须**每台机器一个默认位置**，不能写死某一台的盘符——写死之后别人装上就是"找不到分析器"，
 * 而那句话说起来像扩展坏了。装在 `%LOCALAPPDATA%\CoopaniMusic\hearing`（和设置页推荐的记忆目录同源），
 * 一条安装脚本就能落到这个位置；老机器上已经在别处装好的，仍然认那两处旧路径。
 */
export const HEARING_HOME = (process.env.COOPANI_HEARING_HOME ?? '').trim()
  || defaultHearingHome(process.platform, homedir(), process.env);
/** 这个仓库最早在自己机器上装的那两处（2026-10-31）。只做兼容，不再写进文档。 */
export const LEGACY_HEARING_PYTHON = 'E:/Coopanion/data/hearing-venv/Scripts/python.exe';
export const LEGACY_HEARING_MODELS = 'E:/Coopanion/data/hearing/models';
const pickExisting = (preferred: string, legacy: string): string => {
  if (existsSync(preferred)) return preferred;
  return existsSync(legacy) ? legacy : preferred;
};
export const HEARING_PYTHON = (process.env.COOPANI_HEARING_PYTHON ?? '').trim()
  || pickExisting(hearingPythonPath(HEARING_HOME, process.platform), LEGACY_HEARING_PYTHON);
export const HEARING_MODELS_DIR = (process.env.COOPANI_HEARING_MODELS ?? '').trim()
  || pickExisting(join(HEARING_HOME, 'models'), LEGACY_HEARING_MODELS);
export const HEARING_CACHE_DIR = join(HEARING_MODELS_DIR, 'demucs');
/**
 * 换歌之后多久自动听第一段，也是两次分析之间的硬下限。
 *
 * 30 秒的理由：短于这个，切出来的常常还是上一首的尾巴；长于这个，一首三分钟的歌就只能听
 * 一段，走向（多了什么声部、调性动没动）永远拼不出来。这个数是照着"一首歌至少两段"倒推的。
 */
export const FIRST_HEAR_SEC = 30;

/**
 * 她回一条事件的窗口：推送之后这么久内说的话，才算「对这条事件的回应」。
 *
 * 复读检测要用它把音乐场景的句子从混场里挑出来。段事件间隔 40–50 秒，50 秒够覆盖她的回复
 * （实测她的 pet_say 都在推送后几秒内），又不至于把隔壁牌桌的话卷进来。
 */
export const SAY_WINDOW_MS = 50_000;

/**
 * 能量变化到多少就算「歌在动」，值得凑近听一段。
 *
 * `AudioFeatureAverages.drift()` 的返回值，五维归一化后的欧氏距离。
 */
export const HEAR_DRIFT = 0.17;

/**
 * 两次「因为声音在变」的深听之间，至少隔这么久。
 *
 * 没有这条，硬下限 30 秒一到、drift 又还高，就会连着跑 —— 实测 18:56:05 和 18:56:39
 * 两次分析几乎首尾相接，那一段 CPU 是被吃满的。
 */
export const HEAR_DRIFT_SEC = 60;

/** 本机分轨的英文轨名 → 中文。事件和回执里说人话。 */
export const STEM_ZH: Record<string, string> = {
  drums: '鼓', bass: '贝斯', other: '其他乐器', vocals: '人声', guitar: '吉他', piano: '钢琴',
};

export const STATE_FILE = 'music-state.json';

/**
 * 相位的中文说法。一律带"一带"两个字——这是按播放比例切出来的，不是波形分析出来的。
 * 写成"现在是副歌"就是吹牛：一首歌真正的高潮在哪，我们手上没有数据；写成"副歌一带"，
 * 她说话时就不会把话说死，说错了也不至于下不来台。
 */
export const PHASE_NOTE: Record<Phase, string> = {
  intro: '开场一带，还没进正题',
  verse: '主歌一带，力气还没上来',
  chorus: '副歌一带，这一首的高点',
  bridge: '桥段一带，下面要变',
  // 原本是「尾声一带，尾奏快了」。那个「快了」是个钩子：她每首到这儿都说一句「快到头了」，
  // 一晚上十次，八次的措辞只差一个字。段位是事实，催不催是她自己的事。
  outro: '尾声一带',
};

export const SEGMENT_ASK = [
  // 第 1 段只在长曲时才会推到（短曲的那一段在 onTick 里被跳过了）。
  '回一句：这首往后听下来的感觉。歌名和态度换歌时已经讲过了，别重复。',
  // 段 2（"说他"）不在这里——它按本场第几首轮换，见 TALK_ANGLES。
  '',
  '回一句：往后——下一首、还要听多久。句子讲完就停，别在末尾补一句保证（"我不催你""你随意""都行"这一类不算内容）。别只说"继续放""接着来"，那三个字你已经用过好几遍了；别宣告这首快完了，也别为自己的存在道歉。',
];

/** 隔多少首才许说一次"总共听了多少"。Mr.Q 要的是"一二十首"，取 18。 */
export const COUNT_MILESTONE = 18;

export const TALK_ANGLES = [
  '说今晚的量。数字可以用，但别写成"第 N 首，几点"这种并列报账，说成一句人话——他的耐性、他今晚没打算停。',
  '说过了多久。别报钟点，说"一个多小时"这种粗的，或者干脆只说你的感受。',
  '说人。他认准了谁、连着放同一个嗓子的样子，或者你注意到他手上的动作。',
];

export const MOVE_WORD: Record<string, string> = {
  bounce: '蹦迪',
  dance: '跳舞',
  groove: '律动',
  tap: '打拍子',
  enjoy: '闭眼听',
  stunned: '怔住',
  recoil: '退半步',
  hum: '跟着哼',
  cheer: '跟拍挥',
  sigh: '余韵',
  peek: '凑近听',
  humsit: '坐着哼',
  earcover: '捂耳朵听',
  hop: '小跳',
  jump: '跳',
  nod: '点头',
};

/** 三个坐姿动作。欢快的柔里一个都不给——坐下会让宿主掷那 60% 的睡意骰子。 */
export const SIT_MOVES = new Set(['enjoy', 'humsit', 'earcover']);

/** 段事件的例外：这两个是"反应"，几秒钟的事，什么时候用由她自己判断。 */
export const SEGMENT_SPECIAL = '另外两种可以例外：被某句词钉住就用【怔住】，听到不对劲就用【退半步】。';

/** 换歌事件的例外：一首听进去了的歌刚放完，那口气就是【余韵】。 */
export const TRACK_SPECIAL = '上一首要是听进去了，这一句也可以用【余韵】——整个人沉一下再起来。';

export const MOVE_FALLBACK: Record<Feel, readonly string[]> = {
  hard: ['cheer', 'bounce', 'dance', 'tap'],
  soft: ['peek', 'hum', 'humsit', 'earcover', 'enjoy', 'groove'],
  old: ['hum', 'tap', 'groove'],
  odd: ['groove', 'tap'],
  plain: ['tap', 'groove'],
};

export const MOVE_DEGRADE: Record<string, readonly string[]> = {
  bounce: ['dance', 'hop', 'jump'],
  groove: ['dance', 'nod'],
  tap: ['nod', 'dance'],
  enjoy: [],
  stunned: ['nod', 'shake'],
  recoil: ['shake', 'nod'],
  hum: ['nod', 'tap'],
  cheer: ['dance', 'wave'],
  sigh: ['bow'],
  peek: ['look', 'nod'],
  humsit: ['sit', 'nod'],
  earcover: ['sit', 'nod'],
};
