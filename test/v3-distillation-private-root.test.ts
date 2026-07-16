import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureV3DistillationScratchRoot,
  v3DistillationScratchRoot,
} from '../src/workflows/v3/distillation-private-root.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('v3 distillation private scratch root', () => {
  it('is private and idempotent in a uid-qualified host tmp root', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-distill-private-root-'));
    roots.push(base);

    const expected = v3DistillationScratchRoot(base);
    expect(ensureV3DistillationScratchRoot(base)).toBe(expected);
    expect(ensureV3DistillationScratchRoot(base)).toBe(expected);
    const stat = lstatSync(expected);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('rejects a pre-created symlink at the uid-qualified root', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-distill-private-root-'));
    roots.push(base);
    const target = join(base, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, v3DistillationScratchRoot(base));

    expect(() => ensureV3DistillationScratchRoot(base)).toThrow(
      'invalid workflow distillation scratch root',
    );
  });
});
