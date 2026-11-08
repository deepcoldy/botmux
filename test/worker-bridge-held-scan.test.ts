import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  BridgeTurnQueue,
  BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS,
  BRIDGE_HELD_FINGERPRINT_SCAN_MIN_INTERVAL_MS,
  isHeldInCliQueue,
  isHeldPendingMark,
  makeFingerprint,
  normaliseForFingerprint,
} from '../src/services/bridge-turn-queue.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';

// The worker's fingerprint fallback for an input Claude's own transcript shows
// queued: it still scans (an in-pane /clear while it waits moves it), but far
// less often than for an input with no trace.
const TEXT = '<user_message>continue the task in this topic</user_message>';
afterEach(() => { vi.useRealTimers(); });

function fixture(held: boolean) {
  vi.useFakeTimers({ now: Date.parse('2026-11-02T10:00:00Z') });
  const queue = new BridgeTurnQueue();
  queue.mark('t1', makeFingerprint(TEXT), Date.now(), normaliseForFingerprint(TEXT));
  if (held) {
    queue.ingest([{ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: TEXT } as unknown as TranscriptEvent]);
  }
  expect(isHeldInCliQueue(queue.peek()[0])).toBe(held);
  let scans = 0;
  const scope: Record<string, unknown> = {
    bridgeJsonlDir: '/nowhere', bridgeJsonlPath: '/nowhere/own.jsonl', bridgeQueue: queue,
    bridgeFingerprintScanLastMs: new Map<string, number>(),
    // The real production constants: a copy here would stay green while the
    // worker's own values drifted (the harness resolves free names from scope).
    BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS,
    BRIDGE_HELD_FINGERPRINT_SCAN_MIN_INTERVAL_MS,
    isHeldPendingMark, bridgeKnownSessionIds: new Set<string>(),
    decideFingerprintSwitch: () => { scans += 1; return { action: 'no-match' }; },
    findJsonlContainingFingerprint: () => null, findJsonlsContainingExactContent: () => [],
    bridgeApplyFingerprintSwitch: () => {}, log: () => {},
  };
  const scan = loadWorkerFunction<() => boolean>('maybeSwitchBridgeJsonl', scope);
  return { scanFor: (ms: number) => { for (let t = 0; t <= ms; t += 1_000) { scan(); vi.advanceTimersByTime(1_000); } return scans; } };
}

describe('worker fingerprint fallback while Claude holds the input in its queue', () => {
  it('scans a held input once a minute instead of every 10 seconds', () => {
    expect(fixture(true).scanFor(120_000)).toBe(3);
    expect(fixture(false).scanFor(120_000)).toBe(13);
  });

  it('keeps the held interval strictly wider than the normal interval', () => {
    expect(BRIDGE_HELD_FINGERPRINT_SCAN_MIN_INTERVAL_MS)
      .toBeGreaterThan(BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS);
  });
});
