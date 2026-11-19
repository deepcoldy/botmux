import { computeInputHash } from '../utils/canonical-input-hash.js';
import type { LarkMessage, Session } from '../types.js';
import type { MessageResource } from '../im/lark/message-parser.js';

export interface EffortTaskConfirmation {
  version: 1;
  messageId: string;
  inputHash: string;
  effort: NonNullable<Session['reasoningEffort']>;
  cliId: string;
  nativeId?: string;
  workerGeneration?: number;
  sessionWorkerGeneration?: number;
  /** Canonical handling completed; capacity-only metadata, never submit proof. */
  terminal?: 'admitted' | 'ignored';
}

/** The durable envelope retains task bytes; this proof binds settings to them. */
export function effortTaskFingerprint(message: LarkMessage, resources: MessageResource[]): string {
  return computeInputHash({ content: message.content, senderId: message.senderId,
    senderUnionId: message.senderUnionId, senderType: message.senderType,
    rootId: message.rootId, parentId: message.parentId, threadId: message.threadId,
    mentions: message.mentions, resources });
}

export function findEffortTaskConfirmation(session: Session, messageId: string): EffortTaskConfirmation | undefined {
  return session.codexEffortTaskConfirmations?.find(item => item.messageId === messageId);
}

/** Pending proofs cannot be evicted: their Inbox message still owns replay. */
export function recordEffortTaskConfirmation(session: Session, input: Omit<EffortTaskConfirmation, 'version'>): void {
  const existing = findEffortTaskConfirmation(session, input.messageId);
  if (existing) {
    if (existing.inputHash !== input.inputHash || existing.effort !== input.effort) {
      throw new Error('Effort task input changed after settings confirmation');
    }
    return;
  }
  const entries = [...(session.codexEffortTaskConfirmations ?? [])];
  if (entries.length >= 64) {
    const completed = entries.findIndex(item => item.terminal || session.durablePrimaryInputCommits?.some(proof => proof.turnId === item.messageId));
    if (completed < 0) throw new Error('Pending effort task confirmation capacity is exhausted');
    entries.splice(completed, 1);
  }
  session.codexEffortTaskConfirmations = [...entries, { ...input, version: 1 }];
}
