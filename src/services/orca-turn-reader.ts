import type { OrcaItem, OrcaPage } from './orca-session-protocol.js';

/** Fold journal revisions before attribution. A neighbouring local turn must never become a Bot reply. */
export class OrcaTurnReader {
  private readonly items = new Map<string, OrcaItem>();
  private rejected?: string;
  private uncertain?: string;
  private queued = false;
  private submitted = false;
  private deliveredOperationId: string;
  private providerItemId?: string;
  constructor(private readonly operationId: string, queued = false) {
    this.deliveredOperationId = operationId;
    this.queued = queued;
  }

  apply(page: OrcaPage): void {
    for (const id of page.removedItemIds) this.items.delete(id);
    for (const item of page.items) {
      if (!this.items.has(item.itemId) || this.items.get(item.itemId)!.revision <= item.revision) {
        this.items.set(item.itemId, item);
      }
    }
    const queued = page.submissions.find(s => s.queuedMessageId === this.operationId);
    const submission = queued ?? page.submissions.find(s => s.clientMessageId === this.operationId);
    if (queued) this.deliveredOperationId = queued.clientMessageId;
    if (submission?.providerItemId) this.providerItemId = submission.providerItemId;
    if (submission) {
      this.submitted = true;
      this.rejected = submission.dispatchState === 'rejected' ? submission.reason || 'Orca rejected the message' : undefined;
      this.uncertain = submission.dispatchState === 'unknown' ? submission.reason || 'Orca delivery is unconfirmed' : undefined;
    }
    const draft = page.queuedMessages?.find(q => q.messageId === this.operationId);
    if (draft) this.queued = true;
    if (this.queued && !this.submitted && !page.hasNewer) {
      if (page.queuedMessages !== undefined && !draft) {
        this.uncertain = 'The Orca queued message was removed without a confirmed submission; inspect it in Orca';
      } else if (draft?.paused || draft?.state === 'returned' || page.queuePause) {
        this.uncertain = 'The Orca queued message is paused; resolve it in Orca before resuming Botmux';
      }
    }
    if (this.items.size > 10_000) throw new Error('Orca turn exceeds the journal item limit; continue in Orca');
  }

  view(): { text: string; progress: string; done: boolean; failed?: string; uncertain?: string; turnId?: string } {
    if (this.rejected) return { text: '', progress: '', done: true, failed: this.rejected };
    const rows = [...this.items.values()].sort((a, b) => a.sequence - b.sequence);
    const turn = rows.find(i => !i.agentId && i.body.kind === 'turn'
      && (i.body.userItemId === `orca:${this.deliveredOperationId}`
        || (this.providerItemId !== undefined && i.body.userItemId === this.providerItemId)));
    if (!turn) return { text: '', progress: '', done: false, uncertain: this.uncertain };
    const owned = rows.filter(i => !i.agentId && i.turnScope?.kind === 'turn' && i.turnScope.turnItemId === turn.itemId);
    const text = owned.filter(i => i.body.kind === 'message' && i.body.role === 'assistant')
      .map(i => i.body.blocks?.filter(b => b.type === 'text').map(b => b.text || '').join('') || '')
      .filter(Boolean).join('\n\n');
    const activity = owned.flatMap(i => {
      if (i.body.kind === 'tool-call') return [`${i.body.name || 'Tool'}: ${i.body.state || 'running'}`];
      if (['approval', 'question'].includes(i.body.kind) && i.body.resolution?.state === 'pending') {
        return [`Waiting for input in Orca: ${i.body.title || i.body.question || i.body.kind}`];
      }
      return [];
    }).join('\n');
    const done = turn.body.state !== 'running';
    const failed = done && turn.body.outcome !== 'success'
      ? `Orca turn ended: ${turn.body.outcome || turn.body.state || 'unverifiable'}` : undefined;
    return { text, progress: [activity, text].filter(Boolean).join('\n\n'), done, failed, turnId: turn.body.turnId };
  }
}
