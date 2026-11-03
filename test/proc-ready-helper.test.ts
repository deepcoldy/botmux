import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readPidFileWhenReady } from './helpers/proc-ready.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'proc-ready-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  children.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('readPidFileWhenReady', () => {
  it('returns the pid from an already-complete pidfile', () => {
    const f = join(tmp(), 'p.pid');
    writeFileSync(f, ' 12345\n');
    expect(readPidFileWhenReady(f, 50)).toBe(12345);
  });

  it('waits through the open→write window instead of reading the empty file as NaN', () => {
    const f = join(tmp(), 'p.pid');
    // Separate process: create the path first (visible but empty), then land the
    // digits 150ms later — a deterministic version of the create-then-write race.
    const child = spawn(process.execPath, ['-e',
      `const fs=require('fs');fs.closeSync(fs.openSync(${JSON.stringify(f)},'w'));`
      + `setTimeout(()=>fs.writeFileSync(${JSON.stringify(f)},'777'),150);`
      + `setTimeout(()=>process.exit(0),2000);`], { stdio: 'ignore' });
    children.push(child);
    expect(readPidFileWhenReady(f, 2_000)).toBe(777);
  });

  it('throws a descriptive error when the file never holds a valid pid', () => {
    const f = join(tmp(), 'p.pid');
    closeSync(openSync(f, 'w')); // exists and stays empty
    expect(() => readPidFileWhenReady(f, 60)).toThrow(/never held a valid pid/);
  });
});
