import { existsSync } from 'node:fs';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { traeStateDbPath } from '../../services/traex-paths.js';
import { delay } from '../../utils/timing.js';

/**
 * TRAE CLI (a.k.a. traex / traecli) adapter.
 *
 * TRAE is a Codex-family CLI — it shares the same bracketed-paste input
 * protocol, `--dangerously-bypass-approvals-and-sandbox` / `--no-alt-screen`
 * flags, `resume <uuid>` subcommand, and `›` prompt marker.
 *
 * The important difference from the upstream Codex adapter:
 *   - Data lives under ~/.trae (not ~/.codex), configurable via TRAE_HOME.
 *   - There is no global history.jsonl. The per-session rollout JSONL format
 *     is identical, but submit verification falls back to scanning the
 *     threads SQLite table (state_5.sqlite) whose `first_user_message`
 *     column is written synchronously when the CLI commits a user submit.
 *   - Skills are installed into ~/.trae/skills.
 */

function normaliseHistoryText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function textMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const na = normaliseHistoryText(actual);
  const ne = normaliseHistoryText(expected);
  if (na === ne) return true;
  // first_user_message may be truncated by SQLite substr / UI. Accept a
  // prefix match when expected is longer than what the DB recorded.
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

let sqliteModule: { DatabaseSync: new (path: string) => DatabaseSyncLike } | null = null;
let sqliteLoadAttempted = false;

function loadSqlite(): typeof sqliteModule {
  if (sqliteLoadAttempted) return sqliteModule;
  sqliteLoadAttempted = true;
  // node:sqlite is the built-in experimental SQLite binding available in
  // Node 22+. It requires --experimental-sqlite at the time of writing
  // (2026-06), but the import succeeds even without the flag; the first
  // `new DatabaseSync(...)` throws if the runtime didn't opt in. We swallow
  // that at query time and degrade gracefully.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteModule = require('node:sqlite') as typeof sqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T | null {
  const mod = loadSqlite();
  if (!mod) return null;
  const dbPath = traeStateDbPath();
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSyncLike | undefined;
  try {
    db = new mod.DatabaseSync(dbPath);
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** Snapshot of the newest thread's (id, updated_at_ms, first_user_message)
 *  immediately before a submit. Used after the paste+Enter to detect a new
 *  row (first turn) or a changed first_user_message (unlikely but cheap to
 *  check alongside id+updated_at_ms). */
interface ThreadSnapshot {
  id?: string;
  updatedAtMs?: number;
  firstMessage?: string;
}

function snapLatestThread(): ThreadSnapshot {
  return withDb((db) => {
    const row = db.prepare(
      'SELECT id, updated_at_ms AS updatedAtMs, first_user_message AS firstMessage ' +
      'FROM threads ORDER BY updated_at_ms DESC LIMIT 1',
    ).get() as ThreadSnapshot | undefined;
    return row ?? { };
  }) ?? { };
}

/** Return { found, cliSessionId } if, compared to `before`, a newer thread
 *  now exists whose first_user_message matches `expectedText`. */
function detectNewThread(before: ThreadSnapshot, expectedText: string): { found: boolean; cliSessionId?: string } {
  return withDb((db) => {
    const rows = db.prepare(
      'SELECT id, updated_at_ms AS updatedAtMs, first_user_message AS firstMessage ' +
      'FROM threads WHERE updated_at_ms >= COALESCE(?, 0) ORDER BY updated_at_ms DESC LIMIT 5',
    ).all(before.updatedAtMs ?? 0) as ThreadSnapshot[];
    for (const r of rows) {
      // Skip the exact row we saw before (same id AND same timestamp).
      if (r.id && before.id && r.id === before.id && r.updatedAtMs === before.updatedAtMs) continue;
      if (r.firstMessage && textMatches(r.firstMessage, expectedText)) {
        return { found: true, cliSessionId: r.id };
      }
      // A fresh thread whose first_message is empty so far (still being
      // written) will be caught on a later poll.
    }
    return { found: false };
  }) ?? { found: false };
}

/** Scan threads backwards for the most recent thread whose first_user_message
 *  references the botmux session id. Used by buildArgs(resume) and
 *  buildResumeCommand to recover a TRAE-native session UUID from a botmux
 *  session id. */
function latestTraeSessionForBotmuxSession(botmuxSessionId: string): string | undefined {
  return withDb((db) => {
    const rows = db.prepare(
      'SELECT id, first_user_message AS firstMessage FROM threads ORDER BY created_at DESC LIMIT 200',
    ).all() as { id: string; firstMessage?: string }[];
    for (const r of rows) {
      if (r.firstMessage && r.firstMessage.includes(botmuxSessionId)) return r.id;
    }
    return undefined;
  }) ?? undefined;
}

// -------------------------------------------------------------------------

export function createTraexAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'traex';
  let cachedBin: string | undefined;
  return {
    id: 'traex',
    authPaths: ['~/.trae/cli/auth.json'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, model, disableCliBypass }) {
      const baseArgs = [
        ...(!disableCliBypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        '--no-alt-screen',
      ];
      if (model && model.trim()) baseArgs.push('--model', model.trim());
      if (workingDir) baseArgs.push('-C', workingDir);
      if (!resume) return baseArgs;

      const traeSessionId = resumeSessionId ?? latestTraeSessionForBotmuxSession(sessionId);
      if (!traeSessionId) return baseArgs;
      return ['resume', ...baseArgs, traeSessionId];
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = cliSessionId ?? latestTraeSessionForBotmuxSession(sessionId);
      if (!sid) return null;
      return `traex resume ${sid}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Same bracketed-paste strategy as the Codex adapter: multi-line user
      // messages must not be split into separate turns by embedded \n.
      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          return false;
        }
      };

      // Take the snapshot BEFORE the paste so we can tell a newly-appeared
      // thread from pre-existing ones.
      const beforeSnap = snapLatestThread();

      try {
        if (pty.pasteText) pty.pasteText(content);
        else pty.write('\x1b[200~' + content + '\x1b[201~');
      } catch {
        return { submitted: false };
      }
      await delay(200);
      if (!trySendEnter()) return { submitted: false };

      // SQLite-backed submit verification. When node:sqlite is unavailable
      // or the DB is missing (first run), we short-circuit and return
      // undefined ("no verification performed, assume OK") — same behaviour
      // as the Hermes / Aiden adapters.
      const canVerify = loadSqlite() && existsSync(traeStateDbPath());
      if (!canVerify) return undefined;

      for (let attempt = 0; attempt < 3; attempt++) {
        const match = detectNewThread(beforeSnap, content);
        if (match.found) {
          return match.cliSessionId
            ? { submitted: true, cliSessionId: match.cliSessionId }
            : { submitted: true };
        }
        await delay(800);
        if (!trySendEnter()) return { submitted: false };
      }
      const finalMatch = detectNewThread(beforeSnap, content);
      if (finalMatch.found) {
        return finalMatch.cliSessionId
          ? { submitted: true, cliSessionId: finalMatch.cliSessionId }
          : { submitted: true };
      }
      const recheck = () => {
        const late = detectNewThread(beforeSnap, content);
        return late.found
          ? { submitted: true, cliSessionId: late.cliSessionId }
          : false;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // TRAE has shipped both the Codex-style `›` prompt and the Claude-style
    // `❯` prompt; v0.200.7 also renders a "Context 100% left" status bar.
    readyPattern: /[›❯]|\d+% left/,
    systemHints: BOTMUX_SHELL_HINTS,
    // TRAE 0.200+ shares Codex's type-ahead behaviour: input submitted while
    // a turn is running is parked and merged into the active turn.
    supportsTypeAhead: true,
    altScreen: false,
    skillsDir: '~/.trae/skills',
    // Curated subset — the full catalogue has 27 models. `traex debug models`
    // lists the rest; the setup flow always appends an "Other / custom"
    // free-text option so users aren't locked out.
    modelChoices: [
      'Seed-Dogfooding-2.0',
      'Doubao-Seed-2.0-Code',
      'gpt-5.5',
      'gpt-5',
      'o3',
      'Doubao_1_8',
      'DeepSeek-V4-Pro',
      'kimi-k2.6',
    ],
  };
}

export const create = createTraexAdapter;
