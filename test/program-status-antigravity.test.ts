import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_PROGRAM_STATUS_MIN_VERSION,
  createAntigravityAdapter,
} from '../src/adapters/cli/antigravity.js';
import { createAntigravityAcpAdapter } from '../src/adapters/cli/antigravity-acp.js';
import { buildBotmuxEnvAssignments } from '../src/adapters/backend/tmux-backend.js';
import { ptyChildEnv } from '../src/adapters/backend/pty-backend.js';
import { strictPaneEnvArgs } from '../src/adapters/backend/strict-env.js';
import { buildHerdrFinalCommand } from '../src/adapters/backend/herdr-backend.js';
import { createKimiAdapter } from '../src/adapters/cli/kimi.js';
import { createEbsdAdapter } from '../src/adapters/cli/ebsd.js';
import { createDoubaoAdapter } from '../src/adapters/cli/doubao.js';
import {
  ANTIGRAVITY_OSC7501_ENV_KEY,
  ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY,
  ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS,
  applyAdapterSpawnEnv,
  effectiveProgramStatusEnv,
  filterAppliedAdapterEnvUnset,
  programStatusBlockHoldsTypeAhead,
  programStatusDisabledByEnv,
  programStatusEnabledForLaunch,
  refreshStructuredPreStartLeaseFromProgramStatus,
  shouldDeferAntigravityQuietFinalForProgramStatus,
  shouldFireIdleAfterAntigravityQuietFlush,
} from '../src/core/program-status-gate.js';
import {
  BOTMUX_INJECTED_ENV_KEYS,
  isBotmuxManagedTmuxEnvKey,
  isBotmuxManagedTmuxServerGlobalEnvKey,
} from '../src/utils/child-env.js';
import { STALE_PROGRAM_STATUS_QUIET_MS } from '../src/utils/stale-program-status.js';
import {
  CodexBridgeQueue,
  STRUCTURED_SUBMIT_START_GRACE_MS,
} from '../src/services/codex-bridge-queue.js';
import { IdleDetector, type ProgramStatusEvent } from '../src/utils/idle-detector.js';
import { ProgramStatusFramingStream } from '../src/utils/program-status-parser.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { busyProbeRegion } from '../src/utils/busy-probe.js';

const osc = (fields: string) => `\x1b]7501;${fields}\x07`;
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const AGY_READY_SCREEN = '\r\n────────\r\n>\r\n────────\r\n? for shortcuts\r\n';
const AGY_APPROVAL_SCREEN = '\r\nApprove Bash: touch perm_test_file\r\n> 1. Allow once\r\n  2. Deny\r\n';

afterEach(() => {
  vi.useRealTimers();
});

describe('Antigravity OSC 7501 launch gating and env handling', () => {
  it('enables OSC 7501 for agy >= 1.5.10 and falls back for older, unknown, adopt, remote, or ACP launches', () => {
    const adapter = createAntigravityAdapter('/bin/agy');
    const acp = createAntigravityAcpAdapter('/bin/agy');

    expect(adapter.supportsProgramStatus).toBe(true);
    expect(adapter.programStatusMinVersion).toBe(ANTIGRAVITY_PROGRAM_STATUS_MIN_VERSION);
    expect(adapter.programStatusFollowsInputCycle).toBe(true);
    expect(adapter.programStatusYieldsToTranscriptTerminal).toBe(true);
    expect(adapter.programStatusBlockedHoldsInput).toBe(true);

    // Allowed versions (>= 1.5.10)
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.10' })).toBe(true);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18' })).toBe(true);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.6.0' })).toBe(true);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '2.0.0' })).toBe(true);

    // Below threshold, pre-release of threshold, unknown, adopt, remote
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.9' })).toBe(false);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.4.0' })).toBe(false);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.10-rc.1' })).toBe(false);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: 'unknown' })).toBe(false);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: undefined })).toBe(false);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', adoptMode: true })).toBe(false);
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', remoteViewer: true })).toBe(false);

    // ACP transport stays untouched
    expect(acp.supportsProgramStatus).toBeUndefined();
    expect(acp.spawnEnv).toBeUndefined();
    expect(programStatusEnabledForLaunch(acp, { cliVersion: '1.5.18' })).toBe(false);
  });

  it('respects explicit AGY_CLI_OSC7501=off (case-insensitive) across host, bot, strict policy, and envUnset', () => {
    const adapter = createAntigravityAdapter('/bin/agy');

    expect(programStatusDisabledByEnv('antigravity', { AGY_CLI_OSC7501: 'off' })).toBe(true);
    expect(programStatusDisabledByEnv('antigravity', { AGY_CLI_OSC7501: ' OFF ' })).toBe(true);
    expect(programStatusDisabledByEnv('antigravity', { AGY_CLI_OSC7501: 'on' })).toBe(false);
    expect(programStatusDisabledByEnv('antigravity', { AGY_CLI_OSC7501: 'auto' })).toBe(false);
    expect(programStatusDisabledByEnv('codex', { AGY_CLI_OSC7501: 'off' })).toBe(false);

    expect(programStatusEnabledForLaunch(adapter, {
      cliVersion: '1.5.18',
      env: { AGY_CLI_OSC7501: 'off' },
    })).toBe(false);

    // Per-bot env overrides host env in both directions
    const hostOffBotOn = effectiveProgramStatusEnv(
      { AGY_CLI_OSC7501: 'off' },
      { botEnv: { AGY_CLI_OSC7501: 'on' } },
    );
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', env: hostOffBotOn })).toBe(true);

    const hostOnBotOff = effectiveProgramStatusEnv(
      { AGY_CLI_OSC7501: 'on' },
      { botEnv: { AGY_CLI_OSC7501: 'off' } },
    );
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', env: hostOnBotOff })).toBe(false);

    // envUnset clears inherited host opt-out
    const unsetHostOff = effectiveProgramStatusEnv(
      { AGY_CLI_OSC7501: 'off' },
      { envUnset: ['AGY_CLI_OSC7501'] },
    );
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', env: unsetHostOff })).toBe(true);

    // strict policy drops non-inherited host opt-out, preserves explicitly inherited one
    const strictDrops = effectiveProgramStatusEnv(
      { AGY_CLI_OSC7501: 'off' },
      { envPolicy: { mode: 'strict' } },
    );
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', env: strictDrops })).toBe(true);

    const strictInherits = effectiveProgramStatusEnv(
      { AGY_CLI_OSC7501: 'off' },
      { envPolicy: { mode: 'strict', inherit: ['AGY_CLI_OSC7501'] } },
    );
    expect(programStatusEnabledForLaunch(adapter, { cliVersion: '1.5.18', env: strictInherits })).toBe(false);
  });

  it('injects default OSC 7501 env only when enabled, preserves user overrides, and forwards via tmux assignments', () => {
    const adapter = createAntigravityAdapter('/bin/agy');

    // Enabled with no user overrides -> defaults applied and forwarded through tmux env assignments
    const defaultEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyAdapterSpawnEnv(defaultEnv, adapter, { programStatusEnabled: true });
    expect(defaultEnv[ANTIGRAVITY_OSC7501_ENV_KEY]).toBe('on');
    expect(defaultEnv[ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY]).toBe('brief');
    const assignments = buildBotmuxEnvAssignments(defaultEnv);
    expect(assignments).toContain('AGY_CLI_OSC7501=on');
    expect(assignments).toContain('AGY_CLI_OSC7501_MESSAGES=brief');

    // Disabled (old/unknown version or explicit off) -> nothing injected
    const oldVersionEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyAdapterSpawnEnv(oldVersionEnv, adapter, { programStatusEnabled: false });
    expect(oldVersionEnv[ANTIGRAVITY_OSC7501_ENV_KEY]).toBeUndefined();
    expect(oldVersionEnv[ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY]).toBeUndefined();

    const hostOffEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', AGY_CLI_OSC7501: 'off' };
    applyAdapterSpawnEnv(hostOffEnv, adapter, { programStatusEnabled: false });
    expect(hostOffEnv[ANTIGRAVITY_OSC7501_ENV_KEY]).toBe('off');
    expect(buildBotmuxEnvAssignments(hostOffEnv)).toContain('AGY_CLI_OSC7501=off');

    // Explicit user overrides in host env or botEnv are preserved
    const customHostEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      AGY_CLI_OSC7501: 'auto',
      AGY_CLI_OSC7501_MESSAGES: 'full',
    };
    applyAdapterSpawnEnv(customHostEnv, adapter, { programStatusEnabled: true });
    expect(customHostEnv[ANTIGRAVITY_OSC7501_ENV_KEY]).toBe('auto');
    expect(customHostEnv[ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY]).toBe('full');

    const customBotEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const appliedBot = applyAdapterSpawnEnv(customBotEnv, adapter, {
      programStatusEnabled: true,
      botEnv: { AGY_CLI_OSC7501_MESSAGES: 'full' },
    });
    expect(appliedBot).toEqual([ANTIGRAVITY_OSC7501_ENV_KEY]);
    expect(customBotEnv[ANTIGRAVITY_OSC7501_ENV_KEY]).toBe('on');
    expect(customBotEnv[ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY]).toBeUndefined();

    // Explicit empty botEnv key owns the key without writing a doomed default to childEnv
    const emptyBotEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const appliedEmptyBot = applyAdapterSpawnEnv(emptyBotEnv, adapter, {
      programStatusEnabled: true,
      botEnv: { AGY_CLI_OSC7501: '', AGY_CLI_OSC7501_MESSAGES: '' },
    });
    expect(appliedEmptyBot).toEqual([]);
    expect(emptyBotEnv[ANTIGRAVITY_OSC7501_ENV_KEY]).toBeUndefined();
    expect(emptyBotEnv[ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY]).toBeUndefined();
  });

  it('keeps adapter-injected OSC 7501 defaults intact across pty, strict, and tmux backends when envUnset clears host opt-out', () => {
    const adapter = createAntigravityAdapter('/bin/agy');
    // Host had AGY_CLI_OSC7501=off, user sets envUnset: ['AGY_CLI_OSC7501', 'OTHER_VAR'] to opt back in
    const childEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', OTHER_VAR: '1' };
    const applied = applyAdapterSpawnEnv(childEnv, adapter, { programStatusEnabled: true });
    const unsetEnv = filterAppliedAdapterEnvUnset(['AGY_CLI_OSC7501', 'AGY_CLI_OSC7501_MESSAGES', 'OTHER_VAR'], applied);
    expect(unsetEnv).toEqual(['OTHER_VAR']);

    // PTY backend retains adapter-injected defaults while still unsetting OTHER_VAR
    const ptyEnv = ptyChildEnv({ env: childEnv as Record<string, string>, unsetEnv });
    expect(ptyEnv.AGY_CLI_OSC7501).toBe('on');
    expect(ptyEnv.AGY_CLI_OSC7501_MESSAGES).toBe('brief');
    expect(ptyEnv.OTHER_VAR).toBeUndefined();

    // Strict persistent backends retain adapter-injected defaults too
    const strictArgs = strictPaneEnvArgs({
      cwd: '/tmp',
      cols: 120,
      rows: 40,
      env: childEnv as Record<string, string>,
      unsetEnv,
    });
    expect(strictArgs).toContain('AGY_CLI_OSC7501=on');
    expect(strictArgs).toContain('AGY_CLI_OSC7501_MESSAGES=brief');
    expect(strictArgs.some(a => a.startsWith('OTHER_VAR='))).toBe(false);

    // Non-strict tmux assignments forward defaults and keep OTHER_VAR unset
    const tmuxArgs = buildBotmuxEnvAssignments(childEnv, undefined, unsetEnv);
    expect(tmuxArgs).toContain('AGY_CLI_OSC7501=on');
    expect(tmuxArgs).toContain('AGY_CLI_OSC7501_MESSAGES=brief');
    expect(tmuxArgs).toContain('-u');
    expect(tmuxArgs).toContain('OTHER_VAR');

    // Disabled launch (old version) leaves envUnset untouched so host/rcfile value is removed
    const disabledUnset = filterAppliedAdapterEnvUnset(['AGY_CLI_OSC7501'], []);
    expect(disabledUnset).toEqual(['AGY_CLI_OSC7501']);
  });

  it('strips AGY_CLI_OSC7501* from tmux client env without scrubbing user-owned tmux server globals or rcfiles', () => {
    expect(BOTMUX_INJECTED_ENV_KEYS).not.toContain(ANTIGRAVITY_OSC7501_ENV_KEY);
    expect(BOTMUX_INJECTED_ENV_KEYS).not.toContain(ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY);
    expect(isBotmuxManagedTmuxEnvKey(ANTIGRAVITY_OSC7501_ENV_KEY)).toBe(true);
    expect(isBotmuxManagedTmuxEnvKey(ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY)).toBe(true);
    expect(isBotmuxManagedTmuxServerGlobalEnvKey(ANTIGRAVITY_OSC7501_ENV_KEY)).toBe(false);
    expect(isBotmuxManagedTmuxServerGlobalEnvKey(ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY)).toBe(false);
  });

  it('defers Antigravity quiet-tick provisional final flush on blocked or active working until BOTH OSC and candidate stay quiet >= staleQuietMs', () => {
    // Blocked always defers regardless of quiet time
    expect(shouldDeferAntigravityQuietFinalForProgramStatus({
      blocked: true,
      heldWorking: false,
      programStatusQuietMs: STALE_PROGRAM_STATUS_QUIET_MS * 5,
      candidateAgeMs: STALE_PROGRAM_STATUS_QUIET_MS * 5,
      staleQuietMs: STALE_PROGRAM_STATUS_QUIET_MS,
    })).toBe(true);

    // Not blocked and not heldWorking (e.g. OSC done already arrived or OSC off) -> never defers
    expect(shouldDeferAntigravityQuietFinalForProgramStatus({
      blocked: false,
      heldWorking: false,
      programStatusQuietMs: 0,
      candidateAgeMs: 0,
      staleQuietMs: STALE_PROGRAM_STATUS_QUIET_MS,
    })).toBe(false);

    // Turn running >60s (OSC quiet >= 60s), but provisional candidate just landed (age 2s) -> MUST still defer
    expect(shouldDeferAntigravityQuietFinalForProgramStatus({
      blocked: false,
      heldWorking: true,
      programStatusQuietMs: STALE_PROGRAM_STATUS_QUIET_MS + 30_000,
      candidateAgeMs: 2_000,
      staleQuietMs: STALE_PROGRAM_STATUS_QUIET_MS,
    })).toBe(true);

    // Candidate aged >= 60s, but OSC recently reported working -> MUST still defer
    expect(shouldDeferAntigravityQuietFinalForProgramStatus({
      blocked: false,
      heldWorking: true,
      programStatusQuietMs: 5_000,
      candidateAgeMs: STALE_PROGRAM_STATUS_QUIET_MS + 5_000,
      staleQuietMs: STALE_PROGRAM_STATUS_QUIET_MS,
    })).toBe(true);

    // BOTH OSC quiet >= 60s AND candidate unchanged >= 60s (likely lost done report) -> allow flush
    expect(shouldDeferAntigravityQuietFinalForProgramStatus({
      blocked: false,
      heldWorking: true,
      programStatusQuietMs: STALE_PROGRAM_STATUS_QUIET_MS,
      candidateAgeMs: STALE_PROGRAM_STATUS_QUIET_MS,
      staleQuietMs: STALE_PROGRAM_STATUS_QUIET_MS,
    })).toBe(false);
  });
});

describe('Antigravity OSC 7501 IdleDetector state transitions (empirical agy 1.5.18 wire frames)', () => {
  function setupPipeline() {
    vi.useFakeTimers({ now: 0 });
    const adapter = createAntigravityAdapter('/bin/agy');
    const stream = new ProgramStatusFramingStream();
    const detector = new IdleDetector(adapter);
    const edges: Array<{ t: number; edge: 'idle' | 'busy'; source?: string }> = [];
    const observed: ProgramStatusEvent[] = [];
    detector.onIdle((source) => edges.push({ t: Date.now(), edge: 'idle', source }));
    detector.onBusy(() => edges.push({ t: Date.now(), edge: 'busy' }));

    const feedWire = (chunk: string) => {
      for (const part of stream.feed(chunk)) {
        if (part.type === 'status') {
          observed.push(part.event);
          detector.observeProgramStatus(part.event);
        } else if (part.type === 'data') {
          detector.feed(part.text);
        }
      }
    };

    return { adapter, detector, edges, observed, feedWire };
  }

  it('ignores startup OSC frames before first write and settles startup via composer screen gate', () => {
    const { detector, edges, feedWire } = setupPipeline();

    // Setup wizard blocked -> folder trust blocked -> ready composer idle
    feedWire(osc(`state=blocked:kind=question:app=antigravity:msg=${b64('Finish setup')}`));
    feedWire(osc(`state=blocked:kind=permission:app=antigravity:msg=${b64('Trust this folder?')}`));
    feedWire(osc('state=idle:app=antigravity') + AGY_READY_SCREEN);

    // Startup OSC idle does NOT fire immediately; screen quiescence owns first prompt
    expect(detector.programStatusActive()).toBe(false);
    expect(detector.lastProgramStatusReport()).toBe('idle');
    expect(edges).toEqual([]);

    vi.advanceTimersByTime(3_500);
    expect(edges.map(e => `${e.edge}:${e.source}`)).toEqual(['idle:screen']);
  });

  it('tracks working -> blocked (permission) -> working -> done, holding queued input while blocked', () => {
    const { detector, edges, feedWire } = setupPipeline();

    feedWire(osc('state=idle:app=antigravity') + AGY_READY_SCREEN);
    vi.advanceTimersByTime(3_500);
    edges.length = 0;

    // Submit turn 1
    detector.reset({ inputCycle: true });
    feedWire(osc('state=working:app=antigravity'));
    expect(detector.programStatusActive()).toBe(true);
    expect(detector.programStatusHeldWorking()).toBe(true);
    expect(detector.programStatusHeldBusy()).toBe(true);

    // Permission dialog arrives; static screen stays quiet for 15s
    feedWire(osc(`state=blocked:kind=permission:app=antigravity:msg=${b64('Approve Bash')}`) + AGY_APPROVAL_SCREEN);
    expect(detector.programStatusHeldBusy()).toBe(true);
    expect(detector.programStatusHeldWorking()).toBe(false);
    expect(programStatusBlockHoldsTypeAhead(detector.programStatusBlock())).toBe(true);
    vi.advanceTimersByTime(15_000);
    expect(edges.filter(e => e.edge === 'idle')).toEqual([]);

    // Transcript terminal (fireIdle) MUST NOT override a blocked human gate
    detector.fireIdle();
    expect(edges.filter(e => e.edge === 'idle')).toEqual([]);
    expect(detector.programStatusHeldBusy()).toBe(true);

    // User approves -> working -> done
    feedWire(osc('state=working:app=antigravity'));
    expect(programStatusBlockHoldsTypeAhead(detector.programStatusBlock())).toBe(false);
    feedWire(osc(`state=done:app=antigravity:msg=${b64('Task complete')}`) + AGY_READY_SCREEN);
    expect(detector.programStatusHeldBusy()).toBe(false);
    expect(edges.filter(e => e.edge === 'idle').map(e => e.source)).toEqual(['program-status']);
  });

  it('ignores keystroke-acknowledging idle after done, settles silent slash commands on screen, and completes on error/Esc idle', () => {
    const { detector, edges, feedWire } = setupPipeline();

    feedWire(osc('state=idle:app=antigravity') + AGY_READY_SCREEN);
    vi.advanceTimersByTime(3_500);

    // Turn 1 completes with done
    detector.reset({ inputCycle: true });
    feedWire(osc('state=working:app=antigravity'));
    feedWire(osc(`state=done:app=antigravity:msg=${b64('Task complete')}`) + AGY_READY_SCREEN);
    edges.length = 0;

    // Next input starts: first keystroke emits idle (onKeyPress ack of previous done)
    detector.reset({ inputCycle: true });
    feedWire(osc('state=idle:app=antigravity'));
    expect(edges).toEqual([]); // must NOT complete before working arrives

    // Turn 2 enters working and is interrupted by Esc -> idle
    feedWire(osc('state=working:app=antigravity'));
    expect(detector.programStatusHeldBusy()).toBe(true);
    feedWire(osc('state=idle:app=antigravity') + AGY_READY_SCREEN);
    expect(edges.filter(e => e.edge === 'idle').map(e => e.source)).toEqual(['program-status']);
    edges.length = 0;

    // Non-turn slash command (/model): emits NO OSC 7501 at all -> settles on normal screen quiescence (no 15s wait)
    detector.reset({ inputCycle: true });
    feedWire(AGY_READY_SCREEN);
    vi.advanceTimersByTime(3_500);
    expect(edges.filter(e => e.edge === 'idle').map(e => e.source)).toEqual(['screen']);
    edges.length = 0;

    // Turn 3 fails with error
    detector.reset({ inputCycle: true });
    feedWire(osc('state=working:app=antigravity'));
    feedWire(osc(`state=error:app=antigravity:msg=${b64('Agent stopped with an error')}`) + AGY_READY_SCREEN);
    expect(edges.filter(e => e.edge === 'idle').map(e => e.source)).toEqual(['program-status']);
    expect(detector.programStatusError()).toBe('Agent stopped with an error');
  });

  it('yields lingering working to transcript terminal (fireIdle), but holds blocked question and keeps working across type-ahead', () => {
    const { detector, edges, feedWire } = setupPipeline();

    feedWire(osc('state=idle:app=antigravity') + AGY_READY_SCREEN);
    vi.advanceTimersByTime(3_500);
    edges.length = 0;

    // Type-ahead during active working keeps OSC authority intact
    detector.reset({ inputCycle: true });
    feedWire(osc('state=working:app=antigravity'));
    detector.reset({ inputCycle: true });
    expect(detector.programStatusActive()).toBe(true);
    expect(detector.programStatusHeldWorking()).toBe(true);

    // Blocked question stays busy and vetoes fireIdle
    feedWire(osc(`state=blocked:kind=question:app=antigravity:msg=${b64('Answer question')}`));
    detector.fireIdle();
    expect(edges.filter(e => e.edge === 'idle')).toEqual([]);

    // Back to working -> confirmed transcript terminal (fireIdle) releases lingering working
    feedWire(osc('state=working:app=antigravity'));
    detector.fireIdle();
    expect(edges.filter(e => e.edge === 'idle').map(e => e.source)).toEqual(['external']);
    expect(detector.programStatusHeldBusy()).toBe(false);
  });
});

describe('OSC 7501 busy-driven bounded pre-start lease refresh (Antigravity)', () => {
  function setupQueue() {
    let now = 0;
    const queue = new CodexBridgeQueue(() => now);
    return {
      queue,
      now: () => now,
      setNow: (ms: number) => { now = ms; },
    };
  }

  it('refreshes confirmed and attribution-only Antigravity pre-start heads past 20s while OSC reports busy, then attributes late USER_INPUT', () => {
    for (const confirmed of [true, false]) {
      const { queue, setNow } = setupQueue();
      queue.mark('om_cold', 'cold start prompt', 0);
      if (confirmed) {
        queue.confirmPendingTurn('om_cold', 0);
      } else {
        queue.beginSubmitVerification('om_cold', 0);
        queue.finishSubmitVerification('om_cold', 0);
      }

      // Tick every second past the 20s STRUCTURED_SUBMIT_START_GRACE_MS while OSC holds working/blocked
      for (let t = 1_000; t <= 45_000; t += 1_000) {
        setNow(t);
        const refreshed = refreshStructuredPreStartLeaseFromProgramStatus({
          cliId: 'antigravity',
          programStatusHeldBusy: true,
          queue,
          nowMs: t,
        });
        expect(refreshed).toBe(1);
        expect(queue.pruneExpiredPreStartHeads(t)).toEqual([]);
      }
      expect(queue.hasPendingTurn('om_cold')).toBe(true);

      // Late USER_INPUT + PLANNER_RESPONSE finally land at 46s
      setNow(46_000);
      queue.ingest([
        { kind: 'user', text: 'cold start prompt', uuid: 'u1', timestampMs: 46_000 },
        { kind: 'assistant_final', text: 'cold start reply', uuid: 'a1', timestampMs: 46_100 },
      ]);
      expect(queue.drainEmittable().map(t => ({ turnId: t.turnId, finalText: t.finalText }))).toEqual([
        { turnId: 'om_cold', finalText: 'cold start reply' },
      ]);
    }
  });

  it('uses the real worker viewport hook without OSC, then enforces the same hard ceiling', () => {
    let now = 0;
    const queue = new CodexBridgeQueue(() => now);
    queue.mark('om_cold', 'cold start prompt', 0);
    queue.confirmPendingTurn('om_cold', 0);
    const scope: Record<string, any> = {
      structuredBridgeIs: (id: string) => id === 'antigravity',
      lastInitConfig: { cliId: 'antigravity', adoptMode: false },
      cliAdapter: createAntigravityAdapter(),
      backend: {},
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      captureBackendScreen: () => 'Working…\nesc to cancel',
      busyProbeRegion,
      codexBridgeQueue: queue,
      refreshStructuredPreStartLeaseFromProgramStatus,
      ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS,
    };
    const hold = loadWorkerFunction<() => void>('holdStructuredStartLeasesWhileAntigravityViewportBusy', scope);
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    // No OSC report arrives at all. The visible busy footer keeps the exact
    // owner attributable until its late transcript user/final pair appears.
    for (now = 1_000; now <= 45_000; now += 1_000) {
      hold();
      expect(queue.pruneExpiredPreStartHeads(now)).toEqual([]);
    }
    now = 46_000;
    queue.ingest([
      { kind: 'user', text: 'cold start prompt', uuid: 'u-no-osc', timestampMs: 46_000 },
      { kind: 'assistant_final', text: 'late reply', uuid: 'a-no-osc', timestampMs: 46_100 },
    ]);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_cold', finalText: 'late reply' }]);

    // A permanently stuck footer cannot refresh forever: after the 120s cap,
    // only the ordinary final 20s grace remains.
    const stuck = new CodexBridgeQueue(() => now);
    stuck.mark('om_stuck_viewport', 'stuck prompt', 0);
    stuck.confirmPendingTurn('om_stuck_viewport', 0);
    scope.codexBridgeQueue = stuck;
    now = 0;
    for (now = 1_000; now <= ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS; now += 1_000) {
      hold();
      expect(stuck.pruneExpiredPreStartHeads(now)).toEqual([]);
    }
    now = ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS + 1_000;
    hold();
    expect(stuck.pruneExpiredPreStartHeads(now)).toEqual([]);
    now = ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS + STRUCTURED_SUBMIT_START_GRACE_MS;
    expect(stuck.pruneExpiredPreStartHeads(now)).toEqual([]);
    now += 1;
    expect(stuck.pruneExpiredPreStartHeads(now).map(turn => turn.turnId)).toEqual(['om_stuck_viewport']);
  });

  it('does not probe or renew from a busy viewport for adopt or framed ACP', () => {
    for (const opts of [{ adopt: true, acp: false }, { adopt: false, acp: true }]) {
      const queue = new CodexBridgeQueue(() => 0);
      queue.mark('om_excluded', 'prompt', 0);
      queue.confirmPendingTurn('om_excluded', 0);
      const capture = vi.fn(() => 'Working…\nesc to cancel');
      const scope: Record<string, any> = {
        structuredBridgeIs: (id: string) => id === 'antigravity',
        lastInitConfig: { cliId: 'antigravity', adoptMode: opts.adopt },
        cliAdapter: opts.acp ? createAntigravityAcpAdapter() : createAntigravityAdapter(),
        backend: {},
        backendScreenEvidenceIsAuthoritativeForMutation: () => true,
        captureBackendScreen: capture,
        busyProbeRegion,
        codexBridgeQueue: queue,
        refreshStructuredPreStartLeaseFromProgramStatus,
        ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS,
      };
      loadWorkerFunction<() => void>('holdStructuredStartLeasesWhileAntigravityViewportBusy', scope)();
      expect(capture).not.toHaveBeenCalled();
      expect(queue.peek()[0]?.submitConfirmedAtMs).toBe(0);
    }
  });

  it('enforces the hard ceiling so a permanently stuck working turn still expires and recovers', () => {
    const { queue, setNow } = setupQueue();
    queue.mark('om_stuck', 'stuck prompt', 0);
    queue.confirmPendingTurn('om_stuck', 0);

    // Refreshes succeed up to the hard ceiling (120s)
    for (let t = 1_000; t <= ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS; t += 1_000) {
      setNow(t);
      expect(refreshStructuredPreStartLeaseFromProgramStatus({
        cliId: 'antigravity',
        programStatusHeldBusy: true,
        queue,
        nowMs: t,
      })).toBe(1);
      expect(queue.pruneExpiredPreStartHeads(t)).toEqual([]);
    }

    // Past the hard ceiling, refreshes stop and the final 20s tail lease runs down
    const afterCap = ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS + 1_000;
    setNow(afterCap);
    expect(refreshStructuredPreStartLeaseFromProgramStatus({
      cliId: 'antigravity',
      programStatusHeldBusy: true,
      queue,
      nowMs: afterCap,
    })).toBe(0);

    const beforeExpiry = ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS + STRUCTURED_SUBMIT_START_GRACE_MS;
    setNow(beforeExpiry);
    expect(queue.pruneExpiredPreStartHeads(beforeExpiry)).toEqual([]);

    const atExpiry = beforeExpiry + 1;
    setNow(atExpiry);
    const dropped = queue.pruneExpiredPreStartHeads(atExpiry);
    expect(dropped.map(t => t.turnId)).toEqual(['om_stuck']);
    expect(queue.peek()).toEqual([]);
  });

  it('stops refreshing as soon as OSC leaves busy (done/idle/error), expiring after the normal 20s grace', () => {
    const { queue, setNow } = setupQueue();
    queue.mark('om_err', 'failed before transcript', 0);
    queue.confirmPendingTurn('om_err', 0);

    // Busy for 7s, then OSC reports error (programStatusHeldBusy -> false)
    for (let t = 1_000; t <= 7_000; t += 1_000) {
      setNow(t);
      refreshStructuredPreStartLeaseFromProgramStatus({
        cliId: 'antigravity',
        programStatusHeldBusy: true,
        queue,
        nowMs: t,
      });
    }

    // No refresh once busy ends
    setNow(7_000 + STRUCTURED_SUBMIT_START_GRACE_MS);
    expect(refreshStructuredPreStartLeaseFromProgramStatus({
      cliId: 'antigravity',
      programStatusHeldBusy: false,
      queue,
      nowMs: 7_000 + STRUCTURED_SUBMIT_START_GRACE_MS,
    })).toBe(0);
    expect(queue.pruneExpiredPreStartHeads(7_000 + STRUCTURED_SUBMIT_START_GRACE_MS)).toEqual([]);

    // Expires 1ms past 7s + 20s (well before the 120s ceiling)
    const expiry = 7_000 + STRUCTURED_SUBMIT_START_GRACE_MS + 1;
    setNow(expiry);
    expect(queue.pruneExpiredPreStartHeads(expiry).map(t => t.turnId)).toEqual(['om_err']);
  });

  it('stays strictly scoped to owned terminal Antigravity and skips started, adopted, ACP, restored, and passed heads', () => {
    // Non-antigravity CLIs keep unchanged 20s behavior
    for (const cliId of ['codex', 'traex', 'pi', 'oh-my-pi', 'cursor', undefined]) {
      const { queue, setNow } = setupQueue();
      queue.mark('om_other', 'other cli prompt', 0);
      queue.confirmPendingTurn('om_other', 0);
      setNow(15_000);
      expect(refreshStructuredPreStartLeaseFromProgramStatus({
        cliId,
        programStatusHeldBusy: true,
        queue,
        nowMs: 15_000,
      })).toBe(0);
      setNow(STRUCTURED_SUBMIT_START_GRACE_MS + 1);
      expect(queue.pruneExpiredPreStartHeads(STRUCTURED_SUBMIT_START_GRACE_MS + 1).map(t => t.turnId)).toEqual(['om_other']);
    }

    // Adopt and ACP (runnerFramedInput) are excluded
    for (const flags of [{ adoptMode: true }, { runnerFramedInput: true }]) {
      const { queue, setNow } = setupQueue();
      queue.mark('om_skip', 'prompt', 0);
      queue.confirmPendingTurn('om_skip', 0);
      setNow(15_000);
      expect(refreshStructuredPreStartLeaseFromProgramStatus({
        cliId: 'antigravity',
        ...flags,
        programStatusHeldBusy: true,
        queue,
        nowMs: 15_000,
      })).toBe(0);
    }

    // Journal-restored turn from a previous worker generation is never refreshed
    {
      const { queue, setNow } = setupQueue();
      queue.mark('om_restored', 'old prompt', 0);
      queue.confirmPendingTurn('om_restored', 0);
      queue.peek()[0]!.restoredFromJournal = true;
      setNow(15_000);
      expect(refreshStructuredPreStartLeaseFromProgramStatus({
        cliId: 'antigravity',
        programStatusHeldBusy: true,
        queue,
        nowMs: 15_000,
      })).toBe(0);
    }

    // Already-started unfinished predecessor prevents refreshing queued successor
    {
      const { queue, setNow } = setupQueue();
      queue.mark('om_1', 'first prompt', 0);
      queue.ingest([{ kind: 'user', text: 'first prompt', uuid: 'u1', timestampMs: 1_000 }]);
      queue.mark('om_2', 'second prompt', 2_000);
      queue.confirmPendingTurn('om_2', 2_000);
      setNow(15_000);
      expect(refreshStructuredPreStartLeaseFromProgramStatus({
        cliId: 'antigravity',
        programStatusHeldBusy: true,
        queue,
        nowMs: 15_000,
      })).toBe(0);
      expect(queue.peek()[1]!.submitConfirmedAtMs).toBe(2_000);
    }
  });
});

describe('Non-Antigravity spawnEnv stays removable by envUnset (cross-CLI regression guard)', () => {
  // These adapters predate OSC 7501. Their spawnEnv defaults were always
  // subject to a configured `envUnset`; applyAdapterSpawnEnv must not report
  // them as adapter-injected keys that filterAppliedAdapterEnvUnset would
  // exempt from removal.
  const NON_AGY = [
    { name: 'kimi', make: () => createKimiAdapter('/bin/kimi'), key: 'PI_PROGRAM_STATUS' },
    { name: 'ebsd', make: () => createEbsdAdapter('/bin/ebsd'), key: 'EBSD_NO_UPDATE_CHECK' },
    { name: 'doubao', make: () => createDoubaoAdapter('/bin/doubao'), key: 'DOUBAO_CLI_NO_UPDATE_CHECK' },
  ] as const;

  for (const c of NON_AGY) {
    it(`${c.name}: reports no protected keys and envUnset still removes its spawnEnv default on pty, strict, and herdr`, () => {
      const adapter = c.make();
      const childEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
      const applied = applyAdapterSpawnEnv(childEnv, adapter, { programStatusEnabled: false });
      // The default is still written into childEnv (Object.assign semantics) ...
      expect(childEnv[c.key]).toBe('1');
      // ... but no key is protected from the user's envUnset.
      expect(applied).toEqual([]);

      const unset = [c.key];
      const filteredUnset = filterAppliedAdapterEnvUnset(unset, applied);
      expect(filteredUnset).toEqual([c.key]);

      // PTY: applySessionEnvUnset deletes the default.
      const ptyEnv = ptyChildEnv({ env: childEnv as Record<string, string>, unsetEnv: filteredUnset });
      expect(ptyEnv[c.key]).toBeUndefined();

      // strict: the key is absent from the `env -i` assignments.
      const strictArgs = strictPaneEnvArgs({
        cwd: '/tmp', cols: 120, rows: 40,
        env: childEnv as Record<string, string>, unsetEnv: filteredUnset,
      });
      expect(strictArgs.some(a => a === `${c.key}=1`)).toBe(false);

      // herdr: the final exec still carries the `-u KEY` removal.
      const herdrCmd = buildHerdrFinalCommand('/bin/x', [], { unsetEnv: filteredUnset });
      expect(herdrCmd).toContain('-u');
      expect(herdrCmd).toContain(c.key);
    });

    it(`${c.name}: keeps the spawnEnv default when envUnset does not name it`, () => {
      const adapter = c.make();
      const childEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
      applyAdapterSpawnEnv(childEnv, adapter, { programStatusEnabled: false });
      const ptyEnv = ptyChildEnv({ env: childEnv as Record<string, string> });
      expect(ptyEnv[c.key]).toBe('1');
    });
  }

  it('antigravity injected OSC 7501 keys are still protected from envUnset while other CLIs are not', () => {
    const adapter = createAntigravityAdapter('/bin/agy');
    const childEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const applied = applyAdapterSpawnEnv(childEnv, adapter, { programStatusEnabled: true });
    expect(applied).toEqual([ANTIGRAVITY_OSC7501_ENV_KEY, ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY]);
    // A user envUnset targeting the inherited host opt-out must not delete the
    // adapter-injected on/brief defaults.
    expect(filterAppliedAdapterEnvUnset([ANTIGRAVITY_OSC7501_ENV_KEY, 'OTHER_VAR'], applied))
      .toEqual(['OTHER_VAR']);
  });
});

describe('Antigravity quiet-flush fireIdle decision (flushedCandidateFinal guard)', () => {
  const flushBase = {
    flushedCandidateFinal: true,
    heldWorking: true,
    hasPendingTasks: false,
    hasActiveStartedTurn: false,
  };

  it('fires idle only when the held candidate was actually flushed and the turn has no other live work', () => {
    // Normal quiet flush: this ingest emitted the candidate's assistant_final.
    expect(shouldFireIdleAfterAntigravityQuietFlush(flushBase)).toBe(true);
  });

  it('does NOT fire idle when the candidate was cleared and this ingest emitted no matching final', () => {
    // A concurrent tool call / follow-up USER_INPUT cleared provisionalFinal;
    // onDrainedEvents saw no assistant_final with the candidate's uuid.
    expect(shouldFireIdleAfterAntigravityQuietFlush({
      ...flushBase,
      flushedCandidateFinal: false,
    })).toBe(false);
  });

  it('does NOT fire idle when a successor USER_INPUT already started another turn', () => {
    expect(shouldFireIdleAfterAntigravityQuietFlush({
      ...flushBase,
      hasActiveStartedTurn: true,
    })).toBe(false);
  });

  it('does NOT fire idle while a background task / subagent remains outstanding', () => {
    expect(shouldFireIdleAfterAntigravityQuietFlush({
      ...flushBase,
      hasPendingTasks: true,
    })).toBe(false);
  });

  it('does NOT fire idle when OSC no longer holds working (nothing stale to release)', () => {
    expect(shouldFireIdleAfterAntigravityQuietFlush({
      ...flushBase,
      heldWorking: false,
    })).toBe(false);
  });

  it('real bridge queue: an unfinished started turn vetoes the idle release even after the candidate flushed', () => {
    let now = 0;
    const queue = new CodexBridgeQueue(() => now);
    queue.mark('om_live', 'live turn', 0);
    // A user record starts the turn; no assistant_final yet -> active started turn.
    queue.ingest([{ kind: 'user', text: 'live turn', uuid: 'u1', timestampMs: 1_000 }]);
    const hasActiveStartedTurn = queue.peek().some(turn => turn.started && turn.finalText === undefined);
    expect(hasActiveStartedTurn).toBe(true);
    expect(shouldFireIdleAfterAntigravityQuietFlush({
      ...flushBase,
      hasActiveStartedTurn,
    })).toBe(false);

    // Once its final lands, the same facts allow the release.
    queue.ingest([{ kind: 'assistant_final', text: 'done', uuid: 'a1', timestampMs: 2_000 }]);
    const stillActive = queue.peek().some(turn => turn.started && turn.finalText === undefined);
    expect(stillActive).toBe(false);
    expect(shouldFireIdleAfterAntigravityQuietFlush({
      ...flushBase,
      hasActiveStartedTurn: stillActive,
    })).toBe(true);
  });
});
