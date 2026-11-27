/**
 * How the Dashboard shows one WeCom connection, decided from facts alone (no
 * file access, no process inspection: the manager gathers those and injects
 * them, tests inject their own).
 *
 * The fleet supervisor runs a connection's gateway as the member
 * `wecom-<id12>` when its desired state is `running`; the Dashboard starts and
 * stops it only through `botmux wecom start|stop|restart`. So the state is read
 * from three places: the desired-state record (what should happen), the
 * member's fleet-state row (what the supervisor did), and the bot's runtime
 * record (what the gateway reports: connection state, diagnostics). The runtime
 * record proves it belongs to the member when its pid and birth identity are the
 * row's.
 */
import type { FleetProcState } from '../../core/fleet-supervisor-policy.js';
import type { WecomDesiredRecord, WecomDesiredStopReason } from '../../im/wecom/config/fleet-desired-state.js';
import {
  isFreshWecomRuntime,
  wecomCoreProfileEvaluation,
  wecomStateWriteFailure,
  type WecomRuntimeRecord,
} from '../../im/wecom/config/runtime.js';
import type {
  WecomConnectionAction,
  WecomConnectionDto,
  WecomDiagnosticsDto,
  WecomNotRunningCause,
} from '../../im/wecom/contract/dashboard-dto.js';
import { describeWecomStopReason } from '../../im/wecom/contract/stop-reason.js';
import { wecomStateWriteFailureCause } from '../../im/wecom/contract/state-write-failure.js';

/** What a process inspection says about a recorded pid and birth identity. */
export type WecomProcessEvidence = 'exact' | 'stale' | 'unverifiable';

export interface WecomConnectionFacts {
  id: string;
  /** wecomFleetConfigHash of the configuration file as it is on disk now. */
  configHash: string;
  registry: 'ok' | 'unavailable';
  desired: { status: 'ok'; record?: WecomDesiredRecord } | { status: 'unavailable' };
  /** The fleet supervisor: live (identity verified), down, or unverifiable. */
  supervisor: 'live' | 'down' | 'unverifiable';
  /** This connection's fleet-state row; `process` is checked only for an online row. */
  member?: {
    row: Pick<FleetProcState, 'status' | 'pid' | 'restarts' | 'lastExitCode' | 'configHash' | 'processStart'>;
    process: WecomProcessEvidence;
  };
  /** The bot's runtime record (one per bot, written by whichever gateway holds its lock). */
  runtime?: { record: WecomRuntimeRecord; process: WecomProcessEvidence };
  /** Another configuration of the same bot has a gateway running. */
  sameBot?: 'running' | 'unverifiable';
  /** An older Dashboard's job file for this connection, and its gateway's evidence. */
  legacyJob?: WecomProcessEvidence;
  /** The holder of the bot's single-active lock; asked only when nothing else explains the state. */
  lock(): WecomProcessEvidence;
  /** The configuration's `secretEnv`: the NAME of its credential environment variable, if it uses one. */
  credentialEnv?: string;
  now: number;
}

export type WecomConnectionState = Pick<WecomConnectionDto,
  'gateway' | 'connection' | 'ownership' | 'canStart' | 'canStop' | 'canRestart' | 'desired' | 'stopReason'
  | 'credentialEnv' | 'notRunning' | 'restartRequired' | 'configApplyRetrying' | 'notice' | 'message' | 'diagnostics'
  | 'stateWriteFailure'>;

const DIAGNOSTIC_COUNTS = [
  'callbacks', 'normalized', 'invalid', 'beforeAuth', 'accepted', 'denied', 'duplicates', 'busy', 'commands', 'unsupported',
] as const;

/** The diagnostics a runtime record may carry, copied field by field (nothing else leaves the server). */
export function publicDiagnostics(value: unknown): WecomDiagnosticsDto | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of DIAGNOSTIC_COUNTS) {
    if (!Number.isSafeInteger(source[key]) || (source[key] as number) < 0) {
      return undefined;
    }
    output[key] = source[key];
  }
  for (const key of ['lastCallbackAt', 'lastAdmissionAt']) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) {
      output[key] = source[key];
    }
  }
  if (['accepted', 'denied', 'duplicate', 'busy', 'command', 'unsupported', 'halted'].includes(source.lastAdmission as string)) {
    output.lastAdmission = source.lastAdmission;
  }
  return output as unknown as WecomDiagnosticsDto;
}

/**
 * The stop reason a gateway recorded, as the state shows it. A missing credential
 * variable also names the variable (never its value), so the sentence says which
 * one to set.
 */
function stopReasonFields(
  reason: WecomDesiredStopReason,
  facts: WecomConnectionFacts,
): Pick<WecomConnectionState, 'stopReason' | 'credentialEnv'> {
  const credentialEnv = reason === 'credential_env_missing' ? facts.credentialEnv : undefined;
  return { stopReason: reason, ...(credentialEnv ? { credentialEnv } : {}) };
}

/**
 * A failed state write the gateway's record reports, with its cause. Only a
 * fresh record is evidence of the gateway as it is now: a caller passes one.
 */
function stateWriteFailureFields(record: WecomRuntimeRecord): Pick<WecomConnectionState, 'stateWriteFailure'> {
  const failure = wecomStateWriteFailure(record);
  return failure ? { stateWriteFailure: { cause: wecomStateWriteFailureCause(failure.code), ...failure } } : {};
}

function blocked(fields: Partial<WecomConnectionState> & Pick<WecomConnectionState, 'gateway' | 'ownership'>): WecomConnectionState {
  return { connection: 'unknown', canStart: false, canStop: false, canRestart: false, ...fields };
}

function notRunningOf(facts: WecomConnectionFacts): NonNullable<WecomConnectionState['notRunning']> {
  if (facts.supervisor === 'down') {
    return { cause: 'fleet_down' };
  }
  if (facts.supervisor === 'unverifiable') {
    return { cause: 'fleet_unknown' };
  }
  const row = facts.member?.row;
  if (!row) {
    return { cause: 'not_in_fleet' };
  }
  const causes: Record<FleetProcState['status'], WecomNotRunningCause> = {
    launching: 'restarting',
    errored: 'errored',
    stopped: 'stopped',
    // An online row whose process is gone: the supervisor has not seen the exit yet.
    online: 'exited',
  };
  return { cause: causes[row.status], exitCode: row.lastExitCode, restarts: row.restarts };
}

export function deriveWecomConnectionState(facts: WecomConnectionFacts): WecomConnectionState {
  if (facts.desired.status !== 'ok') {
    return blocked({
      gateway: 'unknown',
      ownership: 'unknown',
      notice: 'desired_state_unavailable',
      message: '企业微信连接的期望状态文件无法读取；在它恢复之前不能启动或停止（恢复方法见 `botmux wecom start` 的提示）。',
    });
  }
  if (facts.registry !== 'ok') {
    return blocked({
      gateway: 'unknown',
      ownership: 'unknown',
      notice: 'registry_unavailable',
      message: '企业微信连接登记表无法读取；在它恢复之前不能启动或停止。',
    });
  }
  const record = facts.desired.record;
  const recorded = record ? { desired: record.desired } : {};

  // An older Dashboard's gateway still running: `botmux restart` moves it into
  // the fleet. Until then neither the fleet nor this Dashboard may start a
  // second gateway for it. (A job whose gateway is gone is handled further down.)
  if (facts.legacyJob === 'exact' || facts.legacyJob === 'unverifiable') {
    return blocked({
      ...recorded,
      gateway: facts.legacyJob === 'exact' ? 'running' : 'unknown',
      ownership: facts.legacyJob === 'exact' ? 'external' : 'unknown',
      notice: 'legacy_gateway',
      message: '旧版 Dashboard 拉起的网关仍在运行；执行 `botmux restart` 完成迁移，之后由 fleet 管理。',
    });
  }

  const runtime = facts.runtime;
  // A runtime record proves a connection state only while the gateway keeps rewriting it (every 3 s).
  const fresh = runtime ? isFreshWecomRuntime(runtime.record, facts.now) : false;
  const member = facts.member;
  if (member && member.row.status === 'online' && member.process === 'exact') {
    const row = member.row;
    const ours = runtime !== undefined
      && runtime.process === 'exact'
      && runtime.record.configId === facts.id
      && runtime.record.pid === row.pid
      && (row.processStart === undefined || runtime.record.processStart === row.processStart)
      && runtime.record.phase !== 'stopped';
    // A gateway that manages its core applies most changes without a restart
    // and says which file it evaluated last (config/runtime.ts coreProfile):
    // its verdict on the file on disk decides. A file it has not looked at yet
    // shows nothing. Without that verdict (an external core, an older gateway,
    // a record that is not this member's or no longer fresh), any change since
    // the member started still means a restart.
    const evaluation = ours && fresh ? wecomCoreProfileEvaluation(runtime.record) : undefined;
    const restartRequired = evaluation
      ? evaluation.configHash === facts.configHash && evaluation.outcome === 'restart_required'
      : row.configHash !== undefined && row.configHash !== facts.configHash;
    const configApplyRetrying = evaluation?.configHash === facts.configHash && evaluation.outcome === 'retrying';
    // Only the member's own gateway, as its record shows it now, has stopped processing.
    const stateWriteFailure = ours && fresh ? stateWriteFailureFields(runtime.record) : {};
    const fleet = {
      ...recorded,
      ownership: 'fleet' as const,
      canStart: false,
      canStop: true,
      canRestart: true,
      ...(restartRequired ? { restartRequired: true } : {}),
      ...(configApplyRetrying ? { configApplyRetrying: true } : {}),
      ...stateWriteFailure,
    };
    if (record?.desired === 'stopped') {
      // Recorded as stopped, still running: a stop is under way (or did not
      // finish). Starting records `running` again; stopping asks once more.
      return {
        ...fleet,
        gateway: 'stopping',
        connection: 'unknown',
        canStart: true,
        notice: 'stop_pending',
        ...(record.reason ? stopReasonFields(record.reason, facts) : {}),
      };
    }
    if (!ours) {
      return { ...fleet, gateway: 'starting', connection: 'unknown', notice: 'no_connection_evidence' };
    }
    const phase = runtime.record.phase;
    const diagnostics = fresh ? publicDiagnostics(runtime.record.diagnostics) : undefined;
    return {
      ...fleet,
      gateway: phase === 'running' ? 'running' : phase === 'stopping' ? 'stopping' : 'starting',
      connection: fresh ? runtime.record.connection : 'unknown',
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
  if (member && member.row.status === 'online' && member.process === 'unverifiable') {
    return blocked({ ...recorded, gateway: 'unknown', ownership: 'unknown', message: '无法核验进程出生身份，已禁止启动/停止以免误操作。' });
  }

  if (facts.sameBot === 'running') {
    return blocked({
      ...recorded,
      gateway: 'running',
      ownership: 'external',
      // Recorded as running, this connection's own gateway keeps failing on the
      // bot's lock: it may still be stopped.
      canStop: record?.desired === 'running',
      message: '同一个 Bot 已由另一份配置运行；请在对应配置管理该实例。',
    });
  }
  if (facts.sameBot === 'unverifiable') {
    return blocked({ ...recorded, gateway: 'unknown', ownership: 'unknown', message: '另一份配置的同 Bot 实例身份无法核验。' });
  }
  if (runtime && runtime.record.configId === facts.id && runtime.record.phase !== 'stopped' && runtime.process !== 'stale') {
    if (runtime.process === 'unverifiable') {
      return blocked({ ...recorded, gateway: 'unknown', ownership: 'unknown', message: '无法核验进程出生身份，已禁止启动/停止以免误操作。' });
    }
    const diagnostics = fresh ? publicDiagnostics(runtime.record.diagnostics) : undefined;
    return blocked({
      ...recorded,
      ...(diagnostics ? { diagnostics } : {}),
      ...(fresh ? stateWriteFailureFields(runtime.record) : {}),
      gateway: runtime.record.phase === 'stopping' ? 'stopping' : 'running',
      ownership: 'external',
      connection: fresh ? runtime.record.connection : 'unknown',
      message: '终端或其他实例启动的网关；请在原终端停止，Dashboard 不接管。',
    });
  }
  const lock = facts.lock();
  if (lock === 'exact') {
    return blocked({
      ...recorded,
      gateway: 'running',
      ownership: 'external',
      message: '检测到原终端的单活网关；此版本未发布连接状态，认证状态未知。',
    });
  }
  if (lock === 'unverifiable') {
    return blocked({ ...recorded, gateway: 'unknown', ownership: 'unknown', message: '检测到单活锁但身份无法核验，请在原终端检查。' });
  }

  // An older Dashboard's job whose gateway is gone: the migration kept it because
  // it could not settle something (typically a core it could not prove was that
  // gateway's, possibly still holding the port). It matters only for a connection
  // nothing runs now — starting one could collide with that core — so it stands
  // in for the two "not running" answers below and nothing above: a fleet member,
  // a terminal gateway or a held lock shows as what it is.
  if (facts.legacyJob === 'stale') {
    return blocked({
      ...recorded,
      gateway: 'stopped',
      ownership: 'external',
      notice: 'legacy_leftover',
      message: '旧版 Dashboard 留下的网关记录还没迁移完（网关已不在，可能还留有它的 core）；执行 `botmux restart` 完成迁移。',
    });
  }

  if (record?.desired === 'running') {
    return {
      gateway: 'stopped',
      connection: 'unknown',
      ownership: 'fleet',
      canStart: true,
      canStop: true,
      canRestart: false,
      desired: 'running',
      notRunning: notRunningOf(facts),
    };
  }
  return {
    gateway: 'stopped',
    connection: 'unknown',
    ownership: 'none',
    canStart: true,
    canStop: false,
    canRestart: false,
    ...recorded,
    ...(record?.reason
      ? {
        ...stopReasonFields(record.reason, facts),
        message: describeWecomStopReason(record.reason, { credentialEnv: facts.credentialEnv }),
      }
      : {}),
  };
}

/**
 * The part of a state whose change ends the display of a failed action. A
 * failed state write counts by its time: the gateway stopping processing, or a
 * new gateway that processes again (a restart of a poisoned gateway can finish
 * without the gateway, ownership or desired state ever looking different),
 * makes an older failed action stale.
 */
export function wecomStateFingerprint(state: WecomConnectionState): string {
  return JSON.stringify([
    state.gateway,
    state.ownership,
    state.desired ?? null,
    state.stopReason ?? null,
    state.notRunning?.cause ?? null,
    state.notice ?? null,
    state.stateWriteFailure?.at ?? null,
  ]);
}

/** An action in progress replaces the state's verbs: the outcome arrives with a later list. */
export function withWecomOperation(
  state: WecomConnectionState,
  operation: { action: WecomConnectionAction; startedAt: number } | undefined,
): WecomConnectionState & Pick<WecomConnectionDto, 'operation'> {
  if (!operation) {
    return state;
  }
  return {
    ...state,
    gateway: operation.action === 'stop' ? 'stopping' : 'starting',
    canStart: false,
    canStop: false,
    canRestart: false,
    operation: { action: operation.action, startedAt: operation.startedAt },
  };
}
