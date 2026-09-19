import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  allExpectedInChat,
  availableBotsForPicker,
  botNameById,
  chatHasAddableBots,
  createAddBotsReconciler,
  createReconciledChatCommitter,
  loadGroupRoleProfileContext,
  markBotsInChat,
  mergeReconciledChat,
  paginateGroupRows,
  planAddBotsFollowup,
  roleProfileBootstrapStatus,
  summarizeAddBotsResult,
  suggestRoleProfileIdFromChat,
} from '../src/dashboard/web/groups.js';
import { hasExplicitChatRole, summarizeGroupProfileMatches } from '../src/dashboard/web/role-profile-match.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('allExpectedInChat — refreshUntilSeen commit predicate', () => {
  it('empty expected set → true (degenerate case, nothing to wait for)', () => {
    expect(allExpectedInChat({ memberBots: [] }, new Set())).toBe(true);
  });

  it('all expected bots show inChat:true → true (commit canonical snapshot)', () => {
    const row = {
      memberBots: [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
        { larkAppId: 'botC', inChat: false },
      ],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(true);
  });

  it('partial: one expected bot still inChat:false → false (keep optimistic, retry)', () => {
    const row = {
      memberBots: [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: false },
      ],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(false);
  });

  it('expected bot missing from memberBots entirely → false', () => {
    const row = {
      memberBots: [{ larkAppId: 'botA', inChat: true }],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(false);
  });

  it('null/undefined row → false unless expected is empty', () => {
    expect(allExpectedInChat(undefined, new Set(['botA']))).toBe(false);
    expect(allExpectedInChat(null, new Set(['botA']))).toBe(false);
    expect(allExpectedInChat(undefined, new Set())).toBe(true);
  });
});

describe('availableBotsForPicker — shared bot picker ordering', () => {
  it('keeps the provided dashboard bot order and filters excluded ids', () => {
    const bots = availableBotsForPicker(
      [
        { larkAppId: 'cli_b', botName: 'Beta' },
        { larkAppId: 'cli_a', botName: 'Alpha' },
        { larkAppId: 'cli_c', botName: 'Gamma' },
      ],
      new Set(['cli_a']),
    );

    expect(bots.map(bot => bot.larkAppId)).toEqual(['cli_b', 'cli_c']);
  });
});

describe('chatHasAddableBots — add-bots button enablement', () => {
  const bots = [
    { larkAppId: 'cli_a', botName: 'Alpha' },
    { larkAppId: 'cli_b', botName: 'Beta' },
  ];

  it('true when at least one roster bot is not yet in the chat', () => {
    const chat = { chatId: 'oc_x', memberBots: [{ larkAppId: 'cli_a', inChat: true }] } as any;
    expect(chatHasAddableBots(chat, bots)).toBe(true);
  });

  it('false when every roster bot is already in the chat', () => {
    const chat = {
      chatId: 'oc_x',
      memberBots: [
        { larkAppId: 'cli_a', inChat: true },
        { larkAppId: 'cli_b', inChat: true },
      ],
    } as any;
    expect(chatHasAddableBots(chat, bots)).toBe(false);
  });

  it('a member present but not inChat still counts as addable (button stays enabled)', () => {
    const chat = {
      chatId: 'oc_x',
      memberBots: [
        { larkAppId: 'cli_a', inChat: true },
        { larkAppId: 'cli_b', inChat: false },
      ],
    } as any;
    expect(chatHasAddableBots(chat, bots)).toBe(true);
  });

  it('empty roster → nothing to add', () => {
    const chat = { chatId: 'oc_x', memberBots: [] } as any;
    expect(chatHasAddableBots(chat, [])).toBe(false);
  });

  it('recovers to enabled once the roster grows beyond current membership', () => {
    const chat = { chatId: 'oc_x', memberBots: [{ larkAppId: 'cli_a', inChat: true }] } as any;
    // Fully covered by the two-bot roster…
    expect(chatHasAddableBots(chat, [
      { larkAppId: 'cli_a', botName: 'Alpha' },
    ])).toBe(false);
    // …but a newly-registered bot makes the button addable again.
    expect(chatHasAddableBots(chat, [
      { larkAppId: 'cli_a', botName: 'Alpha' },
      { larkAppId: 'cli_c', botName: 'Gamma' },
    ])).toBe(true);
  });
});

describe('botNameById — add-bots result label', () => {
  const bots = [
    { larkAppId: 'cli_a', botName: 'Alpha(Claude)' },
    { larkAppId: 'cli_b' },
  ];

  it('returns the roster botName when known', () => {
    expect(botNameById('cli_a', bots)).toBe('Alpha(Claude)');
  });

  it('falls back to the raw id when the roster has no name', () => {
    expect(botNameById('cli_b', bots)).toBe('cli_b');
  });

  it('falls back to the raw id for an unknown bot', () => {
    expect(botNameById('cli_zzz', bots)).toBe('cli_zzz');
  });
});

describe('paginateGroupRows — bounded dashboard DOM', () => {
  const rows = Array.from({ length: 65 }, (_, index) => `group-${index + 1}`);

  it('renders at most the default 30 heavy group rows per page', () => {
    const window = paginateGroupRows(rows, 1);
    expect(window.rows).toHaveLength(30);
    expect(window.rows[0]).toBe('group-1');
    expect(window.rows[29]).toBe('group-30');
    expect(window).toMatchObject({ page: 1, totalPages: 3, from: 1, to: 30, total: 65 });
  });

  it('clamps stale pages after filtering and reports the final partial range', () => {
    const window = paginateGroupRows(rows, 99);
    expect(window.rows).toEqual(['group-61', 'group-62', 'group-63', 'group-64', 'group-65']);
    expect(window).toMatchObject({ page: 3, totalPages: 3, from: 61, to: 65, total: 65 });
  });

  it('returns a stable empty window', () => {
    expect(paginateGroupRows([], 4)).toEqual({
      rows: [], page: 1, totalPages: 1, from: 0, to: 0, total: 0,
    });
  });
});

describe('roleProfileBootstrapStatus — create-group profile feedback', () => {
  it('summarizes a sent bootstrap message', () => {
    const status = roleProfileBootstrapStatus('collab-main', 'om_bootstrap', null);

    expect(status).toEqual({
      kind: 'ok',
      text: 'Profile：collab-main；bootstrap 消息已发送：om_bootstrap',
    });
  });

  it('summarizes failure details without dropping interpolated values', () => {
    const status = roleProfileBootstrapStatus(
      '<profile>',
      null,
      '<script>alert(1)</script>',
    );

    expect(status?.kind).toBe('warn');
    expect(status?.text).toContain('<profile>');
    expect(status?.text).toContain('<script>alert(1)</script>');
  });
});

describe('summarizeAddBotsResult — add-bots inline feedback', () => {
  it('summarizes a clean add-bots result as success', () => {
    const summary = summarizeAddBotsResult([
      { id: 'cli_a', ok: true },
      { id: 'cli_b', ok: true },
    ]);

    expect(summary.okCount).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.rows.map(row => row.id)).toEqual(['cli_a', 'cli_b']);
  });

  it('summarizes partial failures and keeps row details', () => {
    const summary = summarizeAddBotsResult([
      { id: 'cli_ok', ok: true },
      { id: '<bad>', ok: false, error: '<script>alert(1)</script>' },
    ]);

    expect(summary.okCount).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.rows[1]).toMatchObject({
      id: '<bad>',
      ok: false,
      error: '<script>alert(1)</script>',
    });
  });
});

describe('planAddBotsFollowup — post-add close/candidate decision (local optimistic state)', () => {
  const bots = [
    { larkAppId: 'cli_a', botName: 'Alpha' },
    { larkAppId: 'cli_b', botName: 'Beta' },
    { larkAppId: 'cli_c', botName: 'Gamma' },
  ];

  it('collects deduped non-empty ok ids and closes when the roster is exhausted', () => {
    const summary = summarizeAddBotsResult([
      { id: 'cli_a', ok: true },
      { id: 'cli_a', ok: true }, // duplicate row from a retry — must collapse
      { id: 'cli_b', ok: true },
      { id: 'cli_c', ok: true },
    ]);

    const followup = planAddBotsFollowup(summary, bots, new Set());

    expect(followup.okIds).toEqual(['cli_a', 'cli_b', 'cli_c']);
    expect(followup.remaining).toBe(0);
    expect(followup.shouldClose).toBe(true);
  });

  it('keeps the dialog open when candidates remain after this round', () => {
    const summary = summarizeAddBotsResult([{ id: 'cli_a', ok: true }]);

    const followup = planAddBotsFollowup(summary, bots, new Set());

    expect(followup.okIds).toEqual(['cli_a']);
    expect(followup.remaining).toBe(2); // cli_b, cli_c still selectable
    expect(followup.shouldClose).toBe(false);
  });

  it('excludes bots already in chat / added in prior rounds before deciding to close', () => {
    const summary = summarizeAddBotsResult([{ id: 'cli_c', ok: true }]);

    const followup = planAddBotsFollowup(summary, bots, new Set(['cli_a', 'cli_b']));

    expect(followup.okIds).toEqual(['cli_c']);
    expect(followup.remaining).toBe(0);
    expect(followup.shouldClose).toBe(true);
  });

  it('never closes while anything failed, even if no candidates remain', () => {
    const summary = summarizeAddBotsResult([
      { id: 'cli_a', ok: true },
      { id: 'cli_b', ok: true },
      { id: 'cli_c', ok: false, error: 'boom' },
    ]);

    const followup = planAddBotsFollowup(summary, bots, new Set());

    expect(followup.okIds).toEqual(['cli_a', 'cli_b']);
    expect(followup.remaining).toBe(1); // cli_c stays selectable (not an ok id)
    expect(followup.shouldClose).toBe(false); // failed > 0 blocks the auto-close
  });

  it('drops missing / non-string ids instead of stringifying them to "undefined"', () => {
    const summary = summarizeAddBotsResult([
      { ok: true }, // no id
      { id: '', ok: true }, // empty id
      { id: 'cli_b', ok: true },
    ]);

    const followup = planAddBotsFollowup(summary, bots, new Set());

    expect(followup.okIds).toEqual(['cli_b']);
    expect(followup.okIds).not.toContain('undefined');
    expect(followup.okIds).not.toContain('');
  });
});

describe('markBotsInChat — optimistic inChat flip (immutable, like injectOptimisticChat)', () => {
  const snapshot = {
    bots: [
      { larkAppId: 'cli_a', botName: 'Alpha' },
      { larkAppId: 'cli_b', botName: 'Beta' },
      { larkAppId: 'cli_c', botName: 'Gamma' },
    ],
    chats: [
      {
        chatId: 'oc_x',
        name: 'Room',
        memberBots: [
          { larkAppId: 'cli_a', botName: 'Alpha', inChat: false, hasRole: true },
          { larkAppId: 'cli_b', botName: 'Beta', inChat: true },
        ],
      },
      {
        chatId: 'oc_other',
        name: 'Other',
        memberBots: [{ larkAppId: 'cli_a', botName: 'Alpha', inChat: false }],
      },
    ],
  };

  it('flips matched members to inChat:true while preserving their other fields', () => {
    const next = markBotsInChat(snapshot as any, 'oc_x', ['cli_a']);
    const room = next.chats.find(c => c.chatId === 'oc_x')!;
    const alpha = room.memberBots.find(m => m.larkAppId === 'cli_a')!;

    expect(alpha.inChat).toBe(true);
    expect(alpha.hasRole).toBe(true); // untouched
    expect(alpha.botName).toBe('Alpha');
  });

  it('appends okIds missing from memberBots once, reusing snapshot.bots metadata', () => {
    const next = markBotsInChat(snapshot as any, 'oc_x', ['cli_c', 'cli_c']);
    const room = next.chats.find(c => c.chatId === 'oc_x')!;
    const gammaRows = room.memberBots.filter(m => m.larkAppId === 'cli_c');

    expect(gammaRows).toHaveLength(1); // deduped, not appended twice
    expect(gammaRows[0]).toMatchObject({ larkAppId: 'cli_c', botName: 'Gamma', inChat: true });
  });

  it('does not mutate the input snapshot or other chats', () => {
    const before = JSON.parse(JSON.stringify(snapshot));
    const next = markBotsInChat(snapshot as any, 'oc_x', ['cli_a', 'cli_c']);

    expect(snapshot).toEqual(before); // input untouched
    expect(next).not.toBe(snapshot);
    expect(next.chats.find(c => c.chatId === 'oc_other'))
      .toBe(snapshot.chats.find(c => c.chatId === 'oc_other')); // untouched chat kept by reference
  });

  it('returns the same snapshot reference when there is nothing valid to add', () => {
    expect(markBotsInChat(snapshot as any, 'oc_x', [])).toBe(snapshot);
    expect(markBotsInChat(snapshot as any, 'oc_x', ['', undefined as any])).toBe(snapshot);
  });
});

describe('createAddBotsReconciler — overlapping-batch snapshot reconciliation', () => {
  // Build a groups snapshot exposing exactly which okIds the server currently reports
  // as inChat for oc_x. Membership rows for anything not listed are inChat:false.
  function serverSnapshot(inChatIds: string[]) {
    const ids = new Set(inChatIds);
    return {
      bots: [
        { larkAppId: 'cli_a' }, { larkAppId: 'cli_b' }, { larkAppId: 'cli_c' },
      ],
      chats: [{
        chatId: 'oc_x',
        name: 'Room',
        memberBots: ['cli_a', 'cli_b', 'cli_c'].map(id => ({ larkAppId: id, inChat: ids.has(id) })),
      }],
    };
  }

  // A manually-clocked delay: each `delay()` returns a promise the test resolves by
  // calling the matching `tick()`, so batch interleaving is fully deterministic.
  function manualClock() {
    const waiters: Array<() => void> = [];
    return {
      delay: () => new Promise<void>(resolve => { waiters.push(resolve); }),
      async tick() {
        const pending = waiters.splice(0, waiters.length);
        for (const resolve of pending) resolve();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it('does NOT let batch A\'s older poll roll back batch B once B is optimistic (the reported race)', async () => {
    const clock = manualClock();
    const commits: string[][] = [];
    // Server is slow: it only ever shows A this whole test (B has not propagated yet).
    const fetchSnapshot = vi.fn(async () => serverSnapshot(['cli_a']));

    const reconciler = createAddBotsReconciler({
      fetchSnapshot,
      delay: clock.delay,
      isMounted: () => true,
      commit: (_chatId, next) => {
        const row = next.chats.find(c => c.chatId === 'oc_x')!;
        commits.push(row.memberBots.filter(m => m.inChat).map(m => m.larkAppId));
      },
      delays: [1, 1, 1],
    });

    // Batch A, then batch B (B arrives while A is still polling → shared chat, overlap).
    void reconciler.reconcile('oc_x', ['cli_a']);
    void reconciler.reconcile('oc_x', ['cli_b']);

    // Drive several poll cycles. A's poll would see {cli_a} satisfied for its own id,
    // but it has been superseded by B, so it must NOT commit; B needs {cli_a,cli_b}
    // which the server never shows, so nothing commits at all.
    await clock.tick();
    await clock.tick();
    await clock.tick();
    await clock.tick();

    expect(commits).toEqual([]); // B was never rolled back to missing
  });

  it('commits once the server has caught up to the union of all pending batches', async () => {
    const clock = manualClock();
    const commits: string[][] = [];
    // Server converges to A+B only on the 2nd fetch.
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce(serverSnapshot(['cli_a']))
      .mockResolvedValue(serverSnapshot(['cli_a', 'cli_b']));

    const reconciler = createAddBotsReconciler({
      fetchSnapshot,
      delay: clock.delay,
      isMounted: () => true,
      commit: (_chatId, next) => {
        const row = next.chats.find(c => c.chatId === 'oc_x')!;
        commits.push(row.memberBots.filter(m => m.inChat).map(m => m.larkAppId));
      },
      delays: [1, 1, 1, 1],
    });

    void reconciler.reconcile('oc_x', ['cli_a']);
    void reconciler.reconcile('oc_x', ['cli_b']);

    await clock.tick(); // fetch #1 → only A → union {a,b} unsatisfied, no commit
    await clock.tick(); // fetch #2 → {a,b} → commit
    await clock.tick();

    expect(commits).toEqual([['cli_a', 'cli_b']]);
  });

  it('committing chat-X against the live snapshot does NOT roll back chat-Y\'s optimistic membership', () => {
    // The reconciler's guards are per-chat, but a server snapshot fetched while
    // reconciling X still carries Y's not-yet-propagated (missing) membership. The
    // caller must merge only X's row (mergeReconciledChat) instead of committing the
    // whole snapshot, or Y gets rolled back. This asserts that merge behavior directly.
    const live = {
      bots: [{ larkAppId: 'cli_a' }, { larkAppId: 'cli_b' }],
      chats: [
        // X: optimistically has A; Y: optimistically has B.
        { chatId: 'oc_x', name: 'X', memberBots: [{ larkAppId: 'cli_a', inChat: true }] },
        { chatId: 'oc_y', name: 'Y', memberBots: [{ larkAppId: 'cli_b', inChat: true }] },
      ],
    };
    // Fresh server snapshot: X converged (A inChat), but Y has NOT propagated B yet.
    const serverX = {
      bots: [{ larkAppId: 'cli_a' }, { larkAppId: 'cli_b' }],
      chats: [
        { chatId: 'oc_x', name: 'X', memberBots: [{ larkAppId: 'cli_a', inChat: true }] },
        { chatId: 'oc_y', name: 'Y', memberBots: [{ larkAppId: 'cli_b', inChat: false }] },
      ],
    };

    const merged = mergeReconciledChat(live, 'oc_x', serverX);

    const yRow = merged.chats.find(c => c.chatId === 'oc_y')!;
    expect(yRow.memberBots.find(m => m.larkAppId === 'cli_b')!.inChat).toBe(true); // Y kept optimistic
    // X's row is the canonical server row (reference-swapped, not the live one).
    expect(merged.chats.find(c => c.chatId === 'oc_x')).toBe(serverX.chats[0]);
    // Whole-snapshot commit (the bug) WOULD have rolled Y back:
    expect(serverX.chats.find(c => c.chatId === 'oc_y')!.memberBots[0].inChat).toBe(false);
  });

  it('mergeReconciledChat returns base unchanged when the source lacks the chat row', () => {
    const base = {
      bots: [{ larkAppId: 'cli_a' }],
      chats: [{ chatId: 'oc_x', name: 'X', memberBots: [{ larkAppId: 'cli_a', inChat: true }] }],
    };
    const source = { bots: [{ larkAppId: 'cli_a' }], chats: [] };
    expect(mergeReconciledChat(base, 'oc_x', source)).toBe(base);
  });

  it('mixed React batch: a stale queued snapshot update cannot clobber committer ref/state', () => {
    // Faithful model of the page's snapshot plumbing. React defers state: writes enqueue and
    // only apply on flush. The production fix makes the SHARED setSnapshot the single entry
    // point — it updates the synchronous `ref` FIRST, then enqueues an ABSOLUTE value (never an
    // updater that writes ref inside the deferred flush). This test enqueues a stale update
    // BEFORE the two chat commits in the same batch, then flushes, and asserts both `state` and
    // `ref` end with X and Y canonical — the exact regression Round 4 review reported.
    let ref: any = {
      bots: [{ larkAppId: 'cli_a' }, { larkAppId: 'cli_b' }],
      chats: [
        { chatId: 'oc_x', name: 'X', memberBots: [{ larkAppId: 'cli_a', inChat: false }] }, // pre-optimistic
        { chatId: 'oc_y', name: 'Y', memberBots: [{ larkAppId: 'cli_b', inChat: false }] },
      ],
    };
    let state: any = ref;
    const queue: any[] = []; // deferred React state values, flushed in enqueue order

    // Production setSnapshot: sync ref-first, absolute state enqueue, functional next resolves
    // against the live ref.
    const setSnapshot = (next: any) => {
      const resolved = typeof next === 'function' ? next(ref) : next;
      ref = resolved;
      queue.push(resolved);
      return resolved;
    };
    const flush = () => { for (const v of queue.splice(0, queue.length)) state = v; };

    const committed: any[] = [];
    const commit = createReconciledChatCommitter({
      getSnapshot: () => ref,
      applySnapshot: merged => { setSnapshot(merged); }, // reuse the ONE entry point
      onCommitted: merged => { committed.push(merged); },
    });

    const canonical = (inX: boolean, inY: boolean) => ({
      bots: [{ larkAppId: 'cli_a' }, { larkAppId: 'cli_b' }],
      chats: [
        { chatId: 'oc_x', name: 'X', memberBots: [{ larkAppId: 'cli_a', inChat: inX }] },
        { chatId: 'oc_y', name: 'Y', memberBots: [{ larkAppId: 'cli_b', inChat: inY }] },
      ],
    });

    // 1) An unrelated optimistic snapshot update is queued earlier in the same batch (e.g. the
    //    add-bots dialog flipping X optimistic). With the OLD ref-inside-updater shape this would
    //    re-write ref during flush and undo the committers.
    setSnapshot(canonical(true, false));
    // 2) Same batch: X converges (server still lacks Y), then Y converges (server still lacks X).
    commit('oc_x', canonical(true, false));
    commit('oc_y', canonical(false, true));
    // 3) React flushes the whole batch.
    flush();

    const rowIn = (snap: any, id: string) => snap.chats.find((c: any) => c.chatId === id)!.memberBots[0].inChat;
    expect(rowIn(state, 'oc_x')).toBe(true);  // state: X canonical
    expect(rowIn(state, 'oc_y')).toBe(true);  // state: Y canonical
    expect(rowIn(ref, 'oc_x')).toBe(true);    // ref: X canonical (not clobbered by the stale flush)
    expect(rowIn(ref, 'oc_y')).toBe(true);    // ref: Y canonical
    // A subsequent reconcile reads ref — it must see both canonical, not a stale snapshot.
    const last = committed[committed.length - 1];
    expect(rowIn(last, 'oc_x')).toBe(true);
    expect(rowIn(last, 'oc_y')).toBe(true);
  });

  it('stops polling and never commits after the page unmounts', async () => {
    const clock = manualClock();
    const commit = vi.fn();
    let mounted = true;
    const fetchSnapshot = vi.fn(async () => serverSnapshot(['cli_a']));

    const reconciler = createAddBotsReconciler({
      fetchSnapshot,
      delay: clock.delay,
      isMounted: () => mounted,
      commit,
      delays: [1, 1, 1],
    });

    void reconciler.reconcile('oc_x', ['cli_a']);
    mounted = false;
    await clock.tick();
    await clock.tick();

    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores empty/invalid okIds without starting a poll', async () => {
    const clock = manualClock();
    const fetchSnapshot = vi.fn(async () => serverSnapshot([]));
    const reconciler = createAddBotsReconciler({
      fetchSnapshot,
      delay: clock.delay,
      isMounted: () => true,
      commit: () => {},
      delays: [1],
    });

    await reconciler.reconcile('oc_x', []);
    await reconciler.reconcile('oc_x', ['', undefined as any]);
    await clock.tick();

    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});

describe('summarizeGroupProfileMatches — group role/profile status', () => {
  const profiles = [
    { profileId: 'main' },
    { profileId: 'partial' },
    { profileId: 'unused' },
  ];
  const entries = new Map([
    ['main', [
      { profileId: 'main', larkAppId: 'botA', content: 'role A' },
      { profileId: 'main', larkAppId: 'botB', content: 'role B' },
      { profileId: 'main', larkAppId: 'botD', content: '' },
    ]],
    ['partial', [
      { profileId: 'partial', larkAppId: 'botA', content: 'role A' },
      { profileId: 'partial', larkAppId: 'botB', content: 'different B' },
    ]],
    ['unused', [
      { profileId: 'unused', larkAppId: 'botC', content: 'role C' },
    ]],
  ]);

  it('reports matches from explicit group roles only', () => {
    const matches = summarizeGroupProfileMatches(
      [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
        { larkAppId: 'botC', inChat: false },
        { larkAppId: 'botD', inChat: true },
      ],
      profiles,
      entries,
      new Map([
        ['botA', { content: 'role A', source: 'chat' }],
        ['botB', { content: 'role B', source: 'team' }],
      ]),
    );

    expect(matches).toEqual([
      {
        profileId: 'main',
        matched: 1,
        total: 2,
        chatMatched: 1,
        kind: 'partial',
      },
      {
        profileId: 'partial',
        matched: 1,
        total: 2,
        chatMatched: 1,
        kind: 'partial',
      },
    ]);
    expect(matches.map(m => m.profileId)).not.toContain('unused');
  });

  it('does not treat fallback/default role content as a displayed profile match', () => {
    const roles = new Map([
      ['botA', { content: 'role A', source: 'team' }],
      ['botB', { content: 'role B', source: 'team' }],
    ]);

    expect(hasExplicitChatRole(roles)).toBe(false);
    expect(summarizeGroupProfileMatches(
      [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
      ],
      profiles,
      entries,
      roles,
    )).toEqual([]);
  });

  it('returns no match when no profile entry content equals current group roles', () => {
    const matches = summarizeGroupProfileMatches(
      [{ larkAppId: 'botA', inChat: true }],
      profiles,
      entries,
      new Map([['botA', 'other']]),
    );

    expect(matches).toEqual([]);
  });
});

describe('suggestRoleProfileIdFromChat — prompt default', () => {
  it('keeps only backend-valid profile id characters', () => {
    expect(suggestRoleProfileIdFromChat('AI ChangeLog / Prod 群')).toBe('ai-changelog-prod');
  });

  it('falls back to a safe id when the group name has no valid ascii token', () => {
    expect(suggestRoleProfileIdFromChat('项目群')).toBe('profile');
  });
});

describe('loadGroupRoleProfileContext — bounded role requests', () => {
  it('loads explicit chat roles in one batch and skips unconfigured memberships', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/role-profiles') {
        return { ok: true, status: 200, json: async () => ({ profiles: [{ profileId: 'main' }] }) } as Response;
      }
      if (url === '/api/role-profiles/main') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ entries: [{ profileId: 'main', larkAppId: 'botA', content: 'role A' }] }),
        } as Response;
      }
      if (url === '/api/roles/batch') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          targets: [{ larkAppId: 'botA', chatId: 'oc_team' }],
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            roles: [{
              larkAppId: 'botA',
              chatId: 'oc_team',
              content: 'role A',
              hasRole: true,
              effectiveContent: 'role A',
              effectiveSource: 'chat',
              hasEffectiveRole: true,
            }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const context = await loadGroupRoleProfileContext({
      bots: [],
      chats: [{
        chatId: 'oc_team',
        memberBots: [
          { larkAppId: 'botA', inChat: true, hasRole: true },
          { larkAppId: 'botB', inChat: true, hasRole: false },
          { larkAppId: 'botC', inChat: false, hasRole: true },
        ],
      }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith('/api/roles/')))
      .toEqual(['/api/roles/batch']);
    expect(context.groupRoleContentByBot.get('botA\u0000oc_team')).toEqual({
      content: 'role A',
      source: 'chat',
    });
    expect(context.groupRoleContentByBot.has('botB\u0000oc_team')).toBe(false);
  });
});
