import { describe, expect, it } from 'vitest';
import type { FsRule } from '../src/adapters/cli/fs-policy.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultWrapperFsIo,
  wrapperSandboxExitHint,
  cliNameLink,
  sandboxWrapperPreflight,
  uncoveredWrapperDependencies,
  wrapperAutoAllowPaths,
  wrapperDependencies,
  wrapperEntryFiles,
  wrapperSandboxPreflightError,
  type SandboxWrapperLaunch,
  type WrapperFsIo,
} from '../src/core/sandbox-wrapper-launch.js';

// A fake host: files (with their first bytes), dirs, symlinks, PATH lookups.
function io(world: { links?: Record<string, string>; heads?: Record<string, string>; dirs?: string[]; path?: Record<string, string> }): WrapperFsIo {
  const exists = (p: string) => p in (world.heads ?? {}) || (world.dirs ?? []).includes(p);
  return {
    realpath: p => {
      const target = world.links?.[p] ?? p;
      if (!exists(target)) throw new Error(`ENOENT ${p}`);
      return target;
    },
    isFile: p => p in (world.heads ?? {}),
    readHead: p => world.heads?.[p],
    which: name => world.path?.[name],
  };
}

const rules = (ro: string[], deny: string[] = []): FsRule[] => [
  ...ro.map(path => ({ path, access: 'readOnly' as const, source: 'baseline' as const })),
  ...deny.map(path => ({ path, access: 'deny' as const, source: 'mandatory' as const })),
];

const launch = (over: Partial<SandboxWrapperLaunch>): SandboxWrapperLaunch => ({
  wrapperCli: 'mywrap claude', bin: '/opt/w/mywrap', args: ['claude'], cliBin: '/opt/claude/bin/claude', ...over,
});

describe('sandbox wrapper launch', () => {
  it('auto-allows only the wrapper file itself, plus the user wrapper behind a botmux shim', () => {
    const world = io({ heads: { '/opt/w/mywrap': '\x7fELF', '/opt/aiden/bin/aiden': '\x7fELF', '/data/shim/launch': '#!/bin/sh' }, dirs: ['/data/shim'] });
    expect(wrapperAutoAllowPaths(launch({}), world)).toEqual(['/opt/w/mywrap']);
    const shimmed = launch({ bin: '/data/shim/launch', args: ['/opt/aiden/bin/aiden', 'x', 'codex'], botmuxOwnedDirs: ['/data/shim'] });
    expect(wrapperEntryFiles(shimmed)).toEqual(['/data/shim/launch', '/opt/aiden/bin/aiden']);
    expect(wrapperAutoAllowPaths(shimmed, world)).toEqual(['/data/shim/launch', '/opt/aiden/bin/aiden', '/data/shim']);
    // A non-shim program never promotes its first argument into the allowlist.
    expect(wrapperEntryFiles(launch({ args: ['/etc/shadow'] }))).toEqual(['/opt/w/mywrap']);
  });

  it('finds the interpreter of a script wrapper and the npm package of a node wrapper', () => {
    const world = io({
      links: { '/home/u/.npm/bin/aiden': '/home/u/.npm/lib/node_modules/@acme/aiden/bin/aiden.js', '/usr/local/bin/node': '/opt/node-22/bin/node' },
      heads: { '/home/u/.npm/lib/node_modules/@acme/aiden/bin/aiden.js': '#!/usr/bin/env -S node --no-warnings\n', '/opt/node-22/bin/node': '\x7fELF' },
      path: { node: '/usr/local/bin/node' },
    });
    const deps = wrapperDependencies(launch({ bin: '/home/u/.npm/bin/aiden' }), world);
    expect(deps.map(d => d.path)).toEqual([
      '/home/u/.npm/lib/node_modules/@acme/aiden/bin/aiden.js',
      '/home/u/.npm/lib/node_modules/@acme/aiden',
      '/opt/node-22/bin/node',
    ]);
    const missing = uncoveredWrapperDependencies(deps, rules(['/home/u/.npm/lib/node_modules/@acme/aiden/bin/aiden.js', '/opt/node-22']));
    expect(missing.map(d => d.path)).toEqual(['/home/u/.npm/lib/node_modules/@acme/aiden']);
    const msg = wrapperSandboxPreflightError('aiden x claude', missing);
    expect(msg).toContain('/home/u/.npm/lib/node_modules/@acme/aiden');
    expect(msg).toContain('sandboxPaths.readOnly');
  });

  it('treats a deny rule under an allowed root as not covered, and reports an interpreter missing from PATH', () => {
    const world = io({ heads: { '/opt/w/mywrap': '#!/usr/bin/env wrapinterp\n' } });
    const deps = wrapperDependencies(launch({}), world);
    expect(deps.map(d => d.path)).toEqual(['/opt/w/mywrap', 'wrapinterp']);
    expect(uncoveredWrapperDependencies(deps, rules(['/opt'], ['/opt/w'])).map(d => d.path)).toEqual(['/opt/w/mywrap', 'wrapinterp']);
    expect(uncoveredWrapperDependencies(deps, rules(['/opt'])).map(d => d.path)).toEqual(['wrapinterp']);
  });

  it('parses env shebangs with assignments and -u, and stays silent when it cannot tell', () => {
    const world = io({
      heads: {
        '/opt/w/a': '#!/usr/bin/env -S NODE_OPTIONS=--x node\n',
        '/opt/w/b': '#!/usr/bin/env -u HOME node\n',
        '/opt/w/c': '#!/usr/bin/env --weird-flag node\n',
        '/opt/node/bin/node': '\x7fELF',
      },
      path: { node: '/opt/node/bin/node' },
    });
    for (const bin of ['/opt/w/a', '/opt/w/b']) {
      expect(wrapperDependencies(launch({ bin }), world).map(d => d.path)).toEqual([bin, '/opt/node/bin/node']);
    }
    expect(wrapperDependencies(launch({ bin: '/opt/w/c' }), world).map(d => d.path)).toEqual(['/opt/w/c']);
  });

  it('never auto-allows a directory, even when the wrapper name resolves to one', () => {
    const world = io({ links: { '/home/u/bin/aiden': '/home/u/secretdir' }, dirs: ['/home/u/secretdir'] });
    expect(wrapperAutoAllowPaths(launch({ bin: '/home/u/bin/aiden' }), world)).toEqual([]);
  });

  it('refuses a fresh launch with missing dependencies, but never a warm reattach of a live pane', () => {
    const world = io({ heads: { '/opt/w/mywrap': '#!/usr/bin/env wrapinterp\n', '/opt/i/wrapinterp': '\x7fELF' }, path: { wrapinterp: '/opt/i/wrapinterp' } });
    const input = { launch: launch({}), rules: rules(['/opt/w/mywrap']), io: world };
    expect(sandboxWrapperPreflight({ ...input, reattach: false })).toContain('/opt/i/wrapinterp');
    expect(sandboxWrapperPreflight({ ...input, reattach: true })).toBeUndefined();
    expect(sandboxWrapperPreflight({ ...input, rules: rules(['/opt/w/mywrap', '/opt/i']), reattach: false })).toBeUndefined();
    expect(sandboxWrapperPreflight({ ...input, launch: undefined, reattach: false })).toBeUndefined();
  });

  // Bytes this thread actually read() — the only observable that tells a
  // fixed-size head read apart from reading the whole file and slicing it
  // (both return the same 256 bytes). Linux only.
  const threadReadBytes = (): number | undefined => {
    try {
      const m = readFileSync('/proc/thread-self/io', 'utf8').match(/^rchar: (\d+)$/m);
      return m ? Number(m[1]) : undefined;
    } catch { return undefined; }
  };

  it('reads only the shebang head of a wrapper, never a large binary whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-readhead-'));
    try {
      const size = 32 * 1024 * 1024;
      const big = join(dir, 'big-wrapper');
      writeFileSync(big, Buffer.concat([Buffer.from('#!/bin/sh\n'), Buffer.alloc(size, 0x61)]));
      const io = defaultWrapperFsIo(() => undefined);
      const before = threadReadBytes();
      const head = io.readHead(big)!;
      const after = threadReadBytes();
      expect(head.length).toBe(256);
      expect(head.startsWith('#!/bin/sh\n')).toBe(true);
      if (before !== undefined && after !== undefined) expect(after - before).toBeLessThan(size / 64);
      expect(io.readHead(join(dir, 'missing'))).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('points the exit hint at the setting the sandbox mode actually reads', () => {
    expect(wrapperSandboxExitHint('mywrap', 'fs-policy')).toContain('sandboxPaths');
    expect(wrapperSandboxExitHint('mywrap', 'scratch')).toContain('scratchDenyPaths');
    expect(wrapperSandboxExitHint('mywrap', 'scratch')).not.toContain('sandboxPaths');
  });

  it('aliases the CLI name to its real binary, never shadowing botmux itself', () => {
    const world = io({ links: { '/home/u/.local/bin/claude': '/home/u/.local/share/claude/versions/2.1' }, heads: { '/home/u/.local/share/claude/versions/2.1': '\x7fELF' } });
    expect(cliNameLink('/home/u/.local/bin/claude', world)).toEqual({ name: 'claude', target: '/home/u/.local/share/claude/versions/2.1' });
    expect(cliNameLink('/opt/x/botmux', io({ heads: { '/opt/x/botmux': '' } }))).toBeUndefined();
  });
});
