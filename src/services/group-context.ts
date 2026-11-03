import { buildGroupContextBlock, type GroupContextRenderMessage } from './group-context-render.js';
import type { LarkAttachment } from '../types.js';
import { isTopicHeader, parseTopicHeader } from '../core/topic-header.js';
import { selectGroupContextConversation } from './group-context-scope.js';

/** Reuse the canonical topic parser; this selects background, never routes tasks. */
export function groupContextQuery(content: string, options?: { configuredTrigger?: boolean; renderedPrompt?: string }): string | undefined {
  if (options?.configuredTrigger) return (options.renderedPrompt ?? content).trim() || undefined;
  const header = parseTopicHeader(content);
  if (header !== null) return isTopicHeader(header) ? header.prompt.trim() || undefined : undefined;
  const query = content.trim();
  return !query || /^[/!]/.test(query) ? undefined : query;
}

export interface GroupContextTurnRequest {
  appId: string;
  chatId: string;
  turnId: string;
  query: string;
  createTime: number;
  rootId?: string;
  /** Physical conversation boundary, distinct from session reply-mode. */
  scope?: 'main' | 'thread';
  threadId?: string;
  sessionId?: string;
  epoch?: string;
  /** Exact native request revisions captured before asynchronous history reads. */
  nativeInputSeqs?: number[];
}

/** One included source exactly as it was rendered into the frozen body. */
export interface PreparedConversationSource {
  seq: number;
  text: string;
  resourceKeys?: string[];
}

export interface PreparedConversationContext {
  appId: string;
  chatId: string;
  turnId: string;
  createdAt: number;
  body: string;
  includedSeqs: number[];
  nativeInputSeqs?: number[];
  throughSeq: number;
  incomplete: boolean;
  epoch?: string;
  attachments?: LarkAttachment[];
  /** Frozen per-source fragments of `body`, so dispatch can subtract sources
   * covered after preparation without re-rendering or re-reading anything. */
  sources?: PreparedConversationSource[];
}

export interface LocalConversationRender {
  body: string;
  includedSeqs: number[];
  sources: PreparedConversationSource[];
  /** Latest eligible revisions after coverage filtering; attachment candidates. */
  unseen: GroupContextRenderMessage[];
  throughSeq: number;
  truncated: boolean;
  gaps: Set<string>;
  alreadyDeliveredSeqs: number[];
}

/** Render the conversation window for one turn from local records only.
 * Preparation renders once; dispatch never re-renders, it only subtracts the
 * frozen fragments of sources covered in the meantime. */
export function renderLocalConversation(
  request: GroupContextTurnRequest,
  settings: { maxContextChars: number },
  deps: Pick<GroupContextPreparationDeps, 'readLocal' | 'deliveredSeqs'>,
  gaps: Set<string> = new Set(),
): LocalConversationRender {
  let messages: GroupContextRenderMessage[] = [];
  let scopeEvidence: GroupContextRenderMessage[] = [];
  try {
    const local = deps.readLocal(request.appId, request.chatId);
    if (local.incomplete) gaps.add(local.reason ?? 'local_history_incomplete');
    // Stable conversation identity can be learned from a later revision
    // even when that revision's body is beyond this turn's time boundary.
    scopeEvidence = local.messages.filter(message => message.chatId === request.chatId);
    messages = scopeEvidence.filter(message => {
      if (message.chatId !== request.chatId || message.messageId === request.turnId
          || !Number.isFinite(Number(message.createTime)) || Number(message.createTime) > request.createTime) return false;
      // A withdrawal removes text even if it arrives during preparation.
      if (message.deleted) return true;
      const revision = message as GroupContextRenderMessage & { updateTime?: number; observedAt?: number; revision?: number };
      if (revision.updateTime !== undefined && revision.updateTime > request.createTime) {
        gaps.add('revision_after_trigger');
        return false;
      }
      if (revision.updateTime === undefined && message.cardObservedAt !== undefined
          && message.cardObservedAt > request.createTime) {
        gaps.add('card_first_observed_after_trigger');
        return false;
      }
      if (revision.updateTime === undefined && (revision.revision ?? 0) > 0
          && (revision.observedAt ?? 0) > request.createTime) {
        gaps.add('revision_time_unknown');
        return false;
      }
      return true;
    });
  } catch {
    gaps.add('local_history_unavailable');
  }
  // Conversation boundaries apply before attachments as well as prose.
  // Keep all same-message revisions here so scope provenance can survive
  // an edit or tombstone whose event omitted routing metadata.
  messages = selectGroupContextConversation(messages, request, scopeEvidence);

  let alreadyDeliveredSeqs: number[] = [];
  if (request.sessionId && request.epoch) {
    try {
      alreadyDeliveredSeqs = deps.deliveredSeqs(request.appId, request.chatId, request.sessionId, request.epoch);
    } catch { /* An uncertain receipt repeats history instead of skipping it. */ }
  }
  // Deduplicate before coverage filtering: an older uncovered revision must
  // not revive text/resources when its latest version was already supplied.
  const latest = new Map<string, GroupContextRenderMessage>();
  for (const message of messages) {
    if (!latest.has(message.messageId) || latest.get(message.messageId)!.seq < message.seq) latest.set(message.messageId, message);
  }
  const covered = new Set(alreadyDeliveredSeqs);
  const unseen = [...latest.values()].filter(message => !covered.has(message.seq));
  const rendered = buildGroupContextBlock(messages, {
    maxContextChars: settings.maxContextChars,
    currentMessageId: request.turnId,
    query: request.query,
    rootId: request.rootId,
    scope: request.scope,
    threadId: request.threadId,
    scopeEvidence,
    incomplete: gaps.size > 0,
    gapReason: [...gaps].join(', '),
    alreadyDeliveredSeqs,
  });
  const sources = rendered.fragments.map(fragment => ({
    seq: fragment.seq, text: fragment.text, ...(fragment.resourceKeys.length ? { resourceKeys: fragment.resourceKeys } : {}),
  }));
  return { body: rendered.text, includedSeqs: rendered.includedSeqs, sources, unseen, throughSeq: rendered.throughSeq, truncated: rendered.truncated, gaps, alreadyDeliveredSeqs };
}

export interface GroupContextPreparationDeps {
  settings: (appId: string, chatId: string) => { enabled: boolean; maxContextChars: number };
  readPrepared: (appId: string, chatId: string, turnId: string, epoch?: string) => PreparedConversationContext | undefined;
  writePrepared: (value: PreparedConversationContext) => PreparedConversationContext;
  backfill: (request: GroupContextTurnRequest, signal: AbortSignal) => Promise<{
    messages: GroupContextRenderMessage[];
    incomplete: boolean;
    reason?: string;
  }>;
  ingest: (message: GroupContextRenderMessage, appId: string) => void | boolean;
  readLocal: (appId: string, chatId: string) => {
    messages: GroupContextRenderMessage[];
    incomplete: boolean;
    reason?: string;
  };
  deliveredSeqs: (appId: string, chatId: string, sessionId: string, epoch: string) => number[];
  resolveAttachments?: (request: GroupContextTurnRequest, messages: GroupContextRenderMessage[], signal: AbortSignal) => Promise<{
    attachments: LarkAttachment[];
    incomplete: boolean;
  }>;
  now?: () => number;
  timeoutMs?: number;
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('history_timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

/** Prepare background data only. This module has no worker/model dispatch path. */
export function createGroupContextPreparer(deps: GroupContextPreparationDeps) {
  const inFlight = new Map<string, Promise<PreparedConversationContext | undefined>>();
  return async (request: GroupContextTurnRequest): Promise<PreparedConversationContext | undefined> => {
    if (!/^oc_[A-Za-z0-9_-]+$/.test(request.chatId) || !request.appId || !request.turnId) return undefined;
    const settings = deps.settings(request.appId, request.chatId);
    if (!settings.enabled) return undefined;
    const previous = deps.readPrepared(request.appId, request.chatId, request.turnId, request.epoch);
    if (previous) return previous;
    const key = JSON.stringify([request.appId, request.chatId, request.turnId, request.epoch ?? '']);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const run = async (): Promise<PreparedConversationContext> => {
      const gaps = new Set<string>();
      try {
        const history = await bounded(signal => deps.backfill(request, signal), deps.timeoutMs ?? 5_000);
        if (history.incomplete) gaps.add(history.reason ?? 'history_scan_incomplete');
        for (const message of history.messages) {
          // Never copy a message into a different conversation's observation log.
          if (message.chatId === request.chatId && deps.ingest(message, request.appId) === false) gaps.add('history_revision_conflict');
        }
      } catch {
        // Do not include upstream error bodies: they can contain private URLs.
        gaps.add('history_unavailable');
      }
      const local = renderLocalConversation(request, settings, deps, gaps);
      const { unseen } = local;
      const gapsBeforeAttachments = gaps.size;
      let attachments: LarkAttachment[] = [];
      if (deps.resolveAttachments && unseen.length) {
        try {
          const resolved = await bounded(signal => deps.resolveAttachments!(request, unseen, signal), deps.timeoutMs ?? 5_000);
          attachments = resolved.attachments;
          if (resolved.incomplete) gaps.add('attachments_unavailable');
        } catch { gaps.add('attachments_unavailable'); }
      }
      // Attachment resolution may have added a gap after the body was rendered;
      // the stored incompleteness flag must reflect it, so re-render once.
      const rendered = gaps.size === gapsBeforeAttachments ? local : renderLocalConversation(request, settings, deps, gaps);
      return deps.writePrepared({
        appId: request.appId,
        chatId: request.chatId,
        turnId: request.turnId,
        createdAt: (deps.now ?? Date.now)(),
        body: rendered.body,
        includedSeqs: rendered.includedSeqs,
        ...(request.nativeInputSeqs?.length ? { nativeInputSeqs: [...request.nativeInputSeqs] } : {}),
        throughSeq: rendered.throughSeq,
        incomplete: gaps.size > 0 || rendered.truncated,
        ...(request.epoch !== undefined ? { epoch: request.epoch } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(rendered.sources.length ? { sources: rendered.sources } : {}),
      });
    };
    const pending = run();
    inFlight.set(key, pending);
    try { return await pending; }
    finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
  };
}
