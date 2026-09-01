import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The fake socket class is created INSIDE the `ws` factory, and the tests reach it
 * by importing the mocked module itself (below) — no shared outer binding.
 *
 * Two shapes were tried first and both failed, in opposite runners:
 *   · `vi.hoisted(() => { class … })` — a vitest-only TRANSFORM, no `bun test`
 *     equivalent; the file died under bun.
 *   · a top-level `class`/`const` holder read from the factory body — vitest calls
 *     the factory during the hoisted import phase, before those statements run.
 *     Measured, twice: "Cannot access 'FakeWebSocket' before initialization", then
 *     "Cannot access 'wsMock' before initialization".
 * Anything the factory dereferences in its own body must therefore be created in
 * that body. Importing the mock back is what both runners agree on.
 */
vi.mock('ws', () => {
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

  return { default: FakeWebSocket };
});

// The mocked class, pulled back in through the same specifier the code under test
// uses. `vi.mocked` is not involved: this IS the fake, not a spy on the real one.
import FakeWebSocketDefault from 'ws';

interface FakeSocket {
  readonly url: string;
  readonly send: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: any[]): Promise<void>;
}

/** The live instance list, asserted on by the tests below. */
function instances(): FakeSocket[] {
  return (FakeWebSocketDefault as unknown as { instances: FakeSocket[] }).instances;
}

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
    instances().length = 0;
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
    expect(instances()).toHaveLength(0);
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
    await vi.waitFor(() => expect(instances()).toHaveLength(1));
    const socket = instances()[0]!;

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
    await vi.waitFor(() => expect(instances()).toHaveLength(1));
    const socket = instances()[0]!;

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

/**
 * A self-hosted TTS endpoint must not have its API key handed to an HTTP proxy.
 *
 * `openaiSynthesizePcm` sends `Authorization: Bearer <apiKey>` to `cfg.baseUrl`, and
 * a LOCAL endpoint is the documented case (the config hint suggests
 * `http://127.0.0.1:8880/v1`). Under Bun the global `fetch` routes 127.0.0.1 through
 * `$http_proxy` unless `no_proxy` names that literal address — CIDR does not count —
 * so the request, key included, went to the corporate proxy. Reproduced with a
 * canary token: `PROXY_HIT POST …/v1/audio/speech auth=Bearer SECRET_CANARY`.
 *
 * This has to run in a REAL Bun process: Bun snapshots proxy config at startup, and
 * vitest's own worker is Node (whose fetch ignores proxy env entirely), so an
 * in-process assertion cannot see the defect at all.
 */
describe('openaiSynthesizePcm — a local endpoint bypasses the proxy', () => {
  function resolveBun(): string | undefined {
    if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH;
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const candidate = join(dir, 'bun');
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  it('does not send the Bearer token to $http_proxy', async () => {
    const bun = resolveBun();
    if (!bun) {
      // Never silently pass in CI — a skipped security regression is worse than none.
      if (process.env.CI) throw new Error('bun not found on PATH; this test must not be skipped in CI');
      return;
    }

    const { createServer } = await import('node:http');
    const servers: import('node:http').Server[] = [];
    const listen = async (h: import('node:http').RequestListener) => {
      const s = createServer(h); servers.push(s);
      await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
      return (s.address() as { port: number }).port;
    };
    try {
      let proxyHits = 0;
      let leakedAuth = '';
      let localHits = 0;
      const proxyPort = await listen((req, res) => {
        proxyHits++;
        leakedAuth = String(req.headers.authorization ?? '');
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html><title>403 Forbidden</title></html>');
      });
      const ttsPort = await listen((_req, res) => {
        localHits++;
        res.writeHead(200, { 'content-type': 'audio/pcm' });
        res.end(Buffer.alloc(16));
      });

      const modulePath = join(__dirname, '..', 'src', 'services', 'voice', 'openai.ts');
      const snippet = `
        const { openaiSynthesizePcm } = await import(${JSON.stringify(modulePath)});
        try {
          await openaiSynthesizePcm(
            { baseUrl: 'http://127.0.0.1:${ttsPort}/v1', model: 'm', apiKey: 'SECRET_CANARY' },
            'hi', { speaker: 'a' },
          );
          process.stdout.write(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? 'bun' : 'node', ok: true }));
        } catch (e) {
          process.stdout.write(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? 'bun' : 'node', err: String(e && e.message) }));
        }
      `;
      const { spawn } = await import('node:child_process');
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const stdout = await new Promise<string>((resolve, reject) => {
        // Async spawn: spawnSync would block this event loop and the servers above
        // could never accept the child's connection.
        const child = spawn(bun, ['-e', snippet], {
          env: {
            ...process.env,
            http_proxy: proxyUrl, HTTP_PROXY: proxyUrl,
            https_proxy: proxyUrl, HTTPS_PROXY: proxyUrl,
            // The CIDR form real shell rc files use — the one Bun does not honour.
            no_proxy: '127.0.0.0/8', NO_PROXY: '127.0.0.0/8',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', d => { out += String(d); });
        child.stderr.on('data', d => { err += String(d); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bun child timed out')); }, 25_000);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`bun child exited ${code}: ${err.slice(0, 400)}`));
          else resolve(out);
        });
      });

      const parsed = JSON.parse(stdout || '{}');
      // Prove the child really was Bun, or the assertions below mean nothing.
      expect(parsed.runtime).toBe('bun');
      expect(leakedAuth).toBe('');
      expect(proxyHits).toBe(0);
      expect(localHits).toBe(1);
      expect(parsed.ok).toBe(true);
    } finally {
      await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
    }
  }, 40_000);
});
