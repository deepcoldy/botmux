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
import type { TurnParticipant } from '../types.js';

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

export interface ManagedVcQuoteArgs {
  managed: boolean;
  durableDelivery: boolean;
  explicitImMessageId?: string;
  explicitQuote?: string;
}

/** A quote message id is a routing primitive: Lark's reply API derives the
 * destination chat from that id, not from the separately supplied chat id.
 * Managed deliveries therefore cannot choose one, while an explicit IM turn
 * may quote only the exact Lark message frozen in its origin snapshot. */
export function managedVcQuoteError(args: ManagedVcQuoteArgs): string | null {
  if (!args.managed || !args.explicitQuote) return null;
  if (args.durableDelivery || args.explicitQuote !== args.explicitImMessageId) {
    return '--quote 必须是本轮精确路由的 IM 消息；durable delivery 不能指定引用目标。';
  }
  return null;
}

/** Managed VC output must stay within botmux-owned message shapes. Even though
 * ordinary custom cards are scanned for known callback controls, treating an
 * evolving third-party card schema as an exhaustive privilege boundary is not
 * safe for meeting-derived (untrusted) model output. */
export function managedVcCustomCardError(managed: boolean, customCardRequested: boolean): string | null {
  if (!managed || !customCardRequested) return null;
  return '--card-json/--card-file 不允许用于受管 VC 回复；请使用普通文本。';
}

export interface ManagedVcSendControlArgs {
  managed: boolean;
  sendTopLevel: boolean;
  overrideChatId?: string;
  sendInto?: string;
  attentionRequested: boolean;
  explicitMentionCount: number;
  mentionBack: boolean;
  noMention: boolean;
}

/** Freeze every managed reply to the listener-thread route and a no-mention
 * addressing mode. Routing/mention/attention are independent side effects that
 * are not represented by the primary VC action identity. */
export function managedVcSendControlError(args: ManagedVcSendControlArgs): string | null {
  if (!args.managed) return null;
  if (args.sendTopLevel || args.overrideChatId || args.sendInto) {
    return '--top-level/--chat-id/--into 不能改变受管 VC 的 listener-thread 路由。';
  }
  if (args.attentionRequested) {
    return '--attention 不属于受管 VC 主消息 action。';
  }
  if (args.explicitMentionCount > 0 || args.mentionBack || !args.noMention) {
    return '受管 VC 回复必须显式使用 --no-mention，不能使用 --mention/--mention-back。';
  }
  return null;
}

export interface ManagedVcSendPayloadArgs {
  managed: boolean;
  asVoice: boolean;
  hasBodyText: boolean;
  imageCount: number;
  fileCount: number;
  videoCount: number;
  containsNativeAtTag: boolean;
}

/** A dedicated receiver may emit only one botmux-owned text card. Provider
 * uploads (image/file/video/audio) happen before a Lark message UUID can be
 * reconciled, so allowing them would give retries or repeated commands an
 * unledgered resource-creation channel even when the visible message dedupes. */
export function managedVcSendPayloadError(args: ManagedVcSendPayloadArgs): string | null {
  if (!args.managed) return null;
  if (args.asVoice || args.imageCount > 0 || args.fileCount > 0 || args.videoCount > 0) {
    return '受管 VC 回复只允许普通文本；图片、文件、视频和语音上传没有可恢复的 action identity。';
  }
  if (args.containsNativeAtTag) {
    return '受管 VC 文本不能包含原生 <at …> 标签。';
  }
  return null;
}

export function containsLarkAtTag(content: string): boolean {
  return /<at(?:\s|>)/iu.test(content);
}

/** Render model-authored native Lark mention tags inert before placing the
 * text in a botmux-owned card. Full-width angle brackets are intentional:
 * unlike an HTML entity, they cannot be decoded and re-interpreted as a
 * second-pass `<at>` control by the card renderer. */
export function neutralizeLarkAtTags(content: string): string {
  return content
    .replace(/<at(?=\s|>)/giu, '＜at')
    .replace(/<\/at\s*>/giu, match => `＜${match.slice(1, -1)}＞`);
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

export interface MentionBackAmbiguityArgs {
  /** Session chat type — a p2p DM is inherently 1v1, never ambiguous. */
  chatType?: 'group' | 'p2p';
  /** Turn-window counterparts (executable open_id candidates; sender + @-mentions
   *  across folded/type-ahead messages, self bot already excluded, deduped). */
  participants: TurnParticipant[];
  /** True when the window may be under-counted (an unresolved non-open_id @, a
   *  pruned sibling, or no window at all). Forces ambiguous regardless of count
   *  so the model must make an explicit decision. */
  incomplete?: boolean;
}

export interface MentionBackAmbiguityResult {
  /** True when --mention-back is ambiguous and must be replaced by an explicit
   *  --mention / --no-mention (2+ distinct counterparts, or an incomplete
   *  window that could hide additional counterparts). */
  ambiguous: boolean;
  /** The known distinct counterparts to offer as explicit --mention candidates.
   *  May be shorter than the true set when `incomplete` is true. */
  candidates: TurnParticipant[];
  /** Propagated from args: the candidate list is known-incomplete. */
  incomplete: boolean;
}

/**
 * Is `--mention-back` ambiguous for THIS turn? --mention-back means "@ back the
 * one counterpart who triggered this turn". That is unambiguous only when the
 * turn's window provably had a single counterpart. It becomes ambiguous when:
 *   - two or more distinct people/bots took part (a human + a peer bot, two
 *     humans, the triggerer plus someone they @-ed, a type-ahead follow-up from
 *     a third party, …); OR
 *   - the window is INCOMPLETE (an @ we couldn't resolve to an open_id, a
 *     pruned sibling, or no window record at all) — a hidden counterpart may
 *     exist, so we must not assume the lone visible one is the only target.
 * In either case we ask the model to pick an explicit `--mention <open_id>`
 * (from the known candidates) or `--no-mention`, rather than auto-@-ing.
 *
 * NOT symmetric on human-vs-bot: a bot→bot handoff in a provably 1v1 window
 * stays unambiguous (allowed); a lone human likewise. p2p short-circuits to
 * not-ambiguous. Fail-safe: uncertainty always resolves to ambiguous.
 */
export function mentionBackAmbiguity(args: MentionBackAmbiguityArgs): MentionBackAmbiguityResult {
  if (args.chatType === 'p2p') return { ambiguous: false, candidates: [], incomplete: false };
  const distinct = args.participants.filter(p => !!p.openId);
  const incomplete = !!args.incomplete;
  if (!incomplete && distinct.length <= 1) return { ambiguous: false, candidates: [], incomplete: false };
  return { ambiguous: true, candidates: distinct, incomplete };
}

/** Render the blocked-`--mention-back` error: explains the ambiguity and lists
 *  every KNOWN candidate's open_id + name + person/bot/unknown so the model can
 *  `--mention <open_id>` the right one instead of guessing. When the window is
 *  incomplete, says so (there may be participants without a listable open_id). */
export function mentionBackAmbiguityError(candidates: TurnParticipant[], incomplete = false): string {
  const kindLabel = (p: TurnParticipant): string => (p.isBot === true ? 'bot' : p.isBot === false ? '人' : '未知');
  const lines = candidates.map((p) => {
    const name = p.name ? ` ${p.name}` : '';
    return `  • ${p.openId}（${kindLabel(p)}${name}）`;
  });
  const head = incomplete
    ? '--mention-back 本轮无法确定唯一 @ 对象（本轮参与者可能不止下列这些，或有无法解析的 @）：'
    : '--mention-back 在本轮有多个参与者时不可用："回复触发这轮的人" 在多方场景可能 @ 错对象。';
  const listIntro = candidates.length
    ? '请改用 --mention <open_id> 显式点名下列已知本轮参与者之一（可重复 --mention 点多个），或 --no-mention 不 @：'
    : '请改用 --mention <open_id> 显式点名，或 --no-mention 不 @。';
  return [head, listIntro, ...(lines.length ? [lines.join('\n')] : [])].join('\n');
}

/**
 * Agent "raise-hand" attention flag for `botmux send --attention[=kind]`.
 *
 * `--attention`            → boolean raise, kind defaults to 'blocked'.
 * `--attention=<kind>`     → raise with an explicit kind.
 * Unknown kinds fall back to 'blocked' (lenient: never fail the send over a
 * typo'd category — the reason text carries the real meaning).
 *
 * MUST be parsed here, not via argValue('--attention'), because a bare
 * `--attention "我卡住了"` would otherwise eat the message as the flag value.
 * Callers must also add '--attention' to positionals()' booleanFlags so the
 * body isn't swallowed.
 */
export const ATTENTION_KINDS = ['authz', 'decision', 'blocked', 'help'] as const;

export function parseAttentionFlag(args: string[]): { requested: boolean; kind: string } {
  const arg = args.find(a => a === '--attention' || a.startsWith('--attention='));
  if (!arg) return { requested: false, kind: 'blocked' };
  const raw = arg.includes('=') ? arg.slice('--attention='.length) : '';
  const kind = (ATTENTION_KINDS as readonly string[]).includes(raw) ? raw : 'blocked';
  return { requested: true, kind };
}

export interface AttentionUsageArgs {
  requested: boolean;
  /** --top-level */
  sendTopLevel: boolean;
  /** --chat-id <id> */
  overrideChatId?: string;
  /** --into <topic> */
  sendInto?: string;
  /** --voice */
  asVoice?: boolean;
  /** message body has non-empty text */
  hasText: boolean;
}

/**
 * Guard `--attention` usage. Returns an error string, or null if OK.
 * `--attention` only makes sense replying into the CURRENT session: clear-on-reply
 * binds to this session's anchor, so routing the message elsewhere (--top-level /
 * --chat-id / --into) would leave the needs-you signal un-clearable. And the
 * dashboard needs a text reason, so an image/file-only send can't raise.
 */
export function attentionUsageError(args: AttentionUsageArgs): string | null {
  if (!args.requested) return null;
  if (args.sendTopLevel || args.overrideChatId || args.sendInto) {
    return '--attention 只能用于回复当前会话，不能与 --top-level / --chat-id / --into 混用。';
  }
  if (args.asVoice) {
    return '--attention 只能用于文本/卡片消息，不能与 --voice 混用。';
  }
  if (!args.hasText) {
    return '--attention 需要文本 reason（看板「需要你」列要显示原因，不能只发图片/文件）。';
  }
  return null;
}
