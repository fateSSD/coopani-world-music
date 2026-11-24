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
import { channels, killTreeSpec } from './platform.ts';
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
  speechNorm, speechSim, stateAngle, talkAngle, isLivelySoft, moveChoices, choiceText,
  setHostVocab, degradeMove, primaryMove, moveIdOf, fallbackMove, moveIdAny,
  moveCue, moveCueAny, skipSignal, recentDays, shortDay, quote,
} from './helpers.ts';
export * from './helpers.ts';


function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(Boolean(signal?.aborted));
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const hearingMethods: Record<string, any> = {
  /* ================= 深听：两条路，一份档案 ================= */

  hearingMode(): HearingMode { return hearingModeOf(this.cfg.hearingMode); },

  /** 本机那条路装好了没有。没装是「要下载约 500MB」，不是「坏了」。 */
  localHearingReady(): boolean {
    return existsSync(HEARING_PYTHON) && existsSync(HEARING_ANALYZER_FILE);
  },

  /** 给提示词用：现在走哪条路、能不能用、不能用时他该动哪里。 */
  hearingStatusLine(): string {
    return hearingStatusText(this.hearingStatus());
  },

  /** 切片真实长度。读 WAV 头，不按 48k 硬算——设备采样率不一定是 48k。 */
  wavSeconds(file: string): number {
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
  },

  /**
   * 让探针切一段。
   *
   * 请求文件是门控：探针平时一个字节都不写，看到这个文件才从环形缓冲里切 12 秒出来。
   * 9 秒等不到就放弃——多半是采集刚重启，干等只会让气泡更慢。
   */
  async captureWav(signal?: AbortSignal): Promise<{ ok: true; wav: string } | { ok: false; reason: string }> {
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    const dir = dirname(AUDIO_OUT_FILE);
    const request = join(dir, 'coopani-hearing.request');
    const wav = join(dir, 'coopani-hearing.wav');
    const quietRemove = (f: string) => { try { if (existsSync(f)) unlinkSync(f); } catch { /* 下次再清 */ } };
    quietRemove(request); quietRemove(wav);
    try {
      writeFileSync(request, '', 'utf8');
      const started = Date.now();
      while (Date.now() - started < 9000) {
        if (signal?.aborted) {
          quietRemove(request);
          quietRemove(wav);
          return { ok: false, reason: '已打断，本次深听取消' };
        }
        try {
          // 请求被消费、WAV 完整落盘，才算就绪。
          if (!existsSync(request) && existsSync(wav) && statSync(wav).size > 20_000) return { ok: true, wav };
        } catch { /* 文件正在换手 */ }
        if (await abortableSleep(150, signal)) {
          quietRemove(request);
          quietRemove(wav);
          return { ok: false, reason: '已打断，本次深听取消' };
        }
      }
      return { ok: false, reason: '没等到声音切片（采集可能刚重启，或者这会儿没在输出声音）' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },

  /** 本地那条路（兜底）：起一次性 Python 进程分轨，结果写文件再读回来。 */
  async localSliceOneShot(
    wav: string,
    resultFile: string,
    ctx: { at: number; posSec: number | null; seconds: number },
    signal?: AbortSignal,
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string }> {
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    const run = await new Promise<{ err: string; timedOut: boolean; aborted?: boolean }>((resolve) => {
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
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.killHearingTree(child);
        resolve({ err, timedOut: false, aborted: true });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        this.killHearingTree(child);
        resolve({ err, timedOut: true });
      }, 55_000);
      child.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ err: `${err}\n${e.message}`, timedOut: false });
      });
      child.on('exit', () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ err, timedOut: false });
      });
    });

    if (run.aborted || signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
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
  },

  /**
   * 本地深听：优先用常驻进程，失败再退回一次性进程。
   *
   * 常驻省掉每次约 6 秒的会话初始化（实测 19.9 秒 → 同进程 13.6 秒）；
   * 一次性那条留着当保险——预热崩了也不能让她听不了歌。
   */
  async localSlice(
    wav: string,
    resultFile: string,
    ctx: { at: number; posSec: number | null; seconds: number },
    signal?: AbortSignal,
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string }> {
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    const viaWorker = await this.localSliceViaWorker(wav, ctx, signal);
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    if (viaWorker) return viaWorker;
    return this.localSliceOneShot(wav, resultFile, ctx, signal);
  },

  /** 常驻进程那条路。返回 null = 这条走不通，让上层去兜底。 */
  async localSliceViaWorker(
    wav: string,
    ctx: { at: number; posSec: number | null; seconds: number },
    signal?: AbortSignal,
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string } | null> {
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    if (this.hearingWorkerFails >= 3) return null;
    const asrOn = this.cfg.asrEnabled !== false;
    const data = await this.askHearingWorker({
      wav,
      asr: asrOn,
      asr_cross: asrOn && this.cfg.asrCrossCheck ? (this.cfg.asrWhisperTier || 'medium') : '',
    }, 90_000, signal);
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    if (!data) return null;
    this.hearingWorkerFails = 0;
    return this.localDataToSlice(data as LocalAnalysis, ctx);
  },

  ensureHearingWorker(): ChildProcess | null {
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
  },

  onHearingWorkerData(chunk: string): void {
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
  },

  /** 一次请求一个应答。超时或进程死了都返回 null，让上层退回一次性进程。 */
  askHearingWorker(
    req: Record<string, unknown>,
    timeoutMs = 90_000,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const child = this.ensureHearingWorker();
    if (!child?.stdin) return Promise.resolve(null);
    if (this.hearingWorkerPending) this.failHearingWorker(new Error('上一个请求还没回来'));
    return new Promise((resolve) => {
      const finish = (val: Record<string, unknown> | null) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(val);
      };
      const onAbort = () => {
        clearTimeout(timer);
        this.hearingWorkerPending = null;
        this.killHearingTree(child);
        if (this.hearingWorker === child) this.hearingWorker = null;
        finish(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        this.hearingWorkerPending = null;
        this.killHearingTree(child);
        if (this.hearingWorker === child) this.hearingWorker = null;
        this.hearingWorkerFails += 1;
        this.log?.warn(`分析器 ${Math.round(timeoutMs / 1000)} 秒没回，已杀掉重启`);
        finish(null);
      }, timeoutMs);
      this.hearingWorkerPending = { resolve: (v) => finish(v), reject: () => finish(null), timer };
      try {
        child.stdin!.write(`${JSON.stringify(req)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.hearingWorkerPending = null;
        this.log?.warn(`给分析器发请求失败：${error instanceof Error ? error.message : String(error)}`);
        finish(null);
      }
    });
  },

  failHearingWorker(error: Error): void {
    const pending = this.hearingWorkerPending;
    if (!pending) return;
    this.hearingWorkerPending = null;
    clearTimeout(pending.timer);
    this.log?.warn(`分析器请求失败：${error.message}`);
    pending.reject(error);
  },

  /**
   * 杀整棵进程树。
   *
   * 这台机器上 venv 的 python.exe 是个壳（36352），真正的解释器是它拉起来的子进程（36188）。
   * 只 kill 壳的话解释器会变成孤儿继续跑——实测两个进程并存，一个 4MB、一个 718MB。
   * 所以 Windows 上统一走 taskkill /T（命令由 platform.ts 给）。
   * mac 上暂时退回 `child.kill()`：要杀整个进程组得在 spawn 时 detached，那是深听
   * 那一档的改动，P0 不动，先保证 Windows 收尸逻辑一字不变。
   */
  killHearingTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    const spec = killTreeSpec(pid, process.platform);
    if (spec) {
      try {
        spawnSync(spec.command, spec.args, { windowsHide: true });
        return;
      } catch { /* 退化成普通 kill */ }
    }
    try { child.kill(); } catch { /* 已经退出 */ }
  },

  /** 关掉常驻进程。stop/dispose 里必须调，否则卸载扩展后它还挂在那儿吃内存。 */
  stopHearingWorker(): void {
    const child = this.hearingWorker;
    this.hearingWorker = null;
    this.hearingWorkerPending = null;
    if (!child) return;
    try { child.stdin?.write('{"exit":1}\n'); } catch { /* 管道已经断了 */ }
    this.killHearingTree(child);
  },

  /**
   * 趁有歌在放的时候把模型热起来。
   *
   * 预热要 17 秒（读 131MB 权重 + 建 onnxruntime 会话）。放在启动瞬间会让开机更卡，
   * 放在第一次深听会让第一次回答多等 17 秒——都不对。有歌在放的时候机器本来就在忙，
   * 而且那正是她可能被问「仔细听听」的时刻，此时预热最划算。
   */
  warmHearingWorker(): void {
    if (this.hearingWorker || this.hearingWorkerFails > 0) return;
    if (this.hearingMode() !== 'local') return;
    if (!this.localHearingReady()) return;
    this.ensureHearingWorker();
  },

  /** 分析器 JSON → 统一的切片结论。常驻和一次性两条路共用这一份，免得两处走样。 */
  localDataToSlice(
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
  },

  /**
   * 听一次，拿一条切片结论。
   *
   * 两条路在这里分叉，上层不用知道走的是哪条。`hearingBusy` 是全局单飞锁：
   * 云端和本地共用同一个 request 文件和同一个 WAV，并发只会互相踩。
   */
  async listenOnce(
    ctx: { at: number; posSec: number | null }, signal?: AbortSignal,
  ): Promise<{ ok: true; slice: HearingSlice } | { ok: false; reason: string }> {
    const mode = this.hearingMode();
    if (mode === 'off') return { ok: false, reason: '深听关着（设置 → 一起听歌 → 深听方式）' };
    if (mode === 'local' && !this.localHearingReady()) {
      // mac 上还没有本地安装脚本，别让人去找一个不存在的 README 步骤
      if (!channels(process.platform).localHearing) {
        return {
          ok: false,
          reason: '这台系统还没有本地深听（macOS 版还在做）。把「深听方式」切成云端，填个密钥就能用',
        };
      }
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
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    if (this.hearingBusy) return { ok: false, reason: '上一段还没分析完' };
    this.hearingBusy = true;
    const dir = dirname(AUDIO_OUT_FILE);
    const resultFile = join(dir, 'coopani-hearing.json');
    try {
      let cap = await this.captureWav(signal);
      if (!cap.ok) return cap;
      if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
      let seconds = this.wavSeconds(cap.wav);
      if (seconds < MIN_SLICE_SEC) {
        // 采集进程刚重启时环形缓冲是空的，切出来只有两三秒 —— 拿这个算调性纯属瞎猜。
        // 宁可多等四秒重切一次：她这一句晚几秒，比说出一个错调子好。
        if (await abortableSleep(4500, signal)) {
          return { ok: false, reason: '已打断，本次深听取消' };
        }
        const again = await this.captureWav(signal);
        if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
        if (again.ok) {
          const longer = this.wavSeconds(again.wav);
          if (longer > seconds) { cap = again; seconds = longer; }
        }
      }
      if (mode === 'cloud') {
        const model = (this.cfg.hearingCloudModel ?? '').trim() || 'qwen-omni-turbo';
        const res = await cloudListen(cap.wav, {
          base: (this.cfg.hearingCloudBase ?? '').trim(),
          model,
          key: (this.cfg.hearingCloudKey ?? '').trim(),
        }, { ...ctx, seconds }, signal);
        if (res.usage) {
          try { this.host?.reportUsage?.(res.usage, { model, label: 'music:hearing' }); } catch { /* 忽略上报异常 */ }
        }
        return res;
      }
      return await this.localSlice(cap.wav, resultFile, { ...ctx, seconds }, signal);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      // **不留录音。** 云端上传完就删；本地那条路分析器自己删，这里再兜一次。
      for (const f of [join(dir, 'coopani-hearing.request'), join(dir, 'coopani-hearing.wav'), resultFile]) {
        try { if (existsSync(f)) unlinkSync(f); } catch { /* 下次再清 */ }
      }
      this.hearingBusy = false;
    }
  },

  /**
   * 拿这一句转写去和歌词对位。
   *
   * 只查内存里的歌词缓存（peek），**不触发抓取**：这条路径在回答链路上，
   * 不能为了校验去等一次网络。没有缓存就当「没词可对」，不作判断。
   *
   * 对不上不一定是她听错了——可能是时间轴偏了、也可能是抓到的歌词是另一个版本。
   * 但「当成原句引用」的风险比「说得含糊」大得多，所以对不上就降级成「不确定」。
   */
  checkSpeechMatch(track: Track, slice: HearingSlice): void {
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
  },

  /** 一条切片的正文：先说结论，再说结构，最后说这不是总谱。 */
  sliceText(slice: HearingSlice, tail: string): string {
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
  },

  /**
   * 按需深听。
   *
   * 探针内存里始终有最近 12 秒，收到 request 才写一个临时 WAV，读完即删。
   * 结果会并进这首的档案——所以每问一次，她的理解往前进一段，不是从头再来。
   */
  async hearingText(signal?: AbortSignal): Promise<string> {
    if (!this.cfg.audioReactive) return '音频感知关着，深听听不到。开开「跟随系统声音」再用。';
    const st = this.tracker?.state();
    const track = st?.track;
    if (!track || !st?.playing) return '现在没在放，没得深听。';
    const key = trackKey(track);
    if (this.hearingCache && this.hearingCache.key === key && Date.now() - this.hearingCache.at < 20_000) {
      return `${this.hearingCache.text}（20 秒内刚听过，直接复用这次结果）`;
    }

    const res = await this.listenOnce({ at: Date.now(), posSec: st.posSec }, signal);
    if (signal?.aborted) {
      return '已打断，本次深听取消。';
    }
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
  },

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
  recentSays(limit = 60): string[] {
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
  },

  maybeAutoHear(track: Track): void {
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
  },

};
