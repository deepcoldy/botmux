import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';
import {
  connectRealtimeVoiceTransport,
  DEFAULT_REALTIME_VOICE_FRAME_MS,
  REALTIME_VOICE_PROTO_NOT_CONFIGURED,
  RealtimeVoiceNotConfiguredError,
  RealtimeVoiceSession,
  bytesPerRealtimeFrame,
  createProtoRealtimeVoiceProtocol,
  encodeAudioFrameEvent,
  encodeFrontierFrame,
  encodeSessionCloseEvent,
  encodeSessionCreateEvent,
  FRONTIER_FRAME_TYPE_NORMAL,
  FRONTIER_METHOD,
  FRONTIER_SERVICE,
  paceRealtimeVoiceFrames,
  pcmToRealtimeVoiceFrameBatch,
  splitPcmIntoRealtimeFrames,
  type RealtimeVoiceProtocol,
  type RealtimeVoiceTransport,
} from '../src/vc-agent/realtime/index.js';
import type { Pcm } from '../src/services/voice/audio.js';

interface TestWsServer {
  url: string;
  httpServer: Server;
  wss: WebSocketServer;
  close(): Promise<void>;
}

function makePcm(durationMs: number): Pcm {
  const sampleRate = 24_000;
  const channels = 1;
  const bytes = sampleRate * channels * 2 * durationMs / 1000;
  return { sampleRate, channels, data: Buffer.alloc(bytes) };
}

async function makeWsServer(): Promise<TestWsServer> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    httpServer,
    wss,
    async close(): Promise<void> {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function wsDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

describe('vc realtime voice frame utilities', () => {
  it('uses the realtime protocol default of 100ms frames', () => {
    const split = splitPcmIntoRealtimeFrames(makePcm(100));
    expect(split.format.frameMs).toBe(DEFAULT_REALTIME_VOICE_FRAME_MS);
    expect(bytesPerRealtimeFrame(split.format)).toBe(4_800);
    expect(split.frames).toHaveLength(1);
    expect(split.frames[0].data.length).toBe(4_800);
  });

  it('splits 24k mono s16le PCM into 20ms frames', () => {
    const pcm = makePcm(50);
    const split = splitPcmIntoRealtimeFrames(pcm, { frameMs: 20 });

    expect(bytesPerRealtimeFrame(split.format)).toBe(960);
    expect(split.durationMs).toBe(50);
    expect(split.frames.map(f => ({
      seq: f.seq,
      bytes: f.data.length,
      offsetMs: f.offsetMs,
      durationMs: f.durationMs,
    }))).toEqual([
      { seq: 0, bytes: 960, offsetMs: 0, durationMs: 20 },
      { seq: 1, bytes: 960, offsetMs: 20, durationMs: 20 },
      { seq: 2, bytes: 480, offsetMs: 40, durationMs: 10 },
    ]);
  });

  it('rejects PCM buffers that are not aligned to sample frames', () => {
    expect(() => splitPcmIntoRealtimeFrames({
      sampleRate: 24_000,
      channels: 1,
      data: Buffer.alloc(3),
    })).toThrow(/not aligned/);
  });

  it('paces frames by wall-clock offsets', async () => {
    const { frames } = splitPcmIntoRealtimeFrames(makePcm(45), { frameMs: 20 });
    let clock = 1_000;
    const sleeps: number[] = [];
    const sentAt: number[] = [];

    await paceRealtimeVoiceFrames(
      frames,
      () => { sentAt.push(clock); },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      },
    );

    expect(sleeps).toEqual([20, 20]);
    expect(sentAt).toEqual([1_000, 1_020, 1_040]);
  });

  it('builds a realtime frame batch from existing PCM', () => {
    const batch = pcmToRealtimeVoiceFrameBatch(makePcm(40), { frameMs: 20 });
    expect(batch.durationMs).toBe(40);
    expect(batch.format).toMatchObject({ encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, frameMs: 20 });
    expect(batch.frames).toHaveLength(2);
  });
});

describe('RealtimeVoiceSession skeleton', () => {
  it('fails closed before proto encoders are configured', async () => {
    const session = new RealtimeVoiceSession({ larkAppId: 'cli_app', meetingId: 'm1' });

    let caught: unknown;
    try {
      await session.start();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RealtimeVoiceNotConfiguredError);
    expect((caught as RealtimeVoiceNotConfiguredError).code).toBe(REALTIME_VOICE_PROTO_NOT_CONFIGURED);
    expect(session.status).toBe('failed');
  });

  it('waits for session.created before marking the session started', async () => {
    const sent: Buffer[] = [];
    const incoming = [Buffer.from('session.created')];
    const protocol: RealtimeVoiceProtocol = {
      configured: true,
      encodeSessionCreate: () => Buffer.from('session.create'),
      encodeAudioFrame: () => Buffer.from('audio'),
      decodeServerEvent: () => ({ type: 'session.created', sessionId: 12345n }),
    };
    const transport: RealtimeVoiceTransport = {
      send: async (data) => { sent.push(data); },
      receive: async () => incoming.shift() ?? new Promise<Buffer>(() => { /* keep read loop pending */ }),
    };
    const session = new RealtimeVoiceSession({
      larkAppId: 'cli_app',
      meetingId: 'm1',
      protocol,
      transport,
    });

    await session.start();

    expect(session.status).toBe('started');
    expect(session.sessionId).toBe(12345n);
    expect(sent.map(b => b.toString())).toEqual(['session.create']);
  });

  it('fails start on server error before session.created', async () => {
    const protocol: RealtimeVoiceProtocol = {
      configured: true,
      encodeSessionCreate: () => Buffer.from('session.create'),
      encodeAudioFrame: () => Buffer.from('audio'),
      decodeServerEvent: () => ({ type: 'error', code: 4002, message: 'permission denied' }),
    };
    const session = new RealtimeVoiceSession({
      larkAppId: 'cli_app',
      meetingId: 'm1',
      protocol,
      transport: {
        send: async () => {},
        receive: async () => Buffer.from('error'),
      },
    });

    await expect(session.start()).rejects.toThrow(/permission denied/);
    expect(session.status).toBe('failed');
  });

  it('fails start when session.created omits the server session id', async () => {
    const protocol: RealtimeVoiceProtocol = {
      configured: true,
      encodeSessionCreate: () => Buffer.from('session.create'),
      encodeAudioFrame: () => Buffer.from('audio'),
      decodeServerEvent: () => ({ type: 'session.created' }),
    };
    const session = new RealtimeVoiceSession({
      larkAppId: 'cli_app',
      meetingId: 'm1',
      protocol,
      transport: {
        send: async () => {},
        receive: async () => Buffer.from('session.created'),
      },
    });

    await expect(session.start()).rejects.toThrow(/session_id/);
    expect(session.status).toBe('failed');
  });

  it('sends session.close on stop after the server assigns a session id', async () => {
    const sent: string[] = [];
    const incoming = [Buffer.from('session.created')];
    const protocol: RealtimeVoiceProtocol = {
      configured: true,
      encodeSessionCreate: () => Buffer.from('session.create'),
      encodeAudioFrame: () => Buffer.from('audio'),
      encodeSessionClose: (sessionId) => Buffer.from(`session.close:${sessionId}`),
      decodeServerEvent: () => ({ type: 'session.created', sessionId: 67890n }),
    };
    let closed = false;
    const session = new RealtimeVoiceSession({
      larkAppId: 'cli_app',
      meetingId: 'm1',
      protocol,
      transport: {
        send: async (data) => { sent.push(data.toString()); },
        receive: async () => incoming.shift() ?? new Promise<Buffer>(() => { /* keep read loop pending */ }),
        close: async () => { closed = true; },
      },
    });

    await session.start();
    await session.stop('test');

    expect(sent).toEqual(['session.create', 'session.close:67890']);
    expect(closed).toBe(true);
    expect(session.status).toBe('stopped');
  });
});

describe('VC realtime WebSocket transport', () => {
  it('queues inbound WS messages that arrive before receive() is called', async () => {
    const server = await makeWsServer();
    try {
      server.wss.on('connection', (ws) => {
        ws.send(Buffer.from('frontier-frame-1'));
      });
      const transport = await connectRealtimeVoiceTransport(server.url);

      const received = await transport.receive();

      expect(received?.toString()).toBe('frontier-frame-1');
      await transport.close();
    } finally {
      await server.close();
    }
  });

  it('sends each Buffer as one binary WebSocket message and exposes bufferedAmount', async () => {
    const server = await makeWsServer();
    const received: Buffer[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      server.wss.on('connection', (ws) => {
        ws.on('message', (data, isBinary) => {
          expect(isBinary).toBe(true);
          received.push(wsDataToBuffer(data));
          if (received.length === 2) resolve();
        });
      });
    });
    try {
      const transport = await connectRealtimeVoiceTransport(server.url);
      await transport.send(Buffer.from('frame-a'));
      await transport.send(Buffer.from('frame-b'));

      await gotTwo;

      expect(received.map(b => b.toString())).toEqual(['frame-a', 'frame-b']);
      expect(transport.bufferedAmount()).toBeGreaterThanOrEqual(0);
      await transport.close();
    } finally {
      await server.close();
    }
  });

  it('resolves receive() with undefined when the socket closes cleanly', async () => {
    const server = await makeWsServer();
    server.wss.on('connection', (ws) => {
      ws.close();
    });
    try {
      const transport = await connectRealtimeVoiceTransport(server.url);

      await expect(transport.receive()).resolves.toBeUndefined();
      await transport.close();
    } finally {
      await server.close();
    }
  });
});

describe('VC realtime protobuf codec', () => {
  const format = {
    encoding: 'pcm_s16le' as const,
    sampleRate: 24_000,
    channels: 1,
    frameMs: 100,
  };

  // Generated by reference Python pb2 files for fixed inputs via:
  //   python3 scripts/generate-vc-realtime-golden.py --reference-dir <reference-dir>
  // These lock the hand-written Node codec to the reference client wire format.
  const SESSION_CREATE_HEX = '0a0e73657373696f6e2e637265617465122431313131313131312d323232322d333333332d343434342d3535353535353535353535352214323032362d30372d30315430303a30303a30305a52340a320a300a160a09617564696f2f70636d12057331366c6518c0bb0112160a09617564696f2f70636d12057331366c6518c0bb01';
  const FRONTIER_SESSION_CREATE_HEX = '0801100018898a80102001320662696e6172793a166170706c69636174696f6e2f782d70726f746f6275664282010a0e73657373696f6e2e637265617465122431313131313131312d323232322d333333332d343434342d3535353535353535353535352214323032362d30372d30315430303a30303a30305a52340a320a300a160a09617564696f2f70636d12057331366c6518c0bb0112160a09617564696f2f70636d12057331366c6518c0bb014a005a2431313131313131312d323232322d333333332d343434342d3535353535353535353535356000';
  const AUDIO_APPEND_HEX = '0a15617564696f2e757073747265616d2e617070656e6418b9602214323032362d30372d30315430303a30303a30325a5a050a03616263';
  const SESSION_CLOSE_HEX = '0a0d73657373696f6e2e636c6f7365122461616161616161612d626262622d636363632d646464642d65656565656565656565656518b9602214323032362d30372d30315430303a30303a30335a6a020801';
  const SERVER_SESSION_CREATED_FRONTIER_HEX = '0802100018898a80102001320662696e6172793a166170706c69636174696f6e2f782d70726f746f6275664297010a0f73657373696f6e2e63726561746564120f7365727665722d6576656e742d696418b9602214323032362d30372d30315430303a30303a30315a525a0a2431313131313131312d323232322d333333332d343434342d35353535353535353535353512320a300a160a09617564696f2f70636d12057331366c6518c0bb0112160a09617564696f2f70636d12057331366c6518c0bb014a005a0f7365727665722d6576656e742d69646000';

  it('matches the Python pb2 bytes for session.create and Frontier wrapping', () => {
    const event = encodeSessionCreateEvent(format, {
      eventId: '11111111-2222-3333-4444-555555555555',
      createdAt: '2026-07-01T00:00:00Z',
    });
    expect(event.payload.toString('hex')).toBe(SESSION_CREATE_HEX);

    const frame = encodeFrontierFrame({
      seqId: 1n,
      service: FRONTIER_SERVICE,
      method: FRONTIER_METHOD,
      payload: event.payload,
      msgId: event.eventId,
      frameType: FRONTIER_FRAME_TYPE_NORMAL,
    });
    expect(frame.toString('hex')).toBe(FRONTIER_SESSION_CREATE_HEX);
  });

  it('matches the Python pb2 bytes for audio append and session.close', () => {
    const frame = {
      seq: 0,
      offsetMs: 0,
      durationMs: 100,
      data: Buffer.from('abc'),
      format,
    };
    const append = encodeAudioFrameEvent(frame, 12345n, {
      createdAt: '2026-07-01T00:00:02Z',
    });
    expect(append.payload.toString('hex')).toBe(AUDIO_APPEND_HEX);

    const close = encodeSessionCloseEvent(12345n, {
      eventId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      createdAt: '2026-07-01T00:00:03Z',
    });
    expect(close.payload.toString('hex')).toBe(SESSION_CLOSE_HEX);
  });

  it('decodes Python pb2 server frames through the Frontier wrapper', () => {
    const protocol = createProtoRealtimeVoiceProtocol();
    const event = protocol.decodeServerEvent(Buffer.from(SERVER_SESSION_CREATED_FRONTIER_HEX, 'hex'));

    expect(event).toMatchObject({
      type: 'session.created',
      eventId: 'server-event-id',
      sessionId: 12345n,
      createdAt: '2026-07-01T00:00:01Z',
      clientEventId: '11111111-2222-3333-4444-555555555555',
    });
  });
});
