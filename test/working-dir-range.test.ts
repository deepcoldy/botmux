/**
 * A bot's configured directory range (design 2026-11-03 §15.4): the one rule
 * Gate-2 (`approve-dag --working-dir`) and the executing bot's daemon both
 * apply. Real directories and symlinks in a temp tree; no config mocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { checkBotWorkingDir } from '../src/core/working-dir-range.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'wd-range-'));
  roots.push(root);
  const repos = join(root, 'repos');
  const project = join(repos, 'project');
  const outside = join(root, 'outside');
  const pinned = join(root, 'pinned');
  for (const dir of [join(project, 'sub'), outside, pinned]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repos, 'notes.txt'), 'x');
  return { root, repos, project, outside, pinned };
}

describe('checkBotWorkingDir', () => {
  it('a directory at or below a repo root (workingDirs) or the default working dir is in range', () => {
    const t = tree();
    const cfg = { workingDirs: [t.repos], defaultWorkingDir: t.pinned };
    expect(checkBotWorkingDir(cfg, t.repos)).toEqual({ ok: true, path: realpathSync(t.repos) });
    expect(checkBotWorkingDir(cfg, join(t.project, 'sub'))).toEqual({ ok: true, path: realpathSync(join(t.project, 'sub')) });
    expect(checkBotWorkingDir(cfg, t.pinned)).toEqual({ ok: true, path: realpathSync(t.pinned) });
  });

  it('a sibling, a parent, or a name that only shares a prefix is out of range', () => {
    const t = tree();
    mkdirSync(`${t.repos}-old`);
    const cfg = { workingDirs: [t.repos] };
    for (const dir of [t.outside, t.root, `${t.repos}-old`]) {
      expect(checkBotWorkingDir(cfg, dir)).toMatchObject({ ok: false, reason: 'outside_range' });
    }
  });

  it('the legacy comma-separated workingDir and the Oncall-mode directory count as configured', () => {
    const t = tree();
    expect(checkBotWorkingDir({ workingDir: `${t.outside}, ${t.repos}` }, t.project)).toMatchObject({ ok: true });
    expect(checkBotWorkingDir({ defaultOncall: { enabled: true, workingDir: t.pinned } } as never, t.pinned)).toMatchObject({ ok: true });
    // A disabled Oncall mode names no directory.
    expect(checkBotWorkingDir({ defaultOncall: { enabled: false, workingDir: t.pinned } } as never, t.pinned))
      .toMatchObject({ ok: false, reason: 'no_range' });
  });

  it('a bot that configures no directory has no range', () => {
    const t = tree();
    expect(checkBotWorkingDir({}, t.project)).toMatchObject({ ok: false, reason: 'no_range' });
  });

  it('a missing path or a file is refused before any range check', () => {
    const t = tree();
    const cfg = { workingDirs: [t.repos] };
    expect(checkBotWorkingDir(cfg, join(t.repos, 'gone'))).toMatchObject({ ok: false, reason: 'missing' });
    expect(checkBotWorkingDir(cfg, join(t.repos, 'notes.txt'))).toMatchObject({ ok: false, reason: 'not_directory' });
  });

  it('trailing slashes and `..` segments are normalised the same way on both sides', () => {
    const t = tree();
    expect(checkBotWorkingDir({ workingDirs: [`${t.repos}/`] }, `${t.project}/sub/../`)).toEqual({ ok: true, path: realpathSync(t.project) });
  });

  it('`~` expands to the home directory on both sides', () => {
    const t = tree();
    const home = homedir();
    // Only meaningful when the temp tree lives under $HOME; otherwise check
    // that `~` alone is a root covering everything below the home dir.
    const insideHome = !relative(home, t.project).startsWith('..');
    const viaTilde = insideHome ? `~/${relative(home, t.project)}` : undefined;
    if (viaTilde) expect(checkBotWorkingDir({ workingDirs: [t.repos] }, viaTilde)).toEqual({ ok: true, path: realpathSync(t.project) });
    expect(checkBotWorkingDir({ workingDirs: ['~'] }, home)).toEqual({ ok: true, path: realpathSync(home) });
  });

  it('symlinks are resolved before comparing: a link inside the range that leads outside is refused', () => {
    const t = tree();
    const escape = join(t.repos, 'escape');
    symlinkSync(t.outside, escape);
    expect(checkBotWorkingDir({ workingDirs: [t.repos] }, escape)).toMatchObject({ ok: false, reason: 'outside_range', path: escape });
  });

  it('…and a link to a directory inside the range (or a linked root) is accepted as its target: frozen and started in is the realpath', () => {
    const t = tree();
    const alias = join(t.outside, 'project-link');
    symlinkSync(t.project, alias);
    expect(checkBotWorkingDir({ workingDirs: [t.repos] }, alias)).toEqual({ ok: true, path: realpathSync(t.project) });
    const linkedRoot = join(t.root, 'repos-link');
    symlinkSync(t.repos, linkedRoot);
    expect(checkBotWorkingDir({ workingDirs: [linkedRoot] }, t.project)).toEqual({ ok: true, path: realpathSync(t.project) });
    // The real path of the temp root itself (macOS: /var → /private/var).
    expect(checkBotWorkingDir({ workingDirs: [realpathSync(t.repos)] }, t.project)).toMatchObject({ ok: true });
  });
});
