/**
 * PR1 mitigation: per-install-entry observation shared by all workers.
 *
 * Detection must be cheap (one stat per entry per TTL, never a `--version`
 * probe), must use the worker's own attested running identity, and must treat
 * every unavailable input as `unknown` — only `stale` may drive a reclaim.
 *
 * Run: bun x vitest run --project unit test/traex-install-watch.test.ts
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { resolveInstallIdentity } from '../src/services/cli-install-identity.js';
import {
  observeTraexInstall,
  __testOnly_resetTraexInstallWatch,
} from '../src/services/traex-install-watch.js';

const dirs: string[] = [];

function tempEntry(content = 'release-0.214.1'): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-traex-watch-'));
  dirs.push(dir);
  const entry = join(dir, 'traex');
  writeFileSync(entry, content);
  return { dir, entry };
}

function ds(attestation?: DaemonSession['localProcessAttestation']): DaemonSession {
  return { localProcessAttestation: attestation } as unknown as DaemonSession;
}

beforeEach(() => __testOnly_resetTraexInstallWatch());
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('observeTraexInstall', () => {
  it('is not-traex for any other CLI', () => {
    expect(observeTraexInstall(ds(), 'claude-code')).toEqual({ state: 'not-traex' });
  });

  it('is unknown without an attestation', () => {
    expect(observeTraexInstall(ds(), 'traex')).toMatchObject({ state: 'unknown', reason: 'no-attestation' });
  });

  it('is unknown when the running identity is unavailable (macOS / not yet resolved)', () => {
    expect(observeTraexInstall(ds({ backendType: 'pty', credentialIsolated: false }), 'traex'))
      .toMatchObject({ state: 'unknown', reason: 'running-identity-unknown' });
  });

  it('is unknown when the worker never reported its install entry', () => {
    const { entry } = tempEntry();
    const running = resolveInstallIdentity(entry)!;
    expect(observeTraexInstall(ds({ backendType: 'pty', credentialIsolated: false, cliExe: running }), 'traex'))
      .toMatchObject({ state: 'unknown', reason: 'install-entry-unknown' });
  });

  it('is unknown when the recorded install entry no longer resolves', () => {
    const { entry } = tempEntry();
    const running = resolveInstallIdentity(entry)!;
    rmSync(entry);
    expect(observeTraexInstall(
      ds({ backendType: 'pty', credentialIsolated: false, cliExe: running, cliInstallEntry: entry, cliInstallAtSpawn: running }),
      'traex',
    )).toMatchObject({ state: 'unknown', reason: 'install-entry-missing' });
  });

  it('is unknown when the worker did not record what the entry named at spawn', () => {
    const { entry } = tempEntry();
    const running = resolveInstallIdentity(entry)!;
    expect(observeTraexInstall(
      ds({ backendType: 'pty', credentialIsolated: false, cliExe: running, cliInstallEntry: entry }),
      'traex',
    )).toMatchObject({ state: 'unknown', reason: 'install-at-spawn-unknown' });
  });

  it('is unknown when the entry did not name the running image at spawn (wrapper layout)', () => {
    const { entry } = tempEntry('#!/bin/sh\nexec /opt/traex/bin/traex "$@"\n');
    const { entry: real } = tempEntry('real-traex-binary');
    const wrapper = resolveInstallIdentity(entry)!;
    const running = { ...resolveInstallIdentity(real)!, source: 'linux-proc-exe' as const };
    // Nothing was upgraded, yet the wrapper's identity never matches the running image.
    expect(observeTraexInstall(
      ds({
        backendType: 'pty', credentialIsolated: false,
        cliExe: running, cliInstallEntry: entry, cliInstallAtSpawn: wrapper,
      }),
      'traex',
    )).toMatchObject({ state: 'unknown', reason: 'launch-unproven' });
  });

  it('is current when the process runs the installed inode', () => {
    const { entry } = tempEntry();
    const running = resolveInstallIdentity(entry)!;
    const result = observeTraexInstall(
      ds({ backendType: 'pty', credentialIsolated: false, cliExe: running, cliInstallEntry: entry, cliInstallAtSpawn: running }),
      'traex',
    );
    expect(result.state).toBe('current');
  });

  it('is stale when the process holds an older inode than the entry', () => {
    const { entry } = tempEntry('release-0.213.1');
    const running = resolveInstallIdentity(entry)!;
    // Upgrade: a new file replaces the entry.
    writeFileSync(entry, 'release-0.214.1-longer');
    const result = observeTraexInstall(
      ds({ backendType: 'pty', credentialIsolated: false, cliExe: running, cliInstallEntry: entry, cliInstallAtSpawn: running }),
      'traex',
    );
    expect(result.state).toBe('stale');
    if (result.state === 'stale') {
      expect(result.running.ino).toBe(running.ino);
      expect(result.installAtSpawn.ino).toBe(running.ino);
      expect(result.install.ino).toBe(statSync(entry, { bigint: true }).ino.toString());
    }
  });

  it('caches the install stat per entry for the TTL so N workers cost one lookup', () => {
    const { entry } = tempEntry('old');
    const running = resolveInstallIdentity(entry)!;
    const attestation = { backendType: 'pty', credentialIsolated: false, cliExe: running, cliInstallEntry: entry, cliInstallAtSpawn: running };
    const now = 1_000_000;

    expect(observeTraexInstall(ds(attestation), 'traex', now).state).toBe('current');

    // Replace the entry; within the TTL the cached identity is still used.
    writeFileSync(entry, 'a-new-release-with-a-different-size');
    expect(observeTraexInstall(ds(attestation), 'traex', now + 1).state).toBe('current');

    // Past the TTL the shared cache refreshes and the mismatch is visible.
    expect(observeTraexInstall(ds(attestation), 'traex', now + 15_001).state).toBe('stale');
  });

  it('shares one cache across workers of the same entry', () => {
    const { entry } = tempEntry('release');
    const running = resolveInstallIdentity(entry)!;
    const attestation = { backendType: 'pty', credentialIsolated: false, cliExe: running, cliInstallEntry: entry, cliInstallAtSpawn: running };
    const now = 2_000_000;
    expect(observeTraexInstall(ds(attestation), 'traex', now).state).toBe('current');

    writeFileSync(entry, 'release-upgraded-longer');
    // A second worker (different session object, same install entry) sees the
    // same cached answer instead of re-statting.
    expect(observeTraexInstall(ds(attestation), 'traex', now + 10).state).toBe('current');
    expect(observeTraexInstall(ds(attestation), 'traex', now + 15_001).state).toBe('stale');
  });
});
