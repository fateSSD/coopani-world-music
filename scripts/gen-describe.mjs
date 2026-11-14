/**
 * 从 src/world.ts 的 MUSIC_DESCRIBE 重新生成 describe.json。
 * 改过工具或事件之后跑一次，别手改 describe.json（两处写同一份信息迟早对不上）。
 *
 *   node "E:/Coopanion/resources/app/node_modules/tsx/dist/cli.mjs" scripts/gen-describe.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { MUSIC_DESCRIBE } = await import(new URL('../src/world.ts', import.meta.url).href);
const out = fileURLToPath(new URL('../describe.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(MUSIC_DESCRIBE, null, 2)}\n`, 'utf8');
console.log(`已写入 ${out}`);
console.log(`工具：${MUSIC_DESCRIBE.tools.map((t) => t.name).join(', ')}`);
console.log(`事件：${MUSIC_DESCRIBE.events.map((e) => e.type).join(', ')}`);
