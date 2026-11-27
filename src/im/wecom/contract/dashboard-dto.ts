import type { WecomDesiredStopReason } from '../config/fleet-desired-state.js';
import type { WecomStateWriteFailureCause } from './state-write-failure.js';

export interface WecomDiagnosticsDto {
  callbacks: number; normalized: number; invalid: number; beforeAuth: number;
  accepted: number; denied: number; duplicates: number; busy: number; commands: number; unsupported: number;
  lastCallbackAt?: number; lastAdmissionAt?: number; lastAdmission?: 'accepted'|'denied'|'duplicate'|'busy'|'command'|'unsupported'|'halted';
}

/** A start / stop / restart the Dashboard runs through `botmux wecom <action> <id> --json`. */
export type WecomConnectionAction = 'start' | 'stop' | 'restart';

/**
 * Why a connection recorded as `running` has no gateway running right now:
 *  - fleet_down: no fleet supervisor is running (it starts on `botmux start`);
 *  - fleet_unknown: the supervisor's process identity cannot be verified;
 *  - not_in_fleet: the supervisor has not taken the connection on yet;
 *  - restarting: the gateway exited and the supervisor restarts it after a backoff;
 *  - errored: the gateway exited with the no-restart code and is not retried;
 *  - stopped: the supervisor stopped the member (a restart that did not finish);
 *  - exited: the member's process is gone and the supervisor has not noticed yet.
 */
export type WecomNotRunningCause =
  | 'fleet_down' | 'fleet_unknown' | 'not_in_fleet' | 'restarting' | 'errored' | 'stopped' | 'exited';

/**
 * A condition the Dashboard explains next to the state (the frontend words it,
 * by code):
 *  - legacy_gateway: a gateway an older Dashboard started is still running; the
 *    next `botmux restart` moves it into the fleet;
 *  - legacy_leftover: an older Dashboard's record of a gateway is still there
 *    (the gateway itself is gone); the next `botmux restart` finishes the move;
 *  - desired_state_unavailable / registry_unavailable: that file cannot be read;
 *  - stop_pending: recorded as stopped while the fleet still runs it;
 *  - no_connection_evidence: the fleet runs the gateway, which has not reported
 *    a connection yet.
 */
export type WecomConnectionNotice =
  | 'legacy_gateway' | 'legacy_leftover' | 'desired_state_unavailable' | 'registry_unavailable'
  | 'stop_pending' | 'no_connection_evidence';

/** Public host-admin DTO. Never serialize config objects or process records. */
export interface WecomConnectionDto {
  id: string;
  label: string;
  botIdHint: string;
  allowedUserCount: number;
  coreMode: 'managed' | 'external';
  configuration: 'ready' | 'invalid';
  gateway: 'stopped' | 'starting' | 'running' | 'stopping' | 'unknown';
  connection: 'unknown' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  /**
   * fleet: the fleet supervisor runs (or is to run) this connection and the
   * Dashboard starts / stops it through `botmux wecom`; none: nothing runs it;
   * external: a gateway outside the fleet (a terminal, another configuration of
   * the same bot, an older Dashboard's gateway); unknown: cannot be verified.
   */
  ownership: 'fleet' | 'external' | 'none' | 'unknown';
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  /** The recorded desired state; absent when nothing is recorded or the file is unreadable. */
  desired?: 'running' | 'stopped';
  /** The connection's own gateway stopped it, for this reason (desired `stopped`). */
  stopReason?: WecomDesiredStopReason;
  /**
   * With `stopReason: 'credential_env_missing'`: the NAME of the credential
   * environment variable the configuration refers to. Never its value.
   */
  credentialEnv?: string;
  /** Desired `running`, but no gateway is running. */
  notRunning?: { cause: WecomNotRunningCause; exitCode?: number | null; restarts?: number };
  /**
   * The configuration on disk has a change the running gateway applies only
   * after a restart (for an older gateway or an external core: any change
   * since it started).
   */
  restartRequired?: boolean;
  /**
   * The running gateway could not hand the core settings of the configuration
   * on disk to its core yet (invalid, or the core did not take them): the core
   * keeps its current settings and the gateway retries.
   */
  configApplyRetrying?: boolean;
  /**
   * The gateway this row shows (by its fresh runtime record) failed to write its
   * state document: it stays connected but processes no message until it is
   * restarted. `cause` comes from the error code (contract/state-write-failure.ts),
   * `directory` is the state directory.
   */
  stateWriteFailure?: { cause: WecomStateWriteFailureCause; code?: string; at: number; directory: string };
  notice?: WecomConnectionNotice;
  /** An action this Dashboard is running for the connection. */
  operation?: { action: WecomConnectionAction; startedAt: number };
  /** The last action that failed; kept until the next action or a change of state. */
  lastFailure?: { action: WecomConnectionAction; reason: string; message: string; at: number };
  message?: string;
  diagnostics?: WecomDiagnosticsDto;
}

export type WecomAdmissionOutcome = 'accepted' | 'denied' | 'duplicate' | 'busy' | 'command' | 'unsupported' | 'halted';
export interface WecomAdmissionEvent {
    outcome: WecomAdmissionOutcome;
    chatType: 'single' | 'group';
}

export interface WecomOnboardingSnapshot {
  id: string;
  platform: 'wecom';
  createdAt: number;
  updatedAt: number;
  status: 'starting' | 'waiting_for_scan' | 'verifying' | 'needs_pairing' | 'starting_bot' | 'completed' | 'failed' | 'cancelled';
  appName?: string;
  cliId: string;
  workingDir: string;
  qrUrl?: string;
  qrDataUrl?: string;
  expireAt?: number;
  pairingCode?: string;
  externalBotCreated: boolean;
  saved: boolean;
  retryable: boolean;
  connectionId?: string;
  liveStarted?: boolean;
  error?: string;
  message?: string;
  resumeUntil: number;
}
