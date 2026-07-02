import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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

function isOpenCodeSessionId(value: string | undefined): value is string {
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

type DatabaseSyncLike = {
  prepare(sql: string): StatementSyncLike;
  close(): void;
};
type StatementSyncLike = {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
};

let sqliteModule: { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncLike } | null = null;
let sqliteLoadAttempted = false;

function loadSqlite(): typeof sqliteModule {
  if (sqliteLoadAttempted) return sqliteModule;
  sqliteLoadAttempted = true;
  // ESM 下没有裸 require（ReferenceError），必须走 createRequire —— traex.ts 曾因
  // 裸 require 被 try/catch 吞掉而在生产 dist 里整条 SQLite 链路静默失效。
  try {
    const req = createRequire(import.meta.url);
    sqliteModule = req('node:sqlite') as typeof sqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** 只读打开 opencode.db 执行一次查询。DB 是 WAL 模式且被活跃 OpenCode 进程持有，
 *  read-only 连接可并发读；任何失败（模块缺失/文件不存在/短暂锁忙）都回落 null，
 *  上层按"无法验证"降级，不影响输入投递本身。 */
function withDb<T>(fn: (db: DatabaseSyncLike) => T): T | null {
  const mod = loadSqlite();
  if (!mod) return null;
  const dbPath = opencodeDbPath();
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSyncLike | undefined;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 提交验证基线：part 表当前最大 time_created（epoch ms，与 worker 同机同钟）。
 *  之后只认 >= 基线的新行，避免历史消息误配。 */
function snapPartBaseline(): number | null {
  return withDb((db) => {
    const row = db.prepare('SELECT COALESCE(MAX(time_created), 0) AS ts FROM part').get() as { ts: number } | undefined;
    return row?.ts ?? 0;
  });
}

/** 基线之后是否出现文本匹配的 user part；命中则带回其 session_id（= OpenCode 原生
 *  会话 id）。全局 DB 多实例并发写也安全：靠文本相等排除别的会话的行。
 *  严格 `>` 基线：`>=` 会在"用户因疑似丢失而重发同一段文本"时误配上一条的行，
 *  把真丢失误报为已提交；同毫秒漏检的窗口可忽略（新行时间戳必然晚于既有最大值）。 */
function detectNewSubmit(baseline: number, expectedText: string): { found: boolean; cliSessionId?: string } {
  return withDb((db) => {
    const rows = db.prepare(
      "SELECT p.session_id AS sid, json_extract(p.data, '$.text') AS text " +
      'FROM part p JOIN message m ON m.id = p.message_id ' +
      "WHERE json_extract(m.data, '$.role') = 'user' " +
      "  AND json_extract(p.data, '$.type') = 'text' " +
      '  AND p.time_created > ? ' +
      'ORDER BY p.time_created DESC LIMIT 20',
    ).all(baseline) as { sid: string; text?: string }[];
    for (const r of rows) {
      if (r.text && textMatches(r.text, expectedText)) {
        return { found: true, cliSessionId: r.sid };
      }
    }
    return { found: false };
  }) ?? { found: false };
}

/** 兜底反查：botmux 每条 prompt 都带 `<session_id>xxx</session_id>` 块，按该文本在
 *  user part 里找最近命中的 OpenCode 会话。用于 cliSessionId 尚未持久化时的 resume
 *  （典型：首条消息经 --prompt 注入、没走 writeInput 就被 suspend/重启）。 */
function latestOpenCodeSessionForBotmuxSession(botmuxSessionId: string): string | undefined {
  return withDb((db) => {
    const row = db.prepare(
      'SELECT p.session_id AS sid ' +
      'FROM part p JOIN message m ON m.id = p.message_id ' +
      "WHERE json_extract(m.data, '$.role') = 'user' " +
      "  AND json_extract(p.data, '$.type') = 'text' " +
      '  AND instr(p.data, ?) > 0 ' +
      'ORDER BY p.time_created DESC LIMIT 1',
    ).get(botmuxSessionId) as { sid?: string } | undefined;
    return row?.sid;
  }) ?? undefined;
}

function sessionRowExists(cliSessionId: string): boolean | null {
  return withDb((db) => {
    const row = db.prepare('SELECT 1 AS ok FROM session WHERE id = ? LIMIT 1').get(cliSessionId) as { ok?: number } | undefined;
    return !!row?.ok;
  });
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
    authPaths: ['~/.local/share/opencode/auth.json'],
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

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId);
      if (!sid) return null;
      return `opencode -s ${sid}`;
    },

    /** Resume 目标预检：id 不在 session 表 → false（worker 落回全新会话并提示），
     *  避免 `Session not found` exit 1 被放大成自动重启 crash-loop。DB 读不了
     *  （node:sqlite 缺失 / 首次运行 / sandbox overlay 挡住）→ undefined，交给
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
    listResumableSessions({ limit, exclude }) {
      const rows = withDb((db) => db.prepare(
        'SELECT id, directory, title, time_updated AS timeUpdated FROM session ' +
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
          title: (r.title ?? '').trim() || r.id,
          lastActivityAt: r.timeUpdated,
        });
      }
      return Promise.resolve(out);
    },

    async writeInput(pty: PtyHandle, content: string) {
      // 提交验证基线先于写入采样（traex 同款）。斜杠命令是 TUI 命令面板输入，
      // 不产生 user message 行，跳过验证（重试 Enter 还可能误触面板项）。
      const isSlashCommand = content.startsWith('/');
      const baseline = isSlashCommand ? null : snapPartBaseline();

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          return false;
        }
      };

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          pty.sendText(content);
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
      // DB 缺失（首次运行 / sandbox overlay）→ 维持旧行为：盲发、假定成功。
      if (baseline === null) return undefined;

      for (let attempt = 0; attempt < 3; attempt++) {
        const match = detectNewSubmit(baseline, content);
        if (match.found) {
          return match.cliSessionId
            ? { submitted: true, cliSessionId: match.cliSessionId }
            : { submitted: true };
        }
        await delay(800);
        if (!trySendEnter()) return { submitted: false };
      }
      const finalMatch = detectNewSubmit(baseline, content);
      if (finalMatch.found) {
        return finalMatch.cliSessionId
          ? { submitted: true, cliSessionId: finalMatch.cliSessionId }
          : { submitted: true };
      }
      const recheck = () => {
        const late = detectNewSubmit(baseline, content);
        return late.found
          ? { submitted: true, cliSessionId: late.cliSessionId }
          : false;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Bubble Tea TUI — no reliable prompt indicator; rely on quiescence + spinner guard
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Bubble Tea renders in alternate screen buffer
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
