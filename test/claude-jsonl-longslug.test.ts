import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClaudeSessionJsonlPath } from '../src/services/transcript-resolver.js';
import { resolveClaudeJsonlPath } from '../src/adapters/cli/claude-code.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jsonl-longslug-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const longCwd = '/' + 'a'.repeat(240); // slug ~240 chars → truncated + hash suffix
const sid = '01234567-89ab-cdef-0123-456789abcdef';
const jsonl = `${sid}.jsonl`;

function projects(dataDir: string) {
  return join(dataDir, 'projects');
}

describe('long-cwd truncated project slug (Claude opaque hash suffix)', () => {
  it('resolves the jsonl via prefix glob (resolver, follow mode)', () => {
    const dataDir = join(root, 'home');
    const slug = longCwd.replace(/[^A-Za-z0-9-]/g, '-');
    const hashedDir = join(projects(dataDir), `${slug.slice(0, 200)}-rnckgl`);
    mkdirSync(hashedDir, { recursive: true });
    writeFileSync(join(hashedDir, jsonl), '{}');

    const got = getClaudeSessionJsonlPath(sid, longCwd, dataDir);
    expect(got).toBe(join(hashedDir, jsonl));
  });

  it('resolves via the adapter helper used by the worker bridge', () => {
    const dataDir = join(root, 'home2');
    const slug = longCwd.replace(/[^A-Za-z0-9-]/g, '-');
    const hashedDir = join(projects(dataDir), `${slug.slice(0, 200)}-oqhkyd`);
    mkdirSync(hashedDir, { recursive: true });
    writeFileSync(join(hashedDir, jsonl), '{}');
    expect(resolveClaudeJsonlPath(sid, longCwd, dataDir)).toBe(join(hashedDir, jsonl));
  });

  it('returns null when no project dir matches the truncated prefix', () => {
    const dataDir = join(root, 'empty');
    mkdirSync(projects(dataDir), { recursive: true });
    expect(getClaudeSessionJsonlPath(sid, longCwd, dataDir)).toBeNull();
  });

  it('returns null on ambiguous multiple hash dirs carrying the same session', () => {
    const dataDir = join(root, 'ambig');
    const slug = longCwd.replace(/[^A-Za-z0-9-]/g, '-');
    for (const h of ['h1aaaa', 'h2bbbb']) {
      const d = join(projects(dataDir), `${slug.slice(0, 200)}-${h}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, jsonl), '{}');
    }
    expect(getClaudeSessionJsonlPath(sid, longCwd, dataDir)).toBeNull();
  });

  it('keeps the exact-path fast path for normal short cwds', () => {
    const dataDir = join(root, 'short');
    const cwd = '/home/u/proj';
    const d = join(projects(dataDir), '-home-u-proj');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, jsonl), '{}');
    expect(getClaudeSessionJsonlPath(sid, cwd, dataDir)).toBe(join(d, jsonl));
    expect(resolveClaudeJsonlPath(sid, cwd, dataDir)).toBe(join(d, jsonl));
  });
});
