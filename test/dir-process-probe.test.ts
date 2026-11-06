/**
 * findProcessesWithCwdUnder: detection only. Every process here is spawned by
 * the test itself and reaped through its own ChildProcess handle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findLiveProcessReferences, findProcessesWithCwdUnder, parseLsofCwdOutput } from '../src/utils/dir-process-probe.js';

const children: ChildProcess[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dir-process-probe-')));
  dirs.push(dir);
  return dir;
}

async function sleeper(cwd: string): Promise<ChildProcess> {
  const child = spawn('sleep', ['30'], { cwd, stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findProcessesWithCwdUnder', () => {
  it.runIf(process.platform === 'linux')('finds a process whose cwd is the directory or below it, and only that one', async () => {
    const root = tempDir();
    const inside = join(root, 'wt');
    mkdirSync(join(inside, 'pkg'), { recursive: true });
    const elsewhere = join(root, 'wt-other');
    mkdirSync(elsewhere);
    const child = await sleeper(join(inside, 'pkg'));
    const sibling = await sleeper(elsewhere);

    const probe = await findProcessesWithCwdUnder(inside);
    expect(probe.status).toBe('ok');
    if (probe.status !== 'ok') return;
    expect(probe.pids).toContain(child.pid);
    expect(probe.pids).not.toContain(sibling.pid);
  });

  it.runIf(process.platform === 'linux')('stops reporting the process once it exits', async () => {
    const dir = tempDir();
    const child = await sleeper(dir);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    expect(await findProcessesWithCwdUnder(dir)).toEqual({ status: 'ok', pids: [] });
  });

  it('answers unknown when procfs cannot be listed', async () => {
    const probe = await findProcessesWithCwdUnder('/x', { platform: 'linux', procRoot: join(tmpdir(), 'no-such-proc-root') });
    expect(probe.status).toBe('unknown');
  });

  it('uses lsof off Linux and answers unknown when it is unavailable', async () => {
    expect(await findProcessesWithCwdUnder('/work/wt', {
      platform: 'darwin',
      runLsof: async () => 'p10\nfcwd\nn/work/wt/src\np11\nfcwd\nn/work/wt-other\n',
    })).toEqual({ status: 'ok', pids: [10] });
    const probe = await findProcessesWithCwdUnder('/work/wt', {
      platform: 'darwin',
      runLsof: async () => { throw new Error('spawn lsof ENOENT'); },
    });
    expect(probe).toEqual({ status: 'unknown', error: 'spawn lsof ENOENT' });
  });
});

describe('parseLsofCwdOutput', () => {
  it('matches the directory itself and descendants, not same-prefix siblings', () => {
    const out = ['p1', 'fcwd', 'n/work/wt', 'p2', 'fcwd', 'n/work/wt/a/b', 'p3', 'fcwd', 'n/work/wtx', 'p4', 'fcwd', 'n/'].join('\n');
    expect(parseLsofCwdOutput(out, '/work/wt').sort()).toEqual([1, 2]);
  });
});

/** A fake /proc entry: the probe only reads cmdline, environ and cwd. */
function fakeProcess(proc: string, pid: string, entry: { argv?: string[]; env?: string[]; cwd?: string }): void {
  const dir = join(proc, pid);
  mkdirSync(dir, { recursive: true });
  if (entry.argv) writeFileSync(join(dir, 'cmdline'), `${entry.argv.join('\0')}\0`);
  if (entry.env) writeFileSync(join(dir, 'environ'), `${entry.env.join('\0')}\0`);
  if (entry.cwd) symlinkSync(entry.cwd, join(dir, 'cwd'));
}

describe('findLiveProcessReferences', () => {
  it('finds a path in argv, in the start environment, or as cwd', async () => {
    const proc = tempDir();
    fakeProcess(proc, '101', { argv: ['bwrap', '--ro-bind', '/tmp/bmcp-0-aaaa', '/run/botmux-mcp'] });
    fakeProcess(proc, '102', { argv: ['claude'], env: ['TMPDIR=/scratch/p/k1', 'HOME=/root'] });
    fakeProcess(proc, '103', { argv: ['sh'], cwd: '/scratch/p/k2/build' });
    fakeProcess(proc, '104', { argv: ['sh'], cwd: '/scratch/p/k3x' });
    mkdirSync(join(proc, 'self'));

    const found = await findLiveProcessReferences(
      ['bmcp-0-aaaa', '/scratch/p/k1', '/scratch/p/k2', '/scratch/p/k3', '/scratch/p/unused'],
      { platform: 'linux', procRoot: proc },
    );

    expect([...(found ?? [])].sort()).toEqual(['/scratch/p/k1', '/scratch/p/k2', 'bmcp-0-aaaa']);
  });

  it('answers "cannot tell" when there is no process table to read', async () => {
    expect(await findLiveProcessReferences(['/x'], { platform: 'linux', procRoot: join(tempDir(), 'missing') })).toBeNull();
  });

  it('reads one ps listing with start environments off Linux, and cannot tell when ps fails', async () => {
    const listing = [
      '  101 /usr/local/bin/node daemon.js PATH=/usr/bin:/bin HOME=/Users/u',
      '  202 /usr/local/bin/claude --print TMPDIR=/Users/u/.cache/botmux/session-tmp/p/k1 HOME=/Users/u',
      '  303 /bin/zsh -l HOME=/Users/u',
    ].join('\n');
    const found = await findLiveProcessReferences(
      ['/Users/u/.cache/botmux/session-tmp/p/k1', '/Users/u/.cache/botmux/session-tmp/p/k2'],
      { platform: 'darwin', runPs: async () => listing, selfPid: 101 },
    );
    expect([...(found ?? [])]).toEqual(['/Users/u/.cache/botmux/session-tmp/p/k1']);
    expect(await findLiveProcessReferences(['/x'], {
      platform: 'darwin', runPs: async () => { throw new Error('ps: not found'); }, selfPid: 101,
    })).toBeNull();
  });

  it('cannot tell when ps runs but shows no start environments', async () => {
    const listing = [
      '  101 /usr/local/bin/node daemon.js',
      '  202 /usr/local/bin/claude --print',
    ].join('\n');
    expect(await findLiveProcessReferences(['/Users/u/.cache/botmux/session-tmp/p/k1'], {
      platform: 'darwin', runPs: async () => listing, selfPid: 101,
    })).toBeNull();
  });

  it.runIf(process.platform === 'linux')('sees a real process that runs with TMPDIR and cwd in the directory', async () => {
    const scratch = tempDir();
    const other = tempDir();
    const child = spawn('sleep', ['30'], { cwd: scratch, env: { ...process.env, TMPDIR: scratch }, stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });

    const found = await findLiveProcessReferences([scratch, other]);

    expect(found?.has(scratch)).toBe(true);
    expect(found?.has(other)).toBe(false);
  });
});
