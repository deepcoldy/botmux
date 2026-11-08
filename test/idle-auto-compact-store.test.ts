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
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSession, getSession, init, updateSession } from '../src/services/session-store.js';
import {
  applyIdleAutoCompactSetting,
  noteIdleAutoCompactScreenStatus,
  runIdleAutoCompactSweep,
} from '../src/core/idle-auto-compact.js';
import type { DaemonSession } from '../src/core/types.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
const APP = 'cli_idle_compact_store';

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'idle-compact-store-')); init(APP); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('idle auto-compact persistence', () => {
  it('the opt-in and the running idle stretch survive a store reload', () => {
    const session = createSession('oc_chat', 'om_root', 'idle compact', 'group', 'thread');
    session.lastMessageAt = new Date(T0 - MIN).toISOString();
    applyIdleAutoCompactSetting(session, { enabled: true, minutes: 30 });
    updateSession(session);
    const live = { session, lastScreenStatus: 'idle', idleSinceAt: T0 } as unknown as DaemonSession;
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
      now: () => at, supported: () => true, eligible: () => true, contextTokens: () => undefined,
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
    const ds = { session, lastScreenStatus: 'idle', idleSinceAt: T0 } as unknown as DaemonSession;
    let accept = false;
    const compact = vi.fn(() => accept);
    const sweep = (at: number) => runIdleAutoCompactSweep([ds], {
      now: () => at, supported: () => true, eligible: () => true, contextTokens: () => undefined,
      persist: d => updateSession(d.session), compact, notify: () => {}, log: () => {},
    });
    expect(sweep(T0 + 55 * MIN)).toBe(0);
    init(APP);
    expect(getSession(session.sessionId)!.idleAutoCompact?.handledIdleSince).toBeUndefined();
    accept = true;
    expect(sweep(T0 + 56 * MIN)).toBe(1);
  });

  it('a session that never opted in has no setting after reload', () => {
    const session = createSession('oc_chat', 'om_root2', 'plain', 'group', 'thread');
    updateSession(session);
    init(APP);
    expect(getSession(session.sessionId)!.idleAutoCompact).toBeUndefined();
  });
});
