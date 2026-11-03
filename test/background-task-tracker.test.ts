import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BackgroundTaskTracker,
  backgroundTaskStopsInSiblingTranscripts,
  backgroundTaskDispatchToolUseIds,
  backgroundTaskDispatchAcks,
  backgroundTaskLaunches,
  backgroundTaskSettledIds,
  isClaudeMainTurnStart,
  parseTaskNotification,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';

function assistantAgent(uuid: string, toolUseId: string, name: 'Agent' | 'Task' = 'Agent'): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input: { description: 'd', prompt: 'p' } }],
      stop_reason: 'tool_use',
    },
  } as TranscriptEvent;
}

function launchAck(uuid: string, toolUseId: string, agentId: string): TranscriptEvent {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)\nThe agent is working in the background.`,
      }],
    },
  } as TranscriptEvent;
}

function taskNotification(uuid: string, taskId: string, toolUseId: string, status = 'completed'): TranscriptEvent {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
    },
  } as TranscriptEvent;
}

/** The `attachment(queued_command)` shape current CLI builds write when they
 *  re-inject a completion notice: the tag text lives in `attachment.prompt`
 *  with `commandMode:'task-notification'`, and there is no `message`. */
function attachmentTaskNotification(uuid: string, taskId: string, toolUseId: string, status = 'completed'): TranscriptEvent {
  return {
    type: 'attachment',
    uuid,
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
    },
  } as unknown as TranscriptEvent;
}

/** A real type-ahead submission the CLI dequeues: `attachment(queued_command)`
 *  with `commandMode:'prompt'` carrying the user's text. */
function queuedPrompt(uuid: string, text: string): TranscriptEvent {
  return {
    type: 'attachment',
    uuid,
    attachment: { type: 'queued_command', commandMode: 'prompt', prompt: text },
  } as unknown as TranscriptEvent;
}

function assistant(uuid: string, text: string, stopReason: string): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason },
  } as TranscriptEvent;
}

describe('background task detection primitives', () => {
  it('detects Agent and Task dispatch tool_use ids, ignores other tools', () => {
    expect(backgroundTaskDispatchToolUseIds(assistantAgent('a', 'tu-1'))).toEqual(['tu-1']);
    expect(backgroundTaskDispatchToolUseIds(assistantAgent('a', 'tu-2', 'Task'))).toEqual(['tu-2']);
    const bash = {
      type: 'assistant', uuid: 'b',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], stop_reason: 'tool_use' },
    } as TranscriptEvent;
    expect(backgroundTaskDispatchToolUseIds(bash)).toEqual([]);
  });

  it('reads the launch-ack agentId only when both markers are present', () => {
    expect(backgroundTaskDispatchAcks(launchAck('u', 'tu-1', 'agent-77'))).toEqual([
      { toolUseId: 'tu-1', agentId: 'agent-77' },
    ]);
    const plainResult = {
      type: 'user', uuid: 'u2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'ran a background job in the background' }] },
    } as TranscriptEvent;
    // No agentId: line → not an async launch ack.
    expect(backgroundTaskDispatchAcks(plainResult)).toEqual([]);
  });

  it('parses a real task-notification but not a tool_result that merely contains the tag', () => {
    const parsed = parseTaskNotification(taskNotification('u', 'agent-77', 'tu-1'));
    expect(parsed).toEqual({ taskId: 'agent-77', toolUseId: 'tu-1', status: 'completed' });

    const grepHit = {
      type: 'user', uuid: 'g',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'src/x.ts:1: <task-notification>' }] },
    } as TranscriptEvent;
    expect(parseTaskNotification(grepHit)).toBeUndefined();
  });

  it('parses the attachment(queued_command) notification shape current CLI builds emit', () => {
    const parsed = parseTaskNotification(attachmentTaskNotification('u', 'agent-88', 'tu-2', 'failed'));
    expect(parsed).toEqual({ taskId: 'agent-88', toolUseId: 'tu-2', status: 'failed' });

    // A type-ahead user prompt (commandMode:'prompt') is not a notification.
    expect(parseTaskNotification(queuedPrompt('q', 'do the thing'))).toBeUndefined();
  });
});

describe('BackgroundTaskTracker', () => {
  it('stays pending from dispatch until the completion notification arrives', () => {
    const t = new BackgroundTaskTracker();
    expect(t.pending()).toBe(0);

    t.observe(assistantAgent('a1', 'tu-1'));   // dispatch
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));  // async confirmed
    expect(t.pending()).toBe(1);

    // Main turn ends here (end_turn) while agent-1 is still running.
    t.observe(assistant('a2', 'dispatched, waiting', 'end_turn'));
    expect(t.pending()).toBe(1);

    // Background agent finishes → notification retires it.
    t.observe(taskNotification('u2', 'agent-1', 'tu-1', 'completed'));
    expect(t.pending()).toBe(0);
  });

  it('tracks multiple concurrent agents independently', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    t.observe(assistantAgent('a2', 'tu-2'));
    t.observe(launchAck('u2', 'tu-2', 'agent-2'));
    expect(t.pending()).toBe(2);

    t.observe(taskNotification('u3', 'agent-2', 'tu-2'));
    expect(t.pending()).toBe(1);
    t.observe(taskNotification('u4', 'agent-1', 'tu-1'));
    expect(t.pending()).toBe(0);
  });

  it('retires on a failed notification too, and a duplicate notification is idempotent', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    t.observe(taskNotification('u2', 'agent-1', 'tu-1', 'failed'));
    expect(t.pending()).toBe(0);
    // Same agent notifies again after a resume/stop — must not go negative or re-add.
    t.observe(taskNotification('u3', 'agent-1', 'tu-1', 'completed'));
    expect(t.pending()).toBe(0);
  });

  it('does not count an ordinary synchronous turn with no background dispatch', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistant('a1', 'just an answer', 'end_turn'));
    expect(t.pending()).toBe(0);
  });

  it('pairs a dispatch even if the launch-ack event is folded before it in a redrain', () => {
    const t = new BackgroundTaskTracker();
    // Ack observed first (redrain ordering edge): still pairs by tool_use id.
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    t.observe(assistantAgent('a1', 'tu-1'));
    expect(t.pending()).toBe(1);
    t.observe(taskNotification('u2', 'agent-1', 'tu-1'));
    expect(t.pending()).toBe(0);
  });

  it('a genuine new user prompt ends the turn claim but not the running task', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    expect(t.pending()).toBe(1);
    expect(t.pendingTurnAgents()).toBe(1);
    // The user interjects while agent-1 runs. Claude Code keeps the agent
    // running, so it still counts; only the dispatching turn's claim on the
    // `working` card ends.
    const userPrompt: TranscriptEvent = {
      type: 'user', uuid: 'up',
      message: { role: 'user', content: 'please do the next thing' },
    } as TranscriptEvent;
    t.observe(userPrompt);
    expect(t.pending()).toBe(1);
    expect(t.pendingTurnAgents()).toBe(0);
    t.observe(taskNotification('u2', 'agent-1', 'tu-1'));
    expect(t.pending()).toBe(0);
  });

  it('a task-notification does NOT reset like a real user prompt', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    t.observe(assistantAgent('a2', 'tu-2'));
    t.observe(launchAck('u2', 'tu-2', 'agent-2'));
    expect(t.pending()).toBe(2);
    // agent-1 finishes; agent-2 still in flight — the notification retires only
    // agent-1, it must not clear the whole account.
    t.observe(taskNotification('u3', 'agent-1', 'tu-1'));
    expect(t.pending()).toBe(1);
  });

  it('retires against the attachment(queued_command) notification shape', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    expect(t.pending()).toBe(1);
    // The completion notice arrives in the attachment form (majority of real
    // CLI builds) — it must still retire the tracked id.
    t.observe(attachmentTaskNotification('u2', 'agent-1', 'tu-1', 'completed'));
    expect(t.pending()).toBe(0);
  });

  it('a type-ahead prompt (attachment commandMode:prompt) ends the turn claim like a role:user prompt', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    expect(t.pendingTurnAgents()).toBe(1);
    t.observe(queuedPrompt('q', 'please do the next thing'));
    expect(t.pendingTurnAgents()).toBe(0);
    expect(t.pending()).toBe(1);
  });

  it('an attachment notification still does NOT reset the whole account', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    t.observe(assistantAgent('a2', 'tu-2'));
    t.observe(launchAck('u2', 'tu-2', 'agent-2'));
    expect(t.pending()).toBe(2);
    t.observe(attachmentTaskNotification('u3', 'agent-1', 'tu-1'));
    expect(t.pending()).toBe(1);
  });
});

/** A main-thread tool_result carrying Claude Code's structured launch record. */
function structuredLaunch(uuid: string, toolUseId: string, toolUseResult: Record<string, unknown>, timestamp = '2026-10-20T10:00:00.000Z'): TranscriptEvent {
  return {
    type: 'user',
    uuid,
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'started' }] },
    toolUseResult,
  } as TranscriptEvent;
}

function queueOperation(operation: string, content?: string, timestamp = '2026-10-20T10:05:00.000Z'): TranscriptEvent {
  return { type: 'queue-operation', operation, timestamp, ...(content !== undefined ? { content } : {}) } as TranscriptEvent;
}

function notificationText(taskIds: string[], status?: string): string {
  return `<task-notification>\n${taskIds.map(id => `<task-id>${id}</task-id>`).join('\n')}\n`
    + `${status ? `<status>${status}</status>\n` : ''}<summary>s</summary>\n</task-notification>`;
}

describe('structured background task records', () => {
  it('reads Agent, Bash and Monitor launches from toolUseResult', () => {
    expect(backgroundTaskLaunches(structuredLaunch('u', 't1', { isAsync: true, status: 'async_launched', agentId: 'a1' })))
      .toEqual([{ taskId: 'a1', kind: 'agent' }]);
    expect(backgroundTaskLaunches(structuredLaunch('u', 't2', { stdout: '', backgroundTaskId: 'b1' })))
      .toEqual([{ taskId: 'b1', kind: 'shell' }]);
    expect(backgroundTaskLaunches(structuredLaunch('u', 't3', { taskId: 'm1', timeoutMs: 60_000, persistent: false })))
      .toEqual([{ taskId: 'm1', kind: 'monitor', expiresAtMs: Date.parse('2026-10-20T10:00:00.000Z') + 60_000 }]);
    // A persistent Monitor has no deadline of its own.
    expect(backgroundTaskLaunches(structuredLaunch('u', 't4', { taskId: 'm2', timeoutMs: 60_000, persistent: true })))
      .toEqual([{ taskId: 'm2', kind: 'monitor' }]);
    // A foreground Bash result, and a sidechain launch (a sub-agent's own task), are not main-thread launches.
    expect(backgroundTaskLaunches(structuredLaunch('u', 't5', { stdout: 'ok', stderr: '', interrupted: false }))).toEqual([]);
    expect(backgroundTaskLaunches({ ...structuredLaunch('u', 't6', { backgroundTaskId: 'b2' }), isSidechain: true } as TranscriptEvent)).toEqual([]);
  });

  it('settles on a terminal notification in any shape, every listed id, and a TaskStop result', () => {
    // queue-operation enqueue — the only record of a stop made in the TUI's task dialog.
    expect(backgroundTaskSettledIds(queueOperation('enqueue', notificationText(['b1'], 'killed')))).toEqual(['b1']);
    // Resume-time orphan summary lists several ids.
    expect(backgroundTaskSettledIds(queueOperation('enqueue', notificationText(['b2', 'b3'], 'stopped')))).toEqual(['b2', 'b3']);
    // A Monitor's per-event notice has no <status>: the Monitor keeps running.
    expect(backgroundTaskSettledIds(queueOperation('enqueue', notificationText(['m1'])))).toEqual([]);
    // dequeue / remove carry no stop of their own.
    expect(backgroundTaskSettledIds(queueOperation('dequeue'))).toEqual([]);
    expect(backgroundTaskSettledIds(queueOperation('remove', notificationText(['b4'], 'completed')))).toEqual([]);
    expect(backgroundTaskSettledIds(taskNotification('u', 'a1', 'tu', 'failed'))).toEqual(['a1']);
    expect(backgroundTaskSettledIds(attachmentTaskNotification('u', 'a2', 'tu'))).toEqual(['a2']);
    expect(backgroundTaskSettledIds(structuredLaunch('u', 'stop', {
      message: 'Successfully stopped task: b5 (sleep 300)', task_id: 'b5', task_type: 'local_bash', command: 'sleep 300',
    }))).toEqual(['b5']);
    // A failed TaskStop returns a bare string, not a record.
    expect(backgroundTaskSettledIds({ ...structuredLaunch('u', 'stop', {}), toolUseResult: 'Error: No task found with ID: b6' } as TranscriptEvent)).toEqual([]);
  });

  it('recognises the main agent starting work again', () => {
    expect(isClaudeMainTurnStart({ type: 'user', message: { role: 'user', content: 'next please' } } as TranscriptEvent)).toBe(true);
    expect(isClaudeMainTurnStart(queuedPrompt('q', 'next please'))).toBe(true);
    expect(isClaudeMainTurnStart(taskNotification('u', 'a1', 'tu'))).toBe(true);
    expect(isClaudeMainTurnStart(attachmentTaskNotification('u', 'a1', 'tu'))).toBe(true);
    expect(isClaudeMainTurnStart(queueOperation('dequeue'))).toBe(true);
    // A task stopping on its own does not mean the model runs.
    expect(isClaudeMainTurnStart(queueOperation('enqueue', notificationText(['b1'], 'killed')))).toBe(false);
    expect(isClaudeMainTurnStart(structuredLaunch('u', 't', { backgroundTaskId: 'b1' }))).toBe(false);
    expect(isClaudeMainTurnStart({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } } as TranscriptEvent)).toBe(false);
    expect(isClaudeMainTurnStart({ type: 'system', subtype: 'turn_duration' } as TranscriptEvent)).toBe(false);
  });
});

describe('BackgroundTaskTracker — Bash, Monitor and CLI lifetime', () => {
  it('counts background Bash until its stop is recorded, including a TaskStop with no notification', () => {
    const t = new BackgroundTaskTracker();
    t.observe(structuredLaunch('u1', 't1', { backgroundTaskId: 'b1' }));
    t.observe(structuredLaunch('u2', 't2', { backgroundTaskId: 'b2' }));
    expect(t.pending()).toBe(2);
    // Shells never claim the `working` card: that gate stays agent-only.
    expect(t.pendingTurnAgents()).toBe(0);
    t.observe(structuredLaunch('u3', 'stop', { message: 'stopped', task_id: 'b1', task_type: 'local_bash', command: 'x' }));
    expect(t.pending()).toBe(1);
    t.observe(queueOperation('enqueue', notificationText(['b2'], 'completed')));
    expect(t.pending()).toBe(0);
  });

  it('drops a non-persistent Monitor at its own deadline, and keeps it on a status-less event', () => {
    const t = new BackgroundTaskTracker();
    const launchedAt = Date.parse('2026-10-20T10:00:00.000Z');
    t.observe(structuredLaunch('u1', 't1', { taskId: 'm1', timeoutMs: 1_800_000, persistent: false }));
    t.observe(queueOperation('enqueue', notificationText(['m1'])));
    expect(t.pending(launchedAt + 1_799_999)).toBe(1);
    expect(t.pending(launchedAt + 1_800_000)).toBe(0);
  });

  it('ignores launches older than the current CLI process and survives re-reading a settled launch', () => {
    const t = new BackgroundTaskTracker();
    t.reset(Date.parse('2026-10-20T11:00:00.000Z'));
    // Replayed from a resumed transcript: the process that launched it is gone.
    t.observe(structuredLaunch('u1', 't1', { backgroundTaskId: 'old' }, '2026-10-20T10:59:00.000Z'));
    expect(t.pending()).toBe(0);
    t.observe(structuredLaunch('u2', 't2', { backgroundTaskId: 'b1' }, '2026-10-20T11:00:05.000Z'));
    t.observe(queueOperation('enqueue', notificationText(['b1'], 'completed'), '2026-10-20T11:01:00.000Z'));
    // A rotation re-drain reads the launch again after its stop.
    t.observe(structuredLaunch('u2', 't2', { backgroundTaskId: 'b1' }, '2026-10-20T11:00:05.000Z'));
    expect(t.pending()).toBe(0);
  });

  it('accepts launch/settle signals from another CLI (Grok)', () => {
    const t = new BackgroundTaskTracker();
    t.reset(2_000);
    t.launch('g-old', 'shell', { atMs: 1_000 });
    t.launch('g1', 'shell', { atMs: 3_000 });
    t.launch('g2', 'monitor', { atMs: 3_000 });
    expect(t.pending()).toBe(2);
    t.settle('g1');
    t.launch('g1', 'shell', { atMs: 4_000 }); // a later list still showing it running
    expect(t.pending()).toBe(1);
    expect(t.pendingTurnAgents()).toBe(0);
  });
});

/** Replays transcripts recorded from a real Claude Code 2.1.304 session (paths
 *  scrubbed): background Bash + Agent, an interjection, completions, a stop made
 *  in the task dialog, and /clear with the stop landing in the new file. */
describe('BackgroundTaskTracker — recorded Claude Code session', () => {
  function load(name: string): TranscriptEvent[] {
    return readFileSync(new URL(`./fixtures/claude-background-tasks/${name}`, import.meta.url), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptEvent);
  }
  const textOf = (ev: TranscriptEvent): string => {
    const content = ev.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b: any) => b.text ?? b.content ?? '').join(' ');
    return typeof ev.content === 'string' ? ev.content : '';
  };

  it('follows the count the TUI shows through interjection, completion, task-dialog stop and /clear', () => {
    const t = new BackgroundTaskTracker();
    const before = load('before-clear.jsonl');
    const at = (predicate: (ev: TranscriptEvent) => boolean): number => {
      const index = before.findIndex(predicate);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const play = (from: number, to: number): void => { for (const ev of before.slice(from, to + 1)) t.observe(ev); };

    // The main turn's own records: a prompt / wake opens it, the terminal
    // `turn_duration` record after its final reply closes it.
    const turnEndAfter = (index: number): number => {
      const end = before.findIndex((ev, i) => i > index && ev.type === 'system' && ev.subtype === 'turn_duration');
      expect(end).toBeGreaterThan(index);
      return end;
    };

    // Turn 1 launches a background Bash and a background Agent …
    const firstReply = at(ev => textOf(ev) === 'launched');
    play(0, firstReply - 1);
    expect(t.pending()).toBe(2);
    expect(t.backgroundWait()).toBe(0); // the main agent is still in its turn
    // … then ends: the card switches to 「主回合已结束 · 后台子任务运行中（2）」.
    const firstEnd = turnEndAfter(firstReply);
    play(firstReply, firstEnd);
    expect(t.backgroundWait()).toBe(2);
    expect(t.pendingTurnAgents()).toBe(1);

    // The user interjects; the TUI still shows "1 shell" and the agent.
    const hi = at(ev => textOf(ev) === 'Reply with just: hi');
    play(firstEnd + 1, hi);
    expect(t.backgroundWait()).toBe(0); // the main agent is answering
    const hiEnd = turnEndAfter(hi);
    play(hi + 1, hiEnd);
    expect(t.pending()).toBe(2);
    expect(t.backgroundWait()).toBe(2);
    expect(t.pendingTurnAgents()).toBe(0);

    // The shell finishes and wakes the model: back to working, then 1 left.
    const shellWake = at(ev => isClaudeMainTurnStart(ev) && ev.type === 'user' && textOf(ev).includes('bid0v2g0v'));
    play(hiEnd + 1, shellWake);
    expect(t.pending()).toBe(1);
    expect(t.backgroundWait()).toBe(0);
    const shellWakeEnd = turnEndAfter(shellWake);
    play(shellWake + 1, shellWakeEnd);
    expect(t.backgroundWait()).toBe(1);
    // The agent finishes last; once its wake turn ends nothing is left.
    const agentWake = at(ev => isClaudeMainTurnStart(ev) && ev.type === 'user' && textOf(ev).includes('acd41ee20826bff6e'));
    play(shellWakeEnd + 1, agentWake);
    expect(t.pending()).toBe(0);
    const agentWakeEnd = turnEndAfter(agentWake);
    play(agentWake + 1, agentWakeEnd);
    expect(t.backgroundWait()).toBe(0);

    // A 300s shell, stopped from the task dialog: only a queue-operation
    // enqueue records it, and nothing wakes the model.
    const longReply = at(ev => textOf(ev) === 'ok');
    const longEnd = turnEndAfter(longReply);
    play(agentWakeEnd + 1, longEnd);
    expect(t.backgroundWait()).toBe(1);
    const dialogStop = at(ev => ev.type === 'queue-operation' && ev.operation === 'enqueue' && textOf(ev).includes('b5q0sw8z2'));
    expect(isClaudeMainTurnStart(before[dialogStop])).toBe(false);
    play(longEnd + 1, dialogStop);
    expect(t.pending()).toBe(0);
    expect(t.backgroundWait()).toBe(0);

    // A shell launched right before /clear …
    play(dialogStop + 1, before.length - 1);
    expect(t.backgroundWait()).toBe(1);
    // … keeps running across it (the /clear records start no model turn) and
    // reports into the new session file.
    const after = load('after-clear.jsonl');
    const wake = after.findIndex(ev => ev.type === 'queue-operation' && ev.operation === 'dequeue');
    for (const ev of after.slice(0, wake)) t.observe(ev);
    expect(t.backgroundWait()).toBe(0); // stopped; its wake-up is already queued
    for (const ev of after.slice(wake)) t.observe(ev);
    expect(t.pending()).toBe(0);
    expect(t.backgroundWait()).toBe(0);
  });

  it('a non-final assistant message keeps the turn open; only a terminal record ends it', () => {
    const t = new BackgroundTaskTracker();
    t.observe(structuredLaunch('u1', 't1', { backgroundTaskId: 'b1' }));
    t.observe(assistant('a1', 'checking', 'tool_use'));
    expect(t.backgroundWait()).toBe(0);
    t.observe(assistant('a2', 'done for now', 'end_turn'));
    expect(t.backgroundWait()).toBe(1);
    // Input the worker submits opens the turn before its transcript record lands.
    t.noteMainTurn(true);
    expect(t.backgroundWait()).toBe(0);
    t.observe({ type: 'system', subtype: 'turn_duration' } as TranscriptEvent);
    expect(t.backgroundWait()).toBe(1);
    // A replaced CLI process takes its tasks and turn with it.
    t.reset();
    expect(t.backgroundWait()).toBe(0);
  });
});

/** After a /clear typed in the terminal the stop lands in a new session file
 *  the bridge may not follow; the worker reads stops from sibling files while
 *  the card shows background work. */
describe('backgroundTaskStopsInSiblingTranscripts', () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`./fixtures/claude-background-tasks/${name}`, import.meta.url), 'utf8');

  it('settles a task whose stop was written into the post-/clear session file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-sibling-'));
    try {
      const current = join(dir, 'before.jsonl');
      writeFileSync(current, fixture('before-clear.jsonl'));
      const t = new BackgroundTaskTracker();
      for (const line of readFileSync(current, 'utf8').split('\n').filter(Boolean)) t.observe(JSON.parse(line));
      expect(t.backgroundWait()).toBe(1);

      const sinceMs = Date.now() - 1_000;
      // A session last written before the wait began is not read at all.
      const stale = join(dir, 'stale.jsonl');
      writeFileSync(stale, queueLine('stale-task'));
      utimesSync(stale, new Date(sinceMs - 60_000), new Date(sinceMs - 60_000));
      const offsets = new Map<string, number>();
      // The bridge still watches `before.jsonl`; /clear opened a new file.
      expect(backgroundTaskStopsInSiblingTranscripts(dir, current, sinceMs, offsets)).toEqual([]);
      const fresh = join(dir, 'after.jsonl');
      writeFileSync(fresh, fixture('after-clear.jsonl'));
      const ids = backgroundTaskStopsInSiblingTranscripts(dir, current, sinceMs, offsets);
      expect(new Set(ids)).toEqual(new Set(['blv90xfzb']));
      for (const id of ids) t.settle(id);
      expect(t.pending()).toBe(0);
      expect(t.backgroundWait()).toBe(0);
      // Read once: a second pass returns only what was appended since.
      expect(backgroundTaskStopsInSiblingTranscripts(dir, current, sinceMs, offsets)).toEqual([]);
      appendFileSync(fresh, queueLine('later-task'));
      expect(backgroundTaskStopsInSiblingTranscripts(dir, current, sinceMs, offsets)).toEqual(['later-task']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a large file it has not seen before from its end only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-sibling-'));
    try {
      const big = join(dir, 'busy-sibling.jsonl');
      writeFileSync(big, queueLine('old-task') + 'x'.repeat(5 * 1024 * 1024) + '\n');
      const offsets = new Map<string, number>();
      expect(backgroundTaskStopsInSiblingTranscripts(dir, join(dir, 'current.jsonl'), 0, offsets)).toEqual([]);
      appendFileSync(big, queueLine('new-task'));
      expect(backgroundTaskStopsInSiblingTranscripts(dir, join(dir, 'current.jsonl'), 0, offsets)).toEqual(['new-task']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function queueLine(taskId: string): string {
    return JSON.stringify({
      type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(),
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>s</summary>\n</task-notification>`,
    }) + '\n';
  }
});
