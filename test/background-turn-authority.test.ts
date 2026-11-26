import { describe, expect, it } from 'vitest';
import {
  BackgroundTurnAuthorityHold,
  LegacyAgentAckPairer,
  applyClaudeTranscriptEventToAuthorityHold,
  isAuthorityHoldEligibleTask,
  isAuthorityHoldEligibleTurn,
  isClaudeClearOrNewCommandEvent,
  isClaudeUserInterruptTranscriptEvent,
  isDeferrableAuthorityReleaseReason,
} from '../src/core/background-turn-authority.js';
import {
  AbsorbedReplyCollector,
  classifyClaudeTerminalEvent,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';

const T0 = 1_762_344_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const HUMAN_A = {
  requestLarkAppId: 'cli_test',
  requestUserOpenId: 'ou_user_a',
  senderType: 'user' as const,
};
const HUMAN_B = {
  requestLarkAppId: 'cli_test',
  requestUserOpenId: 'ou_user_b',
  senderType: 'user' as const,
};
const BOT_CALLER = {
  requestLarkAppId: 'cli_test',
  requestUserOpenId: 'ou_bot_1',
  senderType: 'bot' as const,
};

function startHumanTurn(hold: BackgroundTurnAuthorityHold, turnId: string, caller = HUMAN_A) {
  return hold.onForegroundTurnStarted({
    turnId,
    caller,
    speakers: [{ openId: caller.requestUserOpenId, turnId }],
  });
}

function userPrompt(text: string, ms: number): TranscriptEvent {
  return {
    type: 'user',
    uuid: `u-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    promptSource: 'user',
    turnOrigin: 'human',
    message: { role: 'user', content: text },
  };
}

function launchBash(taskId: string, ms: number): TranscriptEvent {
  return {
    type: 'user',
    uuid: `launch-bash-${taskId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    toolUseResult: { backgroundTaskId: taskId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${taskId}`, content: `bg ${taskId}` }] },
  };
}

function launchAgent(agentId: string, ms: number): TranscriptEvent {
  return {
    type: 'user',
    uuid: `launch-agent-${agentId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    toolUseResult: { isAsync: true, status: 'async_launched', agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${agentId}`, content: 'launched' }] },
  };
}

function launchWorkflow(taskId: string, ms: number): TranscriptEvent {
  return {
    type: 'user',
    uuid: `launch-wf-${taskId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    toolUseResult: { status: 'async_launched', taskType: 'local_workflow', taskId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${taskId}`, content: 'launched' }] },
  };
}

function launchMonitor(taskId: string, persistent: boolean, ms: number, timeoutMs = 60_000): TranscriptEvent {
  return {
    type: 'user',
    uuid: `launch-mon-${taskId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    toolUseResult: { taskId, persistent, timeoutMs },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${taskId}`, content: 'monitor' }] },
  };
}

function resumeAgent(agentId: string, ms: number): TranscriptEvent {
  return {
    type: 'user',
    uuid: `resume-${agentId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    toolUseResult: { success: true, resumedAgentId: agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-res-${agentId}`, content: 'resumed' }] },
  };
}

function assistantText(text: string, ms: number, stopReason: string | null = 'end_turn'): TranscriptEvent {
  return {
    type: 'assistant',
    uuid: `a-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
  };
}

function assistantToolUse(name: string, toolUseId: string, ms: number): TranscriptEvent {
  return {
    type: 'assistant',
    uuid: `atu-${toolUseId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUseId, name, input: {} }] },
  };
}

function turnDuration(ms: number): TranscriptEvent {
  return {
    type: 'system',
    subtype: 'turn_duration',
    uuid: `dur-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
  };
}

function queueNotice(
  operation: 'enqueue' | 'remove',
  taskIds: string[],
  status: string | undefined,
  ms: number,
): TranscriptEvent {
  const body = taskIds.map(id => `<task-id>${id}</task-id>`).join('\n')
    + (status ? `\n<status>${status}</status>` : '');
  return {
    type: 'queue-operation',
    operation,
    timestamp: iso(ms),
    content: `<task-notification>\n${body}\n</task-notification>`,
  };
}

function queueDequeue(ms: number): TranscriptEvent {
  return {
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: iso(ms),
  };
}

function deliveredWake(
  taskIds: string[],
  ms: number,
  opts: { status?: string; promptSource?: string; turnOrigin?: string } = {},
): TranscriptEvent {
  const status = 'status' in opts ? opts.status : 'completed';
  const body = taskIds.map(id => `<task-id>${id}</task-id>`).join('\n')
    + (status ? `\n<status>${status}</status>` : '');
  return {
    type: 'user',
    uuid: `wake-${taskIds.join('-')}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    promptSource: 'promptSource' in opts ? opts.promptSource : 'system',
    ...('turnOrigin' in opts
      ? (opts.turnOrigin !== undefined ? { turnOrigin: opts.turnOrigin } : {})
      : { turnOrigin: 'task_notification' }),
    message: { role: 'user', content: `<task-notification>\n${body}\n</task-notification>` },
  };
}

function absorbedWakeAttachment(
  taskIds: string[],
  ms: number,
  opts: { status?: string; commandMode?: string } = {},
): TranscriptEvent {
  const status = 'status' in opts ? opts.status : 'completed';
  const body = taskIds.map(id => `<task-id>${id}</task-id>`).join('\n')
    + (status ? `\n<status>${status}</status>` : '');
  return {
    type: 'attachment',
    uuid: `att-${taskIds.join('-')}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      ...('commandMode' in opts
        ? (opts.commandMode !== undefined ? { commandMode: opts.commandMode } : {})
        : { commandMode: 'task-notification' }),
      prompt: `<task-notification>\n${body}\n</task-notification>`,
    },
  };
}

function taskStopResult(taskId: string, ms: number): TranscriptEvent {
  return {
    type: 'user',
    uuid: `stop-${taskId}-${ms}`,
    timestamp: iso(ms),
    isSidechain: false,
    toolUseResult: { task_id: taskId, task_type: 'local_bash' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-stop-${taskId}`, content: 'stopped' }] },
  };
}

describe('BackgroundTurnAuthorityHold — eligibility & predicates', () => {
  it('permits only finite agent and shell tasks, excluding all monitors', () => {
    expect(isAuthorityHoldEligibleTask('agent')).toBe(true);
    expect(isAuthorityHoldEligibleTask('shell')).toBe(true);
    expect(isAuthorityHoldEligibleTask('monitor')).toBe(false);
  });

  it('strictly allowlists single-human interactive non-adopt non-durable un-adopted IM turns', () => {
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a', caller: HUMAN_A })).toBe(true);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a', identityTurnId: 'om_a', caller: HUMAN_A })).toBe(true);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'join_1', caller: HUMAN_A })).toBe(true);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'cct_1', caller: HUMAN_A })).toBe(true);
    expect(isAuthorityHoldEligibleTurn({
      turnId: 'om_a',
      caller: HUMAN_A,
      speakers: [{ openId: HUMAN_A.requestUserOpenId, turnId: 'om_a' }],
    })).toBe(true);

    // Rejected classes (3.10 fail-closed)
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a' })).toBe(false); // callerless
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a', caller: BOT_CALLER })).toBe(false); // bot-sent
    expect(isAuthorityHoldEligibleTurn({
      turnId: 'om_a',
      caller: { ...HUMAN_A, source: 'schedule_creator', taskId: 't1' },
    })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a', caller: HUMAN_A, provenanceIncomplete: true })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({
      turnId: 'om_a2',
      caller: HUMAN_A,
      speakers: [
        { openId: HUMAN_B.requestUserOpenId, turnId: 'om_b' },
        { openId: HUMAN_A.requestUserOpenId, turnId: 'om_a2' },
      ],
    })).toBe(false); // mixed-principal steer (A -> B -> A)
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a', caller: HUMAN_A, adoptMode: true })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_a', caller: HUMAN_A, dispatchAttempt: 1 })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'om_b', identityTurnId: 'om_a', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'schedule:task1:u1', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'trg_abc', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'trg_runas_abc', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'local-123', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'local-headless-123', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'scheduled-fire1', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'auto-compact:1', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'bmx-recovery-1', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: 'board:app:1', caller: HUMAN_A })).toBe(false);
    expect(isAuthorityHoldEligibleTurn({ turnId: undefined, caller: HUMAN_A })).toBe(false);
  });

  it('defers only turn_terminal / prompt_ready / structured_turn_retired', () => {
    expect(isDeferrableAuthorityReleaseReason('turn_terminal')).toBe(true);
    expect(isDeferrableAuthorityReleaseReason('prompt_ready')).toBe(true);
    expect(isDeferrableAuthorityReleaseReason('structured_turn_retired')).toBe(true);
    expect(isDeferrableAuthorityReleaseReason('background_hold:wake_turn_completed')).toBe(false);
    expect(isDeferrableAuthorityReleaseReason('stale_terminal')).toBe(false);
  });

  it('detects user interrupts and /clear or /new while ignoring api-request-blob', () => {
    expect(isClaudeUserInterruptTranscriptEvent({
      type: 'user',
      message: { role: 'user', content: '[Request interrupted by user]' },
    })).toBe(true);
    expect(isClaudeUserInterruptTranscriptEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'err' },
          { type: 'text', text: '[Request interrupted by user for tool use]' },
        ],
      },
    })).toBe(true);
    expect(isClaudeUserInterruptTranscriptEvent({
      type: 'user',
      interruptedMessageId: 'msg_1',
      message: { role: 'user', content: '' },
    } as TranscriptEvent)).toBe(true);
    expect(isClaudeUserInterruptTranscriptEvent({
      type: 'api-request-blob',
      message: { role: 'user', content: '[Request interrupted by user]' },
    })).toBe(false);

    expect(isClaudeClearOrNewCommandEvent({
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    })).toBe(true);
    expect(isClaudeClearOrNewCommandEvent({
      type: 'user',
      message: { role: 'user', content: '<command-name>/new</command-name>' },
    })).toBe(true);
    expect(isClaudeClearOrNewCommandEvent({
      type: 'api-request-blob',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    })).toBe(false);
  });
});

describe('BackgroundTurnAuthorityHold — Claude lifecycle & wake-up micro-turns', () => {
  it('holds across foreground turn_duration, 29ms enqueue→dequeue gap, and tool-only wake micro-turn, then releases', () => {
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    hold.reset(T0);

    startHumanTurn(hold, 'om_A');
    applyClaudeTranscriptEventToAuthorityHold(hold, userPrompt('upload to lark sheet', T0 + 100), pairer, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hold, launchBash('bg_bash_1', T0 + 500), pairer, T0 + 500);
    applyClaudeTranscriptEventToAuthorityHold(hold, assistantText('started bg', T0 + 900), pairer, T0 + 900);

    // Holds even before turn_duration if prompt_ready races
    expect(hold.holds('om_A', undefined, T0 + 950)).toBe(true);

    // Foreground turn closes with turn_duration
    const trEnd = applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 1000), pairer, T0 + 1000);
    expect(trEnd).toEqual({ action: 'entered_idle_hold', turn: { turnId: 'om_A' } });
    expect(hold.phase()).toBe('HELD_WAITING_BG');
    expect(hold.onForegroundTurnTerminal({ turnId: 'om_A', status: 'completed' }, T0 + 1001)).toBe(true);
    expect(hold.holds('om_A', undefined, T0 + 20_000)).toBe(true);

    // Background bash finishes: enqueue lands in one drain tick (29ms before dequeue/user)
    const trEnq = applyClaudeTranscriptEventToAuthorityHold(
      hold, queueNotice('enqueue', ['bg_bash_1'], 'completed', T0 + 30_000), pairer, T0 + 30_000,
    );
    expect(trEnq.action).toBe('none');
    expect(hold.phase()).toBe('WAKE_PENDING');
    expect(hold.holds('om_A', undefined, T0 + 30_010)).toBe(true);

    // Dequeue is a no-op; still WAKE_PENDING
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, queueDequeue(T0 + 30_029), pairer, T0 + 30_029).action).toBe('none');
    expect(hold.phase()).toBe('WAKE_PENDING');

    // Delivered system <task-notification> opens WAKE_ACTIVE
    const trWake = applyClaudeTranscriptEventToAuthorityHold(
      hold, deliveredWake(['bg_bash_1'], T0 + 30_051), pairer, T0 + 30_051,
    );
    expect(trWake).toEqual({ action: 'entered_wake_active', turn: { turnId: 'om_A' } });
    expect(hold.phase()).toBe('WAKE_ACTIVE');
    expect(hold.isWakeActive()).toBe(true);
    expect(hold.holds('om_A', undefined, T0 + 31_000)).toBe(true);

    // Tool-only wake micro-turn (calls lark --as user + botmux send, writes NO visible text)
    applyClaudeTranscriptEventToAuthorityHold(hold, assistantToolUse('Bash', 'tu_lark', T0 + 32_000), pairer, T0 + 32_000);
    expect(hold.holds('om_A', undefined, T0 + 33_000)).toBe(true);

    // Wake micro-turn closes with turn_duration → immediate revoke!
    const trWakeEnd = applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 35_000), pairer, T0 + 35_000);
    expect(trWakeEnd).toEqual({
      action: 'revoke',
      turn: { turnId: 'om_A' },
      reason: 'wake_turn_completed',
    });
    expect(hold.phase()).toBe('IDLE');
    expect(hold.holds('om_A', undefined, T0 + 35_001)).toBe(false);
  });

  it('supports direct-user <task-notification> (no queue-operation), Workflow, legacy ack Agent, and SendMessage resume', () => {
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    hold.reset(T0);

    startHumanTurn(hold, 'om_wf');
    applyClaudeTranscriptEventToAuthorityHold(hold, launchWorkflow('wf_1', T0 + 200), pairer, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(hold, assistantToolUse('Agent', 'tu_legacy', T0 + 300), pairer, T0 + 300);
    applyClaudeTranscriptEventToAuthorityHold(hold, {
      type: 'user',
      uuid: 'ack-legacy',
      timestamp: iso(T0 + 350),
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_legacy', content: 'Async agent launched in the background.\nagentId: ag_legacy' }],
      },
    }, pairer, T0 + 350);
    applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 500), pairer, T0 + 500);
    expect(hold.onForegroundTurnTerminal({ turnId: 'om_wf', status: 'completed' }, T0 + 501)).toBe(true);

    // Direct user wake for wf_1 (ag_legacy still running)
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, deliveredWake(['wf_1'], T0 + 5000), pairer, T0 + 5000))
      .toEqual({ action: 'entered_wake_active', turn: { turnId: 'om_wf' } });
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 6000), pairer, T0 + 6000))
      .toEqual({ action: 'entered_idle_hold', turn: { turnId: 'om_wf' } });
    expect(hold.phase()).toBe('HELD_WAITING_BG');

    // ag_legacy wakes and resumes itself via SendMessage (at newer timestamp)
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, deliveredWake(['ag_legacy'], T0 + 9000), pairer, T0 + 9000).action)
      .toBe('entered_wake_active');
    applyClaudeTranscriptEventToAuthorityHold(hold, resumeAgent('ag_legacy', T0 + 10_000), pairer, T0 + 10_000);
    // Late copy of older stop (atMs < sinceMs) must not settle resumed agent
    applyClaudeTranscriptEventToAuthorityHold(hold, absorbedWakeAttachment(['ag_legacy'], T0 + 9000), pairer, T0 + 10_500);
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 11_000), pairer, T0 + 11_000))
      .toEqual({ action: 'entered_idle_hold', turn: { turnId: 'om_wf' } });
    expect(hold.phase()).toBe('HELD_WAITING_BG');

    // Final completion of resumed agent releases cleanly
    applyClaudeTranscriptEventToAuthorityHold(hold, deliveredWake(['ag_legacy'], T0 + 15_000), pairer, T0 + 15_000);
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 16_000), pairer, T0 + 16_000)).toEqual({
      action: 'revoke',
      turn: { turnId: 'om_wf' },
      reason: 'wake_turn_completed',
    });
  });

  it('handles pre-turn_duration enqueue: absorbed releases at turn_duration, unconsumed enters WAKE_PENDING', () => {
    const holdA = new BackgroundTurnAuthorityHold();
    const pairerA = new LegacyAgentAckPairer();
    holdA.reset(T0);
    startHumanTurn(holdA, 'om_abs');
    applyClaudeTranscriptEventToAuthorityHold(holdA, launchBash('b1', T0 + 100), pairerA, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(holdA, queueNotice('enqueue', ['b1'], 'completed', T0 + 200), pairerA, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(holdA, absorbedWakeAttachment(['b1'], T0 + 250), pairerA, T0 + 250);
    expect(applyClaudeTranscriptEventToAuthorityHold(holdA, turnDuration(T0 + 300), pairerA, T0 + 300).action).toBe('none');
    expect(holdA.phase()).toBe('IDLE');
    expect(holdA.onForegroundTurnTerminal({ turnId: 'om_abs', status: 'completed' }, T0 + 301)).toBe(false);

    const holdB = new BackgroundTurnAuthorityHold();
    const pairerB = new LegacyAgentAckPairer();
    holdB.reset(T0);
    startHumanTurn(holdB, 'om_unabs');
    applyClaudeTranscriptEventToAuthorityHold(holdB, launchBash('b2', T0 + 100), pairerB, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(holdB, queueNotice('enqueue', ['b2'], 'completed', T0 + 200), pairerB, T0 + 200);
    expect(applyClaudeTranscriptEventToAuthorityHold(holdB, turnDuration(T0 + 300), pairerB, T0 + 300))
      .toEqual({ action: 'entered_idle_hold', turn: { turnId: 'om_unabs' } });
    expect(holdB.phase()).toBe('WAKE_PENDING');
    expect(holdB.onForegroundTurnTerminal({ turnId: 'om_unabs', status: 'completed' }, T0 + 301)).toBe(true);
    expect(applyClaudeTranscriptEventToAuthorityHold(holdB, deliveredWake(['b2'], T0 + 330), pairerB, T0 + 330))
      .toEqual({ action: 'entered_wake_active', turn: { turnId: 'om_unabs' } });
    expect(applyClaudeTranscriptEventToAuthorityHold(holdB, turnDuration(T0 + 500), pairerB, T0 + 500))
      .toEqual({ action: 'revoke', turn: { turnId: 'om_unabs' }, reason: 'wake_turn_completed' });
  });

  it('releases immediately (0ms) on killed, stopped, TaskStop, sibling stop, and queue-operation remove', () => {
    for (const status of ['killed', 'stopped'] as const) {
      const hold = new BackgroundTurnAuthorityHold();
      const pairer = new LegacyAgentAckPairer();
      hold.reset(T0);
      startHumanTurn(hold, 'om_kill');
      applyClaudeTranscriptEventToAuthorityHold(hold, launchBash('b1', T0 + 100), pairer, T0 + 100);
      applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 200), pairer, T0 + 200);
      const tr = applyClaudeTranscriptEventToAuthorityHold(
        hold, queueNotice('enqueue', ['b1'], status, T0 + 500), pairer, T0 + 500,
      );
      expect(tr).toEqual({ action: 'revoke', turn: { turnId: 'om_kill' }, reason: 'all_tasks_settled' });
      expect(hold.phase()).toBe('IDLE');
    }

    const holdStop = new BackgroundTurnAuthorityHold();
    const pairerStop = new LegacyAgentAckPairer();
    holdStop.reset(T0);
    startHumanTurn(holdStop, 'om_stop');
    applyClaudeTranscriptEventToAuthorityHold(holdStop, launchBash('b2', T0 + 100), pairerStop, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(holdStop, turnDuration(T0 + 200), pairerStop, T0 + 200);
    expect(applyClaudeTranscriptEventToAuthorityHold(holdStop, taskStopResult('b2', T0 + 300), pairerStop, T0 + 300))
      .toEqual({ action: 'revoke', turn: { turnId: 'om_stop' }, reason: 'all_tasks_settled' });

    const holdSib = new BackgroundTurnAuthorityHold();
    holdSib.reset(T0);
    startHumanTurn(holdSib, 'om_sib');
    holdSib.onTaskLaunched({ taskId: 'b3', kind: 'shell', atMs: T0 + 100 }, T0 + 100);
    holdSib.onForegroundTurnEnded(T0 + 200);
    expect(holdSib.onTaskSettled('b3', { wakes: false, atMs: T0 + 300 }, T0 + 300))
      .toEqual({ action: 'revoke', turn: { turnId: 'om_sib' }, reason: 'all_tasks_settled' });

    const holdRem = new BackgroundTurnAuthorityHold();
    const pairerRem = new LegacyAgentAckPairer();
    holdRem.reset(T0);
    startHumanTurn(holdRem, 'om_rem');
    applyClaudeTranscriptEventToAuthorityHold(holdRem, launchBash('b4', T0 + 100), pairerRem, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(holdRem, turnDuration(T0 + 200), pairerRem, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(holdRem, queueNotice('enqueue', ['b4'], 'completed', T0 + 300), pairerRem, T0 + 300);
    expect(holdRem.phase()).toBe('WAKE_PENDING');
    expect(applyClaudeTranscriptEventToAuthorityHold(holdRem, queueNotice('remove', ['b4'], 'completed', T0 + 350), pairerRem, T0 + 350))
      .toEqual({ action: 'revoke', turn: { turnId: 'om_rem' }, reason: 'wake_pending_removed' });
  });

  it('enforces WAKE_PENDING timeout, maxHoldDurationMs TTL, maxWakeCount cap, and bounded modern missing-turn_duration wake fallback', () => {
    const hold1 = new BackgroundTurnAuthorityHold({ wakePendingTimeoutMs: 5_000 });
    hold1.reset(T0);
    startHumanTurn(hold1, 'om_wp');
    hold1.onTaskLaunched({ taskId: 'b1', kind: 'shell', atMs: T0 + 100 }, T0 + 100);
    hold1.onForegroundTurnEnded(T0 + 200);
    hold1.onTaskSettled('b1', { wakes: true, atMs: T0 + 1000 }, T0 + 1000);
    expect(hold1.phase()).toBe('WAKE_PENDING');
    expect(hold1.nextDeadlineMs()).toBe(T0 + 6000);
    expect(hold1.onTick(T0 + 5999).action).toBe('none');
    expect(hold1.onTick(T0 + 6000)).toEqual({
      action: 'revoke',
      turn: { turnId: 'om_wp' },
      reason: 'wake_pending_timeout',
    });

    const hold2 = new BackgroundTurnAuthorityHold({ maxHoldDurationMs: 60_000 });
    hold2.reset(T0);
    startHumanTurn(hold2, 'om_ttl');
    hold2.onTaskLaunched({ taskId: 'daemon_shell', kind: 'shell', atMs: T0 + 100 }, T0 + 100);
    hold2.onForegroundTurnEnded(T0 + 200);
    expect(hold2.holds('om_ttl', undefined, T0 + 60_199)).toBe(true);
    expect(hold2.holds('om_ttl', undefined, T0 + 60_200)).toBe(false);
    expect(hold2.onTick(T0 + 60_200)).toEqual({
      action: 'revoke',
      turn: { turnId: 'om_ttl' },
      reason: 'hold_ttl_exceeded',
    });

    const hold3 = new BackgroundTurnAuthorityHold({ maxWakeCount: 2 });
    hold3.reset(T0);
    startHumanTurn(hold3, 'om_chain');
    hold3.onTaskLaunched({ taskId: 'c1', kind: 'agent', atMs: T0 + 100 }, T0 + 100);
    hold3.onForegroundTurnEnded(T0 + 200);
    hold3.onWakeDelivered({ taskIds: ['c1'], opensTurn: true, terminalStatus: true, verifiedSystemWake: true, atMs: T0 + 300 }, T0 + 300);
    hold3.onTaskLaunched({ taskId: 'c2', kind: 'agent', atMs: T0 + 350 }, T0 + 350);
    expect(hold3.onWakeTurnEnded('completed', T0 + 400)).toEqual({ action: 'entered_idle_hold', turn: { turnId: 'om_chain' } });
    hold3.onWakeDelivered({ taskIds: ['c2'], opensTurn: true, terminalStatus: true, verifiedSystemWake: true, atMs: T0 + 500 }, T0 + 500);
    hold3.onTaskLaunched({ taskId: 'c3', kind: 'agent', atMs: T0 + 550 }, T0 + 550);
    expect(hold3.onWakeTurnEnded('completed', T0 + 600)).toEqual({
      action: 'revoke',
      turn: { turnId: 'om_chain' },
      reason: 'wake_depth_exceeded',
    });

    // Modern build (durationMarkerSeen=true) whose wake emits end_turn without turn_duration
    // MUST NOT hang 30m — settles at missingDurationMarkerWakeTimeoutMs (or prompt_ready after provisional bound)
    const hold4 = new BackgroundTurnAuthorityHold({ missingDurationMarkerWakeTimeoutMs: 30_000, provisionalWakeEndTimeoutMs: 2_000 });
    const pairer4 = new LegacyAgentAckPairer();
    hold4.reset(T0);
    startHumanTurn(hold4, 'om_nodur');
    applyClaudeTranscriptEventToAuthorityHold(hold4, launchBash('bn1', T0 + 100), pairer4, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hold4, turnDuration(T0 + 200), pairer4, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(hold4, deliveredWake(['bn1'], T0 + 500), pairer4, T0 + 500);
    applyClaudeTranscriptEventToAuthorityHold(hold4, assistantText('done', T0 + 1000), pairer4, T0 + 1000);
    expect(hold4.nextDeadlineMs()).toBe(T0 + 31_000);
    expect(hold4.onTick(T0 + 30_999).action).toBe('none');
    expect(hold4.onTick(T0 + 31_000)).toEqual({ action: 'revoke', turn: { turnId: 'om_nodur' }, reason: 'wake_turn_completed' });
  });

  it('closes wake micro-turns on API error, rate limit, user interrupt (even if bg_2 still runs!), and legacy marker-less provisional bound', () => {
    // Explicit human interrupt during WAKE_ACTIVE MUST revoke immediately even when bg_2 is still live!
    const hIntMulti = new BackgroundTurnAuthorityHold();
    const pIntMulti = new LegacyAgentAckPairer();
    hIntMulti.reset(T0);
    startHumanTurn(hIntMulti, 'om_int_multi');
    applyClaudeTranscriptEventToAuthorityHold(hIntMulti, launchBash('bg_1', T0 + 100), pIntMulti, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hIntMulti, launchBash('bg_2', T0 + 150), pIntMulti, T0 + 150);
    applyClaudeTranscriptEventToAuthorityHold(hIntMulti, turnDuration(T0 + 200), pIntMulti, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(hIntMulti, deliveredWake(['bg_1'], T0 + 300), pIntMulti, T0 + 300);
    expect(applyClaudeTranscriptEventToAuthorityHold(hIntMulti, {
      type: 'user', uuid: 'u-int', timestamp: iso(T0 + 400),
      message: { role: 'user', content: '[Request interrupted by user]' },
    }, pIntMulti, T0 + 400)).toEqual({ action: 'revoke', turn: { turnId: 'om_int_multi' }, reason: 'wake_turn_interrupted' });
    expect(hIntMulti.phase()).toBe('IDLE');

    // Rate-limited or API-error FOREGROUND turn MUST NOT enter HELD_WAITING_BG on turn_duration
    const hRlFg = new BackgroundTurnAuthorityHold();
    const pRlFg = new LegacyAgentAckPairer();
    hRlFg.reset(T0);
    startHumanTurn(hRlFg, 'om_rl_fg');
    applyClaudeTranscriptEventToAuthorityHold(hRlFg, launchBash('bg_rl', T0 + 100), pRlFg, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hRlFg, {
      type: 'assistant', uuid: 'rl-fg', timestamp: iso(T0 + 150), error: 'rate_limit', isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Rate limit' }] },
    }, pRlFg, T0 + 150);
    applyClaudeTranscriptEventToAuthorityHold(hRlFg, turnDuration(T0 + 200), pRlFg, T0 + 200);
    expect(hRlFg.phase()).toBe('IDLE');
    expect(hRlFg.holds('om_rl_fg', undefined, T0 + 201)).toBe(false);

    // API error during WAKE_ACTIVE
    const hErr = new BackgroundTurnAuthorityHold();
    const pErr = new LegacyAgentAckPairer();
    hErr.reset(T0);
    startHumanTurn(hErr, 'om_err');
    applyClaudeTranscriptEventToAuthorityHold(hErr, launchAgent('a1', T0 + 100), pErr, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hErr, turnDuration(T0 + 200), pErr, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(hErr, deliveredWake(['a1'], T0 + 300), pErr, T0 + 300);
    expect(applyClaudeTranscriptEventToAuthorityHold(hErr, {
      type: 'assistant', uuid: 'apierr', timestamp: iso(T0 + 400), isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: '500' }] },
    }, pErr, T0 + 400)).toEqual({ action: 'revoke', turn: { turnId: 'om_err' }, reason: 'wake_turn_failed' });

    // Legacy marker-less build: thinking end_turn followed by tool_use resets timer; final end_turn closes at bound
    const hLeg = new BackgroundTurnAuthorityHold({ provisionalWakeEndTimeoutMs: 2_000 });
    const pLeg = new LegacyAgentAckPairer();
    hLeg.reset(T0);
    startHumanTurn(hLeg, 'om_leg');
    applyClaudeTranscriptEventToAuthorityHold(hLeg, launchBash('b_leg', T0 + 100), pLeg, T0 + 100);
    expect(hLeg.onForegroundTurnTerminal({ turnId: 'om_leg', status: 'completed' }, T0 + 200)).toBe(true);
    applyClaudeTranscriptEventToAuthorityHold(hLeg, deliveredWake(['b_leg'], T0 + 500), pLeg, T0 + 500);
    applyClaudeTranscriptEventToAuthorityHold(hLeg, {
      type: 'assistant', uuid: 'th1', timestamp: iso(T0 + 600),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'run lark' }] },
    }, pLeg, T0 + 600);
    applyClaudeTranscriptEventToAuthorityHold(hLeg, assistantToolUse('Bash', 'tu1', T0 + 700), pLeg, T0 + 700);
    expect(hLeg.onTick(T0 + 5_000).action).toBe('none');
    expect(hLeg.holds('om_leg', undefined, T0 + 5_000)).toBe(true);
    applyClaudeTranscriptEventToAuthorityHold(hLeg, assistantText('all done', T0 + 6_000), pLeg, T0 + 6_000);
    expect(hLeg.onTick(T0 + 8_000)).toEqual({ action: 'revoke', turn: { turnId: 'om_leg' }, reason: 'wake_turn_completed' });
  });
});

describe('BackgroundTurnAuthorityHold — fail-closed security & isolation', () => {
  it('excludes monitors (both persistent and bounded) and fails closed if a monitor notifies during another hold', () => {
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    hold.reset(T0);

    startHumanTurn(hold, 'om_mon');
    applyClaudeTranscriptEventToAuthorityHold(hold, launchMonitor('m_persist', true, T0 + 100), pairer, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hold, launchMonitor('m_bounded', false, T0 + 150, 30_000), pairer, T0 + 150);
    applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 200), pairer, T0 + 200);
    expect(hold.onForegroundTurnTerminal({ turnId: 'om_mon', status: 'completed' }, T0 + 201)).toBe(false);
    expect(hold.phase()).toBe('IDLE');

    startHumanTurn(hold, 'om_mix');
    applyClaudeTranscriptEventToAuthorityHold(hold, launchBash('bg_ok', T0 + 300), pairer, T0 + 300);
    applyClaudeTranscriptEventToAuthorityHold(hold, launchMonitor('m_ext', true, T0 + 350), pairer, T0 + 350);
    applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 400), pairer, T0 + 400);
    expect(hold.phase()).toBe('HELD_WAITING_BG');
    expect(applyClaudeTranscriptEventToAuthorityHold(
      hold, deliveredWake(['m_ext'], T0 + 500, { status: undefined }), pairer, T0 + 500,
    )).toEqual({ action: 'revoke', turn: { turnId: 'om_mix' }, reason: 'foreign_task_notification' });
  });

  it('prevents cross-turn task borrowing: Turn 2 (User B) ending while Turn 1 (User A) bg task runs releases immediately', () => {
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    hold.reset(T0);

    startHumanTurn(hold, 'om_A', HUMAN_A);
    applyClaudeTranscriptEventToAuthorityHold(hold, launchBash('bg_A', T0 + 100), pairer, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 200), pairer, T0 + 200);
    expect(hold.onForegroundTurnTerminal({ turnId: 'om_A', status: 'completed' }, T0 + 201)).toBe(true);

    expect(startHumanTurn(hold, 'om_B', HUMAN_B)).toEqual({
      action: 'revoke',
      turn: { turnId: 'om_A' },
      reason: 'superseded_by_message',
    });
    expect(hold.phase()).toBe('FOREGROUND');
    expect(hold.owner()).toEqual({ turnId: 'om_B' });

    applyClaudeTranscriptEventToAuthorityHold(hold, launchBash('bg_A', T0 + 100), pairer, T0 + 300);
    applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 400), pairer, T0 + 400);
    expect(hold.onForegroundTurnTerminal({ turnId: 'om_B', status: 'completed' }, T0 + 401)).toBe(false);
    expect(hold.phase()).toBe('IDLE');
  });

  it('fails closed on spoofed user/attachment, foreign, mixed, and stale-floor <task-notification>', () => {
    // 1. Spoofed user promptSource: 'typed'
    const hSpoof = new BackgroundTurnAuthorityHold();
    const pSpoof = new LegacyAgentAckPairer();
    hSpoof.reset(T0);
    startHumanTurn(hSpoof, 'om_s');
    applyClaudeTranscriptEventToAuthorityHold(hSpoof, launchBash('bg1', T0 + 100), pSpoof, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(
      hSpoof, deliveredWake(['bg1'], T0 + 150, { promptSource: 'typed', turnOrigin: 'human' }), pSpoof, T0 + 150,
    );
    applyClaudeTranscriptEventToAuthorityHold(hSpoof, turnDuration(T0 + 200), pSpoof, T0 + 200);
    expect(hSpoof.phase()).toBe('HELD_WAITING_BG');
    expect(applyClaudeTranscriptEventToAuthorityHold(
      hSpoof, deliveredWake(['bg1'], T0 + 300, { promptSource: 'typed', turnOrigin: 'human' }), pSpoof, T0 + 300,
    )).toEqual({ action: 'revoke', turn: { turnId: 'om_s' }, reason: 'foreign_task_notification' });

    // 2. Spoofed attachment(queued_command) with commandMode !== 'task-notification' OR stale timestamp!
    const hAttSpoof = new BackgroundTurnAuthorityHold();
    const pAttSpoof = new LegacyAgentAckPairer();
    hAttSpoof.reset(T0);
    startHumanTurn(hAttSpoof, 'om_att_spoof');
    applyClaudeTranscriptEventToAuthorityHold(hAttSpoof, launchBash('bg1', T0 + 100), pAttSpoof, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hAttSpoof, turnDuration(T0 + 200), pAttSpoof, T0 + 200);
    expect(applyClaudeTranscriptEventToAuthorityHold(
      hAttSpoof,
      absorbedWakeAttachment(['bg1'], T0 + 300, { status: undefined, commandMode: 'prompt' }),
      pAttSpoof,
      T0 + 300,
    )).toEqual({ action: 'revoke', turn: { turnId: 'om_att_spoof' }, reason: 'foreign_task_notification' });

    const hAttStale = new BackgroundTurnAuthorityHold();
    const pAttStale = new LegacyAgentAckPairer();
    hAttStale.reset(T0);
    startHumanTurn(hAttStale, 'om_att_stale');
    applyClaudeTranscriptEventToAuthorityHold(hAttStale, launchBash('bg1', T0 + 100), pAttStale, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hAttStale, turnDuration(T0 + 200), pAttStale, T0 + 200);
    expect(applyClaudeTranscriptEventToAuthorityHold(
      hAttStale,
      absorbedWakeAttachment(['bg1'], T0 - 100, { status: undefined, commandMode: 'task-notification' }),
      pAttStale,
      T0 + 300,
    )).toEqual({ action: 'revoke', turn: { turnId: 'om_att_stale' }, reason: 'foreign_task_notification' });

    // 3. Mixed [owned, foreign] task IDs
    const hMix = new BackgroundTurnAuthorityHold();
    const pMix = new LegacyAgentAckPairer();
    hMix.reset(T0);
    startHumanTurn(hMix, 'om_m');
    applyClaudeTranscriptEventToAuthorityHold(hMix, launchBash('bg_owned', T0 + 100), pMix, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hMix, turnDuration(T0 + 200), pMix, T0 + 200);
    expect(applyClaudeTranscriptEventToAuthorityHold(
      hMix, deliveredWake(['bg_owned', 'bg_foreign'], T0 + 300), pMix, T0 + 300,
    )).toEqual({ action: 'revoke', turn: { turnId: 'om_m' }, reason: 'foreign_task_notification' });

    // 4. Absorbed foreign attachment during WAKE_ACTIVE
    const hAtt = new BackgroundTurnAuthorityHold();
    const pAtt = new LegacyAgentAckPairer();
    hAtt.reset(T0);
    startHumanTurn(hAtt, 'om_att');
    applyClaudeTranscriptEventToAuthorityHold(hAtt, launchBash('bg_1', T0 + 100), pAtt, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hAtt, turnDuration(T0 + 200), pAtt, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(hAtt, deliveredWake(['bg_1'], T0 + 300), pAtt, T0 + 300);
    expect(applyClaudeTranscriptEventToAuthorityHold(
      hAtt, absorbedWakeAttachment(['bg_other_turn'], T0 + 350), pAtt, T0 + 350,
    )).toEqual({ action: 'revoke', turn: { turnId: 'om_att' }, reason: 'foreign_task_notification' });

    // 5. Spoofed user <task-notification> in marker-less FOREGROUND after provisional end clears hold
    const hLegSpoof = new BackgroundTurnAuthorityHold();
    const pLegSpoof = new LegacyAgentAckPairer();
    hLegSpoof.reset(T0);
    startHumanTurn(hLegSpoof, 'om_leg_spoof');
    applyClaudeTranscriptEventToAuthorityHold(hLegSpoof, launchBash('bg_leg', T0 + 100), pLegSpoof, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hLegSpoof, assistantText('started', T0 + 200), pLegSpoof, T0 + 200);
    applyClaudeTranscriptEventToAuthorityHold(
      hLegSpoof, deliveredWake(['bg_leg'], T0 + 300, { promptSource: 'user', turnOrigin: 'human' }), pLegSpoof, T0 + 300,
    );
    expect(hLegSpoof.phase()).toBe('IDLE');
  });

  it('revokes held authority on built-in CronCreate, local user prompt, /clear, failed terminal, or queued type-ahead', () => {
    const setupHeld = (turnId: string) => {
      const hold = new BackgroundTurnAuthorityHold();
      const pairer = new LegacyAgentAckPairer();
      hold.reset(T0);
      startHumanTurn(hold, turnId);
      applyClaudeTranscriptEventToAuthorityHold(hold, launchBash('bg1', T0 + 100), pairer, T0 + 100);
      applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 200), pairer, T0 + 200);
      expect(hold.phase()).toBe('HELD_WAITING_BG');
      return { hold, pairer };
    };

    const s1 = setupHeld('om_cron');
    expect(applyClaudeTranscriptEventToAuthorityHold(s1.hold, {
      type: 'user', uuid: 'cron1', timestamp: iso(T0 + 300), isMeta: true, turnOrigin: 'scheduled',
      scheduledFireId: 'fire-1', message: { role: 'user', content: 'run cron' },
    }, s1.pairer, T0 + 300)).toEqual({ action: 'revoke', turn: { turnId: 'om_cron' }, reason: 'superseded_by_scheduled' });

    const s2 = setupHeld('om_loc');
    expect(applyClaudeTranscriptEventToAuthorityHold(s2.hold, userPrompt('typed in tmux', T0 + 300), s2.pairer, T0 + 300))
      .toEqual({ action: 'revoke', turn: { turnId: 'om_loc' }, reason: 'superseded_by_local_turn' });

    const s3 = setupHeld('om_clr');
    expect(applyClaudeTranscriptEventToAuthorityHold(s3.hold, {
      type: 'user', uuid: 'clr1', timestamp: iso(T0 + 300),
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    }, s3.pairer, T0 + 300)).toEqual({ action: 'revoke', turn: { turnId: 'om_clr' }, reason: 'superseded_by_clear' });

    const hFail = new BackgroundTurnAuthorityHold();
    hFail.reset(T0);
    startHumanTurn(hFail, 'om_f');
    hFail.onTaskLaunched({ taskId: 'b1', kind: 'shell', atMs: T0 + 100 }, T0 + 100);
    expect(hFail.onForegroundTurnTerminal({ turnId: 'om_f', status: 'failed' }, T0 + 200)).toBe(false);
    expect(hFail.phase()).toBe('IDLE');

    const hQ = new BackgroundTurnAuthorityHold();
    hQ.reset(T0);
    startHumanTurn(hQ, 'om_q');
    hQ.onTaskLaunched({ taskId: 'b1', kind: 'shell', atMs: T0 + 100 }, T0 + 100);
    expect(hQ.onForegroundTurnTerminal({ turnId: 'om_q', status: 'completed', hasQueuedTypeAhead: true }, T0 + 200)).toBe(false);
    expect(hQ.phase()).toBe('IDLE');
  });

  it('ignores api-request-blob in hold mapper, classifyClaudeTerminalEvent, and AbsorbedReplyCollector', () => {
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    hold.reset(T0);
    startHumanTurn(hold, 'om_blob');
    applyClaudeTranscriptEventToAuthorityHold(hold, launchAgent('ag1', T0 + 100), pairer, T0 + 100);
    applyClaudeTranscriptEventToAuthorityHold(hold, turnDuration(T0 + 200), pairer, T0 + 200);
    expect(hold.phase()).toBe('HELD_WAITING_BG');

    expect(applyClaudeTranscriptEventToAuthorityHold(hold, {
      type: 'api-request-blob',
      message: { role: 'user', content: '<system-reminder>copied</system-reminder>' },
    }, pairer, T0 + 300).action).toBe('none');
    expect(applyClaudeTranscriptEventToAuthorityHold(hold, {
      type: 'api-request-blob',
      message: { role: 'user', content: '<task-notification><task-id>ag1</task-id><status>completed</status></task-notification>' },
    }, pairer, T0 + 310).action).toBe('none');
    expect(hold.phase()).toBe('HELD_WAITING_BG');

    // Direct helpers also ignore api-request-blob (even if synthetic uuid or error flags appear)
    expect(classifyClaudeTerminalEvent({
      type: 'api-request-blob',
      error: 'rate_limit',
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Rate limit' }] },
    })).toBeUndefined();

    const arc = new AbsorbedReplyCollector();
    expect(arc.feed({
      type: 'api-request-blob',
      uuid: 'blob-uuid-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'copied reply' }] },
    })).toBe(false);
    expect(arc.reply()).toBeUndefined();
  });
});
