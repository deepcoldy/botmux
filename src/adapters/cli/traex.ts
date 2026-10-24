import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { wrapBracketedPaste } from './tui-input.js';
import { detectModelsViaExec, parseDebugModelsJson, detectModelCapabilitiesViaExec } from './model-catalog-json.js';
import type { CliAdapter, PtyHandle, StructuredBridgeSpec } from './types.js';
import { traeSessionsRoot, traeHistoryPath } from '../../services/traex-paths.js';
import {
  findTraexSessionIdByBotmuxSessionId,
  traexHistoryMatchDelta,
  traexHistorySize,
  findTraexRolloutSetByPid,
  traexHistorySidIsOwned,
  drainTraexRollout,
  findTraexRolloutByPid,
  findTraexRolloutBySessionId,
  traexSessionIdFromRolloutPath,
  readTraexThreadDetails,
  readTraexThreadIndex,
  traexRolloutUserInputs,
} from '../../services/traex-transcript.js';
import { discoverRolloutSessions } from '../../services/resumable-session-discovery.js';
import { delay } from '../../utils/timing.js';
import { traexRestoredComposerReady, traexViewportFooterBusy } from './traex-footer.js';

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

/**
 * First-run "Legacy TRAE CLI data detected → migrate?" done-markers at the
 * ~/.trae ROOT. traecli treats a marker's mere EXISTENCE (content/mode
 * irrelevant — verified with a 0-byte `chmod 444` file) as "migration already
 * done" and skips the interactive prompt. Under the file sandbox the migration
 * SOURCE ~/.cache/coco is visible (baseline rw bind) but ~/.trae root is not, so
 * without these the TUI wedges on a prompt no human can answer in goal mode.
 *
 * Exposed READ-ONLY (via sandboxReadonlyPaths → fs-policy readonlyRoots), NOT by
 * widening authPaths to the whole ~/.trae: that root also holds hooks/ plugins/
 * skills/ traecli.toml and authPaths compile to readWrite, which would let a
 * chat-driven sandbox mutate shared hook/plugin code other bots execute.
 *
 *  · .coco-rollouts-migrated  → gates the "recent SESSIONS" prompt (the wedge)
 *  · .coco-migrated           → gates the config-migration prompt (defence in depth)
 * Both are dirt-cheap read-only single-file binds; a marker absent on this host is
 * dropped by the worker's existence filter (keepExisting) so it can't cause a bind
 * FAILURE — but note that is not the same as "goal-mode is fine": if the migration
 * SOURCE (~/.cache/coco) exists while the marker is genuinely missing, the prompt
 * legitimately fires. In practice the markers are written host-side once migration
 * has run (the normal fleet state); this bind just makes that host truth visible
 * through the sandbox instead of hidden behind the ~/.trae/cli-only carve-out.
 */
export const TRAE_MIGRATION_DONE_MARKERS = [
  '~/.trae/.coco-rollouts-migrated',
  '~/.trae/.coco-migrated',
] as const;

/**
 * TraeX active-turn busy marker. Every anchor below is extracted verbatim
 * from the traex binary's compiled-in TUI string tables and verified across
 * all 9 local releases (0.201.1-alpha.5 … 0.201.2-alpha.2, both `traex` and
 * `traex-code-mode-host`):
 *
 *  - Spinner frames: the contiguous string "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
 *    (braille rotation compiled into every release).
 *  - Spinner label set 1 (thinking/working rotation): "Thinking longer…",
 *    "Deep in thought…", "Almost there…", "Running command…",
 *    "Command in flight…", "Chugging along…", "Finishing up…", "Executing…",
 *    "Hang tight…", "Waiting for response…", "Any second now…",
 *    "Poking the model…", "On its way…", "Shh, it's thinking…",
 *    "Thinking…", "Reasoning through it…", "Mulling it over…",
 *    "Pondering…", "Working it out…", "Piecing it together…".
 *  - Spinner label set 2 (approval/working/queue): "Reviewing approval
 *    request", "Working…", "Working on it…", "Queued for capacity",
 *    "Queued for next turn".
 *  - Standalone queue notice: "Too many requests right now. You're in the
 *    queue."
 *
 * Older local releases had deleted Codex's "esc to interrupt" footer, but
 * TraeX 0.207.x renders it again while a turn is active. Keep it line-anchored
 * with the standalone queue states so quoted prose does not become busy proof.
 * A live TraeX 0.201.6 turn also renders an `esc to interrupt` activity
 * footer while retaining the visible composer and context bar. Raw PTY and
 * 100ms screen captures verified seven rotating glyphs and ordinary activity
 * labels as well as PreToolUse/PostToolUse/UserPromptSubmit hook-runner rows.
 * TraeX 0.209.1 (tmux capture) renders the capacity queue in the same shape:
 * "◆ Queued for capacity (1s • esc to interrupt)" followed by an indented
 * "└ Too many requests right now. …" child row — neither is caught by the
 * line-start-anchored queue arms, so the activity-row arm must cover it.
 *
 * Four branches:
 *  1. Spinner-anchored labels: "<braille frame><space><label>". The frame
 *     never appears in transcript prose, so assistant output like
 *     "Working… on the fix" cannot revive a completed card. Covers the
 *     working/thinking rotation AND the spinner-prefixed queue state
 *     ("⠋ Queued for capacity" — the queue screen can render a frozen
 *     spinner frame in front of the label).
 *  2. Standalone capacity-queue strings, line-anchored
 *     (`(?:^|[\n\r])[ \t]*…`): "Queued for capacity" and the full queue
 *     notice. The queue screen can render statically (no animating spinner),
 *     so the frame anchor must not be required for it. The line anchor keeps
 *     assistant prose quoting the string mid-sentence ("…says Queued for
 *     capacity whenever…") from registering as busy.
 *  3. Line-anchored activity rows. These require one of the seven observed
 *     rotating glyphs, a no-parentheses activity label, and an elapsed-time /
 *     `esc to interrupt` footer in one pair of parentheses. A closing quote
 *     immediately after the footer is rejected so `◆ Ran echo "(...)"`
 *     history cannot revive an already-idle session. Hook-runner rows use the
 *     same footer shape, so they need no event-name-specific arm.
 *  4. (staticBusyPattern below) the same queue evidence as a pre-idle latch
 *     inside IdleDetector — see TRAEX_STATIC_BUSY_PATTERN.
 *
 * Both states must be covered: the worker's busy-pattern idle probe marks
 * the prompt ready as soon as the marker leaves the viewport, so matching
 * only the queue strings would flash Idle the moment the queue resolves
 * into a real working turn.
 */
const TRAEX_SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export const TRAEX_SPINNER_LABELS = [
  // Set 1 — thinking/working rotation (compiled-in spinner string table).
  'Thinking longer…',
  'Deep in thought…',
  'Almost there…',
  'Running command…',
  'Command in flight…',
  'Chugging along…',
  'Finishing up…',
  'Executing…',
  'Hang tight…',
  'Waiting for response…',
  'Any second now…',
  'Poking the model…',
  'On its way…',
  "Shh, it's thinking…",
  'Thinking…',
  'Reasoning through it…',
  'Mulling it over…',
  'Pondering…',
  'Working it out…',
  'Piecing it together…',
  // Set 2 — approval/working/queue.
  'Reviewing approval request',
  'Working…',
  'Working on it…',
  'Queued for capacity',
  'Queued for next turn',
] as const;

/** Line-anchored standalone busy/queue strings. Shared by the active
 *  busy pattern and the pre-idle static latch (see below). */
const TRAEX_QUEUE_STATIC_ARMS = [
  'Queued for capacity',
  'Queued for next turn',
  'esc to interrupt',
  "Too many requests right now\\. You're in the queue",
];

/** Capacity-only evidence for the experimental auto-model pool.
 *
 * This is deliberately narrower than TRAEX_ACTIVE_BUSY_PATTERN: ordinary
 * working labels, `Queued for next turn`, and generic interrupt footers must
 * never rotate a model. The worker also requires an exact active managed turn
 * before acting on this display-only signal.
 */
const TRAEX_CAPACITY_QUEUE_PATTERN = new RegExp(
  [
    `^[ \\t]*[${TRAEX_SPINNER_FRAMES}⋄✧◇✦❖◈◆][ \\t]+Queued for capacity[ \\t]+\\([^\\r\\n]*esc to interrupt\\)[ \\t]*$`,
    `^[ \\t]*(?:[└├│][ \\t]*)?Too many requests right now\\. You're in the queue(?: at position[ \\t]+\\d+)?\\.[ \\t]*$`,
  ].join('|'),
  'im',
);

const TRAEX_PROGRESS_PATTERN = new RegExp(
  `^[ \t]*[${TRAEX_SPINNER_FRAMES}⋄✧◇✦❖◈◆][ \t]+(?:${TRAEX_SPINNER_LABELS.filter(label => !label.startsWith('Queued')).join('|')})(?:[ \t]*\\([^\\r\\n]*esc to interrupt\\))?[ \t]*$`, 'i');

function traexCurrentFooterState(screen: string): 'capacity' | 'progress' | 'other' | undefined {
  // In no-alt-screen mode an earlier queue row can remain above the current
  // thinking row. The latest activity, rather than elapsed time, wins.
  for (const row of screen.split(/\r?\n/).slice(-12).reverse()) {
    if (TRAEX_PROGRESS_PATTERN.test(row)) return 'progress';
    if (TRAEX_CAPACITY_QUEUE_PATTERN.test(row)) return 'capacity';
    if (/Queued for next turn/.test(row)) return 'other';
  }
  return undefined;
}

export function traexCapacityQueueVisible(screen: string): boolean {
  return !!screen && traexCurrentFooterState(screen) === 'capacity';
}

export function traexCapacityQueuePosition(screen: string): number | undefined {
  if (!traexCapacityQueueVisible(screen)) return undefined;
  const match = screen.split(/\r?\n/).slice(-12).join('\n').match(
    /^[ \t]*(?:[└├│][ \t]*)?Too many requests right now\. You're in the queue at position[ \t]+(\d+)\.[ \t]*$/im,
  );
  const position = match ? Number(match[1]) : undefined;
  return Number.isSafeInteger(position) && position! >= 0 ? position : undefined;
}

/** Positive work evidence, scoped to the current footer, not quoted history. */
export function traexModelProgressVisible(screen: string): boolean {
  return traexCurrentFooterState(screen) === 'progress';
}

/** Legacy TraeX can show current work immediately above next-turn parking.
 * Parking alone is not capacity pressure or work evidence. Preserve that
 * input surface only with its adjacent live spinner and native context footer;
 * unknown/draft rows must not authorize a queued paste. This is input admission
 * evidence only, not a signal for the capacity-switch controller. */
export function traexQueuedTypeAheadVisible(screen: string): boolean {
  const rows = screen.trimEnd().split(/\r?\n/).slice(-12);
  for (let index = rows.length - 1; index >= 0; index--) {
    if (!/^[ \t]*Queued for next turn[ \t]*$/.test(rows[index]!)) continue;
    if (index === 0 || !traexModelProgressVisible(rows[index - 1]!)) return false;
    const footer = rows.slice(index + 1).filter(row => row.trim());
    return footer.length <= 1 && footer.every(row =>
      /^[ \t]*(?:[^\r\n]* · )?Context \d+% (?:left|used)[ \t]*$/.test(row));
  }
  return false;
}

/** Rotating activity glyphs observed on live TraeX activity rows. */
const TRAEX_ACTIVITY_GLYPHS = '⋄✧◇✦❖◈◆';

/** TraeX activity footer captured from live 0.201.6 / 0.209.1 TUIs. Keep it
 *  line- and glyph-anchored: no-alt-screen history can contain the same words.
 *  The lookahead right after `(` confirms the `esc to interrupt` phrase lives
 *  inside this same parenthesis before consuming anything: a long near-miss
 *  line (glyph + parenthesis full of elapsed-time tokens but no footer phrase)
 *  otherwise backs off quadratically — observed ~18s on a 144K PTY chunk vs
 *  <1ms with the guard. IdleDetector feeds unbounded chunks here, so the
 *  pattern must fail fast rather than merely stay rare. */
const TRAEX_ACTIVITY_PATTERN = String.raw`(?:^|[\n\r])[ \t]*[${TRAEX_ACTIVITY_GLYPHS}][ \t]*[^()\r\n]{0,240}\((?=[^()\r\n]*\besc[ \t]+to[ \t]+interrupt\b)[^()\r\n]*\d+(?:h|m|s)(?:[ \t]+\d+(?:m|s))?[^()\r\n]*\besc[ \t]+to[ \t]+interrupt\b[^()\r\n]*\)(?![ \t]*["'\x60])`;

const TRAEX_ACTIVE_BUSY_PATTERN = new RegExp(
  [
    `[${TRAEX_SPINNER_FRAMES}][ \\t]?(?:${TRAEX_SPINNER_LABELS.join('|')})`,
    ...TRAEX_QUEUE_STATIC_ARMS.map((arm) => `(?:^|[\\n\\r])[ \\t]*${arm}`),
    TRAEX_ACTIVITY_PATTERN,
  ].join('|'),
  'i',
);

/**
 * Pre-idle static-busy latch for the capacity-queue screen (ZMX gap).
 *
 * busyPattern/idleToBusyPattern cannot cover the FIRST static queue on ZMX:
 *  - busyPattern is a viewport probe; deferPromptReadyWhileBusy() and the
 *    idle probe bail when backendScreenEvidenceIsAuthoritativeForMutation()
 *    is false (ZMX history is not a trustworthy current viewport).
 *  - idleToBusyPattern only self-heals an ALREADY-published idle, and only
 *    from fresh PTY bytes; a static queue screen emits none.
 *
 * This pattern is consumed inside IdleDetector from the raw PTY byte stream
 * (the same trust level as readyPattern/completionPattern — NOT the
 * forbidden screen-capture snapshot): a chunk carrying queue evidence latches
 * "static busy" and suppresses screen-derived idle until a chunk with
 * readyPattern evidence but no queue string redraws (the real composer).
 * Includes the spinner-prefixed queue form: a frozen braille frame in front
 * of the label would otherwise only buy the 3s spinner guard, after which
 * the static screen would still false-idle.
 */
const TRAEX_STATIC_BUSY_PATTERN = new RegExp(
  [
    `[${TRAEX_SPINNER_FRAMES}][ \\t]?Queued for capacity`,
    ...TRAEX_QUEUE_STATIC_ARMS.map((arm) => `(?:^|[\\n\\r])[ \\t]*${arm}`),
  ].join('|'),
  'i',
);

/** traex / codex / coco 的 `debug models` 输出同构，解析逻辑抽到
 *  model-catalog-json.js 共享；旧名 re-export 保持既有引用（含测试）可用。 */
export { parseDebugModelsJson as parseTraexModelsJson };

/** TRAE rollouts are byte-identical to Codex's; only discovery differs. Unlike codex,
 *  adopt follows the shared skeleton, and a pid-probed rollout also reveals the
 *  native session id (persisted by the worker). */
export const traexBridgeSpec: StructuredBridgeSpec = {
  drain: (path, offset, ctx) => drainTraexRollout(path, offset, { adoptMode: ctx.adoptMode }),
  locate: {
    bySessionId: sessionId => findTraexRolloutBySessionId(sessionId),
    byPid: pid => findTraexRolloutByPid(pid)?.path,
  },
  spawn: { sessionId: 'cli', baseline: 'resume-aware' },
  adopt: {
    attach: 'split-live',
    // Segment-aware parser (resumed rollouts are `…-<sid>_<turn>.jsonl`). An
    // arrow, not a bare reference, so the import is read at call time.
    pidProbedSessionId: path => traexSessionIdFromRolloutPath(path),
  },
};

export function createTraexAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'traex';
  let cachedBin: string | undefined;
  return {
    id: 'traex',
    bridgeSpec: traexBridgeSpec,
    // Whole ~/.trae/cli kept REAL: traex is codex-based and keeps the same SQLite
    // state/log DBs there (state_*.sqlite / logs_*.sqlite) — under the deny-by-
    // default file sandbox a path not in authPaths doesn't exist, so the DBs are
    // unreachable / lack the fcntl locks SQLite needs (same failure as codex.ts).
    // NOTE: we deliberately do NOT widen this to the whole ~/.trae — that root
    // holds hooks/ plugins/ skills/ traecli.toml, and authPaths compile to
    // readWrite (fs-policy `push(authPaths,'readWrite')`), so a chat-driven
    // sandbox could mutate shared hook/plugin CODE that later bots (or the user's
    // own non-sandboxed traecli) execute. The first-run migration markers that
    // must be visible are exposed READ-ONLY via sandboxReadonlyPaths() instead.
    authPaths: ['~/.trae/cli'],
    sandboxReadonlyPaths: () => [...TRAE_MIGRATION_DONE_MARKERS],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, forkSession, workingDir, model, reasoningEffort, modelBackendVariant, disableCliBypass, bypassHookTrust, hideRateLimitModelNudge, remoteWsUrl, remoteThreadId, shellSubprocessEnv, nativeSubagentRuntimeHookCommand }) {
      // TraeX shares Codex's low-quota picker and notice setting. Disable it
      // per process so a message-submit Enter cannot confirm a model switch.
      const modelNudgeArgs = hideRateLimitModelNudge
        ? ['-c', 'notice.hide_rate_limit_model_nudge=true']
        : [];
      // Hybrid RPC input mode (codex-family): attach the TUI to the botmux-owned
      // app-server thread; input flows via JSON-RPC (see codex-rpc-engine + worker)
      // instead of a drop-prone paste. TRAE CLI shares codex's --remote/resume
      // shape, so this is identical to the codex adapter's branch.
      if (remoteWsUrl && remoteThreadId) {
        // -c check_for_update_on_startup=false: RPC pane has no terminal input path,
        // so an interactive update dialog would freeze the resume. TraeX shares
        // codex's config schema; disable at the process level, never user-global.
        return ['--remote', remoteWsUrl, 'resume', '--no-alt-screen', '-c', 'check_for_update_on_startup=false', ...modelNudgeArgs, remoteThreadId];
      }
      const baseArgs = [
        ...(!disableCliBypass ? [
          '--dangerously-bypass-approvals-and-sandbox',
          // Supported TRAE baseline 0.200.16+ has a second interactive
          // "Hooks need review" gate
          // after folder trust. Goal-mode workers have no human at their PTY,
          // so without the automation-specific hook flag they never reach the
          // prompt and `/goal` is never delivered. Gated by the same global
          // `bypassHookTrust` toggle as codex (default ON, operator can disable —
          // it trusts ALL hook sources, not only botmux's), still ANDed with the
          // existing bypass decision: restricted bots must not gain hook trust.
          ...(bypassHookTrust ? ['--dangerously-bypass-hook-trust'] : []),
        ] : []),
        '--no-alt-screen',
        ...modelNudgeArgs,
        ...goalEnvConfigArgs(),
      ];
      // Keep trigger-user identity wrappers available in tool shells. Set only
      // the requested keys, without inheriting the entire worker environment.
      for (const [key, value] of Object.entries(shellSubprocessEnv ?? {})) {
        if (value === undefined) continue;
        baseArgs.push('-c', `shell_environment_policy.set.${key}=${JSON.stringify(value)}`);
      }
      if (model && model.trim()) baseArgs.push('--model', model.trim());
      if (reasoningEffort) baseArgs.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
      if (modelBackendVariant) baseArgs.push('-c', `model_backend_variant=${JSON.stringify(modelBackendVariant)}`);
      if (nativeSubagentRuntimeHookCommand) {
        baseArgs.push('-c', traexNativeSubagentHookConfig(nativeSubagentRuntimeHookCommand));
      }
      if (workingDir) baseArgs.push('-C', workingDir);
      if (!resume) return baseArgs;

      const traeSessionId = resumeSessionId ?? findTraexSessionIdByBotmuxSessionId(sessionId);
      if (!traeSessionId) return baseArgs;
      // Session fork: TraeX exposes the same native subcommand shape as Codex
      // (`traecli fork <id>`). It mints a new thread while leaving the source
      // untouched. The worker sets forkSession only for a fork child's first
      // spawn; later restarts use ordinary resume against the child's new id.
      return [forkSession ? 'fork' : 'resume', ...baseArgs, traeSessionId];
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = cliSessionId ?? findTraexSessionIdByBotmuxSessionId(sessionId);
      if (!sid) return null;
      return `traex resume ${sid}`;
    },

    /** Import path: TRAE writes Codex-family rollout files under
     *  `<TRAE_HOME>/cli/sessions`. */
    listResumableSessions({ limit, exclude }) {
      // Ordering needs only the cheap per-thread index; prompt-bearing detail
      // columns are read lazily for the candidates discovery actually parses.
      const metadataById = new Map([...readTraexThreadIndex()].map(([id, entry]) => [id, {
        cwd: entry.cwd,
        lastActivityAt: entry.updatedAtMs,
        rolloutPath: entry.rolloutPath,
      }]));
      return discoverRolloutSessions(traeSessionsRoot(), limit, exclude, {
        dialect: 'traex',
        metadataById,
        loadSessionDetails: ids => readTraexThreadDetails(ids),
        userInputTexts: traexRolloutUserInputs,
        sessionIdFromPath: traexSessionIdFromRolloutPath,
      });
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

      // Submit confirmation polls the global submit log history.jsonl, NOT the
      // per-session rollout. TRAE is a type-ahead CLI: a message pasted while a
      // turn is running is PARKED in TRAE's queue and only written to the
      // rollout when the running turn dequeues it — which can exceed the
      // worker's confirmation deadline and fire a false "submission couldn't be
      // confirmed" warning even though TRAE received it. history.jsonl is
      // written at SUBMIT time (verified empirically on traecli 0.200.19: a
      // mid-turn follow-up appears here in ~1s while the rollout lags past 20s),
      // so it confirms parked submits immediately. This mirrors the codex
      // adapter, which polls its identically-shaped history.jsonl for the same
      // reason. history.jsonl is created lazily on the first submit, so an
      // absent file just means baseByte=0 and the first appended line matches.
      const historyPath = traeHistoryPath();
      const baseByte = traexHistorySize(historyPath);

      const cliPid = typeof pty.cliPid === 'number' && Number.isInteger(pty.cliPid) && pty.cliPid > 0
        ? pty.cliPid
        : undefined;

      // Two separable facts, matched with two different scans:
      //  - SUBMIT confirmation: any full-content match in the global submit log,
      //    ownership-INDEPENDENT (a foreign-first line or unknown pid must never
      //    suppress it, or the false "submission couldn't be confirmed" warning
      //    this fix removes would come back).
      //  - SESSION ID: history.jsonl is shared by every TRAE pane under one
      //    TRAE_HOME, so a sibling's identical text can surface a foreign id.
      //    Return the id ONLY when this pid provably owns that rollout.
      //
      // The three states of findTraexRolloutSetByPid are kept DISTINCT (not
      // flattened through a boolean helper) because they drive different waits:
      //   • undefined  → fd enumeration unavailable (no pid / not on Linux /
      //     proc unreadable): we can never prove ownership, so there is no point
      //     polling for an owned line — confirm the submit on any-text at once.
      //   • Set (maybe empty) → enumeration works; an owned line may simply not
      //     be on disk yet. KEEP polling for it and do NOT let a foreign-first
      //     any-text hit end the loop early (a sibling's identical line can land
      //     on poll N while our owned line appears on poll N+k — returning
      //     no-SID on the first foreign sighting would permanently drop our id).
      const ownedMatch = (owned: Set<string> | undefined) =>
        traexHistoryMatchDelta(historyPath, baseByte, content, (sid) => traexHistorySidIsOwned(sid ?? '', owned));
      const anyMatch = () => traexHistoryMatchDelta(historyPath, baseByte, content);

      try {
        if (pty.pasteText) pty.pasteText(content);
        else pty.write(wrapBracketedPaste(content));
      } catch {
        return { submitted: false };
      }
      await delay(200);
      if (!trySendEnter()) return { submitted: false };

      // `sawAnyText` remembers that the submit is proven (an any-text line
      // exists) even while we keep polling for the OWNED line. Once set, no
      // further Enter is needed — the message is in TRAE's log — so the loop only
      // waits for the owned rollout to surface.
      let sawAnyText = false;
      // Prefer an owned id whenever enumeration is possible. Returns a final
      // result to return now, or null to keep waiting. `final` relaxes the
      // owned-wait: at budget end / on the worker recheck, confirm on any-text.
      const resolve = (final: boolean) => {
        const owned = cliPid ? findTraexRolloutSetByPid(cliPid) : undefined;
        if (owned !== undefined) {
          const m = ownedMatch(owned);
          if (m.found && m.cliSessionId) return { submitted: true as const, cliSessionId: m.cliSessionId };
          // Enumeration works but no owned line yet. Note submit evidence but
          // keep waiting for the owned id — unless the budget is spent.
          if (anyMatch().found) sawAnyText = true;
          return final && sawAnyText ? { submitted: true as const } : null;
        }
        // Enumeration unavailable — can't prove ownership, so confirm the submit
        // on any-text as soon as it appears (no owned line to wait for).
        if (anyMatch().found) return { submitted: true as const };
        return null;
      };

      for (let attempt = 0; attempt < 3; attempt++) {
        const confirmed = resolve(false);
        if (confirmed) return confirmed;
        await delay(800);
        // Only re-Enter while the submit is still unproven; once any-text is
        // seen the message is committed and we're merely waiting for the owned
        // rollout fd, so another Enter would risk a duplicate submit.
        if (!sawAnyText && !trySendEnter()) return { submitted: false };
      }
      const finalConfirmed = resolve(true);
      if (finalConfirmed) return finalConfirmed;
      // In-band budget exhausted. Hand the worker a recheck closure: a slow or
      // busy TRAE may still append our history line after the retries gave up,
      // and the worker re-scans on a delay before warning the user.
      const recheck = () => resolve(true) ?? false;
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // Active-turn busy marker — spinner-anchored working/thinking labels plus
    // standalone capacity-queue strings. See the TRAEX_ACTIVE_BUSY_PATTERN
    // comment for the binary-extracted evidence and why both states are
    // required.
    busyPattern: TRAEX_ACTIVE_BUSY_PATTERN,
    idleToBusyPattern: TRAEX_ACTIVE_BUSY_PATTERN,
    // TraeX 0.209's glyph status row is recognisable only by its position
    // above the composer, which needs the WHOLE viewport (busyPattern sees a
    // tail region). The worker consults this before busyPattern in both the
    // prompt-ready veto and the idle probe, and supplies the getter only for
    // an authoritative screen. See traex-footer.ts.
    isSessionBusy({ getCurrentScreen }) {
      try {
        const screen = getCurrentScreen?.();
        return !!screen && traexViewportFooterBusy(screen);
      } catch {
        return false;
      }
    },
    // Pre-idle latch for the static capacity-queue screen — holds the session
    // busy before the first idle on backends (ZMX) where the busyPattern
    // viewport probe is forbidden from mutating state. See the
    // TRAEX_STATIC_BUSY_PATTERN comment.
    staticBusyPattern: TRAEX_STATIC_BUSY_PATTERN,
    // Clear the static-busy latch only on real composer evidence (line-start
    // or cursor-addressed rule followed by ›/❯, excluding numbered selector
    // rows). The broad readyPattern also
    // matches `\d+% left` (status bar), which the queue screen itself
    // carries — using it to clear the latch would re-open the ZMX false-idle
    // bug when queue and status bar arrive in separate chunks.
    staticBusyClearPattern: /(?:^|[\n\r]|(?<![─━])[─━]{3,})\s*[›❯](?!\s*\d+\.)/,
    // TRAE has shipped both the Codex-style `›` prompt and the Claude-style
    // `❯` prompt; v0.200.7 also renders a "Context 100% left" status bar.
    // Startup advisory / picker screens also use `❯ 1.` as a menu cursor, so
    // exclude numbered selector rows; otherwise botmux flushes the first prompt
    // into the advisory instead of TRAE's real composer.
    // v0.211.1 uses cursor movement between the rule and composer; stripping
    // ANSI joins them without a newline, so accept the preceding rule too.
    // Anchor to the start of each rule run to avoid quadratic retries on
    // long near-miss chunks. Keep its glyphs aligned with the clear guard
    // in IdleDetector.
    readyPattern: /(?:^|[\n\r]|(?<![─━])[─━]{3,})\s*[›❯](?!\s*\d+\.)|\d+% left/,
    // Skeleton composer gate, same cells and regexes as Codex (fork). Real
    // PTY samples from traex 0.205.1-alpha.3 (node-pty + xterm-headless):
    // the 0.6s frame already draws the `❯ Ask TraeCode CLI …` line and the
    // `100% context left` bar (both match readyPattern above) while the banner
    // cell is still `model:     loading` (directory already resolved); the
    // 1.5s frame has both `model:` and `directory:` cells resolved. The ready
    // banner on 0.201.1-alpha.6 has the identical two-cell shape. The `›` and
    // 2s of silence therefore do not prove submit readiness on cold start.
    // deferFirstPromptTimeoutUntilReady is already set below, so the worker's
    // first-prompt timeouts wait for this gate without worker-side changes.
    startupPendingPattern: /│[ \t]+(?:model|directory):[ \t]+loading\b/,
    startupReadyPattern: /│[ \t]+model:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│[ \t\r\n]*│[ \t]+directory:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│/,
    startupReadyFromHistory: traexRestoredComposerReady,
    systemHints: BOTMUX_SHELL_HINTS,
    // Healthy TraeX turns accept parked input while working. The worker fences
    // delivery independently after a terminal/composer conflict or an unknown
    // history receipt, so ordinary corrections need not wait for completion.
    supportsTypeAhead: true,
    // task_complete in the per-session rollout is an explicit durable turn
    // boundary; worker.ts drains it independently of screen-idle detection.
    reliableTurnTerminal: true,
    // task_complete closes the business turn, not the TUI generation. Require
    // a real ›/❯ composer on authoritative PTY screens before releasing input.
    postTerminalPromptFence: true,
    // A missing history receipt is ambiguous: block successors in this backend
    // generation and never replay the unconfirmed message automatically.
    quarantineUnconfirmedSubmits: true,
    // TRAE's trust/advisory startup screens can accept stdin before the real
    // composer exists, so the worker's 15s soft fallback must wait for the
    // prompt marker. A hard cap in the worker still prevents permanent hangs.
    deferFirstPromptTimeoutUntilReady: true,
    // TraeX treats a literal "@" in the composer as a file-mention trigger.
    // If an automatic title contains a Lark mention (for example "@Bot"), the
    // Enter meant to submit /rename selects a file instead and the next user
    // message is appended to the still-open rename command. Preserve the title
    // text with a full-width at sign so the command remains a single submit.
    buildSessionRenameCommand: (title) => `/rename ${title.replaceAll('@', '＠')}`,
    altScreen: false,
    skillsDir: '~/.trae/skills',
    // Curated subset — the full catalogue has 27 models. `traex debug models`
    // lists the rest; the setup flow always appends an "Other / custom"
    // free-text option so users aren't locked out.
    modelChoices: CLI_MODEL_CHOICES['traex'],
    // Live 模型枚举：`traex debug models` 输出单行 JSON（全量目录 24+ 个模型，
    // 每条带长 description，整包可达数百 KB），故 maxBuffer 给到 16MB、8s 超时
    // 兜底。仅 dashboard 在用户选中 traex 时按需调用，不在 daemon/worker 启动
    // 路径上；任何异常（spawn 失败/超时/输出非法）一律 fail-soft 返回 null，
    // picker 回退到上面的 modelChoices。
    async detectModels(): Promise<readonly string[] | null> {
      return detectModelsViaExec(this.resolvedBin, ['debug', 'models'], parseDebugModelsJson);
    },
    async detectModelCapabilities(options) {
      return detectModelCapabilitiesViaExec(this.resolvedBin, options?.env);
    },
    // RPC mode bridges native AskUserQuestion directly. Keep the normal
    // botmux-ask skill available too: TraeX sessions can fail closed to a
    // standard PTY when RPC is unavailable, where native questions cannot
    // reach the card bridge.
    asksViaHook: false,
  };
}

/** Render one process-layer hook entry. Trae merges this launch layer with
 * global/project hooks; this does not read or mutate either config source. */
export function traexNativeSubagentHookConfig(command: string): string {
  return `hooks.PreToolUse=[{matcher="spawn_agent",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
}
