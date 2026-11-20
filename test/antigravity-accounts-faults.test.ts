import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('Antigravity credential persistence fault injection', () => {
  it('preserves committed snapshots, rolls back uncommitted live writes, and reports cleanup failure', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-agy-fault-test-'));
    const fixture = fileURLToPath(new URL('./fixtures/antigravity-accounts-faults.ts', import.meta.url));
    const child = spawnNodeTsScript(fixture, [root], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    let code: number | null;
    try {
      code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      clearTimeout(timeout);
    }
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.postRenameFsync).toMatchObject({
      injected: true,
      thrown: '',
      persistedIds: ['acc1', 'acc2', 'acc3'],
      tokenExists: true,
      acc3Valid: true,
    });
    expect(result.livePostRenameFsync).toMatchObject({
      injected: true,
      thrown: '',
      activeId: 'acc2',
      liveEmail: 'b@example.test',
      liveMatchesActive: true,
    });
    expect(result.vaultPostRenameFsync).toMatchObject({
      injected: true,
      thrown: '',
      acc2Valid: true,
    });
    expect(result.saveStateRenameRollback).toMatchObject({
      injected: true,
      stateEmail: 'a@example.test',
      liveEmail: 'a@example.test',
      vaultEmail: 'a@example.test',
      vaultAccess: 'OLD_AGY_REFRESHED_ACCESS',
      recoveryExists: true,
      recoveryContainsNewB: true,
    });
    expect(result.saveStateRenameRollback.thrown).not.toBe('');
    expect(result.saveStateRenameRollback.reconciliation.error).toBeUndefined();
    expect(result.metadataStateRenameFailure).toMatchObject({
      injected: true,
      outcome: 'write_failed',
      stateEmailAfterFailure: null,
      accountIds: ['noemail'],
    });
    expect(result.metadataStateRenameFailure.duplicateError).toContain('已托管');
    expect(result.stateRenameFailure).toMatchObject({
      injected: true,
      outcome: 'write_failed',
      liveEmail: 'a@example.test',
      activeId: 'acc1',
      liveMatchesActive: true,
    });
    expect(result.stateRenameFailure.acc1Cooldown).toBeGreaterThan(0);
    expect(result.removeUnlinkFailure).toMatchObject({
      injected: true,
      persistedIds: [],
      tokenStillExists: true,
      retry: { removedId: 'acc1', newActiveId: null },
      tokenExistsAfterRetry: false,
    });
    expect(result.removeUnlinkFailure.thrown).toContain('凭据快照删除失败');
  });
});
