/**
 * Per-session isolated workspace + daemon reaping (review P0/P1).
 *
 * The tests here must prove ISOLATION, not directory bookkeeping: T1 asserts
 * the daemon-id derivation actually distinguishes two sessions (and collapses
 * for a shared realpath — the reason symlinks were rejected), T5/T6 drive the
 * reaper through a fully mocked registry.
 *
 * Run:  pnpm vitest run test/mojo-isolated-workspace.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  cleanupMojoIsolatedWorkspace,
  ensureMojoIsolatedWorkspace,
  mojoIsolatedWorkspacePath,
  mojoWorkspaceHash,
  reapMojoIsolatedDaemon,
  type MojoDaemonReapDeps,
} from '../src/adapters/backend/mojo-isolated-workspace.js';

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-iso-')));
}

describe('T1: daemon-id derivation distinguishes sessions', () => {
  it('two sessions produce two distinct workspace hashes', () => {
    const home = tmpRoot();
    const a = ensureMojoIsolatedWorkspace('session-aaaa', home);
    const b = ensureMojoIsolatedWorkspace('session-bbbb', home);
    expect(a).not.toBe(b);
    // The property the whole fix rests on: distinct realpaths → distinct
    // daemon ids → per-session daemons with per-session env.
    expect(mojoWorkspaceHash(a)).not.toBe(mojoWorkspaceHash(b));
  });

  it('symlinks to a shared target collapse into ONE hash (why real dirs are mandatory)', () => {
    const home = tmpRoot();
    const shared = join(home, 'shared-repo');
    mkdirSync(shared);
    symlinkSync(shared, join(home, 'linkA'));
    symlinkSync(shared, join(home, 'linkB'));
    // mojo's daemon keys on process.cwd(), which is the kernel realpath — both
    // links resolve to the same string, i.e. the same shared daemon.
    expect(mojoWorkspaceHash(realpathSync(join(home, 'linkA'))))
      .toBe(mojoWorkspaceHash(realpathSync(join(home, 'linkB'))));
  });

  it('ensure is idempotent and returns a realpath', () => {
    const home = tmpRoot();
    const first = ensureMojoIsolatedWorkspace('sid-x', home);
    expect(ensureMojoIsolatedWorkspace('sid-x', home)).toBe(first);
    expect(first).toBe(realpathSync(first));
  });
});

function mockDeps(overrides: Partial<MojoDaemonReapDeps> & {
  registry?: Record<string, { workspace: string; pid: number }>;
  livePids?: Map<number, string | null>;
}): { deps: MojoDaemonReapDeps; kills: Array<[number, NodeJS.Signals | 0]>; unlinked: string[] } {
  const registry = overrides.registry ?? {};
  const livePids = overrides.livePids ?? new Map<number, string | null>();
  const kills: Array<[number, NodeJS.Signals | 0]> = [];
  const unlinked: string[] = [];
  const deps: MojoDaemonReapDeps = {
    daemonsDir: '/fake/daemons',
    readdir: () => Object.keys(registry).map(id => `${id}.json`),
    readFile: path => {
      const id = path.replace(/^.*\//, '').replace(/\.json$/, '');
      if (!registry[id]) throw new Error('ENOENT');
      return JSON.stringify(registry[id]);
    },
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (!livePids.has(pid)) { const e: any = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      if (signal === 'SIGKILL') livePids.delete(pid);
    },
    pidCommand: pid => (livePids.has(pid) ? livePids.get(pid)! : null),
    unlink: path => { unlinked.push(path); },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, kills, unlinked };
}

describe('T5: close-time reaping', () => {
  it('SIGTERM→SIGKILL lands on the registry-matched pid and clears the row', async () => {
    const ws = '/real/workspaces/sid-1';
    const { deps, kills, unlinked } = mockDeps({
      registry: { 'M-user-abc123': { workspace: ws, pid: 4242 } },
      livePids: new Map([[4242, '/Users/x/.mojo/bin/mojo-daemon --server wss://…']]),
    });
    const result = await reapMojoIsolatedDaemon(ws, deps);
    expect(result).toMatchObject({ outcome: 'killed', daemonId: 'M-user-abc123', pid: 4242, forced: true });
    expect(kills[0]).toEqual([4242, 'SIGTERM']);
    expect(kills.at(-1)).toEqual([4242, 'SIGKILL']);
    expect(unlinked).toContain('/fake/daemons/M-user-abc123.json');
  });

  it('a SIGTERM-compliant daemon is not SIGKILLed', async () => {
    const ws = '/real/workspaces/sid-2';
    const livePids = new Map([[777, 'mojo-daemon --server wss://…']]);
    const { deps, kills } = mockDeps({
      registry: { 'M-user-def456': { workspace: ws, pid: 777 } },
      livePids,
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        if (signal === 'SIGTERM') { livePids.delete(pid); return; }
        if (!livePids.has(pid)) { const e: any = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      },
    });
    const result = await reapMojoIsolatedDaemon(ws, deps);
    expect(result).toMatchObject({ outcome: 'killed', pid: 777, forced: false });
    expect(kills.filter(([, s]) => s === 'SIGKILL')).toHaveLength(0);
  });

  it('a recycled pid whose command is not mojo is NEVER signalled', async () => {
    const ws = '/real/workspaces/sid-3';
    const { deps, kills } = mockDeps({
      registry: { 'M-user-ghi789': { workspace: ws, pid: 999 } },
      livePids: new Map([[999, '/usr/bin/some-unrelated-server --port 80']]),
    });
    const result = await reapMojoIsolatedDaemon(ws, deps);
    expect(result).toMatchObject({ outcome: 'mismatch', pid: 999 });
    expect(kills).toHaveLength(0);
  });

  it('only the workspace-matched entry is touched', async () => {
    const ws = '/real/workspaces/sid-4';
    const { deps, kills } = mockDeps({
      registry: {
        'M-user-other0': { workspace: '/real/other', pid: 1 },
        'M-user-mine00': { workspace: ws, pid: 2 },
      },
      livePids: new Map([[1, 'mojo-daemon other'], [2, 'mojo-daemon mine']]),
    });
    await reapMojoIsolatedDaemon(ws, deps);
    expect(kills.every(([pid]) => pid === 2)).toBe(true);
  });
});

describe('T6: cold-start / absent daemon never fails the close', () => {
  it('no matching registry entry → not-found, no throw', async () => {
    const { deps, kills } = mockDeps({ registry: { 'M-user-zzz': { workspace: '/elsewhere', pid: 5 } } });
    const result = await reapMojoIsolatedDaemon('/real/workspaces/sid-5', deps);
    expect(result).toMatchObject({ outcome: 'not-found' });
    expect(kills).toHaveLength(0);
  });

  it('unreadable registry dir → not-found, no throw', async () => {
    const { deps } = mockDeps({ readdir: () => { throw new Error('ENOENT'); } });
    await expect(reapMojoIsolatedDaemon('/x', deps)).resolves.toMatchObject({ outcome: 'not-found' });
  });

  it('pid already gone → not-found and the stale row is cleared', async () => {
    const ws = '/real/workspaces/sid-6';
    const { deps, unlinked } = mockDeps({
      registry: { 'M-user-gone': { workspace: ws, pid: 31337 } },
      // livePids empty → pidCommand null
    });
    const result = await reapMojoIsolatedDaemon(ws, deps);
    expect(result).toMatchObject({ outcome: 'not-found' });
    expect(unlinked).toContain('/fake/daemons/M-user-gone.json');
  });
});

describe('cleanupMojoIsolatedWorkspace', () => {
  it('removes the isolated directory and never throws on a clean session', async () => {
    const home = tmpRoot();
    const real = ensureMojoIsolatedWorkspace('sid-clean', home);
    expect(existsSync(real)).toBe(true);
    // Point the reap at an empty fake registry via deps.
    const { deps } = mockDeps({});
    await cleanupMojoIsolatedWorkspace('sid-clean', { home, deps });
    expect(existsSync(mojoIsolatedWorkspacePath('sid-clean', home))).toBe(false);
  });

  it('is a no-op for a session that never created a workspace (cloud mode)', async () => {
    const home = tmpRoot();
    const { deps, kills } = mockDeps({ registry: { 'M-x': { workspace: '/y', pid: 3 } } });
    await cleanupMojoIsolatedWorkspace('sid-cloud-never', { home, deps });
    expect(kills).toHaveLength(0);
  });
});
