/**
 * Production-policy regression for trigger-user identity refreshes.
 *
 * Identity files are written atomically (tmp + rename), so each update gets a
 * new inode. A persistent sandbox must bind the per-session directory: binding
 * the file itself would pin the inode that existed when the pane was spawned.
 * The harness deliberately runs buildFsPolicy → compileToBwrap so it also locks
 * down the production authorization shape, not only bubblewrap's mount behavior.
 */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';
import {
  ensureSessionIdentityPlaceholders,
  sessionIdentityBinDir,
  sessionIdentityPath,
  writeSessionIdentity,
} from '../src/core/cli-identity.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

const USRMERGE = ['/bin', '/lib', '/lib64', '/sbin', '/lib32', '/libx32'];

function bwrapUsable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const probe = spawnSync('bwrap', [
      '--unshare-user', '--die-with-parent',
      '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '/usr/bin/true',
    ], { timeout: 10_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

async function pollFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

interface IdentityPolicyHarness {
  root: string;
  ctlDir: string;
  dataDir: string;
  sessionId: string;
  identityPath: string;
  sessionDir: string;
  args: string[];
}

function compileIdentityPolicy(): IdentityPolicyHarness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-identity-bwrap-')));
  const homeDir = join(root, 'home');
  const botmuxHome = join(homeDir, '.botmux');
  const dataDir = join(botmuxHome, 'data');
  const botHome = join(botmuxHome, 'bots', 'cli_app');
  const workingDir = join(root, 'project');
  const ctlDir = join(root, 'control');
  const emptyDir = join(root, 'masks', 'empty');
  const emptiesDir = join(root, 'masks', 'files');
  for (const dir of [botHome, workingDir, ctlDir, emptyDir, emptiesDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const sessionId = 'sess-live';
  ensureSessionIdentityPlaceholders(dataDir, sessionId, ['lark-cli', 'bytedcli']);
  const identityPath = writeSessionIdentity(dataDir, sessionId, {
    tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'token-first',
  });
  const sessionDir = sessionIdentityBinDir(dataDir, sessionId);
  const policy = buildFsPolicy({
    platform: 'linux',
    homeDir,
    botmuxHome,
    sessionDataDir: dataDir,
    sessionId,
    workingDir,
    currentAppId: 'cli_app',
    botHome,
    redirectedCliData: true,
    execPaths: [dirname(realpathSync(process.execPath))],
    userPaths: { readWrite: [ctlDir] },
    net: true,
    writeRegexes: [],
  });

  // Mirror the worker's impure preparation: only existing grants survive,
  // while denies remain so reachable masks are still compiled fail-closed.
  policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
  const symlinks: { path: string; target: string }[] = [];
  for (const path of USRMERGE) {
    try {
      if (lstatSync(path).isSymbolicLink()) symlinks.push({ path, target: readlinkSync(path) });
    } catch { /* absent on this distro */ }
  }
  const filePaths = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.access !== 'deny') continue;
    try { if (statSync(rule.path).isFile()) filePaths.add(rule.path); } catch { /* absent → dir mask */ }
  }
  const compiled = compileToBwrap(policy, {
    symlinks,
    emptyDir,
    emptiesDir,
    filePaths,
    chdir: workingDir,
  });
  chmodSync(emptyDir, 0o000);
  for (const file of compiled.emptyFiles) writeFileSync(file.path, '', { mode: 0o000 });
  for (const mount of compiled.maskMounts) {
    if (existsSync(mount.path)) continue;
    if (!mount.path.startsWith(`${root}/`)) {
      throw new Error(`refusing to create a test mask mount outside scratch: ${mount.path}`);
    }
    if (mount.kind === 'file') {
      mkdirSync(dirname(mount.path), { recursive: true });
      writeFileSync(mount.path, '');
    } else {
      mkdirSync(mount.path, { recursive: true });
    }
  }
  return { root, ctlDir, dataDir, sessionId, identityPath, sessionDir, args: compiled.args };
}

function compiledBinds(args: string[]): Array<{ mode: '--bind' | '--ro-bind'; source: string; target: string }> {
  const result: Array<{ mode: '--bind' | '--ro-bind'; source: string; target: string }> = [];
  for (let i = 0; i < args.length - 2; i += 1) {
    const mode = args[i];
    if (mode !== '--bind' && mode !== '--ro-bind') continue;
    result.push({ mode, source: args[i + 1]!, target: args[i + 2]! });
    i += 2;
  }
  return result;
}

describe('compileToBwrap × trigger-user identity', () => {
  it('emits one read-only session-directory bind and no mutable file binds', () => {
    const harness = compileIdentityPolicy();
    try {
      const identityRoot = join(harness.dataDir, 'cli-identity');
      const identityBinds = compiledBinds(harness.args).filter(bind =>
        bind.target === identityRoot || bind.target.startsWith(`${identityRoot}/`));
      expect(identityBinds).toEqual([
        { mode: '--ro-bind', source: harness.sessionDir, target: harness.sessionDir },
      ]);
      expect(identityBinds.some(bind =>
        bind.target.includes('/.data/') || bind.target.endsWith('/turn') || bind.target.endsWith('.env')))
        .toBe(false);
    } finally {
      rmSandboxScratch(harness.root);
    }
  });
});

describe.skipIf(!bwrapUsable())('bwrap persistent pane × trigger-user identity', () => {
  it('reads an atomically replaced identity through the production directory bind', async () => {
    const harness = compileIdentityPolicy();
    const firstInode = statSync(harness.identityPath).ino;
    const script = [
      `printf ready > ${JSON.stringify(join(harness.ctlDir, 'ready'))}`,
      `while [ ! -f ${JSON.stringify(join(harness.ctlDir, 'go'))} ]; do sleep 0.05; done`,
      `cat ${JSON.stringify(harness.identityPath)} > ${JSON.stringify(join(harness.ctlDir, 'out'))}`,
    ].join('\n');
    const pane = spawn('bwrap', [
      ...harness.args,
      '/usr/bin/sh', '-c', script,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    try {
      await pollFor(() => existsSync(join(harness.ctlDir, 'ready')), 'sandbox reader ready');
      writeSessionIdentity(harness.dataDir, harness.sessionId, {
        tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'token-second',
      });
      expect(statSync(sessionIdentityPath(harness.dataDir, harness.sessionId, 'lark-cli')).ino)
        .not.toBe(firstInode);
      writeFileSync(join(harness.ctlDir, 'go'), '1');
      await pollFor(() => existsSync(join(harness.ctlDir, 'out')), 'sandbox identity read');
      const body = readFileSync(join(harness.ctlDir, 'out'), 'utf8');
      expect(body).toContain('token-second');
      expect(body).not.toContain('token-first');
    } finally {
      try { pane.kill('SIGKILL'); } catch { /* already gone */ }
      rmSandboxScratch(harness.root);
    }
  });
});
