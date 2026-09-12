/**
 * MiniMax T2A v2 adapter.
 *
 * The synchronous API returns JSON with hex-encoded audio. Requesting mono PCM
 * keeps the engine boundary identical to the rest of the voice pipeline.
 */
import type { Pcm } from './audio.js';
import type { VoiceProviderEffectOptions } from './sami.js';

export const MINIMAX_GLOBAL_TTS_ENDPOINT = 'https://api.minimax.io/v1/t2a_v2';
export const MINIMAX_CN_TTS_ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2';
export const DEFAULT_MINIMAX_TTS_MODEL = 'speech-2.8-hd';
export const DEFAULT_MINIMAX_SPEAKER = 'female-shaonv';

const MINIMAX_PCM_SAMPLE_RATE = 24000;
const MINIMAX_PCM_CHANNELS = 1;

export interface MiniMaxTtsConfig {
  apiKey: string;
  model?: string;
  region?: 'global' | 'cn';
}

export interface MiniMaxSynthOpts {
  speaker: string;
  rate?: number;
  timeoutMs?: number;
}

interface MiniMaxTtsResponse {
  data?: {
    audio?: unknown;
    status?: unknown;
  } | null;
  extra_info?: {
    audio_sample_rate?: unknown;
    audio_channel?: unknown;
    audio_format?: unknown;
  };
  base_resp?: {
    status_code?: unknown;
    status_msg?: unknown;
  };
}

function endpointForRegion(region: MiniMaxTtsConfig['region']): string {
  return region === 'cn' ? MINIMAX_CN_TTS_ENDPOINT : MINIMAX_GLOBAL_TTS_ENDPOINT;
}

function numericMetadata(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function minimaxSynthesizePcm(
  cfg: MiniMaxTtsConfig,
  text: string,
  opts: MiniMaxSynthOpts,
  effects: VoiceProviderEffectOptions = {},
): Promise<Pcm> {
  const clean = text.trim();
  if (!clean) throw new Error('No text was provided for speech synthesis.');
  if (!cfg.apiKey) throw new Error('MiniMax TTS requires an API key.');

  const body = {
    model: cfg.model?.trim() || DEFAULT_MINIMAX_TTS_MODEL,
    text: clean,
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: opts.speaker,
      speed: Math.max(0.5, Math.min(2, opts.rate ?? 1)),
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: MINIMAX_PCM_SAMPLE_RATE,
      format: 'pcm',
      channel: MINIMAX_PCM_CHANNELS,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
  try {
    await effects.beforeProviderEffect?.();
    const res = await fetch(endpointForRegion(cfg.region), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`MiniMax TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const payload = await res.json() as MiniMaxTtsResponse;
    const statusCode = payload.base_resp?.status_code;
    if (statusCode !== 0) {
      const statusMessage = typeof payload.base_resp?.status_msg === 'string'
        ? payload.base_resp.status_msg
        : 'unknown error';
      throw new Error(`MiniMax TTS error ${String(statusCode)}: ${statusMessage}`);
    }
    if (payload.data?.status !== 2) {
      throw new Error(`MiniMax TTS returned incomplete audio status ${String(payload.data?.status)}.`);
    }
    if (payload.extra_info?.audio_format !== undefined && payload.extra_info.audio_format !== 'pcm') {
      throw new Error(`MiniMax TTS returned unexpected audio format ${String(payload.extra_info.audio_format)}.`);
    }

    const audio = payload.data?.audio;
    if (typeof audio !== 'string' || audio.length === 0 || audio.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(audio)) {
      throw new Error('MiniMax TTS returned invalid hex audio.');
    }
    const data = Buffer.from(audio, 'hex');
    if (data.length === 0) throw new Error('MiniMax TTS returned empty audio.');

    return {
      data,
      sampleRate: numericMetadata(payload.extra_info?.audio_sample_rate, MINIMAX_PCM_SAMPLE_RATE),
      channels: numericMetadata(payload.extra_info?.audio_channel, MINIMAX_PCM_CHANNELS),
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('MiniMax TTS synthesis timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
