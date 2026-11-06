/**
 * Keeps every 「流程修改确认」card message showing the TRUE state of the
 * proposal it was posted for (design §13.3, carried proposals).
 *
 * A card message belongs to the revision it was posted for; a direct revision
 * may carry that proposal on (`carriedTo`), so the message must show the end
 * of that chain: its buttons while it waits, its outcome once decided, its
 * void reason once voided. Several writers race on one message — a carry
 * moving it, a later edit freezing it, the initiator's click reply — and an
 * `updateMessage` takes a network round trip, so one read before the update
 * is not enough. Hence, per message:
 *   - updates are serialized (one in flight; later requests queue behind it);
 *   - after each update lands, the state is read again and, if it moved on
 *     meanwhile, the message is updated again, until what it shows is what
 *     the waits say.
 * A click reply that renders in between is corrected the same way (it can
 * only show a decided state, which is the state read next).
 */

import { readV3RevisionWait, type V3RevisionWait } from '../../workflows/v3/run-edit.js';
import { buildV3RevisionCard } from './v3-revision-card.js';
import type { WorkflowSidebarEntryLink } from './workflow-sidebar-entry.js';

/** Bound on carried hops and on re-render rounds (each round is a state change). */
const MAX_HOPS = 16;
const MAX_ROUNDS = 8;

export interface V3RevisionCardState {
  /** Changes whenever what the card must show changes. */
  key: string;
  card: string;
  /** The revision the card ends up showing, and its wait state. */
  revision: number;
  status: V3RevisionWait['status'];
}

const VOID_DETAIL: Record<NonNullable<V3RevisionWait['voidReason']>, string> = {
  superseded: '已被新的修改替代',
  runEnded: 'run 已结束',
  stale: '流程已先一步修改',
};

/**
 * What a card first posted for `revision` must show now: the wait at the end
 * of its `carriedTo` chain, rendered. `undefined` when there is no wait.
 */
export function v3RevisionCardState(
  runDir: string,
  runId: string,
  revision: number,
  /** §11.1: the run's「工作流 ›」entry, rendered in place of「Web 详情」. */
  workflowEntry?: WorkflowSidebarEntryLink,
): V3RevisionCardState | undefined {
  let wait = readV3RevisionWait(runDir, revision);
  for (let hops = 0; wait && wait.status === 'voided' && wait.carriedTo !== undefined && hops < MAX_HOPS; hops++) {
    const next = readV3RevisionWait(runDir, wait.carriedTo);
    if (!next) break;
    wait = next;
  }
  if (!wait) return undefined;
  const resolution = wait.status === 'pending' ? undefined
    : wait.status === 'approved' ? { kind: 'approved' as const, ...(wait.by ? { by: wait.by } : {}) }
      : wait.status === 'rejected' ? { kind: 'rejected' as const, ...(wait.by ? { by: wait.by } : {}) }
        : { kind: 'void' as const, detail: wait.voidReason ? VOID_DETAIL[wait.voidReason] : VOID_DETAIL.stale };
  return {
    key: `${wait.revision}:${wait.status}`,
    card: buildV3RevisionCard({ runId, view: wait.view, ...(resolution ? { resolution } : {}), ...(workflowEntry ? { workflowEntry } : {}) }),
    revision: wait.revision,
    status: wait.status,
  };
}

export type V3RevisionCardSyncResult =
  /** The message shows the current state (`state` = what it shows). */
  | { kind: 'shown'; state: V3RevisionCardState }
  /** An update failed; the message shows whatever it showed before. */
  | { kind: 'failed' }
  /** No wait backs the card: nothing to show. */
  | { kind: 'missing' };

export interface V3RevisionCardRef {
  runId: string;
  /** App that posted the card (the run's owning bot). */
  larkAppId: string;
  messageId: string;
  /** Revision the card was (last) posted or moved for. */
  revision: number;
}

export interface V3RevisionCardSync {
  /** Bring one card message to the current state of its proposal. */
  sync(ref: V3RevisionCardRef): Promise<V3RevisionCardSyncResult>;
}

export function createV3RevisionCardSync(deps: {
  runDir: (runId: string) => string;
  updateMessage: (larkAppId: string, messageId: string, card: string) => Promise<void>;
  warn?: (message: string) => void;
  /** §11.1: the run's「工作流 ›」entry (bot-executed runs only). */
  workflowEntry?: (runId: string) => WorkflowSidebarEntryLink | undefined;
}): V3RevisionCardSync {
  const tails = new Map<string, Promise<unknown>>();

  async function render({ runId, larkAppId, messageId, revision }: V3RevisionCardRef): Promise<V3RevisionCardSyncResult> {
    const runDir = deps.runDir(runId);
    let shown: V3RevisionCardState | undefined;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let state: V3RevisionCardState | undefined;
      try {
        state = v3RevisionCardState(runDir, runId, revision, deps.workflowEntry?.(runId));
      } catch (err) {
        deps.warn?.(`[v3:${runId}] revision card state unreadable: ${err instanceof Error ? err.message : String(err)}`);
        return shown ? { kind: 'shown', state: shown } : { kind: 'failed' };
      }
      if (!state) return shown ? { kind: 'shown', state: shown } : { kind: 'missing' };
      if (shown && state.key === shown.key) return { kind: 'shown', state: shown };
      try {
        await deps.updateMessage(larkAppId, messageId, state.card);
      } catch (err) {
        deps.warn?.(`[v3:${runId}] revision card update failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: 'failed' };
      }
      shown = state;
    }
    return shown ? { kind: 'shown', state: shown } : { kind: 'failed' };
  }

  return {
    sync(ref) {
      const key = `${ref.larkAppId}\u0000${ref.messageId}`;
      const previous = tails.get(key) ?? Promise.resolve();
      const job = previous.catch(() => undefined).then(() => render(ref));
      tails.set(key, job);
      void job.finally(() => {
        if (tails.get(key) === job) tails.delete(key);
      });
      return job;
    },
  };
}

/** How the edit's carried / voided cards ended up (reported to the agent). */
export type V3CarriedCardOutcome = 'moved' | 'posted' | 'failed';
export type V3VoidedCardOutcome = 'frozen' | 'none' | 'failed';

/**
 * A carried proposal keeps its card: sync the old card's messages to it; when
 * none shows it (no messages, or every update failed) and it still waits,
 * post a card of its own.
 */
export async function moveV3CarriedRevisionCard(input: {
  sync: V3RevisionCardSync;
  runDir: string;
  runId: string;
  larkAppId: string;
  revision: number;
  cardMessageIds: readonly string[];
  post: () => Promise<void>;
}): Promise<V3CarriedCardOutcome> {
  const results = await Promise.all(input.cardMessageIds.map((messageId) =>
    input.sync.sync({ runId: input.runId, larkAppId: input.larkAppId, messageId, revision: input.revision })));
  if (results.some((result) => result.kind === 'shown')) return 'moved';
  let wait: V3RevisionWait | undefined;
  try {
    wait = readV3RevisionWait(input.runDir, input.revision);
  } catch {
    wait = undefined;
  }
  // Decided or gone meanwhile: nothing to post, and no card shows it now.
  if (wait?.status !== 'pending') return 'failed';
  try {
    await input.post();
    return 'posted';
  } catch {
    return 'failed';
  }
}

/** Freeze a voided proposal's card messages in place (as what their waits say). */
export async function freezeV3VoidedRevisionCard(input: {
  sync: V3RevisionCardSync;
  runId: string;
  larkAppId: string;
  revision: number;
  cardMessageIds: readonly string[];
}): Promise<V3VoidedCardOutcome> {
  if (input.cardMessageIds.length === 0) return 'none';
  const results = await Promise.all(input.cardMessageIds.map((messageId) =>
    input.sync.sync({ runId: input.runId, larkAppId: input.larkAppId, messageId, revision: input.revision })));
  return results.some((result) => result.kind === 'shown') ? 'frozen' : 'failed';
}
