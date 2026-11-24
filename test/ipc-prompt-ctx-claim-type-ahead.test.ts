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

async function claim(sessionId: string, prompt: string): Promise<Response> {
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
    body: JSON.stringify({ fingerprint: fingerprintPromptText(prompt), prefix: prefixOf(prompt) }),
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
});
