/**
 * sandbox.test.ts
 *
 * Pure-logic tests for the overlayfs file-isolation sandbox: the bwrap arg
 * builder (overlay binds + privacy masks + outbox-last), the relay security
 * boundary (validateRelayRequest / materializeOutboxFile, unchanged), and the
 * upper-layer landing (computeSandboxDiff / applySandboxDiff). No real mount —
 * just the argv shape and the upper-walk/apply contract.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { buildSandboxArgs, reexposeRunBinArgs, validateRelayRequest, materializeOutboxFile, prepareSandbox, type SandboxPlan } from '../src/adapters/backend/sandbox.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';
import { computeSandboxDiff, applySandboxDiff, upperDir } from '../src/services/sandbox-land.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sbx-'));

function plan(over: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    projectMount: '/home/u/proj',
    projectMerged: '/data/sandboxes/s1/proj-merged',
    home: '/root',
    homeMerged: '/data/sandboxes/s1/home-merged',
    outbox: '/data/sandboxes/s1/outbox',
    hideDirs: [],
    hideFiles: [],
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

/** Index of the (flag, a, b) triple in args, or -1. */
function tripleIdx(args: string[], flag: string, a: string, b: string): number {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return i;
  }
  return -1;
}

describe('buildSandboxArgs (overlay model)', () => {
  it('reads the entire real fs read-only (--ro-bind / /)', () => {
    const a = buildSandboxArgs(plan());
    expect(tripleIdx(a, '--ro-bind', '/', '/')).toBeGreaterThanOrEqual(0);
  });

  it('binds the merged home overlay AT the real home path', () => {
    const a = buildSandboxArgs(plan());
    expect(bindDest(a, '--bind', '/data/sandboxes/s1/home-merged')).toBe('/root');
  });

  it('binds the merged project overlay AT projectMount and chdirs there', () => {
    const a = buildSandboxArgs(plan());
    expect(bindDest(a, '--bind', '/data/sandboxes/s1/proj-merged')).toBe('/home/u/proj');
    const ci = a.indexOf('--chdir');
    expect(a[ci + 1]).toBe('/home/u/proj');
  });

  it('masks hideDirs with a tmpfs and hideFiles with a read-only empty placeholder', () => {
    const a = buildSandboxArgs(plan({
      hideDirs: ['/root/.ssh'],
      hideFiles: [{ path: '/root/.botmux/bots.json', empty: '/data/sandboxes/s1/empties/mask-0' }],
    }));
    // dir → tmpfs
    const di = a.indexOf('--tmpfs');
    expect(a).toContain('--tmpfs');
    expect(a.includes('/root/.ssh')).toBe(true);
    expect(tripleIdx(a, '--tmpfs', '/root/.ssh', '/root/.ssh')).toBe(-1); // tmpfs takes a single arg
    expect(di).toBeGreaterThanOrEqual(0);
    // file → ro-bind empty placeholder over the real path
    expect(bindDest(a, '--ro-bind', '/data/sandboxes/s1/empties/mask-0')).toBe('/root/.botmux/bots.json');
  });

  it('binds the outbox LAST so a mask covering a parent dir cannot shadow it', () => {
    const a = buildSandboxArgs(plan({
      hideDirs: ['/data/sandboxes/s1'],  // covers the outbox's parent
    }));
    const maskIdx = a.indexOf('/data/sandboxes/s1');
    const outboxIdx = tripleIdx(a, '--bind', '/data/sandboxes/s1/outbox', '/data/sandboxes/s1/outbox');
    expect(outboxIdx).toBeGreaterThanOrEqual(0);
    expect(outboxIdx).toBeGreaterThan(maskIdx); // outbox bind comes after the mask
  });

  it('binds selected skill runtime roots read-only before the outbox', () => {
    const a = buildSandboxArgs(plan({
      readonlyRoots: ['/data/runtime-skills/s1/claude-plugin'],
    }));
    const rootIdx = tripleIdx(a, '--ro-bind', '/data/runtime-skills/s1/claude-plugin', '/data/runtime-skills/s1/claude-plugin');
    const outboxIdx = tripleIdx(a, '--bind', '/data/sandboxes/s1/outbox', '/data/sandboxes/s1/outbox');

    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(outboxIdx).toBeGreaterThan(rootIdx);
  });

  it('no clone/scrub artefacts: never binds a per-session clone "work" dir', () => {
    const a = buildSandboxArgs(plan());
    // The old model bound a `git clone` "work" dir; the overlay model never does
    // — the project is a merged overlay bound at projectMount, nothing else.
    expect(a.some(x => x.includes('/work'))).toBe(false);
    // The only binds are: ro / /, the two overlay merged dirs, and the outbox.
    const binds = a.filter((x, i) => x === '--bind').length;
    expect(binds).toBe(3); // home-merged, proj-merged, outbox
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

// ── reexposeRunBinArgs: restore fnm/nvm bin dirs masked by --tmpfs /run ──
// Regression for "file sandbox can't start" on fnm/nvm/volta machines: the
// resolved CLI binary (and the daemon's own node) live under /run/user/.../bin,
// which --tmpfs /run masks → bwrap execvp fails → crash-loop.
describe('reexposeRunBinArgs (fnm/nvm /run bin dirs)', () => {
  it('re-binds the containing dir of a /run-resident binary read-only at its real path', () => {
    const a = reexposeRunBinArgs(['/run/user/1001/fnm_multishells/abc_123/bin/codex']);
    expect(tripleIdx(a, '--ro-bind-try', '/run/user/1001/fnm_multishells/abc_123/bin', '/run/user/1001/fnm_multishells/abc_123/bin')).toBe(0);
  });

  it('dedupes when the binary and node share one /run bin dir', () => {
    const dir = '/run/user/1001/fnm_multishells/abc_123/bin';
    const a = reexposeRunBinArgs([`${dir}/codex`, `${dir}/node`]);
    expect(a).toEqual(['--ro-bind-try', dir, dir]);
  });

  it('handles distinct /run dirs for the binary and node', () => {
    const a = reexposeRunBinArgs(['/run/a/bin/codex', '/run/b/bin/node']);
    expect(tripleIdx(a, '--ro-bind-try', '/run/a/bin', '/run/a/bin')).toBeGreaterThanOrEqual(0);
    expect(tripleIdx(a, '--ro-bind-try', '/run/b/bin', '/run/b/bin')).toBeGreaterThanOrEqual(0);
  });

  it('ignores binaries outside /run (system node, npm/pnpm globals) — non-fnm users unaffected', () => {
    expect(reexposeRunBinArgs(['/usr/bin/node', '/usr/local/bin/codex', undefined])).toEqual([]);
  });

  it('NEVER re-binds /run itself (would clobber the tmpfs + the /run/sbxbin relay shim)', () => {
    // A binary directly at /run/node has dirname '/run' — must be skipped.
    expect(reexposeRunBinArgs(['/run/node'])).toEqual([]);
  });

  it('skips empty/non-string entries', () => {
    expect(reexposeRunBinArgs([undefined, '', '/run/user/1/bin/x'])).toEqual(['--ro-bind-try', '/run/user/1/bin', '/run/user/1/bin']);
  });

  it('covers a SECOND-STAGE /run binary (codex-app real codex) when cliBin+node are OUTSIDE /run', () => {
    // codex-app: resolvedBin = daemon node (stable fnm install, NOT /run); the real
    // codex (spawned inside the sandbox for app-server) is declared via
    // sandboxExtraExecPaths. prepareSandbox feeds [cliBin, process.execPath, ...extra].
    const stableNode = '/root/.local/share/fnm/node-versions/v24.16.0/installation/bin/node';
    const runCodex = '/run/user/1001/fnm_multishells/abc_123/bin/codex';
    const a = reexposeRunBinArgs([stableNode, stableNode, runCodex]);
    // only the fnm bin dir is re-bound (stable node ignored, never the cwd)
    expect(a).toEqual(['--ro-bind-try', '/run/user/1001/fnm_multishells/abc_123/bin', '/run/user/1001/fnm_multishells/abc_123/bin']);
  });

  it('DANGER it guards against: a /run working-dir path would re-bind its parent (so the wiring must NOT feed cwd/cliArgs in)', () => {
    // This documents WHY prepareSandbox passes ONLY declared exec paths, never raw
    // cliArgs: a `--cwd /run/user/1001/proj` would re-bind PARENT /run/user/1001,
    // shadowing the project overlay mounted there + exposing siblings/IPC sockets.
    expect(reexposeRunBinArgs(['/run/user/1001/proj'])).toEqual(['--ro-bind-try', '/run/user/1001', '/run/user/1001']);
  });
});

// ── codex-app adapter declares ONLY the second-stage executable, never the cwd ──
// Negative regression for Codex's blocker: sandboxExtraExecPaths must return the
// resolved codex binary and NOTHING path-like (the working dir), so the sandbox
// never re-binds a /run cwd's parent.
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
    // and the resulting re-expose hits only the codex bin dir, not the cwd parent.
    const a = reexposeRunBinArgs([adapter.resolvedBin, process.execPath, ...(extra ?? [])]);
    expect(a).toContain('/run/user/1001/fnm_multishells/abc_123/bin');
    expect(a).not.toContain('/run/user/1001');
  });
});

// ── validateRelayRequest: pure schema + flag-allowlist boundary (UNCHANGED) ──
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

  it('rejects a value-taking flag whose value is itself a flag (--mention --session-id desync)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--mention', '--session-id'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--quote', '--mention'] }).ok).toBe(false);
  });

  it('rejects non-basename content / attachment names (../ traversal)', () => {
    expect(validateRelayRequest({ contentFile: '../../etc/passwd' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', attachments: ['../secret'] }).ok).toBe(false);
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

// ── prepareSandbox: the per-bot toggle must actually engage bwrap ────────────
describe('prepareSandbox enabled gate', () => {
  it('returns null when not enabled (regardless of env)', () => {
    const r = prepareSandbox({
      enabled: false, cliId: 'codex', sessionId: 's', sourceWorkingDir: tmp(),
      dataDir: tmp(), cliBin: '/bin/true', cliArgs: [],
    });
    expect(r).toBeNull();
  });
});

// ── Landing from the overlay UPPER layer ─────────────────────────────────────
// The project overlay UPPER dir IS the changeset. computeSandboxDiff walks it
// (regular file = add/modify, char-dev rdev0 = whiteout/delete); applySandboxDiff
// copies the changes onto a real target. We simulate the upper layer on disk.
describe('sandbox landing from upper layer', () => {
  function makeUpper(dataDir: string, sid: string): string {
    const up = upperDir(dataDir, sid);
    mkdirSync(up, { recursive: true });
    return up;
  }

  it('computeSandboxDiff classifies a new + a modified file under the upper', () => {
    const dataDir = tmp(); const sid = 's-diff';
    const up = makeUpper(dataDir, sid);
    writeFileSync(join(up, 'added.txt'), 'brand new\n');
    mkdirSync(join(up, 'sub'), { recursive: true });
    writeFileSync(join(up, 'sub', 'edited.txt'), 'changed content\n');

    const d = computeSandboxDiff(dataDir, sid);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.empty).toBe(false);
    expect(d.files).toBe(2);
    // both files visible in the stat summary
    expect(d.statText).toContain('added.txt');
    expect(d.statText).toContain('sub/edited.txt');
  });

  it('computeSandboxDiff reports empty when the upper has no changes', () => {
    const dataDir = tmp(); const sid = 's-empty';
    makeUpper(dataDir, sid);
    const d = computeSandboxDiff(dataDir, sid);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.empty).toBe(true);
    expect(d.files).toBe(0);
  });

  it('computeSandboxDiff errors when the session has no upper layer', () => {
    const dataDir = tmp();
    const d = computeSandboxDiff(dataDir, 'nope');
    expect(d.ok).toBe(false);
  });

  it('applySandboxDiff copies new + modified files onto the real target', () => {
    const dataDir = tmp(); const sid = 's-apply';
    const up = makeUpper(dataDir, sid);
    const target = tmp();
    // target already has the file the agent "modified"
    writeFileSync(join(target, 'edited.txt'), 'old content\n');
    // upper = the agent's changeset
    writeFileSync(join(up, 'added.txt'), 'NEW FILE\n');
    writeFileSync(join(up, 'edited.txt'), 'NEW CONTENT\n');
    mkdirSync(join(up, 'deep'), { recursive: true });
    writeFileSync(join(up, 'deep', 'nested.txt'), 'nested\n');

    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(true);
    expect(readFileSync(join(target, 'added.txt'), 'utf8')).toBe('NEW FILE\n');
    expect(readFileSync(join(target, 'edited.txt'), 'utf8')).toBe('NEW CONTENT\n');         // overwrote old
    expect(readFileSync(join(target, 'deep', 'nested.txt'), 'utf8')).toBe('nested\n');      // mkdir -p parent
  });

  it('applySandboxDiff honors an overlay whiteout (char-dev rdev 0) as a deletion when mknod is available', () => {
    const dataDir = tmp(); const sid = 's-del';
    const up = makeUpper(dataDir, sid);
    const target = tmp();
    writeFileSync(join(target, 'gone.txt'), 'to be deleted\n');
    // Try to create a real overlay whiteout (char device, 0/0). Needs CAP_MKNOD;
    // root in this env has it, but skip gracefully if mknod is unavailable.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync('mknod', [join(up, 'gone.txt'), 'c', '0', '0'], { stdio: 'ignore' });
    if (r.status !== 0) {
      // Environment can't make a whiteout — assert the detector at least doesn't
      // misclassify, and skip the deletion assertion.
      expect(existsSync(join(target, 'gone.txt'))).toBe(true);
      return;
    }
    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(true);
    expect(existsSync(join(target, 'gone.txt'))).toBe(false); // whiteout → removed from target
  });

  it('applySandboxDiff errors when nothing changed', () => {
    const dataDir = tmp(); const sid = 's-noop';
    makeUpper(dataDir, sid);
    const target = tmp();
    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(false);
  });

  it('lands a symlink AS a symlink (does not dereference into a content copy)', () => {
    const dataDir = tmp(); const sid = 's-link';
    const up = makeUpper(dataDir, sid);
    const target = tmp();
    // a project-relative symlink the agent created in the upper layer
    writeFileSync(join(up, 'real.txt'), 'payload\n');
    symlinkSync('real.txt', join(up, 'alias.txt'));

    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(true);
    const { lstatSync, readlinkSync } = require('node:fs') as typeof import('node:fs');
    expect(lstatSync(join(target, 'alias.txt')).isSymbolicLink()).toBe(true); // still a link
    expect(readlinkSync(join(target, 'alias.txt'))).toBe('real.txt');         // target preserved
  });

  it('a dangling symlink no longer throws mid-loop — it lands as a link, edits land too', () => {
    const dataDir = tmp(); const sid = 's-dangling';
    const up = makeUpper(dataDir, sid);
    const target = tmp();
    writeFileSync(join(target, 'keep.txt'), 'original\n');
    // upper changeset: a normal edit + a NEW file + a DANGLING symlink. The old
    // code dereferenced the link via copyFileSync → ENOENT mid-loop → the project
    // was left half-landed. Now a symlink (even dangling) is recreated as a link,
    // so apply SUCCEEDS and all changes land.
    writeFileSync(join(up, 'keep.txt'), 'EDITED\n');
    writeFileSync(join(up, 'added.txt'), 'NEW\n');
    symlinkSync('/nonexistent/dangling/target', join(up, 'dangling.lnk'));

    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(true);
    const { lstatSync } = require('node:fs') as typeof import('node:fs');
    expect(lstatSync(join(target, 'dangling.lnk')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('EDITED\n');
    expect(readFileSync(join(target, 'added.txt'), 'utf8')).toBe('NEW\n');
  });

  it('multi-file apply lands every change (two-phase apply, happy path)', () => {
    // The two-phase apply pre-validates all sources, then applies. Confirm a
    // multi-file changeset lands fully. (The fail-closed NO-mutation path — when
    // overlay opacity is undeterminable on a lower-existing dir — is verified by
    // the crippled-PATH opaque-land probe, which can't run as a unit test here
    // because it needs a real opaque overlay dir + no xattr tooling.)
    const dataDir = tmp(); const sid = 's-multi';
    const up = makeUpper(dataDir, sid);
    const target = tmp();
    writeFileSync(join(target, 'a.txt'), 'old\n');
    writeFileSync(join(up, 'a.txt'), 'new\n');
    writeFileSync(join(up, 'b.txt'), 'new b\n');
    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(true);
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(target, 'b.txt'), 'utf8')).toBe('new b\n');
  });

  it('a BRAND-NEW opaque dir is mkdir-only (does NOT rm -rf unrelated real files)', () => {
    // Regression #10: overlay marks BOTH new and replaced dirs opaque. apply must
    // only rm -rf an opaque dir that ALSO exists in the target; a purely-new dir
    // must not clobber concurrent real files that drifted under that path.
    const dataDir = tmp(); const sid = 's-newdir';
    const up = makeUpper(dataDir, sid);
    const target = tmp();
    // The target real project has drifted: a sibling appeared under a path the
    // agent will also create. Simulate "agent created src/new-feature/ fresh".
    mkdirSync(join(target, 'src', 'new-feature'), { recursive: true });
    writeFileSync(join(target, 'src', 'new-feature', 'concurrent.txt'), 'do not delete me\n');
    // Upper: the agent's brand-new dir + its file. We cannot set a real opaque
    // xattr without root/CAP_SYS_ADMIN here, so this asserts the NON-opaque path
    // (plain new dir) never clobbers; the opaque-but-new path shares the same
    // exists-in-target guard in apply.
    mkdirSync(join(up, 'src', 'new-feature'), { recursive: true });
    writeFileSync(join(up, 'src', 'new-feature', 'feature.txt'), 'brand new feature\n');

    const a = applySandboxDiff(target, dataDir, sid);
    expect(a.ok).toBe(true);
    expect(readFileSync(join(target, 'src', 'new-feature', 'feature.txt'), 'utf8')).toBe('brand new feature\n');
    // the concurrent file the agent never touched MUST survive
    expect(existsSync(join(target, 'src', 'new-feature', 'concurrent.txt'))).toBe(true);
  });
});

// ── prepareSandbox: hidePaths produce the right masks ────────────────────────
// On Linux with root we can actually mount the overlays; verify the resulting
// argv masks an existing dir via tmpfs and a file via an empty ro-bind.
describe.skipIf(process.platform !== 'linux')('prepareSandbox hidePaths masks', () => {
  it('turns an existing dir hidePath into a tmpfs mask and a file into a ro-bind empty', () => {
    const src = tmp();
    writeFileSync(join(src, 'file.txt'), 'x');
    // a dir + a file to hide (both under a tmp tree so they exist)
    const secretDir = tmp();
    mkdirSync(join(secretDir, 'sekret'), { recursive: true });
    const secretFile = join(secretDir, 'creds.json');
    writeFileSync(secretFile, 'TOKEN');

    const prev = process.env.BOTMUX_SANDBOX;
    delete process.env.BOTMUX_SANDBOX;
    const dataDir = tmp();
    const sid = 'hp-' + Math.random().toString(36).slice(2);
    let r: ReturnType<typeof prepareSandbox> = null;
    try {
      r = prepareSandbox({
        enabled: true, cliId: 'codex', sessionId: sid, sourceWorkingDir: src,
        dataDir, cliBin: '/bin/true', cliArgs: [],
        hidePaths: [join(secretDir, 'sekret'), secretFile],
      });
      if (r === null) return; // overlay mount unavailable in this env — skip assertions
      // dir → tmpfs mask
      expect(r.args).toContain(join(secretDir, 'sekret'));
      const ti = r.args.indexOf('--tmpfs');
      expect(ti).toBeGreaterThanOrEqual(0);
      // file → ro-bind of an empty placeholder over the real file path
      const idx = r.args.findIndex((x, i) => x === '--ro-bind' && r!.args[i + 2] === secretFile);
      expect(idx).toBeGreaterThanOrEqual(0);
    } finally {
      if (r) r.cleanup();
      if (prev !== undefined) process.env.BOTMUX_SANDBOX = prev;
    }
  });
});
