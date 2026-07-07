import type { Pcm } from '../../services/voice/audio.js';
import {
  DEFAULT_REALTIME_VOICE_FRAME_MS,
  REALTIME_VOICE_ENCODING,
  type RealtimeVoiceAudioFormat,
  type RealtimeVoiceFrame,
} from './types.js';

export interface SplitPcmFrameOptions {
  frameMs?: number;
}

export interface PaceRealtimeVoiceFramesOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  bufferedAmount?: () => number;
  maxBufferedAmount?: number;
  backpressureSleepMs?: number;
}

const DEFAULT_MAX_BUFFERED_AMOUNT = 512 * 1024;
const DEFAULT_BACKPRESSURE_SLEEP_MS = 10;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function realtimeAudioFormatFromPcm(
  pcm: Pcm,
  opts: SplitPcmFrameOptions = {},
): RealtimeVoiceAudioFormat {
  return {
    encoding: REALTIME_VOICE_ENCODING,
    sampleRate: pcm.sampleRate,
    channels: pcm.channels,
    frameMs: opts.frameMs ?? DEFAULT_REALTIME_VOICE_FRAME_MS,
  };
}

export function bytesPerRealtimeFrame(format: RealtimeVoiceAudioFormat): number {
  if (format.encoding !== REALTIME_VOICE_ENCODING) {
    throw new Error(`unsupported realtime audio encoding: ${format.encoding}`);
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`invalid realtime audio sampleRate: ${format.sampleRate}`);
  }
  if (!Number.isInteger(format.channels) || format.channels <= 0) {
    throw new Error(`invalid realtime audio channels: ${format.channels}`);
  }
  if (!Number.isInteger(format.frameMs) || format.frameMs <= 0) {
    throw new Error(`invalid realtime audio frameMs: ${format.frameMs}`);
  }
  const bytes = (format.sampleRate * format.channels * 2 * format.frameMs) / 1000;
  if (!Number.isInteger(bytes)) {
    throw new Error(`realtime audio frame size is fractional: ${bytes} bytes`);
  }
  return bytes;
}

export function splitPcmIntoRealtimeFrames(
  pcm: Pcm,
  opts: SplitPcmFrameOptions = {},
): { format: RealtimeVoiceAudioFormat; frames: RealtimeVoiceFrame[]; durationMs: number } {
  const format = realtimeAudioFormatFromPcm(pcm, opts);
  const bytesPerSampleFrame = format.channels * 2;
  if (pcm.data.length % bytesPerSampleFrame !== 0) {
    throw new Error(`PCM byte length ${pcm.data.length} is not aligned to ${bytesPerSampleFrame}-byte sample frames`);
  }
  const frameBytes = bytesPerRealtimeFrame(format);
  const frames: RealtimeVoiceFrame[] = [];
  let offset = 0;
  let seq = 0;
  while (offset < pcm.data.length) {
    const next = Math.min(offset + frameBytes, pcm.data.length);
    const data = pcm.data.subarray(offset, next);
    const sampleFrames = data.length / bytesPerSampleFrame;
    frames.push({
      seq,
      offsetMs: Math.round((offset / bytesPerSampleFrame / format.sampleRate) * 1000),
      durationMs: Math.round((sampleFrames / format.sampleRate) * 1000),
      data,
      format,
    });
    offset = next;
    seq += 1;
  }
  return {
    format,
    frames,
    durationMs: Math.round((pcm.data.length / bytesPerSampleFrame / format.sampleRate) * 1000),
  };
}

export async function paceRealtimeVoiceFrames(
  frames: RealtimeVoiceFrame[],
  send: (frame: RealtimeVoiceFrame) => void | Promise<void>,
  opts: PaceRealtimeVoiceFramesOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  const maxBufferedAmount = opts.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;
  const backpressureSleepMs = opts.backpressureSleepMs ?? DEFAULT_BACKPRESSURE_SLEEP_MS;

  for (const frame of frames) {
    const waitMs = start + frame.offsetMs - now();
    if (waitMs > 0) await sleep(waitMs);
    while (opts.bufferedAmount && opts.bufferedAmount() > maxBufferedAmount) {
      await sleep(backpressureSleepMs);
    }
    await send(frame);
  }
}
