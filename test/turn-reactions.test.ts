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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
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
import { __testOnly_finishTurnReactions as finishTurnReactions } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'reaction_app';

function makeDs(over: Partial<DaemonSession> = {}): DaemonSession {
  const session: any = { sessionId: 'sess-' + Math.random().toString(36).slice(2), chatId: 'oc_x', rootMessageId: 'om_root' };
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
