/**
 * 对端扩展对应的程序在不在跑。
 *
 * 为什么需要这一层：两个扩展装在同一个宿主里，各推各的事件，**互相不认识** ——
 * 宿主只给了「往同一个对话推事件」这一条路，没有 world 之间互查状态的接口。
 * 而「打炉石的时候别聊歌」这种需求是真的，进程列表就是唯一不需要跨扩展通信、
 * 也不用改宿主就能拿到的信号。
 *
 * 代价要说清楚：**看到进程 ≠ 正在对局**。炉石挂在后台不动也算在跑，这时音乐同样会安静。
 * 所以它只能躲在用户自己打开的开关后面，不能默认开。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchesPeerNames, peerProbeCommand } from './platform.ts';

const run = promisify(execFile);

/** 缓存时长：tasklist 一次要一两百毫秒，不能每次要判断都跑一遍。 */
const TTL_MS = 15_000;

let lastAt = 0;
let lastHit = false;

/**
 * 名单里任一进程在跑就返回 true。
 *
 * 查询失败时返回 false（当作没在跑）—— 这个方向是刻意的：宁可多陪几句，
 * 也不要因为一次 tasklist 失败就让她整段安静下来，那种"突然不说话"最难排查。
 */
export async function isPeerRunning(names: readonly string[]): Promise<boolean> {
  const now = Date.now();
  if (now - lastAt < TTL_MS) return lastHit;

  let hit = false;
  try {
    // win32：/FO CSV 一行一个进程，形如 "Hearthstone.exe","1234","Console","1","1,234 K"
    // darwin：/bin/ps -Ao comm= 一行一个可执行文件全路径，末段是进程名
    // 两种口径的匹配规则（带引号整名 / 末段比 + 容忍 Helper 派生进程）都在 platform.ts，
    // 这里只管跑命令。
    const probe = peerProbeCommand(process.platform);
    const { stdout } = await run(probe.command, probe.args, {
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 4 << 20,
    });
    hit = matchesPeerNames(stdout, names, process.platform);
  } catch {
    hit = false;
  }

  lastAt = now;
  lastHit = hit;
  return hit;
}

/** 测试用：把缓存清掉。 */
export function resetPeerCache(): void {
  lastAt = 0;
  lastHit = false;
}
