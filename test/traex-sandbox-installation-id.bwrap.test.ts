/**
 * TRAE CLI (traex/coco, 0.213.x) cold start inside the oncall file sandbox.
 *
 * The embedded app server opens `<TRAE_HOME>/installation_id` O_RDWR|O_CREAT on
 * EVERY start (even when it exists) and aborts the TUI with
 * "failed to start embedded app server: Read-only file system (os error 30)"
 * when that open fails. The fs-policy only bound `<TRAE_HOME>/cli` read-write,
 * so whenever the TRAE root sat under a READ-ONLY ancestor rule — measured on a
 * devbox where `/opt -> /data00` relocates the baseline readOnly `/opt` to the
 * whole `/data00` and HOME lives in `/data00/home/<user>`, or a user readOnly
 * `~` — every new session died before its first prompt (the IM side only saw
 * `submit_unconfirmed`).
 *
 * This compiles the policy the way the worker does (adapter authPaths +
 * prepared sandboxWritableFiles → readWrite) under a read-only ancestor, then
 * performs the exact failing syscall (`exec 3<>` = O_RDWR|O_CREAT) under real
 * bubblewrap. Skipped off Linux / without usable bwrap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { prepareSandboxWritableFiles } from '../src/adapters/backend/sandbox-writable-files.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

const bwrapUsable = process.platform === 'linux'
  && spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0
  && spawnSync('bwrap', [
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    ...(existsSync('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--unshare-user', '--unshare-pid', '/bin/true',
  ], { stdio: 'ignore' }).status === 0;

const d = bwrapUsable ? describe : describe.skip;
const USRMERGE = ['/bin', '/lib', '/lib64', '/sbin', '/lib32', '/libx32'];

d('TRAE installation_id stays writable under a read-only TRAE root (real bubblewrap)', () => {
  let S: string;
  let home: string;
  let traeHome: string;

  function build(authPaths: string[]) {
    const emptiesDir = join(S, 'sbx/empties');
    const emptyDir = join(S, 'sbx/empty');
    mkdirSync(emptiesDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    const policy = buildFsPolicy({
      platform: 'linux', homeDir: home,
      botmuxHome: join(home, '.botmux'), sessionDataDir: join(home, '.botmux/data'),
      sessionId: 'trae-installation-id',
      workingDir: join(S, 'proj'), currentAppId: 'cli_trae', botHome: join(home, '.botmux/bots/cli_trae'),
      redirectedCliData: true,
      execPaths: [],
      authPaths,
      // The read-only ancestor of the TRAE root (stands in for the relocated
      // /opt -> /data00 baseline or a user readOnly `~`).
      userPaths: { readOnly: [home] },
      net: true, writeRegexes: [],
    });
    policy.rules = policy.rules.filter(r => r.access === 'deny' || existsSync(r.path));
    const symlinks: { path: string; target: string }[] = [];
    for (const p of USRMERGE) {
      try { if (lstatSync(p).isSymbolicLink()) symlinks.push({ path: p, target: readlinkSync(p) }); } catch { /* */ }
    }
    const filePaths = new Set<string>();
    for (const r of policy.rules) {
      if (r.access !== 'deny') continue;
      try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* */ }
    }
    const compiled = compileToBwrap(policy, { symlinks, emptyDir, emptiesDir, filePaths, chdir: join(S, 'proj') });
    chmodSync(emptyDir, 0o000);
    for (const f of compiled.emptyFiles) writeFileSync(f.path, '', { mode: 0o000 });
    for (const m of compiled.maskMounts) {
      if (existsSync(m.path)) continue;
      if (m.kind === 'file') { mkdirSync(dirname(m.path), { recursive: true }); writeFileSync(m.path, ''); }
      else mkdirSync(m.path, { recursive: true });
    }
    return compiled.args;
  }

  function run(args: string[], cmd: string) {
    const r = spawnSync('bwrap', [...args, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  /** The adapter's read-write surface, assembled like the worker does. */
  function adapterAuthPaths(adapter: { authPaths?: readonly string[]; sandboxWritableFiles?(env?: NodeJS.ProcessEnv): readonly string[] }, env: NodeJS.ProcessEnv): string[] {
    return [
      ...(adapter.authPaths ?? []).filter(p => existsSync(p)),
      ...prepareSandboxWritableFiles([...(adapter.sandboxWritableFiles?.(env) ?? [])]),
    ];
  }

  // The adapters' authPaths getters read process.env (the worker pins TRAE_HOME there).
  const savedTraeHome = process.env.TRAE_HOME;
  beforeAll(() => {
    S = realpathSync(mkdtempSync(join(tmpdir(), 'trae-installid-bwrap-')));
    home = join(S, 'home');
    traeHome = join(home, '.trae');
    mkdirSync(join(traeHome, 'cli'), { recursive: true });
    mkdirSync(join(S, 'proj'), { recursive: true });
    writeFileSync(join(traeHome, 'traecli.toml'), 'model = "x"\n');
    process.env.TRAE_HOME = traeHome;
  });
  afterAll(() => {
    if (savedTraeHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = savedTraeHome;
    rmSandboxScratch(S);
  });

  const OPEN_RDWR_CREAT = (p: string) => `exec 3<> ${JSON.stringify(p)} && printf persisted >&3`;

  it('without the grant the exact app-server open fails with EROFS (the reported failure)', () => {
    const args = build([join(traeHome, 'cli')]);
    const r = run(args, OPEN_RDWR_CREAT(join(traeHome, 'installation_id')));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Read-only file system/);
  });

  for (const [name, make] of [['traex', () => createTraexAdapter('/bin/true')], ['coco', () => createCocoAdapter('/bin/true')]] as const) {
    it(`${name}: a missing installation_id is pre-created and opens O_RDWR|O_CREAT; writes reach the host`, () => {
      const id = join(traeHome, 'installation_id');
      rmSync(id, { force: true });
      const args = build(adapterAuthPaths(make(), { ...process.env, TRAE_HOME: traeHome }));
      const r = run(args, OPEN_RDWR_CREAT(id));
      expect(r.out).toBe('');
      expect(r.status).toBe(0);
      expect(readFileSync(id, 'utf8')).toBe('persisted');
    });
  }

  it('the grant is that one file: sibling TRAE root state stays read-only', () => {
    const args = build(adapterAuthPaths(createTraexAdapter('/bin/true'), { ...process.env, TRAE_HOME: traeHome }));
    expect(run(args, `echo x >> ${JSON.stringify(join(traeHome, 'traecli.toml'))}`).status).not.toBe(0);
    expect(run(args, `mkdir ${JSON.stringify(join(traeHome, 'hooks'))}`).status).not.toBe(0);
    expect(readFileSync(join(traeHome, 'traecli.toml'), 'utf8')).toBe('model = "x"\n');
  });
});
