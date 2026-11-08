/**
 * killProcessTree (test/helpers/process-tree.ts) is what integration tests use
 * to take a worker down before deleting its private TMUX_TMPDIR. A tmux call
 * the worker still had in flight must die with it (#2214); a daemon that
 * already left the tree — the tmux server holding the pane a restarted worker
 * re-attaches to — must not.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killProcessTree } from './helpers/process-tree.js';

let dir: string;
let child: ChildProcess | undefined;
const strays: number[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'process-tree-')); });
afterEach(() => {
  try { child?.kill('SIGKILL'); } catch { /* exited */ }
  for (const pid of strays) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
  strays.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** A process that writes `marker` after `delayMs` unless it is killed first. */
const lateWriter = (marker: string, delayMs: number) =>
  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), ${delayMs});`;

/** Run `body` as a CommonJS child, resolved once it wrote `<dir>/ready`. */
async function startChild(body: string): Promise<ChildProcess> {
  const script = join(dir, 'child.cjs');
  writeFileSync(script, `${body}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'ready'))}, '');\nsetInterval(() => {}, 1000);\n`);
  const proc = spawn(process.execPath, [script], { stdio: 'ignore' });
  for (const deadline = Date.now() + 10_000; !existsSync(join(dir, 'ready'));) {
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error('child did not start');
    await new Promise(done => setTimeout(done, 20));
  }
  return proc;
}

const settle = (ms: number) => new Promise(done => setTimeout(done, ms));

describe.skipIf(process.platform === 'win32')('killProcessTree', () => {
  it('takes down a grandchild still running when its parent is killed', async () => {
    const marker = join(dir, 'grandchild-wrote');
    child = await startChild(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(lateWriter(marker, 800))}], { stdio: 'ignore' });
    `);

    await killProcessTree(child);
    await settle(1_500);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('an unreadable process table is warned about, never thrown, and the child is still killed', async () => {
    child = await startChild('');
    const exited = new Promise<void>(done => child!.once('exit', () => done()));
    const fakeBin = join(dir, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => { warnings.push(warning.message); };
    process.on('warning', onWarning);
    const path = process.env.PATH;
    process.env.PATH = `${fakeBin}:${path}`;
    try {
      // It runs in finally blocks: an error of its own would replace the real one.
      await expect(killProcessTree(child)).resolves.toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
    await Promise.race([exited, settle(3_000).then(() => { throw new Error('child was left stopped'); })]);
    await settle(50);
    process.off('warning', onWarning);
    expect(warnings.some(message => /process table unreadable.*ps failed/.test(message))).toBe(true);
  });

  it('leaves a daemon that already left the tree alone', async () => {
    const marker = join(dir, 'daemon-wrote');
    const pidFile = join(dir, 'daemon-pid');
    // Started through an intermediate that exits at once, like a tmux server:
    // it is reparented away from the child and is no longer its descendant.
    child = await startChild(`
      const { spawnSync } = require('node:child_process');
      spawnSync(process.execPath, ['-e', ${JSON.stringify(`
        const d = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lateWriter(marker, 800))}], { detached: true, stdio: 'ignore' });
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));
        d.unref();
      `)}], { stdio: 'ignore' });
    `);
    strays.push(Number(readFileSync(pidFile, 'utf8')));

    await killProcessTree(child);
    await settle(1_500);

    expect(existsSync(marker)).toBe(true);
  });
});
