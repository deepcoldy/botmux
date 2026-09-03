import { beforeEach, describe, expect, it, vi } from 'vitest';

// A plain module-level const, deliberately NOT `vi.hoisted`. `vi.hoisted` is a
// vitest TRANSFORM (it physically lifts the call above the imports) and `bun test`
// has no equivalent — under bun this file died with "Unhandled error between
// tests" at the hoisted line. A plain const is safe under BOTH runners because the
// factory below only READS it when the mocked module is first resolved, which is
// after this statement has executed. (Verified on both runners, not assumed.)
const fakeFs = {
  closeCount: 0,
  openErrorCode: undefined as string | undefined,
  syncErrorCode: undefined as string | undefined,
};

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`mock ${code}`), { code });
}

// ⚠️ The real module is resolved with a LAZY `require` inside the factory, not via
// the factory's `importOriginal` argument and not via a top-level import.
//   · `importOriginal` is vitest-only — bun passes no argument, so awaiting it
//     throws, which is what made this file bun-hostile.
//   · A top-level `import * as actualFs` does NOT work either: vitest hoists
//     `vi.mock` ABOVE the imports, so the factory would read the namespace before
//     initialisation → "Cannot access '__vi_import_0__' before initialization".
//     MEASURED — that exact error is what the first migration attempt produced.
// A `require` evaluated at factory-call time satisfies both models: vitest has
// finished hoisting by then, and bun resolves it at the same moment.
vi.mock('node:fs', () => {
  const actual = require('node:fs') as typeof import('node:fs');
  return {
    ...actual,
    openSync(): number {
      if (fakeFs.openErrorCode) throw errno(fakeFs.openErrorCode);
      return 42;
    },
    fsyncSync(): void {
      if (fakeFs.syncErrorCode) throw errno(fakeFs.syncErrorCode);
    },
    closeSync(): void {
      fakeFs.closeCount++;
    },
  };
});

import { fsyncDirectorySyncPortable } from '../src/utils/fs-durability.js';

beforeEach(() => {
  fakeFs.closeCount = 0;
  fakeFs.openErrorCode = undefined;
  fakeFs.syncErrorCode = undefined;
});

describe('portable directory fsync error policy', () => {
  it('degrades only unsupported open/fsync errnos to best-effort', () => {
    fakeFs.openErrorCode = 'EINVAL';
    expect(() => fsyncDirectorySyncPortable('/virtual/run')).not.toThrow();
    expect(fakeFs.closeCount).toBe(0);

    fakeFs.openErrorCode = undefined;
    fakeFs.syncErrorCode = 'ENOTSUP';
    expect(() => fsyncDirectorySyncPortable('/virtual/run')).not.toThrow();
    expect(fakeFs.closeCount).toBe(1);
  });

  it('propagates real I/O and permission errors and still closes opened fds', () => {
    fakeFs.syncErrorCode = 'EIO';
    expect(() => fsyncDirectorySyncPortable('/virtual/run')).toThrow(/EIO/);
    expect(fakeFs.closeCount).toBe(1);

    fakeFs.syncErrorCode = undefined;
    fakeFs.openErrorCode = 'EACCES';
    expect(() => fsyncDirectorySyncPortable('/virtual/run')).toThrow(/EACCES/);
    expect(fakeFs.closeCount).toBe(1);
  });
});
