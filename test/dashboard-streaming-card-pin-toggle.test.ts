import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CardBehaviorSection } from '../src/dashboard/web/bot-defaults-page.js';
import { ManageDialog, renderGroupsPage } from '../src/dashboard/web/groups-page.js';
import type { GroupChat } from '../src/dashboard/web/groups.js';
import {
  __testOnly_resetGroupsSnapshotCache,
  fetchGroupsSnapshot,
  primeGroupsSnapshotCache,
} from '../src/dashboard/web/groups-api.js';
import { StreamingCardPinToggle } from '../src/dashboard/web/streaming-card-pin-toggle.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const groupsPageMount = vi.hoisted(() => ({ node: null as unknown }));
const confirmDialog = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
const toastModule = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../src/dashboard/web/react-mount.js', () => ({
  mountReactPage: (_root: HTMLElement, node: unknown) => {
    groupsPageMount.node = node;
    return () => undefined;
  },
}));

vi.mock('../src/dashboard/web/confirm-modal.js', () => ({
  confirm: confirmDialog.confirm,
}));

vi.mock('../src/dashboard/web/toast.js', () => ({
  toast: toastModule.toast,
}));

function findByDataAction(
  renderer: TestRenderer.ReactTestRenderer,
  action: string,
) {
  return renderer.root.findByProps({ 'data-action': action });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown): any {
  return { ok: true, status: 200, json: async () => body };
}

async function waitForRender(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => undefined);
    assertion();
  });
}

type GroupMember = GroupChat['memberBots'][number];

function makeMember(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    larkAppId: 'cli_a',
    botName: 'Claude',
    inChat: true,
    pinStreamingCardMasterEnabled: true,
    pinStreamingCardChatEnabled: false,
    pinStreamingCardEffectiveEnabled: false,
    ...overrides,
  };
}

function makeChat(memberBots: GroupMember[], overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    chatId: 'oc_group',
    name: 'Release Room',
    ownerId: 'ou_owner',
    ...overrides,
    memberBots,
  };
}

describe('shared streaming-card pin toggle', () => {
  it('keeps the bot-defaults pin toggle semantics while rendering shared copy', () => {
    const putCardPref = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_pin_absent' },
        putCardPref,
      }));
    });

    const toggle = findByDataAction(renderer, 'toggle-pin-streaming-card');
    expect(toggle.props.checked).toBe(false);
    expect(toggle.props.disabled).toBe(false);
    expect(renderer.root.findByProps({ 'data-streaming-card-pin-toggle': 'bot-defaults' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-streaming-card-pin-help': 'bot-defaults' }).children.join(''))
      .toContain('默认关闭');
  });

  it('associates the checkbox with the rendered help paragraph via aria-describedby', () => {
    const putCardPref = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_pin_a11y' },
        putCardPref,
      }));
    });

    const toggle = findByDataAction(renderer, 'toggle-pin-streaming-card');
    const help = renderer.root.findByProps({ 'data-streaming-card-pin-help': 'bot-defaults' });
    expect(typeof help.props.id).toBe('string');
    expect(help.props.id.length).toBeGreaterThan(0);
    expect(toggle.props['aria-describedby']).toContain(help.props.id);
  });

  it('merges external aria-describedby values with the shared help and description ids', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingCardPinToggle, {
          scope: 'bot-defaults',
          checked: false,
          title: 'Pin current live card',
          description: 'Shared description',
          help: 'Shared help',
          describedBy: 'external-status external-error',
          onChange: () => undefined,
        }),
      );
    });

    const toggle = renderer.root.findByType('input');
    const help = renderer.root.findByProps({ 'data-streaming-card-pin-help': 'bot-defaults' });
    const description = renderer.root.findByType('small');
    const describedBy = String(toggle.props['aria-describedby'] ?? '');

    expect(describedBy).toContain('external-status');
    expect(describedBy).toContain('external-error');
    expect(describedBy).toContain(String(description.props.id));
    expect(describedBy).toContain(String(help.props.id));
  });

  it('keeps bot-defaults rollback behavior after the shared toggle refactor', async () => {
    const putCardPref = vi.fn(async () => ({ ok: false, status: 500, body: { error: 'write_failed' } }));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_pin_fail' },
        putCardPref,
      }));
    });

    await act(async () => {
      findByDataAction(renderer, 'toggle-pin-streaming-card').props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });

    expect(findByDataAction(renderer, 'toggle-pin-streaming-card').props.checked).toBe(false);
    expect(renderer.root.findByProps({ 'data-card-pref-status': '' }).children.join('')).toContain('write_failed');
  });
});

describe('group manage streaming-card pin rows', () => {
  const tr = (key: string, vars?: Record<string, unknown>) => {
    if (key === 'groups.manageTitle') return `Manage ${String(vars?.name ?? '')}`;
    if (key === 'groups.pinStreamingCardSection') return 'Streaming-card Pin';
    if (key === 'groups.pinStreamingCardBotHint') return 'Per-bot chat override for streaming-card pinning.';
    if (key === 'groups.pinStreamingCardMasterOff') return 'Bot default pinning is off, so this chat cannot force-enable it.';
    if (key === 'groups.pinStreamingCardEnabled') return 'This chat pins the live card.';
    if (key === 'groups.pinStreamingCardDisabled') return 'This chat does not pin the live card.';
    if (key === 'groups.pinStreamingCardSaving') return 'Saving…';
    if (key === 'groups.pinStreamingCardSaved') return 'Saved';
    if (key === 'groups.pinStreamingCardSaveFailed') {
      return `Save failed: ${String(Object.prototype.hasOwnProperty.call(vars ?? {}, 'error') ? vars?.error : '{error}')}`;
    }
    if (key === 'groups.pinStreamingCard') return 'Pin current live card';
    if (key === 'groups.pinStreamingCardDescription') return 'Only affects the current public live card for this chat.';
    if (key === 'groups.pinStreamingCardHelp') return 'Uses the exact group-level override route.';
    if (key === 'groups.pinStreamingCardRefreshFailed') {
      return `Saved, but refresh failed: ${String(Object.prototype.hasOwnProperty.call(vars ?? {}, 'error') ? vars?.error : '{error}')}`;
    }
    if (key === 'groups.oncall') return 'Oncall Mode';
    if (key === 'groups.oncallHelp') return 'Oncall help';
    if (key === 'groups.leaveTitle') return 'Select Bots to Leave';
    if (key === 'groups.dangerHint') return 'Danger hint';
    if (key === 'groups.leaveSelected') return 'Selected Bots Leave';
    if (key === 'groups.disband') return 'Disband';
    if (key === 'groups.owner') return 'Owner';
    if (key === 'groups.save') return 'Save';
    if (key === 'sessions.dismiss') return 'Dismiss';
    if (key === 'common.unknown') return 'Unknown';
    return key;
  };
  type ReloadGroups = React.ComponentProps<typeof ManageDialog>['onReloadGroups'];
  const emptyReload: ReloadGroups = async () => ({ chats: [], bots: [] });
  const manageElement = (
    chat: GroupChat,
    onReloadGroups: ReloadGroups = emptyReload,
    available?: boolean,
  ) => React.createElement(ManageDialog, {
    chat,
    available,
    tr,
    onClose: () => undefined,
    onReloadGroups,
  });
  const renderManage = (chat: GroupChat, onReloadGroups?: ReloadGroups) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(manageElement(chat, onReloadGroups)); });
    return renderer;
  };
  const groupPinToggle = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByProps({
    'data-action': 'toggle-pin-streaming-card-group',
    'data-app-id': 'cli_a',
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    __testOnly_resetGroupsSnapshotCache();
    groupsPageMount.node = null;
    confirmDialog.confirm.mockReset();
    confirmDialog.confirm.mockResolvedValue(false);
    toastModule.toast.mockReset();
  });

  it('keeps the open manage dialog synced to reloads and falls back if the chat is missing', async () => {
    const initialChat = makeChat([makeMember({
      botName: 'Claude (stale)',
      oncallChat: { workingDir: '/srv/stale-repo' },
    })]);
    const reloadedChat = makeChat([makeMember({
      botName: 'Claude (fresh)',
      oncallChat: { workingDir: '/srv/fresh-repo' },
      pinStreamingCardChatEnabled: true,
      pinStreamingCardEffectiveEnabled: true,
    })], { name: 'Release Room (fresh)' });
    const requests: string[] = [];
    const initialResponse = deferred<any>();
    const saveResponse = deferred<any>();
    const staleManualResponse = deferred<any>();
    const refreshedResponse = deferred<any>();
    const missingResponse = deferred<any>();
    const refreshResponses = [staleManualResponse, refreshedResponse, missingResponse];
    const refreshRequests = refreshResponses.map(() => deferred<void>());
    let refreshCount = 0;
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (url === '/api/groups') {
        return initialResponse.promise;
      }
      if (url === '/api/role-profiles') {
        return Promise.resolve(jsonResponse({ profiles: [] }));
      }
      if (url === '/api/groups/oc_group/pin-streaming-card/cli_a' && method === 'PUT') {
        return saveResponse.promise;
      }
      if (url === '/api/groups?refresh=1') {
        const response = refreshResponses[refreshCount];
        refreshRequests[refreshCount].resolve();
        refreshCount += 1;
        return response.promise;
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement);
    });
    await vi.waitFor(() => expect(requests).toContain('GET /api/groups'));
    await act(async () => {
      initialResponse.resolve(jsonResponse({ chats: [initialChat], bots: [] }));
    });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ className: 'manage-chat' })).toHaveLength(1);
    });

    act(() => {
      renderer.root.findByProps({ className: 'manage-chat' }).props.onClick();
    });
    act(() => {
      renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });
    const stalePinOnChange = groupPinToggle(renderer).props.onChange;
    const staleOncallToggleChange = renderer.root.findByProps({ 'data-action': 'toggle' }).props.onChange;
    const staleOncallInputChange = renderer.root.findByProps({ 'data-input': 'workingDir' }).props.onChange;
    const staleOncallSaveClick = renderer.root.findByProps({ 'data-action': 'save' }).props.onClick;
    const staleLeaveCheckboxChange = renderer.root
      .findByProps({ name: 'leave-bot', value: 'cli_a' }).props.onChange;
    const staleLeaveClick = renderer.root.findByProps({ id: 'g-leave-btn' }).props.onClick;
    const staleDisbandClick = renderer.root.findByProps({ id: 'g-disband-btn' }).props.onClick;

    expect(renderer.root.findByType('h3').children.join('')).toContain('Release Room');
    expect(groupPinToggle(renderer).props.checked).toBe(false);
    expect(renderer.root.findByProps({ 'data-pin-master-state': 'on' }).children.join(''))
      .toContain('不会置顶');

    act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
    await refreshRequests[0].promise;
    act(() => {
      groupPinToggle(renderer).props.onChange({ currentTarget: { checked: true } });
    });
    await vi.waitFor(() => expect(requests).toContain('PUT /api/groups/oc_group/pin-streaming-card/cli_a'));
    await act(async () => {
      saveResponse.resolve(jsonResponse({ ok: true }));
      await refreshRequests[1].promise;
    });
    await act(async () => {
      refreshedResponse.resolve(jsonResponse({ chats: [reloadedChat], bots: [] }));
    });
    await waitForRender(() => {
      expect(renderer.root.findByType('h3').children.join('')).toContain('Release Room (fresh)');
    });

    expect(renderer.root.findAllByType(ManageDialog)).toHaveLength(1);
    expect(groupPinToggle(renderer).props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'data-pin-master-state': 'on' }).children.join(''))
      .toContain('会置顶');
    expect(renderer.root.findByType(ManageDialog).findAllByType('strong').some(node =>
      node.children.join('') === 'Claude (fresh)'
    )).toBe(true);

    await act(async () => { staleManualResponse.reject(new Error('stale_refresh_failed')); });
    expect(renderer.root.findByType('h3').children.join('')).toContain('Release Room (fresh)');
    expect(groupPinToggle(renderer).props.checked).toBe(true);
    expect(renderer.root.findAll(node => node.props.className === 'hint-warn'
      && node.children.join('').includes('stale_refresh_failed'))).toHaveLength(0);

    act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
    await act(async () => {
      await refreshRequests[2].promise;
      missingResponse.resolve(jsonResponse({ chats: [], bots: [] }));
    });
    await waitForRender(() => {
      expect(renderer.root.findByType('h3').children.join('')).toContain('Release Room');
      expect(renderer.root.findByType('h3').children.join('')).not.toContain('Release Room (fresh)');
    });
    expect(renderer.root.findAllByType(ManageDialog)).toHaveLength(1);
    expect(renderer.root.findByType(ManageDialog).findAllByType('strong').some(node =>
      node.children.join('') === 'Claude (stale)'
    )).toBe(true);

    const pinToggle = groupPinToggle(renderer);
    const oncallToggle = renderer.root.findByProps({ 'data-action': 'toggle' });
    const oncallInput = renderer.root.findByProps({ 'data-input': 'workingDir' });
    const oncallSave = renderer.root.findByProps({ 'data-action': 'save' });
    const leaveCheckbox = renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' });
    const leaveButton = renderer.root.findByProps({ id: 'g-leave-btn' });
    const disbandButton = renderer.root.findByProps({ id: 'g-disband-btn' });
    expect(pinToggle.props.disabled).toBe(true);
    expect(oncallToggle.props.disabled).toBe(true);
    expect(oncallInput.props.disabled).toBe(true);
    expect(oncallSave.props.disabled).toBe(true);
    expect(leaveCheckbox.props.disabled).toBe(true);
    expect(leaveButton.props.disabled).toBe(true);
    expect(disbandButton.props.disabled).toBe(true);

    const mutationsBefore = requests.filter(request => !request.startsWith('GET '));
    confirmDialog.confirm.mockResolvedValue(true);
    await act(async () => {
      stalePinOnChange({ currentTarget: { checked: false } });
      staleOncallToggleChange({ currentTarget: { checked: false } });
      staleOncallInputChange({ currentTarget: { value: '/srv/should-not-save' } });
      staleOncallSaveClick();
      staleLeaveCheckboxChange({ currentTarget: { checked: true } });
      staleLeaveClick();
      staleDisbandClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual(mutationsBefore);
    expect(confirmDialog.confirm).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('applies an earlier save reload after a later manual refresh fails', async () => {
    const initialChat = makeChat([makeMember({ botName: 'Claude (stale)' })]);
    const savedChat = makeChat([makeMember({
      botName: 'Claude (saved)',
      pinStreamingCardChatEnabled: true,
      pinStreamingCardEffectiveEnabled: true,
    })], { name: 'Saved Room' });
    primeGroupsSnapshotCache({ chats: [initialChat], bots: [] });
    const saveResponse = deferred<any>();
    const saveReloadResponse = deferred<any>();
    const manualReloadResponse = deferred<any>();
    const reloadStarted = [deferred<void>(), deferred<void>()];
    let reloadCount = 0;
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      if (url === '/api/groups/oc_group/pin-streaming-card/cli_a' && init?.method === 'PUT') {
        return saveResponse.promise;
      }
      if (url === '/api/groups?refresh=1') {
        const index = reloadCount++;
        reloadStarted[index].resolve();
        return index === 0 ? saveReloadResponse.promise : manualReloadResponse.promise;
      }
      throw new Error(`Unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ className: 'manage-chat' })).toHaveLength(1);
    });
    act(() => { renderer.root.findByProps({ className: 'manage-chat' }).props.onClick(); });
    act(() => { groupPinToggle(renderer).props.onChange({ currentTarget: { checked: true } }); });
    await act(async () => {
      saveResponse.resolve(jsonResponse({ ok: true }));
      await reloadStarted[0].promise;
    });

    act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
    await reloadStarted[1].promise;
    await act(async () => { manualReloadResponse.reject(new Error('later_manual_failed')); });
    expect(renderer.root.findAll(node => node.props.className === 'hint-warn'
      && node.children.join('').includes('later_manual_failed'))).toHaveLength(1);

    await act(async () => {
      saveReloadResponse.resolve(jsonResponse({ chats: [savedChat], bots: [] }));
    });

    expect(renderer.root.findByType('h3').children.join('')).toContain('Saved Room');
    expect(groupPinToggle(renderer).props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'data-pin-master-state': 'on' }).children.join(''))
      .toContain('会置顶');
    expect(renderer.root.findAll(node => node.props.className === 'hint-warn'
      && node.children.join('').includes('later_manual_failed'))).toHaveLength(0);
    await expect(fetchGroupsSnapshot()).resolves.toEqual({ chats: [savedChat], bots: [] });

    act(() => renderer.unmount());
  });

  it('clears a later manual refresh error when an earlier create poll succeeds', async () => {
    const bot = { larkAppId: 'cli_a', botName: 'Claude' };
    primeGroupsSnapshotCache({ chats: [], bots: [bot] });
    const createResponse = deferred<any>();
    const pollingResponse = deferred<any>();
    const manualResponse = deferred<any>();
    const refreshRequests = [deferred<void>(), deferred<void>()];
    const pollDelayProcessed = deferred<void>();
    let refreshCount = 0;
    const nativeDocument = (globalThis as any).document;
    const nativeWindow = (globalThis as any).window;
    const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
    const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
    let releasePollDelay: (() => void) | undefined;
    (globalThis as any).document = {
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
    };
    (globalThis as any).window = {
      setTimeout(callback: () => void, ms?: number) {
        if (ms === 600 && !releasePollDelay) {
          releasePollDelay = () => {
            callback();
            queueMicrotask(() => pollDelayProcessed.resolve());
          };
          return 92;
        }
        return hostSetTimeout(callback, ms);
      },
      clearTimeout: hostClearTimeout,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      open() {},
    };
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      if (url === '/api/feed-groups') {
        return Promise.resolve(jsonResponse({ ok: true, groups: [], larkAppId: 'cli_a' }));
      }
      if (url === '/api/groups/create' && init?.method === 'POST') return createResponse.promise;
      if (url === '/api/groups?refresh=1') {
        const index = refreshCount++;
        refreshRequests[index].resolve();
        return index === 0 ? pollingResponse.promise : manualResponse.promise;
      }
      throw new Error(`Unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });
    await waitForRender(() => {
      expect(renderer.root.findAllByType('button').filter(node => node.props.id === 'g-create')).toHaveLength(1);
    });
    await act(async () => {
      renderer.root.findAllByType('button').find(node => node.props.id === 'g-create')!.props.onClick();
    });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ id: 'g-createform' })).toHaveLength(1);
    });
    act(() => {
      renderer.root.findByProps({ type: 'checkbox', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });

    const nativeFormData = globalThis.FormData;
    (globalThis as any).FormData = class {
      get(name: string): string { return name === 'name' ? 'Created Room' : ''; }
    };
    try {
      act(() => {
        renderer.root.findByProps({ id: 'g-createform' }).props.onSubmit({
          preventDefault() {},
          currentTarget: {},
        });
      });
      await act(async () => {
        createResponse.resolve(jsonResponse({ ok: true, chatId: 'oc_created', creator: 'cli_a' }));
      });
      await vi.waitFor(() => expect(releasePollDelay).toBeTypeOf('function'));
      act(() => { renderer.root.findByProps({ id: 'g-create-close' }).props.onClick(); });

      await act(async () => {
        releasePollDelay!();
        await pollDelayProcessed.promise;
        await refreshRequests[0].promise;
      });
      act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
      await refreshRequests[1].promise;
      await act(async () => { manualResponse.reject(new Error('later_manual_failed')); });
      expect(renderer.root.findAll(node => node.props.className === 'hint-warn'
        && node.children.join('').includes('later_manual_failed'))).toHaveLength(1);

      const polledChat = makeChat([makeMember()], { chatId: 'oc_created', name: 'Polled Room' });
      await act(async () => {
        pollingResponse.resolve(jsonResponse({ chats: [polledChat], bots: [bot] }));
      });
      await waitForRender(() => {
        expect(renderer.root.findByProps({ 'data-chat': 'oc_created' }).findByType('b').children.join(''))
          .toBe('Polled Room');
      });
      expect(renderer.root.findAll(node => node.props.className === 'hint-warn'
        && node.children.join('').includes('later_manual_failed'))).toHaveLength(0);
    } finally {
      (globalThis as any).FormData = nativeFormData;
      (globalThis as any).document = nativeDocument;
      (globalThis as any).window = nativeWindow;
      act(() => renderer.unmount());
    }
  });

  it('does not let an older create poll overwrite a newer manual reload', async () => {
    const bot = { larkAppId: 'cli_a', botName: 'Claude' };
    primeGroupsSnapshotCache({ chats: [], bots: [bot] });
    const createResponse = deferred<any>();
    const manualResponse = deferred<any>();
    const pollingResponse = deferred<any>();
    const refreshRequests = [deferred<void>(), deferred<void>()];
    const pollDelayProcessed = deferred<void>();
    let refreshCount = 0;
    const nativeDocument = (globalThis as any).document;
    const nativeWindow = (globalThis as any).window;
    const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
    const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
    let releasePollDelay: (() => void) | undefined;
    (globalThis as any).document = {
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
    };
    (globalThis as any).window = {
      setTimeout(callback: () => void, ms?: number) {
        if (ms === 600 && !releasePollDelay) {
          releasePollDelay = () => {
            callback();
            queueMicrotask(() => pollDelayProcessed.resolve());
          };
          return 91;
        }
        return hostSetTimeout(callback, ms);
      },
      clearTimeout: hostClearTimeout,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      open() {},
    };
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      if (url === '/api/feed-groups') {
        return Promise.resolve(jsonResponse({ ok: true, groups: [], larkAppId: 'cli_a' }));
      }
      if (url === '/api/groups/create' && init?.method === 'POST') return createResponse.promise;
      if (url === '/api/groups?refresh=1') {
        refreshRequests[refreshCount].resolve();
        refreshCount += 1;
        return refreshCount === 1 ? manualResponse.promise : pollingResponse.promise;
      }
      throw new Error(`Unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });
    await waitForRender(() => {
      expect(renderer.root.findAllByType('button').filter(node => node.props.id === 'g-create')).toHaveLength(1);
    });
    await act(async () => {
      renderer.root.findAllByType('button').find(node => node.props.id === 'g-create')!.props.onClick();
    });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ id: 'g-createform' })).toHaveLength(1);
    });
    act(() => {
      renderer.root.findByProps({ type: 'checkbox', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });

    const nativeFormData = globalThis.FormData;
    (globalThis as any).FormData = class {
      get(name: string): string { return name === 'name' ? 'Created Room' : ''; }
    };
    try {
      act(() => {
        renderer.root.findByProps({ id: 'g-createform' }).props.onSubmit({
          preventDefault() {},
          currentTarget: {},
        });
      });
      await act(async () => {
        createResponse.resolve(jsonResponse({
          ok: true,
          chatId: 'oc_created',
          creator: 'cli_a',
        }));
      });
      await vi.waitFor(() => expect(releasePollDelay).toBeTypeOf('function'));
      act(() => { renderer.root.findByProps({ id: 'g-create-close' }).props.onClick(); });

      act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
      await refreshRequests[0].promise;
      const newestChat = makeChat([makeMember()], { chatId: 'oc_created', name: 'Newest Room' });
      await act(async () => {
        manualResponse.resolve(jsonResponse({ chats: [newestChat], bots: [bot] }));
      });
      expect(renderer.root.findByProps({ 'data-chat': 'oc_created' }).findByType('b').children.join(''))
        .toBe('Newest Room');

      await act(async () => {
        releasePollDelay!();
        await pollDelayProcessed.promise;
      });

      expect(refreshCount).toBe(1);
      expect(renderer.root.findByProps({ 'data-chat': 'oc_created' }).findByType('b').children.join(''))
        .toBe('Newest Room');
    } finally {
      (globalThis as any).FormData = nativeFormData;
      (globalThis as any).document = nativeDocument;
      (globalThis as any).window = nativeWindow;
      act(() => renderer.unmount());
    }
  });

  it('does not let an older forced page reload overwrite a newer successful reload', async () => {
    const initialChat = makeChat([makeMember()], { name: 'Initial Room' });
    const olderChat = makeChat([makeMember()], { name: 'Older Room' });
    const newerChat = makeChat([makeMember()], { name: 'Newer Room' });
    const olderResponse = deferred<any>();
    const newerResponse = deferred<any>();
    let refreshCount = 0;

    primeGroupsSnapshotCache({ chats: [initialChat], bots: [] });
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      if (url === '/api/groups?refresh=1') {
        refreshCount += 1;
        if (refreshCount === 1) return olderResponse.promise;
        if (refreshCount === 2) return newerResponse.promise;
      }
      throw new Error(`Unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ className: 'manage-chat' })).toHaveLength(1);
    });
    act(() => { renderer.root.findByProps({ className: 'manage-chat' }).props.onClick(); });

    const reloadGroups = renderer.root.findByType(ManageDialog).props.onReloadGroups as ReloadGroups;
    let olderReload!: Promise<unknown>;
    let newerReload!: Promise<unknown>;
    act(() => {
      olderReload = reloadGroups({ force: true });
      newerReload = reloadGroups({ force: true });
    });
    await vi.waitFor(() => expect(refreshCount).toBe(2));

    await act(async () => {
      newerResponse.resolve(jsonResponse({ chats: [newerChat], bots: [] }));
      await newerReload;
    });
    expect(renderer.root.findByProps({ 'data-chat': 'oc_group' }).findByType('b').children.join(''))
      .toBe('Newer Room');

    await act(async () => {
      olderResponse.resolve(jsonResponse({ chats: [olderChat], bots: [] }));
      await olderReload;
    });
    expect(renderer.root.findByProps({ 'data-chat': 'oc_group' }).findByType('b').children.join(''))
      .toBe('Newer Room');

    act(() => renderer.unmount());
  });

  it('does not let an older page reload overwrite the shared cache after a newer external refresh succeeds', async () => {
    const initialChat = makeChat([makeMember({ botName: 'Claude (initial)' })], { name: 'Initial Room' });
    const pageAcceptedChat = makeChat([makeMember({ botName: 'Claude (older-page)' })], { name: 'Older Page Room' });
    const newestSharedChat = makeChat([makeMember({
      botName: 'Claude (newest-shared)',
      pinStreamingCardChatEnabled: true,
      pinStreamingCardEffectiveEnabled: true,
    })], { name: 'Newest Shared Room' });
    const pageReloadResponse = deferred<any>();
    const externalRefreshResponse = deferred<any>();
    const requests: string[] = [];
    let refreshCount = 0;

    primeGroupsSnapshotCache({ chats: [initialChat], bots: [] });
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${String(init?.method ?? 'GET')} ${url}`);
      if (url === '/api/groups?refresh=1') {
        refreshCount += 1;
        if (refreshCount === 1) return pageReloadResponse.promise;
        if (refreshCount === 2) return externalRefreshResponse.promise;
      }
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      throw new Error(`Unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });

    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ className: 'manage-chat' })).toHaveLength(1);
    });
    expect(renderer.root.findByProps({ 'data-chat': 'oc_group' }).findByType('b').children.join(''))
      .toBe('Initial Room');

    act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
    await vi.waitFor(() => expect(refreshCount).toBe(1));

    const externalRefresh = fetchGroupsSnapshot({ force: true });
    await vi.waitFor(() => expect(refreshCount).toBe(2));
    await expect((async () => {
      externalRefreshResponse.resolve(jsonResponse({ chats: [newestSharedChat], bots: [] }));
      return externalRefresh;
    })()).resolves.toEqual({ chats: [newestSharedChat], bots: [] });
    await act(async () => {
      pageReloadResponse.resolve(jsonResponse({ chats: [pageAcceptedChat], bots: [] }));
    });

    await waitForRender(() => {
      expect(renderer.root.findByProps({ 'data-chat': 'oc_group' }).findByType('b').children.join(''))
        .toBe('Older Page Room');
    });
    await expect(fetchGroupsSnapshot()).resolves.toEqual({ chats: [newestSharedChat], bots: [] });

    act(() => renderer.unmount());
  });

  it('ignores a pre-write snapshot during save when the post-write reload fails', async () => {
    const initialMember = makeMember();
    const freshMember = { ...initialMember };
    const saveResponse = deferred<any>();
    (globalThis as any).fetch = vi.fn(() => saveResponse.promise);
    const onReloadGroups = vi.fn(async () => { throw new Error('reload_failed'); });
    let renderer!: TestRenderer.ReactTestRenderer;
    const renderDialog = (member: GroupMember) => manageElement(makeChat([member]), onReloadGroups);

    renderer = renderManage(makeChat([initialMember]), onReloadGroups);
    act(() => {
      groupPinToggle(renderer).props.onChange({ currentTarget: { checked: true } });
    });
    act(() => { renderer.update(renderDialog(freshMember)); });

    expect(groupPinToggle(renderer).props.checked).toBe(true);

    await act(async () => {
      saveResponse.resolve(jsonResponse({ ok: true }));
      await vi.waitFor(() => expect(onReloadGroups).toHaveBeenCalledOnce());
    });
    expect(groupPinToggle(renderer).props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'data-pin-status': 'cli_a' }).children.join(''))
      .toContain('refresh failed');
  });

  it('applies a fresh post-write member snapshot even when it keeps the old server value', async () => {
    const initialChat = makeChat([makeMember({ botName: 'Claude (stale)' })]);
    const reloadedChat = makeChat([makeMember({ botName: 'Claude (fresh)' })]);
    (globalThis as any).fetch = vi.fn(async () => jsonResponse({ ok: true }));
    let renderer!: TestRenderer.ReactTestRenderer;
    const onReloadGroups = vi.fn(async () => {
      renderer.update(manageElement(reloadedChat, onReloadGroups));
      return { chats: [reloadedChat], bots: [] };
    });
    renderer = renderManage(initialChat, onReloadGroups);

    await act(async () => {
      groupPinToggle(renderer).props.onChange({ currentTarget: { checked: true } });
      await vi.waitFor(() => expect(onReloadGroups).toHaveBeenCalledOnce());
    });

    expect(groupPinToggle(renderer).props.checked).toBe(false);
    expect(renderer.root.findByProps({ 'data-pin-master-state': 'on' }).children.join(''))
      .toContain('does not pin');
  });

  it('refreshes pristine oncall fields but preserves a dirty working-directory draft', () => {
    const initialMember = makeMember({ oncallChat: null });
    const freshMember = makeMember({ oncallChat: { workingDir: '/srv/fresh-repo' } });
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    const renderer = renderManage(makeChat([initialMember]), onReloadGroups);

    expect(renderer.root.findByProps({ 'data-action': 'toggle' }).props.checked).toBe(false);
    expect(renderer.root.findByProps({ 'data-input': 'workingDir' }).props.value).toBe('');

    act(() => { renderer.update(manageElement(makeChat([freshMember]), onReloadGroups)); });

    expect(renderer.root.findByProps({ 'data-action': 'toggle' }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'data-input': 'workingDir' }).props.value).toBe('/srv/fresh-repo');

    act(() => {
      renderer.root.findByProps({ 'data-input': 'workingDir' })
        .props.onChange({ currentTarget: { value: '/unsaved-user-edit' } });
    });
    act(() => {
      renderer.update(manageElement(makeChat([{
        ...freshMember,
        botName: 'Claude (metadata refreshed)',
      }]), onReloadGroups));
    });

    expect(renderer.root.findByProps({ 'data-input': 'workingDir' }).props.value)
      .toBe('/unsaved-user-edit');
  });

  it('locks oncall fields while a save is pending', async () => {
    const saveResponse = deferred<any>();
    const fetchMock = vi.fn(() => saveResponse.promise);
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    const renderer = renderManage(makeChat([makeMember({
      oncallChat: { workingDir: '/srv/current-repo' },
    })]), onReloadGroups);
    const staleToggleChange = renderer.root.findByProps({ 'data-action': 'toggle' }).props.onChange;
    const staleInputChange = renderer.root.findByProps({ 'data-input': 'workingDir' }).props.onChange;
    const staleSaveClick = renderer.root.findByProps({ 'data-action': 'save' }).props.onClick;

    act(() => {
      staleSaveClick();
    });

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle' });
    const input = renderer.root.findByProps({ 'data-input': 'workingDir' });
    const save = renderer.root.findByProps({ 'data-action': 'save' });
    expect(toggle.props.disabled).toBe(true);
    expect(input.props.disabled).toBe(true);
    expect(save.props.disabled).toBe(true);

    act(() => {
      staleToggleChange({ currentTarget: { checked: false } });
      staleInputChange({ currentTarget: { value: '/srv/during-save' } });
      staleSaveClick();
    });
    expect(renderer.root.findByProps({ 'data-action': 'toggle' }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'data-input': 'workingDir' }).props.value)
      .toBe('/srv/current-repo');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      saveResponse.resolve(jsonResponse({ ok: true, resolvedPath: '/srv/current-repo' }));
      await saveResponse.promise;
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/groups/oc_group/oncall/cli_a',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ workingDir: '/srv/current-repo' }),
      }),
    );
  });

  it('keeps the submitted oncall working directory when an older snapshot arrives before a failed reload', async () => {
    const saveResponse = deferred<any>();
    const reloadResponse = deferred<any>();
    (globalThis as any).fetch = vi.fn(() => saveResponse.promise);
    const onReloadGroups = vi.fn(() => reloadResponse.promise);
    const oldMember = makeMember({ oncallChat: { workingDir: '/srv/old-repo' } });
    const renderer = renderManage(makeChat([oldMember]), onReloadGroups);

    act(() => {
      renderer.root.findByProps({ 'data-input': 'workingDir' })
        .props.onChange({ currentTarget: { value: '/srv/submitted-repo' } });
    });
    act(() => {
      renderer.root.findByProps({ 'data-action': 'save' }).props.onClick();
    });

    await act(async () => {
      saveResponse.resolve(jsonResponse({ ok: true, resolvedPath: '/srv/submitted-repo' }));
      await vi.waitFor(() => expect(onReloadGroups).toHaveBeenCalledOnce());
    });
    act(() => {
      renderer.update(manageElement(makeChat([{
        ...oldMember,
        botName: 'Claude (older snapshot)',
      }]), onReloadGroups));
    });
    await act(async () => {
      reloadResponse.reject(new Error('reload_failed'));
      await reloadResponse.promise.catch(() => undefined);
    });

    expect(renderer.root.findByProps({ 'data-input': 'workingDir' }).props.value)
      .toBe('/srv/submitted-repo');
    expect(renderer.root.findByProps({ 'data-status': true }).children.join(''))
      .toContain('reload_failed');
  });

  it('drops a selected leave target when a fresh chat snapshot removes that member', () => {
    const initialMember = makeMember();
    const freshMember = makeMember({ larkAppId: 'cli_b', botName: 'Codex' });
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    const renderer = renderManage(makeChat([initialMember]), onReloadGroups);
    act(() => {
      renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });

    act(() => { renderer.update(manageElement(makeChat([freshMember]), onReloadGroups)); });
    expect(renderer.root.findAllByProps({ name: 'leave-bot', value: 'cli_a' })).toHaveLength(0);

    act(() => {
      renderer.root.findByProps({ id: 'g-leave-btn' }).props.onClick();
    });

    expect(confirmDialog.confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not submit a selected leave target removed while confirmation is open', async () => {
    const initialMember = makeMember();
    const freshMember = makeMember({ larkAppId: 'cli_b', botName: 'Codex' });
    const confirmation = deferred<boolean>();
    confirmDialog.confirm.mockReturnValueOnce(confirmation.promise);
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    const renderer = renderManage(makeChat([initialMember]), onReloadGroups);
    act(() => {
      renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });
    act(() => {
      renderer.root.findByProps({ id: 'g-leave-btn' }).props.onClick();
    });
    expect(confirmDialog.confirm).toHaveBeenCalledOnce();

    act(() => { renderer.update(manageElement(makeChat([freshMember]), onReloadGroups)); });
    await act(async () => { confirmation.resolve(true); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not submit leave when the chat disappears while confirmation is open', async () => {
    const chat = makeChat([makeMember()]);
    const confirmation = deferred<boolean>();
    confirmDialog.confirm.mockReturnValueOnce(confirmation.promise);
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const renderer = renderManage(chat);
    act(() => {
      renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });
    act(() => { renderer.root.findByProps({ id: 'g-leave-btn' }).props.onClick(); });
    expect(confirmDialog.confirm).toHaveBeenCalledOnce();

    act(() => { renderer.update(manageElement(chat, emptyReload, false)); });
    await act(async () => { confirmation.resolve(true); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not submit disband when the chat disappears while confirmation is open', async () => {
    const chat = makeChat([makeMember()]);
    const confirmation = deferred<boolean>();
    confirmDialog.confirm.mockReturnValueOnce(confirmation.promise);
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const renderer = renderManage(chat);
    act(() => { renderer.root.findByProps({ id: 'g-disband-btn' }).props.onClick(); });
    expect(confirmDialog.confirm).toHaveBeenCalledOnce();

    act(() => { renderer.update(manageElement(chat, emptyReload, false)); });
    await act(async () => { confirmation.resolve(true); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'leave', buttonId: 'g-leave-btn' },
    { action: 'disband', buttonId: 'g-disband-btn' },
  ] as const)('closes the mounted manage dialog after successful $action when a concurrent refresh removes the chat', async ({ action, buttonId }) => {
    const chat = makeChat([makeMember()]);
    const mutationResponse = deferred<any>();
    const mutationStarted = deferred<void>();
    const requests: string[] = [];
    primeGroupsSnapshotCache({ chats: [chat], bots: [] });
    confirmDialog.confirm.mockResolvedValueOnce(true);
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      requests.push(`${method} ${url}`);
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      if (url === `/api/groups/oc_group/${action}` && method === 'POST') {
        mutationStarted.resolve();
        return mutationResponse.promise;
      }
      if (url === '/api/groups?refresh=1') {
        return Promise.resolve(jsonResponse({ chats: [], bots: [] }));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ className: 'manage-chat' })).toHaveLength(1);
    });

    act(() => { renderer.root.findByProps({ className: 'manage-chat' }).props.onClick(); });
    if (action === 'leave') {
      act(() => {
        renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' })
          .props.onChange({ currentTarget: { checked: true } });
      });
    }
    act(() => { renderer.root.findByProps({ id: buttonId }).props.onClick(); });
    await mutationStarted.promise;

    act(() => { renderer.root.findByProps({ id: 'g-refresh' }).props.onClick(); });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ 'data-chat-unavailable': true })).toHaveLength(1);
    });

    await act(async () => {
      mutationResponse.resolve(jsonResponse(action === 'leave'
        ? { result: [{ larkAppId: 'cli_a', ok: true, closedSessions: [] }] }
        : { ok: true, closedSessions: [] }));
      await mutationResponse.promise;
      await Promise.resolve();
    });

    expect(renderer.root.findAllByType(ManageDialog)).toHaveLength(0);
    expect(requests).toContain(`POST /api/groups/oc_group/${action}`);
    expect(toastModule.toast.mock.calls.filter(([, options]) => options?.kind === 'success')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('stops disbanding remaining bots when the dialog unmounts before the first request fails', async () => {
    const firstDisband = deferred<any>();
    const requests: string[] = [];
    confirmDialog.confirm.mockResolvedValueOnce(true);
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      requests.push(`${String(init?.method ?? 'GET')} ${String(input)} ${String((init?.body as string | undefined) ?? '')}`);
      return firstDisband.promise;
    });
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    const renderer = renderManage(makeChat([
      makeMember({ larkAppId: 'cli_a', botName: 'Claude' }),
      makeMember({ larkAppId: 'cli_b', botName: 'Codex' }),
    ], { ownerId: 'cli_b' }), onReloadGroups);

    act(() => { renderer.root.findByProps({ id: 'g-disband-btn' }).props.onClick(); });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    act(() => renderer.unmount());
    await act(async () => {
      firstDisband.reject(new Error('first_failed'));
      await firstDisband.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('POST /api/groups/oc_group/disband');
    expect(onReloadGroups).not.toHaveBeenCalled();
  });

  it('does not let an old leave completion close a replacement manage dialog', async () => {
    const chatA = makeChat([makeMember({ larkAppId: 'cli_a', botName: 'Claude' })], {
      chatId: 'oc_group_a',
      name: 'Room A',
    });
    const chatB = makeChat([makeMember({ larkAppId: 'cli_b', botName: 'Codex' })], {
      chatId: 'oc_group_b',
      name: 'Room B',
    });
    const leaveResponse = deferred<any>();
    const requests: string[] = [];
    primeGroupsSnapshotCache({ chats: [chatA, chatB], bots: [] });
    confirmDialog.confirm.mockResolvedValueOnce(true);
    (globalThis as any).fetch = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      requests.push(`${method} ${url}`);
      if (url === '/api/role-profiles') return Promise.resolve(jsonResponse({ profiles: [] }));
      if (url === '/api/groups/oc_group_a/leave' && method === 'POST') return leaveResponse.promise;
      if (url === '/api/groups?refresh=1') return Promise.resolve(jsonResponse({ chats: [chatA, chatB], bots: [] }));
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(groupsPageMount.node as React.ReactElement); });
    await waitForRender(() => {
      expect(renderer.root.findAllByProps({ className: 'manage-chat' })).toHaveLength(2);
    });

    const manageButtons = renderer.root.findAllByProps({ className: 'manage-chat' });
    act(() => { manageButtons[0].props.onClick(); });
    expect(renderer.root.findByType('h3').children.join('')).toContain('Room A');
    act(() => {
      renderer.root.findByProps({ name: 'leave-bot', value: 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });
    act(() => { renderer.root.findByProps({ id: 'g-leave-btn' }).props.onClick(); });
    await vi.waitFor(() => expect(requests).toContain('POST /api/groups/oc_group_a/leave'));

    act(() => { manageButtons[1].props.onClick(); });
    expect(renderer.root.findByType('h3').children.join('')).toContain('Room B');
    await act(async () => {
      leaveResponse.resolve(jsonResponse({ result: [{ larkAppId: 'cli_a', ok: true, closedSessions: [] }] }));
      await leaveResponse.promise;
      await Promise.resolve();
    });

    expect(renderer.root.findAllByType(ManageDialog)).toHaveLength(1);
    expect(renderer.root.findByType('h3').children.join('')).toContain('Room B');

    act(() => renderer.unmount());
  });

  it('shows master-off copy and keeps the row editable without letting the chat force-enable pinning', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as any;
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(ManageDialog, {
        chat: {
          chatId: 'oc_group',
          name: 'Release Room',
          ownerId: 'ou_owner',
          memberBots: [{
            larkAppId: 'cli_a',
            botName: 'Claude',
            inChat: true,
            pinStreamingCardMasterEnabled: false,
            pinStreamingCardChatEnabled: false,
            pinStreamingCardEffectiveEnabled: false,
          }],
        },
        tr,
        onClose: () => undefined,
        onReloadGroups,
      }));
    });

    expect(renderer.root.findByProps({ 'data-streaming-card-pin-toggle': 'group-manage' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-streaming-card-pin-help': 'group-manage' }).children.join(''))
      .toContain('exact group-level override route');
    expect(renderer.root.findByProps({ 'data-pin-master-state': 'off' }).children.join(''))
      .toContain('cannot force-enable');

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' });
    expect(toggle.props.disabled).toBe(false);

    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/groups/oc_group/pin-streaming-card/cli_a',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(onReloadGroups).toHaveBeenCalledWith({ force: true });
    const status = renderer.root.findByProps({ 'data-pin-status': 'cli_a' });
    expect(status.children.join('')).toBe('Saved');
    expect(String(status.props.className ?? '')).toContain('hint-ok');
    expect(String(status.props.className ?? '')).not.toContain('hint-warn-inline');
  });

  it('disables the row while saving and rolls the toggle back when the save fails', async () => {
    let resolveFetch!: (value: any) => void;
    const pending = new Promise<any>(resolve => { resolveFetch = resolve; });
    const fetchMock = vi.fn(() => pending) as any;
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(ManageDialog, {
        chat: {
          chatId: 'oc_group',
          name: 'Release Room',
          ownerId: 'ou_owner',
          memberBots: [{
            larkAppId: 'cli_a',
            botName: 'Claude',
            inChat: true,
            pinStreamingCardMasterEnabled: true,
            pinStreamingCardChatEnabled: false,
            pinStreamingCardEffectiveEnabled: false,
          }],
        },
        tr,
        onClose: () => undefined,
        onReloadGroups,
      }));
    });

    act(() => {
      renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
    });

    expect(renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'data-pin-status': 'cli_a' }).children.join('')).toContain('Saving');

    await act(async () => {
      resolveFetch({
        ok: false,
        status: 500,
        json: async () => ({ error: 'write_failed' }),
      });
      await pending;
    });

    expect(renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' }).props.checked).toBe(false);
    expect(renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' }).props.disabled).toBe(false);
    const status = renderer.root.findByProps({ 'data-pin-status': 'cli_a' });
    expect(status.children.join('')).toContain('write_failed');
    expect(String(status.props.className ?? '')).toContain('hint-warn-inline');
    expect(String(status.props.className ?? '')).not.toContain('hint-ok');
    expect(onReloadGroups).not.toHaveBeenCalled();
  });

  it('keeps the saved state when PUT succeeds but the forced reload rejects', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as any;
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => { throw new Error('reload_failed'); });
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(ManageDialog, {
        chat: {
          chatId: 'oc_group',
          name: 'Release Room',
          ownerId: 'ou_owner',
          memberBots: [{
            larkAppId: 'cli_a',
            botName: 'Claude',
            inChat: true,
            pinStreamingCardMasterEnabled: true,
            pinStreamingCardChatEnabled: false,
            pinStreamingCardEffectiveEnabled: false,
          }],
        },
        tr,
        onClose: () => undefined,
        onReloadGroups,
      }));
    });

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' })
        .props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': 'cli_a' }).props.checked)
      .toBe(true);
    const status = renderer.root.findByProps({ 'data-pin-status': 'cli_a' });
    expect(status.children.join('')).toContain('refresh failed');
    expect(status.children.join('')).not.toContain('Save failed');
    expect(String(status.props.className ?? '')).toContain('hint-warn-inline');
    expect(String(status.props.className ?? '')).not.toContain('hint-ok');
  });

  it('uses a distinct help id per row and points each checkbox aria-describedby at its own help element', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as any;
    (globalThis as any).fetch = fetchMock;
    const onReloadGroups = vi.fn(async () => ({ chats: [], bots: [] }));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(ManageDialog, {
        chat: {
          chatId: 'oc_group',
          name: 'Release Room',
          ownerId: 'ou_owner',
          memberBots: [
            {
              larkAppId: 'cli_a',
              botName: 'Claude',
              inChat: true,
              pinStreamingCardMasterEnabled: true,
              pinStreamingCardChatEnabled: false,
              pinStreamingCardEffectiveEnabled: false,
            },
            {
              larkAppId: 'cli_b',
              botName: 'Codex',
              inChat: true,
              pinStreamingCardMasterEnabled: false,
              pinStreamingCardChatEnabled: false,
              pinStreamingCardEffectiveEnabled: false,
            },
          ],
        },
        tr,
        onClose: () => undefined,
        onReloadGroups,
      }));
    });

    const rows = renderer.root.findAllByProps({ 'data-streaming-card-pin-help': 'group-manage' });
    expect(rows).toHaveLength(2);
    const ids = rows.map(row => row.props.id);
    expect(new Set(ids).size).toBe(2);

    for (const appId of ['cli_a', 'cli_b']) {
      const toggle = renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card-group', 'data-app-id': appId });
      const describedBy = String(toggle.props['aria-describedby'] ?? '');
      const helpId = rows.find(row => describedBy.includes(String(row.props.id)))?.props.id;
      expect(helpId).toBeTruthy();
      expect(describedBy).toContain(String(helpId));
    }
  });
});
