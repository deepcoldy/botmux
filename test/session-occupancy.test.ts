/**
 * Stage 1 occupancy：库内租约与心跳文件拆开后的所有权回归。
 *
 * 核心洞：「心跳陈旧 + 库内租约有效」在旧实现会放行离线写（abortIf 只读
 * dashboard-daemons）。现探测与 persist 必须在同一 BEGIN IMMEDIATE 里完成。
 * 有效租约一票否决；没有有效租约（缺行 / 过期 / 不可读）时心跳仍参与判定——
 * 这是升级窗口（只写会话行、不写 occupancy 的 daemon，含回滚后的旧构建）。
 *
 * Run:  bunx vitest run test/session-occupancy.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

const loggerMock = vi.hoisted(() => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => loggerMock);

import {
  init,
  listSessions,
  getSession,
  mutateSessionRowOffline,
  readOccupancyLease,
  claimOccupancyLease,
  releaseOccupancyLease,
  occupancyLeaseIsActive,
  OCCUPANCY_LEASE_MS,
  OCCUPANCY_SCOPE_BOT,
} from '../src/services/session-store.js';
import { isOccupancyHeld, mutateSessionRowWhenUnowned } from '../src/services/session-offline-write.js';
import {
  seedPersistedSessionRows,
  seedOccupancyLease,
  readOccupancyLeaseFromDisk,
  readPersistedSessionRows,
  sessionStorePath,
} from './helpers/session-store-disk.js';

function row(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId, chatId: 'oc_chat', rootMessageId: `om_${sessionId}`, title: sessionId,
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

function writeDaemonHeartbeat(appId: string, lastHeartbeat: number): void {
  const dir = join(tempDir, 'dashboard-daemons');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${appId}.json`), JSON.stringify({
    larkAppId: appId,
    ipcPort: 12345,
    lastHeartbeat,
  }));
}

function closeS1Offline(): ReturnType<typeof mutateSessionRowWhenUnowned> {
  return mutateSessionRowWhenUnowned(
    { sessionId: 's1', larkAppId: 'appA' },
    current => { current.status = 'closed'; return true; },
    { dataDir: tempDir },
  );
}

/** A pid that certainly belonged to a process which has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  if (!child.pid) throw new Error('could not spawn a throwaway child');
  return child.pid;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-occupancy-'));
  init();
  loggerMock.logger.warn.mockClear();
  loggerMock.logger.error.mockClear();
});

afterEach(() => {
  init();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('occupancy vs heartbeat window', () => {
  it('stale heartbeat + live lease aborts the offline write (the Stage 1 hole)', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: 4242,
      bootId: 'boot-live',
      leaseUntil: Date.now() + 60_000,
    });
    writeDaemonHeartbeat('appA', Date.now() - 120_000);

    expect(closeS1Offline()).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(true);
  });

  it('expired lease + fresh heartbeat still aborts (upgrade window: a daemon that never wrote occupancy, or a rollback behind a stale row)', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: 4242,
      bootId: 'boot-crashed-newer-build',
      leaseUntil: Date.now() - 1,
    });
    writeDaemonHeartbeat('appA', Date.now());

    expect(closeS1Offline()).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(true);
  });

  it('expired lease + stale heartbeat allows the offline write', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: 4242,
      bootId: 'boot-dead',
      leaseUntil: Date.now() - 1,
    });
    writeDaemonHeartbeat('appA', Date.now() - 120_000);

    expect(closeS1Offline()?.status).toBe('closed');
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('closed');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(false);
  });

  it('missing lease + fresh heartbeat aborts (upgrade-window fallback)', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    writeDaemonHeartbeat('appA', Date.now());

    expect(closeS1Offline()).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(true);
  });

  it('missing lease + no heartbeat allows the offline write', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });

    expect(closeS1Offline()?.status).toBe('closed');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(false);
  });

  it('isOccupancyHeld never throws on an unreadable store — the heartbeat decides', () => {
    const path = sessionStorePath(tempDir, 'appA');
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(path, 'definitely not a sqlite database\n'.repeat(64));

    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(false);
    writeDaemonHeartbeat('appA', Date.now());
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(true);
  });
});

describe('load() claims occupancy in the same IMMEDIATE transaction', () => {
  it('writes the bot-scope lease when the owning process supplies a holder', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    const t0 = Date.now();
    init('appA', { occupancy: { bootId: 'boot-owner', pid: 99 } });
    expect(getSession('s1')?.title).toBe('s1');

    const lease = readOccupancyLeaseFromDisk(tempDir, 'appA');
    expect(lease).toMatchObject({
      scope: OCCUPANCY_SCOPE_BOT,
      ownerPid: 99,
      bootId: 'boot-owner',
    });
    expect(lease!.leaseUntil).toBeGreaterThanOrEqual(t0 + OCCUPANCY_LEASE_MS - 50);
    expect(lease!.leaseUntil).toBeLessThanOrEqual(Date.now() + OCCUPANCY_LEASE_MS);
    expect(readOccupancyLease('appA', tempDir)?.bootId).toBe('boot-owner');
  });

  it('does not claim when no holder is configured (existing tests stay writable)', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    listSessions();
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toBeUndefined();
  });

  it('owner: false never claims even if a holder is passed', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA', { owner: false, occupancy: { bootId: 'boot-worker', pid: 7 } });
    listSessions();
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toBeUndefined();
    expect(claimOccupancyLease({ bootId: 'boot-worker', pid: 7 })).toBe('unavailable');
  });

  it('leaves another boot\'s live lease alone while its owner process is alive, and reports displaced', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    const foreign = { ownerPid: process.pid, bootId: 'boot-predecessor', leaseUntil: Date.now() + 60_000 };
    seedOccupancyLease(tempDir, 'appA', foreign);

    init('appA', { occupancy: { bootId: 'boot-successor', pid: 99 } });
    expect(listSessions().map(s => s.sessionId)).toEqual(['s1']);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toMatchObject(foreign);
    expect(loggerMock.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/held by another live daemon boot/));

    expect(claimOccupancyLease({ bootId: 'boot-successor', pid: 99 })).toBe('displaced');
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toMatchObject(foreign);

    // Offline writers keep yielding to the predecessor until it lets go.
    expect(closeS1Offline()).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('takes over a lease whose owner process is gone even before it expires', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: deadPid(),
      bootId: 'boot-killed',
      leaseUntil: Date.now() + 60_000,
    });

    init('appA', { occupancy: { bootId: 'boot-successor', pid: 99 } });
    listSessions();
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toMatchObject({ bootId: 'boot-successor', ownerPid: 99 });
    expect(loggerMock.logger.warn).not.toHaveBeenCalled();
  });

  it('takes over an expired lease of a still-running process', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: process.pid,
      bootId: 'boot-stalled',
      leaseUntil: Date.now() - 1,
    });

    init('appA', { occupancy: { bootId: 'boot-successor', pid: 99 } });
    listSessions();
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toMatchObject({ bootId: 'boot-successor', ownerPid: 99 });
  });

  it('a claim that cannot be written does not fail the load — rows load, the error is logged, the tick retries', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    const path = sessionStorePath(tempDir, 'appA');
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TRIGGER occupancy_deny BEFORE INSERT ON occupancy '
      + "BEGIN SELECT RAISE(ABORT, 'simulated occupancy write failure'); END;",
    );
    db.close();

    init('appA', { occupancy: { bootId: 'boot-owner', pid: 99 } });
    expect(listSessions().map(s => s.sessionId)).toEqual(['s1']);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toBeUndefined();
    expect(loggerMock.logger.error).toHaveBeenCalledWith(expect.stringMatching(/Failed to claim session store occupancy/));
    expect(() => claimOccupancyLease({ bootId: 'boot-owner', pid: 99 })).toThrow(/simulated occupancy write failure/);

    const fixed = new DatabaseSync(path);
    fixed.exec('DROP TRIGGER occupancy_deny');
    fixed.close();
    expect(claimOccupancyLease({ bootId: 'boot-owner', pid: 99 })).toBe('held');
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')?.bootId).toBe('boot-owner');
  });

  it('schema DDL blocked by an offline writer is retryable, not a permanent load failure', () => {
    // A pre-occupancy store: let the real store lay down its full schema (WAL,
    // indexes), then drop the occupancy table. The first owning load after the
    // upgrade has to CREATE it again — a real write on an otherwise no-op DDL.
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    listSessions();
    init();
    const path = sessionStorePath(tempDir, 'appA');
    const setup = new DatabaseSync(path);
    setup.exec('DROP TABLE occupancy');
    setup.close();

    const writer = new DatabaseSync(path);
    writer.exec('BEGIN IMMEDIATE');
    try {
      init('appA', { occupancy: { bootId: 'boot-owner', pid: 99 } });
      expect(() => listSessions()).toThrow(/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }

    expect(listSessions().map(s => s.sessionId)).toEqual(['s1']);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')?.bootId).toBe('boot-owner');
  });
});

describe('claim / release occupancy', () => {
  it('claim extends the holder\'s lease, yields to a live foreign lease, and release drops only its own row', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    // The holder is THIS process, so its lease is protected by pid liveness.
    init('appA', { occupancy: { bootId: 'boot-owner', pid: process.pid } });
    listSessions();
    const first = readOccupancyLeaseFromDisk(tempDir, 'appA')!;
    const later = first.leaseUntil - 30_000;

    expect(claimOccupancyLease({ bootId: 'boot-owner', pid: process.pid, now: later })).toBe('held');
    const renewed = readOccupancyLeaseFromDisk(tempDir, 'appA')!;
    expect(renewed.leaseUntil).toBe(later + OCCUPANCY_LEASE_MS);
    expect(occupancyLeaseIsActive(renewed, later)).toBe(true);

    // Another boot cannot take a live lease whose owner is still running.
    expect(claimOccupancyLease({ bootId: 'boot-other', pid: deadPid(), now: later })).toBe('displaced');
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toMatchObject({ bootId: 'boot-owner', ownerPid: process.pid });

    expect(releaseOccupancyLease({ bootId: 'boot-other' })).toBe(false);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')?.bootId).toBe('boot-owner');
    expect(releaseOccupancyLease({ bootId: 'boot-owner' })).toBe(true);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toBeUndefined();

    // With the row gone, the next claim (the tick) re-acquires it.
    expect(claimOccupancyLease({ bootId: 'boot-owner', pid: process.pid })).toBe('held');
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')?.bootId).toBe('boot-owner');
  });

  it('an expired lease that is then re-claimed blocks the next offline write', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA', { occupancy: { bootId: 'boot-owner', pid: 99 } });
    listSessions();
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: 99,
      bootId: 'boot-owner',
      leaseUntil: Date.now() - 1,
    });

    expect(mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    )?.status).toBe('closed');

    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    expect(claimOccupancyLease({ bootId: 'boot-owner', pid: 99 })).toBe('held');
    expect(mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    )).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });
});

describe('JSON upgrade-window path still uses abortIf', () => {
  it('does not create a .db and still honours the heartbeat probe', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions-appA.json'), JSON.stringify({
      s1: row('s1', { larkAppId: 'appA' }),
    }));

    const aborted = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir, abortIf: () => true },
    );
    expect(aborted).toBeUndefined();

    const published = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir, abortIf: () => false },
    );
    expect(published?.status).toBe('closed');
    expect(JSON.parse(readFileSync(join(tempDir, 'sessions-appA.json'), 'utf-8')).s1.status).toBe('closed');
    expect(existsSync(sessionStorePath(tempDir, 'appA'))).toBe(false);
  });
});
