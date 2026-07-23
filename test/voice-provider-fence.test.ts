import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];

    readonly url: string;
    readonly send = vi.fn();
    readonly close = vi.fn();
    private readonly listeners = new Map<string, Array<(...args: any[]) => unknown>>();

    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }

    on(event: string, listener: (...args: any[]) => unknown): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    async emit(event: string, ...args: any[]): Promise<void> {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        await listener(...args);
      }
    }
  }

  return { FakeWebSocket };
});

vi.mock('ws', () => ({ default: FakeWebSocket }));

import { openaiSynthesizePcm } from '../src/services/voice/openai.js';
import { mintSamiToken, samiSynthesizePcm } from '../src/services/voice/sami.js';

const SAMI_CREDS = {
  accessKey: 'access',
  secretKey: 'secret',
  appkey: 'app',
  tokenUrl: 'https://token.example.test',
  wsUrl: 'wss://speech.example.test',
};

function tokenResponse(): Response {
  return new Response(JSON.stringify({ token: 'short-lived-token' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('voice provider effect fences', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fences SAMI token minting before fetch and fails closed when revoked', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintSamiToken(SAMI_CREDS, 60, {
      beforeProviderEffect: () => { throw new Error('origin revoked before token'); },
    })).rejects.toThrow('origin revoked before token');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fences SAMI WebSocket construction after token minting', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    let fenceCall = 0;
    const beforeProviderEffect = vi.fn(async () => {
      fenceCall += 1;
      if (fenceCall === 2) throw new Error('origin revoked before connect');
    });

    await expect(samiSynthesizePcm(
      SAMI_CREDS,
      'hello',
      { speaker: 'voice' },
      { beforeProviderEffect },
    )).rejects.toThrow('origin revoked before connect');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beforeProviderEffect).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('awaits a fresh fence after async WebSocket open before sending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
    const sendFence = deferred();
    let fenceCall = 0;
    const beforeProviderEffect = vi.fn(async () => {
      fenceCall += 1;
      if (fenceCall === 3) await sendFence.promise;
    });

    const synthesis = samiSynthesizePcm(
      SAMI_CREDS,
      ' hello ',
      { speaker: 'voice' },
      { beforeProviderEffect },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;

    const opening = socket.emit('open');
    await vi.waitFor(() => expect(beforeProviderEffect).toHaveBeenCalledTimes(3));
    expect(socket.send).not.toHaveBeenCalled();

    sendFence.resolve();
    await opening;
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(socket.send.mock.calls[0]![0]))).toMatchObject({
      token: 'short-lived-token',
      appkey: 'app',
      namespace: 'TTS',
      event: 'StartTask',
    });

    await socket.emit('message', Buffer.from([1, 2, 3]), true);
    await socket.emit('message', Buffer.from(JSON.stringify({
      status_code: 20000000,
      event: 'TaskFinished',
    })), false);
    await expect(synthesis).resolves.toMatchObject({
      data: Buffer.from([1, 2, 3]),
      sampleRate: 24000,
      channels: 1,
    });
  });

  it('does not send on an opened SAMI socket when the last-moment fence revokes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
    let fenceCall = 0;
    const beforeProviderEffect = vi.fn(async () => {
      fenceCall += 1;
      if (fenceCall === 3) throw new Error('origin revoked before send');
    });

    const synthesis = samiSynthesizePcm(
      SAMI_CREDS,
      'hello',
      { speaker: 'voice' },
      { beforeProviderEffect },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;

    await socket.emit('open');

    await expect(synthesis).rejects.toThrow('origin revoked before send');
    expect(beforeProviderEffect).toHaveBeenCalledTimes(3);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('runs the OpenAI fence immediately before the provider fetch', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async () => {
      order.push('fetch');
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pcm = await openaiSynthesizePcm(
      { baseUrl: 'https://openai.example.test/v1/', apiKey: 'key', model: 'tts-model' },
      'hello',
      { speaker: 'alloy' },
      { beforeProviderEffect: () => { order.push('fence'); } },
    );

    expect(order).toEqual(['fence', 'fetch']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pcm).toMatchObject({ data: Buffer.from([4, 5, 6]), sampleRate: 24000, channels: 1 });
  });
});
