/**
 * PR #686 follow-up — the two pre-existing races the Codex-notifier「继续处理」
 * takeover exposed, isolated to their pure decision helpers so they can be
 * exercised without standing up the whole daemon:
 *
 *  P1 · notifierAdoptStaleOrTransferring — after the dynamic import + AbortSignal
 *       await, a concurrent /relay transfer (or /close/swap/re-create) must abort
 *       the takeover BEFORE any mutation, so the outer handler never renders a
 *       bogus green「已接管」over a half-rewritten / relayed session.
 *
 *  P2 · notifierAdoptWouldDropInput — the "would clear drop undelivered input?"
 *       predicate splits by state semantics: repo-select mirror fields
 *       (pendingPrompt/etc) count ONLY while pendingRepo===true (the immediate-
 *       launch path also seeds them but has already forked/delivered), while
 *       pendingRawInput/pendingFollowUpInput are checked independently of
 *       pendingRepo — they are the real just-committed launch window still
 *       waiting on prompt_ready.
 *
 * Run: pnpm vitest run test/codex-notifier-adopt-race.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  transferring: new WeakSet<object>(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient, WSClient: class { start() {} } };
});

// isSessionTransferring is the only worker-pool behaviour these pure helpers
// depend on. Back it by a test-controlled WeakSet keyed on the session object so
// a test can flip a ds "into transfer" without a real relay gate.
vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    isSessionTransferring: (ds: any) => mocks.transferring.has(ds),
  };
});

// The integration test drives adoptCodexNotifierEvent through its real control
// flow; stub the one network hop (message→chat lookup) and the bot config read.
vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    getMessageChatId: vi.fn(async () => 'oc_dm'),
  };
});

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<any>('../src/bot-registry.js');
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: { larkAppId: 'cli_app', cliId: 'codex-app', p2pMode: 'chat', cliPathOverride: undefined },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    })),
  };
});

import {
  __testOnly_notifierAdoptStaleOrTransferring as staleOrTransferring,
  __testOnly_notifierAdoptWouldDropInput as wouldDropInput,
  __testOnly_clearPendingRepoStateForNotifierAdopt as clearForAdopt,
  __testOnly_adoptCodexNotifierEvent as adoptEvent,
  __testOnly_activeSessions as activeSessions,
} from '../src/daemon.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

const KEY = 'oc_dm:cli_app';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sid-1',
      status: 'active',
      cliSessionId: undefined,
    },
    worker: null,
    larkAppId: 'cli_app',
    chatId: 'oc_dm',
    ...overrides,
  } as unknown as DaemonSession;
}

describe('P1 · notifierAdoptStaleOrTransferring', () => {
  beforeEach(() => {
    // Fresh transfer set per test (WeakSet has no clear()).
    mocks.transferring = new WeakSet();
  });

  it('healthy, still-mapped, non-transferring session → proceed (false)', () => {
    const ds = makeDs();
    const sessions = new Map([[KEY, ds]]);
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(false);
  });

  it('session swapped out of the active map → abort (true)', () => {
    const ds = makeDs();
    const other = makeDs({ session: { sessionId: 'sid-2', status: 'active' } as any });
    const sessions = new Map([[KEY, other]]); // key now points elsewhere
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('active-map entry removed (/close) → abort (true)', () => {
    const ds = makeDs();
    const sessions = new Map<string, DaemonSession>(); // key gone
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('session identity drifted (re-created under the same key) → abort (true)', () => {
    const ds = makeDs();
    const sessions = new Map([[KEY, ds]]);
    ds.session.sessionId = 'sid-DIFFERENT';
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('session no longer active (closed) → abort (true)', () => {
    const ds = makeDs({ session: { sessionId: 'sid-1', status: 'closed' } as any });
    const sessions = new Map([[KEY, ds]]);
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('a /relay transfer opened its gate on this session → abort (true)', () => {
    const ds = makeDs();
    const sessions = new Map([[KEY, ds]]);
    mocks.transferring.add(ds); // relay in progress
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });
});

describe('P2 · notifierAdoptWouldDropInput', () => {
  it('nothing pending → false', () => {
    expect(wouldDropInput(makeDs())).toBe(false);
  });

  it('repo-select pending buffer (pendingRepo=true) → true', () => {
    expect(wouldDropInput(makeDs({ pendingRepo: true, pendingPrompt: 'hello' } as any))).toBe(true);
  });

  it('pendingRawInput in the launch window with pendingRepo ALREADY false → true (the P2 window)', () => {
    // commitRepoSelection has set pendingRepo=false and forked; pendingRawInput
    // still awaits the new worker's prompt_ready. The old predicate gated on
    // pendingRepo===true and would MISS this — silently dropping the raw input.
    const ds = makeDs({ pendingRepo: false, pendingRawInput: '/status' } as any);
    expect(wouldDropInput(ds)).toBe(true);
  });

  it('pendingFollowUpInput staged for prompt_ready with pendingRepo false → true', () => {
    const ds = makeDs({
      pendingRepo: false,
      pendingFollowUpInput: { userPrompt: 'go', cliInput: 'wrapped go' },
    } as any);
    expect(wouldDropInput(ds)).toBe(true);
  });

  it('whitespace-only buffers do not count as droppable input', () => {
    const ds = makeDs({ pendingRepo: false, pendingRawInput: '   ', pendingPrompt: '  ' } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  it('mention/context-only pending (no submittable text) → false', () => {
    // pendingMentions / codexApp*Context are not submittable input on their own.
    const ds = makeDs({
      pendingRepo: true,
      pendingMentions: [{ openId: 'ou_x' }],
      pendingCodexAppApplicationContext: { some: 'ctx' },
    } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  // ─── P2 regression: the immediate-launch (pinned/defaultWorkingDir) path ───
  // seeds pendingPrompt/pendingCodexAppText/pendingAttachments as MIRROR fields,
  // forks, and clears only pendingTurnId — leaving those fields on an already-
  // delivered session with pendingRepo=false. Flagging them would wrongly warn
  // "message not delivered, resend" → user re-runs a possibly non-idempotent
  // command. So repo-select mirror fields must ONLY count when pendingRepo===true.
  it('pinned launch residue: pendingPrompt with pendingRepo=false → false (already delivered)', () => {
    const ds = makeDs({ pendingRepo: false, pendingPrompt: 'already ran' } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  it('pinned launch residue: pendingCodexAppText with pendingRepo=false → false', () => {
    const ds = makeDs({ pendingRepo: false, pendingCodexAppText: 'ran visible text' } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  it('pinned launch residue: pendingAttachments with pendingRepo=false → false', () => {
    const ds = makeDs({ pendingRepo: false, pendingAttachments: [{ key: 'img_1' }] } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  it('pinned launch residue: pendingFollowUps with pendingRepo=false → false', () => {
    const ds = makeDs({ pendingRepo: false, pendingFollowUps: ['a', 'b'] } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  it('raw/follow-up stay independent: pendingRawInput true even alongside pendingRepo=false residue', () => {
    // The launch window that IS real: raw input still awaiting prompt_ready,
    // coexisting with an already-delivered pendingPrompt mirror. raw wins → true.
    const ds = makeDs({ pendingRepo: false, pendingPrompt: 'delivered', pendingRawInput: '/status' } as any);
    expect(wouldDropInput(ds)).toBe(true);
  });
});

describe('P2 · clear actually removes what the predicate flagged', () => {
  it('the launch-window fields the predicate now covers are all cleared', () => {
    const ds = makeDs({
      pendingRepo: false,
      pendingRawInput: '/status',
      pendingFollowUpInput: { userPrompt: 'go', cliInput: 'wrapped go' },
      pendingPrompt: 'hi',
    } as any);
    expect(wouldDropInput(ds)).toBe(true);
    clearForAdopt(ds);
    // Everything the predicate reads is now gone → a second check is false.
    expect(wouldDropInput(ds)).toBe(false);
    expect(ds.pendingRawInput).toBeUndefined();
    expect(ds.pendingFollowUpInput).toBeUndefined();
    expect(ds.pendingRepo).toBe(false);
  });
});

// ─── P2#2 integration: guard placement OUTSIDE the launch branch ────────────
// A pure-helper test cannot prove WHERE the transfer guard sits. Drive the real
// adoptCodexNotifierEvent control flow with a session that is ALREADY on the
// target thread with a live worker (so the launch/re-fork branch is skipped
// entirely). Only an out-of-branch guard can still catch an in-flight transfer.
describe('P2#2 · adoptCodexNotifierEvent transfer guard (integration)', () => {
  const EVENT = {
    eventId: 'e'.repeat(64),
    type: 'codex_task_completed',
    source: 'codex-app',
    threadId: 'thread-live',
    nativeTurnId: 'nt-1',
    status: 'completed',
    cwd: '/repos/live',
    title: 'Live task',
    finalPreview: 'done',
  } as any;

  function liveAdoptedDs(): DaemonSession {
    // Same thread as EVENT + a live worker → the `cliSessionId !== threadId ||
    // !worker || worker.killed` launch branch is FALSE (skipped).
    return makeDs({
      session: { sessionId: 'sid-live', status: 'active', cliSessionId: 'thread-live' } as any,
      worker: { killed: false } as any,
      workingDir: '/repos/live',
    });
  }

  beforeEach(() => {
    mocks.transferring = new WeakSet();
    activeSessions.clear();
  });

  it('same-thread live worker + /relay transferring → throws, NOT a green success card', async () => {
    const ds = liveAdoptedDs();
    activeSessions.set(sessionKey('oc_dm', 'cli_app'), ds);
    mocks.transferring.add(ds); // relay in progress on this exact session

    const ctrl = new AbortController();
    await expect(
      adoptEvent('cli_app', EVENT, 'om_card', 'ou_owner', ctrl.signal, Date.now() + 2200),
    ).rejects.toThrow(/转移/); // "该会话正在转移，暂时无法接管…"
  });

  it('same-thread live worker + NOT transferring → returns the green adopt card (idempotent re-click)', async () => {
    const ds = liveAdoptedDs();
    activeSessions.set(sessionKey('oc_dm', 'cli_app'), ds);
    // no transfer gate → the out-of-branch guard is a no-op

    const ctrl = new AbortController();
    const card = await adoptEvent('cli_app', EVENT, 'om_card', 'ou_owner', ctrl.signal, Date.now() + 2200);
    expect(JSON.stringify(card)).toContain('已接管');
  });
});
