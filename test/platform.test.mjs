/**
 * 平台抽象层的验证。
 *
 * 规矩与炉石扩展那份同源（2026-11-12 那边真机验过），重点只有两件事：
 *
 * 1. **Windows 行为一字不变。** 这是最要紧的 —— 为了让 mac 能用而改坏 Windows，
 *    等于用一个人的问题换另一个人的问题。所以 win32 的每条期望值都按 v1.0.0 的原文钉死。
 * 2. **mac 的分支要能在 Windows 上跑。** 全部用注入参数（platform / home / env），
 *    不读真机环境 —— 否则在 Windows 上根本走不到 darwin 分支。
 *
 * 注意：`channels('darwin')` 这组断言钉的是**真机验过的现状**（2026-11-24 macOS 26.6.2
 * 上读到了歌名、控制命令让播放器真的停了）。以后系统升级把私有接口弄坏时，先改这里 ——
 * 它本来就是用来提醒这件事的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channels, defaultHearingHome, hearingPythonPath, killTreeSpec, localDataRoot, matchesPeerNames,
  mediaSourceNoun, peerProbeCommand, processName, readerNoun, unavailableHint,
} from '../src/platform.ts';

test('数据根目录：Windows 还是 LOCALAPPDATA，缺了回落 homedir（不是 AppData\\Local）', () => {
  assert.equal(localDataRoot('win32', 'C:/Users/x', { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }), 'C:/Users/x/AppData/Local');
  // v1.0.0 是 `process.env.LOCALAPPDATA || homedir()`，这条钉的是那个「||」
  assert.equal(localDataRoot('win32', 'C:/Users/x', {}), 'C:/Users/x');
});

test('数据根目录：mac 是 Application Support', () => {
  assert.equal(localDataRoot('darwin', '/Users/x', {}), '/Users/x/Library/Application Support');
  // mac 上不该混进 Windows 的落点
  assert.ok(!localDataRoot('darwin', '/Users/x', { LOCALAPPDATA: 'C:/x' }).includes('AppData'));
});

test('深听目录：两平台都是固定的 CoopaniMusic/hearing，不写死盘符', () => {
  assert.equal(
    defaultHearingHome('win32', 'C:/Users/x', { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }),
    'C:\\Users\\x\\AppData\\Local\\CoopaniMusic\\hearing',
  );
  assert.equal(
    defaultHearingHome('darwin', '/Users/x', {}),
    '/Users/x/Library/Application Support/CoopaniMusic/hearing',
  );
});

test('深听解释器：Windows 是 Scripts/python.exe，mac 是 bin/python3', () => {
  assert.equal(hearingPythonPath('C:\\h', 'win32'), 'C:\\h\\venv\\Scripts\\python.exe');
  assert.equal(hearingPythonPath('/Users/x/h', 'darwin'), '/Users/x/h/venv/bin/python3');
});

test('列进程的命令：win32 逐字是 tasklist /NH /FO CSV', () => {
  assert.deepEqual(peerProbeCommand('win32'), { command: 'tasklist', args: ['/NH', '/FO', 'CSV'] });
  assert.deepEqual(peerProbeCommand('darwin'), { command: '/bin/ps', args: ['-Ao', 'comm='] });
});

test('进程名按平台归一：调用方永远传带 .exe 的那份', () => {
  assert.equal(processName('Hearthstone.exe', 'win32'), 'Hearthstone.exe');
  assert.equal(processName('Hearthstone', 'win32'), 'Hearthstone.exe');
  assert.equal(processName('Hearthstone.exe', 'darwin'), 'Hearthstone');
  assert.equal(processName('cloudmusic.EXE', 'darwin'), 'cloudmusic');
});

test('Windows 进程匹配：带引号整名，foo.exe 不能命中 oo.exe', () => {
  const csv = '"QQMusic.exe","1234","Console","1","1,234 K"\r\n"oo.exe","9","Console","1","1 K"\r\n';
  assert.equal(matchesPeerNames(csv, ['QQMusic.exe'], 'win32'), true);
  // 原逻辑的隐含前提：子串不算。这条最容易在重写时丢掉
  assert.equal(matchesPeerNames(csv, ['foo.exe'], 'win32'), false);
  assert.equal(matchesPeerNames(csv, ['Hearthstone.exe'], 'win32'), false);
});

test('mac 进程匹配：取路径末段，容忍 .app 与 Helper 派生进程', () => {
  const ps = [
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/Applications/QQMusic.app/Contents/MacOS/QQMusic',
    '/Applications/QQMusic.app/Contents/Frameworks/QQMusic Helper.app/Contents/MacOS/QQMusic Helper',
  ].join('\n');
  assert.equal(matchesPeerNames(ps, ['QQMusic.exe'], 'darwin'), true);
  assert.equal(matchesPeerNames(ps, ['NeteaseMusic.exe'], 'darwin'), false);
  // 末段才算：路径中间出现名字不算
  assert.equal(matchesPeerNames('/Users/x/QQMusic/backup.bin\n', ['QQMusic.exe'], 'darwin'), false);
});

test('杀进程树：Windows 走 taskkill /T，其它平台交回调用方', () => {
  assert.deepEqual(killTreeSpec(4321, 'win32'), { command: 'taskkill', args: ['/PID', '4321', '/T', '/F'] });
  assert.equal(killTreeSpec(4321, 'darwin'), null);
});

test('通道清单：Windows 全通；mac 读侧与控制已真机验通、音频与本地深听还没有', () => {
  const win = channels('win32');
  assert.deepEqual(win, { media: 'smtc', mediaReady: true, control: true, systemAudio: true, localHearing: true });
  const mac = channels('darwin');
  assert.equal(mac.media, 'mediaremote');
  // 2026-11-24 真机（macOS 26.6.2 / M4）：读到歌名、toggle 让播放器真的停了。
  assert.equal(mac.mediaReady, true, '读侧真机验通了，闸才放开');
  assert.equal(mac.control, true, '控制也验通了：命令发出去播放器真的响应');
  assert.equal(mac.systemAudio, false, 'P2 才做：抓系统音频跟拍');
  assert.equal(mac.localHearing, false, 'P2 才做：本机深听环境');
  // 认不出的平台一律不假装能用
  const other = channels('freebsd');
  assert.equal(other.mediaReady, false);
  assert.equal(other.control, false);
});

test('没接通时说人话，不静默', () => {
  // 两个平台都接通了，就没有提示语
  assert.equal(unavailableHint('win32'), '');
  assert.equal(unavailableHint('darwin'), '');
  // 认不出的平台必须说话，不能静默降级
  const hint = unavailableHint('freebsd');
  assert.ok(hint.length > 0);
  assert.ok(!hint.toLowerCase().includes('powershell'));
});

test('读侧名词：Windows 保持原文，mac 不许出现「读取进程」', () => {
  // 这两条钉的是 Windows 回执里的原词，改这里等于改用户已经看惯的说法
  assert.equal(readerNoun('win32'), '读取进程');
  assert.equal(mediaSourceNoun('win32'), '系统媒体会话');
  // mac 每次读取只是一个短期进程，说「读取进程没有在跑」会让人去任务管理器里找不存在的东西
  assert.equal(readerNoun('darwin'), '播放器读取');
  assert.equal(mediaSourceNoun('darwin'), '系统的正在播放');
});
