import { existsSync } from 'node:fs';
import { openDatabaseSyncNow } from '../../services/sqlite-compat.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle, ResumableSession } from './types.js';
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

const OPENCODE_SESSION_ID_RE = /^ses_[0-9A-Za-z]+$/;
const OPENCODE_PASTE_THRESHOLD = 150;

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
  return false;
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
export function withDb<T>(fn: (db: DatabaseSyncLike) => T): T | null {
  const dbPath = opencodeDbPath();
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
export function snapPartBaseline(kind: OpenCodeDbKind = 'v1'): number | null {
  const table = kind === 'v2' ? 'session_message' : 'part';
  return withDb((db) => {
    const row = db.prepare(`SELECT COALESCE(MAX(time_created), 0) AS ts FROM ${table}`).get() as { ts: number } | undefined;
    return row?.ts ?? 0;
  });
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
  }) ?? { found: false };
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
    const match = detectNewSubmit(baseline, content, kind);
    if (match.found) {
      return match.cliSessionId
        ? { submitted: true, cliSessionId: match.cliSessionId }
        : { submitted: true };
    }
    await delayFn(800);
    if (!trySendEnter()) return { submitted: false };
  }
  const finalMatch = detectNewSubmit(baseline, content, kind);
  if (finalMatch.found) {
    return finalMatch.cliSessionId
      ? { submitted: true, cliSessionId: finalMatch.cliSessionId }
      : { submitted: true };
  }
  const recheck = () => {
    const late = detectNewSubmit(baseline, content, kind);
    return late.found
      ? { submitted: true, cliSessionId: late.cliSessionId }
      : false;
  };
  return { submitted: false, recheck };
}

/** 兜底反查：botmux 每条 prompt 都带 `<session_id>xxx</session_id>` 块，按该文本在
 *  user 行里找最近命中的 OpenCode 会话。用于 cliSessionId 尚未持久化时的 resume
 *  （典型：首条消息经输入队列投递、没走 writeInput 验证就被 suspend/重启）。 */
export function latestOpenCodeSessionForBotmuxSession(botmuxSessionId: string, kind: OpenCodeDbKind = 'v1'): string | undefined {
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
  }) ?? undefined;
}

export function sessionRowExists(cliSessionId: string, kind: OpenCodeDbKind = 'v1'): boolean | null {
  const table = kind === 'v2' ? 'session_v2' : 'session';
  return withDb((db) => {
    const row = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? LIMIT 1`).get(cliSessionId) as { ok?: number } | undefined;
    return !!row?.ok;
  });
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
export function isOpenCodeSessionBusy(
  cliSessionId: string,
  kind: OpenCodeDbKind = 'v1',
  freshnessWindowMs: number = OPENCODE_BUSY_FRESHNESS_MS,
): boolean {
  const freshBaseline = Date.now() - freshnessWindowMs;

  if (kind === 'v2') {
    return withDb((db) => {
      // 1. 检查是否存在时效内处于 running 状态的 tool part
      const runningTool = db.prepare(
        "SELECT 1 AS busy FROM session_message " +
        "WHERE session_id = ? AND time_created > ? " +
        "  AND json_extract(data, '$.state.status') = 'running' " +
        "LIMIT 1"
      ).get(cliSessionId, freshBaseline) as { busy?: number } | undefined;
      if (runningTool?.busy) return true;

      // 2. 检查最新 assistant message 是否处于时效内的未完成态（无 completed 时间戳）
      const lastMsg = db.prepare(
        "SELECT json_extract(data, '$.time.completed') AS completed " +
        "FROM session_message " +
        "WHERE session_id = ? AND type = 'assistant' AND time_created > ? " +
        "ORDER BY time_created DESC LIMIT 1"
      ).get(cliSessionId, freshBaseline) as { completed?: number } | undefined;

      if (!lastMsg) return false;
      if (lastMsg.completed === undefined || lastMsg.completed === null) return true;
      return false;
    }) ?? false;
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
  }) ?? false;
}

/** Import path（/adopt 第二过滤器）共用实现：从当前存储层的会话表列出可续接的
 *  顶层会话（parent_id 非空的是子代理会话，跳过）。opencode2 与 opencode 共用
 *  同一库文件，kind 区分表空间。 */
export function listOpenCodeResumableSessions(opts: { limit: number; exclude?: ReadonlySet<string> }, kind: OpenCodeDbKind = 'v1'): ResumableSession[] {
  const { limit, exclude } = opts;
  const table = kind === 'v2' ? 'session_v2' : 'session';
  const rows = withDb((db) => db.prepare(
    `SELECT id, directory, title, time_updated AS timeUpdated FROM ${table} ` +
    'WHERE parent_id IS NULL AND time_archived IS NULL ' +
    'ORDER BY time_updated DESC LIMIT ?',
  ).all(limit + (exclude?.size ?? 0)) as { id: string; directory: string; title?: string; timeUpdated: number }[]) ?? [];
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

export function createOpenCodeAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'opencode';
  let cachedBin: string | undefined;
  return {
    id: 'opencode',
    // Whole dir kept REAL, not just auth.json: opencode keeps its global SQLite DB
    // (opencode.db, WAL mode) here. Under the deny-by-default file sandbox a path
    // not in authPaths doesn't exist, so the DB is unreachable / can't get the
    // POSIX fcntl locks SQLite needs (same failure as codex, see codex.ts).
    authPaths: ['~/.local/share/opencode'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, initialPrompt, model }) {
      const args: string[] = [];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // Resume：优先用持久化的 cliSessionId，否则按 botmux session id 文本反查。
      // 找不到就退化为全新会话（与旧行为一致）——绝不带无效 id 启动，
      // `opencode -s <不存在的id>` 会立即 exit 1 → daemon 自动重启 crash-loop。
      const openCodeSessionId = resume
        ? (isOpenCodeSessionId(resumeSessionId) ? resumeSessionId : latestOpenCodeSessionForBotmuxSession(sessionId))
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
    // OpenCode 只在"新会话"应用 --prompt，`-s` 续接时静默忽略（消息会丢）。
    // 置位后 worker 在 resume spawn 时把初始 prompt 转入常规输入队列。
    initialPromptArgsIgnoredOnResume: true,
    rawCommandInputMode: 'paste-line',
    rawCommandSettleMs: 300,

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId);
      if (!sid) return null;
      return `opencode -s ${sid}`;
    },

    /** Resume 目标预检：id 不在 session 表 → false（worker 落回全新会话并提示），
     *  避免 `Session not found` exit 1 被放大成自动重启 crash-loop。DB 读不了
     *  （node:sqlite 缺失 / 首次运行 / sandbox 未授权该 DB 路径）→ undefined，交给
     *  worker 的二级重启护栏。 */
    checkResumeTargetExists({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId);
      if (!sid) {
        // 反查也找不到 → buildArgs 会退化为全新会话，spawn 本身不会失败。
        // 返回 undefined 让 spawn 正常走（fresh），不触发"无法恢复"提示误报。
        return withDb(() => true) === null ? undefined : false;
      }
      const exists = sessionRowExists(sid);
      return exists === null ? undefined : exists;
    },

    /** Import path（/adopt 第二过滤器）：从全局 session 表列出可续接的顶层会话
     *  （parent_id 非空的是子代理会话，跳过）。title 是 OpenCode 自动生成的摘要。 */
    listResumableSessions(opts) {
      return Promise.resolve(listOpenCodeResumableSessions(opts));
    },

    async writeInput(pty: PtyHandle, content: string) {
      // 提交验证基线先于写入采样（traex 同款）。斜杠命令是 TUI 命令面板输入，
      // 不产生 user message 行，跳过验证（重试 Enter 还可能误触面板项）。
      const isSlashCommand = content.startsWith('/');
      const baseline = isSlashCommand ? null : snapPartBaseline();

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          if (!isSlashCommand && pty.pasteText && (content.length > OPENCODE_PASTE_THRESHOLD || content.includes('\n'))) {
            pty.pasteText(content);
          } else {
            pty.sendText(content);
          }
          await delay(200);
          pty.sendSpecialKeys('Enter');
        } else {
          pty.write(content);
          await delay(1000);
          pty.write('\r');
        }
      } catch {
        return { submitted: false };
      }

      // DB-backed submit verification + cliSessionId 捕获。node:sqlite 不可用或
      // DB 缺失（首次运行 / sandbox 未授权该 DB 路径）→ 维持旧行为：盲发、假定成功。
      if (baseline === null) return undefined;

      const result = await detectOpenCodeSubmit(pty, baseline, content, delay);
      if (result.submitted) {
        return result.cliSessionId
          ? { submitted: true, cliSessionId: result.cliSessionId }
          : { submitted: true };
      }
      return { submitted: false, recheck: result.recheck };
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Bubble Tea TUI — no reliable prompt indicator; rely on quiescence + spinner guard
    busyPattern: undefined,
    isSessionBusy({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId)
        ? cliSessionId
        : latestOpenCodeSessionForBotmuxSession(sessionId, 'v1');
      if (!sid) return false;
      return isOpenCodeSessionBusy(sid, 'v1');
    },
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Bubble Tea renders in alternate screen buffer
    readOnlyRemoteScroll: true,
    skillsDir: '~/.config/opencode/skills',
    // botmux hook 安装：spawn 时写入 OpenCode 插件文件，
    // 使 question.asked 事件自动转发到 `botmux hook opencode`。
    hookInstall: {
      configPath: '~/.config/opencode/plugin/botmux-ask.js',
      format: 'opencode-plugin',
    },
    asksViaHook: true,
    // OpenCode model 通常 provider/name 形式（anthropic/claude-sonnet-4、openai/gpt-5），
    // 自由度高，候选只做引导，setup 时选 Other 自定义最常见。
    modelChoices: [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-opus-4',
      'openai/gpt-5',
      'google/gemini-2.5-pro',
    ],
  };
}

export const create = createOpenCodeAdapter;
