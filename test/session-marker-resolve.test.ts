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

  it('prefers the marker (with its fresh turnId) over the env when ancestry resolves', () => {
    writeMarker(process.pid, JSON.stringify({ sessionId: 'marker-sid', turnId: 'turn-9' }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'marker-sid', turnId: 'turn-9' });
  });

  it('parses a positive integer dispatchAttempt from the marker', () => {
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'marker-sid',
      turnId: 'turn-9',
      dispatchAttempt: 2,
    }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'marker-sid', turnId: 'turn-9', dispatchAttempt: 2 });
  });

  it.each([0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])(
    'ignores an invalid marker dispatchAttempt (%s)',
    (dispatchAttempt) => {
      writeMarker(process.pid, JSON.stringify({ sessionId: 'marker-sid', dispatchAttempt }));
      const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
      expect(ctx?.sessionId).toBe('marker-sid');
      expect(ctx?.dispatchAttempt).toBeUndefined();
    },
  );

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

  it('does not mix a marker with another session capability', () => {
    writeMarker(process.pid, JSON.stringify({
      sessionId: 'marker-sid',
      turnId: 'turn-marker',
      dispatchAttempt: 1,
    }));
    writeCapability('env-sid', {
      capability: 'cd'.repeat(32),
      turnId: 'turn-protected',
      dispatchAttempt: 2,
    });
    expect(resolveSessionContext(dir, 'env-sid', process.pid)).toEqual({
      sessionId: 'marker-sid',
      turnId: 'turn-marker',
      dispatchAttempt: 1,
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
