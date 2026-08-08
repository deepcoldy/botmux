import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseOpenTodos,
  todoSnapshotFromEntry,
  readSessionOpenTodos,
  __resetTodoStateCacheForTest,
} from '../src/services/todo-state.js';

// ── Claude TodoWrite tool_use blocks ──────────────────────────────────────────
const claudeTodo = (statuses: string[]) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: statuses.map((status, i) => ({ content: `step ${i}`, status, activeForm: `doing ${i}` })) } },
    ],
  },
});

// ── Codex update_plan function_call ──────────────────────────────────────────
const codexPlan = (statuses: string[], asString = false) => {
  const args = { plan: statuses.map((status, i) => ({ step: `step ${i}`, status })) };
  return {
    type: 'response_item',
    payload: { type: 'function_call', name: 'update_plan', arguments: asString ? JSON.stringify(args) : args },
  };
};

describe('todoSnapshotFromEntry (Claude)', () => {
  it('summarizes a TodoWrite snapshot', () => {
    expect(todoSnapshotFromEntry(claudeTodo(['completed', 'in_progress', 'pending']), 'claude'))
      .toEqual({ total: 3, done: 1, remaining: 2, hasInProgress: true });
  });

  it('ignores non-TodoWrite tool_use and non-assistant entries', () => {
    const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
    expect(todoSnapshotFromEntry(bash, 'claude')).toBeNull();
    expect(todoSnapshotFromEntry({ type: 'user', message: { content: 'hi' } }, 'claude')).toBeNull();
  });

  it('drops unknown status values and returns null on an all-invalid/empty list', () => {
    expect(todoSnapshotFromEntry(claudeTodo(['done', 'blocked']), 'claude')).toBeNull();
    expect(todoSnapshotFromEntry(claudeTodo([]), 'claude')).toBeNull();
    // mixed valid + junk keeps only valid ones
    expect(todoSnapshotFromEntry(claudeTodo(['completed', 'nope']), 'claude'))
      .toEqual({ total: 1, done: 1, remaining: 0, hasInProgress: false });
  });
});

describe('todoSnapshotFromEntry (Codex)', () => {
  it('summarizes an update_plan snapshot (object args)', () => {
    expect(todoSnapshotFromEntry(codexPlan(['completed', 'completed', 'pending']), 'codex'))
      .toEqual({ total: 3, done: 2, remaining: 1, hasInProgress: false });
  });

  it('parses update_plan arguments delivered as a JSON string', () => {
    expect(todoSnapshotFromEntry(codexPlan(['in_progress', 'pending'], true), 'codex'))
      .toEqual({ total: 2, done: 0, remaining: 2, hasInProgress: true });
  });

  it('ignores other function calls and malformed args', () => {
    const other = { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } };
    expect(todoSnapshotFromEntry(other, 'codex')).toBeNull();
    const bad = { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: '{not json' } };
    expect(todoSnapshotFromEntry(bad, 'codex')).toBeNull();
  });
});

describe('parseOpenTodos (last-write-wins)', () => {
  it('returns the last snapshot, reflecting progress over the session', () => {
    const entries = [
      claudeTodo(['pending', 'pending', 'pending']),
      claudeTodo(['completed', 'in_progress', 'pending']),
      claudeTodo(['completed', 'completed', 'completed']),
    ];
    expect(parseOpenTodos(entries, 'claude'))
      .toEqual({ total: 3, done: 3, remaining: 0, hasInProgress: false });
  });

  it('returns null when the transcript has no todo snapshot at all', () => {
    expect(parseOpenTodos([{ type: 'user', message: { content: 'hi' } }], 'claude')).toBeNull();
    expect(parseOpenTodos([], 'codex')).toBeNull();
  });
});

describe('readSessionOpenTodos (unsupported CLIs)', () => {
  it('returns null for CLIs without a todo dialect, without touching disk', () => {
    expect(readSessionOpenTodos({ cliId: 'gemini', sessionId: 's1', cwd: '/tmp' })).toBeNull();
    expect(readSessionOpenTodos({ cliId: 'unknown', sessionId: 's1', cwd: '/tmp' })).toBeNull();
    expect(readSessionOpenTodos({ cliId: undefined, sessionId: 's1', cwd: '/tmp' })).toBeNull();
  });
});

// traex rollout 与 codex 逐字节同构，dialect 应映射到 codex —— 曾因 resolver 返回
// kind:'traex' 而 todoKindForCli 归到 'codex'，二者不等被误判 null。这里锁住修复。
describe('todo dialect mapping (traex ≡ codex)', () => {
  it('parses a traex-format update_plan snapshot via the codex dialect', () => {
    expect(todoSnapshotFromEntry(codexPlan(['completed', 'in_progress']), 'codex'))
      .toEqual({ total: 2, done: 1, remaining: 1, hasInProgress: true });
  });
});

describe('readSessionOpenTodos (Claude transcript on disk, mtime cache)', () => {
  let dir: string;
  afterEach(() => { __resetTodoStateCacheForTest(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  // Claude transcript path = <cwd project key>/<sessionId>.jsonl under ~/.claude.
  // The cold-start case (no transcript yet) must resolve to null, not throw.
  it('returns null when no transcript exists for the session', () => {
    dir = mkdtempSync(join(tmpdir(), 'todo-state-'));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId: `nope-${Date.now()}`, cwd: dir })).toBeNull();
  });
});
