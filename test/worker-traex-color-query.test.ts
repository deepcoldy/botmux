import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { isTerminalColorQueryOnly } from '../src/core/terminal-color-query.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const QUERY = '\x1b]11;?\x1b\\';
const COMPOSER = [
  '──────────────────────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything',
  '──────────────────────────────────────────────────────────',
  '  GPT-6-Astra · /tmp/test · Context —',
  '  ☢ Full Access · ? for shortcuts · ← for agents',
].join('\n');

const detectors: IdleDetector[] = [];
afterEach(() => { for (const d of detectors.splice(0)) d.dispose(); vi.useRealTimers(); });

function harness(cliId = 'traex') {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const detector = new IdleDetector(createTraexAdapter('/bin/true'));
  detectors.push(detector);
  const idle = vi.fn();
  detector.onIdle(idle);
  const relay = vi.fn();
  const scope: Record<string, any> = {
    lastInitConfig: { cliId }, isTerminalColorQueryOnly,
    splitCodexAppControl: (data: string) => data,
    backendScreenRevision: 0, lastPtyActivityAtMs: 0, lastPtyOutputAtMs: 0,
    maybeReportDeferredTopicMaterialization: vi.fn(), maybeCaptureKiroSessionId: vi.fn(),
    maybeReportPiInstallChange: vi.fn(), captureWorkflowTranscript: vi.fn(),
    spawnArgvNeedsWorkingSeed: false,
    renderer: { write: vi.fn(), rawSnapshot: () => COMPOSER },
    refreshHookReviewInputHold: vi.fn(),
    isTmuxMode: true, isPipeMode: true, usesHerdrSnapshotWebHistory: () => false,
    ALT_ENTER_RE: /\x1b\[\?1049h/g, ALT_EXIT_RE: /\x1b\[\?1049l/g,
    altBufferActive: false, scrollback: '', MAX_SCROLLBACK: 100_000,
    wsClients: new Set([{ readyState: 1, send: relay }]), WebSocket: { OPEN: 1 },
    handleVisibleStartupInteraction: () => false,
    switchConfirmGuard: { isArmed: () => false }, btwCaptureGuard: { isArmed: () => false },
    ptyOutputGeneration: { observe: vi.fn() }, ptyOutputSeenThisSpawn: false,
    idleDetector: detector, observeRestoredStartupHistory: vi.fn(),
  };
  const feed = loadWorkerFunction<(data: string) => void>('handlePtyDataChunk', scope);
  return { scope, detector, idle, relay, feed };
}

describe('TRAE output-side color polling', () => {
  it('preserves real renderer/relay bytes without starving idle or viewport quiet evidence', async () => {
    const h = harness();
    h.feed(COMPOSER);
    const revision = h.scope.backendScreenRevision;
    const lastDraw = h.scope.lastPtyOutputAtMs;
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      h.feed(QUERY);
    }
    expect(h.idle).toHaveBeenCalledTimes(1);
    expect(h.detector.isIdleNow()).toBe(true);
    expect(h.scope.backendScreenRevision).toBe(revision);
    expect(h.scope.lastPtyOutputAtMs).toBe(lastDraw);
    expect(h.scope.lastPtyActivityAtMs).toBe(Date.now());
    expect(h.scope.ptyOutputGeneration.observe).toHaveBeenCalledTimes(1);
    expect(h.relay.mock.calls.flat()).toEqual([COMPOSER, ...Array(7).fill(QUERY)]);
    expect(h.scope.renderer.write.mock.calls.flat()).toEqual([COMPOSER, ...Array(7).fill(QUERY)]);
    expect(h.scope.scrollback).toBe(COMPOSER + QUERY.repeat(7));
  });

  it('never manufactures ready evidence from color queries alone', async () => {
    const h = harness();
    for (let i = 0; i < 7; i++) { h.feed(QUERY); await vi.advanceTimersByTimeAsync(1000); }
    expect(h.idle).not.toHaveBeenCalled();
    expect(h.scope.ptyOutputSeenThisSpawn).toBe(false);
  });

  it.each(['working', 'blocked'] as const)('does not override native %s authority', async state => {
    const h = harness();
    h.detector.reset({ inputCycle: true });
    h.detector.observeProgramStatus({ state });
    h.feed(COMPOSER);
    for (let i = 0; i < 7; i++) { h.feed(QUERY); await vi.advanceTimersByTimeAsync(1000); }
    expect(h.idle).not.toHaveBeenCalled();
    expect(h.detector.programStatusHeldBusy()).toBe(true);
    expect(h.detector.lastProgramStatusReport()).toBe(state);
  });

  it.each([
    QUERY + 'draft', '\x1b[2J', '\x1b]11;rgb:ffff/ffff/ffff\x07', '\x1b]11;?',
  ])('retains revision and quiet-window fences for %j', async data => {
    const h = harness();
    h.feed(COMPOSER);
    for (let i = 0; i < 7; i++) { await vi.advanceTimersByTimeAsync(1000); h.feed(data); }
    expect(h.idle).not.toHaveBeenCalled();
    expect(h.scope.backendScreenRevision).toBe(8);
    expect(h.scope.lastPtyOutputAtMs).toBe(Date.now());
  });

  it('leaves other CLI output policy unchanged', async () => {
    const h = harness('claude-code');
    h.feed(COMPOSER);
    for (let i = 0; i < 7; i++) { await vi.advanceTimersByTimeAsync(1000); h.feed(QUERY); }
    expect(h.idle).not.toHaveBeenCalled();
    expect(h.scope.backendScreenRevision).toBe(8);
    expect(h.scope.lastPtyOutputAtMs).toBe(Date.now());
    expect(h.relay).toHaveBeenCalledTimes(8);
  });
});
