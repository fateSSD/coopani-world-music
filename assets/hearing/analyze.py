#!/usr/bin/env python
"""本地深听：源分离 -> 人声旋律 / 调性与和弦 / 乐器存在感。

输入是探针按需写出的十几秒临时 WAV，输出一份小型 JSON。默认分析完删除 WAV，
不保留音频、不上传。重型模型全部在本机运行。
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time

import numpy as np
import soundfile as sf

STEM_ORDER = ["drums", "bass", "other", "vocals", "guitar", "piano"]
STEM_ZH = {
    "drums": "鼓", "bass": "贝斯", "other": "其他乐器",
    "vocals": "人声", "guitar": "吉他", "piano": "钢琴",
}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
INSTRUMENT_ZH = {
    "Acoustic_Guitar": "木吉他", "Bass_Guitar": "贝斯", "Drum_set": "鼓组",
    "Electro_Guitar": "电吉他", "flute": "长笛", "Hi_Hats": "踩镲",
    "Keyboard": "键盘", "Trumpet": "小号", "Violin": "小提琴",
}


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x
    try:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, target)
        return resample_poly(x, target // g, sr // g, axis=-1).astype(np.float32)
    except Exception:
        n = int(round(x.shape[-1] * target / sr))
        src = np.linspace(0.0, 1.0, x.shape[-1], endpoint=False)
        dst = np.linspace(0.0, 1.0, n, endpoint=False)
        if x.ndim == 1:
            return np.interp(dst, src, x).astype(np.float32)
        return np.stack([np.interp(dst, src, ch) for ch in x]).astype(np.float32)


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)) + 1e-12))


def chroma_vector(samples: np.ndarray, sr: int) -> np.ndarray:
    """12 维音级能量；只看 55–2000Hz，避免泛音把调性冲散。"""
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim > 1:
        x = x.mean(axis=0)
    if len(x) < 4096:
        x = np.pad(x, (0, 4096 - len(x)))
    win = np.hanning(4096).astype(np.float32)
    freqs = np.fft.rfftfreq(4096, 1.0 / sr)
    keep = (freqs >= 55) & (freqs <= 2000)
    midi = 69 + 12 * np.log2(np.maximum(freqs[keep], 1e-9) / 440.0)
    pc = np.mod(np.round(midi).astype(int), 12)
    out = np.zeros(12, dtype=np.float64)
    for start in range(0, max(1, len(x) - 4096 + 1), 4096):
        frame = x[start:start + 4096]
        if len(frame) < 4096:
            frame = np.pad(frame, (0, 4096 - len(frame)))
        mag = np.abs(np.fft.rfft(frame * win)) ** 2
        for i, p in enumerate(pc):
            out[p] += float(mag[keep][i])
    n = np.linalg.norm(out)
    return out / n if n > 0 else out


def key_of(chroma: np.ndarray) -> str:
    best = (-2.0, "C 大调")
    for tonic in range(12):
        for name, profile, mode in [("大调", MAJOR, 1), ("小调", MINOR, -1)]:
            rolled = np.roll(profile, tonic)
            score = float(np.corrcoef(chroma, rolled)[0, 1])
            if score > best[0]:
                best = (score, f"{NOTE_NAMES[tonic]} {name}")
    return best[1]


def reconcile_key(key: str, chords: list) -> str:
    """让调性和和弦别自相矛盾。

    短切片上最容易出的错：chroma 相关算出「C# 大调」，和弦时间线却稳定在 C#m。
    这两句并排说出去就是笑话（她自己念出来都别扭）。和弦只认开头两个稳定的，
    主音与调性根音一致时，以和弦的大小调为准 —— 2 秒窗口比整段相关更能代表"此刻"。
    """
    if not key or key == "不明确" or not chords:
        return key
    head = [c.get("chord") for c in chords[:2] if c.get("chord") and c.get("chord") != "不明确"]
    if not head:
        return key
    first = head[0]
    if not first:
        return key
    minor = first.endswith("m")
    root = first[:-1] if minor else first
    if not key.startswith(f"{root} "):
        return key
    want = "小调" if minor else "大调"
    return key if key.endswith(want) else f"{root} {want}"


def chord_name(chroma: np.ndarray) -> tuple[str, float]:
    best = ("", 0.0)
    for root in range(12):
        for mode in ("", "m"):
            third = 3 if mode == "m" else 4
            pcs = {root, (root + third) % 12, (root + 7) % 12}
            template = np.zeros(12)
            template[list(pcs)] = 1
            score = float(np.dot(chroma, template / np.linalg.norm(template)))
            if score > best[1]:
                best = (f"{NOTE_NAMES[root]}{mode}", score)
    return best


def chord_timeline(harmonic: np.ndarray, sr: int, window_sec: float = 2.0) -> list[dict]:
    mono = harmonic.mean(axis=0) if harmonic.ndim > 1 else harmonic
    win = max(4096, int(sr * window_sec))
    hop = max(2048, int(sr * 1.0))
    out = []
    for start in range(0, max(1, len(mono) - win // 2), hop):
        seg = mono[start:start + win]
        if len(seg) < 1024:
            break
        name, score = chord_name(chroma_vector(seg, sr))
        if score < 0.48:
            name = "不明确"
        if not out or out[-1]["chord"] != name:
            out.append({"at_sec": round(start / sr, 1), "chord": name, "score": round(score, 2)})
    return out[:16]


def vocal_melody(vocal: np.ndarray, sr: int) -> dict:
    mono = vocal.mean(axis=0) if vocal.ndim > 1 else vocal
    frame_n, hop = 2048, 256
    if len(mono) < frame_n * 2:
        return {"present": False, "notes": [], "range": "", "summary": "人声轨太短"}
    g = rms(mono)
    if g < 0.0015:
        return {"present": False, "notes": [], "range": "", "summary": "没有检测到清晰人声"}
    win = np.hanning(frame_n).astype(np.float32)
    min_lag, max_lag = int(sr / 1000), int(sr / 70)
    freqs, confs = [], []
    for start in range(0, len(mono) - frame_n, hop):
        frame = mono[start:start + frame_n]
        if rms(frame) < max(0.001, g * 0.28):
            freqs.append(0.0); confs.append(0.0); continue
        x = (frame - frame.mean()) * win
        spec = np.fft.rfft(x, 2 * frame_n)
        ac = np.fft.irfft(spec * np.conj(spec))[:frame_n]
        if ac[0] <= 0:
            freqs.append(0.0); confs.append(0.0); continue
        ac = ac / ac[0]
        seg = ac[min_lag:max_lag]
        if len(seg) < 3:
            freqs.append(0.0); confs.append(0.0); continue
        idx = int(np.argmax(seg))
        # 优先选第一个足够高的峰，减少把二倍频当基频。
        peaks = [i for i in range(1, len(seg) - 1)
                 if seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1] and seg[i] > 0.35]
        if peaks:
            strong = [p for p in peaks if seg[p] >= max(0.45, float(seg[idx]) * 0.9)]
            idx = strong[0] if strong else idx
        lag = min_lag + idx
        f = sr / lag
        midi = int(round(69 + 12 * math.log2(max(f, 1) / 440.0)))
        freqs.append(float(midi) if 40 <= midi <= 90 else 0.0)
        confs.append(float(seg[idx]))
    from scipy.ndimage import median_filter
    arr = np.array(freqs)
    voiced = arr > 0
    if voiced.sum() >= 5:
        arr[voiced] = median_filter(arr[voiced], size=5, mode="nearest")
        # 自相关最容易把二倍频/半频当基频。按前后文的局部中位音高折八度，
        # 只在跳超过 7 个半音时折叠，避免把人声真实的大跳也抹平。
        idxs = np.flatnonzero(arr > 0)
        local = median_filter(arr[idxs], size=9, mode="nearest")
        for j, idx in enumerate(idxs):
            m = arr[idx]
            center = local[j]
            while m - center > 7:
                m -= 12
            while center - m > 7:
                m += 12
            arr[idx] = m
        # 再按整段主旋律中心折一次：12 秒短切片里人声跨两个八度很少见，
        # 极端低音多半是贝斯/鼓漏进人声轨，折回最近的同名音。
        center_all = float(np.median(arr[idxs]))
        for idx in idxs:
            m = arr[idx]
            while m - center_all > 12:
                m -= 12
            while center_all - m > 12:
                m += 12
            arr[idx] = m
        arr[idxs] = median_filter(arr[idxs], size=3, mode="nearest")
    notes, cur, cur_len = [], None, 0
    for m in arr:
        m = int(m)
        if m == cur:
            cur_len += 1
        else:
            if cur and cur_len >= 3:
                notes.append((cur, cur_len * hop / sr))
            cur, cur_len = m if m > 0 else None, 1
    if cur and cur_len >= 3:
        notes.append((cur, cur_len * hop / sr))
    # 只留较长、非零的音；按出现顺序，方便看出动机走向。
    strong_notes = [(m, d) for m, d in notes if d >= 0.12][:24]
    if not strong_notes:
        return {"present": False, "notes": [], "range": "", "summary": "有声音但没提取到稳定旋律"}
    names = [f"{NOTE_NAMES[m % 12]}{m // 12 - 1}" for m, _ in strong_notes]
    lo, hi = min(m for m, _ in strong_notes), max(m for m, _ in strong_notes)
    return {
        "present": True,
        "notes": [{"note": n, "sec": round(d, 2)} for n, (_, d) in zip(names, strong_notes)],
        "range": f"{NOTE_NAMES[lo % 12]}{lo // 12 - 1}–{NOTE_NAMES[hi % 12]}{hi // 12 - 1}",
        "summary": "主旋律约 " + "–".join(names[:10]) + (f"（音域 {NOTE_NAMES[lo % 12]}{lo // 12 - 1}–{NOTE_NAMES[hi % 12]}{hi // 12 - 1}）" if len(names) >= 3 else ""),
    }


def classify_instrument(audio: np.ndarray, sr: int, model_path: Path, cfg_path: Path) -> list[dict]:
    if not model_path.exists():
        return []
    import onnxruntime as ort
    labels = {}
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        labels = {int(k): v for k, v in cfg.get("id2label", {}).items()}
    except Exception:
        pass
    mono = audio.mean(axis=0) if audio.ndim > 1 else audio
    mono = resample(mono.astype(np.float32), sr, 16000)[:96000]
    if len(mono) < 16000:
        return []
    mono = (mono - float(mono.mean())) / (float(mono.std()) + 1e-7)
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    logits = sess.run(None, {"input_values": mono.reshape(1, -1).astype(np.float32)})[0][0]
    e = np.exp(logits - logits.max())
    probs = e / e.sum()
    order = np.argsort(probs)[::-1][:3]
    return [{"name": INSTRUMENT_ZH.get(labels.get(int(i), ""), str(labels.get(int(i), i))),
             "score": round(float(probs[i]), 2)} for i in order]


# ================= 唱词：她「听见」的那一句 =================

# 为什么要在分轨之后再转写一次：混音直接送去识别，鼓和贝斯会把辅音糊掉，
# 中文的送气音和日语的清浊音最先死。htdemucs 已经把人声分离出来了，直接拿这一轨
# 去转写，等于免费做了一次降噪——实测同一段日文，人声轨比混音准确率明显高一档。

# 引擎选择（2026-11-06 在这台机器上实测过，不是凭口碑挑的）：
#   SenseVoice（sherpa-onnx，239MB，非自回归）—— 12 秒 0.13 秒出结果，同一段三次输出
#     一字不差。判别式模型，不会像 whisper 那样一卡住就循环吐同一句。
#   whisper —— 只作交叉校验用，默认关。实测 whisper-small 在这段日文上退化成了
#     78 遍「僕は」；medium 内容对但多印一个字；large-v3 干净但要 5.6 秒、3.1GB。
#     所以 whisper 不是主力，也**不适合**当裁判——它比正主更容易编。

# 置信度不靠模型自己报（sherpa 的 result 里没有分数），靠两条可验证的规则：
#   1. 交叉校验：另开一个引擎，两边归一化后的文本相似度低于阈值就算不一致；
#   2. 歌词对位：世界层拿到歌词时，用歌词去比这段转写，对不上就标 uncertain。
#      （第 2 条在 TS 侧做，这里只负责把文本交出去。）


_LEAN_PATCHED = False


def lean_sessions() -> None:
    """关掉 onnxruntime 的 CPU 内存竞技场。

    实测同一段 12 秒音频、同一台机器：
      默认（竞技场开）：常驻 4.6GB，单次 13.7 秒
      竞技场关：      常驻 425MB，单次 14.2 秒
    多花 0.5 秒换 4.2GB —— 对一个常驻的桌宠进程，这笔账没有悬念。
    竞技场本来是给「反复推理、形状固定」的批处理省 malloc 的，我们一次一首歌，用不上。

    库内部没有暴露这个选项，只能替换它的建会话函数；替换失败就让默认行为继续，
    宁可多占内存，不能因为一个优化把深听弄坏。
    """
    global _LEAN_PATCHED
    if _LEAN_PATCHED:
        return
    try:
        import onnxruntime as ort
        import demucs_onnx.inference as inf

        def _make(onnx_path, providers):
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            opts.enable_cpu_mem_arena = False
            return ort.InferenceSession(str(onnx_path), sess_options=opts, providers=list(providers))

        inf._make_session = _make
        _LEAN_PATCHED = True
    except Exception:
        pass


ASR_MIN_SEC = 6.0            # 短于这个时长听不出完整一句，别硬转
ASR_MIN_VOCAL_RMS = 0.004    # 人声轨太轻（纯器乐/清唱很远）就别浪费一次推理
ASR_MIN_VOCAL_SHARE = 0.05   # 人声在六轨里的能量占比低于这个，基本可以判成器乐
ASR_MODELS_SUBDIR = 'asr'
ASR_LANG_ZH = {'ja': '日语', 'zh': '中文', 'en': '英语', 'ko': '韩语', 'yue': '粤语'}
ASR_MAX_TEXT = 160

_SV_CACHE: dict = {}


def _to16k(audio: np.ndarray, sr: int) -> np.ndarray:
    """ASR 一律要 16k 单声道；分轨出来是 44.1/48k 双声道。"""
    mono = audio.mean(axis=0) if audio.ndim > 1 else np.asarray(audio)
    mono = np.asarray(mono, dtype=np.float32)
    if sr == 16000:
        return mono
    return resample(mono, sr, 16000)


def _normalize_text(s: str) -> str:
    """只留字：标点、空格、全半角差异都不该影响两个引擎是不是说了同一句。"""
    out = []
    for ch in s or '':
        if ch.isspace():
            continue
        if ch in '。、，,.!?！？…・「」『』()（）[]【】ー~～-—:：;；\'"“”‘’':
            continue
        out.append(ch)
    return ''.join(out).lower()


def _similarity(a: str, b: str) -> float:
    a, b = _normalize_text(a), _normalize_text(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    try:
        from difflib import SequenceMatcher
        return SequenceMatcher(None, a, b).ratio()
    except Exception:
        return 0.0


def _sensevoice(models_dir: Path):
    """懒加载并缓存。进程只跑一次，但同一个进程里可能被调用两次（校验用）。"""
    key = str(models_dir)
    if key in _SV_CACHE:
        return _SV_CACHE[key]
    rec = None
    try:
        import sherpa_onnx
        d = Path(models_dir) / ASR_MODELS_SUBDIR / 'sensevoice'
        model, tokens = d / 'model.int8.onnx', d / 'tokens.txt'
        if model.exists() and tokens.exists():
            rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(model), tokens=str(tokens),
                num_threads=max(2, (os.cpu_count() or 4) // 2), use_itn=True, debug=False,
            )
    except Exception:
        rec = None
    _SV_CACHE[key] = rec
    return rec


def _whisper(models_dir: Path, tier: str):
    key = f'{models_dir}|whisper-{tier}'
    if key in _SV_CACHE:
        return _SV_CACHE[key]
    model = None
    try:
        from faster_whisper import WhisperModel
        d = Path(models_dir) / ASR_MODELS_SUBDIR / f'whisper-{tier}'
        if (d / 'model.bin').exists():
            model = WhisperModel(str(d), device='cpu', compute_type='int8',
                                 cpu_threads=max(2, (os.cpu_count() or 4) // 2))
    except Exception:
        model = None
    _SV_CACHE[key] = model
    return model


def _tidy_text(s: str, lang: str) -> str:
    """收一下模型自己的排版：中日韩不要词间空格，句尾标点由调用方统一加，
    否则会拼出「…とか。。」这种两个句号。"""
    out = (s or '').strip()
    if lang in {'ja', 'zh', 'yue', 'ko'}:
        out = out.replace(' ', '')
    return out.strip('。.!?！？、，,;；:： ')


def _run_sensevoice(rec, mono16k: np.ndarray) -> dict:
    stream = rec.create_stream()
    stream.accept_waveform(16000, mono16k)
    rec.decode_stream(stream)
    r = stream.result
    lang = (getattr(r, 'lang', '') or '').replace('<|', '').replace('|>', '')
    return {
        'text': _tidy_text((getattr(r, 'text', '') or '')[:ASR_MAX_TEXT], lang),
        'lang': lang,
        'emotion': (getattr(r, 'emotion', '') or '').replace('<|', '').replace('|>', '').lower(),
        'event': (getattr(r, 'event', '') or '').replace('<|', '').replace('|>', '').lower(),
    }


def _run_whisper(model, mono16k: np.ndarray) -> dict:
    segments, info = model.transcribe(
        mono16k, language=None, temperature=0.0,
        condition_on_previous_text=False, no_speech_threshold=0.6,
        compression_ratio_threshold=2.4, vad_filter=False, beam_size=5,
    )
    text = ''.join(s.text for s in segments).strip()[:ASR_MAX_TEXT]
    return {
        'text': text,
        'lang': getattr(info, 'language', '') or '',
        'lang_prob': round(float(getattr(info, 'language_probability', 0.0) or 0.0), 2),
    }


def transcribe_vocals(
    vocal: np.ndarray, sr: int, models_dir: Path,
    cross_tier: str = '', min_sec: float = ASR_MIN_SEC,
) -> dict:
    """人声轨 → 一句唱词。失败不抛，返回 ok=False 和原因，别把整份分析带崩。"""
    started = time.time()
    out: dict = {'ok': False, 'engine': 'sensevoice'}
    try:
        mono = _to16k(vocal, sr)
        dur = len(mono) / 16000
        if dur < min_sec:
            out['error'] = f'人声段只有 {dur:.1f} 秒，太短不下结论'
            return out
        if rms(np.asarray(mono, dtype=np.float32)) < ASR_MIN_VOCAL_RMS:
            out['error'] = '人声太轻，没听到能成句的唱'
            return out

        rec = _sensevoice(models_dir)
        if rec is None:
            out['error'] = '本机没有 SenseVoice 模型'
            return out
        sv = _run_sensevoice(rec, mono)
        text = sv['text']
        lang = sv['lang']

        out.update({
            'ok': bool(text),
            'text': text,
            'lang': lang,
            'lang_zh': ASR_LANG_ZH.get(lang, ''),
            'emotion': sv['emotion'],
            'event': sv['event'],
            'confident': bool(text) and len(_normalize_text(text)) >= 3,
        })
        if not text:
            out['error'] = '这段没听出成句的词'

        # 交叉校验：只在显式要求时跑。默认关——实测 whisper 在唱段上比正主更容易编。
        if cross_tier:
            wm = _whisper(models_dir, cross_tier)
            if wm is not None:
                w = _run_whisper(wm, mono)
                out['alt'] = w['text']
                out['alt_lang'] = w['lang']
                sim = _similarity(text, w['text'])
                out['agree'] = round(sim, 2)
                out['cross'] = f'whisper-{cross_tier}'
                if text and w['text'] and sim < 0.6:
                    out['confident'] = False
            else:
                out['cross_error'] = f'没有 whisper-{cross_tier} 模型'
        out['elapsed_sec'] = round(time.time() - started, 2)
    except Exception as exc:
        out['error'] = f'{type(exc).__name__}: {exc}'
        out['elapsed_sec'] = round(time.time() - started, 2)
    return out


def run_analysis(wav: Path, *, models_dir: str, cache_dir: str | None, asr: bool,
                 asr_cross: str = '', keep_audio: bool = False) -> dict:
    """分析一段 WAV，返回一份结果字典。命令行和常驻模式共用这一份逻辑。"""
    lean_sessions()
    started = time.time()
    result: dict = {"ok": False, "engine": "demucs-onnx + local dsp"}
    try:
        mix, sr = sf.read(str(wav), dtype="float32", always_2d=True)
        mix = mix.T
        if mix.shape[1] < sr:
            raise RuntimeError("音频太短，至少需要 1 秒")
        duration = mix.shape[1] / sr
        from demucs_onnx import separate
        stems = separate(
            str(wav), model="htdemucs_6s", precision="fp16weights",
            providers="cpu", cache_dir=cache_dir, progress=False,
        )
        levels = {}
        for name in STEM_ORDER:
            arr = stems.get(name)
            if arr is None:
                levels[name] = 0.0
            else:
                arr = np.asarray(arr, dtype=np.float32)
                if arr.ndim == 1:
                    arr = np.stack([arr, arr])
                levels[name] = round(rms(arr), 4)
        total = sum(levels.values()) or 1.0
        shares = {k: round(v / total, 3) for k, v in levels.items()}
        harmonic = np.zeros_like(mix)
        for name in ("bass", "other", "guitar", "piano"):
            arr = stems.get(name)
            if arr is not None:
                a = np.asarray(arr, dtype=np.float32)
                harmonic += a if a.shape == harmonic.shape else np.pad(a, ((0, 0), (0, max(0, harmonic.shape[1] - a.shape[1]))))[:, :harmonic.shape[1]]
        chroma = chroma_vector(harmonic, sr)
        key = key_of(chroma) if np.any(chroma) else "不明确"
        chords = chord_timeline(harmonic, sr)
        key = reconcile_key(key, chords)
        vocals = stems.get("vocals")
        vocal = np.asarray(vocals, dtype=np.float32) if vocals is not None else np.zeros((2, 48000), dtype=np.float32)
        melody = vocal_melody(vocal, sr)
        # 唱词：只有在人声这一轨确实有东西时才转写。纯器乐白白多花 0.1 秒也不该做，
        # 更不该在没人声的时候编出一句词来。
        speech: dict = {}
        if asr:
            share = shares.get("vocals", 0.0)
            if share < ASR_MIN_VOCAL_SHARE:
                speech = {"ok": False, "skipped": True,
                          "error": f"人声占比只有 {share:.2f}，这段大概是器乐"}
            elif duration < ASR_MIN_SEC:
                speech = {"ok": False, "skipped": True, "error": f"切片只有 {duration:.1f} 秒，太短"}
            else:
                speech = transcribe_vocals(
                    vocal, sr, Path(models_dir), cross_tier=asr_cross,
                )
        instruments = []
        other = stems.get("other")
        if other is not None and levels.get("other", 0) > 0.001:
            try:
                instruments = classify_instrument(np.asarray(other, dtype=np.float32), sr,
                                                   Path(models_dir) / "instrument-classification.onnx",
                                                   Path(models_dir) / "instrument-config.json")
            except Exception as exc:
                instruments = [{"name": f"分类器不可用：{exc}", "score": 0.0}]
        present = [STEM_ZH[k] for k in STEM_ORDER if shares.get(k, 0) >= 0.08]
        vocal_text = melody.get("summary", "")
        chord_text = "–".join(c["chord"] for c in chords[:8]) if chords else "没抓到稳定和弦"
        instrument_text = "、".join(f"{x['name']}({x['score']:.2f})" for x in instruments[:2] if x.get("score", 0) > 0.05)
        # 唱词那一句要带引擎和语种：她引用的时候得能说清「这是机器听的」，而不是「我听见你在唱」。
        speech_text = ""
        if speech.get("ok") and speech.get("text"):
            marks = []
            if speech.get("lang_zh"):
                marks.append(speech["lang_zh"])
            if not speech.get("confident"):
                marks.append("不确定")
            tag = f"（{'，'.join(marks)}）" if marks else ""
            speech_text = f"人声轨转写{tag}：{speech['text']}"
        summary = (
            f"约 {duration:.1f} 秒切片；能量构成：{'、'.join(present) if present else '很弱'}。"
            f"调性：{key}；和弦走向：{chord_text}。"
            f"{vocal_text}。"
            + (f"{speech_text}。" if speech_text else "")
            + (f"「其他乐器」分类倾向：{instrument_text}。" if instrument_text else "")
        )
        result.update({
            "ok": True,
            "duration_sec": round(duration, 2),
            "sample_rate": sr,
            "stem_rms": levels,
            "stem_share": shares,
            "key": key,
            "chords": chords,
            "melody": melody,
            "instruments": instruments,
            "speech": speech,
            "summary": summary,
            "elapsed_sec": round(time.time() - started, 1),
            "note": "旋律与乐器来自 12 秒左右切片和本地模型，是倾向不是总谱；和弦与调性也可能被转调、和声叠层干扰。",
        })
    except Exception as exc:
        result.update({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                       "elapsed_sec": round(time.time() - started, 1)})
    result.setdefault("elapsed_sec", round(time.time() - started, 1))
    if not keep_audio:
        try:
            wav.unlink(missing_ok=True)
        except Exception:
            pass
    return result


def serve() -> int:
    """常驻模式：stdin 一行一个请求 JSON，stdout 一行一个结果 JSON。

    为什么需要它：单次进程跑一遍，光给 onnxruntime 建会话就 6.3 秒
    （实测同一段音频：新进程 19.9 秒，同进程第二次 13.6 秒）。她一首歌可能要被问好几次，
    这 6 秒每次都白花。常驻把这笔摊掉，代价是得管生命周期——父进程没了要跟着死。

    协议故意用行分隔 JSON：某一行解析失败只丢那一条，不会脏掉后面的请求。
    文件不经过磁盘：结果直接从 stdout 回去，少一次写+读。
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--models-dir", default=str(Path(__file__).resolve().parent / "models"))
    ap.add_argument("--cache-dir", default=None)
    args = ap.parse_args()

    # **必须先把管道编码钉成 UTF-8。**
    # Windows 下 stdout 默认走控制台代码页（cp936），中文写出去就是 GBK 字节，
    # 而 Node 那边按 utf8 解 —— 2026-11-06 就这么把「G# 小调」「王菲」全变成了乱码，
    # 而且因为 JSON 结构没坏、字段都在，看起来像成功了，只有内容是一堆问号。
    try:
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    lean_sessions()
    try:
        from demucs_onnx import prewarm
        prewarm(models=["htdemucs_6s"], precision="fp16weights", providers="cpu",
                cache_dir=args.cache_dir)
    except Exception as exc:
        sys.stderr.write(f"prewarm 失败（不影响后续，只是第一次会慢）：{exc}\n")
    try:
        _sensevoice(Path(args.models_dir))
    except Exception as exc:
        sys.stderr.write(f"SenseVoice 预加载失败：{exc}\n")
    sys.stdout.write('{"ready":true}\n')
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("exit"):
            break
        try:
            res = run_analysis(
                Path(req["wav"]),
                models_dir=args.models_dir,
                cache_dir=args.cache_dir,
                asr=bool(req.get("asr")),
                asr_cross=str(req.get("asr_cross") or ""),
                keep_audio=bool(req.get("keep_audio")),
            )
        except Exception as exc:
            res = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(res, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


def main() -> int:
    if "--serve" in sys.argv:
        return serve()
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--models-dir", default=str(Path(__file__).resolve().parent / "models"))
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--keep-audio", action="store_true")
    ap.add_argument("--asr", action="store_true", help="用人声轨转写唱词")
    ap.add_argument("--asr-cross", default="", help="交叉校验用哪档 whisper（small/medium/large-v3），空=不校验")
    args = ap.parse_args()
    wav = Path(args.wav)
    out = Path(args.out)
    result = run_analysis(wav, models_dir=args.models_dir, cache_dir=args.cache_dir,
                          asr=args.asr, asr_cross=args.asr_cross, keep_audio=args.keep_audio)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
