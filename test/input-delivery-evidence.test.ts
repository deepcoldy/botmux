import { describe, expect, it } from 'vitest';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { selectSubmitActivityEvidence } from '../src/services/submit-confirmation.js';
import { createSubmitFailureChainController } from '../src/services/submit-failure-chain.js';

describe('InputDeliveryEvidenceTracker', () => {
  const key = { turnId: 'turn-a', dispatchAttempt: 2, cliGeneration: 3 };

  it('retains the write window and native terminal after live lifecycle settlement', () => {
    const tracker = new InputDeliveryEvidenceTracker();
    tracker.start(key, 100);
    tracker.observeStructuredTerminal(key);
    expect(tracker.hasStructuredTerminal(key)).toBe(true);
    expect(tracker.writeStartedAtMs(key)).toBe(100);
  });

  it('recognizes replies sent while the adapter is still waiting for history', () => {
    const tracker = new InputDeliveryEvidenceTracker();
    tracker.start(key, 100);
    const markers = [{ ...key, sentAtMs: 150 }];
    const baseline = tracker.writeStartedAtMs(key) ?? 200;
    expect(selectSubmitActivityEvidence({
      target: key,
      ptyActive: false,
      structuredTurns: [],
      sendMarkers: markers.filter(marker => marker.sentAtMs >= baseline),
    })).toBe('botmux-send');
    expect(selectSubmitActivityEvidence({
      target: key,
      ptyActive: false,
      structuredTurns: [],
      sendMarkers: [{ ...key, sentAtMs: 99 }].filter(marker => marker.sentAtMs >= baseline),
    })).toBeUndefined();
  });

  it.each([
    { ...key, turnId: 'turn-b' },
    { ...key, dispatchAttempt: 1 },
    { ...key, dispatchAttempt: undefined },
    { ...key, cliGeneration: 4 },
  ])('does not inherit a different identity: %j', other => {
    const tracker = new InputDeliveryEvidenceTracker();
    tracker.start(key, 100);
    tracker.observeStructuredTerminal(key);
    expect(tracker.hasStructuredTerminal(other)).toBe(false);
    expect(tracker.writeStartedAtMs(other)).toBeUndefined();
  });

  it('does not mistake a synthetic delivery terminal for native receipt evidence', () => {
    const tracker = new InputDeliveryEvidenceTracker();
    const warnings = createSubmitFailureChainController();
    tracker.start(key, 100);
    warnings.observeTerminal(key); // failed/ambiguous worker notification
    expect(tracker.hasStructuredTerminal(key)).toBe(false);
    warnings.clear();
  });

  it('starts a fresh window for a literal rewrite of the same identity', () => {
    const tracker = new InputDeliveryEvidenceTracker();
    tracker.start(key, 100);
    tracker.observeStructuredTerminal(key);
    tracker.start(key, 200);
    expect(tracker.hasStructuredTerminal(key)).toBe(false);
    expect(tracker.writeStartedAtMs(key)).toBe(200);
  });

  it('records a native terminal without inventing an unknown write time', () => {
    const tracker = new InputDeliveryEvidenceTracker();
    tracker.observeStructuredTerminal(key);
    expect(tracker.hasStructuredTerminal(key)).toBe(true);
    expect(tracker.writeStartedAtMs(key)).toBeUndefined();
    tracker.start({ cliGeneration: 3 }, 100);
    tracker.start({ ...key, turnId: 'invalid' }, NaN);
    expect(tracker.hasStructuredTerminal({ cliGeneration: 3 })).toBe(false);
    expect(tracker.writeStartedAtMs({ ...key, turnId: 'invalid' })).toBeUndefined();
  });

  it('evicts old identities conservatively and clears everything on replacement', () => {
    const tracker = new InputDeliveryEvidenceTracker(2);
    tracker.start(key, 100);
    tracker.observeStructuredTerminal(key);
    tracker.start({ ...key, turnId: 'second' }, 200);
    tracker.start({ ...key, turnId: 'third' }, 300);
    expect(tracker.hasStructuredTerminal(key)).toBe(false);
    expect(tracker.writeStartedAtMs(key)).toBeUndefined();
    tracker.clear();
    expect(tracker.writeStartedAtMs({ ...key, turnId: 'third' })).toBeUndefined();
  });
});
