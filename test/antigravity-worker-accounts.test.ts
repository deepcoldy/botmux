import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  inspectAntigravityAccounts,
  saveAntigravityAccount,
  useAntigravityAccount,
  type AntigravityAccountStoreOptions,
} from '../src/services/antigravity-accounts.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function token(email: string): string {
  return JSON.stringify({
    id_token_email: email,
    token: { access_token: `access-${email}`, refresh_token: `refresh-${email}`, expiry: '2027-01-01T00:00:00Z' },
  });
}
function writeToken(path: string, email: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token(email), { mode: 0o600 });
}

describe('Antigravity worker account launch guards', () => {
  it('always creates and masks a missing account-vault mount target', () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-agy-mask-test-'));
    const prepare = loadWorkerFunction<(
      root: string,
      hideDirectories: Set<string>,
      hideFiles: Set<string>,
    ) => void>('prepareAntigravityAccountsCredentialMask', {
      join, lstatSync, mkdirSync, realpathSync,
    });
    const hideDirectories = new Set<string>();
    const hideFiles = new Set<string>();
    prepare(root, hideDirectories, hideFiles);

    const vault = join(root, 'antigravity-accounts');
    expect(lstatSync(vault).isDirectory()).toBe(true);
    expect(hideDirectories.has(realpathSync(vault))).toBe(true);
    expect(hideFiles.size).toBe(0);

    // Existing non-directory/symlink leaves remain file-shaped masks and are
    // never followed to their target.
    rmSync(vault, { recursive: true });
    const target = join(root, 'target');
    writeFileSync(target, 'not a vault');
    symlinkSync(target, vault);
    prepare(root, hideDirectories, hideFiles);
    expect(hideFiles.has(vault)).toBe(true);
  });

  it('aborts managed preflight on reconcile errors and only returns a proven active account', () => {
    const reconcile = loadWorkerFunction<(opts: AntigravityAccountStoreOptions) => unknown>(
      'reconcileAntigravitySpawnAccount',
      {
        reconcileActiveAntigravityToken: () => ({ managed: true, error: 'no_enabled_account' }),
      },
    );
    expect(() => reconcile({})).toThrow(/no_enabled_account/);

    const unmanaged = loadWorkerFunction<(opts: AntigravityAccountStoreOptions) => unknown>(
      'reconcileAntigravitySpawnAccount',
      { reconcileActiveAntigravityToken: () => ({ managed: false }) },
    );
    expect(unmanaged({})).toBeUndefined();

    const healthy = loadWorkerFunction<(opts: AntigravityAccountStoreOptions) => { accountId: string } | undefined>(
      'reconcileAntigravitySpawnAccount',
      { reconcileActiveAntigravityToken: () => ({ managed: true, activeId: 'acc2' }) },
    );
    expect(healthy({})?.accountId).toBe('acc2');
  });

  it('turns a post-spawn live-token rewrite into an unknown account observation', () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-agy-confirm-test-'));
    const homeDir = join(root, 'home');
    const botmuxConfigDir = join(root, 'botmux');
    const liveTokenPath = join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const opts: AntigravityAccountStoreOptions = {
      homeDir, botmuxConfigDir, liveTokenPath,
      now: () => Date.parse('2026-11-20T12:00:00Z'), platform: 'linux', env: {},
    };
    writeToken(liveTokenPath, 'a@example.test');
    saveAntigravityAccount('acc1', opts);
    const second = join(root, 'second.json');
    writeToken(second, 'b@example.test');
    saveAntigravityAccount('acc2', { ...opts, sourceTokenPath: second });
    useAntigravityAccount('acc2', opts);
    const confirm = loadWorkerFunction<(opts: AntigravityAccountStoreOptions, expected: string) => string | null>(
      'confirmAntigravitySpawnAccount',
      { inspectAntigravityAccounts },
    );

    expect(confirm(opts, 'acc2')).toBe('acc2');
    // Another long-running agy rewrote the shared live file after preflight.
    writeToken(liveTokenPath, 'a@example.test');
    expect(confirm(opts, 'acc2')).toBeNull();
  });
});
