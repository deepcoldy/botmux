/**
 * OpenAI-compatible ASR adapter — 语音消息转写。
 *
 * Targets the de-facto-standard `POST {baseUrl}/audio/transcriptions` contract
 * (whisper API format), so it works with OpenAI's cloud ASR and any
 * self-hosted compatible server (whisper.cpp server, faster-whisper, etc.) —
 * users bring their own baseUrl/key, same pattern as the TTS adapter in
 * openai.ts. Feishu voice messages are ogg/opus, which the whisper API decodes
 * natively — no ffmpeg dependency.
 *
 * Zero new dependencies: uses Node 22 global fetch / FormData / Blob.
 */
import { readFileSync } from 'node:fs';

export interface ResolvedAsrConfig {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey?: string; // 缺省则不带 Authorization（自托管场景）
  model: string; // e.g. whisper-1
  timeoutMs: number; // 默认 120000
  language?: string; // ISO-639-1，如 'zh'
}

export interface TranscribeOpts {
  timeoutMs?: number; // 覆盖 cfg.timeoutMs
  language?: string; // 覆盖 cfg.language
}

/**
 * Transcribe an audio file to text. Returns the trimmed transcript; throws
 * Error（中文 message）on any failure（HTTP 错误 / 超时 / 空结果）。
 */
export async function transcribeAudioFile(
  cfg: ResolvedAsrConfig,
  audioPath: string,
  opts: TranscribeOpts = {},
): Promise<string> {
  const buf = readFileSync(audioPath);
  const form = new FormData();
  // 飞书语音是 ogg/opus；显式给 Blob 一个 .ogg 文件名，部分服务靠扩展名/
  // content-type 选择解码器。不手动设 Content-Type——fetch 会自动补
  // multipart boundary。
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', cfg.model);
  const language = opts.language ?? cfg.language;
  if (language) form.append('language', language);

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ASR HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    // OpenAI 返回 {"text": "..."}；部分兼容服务直接返回纯文本。
    const contentType = res.headers.get('content-type') ?? '';
    const raw = contentType.includes('application/json')
      ? String(((await res.json()) as { text?: unknown })?.text ?? '')
      : await res.text();
    const text = raw.trim();
    if (!text) throw new Error('ASR 转写结果为空');
    return text;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('ASR 转写超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
