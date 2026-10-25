/**
 * 决策看板页面的交互：
 *   - 提交确认框：取消勾选的项留作草稿；同一次点击的重试（网络错误）沿用同一个 nonce，
 *     服务端明确拒绝后下一次点击换新 nonce；投递失败给出重投与去配置的入口。
 *   - 详情页：打开即标记已读；连续输入只在停顿后存一次草稿，baseRev 取当前看到的版本，
 *     存完「管家改过」的提示消失；再点一次已选的选项 = 不选。
 *   - Bot 配置 · 管家：开关立刻保存且不夹带没点保存的提示词；替换预置但没写内容不发请求；
 *     群列表只列本 Bot 在的群。
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemDetailView, SubmitDialog } from '../src/dashboard/web/decision-board-page.js';
import { StewardSection } from '../src/dashboard/web/bot-defaults-page.js';
import { DECISION_BOARD_CHANGED_EVENT, type BoardDetailResponse, type BoardItem } from '../src/dashboard/web/decision-board-model.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { SearchableGroupPicker } from '../src/dashboard/web/searchable-group-picker.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

const zh = createDashboardTranslator('zh');

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

let renderer: TestRenderer.ReactTestRenderer | undefined;
let routes: Route;
let fetcher: ReturnType<typeof vi.fn>;
let dispatched: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function calls(method: string, pathPart: string): Array<{ url: string; body: any }> {
  return fetcher.mock.calls
    .filter(([url, init]) => String(url).includes(pathPart) && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([url, init]) => ({ url: String(url), body: (init as RequestInit).body ? JSON.parse(String((init as RequestInit).body)) : undefined }));
}

const text = () => JSON.stringify(renderer!.toJSON());
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const buttonByText = (label: string) => renderer!.root.find(n => n.type === 'button' && textOf(n).includes(label));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dispatched = [];
  vi.stubGlobal('document', { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event: Event) => { dispatched.push(event.type); return true; },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  routes = () => json({ ok: false, error: 'not_found' }, 404);
  fetcher = vi.fn(async (url: string, init: RequestInit = {}) => routes(String(url), init));
  vi.stubGlobal('fetch', fetcher);
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function boardItem(seq: number, patch: Partial<BoardItem> = {}): BoardItem {
  return {
    seq, title: `事项 ${seq}`, state: 'decide', stage: '在审', question: '恢复同机 bot 的 operate 权限吗？',
    options: [{ key: 'A', label: '恢复', effect: '默认开' }, { key: 'B', label: '只信同 owner' }],
    recommend: 'A', recommendReason: '改动最小', rev: 5, createdAt: 1, updatedAt: 2, stateAt: 2, ...patch,
  };
}

function detail(seq: number, patch: Partial<BoardDetailResponse> = {}): BoardDetailResponse {
  return {
    item: boardItem(seq), links: [], events: [], files: [], pendingDecisions: [],
    steward: { enabled: true, ready: true, chatId: 'oc_s' }, drafts: [], ...patch,
  };
}

describe('submit dialog', () => {
  function serveDrafts(): void {
    const details: Record<string, BoardDetailResponse> = {
      '/items/1': detail(1, { draft: { seq: 1, author: 'owner', choice: 'B', text: '先查删除原因', fileIds: [], baseRev: 5, updatedAt: 11 } }),
      '/items/2': detail(2, { draft: { seq: 2, author: 'owner', choice: 'A', text: '开关放 Bot 配置页', fileIds: ['f1'], baseRev: 4, updatedAt: 22 } }),
      // 草稿已在别处提交：不进确认框。
      '/items/3': detail(3),
    };
    const base = routes;
    routes = (url, init) => {
      const hit = Object.keys(details).find(k => url.endsWith(`/api/decision-board/cli_a${k}`));
      if (hit && (init.method ?? 'GET') === 'GET') return json({ ok: true, ...details[hit] });
      return base(url, init);
    };
  }

  async function open(onClose = vi.fn()) {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SubmitDialog, { appId: 'cli_a', seqs: [1, 2, 3], firstSeq: 2, onClose }));
    });
    await flush();
    return onClose;
  }

  it('leaves unchecked items as drafts and reuses the nonce when retrying after a network error', async () => {
    serveDrafts();
    let attempt = 0;
    const base = routes;
    routes = (url, init) => {
      if (url.endsWith('/submit') && init.method === 'POST') {
        attempt += 1;
        if (attempt === 1) throw new TypeError('network down');
        return json({
          ok: true, duplicate: false, decisions: [],
          batch: { id: 8, author: 'local', createdAt: 1, delivery: 'failed', attempts: 1, error: 'steward_chat_missing' },
        });
      }
      return base(url, init);
    };
    await open();

    const boxes = renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox');
    expect(boxes).toHaveLength(2);
    // 当前详情页那一项（#2）排第一。
    expect(text().indexOf('事项 2')).toBeLessThan(text().indexOf('事项 1'));
    act(() => boxes[1]!.props.onChange({ currentTarget: { checked: false } }));

    await act(async () => { buttonByText(zh('decisionBoard.confirmSubmit', { n: 1 })).props.onClick(); });
    expect(text()).toContain('network down');
    await act(async () => { buttonByText(zh('decisionBoard.confirmSubmit', { n: 1 })).props.onClick(); });

    const posts = calls('POST', '/api/decision-board/cli_a/submit');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.items).toEqual([{ seq: 2, draftUpdatedAt: 22 }]);
    expect(typeof posts[0]!.body.nonce).toBe('string');
    expect(posts[1]!.body).toEqual(posts[0]!.body);

    expect(text()).toContain(zh('decisionBoard.resultFailed', { id: 8, error: zh('decisionBoard.errStewardChatMissing') }));
    expect(renderer!.root.find(n => n.type === 'a' && n.props.href === '#/bot-defaults?bot=cli_a&section=steward')).toBeTruthy();
    expect(buttonByText(zh('decisionBoard.redeliver'))).toBeTruthy();
  });

  it('uses a fresh nonce after the server answered with a rejection', async () => {
    serveDrafts();
    const base = routes;
    routes = (url, init) => {
      if (url.endsWith('/submit') && init.method === 'POST') {
        return json({ ok: false, error: 'draft_changed', message: '#2 的草稿在别处改过，刷新后再提交' }, 409);
      }
      return base(url, init);
    };
    await open();
    await act(async () => { buttonByText(zh('decisionBoard.confirmSubmit', { n: 2 })).props.onClick(); });
    expect(text()).toContain('#2 的草稿在别处改过');
    await act(async () => { buttonByText(zh('decisionBoard.confirmSubmit', { n: 2 })).props.onClick(); });
    const posts = calls('POST', '/submit');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.nonce).not.toBe(posts[0]!.body.nonce);
    expect(posts[0]!.body.items).toEqual([{ seq: 2, draftUpdatedAt: 22 }, { seq: 1, draftUpdatedAt: 11 }]);
  });
});

describe('item detail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let savedDraft: any = { seq: 31, author: 'owner', choice: 'A', text: '旧想法', fileIds: [], baseRev: 4, updatedAt: 100 };
    routes = (url, init) => {
      const method = init.method ?? 'GET';
      if (url.endsWith('/api/decision-board/cli_a/items/31') && method === 'GET') {
        return json({
          ok: true,
          ...detail(31, {
            draft: savedDraft,
            drafts: [{ seq: 31, updatedAt: 100 }, { seq: 12, updatedAt: 50 }],
            events: [{ id: 1, seq: 31, at: 1, actor: 'owner', kind: 'decision', text: '选 B', fileIds: ['f1'], batchId: 7 }],
          }),
        });
      }
      if (url.endsWith('/items/31/seen') && method === 'POST') return json({ ok: true });
      if (url.endsWith('/items/31/draft') && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        savedDraft = { seq: 31, author: 'owner', ...(body.choice ? { choice: body.choice } : {}), text: body.text, fileIds: body.fileIds, baseRev: body.baseRev, updatedAt: 200 };
        return json({ ok: true, draft: savedDraft });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
  });

  async function openDetail() {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq: 31 }));
    });
    await flush();
  }

  const textarea = () => renderer!.root.findByType('textarea');
  const radio = (key: string) => renderer!.root.find(n => n.type === 'input' && n.props.type === 'radio' && n.props.value === key);

  it('marks the item seen, warns about the stale draft and offers to submit it with the other draft', async () => {
    await openDetail();
    expect(calls('POST', '/items/31/seen')).toHaveLength(1);
    expect(text()).toContain(zh('decisionBoard.staleDraft'));
    expect(buttonByText(zh('decisionBoard.submitThisAndOthers', { n: 1 })).props.disabled).toBe(false);
    expect(textarea().props.value).toBe('旧想法');
    expect(radio('A').props.checked).toBe(true);
    // 历史里的附图指向看板文件接口。
    expect(renderer!.root.find(n => n.type === 'img' && n.props.src === '/api/decision-board/cli_a/files/f1')).toBeTruthy();
  });

  it('saves the draft once after typing stops, against the version on screen', async () => {
    await openDetail();
    act(() => textarea().props.onChange({ currentTarget: { value: '新' } }));
    act(() => textarea().props.onChange({ currentTarget: { value: '新的决定' } }));
    expect(calls('PUT', '/items/31/draft')).toHaveLength(0);
    expect(text()).toContain(zh('decisionBoard.savePending'));

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const puts = calls('PUT', '/items/31/draft');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ choice: 'A', text: '新的决定', fileIds: [], baseRev: 5 });
    expect(text()).toContain(zh('decisionBoard.saveSaved'));
    expect(text()).not.toContain(zh('decisionBoard.staleDraft'));
  });

  it('clears the choice when the selected option is clicked again', async () => {
    await openDetail();
    act(() => radio('A').props.onClick());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(radio('A').props.checked).toBe(false);
    expect(calls('PUT', '/items/31/draft').at(-1)!.body).toEqual({ text: '旧想法', fileIds: [], baseRev: 5 });
  });
});

describe('Bot config steward section', () => {
  const groups = {
    bots: [],
    chats: [
      { chatId: 'oc_1', name: '你和管家', memberBots: [{ larkAppId: 'cli_s', inChat: true }] },
      { chatId: 'oc_2', name: '话题群', chatMode: 'topic', memberBots: [{ larkAppId: 'cli_s', inChat: true }] },
      { chatId: 'oc_3', name: '别的 Bot 的群', memberBots: [{ larkAppId: 'cli_other', inChat: true }] },
    ],
  };

  function serve(putResponse?: (body: any) => Response): void {
    routes = (url, init) => {
      const method = init.method ?? 'GET';
      if (url.startsWith('/api/groups') && method === 'GET') return json(groups);
      if (url.endsWith('/api/decision-board/cli_s/guide')) return json({ ok: true, preset: '预置规则正文', effective: '生效规则正文' });
      if (url.endsWith('/api/bots/cli_s/steward') && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        return putResponse ? putResponse(body) : json({ ok: true, steward: body.steward });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
  }

  async function render(steward: BotDefaultsRow['steward'], patchBot = vi.fn()) {
    const bot = { larkAppId: 'cli_s', steward } as BotDefaultsRow;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(StewardSection, { bot, patchBot, active: true }));
    });
    await flush();
    return patchBot;
  }

  it('saves the switch immediately with the saved instructions, not the unsaved text box', async () => {
    serve();
    const patchBot = await render({ enabled: true, chatId: 'oc_1', guideText: '规则A' });
    expect(text()).toContain('预置规则正文');
    // 只列本 Bot 在的群。
    expect(renderer!.root.findByType(SearchableGroupPicker).props.groups.map((g: { chatId: string }) => g.chatId)).toEqual(['oc_1', 'oc_2']);

    act(() => renderer!.root.findByType('textarea').props.onChange({ currentTarget: { value: '规则B（没点保存）' } }));
    const toggle = renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward');
    await act(async () => { toggle.props.onChange({ currentTarget: { checked: false } }); });

    expect(calls('PUT', '/api/bots/cli_s/steward').map(c => c.body)).toEqual([{ steward: { enabled: false, chatId: 'oc_1', guideText: '规则A' } }]);
    expect(patchBot).toHaveBeenCalledWith('cli_s', { steward: { enabled: false, chatId: 'oc_1', guideText: '规则A' } });
    expect(dispatched).toContain(DECISION_BOARD_CHANGED_EVENT);
  });

  it('"add the steward to new chats" is on by default; turning it off saves false, turning it back on drops the field', async () => {
    serve();
    await render({ enabled: true, chatId: 'oc_1', guideText: '规则A' });
    const autoJoin = () => renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward-auto-join');
    expect(autoJoin().props.checked).toBe(true);
    expect(text()).toContain(zh('botDefaults.stewardAutoJoin'));

    await act(async () => { autoJoin().props.onChange({ currentTarget: { checked: false } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body)
      .toEqual({ steward: { enabled: true, chatId: 'oc_1', guideText: '规则A', autoJoinNewGroups: false } });
    expect(autoJoin().props.checked).toBe(false);

    await act(async () => { autoJoin().props.onChange({ currentTarget: { checked: true } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1', guideText: '规则A' } });
  });

  it('"also add it to chats with only you and one bot" is off by default, saves true, and is greyed out while auto-join is off', async () => {
    serve();
    await render({ enabled: true, chatId: 'oc_1' });
    const p2p = () => renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward-auto-join-solo');
    expect(p2p().props.checked).toBe(false);
    expect(p2p().props.disabled).toBe(false);
    await act(async () => { p2p().props.onChange({ currentTarget: { checked: true } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1', autoJoinSoloGroups: true } });

    const autoJoin = renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward-auto-join');
    await act(async () => { autoJoin.props.onChange({ currentTarget: { checked: false } }); });
    expect(p2p().props.disabled).toBe(true);
  });

  it('the auto-join switch only shows while the bot is a steward, and a saved "off" survives turning the steward off and on', async () => {
    serve();
    await render({ enabled: false, autoJoinNewGroups: false });
    expect(renderer!.root.findAll(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward-auto-join')).toHaveLength(0);
    const toggle = renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward');
    await act(async () => { toggle.props.onChange({ currentTarget: { checked: true } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, autoJoinNewGroups: false } });
  });

  it('saves the chosen chat and points out topic groups', async () => {
    serve();
    await render({ enabled: true, chatId: 'oc_1' });
    await act(async () => { renderer!.root.findByType(SearchableGroupPicker).props.onChange('oc_2'); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_2' } });
    expect(text()).toContain(zh('botDefaults.stewardChatTopic'));
  });

  it('does not send "replace" without text, and shows the server reason on a rejected save', async () => {
    serve(() => json({ ok: false, error: 'invalid_steward: steward.chatId 必须是 oc_ 开头的群 ID' }, 400));
    await render({ enabled: true, chatId: 'oc_1' });
    const replace = renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'radio')[1]!;
    act(() => replace.props.onChange());
    await act(async () => { buttonByText(zh('botDefaults.stewardGuideSave')).props.onClick(); });
    expect(calls('PUT', '/api/bots/cli_s/steward')).toHaveLength(0);
    expect(text()).toContain(zh('botDefaults.stewardGuideReplaceEmpty'));

    act(() => renderer!.root.findByType('textarea').props.onChange({ currentTarget: { value: '只汇报' } }));
    await act(async () => { buttonByText(zh('botDefaults.stewardGuideSave')).props.onClick(); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1', guideMode: 'replace', guideText: '只汇报' } });
    expect(text()).toContain('steward.chatId 必须是 oc_ 开头的群 ID');
    expect(text()).not.toContain('invalid_steward');
  });
});
