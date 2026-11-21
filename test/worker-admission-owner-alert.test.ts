import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerAdmissionOwnerAlerts } from '../src/core/worker-admission-owner-alert.js';
import { evaluateWorkerAdmission, type WorkerAdmissionDecision } from '../src/core/worker-budget.js';
import { withFileLockSync } from '../src/utils/file-lock.js';

const GIB = 1024 ** 3;
const blocked = (): WorkerAdmissionDecision => evaluateWorkerAdmission({
  totalMemoryBytes: 16 * GIB, availableMemoryBytes: 0.1 * GIB,
  totalMemorySource: 'host', availableMemorySource: 'host',
  memoryFullAvg10: 0, memoryFullAvg10Source: 'host', warnings: [],
});

describe('worker admission owner alerts', () => {
  let dir: string;
  let owner: string | undefined;
  let alerts: WorkerAdmissionOwnerAlerts[];
  const send = vi.fn(async (_app: string, _owner: string, _content: string) => 'om_notice');
  const onError = vi.fn();
  const make = (dataDir = dir, overrides: Partial<ConstructorParameters<typeof WorkerAdmissionOwnerAlerts>[0]> = {}) => {
    const instance = new WorkerAdmissionOwnerAlerts({ dataDir,
      ownerForApp: app => app === 'app_b' ? 'ou_owner_b' : owner,
      botForApp: app => ({ name: app, locale: 'en' }), send, onError,
      batchMs: 20, cooldownMs: 1_000,
      ...overrides,
    });
    alerts.push(instance);
    return instance;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    dir = mkdtempSync(join(tmpdir(), 'worker-admission-alert-'));
    owner = 'ou_bot_owner';
    alerts = [];
    send.mockClear();
    send.mockResolvedValue('om_notice');
    onError.mockClear();
  });
  afterEach(() => {
    for (const alert of alerts) alert.dispose();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates 30 distinct restored sessions into one bot-owner DM', async () => {
    const alert = make();
    for (let i = 0; i < 30; i++) {
      alert.report('app_a', `session_${i}`, blocked());
      alert.report('app_a', `session_${i}`, blocked());
    }
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['app_a', 'ou_bot_owner']);
    expect(send.mock.calls[0]![2]).toContain('30');
    expect(send.mock.calls[0]![2]).toContain('0.1 GiB');
  });

  it('preserves app-scoped owner identity for different bots', async () => {
    const alert = make();
    alert.report('app_a', 'session_a', blocked());
    alert.report('app_b', 'session_b', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['app_a', 'ou_bot_owner'], ['app_b', 'ou_owner_b'],
    ]);
  });

  it('serializes two notifier instances and retains cooldown across restart', async () => {
    make().report('app_a', 'session_a', blocked());
    make().report('app_a', 'session_b', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    make().report('app_a', 'after_restart', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    make().report('app_a', 'after_cooldown', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not let suppressed batches extend the persisted cooldown', async () => {
    const first = make();
    first.report('app_a', 'initial', blocked());
    await vi.advanceTimersByTimeAsync(20);
    const second = make();
    await vi.advanceTimersByTimeAsync(900);
    second.report('app_a', 'near_expiry', blocked());
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(100);
    second.report('app_a', 'expired', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rate-limits failed sends and permits another attempt after cooldown', async () => {
    send.mockRejectedValueOnce(new Error('transport unavailable'));
    const alert = make();
    alert.report('app_a', 'first', blocked());
    await vi.advanceTimersByTimeAsync(20);
    alert.report('app_a', 'repeat', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    alert.report('app_a', 'retry', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('defers rather than duplicating an alert while a live process holds the claim lock', async () => {
    make().report('app_a', 'first', blocked());
    await vi.advanceTimersByTimeAsync(20);
    const markers = join(dir, '.worker-admission-alerts');
    const marker = join(markers, readdirSync(markers)[0]!);
    const contender = make();
    withFileLockSync(marker, () => {
      contender.report('app_a', 'contender', blocked());
      let wall = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall += 100);
      try { vi.advanceTimersByTime(20); }
      finally { clock.mockRestore(); }
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves cooldown through a small backward clock correction and restart', async () => {
    make().report('app_a', 'first', blocked());
    await vi.advanceTimersByTimeAsync(20);
    vi.setSystemTime(Date.now() - 100);
    make().report('app_a', 'after_clock_change', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not consume cooldown when bot metadata preparation fails', async () => {
    const metadata = vi.fn(() => ({ name: 'Bot', locale: 'en' as const }));
    metadata.mockImplementationOnce(() => { throw new Error('metadata temporarily unavailable'); });
    make(dir, { botForApp: metadata }).report('app_a', 'failed_preparation', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).not.toHaveBeenCalled();
    make().report('app_a', 'retry_preparation', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('follows an owner change before delivery and does not inherit their predecessor cooldown', async () => {
    const alert = make();
    alert.report('app_a', 'first', blocked());
    owner = 'ou_new_owner';
    await vi.advanceTimersByTimeAsync(20);
    expect(send.mock.calls[0]![1]).toBe('ou_new_owner');
    owner = 'ou_third_owner';
    alert.report('app_a', 'second', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toBe('ou_third_owner');
  });

  it('does not claim a cooldown without an owner and retries after owner resolution', async () => {
    const alert = make();
    owner = undefined;
    alert.report('app_a', 'unresolved', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).not.toHaveBeenCalled();
    owner = 'ou_resolved';
    alert.report('app_a', 'resolved', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps local cooldown when disk persistence fails', async () => {
    const file = join(dir, 'not_a_directory');
    writeFileSync(file, 'occupied');
    const alert = make(file);
    alert.report('app_a', 'first', blocked());
    await vi.advanceTimersByTimeAsync(20);
    alert.report('app_a', 'repeat', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('recovers from a malformed persisted marker', async () => {
    make().report('app_a', 'first', blocked());
    await vi.advanceTimersByTimeAsync(20);
    const markers = join(dir, '.worker-admission-alerts');
    writeFileSync(join(markers, readdirSync(markers)[0]!), '{broken');
    make().report('app_a', 'second', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not schedule a notice for allowed admission', async () => {
    make().report('app_a', 'healthy', { ...blocked(), allowed: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels pending batches when the daemon shuts down before delivery', async () => {
    const alert = make();
    alert.report('app_a', 'pending', blocked());
    alert.dispose();
    alert.report('app_a', 'late_retry_after_shutdown', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).not.toHaveBeenCalled();
    make().report('app_a', 'after_restart', blocked());
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
