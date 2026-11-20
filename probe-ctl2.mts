import { runControl, statusText } from './src/control.ts';
import { NowPlayingBridge } from './src/nowplaying.ts';
const b = new NowPlayingBridge();
b.start();
await new Promise((r) => setTimeout(r, 3000));
const show = (tag: string) => { const s = b.snapshot()?.sessions?.[0]; console.log(tag, s ? `${s.status} | ${s.title?.slice(0,28)} | ${s.posSec}/${s.durSec}` : 'null'); };
show('起点 ');
for (const a of ['pause','next','prev','resume'] as const) {
  const r = await runControl(a, 'QQMusic');
  await new Promise((x) => setTimeout(x, 2200));
  console.log(`${a.padEnd(7)}→ ok=${r.ok} raw=${r.status} 中文=${statusText(r.status)} err=${r.error ?? '-'}`);
  show('       ');
}
b.stop();
