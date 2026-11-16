/**
 * 逻辑自检。跑法（用宿主自带的 tsx，扩展目录里没有 node_modules）：
 *   node "E:/Coopanion/resources/app/node_modules/tsx/dist/cli.mjs" --test test/music.test.mjs
 *
 * 重点覆盖两类最容易"看起来在跑"的错：
 * 1. 水位（第几遍、这一场多久）跨场不清零 → 第二场整场哑火；
 * 2. 配置项声明了却没接线 → 使用者改了没效果，还不报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ListeningTracker, isNightHour, localDay, seedPlayedMs, trackKey } from '../src/tracker.ts';
import { ListenStore, summarize } from '../src/history.ts';
import { NowPlayingBridge, parseTickLine } from '../src/nowplaying.ts';
import { pickSession, playerLabel } from '../src/players.ts';
import { bareTitle, describeTrack, pickBest } from '../src/picker.ts';
import { LyricStore, linesAt, linesFrom, matchScore, parseLrc, quoteLines, segmentLines } from '../src/lyrics.ts';
import { MUSIC_DEFAULTS, MUSIC_ID, musicConfigGroups } from '../src/config.ts';
import { MUSIC } from '../src/definition.ts';
import {
  PHASE_NOTE, SEGMENT_ASK, autoHearDue, choiceText, degradeMove, fallbackMove, isLivelySoft, moveChoices, moveCue, moveIdAny, moveIdOf, repeatHint, sayShape, setHostVocab, skipSignal, stateAngle, talkAngle,
} from '../src/world.ts';
import { readHostVocab } from '../src/host-vocab.ts';
import { isPeerRunning, resetPeerCache } from '../src/peer.ts';
import {
  EMPTY_RELAY, RELAY_LEAD_SEC, RELAY_MAX_CHAIN, relayArm, relayHolds, relayMarkFired, relayShouldFire, sanitizeRelay,
} from '../src/relay.ts';
import {
  SOUL_LINE_MAX, addSoulLine, dropSoulLine, ensureSoul, readSoul, resetSoul,
  soulForPrompt, soulGapNote, soulLineCount, soulSectionCounts,
} from '../src/soul.ts';
import {
  LONGFORM_NOTE, LONGFORM_SEC, VibeStore, emojiPool, guessFeel, isLongform, phaseOf, poolIds,
} from '../src/vibe.ts';

const snap = (title, artist, opts = {}) => ({
  app: opts.app ?? 'QQMusic.exe',
  status: opts.status ?? 'playing',
  title,
  artist,
  album: opts.album ?? '',
  posSec: opts.posSec ?? 0,
  durSec: opts.durSec ?? 200,
  canPlay: true, canPause: true, canNext: true, canPrev: true,
});

const T0 = Date.UTC(2026, 9, 25, 6, 0, 0); // 2026-10-25 14:00 GMT+8
const MIN = 60_000;

/** 按秒喂一条，收集所有 signal 的 kind 与正文关键值。 */
function makeTracker(over = {}) {
  return new ListeningTracker({ timezone: 'Asia/Shanghai', nightFrom: 23, longMinutes: 100, ...over });
}

/* ================= tracker ================= */

test('水位：连着三场，每一场的第一首都能被当成"开始"', () => {
  const t = makeTracker();
  // 第一场：进程刚起，首跳只认状态不出声
  assert.deepEqual(t.feed(T0, snap('A', 'X')).signals.map((s) => s.kind), []);
  // 静默 20 分钟后回来 —— 第二场
  let ts = T0 + 20 * MIN;
  assert.deepEqual(t.feed(ts, snap('A', 'X')).signals.map((s) => s.kind), ['start']);
  // 再静默一次 —— 第三场，仍然要能"开始"
  ts += 20 * MIN;
  assert.deepEqual(t.feed(ts, snap('B', 'Y')).signals.map((s) => s.kind), ['start', 'track'],
    '新一场 + 换了歌手，两件事都要有');
});

test('重启后的第一跳不喊"他开始听歌了"', () => {
  const t = makeTracker();
  const r = t.feed(T0, snap('A', 'X'));
  assert.equal(r.signals.length, 0, '第一跳分不清刚打开还是已经放了三小时，不该出声');
  assert.equal(t.state().track?.title, 'A', '状态还是要认下来');
});

test('同一首第 3 遍才算循环，且只报一次', () => {
  const t = makeTracker();
  const kinds = [];
  let ts = T0;
  const play = (title, artist, n = 1) => {
    for (let i = 0; i < n; i += 1) {
      ts += 30_000;
      kinds.push(...t.feed(ts, snap(title, artist)).signals.filter((s) => s.kind === 'loop').map((s) => s.count));
    }
  };
  play('A', 'X', 2);            // 第 1 遍
  play('B', 'X', 2);            // 换歌
  play('A', 'X', 3);            // 第 2 遍
  play('B', 'X', 2);
  play('A', 'X', 3);            // 第 3 遍 → 该报
  play('A', 'X', 2);
  assert.deepEqual(kinds, [3], `循环只报第 3 遍，实际 ${JSON.stringify(kinds)}`);
});

test('换场之后循环计数从 1 重新开始，不会因为上一场听过 3 遍就哑掉', () => {
  const t = makeTracker();
  let ts = T0;
  for (let i = 0; i < 3; i += 1) { ts += 30_000; t.feed(ts, snap('A', 'X')); }
  ts += 20 * MIN;
  const r = t.feed(ts, snap('A', 'X'));
  assert.ok(r.signals.some((s) => s.kind === 'start'));
  assert.ok(!r.signals.some((s) => s.kind === 'loop'), '新一场的第一遍不该算循环');
  assert.equal(t.state().loopCount, 1);
});

test('连续跳歌：5 分钟内 4 首短曲才报，报完清账', () => {
  const t = makeTracker();
  let ts = T0;
  t.feed(ts, snap('A', 'X'));
  const fidget = [];
  for (const title of ['B', 'C', 'D', 'E']) {
    ts += 10_000;                      // 每首只听了 10 秒
    const r = t.feed(ts, snap(title, 'Y'));
    fidget.push(...r.signals.filter((s) => s.kind === 'fidget').map((s) => s.skipped));
  }
  assert.deepEqual(fidget, [4], `应报一次 4 首，实际 ${JSON.stringify(fidget)}`);
});

test('深夜一天只报一次，跨天才能再报', () => {
  const night = Date.UTC(2026, 9, 25, 15, 30, 0); // 23:30 GMT+8
  const t = makeTracker();
  const r1 = t.feed(night, snap('A', 'X'));
  assert.ok(r1.signals.some((s) => s.kind === 'night'));
  const r2 = t.feed(night + 10 * MIN, snap('B', 'X'));
  assert.ok(!r2.signals.some((s) => s.kind === 'night'), '同一天不该报第二遍');
  const nextDay = night + 24 * 3600_000;
  const r3 = t.feed(nextDay, snap('C', 'X'));
  assert.ok(r3.signals.some((s) => s.kind === 'night'), '隔天要能再报');
});

test('久听一档只报一次，不停就一直不重复', () => {
  const t = makeTracker({ longMinutes: 30 });
  let ts = T0;
  const hits = [];
  t.feed(ts, snap('A', 'X'));
  for (let i = 0; i < 60; i += 1) {           // 60 秒一轮，共 60 分钟
    ts += 60_000;
    hits.push(...t.feed(ts, snap('A', 'X')).signals.filter((s) => s.kind === 'long').map((s) => s.minutes));
  }
  assert.equal(hits.length, 1, `只报一次，实际 ${JSON.stringify(hits)}`);
  assert.ok(hits[0] >= 30 && hits[0] <= 31, `分钟数应在 30 上下，实际 ${hits[0]}`);
});

test('暂停不计时；停太久把这一首结算掉', () => {
  const t = makeTracker();
  let ts = T0;
  t.feed(ts, snap('A', 'X'));
  ts += 60_000;
  t.feed(ts, snap('A', 'X'));                  // 听了 1 分钟
  assert.equal(t.state().playedMs, 60_000);
  for (let i = 0; i < 5; i += 1) {             // 暂停 5 分钟
    ts += 60_000;
    assert.equal(t.feed(ts, snap('A', 'X', { status: 'paused' })).finished, null);
  }
  assert.equal(t.state().playedMs, 60_000, '暂停期间不该继续累加');
  // 停超过一场：下次进来时把这一首结算
  const r = t.feed(ts + 20 * MIN, null);
  assert.ok(r.finished, '停太久要结算');
  assert.equal(r.finished.playedMs, 60_000);
  assert.equal(t.state().track, null);
});

test('isNightHour 的边界：23 点起、5 点止，填 2 不变成全天', () => {
  assert.equal(isNightHour(23, 23), true);
  assert.equal(isNightHour(0, 23), true);
  assert.equal(isNightHour(4, 23), true);
  assert.equal(isNightHour(5, 23), false);
  assert.equal(isNightHour(14, 23), false);
  assert.equal(isNightHour(2, 2), true);
  assert.equal(isNightHour(15, 2), false);
});

test('localDay 用部署时区，不跟着机器的 UTC 走', () => {
  const ts = Date.UTC(2026, 9, 24, 17, 0, 0); // 2026-10-25 01:00 GMT+8
  assert.equal(localDay('Asia/Shanghai', ts), '2026-10-25');
  assert.equal(localDay('UTC', ts), '2026-10-24');
});

/* ================= 播放器挑选 ================= */

test('两个播放器同时开着：auto 听正在放的，指定了就只听那一家', () => {
  const sessions = [snap('A', 'X', { app: 'cloudmusic.exe', status: 'paused' }), snap('B', 'Y', { app: 'QQMusic.exe' })];
  assert.equal(pickSession(sessions, { player: 'auto', extraPlayers: '' }).session.title, 'B');
  assert.equal(pickSession(sessions, { player: 'netease', extraPlayers: '' }).session.title, 'A');
  const qq = pickSession(sessions, { player: 'auto', extraPlayers: '' });
  assert.equal(qq.label, 'QQ音乐');
});

test('认不出的播放器：说清为什么读不到，不瞎认', () => {
  const r = pickSession([snap('A', 'X', { app: 'chrome.exe' })], { player: 'auto', extraPlayers: '' });
  assert.equal(r.session, null);
  assert.match(r.reason, /chrome\.exe/);
  // 填进额外播放器之后就认了
  const r2 = pickSession([snap('A', 'X', { app: 'chrome.exe' })], { player: 'auto', extraPlayers: 'chrome' });
  assert.equal(r2.session?.title, 'A');
  assert.equal(playerLabel('Spotify.exe', 'spotify'), 'Spotify');
});

/* ================= 解析 ================= */

test('解析脚本输出：中文歌名、错误行、垃圾行', () => {
  const ok = parseTickLine(JSON.stringify({
    ts: 1,
    sessions: [{ app: 'QQMusic.exe', status: 'Playing', title: '今宵多珍重', artist: '崔萍', album: '今宵多珍重', pos: 1.5, dur: 150, canNext: true }],
  }));
  assert.equal(ok.sessions[0].title, '今宵多珍重');
  assert.equal(ok.sessions[0].status, 'playing');
  assert.equal(ok.sessions[0].canNext, true);
  assert.deepEqual(parseTickLine('{"ts":1,"error":"boom"}'), { ts: 1, error: 'boom' });
  assert.equal(parseTickLine('not json'), null);
  assert.equal(parseTickLine('{"ts":1,"sessions":[]}').sessions.length, 0);
});

test('桥从文件取数据：新的推、半截的跳过、陈旧的丢掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-bridge-'));
  const out = join(dir, 'np.json');
  const got = [];
  const bridge = new NowPlayingBridge({
    outFile: out,
    // 脚本路径故意给不存在的：spawn() 会在 existsSync 那一步早退，不会真的起 powershell。
    // 这里要验的是 poll() 那一层，不是进程拉起的成功路径。
    scriptPath: join(dir, 'none.ps1'),
    onTick: (p) => got.push(p),
  });
  bridge.start();

  // mtime 在有些文件系统上只到秒，显式给递增的时间，测试才不会飘。
  let clock = Date.now();
  const put = (text) => {
    writeFileSync(out, text);
    clock += 1000;
    utimesSync(out, new Date(clock), new Date(clock));
  };
  const tick = (obj) => put(JSON.stringify(obj));

  tick({ ts: Date.now(), sessions: [{ app: 'QQMusic.exe', status: 'Playing', title: '今宵多珍重', artist: '崔萍', pos: 1.5, dur: 150 }] });
  bridge.poll();
  assert.equal(got.length, 1);
  assert.equal(got[0].sessions[0].title, '今宵多珍重');

  // 每秒写一次、每 250ms 读一次：没变就不能重复推，否则一句话会被说四遍。
  bridge.poll();
  assert.equal(got.length, 1, 'mtime 没变不该重复推');

  // 覆盖写的时候读者可能正好读到一半，这是正常现象，不是错误。
  put('{"ts":1,"sessions":[{"app":"QQM');
  bridge.poll();
  assert.equal(got.length, 1, '半截 JSON 不能当成一条数据');

  // Core 重启后读到的是上一次运行留下的文件。推出去她会说"几小时前在听某首歌"。
  tick({ ts: Date.now() - 3_600_000, sessions: [{ app: 'QQMusic.exe', status: 'Playing', title: '老歌', pos: 5, dur: 100 }] });
  bridge.poll();
  assert.equal(got.length, 1, '陈旧快照不能喂给世界层');

  tick({ ts: Date.now(), sessions: [{ app: 'QQMusic.exe', status: 'Playing', title: '新歌', pos: 9, dur: 100 }] });
  bridge.poll();
  assert.equal(got.length, 2);
  assert.equal(got[1].sessions[0].title, '新歌');

  bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

/* ================= 历史落盘 ================= */

test('历史：按天分行、坏行不影响读、超期文件被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-test-'));
  try {
    const store = new ListenStore(dir);
    const rec = { ts: T0, end: T0 + 120_000, app: 'QQMusic.exe', title: 'A', artist: 'X', album: '', ms: 120_000 };
    store.append('2026-10-25', rec);
    store.append('2026-10-25', { ...rec, ts: T0 + 200_000, end: T0 + 260_000, title: 'B', ms: 60_000 });
    assert.equal(store.readDay('2026-10-25').length, 2);

    const s = summarize(store.readDay('2026-10-25'));
    assert.equal(s.tracks, 2);
    assert.equal(s.ms, 180_000);
    assert.equal(s.artists[0].name, 'X');

    // 写个坏行进去，读的时候要能跳过
    store.append('2026-10-26', rec);
    const p = store.pathFor('2026-10-26');
    const text = readFileSync(p, 'utf8');
    writeFileSync(p, `${text}{ broken json\n`, 'utf8');
    assert.equal(store.readDay('2026-10-26').length, 1);

    assert.equal(store.prune(1), 1);
    assert.deepEqual(store.days(), ['2026-10-26']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('笔记：后写的在前，超长截断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-note-'));
  try {
    const store = new ListenStore(dir);
    store.addNote('第一句', T0, { app: 'QQMusic.exe', title: 'A', artist: 'X', album: '' });
    store.addNote('第二句', T0 + 1000, null);
    const notes = store.notes(5);
    assert.equal(notes[0].text, '第二句');
    assert.equal(notes[1].title, 'A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= 接力点歌 ================= */

const pickOf = (title, artist = 'X', durSec = 200) => ({
  title, artist, source: 'qq', url: `https://y.qq.com/${title}`, durSec,
});
const nowOf = (title, pos, dur = 200, artist = 'X', playedMs = 60_000) => ({
  title, artist, app: 'QQMusic.exe', posSec: pos, durSec: dur, playedMs,
});
/** 他真放了这一棒（relay 的记账）；不调它就是在测"递了没播"。 */
const played = (s) => ({ ...s, lastPlayed: true });

test('接力：连满上限就收，之后再点算新一轮而不是第 7 棒', () => {
  let s = null;
  for (let i = 1; i <= RELAY_MAX_CHAIN; i += 1) {
    s = played(relayArm(s, pickOf(`T${i}`), T0 + i * 1000));
  }
  assert.equal(s.count, RELAY_MAX_CHAIN);
  const again = relayArm(s, pickOf('T9'), T0 + 60_000);
  assert.equal(again.count, 1, '连满后再点，是一条新链的第一棒');
  assert.equal(again.firedFor, '', '新链要能重新提醒');
});

test('接力：递了没播的那一棒不占名额 —— 连挑三首也还是第一棒', () => {
  // 2026-10-29 实测：23:05 挑《钟》没播、23:12 又挑《No. 2》，链已经数到 2；
  // 照这个算法，连挑三首没播就假满了 6 首，之后再也不提醒，而用户看不到任何报错。
  let s = relayArm(null, pickOf('A'), T0);
  s = relayArm(s, pickOf('B'), T0 + 1000);
  s = relayArm(s, pickOf('C'), T0 + 2000);
  assert.equal(s.count, 1, '一次都没播过，就还是第一棒');
  assert.equal(s.last.title, 'C');
  // 真的播了之后，下一棒才 +1
  const after = relayArm(played(s), pickOf('D'), T0 + 3000);
  assert.equal(after.count, 2);
});

test('接力：隔太久（半小时）算新的一轮', () => {
  const s = relayArm(null, pickOf('A'), T0);
  const later = relayArm(s, pickOf('B'), T0 + 31 * 60_000);
  assert.equal(later.count, 1);
});

test('接力：只对她点的那首触发，剩 35 秒那一下，且同一棒只提醒一次', () => {
  const state = relayArm(null, pickOf('A'), T0);

  // 剩 60 秒：还不到时候（why 是空串 —— "正常还没到"不该当成异常刷日志）
  const early = relayShouldFire(state, T0 + 5000, nowOf('A', 140));
  assert.equal(early.fire, false);
  assert.equal(early.why, '');

  // 剩 35 秒：触发
  const v = relayShouldFire(state, T0 + 5000, nowOf('A', 200 - RELAY_LEAD_SEC));
  assert.equal(v.fire, true);
  assert.equal(v.remainSec, RELAY_LEAD_SEC);

  // 换一首他没点的歌：不触发 —— 不然她会对着别人的歌一直劝"接下一棒"
  assert.equal(relayShouldFire(state, T0 + 5000, nowOf('B', 165)).fire, false);

  // 这一棒已经递过：同一首不再劝第二遍
  const fired = relayMarkFired(state, 'A', 'X');
  assert.equal(relayShouldFire(fired, T0 + 6000, nowOf('A', 170)).fire, false);
});

test('接力：读不到进度就永远不触发 —— 网易云走窗口标题，没有秒数', () => {
  const state = relayArm(null, pickOf('A'), T0);
  const v = relayShouldFire(state, T0 + 60_000, {
    title: 'A', artist: 'X', app: 'cloudmusic.exe', posSec: null, durSec: null, playedMs: 60_000,
  });
  assert.equal(v.fire, false);
  assert.match(v.why, /进度/);
  // 曲长未知（只给了位置）也不猜
  assert.equal(relayShouldFire(state, T0 + 60_000, {
    title: 'A', artist: 'X', app: 'cloudmusic.exe', posSec: 100, durSec: null, playedMs: 60_000,
  }).fire, false);
  // 但"他到底放没放这首"仍然判得出来 —— 链才记得到账
  assert.equal(relayHolds({
    title: 'A', artist: 'X', app: 'cloudmusic.exe', posSec: null, durSec: null,
  }, state), true, '没有进度也要认得出是不是她点的那首');
});

test('接力：刚切过来的那一首先等五秒，不抢在"换歌了"前面喊快完了', () => {
  const state = relayArm(null, pickOf('A'), T0);
  // 剩 30 秒，但这一首才被看见 2 秒 —— 换歌那条事件可能还在等歌词没发出去
  const early = relayShouldFire(state, T0 + 5000, nowOf('A', 170, 200, 'X', 2000));
  assert.equal(early.fire, false);
  assert.equal(early.why, '', '这是"等一等"，不是异常，别写进日志');
  // 过了五秒就正常判
  assert.equal(relayShouldFire(state, T0 + 5000, nowOf('A', 170, 200, 'X', 6000)).fire, true);
});

test('接力：刚点开就判「快完了」不算数', () => {
  const state = relayArm(null, pickOf('A'), T0);
  // 80 秒的歌，放到 55 秒时剩 25 秒 —— 这是真听了一会儿，该触发
  assert.equal(relayShouldFire(state, T0 + 1000, nowOf('A', 55, 80)).fire, true);
  // 而 20 秒以内的歌直接排除：铃声/试听片段没有"最后一段"
  assert.equal(relayShouldFire(state, T0 + 1000, nowOf('A', 15, 50)).fire, false);
});

test('接力状态：坏数据读回来不炸，没歌名的 last 当成没有', () => {
  assert.deepEqual(sanitizeRelay(null), EMPTY_RELAY);
  assert.deepEqual(sanitizeRelay({}), EMPTY_RELAY);
  const b = sanitizeRelay({ count: 3, lastPlayed: true, last: { title: 'A' }, lastAt: 'x' });
  assert.equal(b.count, 3);
  assert.equal(b.last.title, 'A');
  assert.equal(b.last.url, '', '缺字段给空串，不要 undefined');
  assert.equal(b.lastAt, 0);
  assert.equal(b.lastPlayed, true);
  // 没写这个字段＝没播过 —— 宁可让她下一棒顶替，也别假满
  assert.equal(sanitizeRelay({ last: { title: 'A' } }).lastPlayed, false);
  assert.equal(sanitizeRelay({ lastPlayed: true }).lastPlayed, true);
  assert.equal(sanitizeRelay({ last: {} }).last, null);
  // 0.4.0 之前写下的状态里没有 lastPlayed：那时候 count 数的是"她递了几次"，不可信，
  // 直接读回来当第 1 棒 —— 已经假满到 6 的链会因此重新能用。
  assert.equal(sanitizeRelay({ count: 5, last: { title: 'A' } }).count, 1);
});

/* ================= 口味档案（潜意识文件） ================= */

test('口味档案：建骨架、加一条、重复不加、删一条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-soul-'));
  try {
    const s0 = ensureSoul(dir);
    assert.match(s0, /## 我确实爱听/);
    assert.match(s0, /## 我听不下去的/);
    assert.equal(soulLineCount(s0), 0, '骨架里不该有内容行');

    const r1 = addSoulLine(dir, 'love', '肖邦的夜曲我一遍不够');
    assert.equal(r1.ok, true);
    assert.match(r1.message, /我确实爱听/);
    assert.equal(soulLineCount(readSoul(dir)), 1);

    // 同一句再写一次不该变成两条：她换个说法就说"重复"的话，这文件很快就没人看
    const r2 = addSoulLine(dir, 'love', '肖邦的夜曲我一遍不够');
    assert.match(r2.message, /已经有这条/);
    assert.equal(soulLineCount(readSoul(dir)), 1);

    // 超长的截断
    addSoulLine(dir, 'hate', '这段话说得很长'.repeat(12));
    for (const line of readSoul(dir).split('\n').filter((l) => l.startsWith('- '))) {
      assert.ok(line.length <= SOUL_LINE_MAX + 3, `条目太长（${line.length} 字）：${line}`);
    }

    const r3 = dropSoulLine(dir, '肖邦');
    assert.equal(r3.ok, true);
    assert.equal(soulLineCount(readSoul(dir)), 1);
    assert.doesNotMatch(readSoul(dir), /肖邦/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 「只记了喜欢的那一半」的守卫。
 *
 * 2026-11-03 Mr.Q 的原话：「她的听歌清单里只有喜欢的，没有其他三种，要把规则收紧一点」。
 * 事实：music-soul.md 里 love 2 条，另外三节全空。脏话（嫌弃）只说在气泡里，第二天什么都不剩。
 *
 * 这条测试钉住三件事：四节分别计数；只有 love 攒到两条以上才催；三节里有一条就不再催
 * （催过头会逼她编一条来交差，那比空着更坏）。
 */
test('口味档案：只记爱听那一头时要催，催办不许给出成句的判断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-soul-gap-'));
  try {
    const empty = ensureSoul(dir);
    assert.match(empty, /四节都要用/, '骨架里没写"四节都要用"，她照旧只往 love 里堆');
    assert.deepEqual(soulSectionCounts(empty), { love: 0, tolerate: 0, hate: 0, unsure: 0 });

    // 一条的时候不催：一条还看不出偏向，催了像逼她交作业
    addSoulLine(dir, 'love', '肯收着嗓子的我才信');
    assert.equal(soulGapNote(readSoul(dir)), '');

    addSoulLine(dir, 'love', '慢慢把一件事说完的歌我听得进去');
    const gap = soulGapNote(readSoul(dir));
    assert.match(gap, /另外三节/, '只记了爱听那一头却不催，等于这个口子没堵');
    assert.match(gap, /别为了填满编/, '没写"别编"就会凑数，凑出来的口味比空着更坏');
    assert.doesNotMatch(gap, /^-/, '催办里不许出现可直接照抄的判断');

    // 三节里落了任何一条就不催
    addSoulLine(dir, 'hate', '喊到底的那种我坐不住');
    assert.equal(soulGapNote(readSoul(dir)), '');
    assert.equal(soulSectionCounts(readSoul(dir)).hate, 1);
    assert.equal(soulSectionCounts(readSoul(dir)).love, 2);

    // 催办要真的进提示词正文，否则她根本看不见
    const onlyLove = ensureSoul(dir);
    assert.match(soulForPrompt(onlyLove), /另外三节|还一条没写/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('口味档案：一节装满了就先删再加，不无限堆成流水账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-soul-max-'));
  try {
    ensureSoul(dir);
    for (let i = 0; i < 12; i += 1) assert.equal(addSoulLine(dir, 'tolerate', `第 ${i} 条`).ok, true);
    const over = addSoulLine(dir, 'tolerate', '第十三条');
    assert.equal(over.ok, false);
    assert.match(over.message, /装不下/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('90 天清理只删 listening/ 里的逐日记录，口味档案一个字都不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-prune-'));
  try {
    const store = new ListenStore(dir);
    const rec = (title) => ({ ts: T0, end: T0 + 1000, app: 'QQMusic.exe', title, artist: 'X', album: '', ms: 1000 });
    store.append('2026-07-01', rec('A'));
    store.append('2026-07-02', rec('B'));
    store.append('2026-10-25', rec('C'));

    addSoulLine(dir, 'love', '我对钢琴独奏没有抵抗力');
    const before = readSoul(dir);
    assert.ok(before.includes('钢琴独奏'));

    // 只留最近 2 天 —— 走的就是启动时那条 prune
    const removed = store.prune(2);
    assert.equal(removed, 1);
    assert.equal(store.days().length, 2, '留下的应该是最新两天');
    assert.ok(!store.days().includes('2026-07-01'), '最旧那天该被删掉');
    assert.equal(readSoul(dir), before, '清理听歌记录把口味档案也改了');
    assert.equal(soulLineCount(readSoul(dir)), 1);

    // 设置页那个「清除听歌记录」也不能连它一起清
    store.clearDays();
    assert.equal(readSoul(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('口味档案：清空只剩骨架，文件本身还在（下次不会再长出一份）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-soul-reset-'));
  try {
    addSoulLine(dir, 'love', '一类歌');
    addSoulLine(dir, 'hate', '另一类歌');
    assert.equal(soulLineCount(readSoul(dir)), 2);
    const r = resetSoul(dir);
    assert.equal(r.ok, true);
    assert.match(r.message, /2 条/);
    assert.equal(soulLineCount(readSoul(dir)), 0);
    assert.match(readSoul(dir), /## 我确实爱听/, '骨架还在，不是把文件删了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= 配置与提示词的一致性 ================= */

test('设置页的每个键都是 worlds.music.* 绝对路径', () => {
  const groups = musicConfigGroups();
  const keys = groups.flatMap((g) => Object.keys(g.schema.properties));
  assert.ok(keys.length >= 8);
  for (const key of keys) {
    assert.ok(key.startsWith(`worlds.${MUSIC_ID}.`), `键没带前缀会落到 config.json 根部：${key}`);
  }
  for (const g of groups) assert.equal(g.owner, `world:${MUSIC_ID}`);
});

test('每个配置项都有读取点（声明 ≠ 接线）', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const src = readdirSync(srcDir)
    .filter((f) => f.startsWith('world') && f.endsWith('.ts'))
    .map((f) => readFileSync(new URL(f, srcDir), 'utf8'))
    .join('\n');
  const fields = Object.keys(MUSIC_DEFAULTS()).filter((f) => f !== 'enabled');
  for (const field of fields) {
    const used = new RegExp(`(this\\.)?cfg\\.${field}\\b`).test(src);
    assert.ok(used, `${field} 在 schema 里声明了，但 world*.ts 从来没读过它`);
  }
});

test('提示词里的 {{占位符}} 与 envPromptVars 的键逐字对上', () => {
  const prompt = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'music-var-'));
  const world = MUSIC.create({
    id: MUSIC_ID, cfg: MUSIC_DEFAULTS(), timezone: 'Asia/Shanghai', botName: 'probe',
    botDir: dir, packageDir: dir, dataDir: dir, repoRoot: dir,
    secret: () => '', storeSecret: () => {}, persist: () => {}, restart: async () => {},
  });
  const declared = new Set(
    (world.webUi().promptDocs ?? []).flatMap((d) => (d.vars ?? []).map((v) => v.name)),
  );
  const runtime = new Set(Object.keys(world.envPromptVars()));
  const placeholders = [...prompt.matchAll(/\{\{\s*([a-z0-9._-]+)\s*\}\}/gi)].map((m) => m[1]);
  assert.ok(placeholders.length >= 3);
  for (const p of placeholders) {
    assert.ok(declared.has(p), `模板里有 {{${p}}},但 vars 没声明 —— 渲染出来是个空`);
    assert.ok(runtime.has(p), `模板里有 {{${p}}},但运行时没给值 —— 渲染出来是个空`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('工具与自描述一致；每个工具名带 music_ 前缀', () => {
  const def = MUSIC.describe;
  assert.deepEqual(def.tools.map((t) => t.name), ['music_now', 'music_history', 'music_taste', 'music_control', 'music_note', 'music_tag', 'music_pick', 'music_lyric', 'music_soul', 'music_listen']);
  for (const t of def.tools) assert.match(t.name, /^music_/);
  assert.equal(def.events.length, 10, '8 个播放事件 + music.setup（环境不对）+ music.hearing（深听听不了）');
  for (const e of def.events) assert.match(e.type, /^music\./);
});

test('进度不可信时不补时长；合理时只给这一场的第一首补', () => {
  assert.equal(seedPlayedMs({ posSec: 223, durSec: 263 }), 223_000);
  assert.equal(seedPlayedMs({ posSec: 150, durSec: 150 }), 0, '进度等于总时长，多半是暂停态的假值');
  assert.equal(seedPlayedMs({ posSec: 2, durSec: 200 }), 0);
  assert.equal(seedPlayedMs({ posSec: null, durSec: 200 }), 0);

  const t = makeTracker();
  t.feed(T0, snap('A', 'X', { posSec: 223, durSec: 263 }));
  assert.equal(t.state().playedMs, 223_000, '第一首是听到一半才被看见的，要按进度补');
  let ts = T0 + 10_000;
  t.feed(ts, snap('B', 'X', { posSec: 3, durSec: 200 }));   // 正常换歌，从 0 起算
  assert.equal(t.state().playedMs, 0, '第二首不该再按进度补，墙钟本来就准');
});

test('两个脚本必须是 UTF-8 带 BOM', () => {
  // PS 5.1 读无 BOM 的 UTF-8 会按系统 ANSI 解码：中文变乱码，甚至报"字符串缺少终止符"。
  // 这个坑不报错，只让回执里的中文变成外星文，所以用断言盯着。
  for (const name of ['nowplaying.ps1', 'control.ps1']) {
    const buf = readFileSync(new URL(`../scripts/${name}`, import.meta.url));
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 没有 BOM`);
  }
});

test('trackKey 区分同歌名不同歌手', () => {
  assert.notEqual(trackKey({ app: 'a', title: 'A', artist: 'X', album: '' }), trackKey({ app: 'a', title: 'A', artist: 'Y', album: '' }));
});

/* ================= 陪听节拍（每 30~60 秒一段） ================= */

test('短歌：3 分半切 3 段，段长跟着时长走，最后一段留白', () => {
  const t = makeTracker();                       // 默认 45 秒下限 / 最多 3 段
  let ts = T0;
  t.feed(ts, snap('A', 'X', { durSec: 210 }));
  const hits = [];
  for (let i = 0; i < 210; i += 1) {
    ts += 1000;
    hits.push(...t.feed(ts, snap('A', 'X', { durSec: 210 })).signals.filter((s) => s.kind === 'segment'));
  }
  assert.equal(hits.length, 3, `3 分半最多说 3 段，实际 ${hits.length}`);
  assert.deepEqual(hits.map((h) => h.index), [1, 2, 3], '段号必须从 1 连上去');
  assert.equal(hits[0].fromSec, 0);
  assert.ok(hits[0].toSec >= 30 && hits[0].toSec <= 60, `第 1 段要在 30~60 秒内触发，实际 ${hits[0].toSec}`);
  for (let i = 1; i < hits.length; i += 1) {
    const gap = hits[i].toSec - hits[i - 1].toSec;
    // (210-45)/3 = 55，±15 抖动
    assert.ok(gap >= 39 && gap <= 71, `第 ${i + 1} 段走了 ${gap} 秒，偏出 55±15`);
    assert.equal(hits[i].fromSec, hits[i - 1].toSec, '段与段之间不能有空隙，否则位置对不上');
  }
  assert.ok(hits.at(-1).toSec <= 195, '最后一段不能压到结尾，尾奏要留白');
});

test('长曲：15 分钟的古典不按 45 秒切，照样只说 3 段', () => {
  const t = makeTracker();
  let ts = T0;
  t.feed(ts, snap('A', 'X', { durSec: 900 }));
  assert.ok(Math.abs(t.segLen(1, 900) / 1000 - 45) <= 15, '第 1 段照旧 45 秒，不能让他等四分钟');
  assert.ok(Math.abs(t.segLen(2, 900) / 1000 - 285) <= 15, '(900-45)/3=285 秒');
  assert.equal(t.segLen(4, 900), Infinity, '第 4 段不存在');
  const marks = [];
  for (let i = 0; i < 900; i += 1) {
    ts += 1000;
    marks.push(...t.feed(ts, snap('A', 'X', { durSec: 900 })).signals.filter((s) => s.kind === 'segment').map((s) => s.toSec));
  }
  assert.equal(marks.length, 3, `15 分钟也只该有 3 段，实际 ${marks.length}`);
  assert.ok(marks[0] <= 60, `第 1 段必须早，实际 ${marks[0]} 秒`);
  assert.ok(marks[2] <= 800, `第 3 段要留出结尾，实际 ${marks[2]} 秒`);
});

test('曲长未知时退回下限，仍然守住段数上限', () => {
  const t = makeTracker();
  let ts = T0;
  t.feed(ts, snap('A', 'X', { durSec: null }));
  assert.ok(Math.abs(t.segLen(1, null) / 1000 - 45) <= 15, '不知道多长就按 45 秒');
  let segs = 0;
  for (let i = 0; i < 600; i += 1) {
    ts += 1000;
    segs += t.feed(ts, snap('A', 'X', { durSec: null })).signals.filter((s) => s.kind === 'segment').length;
  }
  assert.equal(segs, 3, '再长也不会超过上限');
});

test('段长按「曲目+段号」定死：同一首歌来回听，段边界不漂', () => {
  const a = makeTracker();
  const b = makeTracker();
  const lens = (t) => [1, 2, 3].map((i) => { t.feed(T0, snap('A', 'X')); return t.segLen(i); });
  assert.deepEqual(lens(a), lens(b), '同一首同样的段号，长度必须一样，否则她的时间感会漂');
  const other = makeTracker();
  other.feed(T0, snap('B', 'Y'));
  assert.notDeepEqual([1, 2, 3].map((i) => other.segLen(i)), lens(a), '换了歌就该换一套节奏');
});

test('听到一半才被看见（重启），不会冒出"第 1 段（0:00 → …）"', () => {
  const t = makeTracker();
  // 274 秒的歌已经放到 190 秒：前两个段点无论如何都过了。
  t.feed(T0, snap('A', 'X', { posSec: 190, durSec: 274 }));
  const said = t.state().segmentsSaid;
  assert.ok(said >= 2, `190 秒至少越过两段，实际 ${said}`);

  const hits = [];
  let ts = T0;
  for (let i = 0; i < 90; i += 1) {
    ts += 1000;
    hits.push(...t.feed(ts, snap('A', 'X', { durSec: 274 })).signals.filter((s) => s.kind === 'segment'));
  }
  assert.ok(!hits.some((h) => h.index === 1), '不该凭空冒出第 1 段');
  for (const h of hits) {
    assert.ok(h.index > said, `段号要接在已折算的 ${said} 之后，实际 ${h.index}`);
    assert.ok(h.fromSec > 0, `区间起点不能是 0:00，实际 ${h.fromSec}`);
  }
});

test('起来的第一跳只对账：不推段事件，也不会隔两秒补一条', () => {
  const t = makeTracker();
  const r = t.feed(T0, snap('A', 'X', { posSec: 190, durSec: 274 }));
  assert.deepEqual(r.signals.map((s) => s.kind), [], '第一跳分不清刚拉起还是放了很久，不该出声');
  assert.ok(t.state().segmentsSaid >= 2, '段号还是要按进度折算');
  let ts = T0;
  for (let i = 0; i < 6; i += 1) {
    ts += 1000;
    const segs = t.feed(ts, snap('A', 'X', { durSec: 274 })).signals.filter((s) => s.kind === 'segment');
    assert.equal(segs.length, 0, `第 ${i + 2} 跳就冒段事件，等于一重启就说话`);
  }
  assert.equal(t.state().playing, true, 'lastPlayingAt 必须写进去，否则下一跳会把整场重置');
});

test('段长填 0 就完全不切段', () => {
  const t = makeTracker({ segmentEverySec: 0 });
  assert.equal(t.segLen(1), Infinity);
  let ts = T0;
  t.feed(ts, snap('A', 'X'));
  let segs = 0;
  for (let i = 0; i < 180; i += 1) {
    ts += 1000;
    segs += t.feed(ts, snap('A', 'X')).signals.filter((s) => s.kind === 'segment').length;
  }
  assert.equal(segs, 0, '关掉之后一条都不该有');
});

test('换歌把段计数清零；暂停期间不产生段', () => {
  const t = makeTracker();
  let ts = T0;
  t.feed(ts, snap('A', 'X'));
  for (let i = 0; i < 100; i += 1) { ts += 1000; t.feed(ts, snap('A', 'X')); }   // 100 秒 → 至少 1 段
  const said = t.state().segmentsSaid;
  assert.ok(said >= 1, '100 秒该说过至少一段');

  for (let i = 0; i < 300; i += 1) {                                          // 暂停 5 分钟
    ts += 1000;
    const r = t.feed(ts, snap('A', 'X', { status: 'paused' }));
    assert.equal(r.signals.filter((s) => s.kind === 'segment').length, 0, '暂停时还在切段就是错的');
  }
  assert.equal(t.state().segmentsSaid, said, '暂停不该推进段号');

  ts += 1000;
  t.feed(ts, snap('B', 'Y'));
  assert.equal(t.state().segmentsSaid, 0, '换歌要从第 1 段重新数');
});

/* ================= 推送策略 ================= */

/** 造一个只用来调 shouldSpeak 的世界实例（跑完要删临时目录）。 */
function probeWorld(cfgOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'music-say-'));
  const world = MUSIC.create({
    id: MUSIC_ID,
    cfg: { ...MUSIC_DEFAULTS(), enabled: true, ...cfgOver },
    timezone: 'Asia/Shanghai', botName: 'probe',
    botDir: dir, packageDir: dir, dataDir: dir, repoRoot: dir,
    secret: () => '', storeSecret: () => {}, persist: () => {}, restart: async () => {},
  });
  return { world, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('每一首换歌都推：不看歌手、不设冷却', () => {
  const { world, cleanup } = probeWorld();
  try {
    const track = { app: 'QQMusic.exe', title: 'T', artist: '同一个人', album: '' };
    // 同一歌手连着五首、全部落在同一秒——上一版会被 artistChanged 和十分钟冷却逐条吃掉。
    for (let i = 0; i < 5; i += 1) {
      assert.equal(
        world.shouldSpeak({ kind: 'track', track, prev: track, indexInSession: i + 2, artistChanged: false, prevPlayedMs: 180_000 }),
        true,
        `第 ${i + 1} 次换歌被闸掉了`,
      );
    }
  } finally { cleanup(); }
});

test('安静档仍然只留深夜和久听，段事件不推', () => {
  const { world, cleanup } = probeWorld({ chatiness: 'quiet' });
  try {
    assert.equal(world.shouldSpeak({ kind: 'segment' }), false);
    assert.equal(world.shouldSpeak({ kind: 'track' }), false);
    assert.equal(world.shouldSpeak({ kind: 'night' }), true);
    assert.equal(world.shouldSpeak({ kind: 'long' }), true);
  } finally { cleanup(); }
});


/* ================= 听感层：路数与位置 ================= */

/** 形象词表的完整副本。换了形象要对一遍——写错的表情会被静默丢掉，失败是看不见的。 */
/**
 * 形象词表夹具，抄自 Coopanion 里鲸鱼形象的 figure.json（vocab 段的 id + names.zh）。
 *
 * 为什么落成本地文件而不是每次去读宿主的 figure.json：扩展要能单独跑测试。
 * 但词表是会随形象改的，所以另有一条测试在能读到宿主 figure.json 时对一遍账——
 * 名字对不上就等于表情被静默丢掉，而失败是看不见的。
 */
const VOCAB_ROWS = JSON.parse(readFileSync(new URL('./whale-vocab.json', import.meta.url), 'utf8'));
/** 词 id，英文写法也认。 */
const VOCAB = new Set(VOCAB_ROWS.map((v) => v.id));
/** 中文名 → id。写脚本时抄的是这一列。 */
const NAMES = new Map();
for (const v of VOCAB_ROWS) for (const n of v.names) NAMES.set(n, v.id);
/** id → expression / motion。表情位和动作位是两回事，混了就会写出"表情用【点头】"。 */
const KIND = new Map(VOCAB_ROWS.map((v) => [v.id, v.kind]));

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

test('相位按比例切；曲长不明或太短就不报', () => {
  assert.equal(phaseOf(10, 240), 'intro');    // 0.04
  assert.equal(phaseOf(48, 240), 'verse');    // 0.20
  assert.equal(phaseOf(120, 240), 'chorus');  // 0.50
  assert.equal(phaseOf(192, 240), 'bridge');  // 0.80
  assert.equal(phaseOf(230, 240), 'outro');   // 0.96
  assert.equal(phaseOf(10, null), null, '不知道曲长就别报位置');
  assert.equal(phaseOf(10, 30), null, '三十秒的曲子分不出段落，硬分就是编');
  assert.equal(phaseOf(null, 240), null);
  assert.equal(phaseOf(-1, 240), null);
});

test('超过六分钟按前中后段说，不报副歌', () => {
  assert.equal(isLongform(240), false);
  assert.equal(isLongform(LONGFORM_SEC + 1), true);
  // 十五分钟的古典放到 5:45，按比例正好进 chorus 那一格——
  // 旧台词会说"副歌一带，这一首的高点"，古典没有副歌，"高点"更是编的。
  assert.equal(phaseOf(345, 900), 'chorus');
  assert.equal(LONGFORM_NOTE.chorus, '中段');
  assert.ok(!/副歌|高点/.test(Object.values(LONGFORM_NOTE).join('')), '长曲的说法里不能出现副歌或高点');
});

test('表情池按路数×位置取；每格最多两个，且都在形象词表里', () => {
  for (const feel of ['hard', 'soft', 'old', 'odd', 'plain']) {
    for (const phase of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
      const pool = emojiPool(feel, phase);
      const words = [...pool.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
      assert.ok(words.length >= 1 && words.length <= 2, `${feel}/${phase} 给了 ${words.length} 个，太多她会全用上`);
      for (const w of words) {
        // 写出去的一律是中文名，不是英文 id：她读的词表"中文"列就是这些字，
        // 抄得一字不差她才不会怀疑"鲸鱼有没有这张脸"。
        assert.ok(NAMES.has(w), `${feel}/${phase} 里的「${w}」不是形象词表的中文名，写出去会被静默丢掉`);
      }
    }
  }
  // 20 格不能塌成一张脸：每个路数用过的表情集合互不相同
  const used = new Map();
  for (const feel of ['hard', 'soft', 'old', 'odd', 'plain']) {
    const set = new Set();
    for (const phase of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
      for (const m of emojiPool(feel, phase).matchAll(/【([^】]+)】/g)) set.add(m[1]);
    }
    used.set(feel, set);
  }
  const feels = [...used.keys()];
  for (let i = 0; i < feels.length; i++) {
    for (let j = i + 1; j < feels.length; j++) {
      const a = used.get(feels[i]);
      const b = used.get(feels[j]);
      const same = [...a].every((w) => b.has(w)) && [...b].every((w) => a.has(w));
      assert.ok(!same, `${feels[i]} 和 ${feels[j]} 用的表情完全一样，"不同曲风不同反应"就是空的`);
    }
  }
  // 不同路数在同一位置必须给出不同的东西，否则"不同歌不同反应"是空的
  assert.notEqual(emojiPool('hard', 'chorus'), emojiPool('soft', 'chorus'));
  assert.notEqual(emojiPool('soft', 'chorus'), emojiPool('soft', 'outro'));
  // 池子里只能是表情。混进动作以后，事件正文会写成「表情就用【认真】（顶多换成【点头】）」，
  // 她照着往 pet_say 首括号里塞动作——实测 21:07 写了 `【点头, 蹦迪】`，人没蹦。
  for (const feel of ['hard', 'soft', 'old', 'odd', 'plain']) {
    for (const phase of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
      for (const id of poolIds(feel, phase)) {
        assert.equal(KIND.get(id), 'expression', `${feel}/${phase} 里混进了动作 ${id}，那不是表情`);
      }
    }
  }
  // 柔歌开头不许给【犯困】：听抒情歌睡着是用户明确否掉的，池子里留着它等于鼓励
  assert.ok(!poolIds('soft', 'intro').includes('sleepy'), '柔歌开头不给犯困，那是"听着听着睡了"的根');
});

test('夹具里的中文名与能在场的 figure.json 一致（读不到就跳过）', () => {
  /*
   * 来源是**两处**，因为认词的是「当前穿的那个形象包」：
   * - 随扩展发的那一份（assets/figure-groove）：蹦迪/律动/打拍子这些我们自己实现的动作在这里；
   * - 宿主自带的鲸鱼（web/whale）：基础表情在这里。
   *
   * 2026-11-16 之前这条只查宿主那一处，能过是因为当时的宿主文件被补丁改过（加了 12 个动作）。
   * 补丁撤掉之后它立刻红了 —— 暴露的是这条断言一直照着错的源。两边都读才对。
   */
  const sources = [
    new URL('../assets/figure-groove/figure.json', import.meta.url),
    'E:/Coopanion/resources/app/node_modules/cortico-world-desktop-pet/web/whale/figure.json',
  ].filter((f) => existsSync(f));
  if (!sources.length) return;
  const liveNames = new Map();
  for (const f of sources) {
    for (const v of JSON.parse(readFileSync(f, 'utf8')).vocab ?? []) {
      // 先到先得：自家包那一份排在前面，它的中文名才是我们的口径
      if (!liveNames.has(v.id)) liveNames.set(v.id, v.names?.zh ?? []);
    }
  }
  assert.deepEqual(
    [...VOCAB].filter((id) => !liveNames.has(id)),
    [],
    '夹具里有宿主已经不认的词 id，表情会被静默丢掉',
  );
  for (const [name, id] of NAMES) {
    assert.ok(liveNames.get(id)?.includes(name), `「${name}」不是 ${id} 的中文名了，写进脚本等于没有表情`);
  }
});

/**
 * 「不吵你了」这个口癖的守卫。
 *
 * 2026-11-03 Mr.Q 的原话：「她老说别吵我，问题是她也没吵我啊」。
 * 根因是提示词里连着给了两处成句示范（`【开心】快完了，我不吵你了。`），
 * 她照着念，还换个说法念——把陪听说成噪音，等于把用户要的东西说成负担。
 *
 * 这条测试盯三件事：可照抄的示范行里不许出现「吵 / 打扰」；禁令本身必须在；
 * 段事件的指令不许再出现「一句收尾就停」那种让她替整首谢幕的说法。
 */
test('提示词里没有把她自己说成噪音的示范句', () => {
  const prompt = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  const bad = prompt
    .split('\n')
    .filter((l) => l.includes('pet_say:') && /吵|打扰/.test(l))
    .map((l) => l.trim());
  assert.deepEqual(bad, [], '示范行里出现「吵/打扰」——她会原样照抄，一次就成口头禅');

  assert.match(prompt, /不许把自己说成噪音/, '禁令不在，光删示范她还会自己发明一个');

  const asks = SEGMENT_ASK.filter((l) => l.includes('回一句：往后'));
  assert.ok(asks.length > 0, '段事件里那条「往后」的指令不见了？');
  assert.deepEqual(
    asks.filter((l) => /收尾就停|收尾/.test(l)).map((l) => l.trim()),
    [],
    '「收尾」会被她做成替整首谢幕；要说清是收这句话，不是给这首收场',
  );
});

test('提示词里出现的每个表情词都在形象词表里', () => {
  const prompt = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  const bad = [];
  for (const m of prompt.matchAll(/【([^】]+)】/g)) {
    for (const raw of m[1].split(/[,，\s]+/)) {
      const w = raw.trim();
      // 【词, 词】/【表情, 动作】是占位符说明，不是真词
      if (!w || ['词', '表情', '动作'].includes(w)) continue;
      // 英文 id 和中文名都认，但两种都必须真的在词表里
      if (!VOCAB.has(w) && !NAMES.has(w)) bad.push(w);
    }
  }
  assert.deepEqual([...new Set(bad)], [], '提示词里有形象不认得的词——她照着抄，气泡上会什么都不发生');
});

test('曲风弱判只看字面；认不出就承认认不出', () => {
  assert.deepEqual(
    guessFeel({ title: '夜曲（钢琴版）', album: '', artist: '周杰伦' }),
    { feel: 'soft', genre: '器乐', sure: true },
  );
  assert.equal(guessFeel({ title: '温柔', album: '', artist: '五月天' }).sure, false, '光看歌名认不出，别给默认值');
  assert.equal(guessFeel({ title: '温柔', album: '', artist: '五月天' }).feel, 'plain');

  const live = guessFeel({ title: '晴天 Live', album: '', artist: '周杰伦' });
  assert.equal(live.genre, '现场版');
  assert.equal(live.feel, 'hard');
  // 版本优先于曲种：摇滚的现场版，说"现场"比说"摇滚"更接近他此刻听到的东西
  assert.equal(guessFeel({ title: 'Wish You Were Here (Live)', album: '', artist: 'Pink Floyd' }).genre, '现场版');
});

test('曲风档案：再标一次覆盖旧的，重启还能读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-vibe-'));
  try {
    const a = new VibeStore(dir);
    const key = 'app\u0001t\u0001a';
    assert.equal(a.get(key), null);
    a.set(key, '抒情', 'soft', 1);
    assert.equal(a.get(key).feel, 'soft');
    a.set(key, '摇滚', 'hard', 2);
    assert.equal(a.get(key).feel, 'hard', '她改主意要生效');
    assert.equal(a.get(key).genre, '摇滚');

    const b = new VibeStore(dir);          // 模拟重启
    assert.equal(b.get(key).feel, 'hard');
    assert.equal(b.get(key).genre, '摇滚');
    assert.equal(b.size, 1, '同一首标两次只该算一首');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('曲风档案：坏行只坏一行，认不出的 feel 要丢掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-vibe-'));
  try {
    writeFileSync(
      join(dir, 'music-tags.jsonl'),
      '{"key":"a","feel":"soft","genre":"x","ts":1}\n'
      + '{ 这行坏了\n'
      + '{"key":"b","feel":"nope","genre":"y","ts":2}\n',
      'utf8',
    );
    const store = new VibeStore(dir);
    assert.equal(store.get('a')?.feel, 'soft', '好行不能被坏行连累');
    assert.equal(store.get('b'), null, 'feel 不认识就不能进缓存，否则会选出一格不存在的表情');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('music_tag：没在放、给错词、重复标，回执都要说清', () => {
  const { world, cleanup, dir } = probeWorld();
  try {
    world.vibes = new VibeStore(dir);
    assert.match(world.tagText('soft', ''), /没在放/);

    const track = { app: 'QQMusic.exe', title: 'X', artist: 'Y', album: '' };
    world.tracker = { state: () => ({ track }) };

    assert.match(world.tagText('温柔', ''), /只认 hard/, '给中文词要明确拒绝，而不是静默当没发生');
    assert.match(world.tagText('soft', '抒情'), /记下了.*柔（抒情）/);
    assert.equal(world.vibes.get(trackKey(track)).feel, 'soft');
    assert.match(world.tagText('soft', '抒情'), /本来就是/, '同一首重复标不该重复记');
    assert.match(world.tagText('hard', ''), /改了.*烈/);
    assert.equal(world.vibes.get(trackKey(track)).genre, '', '换成不带曲风的标记，旧曲风要清掉');
    assert.match(world.tagText('', ''), /只认 hard/);
  } finally {
    cleanup();
  }
});

test('vibeOf 把同歌手学习结果接入实际陪听判断', () => {
  const { world, cleanup } = probeWorld();
  try {
    const a = { app: 'QQMusic.exe', title: 'A', artist: 'Queen', album: 'A' };
    const b = { app: 'QQMusic.exe', title: 'B', artist: 'Queen', album: 'B' };
    world.vibes.set(trackKey(a), '摇滚', 'hard', 1, a);
    world.vibes.set(trackKey(b), '摇滚', 'hard', 2, b);
    const got = world.vibeOf({ app: 'QQMusic.exe', title: 'C', artist: 'Queen', album: 'C' });
    assert.equal(got.source, 'artist');
    assert.equal(got.genre, '摇滚');
    assert.match(got.reason, /2\/2/);
  } finally {
    cleanup();
  }
});

test('声音摘要进入段事件与环境状态，不再对模型隐身', async () => {
  const { world, cleanup } = probeWorld();
  try {
    world.audioPerceptionLine = () => '声音摘要：约 124 BPM，响度偏强，低音偏重（只有能量与拍子，不是完整听歌）。';
    world.tracker = {
      state: () => ({
        track: { app: 'QQMusic.exe', title: 'A', artist: 'X', album: '' },
        playing: true, playedMs: 60_000, sessionPlayedMs: 60_000, loopCount: 1, segmentsSaid: 0,
      }),
    };
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = world.tracker.state().track;
    await world.emit({ kind: 'segment', track, index: 1, fromSec: 0, toSec: 45, posSec: 45, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1 }, Date.now());
    assert.match(events.at(-1).text, /声音摘要：约 124 BPM/);
    assert.match(world.envPromptVars()['music.status'], /声音摘要：约 124 BPM/);
  } finally {
    cleanup();
  }
});

test('段事件带上路数与表情池；她标过就照她的改口', async () => {
  const { world, cleanup, dir } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    world.vibes = new VibeStore(dir);
    const track = { app: 'QQMusic.exe', title: '夜曲', artist: '周杰伦', album: '' };
    world.tracker = {
      state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 60_000, indexInSession: 1, segmentsSaid: 0 }),
    };

    await world.emit({
      kind: 'segment', track, index: 2, fromSec: 45, toSec: 125,
      posSec: 125, durSec: 240, phase: 'chorus', indexInSession: 1, loopCount: 1,
    }, Date.now());
    const first = events.at(-1).text;
    assert.match(first, /副歌一带/);
    assert.match(first, /这首还没标/, '没标的时候必须说没标，不能默认成柔');
    assert.match(first, /脚本开头原样写 【/, '表情要写成"脚本开头原样写【X】"，她才会放在第一个字符');
    assert.ok(!/这首偏/.test(first), '路数还没标的时候不该给语气——那等于替她定了性');

    // 她标了硬摇滚 → 同一条事件立刻改口，表情池也换
    world.tagText('hard', '摇滚');
    await world.emit({
      kind: 'segment', track, index: 3, fromSec: 125, toSec: 190,
      posSec: 190, durSec: 240, phase: 'bridge', indexInSession: 1, loopCount: 1,
    }, Date.now() + 1000);
    const second = events.at(-1).text;
    assert.match(second, /这首偏烈（摇滚）/);
    // 语气和脸必须一起给：只给脸，她会照着句子的情绪挑，表情池等于作废
    assert.match(second, /说话短、冲/, '语气要跟着路数走，不然她会把【思考】写成【开心】');
    // 写中文名（她词表里那一列），不是英文 id：写 id 她会怀疑词表里没有这张脸，然后换成开心的脸
    assert.match(second, /比如【认真, 跟拍挥】/, 'hard/bridge 第一张是【认真】、示例动作是【跟拍挥】，写死在同一个括号里');
    assert.match(second, /顶多换成【得意】/, '第二张降成"顶多换"，她才不会自己去挑第三张');
    assert.match(second, /抄中文别译英文/, '她会把【开心】译成【happy】，得堵住');
    // 烈的 + 桥段/副歌 → 动作必须是蹦迪（真离地、横着走），不是原地摇的跳舞。
    // 而且要和表情写在同一个括号里：另起一句"动作配【蹦迪】"要靠她再发一条 pet_act，实测会漏。
    assert.ok(!/动作配/.test(second), '动作并进括号，不再单起一句');
    assert.match(second, /不按你这句话的情绪挑/, '她是按句子情绪挑脸的，这一句专门拦这个');
    assert.ok(!/【[a-z]+】/.test(second), '段事件里不能出现英文 id');

    // 长曲：同一个 chorus 位置改说"中段"，不出现副歌
    await world.emit({
      kind: 'segment', track: { app: 'QQMusic.exe', title: 'Gymnopédie No.1', artist: 'Satie', album: '' },
      index: 2, fromSec: 60, toSec: 345, posSec: 345, durSec: 900,
      phase: 'chorus', indexInSession: 1, loopCount: 1,
    }, Date.now() + 2000);
    const third = events.at(-1).text;
    assert.match(third, /中段/);
    assert.ok(!/副歌|高点/.test(third), '古典不能说副歌');
  } finally {
    cleanup();
  }
});

test('每种事件的正文都写清了、且没有重复的时间戳', async () => {
  const { world, cleanup } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = { app: 'QQMusic.exe', title: '夜空中最亮的星', artist: '逃跑计划', album: '' };
    const prev = { app: 'QQMusic.exe', title: '上一首', artist: '别的', album: '' };
    world.tracker = { state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 600_000, indexInSession: 3 }) };
    const at = Date.UTC(2026, 9, 25, 15, 40, 0);   // 23:40 GMT+8

    const emit = async (signal) => {
      await world.emit(signal, at);
      return events.at(-1)?.text ?? '';
    };

    const start = await emit({ kind: 'start', track, silenceMin: 12 });
    assert.match(start, /打开音乐/);
    assert.match(start, /隔了 12 分钟/);

    // 「隔了多久」是三态，0 和 null 说的不是一件事：
    //   0   = 真的刚刚还在听
    //   null = 不知道（进程刚起、手上没接住上一次的时刻）
    // 曾经把 Infinity 兜底成 0，于是 2026-10-31 11:16 隔了 8 小时也写「隔了 0 秒」，
    // 她照这个数往回推成"刚放下又拿起来"。不知道就说不知道，别用零冒充。
    const justNow = await emit({ kind: 'start', track, silenceMin: 0 });
    assert.match(justNow, /刚才还在听/);
    assert.ok(!/0 秒/.test(justNow), '"0 秒"不是人话，不该出现在正文里');

    const unknown = await emit({ kind: 'start', track, silenceMin: null });
    assert.match(unknown, /没留记录/);
    assert.ok(!/隔了/.test(unknown), '不知道隔了多久就别报数字');
    assert.ok(!/0 秒/.test(unknown), '不知道更不能说成 0 秒');

    const trackText = await emit({ kind: 'track', track, prev, indexInSession: 3, artistChanged: true, prevPlayedMs: 185_000 });
    assert.match(trackText, /换歌了：《夜空中最亮的星》/);
    // 报名字和态度必须一次说完。拆成"先报名字、45 秒后段 1 再表态"的版本
    // 用户当场反馈过："这一首她只说了名字和歌手没有评价啊"——那四十多秒是空档。
    assert.match(trackText, /先报《歌名》和歌手/, '换歌那条要名字和态度一起要');
    assert.match(trackText, /一句实话/, '态度必须在换歌那条里就要，不能等段 1');
    // "我吃"是她从"吃不吃这一套"这句指令里抄出来的口头禅——四首连下来全成了「X，我吃!」。
    // 指令里必须显式点名禁掉，光在 ENV_PROMPT 里写不够（事件正文比提示词管用）。
    assert.match(trackText, /别写"我吃"/, '得在正文里点名禁掉这个套话，否则她又回去复读');
    assert.ok(!/吃不吃这一套/.test(trackText), '这句指令本身就是复读的源头，不能再出现');
    assert.match(trackText, /脚本开头原样写 【/, '换歌要表态就得给脸，否则她只发文字');
    assert.ok(!/十个字以内/.test(trackText), '"只报名字"的旧指令必须删掉，否则又回到空档');

    const loop = await emit({ kind: 'loop', track, count: 3 });
    assert.match(loop, /第 3 遍/);

    const fidget = await emit({ kind: 'fidget', skipped: 5, windowMin: 4 });
    assert.match(fidget, /连跳了 5 首/);
    assert.match(fidget, /4 分钟/);

    const night = await emit({ kind: 'night', track });
    assert.match(night, /已经这个点了/);
    // 正文开头本来就带 [23:40]，再写一遍就成了"[23:40] 已经 23:40 了"——读起来像机器串线
    assert.ok(!/\] 已经 23:40 了/.test(night), '深夜那条不能把时间戳说两遍');
    assert.match(night, /夜空中最亮的星/);

    const long = await emit({ kind: 'long', track, minutes: 90 });
    assert.match(long, /连着听了 1 小时 30 分/);

    for (const t of [start, trackText, loop, fidget, night, long]) {
      assert.match(t, /^\[\d{2}:\d{2}\]/, '每条正文都要以时间戳开头，她靠它判断"现在几点"');
    }
  } finally {
    cleanup();
  }
});

test('短曲的第 1 段不推、长曲的推——换歌那条已经把名字和态度说完了', () => {
  const seg = (index, durSec) => ({
    kind: 'segment',
    track: { app: 'QQMusic.exe', title: 'x', artist: '', album: '' },
    index, fromSec: 0, toSec: 45, posSec: 45, durSec, phase: 'intro', indexInSession: 1, loopCount: 1,
  });
  assert.equal(skipSignal(seg(1, 210)), true, '3 分半的歌：段 1 会和换歌那条说重');
  assert.equal(skipSignal(seg(1, 900)), false, '15 分钟的曲子只在开头说一句太少，段 1 要留');
  assert.equal(skipSignal(seg(1, null)), true, '曲长未知按短的算——宁可少说一句，别说重');
  assert.equal(skipSignal(seg(2, 210)), false, '只跳第 1 段，段 2 段 3 照推');
  assert.equal(skipSignal({ kind: 'fidget', skipped: 3, windowMin: 4 }), false, '别的信号一律照推');
  assert.equal(skipSignal({ kind: 'track', track: seg(1, 210).track, prev: seg(1, 210).track, indexInSession: 1, artistChanged: false, prevPlayedMs: 1000 }), false, '换歌那条是主信号，绝不能跳');
});

/**
 * 网易云的 SMTC 常年报 pos:0 / dur:0（实测 22:59 拉二第三乐章拿到的就是这组数），
 * 于是 phase 恒为 null。原来位置一未知就把表情和动作一起丢掉，事件只剩一段干话——
 * 而柔歌的睡意正是靠「闭眼听」触发的，不给动作，她永远不会在钢琴曲里打盹。
 */
test('位置未知也要给动作——网易云的古典全走这条路，空着她就既没脸也没动作', () => {
  assert.equal(moveIdAny('soft', null), 'enjoy', '柔歌位置未知时闭眼听，它是睡意开关');
  assert.equal(moveIdAny('hard', null), 'tap');
  assert.equal(moveIdAny('old', null), 'tap');
  assert.equal(moveIdAny('odd', null), 'groove');
  // **2026-10-29 改了：plain（未知）给中性动作，不再给空。**
  // 原来这里写「说不上路数还是不给，那是编的」——理由只对了一半：
  // 「别猜路数」是对的，但「不给动作」等于让她整首歌站着不动，用户看到的是桌宠坏了
  // （另一台机器上的原话就是「我的桌宠直接不做动作了」）。
  // 打拍子是中性的、不带任何路数色彩，所以不算编。判据从「不给」收紧成「只给中性的」。
  assert.equal(moveIdAny('plain', null), 'tap', '未知曲风给中性动作，别给空');
  assert.equal(moveIdAny(null, null), 'tap');
  // 避让在兜底这条路上也得管：连着两段不给同一个
  assert.notEqual(moveIdAny('soft', null, 'enjoy'), 'enjoy', '上一段已经闭眼听了，这一段要换');
  // 原来的判据不因此放松
  assert.equal(moveCue('hard', null), '', 'moveCue 的判据不动，"位置未知不该猜段落"那条还留着');
});

/**
 * 第 4 格「说你自己的状态」曾经一律写死"不许说困"——那是拿《曹操》那两次睡倒换来的。
 * 但 Mr.Q 后来把话改清楚了：「听现在这种曲子的时候，孩子困了就让她睡会吧」。
 * 判据因此从"听歌不许困"变成"这首曲子该不该困"，这条断言把分版钉住。
 */
test('「说你自己的状态」按曲风分版：柔歌允许困，其余照旧不许', () => {
  const soft = stateAngle('soft');
  assert.match(soft, /可以困/, '柔歌里困了就说，别硬撑');
  assert.doesNotMatch(soft, /不许说困/, '柔歌里不能再禁困，那和用户的交代直接矛盾');
  assert.match(soft, /别写【睡觉】/, '柔歌里必须先堵住【睡觉】——那是永久睡下，得等有人点她才醒');

  for (const f of ['hard', 'old', 'odd', 'plain', null]) {
    const t = stateAngle(f);
    assert.doesNotMatch(t, /可以困/, `${f ?? 'null'} 不该得到困这条口子`);
    assert.match(t, /不许说困/, `${f ?? 'null'} 照旧禁困——《曹操》上睡着过两次`);
  }
});

test('talkAngle：数量那格只在里程碑开，其余三格轮转且相邻不同', () => {  // 里程碑：每 18 首才许说一次"总共听了多少"
  assert.equal(talkAngle(1, 18), 0, '18 首该报一次总量');
  assert.equal(talkAngle(1, 36), 0, '36 首再报一次');
  assert.notEqual(talkAngle(1, 17), 0, '17 首不许报总量');

  let prev = null;
  for (let d = 1; d <= 55; d += 1) {
    const a = talkAngle(1, d);
    if (d % 18 === 0) assert.equal(a, 0, `${d} 首掉出了里程碑格`);
    // 非里程碑不许碰 0 号格。碰了就意味着"数首数"回到每几首一次的密度——
    // Mr.Q 的原话是"每一首都数听歌首数，有点烦，隔个一二十首再说吧"。
    else assert.ok(a >= 1 && a <= 3, `第 ${d} 首跑到数量格了，会变回复读`);
    if (prev !== null) assert.notEqual(a, prev, `第 ${d} 首和第 ${d - 1} 首同一个角度`);
    prev = a;
  }
  // 密度验收：55 首里最多 3 次（18/36/54）
  const hits = Array.from({ length: 55 }, (_, i) => talkAngle(1, i + 1)).filter((a) => a === 0).length;
  assert.ok(hits <= 3, `55 首里报了 ${hits} 次总量`);
});

test('段 2 一次只给一样实据——四样并排就是一张可以照抄的填空表', async () => {
  const { world, cleanup } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = { app: 'QQMusic.exe', title: '某首歌', artist: '某人', album: '' };
    // 让"这个歌手今天第 N 首"和"今天已收尾"都有值，才验得出这两档不会同时出现
    // doneToday 必须跟着长。真实环境里每收尾一首它 +1，第一版探针把它钉死成 2，
    // 于是"两个同步递增的量相加当种子"那个 bug 在预演里完全看不出来，只有实测日志才露。
    let dayCount = 2;
    world.store = { readDay: () => Array.from({ length: dayCount }, () => ({ artist: '某人', title: 't' })) };
    const at = Date.UTC(2026, 9, 25, 12, 0, 0);
    const texts = [];
    for (let n = 1; n <= 8; n += 1) {
      dayCount += 1;
      world.tracker = { state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 3_600_000, indexInSession: n }) };
      await world.emit({
        kind: 'segment', track, index: 2, fromSec: 45, toSec: 105,
        posSec: 105, durSec: 200, phase: 'chorus', indexInSession: n, loopCount: 0,
      }, at + n * 300_000);
      texts.push(events.at(-1).text);
    }

    // 「他今天一直在放 X」是"说他"那格去掉了数量之后的写法（listen.28）。
    // 不把它算进标记，角度 2 会被当成空串，和角度 3 撞在一起——那不是真撞，是尺子旧了。
    const marks = ['这一场第', '连着听了', '这个歌手今天第', '今天已收尾', '他今天一直在放'];
    const pick = (t) => marks.filter((m) => t.includes(m)).join('+');
    for (const [i, t] of texts.entries()) {
      const hit = marks.filter((m) => t.includes(m));
      // 病是这么来的：原来 context 把四样事实用「、」并排摆出来，她照着填，
      // 于是 19:53–20:22 连着九次「第 27 首，七点五十三」。
      assert.ok(hit.length <= 1, `第 ${i + 1} 首的段 2 一口气给了 ${hit.join(' / ')}，她会照抄成台账`);
    }
    for (let i = 1; i < texts.length; i += 1) {
      assert.notEqual(pick(texts[i]), pick(texts[i - 1]), '连着两首给同一样实据，她会连着说同一个格式');
    }
    // 时间戳禁令必须写在段 2 正文里：她把正文开头的 [20:21] 念成了"八点二十一"
    for (const t of texts) assert.match(t, /别念进话里/);
    // 别的段不受影响——换歌那条仍然要名字和态度一起给
    assert.ok(!texts[0].includes('这一场第 3 首、连着听了'), '段 2 的分法不能漏到前面的段');
  } finally { cleanup(); }
});

test('真实递增下三格都能跑到——种子不能是两个同步量相加', () => {
  const nonMilestone = new Set();
  let countHits = 0;
  // 真实规律：每换一首，indexInSession 和 doneToday 同时 +1。
  // 旧写法 (indexInSession - 1 + doneToday) % 4 在这个规律下总数每次 +2，
  // 模 4 只在 0 和 2 之间跳，另一半角度永远轮不到。这条断言就是为它设的。
  for (let n = 1; n <= 60; n += 1) {
    const a = talkAngle(n, 40 + n - 1);
    if (a === 0) countHits += 1;
    else nonMilestone.add(a);
  }
  assert.deepEqual([...nonMilestone].sort(), [1, 2, 3],
    `只跑到 ${[...nonMilestone].sort().join('/')} 这几种，段 2 会一直来回说同两种话`);
  assert.ok(countHits <= 4, `60 首里报了 ${countHits} 次总量，密度太高`);
});

test('里程碑那一段只给一件事实，且一首歌只报一次', async () => {
  // 21:37:36 实测：场次 + 时长 + 总量 + 歌手计数四样并排，她立刻又排成一行账。
  // 「隔十几首说一次」被她拆成了「每段都说一点」——所以里程碑要收成一件，且不许重复。
  const { world, cleanup } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = { app: 'QQMusic.exe', title: '某首歌', artist: '某人', album: '' };
    world.store = { readDay: () => Array.from({ length: 54 }, () => ({ artist: '某人', title: 't' })) };
    world.tracker = { state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 9_000_000, indexInSession: 5 }) };
    const at = Date.UTC(2026, 9, 25, 13, 0, 0);
    const emit = async (index, ms) => {
      await world.emit({
        kind: 'segment', track, index, fromSec: 45, toSec: 105,
        posSec: 105, durSec: 200, phase: 'chorus', indexInSession: 5, loopCount: 0,
      }, at + ms);
      return events.at(-1).text;
    };

    const seg2 = await emit(2, 0);
    assert.match(seg2, /今天已收尾 54 首/, '54 是里程碑，该报一次');
    assert.ok(!/这个歌手今天第/.test(seg2), '里程碑那一段只给一件，别再摆歌手计数');
    assert.ok(!/这一场第/.test(seg2), '里程碑那一段不摆场次');

    const seg3 = await emit(3, 60_000);
    assert.ok(!/今天已收尾/.test(seg3), '同一首的后一段不许重复报总量');
    assert.ok(!/，。/.test(seg3), '没有实据时别留下一个孤零零的逗号');
  } finally { cleanup(); }
});

test('动作和表情写在同一个括号里，不另起一条 pet_act', async () => {
  // 21:44:39 实测：事件末尾写着「动作配【打拍子】」，她只发了 pet_say，人站着没动 —— 四条里漏一条。
  // 改成并进表情括号：宿主 parseScript 会把 `【星星眼, 蹦迪】` 拆成 actions=[excited, bounce]，
  // 客户端 pet-app.js 先做动作再打字，一条调用全办完。
  const { world, cleanup } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = { app: 'QQMusic.exe', title: '某首歌', artist: '某人', album: '' };
    world.store = { readDay: () => [] };
    world.tracker = { state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 120_000, indexInSession: 3 }) };
    world.vibes = { get: () => ({ feel: 'hard', genre: '摇滚' }), set: () => {} };
    await world.emit({
      kind: 'segment', track, index: 2, fromSec: 45, toSec: 105,
      posSec: 105, durSec: 200, phase: 'chorus', indexInSession: 3, loopCount: 0,
    }, Date.UTC(2026, 9, 25, 13, 0, 0));
    const text = events.at(-1).text;
    // 2026-10-28 改成候选制：动作给一组让她挑（她会按自己那句话来选），
    // 但"两个词写进同一个括号"这个格式没变 —— 所以示例必须给全，她照示例拼。
    assert.match(text, /比如【[^】]+, [^】]+】/, '要给一个完整的示例，她才知道两个词怎么拼');
    assert.ok(!/动作配/.test(text), '别再另起一句"动作配【X】"，那要靠她再发一条 pet_act，实测会漏');
    assert.match(text, /动作从这几个里挑一个/, '动作要给她候选，不是给唯一答案');
    // 示例里第一张是表情、第二张是动作，顺序错了客户端先做动作再打字，脸会晚半秒才挂上
    const pair = text.match(/比如【([^】]+)】/)[1].split(/[,，]\s*/);
    assert.equal(KIND.get(NAMES.get(pair[0])), 'expression', '第一个必须是表情');
    assert.equal(KIND.get(NAMES.get(pair[1])), 'motion', '第二个必须是动作');
  } finally { cleanup(); }
});

test('动作跟着路数走，不跟着节拍走', () => {
  // 2026-10-28 扩到十个动作后重排。烈这一档的分配是**按实测行为改的**，不是按推断：
  // 三首摇滚里副歌给挥她三次全改成蹦，所以副歌改回蹦、桥段才给挥。
  // 柔的中段改成跟着词哼、正段凑近听。判据仍是"跟着路数走"——同一档里不同段落要分开。
  assert.match(moveCue('hard', 'chorus'), /蹦迪/, '副歌就是她最想蹦的地方');
  assert.match(moveCue('hard', 'bridge'), /跟拍挥/, '桥段收一点，站着挥');
  assert.match(moveCue('hard', 'verse'), /打拍子/, '烈的歌不是全程蹦，非高点只打拍');
  assert.match(moveCue('soft', 'intro'), /闭眼听/);
  assert.match(moveCue('soft', 'outro'), /闭眼听/);
  assert.match(moveCue('soft', 'chorus'), /跟着哼/, '抒情的中段跟着词哼');
  assert.match(moveCue('old', 'verse'), /打拍子/);
  assert.match(moveCue('odd', 'chorus'), /律动/);
  assert.equal(moveCue('plain', 'chorus'), '打拍子', '未知曲风给中性的打拍子，不是不给——空着她就站着不动');
  assert.equal(moveCue(null, 'chorus'), '', '没标路数时不知道该动还是该静');
  assert.equal(moveCue('hard', null), '', '位置未知时不知道在副歌还是开头，不该猜');

  // 写出去的每个动作名都必须在形象词表里，否则气泡上什么都不发生（静默丢弃）
  for (const f of ['hard', 'soft', 'old', 'odd', 'plain']) {
    for (const p of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
      const t = moveCue(f, p);
      if (!t) continue;
      // moveCue 现在直接返回中文动作名（要贴进 `【表情, 动作】` 那个括号），不再带【】
      assert.ok(NAMES.has(t), `${f}/${p} 给了「${t}」，形象词表的中文名里没有，写了也白写`);
      assert.equal(KIND.get(NAMES.get(t)), 'motion', `${f}/${p} 的「${t}」是表情不是动作`);
    }
  }
});

/**
 * 市场里装这个扩展的人，宿主没有 `patch-whale-bounce.mjs` 打的那份补丁——
 * 蹦迪/律动/打拍子/闭眼听四个动作会被宿主**静默丢弃**，不报错，看着就是「她不动」。
 * 这一层就是给那种宿主准备的：认不得就换成原生等价动作，换不出来宁可不给。
 */
test('宿主认不得自定义动作时降级到原生动作（没打补丁的市场用户）', () => {
  // 模拟裸宿主：只有原生动作，没有补丁加进去的那四个
  const bare = new Set(['neutral', 'happy', 'dance', 'nod', 'hop', 'jump', 'sit', 'sleep']);
  try {
    setHostVocab(bare);
    assert.equal(degradeMove('dance'), 'dance', '原生动作原样过，不该被动');
    assert.equal(degradeMove('bounce'), 'dance', '蹦迪 → 跳舞');
    assert.equal(degradeMove('groove'), 'dance', '律动 → 跳舞');
    assert.equal(degradeMove('tap'), 'nod', '打拍子 → 点头');
    assert.equal(
      degradeMove('enjoy'), '',
      '闭眼听没有原生等价，宁可不给——降成 sit/sleep 她就坐在钢琴曲里打盹了',
    );
    assert.equal(moveCue('hard', 'chorus'), '跳舞', '烈歌副歌在裸宿主上仍然会动');
    assert.equal(moveCue('soft', 'intro'), '', '抒情开头不给动作，也不能变成坐下来睡');
    // 降级目标本身必须在裸宿主词表里，否则等于换个名字继续静默丢弃
    for (const id of ['dance', 'nod', 'hop', 'jump']) {
      assert.ok(bare.has(id), `${id} 不在词表里，降级链条自己就断了`);
    }
  } finally {
    setHostVocab(null);
  }
});

test('探不到宿主词表时一点不降级（有补丁的机器不能被误降成跳舞）', () => {
  setHostVocab(null);
  assert.equal(degradeMove('bounce'), 'bounce', '不知道就别动它');
  assert.equal(moveCue('hard', 'chorus'), '蹦迪', '原手感保持');
});

test('不再读宿主安装目录（防回归）', () => {
  /*
   * 2026-11-14 按市集要求撤掉：按路径扫宿主 web/<figure>/figure.json 探词表，和 journey / pz 是同一个问题，
   * 宿主换一次布局就静默失效。光删函数不够 —— 哪天有人为了「让动作更准」把读取加回来，
   * 行为上完全看不出来，直到那份失效。直接在源码上钉死。
   */
  const src = readFileSync(new URL('../src/host-vocab.ts', import.meta.url), 'utf8');
  assert.equal(/from 'node:fs'/.test(src), false, 'host-vocab.ts 又引入了 node:fs');
  assert.equal(/readFileSync|existsSync|readdirSync/.test(src), false, 'host-vocab.ts 又去读文件了');
  assert.equal(readHostVocab(), null, '词表应当恒为 null —— 「不知道」才不降级');
});

/**
 * 「闭眼听」不只是个动作，它还是身体的睡意开关：body.js 记下这个动作的时刻（swoonAt），
 * 之后五分钟内坐下就有七成会真睡着。所以它一旦漏到别的路数上，后果不是"动作配错了"，
 * 而是**她在烈歌里睡倒** —— 那正是用户点过名的事（「像《曹操》这种歌她听睡着了，这像话嘛」）。
 * 这条断言锁死来源：只有柔歌能拿到它，任何路数、任何位置、任何避让顺序都不行。
 */
test('只有柔歌能下发「闭眼听」——它是睡意开关，漏到别的路数上她会在烈歌里睡倒', () => {
  const LAST = ['', 'bounce', 'dance', 'tap', 'groove', 'enjoy'];
  for (const f of ['hard', 'old', 'odd', 'plain']) {
    for (const p of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
      for (const last of LAST) {
        assert.notEqual(
          moveIdOf(f, p, last), 'enjoy',
          `${f}/${p}（上一次是 ${last || '无'}）拿到了 enjoy，她会在这首歌里睡着`,
        );
      }
    }
  }
  // 柔歌的两个入口：开头和收尾。2026-10-28 扩到十个动作后，中段的首选改成跟着哼／凑近听，
  // 撞车时也优先换这两个——这不算丢掉睡意开关，因为开关本来靠的就是开头那一下和收尾那一段。
  assert.equal(moveIdOf('soft', 'intro'), 'enjoy');
  assert.equal(moveIdOf('soft', 'outro'), 'enjoy');
});

test('动作撞车时换备选，不连着给同一个', () => {
  // 抒情歌的副歌和桥段都落在律动上：一首歌两段、换首还是它，桌面上看像卡住了。
  // 实测 21:20 / 21:23 / 21:24 连着三次【律动】。
  assert.match(moveCue('soft', 'chorus'), /跟着哼/);
  assert.doesNotMatch(moveCue('soft', 'chorus', 'hum'), /跟着哼/, '上一次是跟着哼，这一段不能再给同一个');
  assert.match(moveCue('soft', 'chorus', 'hum'), /凑近听|闭眼听/, '撞车后落在同档的备选，不是给空');

  // 烈的副歌撞了应援：换到同样"在动"的备选，不是退回打拍子那种小动作
  assert.doesNotMatch(moveCue('hard', 'chorus', 'cheer'), /应援/);
  // 旧的歌撞了打拍子：换到同档的跟着哼，不能给空
  assert.match(moveCue('old', 'verse', 'tap'), /跟着哼/);

  // 备选轮换不能把动作弄丢，也不能把不该动的歌弄动
  for (const f of ['hard', 'soft', 'old', 'odd']) {
    for (const p of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
      const first = moveCue(f, p);
      if (!first) continue;
      const second = moveCue(f, p, moveIdOf(f, p));
      assert.ok(second, `${f}/${p} 撞车后动作没了`);
      assert.notEqual(second, first, `${f}/${p} 撞车后还是同一个动作`);
    }
  }
  assert.equal(moveCue('plain', 'chorus', 'groove'), '打拍子', '未知曲风撞了律动就换打拍子，仍然有动作');
});

/* ---------- 自己找歌 ---------- */

const mkTrack = (title, durSec, source = 'qq') => ({
  source, id: '1', mid: '', title, artist: '某歌手', album: '某专辑', durSec, url: '',
});

test('挑歌：试听片段不要，同名优先，都不像就取第一条', () => {
  // 精确同名 > 带后缀的现场版
  assert.equal(pickBest([mkTrack('时光(Live)', 344), mkTrack('时光', 305)], '时光').title, '时光');
  // 「《时光》」和「时光」算同一首
  assert.equal(pickBest([mkTrack('时光', 305)], '《时光》').title, '时光');
  // 30 秒以下基本是铃声/试听，不能拿来当她"想听的歌"
  assert.equal(pickBest([mkTrack('时光', 20), mkTrack('别的', 200)], '时光').title, '别的');
  // 一个都不像，也比什么都不给强——她要的是"挑一首"，不是"挑到完美"
  assert.equal(pickBest([mkTrack('无关', 200)], '时光').title, '无关');
  assert.equal(pickBest([], '时光'), null);
  assert.equal(bareTitle('《时光》'), '时光');
  assert.equal(bareTitle('「起风了」'), '起风了');
});

test('一首歌的样子：没有专辑和时长就别硬写括号', () => {
  assert.equal(
    describeTrack({ source: 'qq', id: '1', mid: 'm', title: '时光', artist: '许巍', album: '时光.漫步', durSec: 305, url: '' }),
    '《时光》 — 许巍（专辑《时光.漫步》，5 分 5 秒）',
  );
  assert.equal(
    describeTrack({ source: 'netease', id: '1', mid: '', title: '未知曲目', artist: '', album: '', durSec: 0, url: '' }),
    '《未知曲目》',
  );
});

test('想听清单：同一首不重复记，落盘能读回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-want-'));
  const store = new ListenStore(dir);
  const first = store.addWant({ source: 'qq', id: '1', mid: 'm1', title: '时光', artist: '许巍', album: '', durSec: 305, url: 'https://x/1', why: '想听点旧的' }, 1000);
  assert.equal(first.added, true);
  assert.equal(first.total, 1);

  const again = store.addWant({ source: 'qq', id: '1', mid: 'm1', title: '时光', artist: '许巍', album: '', durSec: 305, url: 'https://x/1', why: '再提一次' }, 2000);
  assert.equal(again.added, false, '同一首重复提不该变成两条');
  assert.equal(store.wantCount(), 1);

  const second = store.addWant({ source: 'netease', id: '9', mid: '', title: '时光', artist: '许巍', album: '', durSec: 305, url: 'https://y/9', why: '' }, 3000);
  assert.equal(second.added, true, '另一个源上的同名歌算另一条');

  const wants = store.wants(10);
  assert.equal(wants.length, 2);
  assert.equal(wants[0].title, '时光');
  assert.equal(wants[0].ts, 3000, '新的在前');

  assert.equal(store.clearWants(), true);
  assert.equal(store.wantCount(), 0);
  rmSync(dir, { recursive: true, force: true });
});


/* ---------- 歌词 ---------- */

const NETEASE_LRC = `[00:00.000] 作词 : 小克
[00:00.536] 作曲 : 林家谦
[00:02.144]若爱是但求开心　我问
[00:06.028]要不要求其伤心
[00:24.601]论尽半生不懂爱
[00:29.689]回头没有心计划未来
`;

const QQ_LRC = `[ti:是但求其爱]
[ar:陈奕迅]
[al:是但求其爱]
[offset:0]
[00:00.00]是但求其爱 - 陈奕迅 (Eason Chan)
[00:00.28]词：小克
[00:00.98]若爱是但求开心 我问
[00:05.14]
[00:05.80]要不要求其伤心
`;

test('LRC 解析：元信息不能混进歌词，隔行空标记要丢掉', () => {
  const n = parseLrc(NETEASE_LRC);
  assert.ok(n.lines.length > 0, '有词的 LRC 必须解析出行');
  // 作词/作曲是元信息，不是歌词
  assert.deepEqual(n.lines.map((l) => l.text), ['若爱是但求开心　我问', '要不要求其伤心', '论尽半生不懂爱', '回头没有心计划未来']);
  assert.equal(n.lines[0].t, 2.144);

  const q = parseLrc(QQ_LRC);
  // [ti:] [ar:] 那种键值行没有数字时间戳，本来就进不来；「词：小克」是制作信息要滤掉
  assert.deepEqual(q.lines.map((l) => l.text), ['是但求其爱 - 陈奕迅 (Eason Chan)', '若爱是但求开心 我问', '要不要求其伤心']);

  // **2026-10-29 改了**：原来这里断言 `parseLrc('').instrumental === true`，
  // 等于把"没拿到内容"钉成"这首是纯音乐"。实测代价是：QQ 接口回 retcode -1901
  // （请求被拒），我们拿回空串，于是她对着有词的《雪の華》《長い間》说"这首没词"。
  // 现在解析层不再判 instrumental —— 解析不出就是解析不出，是不是纯音乐只能由
  // 抓取层看接口的明确标记（网易云的 nolyric）来决定。
  assert.deepEqual(parseLrc('').lines, [], '空输入解析不出行');
  assert.deepEqual(parseLrc('[ti:只有元信息]').lines, [], '只有元信息时解析不出行');
  assert.equal('instrumental' in parseLrc(''), false, '解析层不该再判"有没有词"');
});

// 2026-11-01：两条真实漏网样本，用户反馈「词这次只捞到制作名单，没捞到正文」。
// 名单的标签后面拖着英文（`录音师 Recording Engineer：`）、或者标签里夹 `&`
// （`混音&母带：`），旧的 `^(作词|编曲|混音)\s*[:：]` 一个都对不上，整段名单漏进 lines；
// 换歌那一刻 linesFrom(0) 取头两行，正好全取到名单。
const CREDIT_HEAVY_LRC = `[ti:天气预报]
[ar:梁静茹]
[00:00.00]天气预报 - 梁静茹
[00:03.29]词：郑兴
[00:03.97]曲：郑兴
[00:04.71]编曲 Arrangement：黄中岳 Ray Huang
[00:06.64]制作人 Producer：陈君豪 Howe@成绩好工作室
[00:09.59]吉他 Guitar：黄中岳 Ray Huang
[00:11.40]录音师 Recording Engineer：马一宁 Yi Ning Ma@Show Music Studio
[00:14.37]混音师 Mixing Engineer：沈冠霖 SHENB
[00:16.46]混音录音室 Mixing Studio：小公园 ThePark
[00:18.92]制作助理 Production Assistant：沈冠霖 SHENB/林颉 Jie Lin
[01:02.03]把薄荷搬来新房间 把旧CD整理一遍
[01:13.17]把被子晾在窗台上
`;

test('LRC 解析：制作名单整段剔掉，换歌那一句不能是名单', () => {
  const r = parseLrc(CREDIT_HEAVY_LRC, { title: '天气预报', artist: '梁静茹' });
  assert.deepEqual(
    r.lines.map((l) => l.text),
    ['把薄荷搬来新房间 把旧CD整理一遍', '把被子晾在窗台上'],
    '开头的十一行名单一行都不能剩下',
  );
  // 这就是她真正拿到的那句（world.ts 换歌时 linesFrom(0, 2)）
  assert.equal(
    quoteLines(linesFrom(r.lines, 0, 2)),
    '把薄荷搬来新房间 把旧CD整理一遍 / 把被子晾在窗台上',
  );
});

test('LRC 解析：标签里夹 & 的、名字里再带冒号的制作行，也当名单', () => {
  const raw = `[00:02.28]词：唐恬 TIAN TANG
[00:02.65]编曲：钱雷 LEI QIAN
[00:05.82]混音&母带：赵靖 JING ZHAO BIG.J@SBMS Beijing
[00:09.26]宣传：北京很有可能文化传播有限公司：金朝顺/沈雨娟
[00:17.00]我是这路上 没名字的人
[00:24.06]我没有新闻 没有人评论
`;
  const r = parseLrc(raw, { title: '无名的人', artist: '毛不易' });
  assert.deepEqual(r.lines.map((l) => l.text), ['我是这路上 没名字的人', '我没有新闻 没有人评论']);
});

test('LRC 解析：整份只有名单，就当没拿到词（不给，也不说「这首没词」）', () => {
  const raw = `[00:01.00]作词：甲
[00:02.00]作曲：乙
[00:03.00]编曲 Arrangement：丙
`;
  const r = parseLrc(raw);
  assert.deepEqual(r.lines, [], '剥完名单什么都不剩，解析层回空，由抓取层判成"没拿到"');
});

test('LRC 解析：一行多个时间戳要拆开，offset 要算进去', () => {
  const r = parseLrc('[00:10.00][01:20.00]同一句副歌\n[offset:500]');
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].t, 10.5);
  assert.equal(r.lines[1].t, 80.5);
  // 离谱的 offset 不能信（有的词库写 -100000）
  assert.equal(parseLrc('[offset:-100000]\n[00:05.00]一句').lines[0].t, 5);
});

test('匹配：同名同歌手才敢用，翻唱和同名不同曲一律不要', () => {
  const want = { title: '是但求其爱', artist: '陈奕迅', app: 'netease', durSec: 305 };
  const cand = (title, artist, source = 'netease', durSec = 305) => ({ title, artist, source, durSec });

  assert.ok(matchScore(cand('是但求其爱', '陈奕迅'), want) >= 100);
  // 书名号、括号版本号算同一首
  assert.ok(matchScore(cand('《是但求其爱》', '陈奕迅'), want) >= 70);
  // 翻唱：歌名对上了，但歌手不是他，必须掉到阈值以下
  assert.ok(matchScore(cand('是但求其爱（翻唱完整版）', '节奏黑武士'), want) < 70);
  // 同名但根本不认识的歌手
  assert.ok(matchScore(cand('是但求其爱', '某网红'), want) < 70);
  // 歌名完全无关
  assert.equal(matchScore(cand('最佳损友', '陈奕迅'), want), 0);
  // 伴奏版即使歌名歌手都对，也得掉下来（词不一样）
  assert.ok(matchScore(cand('是但求其爱 (伴奏)', '陈奕迅'), want) < 70);
  // 时长对得上的比对不上的更可信
  const near = matchScore(cand('是但求其爱', '陈奕迅', 'netease', 305), want);
  const far = matchScore(cand('是但求其爱', '陈奕迅', 'netease', 250), want);
  assert.ok(near > far);
});

test('取行：段事件给这一段唱过的，换歌给开头', () => {
  const lines = [
    { t: 0, text: 'A' }, { t: 10, text: 'B' }, { t: 20, text: 'C' },
    { t: 30, text: 'D' }, { t: 40, text: 'E' },
  ];
  // 25→45 这一段唱了 D、E，给两行 → 就要这两行
  assert.deepEqual(segmentLines(lines, 25, 45, 2).map((l) => l.text), ['D', 'E']);
  // 区间里只有一句（长间奏），往前补到够数
  assert.deepEqual(segmentLines(lines, 35, 42, 2).map((l) => l.text), ['D', 'E']);
  // 整段落在前奏：给开头几句，不能空着
  assert.deepEqual(segmentLines(lines, 0, 0, 2).map((l) => l.text), ['A']);
  // 换歌：还没开口，要的是"接下来这几句"，往前取只会拿到第一行
  assert.deepEqual(linesFrom(lines, 0, 2).map((l) => l.text), ['A', 'B']);
  assert.deepEqual(linesFrom(lines, 20, 2).map((l) => l.text), ['C', 'D']);
  // 工具查询："刚唱过什么"，要包含当前这句
  assert.deepEqual(linesAt(lines, 20, 2).map((l) => l.text), ['B', 'C']);

  // 副歌连着重复同一句，去重后只剩一条
  const dup = [{ t: 0, text: '副歌' }, { t: 10, text: '副歌' }, { t: 20, text: '别的' }];
  assert.deepEqual(segmentLines(dup, 0, 25, 3).map((l) => l.text), ['副歌', '别的']);
});

test('歌词要当不可信输入：方括号和尖括号必须清掉', () => {
  // 【】是桌宠的表情/动作块，<> 是行内标记。歌词里出现，她照抄就变成一条指令。
  const out = quoteLines([{ t: 0, text: '【开心】你<笑>了' }]);
  assert.equal(out, '开心你笑了');
  // 超长一句要截断，否则一条事件被一行词撑爆
  const long = quoteLines([{ t: 0, text: '字'.repeat(120) }]);
  assert.ok(long.length <= 47, `截断后长度 ${long.length}`);
  assert.ok(long.endsWith('…'));
});

test('歌词缓存：清得掉、数得对，清完不影响再查', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-lyric-'));
  const store = new LyricStore(dir);
  assert.deepEqual(store.stat(), { files: 0, bytes: 0 });
  assert.equal(store.clear().files, 0);

  // 手工落一份，模拟查过
  const doc = {
    source: 'netease', id: '1496602290', title: '是但求其爱', artist: '陈奕迅',
    lines: [{ t: 0, text: '一句' }], instrumental: false, fetchedAt: Date.now(),
  };
  mkdirSync(join(dir, 'lyrics'), { recursive: true });
  writeFileSync(join(dir, 'lyrics', 'netease-1496602290.json'), JSON.stringify(doc), 'utf8');

  assert.equal(store.stat().files, 1);
  assert.equal(store.read('netease', '1496602290').title, '是但求其爱');
  assert.equal(store.clear().files, 1);
  assert.deepEqual(store.stat(), { files: 0, bytes: 0 });
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 「打炉石时让路」靠的就是这个探测。它错了只有两种后果，两种都难看：
 * 认不出来 → 开关形同虚设；乱认一气 → 她整场不说话，而且没人知道为什么。
 */
test('对端进程探测：认得出在跑的，也认得出不在的', async (t) => {
  if (process.platform !== 'win32') return t.skip('只测 Windows（tasklist）');

  resetPeerCache();
  assert.equal(await isPeerRunning(['definitely-not-a-real-process-xyz.exe']), false, '不存在的进程必须判 false');

  resetPeerCache();
  assert.equal(await isPeerRunning(['node.exe']), true, '测试自己就跑在 node 里，认不出来就是坏了');
});

test('事件正文里不许塞现成句子 —— 给了她就照着念', async () => {
  // 2026-10-28 实测：stateAngle('soft') 里写着
  //   「"眼皮往下掉""听着听着就不想动了"都说得出口」
  // 她 21:43:18 一字不差地说了「这首软得我眼皮往下掉」。
  //
  // 同类错误这是第三次：SEGMENT_ASK 给过一张「第几首、连着多久、几点」的填空表，
  // 她连着 9 首填同一个格式；再早是「你吃不吃这一套」变成「我吃」。
  // 规律一样 —— **给格式她就填格式，给句子她就当台词**。所以拿测试盯着：
  // 这段文案里不许再出现引号包起来的成句示范。
  const soft = stateAngle('soft');
  assert.doesNotMatch(soft, /["“][^"”]{4,}["”]/, `柔歌那段又塞了现成句子：${soft}`);
  assert.match(soft, /可以困/, '不许说困的许可要留着，否则她又不敢困了');

  const hard = stateAngle('hard');
  assert.doesNotMatch(hard, /["“][^"”]{4,}["”]/, `烈歌那段也塞了：${hard}`);
});

test('尾声提示不许带催促词 —— 那是「快到头了」十连的源头', async () => {
  // 一晚上十次「快到头了 / 快收了 / 快完了」，源头是段位文案里的「尾奏快了」。
  // 段位是事实，催不催是她自己的判断。
  const line = PHASE_NOTE.outro ?? '';
  assert.ok(line, '找不到 outro 那一行');
  assert.doesNotMatch(line, /快/, `尾声文案里又写"快"了：${line.trim()}`);
});

test('连听二十分钟以上，柔歌副歌改成坐下来哼 —— 姿势这种事她不会自己想', () => {
  // 2026-10-29 实测：柔档给了「坐着哼」7 次机会，一次都没被挑中。
  // 原因和当初的「应援」一样 —— 它的差别是「坐着」，那是**姿势**，
  // 她的句子永远不会提到坐，所以在候选里永远竞争不过「跟着哼」。
  // 这类「代码知道、她想不到」的信息，必须由代码直接排第一。
  assert.match(moveCue('soft', 'chorus'), /跟着哼/, '没连听很久时还是站着哼');
  assert.match(moveCue('soft', 'chorus', '', true), /坐着哼/, '连听 20 分钟以上该坐下');

  // 但开头和收尾不受影响：`enjoy` 是睡意开关，换成坐姿会打断"该困"的判断
  assert.match(moveCue('soft', 'intro', '', true), /闭眼听/, '开头还是要闭眼听');
  assert.match(moveCue('soft', 'outro', '', true), /闭眼听/, '收尾还是要闭眼听');
  // 别的路数不受影响
  assert.match(moveCue('hard', 'chorus', '', true), /蹦迪/, '烈的歌不该因为坐得久就改成坐');
});

test('没标路数、字面也猜不出的歌，也必须给动作 —— 空值等于「桌宠坏了」', () => {
  // 2026-10-29 另一台机器实测：他原话「我的桌宠直接不做动作了」。
  // 根因是 `plain` 被当成「这首淡，不该动」，而不是「未知」——
  // vibe.ts 自己写着「sure=false 时 feel 一定是 plain，调用方要按未知处理」，
  // 而动作这一侧却 return ''，于是整首歌一个动作都没有。
  // 连带伤害：lastMove 不更新，避让机制整条失效（下一段仍给同一个首选）。
  for (const phase of ['intro', 'verse', 'chorus', 'bridge', 'outro']) {
    assert.ok(moveIdOf('plain', phase), `plain/${phase} 没有动作`);
  }
  assert.ok(moveIdAny('plain', null), 'plain 在位置未知时也没有动作');
  assert.equal(fallbackMove('plain'), 'tap', 'plain 的兜底动作丢了');

  // 避让必须能换：连着两次不给同一个
  const first = moveIdAny('plain', null, '');
  const second = moveIdAny('plain', null, first);
  assert.ok(second && second !== first, `plain 上避让失效：${first} → ${second}`);

  // 但「未知」不该被当成某一档：给的是中性动作，不是烈的蹦迪、也不是柔的闭眼听
  assert.equal(moveCue('plain', 'chorus'), '打拍子', '未知曲风不该给带路数色彩的动作');
});

test('表情那一格空了，动作候选也得发出去 —— 两个是独立的两件事', () => {
  // 2026-10-29 另一台机器实测：换歌事件「正文只有表情、没有动作候选」。
  // 根因是 `const emoji = primary ? ... : ''` —— 表情为空就把整段吞了。
  // 表情来自 POOL[feel][slot]，未知曲风时那一格可能是空的，而动作本来还有得给。
  const t = choiceText(['打拍子', '律动'], '');
  assert.match(t, /【打拍子】【律动】/, '候选没发出去');
  assert.doesNotMatch(t, /比如【, /, '没有表情时不能拼出【, 打拍子】这种空表情的示例');
  assert.match(t, /直接写【打拍子】/, '应该告诉她只写动作就行');

  // 有表情时行为不变
  const t2 = choiceText(['打拍子'], '开心');
  assert.match(t2, /比如【开心, 打拍子】/);
});

test('开音乐那条要带上「今天已经听了多少」——不然她按聊天记录算「一天没见」', async () => {
  // 2026-10-29 实测：他下午听了六个多小时、一百二十多首，晚上打开音乐、戳她一下，
  // 她回「一天没见，你戳我这一下挺客气」。她明明查得出下午听了什么，但这个时刻
  // 手上只有「距上一次听歌 0 秒」——数字在那儿，却没连到"我们今天一起待过"。
  const { world, cleanup } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = { app: 'QQMusic.exe', title: '慢慢喜欢你', artist: '莫文蔚', album: '' };
    world.tracker = { state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 0, indexInSession: 1 }) };
    const at = Date.UTC(2026, 9, 29, 12, 6, 0);   // 20:06 GMT+8

    // 先造「今天已经听完两首」的记录
    const day = localDay('Asia/Shanghai', at);
    for (let i = 0; i < 2; i += 1) {
      world.store.append(day, {
        ts: at - 3_600_000 + i * 300_000, end: at - 3_300_000 + i * 300_000,
        app: 'QQMusic.exe', title: `第${i + 1}首`, artist: '周杰伦', album: '', ms: 300_000,
      });
    }

    await world.emit({ kind: 'start', track, silenceMin: 0 }, at);
    const text = events.at(-1).text;
    assert.match(text, /打开音乐/);
    assert.match(text, /今天已经听了 2 首/, `开音乐时要报今天的量：${text}`);
    assert.match(text, /10 分钟/, '时长也要给，不然只有"几首"没有分量');
  } finally {
    cleanup();
  }
});

test('今天一首都没听完时，不硬报「听了 0 首」', async () => {
  const { world, cleanup } = probeWorld();
  try {
    const events = [];
    world.host = { log: noopLog, pushEvent: async (e) => { events.push(e); } };
    const track = { app: 'QQMusic.exe', title: 'A', artist: 'B', album: '' };
    world.tracker = { state: () => ({ track, sessionStartedAt: 1, sessionPlayedMs: 0, indexInSession: 1 }) };
    await world.emit({ kind: 'start', track, silenceMin: 5 }, Date.UTC(2026, 9, 29, 1, 0, 0));
    const text = events.at(-1).text;
    assert.match(text, /打开音乐/);
    assert.ok(!/今天已经听了/.test(text), `没有记录时别编一个 0 出来：${text}`);
  } finally {
    cleanup();
  }
});

test('标题带版本尾巴、歌手差一个字，也要认得出来 —— 不然整首歌没词', () => {
  // 2026-10-29 实测：《初恋 (First Love) (エンディング Ver.9.0|フルコーラス)》
  // 查不到词，曲库里那条叫「初恋」。两处叠加把它判死了：
  //   1. 标题带一长串版本标记 → 只能靠 includes 得 70，再被扣 10；
  //   2. 我们这边歌手「早見沙織、高垣彩陽」，曲库「早見沙織/高垣彩阳」——
  //      norm 把分隔符删干净后成了两串不同的字，差一个「阳/陽」，-60 判死。
  const want = { title: '初恋 (First Love) (エンディング Ver.9.0|フルコーラス)', artist: '早見沙織、高垣彩陽', app: 'QQMusic.exe' };
  const hit = { title: '初恋', artist: '早見沙織/高垣彩阳', source: 'qq', durSec: 0 };
  assert.ok(matchScore(hit, want) >= 70, `版本尾巴+繁简差异把匹配判死了：${matchScore(hit, want)}`);

  // 但放宽不能放到乱配：歌手完全不同的还是要死
  const wrong = { title: '初恋', artist: '某翻唱歌手', source: 'qq', durSec: 0 };
  assert.ok(matchScore(wrong, want) < 70, '歌手完全不同还放过去，就会评错歌的词');

  // 标题中间的括号是歌名的一部分，不该被摘掉
  const mid = { title: '在某处 (Live)', artist: 'A', source: 'qq', durSec: 0 };
  const wantMid = { title: '在某处 (Live)', artist: 'A', app: 'QQMusic.exe' };
  assert.ok(matchScore(mid, wantMid) >= 100, '完全同名的反而不该被扣分');
});

/* ================= 自动深听的时间窗 ================= */

test('自动深听：换歌只等 30 秒，不是等满一整个间隔', () => {
  const every = 120;
  const t0 = 1_000_000;
  // 换歌那一刻：记下曲目，但不立刻听（尾巴还是上一首的）
  let st = autoHearDue({ key: '', at: 0, lastAt: 0 }, t0, 'A', every);
  assert.equal(st.due, false);
  assert.equal(st.key, 'A');
  assert.equal(autoHearDue(st, t0 + 5_000, 'A', every).due, false);
  // 30 秒到点。原来的实现要等满 120 秒，一首 3 分钟的歌就只听得见一段。
  st = autoHearDue(st, t0 + 30_000, 'A', every);
  assert.equal(st.due, true, '一首 3 分钟的歌必须能在第 30 秒听到第一段');
});

test('自动深听：同一首按间隔来，没到点只记时间不重听', () => {
  const every = 120;
  const t0 = 1_000_000;
  const st = { key: 'A', at: t0, lastAt: t0 };
  assert.equal(autoHearDue(st, t0 + 119_000, 'A', every).due, false);
  assert.equal(autoHearDue(st, t0 + 120_000, 'A', every).due, true);
});

test('自动深听：关着（0）就一次都不跑，云端每段都是钱', () => {
  const st = { key: 'A', at: 0, lastAt: 0 };
  assert.equal(autoHearDue(st, 9_999_999, 'A', 0).due, false);
  assert.equal(autoHearDue(st, 9_999_999, 'B', 0).due, false);
});

test('自动深听：声音在变就提前听，不用等满兜底间隔', () => {
  const every = 120;
  const t0 = 1_000_000;
  const st = { key: 'A', at: t0, lastAt: t0 };
  // 70 秒后能量跳了一下（实测 P75 是 0.17，这里取明显超出的值）→ 提前听，不等 120 秒
  const early = autoHearDue(st, t0 + 70_000, 'A', every, 0.25);
  assert.equal(early.due, true, '编曲变了就该凑近听');
  assert.equal(early.why, 'drift', '触发原因要能说出来，不然调参数时瞎猜');
  // 只是轻微抖动 → 还是等兜底，不烧那十几秒
  assert.equal(autoHearDue(st, t0 + 70_000, 'A', every, 0.03).due, false);
});

test('自动深听：能量一直高也不会连着跑，两次之间至少 60 秒', () => {
  const every = 120;
  const t0 = 1_000_000;
  const st = { key: 'A', at: t0, lastAt: t0 };
  // 40 秒：比 30 秒硬下限已经过了，但能量触发的冷却还没到
  assert.equal(autoHearDue(st, t0 + 40_000, 'A', every, 0.5).due, false, '实测 18:56 那两次首尾相接，CPU 是被吃满的');
  assert.equal(autoHearDue(st, t0 + 60_000, 'A', every, 0.5).due, true);
});

test('自动深听：能量跳得再厉害，两次之间也不许短于 30 秒', () => {
  const every = 120;
  const t0 = 1_000_000;
  const st = { key: 'A', at: t0, lastAt: t0 };
  assert.equal(autoHearDue(st, t0 + 10_000, 'A', every, 0.5).due, false, '刚听完十秒，跳得再猛也不能连跑分离模型');
});

/* ================= 复读检测：把「她说过什么」还给代码 ================= */

test('复读检测：同一个开头用到三次就点出来，标点切开的也算同一句', () => {
  const says = [
    '【平静】这个点了还在放着呢。',
    '一开口就停住不往下说。',
    '【思考】这个点了还在放，窗外一点声都没有。',
    '这个点了还在放，你也不困。',
    '这首还长，我听着。',
  ];
  const hint = repeatHint(says);
  assert.match(hint, /这个点了还在/, '三句都是同一个开头，前六个字都一样');
});

test('复读检测：只碰两次不判——真实数据里炉石那张牌就是这么误报进来的', () => {
  const says = [
    '龙鳞军备先抽一张。',
    '龙鳞军备先留着。',
    '诺兹多姆上场了。',
    '这张存着吧。',
  ];
  assert.equal(repeatHint(says), '', '同一张牌在不同回合说两次，不是复读');
});

test('复读检测：句尾定型也要抓，那是「我不催你」藏身的地方', () => {
  const says = [
    '这首还长，我不催你。',
    '后面随你的意思来，我不催你。',
    '你放到几点都行，我不催你。',
    '鼓在底下走得很稳。',
  ];
  assert.match(repeatHint(says), /这个收尾用过 3 次/, '开头各不相同，只有句尾一样');
});

test('复读检测：六成以上在引词，就叫她换个走法', () => {
  const says = [
    '「过去的誓言」这半句唱得不用力。',
    '「五千年」这么大的词，换个人写就假。',
    '「永远是什么」这一问，比情话狠。',
    '这首慢，气一直吊着。',
    '「不愿走的你」把我绊了一下。',
  ];
  assert.match(repeatHint(says), /别引词/);
});

test('复读检测：没重复就一个字都不说', () => {
  const says = [
    '这首慢，气一直吊着。',
    '鼓在底下走得很稳。',
    '你今晚没打算停啊。',
  ];
  assert.equal(repeatHint(says), '');
});

test('复读检测：不到三句不判，证据不够就不下结论', () => {
  assert.equal(repeatHint(['这个点了还在放。', '这个点了，窗外没声了。']), '');
  assert.equal(repeatHint([]), '');
});

test('复读检测：表情标记和动作标记不算进开头', () => {
  const says = [
    '【喜欢, 跟着哼】这首还长着呢，慢慢听。',
    '<happy>这首还长着呢，别急。',
    '【思考】这首还长着呢，我坐得住。',
  ];
  assert.match(repeatHint(says), /这首还长着呢/);
});

test('复读检测：全句都加破折号时，点出来', () => {
  const says = [
    '「过去的誓言」——唱得不用力。',
    '「五千年」——换个人写就假。',
    '「永远是什么」——这一问狠。',
    '这首慢——气一直吊着。',
  ];
  const hint = repeatHint(says);
  assert.match(hint, /破折号|别引词/);
});

test('复读检测：人格语气词「库」不算句尾指纹', () => {
  // Mr.Q 原话：「库正常这是她原人格用的句末语气词」——拿它判重等于拿人格当缺陷修。
  assert.equal(sayShape('《山丘》，李宗盛。我一点儿没走神，库。').tail, '儿没走神');
  assert.equal(sayShape('「一切有尽头」唱得挺平静，库...').tail, '得挺平静');
  assert.equal(sayShape('这首慢，气一直吊着啦。').tail, '一直吊着');
});

test('复读检测：语气词一样但内容不同，不判重', () => {
  const says = [
    '这首还长，我一点儿没走神，库。',
    '鼓在底下走得很稳，库。',
    '这段我坐着听完，库。',
    '外面天黑了，库。',
  ];
  assert.equal(repeatHint(says), '', '四句都带「库」，但它们不是同一句话');
});

test('复读检测：剥掉语气词之后，「我不催你」这种真复读还是要抓', () => {
  const says = [
    '这首还长，我不催你，库。',
    '后面随你的意思来，我不催你。',
    '你放到几点都行，我不催你啦。',
  ];
  assert.match(repeatHint(says), /我不催你/);
});

/* ================= 欢快的柔：不许坐下、不许困 ================= */

test('欢快的柔认得出：曲风名说了算，不是能量', () => {
  // 柔的 BPM 中位 94.3、烈 94.5，两者分布重叠 —— 拿能量分不开，只能看曲风名
  assert.equal(isLivelySoft('soft', '华语流行', { bpm: 80, rms: .02, bass: .01, mid: .01, high: .001 }), true, '流行哪怕 BPM 低也算欢快');
  assert.equal(isLivelySoft('soft', '抒情流行', null), false, '带「抒情」的先归慢的那一类');
  assert.equal(isLivelySoft('soft', '钢琴抒情', null), false);
  assert.equal(isLivelySoft('soft', '日式摇滚', null), true);
  assert.equal(isLivelySoft('soft', '', { bpm: 110, rms: .04, bass: .02, mid: .02, high: .004 }), true, '曲风名看不出时用 BPM 弱判');
  assert.equal(isLivelySoft('soft', '', { bpm: 88, rms: .04, bass: .02, mid: .02, high: .004 }), false);
  assert.equal(isLivelySoft('hard', '华语流行', null), false, '只对柔这一档生效');
});

test('欢快的柔不给坐姿动作 —— 坐下有 60% 概率睡着', () => {
  const calmo = moveIdOf('soft', 'outro', '', false, false);
  const vivo = moveIdOf('soft', 'outro', '', false, true);
  assert.equal(calmo, 'enjoy', '慢柔的收尾还是闭眼听');
  assert.notEqual(vivo, 'enjoy', '欢快的柔不许闭眼听（那个动作会让身体坐下）');
  assert.equal(fallbackMove('soft', true) !== 'enjoy', true, '位置未知时也不给闭眼听');
  assert.equal(fallbackMove('soft', false), 'enjoy');
});

test('欢快的柔：候选里一个坐姿都不许有', () => {
  const choices = moveChoices('soft', '', true);
  for (const sit of ['闭眼听', '坐着哼', '捂耳朵听']) {
    assert.ok(!choices.includes(sit), `候选里不该出现【${sit}】`);
  }
});

test('欢快的柔不许说困', () => {
  assert.match(stateAngle('soft', true), /醒着|不许说困|不许说想睡/, '欢快的柔要走"醒着"那一版');
  assert.match(stateAngle('soft', false), /可以困/, '慢柔照旧可以困');
});
