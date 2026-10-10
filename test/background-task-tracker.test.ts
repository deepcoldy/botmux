import { describe, expect, it } from 'vitest';
import {
  BackgroundTaskTracker,
  backgroundTaskDispatchToolUseIds,
  backgroundTaskDispatchAcks,
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

  it('a genuine new user prompt bounds a leaked account (resets pending)', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    expect(t.pending()).toBe(1);
    // Completion notification never parsed (hypothetical leak). A real
    // user-typed prompt starts a fresh turn → account must clear.
    const userPrompt: TranscriptEvent = {
      type: 'user', uuid: 'up',
      message: { role: 'user', content: 'please do the next thing' },
    } as TranscriptEvent;
    t.observe(userPrompt);
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

  it('a type-ahead prompt (attachment commandMode:prompt) bounds a leaked account', () => {
    const t = new BackgroundTaskTracker();
    t.observe(assistantAgent('a1', 'tu-1'));
    t.observe(launchAck('u1', 'tu-1', 'agent-1'));
    expect(t.pending()).toBe(1);
    // Completion notice never parsed (hypothetical leak). A type-ahead prompt
    // the CLI dequeues starts a fresh turn → account must clear, just like a
    // role:user prompt.
    t.observe(queuedPrompt('q', 'please do the next thing'));
    expect(t.pending()).toBe(0);
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
