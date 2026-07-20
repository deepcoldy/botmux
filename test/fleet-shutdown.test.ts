import { describe, expect, it, vi } from 'vitest';
import {
  isFleetEntryProvenFreeOfAutorestartTimer,
  isFleetEntryProvenTerminalAfterSignal,
  signalAndAwaitFleet,
  type FleetProcessEntry,
} from '../src/cli/fleet-shutdown.js';
import { DAEMON_GRACEFUL_EXIT_CODE } from '../src/core/supervisor-shutdown-protocol.js';

const entries: FleetProcessEntry[] = [
  {
    name: 'botmux-a', pmId: 1, pid: 101, online: true,
    autorestart: true, stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
  },
  {
    name: 'botmux-b', pmId: 2, pid: 202, online: true,
    autorestart: true, stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
  },
  {
    name: 'botmux-offline', pmId: 3, pid: 0, online: false,
    status: 'stopped', autorestart: false,
  },
];

function gracefulTerminalRows(targets: FleetProcessEntry[]): FleetProcessEntry[] {
  return targets
    .filter(target => target.online && target.pid > 0)
    .map(target => ({
      ...target,
      pid: 0,
      online: false,
      status: 'waiting restart',
      exitCode: DAEMON_GRACEFUL_EXIT_CODE,
    }));
}

describe('generation-aware fleet graceful shutdown', () => {
  it('never treats PM2 signal-death code 0 as the daemon graceful-stop sentinel', () => {
    expect(isFleetEntryProvenFreeOfAutorestartTimer({
      name: 'botmux-a',
      pid: 0,
      online: false,
      status: 'waiting restart',
      autorestart: true,
      exitCode: 0,
      stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
    })).toBe(false);
    expect(isFleetEntryProvenFreeOfAutorestartTimer({
      name: 'botmux-a',
      pid: 0,
      online: false,
      status: 'waiting restart',
      autorestart: true,
      exitCode: DAEMON_GRACEFUL_EXIT_CODE,
      stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
    })).toBe(true);
  });

  it('separates timer-free overlimit admission from post-signal terminal proof', () => {
    const abruptOverlimit: FleetProcessEntry = {
      name: 'botmux-a', pmId: 1, pid: 0, online: false,
      status: 'errored', autorestart: true, exitCode: 0,
      stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
    };
    expect(isFleetEntryProvenFreeOfAutorestartTimer(abruptOverlimit)).toBe(true);
    expect(isFleetEntryProvenTerminalAfterSignal(abruptOverlimit)).toBe(false);
    expect(isFleetEntryProvenTerminalAfterSignal({
      ...abruptOverlimit,
      exitCode: DAEMON_GRACEFUL_EXIT_CODE,
    })).toBe(true);
  });

  it('restores an ACKed daemon whose abrupt exit hits PM2 restart overlimit', () => {
    const target = entries[0]!;
    const alive = new Set([target.pid]);
    let now = 0;
    let restored = false;
    const signalInitial = vi.fn(() => { alive.delete(target.pid); });
    const startOffline = vi.fn((offlineEntries: FleetProcessEntry[]) => {
      expect(offlineEntries).toEqual([
        expect.objectContaining({ name: target.name, status: 'errored', exitCode: 0 }),
      ]);
      restored = true;
      alive.add(303);
    });

    expect(() => signalAndAwaitFleet([target], 'restart', 100, {
      signal: vi.fn(),
      signalInitial,
      assertSignalAuthorityComplete: vi.fn(),
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => restored
        ? [{ ...target, pid: 303, online: true }]
        : [{
            ...target,
            pid: 0,
            online: false,
            status: 'errored',
            exitCode: 0,
          }],
      successorSettleMs: 10,
    })).toThrow(/post-signal terminal proof.*exit_code=0.*restored 1 offline PM2 entry/);
    expect(signalInitial).toHaveBeenCalledOnce();
    expect(startOffline).toHaveBeenCalledOnce();
  });

  it('accepts an errored row only when its exit matches the graceful stop policy', () => {
    const target = entries[0]!;
    const alive = new Set([target.pid]);
    let now = 0;
    const authority = vi.fn();
    signalAndAwaitFleet([target], 'stop', 100, {
      signal(pid) { alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline: vi.fn(),
      list: () => [{
        ...target,
        pid: 0,
        online: false,
        status: 'errored',
        exitCode: DAEMON_GRACEFUL_EXIT_CODE,
      }],
      assertSignalAuthorityComplete: authority,
      successorSettleMs: 10,
      pollMs: 5,
    });
    expect(authority).toHaveBeenCalledOnce();
  });

  it('does not cache a latest terminal proof across a later missing projection', () => {
    const target = entries[0]!;
    const alive = new Set([target.pid]);
    let now = 0;
    let listCalls = 0;
    const startOffline = vi.fn();

    expect(() => signalAndAwaitFleet([target], 'restart', 100, {
      signal(pid) { alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [{
            ...target,
            pid: 0,
            online: false,
            status: 'waiting restart',
            exitCode: DAEMON_GRACEFUL_EXIT_CODE,
          }];
        }
        return [];
      },
      successorSettleMs: 10,
      pollMs: 5,
    })).toThrow(/fleet is partially stopped.*offline: botmux-a/);
    expect(listCalls).toBeGreaterThan(1);
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('does not use a dead replacement exit code to prove its predecessor', () => {
    const target = entries[0]!;
    const alive = new Set([target.pid]);
    let now = 0;
    const startOffline = vi.fn();

    expect(() => signalAndAwaitFleet([target], 'restart', 100, {
      signal(pid) { alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [{
        ...target,
        pid: 303,
        online: false,
        status: 'errored',
        exitCode: DAEMON_GRACEFUL_EXIT_CODE,
      }],
      successorSettleMs: 10,
      pollMs: 5,
    })).toThrow(/post-signal terminal proof.*botmux-a\/101.*fleet is partially stopped/);
    expect(startOffline).toHaveBeenCalledOnce();
  });

  it('refuses before any signal when a non-online PM2 row still owns a live PID', () => {
    const signal = vi.fn();
    const list = vi.fn(() => []);
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet([
      entries[0]!,
      { name: 'botmux-transitioning', pmId: 9, pid: 404, online: false, status: 'launching' },
    ], 'restart', 100, {
      signal,
      isAlive: pid => pid === 101 || pid === 404,
      now: () => 0,
      sleep: vi.fn(),
      startOffline,
      list,
    })).toThrow(/non-online registry rows still have live PID.*botmux-transitioning:404/);
    expect(signal).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('refuses duplicate singleton PM2 names before collapsing or signalling either PID', () => {
    const signal = vi.fn();
    expect(() => signalAndAwaitFleet([
      { name: 'botmux-a', pmId: 1, pid: 101, online: true },
      { name: 'botmux-a', pmId: 4, pid: 404, online: true },
    ], 'stop', 100, {
      signal,
      isAlive: () => true,
      now: () => 0,
      sleep: vi.fn(),
      startOffline: vi.fn(),
      list: vi.fn(() => []),
    })).toThrow(/duplicate registry row.*botmux-a/);
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not signal a later initial target after an earlier signal consumes the deadline', () => {
    let now = 0;
    const signal = vi.fn(() => { now += 10; });
    const list = vi.fn(() => []);
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'restart', 5, {
      signal,
      isAlive: () => true,
      now: () => now,
      sleep: vi.fn(),
      startOffline,
      list,
    })).toThrow(/deadline exhausted during initial daemon signalling.*no later fleet action/);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(101);
    expect(list).not.toHaveBeenCalled();
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('propagates a signal authorization failure instead of treating it as already exited', () => {
    const list = vi.fn(() => []);
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet([entries[0]!], 'restart', 100, {
      signal: () => { throw new Error('old daemon lacks shutdown capability'); },
      isAlive: () => true,
      now: () => 0,
      sleep: vi.fn(),
      startOffline,
      list,
    })).toThrow(/old daemon lacks shutdown capability/);
    expect(list).not.toHaveBeenCalled();
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('signals a live non-online successor and never treats it as quiet', () => {
    const alive = new Set([202]);
    const signalled: number[] = [];
    let now = 0;
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet([entries[1]!], 'restart', 100, {
      signal(pid) {
        signalled.push(pid);
        if (pid === 202) alive.delete(pid);
        if (pid === 303) return; // transitional successor refuses
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => {
        alive.add(303);
        return [{
          name: 'botmux-b', pmId: 2, pid: 303, online: false, status: 'launching',
          exitCode: DAEMON_GRACEFUL_EXIT_CODE,
          stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
        }];
      },
      successorSettleMs: 10,
      pollMs: 5,
    })).toThrow(/daemon generation\(s\).*live generation untouched/);
    expect(signalled).toEqual([202, 303]);
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('requires an initially dormant row to prove that no restart timer can fire', () => {
    const list = vi.fn(() => []);
    expect(() => signalAndAwaitFleet([
      { name: 'botmux-waiting', pmId: 7, pid: 0, online: false, status: 'waiting restart' },
    ], 'stop', 100, {
      signal: vi.fn(),
      isAlive: () => false,
      now: () => 0,
      sleep: vi.fn(),
      startOffline: vi.fn(),
      list,
    })).toThrow(/dormant registry row.*may still restart/);
    expect(list).not.toHaveBeenCalled();
  });

  it('does not trust a bare stopped status as proof that no restart task exists', () => {
    expect(() => signalAndAwaitFleet([
      { name: 'botmux-stopped', pmId: 8, pid: 0, online: false, status: 'stopped' },
    ], 'restart', 100, {
      signal: vi.fn(),
      isAlive: () => false,
      now: () => 0,
      sleep: vi.fn(),
      startOffline: vi.fn(),
      list: vi.fn(() => []),
    })).toThrow(/dormant registry row.*may still restart/);
  });

  it('signals the whole online fleet before polling and succeeds after the quiet window', () => {
    const order: string[] = [];
    const alive = new Set([101, 202]);
    let now = 0;
    signalAndAwaitFleet(entries, 'restart', 100, {
      signal(pid) { order.push(`signal:${pid}`); alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { order.push(`sleep:${ms}`); now += ms; },
      startOffline: names => order.push(`start:${names.join(',')}`),
      list: () => gracefulTerminalRows(entries),
      successorSettleMs: 10,
      pollMs: 5,
    });

    expect(order.slice(0, 2)).toEqual(['signal:101', 'signal:202']);
    expect(order).not.toContain(expect.stringMatching(/^start:/));
    expect(now).toBeGreaterThanOrEqual(10);
  });

  it('batch-dispatches every initial endpoint and compensates a peer when one refuses', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    let restored = false;
    const signalInitial = vi.fn((targets: FleetProcessEntry[]) => {
      expect(targets.map(target => target.pid)).toEqual([101, 202]);
      // A's endpoint hangs/refuses; B accepted the concurrent request and exits.
      alive.delete(202);
    });
    const startOffline = vi.fn((offline: FleetProcessEntry[]) => {
      expect(offline.map(entry => entry.name)).toEqual(['botmux-b']);
      restored = true;
      alive.add(303);
    });
    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'restart', 100, {
      signal: vi.fn(),
      signalInitial,
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        restored
          ? { name: 'botmux-b', pmId: 2, pid: 303, online: true }
          : { name: 'botmux-b', pmId: 2, pid: 0, online: false,
              status: 'waiting restart', exitCode: 0, stopExitCodes: [0] },
      ],
      successorSettleMs: 10,
    })).toThrow(/restored 1 offline PM2 entry.*live generation untouched/);
    expect(signalInitial).toHaveBeenCalledOnce();
    expect(startOffline).toHaveBeenCalledOnce();
  });

  it('compensates and fails when an unacked generation later disappears', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    let restored = false;
    const startOffline = vi.fn((offline: FleetProcessEntry[]) => {
      expect(offline.map(entry => entry.name)).toEqual(['botmux-a', 'botmux-b']);
      restored = true;
      alive.add(301);
      alive.add(302);
    });
    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'restart', 100, {
      signal: vi.fn(),
      signalInitial: () => { alive.clear(); },
      assertSignalAuthorityComplete: () => {
        throw new Error('botmux-a exact IPC ACK missing');
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => restored
        ? [
            { name: 'botmux-a', pmId: 1, pid: 301, online: true },
            { name: 'botmux-b', pmId: 2, pid: 302, online: true },
          ]
        : [
            { name: 'botmux-a', pmId: 1, pid: 0, online: false,
              status: 'waiting restart', exitCode: 0, stopExitCodes: [0] },
            { name: 'botmux-b', pmId: 2, pid: 0, online: false,
              status: 'waiting restart', exitCode: 0, stopExitCodes: [0] },
          ],
      successorSettleMs: 10,
    })).toThrow(/signal authority: botmux-a exact IPC ACK missing.*restored 2 offline PM2 entries/);
    expect(startOffline).toHaveBeenCalledOnce();
  });

  it('never starts the quiet window while a projected row may still publish a successor', () => {
    const alive = new Set([101]);
    const startOffline = vi.fn();
    let now = 0;
    expect(() => signalAndAwaitFleet([entries[0]!], 'stop', 50, {
      signal(pid) { alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [{
        name: 'botmux-a', pmId: 1, pid: 0, online: false,
        status: 'waiting restart', exitCode: 1, stopExitCodes: [0],
      }],
      successorSettleMs: 5,
      pollMs: 5,
    })).toThrow(/fleet is partially stopped.*offline: botmux-a/);
    expect(startOffline).not.toHaveBeenCalled();
    expect(now).toBe(0);
  });

  it('detects and gracefully signals a PM2 successor that appears during the quiet window', () => {
    const signalled: number[] = [];
    const alive = new Set([101, 202]);
    let now = 0;
    signalAndAwaitFleet(entries, 'restart', 300, {
      signal(pid) {
        signalled.push(pid);
        alive.delete(pid);
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline: vi.fn(),
      list: () => {
        const terminal = gracefulTerminalRows(entries);
        if (now < 50 || signalled.includes(303)) return terminal;
        alive.add(303);
        return [
          terminal.find(entry => entry.name === 'botmux-a')!,
          {
            ...entries[1]!,
            pid: 303,
            online: true,
            exitCode: DAEMON_GRACEFUL_EXIT_CODE,
          },
        ];
      },
      successorSettleMs: 100,
      pollMs: 10,
    });

    expect(signalled).toEqual([101, 202, 303]);
    expect(now).toBeGreaterThanOrEqual(150);
  });

  it('does not report success when a discovered successor itself refuses to exit', () => {
    const signalled: number[] = [];
    const alive = new Set([101, 202, 303]);
    let now = 0;
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet([entries[1]!], 'restart', 100, {
      signal(pid) {
        signalled.push(pid);
        if (pid !== 303) alive.delete(pid);
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [{
        name: 'botmux-b', pmId: 2, pid: 303, online: true,
        exitCode: DAEMON_GRACEFUL_EXIT_CODE,
        stopExitCodes: [DAEMON_GRACEFUL_EXIT_CODE],
      }],
      successorSettleMs: 10,
      pollMs: 5,
    })).toThrow(/1\/1 daemon generation\(s\).*live generation untouched/);
    expect(signalled).toEqual([202, 303]);
    expect(startOffline).not.toHaveBeenCalled();
    expect(alive.has(303)).toBe(true);
  });

  it('fresh-lists first, starts only a truly offline peer, and leaves the refuser untouched', () => {
    const alive = new Set([101, 202]);
    const projection = new Map<string, FleetProcessEntry>(entries.map(entry => [entry.name, { ...entry }]));
    let now = 0;
    const startOffline = vi.fn((offlineEntries: FleetProcessEntry[]) => {
      for (const entry of offlineEntries) {
        projection.set(entry.name, { ...entry, pid: 902, online: true });
        alive.add(902);
      }
    });

    expect(() => signalAndAwaitFleet(entries, 'stop', 100, {
      signal(pid) {
        if (pid === 202) {
          alive.delete(pid);
          projection.set('botmux-b', {
            name: 'botmux-b', pmId: 2, pid: 0, online: false,
            status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
          });
        }
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [...projection.values()],
      successorSettleMs: 10,
    })).toThrow(/restored 1 offline PM2 entry.*live generation untouched/);

    expect(startOffline).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'botmux-b', pmId: 2 })],
      expect.any(Number),
    );
    expect(startOffline.mock.calls.flatMap(call => call[0]).map(entry => entry.name))
      .not.toContain('botmux-a');
    expect(alive.has(101)).toBe(true);
  });

  it('does not compensate an exact row when a fresh duplicate with the same name exists', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'restart', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        {
          name: 'botmux-b', pmId: 2, pid: 0, online: false,
          status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
        },
        {
          name: 'botmux-b', pmId: 9, pid: 0, online: false,
          status: 'waiting restart', exitCode: 1, stopExitCodes: [0],
        },
      ],
    })).toThrow(/fleet is partially stopped.*offline: botmux-b/);
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('leaves a successor first observed at the refusal boundary untouched and restores an unrelated peer', () => {
    const alive = new Set([101, 202]);
    const signalled: number[] = [];
    let now = 0;
    let restored = false;
    const startOffline = vi.fn((offlineEntries: FleetProcessEntry[]) => {
      expect(offlineEntries.map(entry => entry.name)).toEqual(['botmux-b']);
      restored = true;
      alive.add(909);
    });
    const projection = (): FleetProcessEntry[] => [
      ...(now >= 40
        ? [{ name: 'botmux-a', pmId: 1, pid: 808, online: true }]
        : [{
            name: 'botmux-a', pmId: 1, pid: 0, online: false,
            status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
          }]),
      restored
        ? { name: 'botmux-b', pmId: 2, pid: 909, online: true }
        : {
            name: 'botmux-b', pmId: 2, pid: 0, online: false,
            status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
          },
    ];

    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'restart', 50, {
      signal(pid) { signalled.push(pid); alive.delete(pid); },
      isAlive(pid) {
        if (pid === 808 && now >= 40) return true;
        return alive.has(pid);
      },
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: projection,
      successorSettleMs: 100,
      pollMs: 5,
    })).toThrow(/restored 1 offline PM2 entry.*live generation untouched/);
    expect(signalled).toEqual([101, 202]);
    expect(signalled).not.toContain(808);
    expect(startOffline).toHaveBeenCalledOnce();
  });

  it('does not restart or re-signal a healthy successor discovered during partial refusal', () => {
    const alive = new Set([101, 202, 303]);
    let now = 0;
    const signalled: number[] = [];
    const startOffline = vi.fn();

    expect(() => signalAndAwaitFleet(entries, 'restart', 100, {
      signal(pid) {
        signalled.push(pid);
        if (pid === 202) alive.delete(pid);
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        { name: 'botmux-b', pmId: 2, pid: 303, online: true },
      ],
      successorSettleMs: 10,
    })).toThrow(/left every live generation untouched/);

    expect(signalled).toEqual([101, 202]);
    expect(startOffline).not.toHaveBeenCalled();
    expect(alive.has(101)).toBe(true);
    expect(alive.has(303)).toBe(true);
  });

  it('fails closed without a PM2 mutation when fresh-list verification fails', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet(entries, 'stop', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => { throw new Error('jlist unavailable'); },
    })).toThrow(/no compensation was attempted.*verification before compensation failed.*jlist unavailable/);
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('fails closed without compensation when successor verification itself cannot be read', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet(entries, 'restart', 100, {
      signal(pid) { alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => { throw new Error('projection corrupt'); },
      successorSettleMs: 10,
    })).toThrow(/state is unverified and no compensation was attempted.*successor verification failed/);
    expect(startOffline).not.toHaveBeenCalled();
  });

  it('reports a genuinely partial fleet when compensation cannot restore an exited peer', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    expect(() => signalAndAwaitFleet(entries, 'restart', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline() { throw new Error('pm2 unavailable'); },
      list: () => [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        {
          name: 'botmux-b', pmId: 2, pid: 0, online: false,
          status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
        },
      ],
    })).toThrow(/fleet is partially stopped.*botmux-b.*pm2 unavailable/);
  });

  it('compensates a peer whose PM2 row says online but whose PID is dead', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    let projection: FleetProcessEntry[] = [
      { name: 'botmux-a', pmId: 1, pid: 101, online: true },
      {
        name: 'botmux-b', pmId: 2, pid: 303, online: true,
        status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
      }, // stale: 303 is not alive
    ];
    const startOffline = vi.fn((offlineEntries: FleetProcessEntry[]) => {
      expect(offlineEntries.map(entry => entry.name)).toEqual(['botmux-b']);
      alive.add(404);
      projection = [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        { name: 'botmux-b', pmId: 2, pid: 404, online: true },
      ];
    });

    expect(() => signalAndAwaitFleet(entries, 'stop', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => projection,
    })).toThrow(/restored 1 offline PM2 entry/);
    expect(startOffline).toHaveBeenCalledOnce();
    expect(alive.has(404)).toBe(true);
  });

  it('refuses to claim restoration when PM2 reports an online replacement with a dead PID', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    let projection: FleetProcessEntry[] = [
      { name: 'botmux-a', pmId: 1, pid: 101, online: true },
      {
        name: 'botmux-b', pmId: 2, pid: 303, online: true,
        status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
      }, // stale before compensation
    ];
    const startOffline = vi.fn((offlineEntries: FleetProcessEntry[]) => {
      expect(offlineEntries.map(entry => entry.name)).toEqual(['botmux-b']);
      // PM2 claims it started 404, but OS liveness never confirms that PID.
      projection = [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        { name: 'botmux-b', pmId: 2, pid: 404, online: true },
      ];
    });

    expect(() => signalAndAwaitFleet(entries, 'restart', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => projection,
    })).toThrow(/fleet is partially stopped.*offline: botmux-b/);
    expect(startOffline).toHaveBeenCalledOnce();
    expect(alive.has(404)).toBe(false);
  });

  it('caps a successor projection at the absolute fleet deadline and never acts on its late result', () => {
    const alive = new Set([202]);
    const signalled: Array<{ pid: number; at: number }> = [];
    const listCalls: Array<{ at: number; budgetMs: number }> = [];
    const startOffline = vi.fn();
    let now = 0;

    expect(() => signalAndAwaitFleet([entries[1]!], 'restart', 50, {
      signal(pid) {
        signalled.push({ pid, at: now });
        alive.delete(pid);
      },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: budgetMs => {
        listCalls.push({ at: now, budgetMs });
        // Even if a non-conforming subprocess returns after its advertised cap,
        // no observation at the absolute deadline may trigger another signal.
        now = 50;
        alive.add(303);
        return [{ name: 'botmux-b', pmId: 2, pid: 303, online: true }];
      },
      successorSettleMs: 10,
    })).toThrow(/no compensation was attempted.*deadline exhausted during PM2 successor verification/);

    expect(listCalls).toEqual([{ at: 0, budgetMs: 2 }]);
    expect(signalled).toEqual([{ pid: 202, at: 0 }]);
    expect(startOffline).not.toHaveBeenCalled();
    expect(now).toBe(50);
  });

  it('does not issue another list or signal after a projection consumes the remaining deadline', () => {
    const alive = new Set([202]);
    const listCalls: Array<{ at: number; budgetMs: number }> = [];
    const signalCalls: Array<{ pid: number; at: number }> = [];
    const startOffline = vi.fn();
    let now = 0;

    expect(() => signalAndAwaitFleet([entries[1]!], 'stop', 50, {
      signal(pid) { signalCalls.push({ pid, at: now }); }, // original refuses
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: budgetMs => {
        listCalls.push({ at: now, budgetMs });
        now = 50;
        return [{ name: 'botmux-b', pmId: 2, pid: 202, online: true }];
      },
      pollMs: 5,
    })).toThrow(/no compensation was attempted.*deadline exhausted during PM2 verification before compensation/);

    expect(listCalls).toEqual([{ at: 40, budgetMs: 2 }]);
    expect(signalCalls).toEqual([{ pid: 202, at: 0 }]);
    expect(startOffline).not.toHaveBeenCalled();
    expect(now).toBe(50);
  });

  it('partitions one bounded multi-entry compensation inside the absolute fleet deadline', () => {
    const targets: FleetProcessEntry[] = [
      { name: 'botmux-a', pmId: 1, pid: 101, online: true },
      { name: 'botmux-b', pmId: 2, pid: 202, online: true },
      { name: 'botmux-c', pmId: 3, pid: 303, online: true },
    ];
    const alive = new Set([101, 202, 303]);
    const listCalls: Array<{ at: number; budgetMs: number }> = [];
    const compensationCalls: Array<{ names: string[]; at: number; budgetMs: number }> = [];
    let now = 0;
    let greatestNow = 0;
    let compensated = false;
    const advance = (ms: number) => {
      now += ms;
      greatestNow = Math.max(greatestNow, now);
    };

    expect(() => signalAndAwaitFleet(targets, 'restart', 50, {
      signal(pid) { if (pid !== 101) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep: advance,
      startOffline(offlineEntries, budgetMs) {
        compensationCalls.push({
          names: offlineEntries.map(entry => entry.name),
          at: now,
          budgetMs,
        });
        // One helper gets one shared tail budget for both ids, never a fresh
        // per-name timeout.
        advance(budgetMs);
        compensated = true;
        alive.add(404);
        alive.add(505);
      },
      list: budgetMs => {
        listCalls.push({ at: now, budgetMs });
        return [
          { name: 'botmux-a', pmId: 1, pid: 101, online: true },
          compensated ? { name: 'botmux-b', pmId: 2, pid: 404, online: true } : {
            name: 'botmux-b', pmId: 2, pid: 0, online: false,
            status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
          },
          compensated ? { name: 'botmux-c', pmId: 3, pid: 505, online: true } : {
            name: 'botmux-c', pmId: 3, pid: 0, online: false,
            status: 'waiting restart', exitCode: 0, stopExitCodes: [0],
          },
        ];
      },
    })).toThrow(/restored 2 offline PM2 entries.*live generation untouched/);

    expect(compensationCalls).toEqual([{
      names: ['botmux-b', 'botmux-c'],
      at: 40,
      budgetMs: 5,
    }]);
    expect(listCalls).toEqual([
      { at: 40, budgetMs: 2 },
      { at: 45, budgetMs: 2 },
    ]);
    expect(now).toBe(45);
    expect(greatestNow).toBeLessThanOrEqual(50);
  });

  it('does not conditionally start a row whose PM2 policy may still have a restart timer', () => {
    const alive = new Set([101, 202]);
    let now = 0;
    const startOffline = vi.fn();
    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'stop', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        {
          name: 'botmux-b', pmId: 2, pid: 0, online: false,
          status: 'waiting restart', exitCode: 1, stopExitCodes: [0],
        },
      ],
    })).toThrow(/fleet is partially stopped.*offline: botmux-b/);
    expect(startOffline).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing exit_code', exitCode: undefined, stopExitCodes: [0] },
    { label: 'null stop code', exitCode: 0, stopExitCodes: [null] },
    { label: 'empty stop code', exitCode: 0, stopExitCodes: [''] },
  ])('does not coerce malformed timer policy into a safe compensation: $label', ({
    exitCode,
    stopExitCodes,
  }) => {
    const alive = new Set([101, 202]);
    const startOffline = vi.fn();
    let now = 0;
    expect(() => signalAndAwaitFleet(entries.slice(0, 2), 'restart', 50, {
      signal(pid) { if (pid === 202) alive.delete(pid); },
      isAlive: pid => alive.has(pid),
      now: () => now,
      sleep(ms) { now += ms; },
      startOffline,
      list: () => [
        { name: 'botmux-a', pmId: 1, pid: 101, online: true },
        {
          name: 'botmux-b', pmId: 2, pid: 0, online: false,
          status: 'waiting restart',
          ...(exitCode !== undefined ? { exitCode } : {}),
          stopExitCodes,
        },
      ],
    })).toThrow(/fleet is partially stopped.*offline: botmux-b/);
    expect(startOffline).not.toHaveBeenCalled();
  });
});
