/**
 * Accept a signed card click and start exactly one turn as the clicker.
 * Session lookup and worker delivery are injected so this file does not import
 * the daemon or the worker pool.
 */
import { resolve as resolvePath } from 'node:path';
import {
  admitCardClickSender,
  readCardClickTurnClaims,
  type CardClickNonceConsume,
  type CardClickTurnClaims,
} from './card-click-turn.js';

export interface CardClickBoundSession {
  sessionId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  workingDir?: string;
  live: unknown;
}

export interface CardClickTurnRuntimeDeps {
  now(): number;
  secret(): string;
  nonces: CardClickNonceConsume;
  isBotOrApp(larkAppId: string, openId: string, unionId?: string): boolean;
  evaluateTalk(
    larkAppId: string,
    chatId: string,
    openId: string,
    chatType: 'group' | 'p2p',
    memberUnionId?: string,
  ): { allowed: boolean; reason?: string };
  canOperate(larkAppId: string, chatId: string, openId: string, unionId?: string): boolean;
  grantCommandRestriction(larkAppId: string, chatId: string, openId: string): { blocked: boolean };
  findSession(larkAppId: string, claims: CardClickTurnClaims): CardClickBoundSession | undefined;
  createSession(
    larkAppId: string,
    claims: CardClickTurnClaims,
    senderOpenId: string,
    chatType: 'group' | 'p2p',
  ): Promise<{ ok: true; session: CardClickBoundSession } | { ok: false; reason: string }>;
  workingDirReady(dir: string): boolean;
  setWorkingDir(session: CardClickBoundSession, dir: string): void;
  /** `principal_lane` wins over `cross_principal` when both apply. */
  sessionBlockedShape?(session: CardClickBoundSession | undefined): 'ok' | 'principal_lane' | 'cross_principal';
  startTurn(
    session: CardClickBoundSession,
    args: { senderOpenId: string; memberUnionId?: string; prompt: string },
  ): Promise<{ ok: true; turnId: string } | { ok: false; reason: string }>;
}

export type CardClickTurnFailure =
  | 'bad_signature'
  | 'expired'
  | 'replayed'
  | 'no_identity'
  | 'bot_or_app'
  | 'blocked'
  | 'not_allowed'
  | 'cannot_operate'
  | 'grant_blocked'
  | 'session_not_found'
  | 'working_dir_mismatch'
  | 'working_dir_required'
  | 'working_dir_missing'
  | 'chat_type_mismatch'
  | 'delivery_failed'
  | 'app_mismatch'
  | 'principal_lane'
  | 'cross_principal';

function memberUnionId(unionId: string | undefined): string | undefined {
  return unionId?.startsWith('on_') ? unionId : undefined;
}

function pathsDiffer(left: string, right: string): boolean {
  return resolvePath(left) !== resolvePath(right);
}

export async function acceptCardClickTurn(
  input: {
    larkAppId: string;
    operatorOpenId?: string;
    operatorUnionId?: string;
    payload?: string;
    sig?: string;
  },
  deps: CardClickTurnRuntimeDeps,
): Promise<{ ok: true; chatId: string; run: () => Promise<{ ok: true; turnId: string } | { ok: false; reason: string }> }
  | { ok: false; reason: CardClickTurnFailure }> {
  const now = deps.now();
  let secret: string;
  try { secret = deps.secret(); } catch { return { ok: false, reason: 'bad_signature' }; }
  const verified = readCardClickTurnClaims(input.payload ?? '', input.sig ?? '', secret, now);
  if (!verified.ok) return verified;
  const claims = verified.claims;
  if (claims.larkAppId !== input.larkAppId) return { ok: false, reason: 'app_mismatch' };

  const openId = input.operatorOpenId;
  if (!openId) return { ok: false, reason: 'no_identity' };
  if (deps.isBotOrApp(input.larkAppId, openId, input.operatorUnionId)) return { ok: false, reason: 'bot_or_app' };

  let session = deps.findSession(input.larkAppId, claims);
  if (claims.sessionId && !session) return { ok: false, reason: 'session_not_found' };
  if (session && claims.chatType && claims.chatType !== session.chatType) {
    return { ok: false, reason: 'chat_type_mismatch' };
  }
  const chatId = session?.chatId ?? claims.chatId;
  if (!chatId) return { ok: false, reason: 'session_not_found' };
  const chatType = session?.chatType ?? claims.chatType ?? 'group';
  const unionId = memberUnionId(input.operatorUnionId);

  const talk = deps.evaluateTalk(input.larkAppId, chatId, openId, chatType, unionId);
  const grant = deps.grantCommandRestriction(input.larkAppId, chatId, openId);
  const operate = deps.canOperate(input.larkAppId, chatId, openId, unionId);
  const admitted = admitCardClickSender({
    openId,
    isBotOrApp: false,
    talk,
    canOperate: operate,
    grantBlocked: grant.blocked,
  });
  if (!admitted.ok) return admitted;

  if (claims.workingDir && !deps.workingDirReady(claims.workingDir)) {
    return { ok: false, reason: 'working_dir_missing' };
  }
  if (!session && !claims.workingDir) return { ok: false, reason: 'working_dir_required' };
  if (session && claims.workingDir && session.workingDir && pathsDiffer(claims.workingDir, session.workingDir)) {
    return { ok: false, reason: 'working_dir_mismatch' };
  }
  const blockedShape = deps.sessionBlockedShape?.(session) ?? 'ok';
  if (blockedShape !== 'ok') return { ok: false, reason: blockedShape };

  let consumed: 'ok' | 'replayed' | 'expired';
  try {
    consumed = deps.nonces.consume(claims.nonce, claims.exp, now);
  } catch {
    return { ok: false, reason: 'delivery_failed' };
  }
  if (consumed === 'expired') return { ok: false, reason: 'expired' };
  if (consumed === 'replayed') return { ok: false, reason: 'replayed' };

  let assignDir: string | undefined;
  if (!session) {
    const created = await deps.createSession(input.larkAppId, claims, admitted.senderOpenId, chatType);
    if (!created.ok) {
      return {
        ok: false,
        reason: created.reason === 'working_dir_mismatch' ? 'working_dir_mismatch' : 'delivery_failed',
      };
    }
    session = created.session;
    if (claims.workingDir && session.workingDir && pathsDiffer(claims.workingDir, session.workingDir)) {
      return { ok: false, reason: 'working_dir_mismatch' };
    }
    if (claims.workingDir && !session.workingDir) assignDir = claims.workingDir;
  } else if (claims.workingDir && !session.workingDir) {
    assignDir = claims.workingDir;
  }

  const bound = session;
  const prompt = claims.prompt;
  return {
    ok: true,
    chatId,
    run: async () => {
      if (assignDir) {
        deps.setWorkingDir(bound, assignDir);
        bound.workingDir = assignDir;
      }
      const started = await deps.startTurn(bound, {
        senderOpenId: admitted.senderOpenId,
        ...(unionId ? { memberUnionId: unionId } : {}),
        prompt,
      });
      if (!started.ok && started.reason !== 'delivery_failed') {
        return { ok: false, reason: 'delivery_failed' };
      }
      return started;
    },
  };
}
