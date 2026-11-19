import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pcm } from './audio.js';
import type { VoiceProviderEffectOptions } from './sami.js';
import type { VolcengineMode, VolcengineTtsConfig } from './types.js';
import { resolveVolcengineConfig } from './volcengine-config.js';

export const DEFAULT_VOLCENGINE_SPEAKER = 'zh_female_vv_uranus_bigtts';

const ENDPOINTS = {
  standard: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  'agent-plan': 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
} satisfies Record<VolcengineMode, string>;

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PCM_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const recordSchema = z.object({
  code: z.number().int(),
  data: z.string().nullable().optional(),
});

class VolcengineError extends Error {}

export interface VolcengineSynthOpts {
  speaker: string;
  rate?: number;
  timeoutMs?: number;
}

function parsePcm(body: Uint8Array): Pcm {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new VolcengineError('Volcengine TTS invalid UTF-8');
  }
  const audio: Buffer[] = [];
  let pcmBytes = 0;
  let records = 0;
  let completed = false;
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (start === -1) {
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue;
      if (completed || char !== '{') throw new VolcengineError('Volcengine TTS invalid trailing record');
      if (++records > MAX_RECORDS) throw new VolcengineError('Volcengine TTS record limit exceeded');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth !== 0) continue;

    let value: unknown;
    try {
      value = JSON.parse(source.slice(start, i + 1));
    } catch {
      throw new VolcengineError('Volcengine TTS malformed JSON');
    }
    start = -1;
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) throw new VolcengineError('Volcengine TTS invalid record');
    const record = parsed.data;
    if (record.code === 20000000) {
      if (record.data) throw new VolcengineError('Volcengine TTS unexpected completion audio');
      completed = true;
    } else if (record.code === 0) {
      if (!record.data) continue;
      const data = record.data;
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      if (data.length % 4 !== 0
        || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))
        || (padding > 0 && alphabet.indexOf(data[data.length - padding - 1] ?? '') % (padding === 2 ? 16 : 4) !== 0)) {
        throw new VolcengineError('Volcengine TTS invalid base64');
      }
      const size = data.length / 4 * 3 - padding;
      if (pcmBytes + size > MAX_PCM_BYTES) throw new VolcengineError('Volcengine TTS PCM limit exceeded');
      const decoded = Buffer.from(data, 'base64');
      if (decoded.toString('base64') !== data) throw new VolcengineError('Volcengine TTS noncanonical base64');
      pcmBytes += size;
      audio.push(decoded);
    } else {
      throw new VolcengineError(`火山引擎语音合成返回业务错误（Volcengine TTS business code ${record.code}）`);
    }
  }
  if (start !== -1 || !completed) throw new VolcengineError('Volcengine TTS incomplete response');
  if (pcmBytes === 0) throw new VolcengineError('Volcengine TTS empty audio');
  if (pcmBytes % 2 !== 0) throw new VolcengineError('Volcengine TTS unaligned PCM');
  return { data: Buffer.concat(audio, pcmBytes), sampleRate: 24000, channels: 1 };
}

export async function volcengineSynthesizePcm(
  cfg: VolcengineTtsConfig,
  text: string,
  opts: VolcengineSynthOpts,
  effects: VoiceProviderEffectOptions = {},
): Promise<Pcm> {
  const credentials = resolveVolcengineConfig(cfg);
  if (!credentials) throw new VolcengineError('Volcengine TTS requires explicit mode and API key');
  if (typeof text !== 'string' || !text.trim()) throw new VolcengineError('Volcengine TTS requires text');
  if (typeof opts.speaker !== 'string' || !opts.speaker.trim()) throw new VolcengineError('Volcengine TTS requires speaker');
  const rate = opts.rate ?? 1;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!Number.isFinite(rate) || rate <= 0) throw new VolcengineError('Volcengine TTS invalid rate');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new VolcengineError('Volcengine TTS invalid timeout');
  }
  const request = {
    req_params: {
      text: text.trim(),
      speaker: opts.speaker.trim(),
      audio_params: {
        format: 'pcm',
        sample_rate: 24000,
        speech_rate: Math.round((Math.max(0.5, Math.min(2, rate)) - 1) * 100),
      },
    },
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': credentials.apiKey,
    'X-Api-Resource-Id': 'seed-tts-2.0',
    'X-Api-Request-Id': randomUUID(),
  };
  const body = JSON.stringify(request);
  await effects.beforeProviderEffect?.();
  const controller = new AbortController();
  const expires = performance.now() + timeoutMs;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new VolcengineError('Volcengine TTS timeout'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(ENDPOINTS[credentials.mode], {
      method: 'POST', headers, body, redirect: 'error', signal: controller.signal,
    }), deadline]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new VolcengineError(`火山引擎语音合成请求失败（Volcengine TTS HTTP ${response.status}）`);
    }
    if (!response.body) throw new VolcengineError('Volcengine TTS missing response body');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new VolcengineError('Volcengine TTS body limit exceeded');
      chunks.push(part.value);
    }
    if (performance.now() >= expires) throw new VolcengineError('Volcengine TTS timeout');
    const pcm = parsePcm(Buffer.concat(chunks, bytes));
    if (performance.now() >= expires) throw new VolcengineError('Volcengine TTS timeout');
    return pcm;
  } catch (error: unknown) {
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    if (timedOut || performance.now() >= expires) throw new VolcengineError('Volcengine TTS timeout');
    if (error instanceof VolcengineError) throw error;
    throw new VolcengineError('Volcengine TTS transport failure');
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}
