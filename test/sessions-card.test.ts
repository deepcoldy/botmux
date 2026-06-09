/**
 * PR3 `/dashboard sessions` slice 1 — card builder + callback handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SessionRow } from '../src/core/dashboard-rows.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildSessionsCard,
  handleSessionsCardAction,
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
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const actions = actionRow.actions as any[];
      const prev = actions.find((a: any) => String(a.text?.content ?? '').includes('上一页'));
      const next = actions.find((a: any) => String(a.text?.content ?? '').includes('下一页'));
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
    const actionRow = elements.find((e: any) => e.tag === 'action');
    expect(actionRow).toBeDefined();
    for (const btn of actionRow.actions) {
      expect(btn.value?.invoker_open_id).toBe(INVOKER);
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
});
