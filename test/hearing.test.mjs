/**
 * 深听两条路的自检。
 *
 * 这一块最容易出的错不是崩溃，而是**静默用了另一种方式**：选了云端却没密钥、
 * 选了本地却没装，代码一声不响地退回"只有能量层"，她于是继续装作听得见。
 * 所以测试要钉三件事——请求长什么样、没配好时说什么、累积会不会串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MUSIC } from '../src/definition.ts';
import { isPeerRunning, resetPeerCache } from '../src/peer.ts';
import {
  HearingStore, buildCloudRequest, cloudListen, createSseReader, extractJson, hearingModeOf,
  hearingNotice, hearingStatusText, hearingUsable, mergeSlice, normalizeAnswer, sheetShort, sheetText,
} from '../src/hearing.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const slice = (over = {}) => ({
  at: 1_700_000_000_000,
  posSec: 30,
  seconds: 12,
  tonic: 'A 小调',
  chords: ['Am', 'F'],
  melody: ['A4', 'C5'],
  voices: ['人声', '鼓'],
  instruments: [{ name: '钢琴', score: 0.6 }],
  summary: '钢琴铺底，人声在中音区',
  source: 'cloud',
  latencySec: 4.2,
  loose: false,
  ...over,
});

test('深听默认走云端，坏值也退回云端而不是关掉', () => {
  const d = MUSIC.defaults();
  assert.equal(d.hearingMode, 'cloud', '默认必须是云端：本地要下 500MB，不能让人一装就卡在这里');
  assert.equal(d.hearingEverySec, 0, '自动累积默认关：云端每段都是计费调用');
  assert.equal(hearingModeOf('nonsense'), 'cloud');
  assert.equal(hearingModeOf('local'), 'local');
  assert.equal(hearingModeOf(undefined), 'cloud');
});

test('三种模式各有各的说法，缺密钥必须说清怎么办', () => {
  const cloudNoKey = hearingStatusText({ mode: 'cloud', keySet: false, localReady: false, model: 'qwen-omni-turbo' });
  assert.match(cloudNoKey, /密钥/);
  assert.match(cloudNoKey, /本地/);
  assert.match(cloudNoKey, /500MB|500 MB/, '要告诉他本地那条路要下多大');

  const cloudOk = hearingStatusText({ mode: 'cloud', keySet: true, localReady: false, model: 'qwen-omni-turbo' });
  assert.match(cloudOk, /qwen-omni-turbo/);
  assert.doesNotMatch(cloudOk, /还没填/);

  const localMissing = hearingStatusText({ mode: 'local', keySet: true, localReady: false, model: '' });
  assert.match(localMissing, /没装好|还没装好/);
  assert.match(localMissing, /云端/, '本地没装时，得给出"切云端"这条退路');

  const localOk = hearingStatusText({ mode: 'local', keySet: false, localReady: true, model: '' });
  assert.match(localOk, /不联网|不出这台机器/);

  const off = hearingStatusText({ mode: 'off', keySet: true, localReady: true, model: '' });
  assert.match(off, /关着/);
});

test('云端请求是 OpenAI 兼容的音频输入，且必须流式', () => {
  const { url, body } = buildCloudRequest({
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
    model: 'qwen-omni-turbo',
    wavBase64: 'AAAA',
    seconds: 12.3,
  });
  assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(body.stream, true, '带音频的模型基本只支持流式，这里是硬要求');
  assert.deepEqual(body.modalities, ['text']);
  const user = body.messages[1];
  const audio = user.content.find((p) => p.type === 'input_audio');
  assert.ok(audio, '没有 input_audio，云端根本收不到声音');
  assert.match(audio.input_audio.data, /^data:audio\/wav;base64,/);
  assert.equal(audio.input_audio.format, 'wav');
  const text = user.content.find((p) => p.type === 'text').text;
  assert.match(text, /12/, '要告诉它切片多长，不然它会按整首猜');
  assert.match(text, /JSON/i);
  // 禁止编曲式那句在 system 里——两段合起来看，别只看 user。
  assert.match(JSON.stringify(body.messages), /不要推测|不要编造/, '必须明确禁止它编曲式');
});

test('SSE 被切成两半也能拼回来', () => {
  const read = createSseReader();
  let out = '';
  out += read('data: {"choices":[{"delta":{"content":"A 小"}}]}\n');
  // 一行 JSON 被网络切成两块：前半块不该被当成坏行丢掉
  out += read('data: {"choices":[{"delta":{"cont');
  out += read('ent":"调"}}]}\n');
  out += read(': keep-alive\n\n');
  out += read('data: [DONE]\n');
  assert.equal(out, 'A 小调');
});

test('模型套了代码块、加了前言，也能抠出 JSON', () => {
  const obj = extractJson('好的，结果如下：\n```json\n{"tonic":"A 小调","chords":["Am"]}\n```\n');
  assert.equal(obj.tonic, 'A 小调');
  assert.deepEqual(obj.chords, ['Am']);
  assert.equal(extractJson('完全不按格式的一段话'), null);
  // 字符串里带大括号不能把深度算错
  assert.equal(extractJson('{"a":"} 不是结尾"}').a, '} 不是结尾');
});

test('云端答得不规矩：能洗的洗，洗不出来就标成 loose', () => {
  const s = normalizeAnswer(
    '{"tonic":"A 小调","chords":["Am","F","C","G","Dm","Em","Bb"],"voices":["人声","唢呐"],'
      + '"instruments":[{"name":"钢琴","score":82},{"name":"弦乐","score":0.4}],"melody":["A4","C5"],"summary":" 钢琴 铺底 "}',
    { at: 1, posSec: 10, seconds: 12, latencySec: 3 },
  );
  assert.equal(s.chords.length, 6, '和弦最多留 6 个');
  assert.equal(s.instruments[0].score, 0.82, '百分制要折回 0–1');
  assert.equal(s.summary, '钢琴 铺底');
  assert.equal(s.loose, false);

  const loose = normalizeAnswer('这段听着像钢琴独奏，没人声。', { at: 1, posSec: 10, seconds: 12, latencySec: 3 });
  assert.equal(loose.loose, true, '不按格式答要标出来，不能当结构化事实用');
  assert.match(loose.summary, /钢琴独奏/);
  assert.equal(loose.tonic, '不明确');
});

test('同一段重听是替换，不同段是追加', () => {
  const meta = { trackKey: 'qq|歌|歌手', title: '歌', artist: '歌手' };
  const a = mergeSlice(null, meta, slice({ posSec: 30 }));
  const b = mergeSlice(a, meta, slice({ posSec: 31, tonic: 'C 大调' }));
  assert.equal(b.slices.length, 1, '同一段听两次不该记成两条互相矛盾的记录');
  assert.equal(b.slices[0].tonic, 'C 大调', '要留新的那条');
  const c = mergeSlice(b, meta, slice({ posSec: 90 }));
  assert.equal(c.slices.length, 2);
  // 重听那条留下的是**新的**位置（31），不是旧的。
  assert.deepEqual(c.slices.map((s) => s.posSec), [31, 90], '档案按时间排');
});

test('整首档案：调性认多数，和弦去重，乐器说倾向', () => {
  const meta = { trackKey: 'k', title: '歌', artist: '歌手' };
  let sheet = mergeSlice(null, meta, slice({ posSec: 20, chords: ['Am', 'F'], melody: ['A4'] }));
  sheet = mergeSlice(sheet, meta, slice({ posSec: 80, chords: ['F', 'C'], melody: ['C5', 'E4'] }));
  const text = sheetText(sheet);
  assert.match(text, /已深听 2 段/);
  assert.match(text, /调性：A 小调（2\/2 段一致）/);
  assert.match(text, /Am–F–C/, '相邻重复的和弦要合掉');
  assert.match(text, /音域 E4–C5/, '音域要按音名算，不能按字母排');
  assert.match(text, /乐器倾向：钢琴\(0\.60\)/);
  assert.match(text, /倾向，不是鉴定/);
});

test('调性前后打架时不取平均，照实说', () => {
  const meta = { trackKey: 'k', title: '歌', artist: '歌手' };
  let sheet = mergeSlice(null, meta, slice({ posSec: 10, tonic: 'A 小调' }));
  sheet = mergeSlice(sheet, meta, slice({ posSec: 60, tonic: 'C 大调' }));
  assert.match(sheetText(sheet), /前后不一样/);
});

test('一条事件用的一行版不吹牛', () => {
  const meta = { trackKey: 'k', title: '歌', artist: '歌手' };
  assert.equal(sheetShort(null), '', '没听过就一个字都不说');
  const one = mergeSlice(null, meta, slice({ posSec: 10, tonic: '不明确', chords: [], voices: ['鼓'] }));
  assert.match(sheetShort(one), /听过一次/);
  assert.match(sheetShort(one), /鼓/);
});

test('听过几段之后报的是走向，不是最近一段的参数', () => {
  const meta = { trackKey: 'k', title: '歌', artist: '歌手' };
  let sheet = mergeSlice(null, meta, slice({ posSec: 174, tonic: 'F# 大调', chords: [], voices: ['钢琴'] }));
  sheet = mergeSlice(sheet, meta, slice({ posSec: 216, tonic: 'E 大调', chords: [], voices: ['钢琴', '鼓', '贝斯'] }));
  const line = sheetShort(sheet);
  assert.match(line, /听过 2 次/, '要报听过几次');
  assert.match(line, /多了 鼓、贝斯/, '后半段进来的声部就得说进来，这是"陪听"的全部意思');
  assert.match(line, /调性从 F# 大调 走到 E 大调/);
  assert.ok(!/E 大调，钢琴，鼓/.test(line), '末段不能再堆一遍完整参数，只说变化');
});

test('调性连变三次时自曝听岔，不许当成事实报', () => {
  const meta = { trackKey: 'k', title: '歌', artist: '歌手' };
  let sheet = mergeSlice(null, meta, slice({ posSec: 174, tonic: 'F# 大调', voices: ['钢琴'] }));
  sheet = mergeSlice(sheet, meta, slice({ posSec: 216, tonic: 'E 大调', voices: ['钢琴'] }));
  sheet = mergeSlice(sheet, meta, slice({ posSec: 264, tonic: 'A# 小调', voices: ['钢琴'] }));
  const line = sheetShort(sheet);
  assert.match(line, /一直在变/, '三段三个调是模型漂移，不是歌在转调');
  assert.match(line, /听岔了/);
});

test('档案落盘后重启还在，且切换目录后旧档案仍读得到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearing-'));
  const old = mkdtempSync(join(tmpdir(), 'hearing-old-'));
  try {
    const store = new HearingStore(dir);
    store.add({ trackKey: 'k', title: '歌', artist: '歌手' }, slice());
    assert.equal(store.count(), 1);

    const again = new HearingStore(dir);
    const loaded = again.get('k');
    assert.ok(loaded, '重启后档案不该消失');
    assert.equal(loaded.slices.length, 1);
    assert.equal(loaded.slices[0].tonic, 'A 小调');

    // 换记忆目录：新目录读得到，旧目录也读得到——合并，不是二选一。
    const moved = new HearingStore(old, dir);
    assert.ok(moved.get('k'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
});

test('占位「不明确」不会被当成和弦念出来', () => {
  const meta = { trackKey: 'k', title: '歌', artist: '歌手' };
  const sheet = mergeSlice(null, meta, slice({ posSec: 10, chords: ['不明确', 'F#', '不明确', 'C#m'] }));
  const text = sheetText(sheet);
  assert.doesNotMatch(text, /不明确/, '占位词漏进了和弦走向，她照着念就是笑话');
  assert.match(text, /F#–C#m/);
});

test('能用也要报一次：老会话的前缀不会重建，事件是唯一必达的通道', () => {
  const usable = { mode: 'local', keySet: false, localReady: true, model: '' };
  assert.equal(hearingUsable(usable), true);
  const text = hearingNotice(usable, 'b2026-10-31.listen.90');
  assert.ok(text, '能用时必须给一段话，不然老会话里她永远不知道');
  assert.match(text, /music_listen/, '要告诉她用哪个工具');
  assert.match(text, /先调|先 .*music_listen/, '要明确"先听再答"，而不是继续说听不清');
  assert.match(text, /优先于/, '必须点明压过提示词里"不许描述具体声音"那句');
  assert.match(text, /listen\.90/, '带版本号，方便判断新旧');

  // 用不了时不能冒出"能用了"
  const broken = { mode: 'cloud', keySet: false, localReady: false, model: 'qwen-omni-turbo' };
  assert.equal(hearingUsable(broken), false);
  assert.doesNotMatch(hearingNotice(broken, 'b1'), /能用了/);
  // 关掉就什么都别说
  assert.equal(hearingNotice({ mode: 'off', keySet: true, localReady: true, model: '' }, 'b1'), null);
});

test('设置页有这一组，默认值齐全，提示词真的拿到了模式说明', () => {
  const d = MUSIC.defaults();
  const fields = ['hearingMode', 'hearingCloudKey', 'hearingCloudBase', 'hearingCloudModel', 'hearingEverySec'];
  for (const f of fields) assert.ok(f in d, `默认值缺 ${f}`);

  // 配置分组是纯数据，直接读源码比反射更稳：只声明不接线是这套框架最容易骗人的一处。
  const src = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');
  assert.match(src, /id: 'music\.hearing'/);
  for (const f of fields) {
    assert.match(src, new RegExp(`P\\('${f}'\\)`), `设置页没有 ${f} 这一项`);
  }

  const prompt = readFileSync(join(ROOT, 'ENV_PROMPT.md'), 'utf8');
  assert.match(prompt, /\{\{music\.hearing\}\}/, '模式说明没进提示词，她就不知道自己听得见什么');
  assert.match(prompt, /分析结果|算出来的/, '必须说清这是分析不是耳朵');
  assert.match(prompt, /music\.hearing/, '事件表里也要有这条');
});

test('checkSpeechMatch 正常调用 speechNorm 不报错（P0 回归锁定）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-sp-'));
  try {
    const world = MUSIC.create({
      id: 'music', cfg: MUSIC.defaults(), timezone: 'Asia/Shanghai', botName: 'probe',
      botDir: ROOT, packageDir: ROOT, dataDir: dir, repoRoot: ROOT,
      secret: () => '', storeSecret: () => {}, persist: () => {}, restart: async () => {},
    });
    // 注入一条内存歌词缓存，确保代码真实走到 speechNorm(sp.text)（L504）和 speechSim（L517）
    world.lyrics.peek = () => ({
      instrumental: false,
      lines: [{ t: 19, text: '风吹麦浪一片金黄' }],
    });
    const track = { app: 'QQMusic.exe', title: '测试曲', artist: '歌手', album: '' };
    const hit = slice({
      posSec: 20,
      speech: { text: '风吹，麦浪！一片金黄', lang: 'zh', langZh: '中文', confident: false },
    });
    world.checkSpeechMatch(track, hit);
    assert.equal(hit.speech.match, 'match');
    assert.equal(hit.speech.confident, true);

    const tiny = slice({
      posSec: 20,
      speech: { text: '啊！', lang: 'zh', langZh: '中文', confident: false },
    });
    world.checkSpeechMatch(track, tiny);
    assert.equal(tiny.speech.match, 'no-lyric');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Harness 原语（M1-M10）：pushDeferred 切代与进度重算、fidget 不误撤、onHandoffEnded、彻底离线、onEventsSettled 记录与取消仍记账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-hp-'));
  const origFetch = globalThis.fetch;
  let networkCalls = 0;
  let abortCtrl = null;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('cloud-listen.test')) {
      return {
        ok: true,
        status: 200,
        body: null,
        text: async () => {
          abortCtrl?.abort();
          return JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ summary: '吉他前奏', tonic: 'C 大调', chords: ['C', 'G'], melody: [], voices: [], instruments: [] }) } }],
            usage: { prompt_tokens: 80, completion_tokens: 20 },
          });
        },
      };
    }
    networkCalls += 1;
    throw new Error(`测试期内禁止外网访问: ${u}`);
  };
  try {
    const world = MUSIC.create({
      id: 'music',
      cfg: {
        ...MUSIC.defaults(),
        lyricAware: true,
        audioReactive: true,
        hearingMode: 'cloud',
        hearingCloudBase: 'https://cloud-listen.test/v1',
        hearingCloudKey: 'sk-test',
      },
      timezone: 'Asia/Shanghai',
      botName: 'probe',
      botDir: dir,
      packageDir: ROOT,
      dataDir: dir,
      repoRoot: ROOT,
      secret: () => '',
      storeSecret: () => {},
      persist: () => {},
      restart: async () => {},
    });
    const trackA = { app: 'QQMusic.exe', title: '曲 A', artist: '甲', album: '' };
    const trackB = { app: 'QQMusic.exe', title: '曲 B', artist: '乙', album: '' };
    let current = trackA;
    let playedMs = 120_000;
    let livePosSec = 90;
    let liveSegmentsSaid = 3;
    world.tracker = {
      state: () => ({
        track: current,
        playing: true,
        sessionStartedAt: 1,
        sessionPlayedMs: playedMs,
        indexInSession: 1,
        posSec: livePosSec,
        durSec: 200,
        segmentsSaid: liveSegmentsSaid,
      }),
    };
    const deferred = [];
    const pushed = [];
    const withdrawn = [];
    const usages = [];
    let nextCursor = 10;
    world.host = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      pushEvent: async (ev, opts) => {
        const c = ++nextCursor;
        pushed.push({ ev, opts, cursor: c });
        return { cursor: c };
      },
      pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
      withdrawPending: async (c) => { withdrawn.push(c); return true; },
      reportUsage: (u, opts) => { usages.push({ u, opts }); },
    };

    // M8：首段 segment 前即桩住歌词抓取（返回 null 表示本地无缓存且不触发外网），断言测试全程零外网歌词请求
    world.lyrics.peek = () => null;
    world.lyrics.ensure = async () => null;

    // M9：pushDeferred 入队阶段不得提前写入 lastTextAt 与 pushStamps
    await world.emit({
      kind: 'segment', track: trackA, index: 3, fromSec: 30, toSec: 90,
      posSec: 90, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1,
    }, Date.now());
    assert.equal(networkCalls, 0, 'M8: 测试全程不应发起真实歌词请求');
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].opts.trigger, 'piggyback');
    assert.equal(world.pushStamps.length, 0, 'M9: deferred 仅入队不应记入 pushStamps');
    assert.equal(world.lastTextAt, null, 'M9: deferred 仅入队不应更新 lastTextAt');

    // M7：同代次同段时 render() 动态反映当下最新 posSec 与 sessionPlayedMs
    livePosSec = 135;
    playedMs = 240_000;
    const updatedSeg = String(deferred[0].spec.render());
    assert.match(updatedSeg, /2:15 \/ 3:20/, 'M7: render() 应反映最新 posSec 2:15 / 3:20');
    assert.match(updatedSeg, /副歌/, 'M7: render() 应重算最新曲目段落位置');
    assert.match(updatedSeg, /4 分钟/, 'M7: render() 应反映最新连听时长 4 分钟');

    // M9：仅当 onEventsSettled('delivered') 才记录 pushStamps 与 lastTextAt（'discarded' 不记录）
    world.onEventsSettled([{ cursor: 500 }], 'discarded');
    assert.equal(world.pushStamps.length, 0);
    world.onEventsSettled([{ cursor: 501 }], 'delivered');
    assert.equal(world.pushStamps.length, 1);
    assert.ok(typeof world.lastTextAt === 'string');

    // M7：进入下一段（segmentsSaid 变更为 4）或播放代次 playEpoch 变化后（即使后来重放同一首 trackA）必须作废返回 null
    liveSegmentsSaid = 4;
    assert.equal(deferred[0].spec.render(), null, '进入下一段后旧段延迟事件应作废');
    liveSegmentsSaid = 3;
    world.playEpoch += 1;
    assert.equal(deferred[0].spec.render(), null, 'M7: 暂停再恢复递增 playEpoch 后，同曲旧段绝不复活');
    current = trackB;
    assert.equal(deferred[0].spec.render(), null, '切歌后尚未投递的旧段事件应返回 null 自取消');

    // M4 & M5：onHandoffEnded 使用独立 music.handoff 事件并在 render() 时实时重算连听时长
    world.onHandoffEnded();
    assert.equal(deferred.length, 2);
    assert.equal(deferred[1].spec.type, 'music.handoff');
    assert.deepEqual(deferred[1].spec.tags, ['snapshot']);
    assert.match(String(deferred[1].spec.render()), /4 分钟/);
    playedMs = 300_000;
    assert.match(String(deferred[1].spec.render()), /5 分钟/, 'render() 应反映投递当下的最新连听时长');

    // M2：同批 fidget（无曲目 trackKey === ''）与同曲 loop 均不应被新曲 track 事件误撤，只撤其他旧曲目游标
    pushed.length = 0;
    withdrawn.length = 0;
    const keyB = 'QQMusic.exe\u0001曲 B\u0001乙';
    world.pendingCursors = [{ cursor: 99, trackKey: 'QQMusic.exe\u0001旧曲\u0001丙', epoch: 0 }];
    world.lastSampledKey = keyB;
    await world.emit({ kind: 'fidget', skipped: 5, windowMin: 5 }, Date.now());
    const fidgetCursor = pushed[0]?.cursor;
    assert.ok(fidgetCursor, 'fidget 事件已发出');
    await world.emit({ kind: 'loop', track: trackB, count: 2 }, Date.now());
    const loopCursor = pushed[1]?.cursor;
    assert.ok(loopCursor, 'loop 事件已发出');
    await world.emit({ kind: 'track', track: trackB, prev: trackA, prevPlayedMs: 180_000 }, Date.now());
    assert.ok(withdrawn.includes(99), '旧曲目的游标 99 应被撤回');
    assert.ok(!withdrawn.includes(loopCursor), '同曲目的 loop 游标不应被同批 track 误撤');
    assert.ok(!withdrawn.includes(fidgetCursor), 'M2: 无曲目的 fidget 游标绝不应被 track 误撤');

    // M3：异步查词等待期间发生切歌（playEpoch 递增），醒来后的旧曲 emit 应自动放弃不发且不误撤新歌游标
    pushed.length = 0;
    withdrawn.length = 0;
    let resolveLyric;
    world.lyrics.peek = () => undefined;
    world.lyrics.ensure = () => new Promise((r) => { resolveLyric = r; });
    const oldEmitPromise = world.emit({ kind: 'track', track: trackA, prev: trackB, prevPlayedMs: 60_000 }, Date.now());
    // 查词未完成时用户切到 trackB
    world.playEpoch += 1;
    world.lastSampledKey = keyB;
    world.pendingCursors = [{ cursor: 777, trackKey: keyB, epoch: world.playEpoch }];
    resolveLyric({ instrumental: true, lines: [] });
    await oldEmitPromise;
    assert.equal(pushed.length, 0, '切歌后才完成查词的旧歌事件不应再 pushEvent');
    assert.ok(!withdrawn.includes(777), '过期的旧歌 emit 不应撤回新歌的游标 777');

    // M1 & M10：云端深听返回瞬间遇到 abort 时，hearingText 取消落盘，但 listenOnce 内对已消耗云端 usage 照常记账
    abortCtrl = new AbortController();
    const minWav = join(dir, 'fake.wav');
    writeFileSync(minWav, Buffer.alloc(64));
    world.captureWav = async () => ({ ok: true, wav: minWav });
    world.wavSeconds = () => 12;
    const hearOut = await world.hearingText(abortCtrl.signal);
    assert.match(hearOut, /已打断/);
    assert.equal(usages.length, 1, 'M10: 云端返回带 usage 后即使 signal.aborted 也应如实 reportUsage 记账');
    assert.equal(world.hearingSheets.get(keyB), null, '已取消的深听不应写入档案');
    assert.equal(world.hearingCache, null, '已取消的深听不应写入 20 秒缓存');

    const tools = world.tools();
    assert.ok(tools.find((t) => t.name === 'music_now')?.tags.includes('snapshot'));
    assert.equal(tools.find((t) => t.name === 'music_listen')?.interruptible, true);
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第三轮复审（M10/M11/M12/M13/M14/M15）：SSE取消保留usage、segment整段重算不混材、一次性提交仅在delivered、snapshot与简介', async () => {
  const { MusicWorld, MUSIC_DESCRIBE } = await import('../src/world.ts');
  const { MUSIC_DEFAULTS } = await import('../src/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'music-r3-'));
  const origFetch = globalThis.fetch;

  try {
    // M14：MUSIC_DESCRIBE 与 describe.json 对 music.segment / music.handoff 均带 snapshot tags
    const descDisk = JSON.parse(readFileSync(join(ROOT, 'describe.json'), 'utf8'));
    for (const evType of ['music.segment', 'music.handoff']) {
      assert.ok(MUSIC_DESCRIBE.events.find((e) => e.type === evType)?.tags?.includes('snapshot'), `M14: 代码声明 ${evType} 应含 snapshot`);
      assert.ok(descDisk.events.find((e) => e.type === evType)?.tags?.includes('snapshot'), `M14: describe.json ${evType} 应含 snapshot`);
    }

    // M15：package.json 三处简介开头置顶 Coopani 宿主版本要求
    // 2026-11-24 起要同时写明两个平台 —— 只说 Windows 的话，mac 用户在市场上会以为装不了
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.description, /^一起听歌（Windows 10\/11 与 macOS，需 Coopani 0\.2\.16\+）/);
    assert.match(pkg.cortico.locales.zh.description, /^支持 Windows 10\/11 与 macOS[^\n]*需要 Coopani 0\.2\.16\+/);
    assert.match(pkg.cortico.locales.en.description, /^Windows 10\/11 and macOS[^\n]*needs Coopani 0\.2\.16\+/);

    // M10：SSE 流已吐出 usage 后若内容为空或流读取中止，cloudListen 均保留 usage 且 hearingOnce 上报
    const wavFile = join(dir, 'sse.wav');
    writeFileSync(wavFile, Buffer.alloc(64));
    const sseUsageOnly = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":""}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":95,"completion_tokens":12}}\n\n'
      + 'data: [DONE]\n\n',
    );
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sseUsageOnly);
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const emptySseRes = await cloudListen(wavFile, { base: 'https://api.example.com/v1', model: 'qwen-omni-turbo', key: 'sk-test' }, { at: Date.now(), posSec: 10, seconds: 12 });
    assert.equal(emptySseRes.ok, false);
    assert.equal(emptySseRes.usage?.promptTokens, 95, 'M10: SSE 空正文必须保留已解析 usage');

    // SSE 吐出 usage chunk 后读取阶段触发 signal.aborted
    const acStream = new AbortController();
    const sseUsageChunk = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"钢琴"}}],"usage":{"prompt_tokens":110,"completion_tokens":20}}\n\n',
    );
    globalThis.fetch = async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(sseUsageChunk);
        await new Promise((r) => setTimeout(r, 25));
        acStream.abort();
        controller.error(new Error('stream aborted'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const abortSseRes = await cloudListen(wavFile, { base: 'https://api.example.com/v1', model: 'qwen-omni-turbo', key: 'sk-test' }, { at: Date.now(), posSec: 10, seconds: 12 }, acStream.signal);
    assert.equal(abortSseRes.ok, false);
    assert.equal(abortSseRes.usage?.promptTokens, 110, 'M10: SSE 中途取消必须保留已收 usage');

    // M11 / M12 / M13：同一 World 验证
    const world = new MusicWorld({
      cfg: { ...MUSIC_DEFAULTS(), enabled: true, hearingMode: 'cloud', hearingCloudBase: 'https://api.example.com/v1', hearingCloudModel: 'qwen-omni-turbo', hearingCloudKey: 'sk-test', maxSegmentsPerTrack: 3, lyricAware: true },
      dataDir: dir,
      timezone: 'Asia/Shanghai',
      botName: '大肥鱼',
    });
    const pushed = [];
    const deferred = [];
    const usages = [];
    let cursorSeq = 200;
    const track = { app: 'QQMusic.exe', title: '测试歌M', artist: '歌手M', album: '' };
    const trackKeyM = 'QQMusic.exe\u0001测试歌M\u0001歌手M';
    let curPos = 45;
    let curPlayedMs = 60_000;
    world.tracker = {
      state: () => ({ playing: true, track, sessionStartedAt: 500, sessionPlayedMs: curPlayedMs, posSec: curPos, durSec: 200, segmentsSaid: 2, indexInSession: 1 }),
    };
    world.host = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      pushEvent: async (e, opts) => {
        const env = { ...e, cursor: ++cursorSeq, opts };
        pushed.push(env);
        return env;
      },
      pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
      reportUsage: (u, opts) => { usages.push({ u, opts }); },
    };

    // 验证 world.hearingOnce 在取消场景依然上报 SSE usage
    world.captureWav = async () => ({ ok: true, wav: wavFile });
    world.wavSeconds = () => 12;
    const acStream2 = new AbortController();
    globalThis.fetch = async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(sseUsageChunk);
        await new Promise((r) => setTimeout(r, 25));
        acStream2.abort();
        controller.error(new Error('stream aborted'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const hearCancelRes = await world.listenOnce({ at: Date.now(), posSec: 10 }, acStream2.signal);
    assert.equal(hearCancelRes.ok, false);
    assert.equal(usages.length, 1, 'M10: world.hearingOnce 遇 SSE 中途取消但有 usage 时应调用 reportUsage');

    // 先准备 18 条今日记录，触发 milestone（COUNT_MILESTONE = 18）
    const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    for (let i = 0; i < 18; i++) {
      world.store.append(todayKey, { ts: Date.now() - 10_000 - i * 1000, end: Date.now() - i * 1000, app: 'QQMusic.exe', title: `S${i}`, artist: '歌手M', album: '', ms: 180_000 });
    }
    world.lyrics.peek = () => ({
      instrumental: false,
      lines: [
        { t: 40, text: '主歌第一句旧词' },
        { t: 50, text: '主歌第二句旧词' },
        { t: 125, text: '副歌高潮新歌词甲' },
        { t: 135, text: '副歌高潮新歌词乙' },
      ],
    });
    world.lyrics.ensure = async () => null;

    await world.emit({ kind: 'segment', track, index: 2, fromSec: 30, toSec: 60, posSec: 45, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1 }, Date.now());
    assert.equal(deferred.length, 1);
    // M11：入队前绝不消耗里程碑、lastMove、深听摘要标记或写入 vocab-hint.done
    assert.equal(world.milestoneReported, 0, 'M11: 入队前不应提交 milestoneReported');
    assert.equal(world.lastMove, '', 'M11: 入队前不应提交 lastMove');
    assert.equal(existsSync(join(dir, 'vocab-hint.done')), false, 'M11: 入队前不应写入 vocab-hint.done');

    // M12：在投递前推进到 135s 副歌，并写入一条新深听切片 -> render() 按最新段整体重算，不含主歌旧词且拿到新深听与新动作
    curPos = 135;
    curPlayedMs = 1_300_000;
    world.hearingSheets.add({ trackKey: trackKeyM, title: track.title, artist: track.artist }, {
      at: Date.now(), posSec: 135, seconds: 12, tonic: 'G 大调', chords: ['G', 'D'], melody: ['G4'], voices: ['高音人声'], instruments: [{ name: '电吉他', score: 0.9 }], loose: false, source: 'cloud',
    });
    const renderedChorus = String(deferred[0].spec.render() ?? '');
    assert.match(renderedChorus, /副歌/, 'M12: 应更新到副歌位置');
    assert.match(renderedChorus, /副歌高潮新歌词甲.*副歌高潮新歌词乙/, 'M12: 应切用副歌窗口歌词');
    assert.doesNotMatch(renderedChorus, /主歌第一句旧词/, 'M12: 不应混用主歌旧歌词');
    assert.match(renderedChorus, /G 大调/, 'M12: 应纳入最新深听摘要');
    // render() 后仍然未真正 delivered，状态仍不得消耗
    assert.equal(world.milestoneReported, 0, 'M11: render() 阶段仍不应提交 milestoneReported');
    assert.equal(existsSync(join(dir, 'vocab-hint.done')), false, 'M11: render() 阶段仍不应写入 vocab-hint.done');

    // discarded 时销毁待提交闭包，全部保持未消费
    world.onEventsSettled([{ type: 'music.segment', source: 'world:music', senderKey: deferred[0].spec.senderKey, ts: new Date().toISOString(), text: '', origin: 'external', cursor: 901 }], 'discarded');
    assert.equal(world.milestoneReported, 0);
    assert.equal(existsSync(join(dir, 'vocab-hint.done')), false);

    // 重新入队后真实 delivered：一次提交全部状态且记录 pushStamps
    deferred.length = 0;
    curPos = 45;
    await world.emit({ kind: 'segment', track, index: 2, fromSec: 30, toSec: 60, posSec: 45, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1 }, Date.now());
    deferred[0].spec.render();
    world.onEventsSettled([{ type: 'music.segment', source: 'world:music', senderKey: deferred[0].spec.senderKey, ts: new Date().toISOString(), text: 'ok', origin: 'external', cursor: 902 }], 'delivered');
    assert.equal(world.milestoneReported, 18, 'M11: delivered 后应提交 milestoneReported');
    assert.ok(world.lastMove.length > 0, 'M11: delivered 后应提交 lastMove');
    assert.equal(existsSync(join(dir, 'vocab-hint.done')), true, 'M11: delivered 后应落盘 vocab-hint.done');

    // M13：直接 pushEvent 在返回时不得提前写入 pushStamps/lastTextAt，仅 delivered 后写入
    world.pushStamps = [];
    world.lastTextAt = null;
    await world.emit({ kind: 'fidget', skipped: 4, windowMin: 5 }, Date.now());
    assert.equal(pushed.length, 1);
    assert.equal(world.pushStamps.length, 0, 'M13: pushEvent 返回时不应提前写 pushStamps');
    assert.equal(world.lastTextAt, null, 'M13: pushEvent 返回时不应提前写 lastTextAt');
    world.onEventsSettled([pushed[0]], 'discarded');
    assert.equal(world.pushStamps.length, 0, 'M13: discarded 后不应写入 pushStamps');
    await world.emit({ kind: 'fidget', skipped: 5, windowMin: 5 }, Date.now() + 1000);
    world.onEventsSettled([pushed[1]], 'delivered');
    assert.equal(world.pushStamps.length, 1, 'M13: delivered 后才写入 pushStamps');
    assert.ok(typeof world.lastTextAt === 'string');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M19：SSE flush/end 收无尾换行 usage，CRLF、跨块 JSON 与 abort 后都不丢账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-m19-'));
  const origFetch = globalThis.fetch;
  try {
    const directUsage = [];
    const read = createSseReader((u) => directUsage.push(u));
    let out = read('data: {"choices":[{"delta":{"content":"甲"}}]}\r\n\r\n');
    out += read('data: {"choices":[{"delta":{"cont');
    out += read.end('ent":"乙"}}],"usage":{"prompt_tokens":21,"completion_tokens":3}}');
    assert.equal(out, '甲乙', 'CRLF 与跨块 JSON 仍要拼回正文');
    assert.equal(directUsage.length, 1, 'end() 必须冲刷没有尾换行的 usage');
    assert.equal(directUsage[0].promptTokens, 21);

    const flushUsage = [];
    const flushing = createSseReader((u) => flushUsage.push(u));
    flushing('data: {"choices":[],"usage":{"prompt_tokens":22,"completion_tokens":4}}');
    assert.equal(flushUsage.length, 0, '普通 read 仍按完整行解析');
    flushing.flush();
    assert.equal(flushUsage[0]?.promptTokens, 22, 'flush() 单独调用也必须记账');
    assert.equal(flushing.flush(), '', '重复 flush 不得重复记账');
    assert.equal(flushUsage.length, 1);

    const wav = join(dir, 'm19.wav');
    writeFileSync(wav, Buffer.alloc(64));
    const finalLine = `data: ${JSON.stringify({
      choices: [{ delta: { content: '{"summary":"钢琴"}' } }],
      usage: { prompt_tokens: 31, completion_tokens: 5 },
    })}`;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(finalLine));
        controller.close();
      },
    }), { status: 200 });
    const complete = await cloudListen(
      wav,
      { base: 'https://local.invalid/v1', model: 'local-stub', key: 'sk-test' },
      { at: Date.now(), posSec: 10, seconds: 12 },
    );
    assert.equal(complete.ok, true);
    assert.equal(complete.slice?.summary, '钢琴');
    assert.equal(complete.usage?.promptTokens, 31, '完整 usage chunk 没有尾换行也要进结果');

    const ac = new AbortController();
    const usageLine = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 47, completion_tokens: 8 } })}`;
    globalThis.fetch = async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"钢琴"}}]}\r\n\r\n'));
        controller.enqueue(new TextEncoder().encode(usageLine.slice(0, 27)));
        controller.enqueue(new TextEncoder().encode(usageLine.slice(27)));
        // 先让已入队碎块真的被 reader 消费，再模拟网络中断；error 会直接丢弃未读队列。
        await new Promise((r) => setTimeout(r, 25));
        ac.abort();
        controller.error(new Error('local abort stub'));
      },
    }), { status: 200 });
    const aborted = await cloudListen(
      wav,
      { base: 'https://local.invalid/v1', model: 'local-stub', key: 'sk-test' },
      { at: Date.now(), posSec: 10, seconds: 12 },
      ac.signal,
    );
    assert.equal(aborted.ok, false);
    assert.match(aborted.reason, /已打断/);
    assert.equal(aborted.usage?.promptTokens, 47, 'usage 后 abort 必须先 flush 尾部再返回失败');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M12/M17/M18：当前位置 null 不回退旧进度旧相位，动态歌词不跨段凑行', async () => {
  const { MusicWorld } = await import('../src/world.ts');
  const { MUSIC_DEFAULTS } = await import('../src/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'music-m12-m18-'));
  try {
    const track = { app: 'QQMusic.exe', title: '实时窗口', artist: '本地桩', album: '' };
    let posSec = 45;
    let durSec = 200;
    const world = new MusicWorld({
      cfg: { ...MUSIC_DEFAULTS(), lyricAware: true, audioReactive: false },
      dataDir: dir,
      timezone: 'Asia/Shanghai',
      botName: 'probe',
    });
    world.store = { readDay: () => [] };
    world.tracker = {
      state: () => ({
        playing: true, track, sessionStartedAt: 1, sessionPlayedMs: 120_000,
        posSec, durSec, segmentsSaid: 2, indexInSession: 1,
      }),
    };
    world.lyrics.peek = () => ({
      instrumental: false,
      lines: [
        { t: 40, text: '旧主歌第一行' },
        { t: 50, text: '旧主歌第二行' },
        { t: 125, text: '新副歌唯一一行' },
      ],
    });
    world.lyrics.ensure = async () => null;
    const deferred = [];
    world.host = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
      pushEvent: async () => { throw new Error('本测试只走 deferred'); },
    };
    await world.emit({
      kind: 'segment', track, index: 2, fromSec: 30, toSec: 60,
      posSec: 45, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1,
    }, Date.now());
    assert.equal(deferred.length, 1);

    posSec = 135;
    const oneLine = String(deferred[0].spec.render());
    assert.match(oneLine, /副歌/);
    assert.match(oneLine, /新副歌唯一一行/);
    assert.doesNotMatch(oneLine, /旧主歌第一行|旧主歌第二行/, '一行新词不得向前补两行旧词');
    assert.equal(deferred[0].spec.render(), oneLine, '重复 render 要稳定且不得消费一次性状态');

    posSec = 180;
    const noLine = String(deferred[0].spec.render());
    assert.doesNotMatch(noLine, /这一段唱的是|旧主歌|新副歌/, '新窗口零行就如实无词，不拿任何旧段填充');

    posSec = null;
    durSec = null;
    const unknown = String(deferred[0].spec.render());
    assert.match(unknown, /放到 位置未知。/);
    assert.doesNotMatch(unknown, /2:15|3:00|3:20|副歌|主歌|尾声/, 'null 不得回退入队旧值或旧相位');
    assert.doesNotMatch(unknown, /旧主歌|新副歌/, '位置未知时也不能拿入队歌词冒充当前窗口');

    posSec = 135;
    durSec = null;
    const noDuration = String(deferred[0].spec.render());
    assert.match(noDuration, /放到 2:15，位置未知。/, '只有时长变 null 也必须明说位置未知');
    assert.doesNotMatch(noDuration, /放到 2:15 \/ 3:20|放到 2:15，副歌/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M16：arm 后 push 异常、切代与让路统一 rollback，后续里程碑不被挡住', async () => {
  const { MusicWorld } = await import('../src/world.ts');
  const { MUSIC_DEFAULTS } = await import('../src/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'music-m16-'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`测试禁止外网：${String(url)}`); };
  let fakeHearthstone = null;
  try {
    const cfg = { ...MUSIC_DEFAULTS(), lyricAware: false, audioReactive: false, yieldToHearthstone: false };
    const world = new MusicWorld({ cfg, dataDir: dir, timezone: 'Asia/Shanghai', botName: 'probe' });
    const track = { app: 'QQMusic.exe', title: '回滚测试', artist: '本地桩', album: '' };
    let currentTrack = track;
    world.store = { readDay: () => Array.from({ length: 18 }, () => ({ artist: '本地桩', title: '旧曲' })) };
    world.tracker = {
      state: () => ({
        playing: true, track: currentTrack, sessionStartedAt: 1, sessionPlayedMs: 120_000,
        posSec: 45, durSec: 200, segmentsSaid: 2, indexInSession: 1,
      }),
    };
    world.host = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      pushDeferred: (spec, opts) => { throw new Error('pushDeferred local fault'); },
      pushEvent: async () => { throw new Error('pushEvent local fault'); },
      withdrawPending: async () => true,
    };
    const signal = {
      kind: 'segment', track, index: 2, fromSec: 30, toSec: 60,
      posSec: 45, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1,
    };
    const emit = () => world.emit(signal, Date.now());
    const assertClean = (label) => {
      assert.equal(world.pendingMilestone, null, `${label}: pendingMilestone 必须释放`);
      assert.equal(world.pendingCommits.size, 0, `${label}: commit 闭包必须释放`);
      assert.equal(world.pendingRollbacks.size, 0, `${label}: rollback 闭包必须释放`);
    };

    await emit();
    assertClean('pushDeferred throw');

    const deferred = [];
    world.host.pushDeferred = (spec, opts) => { deferred.push({ spec, opts }); };
    await emit();
    assert.equal(world.pendingMilestone?.count, 18, '失败后的下一次必须能重新 arm');
    const firstRender = deferred[0].spec.render();
    assert.ok(firstRender);
    assert.equal(deferred[0].spec.render(), firstRender, '重复 render 不应消耗或卡死占位');
    assert.equal(world.pendingMilestone?.count, 18);
    world.onEventsSettled([{ cursor: 800, senderKey: deferred[0].spec.senderKey }], 'discarded');
    assertClean('discarded');

    deferred.length = 0;
    await emit();
    world.playEpoch += 1;
    assert.equal(deferred[0].spec.render(), null, '切代后 render 必须取消');
    assertClean('render 切代');

    deferred.length = 0;
    await emit();
    currentTrack = { app: 'QQMusic.exe', title: '已经切走', artist: '另一位', album: '' };
    assert.equal(deferred[0].spec.render(), null, '切歌后旧曲 render 必须取消');
    assertClean('render 切歌');
    currentTrack = track;

    delete world.host.pushDeferred;
    await emit();
    assertClean('pushEvent throw');

    let cursor = 810;
    world.host.pushEvent = async (ev) => ({ ...ev, cursor: ++cursor });
    await emit();
    assert.equal(world.pendingMilestone?.count, 18, 'pushEvent 失败后也不能挡后续');
    world.onEventsSettled([{ cursor, senderKey: `music.segment:QQMusic.exe\u0001回滚测试\u0001本地桩:1:2` }], 'discarded');
    assertClean('direct discarded');

    // 用临时目录里的本地假进程触发真实 tasklist 让路分支，不碰正在运行的应用。
    const fakePath = join(dir, 'Hearthstone.exe');
    copyFileSync(process.execPath, fakePath);
    fakeHearthstone = spawn(fakePath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    let detected = false;
    for (let i = 0; i < 20 && !detected; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      resetPeerCache();
      detected = await isPeerRunning(['Hearthstone.exe']);
    }
    assert.ok(detected, '本地 Hearthstone.exe 桩必须被进程探测看见');
    cfg.yieldToHearthstone = true;
    let yieldPushes = 0;
    world.host.pushEvent = async () => { yieldPushes += 1; return null; };
    world.host.pushDeferred = (spec, opts) => { yieldPushes += 1; };
    await emit();
    assert.equal(yieldPushes, 0, '让路时不能投递');
    assertClean('让路');
  } finally {
    resetPeerCache();
    if (fakeHearthstone) {
      await new Promise((resolve) => {
        if (fakeHearthstone.exitCode !== null) { resolve(); return; }
        fakeHearthstone.once('exit', resolve);
        fakeHearthstone.kill();
      });
    }
    resetPeerCache();
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M20：提示词有独立歌词隐私护栏，禁止反推心情、关系与在想谁', () => {
  const prompt = readFileSync(join(ROOT, 'ENV_PROMPT.md'), 'utf8');
  const guard = prompt.split(/\r?\n/).find((line) => line.includes('歌词隐私护栏')) ?? '';
  assert.ok(guard, '隐私护栏必须独立成条，不能藏在“看不到选歌动机”里');
  assert.match(guard, /歌词/);
  assert.match(guard, /不得|不许/);
  assert.match(guard, /心情/);
  assert.match(guard, /关系/);
  assert.match(guard, /在想谁/);
});

test('M21：buildSegmentPayload 返回类型静态契约包含 arm/rollback，且行为入口未削弱', () => {
  // 仓库和宿主都没有 TypeScript 编译器；这里用源码类型契约 + 上面真实 render 行为测试做等效检查。
  // 不能把 arm/rollback 改成 any 或删掉来“过检查”：少了任何一个这里立即失败。
  const src = readFileSync(join(ROOT, 'src', 'world.ts'), 'utf8');
  const match = /const buildSegmentPayload = \([\s\S]*?\): \{([\s\S]*?)\} => \{/.exec(src);
  assert.ok(match, '找不到 buildSegmentPayload 的显式返回类型');
  const returns = match[1];
  for (const field of ['commit', 'arm', 'rollback']) {
    assert.match(returns, new RegExp(`${field}: \\(\\) => void`), `返回类型缺 ${field}()`);
  }
  assert.match(returns, /text: string/);
  assert.match(returns, /hasWords: boolean/);
  assert.match(returns, /hasSheet: boolean/);
});

async function makePendingRaceHarness(dir, useDeferred) {
  const { MusicWorld } = await import('../src/world.ts');
  const { MUSIC_DEFAULTS } = await import('../src/config.ts');
  const world = new MusicWorld({
    cfg: { ...MUSIC_DEFAULTS(), lyricAware: false, audioReactive: false },
    dataDir: dir,
    timezone: 'Asia/Shanghai',
    botName: 'probe',
  });
  const track = { app: 'QQMusic.exe', title: '竞态桩', artist: '本地歌手', album: '' };
  let segmentsSaid = 2;
  world.store = { readDay: () => Array.from({ length: 18 }, (_, i) => ({ artist: '本地歌手', title: `旧曲${i}` })) };
  world.tracker = {
    state: () => ({
      playing: true, track, sessionStartedAt: 1, sessionPlayedMs: 120_000,
      posSec: 45, durSec: 200, segmentsSaid, indexInSession: 1,
    }),
  };
  world.lyrics.peek = () => null;
  world.lyrics.ensure = async () => null;
  const pushed = [];
  const deferred = [];
  let cursor = 1000;
  world.host = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    pushEvent: async (ev) => {
      const env = { ...ev, cursor: ++cursor };
      pushed.push(env);
      return env;
    },
    withdrawPending: async () => true,
  };
  if (useDeferred) world.host.pushDeferred = (spec, opts) => { deferred.push({ spec, opts }); };
  const emit = async (index = 2) => {
    segmentsSaid = index;
    await world.emit({
      kind: 'segment', track, index, fromSec: 30, toSec: 60,
      posSec: 45, durSec: 200, phase: 'verse', indexInSession: 1, loopCount: 1,
    }, Date.now());
  };
  return { world, pushed, deferred, emit };
}

function spyPendingAttempt(world, attemptKey) {
  const counts = { commit: 0, rollback: 0 };
  const commit = world.pendingCommits.get(attemptKey);
  const rollback = world.pendingRollbacks.get(attemptKey);
  world.pendingCommits.set(attemptKey, () => { counts.commit += 1; commit?.(); });
  world.pendingRollbacks.set(attemptKey, () => { counts.rollback += 1; rollback?.(); });
  return counts;
}

test('M22：直接事件旧 A delivered/discarded 都只结算自己的 attempt，不碰同 senderKey 新 B', async () => {
  for (const outcome of ['delivered', 'discarded']) {
    const dir = mkdtempSync(join(tmpdir(), 'music-m22-'));
    try {
      const { world, pushed, emit } = await makePendingRaceHarness(dir, false);
      await emit();
      await emit();
      assert.equal(pushed.length, 2);
      assert.equal(pushed[0].senderKey, pushed[1].senderKey, '测试必须复现同曲同段 senderKey 相同');
      const keyA = world.pendingCommitByCursor.get(pushed[0].cursor);
      const keyB = world.pendingCommitByCursor.get(pushed[1].cursor);
      assert.ok(keyA && keyB);
      assert.notEqual(keyA, keyB, '同 senderKey 的两次推送也必须是不同 attempt');
      const a = spyPendingAttempt(world, keyA);
      const b = spyPendingAttempt(world, keyB);

      world.onEventsSettled([pushed[0]], outcome);
      assert.equal(a.commit, outcome === 'delivered' ? 1 : 0, `${outcome}: A commit 次数`);
      assert.equal(a.rollback, outcome === 'discarded' ? 1 : 0, `${outcome}: A rollback 次数`);
      assert.deepEqual(b, { commit: 0, rollback: 0 }, `${outcome}: 旧 A 回执不得结算新 B`);
      assert.equal(world.pendingCommitByCursor.has(pushed[1].cursor), true);
      assert.equal(world.pendingCommits.has(keyB), true);
      assert.equal(world.pendingRollbacks.has(keyB), true);

      world.onEventsSettled([pushed[1]], 'delivered');
      assert.deepEqual(b, { commit: 1, rollback: 0 }, 'B 只能由自己的 cursor 提交');
      assert.equal(world.pendingCommitByCursor.size, 0);
      assert.equal(world.pendingCommits.size, 0);
      assert.equal(world.pendingRollbacks.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('M23：deferred 以唯一 attempt 对账，旧 A delivered/discarded 不串到新 B', async () => {
  for (const outcome of ['delivered', 'discarded']) {
    const dir = mkdtempSync(join(tmpdir(), 'music-m23-'));
    try {
      const { world, deferred, emit } = await makePendingRaceHarness(dir, true);
      await emit();
      await emit();
      assert.equal(deferred.length, 2);
      const keyA = deferred[0].spec.senderKey;
      const keyB = deferred[1].spec.senderKey;
      assert.notEqual(keyA, keyB, 'deferred 没有 cursor，attempt senderKey 必须唯一');
      const a = spyPendingAttempt(world, keyA);
      const b = spyPendingAttempt(world, keyB);

      world.onEventsSettled([{ cursor: 2001, senderKey: keyA }], outcome);
      assert.equal(a.commit, outcome === 'delivered' ? 1 : 0);
      assert.equal(a.rollback, outcome === 'discarded' ? 1 : 0);
      assert.deepEqual(b, { commit: 0, rollback: 0 }, `${outcome}: 旧 deferred A 不得碰到 B`);
      assert.equal(world.pendingDeferredAttempts.has(keyB), true);

      world.onEventsSettled([{ cursor: 2002, senderKey: keyB }], 'delivered');
      assert.deepEqual(b, { commit: 1, rollback: 0 });
      assert.equal(world.pendingDeferredAttempts.size, 0);
      assert.equal(world.pendingCommits.size, 0);
      assert.equal(world.pendingRollbacks.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('M24：withdraw 只有 true 才回滚；false/reject 保留账目，迟到真实 delivered 只 commit 一次', async () => {
  for (const scenario of ['true', 'false', 'reject', 'delivered-before-false', 'discarded-before-reject']) {
    const dir = mkdtempSync(join(tmpdir(), 'music-m24-'));
    try {
      const { world, pushed, emit } = await makePendingRaceHarness(dir, false);
      let finishWithdraw = null;
      if (scenario === 'true') world.host.withdrawPending = async () => true;
      if (scenario === 'false') world.host.withdrawPending = async () => false;
      if (scenario === 'reject') world.host.withdrawPending = async () => { throw new Error('本地撤回失败桩'); };
      if (scenario === 'delivered-before-false') {
        world.host.withdrawPending = () => new Promise((resolve) => { finishWithdraw = () => resolve(false); });
      }
      if (scenario === 'discarded-before-reject') {
        world.host.withdrawPending = () => new Promise((_, reject) => { finishWithdraw = () => reject(new Error('本地延迟拒绝桩')); });
      }
      await emit();
      const cursor = pushed[0].cursor;
      const attemptKey = world.pendingCommitByCursor.get(cursor);
      assert.ok(attemptKey);
      const counts = spyPendingAttempt(world, attemptKey);
      world.withdrawStalePending('');

      if (scenario === 'delivered-before-false') {
        world.onEventsSettled([pushed[0]], 'delivered');
        assert.deepEqual(counts, { commit: 1, rollback: 0 }, `${scenario}: 已投递只能 commit`);
        finishWithdraw();
      } else if (scenario === 'discarded-before-reject') {
        world.onEventsSettled([pushed[0]], 'discarded');
        assert.deepEqual(counts, { commit: 0, rollback: 1 }, `${scenario}: 已丢弃只能 rollback`);
        finishWithdraw();
      }
      await new Promise((resolve) => setImmediate(resolve));

      if (scenario === 'true') {
        assert.deepEqual(counts, { commit: 0, rollback: 1 }, 'withdrawn===true 才能回滚');
        assert.equal(world.pendingCursors.length, 0, 'true: pendingCursors 清理');
        assert.equal(world.pendingCommitByCursor.size, 0, 'true: cursor 映射清理');
        assert.equal(world.pendingCommits.size, 0);
        assert.equal(world.pendingRollbacks.size, 0);
        assert.equal(world.pendingMilestone, null);
        // 已确认撤回的事件绝不可能再 delivered：迟到回执不得复活占位。
        world.onEventsSettled([pushed[0]], 'delivered');
        assert.deepEqual(counts, { commit: 0, rollback: 1 }, 'true: 迟到回执不得复活旧 attempt');
      } else if (scenario === 'delivered-before-false') {
        assert.deepEqual(counts, { commit: 1, rollback: 0 }, `${scenario}: withdraw false 完成后不得二次结算`);
        assert.equal(world.pendingCursors.length, 0);
        assert.equal(world.pendingMilestone, null);
      } else if (scenario === 'discarded-before-reject') {
        assert.deepEqual(counts, { commit: 0, rollback: 1 }, `${scenario}: reject 完成后不得二次结算`);
        assert.equal(world.pendingCursors.length, 0);
        assert.equal(world.pendingMilestone, null);
      } else {
        // false / reject 都不能证明事件没投递：账目必须原样保留，让迟到 delivered 能结算。
        assert.deepEqual(counts, { commit: 0, rollback: 0 }, `${scenario}: 撤回失败不得误丢弃账目`);
        assert.equal(world.pendingCommitByCursor.has(cursor), true, `${scenario}: cursor→attempt 必须保留`);
        assert.equal(world.pendingCursors.length, 1, `${scenario}: 仍要留着等回执/重试`);
        assert.equal(world.pendingMilestone?.ownerKey, attemptKey, `${scenario}: 占位不得提前释放`);

        world.onEventsSettled([pushed[0]], 'delivered');
        assert.deepEqual(counts, { commit: 1, rollback: 0 }, `${scenario}: 迟到真实 delivered 必须 commit`);
        assert.equal(world.pendingCursors.length, 0, `${scenario}: 结算后 pendingCursors 清理`);
        assert.equal(world.pendingCommitByCursor.size, 0, `${scenario}: 结算后 cursor 映射清理`);
        assert.equal(world.pendingCommits.size, 0);
        assert.equal(world.pendingRollbacks.size, 0);
        assert.equal(world.pendingMilestone, null, `${scenario}: 结算后占位清理`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('M24b：撤回 false 后下一轮撤回 true 仍按 cursor 只回滚一次，不泄漏也不二次结算', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-m24b-'));
  try {
    const { world, pushed, emit } = await makePendingRaceHarness(dir, false);
    let calls = 0;
    world.host.withdrawPending = async () => { calls += 1; return calls > 1; };
    await emit();
    const cursor = pushed[0].cursor;
    const attemptKey = world.pendingCommitByCursor.get(cursor);
    const counts = spyPendingAttempt(world, attemptKey);

    world.withdrawStalePending('');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(counts, { commit: 0, rollback: 0 }, '第一次 false 保留账目');
    assert.equal(world.pendingCommitByCursor.has(cursor), true);

    world.withdrawStalePending('');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(counts, { commit: 0, rollback: 1 }, '第二次 true 才回滚');
    assert.equal(world.pendingCursors.length, 0);
    assert.equal(world.pendingCommitByCursor.size, 0);
    assert.equal(world.pendingMilestone, null);

    world.onEventsSettled([pushed[0]], 'delivered');
    assert.deepEqual(counts, { commit: 0, rollback: 1 }, '已撤回的事件迟到 delivered 不得再 commit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M26：未 render 的 deferred 有界回滚；render 后不再按短超时判死', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-m26-'));
  try {
    const { world, deferred, emit } = await makePendingRaceHarness(dir, true);
    world.deferredLeaseMs = 25;
    await emit();
    const keyA = deferred[0].spec.senderKey;
    const a = spyPendingAttempt(world, keyA);
    assert.equal(world.pendingMilestone?.ownerKey, keyA, '入队即占位');

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(a, { commit: 0, rollback: 1 }, '从未 render 的 attempt 到期必须回滚');
    assert.equal(world.pendingMilestone, null, '回滚后占位释放');
    assert.equal(world.pendingCommits.size, 0);
    assert.equal(world.pendingRollbacks.size, 0);
    assert.equal(world.pendingDeferredAttempts.size, 0);
    assert.equal(world.pendingLeases.size, 0, '租约定时器不得残留');

    // render 会撤销租约：同样等过租约时长也不得判死，只能由 settled 结算。
    await emit();
    const keyB = deferred[1].spec.senderKey;
    const b = spyPendingAttempt(world, keyB);
    const text = deferred[1].spec.render();
    assert.ok(text, 'render 后必须有正文');
    // render 会用新闭包替换入队时的占位（先 rollback 旧 arm 再 arm 新 payload），
    // 这次替换是同步的，记下它之后就不允许再有任何结算。
    const afterRender = { ...b };
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(b, afterRender, 'render 后不得按短超时再结算');
    assert.equal(world.pendingMilestone?.ownerKey, keyB, 'render 后的占位不得被租约释放');
    assert.equal(world.pendingCommits.has(keyB), true, 'render 后的 attempt 必须仍等 settled');
    assert.equal(world.pendingLeases.size, 0, 'render 时必须已撤销租约');

    world.onEventsSettled([{ cursor: 5000, senderKey: keyB }], 'delivered');
    assert.equal(world.milestoneReported, 18, '真正 delivered 后必须提交一次里程碑');
    assert.equal(world.pendingMilestone, null);
    assert.equal(world.pendingCommits.size, 0);
    assert.equal(world.pendingRollbacks.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M27：direct archive-only 当场回滚，不留幽灵占位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-m27-'));
  try {
    const { world, emit } = await makePendingRaceHarness(dir, false);
    let rolledBack = 0;
    const setRollback = world.pendingRollbacks.set.bind(world.pendingRollbacks);
    world.pendingRollbacks.set = (key, fn) => setRollback(key, () => { rolledBack += 1; fn(); });
    // 隐藏 World：宿主只归档不投递（contextDelivery=archive-only），永远不会有 delivered 回执。
    world.host.pushEvent = async (ev) => ({ ...ev, cursor: 9001, contextDelivery: 'archive-only' });
    await emit();

    assert.equal(rolledBack, 1, '必须当场回滚占位');
    assert.equal(world.pendingCursors.length, 0, '不得登记游标');
    assert.equal(world.pendingCommitByCursor.size, 0, '不得登记 cursor→attempt');
    assert.equal(world.pendingCommits.size, 0);
    assert.equal(world.pendingRollbacks.size, 0);
    assert.equal(world.pendingMilestone, null, '里程碑占位必须释放');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M28：无游标回执按宿主能力分流——旧宿主假定 delivered 结清，现代宿主当场回滚，都不留幽灵占位', async () => {
  for (const modern of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), `music-m28-${modern ? 'modern' : 'legacy'}-`));
    try {
      // modern=true 时夹具给两参 pushDeferred（现代 deferred/settled 流水线的能力哨兵）
      const { world } = await makePendingRaceHarness(dir, modern);
      world.host.pushEvent = async () => undefined;
      const outcomes = [];
      const settle = world.settlePendingAttempt.bind(world);
      world.settlePendingAttempt = (key, outcome) => { outcomes.push(outcome); settle(key, outcome); };

      await world.emit({ kind: 'loop', track: { app: 'QQMusic.exe', title: '循环桩', artist: '', album: '' }, count: 2 }, Date.now());

      assert.deepEqual(outcomes, [modern ? 'discarded' : 'delivered'],
        `${modern ? '现代' : '旧'}宿主：无游标只结算一次，且结论按能力分流`);
      assert.equal(world.pendingCommits.size, 0, 'commit 闭包不得残留');
      assert.equal(world.pendingRollbacks.size, 0, 'rollback 闭包不得残留');
      assert.equal(world.pendingDeferredAttempts.size, 0);
      assert.equal(world.pendingCursors.length, 0, '无游标不得登记游标');
      assert.equal(world.pendingCommitByCursor.size, 0, '无游标不得登记 cursor→attempt');
      assert.equal(world.pendingMilestone, null, '里程碑占位不得永久锁死');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('M25：deferred 初始 fresh=false、render 变 true 后 arm 与 rollback 都替换', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-m25-'));
  try {
    const { world, deferred, emit } = await makePendingRaceHarness(dir, true);
    await emit(1);
    await emit(2);
    const keyA = deferred[0].spec.senderKey;
    const keyB = deferred[1].spec.senderKey;
    assert.equal(world.pendingMilestone?.ownerKey, keyA, 'A 先占位，B 初始构建必须 fresh=false');

    world.onEventsSettled([{ cursor: 3001, senderKey: keyA }], 'discarded');
    assert.equal(world.pendingMilestone, null);
    const renderedB = String(deferred[1].spec.render() ?? '');
    assert.match(renderedB, /今天已收尾 18 首/, 'A 释放后，B render 必须重新得到里程碑');
    assert.equal(world.pendingMilestone?.count, 18, 'fresh=false→true 后必须重新 arm');
    assert.equal(world.pendingMilestone?.ownerKey, keyB, '占位 owner 必须是 B 当前 attempt');

    await emit(3);
    const keyC = deferred[2].spec.senderKey;
    assert.equal(world.pendingMilestone?.ownerKey, keyB, 'B 已 arm 时 C 不得重复拿里程碑');
    world.onEventsSettled([{ cursor: 3003, senderKey: keyC }], 'discarded');
    assert.equal(world.pendingMilestone?.ownerKey, keyB, 'C 的旧闭包不得误清 B 占位');

    world.onEventsSettled([{ cursor: 3002, senderKey: keyB }], 'discarded');
    assert.equal(world.pendingMilestone, null, 'B discarded 必须调用 render 后的新 rollback，而非初始 false 闭包');

    await emit(1);
    const keyD = deferred[3].spec.senderKey;
    assert.equal(world.pendingMilestone?.ownerKey, keyD, 'B 回滚后下一 attempt 必须能重新 arm');
    world.onEventsSettled([{ cursor: 3004, senderKey: keyD }], 'discarded');
    assert.equal(world.pendingMilestone, null);
    assert.equal(world.pendingDeferredAttempts.size, 0);
    assert.equal(world.pendingCommits.size, 0);
    assert.equal(world.pendingRollbacks.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
