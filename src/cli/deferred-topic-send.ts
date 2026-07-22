import {
  readDeferredTopicBinding,
  withDeferredTopicBindingLock,
  writeDeferredTopicBinding,
  type DeferredTopicBinding,
} from '../core/deferred-topic-binding.js';

export interface DeferredScheduleRunData {
  taskId: string;
  turnId: string;
  routingAnchor: string;
  topicTitle?: string;
  createdAt: string;
}

export interface DeferredTopicSendSession {
  sessionId: string;
  chatId: string;
  larkAppId: string;
  deferredScheduleRun?: DeferredScheduleRunData;
}

export interface DeferredTopicSendResult {
  handled: boolean;
  messageId?: string;
  rootMessageId?: string;
  materializedNow?: boolean;
}

/** Route one `botmux send` effect for a lazily-materialized schedule topic.
 * The per-session file lock spans the provider request so two concurrent CLI
 * processes cannot both create a root. A stable provider UUID (sessionId)
 * makes retry-after-local-write-failure converge on the same Lark message. */
export async function dispatchDeferredTopicSend(opts: {
  dataDir: string;
  session: DeferredTopicSendSession;
  currentTurnId?: string;
  explicitTopLevel: boolean;
  reuseBoundRootWhenTopLevel?: boolean;
  content: string;
  msgType: string;
  uuid?: string;
  sendRoot: (content: string, msgType: string, uuid: string) => Promise<string>;
  sendTitleSeed: (title: string, uuid: string) => Promise<string>;
  replyRoot: (rootMessageId: string, content: string, msgType: string, uuid?: string) => Promise<string>;
}): Promise<DeferredTopicSendResult> {
  const run = opts.session.deferredScheduleRun;
  if (!run) return { handled: false };

  return withDeferredTopicBindingLock(opts.dataDir, opts.session.sessionId, async () => {
    const existing = readDeferredTopicBinding(opts.dataDir, opts.session.sessionId);
    if (existing) {
      if (
        existing.turnId !== run.turnId
        || existing.chatId !== opts.session.chatId
        || existing.larkAppId !== opts.session.larkAppId
        || existing.routingAnchor !== run.routingAnchor
      ) {
        throw new Error('deferred topic binding identity mismatch');
      }
      if (opts.explicitTopLevel && !opts.reuseBoundRootWhenTopLevel) return { handled: false };
      const messageId = await opts.replyRoot(existing.rootMessageId, opts.content, opts.msgType, opts.uuid);
      return { handled: true, messageId, rootMessageId: existing.rootMessageId, materializedNow: false };
    }

    // Only the scheduled turn itself may materialize an as-yet invisible run.
    // A stale/local process without the exact turn marker must not publish it.
    if (!opts.currentTurnId || opts.currentTurnId !== run.turnId) {
      // A missing binding after the scheduled turn must fail closed. Falling
      // through to ordinary chat-scope routing would leak a resumed/stale
      // hidden session's output to the group top level. Explicit --top-level
      // remains the deliberate escape hatch for an operator.
      if (opts.explicitTopLevel) return { handled: false };
      throw new Error('deferred topic is not materialized for this turn');
    }

    const title = run.topicTitle?.trim();
    let rootMessageId: string;
    let messageId: string;
    if (title) {
      rootMessageId = await opts.sendTitleSeed(title, opts.session.sessionId);
      const binding: DeferredTopicBinding = {
        sessionId: opts.session.sessionId,
        turnId: run.turnId,
        chatId: opts.session.chatId,
        larkAppId: opts.session.larkAppId,
        routingAnchor: run.routingAnchor,
        rootMessageId,
        createdAt: new Date().toISOString(),
      };
      writeDeferredTopicBinding(opts.dataDir, binding);
      messageId = await opts.replyRoot(rootMessageId, opts.content, opts.msgType, opts.uuid);
    } else {
      rootMessageId = await opts.sendRoot(opts.content, opts.msgType, opts.session.sessionId);
      const binding: DeferredTopicBinding = {
        sessionId: opts.session.sessionId,
        turnId: run.turnId,
        chatId: opts.session.chatId,
        larkAppId: opts.session.larkAppId,
        routingAnchor: run.routingAnchor,
        rootMessageId,
        createdAt: new Date().toISOString(),
      };
      writeDeferredTopicBinding(opts.dataDir, binding);
      messageId = rootMessageId;
    }
    return { handled: true, messageId, rootMessageId, materializedNow: true };
  });
}
