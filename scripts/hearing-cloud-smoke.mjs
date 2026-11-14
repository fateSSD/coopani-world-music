/**
 * 云端深听的端到端自检（不需要真的 API 密钥）。
 *
 * 起一个假的 OpenAI 兼容服务：检查请求里有没有 input_audio、是不是流式，
 * 然后故意把 SSE 行切成两半分块发回去，验证客户端能拼回来并解析成切片结论。
 */
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { cloudListen } from '../src/hearing.ts';

const WAV = 'C:/Users/Administrator/AppData/Local/Temp/hearing-test/coopani-hearing.wav';
if (!existsSync(WAV)) {
  console.error('没有测试用的 WAV：', WAV);
  process.exit(2);
}

const seen = { audio: false, stream: false, model: '', bytes: 0 };
const answer = {
  tonic: 'A# 小调',
  chords: ['C#m', 'D#m', 'A#m'],
  melody: ['E4', 'F#4', 'D4'],
  voices: ['人声', '鼓', '贝斯'],
  instruments: [{ name: '电吉他', score: 0.62 }],
  summary: '人声在中音区，鼓很实，贝斯贴着根音走',
};

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  seen.model = body.model;
  seen.stream = body.stream === true;
  const audio = body.messages?.[1]?.content?.find((p) => p.type === 'input_audio');
  if (audio?.input_audio?.data?.startsWith('data:audio/wav;base64,')) {
    seen.audio = true;
    seen.bytes = Buffer.from(audio.input_audio.data.split(',')[1], 'base64').byteLength;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payload = `data: {"choices":[{"delta":{"content":${JSON.stringify(JSON.stringify(answer))}}}]}\n\ndata: [DONE]\n`;
  // 故意从中间切开：客户端必须自己攒行。
  const cut = Math.floor(payload.length / 2);
  res.write(payload.slice(0, cut));
  await new Promise((r) => setTimeout(r, 30));
  res.end(payload.slice(cut));
});

await new Promise((r) => server.listen(8791, '127.0.0.1', r));
try {
  const res = await cloudListen(WAV, { base: 'http://127.0.0.1:8791/v1', model: 'mock-omni', key: 'sk-test' }, {
    at: Date.now(), posSec: 42, seconds: 12,
  });
  console.log(JSON.stringify({ seen, ok: res.ok, slice: res.ok ? res.slice : res.reason }, null, 2));
  if (!seen.audio || !seen.stream) throw new Error('请求没带音频或不是流式');
  if (!res.ok) throw new Error(`解析失败：${res.reason}`);
  if (res.slice.tonic !== 'A# 小调' || res.slice.chords.length !== 3) throw new Error('字段没解出来');
  if (Math.abs(seen.bytes - statSync(WAV).size) > 8) throw new Error('上传的音频和文件不一致');
  console.log('云端端到端：通过');
} finally {
  server.close();
}
