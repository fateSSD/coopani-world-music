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
import { channels, mediaSourceNoun, readerNoun, unavailableHint } from './platform.ts';
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


export const webuiMethods: Record<string, any> = {
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
  },

  webUi(): WorldWebUiDecl {
    const lamps: WorldLamp[] = [];
    const bridge = this.bridge;
    const st = this.tracker?.state() ?? null;
    if (!bridge) {
      lamps.push({ label: '播放器', state: 'offline', hint: '还没启动过 —— 不用管，开个播放器放首歌它就会连上。' });
    } else {
      const h = bridge.health();
      const lag = h.lastLineAt === null ? null : Math.round((Date.now() - h.lastLineAt) / 1000);
      if (!h.exe) {
        // 没接通时给的是这个平台的话：mac 上写「找不到 powershell」等于胡话
        const why = unavailableHint(process.platform);
        lamps.push({ label: '播放器', state: 'error', hint: why || '找不到系统自带的命令行宿主，读不到播放器。' });
      }
      else if (!h.running) lamps.push({ label: '播放器', state: 'error', hint: h.lastError ?? `${readerNoun()}没有在跑。` });
      else if (lag === null) lamps.push({ label: '播放器', state: 'loading', hint: `正在连上${mediaSourceNoun()}。` });
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
  },

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
  figureLamp(): WorldLamp {
    const pack = this.figurePack;
    // 话都在 figure-pack.ts 里写 —— 两包共用一份文案，不在这里再编一遍。
    if (!pack) {
      return {
        label: '形象包',
        state: 'loading',
        hint: '随包带了一个形象包，但载入时不装（装的动作要在面板上点）。点了之后装进 data/figures/groove/，'
          + '装完还得去换装页把她选成这个形象 —— 装好和用上是两步。',
      };
    }
    /* 未装（missing）和别人的包（occupied）都算「没启用」，不是故障；装失败才是故障。 */
    const state = pack.status === 'failed'
      ? 'error'
      : (pack.status === 'occupied' || pack.status === 'missing' ? 'offline' : 'online');
    return { label: '形象包', state, hint: pack.message };
  },

  /**
   * 深听状态灯。
   *
   * 这一项的失败是**无声的**：她照常说话、照常跟拍，只是被问到「什么调」时只能回
   * 「听不了」。用户看到的差别只有一句话，所以必须有一盏灯说清是没配、还是没装。
   */
  hearingLamp(): WorldLamp {
    const mode = this.hearingMode();
    if (mode === 'off') {
      return { label: '深听', state: 'offline', hint: '关着。只有拍子和响度，没有调性、和弦、旋律和乐器。' };
    }
    if (mode === 'local') {
      if (this.localHearingReady()) {
        return { label: '深听', state: 'online', hint: '本地：本机分轨，音频不出这台机器，也不联网。' };
      }
      // mac 上连安装脚本都还没有，说「装一遍约 500MB」等于让人去装一个不存在的东西
      if (!channels(process.platform).localHearing) {
        return {
          label: '深听',
          state: 'error',
          hint: '这台系统还没有本地深听（macOS 版还在做）。把「走哪条路」切成云端，填个密钥就能用。',
        };
      }
      return {
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
  },

  sourceLamp(): WorldLamp {
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
  },

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
  hearingStatus(): HearingStatus {
    return {
      mode: this.hearingMode(),
      keySet: Boolean((this.cfg.hearingCloudKey ?? '').trim()),
      localReady: this.localHearingReady(),
      model: (this.cfg.hearingCloudModel ?? '').trim() || 'qwen-omni-turbo',
      asrReady: this.asrReady(),
    };
  },

  /** 唱词转写能不能用：本地这条路 + 配置里开着 + SenseVoice 模型在盘上。 */
  asrReady(): boolean {
    if (this.cfg.asrEnabled === false) return false;
    if (this.hearingMode() !== 'local') return false;
    return existsSync(join(HEARING_MODELS_DIR, 'asr', 'sensevoice', 'model.int8.onnx'));
  },

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
  maybeNotifyHearing(): void {
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
  },

  /**
   * 数据页签顶部那句「记忆存在哪」。
   *
   * 不写死"本机"两个字：这类设置最容易给人一个错误印象——他以为记忆已经在同步盘里，
   * 换台机器打开却是空的。所以三种状态分别说清：没配、配了能用、配了不能用。
   */
  memoryWhereText(): string {
    const { memory, local, custom, problem } = this.layout;
    if (problem) return `⚠ ${problem}`;
    if (!custom) return '';
    return `记忆存在 ${memory}；本机旧记录（${local}）也一起读，不会因为换了位置就看不到以前的。`;
  },

  storageParts(): StoragePart[] {
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
  },

};
