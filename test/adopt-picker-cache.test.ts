/**
 * Unit tests for the /adopt V2 picker candidates cache (services/adopt-picker).
 * The cache exists so search / page re-renders of the picker card don't
 * re-shell-out to tmux; these pin the store / TTL / clear semantics.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

const discovery = vi.hoisted(() => ({
  tmux: vi.fn(() => []),
  zellij: vi.fn(() => []),
  orca: vi.fn(() => []),
  exclude: vi.fn((sessions: unknown[]) => sessions),
  enrich: vi.fn(async (sessions: unknown[]) => sessions),
}));

vi.mock('../src/core/session-discovery.js', () => ({
  discoverAdoptableSessions: discovery.tmux,
  excludeOwnedHerdrAdoptTargets: discovery.exclude,
}));

vi.mock('../src/core/zellij-adopt-discovery.js', () => ({
  discoverAdoptableZellijSessions: discovery.zellij,
}));

vi.mock('../src/core/orca-adopt-discovery.js', () => ({
  discoverAdoptableOrcaSessions: discovery.orca,
}));

// The default live-name enrichment shells out to herdr and reads ~/.claude;
// tests that exercise it inject the real one with fakes (see below).
vi.mock('../src/services/adopt-live-enrich.js', () => ({
  enrichAdoptLiveSessions: discovery.enrich,
}));

import {
  collectAdoptCandidates,
  cacheAdoptCandidates,
  getCachedAdoptCandidates,
  clearAdoptCandidates,
  type AdoptCandidates,
} from '../src/services/adopt-picker.js';

const sample = (): AdoptCandidates => ({
  sessions: [],
  resumable: [{ cliSessionId: 'sess-1', cwd: '/w', title: 't', lastActivityAt: 1 }],
  resumeLimit: 20,
});

describe('adopt-picker candidates cache', () => {
  it('stores and returns a snapshot within TTL', () => {
    const now = 1_000_000;
    cacheAdoptCandidates('root-a', sample(), now);
    const hit = getCachedAdoptCandidates('root-a', now + 1000);
    expect(hit?.resumable[0].cliSessionId).toBe('sess-1');
  });

  it('expires a snapshot past the 5-minute TTL', () => {
    const now = 2_000_000;
    cacheAdoptCandidates('root-b', sample(), now);
    const stale = getCachedAdoptCandidates('root-b', now + 5 * 60 * 1000 + 1);
    expect(stale).toBeUndefined();
  });

  it('clear() drops a snapshot immediately', () => {
    const now = 3_000_000;
    cacheAdoptCandidates('root-c', sample(), now);
    clearAdoptCandidates('root-c');
    expect(getCachedAdoptCandidates('root-c', now + 1)).toBeUndefined();
  });

  it('returns undefined for an unknown key (forces re-discovery)', () => {
    expect(getCachedAdoptCandidates('never-cached', 42)).toBeUndefined();
  });

  it('passes the bot effective executable to both live discovery backends', async () => {
    discovery.tmux.mockClear();
    discovery.zellij.mockClear();
    discovery.orca.mockClear();
    const discoverResumable = vi.fn(async () => []);

    await collectAdoptCandidates(
      'codex',
      '/opt/Vendor Codex/vendorCodex',
      new Map(),
      discoverResumable,
      20,
      '/opt/Vendor Codex/vendorCodex',
    );

    expect(discovery.tmux).toHaveBeenCalledWith('codex', '/opt/Vendor Codex/vendorCodex');
    expect(discovery.zellij).toHaveBeenCalledWith('codex', '/opt/Vendor Codex/vendorCodex');
    expect(discovery.orca).toHaveBeenCalledWith('codex', '/opt/Vendor Codex/vendorCodex');
    // No live sessions → the live-dedup set is passed, just empty.
    expect(discoverResumable).toHaveBeenCalledWith(
      'codex',
      '/opt/Vendor Codex/vendorCodex',
      expect.any(Map),
      20,
      new Set(),
    );
  });

  it('passes the non-empty live session ids to resume discovery so history skips running sessions', async () => {
    const pane = { panePid: 1000, cliPid: 1001, cliId: 'claude-code', cwd: '/work/demo', paneCols: 80, paneRows: 24 };
    discovery.tmux.mockReturnValueOnce([
      { ...pane, source: 'tmux', tmuxTarget: '0:1.0', sessionId: 'sid-tmux' },
      { ...pane, source: 'herdr', herdrSessionName: 'default', herdrTarget: 'w1:p1', herdrPaneId: 'w1:p1', sessionId: 'sid-herdr' },
      { ...pane, source: 'tmux', tmuxTarget: '0:2.0' }, // sessionId undefined
      { ...pane, source: 'tmux', tmuxTarget: '0:3.0', sessionId: '' },
    ] as any);
    discovery.zellij.mockReturnValueOnce([
      { zellijSession: 'demo', zellijPaneId: 'terminal_1', cliPid: 1002, cliId: 'claude-code', cwd: '/work/demo', sessionId: 'sid-zellij' },
    ] as any);
    const discoverResumable = vi.fn(async () => []);

    const result = await collectAdoptCandidates('claude-code', undefined, new Map(), discoverResumable, 20);

    expect(result.sessions).toHaveLength(5);
    expect(discoverResumable).toHaveBeenCalledTimes(1);
    expect((discoverResumable.mock.calls[0] as unknown[])[4]).toEqual(new Set(['sid-tmux', 'sid-herdr', 'sid-zellij']));
  });

  it('keeps the legacy one-argument live discovery calls when no runtime is configured', async () => {
    discovery.tmux.mockClear();
    discovery.zellij.mockClear();

    await collectAdoptCandidates('codex', '/opt/wrapper-codex', new Map(), vi.fn(async () => []), 20);

    expect(discovery.tmux).toHaveBeenCalledWith('codex');
    expect(discovery.zellij).toHaveBeenCalledWith('codex');
  });
});

describe('collectAdoptCandidates: live-name enrichment', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const herdrRow = (extra: Record<string, unknown> = {}) => ({
    source: 'herdr', herdrSessionName: 'default', herdrTarget: 'w1:p1', herdrPaneId: 'w1:p1',
    herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', cliId: 'claude-code', sessionId: 'sid-herdr',
    cwd: '/work/demo', paneCols: 200, paneRows: 50, ...extra,
  });

  function settle<T>(p: Promise<T>) {
    const state: { done: boolean; value?: T } = { done: false };
    void p.then((value) => { state.done = true; state.value = value; });
    return state;
  }
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  /** The real enrichment with a herdr that never answers. */
  async function hungHerdrEnrichment() {
    const { enrichAdoptLiveSessions } = await vi.importActual<typeof import('../src/services/adopt-live-enrich.js')>(
      '../src/services/adopt-live-enrich.js',
    );
    const signals: AbortSignal[] = [];
    const enrichLive = (sessions: any[], opts: { deadlineMs?: number }) => enrichAdoptLiveSessions(sessions, {
      ...opts,
      runHerdr: (_args, { signal }) => {
        signals.push(signal);
        return new Promise<string | undefined>(() => {});
      },
    });
    return { enrichLive, signals };
  }

  it('enriches the final live list (owned panes already excluded) and passes the deadline through', async () => {
    const mine = herdrRow({ herdrAgentName: 'demo-agent' });
    const owned = herdrRow({ herdrPaneId: 'w1:p2', herdrTarget: 'w1:p2', herdrAgentName: 'botmux-owned' });
    discovery.tmux.mockReturnValueOnce([mine, owned] as any);
    discovery.exclude.mockImplementationOnce((sessions: any[]) => sessions.filter(s => s.herdrAgentName !== 'botmux-owned'));
    const named = { ...mine, herdrTabLabel: '整理笔记', herdrTabAutoNamed: false };
    discovery.enrich.mockClear();
    discovery.enrich.mockImplementationOnce(async () => [named]);
    const discoverResumable = vi.fn(async () => []);

    const result = await collectAdoptCandidates(
      'claude-code', undefined, new Map(), discoverResumable, 20, undefined, { deadlineMs: 1_234 },
    );

    expect(discovery.enrich).toHaveBeenCalledTimes(1);
    expect(discovery.enrich).toHaveBeenCalledWith([mine], { deadlineMs: 1_234 });
    expect(result.sessions).toEqual([named]);
    // History dedup still uses the discovered live ids.
    expect((discoverResumable.mock.calls[0] as unknown[])[4]).toEqual(new Set(['sid-herdr']));
  });

  it('runs the enrichment alongside history collection, not after it', async () => {
    vi.useFakeTimers();
    discovery.tmux.mockReturnValueOnce([herdrRow()] as any);
    const discoverResumable = vi.fn(() => new Promise<any[]>(resolve => setTimeout(() => resolve([]), 600)));
    const enrichLive = vi.fn((sessions: any[]) => new Promise<any[]>(resolve => setTimeout(() => resolve(sessions), 500)));

    const state = settle(collectAdoptCandidates(
      'claude-code', undefined, new Map(), discoverResumable, 20, undefined, { enrichLive },
    ));
    await vi.advanceTimersByTimeAsync(599);
    await flush();
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    // 600 ms in total (the longer of the two), far from 600 + 500 serially.
    expect(state.done).toBe(true);
    expect(enrichLive).toHaveBeenCalledTimes(1);
  });

  it('end to end: slow history, hung herdr, callback deadline → back by the deadline, herdr aborted, entries as discovered', async () => {
    vi.useFakeTimers();
    const { enrichLive, signals } = await hungHerdrEnrichment();
    const row = herdrRow();
    discovery.tmux.mockReturnValueOnce([row] as any);
    const discoverResumable = vi.fn(() => new Promise<any[]>(resolve => setTimeout(() => resolve([]), 2_400)));
    const deadlineMs = Date.now() + 2_500;

    const state = settle(collectAdoptCandidates(
      'claude-code', undefined, new Map(), discoverResumable, 20, undefined, { deadlineMs, enrichLive },
    ));
    await vi.advanceTimersByTimeAsync(2_399);
    await flush();
    expect(state.done).toBe(false);
    // The enrichment gave up long before: its 800 ms cap, not the deadline, bounded it.
    expect(signals).toHaveLength(2);
    expect(signals.every(s => s.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(state.done).toBe(true);
    expect(Date.now()).toBeLessThanOrEqual(deadlineMs + 50);
    expect(state.value!.sessions).toEqual([row]);
  });

  it('end to end: discovery ate the budget (under 100 ms left) → no herdr query at all', async () => {
    vi.useFakeTimers();
    const { enrichLive, signals } = await hungHerdrEnrichment();
    const row = herdrRow();
    const deadlineMs = Date.now() + 2_500;
    // A slow synchronous pane scan: 2.41 s pass before discovery returns.
    discovery.tmux.mockImplementationOnce((() => {
      vi.advanceTimersByTime(2_410);
      return [row];
    }) as any);

    const state = settle(collectAdoptCandidates(
      'claude-code', undefined, new Map(), vi.fn(async () => []), 20, undefined, { deadlineMs, enrichLive },
    ));
    await flush();
    expect(state.done).toBe(true);
    expect(signals).toEqual([]);
    expect(Date.now()).toBeLessThanOrEqual(deadlineMs + 50);
    expect(state.value!.sessions).toEqual([row]);
  });

  it('without a deadline the enrichment budget is 800 ms', async () => {
    vi.useFakeTimers();
    const { enrichLive, signals } = await hungHerdrEnrichment();
    discovery.tmux.mockReturnValueOnce([herdrRow()] as any);

    const state = settle(collectAdoptCandidates(
      'claude-code', undefined, new Map(), vi.fn(async () => []), 20, undefined, { enrichLive },
    ));
    await vi.advanceTimersByTimeAsync(799);
    await flush();
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(state.done).toBe(true);
    expect(signals.every(s => s.aborted)).toBe(true);
  });
});
