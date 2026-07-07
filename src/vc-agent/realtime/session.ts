import { protoNotConfigured, transportNotConfigured } from './errors.js';
import { createUnavailableRealtimeVoiceProtocol } from './protocol.js';
import { paceRealtimeVoiceFrames, type PaceRealtimeVoiceFramesOptions } from './pacer.js';
import { synthesizeRealtimeVoiceFrameBatch } from './audio-source.js';
import {
  DEFAULT_REALTIME_VOICE_CHANNELS,
  DEFAULT_REALTIME_VOICE_FRAME_MS,
  DEFAULT_REALTIME_VOICE_SAMPLE_RATE,
  type DecodedRealtimeServerEvent,
  type RealtimeVoiceAudioFormat,
  type RealtimeVoiceFrame,
  type RealtimeVoiceProtocol,
  type RealtimeVoiceSessionInfo,
  type RealtimeVoiceSessionStatus,
  type RealtimeVoiceTransport,
} from './types.js';

export interface RealtimeVoiceSessionOptions extends RealtimeVoiceSessionInfo {
  audioFormat?: Partial<RealtimeVoiceAudioFormat>;
  protocol?: RealtimeVoiceProtocol;
  transport?: RealtimeVoiceTransport;
  sendBinary?: (data: Buffer) => void | Promise<void>;
  handshakeTimeoutMs?: number;
  pacer?: PaceRealtimeVoiceFramesOptions;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export class RealtimeVoiceSession {
  readonly info: RealtimeVoiceSessionInfo;
  readonly audioFormat: RealtimeVoiceAudioFormat;
  private readonly protocol: RealtimeVoiceProtocol;
  private readonly transport?: RealtimeVoiceTransport;
  private readonly pacer?: PaceRealtimeVoiceFramesOptions;
  private readonly handshakeTimeoutMs: number;
  private statusValue: RealtimeVoiceSessionStatus = 'idle';
  private lastErrorValue?: string;
  private startPromise?: Promise<void>;
  private readLoopPromise?: Promise<void>;
  private sessionIdValue?: bigint;

  constructor(opts: RealtimeVoiceSessionOptions) {
    this.info = {
      larkAppId: opts.larkAppId,
      meetingId: opts.meetingId,
      ...(opts.meetingNo ? { meetingNo: opts.meetingNo } : {}),
    };
    this.audioFormat = {
      encoding: 'pcm_s16le',
      sampleRate: opts.audioFormat?.sampleRate ?? DEFAULT_REALTIME_VOICE_SAMPLE_RATE,
      channels: opts.audioFormat?.channels ?? DEFAULT_REALTIME_VOICE_CHANNELS,
      frameMs: opts.audioFormat?.frameMs ?? DEFAULT_REALTIME_VOICE_FRAME_MS,
    };
    this.protocol = opts.protocol ?? createUnavailableRealtimeVoiceProtocol();
    this.transport = opts.transport ?? (opts.sendBinary ? {
      send: opts.sendBinary,
      receive: async () => transportNotConfigured(),
    } : undefined);
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.pacer = opts.pacer;
  }

  get status(): RealtimeVoiceSessionStatus {
    return this.statusValue;
  }

  get lastError(): string | undefined {
    return this.lastErrorValue;
  }

  get sessionId(): bigint | undefined {
    return this.sessionIdValue;
  }

  async start(): Promise<void> {
    if (this.statusValue === 'started') return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.statusValue = 'starting';
    try {
      if (!this.protocol.configured) {
        protoNotConfigured('RealtimeVoiceSession.start() requires Frontier + ClientEvent encoders.');
      }
      const transport = this.requireTransport();
      const createEvent = this.protocol.encodeSessionCreate(this.audioFormat);
      await transport.send(createEvent);
      const created = await this.waitForSessionCreated();
      this.sessionIdValue = created.sessionId;
      this.statusValue = 'started';
      this.lastErrorValue = undefined;
      this.startReadLoop();
    } catch (err) {
      this.statusValue = 'failed';
      this.lastErrorValue = err instanceof Error ? err.message : String(err);
      try {
        await this.transport?.close?.();
      } catch {
        // ignore start-failure close errors
      }
      throw err;
    }
  }

  async speak(text: string): Promise<{ frames: number; durationMs: number }> {
    if (this.statusValue !== 'started') {
      throw new Error(`VC realtime voice session is not started (status=${this.statusValue})`);
    }
    if (!this.protocol.configured) {
      protoNotConfigured('RealtimeVoiceSession.speak() requires ClientEvent audio encoders.');
    }
    const transport = this.requireTransport();
    const sessionId = this.sessionIdValue;
    if (sessionId === undefined) {
      throw new Error('VC realtime voice session has no server session_id');
    }

    const batch = await synthesizeRealtimeVoiceFrameBatch(this.info.larkAppId, text, {
      frameMs: this.audioFormat.frameMs,
    });
    if (batch.format.sampleRate !== this.audioFormat.sampleRate || batch.format.channels !== this.audioFormat.channels) {
      throw new Error(
        `PCM format ${batch.format.sampleRate}Hz/${batch.format.channels}ch does not match realtime session ` +
        `${this.audioFormat.sampleRate}Hz/${this.audioFormat.channels}ch`,
      );
    }
    await paceRealtimeVoiceFrames(
      batch.frames,
      async (frame: RealtimeVoiceFrame) => {
        await transport.send(this.protocol.encodeAudioFrame(frame, sessionId));
      },
      {
        ...this.pacer,
        bufferedAmount: this.pacer?.bufferedAmount ?? transport.bufferedAmount?.bind(transport),
      },
    );
    return { frames: batch.frames.length, durationMs: batch.durationMs };
  }

  async stop(_reason?: string): Promise<void> {
    if (this.statusValue === 'stopped' || this.statusValue === 'idle') {
      this.statusValue = 'stopped';
      return;
    }
    const transport = this.transport;
    const sessionId = this.sessionIdValue;
    this.statusValue = 'stopping';
    try {
      if (transport && sessionId !== undefined && this.protocol.configured) {
        const close = this.protocol.encodeSessionClose?.(sessionId);
        if (close) await transport.send(close);
      }
    } finally {
      await transport?.close?.();
      this.statusValue = 'stopped';
    }
  }

  private requireTransport(): RealtimeVoiceTransport {
    if (!this.transport) transportNotConfigured();
    return this.transport;
  }

  private async waitForSessionCreated(): Promise<{ sessionId: bigint }> {
    const transport = this.requireTransport();
    const deadline = Date.now() + this.handshakeTimeoutMs;
    while (Date.now() <= deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const data = await withTimeout(transport.receive(), remaining, 'Timed out waiting for realtime session.created');
      if (!data) throw new Error('Realtime voice transport closed before session.created');
      const event = this.protocol.decodeServerEvent(data);
      if (!event) continue;
      if (event.type === 'session.created') {
        if (event.sessionId === undefined) {
          throw new Error('Realtime voice session.created did not include session_id');
        }
        return { sessionId: event.sessionId };
      }
      this.assertNonFatalServerEvent(event);
    }
    throw new Error('Timed out waiting for realtime session.created');
  }

  private startReadLoop(): void {
    if (this.readLoopPromise) return;
    const transport = this.transport;
    if (!transport) return;
    this.readLoopPromise = (async () => {
      while (this.statusValue === 'started') {
        const data = await transport.receive();
        if (!data) {
          if (this.statusValue === 'started') this.statusValue = 'stopped';
          return;
        }
        const event = this.protocol.decodeServerEvent(data);
        if (!event) continue;
        if (event.type === 'session.closed') {
          this.statusValue = 'stopped';
          return;
        }
        if (event.type === 'error') {
          const message = realtimeServerErrorMessage(event);
          this.statusValue = 'failed';
          this.lastErrorValue = message;
          return;
        }
      }
    })().catch(err => {
      if (this.statusValue !== 'stopping' && this.statusValue !== 'stopped') {
        this.statusValue = 'failed';
        this.lastErrorValue = err instanceof Error ? err.message : String(err);
      }
    }).finally(() => {
      this.readLoopPromise = undefined;
    });
  }

  private assertNonFatalServerEvent(event: DecodedRealtimeServerEvent): void {
    if (event.type === 'error') throw new Error(realtimeServerErrorMessage(event));
    if (event.type === 'session.closed') throw new Error(`Realtime voice session closed before session.created (reason=${event.reason ?? 'unknown'})`);
  }
}

function realtimeServerErrorMessage(event: Extract<DecodedRealtimeServerEvent, { type: 'error' }>): string {
  const code = event.code === undefined ? 'unknown' : String(event.code);
  return `Realtime voice server error code=${code}: ${event.message ?? 'unknown error'}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
