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
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

  it('isMojoFullyRemote counts the launcher env as part of the proof', () => {
    // The reviewer's finding: cloud/localDaemon/wrapperCli all look clean, but
    // resolveBin() picks the binary off the effective child PATH, and loader hooks
    // reach the real binary. So env has to void the proof exactly like a wrapper.
    for (const key of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']) {
      expect(
        isMojoFullyRemote({ cloud: true, env: { [key]: '/tmp/evil' } }),
        `${key} must void the proof`,
      ).toBe(false);
    }
    // Allowlist, not denylist: an unknown variable is unprovable too, because the
    // set that can redirect execution cannot be enumerated.
    expect(isMojoFullyRemote({ cloud: true, env: { SOMETHING_NEW: 'x' } })).toBe(false);

    // The credential variable is the one safe case — it cannot change what runs.
    expect(isMojoFullyRemote({ cloud: true, env: { X_JWT_TOKEN: 'tok' } })).toBe(true);
    expect(isMojoFullyRemote({ cloud: true, jwtEnv: 'MY_JWT', env: { MY_JWT: 'tok' } })).toBe(true);
    // ...and only under the name this bot actually reads it from.
    expect(isMojoFullyRemote({ cloud: true, jwtEnv: 'MY_JWT', env: { X_JWT_TOKEN: 'tok' } })).toBe(false);
    // An empty env block must not itself be disqualifying.
    expect(isMojoFullyRemote({ cloud: true, env: {} })).toBe(true);
  });

  it('the proof plumbing does not silently drop env on the way in', () => {
    // Narrowing any of these parameter types (as they originally were) drops `env`
    // WITHOUT a compile error — TS only rejects excess properties on fresh literals,
    // so a passed-through EffectiveMojoConfig loses the field silently and the
    // bypass comes back. Locked at the source level because the failure mode is the
    // absence of a field, which no runtime call can observe.
    for (const file of [
      'src/adapters/backend/sandbox.ts',
      'src/adapters/backend/session-backend-selector.ts',
    ]) {
      const src = readFileSync(resolve(file), 'utf8');
      const idx = src.indexOf('localSandboxApplies') >= 0 && file.endsWith('sandbox.ts')
        ? src.indexOf('remoteExecution?: {')
        : src.indexOf('mojoConfig?: {');
      expect(idx, `${file}: proof-input type not found`).toBeGreaterThan(0);
      const decl = src.slice(idx, src.indexOf('}', idx));
      expect(decl, `${file} must accept jwtEnv`).toContain('jwtEnv');
      expect(decl, `${file} must accept env`).toContain('env');
    }
  });

  it('a cold refork cannot turn a proven-remote session into a local launcher', () => {
    // The full attack chain from review. `env` is NOT in MOJO_IDENTITY_KEYS (the
    // JWT has to stay rotatable), so sessionMojoConfig re-merges it from LIVE bot
    // config on every cold refork. Before this fix the session stayed "provable"
    // across that refork while executing a different binary — local sandbox
    // bypassed and device isolation classifying it safe_remote.
    const frozenIdentity = { cloud: true, workspaceId: 'ws-a' };

    // As created: nothing but the control plane.
    expect(localSandboxApplies('mojo', frozenIdentity)).toBe(false);

    // After the bot config gained a redirected PATH and the session was reforked.
    const afterRefork = { ...frozenIdentity, env: { PATH: '/tmp/fake-mojo-dir' } };
    expect(localSandboxApplies('mojo', afterRefork)).toBe(true);
  });

  it('names the offending env vars when refusing a sandboxed mojo bot', () => {
    // "set cloud=true" is useless advice when cloud already IS true and the real
    // blocker is an env var, so the message has to name them.
    const reason = backendSandboxCompatibilityError({
      backendType: 'mojo',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: false,
      mojoConfig: { cloud: true, env: { PATH: '/tmp/x', LD_PRELOAD: '/tmp/y.so' } },
    });
    expect(reason).toBeDefined();
    expect(reason).toContain('LD_PRELOAD');
    expect(reason).toContain('PATH');
    // Not the generic cloud advice, which would be actively misleading here.
    expect(reason).not.toContain('set mojo.cloud=true');
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

describe('every turn-starting IPC carries the mojo credential snapshot', () => {
  // Per-CHANGE-POINT guard, not per-defect. The original fix had two daemon-side
  // send points plus the worker-side apply, but only the worker side was pinned:
  // commenting out BOTH sends left 378 tests green, so the real production bug
  // ("the raw_input the daemon sends has no credential snapshot") could be
  // reintroduced for free.
  //
  // Round-2 review then showed the guard was NOT exhaustive as its comment
  // claimed: it scanned a hardcoded two-file list, and a third send in
  // workflows/v3/ephemeral-pool.ts proved the point. It now walks src/ recursively,
  // so a new send point anywhere fails here.
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  /**
   * Sends that legitimately cannot carry the snapshot, each with the reason it can
   * never reach a mojo session. Asserted below rather than trusted, so an
   * exemption cannot quietly stop being true.
   */
  const EXEMPT: Record<string, { reason: string; proof: string }> = {
    'src/workflows/v3/ephemeral-pool.ts': {
      reason: 'v3 ephemeral pool hardcodes a PTY worker and has no DaemonSession',
      proof: "backendType: 'pty' as const",
    },
  };

  function sends(ipc: string): Array<{ file: string; line: number; body: string }> {
    const out: Array<{ file: string; line: number; body: string }> = [];
    for (const full of walk(resolve('src'))) {
      const rel = full.slice(resolve('.').length + 1);
      const src = readFileSync(full, 'utf8');
      let from = 0;
      for (;;) {
        // The trailing comma is what distinguishes a SEND (an object literal with
        // more fields) from a type position like
        // `Extract<DaemonToWorker, { type: 'raw_input' }>`, which the first version
        // of this scan reported as two bogus send points in worker.ts.
        const idx = src.indexOf(`type: '${ipc}',`, from);
        if (idx < 0) break;
        from = idx + 1;
        // The union declaration is not a send.
        if (rel === 'src/types.ts') continue;
        const end = src.indexOf('});', idx);
        out.push({
          file: rel,
          line: src.slice(0, idx).split('\n').length,
          body: src.slice(idx, end < 0 ? idx + 600 : end),
        });
      }
    }
    return out;
  }

  it('finds the send points at all (guards the assertions below)', () => {
    // Without this, renaming the IPC would make the loops vacuous and pass.
    expect(sends('raw_input').length).toBeGreaterThanOrEqual(3);
    expect(sends('inject_command').length).toBeGreaterThanOrEqual(1);
  });

  it('every exemption still holds', () => {
    for (const [file, { proof }] of Object.entries(EXEMPT)) {
      expect(readFileSync(resolve(file), 'utf8'), `${file} no longer proves its exemption`)
        .toContain(proof);
    }
  });

  for (const send of sends('raw_input')) {
    const exempt = EXEMPT[send.file];
    it(`raw_input ${send.file}:${send.line} ${exempt ? 'is exempt' : 'attaches the snapshot'}`, () => {
      if (exempt) {
        // Worker-side handlers read the field; only DAEMON-side sends must attach it.
        expect(send.body).not.toContain('mojoLivePatchForSession');
        return;
      }
      expect(send.body).toContain('mojoLivePatchForSession(ds)');
    });
  }

  it('inject_command is refused for remote backends instead of carrying a snapshot', () => {
    // A slash injection is a TUI-only channel, but MojoBackend.write() would turn it
    // into a REAL remote turn on the worker's stale token. Refused at the entry
    // point rather than wired up — so the guard here is the refusal, not a snapshot.
    const src = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
    const idx = src.indexOf("type: 'inject_command',");
    expect(idx).toBeGreaterThan(0);
    // The refusal must sit BEFORE the send, not after it.
    const gate = src.indexOf('remote_backend_inject_unsupported');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(idx);
    expect(src.slice(gate - 400, gate)).toContain('isRemoteBackendType(');
  });
});
