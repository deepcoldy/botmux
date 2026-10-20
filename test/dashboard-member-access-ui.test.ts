import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberAccessSection } from '../src/dashboard/web/member-access-section.js';
import { toast } from '../src/dashboard/web/toast.js';
import type { GroupChat, GroupMemberBot } from '../src/dashboard/web/groups-api.js';
import type { GroupMemberDisplay } from '../src/dashboard/web/roles.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

const tr = (key: string, values?: Record<string, unknown>) => {
  let result = key;
  for (const [name, value] of Object.entries(values ?? {})) result = result.replace(`{${name}}`, String(value));
  return result;
};

type FetchCall = { url: string; method: string; body: any };

type RouterState = {
  membersByApp: Record<string, GroupMemberDisplay[]>;
  blockedByApp: Record<string, { raw: string[]; resolved: string[] }>;
  grantResult: { status: number; body: any };
  calls: FetchCall[];
};

function jsonResponse(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function installFetch(state: RouterState): void {
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    let parsedBody: any = null;
    if (init?.body) parsedBody = JSON.parse(String(init.body));
    state.calls.push({ url: target, method, body: parsedBody });

    const appMatch = target.match(/\/api\/(?:groups|bots)\/([^/]+)\//);
    const appId = appMatch?.[1] ?? 'cli_a';

    if (target.endsWith('/members-display') && method === 'GET') {
      return jsonResponse(200, { members: state.membersByApp[appId] ?? [] });
    }
    if (target.endsWith('/blocked-users') && method === 'GET') {
      const blocked = state.blockedByApp[appId] ?? { raw: [], resolved: [] };
      return jsonResponse(200, { ok: true, ...blocked });
    }
    if (target.endsWith('/blocked-users') && method === 'PUT') {
      if (parsedBody.removeOpenIds) {
        // 模拟后端定向解除：按 open_id 从 raw/resolved 中剔除（含别名形态）。
        const removed = new Set<string>(parsedBody.removeOpenIds);
        const current = state.blockedByApp[appId] ?? { raw: [], resolved: [] };
        const next = {
          raw: current.raw.filter((e: string) => !removed.has(e)),
          resolved: (current.resolved ?? []).filter((o: string) => !removed.has(o)),
        };
        state.blockedByApp[appId] = next;
        return jsonResponse(200, { ok: true, ...next });
      }
      state.blockedByApp[appId] = { raw: parsedBody.entries, resolved: parsedBody.entries };
      return jsonResponse(200, { ok: true, raw: parsedBody.entries, resolved: parsedBody.entries });
    }
    if (target.endsWith('/grants/chat') && method === 'POST') {
      if (parsedBody.operation === 'readback') {
        return jsonResponse(200, {
          ok: true,
          subjects: parsedBody.subjectOpenIds.map((openId: string) => ({
            subjectOpenId: openId,
            chatGrantActive: openId === 'ou_u1',
            changed: false,
            grantsTalk: openId === 'ou_u1',
            grantsOperate: false,
          })),
        });
      }
      return jsonResponse(state.grantResult.status, state.grantResult.body);
    }
    if (target.endsWith('/chat-group-grant') && method === 'PUT') {
      return jsonResponse(200, { ok: true, created: true });
    }
    return jsonResponse(404, { ok: false, error: 'unexpected_route' });
  }) as any;
}

const MEMBERS: GroupMemberDisplay[] = [
  { openId: 'ou_u1', name: 'Alice', memberType: 'user' },
  { openId: 'ou_u2', name: 'Bob', memberType: 'user' },
  { openId: 'ou_b1', name: 'Bot X', memberType: 'bot' },
];

const IN_CHAT: GroupMemberBot[] = [
  { larkAppId: 'cli_a', botName: 'Bot A', inChat: true },
  { larkAppId: 'cli_b', botName: 'Bot B', inChat: true },
];

const CHAT: GroupChat = { chatId: 'oc_test', memberBots: IN_CHAT };

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function renderSection(members: GroupMemberBot[] = IN_CHAT): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(MemberAccessSection, {
      chat: CHAT,
      members,
      tr,
    }));
  });
  return renderer;
}

async function open(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ 'data-member-access-toggle': true })
      .props.onToggle({ currentTarget: { open: true } });
  });
  await settle();
}

function makeState(overrides?: Partial<RouterState>): RouterState {
  return {
    membersByApp: { cli_a: MEMBERS, cli_b: [{ openId: 'ou_b_ns', name: 'Beta-ns', memberType: 'user' }] },
    blockedByApp: { cli_a: { raw: [], resolved: [] } },
    grantResult: {
      status: 200,
      body: {
        ok: true,
        subjects: [{
          subjectOpenId: 'ou_u2', chatGrantActive: true, changed: true,
          grantsTalk: true, grantsOperate: false,
        }],
      },
    },
    calls: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemberAccessSection', () => {
  it('shows the empty state when no bot is in chat and performs no requests', () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection([]);
    expect(JSON.stringify(renderer.toJSON())).toContain('grantAdmin.noBot');
    expect(state.calls).toHaveLength(0);
  });

  it('defaults to the first in-chat bot, batches readback, and groups users vs bots', async () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    expect(renderer.root.findByProps({ 'data-action': 'bot-switch' }).props.value).toBe('cli_a');
    expect(renderer.root.findAllByProps({ 'data-member-group': 'users' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-member-group': 'bots' })).toHaveLength(1);
    const rows = renderer.root.findAllByProps({ 'data-action': 'member-select' });
    expect(rows.map((r: any) => r.props.value)).toEqual(['ou_u1', 'ou_u2', 'ou_b1']);

    const displayCalls = state.calls.filter(c => c.url.endsWith('/members-display'));
    expect(displayCalls[0]?.url).toContain('/api/groups/cli_a/oc_test/members-display');
    // Readback for 3 members is one <=50 batch.
    const readbacks = state.calls.filter(c => c.body?.operation === 'readback');
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.body.subjectOpenIds).toHaveLength(3);
    // Alice is granted per the readback fixture → granted tag rendered.
    expect(JSON.stringify(renderer.toJSON())).toContain('grantAdmin.grantedTag');
  });

  it('searches across names only within the selected bot namespace', async () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'member-search' })
        .props.onChange({ currentTarget: { value: 'ali' } });
    });
    const rows = renderer.root.findAllByProps({ 'data-action': 'member-select' });
    expect(rows.map((r: any) => r.props.value)).toEqual(['ou_u1']);
  });

  it('grants selected members with quota/duration wire options', async () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    const grantButton = renderer.root.findByProps({ 'data-action': 'grant-selected' });
    expect(grantButton.props.disabled).toBe(true);

    const checkboxes = renderer.root.findAllByProps({ 'data-action': 'member-select' });
    await act(async () => {
      checkboxes.find((c: any) => c.props.value === 'ou_u2')!
        .props.onChange({ currentTarget: { checked: true } });
    });
    expect(renderer.root.findByProps({ 'data-action': 'grant-selected' }).props.disabled).toBe(false);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'grant-selected' }).props.onClick();
    });
    await settle();

    const grants = state.calls.filter(c => c.body?.operation === 'grant');
    expect(grants).toHaveLength(1);
    expect(grants[0]?.url).toBe('/api/bots/cli_a/grants/chat');
    expect(grants[0]?.method).toBe('POST');
    expect(grants[0]?.body).toMatchObject({
      operation: 'grant',
      receiverLarkAppId: 'cli_a',
      chatId: 'oc_test',
      subjectOpenIds: ['ou_u2'],
      quota: '3',
      durationMs: '3600000',
    });
    expect(toast).toHaveBeenCalledWith('grantAdmin.grantOk', expect.objectContaining({ kind: 'success' }));
  });

  it('intercepts batches over 50 subjects without sending a grant', async () => {
    const many: GroupMemberDisplay[] = Array.from({ length: 51 }, (_, i) => ({
      openId: `ou_p${i}`,
      name: `P${i}`,
      memberType: 'user',
    }));
    const state = makeState({
      membersByApp: { cli_a: many, cli_b: [] },
      grantResult: { status: 500, body: { ok: false, error: 'should_not_reach' } },
    });
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);
    await settle(8);

    for (const checkbox of renderer.root.findAllByProps({ 'data-action': 'member-select' })) {
      await act(async () => {
        (checkbox as any).props.onChange({ currentTarget: { checked: true } });
      });
    }
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'grant-selected' }).props.onClick();
    });
    await settle();

    expect(state.calls.filter(c => c.body?.operation === 'grant')).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith('grantAdmin.tooMany', expect.objectContaining({ kind: 'warning' }));
  });

  it('reports 409 subject_not_current_chat_bot as a not-in-chat message, not network error', async () => {
    const state = makeState({
      grantResult: {
        status: 409,
        body: {
          ok: false,
          error: 'subject_not_current_chat_bot',
          invalidSubjectOpenIds: ['ou_u2'],
        },
      },
    });
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    await act(async () => {
      renderer.root.findAllByProps({ 'data-action': 'member-select' })
        .find((c: any) => c.props.value === 'ou_u2')!
        .props.onChange({ currentTarget: { checked: true } });
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'grant-selected' }).props.onClick();
    });
    await settle();

    expect(toast).toHaveBeenCalledWith(
      'grantAdmin.notInChat',
      expect.objectContaining({ kind: 'warning' }),
    );
  });

  it('blocks and unblocks a row via fresh GET + full PUT of raw entries', async () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    const block = renderer.root.findByProps({ 'data-member-row': 'ou_u2' })
      .findAllByType('button')
      .find(b => b.props['data-action'] === 'row-block');
    await act(async () => { block!.props.onClick(); });
    await settle();

    const blockPuts = state.calls.filter(c => c.url.endsWith('/blocked-users') && c.method === 'PUT');
    expect(blockPuts.at(-1)?.body).toEqual({ entries: ['ou_u2'] });
    expect(toast).toHaveBeenCalledWith('blocked.rowBlockOk', expect.any(Object));
  });

  it('unblocks via the identity-based removeOpenIds route', async () => {
    const state = makeState({
      blockedByApp: { cli_a: { raw: ['ou_u2', 'keep@example.com'], resolved: ['ou_u2'] } },
    });
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    const unblock = renderer.root.findByProps({ 'data-member-row': 'ou_u2' })
      .findAllByType('button')
      .find(b => b.props['data-action'] === 'row-unblock');
    expect(unblock).toBeTruthy();
    await act(async () => { unblock!.props.onClick(); });
    await settle();

    const put = state.calls.filter(c => c.url.endsWith('/blocked-users') && c.method === 'PUT').at(-1);
    // 不再由前端按 ou_ 直值过滤 raw：整条解除交给后端按身份反查。
    expect(put?.body).toEqual({ removeOpenIds: ['ou_u2'] });
    expect(toast).toHaveBeenCalledWith('blocked.rowUnblockOk', expect.any(Object));
  });

  it('unblocks a row whose raw entry was written as an email alias (no ou_ literal exists)', async () => {
    const state = makeState({
      blockedByApp: { cli_a: { raw: ['bob@example.com'], resolved: ['ou_u2'] } },
    });
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    const unblock = renderer.root.findByProps({ 'data-member-row': 'ou_u2' })
      .findAllByType('button')
      .find(b => b.props['data-action'] === 'row-unblock');
    await act(async () => { unblock!.props.onClick(); });
    await settle();

    const put = state.calls.filter(c => c.url.endsWith('/blocked-users') && c.method === 'PUT').at(-1);
    // 旧实现会发 {entries:['bob@example.com']}（过滤不掉，假成功）；现在只发
    // 身份解除请求，由后端反查 email→ou_ 并剔除别名 raw 条目。
    expect(put?.body).toEqual({ removeOpenIds: ['ou_u2'] });
    expect(toast).toHaveBeenCalledWith('blocked.rowUnblockOk', expect.any(Object));
  });

  it('toggles whole-chat grant with no state echo available', async () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'whole-grant' }).props.onClick();
    });
    await settle();
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'whole-revoke' }).props.onClick();
    });
    await settle();

    const calls = state.calls.filter(c => c.url.endsWith('/chat-group-grant'));
    expect(calls.map(c => c.body)).toEqual([
      { chatId: 'oc_test', granted: true },
      { chatId: 'oc_test', granted: false },
    ]);
    expect(toast).toHaveBeenCalledWith('grantAdmin.wholeGrantOk', expect.any(Object));
    expect(toast).toHaveBeenCalledWith('grantAdmin.wholeRevokeOk', expect.any(Object));
  });

  it('reloads every namespace when switching bot viewpoint (never reuses ou_ across apps)', async () => {
    const state = makeState();
    installFetch(state);
    const renderer = renderSection();
    await open(renderer);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'bot-switch' })
        .props.onChange({ currentTarget: { value: 'cli_b' } });
    });
    await settle(8);

    const displayCalls = state.calls.filter(c => c.url.endsWith('/members-display'));
    expect(displayCalls.at(-1)?.url).toContain('/api/groups/cli_b/oc_test/members-display');
    const rows = renderer.root.findAllByProps({ 'data-action': 'member-select' });
    expect(rows.map((r: any) => r.props.value)).toEqual(['ou_b_ns']);
  });
});
