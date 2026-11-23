/**
 * The per-session idle auto-compact setting rides the session row: it must
 * survive a daemon restart (a fresh store load from SQLite), and the persisted
 * idle stretch must let the restored session keep counting from the real idle
 * start rather than from boot.
 *
 * Run: bun run vitest run test/idle-auto-compact-store.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } }, daemon: { backendType: 'tmux', cliId: 'claude-code' } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSession, getSession, init, updateSession, __testOnly_setBeforeRowPersist } from '../src/services/session-store.js';
import {
  applyIdleAutoCompactSetting,
  noteIdleAutoCompactDirectInput,
  noteIdleAutoCompactRefused,
  noteIdleAutoCompactScreenStatus,
  noteIdleAutoCompactTurnEnded,
  runIdleAutoCompactSweep,
} from '../src/core/idle-auto-compact.js';
import type { DaemonSession } from '../src/core/types.js';
import { stampIdleSinceAt } from '../src/core/worker-pool.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
const APP = 'cli_idle_compact_store';

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'idle-compact-store-')); init(APP); });
afterEach(() => { __testOnly_setBeforeRowPersist(undefined); rmSync(tempDir, { recursive: true, force: true }); });

describe('idle auto-compact persistence', () => {
  it('the opt-in and the running idle stretch survive a store reload', () => {
    const session = createSession('oc_chat', 'om_root', 'idle compact', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true, minutes: 30 });
    updateSession(session);
    // A botmux turn just ended (armed by its start) and the screen went idle.
    const live = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactArm: { at: T0 - MIN, busy: true } } as unknown as DaemonSession;
    expect(noteIdleAutoCompactScreenStatus(live, 'working', T0)).toBe(true);
    updateSession(session);

    // "Restart": drop the in-memory map and reload the row from SQLite.
    init(APP);
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.idleAutoCompact).toEqual({ enabled: true, minutes: 30, idleSince: T0 });

    const restored = { session: reloaded, lastScreenStatus: 'idle', idleSinceAt: T0 + 20 * MIN } as unknown as DaemonSession;
    noteIdleAutoCompactScreenStatus(restored, undefined, T0 + 20 * MIN);
    const compact = vi.fn(() => true);
    const sweep = (at: number) => runIdleAutoCompactSweep([restored], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: ds => updateSession(ds.session), compact, notify: () => {}, log: () => {},
    });
    expect(sweep(T0 + 29 * MIN)).toBe(0);
    expect(sweep(T0 + 30 * MIN)).toBe(1);
    // The claim is durable too: a second restart does not re-fire the stretch.
    init(APP);
    expect(getSession(session.sessionId)!.idleAutoCompact?.handledIdleSince).toBe(T0);
  });

  it('an undelivered send releases its claim through the real store (re-assigned row objects)', () => {
    const session = createSession('oc_chat', 'om_root3', 'release', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true });
    updateSession(session);
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactArm: { at: T0 - MIN, busy: true } } as unknown as DaemonSession;
    noteIdleAutoCompactScreenStatus(ds, 'working', T0);
    let accept = false;
    const compact = vi.fn(() => accept);
    const sweep = (at: number) => runIdleAutoCompactSweep([ds], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: () => {}, log: () => {},
    });
    expect(sweep(T0 + 55 * MIN)).toBe(0);
    init(APP);
    expect(getSession(session.sessionId)!.idleAutoCompact?.handledIdleSince).toBeUndefined();
    accept = true;
    expect(sweep(T0 + 56 * MIN)).toBe(1);
  });

  it('the pre-refusal busy marker and its cancellation survive a real SQLite reload', () => {
    const session = createSession('oc_chat', 'om_root4', 'busy marker', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true });
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactWarmSince: T0 } as unknown as DaemonSession;
    updateSession(session);
    const compact = vi.fn(() => true);
    runIdleAutoCompactSweep([ds], {
      now: () => T0 + 55 * MIN, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: () => {}, log: () => {},
    });
    const turnId = compact.mock.calls[0][1] as string;
    ds.lastScreenStatus = 'working';
    ds.idleSinceAt = undefined;
    expect(noteIdleAutoCompactScreenStatus(ds, 'idle', T0 + 55 * MIN + 10_000)).toBe(true);
    updateSession(session);

    init(APP);
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.idleAutoCompact?.inFlight?.busyBeforeSettled).toBe(true);
    const restored = { session: reloaded } as unknown as DaemonSession;
    expect(noteIdleAutoCompactRefused(restored, turnId, 'prompt_not_ready')?.retry).toBe(false);
    expect(restored.session.idleAutoCompact?.retry).toBeUndefined();
    expect(restored.session.idleAutoCompact?.handledIdleSince).toBe(T0);
    expect(restored.idleAutoCompactPendingNotice).toBeUndefined();
    updateSession(reloaded);
    init(APP);
    expect(getSession(session.sessionId)!.idleAutoCompact?.handledIdleSince).toBe(T0);
  });

  it('a failed busy-marker save keeps a live witness and cancels on refusal', () => {
    const session = createSession('oc_chat', 'om_root5', 'busy save failure', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true });
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactWarmSince: T0 } as unknown as DaemonSession;
    updateSession(session);
    const compact = vi.fn(() => true);
    const sweep = (at: number) => runIdleAutoCompactSweep([ds], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: () => {}, log: () => {},
    });
    sweep(T0 + 55 * MIN);
    const turnId = compact.mock.calls[0][1] as string;
    let failOnce = true;
    __testOnly_setBeforeRowPersist(() => {
      if (failOnce) { failOnce = false; throw new Error('injected SQLITE_BUSY'); }
    });
    ds.lastScreenStatus = 'working';
    stampIdleSinceAt(ds, 'idle', T0 + 55 * MIN + 10_000);
    __testOnly_setBeforeRowPersist(undefined);
    // The durable-row rollback removed the nested flag; the independent live
    // witness must still prevent a late refusal from reviving this stretch.
    expect(ds.session.idleAutoCompact?.inFlight?.busyBeforeSettled).toBeUndefined();
    expect(ds.idleAutoCompactBusyBeforeSettledTurnId).toBe(turnId);
    expect(noteIdleAutoCompactRefused(ds, turnId, 'prompt_not_ready')?.retry).toBe(false);
    updateSession(session);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    ds.lastScreenStatus = 'idle';
    stampIdleSinceAt(ds, 'working', T0 + 55 * MIN + 40_000);
    expect(sweep(T0 + 56 * MIN)).toBe(0);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it.each(['completed-first', 'idle-first'] as const)('a completed-settlement rollback reconciles without duplicates (%s)', (order) => {
    const session = createSession('oc_chat', `om_rollback_${order}`, 'completed rollback', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true });
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactWarmSince: T0 } as unknown as DaemonSession;
    updateSession(session);
    const compact = vi.fn(() => true);
    const notices: unknown[] = [];
    const sweep = (at: number) => runIdleAutoCompactSweep([ds], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: (_d, notice) => { notices.push(notice); }, log: () => {},
    });
    sweep(T0 + 55 * MIN);
    const turnId = compact.mock.calls[0][1] as string;
    ds.lastScreenStatus = 'working';
    stampIdleSinceAt(ds, 'idle', T0 + 55 * MIN + 10_000);
    if (order === 'idle-first') {
      ds.lastScreenStatus = 'idle';
      stampIdleSinceAt(ds, 'working', T0 + 55 * MIN + 40_000);
    }
    let failNext = true;
    __testOnly_setBeforeRowPersist(() => {
      if (failNext) { failNext = false; throw new Error('injected completed-settlement rollback'); }
    });
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'completed')).toBe(true);
    expect(() => updateSession(session)).toThrow('injected completed-settlement rollback');
    __testOnly_setBeforeRowPersist(undefined);
    expect(ds.idleAutoCompactCompletedTurnId).toBe(turnId);
    if (order === 'completed-first') {
      expect(ds.session.idleAutoCompact?.inFlight?.completed).toBeUndefined();
      ds.lastScreenStatus = 'idle';
      stampIdleSinceAt(ds, 'working', T0 + 55 * MIN + 40_000);
    } else {
      expect(ds.session.idleAutoCompact?.inFlight).toBeDefined();
      expect(ds.idleAutoCompactPendingNotice?.kind).toBe('compacted');
    }
    for (let m = 56; m <= 120; m += 1) sweep(T0 + m * MIN);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ kind: 'compacted', idleMinutes: 55 }]);
  });

  it('an inherited idle claim without a completed witness folds silently, never waits forever', () => {
    const session = createSession('oc_chat', 'om_completed_restart', 'completed restart', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true });
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactWarmSince: T0 } as unknown as DaemonSession;
    updateSession(session);
    const compact = vi.fn(() => true);
    const notices: unknown[] = [];
    const sweep = (target: DaemonSession, at: number) => runIdleAutoCompactSweep([target], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: (_d, notice) => { notices.push(notice); }, log: () => {},
    });
    sweep(ds, T0 + 55 * MIN);
    const turnId = compact.mock.calls[0][1] as string;
    ds.lastScreenStatus = 'working';
    stampIdleSinceAt(ds, 'idle', T0 + 55 * MIN + 10_000);
    ds.lastScreenStatus = 'idle';
    stampIdleSinceAt(ds, 'working', T0 + 55 * MIN + 40_000);
    let failNext = true;
    __testOnly_setBeforeRowPersist(() => {
      if (failNext) { failNext = false; throw new Error('injected completed restart rollback'); }
    });
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'completed')).toBe(true);
    expect(() => updateSession(session)).toThrow('injected completed restart rollback');
    __testOnly_setBeforeRowPersist(undefined);

    // Restart before any sweep reconcile: the durable idle remains, while the
    // live completed witness is gone. The inherited claim folds as handled.
    init(APP);
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.idleAutoCompact?.inFlight?.idleBeforeSettled).toBe(T0 + 55 * MIN + 40_000);
    expect(reloaded.idleAutoCompact?.inFlight?.completed).toBeUndefined();
    const restored = {
      session: reloaded, lastScreenStatus: 'idle', idleSinceAt: T0 + 55 * MIN + 40_000,
    } as unknown as DaemonSession;
    for (let m = 56; m <= 120; m += 1) sweep(restored, T0 + m * MIN);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    expect(restored.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(restored.session.idleAutoCompact?.handledIdleSince).toBe(T0 + 55 * MIN + 40_000);
  });

  it('a direct-input save rollback still preserves the user\'s new stretch', () => {
    const session = createSession('oc_chat', 'om_direct_rollback', 'direct rollback', 'group', 'thread');
    session.idleAutoCompact = { enabled: true, idleSince: T0 };
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactWarmSince: T0 } as unknown as DaemonSession;
    updateSession(session);
    const compact = vi.fn(() => true);
    const sweep = (at: number) => runIdleAutoCompactSweep([ds], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: () => {}, log: () => {},
    });
    expect(sweep(T0 + 55 * MIN)).toBe(1);
    const turnId = compact.mock.calls[0][1] as string;
    ds.lastScreenStatus = 'working';
    stampIdleSinceAt(ds, 'idle', T0 + 55 * MIN + 5_000);
    expect(noteIdleAutoCompactDirectInput(ds, T0 + 55 * MIN + 10_000)).toBe(true);
    __testOnly_setBeforeRowPersist(() => { throw new Error('injected direct-input EIO'); });
    expect(() => updateSession(session)).toThrow('injected direct-input EIO');
    __testOnly_setBeforeRowPersist(undefined);
    // The nested arm is rolled back with the row; the live arm still opens the
    // user's new stretch, so settlement must not require another nested flag.
    expect(ds.session.idleAutoCompact?.armed).toBeUndefined();
    expect(ds.session.idleAutoCompact?.inFlight?.directInputArmed).toBeUndefined();
    expect(ds.idleAutoCompactDirectInputTurnId).toBe(turnId);
    expect(ds.idleAutoCompactArm).toBeDefined();
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'completed')).toBe(true);
    updateSession(session);
    ds.lastScreenStatus = 'idle';
    stampIdleSinceAt(ds, 'working', T0 + 56 * MIN);
    expect(ds.session.idleAutoCompact?.idleSince).toBe(T0 + 56 * MIN);
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(T0);
    expect(sweep(T0 + 111 * MIN)).toBe(1);
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it.each(['terminal-first', 'sweep-first'] as const)('restart after the direct user\'s idle preserves the new stretch (%s)', (order) => {
    const session = createSession('oc_chat', `om_direct_restart_${order}`, 'direct restart', 'group', 'thread');
    session.idleAutoCompact = { enabled: true, idleSince: T0 };
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0, idleAutoCompactWarmSince: T0 } as unknown as DaemonSession;
    updateSession(session);
    const compact = vi.fn(() => true);
    const notices: unknown[] = [];
    const sweep = (target: DaemonSession, at: number) => runIdleAutoCompactSweep([target], {
      now: () => at, supported: () => true, blockers: () => [], contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: (_d, notice) => { notices.push(notice); }, log: () => {},
    });
    expect(sweep(ds, T0 + 55 * MIN)).toBe(1);
    const turnId = compact.mock.calls[0][1] as string;
    ds.lastScreenStatus = 'working';
    stampIdleSinceAt(ds, 'idle', T0 + 55 * MIN + 5_000);
    noteIdleAutoCompactDirectInput(ds, T0 + 55 * MIN + 10_000);
    updateSession(session);
    // The user's idle edge precedes the compact terminal. Its new idleSince
    // must reach SQLite before the in-flight early return.
    ds.lastScreenStatus = 'idle';
    stampIdleSinceAt(ds, 'working', T0 + 56 * MIN);
    expect(session.idleAutoCompact?.idleSince).toBe(T0 + 56 * MIN);
    expect(session.idleAutoCompact?.handledIdleSince).toBe(T0);

    init(APP);
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.idleAutoCompact?.idleSince).toBe(T0 + 56 * MIN);
    const restored = { session: reloaded } as unknown as DaemonSession;
    restored.lastScreenStatus = 'idle';
    stampIdleSinceAt(restored, undefined, T0 + 56 * MIN + 30_000);
    if (order === 'terminal-first') {
      expect(noteIdleAutoCompactTurnEnded(restored, turnId, 'completed')).toBe(true);
      updateSession(reloaded);
    } else {
      // No local completed/dispatch witness: the inherited sweep retires the
      // claim silently, but must use the same new-stretch preservation rule.
      expect(sweep(restored, T0 + 57 * MIN)).toBe(0);
    }
    expect(restored.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(restored.session.idleAutoCompact?.idleSince).toBe(T0 + 56 * MIN);
    expect(restored.session.idleAutoCompact?.handledIdleSince).toBe(T0);
    expect(sweep(restored, T0 + 112 * MIN)).toBe(1);
    expect(compact).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([]);
  });

  it('a session that never opted in has no setting after reload', () => {
    const session = createSession('oc_chat', 'om_root2', 'plain', 'group', 'thread');
    updateSession(session);
    init(APP);
    expect(getSession(session.sessionId)!.idleAutoCompact).toBeUndefined();
  });
});
