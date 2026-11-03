// Assembly-level regression for the dispatch task-tree session lookup.
//
// The card refresh must narrow its session read to the orchestrating session's
// dispatch roots (never a full cross-store snapshot) AND still see CLOSED rows:
// nodeState() renders a ⚫ closed node from a non-active child session. An
// active-only reader such as findActiveSessionsByRoot would silently drop that
// state back to dispatched/running. This wires the card service to the REAL
// SQLite narrow reader over seeded active+closed rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../src/services/frozen-card-store.js', () => ({ deleteFrozenCards: vi.fn() }));

import { createDispatchTaskTreeCards } from '../src/services/dispatch-task-tree-card.js';
import { readSessionsByRoots } from '../src/services/session-store.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import type { TaskTreeSessionRow } from '../src/core/dispatch-task-tree.js';

const APP_ID = 'cli_tree_closed';
const ORCH = { sessionId: 'orch', larkAppId: APP_ID, chatId: 'oc_chat', rootMessageId: 'om_orch', title: '主编排' };
const roots: string[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'task-tree-closed-row-'));
  roots.push(tempDir);
  writeFileSync(join(tempDir, 'orchestrate-dispatch.json'), JSON.stringify({
    om_child: {
      orchSessionId: 'orch', targetChatId: 'oc_x', targetAppIds: [APP_ID],
      title: '子任务', status: 'accepted', createdAt: '1',
    },
  }));
});

afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cards() {
  return createDispatchTaskTreeCards({
    dataDir: tempDir,
    // The exact composition the daemon wires: narrow SQLite read for the roots
    // the card service hands us, projected to the tree's session-row shape.
    listSessions: (passedRoots: ReadonlySet<string>): TaskTreeSessionRow[] => {
      // The service must narrow to this orchestrator's own dispatch root.
      expect(passedRoots.has('om_child')).toBe(true);
      return readSessionsByRoots(passedRoots, { dataDir: tempDir }).map(s => ({
        sessionId: s.sessionId, larkAppId: s.larkAppId, rootMessageId: s.rootMessageId, status: s.status,
      }));
    },
    localAppIds: () => new Set([APP_ID]),
    resolveThreadId: async () => 'omt_child',
    post: async () => 'om_card',
    update: async () => {},
    isMessageGone: () => false,
    brand: () => 'feishu' as const,
    log: () => {},
  });
}

describe('task-tree refresh keeps closed child rows via the narrow reader', () => {
  it('renders a closed node (⚫) from a closed SQLite row, and only reads the dispatch roots', async () => {
    seedPersistedSessionRows(tempDir, APP_ID, {
      childClosed: {
        sessionId: 'childClosed', chatId: 'oc_x', larkAppId: APP_ID,
        rootMessageId: 'om_child', status: 'closed', title: '子任务',
        closedAt: '2026-02-01T00:00:00.000Z',
      },
      unrelated: {
        sessionId: 'unrelated', chatId: 'oc_x', larkAppId: APP_ID,
        rootMessageId: 'om_unrelated', status: 'active', title: '不该被读到',
      },
    });
    const result = await cards().refresh(ORCH);
    expect(result.tree.nodes).toHaveLength(1);
    expect(result.tree.nodes[0]).toMatchObject({ dispatchRoot: 'om_child', state: 'closed' });
    expect(result.text).toContain('已关闭');
  });

  it('still maps an active child to running through the same narrow reader', async () => {
    seedPersistedSessionRows(tempDir, APP_ID, {
      childActive: {
        sessionId: 'childActive', chatId: 'oc_x', larkAppId: APP_ID,
        rootMessageId: 'om_child', status: 'active', title: '子任务',
      },
    });
    const result = await cards().refresh(ORCH);
    expect(result.tree.nodes[0]!.state).toBe('running');
  });
});
