import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bwrapCanUnsharePid, prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import type { FsPolicy } from '../src/adapters/cli/fs-policy.js';
import { buildWrappedLaunch } from '../src/setup/cli-selection.js';
import { installAidenCodexShim, writeAidenCodexShellConfigs } from '../src/services/aiden-codex-shim.js';
import { sessionIdentityBinDir } from '../src/core/cli-identity.js';
import {
  canonicalHandoffPath,
  cliNameLink,
  defaultWrapperFsIo,
  sandboxHandoffResolver,
  sandboxWrapperLaunchFrom,
  uncoveredWrapperDependencies,
  wrapperAutoAllowPaths,
  wrapperDependencies,
  type SandboxWrapperLaunch,
} from '../src/core/sandbox-wrapper-launch.js';

// Real bwrap: a wrapperCli executed INSIDE the file sandbox, assembled the way
// the worker assembles it (buildWrappedLaunch → auto-allow only the wrapper's
// own file → CLI name alias in the private shim dir → prepareDirectSandbox).
// Run it through isolate-run; nested there, bwrap cannot mount /proc in a new
// pid namespace, so the existing core-only degrade (no pid ns) is used.

const linux = process.platform === 'linux';
const hasBwrap = linux && spawnSync('bwrap', ['--version']).status === 0;
const canRunBwrap = hasBwrap && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--proc', '/proc', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;

let savedCoreOnly: string | undefined;
beforeAll(() => {
  savedCoreOnly = process.env.BOTMUX_CORE_ONLY;
  if (canRunBwrap && !bwrapCanUnsharePid()) process.env.BOTMUX_CORE_ONLY = '1';
});
afterAll(() => {
  if (savedCoreOnly === undefined) delete process.env.BOTMUX_CORE_ONLY;
  else process.env.BOTMUX_CORE_ONLY = savedCoreOnly;
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-sbx-wrapper-')));
  const cliDir = join(root, 'cli-install');
  const wrapDir = join(root, 'wrapper-install');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  for (const d of [cliDir, wrapDir, workspace, home, dataDir]) mkdirSync(d, { recursive: true });
  const cliBin = join(cliDir, 'fakecli');
  writeFileSync(cliBin, '#!/bin/sh\necho "CLI-RAN $*"\n');
  chmodSync(cliBin, 0o755);
  const sibling = join(wrapDir, 'profile.conf');
  writeFileSync(sibling, 'wrapper-profile');
  const secret = join(root, 'host-secret.txt');
  writeFileSync(secret, 'top-secret');
  // The wrapper probes what it can see, then execs the CLI BY NAME.
  const wrapper = join(wrapDir, 'mywrap');
  writeFileSync(wrapper, [
    '#!/bin/sh',
    'echo WRAPPER-RAN',
    `if cat ${JSON.stringify(secret)} >/dev/null 2>&1; then echo SECRET-READ; else echo SECRET-DENIED; fi`,
    `if cat ${JSON.stringify(sibling)} >/dev/null 2>&1; then echo PROFILE-READ; else echo PROFILE-DENIED; fi`,
    'exec "$@"',
    '',
  ].join('\n'));
  chmodSync(wrapper, 0o755);
  // Baseline-shaped policy: system dirs read-only, the CLI's exec dir (what
  // the worker's execDirs contribute), the workspace read-write.
  const policy: FsPolicy = {
    rules: [
      ...['/usr', '/etc', cliDir].map(path => ({ path, access: 'readOnly' as const, source: 'internal' as const })),
      { path: workspace, access: 'readWrite' as const, source: 'internal' as const },
    ],
    net: false,
    writeRegexes: [],
  };
  return { root, cliBin, wrapper, wrapDir, workspace, home, dataDir, policy };
}

type Fixture = ReturnType<typeof fixture>;

function launchFor(f: Fixture): SandboxWrapperLaunch {
  const launch = buildWrappedLaunch(`${f.wrapper} fakecli`, ['--flag', 'x']);
  return { wrapperCli: `${f.wrapper} fakecli`, bin: launch.bin, args: launch.args, cliBin: f.cliBin };
}

function run(f: Fixture, launch: SandboxWrapperLaunch, opts: { alias?: boolean; extraRules?: FsPolicy['rules']; env?: Record<string, string> } = {}) {
  const io = defaultWrapperFsIo(() => undefined);
  const policy: FsPolicy = {
    ...f.policy,
    rules: [
      ...f.policy.rules,
      ...wrapperAutoAllowPaths(launch, io).map(path => ({ path, access: 'readOnly' as const, source: 'adapter' as const })),
      ...(opts.extraRules ?? []),
    ],
  };
  let plan: ReturnType<typeof prepareDirectSandbox> = null;
  try {
    plan = prepareDirectSandbox({
      sessionId: 'session', dataDir: f.dataDir, policy, chdir: f.workspace, home: f.home,
      cliBin: launch.bin, cliArgs: launch.args,
      effectivePath: '/usr/bin:/bin',
      ...(opts.alias === false ? {} : { cliNameLink: cliNameLink(launch.cliBin, io) }),
    });
    expect(plan).not.toBeNull();
    const r = spawnSync(plan!.bin, plan!.args, { encoding: 'utf8', timeout: 15_000, env: { PATH: '/usr/bin:/bin', ...opts.env } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    const empty = join(f.dataDir, 'sandboxes/session/empty');
    if (existsSync(empty)) chmodSync(empty, 0o700);
    plan?.cleanup();
  }
}

describe.skipIf(!canRunBwrap)('wrapperCli inside the file sandbox (real bwrap)', () => {
  let f: Fixture;
  beforeAll(() => { f = fixture(); });
  afterAll(() => rmSync(f.root, { recursive: true, force: true }));

  it('runs the wrapper inside the sandbox, which then execs the CLI by name with its args', () => {
    const r = run(f, launchFor(f));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('WRAPPER-RAN');
    // Inside the same allowlist as the CLI: a host path outside it is unreadable,
    // and nothing next to the wrapper binary was let in automatically.
    expect(r.out).toContain('SECRET-DENIED');
    expect(r.out).toContain('PROFILE-DENIED');
    expect(r.out).toContain('CLI-RAN --flag x');
  });

  it('reaches the wrapper\'s own files only once they are explicitly allowed', () => {
    const r = run(f, launchFor(f), { extraRules: [{ path: f.wrapDir, access: 'readOnly', source: 'user' }] });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('PROFILE-READ');
    expect(r.out).toContain('SECRET-DENIED');
  });

  it('names the missing interpreter of a script wrapper before launch', () => {
    const interpDir = join(f.root, 'interp-install');
    mkdirSync(interpDir, { recursive: true });
    const interp = join(interpDir, 'wrapinterp');
    writeFileSync(interp, '#!/bin/sh\nexec /bin/sh "$@"\n');
    chmodSync(interp, 0o755);
    const scripted = join(f.wrapDir, 'scripted-wrap');
    writeFileSync(scripted, '#!/usr/bin/env wrapinterp\nexec "$@"\n');
    chmodSync(scripted, 0o755);
    const launch: SandboxWrapperLaunch = { wrapperCli: scripted, bin: scripted, args: ['fakecli'], cliBin: f.cliBin };
    const io = defaultWrapperFsIo(name => (name === 'wrapinterp' ? interp : undefined));
    const rules = [
      ...f.policy.rules,
      ...wrapperAutoAllowPaths(launch, io).map(path => ({ path, access: 'readOnly' as const, source: 'adapter' as const })),
    ];
    const missing = uncoveredWrapperDependencies(wrapperDependencies(launch, io), rules);
    expect(missing.map(m => m.path)).toEqual([interp]);
    // And the preflight is right: launched anyway, the sandbox cannot run it.
    const r = run(f, launch);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).not.toContain('CLI-RAN');
  });

  it('runs the aiden x codex shim chain from a symlinked install dir and data dir', () => {
    // /link → /real for both the install tree and the botmux data root.
    const real = join(f.root, 'real');
    const link = join(f.root, 'link');
    mkdirSync(join(real, 'bin'), { recursive: true });
    mkdirSync(join(real, 'data'), { recursive: true });
    symlinkSync(real, link);
    const aiden = join(real, 'bin/aiden');
    // `aiden x codex …` → runs `codex` BY NAME (the shim dir is first on PATH).
    writeFileSync(aiden, '#!/bin/sh\necho "AIDEN-RAN $*"\nshift 2\nexec codex "$@"\n');
    chmodSync(aiden, 0o755);
    const codex = join(real, 'bin/codex');
    writeFileSync(codex, '#!/bin/sh\necho "CODEX-ARGV: $*"\n');
    chmodSync(codex, 0o755);
    // The worker's sandboxed wiring: canonical identity data dir for the shim,
    // canonical handoff resolver and REAL_BIN; PATH lookups stay lexical.
    const shimDir = installAidenCodexShim(join(sessionIdentityBinDir(realpathSync(join(link, 'data')), 'sess'), 'aiden-codex'));
    const lexicalCodex = join(link, 'bin/codex');
    const launch = buildWrappedLaunch('aiden x codex',
      ['-c', 'shell_environment_policy.set.BOTMUX_SESSION_ID="s"', 'exec', 'hi'],
      sandboxHandoffResolver(b => join(link, 'bin', b)),
      { aidenCodexRealBin: canonicalHandoffPath(lexicalCodex), aidenCodexShimDir: shimDir,
        requireAidenCodexShim: true, writeAidenShellConfigs: configs => writeAidenCodexShellConfigs(shimDir, configs) });
    expect(launch.bin).toBe(join(shimDir, 'launch'));
    const sandboxed = sandboxWrapperLaunchFrom({
      applied: true, wrapperCli: 'aiden x codex', bin: launch.bin, args: launch.args,
      cliBin: lexicalCodex, aidenCodexShimDir: shimDir,
    })!;
    // The CLI's own exec dir is allowed by the worker's execDirs (canonical).
    const r = run(f, sandboxed, {
      extraRules: [{ path: join(real, 'bin'), access: 'readOnly', source: 'adapter' }],
      env: launch.env,
    });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('AIDEN-RAN x codex');
    expect(r.out).toContain('CODEX-ARGV: -c shell_environment_policy.set.BOTMUX_SESSION_ID="s" exec hi');
  });
});
