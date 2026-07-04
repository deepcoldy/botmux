import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionContext } from '../src/core/session-marker.js';

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

  it('prefers the marker (with its fresh turnId) over the env when ancestry resolves', () => {
    writeMarker(process.pid, JSON.stringify({ sessionId: 'marker-sid', turnId: 'turn-9' }));
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'marker-sid', turnId: 'turn-9' });
  });

  it('falls back to BOTMUX_SESSION_ID when the marker walk finds nothing (detached/backgrounded)', () => {
    // No markers dir at all → ancestry walk returns null, the detached case.
    const ctx = resolveSessionContext(dir, 'env-sid', process.pid);
    expect(ctx).toEqual({ sessionId: 'env-sid' });
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
});
