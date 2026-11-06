import type { SubmitFailureChainKey } from './submit-failure-chain.js';
import { submitFailureChainKeyOf } from './submit-failure-chain.js';

type Evidence = { writeStartedAtMs?: number; structuredTerminal: boolean };

/**
 * Evidence can arrive while an adapter is still awaiting its history receipt.
 * Retain it independently of live bridge marks and execution timings, which
 * are consumed at completion. Only native structured terminals belong here;
 * worker-synthesized failure/ambiguous terminals do not prove input delivery.
 */
export class InputDeliveryEvidenceTracker {
  private readonly evidence = new Map<string, Evidence>();

  constructor(private readonly maxTracked = 512) {
    if (!Number.isInteger(maxTracked) || maxTracked < 1) {
      throw new Error('maxTracked must be a positive integer');
    }
  }

  start(key: SubmitFailureChainKey, atMs: number = Date.now()): void {
    if (!key.turnId || !Number.isFinite(atMs)) return;
    // A new literal write is a new evidence window, even for a reused id.
    this.remember(key, { writeStartedAtMs: atMs, structuredTerminal: false });
  }

  observeStructuredTerminal(key: SubmitFailureChainKey): void {
    if (!key.turnId) return;
    this.remember(key, {
      ...this.evidence.get(submitFailureChainKeyOf(key)),
      structuredTerminal: true,
    });
  }

  hasStructuredTerminal(key: SubmitFailureChainKey): boolean {
    return !!key.turnId && this.evidence.get(submitFailureChainKeyOf(key))?.structuredTerminal === true;
  }

  writeStartedAtMs(key: SubmitFailureChainKey): number | undefined {
    return key.turnId ? this.evidence.get(submitFailureChainKeyOf(key))?.writeStartedAtMs : undefined;
  }

  clear(): void {
    this.evidence.clear();
  }

  private remember(key: SubmitFailureChainKey, evidence: Evidence): void {
    const encoded = submitFailureChainKeyOf(key);
    this.evidence.delete(encoded);
    this.evidence.set(encoded, evidence);
    while (this.evidence.size > this.maxTracked) {
      const oldest = this.evidence.keys().next().value;
      if (oldest === undefined) break;
      this.evidence.delete(oldest);
    }
  }
}
