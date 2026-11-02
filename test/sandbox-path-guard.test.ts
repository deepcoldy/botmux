import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downgradeForbiddenReadWrite,
  dropReadOnlyLauncherMountCovers,
  findForbiddenReadWritePaths,
  findReadOnlyLauncherMountCovers,
  resolveStoredSandboxPaths,
  findNonAbsoluteSandboxEntries,
  forbiddenReadWriteMessage,
  type ProtectedRoots,
} from '../src/services/sandbox-path-guard.js';
import { accessForPath, buildFsPolicy } from '../src/adapters/cli/fs-policy.js';

describe('sandbox readWrite guard', () => {
  let root: string;
  let roots: ProtectedRoots;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-sbx-guard-'));
    const home = join(root, 'home', 'alice');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    mkdirSync(join(root, 'data', 'botmux'), { recursive: true });
    roots = { homeDirs: [home], botmuxHomes: [join(home, '.botmux'), join(root, 'data', 'botmux')] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const reasons = (paths: string[]) =>
    findForbiddenReadWritePaths(paths, roots).map(f => [f.path, f.reason]);

  it('rejects the filesystem root in every spelling', () => {
    expect(reasons(['/', '//', '/./', ' / '])).toEqual([
      ['/', 'filesystem_root'], ['//', 'filesystem_root'], ['/./', 'filesystem_root'], [' / ', 'filesystem_root'],
    ]);
  });

  it('rejects HOME, its ancestors and `~` forms', () => {
    const home = roots.homeDirs[0]!;
    expect(reasons(['~', '~/', home, `${home}/`, join(root, 'home'), `${home}/../alice`, '~/..'])).toEqual([
      ['~', 'home'], ['~/', 'home'], [home, 'home'], [`${home}/`, 'home'],
      [join(root, 'home'), 'home'], [`${home}/../alice`, 'home'], ['~/..', 'home'],
    ]);
  });

  it('rejects the botmux data roots (default and configured) and their ancestors', () => {
    expect(reasons(['~/.botmux', join(root, 'data', 'botmux'), join(root, 'data')])).toEqual([
      ['~/.botmux', 'botmux_home'], [join(root, 'data', 'botmux'), 'botmux_home'], [join(root, 'data'), 'botmux_home'],
    ]);
  });

  it('rejects a symlink that resolves to a protected root', () => {
    const link = join(root, 'innocent');
    symlinkSync(roots.homeDirs[0]!, link);
    const rootLink = join(root, 'rootlink');
    symlinkSync('/', rootLink);
    expect(reasons([link, rootLink])).toEqual([[link, 'home'], [rootLink, 'filesystem_root']]);
  });

  it('rejects relative readWrite entries: they resolve against the session working directory', () => {
    // `..` from a session in ~/proj is a write grant on HOME, `../..` one on
    // `/`; `~user` is not expanded (same regex as the worker) so it is
    // relative too. Absolute spellings that traverse up stay classified by
    // the root they hit.
    expect(reasons(['..', '../..', './rel', 'relative/dir', '~alice'])).toEqual([
      ['..', 'relative_path'], ['../..', 'relative_path'], ['./rel', 'relative_path'],
      ['relative/dir', 'relative_path'], ['~alice', 'relative_path'],
    ]);
    expect(reasons(['~/..', `${roots.homeDirs[0]}/../alice`]).map(([, reason]) => reason)).toEqual(['home', 'home']);
  });

  it('accepts deeper paths and siblings with a shared name prefix', () => {
    const home = roots.homeDirs[0]!;
    expect(reasons([
      '~/projects/app', `${home}/.botmux/bots/x/work`, `${home}-other`, join(root, 'data', 'botmux-cache'),
      '/opt/proj',
    ])).toEqual([]);
  });

  it('lists relative readOnly/deny entries for the save-time shape check, accepts absolute ones', () => {
    expect(findNonAbsoluteSandboxEntries({
      readWrite: ['/opt/rw'], readOnly: ['..', '~/ro'], deny: ['./secret', '/etc/deny', ''],
    }, roots.homeDirs[0]!)).toEqual([
      { path: '..', tier: 'readOnly' },
      { path: './secret', tier: 'deny' },
      { path: '', tier: 'deny' },
    ]);
  });

  it('names every offending entry in the message', () => {
    const message = forbiddenReadWriteMessage(findForbiddenReadWritePaths(['/', '~'], roots));
    expect(message).toContain('「/」');
    expect(message).toContain('「~」');
  });

  it('does not suggest moving a relative entry to readOnly (that tier rejects it too)', () => {
    const relativeOnly = forbiddenReadWriteMessage(findForbiddenReadWritePaths(['..'], roots));
    expect(relativeOnly).not.toContain('改放到「只读」');
    expect(relativeOnly).toContain('相对路径放进只读也不接受');
    const mixed = forbiddenReadWriteMessage(findForbiddenReadWritePaths(['/', '..'], roots));
    expect(mixed).not.toContain('改放到「只读」');
    expect(mixed).toContain('「/」');
    expect(mixed).toContain('「..」');
    // A non-relative rejection keeps the read-only hint.
    expect(forbiddenReadWriteMessage(findForbiddenReadWritePaths(['~'], roots))).toContain('改放到「只读」');
  });

  it('downgrades stored HOME / botmux-home offenders to readOnly, drops `/` and relative entries, keeps everything else', () => {
    const { lists, downgraded, dropped } = downgradeForbiddenReadWrite(
      { readWrite: ['/', '~/projects/app', '~', '~/.botmux', '..', '../..'], readOnly: ['/opt/ref'], deny: ['~/secret'] },
      roots,
    );
    expect(downgraded.map(f => f.path)).toEqual(['~', '~/.botmux']);
    expect(dropped.map(f => f.path)).toEqual(['/', '..', '../..']);
    expect(dropped.map(f => f.reason)).toEqual(['filesystem_root', 'relative_path', 'relative_path']);
    expect(lists).toEqual({
      readWrite: ['~/projects/app'], readOnly: ['/opt/ref', '~', '~/.botmux'], deny: ['~/secret'],
    });
  });

  it('returns lists unchanged when nothing is forbidden', () => {
    const input = { readWrite: ['~/projects/app'] };
    expect(downgradeForbiddenReadWrite(input, roots)).toEqual({ lists: input, downgraded: [], dropped: [] });
    expect(downgradeForbiddenReadWrite(undefined, roots)).toEqual({ lists: undefined, downgraded: [], dropped: [] });
  });

  it('finds a readOnly entry covering a launcher mount point: `/`, `/run`, `/run/sbxbin`, any spelling or link', () => {
    const home = roots.homeDirs[0]!;
    const rootLink = join(root, 'rootlink');
    symlinkSync('/', rootLink);
    const runLink = join(root, 'varrun');
    symlinkSync('/run', runLink);
    expect(findReadOnlyLauncherMountCovers([
      '/', '//', '/./', ' / ', rootLink,
      '/run', '//run/', '/run/', '/./run', runLink, '/run/sbxbin',
      '/usr', '~', home, '/opt', '..', '/run/lock', '/run/user/1000', '/tmp', '/etc', '/runx',
    ], home, 'linux')).toEqual([
      '/', '//', '/./', ' / ', rootLink,
      '/run', '//run/', '/run/', '/./run', runLink, '/run/sbxbin',
    ]);
  });

  it('drops a stored readOnly `/` and keeps the other readOnly entries', () => {
    const home = roots.homeDirs[0]!;
    const { lists, dropped } = dropReadOnlyLauncherMountCovers(
      { readWrite: ['~/projects/app'], readOnly: ['/usr', '/', '~'], deny: ['~/secret'] }, home, 'linux',
    );
    expect(dropped).toEqual(['/']);
    expect(lists).toEqual({ readWrite: ['~/projects/app'], readOnly: ['/usr', '~'], deny: ['~/secret'] });
    const untouched = { readOnly: ['/usr'] };
    expect(dropReadOnlyLauncherMountCovers(untouched, home, 'linux')).toEqual({ lists: untouched, dropped: [] });
    expect(dropReadOnlyLauncherMountCovers(undefined, home, 'linux')).toEqual({ lists: undefined, dropped: [] });
  });

  it('leaves a readOnly `/` alone on macOS, where Seatbelt runs it as "read everything, write the deeper grants"', () => {
    const home = roots.homeDirs[0]!;
    expect(findReadOnlyLauncherMountCovers(['/', '/run'], home, 'darwin')).toEqual([]);
    const stored = { readOnly: ['/'] };
    expect(dropReadOnlyLauncherMountCovers(stored, home, 'darwin')).toEqual({ lists: stored, dropped: [] });
    // The darwin policy keeps the grant and deeper readWrite rules still win.
    const work = join(root, 'proj');
    const policy = buildFsPolicy({
      platform: 'darwin', homeDir: home, botmuxHome: join(home, '.botmux'), sessionDataDir: join(home, '.botmux', 'data'),
      sessionId: 's', workingDir: work, currentAppId: 'cli_x', botHome: join(home, '.botmux', 'bots', 'cli_x'),
      userPaths: { readOnly: ['/'] }, net: true, writeRegexes: [],
    });
    expect(accessForPath(policy.rules, '/etc/hosts').access).toBe('readOnly');
    expect(accessForPath(policy.rules, join(work, 'file')).access).toBe('readWrite');
  });

  it('resolveStoredSandboxPaths applies every stored-entry rule in one step (the worker\'s list assembly)', () => {
    const home = roots.homeDirs[0]!;
    const stored = {
      readWrite: ['/', '~/projects/app', '~', '..'],
      readOnly: ['/usr', '/', '../ref', '~/docs', '/run', '/run/lock'],
      deny: ['~/secret', 'rel/hidden'],
    };
    const linux = resolveStoredSandboxPaths(stored, { roots, home, platform: 'linux' });
    expect(linux.downgradedReadWrite.map(f => f.path)).toEqual(['~']);
    expect(linux.droppedReadWrite.map(f => f.path)).toEqual(['/', '..']);
    expect(linux.droppedReadOnlyRelative).toEqual(['../ref']);
    expect(linux.droppedReadOnlyRoot).toEqual(['/', '/run']);
    expect(linux.lists).toEqual({
      readWrite: ['~/projects/app'], readOnly: ['/usr', '~/docs', '/run/lock', '~'], deny: ['~/secret', 'rel/hidden'],
    });
    const darwin = resolveStoredSandboxPaths(stored, { roots, home, platform: 'darwin' });
    expect(darwin.droppedReadOnlyRoot).toEqual([]);
    expect(darwin.lists?.readOnly).toEqual(['/usr', '/', '~/docs', '/run', '/run/lock', '~']);
    expect(resolveStoredSandboxPaths(undefined, { roots, home, platform: 'linux' }).lists).toBeUndefined();
  });
});
