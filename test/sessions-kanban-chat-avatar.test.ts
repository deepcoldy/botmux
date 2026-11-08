import { beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { SessionsKanbanView } from '../src/dashboard/web/sessions-kanban.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOOP = (): void => {};
const ICONS = {
  close: 'c', details: 'd', feishu: 'f', history: 'h', key: 'k',
  lock: 'l', restart: 'r', terminal: 't', unlock: 'u',
};
const row = (sessionId: string, chatId: string, chatDisplayName: string) => ({
  sessionId, chatId, chatDisplayName, title: sessionId,
  larkAppId: 'app_avatar', cliId: 'claude', status: 'idle', lastMessageAt: 1,
});
const ROWS = [
  row('s_alone', 'oc_alone', '单会话群'),
  row('s_multi_1', 'oc_multi', '多会话群'),
  row('s_multi_2', 'oc_multi', '多会话群'),
];

function render(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionsKanbanView, {
      rows: ROWS, host: null,
      canRestartSession: () => true, icons: ICONS,
      lockActionLabel: () => 'lock', sessionStatusText: () => 'idle',
      selectedSessionIds: new Set<string>(),
      onDetails: NOOP, onHistory: NOOP, onMoveRows: NOOP, onRename: NOOP, onRestart: NOOP,
      onToggleLock: NOOP, onToggleSelect: NOOP,
    } as any));
  });
  return renderer;
}

function card(renderer: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance {
  return renderer.root.find(node => node.type === 'article' && node.props['data-id'] === id);
}

function avatars(node: ReactTestInstance): ReactTestInstance[] {
  return node.findAll(child => child.type === 'span' && child.props.className === 'kanban-card-avatar');
}

describe('看板卡片的群头像', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: NOOP, removeItem: NOOP } });
    vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} } });
  });

  it('a card that is alone in its chat shows that chat avatar in its head', () => {
    const renderer = render();
    const [avatar] = avatars(card(renderer, 's_alone'));
    expect(avatar).toBeDefined();
    expect(avatar!.props.title).toBe('单会话群');
    expect(avatar!.props.dangerouslySetInnerHTML.__html).toContain('orb-avatar');
    const head = avatar!.parent!;
    expect(head.props.className).toBe('kanban-card-head');
    // 放在勾选框后、CLI 徽标前：卡片左上角。
    const order = head.children.filter((c): c is ReactTestInstance => typeof c !== 'string').map(c => c.props.className ?? c.props.type);
    expect(order.slice(0, 3)).toEqual(['kanban-card-check', 'kanban-card-avatar', 'badge cli-claude']);
  });

  it('cards inside a chat cluster leave the avatar to the cluster header', () => {
    const renderer = render();
    const cluster = renderer.root.find(node => node.type === 'div' && node.props['data-chat'] === 'oc_multi');
    expect(cluster.findAll(node => node.props.className === 'kanban-cluster-avatar')).toHaveLength(1);
    const toggle = cluster.find(node => node.type === 'button' && node.props.className === 'kanban-cluster-toggle');
    act(() => { toggle.props.onClick({ stopPropagation: NOOP }); });
    for (const id of ['s_multi_1', 's_multi_2']) expect(avatars(card(renderer, id))).toEqual([]);
  });
});
