import { createHash } from 'node:crypto';

/** First slice: one ordinary IM transcript final, with no upload effects. */
export interface HandoffFinalOutput {
  sessionId: string;
  turnId: string;
  lastUuid: string;
  content: string;
}

export interface FinalOutputSnapshot {
  intentId: string;
  fingerprint: string;
  output: HandoffFinalOutput;
}

export interface FinalOutputOffer extends FinalOutputSnapshot {
  type: 'final_output_offer';
  version: 1;
  token: string;
}

export interface FinalOutputAccepted {
  type: 'final_output_accepted';
  intentId: string;
  fingerprint: string;
  token: string;
}

export const FINAL_OUTPUT_HANDOFF_MAX_BYTES = 8 * 1024;
export const FINAL_OUTPUT_HANDOFF_MAX_PENDING = 32;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
}

export function canHandoffFinalOutput(value: unknown): value is HandoffFinalOutput {
  if (!value || typeof value !== 'object') return false;
  const v = value as HandoffFinalOutput;
  return text(v.sessionId) && text(v.turnId) && v.turnId.startsWith('om_') && text(v.lastUuid)
    && typeof v.content === 'string' && v.content.trim().length > 0
    && Buffer.byteLength(v.content) <= FINAL_OUTPUT_HANDOFF_MAX_BYTES
    // Uploads and embedded images require a multi-effect delivery plan.
    && !/!\[|<img\b|<image\b/i.test(v.content);
}

export function finalOutputSnapshot(appId: string, value: HandoffFinalOutput): FinalOutputSnapshot {
  if (!text(appId) || !canHandoffFinalOutput(value)) throw new Error('invalid_final_output_handoff');
  const output = { sessionId: value.sessionId, turnId: value.turnId, lastUuid: value.lastUuid, content: value.content };
  return {
    intentId: createHash('sha256').update(JSON.stringify([appId, output.sessionId, output.turnId, output.lastUuid])).digest('hex'),
    fingerprint: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    output,
  };
}

export function validateFinalOutputSnapshot(appId: string, snapshot: FinalOutputSnapshot): FinalOutputSnapshot {
  const expected = finalOutputSnapshot(appId, snapshot?.output);
  if (snapshot.intentId !== expected.intentId || snapshot.fingerprint !== expected.fingerprint) {
    throw new Error('final_output_handoff_identity_mismatch');
  }
  return expected;
}

/** Worker retries only the frozen output. Business prompts are never replayed. */
export class WorkerFinalOutputHandoff {
  private readonly pending = new Map<string, FinalOutputSnapshot>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly deps: {
    appId: string;
    sessionId: string;
    token: string;
    persist(snapshot: FinalOutputSnapshot): void;
    clear(snapshot: FinalOutputSnapshot): void;
    send(offer: FinalOutputOffer): void;
    accepted(snapshot: FinalOutputSnapshot): void;
    error(error: unknown): void;
    retryMs?: number;
  }) {}

  offer(output: HandoffFinalOutput): void {
    if (this.stopped || output.sessionId !== this.deps.sessionId) throw new Error('final_output_handoff_session_mismatch');
    const snapshot = finalOutputSnapshot(this.deps.appId, output);
    const previous = this.pending.get(snapshot.intentId);
    if (previous && previous.fingerprint !== snapshot.fingerprint) throw new Error('final_output_handoff_conflict');
    if (!previous && this.pending.size >= FINAL_OUTPUT_HANDOFF_MAX_PENDING) throw new Error('final_output_handoff_backpressure');
    // This write must succeed before ownership is transferred or IPC is sent.
    this.deps.persist(snapshot);
    this.pending.set(snapshot.intentId, snapshot);
    this.transmit(snapshot);
    this.arm();
  }

  restore(snapshots: readonly FinalOutputSnapshot[]): void {
    for (const snapshot of snapshots) {
      const verified = validateFinalOutputSnapshot(this.deps.appId, snapshot);
      if (verified.output.sessionId !== this.deps.sessionId) throw new Error('final_output_handoff_session_mismatch');
      if (this.pending.size >= FINAL_OUTPUT_HANDOFF_MAX_PENDING) throw new Error('final_output_handoff_backpressure');
      this.pending.set(verified.intentId, verified);
      this.transmit(verified);
    }
    this.arm();
  }

  hasTurn(turnId: string): boolean {
    return [...this.pending.values()].some(snapshot => snapshot.output.turnId === turnId);
  }
  size(): number { return this.pending.size; }

  acknowledge(receipt: FinalOutputAccepted): boolean {
    const snapshot = this.pending.get(receipt.intentId);
    if (this.stopped || receipt.token !== this.deps.token || !snapshot || receipt.fingerprint !== snapshot.fingerprint) return false;
    // If cleanup fails, retain the pending entry and retry the exact offer.
    this.deps.clear(snapshot);
    this.pending.delete(snapshot.intentId);
    this.deps.accepted(snapshot);
    if (this.pending.size === 0 && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Disk remains the successor's recovery owner.
  }

  private transmit(snapshot: FinalOutputSnapshot): void {
    try { this.deps.send({ type: 'final_output_offer', version: 1, token: this.deps.token, ...snapshot }); }
    catch (error) { this.deps.error(error); }
  }

  private arm(): void {
    if (this.timer || this.stopped || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const snapshot of this.pending.values()) this.transmit(snapshot);
      this.arm();
    }, this.deps.retryMs ?? 5_000);
    this.timer.unref?.();
  }
}
