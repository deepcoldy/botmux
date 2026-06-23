import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonClient,
  type DaemonClientOptions,
} from '../src/dashboard/daemon-internal-client.js';

function makeRes(status: number, body: unknown = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function captureFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fn = async (input: any, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

function makeOpts(over: Partial<DaemonClientOptions> = {}): DaemonClientOptions {
  let nonceCounter = 0;
  return {
    secret: 'test-secret',
    appId: 'cli_test',
    dashboardUrl: 'http://127.0.0.1:7891',
    now: () => 1_700_000_000_000,
    randomNonce: () => `nonce-${++nonceCounter}`,
    retries: 2,
    skipBackoffSleep: true,
    ...over,
  };
}

function header(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h?.[name];
}

describe('happy paths', () => {
  it('GET happy → 1 fetch call, returns parsed JSON body', async () => {
    const cap = captureFetch([makeRes(200, { sessions: [{ sessionId: 's1' }] })]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(cap.calls).toHaveLength(1);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sessions: [{ sessionId: 's1' }] });
  });

  it('POST happy with object body sends JSON.stringify + content-type', async () => {
    const cap = captureFetch([makeRes(200, { ok: true })]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch }));
    await client.request({ method: 'POST', path: '/__daemon/sessions/sid/close', body: { reason: 'test' } });
    const call = cap.calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe(JSON.stringify({ reason: 'test' }));
    expect(header(call.init, 'content-type')).toBe('application/json');
  });

  it('undefined body sends no body', async () => {
    const cap = captureFetch([makeRes(200, {})]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch }));
    await client.request({ method: 'POST', path: '/__daemon/sessions/sid/close' });
    expect(cap.calls[0]!.init.body).toBeUndefined();
  });

  it('returns raw text + status when response is not JSON', async () => {
    const cap = captureFetch([makeRes(200, 'plain text')]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.raw).toBe('plain text');
    expect(r.body).toBe('plain text');
  });
});

describe('secret loading', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('throws clearly when the default-loaded secret file is whitespace-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-client-secret-'));
    dirs.push(dir);
    const secretPath = join(dir, '.dashboard-secret');
    writeFileSync(secretPath, '  \n');

    expect(() => createDaemonClient({
      appId: 'cli_test',
      dashboardUrl: 'http://127.0.0.1:7891',
      secretPath,
      fetch: vi.fn() as unknown as typeof fetch,
    })).toThrow('dashboard_secret_missing');
  });

  it('throws clearly when an explicit secret override is whitespace-only', () => {
    expect(() => createDaemonClient({
      appId: 'cli_test',
      dashboardUrl: 'http://127.0.0.1:7891',
      secret: '  \n',
      fetch: vi.fn() as unknown as typeof fetch,
    })).toThrow('dashboard_secret_missing');
  });
});

describe('retry policy — GET', () => {
  it('GET 5xx → retries up to N times, each with a fresh nonce', async () => {
    const cap = captureFetch([
      makeRes(503),
      makeRes(503),
      makeRes(200, { sessions: [] }),
    ]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 2 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(200);
    expect(cap.calls).toHaveLength(3);

    // Each attempt must mint a fresh nonce.
    const nonces = cap.calls.map(c => header(c.init, 'x-botmux-daemon-nonce'));
    expect(new Set(nonces).size).toBe(3);
  });

  it('GET 5xx exhausted retries → returns last failed response', async () => {
    const cap = captureFetch([makeRes(503), makeRes(503), makeRes(503)]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 2 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(503);
    expect(cap.calls).toHaveLength(3); // 1 initial + 2 retries
  });

  it('GET 5xx where each retry signs a fresh (ts, sig)', async () => {
    let n = 0;
    const cap = captureFetch([makeRes(503), makeRes(200, {})]);
    const client = createDaemonClient(makeOpts({
      fetch: cap.fetch,
      now: () => 1_700_000_000_000 + n++ * 1000, // monotonic, advances each call
      randomNonce: () => `nonce-${n}`,
      retries: 2,
    }));
    await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    const tss = cap.calls.map(c => header(c.init, 'x-botmux-daemon-ts'));
    const sigs = cap.calls.map(c => header(c.init, 'x-botmux-daemon-sig'));
    expect(new Set(tss).size).toBe(2);
    expect(new Set(sigs).size).toBe(2);
  });

  it('GET 401 → never retry', async () => {
    const cap = captureFetch([makeRes(401, { ok: false, error: 'sig_mismatch' })]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(401);
    expect(cap.calls).toHaveLength(1);
  });

  it('GET 400 / 403 / 404 → never retry', async () => {
    for (const status of [400, 403, 404]) {
      const cap = captureFetch([makeRes(status)]);
      const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
      const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
      expect(r.status).toBe(status);
      expect(cap.calls).toHaveLength(1);
    }
  });

  it('GET 408 / 429 → retry (timeouts and rate-limits are transient)', async () => {
    const cap = captureFetch([makeRes(429), makeRes(200, {})]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 2 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(200);
    expect(cap.calls).toHaveLength(2);
  });

  it('GET network error → retries', async () => {
    const cap = captureFetch([new Error('econnrefused'), makeRes(200, {})]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 2 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(200);
    expect(cap.calls).toHaveLength(2);
  });

  it('GET network error exhausted → throws the last error', async () => {
    const err = new Error('econnrefused');
    const cap = captureFetch([err, err, err]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 2 }));
    await expect(
      client.request({ method: 'GET', path: '/__daemon/sessions-list' }),
    ).rejects.toThrow('econnrefused');
  });
});

describe('retry policy — non-GET (unsafe writes)', () => {
  it('POST 5xx → no retry by default (avoids double-effect)', async () => {
    const cap = captureFetch([makeRes(503, { ok: false })]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
    const r = await client.request({ method: 'POST', path: '/__daemon/sessions/sid/close', body: {} });
    expect(r.status).toBe(503);
    expect(cap.calls).toHaveLength(1);
  });

  it('POST 5xx with retryUnsafeWrites:true → retries', async () => {
    const cap = captureFetch([makeRes(503), makeRes(503), makeRes(200, { ok: true })]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 2 }));
    const r = await client.request({
      method: 'POST', path: '/__daemon/sessions/sid/close', body: {},
      retryUnsafeWrites: true,
    });
    expect(r.status).toBe(200);
    expect(cap.calls).toHaveLength(3);
  });

  it('POST 401 with retryUnsafeWrites:true → still no retry (401 carved out)', async () => {
    const cap = captureFetch([makeRes(401)]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
    const r = await client.request({
      method: 'POST', path: '/__daemon/sessions/sid/close', body: {},
      retryUnsafeWrites: true,
    });
    expect(r.status).toBe(401);
    expect(cap.calls).toHaveLength(1);
  });

  it('POST network error → no retry by default', async () => {
    const err = new Error('econnrefused');
    const cap = captureFetch([err]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
    await expect(
      client.request({ method: 'POST', path: '/__daemon/sessions/sid/close', body: {} }),
    ).rejects.toThrow('econnrefused');
    expect(cap.calls).toHaveLength(1);
  });

  it('PUT / DELETE follow non-GET policy (no retry by default)', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const cap = captureFetch([makeRes(503)]);
      const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
      await client.request({ method, path: '/__daemon/settings-write' });
      expect(cap.calls).toHaveLength(1);
    }
  });
});

describe('retries: 0 disables retry exactly (regression)', () => {
  it('GET 503 + retries:0 → exactly 1 fetch call', async () => {
    const cap = captureFetch([makeRes(503), makeRes(503)]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 0 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(503);
    expect(cap.calls).toHaveLength(1);
  });

  it('POST 503 + retryUnsafeWrites:true + retries:0 → exactly 1 fetch call', async () => {
    const cap = captureFetch([makeRes(503), makeRes(503)]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 0 }));
    const r = await client.request({
      method: 'POST',
      path: '/__daemon/sessions/sid/close',
      body: {},
      retryUnsafeWrites: true,
    });
    expect(r.status).toBe(503);
    expect(cap.calls).toHaveLength(1);
  });

  it('per-request retries:0 overrides client default', async () => {
    const cap = captureFetch([makeRes(503), makeRes(503), makeRes(200, {})]);
    // Client default retries=5, but per-request retries=0 → exactly 1 call.
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: 5 }));
    const r = await client.request({
      method: 'GET', path: '/__daemon/sessions-list',
      retries: 0,
    });
    expect(r.status).toBe(503);
    expect(cap.calls).toHaveLength(1);
  });

  it('negative retries clamps to 0', async () => {
    const cap = captureFetch([makeRes(503), makeRes(503)]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, retries: -3 }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(503);
    expect(cap.calls).toHaveLength(1);
  });
});

describe('signature integrity — pathWithQuery byte-preservation', () => {
  it('fetch URL path+query matches the bytes we signed', async () => {
    const cap = captureFetch([makeRes(200, { ok: true })]);
    const client = createDaemonClient(makeOpts({
      fetch: cap.fetch,
      dashboardUrl: 'http://127.0.0.1:9999',
    }));
    const path = '/__daemon/workflows-runs-snapshot?z=1&a=2&b=3';
    await client.request({ method: 'GET', path });
    expect(cap.calls[0]!.url).toBe('http://127.0.0.1:9999' + path);
  });
});

describe('timeout / abort', () => {
  it('aborts after timeoutMs and retries for GET', async () => {
    // First call: long-running fetch we abort. Second call: success.
    let aborted = false;
    const fetchFn: any = async (_url: string, init: RequestInit) => {
      // First attempt: never resolves until aborted.
      if (!aborted) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            const e = new Error('aborted');
            (e as any).name = 'AbortError';
            reject(e);
          });
        });
      }
      // Subsequent attempts: succeed immediately.
      return makeRes(200, { ok: true });
    };
    const client = createDaemonClient(makeOpts({
      fetch: fetchFn,
      timeoutMs: 5,
      retries: 1,
    }));
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(200);
    expect(aborted).toBe(true);
  });

  it('non-GET timeout → no retry (throws)', async () => {
    let aborted = false;
    const fetchFn: any = async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('aborted');
          (e as any).name = 'AbortError';
          reject(e);
        });
      });
    };
    const client = createDaemonClient(makeOpts({
      fetch: fetchFn,
      timeoutMs: 5,
      retries: 1,
    }));
    await expect(
      client.request({ method: 'POST', path: '/__daemon/sessions/sid/close', body: {} }),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

describe('header set integrity', () => {
  it('sets the full HMAC header quartet on every request', async () => {
    const cap = captureFetch([makeRes(200, {})]);
    const client = createDaemonClient(makeOpts({ fetch: cap.fetch, appId: 'cli_codex' }));
    await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    const init = cap.calls[0]!.init;
    expect(header(init, 'x-botmux-daemon-ts')).toBeDefined();
    expect(header(init, 'x-botmux-daemon-nonce')).toBeDefined();
    expect(header(init, 'x-botmux-daemon-sig')).toBeDefined();
    expect(header(init, 'x-botmux-daemon-appid')).toBe('cli_codex');
  });
});
