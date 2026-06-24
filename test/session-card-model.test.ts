import { describe, expect, it } from 'vitest';

import type { SessionRow } from '../src/core/dashboard-rows.js';
import {
  composeDetail,
  composeEntries,
  filterByCli,
  filterBySearch,
  filterByStatus,
  paginate,
  sortByStatus,
  statusToDot,
  type SessionRowDto,
} from '../src/dashboard/session-card-model.js';

const FIXED_NOW = 1_700_000_000_000;

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'sess-1',
    larkAppId: 'cli_demo',
    botName: 'demo-bot',
    cliId: 'claude',
    status: 'working',
    adopt: false,
    spawnedAt: FIXED_NOW - 60_000,
    lastMessageAt: FIXED_NOW - 30_000,
    chatId: 'oc_demo',
    rootMessageId: 'om_demo',
    feishuChatLink: 'https://example/oc_demo',
    webPort: 9001,
    ...overrides,
  };
}

describe('session-card-model · composeEntries / statusToDot', () => {
  it('maps working status to a green pulsing dot and primary text includes the title', () => {
    const row = makeRow({ status: 'working', title: 'My session' });
    const [dto] = composeEntries([row], FIXED_NOW);
    expect(dto.dot.tone).toBe('success');
    expect(dto.dot.pulse).toBe(true);
    expect(dto.primary).toContain('My session');
  });

  it('statusToDot falls back to a grey, non-pulsing dot for unknown statuses', () => {
    const dot = statusToDot('mystery');
    expect(dot.tone).toBe('neutral');
    expect(dot.pulse).toBe(false);
    expect(dot.label).toBe('sessions.status.unknown');
  });
});

describe('session-card-model · filters', () => {
  it("filterByStatus(chip='all') keeps content + order and never mutates input (M1)", () => {
    const entries = composeEntries([
      makeRow({ sessionId: 'a', status: 'working' }),
      makeRow({ sessionId: 'b', status: 'closed' }),
      makeRow({ sessionId: 'c', status: 'idle' }),
    ], FIXED_NOW);
    const before = entries.map(e => e.sessionId);
    const out = filterByStatus(entries, 'all');
    expect(out.map(e => e.sessionId)).toEqual(before);
    expect(entries.map(e => e.sessionId)).toEqual(before);
  });

  it('filterBySearch is case-insensitive and matches workingDir substring', () => {
    const entries = composeEntries([
      makeRow({ sessionId: 'a', workingDir: '/home/user/SECRET-Repo' }),
      makeRow({ sessionId: 'b', workingDir: '/tmp/other' }),
    ], FIXED_NOW);
    const matched = filterBySearch(entries, 'secret-repo');
    expect(matched.map(e => e.sessionId)).toEqual(['a']);
  });

  it('filterByCli with undefined or empty string returns all entries unchanged', () => {
    const entries = composeEntries([
      makeRow({ sessionId: 'a', cliId: 'claude' }),
      makeRow({ sessionId: 'b', cliId: 'codex' }),
    ], FIXED_NOW);
    expect(filterByCli(entries, undefined).map(e => e.sessionId)).toEqual(['a', 'b']);
    expect(filterByCli(entries, '').map(e => e.sessionId)).toEqual(['a', 'b']);
    expect(filterByCli(entries, 'claude').map(e => e.sessionId)).toEqual(['a']);
  });
});

describe('session-card-model · sortByStatus', () => {
  it('places working rows before closed rows and sorts same-status by lastMessageAt desc', () => {
    const entries = composeEntries([
      makeRow({ sessionId: 'closed-old', status: 'closed', lastMessageAt: FIXED_NOW - 600_000 }),
      makeRow({ sessionId: 'working-old', status: 'working', lastMessageAt: FIXED_NOW - 500_000 }),
      makeRow({ sessionId: 'working-new', status: 'working', lastMessageAt: FIXED_NOW - 100_000 }),
      makeRow({ sessionId: 'closed-new', status: 'closed', lastMessageAt: FIXED_NOW - 200_000 }),
    ], FIXED_NOW);
    const sorted = sortByStatus(entries);
    expect(sorted.map(e => e.sessionId)).toEqual([
      'working-new', 'working-old', 'closed-new', 'closed-old',
    ]);
  });
});

describe('session-card-model · paginate', () => {
  it('clamps an out-of-range page=99 to the last page and reports a correct pageCount', () => {
    const items: SessionRowDto[] = composeEntries(
      Array.from({ length: 25 }, (_, i) => makeRow({ sessionId: `s-${i}` })),
      FIXED_NOW,
    );
    const { items: page, meta } = paginate(items, 99, 10);
    expect(meta.totalPages).toBe(3);
    expect(meta.page).toBe(3);
    expect(meta.pageSize).toBe(10);
    expect(meta.total).toBe(25);
    expect(page.length).toBe(5);
    expect(page[0].sessionId).toBe('s-20');
  });
});

describe('session-card-model · composeDetail action matrix (M5 extended)', () => {
  it('combines the original 2 cases plus 3 new edges in one matrix', () => {
    // closed → resume=true, close=false
    const closed = composeDetail(makeRow({ status: 'closed', webPort: 7100 }));
    expect(closed.actions.resume.enabled).toBe(true);
    expect(closed.actions.close.enabled).toBe(false);

    // working → resume=false, close=true
    const working = composeDetail(makeRow({ status: 'working', webPort: 7100 }));
    expect(working.actions.resume.enabled).toBe(false);
    expect(working.actions.close.enabled).toBe(true);

    // starting → close=false (don't kill a starting process)
    const starting = composeDetail(makeRow({ status: 'starting', webPort: 7100 }));
    expect(starting.actions.close.enabled).toBe(false);
    expect(starting.actions.resume.enabled).toBe(false);

    // webPort=null → openTerminal=false
    const noPort = composeDetail(makeRow({ status: 'working', webPort: null }));
    expect(noPort.actions.openTerminal.enabled).toBe(false);

    // scope='chat' → locateMode='openChat'
    const chatScope = composeDetail(makeRow({ scope: 'chat' }));
    expect(chatScope.actions.locateMode).toBe('openChat');
    expect(chatScope.actions.locate.enabled).toBe(true);

    // scope='thread' (or absent) → locateMode='openTopic'
    const threadScope = composeDetail(makeRow({ scope: 'thread' }));
    expect(threadScope.actions.locateMode).toBe('openTopic');
    const noScope = composeDetail(makeRow({ scope: undefined }));
    expect(noScope.actions.locateMode).toBe('openTopic');
  });
});

describe('session-card-model · invariants', () => {
  it('filter / sort / paginate do not mutate the input (immutability)', () => {
    const entries = composeEntries([
      makeRow({ sessionId: 'a', status: 'working' }),
      makeRow({ sessionId: 'b', status: 'closed' }),
    ], FIXED_NOW);
    const frozen = Object.freeze(entries.slice());
    const snapshot = frozen.map(e => e.sessionId);
    filterByStatus(frozen, 'all');
    filterByStatus(frozen, 'working');
    filterBySearch(frozen, 'a');
    filterByCli(frozen, 'claude');
    sortByStatus(frozen);
    paginate(frozen, 1, 10);
    expect(frozen.map(e => e.sessionId)).toEqual(snapshot);
  });

  it('nowMs injection is deterministic — same input + same nowMs → identical output (no Date.now drift)', () => {
    const row = makeRow({ lastMessageAt: FIXED_NOW - 90_000 });
    const a = composeEntries([row], FIXED_NOW);
    const b = composeEntries([row], FIXED_NOW);
    expect(a).toEqual(b);
    expect(a[0].secondary).toContain('1m ago');
  });

  it('SessionRowDto + SessionDetailDto are JSON-serialisable round-trip', () => {
    const row = makeRow({ status: 'working', scope: 'thread' });
    const list = composeEntries([row], FIXED_NOW);
    const detail = composeDetail(row, FIXED_NOW);
    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });
});
