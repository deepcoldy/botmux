import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ScheduleAuthorityStore, scheduleAuthorityDbPath } from '../src/services/schedule-authority-store.js';
import { backgroundAuthorityKey, backgroundCredentialPolicyKey, backgroundPeerBelongsToJob, type BackgroundExecutionRegistration } from '../src/core/background-execution-policy.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../src/utils/process-identity.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { parseBackgroundExecutionArgs } from '../src/cli/background-execution.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import type { ScheduledTask } from '../src/types.js';

const roots: string[] = [];
const stores: ScheduleAuthorityStore[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const end = once(child, 'exit'); child.kill('SIGKILL'); await end;
  }
  stores.splice(0).forEach(s => s.close());
  roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
});
function task(): ScheduledTask {
  return { id: 'abcd1234', name: 'background', schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: 'work', workingDir: '/repo', chatId: 'oc_probe', larkAppId: 'cli_probe',
    ownerOpenId: 'ou_probe', ownerUnionId: 'on_probe', enabled: true,
    createdAt: new Date().toISOString(), nextRunAt: new Date().toISOString() } as ScheduledTask;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'background-policy-')); roots.push(root);
  const store = ScheduleAuthorityStore.open(root); stores.push(store);
  store.initializeApp('cli_probe', []); const t = task(); store.createDirect(t);
  const job: BackgroundExecutionRegistration = { id: '12345678-1234-1234-1234-123456789abc',
    appId: 'cli_probe', sessionId: 's-probe', taskId: t.id,
    turnId: `schedule:${t.id}:12345678-1234-1234-1234-123456789abc`,
    root: { pid: process.pid, procStart: readProcessStartIdentity(process.pid)! },
    bootId: readLinuxBootIdentity()!, uid: process.getuid!(), openId: 'ou_probe', unionId: 'on_probe',
    authEpoch: 0, authorityKey: backgroundAuthorityKey(t), credentialPolicyKey: backgroundCredentialPolicyKey({} as any),
    expiresAt: Date.now() + 3600_000 };
  return { root, store, t, job };
}
describe.skipIf(process.platform !== 'linux')('registered background execution policy', () => {
  it('persists registration across authority-store restart and keeps ordinary fire bookkeeping valid', () => {
    const h = fixture(); h.store.registerBackgroundExecution(h.job);
    const reopened = ScheduleAuthorityStore.open(h.root); stores.push(reopened);
    expect(reopened.backgroundExecutions('cli_probe', 's-probe')).toEqual([h.job]);
    h.store.updateTask('cli_probe', h.t.id, t => ({ ...t, lastFiredAt: new Date().toISOString(), nextRunAt: '2031-01-01T00:00:00Z' }));
    expect(reopened.backgroundExecutions('cli_probe', 's-probe')).toHaveLength(1);
    expect(reopened.backgroundExecutions('cli_foreign', 's-probe')).toEqual([]);
    expect(reopened.backgroundExecutions('cli_probe', 'another-session')).toEqual([]);
  });
  it.each(['pause', 'claim', 'prompt', 'revoke'] as const)('permanently retires the old registration on %s', change => {
    const h = fixture(); h.store.registerBackgroundExecution(h.job);
    if (change === 'revoke') h.store.revoke('cli_probe', h.t.id);
    else h.store.updateTask('cli_probe', h.t.id, t => change === 'pause' ? { ...t, enabled: false }
      : change === 'prompt' ? { ...t, prompt: 'different work' }
        : { ...t, runAsClaim: { openId: 'ou_new', unionId: 'on_new', larkAppId: 'cli_probe', claimedAt: new Date().toISOString() } });
    expect(h.store.backgroundExecutions('cli_probe', 's-probe')).toEqual([]);
    // Restoring the visible task fields cannot resurrect the retired job.
    h.store.updateTask('cli_probe', h.t.id, () => h.t);
    expect(h.store.backgroundExecutions('cli_probe', 's-probe')).toEqual([]);
  });
  it('rolls job invalidation back when the matching task write fails', () => {
    const h = fixture(); h.store.registerBackgroundExecution(h.job);
    const db = openDatabaseSyncOrThrow(scheduleAuthorityDbPath(h.root));
    try {
      db.exec(`CREATE TRIGGER reject_pause BEFORE UPDATE ON schedule_authority_tasks
        WHEN NEW.state = 'paused' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
      expect(() => h.store.updateTask('cli_probe', h.t.id, t => ({ ...t, enabled: false }))).toThrow();
      expect(h.store.getRecord('cli_probe', h.t.id)?.state).toBe('active');
      expect(h.store.backgroundExecutions('cli_probe', 's-probe')).toEqual([h.job]);
    } finally { db.close(); }
  });
  it('rejects duplicate roots and a registration built before a task mutation', () => {
    const h = fixture(); h.store.registerBackgroundExecution(h.job);
    expect(() => h.store.registerBackgroundExecution({ ...h.job, id: 'another-id' })).toThrow();
    h.store.updateTask('cli_probe', h.t.id, t => ({ ...t, prompt: 'changed' }));
    expect(() => h.store.registerBackgroundExecution({ ...h.job, id: 'third-id' })).toThrow();
  });
  it('keeps auto-completed one-shot authority for its registered job', () => {
    const h = fixture();
    h.store.updateTask('cli_probe', h.t.id, t => ({ ...t,
      parsed: { kind: 'once', at: new Date().toISOString(), display: 'once' } } as ScheduledTask));
    h.store.registerBackgroundExecution(h.job);
    h.store.updateTask('cli_probe', h.t.id, t => ({ ...t, enabled: false, disabledReason: 'once_completed' }));
    expect(h.store.backgroundExecutions('cli_probe', 's-probe')).toHaveLength(1);
  });
  it('reclaims expired capacity after restart while preserving a live revoked root tombstone', async () => {
    const h = fixture();
    const oldRoot = spawnTsEval('setInterval(() => {}, 1000)', { stdio: 'ignore' });
    children.push(oldRoot); await once(oldRoot, 'spawn');
    const old = { ...h.job, root: { pid: oldRoot.pid!, procStart: readProcessStartIdentity(oldRoot.pid!)! }, expiresAt: Date.now() - 1 };
    h.store.registerBackgroundExecution(old);
    const reopened = ScheduleAuthorityStore.open(h.root); stores.push(reopened);
    expect(() => reopened.registerBackgroundExecution({ ...old, id: 'same-root-replay', expiresAt: h.job.expiresAt })).toThrow();
    const child = spawnTsEval('setInterval(() => {}, 1000)', { stdio: 'ignore' });
    children.push(child); await once(child, 'spawn');
    const replacement = { ...h.job, id: 'replacement', root: { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! } };
    reopened.registerBackgroundExecution(replacement);
    expect(reopened.backgroundExecutions('cli_probe', 's-probe')).toEqual([replacement]);
  });
  it('does not let a revoked live root acquire a fresh lease through a new child PID', async () => {
    const h = fixture(); h.store.registerBackgroundExecution(h.job);
    h.store.revokeBackgroundExecution(h.job.id);
    const child = spawnTsEval('setInterval(() => {}, 1000)', { stdio: 'ignore' });
    children.push(child); await once(child, 'spawn');
    expect(() => h.store.registerBackgroundExecution({ ...h.job, id: 'nested-root',
      root: { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! } })).toThrow();
  });
  it('requires the registered root birth, boot, lease and peer birth', () => {
    const { job } = fixture(); const peer = { ...job.root };
    expect(backgroundPeerBelongsToJob(job, peer)).toBe(true);
    expect(backgroundPeerBelongsToJob({ ...job, bootId: 'wrong-boot' }, peer)).toBe(false);
    expect(backgroundPeerBelongsToJob({ ...job, root: { ...peer, procStart: 'stale' } }, peer)).toBe(false);
    expect(backgroundPeerBelongsToJob(job, { ...peer, procStart: 'reused' })).toBe(false);
    expect(backgroundPeerBelongsToJob({ ...job, expiresAt: Date.now() - 1 }, peer)).toBe(false);
    expect(backgroundPeerBelongsToJob({ ...job, uid: -1 }, peer)).toBe(false);
  });
  it('rejects an unrelated same-UID process and accepts a real descendant', async () => {
    const h = fixture();
    const child = spawnTsEval('setInterval(() => {}, 1000)', { stdio: 'ignore' });
    children.push(child); await once(child, 'spawn');
    const childPeer = { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! };
    expect(backgroundPeerBelongsToJob(h.job, childPeer)).toBe(true);
    const childJob = { ...h.job, root: childPeer };
    expect(backgroundPeerBelongsToJob(childJob, h.job.root)).toBe(false);
    child.kill('SIGTERM'); await once(child, 'exit');
    expect(backgroundPeerBelongsToJob(childJob, childPeer)).toBe(false);
  });
});
describe('background execution CLI syntax', () => {
  it('preserves command argv and accepts a bounded explicit lease', () => {
    expect(parseBackgroundExecutionArgs(['background', '--ttl-seconds', '120', '--', 'node', 'script with spaces.js']))
      .toEqual({ kind: 'launch', command: ['node', 'script with spaces.js'], ttlSeconds: 120 });
  });
  it.each([['background'], ['background', '--'], ['background', '--ttl-seconds', '0', '--', 'node'],
    ['background', '--ttl-seconds', 'Infinity', '--', 'node'], ['background', '--ttl-seconds', '604801', '--', 'node']])(
    'rejects incomplete or unbounded command %j', (...args) => expect(parseBackgroundExecutionArgs(args)).toBeNull());
});
