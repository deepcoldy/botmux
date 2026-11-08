// 第一个 import：测试围栏（unit-setup / bun-test-fence）没生效时整个文件直接拒跑。
import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';

// Tests run as root here, where a real permission check always passes, so a
// read-only root is simulated at `accessSync`. `require` inside the factory:
// bun passes no `importOriginal`.
vi.mock('node:fs', () => {
  const actual = require('node:fs') as typeof import('node:fs');
  return { ...actual, accessSync: vi.fn(actual.accessSync) };
});

import { worktreeTargetPath } from '../src/services/git-worktree.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';

describe('worktreeRoot that is not writable', () => {
  let tempRoot: string;
  let root: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'git-worktree-root-ro-')));
    root = join(tempRoot, 'wt-root');
    mkdirSync(root);
    const configFile = join(tempRoot, 'config.json');
    writeFileSync(configFile, JSON.stringify({ worktreeRoot: root }));
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', configFile);
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back next to the repo, and goes back under the root once it is writable again', () => {
    const parent = join(tempRoot, 'repos');
    const repo = join(parent, 'proj');
    vi.mocked(accessSync).mockImplementationOnce((path, mode) => {
      if (path === root && mode === constants.W_OK) {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      }
    });

    expect(worktreeTargetPath(repo, 'proj-wt-1')).toBe(join(parent, 'proj-wt-1'));
    expect(worktreeTargetPath(repo, 'proj-wt-1')).toBe(join(root, relative(parse(parent).root, parent), 'proj-wt-1'));
  });
});
