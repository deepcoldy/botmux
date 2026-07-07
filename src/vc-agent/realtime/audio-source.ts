import { pcmDurationMs, type Pcm } from '../../services/voice/audio.js';
import { synthesizeVoicePcmForMessage } from '../../services/voice/index.js';
import { splitPcmIntoRealtimeFrames, type SplitPcmFrameOptions } from './pacer.js';
import type { RealtimeVoiceFrameBatch } from './types.js';

export function pcmToRealtimeVoiceFrameBatch(
  pcm: Pcm,
  opts: SplitPcmFrameOptions = {},
): RealtimeVoiceFrameBatch {
  const split = splitPcmIntoRealtimeFrames(pcm, opts);
  return {
    pcm,
    format: split.format,
    frames: split.frames,
    durationMs: pcmDurationMs(pcm),
  };
}

export async function synthesizeRealtimeVoiceFrameBatch(
  larkAppId: string | undefined,
  text: string,
  opts: SplitPcmFrameOptions = {},
): Promise<RealtimeVoiceFrameBatch> {
  const pcm = await synthesizeVoicePcmForMessage(larkAppId, text);
  return pcmToRealtimeVoiceFrameBatch(pcm, opts);
}
