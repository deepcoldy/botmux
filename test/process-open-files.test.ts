import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProcessOpenFiles, probeProcessOpenFiles, processOpenFilesDenial } from '../src/utils/process-open-files.js';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-open-files-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listProcessOpenFiles', () => {
  it('rejects non-positive / non-integer pids without probing', () => {
    expect(listProcessOpenFiles(0)).toBeUndefined();
    expect(listProcessOpenFiles(-1)).toBeUndefined();
    expect(listProcessOpenFiles(1.5)).toBeUndefined();
  });

  it('lists a file the process currently holds open', () => {
    const file = join(dir, 'held.jsonl');
    writeFileSync(file, '');
    const fd = openSync(file, 'r');
    try {
      const targets = listProcessOpenFiles(process.pid);
      expect(targets).toBeDefined();
      expect(targets).toContain(file);
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(process.platform !== 'linux')('skipDeleted drops procfs targets of unlinked files', () => {
    const file = join(dir, 'unlinked.jsonl');
    writeFileSync(file, '');
    const fd = openSync(file, 'r');
    try {
      unlinkSync(file);
      expect(listProcessOpenFiles(process.pid)).toContain(`${file} (deleted)`);
      expect(listProcessOpenFiles(process.pid, { skipDeleted: true })).not.toContain(`${file} (deleted)`);
    } finally {
      closeSync(fd);
    }
  });

  // procfs gives an exited-but-unreaped process's fd directory to root, so a
  // non-root caller is refused it exactly like a sandbox it may not read. That
  // process is gone, not hidden: it must never be reported as a refusal.
  it.skipIf(process.platform !== 'linux')('never reports an exited, unreaped process as a refusal', async () => {
    // `sleep 0` exits; its parent execs into a `sleep` that never reaps it.
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const pid = Number(await new Promise<string>(resolve => parent.stdout!.once('data', d => resolve(String(d).trim()))));
      const state = () => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return ''; } };
      for (let i = 0; i < 100 && !/\) Z /.test(state()); i++) await new Promise(r => setTimeout(r, 20));
      expect(state()).toMatch(/\) Z /);
      expect(probeProcessOpenFiles(pid).status).not.toBe('denied');
      expect(processOpenFilesDenial(pid)).toBeUndefined();
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it.skipIf(process.platform === 'linux')('fails soft within the bound when lsof stalls', () => {
    const fakeLsof = join(dir, 'lsof');
    writeFileSync(fakeLsof, '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ''}`;
    const startedAt = Date.now();
    try {
      expect(listProcessOpenFiles(process.pid)).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

// The lsof fallback, reachable on every platform: pid_max tops out at 2^22, so
// this pid never has a /proc entry and Linux takes the path macOS always takes.
describe('listProcessOpenFiles lsof fallback', () => {
  const NO_PROCFS_PID = 2 ** 22 + 4242;
  let originalPath: string | undefined;
  beforeEach(() => { originalPath = process.env.PATH; });
  afterEach(() => { process.env.PATH = originalPath; });

  function fakeLsof(body: string): void {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
  }

  it('asks lsof for numeric hosts/ports and keeps only path names', () => {
    const argvFile = join(dir, 'argv');
    fakeLsof(`printf '%s\\n' "$@" > '${argvFile}'\nprintf 'p1\\nn/tmp/held.jsonl\\nn->0xdead\\n'`);
    expect(listProcessOpenFiles(NO_PROCFS_PID)).toEqual(['/tmp/held.jsonl']);
    // Without -n/-P lsof resolves host and port names, which is what hangs it.
    expect(readFileSync(argvFile, 'utf8').split('\n'))
      .toEqual(expect.arrayContaining(['-n', '-P', '-p', String(NO_PROCFS_PID)]));
  });

  it('kills a stalled lsof that ignores SIGTERM within the bound', () => {
    fakeLsof(`trap '' TERM\nexec sleep 10`);
    const startedAt = Date.now();
    expect(listProcessOpenFiles(NO_PROCFS_PID)).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);
});

/**
 * pid → open-file probes must go through the bounded helper. Before it
 * existed, five transcript services each carried their own
 * `execSync('lsof -p …')` with no timeout, so a stalled lsof froze the worker
 * event loop.
 */
describe('lsof probes stay bounded', () => {
  it('no service or core module spawns an unbounded lsof', () => {
    const offenders: string[] = [];
    for (const sub of ['services', 'core']) {
      const root = new URL(`../src/${sub}/`, import.meta.url);
      for (const name of readdirSync(root)) {
        if (!name.endsWith('.ts')) continue;
        const source = readFileSync(new URL(name, root), 'utf8');
        if (/execSync\(\s*`lsof/.test(source)) offenders.push(`${sub}/${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
