import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeEffortObserver } from '../src/services/claude-effort-observer.js';
import {
  __testOnly_resetStatuslineCache,
  parseStatuslinePayload,
  statuslineFilePath,
  STATUSLINE_STALE_MS,
  writeStatuslineSnapshot,
} from '../src/services/statusline-snapshot.js';

const NOW = 1_799_000_000_000;
const NATIVE = 'native-claude-session';
let dir: string;
let observer: ClaudeEffortObserver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-effort-'));
  observer = new ClaudeEffortObserver();
  __testOnly_resetStatuslineCache();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function write(level?: string, ts = NOW, native = NATIVE): void {
  writeStatuslineSnapshot(dir, 'botmux-sid', parseStatuslinePayload({
    session_id: native, model: { id: 'claude-opus-5-5' },
    ...(level ? { effort: { level } } : {}),
  }, ts)!);
  // Make the file's refresh visible to the production mtime/size cache even
  // when two isolated fixture writes happen in the same real millisecond.
  utimesSync(statuslineFilePath(dir, 'botmux-sid'), new Date(ts), new Date(ts));
}
function observe(now = NOW, notBefore = NOW - 1) {
  return observer.observe(dir, 'botmux-sid', { claudeSessionId: NATIVE, now, notBefore });
}

describe('Claude statusline effort observer', () => {
  it('reports high → medium without a model turn or model change, deduplicating repeated readings', () => {
    write('high');
    expect(observe()).toEqual({ claudeSessionId: NATIVE, reasoningEffort: 'high' });
    expect(observe()).toBeUndefined();
    write('medium', NOW + 1);
    expect(observe(NOW + 1)).toEqual({ claudeSessionId: NATIVE, reasoningEffort: 'medium' });
    expect(observe(NOW + 2)).toBeUndefined();
  });

  it('clears an observed effort when the native model no longer reports one', () => {
    write('high'); observe();
    write(undefined, NOW + 1);
    expect(observe(NOW + 1)).toEqual({ claudeSessionId: NATIVE, reasoningEffort: null });
  });

  it('republishes an unchanged effort on a new native snapshot after a binding race', () => {
    write('medium'); expect(observe()?.reasoningEffort).toBe('medium');
    write('medium', NOW + 1);
    expect(observe(NOW + 1)?.reasoningEffort).toBe('medium');
    expect(observe(NOW + 2)).toBeUndefined();
  });

  it('expires an unchanged cached reading when statusline reporting stops, then recovers', () => {
    write('high'); observe();
    expect(observe(NOW + STATUSLINE_STALE_MS + 1)).toEqual({ claudeSessionId: NATIVE, reasoningEffort: null });
    write('medium', NOW + STATUSLINE_STALE_MS + 2);
    expect(observe(NOW + STATUSLINE_STALE_MS + 2)).toEqual({ claudeSessionId: NATIVE, reasoningEffort: 'medium' });
  });

  it('does not reuse a previous CLI generation, even for the same native session', () => {
    write('high'); observe();
    observer.reset();
    expect(observe(NOW + 1, NOW + 1)).toEqual({ claudeSessionId: NATIVE, reasoningEffort: null });
    write('medium', NOW + 2);
    expect(observe(NOW + 2, NOW + 1)?.reasoningEffort).toBe('medium');
  });

  it.each(['another-session', ''])('rejects snapshots belonging to an unbound native session (%s)', native => {
    write('medium', NOW, native);
    expect(observe()?.reasoningEffort).toBeNull();
  });

  it('does not accept a snapshot with a future timestamp', () => {
    write('medium', NOW + 1);
    expect(observe()?.reasoningEffort).toBeNull();
  });

  it('clears corrupt/removed snapshots and can read a repaired one', () => {
    write('high'); observe();
    writeFileSync(statuslineFilePath(dir, 'botmux-sid'), '{broken');
    expect(observe()?.reasoningEffort).toBeNull();
    write('medium', NOW + 1);
    expect(observe(NOW + 1)?.reasoningEffort).toBe('medium');
    rmSync(statuslineFilePath(dir, 'botmux-sid'));
    expect(observe(NOW + 2)?.reasoningEffort).toBeNull();
  });
});
