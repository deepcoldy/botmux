import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  parseOpenTodos,
  todoSnapshotFromEntry,
  readSessionOpenTodos,
  __resetTodoStateCacheForTest,
} from '../src/services/todo-state.js';
import { __resetTranscriptResolverCacheForTest } from '../src/services/transcript-resolver.js';

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

// ── 落盘 transcript：增量续读 / fail-closed / 文件替换 / fresh 贯穿 ───────────────
// 二轮审核阻塞②③ + ① fresh。全部走 codex 方言，原因有二：
//   1) fresh 只在「resolver 带 30s miss 负缓存」的路径上有意义。claude-code 分支每次
//      调用都现算（newerFile 直读盘），fresh 是 no-op——用它测 fresh 是假绿（删掉生产
//      代码里的 fresh 透传，claude 用例照样过）。codex 分支走
//      cachedTranscriptPathLookup(...,{retryMiss:q.fresh})，才真正锁住护栏。
//   2) codex home 由 CODEX_HOME 环境变量定向，fixture 全写进临时目录，绝不污染开发者
//      真实 ~/.codex 或 ~/.claude（上一版把 fixture 写进真实 ~/.claude/projects 且没删
//      projectKey 目录——已修正为环境定向 + 整体清理，杜绝 PR #792 同类的数据目录污染）。
// 增量游标 / fail-closed / 文件替换的机制与方言无关；Claude 的 Task* 增量重放由上面的
// 纯 parseOpenTodos 单测覆盖，这里不再落盘重复。
describe('readSessionOpenTodos (落盘 codex rollout：增量续读 / fail-closed / 文件替换 / fresh)', () => {
  let codexHome: string;
  let prevCodexHome: string | undefined;
  let sidCounter = 0;

  beforeAll(() => {
    prevCodexHome = process.env.CODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), 'todo-codexhome-'));
    process.env.CODEX_HOME = codexHome;
  });
  afterAll(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  });
  afterEach(() => {
    __resetTodoStateCacheForTest();
    __resetTranscriptResolverCacheForTest();
  });

  const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

  // codex rollout 路径：<CODEX_HOME>/sessions/<Y>/<M>/<D>/rollout-<ts>-<sid>.jsonl。
  // 每个用例用唯一 sid，避免 resolver 正向缓存（路径命中永久 TTL）跨用例串味。
  function newSession(): { sessionId: string; cliSessionId: string; rolloutPath: string } {
    const cliSessionId = `sid-${process.pid}-${sidCounter++}`;
    const dir = join(codexHome, 'sessions', '2026', '08', '10');
    mkdirSync(dir, { recursive: true });
    const rolloutPath = join(dir, `rollout-2026-08-10T00-00-00-${cliSessionId}.jsonl`);
    return { sessionId: `bmx-${cliSessionId}`, cliSessionId, rolloutPath };
  }
  const read = (s: { sessionId: string; cliSessionId: string }, fresh?: boolean) =>
    readSessionOpenTodos({ cliId: 'codex', sessionId: s.sessionId, cliSessionId: s.cliSessionId, fresh });

  it('无 rollout 落盘时解析为 null，不抛异常', () => {
    const s = newSession();
    expect(read(s)).toBeNull();
  });

  it('增量续读：追加新 update_plan 快照后反映最新状态（只 fold 新行）', () => {
    const s = newSession();
    writeFileSync(s.rolloutPath, line(codexPlan(['pending', 'pending', 'pending'])));
    expect(read(s)).toMatchObject({ total: 3, done: 0, remaining: 3, hasInProgress: false });

    // 追加更新过的快照——增量路径只 fold 新行、给出最新末态（last-write-wins）。
    appendFileSync(s.rolloutPath, line(codexPlan(['completed', 'completed', 'in_progress'])));
    expect(read(s)).toMatchObject({ total: 3, done: 2, remaining: 1, hasInProgress: true });
  });

  it('size 未变则直接返缓存（无新行，稳定同值）', () => {
    const s = newSession();
    writeFileSync(s.rolloutPath, line(codexPlan(['completed', 'pending'])));
    const first = read(s);
    const second = read(s);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ total: 2, done: 1, remaining: 1 });
  });

  it('文件被整体替换（内容变短，size<offset）→ 冷读重解析，不返旧值', () => {
    const s = newSession();
    writeFileSync(s.rolloutPath, line(codexPlan(['completed', 'completed', 'completed'])));
    expect(read(s)).toMatchObject({ total: 3, done: 3, remaining: 0 });

    // 更短的新内容整体覆盖（size 变小 < 上次 offset）——必须冷读出新的单项状态。
    writeFileSync(s.rolloutPath, line(codexPlan(['pending'])));
    expect(read(s)).toMatchObject({ total: 1, done: 0, remaining: 1, hasInProgress: false });
  });

  it('>32MiB transcript → fail-closed 返 null，绝不返旧 cache（含增量路径）', () => {
    const s = newSession();
    // 先建正常小文件并读出有效值，占住 cache（offset 前沿）。
    writeFileSync(s.rolloutPath, line(codexPlan(['completed', 'pending'])));
    expect(read(s)).toMatchObject({ total: 2, done: 1 });

    // 同 inode 原地追加撑到 >32MiB：既走「size≥offset 的增量分支」，护栏又必须拦下。
    // 这正是上一版漏掉的路径（旧护栏只挡冷读）——现在选路前一刀切，返 null。
    appendFileSync(s.rolloutPath, Buffer.alloc(33 * 1024 * 1024, 0x20));
    expect(read(s)).toBeNull();
  });

  it('fresh 贯穿：resolver miss 负缓存后，fresh=true 当场解析成功（non-fresh=null）', () => {
    // codex 分支带 30s miss 负缓存。先非 fresh 读一次（rollout 尚未落盘）种下负缓存，
    // 再落盘：不带 fresh 仍吃负缓存返 null；带 fresh 绕过负缓存当场解析成功。
    const s = newSession();
    expect(read(s)).toBeNull();               // 种下 miss 负缓存
    writeFileSync(s.rolloutPath, line(codexPlan(['completed', 'in_progress'])));
    expect(read(s)).toBeNull();               // 非 fresh：仍吃 30s 负缓存
    expect(read(s, true))                      // fresh：绕过负缓存，当场命中
      .toMatchObject({ total: 2, done: 1, remaining: 1, hasInProgress: true });
  });
});
