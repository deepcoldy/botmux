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
import { statSync, type Stats } from 'node:fs';
import { scanJsonlFromOffset } from './jsonl-cursor.js';
import { resolveSessionTranscriptPath } from './transcript-resolver.js';
import type { CliId } from '../adapters/cli/types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 单条 TODO：状态 + 文字。文字来源随方言不同：Claude TodoWrite 的 content、
 *  Task* 的 subject、Codex update_plan 的 step。供 UI 悬浮展示具体清单。 */
export interface TodoItem {
  status: TodoStatus;
  text: string;
}

export interface OpenTodos {
  /** 待办总数（当前快照里的全部条目）。 */
  total: number;
  /** 已完成条目数。 */
  done: number;
  /** 未完成条目数（pending + in_progress）。 */
  remaining: number;
  /** 是否有一项正在进行（in_progress）—— 供 UI 高亮「正在做这一步」。 */
  hasInProgress: boolean;
  /** 每条 TODO 的状态与文字（按原始顺序），供 UI 悬浮展开清单。 */
  items: TodoItem[];
}

function normalizeTodoStatus(value: unknown): TodoStatus | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null;
}

/** 清洗单条文字：转字符串、trim、限长（防超长步骤撑爆浮层）。 */
function cleanTodoText(v: unknown): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** 把一组 {status,text} 折叠成完成度 + 清单。无任何有效状态返回 null（= 没有有效
 *  待办快照，别当成「0 项已交付」，那会让刚清空 todo 的会话和从没建 todo 的会话表现
 *  一致）。 */
function summarize(entries: Array<{ status: TodoStatus | null; text?: unknown }>): OpenTodos | null {
  const valid = entries.filter((e): e is { status: TodoStatus; text?: unknown } => e.status !== null);
  if (valid.length === 0) return null;
  let done = 0;
  let hasInProgress = false;
  const items: TodoItem[] = [];
  for (const e of valid) {
    if (e.status === 'completed') done++;
    else if (e.status === 'in_progress') hasInProgress = true;
    items.push({ status: e.status, text: cleanTodoText(e.text) });
  }
  return { total: valid.length, done, remaining: valid.length - done, hasInProgress, items };
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
      latest = summarize(todos.map((t: any) => ({ status: normalizeTodoStatus(t?.status), text: t?.content ?? t?.activeForm }))) ?? latest;
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
  return summarize(plan.map((p: any) => ({ status: normalizeTodoStatus(p?.status), text: p?.step })));
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

/** 增量折叠状态：把「整份 transcript → 当前任务态」拆成「逐行 fold + 末态 finalize」，
 *  这样全量解析(parseOpenTodos)与增量游标读(readSessionOpenTodos)共用同一套语义，
 *  且可跨多次读盘只 fold 新追加的行。
 *  - codex：latestSnapshot 存最后一次 update_plan 快照（last-write-wins）。
 *  - claude：latestSnapshot 存最后一次 TodoWrite 快照；同时 claudeTasks 增量重放
 *    Task* 事件。finalize 时 TodoWrite 优先，缺失才回退 Task* 重放。 */
interface ClaudeTaskState {
  /** taskId → {status,text}，Map 保序（= 创建顺序），供 UI 顺序展示。 */
  tasks: Map<string, { status: TodoStatus; text: string }>;
  /** TaskCreate 的 tool_use.id → subject，等 tool_result 回填分配的 taskId。 */
  pendingCreate: Map<string, string>;
  sawAnyTask: boolean;
}
export interface TodoFoldState {
  kind: 'claude' | 'codex';
  latestSnapshot: OpenTodos | null;
  claudeTasks?: ClaudeTaskState;
}

export function newTodoFoldState(kind: 'claude' | 'codex'): TodoFoldState {
  return {
    kind,
    latestSnapshot: null,
    claudeTasks: kind === 'claude'
      ? { tasks: new Map(), pendingCreate: new Map(), sawAnyTask: false }
      : undefined,
  };
}

/** 把单条已解析记录折叠进状态（就地修改）。 */
export function foldTodoEntry(state: TodoFoldState, entry: any): void {
  const snap = todoSnapshotFromEntry(entry, state.kind);
  if (snap) state.latestSnapshot = snap; // 后写覆盖：整表快照语义
  if (state.kind === 'claude' && state.claudeTasks) foldClaudeTaskEntry(state.claudeTasks, entry);
}

/** 折叠出末态：TodoWrite/update_plan 快照优先，claude 缺失时回退 Task* 重放。 */
export function finalizeTodoFold(state: TodoFoldState): OpenTodos | null {
  if (state.latestSnapshot) return state.latestSnapshot;
  if (state.kind === 'claude' && state.claudeTasks) return finalizeClaudeTaskState(state.claudeTasks);
  return null;
}

/** 从整份 transcript（已按行解析的记录数组）取当前任务态。
 *  - codex：update_plan 是整表快照，取最后一次即可。
 *  - claude：两种方言二选一——
 *      · 开源版 Claude Code 用 TodoWrite（整表快照，取最后一次）；
 *      · 本 botmux 环境用 Task* 工具（TaskCreate/TaskUpdate 增量），需按记录重放
 *        累积成末态。TodoWrite 优先（真快照）；没有 TodoWrite 时回退到 Task* 重放。 */
export function parseOpenTodos(entries: any[], kind: 'claude' | 'codex'): OpenTodos | null {
  const state = newTodoFoldState(kind);
  for (const entry of entries) foldTodoEntry(state, entry);
  return finalizeTodoFold(state);
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
// 拆成 foldClaudeTaskEntry（逐行）+ finalizeClaudeTaskState（末态），供增量游标读跨
// 多次读盘持续累积同一份 tasks/pendingCreate。
function foldClaudeTaskEntry(ts: ClaudeTaskState, entry: any): void {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name.trim().toLowerCase() : '';
      if (name === 'taskcreate') {
        if (typeof block.id === 'string') {
          const subject = block?.input?.subject ?? block?.input?.activeForm ?? '';
          ts.pendingCreate.set(block.id, typeof subject === 'string' ? subject : String(subject ?? ''));
        }
        ts.sawAnyTask = true;
      } else if (name === 'taskupdate') {
        const id = taskIdString(block?.input?.taskId);
        const st = block?.input?.status;
        if (id) {
          ts.sawAnyTask = true;
          if (st === 'deleted') ts.tasks.delete(id);
          else {
            const norm = normalizeTodoStatus(st);
            // status 缺省的 TaskUpdate（只改 subject/owner 等）不动状态，但要确保
            // 该任务已在册（默认 pending），否则纯元数据更新会丢任务。
            const cur = ts.tasks.get(id) ?? { status: 'pending' as TodoStatus, text: '' };
            const newSubject = typeof block?.input?.subject === 'string' ? block.input.subject : cur.text;
            ts.tasks.set(id, { status: norm ?? cur.status, text: newSubject });
          }
        }
      }
    } else if (block?.type === 'tool_result') {
      const forId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (forId && ts.pendingCreate.has(forId)) {
        const subject = ts.pendingCreate.get(forId) ?? '';
        ts.pendingCreate.delete(forId);
        const assigned = extractCreatedTaskId(block.content);
        if (assigned && !ts.tasks.has(assigned)) ts.tasks.set(assigned, { status: 'pending', text: subject });
      }
    }
  }
}

function finalizeClaudeTaskState(ts: ClaudeTaskState): OpenTodos | null {
  if (!ts.sawAnyTask || ts.tasks.size === 0) return null;
  return summarize([...ts.tasks.values()]);
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

// ── 增量游标读取（对齐 cost-calculator 的 fd+offset 增量扫描思路）──────────────
// dashboard 每次 /api/sessions、以及每个 working→idle 状态边沿都会对会话调一次。
// 关键：触发读盘的那个状态边沿，恰是 transcript 刚追加完本轮输出（含 todo 快照）
// 的时刻——size 变了，任何「(mtime,size) 不变才命中」的缓存在此刻必 miss。若那时
// 走全量 readFileSync+JSON.parse，31MiB 文件实测 ~330ms 全程阻塞 daemon 主线程。
// 故改为「记住上次读到的字节前沿 offset + 折叠状态，只 fold 新追加的行」：
//   · 文件按 (dev,ino) 认身份，size 未变→直接返缓存；size 增长（append-only）→
//     从 offset 增量扫到末尾，fold 进沿用的 TodoFoldState（快照 last-write-wins、
//     Task* 增量重放都天然支持继续累积）；
//   · ino 变/被截断/首次→冷读全量；冷读遇 >32MiB 直接 fail-closed 返 null，
//     绝不返旧 cache 冒充当前（否则越界前的旧 pending 会被永久当成当前状态）。
const MAX_TODO_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const TODO_CACHE_MAX_ENTRIES = 512;

interface TodoCacheEntry {
  dev: number;
  ino: number;
  /** 已折叠到的字节前沿（最后一条完整行之后）。下次从此处增量续读。 */
  offset: number;
  /** 沿用的折叠状态，跨多次读盘持续累积（只 fold 增量行，绝不重折旧行）。 */
  fold: TodoFoldState;
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

/** 读某会话当前 openTodos。定位 transcript → 增量游标读 → 折叠出最后一次 todo 快照。
 *  任何一步失败（不支持的 CLI、无 transcript、冷读越界、解析失败）都返回 null。
 *  fresh=true 绕过 resolver 对「尚未落盘的懒创建 transcript」的 30s miss 负缓存——
 *  spawn 时 rollout 常还没落盘，首个状态边沿读若不置 fresh 会在 30s 内持续吃 miss，
 *  徽标要等 30s 后某次边沿才出现（镜像 cost-calculator 的 fresh 语义）。 */
export function readSessionOpenTodos(q: {
  cliId: CliId | 'unknown' | undefined;
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  larkAppId?: string;
  fresh?: boolean;
}): OpenTodos | null {
  const kind = todoKindForCli(q.cliId);
  if (!kind) return null;

  const resolved = resolveSessionTranscriptPath({
    cliId: q.cliId as CliId,
    sessionId: q.sessionId,
    cliSessionId: q.cliSessionId,
    cwd: q.cwd,
    larkAppId: q.larkAppId,
    fresh: q.fresh,
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
  let st: Stats | null = null;
  try {
    st = statSync(path);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) {
    todoFileCache.delete(path);
    return null;
  }

  const cached = todoFileCache.get(path);
  const sameFile = !!cached && cached.dev === st.dev && cached.ino === st.ino;

  // >32MiB 一律 fail-closed 返 null，绝不返旧 cache——增量路径也一样。冷读越界会全量
  // 阻塞主线程；增量路径遇「同 inode 被整体覆盖成超大文件」若按 append 续读，既读错
  // 前缀又可能扫超大 delta。故在选路前先按总大小一刀切，语义一致、最省心。
  if (st.size > MAX_TODO_TRANSCRIPT_BYTES) {
    todoFileCache.delete(path);
    return null;
  }

  // append-only 增量续读：size 未变→无新行，直接返缓存；size 增长→只扫 [offset,size)。
  if (sameFile && st.size >= cached!.offset) {
    if (st.size === cached!.offset) return cached!.todos;
    return readIncremental(path, st, cached!);
  }

  // 冷读（首次 / 文件被替换或截断）。
  return readCold(path, st, kind);
}

/** 从 offset 增量扫到末尾，把新完整行 fold 进沿用的折叠状态。读失败则丢缓存回退冷读。 */
function readIncremental(path: string, st: Stats, cached: TodoCacheEntry): OpenTodos | null {
  let scanError = false;
  const cursor = scanJsonlFromOffset(path, cached.offset, {
    endOffset: st.size,
    onLine: (line) => foldJsonLine(cached.fold, line),
    onError: () => { scanError = true; },
  });
  if (!cursor || scanError) {
    todoFileCache.delete(path);
    return readCold(path, st, cached.fold.kind);
  }
  cached.dev = st.dev;
  cached.ino = st.ino;
  cached.offset = cursor.newOffset;
  cached.todos = finalizeTodoFold(cached.fold);
  return cached.todos;
}

/** 冷读：从头折叠整份文件，建立新的缓存条目（含折叠状态 + 字节前沿）。 */
function readCold(path: string, st: Stats, kind: 'claude' | 'codex'): OpenTodos | null {
  const fold = newTodoFoldState(kind);
  let scanError = false;
  const cursor = scanJsonlFromOffset(path, 0, {
    endOffset: st.size,
    onLine: (line) => foldJsonLine(fold, line),
    onError: () => { scanError = true; },
  });
  if (!cursor || scanError) {
    todoFileCache.delete(path);
    return null;
  }
  const todos = finalizeTodoFold(fold);
  if (todoFileCache.size >= TODO_CACHE_MAX_ENTRIES && !todoFileCache.has(path)) {
    const oldest = todoFileCache.keys().next().value;
    if (oldest !== undefined) todoFileCache.delete(oldest);
  }
  todoFileCache.set(path, { dev: st.dev, ino: st.ino, offset: cursor.newOffset, fold, todos });
  return todos;
}

/** 解析并折叠单行 JSONL；半写/损坏行跳过（任务态是 advisory）。 */
function foldJsonLine(fold: TodoFoldState, line: string): void {
  if (!line.trim()) return;
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object') foldTodoEntry(fold, parsed);
  } catch {
    // 跳过半写/损坏行。
  }
}
