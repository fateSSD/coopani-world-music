/**
 * 深听：两条路，一种结果。
 *
 * 云端（默认）——把最近十几秒的临时 WAV 送给一个支持音频输入的对话模型，要它按固定
 * JSON 回答。不占本机空间、装上就能用，代价是要配一个 key，而且音频会离开这台机器。
 * 本地——本机 Python 分轨模型，不联网，代价是要先下约 500MB 的依赖和模型。
 *
 * 两条路都返回 `HearingSlice`，再由 `mergeSlice` 攒成这首的 `SongSheet`。
 * 「整首理解」不是一次吃完一整首，而是每听一段记一段，最后拼出来——这样 12 秒的
 * 样本也能一点点累积成一首歌的轮廓，而且随时可以说清"我只听过哪几段"。
 *
 * 这里不碰播放器、不碰事件，只有纯逻辑 + 一个云端调用。世界层负责取音频、写盘、说话。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export type HearingMode = 'cloud' | 'local' | 'off';

/**
 * 她「听见」的那一句。
 *
 * 和歌词是两回事：歌词是网上抓来的原文，这个是**本机从人声轨里转出来的**。
 * 两者都有时以歌词为准（人写的总比机器听的准），这个只做两件事：
 * 没有词的时候补上「在唱什么」，有词的时候用来对位——机器听的和原文差太远，说明
 * 那一句的时间轴对歪了，此时宁可不说。
 */
export interface HearingSpeech {
  /** 给出去的那一句。对上了歌词就是歌词原文，没词可对就是转写原样。 */
  text: string;
  /** 转写原样。和 text 不同的时候，说明 text 已经被歌词校正过。 */
  heard?: string;
  /** text 是不是来自歌词原文（人写的），而不是机器听出来的。 */
  fromLyric?: boolean;
  /** 语种代码：ja / zh / en / ko / yue。 */
  lang: string;
  /** 语种的中文名，直接进提示词。 */
  langZh: string;
  /** 引擎自己（或交叉校验）判断这句靠不靠得住。false 时不许当原句引用。 */
  confident: boolean;
  /** 和歌词对位的结果：一致 / 不一致 / 没有词可对。世界层填。 */
  match?: 'match' | 'differ' | 'no-lyric';
  /** 交叉校验时另一个引擎的版本，仅供排查。 */
  alt?: string;
}

/** 一条切片结论。两个引擎产出同一种结构，后面所有展示都只认它。 */
export interface HearingSlice {  /** 采样时刻（epoch ms）。 */
  at: number;
  /** 这首歌放到第几秒；读不到进度时是 null。 */
  posSec: number | null;
  /** 切片长度（秒）。 */
  seconds: number;
  /** 调性。拿不准就是「不明确」，不许瞎填。 */
  tonic: string;
  chords: string[];
  /** 主旋律音名，按时间顺序。 */
  melody: string[];
  /** 听得到的声部：人声 / 鼓 / 贝斯 / 吉他 / 钢琴 / 弦乐 / 合成器。 */
  voices: string[];
  instruments: Array<{ name: string; score: number }>;
  summary: string;
  /** 人声轨转写出来的那一句。没开 ASR、没人声、或没听清时为空。 */
  speech?: HearingSpeech | null;
  source: 'cloud' | 'local';
  latencySec: number;
  /** 模型没按格式答，只有一段话——这时候只能当参考，不能当结构化事实。 */
  loose: boolean;
}

/** 一首歌累积下来的档案。 */
export interface SongSheet {
  trackKey: string;
  title: string;
  artist: string;
  slices: HearingSlice[];
  updatedAt: number;
}

export const HEARING_SHEET_FILE = 'music-hearing.jsonl';

/** 一首最多留几条。再多也没有新信息，只是把同一段听了一遍又一遍。 */
const MAX_SLICES = 12;

/** 切片太长没意义（模型吃不下）、太短听不出东西。 */
export const MIN_SLICE_SEC = 6;
export const MAX_SLICE_BYTES = 9 * 1024 * 1024;

const VOICE_WORDS = ['人声', '鼓', '贝斯', '吉他', '钢琴', '弦乐', '合成器'];

/** 语种代码 → 中文名。给提示词用，云端的 lang 字段五花八门，认不出来就留空。 */
const SPEECH_LANG_ZH: Record<string, string> = {
  ja: '日语', japanese: '日语',
  zh: '中文', chinese: '中文', mandarin: '中文',
  en: '英语', english: '英语',
  ko: '韩语', korean: '韩语',
  yue: '粤语', cantonese: '粤语',
};

/** 中日韩不要词间空格；句尾标点由调用方统一加。 */
function tidySpeech(text: string, lang: string): string {
  const raw = (text || '').trim();
  const out = ['ja', 'zh', 'yue', 'ko'].includes(lang) ? raw.replace(/\s+/g, '') : raw.replace(/\s+/g, ' ');
  return out.replace(/[。.!?！？、，,;；:：]+$/, '');
}

export function isHearingMode(v: unknown): v is HearingMode {
  return v === 'cloud' || v === 'local' || v === 'off';
}

/** 配置里可能是个坏值（手改过 json）。坏值按默认走，不静默关掉功能。 */
export function hearingModeOf(v: unknown): HearingMode {
  return isHearingMode(v) ? v : 'cloud';
}

/* ================= 云端 ================= */

const CLOUD_SYSTEM = [
  '你是一台听音分析器。你会收到一段十几秒的音乐切片（系统正在播放的声音）。',
  '只描述这段音频里确实听得到的东西。不要推测整首歌的曲式，不要编造歌词，不要评价好不好听。',
  '拿不准就写「不明确」，或把 score 写低——不要为了凑满字段而猜。',
  'speech 这一项：只有确实听清了人声在唱/说的字才写；听不清就留空字符串。'
    + '宁可空着，也不要按曲风猜一句像样的话——那句话会被当成「她听到的」讲给用户。',
].join('\n');

function cloudAsk(seconds: number): string {
  return [
    `这是约 ${Math.round(seconds)} 秒的切片。按下面的 JSON 回答，只输出 JSON，不要解释、不要代码块标记：`,
    '{',
    '  "tonic": "调性，例如 A 小调；拿不准写 不明确",',
    '  "chords": ["按时间顺序的和弦，最多 6 个，例如 Am"],',
    '  "melody": ["主旋律音名，最多 12 个，例如 E4；听不出就空数组"],',
    '  "voices": ["听得到的声部，从 人声/鼓/贝斯/吉他/钢琴/弦乐/合成器 里选"],',
    '  "instruments": [{"name": "具体乐器", "score": 0.0}],',
    '  "speech": "听清的人声原话（唱词或说话），听不清就写空字符串",',
    '  "lang": "speech 的语种：ja/zh/en/ko/yue，听不出写空",',
    '  "summary": "一句中文，说这段最突出的是什么"',
    '}',
    'voices 只写确实听到的；instruments 最多 3 个，score 是 0–1 的把握。',
  ].join('\n');
}

/** 云端的请求体。单独导出是为了能在测试里钉住形状——这个接口一改，整条路就哑了。 */
export function buildCloudRequest(o: {
  base: string;
  model: string;
  wavBase64: string;
  seconds: number;
}): { url: string; body: Record<string, unknown> } {
  const base = (o.base || '').trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    url,
    body: {
      model: o.model,
      // 带音频输入的对话模型普遍只支持流式（DashScope 的 omni 系列直接要求 stream=true）。
      stream: true,
      stream_options: { include_usage: true },
      modalities: ['text'],
      temperature: 0.2,
      messages: [
        { role: 'system', content: [{ type: 'text', text: CLOUD_SYSTEM }] },
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${o.wavBase64}`, format: 'wav' } },
            { type: 'text', text: cloudAsk(o.seconds) },
          ],
        },
      ],
    },
  };
}

/**
 * SSE 增量解析。
 *
 * 一次 fetch 回来的是碎块，一行的 JSON 可能被切成两半，所以必须自己攒行。
 * 解析失败的行（心跳、注释、半行）直接跳过——云端偶尔会插空行，那不是错误。
 */
export interface SseReader {
  (chunk: string): string;
  /** 流正常结束时冲刷最后一行；没有尾换行的完整 JSON 也不能丢。 */
  flush(): string;
  /** 可带最后一个碎块的结束入口，等价于 read(chunk) + flush()。 */
  end(chunk?: string): string;
}

export function createSseReader(onUsage?: (usage: CloudUsage) => void): SseReader {
  let buf = '';
  const takeLine = (raw: string): string => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return '';
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return '';
    try {
      const j = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
        usage?: unknown;
      };
      if (onUsage && j.usage) {
        const u = parseCloudUsage(j.usage);
        if (u) onUsage(u);
      }
      const c = j.choices?.[0]?.delta?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        let out = '';
        for (const part of c) {
          const t = (part as { text?: unknown })?.text;
          if (typeof t === 'string') out += t;
        }
        return out;
      }
    } catch { /* 完整一行也可能是不认识的数据，跳过即可 */ }
    return '';
  };
  const read = ((chunk: string): string => {
    buf += chunk;
    let out = '';
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      out += takeLine(line);
      idx = buf.indexOf('\n');
    }
    return out;
  }) as SseReader;
  read.flush = (): string => {
    if (!buf) return '';
    const tail = buf;
    buf = '';
    return takeLine(tail);
  };
  read.end = (chunk = ''): string => read(chunk) + read.flush();
  return read;
}

/** 从一段自由文本里抠出第一个完整的 JSON 对象。模型爱套 ```json 或加前言。 */
export function extractJson(text: string): Record<string, unknown> | null {
  const s = text.replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1)) as unknown;
          return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const cleanStr = (v: unknown, max = 40): string =>
  (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);

const cleanList = (v: unknown, max: number, each = 12): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => cleanStr(x, each))
    .filter(Boolean)
    .slice(0, max);

function cleanInstruments(v: unknown): Array<{ name: string; score: number }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ name: string; score: number }> = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const name = cleanStr((item as { name?: unknown }).name, 16);
    if (!name) continue;
    let score = Number((item as { score?: unknown }).score);
    if (!Number.isFinite(score)) score = 0;
    if (score > 1) score = score > 100 ? 1 : score / 100;
    out.push({ name, score: Math.round(score * 100) / 100 });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 把模型的回答变成切片结论。
 *
 * 不按格式答也收：至少那句摘要是有用的，标成 `loose` 就行——
 * 直接判失败会让她白跑一趟，而"这段听着像钢琴独奏"这种话本身就能用。
 */
export function normalizeAnswer(
  text: string,
  ctx: { at: number; posSec: number | null; seconds: number; latencySec: number },
): HearingSlice {
  const base: HearingSlice = {
    at: ctx.at,
    posSec: ctx.posSec,
    seconds: ctx.seconds,
    tonic: '不明确',
    chords: [],
    melody: [],
    voices: [],
    instruments: [],
    summary: '',
    source: 'cloud',
    latencySec: ctx.latencySec,
    loose: false,
  };
  const obj = extractJson(text);
  if (!obj) {
    const said = cleanStr(text, 300);
    return { ...base, summary: said || '云端没有给出可用内容', loose: true };
  }
  const voices = cleanList(obj.voices, 6, 8).filter((v) => VOICE_WORDS.includes(v) || v.length <= 8);
  // 云端给的 speech 一律先标「不确定」：它既没有逐字置信度，也没法在本机复核，
  // 只有等世界层拿歌词去对位、对上了才升级成可引用。
  const lang = cleanStr(obj.lang, 8).toLowerCase();
  const said = tidySpeech(cleanStr(obj.speech, 160), lang);
  return {
    ...base,
    tonic: cleanStr(obj.tonic, 24) || '不明确',
    chords: cleanList(obj.chords, 6, 16),
    melody: cleanList(obj.melody, 12, 6),
    voices,
    instruments: cleanInstruments(obj.instruments),
    speech: said
      ? { text: said, lang, langZh: SPEECH_LANG_ZH[lang] ?? '', confident: false }
      : null,
    summary: cleanStr(obj.summary, 200),
  };
}

export interface CloudConfig {
  base: string;
  model: string;
  key: string;
}

export interface CloudUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

function parseCloudUsage(raw: unknown): CloudUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const promptTokens = Math.max(0, Number(o.prompt_tokens ?? o.input_tokens) || 0);
  const completionTokens = Math.max(0, Number(o.completion_tokens ?? o.output_tokens) || 0);
  if (!promptTokens && !completionTokens) return undefined;
  const details = (o.prompt_tokens_details && typeof o.prompt_tokens_details === 'object')
    ? o.prompt_tokens_details as Record<string, unknown>
    : {};
  const cacheHitTokens = Math.max(0, Number(o.prompt_cache_hit_tokens ?? details.cached_tokens) || 0);
  const cacheMissTokens = Math.max(0, Number(o.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHitTokens));
  const compDetails = (o.completion_tokens_details && typeof o.completion_tokens_details === 'object')
    ? o.completion_tokens_details as Record<string, unknown>
    : {};
  const reasoningTokens = Number(compDetails.reasoning_tokens);
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    ...(Number.isFinite(reasoningTokens) && reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

export type CloudResult =
  | { ok: true; slice: HearingSlice; usage?: CloudUsage }
  | { ok: false; reason: string; usage?: CloudUsage };

const HTTP_HINT: Record<number, string> = {
  400: '请求被拒（多半是模型不支持音频输入，换一个模型名再试）',
  401: '密钥不对或没填',
  403: '这个 key 没有该模型的权限',
  404: '地址或模型名不对（base 应该到 /v1 为止）',
  413: '切片太大，服务端不收',
  429: '限流或余额不足',
};

/**
 * 送一段 WAV 给云端。
 *
 * 超时 45 秒：音频上传 + omni 这类模型的首字延迟都不低，卡在 20 秒会把正常请求误杀。
 * 失败一律翻译成"他能照做的一句话"，别把 HTTP 状态码原样丢给她。
 */
export async function cloudListen(
  wavPath: string,
  cfg: CloudConfig,
  ctx: { at: number; posSec: number | null; seconds: number },
  signal?: AbortSignal,
): Promise<CloudResult> {
  if (!cfg.key.trim()) return { ok: false, reason: '云端深听还没填密钥（设置 → 一起听歌 → 深听方式）' };
  if (!/^https?:\/\//i.test(cfg.base.trim())) return { ok: false, reason: `云端地址不像个网址：${cfg.base}` };
  if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };

  let b64: string;
  try {
    const buf = readFileSync(wavPath);
    if (buf.byteLength > MAX_SLICE_BYTES) return { ok: false, reason: '切片太大，云端不收' };
    b64 = buf.toString('base64');
  } catch (error) {
    return { ok: false, reason: `读不到切片：${error instanceof Error ? error.message : String(error)}` };
  }

  const { url, body } = buildCloudRequest({ base: cfg.base, model: cfg.model, wavBase64: b64, seconds: ctx.seconds });
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = (): void => { ctrl.abort(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 45_000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key.trim()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const hint = HTTP_HINT[res.status] ?? `HTTP ${res.status}`;
      let detail = '';
      try { detail = cleanStr(await res.text(), 160); } catch { /* 没有正文 */ }
      return { ok: false, reason: `${hint}${detail ? `：${detail}` : ''}` };
    }
    let usage: CloudUsage | undefined;
    const read = createSseReader((u) => { usage = u; });
    try {
      let text = '';
      if (res.body) {
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          text += read(decoder.decode(chunk, { stream: true }));
        }
        text += read(decoder.decode());
        text += read.flush();
      } else {
        // 少数网关会忽略 stream，直接回一个普通 JSON。
        const j = JSON.parse(await res.text()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
        if (j.usage) usage = parseCloudUsage(j.usage);
        const c = j.choices?.[0]?.message?.content;
        text = typeof c === 'string' ? c : '';
      }
      if (!text.trim()) return { ok: false, reason: '云端回了空内容', ...(usage ? { usage } : {}) };
      return {
        ok: true,
        slice: normalizeAnswer(text, { ...ctx, latencySec: Math.round((Date.now() - started) / 100) / 10 }),
        ...(usage ? { usage } : {}),
      };
    } catch (streamErr) {
      // abort 前最后一块可能没有换行：先冲刷尾部，已经发生的 usage 不能随取消丢掉。
      read.flush();
      const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消', ...(usage ? { usage } : {}) };
      if (timedOut || /abort/i.test(msg)) return { ok: false, reason: '云端 45 秒没回完，已放弃这次', ...(usage ? { usage } : {}) };
      return { ok: false, reason: `读取云端响应中断（${msg.slice(0, 120)}）`, ...(usage ? { usage } : {}) };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (signal?.aborted) return { ok: false, reason: '已打断，本次深听取消' };
    if (timedOut || /abort/i.test(msg)) return { ok: false, reason: '云端 45 秒没回完，已放弃这次' };
    return { ok: false, reason: `连不上云端（${msg.slice(0, 120)}）` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ================= 累积 ================= */

/** 两条切片是不是在说同一段（同一小节重复听时不该记两遍）。 */
function sameStretch(a: HearingSlice, b: HearingSlice): boolean {
  if (a.posSec !== null && b.posSec !== null) return Math.abs(a.posSec - b.posSec) < 5;
  return Math.abs(a.at - b.at) < 15_000;
}

/**
 * 把新切片并进档案。
 *
 * 同一段重听就**替换**而不是追加：换了一首歌、或者他倒回去重听，档案里不该出现
 * 两条互相矛盾的"同一时刻"。超过上限时丢最早的那条，但保留调性和乐器这些会累积的信息
 * ——它们本来就是从所有切片里统计出来的，不是存在某一条里的。
 */
export function mergeSlice(
  prev: SongSheet | null,
  meta: { trackKey: string; title: string; artist: string },
  slice: HearingSlice,
): SongSheet {
  const base: SongSheet = prev ?? {
    trackKey: meta.trackKey,
    title: meta.title,
    artist: meta.artist,
    slices: [],
    updatedAt: slice.at,
  };
  const kept = base.slices.filter((s) => !sameStretch(s, slice));
  kept.push(slice);
  kept.sort((a, b) => {
    const ap = a.posSec;
    const bp = b.posSec;
    if (ap === null && bp === null) return a.at - b.at;
    if (ap === null) return 1;
    if (bp === null) return -1;
    return ap - bp;
  });
  return {
    ...base,
    title: meta.title || base.title,
    artist: meta.artist || base.artist,
    slices: kept.slice(-MAX_SLICES),
    updatedAt: slice.at,
  };
}

const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 音名 → 可比较的数字（C4 = 48）。解析不了就 null。 */
function noteValue(n: string): number | null {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(n.trim());
  if (!m) return null;
  let pc = NOTE_PC[m[1]];
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return pc + (Number(m[3]) + 1) * 12;
}

function topCounted(items: string[], min = 1): Array<{ name: string; n: number }> {
  const count = new Map<string, number>();
  for (const it of items) count.set(it, (count.get(it) ?? 0) + 1);
  return [...count.entries()]
    .map(([name, n]) => ({ name, n }))
    .filter((x) => x.n >= min)
    .sort((a, b) => b.n - a.n);
}

/**
 * 整首档案的文字版。
 *
 * 每一句都必须能对上一条切片——这是给她看的，也是给我自己查的：她说"这首是 A 小调"
 * 的时候，得能指回哪一段、几段里有几段这么说。
 */
export function sheetText(sheet: SongSheet): string {
  const { slices } = sheet;
  if (!slices.length) return '';
  const times = slices.map((s) => s.posSec).filter((p): p is number => p !== null);
  const span = times.length >= 2
    ? `覆盖 ${mmss(times[0])}–${mmss(times[times.length - 1])}`
    : '只有一段';
  const lines: string[] = [`整首累积：已深听 ${slices.length} 段（${span}）。`];

  // 调性：多数说了算；前后不一致就照实说，别取个平均糊过去。
  const tonics = slices.map((s) => s.tonic).filter((t) => t && t !== '不明确');
  const ranked = topCounted(tonics);
  if (ranked.length) {
    const main = ranked[0];
    if (ranked.length > 1 && main.n * 2 <= tonics.length) {
      lines.push(`调性前后不一样（${ranked.map((r) => r.name).slice(0, 2).join(' → ')}），别当成一个调说死。`);
    } else {
      lines.push(`调性：${main.name}（${main.n}/${tonics.length} 段一致）。`);
    }
  } else {
    lines.push('调性：还没定下来。');
  }

  const chords: string[] = [];
  for (const s of slices) {
    for (const c of s.chords) {
      // 老档案里可能存过「不明确」这个占位，读的时候也挡一道。
      if (!c || c === '不明确') continue;
      if (chords[chords.length - 1] !== c) chords.push(c);
    }
  }
  if (chords.length) lines.push(`和弦（按时间拼）：${chords.slice(0, 10).join('–')}。`);

  const voiceCounts = topCounted(slices.flatMap((s) => s.voices));
  if (voiceCounts.length) {
    const n = slices.length;
    lines.push(`声部：${voiceCounts.map((v) => (v.n >= n ? v.name : `${v.name}(${v.n}/${n} 段)`)).join('、')}。`);
  }

  const notes = slices.flatMap((s) => s.melody);
  if (notes.length >= 3) {
    const vals = notes.map(noteValue).filter((v): v is number => v !== null);
    const top = topCounted(notes)[0];
    let text = `主旋律：${notes.slice(0, 10).join('–')}`;
    if (vals.length >= 3) text += `（音域 ${rangeText(vals)}）`;
    if (top) text += `，出现最多的是 ${top.name}`;
    lines.push(`${text}。`);
  }

  const inst = new Map<string, { total: number; n: number }>();
  for (const s of slices) {
    for (const i of s.instruments) {
      const cur = inst.get(i.name) ?? { total: 0, n: 0 };
      inst.set(i.name, { total: cur.total + i.score, n: cur.n + 1 });
    }
  }
  const top = [...inst.entries()]
    .map(([name, v]) => ({ name, score: Math.round((v.total / v.n) * 100) / 100 }))
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (top.length) lines.push(`乐器倾向：${top.map((t) => `${t.name}(${t.score.toFixed(2)})`).join('、')}——这是倾向，不是鉴定。`);

  // 唱词：这是唯一能证明她「真的在听」而不是在查资料的证据。所以措辞里必须带来源——
  // 「本机转写」四个字是给她看的，提醒她不能把自己听出来的当成原句背给人家。
  const heard = slices.filter((s) => s.speech?.text);
  if (heard.length) {
    const sp = heard[heard.length - 1].speech as HearingSpeech;
    let src: string;
    let trust = '';
    if (sp.fromLyric) {
      src = '她听到的位置与歌词对得上，引用这一句歌词原文';
    } else if (sp.match === 'differ') {
      src = '本机转写，但与歌词对不上';
      trust = '——时间轴可能偏了，只能说「隐约听到像……」，不许当原句引用。';
    } else {
      src = '本机人声轨转写，没有歌词可校对';
      trust = '——唱段转写会错字（实测约七成字准），只能当「隐约听到」，不许当原句引用。';
    }
    lines.push(`她听见的唱词（${sp.langZh || '语种不明'}，${src}）：「${sp.text}」${trust}`);
  }

  return lines.join('\n');
}

function rangeText(vals: number[]): string {
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return `${midiName(lo)}–${midiName(hi)}`;
}

function midiName(v: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pc = ((v % 12) + 12) % 12;
  const oct = Math.floor(v / 12) - 1;
  return `${names[pc]}${oct}`;
}

/** 事件里用的一行版。段事件只有一行位置，给不了整页。 */
/**
 * 一首歌听过几段之后，给她一句话的「走向」。
 *
 * 原来这里只报**最近一段**（「本首已深听 3 段，最近一段：C 大调，钢琴，F–C–F–C–Am–C」）——
 * 她照着说出来永远是"现在我听到 C 大调"，听不出这首歌从哪儿走到哪儿。陪听要的不是快照，
 * 是"前面只有钢琴，后来鼓和贝斯进来"这种进程感。
 *
 * 所以这里改成比首末两段：**多出来什么、少了什么、调性动没动**。参数只在第一段出现一次，
 * 后面一律说变化。
 *
 * 2026-11-10：调性这一格加了一条自曝。实测《レゴリスの砂時計》同一首歌 2.9/3.6/4.4 分钟
 * 三段报了 F# 大调 → E 大调 → A# 小调 —— 3 分钟内调性连变三次，那不是歌在转调，
 * 是 12 秒切片 + 分离模型听岔了。**变两次以上就不许报成事实**，直接说"多半听岔了"。
 */
export function sheetShort(sheet: SongSheet | null): string {
  if (!sheet || !sheet.slices.length) return '';
  const slices = [...sheet.slices].sort((a, b) => (a.posSec ?? 0) - (b.posSec ?? 0));
  const first = slices[0];
  const last = slices[slices.length - 1];
  const at = (s: HearingSlice): string => (s.posSec === null ? '刚才' : mmss(s.posSec));
  const sounds = (s: HearingSlice): string => {
    const parts: string[] = [];
    if (s.tonic && s.tonic !== '不明确') parts.push(s.tonic);
    // 「其他乐器」是分离模型甩不掉的那一轨兜底名，念出来是机器话。见下面 added 的处理。
    const voices = s.voices.filter((v) => v !== '其他乐器');
    if (voices.length) parts.push(voices.slice(0, 3).join('、'));
    if (s.chords.length) parts.push(s.chords.slice(0, 3).join('–'));
    return parts.join('，');
  };
  // 人声轨真转写出来的那一句。这是**听觉证据**，跟反查来的歌词不是一回事，别丢。
  const heard = (s: HearingSlice): string => {
    const text = s.speech?.text;
    if (!text || !s.speech?.confident) return '';
    return `我听到唱的是「${text.length > 14 ? `${text.slice(0, 14)}…` : text}」`;
  };

  if (slices.length === 1) {
    const what = [sounds(first), heard(first)].filter(Boolean).join('；');
    if (!what) return '';
    return first.posSec === null
      ? `这一首我听过一次：${what}。`
      : `这一首我 ${at(first)} 听过一次：${what}。`;
  }

  // 播放进度读不到时（部分客户端只给窗口标题），「刚才那会儿」和「到刚才」会撞成两个"刚才"。
  // 这种情况改用「先是／后来」，只说先后，不编钟点。
  const posKnown = first.posSec !== null && last.posSec !== null;
  const bits: string[] = [];
  const opening = sounds(first);
  if (opening) bits.push(posKnown ? `${at(first)} 那会儿是 ${opening}` : `先是 ${opening}`);

  const added = last.voices.filter((v) => !first.voices.includes(v) && v !== '其他乐器');
  const gone = first.voices.filter((v) => !last.voices.includes(v) && v !== '其他乐器');
  const thicker = last.voices.includes('其他乐器') && !first.voices.includes('其他乐器');
  const where = posKnown ? `到 ${at(last)} ` : '后来';
  if (added.length) bits.push(`${where}多了 ${added.slice(0, 3).join('、')}`);
  else if (gone.length) bits.push(`${where}${gone.slice(0, 3).join('、')}退下去了`);
  else if (thicker) bits.push(`${where}底下的东西厚了一层`);

  const tonics = [...new Set(slices.map((s) => s.tonic).filter((t) => t && t !== '不明确'))];
  if (tonics.length >= 3) {
    bits.push(`调性我这几次听下来一直在变（${tonics.join('→')}），多半是切片太短听岔了`);
  } else if (tonics.length === 2) {
    bits.push(`调性从 ${tonics[0]} 走到 ${tonics[1]}`);
  }

  const lastHeard = heard(last);
  if (lastHeard) bits.push(lastHeard);

  // 只听出一句"当时是什么"、后面什么都没变 —— 那不叫走向，宁可不说。
  if (bits.length < 2) return '';
  return `这一首我听过 ${slices.length} 次：${bits.join('，')}。`;
}

/* ================= 落盘 ================= */

/**
 * 深听档案的存储。追加写 JSONL，读取合并两处目录（换记忆目录时旧档案不能消失）。
 *
 * 只存结论，不存音频：一条记录就是几十个字节的调性/和弦/音名，比波形小五个数量级，
 * 也经得起直接打开看。
 */
export class HearingStore {
  private readonly sheets = new Map<string, SongSheet>();

  constructor(private readonly dir: string, private readonly legacy = '') {
    this.load();
  }

  private files(): string[] {
    const out = [join(this.dir, HEARING_SHEET_FILE)];
    if (this.legacy && this.legacy !== this.dir) out.push(join(this.legacy, HEARING_SHEET_FILE));
    return out.filter((f, i, arr) => arr.indexOf(f) === i);
  }

  private load(): void {
    const seen = new Set<string>();
    for (const file of this.files()) {
      if (!existsSync(file)) continue;
      let body = '';
      try { body = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        let row: (HearingSlice & { trackKey: string; title: string; artist: string }) | null = null;
        try { row = JSON.parse(line) as typeof row; } catch { continue; }
        if (!row?.trackKey || !Number.isFinite(row.at)) continue;
        const id = `${row.trackKey}|${row.at}|${row.posSec ?? ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const { trackKey, title, artist, ...slice } = row;
        const prev = this.sheets.get(trackKey) ?? null;
        this.sheets.set(trackKey, mergeSlice(prev, {
          trackKey,
          title: title ?? '',
          artist: artist ?? '',
        }, {
          ...slice,
          chords: Array.isArray(slice.chords) ? slice.chords : [],
          melody: Array.isArray(slice.melody) ? slice.melody : [],
          voices: Array.isArray(slice.voices) ? slice.voices : [],
          instruments: Array.isArray(slice.instruments) ? slice.instruments : [],
          loose: Boolean(slice.loose),
          source: slice.source === 'local' ? 'local' : 'cloud',
        }));
      }
    }
  }

  get(trackKey: string): SongSheet | null {
    return this.sheets.get(trackKey) ?? null;
  }

  add(meta: { trackKey: string; title: string; artist: string }, slice: HearingSlice): SongSheet {
    const sheet = mergeSlice(this.sheets.get(meta.trackKey) ?? null, meta, slice);
    this.sheets.set(meta.trackKey, sheet);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, HEARING_SHEET_FILE), `${JSON.stringify({ ...slice, ...meta })}\n`, 'utf8');
    } catch { /* 写不进去也不影响这次回答，内存里还有 */ }
    return sheet;
  }

  count(): number {
    return this.sheets.size;
  }
}

/* ================= 状态说明 ================= */

export interface HearingStatus {
  mode: HearingMode;
  keySet: boolean;
  localReady: boolean;
  model: string;
  /** 人声轨转写能不能用（本地这条路 + 配置开着 + 模型在位）。 */
  asrReady?: boolean;
}

/**
 * 给提示词用的一段话。
 *
 * 必须同时说清三件事：现在走哪条路、这条路能不能用、不能用时他该动哪里。
 * 只说"云端"不说"还没配 key"，她就会以为自己听得见。
 */
export function hearingStatusText(s: HearingStatus): string {
  if (s.mode === 'off') {
    return '深听关着。只有能量层（拍子/响度/低音倾向），没有调性、和弦、旋律、乐器。'
      + '他想开的话：设置 → 一起听歌 → 深听方式。';
  }
  if (s.mode === 'local') {
    return s.localReady
      ? '深听走**本地**：本机分轨，音频不出这台机器，不联网。要几秒。'
        + (s.asrReady
          ? '另外人声轨还会转写出一句唱词（本机 SenseVoice）——**这是她自己听到的**，不是查歌词查来的；'
            + '有歌词且对得上时按歌词原文引用，没有歌词时只能当「隐约听到」。'
          : '唱词转写没开或模型没装，所以只有调性/和弦/旋律，别声称听得出唱的是什么。')
      : '深听走**本地**，但这台机器还没装好：需要先下载约 500MB 的依赖和模型（Python 环境 + 六轨分离模型）。'
        + '装好之前 `music_listen` 会用不了——照实说，别装听得到。'
        + '想立刻能用的话，让他把深听方式切成「云端」。';
  }
  return s.keySet
    ? `深听走**云端**（${s.model}）：音频会发到这个服务上去分析，不占本机空间，通常几秒。`
      + '它也会给一句唱词/人声原话，但云端没有逐字置信度、本机也无法复核，'
      + '所以只有和歌词对上了才能当原句引用，否则只能说「隐约听到」。'
    : '深听选的是**云端**，但还没填 API 密钥，现在用不了。'
      + '跟他说：要么填密钥（设置 → 一起听歌 → 深听方式），要么切成「本地」——'
      + '本地要下载约 500MB 的依赖和模型，但之后完全在本机跑、不联网，唱词也更靠得住。';
}

/**
 * 深听能不能用。提示词、状态灯、事件三处必须用同一个判断，否则会出现
 * 「灯是绿的、她说听不了」这种自相矛盾。
 */
export function hearingUsable(s: HearingStatus): boolean {
  if (s.mode === 'off') return false;
  if (s.mode === 'local') return s.localReady;
  return s.keySet;
}

/**
 * 深听状态的事件正文。
 *
 * 为什么「能用」也要推一条：宿主重启时**只恢复**磁盘上的 system 消息，不会重建前缀
 * （只有挂载/卸载 World 或手动「重载前缀」才重建）。于是升级完扩展、重启完 Core，
 * 老会话里她手上还是旧提示词——她连「有深听这回事」都不知道，被问「你听得清吗」只能答
 * 「听不清」。2026-10-31 02:25 就是这么答的。
 *
 * 事件是唯一每轮必达的通道，所以这一句必须自己把话说全：能力在、怎么用、以及它
 * **优先于**旧提示词里那句「不许描述具体声音」。
 */
export function hearingNotice(s: HearingStatus, build: string): string | null {
  if (s.mode === 'off') return null;
  if (!hearingUsable(s)) {
    return s.mode === 'cloud'
      ? '深听选的是**云端**，但还没填密钥，所以现在说不了调性、和弦、旋律和乐器——只有拍子和响度。\n'
        + '跟他说一句：设置 → 一起听歌 → 深听方式。要么填一个密钥（十几秒的切片会发给那个服务，分析完就删），'
        + '要么切成「本地」——本地要下载约 500MB，但之后完全在本机跑、不联网。\n'
        + '**别说成「坏了」** —— 听歌、跟拍、换歌那句都正常，只是她还没学会听调子。'
      : '深听选的是**本地**，但这台机器还没装好（要下约 500MB 的依赖和模型），所以现在说不了调性、和弦、旋律和乐器。\n'
        + '跟他说一句：设置 → 一起听歌 → 深听方式。要么按 README 装一遍，要么切成「云端」——填个密钥立刻能用。\n'
        + '**别说成「坏了」** —— 听歌、跟拍、换歌那句都正常。';
  }

  const how = s.mode === 'local'
    ? '本机分轨，音频不出这台机器、不联网'
    : `云端（${s.model}），十几秒切片会发给那个服务，分析完即删`;
  return `**深听能用了**（${how}；扩展 ${build}）。\n`
    + '`music_listen` 会把最近十几秒送去分析，回来的是：调性、和弦、主旋律音名、声部构成、乐器倾向，'
    + '以及**人声轨转写出来的那句唱词**（本机 SenseVoice，不是查歌词查来的）。\n'
    + '所以：\n'
    + '1. 他问「你听得清吗」「仔细听听」「这首什么乐器/什么调」时，**先调 `music_listen` 再答**，'
    + '别直接说"听不清"——那是旧版本的答案。\n'
    + '2. 分析出来的东西可以说，但要说成「分析出来是 A 小调」，不能说「我听出来」。'
    + '十几秒切片不是整首总谱，多问几次会并进这首的档案，档案里写着听过哪几段。\n'
    + '3. 唱词这一项有硬规矩：**有歌词且对得上时，回执给的是歌词原文**（她听到的位置和歌词一致，'
    + '所以可以引用那一句）；**没有歌词、或和歌词对不上时，那是她自己的转写**——'
    + '实测中文唱段只有约七成字准，只能说「隐约听到像……」，不许当原句引用。'
    + '两种情况的回执里都写明了是哪一种，照回执说的来。\n'
    + '4. 这一条**优先于**提示词里那句「不许描述具体声音」——那句是为没有深听的时候写的。'
    + '深听回执里没有的东西，照旧不许编。';
}

