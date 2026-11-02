/**
 * Linux bwrap robustness (board #86):
 *   1. credential-only isolation gets its own /dev and the probe really uses it;
 *   2. the distro bwrap wins over a PATH one (Codex ships its own build);
 *   3. symlinked baseline dirs (/opt -> /data00/opt) are rebuilt as links;
 *   4. namespace refusals are recognised for the startup-failure notice.
 *
 * The bwrap-gated cases need a host that can create user + PID namespaces.
 * Run them inside isolate-run (with a spare procfs mounted, see the PR) —
 * never start a real sandbox on a shared host directly.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCredentialOnlySandboxArgs,
  CREDENTIAL_ONLY_PROBE_ARGS,
  prepareCredentialOnlySandbox,
  __testOnly_resetPidNamespaceProbe,
  bwrapNamespaceFailure,
  prepareDirectSandbox,
  probeHostCredentialIsolationMechanism,
} from '../src/adapters/backend/sandbox.js';
import { relocateSymlinkedBaselineRules, type FsRule } from '../src/adapters/cli/fs-policy.js';
import {
  __testOnly_resetBwrapWarnings,
  bwrapExecutable,
  bwrapNamespaceDocUrl,
  classifyBwrapNamespaceFailure,
  diagnoseSandboxNamespaceFailure,
  resolveBwrap,
  sandboxNamespaceNotice,
  systemBwrapPath,
} from '../src/core/system-bwrap.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { resolveStoredSandboxPaths } from '../src/services/sandbox-path-guard.js';

const linux = process.platform === 'linux';
const credentialBwrapUsable = linux && probeHostCredentialIsolationMechanism().mechanism === 'bwrap';
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function fakeExecutable(path: string): string {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('bwrap executable resolution', () => {
  afterEach(() => { __testOnly_resetBwrapWarnings(); vi.restoreAllMocks(); });

  it('prefers the first existing system candidate over a bwrap earlier on PATH', () => {
    const root = tmp('bwrap-resolve-');
    const system = fakeExecutable(join(root, 'system-bwrap'));
    const pathDir = join(root, 'path');
    mkdirSync(pathDir);
    fakeExecutable(join(pathDir, 'bwrap'));
    const readVersion = vi.fn(() => 'bubblewrap 0.11.0 (built for Codex)');
    expect(resolveBwrap({
      candidates: [join(root, 'absent'), system],
      env: { PATH: pathDir },
      readVersion,
    })).toEqual({ path: system, system: true });
    expect(readVersion).not.toHaveBeenCalled();
  });

  it('falls back to PATH with a warning and names the Codex build', () => {
    const root = tmp('bwrap-resolve-');
    const pathDir = join(root, 'path');
    mkdirSync(pathDir);
    const onPath = fakeExecutable(join(pathDir, 'bwrap'));
    const codex = resolveBwrap({
      candidates: [join(root, 'absent')],
      env: { PATH: pathDir },
      readVersion: () => 'bubblewrap 0.11.0 (built for Codex)\n',
    });
    expect(codex?.path).toBe(onPath);
    expect(codex?.system).toBe(false);
    expect(codex?.warning).toContain(onPath);
    expect(codex?.warning).toMatch(/Codex-bundled/);

    const plain = resolveBwrap({
      candidates: [join(root, 'absent')],
      env: { PATH: pathDir },
      readVersion: () => 'bubblewrap 0.9.0',
    });
    expect(plain?.warning).toContain(onPath);
    expect(plain?.warning).not.toMatch(/Codex/);
  });

  it('returns undefined when no bwrap exists anywhere', () => {
    const root = tmp('bwrap-resolve-');
    expect(resolveBwrap({ candidates: [join(root, 'absent')], env: { PATH: root } })).toBeUndefined();
    expect(systemBwrapPath([join(root, 'absent')])).toBeUndefined();
  });

  it('skips a non-executable system candidate', () => {
    const root = tmp('bwrap-resolve-');
    const plain = join(root, 'not-exec');
    writeFileSync(plain, '');
    const good = fakeExecutable(join(root, 'good'));
    expect(systemBwrapPath([plain, good])).toBe(good);
  });

  it('logs the fallback warning once per executable', () => {
    const root = tmp('bwrap-resolve-');
    const pathDir = join(root, 'path');
    mkdirSync(pathDir);
    fakeExecutable(join(pathDir, 'bwrap'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = { candidates: [join(root, 'absent')], env: { PATH: pathDir }, readVersion: () => 'bubblewrap 0.9.0' };
    bwrapExecutable(deps);
    bwrapExecutable(deps);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('every Linux sandbox launch names the resolved executable, not a bare bwrap', () => {
    if (!linux) return;
    const bwrap = bwrapExecutable();
    if (!bwrap) return;
    const root = tmp('bwrap-launch-');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'resolve-launch', dataDir: join(root, 'data'),
        policy: { rules: [], net: true, writeRegexes: [] },
        chdir: root, home: root, cliBin: '/bin/true', cliArgs: [],
      });
      if (!plan) return;
      expect(plan.args).toContain(bwrap);
      expect(plan.args).not.toContain('bwrap');
    } finally { plan?.cleanup(); rmSandboxScratch(root); }
  });
});

describe('credential-only isolation /dev', () => {
  const input = {
    hideDirectories: ['/srv/botmux/device-authority'],
    hideFiles: ['/srv/botmux/.dashboard-secret'],
    workingDir: '/workspace',
    cliBin: '/usr/bin/true',
    cliArgs: [],
  };

  it('mounts its own /dev before any credential mask', () => {
    const args = buildCredentialOnlySandboxArgs(input);
    const devAt = args.findIndex((value, i) => value === '--dev' && args[i + 1] === '/dev');
    expect(devAt).toBeGreaterThan(args.indexOf('/'));
    const firstMask = args.findIndex((value, i) => (value === '--tmpfs' || value === '--ro-bind') && i > 1);
    expect(devAt).toBeLessThan(firstMask);
    // The file masks still bind the host /dev/null as their source.
    expect(args).toContain('/srv/botmux/.dashboard-secret');
    expect(args).not.toContain('--dev-bind');
  });

  it('probes with the same /dev and real device I/O', () => {
    expect(CREDENTIAL_ONLY_PROBE_ARGS).toContain('--dev');
    const command = CREDENTIAL_ONLY_PROBE_ARGS.at(-1)!;
    expect(command).toContain('/dev/null');
    expect(command).toContain('/dev/urandom');
  });

  it.skipIf(!credentialBwrapUsable)('lets the confined CLI write /dev/null and read /dev/urandom', () => {
    const root = tmp('cred-dev-');
    const hidden = join(root, 'authority');
    mkdirSync(hidden);
    writeFileSync(join(hidden, 'secret'), 'top');
    // A file mask binds the HOST /dev/null (nodev): its content stays unreadable.
    const hiddenFile = join(root, '.dashboard-secret');
    writeFileSync(hiddenFile, 'token');
    const spawn = prepareCredentialOnlySandbox({
      hideDirectories: [hidden],
      hideFiles: [hiddenFile],
      workingDir: root,
      cliBin: '/bin/sh',
      cliArgs: ['-c', `printf x >/dev/null && head -c 8 /dev/urandom | wc -c && ls ${hidden} | wc -l && { cat ${hiddenFile} 2>/dev/null || echo masked; }`],
    });
    expect(spawn).not.toBeNull();
    const r = spawnSync(spawn!.bin, spawn!.args, { encoding: 'utf8', timeout: 10_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split(/\s+/)).toEqual(['8', '0', 'masked']);
    rmSandboxScratch(root);
  });
});

describe('symlinked baseline directories', () => {
  const io = (links: Record<string, string>, real: string[] = []) => ({
    isSymlink: (p: string) => p in links,
    realpath: (p: string) => {
      if (p in links) return links[p] || undefined;
      const hit = Object.entries(links).find(([from]) => p.startsWith(`${from}/`));
      if (hit) return hit[1] + p.slice(hit[0].length);
      return real.includes(p) || p === '/' || !p.startsWith('/opt') ? p : undefined;
    },
  });
  const ro = (path: string, source: FsRule['source'] = 'baseline'): FsRule => ({ path, access: 'readOnly', source });

  it('rebinds the real path and recreates the link', () => {
    const out = relocateSymlinkedBaselineRules([ro('/etc'), ro('/opt'), ro('/usr')], io({ '/opt': '/data00/opt' }));
    expect(out.symlinks).toEqual([{ path: '/opt', target: '/data00/opt' }]);
    expect(out.rules.map(r => r.path)).toEqual(['/etc', '/usr', '/data00/opt']);
  });

  it('moves rules below the link and lets an explicit rule for the real path win', () => {
    const out = relocateSymlinkedBaselineRules([
      ro('/opt'),
      { path: '/opt/secret', access: 'deny', source: 'user' },
      { path: '/data00/opt', access: 'readWrite', source: 'user' },
    ], io({ '/opt': '/data00/opt' }));
    expect(out.rules).toEqual([
      { path: '/data00/opt', access: 'readWrite', source: 'user' },
      { path: '/data00/opt/secret', access: 'deny', source: 'user' },
    ]);
  });

  it('keeps an explicit rule for a shallower real path over the relocated baseline', () => {
    // Sorted input puts the explicit /c before the deeper lexical link.
    const out = relocateSymlinkedBaselineRules([
      { path: '/c', access: 'readWrite', source: 'user' },
      ro('/srv/cache'),
    ], { isSymlink: p => p === '/srv/cache', realpath: p => (p === '/srv/cache' ? '/c' : p) });
    expect(out.symlinks).toEqual([{ path: '/srv/cache', target: '/c' }]);
    expect(out.rules).toEqual([{ path: '/c', access: 'readWrite', source: 'user' }]);
  });

  it('drops a dangling baseline link and leaves real dirs and non-baseline rules alone', () => {
    const rules = [ro('/opt'), ro('/srv', 'user')];
    const out = relocateSymlinkedBaselineRules(rules, io({ '/opt': '', '/srv': '/data00/srv' }));
    expect(out.symlinks).toEqual([]);
    expect(out.rules).toEqual([ro('/srv', 'user')]);
    const untouched = relocateSymlinkedBaselineRules([ro('/etc')], io({}));
    expect(untouched).toEqual({ rules: [ro('/etc')], symlinks: [] });
  });

  it('only rebuilds a link whose parent is already canonical', () => {
    const out = relocateSymlinkedBaselineRules(
      [ro('/home/u/.cache')],
      { isSymlink: () => true, realpath: (p: string) => p === '/home/u' ? '/data00/home/u' : '/data00/cache' },
    );
    expect(out.symlinks).toEqual([]);
    expect(out.rules).toEqual([ro('/home/u/.cache')]);
  });

  it.skipIf(!credentialBwrapUsable)('exposes the link target and masks a deny under the real path', () => {
    const root = tmp('sbx-optlink-');
    const realOpt = join(root, 'data00', 'opt');
    mkdirSync(join(realOpt, 'tool'), { recursive: true });
    mkdirSync(join(realOpt, 'secret'));
    writeFileSync(join(realOpt, 'tool', 'f'), 'hi');
    writeFileSync(join(realOpt, 'secret', 'key'), 'leak');
    const lexicalOpt = join(root, 'opt');
    symlinkSync(realOpt, lexicalOpt);
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'opt-link', dataDir: join(root, 'botmux'),
        policy: {
          rules: [
            { path: '/etc', access: 'readOnly', source: 'baseline' },
            { path: '/usr', access: 'readOnly', source: 'baseline' },
            { path: lexicalOpt, access: 'readOnly', source: 'baseline' },
            // The worker canonicalizes user denies: /opt/secret arrives as its real path.
            { path: join(realOpt, 'secret'), access: 'deny', source: 'user' },
          ],
          net: true,
          writeRegexes: [],
        },
        chdir: '/', home: root, cliBin: '/bin/sh',
        cliArgs: ['-c', `cat ${lexicalOpt}/tool/f; readlink ${lexicalOpt}; cat ${lexicalOpt}/secret/key 2>/dev/null || echo denied`],
      });
      expect(plan).not.toBeNull();
      const r = spawnSync(plan!.bin, plan!.args, { encoding: 'utf8', timeout: 10_000 });
      expect(r.stderr).toBe('');
      expect(r.stdout.split('\n')).toEqual(['hi' + realOpt, 'denied', '']);
    } finally { plan?.cleanup(); rmSandboxScratch(root); }
  });
});

describe('readOnly entries covering a launcher mount point', () => {
  // Real bwrap on the production plan: a readOnly `/run` (or `/var/run`, a
  // link to it on most distros) re-covers the launcher's tmpfs /run, so
  // `/run/sbxbin` cannot be created and the session exits at launch. The
  // stored-entry step drops such entries; this pins the two together so the
  // guard cannot regress to matching one literal path again.
  function launch(readOnly: string[]) {
    const root = tmp('sbx-ro-run-');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'ro-run', dataDir: join(root, 'botmux'),
        policy: {
          rules: [
            { path: '/etc', access: 'readOnly', source: 'baseline' },
            { path: '/usr', access: 'readOnly', source: 'baseline' },
            // The worker canonicalizes user entries before building the policy.
            ...readOnly.map(path => ({ path: realpathSync(path), access: 'readOnly' as const, source: 'user' as const })),
          ],
          net: true,
          writeRegexes: [],
        },
        // No shell: the probe only needs a process to start inside the plan.
        chdir: '/', home: root, cliBin: '/usr/bin/echo', cliArgs: ['started'],
      });
      expect(plan).not.toBeNull();
      return spawnSync(plan!.bin, plan!.args, { encoding: 'utf8', timeout: 10_000 });
    } finally { plan?.cleanup(); rmSandboxScratch(root); }
  }

  const entries = ['/run', ...(linux && realpathSync('/var/run') === '/run' ? ['/var/run'] : [])];
  it.skipIf(!credentialBwrapUsable).each(entries)('%s exits at launch as stored, and starts once dropped', entry => {
    const stored = launch([entry]);
    expect(stored.status).not.toBe(0);
    expect(stored.stderr).toContain('sbxbin');

    const { lists, droppedReadOnlyRoot } = resolveStoredSandboxPaths({ readOnly: [entry, '/run/lock'] }, { platform: 'linux' });
    expect(droppedReadOnlyRoot).toEqual([entry]);
    const started = launch(lists!.readOnly!);
    expect(started.stderr).toBe('');
    expect(started.stdout).toBe('started\n');
  });
});

describe('bwrap namespace failure diagnosis', () => {
  it.each([
    ["bwrap: Can't mount proc on /newroot/proc: Operation not permitted", 'pid'],
    ['bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces.', 'user'],
    ['bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.', 'user'],
    ['bwrap: setting up uid map: Permission denied', 'user'],
    ['bwrap: Creating new namespace failed: Operation not permitted', 'user'],
  ] as const)('recognises %s', (text, kind) => {
    expect(classifyBwrapNamespaceFailure(`some output\n${text}\n`)).toBe(kind);
  });

  it('ignores unrelated bwrap failures', () => {
    expect(classifyBwrapNamespaceFailure("bwrap: Can't bind mount /oldroot/x on /newroot/x: Unable to apply mount flags")).toBeUndefined();
    expect(classifyBwrapNamespaceFailure(undefined)).toBeUndefined();
  });

  it('renders a localized notice with the docs link', () => {
    expect(sandboxNamespaceNotice('pid', 'zh')).toContain('PID namespace');
    expect(sandboxNamespaceNotice('pid', 'zh')).toContain(bwrapNamespaceDocUrl('zh'));
    expect(sandboxNamespaceNotice('user', 'en')).toContain('user namespace');
    expect(sandboxNamespaceNotice('user', 'en')).toContain(bwrapNamespaceDocUrl('en'));
  });

  it('diagnoses from bwrap output first, then the host probe, only for bwrap launches', () => {
    const probe = vi.fn(() => 'pid' as const);
    const base = { probe, pidNamespaceDropped: () => false };
    expect(diagnoseSandboxNamespaceFailure({ ...base, linuxBwrap: false, text: "Can't mount proc on /newroot/proc" })).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(diagnoseSandboxNamespaceFailure({ ...base, linuxBwrap: true, text: 'No permissions to create new namespace' })).toBe('user');
    expect(probe).not.toHaveBeenCalled();
    // A pane that died with no output: the cached host probe decides.
    expect(diagnoseSandboxNamespaceFailure({ ...base, linuxBwrap: true, text: undefined })).toBe('pid');
    expect(diagnoseSandboxNamespaceFailure({ ...base, linuxBwrap: true, text: 'segfault' })).toBe('pid');
    // Core-only already ran without --unshare-pid on this host.
    expect(diagnoseSandboxNamespaceFailure({ ...base, linuxBwrap: true, text: undefined, pidNamespaceDropped: () => true })).toBeUndefined();
    expect(diagnoseSandboxNamespaceFailure({ linuxBwrap: true, text: undefined, probe: () => undefined, pidNamespaceDropped: () => false })).toBeUndefined();
  });

  it.skipIf(!linux || !bwrapExecutable())('host probe agrees with whether bwrap can create the namespaces', () => {
    __testOnly_resetPidNamespaceProbe();
    try {
      if (credentialBwrapUsable) expect(bwrapNamespaceFailure()).toBeUndefined();
      // isolate-run without a spare procfs: the nested PID namespace is refused.
      else expect(bwrapNamespaceFailure()).toMatch(/^(pid|user)$/);
    } finally { __testOnly_resetPidNamespaceProbe(); }
  });

  it.skipIf(!linux || credentialBwrapUsable || !bwrapExecutable())('reports the namespace refusal in the credential-only probe reason', () => {
    // Only reachable on a host whose bwrap cannot create the namespaces
    // (isolate-run without a spare procfs reproduces the PID case).
    const probe = probeHostCredentialIsolationMechanism();
    expect(probe.supported).toBe(false);
    if (probe.supported) return;
    expect(probe.reason).toMatch(/Can't mount proc|new namespace|uid map/);
    expect(probe.reason).toContain(bwrapNamespaceDocUrl('en'));
  });
});
