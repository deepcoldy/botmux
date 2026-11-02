import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, readlinkSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  applySessionTempEnv,
  cleanupSessionTempDir,
  cleanupSessionTempDirAfterExit,
  ensureSessionTempDir,
  sessionTempDir,
  sweepOrphanSessionTempDirs,
} from '../src/core/session-temp.js';
import { buildBotmuxEnvAssignments } from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';

const roots: string[] = [];

function dataDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-session-temp-')));
  roots.push(root);
  return join(root, 'data');
}

beforeEach(() => { vi.stubEnv('HOME', dataDir()); });

afterEach(() => {
  // Remove only the alias owned by this test HOME; never the shared uid parent.
  if (process.getuid) {
    const alias = dirname(dirname(sessionTempDir('/unused', 'unused')));
    try {
      if (readlinkSync(alias) === resolve(homedir(), '.cache', 'botmux', 'session-tmp')) unlinkSync(alias);
    } catch { /* this test never created an alias */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('session temp', () => {
  it('creates stable per-session scratch in the user cache tree', () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'session-123');
    roots.push(dirname(path));
    expect(realpathSync(path).startsWith(realpathSync(join(homedir(), '.cache', 'botmux', 'session-tmp')))).toBe(true);
    expect(path).toBe(sessionTempDir(data, 'session-123'));
    expect(existsSync(path)).toBe(true);

    const env: NodeJS.ProcessEnv = {};
    applySessionTempEnv(env, path);
    expect(env).toMatchObject({ TMPDIR: path, TMP: path, TEMP: path });
  });

  it('hashes unsafe session ids instead of permitting traversal', () => {
    const data = dataDir();
    const path = sessionTempDir(data, '../../escape');
    expect(path).not.toContain('escape');
  });

  it.skipIf(!process.getuid)('binds a Chrome-shaped socket with a long HOME while keeping artifacts on the cache filesystem', async () => {
    const home = join(dataDir(), 'a-very-long-user-home-component'.repeat(4));
    roots.push(dirname(home));
    vi.stubEnv('HOME', home);
    const data = dataDir();
    const path = ensureSessionTempDir(data, '6c255026-e993-495d-80ec-85d2c3c440dc');
    const alias = dirname(dirname(path));
    roots.push(alias);
    const socket = join(path, 'com.google.Chrome.XXXXXX', 'SingletonSocket');
    mkdirSync(dirname(socket));
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    writeFileSync(join(path, 'artifact'), 'disk-backed');
    const cache = join(home, '.cache', 'botmux', 'session-tmp');
    expect(realpathSync(path).startsWith(realpathSync(cache))).toBe(true);
    expect(readFileSync(join(realpathSync(path), 'artifact'), 'utf8')).toBe('disk-backed');
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.skipIf(!process.getuid)('rejects a substituted short alias instead of writing into another tree', () => {
    const home = dataDir();
    vi.stubEnv('HOME', home);
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'one');
    const alias = dirname(dirname(path));
    roots.push(alias);
    unlinkSync(alias);
    const other = dataDir();
    mkdirSync(other, { recursive: true });
    symlinkSync(other, alias);
    expect(() => ensureSessionTempDir(data, 'two')).toThrow(/does not point to its cache/);
    expect(readdirSync(other)).toEqual([]);
  });

  it.skipIf(!process.getuid)('pins sweep deletion to the backing tree if the alias is changed during the process probe', async () => {
    vi.stubEnv('HOME', dataDir());
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'closed');
    const physical = realpathSync(path);
    const alias = dirname(dirname(path));
    roots.push(alias);
    const foreign = dataDir();
    const foreignSession = join(foreign, ...path.slice(alias.length + 1).split('/'));
    mkdirSync(foreignSession, { recursive: true });
    writeFileSync(join(foreignSession, 'artifact'), 'foreign');
    const removed = await sweepOrphanSessionTempDirs(data, new Set(), {
      now: Date.now() + 600_000,
      liveReferences: async () => {
        unlinkSync(alias);
        symlinkSync(foreign, alias);
        return new Set();
      },
    });
    expect(removed).toContain(physical);
    expect(existsSync(physical)).toBe(false);
    expect(readFileSync(join(foreignSession, 'artifact'), 'utf8')).toBe('foreign');
  });

  it.skipIf(!process.getuid).each(['short', 'cache', 'lexical-cache'] as const)('keeps live scratch referenced through the %s spelling', async spelling => {
    const physicalHome = dataDir();
    mkdirSync(physicalHome, { recursive: true });
    const lexicalHome = dataDir();
    symlinkSync(physicalHome, lexicalHome);
    vi.stubEnv('HOME', lexicalHome);
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'running');
    const alias = dirname(dirname(path));
    roots.push(alias);
    const cachePath = join(homedir(), '.cache', 'botmux', 'session-tmp', path.slice(alias.length + 1));
    writeFileSync(join(path, 'artifact'), 'live');
    const livePath = spelling === 'short' ? path : spelling === 'cache' ? realpathSync(path) : cachePath;
    const removed = await sweepOrphanSessionTempDirs(data, new Set(), {
      now: Date.now() + 600_000,
      liveReferences: async paths => {
        expect(paths).toContain(livePath);
        return new Set([livePath]);
      },
    });
    expect(removed).toEqual([]);
    expect(readFileSync(join(path, 'artifact'), 'utf8')).toBe('live');
  });

  it.skipIf(!process.getuid).each(['before', 'during'])('pins close cleanup to its cache when the alias is retargeted %s removal', async timing => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'closing');
    const physical = realpathSync(path);
    const alias = dirname(dirname(path));
    roots.push(alias);
    const foreign = dataDir();
    const foreignSession = join(foreign, path.slice(alias.length + 1));
    mkdirSync(foreignSession, { recursive: true });
    writeFileSync(join(foreignSession, 'artifact'), 'foreign');
    const legacyProfile = createHash('sha256').update(resolve(data)).digest('hex').slice(0, 16);
    const foreignLegacy = join(foreign, legacyProfile, 'closing');
    mkdirSync(foreignLegacy, { recursive: true });
    writeFileSync(join(foreignLegacy, 'artifact'), 'foreign-legacy');
    const retarget = () => { unlinkSync(alias); symlinkSync(foreign, alias); };
    if (timing === 'before') retarget();
    const pending = cleanupSessionTempDir(data, 'closing');
    if (timing === 'during') retarget();
    await pending;
    expect(readFileSync(join(foreignLegacy, 'artifact'), 'utf8')).toBe('foreign-legacy');
    expect(existsSync(physical)).toBe(false);
    expect(readFileSync(join(foreignSession, 'artifact'), 'utf8')).toBe('foreign');
  });

  it('also retires scratch left in the pre-shortening layout', async () => {
    const data = dataDir();
    const sessionId = '6c255026-e993-495d-80ec-85d2c3c440dc';
    const profile = createHash('sha256').update(resolve(data)).digest('hex').slice(0, 16);
    const legacy = join(homedir(), '.cache', 'botmux', 'session-tmp', profile, sessionId);
    roots.push(dirname(legacy));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'artifact'), 'x');
    await cleanupSessionTempDir(data, sessionId);
    expect(existsSync(legacy)).toBe(false);
  });

  it('separates sibling data directories with the same session id', () => {
    const data = dataDir();
    expect(sessionTempDir(data, 'same')).not.toBe(sessionTempDir(join(dirname(data), 'other-data'), 'same'));
  });

  it('removes only the exact session directory on close', async () => {
    const data = dataDir();
    const one = ensureSessionTempDir(data, 'one');
    const two = ensureSessionTempDir(data, 'two');
    roots.push(dirname(one));
    writeFileSync(join(one, 'artifact'), 'x');
    writeFileSync(join(two, 'artifact'), 'y');

    await cleanupSessionTempDir(data, 'one');
    expect(existsSync(one)).toBe(false);
    expect(readFileSync(join(two, 'artifact'), 'utf8')).toBe('y');
  });

  it('keeps scratch until the worker actually exits', async () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'closing');
    roots.push(dirname(path));
    const worker = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
    }) as ChildProcess;
    const onError = vi.fn();

    cleanupSessionTempDirAfterExit(data, 'closing', worker, onError);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(path)).toBe(true);
    worker.emit('exit', 0, null);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(onError).not.toHaveBeenCalled();
  });

  it('rechecks ownership at exit and preserves a resumed generation', async () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'resumed');
    roots.push(dirname(path));
    const worker = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
    let ownerIsClosed = true;
    cleanupSessionTempDirAfterExit(data, 'resumed', worker, vi.fn(), () => ownerIsClosed);
    ownerIsClosed = false;
    writeFileSync(join(path, 'new-generation'), 'live');
    worker.emit('exit', 0, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(readFileSync(join(path, 'new-generation'), 'utf8')).toBe('live');
  });

  it('detaches the old tree before asynchronous deletion so immediate resume survives', async () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'during-removal');
    roots.push(dirname(path));
    writeFileSync(join(path, 'old'), 'closed');
    const pending = cleanupSessionTempDir(data, 'during-removal');
    expect(existsSync(path)).toBe(false);
    ensureSessionTempDir(data, 'during-removal');
    writeFileSync(join(path, 'new'), 'live');
    await pending;
    expect(readFileSync(join(path, 'new'), 'utf8')).toBe('live');
    expect(existsSync(join(path, 'old'))).toBe(false);
  });

  it('refuses a symlink planted at the session path', () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'linked');
    roots.push(dirname(path));
    rmSync(path, { recursive: true });
    symlinkSync(dataDir(), path);
    expect(() => ensureSessionTempDir(data, 'linked')).toThrow(/not a real directory/);
  });

  it('forwards the scratch variables into persistent-backend panes', () => {
    const path = '/srv/botmux/tmp/sessions/s1';
    const out = buildBotmuxEnvAssignments({ TMPDIR: path, TMP: path, TEMP: path });
    expect(out).toEqual([`TMPDIR=${path}`, `TMP=${path}`, `TEMP=${path}`]);
  });

  it('does not seed a shared tmux server with the session scratch environment', () => {
    const env = { TMPDIR: '/session/scratch', TMP: '/session/scratch', TEMP: '/session/scratch', PATH: '/usr/bin' };
    const client = tmuxEnv(env);
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) expect(client[key]).toBeUndefined();
    expect(client.PATH?.split(':')).toContain('/usr/bin');
    expect(env.TMPDIR).toBe('/session/scratch');
  });
});

describe('orphan scratch sweep (#1748)', () => {
  const later = () => Date.now() + 10 * 60_000;
  const noLive = async () => new Set<string>();

  function sweepRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-scratch-sweep-')));
    roots.push(root);
    return root;
  }

  function legacyDir(root: string, data: string, sessionId: string): string {
    const profile = createHash('sha256').update(resolve(data)).digest('hex').slice(0, 16);
    const path = join(root, profile, sessionId);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it('removes scratch of sessions that are not active and keeps every active one', async () => {
    const root = sweepRoot();
    const data = dataDir();
    const active = ensureSessionTempDir(data, 'suspended-active', root);
    const closed = ensureSessionTempDir(data, 'closed', root);
    const unknown = ensureSessionTempDir(data, 'no-row-anywhere', root);
    writeFileSync(join(active, 'clone'), 'keep');

    const removed = await sweepOrphanSessionTempDirs(data, new Set(['suspended-active']), {
      root, now: later(), liveReferences: noLive,
    });

    expect(removed.sort()).toEqual([closed, unknown].sort());
    expect(readFileSync(join(active, 'clone'), 'utf8')).toBe('keep');
    expect(existsSync(closed)).toBe(false);
    expect(existsSync(unknown)).toBe(false);
  });

  it('lets a resumed session recreate the scratch the sweep removed', async () => {
    const root = sweepRoot();
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'closed-then-resumed', root);
    await sweepOrphanSessionTempDirs(data, new Set(), { root, now: later(), liveReferences: noLive });
    expect(existsSync(path)).toBe(false);

    expect(ensureSessionTempDir(data, 'closed-then-resumed', root)).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it('keeps directories inside the grace window and ones a live process uses', async () => {
    const root = sweepRoot();
    const data = dataDir();
    const fresh = ensureSessionTempDir(data, 'just-spawned', root);
    const used = ensureSessionTempDir(data, 'row-lost-but-running', root);
    utimesSync(used, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    const probe = vi.fn(async (paths: readonly string[]) => new Set(paths.filter(p => p === used)));

    const removed = await sweepOrphanSessionTempDirs(data, new Set(), { root, liveReferences: probe });

    expect(removed).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(used)).toBe(true);
    expect(probe).toHaveBeenCalledWith([used]);
  });

  it('keeps a directory a resume claimed after the liveness probe ran', async () => {
    const root = sweepRoot();
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'resumed-mid-sweep', root);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    // The resumed worker claims its scratch after the probe saw no process.
    const probe = async () => { ensureSessionTempDir(data, 'resumed-mid-sweep', root); return new Set<string>(); };

    const removed = await sweepOrphanSessionTempDirs(data, new Set(), { root, liveReferences: probe });

    expect(removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('removes nothing while no process can be seen (a v3 attempt has no store row)', async () => {
    const root = sweepRoot();
    const data = dataDir();
    const rowless = ensureSessionTempDir(data, 'v3-attempt-without-row', root);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(rowless, old, old);

    const removed = await sweepOrphanSessionTempDirs(data, new Set(), { root, liveReferences: async () => null });

    expect(removed).toEqual([]);
    expect(existsSync(rowless)).toBe(true);
  });

  it('refreshes the mtime of an existing directory when a session claims it again', () => {
    const root = sweepRoot();
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'resumed', root);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    ensureSessionTempDir(data, 'resumed', root);
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000);
  });

  it('reconciles the pre-shortening layout of the same data dir too', async () => {
    const root = sweepRoot();
    const data = dataDir();
    const keep = legacyDir(root, data, 'legacy-active');
    const drop = legacyDir(root, data, 'legacy-closed');

    await sweepOrphanSessionTempDirs(data, new Set(['legacy-active']), { root, now: later(), liveReferences: noLive });

    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
  });

  it('leaves another data dir’s sessions alone while that data dir exists', async () => {
    const root = sweepRoot();
    const mine = dataDir();
    const other = dataDir();
    mkdirSync(other, { recursive: true });
    const foreign = ensureSessionTempDir(other, 'their-session', root);

    await sweepOrphanSessionTempDirs(mine, new Set(), { root, now: later(), liveReferences: noLive });

    expect(existsSync(foreign)).toBe(true);
  });

  it('removes the profile of a data dir that no longer exists', async () => {
    const root = sweepRoot();
    const mine = dataDir();
    const gone = dataDir();
    const orphan = ensureSessionTempDir(gone, 'never-resumable', root);

    await sweepOrphanSessionTempDirs(mine, new Set(), { root, now: later(), liveReferences: noLive });
    expect(existsSync(orphan)).toBe(false);
    await sweepOrphanSessionTempDirs(mine, new Set(), { root, now: later(), liveReferences: noLive });
    expect(existsSync(dirname(orphan))).toBe(false);
  });

  it('keeps a non-empty profile that recorded no data dir, removes empty ones', async () => {
    const root = sweepRoot();
    const mine = dataDir();
    const unmarked = join(root, 'deadbeef', '0123456789abcdef');
    mkdirSync(unmarked, { recursive: true });
    const empty = join(root, 'cafebabe');
    mkdirSync(empty);

    await sweepOrphanSessionTempDirs(mine, new Set(), { root, now: later(), liveReferences: noLive });

    expect(existsSync(unmarked)).toBe(true);
    expect(existsSync(empty)).toBe(false);
  });

  it('finishes trees a crashed remover had already detached, in any profile', async () => {
    const root = sweepRoot();
    const mine = dataDir();
    const leftover = join(root, 'deadbeef', '0123456789abcdef.retired-4242-0011223344556677');
    mkdirSync(join(leftover, 'node_modules'), { recursive: true });

    await sweepOrphanSessionTempDirs(mine, new Set(), { root, now: later(), liveReferences: noLive });

    expect(existsSync(leftover)).toBe(false);
  });

  it('runs extra same-lifetime cleanup behind the ownership check', async () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'with-gateway');
    roots.push(dirname(path));
    const worker = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
    const alsoRemove = vi.fn();
    let owned = false;
    cleanupSessionTempDirAfterExit(data, 'with-gateway', worker, vi.fn(), () => owned, alsoRemove);
    worker.emit('exit', 0, null);
    expect(alsoRemove).not.toHaveBeenCalled();

    const second = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
    owned = true;
    cleanupSessionTempDirAfterExit(data, 'with-gateway', second, vi.fn(), () => owned, alsoRemove);
    expect(alsoRemove).not.toHaveBeenCalled();
    second.emit('exit', 0, null);
    expect(alsoRemove).toHaveBeenCalledTimes(1);
  });
});
