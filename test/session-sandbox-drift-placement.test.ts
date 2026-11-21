/**
 * 沙盒漂移徽标的「落点」回归（第六次同步 master 时由冲突解决引入）。
 *
 * #2552 把会话看板卡从 sessions-page 的 BoardCard 拆进 sessions-kanban 的
 * SessionsKanbanView，与本 PR 在 sessions-page 加 SandboxDriftChip 产生过冲突。
 * 单测组件本身（dashboard-sandbox-hints-ui）只证明 chip 会渲染，证明不了两个
 * 列表视图真的把它接上了——这里钉死两个落点：表格 status 列、看板卡片头。
 * 任一落点被删（例如下次再解冲突漏掉）这两条必须变红。
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// SessionsKanbanView 渲染卡片时会调 loadNameMaps 链路里的名字快照，先 mock 掉网络依赖。
vi.mock('../src/dashboard/web/groups-api.js', () => ({
  fetchGroupsNamesSnapshot: vi.fn(async () => ({ bots: [], chats: [] })),
}));

import { SessionsKanbanView, type SessionsKanbanCallbacks } from '../src/dashboard/web/sessions-kanban.js';
import { SessionsTableBase } from '../src/dashboard/web/sessions-page.js';

const DRIFT = { session: 'scratch', current: 'off' } as const;

const kanbanCallbacks: SessionsKanbanCallbacks = {
  canRestartSession: () => true,
  icons: { feishu: '', history: '', lock: '', restart: '', close: '', terminal: '', unlock: '', details: '' },
  lockActionLabel: () => 'lock',
  sessionStatusText: (s: unknown) => String(s ?? 'unknown'),
  onClose: () => {}, onDetails: () => {}, onHistory: () => {}, onMoveRows: () => {},
  onOpenTerminal: () => {}, onRename: () => {}, onRestart: () => {},
  onToggleLock: () => {}, onToggleSelect: () => {},
  selectedSessionIds: new Set<string>(),
};

const kanbanRow = {
  sessionId: 's_drift_kanban', status: 'active', cliId: 'codex',
  title: '漂移看板卡', botName: 'Bot A', lastMessageAt: 1000,
  sandboxDrift: DRIFT,
};

const tableRow = {
  sessionId: 's_drift_table', status: 'active', cliId: 'codex',
  title: '漂移表格行', chatId: 'oc_1', rootMessageId: 'om_1',
  createdAt: 1000, lastMessageAt: 1000,
  sandboxDrift: DRIFT,
};

describe('SandboxDriftChip 落点（#2552 重构后两个主列表视图都要在）', () => {
  it('看板卡片头渲染沙盒漂移徽标', () => {
    const html = renderToStaticMarkup(createElement(SessionsKanbanView, {
      host: null, ...kanbanCallbacks, rows: [kanbanRow],
    }));
    expect(html).toContain('data-sandbox-drift');
  });

  it('看板卡片对没有漂移的会话不渲染徽标', () => {
    const html = renderToStaticMarkup(createElement(SessionsKanbanView, {
      host: null, ...kanbanCallbacks, rows: [{ ...kanbanRow, sandboxDrift: undefined }],
    }));
    expect(html).not.toContain('data-sandbox-drift');
  });

  it('会话表格的 status 列渲染沙盒漂移徽标', () => {
    const html = renderToStaticMarkup(createElement(SessionsTableBase, {
      rows: [tableRow], limit: 50, onShowMore: () => {}, selected: new Set<string>(),
      hidden: false, sortKey: 'lastMessageAt', sortDir: 'desc',
      selectAllChecked: false, selectAllIndeterminate: false, selectAllDisabled: false,
      hiddenColumns: new Set<string>(), onToggleColumn: () => {}, onResetColumns: () => {},
      onOpen: () => {}, onSelect: () => {}, onSelectAll: () => {}, onSort: () => {},
    }));
    expect(html).toContain('data-sandbox-drift');
  });
});
