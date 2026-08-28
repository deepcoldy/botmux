import { readSessionRowCopiesAcrossStores } from '../services/session-store.js';
import { findAuthenticatedAncestorSessionContext } from './session-marker.js';
import {
  authorizeScheduledTurn,
  parseScheduledTurnId,
  scheduledTurnAuthErrorMessage,
} from './scheduled-turn-provenance.js';

interface PersistedTurnSession {
  sessionId: string;
  status?: string;
  scope?: 'thread' | 'chat';
  larkAppId?: string;
  chatId?: string;
  chatType?: 'group' | 'p2p';
  rootMessageId?: string;
  lastCallerOpenId?: string;
  quoteTargetId?: string;
  currentReplyTarget?: {
    rootMessageId?: string;
    turnId?: string;
  };
}

export interface CurrentTurnProvenance {
  sessionId: string;
  turnId: string;
  callerOpenId: string;
  larkAppId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  /**
   * The current user-visible thread anchor. Thread sessions use their durable
   * root; a chat-scope turn folded into a topic uses that turn's reply target;
   * a chat-top-level turn deliberately has no root.
   */
  rootMessageId?: string;
}

export class CurrentTurnProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrentTurnProvenanceError';
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readPersistedSession(dataDir: string, sessionId: string): PersistedTurnSession {
  // The scan itself lives in session-store (fail-closed on an unlistable data
  // dir, corrupt individual files skipped so an unrelated bot's bad file can
  // neither block nor impersonate a valid record). The exactly-once policy —
  // a duplicated row must not be used to infer the caller — stays here.
  let matches: readonly unknown[];
  try {
    matches = readSessionRowCopiesAcrossStores(sessionId, dataDir);
  } catch (err) {
    throw new CurrentTurnProvenanceError(
      `无法读取 botmux session store：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (matches.length === 0) {
    throw new CurrentTurnProvenanceError(`未找到当前进程所属 session ${sessionId}`);
  }
  if (matches.length !== 1) {
    throw new CurrentTurnProvenanceError(
      `session ${sessionId} 在多个 session store 中重复，拒绝推断当前调用者`,
    );
  }
  return matches[0] as PersistedTurnSession;
}

export interface ResolveCurrentTurnProvenanceOptions {
  dataDir: string;
  /** Inherited session id is only a stale/detached detector, never identity. */
  envSessionId?: string;
  startPid?: number;
}

/**
 * Authenticate an agent-facing command as the human who opened the *current*
 * botmux turn.
 *
 * Unlike the read/reply command resolver, this intentionally has no inherited
 * env fallback. A long-lived CLI keeps stale BOTMUX_TURN_ID/OWNER values, and a
 * detached child keeps those values after losing the process-tree link. A
 * mutating workflow command therefore requires the worker's fresh ancestor
 * marker (sessionId + turnId), then joins it to the latest durable session
 * record. Missing, detached and stale invocations fail closed.
 *
 * Returns null only for a genuine standalone/dev invocation: there is neither
 * an ancestor marker nor an inherited BOTMUX_SESSION_ID claim.
 */
export function resolveCurrentTurnProvenance(
  options: ResolveCurrentTurnProvenanceOptions,
): CurrentTurnProvenance | null {
  const marker = findAuthenticatedAncestorSessionContext(
    options.dataDir,
    options.startPid ?? process.ppid,
  );
  if (!marker) {
    if (nonEmpty(options.envSessionId)) {
      throw new CurrentTurnProvenanceError(
        '当前命令已脱离 botmux CLI 进程树，无法验证本轮调用者；请在当前前台 turn 中重试',
      );
    }
    return null;
  }
  if (!nonEmpty(marker.sessionId) || !nonEmpty(marker.turnId)) {
    throw new CurrentTurnProvenanceError(
      '当前 botmux CLI 进程标记缺少 sessionId/turnId，拒绝使用陈旧环境变量授权',
    );
  }
  if (nonEmpty(options.envSessionId) && options.envSessionId !== marker.sessionId) {
    throw new CurrentTurnProvenanceError(
      `进程标记 session ${marker.sessionId} 与环境 session ${options.envSessionId} 不一致`,
    );
  }

  const session = readPersistedSession(options.dataDir, marker.sessionId);
  if (session.status && session.status !== 'active') {
    throw new CurrentTurnProvenanceError(`session ${marker.sessionId} 已非 active，拒绝授权当前命令`);
  }
  if (!nonEmpty(session.larkAppId) || !nonEmpty(session.chatId)) {
    throw new CurrentTurnProvenanceError(`session ${marker.sessionId} 缺少 larkAppId/chatId`);
  }

  const replyTarget = session.currentReplyTarget;

  // Daemon-initiated scheduled turn (`schedule:<taskId>:<uuid>`): no human
  // inbound message exists, so quoteTargetId/lastCallerOpenId were never set
  // for this turn. Authenticate via the task binding + owner gate instead of
  // the generation join. The live owner-allowed check is enforced on the
  // sandboxed relay path (session-relay): the sandboxed CLI cannot read
  // bots.json, and the daemon re-checks before every run mutation there.
  // The default non-sandboxed signed-envelope route does not re-check
  // membership — see scheduled-turn-provenance for the exact boundary.
  if (parseScheduledTurnId(marker.turnId)) {
    const auth = authorizeScheduledTurn({
      turnId: marker.turnId,
      dataDir: options.dataDir,
      sessionLarkAppId: session.larkAppId,
      sessionChatId: session.chatId,
      isOwnerAllowed: () => true,
    });
    if ('error' in auth) {
      throw new CurrentTurnProvenanceError(scheduledTurnAuthErrorMessage(auth.error));
    }
    let scheduledRootMessageId: string | undefined;
    if ((session.scope ?? 'thread') === 'thread') {
      if (!nonEmpty(session.rootMessageId)) {
        throw new CurrentTurnProvenanceError(`thread session ${marker.sessionId} 缺少 rootMessageId`);
      }
      scheduledRootMessageId = session.rootMessageId;
    } else if (replyTarget) {
      if (!nonEmpty(replyTarget.rootMessageId)) {
        throw new CurrentTurnProvenanceError(`chat session ${marker.sessionId} 的当前 reply target 缺少 rootMessageId`);
      }
      scheduledRootMessageId = replyTarget.rootMessageId;
    }
    return {
      sessionId: marker.sessionId,
      turnId: marker.turnId,
      callerOpenId: auth.ownerOpenId,
      larkAppId: session.larkAppId,
      chatId: session.chatId,
      ...(session.chatType === 'group' || session.chatType === 'p2p'
        ? { chatType: session.chatType }
        : {}),
      ...(scheduledRootMessageId ? { rootMessageId: scheduledRootMessageId } : {}),
    };
  }

  if (!nonEmpty(session.quoteTargetId) || session.quoteTargetId !== marker.turnId) {
    throw new CurrentTurnProvenanceError(
      `进程标记 turn ${marker.turnId} 与 session 当前 quote turn ${session.quoteTargetId ?? '(missing)'} 不一致`,
    );
  }
  if (replyTarget && (!nonEmpty(replyTarget.turnId) || replyTarget.turnId !== marker.turnId)) {
    throw new CurrentTurnProvenanceError(
      `进程标记 turn ${marker.turnId} 与 session 当前 reply turn ${replyTarget.turnId ?? '(missing)'} 不一致`,
    );
  }
  if (!nonEmpty(session.lastCallerOpenId)) {
    throw new CurrentTurnProvenanceError(`session ${marker.sessionId} 缺少 lastCallerOpenId`);
  }

  let rootMessageId: string | undefined;
  if ((session.scope ?? 'thread') === 'thread') {
    if (!nonEmpty(session.rootMessageId)) {
      throw new CurrentTurnProvenanceError(`thread session ${marker.sessionId} 缺少 rootMessageId`);
    }
    rootMessageId = session.rootMessageId;
  } else if (replyTarget) {
    if (!nonEmpty(replyTarget.rootMessageId)) {
      throw new CurrentTurnProvenanceError(`chat session ${marker.sessionId} 的当前 reply target 缺少 rootMessageId`);
    }
    rootMessageId = replyTarget.rootMessageId;
  }

  return {
    sessionId: marker.sessionId,
    turnId: marker.turnId,
    callerOpenId: session.lastCallerOpenId,
    larkAppId: session.larkAppId,
    chatId: session.chatId,
    ...(session.chatType === 'group' || session.chatType === 'p2p'
      ? { chatType: session.chatType }
      : {}),
    ...(rootMessageId ? { rootMessageId } : {}),
  };
}
