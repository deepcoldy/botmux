/**
 * PR3 `/dashboard sessions` slice 1 — card builder + callback handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SessionRow } from '../src/core/dashboard-rows.js';
import { composeDetail } from '../src/dashboard/session-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildSessionsCard,
  buildSessionsDetailCard,
  handleSessionsCardAction,
  SESSIONS_ACTION_BACK_TO_LIST,
  SESSIONS_ACTION_CLOSE,
  SESSIONS_ACTION_DETAIL,
  SESSIONS_ACTION_PAGE,
  SESSIONS_ACTION_REFRESH,
} from '../src/im/lark/sessions-card.js';

const INVOKER = 'ou_owner';
const LARK_APP_ID = 'cli_test';

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
    expect(json).not.toContain('上一页');
    expect(json).not.toContain('下一页');
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

  it('renders pagination buttons when > 10 rows; page=2 emits prev=1 / next=3', () => {
    const rows: SessionRow[] = Array.from({ length: 25 }, (_, i) =>
      row({ sessionId: `sess_${i}`, title: `title-${i}`, status: 'idle' }),
    );
    const json = buildSessionsCard(rows, { ...baseOpts, page: 2 }, NOW);
    expect(json).toContain('上一页');
    expect(json).toContain('下一页');
    expect(json).toContain('第 2/3 页');
    // prev → page=1, next → page=3
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');
  });

  it('on first page prev is disabled; on last page next is disabled', () => {
    const rows: SessionRow[] = Array.from({ length: 15 }, (_, i) => row({ sessionId: `s_${i}`, title: `t-${i}`, status: 'idle' }));
    const findPagerButtons = (json: string): { prev: any; next: any } => {
      const parsed = JSON.parse(json);
      // Slice 2a introduced per-row `📂 详情` action elements before the
      // pagination row, so we can't grab the first action; flatten across
      // all action elements and pick by button label instead.
      const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
      const allActions = actionRows.flatMap((r: any) => (r.actions as any[]) ?? []);
      const prev = allActions.find((a: any) => String(a.text?.content ?? '').includes('上一页'));
      const next = allActions.find((a: any) => String(a.text?.content ?? '').includes('下一页'));
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

  it('disabled close (closed status) → button disabled + reason note rendered', () => {
    const detail = detailFor({ sessionId: 'sess_already_closed', status: 'closed' });
    expect(detail.actions.close.enabled).toBe(false);
    const json = buildSessionsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const closeBtn = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SESSIONS_ACTION_CLOSE,
    );
    expect(closeBtn.disabled).toBe(true);
    // No confirm attached on a disabled button.
    expect(closeBtn.confirm).toBeUndefined();
    // The reasonKey note for alreadyClosed should render somewhere on the card.
    expect(json).toContain('会话已关闭');
  });

  it('disabled close (starting status) → reason note renders the starting copy', () => {
    const detail = detailFor({ sessionId: 'sess_starting', status: 'starting' });
    expect(detail.actions.close.enabled).toBe(false);
    const json = buildSessionsDetailCard(detail, baseOpts);
    expect(json).toContain('会话启动中');
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

  it('page → uses the requested page index (clamped)', async () => {
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
    expect(cardJson).toContain('第 2/3 页');
  });

  it('non-owner → toast `owner_only`, NO client call', async () => {
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

    it('non-owner → toast, no GET', async () => {
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
      // Detail card returned, with close button DISABLED (status overlay → 'closed').
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('会话详情');
      expect(cardJson).toContain('"disabled":true');
      expect(cardJson).toContain('会话已关闭');
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

    it('non-owner → toast, no POST issued', async () => {
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
      // Renders the list card title + lands on page 1 of the 3-page set.
      expect(cardJson).toContain('Dashboard 会话');
      expect(cardJson).toContain('第 1/3 页');
    });

    it('non-owner → toast, no GET', async () => {
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
});
