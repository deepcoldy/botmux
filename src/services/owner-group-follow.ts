import type { OwnerGroupFollowConfig } from './owner-group-follow-policy.js';
import { registerOwnerGroupFollowChangeHandler } from './owner-group-follow-policy.js';
import { OwnerGroupFollowStore } from './owner-group-follow-store.js';

export interface OwnerGroupFollowContext {
  ownerOpenId?: string;
  brand: string;
  config?: OwnerGroupFollowConfig;
}
export interface OwnerGroupFollowDependencies {
  appId: string;
  dataDir: string;
  context(): OwnerGroupFollowContext;
  token(ownerOpenId: string, signal: AbortSignal): Promise<string | null>;
  listChats(token: string, signal: AbortSignal): Promise<string[]>;
  listBotChats(signal: AbortSignal): Promise<string[]>;
  invite(chatId: string, token: string, signal: AbortSignal): Promise<void>;
  notify(ownerOpenId: string, chatId: string | undefined, issue: OwnerGroupFollowIssue | undefined, current: () => boolean): Promise<void>;
  log(message: string): void;
  now?: () => number;
}

export interface OwnerGroupFollowIssue {
  pendingApproval?: boolean;
  authorizationSource?: 'platform' | 'bot';
  authorizationRequired?: boolean;
  authorizeUrl?: string;
  guidance?: string;
}
export class OwnerGroupFollowError extends Error {
  constructor(public readonly retryable: boolean, public readonly authorization = false, public readonly issue?: OwnerGroupFollowIssue) {
    super(authorization ? 'owner group follow authorization required' : 'owner group follow API failed');
  }
}

/** No overlapping scans; API waits never hold the journal's file lock. */
export function createOwnerGroupFollower(deps: OwnerGroupFollowDependencies) {
  const store = new OwnerGroupFollowStore(deps.dataDir, deps.appId);
  const now = deps.now ?? Date.now;
  let running = false, stopped = false, nextPollAt = 0;
  let controller: AbortController | undefined;
  const scopeOf = (context: OwnerGroupFollowContext) => `${context.brand}:${context.ownerOpenId ?? ''}`;
  function changed(): void {
    controller?.abort();
    nextPollAt = 0;
    const context = deps.context();
    store.configure(scopeOf(context), context.config?.enabled === true && !!context.ownerOpenId, true);
  }
  const unregister = registerOwnerGroupFollowChangeHandler(deps.appId, changed);

  async function tick(): Promise<void> {
    if (stopped || running) return;
    const context = deps.context();
    const enabled = context.config?.enabled === true && !!context.ownerOpenId;
    const state = store.configure(scopeOf(context), enabled);
    if (!enabled || !state || now() < nextPollAt) return;
    running = true;
    controller = new AbortController();
    const signal = controller.signal;
    const epoch = state.epoch;
    const owner = context.ownerOpenId!;
    const current = () => !stopped && !signal.aborted && deps.context().ownerOpenId === owner
      && deps.context().brand === context.brand && deps.context().config?.enabled === true
      && store.read()?.epoch === epoch;
    const notice = async (chatId?: string, issue?: OwnerGroupFollowIssue) => {
      if (!current()) return;
      if (!chatId) {
        let shouldNotify = false;
        store.update(epoch, value => {
          if (value.authNoticeAt === undefined || now() - value.authNoticeAt >= 6 * 60 * 60_000) {
            value.authNoticeAt = now(); shouldNotify = true;
          }
        });
        if (!shouldNotify) return;
      }
      if (current()) {
        await deps.notify(owner, chatId, issue, current)
          .catch(() => deps.log('owner group follow notification failed'));
      }
    };
    try {
      const token = await deps.token(owner, signal);
      if (!current()) return;
      if (!token) { await notice(); return; }
      const snapshotRevision = store.read()!.revision;
      // Neither a failed page nor an incomplete listing can trigger invitations.
      const chats = await deps.listChats(token, signal);
      if (!current()) return;
      const botChats = new Set(await deps.listBotChats(signal));
      if (!current()) return;
      const excluded = new Set(deps.context().config?.excludeChatIds ?? []);
      if (!store.observe(epoch, chats, botChats, excluded, snapshotRevision)) return;
      const joinedByOwner = new Set(chats);
      const entries = store.read()?.entries ?? {};
      for (const [chatId, entry] of Object.entries(entries)) {
        if (!current()) return;
        if (!joinedByOwner.has(chatId) || botChats.has(chatId) || excluded.has(chatId)
            || !['pending', 'inviting'].includes(entry.status)) continue;
        // Resolve again before writing: local logout/revocation must stop the scan.
        const freshToken = await deps.token(owner, signal);
        if (!current()) return;
        if (!freshToken) { await notice(); return; }
        if (deps.context().config?.excludeChatIds?.includes(chatId)) continue;
        if (entry.status === 'inviting' && entry.attempts >= 3 && now() - (entry.startedAt ?? now()) >= 120_000) {
          if (entry.attemptId && store.finish(epoch, chatId, entry.attemptId, 'failed', now())) await notice(chatId);
          continue;
        }
        const attemptId = store.claim(epoch, chatId, now());
        if (!attemptId || !current()) continue;
        try {
          await deps.invite(chatId, freshToken, signal);
          store.finish(epoch, chatId, attemptId, 'joined', now());
        } catch (error) {
          if (!current()) return;
          const retryable = !(error instanceof OwnerGroupFollowError) || error.retryable;
          const authorization = error instanceof OwnerGroupFollowError && error.authorization;
          const issue = error instanceof OwnerGroupFollowError ? error.issue : undefined;
          const changedEntry = store.finish(epoch, chatId, attemptId, authorization ? 'authorization' : issue?.pendingApproval ? 'approval' : retryable ? 'retry' : 'failed', now());
          if (authorization) { await notice(undefined, issue); return; }
          if (changedEntry && ['failed', 'approval'].includes(store.read()?.entries[chatId]?.status ?? '')) await notice(chatId, issue);
        }
      }
    } catch (error) {
      if (current()) {
        deps.log(error instanceof OwnerGroupFollowError ? error.message : 'owner group follow scan failed');
        if (error instanceof OwnerGroupFollowError && error.authorization) await notice(undefined, error.issue);
      }
    } finally {
      nextPollAt = signal.aborted ? 0 : now() + (deps.context().config?.pollIntervalSeconds ?? 60) * 1000;
      running = false;
      controller = undefined;
    }
  }
  return {
    tick,
    stop() { stopped = true; controller?.abort(); unregister(); },
  };
}
