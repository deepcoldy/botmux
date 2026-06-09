/**
 * Sessions list card (PR3 `/dashboard sessions` slice 1 + slice 2a).
 *
 * Slice 1 — read-only list + pagination + refresh.
 * Slice 2a — per-row "📂 详情" button opens a detail card; detail card has
 *           "⏏ 关闭" (with Feishu confirm dialog) + "🔙 返回" actions.
 *
 * Detail-card pattern (codex 2026-06-09 scope-cut):
 *  - List card stays read-only beyond the "📂 详情" inline button.
 *  - All action buttons live on the detail card.
 *  - Close is the ONLY action this slice. Restart/resume/locate/terminal
 *    land in slice 2b/2c — keeping per-action callbacks scoped to one
 *    detail card avoids optimistic-state + rollback design conflated with
 *    the list itself.
 *
 * Sync close (NOT optimistic state):
 *  - The close callback awaits the Route B POST inline.
 *  - On 200 → synthesize the closed-state row in-process (snapshot from
 *    the pre-POST GET overlaid with status:'closed' + any closedAt/
 *    cliResumeCommand returned by the close endpoint), then rebuild the
 *    detail card. NO toast on success — single-pass card render.
 *  - On non-200 → return ONLY a toast. We do NOT redraw the card so the
 *    user keeps their current state for retry (codex 2026-06-09).
 *
 * Identity / security:
 *  - `invokerOpenId` is the owner's `ou_*` and is the invoker-lock anchor.
 *  - sender union_id NEVER lands on `action.value` (red line).
 *  - Owner gate runs at the command entry AND on every callback.
 *  - `value.session_id` is read but NEVER trusted for identity — only used
 *    as the routing key. The owner gate is the only authority. The Route B
 *    upstream further enforces `ownerOf(sessionId)` scope.
 *
 * Response shape mirrors `/dashboard settings` slice 3: success path returns
 * ONLY `{ card }` (no toast) so Lark renders the card in a single pass
 * (toast + card would trigger a two-pass render and flash the stale list).
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type { SessionRowDto, SessionDetailDto } from '../../dashboard/session-card-model.js';
import { composeEntries, sortByStatus, paginate, composeDetail } from '../../dashboard/session-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { SessionRow } from '../../core/dashboard-rows.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const SESSIONS_ACTION_REFRESH = 'dash_sessions_refresh' as const;
export const SESSIONS_ACTION_PAGE = 'dash_sessions_page' as const;
export const SESSIONS_ACTION_DETAIL = 'dash_sessions_detail' as const;
export const SESSIONS_ACTION_CLOSE = 'dash_sessions_close' as const;
export const SESSIONS_ACTION_BACK_TO_LIST = 'dash_sessions_back_to_list' as const;

const PAGE_SIZE = 10;

/** Mapping from `StatusDot.tone` to a stable colour-emoji prefix. Pure. */
function toneIcon(tone: string): string {
  switch (tone) {
    case 'success': return '🟢';
    case 'info':    return '🔵';
    case 'warning': return '🟡';
    case 'neutral': return '⚪';
    default:        return '⚫';
  }
}

export interface BuildSessionsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** 1-based page index. Caller clamps; this just renders what's given. */
  page: number;
}

/** Build the sessions list card JSON from raw rows. Pure (composes + paginates). */
export function buildSessionsCard(
  rows: ReadonlyArray<SessionRow>,
  opts: BuildSessionsCardOpts,
  nowMs: number,
): string {
  const sorted = sortByStatus(composeEntries(rows, nowMs));
  const { items, meta } = paginate(sorted, opts.page, PAGE_SIZE);

  const activeCount = sorted.filter(e => e.status !== 'closed').length;
  const closedCount = sorted.length - activeCount;

  const elements: unknown[] = [];

  // Sub-header summary — counts + page indicator. Plain `div` markdown.
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t(
        'card.dashboard.sessions.count_summary',
        {
          active: String(activeCount),
          closed: String(closedCount),
          page: String(meta.page),
          totalPages: String(meta.totalPages),
        },
        opts.locale,
      ),
    },
  });

  elements.push({ tag: 'hr' });

  if (items.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: t('card.dashboard.sessions.empty', undefined, opts.locale),
      },
    });
  } else {
    for (const e of items) {
      // Row text element.
      elements.push(renderRow(e, opts.locale));
      // Per-row action element holding ONLY the "📂 详情" button (slice 2a).
      // Keeping each row's actions in its own `action` element (rather than
      // one shared element for the whole page) makes the visual layout
      // align with the row above and lets us pass the row's sessionId
      // through `value.session_id` as the routing key.
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.dashboard.sessions.row_detail', undefined, opts.locale) },
            type: 'default',
            value: {
              action: SESSIONS_ACTION_DETAIL,
              invoker_open_id: opts.invokerOpenId,
              session_id: e.sessionId,
            },
          },
        ],
      });
    }
  }

  elements.push({ tag: 'hr' });

  // Pagination + refresh — pagination row only if more than one page.
  const actions: unknown[] = [];
  if (meta.totalPages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.sessions.prev', undefined, opts.locale) },
      type: 'default',
      disabled: meta.page <= 1,
      value: {
        action: SESSIONS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.max(1, meta.page - 1)),
      },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.sessions.next', undefined, opts.locale) },
      type: 'default',
      disabled: meta.page >= meta.totalPages,
      value: {
        action: SESSIONS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.min(meta.totalPages, meta.page + 1)),
      },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: SESSIONS_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
    },
  });
  elements.push({ tag: 'action', actions });

  // Footer security note (matches /dashboard settings idiom).
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.sessions.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(entry: SessionRowDto, _locale: Locale): unknown {
  const icon = toneIcon(entry.dot.tone);
  // primary in bold; secondary on its own line in grey.
  // entry.primary is already truncated by composeEntries.
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(entry.primary)}**` +
        (entry.secondary ? `\n<font color="grey">${escapeLarkMd(entry.secondary)}</font>` : ''),
    },
  };
}

/** Slice-2a options for the detail card. `invokerOpenId` plumbs the lock onto every callback button. */
export interface BuildSessionsDetailCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** Override `Date.now()` for the relative-time label. Tests pass a fixed value. */
  nowMs?: number;
}

/**
 * Build the detail card (slice 2a). Status dot + bold title + sessionId
 * monospace; secondary key/value lines for cli/workingDir/chat/status/lastMessage;
 * action row with close + back.
 *
 * The close button is disabled when `detail.actions.close.enabled === false`
 * (per PR1 composeDetail: status==='closed' or 'starting'). When disabled
 * we show a small note next to the disabled button with the i18n key from
 * `reasonKey`.
 */
export function buildSessionsDetailCard(
  detail: SessionDetailDto,
  opts: BuildSessionsDetailCardOpts,
): string {
  const icon = toneIcon(detail.dot.tone);
  const elements: unknown[] = [];

  // ─── Title — status dot + bold title + sessionId monospace ─────────────
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(detail.title)}**` +
        `\n\`${escapeLarkMd(detail.sessionId)}\``,
    },
  });

  elements.push({ tag: 'hr' });

  // ─── Secondary info block ──────────────────────────────────────────────
  const infoLines: string[] = [];
  infoLines.push(
    t(
      'card.dashboard.sessions.detail.status_label',
      { status: escapeLarkMd(detail.status) },
      opts.locale,
    ),
  );
  infoLines.push(
    t(
      'card.dashboard.sessions.detail.cli_label',
      { cli: escapeLarkMd(detail.cliId) },
      opts.locale,
    ),
  );
  if (detail.workingDir) {
    infoLines.push(
      t(
        'card.dashboard.sessions.detail.workingdir_label',
        { dir: escapeLarkMd(detail.workingDir) },
        opts.locale,
      ),
    );
  }
  infoLines.push(
    t(
      'card.dashboard.sessions.detail.chat_label',
      { chat: escapeLarkMd(detail.chatId) },
      opts.locale,
    ),
  );
  const lastMessageAt = detail.raw.lastMessageAt;
  if (Number.isFinite(lastMessageAt) && lastMessageAt > 0) {
    const now = opts.nowMs ?? Date.now();
    infoLines.push(
      t(
        'card.dashboard.sessions.detail.last_message_label',
        { rel: formatRelativeForDetail(lastMessageAt, now) },
        opts.locale,
      ),
    );
  }
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: infoLines.map(l => `<font color="grey">${l}</font>`).join('\n'),
    },
  });

  elements.push({ tag: 'hr' });

  // ─── Action row — close (danger w/ confirm) + back ─────────────────────
  const closeEnabled = detail.actions.close.enabled === true;
  const closeButton: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.close', undefined, opts.locale) },
    type: 'danger',
    value: {
      action: SESSIONS_ACTION_CLOSE,
      invoker_open_id: opts.invokerOpenId,
      session_id: detail.sessionId,
    },
  };
  if (closeEnabled) {
    // Feishu V1 card schema confirm dialog. Only attach when the button is
    // actually clickable — there is no value in confirming a disabled button.
    closeButton.confirm = {
      title: { tag: 'plain_text', content: t('card.dashboard.sessions.confirm.close.title', undefined, opts.locale) },
      text: {
        tag: 'plain_text',
        content: t(
          'card.dashboard.sessions.confirm.close.text',
          { title: detail.title },
          opts.locale,
        ),
      },
    };
  } else {
    closeButton.disabled = true;
  }
  elements.push({
    tag: 'action',
    actions: [
      closeButton,
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.back', undefined, opts.locale) },
        type: 'default',
        value: {
          action: SESSIONS_ACTION_BACK_TO_LIST,
          invoker_open_id: opts.invokerOpenId,
        },
      },
    ],
  });

  // When the close button is disabled, surface the reason inline as a small
  // note so the user knows WHY they can't close (e.g. starting / already
  // closed). The reasonKey from composeDetail is one of:
  //   sessions.action.close.starting | sessions.action.close.alreadyClosed
  // which we translate to user-facing strings here.
  if (!closeEnabled) {
    const reasonKey = detail.actions.close.enabled === false
      ? mapCloseDisabledReason(detail.actions.close.reasonKey)
      : undefined;
    if (reasonKey) {
      elements.push({
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: t(reasonKey, undefined, opts.locale) },
        ],
      });
    }
  }

  // Footer security note (mirrors list card).
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.sessions.detail.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

/** Map composeDetail's reasonKey to the slice-2a i18n key surfaced next to a disabled close button. */
function mapCloseDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'sessions.action.close.starting':
      return 'card.dashboard.sessions.close.disabled.starting';
    case 'sessions.action.close.alreadyClosed':
      return 'card.dashboard.sessions.close.disabled.alreadyClosed';
    default:
      return undefined;
  }
}

function formatRelativeForDetail(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return `${day}d ago`;
}

/**
 * Sanitize user/filesystem-supplied text for inclusion in a Lark `lark_md`
 * element — particularly inside our `<font color="grey">…</font>` wrapper.
 *
 * codex slice-1 blocker #3: title comes from session.title (user-controlled
 * chat content) and workingDir comes from the filesystem. Both flow into a
 * span we wrap with `<font>`; without escaping, a payload containing
 * `</font><at id=ou_x></at>` would close our wrapper and inject a
 * @mention-looking element. We also need to handle `*_~\``-style markdown
 * controls so plain filenames don't render as bold/italic.
 *
 * Order matters: escape `&` FIRST so a later `<` → `&lt;` doesn't get
 * re-encoded as `&amp;lt;`.
 */
function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface SessionsCardHandlerDeps {
  /** Override the per-bot owner lookup. Production omits and uses `bot-registry.getOwnerOpenId`. */
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  /** Factory returning a Route B client for the given larkAppId. */
  createClient: (larkAppId: string) => DaemonClient;
  /** Override locale resolution; production uses the caller-supplied locale. */
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
}

export interface SessionsCardHandlerResult {
  /** Optional — success returns ONLY a `card` (single-pass render). Errors,
   *  permission denials still return a toast (no card to render). */
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function ackToast(textKey: string, locale: Locale): SessionsCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(textKey: string, params: Record<string, string> | undefined, locale: Locale): SessionsCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/**
 * Dispatch a `dash_sessions_*` action callback. Awaits the Route B GET
 * inline and returns the rebuilt card body in the SAME response.
 */
export async function handleSessionsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: SessionsCardHandlerDeps,
): Promise<SessionsCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ─── 1) Invoker lock — fail-closed ──────────────────────────────────
  const invokerOpenId = value.invoker_open_id;
  if (typeof invokerOpenId !== 'string' || !invokerOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (typeof operatorOpenId !== 'string' || !operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (invokerOpenId !== operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }

  // ─── 2) Per-bot owner gate ──────────────────────────────────────────
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const expectedOwner = getOwnerOpenId(larkAppId);
  if (!expectedOwner || operatorOpenId !== expectedOwner) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // Validate the action BEFORE creating the Route B client — an unknown
  // action shouldn't even open a connection (defensive, also keeps the
  // slice-1 invariant that the unknown-action path doesn't touch the
  // client).
  const validActions = new Set<string>([
    SESSIONS_ACTION_REFRESH,
    SESSIONS_ACTION_PAGE,
    SESSIONS_ACTION_DETAIL,
    SESSIONS_ACTION_CLOSE,
    SESSIONS_ACTION_BACK_TO_LIST,
  ]);
  if (!validActions.has(action)) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  const client = deps.createClient(larkAppId);
  const now = (): number => (deps.nowMs ? deps.nowMs() : Date.now());

  // ─── 3a) DETAIL — open the per-session detail card ──────────────────
  if (action === SESSIONS_ACTION_DETAIL) {
    const sessionId = value.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const r = await safeGetSessionsList(client, locale);
    if ('errorResult' in r) return r.errorResult;
    const row = r.rows.find(s => s.sessionId === sessionId);
    if (!row) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const detail = composeDetail(row, now());
    const cardJson = buildSessionsDetailCard(detail, {
      invokerOpenId: expectedOwner,
      locale,
      nowMs: now(),
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3b) CLOSE — synchronous close, in-process overlay, redraw ──────
  if (action === SESSIONS_ACTION_CLOSE) {
    const sessionId = value.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    // Pre-POST snapshot — needed both to confirm the session still exists
    // (avoid POSTing a close on something we can't identify) AND to
    // synthesize the closed-state row in-process (codex 2026-06-09 refines:
    // a refetch after close would race with closed→list propagation).
    const pre = await safeGetSessionsList(client, locale);
    if ('errorResult' in pre) return pre.errorResult;
    const before = pre.rows.find(s => s.sessionId === sessionId);
    if (!before) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }

    // codex 2026-06-10 SECURITY BLOCKER: client-side `disabled` on the
    // close button is UX only — a replayed event, an old card still open,
    // or a hand-crafted payload can still hit this callback. Server-side
    // we MUST re-run the PR1 action-availability matrix against the fresh
    // snapshot and fail-closed on `enabled === false`. This re-uses the
    // SAME composeDetail logic the builder used to decide whether to
    // disable the button in the first place — keeping the rules in one
    // place avoids drift between client paint and server enforce.
    const beforeDetail = composeDetail(before, now());
    if (beforeDetail.actions.close.enabled !== true) {
      // Reuse the SAME PR1 reasonKey → i18n key mapping the builder uses
      // for the inline disabled-button note (`mapCloseDisabledReason`) so
      // toast text matches what the user already sees on the card. NEVER
      // POST; NEVER redraw the card.
      const mappedKey = mapCloseDisabledReason(beforeDetail.actions.close.reasonKey)
        ?? 'card.dashboard.sessions.close_failed';
      return errorToast(mappedKey, undefined, locale);
    }

    // Route B owner gate is the authority on whether THIS bot's owner can
    // close THIS session; we only sanitize the routing key above.
    let resp: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      resp = await client.request({
        method: 'POST',
        path: `/__daemon/sessions/${encodeURIComponent(sessionId)}/close`,
      });
    } catch (e) {
      return errorToast('card.dashboard.sessions.close_failed', { reason: (e as Error).message }, locale);
    }
    if (resp.status !== 200) {
      const body = (resp.body ?? {}) as Record<string, unknown>;
      const reason = String(body.error ?? `http_${resp.status}`);
      // Preserve user state — do NOT redraw card on failure.
      return errorToast('card.dashboard.sessions.close_failed', { reason }, locale);
    }

    // Synthesize the closed-state row from the pre-POST snapshot. Merge
    // closedAt/cliResumeCommand from the close response if the upstream
    // ever surfaces them (defensive — current closeSession returns only
    // `{ ok, alreadyClosed }`, but the proxy may evolve).
    const body = (resp.body ?? {}) as Record<string, unknown>;
    const synthClosedAt: number | undefined =
      typeof body.closedAt === 'number' && Number.isFinite(body.closedAt)
        ? body.closedAt
        : (typeof body.closedAt === 'string' && Number.isFinite(Date.parse(body.closedAt))
            ? Date.parse(body.closedAt)
            : (before.closedAt ?? now()));
    const synth: SessionRow = {
      ...before,
      status: 'closed',
      closedAt: synthClosedAt,
    };
    const detail = composeDetail(synth, now());
    const cardJson = buildSessionsDetailCard(detail, {
      invokerOpenId: expectedOwner,
      locale,
      nowMs: now(),
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3c) BACK TO LIST — rebuild list card at page 1 ─────────────────
  if (action === SESSIONS_ACTION_BACK_TO_LIST) {
    const r = await safeGetSessionsList(client, locale);
    if ('errorResult' in r) return r.errorResult;
    const cardJson = buildSessionsCard(
      r.rows,
      { invokerOpenId: expectedOwner, locale, page: 1 },
      now(),
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3d) Slice-1 actions — REFRESH + PAGE ───────────────────────────
  // `action` is already constrained to validActions above; the only ones
  // left here are REFRESH + PAGE (the other 3 returned early).
  let page = 1;
  if (action === SESSIONS_ACTION_PAGE) {
    const parsed = Number.parseInt(value.page ?? '1', 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  }

  const r = await safeGetSessionsList(client, locale);
  if ('errorResult' in r) return r.errorResult;
  const cardJson = buildSessionsCard(
    r.rows,
    { invokerOpenId: expectedOwner, locale, page },
    now(),
  );
  return {
    // Card-only success path — see settings-card.ts docblock for why no toast.
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}

/**
 * GET `/__daemon/sessions-list` and surface non-200 / network errors as
 * caller-facing error toasts. Returns either `{ rows }` or
 * `{ errorResult }` — exactly one is set.
 *
 * codex slice-1 blocker #1: createDaemonClient.request does NOT throw on
 * 4xx/5xx — it resolves with the response. If we only catch throws we'd
 * silently render an empty list when Route B returns 500/401, masking
 * a real backend failure as "no sessions". So check `status !== 200`
 * explicitly and surface as an error toast.
 */
async function safeGetSessionsList(
  client: DaemonClient,
  locale: Locale,
): Promise<{ rows: ReadonlyArray<SessionRow> } | { errorResult: SessionsCardHandlerResult }> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
  } catch (e) {
    return { errorResult: errorToast('card.dashboard.sessions.list_failed', { reason: (e as Error).message }, locale) };
  }
  if (r.status !== 200) {
    const reason = String((r.body as Record<string, unknown> | undefined)?.error ?? `http_${r.status}`);
    return { errorResult: errorToast('card.dashboard.sessions.list_failed', { reason }, locale) };
  }
  const rows = ((r.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
  return { rows };
}
