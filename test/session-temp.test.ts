import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    expect(path.endsWith('/session-123')).toBe(true);
    expect(existsSync(path)).toBe(true);

    const env: NodeJS.ProcessEnv = {};
    applySessionTempEnv(env, path);
    expect(env).toMatchObject({ TMPDIR: path, TMP: path, TEMP: path });
  });

  it('hashes unsafe session ids instead of permitting traversal', () => {
    const data = dataDir();
    const path = sessionTempDir(data, '../../escape');
    expect(path).toMatch(/\/session-tmp\/[0-9a-f]{16}\/sha256-[0-9a-f]{64}$/);
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
    expect(existsSync(path)).toBe(true);
    worker.emit('exit', 0, null);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(onError).not.toHaveBeenCalled();
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
});
