import type { Pcm } from '../../services/voice/audio.js';

export const DEFAULT_REALTIME_VOICE_SAMPLE_RATE = 24_000;
export const DEFAULT_REALTIME_VOICE_CHANNELS = 1;
export const DEFAULT_REALTIME_VOICE_FRAME_MS = 100;
export const REALTIME_VOICE_ENCODING = 'pcm_s16le';

export type RealtimeVoiceEncoding = typeof REALTIME_VOICE_ENCODING;

export interface RealtimeVoiceAudioFormat {
  encoding: RealtimeVoiceEncoding;
  sampleRate: number;
  channels: number;
  frameMs: number;
}

export interface RealtimeVoiceFrame {
  seq: number;
  offsetMs: number;
  durationMs: number;
  data: Buffer;
  format: RealtimeVoiceAudioFormat;
}

export interface RealtimeVoiceFrameBatch {
  pcm: Pcm;
  format: RealtimeVoiceAudioFormat;
  frames: RealtimeVoiceFrame[];
  durationMs: number;
}

export interface RealtimeVoiceSessionInfo {
  larkAppId: string;
  meetingId: string;
  meetingNo?: string;
}

export type RealtimeVoiceSessionStatus =
  | 'idle'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface RealtimeVoiceProtocol {
  readonly configured: boolean;
  encodeSessionCreate(format: RealtimeVoiceAudioFormat): Buffer;
  encodeAudioFrame(frame: RealtimeVoiceFrame, sessionId: bigint): Buffer;
  encodeAudioUpstreamClear?(sessionId: bigint): Buffer;
  encodeSessionClose?(sessionId: bigint): Buffer;
  decodeServerEvent(data: Buffer): DecodedRealtimeServerEvent | undefined;
}

export type DecodedRealtimeServerEvent =
  | {
      type: 'session.created';
      eventId?: string;
      sessionId?: bigint;
      createdAt?: string;
      clientEventId?: string;
    }
  | {
      type: 'audio.downstream.delta';
      eventId?: string;
      sessionId?: bigint;
      createdAt?: string;
      trackId?: string;
      source?: string;
      ptsMs?: bigint;
      durationMs?: number;
      delta?: Buffer;
    }
  | {
      type: 'session.closed';
      eventId?: string;
      sessionId?: bigint;
      createdAt?: string;
      reason?: number;
    }
  | {
      type: 'error';
      eventId?: string;
      sessionId?: bigint;
      createdAt?: string;
      clientEventId?: string;
      code?: number;
      message?: string;
      retryable?: boolean;
    }
  | {
      type: 'unknown';
      rawType?: string;
      eventId?: string;
      sessionId?: bigint;
      createdAt?: string;
    };

export interface RealtimeVoiceTransport {
  send(data: Buffer): void | Promise<void>;
  receive(): Promise<Buffer | undefined>;
  close?(): void | Promise<void>;
  bufferedAmount?(): number;
}
