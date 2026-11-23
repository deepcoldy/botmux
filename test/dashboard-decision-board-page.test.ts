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
import { BoardSummaryView, ItemDetailView, SubmitDialog, resetBoardNavMemory } from '../src/dashboard/web/decision-board-page.js';
import { StewardSection } from '../src/dashboard/web/bot-defaults-page.js';
import { BOARD_NAV_STORAGE_KEY, DECISION_BOARD_CHANGED_EVENT, type BoardDetailResponse, type BoardItem } from '../src/dashboard/web/decision-board-model.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { SearchableGroupPicker } from '../src/dashboard/web/searchable-group-picker.js';
import { ConfirmModalRoot } from '../src/dashboard/web/confirm-modal.js';
import { pendingLeavePrompt } from '../src/dashboard/web/leave-guard.js';
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

describe('close item UI', () => {
  beforeEach(() => {
    resetBoardNavMemory();
    vi.stubGlobal('location', { hash: '#/board/cli_a/31', pathname: '/', search: '' });
    vi.stubGlobal('history', { state: null, replaceState: () => {} });
  });
  const action = (name: string) => renderer!.root.find(n => n.type === 'button' && n.props['data-action'] === name);
  function serve(includeClosed = false) {
    let closed = false;
    let draft: any = { seq: 31, author: 'owner', choice: 'B', text: '草稿不能投递', fileIds: [], baseRev: 5, updatedAt: 1 };
    routes = (url, init) => {
      if (url.endsWith('/boards')) return json({ ok: true, boards: [{ larkAppId: 'cli_a', botName: '管家', online: true, steward: { enabled: true, ready: true } }] });
      if (url.includes('/items?')) return json({ ok: true, view: 'decide', steward: { enabled: true, ready: true }, counts: { decide: closed ? 0 : 1, active: 0, all: 1 },
        items: closed && !includeClosed ? [] : [{ ...boardItem(31, { state: closed ? 'closed' : 'decide' }), links: [], hasDraft: !closed, pendingDecisions: 0, unseen: false }], drafts: closed ? [] : [{ seq: 31, updatedAt: 1 }], batches: [] });
      if (url.endsWith('/items/31')) return json({ ok: true, ...detail(31, { item: boardItem(31, { state: closed ? 'closed' : 'decide' }), draft,
        events: closed ? [{ id: 1, seq: 31, at: 1, actor: 'owner', kind: 'state', text: '本人关闭（无需再拍板）', fileIds: [] }] : [] }) });
      if (url.endsWith('/seen')) return json({ ok: true });
      if (url.endsWith('/draft')) { draft = { ...draft, ...JSON.parse(String(init.body)) }; return json({ ok: true, draft }); }
      if (url.endsWith('/close-in-chat')) { closed = true; draft = undefined; return json({ ok: true }); }
      return json({ ok: false, error: 'unexpected' }, 404);
    };
  }
  it('detail requires confirmation, cancellation does nothing, closure refreshes and disables old decision editor without submit', async () => {
    serve();
    await act(async () => { renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq: 31 })); });
    await flush();
    expect(action('close-in-chat').children).toContain('关闭此项');
    await act(async () => action('close-in-chat').props.onClick());
    expect(text()).toContain(zh('decisionBoard.closeInChatBody'));
    expect(calls('POST', '/close-in-chat')).toHaveLength(0);
    await act(async () => buttonByText(zh('decisionBoard.cancel')).props.onClick());
    expect(calls('POST', '/close-in-chat')).toHaveLength(0);
    act(() => renderer!.root.findByType('textarea').props.onChange({ currentTarget: { value: '未保存，也不能投递' } }));
    await act(async () => action('close-in-chat').props.onClick());
    await act(async () => action('confirm-close-in-chat').props.onClick());
    await flush();
    expect(calls('POST', '/close-in-chat').map(c => c.body)).toEqual([{ baseRev: 5, confirmed: true }]);
    expect(calls('POST', '/submit')).toEqual([]);
    expect(calls('PUT', '/draft')).toHaveLength(1);
    expect(text()).toContain('本人关闭（无需再拍板）');
    expect(text()).toContain(zh('decisionBoard.closeInChatDone'));
    expect(renderer!.root.findAllByType('textarea')).toEqual([]);
    expect(renderer!.root.findAll(n => n.props['data-action'] === 'close-in-chat')).toEqual([]);
  });
  it('the all-items summary shows the generic closed status without a decision submission', async () => {
    serve(true);
    await act(async () => { renderer = TestRenderer.create(React.createElement(BoardSummaryView, { route: { appId: 'cli_a', view: 'all' } })); });
    for (let i = 0; i < 4; i++) await flush();
    expect(action('close-in-chat').children).toContain('关闭此项');
    await act(async () => action('close-in-chat').props.onClick());
    expect(text()).toContain(zh('decisionBoard.closeInChatBody'));
    await act(async () => action('confirm-close-in-chat').props.onClick());
    await flush();
    expect(text()).toContain(zh('decisionBoard.closeInChatDone'));
    expect(calls('POST', '/submit')).toEqual([]);
    expect(renderer!.root.findAll(n => n.type === 'button' && n.props['data-action'] === 'close-in-chat')).toEqual([]);
  });
  it('summary has a separate close button and refreshes its list after confirmation', async () => {
    serve();
    await act(async () => { renderer = TestRenderer.create(React.createElement(BoardSummaryView, { route: { appId: 'cli_a', view: 'decide' } })); });
    for (let i = 0; i < 4; i++) await flush();
    const close = action('close-in-chat');
    for (let p = close.parent; p; p = p.parent) expect(p.type).not.toBe('a');
    await act(async () => close.props.onClick());
    await act(async () => action('confirm-close-in-chat').props.onClick());
    await flush();
    expect(calls('POST', '/close-in-chat')).toHaveLength(1);
    expect(calls('POST', '/submit')).toEqual([]);
    expect(renderer!.root.findAll(n => n.type === 'button' && n.props['data-action'] === 'close-in-chat')).toEqual([]);
  });
});

describe('ended item with a leftover draft', () => {
  beforeEach(() => {
    resetBoardNavMemory();
    vi.stubGlobal('location', { hash: '#/board/cli_a/31', pathname: '/', search: '' });
    vi.stubGlobal('history', { state: null, replaceState: () => {} });
  });
  it.each(['done', 'closed'] as const)('shows the %s item draft read-only and lets the owner clear it', async state => {
    // 管家改状态不清草稿：详情页不再给编辑器和提交按钮，但草稿要看得到、清得掉，否则一直算在「提交 N 项」里。
    let draft: any = { seq: 31, author: 'owner', choice: 'B', text: '管家改状态前写的说明', fileIds: [], baseRev: 5, updatedAt: 1 };
    routes = (url, init) => {
      const method = init.method ?? 'GET';
      if (url.endsWith('/items/31') && method === 'GET') {
        return json({ ok: true, ...detail(31, { item: boardItem(31, { state }), draft, drafts: draft ? [{ seq: 31, updatedAt: 1 }] : [] }) });
      }
      if (url.endsWith('/seen')) return json({ ok: true });
      if (url.endsWith('/items/31/draft') && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        if (body.choice || body.text.trim() || body.fileIds.length) return json({ ok: false, error: 'item_ended', message: '这一项已处理，不能再保存决定草稿' }, 409);
        draft = undefined;
        return json({ ok: true });
      }
      return json({ ok: false, error: 'unexpected' }, 404);
    };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(React.Fragment, null,
        React.createElement(ItemDetailView, { appId: 'cli_a', seq: 31 }), React.createElement(ConfirmModalRoot)));
    });
    await flush();

    expect(renderer!.root.findAllByType('textarea')).toEqual([]);
    expect(text()).toContain(zh('decisionBoard.endedDraft'));
    expect(text()).toContain('管家改状态前写的说明');
    expect(renderer!.root.findAll(n => n.type === 'button' && textOf(n).includes(zh('decisionBoard.submitThis')))).toEqual([]);

    await act(async () => { buttonByText(zh('decisionBoard.clearDraft')).props.onClick(); });
    expect(calls('PUT', '/draft')).toEqual([]);
    await act(async () => { renderer!.root.find(n => n.type === 'button' && n.props.className === 'btn-danger').props.onClick(); });
    await flush();
    expect(calls('PUT', '/items/31/draft').map(c => c.body)).toEqual([{ text: '', fileIds: [], baseRev: 5 }]);
    expect(text()).not.toContain(zh('decisionBoard.endedDraft'));
    expect(renderer!.root.findAll(n => n.type === 'button' && textOf(n).includes(zh('decisionBoard.clearDraft')))).toEqual([]);
  });
});

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

  it('leaves a draft on an ended item out of the dialog and the request (an old daemon may still return it)', async () => {
    // 新 daemon 在事项结束时把草稿收进历史；旧 daemon 还会给，确认框不列它，也不算在「提交 N 项」里。
    const details: Record<string, BoardDetailResponse> = {
      '/items/1': detail(1, { item: boardItem(1, { state: 'done' }), draft: { seq: 1, author: 'owner', choice: 'B', text: '管家改状态前写的', fileIds: [], baseRev: 5, updatedAt: 11 } }),
      '/items/2': detail(2, { draft: { seq: 2, author: 'owner', choice: 'A', text: '开关放 Bot 配置页', fileIds: [], baseRev: 4, updatedAt: 22 } }),
    };
    routes = (url, init) => {
      const hit = Object.keys(details).find(k => url.endsWith(`/api/decision-board/cli_a${k}`));
      if (hit && (init.method ?? 'GET') === 'GET') return json({ ok: true, ...details[hit] });
      if (url.endsWith('/submit') && init.method === 'POST') {
        return json({ ok: true, duplicate: false, decisions: [], batch: { id: 9, author: 'local', createdAt: 1, delivery: 'delivered', attempts: 1 } });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SubmitDialog, { appId: 'cli_a', seqs: [1, 2], firstSeq: 1, onClose: vi.fn() }));
    });
    await flush();

    const boxes = renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox');
    expect(boxes).toHaveLength(1);
    expect(text()).not.toContain('管家改状态前写的');
    expect(text()).toContain(zh('decisionBoard.submitDialogTitle', { n: 1 }));
    await act(async () => { buttonByText(zh('decisionBoard.confirmSubmit', { n: 1 })).props.onClick(); });
    expect(calls('POST', '/submit').map(c => c.body.items)).toEqual([[{ seq: 2, draftUpdatedAt: 22 }]]);
  });

  it('never says "submit 0": with nothing submittable the title and button carry no number and the button is disabled', async () => {
    serveDrafts();
    await open();
    // 两项都取消勾选：标题回到「提交决定」，按钮是不带数字的「确认提交」且置灰。
    for (const box of renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox')) {
      act(() => box.props.onChange({ currentTarget: { checked: false } }));
    }
    expect(text()).not.toContain(zh('decisionBoard.submitDialogTitle', { n: 0 }));
    expect(text()).not.toContain(zh('decisionBoard.confirmSubmit', { n: 0 }));
    expect(renderer!.root.find(n => n.type === 'h3').children.join('')).toBe(zh('decisionBoard.submitNone'));
    const confirmBtn = renderer!.root.find(n => n.type === 'button' && n.props.className === 'btn-primary');
    expect(textOf(confirmBtn)).toBe(zh('decisionBoard.confirmSubmitNone'));
    expect(confirmBtn.props.disabled).toBe(true);
  });

  it('a dialog opened only for ended items shows no number either', async () => {
    routes = (url, init) => {
      if (url.endsWith('/api/decision-board/cli_a/items/1') && (init.method ?? 'GET') === 'GET') {
        return json({ ok: true, ...detail(1, { item: boardItem(1, { state: 'done' }), draft: { seq: 1, author: 'owner', choice: 'A', text: '', fileIds: [], baseRev: 5, updatedAt: 11 } }) });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SubmitDialog, { appId: 'cli_a', seqs: [1], onClose: vi.fn() }));
    });
    await flush();
    expect(renderer!.root.find(n => n.type === 'h3').children.join('')).toBe(zh('decisionBoard.submitNone'));
    expect(text()).toContain(zh('decisionBoard.submitDialogEmpty'));
    expect(text()).not.toContain(zh('decisionBoard.submitDialogTitle', { n: 0 }));
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

describe('item detail · an item that is no longer waiting for a decision', () => {
  it('shows no options (even if the item still has some) and does not send a choice left over in the draft', async () => {
    vi.useFakeTimers();
    routes = (url, init) => {
      const method = init.method ?? 'GET';
      if (url.endsWith('/items/31') && method === 'GET') {
        return json({ ok: true, ...detail(31, { item: boardItem(31, { state: 'active', question: undefined }), draftAskKey: '',
          draft: { seq: 31, author: 'owner', choice: 'A', text: '旧想法', fileIds: [], baseRev: 5, updatedAt: 100 } }) });
      }
      if (url.endsWith('/seen')) return json({ ok: true });
      if (url.endsWith('/items/31/draft') && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        return json({ ok: true, draft: { seq: 31, author: 'owner', text: body.text, fileIds: body.fileIds, baseRev: body.baseRev, updatedAt: 200 } });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
    await act(async () => { renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq: 31 })); });
    await flush();
    expect(renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'radio')).toEqual([]);
    expect(text()).not.toContain(zh('decisionBoard.askTitle'));
    act(() => renderer!.root.findByType('textarea').props.onChange({ currentTarget: { value: '旧想法，补一句' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(calls('PUT', '/items/31/draft').map(c => c.body)).toEqual([{ text: '旧想法，补一句', fileIds: [], baseRev: 5, askKey: '' }]);
  });
});

describe('item detail · the steward changes the item while the owner is typing', () => {
  const OLD_KEY = 'aaaaaaaaaaaa';
  const outdatedMessage = '这一项在你写草稿时被管家改过（状态或待拍板的选项变了），这次没有存成草稿，刚写的内容已收进这一项的历史。';
  let changed: boolean;
  let gate: Promise<void> | undefined;
  let archivedTexts: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    changed = false;
    gate = undefined;
    archivedTexts = [];
    routes = async (url, init) => {
      const method = init.method ?? 'GET';
      if (url.endsWith('/api/decision-board/cli_a/items/31') && method === 'GET') {
        return json({
          ok: true,
          ...(changed
            ? detail(31, {
              item: boardItem(31, { state: 'active', rev: 6 }),
              draftAskKey: '',
              events: archivedTexts.map((t, i) => ({ id: 9 + i, seq: 31, at: 3, actor: 'owner' as const, kind: 'draft' as const, text: t, fileIds: [] })),
            })
            : detail(31, { draftAskKey: OLD_KEY, draft: { seq: 31, author: 'owner', choice: 'A', text: '旧想法', fileIds: [], baseRev: 5, updatedAt: 100 },
              drafts: [{ seq: 31, updatedAt: 100 }, { seq: 12, updatedAt: 50 }] })),
        });
      }
      if (url.endsWith('/items/31/seen') && method === 'POST') return json({ ok: true });
      if (url.endsWith('/items/31/draft') && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        if (gate) await gate;
        // 真实 store 的 archive 分支只收进历史，成功回 200，不走 late 的 409。
        if (body.archive) return json({ ok: true, draft: null });
        if (changed && body.askKey === OLD_KEY) {
          archivedTexts.push(`这一项改成了「进行中」，这份草稿没有提交（没有发给管家），收在这里留底。\n说明：\n${body.text}`);
          return json({ ok: false, error: 'draft_outdated', message: outdatedMessage }, 409);
        }
        return json({ ok: true, draft: { seq: 31, author: 'owner', ...(body.choice ? { choice: body.choice } : {}), text: body.text, fileIds: body.fileIds, baseRev: body.baseRev, updatedAt: 300 } });
      }
      if (url.endsWith('/files') && method === 'POST') {
        if (gate) await gate;
        return json({ ok: true, file: { id: 'img1', sha256: 'x', mime: 'image/png', bytes: 10, name: 'a.png', by: 'owner', createdAt: 1 } });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
  });

  async function openDetail(): Promise<void> {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq: 31 }));
    });
    await flush();
  }
  const type = (value: string) => act(() => renderer!.root.findByType('textarea').props.onChange({ currentTarget: { value } }));
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); await flush(); };

  it('the late save is refused and its text goes to the history; the box is cleared with a notice and the item is reloaded', async () => {
    await openDetail();
    changed = true;
    type('旧想法，再补一句');
    await settle();
    expect(calls('PUT', '/items/31/draft').map(c => [c.body.askKey, c.body.text])).toEqual([[OLD_KEY, '旧想法，再补一句']]);
    expect(calls('GET', '/items/31').length).toBe(2);
    // 已是进行中：不再显示选项；输入框清空，提示刚写的内容已收进历史，历史里看得到原话。
    expect(renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'radio')).toEqual([]);
    expect(renderer!.root.findByType('textarea').props.value).toBe('');
    expect(renderer!.root.find(n => n.props['data-draft-archived'] !== undefined)).toBeTruthy();
    expect(text()).toContain(zh('decisionBoard.eventDraft'));
    expect(text()).toContain('旧想法，再补一句');
    // 清空后不再自动保存；之后接着写就按现在这一轮存，提示消失。
    await settle();
    expect(calls('PUT', '/items/31/draft')).toHaveLength(1);
    type('按进行中推进');
    await settle();
    expect(calls('PUT', '/items/31/draft').map(c => c.body.askKey)).toEqual([OLD_KEY, '']);
    expect(renderer!.root.findAll(n => n.props['data-draft-archived'] !== undefined)).toEqual([]);
  });

  it('text typed while the refused save was in flight is sent once more for the old round, not left in the box or re-filed under the new one', async () => {
    await openDetail();
    changed = true;
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    type('第一句');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    type('第一句，第二句');
    gate = undefined;
    release();
    await flush();
    await flush();
    await settle();
    expect(calls('PUT', '/items/31/draft').map(c => [c.body.askKey, c.body.text])).toEqual([[OLD_KEY, '第一句'], [OLD_KEY, '第一句，第二句']]);
    expect(renderer!.root.findByType('textarea').props.value).toBe('');
    // 离开页面：输入框已空，不再补存。
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(calls('PUT', '/items/31/draft')).toHaveLength(2);
  });

  it('keeps the unconfirmed in-flight text when supplemental archival fails, and retries it under the old round', async () => {
    await openDetail();
    changed = true;
    const base = routes;
    let failures = 1;
    routes = async (url, init) => {
      if (url.endsWith('/items/31/draft') && init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        if (body.text === '第一句，第二句' && failures > 0) {
          failures -= 1;
          return json({ ok: false, error: 'daemon_offline', message: '502 Bad Gateway' }, 502);
        }
      }
      return base(url, init);
    };
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    type('第一句');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    type('第一句，第二句');
    gate = undefined;
    release();
    await flush();
    await flush();
    await settle();

    // 第一笔已归档，第二笔 502 没归档：只保留仍未确认的内容，不用服务端空草稿覆盖，也不按新一轮自动保存。
    expect(archivedTexts).toHaveLength(1);
    expect(archivedTexts[0]).toContain('第一句');
    expect(archivedTexts[0]).not.toContain('第二句');
    expect(calls('GET', '/items/31')).toHaveLength(1);
    expect(renderer!.root.findByType('textarea').props.value).toBe('第一句，第二句');
    expect(renderer!.root.findByType('textarea').props.readOnly).toBe(true);
    expect(buttonByText(zh('decisionBoard.clearDraft')).props.disabled).toBe(true);
    expect(text()).toContain('502 Bad Gateway');
    expect(calls('PUT', '/items/31/draft')).toHaveLength(2);
    expect(pendingLeavePrompt()).not.toBeNull();

    await act(async () => { buttonByText(zh('decisionBoard.saveRetry')).props.onClick(); });
    await settle();
    const puts = calls('PUT', '/items/31/draft');
    expect(puts).toHaveLength(3);
    expect(puts[2]!.body.askKey).toBe(OLD_KEY);
    expect(puts[2]!.body.text).toBe('第一句，第二句');
    expect(archivedTexts).toHaveLength(2);
    expect(archivedTexts[1]).toContain('第一句，第二句');
    expect(calls('GET', '/items/31')).toHaveLength(2);
    expect(renderer!.root.findByType('textarea').props.value).toBe('');
    expect(renderer!.root.findByType('textarea').props.readOnly).toBe(false);
    expect(pendingLeavePrompt()).toBeNull();
  });

  it('a late save that hits an item the steward has just finished is handled the same way: archived, box cleared, page reloaded', async () => {
    const base = routes;
    let ended = false;
    routes = async (url, init) => {
      const method = init.method ?? 'GET';
      if (ended && url.endsWith('/items/31') && method === 'GET') {
        return json({ ok: true, ...detail(31, { item: boardItem(31, { state: 'done', rev: 7 }), draftAskKey: '' }) });
      }
      if (ended && url.endsWith('/items/31/draft') && method === 'PUT') {
        return json({ ok: false, error: 'draft_outdated', message: '这一项已经结束，不能再保存决定草稿；刚写的内容已收进这一项的历史。' }, 409);
      }
      return base(url, init);
    };
    await openDetail();
    ended = true;
    type('再补一句');
    await settle();
    expect(calls('GET', '/items/31').length).toBe(2);
    expect(renderer!.root.findAll(n => n.type === 'textarea')).toEqual([]);
    expect(renderer!.root.find(n => n.props['data-draft-archived'] !== undefined)).toBeTruthy();
    expect(text()).not.toContain(zh('decisionBoard.endedDraft'));
  });

  it('an old daemon answering item_ended has not archived anything: the text stays in the box with the error', async () => {
    const base = routes;
    routes = async (url, init) => {
      if (url.endsWith('/items/31/draft') && init.method === 'PUT') {
        return json({ ok: false, error: 'item_ended', message: '这一项已处理，不能再保存决定草稿' }, 409);
      }
      return base(url, init);
    };
    await openDetail();
    type('别丢了这句');
    await settle();
    expect(renderer!.root.findByType('textarea').props.value).toBe('别丢了这句');
    expect(renderer!.root.findAll(n => n.props['data-draft-archived'] !== undefined)).toEqual([]);
    expect(text()).toContain('这一项已处理');
  });

  it('while the item is being re-read after the refusal, the old options and the box are locked and submit is off; once it lands, writing saves for the new round', async () => {
    await openDetail();
    changed = true;
    let releaseGet!: () => void;
    const getGate = new Promise<void>(r => { releaseGet = r; });
    const base = routes;
    let slowGet = true;
    routes = async (url, init) => {
      if (slowGet && url.endsWith('/items/31') && (init.method ?? 'GET') === 'GET') { slowGet = false; await getGate; }
      return base(url, init);
    };
    type('第一句');
    await settle();
    expect(calls('PUT', '/items/31/draft')).toHaveLength(1);
    // 重新读还没回来：页面上还是旧选项，不能照着点、也不能写或提交。
    expect(renderer!.root.findByType('textarea').props.readOnly).toBe(true);
    expect(renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'radio').every(r => r.props.disabled)).toBe(true);
    // 另外还有一项草稿：平时这个按钮是能点的，重新读期间置灰。
    expect(buttonByText(zh('decisionBoard.submitOthers', { n: 1 })).props.disabled).toBe(true);
    releaseGet();
    await flush();
    await settle();
    expect(renderer!.root.findByType('textarea').props.readOnly).toBe(false);
    type('看了新内容之后写的');
    await settle();
    expect(calls('PUT', '/items/31/draft').map(c => [c.body.askKey, c.body.text])).toEqual([[OLD_KEY, '第一句'], ['', '看了新内容之后写的']]);
  });

  it('if re-reading the item fails once, it tries again a moment later before unlocking', async () => {
    await openDetail();
    changed = true;
    const base = routes;
    let failures = 1;
    routes = async (url, init) => {
      if (failures > 0 && url.endsWith('/items/31') && (init.method ?? 'GET') === 'GET') { failures -= 1; return json({ ok: false, error: 'daemon_offline' }, 503); }
      return base(url, init);
    };
    type('第一句');
    await settle();
    expect(calls('GET', '/items/31')).toHaveLength(2);
    expect(renderer!.root.findByType('textarea').props.readOnly).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    await flush();
    expect(calls('GET', '/items/31')).toHaveLength(3);
    expect(renderer!.root.findByType('textarea').props.readOnly).toBe(false);
    // 读到的是新内容（进行中，不再给选项）。
    expect(renderer!.root.findAll(n => n.type === 'input' && n.props.type === 'radio')).toEqual([]);
  });

  it('after the refusal the box shows the draft another tab has just saved for the new round, instead of staying empty', async () => {
    await openDetail();
    changed = true;
    const base = routes;
    routes = async (url, init) => {
      if (changed && url.endsWith('/items/31') && (init.method ?? 'GET') === 'GET') {
        return json({ ok: true, ...detail(31, { item: boardItem(31, { state: 'active', rev: 6 }), draftAskKey: '',
          draft: { seq: 31, author: 'owner', text: '另一个标签页刚写的', fileIds: [], baseRev: 6, updatedAt: 400 } }) });
      }
      return base(url, init);
    };
    type('这个标签页写的');
    await settle();
    expect(renderer!.root.findByType('textarea').props.value).toBe('另一个标签页刚写的');
  });

  it('an image that finishes uploading after the box was cleared is not added back into it', async () => {
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.onload?.(); }
    });
    await openDetail();
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    const input = renderer!.root.find(n => n.type === 'input' && n.props.type === 'file');
    // 上传卡在 gate 上（还没传完）。
    await act(async () => { input.props.onChange({ currentTarget: { files: [{ type: 'image/png', size: 10, name: 'a.png' }], value: '' } }); });
    await flush();
    expect(calls('POST', '/files')).toHaveLength(1);
    changed = true;
    gate = undefined;
    type('补一句');
    await settle();
    expect(renderer!.root.findByType('textarea').props.value).toBe('');
    release();
    await flush();
    await settle();
    // 传完的图没有塞进清空后的编辑器；按开始传时的那一轮只收进历史（archive），不存成草稿。
    expect(renderer!.root.findAll(n => n.type === 'img' && String(n.props.src).includes('/files/img1'))).toEqual([]);
    expect(calls('PUT', '/items/31/draft').filter(c => c.body.fileIds.length).map(c => c.body))
      .toEqual([{ text: '', fileIds: ['img1'], baseRev: 5, askKey: OLD_KEY, archive: true }]);
  });

  it('keeps a late image and its leave guard when archival fails, then retries the same file with keepalive', async () => {
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.onload?.(); }
    });
    const base = routes;
    let failures = 1;
    routes = async (url, init) => {
      if (url.endsWith('/items/31/draft') && init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        if (body.archive && failures > 0) {
          failures -= 1;
          return json({ ok: false, error: 'daemon_offline', message: '502 Bad Gateway' }, 502);
        }
      }
      return base(url, init);
    };
    const beforeUnloadListeners: Array<(event: BeforeUnloadEvent) => void> = [];
    const currentWindow = window;
    vi.stubGlobal('window', {
      ...currentWindow,
      addEventListener: (type: string, listener: (event: BeforeUnloadEvent) => void) => {
        if (type === 'beforeunload') beforeUnloadListeners.push(listener);
      },
      removeEventListener: () => {},
    });
    await openDetail();
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    const input = renderer!.root.find(n => n.type === 'input' && n.props.type === 'file');
    await act(async () => { input.props.onChange({ currentTarget: { files: [{ type: 'image/png', size: 10, name: 'a.png' }], value: '' } }); });
    await flush();
    changed = true;
    gate = undefined;
    type('补一句');
    await settle();
    release();
    await flush();
    await settle();

    const previews = () => renderer!.root.findAll(n => n.type === 'img' && String(n.props.src).startsWith('data:'));
    const archives = () => fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/items/31/draft')
      && (init as RequestInit).method === 'PUT' && JSON.parse(String((init as RequestInit).body)).archive === true);
    expect(archives()).toHaveLength(1);
    expect((archives()[0]![1] as RequestInit).keepalive).toBe(true);
    expect(previews()).toHaveLength(1);
    expect(renderer!.root.find(n => n.props['data-upload-error'] !== undefined)).toBeTruthy();
    expect(text()).toContain('502 Bad Gateway');
    expect(pendingLeavePrompt()).not.toBeNull();
    const blockedUnload = { preventDefault: vi.fn(), returnValue: '' } as unknown as BeforeUnloadEvent;
    for (const listener of beforeUnloadListeners) listener(blockedUnload);
    expect(blockedUnload.preventDefault).toHaveBeenCalled();

    await act(async () => { renderer!.root.find(n => n.props['data-action'] === 'retry-archive').props.onClick(); });
    await settle();
    expect(archives()).toHaveLength(2);
    expect(JSON.parse(String((archives()[1]![1] as RequestInit).body))).toEqual({
      text: '', fileIds: ['img1'], baseRev: 5, askKey: OLD_KEY, archive: true,
    });
    expect((archives()[1]![1] as RequestInit).keepalive).toBe(true);
    expect(previews()).toHaveLength(0);
    expect(renderer!.root.findAll(n => n.props['data-action'] === 'retry-archive')).toEqual([]);
    expect(pendingLeavePrompt()).toBeNull();
    const cleanUnload = { preventDefault: vi.fn(), returnValue: '' } as unknown as BeforeUnloadEvent;
    for (const listener of beforeUnloadListeners) listener(cleanUnload);
    expect(cleanUnload.preventDefault).not.toHaveBeenCalled();
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

  it('"decision cards in Feishu" is on by default; turning it off saves false, turning it back on drops the field', async () => {
    serve();
    await render({ enabled: true, chatId: 'oc_1' });
    const cards = () => renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward-decision-cards');
    expect(cards().props.checked).toBe(true);
    expect(text()).toContain(zh('botDefaults.stewardDecisionCards'));
    await act(async () => { cards().props.onChange({ currentTarget: { checked: false } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1', decisionCards: false } });
    expect(cards().props.checked).toBe(false);
    await act(async () => { cards().props.onChange({ currentTarget: { checked: true } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1' } });
  });

  it('"subtask alerts" is off by default; turning it on saves true, turning it back off drops the field', async () => {
    serve();
    await render({ enabled: true, chatId: 'oc_1', closeHints: true });
    const alerts = () => renderer!.root.find(n => n.type === 'input' && n.props['data-action'] === 'toggle-steward-task-hints');
    expect(alerts().props.checked).toBe(false);
    expect(text()).toContain(zh('botDefaults.stewardTaskHints'));
    await act(async () => { alerts().props.onChange({ currentTarget: { checked: true } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1', closeHints: true, taskHints: true } });
    expect(alerts().props.checked).toBe(true);
    await act(async () => { alerts().props.onChange({ currentTarget: { checked: false } }); });
    expect(calls('PUT', '/api/bots/cli_s/steward').at(-1)!.body).toEqual({ steward: { enabled: true, chatId: 'oc_1', closeHints: true } });
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

describe('item detail · previous / next', () => {
  let session: Map<string, string>;
  let loc: { hash: string; pathname: string; search: string };
  let savedText: string;

  beforeEach(() => {
    vi.useFakeTimers();
    resetBoardNavMemory();
    session = new Map();
    loc = { hash: '#/board/cli_a/7', pathname: '/', search: '' };
    vi.stubGlobal('location', loc);
    vi.stubGlobal('history', { state: null, replaceState: () => {} });
    vi.stubGlobal('window', {
      ...(globalThis as any).window,
      sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); } },
    });
    savedText = '';
    routes = (url, init) => {
      const method = init.method ?? 'GET';
      const item = /\/items\/(\d+)$/.exec(url);
      if (item && method === 'GET') {
        const seq = Number(item[1]);
        return json({ ok: true, ...detail(seq, { item: boardItem(seq, { state: seq === 5 ? 'active' : 'decide' }) }) });
      }
      if (url.includes('/items?') && method === 'GET') {
        const view = new URL(url, 'http://x').searchParams.get('view');
        const seqs = view === 'decide' ? [3, 7, 9] : view === 'active' ? [5, 6] : [3, 5, 6, 7, 9];
        return json({ ok: true, view, steward: { enabled: true, ready: true }, counts: { decide: 3, active: 2, all: 5 }, items: seqs.map(n => ({ ...boardItem(n), links: [], hasDraft: false, pendingDecisions: 0, unseen: false })), drafts: [], batches: [] });
      }
      if (url.endsWith('/seen')) return json({ ok: true });
      const draft = /\/items\/(\d+)\/draft$/.exec(url);
      if (draft && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        savedText = body.text;
        return json({ ok: true, draft: { seq: Number(draft[1]), author: 'owner', text: body.text, fileIds: [], baseRev: body.baseRev, updatedAt: 300 } });
      }
      if (url.endsWith('/api/decision-board/boards')) {
        return json({ ok: true, boards: [{ larkAppId: 'cli_a', botName: '管家', online: true, steward: { enabled: true, ready: true } }] });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
  });

  async function open(seq: number) {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq }));
    });
    await flush();
    await flush();
  }

  const navButton = (which: 'prev' | 'next', index = 0) => renderer!.root.findAll(n => n.type === 'button' && n.props['data-nav'] === which)[index]!;

  it('opened straight from a Feishu link: switches within the view the item belongs to, in list order', async () => {
    await open(7);
    expect(calls('GET', '/items?')[0]!.url).toContain('view=decide');
    expect(text()).toContain(zh('decisionBoard.navPosition', { n: 2, total: 3, view: zh('decisionBoard.tabDecide') }));
    expect(navButton('prev').props.disabled).toBe(false);
    await act(async () => { navButton('next').props.onClick(); });
    expect(loc.hash).toBe('#/board/cli_a/9');
    await act(async () => { navButton('prev').props.onClick(); });
    expect(loc.hash).toBe('#/board/cli_a/3');
  });

  it('follows the list the owner came from (view and order), without refetching it; greys out the end', async () => {
    session.set(BOARD_NAV_STORAGE_KEY, JSON.stringify({ appId: 'cli_a', view: 'active', seqs: [6, 5] }));
    await open(5);
    expect(calls('GET', '/items?')).toHaveLength(0);
    expect(text()).toContain(zh('decisionBoard.navPosition', { n: 2, total: 2, view: zh('decisionBoard.tabActive') }));
    expect(navButton('next').props.disabled).toBe(true);
    expect(textOf(navButton('next'))).toBe(zh('decisionBoard.navLast'));
    expect(textOf(navButton('prev'))).toContain(zh('decisionBoard.navPrev'));
    await act(async () => { navButton('prev').props.onClick(); });
    expect(loc.hash).toBe('#/board/cli_a/6');
  });

  it('a remembered list from another board, or one without this item, is not used', async () => {
    session.set(BOARD_NAV_STORAGE_KEY, JSON.stringify({ appId: 'cli_other', view: 'active', seqs: [7, 8] }));
    await open(7);
    expect(calls('GET', '/items?')).toHaveLength(1);
    expect(text()).toContain(zh('decisionBoard.navPosition', { n: 2, total: 3, view: zh('decisionBoard.tabDecide') }));
  });

  it('saves the unsaved draft before switching, so nothing typed is lost', async () => {
    await open(7);
    act(() => renderer!.root.findByType('textarea').props.onChange({ currentTarget: { value: '切走前刚写的' } }));
    expect(calls('PUT', '/items/7/draft')).toHaveLength(0);
    await act(async () => { navButton('next', 1).props.onClick(); });
    const puts = calls('PUT', '/items/7/draft');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.text).toBe('切走前刚写的');
    expect(savedText).toBe('切走前刚写的');
    expect(loc.hash).toBe('#/board/cli_a/9');
  });

  it('the summary page remembers exactly the list it shows, so the detail page walks the same order', async () => {
    loc.hash = '#/board?view=all';
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(BoardSummaryView, { route: { view: 'all' } }));
    });
    for (let i = 0; i < 4; i += 1) await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(JSON.parse(session.get(BOARD_NAV_STORAGE_KEY)!)).toEqual({ appId: 'cli_a', view: 'all', seqs: [3, 5, 6, 7, 9] });
  });
});


describe('linked chats', () => {
  const applink = (chatId: string) => `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}`;
  const chat = (ref: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: 'chat' as const, ref, text, url: applink(ref), ...extra });
  const pr = { kind: 'pr' as const, ref: 'o/r#1', text: 'PR #1', url: 'https://github.com/o/r/pull/1' };
  const anchors = () => renderer!.root.findAll(n => n.type === 'a');
  const chatAnchors = () => anchors().filter(a => a.props['data-chat']);
  const insideAnchor = (node: ReactTestInstance): boolean => {
    for (let p = node.parent; p; p = p.parent) if (p.type === 'a') return true;
    return false;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetBoardNavMemory();
    vi.stubGlobal('location', { hash: '#/board?view=all', pathname: '/', search: '' });
    vi.stubGlobal('history', { state: null, replaceState: () => {} });
  });

  function serve(items: Array<Partial<BoardItem> & { seq: number; links: any[] }>, details: Record<number, Partial<BoardDetailResponse>> = {}) {
    routes = (url, init) => {
      const method = init.method ?? 'GET';
      if (url.endsWith('/api/decision-board/boards')) {
        return json({ ok: true, boards: [{ larkAppId: 'cli_a', botName: '管家', online: true, steward: { enabled: true, ready: true } }] });
      }
      if (url.includes('/items?') && method === 'GET') {
        return json({ ok: true, view: 'all', steward: { enabled: true, ready: true }, counts: { decide: 0, active: items.length, all: items.length },
          items: items.map(i => ({ ...boardItem(i.seq, { state: 'active' }), hasDraft: false, pendingDecisions: 0, unseen: false, ...i })), drafts: [], batches: [] });
      }
      const one = /\/items\/(\d+)$/.exec(url);
      if (one && method === 'GET') return json({ ok: true, ...detail(Number(one[1]), details[Number(one[1])]) });
      if (url.endsWith('/seen')) return json({ ok: true });
      return json({ ok: false, error: 'not_found' }, 404);
    };
  }

  async function openSummary() {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(BoardSummaryView, { route: { view: 'all' } }));
    });
    for (let i = 0; i < 4; i += 1) await flush();
  }

  async function openDetail(seq: number) {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq }));
    });
    await flush();
  }

  it('each row opens its main chat in Feishu; rows without a chat say why or flag it, with no button', async () => {
    serve([
      { seq: 1, links: [pr, chat('oc_task', '任务群'), chat('oc_review', 'PR 评审群', { primary: true })] },
      // 旧 daemon 不标 primary：第一个群就是主群。
      { seq: 2, links: [chat('oc_old', '群 oc_old'), chat('oc_old2', '群 oc_old2')] },
      { seq: 3, links: [pr], noChatReason: '只有 issue，还没开工' },
      { seq: 4, links: [] },
    ]);
    await openSummary();
    const joins = chatAnchors();
    expect(joins.map(a => [a.props['data-chat'], a.props.href, a.props.target])).toEqual([
      ['oc_review', applink('oc_review'), '_blank'],
      ['oc_old', applink('oc_old'), '_blank'],
    ]);
    // 「进群」是行内详情链接的兄弟，不是套在链接里的链接。
    for (const a of joins) expect(insideAnchor(a)).toBe(false);
    expect(textOf(joins[0]!)).toBe(zh('decisionBoard.joinChat'));
    const all = text();
    expect(all).toContain('PR 评审群');
    expect(all).toContain(zh('decisionBoard.moreChats', { n: 1 }));
    expect(all).toContain(zh('decisionBoard.noChat', { reason: '只有 issue，还没开工' }));
    expect(all).toContain(zh('decisionBoard.chatMissing'));
  });

  it('the detail page lists every chat under the title, main chat first and marked; chats are not repeated among the other links', async () => {
    serve([], { 31: { links: [pr, chat('oc_a', '任务群', { chatCheck: 'unverified' }), chat('oc_b', 'PR 评审群', { primary: true, chatCheck: 'verified' })] } });
    await openDetail(31);
    const joins = chatAnchors();
    expect(joins.map(a => [a.props['data-chat'], a.props.href, a.props.target])).toEqual([
      ['oc_b', applink('oc_b'), '_blank'], ['oc_a', applink('oc_a'), '_blank'],
    ]);
    expect(textOf(joins[0]!)).toContain(zh('decisionBoard.primaryChat'));
    expect(textOf(joins[0]!)).not.toContain(zh('decisionBoard.chatUnverified'));
    expect(textOf(joins[1]!)).toContain(zh('decisionBoard.chatUnverified'));
    expect(textOf(joins[1]!)).not.toContain(zh('decisionBoard.primaryChat'));
    // 下方关联只剩 PR。
    expect(anchors().filter(a => a.props.className === 'dboard-link').map(a => a.props.href)).toEqual([pr.url]);
  });

  it('the detail page tells the owner how to get a missing chat added, and shows the no-chat reason when there is one', async () => {
    serve([], { 31: { links: [pr] }, 32: { links: [], item: boardItem(32, { noChatReason: '管家自己处理' }) } });
    await openDetail(31);
    expect(chatAnchors()).toEqual([]);
    expect(text()).toContain('botmux board set 31 --link chat=oc_…');
    act(() => renderer!.unmount());
    await openDetail(32);
    expect(text()).toContain(zh('decisionBoard.noChat', { reason: '管家自己处理' }));
    expect(text()).not.toContain('--link chat=oc_');
  });

  it('rows show the linked chat state: one chat as state + first line, several as a count summary; fresh results get the subtask hint', async () => {
    const at = Date.now() - 12 * 60_000;
    const hint = { kind: 'task_delivered', chatId: 'oc_a', at, key: 'task:delivered:s:t', summary: '登录超时修好了' };
    serve([
      { seq: 1, links: [chat('oc_a', '修登录群')], taskChats: [{ chatId: 'oc_a', kind: 'delivered', at, summary: '登录超时修好了' }], taskFresh: true, taskHint: hint },
      { seq: 2, links: [chat('oc_b', 'B'), chat('oc_c', 'C'), chat('oc_d', 'D')], taskChats: [
        { chatId: 'oc_b', kind: 'working', at }, { chatId: 'oc_c', kind: 'delivered', at }, { chatId: 'oc_d', kind: 'delivered', at },
      ] },
      { seq: 3, links: [chat('oc_e', 'E')] },
    ] as never);
    await openSummary();
    const rows = renderer!.root.findAll(n => n.props.className === 'dboard-row-task');
    expect(rows.map(r => [r.props['data-task'], r.props['data-fresh']])).toEqual([['delivered', 'true'], [undefined, undefined]]);
    expect(textOf(rows[0]!)).toContain(zh('decisionBoard.taskDelivered'));
    expect(textOf(rows[0]!)).toContain('登录超时修好了');
    expect(textOf(rows[1]!)).toBe(`3 个群：1 ${zh('decisionBoard.taskWorking')} · 2 ${zh('decisionBoard.taskDelivered')}`);
    expect(renderer!.root.findAll(n => n.props['data-task-hint']).map(n => n.props['data-task-hint'])).toEqual(['task_delivered']);
    expect(text()).toContain(zh('decisionBoard.taskHintDelivered'));
  });

  it('the detail page shows each linked chat state and the subtask hint banner; nothing extra when the daemon sends none', async () => {
    const at = Date.now() - 60_000;
    serve([], {
      31: {
        links: [chat('oc_a', '修登录群', { primary: true }), chat('oc_b', '文档群')],
        taskChats: [
          { chatId: 'oc_a', kind: 'needs_you', reason: 'attention', at, detail: '要不要合？' },
          { chatId: 'oc_b', kind: 'unreadable' },
        ],
        taskHint: { kind: 'task_needs_you', chatId: 'oc_a', at, key: 'task:needs_you:s:1', detail: '要不要合？' },
      } as never,
      32: { links: [chat('oc_a', '修登录群')] },
    });
    await openDetail(31);
    const items = renderer!.root.findAll(n => n.type === 'li' && n.props.className === 'dboard-task');
    expect(items.map(i => i.props['data-task'])).toEqual(['needs_you', 'unreadable']);
    expect(textOf(items[0]!)).toContain('修登录群');
    expect(textOf(items[0]!)).toContain('要不要合？');
    expect(textOf(items[1]!)).toContain(zh('decisionBoard.taskUnreadable'));
    expect(text()).toContain(zh('decisionBoard.taskHintDetail', { label: zh('decisionBoard.taskHintNeedsYou') }));
    // 进群链接只在上面的群列表里出现一次。
    expect(chatAnchors().map(a => a.props['data-chat'])).toEqual(['oc_a', 'oc_b']);
    act(() => renderer!.unmount());
    await openDetail(32);
    expect(renderer!.root.findAll(n => n.props.className === 'dboard-tasks')).toEqual([]);
    expect(renderer!.root.findAll(n => n.props['data-task-hint'])).toEqual([]);
  });
});
