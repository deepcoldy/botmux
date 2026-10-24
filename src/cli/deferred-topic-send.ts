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

/** Where the per-run topic binding and its first-message claim live.
 *
 * The default is the host-visible sidecar under `dataDir`. A sandboxed /
 * read-isolated CLI cannot create files there, so it uses a daemon-owned store
 * instead (see deferred-topic-remote-store): the daemon serializes the claim
 * with a lease and only records a root it has verified in the target chat. */
export interface DeferredTopicBindingStore {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  read(): DeferredTopicBinding | undefined;
  /** Throws when this caller may not publish a root (e.g. the daemon denied
   * the claim). Called before the provider request, never after it. */
  assertCanMaterialize?(): void;
  write(binding: DeferredTopicBinding): void | Promise<void>;
}

export function localDeferredTopicBindingStore(dataDir: string, sessionId: string): DeferredTopicBindingStore {
  return {
    withLock: fn => withDeferredTopicBindingLock(dataDir, sessionId, fn),
    read: () => readDeferredTopicBinding(dataDir, sessionId),
    write: binding => writeDeferredTopicBinding(dataDir, binding),
  };
}

export interface DeferredTopicSendResult {
  handled: boolean;
  messageId?: string;
  rootMessageId?: string;
  materializedNow?: boolean;
}

export function deferredTopicBindingMatches(
  session: DeferredTopicSendSession,
  binding: DeferredTopicBinding,
): boolean {
  const run = session.deferredScheduleRun;
  return !!run
    && binding.sessionId === session.sessionId
    && binding.turnId === run.turnId
    && binding.chatId === session.chatId
    && binding.larkAppId === session.larkAppId
    && binding.routingAnchor === run.routingAnchor;
}

/** Existing deferred runs reply into their materialized topic before the
 * nominal send target is considered. Mirror that precedence for advisory
 * reachability without materializing a new topic. */
export function reusableDeferredTopicRoot(input: {
  session: DeferredTopicSendSession;
  binding: DeferredTopicBinding | undefined;
  explicitTopLevel: boolean;
  reuseBoundRootWhenTopLevel?: boolean;
}): string | undefined {
  const { binding } = input;
  if (!binding || !deferredTopicBindingMatches(input.session, binding)) return undefined;
  if (input.explicitTopLevel && !input.reuseBoundRootWhenTopLevel) return undefined;
  return binding.rootMessageId;
}

/** Route one `botmux send` effect for a lazily-materialized schedule topic.
 * The per-session file lock spans the provider request so two concurrent CLI
 * processes cannot both create a root. A stable provider UUID (sessionId)
 * makes retry-after-local-write-failure converge on the same Lark message. */
export async function dispatchDeferredTopicSend(opts: {
  dataDir: string;
  /** Resolved lazily, only for a deferred run. Defaults to the local sidecar. */
  store?: () => DeferredTopicBindingStore | Promise<DeferredTopicBindingStore>;
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

  const store = opts.store
    ? await opts.store()
    : localDeferredTopicBindingStore(opts.dataDir, opts.session.sessionId);
  return store.withLock(async () => {
    const existing = store.read();
    if (existing) {
      if (!deferredTopicBindingMatches(opts.session, existing)) {
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

    store.assertCanMaterialize?.();
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
      await store.write(binding);
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
      await store.write(binding);
      messageId = rootMessageId;
    }
    return { handled: true, messageId, rootMessageId, materializedNow: true };
  });
}
