/**
 * Unit tests for the mojo CLI/backend wiring — the cross-cutting invariants that
 * compile fine but fail at runtime if a wiring point is missed.
 *
 * The `reconcileRiffBackendType` cases are the important ones: mojo's
 * `resolvedBin` is an empty string, so a mojo session that gets paired with
 * pty/tmux does not fail loudly at config time — it fails at spawn.
 *
 * Run:  pnpm vitest run test/mojo-wiring.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createMojoAdapter } from '../src/adapters/cli/mojo.js';
import { createCliAdapterSync, rawCliExecutable } from '../src/adapters/cli/registry.js';
import { isMojoFullyRemote, localSandboxApplies } from '../src/adapters/backend/sandbox.js';
import { backendSandboxCompatibilityError } from '../src/adapters/backend/session-backend-selector.js';
import { buildReproduceCommand } from '../src/adapters/backend/reproduce-command.js';
import {
  isRemoteBackendType,
  isRemoteCliId,
  reconcileRiffBackendType,
} from '../src/core/persistent-backend.js';

describe('mojo CLI adapter', () => {
  it('is reachable through the registry by id', () => {
    const adapter = createCliAdapterSync('mojo');
    expect(adapter.id).toBe('mojo');
  });

  it('declares no local binary and no launch args', () => {
    const adapter = createMojoAdapter();
    // MojoBackend shells out per turn; the worker must not spawn anything.
    expect(adapter.resolvedBin).toBe('');
    expect(adapter.buildArgs({ sessionId: 's', resume: false })).toEqual([]);
  });

  it('carves out the whole ~/.mojo dir, not a single credentials file', () => {
    // A single-file carve-out is existence-filtered away before first login and
    // would strand memory/ + skills/ in a short-lived tmpfs.
    expect(createMojoAdapter().authPaths).toEqual(['~/.mojo']);
  });

  it('opts out of type-ahead (turns are serialized server-side)', () => {
    expect(createMojoAdapter().supportsTypeAhead).toBe(false);
  });
});

describe('remote-backend pairing invariant', () => {
  it('classifies mojo and riff as remote, locals as not', () => {
    expect(isRemoteBackendType('mojo')).toBe(true);
    expect(isRemoteBackendType('riff')).toBe(true);
    for (const local of ['pty', 'tmux', 'herdr', 'zellij', 'zmx'] as const) {
      expect(isRemoteBackendType(local)).toBe(false);
    }
  });

  it('forces the mojo backend for the mojo CLI even when configured as pty/tmux', () => {
    // Without this a mojo session spawns pty/tmux against an EMPTY resolvedBin.
    expect(reconcileRiffBackendType('mojo', 'pty', 'pty')).toBe('mojo');
    expect(reconcileRiffBackendType('mojo', 'tmux', 'tmux')).toBe('mojo');
  });

  it('keeps riff pairing behaviour unchanged after the generalization', () => {
    expect(reconcileRiffBackendType('riff', 'pty', 'pty')).toBe('riff');
    expect(reconcileRiffBackendType('claude-code', 'riff', 'tmux')).toBe('tmux');
    // A defaultType itself misconfigured to a remote backend falls back to pty.
    expect(reconcileRiffBackendType('claude-code', 'riff', 'riff')).toBe('pty');
  });

  it('sends a local CLI on the mojo backend back to the daemon default', () => {
    expect(reconcileRiffBackendType('claude-code', 'mojo', 'tmux')).toBe('tmux');
    expect(reconcileRiffBackendType('claude-code', 'mojo', 'mojo')).toBe('pty');
  });

  it('leaves local CLI/backend combinations untouched', () => {
    expect(reconcileRiffBackendType('claude-code', 'tmux', 'pty')).toBe('tmux');
    expect(reconcileRiffBackendType('codex', 'zellij', 'pty')).toBe('zellij');
  });
});

describe('mojo backend bypasses local-only machinery', () => {
  it('bypasses the local sandbox ONLY when mojo provably runs off-box', () => {
    // riff is always remote (pure HTTP).
    expect(localSandboxApplies('riff')).toBe(false);
    expect(localSandboxApplies('tmux')).toBe(true);

    // mojo spawns its binary locally EVERY turn, so the bypass must be earned:
    // cloud on + localDaemon off. Anything else keeps the local sandbox engaged
    // rather than silently skipping it for a bot that asked for sandbox: true.
    expect(localSandboxApplies('mojo', { cloud: true })).toBe(false);
    expect(localSandboxApplies('mojo', { cloud: true, localDaemon: false })).toBe(false);

    // Fail-closed cases — each of these previously bypassed the sandbox.
    expect(localSandboxApplies('mojo', undefined)).toBe(true);
    expect(localSandboxApplies('mojo', {})).toBe(true);
    expect(localSandboxApplies('mojo', { cloud: false })).toBe(true);
    expect(localSandboxApplies('mojo', { cloud: true, localDaemon: true })).toBe(true);
  });

  it('isMojoFullyRemote treats an unproven config as local', () => {
    expect(isMojoFullyRemote({ cloud: true })).toBe(true);
    expect(isMojoFullyRemote(undefined)).toBe(false);
    expect(isMojoFullyRemote({})).toBe(false);
    expect(isMojoFullyRemote({ localDaemon: true })).toBe(false);
    expect(isMojoFullyRemote({ cloud: true, localDaemon: true })).toBe(false);
  });

  it('refuses to launch a locally-executing mojo bot that requested sandbox', () => {
    // Fail closed with an actionable message: MojoBackend does not launch its
    // per-turn child under the sandbox wrapper, so `sandbox: true` cannot be
    // honoured here and must not be silently ignored.
    const err = backendSandboxCompatibilityError({
      backendType: 'mojo',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: false,
      mojoConfig: { cloud: false },
    });
    expect(err).toBeTruthy();
    expect(err).toContain('mojo.cloud=true');

    // Proven-remote mojo is allowed through, like riff.
    expect(backendSandboxCompatibilityError({
      backendType: 'mojo',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: false,
      mojoConfig: { cloud: true },
    })).toBeUndefined();
    expect(backendSandboxCompatibilityError({
      backendType: 'riff',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: false,
    })).toBeUndefined();
  });

  it('has no local reproduce command', () => {
    expect(buildReproduceCommand({
      backendType: 'mojo',
      bin: '',
      args: [],
      cwd: '/tmp',
    })).toBeNull();
  });
});

describe('remote CLI id classification', () => {
  it('recognizes mojo and riff as remote CLI ids', () => {
    expect(isRemoteCliId('mojo')).toBe(true);
    expect(isRemoteCliId('riff')).toBe(true);
    expect(isRemoteCliId('claude-code')).toBe(false);
    expect(isRemoteCliId(undefined)).toBe(false);
  });
});

describe('mojo requires a local binary (unlike riff/mira)', () => {
  it('declares `mojo` so setup fails fast on a missing install', () => {
    // MojoBackend spawns the binary once per turn, so a missing install is a
    // real, user-visible failure — it must NOT be treated like riff/mira, which
    // are pure HTTP and legitimately have no local command.
    expect(rawCliExecutable('mojo')).toBe('mojo');
    expect(rawCliExecutable('riff')).toBeUndefined();
  });

  it('honours an explicit path override', () => {
    expect(rawCliExecutable('mojo', '/opt/custom/mojo')).toBe('/opt/custom/mojo');
  });
});
