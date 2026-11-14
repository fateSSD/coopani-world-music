/**
 * 「记忆存在哪」的自检。
 *
 * 跑法（跟主测试一样，用宿主的 tsx）：
 *   node "E:/Coopanion/resources/app/node_modules/tsx/dist/cli.mjs" --test test/storage.test.mjs
 *
 * 这个功能真正难的不是"能填路径"，而是三个只会在换机器那天才暴露的失败：
 * 1. 换完位置旧记录看不见了（用户以为记忆被搬丢了）；
 * 2. 路径配错了、盘不在，却一声不响地继续写本机（用户以为在同步盘里）；
 * 3. 目录在跑着的时候不见了（拔 U 盘），那一行记录直接丢。
 * 三条都在这里各压一次。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveLayout, sameDir, stillWritable } from '../src/storage.ts';
import { ListenStore } from '../src/history.ts';
import { VibeStore } from '../src/vibe.ts';
import { MUSIC_DEFAULTS, musicConfigGroups } from '../src/config.ts';

const tmp = (tag) => mkdtempSync(join(tmpdir(), `music-store-${tag}-`));

const rec = (title, ts, extra = {}) => ({
  ts,
  end: ts + 200_000,
  app: 'QQMusic.exe',
  title,
  artist: '某人',
  album: '',
  ms: 200_000,
  ...extra,
});

/** 造一个"路径中段是文件"的不可用目录：mkdir 会 ENOTDIR，跟真拔了盘一样写不进去。 */
function blockedPath() {
  const base = tmp('blocked');
  writeFileSync(join(base, 'a-file'), 'x', 'utf8');
  return { base, dir: join(base, 'a-file', 'nested') };
}

test('留空就跟着本机，不算配置过', () => {
  const dir = tmp('empty');
  try {
    const l = resolveLayout(dir, '');
    assert.equal(l.memory, dir);
    assert.equal(l.custom, false);
    assert.equal(l.problem, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('填了目录就真的用它，并且目录会被建出来', () => {
  const local = tmp('local');
  const shared = join(tmp('shared'), '记忆');
  try {
    const l = resolveLayout(local, shared);
    assert.equal(l.custom, true, '填了路径就该用');
    assert.equal(l.memory, shared);
    assert.ok(existsSync(shared), '目录应该被建出来');
    assert.equal(l.problem, null);
    // 新目录是空的 —— 这是"提示"不是"错"，两者必须分开，否则页面上会一直报警。
    assert.ok(l.notice, '空目录要提一句');
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(join(shared, '..'), { recursive: true, force: true });
  }
});

test('填了个用不了的路径：退回本机，并且说清原因', () => {
  const local = tmp('fallback');
  const bad = blockedPath();
  try {
    const l = resolveLayout(local, bad.dir);
    assert.equal(l.memory, local, '用不了就必须退回本机，否则这一整天都记不下来');
    assert.equal(l.custom, false);
    assert.ok(l.problem && l.problem.includes('用不了'), `要给出原因:${l.problem}`);
    assert.equal(l.notice, null);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(bad.base, { recursive: true, force: true });
  }
});

test('换了位置，旧记录还在 —— 读取合并两处', () => {
  const local = tmp('merge-local');
  const shared = tmp('merge-shared');
  try {
    // 旧目录里有一天，新目录里另有一天
    const oldStore = new ListenStore(local);
    oldStore.append('2026-10-27', rec('昨天的歌', 1_000_000));

    const newStore = new ListenStore(shared, local);
    newStore.append('2026-10-28', rec('今天的歌', 2_000_000));

    const merged = newStore.readDays(['2026-10-27', '2026-10-28']);
    assert.deepEqual(merged.map((r) => r.title), ['昨天的歌', '今天的歌'], '旧目录的记录不能因为换了位置就消失');
    assert.deepEqual(newStore.days(), ['2026-10-28', '2026-10-27'], '日期也要取并集');
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test('同一行在两处都有，只算一次', () => {
  const local = tmp('dedup-local');
  const shared = tmp('dedup-shared');
  try {
    const r = rec('重复的歌', 3_000_000);
    // 模拟"旧文件被手动拷进新目录"这种最平常的重复
    mkdirSync(join(local, 'listening'), { recursive: true });
    mkdirSync(join(shared, 'listening'), { recursive: true });
    const line = `${JSON.stringify(r)}\n`;
    writeFileSync(join(local, 'listening', '2026-10-28.jsonl'), line, 'utf8');
    writeFileSync(join(shared, 'listening', '2026-10-28.jsonl'), line, 'utf8');

    const store = new ListenStore(shared, local);
    assert.equal(store.readDay('2026-10-28').length, 1, '同一行合并后只该有一条');
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test('记忆目录忽然写不进去：落到本机，这一行不丢', () => {
  const local = tmp('drop-local');
  const shared = tmp('drop-shared');
  const dayFile = join(shared, 'listening', '2026-10-28.jsonl');
  try {
    const store = new ListenStore(shared, local);
    assert.equal(store.append('2026-10-28', rec('写坏之前', 4_000_000)), true);

    // 把已经写好的那一天的日文件改成只读：等价于盘突然不让写了
    // （拔 U 盘、网盘断线、盘满，最终都表现为"这一行写不进去"）。
    chmodSync(dayFile, 0o444);

    assert.equal(store.append('2026-10-28', rec('写坏之后', 5_000_000)), true, '不该丢记录');
    assert.equal(store.degraded, true, '回落了就要能报出来');

    const titles = store.readDay('2026-10-28').map((r) => r.title);
    assert.deepEqual(titles, ['写坏之前', '写坏之后'], '两条都要读得到');

    const localFile = join(local, 'listening', '2026-10-28.jsonl');
    assert.ok(readFileSync(localFile, 'utf8').includes('写坏之后'), '兜底那一条要落在本机');
  } finally {
    try { chmodSync(dayFile, 0o666); } catch { /* 文件可能已经不在了 */ }
    rmSync(local, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test('曲风档案合并两处，同一个 key 取时间新的', () => {
  const local = tmp('vibe-local');
  const shared = tmp('vibe-shared');
  try {
    const a = new VibeStore(local);
    a.set('歌A|某人', '老标签', 'soft', 1_000);
    a.set('歌B|某人', '只有本机有', 'odd', 1_000);

    const b = new VibeStore(shared, local);
    // 同 key 的更新一条更晚的：应该盖掉本机那份
    b.set('歌A|某人', '新标签', 'hard', 5_000);

    const c = new VibeStore(shared, local);   // 重新构造＝重新合并读
    assert.equal(c.get('歌A|某人').feel, 'hard', '晚的标注要赢');
    assert.equal(c.get('歌A|某人').genre, '新标签');
    assert.equal(c.get('歌B|某人').feel, 'odd', '本机旧档案也要读得到');
    assert.equal(c.size, 2);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test('点「清除」是两处一起清，不是只清新位置', () => {
  const local = tmp('clear-local');
  const shared = tmp('clear-shared');
  try {
    new ListenStore(local).append('2026-10-27', rec('旧目录的歌', 1_000));
    const store = new ListenStore(shared, local);
    store.append('2026-10-28', rec('新目录的歌', 2_000));
    assert.equal(store.days().length, 2);

    store.clearDays();
    assert.equal(store.days().length, 0, '清完两处都该空，否则旧日期会从另一个目录冒出来');
    assert.equal(store.readDays(['2026-10-27', '2026-10-28']).length, 0);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test('配置项真的接上了：默认值、设置页、读取点三处齐全', async () => {
  // 这个项目最容易犯的错就是"声明了没接线"——改完没效果还不报错。
  assert.equal(MUSIC_DEFAULTS().memoryDir, '', '默认必须是空＝跟本机，不能悄悄改到别处');
  const groups = musicConfigGroups();
  const field = groups
    .flatMap((g) => Object.entries(g.schema.properties))
    .find(([k]) => k === 'worlds.music.memoryDir');
  assert.ok(field, '设置页里没有这一项，用户就找不到');
  assert.equal(field[1]['x-path']?.kind, 'directory', '必须是目录选择器，别让人手打路径');

  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.match(src, /cfg\.memoryDir/, 'world.ts 没读这个配置＝改了不生效');
  assert.match(src, /resolveLayout\(/, '没走路径解析，自定义目录不会生效');
});

test('路径比较认得出"其实是一个目录"', () => {
  const d = tmp('same');
  try {
    assert.equal(sameDir(d, d), true);
    assert.equal(sameDir(d, `${d}${join('/')}`), true, '末尾斜杠不该被当成两个目录');
    assert.equal(sameDir(d, join(d, 'sub')), false);
    assert.equal(stillWritable(d), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('网盘冲突副本也要读得到', () => {
  // 两台机器同一天各写过，OneDrive 会留一份 `2026-10-28-电脑名.jsonl`。
  // 只认精确文件名的话，这些行会被静默忽略 —— 而"两台机器接同一份记忆"
  // 正是这个功能存在的理由，在这里漏掉等于功能不成立。
  const dir = tmp('conflict');
  try {
    const listen = join(dir, 'listening');
    mkdirSync(listen, { recursive: true });
    writeFileSync(join(listen, '2026-10-28.jsonl'), `${JSON.stringify(rec('本机写的', 1_000))}\n`, 'utf8');
    writeFileSync(join(listen, '2026-10-28-我的笔记本.jsonl'), `${JSON.stringify(rec('另一台写的', 2_000))}\n`, 'utf8');
    writeFileSync(join(listen, '2026-10-28 (1).jsonl'), `${JSON.stringify(rec('下载副本', 3_000))}\n`, 'utf8');
    // 非日期文件不该被卷进来
    writeFileSync(join(listen, 'music-notes.jsonl'), '', 'utf8');

    const store = new ListenStore(dir);
    assert.deepEqual(store.days(), ['2026-10-28'], '冲突副本不该被算成另一天');
    // readDay 按开始时间排，三个文件各一条，顺序就是写入时间
    assert.deepEqual(
      store.readDay('2026-10-28').map((r) => r.title),
      ['本机写的', '另一台写的', '下载副本'],
      '冲突副本里的记录丢了',
    );

    // 清除时也要一并清掉，否则"清完又冒出来"
    store.clearDays();
    assert.equal(store.readDay('2026-10-28').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
