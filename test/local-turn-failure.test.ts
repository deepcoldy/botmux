import { describe, expect, it } from 'vitest';
import { BridgeTurnQueue, makeFingerprint, type BridgePendingTurn } from '../src/services/bridge-turn-queue.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';
import { localTurnFailureNotice } from '../src/services/local-turn-failure.js';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const LIVE_SINCE = Date.parse('2026-10-21T15:00:00Z');
const LIVE_AT = '2026-10-21T15:40:01.328Z';

function failedLocal(overrides: Partial<BridgePendingTurn> = {}): BridgePendingTurn {
  return {
    turnId: 'local-headless-abc',
    started: true,
    isLocal: true,
    assistantUuids: [],
    precedingLarkTurnId: 'om_lark',
    terminalOutcome: { status: 'failed', errorCode: 'provider_server_error', retryable: true },
    terminalOutcomeAtMs: Date.parse(LIVE_AT),
    ...overrides,
  };
}

describe('localTurnFailureNotice', () => {
  const opts = { liveSinceMs: LIVE_SINCE, zeroPromptTerminalSync: false };

  it('anchors a live failure to the Lark turn that preceded the local turn', () => {
    expect(localTurnFailureNotice(failedLocal(), opts))
      .toEqual({ errorCode: 'provider_server_error', replyTurnId: 'om_lark' });
  });

  it('keeps a scheduled fire on its create-time anchor, never the latest topic', () => {
    expect(localTurnFailureNotice(failedLocal({
      turnId: 'scheduled-fire-1', isScheduled: true, replyAnchorTurnId: 'om_created_here',
    }), opts)).toEqual({ errorCode: 'provider_server_error', replyTurnId: 'om_created_here' });
    expect(localTurnFailureNotice(failedLocal({
      turnId: 'scheduled-fire-2', isScheduled: true, replyAnchorTurnId: undefined,
    }), opts)).toEqual({ errorCode: 'provider_server_error' });
  });

  it('uses the local turn itself under zero-injection terminal sync', () => {
    expect(localTurnFailureNotice(failedLocal(), { ...opts, zeroPromptTerminalSync: true }))
      .toEqual({ errorCode: 'provider_server_error', replyTurnId: 'local-headless-abc' });
  });

  it('stays silent for history and for failures it cannot date', () => {
    expect(localTurnFailureNotice(failedLocal({ terminalOutcomeAtMs: LIVE_SINCE - 1 }), opts)).toBeUndefined();
    expect(localTurnFailureNotice(failedLocal({ terminalOutcomeAtMs: undefined }), opts)).toBeUndefined();
    expect(localTurnFailureNotice(failedLocal({ terminalOutcome: { status: 'completed' } }), opts)).toBeUndefined();
  });
});

/**
 * Runs the worker's real emitReadyTurns against a real queue: what reaches the
 * daemon for a failed local turn (a notice, never a turn terminal), and that
 * the split-final Lark turn fails as itself.
 */
describe('worker emitReadyTurns: failed turns', () => {
  function harness() {
    const sent: Array<Record<string, unknown>> = [];
    const terminals: unknown[][] = [];
    const queue = new BridgeTurnQueue();
    const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean }) => void>('emitReadyTurns', {
      bridgeQueue: queue,
      bridgeFingerprintScanLastMs: new Map(),
      journalBridgeTurnClear: () => {},
      rememberTurnLinkRefMode: () => {},
      readSendMarkers: () => [],
      lastInitConfig: { cliId: 'claude-code' },
      log: () => {},
      cliName: () => 'Claude',
      t,
      zeroPromptTerminalSync: () => false,
      localTurnFailureNotice,
      WORKER_STARTED_AT_MS: LIVE_SINCE,
      send: (msg: Record<string, unknown>) => { sent.push(msg); },
      emitTurnTerminal: (...args: unknown[]) => { terminals.push(args); },
    });
    return { queue, sent, terminals, emitReadyTurns };
  }
  const user = (uuid: string, content: string): TranscriptEvent => ({ type: 'user', uuid, message: { role: 'user', content } });
  const block = (uuid: string, content: unknown[], stop: string): TranscriptEvent =>
    ({ type: 'assistant', uuid, message: { id: 'msg-final', role: 'assistant', content, stop_reason: stop } } as TranscriptEvent);
  const connectionLost = (uuid: string, timestamp: string): TranscriptEvent => ({
    type: 'assistant', uuid, timestamp, isApiErrorMessage: true, error: 'server_error',
    message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Connection lost mid-response.' }] },
  } as TranscriptEvent);
  const duration = (uuid: string): TranscriptEvent => ({ type: 'system', subtype: 'turn_duration', uuid });

  it('sends a notice to the preceding Lark turn for a live headless failure, and no terminal', () => {
    const h = harness();
    h.queue.mark('om_review', makeFingerprint('re-review please'), 100, 're-review please', 1);
    h.queue.ingest([user('u1', 're-review please'), block('a1', [{ type: 'text', text: 'done' }], 'end_turn'), duration('d1')]);
    // Already delivered; only what follows is under test.
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true }).map(turn => turn.turnId)).toEqual(['om_review']);
    // A later stretch of output with nothing collecting — e.g. a turn whose
    // user line a restart absorbed.
    h.queue.ingest([block('a2', [{ type: 'text', text: 'more work' }], 'tool_use'), connectionLost('e2', LIVE_AT), duration('d2')]);
    h.emitReadyTurns({ explicitTerminalOnly: true });

    expect(h.terminals).toEqual([]);
    expect(h.sent).toEqual([{
      type: 'user_notify',
      turnId: 'om_review',
      message: t('worker.local_turn_failed', { cliName: 'Claude', errorCode: 'provider_server_error' }),
    }]);
  });

  it('sends nothing for a failure replayed from before the worker started', () => {
    const h = harness();
    h.queue.ingest([user('local-u', 'typed in the pane'), connectionLost('e1', '2026-10-21T05:17:00.000Z'), duration('d1')]);
    h.emitReadyTurns({ explicitTerminalOnly: true });
    expect(h.terminals).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('fails the Lark turn itself when its final message was split across reads', () => {
    const h = harness();
    h.queue.noteDurationMarkerObserved();
    h.queue.mark('om_review', makeFingerprint('re-review please'), 100, 're-review please', 1);
    h.queue.ingest([user('u1', 're-review please'), block('a-think', [{ type: 'thinking', thinking: '…' }], 'end_turn')]);
    h.emitReadyTurns({ explicitTerminalOnly: true });
    h.emitReadyTurns();
    expect(h.terminals).toEqual([]);
    h.queue.ingest([block('a-text', [{ type: 'text', text: 'posting it' }], 'end_turn'), connectionLost('e1', LIVE_AT), duration('d1')]);
    h.emitReadyTurns({ explicitTerminalOnly: true });

    expect(h.terminals).toEqual([['om_review', 'failed', 'provider_server_error', 1, undefined, true]]);
    expect(h.sent).toEqual([]);
  });
});
