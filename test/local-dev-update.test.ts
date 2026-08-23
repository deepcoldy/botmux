import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWrapperCliEntry,
  checkoutDirFromCliEntry,
  checkoutDirFromWrapperText,
  localDevUpdateSteps,
  isGitWorktree,
  isBotmuxCheckout,
  gitPorcelainStatus,
  gitHeadSha,
  resolveLocalDevRestartTarget,
} from '../src/utils/local-dev-update.js';

describe('parseWrapperCliEntry', () => {
  it('extracts the dist/cli.js path from a standard wrapper', () => {
    const text = '#!/bin/sh\nexec node "/Users/x/iserver/botmux/dist/cli.js" "$@"\n';
    expect(parseWrapperCliEntry(text)).toBe('/Users/x/iserver/botmux/dist/cli.js');
  });

  it('tolerates an absolute node path before the cli.js arg', () => {
    const text = '#!/bin/sh\nexec /usr/local/bin/node "/opt/botmux/dist/cli.js" "$@"\n';
    expect(parseWrapperCliEntry(text)).toBe('/opt/botmux/dist/cli.js');
  });

  it('does not mistake the trailing "$@" for the path', () => {
    const text = 'exec node "/a/b/dist/cli.js" "$@"';
    expect(parseWrapperCliEntry(text)).toBe('/a/b/dist/cli.js');
  });

  it('returns null for a hand-edited / unrecognizable wrapper', () => {
    expect(parseWrapperCliEntry('#!/bin/sh\necho hi\n')).toBeNull();
    expect(parseWrapperCliEntry('')).toBeNull();
  });

  it('ignores a stray .js in a comment before the real exec line', () => {
    const text = [
      '#!/bin/sh',
      '# preload "/tmp/unrelated/scripts/hook.js"',
      'exec node "/Users/x/iserver/botmux/dist/cli.js" "$@"',
    ].join('\n');
    expect(parseWrapperCliEntry(text)).toBe('/Users/x/iserver/botmux/dist/cli.js');
  });

  it('ignores a commented-out old exec line and picks the real one', () => {
    // The "keep the old command as a comment" pattern must not win — the match
    // is anchored to a line that STARTS with exec, so `# old: exec node …` and
    // `echo exec node …` are rejected.
    const text = [
      '#!/bin/sh',
      '# old: exec node "/tmp/old-botmux/dist/cli.js" "$@"',
      '',
      'exec node "/tmp/current-botmux/dist/cli.js" "$@"',
    ].join('\n');
    expect(parseWrapperCliEntry(text)).toBe('/tmp/current-botmux/dist/cli.js');
    expect(parseWrapperCliEntry('echo exec node "/x/dist/cli.js" "$@"')).toBeNull();
  });

  it('requires the trailing "$@" of the generated wrapper shape', () => {
    // A line mentioning the CLI path but not in exec…"$@" form is not a wrapper.
    expect(parseWrapperCliEntry('exec node "/x/dist/cli.js"')).toBeNull();
    expect(parseWrapperCliEntry('node "/x/dist/cli.js" "$@"')).toBeNull();
  });

  it('rejects a relative target path (must be absolute)', () => {
    // A relative path resolves against the shell cwd at exec time but against
    // the reader's cwd here — the two could be different checkouts. Skip it.
    expect(parseWrapperCliEntry('exec node "nested/botmux/dist/cli.js" "$@"')).toBeNull();
    expect(parseWrapperCliEntry('exec node "./dist/cli.js" "$@"')).toBeNull();
  });

  it('only matches a dist/cli.js target, not any other .js on the exec line', () => {
    // A target that is not <root>/dist/cli.js must not be accepted.
    expect(parseWrapperCliEntry('exec node "/opt/tool/build/index.js" "$@"')).toBeNull();
    expect(parseWrapperCliEntry('exec node "/opt/botmux/dist/worker.js" "$@"')).toBeNull();
  });

  it('matches a Windows-separator dist\\cli.js target', () => {
    const text = 'exec node "C:\\botmux\\dist\\cli.js" "$@"';
    expect(parseWrapperCliEntry(text)).toBe('C:\\botmux\\dist\\cli.js');
  });
});

describe('checkoutDirFromCliEntry', () => {
  it('walks up two levels from dist/cli.js to the checkout root', () => {
    expect(checkoutDirFromCliEntry('/Users/x/iserver/botmux/dist/cli.js'))
      .toBe('/Users/x/iserver/botmux');
  });
});

describe('checkoutDirFromWrapperText', () => {
  it('resolves the checkout root from wrapper text', () => {
    const text = '#!/bin/sh\nexec node "/srv/botmux/dist/cli.js" "$@"\n';
    expect(checkoutDirFromWrapperText(text)).toBe('/srv/botmux');
  });

  it('returns null when the wrapper text does not parse', () => {
    expect(checkoutDirFromWrapperText('garbage')).toBeNull();
  });
});

describe('localDevUpdateSteps', () => {
  it('is git pull --ff-only then pnpm build (restart applied separately)', () => {
    expect(localDevUpdateSteps()).toEqual([
      { command: 'git', args: ['pull', '--ff-only'] },
      { command: 'pnpm', args: ['build'] },
    ]);
  });
});

describe('resolveLocalDevRestartTarget', () => {
  const probes = (exists: (d: string) => boolean, heads: Record<string, string>) => ({
    cliEntryExists: exists,
    headOf: (d: string) => heads[d] ?? '',
  });

  it('pinned plan present + unchanged HEAD → restart that checkout', () => {
    const d = resolveLocalDevRestartTarget(
      { dir: '/B', head: 'sha1' }, '/B',
      probes(() => true, { '/B': 'sha1' }),
    );
    expect(d).toEqual({ action: 'restart', dir: '/B' });
  });

  it('pinned plan, but wrapper flipped to C and B lost its dist → fail closed', () => {
    // The run→restart TOCTOU: run built B, a concurrent `use:here` re-pointed the
    // wrapper to C, and B's dist was removed. Must fail, not restart C or A.
    const d = resolveLocalDevRestartTarget(
      { dir: '/B', head: 'sha1' }, '/C',
      probes((dir) => dir === '/C', { '/B': 'sha1', '/C': 'shaX' }),
    );
    expect(d).toEqual({ action: 'fail', reason: 'update_target_unavailable', dir: '/B' });
  });

  it('pinned plan, but B HEAD moved after the build → fail closed (drift)', () => {
    const d = resolveLocalDevRestartTarget(
      { dir: '/B', head: 'sha1' }, '/B',
      probes(() => true, { '/B': 'sha2' }),
    );
    expect(d).toEqual({ action: 'fail', reason: 'update_target_drifted', dir: '/B' });
  });

  it('no pinned plan (plain restart), live target has cli.js → restart it', () => {
    const d = resolveLocalDevRestartTarget(
      undefined, '/A',
      probes(() => true, { '/A': 'sha0' }),
    );
    expect(d).toEqual({ action: 'restart', dir: '/A' });
  });

  it('no pinned plan, live target lacks cli.js → fall back to running root', () => {
    const d = resolveLocalDevRestartTarget(
      undefined, '/A',
      probes(() => false, {}),
    );
    expect(d).toEqual({ action: 'fallback-running-root' });
  });
});

describe('git worktree helpers (real repos)', () => {
  let dir: string;
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-ldu-git-'));
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(dir, 'f'), 'v1\n');
    git(['add', 'f']);
    git(['commit', '-qm', 'c1']);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('isGitWorktree is true for a real repo, false for a bare dir', () => {
    expect(isGitWorktree(dir)).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), 'botmux-ldu-plain-'));
    try {
      expect(isGitWorktree(plain)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('isBotmuxCheckout requires .git AND package.json name === botmux', () => {
    // git repo but no package.json → not a botmux checkout
    expect(isBotmuxCheckout(dir)).toBe(false);
    // git repo with an unrelated package.json → still rejected (repo-identity)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'other-tool' }));
    expect(isBotmuxCheckout(dir)).toBe(false);
    // git repo whose package.json is botmux → accepted, even without dist/
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'botmux' }));
    expect(isBotmuxCheckout(dir)).toBe(true);
    // no .git at all → rejected regardless of package.json
    const plain = mkdtempSync(join(tmpdir(), 'botmux-ldu-nogit-'));
    try {
      writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'botmux' }));
      expect(isBotmuxCheckout(plain)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('gitPorcelainStatus is empty when clean, non-empty when dirty', () => {
    expect(gitPorcelainStatus(dir)).toBe('');
    writeFileSync(join(dir, 'f'), 'changed\n');
    expect(gitPorcelainStatus(dir)).toContain('f');
    writeFileSync(join(dir, 'untracked'), 'x\n');
    expect(gitPorcelainStatus(dir)).toContain('untracked');
  });

  it('gitHeadSha changes across commits (drives the "changed" decision)', () => {
    const before = gitHeadSha(dir);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, 'f'), 'v2\n');
    git(['commit', '-qam', 'c2']);
    const after = gitHeadSha(dir);
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });
});
