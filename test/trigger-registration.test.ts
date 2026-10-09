import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startIpcServer, setLarkAppId, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { config } from '../src/config.js';
import * as leases from '../src/services/idempotency-store.js';
import * as results from '../src/services/async-trigger-store.js';
import * as atomic from '../src/utils/atomic-write.js';

const OWNER = 'app_registration';
const SID = 'sid-original';
const TURN = 'trg-original';
const KEY = 'job-42';
const leaseKey = SID + '\0' + KEY;
let dataDir: string;
let previousDataDir: string;
let handle: IpcServerHandle;

function register(ownerLarkAppId = OWNER, attempting = true) {
  const { record } = leases.claim({
    ownerLarkAppId, sessionId: SID, triggerId: TURN, key: leaseKey,
    requestHash: 'sha256:original', ownerBootId: 'boot-original', now: 1000, kind: 'turn',
  });
  return attempting
    ? leases.transition(ownerLarkAppId, leaseKey, record, { state: 'attempting', now: 2000 }, 'turn')
    : record;
}
function commit(patch: Partial<Parameters<typeof leases.recordTurnInputCommit>[0]> = {}) {
  return leases.recordTurnInputCommit({
    ownerLarkAppId: OWNER, sessionId: SID, triggerId: TURN, key: leaseKey,
    ownerBootId: 'boot-original', workerGeneration: 7, observedAt: 3000, ...patch,
  });
}
function snapshot(dir = dataDir): Record<string, { hash: string; mtime: number }> {
  const files: Record<string, { hash: string; mtime: number }> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(path));
    else files[relative(dataDir, path)] = {
      hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mtime: statSync(path).mtimeMs,
    };
  }
  return files;
}
async function poll(key = KEY, sessionId = SID, suffix = '') {
  const before = snapshot();
  const response = await fetch('http://127.0.0.1:' + handle.port
    + '/api/sessions/' + encodeURIComponent(sessionId)
    + '/trigger-registration?turnIdempotencyKey=' + encodeURIComponent(key) + suffix);
  const body = await response.json();
  expect(snapshot()).toEqual(before);
  return { status: response.status, body };
}
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-registration-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  setLarkAppId(OWNER);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await handle.close();
  setIpcAuthSecret('');
  config.session.dataDir = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('durable exact-turn input observation', () => {
  it('persists only the first exact ACK without changing the attempting fence', () => {
    register();
    expect(commit()).toBe(true);
    expect(leases.lookup(OWNER, leaseKey, 'turn')).toMatchObject({
      state: 'attempting', revision: 3, inputCommit: { workerGeneration: 7, observedAt: 3000 },
    });
    const before = snapshot();
    expect(commit({ observedAt: 4000 })).toBe(true);
    expect(commit({ workerGeneration: 8 })).toBe(false);
    expect(snapshot()).toEqual(before);
  });
  it.each([
    { ownerBootId: 'stale-boot' }, { sessionId: 'another-session' },
    { triggerId: 'another-turn' }, { workerGeneration: 0 }, { workerGeneration: 1.5 },
  ])('ignores unmatched evidence %j', patch => {
    register();
    const before = snapshot();
    expect(commit(patch)).toBe(false);
    expect(snapshot()).toEqual(before);
  });
  it('cannot advance a reserved lease by observing a commit', () => {
    register(OWNER, false);
    expect(commit()).toBe(false);
    expect(leases.lookup(OWNER, leaseKey, 'turn')).toMatchObject({ state: 'reserved', revision: 1 });
  });
  it('preserves the old record when the durable evidence write fails', async () => {
    register();
    const before = snapshot();
    vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => commit()).toThrow('disk full');
    expect(snapshot()).toEqual(before);
    expect((await poll()).body.inputCommitted).toEqual({ state: 'unknown' });
  });
});

describe('GET trigger-registration', () => {
  it('keeps missing and foreign registration indistinguishable and ignores a claimed owner', async () => {
    const absent = await poll();
    register('app_foreign');
    results.recordCompleted(SID, TURN, 'foreign answer', 4000, 'app_foreign');
    expect(await poll(KEY, SID, '&ownerLarkAppId=app_foreign')).toEqual(absent);
    expect(absent).toEqual({ status: 200, body: { ok: true, schemaVersion: 1, larkAppId: OWNER, state: 'unknown', sessionId: SID } });
  });
  it('reads retained evidence after an IPC restart without a live session', async () => {
    register(); commit();
    results.recordCompleted(SID, TURN, 'answer', 4000, OWNER);
    await handle.close();
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    expect(await poll('  ' + KEY + '  ')).toMatchObject({
      status: 200,
      body: {
        state: 'registered',
        registration: { triggerId: TURN, requestHash: 'sha256:original', state: 'attempting', ownerBootId: 'boot-original' },
        inputCommitted: { state: 'observed', workerGeneration: 7, observedAt: 3000 },
        result: { state: 'completed', completedAt: 4000 },
        resultRef: '/api/sessions/' + SID + '/trigger-result?triggerId=' + TURN,
      },
    });
  });
  it('does not take over an old reserved lease or invent missing input evidence', async () => {
    register(OWNER, false);
    expect((await poll()).body).toMatchObject({
      registration: { state: 'reserved', revision: 1 },
      inputCommitted: { state: 'unknown' }, result: { state: 'unknown' },
    });
  });
  it('does not mirror a parked steer or claim pending is executing', async () => {
    register();
    results.recordPending(SID, TURN, 2000, OWNER);
    results.recordPending(SID, 'trg-successor', 2100, OWNER);
    results.recordSteerParked(SID, TURN, 'trg-successor', 2200, OWNER);
    results.recordCompleted(SID, 'trg-successor', 'merged answer', 4000, OWNER);
    expect((await poll()).body).toMatchObject({
      inputCommitted: { state: 'unknown' }, result: { state: 'pending', steerParkedBy: 'trg-successor' },
    });
  });
  it.each(['failed', 'interrupted'] as const)('reads an exact persisted %s outcome', async state => {
    register();
    results.recordPending(SID, TURN, 2000, OWNER);
    if (state === 'failed') results.recordTerminalFailureStrict(SID, TURN, 4000, OWNER, 'provider_error');
    else results.recordInterruptedStrict(SID, TURN, 4000, OWNER);
    expect((await poll()).body.result.state).toBe(state);
  });
  it('withholds results without matching owner proof', async () => {
    register();
    results.recordCompleted(SID, TURN, 'unproven result', 4000);
    expect((await poll()).body.result).toEqual({ state: 'unknown' });
  });
  it.each(['lease', 'result', 'inputCommit'])('reports corrupt %s data without changing files', async kind => {
    register();
    if (kind === 'result') {
      results.recordPending(SID, TURN, 2000, OWNER);
      writeFileSync(join(dataDir, 'async-triggers', SID + '.json'), '{broken');
    } else {
      const file = Object.keys(snapshot()).find(path => path.startsWith('idempotency/') && path.endsWith('.json'))!;
      if (kind === 'lease') writeFileSync(join(dataDir, file), '{broken');
      else {
        const row = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
        row.inputCommit = { workerGeneration: '7', observedAt: 3000 };
        writeFileSync(join(dataDir, file), JSON.stringify(row));
      }
    }
    expect(await poll()).toEqual({ status: 503, body: { ok: false, errorCode: 'observation_unavailable' } });
  });
  it.each(['', '   ', 'x'.repeat(201)])('rejects invalid key %j', async key => {
    expect((await poll(key)).status).toBe(400);
  });
  it('rejects ambiguous keys and unsafe session paths', async () => {
    expect((await poll(KEY, SID, '&turnIdempotencyKey=second')).status).toBe(400);
    expect((await poll(KEY, '../foreign')).status).toBe(400);
  });
  it('does not widen the core-only unauthenticated route allowlist', async () => {
    await handle.close();
    setIpcAuthSecret('test-registration-secret');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    expect((await poll()).status).toBe(401);
  });
  it('waits for restoration before reading state', async () => {
    await handle.close();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', ready });
    let settled = false;
    const request = poll().then(result => { settled = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(settled).toBe(false);
    } finally { release(); }
    expect((await request).status).toBe(200);
  });
});
