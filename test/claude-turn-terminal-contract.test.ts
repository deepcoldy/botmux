import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import {
  isClaudeTurnTerminalEvent,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';

type TerminalStatus = 'completed' | 'failed' | 'ambiguous';
type Terminal = { turnId: string; dispatchAttempt: number; status: TerminalStatus; errorCode?: string };

function user(uuid: string, content: string): TranscriptEvent {
  return { type: 'user', uuid, message: { role: 'user', content } };
}

function queued(uuid: string, prompt: string): TranscriptEvent {
  return { type: 'attachment', uuid, attachment: { type: 'queued_command', prompt } };
}

function assistant(
  uuid: string,
  text: string | undefined,
  stopReason: string,
): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: text === undefined ? [] : [{ type: 'text', text }],
      stop_reason: stopReason,
    },
  };
}

function turnDuration(uuid: string): TranscriptEvent {
  return { type: 'system', subtype: 'turn_duration', uuid };
}

/** Same two primitives used by worker.ts: transcript attribution + terminal IPC dedup. */
class ContractHarness {
  readonly queue = new BridgeTurnQueue();
  readonly deduper = new TurnTerminalDeduper();
  readonly emitted: Terminal[] = [];

  mark(turnId: string, content: string, dispatchAttempt: number): void {
    this.queue.mark(turnId, makeFingerprint(content), 100, content, dispatchAttempt);
  }

  ingest(events: TranscriptEvent[]): void {
    this.queue.ingest(events, '/tmp/claude-session.jsonl');
    for (const turn of this.queue.drainEmittable({ explicitTerminalOnly: true })) {
      this.emit(turn.turnId, turn.dispatchAttempt!, 'completed');
    }
  }

  fail(turnId: string, dispatchAttempt: number, errorCode: string): void {
    this.emit(turnId, dispatchAttempt, 'failed', errorCode);
  }

  exit(turnId: string, dispatchAttempt: number): void {
    this.emit(turnId, dispatchAttempt, 'ambiguous', 'cli_exit');
  }

  private emit(
    turnId: string,
    dispatchAttempt: number,
    status: TerminalStatus,
    errorCode?: string,
  ): void {
    if (!this.deduper.claim('receiver-session', turnId, dispatchAttempt)) return;
    this.emitted.push({ turnId, dispatchAttempt, status, ...(errorCode ? { errorCode } : {}) });
  }
}

describe('Claude durable turn terminal contract', () => {
  it('recognizes final assistant and turn-duration markers but not tool/continuation pauses', () => {
    expect(isClaudeTurnTerminalEvent(assistant('a1', 'done', 'end_turn'))).toBe(true);
    expect(isClaudeTurnTerminalEvent(assistant('a2', 'stopped', 'stop_sequence'))).toBe(true);
    expect(isClaudeTurnTerminalEvent(assistant('a3', undefined, 'max_tokens'))).toBe(true);
    expect(isClaudeTurnTerminalEvent(turnDuration('s1'))).toBe(true);
    expect(isClaudeTurnTerminalEvent(assistant('tool', undefined, 'tool_use'))).toBe(false);
    expect(isClaudeTurnTerminalEvent(assistant('pause', undefined, 'pause_turn'))).toBe(false);
    expect(isClaudeTurnTerminalEvent({
      ...assistant('side', 'subagent done', 'end_turn'),
      isSidechain: true,
    } as TranscriptEvent)).toBe(false);
  });

  it('maps two consecutive/type-ahead transcript turns to one terminal each', () => {
    const h = new ContractHarness();
    h.mark('delivery-1', 'first durable prompt', 1);
    h.mark('delivery-2', 'second durable prompt', 1);
    h.ingest([
      user('u1', 'first durable prompt'),
      assistant('tool-1', undefined, 'tool_use'),
      assistant('a1', 'first answer', 'end_turn'),
      turnDuration('duration-1'), // duplicate marker for the same turn
      queued('u2', 'second durable prompt'),
      assistant('a2', 'second answer', 'stop_sequence'),
      turnDuration('duration-2'),
    ]);

    expect(h.emitted).toEqual([
      { turnId: 'delivery-1', dispatchAttempt: 1, status: 'completed' },
      { turnId: 'delivery-2', dispatchAttempt: 1, status: 'completed' },
    ]);
  });

  it('settles an empty/silent final without fabricating visible assistant text', () => {
    const h = new ContractHarness();
    h.mark('silent-delivery', 'analyze silently', 4);
    h.ingest([
      user('u-empty', 'analyze silently'),
      assistant('a-empty', undefined, 'end_turn'),
      turnDuration('duration-empty'),
    ]);

    expect(h.emitted).toEqual([
      { turnId: 'silent-delivery', dispatchAttempt: 4, status: 'completed' },
    ]);
  });

  it('deduplicates replayed final markers and a second marker shape', () => {
    const h = new ContractHarness();
    h.mark('delivery-dedup', 'do once', 2);
    const final = assistant('a-final', 'done', 'end_turn');
    const duration = turnDuration('duration-final');
    h.ingest([user('u', 'do once'), final]);
    h.ingest([final, duration, duration]);

    expect(h.emitted).toEqual([
      { turnId: 'delivery-dedup', dispatchAttempt: 2, status: 'completed' },
    ]);
  });

  it('does not use a prompt-looking idle edge as a durable terminal', () => {
    const queue = new BridgeTurnQueue();
    queue.mark('permission-wait', makeFingerprint('needs permission'), 100, 'needs permission', 1);
    queue.ingest([
      user('u', 'needs permission'),
      assistant('tool', undefined, 'tool_use'),
    ]);
    expect(queue.drainEmittable({
      terminalBoundary: true,
      requireExplicitTerminalForDurable: true,
    })).toEqual([]);
  });

  it('uses the next transcript turn-start as a boundary for older marker-less Claude JSONL', () => {
    const h = new ContractHarness();
    h.mark('old-shape-1', 'first old prompt', 1);
    h.mark('old-shape-2', 'second old prompt', 1);
    h.ingest([
      user('old-u1', 'first old prompt'),
      queued('old-u2', 'second old prompt'),
    ]);
    expect(h.emitted).toEqual([
      { turnId: 'old-shape-1', dispatchAttempt: 1, status: 'completed' },
    ]);
  });

  it('lets exactly one outcome win transcript-final versus CLI-exit race', () => {
    const exitFirst = new ContractHarness();
    exitFirst.mark('exit-race', 'long task', 3);
    exitFirst.ingest([user('u-exit', 'long task'), assistant('tool', undefined, 'tool_use')]);
    exitFirst.exit('exit-race', 3);
    exitFirst.ingest([assistant('late-final', 'late result', 'end_turn'), turnDuration('late-duration')]);
    exitFirst.exit('exit-race', 3);
    expect(exitFirst.emitted).toEqual([
      { turnId: 'exit-race', dispatchAttempt: 3, status: 'ambiguous', errorCode: 'cli_exit' },
    ]);

    const finalFirst = new ContractHarness();
    finalFirst.mark('final-race', 'quick task', 7);
    finalFirst.ingest([user('u-final', 'quick task'), assistant('a-final', 'done', 'end_turn')]);
    finalFirst.exit('final-race', 7);
    expect(finalFirst.emitted).toEqual([
      { turnId: 'final-race', dispatchAttempt: 7, status: 'completed' },
    ]);
  });

  it('deduplicates hard-submit and usage-limit failure races with later final/exit', () => {
    const h = new ContractHarness();
    h.mark('hard-failure', 'hard fail', 1);
    h.fail('hard-failure', 1, 'submit_impossible:unsupported_submit_key');
    h.exit('hard-failure', 1);

    h.mark('usage-limit', 'limited', 2);
    h.fail('usage-limit', 2, 'submit_usage_limit');
    h.exit('usage-limit', 2);

    expect(h.emitted).toEqual([
      {
        turnId: 'hard-failure',
        dispatchAttempt: 1,
        status: 'failed',
        errorCode: 'submit_impossible:unsupported_submit_key',
      },
      {
        turnId: 'usage-limit',
        dispatchAttempt: 2,
        status: 'failed',
        errorCode: 'submit_usage_limit',
      },
    ]);
  });

  it('wires all durable failure/exit paths through the same terminal emitter', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(source).toContain("emitDurableFailure(`submit_impossible:${reason}`)");
    expect(source).toContain("emitDurableFailure('submit_usage_limit')");
    expect(source).toContain("emitDurableFailure('submit_unconfirmed')");
    expect(source).toContain('bridgeQueue.dropPendingTurn(bridgeTurnId, turnIdentity?.dispatchAttempt)');
    expect(source).toContain("'terminal_bridge_unavailable'");
    expect(source).toMatch(/emitTurnTerminal\([\s\S]*?'ambiguous',[\s\S]*?'cli_exit'/);
    expect(source).toContain('requireExplicitTerminalForDurable: true');
  });
});
