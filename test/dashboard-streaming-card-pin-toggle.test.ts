import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CardBehaviorSection } from '../src/dashboard/web/bot-defaults-page.js';
import { ManageDialog } from '../src/dashboard/web/groups-page.js';
import { StreamingCardPinToggle } from '../src/dashboard/web/streaming-card-pin-toggle.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function findByDataAction(
  renderer: TestRenderer.ReactTestRenderer,
  action: string,
) {
  return renderer.root.findByProps({ 'data-action': action });
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

  beforeEach(() => {
    vi.restoreAllMocks();
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
