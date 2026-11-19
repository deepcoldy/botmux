/**
 * readJsonLines (test/helpers/read-json-lines.ts) is how integration tests
 * poll a JSON Lines file a fake CLI or fixture server is still appending to.
 * A poll that lands inside one append must not throw (#2228).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonLines } from './helpers/read-json-lines.js';

let dir: string;
let writer: ChildProcess | undefined;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'read-json-lines-')); });
afterEach(() => {
  try { writer?.kill('SIGKILL'); } catch { /* exited */ }
  writer = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms: number) => new Promise(done => setTimeout(done, ms));

describe('readJsonLines', () => {
  it('returns the complete lines and leaves a trailing fragment for the next read', () => {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '{"n":1}\n\n{"n":2}\n{"n":3,"te');
    expect(readJsonLines(file)).toEqual([{ n: 1 }, { n: 2 }]);
    writeFileSync(file, '{"n":1}\n\n{"n":2}\n{"n":3,"text":"done"}\n');
    expect(readJsonLines(file)).toEqual([{ n: 1 }, { n: 2 }, { n: 3, text: 'done' }]);
  });

  it('reads a missing file as no lines', () => {
    expect(readJsonLines(join(dir, 'not-written-yet.jsonl'))).toEqual([]);
  });

  it('still throws on a complete line that is not JSON: a fixture bug is not a race', () => {
    const file = join(dir, 'broken.jsonl');
    writeFileSync(file, '{"n":1}\nnot json\n');
    expect(() => readJsonLines(file)).toThrow(SyntaxError);
  });

  it('polling a line another process appends in two parts never throws and ends with the whole line', async () => {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '{"n":1}\n');
    const line = JSON.stringify({ n: 2, text: 'second event' });
    // Our own writer: the first half, a pause, then the rest with its newline.
    writer = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const file = ${JSON.stringify(file)};
      const line = ${JSON.stringify(line)};
      fs.appendFileSync(file, line.slice(0, 10));
      setTimeout(() => fs.appendFileSync(file, line.slice(10) + '\\n'), 300);
    `], { stdio: 'ignore' });

    let sawFragment = false;
    let rows = readJsonLines(file);
    for (const deadline = Date.now() + 10_000; rows.length < 2;) {
      if (Date.now() > deadline) throw new Error('the second line never completed');
      await settle(10);
      if (!readFileSync(file, 'utf8').endsWith('\n')) sawFragment = true;
      rows = readJsonLines(file);
    }

    expect(sawFragment).toBe(true);
    expect(rows).toEqual([{ n: 1 }, { n: 2, text: 'second event' }]);
  });
});
