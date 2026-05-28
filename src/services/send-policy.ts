/**
 * Pure decision helpers for `botmux send` (extracted from cmdSend so they can
 * be unit-tested without process.exit / Lark I/O).
 *
 * Two policies live here:
 *   - resolveQuoteTarget: which message a chat-scope send should quote (reply
 *     to), so 普通群 messages render Lark's 引用 chain. Thread-scope and
 *     --top-level never quote.
 *   - validateMentionDecision: the @ hard-gate — every model-initiated reply
 *     must explicitly choose --mention / --mention-back / --no-mention.
 */

export interface QuoteTargetArgs {
  /** session.scope === 'chat' */
  isChatScope: boolean;
  /** --top-level publish mode */
  sendTopLevel: boolean;
  /** --no-quote: force a plain (un-quoted) send */
  noQuote: boolean;
  /** --quote <message_id> explicit override */
  explicitQuote?: string;
  /** session.quoteTargetId — the latest inbound message this turn responds to */
  sessionQuoteTargetId?: string;
}

/**
 * Resolve the message id a send should quote, or null for a plain send.
 * Priority: --quote > session.quoteTargetId. Only chat-scope, non-top-level,
 * non-`--no-quote` sends quote.
 */
export function resolveQuoteTarget(args: QuoteTargetArgs): string | null {
  if (!args.isChatScope || args.sendTopLevel || args.noQuote) return null;
  const target = args.explicitQuote ?? args.sessionQuoteTargetId;
  return target && target.trim() ? target.trim() : null;
}

export interface MentionDecisionArgs {
  /** config.send.requireMentionDecision */
  enabled: boolean;
  /** --top-level publish is exempt from the gate */
  sendTopLevel: boolean;
  /** at least one --mention <ou:Name> given */
  hasMentionArgs: boolean;
  /** --mention-back given */
  mentionBack: boolean;
  /** --no-mention given */
  noMention: boolean;
  /** whether the session knows who sent the message being replied to */
  hasQuoteTargetSender: boolean;
}

export interface MentionDecisionResult {
  ok: boolean;
  /** present when !ok — the message to print before exit(2) */
  error?: string;
}

/**
 * Enforce that the model made an explicit @ decision before sending.
 * Returns ok:false with a context-aware error when no decision was made or
 * the flags contradict each other.
 */
export function validateMentionDecision(args: MentionDecisionArgs): MentionDecisionResult {
  if (!args.enabled || args.sendTopLevel) return { ok: true };

  if (args.noMention && (args.hasMentionArgs || args.mentionBack)) {
    return { ok: false, error: '--no-mention 不能与 --mention / --mention-back 同时使用。' };
  }

  if (args.mentionBack && !args.hasQuoteTargetSender) {
    return { ok: false, error: '--mention-back 无可 @ 对象：本轮没有可识别的触发消息发送者。请改用 --mention <ou:Name> 或 --no-mention。' };
  }

  const decided = args.hasMentionArgs || args.mentionBack || args.noMention;
  if (decided) return { ok: true };

  // No decision made — guide by message VALUE (not by human-vs-bot). Avoid
  // letting --no-mention become the lazy default, and avoid meaningless @.
  return {
    ok: false,
    error: '本条需显式 @ 决策（别把 --no-mention 当默认）：有实质结论、要对方继续看/确认/决策 → --mention-back（或 --mention <ou:Name> 点名）；纯记录/低优先级进度/简短确认 → --no-mention；若只是没信息量的"收到"，不如不发，等有内容再回。',
  };
}
