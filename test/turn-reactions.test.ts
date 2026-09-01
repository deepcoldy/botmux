/**
 * Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming card disabled):
 *   - noteTurnReceived(ds, msgId): react 冲! (GoGoGo) the instant a user message
 *     is accepted for the session, tracked per-message in ds.pendingAckReactions.
 *   - finishTurnReactions(ds): when the worker next goes idle, flip every pending
 *     ✋ to ✅ (DONE) and clear the list.
 *
 * Binding the "received" reaction to the message (not a worker status edge) is
 * what makes type-ahead / busy-batched messages each get their own reaction —
 * the regression this test locks (Codex review of the patch-removal change).
 *
 * Run:  pnpm vitest run test/turn-reactions.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return { ...actual, addReaction: mocks.addReaction, removeReaction: mocks.removeReaction };
});

import { registerBot } from '../src/bot-registry.js';
import { noteTurnReceived } from '../src/daemon.js';
import {
  initWorkerPool,
  __testOnly_finishTurnReactions as finishTurnReactions,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'reaction_app';

function makeDs(over: Partial<DaemonSession> = {}): DaemonSession {
  // status:'active' is required by the screen_update handler's ownsLifecycleMutation
  // guard (added with the ZMX lifecycle-ownership work). Without it every
  // screen_update breaks before lastScreenStatus updates, so the behavioral
  // working→idle / working→limited flip tests below never see a real edge.
  const session: any = { sessionId: 'sess-' + Math.random().toString(36).slice(2), chatId: 'oc_x', rootMessageId: 'om_root', status: 'active' };
  return { session, larkAppId: APP, chatId: 'oc_x', scope: 'chat', ...over } as unknown as DaemonSession;
}

// Reactions are auto-on for card-off sessions, so the gate is driven by
// disableStreamingCard (streaming card on → no reactions; off → reactions).
function registerWith(reactionsOn: boolean, opts: { silentTurnReactions?: boolean; receivedReactionEmoji?: string; doneReactionEmoji?: string } = {}) {
  registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: ['ou_o'],
    disableStreamingCard: reactionsOn || undefined,
    silentTurnReactions: opts.silentTurnReactions || undefined,
    receivedReactionEmoji: opts.receivedReactionEmoji,
    doneReactionEmoji: opts.doneReactionEmoji,
  });
}

describe('two-phase turn reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-react-'));
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
  });

  it('streaming card on (default): no reaction on receipt', async () => {
    registerWith(false);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('Plan B: a meeting-agent session reacts to plain user turns like any card-off session', async () => {
    registerWith(true);
    const ds = makeDs({
      pendingAckReactions: [{ messageId: 'om_old', reactionId: 'rid_old' }],
    });
    // The vcMeetingReceiver marker is now pure delivery metadata. A plain user
    // message (no stamped meeting @mention origin) is an ordinary turn, so it
    // gets the ✋ on receipt and its pending ✋ settle to ✅ on idle.
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };

    await noteTurnReceived(ds, 'om_new');
    await finishTurnReactions(ds);

    // ✋ added on the new user message; the stale + new pending entries settle.
    expect(mocks.addReaction).toHaveBeenCalled();
    expect(mocks.removeReaction).toHaveBeenCalled();
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('reacts 冲! (GoGoGo) on each accepted message and dedups by message id', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_a');
    await noteTurnReceived(ds, 'om_a'); // same message — must not double-react
    await noteTurnReceived(ds, 'om_b');
    expect(mocks.addReaction).toHaveBeenCalledTimes(2);
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'GoGoGo');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a', 'om_b']);
  });

  it('can use Get as the received reaction for substitute turns', async () => {
    registerWith(true);
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_sub', undefined, undefined, undefined, 'Get');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_sub', 'Get');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_sub']);
  });

  it('substitute turn is card-off even when streaming card is globally enabled', async () => {
    registerWith(false);
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_trigger', turnId: 'om_a', updatedAt: new Date().toISOString(), substitute: true },
    });

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });

  it('queued substitute turn A stays card-off after normal turn B overwrote the slot (per-turn gate)', async () => {
    registerWith(false);
    const ds = makeDs({
      // Slot points at the LATEST turn (normal B); the executing turn A is a
      // substitute turn recorded in the per-turn map.
      currentReplyTarget: { rootMessageId: 'om_b', turnId: 'om_b', updatedAt: new Date().toISOString() },
      session: {
        sessionId: 'sess-ab', chatId: 'oc_x', rootMessageId: 'om_root',
        replyTargets: {
          om_a: { rootMessageId: 'om_trigger_a', updatedAt: new Date().toISOString(), substitute: true },
          om_b: { rootMessageId: 'om_b', updatedAt: new Date().toISOString() },
        },
      },
    });

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
  });

  it('reverse order: normal turn A keeps its card after substitute turn B overwrote the slot', async () => {
    registerWith(false);
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_trigger_b', turnId: 'om_b', updatedAt: new Date().toISOString(), substitute: true },
      session: {
        sessionId: 'sess-ba', chatId: 'oc_x', rootMessageId: 'om_root',
        replyTargets: {
          om_a: { rootMessageId: 'om_a', updatedAt: new Date().toISOString() },
          om_b: { rootMessageId: 'om_trigger_b', updatedAt: new Date().toISOString(), substitute: true },
        },
      },
    });

    await noteTurnReceived(ds, 'om_a');

    // Normal turn A is card-on → no ack reaction for it, even though the slot
    // currently belongs to substitute turn B.
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('a later non-substitute turn in the same session gets the streaming card back (no session latch)', async () => {
    registerWith(false);
    const ds = makeDs({
      // A direct @bot turn overwrote the reply target: substitute flag gone.
      currentReplyTarget: { rootMessageId: 'om_direct', turnId: 'om_b', updatedAt: new Date().toISOString() },
    });

    await noteTurnReceived(ds, 'om_b');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('silentTurnReactions suppresses receipt reactions in card-off sessions', async () => {
    registerWith(true, { silentTurnReactions: true });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('silentTurnReactions is a no-op when the streaming card is on (gate order)', async () => {
    // Card-on already early-returns before the silent gate, so the flag must not
    // perturb card-on behavior — same outcome as a plain card-on session.
    registerWith(false, { silentTurnReactions: true });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('skips non-message ids (doc-comment id / chat anchor cannot carry a reaction)', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'comment_123');
    await noteTurnReceived(ds, 'oc_chat');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('type-ahead: two messages while busy each get 冲! then both flip to ✅ at idle', async () => {
    registerWith(true);
    const ds = makeDs();
    // B arrives while A is still being processed — no second working edge, but
    // each accepted message still gets its own ✋ because we bind to the message.
    await noteTurnReceived(ds, 'om_a');
    await noteTurnReceived(ds, 'om_b');
    expect(mocks.addReaction).toHaveBeenCalledTimes(2);

    mocks.addReaction.mockClear();
    await finishTurnReactions(ds);

    // Each ✋ removed and replaced with ✅ DONE — neither message is left behind.
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('silentTurnReactions clears pending received reactions without adding DONE', async () => {
    registerWith(true, { silentTurnReactions: true });
    const ds = makeDs({
      pendingAckReactions: [
        { messageId: 'om_a', reactionId: 'rid_om_a' },
        { messageId: 'om_b', reactionId: 'rid_om_b' },
      ],
    });

    await finishTurnReactions(ds);

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('does not register an in-flight ✋ that a concurrent idle could DONE prematurely', async () => {
    registerWith(true);
    const ds = makeDs();
    // addReaction for B hangs until released — simulating a slow Lark round-trip
    // while a previous turn finishes.
    let releaseB!: (v: string) => void;
    const bPending = new Promise<string>((r) => { releaseB = r; });
    mocks.addReaction.mockReturnValueOnce(bPending as any);

    const notePromise = noteTurnReceived(ds, 'om_b'); // in flight, not yet awaited

    // A previous turn's idle fires while addReaction(om_b) is still pending.
    await finishTurnReactions(ds);
    // om_b is NOT registered yet → no premature DONE, list stays empty.
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(ds.pendingAckReactions ?? []).toEqual([]);

    // addReaction resolves → only now does om_b register.
    releaseB('rid_om_b');
    await notePromise;
    expect(ds.pendingAckReactions?.map((a) => a.messageId)).toEqual(['om_b']);

    // om_b's own idle now flips it to ✅ exactly once.
    await finishTurnReactions(ds);
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('finishTurnReactions with no pending acks is a no-op', async () => {
    const ds = makeDs();
    await finishTurnReactions(ds);
    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('custom emoji: bots.json overrides the received / done emoji_type', async () => {
    registerWith(true, { receivedReactionEmoji: 'OK', doneReactionEmoji: 'Thumbsup' });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'OK');

    mocks.addReaction.mockClear();
    await finishTurnReactions(ds);
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'Thumbsup');
  });

  it('received == done emoji: turn-end keeps the marker unchanged (Pi premature-idle guard)', async () => {
    // Both configured to GoGoGo — a premature idle removes then re-adds the same
    // 冲!, so a misleading ✅ never appears even if idle fires mid-turn.
    registerWith(true, { receivedReactionEmoji: 'GoGoGo', doneReactionEmoji: 'GoGoGo' });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');

    mocks.addReaction.mockClear();
    await finishTurnReactions(ds);
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
  });
});

/**
 * Source-level pin: the screen_update handler must only flip ✋→✅ after a real
 * busy period (working/analyzing → idle). Cold-start starting→idle
 * (ready-gate settle before the turn has gone working) must leave GoGoGo alone
 * — otherwise card-off Grok sessions DONE a message while the CLI is still
 * chewing the first prompt. A limited settle is also excluded (rate limit is a
 * blocked turn, not completion — see test/rate-limit-notify.test.ts).
 */
describe('turn reaction idle edge gate (source)', () => {
  it('finishTurnReactions is gated on prevStatus working|analyzing and idle settle', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/core/worker-pool.ts'),
      'utf8',
    );
    // Anchor on the screen_update reaction comment — "// Usage ledger" alone
    // also appears on the kill/close path and would pick the wrong block.
    const blockStart = source.indexOf('// Usage ledger + turn reactions') >= 0
      ? source.indexOf('// Usage ledger + turn reactions')
      : source.indexOf('// Usage ledger: any settle-to-idle');
    expect(blockStart).toBeGreaterThan(-1);
    // Window is wider than the original 900 chars: the gate now also excludes
    // limited settles, so the condition line carries the extra idle check.
    const block = source.slice(blockStart, blockStart + 1400);
    expect(block).toContain("prevStatus === 'working' || prevStatus === 'analyzing'");
    expect(block).toContain('void finishTurnReactions(ds)');
    // Must NOT call finishTurnReactions on every idle/limited edge unconditionally.
    expect(block).not.toMatch(
      /if \(ds\.lastScreenStatus === 'idle' \|\| ds\.lastScreenStatus === 'limited'\) \{\s*recordUsageForDaemonSession\(ds\);\s*void finishTurnReactions\(ds\);/,
    );
  });
});

/**
 * Behavioral pin for PR #633 review P2: card-off finishTurnReactions requires a
 * working→idle edge. Argv cold-start (Pi/Gemini) must seed working before idle
 * (worker side); daemon-side, bare undefined→idle must NOT flip, while the
 * seeded working→idle sequence must.
 */
describe('turn reaction screen_update behavioral gate', () => {
  function makeFakeWorker() {
    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.send = vi.fn();
    worker.kill = vi.fn();
    worker.pid = 4242;
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    return worker;
  }

  async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    // finishTurnReactions is fire-and-forget void; wait a tick for awaits
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-react-behav-'));
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('undefined→idle alone does not DONE pending GoGoGo (gate)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'done?', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });

  it('working→idle flips pending GoGoGo to DONE (argv seed / flushPending path)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    // Mirrors markPromptReady seeding working then idle for quiescence argv CLIs.
    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    await flush();
    worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('working→limited does NOT DONE (rate limit is a blocked turn, not completion)', async () => {
    // A limited settle means the CLI is stuck on a rate/usage limit. DONE-ing
    // the ✋ here made users think the task finished while it actually stalled;
    // the proactive rate-limit notification (test/rate-limit-notify.test.ts)
    // owns that attention instead. The ✋ must stay until a real idle settle.
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: 'Rate limit exceeded. Try again at 10:36 PM.',
      status: 'working',
    });
    await flush();
    worker.emit('message', {
      type: 'screen_update',
      content: 'Rate limit exceeded. Try again at 10:36 PM.',
      status: 'limited',
      usageLimit: {
        limited: true,
        kind: 'rate',
        retryAtMs: Date.now() + 60_000,
        retryLabel: '10:36 PM',
        retryReady: false,
      },
    });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });

  it('limited→limited alone does not DONE (no working edge)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limitedMsg = {
      type: 'screen_update' as const,
      content: 'Rate limit exceeded. Try again at 10:36 PM.',
      status: 'limited' as const,
      usageLimit: {
        limited: true as const,
        kind: 'rate' as const,
        retryAtMs: Date.now() + 60_000,
        retryLabel: '10:36 PM',
        retryReady: false,
      },
    };
    worker.emit('message', limitedMsg);
    await flush();
    worker.emit('message', limitedMsg);
    await flush();

    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });
});


