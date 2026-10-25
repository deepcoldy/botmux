/**
 * F3: the worker's actual spawn decision is the single source of truth for
 * the identity storage model. The daemon consumes the private
 * session_identity_decision report and must NOT re-derive sandbox/loopback
 * facts from the frozen session config or its own BOTMUX_SANDBOX environment.
 *
 * These cases pin the split the old dual-predicate design got wrong:
 *  - frozen `sandbox:true, sandboxNetwork:false` with the worker reporting
 *    `proven` (BOTMUX_SANDBOX=0 forced the spawn off) → daemon follows proven;
 *  - frozen `sandbox:off` with the worker reporting `single` (env=1 engaged a
 *    net-isolated sandbox) → daemon follows single;
 *  - no report yet → fail-closed 'single' and the proven content route stays
 *    shut (covered in ipc-current-execution-route.test.ts);
 *  - a structurally impossible proven report (adopt session after a config
 *    change) → conflict, 'single', and publication is flagged withheld.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as botRegistry from '../src/bot-registry.js';
import {
  identityDecisionConflict,
  identityDecisionTurnIsLive,
  identityStorageModelForDaemonSession,
  recordWorkerIdentityDecision,
} from '../src/core/worker-pool.js';
function sessionFixture(extra: Record<string, unknown> = {}): any {
  return {
    session: {
      sessionId: 'decision-session',
      status: 'active',
      backendType: 'pty',
      sandbox: true,
      sandboxNetwork: false,
      ...('sessionExtra' in extra ? extra.sessionExtra as object : {}),
    },
    larkAppId: 'cli_decision',
    chatId: 'oc_decision',
    worker: { killed: false },
    workerGeneration: 9,
    ...extra,
  };
}

const worker = { pid: 4242 } as any;

beforeEach(() => {
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({
    config: { larkAppId: 'cli_decision', apiOnly: false, backendType: 'pty' },
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identityStorageModelForDaemonSession follows the worker report', () => {
  it('defaults to single before any report regardless of frozen sandbox fields', () => {
    const ds = sessionFixture();
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
  });

  it('follows a proven report even when the frozen config says net-isolated sandbox', () => {
    // Cell 1 of the matrix: BOTMUX_SANDBOX=0 disengaged the worker's sandbox,
    // so the spawn reached loopback and rendered proven. The frozen config
    // (sandbox:true, sandboxNetwork:false) used to make the daemon publish
    // single files — the fail-open split. It must now follow the report.
    const ds = sessionFixture();
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(identityStorageModelForDaemonSession(ds)).toBe('proven');
    expect(identityDecisionConflict(ds)).toBeUndefined();
    expect(ds.reportedIdentityModel).toMatchObject({ workerPid: 4242, workerGeneration: 9 });
  });

  it('keeps following proven with BOTMUX_SANDBOX set in the daemon environment', () => {
    // Fake-fix counterexample ①: a daemon that reads process.env.BOTMUX_SANDBOX
    // would flip its own answer. The daemon never reads it for this decision.
    vi.stubEnv('BOTMUX_SANDBOX', '0');
    try {
      const ds = sessionFixture();
      recordWorkerIdentityDecision(ds, worker, 9, {
        model: 'proven', sandboxEngaged: false, loopbackShared: true,
      });
      expect(identityStorageModelForDaemonSession(ds)).toBe('proven');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('follows a single report even when the frozen config says sandbox off', () => {
    // Cell 2: BOTMUX_SANDBOX=1 engaged a network-isolated sandbox despite the
    // frozen off config; the worker rendered single and reports it.
    const ds = sessionFixture({
      sessionExtra: { sandbox: false, sandboxNetwork: false },
    });
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'single', sandboxEngaged: true, loopbackShared: false,
    });
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
    expect(identityDecisionConflict(ds)).toBeUndefined();
  });

  it('tracks the latest report across model switches', () => {
    const ds = sessionFixture({ sessionExtra: { sandbox: false } });
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'proven', sandboxEngaged: true, loopbackShared: true,
    });
    expect(identityStorageModelForDaemonSession(ds)).toBe('proven');
    // Restart generation with the env switch flipped: the new worker reports
    // single; nothing may keep the daemon on the stale proven answer.
    recordWorkerIdentityDecision(ds, worker, 10, {
      model: 'single', sandboxEngaged: true, loopbackShared: false,
    });
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
    expect(ds.reportedIdentityModel.workerGeneration).toBe(10);
  });
});

describe('fail-closed on impossible or malformed reports', () => {
  it('refuses a proven report for a structurally single (adopt) session', () => {
    const ds = sessionFixture({ sessionExtra: { adoptedFrom: 'pane-xyz' } });
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(identityDecisionConflict(ds)).toMatch(/structurally cannot run proven/);
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
    expect(ds.reportedIdentityModel.conflict).toBeTruthy();
  });

  it('refuses a proven report for an apiOnly/no-transport session', () => {
    vi.mocked(botRegistry.getBot).mockReturnValue({
      config: { larkAppId: 'cli_decision', apiOnly: true, backendType: 'pty' },
    } as any);
    const ds = sessionFixture();
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(identityDecisionConflict(ds)).toBeTruthy();
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
  });

  it('refuses malformed spawn facts instead of trusting a stray string', () => {
    const ds = sessionFixture();
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'proven', sandboxEngaged: 'yes' as any, loopbackShared: 1 as any,
    });
    expect(identityDecisionConflict(ds)).toMatch(/malformed/);
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
  });

  it('a single report never needs the structural proven check', () => {
    const ds = sessionFixture({ sessionExtra: { adoptedFrom: 'pane-xyz' } });
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'single', sandboxEngaged: true, loopbackShared: false,
    });
    expect(identityDecisionConflict(ds)).toBeUndefined();
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
  });

  it('drops to single when the session shape turns structurally impossible after the report', () => {
    // Config can change between the worker's report and a later turn (the long
    // gap a device-grant poll covers). The accessor re-checks the structural
    // half live rather than trusting a proven record that no longer applies.
    const ds = sessionFixture();
    recordWorkerIdentityDecision(ds, worker, 9, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(identityStorageModelForDaemonSession(ds)).toBe('proven');
    ds.session.adoptedFrom = 'pane-abc';
    expect(identityDecisionConflict(ds)).toMatch(/structurally cannot run proven/);
    expect(identityStorageModelForDaemonSession(ds)).toBe('single');
  });

  it('detects a flip against the LAST PUBLISHED model, not the previous report (N1/N2 restart window)', () => {
    const ds = sessionFixture({ sessionExtra: { sandbox: false, sandboxNetwork: false } });

    // Cold start / restart: the daemon publishes the opening turn single
    // BEFORE any worker report exists (the accept-time fail-closed default).
    ds.lastPublishedIdentityModel = 'single';

    // The spawn actually runs proven (no sandbox / loopback shared): flip.
    const proven = recordWorkerIdentityDecision(ds, worker, 10, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(proven).toEqual({ model: 'proven', flipped: true });

    // Until the daemon actually replays the turn under proven, an identical
    // report keeps reporting the flip (a skipped/failed replay gets retried).
    const retried = recordWorkerIdentityDecision(ds, worker, 10, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(retried.flipped).toBe(true);

    // The flip handler's replay publishes via identityModelForPublication,
    // which moves the baseline; a later identical report is then no flip.
    ds.lastPublishedIdentityModel = 'proven';
    const again = recordWorkerIdentityDecision(ds, worker, 10, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    expect(again.flipped).toBe(false);

    // The reverse transition after an actual single publication also flips.
    ds.lastPublishedIdentityModel = 'proven';
    const backToSingle = recordWorkerIdentityDecision(ds, worker, 11, {
      model: 'single', sandboxEngaged: true, loopbackShared: false,
    });
    expect(backToSingle).toEqual({ model: 'single', flipped: true });
  });

  it('reports no flip (and no replay) before the daemon published anything', () => {
    const ds = sessionFixture();
    const decision = recordWorkerIdentityDecision(ds, worker, 1, {
      model: 'proven', sandboxEngaged: false, loopbackShared: true,
    });
    // No lastPublishedIdentityModel: nothing on disk to roll back.
    expect(decision.flipped).toBe(false);
  });
});

describe('identityDecisionTurnIsLive (P2 opening-turn gate)', () => {
  function liveSession(sessionExtra: Record<string, unknown> = {}, dsExtra: Record<string, unknown> = {}): any {
    return {
      session: { sessionId: 'decision-session', status: 'active', ...sessionExtra },
      larkAppId: 'cli_decision', chatId: 'oc_decision',
      worker: { killed: false, pid: 1 }, workerGeneration: 1,
      ...dsExtra,
    };
  }

  it('accepts the reported spawn turn before any daemon live-turn field is set (opening turn)', () => {
    // The new-topic boundary: accept ran before fork; currentTurnId is set
    // later by beginNewTurn and pendingTurnId/managedOrigin are not populated
    // yet. The current-generation worker's own spawn decision is authority.
    const ds = liveSession();
    expect(ds.currentTurnId).toBeUndefined();
    expect(identityDecisionTurnIsLive(ds, 'first-turn')).toBe(true);
  });

  it('refuses a turn the current worker already sent turn_terminal for', () => {
    // Reverse-risk: a late decision for an over turn must not resurrect it.
    const ds = liveSession({}, { terminalIdentityTurnIds: new Set(['om_old']) });
    expect(identityDecisionTurnIsLive(ds, 'om_old')).toBe(false);
    expect(identityDecisionTurnIsLive(ds, 'om_new')).toBe(true);
  });

  it('refuses when the session is inactive or the live worker is dead', () => {
    expect(identityDecisionTurnIsLive(liveSession({ status: 'closed' }), 'first-turn')).toBe(false);
    expect(identityDecisionTurnIsLive(liveSession({}, { worker: { killed: true, pid: 1 } }), 'first-turn')).toBe(false);
    expect(identityDecisionTurnIsLive({
      session: { sessionId: 'x', status: 'active' }, larkAppId: 'a', chatId: 'c',
    }, 'first-turn')).toBe(false);
  });
});
