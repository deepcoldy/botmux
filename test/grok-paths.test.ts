/**
 * Unit tests for Grok cwd bucket resolution (HOME symlink / getcwd mismatch).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encodeGrokCwd,
  grokPromptHistoryPath,
  resolveGrokCwdBucketDir,
} from '../src/services/grok-paths.js';

// tmpdir() itself is a symlink on macOS (/var → /private/var); canonicalize so
// the scaffold's own root is not a confounder when asserting symlink
// normalization (see test/claude-code-cwd.test.ts).
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-grok-paths-')));
const itPosix = it.skipIf(process.platform === 'win32');

describe('resolveGrokCwdBucketDir / symlink cwd', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  function makeLinkedCwd(tag: string): { physicalCwd: string; logicalCwd: string } {
    const physicalHome = join(ROOT, `data00-home-${tag}`);
    const logicalHome = join(ROOT, `home-${tag}`);
    mkdirSync(physicalHome, { recursive: true });
    symlinkSync(physicalHome, logicalHome);
    const physicalCwd = join(physicalHome, 'proj');
    const logicalCwd = join(logicalHome, 'proj');
    mkdirSync(physicalCwd, { recursive: true });
    expect(realpathSync(logicalCwd)).toBe(realpathSync(physicalCwd));
    return { physicalCwd, logicalCwd };
  }

  itPosix('finds the physical-cwd bucket when botmux holds a HOME-symlink path', () => {
    const { physicalCwd, logicalCwd } = makeLinkedCwd('main');

    const physicalBucket = join(ROOT, 'sessions', encodeGrokCwd(physicalCwd));
    mkdirSync(physicalBucket, { recursive: true });
    writeFileSync(join(physicalBucket, 'prompt_history.jsonl'), '');

    expect(join(ROOT, 'sessions', encodeGrokCwd(logicalCwd))).not.toBe(physicalBucket);
    expect(existsSync(join(ROOT, 'sessions', encodeGrokCwd(logicalCwd)))).toBe(false);

    expect(resolveGrokCwdBucketDir(logicalCwd)).toBe(physicalBucket);
    expect(grokPromptHistoryPath(logicalCwd)).toBe(join(physicalBucket, 'prompt_history.jsonl'));
    expect(existsSync(grokPromptHistoryPath(logicalCwd))).toBe(true);
  });

  itPosix('predicts Grok getcwd() bucket when nothing exists on disk yet', () => {
    const { physicalCwd, logicalCwd } = makeLinkedCwd('empty');

    expect(resolveGrokCwdBucketDir(logicalCwd)).toBe(
      join(ROOT, 'sessions', encodeGrokCwd(physicalCwd)),
    );
  });

  itPosix('matches a hashed .cwd marker written with the physical path', () => {
    const { physicalCwd, logicalCwd } = makeLinkedCwd('hash');

    const hashBucket = join(ROOT, 'sessions', 'phys-hash-abcd');
    mkdirSync(hashBucket, { recursive: true });
    writeFileSync(join(hashBucket, '.cwd'), physicalCwd + '\n');
    writeFileSync(join(hashBucket, 'prompt_history.jsonl'), '');

    expect(resolveGrokCwdBucketDir(logicalCwd)).toBe(hashBucket);
    expect(existsSync(grokPromptHistoryPath(logicalCwd))).toBe(true);
  });

  itPosix('does not let an empty encoded logical dir shadow the physical prompt_history', () => {
    const { physicalCwd, logicalCwd } = makeLinkedCwd('shadow-encoded');

    const logicalBucket = join(ROOT, 'sessions', encodeGrokCwd(logicalCwd));
    const physicalBucket = join(ROOT, 'sessions', encodeGrokCwd(physicalCwd));
    mkdirSync(logicalBucket, { recursive: true });
    mkdirSync(physicalBucket, { recursive: true });
    writeFileSync(join(physicalBucket, 'prompt_history.jsonl'), '');

    expect(resolveGrokCwdBucketDir(logicalCwd)).toBe(physicalBucket);
    expect(existsSync(grokPromptHistoryPath(logicalCwd))).toBe(true);
  });

  it('keeps a trailing space when predicting a not-yet-created bucket', () => {
    const cwd = join(ROOT, 'proj') + ' ';
    expect(resolveGrokCwdBucketDir(cwd)).toBe(
      join(ROOT, 'sessions', encodeGrokCwd(cwd)),
    );
  });

  itPosix('does not let an empty encoded dir shadow a hashed bucket with prompt_history', () => {
    const { physicalCwd, logicalCwd } = makeLinkedCwd('shadow-hash');

    const logicalBucket = join(ROOT, 'sessions', encodeGrokCwd(logicalCwd));
    mkdirSync(logicalBucket, { recursive: true });

    const hashBucket = join(ROOT, 'sessions', 'phys-hash-shadow');
    mkdirSync(hashBucket, { recursive: true });
    writeFileSync(join(hashBucket, '.cwd'), physicalCwd + '\n');
    writeFileSync(join(hashBucket, 'prompt_history.jsonl'), '');

    expect(resolveGrokCwdBucketDir(logicalCwd)).toBe(hashBucket);
    expect(existsSync(grokPromptHistoryPath(logicalCwd))).toBe(true);
  });
});
