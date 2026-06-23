import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let resolvedPath = '';
let resolvedKind: string = 'claude';

vi.mock('../src/services/transcript-resolver.js', () => ({
  resolveSessionTranscriptPath: vi.fn(() => resolvedPath ? { path: resolvedPath, kind: resolvedKind } : null),
}));

import { buildSafeInsightConversation, buildSafeInsightOverview, buildSafeInsightReport, buildSafeInsightTurnDetail } from '../src/services/insight/report.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-insight-report-'));
  resolvedPath = '';
  resolvedKind = 'claude';
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeClaudeFailureFixture(count: number): string {
  const path = join(dir, 'claude.jsonl');
  const lines: string[] = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'fix' } }),
  ];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: `2026-06-17T01:00:0${i + 1}.000Z`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `curl https://x.test?a=secret-${i}` } }] },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: `2026-06-17T01:00:1${i + 1}.000Z`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true, content: `sk-secret-${i}` }] },
    }));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

function writeClaudeDiagnosticFixture(): string {
  const path = join(dir, 'claude-diagnostics.jsonl');
  const lines: string[] = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'diagnose' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-17T01:00:01.000Z',
      message: { id: 'm-edit', role: 'assistant', usage: { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }, content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/secret/a.ts' } }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-17T01:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-17T01:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm build --token sk-secret' } }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-17T01:01:15.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'done' }] },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

function writeClaudeReadWriteOnlyFixture(): string {
  const path = join(dir, 'claude-read-write-only.jsonl');
  const lines: string[] = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'make the small edit' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-17T01:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/secret/a.ts' } }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-17T01:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

function writeCodexWorkSummaryFixture(): string {
  const path = join(dir, 'codex-work-summary.jsonl');
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '@@',
    '-old',
    '+new',
    '+extra',
    '*** Update File: /secret/project/src/other.ts',
    '@@',
    '-gone',
    '+kept',
    '*** End Patch',
  ].join('\n');
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-17T01:00:00.000Z', payload: { type: 'user_message', message: 'summarize work' } }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:01.000Z',
      payload: { type: 'function_call', call_id: 'r1', name: 'read_file', arguments: JSON.stringify({ file_path: '/secret/project/src/app.ts' }) },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:02.000Z',
      payload: { type: 'function_call_output', call_id: 'r1', output: 'ok' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:03.000Z',
      payload: { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: patch },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-17T01:00:04.000Z',
      payload: { type: 'patch_apply_end', call_id: 'p1', success: true },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:05.000Z',
      payload: { type: 'function_call', call_id: 'e1', name: 'Edit', arguments: JSON.stringify({ file_path: '/secret/project/src/edit.ts', old_string: 'one\nold', new_string: 'one\nnew\nextra' }) },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:06.000Z',
      payload: { type: 'function_call_output', call_id: 'e1', output: 'ok' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:07.000Z',
      payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pnpm test --token sk-secret' }) },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:09.000Z',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'Wall time: 2s\nProcess exited with code 1\nTOKEN=secret' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:10.000Z',
      payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pnpm test --token sk-secret' }) },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T01:00:11.000Z',
      payload: { type: 'function_call_output', call_id: 'c2', output: 'Wall time: 1s\nProcess exited with code 0' },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

function writeClaudeLateFailureFixture(): string {
  const path = join(dir, 'claude-late-failure.jsonl');
  const lines: string[] = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'late failures' } }),
  ];
  for (let i = 0; i < 3; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: `2026-06-17T01:00:0${i + 1}.000Z`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: `/secret/${i}.ts` } }] },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: `2026-06-17T01:00:1${i + 1}.000Z`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: 'ok' }] },
    }));
  }
  for (let i = 0; i < 2; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: `2026-06-17T01:00:2${i + 1}.000Z`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: `deploy --token sk-secret-${i}` } }] },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: `2026-06-17T01:00:3${i + 1}.000Z`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, is_error: true, content: 'failed' }] },
    }));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

// turn 0: prompt + narration + a tool_use span. turn 1: prompt + narration, NO
// tool (a fully tool-less turn). Used to prove agent narration is gated to
// detail=spans / conversation, and that a tool-less turn still renders.
function writeClaudeNarrationFixture(): string {
  const path = join(dir, 'claude-narration.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'fix' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:01.000Z', message: { id: 'm1', role: 'assistant', content: [
      { type: 'text', text: 'Looking into it. token=sk-abcdef1234567890' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } },
    ] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:03.000Z', message: { role: 'user', content: 'and explain' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:04.000Z', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'It does X.' },
    ] } }),
  ];
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

describe('SafeInsightReport', () => {
  it('returns summary without spans and sorts suggestions by severity', () => {
    resolvedPath = writeClaudeFailureFixture(3);
    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'summary', now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.status).toBe('ok');
    expect(report.meta.detail).toBe('summary');
    expect(report.spans).toBeUndefined();
    expect(report.agg).toMatchObject({ totalSpans: 3, failedSpans: 3, slowSpans: 0 });
    expect(report.suggestions[0]).toMatchObject({ id: 'high_tool_failure', severity: 'bad' });
    expect(report.diagnostics[0]).toMatchObject({
      id: 'high_tool_failure',
      suggestionId: 'high_tool_failure',
      kind: 'tool_failure',
      severity: 'bad',
      targets: { tools: ['Bash'] },
      stats: { failedSpans: 3, matchedSpans: 3, returnedSpans: 0, topTool: 'Bash', topToolFailures: 3 },
    });
    expect(report.diagnostics[0].targets.spanIndexes).toBeUndefined();
  });

  it('returns only safe span summaries for detail=spans', () => {
    resolvedPath = writeClaudeFailureFixture(1);
    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.spans).toHaveLength(1);
    expect(report.spans![0]).toMatchObject({
      tool: 'Bash',
      phase: 'run',
      turnIndex: 0,
      inputSummary: 'shell command',
      outputSummary: 'tool error',
      intent: { kind: 'unknown' },
      result: { category: 'command_failed' },
      tags: expect.arrayContaining(['failure', 'diagnostic']),
      evidence: {
        command: { text: 'curl https://x.test?<redacted>', truncated: false },
        output: { text: '<redacted>', truncated: false },
      },
      detail: expect.objectContaining({
        evidence: {
          command: { text: 'curl https://x.test?<redacted>', truncated: false },
          output: { text: '<redacted>', truncated: false },
        },
      }),
    });
    expect(JSON.stringify(report)).not.toContain('sk-secret');
    expect(JSON.stringify(report)).not.toContain('a=secret');
  });

  it('returns diagnostic targets that point at visible safe spans and expose truncation stats', () => {
    resolvedPath = writeClaudeFailureFixture(3);
    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', maxSpans: 2, now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.spans).toHaveLength(2);
    expect(report.meta.capped).toBe(true);
    expect(report.diagnostics[0]).toMatchObject({
      id: 'high_tool_failure',
      kind: 'tool_failure',
      targets: { spanIndexes: [0, 1], turnIndexes: [0], tools: ['Bash'] },
      stats: { failedSpans: 3, matchedSpans: 3, returnedSpans: 2 },
    });
  });

  it('prioritizes diagnostic evidence over a simple transcript prefix when capped', () => {
    resolvedPath = writeClaudeLateFailureFixture();
    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', maxSpans: 3, now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.spans?.map(s => s.tool)).toEqual(['Read', 'Bash', 'Bash']);
    expect(report.diagnostics[0]).toMatchObject({
      id: 'tool_failure_present',
      kind: 'tool_failure',
      targets: { spanIndexes: [1, 2], turnIndexes: [0], tools: ['Bash'] },
      stats: { failedSpans: 2, matchedSpans: 2, returnedSpans: 2 },
    });
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  it('builds slow-span and read/write diagnostics without leaking raw text', () => {
    resolvedPath = writeClaudeDiagnosticFixture();
    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });

    const slow = report.diagnostics.find(d => d.id === 'slow_span');
    const rw = report.diagnostics.find(d => d.id === 'low_read_write_ratio');
    expect(report.spans?.[0]).toMatchObject({
      intent: { kind: 'edit_file', subject: 'a.ts' },
      result: { category: 'ok' },
      tags: expect.arrayContaining(['read_write_imbalance', 'diagnostic']),
    });
    expect(report.spans?.[1]).toMatchObject({
      intent: { kind: 'run_script', subject: 'pnpm build', detail: 'build' },
      result: { category: 'ok' },
      tags: expect.arrayContaining(['slow', 'read_write_imbalance', 'diagnostic']),
      detail: expect.objectContaining({
        headline: expect.objectContaining({ id: 'span_slow' }),
        intent: { kind: 'run_script', subject: 'pnpm build', detail: 'build' },
        result: { category: 'ok' },
        turnIndex: 0,
      }),
    });
    expect(slow).toMatchObject({
      kind: 'slow_span',
      targets: { spanIndexes: [1], turnIndexes: [0], tools: ['Bash'] },
      stats: { slowSpansTotal: 1, returnedSpans: 1, slowestTool: 'Bash', slowestDurationMs: 72_000 },
    });
    expect(rw).toMatchObject({
      kind: 'read_write_imbalance',
      targets: { spanIndexes: [0, 1], turnIndexes: [0], tools: ['Edit', 'Bash'] },
      stats: { readWriteRatio: 0, readSpans: 0, writeSpans: 1, matchedSpans: 2, returnedSpans: 2 },
    });
    expect(report.turnDiagnostics).toEqual([
      expect.objectContaining({
        turnIndex: 0,
        severity: 'warn',
        headline: expect.objectContaining({ id: 'turn_has_slow_spans' }),
        metrics: { reads: 0, edits: 1, runs: 1, failures: 0, durationMs: 73_000 },
        spanIndexes: [0, 1],
        tags: expect.arrayContaining(['slow', 'read_write_imbalance']),
      }),
    ]);
    expect(report.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'split_slow_operation',
        diagnosticId: 'slow_span',
        impact: expect.objectContaining({ id: 'impact_slow_spans' }),
        why: expect.objectContaining({ id: 'why_slow_span_dominates' }),
        nextActions: expect.arrayContaining([
          expect.objectContaining({ id: 'narrow_or_split_slow_operation' }),
        ]),
        evidence: expect.objectContaining({ spanIndexes: [1], turnIndexes: [0] }),
      }),
      expect.objectContaining({
        id: 'add_read_pass_before_edit',
        diagnosticId: 'low_read_write_ratio',
      }),
    ]));
    expect(report.turnTimeline).toEqual([
      expect.objectContaining({
        turnIndex: 0,
        severity: 'warn',
        prompt: { text: 'diagnose', truncated: false },
        context: {
          turnIndex: 0,
          inputTokens: 500,
          outputTokens: 30,
          cacheReadTokens: 100,
          cacheCreateTokens: 10,
          contextTokens: 610,
          totalTokens: 640,
        },
        headline: expect.objectContaining({ id: 'turn_has_slow_spans' }),
        metrics: { reads: 0, edits: 1, runs: 1, failures: 0, durationMs: 73_000 },
        events: [
          expect.objectContaining({
            kind: 'edit',
            spanIndex: 0,
            label: expect.objectContaining({ id: 'timeline_span_completed' }),
            intent: { kind: 'edit_file', subject: 'a.ts' },
          }),
          expect.objectContaining({
            kind: 'run',
            spanIndex: 1,
            label: expect.objectContaining({ id: 'timeline_span_completed' }),
            intent: { kind: 'run_script', subject: 'pnpm build', detail: 'build' },
            evidence: {
              command: { text: 'pnpm build --token <redacted>', truncated: false },
              output: { text: 'done', truncated: false },
            },
          }),
        ],
      }),
    ]);
    expect('conversation' in report).toBe(false);
    expect(JSON.stringify(report)).not.toContain('/secret/a.ts');
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  it('returns paged full turn prompt with same-turn agent messages', () => {
    resolvedPath = writeClaudeDiagnosticFixture();
    const turn = buildSafeInsightTurnDetail({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, 0, { offset: 0, limit: 4 });

    expect(turn).toMatchObject({
      status: 'ok',
      turnIndex: 0,
      offset: 0,
      limit: 4,
      total: 8,
      nextOffset: 4,
      hasMore: true,
      prompt: { text: 'diag', truncated: true },
    });
    expect(turn.messages).toEqual([
      expect.objectContaining({
        role: 'agent',
        event: expect.objectContaining({ kind: 'edit', spanIndex: 0 }),
      }),
      expect.objectContaining({
        role: 'agent',
        severity: 'warn',
        tags: expect.arrayContaining(['slow']),
        event: expect.objectContaining({
          kind: 'run',
          evidence: {
            command: { text: 'pnpm build --token <redacted>', truncated: false },
            output: { text: 'done', truncated: false },
          },
        }),
      }),
    ]);
  });

  it('returns paged and filterable conversation projection without bloating the report', () => {
    resolvedPath = writeClaudeDiagnosticFixture();
    const page = buildSafeInsightConversation({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { offset: 0, limit: 2 });

    expect(page).toMatchObject({
      status: 'ok',
      offset: 0,
      limit: 2,
      total: 3,
      nextOffset: 2,
      hasMore: true,
    });
    expect(page.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'diagnose', severity: 'warn' }),
      expect.objectContaining({ role: 'agent', event: expect.objectContaining({ kind: 'edit' }) }),
    ]);

    const filtered = buildSafeInsightConversation({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { tag: 'slow', q: 'pnpm build' });
    expect(filtered).toMatchObject({ total: 1, hasMore: false });
    expect(filtered.messages[0]).toMatchObject({
      role: 'agent',
      severity: 'warn',
      tags: expect.arrayContaining(['slow']),
      event: expect.objectContaining({
        evidence: {
          command: { text: 'pnpm build --token <redacted>', truncated: false },
          output: { text: 'done', truncated: false },
        },
      }),
    });

    const noTurns = buildSafeInsightConversation({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { turnIndexes: [99] });
    expect(noTurns).toMatchObject({ total: 0, hasMore: false, messages: [] });
  });

  it('summarizes changed files and commands for detail reports without leaking absolute paths or secrets', () => {
    resolvedKind = 'codex';
    resolvedPath = writeCodexWorkSummaryFixture();
    const report = buildSafeInsightReport({
      cliId: 'codex',
      sessionId: 's1',
      cwd: '/secret/project',
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.workSummary?.fileChanges).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        reads: 1,
        edits: 1,
        added: 3,
        removed: 2,
        turnIndexes: [0],
      }),
      expect.objectContaining({
        path: 'src/edit.ts',
        reads: 0,
        edits: 1,
        added: 3,
        removed: 2,
        turnIndexes: [0],
      }),
      expect.objectContaining({
        path: 'src/other.ts',
        reads: 0,
        edits: 1,
        added: 3,
        removed: 2,
        turnIndexes: [0],
      }),
    ]);
    expect(report.workSummary?.commandsRun).toEqual([
      expect.objectContaining({
        command: { text: 'pnpm test --token <redacted>', truncated: false },
        count: 2,
        failures: 1,
        totalDurationMs: 3000,
        maxDurationMs: 2000,
        lastStatus: 'ok',
        turnIndexes: [0],
      }),
    ]);
    expect(JSON.stringify(report.workSummary)).not.toContain('/secret/project');
    expect(JSON.stringify(report.workSummary)).not.toContain('sk-secret');
    expect(JSON.stringify(report.workSummary)).not.toContain('TOKEN=secret');
  });

  it('supports TRAE by reusing the Codex-family rollout reader', () => {
    resolvedKind = 'traex';
    resolvedPath = writeCodexWorkSummaryFixture();
    const report = buildSafeInsightReport({
      cliId: 'traex',
      sessionId: 's1',
      cwd: '/secret/project',
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.status).toBe('ok');
    expect(report.agg.totalSpans).toBe(5);
    expect(report.workSummary?.commandsRun[0]).toMatchObject({
      command: { text: 'pnpm test --token <redacted>', truncated: false },
      count: 2,
      failures: 1,
    });
  });

  it('supports Antigravity reports without leaking command secrets', () => {
    const path = join(dir, 'antigravity-report.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-06-17T01:00:00Z',
        content: '<USER_REQUEST>run the failing test</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-06-17T01:00:01Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"pnpm test --token sk-secret"' } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'RUN_COMMAND',
        status: 'DONE',
        created_at: '2026-06-17T01:00:03Z',
        content: 'Created At: 2026-06-17T01:00:01Z Completed At: 2026-06-17T01:00:03Z Process exited with code 1',
      }),
    ].join('\n') + '\n', 'utf-8');
    resolvedKind = 'antigravity';
    resolvedPath = path;
    const report = buildSafeInsightReport({
      cliId: 'antigravity',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.status).toBe('ok');
    expect(report.spans?.[0]).toMatchObject({
      tool: 'Bash',
      status: 'error',
      intent: { kind: 'test', subject: 'pnpm test' },
      result: { category: 'test_failed', exitCode: 1 },
      evidence: {
        command: { text: 'pnpm test --token <redacted>', truncated: false },
      },
    });
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  it('keeps pure read/write imbalance visible without flagging the turn as attention-needed', () => {
    resolvedPath = writeClaudeReadWriteOnlyFixture();
    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(report.spans).toHaveLength(1);
    expect(report.spans?.[0]).toMatchObject({
      tool: 'Edit',
      status: 'ok',
      tags: expect.arrayContaining(['read_write_imbalance', 'diagnostic']),
    });
    expect(report.diagnostics.find(d => d.id === 'low_read_write_ratio')).toMatchObject({
      kind: 'read_write_imbalance',
      targets: { spanIndexes: [0], turnIndexes: [0], tools: ['Edit'] },
    });
    expect(report.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'add_read_pass_before_edit',
        diagnosticId: 'low_read_write_ratio',
      }),
    ]));
    expect(report.turnDiagnostics).toEqual([]);
    expect(report.turnTimeline).toEqual([
      expect.objectContaining({
        turnIndex: 0,
        severity: 'info',
        prompt: { text: 'make the small edit', truncated: false },
        headline: expect.objectContaining({ id: 'turn_normal' }),
        tags: expect.arrayContaining(['read_write_imbalance']),
      }),
    ]);
  });

  it('fails closed for unsupported CLIs and safe error text', () => {
    const report = buildSafeInsightReport({
      cliId: 'coco',
      sessionId: 's1',
      cwd: '/private/path',
    });

    expect(report.status).toBe('unsupported_cli');
    expect(report.spans).toBeUndefined();
    expect(report.error?.message).toBe('Insight is not available for this CLI yet.');
    expect(JSON.stringify(report)).not.toContain('/private/path');
  });

  it('builds a cross-session safe overview with aggregate suggestions', async () => {
    resolvedPath = writeClaudeFailureFixture(3);
    const overview = await buildSafeInsightOverview([
      {
        cliId: 'claude-code',
        sessionId: 's1',
        cwd: dir,
        title: 'first',
        botName: 'bot-a',
        lastMessageAt: 10,
      },
      {
        cliId: 'claude-code',
        sessionId: 's2',
        cwd: dir,
        title: 'second',
        botName: 'bot-b',
        lastMessageAt: 20,
      },
    ], { limit: 10, now: () => new Date('2026-06-17T02:00:00.000Z') });

    expect(overview.meta).toMatchObject({
      totalSessions: 2,
      returnedSessions: 2,
      analyzedSessions: 2,
      capped: false,
      limit: 10,
    });
    expect(overview.agg).toMatchObject({ totalSpans: 6, failedSpans: 6, slowSpans: 0 });
    expect(overview.topFailedTools[0]).toEqual({ tool: 'Bash', count: 6 });
    expect(overview.suggestions[0]).toMatchObject({ id: 'high_tool_failure', severity: 'bad', count: 2 });
    expect(overview.sessions.map(s => s.sessionId)).toEqual(['s2', 's1']);
    expect(JSON.stringify(overview)).not.toContain('sk-secret');
    expect(JSON.stringify(overview)).not.toContain('curl https://x.test');
  });

  it('gates scrubbed agent narration to detail=spans and omits it from detail=summary', () => {
    resolvedPath = writeClaudeNarrationFixture();

    const summary = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'summary', now: () => new Date('2026-06-17T02:00:00.000Z') });
    // narration never reaches the summary report (the /insight card + overview path)
    expect(JSON.stringify(summary)).not.toContain('Looking into it');
    expect(JSON.stringify(summary)).not.toContain('It does X');

    const spans = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', now: () => new Date('2026-06-17T02:00:00.000Z') });
    const t0 = spans.turnTimeline.find(t => t.turnIndex === 0);
    expect(t0?.agentSay?.text).toContain('Looking into it');
    // a secret echoed in narration is scrubbed before it reaches the structure
    expect(JSON.stringify(spans.turnTimeline)).toContain('token=<redacted>');
    expect(JSON.stringify(spans.turnTimeline)).not.toContain('sk-abcdef1234567890');
  });

  it('does not resurrect a cap-trimmed span turn as an empty narration turn, but keeps genuinely tool-less turns', () => {
    // turn 0: a FAILING tool (high cap priority). turn 1: narration + a SUCCESS
    // tool (low priority → trimmed when maxSpans is small). turn 2: narration
    // only, no tool (genuinely tool-less).
    const path = join(dir, 'claude-cap.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 't0' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:01.000Z', message: { id: 'a0', role: 'assistant', content: [
        { type: 'tool_use', id: 'f0', name: 'Bash', input: { command: 'false' } },
      ] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f0', is_error: true, content: 'boom' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:03.000Z', message: { role: 'user', content: 't1' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:04.000Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: 'CAPPED_TURN_NARRATION' },
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x/y.ts' } },
      ] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:06.000Z', message: { role: 'user', content: 't2' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:07.000Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'text', text: 'TOOLLESS_TURN_NARRATION' },
      ] } }),
    ].join('\n') + '\n', 'utf-8');
    resolvedPath = path;

    const report = buildSafeInsightReport({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { detail: 'spans', maxSpans: 1, now: () => new Date('2026-06-17T02:00:00.000Z') });

    const turnIndexes = report.turnTimeline.map(t => t.turnIndex);
    // turn 1 has a real span trimmed by the cap → must NOT become a phantom 0-op
    // turn, and its narration must not leak past the cap.
    expect(turnIndexes).not.toContain(1);
    expect(JSON.stringify(report.turnTimeline)).not.toContain('CAPPED_TURN_NARRATION');
    // turn 2 is genuinely tool-less → its narration still surfaces under the cap.
    expect(turnIndexes).toContain(2);
    const t2 = report.turnTimeline.find(t => t.turnIndex === 2);
    expect(t2?.agentSay?.text).toContain('TOOLLESS_TURN_NARRATION');
    expect(t2?.events).toEqual([]);
  });

  it('renders a tool-less narration turn in the conversation replay (turn with no span)', () => {
    resolvedPath = writeClaudeNarrationFixture();
    const convo = buildSafeInsightConversation({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: dir,
    }, { offset: 0, limit: 50 });

    // turn 1 ran no tool — its narration must still surface as an agent 'say'
    // message (text, no event). This is the regression the timeline union fixes.
    const turn1Say = convo.messages.find(m => m.turnIndex === 1 && m.role === 'agent' && !!m.text && !m.event);
    expect(turn1Say?.text).toContain('It does X');
    // and the narration on the tool-bearing turn 0 is present too
    const turn0Say = convo.messages.find(m => m.turnIndex === 0 && m.role === 'agent' && !!m.text && !m.event);
    expect(turn0Say?.text).toContain('Looking into it');
  });
});
