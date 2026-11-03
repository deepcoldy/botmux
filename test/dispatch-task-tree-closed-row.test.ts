// Assembly-level regression for the dispatch task-tree session lookup.
//
// The card refresh wires to listDispatchTreeSessionRows — the real seam: a
// narrow root-indexed read across stores plus the tree-row projection. It must
// (1) keep CLOSED rows so nodeState() renders ⚫, (2) backfill larkAppId for
// rows missing the column copy (a cross-bot closed child would otherwise drop
// to dispatched/running), and (3) exclude rows for roots it did not ask for.
// Switching the seam's reader back to a full snapshot or to an active-only
// reader turns these red.
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
import { listDispatchTreeSessionRows } from '../src/services/dispatch-task-tree-sessions.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const ORCH_APP = 'cli_orch';
const CHILD_APP = 'cli_childbot';
const ORCH = { sessionId: 'orch', larkAppId: ORCH_APP, chatId: 'oc_chat', rootMessageId: 'om_orch', title: '主编排' };
const roots: string[] = [];

function writeRegistry(): void {
  writeFileSync(join(tempDir, 'orchestrate-dispatch.json'), JSON.stringify({
    om_child: {
      orchSessionId: 'orch', targetChatId: 'oc_x', targetAppIds: [CHILD_APP],
      title: '子任务', status: 'accepted', createdAt: '1',
    },
  }));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'task-tree-closed-row-'));
  roots.push(tempDir);
  writeRegistry();
});

afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cards() {
  return createDispatchTaskTreeCards({
    dataDir: tempDir,
    // The real daemon assembly seam.
    listSessions: passedRoots => listDispatchTreeSessionRows(passedRoots, tempDir),
    localAppIds: () => new Set([ORCH_APP, CHILD_APP]),
    resolveThreadId: async () => 'omt_child',
    post: async () => 'om_card',
    update: async () => {},
    isMessageGone: () => false,
    brand: () => 'feishu' as const,
    log: () => {},
  });
}

describe('task-tree session seam', () => {
  it('backfills larkAppId for a cross-store closed row missing it and excludes other roots', () => {
    seedPersistedSessionRows(tempDir, CHILD_APP, {
      childClosed: {
        sessionId: 'childClosed', chatId: 'oc_x',
        // Deliberately NO larkAppId: older/column-less rows inherit the store id.
        rootMessageId: 'om_child', status: 'closed', title: '子任务',
        closedAt: '2026-02-01T00:00:00.000Z',
      },
      unrelated: {
        sessionId: 'unrelated', chatId: 'oc_x',
        rootMessageId: 'om_other', status: 'active', title: '不该被读到',
      },
    });
    const rows = listDispatchTreeSessionRows(new Set(['om_child']), tempDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'childClosed', larkAppId: CHILD_APP, status: 'closed' });
  });
});

describe('task-tree refresh keeps closed child rows via the real seam', () => {
  it('renders a closed node (⚫) for a cross-bot closed child whose row omits larkAppId', async () => {
    seedPersistedSessionRows(tempDir, CHILD_APP, {
      childClosed: {
        sessionId: 'childClosed', chatId: 'oc_x',
        rootMessageId: 'om_child', status: 'closed', title: '子任务',
        closedAt: '2026-02-01T00:00:00.000Z',
      },
      unrelated: {
        sessionId: 'unrelated', chatId: 'oc_x',
        rootMessageId: 'om_other', status: 'active', title: '不该被读到',
      },
    });
    const result = await cards().refresh(ORCH);
    expect(result.tree.nodes).toHaveLength(1);
    expect(result.tree.nodes[0]).toMatchObject({ dispatchRoot: 'om_child', state: 'closed' });
  });

  it('maps an active cross-bot child to running through the same seam', async () => {
    seedPersistedSessionRows(tempDir, CHILD_APP, {
      childActive: {
        sessionId: 'childActive', chatId: 'oc_x', larkAppId: CHILD_APP,
        rootMessageId: 'om_child', status: 'active', title: '子任务',
      },
    });
    const result = await cards().refresh(ORCH);
    expect(result.tree.nodes[0]!.state).toBe('running');
  });
});
