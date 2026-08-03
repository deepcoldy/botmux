import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartIdentity, resolveSessionContext } from '../src/core/session-marker.js';
import {
  managedOriginCapabilityPath,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

// resolveSessionContext is the layer that powers session-id inference for
// `botmux send` / history / bots. Regression guard: a detached/backgrounded
// invocation breaks the process-tree marker walk, and before the env fallback
// it errored with "无法推断 session-id" even though BOTMUX_SESSION_ID was right
// there in the inherited env.
describe('resolveSessionContext()', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bmx-marker-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeMarker(pid: number, body: string): void {
    const markersDir = join(dir, '.botmux-cli-pids');
    mkdirSync(markersDir, { recursive: true });
    writeFileSync(join(markersDir, String(pid)), body);
  }

  function writeCapability(sessionId: string, body: Record<string, unknown>): void {
    replaceManagedOriginCapabilityFile(
      managedOriginCapabilityPath(dir, sessionId),
      JSON.stringify({ sessionId, ...body }),
    );
  }

  // A genuine worker marker always names the SAME session as the injected
  // BOTMUX_SESSION_ID (both are written per-spawn for one session); the marker's
  // only edge is carrying the fresh per-turn turnId/dispatchAttempt the env lacks.
  it('prefers the marker (with its fresh turnId) over the env when ancestry resolves', () => {
    writeMarker(process.pid, JSON.stringify({ sessionId: 'env-sid', turnId: 'turn-9' }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid', turnId: 'turn-9' });
  });

  it('parses a positive integer dispatchAttempt from the marker', () => {
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'env-sid',
      turnId: 'turn-9',
      dispatchAttempt: 2,
    }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid', turnId: 'turn-9', dispatchAttempt: 2 });
  });

  it.each([0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])(
    'ignores an invalid marker dispatchAttempt (%s)',
    (dispatchAttempt) => {
      writeMarker(process.pid, JSON.stringify({ sessionId: 'env-sid', dispatchAttempt }));
      const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
      expect(ctx?.sessionId).toBe('env-sid');
      expect(ctx?.dispatchAttempt).toBeUndefined();
    },
  );

  // ── Recycled-PID misroute guard (the cross-bot leak these fixes address) ──
  // The kernel recycles PID numbers; a since-exited session's marker file left on
  // a reused PID must never route THIS process's send into that stale session.
  it('rejects a legacy marker whose session differs from env (the cross-bot leak) → env fallback', () => {
    // Reproduces the incident: a June legacy marker (no procStart) on a recycled
    // low PID named a DIFFERENT bot's long-closed session. The marker walk must
    // skip it and fall back to the authoritative inherited env session id.
    writeMarker(process.pid, JSON.stringify({ sessionId: 'stale-other-bot-sid', turnId: null }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid' });
  });

  it('rejects a marker whose procStart ≠ the live process (recycled PID with a birth-stamp)', () => {
    // A newer marker carries procStart; if it disagrees with the live process the
    // PID was recycled onto us — skip even when it happens to match the env sid.
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'env-sid', turnId: 'turn-x', procStart: '1', // 1 tick ≠ any real start
    }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid' }); // env fallback, marker's turnId dropped
  });

  it('honors a marker whose procStart MATCHES the live process (genuine ancestor)', () => {
    const liveStart = readProcessStartIdentity(process.pid);
    expect(liveStart).toBeTruthy();
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'env-sid', turnId: 'turn-live', procStart: liveStart,
    }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid', turnId: 'turn-live' });
  });

  it('honors a live legacy marker (no procStart) that matches env — zero regression for old-format sessions', () => {
    // 700+ live sessions in the fleet still carry pre-procStart markers. As long
    // as the sid matches the inherited env, they stay fully trusted.
    writeMarker(process.pid, JSON.stringify({ sessionId: 'env-sid', turnId: 'turn-legacy' }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid', turnId: 'turn-legacy' });
  });

  it('trusts a live legacy marker when no env is available to contradict it', () => {
    // host-command-context passes envSessionId=undefined ("am I in a session?").
    // With nothing to disprove and a live PID, the marker is honored as before.
    writeMarker(process.pid, JSON.stringify({ sessionId: 'only-marker-sid', turnId: 't' }));
    const ctx = resolveSessionContext(dir, undefined, process.pid);
    expect(ctx).toEqual({ sessionId: 'only-marker-sid', turnId: 't' });
  });


  it('falls back to BOTMUX_SESSION_ID when the marker walk finds nothing (detached/backgrounded)', () => {
    // No markers dir at all → ancestry walk returns null, the detached case.
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid' });
  });

  it('uses the protected per-session capability snapshot when PID markers are hidden', () => {
    writeCapability('env-sid', {
      capability: 'ab'.repeat(32),
      turnId: 'turn-protected',
      dispatchAttempt: 3,
    });
    expect(resolveSessionContext(dir, 'env-sid', process.pid)).toEqual({
      sessionId: 'env-sid',
      turnId: 'turn-protected',
      dispatchAttempt: 3,
    });
  });

  it('prefers a live marker over a residual same-session capability snapshot', () => {
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'env-sid',
      turnId: 'turn-live',
      dispatchAttempt: 1,
    }));
    writeCapability('env-sid', {
      capability: 'bc'.repeat(32),
      turnId: 'turn-residual',
      dispatchAttempt: 4,
    });
    expect(resolveSessionContext(dir, 'env-sid', process.pid)).toEqual({
      sessionId: 'env-sid',
      turnId: 'turn-live',
      dispatchAttempt: 1,
    });
  });

  it('rejects a foreign-session marker and uses this session’s own capability snapshot instead', () => {
    // marker names a DIFFERENT session than env → recycled-PID collision. It must
    // be skipped, and resolution must land on env-sid's own capability snapshot,
    // never blending the foreign marker's fields in.
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'foreign-sid',
      turnId: 'turn-marker',
      dispatchAttempt: 1,
    }));
    writeCapability('env-sid', {
      capability: 'cd'.repeat(32),
      turnId: 'turn-protected',
      dispatchAttempt: 2,
    });
    expect(resolveSessionContext(dir, 'env-sid', process.pid)).toEqual({
      sessionId: 'env-sid',
      turnId: 'turn-protected',
      dispatchAttempt: 2,
    });
  });

  it('falls back to env when the matched marker is empty/legacy (no usable sessionId)', () => {
    writeMarker(process.pid, ''); // legacy empty marker
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid' });
  });

  it('returns null when neither marker nor env can identify a session', () => {
    expect(resolveSessionContext(dir, undefined, process.pid)).toBeNull();
  });

  it('does not invent a turnId on the env path', () => {
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx?.turnId).toBeUndefined();
  });

  it('never falls back to an ambient PATH ps probe on Linux', () => {
    if (process.platform !== 'linux') return;
    const fakeBin = join(dir, 'bin');
    const touched = join(dir, 'ambient-ps-ran');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'ps'), `#!/bin/sh\ntouch ${JSON.stringify(touched)}\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      expect(readProcessStartIdentity(999_999_999)).toBeUndefined();
      expect(existsSync(touched)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
