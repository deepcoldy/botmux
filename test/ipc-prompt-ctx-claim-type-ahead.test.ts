// A type-ahead message's UserPromptSubmit hook fires while the running turn is
// still the managed origin; the claim route must hand back that message's own
// sidecar from the real store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-pctx-type-ahead-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmpRoot;
});

const { setIpcAuthSecret, startIpcServer } = await import('../src/core/dashboard-ipc-server.js');
const { daemonIpcAuthHeaders } = await import('../src/core/daemon-ipc-auth.js');
const workerPool = await import('../src/core/worker-pool.js');
const { writePromptContext, fingerprintPromptText, prefixOf } = await import('../src/services/prompt-context-store.js');
const { dropTypeAheadPromptTurn } = await import('../src/core/type-ahead-prompt-queue.js');
const { claimPromptContextEnvelopeWithRetry, claimPromptContextEnvelopeWithLiveOrigin } = await import('../src/services/prompt-context-claim-client.js');

const HOST_SECRET = 'test-ipc-claim-type-ahead-secret';
let handle: Awaited<ReturnType<typeof startIpcServer>> | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function claim(sessionId: string, prompt: string, hookPrompt = prompt): Promise<Response> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  const path = `/api/sessions/${sessionId}/prompt-ctx/claim`;
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    }),
    body: JSON.stringify({ fingerprint: fingerprintPromptText(hookPrompt), prefix: prefixOf(hookPrompt) }),
  });
}

describe('prompt-ctx claim for a type-ahead message', () => {
  it('returns the queued turn\'s own envelope while the earlier turn is still running', async () => {
    const ds = {
      session: { sessionId: 's-type-ahead', status: 'active' },
      managedTurnOrigin: { capability: 'c'.repeat(64), turnId: 'om_running' },
      larkAppId: 'app-1',
      typeAheadPromptTurnIds: ['om_queued'],
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds as any);
    writePromptContext('s-type-ahead', 'om_queued', '插一句：顺便把评审也提了', '<sender name="董思琪" />');

    const res = await claim('s-type-ahead', '插一句：顺便把评审也提了');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope: '<sender name="董思琪" />' });
    expect(ds.typeAheadPromptTurnIds).toEqual([]);
    expect((await claim('s-type-ahead', '插一句：顺便把评审也提了')).status).toBe(404);
  });

  it('does not hand out a sidecar of a turn the worker never reported as type-ahead', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-unreported', status: 'active' },
      managedTurnOrigin: { capability: 'c'.repeat(64), turnId: 'om_running' },
      larkAppId: 'app-1',
    } as any);
    writePromptContext('s-unreported', 'om_other', '继续', '<sender name="someone" />');

    const res = await claim('s-unreported', '继续');

    expect(res.status).toBe(404);
  });

  it('fails open without consuming either sidecar when a missed turn and a later turn share a fingerprint', async () => {
    const ds = {
      session: { sessionId: 's-ambiguous', status: 'active' },
      managedTurnOrigin: { capability: 'c'.repeat(64), turnId: 'om_running' },
      larkAppId: 'app-1',
      typeAheadPromptTurnIds: ['om_missed', 'om_later'],
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds as any);
    writePromptContext('s-ambiguous', 'om_missed', '继续', 'OLD_ENVELOPE');
    writePromptContext('s-ambiguous', 'om_later', '继续', 'NEW_ENVELOPE');

    expect((await claim('s-ambiguous', '继续')).status).toBe(404);
    expect(ds.typeAheadPromptTurnIds).toEqual(['om_missed', 'om_later']);

    // The old turn's eventual drop removes only its own candidate. The later
    // hook can then claim its own envelope instead of inheriting the old one.
    dropTypeAheadPromptTurn(ds as any, 'om_missed');
    const res = await claim('s-ambiguous', '继续');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope: 'NEW_ENVELOPE' });
    expect(ds.typeAheadPromptTurnIds).toEqual([]);
  });

  it('also fails open on ambiguous prefix matches while a later exact match wins globally', async () => {
    const common = 'abcdefghijklmnopqrstuvwxyz一二三四五六七八九十';
    const oldPrompt = `${common}-old-tail`;
    const newPrompt = `${common}-new-tail`;
    const ds = {
      session: { sessionId: 's-prefix', status: 'active' },
      managedTurnOrigin: { capability: 'c'.repeat(64), turnId: 'om_running' },
      larkAppId: 'app-1',
      typeAheadPromptTurnIds: ['om_old', 'om_new'],
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds as any);
    writePromptContext('s-prefix', 'om_old', oldPrompt, 'OLD_ENVELOPE');
    writePromptContext('s-prefix', 'om_new', newPrompt, 'NEW_ENVELOPE');

    // Neither full fingerprint matches: two prefix candidates must not be popped.
    expect((await claim('s-prefix', newPrompt, `${common}-corrupted-tail`)).status).toBe(404);
    expect(ds.typeAheadPromptTurnIds).toEqual(['om_old', 'om_new']);

    // With an exact match for the new turn, the old turn's matching prefix must
    // not win merely because it appeared earlier in the queue.
    const res = await claim('s-prefix', newPrompt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope: 'NEW_ENVELOPE' });
    expect(ds.typeAheadPromptTurnIds).toEqual(['om_old']);
  });

  it('retries a 404 after the registration crosses the claim response boundary', async () => {
    const ds = {
      session: { sessionId: 's-delayed', status: 'active' },
      managedTurnOrigin: { capability: 'c'.repeat(64), turnId: 'om_running' },
      larkAppId: 'app-1',
      typeAheadPromptTurnIds: [] as string[],
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds as any);
    writePromptContext('s-delayed', 'om_delayed', '继续', 'DELAYED_ENVELOPE');
    let attempts = 0;
    const envelope = await claimPromptContextEnvelopeWithRetry(async () => {
      attempts++;
      const res = await claim('s-delayed', '继续');
      if (attempts === 1) {
        expect(res.status).toBe(404);
        // The 404 is already on the wire when the worker's queued IPC lands.
        ds.typeAheadPromptTurnIds = ['om_delayed'];
      }
      return res;
    }, { retryForMs: 200, retryIntervalMs: 1 });

    expect(envelope).toBe('DELAYED_ENVELOPE');
    expect(attempts).toBe(2);
    expect(ds.typeAheadPromptTurnIds).toEqual([]);
  });

  it('re-reads capability auth after a 404 so an advance cannot turn the retry into a stale 403', async () => {
    const capA = 'a'.repeat(64);
    const capB = 'b'.repeat(64);
    const ds = {
      session: { sessionId: 's-capability', status: 'active' },
      managedTurnOrigin: { capability: capA, turnId: 'om_A' },
      larkAppId: 'app-1',
      typeAheadPromptTurnIds: [] as string[],
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds as any);
    writePromptContext('s-capability', 'om_B', '继续', 'CAPABILITY_ENVELOPE');
    // Start the authenticated server without registering the queued candidate.
    expect((await claim('s-capability', '继续')).status).toBe(404);

    let origin = { capability: capA, turnId: 'om_A' };
    let attempts = 0;
    const envelope = await claimPromptContextEnvelopeWithLiveOrigin({
      fingerprint: fingerprintPromptText('继续'),
      prefix: prefixOf('继续'),
      readOrigin: () => origin,
      request: async body => {
        attempts++;
        const path = '/api/sessions/s-capability/prompt-ctx/claim';
        const res = await fetch(`http://127.0.0.1:${handle!.port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (attempts === 1) {
          expect(res.status).toBe(404);
          origin = { capability: capB, turnId: 'om_B' };
          ds.managedTurnOrigin = { capability: capB, turnId: 'om_B' };
          ds.typeAheadPromptTurnIds = ['om_B'];
        }
        return res;
      },
    }, { retryForMs: 200, retryIntervalMs: 1 });

    expect(envelope).toBe('CAPABILITY_ENVELOPE');
    expect(attempts).toBe(2);
    expect(ds.typeAheadPromptTurnIds).toEqual([]);
  });
});
