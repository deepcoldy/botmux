// test/trigger-result-steer-park.test.ts
//
// Route-level coverage for the HTTP steer-group restart insurance
// (POST /api/trigger options.steer; codex-app native turn/steer).
//
// The store primitives (recordSteerParked / followSteerParkedChain) are pinned
// in async-trigger-store.test.ts; these cases pin the CALLER glue inside
// buildAsyncTriggerLookupResponse: when the daemon restarted in the
// superseded → real-final window, polling a PARKED member must walk the durable
// `steerParkedBy` chain to its first terminal successor and mirror that outcome
// (completed carries the merged answer WITHOUT usage; turn_terminal mirrors the
// provider code; anything else becomes dispatch_unknown), while a chain that
// still ends pending — including a corrupt on-disk cycle — keeps reporting
// `running`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { config } from '../src/config.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';

const OWNER = 'app_steer_park_route';
let handle: IpcServerHandle | null = null;
let dataDir: string;
let prevDataDir: string | undefined;
let prevConfigDataDir: string;

function poll(sessionId: string, triggerId: string): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${handle!.port}/api/sessions/${sessionId}/trigger-result?triggerId=${encodeURIComponent(triggerId)}`,
  );
}

describe('GET trigger-result — steer park-chain mirror after a daemon restart', () => {
  beforeEach(async () => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    prevConfigDataDir = config.session.dataDir;
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-steer-park-route-'));
    process.env.SESSION_DATA_DIR = dataDir;
    config.session.dataDir = dataDir;
    setLarkAppId(OWNER);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle) { await handle.close(); handle = null; }
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
    config.session.dataDir = prevConfigDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('mirrors a completed successor: parked member resolves with the merged answer and NO usage', async () => {
    const sid = 'sid-steer-park-completed';
    asyncTriggerStore.recordPending(sid, 'trg_root', 1000, OWNER);
    asyncTriggerStore.recordPending(sid, 'trg_head', 2000, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'trg_root', 'trg_head', 1500, OWNER);
    // The real merged final lands on the successor, carrying the group's usage.
    asyncTriggerStore.recordCompleted(sid, 'trg_head', 'merged answer', 4000, OWNER, {
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheCreateTokens: 1,
    });

    const res = await poll(sid, 'trg_root');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      state: 'completed',
      triggerId: 'trg_root',
      output: { content: 'merged answer' },
    });
    // Usage belongs to the real (last) trigger only — never fanned to a parked
    // earlier member.
    expect(body.usage).toBeUndefined();

    // The mirror was DURABLY materialized onto the parked id, not just rendered
    // for this one response.
    const persisted = asyncTriggerStore.lookup(sid, 'trg_root');
    expect(persisted?.result.status).toBe('completed');
    expect(persisted?.result.content).toBe('merged answer');
    expect(persisted?.result.usage).toBeUndefined();
    expect(persisted?.result.steerParkedBy).toBeUndefined();
  });

  it('returns a durable exact-turn interrupt after a daemon restart while its session remains open', async () => {
    const sid = 'sid-interrupted-restart';
    asyncTriggerStore.recordPending(sid, 'trg_stop', 1000, OWNER);
    asyncTriggerStore.recordInterruptedStrict(sid, 'trg_stop', 7000, OWNER);

    const res = await poll(sid, 'trg_stop');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      state: 'interrupted',
      triggerId: 'trg_stop',
      finishedAt: new Date(7000).toISOString(),
    });
  });

  it('mirrors a turn_terminal successor: parked member fails with the provider terminal code', async () => {
    const sid = 'sid-steer-park-terminal';
    asyncTriggerStore.recordPending(sid, 'trg_root', 1000, OWNER);
    asyncTriggerStore.recordPending(sid, 'trg_head', 2000, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'trg_root', 'trg_head', 1500, OWNER);
    asyncTriggerStore.recordTerminalFailureStrict(sid, 'trg_head', 3000, OWNER, 'provider_500');

    const res = await poll(sid, 'trg_root');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      state: 'failed',
      triggerId: 'trg_root',
      errorCode: 'trigger_failed',
    });
    expect(body.error).toContain('provider_500');

    const persisted = asyncTriggerStore.lookup(sid, 'trg_root');
    expect(persisted?.result.status).toBe('failed');
    expect(persisted?.result.reason).toBe('turn_terminal');
    expect(persisted?.result.terminalErrorCode).toBe('provider_500');
  });

  it('mirrors a dispatch_unknown successor (durable failed without terminal code)', async () => {
    const sid = 'sid-steer-park-unknown';
    asyncTriggerStore.recordPending(sid, 'trg_root', 1000, OWNER);
    asyncTriggerStore.recordPending(sid, 'trg_head', 2000, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'trg_root', 'trg_head', 1500, OWNER);
    asyncTriggerStore.recordFailedStrict(sid, 'trg_head', 3000, OWNER, 'dispatch_unknown');

    const res = await poll(sid, 'trg_root');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      state: 'failed',
      triggerId: 'trg_root',
      errorCode: 'no_output',
    });
  });

  it('keeps reporting running while the parked chain still ends pending (real final not on disk yet)', async () => {
    const sid = 'sid-steer-park-pending';
    asyncTriggerStore.recordPending(sid, 'trg_root', 1000, OWNER);
    asyncTriggerStore.recordPending(sid, 'trg_head', 2000, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'trg_root', 'trg_head', 1500, OWNER);

    const res = await poll(sid, 'trg_root');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      state: 'running',
      triggerId: 'trg_root',
    });
  });

  it('fails closed to running on a corrupt on-disk cycle (never 500s or loops)', async () => {
    const sid = 'sid-steer-park-cycle';
    asyncTriggerStore.recordPending(sid, 'a', 1000, OWNER);
    asyncTriggerStore.recordPending(sid, 'b', 1000, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'a', 'b', 1100, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'b', 'a', 1200, OWNER);

    const res = await poll(sid, 'a');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: 'running', triggerId: 'a' });
  });

  it('keeps reporting running (no 500) when the mirror write itself throws, and retries next poll', async () => {
    const sid = 'sid-steer-park-writefault';
    asyncTriggerStore.recordPending(sid, 'trg_root', 1000, OWNER);
    asyncTriggerStore.recordPending(sid, 'trg_head', 2000, OWNER);
    asyncTriggerStore.recordSteerParked(sid, 'trg_root', 'trg_head', 1500, OWNER);
    asyncTriggerStore.recordTerminalFailureStrict(sid, 'trg_head', 3000, OWNER, 'provider_500');

    // First poll: the strict mirror write fails transiently (EIO class). The
    // poll must stay 200/running (the parked record is untouched), not 500.
    const strictWrite = vi
      .spyOn(asyncTriggerStore, 'recordTerminalFailureStrict')
      .mockImplementationOnce(() => { throw new Error('EIO: simulated write fault'); });

    const res1 = await poll(sid, 'trg_root');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ ok: true, state: 'running' });
    expect(strictWrite).toHaveBeenCalledTimes(1);

    // Disk unchanged after the failed mirror.
    const parkedAfterFault = asyncTriggerStore.lookup(sid, 'trg_root');
    expect(parkedAfterFault?.result.status).toBe('pending');
    expect(parkedAfterFault?.result.steerParkedBy).toBe('trg_head');

    // Once storage recovers, the next poll mirrors normally.
    const res2 = await poll(sid, 'trg_root');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({
      ok: true, state: 'failed', errorCode: 'trigger_failed',
    });
  });
});
