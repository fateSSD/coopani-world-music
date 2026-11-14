import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioFeatureAverages, audioFeaturesOf, describeAudioFeatures, suggestGenre } from '../src/genre.ts';
import { VibeStore } from '../src/vibe.ts';

const track = (title, artist, album = '') => ({ title, artist, album });
const tag = (key, genre, feel, extra = {}) => ({ key, genre, feel, ts: 1, ...extra });
const rockAudio = { bpm: 124, rms: 0.1, bass: 0.06, mid: 0.08, high: 0.01 };
const softAudio = { bpm: 68, rms: 0.02, bass: 0.004, mid: 0.015, high: 0.002 };

test('同专辑一首标签就能迁移，且带可解释依据', () => {
  const tags = [tag('a', '后摇', 'soft', { artist: 'Mono', album: 'Hymn', title: 'A' })];
  const got = suggestGenre(track('B', 'Mono', 'Hymn'), tags, null);
  assert.equal(got.source, 'album');
  assert.equal(got.genre, '后摇');
  assert.match(got.reason, /同专辑/);
});

test('同歌手只听一首不外推；两首同向才形成判断', () => {
  const one = [tag('a', '摇滚', 'hard', { artist: 'Queen', album: 'A' })];
  assert.equal(suggestGenre(track('B', 'Queen', 'B'), one, null), null);
  const two = [...one, tag('b', '摇滚', 'hard', { artist: 'Queen', album: 'B', ts: 2 })];
  const got = suggestGenre(track('C', 'Queen', 'C'), two, null);
  assert.equal(got.source, 'artist');
  assert.equal(got.feel, 'hard');
  assert.match(got.reason, /2\/2/);
});

test('歌手标签冲突时要两首以上且至少六成同向', () => {
  const tags = [
    tag('a', '摇滚', 'hard', { artist: 'X', ts: 1 }),
    tag('b', '摇滚', 'hard', { artist: 'X', ts: 2 }),
    tag('c', '抒情', 'soft', { artist: 'X', ts: 3 }),
  ];
  assert.equal(suggestGenre(track('D', 'X'), tags, null).genre, '摇滚');
  const tie = [
    tag('a', '摇滚', 'hard', { artist: 'X', ts: 1 }),
    tag('b', '抒情', 'soft', { artist: 'X', ts: 2 }),
  ];
  assert.equal(suggestGenre(track('D', 'X'), tie, null), null);
});

test('声音近邻至少两个同曲风样本，拒绝远处和单样本', () => {
  const tags = [
    tag('a', '摇滚', 'hard', { artist: 'A', features: rockAudio }),
    tag('b', '摇滚', 'hard', { artist: 'B', features: { ...rockAudio, bpm: 126 } }),
    tag('c', '钢琴小品', 'soft', { artist: 'C', features: softAudio }),
    tag('d', '钢琴小品', 'soft', { artist: 'D', features: { ...softAudio, bpm: 70 } }),
  ];
  const got = suggestGenre(track('新歌', '陌生人'), tags, rockAudio);
  assert.equal(got.source, 'audio');
  assert.equal(got.genre, '摇滚');
  assert.match(got.reason, /2 首/);
  assert.equal(suggestGenre(track('新歌', '陌生人'), tags.slice(0, 1), rockAudio), null);
  const far = { bpm: 42, rms: 0.001, bass: 0, mid: 0.0008, high: 0.0001 };
  assert.equal(suggestGenre(track('新歌', '陌生人'), tags, far), null);
});

test('给模型的声音摘要只说拍子、响度与频段', () => {
  assert.equal(describeAudioFeatures(rockAudio), '约 124 BPM，响度偏强，低音偏重');
  assert.equal(describeAudioFeatures(softAudio), '约 68 BPM，响度中等，频段较均衡');
  assert.match(describeAudioFeatures({ bpm: 90, rms: 0.004, bass: 0.0004, mid: 0.002, high: 0.001 }), /响度偏弱，高频偏亮/);
});

test('音频特征必须有效，均值至少六个采样且换歌清零', () => {
  assert.equal(audioFeaturesOf({ bpm: 0, rms: 0.1, bass: 0, mid: 0, high: 0 }), null);
  assert.equal(audioFeaturesOf(rockAudio).bpm, 124);
  const avg = new AudioFeatureAverages();
  for (let i = 0; i < 5; i++) avg.add('a', rockAudio);
  assert.equal(avg.summary(), null);
  avg.add('a', rockAudio);
  assert.equal(avg.summary().bpm, 124);
  avg.add('b', softAudio);
  assert.equal(avg.count, 1);
  assert.equal(avg.summary(), null);
});

test('标签的歌手、专辑与声音特征随档案重启保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'genre-learn-'));
  try {
    const store = new VibeStore(dir);
    store.set('a', '摇滚', 'hard', 1, { title: 'A', artist: 'X', album: 'Y', features: rockAudio });
    const loaded = new VibeStore(dir).get('a');
    assert.equal(loaded.artist, 'X');
    assert.equal(loaded.album, 'Y');
    assert.equal(loaded.features.bpm, 124);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧档案从 key 补出歌手，但不虚构专辑和声音特征', () => {
  const dir = mkdtempSync(join(tmpdir(), 'genre-legacy-'));
  try {
    writeFileSync(join(dir, 'music-tags.jsonl'), `${JSON.stringify({ key: 'app\u0001歌名\u0001歌手', genre: '摇滚', feel: 'hard', ts: 1 })}\n`, 'utf8');
    const loaded = new VibeStore(dir).all()[0];
    assert.equal(loaded.title, '歌名');
    assert.equal(loaded.artist, '歌手');
    assert.equal(loaded.album, undefined);
    assert.equal(loaded.features, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= 能量变化量（自动深听该不该跑） ================= */

test('能量变化量：段落内部很稳，编曲换了一层就跳起来', () => {
  const a = new AudioFeatureAverages();
  for (let i = 0; i < 16; i += 1) a.add('k', softAudio);
  const steady = a.drift();
  assert.ok(steady !== null && steady < 0.02, '同一个声音一直在放，变化量应该接近 0');

  // 后半段换成摇滚那种量级：鼓、贝斯全进来
  for (let i = 0; i < 8; i += 1) a.add('k', rockAudio);
  const jumped = a.drift();
  assert.ok(jumped !== null && jumped > 0.2, `编曲换层应该明显跳，实测 ${jumped}`);
  assert.ok(jumped > steady, '变了就是变了，不许比稳态还小');
});

test('能量变化量：采样不够就不给数，别拿两三个点瞎算', () => {
  const a = new AudioFeatureAverages();
  for (let i = 0; i < 10; i += 1) a.add('k', softAudio);
  assert.equal(a.drift(), null);
});

test('能量变化量：换歌就清零，不拿上一首的尾巴当这一首的变化', () => {
  const a = new AudioFeatureAverages();
  for (let i = 0; i < 16; i += 1) a.add('A', softAudio);
  for (let i = 0; i < 8; i += 1) a.add('B', rockAudio);
  assert.equal(a.drift(), null, '刚换歌，这一首的采样还不够 16 个，必须返 null');
});
