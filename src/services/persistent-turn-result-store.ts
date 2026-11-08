import { TurnResultStore } from './turn-result-store.js';
import { sessionContractStore, type SessionContractStore } from './session-contract-store.js';
import type { TurnResult, TurnResultBinding, TurnDeliveryReceipt, TurnResultLookup } from './turn-result.js';
import type { ContractSessionRef, ExecutionContract } from './session-contract.js';
import { outputDeliveryJournal, type OutputDeliveryRecord } from './output-delivery-journal.js';

export interface ContractTurnResult {
  version: 2;
  ref: TurnResult['ref'];
  resultRevision: number;
  execution: ExecutionContract;
  source?: TurnResult['source'];
  delivery?: { output: TurnResult['output']; receipt: TurnDeliveryReceipt };
  outputs: Array<Pick<OutputDeliveryRecord, 'id' | 'state' | 'receipt' | 'reason' | 'origin'>>;
}

/** The cache never decides execution truth. A refresh joins the original
 * attempt, frozen source and delivery facts from the durable contract. */
export class PersistentTurnResultStore extends TurnResultStore {
  constructor(private readonly dataDir: string) { super(); }
  private contract(ref: TurnResult['ref']): { store: SessionContractStore; session: ContractSessionRef } {
    return { store: sessionContractStore(this.dataDir, ref.botId), session: { appId: ref.botId, sessionId: ref.sessionId } };
  }
  override begin(binding: TurnResultBinding): void {
    super.begin(binding);
    const { store, session } = this.contract(binding.ref);
    store.rememberResultBinding(session, binding);
  }
  override readBinding(ref: TurnResult['ref']): TurnResultBinding | undefined {
    const { store, session } = this.contract(ref);
    return store.resultBinding(session, ref.turnId, ref.dispatchAttempt) ?? super.readBinding(ref);
  }
  override recordDelivery(binding: TurnResultBinding, output: TurnResult['output'], receipt: TurnDeliveryReceipt): void {
    super.recordDelivery(binding, output, receipt);
    const { store, session } = this.contract(binding.ref);
    const frozen = store.resultBinding(session, binding.ref.turnId, binding.ref.dispatchAttempt);
    if (frozen && frozen.source.chatId === binding.source.chatId) store.rememberResultDelivery(session, binding.ref.turnId, binding.ref.dispatchAttempt, output, receipt);
  }
  readContract(ref: TurnResult['ref']): ContractTurnResult | undefined {
    const { store, session } = this.contract(ref);
    const execution = store.executions(session, ref.turnId, ref.dispatchAttempt)[0];
    if (!execution) return undefined;
    const binding = store.resultBinding(session, ref.turnId, ref.dispatchAttempt);
    const delivery = store.resultDelivery(session, ref.turnId, ref.dispatchAttempt);
    const outputs = outputDeliveryJournal(this.dataDir, ref.botId).forTurn(ref.sessionId, ref.turnId)
      .filter(output => output.origin?.scope.execution?.executionId === execution.ref.executionId)
      .map(({ id, state, receipt, reason, origin }) => ({ id, state, receipt, reason, origin }));
    const resultRevision = store.resultRevision(session, ref.turnId, ref.dispatchAttempt, { execution, delivery, outputs });
    return structuredClone({ version: 2, ref, resultRevision, execution,
      outputs, ...(binding ? { source: binding.source } : {}), ...(delivery ? { delivery } : {}) });
  }
  override read(ref: TurnResult['ref']): TurnResultLookup {
    const result = this.readContract(ref);
    if (!result) return super.read(ref);
    const { execution, source, delivery } = result;
    if (!source) return { status: 'not_found' };
    if (!execution.terminal && execution.phase !== 'reconciling') return { status: 'not_ready' };
    const output: TurnResult['output'] = execution.output?.availability === 'available'
      ? { status: 'available', content: execution.output.content, format: 'markdown' }
      : execution.output?.availability === 'empty' ? { status: 'empty' }
        : { status: 'unavailable', reason: 'output_not_observed' };
    return { status: 'ready', result: { version: 1, ref, source, resultRevision: result.resultRevision,
      execution: { status: execution.terminal?.status === 'succeeded' ? 'completed' : execution.terminal?.status ?? 'ambiguous',
        ...(execution.terminal?.errorCode ? { errorCode: execution.terminal.errorCode } : {}) },
      output, deliveries: delivery ? [delivery.receipt] : execution.deliveries.map(receipt => ({ channel: source.kind,
        status: receipt.status, messages: receipt.messageId ? [{ messageId: receipt.messageId, kind: 'primary' as const }] : [] })) } };
  }
}
