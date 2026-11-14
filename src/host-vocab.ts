/**
 * 宿主认得哪些动作 —— **不再去扫宿主的安装目录**。
 *
 * ## 原来怎么做的，为什么撤了
 *
 * 原来按路径扫 `resources/app/node_modules/cortico-world-desktop-pet/web/<figure>/figure.json`，
 * 读出词表，好在扩展发动作名前先做一次降级（宿主没有 `bounce`，就换成 `dance`）。
 *
 * 理由没错，**做法越界**：和 journey、pz 那两处是同一个问题 ——
 * 按路径读别人的安装包，拿「我恰好知道宿主的目录布局」当契约用。
 * 宿主换一次布局就静默失效，而表现是「她不动了」。
 * 市集把这条例为申请认证的必改项（`cortico-extensions#659`）。
 *
 * ## 撤了之后靠什么
 *
 * 靠**名字对不上就退回原生动作**：
 *
 * - 宿主 `act()` 认不出这个词时落到 `default` 分支，读 `vocab[id].motion`。
 *   有（形象包声明了这个动作）就演，没有就 `return false` —— 静默丢弃，脸会变、人不动。
 * - 所以带这些动作的**形象包**是唯一的实现方式：`figure.json` 的 vocab 条目带 `motion` 字段，
 *   `figure.js` 的 `gestures` 点名，宿主就把 `frame.gesture` 交给它自己画。
 * - 当前形象的词表本来就写在宿主的环境提示词里（`{{pet.vocab}}`），模型看得到。
 *
 * 因此这里恒返回 `null`：**「不知道」= 不降级 = 原样发**。
 * `degradeMove()` 在 `hostVocab` 为 null 时原样返回 id，行为与没装形象包时一致。
 *
 * ## 一句话
 *
 * 宁可发一个可能被丢掉的名字，也不拿一份猜出来的清单去否掉她想做的事。
 * 猜错的代价（她站着不动）比漏一个动作大得多。
 */

/**
 * 宿主词表 —— 恒 `null`。
 *
 * 保留这个函数只为不改调用方签名（`world.ts` 一处），
 * 也让以后真有了 `ctx.figure()` 之类的接口时只改这里。
 */
export function readHostVocab(): Set<string> | null {
  return null;
}
