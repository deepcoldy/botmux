import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';

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
