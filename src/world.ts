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
import { ensureFigurePack, type FigurePackResult } from './figure-pack.ts';

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
   */
  private async installFigurePack(): Promise<void> {
    try {
      this.figurePack = await ensureFigurePack({
        dataDir: this.opts.dataDir,
        sourceDir: FIGURE_PACK_SOURCE,
        installer: MUSIC_ID,
        log: this.log ?? undefined,
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
    // 那组动作只能由形象包提供。随包带了一份，装到桌宠找得到的地方（幂等，不抛错）。
    await this.installFigurePack();
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

  /* ================= 面板 ================= */

  private async panelInvoke(_panel: string, method: string, _args?: unknown): Promise<unknown> {
    if (method !== 'snapshot' && method !== '') {
      throw new Error(`没有这个方法：${method}`);
    }
    return this.panelSnapshot();
  }

  /**
   * 面板要的那一份。
   *
   * **只读**：这一页没有任何写操作。想让她记态度，走 `music_tag` 的 `verdict` 参数 ——
   * 那是她自己在听的时候下的判断，不该由面板上的按钮替她下。
   */
  private panelSnapshot(): Record<string, unknown> {
    const st = this.tracker?.state() ?? null;
    const track = st?.playing && st.track ? st.track : null;
    const ui = this.webUi();
    const tz = this.opts.timezone;
    const todayRecords = this.store?.readDay(localDay(tz, Date.now())) ?? [];
    const todayMs = todayRecords.reduce((sum, r) => sum + (Number(r.ms) || 0), 0);

    const vibe = track ? this.vibeOf(track) : null;
    /* 没说过就是没说过 —— **不拿 vibe 冒充态度**。 */
    const like = track && this.store ? this.store.likeOf(trackKey(track)) : null;
    const wants = this.store?.wants(8) ?? [];

    const feelText = vibe ? FEEL_TEXT[vibe.feel] : '';
    const verdictWord = like
      ? (like.verdict === 'like' ? '喜欢' : like.verdict === 'meh' ? '说不上' : '不喜欢')
      : '';

    const digest = [
      `版本 ${PANEL_VERSION}`,
      `播放器：${track ? playerLabel(track.app, this.cfg.extraPlayers) : (st ? '在跑，没在放' : '没连上')}`,
      track
        ? `这首：《${track.title || '未知'}》${track.artist ? ` - ${track.artist}` : ''}${feelText ? `（${feelText}${vibe?.genre ? ` · ${vibe.genre}` : ''}）` : ''}`
        : '这首：没在放',
      `态度：${verdictWord || '还没说过'}${like?.why ? `（${like.why}）` : ''}`,
      `想听：${wants.length} 首`,
      `今天：${todayRecords.length} 首${todayMs > 0 ? ` · ${humanDuration(todayMs)}` : ''}`,
      `灯：${(ui.lamps ?? []).map((l) => `${l.label} ${l.state}`).join(' / ')}`,
    ].join('\n');

    return {
      version: PANEL_VERSION,
      now: track
        ? {
          title: track.title || '未知曲目',
          artist: track.artist || '',
          album: track.album || '',
          app: playerLabel(track.app, this.cfg.extraPlayers),
          posSec: typeof st?.posSec === 'number' ? st.posSec : null,
          durSec: typeof st?.durSec === 'number' ? st.durSec : null,
        }
        : null,
      playerUp: Boolean(st),
      vibe: vibe
        ? {
          feel: vibe.feel,
          feelText,
          genre: vibe.genre,
          /* 这个认知从哪儿来：tag / album / artist / guess / audio / none。如实给，别装确定。 */
          source: vibe.source,
          reason: vibe.reason ?? '',
        }
        : null,
      like: like ? { verdict: like.verdict, word: verdictWord, why: like.why, at: like.ts } : null,
      wants: wants.map((w) => ({ title: w.title, artist: w.artist })),
      today: { count: todayRecords.length, msText: todayMs > 0 ? humanDuration(todayMs) : '' },
      lamps: ui.lamps ?? [],
      feedback: {
        repo: 'https://github.com/fateSSD/coopani-world-music',
        version: PANEL_VERSION,
        digest,
      },
    };
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

  private tagText(feel: string, genre: string, verdict = '', why = ''): string {
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
    /*
     * 态度单独存。**跟 `vibe` 不是一回事** —— `vibe` 是「这首是什么」，
     * 态度是「我要不要听」。一首可以又吵又不喜欢，也可以又吵又爱听。
     */
    let likeText = '';
    if (verdict) {
      const v = verdict.trim().toLowerCase();
      if (v === 'like' || v === 'meh' || v === 'no') {
        const r = this.store.addLike({
          key: trackKey(track),
          title: track.title,
          artist: track.artist,
          verdict: v,
          why: why.trim().slice(0, 60),
        }, Date.now());
        const word = v === 'like' ? '喜欢' : v === 'meh' ? '说不上' : '不喜欢';
        likeText = r.ok
          ? `态度也记下了：${word}${why.trim() ? `（${why.trim().slice(0, 60)}）` : ''}。`
          : '态度那句没写进文件（记忆目录不可写），听感倒是标上了。';
      } else {
        likeText = `态度只认 like / meh / no，你给的是「${verdict}」，这句没记。`;
      }
    }

    if (before && before.feel === feel && (before.genre ?? '') === clean) {
      // 老档案只有 key/feel：同标签重复标记时补齐学习字段，但不改变用户判断。
      if (!before.title || !before.artist || (!before.features && features)) {
        this.vibes.set(trackKey(track), clean, feel, Date.now(), meta);
      }
      return `${name}本来就是 ${label}，没变。${likeText}`;
    }
    this.vibes.set(trackKey(track), clean, feel, Date.now(), meta);
    return `${before ? '改了' : '记下了'}：${name} → ${label}。这一首后面的段按这个换表情；同专辑、同歌手与相似声音会逐步参考它。${likeText}`;
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
    /* 形象包。这一版报的是真状态 —— 为什么能报到，见 figureLamp 上面那段。 */
    lamps.push(this.figureLamp());

    const tz = this.opts.timezone;
    const todayRecords = this.store?.readDay(localDay(tz, Date.now())) ?? [];
    const todayMs = todayRecords.reduce((sum, r) => sum + (Number(r.ms) || 0), 0);
    const days = this.store?.days() ?? [];
    /* `?. ` 不是防御性编程 —— 这个方法的注释就写着「webUi() 可能在 start 之前被调（数据页签要读它）」。 */
    const wantCount = this.store?.wantCount() ?? 0;
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
      /*
       * 面板。之前不做的理由是「加面板要宿主前端有对应组件」——
       * 那条约束针对的是**声明一个前端里不存在的 panel id**。
       * 这次把 `webui/panel.js` 一起提供（`cortico.webUiClient`），
       * 声明和数据都在自己这边，不存在「产物里没有」的问题。
       */
      panels: [
        {
          id: 'now',
          title: '她此刻',
          description: '在放什么、她怎么听这首、她想听什么。',
        },
      ],
      invoke: (panel: string, method: string, args?: unknown) => this.panelInvoke(panel, method, args),
      config: musicConfigGroups(),
      // 装形象包的入口。上面那盏灯说的是「装什么、为什么」，这里给「去哪儿装」——
      /*
       * 光有说明没有入口，等于让人自己找。`#/dress` 是应用内换装页。
       *
       * ⚠ **前面那个 `/` 不能少**（2026-11-15）。宿主 `isSafeLinkHref()` 只放行
       * 「以 `/` 开头」或「能被 `new URL()` 解析」的 href；`'#/dress'` 两条都不满足，
       * 于是每次启动都报一条 `有 1 条链接的 href 不安全,已丢弃`，入口悄悄消失。
       */
      links: [{ label: '装形象包 → 换装页', href: '/#/dress', inheritTheme: true }],
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
   * 形象包灯。
   *
   * **上一版这盏灯是纯说明，因为它判断不了「装没装」。** 当时的结论是
   * 「`ctx.dataDir` 和 companion 那个 `data/figures/` 不是一个地方，读不到」——
   * 这条结论是错的。`ctx.dataDir` 就是部署的 `data` 目录**本身**：
   * 炉石把 `hearthstone-last-game.json` 写在它下面，这边把 `lyrics/` 写在它下面，
   * 桌宠的 `figures/` 也在那一层（`<部署>/data/figures/`）。
   * 所以现在装和报状态都能做。
   *
   * 唯一仍然报不出的是「用户在换装页**选没选**这个形象」—— 那要读
   * `worlds.desktop-pet.skin.figure`，是别人的配置段，不碰（市集同样要求别读）。
   * 所以这盏灯只敢说「装好了」，不敢说「她会动了」，并把「两步」讲清楚。
   */
  private figureLamp(): WorldLamp {
    const pack = this.figurePack;
    // 话都在 figure-pack.ts 里写 —— 两包共用一份文案，不在这里再编一遍。
    if (!pack) {
      return {
        label: '形象包',
        state: 'loading',
        hint: '随包带了一个形象包，启动时装进 data/figures/groove/。还没开始 —— 等她启动；'
          + '等不及就把扩展目录里的 assets/figure-groove 拷过去，再去换装页选。',
      };
    }
    const state = pack.status === 'failed' ? 'error' : pack.status === 'occupied' ? 'offline' : 'online';
    return { label: '形象包', state, hint: pack.message };
  }

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
