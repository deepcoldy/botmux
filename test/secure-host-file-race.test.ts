import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsRace = {
  afterDirectoryOpen: undefined as undefined | (() => void),
};

vi.mock('node:fs', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
  const actual = require('node:fs') as typeof import('node:fs');
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
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';

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

  it('keeps the dashboard token lock+write on the pinned dir when an ancestor is swapped', () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'botmux-token-race-'));
    roots.push(root);
    chmodSync(root, 0o777);
    const visibleRoot = join(root, 'visible');
    const movedRoot = join(root, 'moved');
    const visibleBotmux = join(visibleRoot, '.botmux');
    const tokenPath = join(visibleBotmux, '.dashboard-token');
    const movedLeaf = join(movedRoot, '.botmux', '.dashboard-token');
    mkdirSync(visibleBotmux, { recursive: true, mode: 0o700 });

    // Right after the credential parent fd is pinned, rename the whole ancestor
    // aside and drop a 0777 trap directory back into the old path. If the lock
    // or the token write re-resolved the pathname instead of the pinned fd,
    // they would land in (or be redirected through) the attacker-writable trap.
    fsRace.afterDirectoryOpen = () => {
      renameSync(visibleRoot, movedRoot);
      mkdirSync(visibleBotmux, { recursive: true, mode: 0o777 });
      chmodSync(visibleBotmux, 0o777);
    };

    const token = loadOrCreatePersistedToken(tokenPath);

    // Token + its lock landed in the pinned (moved) directory, never the trap.
    expect(readFileSync(movedLeaf, 'utf8').trim()).toBe(token);
    expect(lstatSync(movedLeaf).mode & 0o777).toBe(0o600);
    expect(existsSync(tokenPath)).toBe(false);
    expect(existsSync(`${tokenPath}.lock`)).toBe(false);
  });
});
