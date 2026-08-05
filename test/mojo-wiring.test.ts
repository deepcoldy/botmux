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
import { localSandboxApplies } from '../src/adapters/backend/sandbox.js';
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
  it('is excluded from the local sandbox engine', () => {
    // mojo runs tools in its own --cloud sandbox; without the bypass the
    // worker's fail-closed "backend not sandboxable" check bricks the bot.
    expect(localSandboxApplies('mojo')).toBe(false);
    expect(localSandboxApplies('riff')).toBe(false);
    expect(localSandboxApplies('tmux')).toBe(true);
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
