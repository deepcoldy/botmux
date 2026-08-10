import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
      .toMatchObject({ total: 3, done: 1, remaining: 2, hasInProgress: true });
  });

  it('carries per-item text and status in order (TodoWrite content)', () => {
    // 悬浮浮层要的具体清单：每条 {status,text}，text 取 TodoWrite 的 content。
    expect(todoSnapshotFromEntry(claudeTodo(['completed', 'in_progress', 'pending']), 'claude')?.items)
      .toEqual([
        { status: 'completed', text: 'step 0' },
        { status: 'in_progress', text: 'step 1' },
        { status: 'pending', text: 'step 2' },
      ]);
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
      .toMatchObject({ total: 1, done: 1, remaining: 0, hasInProgress: false });
  });
});

describe('todoSnapshotFromEntry (Codex)', () => {
  it('summarizes an update_plan snapshot (object args)', () => {
    expect(todoSnapshotFromEntry(codexPlan(['completed', 'completed', 'pending']), 'codex'))
      .toMatchObject({ total: 3, done: 2, remaining: 1, hasInProgress: false });
  });

  it('parses update_plan arguments delivered as a JSON string', () => {
    expect(todoSnapshotFromEntry(codexPlan(['in_progress', 'pending'], true), 'codex'))
      .toMatchObject({ total: 2, done: 0, remaining: 2, hasInProgress: true });
  });

  it('carries per-item text from the plan step', () => {
    expect(todoSnapshotFromEntry(codexPlan(['completed', 'pending']), 'codex')?.items)
      .toEqual([
        { status: 'completed', text: 'step 0' },
        { status: 'pending', text: 'step 1' },
      ]);
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
      .toMatchObject({ total: 3, done: 3, remaining: 0, hasInProgress: false });
  });

  it('returns null when the transcript has no todo snapshot at all', () => {
    expect(parseOpenTodos([{ type: 'user', message: { content: 'hi' } }], 'claude')).toBeNull();
    expect(parseOpenTodos([], 'codex')).toBeNull();
  });
});

// ── Claude Code 内建 Task* 工具（本 botmux 环境）的增量重放 ────────────────────
// TaskCreate 无 taskId（分配的号在紧邻 tool_result 文本里），TaskUpdate 按 id 改状态。
const taskCreate = (useId: string, subject: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'TaskCreate', input: { subject, description: 'x', activeForm: 'doing' } }] },
});
const createResult = (useId: string, taskNo: number) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: `Task #${taskNo} created successfully: whatever` }] },
});
const taskUpdate = (taskId: string, status: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `u-${taskId}-${status}`, name: 'TaskUpdate', input: { taskId, status } }] },
});

describe('parseOpenTodos (Claude Task* incremental replay)', () => {
  it('replays TaskCreate/TaskUpdate into the current task state', () => {
    const entries = [
      taskCreate('c1', 'A'), createResult('c1', 1),
      taskCreate('c2', 'B'), createResult('c2', 2),
      taskCreate('c3', 'C'), createResult('c3', 3),
      taskUpdate('1', 'completed'),
      taskUpdate('2', 'in_progress'),
      // 3 仍是创建时的默认 pending
    ];
    expect(parseOpenTodos(entries, 'claude'))
      .toMatchObject({ total: 3, done: 1, remaining: 2, hasInProgress: true });
  });

  it('carries each task subject as item text, in creation order', () => {
    const entries = [
      taskCreate('c1', 'A'), createResult('c1', 1),
      taskCreate('c2', 'B'), createResult('c2', 2),
      taskCreate('c3', 'C'), createResult('c3', 3),
      taskUpdate('1', 'completed'),
      taskUpdate('2', 'in_progress'),
    ];
    expect(parseOpenTodos(entries, 'claude')?.items)
      .toEqual([
        { status: 'completed', text: 'A' },
        { status: 'in_progress', text: 'B' },
        { status: 'pending', text: 'C' },
      ]);
  });

  it('honors the last status per task and drops deleted tasks', () => {
    const entries = [
      taskCreate('c1', 'A'), createResult('c1', 1),
      taskCreate('c2', 'B'), createResult('c2', 2),
      taskUpdate('1', 'in_progress'),
      taskUpdate('1', 'completed'), // 后写覆盖
      taskUpdate('2', 'deleted'),   // 移出清单
    ];
    expect(parseOpenTodos(entries, 'claude'))
      .toMatchObject({ total: 1, done: 1, remaining: 0, hasInProgress: false });
  });

  it('keeps a task in the list on a metadata-only update (no status field)', () => {
    const entries = [
      taskCreate('c1', 'A'), createResult('c1', 1),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '1', subject: 'renamed' } }] } },
    ];
    expect(parseOpenTodos(entries, 'claude'))
      .toMatchObject({ total: 1, done: 0, remaining: 1, hasInProgress: false });
  });

  it('TodoWrite snapshot wins over Task* replay when both are present', () => {
    const entries = [
      taskCreate('c1', 'A'), createResult('c1', 1),
      claudeTodo(['completed', 'completed']),
    ];
    expect(parseOpenTodos(entries, 'claude'))
      .toMatchObject({ total: 2, done: 2, remaining: 0, hasInProgress: false });
  });

  it('returns null when no Task* and no TodoWrite events exist', () => {
    expect(parseOpenTodos([{ type: 'user', message: { content: 'hi' } }], 'claude')).toBeNull();
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
      .toMatchObject({ total: 2, done: 1, remaining: 1, hasInProgress: true });
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

// ── 增量游标读 / fail-closed / 文件替换（二轮审核阻塞②③ + ① fresh 贯穿）──────────
// readSessionOpenTodos 走真实落盘 transcript：写在 resolver 计算出的
// ~/.claude/projects/<项目key>/<sessionId>.jsonl。cwd 用 mkdtemp 保证 projectKey
// 唯一（realpath→非字母数字转 '-'），sessionId 带随机后缀，afterEach 清理该文件。
describe('readSessionOpenTodos (增量续读 / fail-closed / 文件替换)', () => {
  let cwdDir: string;
  let transcriptPath: string;

  // resolver: projectKey = realpathSync(cwd) 里非 [A-Za-z0-9-] → '-'。
  function transcriptPathFor(cwd: string, sessionId: string): string {
    const projectKey = realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-');
    const projectDir = join(homedir(), '.claude', 'projects', projectKey);
    mkdirSync(projectDir, { recursive: true });
    return join(projectDir, `${sessionId}.jsonl`);
  }
  const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

  afterEach(() => {
    __resetTodoStateCacheForTest();
    if (transcriptPath) rmSync(transcriptPath, { force: true });
    if (cwdDir) rmSync(cwdDir, { recursive: true, force: true });
    transcriptPath = '';
    cwdDir = '';
  });

  function setup(): { sessionId: string; cwd: string } {
    cwdDir = mkdtempSync(join(tmpdir(), 'todo-cwd-'));
    const sessionId = `sess-${process.pid}-${Math.floor(performance.now() * 1000)}`;
    transcriptPath = transcriptPathFor(cwdDir, sessionId);
    return { sessionId, cwd: cwdDir };
  }

  it('增量续读：追加新 TodoWrite 快照后反映最新状态（不重折旧行）', () => {
    const { sessionId, cwd } = setup();
    writeFileSync(transcriptPath, line(claudeTodo(['pending', 'pending', 'pending'])));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 3, done: 0, remaining: 3, hasInProgress: false });

    // 追加一条更新过的快照——增量路径应只 fold 新行、给出最新末态。
    appendFileSync(transcriptPath, line(claudeTodo(['completed', 'completed', 'in_progress'])));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 3, done: 2, remaining: 1, hasInProgress: true });
  });

  it('增量续读：Task* 增量事件跨多次读盘持续累积', () => {
    const { sessionId, cwd } = setup();
    writeFileSync(transcriptPath, line(taskCreate('c1', 'A')) + line(createResult('c1', 1)));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 1, done: 0, remaining: 1, hasInProgress: false });

    // 追加第二个任务 + 把第一个标完成——沿用折叠状态，末态应为 2 项 1 完成。
    appendFileSync(transcriptPath, line(taskCreate('c2', 'B')) + line(createResult('c2', 2)) + line(taskUpdate('1', 'completed')));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 2, done: 1, remaining: 1, hasInProgress: false });
  });

  it('size 未变则直接返缓存（无新行，稳定同值）', () => {
    const { sessionId, cwd } = setup();
    writeFileSync(transcriptPath, line(claudeTodo(['completed', 'pending'])));
    const first = readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd });
    const second = readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd });
    expect(second).toEqual(first);
    expect(second).toMatchObject({ total: 2, done: 1, remaining: 1 });
  });

  it('文件被整体替换（内容变短，size<offset）→ 冷读重解析，不返旧值', () => {
    const { sessionId, cwd } = setup();
    writeFileSync(transcriptPath, line(claudeTodo(['completed', 'completed', 'completed'])));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 3, done: 3, remaining: 0 });

    // 用更短的新内容整体覆盖（size 变小 < 上次 offset）——必须冷读出新的单项状态。
    writeFileSync(transcriptPath, line(claudeTodo(['pending'])));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 1, done: 0, remaining: 1, hasInProgress: false });
  });

  it('冷读遇 >32MiB transcript → fail-closed 返 null，绝不返旧 cache', () => {
    const { sessionId, cwd } = setup();
    // 先建一个正常的小文件并读出有效值，占住 cache。
    writeFileSync(transcriptPath, line(claudeTodo(['completed', 'pending'])));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd }))
      .toMatchObject({ total: 2, done: 1 });

    // 整体替换成一个 >32MiB 的新文件（size<offset 触发冷读路径，超阈值 fail-closed）。
    const bigLine = line(claudeTodo(['pending']));
    const header = Buffer.from(bigLine);
    const filler = Buffer.alloc(33 * 1024 * 1024, 0x20); // 33MiB 空格，非法 JSON 也无所谓——超阈直接拒
    writeFileSync(transcriptPath, Buffer.concat([header, filler]));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd })).toBeNull();
  });

  it('fresh 贯穿：resolver miss 负缓存后，fresh=true 能在同一读里拿到刚落盘的 transcript', () => {
    // 先用非 fresh 读一次不存在的 transcript（种下 resolver 的 30s miss 负缓存），
    // 再落盘并以 fresh=true 读——fresh 绕过负缓存立即命中，而非等 30s。
    cwdDir = mkdtempSync(join(tmpdir(), 'todo-cwd-'));
    const sessionId = `sess-fresh-${process.pid}-${Math.floor(performance.now() * 1000)}`;
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd: cwdDir })).toBeNull();

    transcriptPath = transcriptPathFor(cwdDir, sessionId);
    writeFileSync(transcriptPath, line(claudeTodo(['completed', 'in_progress'])));
    expect(readSessionOpenTodos({ cliId: 'claude-code', sessionId, cwd: cwdDir, fresh: true }))
      .toMatchObject({ total: 2, done: 1, remaining: 1, hasInProgress: true });
  });
});
