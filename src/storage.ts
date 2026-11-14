/**
 * 记忆存在哪。
 *
 * 默认跟着宿主的 `dataDir`（每台机器一份，各记各的）。但"这台机器听过的歌"是个
 * 跟着人走的东西，不跟着机器走——公司听一下午、回家还想接着聊，靠的就是把记忆
 * 放到一个两边都看得见的目录（OneDrive、NAS、移动硬盘都行）。
 *
 * 这里只做一件事：把「配置里写的目录」翻译成一个可用的绝对路径，并且**分成两类**。
 *
 * - **记忆**（listening / notes / wants / tags）：可能落在自定义目录，跟着人走。
 * - **本机状态**（当前播放快照、歌词缓存、一次性标记）：**永远留在本机**。
 *
 * 为什么必须分开：`music-state.json` 是"她现在以为你在听什么"。两台机器共写一份，
 * 回家打开就会看到公司那台昨天的歌，还会把正在听的这一首覆盖掉。状态不是记忆，
 * 共享它只会制造幻觉。
 *
 * 还有一条：**读取永远合并两处**。切换目录那天，旧目录里的历史不能凭空消失——
 * 不然用户看到的是"我把记忆搬到新位置，结果全没了"。写入只写新目录，读取两处合并，
 * 没有任何搬迁动作，也就没有搬一半坏掉的窗口。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface StorageLayout {
  /** 记忆写入目录。自定义目录不可用时等于 `local`。 */
  memory: string;
  /** 宿主给的默认目录。始终参与**读取**，防止切目录后旧记录看起来消失。 */
  local: string;
  /** 自定义目录是否真的启用（配置了且可用）。 */
  custom: boolean;
  /**
   * 自定义目录**没启用**或**不可用**时的一句话。为空表示真的在用（或没配）。
   *
   * 这段文字会出现在日志和设置页的数据页签里——**必须说清是没配还是配了但用不了**，
   * 因为这两种情况的处置完全不同（前者不用管，后者要去看盘还在不在）。
   */
  problem: string | null;
  /**
   * 用上了，但有句话要提。目前只有一种：新目录还是空的。
   *
   * 跟 `problem` 分开是因为处置完全不同——这里不用做任何事，只是别让他以为"以前的都没了"。
   */
  notice: string | null;
}

/** 路径比较用：统一成绝对路径再比，大小写按 Windows 的习惯忽略。 */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try {
      return resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    } catch {
      return p.replace(/[\\/]+$/, '').toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/** 设置页里"推荐目录"的起点：用户主目录下一个好找的地方，不替他建。 */
export function suggestedMemoryDir(): string {
  try {
    return join(homedir(), 'CoopaniMusic');
  } catch {
    return '';
  }
}

/**
 * 探测一个目录能不能真的用来存东西。
 *
 * 不用 `accessSync(W_OK)`：网盘和移动硬盘会把权限位报得很乐观，真写下去才失败。
 * 写一个探针文件再删掉，是唯一能同时验「路径存在、有权限、盘在线」的办法。
 * 探针文件名带 pid，两台机器同时探测也不会撞。
 */
function probeWritable(dir: string): { ok: true } | { ok: false; reason: string } {
  const probe = join(dir, `.write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    if (code === 'ENOENT') return { ok: false, reason: '所在盘符不存在（移动硬盘拔了？网络盘没连上？）' };
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, reason: '没有写入权限' };
    if (code === 'ENOTDIR') return { ok: false, reason: '路径里有一段不是文件夹' };
    return { ok: false, reason: `建不了目录（${code || '未知错误'}）` };
  }
  try {
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    if (code === 'EROFS') return { ok: false, reason: '这个盘是只读的' };
    if (code === 'ENOSPC') return { ok: false, reason: '盘满了' };
    return { ok: false, reason: `写得进目录但写不了文件（${code || '未知错误'}）` };
  }
}

/**
 * 把配置翻译成可用路径。
 *
 * 配置为空、等于默认目录、或者探测失败，都退回默认目录并给出原因——
 * **永远返回一个能用的目录**，调用方不必再判空。这一条的代价是"配错了会静默退回本机"，
 * 所以 `problem` 必须被日志和设置页真的用上，否则用户会以为记忆在同步盘里，其实一直写在本机。
 */
export function resolveLayout(dataDir: string, configured: string): StorageLayout {
  const local = dataDir;
  const wanted = (configured ?? '').trim();

  if (!wanted) return { memory: local, custom: false, local, problem: null, notice: null };
  if (sameDir(wanted, local)) return { memory: local, custom: false, local, problem: null, notice: null };

  const probe = probeWritable(wanted);
  if (!probe.ok) {
    return {
      memory: local,
      custom: false,
      local,
      problem: `记忆位置「${wanted}」用不了：${probe.reason}。这段时间的听歌记录照旧存在本机。`,
      notice: null,
    };
  }

  // 目录可用，但还没建过任何东西：这不是错，只是"从这里重新开始记"，得先说一声。
  const fresh = !existsSync(join(wanted, 'listening')) && !existsSync(join(wanted, 'music-notes.jsonl'));
  return {
    memory: wanted,
    custom: true,
    local,
    problem: null,
    notice: fresh ? `记忆位置切到「${wanted}」，这个目录还是空的，会从这里接着记。本机旧记录仍然读得到。` : null,
  };
}

/** 目录是否真的能写（运行中复查用：U 盘可能在跑着的时候被拔掉）。 */
export function stillWritable(dir: string): boolean {
  return probeWritable(dir).ok;
}
