import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { WorkerFinalOutput } from '../types.js';

/** Filesystem key for per-app journals/stores. Containment, not an id-shape
 *  whitelist, is the security boundary here: the configured app id space is
 *  owned by the registry/Feishu protocol edges (`cli_…`, synthesized
 *  `local_<slug>` where the slug permits dots), and these stores must stay
 *  constructible for every safe basename. Rejects path traversal, leading
 *  dots (`.`/`..`), whitespace and control characters in either direction. */
export function isOutputJournalAppId(appId: unknown): appId is string {
  return typeof appId === 'string'
    && appId.length > 0 && appId.length <= 128
    && appId === basename(appId)
    && !appId.includes('\\')
    && !appId.startsWith('.')
    && !/[\s\0]/.test(appId);
}

export interface OutputHandoffClaim {
  version: 2;
  id: string;
  fingerprint: string;
  token: string;
}
export interface OutputHandoffReceipt {
  type: 'final_output_settled';
  id: string;
  fingerprint: string;
  token: string;
}
export interface OutputSnapshot {
  version: 2;
  id: string;
  fingerprint: string;
  output: WorkerFinalOutput;
  createdAt: number;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

/** Keep the native correlation in the envelope, but exclude request-scoped
 * ACK addresses from the stable effect identity. */
export function outputSnapshot(appId: string, output: WorkerFinalOutput, now = Date.now()): OutputSnapshot {
  if (!boundedId(appId) || !boundedId(output.sessionId) || !boundedId(output.turnId) || !boundedId(output.lastUuid)
    || typeof output.content !== 'string' || (output.dispatchAttempt !== undefined && !Number.isSafeInteger(output.dispatchAttempt))) {
    throw new Error('invalid_output_snapshot');
  }
  const { handoff: _claim, ...frozen } = structuredClone(output);
  const canonical = structuredClone(frozen);
  if (canonical.codexAppSettlement) {
    canonical.codexAppSettlement.requestId = '';
    delete canonical.codexAppSettlement.completedAtMs;
    delete canonical.codexAppSettlement.durationMs;
  }
  delete canonical.usage;
  if (canonical.codexAppSettlement) { canonical.lastUuid = ""; canonical.content = ""; delete canonical.suppressDelivery; }
  delete canonical.durationMs;
  delete canonical.executionStartedAtMs;
  const native = canonical.codexAppSettlement;
  const key = [appId, frozen.sessionId, frozen.turnId, frozen.dispatchAttempt ?? null,
    native ? [native.generation, native.seq, native.dispatchId] : frozen.lastUuid, frozen.kind ?? 'bridge'];
  return { version: 2,
    id: createHash('sha256').update(JSON.stringify(key)).digest('hex'),
    fingerprint: createHash('sha256').update(JSON.stringify(canonical, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex'),
    output: frozen, createdAt: now };
}

export function validateOutputSnapshot(appId: string, snapshot: OutputSnapshot): OutputSnapshot {
  const expected = outputSnapshot(appId, snapshot.output, snapshot.createdAt);
  if (snapshot.version !== 2 || snapshot.id !== expected.id || snapshot.fingerprint !== expected.fingerprint) throw new Error('output_snapshot_conflict');
  return expected;
}

/** A native final may be re-emitted as empty after its explicit publication.
 * Keep the first body; only its authenticated callback address and suppression
 * can change. Other content changes remain conflicts. */
export function mergeOutputReplay(previous: OutputSnapshot, next: OutputSnapshot): OutputSnapshot {
  if (previous.id !== next.id || previous.fingerprint !== next.fingerprint) throw new Error('output_handoff_payload_conflict');
  const native = next.output.codexAppSettlement;
  if (!native || !previous.output.codexAppSettlement) return previous;
  if (previous.output.content !== next.output.content && !(next.output.suppressDelivery === true && next.output.content === '')) throw new Error('output_handoff_payload_conflict');
  return { ...previous, output: { ...previous.output,
    codexAppSettlement: { ...previous.output.codexAppSettlement, requestId: native.requestId },
    ...((previous.output.suppressDelivery || next.output.suppressDelivery) ? { suppressDelivery: true } : {}),
  } };
}

/** Covers every final_output producer. Backend-specific ACKs remain intact;
 * this receipt retires only the generic output recovery copy. */
export class UniversalOutputHandoff {
  private readonly pending = new Map<string, OutputSnapshot>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly deps: {
    appId: string;
    sessionId: string;
    token: string;
    persist(snapshot: OutputSnapshot): void;
    remove(snapshot: OutputSnapshot): void;
    restore(): OutputSnapshot[];
    send(output: WorkerFinalOutput): void;
    error(error: unknown): void;
    retryMs?: number;
  }) {}

  publish(output: WorkerFinalOutput): void {
    if (this.stopped || output.sessionId !== this.deps.sessionId) throw new Error('output_handoff_session_mismatch');
    let snapshot = outputSnapshot(this.deps.appId, output);
    const previous = this.pending.get(snapshot.id);
    if (previous) snapshot = mergeOutputReplay(previous, snapshot);
    this.pending.set(snapshot.id, snapshot);
    try { this.deps.persist(snapshot); }
    catch (error) { this.arm(); throw error; }
    this.transmit(snapshot);
    this.arm();
  }

  start(): void {
    for (const stored of this.deps.restore()) {
      const snapshot = validateOutputSnapshot(this.deps.appId, stored);
      if (snapshot.output.sessionId !== this.deps.sessionId) throw new Error('output_handoff_session_mismatch');
      this.pending.set(snapshot.id, snapshot);
      this.transmit(snapshot);
    }
    this.arm();
  }

  acknowledge(receipt: OutputHandoffReceipt): boolean {
    const snapshot = this.pending.get(receipt.id);
    if (this.stopped || !snapshot || receipt.token !== this.deps.token || receipt.fingerprint !== snapshot.fingerprint) return false;
    this.deps.remove(snapshot);
    this.pending.delete(receipt.id);
    if (!this.pending.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return true;
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  private transmit(snapshot: OutputSnapshot): void {
    try { this.deps.send({ ...snapshot.output, handoff: { version: 2, id: snapshot.id, fingerprint: snapshot.fingerprint, token: this.deps.token } }); }
    catch (error) { this.deps.error(error); }
  }
  private arm(): void {
    if (this.stopped || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; for (const snapshot of this.pending.values()) { try { this.deps.persist(snapshot); this.transmit(snapshot); } catch (error) { this.deps.error(error); } } this.arm(); }, this.deps.retryMs ?? 5_000);
    this.timer.unref?.();
  }
}
