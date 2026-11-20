import { isPeerRunning } from './src/peer.ts';
import { peerProbeCommand, matchesPeerNames, channels, localDataRoot } from './src/platform.ts';

const names = ['QQMusic.exe', 'CloudMusic.exe', 'QQMusic'];
console.log('platform       :', process.platform);
console.log('probe cmd      :', JSON.stringify(peerProbeCommand(undefined, process.platform)));
console.log('peer running   :', await isPeerRunning(names));
console.log('channels       :', JSON.stringify(channels(process.platform)));
console.log('localDataRoot  :', localDataRoot(undefined, process.platform));
