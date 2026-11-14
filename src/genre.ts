/**
 * 可解释的曲风学习：同专辑 → 同歌手多数标签 → 已标曲目的声音近邻。
 *
 * 不做「听见 120BPM 就说是电子」这种假识别。音频只负责寻找过去标过的相似曲目；
 * 没有学习样本时，仍然承认未知。用户后来的标记覆盖旧标签，因为调用方传入的是
 * VibeStore 每首歌的最新一行，而不是全部历史。
 */
import type { Track } from './tracker.ts';
import type { Feel, VibeTag } from './vibe.ts';

export interface AudioFeatures {
  bpm: number;
  rms: number;
  bass: number;
  mid: number;
  high: number;
}

export interface GenreSuggestion {
  feel: Feel;
  genre: string;
  source: 'album' | 'artist' | 'audio';
  /** 给事件正文和工具回执看的依据，不伪装成测量精度。 */
  reason: string;
  /** 只用于排序与诊断，不对用户显示成百分比。 */
  confidence: number;
}

const norm = (s: unknown): string => String(s ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const validFeel = (n: number): boolean => Number.isFinite(n) && n >= 0;

export function audioFeaturesOf(value: unknown): AudioFeatures | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const out = {
    bpm: Number(raw.bpm), rms: Number(raw.rms), bass: Number(raw.bass),
    mid: Number(raw.mid), high: Number(raw.high),
  };
  if (![out.bpm, out.rms, out.bass, out.mid, out.high].every(validFeel)) return null;
  if (out.bpm <= 0 || out.rms <= 0) return null;
  return out;
}

/** 给模型看的声音摘要：只描述拍子、响度和频段，不假装知道旋律或配器。 */
export function describeAudioFeatures(f: AudioFeatures): string {
  const loudness = f.rms < 0.008 ? '偏弱' : f.rms < 0.035 ? '中等' : '偏强';
  const low = f.bass / Math.max(f.rms, 1e-6);
  const high = f.high / Math.max(f.rms, 1e-6);
  const band = low > 0.58 ? '低音偏重' : high > 0.2 ? '高频偏亮' : '频段较均衡';
  return `约 ${Math.round(f.bpm)} BPM，响度${loudness}，${band}`;
}

/** 同组标签取多数；平票取最近标过的一组。 */
function majority(tags: readonly VibeTag[]): { feel: Feel; genre: string; count: number; ts: number } | null {
  const groups = new Map<string, { feel: Feel; genre: string; count: number; ts: number }>();
  for (const tag of tags) {
    const key = `${tag.feel}\u0000${norm(tag.genre)}`;
    const old = groups.get(key);
    groups.set(key, {
      feel: tag.feel, genre: tag.genre,
      count: (old?.count ?? 0) + 1,
      ts: Math.max(old?.ts ?? 0, tag.ts),
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.ts - a.ts)[0] ?? null;
}

/** 特征只用于「接近哪些已标曲目」，五维都压缩到相近量级。 */
function vector(f: AudioFeatures): number[] {
  const rms = Math.max(f.rms, 1e-6);
  return [
    Math.min(1.25, f.bpm / 160),
    Math.min(1.25, f.rms * 8),
    Math.min(1.25, f.bass / rms),
    Math.min(1.25, f.mid / rms),
    Math.min(1.25, f.high / rms),
  ];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0) / a.length);
}

/**
 * 给一个不带标题字面规则的候选。调用方应先查同曲标签，再调用这里，随后查字面；
 * 只有字面也不中时才使用本函数的 audio 结果。
 */
export function suggestGenre(
  track: Pick<Track, 'title' | 'artist' | 'album'>,
  tags: readonly VibeTag[],
  features?: AudioFeatures | null,
): GenreSuggestion | null {
  const artist = norm(track.artist);
  const album = norm(track.album);
  const usable = tags.filter((t) => t && t.key && t.genre !== undefined);

  // 专辑内一首已标就够：这是强上下文，但冲突时仍按多数/最近标签。
  if (album && artist) {
    const same = usable.filter((t) => norm(t.album) === album && norm(t.artist) === artist);
    const top = majority(same);
    if (top) {
      return {
        feel: top.feel, genre: top.genre, source: 'album', confidence: 0.9,
        reason: `同专辑《${track.album}》里已经有 ${same.length} 首是「${top.genre || top.feel}」`,
      };
    }
  }

  // 同歌手至少两首同向，且占比不低于 60%。只听一首绝不外推整个歌手。
  if (artist) {
    const same = usable.filter((t) => norm(t.artist) === artist);
    const top = majority(same);
    if (top && top.count >= 2 && top.count / same.length >= 0.6) {
      return {
        feel: top.feel, genre: top.genre, source: 'artist', confidence: top.count / same.length,
        reason: `这个歌手 ${top.count}/${same.length} 首都是「${top.genre || top.feel}」`,
      };
    }
  }

  if (features) {
    const current = vector(features);
    const groups = new Map<string, VibeTag[]>();
    for (const tag of usable) {
      const genre = norm(tag.genre);
      if (!genre || !tag.features) continue;
      const valid = audioFeaturesOf(tag.features);
      if (!valid) continue;
      const list = groups.get(genre) ?? [];
      list.push({ ...tag, features: valid });
      groups.set(genre, list);
    }
    const candidates: Array<{ feel: Feel; genre: string; count: number; distance: number }> = [];
    for (const [genre, list] of groups) {
      // 声音近邻也需要两个独立样本，防止单个标签变成万能模板。
      if (list.length < 2) continue;
      const centroid = vector({
        bpm: list.reduce((s, t) => s + t.features!.bpm, 0) / list.length,
        rms: list.reduce((s, t) => s + t.features!.rms, 0) / list.length,
        bass: list.reduce((s, t) => s + t.features!.bass, 0) / list.length,
        mid: list.reduce((s, t) => s + t.features!.mid, 0) / list.length,
        high: list.reduce((s, t) => s + t.features!.high, 0) / list.length,
      });
      candidates.push({
        feel: majority(list)!.feel, genre: list[0].genre, count: list.length,
        distance: distance(current, centroid),
      });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const margin = best && candidates[1] ? candidates[1].distance - best.distance : 1;
    if (best && best.distance <= 0.10 && margin >= 0.04) {
      return {
        feel: best.feel, genre: best.genre, source: 'audio',
        confidence: Math.max(0.5, 1 - best.distance),
        reason: `声音跟以前听过的 ${best.count} 首「${best.genre}」很像`,
      };
    }
  }
  return null;
}

/** 每首歌单独积累均值；换歌即清零，最多保留最近 60 个有效采样。 */
export class AudioFeatureAverages {
  private key = '';
  private samples: AudioFeatures[] = [];

  add(key: string, features: AudioFeatures): void {
    if (this.key !== key) {
      this.key = key;
      this.samples = [];
    }
    this.samples.push(features);
    if (this.samples.length > 60) this.samples.splice(0, this.samples.length - 60);
  }

  get count(): number {
    return this.samples.length;
  }

  /** 至少 6 秒有效声音才参与学习，避免换歌第一秒的旧 BPM 被当成特征。 */
  summary(): AudioFeatures | null {
    if (this.samples.length < 6) return null;
    const mean = (k: keyof AudioFeatures) => this.samples.reduce((s, f) => s + f[k], 0) / this.samples.length;
    return { bpm: mean('bpm'), rms: mean('rms'), bass: mean('bass'), mid: mean('mid'), high: mean('high') };
  }

  /**
   * 「这会儿和刚才比，声音变了多少」——0 到 1.25 之间，0 是完全没变。
   *
   * 用途：决定**该不该凑近听一段**。原来是每 120 秒准时跑一次分离模型，不管歌有没有在动；
   * 现在改成拿这个值判断——编曲真变了（鼓进来、弦乐铺上去、突然安静）才值得烧那十几秒 CPU。
   * 安静段落一动不动的时候，一次都不跑。
   *
   * 算法：最近 window 个采样 vs 之前 window 个采样，各自取均值，再算归一化欧氏距离（就是 vector() 那五维）。
   * 用的是和声音近邻同一套归一化，所以阈值可以跨歌通用，不用分曲风调。
   *
   * window=8：约 14 秒（采样是 ≥900ms 一次）。短于这个，一个鼓点就能骗过它；
   * 长于这个，副歌进来了它还停在上一段。
   */
  drift(window = 8): number | null {
    if (this.samples.length < window * 2) return null;
    const head = this.samples.slice(-window * 2, -window).map(vector);
    const tail = this.samples.slice(-window).map(vector);
    const mean = (list: number[][]): number[] => list[0].map((_, i) => list.reduce((s, v) => s + v[i], 0) / list.length);
    return distance(mean(head), mean(tail));
  }
}
