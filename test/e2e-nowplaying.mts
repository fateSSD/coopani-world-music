/**
 * 端到端探针：真的把桥拉起来，看它能不能在 conhost --headless 下拿到数据。
 * 只用于本地验证，不进扩展包。
 *   node <tsx> e2e.ts
 */
import { NowPlayingBridge } from '../src/nowplaying.ts';

const bridge = new NowPlayingBridge({
  intervalMs: 1000,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
  onTick: (p) => {
    const s = p.sessions[0];
    console.log(`tick ts=${p.ts} n=${p.sessions.length} ${s ? `${s.app} ${s.status} "${s.title}" pos=${s.posSec}` : '(no session)'}`);
  },
});

let ticks = 0;
const orig = bridge.snapshot.bind(bridge);
bridge.start();

const t = setInterval(() => {
  ticks++;
  const h = bridge.health();
  console.log(`t=${ticks}s running=${h.running} pid=${h.pid} lastLineAt=${h.lastLineAt ? Date.now() - h.lastLineAt + 'ms ago' : 'null'} restarts=${h.restarts} err=${h.lastError ?? '-'}`);
  if (ticks >= 8) {
    clearInterval(t);
    bridge.stop();
    console.log('stopped. snapshot sessions =', orig()?.sessions.length ?? 'null');
    setTimeout(() => process.exit(0), 500);
  }
}, 1000);
