/**
 * Regression for PR #467 二审 finding 4: a sandbox-enabled bot switched to the
 * riff backend must NOT hit the worker's fail-safe "backend not sandboxable"
 * hard error — riff runs in its own remote sandbox and has no local process.
 *
 * Run:  pnpm vitest run test/riff-sandbox-bypass.test.ts
 */
import { describe, it, expect } from 'vitest';
import { localSandboxApplies, resolveLocalSandboxMode, autoWorktreeFallbackSandboxError } from '../src/adapters/backend/sandbox.js';
import { readFileSync } from 'node:fs';

describe('localSandboxApplies', () => {
  it('bypasses the local file sandbox for the riff backend (remote sandbox, no local process)', () => {
    expect(localSandboxApplies('riff')).toBe(false);
  });

  it('keeps the sandbox for local backends — fs-policy applies on BOTH platforms now', () => {
    expect(localSandboxApplies('pty')).toBe(true);
    expect(localSandboxApplies('tmux')).toBe(true);
  });
});

describe('resolveLocalSandboxMode (shared worker ↔ auto-worktree fail-closed resolver)', () => {
  // The ONE resolver both the worker (sandboxMode) and the auto-worktree
  // fail-closed gate use, so the two can never drift again. The remote exemption
  // wraps the WHOLE resolution (config / readIsolation / env), and mojo is
  // exempt ONLY when provably fully remote. There is no no-transport arm (#899).
  it('resolves the tri-state for a local backend exactly like resolveSandboxMode', () => {
    expect(resolveLocalSandboxMode({ backendType: 'pty', configSandbox: true })).toBe('oncall');
    expect(resolveLocalSandboxMode({ backendType: 'pty', configSandbox: 'scratch' })).toBe('scratch');
    expect(resolveLocalSandboxMode({ backendType: 'pty', readIsolation: true })).toBe('oncall');
    expect(resolveLocalSandboxMode({ backendType: 'pty', envValue: '1' })).toBe('oncall');
    expect(resolveLocalSandboxMode({ backendType: 'tmux', configSandbox: true, envValue: 'scratch' })).toBe('scratch');
    expect(resolveLocalSandboxMode({ backendType: 'pty' })).toBe('off');
    expect(resolveLocalSandboxMode({ backendType: 'tmux', configSandbox: false, readIsolation: false })).toBe('off');
  });

  it('throws (fail closed) on an unparseable config value or BOTMUX_SANDBOX for a local backend', () => {
    expect(() => resolveLocalSandboxMode({ backendType: 'pty', configSandbox: 'nope' })).toThrow();
    expect(() => resolveLocalSandboxMode({ backendType: 'pty', envValue: 'yes' })).toThrow();
  });

  it('exempts riff and remote-runner whatever the inputs — the remote exemption wraps everything', () => {
    for (const backendType of ['riff', 'remote-runner']) {
      expect(resolveLocalSandboxMode({ backendType, configSandbox: true })).toBe('off');
      expect(resolveLocalSandboxMode({ backendType, configSandbox: 'scratch' })).toBe('off');
      expect(resolveLocalSandboxMode({ backendType, readIsolation: true })).toBe('off');
      expect(resolveLocalSandboxMode({ backendType, envValue: '1' })).toBe('off');
    }
  });

  it('exempts a PROVABLY remote mojo session (cloud on, localDaemon off, no wrapper, clean env)', () => {
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: true }, configSandbox: true,
    })).toBe('off');
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: true }, envValue: '1',
    })).toBe('off');
  });

  it('does NOT exempt mojo by name alone — a local mojo session keeps its sandbox', () => {
    expect(resolveLocalSandboxMode({ backendType: 'mojo', configSandbox: true })).toBe('oncall');
    expect(resolveLocalSandboxMode({ backendType: 'mojo', mojoConfig: {}, configSandbox: true })).toBe('oncall');
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: false }, configSandbox: true,
    })).toBe('oncall');
  });

  it('does NOT exempt mojo cloud when the remote proof is voided (localDaemon / wrapperCli / env)', () => {
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: true, localDaemon: true }, configSandbox: true,
    })).toBe('oncall');
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: true, wrapperCli: 'wrap' }, configSandbox: true,
    })).toBe('oncall');
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: true, env: { PATH: '/tmp/fake' } }, configSandbox: true,
    })).toBe('oncall');
    expect(resolveLocalSandboxMode({
      backendType: 'mojo', mojoConfig: { cloud: true, env: { X_JWT_TOKEN: 'tok' } }, configSandbox: true,
    })).toBe('off'); // the ONE exempt name
  });
});

describe('autoWorktreeFallbackSandboxError (fork may only strengthen the gate verdict)', () => {
  it('refuses oncall in the dir the gate degraded to', () => {
    expect(autoWorktreeFallbackSandboxError({ sandboxMode: 'oncall', workingDir: '/repo/x', fallbackDir: '/repo/x' })).toBeTruthy();
    expect(autoWorktreeFallbackSandboxError({ sandboxMode: 'oncall', workingDir: '/repo/x/', fallbackDir: '/repo/x' })).toBeTruthy();
  });
  it('allows off / scratch, other dirs, and sessions without a fallback marker', () => {
    expect(autoWorktreeFallbackSandboxError({ sandboxMode: 'off', workingDir: '/repo/x', fallbackDir: '/repo/x' })).toBeUndefined();
    expect(autoWorktreeFallbackSandboxError({ sandboxMode: 'scratch', workingDir: '/repo/x', fallbackDir: '/repo/x' })).toBeUndefined();
    expect(autoWorktreeFallbackSandboxError({ sandboxMode: 'oncall', workingDir: '/repo/x-wt', fallbackDir: '/repo/x' })).toBeUndefined();
    expect(autoWorktreeFallbackSandboxError({ sandboxMode: 'oncall', workingDir: '/repo/x', fallbackDir: undefined })).toBeUndefined();
  });
  it('is wired: forkWorker forwards the session marker and the worker throws on the resolved sandboxMode', () => {
    const wp = readFileSync('src/core/worker-pool.ts', 'utf8');
    expect(wp).toContain('autoWorktreeFallbackDir: ds.session.autoWorktreeFallbackDir,');
    const w = readFileSync('src/worker.ts', 'utf8');
    const i = w.indexOf('const sandboxMode = resolveLocalSandboxMode(');
    const j = w.indexOf('fallbackDir: cfg.autoWorktreeFallbackDir,');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(w.slice(j, j + 200)).toContain('if (fallbackError) throw new Error(fallbackError);');
  });
});

import { reconcileRiffBackendType } from '../src/core/persistent-backend.js';
import { isValidRiffBaseUrl } from '../src/adapters/backend/riff-backend.js';

describe('reconcileRiffBackendType (finding G — pairing invariant at the spawn chokepoint)', () => {
  it('forces riff backend for the riff CLI regardless of stored backendType', () => {
    expect(reconcileRiffBackendType('riff', 'pty', 'tmux')).toBe('riff');
    expect(reconcileRiffBackendType('riff', 'tmux', 'tmux')).toBe('riff');
    expect(reconcileRiffBackendType('riff', 'riff', 'tmux')).toBe('riff');
  });

  it('falls back to the daemon default when a non-riff CLI carries backendType=riff', () => {
    expect(reconcileRiffBackendType('codex', 'riff', 'tmux')).toBe('tmux');
    expect(reconcileRiffBackendType('codex-app', 'riff', 'tmux')).toBe('tmux');
    expect(reconcileRiffBackendType('claude-code', 'riff', 'pty')).toBe('pty');
  });

  it('degrades to pty when the daemon default itself is misconfigured as riff', () => {
    expect(reconcileRiffBackendType('codex', 'riff', 'riff' as any)).toBe('pty');
  });

  it('passes through manual non-riff overrides', () => {
    expect(reconcileRiffBackendType('codex', 'tmux', 'pty')).toBe('tmux');
    expect(reconcileRiffBackendType('claude-code', 'herdr', 'tmux')).toBe('herdr');
  });
});

describe('isValidRiffBaseUrl (finding G — fail-fast gate)', () => {
  it('accepts http(s) URLs only', () => {
    expect(isValidRiffBaseUrl('https://riff-boe.example.com')).toBe(true);
    expect(isValidRiffBaseUrl('http://localhost:3000')).toBe(true);
  });
  it('rejects empty / undefined / non-http values (the `{}` config save case)', () => {
    expect(isValidRiffBaseUrl(undefined)).toBe(false);
    expect(isValidRiffBaseUrl('')).toBe(false);
    expect(isValidRiffBaseUrl('   ')).toBe(false);
    expect(isValidRiffBaseUrl('ftp://x')).toBe(false);
    expect(isValidRiffBaseUrl('not-a-url')).toBe(false);
  });
});
