import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { traeStateDbPath, traeSessionsRoot } from '../../services/traex-paths.js';
import { traexRolloutHasUserInputSince } from '../../services/traex-transcript.js';
import { discoverRolloutSessions } from '../../services/resumable-session-discovery.js';
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
 *   - There is no global history.jsonl. Submit verification uses the threads
 *     SQLite table as the authoritative session/path index, then requires an
 *     exact role=user record in that rollout's post-submit byte delta.
 *   - Skills are installed into ~/.trae/skills.
 */

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
  // Node 22+. The runtime may still reject it (older Node without the
  // feature); callers treat that as verification-unavailable and fail closed.
  // 必须走 createRequire：本包是 ESM（"type":"module"），裸 require 是
  // ReferenceError —— 之前就是被这里的 try/catch 吞掉，导致生产 dist 里
  // SQLite 提交验证/会话反查整条链路静默失效。
  try {
    const req = createRequire(import.meta.url);
    sqliteModule = req('node:sqlite') as typeof sqliteModule;
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

interface ThreadSnapshot {
  id: string;
  updatedAtMs: number;
  rolloutPath: string;
  rolloutOffset: number;
}

interface SubmitSnapshot {
  newestUpdatedAtMs: number;
  byId: Map<string, ThreadSnapshot>;
}

function currentFileSize(path: string): number {
  if (!path || !existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

/** Snapshot recent SQLite thread rows and each rollout's complete byte size
 * before touching the PTY. The DB is an index; the rollout delta below is the
 * actual submit proof. `null` means verification is unavailable and callers
 * must fail closed before writing any bytes. */
function snapRecentThreads(): SubmitSnapshot | null {
  return withDb((db) => {
    const rows = db.prepare(
      'SELECT id, COALESCE(updated_at_ms, 0) AS updatedAtMs, rollout_path AS rolloutPath ' +
      'FROM threads ORDER BY updated_at_ms DESC LIMIT 64',
    ).all() as Array<Omit<ThreadSnapshot, 'rolloutOffset'>>;
    const byId = new Map<string, ThreadSnapshot>();
    let newestUpdatedAtMs = 0;
    for (const row of rows) {
      if (!row.id || !row.rolloutPath) continue;
      newestUpdatedAtMs = Math.max(newestUpdatedAtMs, Number(row.updatedAtMs) || 0);
      byId.set(row.id, {
        id: row.id,
        updatedAtMs: Number(row.updatedAtMs) || 0,
        rolloutPath: row.rolloutPath,
        rolloutOffset: currentFileSize(row.rolloutPath),
      });
    }
    return { newestUpdatedAtMs, byId };
  });
}

/** Resolve the session whose rollout gained this exact role=user record.
 * Works for the first prompt, later prompts in the same thread, and a freshly
 * rotated thread. Sibling processes can update SQLite concurrently, but their
 * rollout delta cannot match our full prompt accidentally. */
function detectSubmittedThread(before: SubmitSnapshot, expectedText: string): { found: boolean; cliSessionId?: string } {
  return withDb((db) => {
    const rows = db.prepare(
      'SELECT id, COALESCE(updated_at_ms, 0) AS updatedAtMs, rollout_path AS rolloutPath ' +
      'FROM threads WHERE COALESCE(updated_at_ms, 0) >= ? ORDER BY updated_at_ms DESC LIMIT 64',
    ).all(before.newestUpdatedAtMs) as Array<Omit<ThreadSnapshot, 'rolloutOffset'>>;
    for (const r of rows) {
      if (!r.id || !r.rolloutPath) continue;
      const prior = before.byId.get(r.id);
      const fromOffset = prior?.rolloutPath === r.rolloutPath ? prior.rolloutOffset : 0;
      if (traexRolloutHasUserInputSince(r.rolloutPath, fromOffset, expectedText)) {
        return { found: true, cliSessionId: r.id };
      }
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

/**
 * TRAE/Codex sanitizes the environment inherited by model shell tools. Goal
 * mode is file-backed, so the agent must receive these non-secret path vars or
 * commands such as `cat $BOTMUX_GOAL_PATH` collapse to an empty argument and
 * can hang on stdin. Forward only the goal contract, not the full worker env.
 */
const TRAEX_GOAL_ENV_KEYS = [
  'BOTMUX_GOAL_PATH',
  'BOTMUX_GOAL_INPUTS_PATH',
  'BOTMUX_GOAL_OUTPUT_DIR',
  'BOTMUX_GOAL_MANIFEST_PATH',
  'BOTMUX_GOAL_ATTEMPT_DIR',
  'BOTMUX_V3_GOAL',
] as const;

function goalEnvConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  for (const key of TRAEX_GOAL_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    args.push('-c', `shell_environment_policy.set.${key}=${JSON.stringify(value)}`);
  }
  return args;
}

export function createTraexAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'traex';
  let cachedBin: string | undefined;
  return {
    id: 'traex',
    // Whole ~/.trae/cli kept REAL: traex is codex-based and keeps the same SQLite
    // state/log DBs there (state_*.sqlite / logs_*.sqlite) — the sandbox home
    // overlay lacks the fcntl locks SQLite needs (same failure as codex.ts).
    authPaths: ['~/.trae/cli'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, model, disableCliBypass }) {
      const baseArgs = [
        ...(!disableCliBypass ? [
          '--dangerously-bypass-approvals-and-sandbox',
          // Supported TRAE baseline 0.200.16+ has a second interactive
          // "Hooks need review" gate
          // after folder trust. Goal-mode workers have no human at their PTY,
          // so without the automation-specific hook flag they never reach the
          // prompt and `/goal` is never delivered. Keep it tied to the existing
          // bypass decision: restricted bots must not gain hook trust.
          '--dangerously-bypass-hook-trust',
        ] : []),
        '--no-alt-screen',
        ...goalEnvConfigArgs(),
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

    /** Import path: TRAE writes Codex-family rollout files under
     *  `<TRAE_HOME>/cli/sessions`. */
    listResumableSessions({ limit, exclude }) {
      return discoverRolloutSessions(traeSessionsRoot(), limit, exclude);
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

      // Reliable delivery requires an attributable submit. Refuse before the
      // paste if the SQLite session/path index cannot be read; writing first
      // and discovering that verification is unavailable would make replay
      // ambiguous and could execute the same action twice.
      const beforeSnap = snapRecentThreads();
      if (!beforeSnap) {
        return {
          submitted: false,
          failureReason: 'TRAE SQLite 提交验证不可用，已在写入前安全拒绝。',
        };
      }

      try {
        if (pty.pasteText) pty.pasteText(content);
        else pty.write('\x1b[200~' + content + '\x1b[201~');
      } catch {
        return { submitted: false };
      }
      await delay(200);
      if (!trySendEnter()) return { submitted: false };

      for (let attempt = 0; attempt < 3; attempt++) {
        const match = detectSubmittedThread(beforeSnap, content);
        if (match.found) {
          return match.cliSessionId
            ? { submitted: true, cliSessionId: match.cliSessionId }
            : { submitted: true };
        }
        await delay(800);
        if (!trySendEnter()) return { submitted: false };
      }
      const finalMatch = detectSubmittedThread(beforeSnap, content);
      if (finalMatch.found) {
        return finalMatch.cliSessionId
          ? { submitted: true, cliSessionId: finalMatch.cliSessionId }
          : { submitted: true };
      }
      const recheck = () => {
        const late = detectSubmittedThread(beforeSnap, content);
        return late.found
          ? { submitted: true, cliSessionId: late.cliSessionId }
          : false;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // TRAE has shipped both the Codex-style `›` prompt and the Claude-style
    // `❯` prompt; v0.200.7 also renders a "Context 100% left" status bar.
    // Startup advisory / picker screens also use `❯ 1.` as a menu cursor, so
    // exclude numbered selector rows; otherwise botmux flushes the first prompt
    // into the advisory instead of TRAE's real composer.
    readyPattern: /(?:^|[\n\r])\s*[›❯](?!\s*\d+\.)|\d+% left/,
    systemHints: BOTMUX_SHELL_HINTS,
    // TRAE 0.200+ shares Codex's type-ahead behaviour: input submitted while
    // a turn is running is parked and merged into the active turn.
    supportsTypeAhead: true,
    // task_complete in the per-session rollout is an explicit durable turn
    // boundary; worker.ts drains it independently of screen-idle detection.
    reliableTurnTerminal: true,
    // TRAE's trust/advisory startup screens can accept stdin before the real
    // composer exists, so the worker's 15s soft fallback must wait for the
    // prompt marker. A hard cap in the worker still prevents permanent hangs.
    deferFirstPromptTimeoutUntilReady: true,
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
