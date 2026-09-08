import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import {
  isClaudeTurnTerminalEvent,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';

type TerminalStatus = 'completed' | 'failed' | 'ambiguous';
type Terminal = { turnId: string; dispatchAttempt: number; status: TerminalStatus; errorCode?: string; retryable?: boolean };

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
      if (turn.rateLimited) continue;
      const outcome = turn.terminalOutcome;
      // Mirrors worker.ts emitReadyTurns: a SYNTHESISED local turn has no Lark
      // turn behind it, so its failure must not reach the daemon (which would
      // render a user-facing 「本轮执行失败」card for a turn nobody sent).
      if (turn.isLocal && outcome && outcome.status !== 'completed') continue;
      this.emit(
        turn.turnId,
        turn.dispatchAttempt!,
        outcome?.status ?? 'completed',
        outcome?.errorCode,
        outcome?.retryable,
      );
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
    retryable?: boolean,
  ): void {
    if (!this.deduper.claim('receiver-session', turnId, dispatchAttempt)) return;
    this.emitted.push({
      turnId,
      dispatchAttempt,
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
    });
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

  it('maps the observed EOF fixture to retryable failed and ignores the later duration marker', () => {
    const h = new ContractHarness();
    h.mark('delivery-eof', 'continue the task', 1);
    h.ingest([
      user('u-eof', 'continue the task'),
      {
        type: 'assistant',
        uuid: 'fixture-error',
        isApiErrorMessage: true,
        error: 'unknown',
        message: {
          role: 'assistant',
          stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'API Error: provider disconnected: unexpected EOF' }],
        },
      },
      turnDuration('fixture-duration'),
    ]);

    expect(h.emitted).toEqual([{
      turnId: 'delivery-eof',
      dispatchAttempt: 1,
      status: 'failed',
      errorCode: 'provider_unexpected_eof',
      retryable: true,
    }]);
  });

  it('does not emit an ordinary terminal for a structured 429 boundary', () => {
    const h = new ContractHarness();
    h.mark('limited-turn', 'limited request', 1);
    h.ingest([
      user('u-limit', 'limited request'),
      {
        type: 'assistant', uuid: 'rl-contract', isApiErrorMessage: true,
        error: 'rate_limit', apiErrorStatus: 429,
        message: { role: 'assistant', content: [], stop_reason: 'stop_sequence' },
      },
      turnDuration('duration-limit'),
    ]);

    expect(h.emitted).toEqual([]);
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
    expect(source).toContain("emitDurableTerminal(`submit_impossible:${reason}`)");
    expect(source).toContain("emitDurableTerminal('submit_usage_limit')");
    expect(source).toContain("emitDurableTerminal('submit_unconfirmed')");
    expect(source).toContain('dropFailedBridgeMark(bridgeTurnId, turnIdentity?.dispatchAttempt)');
    expect(source).toContain("'terminal_bridge_unavailable'");
    expect(source).toMatch(/emitTurnTerminal\([\s\S]*?'ambiguous',[\s\S]*?'cli_exit'/);
    expect(source).toContain('requireExplicitTerminalForDurable: true');
  });

  /**
   * A synthesised local turn must never raise a user-visible failure.
   *
   * `local-*` / `local-headless-*` ids are minted by the attribution queue for
   * transcript activity that matched no pending Lark mark — terminal-typed
   * input, or (after a restart) replayed history whose original mark is gone.
   * Its transcript FALLBACK is already suppressed unconditionally, but its
   * TERMINAL used to flow straight through, and the daemon renders any
   * non-completed terminal as a 「本轮执行失败」card stamped `new Date()` plus
   * the session's CURRENT lastUserPrompt — so the card named the wrong time
   * and the wrong task.
   *
   * MEASURED on a live session: a `provider_server_error` recorded at 09:17
   * was re-surfaced as a fresh failure card at 16:44 and again the next day at
   * 04:32, both times at a daemon restart. The production log is unambiguous —
   * 33 local turns logged "suppressed" on that tick and the failing one logged
   * nothing at all, because it took the early `continue` before the gate.
   */
  describe('synthesised local turns raise no user-visible failure', () => {
    /** The exact shape claude writes when a stream dies mid-response. */
    function connectionLost(uuid: string): TranscriptEvent {
      return {
        type: 'assistant',
        uuid,
        isApiErrorMessage: true,
        error: 'server_error',
        message: {
          role: 'assistant',
          stop_reason: 'stop_sequence',
          content: [{
            type: 'text',
            text: 'API Error: Connection lost mid-response. The response above may be incomplete.',
          }],
        },
      } as TranscriptEvent;
    }

    it('emits no terminal for a local turn that died with provider_server_error', () => {
      const h = new ContractHarness();
      // No mark() at all → the user event synthesises a local turn.
      h.ingest([
        user('local-u', 'something typed straight into the pane'),
        assistant('local-a', 'partial work', 'tool_use'),
        connectionLost('local-err'),
        turnDuration('local-dur'),
      ]);
      expect(h.emitted).toEqual([]);
    });

    it('emits no terminal for a HEADLESS local turn that died with provider_server_error', () => {
      // The other synthesis path: an assistant boundary arrives with no
      // collecting context at all (a restart cut the stream and the user event
      // was already absorbed), so the queue mints `local-headless-<uuid>`.
      // Reviewed as logically covered by the same gate, but it had no sample of
      // its own — and "covered by the same branch" is an argument, not a test.
      const h = new ContractHarness();
      h.ingest([
        assistant('headless-a', 'partial work with no user event', 'tool_use'),
        connectionLost('headless-err'),
        turnDuration('headless-dur'),
      ]);
      expect(h.emitted).toEqual([]);
    });

    it('still emits the failure for a REAL Lark turn — the card must not be lost', () => {
      // Positive control. Without this, the fix above could be "suppress
      // everything" and the suite would not notice.
      const h = new ContractHarness();
      h.mark('delivery-1', 'a real lark prompt', 1);
      h.ingest([
        user('u1', 'a real lark prompt'),
        assistant('a1', 'partial work', 'tool_use'),
        connectionLost('err-1'),
        turnDuration('dur-1'),
      ]);
      expect(h.emitted).toEqual([{
        turnId: 'delivery-1',
        dispatchAttempt: 1,
        status: 'failed',
        errorCode: 'provider_server_error',
        retryable: true,
      }]);
    });

    it('still emits a local turn\'s COMPLETED terminal (bookkeeping, invisible to the user)', () => {
      // The gate is scoped to the failure arm only: a completed local terminal
      // settles the dedupe claim / durable release / CoT finalize and shows the
      // user nothing, so suppressing it too would be a silent behaviour change.
      const h = new ContractHarness();
      h.ingest([
        user('local-u', 'typed in the pane'),
        assistant('local-a', 'done', 'end_turn'),
      ]);
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].status).toBe('completed');
      expect(h.emitted[0].turnId.startsWith('local-')).toBe(true);
    });

    it('worker.ts gates the terminal on isLocal, not only the fallback', () => {
      const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
      // The guard must live in the TERMINAL loop. Anchored on the log line so a
      // refactor that drops the gate fails here rather than silently reopening
      // the card path.
      expect(source).toContain('Bridge terminal suppressed for synthesised local turn');
      expect(source).toMatch(
        /if \(turn\.isLocal && outcome && outcome\.status !== 'completed'\) \{/,
      );
      // ORDER, not merely presence. Keeping every byte of the gate but moving
      // it one call later — below emitTurnTerminal — resurrects the phantom
      // card exactly (the failure terminal ships, then the gate logs and
      // `continue`s into nothing), and every string assertion above stays
      // green. Both indices are pinned > -1 first: toBeLessThan(-1, n) passes
      // silently, so a slice that missed the function would fake a pass.
      const fn = source.slice(
        source.indexOf('function emitReadyTurns('),
        source.indexOf('function drainPathInto('),
      );
      const gateAt = fn.indexOf('Bridge terminal suppressed for synthesised local turn');
      const emitAt = fn.indexOf('emitTurnTerminal(');
      expect(gateAt).toBeGreaterThan(-1);
      expect(emitAt).toBeGreaterThan(-1);
      expect(gateAt).toBeLessThan(emitAt);
    });
  });
});
