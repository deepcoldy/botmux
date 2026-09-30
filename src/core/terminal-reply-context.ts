import type { DaemonSession } from './types.js';
import { frozenReplyContextForTurn, pickTurnReplyTarget } from './reply-target.js';

/** A native terminal turn has its own delivery identity, but zero-injection
 * sessions keep replying to the latest IM initiator. Capture once at start;
 * neither completion nor a retry may borrow a later sender or destination. */
export function captureTerminalReplyContext(ds: DaemonSession, turnId: string, startedAtMs: number, replyContextTurnId?: string): boolean {
  if (ds.session.turnReplyContexts?.[turnId]) return false;
  const continuation = replyContextTurnId ? ds.session.turnReplyContexts?.[replyContextTurnId] : undefined;
  let sourceId = ds.session.quoteTargetId ?? ds.session.currentReplyTarget?.turnId;
  const targets = ds.session.replyTargets ?? {};
  // IPC may arrive just after a newer IM input. Native timestamps let us
  // select the latest real input that existed when this terminal turn began.
  if (sourceId && Date.parse(targets[sourceId]?.updatedAt ?? '') > startedAtMs) {
    sourceId = Object.entries(targets)
      .filter(([, entry]) => Date.parse(entry.updatedAt) <= startedAtMs)
      .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))[0]?.[0];
  }
  const source = sourceId ? pickTurnReplyTarget(ds.session, sourceId) : undefined;
  const context = frozenReplyContextForTurn(ds, sourceId);
  const exactLegacy = sourceId !== undefined && sourceId === ds.session.quoteTargetId;
  const sender = source?.senderOpenId ?? context.replyTargetSenderOpenId
    ?? (exactLegacy ? ds.session.quoteTargetSenderOpenId : undefined);
  const isBot = context.replyTargetSenderIsBot
    ?? source?.participants?.find(p => p.openId === sender)?.isBot
    ?? (exactLegacy ? ds.session.quoteTargetSenderIsBot : undefined);
  const contexts = ds.session.turnReplyContexts ??= {};
  const inherited = continuation ?? {
    ...context,
    ...(sender ? { replyTargetSenderOpenId: sender } : {}),
    ...(isBot !== undefined ? { replyTargetSenderIsBot: isBot } : {}),
  };
  contexts[turnId] = { ...inherited, target: { ...inherited.target } };
  // Keep the latest original IM anchor even after many terminal-only rounds.
  for (const stale of Object.keys(contexts).filter(id => id !== sourceId).slice(0, Math.max(0, Object.keys(contexts).length - 256))) {
    delete contexts[stale];
  }
  return true;
}
