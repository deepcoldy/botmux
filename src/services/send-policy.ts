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

export interface AfterTheFactTopicQuoteArgs {
  /** The message id this send would quote (null ⇒ nothing to decide). */
  quoteTargetId: string | null;
  /**
   * The frozen per-turn record's `inThread` for the turn that produced
   * `quoteTargetId`: did the inbound message arrive from INSIDE a topic?
   * `undefined` = unknown (pre-`inThread` session row).
   */
  quotedTurnInThread?: boolean;
  /**
   * `thread_id` the quote target carries RIGHT NOW, freshly probed from Lark.
   * `null` = confirmed no topic. `undefined` = probe failed / not attempted.
   */
  currentThreadId?: string | null;
  /** An explicit `--quote <id>` is the operator's own choice; never override it. */
  explicitQuote?: string;
}

/**
 * Whether a chat-scope send must DROP its quote and post flat instead.
 *
 * Lark's reply API makes a reply inherit the **current** topic membership of the
 * message it quotes — `reply_in_thread: false` only declines to OPEN a new
 * topic, it cannot escape an existing one. So when the user @s the bot at group
 * top level and only AFTERWARDS opens a 话题 on that very message, quoting it
 * drops the answer into a topic the user never @'d the bot in (the same
 * user-reported bug the regular-group fold fixes on the dispatcher side — this
 * is its `botmux send` half, which owns the visible prose reply).
 *
 * Requires BOTH halves, so it can only ever fire on the exact reported case:
 *   • the quoted turn arrived at top level (`inThread === false`), and
 *   • that message NOW carries a `thread_id` — i.e. the topic appeared later.
 *
 * Fails toward the pre-existing behavior (keep quoting) whenever either half is
 * unknown: an old session row has no `inThread`, and a failed/skipped probe
 * leaves `currentThreadId` undefined. Quoting is the long-standing default, so
 * uncertainty must never silently change where every normal reply lands.
 */
export function shouldDropAfterTheFactTopicQuote(args: AfterTheFactTopicQuoteArgs): boolean {
  if (!args.quoteTargetId) return false;
  // `--quote <id>` is an explicit operator instruction; honor it verbatim.
  if (args.explicitQuote) return false;
  // Only a turn PROVEN to have arrived at top level can be a victim here.
  // `undefined` (legacy row) must keep the old behavior, never guess.
  if (args.quotedTurnInThread !== false) return false;
  // The topic must actually exist now. `undefined` = we don't know ⇒ keep quoting.
  return typeof args.currentThreadId === 'string' && args.currentThreadId.trim().length > 0;
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

export interface RawMention {
  /** open_id (ou_…), or a full email / union_id / mobile when the bot
   *  enables arbitrary mention. */
  identifier: string;
  /** optional display name for inline <at> substitution */
  name: string;
}

export interface MentionClassifyResult {
  ok: boolean;
  /** present when !ok — message to print before exit(2) */
  error?: string;
  /** literal open_id entries — always allowed, pass through untouched */
  openIdMentions: RawMention[];
  /** non-open_id entries that must be resolved + membership-gated (empty unless
   *  the switch is on) */
  toResolve: RawMention[];
}

/**
 * Pure gate for `botmux send --mention` identifiers. Splits literal open_ids
 * (always allowed) from non-open_id identifiers (email / union_id /
 * mobile). Non-open_id identifiers are only permitted when the bot config sets
 * `allowArbitraryMention`; otherwise this returns ok:false so the caller can
 * reject before doing any Lark I/O. The actual email→open_id resolution and
 * group-membership check are async side effects the caller performs on
 * `toResolve`. Keeping the decision here makes it unit-testable without Lark.
 */
export function classifyMentionIdentifiers(
  raw: RawMention[],
  allowArbitraryMention: boolean,
): MentionClassifyResult {
  const openIdMentions = raw.filter(r => r.identifier.startsWith('ou_'));
  const nonOpenId = raw.filter(r => !r.identifier.startsWith('ou_'));
  if (nonOpenId.length > 0 && !allowArbitraryMention) {
    return {
      ok: false,
      error:
        `--mention 只接受字面 open_id（ou_…）；不支持用邮箱 @ 任意人。\n` +
        `如需按完整邮箱/手机号/union_id @ 群内成员，请在该 bot 配置里设 allowArbitraryMention: true。\n` +
        `无法解析的项：${nonOpenId.map(r => r.identifier).join(', ')}`,
      openIdMentions,
      toResolve: [],
    };
  }
  return { ok: true, openIdMentions, toResolve: nonOpenId };
}

/**
 * Pure group-membership gate for resolved --mention targets. Given the resolved
 * open_id per non-open_id identifier and the set of open_ids that are actually
 * members of the destination chat, return the identifiers whose resolved open_id
 * is NOT a member (the ones that must be rejected). Extracted from cmdSend so the
 * "in-group passes / out-of-group rejected" contract is unit-testable without
 * Lark I/O — a mutation that deletes the check (always [] ) or reverses it
 * (`has` instead of `!has`) must make these tests fail.
 */
export function outsidersForMembership(
  resolved: Array<{ identifier: string; openId: string }>,
  memberIds: Set<string>,
): Array<{ identifier: string; openId: string }> {
  return resolved.filter(r => !memberIds.has(r.openId));
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
