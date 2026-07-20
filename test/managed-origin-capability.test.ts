import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ensureManagedOriginAttestationDirectory,
  ensureManagedOriginDataRootProbe,
  ensureManagedOriginRootLocator,
  hasManagedOriginIsolationMarker,
  managedOriginAttestationDirectory,
  managedOriginCapabilityPath,
  managedOriginDataRootProbeAccess,
  managedOriginDataRootProbePath,
  managedOriginRootLocatorPath,
  readManagedOriginAuthorityFile,
  readManagedOriginCapability,
  readManagedOriginRootLocator,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

describe('managed origin capability transport', () => {
  const G1 = '11'.repeat(32);
  const G2 = '22'.repeat(32);
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
    const path = managedOriginCapabilityPath(dir, sessionId, G1);
    expect(path).toMatch(/\/read-isolation\/origin-[a-f0-9]{64}\.json$/);
    expect(path).not.toContain(sessionId);
    expect(managedOriginCapabilityPath(dir, 'another-session', G1)).not.toBe(path);
    expect(managedOriginCapabilityPath(dir, sessionId, G2)).not.toBe(path);

    replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId,
      channelId: G1,
      capability: 'ab'.repeat(32),
      turnId: 'turn-1',
      dispatchAttempt: 2,
    }));
    expect(readManagedOriginCapability(dir, sessionId, undefined, G1)).toEqual({
      sessionId,
      channelId: G1,
      capability: 'ab'.repeat(32),
      turnId: 'turn-1',
      dispatchAttempt: 2,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readManagedOriginCapability(dir, 'another-session', undefined, G1)).toBeNull();
    expect(readManagedOriginCapability(dir, sessionId, undefined, G2)).toBeNull();
    expect(readManagedOriginCapability(dir, sessionId)).toBeNull();
  });

  it('replaces a planted destination symlink without overwriting its target', () => {
    const dir = makeDir();
    const path = managedOriginCapabilityPath(dir, 'session-a', G1);
    mkdirSync(dirname(path), { recursive: true });
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'sentinel');
    symlinkSync(target, path);

    replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId: 'session-a',
      channelId: G1,
      capability: 'cd'.repeat(32),
    }));

    expect(readFileSync(target, 'utf8')).toBe('sentinel');
    expect(readManagedOriginCapability(dir, 'session-a', undefined, G1)?.capability).toBe('cd'.repeat(32));
  });

  it('recovers a planted attestation-dir symlink without touching its target and writes the static marker', () => {
    const dir = makeDir();
    const proofDir = managedOriginAttestationDirectory(dir, 'session-a', G1);
    mkdirSync(dirname(proofDir), { recursive: true });
    const target = join(dir, 'attacker-target');
    mkdirSync(target);
    writeFileSync(join(target, 'sentinel'), 'keep');
    symlinkSync(target, proofDir);

    expect(ensureManagedOriginAttestationDirectory(dir, 'session-a', G1)).toBe(proofDir);
    expect(lstatSync(proofDir).isDirectory()).toBe(true);
    expect(lstatSync(proofDir).isSymbolicLink()).toBe(false);
    expect(statSync(proofDir).mode & 0o777).toBe(0o700);
    expect(hasManagedOriginIsolationMarker(dir, 'session-a', G1)).toBe(true);
    expect(hasManagedOriginIsolationMarker(dir, 'session-a', G2)).toBe(false);
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('rejects a symlinked parent instead of writing through it', () => {
    const dir = makeDir();
    const targetDir = join(dir, 'attacker-target');
    mkdirSync(targetDir);
    symlinkSync(targetDir, join(dir, 'read-isolation'));
    const path = managedOriginCapabilityPath(dir, 'session-a', G1);

    expect(() => replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId: 'session-a',
      channelId: G1,
      capability: 'de'.repeat(32),
    }))).toThrow(/not a real directory/);
    expect(readManagedOriginCapability(dir, 'session-a', undefined, G1)).toBeNull();
  });

  it('reads the Linux relay token but rejects malformed authority', () => {
    const dir = makeDir();
    const relay = join(dir, 'relay');
    mkdirSync(relay);
    const relayPath = join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME);
    writeFileSync(relayPath, JSON.stringify({ token: 'ef'.repeat(32) }), { mode: 0o600 });
    expect(readManagedOriginCapability(dir, 'session-a', relay)).toEqual({
      sessionId: 'session-a',
      capability: 'ef'.repeat(32),
    });
    writeFileSync(relayPath, JSON.stringify({ token: 'not-a-capability' }), { mode: 0o600 });
    expect(readManagedOriginCapability(dir, 'session-a', relay)).toBeNull();
  });

  it('refuses a symlink capability leaf instead of following it', () => {
    const dir = makeDir();
    const relay = join(dir, 'relay');
    mkdirSync(relay);
    const target = join(dir, 'target-cap');
    writeFileSync(target, JSON.stringify({ token: 'ef'.repeat(32) }), { mode: 0o600 });
    symlinkSync(target, join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME));
    expect(readManagedOriginCapability(dir, 'session-a', relay)).toBeNull();
  });

  it('keeps same-session pane generations disjoint when an old worker tears down', () => {
    const dir = makeDir();
    const p1 = managedOriginCapabilityPath(dir, 'session-a', G1);
    const p2 = managedOriginCapabilityPath(dir, 'session-a', G2);
    replaceManagedOriginCapabilityFile(p1, JSON.stringify({
      sessionId: 'session-a', channelId: G1, capability: 'aa'.repeat(32),
    }));
    replaceManagedOriginCapabilityFile(p2, JSON.stringify({
      sessionId: 'session-a', channelId: G2, capability: 'bb'.repeat(32),
    }));
    rmSync(p1, { force: true });
    expect(readManagedOriginCapability(dir, 'session-a', undefined, G1)).toBeNull();
    expect(readManagedOriginCapability(dir, 'session-a', undefined, G2)?.capability)
      .toBe('bb'.repeat(32));
  });

  it('reads a root locator through a symlinked ~/.botmux parent and rejects unsafe leaves', () => {
    const root = makeDir();
    const osHome = join(root, 'home');
    const actualBotmux = join(root, 'actual-botmux');
    const dataDir = join(root, 'data');
    mkdirSync(osHome);
    mkdirSync(actualBotmux, { mode: 0o700 });
    mkdirSync(dataDir);
    symlinkSync(actualBotmux, join(osHome, '.botmux'));

    ensureManagedOriginRootLocator(osHome, 'session-a', dataDir);
    expect(readManagedOriginRootLocator(osHome, 'session-a')).toEqual({
      sessionId: 'session-a', dataDir: realpathSync(dataDir),
    });

    const locator = managedOriginRootLocatorPath(osHome, 'session-a');
    const target = join(root, 'attacker-locator');
    writeFileSync(target, JSON.stringify({
      domain: 'botmux.managed-origin-root.v1', sessionId: 'session-a', dataDir,
    }), { mode: 0o600 });
    rmSync(locator);
    symlinkSync(target, locator);
    expect(readManagedOriginRootLocator(osHome, 'session-a')).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('rejects FIFO and oversized authority metadata without blocking', () => {
    const dir = makeDir();
    const fifo = join(dir, 'authority.fifo');
    execFileSync('mkfifo', [fifo]);
    expect(readManagedOriginAuthorityFile(fifo)).toBeNull();
    const oversized = join(dir, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(8 * 1024 + 1), { mode: 0o600 });
    expect(readManagedOriginAuthorityFile(oversized)).toBeNull();
  });

  it('binds the kernel probe to the exact data root and rejects DAC-only denial', () => {
    const root = makeDir();
    const dataDir = join(root, 'data');
    const sibling = join(root, 'fake-data');
    mkdirSync(dataDir);
    mkdirSync(sibling);
    ensureManagedOriginDataRootProbe(dataDir, 'session-a');
    expect(managedOriginDataRootProbeAccess(realpathSync(dataDir), 'session-a'))
      .toBe('host_accessible');
    expect(managedOriginDataRootProbePath(realpathSync(dataDir), 'session-a'))
      .not.toBe(managedOriginDataRootProbePath(realpathSync(sibling), 'session-a'));
    expect(managedOriginDataRootProbeAccess(realpathSync(sibling), 'session-a'))
      .toBe('missing_or_unsafe');

    const fakeProbe = managedOriginDataRootProbePath(realpathSync(sibling), 'session-a');
    replaceManagedOriginCapabilityFile(fakeProbe, JSON.stringify({
      domain: 'botmux.managed-origin-root-probe.v1',
      sessionId: 'session-a',
      dataDir: realpathSync(sibling),
    }));
    // A writable fake root can manufacture EACCES with mode 000; only
    // Seatbelt's EPERM is accepted as confinement evidence.
    chmodSync(fakeProbe, 0o000);
    expect(managedOriginDataRootProbeAccess(realpathSync(sibling), 'session-a'))
      .toBe('missing_or_unsafe');
  });
});
