import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  botmuxWorktreeIdentityMatches,
  deleteBotmuxWorktree,
  findBotmuxWorktreeFor,
  recordBotmuxWorktree,
} from '../src/services/botmux-worktree-store.js';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-worktree-store-')));
  dataDir = join(root, 'data');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('botmux worktree store', () => {
  it('finds the recorded worktree for the directory itself or anything below it, never a same-prefix sibling', () => {
    const wt = dir('proj-wt-a');
    dir('proj-wt-a/pkg/src');
    dir('proj-wt-ab');
    recordBotmuxWorktree(dataDir, { dir: wt, main: join(root, 'proj'), branch: 'wt/a', larkAppId: 'app' });

    expect(findBotmuxWorktreeFor(dataDir, wt)?.branch).toBe('wt/a');
    expect(findBotmuxWorktreeFor(dataDir, join(wt, 'pkg', 'src'))?.dir).toBe(wt);
    expect(findBotmuxWorktreeFor(dataDir, join(root, 'proj-wt-ab'))).toBeUndefined();
  });

  it('pins the directory identity so a re-created path no longer matches', () => {
    const wt = dir('proj-wt-a');
    const record = recordBotmuxWorktree(dataDir, { dir: wt, main: join(root, 'proj'), branch: 'wt/a' });
    expect(botmuxWorktreeIdentityMatches(record)).toBe(true);

    renameSync(wt, `${wt}-old`);
    mkdirSync(wt);
    expect(botmuxWorktreeIdentityMatches(record)).toBe(false);
  });

  it('drops records of directories that are gone when it next writes', () => {
    const gone = dir('proj-wt-gone');
    recordBotmuxWorktree(dataDir, { dir: gone, main: join(root, 'proj'), branch: 'wt/gone' });
    rmSync(gone, { recursive: true });

    recordBotmuxWorktree(dataDir, { dir: dir('proj-wt-new'), main: join(root, 'proj'), branch: 'wt/new' });
    mkdirSync(gone);
    expect(findBotmuxWorktreeFor(dataDir, gone)).toBeUndefined();
  });

  it('deletes one record', () => {
    const wt = dir('proj-wt-a');
    recordBotmuxWorktree(dataDir, { dir: wt, main: join(root, 'proj'), branch: 'wt/a' });

    expect(deleteBotmuxWorktree(dataDir, wt)).toBe(true);
    expect(findBotmuxWorktreeFor(dataDir, wt)).toBeUndefined();
    expect(deleteBotmuxWorktree(dataDir, wt)).toBe(false);
  });

  it('throws on a corrupt store rather than answering "not recorded"', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'botmux-worktrees.json'), '[]');
    expect(() => findBotmuxWorktreeFor(dataDir, root)).toThrow();
  });
});
