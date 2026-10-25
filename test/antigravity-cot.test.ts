import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay } from '../src/utils/timing.js';
import {
  extractAntigravityCotEntriesFromRecord,
  startAntigravityCot,
  stopAntigravityCot,
  stopAllAntigravityCot,
  type AntigravityCotEntry,
} from '../src/services/antigravity-cot.js';
import { isAntigravityTranscriptBusy } from '../src/adapters/cli/antigravity.js';
import { jsonl, writeAntigravityTwoLogs } from './helpers/antigravity-two-logs.js';

describe('antigravity-cot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-agy-cot-'));
  });

  afterEach(() => {
    stopAllAntigravityCot();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('extractAntigravityCotEntriesFromRecord parses thinking, text, tools and results', () => {
    const pending: Array<{ id: string; name: string }> = [];

    // 1. User input
    const userRes = extractAntigravityCotEntriesFromRecord(
      { type: 'USER_INPUT', content: 'hello' },
      pending,
    );
    expect(userRes).toEqual([]);

    // 2. Planner response with thinking and tool_call
    const planRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        thinking: 'Let us check status',
        content: 'Running status check',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: 'git status', toolAction: 'Check status' },
          },
        ],
      },
      pending,
    );

    expect(planRes.length).toBe(3);
    expect(planRes[0]).toEqual({ kind: 'thinking', text: 'Let us check status' });
    expect(planRes[1]).toEqual({ kind: 'text', text: 'Running status check' });
    expect(planRes[2]).toMatchObject({
      kind: 'tool_call',
      id: 'call_1_0',
      name: 'run_command',
      subject: 'git status',
    });
    expect(pending.length).toBe(1);

    // 3. Tool result
    const resultRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        content: 'On branch master\nnothing to commit',
      },
      pending,
    );

    expect(resultRes.length).toBe(1);
    expect(resultRes[0]).toEqual({
      kind: 'tool_result',
      id: 'call_1_0',
      result: 'On branch master\nnothing to commit',
    });
    expect(pending.length).toBe(0);
  });

  it('truncates oversized tool args and result', () => {
    const pending: Array<{ id: string; name: string }> = [];
    const planRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: 'x'.repeat(1000) },
          },
        ],
      },
      pending,
    );

    expect(planRes[0].kind).toBe('tool_call');
    if (planRes[0].kind === 'tool_call') {
      expect(planRes[0].args.length).toBeLessThanOrEqual(601);
      expect(planRes[0].args.endsWith('…')).toBe(true);
    }

    const resultRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 2,
        type: 'GENERIC',
        content: 'y'.repeat(2000),
      },
      pending,
    );

    expect(resultRes[0].kind).toBe('tool_result');
    if (resultRes[0].kind === 'tool_result') {
      expect(resultRes[0].result.length).toBeLessThanOrEqual(801);
      expect(resultRes[0].result.endsWith('…')).toBe(true);
    }
  });

  it('streams incremental entries from transcript file', async () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'USER_INPUT', content: 'test' }) + '\n');

    const received: AntigravityCotEntry[] = [];
    const ok = startAntigravityCot(
      'conv-1234',
      (entries) => {
        received.push(...entries);
      },
      {
        transcriptPath,
        mode: 'fresh',
        pollIntervalMs: 50,
      },
    );
    expect(ok).toBe(true);

    // Append new line
    const record = {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      thinking: 'Thinking about the problem',
    };
    appendFileSync(transcriptPath, JSON.stringify(record) + '\n');

    await delay(150);

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({
      kind: 'thinking',
      text: 'Thinking about the problem',
    });

    stopAntigravityCot('conv-1234');
  });

  it('ignores SYSTEM:CHECKPOINT and SYSTEM:SYSTEM_MESSAGE and does not desync pendingTools', () => {
    const pending: Array<{ id: string; name: string }> = [];

    // 1. Planner response with a tool call
    const planRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ id: 'call_cmd_1', name: 'run_command', args: { CommandLine: 'ls' } }],
      },
      pending,
    );
    expect(planRes.length).toBe(1);
    expect(planRes[0].kind).toBe('tool_call');
    expect(pending).toEqual([{ id: 'call_cmd_1', name: 'run_command' }]);

    // 2. Intermediate checkpoint record
    const cpRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        content: 'internal checkpoint state json',
      },
      pending,
    );
    expect(cpRes).toEqual([]);
    // pendingTools must NOT be consumed!
    expect(pending).toEqual([{ id: 'call_cmd_1', name: 'run_command' }]);

    // 3. Intermediate system message record
    const sysRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 3,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: 'Background task finished',
      },
      pending,
    );
    expect(sysRes).toEqual([]);
    expect(pending).toEqual([{ id: 'call_cmd_1', name: 'run_command' }]);

    // 4. Actual tool result arrives: must bind to call_cmd_1
    const resultRes = extractAntigravityCotEntriesFromRecord(
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        content: 'file1.txt\nfile2.txt',
      },
      pending,
    );
    expect(resultRes).toEqual([
      {
        kind: 'tool_result',
        id: 'call_cmd_1',
        result: 'file1.txt\nfile2.txt',
      },
    ]);
    expect(pending.length).toBe(0);
  });

  it('resets pendingTools when a new user input record arrives', () => {
    const pending: Array<{ id: string; name: string }> = [{ id: 'stale_call', name: 'old_tool' }];
    const res = extractAntigravityCotEntriesFromRecord(
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: 'next turn instruction',
      },
      pending,
    );
    expect(res).toEqual([]);
    expect(pending.length).toBe(0);
  });

  describe('transcript_full.jsonl vs the compact transcript.jsonl', () => {
    const CID = '00000000-0000-4000-8000-0000000000c0';

    async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await delay(20);
      }
    }

    const finalTextOf = (entries: readonly AntigravityCotEntry[]): string | undefined =>
      entries.filter(e => e.kind === 'text').at(-1)?.text;

    it('streams the untruncated final text and thinking from the full log', async () => {
      const logs = writeAntigravityTwoLogs(tmpDir, CID);
      const received: AntigravityCotEntry[] = [];
      startAntigravityCot(CID, entries => { received.push(...entries); }, { brainDir: tmpDir, mode: 'fresh', pollIntervalMs: 50 });
      await waitFor(() => finalTextOf(received) !== undefined);
      expect(finalTextOf(received)).toBe(logs.finalText);
      expect(received.filter(e => e.kind === 'thinking').map(e => e.text)).toEqual(['合成思考 1', '合成思考 23', '合成的收尾思考']);
    });

    it('moves a compact read to the full log once agy creates it, without repeating or skipping records', async () => {
      const logs = writeAntigravityTwoLogs(tmpDir, CID);
      // Reader starts in the few ms where only the compact log exists, with
      // records 0–11 already on disk (baselined as history).
      writeFileSync(logs.compactPath, jsonl(logs.compactRecords.slice(0, 12)));
      rmSync(logs.fullPath);
      const received: AntigravityCotEntry[] = [];
      startAntigravityCot(CID, entries => { received.push(...entries); }, { brainDir: tmpDir, pollIntervalMs: 50 });
      writeFileSync(logs.fullPath, jsonl(logs.fullRecords.slice(0, 12)));
      await delay(150);
      expect(received).toEqual([]);
      appendFileSync(logs.compactPath, jsonl(logs.compactRecords.slice(12)));
      appendFileSync(logs.fullPath, jsonl(logs.fullRecords.slice(12)));
      await waitFor(() => finalTextOf(received) !== undefined);
      expect(finalTextOf(received)).toBe(logs.finalText);
      // Records 12–25: tool calls on odd steps 13–23, results on even 12–24.
      expect(received.filter(e => e.kind === 'tool_call').map(e => (e as { id: string }).id))
        .toEqual(['call-13', 'call-15', 'call-17', 'call-19', 'call-21', 'call-23']);
      expect(received.filter(e => e.kind === 'tool_result')).toHaveLength(7);
    });

    it('keeps reading the compact log when agy writes no full log', async () => {
      const logs = writeAntigravityTwoLogs(tmpDir, CID, { withFull: false });
      const received: AntigravityCotEntry[] = [];
      startAntigravityCot(CID, entries => { received.push(...entries); }, { brainDir: tmpDir, mode: 'fresh', pollIntervalMs: 50 });
      await waitFor(() => finalTextOf(received) !== undefined);
      expect(finalTextOf(received)).toBe(logs.compactRecords[25].content);
    });
  });

  describe('isAntigravityTranscriptBusy', () => {
    it('returns false for non-existent file or empty transcript', () => {
      expect(isAntigravityTranscriptBusy(join(tmpDir, 'not-exists.jsonl'))).toBe(false);
      const emptyFile = join(tmpDir, 'empty.jsonl');
      writeFileSync(emptyFile, '');
      expect(isAntigravityTranscriptBusy(emptyFile)).toBe(false);
    });

    it('returns true when last record is USER_INPUT or has pending tool calls', () => {
      const file = join(tmpDir, 'busy.jsonl');
      writeFileSync(
        file,
        JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'do work' }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(true);

      // Model started a tool call
      appendFileSync(
        file,
        JSON.stringify({
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 5' } }],
        }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(true);

      // Tool result received
      appendFileSync(
        file,
        JSON.stringify({ source: 'MODEL', type: 'GENERIC', content: 'ok' }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(true);
    });

    it('returns false when last record is final PLANNER_RESPONSE without tool calls', () => {
      const file = join(tmpDir, 'idle.jsonl');
      writeFileSync(
        file,
        JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' }) + '\n' +
        JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Hello there!' }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(false);
    });

    it('returns false when completed response is followed by cancellation or CHECKPOINT', () => {
      const file = join(tmpDir, 'canceled.jsonl');
      writeFileSync(
        file,
        JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'done' }) + '\n' +
        JSON.stringify({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'The user canceled the task.' }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(false);

      const checkpointFile = join(tmpDir, 'checkpoint.jsonl');
      writeFileSync(
        checkpointFile,
        JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'done' }) + '\n' +
        JSON.stringify({ source: 'SYSTEM', type: 'CHECKPOINT', content: 'state snapshot' }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(checkpointFile)).toBe(false);
    });

    it('returns false on ERROR_MESSAGE after user prompt', () => {
      const file = join(tmpDir, 'error.jsonl');
      writeFileSync(
        file,
        JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' }) + '\n' +
        JSON.stringify({ source: 'SYSTEM', type: 'ERROR_MESSAGE', content: 'error: generation failed' }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(false);
    });

    it('returns true when tool call record is longer than the former 8KB read buffer', () => {
      const file = join(tmpDir, 'large-tool-call.jsonl');
      writeFileSync(
        file,
        JSON.stringify({
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'write_file', args: { content: 'x'.repeat(10_000) } }],
        }) + '\n',
      );
      expect(isAntigravityTranscriptBusy(file)).toBe(true);
    });

    it.each(['CHECKPOINT', 'TASK_NOTIFICATION', 'SYSTEM_MESSAGE'])(
      'keeps active work busy when a large tool call is followed by %s',
      (type) => {
        const file = join(tmpDir, 'large-tool-with-notification.jsonl');
        writeFileSync(file, [
          { source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [
            { name: 'write_file', args: { content: 'x'.repeat(100_000) } },
          ] },
          { source: 'SYSTEM', type, content: 'state notification' },
        ].map(record => JSON.stringify(record)).join('\n') + '\n');

        expect(isAntigravityTranscriptBusy(file)).toBe(true);
      },
    );

    it('finds a completed response behind a large checkpoint and later notification', () => {
      const file = join(tmpDir, 'completed-before-large-checkpoint.jsonl');
      writeFileSync(file, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'work' },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'done' },
        { source: 'SYSTEM', type: 'CHECKPOINT', content: 'x'.repeat(100_000) },
        { source: 'SYSTEM', type: 'TASK_NOTIFICATION', content: 'state notification' },
      ].map(record => JSON.stringify(record)).join('\n') + '\n');

      expect(isAntigravityTranscriptBusy(file)).toBe(false);
    });
  });
});
