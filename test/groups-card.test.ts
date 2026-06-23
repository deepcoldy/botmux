/**
 * PR3 `/dashboard groups` — card builder + callback handler tests.
 *
 * Exercises the groups-specific count summary, escaping, pagination, global
 * matrix aggregation, detail management actions, and handler arms.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  GroupsBotInput,
  GroupsChatInput,
  GroupsMemberBotInput,
} from '../src/dashboard/groups-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildGroupsCard,
  buildGroupsDetailCard,
  buildGroupsRoleCard,
  handleGroupsCardAction,
  GROUPS_ACTION_ADD_BOT,
  GROUPS_ACTION_DETAIL,
  GROUPS_ACTION_LEAVE_BOT,
  GROUPS_ACTION_ONCALL_BIND,
  GROUPS_ACTION_ONCALL_UNBIND,
  GROUPS_ACTION_PAGE,
  GROUPS_ACTION_REFRESH,
  GROUPS_ACTION_ROLE_DELETE,
  GROUPS_ACTION_ROLE_OPEN,
  GROUPS_ACTION_ROLE_SAVE,
} from '../src/im/lark/groups-card.js';

const INVOKER = 'ou_owner';
const LARK_APP_ID = 'cli_test';

const SELF_BOT: GroupsBotInput = { larkAppId: LARK_APP_ID, botName: 'self-bot' };

function member(over: Partial<GroupsMemberBotInput> = {}): GroupsMemberBotInput {
  return {
    larkAppId: LARK_APP_ID,
    botName: 'self-bot',
    inChat: true,
    oncallChat: null,
    ...over,
  };
}

function chat(over: Partial<GroupsChatInput> = {}): GroupsChatInput {
  return {
    chatId: 'oc_default1234',
    name: 'default-room',
    memberBots: [member()],
    ...over,
  };
}

function matrix(chats: GroupsChatInput[], bots: GroupsBotInput[] = [SELF_BOT]) {
  return { chats, bots };
}

describe('buildGroupsCard', () => {
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, page: 1 };

  it('empty list → renders empty state, refresh button present', () => {
    const json = buildGroupsCard(matrix([], [SELF_BOT]), baseOpts);
    expect(json).toContain('Dashboard 群组');
    expect(json).toContain('_当前没有群_');
    // No pagination buttons (single page when empty).
    expect(json).not.toContain('← 上');
    expect(json).not.toContain('下 →');
    // Refresh button always present.
    expect(json).toContain(GROUPS_ACTION_REFRESH);
  });

  it('count summary "总群数 N · 全覆盖 M · 未覆盖 K"', () => {
    const chats: GroupsChatInput[] = [
      chat({ chatId: 'oc_a1', name: 'in-1', memberBots: [member({ inChat: true })] }),
      chat({ chatId: 'oc_a2', name: 'in-2', memberBots: [member({ inChat: true })] }),
      chat({ chatId: 'oc_b1', name: 'out-1', memberBots: [member({ inChat: false })] }),
      chat({ chatId: 'oc_c1', name: 'unknown-1', memberBots: [member({ inChat: undefined, status: 'unknown' })] }),
    ];
    const json = buildGroupsCard(matrix(chats), baseOpts);
    expect(json).toContain('总群数 4');
    expect(json).toContain('全覆盖 2');
    expect(json).toContain('未覆盖 2');
    expect(json).toContain('第 1/1 页');
  });

  it('row content shows chat.name + chatIdSuffix + status (in/out/unknown/error)', () => {
    const chats: GroupsChatInput[] = [
      chat({ chatId: 'oc_in_xxxx', name: 'group-in', memberBots: [member({ inChat: true })] }),
      chat({ chatId: 'oc_out_xxx', name: 'group-out', memberBots: [member({ inChat: false })] }),
      chat({ chatId: 'oc_unk_xxx', name: 'group-unk', memberBots: [member({ inChat: undefined, status: 'unknown' })] }),
      chat({ chatId: 'oc_err_xxx', name: 'group-err', memberBots: [member({ status: 'error' })] }),
    ];
    const json = buildGroupsCard(matrix(chats), baseOpts);
    // Each name rendered.
    expect(json).toContain('group-in');
    expect(json).toContain('group-out');
    expect(json).toContain('group-unk');
    expect(json).toContain('group-err');
    // Each chatIdSuffix (last 4 chars) rendered.
    expect(json).toContain('xxxx');
    // Status labels.
    expect(json).toContain('已加入');
    expect(json).toContain('未加入');
    expect(json).toContain('未知');
    expect(json).toContain('错误');
    // Status icons.
    expect(json).toContain('🟢');
    expect(json).toContain('⚪');
    expect(json).toContain('🟡');
    expect(json).toContain('🔴');
  });

  it('scope=global → values carry dashboard_scope and row summarizes all bot columns', () => {
    const otherBot: GroupsBotInput = { larkAppId: 'cli_other', botName: 'other-bot' };
    const chats: GroupsChatInput[] = [
      chat({
        chatId: 'oc_global',
        name: 'global-room',
        memberBots: [
          member({ inChat: true }),
          { larkAppId: 'cli_other', botName: 'other-bot', inChat: false },
        ],
      }),
    ];
    const json = buildGroupsCard(
      matrix(chats, [SELF_BOT, otherBot]),
      { ...baseOpts, scope: 'global' },
    );
    expect(json).toContain('"dashboard_scope":"global"');
    expect(json).toContain('覆盖 未加入');
    expect(json).toContain('已加入 1/2');
    expect(json).toContain('全覆盖 0 · 未覆盖 1');
  });

  // codex slice-1 blocker: chat.name is user-controlled (group title) and
  // chatIdSuffix flows into a `<font color="grey">…</font>` wrapper. Without
  // escaping, a payload like `</font><at id=ou_x></at>` in either would close
  // our wrapper and inject @mention-shaped content.
  it('escape: chat.name + workingDir injection with <at>/<font> → no naked <at, correct closing </font> count', () => {
    const chats: GroupsChatInput[] = [
      chat({
        chatId: 'oc_inject_name',
        // chat.name carries the <at>/<font> injection payload.
        name: '<at id=ou_x></at> evil name',
        memberBots: [member({ inChat: true })],
      }),
      chat({
        // chatIdSuffix takes the LAST 4 chars of chatId; arrange the suffix
        // to carry `<at>`-shaped bytes so an injection in the suffix would
        // close our outer `<font color="grey">` wrapper if not escaped.
        chatId: 'oc_</font><at',
        name: 'normal name',
        memberBots: [member({ inChat: true })],
      }),
    ];
    const json = buildGroupsCard(matrix(chats), baseOpts);
    const parsed = JSON.parse(json);
    const rowDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
        && /(evil name|normal name)/.test(e.text.content as string),
    );
    expect(rowDivs.length).toBe(2);
    for (const d of rowDivs) {
      const content = d.text.content as string;
      // No naked `<at`.
      expect(content).not.toMatch(/<at\b/);
      // The row renders two intentional outer `<font color="grey">…</font>`
      // wrappers — one for the chatIdSuffix and one for the secondary
      // status line — so the closing tag count must match the opener count
      // exactly (no stray closer that would escape the wrapper).
      const closingFontCount = (content.match(/<\/font>/g) ?? []).length;
      const openingFontCount = (content.match(/<font\b[^>]*>/g) ?? []).length;
      expect(closingFontCount).toBe(openingFontCount);
      expect(closingFontCount).toBeGreaterThanOrEqual(1);
      // Escaped form visible.
      expect(content).toContain('&lt;');
    }
    // The intentional outer wrapper is still there (JSON-encoded).
    expect(json).toContain('<font color=\\"grey\\">');
  });

  it('escape order — `&` is escaped first so `<` does NOT become `&amp;lt;`', () => {
    const chats: GroupsChatInput[] = [
      chat({ chatId: 'oc_amp1234', name: 'A & B<x>' }),
    ];
    const json = buildGroupsCard(matrix(chats), baseOpts);
    expect(json).toContain('A &amp; B');
    expect(json).not.toContain('&amp;lt;');
    expect(json).not.toContain('&amp;amp;');
  });

  it('pagination: > 5 rows → prev/next, boundary disable (page=2 of 5 with 25 rows)', () => {
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    const chats: GroupsChatInput[] = Array.from({ length: 25 }, (_, i) =>
      chat({ chatId: `oc_${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
    );
    const json = buildGroupsCard(matrix(chats), { ...baseOpts, page: 2 });
    expect(json).toContain('← 上');
    expect(json).toContain('下 →');
    expect(json).toContain('第 2/5 页');
    // prev → page=1, next → page=3
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');

    const findPagerButtons = (j: string): { prev: any; next: any } => {
      const parsed = JSON.parse(j);
      const actions = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const prev = actions.find((a: any) => String(a.text?.content ?? '').includes('← 上'));
      const next = actions.find((a: any) => String(a.text?.content ?? '').includes('下 →'));
      return { prev, next };
    };

    // page=1 → prev disabled
    const page1 = buildGroupsCard(matrix(chats), { ...baseOpts, page: 1 });
    const { prev: p1prev, next: p1next } = findPagerButtons(page1);
    expect(p1prev.disabled).toBe(true);
    expect(p1next.disabled).toBe(false);

    // page=5 (last) → next disabled
    const page5 = buildGroupsCard(matrix(chats), { ...baseOpts, page: 5 });
    const { prev: p5prev, next: p5next } = findPagerButtons(page5);
    expect(p5prev.disabled).toBe(false);
    expect(p5next.disabled).toBe(true);
  });

  it('every action button carries `invoker_open_id` bound to the OWNER', () => {
    const chats: GroupsChatInput[] = Array.from({ length: 15 }, (_, i) =>
      chat({ chatId: `oc_${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
    );
    const json = buildGroupsCard(matrix(chats), baseOpts);
    const parsed = JSON.parse(json);
    const elements = parsed.elements as any[];
    const actionRow = elements.find((e: any) => e.tag === 'action');
    expect(actionRow).toBeDefined();
    for (const btn of actionRow.actions) {
      expect(btn.value?.invoker_open_id).toBe(INVOKER);
    }
  });

  it('NEVER leaks `union_id` or `senderUnionId` in the rendered JSON', () => {
    const chats: GroupsChatInput[] = [chat()];
    const json = buildGroupsCard(matrix(chats), baseOpts);
    expect(json).not.toContain('"union_id"');
    expect(json).not.toContain('"senderUnionId"');
  });

  it('list row renders a compact 管理 entry carrying chat_id + current page', () => {
    const json = buildGroupsCard(matrix([chat({ chatId: 'oc_manage', name: 'manage-room' })]), baseOpts);
    const parsed = JSON.parse(json);
    const actions = (parsed.elements as any[])
      .filter((e: any) => e.tag === 'action')
      .flatMap((e: any) => e.actions ?? []);
    const manage = actions.find((a: any) => a.value?.action === GROUPS_ACTION_DETAIL);
    expect(manage).toBeDefined();
    expect(manage.text.content).toContain('管理');
    expect(manage.value.chat_id).toBe('oc_manage');
    expect(manage.value.page).toBe('1');
    expect(manage.value.invoker_open_id).toBe(INVOKER);
  });

  it('detail card renders add / remove / oncall / role controls per bot status', () => {
    const otherBot: GroupsBotInput = { larkAppId: 'cli_other', botName: 'other-bot' };
    const group = chat({
      chatId: 'oc_detail',
      name: 'detail-room',
      memberBots: [
        member({ inChat: true, hasRole: true, oncallChat: { chatId: 'oc_detail', workingDir: '/repo' } }),
        { larkAppId: 'cli_other', botName: 'other-bot', inChat: false, oncallChat: null },
      ],
    });
    const json = buildGroupsDetailCard(
      matrix([group], [SELF_BOT, otherBot]),
      group,
      { invokerOpenId: INVOKER, locale: 'zh', page: 2, origin: 'overview', scope: 'global' },
    );
    expect(json).toContain('群组管理');
    expect(json).toContain('detail-room');
    expect(json).toContain('Role 已配置');
    expect(json).toContain('Oncall 开启 /repo');
    expect(json).toContain(GROUPS_ACTION_ROLE_OPEN);
    expect(json).toContain(GROUPS_ACTION_ONCALL_UNBIND);
    expect(json).toContain(GROUPS_ACTION_LEAVE_BOT);
    expect(json).toContain(GROUPS_ACTION_ADD_BOT);
    expect(json).toContain('"dashboard_scope":"global"');
    expect(json).toContain('dash_overview_refresh');
  });

  /** ─── Overview drilldown (2026-06-10) ───
   *  Standalone and drilldown both use the unified default 5/page; `origin`
   *  is the only thing the drilldown sub-card carries — it controls the
   *  「↩ 总览」 button and is threaded through every callback so the
   *  back affordance persists across page/refresh round-trips. */
  describe('overview drilldown', () => {
    const chats12: GroupsChatInput[] = Array.from({ length: 12 }, (_, i) =>
      chat({ chatId: `oc_${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
    );

    it('default PAGE_SIZE → 5 rows/page (regression: matches standalone behavior)', () => {
      const json = buildGroupsCard(matrix(chats12), { invokerOpenId: INVOKER, locale: 'zh', page: 1 });
      const parsed = JSON.parse(json);
      const rowDivs = (parsed.elements as any[]).filter(
        (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
          && /chat-\d+/.test(e.text.content as string),
      );
      expect(rowDivs.length).toBe(5);
    });

    it('explicit pageSize=3 override → 3 rows', () => {
      const json = buildGroupsCard(matrix(chats12), { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3 });
      const parsed = JSON.parse(json);
      const rowDivs = (parsed.elements as any[]).filter(
        (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
          && /chat-\d+/.test(e.text.content as string),
      );
      expect(rowDivs.length).toBe(3);
    });

    it('oversized pageSize is clamped before button values are written', () => {
      const chats150 = Array.from({ length: 150 }, (_, i) =>
        chat({ chatId: `oc_big_${i}`, name: `big-${i}` }),
      );
      const json = buildGroupsCard(
        matrix(chats150),
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 999 },
      );
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
      const json = buildGroupsCard(
        matrix(chats12),
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' },
      );
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
      const json = buildGroupsCard(matrix(chats12), { invokerOpenId: INVOKER, locale: 'zh', page: 1 });
      const parsed = JSON.parse(json);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const backBtn = allButtons.find((b: any) => b.value?.action === 'dash_overview_refresh');
      expect(backBtn).toBeUndefined();
    });

    it('origin=overview → every child button.value carries origin (page_size omitted when == default)', () => {
      // PAGE_SIZE=5 default; drilldown passes pageSize=5 (== default), so
      // `page_size` is NOT threaded onto button.value. Origin remains the
      // canonical drilldown signal.
      const json = buildGroupsCard(
        matrix(chats12),
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' },
      );
      const parsed = JSON.parse(json);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const childButtons = allButtons.filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      expect(childButtons.length).toBeGreaterThan(0);
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
        expect(b.value.page_size).toBeUndefined();
      }
    });

    it('origin=overview + pageSize=3 (overridden) → button.value carries BOTH origin AND page_size', () => {
      const json = buildGroupsCard(
        matrix(chats12),
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3, origin: 'overview' },
      );
      const parsed = JSON.parse(json);
      const childButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      expect(childButtons.length).toBeGreaterThan(0);
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
        expect(b.value.page_size).toBe('3');
      }
    });

    it('totalPages > 2 (rows=12 with pageSize=5 → 3 pages) → select_static jump-page appears', () => {
      const json = buildGroupsCard(
        matrix(chats12),
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' },
      );
      const parsed = JSON.parse(json);
      const allActions = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const selectStatic = allActions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic).toBeDefined();
      expect(selectStatic.value.action).toBe(GROUPS_ACTION_PAGE);
      // 12 rows / 5 per page = 3 pages → 3 options.
      expect(selectStatic.options).toHaveLength(3);
      expect(selectStatic.options.map((o: any) => o.value)).toEqual(['1', '2', '3']);
    });

    it('totalPages > 50 cap → NO select_static (payload safety)', () => {
      // pageSize=1 with 60 rows → 60 pages > JUMP_PAGE_MAX_OPTIONS(50)
      const manyChats: GroupsChatInput[] = Array.from({ length: 60 }, (_, i) =>
        chat({ chatId: `oc_xx${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
      );
      const json = buildGroupsCard(
        matrix(manyChats),
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 1, origin: 'overview' },
      );
      const parsed = JSON.parse(json);
      const allActions = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const selectStatic = allActions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic).toBeUndefined();
    });
  });
});

describe('handleGroupsCardAction', () => {
  function makeDeps(over: any = {}): any {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { chats: [chat({ chatId: 'oc_h1', name: 'one' })], bots: [SELF_BOT] },
      raw: '',
    }));
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh',
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

  it('refresh → GET /__daemon/groups-matrix, returns { card } only (no toast)', async () => {
    const deps = makeDeps();
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/groups-matrix' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
  });

  it('refresh with dashboard_scope=global → GET /__daemon/groups-matrix?scope=global and keeps scope on rebuilt card', async () => {
    const deps = makeDeps();
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER, dashboard_scope: 'global' }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/groups-matrix?scope=global' });
    expect(JSON.stringify(r.card?.data)).toContain('"dashboard_scope":"global"');
  });

  it('second allowedUsers admin can refresh; rebuilt card keeps that admin as invoker', async () => {
    const secondAdmin = 'ou_second_admin';
    const deps = makeDeps({ getDashboardAdminOpenIds: () => [INVOKER, secondAdmin] });
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: secondAdmin }, secondAdmin),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(r.card?.data)).toContain(`"invoker_open_id":"${secondAdmin}"`);
  });

  it('page → renders requested page', async () => {
    const chats = Array.from({ length: 25 }, (_, i) =>
      chat({ chatId: `oc_${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
    );
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { chats, bots: [SELF_BOT] }, raw: '' })),
      } as any)),
    });
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_PAGE, invoker_open_id: INVOKER, page: '2' }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    expect(cardJson).toContain('第 2/5 页');
  });

  it('non-admin → toast `owner_only`, NO client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => 'ou_other' });
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('missing invoker → toast `not_invoker`, no client call', async () => {
    const deps = makeDeps();
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('mismatch invoker (invoker_open_id !== operator.open_id) → toast `not_invoker`', async () => {
    const deps = makeDeps();
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER }, 'ou_stranger'),
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
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('拉取群组失败');
    expect(r.toast?.content).toContain('boom');
    expect(r.card).toBeUndefined();
  });

  it('Route B returns 500 → toast `list_failed` with http_500, NO empty list card', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: async () => ({ status: 500, body: {}, raw: '' }),
      } as any)),
    });
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER }),
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
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('bad_signature');
    expect(r.toast?.content).not.toContain('http_401');
  });

  it('unknown action → toast `invalid_action`, no client call', async () => {
    const deps = makeDeps();
    const r = await handleGroupsCardAction(
      makeAction({ action: 'dash_groups_evil', invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('⚠️');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  /** ─── Overview drilldown — handler honors nav state ─── */
  it('page action via select_static (action.option, no value.page) → uses option page', async () => {
    // 12 chats, pageSize=5 → 3 pages. select_static dispatches with
    // action.option='3' but value.page is absent. Handler should fall back
    // to action.option.
    const chats = Array.from({ length: 12 }, (_, i) =>
      chat({ chatId: `oc_${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
    );
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { chats, bots: [SELF_BOT] }, raw: '' })),
      } as any)),
    });
    // Inject `action.option` on the raw envelope (not value.page).
    const envelope = {
      operator: { open_id: INVOKER },
      action: {
        option: '3',
        value: {
          action: GROUPS_ACTION_PAGE,
          invoker_open_id: INVOKER,
          origin: 'overview',
        },
      },
      context: { open_message_id: 'om_card' },
    } as any;
    const r = await handleGroupsCardAction(envelope, LARK_APP_ID, deps);
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 3/3 页');
  });

  it('refresh with origin=overview → rebuilt card has ↩ 总览 button', async () => {
    const chats = Array.from({ length: 12 }, (_, i) =>
      chat({ chatId: `oc_${String(i).padStart(4, '0')}`, name: `chat-${i}` }),
    );
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { chats, bots: [SELF_BOT] }, raw: '' })),
      } as any)),
    });
    const r = await handleGroupsCardAction(
      makeAction({
        action: GROUPS_ACTION_REFRESH,
        invoker_open_id: INVOKER,
        origin: 'overview',
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

  it('detail action → GET matrix and returns detail card', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({
          status: 200,
          body: { chats: [chat({ chatId: 'oc_detail', name: 'detail-room' })], bots: [SELF_BOT] },
          raw: '',
        })),
      } as any)),
    });
    const r = await handleGroupsCardAction(
      makeAction({ action: GROUPS_ACTION_DETAIL, invoker_open_id: INVOKER, chat_id: 'oc_detail' }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('群组管理');
    expect(cardJson).toContain('detail-room');
    expect(cardJson).toContain(GROUPS_ACTION_ROLE_OPEN);
    const card = r.card?.data as any;
    const form = card.elements.find((e: any) => e?.tag === 'form' && e?.name === 'groups_oncall_form');
    expect(form).toBeTruthy();
    expect(form.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'input', name: 'working_dir' }),
      expect.objectContaining({
        tag: 'button',
        action_type: 'form_submit',
        value: expect.objectContaining({ action: GROUPS_ACTION_ONCALL_BIND }),
      }),
    ]));
  });

  it('add_bot action → GET matrix, POST add-bots, GET fresh matrix, returns detail card', async () => {
    const otherBot: GroupsBotInput = { larkAppId: 'cli_other', botName: 'other-bot' };
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET') return { status: 200, body: { chats: [chat({
        chatId: 'oc_add',
        name: 'add-room',
        memberBots: [member({ inChat: true }), { larkAppId: 'cli_other', botName: 'other-bot', inChat: false }],
      })], bots: [SELF_BOT, otherBot] }, raw: '' };
      return { status: 200, body: { ok: true }, raw: '{"ok":true}' };
    });
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      makeAction({
        action: GROUPS_ACTION_ADD_BOT,
        invoker_open_id: INVOKER,
        chat_id: 'oc_add',
        app_id: 'cli_other',
      }),
      LARK_APP_ID,
      deps,
    );
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(requestSpy.mock.calls[1][0]).toEqual({
      method: 'POST',
      path: '/__daemon/groups/oc_add/add-bots',
      body: { larkAppIds: ['cli_other'] },
    });
    expect(JSON.stringify(r.card?.data)).toContain('群组管理');
  });

  it('leave_bot action → refuses when matrix says bot is already out, POST 0 times', async () => {
    const otherBot: GroupsBotInput = { larkAppId: 'cli_other', botName: 'other-bot' };
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { chats: [chat({
        chatId: 'oc_leave',
        memberBots: [member({ inChat: true }), { larkAppId: 'cli_other', botName: 'other-bot', inChat: false }],
      })], bots: [SELF_BOT, otherBot] },
      raw: '',
    }));
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      makeAction({
        action: GROUPS_ACTION_LEAVE_BOT,
        invoker_open_id: INVOKER,
        chat_id: 'oc_leave',
        app_id: 'cli_other',
      }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('当前状态不允许');
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('oncall_bind action → requires working_dir before POST', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { chats: [chat({ chatId: 'oc_oncall', memberBots: [member({ inChat: true, oncallChat: null })] })], bots: [SELF_BOT] },
      raw: '',
    }));
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      makeAction({
        action: GROUPS_ACTION_ONCALL_BIND,
        invoker_open_id: INVOKER,
        chat_id: 'oc_oncall',
        app_id: LARK_APP_ID,
      }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('工作目录');
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('oncall_bind action → POST bind with form working_dir and keeps global nav on rebuilt detail', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET') return {
        status: 200,
        body: { chats: [chat({ chatId: 'oc_oncall', memberBots: [member({ inChat: true, oncallChat: null })] })], bots: [SELF_BOT] },
        raw: '',
      };
      return { status: 200, body: { ok: true }, raw: '{"ok":true}' };
    });
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      {
        ...makeAction({
          action: GROUPS_ACTION_ONCALL_BIND,
          invoker_open_id: INVOKER,
          chat_id: 'oc_oncall',
          app_id: LARK_APP_ID,
          dashboard_scope: 'global',
        }),
        action: {
          value: {
            action: GROUPS_ACTION_ONCALL_BIND,
            invoker_open_id: INVOKER,
            chat_id: 'oc_oncall',
            app_id: LARK_APP_ID,
            dashboard_scope: 'global',
          },
          form_value: { working_dir: '/repo' },
        },
      } as any,
      LARK_APP_ID,
      deps,
    );
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/groups-matrix?scope=global' });
    expect(requestSpy.mock.calls[1][0]).toEqual({
      method: 'POST',
      path: '/__daemon/groups/oc_oncall/oncall/cli_test/bind',
      body: { workingDir: '/repo' },
    });
    expect(JSON.stringify(r.card?.data)).toContain('"dashboard_scope":"global"');
  });

  it('role_open action → GET role and returns role edit card with content', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.path === '/__daemon/groups-matrix') return {
        status: 200,
        body: { chats: [chat({ chatId: 'oc_role', memberBots: [member({ inChat: true, hasRole: true })] })], bots: [SELF_BOT] },
        raw: '',
      };
      return { status: 200, body: { content: 'current role' }, raw: '{"content":"current role"}' };
    });
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      makeAction({
        action: GROUPS_ACTION_ROLE_OPEN,
        invoker_open_id: INVOKER,
        chat_id: 'oc_role',
        app_id: LARK_APP_ID,
      }),
      LARK_APP_ID,
      deps,
    );
    expect(requestSpy.mock.calls[1][0]).toEqual({
      method: 'GET',
      path: '/__daemon/groups/oc_role/roles/cli_test',
    });
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('群组 Role');
    expect(cardJson).toContain('当前 Role');
    expect(cardJson).toContain('编辑 Role');
    expect(cardJson).toContain('current role');
    const card = r.card?.data as any;
    const form = card.elements.find((e: any) => e?.tag === 'form' && e?.name === 'groups_role_form');
    expect(form).toBeTruthy();
    expect(form.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tag: 'input',
        name: 'role',
        default_value: 'current role',
        input_type: 'multiline_text',
        rows: 8,
      }),
      expect.objectContaining({
        tag: 'button',
        name: 'groups_role_save',
        action_type: 'form_submit',
        value: expect.objectContaining({ action: GROUPS_ACTION_ROLE_SAVE }),
      }),
    ]));
    expect(form.elements.some((e: any) => e?.tag === 'action')).toBe(false);
  });

  it('buildGroupsRoleCard shows an explicit empty current-role state', () => {
    const json = buildGroupsRoleCard(
      chat({ chatId: 'oc_empty_role', name: 'empty-role-room' }),
      {
        botName: 'self-bot',
        larkAppId: LARK_APP_ID,
        status: 'in',
        hasRole: false,
        oncallWorkingDir: null,
        isOwnerBot: true,
        bind: { enabled: true },
        unbind: { enabled: false, reasonKey: 'not_bound' },
      },
      '',
      { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
    );
    expect(json).toContain('当前 Role');
    expect(json).toContain('当前未配置 Role');
  });

  it('role_save action → PUT role content then refetches detail', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET') return {
        status: 200,
        body: { chats: [chat({ chatId: 'oc_role', memberBots: [member({ inChat: true })] })], bots: [SELF_BOT] },
        raw: '',
      };
      return { status: 200, body: { ok: true }, raw: '{"ok":true}' };
    });
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      {
        ...makeAction({
          action: GROUPS_ACTION_ROLE_SAVE,
          invoker_open_id: INVOKER,
          chat_id: 'oc_role',
          app_id: LARK_APP_ID,
        }),
        action: {
          value: {
            action: GROUPS_ACTION_ROLE_SAVE,
            invoker_open_id: INVOKER,
            chat_id: 'oc_role',
            app_id: LARK_APP_ID,
          },
          form_value: { role: 'new role' },
        },
      } as any,
      LARK_APP_ID,
      deps,
    );
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(requestSpy.mock.calls[1][0]).toEqual({
      method: 'PUT',
      path: '/__daemon/groups/oc_role/roles/cli_test',
      body: { content: 'new role' },
    });
    expect(JSON.stringify(r.card?.data)).toContain('群组管理');
  });

  it('role_save action accepts input_value callback fallback', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET') return {
        status: 200,
        body: { chats: [chat({ chatId: 'oc_role', memberBots: [member({ inChat: true })] })], bots: [SELF_BOT] },
        raw: '',
      };
      return { status: 200, body: { ok: true }, raw: '{"ok":true}' };
    });
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    await handleGroupsCardAction(
      {
        ...makeAction({
          action: GROUPS_ACTION_ROLE_SAVE,
          invoker_open_id: INVOKER,
          chat_id: 'oc_role',
          app_id: LARK_APP_ID,
        }),
        action: {
          value: {
            action: GROUPS_ACTION_ROLE_SAVE,
            invoker_open_id: INVOKER,
            chat_id: 'oc_role',
            app_id: LARK_APP_ID,
          },
          input_value: 'role from input behavior',
        },
      } as any,
      LARK_APP_ID,
      deps,
    );
    expect(requestSpy.mock.calls[1][0]).toEqual({
      method: 'PUT',
      path: '/__daemon/groups/oc_role/roles/cli_test',
      body: { content: 'role from input behavior' },
    });
  });

  it('role_delete action → DELETE role then refetches detail', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET') return {
        status: 200,
        body: { chats: [chat({ chatId: 'oc_role', memberBots: [member({ inChat: true, hasRole: true })] })], bots: [SELF_BOT] },
        raw: '',
      };
      return { status: 200, body: { ok: true }, raw: '{"ok":true}' };
    });
    const deps = makeDeps({ createClient: vi.fn(() => ({ request: requestSpy } as any)) });
    const r = await handleGroupsCardAction(
      makeAction({
        action: GROUPS_ACTION_ROLE_DELETE,
        invoker_open_id: INVOKER,
        chat_id: 'oc_role',
        app_id: LARK_APP_ID,
      }),
      LARK_APP_ID,
      deps,
    );
    expect(requestSpy.mock.calls[1][0]).toEqual({
      method: 'DELETE',
      path: '/__daemon/groups/oc_role/roles/cli_test',
      body: undefined,
    });
    expect(JSON.stringify(r.card?.data)).toContain('群组管理');
  });
});
