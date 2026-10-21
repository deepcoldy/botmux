/**
 * Fallback for an OSC 7501 `working` hold whose terminal report never arrives.
 *
 * Claude Code can be back at its prompt with the transcript closed while the
 * last OSC report still says `working` (lost report, or a child id that never
 * reports back). The detector then ignored every idle signal forever. The
 * release needs the transcript, OSC silence and the screen to agree.
 *
 * Run: bun x vitest run test/stale-program-status.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleDetector } from '../src/utils/idle-detector.js';
import {
  ClaudeTranscriptTurnEnd,
  STALE_PROGRAM_STATUS_QUIET_MS,
  staleProgramStatusVerdict,
} from '../src/utils/stale-program-status.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';

function makeCli(): CliAdapter {
  return {
    id: 'test-cli',
    resolvedBin: '/usr/bin/test-cli',
    buildArgs: () => [],
    writeInput: async () => {},
    readyPattern: /❯/,
    idleToBusyPattern: /esc to interrupt/,
    systemHints: [],
    altScreen: false,
  };
}

const userLine = (uuid: string): TranscriptEvent => ({ type: 'user', uuid, message: { role: 'user', content: 'do it' } } as any);
const toolUse = (uuid: string): TranscriptEvent => ({
  type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
} as any);
const finalAnswer = (uuid: string): TranscriptEvent => ({
  type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
} as any);
const turnDuration = (uuid: string): TranscriptEvent => ({ type: 'system', subtype: 'turn_duration', uuid } as any);

describe('IdleDetector.releaseStaleProgramStatus', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('releases a held working record as idle and leaves authority mode', () => {
    const detector = new IdleDetector(makeCli());
    const idle = vi.fn();
    detector.onIdle(idle);
    detector.observeProgramStatus({ state: 'working' });
    detector.observeProgramStatus({ state: 'working', id: 'child' });
    expect(detector.programStatusHeldWorking()).toBe(true);
    detector.fireIdle();
    expect(idle).not.toHaveBeenCalled();

    expect(detector.releaseStaleProgramStatus()).toBe(true);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledWith('external');
    expect(detector.programStatusActive()).toBe(false);
    expect(detector.programStatusHeldWorking()).toBe(false);
    expect(detector.releaseStaleProgramStatus()).toBe(false);
    detector.dispose();
  });

  it('a later busy redraw or OSC report takes the session back to working', () => {
    const detector = new IdleDetector(makeCli());
    const busy = vi.fn();
    detector.onIdle(() => {});
    detector.onBusy(busy);
    detector.observeProgramStatus({ state: 'working' });
    detector.releaseStaleProgramStatus();

    detector.observeProgramStatus({ state: 'working' });
    expect(busy).toHaveBeenCalledTimes(1);
    expect(detector.programStatusActive()).toBe(true);
    detector.dispose();
  });

  it('never releases a blocked record — it waits on a human', () => {
    const detector = new IdleDetector(makeCli());
    const idle = vi.fn();
    detector.onIdle(idle);
    detector.observeProgramStatus({ state: 'working' });
    detector.observeProgramStatus({ state: 'blocked', id: 'perm', kind: 'permission' });
    expect(detector.programStatusHeldWorking()).toBe(false);
    expect(detector.releaseStaleProgramStatus()).toBe(false);
    expect(idle).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('has nothing to release without OSC authority or after a terminal report', () => {
    const plain = new IdleDetector(makeCli());
    expect(plain.releaseStaleProgramStatus()).toBe(false);
    plain.dispose();

    const finished = new IdleDetector(makeCli());
    finished.onIdle(() => {});
    finished.observeProgramStatus({ state: 'working' });
    finished.observeProgramStatus({ state: 'done' });
    expect(finished.programStatusHeldWorking()).toBe(false);
    expect(finished.releaseStaleProgramStatus()).toBe(false);
    finished.dispose();
  });

  it('measures OSC silence from the last accepted report', () => {
    const detector = new IdleDetector(makeCli());
    expect(detector.programStatusQuietMs()).toBe(Number.POSITIVE_INFINITY);
    detector.observeProgramStatus({ state: 'working' });
    vi.advanceTimersByTime(45_000);
    expect(detector.programStatusQuietMs()).toBe(45_000);
    detector.observeProgramStatus({ state: 'working', progress: 50 });
    expect(detector.programStatusQuietMs()).toBe(0);
    detector.dispose();
  });
});

describe('ClaudeTranscriptTurnEnd', () => {
  it('is closed only while the latest main-thread record ended the turn', () => {
    const end = new ClaudeTranscriptTurnEnd();
    end.observe([userLine('u1'), toolUse('a1')], 1_000);
    expect(end.endedForMs(2_000)).toBeUndefined();

    end.observe([finalAnswer('a2'), turnDuration('d1')], 3_000);
    expect(end.endedForMs(10_000)).toBe(7_000);

    // Metadata after the boundary does not reopen it.
    end.observe([{ type: 'file-history-snapshot', uuid: 's1' } as any, { type: 'queue-operation', operation: 'enqueue' } as any], 4_000);
    expect(end.endedForMs(10_000)).toBe(7_000);

    // A background-task notification (or any new prompt) reopens it.
    end.observe([userLine('u2')], 5_000);
    expect(end.endedForMs(10_000)).toBeUndefined();
  });

  it('ignores sidechain records and resets with the CLI process', () => {
    const end = new ClaudeTranscriptTurnEnd();
    end.observe([finalAnswer('a1')], 1_000);
    end.observe([{ ...userLine('side'), isSidechain: true } as any], 2_000);
    expect(end.endedForMs(5_000)).toBe(4_000);
    end.reset();
    expect(end.endedForMs(5_000)).toBeUndefined();
  });
});

describe('staleProgramStatusVerdict', () => {
  const quiet = STALE_PROGRAM_STATUS_QUIET_MS;
  const evidence = (over: Partial<Parameters<typeof staleProgramStatusVerdict>[0]> = {}) => ({
    heldWorking: true,
    programStatusQuietMs: quiet,
    transcriptEndedForMs: quiet,
    backgroundTasksRunning: 0,
    ...over,
  });

  it('only consults the screen once the transcript and OSC have both been quiet long enough', () => {
    expect(staleProgramStatusVerdict(evidence())).toBe('check-screen');
    expect(staleProgramStatusVerdict(evidence({ programStatusQuietMs: quiet - 1 }))).toBe('wait');
    expect(staleProgramStatusVerdict(evidence({ transcriptEndedForMs: quiet - 1 }))).toBe('wait');
  });

  it('keeps waiting while background work of the ended turn is still running', () => {
    // Claude Code holds `working` for a background Bash / Monitor / agent after
    // the main turn ended: a real hold, not a lost terminal report.
    expect(staleProgramStatusVerdict(evidence({
      programStatusQuietMs: quiet * 60,
      transcriptEndedForMs: quiet * 60,
      backgroundTasksRunning: 1,
    }))).toBe('wait');
  });

  it('stops when nothing is held or the transcript turn is still open', () => {
    expect(staleProgramStatusVerdict(evidence({ heldWorking: false, backgroundTasksRunning: 2 }))).toBe('stop');
    expect(staleProgramStatusVerdict(evidence({ transcriptEndedForMs: undefined }))).toBe('stop');
  });
});
