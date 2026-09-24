/**
 * Linux bubblewrap regression for trigger-user identity refreshes.
 *
 * Identity files are written atomically (tmp + rename), so each update gets a
 * new inode. A persistent sandbox must bind the per-session directory: binding
 * the file itself would pin the inode that existed when the pane was spawned.
 */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionIdentityPath, writeSessionIdentity } from '../src/core/cli-identity.js';

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

describe.skipIf(!bwrapUsable())('bwrap persistent pane × trigger-user identity', () => {
  it('reads the identity inode atomically replaced after sandbox spawn', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-identity-bwrap-'));
    const ctlDir = mkdtempSync(join(tmpdir(), 'botmux-identity-ctl-'));
    const sessionId = 'sess-live';
    const identityPath = writeSessionIdentity(dataDir, sessionId, {
      tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'token-first',
    });
    const identityDir = dirname(identityPath);
    const sessionDir = dirname(identityDir);
    const firstInode = statSync(identityPath).ino;
    const script = [
      `printf ready > ${JSON.stringify(join(ctlDir, 'ready'))}`,
      `while [ ! -f ${JSON.stringify(join(ctlDir, 'go'))} ]; do sleep 0.05; done`,
      `cat ${JSON.stringify(identityPath)} > ${JSON.stringify(join(ctlDir, 'out'))}`,
    ].join('\n');
    const pane = spawn('bwrap', [
      '--unshare-user', '--die-with-parent',
      '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind', sessionDir, sessionDir,
      '--bind', ctlDir, ctlDir,
      '/usr/bin/sh', '-c', script,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    try {
      await pollFor(() => existsSync(join(ctlDir, 'ready')), 'sandbox reader ready');
      writeSessionIdentity(dataDir, sessionId, {
        tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'token-second',
      });
      expect(statSync(sessionIdentityPath(dataDir, sessionId, 'lark-cli')).ino).not.toBe(firstInode);
      writeFileSync(join(ctlDir, 'go'), '1');
      await pollFor(() => existsSync(join(ctlDir, 'out')), 'sandbox identity read');
      const body = readFileSync(join(ctlDir, 'out'), 'utf8');
      expect(body).toContain('token-second');
      expect(body).not.toContain('token-first');
    } finally {
      try { pane.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(ctlDir, { recursive: true, force: true });
    }
  });
});
