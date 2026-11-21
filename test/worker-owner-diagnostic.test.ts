import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerOwnerDiagnostics } from '../src/core/worker-owner-diagnostic.js';
import { WorkerAdmissionOwnerAlerts } from '../src/core/worker-admission-owner-alert.js';
import { evaluateWorkerAdmission } from '../src/core/worker-budget.js';

describe('worker owner diagnostic batches', () => {
  let dir: string;
  let owner: string | undefined;
  const instances: Array<{ dispose(): void }> = [];
  const send = vi.fn(async (_app: string, _owner: string, _content: string) => 'om_notice');
  const onError = vi.fn();
  const deps = () => ({ dataDir: dir, ownerForApp: () => owner,
    botForApp: () => ({ name: 'Bot', locale: 'en' as const }), send, onError,
    batchMs: 20, cooldownMs: 1_000 });
  const make = () => {
    const diagnostics = new WorkerOwnerDiagnostics(deps());
    instances.push(diagnostics);
    return diagnostics;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    dir = mkdtempSync(join(tmpdir(), 'worker-owner-diagnostic-'));
    owner = 'ou_owner';
    send.mockReset(); send.mockResolvedValue('om_notice'); onError.mockClear();
  });
  afterEach(() => {
    for (const instance of instances.splice(0)) instance.dispose();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('combines restored process failures and counts each affected session once', async () => {
    const diagnostics = make();
    for (let i = 0; i < 3; i++) {
      diagnostics.report('app_a', `s${i}`, { kind: 'startup_failure', cliName: 'CLI', reason: 'spawn ENOENT' });
      diagnostics.report('app_a', `s${i}`, { kind: 'startup_failure', cliName: 'CLI', reason: 'spawn ENOENT' });
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['app_a', 'ou_owner']);
    expect(send.mock.calls[0]![2]).toContain('3');
    expect(send.mock.calls[0]![2]).toContain('ENOENT');
  });

  it('keeps install, startup and memory episodes independent', async () => {
    const diagnostics = make();
    const memory = new WorkerAdmissionOwnerAlerts(deps()); instances.push(memory);
    diagnostics.report('app_a', 'startup', { kind: 'startup_failure', cliName: 'CLI', reason: 'EACCES' });
    for (let i = 0; i < 3; i++) diagnostics.report('app_a', `install${i}`, {
      kind: 'cli_install_changed', cliName: 'Pi', runningVersion: '1.1.0', installedVersion: '1.3.0',
    });
    memory.report('app_a', 'memory', evaluateWorkerAdmission({
      totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 0.1 * 1024 ** 3,
      totalMemorySource: 'host', availableMemorySource: 'host', warnings: [],
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(3);
    const install = send.mock.calls.find(call => call[2].includes('1.3.0'))!;
    expect(install[2]).toContain('1.1.0');
    expect(install[2]).toContain('3');
  });

  it('retains cooldown across notifier restart and allows a later attempt', async () => {
    const event = { kind: 'startup_failure', cliName: 'CLI', reason: 'ENOENT' } as const;
    make().report('app_a', 'first', event);
    await vi.advanceTimersByTimeAsync(20);
    make().report('app_a', 'after_restart', event);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    make().report('app_a', 'later', event);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('follows the current owner and does not claim an unresolved recipient', async () => {
    const diagnostics = make();
    owner = undefined;
    const event = { kind: 'cli_install_changed', cliName: 'Pi', runningVersion: 'old', installedVersion: 'new' } as const;
    diagnostics.report('app_a', 'unresolved', event);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).not.toHaveBeenCalled();
    diagnostics.report('app_a', 'resolved', event);
    owner = 'ou_new_owner';
    await vi.advanceTimersByTimeAsync(20);
    expect(send.mock.calls[0]![1]).toBe('ou_new_owner');
  });

  it('throttles transport failures and discards post-shutdown reports', async () => {
    const diagnostics = make();
    const event = { kind: 'startup_failure', cliName: 'CLI', reason: 'ENOENT' } as const;
    send.mockRejectedValueOnce(new Error('transport unavailable'));
    diagnostics.report('app_a', 'first', event);
    await vi.advanceTimersByTimeAsync(20);
    diagnostics.report('app_a', 'repeat', event);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    diagnostics.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    diagnostics.report('app_a', 'after_shutdown', event);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
