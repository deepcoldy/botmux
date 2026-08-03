import { randomUUID } from 'node:crypto';

export type MessageListenerRunPreviewState = 'triggered' | 'running' | 'replied' | 'failed';

export interface MessageListenerRunPreviewResult {
  runId: string;
  messageId: string;
  ok: boolean;
  state: MessageListenerRunPreviewState;
  action?: string;
  sessionId?: string;
  triggerId?: string;
  error?: string;
  replyMessageId?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface MessageListenerRunPreviewRecord {
  runId: string;
  larkAppId: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
  results: MessageListenerRunPreviewResult[];
}

const RUN_TTL_MS = 60 * 60 * 1000;
const MAX_RUNS = 200;

const runs = new Map<string, MessageListenerRunPreviewRecord>();
const turnIndex = new Map<string, { runId: string; messageId: string }>();

function nowIso(): string {
  return new Date().toISOString();
}

function prune(): void {
  const cutoff = Date.now() - RUN_TTL_MS;
  for (const [runId, run] of runs) {
    if (Date.parse(run.updatedAt) < cutoff) {
      runs.delete(runId);
      for (const result of run.results) {
        if (result.triggerId) turnIndex.delete(result.triggerId);
      }
    }
  }
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    const run = runs.get(oldest);
    runs.delete(oldest);
    for (const result of run?.results ?? []) {
      if (result.triggerId) turnIndex.delete(result.triggerId);
    }
  }
}

export function createMessageListenerRunPreview(
  larkAppId: string,
  chatId: string,
  messageIds: string[],
): MessageListenerRunPreviewRecord {
  prune();
  const at = nowIso();
  const runId = `mlrp_${randomUUID()}`;
  const record: MessageListenerRunPreviewRecord = {
    runId,
    larkAppId,
    chatId,
    createdAt: at,
    updatedAt: at,
    results: messageIds.map(messageId => ({
      runId,
      messageId,
      ok: true,
      state: 'triggered',
      createdAt: at,
      updatedAt: at,
    })),
  };
  runs.set(runId, record);
  return cloneRun(record);
}

export function createMessageListenerRunPreviewTurnId(): string {
  return `mlrp_turn_${randomUUID()}`;
}

function findResult(runId: string, messageId: string): MessageListenerRunPreviewResult | undefined {
  return runs.get(runId)?.results.find(result => result.messageId === messageId);
}

function touchRun(run: MessageListenerRunPreviewRecord, at: string): void {
  run.updatedAt = at;
}

export function markMessageListenerRunPreviewTriggered(
  runId: string,
  messageId: string,
  update: {
    action?: string;
    sessionId?: string;
    triggerId?: string;
  },
): MessageListenerRunPreviewResult | null {
  const run = runs.get(runId);
  const result = run?.results.find(item => item.messageId === messageId);
  if (!run || !result) return null;
  const at = nowIso();
  result.ok = true;
  result.state = 'triggered';
  result.action = update.action;
  result.sessionId = update.sessionId;
  result.triggerId = update.triggerId;
  result.error = undefined;
  result.updatedAt = at;
  touchRun(run, at);
  if (update.triggerId) turnIndex.set(update.triggerId, { runId, messageId });
  return { ...result };
}

export function markMessageListenerRunPreviewRunning(triggerId: string): MessageListenerRunPreviewResult | null {
  const ref = turnIndex.get(triggerId);
  if (!ref) return null;
  const run = runs.get(ref.runId);
  const result = findResult(ref.runId, ref.messageId);
  if (!run || !result || result.state === 'replied' || result.state === 'failed') return null;
  const at = nowIso();
  result.state = 'running';
  result.updatedAt = at;
  touchRun(run, at);
  return { ...result };
}

export function markMessageListenerRunPreviewReplied(
  triggerId: string,
  update: {
    sessionId?: string;
    replyMessageId?: string;
  } = {},
): MessageListenerRunPreviewResult | null {
  const ref = turnIndex.get(triggerId);
  if (!ref) return null;
  const run = runs.get(ref.runId);
  const result = findResult(ref.runId, ref.messageId);
  if (!run || !result) return null;
  const at = nowIso();
  result.ok = true;
  result.state = 'replied';
  if (update.sessionId) result.sessionId = update.sessionId;
  if (update.replyMessageId) result.replyMessageId = update.replyMessageId;
  result.error = undefined;
  result.finishedAt = at;
  result.updatedAt = at;
  touchRun(run, at);
  return { ...result };
}

export function markMessageListenerRunPreviewFailed(
  triggerIdOrRunId: string,
  update: {
    messageId?: string;
    sessionId?: string;
    error?: string;
  } = {},
): MessageListenerRunPreviewResult | null {
  const ref = update.messageId
    ? { runId: triggerIdOrRunId, messageId: update.messageId }
    : turnIndex.get(triggerIdOrRunId);
  if (!ref) return null;
  const run = runs.get(ref.runId);
  const result = findResult(ref.runId, ref.messageId);
  if (!run || !result || result.state === 'replied') return null;
  const at = nowIso();
  result.ok = false;
  result.state = 'failed';
  if (update.sessionId) result.sessionId = update.sessionId;
  result.error = update.error;
  result.finishedAt = at;
  result.updatedAt = at;
  touchRun(run, at);
  return { ...result };
}

export function getMessageListenerRunPreview(runId: string): MessageListenerRunPreviewRecord | null {
  prune();
  const run = runs.get(runId);
  return run ? cloneRun(run) : null;
}

export function clearMessageListenerRunPreviewStore(): void {
  runs.clear();
  turnIndex.clear();
}

function cloneRun(run: MessageListenerRunPreviewRecord): MessageListenerRunPreviewRecord {
  return {
    ...run,
    results: run.results.map(result => ({ ...result })),
  };
}
