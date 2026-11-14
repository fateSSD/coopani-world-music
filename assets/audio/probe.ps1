param(
  [string]$Out = "$env:TEMP\coopani-audio.json",
  [int]$Hz = 10,
  [int]$Seconds = 0,
  [int]$ParentPid = 0,
  [switch]$TestBeep
)

# 编译前先把 TEMP 换到自己的缓存目录。
#
# 为什么：Add-Type 要把内联的 C# 先写成一个临时 .cs 再调编译器，临时文件落在 %TEMP%。
# 而 Core 启动子进程时把 TEMP 指到了它自己的 data\tmp —— 那里编译会失败（「无法添加类型」），
# 错误只落在 stderr 里，外面看到的就是「进程活着、CPU 为 0、JSON 一直不动」。
# 这个坑花了一晚上：单跑脚本永远正常，只有被 Core 拉起来才失败。
$cache = Join-Path $env:LOCALAPPDATA 'CoopaniAudio\tmp'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$env:TEMP = $cache
$env:TMP = $cache

# 系统输出回环采集 —— 纯 C#（WASAPI），不依赖任何 DLL、不装驱动。
# 干什么：把声卡正在放的东西复制一份，算出 低音/中音/高音 能量、整体响度、还有拍子（BPM）。
# 只在本机算，写一个几十字节的 JSON；不录音、不存波形、不联网。
#
# ⚠ 这个文件必须存成 **UTF-8 with BOM**。PowerShell 5.1 读没有 BOM 的 .ps1 会按 ANSI(GBK) 解释，
# 中文注释的多字节会把换行吃掉、和下一行代码粘成一体，编译器报一堆「名称不存在」的怪错。

$src = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CoopaniAudio
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
        public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePos, out ulong qpcPos);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    public static class Probe
    {
        [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

        // ---- 状态（每 100ms 写一次盘）----
        static double _rms, _bass, _mid, _high;
        static double _bpm;
        static volatile bool _beat;
        static long _beatAtMs;
        static string _outPath;
        static int _parentPid;
        static volatile bool _stop;
        static string _error;
        static long _frames, _packets;
        static long _lastWriteMs;
        // 最近 12 秒只留在内存；只有收到深听请求才写一个临时 WAV。
        static float[] _ring;
        static int _ringPos, _ringCount, _channels = 2, _rate = 48000;
        static readonly object _ringLock = new object();
        static long NowMs() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

        static void EnsureRing(int channels, int rate)
        {
            lock (_ringLock)
            {
                _channels = channels;
                _rate = rate;
                int need = channels * rate * 12;
                if (_ring == null || _ring.Length < need)
                {
                    _ring = new float[need];
                    _ringPos = 0;
                    _ringCount = 0;
                }
            }
        }

        static void AppendRing(float[] buffer, int count)
        {
            lock (_ringLock)
            {
                if (_ring == null) return;
                int cap = _ring.Length;
                int pos = _ringPos;
                int first = Math.Min(count, cap - pos);
                Array.Copy(buffer, 0, _ring, pos, first);
                if (count > first) Array.Copy(buffer, first, _ring, 0, count - first);
                _ringPos = (pos + count) % cap;
                _ringCount = Math.Min(cap, _ringCount + count);
            }
        }

        static float[] SnapshotRing()
        {
            lock (_ringLock)
            {
                if (_ring == null || _ringCount == 0) return new float[0];
                int cap = _ring.Length;
                int start = (_ringPos - _ringCount + cap) % cap;
                var copy = new float[_ringCount];
                int first = Math.Min(_ringCount, cap - start);
                Array.Copy(_ring, start, copy, 0, first);
                if (_ringCount > first) Array.Copy(_ring, 0, copy, first, _ringCount - first);
                return copy;
            }
        }

        /** 只在有 coopani-hearing.request 时落一个 12 秒 PCM16 临时 WAV；读完由分析器删除。 */
        static void MaybeDump()
        {
            string dir = Path.GetDirectoryName(_outPath);
            if (String.IsNullOrEmpty(dir)) dir = ".";
            string req = Path.Combine(dir, "coopani-hearing.request");
            if (!File.Exists(req)) return;
            try
            {
                var samples = SnapshotRing();
                if (samples.Length < _rate * _channels * 3) return;
                string wav = Path.Combine(dir, "coopani-hearing.wav");
                string tmp = wav + ".tmp";
                WritePcm16(tmp, samples, _channels, _rate);
                if (File.Exists(wav)) File.Delete(wav);
                File.Move(tmp, wav);
                File.Delete(req);
            }
            catch
            {
                // 请求留着，下一个 100ms 再试；绝不因为深听失败影响跟拍。
            }
        }

        static void WritePcm16(string path, float[] samples, int channels, int rate)
        {
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read))
            using (var w = new BinaryWriter(fs))
            {
                int dataBytes = samples.Length * 2;
                w.Write(new[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' });
                w.Write(36 + dataBytes);
                w.Write(new[] { (byte)'W', (byte)'A', (byte)'V', (byte)'E' });
                w.Write(new[] { (byte)'f', (byte)'m', (byte)'t', (byte)' ' });
                w.Write(16);
                w.Write((short)1);
                w.Write((short)channels);
                w.Write(rate);
                w.Write(rate * channels * 2);
                w.Write((short)(channels * 2));
                w.Write((short)16);
                w.Write(new[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a' });
                w.Write(dataBytes);
                for (int i = 0; i < samples.Length; i++)
                {
                    double v = Math.Max(-1.0, Math.Min(1.0, samples[i]));
                    w.Write((short)Math.Round(v * 32767.0));
                }
            }
        }

        public static void Run(string outPath, int hz, int seconds, int parentPid, bool testBeep)
        {
            _outPath = outPath;
            _parentPid = parentPid;
            // 采集由 WMI 独立启动，不再继承 Core 的作业对象；但仍跟随 Core 的生命周期。
            // 主循环每半秒确认一次父进程，Core 退出后这里也退出，不留常驻孤儿。
            if (testBeep)
            {
                var t = new Thread(() => { try { while (true) { Console.Beep(880, 110); Thread.Sleep(290); } } catch { } });
                t.IsBackground = true; t.Start();
            }
            try { ShowWindow(GetConsoleWindow(), 0); } catch { }
            try
            {
                var worker = StartWorker(hz);
                var end = seconds > 0 ? DateTime.UtcNow.AddSeconds(seconds) : DateTime.MaxValue;
                // 采集线程会卡死（换歌、切设备），卡了以后一滴数据都不再写。主线程每半秒看一眼：
                // **3 秒没写盘就掐掉重开一个**。这是最后一道保险，比让整个功能静默失效强。
                while (!_stop && DateTime.UtcNow < end)
                {
                    if (_parentPid > 0)
                    {
                        try { if (System.Diagnostics.Process.GetProcessById(_parentPid).HasExited) break; }
                        catch { break; }
                    }
                    Thread.Sleep(500);
                    if (NowMs() - _lastWriteMs < 3000) continue;
                    // 不 Abort：线程卡在 COM 里时 Abort 会一直等它返回，主线程跟着一起死。
                    // 直接再开一个；卡住的那个是后台线程，进程退出时一起收走。
                    worker = StartWorker(hz);
                    _error = "worker-restart";
                    Write();
                    _error = null;
                }
                _stop = true;
            }
            catch (Exception ex) { _error = ex.Message; Write(); }
        }

        /** 释放客户端。换歌、切设备都会让回环流作废，只能整个重开。 */
        static void Release(ref IAudioClient client, ref IAudioCaptureClient capture, ref IntPtr fmtPtr)
        {
            try { if (client != null) client.Stop(); } catch { }
            try { if (capture != null) Marshal.ReleaseComObject(capture); } catch { }
            try { if (client != null) Marshal.ReleaseComObject(client); } catch { }
            try { if (fmtPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(fmtPtr); } catch { }
            fmtPtr = IntPtr.Zero;
            capture = null;
            client = null;
        }

        static Thread StartWorker(int hz)
        {
            var t = new Thread(() => Loop(hz));
            t.IsBackground = true;
            t.Name = "coopani-audio";
            t.Start();
            _lastWriteMs = NowMs();
            return t;
        }

        static void Loop(int hz)
        {
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            IntPtr fmtPtr = IntPtr.Zero;
            int channels = 2, rate = 48000;

            var sw = System.Diagnostics.Stopwatch.StartNew();
            long nextWrite = 0, lastOnset = -10000, lastFrameAt = 0;
            var intervals = new System.Collections.Generic.List<double>();
            double bassEma = 0.003, prevBass = 0;
            double lpBass = 0, lpMid = 0, aBass = 0.02, aMid = 0.3;
            float[] buffer = new float[1 << 16];

            while (!_stop)
            {
                /* ---- 打开（或重开）采集 ----
                 * 回环客户端会被「换歌 / 切默认设备 / 独占模式」弄死，死了之后 GetNextPacketSize 一直返错。
                 * 原先是 sleep 一下再 continue —— 于是永远不再写文件：进程活着、CPU 为 0、数值停在死掉那一刻。
                 * 现在出错一律「释放 + 重开」，两秒没数据也重开。
                 */
                if (client == null)
                {
                    capture = null;
                    fmtPtr = IntPtr.Zero;
                    try
                    {
                        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
                        IMMDevice device;
                        int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out device);
                        if (hr != 0) { _error = "no-device"; Write(); Thread.Sleep(1000); continue; }
                        Guid iidClient = typeof(IAudioClient).GUID;
                        object o;
                        hr = device.Activate(ref iidClient, 1, IntPtr.Zero, out o);
                        if (hr != 0) { _error = "activate-" + hr; Write(); Thread.Sleep(1000); continue; }
                        client = (IAudioClient)o;
                        hr = client.GetMixFormat(out fmtPtr);
                        if (hr != 0) { _error = "mixfmt-" + hr; Release(ref client, ref capture, ref fmtPtr); Thread.Sleep(600); continue; }
                        var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
                        channels = fmt.nChannels;
                        rate = (int)fmt.nSamplesPerSec;
                        EnsureRing(channels, rate);
                        // LOOPBACK(0x20000) | NOPERSIST(0x80000)
                        hr = client.Initialize(0, 0x20000 | 0x80000, 10000000, 0, fmtPtr, IntPtr.Zero);
                        if (hr != 0) { _error = "init-" + hr; Release(ref client, ref capture, ref fmtPtr); Thread.Sleep(600); continue; }
                        Guid iidCapture = typeof(IAudioCaptureClient).GUID;
                        object cap;
                        hr = client.GetService(ref iidCapture, out cap);
                        if (hr != 0) { _error = "service-" + hr; Release(ref client, ref capture, ref fmtPtr); Thread.Sleep(600); continue; }
                        capture = (IAudioCaptureClient)cap;
                        client.Start();
                        aBass = 1.0 - Math.Exp(-2 * Math.PI * 150.0 / rate);
                        aMid = 1.0 - Math.Exp(-2 * Math.PI * 2500.0 / rate);
                        _error = null;
                        lastFrameAt = sw.ElapsedMilliseconds;
                    }
                    catch (Exception ex)
                    {
                        _error = "open:" + ex.GetType().Name;
                        Release(ref client, ref capture, ref fmtPtr);
                        Thread.Sleep(600);
                        continue;
                    }
                }

                uint pending = 0;
                if (capture.GetNextPacketSize(out pending) != 0)
                {
                    Release(ref client, ref capture, ref fmtPtr);
                    _error = "stream-lost";
                    continue;
                }

                int guard = 0;
                while (pending > 0 && guard++ < 64)
                {
                    IntPtr data; uint frames, flags; ulong dpos, qpos;
                    if (capture.GetBuffer(out data, out frames, out flags, out dpos, out qpos) != 0)
                    {
                        Release(ref client, ref capture, ref fmtPtr);
                        break;
                    }
                    if (frames > 0)
                    {
                        int need = (int)frames * channels;
                        if (buffer.Length < need) buffer = new float[need];
                        if (data != IntPtr.Zero && (flags & 0x2) == 0) // 0x2 = SILENT
                            Marshal.Copy(data, buffer, 0, need);
                        else
                            Array.Clear(buffer, 0, need);
                        AppendRing(buffer, need);

                        double sum = 0, bs = 0, ms = 0;
                        for (int i = 0; i < need; i++)
                        {
                            double v = buffer[i];
                            sum += v * v;
                            lpBass += (v - lpBass) * aBass;
                            lpMid += (v - lpMid) * aMid;
                            bs += lpBass * lpBass;
                            ms += lpMid * lpMid;
                        }
                        _frames += need; _packets++;
                        lastFrameAt = sw.ElapsedMilliseconds;
                        double rms = Math.Sqrt(sum / need);
                        _rms = _rms * 0.6 + rms * 0.4;
                        _bass = _bass * 0.6 + Math.Sqrt(bs / need) * 0.4;
                        _mid = _mid * 0.6 + Math.Sqrt(ms / need) * 0.4;
                        _high = _high * 0.6 + Math.Max(0, rms - Math.Sqrt(ms / need)) * 0.4;

                        // 拍子：**只看低音，不看整体响度。**
                        // 用整体响度会把军鼓 / 吉他反拍也算成拍点 —— 一首 72 BPM 的慢歌会被数成 140。
                        double bassRms = Math.Sqrt(bs / need);
                        bassEma = bassEma * 0.95 + bassRms * 0.05;
                        long nowMs = sw.ElapsedMilliseconds;
                        if (bassRms > 0.004 && bassRms > bassEma * 1.5 && bassRms > prevBass && nowMs - lastOnset > 180)
                        {
                            if (lastOnset > 0)
                            {
                                intervals.Add(nowMs - lastOnset);
                                if (intervals.Count > 12) intervals.RemoveAt(0);
                                double bpm = 60000.0 / Median(intervals);
                                while (bpm < 55) bpm *= 2;
                                while (bpm > 130) bpm /= 2;
                                _bpm = _bpm <= 0 ? bpm : _bpm * 0.75 + bpm * 0.25;
                            }
                            lastOnset = nowMs;
                            _beat = true;
                            _beatAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        }
                        prevBass = bassRms;
                    }
                    capture.ReleaseBuffer(frames);
                    if (capture.GetNextPacketSize(out pending) != 0) break;
                }

                // 两秒没有新数据 = 流死了，重开
                if (client != null && sw.ElapsedMilliseconds - lastFrameAt > 2000)
                {
                    Release(ref client, ref capture, ref fmtPtr);
                    _error = "reopen";
                    continue;
                }

                if (sw.ElapsedMilliseconds >= nextWrite)
                {
                    nextWrite = sw.ElapsedMilliseconds + 1000 / Math.Max(1, hz);
                    if (_bpm > 0 && sw.ElapsedMilliseconds - lastOnset > 4000) _bpm = 0;
                    Write();
                    if (_beat && sw.ElapsedMilliseconds - lastOnset > 120) _beat = false;
                }
                Thread.Sleep(5);
            }
        }

        static double Median(System.Collections.Generic.List<double> xs)
        {
            var a = xs.ToArray();
            Array.Sort(a);
            int n = a.Length;
            return n == 0 ? 500 : (n % 2 == 1 ? a[n / 2] : (a[n / 2 - 1] + a[n / 2]) / 2);
        }

        static void Write()
        {
            try
            {
                var sb = new StringBuilder(160);
                sb.Append('{');
                if (_error != null) sb.Append("\"error\":\"").Append(_error.Replace("\"", "'")).Append("\",");
                sb.Append("\"bpm\":").Append((int)Math.Round(_bpm));
                sb.Append(",\"rms\":").Append(Math.Round(_rms, 4).ToString(System.Globalization.CultureInfo.InvariantCulture));
                sb.Append(",\"bass\":").Append(Math.Round(_bass, 4).ToString(System.Globalization.CultureInfo.InvariantCulture));
                sb.Append(",\"mid\":").Append(Math.Round(_mid, 4).ToString(System.Globalization.CultureInfo.InvariantCulture));
                sb.Append(",\"high\":").Append(Math.Round(_high, 4).ToString(System.Globalization.CultureInfo.InvariantCulture));
                sb.Append(",\"beat\":").Append(_beat ? "true" : "false");
                sb.Append(",\"beatAt\":").Append(_beatAtMs);
                sb.Append(",\"frames\":").Append(_frames);
                sb.Append(",\"packets\":").Append(_packets);
                sb.Append(",\"at\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                sb.Append('}');
                // **原地覆盖写，不删不搬。**
                // 原来写 tmp 再 File.Delete + File.Move —— 读的一方（页面每 200ms 一次）正开着文件时，
                // Windows 上删不掉，重试几次仍失败就整轮跳过。表现是「进程活着、CPU 为 0、文件不再更新」。
                // 一条 130 字节的 JSON 一次写完，读者最多读到半截，下一轮就好 —— 比停死强得多。
                using (var fs = new FileStream(_outPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                using (var w = new StreamWriter(fs, new UTF8Encoding(false)))
                {
                    w.Write(sb.ToString());
                }
                MaybeDump();
                _lastWriteMs = NowMs();
            }
            catch { }
        }
    }
}
'@

# pid 必须由本进程自己交出去。
#
# Core 是拿 conhost.exe --headless 起本进程的，所以它手里的 child.pid 是**宿主**的 pid。
# 实测（2026-10-31）：杀掉 conhost 之后这条 powershell 仍然活着 —— Core 那边「杀宿主」
# 收不到尸，watchAudio 每重开一次就漏一个采集进程；而 Core 还活着，下面那个
# -ParentPid 看门狗根本不会触发。多个进程同时读声卡，能量值会互相打架。
#
# 写在 Add-Type 之前：编译要几秒，早点落盘 Core 才能早点认领。
# 写失败不致命，Core 会退回只看文件 mtime。
try {
  [System.IO.File]::WriteAllText("$Out.pid", [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
} catch { }

Add-Type -TypeDefinition $src -Language CSharp | Out-Null
[CoopaniAudio.Probe]::Run($Out, $Hz, $Seconds, $ParentPid, [bool]$TestBeep)
