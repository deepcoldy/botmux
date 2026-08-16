import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { CODEX_CONNECTION_ERROR_CODE, CODEX_RATE_LIMIT_ERROR_CODE } from '../src/services/codex-transcript.js';
import {
  isBridgeNothingToSendFinal,
  shouldEmitEmptyCompletedBridgeFallback,
} from '../src/services/bridge-fallback-gate.js';
import {
  drainTraexRollout,
  readLatestTraexRuntime,
  traexRolloutHasUserInputSince,
  traexHistoryMatchDelta,
  traexHistorySize,
  traexHistorySidIsOwned,
} from '../src/services/traex-transcript.js';

const SID = '00000000-0000-7000-8000-000000000001';
let dir: string;
let path: string;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function user(text: string, timestamp = '2000-01-01T00:00:01.000Z') {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: text,
      images: [],
      local_images: [],
      text_elements: [],
    },
  };
}

function userResponseItem(text: string, timestamp = '2000-01-01T00:00:01.000Z') {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantProgress(text: string) {
  return {
    timestamp: '2000-01-01T00:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      // TRAE rollout shape: no phase. These records are emitted during
      // tool use and therefore must never close a turn.
      content: [{ type: 'output_text', text }],
    },
  };
}

function taskComplete(lastAgentMessage?: string) {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '00000000-0000-7000-8000-000000000010',
      ...(lastAgentMessage === undefined ? {} : { last_agent_message: lastAgentMessage }),
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

function agentMessage(text: string, phase: 'commentary' | 'final_answer' = 'commentary') {
  return {
    timestamp: '2000-01-01T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: text,
      phase,
      memory_citation: null,
    },
  };
}

function taskCompleteWithError(error: unknown, lastAgentMessage?: string) {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '00000000-0000-7000-8000-000000000010',
      ...(lastAgentMessage === undefined ? {} : { last_agent_message: lastAgentMessage }),
      error,
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

function turnAborted(reason: unknown = 'interrupted') {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'turn_aborted',
      turn_id: '00000000-0000-7000-8000-000000000010',
      reason,
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-transcript-'));
  path = join(dir, `rollout-2000-01-01T00-00-00-${SID}.jsonl`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('drainTraexRollout', () => {
  it('reports the latest complete turn_context model and reasoning effort', () => {
    writeFileSync(path, [
      line({
        type: 'turn_context',
        payload: {
          model: 'GPT-5.5',
          collaboration_mode: { settings: { reasoning_effort: 'high' } },
        },
      }),
      line(user('switch model')),
      line({
        type: 'turn_context',
        payload: {
          model: 'GPT-5.6-Sol',
          collaboration_mode: { settings: { reasoning_effort: 'xhigh' } },
        },
      }),
      line(taskComplete('done')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.latestModel).toBe('GPT-5.6-Sol');
    expect(result.latestReasoningEffort).toBe('xhigh');
    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'GPT-5.6-Sol',
      reasoningEffort: 'xhigh',
    });
  });

  it('ignores a partial trailing model record until it is complete', () => {
    writeFileSync(path, line({ type: 'turn_context', payload: { model: 'stable-model' } }));
    appendFileSync(path, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'partial-model' },
    }).slice(0, -4));

    expect(drainTraexRollout(path, 0).latestModel).toBe('stable-model');
    expect(readLatestTraexRuntime(path)).toEqual({ model: 'stable-model' });
  });

  it('readLatestTraexRuntime resolves model and effort from independent latest records (backward scan)', () => {
    // /model then /effort switched in separate turns — each field is
    // latest-wins independently, so the newest of EACH must win even though
    // they live on different lines.
    writeFileSync(path, [
      line({ type: 'turn_context', payload: { model: 'old-model', reasoning_effort: 'low' } }),
      line(user('/model new')),
      line({ type: 'turn_context', payload: { model: 'new-model' } }),
      line(user('/effort high')),
      line({ type: 'turn_context', payload: { reasoning_effort: 'high' } }),
      line(taskComplete('done')),
    ].join(''));

    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'new-model',
      reasoningEffort: 'high',
    });
  });

  it('readLatestTraexRuntime finds the runtime when the only record is the first line (offset 0)', () => {
    writeFileSync(path, line({ type: 'turn_context', payload: { model: 'solo-model' } }));
    expect(readLatestTraexRuntime(path)).toEqual({ model: 'solo-model' });
  });

  it('readLatestTraexRuntime scans back across a large transcript to the newest tail record', () => {
    const filler = Array.from({ length: 2000 }, (_, i) =>
      line(assistantProgress(`tool commentary chunk ${i} ${'x'.repeat(200)}`)),
    ).join('');
    writeFileSync(path, [
      line({ type: 'turn_context', payload: { model: 'stale', reasoning_effort: 'low' } }),
      filler,
      line({ type: 'turn_context', payload: { model: 'fresh-tail', reasoning_effort: 'xhigh' } }),
      line(taskComplete('done')),
    ].join(''));

    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'fresh-tail',
      reasoningEffort: 'xhigh',
    });
  });

  it('uses task_complete as the terminal and ignores phase-less assistant progress', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(assistantProgress('intermediate tool commentary')),
      line(assistantProgress('final-looking but still not a boundary')),
      line(taskComplete('durable final answer')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'do the work',
        sourceSessionId: SID,
      }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'durable final answer',
        sourceSessionId: SID,
      }),
    ]);
  });

  it('ignores internal role=user injections without a user_message event', () => {
    writeFileSync(path, [
      line(userResponseItem('<environment_context>runtime context</environment_context>')),
      line(userResponseItem('Warning: runtime-generated process limit notice')),
      line(userResponseItem('real terminal input')),
      line(user('real terminal input')),
      line(taskComplete('done')),
    ].join(''));

    expect(drainTraexRollout(path, 0).events).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'real terminal input',
      }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'done',
      }),
    ]);
  });

  it('emits an empty task_complete so a silent durable turn can settle', () => {
    writeFileSync(path, line(user('finish silently')) + line(taskComplete()));
    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('maps a turn_aborted shape to ambiguous with a bounded safe error code', () => {
    writeFileSync(path, line(user('cancel me')) + line(turnAborted('Interrupted by user / unsafe')));
    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'ambiguous',
      terminalErrorCode: 'traex_turn_aborted:interrupted_by_user_unsafe',
    }));

    const queue = new CodexBridgeQueue();
    queue.mark('cancelled-delivery', 'cancel me', Date.parse('2000-01-01T00:00:00.000Z'), 6);
    queue.ingest(result.events);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'cancelled-delivery',
        dispatchAttempt: 6,
        terminalStatus: 'ambiguous',
        terminalErrorCode: 'traex_turn_aborted:interrupted_by_user_unsafe',
      }),
    ]);
  });

  it('does not advance over or emit a crash-partial terminal tail', () => {
    const first = line(user('partial-tail test'));
    const terminal = JSON.stringify(taskComplete('done'));
    writeFileSync(path, first + terminal.slice(0, -8));

    const beforeComplete = drainTraexRollout(path, 0);
    expect(beforeComplete.events.map(event => event.kind)).toEqual(['user']);
    expect(beforeComplete.newOffset).toBe(Buffer.byteLength(first));
    expect(beforeComplete.pendingTail.length).toBeGreaterThan(0);

    appendFileSync(path, terminal.slice(-8) + '\n');
    const afterComplete = drainTraexRollout(path, beforeComplete.newOffset);
    expect(afterComplete.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'done' }),
    ]);
  });

  it('preserves TRAE steer attribution: the last typed-ahead turn gets the single completion', () => {
    writeFileSync(path, [
      line(user('first durable prompt', '2000-01-01T00:00:01.000Z')),
      line(user('second steered prompt', '2000-01-01T00:00:02.000Z')),
      line(taskComplete('one merged answer')),
    ].join(''));
    const queue = new CodexBridgeQueue();
    queue.mark('delivery-1', 'first durable prompt', Date.parse('2000-01-01T00:00:00.000Z'), 3);
    queue.mark('delivery-2', 'second steered prompt', Date.parse('2000-01-01T00:00:00.001Z'), 4);
    queue.ingest(drainTraexRollout(path, 0).events);

    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'delivery-2',
        dispatchAttempt: 4,
        finalText: 'one merged answer',
      }),
    ]);
  });

  it('maps a task_complete error payload to a failed terminal (path A: endpoint failure)', () => {
    // Real shape from rollout-…01a0098a….jsonl: traecli writes task_complete
    // with last_agent_message=null AND error when the model endpoint fails.
    writeFileSync(path, [
      line(user('call the model')),
      line(taskCompleteWithError({
        message: 'model endpoint connection failed before receiving an HTTP response: error sending request for url (https://copilot.byteintl.net/api/ide/v2/llm_raw_chat)',
        codex_error_info: { http_connection_failed: { http_status_code: null } },
      })),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_CONNECTION_ERROR_CODE,
    });
    expect(result.events.at(-1)!.terminalErrorSummary).toContain('model endpoint connection failed');
    // The provider URL must not survive into the user-facing summary.
    expect(result.events.at(-1)!.terminalErrorSummary).not.toContain('copilot.byteintl.net');
  });

  it('classifies as failed even when last_agent_message is present alongside the error', () => {
    writeFileSync(path, line(user('partial turn'))
      + line(taskCompleteWithError({ message: 'connection reset by peer' }, 'partial answer')));

    expect(drainTraexRollout(path, 0).events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: 'partial answer',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_CONNECTION_ERROR_CODE,
    });
  });

  it('synthesises the bare sentinel when the last commentary ends with BOTMUX_NO_REPLY (path B: deliberate silence)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('进度：CI 已绿', 'commentary')),
      line(agentMessage('我已完成状态回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NO_REPLY',
    }));
  });

  it('recognises the current BOTMUX_NOTHING_TO_SEND sentinel as deliberate silence', () => {
    writeFileSync(path, [
      line(user('ambient chatter')),
      line(agentMessage('BOTMUX_NOTHING_TO_SEND', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NOTHING_TO_SEND',
    }));
  });

  it('retains agent_message state across drain calls (commentary drained before task_complete)', () => {
    // Turns run for minutes while the poller drains on the second scale: the
    // commentary batch and the task_complete almost never share a drain call.
    const firstBatch = line(user('long-running turn'))
      + line(agentMessage('工作中', 'commentary'))
      + line(agentMessage('已通过 botmux send 回报。BOTMUX_NO_REPLY', 'commentary'));
    writeFileSync(path, firstBatch);
    const first = drainTraexRollout(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    appendFileSync(path, line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'BOTMUX_NO_REPLY' }),
    ]);
  });

  it('does not treat a commentary without a trailing sentinel as silence', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('随便聊聊，没有结论', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('reconstructs the final from the last final_answer-phase agent_message (defensive: TRAE dropped the final)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('思考中', 'commentary')),
      line(agentMessage('这是最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('prefers a final_answer reconstruction over a commentary sentinel', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(agentMessage('真正的最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '真正的最终答案',
    }));
  });

  it('resets pending agent state at each user_message so a prior turn cannot leak', () => {
    writeFileSync(path, [
      line(user('first turn')),
      line(agentMessage('第一轮已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
      line(user('second turn')),
      line(taskComplete()),
    ].join(''));

    const finals = drainTraexRollout(path, 0).events.filter(event => event.kind === 'assistant_final');
    expect(finals[0]).toEqual(expect.objectContaining({ text: 'BOTMUX_NO_REPLY' }));
    expect(finals[1]).toEqual(expect.objectContaining({ text: '' }));
  });

  it('synthesised sentinel final is genuine silence: the empty-completed alert stays suppressed', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
    ].join(''));

    const queue = new CodexBridgeQueue();
    queue.mark('delivery-1', 'do the work', Date.parse('2000-01-01T00:00:00.000Z'), 1);
    queue.ingest(drainTraexRollout(path, 0).events);
    const turn = queue.drainEmittable()[0];
    expect(turn.finalText).toBe('BOTMUX_NO_REPLY');
    expect(isBridgeNothingToSendFinal(turn.finalText)).toBe(true);
    expect(shouldEmitEmptyCompletedBridgeFallback(
      {
        markTimeMs: turn.markTimeMs,
        isLocal: false,
        finalText: turn.finalText,
        terminalStatus: turn.terminalStatus,
      },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('does not synthesise a bare sentinel in adopt mode (verbatim contract)', () => {
    // adopt posts transcript text verbatim, so a synthesised token would leak
    // the literal sentinel into Lark. Keep the empty final; no alert fires in
    // adopt either (shouldEmitEmptyCompletedBridgeFallback is adopt-gated).
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
    // Non-adopt still synthesises (existing behaviour).
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NO_REPLY',
    }));
  });

  it('reconstructs a final_answer-phase message in adopt mode (real answer, not synthesis)', () => {
    // final_answer reconstruction is safe in BOTH modes: it is the model's
    // real transcript answer (phase-guaranteed, not tool narration), and adopt
    // posts transcript text verbatim anyway. Only the bare-sentinel synthesis
    // is adopt-gated. adopt is in fact the mode where reconstruction matters
    // most — drain is the only channel to Lark there.
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('思考中', 'commentary')),
      line(agentMessage('这是最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
    // Non-adopt reconstructs identically.
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('a probe re-drain mid-turn does not clear the production pending state', () => {
    // traexRolloutHasUserInputSince re-drains the same live rollout; its
    // user_message processing must not delete the commentary the production
    // drainer is holding for the still-open turn.
    const firstBatch = line(user('long turn'))
      + line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary'));
    writeFileSync(path, firstBatch);
    const first = drainTraexRollout(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    // Submit-confirmation probe re-drains the same rollout.
    expect(traexRolloutHasUserInputSince(path, 0, 'long turn')).toBe(true);

    // Turn completes; the production drain must still see the cached commentary.
    appendFileSync(path, line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'BOTMUX_NO_REPLY' }),
    ]);
  });

  it('maps a 429 task_complete error to the rate-limit failure code', () => {
    writeFileSync(path, [
      line(user('hit the limit')),
      line(taskCompleteWithError({ message: '429 Too Many Requests' })),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_RATE_LIMIT_ERROR_CODE,
    });
  });
});

describe('traexRolloutHasUserInputSince', () => {
  it('matches only a complete exact user record appended after the baseline', () => {
    const old = line(user('same thread, old prompt'));
    writeFileSync(path, old);
    const baseline = Buffer.byteLength(old);
    appendFileSync(path, line(user('same thread, later prompt')));

    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread, later prompt')).toBe(true);
    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread, old prompt')).toBe(false);
    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread')).toBe(false);
  });
});

describe('traexHistoryMatchDelta (submit-time history.jsonl verification)', () => {
  let histPath: string;

  function histLine(sessionId: string, text: string): string {
    return `${JSON.stringify({ session_id: sessionId, ts: 1785900000, text })}\n`;
  }

  beforeEach(() => {
    histPath = join(dir, 'history.jsonl');
  });

  it('confirms a submit appended after baseByte and returns its session_id', () => {
    const base = histLine('aaaa1111-0000-7000-8000-000000000001', 'earlier turn');
    writeFileSync(histPath, base);
    const baseByte = Buffer.byteLength(base);
    // The follow-up botmux would paste while a turn is running: parked by TRAE
    // but written to history.jsonl immediately at submit time.
    appendFileSync(histPath, histLine('bbbb2222-0000-7000-8000-000000000002', '<session_id>x</session_id>\n\n<user_message>\nfollow-up while busy\n</user_message>'));

    const match = traexHistoryMatchDelta(histPath, baseByte, '<session_id>x</session_id>\n\n<user_message>\nfollow-up while busy\n</user_message>');
    expect(match.found).toBe(true);
    expect(match.cliSessionId).toBe('bbbb2222-0000-7000-8000-000000000002');
  });

  it('never matches a line at or before baseByte (only the new submit)', () => {
    const base = histLine('aaaa1111-0000-7000-8000-000000000001', 'earlier turn');
    writeFileSync(histPath, base);
    const baseByte = Buffer.byteLength(base);
    expect(traexHistoryMatchDelta(histPath, baseByte, 'earlier turn').found).toBe(false);
  });

  it('returns not-found when the file is absent (lazy-created on first submit)', () => {
    expect(traexHistoryMatchDelta(join(dir, 'nope.jsonl'), 0, 'anything').found).toBe(false);
  });

  it('normalises CRLF/CR so a paste round-tripped through TRAE still matches', () => {
    writeFileSync(histPath, '');
    appendFileSync(histPath, histLine('cccc3333-0000-7000-8000-000000000003', 'line one\nline two'));
    // Expected text arrives with CRLF from the caller; the stored text is LF.
    const match = traexHistoryMatchDelta(histPath, 0, 'line one\r\nline two');
    expect(match.found).toBe(true);
    expect(match.cliSessionId).toBe('cccc3333-0000-7000-8000-000000000003');
  });

  it('ignores a trailing partial (non-newline-terminated) line until it completes', () => {
    writeFileSync(histPath, '');
    // Half-written line — no trailing newline. Must NOT match yet.
    const partial = JSON.stringify({ session_id: 'dddd4444-0000-7000-8000-000000000004', ts: 1785900001, text: 'mid write' });
    writeFileSync(histPath, partial);
    expect(traexHistoryMatchDelta(histPath, 0, 'mid write').found).toBe(false);
    // Completed with a newline on a later poll — now it matches.
    writeFileSync(histPath, partial + '\n');
    expect(traexHistoryMatchDelta(histPath, 0, 'mid write').found).toBe(true);
  });

  it('with an ownership filter, skips a sibling pane\'s identical text and accepts only the owned session', () => {
    writeFileSync(histPath, '');
    const foreignSid = 'ffff0000-0000-7000-8000-00000000000f';
    const ownedSid = '11110000-0000-7000-8000-000000000011';
    // Same exact text submitted by two panes sharing one TRAE_HOME; the
    // sibling's line lands first.
    appendFileSync(histPath, histLine(foreignSid, 'duplicate text'));
    appendFileSync(histPath, histLine(ownedSid, 'duplicate text'));

    const acceptOwned = (sid: string | undefined) => sid?.toLowerCase() === ownedSid.toLowerCase();
    const match = traexHistoryMatchDelta(histPath, 0, 'duplicate text', acceptOwned);
    expect(match.found).toBe(true);
    expect(match.cliSessionId).toBe(ownedSid);

    // If the ONLY line is a foreign pane's, the owned filter rejects it.
    writeFileSync(histPath, histLine(foreignSid, 'only foreign'));
    expect(traexHistoryMatchDelta(histPath, 0, 'only foreign', acceptOwned).found).toBe(false);
  });

  it('traexHistorySize returns 0 for an absent file and the byte size otherwise', () => {
    expect(traexHistorySize(join(dir, 'absent.jsonl'))).toBe(0);
    const body = histLine('eeee5555-0000-7000-8000-000000000055', 'sized');
    writeFileSync(histPath, body);
    expect(traexHistorySize(histPath)).toBe(Buffer.byteLength(body));
  });
});

describe('traexHistorySidIsOwned (ownership gate predicate)', () => {
  const OWNED = 'aaaa1111-0000-7000-8000-000000000001';
  const FOREIGN = 'ffff0000-0000-7000-8000-00000000000f';

  it('accepts an id present in the owned set (case-insensitive)', () => {
    const owned = new Set([OWNED.toLowerCase()]);
    expect(traexHistorySidIsOwned(OWNED, owned)).toBe(true);
    expect(traexHistorySidIsOwned(OWNED.toUpperCase(), owned)).toBe(true);
  });

  it('rejects an id NOT in the owned set (foreign sibling pane)', () => {
    const owned = new Set([OWNED.toLowerCase()]);
    expect(traexHistorySidIsOwned(FOREIGN, owned)).toBe(false);
  });

  it('fails closed when the set is undefined (fd enumeration unavailable)', () => {
    expect(traexHistorySidIsOwned(OWNED, undefined)).toBe(false);
  });

  it('fails closed on an empty set (pid holds no TRAE rollout)', () => {
    expect(traexHistorySidIsOwned(OWNED, new Set())).toBe(false);
  });
});
