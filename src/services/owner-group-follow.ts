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
    // A temporarily unresolved owner is not a new identity scope. Keep the
    // previous journal so a healed owner resumes its baseline and removals,
    // but still advance its epoch to fence other daemons' old responses.
    if (!context.ownerOpenId) {
      const previous = store.read();
      if (previous) store.configure(previous.scope, context.config?.enabled === true, true);
      return;
    }
    store.configure(scopeOf(context), context.config?.enabled === true, true);
  }
  const unregister = registerOwnerGroupFollowChangeHandler(deps.appId, changed);

  async function tick(): Promise<void> {
    if (stopped || running) return;
    const context = deps.context();
    if (!context.ownerOpenId) return;
    const enabled = context.config?.enabled === true;
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
      const observedRevision = store.observe(epoch, chats, botChats, excluded, snapshotRevision);
      if (observedRevision === undefined) return;
      let roundRevision = observedRevision;
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
          if (entry.attemptId) {
            const settledRevision = store.finish(epoch, chatId, entry.attemptId, 'failed', now());
            if (settledRevision !== undefined) {
              roundRevision = settledRevision;
              await notice(chatId);
            }
          }
          continue;
        }
        const claim = store.claim(epoch, chatId, now(), roundRevision);
        if (!claim) {
          // Another daemon committed a newer snapshot after our observe. Do not
          // let this stale round manufacture any further invitations.
          if (store.read()?.revision !== roundRevision) return;
          continue;
        }
        roundRevision = claim.revision;
        if (!current()) return;
        try {
          await deps.invite(chatId, freshToken, signal);
          const settledRevision = store.finish(epoch, chatId, claim.attemptId, 'joined', now());
          if (settledRevision !== undefined) roundRevision = settledRevision;
        } catch (error) {
          if (!current()) return;
          if (!(error instanceof OwnerGroupFollowError)) {
            // A transport/parse failure leaves the POST outcome unknown. Keep
            // its durable claim for membership reconciliation and the 120s
            // stale-claim window instead of retrying on the ordinary 60s path.
            deps.log('owner group follow invitation outcome unknown');
            continue;
          }
          const retryable = error.retryable;
          const authorization = error.authorization;
          const issue = error.issue;
          const settledRevision = store.finish(epoch, chatId, claim.attemptId, authorization ? 'authorization' : issue?.pendingApproval ? 'approval' : retryable ? 'retry' : 'failed', now());
          if (settledRevision !== undefined) roundRevision = settledRevision;
          if (authorization) { await notice(undefined, issue); return; }
          if (settledRevision !== undefined && ['failed', 'approval'].includes(store.read()?.entries[chatId]?.status ?? '')) await notice(chatId, issue);
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
