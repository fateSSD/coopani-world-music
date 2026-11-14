import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorldDefinition } from 'cortico/world.ts';
import { MUSIC_DEFAULTS, MUSIC_ID, type MusicConfigSection } from './config.ts';
import { MUSIC_DESCRIBE, MusicWorld } from './world.ts';

/** 提示词文件按本文件位置定位：用 ctx.packageDir 拼会 ENOENT，然后把挂载半途打断。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

export const MUSIC: WorldDefinition<MusicConfigSection> = {
  id: MUSIC_ID,
  label: '一起听歌',
  defaults: () => structuredClone(MUSIC_DEFAULTS()),
  preflight: () => {
    // 只查这一件事：提示词文件读不到会让前缀重建失败，进而留下幽灵实例，
    // 表现是之后每次激活都报"工具撞名"，而且重启也清不掉。这里提前拦住。
    if (!existsSync(ENV_PROMPT_FILE)) {
      throw new Error(`一起听歌：提示词文件读不到（${ENV_PROMPT_FILE}）。`);
    }
  },
  create: (ctx) => new MusicWorld({
    cfg: ctx.cfg, // 活引用，别展开成 {...ctx.cfg}
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    botName: ctx.botName,
  }),
  describe: MUSIC_DESCRIBE,
};
