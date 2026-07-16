import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeFs = vi.hoisted(() => ({
  closeCount: 0,
  openErrorCode: undefined as string | undefined,
  syncErrorCode: undefined as string | undefined,
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`mock ${code}`), { code });
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
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
