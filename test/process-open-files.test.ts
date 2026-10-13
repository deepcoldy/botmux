import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProcessOpenFiles } from '../src/utils/process-open-files.js';

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

/**
 * Source lock: pid → open-file probes must go through the bounded helper.
 * Before it existed, five transcript services each carried their own
 * `execSync('lsof -p …')` with no timeout, so a stalled lsof froze the worker
 * event loop. Pin both the helper's bounds and the absence of raw copies.
 */
describe('lsof probes stay bounded', () => {
  const helperSource = readFileSync(new URL('../src/utils/process-open-files.ts', import.meta.url), 'utf8');

  it('the helper runs lsof shell-free with a hard timeout and no name resolution', () => {
    expect(helperSource).toContain("execFileSync('lsof', ['-n', '-P', '-p', String(pid), '-Fn'], LSOF_EXEC_OPTIONS)");
    expect(helperSource).toMatch(/timeout: LSOF_TIMEOUT_MS/);
    expect(helperSource).toMatch(/killSignal: 'SIGKILL'/);
    expect(helperSource).not.toContain('execSync(');
  });

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
