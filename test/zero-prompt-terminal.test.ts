import { describe, expect, it } from 'vitest';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { shouldSuppressBridgeEmit, shouldEmitEmptyCompletedBridgeFallback } from '../src/services/bridge-fallback-gate.js';
import { captureTerminalReplyContext } from '../src/core/terminal-reply-context.js';
import type { DaemonSession } from '../src/core/types.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';

const user = (uuid: string, text: string): TranscriptEvent => ({
  type: 'user', uuid, timestamp: new Date(1_000).toISOString(), message: { role: 'user', content: text },
});
const final = (uuid: string, text: string): TranscriptEvent => ({
  type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

describe('zero-prompt terminal replies', () => {
  it('captures a retry after 400 and later terminal rounds, ignoring model menus and history', () => {
    const starts: string[] = [];
    const q = new BridgeTurnQueue(t => starts.push(t.turnId));
    const old = [user('old', 'old question'), final('old-final', 'old answer')];
    q.absorb(old);
    q.ingest(old);
    q.mark('om_task', makeFingerprint('review task'));
    q.ingest([user('initial', 'review task'), {
      ...final('error', 'API Error: 400 unknown error'), isApiErrorMessage: true, apiErrorStatus: 400,
    }]);
    expect(q.drainEmittable({ explicitTerminalOnly: true })[0].terminalOutcome?.status).toBe('failed');
    q.ingest([
      user('caveat', '<local-command-caveat>local commands</local-command-caveat>'),
      user('model', '<command-name>/model</command-name><command-message>model</command-message>'),
      user('stdout', '<local-command-stdout>Set model to new-model</local-command-stdout>'),
    ]);
    expect(starts).toEqual([]);
    expect(q.drainEmittable()).toEqual([]);
    for (const [id, prompt] of [['retry', 'review task'], ['followup', 'continue checking']]) {
      q.ingest([user(id, prompt), final(`${id}-final`, 'finished')]);
      const turn = q.drainEmittable({ explicitTerminalOnly: true })[0];
      expect(turn).toMatchObject({ turnId: `local-${id}`, isLocal: true, terminalOutcome: { status: 'completed' } });
      const gate = { ...turn, finalText: 'finished' };
      expect(shouldSuppressBridgeEmit(gate, undefined, [], false, 'transcript')).toBe(true);
      expect(shouldSuppressBridgeEmit({ ...gate, forwardLocalFinal: true }, undefined, [], false, 'transcript')).toBe(false);
    }
    expect(starts).toEqual(['local-retry', 'local-followup']);
    // File-watch re-drain cannot create a second delivery.
    q.ingest([user('retry', 'review task'), final('retry-final', 'finished')]);
    expect(q.drainEmittable()).toEqual([]);
  });

  it('still suppresses silence, empty local turns and explicit final duplicates', () => {
    const gate = { isLocal: true, forwardLocalFinal: true, markTimeMs: 100, finalText: 'answer' };
    expect(shouldSuppressBridgeEmit(gate, undefined, [{ sentAtMs: 110, responseKind: 'final' }], false, 'transcript')).toBe(true);
    expect(shouldSuppressBridgeEmit({ ...gate, finalText: 'BOTMUX_NOTHING_TO_SEND' }, undefined, [], false, 'transcript')).toBe(true);
    expect(shouldEmitEmptyCompletedBridgeFallback({ ...gate, finalText: '' }, undefined, [], false, 'transcript')).toBe(false);
    expect(shouldSuppressBridgeEmit({ ...gate, terminalStatus: 'failed' }, undefined, [], false, 'transcript')).toBe(true);
  });

  it('uses structured local-turn observation without replaying pre-attach history', () => {
    const starts: string[] = [];
    const q = new CodexBridgeQueue(() => 10_000, t => starts.push(t.turnId));
    q.setLocalTurns(true, 10_000);
    q.ingest([{ kind: 'user', uuid: 'historical', timestampMs: 1, text: 'old question' }]);
    q.ingest([{ kind: 'user', uuid: 'new', timestampMs: 10_001, text: 'terminal question' },
      { kind: 'assistant_final', uuid: 'answer', timestampMs: 10_010, text: 'terminal answer' }]);
    const turns = q.drainEmittable();
    expect(starts).toEqual(['codex-local-new']);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ isLocal: true, finalText: 'terminal answer' });
  });

  it('freezes the latest original initiator and destination for each terminal round', () => {
    const ds = { scope: 'chat', chatId: 'oc_chat', session: {
      quoteTargetId: 'om_a', quoteTargetSenderOpenId: 'ou_a', quoteTargetSenderIsBot: true,
      replyTargets: { om_a: { senderOpenId: 'ou_a', updatedAt: new Date(100).toISOString() } },
      turnReplyContexts: { om_a: { target: { mode: 'thread', rootMessageId: 'om_topic_a' }, replyTargetSenderOpenId: 'ou_a', replyTargetSenderIsBot: true } },
    } } as unknown as DaemonSession;
    captureTerminalReplyContext(ds, 'local-1', 200);
    captureTerminalReplyContext(ds, 'local-2', 300);
    ds.session.quoteTargetId = 'om_b';
    ds.session.quoteTargetSenderOpenId = 'ou_b';
    ds.session.replyTargets!.om_b = { senderOpenId: 'ou_b', updatedAt: new Date(400).toISOString() };
    ds.session.turnReplyContexts!.om_b = { target: { mode: 'quote', rootMessageId: 'om_topic_b' }, replyTargetSenderOpenId: 'ou_b', replyTargetSenderIsBot: false };
    captureTerminalReplyContext(ds, 'local-3', 500);
    captureTerminalReplyContext(ds, 'local-late-final', 550, 'local-1');
    // An IPC whose native start precedes B still belongs to A.
    captureTerminalReplyContext(ds, 'local-delayed', 350);
    for (const id of ['local-1', 'local-2', 'local-delayed', 'local-late-final']) {
      expect(ds.session.turnReplyContexts![id]).toMatchObject({ target: { mode: 'thread', rootMessageId: 'om_topic_a' }, replyTargetSenderOpenId: 'ou_a', replyTargetSenderIsBot: true });
    }
    expect(ds.session.turnReplyContexts!['local-3']).toMatchObject({ target: { mode: 'quote', rootMessageId: 'om_topic_b' }, replyTargetSenderOpenId: 'ou_b' });
    expect(captureTerminalReplyContext(ds, 'local-1', 600)).toBe(false);
    expect(ds.session.quoteTargetId).toBe('om_b');
  });

  it('retains the reply address for text arriving after an empty native end_turn', () => {
    const starts: Array<{ turnId: string; replyContextTurnId?: string }> = [];
    const q = new BridgeTurnQueue(t => starts.push(t));
    q.ingest([user('replayed', 'review again'), final('empty', '')]);
    q.drainEmittable({ explicitTerminalOnly: true });
    q.ingest([final('late-final', 'review result')]);
    expect(starts).toMatchObject([
      { turnId: 'local-replayed' },
      { turnId: 'local-headless-late-final', replyContextTurnId: 'local-replayed' },
    ]);
  });
});
