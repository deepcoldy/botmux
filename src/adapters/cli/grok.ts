import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { buildBotmuxSystemPromptText } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { sessionReadyHookCommand } from '../hook-command.js';
import { delay, scaleMs } from '../../utils/timing.js';
import {
  grokHome,
  grokHooksDir,
  grokPromptHistoryPath,
  grokSkillsDir,
} from '../../services/grok-paths.js';
import {
  discoverGrokSessions,
  findGrokSessionByPid,
  grokFileSize,
  grokSessionDirExists,
  grokSessionExists,
  matchGrokPromptAppend,
} from '../../services/grok-transcript.js';
import { builtinSkillBlockForInjectsSessionContext } from '../../skills/injection-mode.js';
import { whiteboardEnabled } from '../../services/whiteboard-store.js';

/**
 * Adapter for xAI Grok Build TUI (`grok`).
 *
 *  Binary: `grok` (install: curl -fsSL https://x.ai/cli/install.sh | bash).
 *  State:  `$GROK_HOME` (default `~/.grok`) — auth, sessions/<encoded-cwd>/
 *          <uuid>/, skills, hooks, session_search.sqlite. All paths below go
 *          through grok-paths helpers so a custom GROK_HOME stays consistent
 *          between the spawned CLI and the worker's watchers.
 *
 *  ## Session model (verified on grok 0.2.93)
 *  - botmux `sessionId` is already a UUID (`randomUUID()`), valid for
 *    `grok --session-id` on fresh spawns.
 *  - The session dir (summary.json + updates.jsonl) is created at TUI
 *    STARTUP, before any prompt. `--session-id <id>` REFUSES an id whose dir
 *    already exists ("Session ID is already in use", exit 1), so a fresh
 *    spawn probes the dir and omits the flag when present (otherwise the
 *    worker's tier-2 resume→fresh fallback would crash-loop on the same
 *    UUID). Grok then mints its own id; writeInput's submit verify
 *    recaptures it as cliSessionId.
 *  - Resume: `--resume <cliSessionId|sessionId>`; preflight via
 *    `checkResumeTargetExists` against `summary.json`. A positional initial
 *    prompt IS honored on resume spawns (verified), so no
 *    `initialPromptArgsIgnoredOnResume`.
 *
 *  ## Type-ahead
 *  Grok's interactive TUI accepts mid-turn Enter as a follow-up. Although its
 *  UI describes this as queued, 0.2.99 transcripts can contain multiple
 *  `user_message_chunk`s before one `turn_completed` (active-turn merge).
 *  `supportsTypeAhead: true` remains useful for ordinary IM turns and
 *  CodexBridgeQueue's HOL-block-drop attributes the one merged final to the
 *  newest matching turn. Durable deliveries are explicitly excluded from
 *  type-ahead on both sides by the worker's queue policy, so an exact receipt
 *  can never be merged away.
 *  Multi-line input via tmux `send-keys -l` is safe: grok treats a literal
 *  `\n` as a soft newline inside the composer, NOT as submit (verified —
 *  no bracketed paste needed, unlike codex).
 *
 *  ## Status / bridge
 *  Bridge source of truth: per-session `updates.jsonl`
 *  (`user_message_chunk` / `agent_message_chunk` + `turn_completed`),
 *  drained via `drainGrokUpdates`. Submit VERIFY uses the bucket-level
 *  `prompt_history.jsonl` instead: it is appended AT SUBMIT TIME even while
 *  a turn is running, whereas updates.jsonl records a parked type-ahead
 *  message only at DEQUEUE time — polling it would spuriously fail every
 *  busy-turn submit (codex's history.jsonl plays the same role there).
 *  Ready gate: global `$GROK_HOME/hooks/botmux-session-ready.json`
 *  SessionStart → `botmux session-ready` (`injectsReadyHook`).
 *
 *  ## Session context / system prompt
 *  Grok's append flag is `--rules` (docs: alias of Claude's
 *  `--append-system-prompt`). Full replace is `--system-prompt-override` —
 *  too aggressive for botmux (would drop Grok's default agent prompt). We
 *  set `injectsSessionContext` and push `buildBotmuxSystemPromptText` via
 *  `--rules`, same contract as Claude's `--append-system-prompt` path
 *  (session-manager then omits inline <botmux_routing>/<identity>/<session_id>).
 *
 *  ## Skills
 *  Interactive TUI does **not** accept `--plugin-dir` (agent-only / headless).
 *  Built-ins use global `$GROK_HOME/skills` with global|prompt|off modes.
 *  With injectsSessionContext, prompt/off catalogs ride on `--rules`
 *  (genius pattern) rather than the per-message envelope.
 *
 *  ## Plan mode
 *  Claude disallows EnterPlanMode/ExitPlanMode for Feishu UX (blocking
 *  approval). Grok's TUI equivalent is `--no-plan`.
 *
 *  ## Sandbox
 *  `authPaths: [$GROK_HOME]` (directory) — grok keeps SQLite DBs there
 *  (session_search.sqlite, worktrees.db) which fail under overlayfs fcntl
 *  locks.
 */
export function createGrokAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand).
  const rawBin = pathOverride ?? 'grok';
  let cachedBin: string | undefined;
  return {
    id: 'grok',
    // Absolute runtime paths (not `~/…` literals): GROK_HOME can override the
    // data root, and sandbox/auth carve-outs must track the same resolved dir
    // the spawned CLI uses (split-brain bug if we freezed `~/.grok` at build).
    // Same pattern as codex's lazy skillsDir getter under CODEX_HOME.
    get authPaths(): readonly string[] { return [grokHome()]; },
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    supportsTypeAhead: true,
    // updates.jsonl provides a session-scoped, explicit `turn_completed`
    // boundary. The bridge preserves empty finals and maps error/cancelled
    // stop reasons, so meeting delivery never relies on prompt-looking screen
    // idle. Crash/submit failures are reconciled by the worker's exact-attempt
    // terminal path.
    reliableTurnTerminal: true,
    injectsReadyHook: true,
    injectsSessionContext: true,
    // Hold soft first-prompt timeout until SessionStart ready signal or the
    // composer's readyPattern — cold-start TUI can accept (and drop) stdin
    // before the real composer exists.
    deferFirstPromptTimeoutUntilReady: true,

    buildArgs({
      sessionId,
      resume,
      resumeSessionId,
      workingDir,
      model,
      initialPrompt,
      disableCliBypass,
      botName,
      botOpenId,
      locale,
      larkAppId,
    }) {
      const args: string[] = [];
      if (!disableCliBypass) {
        // Claude: --dangerously-skip-permissions. Grok: --always-approve (YOLO).
        args.push('--always-approve');
      }
      // Align Claude's EnterPlanMode/ExitPlanMode deny — Feishu can't drive
      // the plan-approval TUI cleanly. `--no-plan` is a top-level TUI flag.
      args.push('--no-plan');
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }

      if (resume) {
        const sid = resumeSessionId || sessionId;
        if (sid) args.push('--resume', sid);
        else args.push('--continue');
      } else if (sessionId && !grokSessionDirExists(sessionId, workingDir)) {
        // Pin grok's id to the botmux UUID so resume can reuse it. Skipped
        // when the dir already exists: grok exits 1 on a reused --session-id
        // (see header), which would turn the worker's crash-restart fresh
        // fallback into a spawn loop. Without the flag grok mints a new id
        // and writeInput's verify recaptures it.
        args.push('--session-id', sessionId);
      }

      // Claude: --append-system-prompt. Grok: --rules (append; docs alias).
      // Do NOT use --system-prompt-override — that replaces Grok's agent prompt.
      args.push(
        '--rules',
        buildBotmuxSystemPromptText({
          locale,
          botName,
          botOpenId,
          builtinSkillBlock: builtinSkillBlockForInjectsSessionContext(larkAppId, locale, {
            asksViaHook: false,
            whiteboardEnabled: whiteboardEnabled(),
          }),
        }),
      );

      // Positional initial prompt — processed after TUI startup (works for
      // fresh AND resume spawns, verified on 0.2.93). With injectsSessionContext
      // this is the user's first turn only (no inline routing envelope).
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    passesInitialPromptViaArgs: true,

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = cliSessionId || sessionId;
      if (!sid) return null;
      return `grok --resume ${sid}`;
    },

    checkResumeTargetExists({ sessionId, cliSessionId, workingDir }) {
      const sid = cliSessionId || sessionId;
      if (!sid) return false;
      return grokSessionExists(sid, workingDir);
    },

    listResumableSessions({ limit, exclude }) {
      return discoverGrokSessions(limit, exclude);
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Submit verify against the bucket-level prompt_history.jsonl (one
      // {timestamp, session_id, prompt} line per submit, written at submit
      // time even while a turn runs — see header). Requires cliCwd: without
      // it we cannot safely pick a bucket (scanning every cwd's history
      // would risk cross-session false matches + persist wrong cliSessionId).
      // Production always sets cliCwd (spawn + adopt); missing cwd → fail
      // closed and let the structured bridge recover.
      //
      // Concurrent workers share the cwd bucket's prompt_history. Bind each
      // match to THIS process's active Grok session via cliPid → open fds
      // (re-probed every poll so /new|/clear|/resume rotation is picked up).
      const cwd = pty.cliCwd;
      if (!cwd) {
        if (pty.sendText && pty.sendSpecialKeys) {
          if (pty.sendText(content) === false) return { submitted: false };
          await delay(scaleMs(200));
          if (pty.sendSpecialKeys('Enter') === false) return { submitted: false };
        } else {
          pty.write(content);
          await delay(scaleMs(1000));
          pty.write('\r');
        }
        return { submitted: false };
      }

      const historyPath = grokPromptHistoryPath(cwd);
      const baseByte = grokFileSize(historyPath);

      // Paste text once; retries only re-send Enter (codex/coco parity).
      // Re-pasting the full body on retry double-submits when the first Enter
      // actually landed but prompt_history was slow, or doubles composer text
      // when Enter was dropped but the paste stuck.
      // TmuxPipeBackend (adopt) returns false on failed writes instead of
      // throwing — treat false as definite failure.
      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) {
            return pty.sendSpecialKeys('Enter') !== false;
          }
          pty.write('\r');
          return true;
        } catch {
          // tmux session gone mid-write — bail cleanly.
          return false;
        }
      };

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          if (pty.sendText(content) === false) return { submitted: false };
          await delay(scaleMs(200));
        } else {
          pty.write(content);
          await delay(scaleMs(1000));
        }
      } catch {
        return { submitted: false };
      }
      if (!trySendEnter()) return { submitted: false };

      // First submit in a fresh bucket creates the file after our snapshot —
      // re-stat base as 0 when the path appears mid-poll. Re-resolve prefer
      // sid each probe so a mid-wait /new rotation still binds correctly.
      const probe = (): { found: boolean; cliSessionId?: string } => {
        const base = existsSync(historyPath) ? baseByte : 0;
        const preferSessionId = pty.cliPid
          ? findGrokSessionByPid(pty.cliPid)?.sessionId
          : undefined;
        return matchGrokPromptAppend(historyPath, base, content, { preferSessionId });
      };

      const deadline = Date.now() + scaleMs(4_000);
      for (let attempt = 0; attempt < 3; attempt++) {
        const waitUntil = Math.min(deadline, Date.now() + scaleMs(800));
        while (Date.now() < waitUntil) {
          const hit = probe();
          if (hit.found) {
            return hit.cliSessionId
              ? { submitted: true, cliSessionId: hit.cliSessionId }
              : { submitted: true };
          }
          await delay(scaleMs(100));
        }
        if (Date.now() >= deadline) break;
        if (!trySendEnter()) return { submitted: false };
      }

      const late = probe();
      if (late.found) {
        return late.cliSessionId
          ? { submitted: true, cliSessionId: late.cliSessionId }
          : { submitted: true };
      }

      const recheck = () => {
        const hit = probe();
        if (!hit.found) return false;
        return hit.cliSessionId
          ? { submitted: true as const, cliSessionId: hit.cliSessionId }
          : true;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // Composer box `❯` renders once the TUI is interactive — pairs with
    // deferFirstPromptTimeoutUntilReady to keep the first prompt held past
    // the soft timeout (the SessionStart ready hook is the primary signal).
    readyPattern: /❯/,
    // Busy markers verified on 0.2.93: "⠧ Waiting for response…" spinner
    // during the model phase, and the "Ctrl+c:cancel" shortcut-bar entry
    // through model AND tool phases (idle bar shows Shift+Tab:mode /
    // Ctrl+x:shortcuts only).
    busyPattern: /Waiting for response|Ctrl\+c:\s*cancel/i,
    // Routing/identity ride on --rules (injectsSessionContext); no inline hints.
    systemHints: [],
    altScreen: true,
    // Global skill root under $GROK_HOME (TUI has no --plugin-dir); layout is
    // `skills/<name>/SKILL.md`, same operational model as Codex.
    get skillsDir(): string { return grokSkillsDir(); },
    // SessionStart → botmux session-ready for injectsReadyHook gate.
    hookInstall: {
      get configPath(): string { return join(grokHooksDir(), 'botmux-session-ready.json'); },
      format: 'grok-hooks',
      sessionStartCommand: sessionReadyHookCommand(),
    },
    modelChoices: [
      'grok-4.5',
      'grok-composer-2.5-fast',
    ],
  };
}

export const create = createGrokAdapter;
