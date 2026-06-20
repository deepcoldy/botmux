/**
 * Tests for symlink-aware cwd handling in the Claude Code adapter.
 *
 * Real bug: when botmux's `workingDir` is a symlink (e.g. /home/x →
 * /data00/home/x), Claude Code itself realpath's its cwd via getcwd(3)
 * before computing the project hash, so its on-disk JSONL lands under
 * `~/.claude/projects/-data00-home-x/`. botmux historically used the raw
 * symlink path, so its bridge watcher tailed `~/.claude/projects/-home-x/`,
 * which doesn't exist — and submit-confirm + the no-`botmux send` fallback
 * both silently broke.
 *
 * Run:  pnpm vitest run test/claude-code-cwd.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';

const SID = '01234567-89ab-cdef-0123-456789abcdef';

let tmpRoot: string;
let realDir: string;
let symDir: string;

beforeEach(() => {
  // realpathSync: on macOS os.tmpdir() is a symlink (/var → /private/var). The
  // helper realpath-resolves cwd, so the "already a real path" case must start
  // from an already-resolved root or the expected hash would lack /private.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-cwd-')));
  realDir = join(tmpRoot, 'real-target');
  symDir = join(tmpRoot, 'sym-link');
  mkdirSync(realDir);
  symlinkSync(realDir, symDir);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function expectedProjectFor(cwd: string): string {
  const projectHash = cwd.replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', projectHash, `${SID}.jsonl`);
}

describe('claudeJsonlPathForSession: symlink-aware cwd resolution', () => {
  it('returns the realpath-derived path when cwd is a symlink', () => {
    const got = claudeJsonlPathForSession(SID, symDir);
    // Claude Code itself runs under realpath(symDir) === realDir; the JSONL
    // lives in the project dir derived from realDir, NOT symDir.
    expect(got).toBe(expectedProjectFor(realDir));
    // Sanity: the would-be naive path (treating symDir literally) is different,
    // proving the test actually exercised symlink resolution.
    expect(got).not.toBe(expectedProjectFor(symDir));
  });

  it('is idempotent when cwd is already a real path', () => {
    const got = claudeJsonlPathForSession(SID, realDir);
    expect(got).toBe(expectedProjectFor(realDir));
  });

  it('falls back to the raw cwd when realpath fails (path does not exist)', () => {
    // realpathSync throws on a non-existent path. The helper catches and
    // returns the raw cwd so an upstream existsSync check can still surface
    // a meaningful "no such directory" error rather than masking it as a
    // path-resolution failure here.
    const ghost = join(tmpRoot, 'never-existed');
    const got = claudeJsonlPathForSession(SID, ghost);
    expect(got).toBe(expectedProjectFor(ghost));
  });
});
