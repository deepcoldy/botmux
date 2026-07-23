import { describe, expect, it, vi } from 'vitest';
import type { FleetProcessEntry } from '../src/cli/fleet-shutdown.js';
import {
  assertDaemonPm2GracefulExitPolicy,
  assertConfiguredPm2FleetOnline,
  assertConfiguredPm2FleetReady,
  assertExactAttestedDaemonSet,
  classifyStartBotFleetAdmission,
  normalizeRawPm2StopExitCodes,
  reconcileLatePm2StartPublication,
  runBoundedPm2StartTransaction,
} from '../src/cli/pm2-start-transaction.js';
import { DAEMON_GRACEFUL_EXIT_CODE } from '../src/core/supervisor-shutdown-protocol.js';

function row(
  name: string,
  pmId: number,
  options: { pid?: number; online?: boolean } = {},
): FleetProcessEntry {
  return {
    name,
    pmId,
    pid: options.pid ?? pmId + 100,
    online: options.online ?? true,
    status: options.online === false ? 'stopped' : 'online',
  };
}

const configured = ['botmux-a', 'botmux-b', 'botmux-dashboard'];
const alive = (pid: number) => pid > 0;

describe('configured PM2 fleet start authority', () => {
  it('requires the new daemon PM2 policy instead of trusting capability alone', () => {
    expect(() => assertDaemonPm2GracefulExitPolicy('start-idempotent-ready', [{
      ...row('botmux-a', 0),
      autorestart: true,
      stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
    }])).not.toThrow();
    expect(() => assertDaemonPm2GracefulExitPolicy('start-idempotent-ready', [{
      ...row('botmux-a', 0),
      autorestart: true,
      stopExitCodes: [0],
    }])).toThrow(
      /does not prove signal-death autorestart.*botmux restart --bootstrap-shutdown-protocol --yes/,
    );
    expect(() => assertDaemonPm2GracefulExitPolicy('start-idempotent-ready', [{
      ...row('botmux-a', 0),
      autorestart: false,
      stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
    }])).toThrow(/does not prove signal-death autorestart/);
  });

  it('preserves raw PM2 stop-exit-code elements for exact policy validation', () => {
    expect(normalizeRawPm2StopExitCodes([42, '0foo'])).toEqual([42, '0foo']);
    expect(normalizeRawPm2StopExitCodes([42, '0x0'])).toEqual([42, '0x0']);
    expect(normalizeRawPm2StopExitCodes([42, null])).toEqual([42, null]);
    expect(normalizeRawPm2StopExitCodes('42')).toEqual(['42']);
    expect(normalizeRawPm2StopExitCodes(null)).toEqual([null]);
  });

  it.each([
    [42, '0foo'],
    [42, '0x0'],
    [42, null],
  ])('rejects restart-suppressing raw stop-exit-code extras: %j', stopExitCodes => {
    expect(() => assertDaemonPm2GracefulExitPolicy('start-idempotent-ready', [{
      ...row('botmux-a', 0),
      autorestart: true,
      stopExitCodes,
    }])).toThrow(/does not prove signal-death autorestart.*stop_exit_codes=\[42\]/);
  });

  it('accepts only the numeric sentinel or its canonical decimal string', () => {
    for (const stopExitCodes of [[42], ['42']]) {
      expect(() => assertDaemonPm2GracefulExitPolicy('start-idempotent-ready', [{
        ...row('botmux-a', 0),
        autorestart: true,
        stopExitCodes,
      }])).not.toThrow();
    }
    for (const stopExitCodes of [['042'], ['42foo'], ['0x2a']]) {
      expect(() => assertDaemonPm2GracefulExitPolicy('start-idempotent-ready', [{
        ...row('botmux-a', 0),
        autorestart: true,
        stopExitCodes,
      }])).toThrow(/does not prove signal-death autorestart/);
    }
  });

  it('accepts only one exact online/live row per configured process', () => {
    expect(() => assertConfiguredPm2FleetOnline(
      'start',
      [row('botmux-a', 0), row('botmux-b', 1), row('botmux-dashboard', 2)],
      configured,
      alive,
    )).not.toThrow();
  });

  it('rejects a dead, missing, unexpected, or duplicate-id row', () => {
    expect(() => assertConfiguredPm2FleetOnline(
      'start',
      [row('botmux-a', 0), row('botmux-b', 1, { pid: 0 }), row('botmux-dashboard', 2)],
      configured,
      alive,
    )).toThrow(/botmux-b/);
    expect(() => assertConfiguredPm2FleetOnline(
      'start',
      [row('botmux-a', 0), row('botmux-dashboard', 2)],
      configured,
      alive,
    )).toThrow(/botmux-b/);
    expect(() => assertConfiguredPm2FleetOnline(
      'start',
      [row('botmux-a', 0), row('botmux-b', 1), row('botmux-old', 2)],
      configured,
      alive,
    )).toThrow(/unexpected PM2 core row/);
    expect(() => assertConfiguredPm2FleetOnline(
      'start',
      [row('botmux-a', 0), row('botmux-b', 0), row('botmux-dashboard', 2)],
      configured,
      alive,
    )).toThrow(/duplicate canonical pm_id 0 across botmux-a and botmux-b/);
    expect(() => assertConfiguredPm2FleetOnline(
      'start',
      [row('botmux-a', 0, { pid: 777 }), row('botmux-b', 1),
        row('botmux-dashboard', 2, { pid: 777 })],
      configured,
      alive,
    )).toThrow(/duplicate positive pid 777 across botmux-a and botmux-dashboard/);
  });

  it.each([
    'start-idempotent-ready',
    'start-bot-already-online-ready',
  ])('does not accept %s PM2-online rows while an old daemon capability is missing', (operation) => {
    expect(() => assertConfiguredPm2FleetReady(
      operation,
      [row('botmux-a', 0), row('botmux-b', 1), row('botmux-dashboard', 2)],
      configured,
      alive,
      () => { throw new Error('botmux-b has no handler-ready shutdown capability'); },
    )).toThrow(/botmux-b has no handler-ready shutdown capability/);
  });

  it('rejects a capability scan that omits a daemon which exited mid-read', () => {
    expect(() => assertExactAttestedDaemonSet(
      'restart-after-launch',
      [row('botmux-a', 0, { pid: 101 }), row('botmux-b', 1, { pid: 202 })],
      [101],
      () => true,
    )).toThrow(/handler-ready capability set is incomplete.*expected pids: 101, 202.*attested: 101/);
  });
});

describe('start-bot exact append-one admission', () => {
  it('admits exactly one missing requested bot when all configured peers are live', () => {
    expect(classifyStartBotFleetAdmission(
      'start-bot',
      [row('botmux-a', 0), row('botmux-dashboard', 2)],
      configured,
      'botmux-b',
      alive,
    )).toEqual({ state: 'start-eligible' });
  });

  it('is idempotent only for the exact fully-online configured fleet', () => {
    expect(classifyStartBotFleetAdmission(
      'start-bot',
      [row('botmux-a', 0), row('botmux-b', 1), row('botmux-dashboard', 2)],
      configured,
      'botmux-b',
      alive,
    )).toEqual({ state: 'already-online' });
  });

  it('rejects dashboard-only and another-missing-bot partial fleets', () => {
    expect(() => classifyStartBotFleetAdmission(
      'start-bot',
      [row('botmux-dashboard', 2)],
      configured,
      'botmux-b',
      alive,
    )).toThrow(/configured peer.*botmux-a/);

    expect(() => classifyStartBotFleetAdmission(
      'start-bot',
      [row('botmux-a', 0), row('botmux-dashboard', 3)],
      ['botmux-a', 'botmux-b', 'botmux-c', 'botmux-dashboard'],
      'botmux-c',
      alive,
    )).toThrow(/configured peer.*botmux-b/);
  });

  it('rejects an existing transitional target instead of routing it through start', () => {
    expect(() => classifyStartBotFleetAdmission(
      'start-bot',
      [row('botmux-a', 0), row('botmux-b', 1, { online: false }), row('botmux-dashboard', 2)],
      configured,
      'botmux-b',
      alive,
    )).toThrow(/existing non-live\/transitional/);
  });

  it('distinguishes a truly empty fleet from unsafe partial fleets', () => {
    expect(classifyStartBotFleetAdmission(
      'start-bot', [], configured, 'botmux-b', alive,
    )).toEqual({ state: 'fleet-down' });
  });
});

describe('bounded PM2 start transaction', () => {
  it('passes exact budgets and returns only a fresh verified projection', () => {
    const order: string[] = [];
    const projection = [{ name: 'ready' }];
    const result = runBoundedPm2StartTransaction('start', 30_000, 10_000, {
      start: timeout => { order.push(`start:${timeout}`); },
      verifyFresh: timeout => { order.push(`verify:${timeout}`); return projection; },
      rollback: () => { order.push('rollback'); },
    });
    expect(result).toBe(projection);
    expect(order).toEqual(['start:30000', 'verify:10000']);
  });

  it('accepts a complete fresh fleet even if the launcher itself timed out', () => {
    const rollback = vi.fn();
    expect(runBoundedPm2StartTransaction('start', 30, 10, {
      start: () => { throw new Error('ETIMEDOUT'); },
      verifyFresh: () => 'complete-fresh-fleet',
      rollback,
    })).toBe('complete-fresh-fleet');
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back a partial launch before exposing verification failure', () => {
    const order: string[] = [];
    expect(() => runBoundedPm2StartTransaction('restart-start', 30, 10, {
      start: () => { order.push('start-partial'); throw new Error('socket closed'); },
      verifyFresh: () => { order.push('verify-fresh'); throw new Error('botmux-b unavailable'); },
      rollback: () => { order.push('rollback-partial'); },
    })).toThrow(/start: socket closed.*verify: botmux-b unavailable.*partial launch was rolled back/);
    expect(order).toEqual(['start-partial', 'verify-fresh', 'rollback-partial']);
  });

  it('reports rollback failure without hiding the original start/verify evidence', () => {
    expect(() => runBoundedPm2StartTransaction('start-bot', 30, 10, {
      start: () => { throw new Error('launch failed'); },
      verifyFresh: () => { throw new Error('target transitional'); },
      rollback: () => { throw new Error('descriptor ambiguous'); },
    })).toThrow(/launch failed.*target transitional.*rollback failed: descriptor ambiguous/);
  });

  it('does not accept an empty first rollback read when a candidate publishes later', () => {
    let now = 0;
    const observations = [true, false, true, true];
    const reconcileOnce = vi.fn(() => observations.shift() ?? true);

    reconcileLatePm2StartPublication('start-bot', 10, 500, {
      now: () => now,
      sleep: ms => { now += ms; },
      reconcileOnce,
    });

    // First `true` is the empty projection. The late false observation resets
    // the settle clock; only two later restored observations complete it.
    expect(reconcileOnce).toHaveBeenCalledTimes(4);
    expect(now).toBeGreaterThanOrEqual(120);
  });

  it('returns explicit uncertainty when late publication never settles', () => {
    let now = 0;
    expect(() => reconcileLatePm2StartPublication('restart-start', 10, 30, {
      now: () => now,
      sleep: ms => { now += ms; },
      reconcileOnce: () => false,
    })).toThrow(/rollback remains uncertain.*late-publication settle window/);
  });
});
