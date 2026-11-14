/**
 * 深听两条路的自检。
 *
 * 这一块最容易出的错不是崩溃，而是**静默用了另一种方式**：选了云端却没密钥、
 * 选了本地却没装，代码一声不响地退回"只有能量层"，她于是继续装作听得见。
 * 所以测试要钉三件事——请求长什么样、没配好时说什么、累积会不会串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { MUSIC } from '../src/definition.ts';
import {
  HearingStore, buildCloudRequest, createSseReader, extractJson, hearingModeOf,
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
