/**
 * OpenAI-compatible TTS adapter — the open-source default engine.
 *
 * Targets the de-facto-standard `POST {baseUrl}/audio/speech` contract, so it
 * works with OpenAI's cloud TTS and any self-hosted compatible server
 * (Kokoro-FastAPI, openedai-speech, etc.) — users bring their own baseUrl/key.
 *
 * We request `response_format: 'pcm'` (24kHz s16le mono, per the OpenAI spec)
 * so the rest of the pipeline shares one clean PCM→opus encode path. Servers
 * that don't implement pcm should be configured against one that does.
 */
import type { Pcm } from './audio.js';
import type { VoiceProviderEffectOptions } from './sami.js';

export interface OpenAITtsConfig {
  baseUrl: string; // e.g. https://api.openai.com/v1 or http://127.0.0.1:8880/v1
  apiKey: string;
  model: string; // e.g. tts-1 / kokoro
}

const OPENAI_PCM_SR = 24000; // OpenAI /audio/speech pcm output is 24kHz s16le mono

export interface OpenAISynthOpts {
  speaker: string; // maps to the `voice` field
  rate?: number; // maps to `speed` (0.25–4.0)
  timeoutMs?: number;
}

export async function openaiSynthesizePcm(
  cfg: OpenAITtsConfig,
  text: string,
  opts: OpenAISynthOpts,
  effects: VoiceProviderEffectOptions = {},
): Promise<Pcm> {
  const clean = text.trim();
  if (!clean) throw new Error('没有要合成的文字');
  if (!cfg.baseUrl || !cfg.model) throw new Error('OpenAI 兼容引擎配置不完整（需要 baseUrl / model）。');
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/audio/speech`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: clean,
    voice: opts.speaker,
    response_format: 'pcm',
  };
  if (opts.rate && opts.rate !== 1) body.speed = Math.max(0.25, Math.min(4, opts.rate));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
  try {
    await effects.beforeProviderEffect?.();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) throw new Error('TTS 返回空音频');
    return { data, sampleRate: OPENAI_PCM_SR, channels: 1 };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('TTS 合成超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
