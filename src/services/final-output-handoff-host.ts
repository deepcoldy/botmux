import { FinalOutputHandoffStore, type StoredFinalOutput } from './final-output-handoff-store.js';
import { PROVIDER_TTL_MS } from '../workflows/shared/provider-reconciler.js';

export class FinalOutputRejectedError extends Error {}

export interface FinalOutputDeliveryControl {
  owns(): boolean;
  beforeEffect(): void;
}

/** The durable accept boundary lives in the store; this coordinator only owns
 * bounded claims and projection callbacks. It never re-submits CLI input. */
export class FinalOutputHandoffHost {
  private readonly running = new Map<string, Promise<void>>();
  private cursor?: { createdAt: number; intentId: string };
  constructor(readonly store: FinalOutputHandoffStore, private readonly deps: {
    available(record: StoredFinalOutput): 'ready' | 'wait' | 'cancelled';
    deliver(record: StoredFinalOutput, control: FinalOutputDeliveryControl): Promise<{ messageId: string; suppressed?: boolean }>;
    error(record: StoredFinalOutput, error: unknown): void;
    knownReceipt?(record: StoredFinalOutput): { messageId: string; suppressed?: boolean } | undefined;
    settled?(record: StoredFinalOutput): void;
    now?: () => number;
  }) {}

  async pump(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    let records = this.store.pending(now, this.cursor);
    if (records.length === 0 && this.cursor) { this.cursor = undefined; records = this.store.pending(now); }
    const last = records.at(-1);
    if (last) this.cursor = { createdAt: last.createdAt, intentId: last.intentId };
    await Promise.all(records.map(record => this.run(record.intentId)));
  }

  run(id: string): Promise<void> {
    const prior = this.running.get(id);
    if (prior) return prior;
    const result = this.deliver(id).finally(() => { if (this.running.get(id) === result) this.running.delete(id); });
    this.running.set(id, result);
    return result;
  }

  private async deliver(id: string): Promise<void> {
    const now = () => this.deps.now?.() ?? Date.now();
    const current = this.store.read(id);
    if (!current || !['prepared', 'attempting'].includes(current.state)) return;
    const known = this.deps.knownReceipt?.(current);
    const availability = this.deps.available(current);
    if (availability === 'wait' && !known) return;
    const record = this.store.claim(id, now());
    if (!record?.claim) return;
    const claim = record.claim;
    if (known) {
      try { this.store.settle(id, claim, known.suppressed ? 'suppressed' : 'delivered', { messageId: known.messageId }, now()); this.notifySettled(record); }
      catch (error) { this.store.release(id, claim, now() + 5_000); this.deps.error(record, error); }
      return;
    }
    if (availability === 'cancelled') {
      this.store.settle(id, claim, current.state === 'attempting' ? 'ambiguous' : 'cancelled', { reason: 'session_or_authority_unavailable' }, now()); return;
    }
    if (record.state === 'attempting' && (record.firstAttemptAt === undefined
      || now() - record.firstAttemptAt >= PROVIDER_TTL_MS['feishu-im'] - 60_000)) {
      this.store.settle(id, claim, 'ambiguous', { reason: 'provider_dedupe_window_expired' }, now()); return;
    }
    if (now() - record.createdAt > 24 * 60 * 60_000) {
      this.store.settle(id, claim, 'ambiguous', { reason: 'recovery_window_expired' }, now());
      this.deps.error(record, new Error('final_output_recovery_window_expired'));
      return;
    }
    const owns = () => this.store.owns(id, claim, now()) && this.deps.available(record) === 'ready';
    const renewal = setInterval(() => {
      try { this.store.renew(id, claim, now()); } catch (error) { this.deps.error(record, error); }
    }, 10_000);
    renewal.unref?.();
    let confirmed: { messageId: string; suppressed?: boolean } | undefined;
    try {
      const delivery = await this.deps.deliver(record, {
        owns,
        beforeEffect: () => {
          if (!owns()) throw new Error('final_output_authority_changed');
          this.store.attempting(id, claim, now());
        },
      });
      if (!delivery.messageId?.startsWith('om_')) throw new Error('final_output_missing_receipt');
      confirmed = delivery;
      this.store.settle(id, claim, delivery.suppressed ? 'suppressed' : 'delivered', { messageId: delivery.messageId }, now());
      this.notifySettled(record);
    } catch (error) {
      const actual = this.store.read(id);
      if (actual?.claim === claim) {
        const receipt = confirmed ?? this.deps.knownReceipt?.(actual);
        if (receipt) {
          // A provider/ledger receipt is stronger than a projection write error.
          try { this.store.settle(id, claim, receipt.suppressed ? 'suppressed' : 'delivered', { messageId: receipt.messageId }, now()); this.notifySettled(record); }
          catch { this.store.release(id, claim, now() + 5_000); }
        } else if (error instanceof FinalOutputRejectedError) this.store.settle(id, claim, 'rejected', { reason: error.message }, now());
        else if (actual.state === 'attempting') this.store.settle(id, claim, 'ambiguous', { reason: String(error).slice(0, 256) }, now());
        else if (this.deps.available(record) === 'cancelled') this.store.settle(id, claim, 'cancelled', { reason: 'authority_changed_before_effect' }, now());
        else this.store.release(id, claim, now() + 5_000);
      }
      this.deps.error(record, error);
    } finally { clearInterval(renewal); }
  }

  private notifySettled(record: StoredFinalOutput): void {
    try {
      const current = this.store.read(record.intentId);
      if (current && ['delivered', 'suppressed'].includes(current.state)) this.deps.settled?.(current);
    } catch { /* observers cannot change a receipt */ }
  }
}
