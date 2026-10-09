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
import StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { t, type Locale } from '../../i18n/index.js';
import type { ModelFallbackState } from '../../types.js';
import {
  REPLY_CARD_FOOTER_ELEMENT_ID,
  REPLY_CARD_FOOTER_MARKER,
  replyCardHeadingElementId,
} from './reply-card-footer-signature.js';
import { buildFeedbackElement } from './skill-feedback-card.js';
import type { FeedbackPolicy } from '../../services/feedback-policy.js';
import type { StatuslineQuota } from '../../services/statusline-snapshot.js';
import type { ReplyCardHeader } from './reply-card-style.js';
import { TABLE_AUTO_ROW_STYLE } from './table-style.js';
import {
  DEGRADED_TABLE_MAX_ROWS,
  VEGA_LITE_FENCE_LANGS,
  convertVegaLiteFence,
  degradedVegaLiteElements,
  type CardRenderDiagnostic,
  type VegaLiteConversion,
} from './vega-lite-chart.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from './turn-reply-card-size.js';
import { logger } from '../../utils/logger.js';

/** Room kept for chrome that callers attach *after* a card is built and
 * fitted — today the on-call group button (≈483B of request body), added by
 * `attachOncallGroupButton` in both `botmux send` and the daemon. Reserved
 * unconditionally; it costs nothing when no button is attached. */
export const CARD_LATE_CHROME_RESERVE_BYTES = 2_000;

export type { CardRenderDiagnostic } from './vega-lite-chart.js';

export { REPLY_CARD_FOOTER_MARKER } from './reply-card-footer-signature.js';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
// This parser only classifies images for removal. Include schemes such as
// file: that the HTML renderer rejects but Feishu may still treat as images.
const imageScanMd = new MarkdownIt({ html: false, linkify: false, breaks: false });
imageScanMd.validateLink = () => true;
const imageRuleParser = new MarkdownIt();
imageRuleParser.inline.ruler.enableOnly('image');
const parseImage = imageRuleParser.inline.ruler.getRules('')[0];
const MAX_LOCAL_HOME_LINK_REPAIRS = 256;
/** Keep structured replies readable without letting heading-heavy model output
 *  multiply schema-v2 body elements without bound. Each promoted heading can
 *  split one prose buffer into another element, so six keeps ordinary cards
 *  bounded while still covering the sections in a typical result report. */
const MAX_PROMOTED_CARD_HEADINGS = 6;
/** Feishu recommends at most five charts per card. Byte size is not budgeted
 * here: the only real limit is the 30KB card request body, which can only be
 * measured once the whole card exists (see `fitChartsToCardBudget`). */
const MAX_CARD_CHARTS = 5;

interface CardLayoutBudget {
  promotedHeadings: number;
  charts: number;
  diagnostics?: CardRenderDiagnostic[];
}

/** Every element produced for one ```vega-lite fence is tagged with the same
 * group so the post-assembly budget pass can step it down without re-parsing.
 * Stage 0 = chart, 1 = notice + 50-row table, 2 = notice + 10-row table,
 * 3 = notice only. */
interface ChartGroup {
  stage: 0 | 1 | 2 | 3;
  degraded: Extract<VegaLiteConversion, { ok: false }>;
  diagnostics?: CardRenderDiagnostic[];
}
const chartGroups = new WeakMap<object, ChartGroup>();
const STAGE_ROWS = [DEGRADED_TABLE_MAX_ROWS, DEGRADED_TABLE_MAX_ROWS, 10, 0] as const;

function tagChartGroup(elements: any[], group: ChartGroup): any[] {
  for (const element of elements) chartGroups.set(element, group);
  return elements;
}

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
  /** Session-only configuration; separate from the last executor-reported effort. */
  reasoningControl?: {
    choices: readonly import('../../services/codex-reasoning-effort.js').CodexReasoningEffort[];
    selected?: string;
    pending: boolean;
  };
  /** Frozen TraeX backend variant selected for this session. */
  modelBackendVariant?: string;
  /** Claude model fallback in effect, rendered as its own notice line on the
   *  live card. It rides this snapshot rather than a 23rd positional arg on
   *  buildStreamingCard: every call site already forwards the snapshot (locked
   *  by test/streaming-card-usage-arg.test.ts), so no call site can forget it.
   *  Not a usage metric, but the same class of runtime identity as `model`. */
  modelFallback?: ModelFallbackState;
  /** Claude Code statusline 快照（`botmux statusline` 落盘，daemon 合并）。存在时
   *  上下文段改渲染纯百分比 `ctx N%`，并追加 `5h N%` / `7d N%` 账号配额段。
   *  缺省 / null ⇒ 与无 statusline 时逐字节相同（只看 `context`）。 */
  quota?: StatuslineQuota | null;
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
export const DEFAULT_BRAND_LABEL = 'Powered by [botmux](https://github.com/deepcoldy/botmux) with :LOVE:';

/**
 * Resolve the brand segment to render in a card footer from a bot's configured
 * `brandLabel` (see {@link resolveBrandLabel}):
 *   • `undefined` (unset)  → `Powered by [botmux](...) with :LOVE:`
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
  // statusline 给的 contextPercent 优先（Claude Code 的 transcript 本身没有窗口字段，
  // 这是它唯一的百分比来源）；其余 CLI 仍走 transcript 的 percentUsed。
  const pct = usage.quota?.contextPercent ?? usage.context?.percentUsed;
  return isNonNegativeFinite(pct)
    ? Math.min(100, Math.round(pct))
    : undefined;
}

/** 配额百分比（5h / 7d）：与上下文同口径 round + clamp；非法值 ⇒ undefined（省略该段）。 */
function quotaPercent(value: unknown): number | undefined {
  return isNonNegativeFinite(value) ? Math.min(100, Math.round(value)) : undefined;
}

export function cardUsageFooterSegment(
  usage: CardUsageSnapshot,
  locale?: Locale,
  variant: 'footer' | 'streaming' = 'footer',
  opts?: { compactHintThreshold?: number },
): string | null {
  const parts: string[] = [];
  const quota = usage.quota ?? undefined;
  const quotaPct = quota ? contextPercentUsed(usage) : undefined;
  if (quota && quotaPct !== undefined) {
    // statusline 路径（Claude Code）：只渲染纯百分比 `ctx 23%`——不带绝对值（statusline
    // 的 used_percentage 与 transcript 的 usedTokens 口径不同，混排会自相矛盾）、不画
    // 进度条、不渲染 resets_at。「建议压缩」提示与下方绝对值分支同源同阈值。
    const overThreshold = contextOverCompactThreshold(usage, opts?.compactHintThreshold);
    parts.push(
      `${t('card.usage.ctx', undefined, locale)} ${quotaPct}%`
      + (overThreshold ? ` · ${t('card.context.compact_hint', undefined, locale)}` : ''),
    );
  } else if (usage.context && isNonNegativeFinite(usage.context.usedTokens)) {
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
  // 账号级配额（statusline 独有）：5h / 7d 滚动窗口用量，footer 与 streaming 都渲染——
  // 它比 Token 累计更值得占 footer 的位置（用户关心的是「还能跑多久」）。
  // 窗口已滚动的桶在读取端已被丢弃（readStatuslineSnapshot），这里只看是否有值。
  if (quota) {
    const fiveHour = quotaPercent(quota.fiveHourPercent);
    if (fiveHour !== undefined) parts.push(`${t('card.usage.quota_5h', undefined, locale)} ${fiveHour}%`);
    const sevenDay = quotaPercent(quota.sevenDayPercent);
    if (sevenDay !== undefined) parts.push(`${t('card.usage.quota_7d', undefined, locale)} ${sevenDay}%`);
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
 * {@link cardUsageFooterSegment}'s metric text. Returns `**model** variant · effort`
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
  const variant = usage.modelBackendVariant === 'standard'
    ? 'Standard'
    : usage.modelBackendVariant === 'max'
      ? 'Max'
      : '';
  const reasoningEffort = compactRuntimeLabel(usage.reasoningEffort, 10);
  const tail = [variant, reasoningEffort].filter(Boolean);
  return `**${model}**${tail.length > 0 ? `\u00a0${tail.join(' · ')}` : ''}`;
}

/** Friendly Claude model name for card copy: `claude-fable-5-1[1m]` → `Fable 5.1`,
 *  `claude-opus-5` → `Opus 5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`.
 *  Anything that is not a recognised `claude-<family>-<major>[-<minor>][-<date>]`
 *  id keeps its raw form.
 *
 *  The minor is capped at TWO digits on purpose. Date-suffixed ids without a
 *  minor (`claude-opus-4-20250514`) otherwise let the minor group swallow the
 *  date and render "Opus 4.20250514"; with the cap the regex backtracks into
 *  the date branch and the id reads as plain "Opus 4". No real Claude minor has
 *  ever been longer than two digits. */
function claudeModelLabel(id: string): string {
  const bare = id.trim().replace(/\[[^\]]*\]$/, '').trim();
  const m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/i.exec(bare);
  if (!m) return id.trim();
  const family = m[1].toLowerCase();
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Escape markdown control characters without the non-breaking-space rewrite
 *  compactRuntimeLabel applies — this notice is prose, not a compact tail. */
function escapeCardPlainText(value: string): string {
  return value.replace(/[*_~`\[\]\\<>]/g, char => `\\${char}`);
}

const MODEL_FALLBACK_LABEL_MAX = 32;
/** Tighter than the model cap: `trigger` / `apiRefusalCategory` are raw
 *  provider strings that ride in parentheses at the end of an already-full
 *  line, and unlike a model id nothing about them is worth more than a glance.
 *  Real values (`overloaded`, `model_not_found`, `cyber`) fit easily. */
const MODEL_FALLBACK_REASON_MAX = 24;

/** Bound one transcript-derived token of the notice and force it onto ONE line.
 *  Every token here comes from Claude's own record, so it can carry newlines,
 *  control characters or an arbitrarily long `/model` alias — any of which
 *  would break the single-line footnote the notice is. Real values are well
 *  under the caps (the longest Claude id, `claude-haiku-4-5-20251001`, is 25
 *  chars), so this only ever bites a pathological value. */
function compactNoticeToken(value: string, maxLength: number): string {
  const normalized = value
    // C0/C1 controls (newlines included) plus the Unicode line/paragraph
    // separators, flattened to a space before whitespace is collapsed.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 1))}\u2026`
    : normalized;
  return escapeCardPlainText(compact);
}

function fallbackModelText(id: string): string {
  return compactNoticeToken(claudeModelLabel(id), MODEL_FALLBACK_LABEL_MAX);
}

/** One-line notice for a model fallback still in effect, or null when there is
 *  none. Only the model ids and the reason are rendered — Claude's own record
 *  carries a full paragraph of prose, which would swamp a status line. */
export function cardModelFallbackNotice(
  fallback: ModelFallbackState | undefined,
  locale?: Locale,
): string | null {
  if (!fallback?.originalModel || !fallback.fallbackModel) return null;
  const rawReason = fallback.kind === 'refusal'
    ? fallback.apiRefusalCategory
    : fallback.kind === 'unavailable' ? fallback.trigger : undefined;
  // The reason is a raw provider string straight out of the transcript, so it
  // gets the same one-line + bounded + escaped treatment as the model labels;
  // a multi-line or novel-length trigger would otherwise wreck the footnote.
  const compactReason = rawReason
    ? compactNoticeToken(rawReason, MODEL_FALLBACK_REASON_MAX)
    : '';
  const reason = compactReason
    ? t('card.model_fallback.reason', { reason: compactReason }, locale)
    : t('card.model_fallback.no_reason', undefined, locale);
  return t(`card.model_fallback.${fallback.kind}`, {
    originalModel: fallbackModelText(fallback.originalModel),
    fallbackModel: fallbackModelText(fallback.fallbackModel),
    reason,
  }, locale);
}

/** Build the one canonical footer shared by all Bot Session reply cards.
 * Ordering, i18n, the parser marker, grey styling, and recipient rendering live
 * here so direct sends and daemon fallbacks cannot drift apart. */
export function buildReplyCardFooter(opts: {
  brand?: string;
  recipientOpenIds?: readonly string[];
  usage?: CardUsageSnapshot;
  executionDurationMs?: number;
  waitingDurationMs?: number;
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
  const durationMs = opts.executionDurationMs;
  const hasDuration = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0;
  const waitingMs = opts.waitingDurationMs;
  const hasWaiting = typeof waitingMs === 'number' && Number.isFinite(waitingMs) && waitingMs >= 0;
  if (hasWaiting) {
    parts.push(t('card.waiting_duration', { seconds: (waitingMs / 1000).toFixed(1) }, opts.locale));
  }
  if (hasDuration) {
    parts.push(t('card.execution_duration', { seconds: (durationMs / 1000).toFixed(1) }, opts.locale));
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

  // The marker lets the parser identify a card's footer (and strip it before a
  // bot-to-bot relay). Keep it as invisible text beside the first ordinary
  // separator: a Markdown-link marker makes Lark render the separator dot as a
  // clickable Botmux website link. But a BRAND-ONLY footer (no usage or
  // recipient — the common case now that usageDisplay defaults to the streaming
  // card body and the reply-card footer is context-only) needs no marker:
  // appending it renders a dangling "botmux ·". The default/repository brand is
  // plain link text with no mention, so it cannot trigger bot-to-bot pollution
  // and does not need the ownership marker (the parser already treats a bare
  // repo link as ordinary content, matching the long-standing "brand-only is
  // undecidable, keep it" contract). Any footer carrying usage, timing, or a recipient
  // is still signed.
  const signMarker = hasUsage || hasDuration || hasWaiting || hasRecipient;
  let signedContent: string;
  if (!signMarker) {
    signedContent = parts[0]; // brand-only — no marker
  } else if (parts.length > 1) {
    signedContent = `${parts[0]} ·${REPLY_CARD_FOOTER_MARKER} ${parts.slice(1).join(' · ')}`;
  } else {
    // usage-only / recipient-only (brand disabled) — still marked for parsing.
    signedContent = `${parts[0]}${REPLY_CARD_FOOTER_MARKER}`;
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
    ...TABLE_AUTO_ROW_STYLE,
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

/** Source markers let CommonMark identify actual image references without
 * rewriting code examples, escaped syntax, or the surrounding Markdown. */
function cardImageReferences(input: string): Array<{ position: number; source: string }> {
  if (!input.includes('![')) return [];
  const prefix = chooseLinkMarkerPrefix(input);
  const positions: number[] = [];
  const marked = input.replace(/\\.|!\[/gs, (match: string, offset: number) => {
    if (match !== '![') return match;
    const id = positions.push(offset) - 1;
    return `${prefix}${id}x![`;
  });
  const marker = new RegExp(`${escapeRegExp(prefix)}(\\d+)x$`);
  const images: Array<{ position: number; source: string }> = [];
  const inspect = (tokens: Token[]): void => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'image') {
        const match = tokens[i - 1]?.content.match(marker);
        if (match) images.push({ position: positions[Number(match[1])], source: token.attrGet('src') ?? '' });
      }
      if (token.children) inspect(token.children);
    }
  };
  inspect(imageScanMd.parse(marked, {}));
  return images.sort((a, b) => a.position - b.position);
}

/** Resolve real Markdown images, preserving code examples and untouched source.
 * The image-only rule supplies exact source spans; the full parser above
 * decides which occurrences are actually images rather than literal code. */
export async function resolveCardMarkdownImages(
  input: string,
  resolveSource: (source: string) => Promise<string | undefined>,
): Promise<string> {
  input = unescapeFenceLines(input);
  const references = cardImageReferences(input);
  if (!references.length) return input;
  const env: Record<string, unknown> = {};
  imageScanMd.parse(input, env);
  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.position < cursor || FEISHU_IMG_KEY.test(reference.source)) continue;
    const state = new StateInline(input, imageScanMd, env, []);
    state.pos = reference.position;
    if (!parseImage(state, false)) continue;
    const token = state.tokens.at(-1);
    if (token?.type !== 'image' || token.attrGet('src') !== reference.source) continue;
    const key = await resolveSource(reference.source);
    if (!key || !FEISHU_IMG_KEY.test(key)) continue;
    parts.push(input.slice(cursor, reference.position), `![${token.content}](${key})`);
    cursor = state.pos;
  }
  return parts.join('') + input.slice(cursor);
}

function normalizeCardImages(input: string, omitAll = false): string {
  const unsupported = new Set(cardImageReferences(input)
    .filter(image => omitAll || !FEISHU_IMG_KEY.test(image.source)).map(image => image.position));
  return input.replace(/!\[/g, (match: string, offset: number) =>
    unsupported.has(offset) ? '[Image omitted] [' : match);
}

/** Last-resort image-free version of a rejected reply card. Keep the card
 * envelope, text, tables, code and controls so existing delivery accounting
 * can continue to use the same message type and provider UUID. */
export function omitReplyCardImages(cardJson: string): string {
  let card: unknown;
  try { card = JSON.parse(cardJson); } catch { return cardJson; }
  let changed = false;
  const visit = (value: unknown, markdownFields?: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map(child => visit(child, markdownFields));
    if (!value || typeof value !== 'object') return value;
    if ('tag' in value && value.tag === 'img') {
      changed = true;
      const alt = 'alt' in value ? value.alt : undefined;
      const text = typeof alt === 'string' ? alt
        : alt && typeof alt === 'object' && 'content' in alt && typeof alt.content === 'string'
          ? alt.content : '';
      return { tag: 'markdown', content: `[Image omitted] ${md.utils.escapeHtml(text).replace(/[\\`*_[\]<>!]/g, '\\$&')}`.trim() };
    }
    const tableFields = 'tag' in value && value.tag === 'table' && 'columns' in value && Array.isArray(value.columns)
      ? new Set<string>(value.columns.flatMap((column: unknown) =>
        column && typeof column === 'object' && 'data_type' in column && column.data_type === 'lark_md'
          && 'name' in column && typeof column.name === 'string' ? [column.name] : []))
      : undefined;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (typeof child === 'string' && (markdownFields?.has(key)
        || ('tag' in value && (value.tag === 'markdown' || value.tag === 'lark_md') && key === 'content'))) {
        const content = normalizeCardImages(child, true);
        if (content !== child) changed = true;
        return [key, content];
      }
      return [key, visit(child, key === 'rows' ? tableFields : undefined)];
    }));
  };
  const result = visit(card);
  return changed ? JSON.stringify(result) : cardJson;
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
  imageMode = 'fit_horizontal',
  diagnostics?: CardRenderDiagnostic[],
): any[] {
  if (!input) return [];
  // Recover model-escaped fences first so markdown-it can classify their
  // contents as code before local-link normalization inspects link tokens.
  input = prepareCardMarkdown(input, cwd, localHomeLinkMode);
  // Only sanitize at the rendering boundary: sandbox relay preparation runs
  // before --images uploads resolve img:N placeholders to real image keys.
  input = normalizeCardImages(input);
  // Pre-pass: a line that is nothing but 2+ images renders as a side-by-side
  // image row (column_set) instead of stacked full-width images. Everything
  // else flows through the markdown element builder unchanged. Fence-aware so
  // image-looking lines inside ``` code blocks are left intact.
  const elements: any[] = [];
  const layoutBudget: CardLayoutBudget = { promotedHeadings: 0, charts: 0, diagnostics };
  for (const seg of splitImageRowSegments(input, imageMode)) {
    if (seg.type === 'imgrow') elements.push(imageRowElement(seg.keys));
    else if (seg.type === 'img') elements.push(singleImageLayout(seg.key, imageMode, seg.alt));
    else elements.push(...buildMarkdownElements(seg.content, layoutBudget));
  }
  return elements;
}

function buildMarkdownElements(
  input: string,
  layoutBudget: CardLayoutBudget,
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

    if (t.type === 'fence' && VEGA_LITE_FENCE_LANGS.has((t.info || '').trim().split(/\s+/)[0]!.toLowerCase())) {
      // A chart fence becomes a native Card 2.0 chart, or a notice plus a
      // plain-text data table — never the raw spec (see vega-lite-chart.ts).
      flushBuf();
      elements.push(...buildVegaLiteElements(t.content, layoutBudget));
      i++;
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

function buildVegaLiteElements(source: string, layoutBudget: CardLayoutBudget): any[] {
  let result = convertVegaLiteFence(source);
  if (result.ok) {
    const rows = (result.element.chart_spec as { data: { values: Record<string, string | number | boolean | null>[] } }).data.values;
    const fallback = { ok: false as const, reason: 'card_budget_exceeded', ...(result.title ? { title: result.title } : {}), rows };
    if (layoutBudget.charts < MAX_CARD_CHARTS) {
      layoutBudget.charts++;
      return tagChartGroup([result.element], { stage: 0, degraded: fallback, diagnostics: layoutBudget.diagnostics });
    }
    // Over the per-card chart count: keep the data as a table.
    result = { ...fallback, reason: 'too_many_charts' };
  }
  layoutBudget.diagnostics?.push({
    kind: 'chart_degraded',
    reason: result.reason,
    ...(result.title ? { title: result.title } : {}),
  });
  const group: ChartGroup = { stage: 1, degraded: result };
  return tagChartGroup(degradedVegaLiteElements(result), group);
}

/** Placeholder `receive_id` for sizing when the target chat is not known;
 * real chat ids have the same length. */
const SIZING_CHAT_ID = `oc_${'0'.repeat(32)}`;

export interface CardBudgetResult {
  /** Request body bytes after fitting, measured like the Feishu API call. */
  bytes: number;
  /** False when the card is still over budget after every chart group has
   * been stepped down (i.e. the excess is not chart content). */
  fits: boolean;
}

/**
 * Step chart groups down (chart → 50-row table → 10-row table → notice) until
 * the card's request body fits Feishu's 30KB card limit. Measures the real
 * request (`turnReplyCardRequestBytes`: callback markers, envelope and the
 * second JSON serialization of `content`), not the bare card JSON. Only
 * elements produced for ```vega-lite fences are touched; the card is edited in
 * place. `reserveBytes` leaves room for chrome added after this call.
 */
export function fitChartsToCardBudget(
  card: { body?: { elements?: any[] } },
  opts: { chatId?: string; reserveBytes?: number; diagnostics?: CardRenderDiagnostic[] } = {},
): CardBudgetResult {
  const elements = card.body?.elements;
  const limit = TURN_REPLY_CARD_MAX_BYTES - (opts.reserveBytes ?? 0);
  const measure = () => turnReplyCardRequestBytes(JSON.stringify(card), opts.chatId ?? SIZING_CHAT_ID);
  let bytes = measure();
  if (!elements || bytes <= limit) return { bytes, fits: bytes <= limit };
  for (;;) {
    // Collect contiguous runs belonging to one group that can still shrink.
    const runs: Array<{ group: ChartGroup; start: number; end: number; size: number }> = [];
    for (let index = 0; index < elements.length; index++) {
      const group = chartGroups.get(elements[index]);
      if (!group || group.stage >= 3) continue;
      let end = index;
      while (end + 1 < elements.length && chartGroups.get(elements[end + 1]) === group) end++;
      runs.push({ group, start: index, end, size: Buffer.byteLength(JSON.stringify(elements.slice(index, end + 1)), 'utf8') });
      index = end;
    }
    if (runs.length === 0) return { bytes, fits: false };
    const largest = runs.reduce((best, run) => (run.size > best.size ? run : best));
    const { group } = largest;
    if (group.stage === 0) {
      const sink = opts.diagnostics ?? group.diagnostics;
      sink?.push({
        kind: 'chart_degraded',
        reason: 'card_budget_exceeded',
        ...(group.degraded.title ? { title: group.degraded.title } : {}),
      });
      group.degraded = { ...group.degraded, reason: 'card_budget_exceeded' };
    }
    group.stage = (group.stage + 1) as ChartGroup['stage'];
    const replacement = tagChartGroup(degradedVegaLiteElements(group.degraded, STAGE_ROWS[group.stage]), group);
    elements.splice(largest.start, largest.end - largest.start + 1, ...replacement);
    bytes = measure();
    if (bytes <= limit) return { bytes, fits: true };
  }
}

/** Budget pass for cards built inside this module and delivered by the
 * daemon. Reserves room for late chrome (on-call button) and makes chart
 * degradation or an unfixable overflow observable in the daemon log. */
function fitBuiltCard(card: { body?: { elements?: any[] } }, label: string): void {
  const diagnostics: CardRenderDiagnostic[] = [];
  const result = fitChartsToCardBudget(card, { reserveBytes: CARD_LATE_CHROME_RESERVE_BYTES, diagnostics });
  if (!result.fits) {
    logger.warn(`[card] ${label}: request body ~${result.bytes}B still exceeds Feishu's 30KB card limit after chart degradation`);
  }
  if (diagnostics.length > 0) {
    logger.warn(`[card] ${label}: degraded charts: ${diagnostics.map(item => item.reason).join(', ')}`);
  }
}

// Existing multi-image rows retain their legacy payload for compatibility.
function singleImgElement(imgKey: string): any {
  return { tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: '' }, mode: 'fit_horizontal', preview: true };
}

/** Botmux width presets, not Feishu's square/cropping `size` presets. */
function singleImageLayout(imgKey: string, mode: string, alt: string): any {
  const img = {
    tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: alt },
    scale_type: 'fit_horizontal', preview: true,
  };
  const columnCounts: Record<string, number> = { medium: 2, small: 3, tiny: 4 };
  const count = columnCounts[mode];
  if (!count) return img;
  // Feishu normalizes unequal weights to 1. Use N equal columns instead:
  // one image and N-1 empty columns. `none` preserves the fraction on narrow
  // screens; fit_horizontal keeps the entire image without a fixed height.
  return {
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: '0px',
    columns: Array.from({ length: count }, (_, index) => ({
      tag: 'column', width: 'weighted', weight: 1,
      elements: index === 0 ? [img] : [],
    })),
  };
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
 * the whole card. Non-key images are downgraded before this layout pass.
 */
const FEISHU_IMG_KEY = /^img_v\d+_[A-Za-z0-9_-]+$/i;

type BodySegment = { type: 'text'; content: string } | { type: 'imgrow'; keys: string[] } | { type: 'img'; key: string; alt: string };

/**
 * Split a markdown body into segments, pulling out lines that consist solely of
 * 2+ image tokens as `imgrow` segments (→ side-by-side row). Fence-aware: lines
 * inside ``` / ~~~ code blocks are never treated as image rows.
 */
function splitImageRowSegments(input: string, imageMode = 'fit_horizontal'): BodySegment[] {
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
    // Only promote standalone images for an explicit size override. Keep the
    // legacy Markdown output, inline prose, code blocks, and image grids intact.
    if (!fenceChar && imageMode !== 'fit_horizontal') {
      const single = line.match(/^ {0,3}!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
      if (single && FEISHU_IMG_KEY.test(single[2])) {
        flush();
        segs.push({ type: 'img', key: single[2], alt: single[1] });
        continue;
      }
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
 * `imageMode` overrides standalone single images only; inline Markdown images
 * and side-by-side rows retain their existing layout.
 */
export function buildImageCardElements(
  md: string,
  imageKeys: string[],
  cwd = process.cwd(),
  localHomeLinkMode: LocalHomeLinkMode = 'filesystem',
  imageMode?: string,
  diagnostics?: CardRenderDiagnostic[],
): any[] {
  if (imageKeys.length === 0) return md ? buildCardBodyElements(md, cwd, localHomeLinkMode, imageMode, diagnostics) : [];

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

  return buildCardBodyElements(resolved, cwd, localHomeLinkMode, imageMode, diagnostics);
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
 * {@link brandFooterSegment}): unset → default `Powered by [botmux](...) with :LOVE:`, `''` → brand
 * suppressed, else custom. When brand, usage, and recipient are all absent the
 * whole footer (HR included) is omitted.
 */
// No production send path calls buildMarkdownCard today (tests only); the
// budget pass is kept so a future caller cannot reopen the 30KB gap.
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
  const card = createReplyCard(elements);
  fitBuiltCard(card, 'markdown_card');
  return JSON.stringify(card);
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
  executionDurationMs?: number;
  waitingDurationMs?: number;
}): string {
  const elements = opts.markdown
    ? buildCardBodyElements(opts.markdown, opts.workingDir, opts.localHomeLinkMode ?? 'filesystem')
    : [];
  if (opts.feedback) elements.push(buildFeedbackElement(opts.feedback.policy));
  const footer = buildReplyCardFooter({
    brand: opts.brand,
    recipientOpenIds: opts.recipientOpenId ? [opts.recipientOpenId] : [],
    usage: opts.usage,
    executionDurationMs: opts.executionDurationMs,
    waitingDurationMs: opts.waitingDurationMs,
    locale: opts.locale,
  });
  if (footer) elements.push({ tag: 'hr' }, footer.element);
  const card = createReplyCard(elements);
  fitBuiltCard(card, 'final_reply');
  return JSON.stringify(card);
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
  executionDurationMs?: number;
  waitingDurationMs?: number;
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
      content: normalizeCardImages(`**👤 ${t('card.you', undefined, locale)}**\n\n${quoteLines(u || t('common.empty_paren', undefined, locale))}`),
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
    executionDurationMs: opts.executionDurationMs,
    waitingDurationMs: opts.waitingDurationMs,
  });
  if (footer) {
    elements.push({ tag: 'hr' });
    elements.push(footer.element);
  }

  const card = createReplyCard(elements);
  fitBuiltCard(card, 'contextual_reply');
  return JSON.stringify(card);
}
