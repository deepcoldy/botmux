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
});
