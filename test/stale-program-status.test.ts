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
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdleDetector } from '../src/utils/idle-detector.js';
import {
  ClaudeTranscriptTurnEnd,
  claudeTranscriptLatestTurnState,
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

describe('claudeTranscriptLatestTurnState (re-attach: is the turn still running?)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bmx-turn-state-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, rows: unknown[], tail = '') => {
    const path = join(dir, name);
    writeFileSync(path, rows.map(row => `${JSON.stringify(row)}\n`).join('') + tail);
    return path;
  };

  it('a tool call with no result yet leaves the turn open; its closing record closes it', () => {
    const path = write('t.jsonl', [userLine('u1'), toolUse('a1')]);
    expect(claudeTranscriptLatestTurnState(path)).toBe('open');
    appendFileSync(path, [finalAnswer('a2'), turnDuration('d1')].map(r => `${JSON.stringify(r)}\n`).join(''));
    expect(claudeTranscriptLatestTurnState(path)).toBe('closed');
  });

  it('looks past metadata and sidechain records to the latest main-thread one', () => {
    const path = write('t.jsonl', [
      userLine('u1'), finalAnswer('a1'),
      { type: 'file-history-snapshot', uuid: 's1' },
      { ...userLine('side'), isSidechain: true },
    ]);
    expect(claudeTranscriptLatestTurnState(path)).toBe('closed');
  });

  it('ignores a record still being written and answers nothing for a missing or empty file', () => {
    const path = write('t.jsonl', [userLine('u1'), finalAnswer('a1')], '{"type":"user","message":{"role":"us');
    expect(claudeTranscriptLatestTurnState(path)).toBe('closed');
    expect(claudeTranscriptLatestTurnState(join(dir, 'missing.jsonl'))).toBeUndefined();
    expect(claudeTranscriptLatestTurnState(write('empty.jsonl', []))).toBeUndefined();
  });

  it('treats user interrupts (with or without interruptedMessageId), API errors, and synthetic no-model-reply as closed', () => {
    const p1 = write('int-tool.jsonl', [
      userLine('u1'),
      toolUse('a1'),
      { type: 'user', uuid: 'int1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    ]);
    expect(claudeTranscriptLatestTurnState(p1)).toBe('closed');

    const p2 = write('int-id.jsonl', [
      userLine('u1'),
      { type: 'user', uuid: 'int2', interruptedMessageId: 'msg_1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]);
    expect(claudeTranscriptLatestTurnState(p2)).toBe('closed');

    const p3 = write('api-err.jsonl', [
      userLine('u1'),
      { type: 'assistant', uuid: 'e1', isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', model: '<synthetic>', stop_reason: null, content: [{ type: 'text', text: 'API Error: 500' }] } },
    ]);
    expect(claudeTranscriptLatestTurnState(p3)).toBe('closed');

    const p4 = write('synth.jsonl', [
      userLine('u1'),
      { type: 'assistant', uuid: 's1', isApiErrorMessage: false, message: { role: 'assistant', model: '<synthetic>', stop_reason: null, content: [{ type: 'text', text: 'No response requested.' }] } },
    ]);
    expect(claudeTranscriptLatestTurnState(p4)).toBe('closed');
  });

  it('ignores api-request-blob and local slash-command wrappers when scanning for open turns', () => {
    const p1 = write('blob.jsonl', [
      userLine('u1'),
      finalAnswer('a1'),
      turnDuration('d1'),
      { type: 'api-request-blob', hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: 'blob copy' }] } },
    ]);
    expect(claudeTranscriptLatestTurnState(p1)).toBe('closed');

    const p2 = write('slash.jsonl', [
      userLine('u1'),
      finalAnswer('a1'),
      turnDuration('d1'),
      { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/model</command-name>' } },
      { type: 'user', uuid: 'c2', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } },
    ]);
    expect(claudeTranscriptLatestTurnState(p2)).toBe('closed');
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

  it('ignores api-request-blob records in ClaudeTranscriptTurnEnd and claudeTranscriptLatestTurnState', () => {
    const tracker = new ClaudeTranscriptTurnEnd();
    const base = 1_762_344_000_000;
    tracker.observe([
      { type: 'system', subtype: 'turn_duration', timestamp: new Date(base).toISOString() },
    ], base);
    expect(tracker.endedForMs(base + 5000)).toBe(5000);

    // Trailing user/assistant api-request-blob must NOT reopen the closed turn
    tracker.observe([
      { type: 'api-request-blob', message: { role: 'user', content: 'copied prompt' } },
      { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'copied' }] } },
    ], base + 6000);
    expect(tracker.endedForMs(base + 10_000)).toBe(10_000);

    // Same for file-tail inspection
    const dir = mkdtempSync(join(tmpdir(), 'stale-blob-'));
    try {
      const file = join(dir, 'session.jsonl');
      writeFileSync(file, [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }),
        JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
        JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'copied' } }),
      ].join('\n') + '\n');
      expect(claudeTranscriptLatestTurnState(file)).toBe('closed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

