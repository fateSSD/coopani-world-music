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
import { readerNoun, unavailableHint } from './platform.ts';
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


export const toolMethods: Record<string, any> = {
  /* ================= 面板 ================= */

  /**
   * 面板动作。
   *
   * `installFigure` 是**唯一**一个写动作（2026-11-16）。它存在的理由就是
   * 「装形象包要在用户点了之后才发生」—— 载入时自动装被官方点名要求去掉
   * （`cortico-extensions#659`）。别的动作一律只读。
   */
  async panelInvoke(_panel: string, method: string, _args?: unknown): Promise<unknown> {
    if (method === 'installFigure') {
      await this.installFigurePack();
      return this.panelSnapshot();
    }
    if (method !== 'snapshot' && method !== '') {
      throw new Error(`没有这个方法：${method}`);
    }
    return this.panelSnapshot();
  },

  /**
   * 面板要的那一份。
   *
   * **只读**：这一页没有任何写操作。想让她记态度，走 `music_tag` 的 `verdict` 参数 ——
   * 那是她自己在听的时候下的判断，不该由面板上的按钮替她下。
   */
  panelSnapshot(): Record<string, unknown> {
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
    const wantTotal = this.store?.wantCount() ?? 0;
    const liked = this.store?.likedTracks(10) ?? [];
    const likeTotal = this.store?.likedCount() ?? 0;

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
      `喜欢：${likeTotal} 首`,
      `想听：${wantTotal} 首`,
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
      likes: liked.map((x) => ({ title: x.title, artist: x.artist, why: x.why, at: x.ts })),
      likeTotal,
      wants: wants.map((w) => ({ title: w.title, artist: w.artist, why: w.why, url: w.url })),
      wantTotal,
      today: { count: todayRecords.length, msText: todayMs > 0 ? humanDuration(todayMs) : '' },
      lamps: ui.lamps ?? [],
      /* 形象包：面板上要有个「装」的按钮，就得知道现在是什么状态。 */
      figure: this.figurePack
        ? { status: this.figurePack.status, message: this.figurePack.message, dir: this.figurePack.dir }
        : null,
      feedback: {
        repo: 'https://github.com/fateSSD/coopani-world-music',
        version: PANEL_VERSION,
        digest,
      },
    };
  },

  /**
   * music_lyric 的回执。
   *
   * 回执里刻意**不写秒数**，只写"第几行 / 共几行"。写秒数她会念成"一分二十三秒"，
   * 那跟她自己的段报时叠在一起，就成了在报进度条。她要的是"唱到哪一句"。
   */
  async lyricText(ahead: number): Promise<string> {
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
  },

  /**
   * 这首歌按什么路数处理，优先级从高到低：
   * 同曲标签 → 同专辑/同歌手学习 → 字面弱判 → 声音近邻 → 未知。
   *
   * "她自己标的"永远优先：她认得出的歌，比"标题里有'钢琴'两个字"可靠得多。
   * 而且这样她改主意也有效——再标一次就覆盖。
   */
  vibeOf(track: Track): {
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
  },

  /* ---------- 工具回执正文 ---------- */

  healthLine(): string {
    const bridge = this.bridge;
    if (!bridge) return '数据源：还没启动。';
    const h = bridge.health();
    if (!h.exe) {
      const why = unavailableHint(process.platform);
      return why ? `数据源：${why}` : '数据源：这台机器找不到 powershell，读不到播放器。';
    }
    if (!h.running) return `数据源：${readerNoun()}没有在跑${h.lastError ? `（${h.lastError}）` : ''}。`;
    if (h.lastLineAt === null) return `数据源：${readerNoun()}刚起来，还没拿到第一份数据。`;
    const lag = Math.round((Date.now() - h.lastLineAt) / 1000);
    if (lag > 20) return `数据源：数据停在 ${lag} 秒前，可能播放器刚被关掉或系统媒体组件重启了。`;
    return `数据源正常（${lag} 秒前的采样${h.restarts ? `，重启过 ${h.restarts} 次` : ''}）。`;
  },

  nowText(): string {
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
  },

  historyText(days: number): string {
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
  },

  tasteText(days: number): string {
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
  },

  async controlText(action: string): Promise<string> {
    if (!this.cfg.controlAllowed) {
      return '使用者关掉了「允许她代为暂停/切歌」，所以没有按。需要的话让他在设置里打开。';
    }
    const allowed: ControlAction[] = ['pause', 'resume', 'next', 'prev'];
    if (!allowed.includes(action as ControlAction)) {
      return '没有指定动作。可用：pause（暂停）、resume（继续）、next（下一首）、prev（上一首）。';
    }
    const pick = this.lastPick;
    const match = pick?.session?.app ?? '';
    // mac 上没有「脚本自己回读」，得给一个立刻重读的口子；Windows 那侧用不到这个参数。
    const readBack = this.bridge?.readNow ? this.bridge.readNow.bind(this.bridge) : undefined;
    const result = await runControl(action as ControlAction, match, 10_000, readBack);
    if (!result.ok) {
      return `没能按下去：${result.error ?? '播放器拒绝了这次操作'}。${result.app ? `（${result.app}）` : ''}`;
    }
    const label = playerLabel(result.app ?? '', this.cfg.extraPlayers);
    const verb = { pause: '暂停', resume: '继续', next: '切到下一首', prev: '退回上一首' }[action as ControlAction];
    const now = result.title
      ? `现在 ${quote({ app: result.app ?? '', title: result.title, artist: result.artist ?? '', album: '' }, '')}，${statusText(result.status)}。`
      : `${statusText(result.status)}。`;
    return `已经在 ${label} 上${verb}了。${now}`;
  },

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
  async pickText(query: string, why: string, from = 0): Promise<string> {
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
    const recentlyPlayed = this.store.recentlyFulfilledWant(best, 6 * 3600_000, Date.now());
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
    if (saved.added && recentlyPlayed) {
      parts.push('（注意：这首几小时内刚听过并从想听里划掉过，重新挂回去了。）');
    }
    parts.push(arm);
    if (attempt.ok) parts.push(`已经在 ${sourceLabel(best.source)} 上放了。`);
    else parts.push(`${attempt.reason}。链接在这里，点开就能放：${best.url}`);
    if (problems.length) parts.push(`（${problems.join('；')}）`);
    return parts.join('');
  },

  /**
   * 记一棒：这一首是她递出去的。
   *
   * 落盘是**立刻**的（saveState(true)）。接力状态一丢，下一首快完时她就不会开口，
   * 而用户看到的是"连续点歌只连了一首就不动了"——这种错很难归到"状态没存住"上。
   */
  armRelay(pick: RelayPick): string {
    if (!this.cfg.relayPick) return '接力点歌关着，所以我不会跟着接下一棒。';
    const before = this.relayState;
    const next = relayArm(before, pick, Date.now(), RELAY_MAX_CHAIN);
    this.relayState = next;
    this.saveState(true);
    const fresh = next.startedAt !== before.startedAt;
    if (fresh) return `这一轮第一棒（最多 ${RELAY_MAX_CHAIN} 首）。`;
    return `这一轮第 ${next.count} 棒（最多 ${RELAY_MAX_CHAIN} 首）。`;
  },

  /**
   * 想听清单里还能接的几首，带编号。
   *
   * 编号不是装饰：`music_pick` 的 `from` 就是按这个号取的。让她对着清单文字自己数，
   * 数错一位就递了别的歌 —— 而这类错没有任何报错，只有"她忽然换了首无关的"。
   */
  relayCandidatesText(cur: Track): string {
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
  },

  /** 想听清单的文本版。没给关键词时走这条——比回一句"请给个关键词"有用。 */
  wishlistText(): string {
    const wants: WantItem[] = this.store.wants(10);
    if (wants.length === 0) return '想听清单还是空的（听过的会自动划掉）。给我一个关键词，我去搜一首。';
    const lines = [`想听清单（${this.store.wantCount()} 首，还没听过的，新的在前）：`];
    wants.forEach((w, i) => {
      const who = w.artist ? ` — ${w.artist}` : '';
      const why = w.why ? `｜${w.why}` : '';
      lines.push(`${i + 1}. 《${w.title}》${who}${why}`);
      if (w.url) lines.push(`   ${w.url}`);
    });
    return lines.join('\n');
  },

  /**
   * `music_soul` 的回执。
   *
   * 默认动作是读（不给参数）。写必须显式给 `add` + `section`，或者 `drop`。
   * **故意不提供"整篇覆写"**：这是全扩展唯一一个不可恢复的文件（逐日记录坏了只坏一行，
   * 笔记是追加），覆写一次就把她攒了几个月的东西抹平了。一条一条加，够用且安全。
   */
  soulText(args: Record<string, unknown>): string {
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
  },

  tagText(feel: string, genre: string, verdict = '', why = ''): string {
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
  },


  noteText(text: string): string {
    const trimmed = (text || '').trim();
    if (!trimmed) return '没有内容可记。';
    const clipped = trimmed.slice(0, 120);
    const st = this.tracker?.state() ?? null;
    this.store?.addNote(clipped, Date.now(), st?.track ?? null);
    return `记下了：${clipped}${st?.track ? `（贴着《${st.track.title}》）` : ''}`;
  },

};
