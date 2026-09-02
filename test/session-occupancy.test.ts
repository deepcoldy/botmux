/**
 * Stage 1 occupancy：库内租约与心跳文件拆开后的所有权回归。
 *
 * 核心洞：「心跳陈旧 + 库内租约有效」在旧实现会放行离线写（abortIf 只读
 * dashboard-daemons）。现探测与 persist 必须在同一 BEGIN IMMEDIATE 里完成。
 *
 * Run:  bunx vitest run test/session-occupancy.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  init,
  listSessions,
  getSession,
  mutateSessionRowOffline,
  readOccupancyLease,
  renewOccupancyLease,
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-occupancy-'));
  init();
});

afterEach(() => {
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

    const published = mutateSessionRowWhenUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );

    expect(published).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(true);
  });

  it('expired lease allows the offline write even when the heartbeat file is still fresh', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    seedOccupancyLease(tempDir, 'appA', {
      ownerPid: 4242,
      bootId: 'boot-dead',
      leaseUntil: Date.now() - 1,
    });
    writeDaemonHeartbeat('appA', Date.now());

    const published = mutateSessionRowWhenUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );

    expect(published?.status).toBe('closed');
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('closed');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(false);
  });

  it('missing lease + fresh heartbeat aborts (upgrade-window fallback)', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    writeDaemonHeartbeat('appA', Date.now());

    const published = mutateSessionRowWhenUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );

    expect(published).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(true);
  });

  it('missing lease + no heartbeat allows the offline write', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });

    const published = mutateSessionRowWhenUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );

    expect(published?.status).toBe('closed');
    expect(isOccupancyHeld('appA', { dataDir: tempDir })).toBe(false);
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
  });
});

describe('renew / release occupancy', () => {
  it('renew extends only the matching boot_id; release drops that row', () => {
    seedPersistedSessionRows(tempDir, 'appA', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA', { occupancy: { bootId: 'boot-owner', pid: 99 } });
    listSessions();
    const first = readOccupancyLeaseFromDisk(tempDir, 'appA')!;
    const later = first.leaseUntil + 30_000;

    expect(renewOccupancyLease({ bootId: 'boot-other', pid: 99, now: later })).toBe(false);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')?.leaseUntil).toBe(first.leaseUntil);

    expect(renewOccupancyLease({ bootId: 'boot-owner', pid: 99, now: later })).toBe(true);
    const renewed = readOccupancyLeaseFromDisk(tempDir, 'appA')!;
    expect(renewed.leaseUntil).toBe(later + OCCUPANCY_LEASE_MS);
    expect(occupancyLeaseIsActive(renewed, later)).toBe(true);

    expect(releaseOccupancyLease({ bootId: 'boot-other' })).toBe(false);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')?.bootId).toBe('boot-owner');
    expect(releaseOccupancyLease({ bootId: 'boot-owner' })).toBe(true);
    expect(readOccupancyLeaseFromDisk(tempDir, 'appA')).toBeUndefined();
  });

  it('an expired lease that is then renewed blocks the next offline write', () => {
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
    expect(renewOccupancyLease({ bootId: 'boot-owner', pid: 99 })).toBe(true);
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
  });
});
