import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';
import {
  RESTART_TASK_MAX_AGE_MS,
  claudeInterruptedWork,
  hasInterruptedWork,
  mergeInterruptedWork,
  prefixRestartNote,
  restartInterruptionNote,
  restartInterruptionNotice,
  restartNoteInput,
  restartNoteMayPrefix,
  shouldSuppressRestartInterruptionScan,
  structuredTurnOpen,
  transcriptTailOffset,
  withoutReportedTasks,
} from '../src/services/restart-interruption.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';

describe('shouldSuppressRestartInterruptionScan', () => {
  // Full truth table: cause, CLI, requested-id presence and id equality.
  // Both ids undefined satisfy equality but must still leave scanning enabled.
  it.each([
    [true, 'traex-auto-model', 'traex', 'native', 'native'],
    [false, 'traex-auto-model', 'traex', 'native', 'other'],
    [false, 'traex-auto-model', 'traex', undefined, undefined],
    [false, 'traex-auto-model', 'traex', undefined, 'native'],
    [false, 'traex-auto-model', 'codex', 'native', 'native'],
    [false, 'traex-auto-model', 'codex', 'native', 'other'],
    [false, 'traex-auto-model', 'codex', undefined, undefined],
    [false, 'traex-auto-model', 'codex', undefined, 'native'],
    [false, undefined, 'traex', 'native', 'native'],
    [false, undefined, 'traex', 'native', 'other'],
    [false, undefined, 'traex', undefined, undefined],
    [false, undefined, 'traex', undefined, 'native'],
    [false, undefined, 'codex', 'native', 'native'],
    [false, undefined, 'codex', 'native', 'other'],
    [false, undefined, 'codex', undefined, undefined],
    [false, undefined, 'codex', undefined, 'native'],
    [false, 'traex-auto-model', 'traex', 'native', undefined],
  ] as const)('suppress=%s with cause=%s, CLI=%s, requested=%s, effective=%s',
    (suppress, restartCause, cliId, exactResumeSessionId, effectiveCliSessionId) => {
      expect(shouldSuppressRestartInterruptionScan({
        restartCause, cliId, exactResumeSessionId, effectiveCliSessionId,
      })).toBe(suppress);
    });
});

// Record shapes follow Claude Code 2.1.305 transcripts from the 10-21 tmux
// server loss (ids and texts are synthetic).
const at = (hhmmss: string): string => `2026-10-20T${hhmmss}.000Z`;

function prompt(uuid: string, ts: string, text = 'please watch CI'): TranscriptEvent {
  return { type: 'user', uuid, timestamp: at(ts), message: { role: 'user', content: text } } as TranscriptEvent;
}

function toolUse(uuid: string, ts: string, id: string, name: string, input: Record<string, unknown>): TranscriptEvent {
  return {
    type: 'assistant', uuid, timestamp: at(ts),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
  } as TranscriptEvent;
}

function toolResult(uuid: string, ts: string, toolUseId: string, toolUseResult: unknown, text = 'ok'): TranscriptEvent {
  return {
    type: 'user', uuid, timestamp: at(ts),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    toolUseResult,
  } as TranscriptEvent;
}

function endTurn(uuid: string, ts: string): TranscriptEvent[] {
  return [
    { type: 'assistant', uuid, timestamp: at(ts), message: { role: 'assistant', content: [{ type: 'text', text: 'Waiting for the background job.' }], stop_reason: 'end_turn' } } as TranscriptEvent,
    { type: 'system', subtype: 'turn_duration', timestamp: at(ts) } as TranscriptEvent,
  ];
}

function notice(taskIds: string[], status: string | undefined, summary: string): string {
  return `<task-notification>\n${taskIds.map(id => `<task-id>${id}</task-id>`).join('\n')}\n`
    + `${status ? `<status>${status}</status>\n` : ''}<summary>${summary}</summary>\n</task-notification>`;
}

function enqueue(ts: string, content: string): TranscriptEvent {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: at(ts), content } as TranscriptEvent;
}

/** Bash `run_in_background` launch (tool_use + structured result). */
function bashLaunch(n: number, ts: string, taskId: string, description: string): TranscriptEvent[] {
  return [
    toolUse(`a-bash-${n}`, ts, `call-bash-${n}`, 'Bash', { command: 'gh run watch 1', description, run_in_background: true }),
    toolResult(`u-bash-${n}`, ts, `call-bash-${n}`, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId }),
  ];
}

/** Monitor launch: `{ taskId, timeoutMs, persistent }`. */
function monitorLaunch(n: number, ts: string, taskId: string, description: string, timeoutMs = 1_800_000): TranscriptEvent[] {
  return [
    toolUse(`a-mon-${n}`, ts, `call-mon-${n}`, 'Monitor', { command: 'while true; do sleep 45; done', description, persistent: false, timeout_ms: timeoutMs }),
    toolResult(`u-mon-${n}`, ts, `call-mon-${n}`, { taskId, timeoutMs, persistent: false }),
  ];
}

const RESTART = Date.parse(at('20:43:13'));

describe('claudeInterruptedWork — background tasks', () => {
  it('reports tasks the process killed on its way out (10-21 tmux loss), with their descriptions', () => {
    const events = [
      prompt('p1', '20:10:00'),
      ...bashLaunch(1, '20:10:05', 'bqcj23cgb', 'Wait for CI run 39487179085 to complete'),
      ...monitorLaunch(2, '20:19:43', 'bz776ff12', 'PR1620 test2/3 rerun completion'),
      ...endTurn('a-end', '20:20:00'),
      // SIGHUP: Claude Code stops every running task, then dies.
      enqueue('20:42:58', notice(['bqcj23cgb'], 'killed', 'Background command "Wait for CI run 39487179085 to complete" was stopped')),
      enqueue('20:42:58', notice(['bz776ff12'], 'killed', 'Monitor "PR1620 test2/3 rerun completion" stopped')),
      // The resumed process's own orphan notice (after the restart instant) is not the old process's state.
      enqueue('20:43:16', notice(['bqcj23cgb', '__orphan_summary__:shell'], 'stopped', "didn't finish before the previous session ended")),
    ];
    const work = claudeInterruptedWork(events, RESTART);
    expect(work.turnOpen).toBe(false);
    expect(work.tasks).toEqual([
      { taskId: 'bqcj23cgb', kind: 'shell', description: 'Wait for CI run 39487179085 to complete' },
      { taskId: 'bz776ff12', kind: 'monitor', description: 'PR1620 test2/3 rerun completion' },
    ]);
    expect(hasInterruptedWork(work)).toBe(true);
  });

  it('reports a background run killed by a suspend (the #1959 shape)', () => {
    const events = [
      prompt('p1', '17:20:00', 'run the full unit suite'),
      ...bashLaunch(1, '17:22:02', 'b2ljqce5p', 'Run full unit suite in background'),
      ...endTurn('a-end', '17:23:22'),
      enqueue('19:04:53', notice(['b2ljqce5p'], 'killed', 'Background command "Run full unit suite in background" was stopped')),
    ];
    expect(claudeInterruptedWork(events, Date.parse(at('23:14:16'))).tasks.map(task => task.taskId)).toEqual(['b2ljqce5p']);
  });

  it('still reports the kill when the dying process starts dequeuing its notice (seen with a real tmux kill-server)', () => {
    const events = [
      ...bashLaunch(1, '00:01:14', 'bzbnqc41l', 'Wait for CI run 123 to complete'),
      ...endTurn('a-end', '00:01:20'),
      enqueue('00:01:24', notice(['bzbnqc41l'], 'killed', 'Background command "Wait for CI run 123 to complete" was stopped')),
      { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-20T00:01:24.200Z' } as TranscriptEvent,
    ];
    expect(claudeInterruptedWork(events, Date.parse(at('00:01:38'))).tasks.map(task => task.taskId)).toEqual(['bzbnqc41l']);
  });

  it('a task the process lived on after killing (TUI stop) is not reported', () => {
    const events = [
      ...bashLaunch(1, '10:00:00', 'b1', 'long job'),
      enqueue('10:01:00', notice(['b1'], 'killed', 'Background command "long job" was stopped')),
      prompt('p2', '10:02:00', 'next'),
      ...endTurn('a-end', '10:02:10'),
    ];
    expect(claudeInterruptedWork(events, Date.parse(at('11:00:00'))).tasks).toEqual([]);
  });

  it('with botmux\'s record of when the process ended, a stop made long before it is not an exit kill', () => {
    // Idle session: the user stops the monitor from the TUI's task dialog at
    // 10:01; Claude Code wakes no one, so that stop is the last record. The CLI
    // dies at 16:00.
    const events = [
      ...monitorLaunch(1, '10:00:00', 'm1', 'watch CI', 0),
      ...endTurn('a-end', '10:00:05'),
      enqueue('10:01:00', notice(['m1'], 'killed', 'Monitor "watch CI" stopped')),
    ];
    const restartAt = Date.parse(at('16:00:20'));
    expect(claudeInterruptedWork(events, restartAt, { processEndedAtMs: Date.parse(at('16:00:00')) }).tasks).toEqual([]);
    // The transcript alone cannot tell (new worker, no record): reported.
    expect(claudeInterruptedWork(events, restartAt).tasks.map(task => task.taskId)).toEqual(['m1']);
    // A real exit kill is a few seconds before the observed end (12–22 s on 10-21).
    expect(claudeInterruptedWork(events, Date.parse(at('10:01:30')), { processEndedAtMs: Date.parse(at('10:01:22')) })
      .tasks.map(task => task.taskId)).toEqual(['m1']);
  });

  it('a task still running with no stop record at all is reported (process killed without writing one)', () => {
    const events = [...bashLaunch(1, '10:00:00', 'b1', 'watch deploy'), ...endTurn('a-end', '10:00:05')];
    expect(claudeInterruptedWork(events, Date.parse(at('10:30:00'))).tasks.map(task => task.taskId)).toEqual(['b1']);
  });

  it('completed tasks, TaskStop, expired Monitors and day-old launches are not reported', () => {
    const events = [
      ...bashLaunch(1, '10:00:00', 'done', 'finished job'),
      { type: 'user', timestamp: at('10:05:00'), message: { role: 'user', content: notice(['done'], 'completed', 'done') } } as TranscriptEvent,
      ...bashLaunch(2, '10:06:00', 'stopped-by-model', 'stopped job'),
      toolResult('u-stop', '10:07:00', 'call-stop', { message: 'Successfully stopped task', task_id: 'stopped-by-model', task_type: 'local_bash' }),
      ...monitorLaunch(3, '10:08:00', 'short-monitor', 'five minutes', 300_000),
      ...endTurn('a-end', '10:08:10'),
    ];
    expect(claudeInterruptedWork(events, Date.parse(at('10:30:00'))).tasks).toEqual([]);

    const old = [...bashLaunch(1, '10:00:00', 'ancient', 'forgotten'), ...endTurn('a-end', '10:00:05')];
    expect(claudeInterruptedWork(old, Date.parse(at('10:00:06')) + RESTART_TASK_MAX_AGE_MS + 1).tasks).toEqual([]);
  });

  it('pairs the legacy Agent dispatch with its launch-ack', () => {
    const events = [
      toolUse('a1', '10:00:00', 'tu-1', 'Agent', { description: 'Inventory tmux call sites', prompt: 'p', run_in_background: true }),
      toolResult('u1', '10:00:01', 'tu-1', undefined, 'Async agent launched in the background.\nagentId: agent-7'),
      ...endTurn('a-end', '10:00:05'),
    ];
    expect(claudeInterruptedWork(events, Date.parse(at('10:10:00'))).tasks)
      .toEqual([{ taskId: 'agent-7', kind: 'agent', description: 'Inventory tmux call sites' }]);
  });
});

describe('claudeInterruptedWork — the main turn', () => {
  const BEFORE = Date.parse(at('12:00:00'));

  it('a turn cut off between tool calls is open; one that reached its terminal record is not', () => {
    const cut = [
      prompt('p1', '11:00:00', 'review PR 2072'),
      toolUse('a1', '11:00:10', 'call-1', 'Bash', { command: 'git diff' }),
      toolResult('u1', '11:00:11', 'call-1', { stdout: 'diff' }),
    ];
    expect(claudeInterruptedWork(cut, BEFORE).turnOpen).toBe(true);
    expect(claudeInterruptedWork([...cut, ...endTurn('a-end', '11:05:00')], BEFORE).turnOpen).toBe(false);
  });

  it('a prompt the model never answered is open', () => {
    expect(claudeInterruptedWork([prompt('p1', '11:00:00')], BEFORE).turnOpen).toBe(true);
  });

  it('an Esc interrupt closes the turn: the user stopped it, nothing was cut off', () => {
    const events = [
      prompt('p1', '11:00:00'),
      toolUse('a1', '11:00:10', 'call-1', 'Bash', { command: 'sleep 100' }),
      { type: 'user', timestamp: at('11:00:20'), interruptedMessageId: 'msg_1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } } as TranscriptEvent,
    ];
    expect(claudeInterruptedWork(events, BEFORE).turnOpen).toBe(false);
  });

  it('a delivered task notification the model never answered (resume orphan) does not open the turn', () => {
    const orphan = { type: 'user', timestamp: at('11:30:00'), message: { role: 'user', content: notice(['b1'], 'stopped', "didn't finish before the previous session ended") } } as TranscriptEvent;
    const events = [prompt('p1', '11:00:00'), ...endTurn('a-end', '11:00:05'), orphan];
    expect(claudeInterruptedWork(events, BEFORE).turnOpen).toBe(false);
    // Once the model starts answering it, the woken turn is open.
    const answering = toolUse('a2', '11:30:05', 'call-2', 'Bash', { command: 'cat out' });
    expect(claudeInterruptedWork([...events, answering], BEFORE).turnOpen).toBe(true);
  });

  it('records at or after the restart instant are ignored, sidechain records never count', () => {
    const events = [
      ...endTurn('a-end', '11:00:05'),
      prompt('p-new', '12:00:00'),
      { ...toolUse('side', '11:30:00', 'side-1', 'Bash', { command: 'x' }), isSidechain: true } as TranscriptEvent,
    ];
    expect(claudeInterruptedWork(events, BEFORE).turnOpen).toBe(false);
  });
});

describe('mergeInterruptedWork', () => {
  it('keeps an undelivered earlier result: the dead resumed process\'s own records settled its tasks', () => {
    const earlier = { turnOpen: true, tasks: [{ taskId: 'b1', kind: 'shell' as const, description: 'poll CI' }] };
    const later = { turnOpen: false, tasks: [{ taskId: 'b2', kind: 'monitor' as const }] };
    expect(mergeInterruptedWork(earlier, later)).toEqual({ turnOpen: true, tasks: [earlier.tasks[0], later.tasks[0]] });
    expect(mergeInterruptedWork(undefined, later)).toBe(later);
    // The same task seen again keeps the newer record, once.
    const again = { turnOpen: false, tasks: [{ taskId: 'b1', kind: 'shell' as const }] };
    expect(mergeInterruptedWork(earlier, again).tasks).toEqual([{ taskId: 'b1', kind: 'shell' }]);
  });
});

describe('withoutReportedTasks', () => {
  it('drops tasks this worker already reported and keeps the turn as is', () => {
    const work = { turnOpen: true, tasks: [{ taskId: 'b1', kind: 'shell' as const }, { taskId: 'b2', kind: 'monitor' as const }] };
    expect(withoutReportedTasks(work, new Set(['b1']))).toEqual({ turnOpen: true, tasks: [{ taskId: 'b2', kind: 'monitor' }] });
    expect(hasInterruptedWork(withoutReportedTasks({ turnOpen: false, tasks: [work.tasks[0]] }, new Set(['b1'])))).toBe(false);
  });
});

describe('structuredTurnOpen (Pi / Codex / Grok bridge events)', () => {
  const ev = (kind: 'user' | 'turn_started' | 'assistant_final' | 'turn_aborted' | 'turn_bind' | 'cot', timestampMs: number) => ({ kind, timestampMs });

  it('a Pi review cut off mid tool call is open; a final or an abort closes it', () => {
    expect(structuredTurnOpen([ev('user', 1), ev('cot', 2), ev('cot', 3)], 10)).toBe(true);
    expect(structuredTurnOpen([ev('user', 1), ev('cot', 2), ev('assistant_final', 3)], 10)).toBe(false);
    expect(structuredTurnOpen([ev('user', 1), ev('turn_aborted', 2)], 10)).toBe(false);
    expect(structuredTurnOpen([ev('turn_started', 1)], 10)).toBe(true);
    expect(structuredTurnOpen([ev('turn_bind', 1)], 10)).toBe(false);
    // A stray cot after the final does not reopen it.
    expect(structuredTurnOpen([ev('user', 1), ev('assistant_final', 2), ev('cot', 3)], 10)).toBe(false);
  });

  it('only events before the restart instant count, and a window starting mid-turn still reads open', () => {
    expect(structuredTurnOpen([ev('assistant_final', 1), ev('user', 10)], 10)).toBe(false);
    expect(structuredTurnOpen([ev('cot', 1), ev('cot', 2)], 10)).toBe(true);
  });
});

describe('transcriptTailOffset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-tail-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads small files whole and starts large ones on a line boundary', () => {
    const path = join(dir, 't.jsonl');
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(50) }));
    writeFileSync(path, `${lines.join('\n')}\n`);
    expect(transcriptTailOffset(path, 1_000_000)).toBe(0);
    const offset = transcriptTailOffset(path, 500);
    const text = `${lines.join('\n')}\n`;
    expect(text[offset - 1]).toBe('\n');
    expect(text.length - offset).toBeLessThanOrEqual(500);
    expect(() => JSON.parse(text.slice(offset).split('\n')[0])).not.toThrow();
  });
});

describe('note and notice text', () => {
  // Expectations are built from the same i18n keys, so these pin which parts a
  // message is made of, not its wording.
  const kind = (k: 'shell' | 'monitor' | 'agent') => t(`worker.restart_interrupted.kind.${k}`);

  it('the note says the turn was cut off and names each task with its kind and id', () => {
    setDefaultLocale('zh');
    const work = {
      turnOpen: true,
      tasks: [
        { taskId: 'b1', kind: 'shell' as const, description: 'Wait for CI run 1 to complete' },
        { taskId: 'm1', kind: 'monitor' as const },
      ],
    };
    const note = restartInterruptionNote(work);
    expect(note).toContain(t('worker.restart_interrupted.note_turn'));
    expect(note).toContain(t('worker.restart_interrupted.task', { name: 'Wait for CI run 1 to complete', kind: kind('shell'), id: 'b1' }));
    expect(note).toContain(t('worker.restart_interrupted.task_unnamed', { kind: kind('monitor'), id: 'm1' }));
    expect(restartInterruptionNote({ turnOpen: false, tasks: work.tasks })).not.toContain(t('worker.restart_interrupted.note_turn'));
    expect(restartInterruptionNote({ turnOpen: true, tasks: [] }))
      .not.toContain(t('worker.restart_interrupted.task_unnamed', { kind: kind('monitor'), id: 'm1' }));
  });

  it('the notice tells whether the CLI was handed the note', () => {
    setDefaultLocale('zh');
    const work = { turnOpen: true, tasks: [] };
    const details = t('worker.restart_interrupted.notice_turn');
    expect(restartInterruptionNotice(work, { cliName: 'Claude', noteDelivered: true }))
      .toBe(t('worker.restart_interrupted.notice', { cliName: 'Claude', details }));
    expect(restartInterruptionNotice(work, { cliName: 'Claude', noteDelivered: false }))
      .toBe(t('worker.restart_interrupted.notice_no_note', { cliName: 'Claude', details }));
  });

  it('a long task list shows the first five and counts the rest', () => {
    setDefaultLocale('zh');
    const many = { turnOpen: false, tasks: Array.from({ length: 7 }, (_, i) => ({ taskId: `t${i}`, kind: 'shell' as const })) };
    const notice = restartInterruptionNotice(many, { cliName: 'Claude', noteDelivered: true });
    for (let i = 0; i < 5; i++) expect(notice).toContain(`t${i}`);
    expect(notice).not.toContain('t5');
    expect(notice).toContain(t('worker.restart_interrupted.more_tasks', { count: 2 }));
    expect(notice).toContain(t('worker.restart_interrupted.notice_tasks', {
      count: 7,
      tasks: `${many.tasks.slice(0, 5).map(task => t('worker.restart_interrupted.task_unnamed', { kind: kind('shell'), id: task.taskId })).join(t('worker.restart_interrupted.list_separator'))}${t('worker.restart_interrupted.more_tasks', { count: 2 })}`,
    }));
  });

  it('follows the bot locale', () => {
    const work = { turnOpen: true, tasks: [{ taskId: 'b1', kind: 'shell' as const, description: 'poll CI' }] };
    setDefaultLocale('zh');
    const zh = restartInterruptionNote(work);
    setDefaultLocale('en');
    try {
      const en = restartInterruptionNote(work);
      expect(en).not.toBe(zh);
      expect(en).toBe(t('worker.restart_interrupted.note', {
        details: t('worker.restart_interrupted.note_turn', undefined, 'en')
          + t('worker.restart_interrupted.note_tasks', {
            tasks: t('worker.restart_interrupted.task', { name: 'poll CI', kind: t('worker.restart_interrupted.kind.shell', undefined, 'en'), id: 'b1' }, 'en'),
          }, 'en'),
      }, 'en'));
    } finally {
      setDefaultLocale('zh');
    }
  });
});

describe('carrying the note to the resumed CLI', () => {
  it('prefixes the next input but keeps its logical content for turn attribution', () => {
    const item = { content: '<botmux_routing>…</botmux_routing>\nmerge it', turnId: 'om_2' };
    const prefixed = prefixRestartNote(item, 'NOTE');
    expect(prefixed.content).toBe(`NOTE\n\n${item.content}`);
    expect(prefixed.logicalContent).toBe(item.content);
    expect(prefixRestartNote({ content: 'x', logicalContent: '/cmd x' }, 'NOTE').logicalContent).toBe('/cmd x');
    // Replayed after a second restart: the newer note replaces the older one.
    const again = prefixRestartNote(prefixed, 'NOTE 2');
    expect(again.content).toBe(`NOTE 2\n\n${item.content}`);
    expect(again.logicalContent).toBe(item.content);
  });

  it('never mixes the note into durable, meeting, Codex App or continuation inputs', () => {
    expect(restartNoteMayPrefix({ content: 'x', turnId: 'om_1' })).toBe(true);
    expect(restartNoteMayPrefix({ content: 'x', dispatchAttempt: 1 })).toBe(false);
    expect(restartNoteMayPrefix({ content: 'x', durablePrimaryInbox: true })).toBe(false);
    expect(restartNoteMayPrefix({ content: 'x', codexAppDispatchId: 'd' })).toBe(false);
  });

  it('a standalone note continues the last turn with its caller identity only', () => {
    const template = {
      content: 'original',
      logicalContent: 'original',
      turnId: 'om_1',
      turnCallerOpenId: 'ou_a',
      trustedCaller: { requestUserOpenId: 'ou_a' } as any,
      nativeSessionTitle: 'title',
      noReplay: true,
    };
    expect(restartNoteInput(template, 'NOTE')).toEqual({
      content: 'NOTE', turnId: 'om_1', turnCallerOpenId: 'ou_a', trustedCaller: { requestUserOpenId: 'ou_a' },
    });
    expect(restartNoteInput({ content: 'x' }, 'NOTE')).toBeUndefined();
    expect(restartNoteInput({ content: 'x', turnId: 'om_1', dispatchAttempt: 2 }, 'NOTE')).toBeUndefined();
  });
});
