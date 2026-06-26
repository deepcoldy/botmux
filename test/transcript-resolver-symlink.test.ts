import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getClaudeSessionJsonlPath } from '../src/services/transcript-resolver.js';

// Regression: a symlinked cwd (the real-world case: /home/<user> → /data00/home/<user>)
// must resolve to the SAME project key Claude Code writes under. Claude keys
// projects by realpath; a lexical resolve() would key by the symlink path,
// miss the transcript, and make the usage ledger silently write no delta.
describe('getClaudeSessionJsonlPath — symlinked cwd', () => {
  const trash: string[] = [];
  afterEach(() => { for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('keys the project by the realpath of a symlinked cwd, not the lexical path', () => {
    const base = mkdtempSync(join(tmpdir(), 'botmux-symlink-'));
    trash.push(base);

    // Real working dir + a symlink pointing at it (mimics /home → /data00).
    const realDir = join(base, 'data00', 'work');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(join(base, 'home'), { recursive: true });
    const linkDir = join(base, 'home', 'work');
    symlinkSync(realDir, linkDir);

    // Claude writes the transcript under the REAL path's project key.
    const dataDir = join(base, '.claude');
    const realKey = realpathSync(realDir).replace(/[^A-Za-z0-9-]/g, '-');
    const sid = 'sess-1';
    mkdirSync(join(dataDir, 'projects', realKey), { recursive: true });
    const expected = join(dataDir, 'projects', realKey, `${sid}.jsonl`);
    writeFileSync(expected, '{}');

    // Query with the SYMLINK path (as botmux sessions do) → must still find it.
    expect(getClaudeSessionJsonlPath(sid, linkDir, dataDir)).toBe(expected);
  });

  it('still resolves a plain (non-symlinked) cwd', () => {
    const base = mkdtempSync(join(tmpdir(), 'botmux-symlink-'));
    trash.push(base);
    const cwd = join(base, 'work');
    mkdirSync(cwd, { recursive: true });
    const dataDir = join(base, '.claude');
    const key = realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-');
    const sid = 'sess-2';
    mkdirSync(join(dataDir, 'projects', key), { recursive: true });
    const expected = join(dataDir, 'projects', key, `${sid}.jsonl`);
    writeFileSync(expected, '{}');

    expect(getClaudeSessionJsonlPath(sid, cwd, dataDir)).toBe(expected);
  });

  it('returns null when no transcript exists at the resolved key', () => {
    const base = mkdtempSync(join(tmpdir(), 'botmux-symlink-'));
    trash.push(base);
    const cwd = join(base, 'work');
    mkdirSync(cwd, { recursive: true });
    expect(getClaudeSessionJsonlPath('missing', cwd, join(base, '.claude'))).toBeNull();
  });

  it('falls back to a lexical resolve when cwd is not on disk (realpath throws)', () => {
    const base = mkdtempSync(join(tmpdir(), 'botmux-symlink-'));
    trash.push(base);
    // cwd does not exist → realpathSync throws → lexical fallback keeps old behavior.
    const ghost = join(base, 'gone', 'work');
    const dataDir = join(base, '.claude');
    const key = ghost.replace(/[^A-Za-z0-9-]/g, '-');
    const sid = 'sess-3';
    mkdirSync(join(dataDir, 'projects', key), { recursive: true });
    const expected = join(dataDir, 'projects', key, `${sid}.jsonl`);
    writeFileSync(expected, '{}');

    expect(getClaudeSessionJsonlPath(sid, ghost, dataDir)).toBe(expected);
  });
});
