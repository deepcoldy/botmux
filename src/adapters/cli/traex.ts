import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { parseDebugModelsJson } from './model-catalog-json.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { traeSessionsRoot, traeHistoryPath } from '../../services/traex-paths.js';
import {
  findTraexSessionIdByBotmuxSessionId,
  traexHistoryMatchDelta,
  traexHistorySize,
  findTraexRolloutSetByPid,
  traexHistorySidIsOwned,
  readTraexThreadMetadataIndex,
} from '../../services/traex-transcript.js';
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
 *    request", "Working…", "Working on it…", "Queued for capacity".
 *  - Standalone queue notice: "Too many requests right now. You're in the
 *    queue."
 *
 * TraeX forked from Codex and DELETED the "esc to interrupt" footer hint —
 * `grep -a -c "esc to interrupt"` returns 0 across every local release and
 * the 94MB TUI logs — so the Codex pattern's second anchor is invalid here.
 *
 * Three branches:
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
 *  3. (staticBusyPattern below) the same queue evidence as a pre-idle latch
 *     inside IdleDetector — see TRAEX_STATIC_BUSY_PATTERN.
 *
 * Both states must be covered: the worker's busy-pattern idle probe marks
 * the prompt ready as soon as the marker leaves the viewport, so matching
 * only the queue strings would flash Idle the moment the queue resolves
 * into a real working turn.
 */
const TRAEX_SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const TRAEX_SPINNER_LABELS = [
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
] as const;

/** Line-anchored standalone capacity-queue strings. Shared by the active
 *  busy pattern and the pre-idle static latch (see below). */
const TRAEX_QUEUE_STATIC_ARMS = [
  'Queued for capacity',
  "Too many requests right now\\. You're in the queue",
];

const TRAEX_ACTIVE_BUSY_PATTERN = new RegExp(
  [
    `[${TRAEX_SPINNER_FRAMES}][ \\t]?(?:${TRAEX_SPINNER_LABELS.join('|')})`,
    ...TRAEX_QUEUE_STATIC_ARMS.map((arm) => `(?:^|[\\n\\r])[ \\t]*${arm}`),
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

export function createTraexAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'traex';
  let cachedBin: string | undefined;
  return {
    id: 'traex',
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

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, model, reasoningEffort, modelBackendVariant, disableCliBypass, bypassHookTrust, remoteWsUrl, remoteThreadId, nativeSubagentRuntimeHookCommand }) {
      // Hybrid RPC input mode (codex-family): attach the TUI to the botmux-owned
      // app-server thread; input flows via JSON-RPC (see codex-rpc-engine + worker)
      // instead of a drop-prone paste. TRAE CLI shares codex's --remote/resume
      // shape, so this is identical to the codex adapter's branch.
      if (remoteWsUrl && remoteThreadId) {
        // -c check_for_update_on_startup=false: RPC pane has no terminal input path,
        // so an interactive update dialog would freeze the resume. TraeX shares
        // codex's config schema; disable at the process level, never user-global.
        return ['--remote', remoteWsUrl, 'resume', '--no-alt-screen', '-c', 'check_for_update_on_startup=false', remoteThreadId];
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
        ...goalEnvConfigArgs(),
      ];
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
      return ['resume', ...baseArgs, traeSessionId];
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = cliSessionId ?? findTraexSessionIdByBotmuxSessionId(sessionId);
      if (!sid) return null;
      return `traex resume ${sid}`;
    },

    /** Import path: TRAE writes Codex-family rollout files under
     *  `<TRAE_HOME>/cli/sessions`. */
    listResumableSessions({ limit, exclude }) {
      const nativeMetadata = readTraexThreadMetadataIndex();
      const metadataById = new Map([...nativeMetadata].map(([id, metadata]) => [id, {
        title: metadata.title,
        firstUserMessage: metadata.firstUserMessage,
        cwd: metadata.cwd,
        lastActivityAt: metadata.updatedAtMs,
      }]));
      return discoverRolloutSessions(traeSessionsRoot(), limit, exclude, {
        dialect: 'traex',
        metadataById,
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
        else pty.write('\x1b[200~' + content + '\x1b[201~');
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
    // Pre-idle latch for the static capacity-queue screen — holds the session
    // busy before the first idle on backends (ZMX) where the busyPattern
    // viewport probe is forbidden from mutating state. See the
    // TRAEX_STATIC_BUSY_PATTERN comment.
    staticBusyPattern: TRAEX_STATIC_BUSY_PATTERN,
    // Clear the static-busy latch only on real composer evidence (line-start
    // ›/❯, excluding numbered selector rows). The broad readyPattern also
    // matches `\d+% left` (status bar), which the queue screen itself
    // carries — using it to clear the latch would re-open the ZMX false-idle
    // bug when queue and status bar arrive in separate chunks.
    staticBusyClearPattern: /(?:^|[\n\r])\s*[›❯](?!\s*\d+\.)/,
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
    buildSessionRenameCommand: (title) => `/rename ${title}`,
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
    // Live 模型枚举：`traex debug models` 输出单行 JSON（全量目录 24+ 个模型，
    // 每条带长 description，整包可达数百 KB），故 maxBuffer 给到 16MB、8s 超时
    // 兜底。仅 dashboard 在用户选中 traex 时按需调用，不在 daemon/worker 启动
    // 路径上；任何异常（spawn 失败/超时/输出非法）一律 fail-soft 返回 null，
    // picker 回退到上面的 modelChoices。
    async detectModels(): Promise<readonly string[] | null> {
      try {
        // lazy promisify：顶层 promisify(execFile) 会在部分 mock child_process
        // 的测试 import 阶段炸（mock 无 execFile 导出）；推迟到调用时，fail-soft
        // 的 try/catch 兜住（契约：任何异常 → null）。
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync(this.resolvedBin, ['debug', 'models'], {
          timeout: 8000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const models = parseDebugModelsJson(stdout);
        return models.length > 0 ? models : null;
      } catch {
        return null;
      }
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

export const create = createTraexAdapter;
