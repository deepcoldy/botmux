// 任务态（openTodos）：从 Claude / Codex 的 transcript 里提取「当前 TODO 完成度」。
//
// 会话状态重设计 P2：运行态（进程忙/闲）与任务态（活干完没）正交。运行态已由
// worker 的 readyPattern/busyPattern 探测；任务态这里从 CLI 自己维护的待办列表读：
//   - Claude Code：`TodoWrite` 工具调用，input.todos[] 每项 {content,status,activeForm}
//   - Codex：`update_plan` 函数调用，arguments.plan[] 每项 {step,status}
// 两者都是「整表快照、后写覆盖前写」，所以取 transcript 里最后一次调用即当前状态。
// status 口径统一为 pending / in_progress / completed（与 insight/classify 同源）。
//
// 读不到（其它 CLI、无 transcript、从未写过 todo）返回 null —— 由调用方标「未知/不
// 支持」，绝不硬猜完成度。纯解析函数 parseOpenTodos 无 fs 依赖，便于单测。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolveSessionTranscriptPath } from './transcript-resolver.js';
import type { CliId } from '../adapters/cli/types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface OpenTodos {
  /** 待办总数（当前快照里的全部条目）。 */
  total: number;
  /** 已完成条目数。 */
  done: number;
  /** 未完成条目数（pending + in_progress）。 */
  remaining: number;
  /** 是否有一项正在进行（in_progress）—— 供 UI 高亮「正在做这一步」。 */
  hasInProgress: boolean;
}

function normalizeTodoStatus(value: unknown): TodoStatus | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null;
}

/** 把一组 {status} 折叠成完成度。空数组返回 null（= 没有有效待办快照，别当成
 *  「0 项已交付」，那会让刚清空 todo 的会话和从没建 todo 的会话表现一致）。 */
function summarize(statuses: Array<TodoStatus | null>): OpenTodos | null {
  const valid = statuses.filter((s): s is TodoStatus => s !== null);
  if (valid.length === 0) return null;
  let done = 0;
  let hasInProgress = false;
  for (const s of valid) {
    if (s === 'completed') done++;
    else if (s === 'in_progress') hasInProgress = true;
  }
  return { total: valid.length, done, remaining: valid.length - done, hasInProgress };
}

/** 从单条已解析的 transcript 记录里取 todo 快照；不是 todo 记录返回 null。
 *  Claude：assistant 消息里 name==='TodoWrite' 的 tool_use，input.todos[]。
 *  Codex：response_item 里 payload.type==='function_call' 且 name==='update_plan',
 *         arguments.plan[]（arguments 可能是 JSON 字符串）。 */
export function todoSnapshotFromEntry(entry: any, kind: 'claude' | 'codex'): OpenTodos | null {
  if (!entry || typeof entry !== 'object') return null;

  if (kind === 'claude') {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return null;
    let latest: OpenTodos | null = null;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const name = typeof block.name === 'string' ? block.name.trim().toLowerCase() : '';
      if (name !== 'todowrite') continue;
      const todos = block?.input?.todos;
      if (!Array.isArray(todos)) continue;
      // 同一条消息里若出现多次（罕见），后者覆盖前者。
      latest = summarize(todos.map((t: any) => normalizeTodoStatus(t?.status))) ?? latest;
    }
    return latest;
  }

  // codex
  const payload = entry?.payload ?? {};
  if (entry?.type !== 'response_item' || payload?.type !== 'function_call') return null;
  const name = typeof payload.name === 'string' ? payload.name.trim().toLowerCase() : '';
  if (name !== 'update_plan') return null;
  const args = parseArgs(payload.arguments ?? payload.input);
  const plan = args?.plan;
  if (!Array.isArray(plan)) return null;
  return summarize(plan.map((p: any) => normalizeTodoStatus(p?.status)));
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从整份 transcript（已按行解析的记录数组）取当前任务态。
 *  - codex：update_plan 是整表快照，取最后一次即可。
 *  - claude：两种方言二选一——
 *      · 开源版 Claude Code 用 TodoWrite（整表快照，取最后一次）；
 *      · 本 botmux 环境用 Task* 工具（TaskCreate/TaskUpdate 增量），需按记录重放
 *        累积成末态。TodoWrite 优先（真快照）；没有 TodoWrite 时回退到 Task* 重放。 */
export function parseOpenTodos(entries: any[], kind: 'claude' | 'codex'): OpenTodos | null {
  let latest: OpenTodos | null = null;
  for (const entry of entries) {
    const snap = todoSnapshotFromEntry(entry, kind);
    if (snap) latest = snap; // 后写覆盖：整表快照语义，只保留最后一次
  }
  if (latest) return latest;
  // 无 TodoWrite/update_plan 快照时，claude 侧尝试 Task* 增量重放。
  if (kind === 'claude') return replayClaudeTaskState(entries);
  return null;
}

// ── Claude Code 内建 Task* 工具（本 botmux 环境）的增量重放 ────────────────────
// 与开源版 TodoWrite（整表快照）不同，本环境的任务清单是增量事件：
//   · TaskCreate：input={subject,description,activeForm}，无 taskId——分配的 id 在
//     紧邻的 tool_result 文本里「Task #N created successfully: ...」。新任务初始
//     状态 pending。
//   · TaskUpdate：input={taskId, status?, ...}，status ∈ pending/in_progress/
//     completed/deleted。deleted 从清单移除（工具语义：永久删除）。
// 按 tool_use.id 关联 TaskCreate 与其结果，重放出 Map<taskId,status> 末态，再折叠
// 成 OpenTodos。整个清单没有任何任务时返回 null（= 未用过任务清单，别当已交付）。
function replayClaudeTaskState(entries: any[]): OpenTodos | null {
  const status = new Map<string, TodoStatus>();
  // TaskCreate 的 tool_use.id → 该次创建（等它的 tool_result 回填分配的 taskId）。
  const pendingCreate = new Map<string, true>();
  let sawAnyTask = false;

  for (const entry of entries) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name.trim().toLowerCase() : '';
        if (name === 'taskcreate') {
          if (typeof block.id === 'string') pendingCreate.set(block.id, true);
          sawAnyTask = true;
        } else if (name === 'taskupdate') {
          const id = taskIdString(block?.input?.taskId);
          const st = block?.input?.status;
          if (id) {
            sawAnyTask = true;
            if (st === 'deleted') status.delete(id);
            else {
              const norm = normalizeTodoStatus(st);
              // status 缺省的 TaskUpdate（只改 subject/owner 等）不动状态，但要确保
              // 该任务已在册（默认 pending），否则纯元数据更新会丢任务。
              if (!status.has(id)) status.set(id, 'pending');
              if (norm) status.set(id, norm);
            }
          }
        }
      } else if (block?.type === 'tool_result') {
        const forId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (forId && pendingCreate.has(forId)) {
          pendingCreate.delete(forId);
          const assigned = extractCreatedTaskId(block.content);
          if (assigned && !status.has(assigned)) status.set(assigned, 'pending');
        }
      }
    }
  }

  if (!sawAnyTask || status.size === 0) return null;
  return summarize([...status.values()]);
}

function taskIdString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 从 TaskCreate 的 tool_result 文本里抓分配的任务号：「Task #N created successfully」。
 *  content 可能是纯字符串，或 [{type:'text',text}] 数组。 */
function extractCreatedTaskId(content: unknown): string | null {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  }
  const m = text.match(/Task #(\d+) created/i);
  return m ? m[1] : null;
}

// ── 带 mtime 失效的缓存读取（对齐 cost-calculator 的 usageFileCache 思路）──────
// dashboard 每次 /api/sessions 会对每个会话调一次；用 mtime+size 命中缓存，避免
// 每请求重读整份 transcript。超大文件跳过（与 insight jsonl 的 32MB 上限一致）。
const MAX_TODO_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const TODO_CACHE_MAX_ENTRIES = 512;

interface TodoCacheEntry {
  mtimeMs: number;
  size: number;
  todos: OpenTodos | null;
}
const todoFileCache = new Map<string, TodoCacheEntry>();

export function __resetTodoStateCacheForTest(): void {
  todoFileCache.clear();
}

function todoKindForCli(cliId: CliId | 'unknown' | undefined): 'claude' | 'codex' | null {
  switch (cliId) {
    case 'claude-code':
    case 'seed':
    case 'relay':
    case 'aiden':
      return 'claude';
    case 'codex':
    case 'traex':
      return 'codex';
    default:
      return null; // 其它 CLI 暂不支持任务态提取
  }
}

/** 读某会话当前 openTodos。定位 transcript → mtime 缓存 → 解析最后一次 todo 快照。
 *  任何一步失败（不支持的 CLI、无 transcript、超大、解析失败）都返回 null。 */
export function readSessionOpenTodos(q: {
  cliId: CliId | 'unknown' | undefined;
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
}): OpenTodos | null {
  const kind = todoKindForCli(q.cliId);
  if (!kind) return null;

  const resolved = resolveSessionTranscriptPath({
    cliId: q.cliId as CliId,
    sessionId: q.sessionId,
    cliSessionId: q.cliSessionId,
    cwd: q.cwd,
  });
  // resolver 的 kind 与我们的 todo dialect 需一致。traex rollout 与 codex 逐字节同构
  // （response_item + function_call），按 codex 方言解析。
  if (!resolved) return null;
  const resolvedKind: 'claude' | 'codex' | null =
    resolved.kind === 'claude' ? 'claude'
    : resolved.kind === 'codex' || resolved.kind === 'traex' ? 'codex'
    : null;
  if (resolvedKind !== kind) return null;

  const path = resolved.path;
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(path);
  } catch {
    st = null;
  }
  if (!st) {
    todoFileCache.delete(path);
    return existsSync(path) ? parseFile(path, kind) : null;
  }

  const cached = todoFileCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.todos;
  }
  if (st.size > MAX_TODO_TRANSCRIPT_BYTES) {
    return cached?.todos ?? null;
  }

  const todos = parseFile(path, kind);
  if (todoFileCache.size >= TODO_CACHE_MAX_ENTRIES && !todoFileCache.has(path)) {
    const oldest = todoFileCache.keys().next().value;
    if (oldest !== undefined) todoFileCache.delete(oldest);
  }
  todoFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, todos });
  return todos;
}

function parseFile(path: string, kind: 'claude' | 'codex'): OpenTodos | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const entries: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // 跳过半写/损坏行；任务态是 advisory。
    }
  }
  return parseOpenTodos(entries, kind);
}
