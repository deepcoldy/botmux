/**
 * Kernel-level check of the sandbox credential visibility layouts covered by
 * test/sandbox-credential-visibility.test.ts: compile the production policy to
 * a real bwrap argv (same steps as the worker: mode-000 empty sources,
 * pre-created mask mountpoints) and run shell probes inside it.
 *
 *  - workingDir is the (fake) home, so it covers the botmux root: bots.json,
 *    .dashboard-secret and a sibling bot's send-cred.json must be neither
 *    readable nor writable; the own BOT_HOME send-cred.json stays usable.
 *  - the botmux install root is a git checkout: its .env, bots config, login
 *    state and .git are hidden, code and build outputs stay readable.
 *
 * Every file is a fake. Run inside isolate-run, wrapped in a private mount+PID
 * namespace so the nested `--unshare-user --proc` works:
 *   isolate-run -- unshare --mount --propagation private --pid --fork --mount-proc --kill-child \
 *     bunx vitest run test/sandbox-credential-visibility.bwrap.test.ts
 * Skipped (not passed) where bwrap cannot run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';
import { botmuxInstallRootMaskPaths } from '../src/adapters/cli/install-root-masks.js';
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

d('sandbox credential visibility (real bubblewrap)', () => {
  let S: string;
  let home: string;
  let bh: string;
  let checkout: string;
  let args: string[];

  const put = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };

  function compile(workingDir: string, root = bh): string[] {
    // Fresh mask sources per compile: the previous ones are mode 000 and a
    // non-root uid cannot rewrite them.
    const sbx = mkdtempSync(join(S, 'sbx-'));
    const emptiesDir = join(sbx, 'empties');
    const emptyDir = join(sbx, 'empty');
    mkdirSync(emptiesDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    const policy = buildFsPolicy({
      platform: 'linux', homeDir: home,
      botmuxHome: root, defaultBotmuxHome: bh, sessionDataDir: join(root, 'data'),
      sessionId: 'cred-vis', workingDir, currentAppId: 'cli_self', botHome: join(root, 'bots/cli_self'),
      redirectedCliData: true,
      loadedBotsConfigPath: join(bh, 'bots.json'),
      botmuxInstallRoot: checkout,
      botmuxInstallRootMaskPaths: botmuxInstallRootMaskPaths(checkout).paths,
      execPaths: [dirname(realpathSync(process.execPath))],
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
      try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* absent → dir mask */ }
    }
    const compiled = compileToBwrap(policy, { symlinks, emptyDir, emptiesDir, filePaths, chdir: workingDir });
    chmodSync(emptyDir, 0o000);
    for (const f of compiled.emptyFiles) writeFileSync(f.path, '', { mode: 0o000 });
    for (const m of compiled.maskMounts) {
      if (existsSync(m.path)) continue;
      if (m.kind === 'file') put(m.path, '');
      else mkdirSync(m.path, { recursive: true });
    }
    return compiled.args;
  }

  const sh = (cmd: string, argv = args) => {
    const r = spawnSync('bwrap', [...argv, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const q = (p: string) => JSON.stringify(p);
  // Content check, not just the exit code: every fake file holds a FAKE-* body.
  const readable = (p: string, argv = args) => {
    const r = sh(`cat ${q(p)}`, argv);
    return r.status === 0 && r.out.includes('FAKE');
  };

  beforeAll(() => {
    S = realpathSync(mkdtempSync(join(tmpdir(), 'cred-vis-bwrap-')));
    home = join(S, 'home');
    bh = join(home, '.botmux');
    checkout = join(S, 'checkout');
    put(join(bh, 'bots.json'), 'FAKE-bots');
    put(join(bh, '.dashboard-secret'), 'FAKE-secret');
    put(join(bh, 'bots/cli_other/send-cred.json'), 'FAKE-other');
    put(join(bh, 'bots/cli_self/send-cred.json'), 'FAKE-self');
    put(join(bh, 'data/session-stores/cli_self/x'), 'FAKE-store');
    put(join(home, 'proj/readme.md'), 'FAKE-proj');
    put(join(checkout, 'package.json'), '{"FAKE":1}');
    put(join(checkout, 'dist/cli.js'), 'FAKE-code');
    put(join(checkout, '.gitignore'), '.env\ndist/\nstorageState.json\n');
    put(join(checkout, '.env'), 'FAKE-env');
    put(join(checkout, 'storageState.json'), 'FAKE-state');
    put(join(checkout, 'test-bots.json'), 'FAKE-checkout-bots');
    execFileSync('git', ['-C', checkout, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', checkout, 'add', 'package.json', '.gitignore'], { stdio: 'ignore' });
    put(join(checkout, '.git/marker'), 'FAKE-git');
    args = compile(home);
  });
  afterAll(() => { if (S) rmSandboxScratch(S); });

  it('workingDir covering ~/.botmux: botmux credentials are neither readable nor writable', () => {
    for (const p of [join(bh, 'bots.json'), join(bh, '.dashboard-secret'), join(bh, 'bots/cli_other/send-cred.json')]) {
      expect(readable(p), p).toBe(false);
      expect(sh(`echo hacked > ${q(p)}`).status, p).not.toBe(0);
    }
    expect(sh(`echo x > ${q(join(bh, 'new-file'))}`).status).not.toBe(0);
    expect(readFileSync(join(bh, 'bots.json'), 'utf8')).toBe('FAKE-bots');
  });

  it('the own BOT_HOME and session store stay usable', () => {
    expect(readable(join(bh, 'bots/cli_self/send-cred.json'))).toBe(true);
    expect(sh(`echo ok > ${q(join(bh, 'bots/cli_self/note'))}`).status).toBe(0);
    expect(readable(join(bh, 'data/session-stores/cli_self/x'))).toBe(true);
    expect(readable(join(home, 'proj/readme.md'))).toBe(true);
    expect(sh(`echo ok > ${q(join(home, 'proj/out.txt'))}`).status).toBe(0);
  });

  it('install root: non-code files hidden, code readable, nothing writable', () => {
    for (const p of [join(checkout, '.env'), join(checkout, 'storageState.json'), join(checkout, 'test-bots.json'), join(checkout, '.git/marker')]) {
      expect(readable(p), p).toBe(false);
    }
    expect(readable(join(checkout, 'dist/cli.js'))).toBe(true);
    expect(readable(join(checkout, 'package.json'))).toBe(true);
    expect(sh(`echo x > ${q(join(checkout, 'dist/cli.js'))}`).status).not.toBe(0);
  });

  it('data dir inside the checkout: code still readable, credentials hidden', () => {
    put(join(checkout, 'bots/cli_self/send-cred.json'), 'FAKE-self-in-checkout');
    put(join(checkout, 'bots/cli_other/send-cred.json'), 'FAKE-other-in-checkout');
    const argv = compile(join(home, 'proj'), checkout);
    expect(readable(join(checkout, 'dist/cli.js'), argv)).toBe(true);
    expect(readable(join(checkout, 'package.json'), argv)).toBe(true);
    expect(readable(join(checkout, '.env'), argv)).toBe(false);
    expect(readable(join(checkout, 'bots/cli_other/send-cred.json'), argv)).toBe(false);
    expect(readable(join(checkout, 'bots/cli_self/send-cred.json'), argv)).toBe(true);
  });
});
