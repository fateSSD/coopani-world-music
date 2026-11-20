import { isPeerRunning, resetPeerCache } from './src/peer.ts';
const cases: [string, string[]][] = [
  ['QQ音乐真名', ['QQMusic.exe']],
  ['带引号', ['"QQMusic.exe"']],
  ['前缀误判 QQ.exe', ['QQ.exe']],
  ['NETEASE 大写', ['NETEASECLOUDMUSIC.EXE']],
  ['不存在', ['NoSuchPlayer.exe']],
  ['空名单', []],
];
for (const [tag, names] of cases) { resetPeerCache(); console.log(tag.padEnd(18), '→', await isPeerRunning(names as string[])); }
