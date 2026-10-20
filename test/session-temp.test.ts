import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  applySessionTempEnv,
  cleanupSessionTempDir,
  cleanupSessionTempDirAfterExit,
  ensureSessionTempDir,
  sessionTempDir,
} from '../src/core/session-temp.js';
import { buildBotmuxEnvAssignments } from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';

const roots: string[] = [];

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-session-temp-'));
  roots.push(root);
  return join(root, 'data');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session temp', () => {
  it('creates stable per-session scratch in the user cache tree', () => {
    const data = dataDir();
    const path = ensureSessionTempDir(data, 'session-123');
    roots.push(dirname(path));
    expect(path.startsWith(join(homedir(), '.cache', 'botmux', 'session-tmp'))).toBe(true);
    expect(path).toMatch(/\/session-tmp\/[0-9a-f]{8}\/[0-9a-f]{16}$/);
    expect(existsSync(path)).toBe(true);

    const env: NodeJS.ProcessEnv = {};
    applySessionTempEnv(env, path);
    expect(env).toMatchObject({ TMPDIR: path, TMP: path, TEMP: path });
  });

  it('hashes unsafe session ids instead of permitting traversal', () => {
    const data = dataDir();
    const path = sessionTempDir(data, '../../escape');
    expect(path).toMatch(/\/session-tmp\/[0-9a-f]{8}\/[0-9a-f]{16}$/);
  });

  it('leaves room under the 104-byte AF_UNIX limit for sockets created in TMPDIR', () => {
    // The scratch dir becomes the CLI's TMPDIR. A raw UUID segment used to put
    // e.g. Python multiprocessing's listener socket past macOS's sun_path cap.
    const path = sessionTempDir(dataDir(), '6c255026-e993-495d-80ec-85d2c3c440dc');
    expect(relative(homedir(), path).length).toBeLessThanOrEqual(51);
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
    const path = sessionTempDir(data, 'linked');
    roots.push(dirname(path));
    mkdirSync(join(path, '..'), { recursive: true });
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
