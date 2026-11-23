import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue, CodexMidTurnReplyCollector, STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { shouldSuppressStructuredFallback, structuredFallbackKind, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import { CODEX_AUTH_ERROR_CODE, CODEX_CONNECTION_ERROR_CODE, CODEX_INVALID_REQUEST_ERROR_CODE, CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE, CODEX_RATE_LIMIT_ERROR_CODE, CODEX_TASK_FAILED_ERROR_CODE, CODEX_UPSTREAM_ERROR_CODE, codexTaskFailureCode, drainCodexRollout, codexSessionIdFromRolloutPath, findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId, codexHistorySidIsOwned, isCodexRateLimitEvent, isExactCodexOutputLimitError, splitCodexEventsByCutoff, extractLastCodexTurn, scanCodexThreadSettings, readLatestCodexRuntime, codexCotEntriesFromResponseItem, type CodexBridgeEvent } from '../src/services/codex-transcript.js';

import { codexEventsWithStableIds } from '../src/services/codex-rollout-replay.js';

let dir: string;
let path: string;

function ev(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

/** Reader output without the bare tool-call boundaries (`toolCallBoundary`):
 *  the thinking timeline and turn records the exec-wrapper tests pin. */
function drainTimeline(...args: Parameters<typeof drainCodexRollout>): ReturnType<typeof drainCodexRollout> {
  const r = drainCodexRollout(...args);
  return { ...r, events: r.events.filter(e => e.toolCallBoundary !== true) };
}

function userResponseItem(text: string, ts = '2026-04-29T07:00:00.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantFinalResponseItem(text: string, ts = '2026-04-29T07:00:01.000Z') {
  // The turn terminal is now event_msg/task_complete, NOT the assistant
  // response_item. Codex >=0.146 dropped phase:'final_answer', so this helper
  // emits the task_complete record that actually closes the turn. `text`
  // becomes last_agent_message. Kept named "assistantFinal…" so existing
  // call sites read naturally.
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: `turn-${ts}`,
      last_agent_message: text,
    },
  };
}

/** An assistant `response_item` message — mid-turn OR final, both phase-less in
 *  codex >=0.146. The reader must NOT treat any of these as a turn boundary. */
function assistantMessageResponseItem(text: string, phase?: string, ts = '2026-04-29T07:00:01.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      ...(phase !== undefined ? { phase } : {}),
      content: [{ type: 'output_text', text }],
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-transcript-'));
  path = join(dir, 'rollout.jsonl');
});

describe('post-delivery provider failure notification', () => {
  it.each([false, true])('keeps the delivered final after an empty 527 terminal (incremental=%s)', incremental => {
    const start = Date.parse('2026-04-29T07:00:00.000Z');
    const queue = new CodexBridgeQueue(() => start);
    queue.mark('lark-delivered-turn', 'Run the probe', start);
    writeFileSync(path, ev(userResponseItem('Run the probe')));
    const first = incremental ? drainCodexRollout(path, 0) : undefined;
    if (first) queue.ingest(first.events);
    const delivered: BridgeSendMarker = {
      sentAtMs: start + 1_000, messageId: 'om_success', responseKind: 'final',
      turnId: 'lark-delivered-turn', terminalCarrier: 'standard_reply_card',
    };
    appendFileSync(path, ev({
      timestamp: '2026-04-29T07:02:44.000Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'native-provider-turn', last_agent_message: null,
        error: { message: 'unexpected status 527: empty provider response',
          codex_error_info: { http_connection_failed: { http_status_code: 527 } } } },
    }));
    queue.ingest(drainCodexRollout(path, first?.newOffset ?? 0, first?.state).events);
    const [ready] = queue.drainEmittable();
    expect(ready).toMatchObject({ turnId: 'lark-delivered-turn', finalText: '',
      terminalStatus: 'failed', terminalErrorCode: CODEX_CONNECTION_ERROR_CODE });
    const gate = { ...ready, markTimeMs: ready.markTimeMs, isLocal: ready.isLocal };
    const kind = structuredFallbackKind(gate, undefined, [delivered], false, true);
    // Default (experimental opt-in absent): the legacy failure notice is unchanged.
    expect(shouldSuppressStructuredFallback(kind, gate, undefined, [delivered], false)).toBe(false);
    expect(shouldSuppressStructuredFallback(kind, gate, undefined, [delivered], false, 'send', true)).toBe(true);
    // Progress is not a final: the same real provider failure still reaches the user.
    expect(shouldSuppressStructuredFallback(kind, gate, undefined,
      [{ ...delivered, responseKind: 'progress' }], false, 'send', true)).toBe(false);
    expect(ready.terminalStatus).toBe('failed');
  });
});

describe('Codex environment updates in adopted turns', () => {
  const nativeTurnId = 'native-active-turn';
  const environment = '<environment_context>\n  <current_date>2026-10-06</current_date>\n  <timezone>Asia/Singapore</timezone>\n</environment_context>';
  const metadata = (kinds: readonly string[]) => ({
    turn_id: nativeTurnId,
    content_item_kinds: kinds,
  });

  it.each([
    ['structured', metadata(['environments.environment_context'])],
    ['legacy', undefined],
  ])('keeps the original thinking timeline and final reply for a %s environment update', (_name, contextMetadata) => {
    const now = Date.parse('2026-04-29T07:00:00.000Z');
    const q = new CodexBridgeQueue(() => now);
    const retired: string[] = [];
    const thinkingTurns: string[] = [];
    q.setLocalTurns(true, now);
    q.mark('lark-turn', 'Keep working', now);
    q.setCotSupersededObserver(turn => retired.push(turn.turnId));
    q.setCotObserver((_entries, turn) => thinkingTurns.push(turn.turnId));
    const prompt = userResponseItem('Keep working');
    const context = userResponseItem(environment, '2026-04-29T07:00:02.000Z');
    writeFileSync(path, [
      { timestamp: '2026-04-29T07:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: nativeTurnId } },
      { ...prompt, payload: { ...prompt.payload, internal_chat_message_metadata_passthrough: metadata(['user.text']) } },
    ].map(ev).join(''));
    const initial = drainCodexRollout(path, 0);
    q.ingest(initial.events);
    appendFileSync(path, [
      { ...context, payload: { ...context.payload, ...(contextMetadata ? { internal_chat_message_metadata_passthrough: contextMetadata } : {}) } },
      { timestamp: '2026-04-29T07:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'read_file', call_id: 'read-1', arguments: '{}' } },
    ].map(ev).join(''));
    const update = drainCodexRollout(path, initial.newOffset, initial.state);
    q.ingest(update.events);
    expect(retired).toEqual([]);
    expect(thinkingTurns).toEqual(['lark-turn']);
    expect(q.peek()).toMatchObject([{ turnId: 'lark-turn', sourceTurnId: nativeTurnId }]);
    expect(q.hasBlockingTurn()).toBe(true);
    expect(q.drainEmittable()).toEqual([]);

    appendFileSync(path, ev({ timestamp: '2026-04-29T07:00:04.000Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: nativeTurnId, last_agent_message: 'Finished' } }));
    q.ingest(drainCodexRollout(path, update.newOffset, update.state).events);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'lark-turn', finalText: 'Finished' }]);
    expect(q.hasBlockingTurn()).toBe(false);
  });

  it.each([
    ['typed environment example', environment, metadata(['user.text'])],
    ['mixed user and environment content', environment, metadata(['environments.environment_context', 'user.text'])],
    ['mixed user and AGENTS.md content', environment, metadata(['agents_md.instructions', 'user.text'])],
    ['unknown content kind', environment, metadata(['future.content'])],
    ['empty content kinds', environment, metadata([])],
    ['malformed content kinds', environment, { content_item_kinds: 'environments.environment_context' }],
    ['legacy local input', 'Keep working on the next part', undefined],
    ['legacy incomplete wrapper', '<environment_context>', undefined],
    ['legacy quoted block with a request', `${environment}\nExplain this configuration`, undefined],
    ['legacy request between blocks', `${environment}\nExplain this\n${environment}`, undefined],
  ])('preserves real input and steer behavior for %s', (_name, text, contextMetadata) => {
    const now = Date.parse('2026-04-29T07:00:00.000Z');
    const q = new CodexBridgeQueue(() => now);
    const retired: string[] = [];
    q.setLocalTurns(true, now);
    q.mark('lark-turn', 'Keep working', now);
    q.setCotSupersededObserver(turn => retired.push(turn.turnId));
    const successor = userResponseItem(text, '2026-04-29T07:00:02.000Z');
    writeFileSync(path, [userResponseItem('Keep working'),
      { ...successor, payload: { ...successor.payload, ...(contextMetadata ? { internal_chat_message_metadata_passthrough: contextMetadata } : {}) } },
    ].map(ev).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(retired).toEqual(['lark-turn']);
    expect(q.peek()).toMatchObject([{ isLocal: true, userText: text }]);
  });

  it('attributes a real same-native-turn Lark steer after an environment update', () => {
    const now = Date.parse('2026-04-29T07:00:00.000Z');
    const q = new CodexBridgeQueue(() => now);
    const retired: string[] = [];
    q.setLocalTurns(true, now);
    q.mark('first', 'First request', now);
    q.mark('second', 'Additional request', now);
    q.setCotSupersededObserver(turn => retired.push(turn.turnId));
    const rows = [
      ['First request', ['user.text']],
      [environment, ['environments.environment_context']],
      ['Additional request', ['user.text']],
    ] as const;
    writeFileSync(path, rows.map(([text, kinds]) => {
      const item = userResponseItem(text);
      return ev({ ...item, payload: { ...item.payload, internal_chat_message_metadata_passthrough: metadata(kinds) } });
    }).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(retired).toEqual(['first']);
    expect(q.peek()).toMatchObject([{ turnId: 'second' }]);
    expect(q.peek()[0].isLocal).not.toBe(true);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Codex mid-turn replies: progress, and the answer to a same-turn steer', () => {
  const native = 'native-turn-steer';
  const at = (sec: number) => `2026-04-29T07:00:${String(sec).padStart(2, '0')}.000Z`;
  const toolCall = (id: string, sec: number) =>
    ({ timestamp: at(sec), type: 'response_item', payload: { type: 'custom_tool_call', name: 'js', call_id: id, input: 'run()' } });
  const toolOutput = (id: string, sec: number) =>
    ({ timestamp: at(sec), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: 'ok' } });
  /** A wrapped shell call: its timeline entry is deferred to the command's
   *  completion or the turn's end. */
  const execCall = (id: string, sec: number) => ({ timestamp: at(sec), type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: id, input: 'await tools.exec_command({ cmd: "npm test" })' } });
  const withKinds = (row: ReturnType<typeof userResponseItem>, kinds: readonly string[]) =>
    ({ ...row, payload: { ...row.payload, internal_chat_message_metadata_passthrough: { turn_id: native, content_item_kinds: kinds } } });

  /** A queue wired like the worker: one collector per turn, local turns skipped. */
  function observed(q: CodexBridgeQueue) {
    const collectors = new WeakMap<CodexPendingTurn, CodexMidTurnReplyCollector>();
    const replies: Array<[string, string, 'steer answer' | 'progress']> = [];
    q.setMidTurnReplyObserver((event, turn) => {
      if (turn.isLocal) return;
      let c = collectors.get(turn);
      if (!c) collectors.set(turn, c = new CodexMidTurnReplyCollector(turn));
      const reply = c.feed(event);
      if (reply) replies.push([turn.turnId, reply.text, reply.answersSteer ? 'steer answer' : 'progress']);
    });
    return replies;
  }

  /** Rollout of one execution with a second Lark message steered into it. */
  function run(afterSteer: object[], withStableIds = false) {
    const now = Date.parse(at(0));
    const q = new CodexBridgeQueue(() => now);
    q.mark('om_task', 'Keep working', now);
    q.mark('om_followup', '下载弄完了吗？可以关窗口了吗', now);
    const replies = observed(q);
    const ingest = (events: CodexBridgeEvent[]) =>
      q.ingest(withStableIds ? codexEventsWithStableIds(path, events) : events);
    writeFileSync(path, [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: native } },
      userResponseItem('Keep working', at(1)),
      assistantMessageResponseItem('Working on it.', 'commentary', at(2)),
      toolCall('c1', 3), toolOutput('c1', 4),
    ].map(ev).join(''));
    const first = drainCodexRollout(path, 0);
    ingest(first.events);
    appendFileSync(path, [userResponseItem('下载弄完了吗？可以关窗口了吗', at(5)), ...afterSteer].map(ev).join(''));
    ingest(drainCodexRollout(path, first.newOffset, first.state).events);
    return { q, replies };
  }
  const beforeSteer = ['om_task', 'Working on it.', 'progress'];

  it('answers the steer once the model goes back to work, then posts its progress, and the turn still ends with its final', () => {
    const { q, replies } = run([
      assistantMessageResponseItem('可以关闭下载窗口，下载已经完成。', 'commentary', at(6)),
      toolCall('c2', 7), toolOutput('c2', 8),
      assistantMessageResponseItem('Next step done.', 'commentary', at(9)),
      toolCall('c3', 10), toolOutput('c3', 11),
      assistantMessageResponseItem('All done.', 'final_answer', at(12)),
      { timestamp: at(13), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'All done.' } },
    ]);
    expect(replies).toEqual([
      beforeSteer,
      ['om_followup', '可以关闭下载窗口，下载已经完成。', 'steer answer'],
      ['om_followup', 'Next step done.', 'progress'],
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(t => [t.turnId, t.finalText])).toEqual([['om_followup', 'All done.']]);
  });

  it('answers at a wrapped shell call, without the final message', () => {
    const { replies } = run([
      assistantMessageResponseItem('下载已完成，可以关窗口。', 'commentary', at(6)),
      execCall('c2', 7), toolOutput('c2', 8),
      assistantMessageResponseItem('All tests pass. Done.', 'final_answer', at(9)),
      { timestamp: at(10), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'All tests pass. Done.' } },
    ]);
    expect(replies).toEqual([beforeSteer, ['om_followup', '下载已完成，可以关窗口。', 'steer answer']]);
  });

  it.each([
    ['raw offset events', false],
    ['production stable-id events', true],
  ])('is not completed by a shell call recorded before the answer and surfaced at the turn\'s end (%s)', (_label, withStableIds) => {
    if (withStableIds) {
      path = join(dir, 'rollout-2026-04-29T07-00-00-019dd80d-d922-7a11-8339-0208d8c5b4ec.jsonl');
    }
    const { replies } = run([
      execCall('c2', 6), toolOutput('c2', 7),
      assistantMessageResponseItem('Yes, it finished.', 'commentary', at(8)),
      assistantMessageResponseItem('All done.', 'final_answer', at(9)),
      { timestamp: at(10), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'All done.' } },
    ], withStableIds);
    expect(replies).toEqual([beforeSteer]);
  });

  it('leaves an answer that is the final message to the turn\'s own reply', () => {
    const { replies } = run([
      toolCall('c2', 6), toolOutput('c2', 7),
      assistantMessageResponseItem('Yes, it finished; all done.', 'final_answer', at(8)),
      { timestamp: at(9), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'Yes, it finished; all done.' } },
    ]);
    expect(replies).toEqual([beforeSteer]);
  });

  it('posts each thing an ordinary turn says mid-work as progress, never as a steer answer', () => {
    const now = Date.parse(at(0));
    const q = new CodexBridgeQueue(() => now);
    q.mark('om_task', 'Keep working', now);
    const replies = observed(q);
    writeFileSync(path, [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: native } },
      userResponseItem('Keep working', at(1)),
      assistantMessageResponseItem('Working on it.', 'commentary', at(2)),
      toolCall('c1', 3), toolOutput('c1', 4),
      assistantMessageResponseItem('Installed; verifying.', 'commentary', at(5)),
      toolCall('c2', 6), toolOutput('c2', 7),
      assistantMessageResponseItem('Done.', 'final_answer', at(8)),
      { timestamp: at(9), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'Done.' } },
    ].map(ev).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(replies).toEqual([
      ['om_task', 'Working on it.', 'progress'],
      ['om_task', 'Installed; verifying.', 'progress'],
    ]);
    expect(q.drainEmittable().map(t => [t.turnId, t.finalText])).toEqual([['om_task', 'Done.']]);
  });

  // A command's completion record carries a tool_call entry for the thinking
  // timeline, but it is written when the command finished.
  it('does not take a command completion written after the final message for the model going back to work', () => {
    const now = Date.parse(at(0));
    const q = new CodexBridgeQueue(() => now);
    q.mark('om_task', 'Keep working', now);
    const replies = observed(q);
    const completion = (id: string, sec: number) => ({ timestamp: at(sec), type: 'event_msg', payload: {
      type: 'item_completed', turn_id: native,
      item: { type: 'CommandExecution', id, command: ['npm', 'test'], aggregated_output: 'ok' } } });
    writeFileSync(path, [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: native } },
      userResponseItem('Keep working', at(1)),
      assistantMessageResponseItem('Running the tests.', 'commentary', at(2)),
      execCall('c1', 3),
      assistantMessageResponseItem('Final answer.', 'final_answer', at(4)),
      completion('c1', 5),
      { timestamp: at(6), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'Final answer.' } },
    ].map(ev).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(replies).toEqual([['om_task', 'Running the tests.', 'progress']]);
    expect(q.drainEmittable().map(t => [t.turnId, t.finalText])).toEqual([['om_task', 'Final answer.']]);
  });

  it('does not take an unmatched terminal exec fallback after the final message for new progress', () => {
    const now = Date.parse(at(0));
    const q = new CodexBridgeQueue(() => now);
    q.mark('om_task', 'Keep working', now);
    const replies = observed(q);
    writeFileSync(path, [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: native } },
      userResponseItem('Keep working', at(1)),
      execCall('unmatched-after-final', 2),
      assistantMessageResponseItem('Final answer.', 'final_answer', at(3)),
      toolOutput('unmatched-after-final', 4),
      { timestamp: at(5), type: 'event_msg', payload: { type: 'task_complete', turn_id: native, last_agent_message: 'Final answer.' } },
    ].map(ev).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(replies).toEqual([]);
    expect(q.drainEmittable().map(t => [t.turnId, t.finalText])).toEqual([['om_task', 'Final answer.']]);
  });

  // A fresh conversation (new session, /clear, /new) opens with Codex's
  // AGENTS.md block as role=user in the same native turn as the first input.
  it('does not take the first message after AGENTS.md opens a conversation for a steer', () => {
    const now = Date.parse(at(0));
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, now - 60_000);
    q.mark('om_task', '更新本机 codex', now);
    const replies = observed(q);
    writeFileSync(path, [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: native } },
      withKinds(userResponseItem('# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n继续之前先跑 test。\n</INSTRUCTIONS>', at(1)),
        ['agents_md.instructions', 'environments.environment_context']),
      withKinds(userResponseItem('更新本机 codex', at(4)), ['user.text']),
      assistantMessageResponseItem('我先确认终端里实际使用的 Codex CLI 版本。', 'commentary', at(5)),
      toolCall('c1', 6), toolOutput('c1', 7),
    ].map(ev).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(replies).toEqual([['om_task', '我先确认终端里实际使用的 Codex CLI 版本。', 'progress']]);
    expect(q.peek()).toMatchObject([{ turnId: 'om_task', started: true }]);
    expect(q.peek()[0].steeredMidTurn).toBeUndefined();
  });

  it('posts nothing for a local turn', () => {
    const now = Date.parse(at(0));
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, now - 60_000);
    const replies = observed(q);
    writeFileSync(path, [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: native } },
      userResponseItem('typed in the terminal', at(1)),
      assistantMessageResponseItem('Working on it.', 'commentary', at(2)),
      toolCall('c1', 3), toolOutput('c1', 4),
    ].map(ev).join(''));
    q.ingest(drainCodexRollout(path, 0).events);
    expect(q.peek()).toMatchObject([{ isLocal: true }]);
    expect(replies).toEqual([]);
  });
});

describe('CodexMidTurnReplyCollector', () => {
  const message = (uuid: string, text: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [], assistantMessage: text });
  const tool = (uuid: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [{ kind: 'tool_call', id: uuid, name: 'js', args: '' }] });
  const thinking = (uuid: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [{ kind: 'thinking', text: 'hmm' }] });

  it('waits through tool calls before anything is said, joins a run of messages, and reports each run once', () => {
    const c = new CodexMidTurnReplyCollector({ steeredMidTurn: true });
    expect(c.feed(tool('t0'))).toBeUndefined();
    expect(c.feed(message('m1', 'First part.'))).toBeUndefined();
    expect(c.feed(thinking('r1'))).toBeUndefined();
    expect(c.feed(message('m2', '  Second part. '))).toBeUndefined();
    expect(c.feed(tool('t1'))).toEqual({ text: 'First part.\n\nSecond part.', lastUuid: 'm2', saidAtMs: 0, answersSteer: true });
    expect(c.feed(tool('t2'))).toBeUndefined();
    expect(c.feed(message('m3', 'later narration'))).toBeUndefined();
    expect(c.feed(tool('t3'))).toEqual({ text: 'later narration', lastUuid: 'm3', saidAtMs: 0, answersSteer: false });
    expect(c.feed(message('m4', 'the final answer'))).toBeUndefined();
  });

  it('does not complete a run at a command completion record, and reports when the run was said', () => {
    const c = new CodexMidTurnReplyCollector({});
    c.feed({ ...message('m1', 'Final answer.'), timestampMs: 42 });
    expect(c.feed({ ...tool('done'), toolCompletion: true })).toBeUndefined();
    expect(c.feed(tool('t1'))).toEqual({ text: 'Final answer.', lastUuid: 'm1', saidAtMs: 42, answersSteer: false });
  });

  it('never calls anything an ordinary turn says a steer answer', () => {
    const c = new CodexMidTurnReplyCollector({});
    c.feed(message('m1', 'Working on it.'));
    expect(c.feed(tool('t1'))).toMatchObject({ answersSteer: false });
  });

  it('is not completed by a tool record written before the latest message', () => {
    const at = (uuid: string, offset: number, ev: CodexBridgeEvent): CodexBridgeEvent =>
      ({ ...ev, uuid, rolloutPath: '/r.jsonl', rolloutOffset: offset });
    const c = new CodexMidTurnReplyCollector({});
    c.feed(at('m1', 100, message('m1', 'Step one.')));
    expect(c.feed(at('t1', 200, tool('t1')))).toMatchObject({ text: 'Step one.' });
    c.feed(at('m2', 400, message('m2', 'Step two.')));
    expect(c.feed(at('t-deferred', 300, tool('t-deferred')))).toBeUndefined();
    expect(c.feed(at('t2', 500, tool('t2')))).toMatchObject({ text: 'Step two.', lastUuid: 'm2' });
  });
});

describe('codexSessionIdFromRolloutPath', () => {
  it('extracts sessionId suffix from a canonical rollout path', () => {
    expect(codexSessionIdFromRolloutPath(
      '/root/.codex/sessions/2026/04/29/rollout-2026-04-29T07-04-39-019dd80d-d922-7a11-8339-0208d8c5b4ec.jsonl',
    )).toBe('019dd80d-d922-7a11-8339-0208d8c5b4ec');
  });

  it('returns undefined for non-rollout paths', () => {
    expect(codexSessionIdFromRolloutPath('/var/log/syslog')).toBeUndefined();
    expect(codexSessionIdFromRolloutPath('/root/.codex/history.jsonl')).toBeUndefined();
  });

  it('returns undefined when filename is malformed', () => {
    expect(codexSessionIdFromRolloutPath('/root/.codex/sessions/foo/bar.jsonl')).toBeUndefined();
    expect(codexSessionIdFromRolloutPath('rollout-no-suffix-just-text.jsonl')).toBeUndefined();
  });
});

describe('findCodexRolloutBySessionId', () => {
  it('honors CODEX_HOME when locating rollout transcripts', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '02');
    const rolloutPath = join(rolloutDir, `rollout-2026-06-02T08-14-07-${sid}.jsonl`);
    process.env.CODEX_HOME = codexHome;
    try {
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(rolloutPath, '');
      expect(findCodexRolloutBySessionId(sid)).toBe(rolloutPath);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('codexHistorySidIsOwned (pure attach-ownership decision)', () => {
  // This is the exact predicate BOTH worker attach entry points (notify
  // re-attach + initial-attach guard) consult via codexHistorySidOwnedByCurrentPid.
  // Testing it directly proves "owned B is selected, foreign A is rejected"
  // without a live worker — and without a parallel copy of the decision.
  const OWNED = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const SIBLING = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const FOREIGN = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

  it('accepts an owned sid (single-rollout pid)', () => {
    expect(codexHistorySidIsOwned(OWNED, new Set([OWNED]))).toBe(true);
  });

  it('accepts EITHER owned sid in the parent+sibling multi-rollout case', () => {
    const owned = new Set([OWNED, SIBLING]);
    expect(codexHistorySidIsOwned(OWNED, owned)).toBe(true);
    expect(codexHistorySidIsOwned(SIBLING, owned)).toBe(true);
  });

  it('rejects a foreign sid (shared-CODEX_HOME sibling pane collision)', () => {
    expect(codexHistorySidIsOwned(FOREIGN, new Set([OWNED, SIBLING]))).toBe(false);
  });

  it('is case-insensitive on the sid', () => {
    expect(codexHistorySidIsOwned(OWNED.toUpperCase(), new Set([OWNED]))).toBe(true);
  });

  it('fails closed when the owned set is unavailable (fd enumeration failed)', () => {
    expect(codexHistorySidIsOwned(OWNED, undefined)).toBe(false);
  });

  it('fails closed against an empty owned set (pid holds no rollout yet)', () => {
    expect(codexHistorySidIsOwned(OWNED, new Set())).toBe(false);
  });
});

describe('findCodexSessionIdByBotmuxSessionId', () => {
  it('bounds the history scan to the requested tail window', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const historyPath = join(codexHome, 'history.jsonl');
    process.env.CODEX_HOME = codexHome;
    try {
      const oldLine = JSON.stringify({ session_id: 'old-codex-sid', text: 'hello <session_id>botmux-tail-sid</session_id>' });
      const padding = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ session_id: `pad-${i}`, text: 'x'.repeat(100) }),
      ).join('\n');
      writeFileSync(historyPath, `${oldLine}\n${padding}\n`);

      // The marker lives outside a 1 KiB tail window — must not be found
      // (and, crucially, the whole multi-MB file must not be slurped).
      expect(findCodexSessionIdByBotmuxSessionId('botmux-tail-sid', { maxTailBytes: 1024 })).toBeUndefined();
      // The default window is large enough to cover the entire file here.
      expect(findCodexSessionIdByBotmuxSessionId('botmux-tail-sid')).toBe('old-codex-sid');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('honors CODEX_HOME and returns the newest history entry for a botmux session', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const historyPath = join(codexHome, 'history.jsonl');
    process.env.CODEX_HOME = codexHome;
    try {
      writeFileSync(historyPath, [
        JSON.stringify({ session_id: 'older-codex-sid', text: 'hello <session_id>botmux-sid</session_id>' }),
        JSON.stringify({ session_id: 'unrelated-codex-sid', text: 'hello another-session' }),
        JSON.stringify({ session_id: 'newer-codex-sid', text: 'resume <session_id>botmux-sid</session_id>' }),
      ].join('\n') + '\n');

      expect(findCodexSessionIdByBotmuxSessionId('botmux-sid')).toBe('newer-codex-sid');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('splitCodexEventsByCutoff', () => {
  const ev = (uuid: string, kind: 'user' | 'assistant_final', timestampMs: number, text = 't'): CodexBridgeEvent =>
    ({ uuid, timestampMs, kind, text });

  it('partitions by strict less-than: events at cutoff land in live', () => {
    const events = [ev('a', 'user', 50), ev('b', 'user', 100), ev('c', 'assistant_final', 150)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['a']);
    expect(out.live.map(e => e.uuid)).toEqual(['b', 'c']);
  });

  it('all-history when every event predates cutoff', () => {
    const events = [ev('a', 'user', 10), ev('b', 'assistant_final', 20)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['a', 'b']);
    expect(out.live).toEqual([]);
  });

  it('all-live when every event is at-or-after cutoff', () => {
    const events = [ev('a', 'user', 100), ev('b', 'assistant_final', 200)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history).toEqual([]);
    expect(out.live.map(e => e.uuid)).toEqual(['a', 'b']);
  });

  it('preserves event order within each partition', () => {
    const events = [
      ev('hist1', 'user', 10),
      ev('live1', 'user', 200),
      ev('hist2', 'assistant_final', 50),
      ev('live2', 'assistant_final', 250),
    ];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['hist1', 'hist2']);
    expect(out.live.map(e => e.uuid)).toEqual(['live1', 'live2']);
  });

  it('empty input returns empty partitions', () => {
    const out = splitCodexEventsByCutoff([], 100);
    expect(out.history).toEqual([]);
    expect(out.live).toEqual([]);
  });
});

describe('extractLastCodexTurn', () => {
  const mk = (kind: 'user' | 'assistant_final', text: string) => ({ kind, text });

  it('returns last user/assistant_final pair from a typical history', () => {
    const out = extractLastCodexTurn([
      mk('user', 'u1'), mk('assistant_final', 'a1'),
      mk('user', 'u2'), mk('assistant_final', 'a2'),
    ]);
    expect(out).toEqual({ userText: 'u2', assistantText: 'a2' });
  });

  it('pairs the last assistant_final with the nearest preceding user', () => {
    // u1 没回复 → 配 (u2, a) 而不是 (u1, a)
    const out = extractLastCodexTurn([
      mk('user', 'u1'),
      mk('user', 'u2'),
      mk('assistant_final', 'a'),
    ]);
    expect(out).toEqual({ userText: 'u2', assistantText: 'a' });
  });

  it('returns undefined when there is no assistant_final', () => {
    expect(extractLastCodexTurn([mk('user', 'u1'), mk('user', 'u2')])).toBeUndefined();
  });

  it('returns undefined when assistant_final has no preceding user', () => {
    // 罕见但可能：rollout 起手就是 assistant message（例如 resume 截断）
    expect(extractLastCodexTurn([mk('assistant_final', 'a')])).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(extractLastCodexTurn([])).toBeUndefined();
  });

  it('ignores trailing user that has no reply yet', () => {
    // ...u1 a1 u2  → 最后一对完整 turn 仍是 (u1, a1)
    const out = extractLastCodexTurn([
      mk('user', 'u1'), mk('assistant_final', 'a1'),
      mk('user', 'u2'),
    ]);
    expect(out).toEqual({ userText: 'u1', assistantText: 'a1' });
  });
});

describe('codexTaskFailureCode (shared Codex-family failure classifier)', () => {
  it('keeps the exact output-limit discriminator separate from the shared classifier', () => {
    const exact = 'model output limit exceeded: max_output_tokens';
    expect(isExactCodexOutputLimitError(exact)).toBe(true);
    expect(isExactCodexOutputLimitError({ message: `  ${exact.toUpperCase()}  ` })).toBe(true);
    expect(isExactCodexOutputLimitError(`${exact}: extra`)).toBe(false);
    expect(codexTaskFailureCode(exact)).toBe(CODEX_TASK_FAILED_ERROR_CODE);
  });

  it('classifies model gateway / upstream failures as codex_upstream_error', () => {
    // Live incident shape: the model gateway cancelled the stream mid-turn.
    expect(codexTaskFailureCode(
      'upstream stream error: rpc error: code = 1 desc = Cancelled by backend [biz error]',
    )).toBe(CODEX_UPSTREAM_ERROR_CODE);
    expect(codexTaskFailureCode('502 Bad Gateway')).toBe(CODEX_UPSTREAM_ERROR_CODE);
    expect(codexTaskFailureCode('503 Service Unavailable')).toBe(CODEX_UPSTREAM_ERROR_CODE);
    expect(codexTaskFailureCode({ error: { message: 'Internal server error' } }))
      .toBe(CODEX_UPSTREAM_ERROR_CODE);
    expect(codexTaskFailureCode('Overloaded: please retry')).toBe(CODEX_UPSTREAM_ERROR_CODE);
  });

  it('checks upstream BEFORE connection so "gateway timeout" is server-side, not local network', () => {
    expect(codexTaskFailureCode('504 Gateway Timeout')).toBe(CODEX_UPSTREAM_ERROR_CODE);
  });

  it('keeps the more specific categories ahead of upstream', () => {
    // A gateway 429 is still a rate limit; a gateway 401 is still auth.
    expect(codexTaskFailureCode('upstream error: 429 Too Many Requests')).toBe(CODEX_RATE_LIMIT_ERROR_CODE);
    expect(codexTaskFailureCode('gateway rejected: 401 Unauthorized')).toBe(CODEX_AUTH_ERROR_CODE);
    expect(codexTaskFailureCode('invalid_request: empty_string')).toBe(CODEX_INVALID_REQUEST_ERROR_CODE);
  });

  it('keeps plain connectivity failures on codex_connection_failed', () => {
    expect(codexTaskFailureCode('ECONNRESET: connection reset by peer')).toBe(CODEX_CONNECTION_ERROR_CODE);
    expect(codexTaskFailureCode('getaddrinfo ENOTFOUND api.example.com')).toBe(CODEX_CONNECTION_ERROR_CODE);
  });

  it('classifies 413 as payload-too-large instead of a connection failure', () => {
    // Live incident shape (DeepSeek / openresty gateway, 2026-11): the whole
    // HTML body arrives wrapped in Codex's http_connection_failed error info.
    // Reporting it as codex_connection_failed told the user to check the
    // network, which can never fix a request-body size limit.
    const live = {
      message: 'unexpected status 413 Payload Too Large: <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>',
      codex_error_info: { http_connection_failed: { http_status_code: 413 } },
    };
    expect(codexTaskFailureCode(live)).toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
    expect(codexTaskFailureCode('413 Request Entity Too Large')).toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
    expect(codexTaskFailureCode('unexpected status 413 Payload Too Large')).toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
    expect(codexTaskFailureCode({ error: { message: 'Request body too large' } }))
      .toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
  });

  it('does not let the payload-too-large branch swallow unrelated statuses', () => {
    expect(codexTaskFailureCode('400 Bad Request: invalid body')).toBe(CODEX_INVALID_REQUEST_ERROR_CODE);
    expect(codexTaskFailureCode('429 Too Many Requests')).toBe(CODEX_RATE_LIMIT_ERROR_CODE);
  });

  it('classifies a 413 by its status alone when the body has no "too large" wording', () => {
    // Anthropic's request_too_large body (as its SDK formats it) matches none
    // of the text alternatives; only the status token identifies the cause.
    expect(codexTaskFailureCode('413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}'))
      .toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
    expect(codexTaskFailureCode({
      message: 'unexpected status',
      codex_error_info: { http_connection_failed: { http_status_code: 413 } },
    })).toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
  });

  it('keeps a 413 relayed inside an invalid_request_error envelope on payload-too-large', () => {
    expect(codexTaskFailureCode({ error: { type: 'invalid_request_error', message: '413 Request Entity Too Large' } }))
      .toBe(CODEX_PAYLOAD_TOO_LARGE_ERROR_CODE);
  });

  it('falls back to codex_task_failed for unrecognized errors', () => {
    expect(codexTaskFailureCode('something exploded')).toBe(CODEX_TASK_FAILED_ERROR_CODE);
  });
});

describe('drainCodexRollout', () => {
  it('returns empty for missing file', () => {
    const r = drainCodexRollout(join(dir, 'missing.jsonl'), 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('extracts user (response_item) + assistant_final (task_complete)', () => {
    writeFileSync(path,
      ev(userResponseItem('hello there')) +
      ev(assistantFinalResponseItem('hi back')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('hello there');
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('hi back');
  });

  it('surfaces task_started before a delayed user record', () => {
    writeFileSync(path,
      ev({
        timestamp: '2026-04-29T07:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'native-turn-1' },
      })
      + ev(userResponseItem('delayed prompt', '2026-04-29T07:01:40.000Z'))
      + ev(assistantFinalResponseItem('done', '2026-04-29T07:02:00.000Z')));

    expect(drainCodexRollout(path, 0).events).toEqual([
      expect.objectContaining({ kind: 'turn_started', sourceTurnId: 'native-turn-1' }),
      expect.objectContaining({ kind: 'user', text: 'delayed prompt' }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'done',
        sourceTurnId: 'turn-2026-04-29T07:02:00.000Z',
      }),
    ]);
  });

  it('renders native CommandExecution and hides its outer JavaScript exec wrapper', () => {
    writeFileSync(path,
      ev(userResponseItem('inspect the readme'))
      + ev({
        timestamp: '2026-04-29T07:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call', name: 'exec', call_id: 'outer-1',
          input: 'await tools.exec_command({ cmd: "sed -n 1,20p README.md" })',
        },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.150Z',
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'reasoning-1' } },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.160Z',
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'message-1' } },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.200Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution', id: 'native-1',
            command: ['/bin/bash', '-lc', "sed -n '1,20p' README.md"],
            parsed_cmd: [{ type: 'read', cmd: "sed -n '1,20p' README.md" }],
            formatted_output: '# BotMux\nNative output',
          },
        },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.300Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'outer-1', output: '{"output":"wrapper output"}' },
      })
      + ev(assistantFinalResponseItem('done')));

    const result = drainTimeline(path, 0);
    const cot = result.events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(1);
    expect(cot[0].cotEntries).toEqual([
      {
        kind: 'tool_call', id: 'native-1', name: 'shell',
        args: JSON.stringify({ command: ['/bin/bash', '-lc', "sed -n '1,20p' README.md"] }),
        subject: "sed -n '1,20p' README.md",
      },
      { kind: 'tool_result', id: 'native-1', result: '# BotMux\nNative output' },
    ]);
  });

  it('suppresses exec outputs across incremental drains and polling wrappers', () => {
    writeFileSync(path,
      ev({
        timestamp: '2026-04-29T07:00:00.100Z', type: 'response_item',
        payload: {
          type: 'custom_tool_call', name: 'exec', call_id: 'outer-run',
          input: 'await tools.exec_command({ cmd: "code --list-extensions --show-versions 2>/dev/null | rg -i \'openai|codex|chatgpt|continue|cline\' | head -35" })',
        },
      }));
    const first = drainTimeline(path, 0);
    expect(first.events).toEqual([]);

    appendFileSync(path,
      ev({
        timestamp: '2026-04-29T07:00:00.150Z', type: 'event_msg',
        payload: { type: 'ignored', blob: 'x'.repeat(70 * 1024) },
      })
      +
      ev({
        timestamp: '2026-04-29T07:00:00.200Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'outer-run', output: 'control output' },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.300Z', type: 'response_item',
        payload: {
          type: 'custom_tool_call', name: 'exec', call_id: 'outer-poll',
          input: 'await tools.exec_command({ cmd: "code --list-extensions --show-versions 2>/dev/null | rg -i \'openai|codex|chatgpt|continue|cline\' | head -35" })',
        },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.400Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'outer-poll', output: 'poll output' },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.500Z', type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution', id: 'native-2',
            command: ['bash', '-lc', "code --list-extensions --show-versions 2>/dev/null | rg -i 'openai|codex|chatgpt|continue|cline' | head -35"],
            parsed_cmd: [{ type: 'unknown', cmd: "code --list-extensions --show-versions 2>/dev/null | rg -i 'openai|codex|chatgpt|continue|cline' | head -35" }],
            stdout: 'passed', stderr: '',
          },
        },
      }));
    const second = drainTimeline(path, first.newOffset);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].cotEntries).toMatchObject([
      { kind: 'tool_call', id: 'native-2', name: 'shell', subject: "code --list-extensions --show-versions 2>/dev/null | rg -i 'openai|codex|chatgpt|continue|cline' | head -35" },
      { kind: 'tool_result', id: 'native-2', result: 'passed' },
    ]);
  });

  it('preserves non-exec custom tools', () => {
    writeFileSync(path,
      ev({
        timestamp: '2026-04-29T07:00:00.100Z', type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input: '*** Begin Patch' },
      }));
    const first = drainTimeline(path, 0);
    expect(first.events.filter(event => event.kind === 'cot')).toHaveLength(1);

    appendFileSync(path, ev({
        timestamp: '2026-04-29T07:00:00.200Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Done' },
      })
      + ev({
        timestamp: '2026-04-29T07:00:00.300Z', type: 'response_item',
        payload: {
          type: 'custom_tool_call', name: 'exec', call_id: 'stale-exec',
          input: 'await tools.exec_command({ cmd: "echo stale" })',
        },
      })
      + ev(assistantFinalResponseItem('complete')));
    const completed = drainTimeline(path, first.newOffset);
    expect(completed.events.filter(event => event.kind === 'cot')).toHaveLength(1);
    expect(completed.events.find(event => event.kind === 'cot')?.cotEntries).toEqual([
      { kind: 'tool_result', id: 'patch-1', result: 'Done' },
    ]);
  });

  it('restores an exec wrapper at turn completion when no native command arrives', () => {
    writeFileSync(path, ev(userResponseItem('run a custom tool')) + ev({
      type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'fallback-1',
        input: 'await tools.exec_command({ cmd: "echo fallback" })',
      },
    }));
    const first = drainTimeline(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);
    appendFileSync(path, ev({
      type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'fallback-1', output: '{"output":"ok"}'
      },
    }) + ev({ type: 'event_msg', payload: { type: 'ignored', blob: 'x'.repeat(70 * 1024) } }));
    const second = drainTimeline(path, first.newOffset);
    expect(second.events).toEqual([]);
    appendFileSync(path, ev(assistantFinalResponseItem('done')));
    const third = drainTimeline(path, second.newOffset);
    expect(third.events.map(event => event.kind)).toEqual(['cot', 'assistant_final']);
    expect(third.events[0].cotEntries).toMatchObject([
      { kind: 'tool_call', id: 'fallback-1', name: 'exec' },
      { kind: 'tool_result', id: 'fallback-1', result: 'ok' },
    ]);
  });

  it('closes an empty native command result and ignores wrappers from prior turns', () => {
    writeFileSync(path,
      ev(userResponseItem('first'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'old',
        input: 'await tools.exec_command({ cmd: "echo old" })',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'old', output: 'old output'
      } })
      + ev(assistantFinalResponseItem('first done'))
      + ev(userResponseItem('second'))
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-empty', command: ['true'], formatted_output: ''
      } } })
      + ev(assistantFinalResponseItem('second done')));
    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(2);
    expect(cot[0].cotEntries?.[0]).toMatchObject({ kind: 'tool_call', id: 'old' });
    expect(cot[1].cotEntries).toEqual([
      { kind: 'tool_call', id: 'native-empty', name: 'shell', args: '{"command":["true"]}', subject: 'true' },
      { kind: 'tool_result', id: 'native-empty', result: '' },
    ]);
  });

  it('keeps an exec fallback when the same turn includes a file change', () => {
    writeFileSync(path,
      ev(userResponseItem('edit and inspect'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'mixed', input: 'await tools.apply_patch(...)'
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'FileChange', id: 'file-1'
      } } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'mixed', output: 'Patch applied'
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-3', command: ['git', 'diff'], stdout: 'diff'
      } } })
      + ev(assistantFinalResponseItem('done')));
    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    const calls = cot.flatMap(event => event.cotEntries ?? []).filter(entry => entry.kind === 'tool_call');
    expect(calls.map(entry => entry.id)).toEqual(['mixed', 'native-3']);
  });

  it('keeps non-command exec wrappers that precede a native shell command', () => {
    writeFileSync(path,
      ev(userResponseItem('plan then inspect'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'plan-wrapper',
        input: 'await tools.update_plan({ plan: [] })',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'plan-wrapper', output: '{"output":"updated"}',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'shell-wrapper',
        input: 'await tools.exec_command({ cmd: "git status --short" })',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'shell-wrapper', output: '{"output":"wrapper"}',
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-status', command: ['bash', '-lc', 'git status --short'], stdout: 'clean',
      } } })
      + ev(assistantFinalResponseItem('done')));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot.flatMap(event => event.cotEntries ?? [])).toEqual([
      expect.objectContaining({ kind: 'tool_call', id: 'plan-wrapper', name: 'exec' }),
      { kind: 'tool_result', id: 'plan-wrapper', result: 'updated' },
      expect.objectContaining({ kind: 'tool_call', id: 'native-status', name: 'shell' }),
      { kind: 'tool_result', id: 'native-status', result: 'clean' },
    ]);
  });

  it('splits mixed exec wrappers and suppresses only the matched command', () => {
    writeFileSync(path,
      ev(userResponseItem('run and poll'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'mixed-wrapper',
        input: 'await Promise.allSettled([tools.web__run({ query: "status" }), tools.exec_command({ cmd: "sleep 1" }), tools.write_stdin({ session_id: 7, chars: "" })])',
      } }));
    const first = drainTimeline(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    appendFileSync(path, ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'mixed-wrapper', output: '{"output":"poll complete"}',
      } }));
    const second = drainTimeline(path, first.newOffset);
    expect(second.events).toEqual([]);

    appendFileSync(path, ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-sleep', command: ['bash', '-lc', 'sleep 1'], stdout: '',
      } } })
      + ev(assistantFinalResponseItem('done')));

    const entries = drainTimeline(path, second.newOffset).events
      .filter(event => event.kind === 'cot')
      .flatMap(event => event.cotEntries ?? []);
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'tool_call', id: 'native-sleep', name: 'shell', subject: 'sleep 1' }),
      { kind: 'tool_result', id: 'native-sleep', result: '' },
      expect.objectContaining({ kind: 'tool_call', id: 'mixed-wrapper:0', name: 'web__run' }),
      { kind: 'tool_result', id: 'mixed-wrapper:0', result: '' },
      expect.objectContaining({ kind: 'tool_call', id: 'mixed-wrapper:2', name: 'write_stdin' }),
      { kind: 'tool_result', id: 'mixed-wrapper:2', result: 'poll complete' },
    ]);
    expect(entries.some(entry => entry.kind === 'tool_call' && entry.name === 'exec')).toBe(false);
  });

  it('does not treat tool names inside strings as nested calls', () => {
    writeFileSync(path,
      ev(userResponseItem('show an example'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'example-wrapper',
        input: 'const example = "tools.exec_command({ cmd: \\\"fake\\\" })"; text(example)',
      } }));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(1);
    expect(cot[0].cotEntries?.[0]).toMatchObject({ kind: 'tool_call', id: 'example-wrapper', name: 'exec' });
  });

  it('keeps an unmatched command wrapper when another native command exists', () => {
    writeFileSync(path,
      ev(userResponseItem('run both'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'early-wrapper',
        input: 'await tools.exec_command({ cmd: "echo early" })',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'early-wrapper', output: '{"output":"early"}',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'late-wrapper',
        input: 'await tools.exec_command({ cmd: "echo late" })',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'late-wrapper', output: '{"output":"late"}',
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-late', command: ['bash', '-lc', 'echo late'], stdout: 'late',
      } } })
      + ev(assistantFinalResponseItem('done')));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot.map(event => event.cotEntries?.[0]?.id)).toEqual(['native-late', 'early-wrapper']);
  });

  it('does not let injected user records truncate terminal fallbacks', () => {
    writeFileSync(path,
      ev(userResponseItem('first'))
      + ev(assistantFinalResponseItem('first done'))
      + ev(userResponseItem('run legacy command'))
      + ev({ type: 'response_item', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'legacy-unmatched',
        arguments: '{"cmd":"echo legacy"}',
      } })
      + ev(userResponseItem('<session_id>abc</session_id><botmux_reminder>continue</botmux_reminder>'))
      + ev({ type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'legacy-unmatched', output: '{"output":"legacy"}',
      } })
      + ev(assistantFinalResponseItem('done')));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(1);
    expect(cot[0].cotEntries).toEqual([
      expect.objectContaining({ kind: 'tool_call', id: 'legacy-unmatched', name: 'exec_command' }),
      { kind: 'tool_result', id: 'legacy-unmatched', result: 'legacy' },
    ]);
  });

  it('does not duplicate a shell command merely because it also changes files', () => {
    const command = 'mkdir -p tmp && cp a tmp/a';
    writeFileSync(path,
      ev(userResponseItem('copy the file'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'copy-wrapper',
        input: `await tools.exec_command({ cmd: ${JSON.stringify(command)} })`,
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-copy', command: ['bash', '-lc', command], stdout: '',
      } } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'FileChange', id: 'copy-files',
      } } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'copy-wrapper', output: '{"output":""}',
      } })
      + ev(assistantFinalResponseItem('done')));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(1);
    expect(cot[0].cotEntries?.[0]).toMatchObject({ kind: 'tool_call', id: 'native-copy' });
  });

  it('deduplicates legacy exec_command function calls by call id', () => {
    writeFileSync(path,
      ev(userResponseItem('inspect'))
      + ev({ type: 'response_item', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'legacy-call',
        arguments: '{"cmd":"pwd"}',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'legacy-call', output: '{"output":"/repo"}',
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'legacy-call', command: ['bash', '-lc', 'pwd'], stdout: '/repo',
      } } })
      + ev(assistantFinalResponseItem('done')));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(1);
    expect(cot[0].cotEntries?.[0]).toMatchObject({ kind: 'tool_call', id: 'legacy-call', name: 'shell' });
  });

  it('matches a native command produced from a wrapper template literal', () => {
    writeFileSync(path,
      ev(userResponseItem('inspect docs'))
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'template-wrapper',
        input: 'const doc = "abc"; await tools.exec_command({ cmd: `fetch --doc ${doc} --format json` })',
      } })
      + ev({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'template-wrapper', output: '{"output":"wrapper"}',
      } })
      + ev({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'native-template',
        command: ['bash', '-lc', 'fetch --doc abc --format json'], stdout: 'native',
      } } })
      + ev(assistantFinalResponseItem('done')));

    const cot = drainTimeline(path, 0).events.filter(event => event.kind === 'cot');
    expect(cot).toHaveLength(1);
    expect(cot[0].cotEntries?.[0]).toMatchObject({ kind: 'tool_call', id: 'native-template' });
  });

  it('marks where a deferred shell call was made, apart from its thinking-timeline entry', () => {
    writeFileSync(path,
      ev(userResponseItem('inspect the readme'))
      + ev({ timestamp: '2026-04-29T07:00:00.100Z', type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'outer-1',
        input: 'await tools.exec_command({ cmd: "sed -n 1,20p README.md" })' } })
      + ev({ timestamp: '2026-04-29T07:00:00.200Z', type: 'response_item', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'legacy-1', arguments: '{"cmd":"ls"}' } })
      + ev({ timestamp: '2026-04-29T07:00:00.300Z', type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input: '*** Begin Patch' } }));
    const r = drainCodexRollout(path, 0);
    // One bare boundary per deferred call, at its own line; an ordinary call
    // keeps its timeline entry and needs none.
    const boundaries = r.events.filter(e => e.toolCallBoundary === true);
    expect(boundaries.map(e => [e.kind, e.cotEntries, e.text])).toEqual([['cot', [], ''], ['cot', [], '']]);
    expect(new Set(r.events.map(e => e.uuid)).size).toBe(r.events.length);
    expect(r.events.filter(e => e.kind === 'cot' && !e.toolCallBoundary).flatMap(e => e.cotEntries ?? []).map(e => e.kind)).toEqual(['tool_call']);
  });

  it('skips developer role messages', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys instr' }] },
      }) +
      ev(userResponseItem('real user prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('real user prompt');
  });

  // Regression for the codex >=0.146 phase-drift bug: mid-turn AND final
  // assistant response_item messages are both phase-less and must NOT be a
  // turn boundary. Only task_complete closes the turn. Keying on a phase-less
  // assistant message would close the turn on the first mid-turn preamble
  // ("I'll run the commands…") and truncate the real answer.
  it('never treats an assistant response_item message as terminal (mid-turn preamble + phase-less final)', () => {
    writeFileSync(path,
      ev(userResponseItem('do two things')) +
      ev(assistantMessageResponseItem("I'll run the commands.")) +   // mid-turn preamble, phase:undefined
      ev(assistantMessageResponseItem('step1 step2 DONE')) +          // final answer, ALSO phase:undefined (0.146)
      ev(assistantFinalResponseItem('step1 step2 DONE')));            // the real terminal
    const r = drainCodexRollout(path, 0);
    // Exactly one user + one assistant_final (from task_complete). Neither
    // assistant response_item is a boundary: each surfaces only as a 'cot'
    // record carrying its text, with no thinking-timeline entries.
    expect(r.events.map(e => e.kind)).toEqual(['user', 'cot', 'cot', 'assistant_final']);
    expect(r.events.filter(e => e.kind === 'cot').map(e => [e.assistantMessage, e.cotEntries, e.text])).toEqual([
      ["I'll run the commands.", [], ''],
      ['step1 step2 DONE', [], ''],
    ]);
    expect(r.events[3].text).toBe('step1 step2 DONE');
  });

  // Old codex (0.139 / 0.145) still tags the final message phase:'final_answer'
  // AND emits task_complete. We take ONLY task_complete → exactly one
  // assistant_final, no double-close (the queue would buffer a stray second
  // final and could mis-close a later turn).
  it('old-codex final_answer response_item + task_complete → single assistant_final', () => {
    writeFileSync(path,
      ev(userResponseItem('hi')) +
      ev(assistantMessageResponseItem('legacy final', 'final_answer')) +  // old phase-tagged final
      ev(assistantFinalResponseItem('legacy final')));                    // task_complete for same turn
    const r = drainCodexRollout(path, 0);
    const finals = r.events.filter(e => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('legacy final');
  });

  // A task_complete with empty last_agent_message still closes the turn (a
  // silent successful turn must release its durable delivery).
  it('empty last_agent_message still yields an assistant_final', () => {
    writeFileSync(path,
      ev(userResponseItem('go')) +
      ev({ timestamp: '2026-04-29T07:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '' } }));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('');
  });

  it('maps the real nested -4003 task_complete error to a safe failed terminal', () => {
    const nested = JSON.stringify({
      error: {
        message: "code: empty_string; message: Invalid 'input[0].tools[0].description': empty string. Expected a string with minimum length 1, but got an empty string instead.",
        type: 'invalid_request_error',
        param: 'input[0].tools[0].description',
        code: '-4003',
      },
    });
    writeFileSync(path,
      ev(userResponseItem('inspect incident')) +
      ev({
        timestamp: '2026-08-08T02:50:18.520Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: '019fdf47-40cf-7a60-9a78-718346e4ce80',
          last_agent_message: null,
          error: { message: nested, codex_error_info: 'other' },
        },
      }));
    const failed = drainCodexRollout(path, 0).events[1];
    expect(failed).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_INVALID_REQUEST_ERROR_CODE,
    });
    expect(failed.terminalErrorSummary).toContain('-4003 invalid_request_error');
    expect(failed.terminalErrorSummary).toContain('input[0].tools[0].description');
  });

  it('redacts credentials and active syntax from bounded auth summaries', () => {
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'auth-failure',
        error: {
          message: `401 Unauthorized authorization=Bearer abcdefghijklmnopqrstuvwxyz token=super-secret-value https://example.test/cb?signature=leak <at user_id="ou_secret"> @all ${'x'.repeat(500)}`,
        },
      },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorCode).toBe(CODEX_AUTH_ERROR_CODE);
    expect(failed.terminalErrorSummary).toContain('[REDACTED]');
    expect(failed.terminalErrorSummary).toContain('[URL]');
    expect(failed.terminalErrorSummary).not.toContain('abcdefghijkl');
    expect(failed.terminalErrorSummary).not.toContain('super-secret-value');
    expect(failed.terminalErrorSummary).not.toContain('<at');
    expect(failed.terminalErrorSummary).not.toContain('@all');
    expect(failed.terminalErrorSummary!.length).toBeLessThanOrEqual(320);
  });

  it('redacts quoted-JSON credential values while keeping non-secret fields', () => {
    // Provider errors are commonly JSON payloads whose message text embeds a
    // credential in quoted-JSON form: `"api_key":"..."`. The key name carries
    // its own closing quote, so a bare `key[:=]` matcher misses it. The redact
    // rule pairs the key/value quotes with backrefs and spans `\"` escapes, so
    // the WHOLE value is removed — including values that contain an escaped
    // quote — while quoted keys with bare-word values are left untouched.
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'json-secret',
        error: {
          message: 'gateway rejected request for model gpt-5: {"api_key":"AbCdEf123456xyz","password":"hunter2secret"}',
        },
      },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorSummary).toBeDefined();
    // Secrets in quoted-JSON form are redacted.
    expect(failed.terminalErrorSummary).not.toContain('AbCdEf123456xyz');
    expect(failed.terminalErrorSummary).not.toContain('hunter2secret');
    expect(failed.terminalErrorSummary).toContain('[REDACTED]');
    // Non-secret text (the useful reason) survives — no over-redaction.
    expect(failed.terminalErrorSummary).toContain('gpt-5');
  });

  it('redacts the whole value when a quoted-JSON secret contains an escaped quote', () => {
    // A value like `"abc\"TAIL"` must be redacted in full. A value matcher that
    // stopped at the first inner quote would leave the `TAIL` tail exposed.
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'escaped-quote',
        error: { message: `gateway rejected: ${JSON.stringify({ password: 'abc"TAIL_SECRET_123' })}` },
      },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorSummary).toBeDefined();
    expect(failed.terminalErrorSummary).not.toContain('TAIL_SECRET_123');
    expect(failed.terminalErrorSummary).toContain('[REDACTED]');
    expect(failed.terminalErrorSummary).toContain('gateway rejected');
  });

  it('does not swallow the word after a quoted key that has a bare-word value', () => {
    // Regression guard: `"token": a lexical unit` is NOT `key=value` — the
    // redaction must not treat `a` as the value and delete the trailing words.
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'quoted-key-bare-value',
        error: { message: 'provider said {"token": a lexical unit failed here}' },
      },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorSummary).toBeDefined();
    // The lexical units are ordinary prose, not a credential — keep them.
    expect(failed.terminalErrorSummary).toContain('a lexical unit failed here');
  });

  it('fails closed (no summary) when message wrapping exceeds the unwrap depth', () => {
    // codexFailureLeaf peels at most 6 levels. A provider that wraps
    // `message: JSON.stringify(...)` more deeply leaves `message` as a still
    // -nested JSON literal whose escaped quotes defeat redaction. Rather than
    // leak the embedded secret verbatim, surface no summary.
    let inner: string = JSON.stringify({ api_key: 'DEEP_SECRET_VALUE' });
    for (let i = 0; i < 9; i++) inner = JSON.stringify({ message: inner });
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'deep-wrap',
        error: JSON.parse(inner),
      },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalStatus).toBe('failed');
    // The secret never reaches the user-facing summary.
    expect(failed.terminalErrorSummary ?? '').not.toContain('DEEP_SECRET_VALUE');
    expect(failed.terminalErrorSummary).toBeUndefined();
  });

  it('bounds redaction work on adversarial long input (no super-linear blowup)', () => {
    // A JWT-shaped `-`-rich run makes the credential regexes backtrack
    // super-linearly. The pre-scan cap must keep a large blob fast. Guard with
    // wall-clock: unbounded, ~32k chars took seconds; bounded it is a few ms.
    const evil = `${'a-'.repeat(16_000)}aaaaaaaaaaaa.bbbbbbbbbbbb.short`;
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'redos-guard',
        error: { message: evil },
      },
    }));
    const t0 = Date.now();
    const failed = drainCodexRollout(path, 0).events[0];
    const elapsedMs = Date.now() - t0;
    expect(failed.terminalStatus).toBe('failed');
    expect((failed.terminalErrorSummary ?? '').length).toBeLessThanOrEqual(320);
    // Generous ceiling: bounded is single-digit ms; unbounded blew past 500ms.
    expect(elapsedMs).toBeLessThan(200);
  });

  it('does not backtrack on an unclosed quoted value full of backslashes', () => {
    // The quoted-value redactor must use mutually-exclusive branches so a
    // missing close quote after a run of backslashes cannot blow up. Under the
    // old `(?:\\.|(?!close).)*` shape this took hundreds of ms at ~56 chars.
    const evil = `gateway {"password":"${'\\'.repeat(4_000)}X`;
    const t0 = Date.now();
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'backslash-redos', error: { message: evil } },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    const elapsedMs = Date.now() - t0;
    expect(failed.terminalStatus).toBe('failed');
    expect(elapsedMs).toBeLessThan(200);
  });

  it('fails closed when the pre-scan cut leaves a credential value unclosed', () => {
    // A real secret sitting past the pre-scan bound gets sliced mid-value,
    // leaving `password":"SSS…` with no closing quote. The closed-value
    // redactor would miss it and leak the prefix into the shown summary, so an
    // unclosed credential value must fail closed instead.
    const message = 'x'.repeat(300) + `{"password":"${'S'.repeat(1800)}"}`;
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'prescan-cut', error: { message } },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalStatus).toBe('failed');
    expect(failed.terminalErrorSummary ?? '').not.toContain('SSSSS');
    expect(failed.terminalErrorSummary).toBeUndefined();
  });

  it('keeps a word-boundary so lookalike keys like notpassword are not redacted', () => {
    // `notpassword=VALUE` is not a `password` credential — the bare-key rule
    // must anchor on a word boundary and leave the value intact.
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'word-boundary', error: { message: 'config notpassword=VISIBLE_WORD applied' } },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorSummary).toBeDefined();
    expect(failed.terminalErrorSummary).toContain('VISIBLE_WORD');
    // A real bare `password=` in the same string is still redacted.
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'word-boundary-2', error: { message: 'auth password=REAL_SECRET_VAL denied' } },
    }));
    const failed2 = drainCodexRollout(path, 0).events[0];
    expect(failed2.terminalErrorSummary).not.toContain('REAL_SECRET_VAL');
    expect(failed2.terminalErrorSummary).toContain('[REDACTED]');
  });

  it('fails closed when the pre-scan cut lands on a lone dangling backslash', () => {
    // If the 2000-char pre-scan slices mid-escape, the value tail ends in a
    // single `\`. The unclosed-value probe must still fire (its trailing `\\?`
    // absorbs that lone backslash) or the secret prefix leaks into the summary.
    const prefix = 'x'.repeat(300) + '{"password":"';
    const message = prefix + 'S'.repeat(2000 - prefix.length - 1) + '\\REST_OF_SECRET"}';
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'odd-backslash-cut', error: { message } },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorSummary ?? '').not.toContain('SSSSS');
    expect(failed.terminalErrorSummary).toBeUndefined();
  });

  it('redacts a bare-key quoted value containing an escaped quote', () => {
    // `password:"abc\"TAIL"` (bare key, double-quoted value with an inner
    // escaped quote). The bare rule's quoted-value branch must be escape-safe
    // like the JSON-key rule, or it stops at the `\"` and leaks the tail.
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'bare-escaped-quote', error: { message: 'provider {password:"abc\\"TAIL_SECRET_123"} rejected' } },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorSummary).toBeDefined();
    expect(failed.terminalErrorSummary).not.toContain('TAIL_SECRET_123');
    expect(failed.terminalErrorSummary).toContain('[REDACTED]');
  });

  it('classifies structured 429 failures for the dedicated limited state', () => {
    writeFileSync(path, ev({
      timestamp: '2026-08-08T02:50:18.520Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'limited',
        error: { message: '429 Too Many Requests' },
      },
    }));
    const failed = drainCodexRollout(path, 0).events[0];
    expect(failed.terminalErrorCode).toBe(CODEX_RATE_LIMIT_ERROR_CODE);
    expect(isCodexRateLimitEvent(failed)).toBe(true);
  });

  // task_complete without a turn_id is a malformed/partial record — ignored
  // (belt-and-suspenders on top of the newline-completeness guard).
  it('task_complete without turn_id is ignored', () => {
    writeFileSync(path,
      ev(userResponseItem('go')) +
      ev({ timestamp: '2026-04-29T07:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'no turn id' } }));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
  });

  // A cancelled turn writes turn_aborted (no task_complete) → ambiguous
  // terminal so the durable delivery releases instead of wedging as running.
  it('turn_aborted yields an ambiguous assistant_final', () => {
    writeFileSync(path,
      ev(userResponseItem('go')) +
      ev({ timestamp: '2026-04-29T07:00:02.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'user interrupt' } }));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].terminalStatus).toBe('ambiguous');
    expect(r.events[1].terminalErrorCode).toBe('codex_turn_aborted:user_interrupt');
  });

  // Bare/malformed CoT-adjacent items (no summary text, no call ids) and
  // non-terminal event_msg records still produce NO events — the cot channel
  // only fires for well-formed items (see the dedicated describe below).
  it('skips empty reasoning / id-less function_call(+output) / non-terminal event_msg', () => {
    writeFileSync(path,
      ev({ type: 'response_item', payload: { type: 'reasoning' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call_output' } }) +
      ev({ type: 'event_msg', payload: { type: 'token_count', total: 42 } }) +
      ev({ type: 'event_msg', payload: { type: 'agent_message', message: 'mid-turn chatter' } }) +
      ev(userResponseItem('actual prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('actual prompt');
  });

  it('emits cot events for reasoning summaries and tool calls between the turn boundaries', () => {
    writeFileSync(path,
      ev(userResponseItem('do the thing')) +
      ev({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Plan** first I look around' }] } }) +
      ev({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":["bash","-lc","ls"]}' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '{"output":"total 24","metadata":{"exit_code":0}}' } }) +
      ev(assistantFinalResponseItem('done')));
    const r = drainCodexRollout(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'cot', 'cot', 'cot', 'assistant_final']);
    expect(r.events[1].cotEntries).toEqual([{ kind: 'thinking', text: '**Plan** first I look around' }]);
    expect(r.events[2].cotEntries).toEqual([{ kind: 'tool_call', id: 'call_1', name: 'shell', args: '{"command":["bash","-lc","ls"]}', subject: 'ls' }]);
    // Wrapped shell output is unwrapped to the inner text.
    expect(r.events[3].cotEntries).toEqual([{ kind: 'tool_result', id: 'call_1', result: 'total 24' }]);
  });

  it('extracts turn_aborted as a no-output terminal edge', () => {
    writeFileSync(path,
      ev(userResponseItem('interrupt me')) +
      ev({
        timestamp: '2026-04-29T07:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' },
      }));
    const r = drainCodexRollout(path, 0);
    expect(r.events.map(event => ({ kind: event.kind, text: event.text, status: event.terminalStatus }))).toEqual([
      { kind: 'user', text: 'interrupt me', status: undefined },
      { kind: 'assistant_final', text: '', status: 'ambiguous' },
    ]);
  });

  it('keeps an empty final_answer as a normal completed terminal edge', () => {
    writeFileSync(path,
      ev(userResponseItem('finish without visible text')) +
      ev(assistantFinalResponseItem('')));
    const r = drainCodexRollout(path, 0);
    expect(r.events.map(event => ({ kind: event.kind, text: event.text }))).toEqual([
      { kind: 'user', text: 'finish without visible text' },
      { kind: 'assistant_final', text: '' },
    ]);
  });

  it('skips messages with no input_text/output_text content', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'image_url', url: 'x' }] },
      }) +
      ev(userResponseItem('text after image-only')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('text after image-only');
  });

  it('ignores malformed JSON lines', () => {
    writeFileSync(path,
      'not json\n' +
      ev(userResponseItem('after bad line')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('after bad line');
  });

  it('byte-offset stable: re-drain from newOffset returns no events', () => {
    writeFileSync(path,
      ev(userResponseItem('first')) +
      ev(assistantFinalResponseItem('reply')));
    const first = drainCodexRollout(path, 0);
    const second = drainCodexRollout(path, first.newOffset);
    expect(second.events).toEqual([]);
    expect(second.newOffset).toBe(first.newOffset);
  });

  it('appended events drain incrementally', () => {
    writeFileSync(path, ev(userResponseItem('first')));
    const r1 = drainCodexRollout(path, 0);
    expect(r1.events).toHaveLength(1);
    appendFileSync(path, ev(assistantFinalResponseItem('reply')));
    const r2 = drainCodexRollout(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].kind).toBe('assistant_final');
  });

  it('reuses the turn lower bound when tool calls and outputs cross ticks', () => {
    writeFileSync(path, ev(userResponseItem('long running turn')) + ev({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'cross-tick-0',
        input: 'await tools.exec_command({ cmd: "echo 0" })',
      },
    }));
    let drained = drainTimeline(path, 0);

    const startedAt = performance.now();
    for (let i = 0; i < 128; i++) {
      appendFileSync(path,
        ev({ type: 'event_msg', payload: { type: 'progress', blob: 'x'.repeat(64 * 1024) } })
        + ev({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output', call_id: `cross-tick-${i}`, output: 'ok',
          },
        })
        + ev({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call', name: 'exec', call_id: `cross-tick-${i + 1}`,
            input: `await tools.exec_command({ cmd: "echo ${i + 1}" })`,
          },
        }));
      drained = drainTimeline(path, drained.newOffset, drained.state);
      expect(drained.events).toEqual([]);
      expect(drained.state).toEqual({
        nextOffset: drained.newOffset,
        turnStartOffset: 0,
      });
    }
    const elapsedMs = performance.now() - startedAt;

    // This reads roughly 8 MiB in total. Eagerly reverse-scanning from every
    // tick made the same fixture quadratic and took several seconds.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('partial trailing line is held back as pendingTail', () => {
    writeFileSync(path, ev(userResponseItem('complete')) + '{"type":"response_item",partial');
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.pendingTail).toContain('partial');
    expect(r.newOffset).toBeLessThan(statSync(path).size);
  });

  it('uuid encodes path:byteStart and is stable across re-drains', () => {
    writeFileSync(path,
      ev(userResponseItem('uuid-one')) +
      ev(userResponseItem('uuid-two')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].uuid).toMatch(/^.+\.jsonl:0$/);
    expect(r.events[1].uuid).not.toBe(r.events[0].uuid);
    // Re-drain from 0 should produce identical uuids.
    const r2 = drainCodexRollout(path, 0);
    expect(r2.events.map(e => e.uuid)).toEqual(r.events.map(e => e.uuid));
  });

  it('truncated file (size < fromOffset) re-drains from top', () => {
    writeFileSync(path,
      ev(userResponseItem('original message that is reasonably long for offset')) +
      ev(assistantFinalResponseItem('long original answer to take up bytes')));
    const r1 = drainCodexRollout(path, 0);
    // Simulate truncation: rewrite with strictly shorter content so the new
    // size is below r1.newOffset and the re-drain branch fires.
    writeFileSync(path, ev(userResponseItem('s')));
    const r2 = drainCodexRollout(path, r1.newOffset, r1.state);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].text).toBe('s');
    expect(r2.state).toEqual({ nextOffset: r2.newOffset, turnStartOffset: 0 });
  });
});

function threadSettingsApplied(serviceTier?: string, ts = '2026-04-29T07:00:00.000Z', model = 'gpt-5.6-sol') {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: {
        model,
        model_provider_id: 'byteseed',
        ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
      },
    },
  };
}

describe('Codex thread settings observation', () => {
  it('returns undefined when the rollout has no applied-settings record yet', () => {
    writeFileSync(path,
      ev(userResponseItem('hi')) + ev(assistantFinalResponseItem('hello')));
    expect(scanCodexThreadSettings(path)).toBeUndefined();
  });

  it('returns undefined for a missing / empty rollout file', () => {
    expect(scanCodexThreadSettings(join(dir, 'does-not-exist.jsonl'))).toBeUndefined();
    writeFileSync(path, '');
    expect(scanCodexThreadSettings(path)).toBeUndefined();
  });

  it('reads the applied model and service tier', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default')) + ev(userResponseItem('hi')));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('returns the LATEST applied tier when the session switched mid-way', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default', '2026-04-29T07:00:00.000Z')) +
      ev(userResponseItem('go fast')) +
      ev(threadSettingsApplied('priority', '2026-04-29T07:05:00.000Z')) +
      ev(assistantFinalResponseItem('done')));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
    });
  });

  it('ignores non-settings lines and tolerates malformed json', () => {
    writeFileSync(path,
      'not json at all\n' +
      ev(userResponseItem('hi')) +
      ev(threadSettingsApplied('priority')) +
      'still garbage\n');
    expect(scanCodexThreadSettings(path)?.serviceTier).toBe('priority');
  });

  it('treats a valid settings event that carries no service_tier as default', () => {
    writeFileSync(path, ev(threadSettingsApplied()));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('reads the top-level reasoning_effort (follows an in-session /effort switch)', () => {
    writeFileSync(path, ev({
      timestamp: '2026-04-29T07:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: {
          model: 'gpt-5.6-sol',
          service_tier: 'default',
          reasoning_effort: 'xhigh',
        },
      },
    }));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      serviceTier: 'default',
    });
  });

  it('falls back to collaboration_mode.settings.reasoning_effort when no top-level effort', () => {
    writeFileSync(path, ev({
      timestamp: '2026-04-29T07:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: {
          model: 'gpt-5.6-sol',
          service_tier: 'default',
          collaboration_mode: { settings: { reasoning_effort: 'high' } },
        },
      },
    }));
    expect(scanCodexThreadSettings(path)?.reasoningEffort).toBe('high');
  });

  it('reports the latest settings from the newly appended byte range', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default')) + ev(userResponseItem('first')));
    const first = drainCodexRollout(path, 0);
    expect(first.latestThreadSettings).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });

    // Both toggles can land between two 1s bridge polls. The final executor
    // state must still be observed even when no PTY screen update follows.
    appendFileSync(path,
      ev(threadSettingsApplied('priority', '2026-04-29T07:01:00.000Z'))
      + ev(threadSettingsApplied('default', '2026-04-29T07:01:00.100Z')));
    const second = drainCodexRollout(path, first.newOffset);

    expect(second.events).toEqual([]);
    expect(second.latestThreadSettings).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('clears a live priority snapshot when Codex omits service_tier', () => {
    writeFileSync(path, ev(threadSettingsApplied('priority')));
    const first = drainCodexRollout(path, 0);
    expect(first.latestThreadSettings?.serviceTier).toBe('priority');

    appendFileSync(path, ev(threadSettingsApplied(undefined, '2026-04-29T07:01:00.000Z')));
    const second = drainCodexRollout(path, first.newOffset);
    expect(second.latestThreadSettings).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('backward scan returns the newest omitted service_tier as default', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('priority'))
      + ev(threadSettingsApplied(undefined, '2026-04-29T07:01:00.000Z')));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('reverse-scans across chunk and UTF-8 boundaries without loading the whole rollout', () => {
    const latest = ev(threadSettingsApplied('priority', '2026-04-29T07:05:00.000Z'));
    // 900 trailing bytes force the preceding settings line to straddle the
    // scanner's 1024-byte read boundary. Earlier multi-byte content exercises
    // the byte-oriented carry path as well.
    writeFileSync(path,
      ev(threadSettingsApplied('default'))
      + ev(userResponseItem('边界'.repeat(800)))
      + latest
      + `${'x'.repeat(899)}\n`);

    expect(scanCodexThreadSettings(path, { chunkBytes: 1024 })).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
    });
  });
});

function turnContext(opts: {
  model?: string;
  effort?: string;
  settingsModel?: string;
  settingsEffort?: string;
  ts?: string;
} = {}) {
  const payload: any = { turn_id: `turn-${opts.ts ?? 'x'}` };
  if (opts.model !== undefined) payload.model = opts.model;
  if (opts.effort !== undefined) payload.effort = opts.effort;
  if (opts.settingsModel !== undefined || opts.settingsEffort !== undefined) {
    payload.collaboration_mode = {
      settings: {
        ...(opts.settingsModel !== undefined ? { model: opts.settingsModel } : {}),
        ...(opts.settingsEffort !== undefined ? { reasoning_effort: opts.settingsEffort } : {}),
      },
    };
  }
  return {
    timestamp: opts.ts ?? '2026-04-29T07:00:00.000Z',
    type: 'turn_context',
    payload,
  };
}

describe('Codex turn_context runtime (drain)', () => {
  it('surfaces model + effort from a turn_context (the per-turn source)', () => {
    writeFileSync(path, ev(turnContext({ model: 'gpt-5.6-sol', effort: 'xhigh' })));
    const r = drainCodexRollout(path, 0);
    expect(r.latestModel).toBe('gpt-5.6-sol');
    expect(r.latestReasoningEffort).toBe('xhigh');
  });

  it('falls back to collaboration_mode.settings for model/effort', () => {
    writeFileSync(path, ev(turnContext({ settingsModel: 'gpt-5.6-sol', settingsEffort: 'high' })));
    const r = drainCodexRollout(path, 0);
    expect(r.latestModel).toBe('gpt-5.6-sol');
    expect(r.latestReasoningEffort).toBe('high');
  });

  it('is latest-wins across multiple turn_context records (independent /model, /effort)', () => {
    writeFileSync(path,
      ev(turnContext({ model: 'gpt-5.6-sol', effort: 'low', ts: '2026-04-29T07:00:00.000Z' }))
      + ev(userResponseItem('switch'))
      + ev(turnContext({ model: 'gpt-5.6-pro', effort: 'xhigh', ts: '2026-04-29T07:01:00.000Z' })));
    const r = drainCodexRollout(path, 0);
    expect(r.latestModel).toBe('gpt-5.6-pro');
    expect(r.latestReasoningEffort).toBe('xhigh');
  });

  it('leaves runtime undefined when no turn_context appears', () => {
    writeFileSync(path, ev(userResponseItem('hi')) + ev(assistantFinalResponseItem('yo')));
    const r = drainCodexRollout(path, 0);
    expect(r.latestModel).toBeUndefined();
    expect(r.latestReasoningEffort).toBeUndefined();
  });

  it('reports runtime only from the newly appended byte range on an incremental drain', () => {
    writeFileSync(path, ev(turnContext({ model: 'gpt-5.6-sol', effort: 'low' })));
    const first = drainCodexRollout(path, 0);
    expect(first.latestReasoningEffort).toBe('low');
    appendFileSync(path,
      ev(userResponseItem('go'))
      + ev(turnContext({ model: 'gpt-5.6-sol', effort: 'xhigh', ts: '2026-04-29T07:02:00.000Z' })));
    const second = drainCodexRollout(path, first.newOffset);
    expect(second.latestReasoningEffort).toBe('xhigh');
  });

  it('binds runtime to its own native final across polling ticks', () => {
    const firstTs = '2026-04-29T07:00:00.000Z';
    const secondTs = '2026-04-29T07:01:00.000Z';
    writeFileSync(path, ev(turnContext({ model: 'gpt-6.1-sol', effort: 'max', ts: firstTs })));
    const first = drainCodexRollout(path, 0);
    appendFileSync(path,
      ev(assistantFinalResponseItem('first reply', firstTs))
      + ev(turnContext({ settingsModel: 'gpt-6.2-sol', settingsEffort: 'low', ts: secondTs }))
      + ev(assistantFinalResponseItem('second reply', secondTs))
      + ev(assistantFinalResponseItem('reply without context')));
    const second = drainCodexRollout(path, first.newOffset, first.state);
    expect(second.events).toMatchObject([
      { text: 'first reply', replyModel: 'gpt-6.1-sol', replyReasoningEffort: 'max' },
      { text: 'second reply', replyModel: 'gpt-6.2-sol', replyReasoningEffort: 'low' },
      { text: 'reply without context' },
    ]);
    expect(second.events[2].replyModel).toBeUndefined();
    expect(second.events[2].replyReasoningEffort).toBeUndefined();
  });
});

describe('readLatestCodexRuntime (attach bootstrap)', () => {
  it('returns {} for a missing / empty rollout', () => {
    expect(readLatestCodexRuntime(join(dir, 'nope.jsonl'))).toEqual({});
    writeFileSync(path, '');
    expect(readLatestCodexRuntime(path)).toEqual({});
  });

  it('reads the newest turn_context model + effort near the tail', () => {
    writeFileSync(path,
      ev(turnContext({ model: 'gpt-5.6-sol', effort: 'low', ts: '2026-04-29T07:00:00.000Z' }))
      + ev(userResponseItem('later'))
      + ev(turnContext({ model: 'gpt-5.6-pro', effort: 'xhigh', ts: '2026-04-29T07:09:00.000Z' })));
    expect(readLatestCodexRuntime(path)).toEqual({ model: 'gpt-5.6-pro', reasoningEffort: 'xhigh' });
  });

  it('excludes a non-newline-terminated trailing partial (crash mid-write)', () => {
    writeFileSync(path,
      ev(turnContext({ model: 'gpt-5.6-sol', effort: 'xhigh' }))
      + JSON.stringify(turnContext({ model: 'half-written', effort: 'garbage' })));
    // The half-written last line has no trailing \n → excluded; the prior
    // complete record wins.
    expect(readLatestCodexRuntime(path)).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
  });
});

describe('codexCotEntriesFromResponseItem (CoT thinking timeline)', () => {
  it('joins multiple summary_text blocks; falls back to reasoning_text when summary is empty', () => {
    expect(codexCotEntriesFromResponseItem({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'a' }, { type: 'summary_text', text: 'b' }],
    })).toEqual([{ kind: 'thinking', text: 'a\n\nb' }]);
    expect(codexCotEntriesFromResponseItem({
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'raw chain of thought' }],
    })).toEqual([{ kind: 'thinking', text: 'raw chain of thought' }]);
  });

  it('truncates oversized function_call arguments with an ellipsis', () => {
    const args = `{"content":"${'x'.repeat(2000)}"}`;
    const [entry] = codexCotEntriesFromResponseItem({ type: 'function_call', name: 'apply_patch', call_id: 'c1', arguments: args });
    expect(entry).toMatchObject({ kind: 'tool_call', id: 'c1', name: 'apply_patch' });
    expect((entry as any).args.length).toBe(601); // 600-char cap + '…'
    expect((entry as any).args.endsWith('…')).toBe(true);
  });

  it('maps local_shell_call and web_search_call to named tool calls', () => {
    expect(codexCotEntriesFromResponseItem({
      type: 'local_shell_call', call_id: 'c2', status: 'completed', action: { type: 'exec', command: ['ls'] },
    })).toEqual([{ kind: 'tool_call', id: 'c2', name: 'shell', args: '{"type":"exec","command":["ls"]}', subject: 'ls' }]);
    expect(codexCotEntriesFromResponseItem({
      type: 'web_search_call', id: 'ws1', action: { query: 'feishu cot' },
    })).toEqual([{ kind: 'tool_call', id: 'ws1', name: 'web_search', args: '{"query":"feishu cot"}', subject: 'feishu cot' }]);
  });

  /**
   * `subject` 在截断之前从原始 arguments / input / action 上取：四种 tool_call
   * 形态各验一条，其中 function_call 的脚本超过 600 字符、args 被截而 subject 完整。
   */
  it('carries the subject taken BEFORE truncation across all four tool_call shapes', () => {
    const script = `echo ${'x'.repeat(695)}`; // 700 chars
    const [fc] = codexCotEntriesFromResponseItem({
      type: 'function_call', name: 'shell', call_id: 'f1',
      arguments: JSON.stringify({ command: ['bash', '-lc', script] }),
    }) as any[];
    expect(fc.args.length).toBe(601);
    expect(fc.subject).toBe(script);

    // custom_tool_call: raw non-JSON string, multi-line collapsed to one line.
    const [ct] = codexCotEntriesFromResponseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'c1',
      input: 'await tools.exec_command({\n  cmd: "free -h"\n})',
    }) as any[];
    expect(ct.subject).toBe('await tools.exec_command({ cmd: "free -h" })');

    // local_shell_call: argv last element, not the joined boilerplate.
    const [ls] = codexCotEntriesFromResponseItem({
      type: 'local_shell_call', call_id: 'l1', action: { type: 'exec', command: ['bash', '-lc', 'pnpm run build'] },
    }) as any[];
    expect(ls.subject).toBe('pnpm run build');

    // apply_patch: first file path in the patch.
    const [ap] = codexCotEntriesFromResponseItem({
      type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1',
      input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch',
    }) as any[];
    expect(ap.subject).toBe('src/a.ts');
  });

  it('keeps a raw (non-wrapped) function_call_output string and maps custom tool calls', () => {
    expect(codexCotEntriesFromResponseItem({ type: 'function_call_output', call_id: 'c1', output: 'plain output' }))
      .toEqual([{ kind: 'tool_result', id: 'c1', result: 'plain output' }]);
    expect(codexCotEntriesFromResponseItem({ type: 'custom_tool_call', name: 'my_tool', call_id: 'c3', input: '{"x":1}' }))
      .toEqual([{ kind: 'tool_call', id: 'c3', name: 'my_tool', args: '{"x":1}' }]);
    expect(codexCotEntriesFromResponseItem({ type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' }))
      .toEqual([{ kind: 'tool_result', id: 'c3', result: 'ok' }]);
  });

  it('returns [] for messages, ghost snapshots and empty outputs', () => {
    expect(codexCotEntriesFromResponseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] })).toEqual([]);
    expect(codexCotEntriesFromResponseItem({ type: 'ghost_snapshot' })).toEqual([]);
    expect(codexCotEntriesFromResponseItem({ type: 'function_call_output', call_id: 'c1', output: '' })).toEqual([]);
    expect(codexCotEntriesFromResponseItem(undefined)).toEqual([]);
  });
});

describe('explicit Codex capacity failures', () => {
  it.each([
    { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' },
    { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
    { code: 'serverOverloaded' },
  ])('recognises the real terminal shape: %j', async error => {
    const { CODEX_CAPACITY_ERROR_CODE, isCodexCapacityError } = await import('../src/services/codex-transcript.js');
    expect(isCodexCapacityError(error)).toBe(true);
    writeFileSync(path, ev({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'capacity', error } }));
    expect(drainCodexRollout(path, 0).events.at(-1)).toMatchObject({ terminalStatus: 'failed', terminalErrorCode: CODEX_CAPACITY_ERROR_CODE });
    // The taxonomy shared by other CLI readers stays unchanged.
    expect(codexTaskFailureCode(error)).toBe(CODEX_UPSTREAM_ERROR_CODE);
  });

  it.each([{ code: 'Overloaded: please retry' }, { message: 'Selected model is at capacity, retry later.' }])('keeps non-exact object payloads out of recovery: %j', async error => {
    const { isCodexCapacityError } = await import('../src/services/codex-transcript.js');
    expect(isCodexCapacityError(error)).toBe(false);
  });

  it.each(['503 Service Unavailable', 'Overloaded: please retry', '429 Too Many Requests', 'gateway timeout'])('does not opt generic %s into capacity recovery', async error => {
    const { isCodexCapacityError } = await import('../src/services/codex-transcript.js');
    expect(isCodexCapacityError(error)).toBe(false);
  });
});

it.each(['401 Unauthorized', '429 Too Many Requests', '400 invalid request'])('a capacity message cannot override %s', async code => {
  const { isCodexCapacityError } = await import('../src/services/codex-transcript.js');
  expect(isCodexCapacityError({ code, message: 'Selected model is at capacity. Please try a different model.' })).toBe(false);
});

describe('a Lark input that never reached Codex does not take the next input\'s reply', () => {
  const at = (sec: number) => `2026-04-29T07:01:${String(sec).padStart(2, '0')}.000Z`;
  const t0 = Date.parse(at(0));
  const taskStarted = (turn: string, sec: number) =>
    ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
  const userRecord = (text: string, sec: number, turn: string, kinds: readonly string[] = ['user.text']) => {
    const item = userResponseItem(text, at(sec));
    return { ...item, payload: { ...item.payload,
      internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: kinds } } };
  };
  const taskComplete = (turn: string, text: string, sec: number) =>
    ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: text } });
  // Codex opens every conversation (fresh, /clear, /new) with this role=user block.
  const agentsMd = (turn: string, sec: number) => userRecord(
    '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n不要继续写到根目录；跑 test 前先 commit。\n</INSTRUCTIONS>',
    sec, turn, ['agents_md.instructions', 'environments.environment_context']);
  // Every Lark wiki link shares its first 30 characters, the attribution fingerprint.
  const wiki = (doc: string, ask: string) => `https://example.feishu.cn/wiki/${doc} ${ask}`;

  function rollout(q: CodexBridgeQueue): (rows: object[]) => void {
    let offset = 0;
    let state: ReturnType<typeof drainCodexRollout>['state'] | undefined;
    writeFileSync(path, '');
    return rows => {
      appendFileSync(path, rows.map(ev).join(''));
      const drained = drainCodexRollout(path, offset, state);
      offset = drained.newOffset;
      state = drained.state;
      q.ingest(drained.events);
    };
  }
  const shape = (q: CodexBridgeQueue) => q.peek().map(turn => ({
    turnId: turn.turnId, started: turn.started, passed: turn.passedBySuccessor === true }));

  it.each([
    ['after its native start', true],
    // The incident shape: after /clear the bridge attached to the new rollout
    // just past task_started, so no start claim ever touched the typo.
    ['attached past its native start', false],
  ] as const)('adopt (%s): a slash typo Codex never submitted is passed; the next input gets its own reply at once', (_name, withStart) => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.beginSubmitVerification('typo', t0);
    q.mark('ask', wiki('AAA', '看看里面的压缩包能不能下载'), t0 + 1000);
    q.beginSubmitVerification('ask', t0 + 1000);
    const feed = rollout(q);

    feed([...(withStart ? [taskStarted('N1', 2)] : []), agentsMd('N1', 3),
      userRecord(wiki('AAA', '看看里面的压缩包能不能下载'), 4, 'N1')]);
    expect(shape(q)).toEqual([
      { turnId: 'ask', started: true, passed: false },
      { turnId: 'typo', started: false, passed: true },
    ]);
    now = t0 + 6000;
    // Nothing is retired while the input that passed it is still running.
    expect(q.pruneExpiredPreStartHeads(now)).toEqual([]);

    feed([taskComplete('N1', 'Downloaded to data/my.', 8)]);
    now = t0 + 9000;
    const ready = q.drainEmittable();
    expect(ready).toMatchObject([{ turnId: 'ask', finalText: 'Downloaded to data/my.' }]);
    expect(ready[0].isLocal).not.toBe(true);
    // The typo keeps nothing busy. It is retired (with its usual notice) once
    // its own submit check can no longer prove it arrived: at once when a
    // native start already settled that check, else when the check runs out.
    expect(q.hasBlockingTurn(now)).toBe(false);
    expect(q.preStartLeaseRemainingMs(now)).toBeUndefined();
    expect(q.pruneExpiredPreStartHeads(now).map(turn => turn.turnId)).toEqual(withStart ? ['typo'] : []);
    now = t0 + STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS + 1;
    expect(q.pruneExpiredPreStartHeads(now).map(turn => turn.turnId)).toEqual(withStart ? [] : ['typo']);
    expect(q.size()).toBe(0);
  });

  it('adopt: of two links with the same opening, only the one whose whole text arrived gets the reply', () => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('lost', wiki('AAA', '看看这个'), t0);
    q.mark('real', wiki('BBB', '下载压缩包'), t0 + 1000);
    rollout(q)([taskStarted('N1', 2), userRecord(wiki('BBB', '下载压缩包'), 3, 'N1'), taskComplete('N1', 'BBB downloaded.', 6)]);
    now = t0 + 7000;
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'real', finalText: 'BBB downloaded.' }]);
    expect(q.pruneExpiredPreStartHeads(now).map(turn => turn.turnId)).toEqual(['lost']);
  });

  it('identical inputs that both arrive still pair in order', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('first', '继续', t0);
    q.mark('second', '继续', t0 + 500);
    rollout(q)([
      taskStarted('N1', 1), userRecord('继续', 2, 'N1'), taskComplete('N1', 'one', 3),
      taskStarted('N2', 4), userRecord('继续', 5, 'N2'), taskComplete('N2', 'two', 6),
    ]);
    expect(q.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([['first', 'one'], ['second', 'two']]);
  });

  it('the AGENTS.md block that opens a conversation does not claim a short message it happens to contain', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('lark', '继续', t0);
    rollout(q)([taskStarted('N1', 1), agentsMd('N1', 2), userRecord('继续', 3, 'N1'), taskComplete('N1', 'continued', 4)]);
    const ready = q.drainEmittable();
    expect(ready).toMatchObject([{ turnId: 'lark', finalText: 'continued' }]);
    expect(ready[0].isLocal).not.toBe(true);
  });

  it('a passed mark claims no later native start and holds no later reply', () => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.beginSubmitVerification('typo', t0);
    q.mark('ask', '帮我看一下这个报错', t0 + 500);
    const feed = rollout(q);
    feed([taskStarted('N1', 1), userRecord('帮我看一下这个报错', 2, 'N1'), taskComplete('N1', 'first answer', 3)]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'ask' }]);

    // The next message arrives before any expiry pass has retired the typo.
    now = t0 + 4000;
    q.mark('next', '再跑一遍测试', now);
    feed([taskStarted('N2', 5)]);
    expect(shape(q)).toEqual([
      { turnId: 'next', started: true, passed: false },
      { turnId: 'typo', started: false, passed: true },
    ]);
    feed([userRecord('再跑一遍测试', 6, 'N2'), taskComplete('N2', 'second answer', 7)]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'next', finalText: 'second answer' }]);
  });

  it('while a passed mark awaits expiry, the next input still owns a record that only matches its fingerprint', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.mark('ask', '帮我看一下这个报错', t0 + 500);
    const feed = rollout(q);
    feed([userRecord('帮我看一下这个报错', 1, 'N1'), taskComplete('N1', 'first answer', 2)]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'ask' }]);

    // Codex recorded this input with its attachment rewritten: the opening
    // still matches, the whole text does not.
    const asked = '请帮我看看这张截图里的报错到底是什么原因造成的，并顺便给出一个可行的修复建议';
    q.mark('next', `${asked} /tmp/botmux/img-1.png`, t0 + 3000);
    feed([userRecord(`${asked} [Image #1]`, 4, 'N2'), taskComplete('N2', 'second answer', 5)]);
    const ready = q.drainEmittable();
    expect(ready).toMatchObject([{ turnId: 'next', finalText: 'second answer' }]);
    expect(ready[0].isLocal).not.toBe(true);
  });

  it('the input queued behind the passed mark keeps the lease refresh it is owed', () => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.mark('ask', '跑一个很长的任务', t0 + 500);
    q.mark('third', '完了再总结一下', t0 + 1000);
    q.confirmPendingTurn('third', t0 + 1000);
    const feed = rollout(q);
    feed([taskStarted('N1', 1), userRecord('跑一个很长的任务', 2, 'N1')]);
    // The long task outlives the queued input's own start lease...
    now = t0 + 60_000;
    feed([taskComplete('N1', 'long task done', 59)]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'ask' }]);
    // ...but its lease restarts at that terminal, so only the typo is retired.
    expect(q.pruneExpiredPreStartHeads(now).map(turn => turn.turnId)).toEqual(['typo']);
    expect(shape(q)).toEqual([{ turnId: 'third', started: false, passed: false }]);
  });

  it('a passed mark is no longer the input a CLI reports holding or the owner of native input', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.mark('ask', '帮我看一下这个报错', t0 + 500);
    const feed = rollout(q);
    feed([taskStarted('N1', 1), userRecord('帮我看一下这个报错', 2, 'N1')]);
    q.mark('third', '完了再总结一下', t0 + 3000);
    q.ingest([{ uuid: 'queued-3', timestampMs: t0 + 3100, kind: 'input_queued', text: '' }]);
    expect(q.peek().find(turn => turn.turnId === 'third')?.cliQueuedAtMs).toBeDefined();
    expect(q.peek().find(turn => turn.turnId === 'typo')?.cliQueuedAtMs).toBeUndefined();
    expect(q.nativeInputOwner('/cleat', t0 + 3200)).toBeUndefined();
  });

  it('non-adopt keeps its buffer: an exact successor behind two dead heads never leaves the session busy', () => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.mark('A', wiki('AAA', '看看这个'), t0);
    q.mark('X', '/never-submitted', t0 + 1000);
    q.mark('B', wiki('BBB', '下载压缩包'), t0 + 2000);
    rollout(q)([taskStarted('N1', 3), userRecord(wiki('BBB', '下载压缩包'), 4, 'N1'), taskComplete('N1', 'answer B', 5)]);
    for (const at of [10, 60, 3600]) {
      now = t0 + at * 1000;
      q.pruneExpiredPreStartHeads(now);
      q.drainEmittable();
    }
    expect(q.hasBlockingTurn(now)).toBe(false);
    expect(q.peek().filter(turn => turn.started && turn.finalText === undefined)).toEqual([]);
  });

  it('a record written before the later mark existed (typed in the terminal) passes nothing', () => {
    const q = new CodexBridgeQueue(() => t0 + 10_000);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.mark('lark', '同一句话', t0 + 5000);
    rollout(q)([userRecord('同一句话', 2, 'N1'), taskComplete('N1', 'terminal answer', 3)]);
    expect(q.drainEmittable()).toMatchObject([{ isLocal: true, finalText: 'terminal answer' }]);
    expect(shape(q)).toEqual([
      { turnId: 'typo', started: false, passed: false },
      { turnId: 'lark', started: false, passed: false },
    ]);
  });

  it('never passes an input whose submit the CLI confirmed', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('confirmed', 'first request', t0);
    q.confirmPendingTurn('confirmed', t0 + 100);
    q.mark('later', 'second request', t0 + 200);
    q.ingest([{ uuid: 'user-2', timestampMs: t0 + 300, kind: 'user', text: 'second request' }]);
    expect(q.peek().find(turn => turn.turnId === 'confirmed')?.passedBySuccessor).toBeUndefined();
    expect(q.peek().find(turn => turn.turnId === 'later')?.started).toBe(false);
  });

  it('a passed mark is retired even when a rolled-back start sits ahead of it', () => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0 + 1000);
    q.mark('ask', 'valid B', t0 + 2000);
    q.mark('next', 'valid C', t0 + 3000);
    const feed = rollout(q);
    now = t0 + 9000;
    feed([taskStarted('B', 4), userRecord('valid B', 5, 'B'), taskComplete('B', 'answer B', 6),
      taskStarted('cancelled', 7), { timestamp: at(8), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'cancelled', reason: 'interrupted' } }]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'ask', finalText: 'answer B' }]);
    // The aborted start put 'next' back ahead of the typo, with a fresh lease;
    // the typo goes now, while 'next' keeps waiting for its own record.
    expect(q.pruneExpiredPreStartHeads(now).map(turn => turn.turnId)).toEqual(['typo']);
    expect(shape(q)).toEqual([{ turnId: 'next', started: false, passed: false }]);
  });

  it('passes nothing for a driver that has not enabled whole-input passing', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.mark('typo', '/cleat', t0);
    q.mark('ask', '帮我看一下这个报错', t0 + 500);
    rollout(q)([userRecord('帮我看一下这个报错', 1, 'N1'), taskComplete('N1', 'answer', 2)]);
    expect(q.drainEmittable()).toMatchObject([{ isLocal: true, finalText: 'answer' }]);
    expect(shape(q).map(turn => turn.passed)).toEqual([false, false]);
  });

  it('passes nothing outside adopt mode even when the driver allows it', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setWholeInputPassing(true);
    q.mark('typo', '/cleat', t0);
    q.mark('ask', '帮我看一下这个报错', t0 + 500);
    rollout(q)([userRecord('帮我看一下这个报错', 1, 'N1')]);
    // Non-adopt keeps its buffer: the record waits for the dead head to expire.
    expect(shape(q)).toEqual([
      { turnId: 'typo', started: false, passed: false },
      { turnId: 'ask', started: false, passed: false },
    ]);
  });

  it('a late positive submit receipt takes a pass back', () => {
    const q = new CodexBridgeQueue(() => t0 + 3000);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('first', 'first request', t0);
    q.beginSubmitVerification('first', t0);
    q.mark('second', 'second request', t0 + 1000);
    q.ingest([{ uuid: 'user-2', timestampMs: t0 + 2000, kind: 'user', text: 'second request' }]);
    expect(q.peek().find(turn => turn.turnId === 'first')?.passedBySuccessor).toBe(true);
    q.confirmPendingTurn('first', t0 + 3000);
    expect(q.peek().find(turn => turn.turnId === 'first')?.passedBySuccessor).toBeUndefined();
    // Confirmed input is owed a start again: it holds the session and its lease.
    expect(q.pruneExpiredPreStartHeads(t0 + 3000)).toEqual([]);
  });

  it('a passed mark whose own record arrives after all gets its own reply', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('first', 'first request', t0);
    q.mark('second', 'second request', t0 + 1000);
    rollout(q)([userRecord('second request', 2, 'N1'), taskComplete('N1', 'second answer', 3),
      userRecord('first request', 4, 'N2'), taskComplete('N2', 'first answer', 5)]);
    expect(q.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([
      ['second', 'second answer'], ['first', 'first answer']]);
  });

  it('a late identical record revives the older passed mark instead of a newer head', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('first', '继续', t0);
    q.mark('passing', 'different input', t0 + 100);
    const feed = rollout(q);
    feed([userRecord('different input', 1, 'N1'), taskComplete('N1', 'passing answer', 2)]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'passing', finalText: 'passing answer' }]);
    expect(shape(q)).toEqual([{ turnId: 'first', started: false, passed: true }]);

    // Deliberately reuse the original mark timestamp: submission order, not a
    // timestamp tie-break or the reordered queue position, must decide ownership.
    q.mark('newer-same-text', '继续', t0);
    feed([
      userRecord('继续', 3, 'N-first-late'), taskComplete('N-first-late', 'first answer', 4),
      userRecord('继续', 5, 'N-newer'), taskComplete('N-newer', 'newer answer', 6),
    ]);
    expect(q.drainEmittable().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
      ['first', 'N-first-late', 'first answer'],
      ['newer-same-text', 'N-newer', 'newer answer'],
    ]);
  });

  it('late quarantine evidence revokes a pass and survives the successor terminal', () => {
    let now = t0;
    const q = new CodexBridgeQueue(() => now);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('parked', 'first request', t0);
    q.beginSubmitVerification('parked', t0);
    q.mark('later', 'second request', t0 + 500);
    const feed = rollout(q);
    feed([userRecord('second request', 1, 'N1')]);
    expect(shape(q).find(turn => turn.turnId === 'parked')?.passed).toBe(true);

    // writeInput can arm quarantine only after the later transcript record has
    // already passed this mark. That new evidence must restore its old lease.
    now = t0 + 2_000;
    q.finishSubmitVerification('parked', now);
    q.setInputDeliveryQuarantined('parked', true);
    feed([taskComplete('N1', 'second answer', 3)]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'later', finalText: 'second answer' }]);
    now = t0 + STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS + 4_000;
    expect(q.pruneExpiredPreStartHeads(now)).toEqual([]);
    expect(q.peek()).toMatchObject([{ turnId: 'parked', passedBySuccessor: undefined, inputDeliveryQuarantined: true }]);
  });

  it('never passes an input the CLI reported it is still holding', () => {
    const q = new CodexBridgeQueue(() => t0);
    q.setLocalTurns(true, t0);
    q.setWholeInputPassing(true);
    q.mark('held', 'first request', t0);
    q.ingest([{ uuid: 'queued-1', timestampMs: t0 + 100, kind: 'input_queued', text: '' }]);
    q.mark('later', 'second request', t0 + 200);
    q.ingest([{ uuid: 'user-2', timestampMs: t0 + 300, kind: 'user', text: 'second request' }]);
    const held = q.peek().find(turn => turn.turnId === 'held');
    expect(held).toMatchObject({ started: false });
    expect(held?.passedBySuccessor).toBeUndefined();
    expect(q.peek().find(turn => turn.turnId === 'later')?.started).toBe(false);
  });
});
