import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsRace = vi.hoisted(() => ({
  afterDirectoryOpen: undefined as undefined | (() => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(
      path: import('node:fs').PathLike,
      flags: import('node:fs').OpenMode,
      mode?: import('node:fs').Mode,
    ): number {
      const fd = actual.openSync(path, flags, mode);
      if (
        process.platform === 'linux'
        && typeof flags === 'number'
        && (flags & actual.constants.O_DIRECTORY) !== 0
        && fsRace.afterDirectoryOpen
      ) {
        const hook = fsRace.afterDirectoryOpen;
        fsRace.afterDirectoryOpen = undefined;
        hook();
      }
      return fd;
    },
  };
});

import { writeSecureHostFileSync } from '../src/platform/secure-host-file.js';

const roots: string[] = [];

afterEach(() => {
  fsRace.afterDirectoryOpen = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('secure host authority directory pinning', () => {
  it('does not redirect a Linux write when an ancestor changes after directory open', () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'botmux-secure-host-race-'));
    roots.push(root);
    chmodSync(root, 0o777);
    const visibleRoot = join(root, 'visible');
    const movedRoot = join(root, 'moved');
    const visibleDirectory = join(visibleRoot, '.botmux');
    const movedFile = join(movedRoot, '.botmux', 'platform.json');
    const trapFile = join(visibleDirectory, 'platform.json');
    mkdirSync(visibleDirectory, { recursive: true, mode: 0o700 });

    fsRace.afterDirectoryOpen = () => {
      renameSync(visibleRoot, movedRoot);
      mkdirSync(visibleDirectory, { recursive: true, mode: 0o777 });
      chmodSync(visibleDirectory, 0o777);
    };

    writeSecureHostFileSync(trapFile, 'secret');

    expect(readFileSync(movedFile, 'utf8')).toBe('secret');
    expect(existsSync(trapFile)).toBe(false);
  });
});
