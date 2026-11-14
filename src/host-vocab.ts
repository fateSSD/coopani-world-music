/**
 * 读宿主桌宠认得的动作词表。
 *
 * 为什么需要这一层：扩展用的四个动作（蹦迪 / 律动 / 打拍子 / 闭眼听）不是宿主原生，
 * 是 `coopani/patch-whale-bounce.mjs` 给宿主包打补丁加进去的。别人从市场装这个扩展时，
 * 他们的宿主没有那份补丁——**动作会被静默丢掉，不报错，只是人站着不动**。
 * 所以启动时先问一句「你的词表里都有什么」，没有的降级到原生等价动作。
 *
 * 探不到就返回 null，调用方保持原行为：宁可不知道，也不瞎猜。
 * 猜错的代价是把她变成一个只会站着的木头人，比少动一下严重得多。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 宿主包里形象目录的位置，相对宿主根。 */
const PET_WEB = 'resources/app/node_modules/cortico-world-desktop-pet/web';

/** 当前默认形象优先，其余形象目录兜底——用户换了形象也还能读到一份可用词表。 */
const PREFERRED = 'whale';

/** 候选 figure.json 路径：先看环境变量，再从可执行文件推，最后扫 web 下所有形象。 */
function figureCandidates(): string[] {
  const roots: string[] = [];
  if (process.env.COOPANION_ROOT) roots.push(process.env.COOPANION_ROOT);
  if (process.execPath) roots.push(dirname(process.execPath));

  const out: string[] = [];
  for (const root of roots) {
    const web = join(root, PET_WEB);
    out.push(join(web, PREFERRED, 'figure.json'));
    try {
      for (const ent of readdirSync(web, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name !== PREFERRED) out.push(join(web, ent.name, 'figure.json'));
      }
    } catch {
      // 目录不存在，交给下一轮候选
    }
  }
  return out;
}

/**
 * 宿主词表里的全部 id（表情 + 动作）。
 * 返回 null 表示「没读到」，不等于「宿主没有任何动作」——两者处置完全相反。
 */
export function readHostVocab(): Set<string> | null {
  for (const p of figureCandidates()) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { vocab?: unknown };
      if (!Array.isArray(parsed.vocab)) continue;
      const ids = parsed.vocab
        .map((v) => (v as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length) return new Set(ids);
    } catch {
      // 坏文件当成「没有」，继续下一个候选
    }
  }
  return null;
}
