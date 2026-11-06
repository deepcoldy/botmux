/**
 * Which keys a "CLI is stuck" card may send, per blocking page, and who may
 * press each one. Pure and shared by both sides of the IPC boundary:
 *  - the daemon builds the card buttons from it and maps a click
 *    (page type + button index) back to exactly one key — the key named in the
 *    card callback is never trusted;
 *  - the worker re-checks the requested key against the same table right
 *    before writing it, after re-classifying the live screen.
 *
 * Page types come from `classifyStuckPage` (utils/stuck-detector.ts), which
 * only recognises screens captured from real CLI builds.
 *
 * Safety model:
 *  - `initiator` keys only ever DECLINE or SKIP: they leave the page without
 *    persisting a decision (Esc on the Codex-family hook review = "continue
 *    without trusting", hooks simply do not run this session; Esc on the TRAE
 *    migration picker = "Skip for now", asked again next start). They may be
 *    pressed by the turn's initiator (while they may still talk to the bot) or
 *    by a bot operator.
 *  - `admin` keys persist a trust decision (`t` writes trusted_hash into the
 *    CLI config — the hook may then run outside the sandbox on every later
 *    start) or only navigate towards one. Bot operators (canOperate) only —
 *    exactly who could press them before this table existed.
 *  - No free text, no arbitrary keys: the card never carries an input box.
 *
 * Index order of the two hook-review browser pages is kept identical to the
 * card that predates this table (L1: t / Enter / Esc, L2: t / Esc).
 */
import type { StuckPageType } from '../utils/stuck-detector.js';

export type StuckKeyAudience = 'initiator' | 'admin';
export type StuckKey = 'Escape' | 'Enter' | 't';

export interface StuckPageOption {
  key: StuckKey;
  /** i18n key of the button label. */
  labelKey: string;
  audience: StuckKeyAudience;
}

export interface StuckPageSpec {
  /** i18n key of the one-line explanation of the page. */
  descriptionKey: string;
  options: readonly StuckPageOption[];
}

export const STUCK_PAGE_CATALOG: Readonly<Record<StuckPageType, StuckPageSpec>> = {
  'hook review startup': {
    descriptionKey: 'card.stuck.page.hook_review_startup',
    options: [
      { key: 'Escape', labelKey: 'card.stuck.key.skip_hooks', audience: 'initiator' },
    ],
  },
  'hook review level 1': {
    descriptionKey: 'card.stuck.page.hook_review_level1',
    options: [
      { key: 't', labelKey: 'card.stuck.key.trust_all', audience: 'admin' },
      { key: 'Enter', labelKey: 'card.stuck.key.review_hooks', audience: 'admin' },
      { key: 'Escape', labelKey: 'card.stuck.key.close_hooks', audience: 'initiator' },
    ],
  },
  'hook review level 2': {
    descriptionKey: 'card.stuck.page.hook_review_level2',
    options: [
      { key: 't', labelKey: 'card.stuck.key.trust_one', audience: 'admin' },
      { key: 'Escape', labelKey: 'card.stuck.key.go_back', audience: 'initiator' },
    ],
  },
  'cli migration menu': {
    descriptionKey: 'card.stuck.page.migration_menu',
    options: [
      { key: 'Escape', labelKey: 'card.stuck.key.skip_migration', audience: 'initiator' },
    ],
  },
};

export function isStuckPageType(value: unknown): value is StuckPageType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STUCK_PAGE_CATALOG, value);
}

export function stuckPageSpec(pageType: unknown): StuckPageSpec | undefined {
  return isStuckPageType(pageType) ? STUCK_PAGE_CATALOG[pageType] : undefined;
}

/** The option behind a card button. A missing, non-integer or out-of-range
 *  index resolves to nothing — never to a default option. */
export function stuckPageOptionAt(pageType: unknown, rawIndex: unknown): StuckPageOption | undefined {
  const spec = stuckPageSpec(pageType);
  if (!spec) return undefined;
  // Card callbacks carry the index as a canonical decimal string; accept
  // that (or a plain integer) only — not '02', ' 2 ', '2e0', [2] or true.
  let index: number;
  if (typeof rawIndex === 'number') index = rawIndex;
  else if (typeof rawIndex === 'string' && /^(?:0|[1-9]\d{0,3})$/.test(rawIndex)) index = Number(rawIndex);
  else return undefined;
  if (!Number.isSafeInteger(index) || index < 0 || index >= spec.options.length) return undefined;
  return spec.options[index];
}

/** Worker-side defence in depth: the exact key sequence a stuck card may write
 *  on this page — one key, listed for the page. */
export function isAllowedStuckKeySequence(pageType: unknown, keys: readonly string[]): boolean {
  const spec = stuckPageSpec(pageType);
  if (!spec || keys.length !== 1) return false;
  return spec.options.some(option => option.key === keys[0]);
}

/**
 * Who may press a stuck-card button. Bot operators may press every button;
 * the turn initiator may press `initiator` buttons only, and only while they
 * may still talk to the bot (a revoked chat grant or a block list entry is
 * re-evaluated at click time). Nobody else — in particular not other group
 * members who merely see the card.
 */
export function stuckKeyPermitted(input: {
  audience: StuckKeyAudience;
  operatorOpenId: string | undefined;
  initiatorOpenId: string | undefined;
  operatorIsAdmin: boolean;
  operatorCanTalk: boolean;
}): boolean {
  if (!input.operatorOpenId) return false;
  if (input.operatorIsAdmin) return true;
  if (input.audience !== 'initiator') return false;
  return !!input.initiatorOpenId
    && input.operatorOpenId === input.initiatorOpenId
    && input.operatorCanTalk;
}

export const STUCK_SCREEN_TAIL_MAX_LINES = 16;
export const STUCK_SCREEN_TAIL_MAX_CHARS = 1500;

/**
 * The bottom of a terminal snapshot as plain text for a card: ANSI stripped,
 * trailing blank rows dropped, runs of blank rows collapsed, right-trimmed,
 * bounded in lines and characters. Triple backticks are defused so the text
 * cannot break out of the card's code block. Empty string when nothing is
 * visible.
 */
export function stuckScreenTail(
  snapshot: string | null | undefined,
  maxLines = STUCK_SCREEN_TAIL_MAX_LINES,
  maxChars = STUCK_SCREEN_TAIL_MAX_CHARS,
): string {
  if (!snapshot) return '';
  const rows = snapshot
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(row => row.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, ''));
  let end = rows.length;
  while (end > 0 && rows[end - 1] === '') end--;
  const collapsed: string[] = [];
  for (const row of rows.slice(0, end)) {
    if (row === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(row);
  }
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  let tail = collapsed.slice(-maxLines).join('\n');
  if (tail.length > maxChars) tail = tail.slice(tail.length - maxChars);
  return tail.replace(/`{3,}/g, match => match.split('').join('​'));
}

const HIDDEN = '‹hidden›';

/** Rows of a recognised hook-review page whose value is free-form user
 *  content (the hook's command line, the config path it came from, its
 *  matcher) — masked whole: a hook command can carry a literal token in any
 *  shape. Matched as `<Label><2+ spaces><value>` like the detail page draws. */
const FREE_FORM_ROW = /^(\s*(?:Command|Source|Matcher)\s{2,})\S.*$/;
/** Any labelled row of the hook detail page. A free-form value too long for
 *  the terminal wraps onto unlabelled continuation rows; those stay masked
 *  until the next labelled row or a blank row. */
const DETAIL_ROW = /^\s*(?:Event|Matcher|Source|Command|Mode|Timeout|Trust)\s{2,}\S/;

/** Backstop for credential-shaped values anywhere else in the tail. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bBearer\s+\S+/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b([A-Za-z_]*(?:token|secret|passw(?:or)?d|api[_-]?key)[A-Za-z_]*\s*[:=]\s*)\S+/gi,
  /(\/\/[^\s/:@]+:)[^\s/@]+(?=@)/g,
];

/**
 * Mask what a stuck card must not repeat from a recognised page's tail: the
 * free-form value rows (FREE_FORM_ROW), credential-shaped values
 * (SECRET_SHAPES) and the user name in home-directory paths.
 */
export function redactStuckPageTail(tail: string): string {
  let inFreeForm = false;
  return tail
    .split('\n')
    .map(row => {
      const free = FREE_FORM_ROW.exec(row);
      if (free) {
        inFreeForm = true;
        return `${free[1]}${HIDDEN}`;
      }
      if (inFreeForm && row.trim() && !DETAIL_ROW.test(row)) {
        return `${/^\s*/.exec(row)![0]}${HIDDEN}`;
      }
      inFreeForm = false;
      let out = row.replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1~');
      for (const shape of SECRET_SHAPES) {
        out = out.replace(shape, (match, keep?: string) =>
          typeof keep === 'string' && match.startsWith(keep) ? `${keep}${HIDDEN}` : HIDDEN);
      }
      return out;
    })
    .join('\n');
}
