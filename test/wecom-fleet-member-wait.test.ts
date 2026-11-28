import { describe, expect, it } from 'vitest';
import { FileLockTimeoutError } from '../src/utils/file-lock.js';
import type { FleetCommandResult } from '../src/core/fleet-command-queue.js';
import {
  awaitFleetMemberOutcome,
  fleetMemberRequestTimeoutMs,
  productionFleetMemberWaitDeps,
  runUnderWecomFleetLock,
  type FleetMemberWaitDeps,
} from '../src/cli/wecom/fleet-lifecycle-runtime.js';
import {
  FLEET_MEMBER_START_WAIT_MS,
  FLEET_MEMBER_STOP_WAIT_MS,
  fleetStopWaitMs,
} from '../src/core/fleet-runtime.js';
import { FLEET_DAEMON_EXIT_WAIT_MS } from '../src/core/shutdown-budgets.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import type { WecomMemberTicket } from '../src/cli/wecom/fleet-lifecycle.js';
import {
  WECOM_LIFECYCLE_LOCK_WAIT_MS,
  WECOM_LIFECYCLE_MAX_MS,
  WECOM_START_SETTLE_MS,
} from '../src/im/wecom/contract/lifecycle-budgets.js';
import { WECOM_LIFECYCLE_CLI_TIMEOUT_MS } from '../src/dashboard/wecom/lifecycle-cli.js';

/**
 * A supervisor that records its outcome `answerAfterMs` after submission, or
 * disappears `exitAfterMs` after it. `drainedAfterMs`: when it took the command
 * out of the queue (until then a withdrawal finds it).
 */
function waitDeps(options: {
  answerAfterMs?: number;
  answer?: FleetCommandResult;
  exitAfterMs?: number;
  drainedAfterMs?: number;
  timeoutMs?: number;
}) {
  let clock = 0;
  let queued = true;
  const withdrawals: number[] = [];
  const deps: FleetMemberWaitDeps = {
    readResult: id => {
      if (options.answerAfterMs !== undefined && clock >= options.answerAfterMs && options.answer) {
        return { ...options.answer, id };
      }
      return undefined;
    },
    supervisorAlive: () => options.exitAfterMs === undefined || clock < options.exitAfterMs,
    withdraw: () => {
      withdrawals.push(clock);
      if (options.drainedAfterMs !== undefined && clock >= options.drainedAfterMs) queued = false;
      const was = queued;
      queued = false;
      return was;
    },
    timeoutMs: () => options.timeoutMs ?? 60_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  };
  return { deps, elapsed: () => clock, withdrawals };
}

const ticket = (op: WecomMemberTicket['op'] = 'start-member'): WecomMemberTicket =>
  ({ op, name: 'wecom-x', id: 'cmd-1', supervisor: { pid: 4242, processStart: 'S' } });
const startedResult: FleetCommandResult = { id: '', op: 'start-member', name: 'wecom-x', ok: true, state: 'started', at: 'T' };

describe('waiting for a member op', () => {
  it('returns the outcome the supervisor recorded for this command, and takes nothing back', async () => {
    const h = waitDeps({ answerAfterMs: 2_000, answer: startedResult });
    expect(await awaitFleetMemberOutcome(ticket(), 60_000, h.deps)).toEqual({ ok: true, state: 'started', name: 'wecom-x' });
    expect(h.withdrawals).toEqual([]);
  });

  it('stops waiting soon after the supervisor goes away, and takes the command back', async () => {
    const h = waitDeps({ exitAfterMs: 5_000, timeoutMs: FLEET_MEMBER_STOP_WAIT_MS });
    const outcome = await awaitFleetMemberOutcome(ticket('stop-member'), FLEET_MEMBER_STOP_WAIT_MS, h.deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'supervisor_exited', withdrawn: true });
    expect(h.elapsed()).toBeLessThan(5_000 + 2_000);
    expect(h.withdrawals).toHaveLength(1);
  });

  it('says so when the supervisor had already taken the command before it went away', async () => {
    const h = waitDeps({ exitAfterMs: 5_000, drainedAfterMs: 0 });
    expect(await awaitFleetMemberOutcome(ticket('stop-member'), 60_000, h.deps))
      .toMatchObject({ ok: false, reason: 'supervisor_exited', withdrawn: false });
  });

  it('still takes an outcome the supervisor recorded just before it exited', async () => {
    // The outcome lands between the wait's last read and the withdrawal.
    let recorded = false;
    const h = waitDeps({});
    h.deps.readResult = id => (recorded ? { ...startedResult, op: 'stop-member', state: 'stopped', id } : undefined);
    h.deps.supervisorAlive = () => { recorded = true; return false; };
    expect(await awaitFleetMemberOutcome(ticket('stop-member'), 60_000, h.deps)).toMatchObject({ ok: true, state: 'stopped' });
  });

  it('times out while the supervisor is alive but never answers, and takes the command back', async () => {
    const h = waitDeps({ timeoutMs: 30_000 });
    const outcome = await awaitFleetMemberOutcome(ticket(), 300_000, h.deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'timeout', withdrawn: true });
    expect(h.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(h.withdrawals).toEqual([h.elapsed()]);
  });

  it('waits no longer than the caller has left, even when the op\'s own budget is longer', async () => {
    const h = waitDeps({ timeoutMs: FLEET_MEMBER_STOP_WAIT_MS });
    await awaitFleetMemberOutcome(ticket('stop-member'), 10_000, h.deps);
    expect(h.elapsed()).toBeGreaterThanOrEqual(10_000);
    expect(h.elapsed()).toBeLessThan(11_000);
  });
});

describe('how long the supervisor and the lock are waited for', () => {
  it('waits the fleet\'s stop budget for stop-member and its start budget for start-member', () => {
    expect(fleetMemberRequestTimeoutMs('stop-member')).toBe(FLEET_MEMBER_STOP_WAIT_MS);
    expect(fleetMemberRequestTimeoutMs('start-member')).toBe(FLEET_MEMBER_START_WAIT_MS);
    const wired = productionFleetMemberWaitDeps();
    expect(wired.timeoutMs('stop-member')).toBe(FLEET_MEMBER_STOP_WAIT_MS);
    expect(wired.timeoutMs('start-member')).toBe(FLEET_MEMBER_START_WAIT_MS);
  });

  it('keeps a whole command (its bound, plus a settle window it never cuts short) within the Dashboard\'s patience', () => {
    expect(WECOM_LIFECYCLE_CLI_TIMEOUT_MS).toBeGreaterThan(WECOM_LIFECYCLE_MAX_MS + WECOM_START_SETTLE_MS);
  });

  // `botmux stop` and `botmux restart` hold the fleet mutation lock while they
  // wait for the old supervisor to stop (stopFleet), for at most fleetStopWaitMs
  // of their FLEET_DAEMON_EXIT_WAIT_MS — longer while a WeCom gateway is live,
  // since the supervisor then waits out the gateway's kill timeout. A wecom
  // command must not give up with fleet_busy inside that window. (The restart's
  // health gate after it is not covered in its worst case.)
  it('waits for the fleet lock at least as long as a Feishu stop waits for a supervisor stopping a gateway', () => {
    const liveGateway = {
      supervisorPid: 0,
      supervisorStartedAt: '',
      procs: [{
        name: wecomFleetMemberName('a'.repeat(64)),
        appId: '',
        pid: process.pid,
        generation: 1,
        status: 'online' as const,
        restarts: 0,
        lastExitCode: null,
        startedAt: null,
      }],
    };
    expect(WECOM_LIFECYCLE_LOCK_WAIT_MS).toBeGreaterThanOrEqual(fleetStopWaitMs(FLEET_DAEMON_EXIT_WAIT_MS, liveGateway));
    expect(WECOM_LIFECYCLE_LOCK_WAIT_MS).toBeGreaterThanOrEqual(fleetStopWaitMs(FLEET_DAEMON_EXIT_WAIT_MS, null));
  });
});

describe('the fleet mutation lock around one section of a wecom command', () => {
  const busy = () => new FileLockTimeoutError('/x/pm2-fleet-mutation.lock', 1, 1);

  it('says once that it is waiting (not in --json), then runs when the lock frees up', async () => {
    const waits: number[] = [];
    const notes: string[] = [];
    const runWithLock = async <T>(fn: () => Promise<T>, maxWaitMs: number): Promise<T> => {
      waits.push(maxWaitMs);
      if (waits.length === 1) throw busy();
      return fn();
    };
    expect(await runUnderWecomFleetLock(runWithLock, () => 'ran', 600_000, { json: false, notifyWaiting: line => notes.push(line) }))
      .toEqual({ ok: true, value: 'ran' });
    expect(notes).toHaveLength(1);
    expect(waits[1]).toBe(WECOM_LIFECYCLE_LOCK_WAIT_MS);

    const quiet: string[] = [];
    waits.length = 0;
    await runUnderWecomFleetLock(runWithLock, () => 'ran', 600_000, { json: true, notifyWaiting: line => quiet.push(line) });
    expect(quiet).toEqual([]);
  });

  it('waits no longer than the command has left', async () => {
    const waits: number[] = [];
    const runWithLock = async <T>(_fn: () => Promise<T>, maxWaitMs: number): Promise<T> => {
      waits.push(maxWaitMs);
      throw busy();
    };
    await runUnderWecomFleetLock(runWithLock, () => 'ran', 20_000, { json: true });
    expect(Math.max(...waits)).toBe(20_000);
  });

  it('answers busy when the lock never frees up, without running the section', async () => {
    let ran = false;
    const outcome = await runUnderWecomFleetLock(async () => { throw busy(); }, () => { ran = true; }, 600_000, { json: true });
    expect(outcome).toEqual({ ok: false });
    expect(ran).toBe(false);
  });

  it('passes on any other error from taking the lock, instead of calling it busy', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    let ran = false;
    await expect(runUnderWecomFleetLock(async () => { throw denied; }, () => { ran = true; }, 600_000, { json: true }))
      .rejects.toBe(denied);
    expect(ran).toBe(false);
  });

  it('does not mistake a lock timeout from inside the section for the fleet lock being busy', async () => {
    let runs = 0;
    const runWithLock = async <T>(fn: () => Promise<T>): Promise<T> => fn();
    await expect(runUnderWecomFleetLock(runWithLock, () => {
      runs += 1;
      throw busy();
    }, 600_000, { json: true })).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(runs).toBe(1);
  });
});
