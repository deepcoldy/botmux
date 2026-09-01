/**
 * Markdown → Feishu interactive card v2 body builder.
 *
 * Shared by `cli.ts` (`botmux send`) and `core/worker-pool.ts` (bridge
 * fallback final_output forwarding) so a model reply going through either
 * path renders identically in the Lark thread — same chrome, same markdown
 * rendering, same table widget.
 *
 * Implementation note: parsing is delegated to `markdown-it` (CommonMark +
 * GFM tables) instead of hand-rolled regex. The previous regex-based fence
 * splitter mis-fired on two real cases observed in production:
 *   1. Code fences directly adjacent to a prose line (no blank line) — Feishu's
 *      markdown widget needs blank lines around fences, and the old splitter
 *      didn't enforce them, so fences leaked through as literal `\`\`\`` text.
 *   2. Nested 3-backtick fences — the non-greedy regex closed the outer fence
 *      at the first inner one, garbling everything after it.
 * markdown-it tokenizes correctly per CommonMark and gives us blank-line
 * normalization for free. For nested fences users should use 4+ backticks for
 * the outer block (CommonMark spec).
 */

import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { t, type Locale } from '../../i18n/index.js';
import {
  REPLY_CARD_FOOTER_ELEMENT_ID,
  REPLY_CARD_FOOTER_MARKER,
  replyCardHeadingElementId,
} from './reply-card-footer-signature.js';
import { buildFeedbackElement } from './skill-feedback-card.js';
import type { FeedbackPolicy } from '../../services/feedback-policy.js';
import type { ReplyCardHeader } from './reply-card-style.js';

export { REPLY_CARD_FOOTER_MARKER } from './reply-card-footer-signature.js';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
const MAX_LOCAL_HOME_LINK_REPAIRS = 256;
/** Keep structured replies readable without letting heading-heavy model output
 *  multiply schema-v2 body elements without bound. Each promoted heading can
 *  split one prose buffer into another element, so six keeps ordinary cards
 *  bounded while still covering the sections in a typical result report. */
const MAX_PROMOTED_CARD_HEADINGS = 6;

/** Canonical chrome for ordinary Bot Session reply cards. The CLI send path
 *  and daemon final-output fallback both spread this object so layout cannot
 *  drift between an explicit `botmux send` and an automatic fallback reply. */
export const REPLY_CARD_CONFIG = {
  update_multi: true,
  width_mode: 'fill',
} as const;

export interface ReplyCardV2 {
  schema: '2.0';
  config: { update_multi: true; width_mode: 'fill' };
  header?: ReplyCardHeader;
  body: { direction: 'vertical'; elements: any[] };
}

/** Single envelope shared by direct sends and fallback reply-card builders. */
export function createReplyCard(
  elements: any[],
  header?: ReplyCardHeader,
): ReplyCardV2 {
  return {
    schema: '2.0',
    config: { ...REPLY_CARD_CONFIG },
    ...(header ? { header } : {}),
    body: { direction: 'vertical', elements },
  };
}

export type LocalHomeLinkMode = 'filesystem' | 'lexical' | 'disabled';

/** Native usage facts rendered in a Bot reply-card footer. Context is the
 * latest context-window measurement; tokens are cumulative for the Session.
 * Missing facts are omitted independently and must never be estimated. */
export interface CardUsageSnapshot {
  context: {
    usedTokens: number;
    windowTokens?: number;
    percentUsed?: number;
  } | null;
  tokens: {
    in: number;
    out: number;
  } | null;
  /** Delta for the latest user turn (small, matches the CLI TUI's per-turn
   *  ↑↓). Null for dialects without per-turn tracking. Rendered on the live
   *  streaming card; the reply-card footer stays compact and omits it. */
  turnTokens?: {
    in: number;
    out: number;
  } | null;
  /** Latest executor-reported model. Rendered by session-status cards only. */
  model?: string;
  /** Latest executor-reported reasoning effort. */
  reasoningEffort?: string;
}

export interface ReplyCardFooter {
  /** Fully wrapped markdown content, reusable inside the voice-button row. */
  content: string;
  /** Standalone footer element used by ordinary reply cards. */
  element: {
    tag: 'markdown';
    element_id: typeof REPLY_CARD_FOOTER_ELEMENT_ID;
    text_size: 'notation';
    content: string;
  };
}

interface LocalHomeCandidate {
  id: number;
  start: number;
  end: number;
  value: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find home-prefix occurrences that are worth asking markdown-it about. The
 * scan deliberately over-matches prose and code: a unique, URL-safe marker is
 * injected before each occurrence and only markers that markdown-it returns
 * as the start of a real `link_open` href are accepted. This keeps CommonMark
 * semantics (containers, code, tables, and all newline styles) in one parser
 * instead of recreating source maps or inline rules here.
 */
function collectLocalHomeLinkCandidates(
  input: string,
  relativeHome: string,
): LocalHomeCandidate[] {
  const homeOccurrence = new RegExp(
    `${escapeRegExp(relativeHome)}(?=$|[/?#>:()\\s\\\\])`,
    'gi',
  );
  const candidates: LocalHomeCandidate[] = [];
  for (const match of input.matchAll(homeOccurrence)) {
    const start = match.index;
    candidates.push({
      id: candidates.length,
      start,
      end: start + match[0].length,
      value: '',
    });
  }
  return candidates;
}

function chooseLinkMarkerPrefix(input: string): string {
  let prefix: string;
  do {
    prefix = `bmxlocallink${randomBytes(12).toString('hex')}x`;
  } while (input.includes(prefix));
  return prefix;
}

/** Return only candidates that markdown-it confirms start a real link href. */
function validateLocalHomeLinkCandidates(
  input: string,
  candidates: LocalHomeCandidate[],
): LocalHomeCandidate[] {
  if (candidates.length === 0) return [];

  const markerPrefix = chooseLinkMarkerPrefix(input);
  const markedParts: string[] = [];
  let sourceCursor = 0;
  for (const candidate of candidates) {
    const marker = `${markerPrefix}${candidate.id}x/`;
    markedParts.push(input.slice(sourceCursor, candidate.start), marker);
    sourceCursor = candidate.start;
  }
  markedParts.push(input.slice(sourceCursor));
  const marked = markedParts.join('');

  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const confirmed = new Set<number>();
  const markerPattern = new RegExp(`^${escapeRegExp(markerPrefix)}(\\d+)x/`);
  const anyMarkerPattern = new RegExp(`${escapeRegExp(markerPrefix)}\\d+x/`, 'g');
  for (const token of md.parse(marked, {})) {
    if (token.type !== 'inline') continue;
    for (const child of token.children ?? []) {
      if (child.type !== 'link_open') continue;
      const href = child.attrGet('href') ?? '';
      const markerMatch = href.match(markerPattern);
      if (!markerMatch) continue;
      const id = Number(markerMatch[1]);
      const candidate = byId.get(id);
      if (!candidate) continue;
      const marker = markerMatch[0];
      candidate.value = md.normalizeLinkText(
        href.slice(marker.length).replace(anyMarkerPattern, ''),
      );
      confirmed.add(id);
    }
  }
  return candidates.filter(candidate => confirmed.has(candidate.id));
}

/**
 * Restore the leading slash when a model emits the current user's home path
 * as a relative Markdown link destination. Codex file links are normally
 * absolute (`/Users/alice/...` or `/home/alice/...`); without the slash,
 * Feishu resolves the destination as a relative URL and cannot open it.
 *
 * The repair is intentionally narrow: it only matches the current host home
 * prefix and only in destinations markdown-it recognizes as real inline links.
 * Web links, existing absolute paths, other users' homes, and general
 * relative links are left unchanged. An ambiguous home-shaped target is only
 * repaired when the absolute file exists and the same target does not exist
 * relative to the current working directory.
 */
export function normalizeLocalHomeLinks(
  input: string,
  homeDir = homedir(),
  cwd = process.cwd(),
  pathExists: (path: string) => boolean = existsSync,
  mode: LocalHomeLinkMode = 'filesystem',
): string {
  if (mode === 'disabled') return input;
  const relativeHome = homeDir.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!relativeHome || relativeHome === homeDir) return input;

  const homePrefix = new RegExp(`^${escapeRegExp(relativeHome)}(?=$|[/?#])`, 'i');
  const normalizedHome = resolve(homeDir);
  const pathExistence = new Map<string, boolean>();
  const cachedPathExists = (path: string): boolean => {
    let exists = pathExistence.get(path);
    if (exists === undefined) {
      exists = pathExists(path);
      pathExistence.set(path, exists);
    }
    return exists;
  };

  const confirmedDestinations = validateLocalHomeLinkCandidates(
    input,
    collectLocalHomeLinkCandidates(input, relativeHome),
  );
  // Filesystem mode caps synchronous probes over untrusted model output.
  // Lexical mode performs no I/O, so it can repair every confirmed link.
  const destinations = mode === 'filesystem'
    ? confirmedDestinations.slice(0, MAX_LOCAL_HOME_LINK_REPAIRS)
    : confirmedDestinations;
  const repairs: Array<{ start: number; end: number }> = [];
  for (const destination of destinations) {
    const homeMatch = destination.value.match(homePrefix);
    if (!homeMatch) continue;

    const relativeTarget = destination.value.split(/[?#]/, 1)[0];
    const absoluteTargetText = `${relativeHome}${destination.value.slice(homeMatch[0].length)}`
      .split(/[?#]/, 1)[0];
    const strippedRelativeTarget = relativeTarget.replace(/:\d+(?::\d+)?$/, '');
    const strippedAbsoluteTargetText = absoluteTargetText.replace(/:\d+(?::\d+)?$/, '');
    const targetTexts = [{ relative: relativeTarget, absolute: absoluteTargetText }];
    const hasPositionSuffix = strippedRelativeTarget !== relativeTarget &&
      strippedAbsoluteTargetText !== absoluteTargetText;
    if (hasPositionSuffix) {
      targetTexts.push({ relative: strippedRelativeTarget, absolute: strippedAbsoluteTargetText });
    }

    const targetCandidates = targetTexts.map(target => ({
      relative: resolve(cwd, target.relative),
      absolute: resolve('/', target.absolute),
    }));
    if (targetCandidates[0].absolute !== normalizedHome &&
        !targetCandidates[0].absolute.startsWith(`${normalizedHome}/`)) continue;

    // A numeric suffix can be a Codex source position. Never let removing it
    // create a second candidate outside HOME (for example `..:123`). In
    // filesystem mode the exact literal filename remains eligible; lexical
    // mode cannot distinguish it safely, so it leaves the link unchanged.
    const strippedCandidateIsSafe = targetCandidates.length === 1 ||
      targetCandidates[1].absolute === normalizedHome ||
      targetCandidates[1].absolute.startsWith(`${normalizedHome}/`);
    if (mode === 'lexical' && !strippedCandidateIsSafe) continue;

    if (mode === 'filesystem') {
      const safeCandidates = strippedCandidateIsSafe ? targetCandidates : targetCandidates.slice(0, 1);
      // Preserve the source spelling/case for cwd-relative disambiguation. On
      // a case-sensitive filesystem, `Home/alice/a` and `home/alice/a` differ.
      if (safeCandidates.some(target => cachedPathExists(target.relative))) continue;
      if (!safeCandidates.some(target => cachedPathExists(target.absolute))) continue;
    }

    const rawHome = input.slice(destination.start, destination.end);
    if (rawHome.toLowerCase() !== homeMatch[0].toLowerCase()) continue;
    repairs.push({ start: destination.start, end: destination.end });
  }

  if (repairs.length === 0) return input;
  const outputParts: string[] = [];
  let outputCursor = 0;
  for (const repair of repairs) {
    outputParts.push(input.slice(outputCursor, repair.start), `/${relativeHome}`);
    outputCursor = repair.end;
  }
  outputParts.push(input.slice(outputCursor));
  return outputParts.join('');
}

/** Default footer brand when a bot has no custom `brandLabel` configured. */
export const DEFAULT_BRAND_LABEL = '[botmux](https://github.com/deepcoldy/botmux)';

/**
 * Resolve the brand segment to render in a card footer from a bot's configured
 * `brandLabel` (see {@link resolveBrandLabel}):
 *   • `undefined` (unset)  → the default botmux link
 *   • `''` / whitespace    → `null` (brand suppressed)
 *   • any other string     → one trimmed line (markdown allowed)
 * Returning `null` lets callers drop the brand — and, when there's also no
 * recipient, the whole footer (HR included) — so an empty brand reads clean.
 */
export function brandFooterSegment(brand: string | undefined): string | null {
  if (brand === undefined) return DEFAULT_BRAND_LABEL;
  const normalized = brand
    .trim()
    .replace(/[ \t]*(?:\r\n?|\n|\u2028|\u2029)+[ \t]*/g, ' ');
  return normalized || null;
}

function compactTokenCount(value: number): string {
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ] as const;
  let unitIndex = units.findIndex(candidate => value >= candidate.threshold);
  if (unitIndex < 0) return Math.round(value).toString();
  let unit = units[unitIndex];
  let scaled = value / unit.threshold;
  // Avoid boundary artifacts such as 1000K/1000M after one-decimal rounding.
  if (unitIndex > 0 && Number(scaled.toFixed(1)) >= 1_000) {
    unit = units[--unitIndex];
    scaled = value / unit.threshold;
  }
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${unit.suffix}`;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function compactRuntimeLabel(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/[ \t]*(?:\r\n?|\n|\u2028|\u2029)+[ \t]*/g, ' ');
  if (!normalized) return undefined;
  const compact = normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
    : normalized;
  return compact
    .replace(/[*_~`\[\]\\<>]/g, char => `\\${char}`)
    .replace(/ /g, '\u00a0');
}

/** Strip a leading `provider/` routing namespace from a model id so the card
 *  shows the bare model name (e.g. `model_hub/es1_orange_o48` \u2192
 *  `es1_orange_o48`). Only a clean single-token prefix (alphanumerics, `.`, `_`,
 *  `-`) followed by one slash is removed, so a value with no slash
 *  (`gpt-5.6-sol`) or arbitrary text containing a slash is returned unchanged. */
function stripModelProviderPrefix(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/^[A-Za-z0-9._-]+\//, '');
}

/** Format usage as one segment shared by reply-card footers and the live
 * streaming card. The caller supplies native facts; this module only formats
 * them and never infers a context window or token count. Returns null when no
 * valid native metric is available.
 *
 * `variant`:
 *   - `'footer'` (default): minimal — context only. Reply-card footers are
 *     cramped (brand · usage · 发送给), so the large cumulative token string is
 *     dropped here (it lives on the streaming card / usage ledger). 上下文占用
 *     is the one glanceable "how full am I" metric worth keeping.
 *   - `'streaming'`: rich — context + `本轮 ↑X ↓Y`(per-turn delta, matches the
 *     CLI TUI) + `累计 ↑A ↓B`(session total). The live card has room and
 *     refreshes during execution. */
/**
 * True when a context snapshot is at/over the compact threshold — the single
 * source of truth for BOTH the `建议压缩` hint appended by
 * {@link cardUsageFooterSegment} and the streaming card's red line colour.
 *
 * ⚠️ Callers must NOT re-derive this by string-matching the rendered segment for
 * the hint text: the hint is user-customizable copy (an override may even be the
 * empty string, which makes `includes()` match unconditionally and paints every
 * card red), and coupling colour to copy means editing a translation silently
 * changes behaviour. Ask this predicate instead.
 *
 * No percentage (a CLI that reports usedTokens but no window — Claude Code's
 * transcript has no context-window field) or no threshold ⇒ false, so the hint
 * and the colour can never fire on a snapshot that cannot be over any limit.
 */
export function contextOverCompactThreshold(
  usage: CardUsageSnapshot,
  threshold: number | undefined,
): boolean {
  const pct = contextPercentUsed(usage);
  return pct !== undefined && isNonNegativeFinite(threshold) && pct >= threshold;
}

/** Rounded, clamped context percentage, or undefined when the CLI reports no
 *  window (⇒ no percentage to show). Shared so the footer text and
 *  {@link contextOverCompactThreshold} can never disagree on the value. */
function contextPercentUsed(usage: CardUsageSnapshot): number | undefined {
  return isNonNegativeFinite(usage.context?.percentUsed)
    ? Math.min(100, Math.round(usage.context.percentUsed))
    : undefined;
}

export function cardUsageFooterSegment(
  usage: CardUsageSnapshot,
  locale?: Locale,
  variant: 'footer' | 'streaming' = 'footer',
  opts?: { compactHintThreshold?: number },
): string | null {
  const parts: string[] = [];
  if (usage.context && isNonNegativeFinite(usage.context.usedTokens)) {
    const used = compactTokenCount(usage.context.usedTokens);
    const window = usage.context.windowTokens;
    const windowSuffix = isNonNegativeFinite(window) && window > 0
      ? `/${compactTokenCount(window)}`
      : '';
    const pct = contextPercentUsed(usage);
    const percentSuffix = pct !== undefined ? ` (${pct}%)` : '';
    const suffix = `${windowSuffix}${percentSuffix}`;
    // 「建议压缩」提示（streaming 卡片）。曾经它是**独立一行** `📊 上下文 N%`，
    // 与本 footer 同源（都读 percentUsed）⟹ 同一个百分比在一张卡上出现两次，
    // 且那一行还比这里少了绝对值。现在只在这一行的上下文段尾追加提示，不再多占一行。
    // 无百分比（Claude Code 的 transcript 没有上下文窗口字段）时天然不触发。
    const overThreshold = contextOverCompactThreshold(usage, opts?.compactHintThreshold);
    parts.push(
      `${t('card.usage.context', undefined, locale)} ${used}${suffix}`
      + (overThreshold ? ` · ${t('card.context.compact_hint', undefined, locale)}` : ''),
    );
  }
  // Footer variant is context-only (keeps the cramped reply-card footer clean);
  // the token breakdown below is streaming-only.
  if (variant !== 'streaming') {
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  // Per-turn delta (streaming only): small ↑↓ for the latest turn, labelled 本轮.
  const turn = usage.turnTokens;
  if (turn
    && isNonNegativeFinite(turn.in)
    && isNonNegativeFinite(turn.out)
    && (turn.in > 0 || turn.out > 0)) {
    parts.push(
      `${t('card.usage.turn', undefined, locale)} `
      + `↑${compactTokenCount(turn.in)} ↓${compactTokenCount(turn.out)}`,
    );
  }
  if (usage.tokens
    && isNonNegativeFinite(usage.tokens.in)
    && isNonNegativeFinite(usage.tokens.out)
    // Suppress an all-zero token line: a brand-new session (or a synthetic /
    // zero-usage transcript record read before the real turn lands) yields
    // in=out=0, which would render a meaningless "↑0 ↓0". Omit it like any
    // other missing metric until there is real usage to show.
    && (usage.tokens.in > 0 || usage.tokens.out > 0)) {
    parts.push(
      `${t('card.usage.total', undefined, locale)} `
      + `↑${compactTokenCount(usage.tokens.in)} ↓${compactTokenCount(usage.tokens.out)}`,
    );
  }
  // Runtime identity is formatted separately by cardUsageRuntimeSegment, then
  // the streaming card appends it to this metric string with ` · ` in one
  // continuous markdown paragraph. Keep this function metric-only so reply-card
  // footers remain unchanged and the streaming renderer owns the tail layout.
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Streaming-card runtime tail appended after
 * {@link cardUsageFooterSegment}'s metric text. Returns `**model** effort`
 * (model bolded within the shared grey markdown) or null when there is no model.
 * `effort` is dropped when absent — no placeholder. `hasMetrics` prevents a
 * standalone runtime-only row when native usage is unavailable. The
 * model↔effort join uses a non-breaking space so the pair never wraps apart. */
export function cardUsageRuntimeSegment(
  usage: CardUsageSnapshot,
  hasMetrics: boolean,
): string | null {
  if (!hasMetrics) return null;
  // Strip a leading `provider/` routing prefix (e.g. `model_hub/es1_orange_o48`
  // \u2192 `es1_orange_o48`) so the card shows the bare model name, not the relay's
  // internal namespace. A value with no slash (e.g. `gpt-5.6-sol`) is untouched.
  // Keep the tail compact so the continuous usage paragraph wraps predictably.
  const model = compactRuntimeLabel(stripModelProviderPrefix(usage.model), 20);
  if (!model) return null;
  const reasoningEffort = compactRuntimeLabel(usage.reasoningEffort, 10);
  return `**${model}**${reasoningEffort ? `\u00a0${reasoningEffort}` : ''}`;
}

/** Build the one canonical footer shared by all Bot Session reply cards.
 * Ordering, i18n, the parser marker, grey styling, and recipient rendering live
 * here so direct sends and daemon fallbacks cannot drift apart. */
export function buildReplyCardFooter(opts: {
  brand?: string;
  recipientOpenIds?: readonly string[];
  usage?: CardUsageSnapshot;
  locale?: Locale;
}): ReplyCardFooter | null {
  const parts: string[] = [];
  const brandSeg = brandFooterSegment(opts.brand);
  if (brandSeg) parts.push(brandSeg);
  let hasUsage = false;
  if (opts.usage) {
    const usageSeg = cardUsageFooterSegment(opts.usage, opts.locale);
    if (usageSeg) { parts.push(usageSeg); hasUsage = true; }
  }
  const recipientOpenIds = [...new Set((opts.recipientOpenIds ?? []).filter(Boolean))];
  const hasRecipient = recipientOpenIds.length > 0;
  if (hasRecipient) {
    parts.push(
      `${t('card.sent_to', undefined, opts.locale)}`
      + recipientOpenIds.map(id => `<at id=${id}></at>`).join(' '),
    );
  }
  if (parts.length === 0) return null;

  // The marker is a visible, versioned link that lets the parser identify a
  // card's footer (and strip it before a bot-to-bot relay). It doubles as the
  // first separator. But a BRAND-ONLY footer (no usage, no recipient — the
  // common case now that usageDisplay defaults to the streaming card body and
  // the reply-card footer is context-only) needs no marker: appending it renders
  // a dangling "botmux ·". The default/repository brand is plain link text with
  // no `@`, so it cannot trigger bot-to-bot pollution and does not need the
  // ownership marker (the parser already treats a bare repo link as ordinary
  // content, matching the long-standing "brand-only is undecidable, keep it"
  // contract). Any footer carrying usage or a recipient is still signed.
  const signMarker = hasUsage || hasRecipient;
  let signedContent: string;
  if (!signMarker) {
    signedContent = parts[0]; // brand-only — no marker
  } else if (parts.length > 1) {
    signedContent = `${parts[0]} ${REPLY_CARD_FOOTER_MARKER} ${parts.slice(1).join(' · ')}`;
  } else {
    // usage-only / recipient-only (brand disabled) — still marked for parsing.
    signedContent = `${parts[0]} ${REPLY_CARD_FOOTER_MARKER}`;
  }
  const content = `<font color='grey'>${signedContent}</font>`;
  return {
    content,
    element: {
      tag: 'markdown',
      element_id: REPLY_CARD_FOOTER_ELEMENT_ID,
      text_size: 'notation',
      content,
    },
  };
}

/** Clone a caller-supplied schema-2 card and append the canonical reply
 * footer. Returns null for cards without a v2 `body.elements` array or when a
 * caller-owned element already occupies the globally unique footer id. */
export function appendReplyCardFooterToV2Card(
  card: Record<string, unknown>,
  opts: Parameters<typeof buildReplyCardFooter>[0],
): Record<string, unknown> | null {
  const cloned = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
  if (cloned.schema !== '2.0') return null;
  const body = cloned.body as { elements?: unknown } | undefined;
  if (!body || !Array.isArray(body.elements)) return null;
  const header = cloned.header as {
    text_tag_list?: unknown;
    i18n_text_tag_list?: unknown;
  } | undefined;
  const i18nHeaderTagLists = header?.i18n_text_tag_list
    && typeof header.i18n_text_tag_list === 'object'
    ? Object.values(header.i18n_text_tag_list as Record<string, unknown>)
    : [];
  if (
    containsReplyCardFooterId(body.elements)
    || containsReplyCardFooterId(header?.text_tag_list)
    || containsReplyCardFooterId(i18nHeaderTagLists)
  ) {
    return null;
  }
  const footer = buildReplyCardFooter(opts);
  if (footer) body.elements.push({ tag: 'hr' }, footer.element);
  return cloned;
}

function containsReplyCardFooterId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReplyCardFooterId);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.element_id === REPLY_CARD_FOOTER_ELEMENT_ID) return true;
  // Follow only documented component-child slots. Callback `value`, behavior
  // payloads, and other arbitrary business JSON are deliberately outside the
  // card component tree even when they contain tag/element_id-shaped fields.
  return containsReplyCardFooterId(record.elements)
    || containsReplyCardFooterId(record.columns)
    || containsReplyCardFooterId(record.actions)
    || containsReplyCardFooterId(record.extra);
}

/** Build a Feishu native `table` element from a `table_open … table_close` token slice. */
function buildTableFromTokens(tokens: Token[]): any | null {
  const headerCells: string[] = [];
  const bodyRows: string[][] = [];
  let inHead = false;
  let inBody = false;
  let currentRow: string[] | null = null;
  let inCell = false;

  for (const t of tokens) {
    switch (t.type) {
      case 'thead_open': inHead = true; break;
      case 'thead_close': inHead = false; break;
      case 'tbody_open': inBody = true; break;
      case 'tbody_close': inBody = false; break;
      case 'tr_open': currentRow = []; break;
      case 'tr_close':
        if (inBody && currentRow) bodyRows.push(currentRow);
        currentRow = null;
        break;
      case 'th_open':
      case 'td_open': inCell = true; break;
      case 'th_close':
      case 'td_close': inCell = false; break;
      case 'inline':
        if (inCell) {
          if (inHead) headerCells.push(t.content);
          else if (currentRow) currentRow.push(t.content);
        }
        break;
    }
  }

  if (headerCells.length === 0) return null;

  const columns = headerCells.map((h, i) => ({
    name: `c${i}`,
    display_name: h || ' ',
    data_type: 'lark_md',
    width: 'auto',
  }));
  const rows = bodyRows.map(r => {
    const o: Record<string, string> = {};
    for (let i = 0; i < headerCells.length; i++) o[`c${i}`] = r[i] ?? '';
    return o;
  });
  return {
    tag: 'table',
    page_size: Math.min(10, Math.max(1, rows.length || 1)),
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

function sliceLines(lines: string[], map: [number, number]): string {
  return lines.slice(map[0], map[1]).join('\n');
}

/** Find index of the matching close token at the same nesting depth. */
function findMatchingClose(tokens: Token[], openIdx: number): number {
  const open = tokens[openIdx];
  const close = open.type.replace(/_open$/, '_close');
  let depth = 1;
  for (let j = openIdx + 1; j < tokens.length; j++) {
    if (tokens[j].type === open.type) depth++;
    else if (tokens[j].type === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

/**
 * Defensive unescape: when a line consists solely of 3+ backslash-escaped
 * backticks (with optional ≤3-space indent and an info string with no
 * backticks), strip the backslashes so markdown-it sees a real fence.
 *
 * This shields against a common LLM/shell bug: writing `botmux send "$(cat
 * <<'EOF' \`\`\` ... \`\`\` EOF)"` puts literal `\\\`` into the markdown
 * because the model over-escapes inside a single-quoted heredoc. markdown-it
 * then treats each `\\\`` as a CommonMark backslash-escape (literal backtick),
 * so no fence opens and the code block renders as flat text in the card.
 *
 * The regex is intentionally tight — only whole lines that are pure escaped
 * fences are touched. Inline `\\\`` and code-block bodies that mention
 * `\\\`\\\`\\\`` (e.g. a markdown tutorial) are unaffected.
 */
function unescapeFenceLines(input: string): string {
  return input.replace(/^[ ]{0,3}(?:\\`){3,}[^\n`]*$/gm, m => m.replace(/\\`/g, '`'));
}

/** Normalize source bytes that must be settled before the card is rendered. */
export function prepareCardMarkdown(
  input: string,
  cwd = process.cwd(),
  localHomeLinkMode: LocalHomeLinkMode = 'filesystem',
): string {
  input = unescapeFenceLines(input);
  return normalizeLocalHomeLinks(input, homedir(), cwd, existsSync, localHomeLinkMode);
}

export interface ExtractedReplyCardHeading {
  /** Markdown body with the selected heading source line removed. */
  markdown: string;
  /** Plain visible text for `header.title`; absent when no eligible heading exists. */
  heading?: string;
}

function inlineTokenPlainText(token: Token | undefined): string {
  if (!token) return '';
  if (!Array.isArray(token.children)) return token.content.trim();
  return token.children
    .map(child => {
      if (child.type === 'text' || child.type === 'code_inline') return child.content;
      if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
      if (child.type === 'image') return child.content;
      return '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Consume the first heading that the ordinary body renderer would promote:
 * a top-level ATX H1/H2 outside code fences. The exact source line is removed
 * so the Card 2.0 header and body do not repeat it. No other markdown changes.
 */
export function extractFirstReplyCardHeading(input: string): ExtractedReplyCardHeading {
  if (!input) return { markdown: input };
  const parseInput = unescapeFenceLines(input);
  const tokens = md.parse(parseInput, {});
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token.level !== 0
      || token.type !== 'heading_open'
      || !/^h[12]$/.test(token.tag)
      || !/^#{1,2}$/.test(token.markup)
      || !token.map
    ) {
      continue;
    }
    const heading = inlineTokenPlainText(tokens[index + 1]);
    if (!heading) continue;
    const lines = input.split('\n');
    const [start, end] = token.map as [number, number];
    lines.splice(start, Math.max(1, end - start));
    return { markdown: lines.join('\n'), heading };
  }
  return { markdown: input };
}

/**
 * Split markdown into card v2 body elements:
 *   1. Pipe tables → native `table` widget (Feishu's markdown widget can't
 *      render them as a grid).
 *   2. H1/H2 → bounded standalone heading widgets; H3-H6 → bold (Feishu's
 *      markdown widget doesn't render ATX `#`).
 *   3. Code fences → re-emitted with the original backtick run, joined with
 *      blank lines on either side (Feishu's widget needs them to recognise the
 *      fence).
 *   4. Everything else → original source slice, glued by blank lines.
 *
 * Prose between promoted headings/tables/image rows is merged into one
 * `markdown` element to keep card element counts modest.
 */
export function buildCardBodyElements(
  input: string,
  cwd = process.cwd(),
  localHomeLinkMode: LocalHomeLinkMode = 'filesystem',
): any[] {
  if (!input) return [];
  // Recover model-escaped fences first so markdown-it can classify their
  // contents as code before local-link normalization inspects link tokens.
  input = prepareCardMarkdown(input, cwd, localHomeLinkMode);
  // Pre-pass: a line that is nothing but 2+ images renders as a side-by-side
  // image row (column_set) instead of stacked full-width images. Everything
  // else flows through the markdown element builder unchanged. Fence-aware so
  // image-looking lines inside ``` code blocks are left intact.
  const elements: any[] = [];
  const layoutBudget = { promotedHeadings: 0 };
  for (const seg of splitImageRowSegments(input)) {
    if (seg.type === 'imgrow') elements.push(imageRowElement(seg.keys));
    else elements.push(...buildMarkdownElements(seg.content, layoutBudget));
  }
  return elements;
}

function buildMarkdownElements(
  input: string,
  layoutBudget: { promotedHeadings: number },
): any[] {
  if (!input) return [];
  input = unescapeFenceLines(input);
  const tokens = md.parse(input, {});
  const lines = input.split('\n');
  const elements: any[] = [];
  const buf: string[] = [];

  const flushBuf = () => {
    const text = buf.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) elements.push({ tag: 'markdown', content: text });
    buf.length = 0;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.level !== 0) { i++; continue; }

    if (t.type === 'table_open') {
      flushBuf();
      const j = findMatchingClose(tokens, i);
      const tableEl = buildTableFromTokens(tokens.slice(i, j + 1));
      if (tableEl) elements.push(tableEl);
      else if (t.map) buf.push(sliceLines(lines, t.map as [number, number]));
      i = j + 1;
      continue;
    }

    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = (inline?.content ?? '').replace(/^#{1,6}\s+/, '').trim();
      const level = Number.parseInt(t.tag.slice(1), 10);
      const promote = text
        && level <= 2
        && /^#{1,2}$/.test(t.markup)
        && layoutBudget.promotedHeadings < MAX_PROMOTED_CARD_HEADINGS;
      if (promote) {
        // Feishu's markdown widget does not render ATX markers. A standalone
        // Card JSON 2.0 20px heading restores hierarchy without making H1
        // model output dominate the card. The element id carries the original
        // ATX level because message reads strip `text_size` — without it the
        // heading would come back as bare glued text.
        flushBuf();
        layoutBudget.promotedHeadings++;
        elements.push({
          tag: 'markdown',
          element_id: replyCardHeadingElementId(
            level as 1 | 2,
            layoutBudget.promotedHeadings,
          ),
          text_size: 'heading-2',
          content: text,
        });
      } else if (text) {
        // H3-H6 and headings beyond the safety budget retain the established
        // compact fallback instead of increasing the component count further.
        buf.push(`**${text}**`);
      }
      i += 3; // heading_open, inline, heading_close
      continue;
    }

    if (t.type === 'fence' || t.type === 'code_block') {
      const fence = t.markup || '```';
      const info = (t.info || '').trim();
      const content = t.content.replace(/\n+$/, '');
      buf.push(`${fence}${info}\n${content}\n${fence}`);
      i++;
      continue;
    }

    if (t.type === 'hr') {
      buf.push('---');
      i++;
      continue;
    }

    if (t.type === 'html_block') {
      if (t.map) buf.push(sliceLines(lines, t.map as [number, number]));
      i++;
      continue;
    }

    // Generic open token (paragraph_open, bullet_list_open, ordered_list_open,
    // blockquote_open, …): slice source by the open-token's line map and skip
    // to the matching close.
    if (t.type.endsWith('_open') && t.map) {
      buf.push(sliceLines(lines, t.map as [number, number]));
      i = findMatchingClose(tokens, i) + 1;
      continue;
    }

    i++;
  }

  flushBuf();
  return elements;
}

/** A single uploaded image rendered full-width (legacy single-image look). */
function singleImgElement(imgKey: string): any {
  return { tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: '' }, mode: 'fit_horizontal', preview: true };
}

/**
 * One row of N images side by side, each scaled to fit its column (aspect ratio
 * preserved — wide menu cards keep their full content, just smaller). A
 * `column_set` with equal weighted columns is used instead of the native
 * `img_combination` widget because the latter crops images to fill square-ish
 * cells, which would lop the sides off landscape images.
 */
function imageRowElement(imgKeys: string[]): any {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: imgKeys.map(k => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [singleImgElement(k)],
    })),
  };
}

/** A markdown image token: `![alt](src)`, capturing the src (img_key). */
const IMG_TOKEN_SRC = /!\[[^\]]*\]\(([^)\s]+)\)/g;
/**
 * A whole line that is nothing but 2+ image tokens (the "image row" form).
 * At most 3 leading spaces: a 4+-space indent is a CommonMark indented code
 * block, whose contents `markdown-it` protects — the pre-pass must not yank an
 * indented `![](k1) ![](k2)` line out of one and promote it to a native row.
 */
const IMG_ROW_LINE = /^ {0,3}(?:!\[[^\]]*\]\([^)\s]+\)\s*){2,}$/;
/**
 * Feishu-uploaded image keys look like `img_v2_<id>` / `img_v3_<id>` (the
 * `<id>` is alphanumerics, `-` and `_`). Only a line whose every src is a full
 * such key is promoted to a native `img` row — a model reply may emit a
 * `![](https://…) ![](…)` URL line (or other non-key src like `img_v2foo.png`),
 * and a native `img` element with a non-key as its "img_key" makes Feishu reject
 * the whole card. Non-key lines fall through to the markdown widget unchanged
 * (same as before this feature existed).
 */
const FEISHU_IMG_KEY = /^img_v\d+_[A-Za-z0-9_-]+$/i;

type BodySegment = { type: 'text'; content: string } | { type: 'imgrow'; keys: string[] };

/**
 * Split a markdown body into segments, pulling out lines that consist solely of
 * 2+ image tokens as `imgrow` segments (→ side-by-side row). Fence-aware: lines
 * inside ``` / ~~~ code blocks are never treated as image rows.
 */
function splitImageRowSegments(input: string): BodySegment[] {
  const segs: BodySegment[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.length) { segs.push({ type: 'text', content: buf.join('\n') }); buf = []; } };
  // Track the open fence's char AND run length so a 4-backtick outer block
  // isn't closed by an inner 3-backtick fence. Per CommonMark a closing fence
  // is the same char, length ≥ the opening run, and nothing but whitespace
  // after the run (no info string).
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of input.split('\n')) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const run = fence[1];
      const ch = run[0];
      if (!fenceChar) {
        fenceChar = ch;                           // opening fence
        fenceLen = run.length;
      } else if (ch === fenceChar && run.length >= fenceLen && fence[2].trim() === '') {
        fenceChar = '';                           // valid closing fence
        fenceLen = 0;
      }
      buf.push(line);
      continue;
    }
    if (!fenceChar && IMG_ROW_LINE.test(line)) {
      const keys = Array.from(line.matchAll(IMG_TOKEN_SRC), m => m[1]);
      if (keys.every(k => FEISHU_IMG_KEY.test(k))) {
        flush();
        segs.push({ type: 'imgrow', keys });
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return segs;
}

/**
 * Build card body elements from a `botmux send` body whose images were uploaded
 * via `--images` and referenced by `![alt](img:N)` placeholders (`N` is the
 * 0-based --images index):
 *
 *   - `![](img:3)`    — single index → full-width inline image.
 *   - `![](img:0,1)`  — 2+ comma-separated indices → one row of images side by
 *                       side. Row width = group size: `img:0,1` two per row,
 *                       `img:0,1,2` three per row. Each placeholder is one row.
 *   - any image not named by a placeholder is appended full-width at the end.
 *
 * Placeholders are resolved to plain `![](img_key)` markdown (grouped ones onto
 * a single line) and handed to {@link buildCardBodyElements}, whose image-row
 * pre-pass turns multi-image lines into the actual `column_set` rows. This keeps
 * one rendering path: a caller that embeds `![](img_key)` directly and puts two
 * on a line (e.g. the menu poster) gets the same grid without using `--images`.
 */
export function buildImageCardElements(
  md: string,
  imageKeys: string[],
  cwd = process.cwd(),
  localHomeLinkMode: LocalHomeLinkMode = 'filesystem',
): any[] {
  if (imageKeys.length === 0) return md ? buildCardBodyElements(md, cwd, localHomeLinkMode) : [];

  const used = new Set<number>();
  const keyAt = (idx: number): string | null =>
    Number.isInteger(idx) && idx >= 0 && idx < imageKeys.length ? imageKeys[idx] : null;

  // Grouped placeholder `![](img:0,1[,2…])` → space-joined image tokens on one
  // line so the row pre-pass picks them up.
  let resolved = md.replace(/!\[[^\]]*\]\(img:(\d+(?:\s*,\s*\d+)+)\)/g, (full, list: string) => {
    const keys: string[] = [];
    for (const part of list.split(',')) {
      const idx = Number(part.trim());
      const key = keyAt(idx);
      if (key) { used.add(idx); keys.push(key); }
    }
    if (keys.length === 0) return full;            // all out of range → literal
    return keys.map(k => `![](${k})`).join(' ');
  });
  // Single-index placeholder `![alt](img:N)` → inline image (legacy).
  resolved = resolved.replace(/!\[([^\]]*)\]\(img:(\d+)\)/g, (full, alt: string, idxStr: string) => {
    const key = keyAt(Number(idxStr));
    if (!key) return full;
    used.add(Number(idxStr));
    return `![${alt}](${key})`;
  });

  // Trailing: images never referenced by any placeholder → single full-width,
  // each on its own line (stacked, legacy behaviour).
  const trailing = imageKeys.map((k, i) => (used.has(i) ? '' : `![](${k})`)).filter(Boolean).join('\n\n');
  if (trailing) resolved = resolved ? `${resolved}\n\n${trailing}` : trailing;

  return buildCardBodyElements(resolved, cwd, localHomeLinkMode);
}

/**
 * Heuristic: does `text` contain markdown syntax that renders badly as plain
 * text in Feishu (code fences, headings, lists, bold, inline code, links,
 * tables, blockquotes, hr)? Callers use this to decide between an interactive
 * card and a plain post.
 */
export function hasMarkdown(text: string): boolean {
  if (!text) return false;
  return (
    /```/.test(text) ||
    /^#{1,6}\s/m.test(text) ||
    /^\s{0,3}[-*+]\s+\S/m.test(text) ||
    /^\s{0,3}\d+\.\s+\S/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /(^|[^`])`[^`\n]+`([^`]|$)/.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text) ||
    /^\s*\|.+\|\s*$/m.test(text) ||
    /^>\s/m.test(text) ||
    /^(?:---|\*\*\*|___)\s*$/m.test(text)
  );
}

/**
 * Build a complete Feishu interactive card (schema 2.0) from a markdown
 * body, with the same footer chrome `botmux send` uses: HR + small grey
 * brand segment + optional `发送给：@<owner>` mention.
 *
 * `recipientOpenId` (when given) renders as `<at id=…></at>` in the
 * footer — typically the session owner. Pass `undefined` to omit the
 * addressing line (e.g. top-level broadcasts have no specific recipient).
 *
 * `brand` is the sending bot's configured `brandLabel` (see
 * {@link brandFooterSegment}): unset → default botmux link, `''` → brand
 * suppressed, else custom. When brand, usage, and recipient are all absent the
 * whole footer (HR included) is omitted.
 */
export function buildMarkdownCard(
  md: string,
  recipientOpenId?: string,
  brand?: string,
  locale?: Locale,
  workingDir?: string,
  localHomeLinkMode: LocalHomeLinkMode = 'filesystem',
  usage?: CardUsageSnapshot,
): string {
  const elements = md ? buildCardBodyElements(md, workingDir, localHomeLinkMode) : [];
  const footer = buildReplyCardFooter({
    brand,
    recipientOpenIds: recipientOpenId ? [recipientOpenId] : [],
    usage,
    locale,
  });
  // No brand, usage, or recipient → no footer at all (skip the orphan HR too).
  if (footer) {
    elements.push({ tag: 'hr' });
    elements.push(footer.element);
  }
  return JSON.stringify(createReplyCard(elements));
}

/** Build the canonical final-answer card. Streaming/progress/session cards
 * must keep using their existing builders and never call this helper. */
export function buildCanonicalFinalReplyCard(opts: {
  markdown: string;
  feedback?: { policy: FeedbackPolicy };
  recipientOpenId?: string;
  brand?: string;
  locale?: Locale;
  workingDir?: string;
  localHomeLinkMode?: LocalHomeLinkMode;
  usage?: CardUsageSnapshot;
}): string {
  const elements = opts.markdown
    ? buildCardBodyElements(opts.markdown, opts.workingDir, opts.localHomeLinkMode ?? 'filesystem')
    : [];
  if (opts.feedback) elements.push(buildFeedbackElement(opts.feedback.policy));
  const footer = buildReplyCardFooter({
    brand: opts.brand,
    recipientOpenIds: opts.recipientOpenId ? [opts.recipientOpenId] : [],
    usage: opts.usage,
    locale: opts.locale,
  });
  if (footer) elements.push({ tag: 'hr' }, footer.element);
  return JSON.stringify(createReplyCard(elements));
}

/** Prefix every line with `> ` so Feishu's markdown widget renders it as a
 *  blockquote even when the body contains blank lines. Empty lines become a
 *  bare `>` to keep the quote block contiguous. */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map(line => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Build a contextual reply card: a title strip, an optional quoted user
 * prompt, and the assistant body rendered through the same markdown-it
 * pipeline as `buildMarkdownCard`. Used by:
 *   • `/adopt` 前最后一轮 preamble — surfaces the last turn of the
 *     adopted CLI session.
 *   • Local-terminal turns synced back to Lark — when the user types
 *     directly into the adopted pane, both sides of the exchange are
 *     posted so the thread sees a complete conversation.
 *
 * Empty `userText` is rendered as a `(空)` placeholder inside the quote so
 * the visual layout stays consistent; pass `undefined` to omit the user
 * section entirely (headless variant).
 */
export function buildContextualReplyCard(opts: {
  title: string;
  userText?: string;
  assistantText: string;
  assistantLabel: string;
  recipientOpenId?: string;
  brand?: string;
  locale?: Locale;
  workingDir?: string;
  localHomeLinkMode?: LocalHomeLinkMode;
  usage?: CardUsageSnapshot;
  feedback?: { policy: FeedbackPolicy };
}): string {
  const {
    title,
    userText,
    assistantText,
    assistantLabel,
    recipientOpenId,
    brand,
    locale,
    workingDir,
    localHomeLinkMode = 'filesystem',
    usage,
  } = opts;
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    text_size: 'heading-2',
    content: title,
  });

  if (userText !== undefined) {
    const u = userText.trim();
    elements.push({
      tag: 'markdown',
      content: `**👤 ${t('card.you', undefined, locale)}**\n\n${quoteLines(u || t('common.empty_paren', undefined, locale))}`,
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `**🤖 ${assistantLabel}**`,
  });

  const bodyElements = assistantText.trim()
    ? buildCardBodyElements(assistantText, workingDir, localHomeLinkMode)
    : [{ tag: 'markdown', content: `*${t('common.empty_paren', undefined, locale)}*` }];
  for (const el of bodyElements) elements.push(el);

  if (opts.feedback) elements.push(buildFeedbackElement(opts.feedback.policy));

  const footer = buildReplyCardFooter({
    brand,
    recipientOpenIds: recipientOpenId ? [recipientOpenId] : [],
    usage,
    locale,
  });
  if (footer) {
    elements.push({ tag: 'hr' });
    elements.push(footer.element);
  }

  return JSON.stringify(createReplyCard(elements));
}
