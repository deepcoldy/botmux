/**
 * `tmpDir` keeps the temporary file of an atomic write out of the target
 * directory. The send-cred writers use it when `sandboxWithholdBotSecret`
 * denies only the exact credential file inside a sandbox-readable BOT_HOME.
 *
 * Run: npx vitest run --project unit test/atomic-write-tmpdir.test.ts
 */
// Must stay the first import: this file mocks node:fs, so refuse to run outside
// a fenced data dir (see the helper's comment).
import './helpers/require-fenced-data-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const opened = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => { opened.push(String(args[0])); return actual.openSync(...args); } };
});

import { atomicWriteFileSync } from '../src/utils/atomic-write.js';

let root = '';
afterEach(() => { rmSync(root, { recursive: true, force: true }); opened.length = 0; });

describe('atomicWriteFileSync tmpDir', () => {
  it('creates the temporary file in tmpDir, never next to the target', () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-atomic-tmpdir-'));
    const home = join(root, 'bots', 'cli_x');
    mkdirSync(home, { recursive: true });
    const target = join(home, 'send-cred.json');
    atomicWriteFileSync(target, '{"s":1}', { mode: 0o600, tmpDir: dirname(home) });
    expect(readFileSync(target, 'utf8')).toBe('{"s":1}');
    const temps = opened.filter(p => p.includes('send-cred.json.') && p.endsWith('.tmp'));
    expect(temps.length).toBeGreaterThan(0);
    for (const t of temps) expect(dirname(t)).toBe(dirname(home));
    expect(readdirSync(home)).toEqual(['send-cred.json']);
    expect(readdirSync(dirname(home))).toEqual(['cli_x']);
  });
});
