/**
 * 音频跟拍的自检。
 *
 * 这一块的失败模式是「看起来在跑」：采集进程活着、JSON 也在更新，可页面根本没拿到数。
 * 所以测试要钉三件事——配置项存在、采集脚本在包里、宿主补丁表里有那几条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSIC } from '../src/definition.ts';
import { isProcessAlive } from '../src/nowplaying.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('配置项 audioReactive 默认开着，而且能关', () => {
  const d = MUSIC.defaults();
  assert.equal(d.audioReactive, true, '默认跟拍；关掉是给「不想让她听到所有系统声音」的人');
});

test('采集脚本在包里', () => {
  const p = join(ROOT, 'assets', 'audio', 'probe.ps1');
  assert.ok(existsSync(p), `包里没有采集脚本：${p}`);
  const s = readFileSync(p, 'utf8');
  // 用的是 WASAPI 回环，不是麦克风 —— 这两句掉了就说明被换成了别的东西
  assert.match(s, /IAudioCaptureClient/, '没有回环采集接口');
  assert.match(s, /0x20000/, '没有 LOOPBACK 标志，采到的会是麦克风');
  // 平时只写一个小 JSON；深听请求到来时才落一个临时 WAV，且必须由 request 门控。
  assert.match(s, /coopani-audio\.json|_outPath/, '没有输出路径');
  assert.match(s, /coopani-hearing\.request/, '深听没有请求门控');
  assert.match(s, /if \(!File\.Exists\(req\)\) return;/, '没有请求时也可能写音频');
  assert.match(s, /WritePcm16/, '深听切片写不出 WAV');
  assert.ok(!/\.mp3|\.flac/i.test(s), '只该写临时 WAV，不该转存其他音频格式');
});

test('拍子频率会折回看得舒服的区间', () => {
  // 和 figure.js 里的 beatHz 同一套规则：0.9–2.0Hz。窄得有点反直觉，但正因如此，
  // 被数成两倍速的慢歌（66 BPM → 报 132）会折回 1.1Hz —— 正好是它真正的拍子。
  const beatHz = (bpm) => {
    let f = (Number(bpm) || 69) / 60;
    if (!(f > 0)) f = 1.15;
    while (f > 2.0) f /= 2;
    while (f < 0.9) f *= 2;
    return f;
  };
  assert.ok(Math.abs(beatHz(120) - 2.0) < 1e-9, '120 BPM = 2Hz，正好一拍一晃');
  assert.equal(beatHz(0), 1.15, '没采到就用回原来的 1.15Hz');
  assert.ok(Math.abs(beatHz(132) - 1.1) < 1e-9, '慢歌被数成两倍速时要折回真实拍子');
  assert.ok(beatHz(180) <= 2.0, '180 BPM 要折回来，不然像抽搐');
  assert.ok(beatHz(40) >= 0.9, '40 BPM 要往上一档');
  for (const b of [30, 60, 72, 90, 120, 150, 200, 240]) {
    const f = beatHz(b);
    assert.ok(f >= 0.9 && f <= 2.0, `${b} BPM 落在了 ${f}Hz，超出区间`);
  }
});

test('坐姿慢摇取半拍并限制速度，无音频时退回 0.62Hz', () => {
  const beatHz = (bpm) => {
    let f = (Number(bpm) || 69) / 60;
    if (!(f > 0)) f = 1.15;
    while (f > 2.0) f /= 2;
    while (f < 0.9) f *= 2;
    return f;
  };
  const earHz = (bpm) => {
    const b = Number(bpm) || 0;
    const h = b > 0 ? beatHz(b) * 0.5 : 0.62;
    return Math.min(1.05, Math.max(0.55, h));
  };
  assert.equal(earHz(0), 0.62);
  assert.ok(Math.abs(earHz(132) - 0.55) < 1e-9);
  for (const b of [30, 60, 72, 90, 120, 150, 200, 240]) {
    const f = earHz(b);
    assert.ok(f >= 0.55 && f <= 1.05, `${b} BPM 的坐姿慢摇是 ${f}Hz`);
  }
});

test('采集进程走 conhost --headless 托管，输出路径和 Core PID 都显式传', () => {
  // 2026-10-31 起不再有 assets/audio/launch.ps1：那套「短启动器 + WMI」会在 Core 重启时
  // 弹出一个 Windows Terminal 标签页。现在由 conhost --headless 托管，ConPTY 背面无窗口。
  const world = readFileSync(join(ROOT, 'src', 'world.ts'), 'utf8');
  assert.match(world, /--headless/, '没走无窗口宿主，Core 重启会弹出终端标签页');
  assert.match(world, /'-Out', AUDIO_OUT_FILE/, '输出路径必须显式传，不能指望继承来的 TEMP');
  assert.match(world, /'-ParentPid', String\(process\.pid\)/, '采集进程必须跟随 Core 生命周期');
  assert.doesNotMatch(world, /AUDIO_LAUNCHER_FILE/, '启动器常量应该已经删干净，别留死引用');
  const probe = readFileSync(join(ROOT, 'assets', 'audio', 'probe.ps1'), 'utf8');
  assert.match(probe, /GetProcessById\(_parentPid\)/, '采集进程没有父进程看门狗');
  const buf = readFileSync(join(ROOT, 'assets', 'audio', 'probe.ps1'));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'probe.ps1 没有 BOM，PS 5.1 会读坏中文');
});

test('采集进程自己交 pid，收尸不能只杀宿主', () => {
  // 2026-10-31 实测：杀掉 conhost 之后，它托管的 powershell 仍然活着。
  // Core 手里只有宿主的 pid，于是 watchAudio 每重开一次就漏一个采集进程——
  // 而 Core 还活着，probe 里的 -ParentPid 看门狗永远不会触发。
  const probe = readFileSync(join(ROOT, 'assets', 'audio', 'probe.ps1'), 'utf8');
  assert.match(probe, /WriteAllText\("\$Out\.pid", \[string\]\$PID/, 'probe.ps1 没有把自己的 pid 写出来');
  // 必须写在 Add-Type 之前：编译要几秒，写晚了 Core 认领不到就当没收过尸。
  const pidWriteAt = probe.indexOf('$Out.pid');
  const compileAt = probe.indexOf('Add-Type -TypeDefinition');
  assert.ok(pidWriteAt > 0 && compileAt > 0 && pidWriteAt < compileAt, 'pid 必须赶在 Add-Type 编译之前落盘');

  const world = readFileSync(join(ROOT, 'src', 'world.ts'), 'utf8');
  assert.match(world, /audioHostPid/, '没有把宿主 pid 和采集 pid 分开');
  assert.match(world, /readAudioPid\(\)/, '没有从 <out>.pid 认领采集进程');
  assert.doesNotMatch(
    world,
    /this\.audioPid = child\.pid/,
    '又把宿主 pid 当成采集 pid 了——杀宿主收不到尸',
  );
  // 顺序也要对：先杀采集进程，再杀宿主。
  const stopFn = world.slice(world.indexOf('private stopAudio()'), world.indexOf('private audioPidFile()'));
  const killWorkerAt = stopFn.indexOf('process.kill(workerPid)');
  const killHostAt = stopFn.indexOf('process.kill(hostPid)');
  assert.ok(killWorkerAt > 0, 'stopAudio 没有按 pid 杀采集进程');
  assert.ok(killHostAt > killWorkerAt, '应该先杀采集进程再杀宿主');
});

test('杀进程之前先问一句「这个 pid 还有人吗」', () => {
  // 宿主退出后 pid 会多留一会儿（留着才能收孤儿），那段时间里 Windows 可能已经把号
  // 复用出去了。照着旧值直接 process.kill，杀掉的可能是别人的进程。
  assert.equal(isProcessAlive(process.pid), true, '自己总该是活的');
  // 这个号在 Windows 上不会被分配（pid 是 4 的倍数，且远小于此）。ESRCH 要判成「没了」，
  // 不能因为抛异常就当成「有权限问题所以还活着」。
  assert.equal(isProcessAlive(4_000_000), false, '不存在的 pid 应该判死');

  const world = readFileSync(join(ROOT, 'src', 'world.ts'), 'utf8');
  assert.match(world, /isProcessAlive\(workerPid\)/, '收尸前没有做存活校验');

  // 读取进程那一侧同一个洞：pid 文件里的死号会被认领，然后 exit 分支看见
  // workerPid 有值就当"还活着"直接 return，读取静默失效。
  const nowplaying = readFileSync(join(ROOT, 'src', 'nowplaying.ts'), 'utf8');
  const claim = nowplaying.slice(nowplaying.indexOf('private readWorkerPid()'), nowplaying.indexOf('private poll()'));
  assert.match(claim, /if \(!isProcessAlive\(pid\)\)/, '认领读取进程 pid 时没有校验存活');
});

test('宿主自己退出后，看门狗不能永眠', () => {
  // 原先的判据是「三个句柄都空就 return」。可宿主一退出三者就全空，于是看门狗
  // 从此不再检查，音频跟拍静默失效——动作按最后一拍的节奏一直晃，没人发现。
  const world = readFileSync(join(ROOT, 'src', 'world.ts'), 'utf8');
  assert.match(world, /audioWanted/, '没有显式的「应该跑」标志，句柄全空后就分辨不出该不该重开');
  assert.match(world, /private reopenAudio\(/, '重开逻辑应该收口，别在几处各写一遍');

  const watch = world.slice(world.indexOf('private watchAudio()'), world.indexOf('private reopenAudio('));
  const emptyBranch = watch.match(/!this\.audioChild && !this\.audioHostPid && this\.audioPid === null\)\s*\{([^}]*)\}/);
  assert.ok(emptyBranch, '没找到「三个句柄全空」的分支');
  assert.match(emptyBranch[1], /reopenAudio\(/, '三句柄全空时必须重开，直接 return 等于放弃');

  // 孤儿也要在 exit 里当场收掉：宿主没了但采集还活着，它还在写文件，
  // 光看 mtime 的看门狗永远发现不了。
  assert.match(world, /const orphan = this\.audioPid/, 'exit 里没有收孤儿');

  // 收完还得把 pid 文件删掉，否则下一轮会把它当成"还在跑"重新认领。
  // 2026-10-31 真踩到了：宿主被杀 5 秒后日志又冒出「已认领：<已死的旧 pid>」。
  const exitBlock = world.slice(world.indexOf("child.on('exit'"), world.indexOf("child.on('error'"));
  assert.match(exitBlock, /unlinkSync\(this\.audioPidFile\(\)\)/, 'exit 里没有删 pid 文件，旧号会被重新认领');

  // 认领这一侧也校验一次存活：文件里可能是上一轮留下的号。
  assert.match(world, /if \(!isProcessAlive\(pid\)\)/, '认领 pid 时没有校验存活');
});
