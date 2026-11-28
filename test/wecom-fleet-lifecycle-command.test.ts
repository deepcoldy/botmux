import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  setWecomFleetDesiredStopped,
  wecomFleetDesiredStatePath,
} from '../src/im/wecom/config/fleet-desired-state.js';
import { describeWecomStopReason } from '../src/im/wecom/contract/stop-reason.js';
import { listWecomFleetConnections, type WecomFleetConnection } from '../src/im/wecom/config/fleet-members.js';
import { resolveWecomFleetMembers } from '../src/core/fleet-wecom-members.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import type { FleetMemberCommandOp } from '../src/core/fleet-command-queue.js';
import type { FleetStatusRow } from '../src/core/fleet-runtime.js';
import type { WecomExternalInstance } from '../src/im/wecom/config/fleet-external-instance.js';
import { FileLockTimeoutError } from '../src/utils/file-lock.js';
import {
  findWecomConnection,
  parseWecomLifecycleArgs,
  printWecomLifecycleResult,
  runWecomLifecycle,
  type WecomLifecycleDeps,
  type WecomLifecycleRequest,
  type WecomMemberRequestOutcome,
} from '../src/cli/wecom/fleet-lifecycle.js';
import { WECOM_START_SETTLE_MS } from '../src/im/wecom/contract/lifecycle-budgets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A WeCom root with one registered connection. */
function fixture(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-lifecycle-'));
  dirs.push(root);
  const file = join(root, 'conn', 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ botId: 'bot', coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'], ...config }));
  writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [file] }));
  const configId = wecomConfigId(file);
  return { root, file, configId, member: wecomFleetMemberName(configId) };
}

type Answer = WecomMemberRequestOutcome | ((name: string) => WecomMemberRequestOutcome);

/**
 * Real desired-state and registry files under `root`; a scripted supervisor.
 * Every op handed over records the desired state as it was on disk at that
 * moment and whether the fleet lock was held; every wait for an answer records
 * whether the lock was held while waiting.
 */
function harness(root: string, answers: Partial<Record<FleetMemberCommandOp, Answer[]>>, rows: Array<FleetStatusRow | undefined> = []) {
  let clock = 1_000_000;
  const requests: Array<{ op: FleetMemberCommandOp; name: string; desiredAtRequest: string | undefined; underLock: boolean }> = [];
  const waitsUnderLock: boolean[] = [];
  let reconciles = 0;
  let lockHeld = false;
  let lockSections = 0;
  let nextTicket = 0;
  const pending = new Map<string, WecomMemberRequestOutcome>();
  const queue = { 'start-member': [...(answers['start-member'] ?? [])], 'stop-member': [...(answers['stop-member'] ?? [])] };
  const rowQueue = [...rows];
  const control: { external: WecomExternalInstance; lockBusy: boolean; afterWait?: () => void } = { external: { kind: 'none' }, lockBusy: false };
  const deps: WecomLifecycleDeps = {
    readDesired: () => readWecomFleetDesiredState(root),
    listConnections: () => listWecomFleetConnections(root),
    setDesired: (configId, desired) => setWecomFleetDesiredState(configId, desired, { root, now: () => new Date(clock) }),
    desiredStatePath: wecomFleetDesiredStatePath(root),
    registryPath: join(root, 'config-registry.json'),
    withFleetLock: async (section) => {
      if (control.lockBusy) return { ok: false };
      lockHeld = true;
      lockSections += 1;
      try {
        return { ok: true, value: section() };
      } finally {
        lockHeld = false;
      }
    },
    submit: (op, name) => {
      const snapshot = readWecomFleetDesiredState(root);
      const desiredAtRequest = snapshot.status === 'ok'
        ? [...snapshot.connections.values()].map(r => r.desired).join(',') || undefined
        : 'unavailable';
      requests.push({ op, name, desiredAtRequest, underLock: lockHeld });
      const next = queue[op].shift();
      if (!next) throw new Error(`unexpected ${op}`);
      const outcome = typeof next === 'function' ? next(name) : next;
      // Like the real submission: with no supervisor nothing is enqueued.
      if (!outcome.ok && outcome.reason === 'fleet_down') return { ok: false, outcome };
      nextTicket += 1;
      const id = `t${nextTicket}`;
      pending.set(id, outcome);
      return { ok: true, ticket: { op, name, id, supervisor: { pid: 4242, processStart: 'S' } } };
    },
    awaitOutcome: async (ticket) => {
      waitsUnderLock.push(lockHeld);
      clock += 100;
      const outcome = pending.get(ticket.id)!;
      control.afterWait?.();
      return outcome;
    },
    findExternalInstance: () => control.external,
    reconcile: () => { reconciles += 1; },
    readMemberRow: () => (rowQueue.length > 1 ? rowQueue.shift() : rowQueue[0]),
    logDir: '/logs',
    requestTimeoutSeconds: () => 30,
    memberStopWaitMs: 90_000,
    commandBudgetMs: 300_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  };
  return {
    deps,
    requests,
    control,
    waitsUnderLock,
    lockSections: () => lockSections,
    reconciles: () => reconciles,
    elapsed: () => clock - 1_000_000,
  };
}

const started = (name: string): WecomMemberRequestOutcome => ({ ok: true, state: 'started', name });
const stoppedOk = (name: string): WecomMemberRequestOutcome => ({ ok: true, state: 'stopped', name });
const fail = (reason: Extract<WecomMemberRequestOutcome, { ok: false }>['reason']) =>
  (name: string): WecomMemberRequestOutcome => ({ ok: false, reason, message: 'm', name });
const onlineRow = (name: string, pid = 4242): FleetStatusRow =>
  ({ name, appId: '', pid, status: 'online', alive: true, restarts: 0, lastExitCode: null, startedAt: 'T' });

function recordOf(root: string, configId: string) {
  const snapshot = readWecomFleetDesiredState(root);
  if (snapshot.status !== 'ok') throw new Error('unavailable');
  return snapshot.connections.get(configId);
}

function req(op: WecomLifecycleRequest['op'], configId: string): Pick<WecomLifecycleRequest, 'op' | 'target'> {
  return { op, target: { kind: 'id', configId } };
}

describe('botmux wecom start', () => {
  it('records running before asking the supervisor, and reports the member started', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(h.requests).toEqual([{ op: 'start-member', name: f.member, desiredAtRequest: 'running', underLock: true }]);
    expect(h.waitsUnderLock).toEqual([false]);
    expect(result).toMatchObject({ ok: true, state: 'started', configId: f.configId, member: f.member, desired: 'running' });
    expect(recordOf(f.root, f.configId)?.desired).toBe('running');
    expect(printWecomLifecycleResult(result, true, { log: () => {}, error: () => {} })).toBe(0);
  });

  it('clears the reason a gateway left when it stopped itself, and says which one it cleared', async () => {
    const f = fixture();
    setWecomFleetDesiredStopped(f.configId, 'replaced', { root: f.root });
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(recordOf(f.root, f.configId)).toMatchObject({ desired: 'running' });
    expect(recordOf(f.root, f.configId)?.reason).toBeUndefined();
    expect(result.clearedStopReason).toBe('replaced');
  });

  it('with no fleet running keeps the recorded intent and fails, so the caller knows nothing started', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [fail('fleet_down')] });
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'fleet_down', desired: 'running' });
    expect(recordOf(f.root, f.configId)?.desired).toBe('running');
    expect(h.reconciles()).toBe(0);
    expect(printWecomLifecycleResult(result, true, { log: () => {}, error: () => {} })).not.toBe(0);
  });

  it('does not roll the intent back when the supervisor fails, and nudges it to reconcile once', async () => {
    for (const reason of ['spawn_failed', 'timeout', 'resolve_failed', 'supervisor_exited'] as const) {
      const f = fixture();
      const h = harness(f.root, { 'start-member': [fail(reason)] });
      const result = await runWecomLifecycle(req('start', f.configId), h.deps);
      expect(result).toMatchObject({ ok: false, reason });
      expect(recordOf(f.root, f.configId)?.desired).toBe('running');
      expect(h.reconciles()).toBe(1);
    }
  });

  it('reports a gateway that exits right after starting, with the reason it recorded', async () => {
    const f = fixture();
    const h = harness(f.root, {
      'start-member': [name => {
        // The gateway refuses (no-restart exit) and records why before exiting.
        setWecomFleetDesiredStopped(f.configId, 'invalid_configuration', { root: f.root });
        return started(name);
      }],
    }, [
      onlineRow(f.member),
      { ...onlineRow(f.member), pid: 0, status: 'errored', alive: false, lastExitCode: 78 },
    ]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'gateway_exited', desired: 'stopped', stopReason: 'invalid_configuration' });
  });

  it('watches a started gateway for the settle window only', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result.ok).toBe(true);
    expect(h.elapsed()).toBeGreaterThanOrEqual(WECOM_START_SETTLE_MS);
    expect(h.elapsed()).toBeLessThan(WECOM_START_SETTLE_MS + 1_000);
  });

  it('treats a member still shown online but whose process is gone as an exit', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member), { ...onlineRow(f.member), alive: false }]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'gateway_exited' });
  });

  it('answers desired_state_busy, instead of throwing, when the desired-state lock is held', async () => {
    const f = fixture();
    const h = harness(f.root, {});
    h.deps.setDesired = () => { throw new FileLockTimeoutError(`${f.root}/fleet-desired.json.lock`, 1, 1); };
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'desired_state_busy', configId: f.configId });
    expect(h.requests).toEqual([]);
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it('treats a restarted pid during the settle window as an exit', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member, 100), onlineRow(f.member, 101)]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'gateway_exited', desired: 'running' });
  });

  it('refuses a registered connection whose configuration file is gone, changing nothing', async () => {
    const f = fixture();
    rmSync(f.file);
    const h = harness(f.root, {});
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'configuration_missing' });
    expect(h.requests).toEqual([]);
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
  });
});

describe('botmux wecom stop', () => {
  it('records stopped BEFORE asking the supervisor to stop the member', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk] });
    const result = await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(h.requests).toEqual([{ op: 'stop-member', name: f.member, desiredAtRequest: 'stopped', underLock: true }]);
    expect(h.waitsUnderLock).toEqual([false]);
    expect(result).toMatchObject({ ok: true, state: 'stopped', desired: 'stopped' });
  });

  it('records a person\'s stop without a reason, replacing a gateway-recorded one', async () => {
    const f = fixture();
    setWecomFleetDesiredStopped(f.configId, 'authentication_failed', { root: f.root });
    const h = harness(f.root, { 'stop-member': [name => ({ ok: true, state: 'already-stopped', name })] });
    await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(recordOf(f.root, f.configId)).toMatchObject({ desired: 'stopped' });
    expect(recordOf(f.root, f.configId)?.reason).toBeUndefined();
  });

  it('succeeds with no fleet running: the recorded stop is the whole job then', async () => {
    const f = fixture();
    const h = harness(f.root, { 'stop-member': [fail('fleet_down')] });
    const result = await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(result).toMatchObject({ ok: true, state: 'already-stopped', desired: 'stopped' });
    expect(recordOf(f.root, f.configId)?.desired).toBe('stopped');
  });

  it('reads "not a member" from the supervisor as already stopped for a registered connection', async () => {
    const f = fixture();
    const h = harness(f.root, { 'stop-member': [fail('unknown_member')] });
    const result = await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(result).toMatchObject({ ok: true, state: 'already-stopped' });
  });

  it('keeps the stop recorded when the supervisor fails to stop it, and nudges a reconcile', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [fail('stop_failed')] });
    const result = await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'stop_failed', desired: 'stopped' });
    expect(recordOf(f.root, f.configId)?.desired).toBe('stopped');
    expect(h.reconciles()).toBe(1);
  });
});

describe('a registered connection whose configuration file is gone', () => {
  it('can still be stopped: recorded stopped and the member asked to stop', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    rmSync(f.file);
    const h = harness(f.root, { 'stop-member': [stoppedOk] });
    const result = await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(h.requests).toEqual([{ op: 'stop-member', name: f.member, desiredAtRequest: 'stopped', underLock: true }]);
    expect(result).toMatchObject({ ok: true, state: 'stopped', desired: 'stopped' });
  });

  it('is refused by restart, like start, changing nothing', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    rmSync(f.file);
    const h = harness(f.root, {});
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'configuration_missing' });
    expect(h.requests).toEqual([]);
  });
});

describe('botmux wecom restart', () => {
  it('stops then starts a running member, one op at a time, never recording a stop', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk], 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(h.requests).toEqual([
      { op: 'stop-member', name: f.member, desiredAtRequest: 'running', underLock: true },
      { op: 'start-member', name: f.member, desiredAtRequest: 'running', underLock: true },
    ]);
    // Two short locked sections; neither wait for an answer holds the lock.
    expect(h.lockSections()).toBe(2);
    expect(h.waitsUnderLock).toEqual([false, false]);
    expect(result).toMatchObject({ ok: true, state: 'restarted', desired: 'running' });
  });

  it('starts a connection that is not recorded as running, like start', async () => {
    for (const before of ['stopped', undefined] as const) {
      const f = fixture();
      if (before) setWecomFleetDesiredState(f.configId, before, { root: f.root });
      const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member)]);
      const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
      expect(h.requests.map(r => r.op)).toEqual(['start-member']);
      expect(result).toMatchObject({ ok: true, state: 'started', desired: 'running' });
    }
  });

  it('leaves the intent running when the start half fails after the stop', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk], 'start-member': [fail('spawn_failed')] });
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'spawn_failed', desired: 'running' });
    expect(recordOf(f.root, f.configId)?.desired).toBe('running');
    expect(h.reconciles()).toBe(1);
  });

  it('does not start when the stop half fails', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [fail('timeout')] });
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(h.requests.map(r => r.op)).toEqual(['stop-member']);
  });
});

describe('which connection, and unreadable state', () => {
  it('addresses the same connection by --config file as by id', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle({ op: 'start', target: { kind: 'file', file: f.file } }, h.deps);
    expect(result).toMatchObject({ ok: true, configId: f.configId, member: f.member });
  });

  it('addresses the same connection by the member name botmux status shows as by id', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle({ op: 'start', target: { kind: 'member', name: f.member } }, h.deps);
    expect(result).toMatchObject({ ok: true, configId: f.configId, member: f.member });
    expect(h.requests.map(r => r.name)).toEqual([f.member]);
  });

  it('refuses a member name no registered connection has the way it refuses an unknown id, writing nothing', async () => {
    const f = fixture();
    const unknownId = 'f'.repeat(64);
    const unknownMember = wecomFleetMemberName(unknownId);
    const h = harness(f.root, {});
    const byMember = await runWecomLifecycle({ op: 'stop', target: { kind: 'member', name: unknownMember } }, h.deps);
    const byId = await runWecomLifecycle(req('stop', unknownId), h.deps);
    expect(byMember).toMatchObject({ ok: false, reason: 'unknown_connection', configId: null, member: null });
    expect({ ...byMember, message: byMember.message.replace(unknownMember, '<target>') })
      .toEqual({ ...byId, message: byId.message.replace(unknownId, '<target>') });
    expect(printWecomLifecycleResult(byMember, true, { log: () => {}, error: () => {} })).toBe(1);
    expect(h.requests).toEqual([]);
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
  });

  it('refuses a connection that is not registered and writes nothing', async () => {
    const f = fixture();
    const h = harness(f.root, {});
    const result = await runWecomLifecycle(req('start', 'f'.repeat(64)), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'unknown_connection', configId: null, member: null });
    expect(h.requests).toEqual([]);
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
  });

  it('leaves an unreadable desired-state file byte for byte as it was, for every op', async () => {
    for (const op of ['start', 'stop', 'restart'] as const) {
      const f = fixture();
      const path = wecomFleetDesiredStatePath(f.root);
      writeFileSync(path, '{ broken');
      const h = harness(f.root, {});
      const result = await runWecomLifecycle(req(op, f.configId), h.deps);
      expect(result).toMatchObject({ ok: false, reason: 'desired_state_unavailable' });
      expect(result.message).toContain(path);
      expect(readFileSync(path, 'utf8')).toBe('{ broken');
      expect(h.requests).toEqual([]);
    }
  });

  it('refuses when the registry cannot be read', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'config-registry.json'), 'nope');
    const h = harness(f.root, {});
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'registry_unavailable' });
    expect(h.requests).toEqual([]);
  });
});

describe('the fleet lock is held only to record and hand over', () => {
  it('a restart whose every wait runs to its limit still ends within the command budget', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, {
      'stop-member': [stoppedOk],
      'start-member': [fail('member_stopping'), started],
    }, [onlineRow(f.member, 100)]);
    let clock = 0;
    const budgets = { 'stop-member': 97_500, 'start-member': 30_000 } as const;
    const lock = h.deps.withFleetLock;
    const answer = h.deps.awaitOutcome;
    h.deps.now = () => clock;
    h.deps.sleep = async ms => { clock += ms; };
    // Every lock wait and every wait for an answer uses all the time it is given.
    h.deps.withFleetLock = async (section, maxWaitMs) => {
      clock += Math.min(135_000, maxWaitMs);
      return maxWaitMs > 0 ? lock(section, maxWaitMs) : { ok: false };
    };
    h.deps.awaitOutcome = async (ticket, maxWaitMs) => {
      clock += Math.min(budgets[ticket.op], maxWaitMs);
      return answer(ticket, maxWaitMs);
    };
    // The stopping generation never goes away.
    await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(clock).toBeLessThanOrEqual(h.deps.commandBudgetMs + WECOM_START_SETTLE_MS + 1_000);
  });

  it('answers fleet_busy and records nothing when the lock stays taken', async () => {
    const f = fixture();
    const h = harness(f.root, {});
    h.control.lockBusy = true;
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'fleet_busy' });
    expect(h.requests).toEqual([]);
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
  });

  it('a restart whose start half cannot get the lock keeps the intent running', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk] });
    h.control.afterWait = () => { h.control.lockBusy = true; };
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'fleet_busy', desired: 'running' });
    expect(h.requests.map(r => r.op)).toEqual(['stop-member']);
  });
});

describe('an instance outside the fleet already runs the bot', () => {
  for (const external of [
    { kind: 'external', source: 'terminal_gateway', pid: 77 },
    { kind: 'external', source: 'same_bot', configId: 'e'.repeat(64) },
    { kind: 'external', source: 'instance_lock', pid: 78 },
    { kind: 'unverifiable', source: 'instance_lock', pid: 79 },
  ] as const) {
    it(`start and restart refuse (${external.kind} ${external.source}) without recording anything`, async () => {
      for (const op of ['start', 'restart'] as const) {
        const f = fixture();
        if (op === 'restart') setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
        const before = existsSync(wecomFleetDesiredStatePath(f.root)) ? readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8') : null;
        const h = harness(f.root, {});
        h.control.external = external;
        const result = await runWecomLifecycle(req(op, f.configId), h.deps);
        expect(result).toMatchObject({ ok: false, reason: 'external_instance', configId: f.configId });
        expect(h.requests).toEqual([]);
        const after = existsSync(wecomFleetDesiredStatePath(f.root)) ? readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8') : null;
        expect(after).toBe(before);
      }
    });
  }

  it('does not stand in the way of stop', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk] });
    h.control.external = { kind: 'external', source: 'instance_lock', pid: 78 };
    expect(await runWecomLifecycle(req('stop', f.configId), h.deps)).toMatchObject({ ok: true, state: 'stopped' });
  });
});

describe('a gateway that is shutting itself down when start arrives', () => {
  it('waits for that generation to exit, then starts a new one and watches it', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [fail('member_stopping'), started] }, [
      onlineRow(f.member, 100),
      onlineRow(f.member, 100),
      { ...onlineRow(f.member, 0), status: 'errored', alive: false, lastExitCode: 78 },
      onlineRow(f.member, 101),
    ]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(h.requests.map(r => [r.op, r.underLock])).toEqual([['start-member', true], ['start-member', true]]);
    expect(h.waitsUnderLock).toEqual([false, false]);
    expect(result).toMatchObject({ ok: true, state: 'started', desired: 'running' });
    expect(h.elapsed()).toBeGreaterThanOrEqual(WECOM_START_SETTLE_MS);
  });

  it('watches the new generation even when the supervisor already brought it back on its own', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [fail('member_stopping'), name => ({ ok: true, state: 'already-online', name })] }, [
      onlineRow(f.member, 100),
      onlineRow(f.member, 101),
      { ...onlineRow(f.member, 0), status: 'errored', alive: false, lastExitCode: 78 },
    ]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'gateway_exited' });
  });

  it('reports failure, not "already running", when that generation does not exit in time', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [fail('member_stopping')] }, [onlineRow(f.member, 100)]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'member_stopping', desired: 'running' });
    expect(h.requests).toHaveLength(1);
  });

  it('starts nothing when a person recorded a stop while it was shutting down', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [fail('member_stopping')] }, [
      onlineRow(f.member, 100),
      { ...onlineRow(f.member, 0), status: 'stopped', alive: false },
    ]);
    h.control.afterWait = () => setWecomFleetDesiredState(f.configId, 'stopped', { root: f.root });
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'superseded', desired: 'stopped' });
    expect(h.requests).toHaveLength(1);
  });
});

describe('what the result says about the desired state', () => {
  it('is read from the file when the command ends, not remembered from its start', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [fail('superseded')] });
    // Another command records running while this stop waits for its answer.
    h.control.afterWait = () => setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const result = await runWecomLifecycle(req('stop', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'superseded', desired: 'running' });
  });

  it('carries a gateway-recorded reason that landed while start waited', async () => {
    const f = fixture();
    const h = harness(f.root, { 'start-member': [fail('unknown_member')] });
    h.control.afterWait = () => setWecomFleetDesiredStopped(f.configId, 'replaced', { root: f.root });
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'unknown_member', desired: 'stopped', stopReason: 'replaced' });
  });
});

describe('restart, beyond the plain case', () => {
  it('goes on to start when the stop finds nothing to stop', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [fail('unknown_member')], 'start-member': [started] }, [onlineRow(f.member)]);
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(h.requests.map(r => r.op)).toEqual(['stop-member', 'start-member']);
    expect(result).toMatchObject({ ok: true, state: 'restarted', desired: 'running' });
  });

  it('clears a stop the gateway recorded on its own between the two halves, like start', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk], 'start-member': [started] }, [onlineRow(f.member)]);
    h.control.afterWait = () => {
      h.control.afterWait = undefined;
      setWecomFleetDesiredStopped(f.configId, 'replaced', { root: f.root });
    };
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(h.requests.map(r => [r.op, r.desiredAtRequest])).toEqual([['stop-member', 'running'], ['start-member', 'running']]);
    expect(result).toMatchObject({ ok: true, state: 'restarted', desired: 'running', clearedStopReason: 'replaced' });
  });

  it('does not start again when a person recorded a stop between the two halves', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running', { root: f.root });
    const h = harness(f.root, { 'stop-member': [stoppedOk] });
    h.control.afterWait = () => setWecomFleetDesiredState(f.configId, 'stopped', { root: f.root });
    const result = await runWecomLifecycle(req('restart', f.configId), h.deps);
    expect(h.requests.map(r => r.op)).toEqual(['stop-member']);
    expect(result).toMatchObject({ ok: false, reason: 'superseded', desired: 'stopped' });
  });
});

describe('a credential taken from an environment variable the fleet does not have', () => {
  it('names the variable, not "invalid configuration", when the gateway stops on it', async () => {
    const f = fixture({ secretEnv: 'PROBE_WECOM_SECRET' });
    const h = harness(f.root, {
      'start-member': [name => {
        setWecomFleetDesiredStopped(f.configId, 'credential_env_missing', { root: f.root });
        return started(name);
      }],
    }, [
      onlineRow(f.member),
      { ...onlineRow(f.member), pid: 0, status: 'errored', alive: false, lastExitCode: 78 },
    ]);
    const result = await runWecomLifecycle(req('start', f.configId), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'gateway_exited', desired: 'stopped', stopReason: 'credential_env_missing' });
    expect(result.message).toContain('PROBE_WECOM_SECRET');
    expect(result.message).not.toContain(describeWecomStopReason('invalid_configuration'));
  });
});

describe('argument parsing', () => {
  const id = 'a'.repeat(64);
  it('takes a full configId or --config <file>, and --json anywhere after the op', () => {
    expect(parseWecomLifecycleArgs(['start', id])).toEqual({ ok: true, request: { op: 'start', target: { kind: 'id', configId: id }, json: false } });
    expect(parseWecomLifecycleArgs(['stop', '--json', id])).toEqual({ ok: true, request: { op: 'stop', target: { kind: 'id', configId: id }, json: true } });
    expect(parseWecomLifecycleArgs(['restart', '--config', 'c.json'], '/w')).toEqual({
      ok: true, request: { op: 'restart', target: { kind: 'file', file: '/w/c.json' }, json: false },
    });
  });

  it('takes the member name botmux status shows', () => {
    const member = `wecom-${id.slice(0, 12)}`;
    expect(parseWecomLifecycleArgs(['stop', member, '--json'])).toEqual({ ok: true, request: { op: 'stop', target: { kind: 'member', name: member }, json: true } });
  });

  it('rejects a shortened id, another process name, a missing target and extra operands', () => {
    for (const args of [['start', id.slice(0, 12)], ['start', 'botmux-0'], ['start', `wecom-${id.slice(0, 11)}`], ['stop'], ['start', id, id], ['start', '--config'], ['start', `wecom-${id.slice(0, 12)}`, id]]) {
      expect(parseWecomLifecycleArgs(args)).toMatchObject({ ok: false, help: false });
    }
    expect(parseWecomLifecycleArgs(['start', '--help'])).toMatchObject({ ok: false, help: true });
  });

  it('does not take another switch as the --config file', () => {
    for (const args of [['start', '--config', '--json'], ['stop', '--config', '-x'], ['restart', '--config', '--force', '--json']]) {
      expect(parseWecomLifecycleArgs(args)).toMatchObject({ ok: false, help: false });
    }
  });
});

describe('two registered connections whose ids share a member name', () => {
  // Ids sharing their first 12 hex digits; the registry order is the array order.
  const first = '0123456789ab' + '1'.repeat(52);
  const second = '0123456789ab' + '2'.repeat(52);
  const connection = (configId: string, desired: WecomFleetConnection['desired'], presence: 'present' | 'missing' | 'unreadable' = 'present'): WecomFleetConnection => ({
    configId,
    file: `/registry/${configId}.json`,
    memberName: wecomFleetMemberName(configId),
    desired,
    config: presence === 'present' ? { presence, text: '{}' } : presence === 'missing' ? { presence } : { presence, reason: 'EACCES' },
  });
  const name = wecomFleetMemberName(first);

  /** The file the fleet's own member resolution runs (or holds) under `name`, if any. */
  function fleetHolder(connections: WecomFleetConnection[]): string | undefined {
    const resolution = resolveWecomFleetMembers({ distDir: '/dist', baseEnv: {}, readEnvFileText: () => undefined, connections });
    const member = resolution.members.find(spec => spec.name === name);
    if (member) return member.external!.args.find(arg => arg.startsWith('/registry/'));
    if (resolution.indeterminate.includes(name)) {
      return connections.find(c => c.desired === 'running' && c.config.presence === 'unreadable')!.file;
    }
    return undefined;
  }

  it.each([
    ['the second runs', [connection(first, 'stopped'), connection(second, 'running')]],
    ['both run', [connection(first, 'running'), connection(second, 'running')]],
    ['the first runs from a missing file', [connection(first, 'running', 'missing'), connection(second, 'running')]],
    ['the first runs from an unreadable file', [connection(first, 'running', 'unreadable'), connection(second, 'running')]],
  ] as const)('gives the name to the one the fleet runs under it (%s)', (_case, connections) => {
    const found = findWecomConnection([...connections], { kind: 'member', name });
    expect(found.ok && found.connection.file).toBe(fleetHolder([...connections]));
  });

  it('gives it to the first registered one when the fleet runs neither', () => {
    const connections = [connection(first, 'stopped'), connection(second, 'unrecorded')];
    expect(fleetHolder(connections)).toBeUndefined();
    const found = findWecomConnection(connections, { kind: 'member', name });
    expect(found.ok && found.connection.configId).toBe(first);
  });
});
