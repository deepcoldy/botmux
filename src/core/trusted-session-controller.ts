import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { getBot } from '../bot-registry.js';

/** The inbound talk gate has already authenticated this caller. Configured
 * groups accept their input as a later turn, regardless of how the session began. */
export function isSerialGroupInput(ds: DaemonSession, caller?: TrustedCaller): boolean {
  if (!caller || caller.requestLarkAppId !== ds.larkAppId
    || caller.source === 'schedule_creator' || ds.adoptedFrom
    || ds.chatType !== 'group') return false;
  return getBot(ds.larkAppId).config.groupSerialInput?.[ds.chatId] === true;
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
