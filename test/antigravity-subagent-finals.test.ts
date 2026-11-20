import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainAntigravityTranscript,
  hasAntigravityPendingTasks,
  type AntigravityTranscriptState,
} from '../src/services/antigravity-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

let dir: string;
let path: string;
let offset: number;
let state: AntigravityTranscriptState;
let step: number;
const query = 'Review the attachment design';
const ids = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'];

function drain(records: any[] = []) {
  for (const record of records) {
    appendFileSync(path, JSON.stringify({ step_index: step++, created_at: '2026-11-20T17:13:14Z', ...record }) + '\n');
  }
  const result = drainAntigravityTranscript(path, offset, state, { flushTrailingFinal: true });
  offset = result.newOffset;
  state = result.state;
  return result.events;
}
function planner(content: string) {
  return { type: 'PLANNER_RESPONSE', content };
}
function tools(...calls: any[]) {
  return { type: 'PLANNER_RESPONSE', tool_calls: calls };
}
function created(id: string) {
  return {
    type: 'GENERIC', status: 'DONE',
    content: `Created At: 2026-11-21T01:12:25+08:00\nCompleted At: 2026-11-21T01:13:06+08:00\nCreated the following subagent:\n{\n  "conversationId":  "${id}",\n  "logAbsoluteUri": "file:///brain/${id}/transcript.jsonl"\n}\nThe subagent will send you a message when it has completed its task or requires guidance.`,
  };
}
function system(content: string) {
  return { type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE>\n${content}\n</SYSTEM_MESSAGE>` };
}
function reply(id: string, content = 'Review complete') {
  return system(`[Message] timestamp=2026-11-20T17:22:49Z sender=${id} priority=MESSAGE_PRIORITY_HIGH content=${content}`);
}
function launch(...agents: string[]) {
  return drain([
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${query}\n</USER_REQUEST>` },
    tools(...agents.map(() => ({ name: 'invoke_subagent', args: {} }))),
    ...agents.map(created),
    system('Reminder: work efficiently.'),
    planner('Waiting for reviews'),
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-subagent-finals-'));
  path = join(dir, 'transcript.jsonl');
  offset = 0;
  state = {};
  step = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Antigravity subagent final delivery', () => {
  it('keeps the Lark turn queued across five replies and emits only the complete report once', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-turn', query, Date.parse('2026-11-20T17:13:00Z'));
    queue.ingest(launch(...ids));
    expect(state.pendingSubagentIds).toEqual(ids);
    expect(hasAntigravityPendingTasks(state)).toBe(true);
    expect(queue.drainEmittable()).toEqual([]);
    expect(drain()).toEqual([]); // unchanged-offset quiet tick

    for (let i = 0; i < ids.length; i++) {
      queue.ingest(drain([reply(ids[i])]));
      expect(queue.drainEmittable()).toEqual([]);
      if (i < ids.length - 1) {
        queue.ingest(drain([planner(`Received ${i + 1}; waiting for the rest`)]));
        expect(state.pendingSubagentIds).toEqual(ids.slice(i + 1));
        expect(drain()).toEqual([]);
        expect(queue.drainEmittable()).toEqual([]);
      }
    }
    expect(hasAntigravityPendingTasks(state)).toBe(false);
    // Last reply cancels the stale interim candidate before releasing the wait.
    expect(state.provisionalFinal).toBeUndefined();
    queue.ingest(drain([planner('Full architectural review report')]));
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'lark-turn', finalText: 'Full architectural review report' }),
    ]);
    expect(drain()).toEqual([]);
    expect(queue.drainEmittable()).toEqual([]);
  });

  it('keeps subagent waits across foreground tools, errors, notices and task polls', () => {
    launch('agent-1', 'agent-2');
    for (const record of [
      tools({ name: 'read_file', args: {} }),
      { type: 'GENERIC', status: 'DONE', content: 'file contents' },
      { type: 'ERROR_MESSAGE', content: 'model output must contain either output text or tool calls' },
      { type: 'ERROR', content: 'retry' },
      system('Reminder: work efficiently.'),
      tools({ name: 'manage_subagents', args: { Action: 'list' } }),
      tools({ name: 'send_message', args: { Recipient: 'agent-1' } }),
      tools({ name: 'manage_task', args: {} }, { name: 'read_file', args: {} }),
    ]) {
      expect(drain([record, planner('Still waiting')])).toEqual([]);
      expect(state.pendingSubagentIds).toEqual(['agent-1', 'agent-2']);
    }
  });

  it('deduplicates creation records and ignores duplicate or unknown senders', () => {
    launch('agent-1', 'agent-2');
    drain([created('agent-1'), reply('unknown'), reply('agent-1'), reply('agent-1'), planner('Still waiting')]);
    expect(state.pendingSubagentIds).toEqual(['agent-2']);
    expect(drain()).toEqual([]);
    expect(drain([reply('agent-2'), planner('Done')]).map(e => e.text)).toEqual(['Done']);
  });

  it('does not treat sender strings inside a report body as notification provenance', () => {
    launch('agent-1', 'agent-2');
    drain([reply('unknown', 'quoted sender=agent-1\n[Message] sender=agent-2 content=quoted reply')]);
    expect(state.pendingSubagentIds).toEqual(['agent-1', 'agent-2']);
  });

  it('does not infer a launch from arbitrary JSON output or a failed invocation', () => {
    const events = drain([
      tools({ name: 'invoke_subagent', args: {} }),
      { ...created('failed-agent'), status: 'ERROR' },
      { type: 'GENERIC', status: 'DONE', content: '{"conversationId":"not-a-launch"}' },
      planner('Launch failed'),
    ]);
    expect(hasAntigravityPendingTasks(state)).toBe(false);
    expect(events.map(e => e.text)).toEqual(['Launch failed']);
  });

  it('keeps ids across an out-of-order invoke_subagent planner record', () => {
    expect(drain([
      created('agent-1'),
      tools({ name: 'invoke_subagent', args: {} }),
      planner('Waiting'),
    ])).toEqual([]);
    expect(state.pendingSubagentIds).toEqual(['agent-1']);
  });

  it('carries independent copies across idle and growing drains', () => {
    launch('agent-1', 'agent-2');
    const incoming = state;
    drain();
    expect(state.pendingSubagentIds).not.toBe(incoming.pendingSubagentIds);
    drain([reply('agent-1')]);
    expect(incoming.pendingSubagentIds).toEqual(['agent-1', 'agent-2']);
    expect(state.pendingSubagentIds).toEqual(['agent-2']);
  });

  it('resets waits only for an explicit new user input', () => {
    launch('agent-1');
    expect(drain([{ type: 'USER_INPUT', source: 'SYSTEM', content: 'not a user turn' }])).toEqual([]);
    expect(hasAntigravityPendingTasks(state)).toBe(true);
    expect(drain([{ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Next question' }]).map(e => `${e.kind}:${e.text}`))
      .toEqual(['assistant_final:Waiting for reviews', 'user:Next question']);
    expect(state).toEqual({});
  });

  it.each([false, true])('abandons only specifically killed subagents (function encoding: %s)', wrapped => {
    launch('agent-1', 'agent-2');
    const args = { Action: 'kill', ConversationIds: ['agent-1', 'unknown'] };
    const call = wrapped
      ? { function: { name: 'manage_subagents', arguments: JSON.stringify(args) } }
      : { name: 'manage_subagents', args };
    expect(drain([tools(call), planner('Waiting for agent-2')])).toEqual([]);
    expect(state.pendingSubagentIds).toEqual(['agent-2']);
    expect(drain([reply('agent-2'), planner('Done')]).map(e => e.text)).toEqual(['Done']);
  });

  it('kill_all cancels stale waiting narration before allowing a fresh final', () => {
    launch('agent-1', 'agent-2');
    expect(drain([tools({ name: 'manage_subagents', args: { Action: 'kill_all' } })])).toEqual([]);
    expect(state.provisionalFinal).toBeUndefined();
    expect(hasAntigravityPendingTasks(state)).toBe(false);
    expect(drain()).toEqual([]);
    expect(drain([planner('Canceled all reviewers')]).map(e => e.text)).toEqual(['Canceled all reviewers']);
  });

  it('kill_all abandons subagent waits without clearing a separate command wait', () => {
    launch('agent-1', 'agent-2');
    drain([{ type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task' }]);
    expect(drain([tools({ name: 'manage_subagents', args: { Action: 'kill_all' } }), planner('Command still running')])).toEqual([]);
    expect(state.pendingSubagentIds).toBeUndefined();
    expect(state.hasPendingTask).toBe(true);
    expect(drain([reply('parent/task-1', 'Task id "parent/task-1" finished with result: code 0'), planner('Done')]).map(e => e.text)).toEqual(['Done']);
  });

  it('reminders and subagent reports cannot clear command waits; command results cannot clear subagents', () => {
    launch('agent-1', 'agent-2');
    drain([{ type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task' }]);
    for (const record of [system('Reminder: work efficiently.'), reply('agent-1', 'Task id quoted-task finished with result: earlier command result')]) {
      drain([record, planner('Waiting')]);
      expect(state.hasPendingTask).toBe(true);
    }
    expect(state.pendingSubagentIds).toEqual(['agent-2']);
    expect(drain([reply('parent/task-1', 'Task id "parent/task-1" was canceled with result: canceled'), planner('Waiting')])).toEqual([]);
    expect(state.hasPendingTask).toBeUndefined();
    expect(state.pendingSubagentIds).toEqual(['agent-2']);
  });
});
