/**
 * PR3 `/dashboard groups` slice 1 — card builder + callback handler tests.
 *
 * Single-column matrix (post per-bot scope): the upstream Route B endpoint
 * filters `bots` and `chats` so the rendered card sees ONLY the caller's
 * bot. This file mirrors sessions-card.test.ts but exercises the
 * groups-specific count summary, escaping, pagination, and handler arms.
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
  handleGroupsCardAction,
  GROUPS_ACTION_PAGE,
  GROUPS_ACTION_REFRESH,
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
    expect(json).toContain('Dashboard 群矩阵');
    expect(json).toContain('_当前没有群_');
    // No pagination buttons (single page when empty).
    expect(json).not.toContain('上一页');
    expect(json).not.toContain('下一页');
    // Refresh button always present.
    expect(json).toContain(GROUPS_ACTION_REFRESH);
  });

  it('count summary "总群数 N · 已加入 M · 未加入 K"', () => {
    const chats: GroupsChatInput[] = [
      chat({ chatId: 'oc_a1', name: 'in-1', memberBots: [member({ inChat: true })] }),
      chat({ chatId: 'oc_a2', name: 'in-2', memberBots: [member({ inChat: true })] }),
      chat({ chatId: 'oc_b1', name: 'out-1', memberBots: [member({ inChat: false })] }),
      chat({ chatId: 'oc_c1', name: 'unknown-1', memberBots: [member({ inChat: undefined, status: 'unknown' })] }),
    ];
    const json = buildGroupsCard(matrix(chats), baseOpts);
    expect(json).toContain('总群数 4');
    expect(json).toContain('已加入 2');
    expect(json).toContain('未加入 2');
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
    expect(json).toContain('上一页');
    expect(json).toContain('下一页');
    expect(json).toContain('第 2/5 页');
    // prev → page=1, next → page=3
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');

    const findPagerButtons = (j: string): { prev: any; next: any } => {
      const parsed = JSON.parse(j);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const actions = actionRow.actions as any[];
      const prev = actions.find((a: any) => String(a.text?.content ?? '').includes('上一页'));
      const next = actions.find((a: any) => String(a.text?.content ?? '').includes('下一页'));
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

  /** ─── Overview drilldown (2026-06-10) ───
   *  Standalone and drilldown both use the unified default 5/page; `origin`
   *  is the only thing the drilldown sub-card carries — it controls the
   *  「🔙 返回总览」 button and is threaded through every callback so the
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

    it('origin=overview → footer renders "🔙 返回总览" with action=dash_overview_refresh', () => {
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
      expect(String(backBtn.text?.content ?? '')).toContain('返回总览');
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

  it('non-owner → toast `owner_only`, NO client call', async () => {
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
    expect(r.toast?.content).toContain('拉取群矩阵失败');
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

  it('refresh with origin=overview → rebuilt card has 返回总览 button', async () => {
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
    expect(cardJson).toContain('返回总览');
  });
});
