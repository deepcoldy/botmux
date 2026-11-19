import type { OutputDeliveryJournal, OutputDeliveryRecord, OutputReceipt, OutputProviderEffectHooks } from './output-delivery-journal.js';

/** Structural, non-transient failure: the frozen destination can never accept
 *  this output (channel/private-reply policy changed, HTTP owner gone). The
 *  row is filed as terminal `rejected` instead of retried forever. */
export class OutputDeliveryTerminalError extends Error {
  constructor(message: string) { super(message); this.name = 'OutputDeliveryTerminalError'; }
}

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
    /** terminal=true means the row is now in the permanent rejected state. */
    error(error: unknown, terminal?: boolean): void;
  }): Promise<void> {
    const current = this.journal.read(record.id)!;
    if (current.state === 'settled') { deps.settled(current); return; }
    // Terminal rejection is a durable human-inspection state, not a delivery
    // success: never invoke the settled callback (no worker ACK) and never retry.
    if (current.state === 'rejected') return;
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
      if (error instanceof OutputDeliveryTerminalError) {
        // A structurally impossible delivery leaves the retry loop for good;
        // the error dep surfaces a stable attention (no 5s re-publish churn).
        if (this.journal.rejectTerminal(record.id, owner, error.message)) deps.error(error, true);
      } else {
        this.journal.block(record.id, owner, String(error));
        deps.error(error, false);
      }
    } finally { clearInterval(heartbeat); }
  }
}
