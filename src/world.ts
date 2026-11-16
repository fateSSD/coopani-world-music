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
import { ensureFigurePack, inspectFigurePack, type FigurePackResult } from './figure-pack.ts';

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

import {
  PANEL_VERSION, FIGURE_PACK_SOURCE, BUILD_TAG, LYRIC_WAIT_MS, ENV_PROMPT_FILE,
  AUDIO_PROBE_FILE, AUDIO_OUT_FILE, HEARING_ANALYZER_FILE, HEARING_HOME,
  LEGACY_HEARING_PYTHON, LEGACY_HEARING_MODELS, HEARING_PYTHON, HEARING_MODELS_DIR,
  HEARING_CACHE_DIR, FIRST_HEAR_SEC, SAY_WINDOW_MS, HEAR_DRIFT, HEAR_DRIFT_SEC,
  STEM_ZH, STATE_FILE, PHASE_NOTE, SEGMENT_ASK, COUNT_MILESTONE, TALK_ANGLES,
  MOVE_WORD, SIT_MOVES, SEGMENT_SPECIAL, TRACK_SPECIAL, MOVE_FALLBACK, MOVE_DEGRADE,
} from './constants.ts';
export * from './constants.ts';
import {
  EVENT_DECLS, EVENT_BY_KIND, NOW_DECL, HISTORY_DECL, TASTE_DECL, CONTROL_DECL,
  NOTE_DECL, TAG_DECL, PICK_DECL, SOUL_DECL, LYRIC_DECL, LISTEN_DECL, MUSIC_DESCRIBE,
} from './describe.ts';
export * from './describe.ts';

import {
  autoHearDue, type SayShape, sayShape, repeatHint, type LocalAnalysis,
  speechSim, stateAngle, talkAngle, isLivelySoft, moveChoices, choiceText,
  setHostVocab, degradeMove, primaryMove, moveIdOf, fallbackMove, moveIdAny,
  moveCue, moveCueAny, skipSignal, recentDays, shortDay, quote,
} from './helpers.ts';
export * from './helpers.ts';

import { toolMethods } from './world-tools.ts';
import { hearingMethods } from './world-hearing.ts';
import { webuiMethods } from './world-webui.ts';

export interface MusicWorldOptions {
  cfg: MusicConfigSection;
  dataDir: string;
  timezone: string;
  botName: string;
}

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
  /**
   * 随包带的形象包装到哪里了。
   *
   * 留在实例上而不是只打日志：`webUi()` 可能先于 `start()` 被调（数据页签要读它），
   * 灯得说得出「还没装 / 装好了 / 装失败」三种状态，不能假装。
   */
  private figurePack: FigurePackResult | null = null;

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

  /**
   * 把随包带的形象包装进 `figures/`。
   *
   * 幂等、不抛错 —— 装不上只是「她不能跟着拍子动」，听歌本身一步都不少。
   * 结果留在 `this.figurePack` 上给灯用：换装页不会告诉我们「选了没」，
   * 所以灯只能把「装和用是两步」说清楚，不能说成「已经会动了」。
   *
   * ⚠ **只从面板按钮调**（2026-11-16）。World 载入时调的是 `refreshFigurePack()`，
   * 官方要求「不要在载入时自动安装」（`cortico-extensions#659`）。
   */
  private async installFigurePack(): Promise<void> {
    try {
      this.figurePack = await ensureFigurePack({
        dataDir: this.opts.dataDir,
        sourceDir: FIGURE_PACK_SOURCE,
        installer: MUSIC_ID,
        log: this.log ?? undefined,
        // 面板按钮是明确的用户动作，同版本也重写一遍（包里坏了自己救）
        force: true,
      });
    } catch (error) {
      this.figurePack = {
        status: 'failed',
        dir: '',
        version: null,
        message: `装形象包时出了意外：${error instanceof Error ? error.message : String(error)}`,
      };
      this.log?.warn(this.figurePack.message);
    }
  }

  /**
   * 启动时只**看**，不装（2026-11-16）。
   *
   * 载入就写盘是市集明令禁止的那一类「使用者预期之外的行为」：他装了个听歌扩展，
   * 结果桌宠的 `data/figures/` 里多出一个包。现在改成面板上一个按钮，点了才装。
   *
   * 代价是灯里的状态要靠推断（版本、标记文件、有没有被占），不能靠「刚装过」，
   * 但那是准的：`inspectFigurePack` 和 `ensureFigurePack` 走同一套判据。
   */
  private async refreshFigurePack(): Promise<void> {
    try {
      this.figurePack = await inspectFigurePack({
        dataDir: this.opts.dataDir,
        sourceDir: FIGURE_PACK_SOURCE,
      });
    } catch (error) {
      this.figurePack = {
        status: 'failed',
        dir: '',
        version: null,
        message: `看形象包状态时出了意外：${error instanceof Error ? error.message : String(error)}`,
      };
      this.log?.warn(this.figurePack.message);
    }
  }

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
    // 那组动作只能由形象包提供。随包带了一份 —— 但**载入时不装**（2026-11-16）。
    // 只读一眼状态：装没装、是不是别人的、版本旧没旧。装的动作在面板按钮里。
    await this.refreshFigurePack();
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
        handler: async (args) => ({
          text: this.tagText(
            String(args.feel ?? ''),
            String(args.genre ?? ''),
            String(args.verdict ?? ''),
            String(args.why ?? ''),
          ),
        }),
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

  declare panelInvoke: any;
  declare panelSnapshot: any;
  declare lyricText: any;
  declare vibeOf: any;
  declare healthLine: any;
  declare nowText: any;
  declare historyText: any;
  declare tasteText: any;
  declare controlText: any;
  declare pickText: any;
  declare armRelay: any;
  declare relayCandidatesText: any;
  declare wishlistText: any;
  declare soulText: any;
  declare tagText: any;
  declare noteText: any;
  declare hearingMode: any;
  declare localHearingReady: any;
  declare hearingStatusLine: any;
  declare wavSeconds: any;
  declare captureWav: any;
  declare localSliceOneShot: any;
  declare localSlice: any;
  declare localSliceViaWorker: any;
  declare ensureHearingWorker: any;
  declare onHearingWorkerData: any;
  declare askHearingWorker: any;
  declare failHearingWorker: any;
  declare killHearingTree: any;
  declare stopHearingWorker: any;
  declare warmHearingWorker: any;
  declare localDataToSlice: any;
  declare listenOnce: any;
  declare checkSpeechMatch: any;
  declare sliceText: any;
  declare hearingText: any;
  declare recentSays: any;
  declare maybeAutoHear: any;
  declare envPromptVars: any;
  declare webUi: any;
  declare figureLamp: any;
  declare hearingLamp: any;
  declare sourceLamp: any;
  declare hearingStatus: any;
  declare asrReady: any;
  declare maybeNotifyHearing: any;
  declare memoryWhereText: any;
  declare storageParts: any;
}

Object.assign(MusicWorld.prototype, toolMethods, hearingMethods, webuiMethods);
