import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';
import {
  managedTmuxBinDir,
  managedTmuxRoot,
  resetManagedTmuxVerificationForTests,
} from '../src/setup/tmux-managed-path.js';

// These cases exercise the production precedence, so they step outside the
// test tmux fence on purpose: nothing here runs a tmux SERVER — the only
// process started is the fake `tmux -V` script written below.
const FENCE_KEYS = ['BOTMUX_TMUX_FENCE_LOG', 'BOTMUX_FENCED_RUN'] as const;
let home: string;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { HOME: process.env.HOME, ...Object.fromEntries(FENCE_KEYS.map(k => [k, process.env[k]])) };
  home = mkdtempSync(join(tmpdir(), 'tmux-env-managed-'));
  process.env.HOME = home;
  for (const k of FENCE_KEYS) delete process.env[k];
  resetManagedTmuxVerificationForTests();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  resetManagedTmuxVerificationForTests();
});

function installLayout(script = '#!/bin/sh\necho "tmux 3.5a"\n', release = '3.5a'): string {
  const root = managedTmuxRoot(home);
  mkdirSync(join(root, 'releases', 'r1', 'bin'), { recursive: true });
  writeFileSync(join(root, 'releases', 'r1', 'bin', 'tmux'), script, { mode: 0o755 });
  writeFileSync(join(root, 'releases', 'r1', 'manifest.json'), JSON.stringify({ release }));
  symlinkSync('releases/r1', join(root, 'current'));
  return managedTmuxBinDir(root);
}

describe('tmuxEnv and botmux\'s own tmux', () => {
  it('without it, PATH is the caller\'s PATH plus the usual extras', () => {
    const path = tmuxEnv({ PATH: '/home/u/.local/bin:/usr/bin' }).PATH!;
    expect(path.split(':')[0]).toBe('/home/u/.local/bin');
    expect(path).not.toContain('.botmux/tools');
  });

  it('once installed, every botmux tmux call resolves it first — ahead of the user\'s copy', () => {
    const bin = installLayout();
    const path = tmuxEnv({ PATH: '/home/u/.local/bin:/usr/bin' }).PATH!.split(':');
    expect(path[0]).toBe(bin);
    expect(path.indexOf('/home/u/.local/bin')).toBeGreaterThan(0);
    // Idempotent: feeding the result back in does not duplicate it.
    const again = tmuxEnv({ PATH: path.join(':') }).PATH!.split(':');
    expect(again.filter(p => p === bin)).toHaveLength(1);
  });

  it('a copy that no longer runs here (missing library, truncated file, wrong release) never shadows the user\'s tmux', () => {
    installLayout('#!/bin/sh\necho "tmux: error while loading shared libraries: libjemalloc.so.2" >&2\nexit 127\n');
    expect(tmuxEnv({ PATH: '/usr/bin' }).PATH).not.toContain('.botmux/tools');
  });

  it('an empty (truncated) executable is not trusted even though it "succeeds"', () => {
    installLayout('');
    expect(tmuxEnv({ PATH: '/usr/bin' }).PATH).not.toContain('.botmux/tools');
  });

  it('an answer that is not the release botmux installed is not trusted', () => {
    installLayout('#!/bin/sh\necho "tmux 3.3a"\n', '3.5a');
    expect(tmuxEnv({ PATH: '/usr/bin' }).PATH).not.toContain('.botmux/tools');
  });

  it('inside a tmux test fence the managed copy is ignored (the fence shim must stay first)', () => {
    installLayout();
    expect(tmuxEnv({ PATH: '/fence/bin:/usr/bin', BOTMUX_TMUX_FENCE_LOG: '/tmp/x.log' }).PATH!.split(':')[0]).toBe('/fence/bin');
    expect(tmuxEnv({ PATH: '/usr/bin', BOTMUX_FENCED_RUN: '1' }).PATH).not.toContain('.botmux/tools');
  });

  it('`current` must be botmux\'s symlink, not a directory someone created', () => {
    const root = managedTmuxRoot(home);
    mkdirSync(join(root, 'current', 'bin'), { recursive: true });
    writeFileSync(join(root, 'current', 'bin', 'tmux'), '#!/bin/sh\necho "tmux 3.5a"\n', { mode: 0o755 });
    expect(tmuxEnv({ PATH: '/usr/bin' }).PATH).not.toContain('.botmux/tools');
  });

  it('a half-built layout (no `current` link, or no executable) is ignored', () => {
    const root = managedTmuxRoot(home);
    mkdirSync(join(root, 'releases', 'r1', 'bin'), { recursive: true });
    expect(tmuxEnv({ PATH: '/usr/bin' }).PATH).not.toContain('.botmux/tools');
    symlinkSync('releases/r1', join(root, 'current'));
    expect(tmuxEnv({ PATH: '/usr/bin' }).PATH).not.toContain('.botmux/tools');
  });
});
