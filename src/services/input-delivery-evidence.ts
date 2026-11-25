import type { SubmitFailureChainKey } from './submit-failure-chain.js';
import { submitFailureChainKeyOf } from './submit-failure-chain.js';

export interface AuthoritativeInputReceipt {
  evidence: 'structured-transcript' | 'botmux-send';
  cliSessionId?: string;
  /** Claude transcript provenance, used to reject already-retired secondary
   *  files when retained evidence is probed after a rotation. */
  sourceJsonlPath?: string;
}

type Evidence = {
  writeStartedAtMs?: number;
  externalInputGeneration?: number;
  interruptGeneration?: number;
  structuredTerminal: boolean;
  authoritativeReceipt?: AuthoritativeInputReceipt;
};

/** A persistent reattach does not execute the configured resume target, so that
 * target is not proof of the pane's live native conversation. Wait for an owned
 * observation instead of mistaking the first config correction for a rotation. */
export function inputDeliveryObservedSessionIdAtSpawn(
  willReattachPersistent: boolean,
  effectiveCliSessionId?: string,
): string | undefined {
  return willReattachPersistent ? undefined : effectiveCliSessionId;
}

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

  start(key: SubmitFailureChainKey, atMs: number = Date.now(), externalInputGeneration?: number, interruptGeneration?: number): void {
    if (!key.turnId || !Number.isFinite(atMs)) return;
    // A new literal write is a new evidence window, even for a reused id.
    this.remember(key, {
      writeStartedAtMs: atMs,
      externalInputGeneration,
      interruptGeneration,
      structuredTerminal: false,
      authoritativeReceipt: undefined,
    });
  }

  observeAuthoritativeReceipt(
    key: SubmitFailureChainKey,
    receipt: AuthoritativeInputReceipt,
  ): void {
    if (!key.turnId) return;
    const prev = this.evidence.get(submitFailureChainKeyOf(key));
    const prevReceipt = prev?.authoritativeReceipt;
    const evidence: AuthoritativeInputReceipt['evidence'] =
      prevReceipt?.evidence === 'structured-transcript' || receipt.evidence === 'structured-transcript'
        ? 'structured-transcript'
        : receipt.evidence;
    // An authoritative transcript rebind may correct an early sibling bind while
    // the adapter write is still pending. Prefer the newest receipt's owned id;
    // only retain the old one when the newer proof carries no id at all.
    const cliSessionId = receipt.cliSessionId ?? prevReceipt?.cliSessionId;
    const sourceJsonlPath = receipt.sourceJsonlPath ?? prevReceipt?.sourceJsonlPath;
    this.remember(key, {
      structuredTerminal: false,
      ...prev,
      authoritativeReceipt: {
        evidence,
        ...(cliSessionId ? { cliSessionId } : {}),
        ...(sourceJsonlPath ? { sourceJsonlPath } : {}),
      },
    });
  }

  authoritativeReceipt(key: SubmitFailureChainKey): AuthoritativeInputReceipt | undefined {
    return key.turnId ? this.evidence.get(submitFailureChainKeyOf(key))?.authoritativeReceipt : undefined;
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

  externalInputGenerationAtWrite(key: SubmitFailureChainKey): number | undefined {
    return key.turnId ? this.evidence.get(submitFailureChainKeyOf(key))?.externalInputGeneration : undefined;
  }

  interruptGenerationAtWrite(key: SubmitFailureChainKey): number | undefined {
    return key.turnId ? this.evidence.get(submitFailureChainKeyOf(key))?.interruptGeneration : undefined;
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
