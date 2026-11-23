/**
 * mac 读侧的验证。
 *
 * 全部在 Windows 上跑得通：解析、进度推算、命令生成都是纯函数，桥类走注入的假执行器。
 * **这里通过不代表 mac 上能用** —— 真机还有三件事没验（见 `_状态.md`）：
 * MRNowPlayingRequest 在 26.6.2 上是否真给数据、控制命令是否被吞、进程名对不对。
 * 这个文件的职责是「不许把能推出来的东西推错」，不是「证明能用」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DarwinMediaBridge, clampPosition, controlCommand, controlJxa, estimatePosition,
  OSASCRIPT_PATH, parseDarwinTick, pickJsonLine, pickVerdict, rateToStatus, readCommand,
  runDarwinControl,
} from '../src/darwin-media.ts';
import { createMediaBridge } from '../src/media.ts';
import { NowPlayingBridge } from '../src/nowplaying.ts';
import { channels, mediaBridgeKind } from '../src/platform.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------- 纯函数 ----------

test('速率→状态：>0 在放、=0 暂停、拿不到就是未知（不猜）', () => {
  assert.equal(rateToStatus(1), 'playing');
  assert.equal(rateToStatus(0.5), 'playing');
  assert.equal(rateToStatus(0), 'paused');
  assert.equal(rateToStatus(null), 'unknown');
  assert.equal(rateToStatus(undefined), 'unknown');
  assert.equal(rateToStatus(Number.NaN), 'unknown');
});

test('进度推算：播放时按速率前推，暂停/无时间戳/时钟异常时退回原值', () => {
  const now = 1_000_000;
  // 播放中：上报 30 秒前，速率 1 → 位置约 130
  assert.equal(estimatePosition(100, now - 30_000, 1, now), 130);
  // 暂停：rate 0，不推
  assert.equal(estimatePosition(100, now - 30_000, 0, now), 100);
  // 没有时间戳：不推
  assert.equal(estimatePosition(100, null, 1, now), 100);
  // 时间戳在未来（时钟乱）：不推
  assert.equal(estimatePosition(100, now + 5_000, 1, now), 100);
  // 时间戳早得离谱（>1h）：不推
  assert.equal(estimatePosition(100, now - 7_200_000, 1, now), 100);
  // 本来就没有 elapsed
  assert.equal(estimatePosition(null, now, 1, now), null);
});

test('进度截断：超过总长就贴到总长，负值归零', () => {
  assert.equal(clampPosition(300, 250), 250);
  assert.equal(clampPosition(100, 250), 100);
  assert.equal(clampPosition(-5, 250), 0);
  assert.equal(clampPosition(100, null), 100);
  assert.equal(clampPosition(null, 250), null);
  // 总长是 0 或负数时不做截断（流媒体常见 0）
  assert.equal(clampPosition(100, 0), 100);
});

test('挑 JSON 行：前面有杂音也要抓到脚本返回的那一行', () => {
  const stdout = 'perl: warning: Setting locale failed\n{"title":"x"}\n';
  assert.equal(pickJsonLine(stdout), '{"title":"x"}');
  assert.equal(pickJsonLine('   \n  '), null);
  assert.equal(pickJsonLine('只有普通文字'), null);
});

// ---------- 解析 ----------

test('解析：一条完整会话，字段进对了位置', () => {
  const now = 2_000_000;
  const line = JSON.stringify({
    app: 'QQ音乐',
    title: '出现又离开 (2026 再唱版)',
    artist: '那英',
    album: '出现又离开',
    rate: 1,
    duration: 300,
    elapsed: 20,
    ts: now - 10_000,
  });
  const parsed = parseDarwinTick(line, now);
  assert.ok(parsed && 'sessions' in parsed);
  const s = parsed.sessions[0];
  assert.equal(s.app, 'QQ音乐');
  assert.equal(s.via, 'mediaremote');
  assert.equal(s.status, 'playing');
  assert.equal(s.title, '出现又离开 (2026 再唱版)');
  // 标题里的版本后缀不许被"顺手清理"——那是播放器给的原文
  assert.ok(s.title.includes('(2026'));
  assert.equal(s.artist, '那英');
  assert.equal(s.durSec, 300);
  // 上报 10 秒前、速率 1 → 20 + 10
  assert.equal(s.posSec, 30);
  assert.equal(s.canPause, true);
});

test('解析：框架给了 calculatedPlaybackPosition 时优先用，不再外推', () => {
  const now = 2_000_000;
  const line = JSON.stringify({ app: '网易云音乐', title: '长征', rate: 1, duration: 200, elapsed: 5, ts: now - 60_000, pos: 88 });
  const parsed = parseDarwinTick(line, now);
  assert.ok(parsed && 'sessions' in parsed);
  assert.equal(parsed.sessions[0].posSec, 88);
});

test('解析：暂停态不往前推', () => {
  const now = 2_000_000;
  const line = JSON.stringify({ app: 'QQ音乐', title: '某首歌', rate: 0, duration: 200, elapsed: 42, ts: now - 60_000 });
  const parsed = parseDarwinTick(line, now);
  assert.ok(parsed && 'sessions' in parsed);
  assert.equal(parsed.sessions[0].status, 'paused');
  assert.equal(parsed.sessions[0].posSec, 42);
});

test('解析：没在放歌不是错误，给空会话', () => {
  const empty = parseDarwinTick(JSON.stringify({ app: '', empty: true }));
  assert.ok(empty && 'sessions' in empty);
  assert.equal(empty.sessions.length, 0);

  // 没标题的会话对上层没意义（串词、查歌词都要标题）
  const noTitle = parseDarwinTick(JSON.stringify({ app: 'QQ音乐', title: '   ' }));
  assert.ok(noTitle && 'sessions' in noTitle);
  assert.equal(noTitle.sessions.length, 0);
});

test('解析：脚本报错要原样带出来，不能当成"没在放歌"', () => {
  const parsed = parseDarwinTick(JSON.stringify({ error: '这个系统上 MediaRemote 没有 MRNowPlayingRequest' }));
  assert.ok(parsed && 'error' in parsed);
  assert.match(parsed.error, /MRNowPlayingRequest/);
});

test('解析：读不懂的输出返回 null（下一跳再说，不算错误）', () => {
  assert.equal(parseDarwinTick('{"title":'), null);
  assert.equal(parseDarwinTick(''), null);
  assert.equal(parseDarwinTick('not json'), null);
});

test('解析：app 缺失时给一个人能读的占位，不给空串', () => {
  const parsed = parseDarwinTick(JSON.stringify({ title: '某首歌', rate: 1 }));
  assert.ok(parsed && 'sessions' in parsed);
  assert.equal(parsed.sessions[0].app, '未知播放器');
});

// ---------- 命令行 ----------

test('读命令：走系统自带 osascript，脚本里用的是 MRNowPlayingRequest 而不是被封的那个 C 函数', () => {
  const cmd = readCommand();
  assert.equal(cmd.command, OSASCRIPT_PATH);
  assert.deepEqual(cmd.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  const script = cmd.args[3];
  assert.ok(script.includes('MRNowPlayingRequest'), '必须走 ObjC 类，不然 15.4+ 上读出来是空的');
  assert.ok(script.includes('MediaRemote.framework'));
  // 直连那条路在 15.4+ 已封，不许出现在脚本里
  assert.ok(!script.includes('MRMediaRemoteGetNowPlayingInfo'));
});

test('控制命令：暂停发 1、继续发 0、下一首 4、上一首 5（不用 toggle）', () => {
  const valueOf = (action) => {
    const script = controlJxa(action);
    const m = script.match(/sendCommandOptionsCompletion\((\d+),/);
    return m ? Number(m[1]) : null;
  };
  assert.equal(valueOf('pause'), 1);
  assert.equal(valueOf('resume'), 0);
  assert.equal(valueOf('next'), 4);
  assert.equal(valueOf('prev'), 5);
  // toggle(2) 在两个方向都不幂等，一旦状态错开就会反向操作
  assert.ok(!Object.values(['pause', 'resume', 'next', 'prev']).map(valueOf).includes(2));

  const cmd = controlCommand('pause');
  assert.equal(cmd.command, OSASCRIPT_PATH);
  assert.ok(cmd.args[3].includes('MRNowPlayingController'));
});

test('控制结论解析：只认最后一行，error 前缀要能识别', () => {
  assert.equal(pickVerdict('ok'), 'ok');
  assert.equal(pickVerdict('warning\nok\n'), 'ok');
  assert.equal(pickVerdict('error: 拿不到本机播放控制器'), 'error: 拿不到本机播放控制器');
  assert.equal(pickVerdict(''), '');
});

// ---------- 桥 ----------

test('桥：读到一跳就更新快照并回调', async () => {
  const ticks = [];
  const bridge = new DarwinMediaBridge({
    intervalMs: 50,
    onTick: (p) => ticks.push(p),
    run: async () => ({ stdout: JSON.stringify({ app: 'QQ音乐', title: '出现又离开', artist: '那英', rate: 1, duration: 200, elapsed: 10, ts: Date.now() }), stderr: '', failed: false }),
  });
  bridge.start();
  await tick(20);
  bridge.stop();
  assert.equal(ticks.length >= 1, true);
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.title, '出现又离开');
  assert.equal(s.via, 'mediaremote');
  const h = bridge.health();
  assert.equal(h.running, true);
  assert.equal(h.pid, null, 'mac 没有常驻进程可认领');
  assert.equal(h.exe, OSASCRIPT_PATH);
});

test('桥：脚本没输出 → 记错误、running 为 false，但进程不崩', async () => {
  const bridge = new DarwinMediaBridge({
    intervalMs: 50,
    run: async () => ({ stdout: '', stderr: 'execution error: 不能获得类', failed: true }),
  });
  bridge.start();
  await tick(20);
  bridge.stop();
  const h = bridge.health();
  assert.equal(h.running, false);
  assert.match(h.lastError, /不能获得类/);
  assert.equal(bridge.snapshot(), null);
});

test('桥：脚本明确报错 → 不许当成"没在放歌"，要落在 health.lastError', async () => {
  const bridge = new DarwinMediaBridge({
    intervalMs: 50,
    run: async () => ({ stdout: '{"error":"这个系统上 MediaRemote 没有 MRNowPlayingRequest"}', stderr: '', failed: false }),
  });
  bridge.start();
  await tick(20);
  bridge.stop();
  const h = bridge.health();
  assert.match(h.lastError, /MRNowPlayingRequest/);
  assert.equal(h.running, false);
});

test('桥：stop 之后不再发命令', async () => {
  let calls = 0;
  const bridge = new DarwinMediaBridge({
    intervalMs: 20,
    run: async () => {
      calls += 1;
      return { stdout: '{"empty":true}', stderr: '', failed: false };
    },
  });
  bridge.start();
  await tick(30);
  bridge.stop();
  const after = calls;
  await tick(60);
  assert.equal(calls, after);
});

test('桥：空会话也要算"读到了"（没放歌 ≠ 读侧坏了）', async () => {
  const bridge = new DarwinMediaBridge({
    intervalMs: 50,
    run: async () => ({ stdout: '{"app":"","empty":true}', stderr: '', failed: false }),
  });
  bridge.start();
  await tick(20);
  bridge.stop();
  assert.equal(bridge.health().running, true);
  assert.deepEqual(bridge.snapshot().sessions, []);
});

// ---------- 控制 ----------

test('控制：命令送达 + 回读到状态才算 ok，并把真实状态带回去', async () => {
  const result = await runDarwinControl('pause', {
    run: async () => ({ stdout: 'ok', stderr: '', failed: false }),
    verifyDelayMs: 1,
    readBack: async () => ({ ts: Date.now(), sessions: [{ app: 'QQ音乐', via: 'mediaremote', status: 'paused', title: '出现又离开', artist: '那英', album: '', posSec: 30, durSec: 200, canPlay: true, canPause: true, canNext: true, canPrev: true }] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'paused');
  assert.equal(result.title, '出现又离开');
});

test('控制：脚本报错就 ok=false，不许把"发出去了"当成功', async () => {
  const result = await runDarwinControl('next', {
    run: async () => ({ stdout: 'error: 拿不到本机播放控制器', stderr: '', failed: false }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /播放控制器/);
});

test('控制：回读不到状态时，ok 仍为 true 但要说明没确认', async () => {
  const result = await runDarwinControl('next', {
    run: async () => ({ stdout: 'ok', stderr: '', failed: false }),
    verifyDelayMs: 1,
    readBack: async () => ({ ts: Date.now(), sessions: [] }),
  });
  assert.equal(result.ok, true);
  assert.match(result.error, /回读不到/);
});

// ---------- 工厂 ----------

test('工厂：win32 给 SMTC 桥，darwin 给 MediaRemote 桥 —— 平台判断只在 platform.ts', () => {
  assert.equal(mediaBridgeKind('win32'), 'smtc');
  assert.equal(mediaBridgeKind('darwin'), 'mediaremote');
  assert.equal(channels('win32').media, 'smtc');
  assert.equal(channels('darwin').media, 'mediaremote');

  assert.equal(createMediaBridge({ platform: 'win32' }) instanceof NowPlayingBridge, true);
  assert.equal(createMediaBridge({ platform: 'darwin' }) instanceof DarwinMediaBridge, true);
});

test('工厂：mac 上间隔被抬到不低于 1.5 秒（每跳都是一个新进程）', () => {
  const fast = createMediaBridge({ platform: 'darwin', intervalMs: 100 });
  assert.equal(fast.intervalMs >= 1500, true);
  const slow = createMediaBridge({ platform: 'darwin', intervalMs: 5000 });
  assert.equal(slow.intervalMs, 5000);
});
