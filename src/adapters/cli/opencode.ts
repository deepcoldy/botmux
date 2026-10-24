import { existsSync } from 'node:fs';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { openDatabaseSyncNow } from '../../services/sqlite-compat.js';
import { resolveCommand } from './registry.js';
import { detectModelsViaExec } from './model-catalog-json.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { wrapBracketedPaste } from './tui-input.js';
import { TMUX_INITIAL_PROMPT_ARG_BUDGET, type CliAdapter, type PtyHandle, type ResumableSession } from './types.js';
import { opencodeDbPath } from '../../services/opencode-paths.js';

import { delay } from '../../utils/timing.js';

/**
 * OpenCode 会话存储：1.17+ 是一个全局 SQLite 库（opencode.db），session 表一行一个
 * 会话（id 形如 `ses_…`，带 directory/title/时间戳），message/part 表存对话内容。
 * TUI 用 `-s/--session <id>` 精确续接既有会话（实测 1.17.11：同目录重启后历史完整
 * 加载、新消息落在同一 session 行；不存在的 id 会立即 exit 1 "Session not found"，
 * 所以 checkResumeTargetExists 必须先探测，否则 daemon 自动重启路径会 crash-loop）。
 *
 * 会话 id 的发现走 traex 同款两条路：
 *   - writeInput 后到 DB 里验证 user part 是否落库（顺带拿到 session_id 持久化）；
 *   - 兜底：botmux 每条 prompt 都嵌 `<session_id>` 块，直接在 part 表按文本反查。
 */

const OPENCODE_SESSION_ID_RE = /^ses_[0-9A-Za-z-]+$/;
const OPENCODE_PASTE_THRESHOLD = 150;

/** `models` 列表里一行模型 id 的形态：provider/name（允许多级，如 openrouter/anthropic/claude-sonnet-4）。 */
const MODEL_ID_RE = /^[^\s/]+(?:\/[^\s]+)+$/;

/**
 * 解析 `opencode models` / `mimo models` 的纯文本输出为模型 id 列表。
 * 输出每行一个模型，可带 ` — window 1.05M, compacts at 944K` 这类展示元数据
 * （实测 mimo 1.x）；管道下无 ANSI 颜色，但 TTY 直出时可能带，先剥掉。
 * 容错：只保留符合 provider/name 形态的行，标题/空行/坏行一律跳过（一条坏数据
 * 不影响其余模型）；去重并保持出现顺序。
 */
export function parseModelList(stdout: string): string[] {
  return [...new Set(stdout
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+—.*$/, '').trim())
    .filter((line) => MODEL_ID_RE.test(line)))];
}

/** 判断是否 OpenCode 原生会话 id（`ses_…`）。opencode2 复用同一套 id 规则。 */
export function isOpenCodeSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && OPENCODE_SESSION_ID_RE.test(value);
}

function normaliseText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function textMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const na = normaliseText(actual);
  const ne = normaliseText(expected);
  if (na === ne) return true;
  // 宽容前缀匹配：多行内容在 TUI 里可能被嵌入换行提前提交（只提交了第一段），
  // 或 DB 侧截断。宁可认作已提交，也不误报"未确认"（与旧盲发行为对齐，不回退）。
  if (na.length > 0 && (ne.startsWith(na) || na.startsWith(ne.slice(0, na.length)))) return true;
  // OpenCode 只会在原始输入前加 Directory Context；BotMux 信封本身必须作为
  // 完整、不变的后缀落库。把 user_message 内容视为不透明文本，不解析其中可能
  // 出现的 XML-looking 字符串。
  return ne.length > 0 && na.endsWith(ne);
}

// -- SQLite helpers (node:sqlite, Node 22+ experimental) -----------------

/**
 * 存储层版本选择。opencode 1.x 写 V1 表（session/message/part）；opencode2
 * （next-17135 起实测）把新会话写入 V2 表（session_v2/session_message），V1 表
 * 冻结不再更新。两套表字段高度同构（id/directory/title/time_created 等一致），
 * 查询差异集中在 user 文本行的定位方式：
 *   - V1：part JOIN message，role 从 message.data 解析，text 在 part.data
 *   - V2：session_message 自带 type 列，user 文本在 data 的 $.text
 * 各 helper 按 kind 切换 SQL；opencode 适配器恒走 v1（默认），opencode2 传 v2。
 */
export type OpenCodeDbKind = 'v1' | 'v2';

type DatabaseSyncLike = {
  prepare(sql: string): StatementSyncLike;
  close(): void;
};
type StatementSyncLike = {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
};

/** 只读打开 opencode.db 执行一次查询。DB 是 WAL 模式且被活跃 OpenCode 进程持有，
 *  read-only 连接可并发读；任何失败（模块缺失/文件不存在/短暂锁忙）都回落 null，
 *  上层按"无法验证"降级，不影响输入投递本身。opencode2 与 opencode 共用该库。 */
export function withDb<T>(fn: (db: DatabaseSyncLike) => T, dbPath = opencodeDbPath()): T | null {
  if (!existsSync(dbPath)) return null;
  // Runtime-agnostic open: node:sqlite on Node, bun:sqlite on the compiled
  // binary (node:sqlite is absent under Bun). Returns null if neither loads,
  // matching the best-effort degrade below.
  const db = openDatabaseSyncNow(dbPath, { readOnly: true }) as DatabaseSyncLike | null;
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 提交验证基线：当前存储层最大 time_created（epoch ms，与 worker 同机同钟）。
 *  之后只认 >= 基线的新行，避免历史消息误配。 */
export function snapPartBaseline(kind: OpenCodeDbKind = 'v1', dbPath = opencodeDbPath()): number | null {
  const table = kind === 'v2' ? 'session_message' : 'part';
  return withDb((db) => {
    const row = db.prepare(`SELECT COALESCE(MAX(time_created), 0) AS ts FROM ${table}`).get() as { ts: number } | undefined;
    return row?.ts ?? 0;
  }, dbPath);
}

/**
 * 基线之后是否出现文本匹配的 user 行；命中则带回其 session_id（= OpenCode 原生
 * 会话 id）。全局 DB 多实例并发写也安全：靠文本相等排除别的会话的行。
 * 严格 `>` 基线：`>=` 会在"用户因疑似丢失而重发同一段文本"时误配上一条的行，
 * 把真丢失误报为已提交；同毫秒漏检的窗口可忽略（新行时间戳必然晚于既有最大值）。
 */
function detectNewSubmit(
  baseline: number,
  expectedText: string,
  kind: OpenCodeDbKind,
  dbPath: string,
): { found: boolean; cliSessionId?: string } {
  const q = kind === 'v2'
    ? "SELECT session_id AS sid, json_extract(data, '$.text') AS text " +
      "FROM session_message WHERE type = 'user' " +
      "  AND json_extract(data, '$.text') IS NOT NULL " +
      '  AND time_created > ? ' +
      'ORDER BY time_created DESC LIMIT 20'
    : "SELECT p.session_id AS sid, json_extract(p.data, '$.text') AS text " +
      'FROM part p JOIN message m ON m.id = p.message_id ' +
      "WHERE json_extract(m.data, '$.role') = 'user' " +
      "  AND json_extract(p.data, '$.type') = 'text' " +
      '  AND p.time_created > ? ' +
      'ORDER BY p.time_created DESC LIMIT 20';
  return withDb((db) => {
    const rows = db.prepare(q).all(baseline) as { sid: string; text?: string }[];
    for (const r of rows) {
      if (r.text && textMatches(r.text, expectedText)) {
        return { found: true, cliSessionId: r.sid };
      }
    }
    return { found: false };
  }, dbPath) ?? { found: false };
}

/** 提交验证轮询（writeInput 共用实现，opencode2 复用）：基线已由调用方采样，
 *  之后只认 > 基线的新 user 行；命中则带回 cliSessionId。斜杠命令基线为 null
 *  （不产生 user message 行），直接视为已提交。kind 选存储层（v1/v2）。 */
export async function detectOpenCodeSubmit(
  pty: PtyHandle,
  baseline: number | null,
  content: string,
  delayFn: (ms: number) => Promise<void> = delay,
  kind: OpenCodeDbKind = 'v1',
  dbPath = opencodeDbPath(),
  retryEnter = true,
): Promise<{ submitted: boolean; cliSessionId?: string; recheck?: () => { submitted: boolean; cliSessionId?: string } | false }> {
  const trySendEnter = (): boolean => {
    try {
      if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
      else pty.write('\r');
      return true;
    } catch {
      return false;
    }
  };

  if (baseline === null) return { submitted: true };

  for (let attempt = 0; attempt < 3; attempt++) {
    const match = detectNewSubmit(baseline, content, kind, dbPath);
    if (match.found) {
      return match.cliSessionId
        ? { submitted: true, cliSessionId: match.cliSessionId }
        : { submitted: true };
    }
    await delayFn(800);
    // 等待期间记录可能已落库：发送重试 Enter 前先复查，命中就不再补发 Enter
    // （避免对已提交的内容多按一次回车，把输入框里本已提交的行再触发一次）。
    const afterWait = detectNewSubmit(baseline, content, kind, dbPath);
    if (afterWait.found) {
      return afterWait.cliSessionId
        ? { submitted: true, cliSessionId: afterWait.cliSessionId }
        : { submitted: true };
    }
    if (retryEnter && !trySendEnter()) return { submitted: false };
  }
  const finalMatch = detectNewSubmit(baseline, content, kind, dbPath);
  if (finalMatch.found) {
    return finalMatch.cliSessionId
      ? { submitted: true, cliSessionId: finalMatch.cliSessionId }
      : { submitted: true };
  }
  const recheck = () => {
    const late = detectNewSubmit(baseline, content, kind, dbPath);
    return late.found
      ? { submitted: true, cliSessionId: late.cliSessionId }
      : false;
  };
  return { submitted: false, recheck };
}

/** 兜底反查：botmux 每条 prompt 都带 `<session_id>xxx</session_id>` 块，按该文本在
 *  user 行里找最近命中的 OpenCode 会话。用于 cliSessionId 尚未持久化时的 resume
 *  （典型：首条消息经输入队列投递、没走 writeInput 验证就被 suspend/重启）。 */
export function latestOpenCodeSessionForBotmuxSession(botmuxSessionId: string, kind: OpenCodeDbKind = 'v1', dbPath = opencodeDbPath()): string | undefined {
  const q = kind === 'v2'
    ? "SELECT session_id AS sid FROM session_message WHERE type = 'user' AND instr(data, ?) > 0 " +
      'ORDER BY time_created DESC LIMIT 1'
    : 'SELECT p.session_id AS sid ' +
      'FROM part p JOIN message m ON m.id = p.message_id ' +
      "WHERE json_extract(m.data, '$.role') = 'user' " +
      "  AND json_extract(p.data, '$.type') = 'text' " +
      '  AND instr(p.data, ?) > 0 ' +
      'ORDER BY p.time_created DESC LIMIT 1';
  return withDb((db) => {
    const row = db.prepare(q).get(botmuxSessionId) as { sid?: string } | undefined;
    return row?.sid;
  }, dbPath) ?? undefined;
}

export function sessionRowExists(cliSessionId: string, kind: OpenCodeDbKind = 'v1', dbPath = opencodeDbPath()): boolean | null {
  const table = kind === 'v2' ? 'session_v2' : 'session';
  return withDb((db) => {
    const row = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? LIMIT 1`).get(cliSessionId) as { ok?: number } | undefined;
    return !!row?.ok;
  }, dbPath);
}

/** 会话忙碌态判断的时效窗口（毫秒）。超过此窗口未更新的异常/孤儿记录不判忙，避免进程异常终止导致死锁。 */
export const OPENCODE_BUSY_FRESHNESS_MS = 120_000;

/**
 * 探测 OpenCode 会话当前是否处于执行中（时效内的工具调用中或模型生成中）。
 *
 * 判 busy 准则（必须在 freshnessWindowMs 时效窗口内，满足任一即为 busy）：
 *  1. 存在属于该 session、状态为 `status: "running"` 的 tool part；
 *  2. 该 session 最新的一条 assistant message 处于未完成状态（没有 completed 时间戳）。
 */
export function isOpenCodeInitialPromptComplete(
  baseline: number,
  cliSessionId: string,
  kind: OpenCodeDbKind = 'v1',
  dbPath = opencodeDbPath(),
): boolean {
  const table = kind === 'v2' ? 'session_message' : 'message';
  const role = kind === 'v2' ? "type = 'assistant'" : "json_extract(data, '$.role') = 'assistant'";
  const completed = kind === 'v2'
    ? "json_extract(data, '$.time.completed')"
    : "json_extract(data, '$.time.completed')";
  return withDb((db) => {
    const assistant = db.prepare(
      `SELECT ${completed} AS completed FROM ${table} WHERE session_id = ? AND ${role} AND time_created > ? ORDER BY time_created DESC LIMIT 1`,
    ).get(cliSessionId, baseline) as { completed?: number | null } | undefined;
    if (assistant?.completed === undefined || assistant.completed === null) return false;
    const runningTool = kind === 'v2'
      ? db.prepare(
        "SELECT 1 AS busy FROM session_message WHERE session_id = ? AND time_created > ? AND json_extract(data, '$.state.status') = 'running' LIMIT 1",
      ).get(cliSessionId, baseline)
      : db.prepare(
        "SELECT 1 AS busy FROM part WHERE session_id = ? AND time_created > ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') = 'running' LIMIT 1",
      ).get(cliSessionId, baseline);
    return !(runningTool as { busy?: number } | undefined)?.busy;
  }, dbPath) ?? false;
}

export function isOpenCodeSessionBusy(
  cliSessionId: string,
  kind: OpenCodeDbKind = 'v1',
  freshnessWindowMs: number = OPENCODE_BUSY_FRESHNESS_MS,
  dbPath = opencodeDbPath(),
  /** 由 worker 注入：本会话 CLI 子进程是否存活；undefined = 无法判断（无 pid）。 */
  isCliProcessAlive?: () => boolean | undefined,
): boolean {
  const freshBaseline = Date.now() - freshnessWindowMs;

  if (kind === 'v2') {
    return withDb((db) => {
      // V2 的权威「整轮结束」标记：OpenCode 2 在每个执行回合（成功 / 失败 /
      // interrupted）彻底 drain 后，都会写入一条 type='idle' 的 session_message
      // （实测 2.0.x：`{ time: { created }, outcome: 'succeeded' | 'failed' | … }`，
      // 落在最后一条 assistant completed 之后数毫秒）。该标记不参与插件事件流
      // （`session.idle` 只在 TUI 本地 bus 上），但在 TUI / serve / run 三种模式下
      // 都会持久化，因此是区分「整轮结束」与「步骤间等待」的唯一权威存储依据。
      const lastIdle = db.prepare(
        "SELECT COALESCE(MAX(time_created), 0) AS t FROM session_message " +
        "WHERE session_id = ? AND type = 'idle'"
      ).get(cliSessionId) as { t?: number } | undefined;
      // 各结构信号统一用「严格晚于 turnCutoff」做回合内隔离（time_updated /
      // time_created > turnCutoff）。若某行的更新时刻与 idle 标记恰好同毫秒，该行
      // 会被划到上一回合而漏判一步；实测 idle 落在最后一条 assistant completed
      // 之后数毫秒，该窗口概率极低，且即使误判也只多等一个探测周期、下一条 idle
      // 即可自愈，故保留严格大于（不用 >=）以免把刚闭合回合的收尾行重新判忙。
      const turnCutoff = lastIdle?.t ?? 0;

      // 第一步：纯结构性地判断回合是否尚未闭合，**不做任何时效筛选**。
      // 「回合是否结束」与「进程是否还活着」必须分开：前台长工具期间 DB 可以
      // 数分钟零写入（实测 opencode 2.0.32 前台 sleep 150：工具 running 期间
      // 连续 149s 无任何行创建/更新；tool.progress 是 ephemeral 事件不落库，
      // session_inbox/session_pending 也为空），用 DB 静默推断死亡必然误杀。
      //
      // 1. 工具仍在运行。V2 把 part 嵌在 assistant message 的 `content[]` 里
      //    （`content[*].state.status='running'`，实测 2.0.x 行形状），旧查询只
      //    查消息顶层 `$.state.status`，而顶层恒为 NULL —— 该判据在 2.0.32 实测
      //    100% 漏检。按行 time_updated 落在 idle 标记之后做回合内隔离：长工具
      //    的 time_created 可能很旧，但完成时 time_updated 会刷新；顶层查询保留
      //    作旧/未来行形状的防御性兜底。
      //
      //    坏数据隔离：同一会话里任意一行 data 非法、`content` 不是数组、或
      //    content 元素是非 JSON 文本（实测 2.0.x 最终回复行 content 可能是纯
      //    字符串标量、数组里也可能混普通字符串），都不能让整条 busy 查询抛错
      //    而 fail-open——withDb 会把异常吞成 null → busy=false，恰好退回本函数
      //    要修的假空闲。两道防护：
      //    a) json_each 入口只对「合法 data 且 content 是数组」展开，否则给空数组
      //       （坏 data / 标量 content 不产生任何元素）；
      //    b) 元素取值用 CASE：json_each 对对象元素返回的 p.value 也是该对象的
      //       JSON 文本（typeof 恒为 'text'），故 json_valid(p.value) 同时覆盖
      //       真实对象 part 与「字符串元素里包着 JSON 文本」两种形状；普通字符串
      //       /数字/null/布尔/嵌套数组由 json_valid 或 json_extract 返回 NULL 自然
      //       排除。注意不要改成 json_type(p.value)='object'：它会把裸 JSON 文本
      //       二次解析成 object 而转去取路径值，在字符串元素上路径为 NULL 反致漏检。
      //    status 用 = 'running' 精确匹配：大小写变体（"Running"）或数值（42）不
      //    算运行中（2.0.32 实测线形状恒为小写）；要容忍大小写须显式 lower()。
      const nestedRunningTool = db.prepare(
        "SELECT 1 AS busy FROM session_message AS m, " +
        "json_each(CASE WHEN json_valid(m.data) AND json_type(m.data, '$.content') = 'array' " +
        "THEN json_extract(m.data, '$.content') ELSE json_array() END) AS p " +
        "WHERE m.session_id = ? AND m.time_updated > ? " +
        "  AND CASE WHEN json_valid(p.value) THEN json_extract(p.value, '$.state.status') END = 'running' " +
        "LIMIT 1"
      ).get(cliSessionId, turnCutoff) as { busy?: number } | undefined;

      // 顶层 running 兜底：json_extract 必须包在顺序无关的 CASE 里（不能写
      // `json_valid(data) AND json_extract(...)`——SQLite 不保证 AND 求值顺序，
      // 反序或在 SELECT 投影里会对坏 data 抛 malformed JSON）。
      const topLevelRunning = db.prepare(
        "SELECT 1 AS busy FROM session_message " +
        "WHERE session_id = ? AND time_updated > ? " +
        "  AND CASE WHEN json_valid(data) THEN json_extract(data, '$.state.status') END = 'running' " +
        "LIMIT 1"
      ).get(cliSessionId, turnCutoff) as { busy?: number } | undefined;

      // 2. 回合内已有 assistant message 但尚未 completed（模型生成中）。同样用
      //    顺序无关 CASE 包住 json_extract，避免坏 data 行抛错毒化整个回调。
      const incompleteAssistant = db.prepare(
        "SELECT 1 AS busy FROM session_message " +
        "WHERE session_id = ? AND type = 'assistant' AND time_updated > ? " +
        "  AND CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') IS NULL ELSE 0 END " +
        "LIMIT 1"
      ).get(cliSessionId, turnCutoff) as { busy?: number } | undefined;

      // 3. idle 之后存在 user message：回合已提交但 idle 标记尚未写入。
      //    覆盖两类屏幕启发式必误判的空档（旧逻辑在这两处都返回 false）：
      //    a) 提交后、首条 assistant 落库前（relay 首 token 延迟）；
      //    b) 上一条 assistant 已 completed、下一步 assistant 尚未创建
      //       （步骤间等待；实测 relay 下 2–8s，超过 IdleDetector 的 2s 静默
      //       窗口 + 3.5s db-busy 探测周期，卡片会翻成「等待输入」并提前放行
      //       回合权威 / 推进排队输入）。
      const openTurnUserMessage = db.prepare(
        "SELECT 1 AS busy FROM session_message " +
        "WHERE session_id = ? AND type = 'user' AND time_created > ? " +
        "LIMIT 1"
      ).get(cliSessionId, turnCutoff) as { busy?: number } | undefined;

      const turnOpen = !!(nestedRunningTool?.busy || topLevelRunning?.busy
        || incompleteAssistant?.busy || openTurnUserMessage?.busy);
      if (!turnOpen) return false;

      // 第二步：回合未闭合时，用「进程是否存活」区分长任务与崩溃孤儿。
      //  - 进程存活：无条件判忙。DB 静默不等于空闲（长工具 / 长 relay 等待），
      //    闭合信号只有 idle 标记，等待本身是回合的一部分。
      //  - 进程已退出：fail-open（与旧版孤儿保护意图一致）。opencode 下次打开
      //    该会话会自行对账：实测被杀会话残留的 running part 在 resume 时被
      //    改写为 tool/error、补齐 assistant completed，再正常写 idle 标记。
      //
      // 已知取舍（无上界）：若库里从无 idle 标记（旧版本写过的历史会话，或某次
      // idle 落库失败）而 CLI 进程一直存活，turnCutoff=0、上面的结构信号恒真，
      // busy 会一直保持——「从未 idle + 行全部陈旧 + 末条已 completed」与「长 relay
      // 步骤间空档」仅凭 DB 无法区分（后者本就要求进程存活时继续判忙），故不做
      // DB 侧超时兜底；进程退出即靠上面的 fail-open 解除。90s 首次就绪硬超时是
      // worker 侧的独立逃生阀。如未来需要更早放行，应叠加「屏幕已出现 composer」
      // 之类非 DB 信号，而不是给结构判据加时效。
      const liveness = isCliProcessAlive?.();
      if (liveness === true) return true;
      if (liveness === false) return false;

      // 拿不到进程信号时（无 pid 的 adopt 等）回退到旧的 DB 存活性窗口：
      // freshnessWindowMs 内没有任何行被创建或更新，视为异常 / 孤儿，fail-open。
      const alive = db.prepare(
        "SELECT 1 AS alive FROM session_message " +
        "WHERE session_id = ? AND (time_created > ? OR time_updated > ?) " +
        "LIMIT 1"
      ).get(cliSessionId, freshBaseline, freshBaseline) as { alive?: number } | undefined;
      return !!alive?.alive;
    }, dbPath) ?? false;
  }

  return withDb((db) => {
    // 1. 检查是否存在时效内处于 running 状态的 tool part
    const runningTool = db.prepare(
      "SELECT 1 AS busy FROM part " +
      "WHERE session_id = ? AND time_created > ? " +
      "  AND json_extract(data, '$.type') = 'tool' " +
      "  AND json_extract(data, '$.state.status') = 'running' " +
      "LIMIT 1"
    ).get(cliSessionId, freshBaseline) as { busy?: number } | undefined;
    if (runningTool?.busy) return true;

    // 2. 检查最新 assistant message 是否处于时效内的未完成态（无 completed 时间戳）
    const lastMsg = db.prepare(
      "SELECT json_extract(data, '$.time.completed') AS completed " +
      "FROM message " +
      "WHERE session_id = ? AND time_created > ? " +
      "  AND json_extract(data, '$.role') = 'assistant' " +
      "ORDER BY time_created DESC LIMIT 1"
    ).get(cliSessionId, freshBaseline) as { completed?: number } | undefined;

    if (!lastMsg) return false;
    if (lastMsg.completed === undefined || lastMsg.completed === null) return true;
    return false;
  }, dbPath) ?? false;
}

/** Import path（/adopt 第二过滤器）共用实现：从当前存储层的会话表列出可续接的
 *  顶层会话（parent_id 非空的是子代理会话，跳过）。opencode2 与 opencode 共用
 *  同一库文件，kind 区分表空间。 */
export function listOpenCodeResumableSessions(opts: { limit: number; exclude?: ReadonlySet<string> }, kind: OpenCodeDbKind = 'v1', dbPath = opencodeDbPath()): ResumableSession[] {
  const { limit, exclude } = opts;
  const table = kind === 'v2' ? 'session_v2' : 'session';
  const rows = withDb((db) => db.prepare(
    `SELECT id, directory, title, time_updated AS timeUpdated FROM ${table} ` +
    'WHERE parent_id IS NULL AND time_archived IS NULL ' +
    'ORDER BY time_updated DESC LIMIT ?',
  ).all(limit + (exclude?.size ?? 0)) as { id: string; directory: string; title?: string; timeUpdated: number }[], dbPath) ?? [];
  const out: ResumableSession[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (exclude?.has(r.id)) continue;
    if (!r.directory || !existsSync(r.directory)) continue;
    out.push({
      cliSessionId: r.id,
      cwd: r.directory,
      title: (r.title ?? '').trim(),
      lastActivityAt: r.timeUpdated,
    });
  }
  return out;
}

// -------------------------------------------------------------------------

export interface OpenCodeLikeAdapterOptions {
  id: CliAdapter['id'];
  defaultBin: string;
  dataRoot: string;
  authPaths?: readonly string[];
  dbPath: () => string;
  skillsDir: string;
  hookConfigPath: string;
  modelChoices: readonly string[] | undefined;
  /** live 模型枚举的子命令参数（opencode / mimo 都是 `models` 纯文本列表）。 */
  modelListArgs: readonly string[];
  startupArgs?: readonly string[];
}

export function createOpenCodeLikeAdapter(pathOverride: string | undefined, runtime: OpenCodeLikeAdapterOptions): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? runtime.defaultBin;
  let cachedBin: string | undefined;
  return {
    id: runtime.id,
    // Whole dir kept REAL, not just auth.json: opencode keeps its global SQLite DB
    // (opencode.db, WAL mode) here. Under the deny-by-default file sandbox a path
    // not in authPaths doesn't exist, so the DB is unreachable / can't get the
    // POSIX fcntl locks SQLite needs (same failure as codex, see codex.ts).
    authPaths: [...(runtime.authPaths ?? [runtime.dataRoot])],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, initialPrompt, model }) {
      const args: string[] = [...(runtime.startupArgs ?? [])];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // Resume：优先用持久化的 cliSessionId，否则按 botmux session id 文本反查。
      // 找不到就退化为全新会话（与旧行为一致）——绝不带无效 id 启动，
      // `opencode -s <不存在的id>` 会立即 exit 1 → daemon 自动重启 crash-loop。
      const openCodeSessionId = resume
        ? (isOpenCodeSessionId(resumeSessionId) ? resumeSessionId : latestOpenCodeSessionForBotmuxSession(sessionId, 'v1', runtime.dbPath()))
        : undefined;
      if (openCodeSessionId) {
        args.push('--session', openCodeSessionId);
      }
      // Use --prompt for the initial prompt.  OpenCode's Bubble Tea TUI
      // has an async startup phase; writing to stdin during this window
      // may be lost.  --prompt injects it once the TUI is ready.
      // 注意：`-s` resume 下 --prompt 会被 OpenCode 忽略（实测 1.17.11），worker 靠
      // initialPromptArgsIgnoredOnResume 在 resume 时把 prompt 改走输入队列，
      // 所以这里 resume 分支收到的 initialPrompt 恒为 undefined。
      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
      }
      return args;
    },

    passesInitialPromptViaArgs: true,
    // tmux `new-session` rejects launch command strings well below OS ARG_MAX
    // (~12 KB ok, ~16 KB "command too long" on Linux + tmux 3.3a).  OpenCode
    // bakes the full first-round prompt into `--prompt <content>`, so a long
    // routing/role/user prompt blows the tmux limit before OpenCode starts.
    // Budget set to 8 KB: the botmux routing envelope alone is ~5.8–6.2 KB
    // (zh/en) for a typical new topic, so 8 KB keeps short user messages on
    // the reliable `--prompt` cold-start path while leaving ~6 KB headroom
    // below the measured tmux ceiling.  Over-limit prompts defer to the
    // normal post-start input queue.
    maxInitialPromptArgBytes: TMUX_INITIAL_PROMPT_ARG_BUDGET,
    // OpenCode 只在"新会话"应用 --prompt，`-s` 续接时静默忽略（消息会丢）。
    // 置位后 worker 在 resume spawn 时把初始 prompt 转入常规输入队列。
    initialPromptArgsIgnoredOnResume: true,
    durableInitialPromptViaArgs: true,
    captureInitialPromptArgSubmission() {
      return snapPartBaseline('v1', runtime.dbPath());
    },
    async confirmInitialPromptArgSubmission(baseline, content) {
      return detectOpenCodeSubmit({ write() {} }, baseline, content, delay, 'v1', runtime.dbPath(), false);
    },
    findInitialPromptArgSubmission(baseline, content) {
      if (baseline === null) return { submitted: false };
      const result = detectNewSubmit(baseline, content, 'v1', runtime.dbPath());
      return result.cliSessionId
        ? { submitted: result.found, cliSessionId: result.cliSessionId }
        : { submitted: result.found };
    },
    isInitialPromptComplete(baseline, cliSessionId) {
      return baseline !== null && isOpenCodeInitialPromptComplete(baseline, cliSessionId, 'v1', runtime.dbPath());
    },
    rawCommandInputMode: 'paste-line',
    rawCommandSettleMs: 300,

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId, 'v1', runtime.dbPath());
      if (!sid) return null;
      return `${runtime.defaultBin} -s ${sid}`;
    },

    /** Resume 目标预检：id 不在 session 表 → false（worker 落回全新会话并提示），
     *  避免 `Session not found` exit 1 被放大成自动重启 crash-loop。DB 读不了
     *  （node:sqlite 缺失 / 首次运行 / sandbox 未授权该 DB 路径）→ undefined，交给
     *  worker 的二级重启护栏。 */
    checkResumeTargetExists({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId, 'v1', runtime.dbPath());
      if (!sid) {
        // 反查也找不到 → buildArgs 会退化为全新会话，spawn 本身不会失败。
        // 返回 undefined 让 spawn 正常走（fresh），不触发"无法恢复"提示误报。
        return withDb(() => true, runtime.dbPath()) === null ? undefined : false;
      }
      const exists = sessionRowExists(sid, 'v1', runtime.dbPath());
      return exists === null ? undefined : exists;
    },

    /** Import path（/adopt 第二过滤器）：从全局 session 表列出可续接的顶层会话
     *  （parent_id 非空的是子代理会话，跳过）。title 是 OpenCode 自动生成的摘要。 */
    listResumableSessions(opts) {
      return Promise.resolve(listOpenCodeResumableSessions(opts, 'v1', runtime.dbPath()));
    },

    async writeInput(pty: PtyHandle, content: string) {
      // 提交验证基线先于写入采样（traex 同款）。斜杠命令是 TUI 命令面板输入，
      // 不产生 user message 行，跳过验证（重试 Enter 还可能误触面板项）。
      const isSlashCommand = content.startsWith('/');
      const needsPaste = !isSlashCommand && (content.length > OPENCODE_PASTE_THRESHOLD || content.includes('\n'));
      const baseline = isSlashCommand ? null : snapPartBaseline('v1', runtime.dbPath());

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          if (needsPaste && pty.pasteText) {
            pty.pasteText(content);
          } else {
            pty.sendText(content);
          }
          await delay(200);
          pty.sendSpecialKeys('Enter');
        } else {
          // Raw PTY has no tmux paste-buffer to add these markers. Without
          // them, long/deferred or multiline prompts are parsed as individual
          // key events and can be dropped instead of submitted as one message.
          pty.write(needsPaste ? wrapBracketedPaste(content) : content);
          await delay(1000);
          pty.write('\r');
        }
      } catch {
        return { submitted: false };
      }

      // DB-backed submit verification + cliSessionId 捕获。node:sqlite 不可用或
      // DB 缺失（首次运行 / sandbox 未授权该 DB 路径）→ 维持旧行为：盲发、假定成功。
      if (baseline === null) return undefined;

      const result = await detectOpenCodeSubmit(pty, baseline, content, delay, 'v1', runtime.dbPath());
      if (result.submitted) {
        return result.cliSessionId
          ? { submitted: true, cliSessionId: result.cliSessionId }
          : { submitted: true };
      }
      return { submitted: false, recheck: result.recheck };
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Bubble Tea TUI — no reliable prompt indicator; rely on quiescence + spinner guard
    // No reliable prompt anchor: require 4s of silence before the FIRST paste
    // so cold start / resume→fresh cannot type into a still-booting TUI; later
    // cycles return to the normal 2s window.
    firstPromptQuiescenceMs: 4_000,
    busyPattern: undefined,
    isSessionBusy({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId)
        ? cliSessionId
        : latestOpenCodeSessionForBotmuxSession(sessionId, 'v1', runtime.dbPath());
      if (!sid) return false;
      return isOpenCodeSessionBusy(sid, 'v1', OPENCODE_BUSY_FRESHNESS_MS, runtime.dbPath());
    },
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Bubble Tea renders in alternate screen buffer
    readOnlyRemoteScroll: true,
    skillsDir: runtime.skillsDir,
    // botmux hook 安装：spawn 时写入 OpenCode 插件文件，
    // 使 question.asked 事件自动转发到 `botmux hook opencode`。
    hookInstall: {
      configPath: runtime.hookConfigPath,
      format: 'opencode-plugin',
    },
    asksViaHook: true,
    // Live 模型枚举：`<bin> models` 输出纯文本列表（每行 provider/name，可带
    // 展示元数据，见 parseModelList）。仅 dashboard 在用户选中该 CLI 时按需调用，
    // 不在 daemon/worker 启动路径上；任何异常（spawn 失败/超时/输出为空）一律
    // fail-soft 返回 null，picker 回退到下面的 modelChoices。
    async detectModels(): Promise<readonly string[] | null> {
      return detectModelsViaExec(this.resolvedBin, runtime.modelListArgs, parseModelList);
    },
    // OpenCode model 通常 provider/name 形式（anthropic/claude-sonnet-4、openai/gpt-5），
    // 自由度高，候选只做引导，setup 时选 Other 自定义最常见。
    modelChoices: runtime.modelChoices ? [...runtime.modelChoices] : undefined,
  };
}

export function createOpenCodeAdapter(pathOverride?: string): CliAdapter {
  return createOpenCodeLikeAdapter(pathOverride, {
    id: 'opencode',
    defaultBin: 'opencode',
    dataRoot: '~/.local/share/opencode',
    dbPath: opencodeDbPath,
    skillsDir: '~/.config/opencode/skills',
    hookConfigPath: '~/.config/opencode/plugin/botmux-ask.js',
    modelListArgs: ['models'],
    modelChoices: CLI_MODEL_CHOICES['opencode'],
  });
}
