/**
 * Unit tests for Grok updates.jsonl drain + session discovery helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, existsSync,
  openSync, closeSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import {
  drainGrokUpdates,
  isGrokNarrationInterruption,
  matchGrokPromptAppend,
  discoverGrokSessions,
  findGrokSessionByPid,
  grokSessionDirExists,
  grokSessionIdFromPath,
} from '../src/services/grok-transcript.js';
import {
  encodeGrokCwd,
  grokPromptHistoryPath,
  resolveGrokCwdBucketDir,
} from '../src/services/grok-paths.js';

const ROOT = join(tmpdir(), `botmux-grok-test-${process.pid}`);

function writeUpdates(sessionId: string, cwd: string, lines: object[]): string {
  const bucket = encodeURIComponent(cwd);
  const dir = join(ROOT, 'sessions', bucket, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'updates.jsonl');
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    info: { id: sessionId, cwd },
    generated_title: 'Test session',
    updated_at: new Date().toISOString(),
  }));
  return path;
}

function userChunk(sessionId: string, text: string, eventId: string, ts = 1_000_000) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function agentChunk(sessionId: string, text: string, eventId: string, ts = 1_000_100) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function hookExecution(sessionId: string, eventName: string, eventId: string, ts = 1_000_180) {
  return {
    timestamp: ts,
    method: '_x.ai/session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'hook_execution',
        event_name: eventName,
        runs: [],
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function passiveUpdate(sessionId: string, sessionUpdate: string, eventId: string, ts = 1_000_180) {
  return {
    timestamp: ts,
    method: '_x.ai/session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate,
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function turnDone(
  sessionId: string,
  eventId: string,
  ts = 1_000_200,
  stopReason = 'end_turn',
  opts?: { cancelTrigger?: string; metaOn?: 'update' | 'params' | 'split' },
) {
  const update: Record<string, unknown> = {
    sessionUpdate: 'turn_completed',
    stop_reason: stopReason,
  };
  const params: Record<string, unknown> = { sessionId, update };
  const metaOn = opts?.metaOn ?? 'update';
  if (metaOn === 'split') {
    update._meta = { eventId, agentTimestampMs: ts };
    params._meta = opts?.cancelTrigger ? { cancelTrigger: opts.cancelTrigger } : {};
  } else {
    const meta: Record<string, unknown> = { eventId, agentTimestampMs: ts };
    if (opts?.cancelTrigger) meta.cancelTrigger = opts.cancelTrigger;
    if (metaOn === 'params') params._meta = meta;
    else update._meta = meta;
  }
  return {
    timestamp: ts,
    method: metaOn === 'update' ? 'session/update' : '_x.ai/session/update',
    params,
  };
}

function toolCall(sessionId: string, eventId: string, ts = 1_000_150) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `call-${eventId}`,
        title: 'run_terminal_command',
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function promptHistoryLine(sessionId: string, prompt: string, ts = '2026-07-12T10:00:00Z') {
  return { timestamp: ts, session_id: sessionId, prompt, is_bash: false };
}

describe('drainGrokUpdates', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('emits public narration and completed tools without making them final or exposing thoughts', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const call = toolCall(sid, 'read');
    Object.assign(call.params.update, { rawInput: { target_file: 'README.md' } });
    const event = (update: object) => ({ params: { sessionId: sid, update } });
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'inspect the project', 'user'),
      agentChunk(sid, 'Reading ', 'a1'), agentChunk(sid, 'the README.', 'a2'),
      event({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } }),
      call,
      event({ sessionUpdate: 'tool_call_update', toolCallId: 'call-read', title: 'Read', rawInput: { target_file: 'README.md' } }),
      event({ sessionUpdate: 'tool_call_update', toolCallId: 'call-read', status: 'in_progress', rawOutput: 'partial' }),
      event({ sessionUpdate: 'tool_call_update', toolCallId: 'call-read', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Project documentation' } }], rawOutput: { internal: 'not shown' } }),
      agentChunk(sid, 'Final summary.', 'final'), turnDone(sid, 'done'),
    ]);
    const legacy = drainGrokUpdates(path, 0);
    expect(legacy.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    const result = drainGrokUpdates(path, 0, { includePublicActivity: true });
    expect(result.events.map(e => e.kind)).toEqual(['user', 'cot', 'cot', 'cot', 'assistant_final']);
    expect(result.events.filter(e => e.kind === 'cot').flatMap(e => e.cotEntries ?? [])).toEqual([
      { kind: 'text', text: 'Reading the README.' },
      { kind: 'tool_call', id: 'call-read', name: 'run_terminal_command', args: '{"target_file":"README.md"}', subject: 'README.md' },
      { kind: 'tool_result', id: 'call-read', result: 'Project documentation' },
    ]);
    expect(result.events.at(-1)).toEqual(legacy.events.at(-1));
    expect(result.events.every(e => e.sourceSessionId === sid)).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain('private reasoning');
    expect(JSON.stringify(result.events)).not.toContain('partial');
    expect(JSON.stringify(result.events)).not.toContain('not shown');
  });

  it('retains stable narration identities across partial polls and consumes tool activity only once', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [userChunk(sid, 'inspect', 'user'), agentChunk(sid, 'Checking.', 'a')]);
    const first = drainGrokUpdates(path, 0, { includePublicActivity: true });
    expect(first.events.map(e => e.kind)).toEqual(['user']);
    appendFileSync(path, JSON.stringify(toolCall(sid, 'tool')) + '\n');
    const next = drainGrokUpdates(path, first.newOffset, { includePublicActivity: true });
    expect(next.events.map(e => e.kind)).toEqual(['cot', 'cot']);
    expect(next.events).toEqual(drainGrokUpdates(path, first.newOffset, { includePublicActivity: true }).events);
    expect(drainGrokUpdates(path, next.newOffset, { includePublicActivity: true }).events).toEqual([]);
    appendFileSync(path, JSON.stringify(agentChunk(sid, 'Done.', 'f')) + '\n' + JSON.stringify(turnDone(sid, 'done')) + '\n');
    const final = drainGrokUpdates(path, next.newOffset, { includePublicActivity: true });
    expect(final.events).toHaveLength(1);
    expect(final.events[0]).toMatchObject({ kind: 'assistant_final', text: 'Done.', terminalStatus: 'completed' });
  });

  it.each(['stop', 'stop_failure'])('keeps %s final text out of public activity', hook => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'inspect', 'user'), agentChunk(sid, 'Full final answer.', 'answer'),
      hookExecution(sid, hook, 'hook'), turnDone(sid, 'done'),
    ]);
    const result = drainGrokUpdates(path, 0, { includePublicActivity: true });
    expect(result.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(result.events.at(-1)).toMatchObject({ text: 'Full final answer.', terminalStatus: 'completed' });
    expect(result.events).toEqual(drainGrokUpdates(path, 0).events);
    expect(result.newOffset).toBe(statSync(path).size);
  });

  it('retains final chunks across stop_failure and passive events with public activity enabled', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'inspect', 'user'), agentChunk(sid, 'First part, ', 'a1'),
      hookExecution(sid, 'stop_failure', 'hook'),
      passiveUpdate(sid, 'background_tasks', 'background'),
      passiveUpdate(sid, 'memory_dream_completed', 'memory'),
      passiveUpdate(sid, 'auto_compact_completed', 'compact'),
      agentChunk(sid, 'second part.', 'a2'), turnDone(sid, 'done'),
    ]);
    const result = drainGrokUpdates(path, 0, { includePublicActivity: true });
    expect(result.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(result.events.at(-1)).toMatchObject({ text: 'First part, second part.', terminalStatus: 'completed' });
  });

  it('reports background task launches and stops without touching the buffered reply', () => {
    // Record shapes as Grok 1.x writes them (command / cwd / output paths omitted).
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const bg = (update: Record<string, unknown>, eventId: string, ts: number) => ({
      timestamp: Math.floor(ts / 1000),
      method: '_x.ai/session/update',
      params: { sessionId: sid, update, _meta: { eventId, agentTimestampMs: ts } },
    });
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'run it in the background', 'user'),
      agentChunk(sid, 'Started ', 'a1'),
      bg({ sessionUpdate: 'task_backgrounded', tool_call_id: 'call-1', task_id: 'call-1' }, 'launch', 1_000_110),
      bg({ sessionUpdate: 'task_backgrounded', tool_call_id: 'call-2', task_id: 'call-2', monitor_description: 'watch CI' }, 'launch-2', 1_000_115),
      bg({ sessionUpdate: 'background_tasks', tasks: [
        { task_id: 'call-1', kind: 'bash', status: 'running', started_at: '2026-09-18T00:00:32Z' },
        { task_id: 'call-2', kind: 'monitor', status: 'running', started_at: '2026-09-18T00:00:33Z' },
        { task_id: 'call-0', kind: 'bash', status: 'completed', started_at: '2026-09-18T00:00:01Z' },
      ] }, 'list', 1_000_120),
      agentChunk(sid, 'it.', 'a2'),
      turnDone(sid, 'done'),
    ]);
    const first = drainGrokUpdates(path, 0, { includePublicActivity: true });
    expect(first.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(first.events.at(-1)).toMatchObject({ text: 'Started it.' });
    expect(first.backgroundTasks).toEqual({
      launched: [
        { taskId: 'call-1', kind: 'shell', atMs: 1_000_110 },
        { taskId: 'call-2', kind: 'monitor', atMs: 1_000_115 },
        { taskId: 'call-1', kind: 'shell', atMs: 1_000_120 },
        { taskId: 'call-2', kind: 'monitor', atMs: 1_000_120 },
      ],
      settled: ['call-0'],
    });

    appendFileSync(path, [
      bg({ sessionUpdate: 'task_completed', task_snapshot: { task_id: 'call-1', kind: 'bash', exit_code: 0, is_backgrounded: true }, will_wake: true }, 'done-1', 1_000_300),
      bg({ sessionUpdate: 'background_tasks', tasks: [
        { task_id: 'call-1', kind: 'bash', status: 'completed' },
        { task_id: 'call-2', kind: 'monitor', status: 'running' },
      ] }, 'list-2', 1_000_301),
    ].map(line => JSON.stringify(line)).join('\n') + '\n');
    const second = drainGrokUpdates(path, first.newOffset, { includePublicActivity: true });
    expect(second.events).toEqual([]);
    expect(second.backgroundTasks).toEqual({
      launched: [{ taskId: 'call-2', kind: 'monitor', atMs: 1_000_301 }],
      settled: ['call-1', 'call-1'],
    });
    // A range with no background records carries no field at all.
    expect(drainGrokUpdates(path, second.newOffset).backgroundTasks).toBeUndefined();
  });

  it.each(['pre_tool_use', 'post_tool_use', 'post_tool_use_failure', 'session_end'])(
    'emits interrupted narration once and releases its cursor on %s', hook => {
      const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const path = writeUpdates(sid, '/tmp/proj', [
        userChunk(sid, 'inspect', 'user'), agentChunk(sid, 'Checking.', 'narration'),
        hookExecution(sid, hook, 'hook'),
      ]);
      const result = drainGrokUpdates(path, 0, { includePublicActivity: true });
      expect(result.events.map(e => e.kind)).toEqual(['user', 'cot']);
      expect(result.events[1]).toMatchObject({ sourceSessionId: sid, cotEntries: [{ kind: 'text', text: 'Checking.' }] });
      expect(result.newOffset).toBe(statSync(path).size);
      expect(drainGrokUpdates(path, result.newOffset, { includePublicActivity: true }).events).toEqual([]);
      if (hook !== 'session_end') {
        appendFileSync(path, JSON.stringify(turnDone(sid, 'done')) + '\n');
        expect(drainGrokUpdates(path, result.newOffset, { includePublicActivity: true }).events)
          .toMatchObject([{ kind: 'assistant_final', text: '', terminalStatus: 'completed' }]);
      }
    },
  );

  it('delivers complete narration to the queue once across passive events and partial polls', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'inspect', 'user'), agentChunk(sid, 'Checking ', 'a1'),
      hookExecution(sid, 'stop', 'stop'),
    ]);
    const queue = new CodexBridgeQueue();
    const narration: string[] = [];
    queue.setCotObserver(entries => {
      for (const entry of entries) if (entry.kind === 'text') narration.push(entry.text);
    });
    queue.mark('om_test', 'inspect', 100);
    const first = drainGrokUpdates(path, 0, { includePublicActivity: true });
    queue.ingest(first.events);
    expect(first.events.map(e => e.kind)).toEqual(['user']);
    expect(first.newOffset).toBe(Buffer.byteLength(JSON.stringify(userChunk(sid, 'inspect', 'user')) + '\n'));
    appendFileSync(path, [
      passiveUpdate(sid, 'background_tasks', 'background'), agentChunk(sid, 'the project.', 'a2'),
      hookExecution(sid, 'pre_tool_use', 'pre-tool'), toolCall(sid, 'tool'),
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const next = drainGrokUpdates(path, first.newOffset, { includePublicActivity: true });
    queue.ingest(next.events);
    queue.ingest(next.events);
    expect(narration).toEqual(['Checking the project.']);
    expect(queue.drainEmittable()).toEqual([]);
    appendFileSync(path, [agentChunk(sid, 'Done.', 'final'), hookExecution(sid, 'stop', 'last-stop'), turnDone(sid, 'done')]
      .map(e => JSON.stringify(e)).join('\n') + '\n');
    queue.ingest(drainGrokUpdates(path, next.newOffset, { includePublicActivity: true }).events);
    expect(narration).toEqual(['Checking the project.']);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_test', finalText: 'Done.' }]);
  });

  it('preserves failed tool output without converting it into a turn terminal', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [userChunk(sid, 'run a check', 'user'), toolCall(sid, 'tool'),
      { params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-tool', status: 'failed', rawOutput: { error: 'command failed' } } } },
    ]);
    const result = drainGrokUpdates(path, 0, { includePublicActivity: true });
    expect(result.events.at(-1)).toMatchObject({ kind: 'cot', cotEntries: [{ kind: 'tool_result', id: 'call-tool', result: '{"error":"command failed"}' }] });
    expect(result.events.some(e => e.kind === 'assistant_final')).toBe(false);
  });

  it.each(['content', 'raw-string', 'raw-object'] as const)('bounds oversized %s tool output before it leaves the reader', source => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const large = 'x'.repeat(200_000);
    const output = source === 'raw-object' ? { output: large } : large;
    const path = writeUpdates(sid, '/tmp/proj', [userChunk(sid, 'inspect', 'user'),
      { params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'read-large', title: 'Read', rawInput: { target_file: 'README.md', extra: large } } } },
      { params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'read-large', status: 'completed',
        ...(source === 'content' ? { content: [{ type: 'content', content: { type: 'text', text: large } }], rawOutput: 'unused fallback' } : { rawOutput: output }),
      } } }, agentChunk(sid, 'Full final answer.', 'final'), turnDone(sid, 'done'),
    ]);
    const events = drainGrokUpdates(path, 0, { includePublicActivity: true }).events;
    const entries = events.flatMap(e => e.cotEntries ?? []);
    const call = entries.find(e => e.kind === 'tool_call');
    const result = entries.find(e => e.kind === 'tool_result');
    expect(call).toMatchObject({ kind: 'tool_call', subject: 'README.md' });
    expect(call?.kind === 'tool_call' && call.args.length).toBeLessThanOrEqual(601);
    const original = source === 'raw-object' ? JSON.stringify(output) : large;
    expect(result).toEqual({ kind: 'tool_result', id: 'read-large', result: `${original.slice(0, 800)}…` });
    expect(events.at(-1)).toMatchObject({ kind: 'assistant_final', text: 'Full final answer.' });
  });

  it('attributes public activity once to the matching native turn without settling on a tool', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [userChunk(sid, 'inspect', 'user'), agentChunk(sid, 'Checking.', 'a'), toolCall(sid, 'tool')]);
    const events = drainGrokUpdates(path, 0, { includePublicActivity: true }).events;
    const queue = new CodexBridgeQueue();
    const seen: string[] = [];
    queue.setCotObserver((_entries, turn) => seen.push(turn.turnId));
    queue.ingest(events.filter(e => e.kind === 'cot').map(e => ({ ...e, uuid: `history:${e.uuid}` })));
    expect(seen).toEqual([]);
    queue.mark('om_test', 'inspect', 100);
    queue.ingest(events);
    queue.ingest(events);
    expect(seen).toEqual(['om_test', 'om_test']);
    expect(queue.drainEmittable()).toEqual([]);
    queue.ingest([{ ...events[1], uuid: 'wrong-session', sourceSessionId: 'another-native-session' }]);
    expect(seen).toHaveLength(2);
    appendFileSync(path, JSON.stringify(agentChunk(sid, 'Done.', 'f')) + '\n' + JSON.stringify(turnDone(sid, 'done')) + '\n');
    queue.ingest(drainGrokUpdates(path, 0, { includePublicActivity: true }).events);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_test', finalText: 'Done.' }]);
    queue.ingest([{ ...events[1], uuid: 'after-final' }]);
    expect(seen).toHaveLength(2);
  });

  it('retires a merged Grok input without manufacturing an earlier final', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'first request', 'u1'),
      userChunk(sid, 'follow-up', 'u2', 1_000_050),
      agentChunk(sid, 'Combined answer.', 'final'), turnDone(sid, 'done'),
    ]);
    const queue = new CodexBridgeQueue();
    const superseded: string[] = [];
    queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
    queue.mark('om_first', 'first request', 100);
    queue.mark('om_second', 'follow-up', 200);
    queue.ingest(drainGrokUpdates(path, 0, { includePublicActivity: true }).events);
    expect(superseded).toEqual(['om_first']);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_second', finalText: 'Combined answer.' }]);
    expect(queue.drainEmittable()).toEqual([]);
  });

  it('emits user + assistant_final for a completed turn', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'hello world', 'e1'),
      agentChunk(sid, 'Hi ', 'e2'),
      agentChunk(sid, 'there', 'e3'),
      turnDone(sid, 'e4'),
    ]);
    const r = drainGrokUpdates(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ kind: 'user', text: 'hello world', sourceSessionId: sid });
    expect(r.events[1]).toMatchObject({
      kind: 'assistant_final', text: 'Hi there', sourceSessionId: sid, terminalStatus: 'completed',
    });
  });

  it('rewinds offset when turn is still open (no turn_completed yet)', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q1', 'e1'),
      agentChunk(sid, 'partial', 'e2'),
    ]);
    const r = drainGrokUpdates(path, 0);
    // user emitted; agent buffered → offset rewound to first agent line
    expect(r.events.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
    expect(r.newOffset).toBeGreaterThan(0);
    // re-drain from newOffset still has no final
    const r2 = drainGrokUpdates(path, r.newOffset);
    expect(r2.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
  });

  it('emits only the LAST agent-message group as assistant_final (codex final_answer parity)', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'do the thing', 'e1'),
      // Progress narration before a tool call — must NOT reach Lark.
      agentChunk(sid, '先跑一下测试。', 'e2'),
      toolCall(sid, 'e3'),
      // Another narration group between tools.
      agentChunk(sid, '测试通过，', 'e4'),
      agentChunk(sid, '开始改代码。', 'e5'),
      toolCall(sid, 'e6'),
      // Final answer group (streams in two chunks).
      agentChunk(sid, '改完了：', 'e7'),
      agentChunk(sid, '一切正常。', 'e8'),
      turnDone(sid, 'e9'),
    ]);
    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('改完了：一切正常。');
  });

  it('still converges when a tool-only stretch follows a narration group', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'narration', 'e2'),
      toolCall(sid, 'e3'),
      toolCall(sid, 'e4'),
    ]);
    // Narration is dropped on the first tool_call; offset advances past the
    // tool stretch (no rewind pin) so long tool runs stay cheap to poll.
    const r1 = drainGrokUpdates(path, 0);
    expect(r1.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
    expect(r1.newOffset).toBeGreaterThan(0);
    // Turn completes with a fresh final group appended later.
    appendFileSync(path, JSON.stringify(agentChunk(sid, 'final', 'e5', 1_000_180)) + '\n');
    appendFileSync(path, JSON.stringify(turnDone(sid, 'e6')) + '\n');
    const r2 = drainGrokUpdates(path, r1.newOffset);
    const finals = r2.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('final');
  });

  it('emits an empty completed terminal without leaking narration when no post-tool final exists', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'looking at files…', 'e2'),
      toolCall(sid, 'e3'),
      toolCall(sid, 'e4'),
      // Model ends the turn without a further agent_message_chunk.
      turnDone(sid, 'e5'),
    ]);
    const r = drainGrokUpdates(path, 0);
    expect(r.events.filter((e) => e.kind === 'user')).toHaveLength(1);
    // Prefer empty over posting mid-turn chatter as the Lark fallback, but the
    // authoritative boundary must still release an exact durable turn.
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toEqual([
      expect.objectContaining({
        kind: 'assistant_final', text: '', sourceSessionId: sid, terminalStatus: 'completed',
      }),
    ]);
  });

  it.each([
    ['error', 'failed', 'grok_turn_error', 'turn error'],
    ['cancelled', 'failed', 'grok_turn_cancelled', 'turn cancelled'],
    ['future reason', 'failed', 'grok_stop_reason:future_reason', 'stop reason: future_reason'],
  ] as const)('maps %s turn_completed to %s even with an empty final', (reason, status, errorCode, summary) => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      turnDone(sid, 'e2', 1_000_200, reason),
    ]);

    const r = drainGrokUpdates(path, 0);

    expect(r.events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'q', sourceSessionId: sid }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: '',
        sourceSessionId: sid,
        terminalStatus: status,
        terminalErrorCode: errorCode,
        terminalErrorSummary: summary,
      }),
    ]);
  });

  it.each([
    ['params'] as const,
    ['update'] as const,
  ])('maps cancelled + send_now on %s._meta to ambiguous', (metaOn) => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      turnDone(sid, 'e2', 1_000_200, 'cancelled', { cancelTrigger: 'send_now', metaOn }),
    ]);

    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');

    expect(finals).toEqual([
      expect.objectContaining({
        kind: 'assistant_final',
        text: '',
        sourceSessionId: sid,
        terminalStatus: 'ambiguous',
        terminalErrorCode: 'grok_turn_cancelled',
      }),
    ]);
    expect(finals[0]).not.toHaveProperty('terminalErrorSummary');
  });

  it('drops buffered agent text when cancelled by send_now', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'partial answer already streamed', 'e2'),
      turnDone(sid, 'e3', 1_000_200, 'cancelled', { cancelTrigger: 'send_now', metaOn: 'params' }),
    ]);

    const r = drainGrokUpdates(path, 0);
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toEqual([
      expect.objectContaining({
        kind: 'assistant_final',
        text: '',
        sourceSessionId: sid,
        terminalStatus: 'ambiguous',
        terminalErrorCode: 'grok_turn_cancelled',
      }),
    ]);
  });

  it('reads cancelTrigger from params._meta when update._meta has no trigger', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      turnDone(sid, 'e2', 1_000_200, 'cancelled', { cancelTrigger: 'send_now', metaOn: 'split' }),
    ]);

    const r = drainGrokUpdates(path, 0);
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toEqual([
      expect.objectContaining({
        kind: 'assistant_final',
        text: '',
        terminalStatus: 'ambiguous',
        terminalErrorCode: 'grok_turn_cancelled',
      }),
    ]);
  });

  it('does not rewind across a long tool stretch after dropping narration', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const lines: object[] = [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'narration', 'e2'),
    ];
    // Simulate a heavy tool phase (real turns can have hundreds of updates).
    for (let i = 0; i < 50; i++) lines.push(toolCall(sid, `t${i}`, 1_000_150 + i));
    const path = writeUpdates(sid, '/tmp/proj', lines);
    const r1 = drainGrokUpdates(path, 0);
    // Offset should sit at EOF (no open agent group to pin).
    const size = statSync(path).size;
    expect(r1.newOffset).toBe(size);
    // Incremental poll from that offset sees only the new final group.
    appendFileSync(path, JSON.stringify(agentChunk(sid, 'done', 'f1', 1_000_300)) + '\n');
    appendFileSync(path, JSON.stringify(turnDone(sid, 'f2', 1_000_301)) + '\n');
    const r2 = drainGrokUpdates(path, r1.newOffset);
    expect(r2.events.filter((e) => e.kind === 'assistant_final').map((e) => e.text)).toEqual(['done']);
  });

  it('does not advance offset on a pure partial-line window (no trailing \\n yet)', () => {
    // Grok mid-flush of a long JSONL line: poll sees bytes but no newline.
    // Advancing by 1 would desync the next poll and drop the finished event.
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const dir = join(ROOT, 'sessions', encodeURIComponent('/tmp/proj'), sid);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'updates.jsonl');
    const half = JSON.stringify(userChunk(sid, 'hello world', 'e1')).slice(0, 40);
    writeFileSync(path, half); // no trailing \n
    const r1 = drainGrokUpdates(path, 0);
    expect(r1.events).toHaveLength(0);
    expect(r1.newOffset).toBe(0);
    expect(r1.pendingTail).toBe(half);

    // Finish the line; next drain from the same offset must see the full event.
    writeFileSync(path, JSON.stringify(userChunk(sid, 'hello world', 'e1')) + '\n');
    const r2 = drainGrokUpdates(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]).toMatchObject({ kind: 'user', text: 'hello world' });
  });

  it('preserves final agent text when followed by hook_execution stop before turn_completed', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, '请注册 Agent', 'e1'),
      agentChunk(sid, '目前还没有你的字节邮箱，请确认。', 'e2'),
      hookExecution(sid, 'stop', 'e3'),
      turnDone(sid, 'e4'),
    ]);
    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('目前还没有你的字节邮箱，请确认。');
  });

  it('preserves agent text when hook_execution stop is interleaved between chunks', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, '第一部分，', 'e2'),
      hookExecution(sid, 'stop', 'e3'),
      agentChunk(sid, '第二部分。', 'e4'),
      turnDone(sid, 'e5'),
    ]);
    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('第一部分，第二部分。');
  });

  it('drops narration when followed by hook_execution pre_tool_use and tool_call', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, '先查一下记录。', 'e2'),
      hookExecution(sid, 'pre_tool_use', 'e3'),
      toolCall(sid, 'e4'),
      agentChunk(sid, '这是最终回复。', 'e5'),
      hookExecution(sid, 'stop', 'e6'),
      turnDone(sid, 'e7'),
    ]);
    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('这是最终回复。');
  });

  it('does not drop agent text on passive background updates before turn_completed', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, '已处理完成。', 'e2'),
      passiveUpdate(sid, 'background_tasks', 'e3'),
      turnDone(sid, 'e4'),
    ]);
    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('已处理完成。');
  });

  it('drops unfinished agent text on session_end and advances offset to avoid pinning', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, '未完成的一半回答...', 'e2'),
      hookExecution(sid, 'session_end', 'e3'),
    ]);
    const r = drainGrokUpdates(path, 0);
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
    const size = statSync(path).size;
    expect(r.newOffset).toBe(size);
  });
});

describe('isGrokNarrationInterruption', () => {
  it('returns true for tool calls, thoughts, and plans', () => {
    expect(isGrokNarrationInterruption({ sessionUpdate: 'tool_call' })).toBe(true);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'tool_call_update' })).toBe(true);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'agent_thought_chunk' })).toBe(true);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'plan' })).toBe(true);
  });

  it('returns true for tool execution hooks and session_end', () => {
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'pre_tool_use' })).toBe(true);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'post_tool_use' })).toBe(true);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'post_tool_use_failure' })).toBe(true);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'session_end' })).toBe(true);
  });

  it('returns false for turn lifecycle hooks and passive updates', () => {
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'stop' })).toBe(false);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'stop_failure' })).toBe(false);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'session_start' })).toBe(false);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit' })).toBe(false);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'background_tasks' })).toBe(false);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'memory_dream_completed' })).toBe(false);
    expect(isGrokNarrationInterruption({ sessionUpdate: 'auto_compact_completed' })).toBe(false);
  });
});

describe('matchGrokPromptAppend', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  function writePromptHistory(cwd: string, lines: object[]): string {
    const dir = join(ROOT, 'sessions', encodeURIComponent(cwd));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'prompt_history.jsonl');
    writeFileSync(path, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return path;
  }

  it('finds a newly appended submit and returns its session id', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writePromptHistory('/tmp/proj', [
      promptHistoryLine(sid, 'old prompt'),
    ]);
    const base = statSync(path).size;
    appendFileSync(path, JSON.stringify(promptHistoryLine(sid, 'fresh botmux prompt xyz')) + '\n');
    const hit = matchGrokPromptAppend(path, base, 'fresh botmux prompt xyz');
    expect(hit).toEqual({ found: true, cliSessionId: sid });
    // Lines before the baseline must not match.
    expect(matchGrokPromptAppend(path, base, 'old prompt').found).toBe(false);
  });

  it('matches multi-line prompts verbatim (composer soft newlines)', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writePromptHistory('/tmp/proj', []);
    const content = 'first line\nsecond line';
    appendFileSync(path, JSON.stringify(promptHistoryLine(sid, content)) + '\n');
    expect(matchGrokPromptAppend(path, 0, content).found).toBe(true);
    expect(matchGrokPromptAppend(path, 0, 'first line\r\nsecond line').found).toBe(true);
    expect(matchGrokPromptAppend(path, 0, 'unrelated').found).toBe(false);
  });

  it('does not cross-claim when two sessions append the same prompt (preferSessionId)', () => {
    const sidA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const sidB = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writePromptHistory('/tmp/shared-proj', []);
    const prompt = '继续';
    // Worker A and B both submit the same text into the shared cwd bucket.
    appendFileSync(path, JSON.stringify(promptHistoryLine(sidA, prompt)) + '\n');
    appendFileSync(path, JSON.stringify(promptHistoryLine(sidB, prompt)) + '\n');

    // Without binding: ambiguous → fail closed (never hand B's sid to A).
    expect(matchGrokPromptAppend(path, 0, prompt).found).toBe(false);

    // With prefer: each worker claims only its own line.
    expect(matchGrokPromptAppend(path, 0, prompt, { preferSessionId: sidA }))
      .toEqual({ found: true, cliSessionId: sidA });
    expect(matchGrokPromptAppend(path, 0, prompt, { preferSessionId: sidB }))
      .toEqual({ found: true, cliSessionId: sidB });

    // Prefer a sid that has not appended yet → not found (keep polling).
    expect(matchGrokPromptAppend(path, 0, prompt, {
      preferSessionId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }).found).toBe(false);
  });
});

describe('resolveGrokCwdBucketDir / hashed buckets', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('prefers the normal encoded bucket when present', () => {
    const cwd = '/tmp/short-proj';
    const encoded = encodeGrokCwd(cwd);
    mkdirSync(join(ROOT, 'sessions', encoded), { recursive: true });
    expect(resolveGrokCwdBucketDir(cwd)).toBe(join(ROOT, 'sessions', encoded));
  });

  it('locates a hashed bucket via .cwd when encoded name would exceed 255 bytes', () => {
    // CJK path: percent-encoding balloons past 255 bytes easily.
    const cwd = '/tmp/' + '测'.repeat(90);
    expect(Buffer.byteLength(encodeGrokCwd(cwd), 'utf8')).toBeGreaterThan(255);

    const hashBucket = 'ce-shi-a1b2c3d4'; // fake slug+hash; only .cwd content matters
    const bucketDir = join(ROOT, 'sessions', hashBucket);
    mkdirSync(bucketDir, { recursive: true });
    writeFileSync(join(bucketDir, '.cwd'), cwd + '\n');
    writeFileSync(join(bucketDir, 'prompt_history.jsonl'), '');

    expect(resolveGrokCwdBucketDir(cwd)).toBe(bucketDir);
    // prompt_history must resolve through the hashed bucket — not the
    // non-existent encoded path that would ENAMETOOLONG / miss the file.
    expect(grokPromptHistoryPath(cwd)).toBe(join(bucketDir, 'prompt_history.jsonl'));
    expect(existsSync(grokPromptHistoryPath(cwd))).toBe(true);
  });

  it('does not bind a hashed bucket whose .cwd points at a different path', () => {
    const cwd = '/tmp/' + '路'.repeat(90);
    const other = '/tmp/other-long-' + '径'.repeat(80);
    const hashBucket = 'other-hash-ffff';
    mkdirSync(join(ROOT, 'sessions', hashBucket), { recursive: true });
    writeFileSync(join(ROOT, 'sessions', hashBucket, '.cwd'), other);
    // No matching bucket → fall back to preferred encoded path (may not exist).
    expect(resolveGrokCwdBucketDir(cwd)).toBe(join(ROOT, 'sessions', encodeGrokCwd(cwd)));
  });
});

describe('grokSessionDirExists / grokSessionIdFromPath', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('detects an existing session dir in the cwd bucket and in other buckets', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    mkdirSync(join(ROOT, 'sessions', encodeURIComponent('/tmp/proj'), sid), { recursive: true });
    expect(grokSessionDirExists(sid, '/tmp/proj')).toBe(true);
    expect(grokSessionDirExists(sid, '/tmp/other')).toBe(true); // cross-bucket scan
    expect(grokSessionDirExists('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', '/tmp/proj')).toBe(false);
    expect(grokSessionDirExists('not-a-uuid', '/tmp/proj')).toBe(false);
  });

  it('extracts the session id from an updates.jsonl path under a custom GROK_HOME', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const p = join(ROOT, 'sessions', encodeURIComponent('/tmp/proj'), sid, 'updates.jsonl');
    expect(grokSessionIdFromPath(p)).toBe(sid);
    expect(grokSessionIdFromPath(`/home/u/.grok/sessions/%2Ftmp/${sid}/updates.jsonl`)).toBe(sid);
    expect(grokSessionIdFromPath('/somewhere/else.jsonl')).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'linux')('findGrokSessionByPid rotation', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('prefers the newest open updates stream when /new briefly retains both sessions', () => {
    const oldSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const newSid = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const oldPath = writeUpdates(oldSid, '/tmp/proj', [userChunk(oldSid, 'old', 'e1')]);
    const newPath = writeUpdates(newSid, '/tmp/proj', [userChunk(newSid, 'new', 'e2')]);
    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-01-01T00:00:05Z');
    utimesSync(oldPath, oldTime, oldTime);
    utimesSync(newPath, newTime, newTime);
    const oldFd = openSync(oldPath, 'r');
    const newFd = openSync(newPath, 'r');
    try {
      expect(findGrokSessionByPid(process.pid)).toEqual({
        sessionId: newSid,
        updatesPath: newPath,
      });
    } finally {
      closeSync(newFd);
      closeSync(oldFd);
    }
  });
});

describe('discoverGrokSessions', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('lists external sessions and hides botmux-injected ones', async () => {
    const external = '11111111-1111-4111-8111-111111111111';
    const botmux = '22222222-2222-4222-8222-222222222222';
    writeUpdates(external, '/tmp/a', [
      userChunk(external, 'raw external prompt', 'e1'),
      agentChunk(external, 'ok', 'e2'),
      turnDone(external, 'e3'),
    ]);
    writeUpdates(botmux, '/tmp/b', [
      userChunk(botmux, '<user_message>from lark</user_message><botmux_routing>x</botmux_routing>', 'e1'),
    ]);
    const out = await discoverGrokSessions(10);
    expect(out.map((s) => s.cliSessionId)).toContain(external);
    expect(out.map((s) => s.cliSessionId)).not.toContain(botmux);
    expect(out.find((s) => s.cliSessionId === external)?.cwd).toBe('/tmp/a');
  });

  it('keeps external prompts that merely discuss botmux tags (structural filter only)', async () => {
    const discuss = '33333333-3333-4333-8333-333333333333';
    // Real botmux envelope: whole turn IS the structural wrapper.
    const botmuxReal = '44444444-4444-4444-8444-444444444444';
    writeUpdates(discuss, '/tmp/c', [
      userChunk(discuss, 'explain why <user_message>…</user_message> and <botmux_routing> appear in the transcript', 'e1'),
    ]);
    writeUpdates(botmuxReal, '/tmp/d', [
      userChunk(
        botmuxReal,
        '<user_message>\nplease review\n</user_message>\n\n<sender type="user" open_id="ou_0123456789abcdef0123456789abcdef" />',
        'e1',
      ),
    ]);
    const out = await discoverGrokSessions(10);
    expect(out.map((s) => s.cliSessionId)).toContain(discuss);
    expect(out.map((s) => s.cliSessionId)).not.toContain(botmuxReal);
  });
});
