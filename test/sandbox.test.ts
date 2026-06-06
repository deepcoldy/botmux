/**
 * sandbox.test.ts
 *
 * Pure-logic tests for the file-isolation sandbox (bubblewrap) arg builder and
 * the per-CLI config-scoping helper. No bwrap/network — just the argv shape and
 * the scrub contract.
 */
import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { buildSandboxArgs, seedScopedConfig, validateRelayRequest, materializeOutboxFile, prepareSandbox, type SandboxPlan } from '../src/adapters/backend/sandbox.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sbx-'));

function plan(over: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    workDir: '/data/sandboxes/s1/work',
    projectMount: '/home/u/proj',
    scopedHome: '/data/sandboxes/s1/home',
    outbox: '/data/sandboxes/s1/outbox',
    toolchainRo: ['/opt/node'],
    net: true,
    ...over,
  };
}

/** Find the value bwrap would mount at `dest` for a given bind flag. */
function bindDest(args: string[], flag: string, src: string): string | undefined {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === src) return args[i + 2];
  }
  return undefined;
}

describe('buildSandboxArgs', () => {
  it('masks the real home with the scoped home', () => {
    const a = buildSandboxArgs(plan());
    expect(bindDest(a, '--bind', '/data/sandboxes/s1/home')).toBe(homedir());
  });

  it('mounts the clone AT projectMount (not at its own host path)', () => {
    const a = buildSandboxArgs(plan());
    // clone host path → projectMount
    expect(bindDest(a, '--bind', '/data/sandboxes/s1/work')).toBe('/home/u/proj');
    // and chdir is the mount target, so the CLI's -C/cwd args resolve
    const ci = a.indexOf('--chdir');
    expect(a[ci + 1]).toBe('/home/u/proj');
  });

  it('binds the outbox at its own path and re-exposes toolchain read-only', () => {
    const a = buildSandboxArgs(plan());
    expect(bindDest(a, '--bind', '/data/sandboxes/s1/outbox')).toBe('/data/sandboxes/s1/outbox');
    expect(bindDest(a, '--ro-bind-try', '/opt/node')).toBe('/opt/node');
  });

  it('keeps the network by default and drops it when net=false', () => {
    expect(buildSandboxArgs(plan({ net: true }))).not.toContain('--unshare-net');
    expect(buildSandboxArgs(plan({ net: false }))).toContain('--unshare-net');
  });

  it('always isolates user/pid/ipc namespaces', () => {
    const a = buildSandboxArgs(plan());
    for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc']) {
      expect(a).toContain(flag);
    }
  });
});

describe('seedScopedConfig', () => {
  it('returns false for a CLI with no persistent config', () => {
    const home = mkdtempSync(join(tmpdir(), 'sbx-'));
    expect(seedScopedConfig('hermes', home)).toBe(false);
  });

  it('creates the scoped config dir for a known CLI (codex)', () => {
    const home = mkdtempSync(join(tmpdir(), 'sbx-'));
    expect(seedScopedConfig('codex', home)).toBe(true);
    // The de-identified ~/.codex is materialised even if the host has nothing to copy.
    expect(existsSync(join(home, '.codex'))).toBe(true);
  });
});

// ── validateRelayRequest: pure schema + flag-allowlist boundary ─────────────
// Regression for the "sandbox makes host read an arbitrary path" confused-deputy
// blocker: only plain outbox basenames + allowlisted flags pass; raw argv /
// path flags / sandbox-chosen session-id are rejected.
describe('validateRelayRequest', () => {
  it('accepts plain basenames + allowlisted presentation flags', () => {
    const r = validateRelayRequest({ contentFile: 'c.content', attachments: ['a.png'], flags: ['--mention-back', '--mention', 'ou:X', '--voice'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentName).toBe('c.content');
    expect(r.value.attachmentNames).toEqual(['a.png']);
    expect(r.value.flags).toEqual(['--mention-back', '--mention', 'ou:X', '--voice']);
  });

  it('rejects the raw-hostArgs exploit (path-bearing flag not allowlisted)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--content-file', '/root/.botmux/bots.json'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--files', '/root/.ssh/id_rsa'] }).ok).toBe(false);
  });

  it('rejects a sandbox-supplied --session-id (cannot target another session)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--session-id', 'other'] }).ok).toBe(false);
  });

  it('rejects non-basename content / attachment names (../ traversal)', () => {
    expect(validateRelayRequest({ contentFile: '../../etc/passwd' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', attachments: ['../secret'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'a/b' }).ok).toBe(false);
    expect(validateRelayRequest({ /* missing contentFile */ flags: [] }).ok).toBe(false);
  });
});

// ── materializeOutboxFile: TOCTOU-safe read of an outbox file ───────────────
// Regression for the post-validation symlink-swap (TOCTOU): the read itself
// refuses symlinks (O_NOFOLLOW) and reads from the fd, so a swap can't redirect
// it to a host file. There is no separate check-then-use window any more.
describe('materializeOutboxFile (TOCTOU)', () => {
  it('copies a regular outbox file into the private dest', () => {
    const outbox = tmp(); const stage = tmp();
    writeFileSync(join(outbox, 'c.content'), 'hello');
    const dest = join(stage, 'out');
    expect(materializeOutboxFile(outbox, 'c.content', dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('hello');
  });

  it('refuses a symlink swapped into the outbox pointing at a host file (no exfil)', () => {
    const outbox = tmp(); const stage = tmp(); const secretDir = tmp();
    const secret = join(secretDir, 'bots.json');
    writeFileSync(secret, 'SECRET_FROM_HOST');
    // simulate the sandbox swapping the validated name for a symlink-to-secret
    symlinkSync(secret, join(outbox, 'c.content'));
    const dest = join(stage, 'out');
    expect(materializeOutboxFile(outbox, 'c.content', dest)).toBe(false);  // O_NOFOLLOW rejects
    expect(existsSync(dest)).toBe(false);  // nothing materialized → nothing to exfil
  });

  it('refuses a missing or non-regular file', () => {
    const outbox = tmp(); const stage = tmp();
    expect(materializeOutboxFile(outbox, 'nope', join(stage, 'o'))).toBe(false);
    rmSync(join(stage, 'sub'), { recursive: true, force: true });
  });
});

// ── prepareSandbox: the per-bot toggle must actually engage bwrap ────────────
// Regression for the "dashboard sandbox:true never triggers bwrap" blocker:
// prepareSandbox must honor the explicit `enabled` flag, NOT the env var.
describe('prepareSandbox enabled gate', () => {
  it('returns null when not enabled (regardless of env)', () => {
    const r = prepareSandbox({
      enabled: false, cliId: 'codex', sessionId: 's', sourceWorkingDir: tmp(),
      dataDir: tmp(), cliBin: '/bin/true', cliArgs: [],
    });
    expect(r).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('engages bwrap when enabled=true without BOTMUX_SANDBOX env', () => {
    const src = tmp();
    writeFileSync(join(src, 'file.txt'), 'x');  // a non-git project copied via cp
    const prev = process.env.BOTMUX_SANDBOX;
    delete process.env.BOTMUX_SANDBOX;  // prove env is NOT what enables it
    try {
      const r = prepareSandbox({
        enabled: true, cliId: 'codex', sessionId: 'pb', sourceWorkingDir: src,
        dataDir: tmp(), cliBin: '/bin/true', cliArgs: [],
      });
      expect(r).not.toBeNull();
      expect(r!.bin).toBe('bwrap');
      expect(r!.args).toContain('--');
    } finally {
      if (prev !== undefined) process.env.BOTMUX_SANDBOX = prev;
    }
  });
});
