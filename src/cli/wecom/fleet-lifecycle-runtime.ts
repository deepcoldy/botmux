/**
 * Production wiring of `botmux wecom start|stop|restart` (fleet-lifecycle.ts):
 * the member-op round trip with the live supervisor, the fleet mutation lock,
 * the external-instance check, and the real file locations.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { wecomRoot } from '../../im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  wecomFleetDesiredStatePath,
} from '../../im/wecom/config/fleet-desired-state.js';
import {
  findExternalWecomInstance,
  gatherWecomInstanceFacts,
  wecomConfigBotId,
} from '../../im/wecom/config/fleet-external-instance.js';
import { listWecomFleetConnections, type WecomFleetConnection } from '../../im/wecom/config/fleet-members.js';
import { WECOM_LIFECYCLE_LOCK_WAIT_MS, WECOM_LIFECYCLE_MAX_MS } from '../../im/wecom/contract/lifecycle-budgets.js';
import {
  readFleetCommandResult,
  withdrawFleetCommand,
  type FleetCommandResult,
  type FleetMemberCommandOp,
} from '../../core/fleet-command-queue.js';
import {
  FLEET_MEMBER_START_WAIT_MS,
  FLEET_MEMBER_STOP_WAIT_MS,
  fleetCommandPath,
  fleetCommandResultsPath,
  fleetLogDir,
  fleetStatePath,
  fleetSupervisorStillRunning,
  readFleetStatus,
  signalFleetReconcile,
  submitFleetMemberCommand,
} from '../../core/fleet-runtime.js';
import { readFleetState } from '../../core/fleet-state-store.js';
import { FileLockTimeoutError } from '../../utils/file-lock.js';
import {
  type WecomFleetLockOutcome,
  type WecomLifecycleDeps,
  type WecomMemberRequestOutcome,
  type WecomMemberSubmission,
  type WecomMemberTicket,
} from './fleet-lifecycle.js';

export function fleetMemberRequestTimeoutMs(op: FleetMemberCommandOp): number {
  return op === 'stop-member' ? FLEET_MEMBER_STOP_WAIT_MS : FLEET_MEMBER_START_WAIT_MS;
}

export interface FleetMemberWaitDeps {
  readResult(id: string): FleetCommandResult | undefined;
  /** Is the supervisor this op was handed to still the one running? Unknown counts as running. */
  supervisorAlive(ticket: WecomMemberTicket): boolean;
  /** Take the op back out of the queue; true when it was still there. */
  withdraw(id: string): boolean;
  timeoutMs(op: FleetMemberCommandOp): number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const RESULT_POLL_MS = 150;
/** How often the wait checks that the supervisor is still there. Each check
 *  reads its birth identity (two `ps` runs on macOS), hence not every poll. */
const SUPERVISOR_CHECK_MS = 1_000;

function outcomeOf(result: FleetCommandResult, name: string): WecomMemberRequestOutcome {
  return result.ok
    ? { ok: true, state: result.state, name }
    : { ok: false, reason: result.reason, message: result.message, name };
}

/**
 * Wait for the supervisor's recorded outcome of one submitted member op, for
 * at most `maxWaitMs` (and at most the op's own budget). The fleet mutation
 * lock is not held meanwhile.
 *
 * No answer can come once the wait runs out, or once the supervisor that was
 * signalled is gone — exited, or replaced by another generation (a fleet
 * restart in between; the new supervisor never carries out an op enqueued
 * before it started). Either way the op is then taken back out of the queue if
 * no supervisor has read it yet, so it cannot be carried out later against a
 * newer intent; `withdrawn` says whether that happened.
 */
export async function awaitFleetMemberOutcome(
  ticket: WecomMemberTicket,
  maxWaitMs: number,
  deps: FleetMemberWaitDeps,
): Promise<WecomMemberRequestOutcome> {
  const deadline = deps.now() + Math.max(0, Math.min(deps.timeoutMs(ticket.op), maxWaitMs));
  let nextSupervisorCheck = deps.now() + SUPERVISOR_CHECK_MS;
  const gaveUp = (
    reason: 'timeout' | 'supervisor_exited',
    message: string,
  ): WecomMemberRequestOutcome => {
    const withdrawn = deps.withdraw(ticket.id);
    // It may have recorded the outcome between the last read and the withdrawal.
    const late = deps.readResult(ticket.id);
    if (late) return outcomeOf(late, ticket.name);
    return { ok: false, reason, message, name: ticket.name, withdrawn };
  };
  for (;;) {
    const result = deps.readResult(ticket.id);
    if (result) return outcomeOf(result, ticket.name);
    if (deps.now() >= deadline) {
      return gaveUp('timeout', `${ticket.name} 未在超时时间内得到 supervisor 的处理结果`);
    }
    if (deps.now() >= nextSupervisorCheck) {
      nextSupervisorCheck = deps.now() + SUPERVISOR_CHECK_MS;
      if (!deps.supervisorAlive(ticket)) {
        return gaveUp('supervisor_exited', 'supervisor 在等待期间退出');
      }
    }
    await deps.sleep(RESULT_POLL_MS);
  }
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export function productionFleetMemberWaitDeps(): FleetMemberWaitDeps {
  return {
    readResult: id => readFleetCommandResult(fleetCommandResultsPath(), id),
    supervisorAlive: ticket => {
      try {
        return fleetSupervisorStillRunning(ticket.supervisor);
      } catch {
        return true;
      }
    },
    withdraw: id => withdrawFleetCommand(fleetCommandPath(), id),
    timeoutMs: fleetMemberRequestTimeoutMs,
    now: Date.now,
    sleep,
  };
}

/** Enqueue + SIGHUP (call under the fleet mutation lock). */
export function submitWecomMemberOp(op: FleetMemberCommandOp, name: string): WecomMemberSubmission {
  const submitted = submitFleetMemberCommand(op, name, {
    idFactory: () => randomBytes(8).toString('hex'),
    nowIso: () => new Date().toISOString(),
  });
  if (!submitted.ok) return { ok: false, outcome: submitted };
  return { ok: true, ticket: { op, name, id: submitted.id, supervisor: submitted.supervisor } };
}

/** The external-instance check with the real files and process table. */
export function findExternalWecomInstanceOnHost(
  connection: WecomFleetConnection,
  connections: readonly WecomFleetConnection[],
  root: string = wecomRoot(),
) {
  if (connection.config.presence !== 'present') return { kind: 'none' as const };
  const botId = wecomConfigBotId(connection.config.text);
  if (!botId) return { kind: 'none' as const };
  const others = connections.flatMap(other => {
    const otherBotId = other.config.presence === 'present' ? wecomConfigBotId(other.config.text) : undefined;
    return otherBotId ? [{ configId: other.configId, botId: otherBotId }] : [];
  });
  const rows = new Map((readFleetState(fleetStatePath())?.procs ?? []).map(row => [row.name, row]));
  return findExternalWecomInstance(gatherWecomInstanceFacts({
    root,
    configId: connection.configId,
    botId,
    connections: others,
    rows,
  }));
}

/** The first, short attempt; only when it fails does the command say it is waiting. */
const LOCK_QUICK_ATTEMPT_MS = 1_000;

export type FleetLockRunner = <T>(fn: () => Promise<T>, maxWaitMs: number) => Promise<T>;

/**
 * Run `section` under the fleet mutation lock, waiting at most `maxWaitMs`
 * (and at most WECOM_LIFECYCLE_LOCK_WAIT_MS). When the lock is taken, say so
 * once (not in `--json` mode, whose output is a single line) and keep waiting;
 * still taken then → `{ ok: false }`. A lock timeout raised from INSIDE the
 * section (another file's lock) is not mistaken for the fleet lock being busy.
 */
export async function runUnderWecomFleetLock<T>(
  runWithLock: FleetLockRunner,
  section: () => T,
  maxWaitMs: number,
  options: { json: boolean; notifyWaiting?: (line: string) => void },
): Promise<WecomFleetLockOutcome<T>> {
  let entered = false;
  const guarded = async () => {
    entered = true;
    return section();
  };
  const attempt = async (waitMs: number): Promise<WecomFleetLockOutcome<T>> => {
    try {
      return { ok: true, value: await runWithLock(guarded, waitMs) };
    } catch (err) {
      if (entered || !(err instanceof FileLockTimeoutError)) throw err;
      return { ok: false };
    }
  };
  const longest = Math.max(0, Math.min(WECOM_LIFECYCLE_LOCK_WAIT_MS, maxWaitMs));
  const quick = await attempt(Math.min(LOCK_QUICK_ATTEMPT_MS, longest));
  if (quick.ok || longest <= LOCK_QUICK_ATTEMPT_MS) return quick;
  if (!options.json) {
    (options.notifyWaiting ?? (line => console.error(line)))(
      `… 另一个 fleet 操作正在进行，等待它结束（最长 ${Math.round(longest / 1000)} 秒）`);
  }
  return attempt(longest);
}

export function productionWecomLifecycleDeps(
  runWithLock: FleetLockRunner,
  options: { json: boolean },
): WecomLifecycleDeps {
  const root = wecomRoot();
  const wait = productionFleetMemberWaitDeps();
  return {
    readDesired: () => readWecomFleetDesiredState(root),
    listConnections: () => listWecomFleetConnections(root),
    setDesired: (configId, desired) => setWecomFleetDesiredState(configId, desired, { root }),
    desiredStatePath: wecomFleetDesiredStatePath(root),
    registryPath: join(root, 'config-registry.json'),
    withFleetLock: (section, maxWaitMs) => runUnderWecomFleetLock(runWithLock, section, maxWaitMs, options),
    submit: submitWecomMemberOp,
    awaitOutcome: (ticket, maxWaitMs) => awaitFleetMemberOutcome(ticket, maxWaitMs, wait),
    findExternalInstance: (connection, connections) => findExternalWecomInstanceOnHost(connection, connections, root),
    reconcile: () => {
      signalFleetReconcile();
    },
    readMemberRow: name => readFleetStatus().rows.find(row => row.name === name),
    logDir: fleetLogDir(),
    requestTimeoutSeconds: op => Math.round(fleetMemberRequestTimeoutMs(op) / 1000),
    memberStopWaitMs: FLEET_MEMBER_STOP_WAIT_MS,
    commandBudgetMs: WECOM_LIFECYCLE_MAX_MS,
    now: Date.now,
    sleep,
  };
}
