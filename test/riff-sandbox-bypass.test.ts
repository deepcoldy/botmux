/**
 * Regression for PR #467 二审 finding 4: a sandbox-enabled bot switched to the
 * riff backend must NOT hit the worker's fail-safe "backend not sandboxable"
 * hard error — riff runs in its own remote sandbox and has no local process.
 *
 * Run:  pnpm vitest run test/riff-sandbox-bypass.test.ts
 */
import { describe, it, expect } from 'vitest';
import { localSandboxApplies, localSandboxRequested } from '../src/adapters/backend/sandbox.js';

describe('localSandboxApplies', () => {
  it('bypasses the local file sandbox for the riff backend (remote sandbox, no local process)', () => {
    expect(localSandboxApplies('riff')).toBe(false);
  });

  it('keeps the sandbox for local backends — fs-policy applies on BOTH platforms now', () => {
    expect(localSandboxApplies('pty')).toBe(true);
    expect(localSandboxApplies('tmux')).toBe(true);
  });
});

describe('localSandboxRequested (shared worker ↔ auto-worktree fail-closed predicate)', () => {
  // The ONE predicate both the worker (sandboxRequested) and the auto-worktree
  // fail-closed gate use, so the two can never drift again. The remote exemption
  // must wrap the WHOLE union (sandbox / readIsolation / noTransport / env), and
  // mojo is exempt ONLY when provably fully remote.
  it('requests the sandbox for a local backend with any union arm on', () => {
    expect(localSandboxRequested({ backendType: 'pty', sandbox: true })).toBe(true);
    expect(localSandboxRequested({ backendType: 'pty', readIsolation: true })).toBe(true);
    expect(localSandboxRequested({ backendType: 'pty', noTransport: true })).toBe(true);
    expect(localSandboxRequested({ backendType: 'pty', envSandboxEnabled: true })).toBe(true);
  });

  it('requests nothing for a local backend with every union arm off', () => {
    expect(localSandboxRequested({ backendType: 'pty' })).toBe(false);
    expect(localSandboxRequested({ backendType: 'tmux', sandbox: false, readIsolation: false })).toBe(false);
  });

  it('exempts riff with ANY union arm — the remote exemption wraps the whole union', () => {
    expect(localSandboxRequested({ backendType: 'riff', sandbox: true })).toBe(false);
    expect(localSandboxRequested({ backendType: 'riff', readIsolation: true })).toBe(false);
    expect(localSandboxRequested({ backendType: 'riff', noTransport: true })).toBe(false);
    expect(localSandboxRequested({ backendType: 'riff', envSandboxEnabled: true })).toBe(false);
  });

  it('exempts a PROVABLY remote mojo session (cloud on, localDaemon off, no wrapper, clean env)', () => {
    // The deepcoldy regression: a mojo {cloud:true} + sandbox bot was refused by
    // the fail-closed gate even though the worker applies NO local sandbox to it.
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true }, sandbox: true,
    })).toBe(false);
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true }, envSandboxEnabled: true,
    })).toBe(false);
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true }, noTransport: true,
    })).toBe(false);
  });

  it('does NOT exempt mojo by name alone — a local mojo session stays fail-closed', () => {
    expect(localSandboxRequested({ backendType: 'mojo', sandbox: true })).toBe(true);
    expect(localSandboxRequested({ backendType: 'mojo', mojoConfig: {}, sandbox: true })).toBe(true);
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: false }, sandbox: true,
    })).toBe(true);
  });

  it('does NOT exempt mojo cloud when the remote proof is voided (localDaemon / wrapperCli / env)', () => {
    // localDaemon explicitly opts into host execution.
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true, localDaemon: true }, sandbox: true,
    })).toBe(true);
    // A top-level wrapperCli runs before the binary and can rewrite the env the
    // decision depends on — the proof must see it (EffectiveMojoConfig carries it).
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true, wrapperCli: 'wrap' }, sandbox: true,
    })).toBe(true);
    // Any env key besides the canonical JWT name voids the proof (PATH / loader
    // hooks can change which binary executes).
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true, env: { PATH: '/tmp/fake' } }, sandbox: true,
    })).toBe(true);
    expect(localSandboxRequested({
      backendType: 'mojo', mojoConfig: { cloud: true, env: { X_JWT_TOKEN: 'tok' } }, sandbox: true,
    })).toBe(false); // the ONE exempt name
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
