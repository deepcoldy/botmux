import type { PersistedAsyncTriggerResult } from '../services/async-trigger-store.js';

interface TriggerLookup {
  ok: boolean;
  triggerId?: string;
  target?: { kind: string; sessionId?: string; chatId?: string };
}

/** Exact receiver-owned queue proof for HTTP turns, including the first
 * unkeyed turn and silent/group tasks with no IM reply anchor. A session
 * summary or running status alone is never proof. No process capability,
 * environment, unrelated turn or foreign bot record is exposed. */
export function projectTriggerInputCommit(input: {
  ownerLarkAppId: string;
  sessionId: string;
  triggerId?: string;
  session?: { sessionId: string; larkAppId?: string; chatId?: string; workerGeneration?: number };
  persisted?: { ownerLarkAppId?: string; triggerId: string; result: PersistedAsyncTriggerResult };
  result: TriggerLookup;
}) {
  const unknown = { schemaVersion: 1, state: 'unknown' } as const;
  const { session, result, persisted, triggerId, sessionId, ownerLarkAppId } = input;
  if (!ownerLarkAppId || !triggerId || !session || session.sessionId !== sessionId
    || session.larkAppId !== ownerLarkAppId || !session.chatId || !result.ok
    || result.triggerId !== triggerId || result.target?.kind !== 'turn'
    || result.target.sessionId !== sessionId || result.target.chatId !== session.chatId
    || persisted?.ownerLarkAppId !== ownerLarkAppId || persisted.triggerId !== triggerId) return unknown;
  const commit = persisted.result.inputCommit;
  if (!commit || !Number.isSafeInteger(commit.workerGeneration) || commit.workerGeneration <= 0
    || commit.workerGeneration !== session.workerGeneration || !Number.isFinite(commit.observedAt)
    || !Number.isFinite(new Date(commit.observedAt).getTime())) return unknown;
  return { schemaVersion: 1, state: 'observed', larkAppId: ownerLarkAppId,
    sessionId, chatId: session.chatId, triggerId,
    workerGeneration: commit.workerGeneration, committedAt: new Date(commit.observedAt).toISOString() } as const;
}
