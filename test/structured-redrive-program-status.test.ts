/**
 * A Claude session's opening turn was reclaimed while it was running.
 *
 * Production (2026-11-11, session 9b5984ae): the opening message was still
 * being typed into Claude's composer when the idle detector reported a prompt;
 * that ready was deferred until the write settled. Claude then took the input
 * and reported `working` over OSC 7501 (16:38:21.5) and sent its first model
 * request. When the write settled (16:38:22.9) the deferred ready was
 * replayed through the busy-marker screen probe. botmux's statusLine keeps
 * Claude from drawing its busy footer, so the probe saw no busy marker and
 * marked the prompt ready: the turn's authority was released and the daemon
 * saw an idle session, which the live-worker cap suspended 1.4 s later.
 *
 * The real `redriveRejectedStructuredReady`, `probeBusyPatternIdle` and the
 * post-submit probe loop from src/worker.ts, the real CLI adapters and the
 * real IdleDetector; only the worker's surroundings (backend, screen, PTY
 * output generation) are given.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { busyProbeRegion } from '../src/utils/busy-probe.js';
import { BusyReadyFallbackGate } from '../src/utils/busy-ready-fallback.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/** Claude at its composer while it works: the statusLine row replaces the
 *  「esc to interrupt」 footer, so no busy marker is on screen. */
const CLAUDE_WORKING_WITHOUT_BUSY_FOOTER = [
  ' ✳ Cogitating…',
  '─'.repeat(60),
  '❯ ',
  '─'.repeat(60),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '  botmux · session 9b5984ae',
].join('\n');
const PI_AT_PROMPT = ['> tool output', '', '─'.repeat(40), '> ', '─'.repeat(40), ' ~/repo  claude-sonnet'].join('\n');

function worker(cliId: CliId, screen: string) {
  const adapter = createCliAdapterSync(cliId);
  const detector = new IdleDetector(adapter);
  const idleEdges: string[] = [];
  detector.onIdle(source => { idleEdges.push(source); });
  const markPromptReady = vi.fn(() => { scope.isPromptReady = true; });
  const backend = { captureCurrentScreen: () => screen };
  const scope: Record<string, unknown> = {
    // Deferred while the write was in flight; the CLI has printed since.
    structuredRejectedReadyEvidenceGeneration: 1,
    ptyOutputGeneration: { isCurrent: () => false },
    backend,
    isPromptReady: false,
    idleDetector: detector,
    cliAdapter: adapter,
    sessionId: 'sid-9b5984ae',
    lastSpawnEffectiveCliSessionId: undefined,
    lastInitConfig: { cliId },
    backendScreenRevision: 1,
    bridgeJsonlPath: undefined,
    // The turn's transcript is not holding readiness back here.
    hasStructuredLifecycleBlock: () => false,
    codexBridgeQueue: { preStartLeaseRemainingMs: () => undefined },
    stopStructuredStartGraceRecheck: () => {},
    scheduleStructuredStartGraceRecheck: () => {},
    pruneExpiredStructuredHeadsAndEmit: () => false,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    canCaptureBusyPatternScreen: () => true,
    captureBackendScreen: (be: typeof backend) => be.captureCurrentScreen(),
    cliProcessAliveProbe: () => () => true,
    cliProcessAliveFromBackend: () => true,
    busyProbeRegion,
    stripAnsiScreenText: (text: string) => text,
    reattachedTurnStillOpen: () => false,
    busyPatternIdleProbeTimer: null,
    IDLE_PROBE_INTERVAL_MS: 3_500,
    busyReadyFallbackGate: new BusyReadyFallbackGate(() => ({ fallbackMs: 17_500, stableScreenMs: 7_000 })),
    markPromptReady,
    log: () => {},
  };
  for (const name of ['probeBusyPatternIdle', 'stopBusyPatternIdleProbe', 'maybeForceReadyOnStaleBusyMarker',
    'scheduleBusyPatternIdleProbe']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  const redrive = loadWorkerFunction<() => void>('redriveRejectedStructuredReady', scope);
  return { detector, idleEdges, markPromptReady, redrive, scope };
}

describe('replaying a prompt-ready deferred by an in-flight write', () => {
  it('does not mark a turn ready that the CLI reported working after the deferral', () => {
    const { detector, idleEdges, markPromptReady, redrive, scope } = worker('claude-code', CLAUDE_WORKING_WITHOUT_BUSY_FOOTER);
    // 16:38:21.5: Claude took the input and reports working.
    detector.observeProgramStatus({ state: 'working' });

    // 16:38:22.9: the write settles and replays the deferred ready.
    redrive();

    expect(markPromptReady).not.toHaveBeenCalled();
    expect(scope.structuredRejectedReadyEvidenceGeneration).toBeUndefined();
    expect(idleEdges).toEqual([]);

    // The turn ends when Claude says so.
    detector.observeProgramStatus({ state: 'idle' });
    expect(idleEdges).toEqual(['program-status']);
  });

  it('does not mark it ready while the CLI waits on a permission prompt either', () => {
    const { detector, markPromptReady, redrive } = worker('claude-code', CLAUDE_WORKING_WITHOUT_BUSY_FOOTER);
    detector.observeProgramStatus({ state: 'blocked', kind: 'permission' });

    redrive();

    expect(markPromptReady).not.toHaveBeenCalled();
  });

  it('still replays it when the CLI reported no work since', () => {
    const { detector, markPromptReady, redrive } = worker('claude-code', CLAUDE_WORKING_WITHOUT_BUSY_FOOTER);
    detector.observeProgramStatus({ state: 'working' });
    detector.observeProgramStatus({ state: 'idle' });

    redrive();

    expect(markPromptReady).toHaveBeenCalledTimes(1);
  });

  it('still replays it for a CLI that reports no program status', () => {
    const { markPromptReady, redrive } = worker('claude-code', CLAUDE_WORKING_WITHOUT_BUSY_FOOTER);

    redrive();

    expect(markPromptReady).toHaveBeenCalledTimes(1);
  });

  it('leaves a Pi session whose idle report was lost to the post-submit probe, which still releases it', () => {
    vi.useFakeTimers();
    try {
      const { detector, markPromptReady, redrive, scope } = worker('pi', PI_AT_PROMPT);
      detector.observeProgramStatus({ state: 'working', app: 'pi' });
      // The submit armed the probe loop; the `idle` report never comes.
      (scope.scheduleBusyPatternIdleProbe as (source: string) => void)('pi post-submit');

      redrive();
      expect(markPromptReady).not.toHaveBeenCalled();

      // Pi's screen shows no busy marker: its probe ends the wait.
      vi.advanceTimersByTime((scope.IDLE_PROBE_INTERVAL_MS as number) + 100);
      expect(markPromptReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
