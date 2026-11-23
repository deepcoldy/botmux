/**
 * The daemon's public trigger entry marks a request as submitted from outside
 * (core/turn-origin) for scripts, webhooks, the platform and the Dashboard, and
 * not for the relays other daemons send to the same entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as triggerSession from '../src/core/trigger-session.js';

let handle: IpcServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; vi.restoreAllMocks(); });

describe('public trigger entry', () => {
  it('marks scripts, webhooks and the platform as external, never a report relay or a meeting delivery', async () => {
    setLarkAppId('cli_trigger_origin');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const previous = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map());
    const seen: Array<boolean | undefined> = [];
    vi.spyOn(triggerSession, 'triggerSessionTurn').mockImplementation(async (_req, deps) => {
      seen.push(deps.externalRequest);
      return { ok: true, triggerId: 'trg_x', action: 'queued' } as any;
    });
    try {
      for (const source of [
        { type: 'webhook', connectorId: 'ci' },
        { type: 'ui', requestId: 'r1' },
        { type: 'ui', connectorId: 'botmux-report' },
        { type: 'vc_meeting' },
      ]) {
        const response = await fetch(`http://127.0.0.1:${handle.port}/api/trigger`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source, target: { kind: 'turn', botId: 'cli_trigger_origin', sessionId: 'fixture-session' },
            instruction: 'run', envelope: { sourceName: 'Example', format: 'text', trusted: false },
          }),
        });
        expect(response.status).toBe(200);
      }
      expect(seen).toEqual([true, true, false, false]);
    } finally {
      workerPool.setActiveSessionsRegistry(previous ?? new Map());
    }
  });
});
