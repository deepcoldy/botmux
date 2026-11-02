import type { TrustedCaller } from '../types.js';

export interface InboundTrustedCallerInput {
  larkAppId: string;
  senderOpenId?: string;
  senderUnionId?: string;
  senderIsBot?: boolean;
  /** Exact signed inbound Lark message that opened the turn. */
  messageId?: string;
}

export interface InboundTrustedCallerDeps {
  resolveMessageSenderUnionId(
    larkAppId: string,
    messageId: string,
  ): Promise<string | null>;
}

const UNION_ID_RE = /^on_[A-Za-z0-9_-]{4,128}$/;

/**
 * Build the host-owned caller snapshot for an ordinary inbound turn.
 *
 * Some Lark message events omit `sender.sender_id.union_id` even for a human.
 * Only a provably-human event may repair that omission, and only by asking
 * Lark for the sender of the exact signed message with `user_id_type=union_id`.
 * Unknown/bot senders never enter this fallback, so the lookup cannot turn a
 * peer bot into a human database principal.
 */
export async function trustedCallerFromInbound(
  input: InboundTrustedCallerInput,
  deps: InboundTrustedCallerDeps,
): Promise<TrustedCaller | undefined> {
  let unionId = input.senderUnionId;
  if (!unionId
    && input.senderIsBot === false
    && input.senderOpenId
    && input.messageId?.startsWith('om_')) {
    try {
      const resolved = await deps.resolveMessageSenderUnionId(
        input.larkAppId,
        input.messageId,
      );
      if (resolved && UNION_ID_RE.test(resolved)) unionId = resolved;
    } catch {
      // Best-effort repair. The caller remains open_id-only and consumers that
      // require union_id continue to fail closed.
    }
  }

  if (!input.senderOpenId && !unionId) return undefined;
  return {
    ...(input.senderOpenId ? { requestUserOpenId: input.senderOpenId } : {}),
    ...(unionId ? { requestUserUnionId: unionId } : {}),
    requestLarkAppId: input.larkAppId,
    ...(input.senderIsBot === undefined
      ? {}
      : { senderType: input.senderIsBot ? 'bot' as const : 'user' as const }),
  };
}
