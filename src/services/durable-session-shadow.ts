import type { Session } from '../types.js';
import { sessionKey, storedSessionAnchorId } from '../core/types.js';
import type { DurableJson } from './durable-coordination.js';

export const DURABLE_SESSION_SHADOW_PROJECTION_VERSION = 1 as const;

/**
 * Deliberately narrow shadow copy. Titles, prompts, owners, paths, attachments,
 * tokens, provider lineage and terminal state stay exclusively in the existing
 * Session store until each field has an explicit multi-replica contract.
 */
export interface DurableSessionShadowProjection {
  version: typeof DURABLE_SESSION_SHADOW_PROJECTION_VERSION;
  type: 'botmux.session.shadow';
  sessionId: string;
  larkAppId: string;
  anchorId: string;
  scope: 'thread' | 'chat';
  status: 'active' | 'closed';
  createdAt: string;
  lastMessageAt?: string;
  closedAt?: string;
}

export function durableSessionShadowProjection(session: Session): {
  sessionKey: string;
  value: DurableJson;
} {
  const sessionId = session.sessionId?.trim();
  const larkAppId = session.larkAppId?.trim();
  const anchorId = storedSessionAnchorId(session)?.trim();
  if (!sessionId || sessionId.length > 256) {
    throw new Error('durable Session shadow requires a bounded sessionId');
  }
  if (!larkAppId || larkAppId.length > 256) {
    throw new Error('durable Session shadow requires a bounded larkAppId');
  }
  if (!anchorId || anchorId.length > 512) {
    throw new Error('durable Session shadow requires a bounded routing anchor');
  }
  const value: DurableSessionShadowProjection = {
    version: DURABLE_SESSION_SHADOW_PROJECTION_VERSION,
    type: 'botmux.session.shadow',
    sessionId,
    larkAppId,
    anchorId,
    scope: session.scope === 'chat' ? 'chat' : 'thread',
    status: session.status,
    createdAt: session.createdAt,
    ...(session.lastMessageAt ? { lastMessageAt: session.lastMessageAt } : {}),
    ...(session.closedAt ? { closedAt: session.closedAt } : {}),
  };
  return {
    sessionKey: sessionKey(anchorId, larkAppId),
    value: value as unknown as DurableJson,
  };
}
