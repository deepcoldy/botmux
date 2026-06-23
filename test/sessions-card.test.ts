/**
 * PR3 `/dashboard sessions` slice 1 — card builder + callback handler tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SessionRow } from '../src/core/dashboard-rows.js';
import { composeDetail } from '../src/dashboard/session-card-model.js';
import { globalConfigPath } from '../src/global-config.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildSessionsCard,
  buildSessionsDetailCard,
  handleSessionsCardAction,
  SESSIONS_ACTION_BACK_TO_LIST,
  SESSIONS_ACTION_CLOSE,
  SESSIONS_ACTION_DETAIL,
  SESSIONS_ACTION_LOCATE,
  SESSIONS_ACTION_PAGE,
  SESSIONS_ACTION_REFRESH,
  SESSIONS_ACTION_RESUME,
} from '../src/im/lark/sessions-card.js';

const INVOKER = 'ou_owner';
const LARK_APP_ID = 'cli_test';

// The terminal button's URL wrapping depends on the global dashboard setting
// `openTerminalInFeishu` (read via readGlobalConfig at card-build time): default
// → direct URL, opt-in → Feishu sidebar applink wrapper. Isolate HOME to an
// empty temp dir so these tests deterministically see the DEFAULT (no
// config.json → direct URL), independent of whatever the test runner's real
// ~/.botmux/config.json holds. readGlobalConfig's read cache is keyed on the
// resolved config path, so stubbing HOME forces a fresh read of the empty dir.
let sessionsCardTestHome: string;
beforeEach(() => {
  sessionsCardTestHome = mkdtempSync(join(tmpdir(), 'botmux-sessions-card-'));
  vi.stubEnv('HOME', sessionsCardTestHome);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sessionsCardTestHome, { recursive: true, force: true });
});

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'sess_default',
    rootMessageId: 'om_root',
    chatId: 'oc_chat',
    chatType: 'group',
    title: 'default session',
    cliId: 'claude-code',
    workingDir: '~/work',
    status: 'idle',
    lastMessageAt: 1_000_000,
    cliVersion: 'unknown',
    webPort: 7891,
    scope: 'thread',
    spawnedAt: 0,
    larkAppId: LARK_APP_ID,
    isOncall: false,
    hasHistory: true,
    ...over,
  } as SessionRow;
}

describe('buildSessionsCard', () => {
  const NOW = 2_000_000;
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, page: 1 };

  it('empty list → renders the empty state, no action row for the empty list, no pagination', () => {
    const json = buildSessionsCard([], baseOpts, NOW);
    expect(json).toContain('Dashboard 会话');
    expect(json).toContain('_当前没有会话_');
    // No prev/next buttons when list is empty (totalPages === 1).
    expect(json).not.toContain('← 上');
    expect(json).not.toContain('下 →');
    // Refresh button is always present.
    expect(json).toContain(SESSIONS_ACTION_REFRESH);
  });

  it('sorts by status — working before idle before closed', () => {
    const rows: SessionRow[] = [
      row({ sessionId: 'sess_closed', status: 'closed', title: 'closed-one', lastMessageAt: 1_500_000 }),
      row({ sessionId: 'sess_idle', status: 'idle', title: 'idle-one', lastMessageAt: 1_900_000 }),
      row({ sessionId: 'sess_work', status: 'working', title: 'work-one', lastMessageAt: 1_200_000 }),
    ];
    const json = buildSessionsCard(rows, baseOpts, NOW);
    // Working should appear before idle in the rendered string.
    const workIdx = json.indexOf('work-one');
    const idleIdx = json.indexOf('idle-one');
    const closedIdx = json.indexOf('closed-one');
    expect(workIdx).toBeGreaterThan(0);
    expect(idleIdx).toBeGreaterThan(0);
    expect(closedIdx).toBeGreaterThan(0);
    expect(workIdx).toBeLessThan(idleIdx);
    expect(idleIdx).toBeLessThan(closedIdx);
  });

  it('shows active / closed counts in the summary line', () => {
    const rows: SessionRow[] = [
      row({ sessionId: 'a', status: 'working' }),
      row({ sessionId: 'b', status: 'idle' }),
      row({ sessionId: 'c', status: 'closed' }),
      row({ sessionId: 'd', status: 'closed' }),
    ];
    const json = buildSessionsCard(rows, baseOpts, NOW);
    expect(json).toContain('活跃 2');
    expect(json).toContain('已关闭 2');
  });

  it('renders pagination buttons when > 5 rows; page=2 emits prev=1 / next=3', () => {
    // Default PAGE_SIZE=5 (unified with overview drilldown 2026-06-10).
    // 25 rows / 5 per page = 5 pages.
    const rows: SessionRow[] = Array.from({ length: 25 }, (_, i) =>
      row({ sessionId: `sess_${i}`, title: `title-${i}`, status: 'idle' }),
    );
    const json = buildSessionsCard(rows, { ...baseOpts, page: 2 }, NOW);
    expect(json).toContain('← 上');
    expect(json).toContain('下 →');
    expect(json).toContain('第 2/5 页');
    // prev → page=1, next → page=3
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');
  });

  it('on first page prev is disabled; on last page next is disabled', () => {
    // 8 rows / PAGE_SIZE=5 = 2 pages → easy boundary test.
    const rows: SessionRow[] = Array.from({ length: 8 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const findPagerButtons = (json: string): { prev: any; next: any } => {
      const parsed = JSON.parse(json);
      // Slice 2a introduced per-row `📂 详情` action elements before the
      // pagination row, so we can't grab the first action; flatten across
      // all action elements and pick by button label instead.
      const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
      const allActions = actionRows.flatMap((r: any) => (r.actions as any[]) ?? []);
      const prev = allActions.find((a: any) => String(a.text?.content ?? '').includes('← 上'));
      const next = allActions.find((a: any) => String(a.text?.content ?? '').includes('下 →'));
      return { prev, next };
    };
    const page1 = buildSessionsCard(rows, { ...baseOpts, page: 1 }, NOW);
    const { prev: p1prev, next: p1next } = findPagerButtons(page1);
    expect(p1prev.disabled).toBe(true);
    expect(p1next.disabled).toBe(false);

    const page2 = buildSessionsCard(rows, { ...baseOpts, page: 2 }, NOW);
    const { prev: p2prev, next: p2next } = findPagerButtons(page2);
    expect(p2prev.disabled).toBe(false);
    expect(p2next.disabled).toBe(true);
  });

  it('NEVER leaks `union_id` or `senderUnionId` in the rendered JSON', () => {
    const rows: SessionRow[] = [row({ sessionId: 'a', status: 'working' })];
    const json = buildSessionsCard(rows, baseOpts, NOW);
    expect(json).not.toContain('"union_id"');
    expect(json).not.toContain('"senderUnionId"');
  });

  // codex slice-1 blocker #3: title/workingDir are user/filesystem-controlled
  // and flow into a `<font color="grey">…</font>` wrapper. Without HTML escape,
  // a payload like `</font><at ...></at>` would close our wrapper and inject
  // a @mention-shaped element. Test with codex's two sample payloads.
  it('escapes HTML control chars in title / workingDir — no naked <at or stray </font> in row content', () => {
    const rows: SessionRow[] = [
      row({
        sessionId: 's_inject_title',
        status: 'idle',
        title: '<at id=ou_x></at> evil title',
        workingDir: '~/normal',
      }),
      row({
        sessionId: 's_inject_dir',
        status: 'idle',
        title: 'normal title',
        workingDir: '</font><at id=ou_y></at>',
      }),
    ];
    const json = buildSessionsCard(rows, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const rowDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
        && /(evil title|normal title)/.test(e.text.content as string),
    );
    expect(rowDivs.length).toBe(2);
    for (const d of rowDivs) {
      const content = d.text.content as string;
      // No naked `<at` allowed anywhere
      expect(content).not.toMatch(/<at\b/);
      // No stray `</font>` other than our own intentional closing tag.
      // Our renderer emits exactly ONE outer `<font color="grey">…</font>`,
      // so closing tag count should be exactly 1.
      const closingFontCount = (content.match(/<\/font>/g) ?? []).length;
      expect(closingFontCount).toBe(1);
      // The escaped form should be visible in the output.
      expect(content).toContain('&lt;');
    }
    // The intentional outer wrapper is still there (JSON-encoded, so the
    // attribute quote becomes \").
    expect(json).toContain('<font color=\\"grey\\">');
  });

  it('escape order — `&` is escaped first so `<` does NOT become `&amp;lt;`', () => {
    const rows: SessionRow[] = [
      row({ sessionId: 'amp', status: 'idle', title: 'A & B', workingDir: '~/x<y>' }),
    ];
    const json = buildSessionsCard(rows, baseOpts, NOW);
    expect(json).toContain('A &amp; B');
    expect(json).not.toContain('&amp;lt;');
    expect(json).not.toContain('&amp;amp;');
  });

  it('every action button carries `invoker_open_id` bound to the OWNER', () => {
    const rows: SessionRow[] = Array.from({ length: 15 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const json = buildSessionsCard(rows, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const elements = parsed.elements as any[];
    // Slice 2a injects per-row detail action elements before the pagination
    // action row. Walk EVERY action element + button to assert the lock.
    const actionRows = elements.filter((e: any) => e.tag === 'action');
    expect(actionRows.length).toBeGreaterThanOrEqual(2); // at least 1 row detail + 1 pager
    for (const ar of actionRows) {
      for (const btn of ar.actions) {
        expect(btn.value?.invoker_open_id).toBe(INVOKER);
      }
    }
  });

  // ─── Slice 2a per-row detail button ─────────────────────────────────
  it('every list row carries an inline `📂 详情` button whose value.session_id matches that row', () => {
    const rows: SessionRow[] = [
      row({ sessionId: 'sess_a', status: 'working', title: 'a' }),
      row({ sessionId: 'sess_b', status: 'idle', title: 'b' }),
      row({ sessionId: 'sess_c', status: 'closed', title: 'c' }),
    ];
    const json = buildSessionsCard(rows, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    // Every per-row action element has exactly one button with action=DETAIL.
    const detailButtons = actionRows
      .flatMap((ar: any) => ar.actions ?? [])
      .filter((b: any) => b.value?.action === SESSIONS_ACTION_DETAIL);
    // Exactly one detail button per row.
    expect(detailButtons.length).toBe(rows.length);
    const seenIds = new Set(detailButtons.map((b: any) => b.value.session_id));
    // Both ids must show up (sorted order — working/idle/closed).
    expect(seenIds.has('sess_a')).toBe(true);
    expect(seenIds.has('sess_b')).toBe(true);
    expect(seenIds.has('sess_c')).toBe(true);
    // Every detail button text matches the i18n label.
    for (const b of detailButtons) {
      expect(String(b.text?.content ?? '')).toContain('📂');
    }
  });

  /** ─── Overview drilldown (2026-06-10) ───
   *  Standalone and drilldown both use the unified default 5/page; `origin`
   *  is the only thing the drilldown sub-card carries — it controls the
   *  「↩ 总览」 button and is threaded through every callback so the
   *  back affordance persists across page/refresh/detail/detail-back/
   *  toggle round-trips. */
  describe('overview drilldown', () => {
    const NOW = 2_000_000;
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ sessionId: `sess_${i}`, title: `s${i}`, status: 'idle', lastMessageAt: 1_000_000 - i * 1000 }),
    );

    it('default PAGE_SIZE → 5 rows/page (standalone and drilldown both 5 after 2026-06-10 unification)', () => {
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1 }, NOW);
      const parsed = JSON.parse(json);
      const detailButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((a: any) => a.value?.action === SESSIONS_ACTION_DETAIL);
      expect(detailButtons.length).toBe(5);
    });

    it('explicit pageSize override still works (caller can pick a different size)', () => {
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3 }, NOW);
      const parsed = JSON.parse(json);
      const detailButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((a: any) => a.value?.action === SESSIONS_ACTION_DETAIL);
      expect(detailButtons.length).toBe(3);
    });

    it('oversized pageSize is clamped before button values are written', () => {
      const rows150 = Array.from({ length: 150 }, (_, i) =>
        row({ sessionId: `sess_big_${i}`, title: `big-${i}`, status: 'idle' }),
      );
      const json = buildSessionsCard(rows150, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 999 }, NOW);
      const parsed = JSON.parse(json);
      expect(JSON.stringify(parsed)).toContain('第 1/2 页');
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      for (const b of allButtons) {
        if (b.value?.page_size !== undefined) expect(b.value.page_size).toBe('100');
      }
    });

    it('origin=overview → footer renders "↩ 总览" with action=dash_overview_refresh', () => {
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const backBtn = allButtons.find((b: any) => b.value?.action === 'dash_overview_refresh');
      expect(backBtn).toBeDefined();
      expect(backBtn.value.invoker_open_id).toBe(INVOKER);
      expect(String(backBtn.text?.content ?? '')).toContain('↩ 总览');
    });

    it('standalone (no origin) → NO back-to-overview button', () => {
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1 }, NOW);
      const parsed = JSON.parse(json);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const backBtn = allButtons.find((b: any) => b.value?.action === 'dash_overview_refresh');
      expect(backBtn).toBeUndefined();
    });

    it('origin=overview → every child button.value carries origin (page_size omitted when == default)', () => {
      // After 2026-06-10 unification, PAGE_SIZE=5 default. When drilldown
      // also passes pageSize=5 (== default), `page_size` is NOT threaded
      // onto button.value (effectivePageSize === PAGE_SIZE branch). Origin
      // remains the canonical drilldown signal.
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const childButtons = allButtons.filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
        // page_size omitted because effective size equals PAGE_SIZE default.
        expect(b.value.page_size).toBeUndefined();
      }
    });

    it('origin=overview + pageSize=3 (overridden) → button.value carries BOTH origin AND page_size', () => {
      // Demonstrate the nav-fields contract still works when the caller
      // overrides to a non-default size.
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const childButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
        expect(b.value.page_size).toBe('3');
      }
    });

    it('totalPages > 2 (rows=12 with pageSize=5 → 3 pages) → select_static jump-page appears', () => {
      const json = buildSessionsCard(rows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const allActions = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const selectStatic = allActions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic).toBeDefined();
      expect(selectStatic.value.action).toBe(SESSIONS_ACTION_PAGE);
      // 12 rows / 5 per page = 3 pages → 3 options.
      expect(selectStatic.options).toHaveLength(3);
      expect(selectStatic.options.map((o: any) => o.value)).toEqual(['1', '2', '3']);
    });

    it('totalPages <= 2 → NO select_static (only prev/next + refresh)', () => {
      const fewRows = rows.slice(0, 8); // 8 rows / 5 per page = 2 pages
      const json = buildSessionsCard(fewRows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const allActions = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const selectStatic = allActions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic).toBeUndefined();
    });

    it('totalPages > 50 cap → NO select_static (payload safety)', () => {
      // pageSize=1 with 60 rows → 60 pages > JUMP_PAGE_MAX_OPTIONS(50)
      const manyRows = Array.from({ length: 60 }, (_, i) => row({ sessionId: `sess_x_${i}`, title: `s${i}` }));
      const json = buildSessionsCard(manyRows, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 1, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const allActions = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const selectStatic = allActions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic).toBeUndefined();
    });
  });
});

describe('buildSessionsDetailCard (slice 2a)', () => {
  const NOW = 2_000_000;
  function detailFor(over: Partial<SessionRow> = {}) {
    return composeDetail(row(over), NOW);
  }
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, nowMs: NOW };

  it('renders a title section that shows the sessionId verbatim', () => {
    const detail = detailFor({ sessionId: 'sess_detail_123', title: 'my session', status: 'idle' });
    const json = buildSessionsDetailCard(detail, baseOpts);
    expect(json).toContain('Dashboard 会话'.replace('Dashboard 会话', '会话')); // detail.title header includes "会话详情"
    expect(json).toContain('会话详情');
    expect(json).toContain('sess_detail_123');
  });

  it('renders the close button with action=dash_sessions_close + session_id', () => {
    const detail = detailFor({ sessionId: 'sess_close_me', status: 'idle' });
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const closeBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_CLOSE,
    );
    expect(closeBtn).toBeDefined();
    expect(closeBtn.value.session_id).toBe('sess_close_me');
    expect(closeBtn.value.invoker_open_id).toBe(INVOKER);
  });

  it('renders the back button with action=dash_sessions_back_to_list', () => {
    const detail = detailFor({ sessionId: 'sess_back', status: 'idle' });
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const backBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_BACK_TO_LIST,
    );
    expect(backBtn).toBeDefined();
    expect(backBtn.value.invoker_open_id).toBe(INVOKER);
  });

  it('enabled close button carries a confirm dialog with non-empty title + text', () => {
    const detail = detailFor({ sessionId: 'sess_confirm', title: 'confirm me', status: 'idle' });
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const closeBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_CLOSE,
    );
    expect(closeBtn.confirm).toBeDefined();
    expect(String(closeBtn.confirm.title?.content ?? '').length).toBeGreaterThan(0);
    expect(String(closeBtn.confirm.text?.content ?? '').length).toBeGreaterThan(0);
    expect(closeBtn.disabled).not.toBe(true); // enabled, must not be marked disabled
  });

  it('closed status → resume button replaces close (slice 2b)', () => {
    // Slice 2b: status='closed' rows render resume INSTEAD OF the close
    // button. The PR1 matrix says `close.enabled=false, resume.enabled=true`
    // when closed. Builder swaps the button rather than rendering a
    // disabled close.
    const detail = detailFor({ sessionId: 'sess_already_closed', status: 'closed' });
    expect(detail.actions.close.enabled).toBe(false);
    expect(detail.actions.resume.enabled).toBe(true);
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const actions = actionRow.actions as any[];
    // No close button on a closed-state card.
    expect(actions.find((a: any) => a.value?.action === SESSIONS_ACTION_CLOSE)).toBeUndefined();
    // resume button present with confirm dialog.
    const resumeBtn = actions.find((a: any) => a.value?.action === 'dash_sessions_resume');
    expect(resumeBtn).toBeDefined();
    expect(resumeBtn.disabled).not.toBe(true);
    expect(resumeBtn.confirm).toBeDefined();
  });

  it('disabled close (starting status) → reason note renders the starting copy', () => {
    const detail = detailFor({ sessionId: 'sess_starting', status: 'starting' });
    expect(detail.actions.close.enabled).toBe(false);
    const json = buildSessionsDetailCard(detail, baseOpts);
    expect(json).toContain('会话启动中');
  });

  /** ─── Overview drilldown — detail back button preserves nav ─── */
  it('detail card with origin=overview (pageSize at default) → back button.value carries origin (page_size omitted)', () => {
    // After 2026-06-10 unification, PAGE_SIZE=5; drilldown passes
    // pageSize=5 (== default), so `page_size` is omitted from nav fields
    // (only included when different from default).
    const detail = detailFor({ sessionId: 'sess_back_overview', status: 'idle' });
    const json = buildSessionsDetailCard(detail, {
      ...baseOpts,
      origin: 'overview',
      pageSize: 5,
    });
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const backBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_BACK_TO_LIST,
    );
    expect(backBtn.value.origin).toBe('overview');
    expect(backBtn.value.page_size).toBeUndefined();
    // close button mirrors back-button nav (so successful close → rebuilt
    // detail → 🔙 返回 still lands on drilldown list).
    const closeBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_CLOSE,
    );
    expect(closeBtn.value.origin).toBe('overview');
    expect(closeBtn.value.page_size).toBeUndefined();
  });

  it('detail card with origin=overview AND overridden pageSize=3 → back/close carry origin AND page_size', () => {
    const detail = detailFor({ sessionId: 'sess_override', status: 'idle' });
    const json = buildSessionsDetailCard(detail, {
      ...baseOpts,
      origin: 'overview',
      pageSize: 3,
    });
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const backBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_BACK_TO_LIST,
    );
    expect(backBtn.value.origin).toBe('overview');
    expect(backBtn.value.page_size).toBe('3');
  });

  it('detail card WITHOUT origin → back/close values do NOT include origin/page_size', () => {
    const detail = detailFor({ sessionId: 'sess_standalone', status: 'idle' });
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const backBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_BACK_TO_LIST,
    );
    expect(backBtn.value.origin).toBeUndefined();
    expect(backBtn.value.page_size).toBeUndefined();
  });

  /** ─── Slice 2b — locate / terminal / resume buttons ─────────────────── */
  describe('slice 2b: detail card 4-action row', () => {
    it('active session → row has locate / terminal / close / back; NO resume', () => {
      const detail = detailFor({ sessionId: 'sess_active', status: 'idle' });
      const json = buildSessionsDetailCard(detail, {
        ...baseOpts,
        terminalUrl: 'http://host:7891',
      });
      const parsed = JSON.parse(json);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const acts = actionRow.actions as any[];
      expect(acts).toHaveLength(4);
      // Locate present (action callback for thread-scope; no feishuChatLink passed).
      expect(acts[0].value?.action).toBe('dash_sessions_locate');
      // Terminal present with multi_url.
      expect(acts[1].multi_url).toBeDefined();
      expect(acts[1].multi_url?.url).toContain('http://host:7891');
      // Close present (NOT resume) — active state.
      expect(acts[2].value?.action).toBe(SESSIONS_ACTION_CLOSE);
      // Back present.
      expect(acts[3].value?.action).toBe(SESSIONS_ACTION_BACK_TO_LIST);
      // No resume button anywhere on the row.
      expect(acts.find(a => a.value?.action === 'dash_sessions_resume')).toBeUndefined();
    });

    it('closed session → row has locate / terminal / resume / back; NO close', () => {
      const detail = detailFor({ sessionId: 'sess_closed', status: 'closed', webPort: null });
      const json = buildSessionsDetailCard(detail, baseOpts);
      const parsed = JSON.parse(json);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const acts = actionRow.actions as any[];
      expect(acts).toHaveLength(4);
      // Resume present (NOT close).
      const resumeBtn = acts.find(a => a.value?.action === 'dash_sessions_resume');
      expect(resumeBtn).toBeDefined();
      expect(resumeBtn.confirm).toBeDefined();
      // No close button.
      expect(acts.find(a => a.value?.action === SESSIONS_ACTION_CLOSE)).toBeUndefined();
    });

    it('terminal: no webPort → button disabled + noPort reason note', () => {
      const detail = detailFor({ sessionId: 'sess_noterm', status: 'closed', webPort: null });
      const json = buildSessionsDetailCard(detail, baseOpts); // no terminalUrl
      const parsed = JSON.parse(json);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const terminalBtn = (actionRow.actions as any[])[1];
      expect(terminalBtn.disabled).toBe(true);
      expect(terminalBtn.multi_url).toBeUndefined();
      expect(json).toContain('Web 终端端口');
    });

    it('terminal: has webPort → button has multi_url, NOT disabled', () => {
      const detail = detailFor({ sessionId: 'sess_term', status: 'idle' });
      const json = buildSessionsDetailCard(detail, {
        ...baseOpts,
        terminalUrl: 'http://host:7891/s/sess_term',
      });
      const parsed = JSON.parse(json);
      const terminalBtn = (parsed.elements as any[]).find(
        (e: any) => e.tag === 'action',
      ).actions[1];
      expect(terminalBtn.disabled).not.toBe(true);
      expect(terminalBtn.multi_url?.url).toBeDefined();
    });

    it('locate (chat-scope) → multi_url to feishuChatLink, NO callback', () => {
      const detail = detailFor({ sessionId: 'sess_chat', status: 'idle', scope: 'chat' });
      expect(detail.actions.locateMode).toBe('openChat');
      const json = buildSessionsDetailCard(detail, {
        ...baseOpts,
        feishuChatLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat',
      });
      const parsed = JSON.parse(json);
      const locateBtn = (parsed.elements as any[]).find(
        (e: any) => e.tag === 'action',
      ).actions[0];
      expect(locateBtn.multi_url?.url).toContain('openChatId');
      expect(locateBtn.value?.action).toBeUndefined();
    });

    it('locate (thread-scope) → callback action, NO multi_url', () => {
      const detail = detailFor({ sessionId: 'sess_thread', status: 'idle', scope: 'thread' });
      expect(detail.actions.locateMode).toBe('openTopic');
      const json = buildSessionsDetailCard(detail, baseOpts);
      const parsed = JSON.parse(json);
      const locateBtn = (parsed.elements as any[]).find(
        (e: any) => e.tag === 'action',
      ).actions[0];
      expect(locateBtn.multi_url).toBeUndefined();
      expect(locateBtn.value?.action).toBe('dash_sessions_locate');
      expect(locateBtn.value?.session_id).toBe('sess_thread');
    });

    it('origin=overview → locate / resume callback values carry origin', () => {
      const detail = detailFor({ sessionId: 'sess_nav', status: 'closed', webPort: null });
      const json = buildSessionsDetailCard(detail, { ...baseOpts, origin: 'overview' });
      const parsed = JSON.parse(json);
      const actions = (parsed.elements as any[]).find((e: any) => e.tag === 'action').actions as any[];
      const locateBtn = actions[0];
      const resumeBtn = actions.find(a => a.value?.action === 'dash_sessions_resume');
      // thread-scope locate has callback; carries origin.
      expect(locateBtn.value?.origin).toBe('overview');
      expect(resumeBtn.value.origin).toBe('overview');
    });

    /** Codex 2026-06-11 blocker #1 — closed sessions can carry a stale
     *  webPort (closeSession doesn't null it). The matrix status gate AND
     *  the buildSessionTerminalUrl status gate together guarantee the
     *  closed detail card never advertises a Web Terminal link. */
    it('closed status with stale webPort → terminal disabled + no multi_url (regression)', () => {
      // Force a closed row that still carries an old webPort (real-world
      // shape: closeSession only flips status, doesn't null the port).
      const detail = detailFor({ sessionId: 'sess_stale', status: 'closed', webPort: 7891 });
      // PR1 matrix must say openTerminal disabled despite the webPort.
      expect(detail.actions.openTerminal.enabled).toBe(false);
      const json = buildSessionsDetailCard(detail, {
        ...baseOpts,
        terminalUrl: 'http://host:7891', // also force a stale URL
      });
      const parsed = JSON.parse(json);
      const actions = (parsed.elements as any[]).find((e: any) => e.tag === 'action').actions as any[];
      const terminalBtn = actions[1];
      expect(terminalBtn.disabled).toBe(true);
      expect(terminalBtn.multi_url).toBeUndefined();
    });
  });

  it('escapes title against <at> / <font> injection so user-supplied chars cannot break the wrapper', () => {
    const detail = detailFor({
      sessionId: 'sess_inject',
      // user-supplied chat title with HTML-shaped chars
      title: '</font><at id=ou_evil></at> evil',
      workingDir: '~/normal',
      status: 'idle',
    });
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    // Find any div whose content references the (escaped) "evil" suffix.
    const evilDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
        && (e.text.content as string).includes('evil'),
    );
    expect(evilDivs.length).toBeGreaterThan(0);
    for (const d of evilDivs) {
      const content = d.text.content as string;
      // Raw `<at` must NOT appear anywhere (escaped form `&lt;at` is fine).
      expect(content).not.toMatch(/<at\b/);
      // `&lt;` must appear (escape took effect).
      expect(content).toContain('&lt;');
    }
  });
});

describe('handleSessionsCardAction', () => {
  function makeDeps(over: any = {}): any {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { sessions: [row({ sessionId: 'sess_a', status: 'working' })] },
      raw: '',
    }));
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh',
      nowMs: () => 2_000_000,
      requestSpy,
      ...over,
    };
  }

  function makeAction(value: Record<string, string>, operator = INVOKER): CardActionData {
    return {
      operator: { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  it('refresh → GET /__daemon/sessions-list, returns { card } only (no toast)', async () => {
    const deps = makeDeps();
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
  });

  it('refresh with dashboard_scope=global → GET /__daemon/sessions-list?scope=global and keeps scope on rebuilt card', async () => {
    const deps = makeDeps();
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER, dashboard_scope: 'global' }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list?scope=global' });
    expect(JSON.stringify(r.card?.data)).toContain('"dashboard_scope":"global"');
  });

  it('second allowedUsers admin can refresh; rebuilt card keeps that admin as invoker', async () => {
    const secondAdmin = 'ou_second_admin';
    const deps = makeDeps({ getDashboardAdminOpenIds: () => [INVOKER, secondAdmin] });
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: secondAdmin }, secondAdmin),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(r.card?.data)).toContain(`"invoker_open_id":"${secondAdmin}"`);
  });

  it('page → uses the requested page index (clamped)', async () => {
    // 25 rows / PAGE_SIZE=5 = 5 pages.
    const rows = Array.from({ length: 25 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { sessions: rows }, raw: '' })),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_PAGE, invoker_open_id: INVOKER, page: '2' }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 2/5 页');
  });

  /** ─── Overview drilldown — handler honors nav state ─── */
  it('page action via select_static (action.option, no value.page) → uses option page', async () => {
    // 12 rows, pageSize=5 → 3 pages. select_static dispatches with
    // action.option='3' but value.page is absent. Handler should fall back
    // to action.option.
    const rows = Array.from({ length: 12 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { sessions: rows }, raw: '' })),
      } as any)),
    });
    // Inject `action.option` on the raw envelope (not value.page).
    const envelope = {
      operator: { open_id: INVOKER },
      action: {
        option: '3',
        value: {
          action: SESSIONS_ACTION_PAGE,
          invoker_open_id: INVOKER,
          origin: 'overview',
          page_size: '5',
        },
      },
      context: { open_message_id: 'om_card' },
    } as any;
    const r = await handleSessionsCardAction(envelope, LARK_APP_ID, deps);
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 3/3 页');
  });

  it('refresh with origin=overview → rebuilt card still has back-to-overview button + 5/page', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { sessions: rows }, raw: '' })),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({
        action: SESSIONS_ACTION_REFRESH,
        invoker_open_id: INVOKER,
        origin: 'overview',
        page_size: '5',
      }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    // 12 / 5 = 3 pages.
    expect(cardJson).toContain('第 1/3 页');
    // Back-to-overview button.
    expect(cardJson).toContain('dash_overview_refresh');
    expect(cardJson).toContain('↩ 总览');
  });

  it('back_to_list with origin=overview → rebuilt list is drilldown shape (5/page + back btn)', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { sessions: rows }, raw: '' })),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({
        action: SESSIONS_ACTION_BACK_TO_LIST,
        invoker_open_id: INVOKER,
        origin: 'overview',
        page_size: '5',
      }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 1/3 页');
    expect(cardJson).toContain('dash_overview_refresh');
  });

  it('detail with origin=overview (default page size) → detail back/close values carry origin (page_size omitted)', async () => {
    // After 2026-06-10 unification PAGE_SIZE=5; 5 == default → page_size
    // omitted (only origin remains as the drilldown signal).
    const rows = [row({ sessionId: 's_detail', title: 'detail', status: 'idle' })];
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { sessions: rows }, raw: '' })),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({
        action: SESSIONS_ACTION_DETAIL,
        invoker_open_id: INVOKER,
        session_id: 's_detail',
        origin: 'overview',
        page_size: '5',
      }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    // Detail card itself does NOT render back-to-overview (single back
    // affordance per slice) but the back button must propagate origin so
    // the rebuilt list stays drilldown.
    expect(cardJson).toContain('"origin":"overview"');
    expect(cardJson).not.toContain('"page_size":"5"');
  });

  it('detail with origin=overview AND overridden page_size=3 → back/close carry origin AND page_size', async () => {
    const rows = [row({ sessionId: 's_detail_override', title: 'detail', status: 'idle' })];
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { sessions: rows }, raw: '' })),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({
        action: SESSIONS_ACTION_DETAIL,
        invoker_open_id: INVOKER,
        session_id: 's_detail_override',
        origin: 'overview',
        page_size: '3',
      }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('"origin":"overview"');
    expect(cardJson).toContain('"page_size":"3"');
  });

  it('non-admin → toast `owner_only`, NO client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => 'ou_other' });
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('missing invoker_open_id → toast `not_invoker`, no client call', async () => {
    const deps = makeDeps();
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH }),  // no invoker_open_id
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('invoker_open_id !== operator.open_id → toast `not_invoker`', async () => {
    const deps = makeDeps();
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER }, 'ou_stranger'),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('Route B throws → toast `list_failed` with the error reason', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => { throw new Error('boom'); } } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('拉取会话列表失败');
    expect(r.toast?.content).toContain('boom');
    expect(r.card).toBeUndefined();
  });

  // codex slice-1 blocker #1: createDaemonClient.request does NOT throw on
  // 4xx/5xx — it returns the response. Before the fix a 500 would surface
  // as an empty list (sessions undefined → []), masking the real failure.
  it('Route B returns 500 → toast `list_failed` with http_500, NO empty list card', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: async () => ({ status: 500, body: {}, raw: '' }),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('http_500');
    expect(r.card).toBeUndefined();
  });

  it('Route B 401 with body.error → reason uses body.error verbatim', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: async () => ({ status: 401, body: { error: 'bad_signature' }, raw: '' }),
      } as any)),
    });
    const r = await handleSessionsCardAction(
      makeAction({ action: SESSIONS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('bad_signature');
    expect(r.toast?.content).not.toContain('http_401');
  });

  it('unknown action → toast `invalid_action`, no client call', async () => {
    const deps = makeDeps();
    const r = await handleSessionsCardAction(
      makeAction({ action: 'dash_sessions_evil', invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('⚠️');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  // ─── Slice 2a: DETAIL ────────────────────────────────────────────────
  describe('action=dash_sessions_detail', () => {
    function makeDetailDeps(sessionId = 'sess_a') {
      const sessions = [
        row({ sessionId, status: 'idle', title: 'visible row' }),
        row({ sessionId: 'sess_other', status: 'working', title: 'other' }),
      ];
      const requestSpy = vi.fn(async () => ({ status: 200, body: { sessions }, raw: '' }));
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh',
        nowMs: () => 2_000_000,
        requestSpy,
      };
    }

    it('happy: GET sessions-list and returns { card } containing the detail (with close button)', async () => {
      const deps = makeDetailDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(deps.requestSpy).toHaveBeenCalledOnce();
      expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list' });
      expect(r.toast).toBeUndefined();
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      // Detail card header rendered + close button present.
      expect(cardJson).toContain('会话详情');
      expect(cardJson).toContain(SESSIONS_ACTION_CLOSE);
      expect(cardJson).toContain('sess_a');
    });

    it('session_id not in list → toast session_not_found, no card', async () => {
      const deps = makeDetailDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_does_not_exist' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('会话不存在');
      expect(r.card).toBeUndefined();
    });

    it('non-admin → toast, no GET', async () => {
      const deps = { ...makeDetailDeps('sess_a'), getOwnerOpenId: () => 'ou_other' };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('missing invoker_open_id → toast, no GET', async () => {
      const deps = makeDetailDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('invoker mismatch → toast, no GET', async () => {
      const deps = makeDetailDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction(
          { action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_a' },
          'ou_stranger',
        ),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('Route B GET throws → toast list_failed (boom), no card', async () => {
      const deps = {
        createClient: vi.fn(() => ({ request: async () => { throw new Error('boom'); } } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('拉取会话列表失败');
      expect(r.toast?.content).toContain('boom');
      expect(r.card).toBeUndefined();
    });

    it('Route B GET 500 → toast list_failed http_500, no card', async () => {
      const deps = {
        createClient: vi.fn(() => ({
          request: async () => ({ status: 500, body: {}, raw: '' }),
        } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('http_500');
      expect(r.card).toBeUndefined();
    });

    it('Route B GET 401 → toast list_failed (uses body.error verbatim), no card', async () => {
      const deps = {
        createClient: vi.fn(() => ({
          request: async () => ({ status: 401, body: { error: 'bad_signature' }, raw: '' }),
        } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_DETAIL, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('bad_signature');
      expect(r.card).toBeUndefined();
    });
  });

  // ─── Slice 2a: CLOSE ─────────────────────────────────────────────────
  describe('action=dash_sessions_close', () => {
    function makeCloseDeps(sessionId = 'sess_a', closePostResp?: { status: number; body?: any }) {
      const sessions = [
        row({ sessionId, status: 'idle', title: 'close me' }),
        row({ sessionId: 'sess_other', status: 'working', title: 'other' }),
      ];
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
          return { status: 200, body: { sessions }, raw: '' };
        }
        if (req.method === 'POST' && req.path.startsWith('/__daemon/sessions/')) {
          return closePostResp ?? { status: 200, body: { ok: true, alreadyClosed: false }, raw: '' };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh',
        nowMs: () => 2_000_000,
        requestSpy,
      };
    }

    it('happy: GET once + POST once + synthesizes closed detail (no 2nd GET, no toast)', async () => {
      const deps = makeCloseDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      // Verify call shape: GET (pre-POST snapshot) then POST. NO third call.
      expect(deps.requestSpy).toHaveBeenCalledTimes(2);
      expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list' });
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/sessions/sess_a/close' }),
      );
      // No toast on success.
      expect(r.toast).toBeUndefined();
      // Detail card returned. Slice 2b: closed-state detail no longer has
      // a disabled close button — it renders the resume button instead.
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('会话详情');
      // Resume button on closed-state card.
      expect(cardJson).toContain('dash_sessions_resume');
      // No close action button (it's been replaced by resume).
      expect(cardJson).not.toContain('"action":"dash_sessions_close"');
      // Codex 2026-06-11 blocker #1: terminal must be disabled and have no
      // multi_url on the closed synth (port cleared, status gate fires).
      expect(cardJson).not.toContain('multi_url');
      expect(cardJson).toContain('Web 终端端口');
    });

    it('POST 404 → toast close_failed, NO card (state preserved)', async () => {
      const deps = makeCloseDeps('sess_a', { status: 404, body: { error: 'unknown_session' } });
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('关闭失败');
      // body.error is preferred over http_404
      expect(r.toast?.content).toContain('unknown_session');
      expect(r.card).toBeUndefined();
    });

    it('POST 500 (no body.error) → toast close_failed http_500, NO card', async () => {
      const deps = makeCloseDeps('sess_a', { status: 500, body: {} });
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('关闭失败');
      expect(r.toast?.content).toContain('http_500');
      expect(r.card).toBeUndefined();
    });

    it('POST throws → toast close_failed (err.message), NO card', async () => {
      // Custom client where GET works but POST throws.
      const sessions = [row({ sessionId: 'sess_a', status: 'idle', title: 'x' })];
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
          return { status: 200, body: { sessions }, raw: '' };
        }
        throw new Error('network down');
      });
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('关闭失败');
      expect(r.toast?.content).toContain('network down');
      expect(r.card).toBeUndefined();
    });

    it('non-admin → toast, no POST issued', async () => {
      const deps = { ...makeCloseDeps('sess_a'), getOwnerOpenId: () => 'ou_other' };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      // No client was even created.
      expect(deps.createClient).not.toHaveBeenCalled();
      // Spy was untouched.
      expect(deps.requestSpy).not.toHaveBeenCalled();
    });

    it('invoker mismatch → toast, no POST issued', async () => {
      const deps = makeCloseDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction(
          { action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' },
          'ou_stranger',
        ),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('pre-POST GET cannot find sessionId → toast session_not_found, NO POST issued', async () => {
      const deps = makeCloseDeps('sess_a');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_GHOST' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('会话不存在');
      expect(r.card).toBeUndefined();
      // Only the GET was issued; NO POST call ever happened.
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    // codex 2026-06-10 SECURITY BLOCKER: client-side `disabled` on the close
    // button is UX only. The callback handler MUST re-run composeDetail's
    // action matrix against the fresh snapshot and fail-closed on
    // `enabled === false`. These two tests cover the matrix's two
    // closed-button reasonKeys (alreadyClosed + starting).
    function makeCloseDepsWithStatus(sessionId: string, status: SessionRow['status']) {
      const sessions = [row({ sessionId, status, title: 'guard me' })];
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
          return { status: 200, body: { sessions }, raw: '' };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
        requestSpy,
      };
    }

    it('pre-POST snapshot status=starting → toast (close.disabled.starting), POST 0 times', async () => {
      const deps = makeCloseDepsWithStatus('sess_a', 'starting');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      // Toast surfaces the matrix's starting reason (matches the inline
      // disabled-button note text).
      expect(r.toast?.content).toContain('启动中');
      expect(r.card).toBeUndefined();
      // GET happened (snapshot); POST NEVER happened.
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('pre-POST snapshot status=closed → toast (close.disabled.alreadyClosed), POST 0 times', async () => {
      const deps = makeCloseDepsWithStatus('sess_a', 'closed');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_CLOSE, invoker_open_id: INVOKER, session_id: 'sess_a' }),
        LARK_APP_ID,
        deps,
      );
      expect(r.toast?.content).toContain('已关闭');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });
  });

  // ─── Slice 2a: BACK TO LIST ─────────────────────────────────────────
  describe('action=dash_sessions_back_to_list', () => {
    it('GET sessions-list → returns { card } with list card body at page 1', async () => {
      // 25 rows / PAGE_SIZE=5 = 5 pages.
      const sessions = Array.from({ length: 25 }, (_, i) =>
        row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }),
      );
      const requestSpy = vi.fn(async () => ({ status: 200, body: { sessions }, raw: '' }));
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER }),
        LARK_APP_ID,
        deps as any,
      );
      expect(requestSpy).toHaveBeenCalledOnce();
      expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list' });
      expect(r.toast).toBeUndefined();
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      // Renders the list card title + lands on page 1 of the 5-page set.
      expect(cardJson).toContain('Dashboard 会话');
      expect(cardJson).toContain('第 1/5 页');
    });

    it('back_to_list with source page → restores that page, not page 1', async () => {
      // 25 rows / PAGE_SIZE=5 = 5 pages; detail card was opened from page 3 and
      // threads `page=3` back through the 🔙 button (M8 — consistent with
      // schedules/workflows detail cards).
      const sessions = Array.from({ length: 25 }, (_, i) =>
        row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }),
      );
      const requestSpy = vi.fn(async () => ({ status: 200, body: { sessions }, raw: '' }));
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER, page: '3' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('第 3/5 页');
    });

    it('non-admin → toast, no GET', async () => {
      const requestSpy = vi.fn();
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => 'ou_other',
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('invoker mismatch → toast, no GET', async () => {
      const requestSpy = vi.fn();
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER }, 'ou_stranger'),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });
  });

  /** ─── Slice 2b: LOCATE + RESUME handler ──────────────────────────── */
  describe('action=dash_sessions_locate', () => {
    /** Codex 2026-06-11 blocker #2 — locate now pre-GETs to verify scope.
     *  Helper makes a 2-stage spy: GET returns the row, POST returns the
     *  configured response. */
    function makeLocateDeps(rowOver: Partial<SessionRow> & { sessionId: string }, postResp: { status: number; body: any } = { status: 200, body: { ok: true } }) {
      const sessionRow = row({ status: 'idle', scope: 'thread', ...rowOver });
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
          return { status: 200, body: { sessions: [sessionRow] }, raw: '' };
        }
        if (req.method === 'POST' && req.path === `/__daemon/sessions/${sessionRow.sessionId}/locate`) {
          return { status: postResp.status, body: postResp.body, raw: '' };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
        requestSpy,
      };
    }

    it('happy (thread-scope) → GET + POST, toast-only success, no card', async () => {
      const deps = makeLocateDeps({ sessionId: 'sess_locate', scope: 'thread' });
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_LOCATE, invoker_open_id: INVOKER, session_id: 'sess_locate' }),
        LARK_APP_ID,
        deps as any,
      );
      // 2 calls: pre-GET (scope check) + POST.
      expect(deps.requestSpy).toHaveBeenCalledTimes(2);
      expect(deps.requestSpy.mock.calls[0][0].method).toBe('GET');
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/sessions/sess_locate/locate' }),
      );
      expect(r.toast?.type).toBe('success');
      expect(r.toast?.content).toContain('定位标记');
      expect(r.card).toBeUndefined();
    });

    it('chat-scope crafted callback → server-side rejected, POST 0 times', async () => {
      // Codex 2026-06-11 blocker #2: chat-scope rows render `multi_url(feishuChatLink)`,
      // never the action callback. A hand-crafted callback against a chat-scope
      // row must be rejected before any POST hits the daemon — otherwise the
      // thread-locate path would fire a misleading @mention in a chat that
      // wasn't asked for it.
      const deps = makeLocateDeps({ sessionId: 'sess_chat', scope: 'chat' });
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_LOCATE, invoker_open_id: INVOKER, session_id: 'sess_chat' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.type).toBe('error');
      expect(r.toast?.content).toContain('定位失败');
      expect(r.toast?.content).toContain('chat_scope_not_supported');
      // Defense-in-depth: only the GET ran; no POST issued.
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls).toHaveLength(0);
    });

    it('POST 429 → toast locate_failed, no card', async () => {
      const deps = makeLocateDeps(
        { sessionId: 'sess_cd', scope: 'thread' },
        { status: 429, body: { error: 'cooldown' } },
      );
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_LOCATE, invoker_open_id: INVOKER, session_id: 'sess_cd' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.type).toBe('error');
      expect(r.toast?.content).toContain('定位失败');
      expect(r.toast?.content).toContain('cooldown');
      expect(r.card).toBeUndefined();
    });

    it('POST throws → toast locate_failed with reason, no card', async () => {
      const sessionRow = row({ sessionId: 'sess_x', scope: 'thread' });
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET') return { status: 200, body: { sessions: [sessionRow] }, raw: '' };
        throw new Error('econnrefused');
      });
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_LOCATE, invoker_open_id: INVOKER, session_id: 'sess_x' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.type).toBe('error');
      expect(r.toast?.content).toContain('econnrefused');
      expect(r.card).toBeUndefined();
    });

    it('missing session_id → session_not_found toast, no client call', async () => {
      const requestSpy = vi.fn();
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_LOCATE, invoker_open_id: INVOKER }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('不存在');
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('row vanished → session_not_found toast, no POST', async () => {
      const requestSpy = vi.fn(async () => ({ status: 200, body: { sessions: [] }, raw: '' }));
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_LOCATE, invoker_open_id: INVOKER, session_id: 'sess_ghost' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('不存在');
      const postCalls = requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls).toHaveLength(0);
    });
  });

  describe('action=dash_sessions_resume', () => {
    function makeResumeDeps(sessionId: string, postResp: { status: number; body: any } = { status: 200, body: { ok: true } }, postRefetchRow?: SessionRow | null) {
      const closedRow = row({ sessionId, status: 'closed', title: 'closed-row' });
      const refetchRow = postRefetchRow === undefined
        ? row({ sessionId, status: 'idle', webPort: 7892, title: 'closed-row' })
        : postRefetchRow;
      let getCalls = 0;
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
          getCalls += 1;
          if (getCalls === 1) return { status: 200, body: { sessions: [closedRow] }, raw: '' };
          return { status: 200, body: { sessions: refetchRow ? [refetchRow] : [] }, raw: '' };
        }
        if (req.method === 'POST' && req.path === `/__daemon/sessions/${sessionId}/resume`) {
          return { status: postResp.status, body: postResp.body, raw: '' };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
        requestSpy,
      };
    }

    it('happy: GET + POST + 2nd GET → rebuild detail with fresh row', async () => {
      const deps = makeResumeDeps('sess_r');
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_RESUME, invoker_open_id: INVOKER, session_id: 'sess_r' }),
        LARK_APP_ID,
        deps as any,
      );
      // 3 calls: pre-GET + POST + post-GET
      expect(deps.requestSpy).toHaveBeenCalledTimes(3);
      expect(deps.requestSpy.mock.calls[0][0].method).toBe('GET');
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/sessions/sess_r/resume' }),
      );
      expect(deps.requestSpy.mock.calls[2][0].method).toBe('GET');
      // Fresh row → idle status → card no longer shows resume button.
      expect(r.toast).toBeUndefined();
      const cardJson = JSON.stringify(r.card?.data);
      // Idle now → close button reappears, resume gone.
      expect(cardJson).toContain('"action":"dash_sessions_close"');
      expect(cardJson).not.toContain('"action":"dash_sessions_resume"');
    });

    it('active state replay (matrix says resume.enabled=false) → toast resume.disabled.onlyClosed, 0 POST', async () => {
      const activeRow = row({ sessionId: 'sess_active', status: 'idle' });
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET') return { status: 200, body: { sessions: [activeRow] }, raw: '' };
        throw new Error('POST should not be called');
      });
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_RESUME, invoker_open_id: INVOKER, session_id: 'sess_active' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.type).toBe('error');
      expect(r.toast?.content).toContain('仅可恢复已关闭');
      // No POST was issued — security matrix gate worked.
      const postCalls = requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls).toHaveLength(0);
    });

    it('POST 500 → toast resume_failed, no card', async () => {
      const deps = makeResumeDeps('sess_r', { status: 500, body: { error: 'worker_failed' } });
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_RESUME, invoker_open_id: INVOKER, session_id: 'sess_r' }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.type).toBe('error');
      expect(r.toast?.content).toContain('恢复失败');
      expect(r.toast?.content).toContain('worker_failed');
      expect(r.card).toBeUndefined();
    });

    it('2nd GET refetch row vanished → fallback synth with status=idle', async () => {
      const deps = makeResumeDeps('sess_r', { status: 200, body: { ok: true } }, null);
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_RESUME, invoker_open_id: INVOKER, session_id: 'sess_r' }),
        LARK_APP_ID,
        deps as any,
      );
      // Fallback synth: still renders a card (no error).
      expect(r.toast).toBeUndefined();
      expect(r.card).toBeDefined();
    });

    it('missing session_id → session_not_found toast, no client call', async () => {
      const requestSpy = vi.fn();
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => 2_000_000,
      };
      const r = await handleSessionsCardAction(
        makeAction({ action: SESSIONS_ACTION_RESUME, invoker_open_id: INVOKER }),
        LARK_APP_ID,
        deps as any,
      );
      expect(r.toast?.content).toContain('不存在');
      expect(requestSpy).not.toHaveBeenCalled();
    });
  });
});
