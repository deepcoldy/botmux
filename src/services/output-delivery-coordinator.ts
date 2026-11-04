import type { OutputDeliveryJournal, OutputDeliveryRecord, OutputReceipt, OutputProviderEffectHooks } from './output-delivery-journal.js';

export interface OutputDeliveryControl {
  record: OutputDeliveryRecord;
  publicationUuid?: string;
  rejectedReason?: string;
  freezeTransport(key: string, proposed: { content: string; msgType: string; providerUuid: string }): typeof proposed;
  owns(): boolean;
  effect<T>(key: string, dispatch: (hooks: OutputProviderEffectHooks) => Promise<T>): Promise<T>;
}

/** The journal owns retries; adapters own authorization and native terminal
 * receipts. A generic receipt never substitutes for a runner's ACK. */
export class OutputDeliveryCoordinator {
  constructor(readonly journal: OutputDeliveryJournal) {}
  async deliver(record: OutputDeliveryRecord, deps: {
    owns(): boolean;
    process(record: OutputDeliveryRecord, control: OutputDeliveryControl): Promise<OutputReceipt | undefined>;
    settled(record: OutputDeliveryRecord): void;
    error(error: unknown): void;
  }): Promise<void> {
    const current = this.journal.read(record.id)!;
    if (current.state === 'settled') { deps.settled(current); return; }
    if (!deps.owns()) return;
    const owner = this.journal.newOwner();
    if (!this.journal.claim(record.id, owner)) return;
    const owns = () => deps.owns() && this.journal.owns(record.id, owner);
    const heartbeat = setInterval(() => {
      try { if (deps.owns()) this.journal.renew(record.id, owner); }
      catch (error) { deps.error(error); }
    }, 10_000);
    heartbeat.unref?.();
    try {
      const receipt = await deps.process(current, { record: current, owns,
        freezeTransport: (key, proposed) => {
          if (!owns()) throw new Error('output_transport_authority_changed');
          return this.journal.freezeTransport(record.id, owner, key, proposed);
        },
        effect: (key, dispatch) => {
          if (!owns()) return Promise.reject(new Error('output_effect_authority_changed'));
          return this.journal.effect(record.id, owner, key, dispatch, () => {
            if (!owns()) throw new Error('output_effect_authority_changed');
          });
        } });
      if (!receipt) { this.journal.block(record.id, owner, 'output_delivery_unconfirmed'); return; }
      // Receipts returned by adapters include definite external effect evidence.
      // Persist that evidence before ACK; a replacement can finish cleanup.
      if (this.journal.complete(record.id, owner, receipt)) deps.settled(this.journal.read(record.id)!);
    } catch (error) {
      this.journal.block(record.id, owner, String(error));
      deps.error(error);
    } finally { clearInterval(heartbeat); }
  }
}
