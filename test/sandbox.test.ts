/**
 * sandbox.test.ts
 *
 * Tests for the DIRECT-mode file sandbox module: the relay security boundary
 * (validateRelayRequest / materializeOutboxFile — the sandbox↔host trust
 * boundary, unchanged by the fs-policy refactor) and the platform gate of
 * prepareDirectSandbox. The pure mount-plan logic lives in fs-policy.ts and is
 * covered by fs-policy.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { buildCredentialOnlySandboxArgs, buildRelayHostEnv, validateRelayRequest, materializeOutboxFile, prepareDirectSandbox, coreOnlyPidNamespaceDegrade, bwrapCanUnsharePid, pidNsDualProbeCanUnshare, __testOnly_resetPidNamespaceProbe } from '../src/adapters/backend/sandbox.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sbx-'));

describe('codex-app sandboxExtraExecPaths', () => {
  it('returns exactly the resolved codex bin and never the working dir', () => {
    // pathOverride is absolute → resolveCommand short-circuits (no shell-out / flake).
    const runCodex = '/run/user/1001/fnm_multishells/abc_123/bin/codex';
    const adapter = createCodexAppAdapter(runCodex);
    // build args with a /run working dir — must NOT leak into the exec-path list.
    adapter.buildArgs({ sessionId: 's1', resume: false, workingDir: '/run/user/1001/proj' });
    const extra = adapter.sandboxExtraExecPaths?.();
    expect(extra).toEqual([runCodex]);
    expect(extra).not.toContain('/run/user/1001/proj');
  });
});

describe('prepareDirectSandbox platform gate', () => {
  it('returns null off-linux (worker treats null as a hard error, never silent-unsandboxed)', () => {
    if (process.platform === 'linux') return; // gate only observable off-linux
    const r = prepareDirectSandbox({
      sessionId: 's1', dataDir: tmp(),
      policy: { rules: [], net: true, writeRegexes: [] },
      chdir: '/x', home: '/home/u', cliBin: '/usr/bin/true', cliArgs: [],
    });
    expect(r).toBeNull();
  });
});

describe('credential-only managed-origin carve-out', () => {
  it('hides the shared parent before exposing only the owning rotating directory', () => {
    const parent = '/srv/botmux/data/read-isolation';
    const own = `${parent}/origin-${'a'.repeat(64)}`;
    const args = buildCredentialOnlySandboxArgs({
      hideDirectories: ['/srv/botmux/device-authority'],
      hideFiles: ['/srv/botmux/.dashboard-secret'],
      privateReadonlyDirectories: [{ parent, directory: own }],
      workingDir: '/workspace',
      cliBin: '/usr/bin/true',
      cliArgs: [],
    });
    const hideParentAt = args.findIndex((value, index) => value === '--tmpfs'
      && args[index + 1] === parent);
    const exposeOwnAt = args.findIndex((value, index) => value === '--ro-bind'
      && args[index + 1] === own && args[index + 2] === own);
    expect(hideParentAt).toBeGreaterThan(-1);
    expect(exposeOwnAt).toBe(hideParentAt + 2);
    expect(args).not.toContain(`${parent}/origin-${'b'.repeat(64)}`);
  });

  it('rejects a private directory outside the hidden parent', () => {
    expect(() => buildCredentialOnlySandboxArgs({
      hideDirectories: ['/srv/botmux/device-authority'],
      hideFiles: [],
      privateReadonlyDirectories: [{
        parent: '/srv/botmux/data/read-isolation',
        directory: '/srv/other/origin',
      }],
      workingDir: '/workspace',
      cliBin: '/usr/bin/true',
      cliArgs: [],
    })).toThrow(/must be below/);
  });
});

// The pid-namespace degrade (drop --unshare-pid for a nested sandbox that can't
// mount /proc in a new pid ns) MUST be gated to core-only. On a normal/mixed
// fleet a sibling transport bot's worker carries LARK_APP_SECRET in its env, so
// dropping pid isolation would expose it via /proc/<pid>/environ. The gate is
// BOTMUX_CORE_ONLY=1 && !bwrapCanUnsharePid() — and BOTMUX_CORE_ONLY short-
// circuits FIRST, so the normal fleet never even runs the probe, never degrades.
describe('coreOnlyPidNamespaceDegrade gate (credential-safety)', () => {
  it('is FALSE without BOTMUX_CORE_ONLY, regardless of host pid-ns support (normal fleet keeps --unshare-pid)', () => {
    const prev = process.env.BOTMUX_CORE_ONLY;
    delete process.env.BOTMUX_CORE_ONLY;
    __testOnly_resetPidNamespaceProbe();
    try {
      expect(coreOnlyPidNamespaceDegrade()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_CORE_ONLY;
      else process.env.BOTMUX_CORE_ONLY = prev;
      __testOnly_resetPidNamespaceProbe();
    }
  });

  it('under BOTMUX_CORE_ONLY, tracks the host probe: degrade IFF the host cannot unshare-pid', () => {
    const prev = process.env.BOTMUX_CORE_ONLY;
    process.env.BOTMUX_CORE_ONLY = '1';
    __testOnly_resetPidNamespaceProbe();
    try {
      // On this (non-nested) host the probe should succeed → NO degrade. In a
      // nested sandbox the same call returns true. We assert the invariant that
      // degrade === (core-only AND probe-says-cant): here core-only is on, so
      // the result must be the negation of the raw probe.
      const canUnshare = bwrapCanUnsharePid();
      expect(coreOnlyPidNamespaceDegrade()).toBe(!canUnshare);
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_CORE_ONLY;
      else process.env.BOTMUX_CORE_ONLY = prev;
      __testOnly_resetPidNamespaceProbe();
    }
  });

  // codex review concern #2 (P1): a naive probe treats ANY bwrap failure as
  // "safe to drop --unshare-pid". Three-state classification (success /
  // clean-nonzero / inconclusive) is load-bearing — a timeout/spawn-error must
  // NOT be lumped with a clean nonzero exit. Degrade ONLY on the exact nested
  // signature: full=clean-nonzero (bwrap definitively rejected the pid-ns run)
  // AND weak=success (accepted it without pid-ns). Everything else fail-closed.
  describe('pidNsDualProbeCanUnshare (three-state, fail-closed)', () => {
    it('full success → CAN unshare-pid (no degrade), regardless of weak', () => {
      expect(pidNsDualProbeCanUnshare('success', 'success')).toBe(true);
      expect(pidNsDualProbeCanUnshare('success', 'clean-nonzero')).toBe(true);
      expect(pidNsDualProbeCanUnshare('success', 'inconclusive')).toBe(true);
    });
    it('full clean-nonzero + weak success → nested signature → CANNOT unshare-pid (the ONLY degrade case)', () => {
      expect(pidNsDualProbeCanUnshare('clean-nonzero', 'success')).toBe(false);
    });
    it('BOTH clean-nonzero (fake bwrap always exits 1 — codex repro) → bwrap broken, NOT pid-ns → CAN unshare-pid (fail-closed)', () => {
      expect(pidNsDualProbeCanUnshare('clean-nonzero', 'clean-nonzero')).toBe(true);
    });
    it('full INCONCLUSIVE (timeout / spawn-error / signal) + weak success → NOT evidence of pid-ns restriction → CAN unshare-pid (the timeout case codex flagged)', () => {
      expect(pidNsDualProbeCanUnshare('inconclusive', 'success')).toBe(true);
      expect(pidNsDualProbeCanUnshare('inconclusive', 'clean-nonzero')).toBe(true);
      expect(pidNsDualProbeCanUnshare('inconclusive', 'inconclusive')).toBe(true);
    });
    it('full clean-nonzero + weak NOT clean-success (nonzero/inconclusive) → do NOT degrade', () => {
      expect(pidNsDualProbeCanUnshare('clean-nonzero', 'clean-nonzero')).toBe(true);
      expect(pidNsDualProbeCanUnshare('clean-nonzero', 'inconclusive')).toBe(true);
    });
  });
});

// Regression for the symlinked-$HOME execvp bug: the worker hands the sandbox a
// LEXICAL cli bin (e.g. ~/.local/bin/claude → /home/u/.local/bin/claude on a
// /home/u → /data00/home/u shared-drive host), but the sandbox only binds
// CANONICAL exec dirs. bwrap's execvp then can't resolve the lexical /home/u
// prefix (absent in the fresh root) and the CLI dies instantly (pane gone →
// tmux pipe-pane fails). prepareDirectSandbox must realpath the bin so the exec
// target lands on a bound path.
describe('prepareDirectSandbox canonicalizes the exec bin (symlinked-$HOME)', () => {
  it('replaces a symlinked cli bin path with its realpath in the bwrap argv', () => {
    if (process.platform !== 'linux') return; // bwrap path only built on linux
    const dir = mkdtempSync(join(tmpdir(), 'sbx-binlink-'));
    // Real target + a symlink pointing at it (models ~/.local/bin/claude → …/claude.exe).
    const realBin = join(dir, 'real-cli');
    writeFileSync(realBin, '#!/bin/sh\ntrue\n', { mode: 0o755 });
    const linkBin = join(dir, 'linked-cli');
    symlinkSync(realBin, linkBin);
    const r = prepareDirectSandbox({
      sessionId: 'binlink', dataDir: tmp(),
      policy: { rules: [], net: true, writeRegexes: [] },
      chdir: dir, home: dir, cliBin: linkBin, cliArgs: ['--v'],
    });
    // Off-CI without bwrap installed prepareDirectSandbox returns null (dep gate);
    // only assert the canonicalization when it actually produced a plan.
    if (!r) return;
    const dashDash = r.args.lastIndexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    const execTarget = r.args[dashDash + 1];
    expect(execTarget).toBe(realpathSync(linkBin)); // canonical, not the lexical symlink
    expect(execTarget).not.toBe(linkBin);
    expect(r.args.slice(dashDash + 2)).toEqual(['--v']); // cliArgs preserved verbatim
    r.cleanup();
  });
});


// ── validateRelayRequest: pure schema + flag-allowlist boundary (UNCHANGED) ──
// Regression for the "sandbox makes host read an arbitrary path" confused-deputy
// blocker: only plain outbox basenames + allowlisted flags pass; raw argv /
// path flags / sandbox-chosen session-id are rejected.
describe('validateRelayRequest', () => {
  it('forces host-relayed cards to use probe-free lexical link repair', () => {
    expect(buildRelayHostEnv({
      BOTMUX_SEND_RELAY: '/sandbox/outbox',
      BOTMUX_CARD_LOCAL_LINK_MODE: 'filesystem',
      KEEP_ME: 'yes',
    })).toMatchObject({
      BOTMUX_CARD_LOCAL_LINK_MODE: 'lexical',
      KEEP_ME: 'yes',
    });
    expect(buildRelayHostEnv({ BOTMUX_SEND_RELAY: '/sandbox/outbox' }))
      .not.toHaveProperty('BOTMUX_SEND_RELAY');

    expect(buildRelayHostEnv({}, '/private/staging/prepared.md')).toMatchObject({
      BOTMUX_CARD_LOCAL_LINK_MODE: 'disabled',
      BOTMUX_CARD_PREPARED_CONTENT_FILE: '/private/staging/prepared.md',
    });
  });

  it('accepts plain basenames + allowlisted presentation flags', () => {
    const r = validateRelayRequest({
      contentFile: 'c.content',
      preparedContentFile: 'c.card-content',
      attachments: ['a.png'],
      videos: ['replay.mp4'],
      videoCovers: ['cover.png'],
      flags: ['--mention-back', '--mention', 'ou:X', '--voice'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentName).toBe('c.content');
    expect(r.value.preparedContentName).toBe('c.card-content');
    expect(r.value.attachmentNames).toEqual(['a.png']);
    expect(r.value.videoNames).toEqual(['replay.mp4']);
    expect(r.value.videoCoverNames).toEqual(['cover.png']);
    expect(r.value.flags).toEqual(['--mention-back', '--mention', 'ou:X', '--voice']);
  });

  it('allows only validated response kinds through the sandbox relay', () => {
    expect(validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--response-kind', 'final', '--no-mention'],
    })).toMatchObject({
      ok: true,
      value: { flags: ['--response-kind', 'final', '--no-mention'] },
    });
    expect(validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--response-kind', 'auxiliary'],
    })).toMatchObject({
      ok: true,
      value: { flags: ['--response-kind', 'auxiliary'] },
    });
    expect(validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--response-kind', 'draft'],
    })).toMatchObject({ ok: false, error: 'flag --response-kind must be progress, final, or auxiliary' });
  });

  it('allows only canonical reply layouts through the sandbox relay', () => {
    for (const layout of ['result', 'progress', 'risk', 'blocked', 'handoff']) {
      expect(validateRelayRequest({
        contentFile: 'c.content',
        flags: ['--layout', layout, '--no-mention'],
      })).toMatchObject({
        ok: true,
        value: { flags: ['--layout', layout, '--no-mention'] },
      });
    }
    for (const layout of ['diff', 'compare', 'green', '']) {
      expect(validateRelayRequest({
        contentFile: 'c.content',
        flags: ['--layout', layout],
      })).toMatchObject({
        ok: false,
        error: 'flag --layout must be result, progress, risk, blocked, or handoff',
      });
    }
  });

  it('accepts a custom card file as a plain outbox basename', () => {
    const r = validateRelayRequest({
      contentFile: 'c.content',
      cardFile: 'card.json',
      flags: ['--no-mention'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentName).toBe('c.content');
    expect(r.value.cardName).toBe('card.json');
    expect(r.value.flags).toEqual(['--no-mention']);
  });

  it('validates and preserves a frozen relay origin', () => {
    const r = validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--no-mention'],
      originTurnId: 'delivery-key',
      originDispatchAttempt: 3,
    });
    expect(r).toMatchObject({
      ok: true,
      value: { originTurnId: 'delivery-key', originDispatchAttempt: 3 },
    });
    expect(validateRelayRequest({
      contentFile: 'c.content', originDispatchAttempt: 1,
    })).toMatchObject({ ok: false });
    expect(validateRelayRequest({
      contentFile: 'c.content', originTurnId: 'delivery-key', originDispatchAttempt: 0,
    })).toMatchObject({ ok: false });
  });

  it('rejects the raw-hostArgs exploit (path-bearing flag not allowlisted)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--content-file', '/root/.botmux/bots.json'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--files', '/root/.ssh/id_rsa'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--card-file', '/root/.botmux/card.json'] }).ok).toBe(false);
  });

  it('rejects a sandbox-supplied --session-id (cannot target another session)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--session-id', 'other'] }).ok).toBe(false);
  });

  it('rejects sandbox-supplied --attention (receiver cannot emit an unledgered daemon hook)', () => {
    expect(validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--attention'],
    })).toMatchObject({ ok: false, error: 'flag not allowed: --attention' });
  });

  it('rejects a value-taking flag whose value is itself a flag (--mention --session-id desync)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--mention', '--session-id'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--quote', '--mention'] }).ok).toBe(false);
  });

  it('rejects non-basename content / attachment names (../ traversal)', () => {
    expect(validateRelayRequest({ contentFile: '../../etc/passwd' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', preparedContentFile: '../prepared' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', attachments: ['../secret'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', cardFile: '../card.json' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', videos: ['../secret.mp4'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', videoCovers: ['../cover.png'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'a/b' }).ok).toBe(false);
    expect(validateRelayRequest({ /* missing contentFile */ flags: [] }).ok).toBe(false);
  });
});

// ── materializeOutboxFile: TOCTOU-safe read of an outbox file (UNCHANGED) ────
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
    symlinkSync(secret, join(outbox, 'c.content'));
    const dest = join(stage, 'out');
    expect(materializeOutboxFile(outbox, 'c.content', dest)).toBe(false);  // O_NOFOLLOW rejects
    expect(existsSync(dest)).toBe(false);  // nothing materialized → nothing to exfil
  });

  it('refuses a missing or non-regular file', () => {
    const outbox = tmp(); const stage = tmp();
    expect(materializeOutboxFile(outbox, 'nope', join(stage, 'o'))).toBe(false);
  });

  it('does NOT hang on a FIFO and rejects it (O_NONBLOCK + fstat-reject)', () => {
    // Regression: a malicious agent drops a FIFO into the rw-bound outbox; without
    // O_NONBLOCK the synchronous openSync blocks forever (no writer), freezing the
    // worker event loop. With O_NONBLOCK the open returns immediately and the
    // fstat reject (isFile() false) refuses it — no hang, no materialization.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const outbox = tmp(); const stage = tmp();
    try { execFileSync('mkfifo', [join(outbox, 'evil')], { stdio: 'ignore' }); }
    catch { return; } // mkfifo unavailable in this env — skip
    const dest = join(stage, 'o');
    const start = Date.now();
    const r = materializeOutboxFile(outbox, 'evil', dest);
    const elapsed = Date.now() - start;
    expect(r).toBe(false);            // rejected (not a regular file)
    expect(existsSync(dest)).toBe(false);
    expect(elapsed).toBeLessThan(2000); // returned immediately, did NOT block
  });
});
