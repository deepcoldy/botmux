/**
 * How the Dashboard shows a WeCom connection run by the fleet: one case per
 * distinguishable situation (desired state × member row × runtime record ×
 * the evidence that blocks the Dashboard from acting). Pure: every fact is
 * injected.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveWecomConnectionState,
  wecomStateFingerprint,
  withWecomOperation,
  type WecomConnectionFacts,
} from '../src/dashboard/wecom/connection-state.js';
import { describeWecomStopReason } from '../src/im/wecom/contract/stop-reason.js';
import type { WecomRuntimeRecord } from '../src/im/wecom/config/runtime.js';

const ID = 'a'.repeat(64);
const NOW = 100_000;

function facts(overrides: Partial<WecomConnectionFacts> = {}): WecomConnectionFacts {
  return {
    id: ID,
    configHash: 'hash-on-disk',
    registry: 'ok',
    desired: { status: 'ok' },
    supervisor: 'live',
    lock: () => 'stale',
    now: NOW,
    ...overrides,
  };
}

const desired = (state: 'running' | 'stopped', reason?: 'replaced' | 'authentication_failed' | 'instance_busy' | 'credential_env_missing') => ({
  status: 'ok' as const,
  record: { desired: state, updatedAt: '2026-11-18T00:00:00.000Z', ...(reason ? { reason } : {}) },
});

const member = (row: Partial<NonNullable<WecomConnectionFacts['member']>['row']> = {}, process: 'exact' | 'stale' | 'unverifiable' = 'exact') => ({
  row: { status: 'online' as const, pid: 300, restarts: 0, lastExitCode: null, configHash: 'hash-on-disk', processStart: 'birth-300', ...row },
  process,
});

const diagnostics = {
  callbacks: 3, normalized: 3, invalid: 0, beforeAuth: 0, accepted: 2, denied: 1, duplicates: 0, busy: 0, commands: 0, unsupported: 0,
};

const runtime = (record: Partial<WecomRuntimeRecord> = {}, process: 'exact' | 'stale' | 'unverifiable' = 'exact') => ({
  record: {
    version: 1 as const,
    configId: ID,
    pid: 300,
    processStart: 'birth-300',
    instanceId: 'instance',
    connection: 'connected' as const,
    phase: 'running' as const,
    updatedAt: NOW - 1_000,
    diagnostics,
    ...record,
  },
  process,
});

describe('a connection the fleet runs', () => {
  it('is running, with the connection state and diagnostics of the runtime record that belongs to the member', () => {
    const state = deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime() }));
    expect(state).toMatchObject({
      gateway: 'running',
      connection: 'connected',
      ownership: 'fleet',
      desired: 'running',
      canStart: false,
      canStop: true,
      canRestart: true,
      diagnostics,
    });
    expect(state.notice).toBeUndefined();
    expect(state.restartRequired).toBeUndefined();
  });

  it('is starting while no runtime record proves a connection for this member', () => {
    expect(deriveWecomConnectionState(facts({ desired: desired('running'), member: member() }))).toMatchObject({
      gateway: 'starting', connection: 'unknown', ownership: 'fleet', notice: 'no_connection_evidence', canStop: true,
    });
  });

  it('does not take a runtime record of another process (other pid, or same pid of another birth) as the member\'s', () => {
    for (const record of [{ pid: 301 }, { processStart: 'birth-of-a-recycled-pid' }]) {
      const state = deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime(record) }));
      expect(state).toMatchObject({ gateway: 'starting', connection: 'unknown', notice: 'no_connection_evidence' });
      expect(state.diagnostics).toBeUndefined();
    }
  });

  it('does not take another configuration\'s runtime record of the same bot as the member\'s', () => {
    const state = deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime({ configId: 'b'.repeat(64) }) }));
    expect(state).toMatchObject({ gateway: 'starting', notice: 'no_connection_evidence' });
  });

  it('keeps showing it running from an old runtime record, without claiming a connection state or diagnostics', () => {
    const state = deriveWecomConnectionState(facts({
      desired: desired('running'), member: member(), runtime: runtime({ updatedAt: NOW - 60_000 }),
    }));
    expect(state).toMatchObject({ gateway: 'running', connection: 'unknown' });
    expect(state.diagnostics).toBeUndefined();
  });

  it('says a restart is needed when the configuration changed after the member started', () => {
    const changed = deriveWecomConnectionState(facts({ desired: desired('running'), member: member({ configHash: 'hash-at-start' }), runtime: runtime() }));
    expect(changed).toMatchObject({ gateway: 'running', restartRequired: true });
    const unknown = deriveWecomConnectionState(facts({ desired: desired('running'), member: member({ configHash: undefined }), runtime: runtime() }));
    expect(unknown.restartRequired).toBeUndefined();
  });

  it('is stopping, and may be started again or stopped again, when it is recorded as stopped but still runs', () => {
    expect(deriveWecomConnectionState(facts({ desired: desired('stopped'), member: member(), runtime: runtime() }))).toMatchObject({
      gateway: 'stopping', ownership: 'fleet', notice: 'stop_pending', desired: 'stopped', canStart: true, canStop: true,
    });
  });

  it('is unknown, and cannot be acted on, when the member\'s process identity cannot be verified', () => {
    expect(deriveWecomConnectionState(facts({ desired: desired('running'), member: member({}, 'unverifiable') }))).toMatchObject({
      gateway: 'unknown', ownership: 'unknown', canStart: false, canStop: false, canRestart: false,
    });
  });
});

describe('a configuration change of a running connection whose gateway reports its verdict', () => {
  const DISK = 'd'.repeat(64);
  const OTHER = 'e'.repeat(64);
  // The member started from an older file: without a verdict that alone means a restart.
  const running = (coreProfile?: WecomRuntimeRecord['coreProfile'], record: Partial<WecomRuntimeRecord> = {}) => deriveWecomConnectionState(facts({
    configHash: DISK,
    desired: desired('running'),
    member: member({ configHash: 'f'.repeat(64) }),
    runtime: runtime({ ...(coreProfile ? { coreProfile } : {}), ...record }),
  }));

  it('needs no restart when the gateway applied the file on disk', () => {
    const state = running({ configHash: DISK, outcome: 'applied' });
    expect(state.gateway).toBe('running');
    expect(state.restartRequired).toBeUndefined();
    expect(state.configApplyRetrying).toBeUndefined();
  });

  it('needs a restart when the gateway says the file on disk has a restart-only change', () => {
    expect(running({ configHash: DISK, outcome: 'restart_required' })).toMatchObject({ restartRequired: true });
    expect(running({ configHash: DISK, outcome: 'restart_required' }).configApplyRetrying).toBeUndefined();
  });

  it('says the new settings are not in effect yet while the gateway retries handing them over', () => {
    const state = running({ configHash: DISK, outcome: 'retrying' });
    expect(state.configApplyRetrying).toBe(true);
    expect(state.restartRequired).toBeUndefined();
  });

  it('says nothing about a file the gateway has not evaluated yet', () => {
    for (const outcome of ['applied', 'restart_required', 'retrying'] as const) {
      const state = running({ configHash: OTHER, outcome });
      expect(state.restartRequired, outcome).toBeUndefined();
      expect(state.configApplyRetrying, outcome).toBeUndefined();
    }
  });

  it('falls back to the start-time comparison for a record without a verdict, a stale record or another process\'s record', () => {
    expect(running()).toMatchObject({ restartRequired: true });
    expect(running({ configHash: DISK, outcome: 'applied' }, { updatedAt: NOW - 60_000 })).toMatchObject({ restartRequired: true });
    const foreign = running({ configHash: DISK, outcome: 'applied' }, { pid: 301 });
    expect(foreign).toMatchObject({ gateway: 'starting', restartRequired: true });
    expect(foreign.configApplyRetrying).toBeUndefined();
  });

  it('ignores a malformed verdict', () => {
    expect(running({ configHash: DISK, outcome: 'nonsense' } as never)).toMatchObject({ restartRequired: true });
  });
});

describe('a connection recorded as running that is not running', () => {
  const notRunning = (overrides: Partial<WecomConnectionFacts>) =>
    deriveWecomConnectionState(facts({ desired: desired('running'), ...overrides }));

  it('can be started again or stopped, and says why it is not running', () => {
    const state = notRunning({ supervisor: 'down' });
    expect(state).toMatchObject({
      gateway: 'stopped', ownership: 'fleet', desired: 'running', canStart: true, canStop: true, canRestart: false,
      notRunning: { cause: 'fleet_down' },
    });
  });

  it('tells the fleet being down, unverifiable, or not having taken the connection on yet apart', () => {
    expect(notRunning({ supervisor: 'down', member: member({ status: 'errored' }, 'stale') }).notRunning).toEqual({ cause: 'fleet_down' });
    expect(notRunning({ supervisor: 'unverifiable' }).notRunning).toEqual({ cause: 'fleet_unknown' });
    expect(notRunning({ supervisor: 'live' }).notRunning).toEqual({ cause: 'not_in_fleet' });
  });

  it('carries the member\'s exit code and restart count for a backoff, an errored member, a stopped member and a dead pid', () => {
    expect(notRunning({ member: member({ status: 'launching', pid: 0, restarts: 3, lastExitCode: 1 }, 'stale') }).notRunning)
      .toEqual({ cause: 'restarting', exitCode: 1, restarts: 3 });
    expect(notRunning({ member: member({ status: 'errored', pid: 0, restarts: 0, lastExitCode: 78 }, 'stale') }).notRunning)
      .toEqual({ cause: 'errored', exitCode: 78, restarts: 0 });
    expect(notRunning({ member: member({ status: 'stopped', pid: 0, lastExitCode: 0 }, 'stale') }).notRunning)
      .toEqual({ cause: 'stopped', exitCode: 0, restarts: 0 });
    expect(notRunning({ member: member({ status: 'online' }, 'stale') }).notRunning)
      .toEqual({ cause: 'exited', exitCode: null, restarts: 0 });
  });
});

describe('a stopped connection', () => {
  it('stopped by its own gateway shows the reason, in the words the CLI uses, and can be started', () => {
    const state = deriveWecomConnectionState(facts({ desired: desired('stopped', 'replaced') }));
    expect(state).toMatchObject({
      gateway: 'stopped', ownership: 'none', desired: 'stopped', stopReason: 'replaced', canStart: true, canStop: false,
    });
    expect(state.message).toBe(describeWecomStopReason('replaced'));
  });

  it('stopped for a credential variable missing from the fleet\'s environment names the variable and can be started', () => {
    const state = deriveWecomConnectionState(facts({ desired: desired('stopped', 'credential_env_missing'), credentialEnv: 'WECOM_BOT_SECRET' }));
    expect(state).toMatchObject({
      gateway: 'stopped', ownership: 'none', desired: 'stopped', stopReason: 'credential_env_missing',
      credentialEnv: 'WECOM_BOT_SECRET', canStart: true,
    });
    expect(state.message).toBe(describeWecomStopReason('credential_env_missing', { credentialEnv: 'WECOM_BOT_SECRET' }));
    expect(state.message).toContain('WECOM_BOT_SECRET');
    // The variable's name belongs to that reason only.
    const replaced = deriveWecomConnectionState(facts({ desired: desired('stopped', 'replaced'), credentialEnv: 'WECOM_BOT_SECRET' }));
    expect(replaced.credentialEnv).toBeUndefined();
    expect(replaced.message).not.toContain('WECOM_BOT_SECRET');
  });

  it('stopped by a person, or never recorded, is simply stopped', () => {
    const byPerson = deriveWecomConnectionState(facts({ desired: desired('stopped') }));
    expect(byPerson).toMatchObject({ gateway: 'stopped', ownership: 'none', desired: 'stopped', canStart: true });
    expect(byPerson.stopReason).toBeUndefined();
    expect(byPerson.message).toBeUndefined();
    const unrecorded = deriveWecomConnectionState(facts());
    expect(unrecorded).toMatchObject({ gateway: 'stopped', ownership: 'none', canStart: true, canStop: false });
    expect(unrecorded.desired).toBeUndefined();
  });
});

describe('what keeps the Dashboard from acting', () => {
  it('a gateway outside the fleet for this configuration (a terminal) is external and is not taken over', () => {
    const state = deriveWecomConnectionState(facts({ desired: desired('stopped'), runtime: runtime() }));
    expect(state).toMatchObject({ gateway: 'running', ownership: 'external', connection: 'connected', canStart: false, canStop: false });
  });

  it('an older Dashboard\'s gateway still running blocks every action until `botmux restart` migrates it, even next to a fleet member', () => {
    for (const extra of [{}, { member: member(), runtime: runtime() }]) {
      expect(deriveWecomConnectionState(facts({ desired: desired('running'), legacyJob: 'exact', ...extra }))).toMatchObject({
        gateway: 'running', ownership: 'external', notice: 'legacy_gateway', canStart: false, canStop: false, canRestart: false,
      });
    }
    expect(deriveWecomConnectionState(facts({ legacyJob: 'unverifiable' }))).toMatchObject({ gateway: 'unknown', notice: 'legacy_gateway', canStart: false });
  });

  it('an older Dashboard\'s record whose gateway is gone still blocks starting until the migration finishes', () => {
    expect(deriveWecomConnectionState(facts({ legacyJob: 'stale' }))).toMatchObject({
      gateway: 'stopped', notice: 'legacy_leftover', canStart: false, canStop: false,
    });
  });

  it('an unreadable desired-state file or registry leaves the state unknown and nothing startable or stoppable', () => {
    expect(deriveWecomConnectionState(facts({ desired: { status: 'unavailable' }, member: member(), runtime: runtime() }))).toMatchObject({
      gateway: 'unknown', ownership: 'unknown', notice: 'desired_state_unavailable', canStart: false, canStop: false, canRestart: false,
    });
    expect(deriveWecomConnectionState(facts({ registry: 'unavailable', desired: desired('running') }))).toMatchObject({
      gateway: 'unknown', notice: 'registry_unavailable', canStart: false, canStop: false,
    });
  });

  it('the same bot running through another configuration keeps this one from starting; a running record may still be stopped', () => {
    expect(deriveWecomConnectionState(facts({ sameBot: 'running' }))).toMatchObject({ ownership: 'external', canStart: false, canStop: false });
    expect(deriveWecomConnectionState(facts({ sameBot: 'running', desired: desired('running') }))).toMatchObject({ canStart: false, canStop: true });
    expect(deriveWecomConnectionState(facts({ sameBot: 'unverifiable' }))).toMatchObject({ gateway: 'unknown', canStart: false });
  });

  it('a held single-active lock (a gateway from before runtime records) is external; an unverifiable one is unknown', () => {
    expect(deriveWecomConnectionState(facts({ lock: () => 'exact' }))).toMatchObject({ gateway: 'running', ownership: 'external', canStart: false });
    expect(deriveWecomConnectionState(facts({ lock: () => 'unverifiable' }))).toMatchObject({ gateway: 'unknown', canStart: false });
  });

  it('an unverifiable runtime record of this configuration is unknown', () => {
    expect(deriveWecomConnectionState(facts({ runtime: runtime({}, 'unverifiable') }))).toMatchObject({ gateway: 'unknown', canStart: false, canStop: false });
  });
});

describe('an action in progress and the end of a failure', () => {
  it('replaces the verbs while an action runs and says which one', () => {
    const base = deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime() }));
    expect(withWecomOperation(base, { action: 'stop', startedAt: 5 })).toMatchObject({
      gateway: 'stopping', canStart: false, canStop: false, canRestart: false, operation: { action: 'stop', startedAt: 5 },
    });
    expect(withWecomOperation(base, { action: 'restart', startedAt: 5 })).toMatchObject({ gateway: 'starting', operation: { action: 'restart' } });
    expect(withWecomOperation(base, undefined)).toBe(base);
  });

  it('a state change ends a failure\'s display; new diagnostics or a new connection state do not', () => {
    const errored = deriveWecomConnectionState(facts({ desired: desired('running'), member: member({ status: 'errored', pid: 0, lastExitCode: 78 }, 'stale') }));
    const restarting = deriveWecomConnectionState(facts({ desired: desired('running'), member: member({ status: 'launching', pid: 0 }, 'stale') }));
    expect(wecomStateFingerprint(errored)).not.toBe(wecomStateFingerprint(restarting));
    const connected = deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime() }));
    const reconnecting = deriveWecomConnectionState(facts({
      desired: desired('running'), member: member(), runtime: runtime({ connection: 'reconnecting', diagnostics: { ...diagnostics, callbacks: 9 } }),
    }));
    expect(wecomStateFingerprint(connected)).toBe(wecomStateFingerprint(reconnecting));
  });
});

describe('evidence that is not taken at face value', () => {
  it('a runtime record stamped in the future proves no connection state', () => {
    const state = deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime({ updatedAt: NOW + 5_000 }) }));
    expect(state).toMatchObject({ gateway: 'running', connection: 'unknown' });
    expect(state.diagnostics).toBeUndefined();
  });

  it('the member\'s own record in the stopped phase is not its current state', () => {
    const state = deriveWecomConnectionState(facts({
      desired: desired('running'), member: member(), runtime: runtime({ phase: 'stopped', connection: 'disconnected' }),
    }));
    expect(state).toMatchObject({ gateway: 'starting', connection: 'unknown', notice: 'no_connection_evidence' });
    expect(state.diagnostics).toBeUndefined();
  });

  it('a member whose record is in the stopping phase shows as stopping', () => {
    expect(deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: runtime({ phase: 'stopping' }) })))
      .toMatchObject({ gateway: 'stopping', ownership: 'fleet' });
  });

  it('a stop under way keeps showing why the gateway stopped itself', () => {
    expect(deriveWecomConnectionState(facts({ desired: desired('stopped', 'authentication_failed'), member: member(), runtime: runtime() })))
      .toMatchObject({ gateway: 'stopping', notice: 'stop_pending', stopReason: 'authentication_failed' });
  });

  it('a runtime record whose process is gone is not a gateway running in a terminal', () => {
    expect(deriveWecomConnectionState(facts({ desired: desired('stopped'), runtime: runtime({}, 'stale') }))).toMatchObject({
      gateway: 'stopped', ownership: 'none', canStart: true,
    });
  });
});

describe('a gateway that failed to write its state document', () => {
  const DIRECTORY = '/srv/wecom/state';
  const failure = { code: 'ENOSPC', at: NOW - 5_000, directory: DIRECTORY };
  const withFailure = (value: unknown = failure, record: Partial<WecomRuntimeRecord> = {}, process: 'exact' | 'stale' | 'unverifiable' = 'exact') =>
    runtime({ stateWriteFailure: value as WecomRuntimeRecord['stateWriteFailure'], ...record }, process);
  const fleetRun = (record: ReturnType<typeof runtime>) =>
    deriveWecomConnectionState(facts({ desired: desired('running'), member: member(), runtime: record }));

  // Mutation: dropping either the "this member's record" or the "fresh" condition turns this red.
  it('shows the failure, with its cause, from the fresh record of the fleet member\'s own gateway, and nothing else changes', () => {
    const state = fleetRun(withFailure());
    expect(state.stateWriteFailure).toEqual({ cause: 'disk_full', code: 'ENOSPC', at: failure.at, directory: DIRECTORY });
    const { stateWriteFailure: _shown, ...rest } = state;
    expect(rest).toEqual(fleetRun(runtime()));
  });

  it('gives each code its own cause, and a record without a code an unknown one', () => {
    expect(fleetRun(withFailure({ ...failure, code: 'EACCES' })).stateWriteFailure?.cause).toBe('permission_denied');
    expect(fleetRun(withFailure({ ...failure, code: 'EXDEV' })).stateWriteFailure).toMatchObject({ cause: 'other', code: 'EXDEV' });
    expect(fleetRun(withFailure({ at: failure.at, directory: DIRECTORY })).stateWriteFailure).toEqual({ cause: 'unknown', at: failure.at, directory: DIRECTORY });
  });

  it('shows nothing from a record that is not the member\'s, or no longer fresh', () => {
    for (const record of [{ pid: 301 }, { processStart: 'birth-of-a-recycled-pid' }, { configId: 'b'.repeat(64) }]) {
      const state = fleetRun(withFailure(failure, record));
      expect(state.notice, JSON.stringify(record)).toBe('no_connection_evidence');
      expect(state.stateWriteFailure, JSON.stringify(record)).toBeUndefined();
    }
    const stale = fleetRun(withFailure(failure, { updatedAt: NOW - 60_000 }));
    expect(stale.gateway).toBe('running');
    expect(stale.stateWriteFailure).toBeUndefined();
  });

  it('shows it for a gateway started in a terminal while its record is fresh', () => {
    const external = (record: ReturnType<typeof runtime>) => deriveWecomConnectionState(facts({ desired: desired('stopped'), runtime: record }));
    expect(external(withFailure())).toMatchObject({
      ownership: 'external', gateway: 'running', connection: 'connected',
      stateWriteFailure: { cause: 'disk_full', code: 'ENOSPC', at: failure.at, directory: DIRECTORY },
    });
    expect(external(withFailure(failure, { updatedAt: NOW - 60_000 })).stateWriteFailure).toBeUndefined();
  });

  it('shows it nowhere else: not for a gateway that is gone or unverifiable, nor next to another configuration\'s gateway', () => {
    const states = [
      facts({ desired: desired('stopped'), runtime: withFailure(failure, {}, 'stale') }),
      facts({ desired: desired('stopped'), runtime: withFailure(failure, {}, 'unverifiable') }),
      facts({ sameBot: 'running', runtime: withFailure() }),
      facts({ desired: desired('running'), supervisor: 'down', runtime: withFailure(failure, { phase: 'stopped' }) }),
      facts({ desired: desired('running'), member: member({}, 'unverifiable'), runtime: withFailure() }),
    ].map(deriveWecomConnectionState);
    for (const state of states) expect(state.stateWriteFailure, JSON.stringify(state)).toBeUndefined();
  });

  // Mutation: letting a relative directory or a malformed code through turns this red.
  it('takes only a well-formed failure, field by field, and keeps nothing else the record carries', () => {
    const rejected = [
      { ...failure, directory: 'relative/state' },
      { ...failure, directory: `/${'d'.repeat(1024)}` },
      { ...failure, directory: '/srv/wecom/\nstate' },
      { ...failure, directory: '/srv/wecom/\u009bstate' },
      { ...failure, directory: 42 },
      { ...failure, at: 'yesterday' },
      { ...failure, at: Number.NaN },
      { ...failure, at: Number.POSITIVE_INFINITY },
      { code: 'ENOSPC', directory: DIRECTORY },
      'ENOSPC',
      null,
    ];
    for (const value of rejected) {
      expect(fleetRun(withFailure(value)).stateWriteFailure, JSON.stringify(value)).toBeUndefined();
    }
    // A malformed code alone is dropped; the failure still shows, its cause unknown.
    for (const code of ['enospc', 'ENO SPC', 'E'.repeat(33), 28]) {
      expect(fleetRun(withFailure({ ...failure, code })).stateWriteFailure, String(code))
        .toEqual({ cause: 'unknown', at: failure.at, directory: DIRECTORY });
    }
    const extra = fleetRun(withFailure({ ...failure, message: 'private-marker', nested: { secret: 'private-marker' } }));
    expect(extra.stateWriteFailure).toEqual({ cause: 'disk_full', code: 'ENOSPC', at: failure.at, directory: DIRECTORY });
    expect(JSON.stringify(extra)).not.toContain('private-marker');
  });

  it('ends the display of a failed action when the gateway stops processing, and again when a gateway processes again', () => {
    const healthy = fleetRun(runtime());
    const failed = fleetRun(withFailure());
    expect(wecomStateFingerprint(failed)).not.toBe(wecomStateFingerprint(healthy));
    // Another gateway generation failing later is another state too.
    expect(wecomStateFingerprint(fleetRun(withFailure({ ...failure, at: failure.at + 1 })))).not.toBe(wecomStateFingerprint(failed));
  });
});

describe('a change of recorded intent alone', () => {
  // A failed action recorded while nothing was recorded; then someone stops the
  // connection elsewhere (`botmux wecom stop`). Nothing runs either way, so only
  // `desired` changes — and the old failure no longer describes the connection.
  it('ends the display of a failed action', () => {
    const unrecorded = deriveWecomConnectionState(facts());
    const stoppedByPerson = deriveWecomConnectionState(facts({ desired: desired('stopped') }));
    expect(wecomStateFingerprint(unrecorded)).not.toBe(wecomStateFingerprint(stoppedByPerson));
  });
});

describe('an older Dashboard record whose gateway is gone', () => {
  const stale = { legacyJob: 'stale' as const };

  it('does not hide a fleet member that runs the connection, nor its buttons', () => {
    expect(deriveWecomConnectionState(facts({ ...stale, desired: desired('running'), member: member(), runtime: runtime() }))).toMatchObject({
      gateway: 'running', ownership: 'fleet', canStop: true, canRestart: true,
    });
  });

  it('does not hide a gateway running in a terminal', () => {
    expect(deriveWecomConnectionState(facts({ ...stale, runtime: runtime() }))).toMatchObject({ gateway: 'running', ownership: 'external' });
  });

  it('does not hide a gateway holding the bot\'s single-active lock', () => {
    expect(deriveWecomConnectionState(facts({ ...stale, lock: () => 'exact' }))).toMatchObject({ gateway: 'running', ownership: 'external' });
  });

  it('stands in for "set to run but not running" as well as "stopped"', () => {
    const state = deriveWecomConnectionState(facts({ ...stale, desired: desired('running'), supervisor: 'down' }));
    expect(state).toMatchObject({ notice: 'legacy_leftover', canStart: false, canStop: false });
    expect(state.notRunning).toBeUndefined();
  });
});
