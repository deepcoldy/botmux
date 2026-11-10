import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  updateSessionPid: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { createIdleSpinDetector } from '../src/core/idle-spin-detector.js';
import { resolveIdleSpinSuspendConfig } from '../src/core/idle-spin-config.js';
import type { IdleSpinSampler, IdleSpinSample } from '../src/core/idle-spin-sampler.js';
import { __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
import { __testOnly_setSuspendBackingVerifier } from '../src/core/worker-pool.js';

const now = Date.UTC(2026, 10, 10, 9, 0, 0);

function makeDs(sessionId: string, overrides: Record<string, any> = {}) {
  const { session, initConfig, worker, ...rest } = overrides;
  return {
    session: {
      sessionId,
      status: 'active',
      title: `title-${sessionId}`,
      cliId: 'traex',
      lastMessageAt: new Date(now - 10 * 60_000).toISOString(),
      ...(session ?? {}),
    },
    initConfig: { backendType: 'tmux', cliId: 'traex', ...(initConfig ?? {}) },
    worker: {
      pid: 4000,
      killed: false,
      send: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
      ...(worker ?? {}),
    },
    workerGeneration: 1,
    workerPort: 1000,
    workerToken: 'tok',
    workerReady: true,
    larkAppId: 'cli_test',
    spawnedAt: now - 10 * 60_000,
    lastMessageAt: now - 10 * 60_000,
    lastScreenStatus: 'idle',
    exitEventEmitted: false,
    localProcessAttestation: {
      backendType: 'tmux',
      credentialIsolated: false,
      cliPid: 5000,
      cliProcStart: '123',
      workerGeneration: 1,
    },
    ...rest,
  } as any;
}

function fakeSampler(readCpu: () => Record<string, number>): IdleSpinSampler {
  return {
    async sample(targets): Promise<IdleSpinSample> {
      const cpu = readCpu();
      const sessions = new Map();
      for (const target of targets) {
        if (cpu[target.sessionId] === undefined) continue;
        sessions.set(target.sessionId, {
          sessionId: target.sessionId,
          cpuPercent: cpu[target.sessionId],
          pids: 3,
          confidence: 'attestation' as const,
        });
      }
      return {
        supported: true,
        sampledAt: now,
        cpuCount: 32,
        hostCpuPct: 50,
        sessions,
        invalid: new Map(),
      };
    },
    reset() { /* no-op */ },
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return resolveIdleSpinSuspendConfig({
    cpuPercent: 20,
    consecutiveSamples: 2,
    minIdleMinutes: 5,
    maxSuspendsPerSample: 8,
    ...overrides,
  });
}

beforeEach(() => {
  __testOnly_resetBotTurnMutationGates();
  __testOnly_setSuspendBackingVerifier(() => true);
});
afterEach(() => {
  __testOnly_setSuspendBackingVerifier();
});

describe('idle-spin detector', () => {
  it('suspends a traex session after consecutive over-threshold idle samples', async () => {
    const ds = makeDs('spin');
    const sessions = new Map([['spin', ds]]);
    const cpu = { spin: 60 };
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => cpu),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });

    const first = await detector.tick(config());
    expect(first.overThreshold).toBe(0);
    expect(ds.worker).not.toBeNull();

    const second = await detector.tick(config());
    expect(second.suspended).toBe(1);
    expect(ds.worker).toBeNull();
    expect(ds.session.status).toBe('active');
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.idleSinceAt).toBeUndefined();
  });

  it('never suspends a busy session even at high CPU', async () => {
    const ds = makeDs('busy', { lastScreenStatus: 'working' });
    const sessions = new Map([['busy', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ busy: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    for (let i = 0; i < 4; i++) await detector.tick(config());
    expect(ds.worker).not.toBeNull();
  });

  it('resets the streak when one sample drops below the threshold', async () => {
    const ds = makeDs('flap');
    const sessions = new Map([['flap', ds]]);
    let cpu = 60;
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ flap: cpu })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    await detector.tick(config());
    cpu = 5;
    await detector.tick(config());
    expect(detector.streaks().get('flap')).toBeUndefined();
    cpu = 60;
    await detector.tick(config());
    expect(ds.worker).not.toBeNull(); // needs 2 consecutive again
    await detector.tick(config());
    expect(ds.worker).toBeNull();
  });

  it.each([
    ['background task', (d: any) => { d.backgroundTaskCount = 1; }],
    ['pending raw input', (d: any) => { d.pendingRawInput = '/goal'; }],
    ['pending follow-up', (d: any) => { d.pendingFollowUps = ['x']; }],
    ['agent attention', (d: any) => { d.agentAttention = { kind: 'decision', reason: 'pick', at: now }; }],
    ['usage limit', (d: any) => { d.usageLimit = { kind: 'rate_limited' }; }],
    ['final delivery', (d: any) => { d.finalOutputDeliveriesInFlight = new Set([Promise.resolve()]); }],
    ['accepted input', (d: any) => {
      d.acceptedInputTurns = new Map([['t', { workerGeneration: 1, turnId: 't', phase: 'native-submit', at: now }]]);
    }],
    ['activation pending', (d: any) => { d.session.queuedActivationPending = true; }],
    ['activation tail', (d: any) => { d.session.queuedActivationTail = [{ turnId: 't' }]; }],
    ['initial start', (d: any) => { d.initialStartPending = true; }],
    ['deferred schedule run', (d: any) => {
      d.session.deferredScheduleRun = { taskId: 'task', turnId: 'turn', routingAnchor: 'a', createdAt: 'x' };
    }],
    ['deferred schedule undelivered', (d: any) => { d.deferredScheduleUndeliveredTurnId = 't'; }],
    ['deferred schedule unconfirmed', (d: any) => { d.deferredScheduleUnconfirmedTurnId = 't'; }],
    ['prompt cache keepalive', (d: any) => { d.promptCacheKeepalive = { pings: 1, idleSinceAt: now }; }],
    ['idle auto compact arm', (d: any) => { d.idleAutoCompactArm = { at: now, busy: false }; }],
    ['pending suspend', (d: any) => { d.pendingSuspendReason = 'manual'; }],
  ] as const)('fails closed for %s', async (_label, mutate) => {
    const ds = makeDs('guarded');
    mutate(ds);
    const sessions = new Map([['guarded', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ guarded: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    for (let i = 0; i < 3; i++) await detector.tick(config());
    expect(ds.worker).not.toBeNull();
  });

  it('skips pty sessions (non-resumable backend) even at high CPU', async () => {
    const ds = makeDs('pty', { initConfig: { backendType: 'pty', cliId: 'traex' } });
    const sessions = new Map([['pty', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ pty: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    for (let i = 0; i < 3; i++) await detector.tick(config());
    expect(ds.worker).not.toBeNull();
  });

  it('does not touch non-traex CLIs by default, but honours an explicit opt-in', async () => {
    const ds = makeDs('claude', {
      session: { cliId: 'claude-code' },
      initConfig: { backendType: 'tmux', cliId: 'claude-code' },
    });
    const sessions = new Map([['claude', ds]]);
    const sampler = fakeSampler(() => ({ claude: 200 }));
    const base = {
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'claude-code' as const,
      sampler,
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    };
    const defaultDetector = createIdleSpinDetector(base);
    for (let i = 0; i < 3; i++) await defaultDetector.tick(config());
    expect(ds.worker).not.toBeNull();

    const optIn = createIdleSpinDetector(base);
    for (let i = 0; i < 2; i++) await optIn.tick(config({ cliIds: ['claude-code'] }));
    expect(ds.worker).toBeNull();
  });

  it('fails closed when the traex install is stale or identity is unknown', async () => {
    for (const state of ['stale', 'unknown']) {
      const ds = makeDs(`install-${state}`);
      const sessions = new Map([[`install-${state}`, ds]]);
      const detector = createIdleSpinDetector({
        larkAppId: 'cli_test',
        activeSessions: sessions,
        defaultCliId: 'traex',
        sampler: fakeSampler(() => ({ [`install-${state}`]: 200 })),
        observeInstall: () => ({ state }),
        now: () => now,
      });
      for (let i = 0; i < 3; i++) await detector.tick(config());
      expect(ds.worker).not.toBeNull();
    }
  });

  it('detects a restored idle session with no idleSinceAt (conservative activity clock)', async () => {
    const ds = makeDs('restored');
    ds.idleSinceAt = undefined;
    const sessions = new Map([['restored', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ restored: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    for (let i = 0; i < 2; i++) await detector.tick(config());
    expect(ds.worker).toBeNull();
  });

  it('keeps streaks and retries when the mutation gate is busy', async () => {
    const ds = makeDs('gated');
    const sessions = new Map([['gated', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_gate',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ gated: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
      mutationAcquireTimeoutMs: 1,
    });
    const { withBotTurnAdmission } = await import('../src/core/bot-turn-mutation-gate.js');
    let release!: () => void;
    let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const admission = withBotTurnAdmission('cli_gate', async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await admitted;

    const first = await detector.tick(config({ consecutiveSamples: 1 }));
    expect(first.gateBusy).toBe(true);
    expect(ds.worker).not.toBeNull();
    expect(detector.streaks().get('gated')).toBe(1);

    release();
    await admission;
    const second = await detector.tick(config({ consecutiveSamples: 1 }));
    expect(second.suspended).toBe(1);
    expect(ds.worker).toBeNull();
  });

  it('does nothing when the config is disabled', async () => {
    const ds = makeDs('off');
    const sessions = new Map([['off', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ off: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    for (let i = 0; i < 3; i++) await detector.tick(config({ enabled: false }));
    expect(ds.worker).not.toBeNull();
  });

  it('resets streaks when the detection config changes', async () => {
    const ds = makeDs('reload');
    const sessions = new Map([['reload', ds]]);
    const detector = createIdleSpinDetector({
      larkAppId: 'cli_test',
      activeSessions: sessions,
      defaultCliId: 'traex',
      sampler: fakeSampler(() => ({ reload: 200 })),
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    await detector.tick(config({ consecutiveSamples: 3 }));
    expect(detector.streaks().get('reload')).toBe(1);
    // A threshold change is a new policy; the old streak must not carry over.
    await detector.tick(config({ consecutiveSamples: 3, cpuPercent: 30 }));
    expect(detector.streaks().get('reload')).toBe(1);
    expect(ds.worker).not.toBeNull();
  });

  it('only reclaims sessions in this daemon map (multi-bot isolation)', async () => {
    const own = makeDs('own');
    const other = makeDs('other');
    const ownMap = new Map([['own', own]]);
    const otherMap = new Map([['other', other]]);
    const sampler = fakeSampler(() => ({ own: 200, other: 200 }));
    const detectorA = createIdleSpinDetector({
      larkAppId: 'cli_a',
      activeSessions: ownMap,
      defaultCliId: 'traex',
      sampler,
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    const detectorB = createIdleSpinDetector({
      larkAppId: 'cli_b',
      activeSessions: otherMap,
      defaultCliId: 'traex',
      sampler,
      observeInstall: () => ({ state: 'current' }),
      now: () => now,
    });
    for (let i = 0; i < 2; i++) {
      await detectorA.tick(config());
      await detectorB.tick(config());
    }
    expect(own.worker).toBeNull();
    expect(other.worker).toBeNull();
    // Each detector only ever saw its own map.
    expect(detectorA.streaks().has('other')).toBe(false);
    expect(detectorB.streaks().has('own')).toBe(false);
  });
});
