import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import {
  setLinkRefRuntime,
  type LinkRefRuntime,
} from '../src/services/link-ref-runtime.js';

const CAPABILITY = 'c0ffee12'.repeat(8);
const HOST_SECRET = 'test-link-ref-session-cli-ipc-secret';
const SESSION_ID = 'session-link-ref';
const ROUTE = `/api/sessions/${SESSION_ID}/link-refs/register`;
const fullUrl = 'https://example.test/authorize'
  + '?code=one&token=two&signature=three&state=four&redirect_uri=https%3A%2F%2Fclient.test%2Fdone';

let handle: IpcServerHandle | null = null;

const EMPTY_STATS = {
  scannedBytes: 0,
  found: 0,
  candidateCount: 0,
  filteredCredential: 0,
  filteredMetadata: 0,
  filteredInvalid: 0,
};

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setLinkRefRuntime(undefined);
  vi.restoreAllMocks();
});

async function ensureServer(): Promise<IpcServerHandle> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  return handle;
}

function installSession(input: {
  sessionId?: string;
  status?: 'active' | 'closed';
  capability?: string;
  turnId?: string;
  dispatchAttempt?: number;
  linkRefMode?: 'observe' | 'enabled';
} = {}): void {
  const sessionId = input.sessionId ?? SESSION_ID;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((requested: string) => (
    requested === sessionId
      ? {
          session: { sessionId, status: input.status ?? 'active' },
          larkAppId: 'app-live',
          managedTurnOrigin: {
            capability: input.capability ?? CAPABILITY,
            turnId: input.turnId ?? 'turn-live',
            dispatchAttempt: input.dispatchAttempt ?? 7,
            ...(input.linkRefMode ? { linkRefMode: input.linkRefMode } : {}),
          },
        } as any
      : undefined
  ));
}

function installRuntime(registerSources = vi.fn(() => ({
  companion: '<botmux_link_refs>\nlr_ref = exact\n</botmux_link_refs>',
  stats: { ...EMPTY_STATS, scannedBytes: 10, found: 1, candidateCount: 1 },
}))): ReturnType<typeof vi.fn> {
  setLinkRefRuntime({ registerSources } as unknown as LinkRefRuntime);
  return registerSources;
}

async function post(input: {
  sessionId?: string;
  auth?: 'capability' | 'signed' | 'none';
  capability?: string;
  body?: Record<string, unknown>;
  rawBody?: string;
} = {}): Promise<Response> {
  const server = await ensureServer();
  const sessionId = input.sessionId ?? SESSION_ID;
  const path = `/api/sessions/${sessionId}/link-refs/register`;
  const requestBody = {
    sourceType: 'history',
    sourceId: 'history-result',
    value: { text: fullUrl },
    ...(input.body ?? {}),
  };
  if ((input.auth ?? 'capability') === 'capability') {
    Object.assign(requestBody, { originCapability: input.capability ?? CAPABILITY });
  }
  const headers: HeadersInit = input.auth === 'signed'
    ? daemonIpcAuthHeaders({
        secret: HOST_SECRET,
        port: server.port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
      })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers,
    body: input.rawBody ?? JSON.stringify(requestBody),
  });
}

describe('POST /api/sessions/:sessionId/link-refs/register', () => {
  it.each(['capability', 'signed'] as const)(
    'accepts %s authentication and derives the exact live key and mode',
    async (auth) => {
      installSession({ linkRefMode: 'enabled' });
      const registerSources = installRuntime();

      const response = await post({ auth });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        companion: '<botmux_link_refs>\nlr_ref = exact\n</botmux_link_refs>',
        stats: { ...EMPTY_STATS, scannedBytes: 10, found: 1, candidateCount: 1 },
      });
      expect(registerSources).toHaveBeenCalledWith({
        key: {
          appId: 'app-live',
          sessionId: SESSION_ID,
          turnId: 'turn-live',
          dispatchAttempt: 7,
        },
        mode: 'enabled',
        sources: [{
          sourceType: 'history',
          sourceId: 'history-result',
          kind: 'structured',
          value: { text: fullUrl },
        }],
      });
    },
  );

  it('rejects stale and cross-session rotating capabilities', async () => {
    installSession({ linkRefMode: 'enabled' });
    const registerSources = installRuntime();

    const stale = await post({ capability: 'deadbeef'.repeat(8) });
    const crossSession = await post({ sessionId: 'session-other' });

    expect(stale.status).toBe(403);
    expect(crossSession.status).toBe(403);
    expect(registerSources).not.toHaveBeenCalled();
  });

  it('rejects a closed session and a live origin without a turn', async () => {
    installSession({ status: 'closed', linkRefMode: 'enabled' });
    const registerSources = installRuntime();
    expect((await post()).status).toBe(404);

    vi.restoreAllMocks();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: SESSION_ID, status: 'active' },
      larkAppId: 'app-live',
      managedTurnOrigin: { capability: CAPABILITY, linkRefMode: 'enabled' },
    } as any);
    expect((await post()).status).toBe(409);
    expect(registerSources).not.toHaveBeenCalled();
  });

  it('disabled returns without touching the LinkRef runtime', async () => {
    installSession();
    const registerSources = installRuntime();

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stats: EMPTY_STATS });
    expect(registerSources).not.toHaveBeenCalled();
  });

  it('does not let the request body select identity, attempt, mode, or mappings', async () => {
    installSession({ linkRefMode: 'enabled' });
    const registerSources = installRuntime();

    const response = await post({ body: {
      appId: 'app-forged',
      sessionId: 'session-forged',
      turnId: 'turn-forged',
      dispatchAttempt: 99,
      mode: 'disabled',
      mapping: { lr_fake: fullUrl },
    } });

    expect(response.status).toBe(400);
    expect(registerSources).not.toHaveBeenCalled();
  });

  it('returns the original command path as usable when registration fails', async () => {
    installSession({ linkRefMode: 'enabled' });
    const registerSources = installRuntime(vi.fn(() => {
      throw Object.assign(new Error('database text must not escape'), { code: 'SQLITE_BUSY' });
    }));

    const response = await post();

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ ok: true, stats: EMPTY_STATS });
    expect(JSON.stringify(result)).not.toContain('database');
    expect(registerSources).toHaveBeenCalledOnce();
  });

  it('returns no companion when an enabled turn is already settled', async () => {
    installSession({ linkRefMode: 'enabled' });
    const registerSources = installRuntime(vi.fn(() => ({ stats: EMPTY_STATS })));

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stats: EMPTY_STATS });
    expect(registerSources).toHaveBeenCalledOnce();
  });

  it('rejects request bodies larger than 1 MiB before registration', async () => {
    installSession({ linkRefMode: 'enabled' });
    const registerSources = installRuntime();
    const rawBody = JSON.stringify({
      sourceType: 'history',
      value: 'x'.repeat(1024 * 1024),
      originCapability: CAPABILITY,
    });

    const response = await post({ rawBody });

    expect(response.status).toBe(413);
    expect(registerSources).not.toHaveBeenCalled();
  });
});

// Regression: link-refs/resolve must share the narrow untrushed-auth aperture
// with link-refs/register. In an isolated (bwrap / macOS Seatbelt) session the
// CLI has no host HMAC secret; if resolve is absent from routeHasNarrowUntrustedAuth
// the outer gate returns 401 before the handler's own capability check, so every
// enabled isolated `botmux send` carrying a ref exits 2 (link_ref_ledger_unavailable).
describe('narrow untrusted-auth aperture covers both link-ref routes', () => {
  async function capabilityOnly(route: 'link-refs/register' | 'link-refs/resolve'): Promise<Response> {
    const server = await ensureServer();
    installSession({ linkRefMode: 'enabled' });
    installRuntime();
    const path = `/api/sessions/${SESSION_ID}/${route}`;
    // Deliberately NO host HMAC headers: isolated CLI presents only the
    // rotating per-turn capability inside the body.
    const body = route === 'link-refs/register'
      ? {
          sourceType: 'history',
          sourceId: 'history-result',
          value: { text: fullUrl },
          originCapability: CAPABILITY,
        }
      : { originCapability: CAPABILITY, payload: { text: 'x' } };
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it.each(['link-refs/register', 'link-refs/resolve'] as const)(
    'routes %s past the outer 401 gate with a capability-only request',
    async (route) => {
      const response = await capabilityOnly(route);
      // Must not be the outer "unauthorized" dead-end. register resolves 200;
      // resolve reaches its handler too (4xx other than 401, or 200).
      expect(response.status).not.toBe(401);
    },
  );
});

import { routeHasNarrowUntrustedAuth } from '../src/core/dashboard-ipc-server.js';

// Set-level invariant: every narrow session sub-route (master's full list plus
// the link-ref routes this PR adds) must pass the untrusted-auth aperture.
// A merge that silently replaces one alternative (the R6 deferred-topic and
// the link-refs/resolve misses) breaks this list.
describe('routeHasNarrowUntrustedAuth session-route set invariant', () => {
  const sessionRoutes = [
    'slash', 'cd', 'close', 'preview', 'chat-rename', 'chat-manager', 'rename',
    'project', 'decision-board', 'project-dispatch-policy', 'continuation', 'durable-send',
    'turn-delivery', 'deferred-topic', 'link-refs/register', 'link-refs/resolve',
    'auth-request', 'auth-status',
  ] as const;

  it.each([...sessionRoutes])('covers POST /api/sessions/:id/%s', (route) => {
    expect(routeHasNarrowUntrustedAuth('POST', `/api/sessions/${SESSION_ID}/${route}`)).toBe(true);
  });

  it('does not widen the aperture to GET or other paths', () => {
    expect(routeHasNarrowUntrustedAuth('GET', `/api/sessions/${SESSION_ID}/link-refs/resolve`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `/api/sessions/${SESSION_ID}/something-else`)).toBe(false);
  });
});
