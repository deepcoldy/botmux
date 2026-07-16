import { describe, expect, it, afterEach } from 'vitest';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  managedOriginCapabilityPath,
  readManagedOriginCapability,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

describe('managed origin capability transport', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-origin-cap-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('derives an opaque path and validates a direct per-session claim', () => {
    const dir = makeDir();
    const sessionId = '../session/private';
    const path = managedOriginCapabilityPath(dir, sessionId);
    expect(path).toMatch(/\/read-isolation\/origin-[a-f0-9]{64}\.json$/);
    expect(path).not.toContain(sessionId);
    expect(managedOriginCapabilityPath(dir, 'another-session')).not.toBe(path);

    replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId,
      capability: 'ab'.repeat(32),
      turnId: 'turn-1',
      dispatchAttempt: 2,
    }));
    expect(readManagedOriginCapability(dir, sessionId)).toEqual({
      sessionId,
      capability: 'ab'.repeat(32),
      turnId: 'turn-1',
      dispatchAttempt: 2,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readManagedOriginCapability(dir, 'another-session')).toBeNull();
  });

  it('replaces a planted destination symlink without overwriting its target', () => {
    const dir = makeDir();
    const path = managedOriginCapabilityPath(dir, 'session-a');
    mkdirSync(dirname(path), { recursive: true });
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'sentinel');
    symlinkSync(target, path);

    replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId: 'session-a',
      capability: 'cd'.repeat(32),
    }));

    expect(readFileSync(target, 'utf8')).toBe('sentinel');
    expect(readManagedOriginCapability(dir, 'session-a')?.capability).toBe('cd'.repeat(32));
  });

  it('rejects a symlinked parent instead of writing through it', () => {
    const dir = makeDir();
    const targetDir = join(dir, 'attacker-target');
    mkdirSync(targetDir);
    symlinkSync(targetDir, join(dir, 'read-isolation'));
    const path = managedOriginCapabilityPath(dir, 'session-a');

    expect(() => replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId: 'session-a',
      capability: 'de'.repeat(32),
    }))).toThrow(/not a real directory/);
    expect(readManagedOriginCapability(dir, 'session-a')).toBeNull();
  });

  it('reads the Linux relay token but rejects malformed authority', () => {
    const dir = makeDir();
    const relay = join(dir, 'relay');
    mkdirSync(relay);
    const relayPath = join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME);
    writeFileSync(relayPath, JSON.stringify({ token: 'ef'.repeat(32) }));
    expect(readManagedOriginCapability(dir, 'session-a', relay)).toEqual({
      sessionId: 'session-a',
      capability: 'ef'.repeat(32),
    });
    writeFileSync(relayPath, JSON.stringify({ token: 'not-a-capability' }));
    expect(readManagedOriginCapability(dir, 'session-a', relay)).toBeNull();
  });
});
