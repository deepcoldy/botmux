import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { findOncallChat } from '../bot-registry.js';

/** The inbound talk gate has already authenticated this caller. A shared
 * oncall bootstrap accepts their input as a later turn, never as a steer. */
export function isCollaborativeOncallInput(ds: DaemonSession, caller?: TrustedCaller): boolean {
  if (!caller || caller.requestLarkAppId !== ds.larkAppId
    || caller.source === 'schedule_creator' || ds.adoptedFrom
    || ds.chatType !== 'group') return false;
  // Older chat-scope bootstraps predate the explicit origin field. These
  // daemon-minted turn contexts also survive restart and cannot come from text.
  const autoStarted = ds.session.autoStartedOnGroupJoin
    ?? Object.keys(ds.session.turnReplyContexts ?? {}).some(id => id.startsWith('join_'));
  return autoStarted && !!findOncallChat(ds.larkAppId, ds.chatId);
}

/** Derive the stable task controller from the session owner, never from
 * historical caller fields that may belong to a different principal. */
export function trustedSessionController(ds: DaemonSession): TrustedCaller | undefined {
  const ownerOpenId = ds.ownerOpenId ?? ds.session.ownerOpenId;
  const ownerUnionId = ds.session.ownerUnionId;
  if (!ownerOpenId && !ownerUnionId) return undefined;
  return {
    ...(ownerOpenId ? { requestUserOpenId: ownerOpenId } : {}),
    ...(ownerUnionId ? { requestUserUnionId: ownerUnionId } : {}),
    requestLarkAppId: ds.larkAppId,
    senderType: 'user',
  };
}
