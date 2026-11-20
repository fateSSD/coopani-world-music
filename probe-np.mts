import { NowPlayingBridge } from './src/nowplaying.ts';
const b = new NowPlayingBridge({ log: (lv, m) => console.log('[log]', lv, m) });
b.start();
const t0 = Date.now();
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const s = b.snapshot();
  if (s && s.playing) { console.log(`第 ${((Date.now()-t0)/1000).toFixed(1)}s 拿到数据`); console.log(JSON.stringify(s, null, 2)); break; }
  if (i === 19) { console.log('15s 内没拿到 playing 数据，最后快照:', JSON.stringify(b.snapshot(), null, 2)); }
}
console.log('health:', JSON.stringify(b.health()));
b.stop();
