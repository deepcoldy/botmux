#!/usr/bin/env node
/**
 * Worker process: manages a single CLI PTY session + web terminal.
 * Forked by the daemon, communicates via Node.js IPC.
 *
 * Lifecycle:
 *   1. Daemon forks this process
 *   2. Receives 'init' message with session config
 *   3. Spawns CLI via CliAdapter + PtyBackend (interactive mode)
 *   4. Starts HTTP + WebSocket server for xterm.js
 *   5. Receives 'message' events from daemon, writes to PTY stdin
 *   6. On 'close', kills CLI and exits
 *   7. On 'restart', kills CLI and re-spawns with --resume
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, statSync, readdirSync, readlinkSync, readFileSync, realpathSync, copyFileSync, watch as fsWatch, createWriteStream, type FSWatcher, type WriteStream } from 'node:fs';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { isAbsolute, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  evaluateReadIsolationGate,
  buildSeatbeltProfile,
  isolatedPaneReattachSafe,
  sendCredFilePath,
  botHomePath,
  buildV2DenyPaths,
  buildV2DenyRegexes,
  buildV2CarveOuts,
  type V2IsolationContext,
} from './adapters/cli/read-isolation.js';
import { killPersistentSession, type PersistentBackendType } from './core/persistent-backend.js';
import { drainTranscript, joinAssistantText, trailingAssistantText, findJsonlContainingFingerprint, findJsonlsContainingExactContent, findLatestJsonl, extractLastAssistantTurn, stringifyUserContent, extractTurnStartText, splitTranscriptEventsByCutoff, type TranscriptEvent } from './services/claude-transcript.js';
import { BridgeTurnQueue, makeFingerprint, normaliseForFingerprint } from './services/bridge-turn-queue.js';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from './services/bridge-fallback-gate.js';
import { shouldReleaseFirstPromptTimeout, shouldWriteNow } from './utils/input-gate.js';
import { stripAnsiForLog, tailChars } from './utils/crash-log.js';
import { installStdioEpipeGuard, isIgnorableStreamError } from './utils/stdio-epipe-guard.js';
import { mergeQueuedCliInput, type PendingCliInput } from './utils/pending-input-queue.js';
import { ReadyGate, shouldArmReadyGate } from './utils/ready-gate.js';
import { shouldRunStartupCommandsOnSpawn, shouldDeferInitialPromptForStartup } from './core/startup-commands.js';
import { sanitizePerBotEnv } from './core/per-bot-env.js';
import { InflightInputTracker } from './core/inflight-input-tracker.js';
import {
  shouldRunQuietRotation,
  evaluatePidResolverPullback,
  decideFingerprintSwitch,
  shouldHealAbsentBaseline,
  sessionIdFromJsonlPath,
  SESSION_ID_FILENAME_RE,
  type PidFollowResult,
} from './services/bridge-rotation-policy.js';
import { CodexBridgeQueue } from './services/codex-bridge-queue.js';
import { drainCodexRollout, findCodexRolloutBySessionId, findCodexRolloutByPid, splitCodexEventsByCutoff, extractLastCodexTurn, type CodexBridgeEvent } from './services/codex-transcript.js';
import { findTraexRolloutBySessionId, findTraexRolloutByPid } from './services/traex-transcript.js';
import { cocoEventsPathForSession, drainCocoEvents, findCocoSessionByPid } from './services/coco-transcript.js';
import { currentHermesStateOffset, drainHermesStateDb } from './services/hermes-transcript.js';
import { currentMtrSessionOffset, drainMtrSession, findLatestMtrSessionByDirectory, findMtrSessionById, type MtrTranscriptSource } from './services/mtr-transcript.js';
import { drainPiTranscript, findPiTranscriptByPid, findPiTranscriptBySessionId } from './services/pi-transcript.js';
import { drainCursorTranscript, findCursorChatIdByPid, findCursorTranscriptByChatId, findCursorTranscriptByPid } from './services/cursor-transcript.js';
import { shouldObserveCursorChatId, shouldPersistObservedCursorChatId } from './services/cursor-resume-policy.js';
import { baselineJsonlCursor } from './services/jsonl-cursor.js';
import { dirname } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { listenWebTerminalWithFallback } from './utils/web-terminal-listen.js';
import { TERMINAL_FAVICON_DATA_URI } from './utils/terminal-favicon.js';
import type { DaemonToWorker, WorkerToDaemon, DisplayMode, TermActionKey, ScreenStatus } from './types.js';
import { t, setDefaultLocale } from './i18n/index.js';
import { TerminalRenderer } from './utils/terminal-renderer.js';
import {
  DEFAULT_RENDER_COLS,
  DEFAULT_RENDER_ROWS,
  MAX_RENDER_COLS,
  MAX_RENDER_ROWS,
  MIN_RENDER_COLS,
  MIN_RENDER_ROWS,
  clamp,
  resolveRenderDimensions,
} from './utils/render-dimensions.js';
import { createCliAdapterSync, locateOnPath } from './adapters/cli/registry.js';
import { buildWrappedLaunch, parseWrapperCli, isTtadkWrapper } from './setup/cli-selection.js';
import { findLaunchedCliPid, scheduleWrapperRealCliPid, readComm, isBareShellComm, bareShellLaunchKind } from './core/session-discovery.js';
import { claudeJsonlPathForSession, resolveJsonlFromPid, findOpenClaudeSessionIds, DEFAULT_CLAUDE_DATA_DIR } from './adapters/cli/claude-code.js';
import { sessionReadyHookCommand } from './adapters/hook-command.js';
import { mtrSessionIdForBotmuxSession } from './adapters/cli/mtr.js';
import type { CliAdapter, PtyHandle, SubmitRecheckResult, CliId } from './adapters/cli/types.js';
import { PtyBackend } from './adapters/backend/pty-backend.js';
import { HerdrBackend } from './adapters/backend/herdr-backend.js';
import { TmuxBackend } from './adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from './adapters/backend/tmux-pipe-backend.js';
import { ZellijBackend, ZELLIJ_CONFIG_KDL } from './adapters/backend/zellij-backend.js';
import { ZellijObserveBackend } from './adapters/backend/zellij-observe-backend.js';
import { zellijEnv } from './setup/ensure-zellij.js';
import { isObserveBackend, type ObserveBackend } from './adapters/backend/types.js';
import { selectSessionBackend, decideBackendGate, backendGateUserMessage } from './adapters/backend/session-backend-selector.js';
import { prepareSandbox, attachSandboxOutbox, startOutboxWatcher, sandboxEnabled, sandboxedClaudeDataDir } from './adapters/backend/sandbox.js';
import type { BackendType, SessionBackend } from './adapters/backend/types.js';
import { tmuxEnv, probeTmuxFunctional } from './setup/ensure-tmux.js';
import { IdleDetector } from './utils/idle-detector.js';
import { ScreenAnalyzer } from './utils/screen-analyzer.js';
import { captureToPng } from './utils/screenshot-renderer.js';
import { snapshotToPng, snapshotToText, shouldCaptureScreen, isScreenSelfDriven } from './utils/transient-snapshot.js';
import { chooseWebTerminalSeed } from './utils/web-terminal-seed.js';
import { parseWorkerRequestUrl } from './utils/worker-http.js';
import { detectCliUsageLimit, usageLimitStateKey, type CliUsageLimitState } from './utils/cli-usage-limit.js';
import { uploadImageBuffer } from './utils/lark-upload.js';
import { redactChildEnv } from './utils/child-env.js';
import { decideSubmitConfirmationAction, type SubmitActivityEvidence } from './services/submit-confirmation.js';
import { config, resolveChatBotDiscoveryConfig } from './config.js';
import * as sessionStore from './services/session-store.js';
import * as pty from 'node-pty';
import { createHash } from 'node:crypto';
import { installHook, type HookInstallConfig } from './adapters/hook-installer.js';
import { hookCommandFor } from './adapters/hook-command.js';

// ─── State ───────────────────────────────────────────────────────────────────

let cliAdapter: CliAdapter | null = null;
let backend: SessionBackend | null = null;
let cliPidMarker: string | null = null;  // path to .botmux-cli-pids/<pid>
let seatbeltProfilePath: string | null = null;       // per-session Seatbelt .sb profile to rm at exit (external-wrapper read isolation)
let sandboxStopWatcher: (() => void) | null = null;  // stop fn for the sandbox outbox watcher
let sandboxCleanup: (() => void) | null = null;      // unmount overlays + rm the per-session sandbox tree
let sandboxTeardownDone = false;                     // guards the exit-time best-effort teardown from double-running / running on suspend-for-resume
/** Counts consecutive in-worker restart cycles (see case 'restart'). Used by
 *  the SECONDARY guard so an adapter whose checkResumeTargetExists misses
 *  (returns undefined) or whose resume target vanishes between the check and
 *  spawn never crash-loops: 2nd consecutive restart → drop resume semantics,
 *  spawn fresh. Reset to 0 whenever spawnCli proceeds with a successful
 *  (non-forced) config, so healthy restarts (e.g. user `/restart`) are
 *  unaffected. */
let consecutiveInWorkerRestarts = 0;
/** Guard: user_notify for "resume → fresh fallback" is sent once per worker
 *  lifecycle so a 4× crash loop does not spam the Lark thread with 4 copies
 *  of the same warning. */
let resumeFallbackNotified = false;

/** v2 read isolation — provision a bot's PER-BOT config dir under its BOT_HOME so the
 *  CLI (redirected there via CLAUDE_CONFIG_DIR/CODEX_HOME) starts fully set up despite
 *  the global ~/.claude|~/.codex being Seatbelt-denied. Idempotent (guards on
 *  existence), best-effort (only warns). The worker runs UNSANDBOXED, so it can read
 *  the global config/keychain to seed the per-bot copy. */
function provisionIsolatedBotHome(
  botHome: string,
  workingDir: string,
  isClaude: boolean,
  cliId: string,
  hookInstall: HookInstallConfig | undefined,
  log: (m: string) => void,
): void {
  try {
    if (isClaude) {
      const cdir = join(botHome, 'claude');
      mkdirSync(cdir, { recursive: true });
      // Auth: a fresh CLAUDE_CONFIG_DIR does NOT inherit the shared account's OAuth
      // token → keep <cdir>/.credentials.json synced to the FRESHEST valid credential
      // on EVERY spawn (verified: Claude logs in from that file). Refreshing here (not
      // just seeding once) means a re-login elsewhere self-heals on the next cold
      // spawn — no separate sync step needed. Same shared account for every bot.
      const fresh = freshestClaudeCred();
      if (fresh) writeCredIfChanged(join(cdir, '.credentials.json'), fresh);
      else if (!existsSync(join(cdir, '.credentials.json'))) {
        log(`[read-isolation] WARN no Claude credential found (keychain or ~/.claude/.credentials.json) — bot may hit login screen`);
      }
      // State: seed <cdir>/.claude.json from the GLOBAL one MINUS `projects` (keeps the
      // onboarding/promo "seen" flags + account so no dialogs appear, without leaking
      // other projects' data), then trust this bot's cwd. Merge-safe on resume.
      seedAndTrustClaudeState(join(cdir, '.claude.json'), workingDir, log);
      // Hooks: install the SessionStart-ready + askUserQuestion hooks into the PER-BOT
      // settings.json (global ~/.claude/settings.json is Seatbelt-denied), else the
      // worker's ready gate falls back to a slow timeout and AskUserQuestion won't relay.
      if (hookInstall) {
        try { installHook(cliId, { ...hookInstall, configPath: join(cdir, 'settings.json') }, hookCommandFor(cliId)); }
        catch (e) { log(`[read-isolation] WARN per-bot hook install failed: ${(e as Error).message}`); }
      }
    } else {
      const cdir = join(botHome, 'codex');
      mkdirSync(cdir, { recursive: true });
      // auth.json: keep synced to the shared account's copy on EVERY spawn (a re-login
      // elsewhere rotates the refresh token, which would strand a stale per-bot copy).
      const authSrc = join(homedir(), '.codex', 'auth.json');
      if (existsSync(authSrc)) writeCredIfChanged(join(cdir, 'auth.json'), readFileSync(authSrc, 'utf-8'));
      // config.toml: seed ONCE (it may carry per-bot customizations afterwards).
      const cfgDst = join(cdir, 'config.toml');
      const cfgSrc = join(homedir(), '.codex', 'config.toml');
      if (!existsSync(cfgDst) && existsSync(cfgSrc)) copyFileSync(cfgSrc, cfgDst);
    }
  } catch (e) {
    log(`[read-isolation] WARN provisioning bot home failed: ${(e as Error).message}`);
  }
}

/** Pick the FRESHEST valid Claude OAuth credential: macOS keychain vs the global
 *  `~/.claude/.credentials.json`, by `claudeAiOauth.expiresAt` (longest runway
 *  wins — a re-login updates one of the two, and this picks whichever is newer).
 *  Returns the raw credential JSON string, or null when neither source exists. */
function freshestClaudeCred(): string | null {
  const cands: { raw: string; exp: number }[] = [];
  const expOf = (raw: string): number => {
    try { return Number(JSON.parse(raw)?.claudeAiOauth?.expiresAt) || 0; } catch { return 0; }
  };
  try {
    const p = join(homedir(), '.claude', '.credentials.json');
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8').trim();
      if (raw) cands.push({ raw, exp: expOf(raw) });
    }
  } catch { /* unreadable file → skip candidate */ }
  try {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf-8' });
    const raw = (r.stdout ?? '').trim();
    if (raw) cands.push({ raw, exp: expOf(raw) });
  } catch { /* no keychain (non-mac) → skip candidate */ }
  if (!cands.length) return null;
  cands.sort((a, b) => b.exp - a.exp);
  return cands[0].raw;
}

/** Write a credential file (mode 0600) only when its content actually changed —
 *  avoids needless mtime churn on every spawn. Trailing-newline differences are
 *  ignored for the comparison; the written form is newline-terminated. */
function writeCredIfChanged(dst: string, raw: string): void {
  const body = raw.endsWith('\n') ? raw : raw + '\n';
  try {
    if (existsSync(dst) && readFileSync(dst, 'utf-8').trim() === raw.trim()) return;
  } catch { /* unreadable existing file → overwrite below */ }
  writeFileSync(dst, body, { mode: 0o600 });
}

/** Seed a fresh per-bot `.claude.json` from the global top-level flags (minus projects)
 *  so onboarding/promo dialogs are pre-dismissed and the account is recognized, then
 *  mark this bot's realpath(cwd) trusted. Merge-safe: only seeds when absent; always
 *  refreshes the cwd trust. */
function seedAndTrustClaudeState(statePath: string, workingDir: string, log: (m: string) => void): void {
  try {
    let data: Record<string, any> = {};
    if (existsSync(statePath)) {
      try { data = JSON.parse(readFileSync(statePath, 'utf-8')); } catch { data = {}; }
    } else {
      try {
        const g = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf-8')) as Record<string, any>;
        const { projects: _drop, ...top } = g;
        data = top;
      } catch { data = {}; }
    }
    if (!data.projects || typeof data.projects !== 'object') data.projects = {};
    let canonical = workingDir;
    try { canonical = realpathSync(workingDir); } catch { /* cwd may not exist yet */ }
    const entry = data.projects[canonical] && typeof data.projects[canonical] === 'object'
      ? data.projects[canonical]
      : (data.projects[canonical] = {});
    entry.hasTrustDialogAccepted = true;
    writeFileSync(statePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (e) {
    log(`[read-isolation] WARN seed .claude.json failed: ${(e as Error).message}`);
  }
}

const IDLE_PROBE_INTERVAL_MS = 3_500;
const IDLE_PROBE_MAX_ATTEMPTS = 24;
let busyPatternIdleProbeTimer: ReturnType<typeof setTimeout> | null = null;
let reattachIdleProbeTimer: ReturnType<typeof setTimeout> | null = null;
/** The effectiveResume flag used by the most recent spawnCli call. Written
 *  immediately after the two-tier fallback check so late-attach timers
 *  (hermes, cursor, etc.) can read THE SAME semantics the spawn used,
 *  instead of re-deriving from lastInitConfig.resume (which never reflects
 *  Tier-1/Tier-2 fresh demotion). Updated in spawnCli BEFORE any bridge
 *  setup so even the tick that fires between spawnCli-start and the
 *  adapter's hermesBridgeAttach reads the correct mode. */
let lastSpawnEffectiveResume = false;
let lastSpawnEffectiveCliSessionId: string | undefined;
let idleDetector: IdleDetector | null = null;
let isTmuxMode = false;
/** True once a crash diagnostic tmux shell (bmx-diag-<sid>) is live. */
let crashDiagnosticTmuxParked = false;
/** True once the daemon told us to stop & park a crash diagnostic (crash loop):
 *  the next user message retries the CLI. Distinct from the flag above because
 *  retry must still fire even if the tmux park itself failed (no hang). */
let crashDiagnosticStopped = false;
/** Exit code/signal of the just-exited CLI, stashed so a deferred park
 *  (park_diagnostic IPC) can stamp the captured log even though the park no
 *  longer happens inline in onExit. */
let lastCliExitCode: number | null = null;
let lastCliExitSignal: string | null = null;
/** Adopt-bridge mode using TmuxPipeBackend: not a tmux attach client, all
 *  web-terminal updates flow through the shared scrollback fan-out instead
 *  of per-WS attach-session PTYs. Set in spawnCli's adopt branch. */
let isPipeMode = false;
let effectiveBackendType: BackendType = 'pty';
/** pty-under-zellij backend (BACKEND_TYPE=zellij). Behaves like the non-tmux
 *  pty path for the worker (renderer screenshots, relay web terminal) but owns
 *  a persistent zellij session that survives daemon restart. */
let isZellijMode = false;
let httpServer: ReturnType<typeof createHttpServer> | null = null;
let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();
const authedClients = new WeakSet<WebSocket>();
/** Per-WS-client tmux/zellij attach PTYs. */
const clientPtys = new Map<WebSocket, pty.IPty>();
const writeToken = randomBytes(16).toString('hex');

/**
 * Resolve terminal write permission for one request, honoring a platform-injected
 * `X-Botmux-Role` header. The central platform fronts `/s/*` and sets the role
 * (owner | teammate | guest) after authenticating the viewer, stripping any
 * client-supplied header; it reaches the worker via dashboard /s bridge →
 * terminal-proxy → here. When the header is present we trust it (platform-fronted
 * access): only `owner` may drive the terminal; everything else (teammate / guest
 * / anything else) is read-only. When the header is absent (local direct access,
 * no platform in front), fall back to the legacy write-token query param.
 */
function resolveTerminalWrite(req: IncomingMessage, tokenMatches: boolean): { hasWrite: boolean; platformReadonly: boolean } {
  const role = req.headers['x-botmux-role'];
  if (typeof role === 'string' && role) {
    const hasWrite = role === 'owner';
    return { hasWrite, platformReadonly: !hasWrite };
  }
  return { hasWrite: tokenMatches, platformReadonly: false };
}

/** Lazily-written locked-mode zellij config for per-WS web-terminal attach
 *  clients: cleared keybinds + locked mode so every keystroke passes straight
 *  to the focused (codex) pane, never intercepted as a zellij shortcut. */
let zellijAttachCfgPath: string | null = null;
function ensureZellijAttachConfig(): string {
  if (zellijAttachCfgPath) return zellijAttachCfgPath;
  const p = join(process.env.SESSION_DATA_DIR ?? '/tmp', '.zellij-web-attach.kdl');
  // 原子写：同一 data dir 下多个 worker 进程会写同一路径（内容相同），
  // 裸写并发互踩会让 attach 客户端读到半截 kdl。
  try { atomicWriteFileSync(p, ZELLIJ_CONFIG_KDL); } catch { /* best effort */ }
  zellijAttachCfgPath = p;
  return p;
}

let sessionId = '';
let lastInitConfig: Extract<DaemonToWorker, { type: 'init' }> | null = null;
const CLI_DISPLAY_NAMES: Record<string, string> = { 'claude-code': 'Claude', seed: 'Seed', relay: 'Relay', aiden: 'Aiden', coco: 'CoCo', codex: 'Codex', 'codex-app': 'Codex App', cursor: 'Cursor', gemini: 'Gemini', genius: 'Genius', opencode: 'OpenCode', antigravity: 'Antigravity', mtr: 'MTR', hermes: 'Hermes', mira: 'Mira', mir: 'Mir CLI', traex: 'TRAE', pi: 'Pi', copilot: 'Copilot', 'oh-my-pi': 'Oh My Pi', kimi: 'Kimi' };
function cliName(): string { return CLI_DISPLAY_NAMES[lastInitConfig?.cliId ?? ''] ?? 'CLI'; }
let isPromptReady = false;
/** Mutex for async flushPending — prevents concurrent flush loops. */
let isFlushing = false;
/** Per-spawn one-shot: have this spawn's bot.startupCommands been typed in yet?
 *  Reset in spawnCli so a restart/resume (which re-spawns the CLI) re-applies
 *  them — needed because session-only settings like `/effort ultracode` are lost
 *  when the CLI restarts. Consumed inside flushPending right before the first
 *  user prompt is drained, so the commands always precede it (see runStartupCommands). */
let hasRunStartupCommands = false;
/** Per-spawn latch: set once the launch-failure detector has decided the pane
 *  leaf is a bare shell (the CLI never launched — e.g. a user rcfile that
 *  `exec`-trampolines into another shell pre-empted the wrapper's `exec <cli>`).
 *  Once set, flushPending refuses to type prompts into the bare shell (which
 *  would just produce `zsh: parse error`) and the user gets one diagnostic
 *  instead. Reset per spawn in spawnCli. */
let bareShellLaunchBlocked = false;
/** Per-spawn one-shot: has the bare-shell launch check already run for this
 *  spawn? Gates detectBareShellLaunch() to the FIRST flush only (the
 *  "about to type the first prompt" moment), independent of the startup-commands
 *  one-shot so it also covers a reattach onto a pane that degraded to a bare
 *  shell. Reset per spawn in spawnCli. */
let bareShellChecked = false;
/** Ready-gate (Claude-family): holds the first prompt until the SessionStart
 *  hook fires a true-ready signal, so a cjadk-style startup selector's ❯ (which
 *  falsely matches readyPattern) can't eat the first message. Recreated + armed
 *  per spawn in spawnCli; disarmed on signal or fallback timeout. */
let readyGate = new ReadyGate();
/** Fallback timer: if the SessionStart signal never arrives (hook injection
 *  failed / old CLI / launcher didn't pass --settings / adopt) release the gate
 *  and fall back to readyPattern + quiescence. */
let readySignalTimer: ReturnType<typeof setTimeout> | null = null;
/** How long the ready-gate waits for the SessionStart signal before falling
 *  back. The real signal lands within ~ms of the input box rendering, so this is
 *  pure insurance against a missing/failed hook — generous but bounded. */
const READY_SIGNAL_TIMEOUT_MS = 45_000;
/** Soft fallback for CLIs that never emit an idle/ready signal during startup.
 *  Legacy adapters release queued first input here. Adapters that opt into
 *  deferFirstPromptTimeoutUntilReady wait for the real readyPattern until the
 *  hard cap below. */
const FIRST_PROMPT_TIMEOUT_MS = 15_000;
/** Hard cap for startup screens that outlive the soft fallback. Prevents a
 *  changed/missing readyPattern from trapping the first queued input forever. */
const FIRST_PROMPT_HARD_TIMEOUT_MS = 90_000;
/** Epoch ms of the most recent PTY output — used to settle for quiescence
 *  before the first flush (see settleThenFlush). */
let lastPtyOutputAtMs = 0;
/** After the SessionStart signal fires, the input box has appeared but Ink's
 *  startup render isn't fully drained yet — typing immediately trips Claude's
 *  paste-burst heuristic and the `\` soft-newline markers (claude-code
 *  writeInput) get kept literally. This is pronounced under wrapperCli launchers
 *  (e.g. `aiden x claude`) whose Claude renders more at startup. So we wait for
 *  the PTY to fall quiet for SETTLE_MS before the first flush — the signal still
 *  gates readiness (anti-selector), the settle just lets the render drain. */
const READY_FLUSH_SETTLE_MS = 1_000;
/** Upper bound on the settle so a chatty startup (spinners, periodic redraw)
 *  can't stall the first prompt indefinitely. */
const READY_FLUSH_SETTLE_CAP_MS = 6_000;
let readyFlushSettleTimer: ReturnType<typeof setTimeout> | null = null;
/** True while the post-signal quiescence settle is in progress — flushPending
 *  holds (just like the gate) so a message arriving mid-settle can't type-ahead
 *  past the settle and re-trigger paste-burst. */
let isSettlingFirstFlush = false;

/** Wait until the PTY has been quiet for READY_FLUSH_SETTLE_MS (Ink render
 *  drained), capped at READY_FLUSH_SETTLE_CAP_MS, then flush the held prompt.
 *  A real SessionStart/BOTMUX_READY_COMMAND signal is itself authoritative
 *  prompt readiness; the timeout fallback only opens the gate and lets the
 *  regular readyPattern/idle path prove readiness later. */
function settleThenFlush(startedAtMs: number, promptReadyAfterSettle: boolean): void {
  readyFlushSettleTimer = null;
  const now = Date.now();
  const quietForMs = now - lastPtyOutputAtMs;
  if (quietForMs >= READY_FLUSH_SETTLE_MS || now - startedAtMs >= READY_FLUSH_SETTLE_CAP_MS) {
    isSettlingFirstFlush = false;
    log(`Ready-gate settle done (quiet ${quietForMs}ms); ${promptReadyAfterSettle ? 'marking prompt ready' : 'delivering held first prompt'}`);
    if (promptReadyAfterSettle) {
      markPromptReady();
      return;
    }
    void flushPending();
    return;
  }
  const wait = Math.min(READY_FLUSH_SETTLE_MS - quietForMs, READY_FLUSH_SETTLE_CAP_MS - (now - startedAtMs));
  readyFlushSettleTimer = setTimeout(() => settleThenFlush(startedAtMs, promptReadyAfterSettle), Math.max(50, wait));
  readyFlushSettleTimer.unref?.();
}

/** Release the ready-gate and flush anything it held. No-op when the gate was
 *  never armed (other CLIs / adopt) or already released (idempotent). */
function releaseReadyGate(reason: string, opts?: { promptReadyAfterSettle?: boolean }): void {
  if (readySignalTimer) { clearTimeout(readySignalTimer); readySignalTimer = null; }
  if (readyGate.receive()) {
    log(`Ready gate released (${reason}); settling for PTY quiescence before first flush`);
    if (readyFlushSettleTimer) { clearTimeout(readyFlushSettleTimer); readyFlushSettleTimer = null; }
    isSettlingFirstFlush = true;
    settleThenFlush(Date.now(), opts?.promptReadyAfterSettle === true);
  }
}

/** Per-startup-command quiescence: how long the PTY must be quiet before sending
 *  the next command, capped so a slow/redrawing command can't stall the queue. */
const STARTUP_CMD_QUIET_MS = 500;
const STARTUP_CMD_CAP_MS = 4_000;

/** Inter-keystroke spacing when typing a slash command into CoCo char-by-char.
 *  CoCo (Trae CLI, Ink TUI) treats "several bytes delivered in one PTY read" as a
 *  paste, which skips command mode + the slash picker — so each char must land as
 *  its own keystroke. 40ms is comfortably above CoCo's coalescing window (verified
 *  against Trae CLI 0.120.45) while keeping a short command sub-second. */
const COCO_SLASH_TYPE_THROTTLE_MS = 40;

/** Type one literal input LINE into the CLI exactly like a passthrough slash
 *  command: raw text → a 200ms beat (so the TUI's slash-command picker registers
 *  the match before submit) → a separate Enter. Non-TUI backends fall back to a
 *  single write + CR. Shared by the `raw_input` IPC handler and runStartupCommands
 *  so both stay in lockstep. */
async function sendRawCommandLine(be: NonNullable<typeof backend>, content: string): Promise<void> {
  if ('sendText' in be && 'sendSpecialKeys' in be) {
    if (lastInitConfig?.cliId === 'coco') {
      // CoCo (Trae CLI, Ink TUI) detects "several bytes in one PTY read = paste",
      // so a one-shot sendText('/model') lands as PASTED text: command mode + the
      // slash picker never activate and the trailing Enter submits `/model` to the
      // model (the "/model 多一个换行" bug). Fix: type char-by-char (throttled) so
      // each char is a distinct keystroke that opens command mode, and append ONE
      // trailing space to a bare command so the suggestion popup is dismissed.
      // Without that dismissal the popup captures the first Enter (CoCo then needs
      // two), and for an interactive command like /model — which opens a model
      // selector — a stray second Enter would confirm whatever model is highlighted.
      // Popup gone ⇒ exactly one Enter executes (/model just opens the selector and
      // waits). trim() first so a trailing newline carried from the Lark message
      // isn't typed as a literal newline that re-breaks command detection.
      const cmd = content.trim();
      const typed = cmd.includes(' ') ? cmd : `${cmd} `;
      for (const ch of typed) {
        (be as any).sendText(ch);
        await new Promise(r => setTimeout(r, COCO_SLASH_TYPE_THROTTLE_MS));
      }
      await new Promise(r => setTimeout(r, 200));
      (be as any).sendSpecialKeys('Enter');
      return;
    }
    (be as any).sendText(content);
    await new Promise(r => setTimeout(r, 200));
    (be as any).sendSpecialKeys('Enter');
  } else {
    // PtyBackend has no sendText/sendSpecialKeys, so write the keystrokes
    // directly — but still beat between the text and the Enter. Writing
    // `content + '\r'` in one chunk submits before the CLI's slash-command
    // parser has registered the `/cmd` match, so the command is left
    // unsent in the input box (observed with `/goal <text>` on a pty
    // workflow worker: typed but never executed). Mirror the tmux path's
    // 200ms beat.
    be.write(content);
    await new Promise(r => setTimeout(r, 200));
    be.write('\r');
  }
}

/** Resolve once the PTY has been quiet for `quietMs`, or after `capMs` total.
 *  Spaces out startup commands so each is processed before the next is typed. */
function awaitPtyQuiescence(quietMs: number, capMs: number): Promise<void> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const check = () => {
      const now = Date.now();
      if (now - lastPtyOutputAtMs >= quietMs || now - startedAt >= capMs) { resolve(); return; }
      const wait = Math.min(quietMs - (now - lastPtyOutputAtMs), capMs - (now - startedAt));
      const t = setTimeout(check, Math.max(50, wait));
      t.unref?.();
    };
    check();
  });
}

/** Type this spawn's bot.startupCommands into the CLI in order — one submit each,
 *  before the first user prompt. Best-effort: a failing command is logged and
 *  skipped, never blocking the first prompt. Skipped in adopt mode (we observe
 *  the user's existing session). Invoked once per spawn from flushPending under
 *  the isFlushing mutex, so no user message can interleave. */
async function runStartupCommands(): Promise<void> {
  const cmds = lastInitConfig?.startupCommands;
  if (!cmds || cmds.length === 0) return;
  if (lastInitConfig?.adoptMode) return;
  if (!backend) return;
  log(`Running ${cmds.length} startup command(s) before first prompt`);
  for (const cmd of cmds) {
    if (!backend) break;
    try {
      await sendRawCommandLine(backend, cmd);
      await awaitPtyQuiescence(STARTUP_CMD_QUIET_MS, STARTUP_CMD_CAP_MS);
      log(`Startup command sent: ${cmd}`);
    } catch (e: any) {
      log(`Startup command failed (${cmd}): ${e?.message ?? e}`);
    }
  }
  // Commands consumed turns and reset idle; treat the first user prompt fresh.
  isPromptReady = false;
  idleDetector?.reset();
}

const pendingMessages: PendingCliInput[] = [];
/** Inputs written to the CLI whose turn hasn't completed — re-queued across a
 *  CLI crash so a submit-time death can't silently eat user messages. */
const inflightInputs = new InflightInputTracker();
/** Alternate submit-confirmation signals. Some CLIs can consume PTY input and
 *  start work before their history/transcript submit marker is observable. */
let lastPtyActivityAtMs = 0;
let currentBotmuxTurnId: string | undefined;
function writeCliPidMarker(): void {
  if (!cliPidMarker || !sessionId) return;
  try {
    // 原子写：daemon 侧（killStalePids 等）随时读这个 marker JSON。
    atomicWriteFileSync(cliPidMarker, JSON.stringify({ sessionId, turnId: currentBotmuxTurnId ?? null }));
  } catch (err: any) {
    log(`Failed to update CLI PID marker: ${err?.message ?? err}`);
  }
}
let lastStructuredBridgeActivityAtMs = 0;

type RuntimeScreenStatus = Exclude<ScreenStatus, 'limited'>;

// Per-turn usage-limit state machine. Owns the turn counter plus the
// "did this turn hit a limit" / "suppress a stale retry-ready banner" flags, so
// classify()'s state writes are explicit method calls rather than hidden
// mutations of module globals from a function that otherwise reads as a pure
// mapper.
function createUsageLimitTracker() {
  let turnSeq = 0;
  let detectedTurn: number | undefined;
  let suppressedRetryReadyKey: string | undefined;

  return {
    currentTurn(): number {
      return turnSeq;
    },
    // Open a new turn; remember any stale retry-ready banner still on screen so
    // classify() doesn't re-flag it as a fresh limit this turn.
    beginTurn(snapshot: string): number {
      turnSeq++;
      detectedTurn = undefined;
      const current = detectCliUsageLimit(snapshot);
      suppressedRetryReadyKey = current.limited && current.retryReady
        ? usageLimitStateKey(current)
        : undefined;
      return turnSeq;
    },
    // Map a runtime status to a usage-limit-aware status, recording whether this
    // turn hit a limit (read back via detectedThisTurn).
    classify(
      content: string,
      status: RuntimeScreenStatus,
    ): { status: RuntimeScreenStatus | 'limited'; usageLimit?: CliUsageLimitState } {
      const detected = detectCliUsageLimit(content);
      if (!detected.limited) return { status };

      const key = usageLimitStateKey(detected);
      if (detected.retryReady && key === suppressedRetryReadyKey) {
        return { status };
      }

      suppressedRetryReadyKey = undefined;
      detectedTurn = turnSeq;
      return { status: 'limited', usageLimit: detected };
    },
    detectedThisTurn(seq: number): boolean {
      return detectedTurn === seq;
    },
  };
}

const usageLimitTracker = createUsageLimitTracker();

function currentUsageLimitSnapshot(): string {
  return lastAnalyzerSnapshot || renderer?.rawSnapshot() || '';
}

// ─── Adopt-bridge state (Claude Code only) ─────────────────────────────────
//
// In bridge mode the daemon adopted an existing CLI session that we do NOT
// own; the model never sees botmux. We harvest assistant turns by tailing
// Claude Code's transcript JSONL and forward only the bytes appended after
// each Lark-driven user turn — never the historical content present at
// attach time, never local-terminal-driven turns.
//
// Attribution lives in BridgeTurnQueue; this file only manages the
// fs.watch wakeup, byte-offset bookkeeping, lazy baseline, and IPC emit.
let bridgeJsonlPath: string | undefined;
/** Directory enclosing bridgeJsonlPath. We poll this dir for newer jsonl
 *  files so the bridge follows `/clear` / `/resume` in the user's CLI —
 *  those create a brand-new sessionId.jsonl, and a watcher pinned to the
 *  original path would silently stop receiving events. */
let bridgeJsonlDir: string | undefined;
/** PID + cwd of the adopted Claude Code process. Lets every poll re-read
 *  ~/.claude/sessions/<pid>.json — Claude's own pid-state record. Empirical
 *  scope (Claude Code 2.1.123): the pid file's `sessionId` is set ONCE at
 *  process start. `--resume` (which spawns a new process) does rotate the
 *  recorded sessionId; `/clear` / in-pane `/resume` do NOT — those rely on
 *  the fingerprint fallback (which anchors on a pending Lark turn) to
 *  follow the new jsonl. */
let bridgeCliPid: number | undefined;
let bridgeCliCwd: string | undefined;
/** Claude-family data root the bridge resolves JSONL / pid-state / tasks
 *  against. `~/.claude` for Claude Code; Seed CLI's `.claude-runtime`. Set at
 *  bridge start (from the adapter's claudeDataDir); defaults to `~/.claude` so
 *  the adopt path and any non-seed caller behave exactly as before. */
let bridgeDataDir: string = DEFAULT_CLAUDE_DATA_DIR;
/** Last sessionId we observed via the pid resolver — used to detect
 *  rotations cheaply (string compare instead of stat()ing every jsonl). */
let bridgeObservedCliSessionId: string | undefined;
/** Sibling-pane hijack guard state.
 *
 *  Every sessionId we have evidence of belonging to our adopted Claude pid:
 *  initial attach path, pid resolver hits, `/proc/<pid>/fd` hits. The
 *  fingerprint fallback's two-phase decision (`decideFingerprintSwitch`
 *  in `src/services/bridge-rotation-policy.ts`) consumes this set:
 *  Phase 1 substring match runs against trusted sids only; Phase 2
 *  exact-content recovery runs against UNTRUSTED sids only. Unknown
 *  sessionIds never pass Phase 1 even when the file looks freshly
 *  created — freshness/timestamp signals cannot prove pane ownership
 *  across siblings in the same project dir. */
const bridgeKnownSessionIds = new Set<string>();
/** Set when the fingerprint fallback accepts a candidate whose sessionId
 *  doesn't match the pid file's current sessionId (Claude's pid file isn't
 *  refreshed by in-pane `/clear`, so it keeps reporting the spawn-time sid
 *  even after the user rotated). Suppresses pid resolver from pulling the
 *  watcher back to that spawn-time sid every tick. Cleared when pid file
 *  reports a NEW sid (fresh `--resume` / spawn), at which point a real
 *  rotation has happened and we should follow it. */
let bridgeStalePidStateSessionId: string | undefined;
/** Old jsonl paths we keep polling AFTER a rotation switched
 *  bridgeJsonlPath away — needed when a started turn was stamped with the
 *  old path but its assistant text hasn't been written yet. We continue to
 *  drain each entry on every tick so trailing appends to that file land in
 *  the queue against the right turn, and prune the entry once no pending
 *  turn references the path anymore. */
const bridgeSecondaryPaths = new Map<string, number>(); // path → offset
let bridgeOffset = 0;
let bridgePendingTail = '';
const bridgeQueue = new BridgeTurnQueue();
let bridgeWatcher: FSWatcher | null = null;
let bridgeFallbackTimer: NodeJS.Timeout | null = null;
let herdrAdoptBridgeQuietTimer: NodeJS.Timeout | null = null;
const HERDR_ADOPT_BRIDGE_QUIET_MS = 3_000;
/** True once we successfully baselined the transcript file. Until then,
 *  any data we see is treated as history — absorbed into the queue's seen
 *  set without being attributed to a pending Lark turn. This protects the
 *  first Lark turn from inheriting historical lines if Claude Code creates
 *  the JSONL file *after* attach. */
let bridgeBaselineDone = false;
/** Once-per-attach flag so a re-baseline after fs.watch lazy-fire doesn't
 *  re-send the preamble. Reset only when the bridge teardown happens. */
let bridgePreambleSent = false;

// ─── Codex bridge state ──────────────────────────────────────────────────
//
// Parallel to the Claude bridge above. Codex's transcript layout is
// different enough (separate file location, different event schema) that
// trying to share storage / readers would obscure both — so we keep state
// independent. Marker file (`<DATA_DIR>/turn-sends/<sid>.jsonl`) and the
// gate function are CLI-agnostic and shared.
let codexBridgeRolloutPath: string | undefined;
let codexBridgeOffset = 0;
let codexBridgePendingTail = '';
let codexBridgeBaselineDone = false;
const codexBridgeQueue = new CodexBridgeQueue();
let codexBridgeWatcher: FSWatcher | null = null;
let codexBridgeTimer: NodeJS.Timeout | null = null;
let hermesBridgeOffset = 0;
let hermesBridgeBaselineDone = false;
let mtrBridgeSource: MtrTranscriptSource | undefined;
let mtrBridgeOffset = 0;
let mtrBridgeBaselineDone = false;
/** Codex sessionId we received via writeInput but haven't yet resolved a
 *  rollout file for. The poller keeps retrying — the file appears on
 *  Codex's first user submit, but with some race delay after our submit
 *  returns. Cleared once attached. */
let codexBridgePendingSessionId: string | undefined;
/** Adopt-only: PID of the externally-running Codex process. Used by the
 *  poller to fall back to /proc/<pid>/fd discovery when sessionId is
 *  unknown (e.g. discovery probe missed the rollout fd). */
let codexAdoptPendingPid: number | undefined;
/** Adopt-only: wall-clock millis at adopt-spawn time. Late-attach uses
 *  this as the cutoff for splitting an existing rollout into "history"
 *  (absorb) vs "live" (ingest) — so events the user produced AFTER adopt
 *  but BEFORE the rollout was located still reach the Lark thread. 5s
 *  skew tolerance is applied on top, mirroring the Lark/Claude bridges. */
let codexAdoptStartMs: number | undefined;

/** Adopt-only: 一次性发送的 "/adopt 前最后一轮" preamble 是否已经触发过。
 *  codexBridgeAttach 在 split-live 分支会查 history 取最后一对 user/assistant
 *  发给 daemon —— late-attach poller 也会反复走这条分支（每秒一次），所以
 *  必须有标志位防重发。镜像 claude 那套 bridgePreambleSent 的角色。 */
let codexBridgePreambleSent = false;

/** Cap the preamble text so an extremely long previous turn doesn't blow
 *  past Lark's per-message limit. The user only needs enough to recall
 *  context, not the entire transcript. */
const PREAMBLE_USER_MAX = 500;
const PREAMBLE_ASSISTANT_MAX = 4000;

/** Same intent as the preamble caps, but for live local-terminal turns
 *  forwarded to Lark. A long paste typed locally shouldn't be allowed to
 *  blow past Lark's per-message limit. */
const LOCAL_TURN_USER_MAX = 1000;
const LOCAL_TURN_ASSISTANT_MAX = 8000;

function truncatePreambleText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/** Prepare a local-turn `final_output` payload. The daemon owns the card
 *  chrome (label/quote/markdown body), so we ship the user prompt and
 *  assistant text as separate fields — see card-builder `buildContextualReplyCard`.
 *  Returns null when both sides are empty so the caller can skip the emit. */
function formatLocalTurnFields(userText: string, assistantText: string): { userText: string; content: string } | null {
  const u = truncatePreambleText(userText.trim(), LOCAL_TURN_USER_MAX);
  const a = truncatePreambleText(assistantText.trim(), LOCAL_TURN_ASSISTANT_MAX);
  if (!u && !a) return null;
  return { userText: u, content: a };
}

/** Same as `formatLocalTurnFields` but for HEADLESS local turns — daemon
 *  restart cut off an in-flight model stream so we have an assistant side
 *  with no resolvable user prompt. */
function formatHeadlessLocalTurnContent(assistantText: string): string | null {
  const a = truncatePreambleText(assistantText.trim(), LOCAL_TURN_ASSISTANT_MAX);
  return a || null;
}

// ─── Bridge fallback marker (non-adopt) ────────────────────────────────────
//
// `botmux send` (cli.ts cmdSend) appends a line
// `{sentAtMs, messageId, contentLength?}\n` to
// `<DATA_DIR>/turn-sends/<sid>.jsonl` every time the model successfully posts
// a reply to its OWN session thread. The worker reads these markers at idle
// and suppresses transcript-driven final_output for any turn whose time window
// already contains a send that appears to cover the same final answer — i.e.
// the model didn't forget, no fallback needed. Append-only over a shared file
// (instead of a per-turn marker) is
// type-ahead safe: type-ahead'd turns each have their own [markTimeMs,
// nextTurn.markTimeMs) window, and a stray send only fills its own bucket.
// This relies on each turn's markTimeMs reflecting when it ACTUALLY started
// processing, not when the worker marked it — the structured queue overrides
// markTimeMs to the dequeue-time transcript event (CodexBridgeQueue.ingest)
// and emitReadyCodexTurns only treats a STARTED next turn as a boundary, so
// the early back-to-back marks type-ahead produces don't collapse the windows.
function bridgeMarkerPath(): string | undefined {
  if (!process.env.SESSION_DATA_DIR || !sessionId) return undefined;
  return join(process.env.SESSION_DATA_DIR, 'turn-sends', `${sessionId}.jsonl`);
}

function readSendMarkers(): BridgeSendMarker[] {
  const path = bridgeMarkerPath();
  if (!path || !existsSync(path)) return [];
  try {
    const out: BridgeSendMarker[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.sentAtMs === 'number') out.push(parsed);
      } catch { /* skip malformed line */ }
    }
    return out;
  } catch (err: any) {
    log(`Bridge marker read failed: ${err.message}`);
    return [];
  }
}

function submitActivityEvidenceSince(sinceMs: number): SubmitActivityEvidence | undefined {
  if (lastPtyActivityAtMs > sinceMs) return 'pty-output';
  if (lastStructuredBridgeActivityAtMs > sinceMs) return 'structured-transcript';
  if (readSendMarkers().some(m => m.sentAtMs >= sinceMs)) return 'botmux-send';
  return undefined;
}

function clearSendMarkers(): void {
  const path = bridgeMarkerPath();
  if (!path) return;
  try { unlinkSync(path); } catch { /* already gone or fs.unavailable; not fatal */ }
}

function maybeEmitAdoptPreamble(events: TranscriptEvent[]): void {
  // Preamble is an /adopt-only signal: it tells the user "here's the last
  // turn from the Claude session you just attached to, so the Lark thread
  // has context to continue from". In non-adopt sessions the user IS the
  // Lark thread (every turn was already pushed there as a card), so
  // surfacing the last turn again on daemon restart is just noise.
  if (!lastInitConfig?.adoptMode) return;
  // Same logic for /adopt sessions restored after a daemon restart: the
  // Lark thread already has every prior turn pushed as cards, AND the
  // baseline jsonl persisted in session metadata may be stale (Claude
  // could have /clear'd since the original /adopt), so a preamble here
  // would surface old, out-of-context content.
  if (lastInitConfig?.adoptRestoredFromMetadata) return;
  if (bridgePreambleSent) return;
  const turn = extractLastAssistantTurn(events);
  if (!turn) return;
  bridgePreambleSent = true;
  send({
    type: 'adopt_preamble',
    turnId: currentBotmuxTurnId,
    userText: truncatePreambleText(turn.userText, PREAMBLE_USER_MAX),
    assistantText: truncatePreambleText(turn.assistantText, PREAMBLE_ASSISTANT_MAX),
  });
  log('Bridge adopt preamble emitted (last completed turn from baseline)');
}

/** Codex / CoCo 镜像版：split-live 攒齐 history 后挑最后一对 user/assistant_final
 *  发回 daemon 渲染成 "📜 /adopt 前最后一轮" 卡片。语义、跳过条件、字数截断都
 *  对齐 maybeEmitAdoptPreamble；区别只在事件取出方式（codex/coco 是结构化
 *  event，不需要走 claude 那套 jsonl turn assembly）。 */
function maybeEmitCodexAdoptPreamble(
  history: readonly { kind: 'user' | 'assistant_final'; text: string }[],
): void {
  if (!lastInitConfig?.adoptMode) return;
  if (lastInitConfig?.adoptRestoredFromMetadata) return;
  if (codexBridgePreambleSent) return;
  const turn = extractLastCodexTurn(history);
  if (!turn) return;
  if (!turn.userText.trim() && !turn.assistantText.trim()) return;
  codexBridgePreambleSent = true;
  send({
    type: 'adopt_preamble',
    turnId: currentBotmuxTurnId,
    userText: truncatePreambleText(turn.userText, PREAMBLE_USER_MAX),
    assistantText: truncatePreambleText(turn.assistantText, PREAMBLE_ASSISTANT_MAX),
  });
  log('Codex bridge adopt preamble emitted (last completed turn from split-live history)');
}

/** Extract the sessionId from a Claude jsonl path and add it to the
 *  known-sid set. Validates the filename against Claude's UUID-shaped
 *  sessionId pattern so non-Claude jsonls in the project dir (accidental
 *  drops, third-party tooling) can't poison the trust set. No-op on
 *  parse failure. */
function bridgeRememberSessionIdForPath(path: string | undefined): void {
  if (!path) return;
  const sid = sessionIdFromJsonlPath(path);
  if (!SESSION_ID_FILENAME_RE.test(sid)) return;
  bridgeKnownSessionIds.add(sid);
}

/** Cheap per-tick probe: read /proc/<bridgeCliPid>/fd and add every jsonl
 *  the adopted Claude pid currently has open into the known-sid set. fd
 *  observation is intermittent (Claude opens-writes-closes per event), so
 *  running this every tick raises our chances of catching a post-/clear
 *  sessionId before the user's next Lark message arrives. No-op when there
 *  is no pid or /proc isn't available. */
function bridgeProbeOpenSessionIds(): void {
  if (bridgeCliPid === undefined || !bridgeJsonlDir) return;
  const opened = findOpenJsonlsForPid(bridgeCliPid, bridgeJsonlDir);
  for (const path of opened) bridgeRememberSessionIdForPath(path);
}

function bridgeShouldEmitAfterTranscriptQuiet(): boolean {
  return lastInitConfig?.adoptMode === true
    && lastInitConfig?.adoptSource === 'herdr'
    && lastInitConfig?.cliId === 'claude-code'
    && !!bridgeJsonlPath;
}

function clearHerdrAdoptBridgeQuietTimer(): void {
  if (!herdrAdoptBridgeQuietTimer) return;
  clearTimeout(herdrAdoptBridgeQuietTimer);
  herdrAdoptBridgeQuietTimer = null;
}

function scheduleHerdrAdoptBridgeQuietEmit(): void {
  if (!bridgeShouldEmitAfterTranscriptQuiet()) return;
  clearHerdrAdoptBridgeQuietTimer();
  herdrAdoptBridgeQuietTimer = setTimeout(() => {
    herdrAdoptBridgeQuietTimer = null;
    if (!bridgeShouldEmitAfterTranscriptQuiet()) return;
    try {
      bridgeDrainAndMaybeEmit();
      markPromptReady();
      log('Bridge quiet emit attempted — herdr adopt mode');
    } catch (err: any) {
      log(`Bridge quiet emit error: ${err.message}`);
    }
  }, HERDR_ADOPT_BRIDGE_QUIET_MS);
  herdrAdoptBridgeQuietTimer.unref?.();
}

function bridgeAbsorbBaseline(): void {
  if (!bridgeJsonlPath) return;
  if (!lastInitConfig?.adoptMode) {
    const cursor = baselineJsonlCursor(bridgeJsonlPath);
    bridgeOffset = cursor.newOffset;
    bridgePendingTail = cursor.pendingTail;
    bridgeBaselineDone = true;
    return;
  }
  const result = drainTranscript(bridgeJsonlPath, 0);
  bridgeOffset = result.newOffset;
  bridgePendingTail = result.pendingTail;
  bridgeQueue.absorb(result.events);
  bridgeBaselineDone = true;
  // After absorb (uuids registered as seen so they won't re-emit as a Lark
  // turn), surface the last completed user/assistant exchange to Lark as a
  // one-shot preamble — but only for real /adopt sessions. Non-adopt
  // claude-code fallback bridge also uses baseline-existing on daemon
  // restart/resume; it must not emit the "/adopt 前最后一轮" message.
  if (lastInitConfig?.adoptMode) maybeEmitAdoptPreamble(result.events);
}

/** Record `bridgeStalePidStateSessionId` if the pid file's current sid
 *  disagrees with the just-accepted candidate's sid. Stops the next pid
 *  resolver tick from pulling the watcher back to the stale spawn-time
 *  path Claude wrote into the pid file — which it never refreshes on
 *  in-pane `/clear`. No-op when pid file is unavailable or already
 *  agrees. */
function bridgeMarkStalePidStateForAcceptedSid(acceptedSid: string): void {
  if (bridgeCliPid === undefined || bridgeCliCwd === undefined) return;
  const pidResolved = resolveJsonlFromPid(bridgeCliPid, bridgeCliCwd, bridgeDataDir);
  if (pidResolved && pidResolved.cliSessionId !== acceptedSid) {
    bridgeStalePidStateSessionId = pidResolved.cliSessionId;
  }
}

/** Apply a fingerprint-driven switch: drain old path, retire watcher,
 *  pivot bridgeJsonlPath to `matched`, split the new path's existing
 *  content by `cutoffMs` (history → absorbed into the seen set, live →
 *  ingested), and install a new fs.watch. The split-live step is what
 *  prevents the "switched into a long-lived /clear file → all prior
 *  iTerm-typed turns get re-emitted as 🖥️ 终端本地对话" symptom: any
 *  user/assistant events written before the Lark mark are pre-existing
 *  pane history, not events to forward. `cutoffMs` should be the same
 *  `markTimeMs - 5s` used for the fingerprint scan's lower bound. */
function bridgeApplyFingerprintSwitch(matched: string, reason: string, cutoffMs: number): void {
  // Drain-before-switch: pull in any unread bytes from the old path so a
  // late assistant append doesn't vanish. We do NOT emit here — emission
  // only happens at idle (bridgeDrainAndMaybeEmit), otherwise drainEmittable
  // would publish a half-finished assistant turn during fs.watch / poll
  // ticks (drainEmittable's contract is "has visible text", not "model
  // finished"). If the drained user/assistant events still need follow-up
  // appends on the old path, retainSecondaryPathIfStillReferenced() keeps
  // the old path in the polling rotation.
  if (bridgeJsonlPath && bridgeBaselineDone) {
    let postDrainOffset = bridgeOffset;
    try {
      const drained = drainPathInto(bridgeJsonlPath, bridgeOffset);
      postDrainOffset = drained.offset;
    } catch (err: any) {
      log(`Bridge final-drain on fingerprint switch failed (${err.message}); continuing`);
    }
    retainSecondaryPathIfStillReferenced(bridgeJsonlPath, postDrainOffset);
  }
  log(`Bridge transcript switched: ${bridgeJsonlPath} → ${matched} (${reason})`);
  if (bridgeWatcher) {
    try { bridgeWatcher.close(); } catch { /* ignore */ }
    bridgeWatcher = null;
  }
  // Critically: do NOT clear pending turns. The switch was triggered by
  // the FIRST pending turn already living in `matched`, so the immediate
  // next ingest from offset 0 will find that user event and start the
  // turn. Clearing here would race-drop exactly the message we're
  // trying to deliver.
  bridgeJsonlPath = matched;
  bridgeJsonlDir = dirname(matched);
  bridgePendingTail = '';
  // Split-live: drain `matched` from offset 0, partition by cutoffMs.
  // History (pre-mark) is absorbed into the seen set so the iTerm-side
  // turns the user accumulated before this Lark message DON'T re-emit
  // as "🖥️ 终端本地对话" cards. Live (post-mark) goes through ingest
  // so the Lark fingerprint can start its turn. Mirrors what
  // performRotationSwitch already does for fd-rotation rotations.
  const drained = drainTranscript(matched, 0);
  bridgeOffset = drained.newOffset;
  bridgePendingTail = drained.pendingTail;
  const { history, live } = splitTranscriptEventsByCutoff(drained.events, cutoffMs);
  bridgeQueue.absorb(history);
  if (live.length > 0) bridgeQueue.ingest(live, matched);
  bridgeBaselineDone = true;
  log(`Bridge fingerprint switch split: ${history.length} historical events absorbed, ${live.length} live events ingested (cutoff=${cutoffMs})`);
  bridgeRememberSessionIdForPath(matched);
  bridgeMarkStalePidStateForAcceptedSid(sessionIdFromJsonlPath(matched));
  try {
    bridgeWatcher = fsWatch(matched, { persistent: false }, () => {
      try { performBridgeIngestAndScheduleQuietEmit(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable on new target (${err.message}); relying on fallback poller`);
  }
}

/** Detect /clear / /resume: when Claude Code starts a new session in the
 *  user's pane it writes to a brand-new sessionId.jsonl. Two-phase scan:
 *
 *  - Phase 1 (known-sid substring): cheap path for trusted candidates
 *    only. Same content fingerprint substring search as before — safe
 *    here because we've gated it on the pid-derived trust set, so a
 *    sibling pane in the same project dir (different sessionId) can
 *    never be the match even when its content includes the fingerprint.
 *
 *  - Phase 2 (unknown-sid exact-content recovery): in-pane `/clear`
 *    creates a new sessionId Claude does NOT write into its pid file.
 *    If the fd probe didn't catch the brief open window, the new sid is
 *    untrusted and Phase 1 rejects it. Phase 2 falls back to scanning
 *    every UNTRUSTED candidate jsonl for a user/queue event whose
 *    NORMALISED content equals our just-marked Lark message in full
 *    (not a substring) — strong enough that "test" doesn't false-match
 *    "run tests". When exactly one untrusted candidate matches, accept
 *    it; when multiple match, abstain and surface an unambiguous log
 *    line so the user can take recovery action.
 *
 *  Pending turns are preserved across the switch so the next ingest
 *  can match and start the turn in the new file. */
/** Per-fingerprint rate limit for the full-directory fingerprint scan.
 *  Without this, a wedged pending turn (e.g. writeInput's Enter eaten by a
 *  Claude TUI prompt so the user line never lands in any jsonl) drives this
 *  function every 1s from the fallback timer and every idle tick — each
 *  call reads the trailing 1MB of every jsonl in the project dir (hundreds
 *  of files, 100s of MB total), pegging the worker at 99% CPU until
 *  restart. The cleanup paths in #1/#2 (dropPendingTurn / pruneExpired)
 *  are what actually *removes* the stuck mark; this rate limit just keeps
 *  the windows in between cheap.
 *
 *  10s is much wider than the milliseconds Claude needs to write a normal
 *  user line, but `maybeSwitchBridgeJsonl` is only consulted when the
 *  primary jsonl scan in `bridgeIngest` already failed to find the line —
 *  i.e. Claude rotated the file via `/clear` / `/resume`. Those rotations
 *  happen hours apart in practice, so a 10s detection delay is invisible. */
const BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS = 10_000;
const bridgeFingerprintScanLastMs = new Map<string, number>();

/** Pending+unstarted bridge marks expire after this long. Defensive TTL:
 *  every known path that creates a mark also has an explicit
 *  `dropPendingTurn` path, but TTL guarantees self-healing if a future
 *  code path forgets one. 120s is well past Claude's deferred recheck
 *  window (20s) and any plausible jsonl-flush delay; the only marks left
 *  this long are real failures. */
const BRIDGE_PENDING_TURN_TTL_MS = 120_000;

function maybeSwitchBridgeJsonl(): boolean {
  if (!bridgeJsonlDir) return false;
  const pending = bridgeQueue.peek();
  const candidate = pending.find(t => !t.started && !!t.contentFingerprint);
  if (!candidate || !candidate.contentFingerprint) return false;
  // Per-fingerprint rate limit — see BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS.
  const lastScan = bridgeFingerprintScanLastMs.get(candidate.contentFingerprint);
  const now = Date.now();
  if (lastScan !== undefined && now - lastScan < BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS) {
    return false;
  }
  bridgeFingerprintScanLastMs.set(candidate.contentFingerprint, now);

  // Bound the search to events written after the turn was marked. Short
  // fingerprints ("hello", "test") would otherwise match old user lines
  // in unrelated sibling jsonls. 5s skew absorbs clock drift between the
  // mark and Claude's transcript write.
  const minEventTimestampMs = candidate.markTimeMs !== undefined
    ? candidate.markTimeMs - 5_000
    : undefined;

  const fingerprintScanOptions = {
    excludePath: bridgeJsonlPath,
    includeQueueOperations: true,
    minEventTimestampMs,
  };
  const decision = decideFingerprintSwitch({
    contentFingerprint: candidate.contentFingerprint,
    contentNormalized: candidate.contentNormalized,
    knownSessionIds: bridgeKnownSessionIds,
    findSubstring: (acceptCandidate) =>
      findJsonlContainingFingerprint(bridgeJsonlDir!, candidate.contentFingerprint!, {
        ...fingerprintScanOptions,
        acceptCandidate,
      }),
    findExact: (acceptCandidate) =>
      candidate.contentNormalized
        ? findJsonlsContainingExactContent(bridgeJsonlDir!, candidate.contentNormalized, {
            ...fingerprintScanOptions,
            acceptCandidate,
          })
        : [],
  });
  if (decision.action === 'switch') {
    const reason = decision.reason === 'known-sid-substring'
      ? 'known-sid fingerprint match'
      : 'unknown-sid exact-content recovery (in-pane /clear with stale pid file)';
    // Boundary alignment with the fingerprint scanner:
    //
    //   scanner.minEventTimestampMs is INCLUSIVE — events with
    //     timestamp >= (markTimeMs - 5s) are eligible to start the turn.
    //   splitTranscriptEventsByCutoff puts timestamp <= cutoffMs in
    //     history (absorbed) and > cutoffMs in live (ingested).
    //
    // If we hand split the same value as the scanner's lower bound, an
    // event AT exactly that timestamp (e.g. the user's just-arrived
    // Lark user event) is matched-eligible by the scanner — driving
    // the switch — but absorbed as history by split, leaving the
    // pending turn unstarted and the message silent. Subtract 1ms to
    // make split's history strictly older than the scanner's
    // eligibility floor.
    const historyCutoffMs = ((candidate.markTimeMs ?? Date.now()) - 5_000) - 1;
    bridgeApplyFingerprintSwitch(decision.path, reason, historyCutoffMs);
    return true;
  }
  if (decision.action === 'abstain') {
    log(`Bridge fingerprint switch ABSTAINED (${decision.reason}): ${decision.candidates.length} unknown jsonls have an exact-content match for the pending Lark turn (${decision.candidates.join(', ')}). User should re-/adopt or send a longer disambiguating message.`);
    return false;
  }
  return false;
}

/** Last-resort rotation follower for the case where pid resolver returned
 *  `'unavailable'` (no /proc, missing/invalid pid file). Originally also
 *  ran on `'same'` to catch in-pane `/clear` with no pending Lark turn,
 *  but that path is now intentionally dropped — the directory-mtime
 *  heuristic in Path 2 below cannot tell our pane's rotation from a
 *  sibling Claude pane in the same cwd, and the sibling-pane hijack
 *  silently corrupts every multi-pane adopt setup (see
 *  `bridge-rotation-policy.ts`). The Lark-message-driven /clear recovery
 *  flow (fingerprint fallback) covers the dominant case.
 *
 *  Detection priority:
 *    1. Linux first-class: read `/proc/<pid>/fd` and pick the .jsonl the
 *       adopted Claude process actually has open. Bound to the real PID
 *       — a sibling Claude pane has a different PID and cannot hijack
 *       the result. Note: Claude Code opens-writes-closes per event, so
 *       this often returns 0 entries between writes; the gate above
 *       ensures we still skip Path 2 in that case when pid resolver
 *       confirmed our path.
 *    2. Cross-platform fallback: directory-level mtime heuristic, gated
 *       on (a) our current jsonl quiet ≥ QUIET_ROTATION_MS, (b) candidate
 *       newer by ≥ QUIET_ROTATION_MS, (c) adopted Claude pid alive. Only
 *       runs when Path 1 returns 0 entries AND pid resolver was
 *       unavailable.
 *
 *  When a rotation is detected, the new jsonl is drained from offset 0
 *  and events are split by timestamp against `rotationCutoffMs` (the
 *  old jsonl's last-write time): events before the cutoff are *history*
 *  (absorbed into the seen-set, not emitted), events after are *live*
 *  (ingested → local-turn synthesis runs). This is what lets a rotation
 *  to a long-history jsonl NOT replay the entire past as one giant
 *  local turn.
 *
 *  Critically, we do NOT call `bridgeAbsorbBaseline` here — that helper
 *  also fires `maybeEmitAdoptPreamble`, which on rotation would surface
 *  the *previous session's* last turn as if it were a fresh "/adopt 前最
 *  后一轮" preamble. Preamble belongs only to initial attach. */
const QUIET_ROTATION_MS = 8_000;

function statSafe(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** List `.jsonl` files inside `dir` that are currently held open by `pid`.
 *  Returns [] on non-Linux platforms or if /proc lookup fails — the caller
 *  treats an empty result as "fd info unavailable, fall back to mtime". */
function findOpenJsonlsForPid(pid: number, dir: string): string[] {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${name}`);
    } catch {
      continue;
    }
    if (!target.endsWith('.jsonl')) continue;
    if (dirname(target) !== dir) continue;
    out.push(target);
  }
  return out;
}

/** Pick the most recently modified path among `paths`. Returns null if
 *  none of them stat. */
function newestPath(paths: string[]): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const p of paths) {
    const st = statSafe(p);
    if (!st) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
  }
  return best?.path ?? null;
}

/** Switch bridgeJsonlPath to `newPath` and split-baseline its existing
 *  content: events with timestamp ≤ `cutoffMs` are absorbed as history
 *  (seen-set only, no emission), events strictly after are ingested so
 *  local turn synthesis runs against them. The old path is retained in
 *  the secondary polling rotation if any started turn still references
 *  it. Does NOT emit `adopt_preamble` — that's an initial-attach signal,
 *  not a rotation signal. */
function performRotationSwitch(newPath: string, cutoffMs: number, reason: string): void {
  // Drain-before-switch: pull any unread bytes from the old path so a
  // late assistant append doesn't vanish. Mirrors the other rotation
  // helpers.
  if (bridgeJsonlPath && bridgeBaselineDone) {
    let postDrainOffset = bridgeOffset;
    try {
      const drained = drainPathInto(bridgeJsonlPath, bridgeOffset);
      postDrainOffset = drained.offset;
    } catch (err: any) {
      log(`Bridge final-drain on rotation (${reason}) failed (${err.message}); continuing`);
    }
    retainSecondaryPathIfStillReferenced(bridgeJsonlPath, postDrainOffset);
  }

  log(`Bridge transcript switched (${reason}): ${bridgeJsonlPath ?? '(none)'} → ${newPath}`);
  if (bridgeWatcher) {
    try { bridgeWatcher.close(); } catch { /* ignore */ }
    bridgeWatcher = null;
  }
  bridgeJsonlPath = newPath;
  bridgeJsonlDir = dirname(newPath);
  bridgePendingTail = '';

  // Drain the new path from 0 ourselves (do NOT call bridgeAbsorbBaseline
  // — that would emit the preamble we want to suppress on rotation).
  const result = drainTranscript(newPath, 0);
  bridgeOffset = result.newOffset;
  bridgePendingTail = result.pendingTail;
  const { history, live } = splitTranscriptEventsByCutoff(result.events, cutoffMs);
  bridgeQueue.absorb(history);
  if (live.length > 0) bridgeQueue.ingest(live, newPath);
  bridgeBaselineDone = true;
  log(`Bridge rotation split: ${history.length} historical events absorbed, ${live.length} live events ingested`);

  try {
    bridgeWatcher = fsWatch(newPath, { persistent: false }, () => {
      try { performBridgeIngestAndScheduleQuietEmit(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable on rotated target (${err.message}); relying on fallback poller`);
  }
}

function maybeFollowQuietRotation(): void {
  if (!bridgeJsonlDir || !bridgeJsonlPath) return;
  // Need a known pid to do safe rotation tracking; if we don't have one,
  // we can't bind to the adopted Claude process and a directory-mtime
  // switch would risk sibling-pane hijack.
  if (bridgeCliPid === undefined) return;
  if (!isPidAlive(bridgeCliPid)) return;

  const currentStat = statSafe(bridgeJsonlPath);
  if (!currentStat) return;

  // Path 1: Linux fd-based detection — definitive, can't be hijacked.
  // Read /proc/<pid>/fd, find every .jsonl Claude has open in our cwd's
  // project dir, pick the one with the most recent mtime. Differs from
  // bridgeJsonlPath ⇒ rotation.
  const opened = findOpenJsonlsForPid(bridgeCliPid, bridgeJsonlDir);
  if (opened.length > 0) {
    // Every fd-observed jsonl belongs to our pid — feed all of them
    // into the sibling-pane hijack guard's trust list, not just the
    // newest. This is how a post-/clear sessionId enters the trust
    // set: Claude opens the new jsonl briefly during the /clear
    // handshake; if a fd probe lands in that window, fingerprint
    // fallback can later accept the new sessionId on the user's next
    // Lark message.
    for (const path of opened) bridgeRememberSessionIdForPath(path);
    const newest = newestPath(opened);
    if (newest && newest !== bridgeJsonlPath) {
      performRotationSwitch(newest, currentStat.mtimeMs, `pid fd → ${bridgeCliPid}`);
    }
    // fd lookup succeeded — even if it confirmed the current path, the
    // mtime fallback below would only add risk. Stop here.
    return;
  }

  // Path 2: non-Linux fallback (or /proc unavailable). Directory-mtime
  // heuristic with three guards plus a trust-set filter on candidates.
  //
  // Without the trust-set filter, an actively-written sibling Claude pane
  // in the same project dir always wins the mtime race; pid resolver then
  // pulls the watcher back to our own (idle) jsonl on the next tick,
  // re-arming the same condition. Result: 1 Hz path-flap that pegs CPU
  // for as long as the sibling keeps writing (observed: 8 days, 6896
  // switches on a single worker). Only candidates whose sid lives in
  // `bridgeKnownSessionIds` (populated from initial attach, pid resolver
  // hits, fd probes) are eligible — sibling sids are rejected.
  const now = Date.now();
  if (now - currentStat.mtimeMs < QUIET_ROTATION_MS) return;
  const latest = findLatestJsonl(bridgeJsonlDir, {
    acceptCandidate: (path) => {
      const sid = sessionIdFromJsonlPath(path);
      return SESSION_ID_FILENAME_RE.test(sid) && bridgeKnownSessionIds.has(sid);
    },
  });
  if (!latest || latest === bridgeJsonlPath) return;
  const latestStat = statSafe(latest);
  if (!latestStat) return;
  if (latestStat.mtimeMs - currentStat.mtimeMs < QUIET_ROTATION_MS) return;
  performRotationSwitch(latest, currentStat.mtimeMs, `quiet mtime fallback (${Math.round((now - currentStat.mtimeMs) / 1000)}s quiet)`);
}

/** Pid-state rotation follow: re-read ~/.claude/sessions/<cliPid>.json
 *  and switch bridgeJsonlPath whenever the recorded sessionId differs
 *  from what we're watching. Same source as the writeInput pid resolver,
 *  with the same cwd + procStart validation.
 *
 *  Empirical scope (Claude Code 2.1.123): the pid file's `sessionId` is
 *  written ONCE at process start. `--resume` rewrites it (it's a fresh
 *  spawn → fresh pid file). In-pane `/clear` does NOT rewrite it —
 *  `updatedAt` and `status` change but `sessionId` stays. So this probe
 *  catches spawn-time / `--resume` rotations; `/clear` (and in-pane
 *  `/resume` if Claude treats it the same) is left to the fingerprint
 *  fallback that anchors on a pending Lark turn. Returns a tri-state
 *  result rather than a bool so the caller can distinguish 'switched'
 *  (we moved) from 'same' (path confirmed) from 'unavailable' (no
 *  reliable answer) — the downstream gates use that distinction. */
/** Tri-state result so callers can distinguish "pid file unreadable, fall
 *  back to fingerprint heuristic" from "pid file confirmed current path"
 *  vs "pid file said rotate to a new path".
 *
 *  Used by two downstream gates:
 *  - Fingerprint fallback (`maybeSwitchBridgeJsonl`): runs whenever the
 *    pid resolver did not actively switch (`!= 'switched'`). Safe even
 *    on `'same'` because the fingerprint scan requires a pending Lark
 *    turn — no risk of hijacking to a sibling pane.
 *  - Quiet-mtime fallback (`maybeFollowQuietRotation`): runs only on
 *    `'unavailable'`. The mtime heuristic can't distinguish our pane's
 *    rotation from a sibling pane in the same cwd, so even when pid
 *    resolver's `'same'` is not proof against in-process /clear (it
 *    isn't — Claude doesn't refresh `sessionId` on /clear), we still
 *    skip the heuristic. The cost is that a pure-local /clear with no
 *    pending Lark turn won't auto-follow until the user sends a Lark
 *    message; the alternative (running mtime fallback on 'same') would
 *    silently corrupt every multi-pane adopt setup.
 *
 *  Type imported from `./services/bridge-rotation-policy` — the gate
 *  function lives there so it's testable without dragging worker fs/IPC
 *  side-effects into the unit suite. */

function maybeFollowSessionRotationViaPid(): PidFollowResult {
  if (!bridgeCliPid || !bridgeCliCwd) return 'unavailable';
  const resolved = resolveJsonlFromPid(bridgeCliPid, bridgeCliCwd, bridgeDataDir);
  if (!resolved) return 'unavailable';
  if (bridgeObservedCliSessionId !== resolved.cliSessionId) {
    bridgeObservedCliSessionId = resolved.cliSessionId;
  }
  // Pid resolver always reports the spawn-time sessionId — this is a sid
  // that genuinely belongs to our adopted Claude pid, so remember it for
  // the sibling-pane hijack guard.
  bridgeRememberSessionIdForPath(resolved.path);
  if (resolved.path === bridgeJsonlPath) return 'same';
  // Stale-pid suppression: when the fingerprint fallback accepted a
  // post-/clear jsonl (Claude's pid file isn't refreshed by in-pane
  // /clear, so it keeps reporting the spawn-time sid), pid resolver
  // would otherwise pull the watcher back to that spawn-time sid every
  // tick — re-creating the flap loop the user reported. The decision
  // lives in `bridge-rotation-policy.evaluatePidResolverPullback` so
  // the four-cell matrix can be unit-tested in isolation.
  const pullback = evaluatePidResolverPullback({
    resolvedCliSessionId: resolved.cliSessionId,
    resolvedPath: resolved.path,
    currentBridgeJsonlPath: bridgeJsonlPath,
    stalePidStateSessionId: bridgeStalePidStateSessionId,
  });
  if (pullback.clearStale) bridgeStalePidStateSessionId = undefined;
  if (pullback.suppress) return 'same';

  // Drain-before-switch: pull in any unread bytes from the OLD path so a
  // trailing assistant append doesn't vanish. We do NOT emit here — emit
  // is reserved for idle ticks (bridgeDrainAndMaybeEmit), otherwise we'd
  // publish a half-finished assistant during fs.watch / poll-driven
  // bridgeIngest calls. If a started turn still references the old path
  // and its assistant text might still be on the way, the old path stays
  // in the polling rotation via bridgeSecondaryPaths.
  if (bridgeJsonlPath && bridgeBaselineDone) {
    let postDrainOffset = bridgeOffset;
    try {
      const drained = drainPathInto(bridgeJsonlPath, bridgeOffset);
      postDrainOffset = drained.offset;
    } catch (err: any) {
      log(`Bridge final-drain on rotation failed (${err.message}); continuing`);
    }
    retainSecondaryPathIfStillReferenced(bridgeJsonlPath, postDrainOffset);
  }

  log(`Bridge transcript switched (pid resolver): ${bridgeJsonlPath ?? '(none)'} → ${resolved.path}`);
  if (bridgeWatcher) {
    try { bridgeWatcher.close(); } catch { /* ignore */ }
    bridgeWatcher = null;
  }
  // Preserve any pending Lark turn so the next ingest can attribute it
  // when Claude appends our user event to the new jsonl. Skip baseline:
  // we want to read from offset 0 so the pending turn's user event is
  // visible to BridgeTurnQueue.ingest(). Turns already started on the
  // old path keep their stamped sourceJsonlPath, so when their assistant
  // text eventually arrives there too it still resolves correctly.
  bridgeJsonlPath = resolved.path;
  bridgeJsonlDir = dirname(resolved.path);
  bridgeOffset = 0;
  bridgePendingTail = '';
  bridgeBaselineDone = true;
  try {
    bridgeWatcher = fsWatch(resolved.path, { persistent: false }, () => {
      try { performBridgeIngestAndScheduleQuietEmit(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable on rotated target (${err.message}); relying on fallback poller`);
  }
  return 'switched';
}

function bridgeIngest(): void {
  // Defensive TTL: sweep any pending+unstarted mark whose Lark message
  // never matched a user line in the transcript (writeInput failure
  // surface that didn't get caught, future paths that forget to call
  // dropPendingTurn). Without this, a stranded mark drives
  // `maybeSwitchBridgeJsonl` to do full-directory jsonl scans every tick
  // until daemon restart — the 99% CPU bug. The explicit dropPendingTurn
  // path in scheduleSubmitFailureNotify handles the known offender;
  // this catches everything else.
  const expired = bridgeQueue.pruneExpired(BRIDGE_PENDING_TURN_TTL_MS);
  for (const t of expired) {
    if (t.contentFingerprint) bridgeFingerprintScanLastMs.delete(t.contentFingerprint);
    log(`Bridge mark expired after ${Math.round(BRIDGE_PENDING_TURN_TTL_MS / 1000)}s without matching a jsonl user line (turnId=${t.turnId}) — dropped to prevent rotation-fallback scan loop.`);
  }
  // Drain secondary paths first so any trailing assistant text on an old
  // jsonl reaches the queue before the rotation check considers retiring
  // the path. Strictly read-only on the polling rotation; never triggers
  // a rotate or shifts the primary path.
  drainSecondaryPaths();
  // Cheap probe: catch any jsonls our adopted pid currently has open
  // and add their sessionIds to the sibling-pane hijack guard's trust
  // list. Runs every tick (independent of rotation gates) because
  // Claude opens-writes-closes the jsonl per event — fd observation
  // is therefore intermittent, and more ticks = more chances to
  // catch a post-/clear sessionId. This is the only hook by which
  // an in-pane /clear becomes followable: without an fd-probe hit
  // the fingerprint fallback will reject the new (unknown) sessionId
  // and the user must re-adopt to recover.
  bridgeProbeOpenSessionIds();
  // Pid-resolver: catches *spawn-time* rotations (new Claude PID → new
  // pid file → new sessionId), e.g. daemon restart that re-issues
  // `--resume <id>` and Claude rotates the internal id.
  const pidFollow = maybeFollowSessionRotationViaPid();
  // Fingerprint fallback: catches *in-process* rotations Claude makes
  // via /clear or /resume from the user's pane. Empirically (verified
  // on Claude Code 2.1.123) the pid file's `sessionId` field is set
  // ONCE at process start; /clear refreshes `updatedAt` but does NOT
  // rewrite `sessionId`, so pid resolver returning 'same' is NOT proof
  // that no rotation happened. We skip the fingerprint scan only when
  // pid resolver actively switched the path — in that case the
  // authoritative source already moved us, and running fingerprint on
  // top would risk a redundant flip. Sibling-pane hijack protection is
  // NOT delegated to the markTimeMs-5s event filter (short fingerprints
  // substring-match unrelated content like "test" → "run tests"); the
  // real gate is the sibling guard inside `maybeSwitchBridgeJsonl` that
  // rejects every candidate whose sessionId isn't in the pid-derived
  // trust set.
  let switched = pidFollow === 'switched';
  if (!switched) {
    switched = maybeSwitchBridgeJsonl();
  }
  // Quiet-rotation fallback: directory-mtime heuristic that picks the
  // newest jsonl in the same project dir when our current path goes
  // quiet. Originally the safety net for "user runs /clear purely in
  // iTerm with no pending Lark turn, so fingerprint fallback can't
  // anchor on anything". Trade-off: when the user has a SIBLING Claude
  // pane in the same cwd, that pane's busier jsonl always wins this
  // race and the bridge gets hijacked, ingesting the sibling pane's
  // user/assistant events as `isLocal: true` local turns and forwarding
  // them to the adopted Lark thread (the user-reported "/adopt 一对话
  // 出来一堆历史会话" symptom).
  //
  // We accept the asymmetry: sibling-pane hijack is silent, persistent
  // and corrupts every adopted multi-pane setup; pure-local /clear
  // without a pending Lark turn is a narrow corner case the user can
  // unstick by sending one Lark message (which arms fingerprint
  // fallback). So we ONLY consult the mtime heuristic when the pid
  // probe was unavailable (non-Linux, missing/invalid pid file).
  if (shouldRunQuietRotation(pidFollow, switched)) {
    maybeFollowQuietRotation();
  }
  if (!bridgeJsonlPath) return;
  if (!bridgeBaselineDone) {
    // Lazy baseline: file didn't exist at attach, baseline the moment it does.
    if (!existsSyncSafe(bridgeJsonlPath)) return;
    bridgeAbsorbBaseline();
    return;
  }
  const result = drainTranscript(bridgeJsonlPath, bridgeOffset);
  bridgeOffset = result.newOffset;
  bridgePendingTail = result.pendingTail;
  if (result.events.length > 0) lastStructuredBridgeActivityAtMs = Date.now();
  bridgeQueue.ingest(result.events, bridgeJsonlPath);
}

function performBridgeIngestAndScheduleQuietEmit(): void {
  const beforePath = bridgeJsonlPath;
  const beforeOffset = bridgeOffset;
  bridgeIngest();
  if (bridgeJsonlPath && (bridgeJsonlPath !== beforePath || bridgeOffset > beforeOffset)) {
    scheduleHerdrAdoptBridgeQuietEmit();
  }
}

function startBridgeWatcher(jsonlPath: string, opts?: { cliPid?: number; cliCwd?: string; mode?: 'baseline-existing' | 'fresh-empty'; dataDir?: string }): void {
  bridgeJsonlPath = jsonlPath;
  bridgeJsonlDir = dirname(jsonlPath);
  bridgeCliPid = opts?.cliPid;
  bridgeCliCwd = opts?.cliCwd;
  bridgeDataDir = opts?.dataDir ?? DEFAULT_CLAUDE_DATA_DIR;
  const mode = opts?.mode ?? 'baseline-existing';
  // Pid-state record ranks above the path the adopt scan computed. If
  // Claude was launched with `--resume` (or the adopt scan picked a
  // stale jsonl), the pid file points at the actual current sessionId
  // and we swap to it before baseline so we don't waste a baseline on
  // a frozen file.
  if (bridgeCliPid && bridgeCliCwd) {
    const resolved = resolveJsonlFromPid(bridgeCliPid, bridgeCliCwd, bridgeDataDir);
    if (resolved) {
      bridgeObservedCliSessionId = resolved.cliSessionId;
      bridgeRememberSessionIdForPath(resolved.path);
      if (resolved.path !== bridgeJsonlPath) {
        log(`Bridge transcript adjusted at start (pid resolver): ${bridgeJsonlPath} → ${resolved.path}`);
        bridgeJsonlPath = resolved.path;
        bridgeJsonlDir = dirname(resolved.path);
      }
    }
  }
  // fd probe at start: the pid file's `sessionId` is set ONCE at Claude's
  // process start and is NOT refreshed by in-pane `/clear`. So if the user
  // /clear'd between the original /adopt and this worker spawn (most
  // commonly: daemon restart that restored a long-lived adopt session),
  // pid resolver still points at the spawn-time jsonl while Claude has
  // rotated to a new one. `/proc/<pid>/fd` shows what Claude *currently*
  // has open — bound to our pid, so no sibling-pane hijack risk.
  //
  // Two signals matter: direct `.jsonl` fd (only present during a write
  // window — Claude opens-writes-closes per event) and `~/.claude/tasks/
  // <sid>` symlinks (Claude holds the tasks dir + its .lock file open
  // continuously for the active session, so this catches the rotation
  // even between writes). `findOpenClaudeSessionIds` unions both.
  if (bridgeCliPid !== undefined && bridgeJsonlDir && bridgeCliCwd) {
    const sids = findOpenClaudeSessionIds(bridgeCliPid, bridgeDataDir);
    const candidates: string[] = [];
    for (const sid of sids) {
      const path = claudeJsonlPathForSession(sid, bridgeCliCwd, bridgeDataDir);
      bridgeRememberSessionIdForPath(path);
      if (existsSyncSafe(path)) candidates.push(path);
    }
    if (candidates.length > 0) {
      const newest = newestPath(candidates);
      if (newest && newest !== bridgeJsonlPath) {
        log(`Bridge transcript adjusted at start (pid fd probe — Claude rotated since worker spawn): ${bridgeJsonlPath} → ${newest}`);
        bridgeJsonlPath = newest;
        bridgeJsonlDir = dirname(newest);
        // Pid file's sessionId disagrees with the path Claude actually has
        // open — record it as stale so the per-tick pid resolver doesn't
        // pull us back to the spawn-time jsonl on every poll.
        bridgeMarkStalePidStateForAcceptedSid(sessionIdFromJsonlPath(newest));
      }
    }
  }
  // Remember the initial path's sessionId — this is the ground-truth
  // anchor for the sibling-pane hijack guard. Subsequent fingerprint
  // candidates are accepted only if their sessionId is in this set
  // (populated here, by pid resolver hits, and by per-tick fd probes).
  bridgeRememberSessionIdForPath(bridgeJsonlPath);
  if (mode === 'fresh-empty') {
    // Non-adopt fallback: brand-new session, jsonl gets created on the first
    // user submit. We must NOT lazy-absorb the file when it appears — that
    // would treat the first turn's user/assistant events as history and the
    // worker would never emit a final_output for them. Instead declare
    // baseline=done with offset=0 up front: the very first events drained
    // from the file are eligible for attribution against pending Lark turns.
    bridgeOffset = 0;
    bridgePendingTail = '';
    bridgeBaselineDone = true;
    log(`Bridge fresh-empty mode: ${bridgeJsonlPath} (waiting for file to appear; no baseline absorb)`);
  } else if (existsSyncSafe(bridgeJsonlPath)) {
    bridgeAbsorbBaseline();
    log(`Bridge baselined: ${bridgeJsonlPath} (offset=${bridgeOffset})`);
  } else {
    log(`Bridge transcript not yet present at ${bridgeJsonlPath}; will baseline on first appearance`);
  }
  // fs.watch is best-effort wakeup — actual data source is the byte offset.
  // The fallback poller covers fs.watch's gaps (NFS, rename-rotation, etc.)
  // and also drives lazy baseline when the file shows up after attach.
  try {
    bridgeWatcher = fsWatch(bridgeJsonlPath, { persistent: false }, () => {
      try { performBridgeIngestAndScheduleQuietEmit(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable (${err.message}); relying on fallback poller`);
  }
  bridgeFallbackTimer = setInterval(() => {
    try { performBridgeIngestAndScheduleQuietEmit(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
  }, 1000);
}

function stopBridgeWatcher(): void {
  clearHerdrAdoptBridgeQuietTimer();
  if (bridgeWatcher) {
    try { bridgeWatcher.close(); } catch { /* ignore */ }
    bridgeWatcher = null;
  }
  if (bridgeFallbackTimer) {
    clearInterval(bridgeFallbackTimer);
    bridgeFallbackTimer = null;
  }
  bridgeCliPid = undefined;
  bridgeCliCwd = undefined;
  bridgeObservedCliSessionId = undefined;
  bridgeKnownSessionIds.clear();
  bridgeStalePidStateSessionId = undefined;
  bridgeSecondaryPaths.clear();
  bridgeFingerprintScanLastMs.clear();
  bridgePreambleSent = false;
}

/**
 * Push a pending turn for the next Lark message.
 *
 * Returns the turnId on success, undefined if bridge-final-output isn't
 * available for this message (transcript not yet baselined). On undefined
 * the worker still raw-writes the message into the pane — the user just
 * won't get a transcript-driven final_output reply for it. This keeps the
 * v3 promise: if we can't attribute correctly, we don't attribute at all.
 *
 * `messageText` is the raw Lark message body — we derive a short content
 * fingerprint from it so the next *matching* user event in the transcript
 * (and only that one) starts this turn. Local-terminal input that races
 * with the pane-write will not match the fingerprint and won't hijack the
 * Lark turn.
 *
 * The turnId is returned so the writeInput failure path can call
 * `bridgeQueue.dropPendingTurn(turnId)` after deferred recheck conclusively
 * fails — otherwise an Enter-eaten-by-TUI submit leaves a fingerprint that
 * no jsonl line will ever match, and `maybeSwitchBridgeJsonl` burns 99%
 * CPU scanning all sibling jsonls for it on every poll tick.
 */
function bridgeMarkPendingTurn(messageText: string, preferredTurnId?: string): string | undefined {
  if (!bridgeJsonlPath) return undefined;
  if (!bridgeBaselineDone) {
    // Self-heal a stuck baseline: the guessed transcript path never
    // materialised (Claude wrote under a different sessionId, a stale resume
    // id, or an /adopt sid persisted as the botmux sid). An absent file has
    // no history to absorb, so arm fresh-empty readiness so THIS turn gets
    // marked — the mark arms the per-tick exact-content fingerprint recovery,
    // which finds the jsonl Claude actually wrote this message to and switches
    // the bridge onto it (no dependence on Claude-internal pid files, so
    // version-robust). See shouldHealAbsentBaseline for the full rationale.
    if (shouldHealAbsentBaseline({
      baselineDone: bridgeBaselineDone,
      hasJsonlPath: !!bridgeJsonlPath,
      jsonlFileExists: existsSyncSafe(bridgeJsonlPath),
    })) {
      bridgeOffset = 0;
      bridgePendingTail = '';
      bridgeBaselineDone = true;
      log(`Bridge baseline self-healed: guessed transcript ${bridgeJsonlPath} absent; fresh-empty readiness armed for fingerprint recovery`);
    } else {
      log('Bridge baseline not ready — this turn will not have transcript-driven final_output');
      return undefined;
    }
  }
  const fingerprint = makeFingerprint(messageText);
  // Full normalised content powers the unknown-sid recovery path. When a
  // user runs `/clear` and the bridge can't see the new sessionId yet
  // (pid file lags, fd probe missed the brief open window), we fall back
  // to scanning every untrusted candidate jsonl for an EXACT equality
  // with this normalised string — substantially harder for a sibling
  // pane to false-match than the 30-char substring fingerprint.
  const normalised = normaliseForFingerprint(messageText);
  const contentNormalized = normalised.length > 0 ? normalised : undefined;
  const turnId = preferredTurnId ?? randomBytes(8).toString('hex');
  bridgeQueue.mark(turnId, fingerprint, Date.now(), contentNormalized);
  return turnId;
}

function bridgeDrainAndMaybeEmit(): void {
  if (!bridgeJsonlPath) return;
  bridgeIngest();
  emitReadyTurns();
  // Prune AFTER emit so a path is only retired once its turn has actually
  // been published. During non-idle ticks (fs.watch / 1s poll) we never
  // emit, so we never prune — the path stays put until idle resolves it.
  pruneSecondaryPaths();
}

/** Pop ready turns and emit their final_output. Resolves uuid → text via
 *  each turn's own `sourceJsonlPath` (stamped at turn-start) so an in-flight
 *  reply that started in an old jsonl still gets picked up after a sessionId
 *  rotation has switched the global `bridgeJsonlPath` to a different file.
 *  Falls back to `bridgeJsonlPath` for legacy turns without a stamped source.
 *
 *  Caches per-path drains so a batch of turns from the same file only reads
 *  the transcript once (O(jsonl size) per distinct path). */
function emitReadyTurns(): void {
  const ready = bridgeQueue.drainEmittable();
  if (ready.length === 0) return;
  const adoptMode = lastInitConfig?.adoptMode === true;
  // Send markers (`botmux send` landed in own thread) + the queue's first
  // still-unready turn. The latter caps the LAST ready turn's window —
  // without it, a model that's still mid-tool-use for turn N+1 could leak
  // a send credit into turn N's window via shouldSuppressBridgeEmit.
  const markers = adoptMode ? [] : readSendMarkers();
  const remainingPending = bridgeQueue.peek();
  const nextPendingMarkTimeMs = remainingPending.length > 0 ? remainingPending[0].markTimeMs : undefined;
  const cache = new Map<string, ReturnType<typeof drainTranscript>>();
  for (let i = 0; i < ready.length; i++) {
    const turn = ready[i];
    const nextBoundaryMs = (i + 1 < ready.length ? ready[i + 1].markTimeMs : nextPendingMarkTimeMs);
    if (turn.isLocal && shouldSuppressBridgeEmit({ markTimeMs: turn.markTimeMs, isLocal: turn.isLocal }, nextBoundaryMs, markers, adoptMode)) {
      const reason = turn.isLocal ? 'local-typed' : 'model called botmux send within window';
      log(`Bridge fallback suppressed for turn ${turn.turnId.substring(0, 8)} (${reason})`);
      continue;
    }

    const path = turn.sourceJsonlPath ?? bridgeJsonlPath;
    if (!path) continue;
    let drained = cache.get(path);
    if (!drained) {
      drained = drainTranscript(path, 0);
      cache.set(path, drained);
    }
    const set = new Set(turn.assistantUuids);
    const matched = drained.events.filter(e => e.uuid && set.has(e.uuid));
    // Non-adopt fallback posts the turn's FINAL answer (text after the last
    // tool_use), not the whole-turn narration collage — joining every interim
    // block both reads as noise in Lark and inflates finalText past the
    // material-longer gate, re-posting turns the model already `botmux send`ed.
    // Adopt keeps the full join: transcript drain is that mode's only channel,
    // so interim narration is the user's only window into the turn.
    const assistantText = adoptMode ? joinAssistantText(matched) : trailingAssistantText(drained.events, turn.assistantUuids);
    if (assistantText.length === 0) continue;
    const lastUuid = turn.assistantUuids[turn.assistantUuids.length - 1];

    if (shouldSuppressBridgeEmit({ markTimeMs: turn.markTimeMs, isLocal: turn.isLocal, finalText: assistantText }, nextBoundaryMs, markers, adoptMode)) {
      const reason = turn.isLocal ? 'local-typed' : 'model called botmux send within window';
      log(`Bridge fallback suppressed for turn ${turn.turnId.substring(0, 8)} (${reason})`);
      continue;
    }

    if (turn.isLocal) {
      if (turn.userUuid) {
        // Local turn (adopt mode only): also surface the user prompt so the
        // Lark thread shows both sides of the exchange. User text comes from
        // the same drained transcript via the userUuid stamped at start time.
        // extractTurnStartText handles both `role:user` events (text in
        // message.content) AND `attachment(queued_command)` events (text in
        // attachment.prompt) so type-ahead'd local input renders the same as
        // a normally-typed pane prompt.
        const userEv = drained.events.find(e => e.uuid === turn.userUuid);
        const rawUserText = userEv ? extractTurnStartText(userEv) : '';
        const fields = formatLocalTurnFields(rawUserText, assistantText);
        if (!fields) continue;
        send({
          type: 'final_output',
          content: fields.content,
          lastUuid,
          turnId: turn.turnId,
          kind: 'local-turn',
          userText: fields.userText,
        });
        continue;
      }
      // Headless local turn — see formatHeadlessLocalTurnContent for context.
      const headlessContent = formatHeadlessLocalTurnContent(assistantText);
      if (!headlessContent) continue;
      send({
        type: 'final_output',
        content: headlessContent,
        lastUuid,
        turnId: turn.turnId,
        kind: 'local-turn-headless',
      });
      continue;
    }

    send({ type: 'final_output', content: assistantText, lastUuid, turnId: turn.turnId });
  }
}

/** Drain `path` from `fromOffset` and feed the events to the bridge queue
 *  with that path as the source stamp. Pure side-effects on bridgeQueue +
 *  the returned cursor; does NOT touch bridgeJsonlPath / bridgeOffset, so
 *  callers can use it to flush the old path during a rotation without
 *  disturbing the watcher's normal cursor. Returns the new offset for the
 *  caller to commit (or discard, if it's about to switch paths). */
function drainPathInto(path: string, fromOffset: number): { offset: number; tail: string } {
  const result = drainTranscript(path, fromOffset);
  bridgeQueue.ingest(result.events, path);
  return { offset: result.newOffset, tail: result.pendingTail };
}

// ─── Codex bridge wiring ─────────────────────────────────────────────────
//
// Codex's bridge fallback is intentionally simpler than Claude's: no /adopt
// surface, no pid-resolver / quiet-rotation / fingerprint-jsonl-switch
// machinery. The reader watches one rollout file (located by cliSessionId)
// and the queue's only responsibility is "user fingerprint match → start;
// assistant_final → close". Everything else (mark / emit gate / send
// marker IO / type-ahead serialisation / one-write-per-idle break) is
// shared with the Claude path.

function codexBridgeFallbackActive(): boolean {
  // True for transcript-backed CLIs whose final output can be harvested
  // when the model forgets to call `botmux send`.
  const id = lastInitConfig?.cliId;
  if (id === 'codex' || id === 'traex' || id === 'coco' || id === 'hermes' || id === 'mtr' || id === 'pi') return true;
  // Cursor only harvests its transcript in adopt mode: a botmux-spawned
  // cursor session carries the botmux skill and replies via `botmux send`,
  // and we never resolve a transcript path for it — so leave that flow
  // (screen capture + botmux send) untouched and scope the bridge to adopt.
  if (id === 'cursor') return lastInitConfig?.adoptMode === true;
  return false;
}

// Both Codex and TRAE share the same rollout JSONL layout (response_item
// messages), so drainCodexRollout works for both.
function structuredBridgeIsCodex(): boolean {
  return lastInitConfig?.cliId === 'codex' || lastInitConfig?.cliId === 'traex';
}

function structuredBridgeIsHermes(): boolean {
  return lastInitConfig?.cliId === 'hermes';
}

function structuredBridgeIsMtr(): boolean {
  return lastInitConfig?.cliId === 'mtr';
}

function structuredBridgeIsPi(): boolean {
  return lastInitConfig?.cliId === 'pi';
}

function codexBridgeIsCursor(): boolean {
  return lastInitConfig?.cliId === 'cursor';
}

function structuredBridgeIngestPath(path: string, offset: number) {
  if (structuredBridgeIsCodex()) return drainCodexRollout(path, offset);
  if (codexBridgeIsCursor()) return drainCursorTranscript(path, offset);
  if (structuredBridgeIsPi()) return drainPiTranscript(path, offset);
  if (structuredBridgeIsHermes()) {
    const result = drainHermesStateDb(offset);
    return { events: result.events, newOffset: result.newOffset, pendingTail: '' };
  }
  return drainCocoEvents(path, offset);
}

function codexBridgeStartTimer(): void {
  if (codexBridgeTimer) return;
  // Single 1s ticker that handles three jobs: late-attach (poll for the
  // rollout file once we know cliSessionId), ingest (fs.watch backup),
  // and idle-window emit. The last is critical for the late-attach race:
  // if the rollout path appears AFTER the CLI's idle event has fired,
  // the idle callback's emit already ran (and saw an empty queue), so
  // the next emit chance would be at the next idle — i.e. the user has
  // to send another message before the previous turn's fallback shows
  // up. Emitting here when isPromptReady=true closes that window.
  // Codex's queue only releases turns on `assistant_final` (the model's
  // declared end-of-turn), so a tick-driven emit can't accidentally
  // publish a half-streamed response.
  codexBridgeTimer = setInterval(() => {
    try {
      if (structuredBridgeIsHermes()) {
        // Use lastSpawnEffectiveResume (written by spawnCli AFTER the
        // two-tier fallback), NOT lastInitConfig.resume. Otherwise a
        // Tier-1/Tier-2 demotion to fresh would still baseline the empty
        // hermes store as "existing" and swallow the first turn.
        if (!hermesBridgeBaselineDone) hermesBridgeAttach(lastSpawnEffectiveResume ? 'baseline-existing' : 'fresh-empty');
        hermesBridgeIngest();
        if (isPromptReady) emitReadyCodexTurns();
        return;
      }
      if (structuredBridgeIsMtr()) {
        if (!mtrBridgeSource) {
          const source =
            findMtrSessionById(codexBridgePendingSessionId)
            ?? (lastInitConfig?.adoptMode
              ? findLatestMtrSessionByDirectory(lastInitConfig.adoptCwd ?? lastInitConfig.workingDir)
              : undefined);
          if (source) {
            codexBridgePendingSessionId = undefined;
            codexAdoptPendingPid = undefined;
            mtrBridgeAttach(source, lastInitConfig?.adoptMode ? 'split-live' : 'fresh-empty');
          }
        }
        mtrBridgeIngest();
        if (isPromptReady) emitReadyCodexTurns();
        return;
      }
      if (codexBridgeIsCursor()) {
        // Late-attach: the transcript usually exists at adopt time (the
        // session is already running), so cursorBridgeAttach in setup wins.
        // This covers the rare race where pid→chatId resolved but the JSONL
        // hadn't been created yet. Resolution order: chatId (cliSessionId) →
        // path; then adopt pid → store.db fd → chatId → path.
        if (!codexBridgeRolloutPath) {
          let path = codexBridgePendingSessionId
            ? findCursorTranscriptByChatId(codexBridgePendingSessionId)
            : undefined;
          if (!path && codexAdoptPendingPid) {
            path = findCursorTranscriptByPid(codexAdoptPendingPid)?.path;
          }
          if (path) {
            codexBridgePendingSessionId = undefined;
            codexAdoptPendingPid = undefined;
            cursorBridgeAttach(path, cursorLateAttachMode(path));
          }
        }
        codexBridgeIngest();
        if (isPromptReady) emitReadyCodexTurns();
        return;
      }
      if (!codexBridgeRolloutPath) {
        // Two discovery paths, in order: cliSessionId (known via writeInput
        // result for non-adopt or daemon-side probe for adopt) → exact
        // file by name; PID (adopt only) → walk /proc/<pid>/fd. Adopt
        // attaches via split-live (history absorbed, live ingested);
        // non-adopt uses fresh-empty (queue's markTimeMs - 5s lower bound
        // gates historical fingerprint matches without needing a split).
        // Discovery primitives differ per CLI: codex walks ~/.codex/sessions
        // by sid suffix; CoCo's events.jsonl path is deterministic from
        // sid, so the lookup is just a path computation + existence check.
        const isCoco = lastInitConfig?.cliId === 'coco';
        const isTraex = lastInitConfig?.cliId === 'traex';
        const isPi = lastInitConfig?.cliId === 'pi';
        let path: string | undefined;
        if (codexBridgePendingSessionId) {
          if (isCoco) {
            path = cocoEventsPathForSession(codexBridgePendingSessionId);
            if (path && !existsSync(path)) path = undefined;
          } else if (isPi) {
            path = findPiTranscriptBySessionId(codexBridgePendingSessionId, lastInitConfig?.workingDir);
          } else if (isTraex) {
            path = findTraexRolloutBySessionId(codexBridgePendingSessionId);
          } else {
            path = findCodexRolloutBySessionId(codexBridgePendingSessionId);
          }
        }
        if (!path && codexAdoptPendingPid) {
          if (isCoco) {
            const probed = findCocoSessionByPid(codexAdoptPendingPid);
            if (probed && existsSync(probed.eventsPath)) path = probed.eventsPath;
          } else if (isPi) {
            const probed = findPiTranscriptByPid(codexAdoptPendingPid);
            if (probed) path = probed.path;
          } else if (isTraex) {
            const probed = findTraexRolloutByPid(codexAdoptPendingPid);
            if (probed) path = probed.path;
          } else {
            const probed = findCodexRolloutByPid(codexAdoptPendingPid);
            if (probed) path = probed.path;
          }
        }
        if (path) {
          codexBridgePendingSessionId = undefined;
          codexAdoptPendingPid = undefined;
          // Adopt mode: split-live partitions drained events by
          // codexAdoptStartMs so anything the user did AFTER adopt but
          // BEFORE we found the rollout still emits (history is absorbed,
          // live is ingested). Non-adopt: fresh-empty as before — queue's
          // markTimeMs - 5s lower bound is enough since there's no
          // local-turn synthesis on that path.
          const mode = lastInitConfig?.adoptMode ? 'split-live' : 'fresh-empty';
          codexBridgeAttach(path, mode);
        }
      }
      codexBridgeIngest();
      if (isPromptReady) emitReadyCodexTurns();
    } catch (err: any) {
      log(`Codex bridge tick error: ${err.message}`);
    }
  }, 1000);
}

function hermesBridgeAttach(mode: 'baseline-existing' | 'fresh-empty'): void {
  hermesBridgeOffset = currentHermesStateOffset();
  hermesBridgeBaselineDone = true;
  log(`Hermes bridge ${mode}: state.db offset=${hermesBridgeOffset}`);
  codexBridgeStartTimer();
}

function hermesBridgeIngest(): void {
  if (!hermesBridgeBaselineDone) return;
  const result = drainHermesStateDb(hermesBridgeOffset);
  hermesBridgeOffset = result.newOffset;
  if (result.events.length > 0) lastStructuredBridgeActivityAtMs = Date.now();
  codexBridgeQueue.ingest(result.events);
  if (result.events.some(e => e.kind === 'assistant_final')) {
    idleDetector?.fireIdle();
  }
}

function mtrBridgeAttach(source: MtrTranscriptSource, mode: 'baseline-existing' | 'fresh-empty' | 'split-live'): void {
  mtrBridgeSource = source;
  if (mode === 'split-live') {
    const result = drainMtrSession(source, 0);
    const cutoff = (codexAdoptStartMs ?? Date.now()) - 5_000;
    const { history, live } = splitCodexEventsByCutoff(result.events, cutoff);
    codexBridgeQueue.absorb(history);
    codexBridgeQueue.ingest(live);
    mtrBridgeOffset = result.newOffset;
    mtrBridgeBaselineDone = true;
    log(`MTR bridge split-live: ${source.dbPath}#${source.sessionId} (history=${history.length}, live=${live.length}, cutoff=${cutoff}, offset=${mtrBridgeOffset})`);
    maybeEmitCodexAdoptPreamble(history);
  } else if (mode === 'baseline-existing') {
    const baseline = currentMtrSessionOffset(source);
    const result = drainMtrSession(source, baseline);
    codexBridgeQueue.absorb(result.events);
    mtrBridgeOffset = Math.max(baseline, result.newOffset);
    mtrBridgeBaselineDone = true;
    log(`MTR bridge baselined: ${source.dbPath}#${source.sessionId} (offset=${mtrBridgeOffset}, absorbed=${result.events.length})`);
  } else {
    mtrBridgeOffset = 0;
    mtrBridgeBaselineDone = true;
    log(`MTR bridge fresh-empty: ${source.dbPath}#${source.sessionId}`);
  }
  codexBridgeStartTimer();
}

function mtrBridgeIngest(): void {
  if (!mtrBridgeBaselineDone || !mtrBridgeSource) return;
  const result = drainMtrSession(mtrBridgeSource, mtrBridgeOffset);
  mtrBridgeOffset = result.newOffset;
  if (result.events.length > 0) lastStructuredBridgeActivityAtMs = Date.now();
  codexBridgeQueue.ingest(result.events);
  if (result.events.some(e => e.kind === 'assistant_final')) {
    idleDetector?.fireIdle();
  }
}

function codexBridgeAttach(rolloutPath: string, mode: 'baseline-existing' | 'baseline-existing-skip-tail' | 'fresh-empty' | 'split-live'): void {
  codexBridgeRolloutPath = rolloutPath;
  if (mode === 'fresh-empty') {
    // Brand-new session OR late-attach right after first submit. Either
    // way we want to ingest from offset 0 — pending turns marked before
    // attach are still in the queue, so the user_message that just landed
    // (or is about to land) will fingerprint-match them.
    codexBridgeOffset = 0;
    codexBridgePendingTail = '';
    codexBridgeBaselineDone = true;
    log(`Codex bridge fresh-empty: ${rolloutPath}`);
  } else if (mode === 'split-live' && existsSync(rolloutPath)) {
    // Adopt mode: drain everything, then split by adoptStartMs. History
    // (pre-adopt) is `absorb()`-ed so it can't replay; live (post-adopt)
    // is `ingest()`-ed so a Lark turn already marked or an iTerm-typed
    // local turn that landed before we found the rollout still gets
    // attributed. Without this split, baseline-existing would absorb()
    // the live events too, silently dropping anything the user did
    // between adopt and rollout-discovery — that's the user-reported
    // "iTerm 手动输入飞书没收到" symptom under late-attach.
    const result = structuredBridgeIngestPath(rolloutPath, 0);
    const cutoff = (codexAdoptStartMs ?? Date.now()) - 5_000;
    const { history, live } = splitCodexEventsByCutoff(result.events, cutoff);
    codexBridgeQueue.absorb(history);
    codexBridgeQueue.ingest(live);
    codexBridgeOffset = result.newOffset;
    codexBridgePendingTail = result.pendingTail;
    codexBridgeBaselineDone = true;
    log(`Codex bridge split-live: ${rolloutPath} (history=${history.length}, live=${live.length}, cutoff=${cutoff}, offset=${codexBridgeOffset})`);
    maybeEmitCodexAdoptPreamble(history);
  } else if (mode === 'split-live') {
    // split-live requested but file missing — degrade to fresh: the file
    // will appear later via fs.watch / poller, and ingest from offset 0
    // will pick up everything as live (consistent with split semantics
    // when there's no history to absorb).
    codexBridgeOffset = 0;
    codexBridgePendingTail = '';
    codexBridgeBaselineDone = true;
    log(`Codex bridge split-live degraded to fresh (file missing): ${rolloutPath}`);
  } else if (mode === 'baseline-existing-skip-tail' && existsSync(rolloutPath)) {
    let size = 0;
    try { size = statSync(rolloutPath).size; } catch { /* degrade below */ }
    codexBridgeOffset = size;
    codexBridgePendingTail = '';
    codexBridgeBaselineDone = true;
    log(`Codex bridge baselined: ${rolloutPath} (offset=${codexBridgeOffset}, skipTail=true)`);
  } else if (existsSync(rolloutPath)) {
    const cursor = baselineJsonlCursor(rolloutPath);
    codexBridgeOffset = cursor.newOffset;
    codexBridgePendingTail = cursor.pendingTail;
    codexBridgeBaselineDone = true;
    log(`Codex bridge baselined: ${rolloutPath} (offset=${codexBridgeOffset})`);
  } else {
    // baseline-existing requested but file missing — degrade to fresh
    // semantics so the lazy-appearing file isn't accidentally absorbed.
    codexBridgeOffset = 0;
    codexBridgePendingTail = '';
    codexBridgeBaselineDone = true;
    log(`Codex bridge transcript not yet present at ${rolloutPath}; treating as fresh`);
  }
  try {
    codexBridgeWatcher = fsWatch(rolloutPath, { persistent: false }, () => {
      try { codexBridgeIngest(); } catch (err: any) { log(`Codex bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Codex bridge fs.watch unavailable (${err.message}); relying on poller`);
  }
  // macOS 上 fs.watch 对 codex/coco 的外部进程追加 rollout / events.jsonl
  // 经常静默丢事件（FSEvents 跨进程不可靠），所以无论 watcher 是否 attach
  // 成功，都必须起 1s poller 兜底 —— 不然 split-live 成功的 adopt session
  // 在 macOS 上会卡死，永远收不到模型回复。Linux 上 poller 多 tick 也无害
  // （codexBridgeIngest 在 offset 未推进时是 no-op）。
  codexBridgeStartTimer();
}

type CursorAttachMode = 'baseline-existing' | 'fresh-empty';

function cursorLateAttachMode(path: string): CursorAttachMode {
  const start = codexAdoptStartMs;
  if (start !== undefined) {
    try {
      const birthtimeMs = statSync(path).birthtimeMs;
      // Cursor often creates the agent-transcript file lazily on the first
      // post-adopt submit. In that case the first user line is live and must
      // be ingested from byte 0 rather than swallowed as history.
      if (Number.isFinite(birthtimeMs) && birthtimeMs >= start - 5_000) return 'fresh-empty';
    } catch { /* fall back to history-safe baseline */ }
  }
  return 'baseline-existing';
}

/** Attach the Cursor adopt bridge. Cursor's JSONL has no per-event
 *  timestamp, so existing transcripts are baselined by byte offset. Cursor
 *  restore intentionally skips any partial tail present at attach time: it is
 *  old in-flight output and must not be attributed to the next Lark turn. If
 *  the transcript is created after /adopt, attach fresh so the first
 *  post-adopt Lark/user turn can still be attributed. */
function cursorBridgeAttach(path: string, mode: CursorAttachMode = 'baseline-existing'): void {
  if (mode === 'baseline-existing' && existsSync(path)) {
    try {
      const full = drainCursorTranscript(path, 0);
      maybeEmitCodexAdoptPreamble(full.events);
    } catch (err: any) {
      log(`Cursor bridge preamble drain failed: ${err.message}`);
    }
  }
  codexBridgeAttach(path, mode === 'baseline-existing' ? 'baseline-existing-skip-tail' : mode);
}

/** Called from flushPending after writeInput first returns a cliSessionId.
 *  Tries to locate the rollout file immediately; if it's not on disk yet,
 *  remembers the sid so the 1s poller can keep retrying. */
function codexBridgeNotifyCliSessionId(cliSessionId: string): void {
  if (!codexBridgeFallbackActive() || codexBridgeRolloutPath) return;
  if (structuredBridgeIsMtr()) {
    const source = findMtrSessionById(cliSessionId);
    if (source) {
      codexBridgePendingSessionId = undefined;
      mtrBridgeAttach(source, 'fresh-empty');
    } else {
      codexBridgePendingSessionId = cliSessionId;
      codexBridgeStartTimer();
    }
    return;
  }
  if (codexBridgeIsCursor()) {
    // Cursor's cliSessionId is the chatId — the same UUID naming the
    // agent-transcript JSONL, so it resolves the path directly.
    const cursorPath = findCursorTranscriptByChatId(cliSessionId);
    if (cursorPath) {
      codexBridgePendingSessionId = undefined;
      cursorBridgeAttach(cursorPath, cursorLateAttachMode(cursorPath));
    } else {
      codexBridgePendingSessionId = cliSessionId;
      codexBridgeStartTimer();
    }
    return;
  }
  const path = lastInitConfig?.cliId === 'traex'
    ? findTraexRolloutBySessionId(cliSessionId)
    : lastInitConfig?.cliId === 'pi'
      ? findPiTranscriptBySessionId(cliSessionId, lastInitConfig?.workingDir)
      : findCodexRolloutBySessionId(cliSessionId);
  if (path) {
    codexBridgePendingSessionId = undefined;
    codexBridgeAttach(path, 'fresh-empty');
  } else {
    codexBridgePendingSessionId = cliSessionId;
    codexBridgeStartTimer();
  }
}

function codexBridgeIngest(): void {
  if (structuredBridgeIsHermes()) {
    hermesBridgeIngest();
    return;
  }
  if (structuredBridgeIsMtr()) {
    mtrBridgeIngest();
    return;
  }
  if (!codexBridgeRolloutPath || !codexBridgeBaselineDone) return;
  const result = structuredBridgeIngestPath(codexBridgeRolloutPath, codexBridgeOffset);
  codexBridgeOffset = result.newOffset;
  codexBridgePendingTail = result.pendingTail;
  if (result.events.length > 0) lastStructuredBridgeActivityAtMs = Date.now();
  codexBridgeQueue.ingest(result.events);
  // Transcript-driven idle: an `assistant_final` event is the CLI declaring
  // end-of-turn, far more reliable than the screen-pattern heuristic
  // (CoCo's status bar varies by --yolo flag, version, theme; codex has
  // its own moving targets). Pushing idle here lets the bridge emit
  // immediately instead of waiting for readyPattern + quiescence to
  // converge. Idempotent — IdleDetector.fireIdle no-ops while already idle.
  if (result.events.some(e => e.kind === 'assistant_final')) {
    idleDetector?.fireIdle();
  }
}

/** Mark a pending Lark turn for Codex. Crucially this works even before a
 *  rollout path is known — the queue is path-agnostic, and ingest after
 *  late-attach picks up the user_message and matches the fingerprint. */
function codexBridgeMarkPendingTurn(messageText: string, preferredTurnId?: string): boolean {
  if (!codexBridgeFallbackActive()) return false;
  const turnId = preferredTurnId ?? `codex-${randomBytes(8).toString('hex')}`;
  codexBridgeQueue.mark(turnId, messageText);
  return true;
}

function codexBridgeDrainAndMaybeEmit(): void {
  if (!codexBridgeFallbackActive()) return;
  if (structuredBridgeIsHermes() || structuredBridgeIsMtr() || (codexBridgeRolloutPath && codexBridgeBaselineDone)) {
    try { codexBridgeIngest(); } catch (err: any) { log(`Codex bridge ingest error: ${err.message}`); }
  }
  emitReadyCodexTurns();
}

function emitReadyCodexTurns(): void {
  const ready = codexBridgeQueue.drainEmittable();
  if (ready.length === 0) return;
  const adoptMode = lastInitConfig?.adoptMode === true;
  // Adopt mode: model is the user's external Codex, no botmux send to
  // gate against — every assistant turn (Lark-driven OR locally typed)
  // should reach the thread. Skip marker IO entirely.
  const markers = adoptMode ? [] : readSendMarkers();
  const remaining = codexBridgeQueue.peek();
  // Only a STARTED pending turn can bound the last ready turn's send window.
  // An unstarted turn hasn't been dequeued yet (its user event hasn't landed),
  // so it has produced no sends to leak backwards — and under type-ahead its
  // markTimeMs is still the early flush-time mark, which would prematurely
  // (often invalidly, lower>upper) close the ready turn's window and let its
  // own send escape suppression → duplicate. A started-but-not-final turn
  // (model mid-tool-use for N+1) keeps its real overridden markTimeMs as the
  // boundary, preserving the original leak guard.
  const nextPendingMarkTimeMs = remaining.length > 0 && remaining[0].started
    ? remaining[0].markTimeMs
    : undefined;
  for (let i = 0; i < ready.length; i++) {
    const turn = ready[i];
    if (!turn.finalText) continue;
    const nextBoundaryMs = (i + 1 < ready.length ? ready[i + 1].markTimeMs : nextPendingMarkTimeMs);
    if (shouldSuppressBridgeEmit({ markTimeMs: turn.markTimeMs, isLocal: turn.isLocal, finalText: turn.finalText }, nextBoundaryMs, markers, adoptMode)) {
      log(`Codex bridge fallback suppressed for turn ${turn.turnId.substring(0, 8)} (gate)`);
      continue;
    }
    if (turn.isLocal) {
      // Local turn (adopt only): user typed in iTerm. Surface both sides
      // so the Lark thread sees a complete exchange instead of an orphan
      // reply. formatLocalTurnFields caps both texts to keep within
      // Lark's per-message limit; daemon owns the card chrome.
      const fields = formatLocalTurnFields(turn.userText ?? '', turn.finalText);
      if (!fields) continue;
      send({
        type: 'final_output',
        content: fields.content,
        lastUuid: turn.turnId,
        turnId: turn.turnId,
        kind: 'local-turn',
        userText: fields.userText,
      });
      continue;
    }
    send({ type: 'final_output', content: turn.finalText, lastUuid: turn.turnId, turnId: turn.turnId });
  }
}

function stopCodexBridge(): void {
  if (codexBridgeWatcher) {
    try { codexBridgeWatcher.close(); } catch { /* ignore */ }
    codexBridgeWatcher = null;
  }
  if (codexBridgeTimer) {
    clearInterval(codexBridgeTimer);
    codexBridgeTimer = null;
  }
  codexBridgeRolloutPath = undefined;
  codexBridgeOffset = 0;
  codexBridgePendingTail = '';
  codexBridgeBaselineDone = false;
  hermesBridgeOffset = 0;
  hermesBridgeBaselineDone = false;
  mtrBridgeSource = undefined;
  mtrBridgeOffset = 0;
  mtrBridgeBaselineDone = false;
  codexBridgeQueue.clearPending();
  codexBridgeQueue.setLocalTurns(false);
  codexBridgePendingSessionId = undefined;
  codexAdoptPendingPid = undefined;
  codexAdoptStartMs = undefined;
}

/** When a rotation moves bridgeJsonlPath away from `oldPath`, queue turns
 *  whose sourceJsonlPath equals oldPath may still be waiting on assistant
 *  text that hasn't landed yet. Add oldPath to the secondary polling set
 *  so subsequent ingests continue to drain it; the offset is whatever was
 *  reached by the final pre-switch drain so we don't re-scan history. The
 *  entry is later pruned after each idle emit when no started turn
 *  references it anymore. */
function retainSecondaryPathIfStillReferenced(oldPath: string, postDrainOffset: number): void {
  const stillReferenced = bridgeQueue.peek().some(t => t.sourceJsonlPath === oldPath);
  if (!stillReferenced) return;
  const existing = bridgeSecondaryPaths.get(oldPath);
  // Don't rewind a higher existing offset — multiple rotations through
  // the same file shouldn't replay drained bytes.
  if (existing === undefined || postDrainOffset > existing) {
    bridgeSecondaryPaths.set(oldPath, postDrainOffset);
  }
  log(`Bridge retaining secondary path ${oldPath} (offset=${postDrainOffset}) for in-flight turn`);
}

/** Drain every secondary path once. Mirrors bridgeIngest's primary-path
 *  drain but never touches bridgeJsonlPath / bridgeOffset and never
 *  triggers further rotation checks — it's strictly a "catch up trailing
 *  events on an old file" pass. */
function drainSecondaryPaths(): void {
  for (const [path, offset] of bridgeSecondaryPaths) {
    try {
      const result = drainTranscript(path, offset);
      if (result.events.length > 0) bridgeQueue.ingest(result.events, path);
      bridgeSecondaryPaths.set(path, result.newOffset);
    } catch (err: any) {
      log(`Bridge secondary-path drain failed (${path}): ${err.message}`);
    }
  }
}

/** Drop secondary paths whose started turns are no longer in the queue —
 *  i.e. they've been emitted (or discarded). Called after each idle emit so
 *  pruning never races with an in-flight turn. */
function pruneSecondaryPaths(): void {
  if (bridgeSecondaryPaths.size === 0) return;
  const referenced = new Set<string>();
  for (const t of bridgeQueue.peek()) {
    if (t.sourceJsonlPath) referenced.add(t.sourceJsonlPath);
  }
  for (const path of [...bridgeSecondaryPaths.keys()]) {
    if (!referenced.has(path)) {
      bridgeSecondaryPaths.delete(path);
      log(`Bridge dropped secondary path ${path} (no remaining turns)`);
    }
  }
}

/** Tiny safe-existence check that doesn't throw. */
function existsSyncSafe(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}
/** Suppress screen updates until first prompt detected (avoids history replay in card on --resume) */
let awaitingFirstPrompt = true;

// ─── PTY Dimensions ──────────────────────────────────────────────────────────
// Default for botmux-spawned CLIs: narrow enough for the web terminal to
// render comfortably and for the card PNG to fit Lark's typical card width.
// Adopt mode overrides this via resolveRenderDimensions() to match the
// user's actual pane (often 200-270 cols) so the renderer doesn't wrap
// wide ANSI into a stair-stepped / duplicated mess.
const PTY_COLS = DEFAULT_RENDER_COLS;
const PTY_ROWS = DEFAULT_RENDER_ROWS;
/** Set in the `init` handler BEFORE startScreenUpdates() so the headless
 *  xterm + screenshot canvas are sized to the source pane from the start.
 *  Setting them later (after the renderer was built at the default size)
 *  wouldn't retroactively re-size what xterm has already buffered,
 *  leaving the wrap artefacts in place. */
let renderCols = PTY_COLS;
let renderRows = PTY_ROWS;

// ─── Headless Terminal for Screen Capture ────────────────────────────────────

let renderer: TerminalRenderer | null = null;
/** Most recent unfiltered viewport text — kept in sync by the screen_update
 *  timer for pipe-pane backends so ScreenAnalyzer (which is synchronous) has
 *  a fresh snapshot to read without needing its own tmux capture-pane call. */
let lastAnalyzerSnapshot = '';
let screenUpdateTimer: ReturnType<typeof setInterval> | null = null;
const SCREEN_UPDATE_INTERVAL_MS = 2_000;

// ─── Scrollback Buffer (replay to late-connecting WS clients) ───────────────

const MAX_SCROLLBACK = 1_000_000; // chars (~1MB)
let scrollback = '';
const WORKFLOW_TRANSCRIPT_MAX = 2_000_000; // chars (~2MB)
const WORKFLOW_OUTPUT_END_MARKER = '</WORKFLOW_OUTPUT>';
const CRASH_DIAGNOSTIC_RAW_MAX = 200_000; // enough scrollback for the web terminal without huge temp files
const CRASH_LOG_TAIL_MAX = 2_500; // bounded Feishu text payload
let workflowTranscript = '';
let workflowFinalOutputSent = false;
/** Tracks whether the CLI is currently in the alt screen buffer. Updated by
 *  scanning PTY output for DECSET 1049/47/1047 toggles. Used when trimming
 *  scrollback at cap so replay always starts with the correct buffer mode —
 *  otherwise a cap-time slice can drop the alt-buffer-enter and every
 *  subsequent TUI redraw lands in the *normal* buffer, producing the
 *  "scrolling up shows several duplicated screens" bug. */
let altBufferActive = false;
const ALT_ENTER_RE = /\x1b\[\?(1049|1047|47)h/g;
const ALT_EXIT_RE = /\x1b\[\?(1049|1047|47)l/g;

function recentTerminalLogTail(): string | undefined {
  const plain = stripAnsiForLog(tailChars(scrollback, CRASH_DIAGNOSTIC_RAW_MAX));
  if (!plain) return undefined;
  return tailChars(plain, CRASH_LOG_TAIL_MAX);
}

function crashDiagnosticPath(): string | undefined {
  const dataDir = process.env.SESSION_DATA_DIR;
  if (!dataDir || !sessionId) return undefined;
  return join(dataDir, 'crash-diagnostics', `${sessionId}.ansi`);
}

function destroyCrashDiagnosticTerminal(reason: string): void {
  // Leaving the stopped-awaiting-retry state regardless of whether a tmux shell
  // was actually parked (park may have failed); the next retry/close/suspend
  // funnels through here.
  crashDiagnosticStopped = false;
  if (!crashDiagnosticTmuxParked || !sessionId) return;
  try {
    TmuxBackend.killSession(TmuxBackend.diagnosticSessionName(sessionId));
    log(`Crash diagnostic tmux session destroyed (${reason})`);
  } catch (err: any) {
    log(`Crash diagnostic tmux cleanup failed (${reason}): ${err?.message ?? err}`);
  }
  // Best-effort: drop the captured .ansi file too so a long-lived daemon does
  // not accumulate one ~200 KB file per crashed session forever.
  const path = crashDiagnosticPath();
  if (path) { try { unlinkSync(path); } catch { /* already gone — benign */ } }
  crashDiagnosticTmuxParked = false;
}

function parkCrashDiagnosticTerminal(code: number | null, signal: string | null): boolean {
  if (lastInitConfig?.adoptMode || effectiveBackendType !== 'tmux' || !sessionId) return false;
  const path = crashDiagnosticPath();
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const rawTail = tailChars(scrollback, CRASH_DIAGNOSTIC_RAW_MAX);
    const header =
      `[botmux] ${cliName()} exited (code: ${code ?? 'null'}, signal: ${signal ?? 'null'}).\n` +
      `[botmux] Captured at ${new Date().toISOString()}.\n\n`;
    writeFileSync(path, header + rawTail);
  } catch (err: any) {
    log(`Crash diagnostic log write failed: ${err?.message ?? err}`);
    return false;
  }

  // Park under a DISTINCT name (`bmx-diag-<sid>`), never the live CLI's
  // `bmx-<sid>` backing-session name. The whole persistent-backend machinery
  // (restore probe, hasSession reattach, idle-sweep cold-resume, `botmux
  // resume`) keys off `bmx-<sid>` to mean "the live CLI". Reusing that name for
  // a bare diagnostic shell makes restore/cold-resume reattach the shell as if
  // it were the CLI and type the user's next message into raw bash. With a
  // distinct name, `bmx-<sid>` is correctly absent after the crash, so every
  // one of those paths sees "no live CLI" and does the right thing; the web
  // terminal is pointed at the diagnostic name explicitly (see the WS attach).
  const ok = TmuxBackend.parkDiagnosticSession(TmuxBackend.diagnosticSessionName(sessionId), {
    cwd: lastInitConfig?.workingDir ?? process.cwd(),
    cols: renderCols || PTY_COLS,
    rows: renderRows || PTY_ROWS,
    contentPath: path,
  });
  if (!ok) {
    // tmux spawn failed after the .ansi was written — drop the orphan file.
    try { unlinkSync(path); } catch { /* benign */ }
    return false;
  }
  crashDiagnosticTmuxParked = true;
  isTmuxMode = true;
  isPipeMode = false;
  isZellijMode = false;
  // The CLI is gone; stop the screen-update + analyzer loops so a stale
  // `status='working'` tick can't un-freeze the daemon's frozen crash card.
  // The web terminal is served by per-client tmux-attach PTYs, not these loops,
  // so the diagnostic shell stays visible. flushPending's retry path restarts
  // both when the next message respawns the CLI.
  stopScreenUpdates();
  stopScreenAnalyzer();
  log(`Crash diagnostic tmux session parked at ${TmuxBackend.diagnosticSessionName(sessionId)}`);
  return true;
}

// ─── Screen Analyzer (AI-based TUI prompt detection) ────────────────────────

let screenAnalyzer: ScreenAnalyzer | null = null;
/** When true, user messages are queued because a TUI prompt is active */
let tuiPromptBlocking = false;

function isWorkflowWorker(): boolean {
  return process.env.BOTMUX_WORKFLOW === '1';
}

/**
 *  Raw PTY byte stream writer — independent of the IPC `final_output` path.
 *  Powers the dashboard "terminal replay" view: bytes flow straight through
 *  without splitting on `\n` or prefixing each line, so ANSI cursor moves /
 *  status bars / alt-screen toggles all survive and `xterm.write()` on the
 *  client renders an actual recording of the live session.
 *
 *  Lazily opened on first PTY chunk so attempts that never produce data
 *  don't leave empty `pty.log` files behind.  Closed at worker exit by the
 *  process-shutdown hook below.
 */
let workflowPtyLogStream: WriteStream | undefined;
let workflowPtyLogOpenFailed = false;
function appendWorkflowPtyLog(data: string): void {
  if (!isWorkflowWorker() || workflowPtyLogOpenFailed) return;
  const path = process.env.BOTMUX_WORKFLOW_PTY_LOG_PATH;
  if (!path) return;
  if (!workflowPtyLogStream) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      workflowPtyLogStream = createWriteStream(path, { flags: 'a' });
      workflowPtyLogStream.on('error', (err) => {
        log(`workflow pty log write error: ${err.message}`);
      });
    } catch (err: any) {
      workflowPtyLogOpenFailed = true;
      log(`workflow pty log open failed (${path}): ${err.message}`);
      return;
    }
  }
  workflowPtyLogStream.write(data);
}

function captureWorkflowTranscript(data: string): void {
  appendWorkflowPtyLog(data);
  if (!isWorkflowWorker() || workflowFinalOutputSent) return;
  workflowTranscript += data;
  if (workflowTranscript.length > WORKFLOW_TRANSCRIPT_MAX) {
    workflowTranscript = workflowTranscript.slice(-WORKFLOW_TRANSCRIPT_MAX);
  }
}

function maybeEmitWorkflowTranscriptOutput(): void {
  if (!isWorkflowWorker() || workflowFinalOutputSent) return;
  if (!workflowTranscript.includes(WORKFLOW_OUTPUT_END_MARKER)) return;
  send({
    type: 'final_output',
    content: workflowTranscript,
    lastUuid: `workflow-pty-${Date.now()}`,
    turnId: currentBotmuxTurnId ?? `workflow-pty-${sessionId || 'unknown'}`,
  });
  log('Workflow PTY transcript final_output emitted');
}

function startScreenAnalyzer(): void {
  const sa = config.screenAnalyzer;
  log(`ScreenAnalyzer config: enabled=${sa.enabled}, baseUrl=${sa.baseUrl ? 'set' : 'empty'}, model=${sa.model || 'empty'}, extraHeaders=${JSON.stringify(sa.extraHeaders)}`);
  if (!sa.enabled || !sa.baseUrl || !sa.apiKey || !sa.model) return;

  screenAnalyzer = new ScreenAnalyzer(
    {
      baseUrl: sa.baseUrl,
      apiKey: sa.apiKey,
      model: sa.model,
      intervalMs: sa.intervalMs,
      stableCount: sa.stableCount,
      snapshotMaxChars: sa.snapshotMaxChars,
      extraHeaders: sa.extraHeaders,
      extraBody: sa.extraBody,
    },
    {
      getSnapshot: () => {
        // ScreenAnalyzer is called every ~5s for TUI-prompt detection. We
        // can't make this async without overhauling the analyzer, so cache
        // the last pipe-pane text snapshot here and refresh it eagerly.
        // For pipe-pane backends, the cache is repopulated by the screen
        // update timer; for others, fall through to the long-lived renderer.
        return lastAnalyzerSnapshot || renderer?.rawSnapshot() || '';
      },
      onAnalyzing: () => { /* no-op: only block when prompt is actually detected */ },
      onTuiPrompt: (description, options, multiSelect) => {
        tuiPromptBlocking = true;
        send({ type: 'tui_prompt', description, options, multiSelect, turnId: currentBotmuxTurnId });
      },
      onTuiPromptResolved: (selectedText) => {
        tuiPromptBlocking = false;
        send({ type: 'tui_prompt_resolved', selectedText });
        // Flush any messages that were queued during the prompt
        flushPending();
      },
      log,
    },
  );
  screenAnalyzer.start();
}

function stopScreenAnalyzer(): void {
  screenAnalyzer?.dispose();
  screenAnalyzer = null;
  tuiPromptBlocking = false;
}

// ─── Screenshot Capture (PNG → Feishu image_key) ────────────────────────────

const SCREENSHOT_INTERVAL_MS = 10_000;
const POST_ACTION_DELAY_MS = 1_000;
// PNG dimensions key off the renderer's actual size (renderCols / renderRows),
// which adopt-mode peg to the source pane so wrap artefacts don't appear.
// Re-clamping at MAX_RENDER_COLS/ROWS guards against a malformed init
// payload sneaking past the resolver into a runaway canvas.

let displayMode: DisplayMode = 'hidden';
let screenshotTimer: ReturnType<typeof setInterval> | null = null;
let pendingShotTimer: ReturnType<typeof setTimeout> | null = null;
let lastShotHash = '';
let larkAppIdForUpload = '';
let larkAppSecretForUpload = '';
let larkBrandForUpload: 'feishu' | 'lark' = 'feishu';

function startScreenshotLoop(): void {
  stopScreenshotLoop();
  screenshotTimer = setInterval(() => { void captureAndUpload(); }, SCREENSHOT_INTERVAL_MS);
  log(`Screenshot loop started (interval=${SCREENSHOT_INTERVAL_MS}ms)`);
  // Capture immediately so the user gets a first frame fast
  void captureAndUpload();
}

function stopScreenshotLoop(): void {
  const wasRunning = !!screenshotTimer || !!pendingShotTimer;
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  if (pendingShotTimer) { clearTimeout(pendingShotTimer); pendingShotTimer = null; }
  if (wasRunning) log('Screenshot loop stopped');
}

// Throttle silent-skip reasons so a wedged worker prints why once every 30s
// without spamming. Each distinct reason has its own throttle clock.
const screenshotSkipLogState: Record<string, number> = {};
function logScreenshotSkip(reason: string): void {
  const now = Date.now();
  if (now - (screenshotSkipLogState[reason] ?? 0) < 30_000) return;
  screenshotSkipLogState[reason] = now;
  log(`Screenshot skipped: ${reason}`);
}

// Worker stderr is piped through worker-pool, where most CLI stderr stays at
// info level to avoid polluting error.log. Mark true worker faults so the
// parent can selectively promote only these lines to logger.error.
const WORKER_ERROR_MARKER = '[botmux-worker-error]';
function logError(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [worker:${sessionId.substring(0, 8) || '??'}] ${WORKER_ERROR_MARKER} ${msg}\n`);
}

/** Schedule a single capture +1s, then resume the regular 10s cadence. */
function scheduleOneShotAfterAction(): void {
  if (displayMode !== 'screenshot') return;
  if (pendingShotTimer) clearTimeout(pendingShotTimer);
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  pendingShotTimer = setTimeout(async () => {
    pendingShotTimer = null;
    await captureAndUpload();
    if (displayMode === 'screenshot') {
      screenshotTimer = setInterval(() => { void captureAndUpload(); }, SCREENSHOT_INTERVAL_MS);
    }
  }, POST_ACTION_DELAY_MS);
}

async function captureAndUpload(): Promise<void> {
  // displayMode mismatch should be impossible during a running loop (start/stop
  // gate on it). Logging here exists to surface the unexpected case — e.g. a
  // stray scheduleOneShotAfterAction firing after user toggled back to hidden.
  if (displayMode !== 'screenshot') { logScreenshotSkip(`displayMode=${displayMode}`); return; }
  if (awaitingFirstPrompt)          { logScreenshotSkip('awaitingFirstPrompt'); return; }
  if (!larkAppIdForUpload || !larkAppSecretForUpload) { logScreenshotSkip('lark credentials missing'); return; }

  let png: Buffer;
  let usageLimitContent = '';
  try {
    // Preferred path: pipe-pane backends ask tmux for a fresh viewport
    // snapshot and render it through a transient xterm-headless. This
    // avoids the accumulated-buffer drift that produced duplicated /
    // staircase content under the legacy long-lived renderer.
    const pipeResult = await snapshotToPng(backend, renderCols, renderRows);
    if (pipeResult) {
      if (pipeResult.ansi === lastShotHash) return;
      lastShotHash = pipeResult.ansi;
      png = pipeResult.png;
      usageLimitContent = pipeResult.content;
    } else {
      // Fallback path: non-pipe backends (PtyBackend, legacy TmuxBackend)
      // still drive the long-lived renderer.
      if (!renderer) { logScreenshotSkip('renderer=null'); return; }
      const term = renderer.xterm;
      const startY = term.buffer.active.baseY;
      const snap = renderer.rawSnapshot();
      const hash = createHash('md5').update(snap).digest('hex');
      if (hash === lastShotHash) return;
      lastShotHash = hash;
      usageLimitContent = snap;
      const shotCols = clamp(term.cols, MIN_RENDER_COLS, MAX_RENDER_COLS);
      const shotRows = clamp(term.rows, MIN_RENDER_ROWS, MAX_RENDER_ROWS);
      png = captureToPng(term, { cols: shotCols, rows: shotRows, startY });
    }
  } catch (err: any) {
    logError(`Screenshot render failed: ${err?.message ?? err}`);
    return;
  }

  let imageKey: string;
  try {
    imageKey = await uploadImageBuffer(larkAppIdForUpload, larkAppSecretForUpload, png, larkBrandForUpload);
  } catch (err: any) {
    logError(`Screenshot upload failed: ${err?.message ?? err}`);
    return;
  }

  let status: RuntimeScreenStatus = isPromptReady ? 'idle' : 'working';
  if (screenAnalyzer?.isAnalyzing) status = 'analyzing';
  send({ type: 'screenshot_uploaded', imageKey, ...usageLimitTracker.classify(usageLimitContent, status) });
}

function applyDisplayMode(mode: DisplayMode): void {
  displayMode = mode;
  lastShotHash = '';
  if (mode === 'screenshot') startScreenshotLoop();
  else stopScreenshotLoop();
}

// Quick-action key → real key event for the CLI (tmux send-keys names + PTY ANSI seqs).
const TMUX_KEY_MAP: Record<TermActionKey, string> = {
  esc: 'Escape', ctrlc: 'C-c', tab: 'Tab', enter: 'Enter', space: 'Space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  half_page_up: 'PPage', half_page_down: 'NPage',
};
const PTY_SEQ_MAP: Record<TermActionKey, string> = {
  esc: '\x1b', ctrlc: '\x03', tab: '\t', enter: '\r', space: ' ',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
  half_page_up: '\x1b[5~', half_page_down: '\x1b[6~',
};

// ── Tmux copy-mode scroll state ────────────────────────────────────────────
// TUIs (Claude Code, vim, etc.) run in the alternate screen buffer which has
// no in-buffer scrollback — PageUp/PageDown sent to the CLI typically does
// nothing. In tmux mode we instead use tmux's own copy-mode to scroll the
// pane viewport into history; pipe-pane streams the scrolled view back to
// our headless terminal so the next screenshot captures it.
let tmuxScrolledHalfPages = 0;

function exitTmuxScrollMode(): void {
  if (tmuxScrolledHalfPages === 0 || !backend || !('sendCopyModeCommand' in backend)) return;
  try { (backend as any).sendCopyModeCommand('cancel'); } catch { /* benign */ }
  tmuxScrolledHalfPages = 0;
}

function handleTermAction(key: TermActionKey): void {
  if (!backend) return;
  const isHalfPage = key === 'half_page_up' || key === 'half_page_down';

  // Tmux copy-mode scroll (works around alternate-buffer scrollback limitation)
  if (isHalfPage && 'sendCopyModeCommand' in backend) {
    const tb = backend as any;
    try {
      if (tmuxScrolledHalfPages === 0 && key === 'half_page_up') {
        tb.enterCopyMode();
      }
      if (key === 'half_page_up' || tmuxScrolledHalfPages > 0) {
        tb.sendCopyModeCommand(key === 'half_page_up' ? 'halfpage-up' : 'halfpage-down');
        tmuxScrolledHalfPages += key === 'half_page_up' ? 1 : -1;
        if (tmuxScrolledHalfPages <= 0) {
          tmuxScrolledHalfPages = 0;
          // -e flag to copy-mode auto-exits when scrolled to bottom; cancel as fallback.
          try { tb.sendCopyModeCommand('cancel'); } catch { /* benign */ }
        }
      }
      log(`Tmux scroll: ${key} → ${tmuxScrolledHalfPages} halfpages above bottom`);
    } catch (err: any) {
      log(`Tmux scroll failed: ${err.message}`);
    }
    scheduleOneShotAfterAction();
    return;
  }

  // Any non-scroll key cancels active scroll first so the live view returns.
  if (tmuxScrolledHalfPages > 0) exitTmuxScrollMode();

  if ('sendSpecialKeys' in backend && TMUX_KEY_MAP[key]) {
    (backend as any).sendSpecialKeys(TMUX_KEY_MAP[key]);
  } else if (PTY_SEQ_MAP[key]) {
    backend.write(PTY_SEQ_MAP[key]);
  }
  // ESC/Ctrl-C/Enter likely ends an active TUI prompt. The analyzer
  // won't re-analyze while promptActive=true, so un-wedge both flags here.
  // Without this, dismissing an AskUserQuestion dialog via the quick-key
  // button leaves tuiPromptBlocking=true forever and silently queues every
  // subsequent user message.
  if (tuiPromptBlocking && (key === 'esc' || key === 'ctrlc' || key === 'enter')) {
    tuiPromptBlocking = false;
    screenAnalyzer?.notifySelection(`term_action:${key}`);
    void flushPending();
  }
  log(`Term action: ${key}`);
  scheduleOneShotAfterAction();
}

/** Key name → ANSI escape sequence (for PtyBackend) */
const KEY_TO_ANSI: Record<string, string> = {
  Up: '\x1b[A', Down: '\x1b[B', Left: '\x1b[D', Right: '\x1b[C',
  Enter: '\r', Space: ' ', Tab: '\t', Escape: '\x1b',
};

/**
 * Execute an AI-provided key sequence with delays between each key.
 * @param keys — key names like ["Down","Down","Space","Up","Up"]
 * @param isFinal — if true, this action ends the prompt (clear blocking state)
 */
async function handleTuiKeys(keys: string[], isFinal: boolean): Promise<void> {
  if (!backend || keys.length === 0) return;

  if ('sendSpecialKeys' in backend) {
    const b = backend as any;
    // Send each key individually with 100ms delay for TUI state processing
    for (const key of keys) {
      b.sendSpecialKeys(key);
      await new Promise(r => setTimeout(r, 100));
    }
  } else {
    for (const key of keys) {
      backend.write(KEY_TO_ANSI[key] ?? key);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (isFinal) {
    tuiPromptBlocking = false;
    if (isPromptReady) {
      isPromptReady = false;
      idleDetector?.reset();
    }
    screenAnalyzer?.notifySelection('final');
  }

  log(`TUI keys: ${keys.join(' ')}${isFinal ? ' (final)' : ''}`);
}

/**
 * Handle atomic text-input: navigate to "Type something" (WITHOUT pressing Enter),
 * then write text via cliAdapter (which adds its own Enter to submit).
 *
 * Why strip Enter: pressing Enter on "Type something" in some TUIs (e.g. Claude Code)
 * is treated as a "decline" action, not a "enter text mode" action. The TUI
 * auto-switches to text input mode as soon as a character is typed.
 */
async function handleTuiTextInput(keys: string[], text: string): Promise<void> {
  if (!backend || !cliAdapter) return;

  // Strip trailing Enter from keys — we don't want to press Enter on "Type something"
  const navKeys = keys[keys.length - 1] === 'Enter' ? keys.slice(0, -1) : keys;

  // Step 1: navigate to "Type something" (no Enter)
  if ('sendSpecialKeys' in backend) {
    const b = backend as any;
    for (const key of navKeys) {
      b.sendSpecialKeys(key);
      await new Promise(r => setTimeout(r, 100));
    }
  } else {
    for (const key of navKeys) {
      backend.write(KEY_TO_ANSI[key] ?? key);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Step 2: clear blocking state
  tuiPromptBlocking = false;
  if (isPromptReady) {
    isPromptReady = false;
    idleDetector?.reset();
  }
  screenAnalyzer?.notifySelection('text-input');

  // Wait briefly so the cursor position is stable before pasting
  await new Promise(r => setTimeout(r, 200));

  // Step 3: write text via cliAdapter (auto-switches to text mode + submits with Enter)
  log(`TUI text input: writing "${text.substring(0, 80)}" to PTY (after ${navKeys.length} nav keys)`);
  try {
    await cliAdapter.writeInput(backend, text);
  } catch (err: any) {
    log(`TUI text input write failed: ${err.message}`);
  }
}

/**
 * Drive CoCo's native AskUserQuestion picker to enter the answer the user picked
 * on the Lark card. CoCo's PreToolUse hook can't inject answers via a directive
 * (verified), so the daemon sends this after the ask settles and the hook
 * returned passthrough — meaning CoCo is about to (or just did) render the
 * picker. We wait for the picker to appear, then play the key sequence.
 *
 * Verified behaviour (CoCo 0.120.38):
 *   - Single question: the per-question final key (Enter / "Next"→Enter / typed
 *     text→Enter) submits the whole ask DIRECTLY — there is no Review screen, so
 *     NO extra Enter (sending one would hit the idle prompt).
 *   - Multiple questions: after the last question advances, a "Review your
 *     answers / Submit answers" screen appears; needsReviewSubmit drives the
 *     extra Enter there.
 *   - Free-text (comment): navKeys move the cursor to the first question's
 *     "Type something" row; typing a char auto-switches that row to input mode,
 *     then a single Enter submits. We type via the backend + one Enter (NOT the
 *     adapter's writeInput, whose submit-verification retries would fire stray
 *     Enters into the idle prompt). Multi-question free-text isn't fully
 *     supported (one text can't answer several structured questions).
 * Key names ('Down'/'Space'/'Enter') match what the manual probe confirmed.
 */
async function driveCocoPicker(navKeys: string[], needsReviewSubmit: boolean, comment?: string | null): Promise<void> {
  if (!backend) return;
  const snap = () => (lastAnalyzerSnapshot || renderer?.rawSnapshot() || '');
  const waitFor = async (re: RegExp, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (re.test(snap())) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  };

  // The hook returns passthrough → CoCo renders the picker; only then send keys.
  const appeared = await waitFor(/Enter to select|Tab\/Arrow keys|Review your answers/, 30_000);
  if (!appeared) { log('coco_drive_picker: picker not detected within 30s — aborting drive'); return; }
  tuiPromptBlocking = true;

  if (comment && comment.trim()) {
    // Free-text reply: navigate to the first question's "Type something" row,
    // type the text, then a single Enter. Single-question submits directly; for
    // multi-question this only fills the first question (logged limitation).
    log(`coco_drive_picker: free-text answer (${navKeys.length} nav keys)${needsReviewSubmit ? ' [multi-question — partial]' : ''}`);
    const b = backend as any;
    if ('sendSpecialKeys' in backend) {
      for (const key of navKeys) { b.sendSpecialKeys(key); await new Promise(r => setTimeout(r, 100)); }
    } else {
      for (const key of navKeys) { backend.write(KEY_TO_ANSI[key] ?? key); await new Promise(r => setTimeout(r, 100)); }
    }
    await new Promise(r => setTimeout(r, 150));
    if ('sendText' in backend && b.sendText) b.sendText(comment); else backend.write(comment);
    await new Promise(r => setTimeout(r, 200));
    await handleTuiKeys(['Enter'], true); // single Enter submits + clears blocking state
    return;
  }

  // Button selection. Single question: navKeys submit directly (isFinal=true).
  // Multi question: navKeys land on Review, then one Enter on "Submit answers".
  log(`coco_drive_picker: selection answer (${navKeys.length} keys, review=${needsReviewSubmit})`);
  await handleTuiKeys(navKeys, !needsReviewSubmit);
  if (needsReviewSubmit) {
    const review = await waitFor(/Review your answers|Submit answers/, 8_000);
    if (!review) log('coco_drive_picker: Review screen not detected — submitting anyway');
    await handleTuiKeys(['Enter'], true); // cursor defaults to "Submit answers"
  }
}

// ─── Trust Dialog Detection ──────────────────────────────────────────────────

// Claude Code: "Yes, I trust this folder"
// Codex:       "› 1. Yes, continue  2. No, quit" (ANSI cursor codes strip spaces from
//               longer phrases like "Do you trust…", but "Yes, continue" survives intact
//               in a single PTY chunk)
const TRUST_DIALOG_PATTERN = /Yes, I trust this folder|Yes, continue/;
let trustHandled = false;

// Codex App runner sends botmux control messages as OSC sequences so they do
// not pollute the visible terminal. Strip them before xterm rendering and
// translate them back into worker IPC.
const CODEX_APP_OSC_PREFIX = '\x1b]777;botmux:';
const APP_RUNNER_OSC_CLI_IDS = new Set(['codex-app', 'mira', 'mir']);
let codexAppOscPending = '';

function decodeCodexAppPayload(payload: string): any | undefined {
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function handleCodexAppMarker(body: string): void {
  const sep = body.indexOf(':');
  if (sep < 0) return;
  const kind = body.slice(0, sep);
  const payload = decodeCodexAppPayload(body.slice(sep + 1));
  if (!payload || typeof payload !== 'object') return;

  if (kind === 'thread' && typeof payload.threadId === 'string') {
    persistCliSessionId(payload.threadId);
    return;
  }

  if (kind === 'final' && typeof payload.content === 'string') {
    const startedAtMs = typeof payload.startedAtMs === 'number' ? payload.startedAtMs : undefined;
    const completedAtMs = typeof payload.completedAtMs === 'number' ? payload.completedAtMs : Date.now();
    if (startedAtMs !== undefined) {
      const sentByModel = shouldSuppressBridgeEmit(
        { markTimeMs: startedAtMs, isLocal: false, finalText: payload.content },
        completedAtMs + 5_001,
        readSendMarkers(),
        false,
      );
      if (sentByModel) {
        log(`${cliName()} final_output suppressed (model already called botmux send)`);
        return;
      }
    }
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : (currentBotmuxTurnId ?? `${lastInitConfig?.cliId ?? 'app'}-${Date.now()}`);
    send({
      type: 'final_output',
      content: payload.content,
      lastUuid: turnId,
      turnId,
    });
  }
}

function splitCodexAppControl(data: string): string {
  if (!APP_RUNNER_OSC_CLI_IDS.has(lastInitConfig?.cliId ?? '') && codexAppOscPending.length === 0) return data;
  const input = codexAppOscPending + data;
  codexAppOscPending = '';

  let out = '';
  let cursor = 0;
  for (;;) {
    const start = input.indexOf(CODEX_APP_OSC_PREFIX, cursor);
    if (start < 0) {
      let tailStart = input.length;
      const tail = input.slice(cursor);
      for (let n = Math.min(CODEX_APP_OSC_PREFIX.length - 1, tail.length); n > 0; n--) {
        if (CODEX_APP_OSC_PREFIX.startsWith(tail.slice(tail.length - n))) {
          tailStart = input.length - n;
          break;
        }
      }
      out += input.slice(cursor, tailStart);
      codexAppOscPending = input.slice(tailStart);
      return out;
    }

    out += input.slice(cursor, start);
    const end = input.indexOf('\x07', start + CODEX_APP_OSC_PREFIX.length);
    if (end < 0) {
      codexAppOscPending = input.slice(start);
      return out;
    }
    handleCodexAppMarker(input.slice(start + CODEX_APP_OSC_PREFIX.length, end));
    cursor = end + 1;
  }
}

// ─── Prompt Detection ────────────────────────────────────────────────────────

function onPtyData(data: string): void {
  data = splitCodexAppControl(data);
  if (data.length === 0) return;
  lastPtyActivityAtMs = Date.now();
  captureWorkflowTranscript(data);
  renderer?.write(data);

  // In tmux-attach mode, each web client has its own tmux attach PTY —
  // no relay needed. In non-tmux mode AND in pipe mode (adopt-bridge),
  // broadcast through the shared scrollback so all connected web clients
  // render the same byte stream.
  if (!isTmuxMode || isPipeMode) {
    // Track alt-buffer state so we can restore it in the scrollback prefix.
    // Scan for the *last* toggle in this chunk — that's the current state.
    let lastToggleIdx = -1;
    let lastToggleActive = altBufferActive;
    ALT_ENTER_RE.lastIndex = 0;
    ALT_EXIT_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = ALT_ENTER_RE.exec(data)); ) {
      if (m.index > lastToggleIdx) { lastToggleIdx = m.index; lastToggleActive = true; }
    }
    for (let m: RegExpExecArray | null; (m = ALT_EXIT_RE.exec(data)); ) {
      if (m.index > lastToggleIdx) { lastToggleIdx = m.index; lastToggleActive = false; }
    }
    altBufferActive = lastToggleActive;

    scrollback += data;
    if (scrollback.length > MAX_SCROLLBACK) {
      // Slice at an escape-sequence boundary so the replay never starts
      // mid-sequence. Then re-inject a full reset + alt-buffer-enter so
      // the receiving xterm lands in the right buffer, matching the CLI.
      let cut = scrollback.length - MAX_SCROLLBACK;
      const escAt = scrollback.indexOf('\x1b', cut);
      cut = escAt >= 0 ? escAt : cut;
      const prefix = altBufferActive ? '\x1bc\x1b[?1049h' : '\x1bc';
      scrollback = prefix + scrollback.slice(cut);
    }
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  // Trust dialog auto-accept
  if (!trustHandled) {
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    if (TRUST_DIALOG_PATTERN.test(stripped)) {
      trustHandled = true;
      log('Trust dialog detected, auto-accepting...');
      if (backend && 'sendSpecialKeys' in backend) {
        (backend as any).sendSpecialKeys('Enter');
      } else {
        backend?.write('\r');
      }
      return;
    }
  }

  // Track last PTY output time for the ready-gate quiescence settle (see
  // settleThenFlush) and delegate idle detection to IdleDetector.
  lastPtyOutputAtMs = Date.now();
  idleDetector?.feed(data);
}

function markPromptReady(): void {
  if (isPromptReady) return;  // guard against duplicate calls
  stopBusyPatternIdleProbe();
  // Ready-gate: a startup selector's ❯ (cjadk et al.) falsely matches
  // readyPattern → the IdleDetector fires idle while the CLI is NOT actually at
  // its input box. Hold off declaring ready until the SessionStart hook signal
  // (or the fallback timeout) so the first prompt isn't typed into the selector.
  // releaseReadyGate() drives flushPending() once the real signal lands, and a
  // later genuine idle then runs this fully. No-op for non-armed gates.
  if (readyGate.shouldHold()) {
    log('Idle detected but holding for SessionStart ready signal (startup selector guard)');
    return;
  }
  isPromptReady = true;
  // CLI 实际启动成功（回到 prompt）：复位连续重启计数。
  // 任何能到这一步的 spawn 都算"成功"——后续即便再崩溃（不是 resume 目标不存在
  // 的问题），下一轮也该有新的 2 次重试预算，而不是被历史重启计数卡住。
  if (consecutiveInWorkerRestarts > 0) {
    log(`CLI reached prompt successfully — resetting consecutive restart count (was ${consecutiveInWorkerRestarts})`);
    consecutiveInWorkerRestarts = 0;
  }
  // CLI is back at its prompt — every previously written input has been
  // consumed, so nothing is in flight anymore. A later crash must not
  // replay these.
  inflightInputs.onTurnComplete();
  maybeEmitWorkflowTranscriptOutput();
  if (awaitingFirstPrompt) {
    awaitingFirstPrompt = false;
    renderer?.markNewTurn();  // exclude history replay from streaming card
  }
  send({ type: 'prompt_ready' });
  // Send immediate idle snapshot so Lark card reflects idle status.
  // BUT: skip when messages are pending — flushPending() will immediately
  // make the CLI busy, so the idle state is transient and shouldn't appear
  // in the card.  This avoids a false "就绪" flash on daemon restart
  // (where the initial prompt is queued before the CLI becomes idle).
  if (renderer && pendingMessages.length === 0 && !isFlushing) {
    const { content } = renderer.snapshot();
    send({ type: 'screen_update', content, ...usageLimitTracker.classify(content, 'idle'), turnId: currentBotmuxTurnId });
  }
  flushPending();
}

function persistCliSessionId(cliSessionId: string): void {
  if (!cliSessionId || !sessionId) return;
  if (lastInitConfig) lastInitConfig.cliSessionId = cliSessionId;
  send({ type: 'cli_session_id', cliSessionId });
  try {
    const session = sessionStore.getSession(sessionId);
    if (!session || session.cliSessionId === cliSessionId) return;
    session.cliSessionId = cliSessionId;
    sessionStore.updateSession(session);
    log(`Persisted CLI session id: ${cliSessionId}`);
  } catch (err: any) {
    log(`Failed to persist CLI session id: ${err.message}`);
  }
}

function observeCursorCliSessionId(pid: number, label = 'spawn'): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!shouldObserveCursorChatId({
    cliId: lastInitConfig?.cliId,
    effectiveResume: lastSpawnEffectiveResume,
    effectiveCliSessionId: lastSpawnEffectiveCliSessionId,
  })) return;

  const backendAtSpawn = backend;
  let attempts = 0;
  const maxAttempts = 60; // Cursor may open store.db only after its startup render settles.
  const tick = () => {
    if (!backend || !shouldObserveCursorChatId({
      cliId: lastInitConfig?.cliId,
      effectiveResume: lastSpawnEffectiveResume,
      effectiveCliSessionId: lastSpawnEffectiveCliSessionId,
    })) return;
    if (backend !== backendAtSpawn) return;
    const currentPid = backend.getChildPid?.();
    if (currentPid && currentPid !== pid) return;

    const realPid = findLaunchedCliPid(pid, 'cursor') ?? pid;
    const chatId = findCursorChatIdByPid(realPid);
    if (chatId) {
      if (!shouldPersistObservedCursorChatId({
        effectiveResume: lastSpawnEffectiveResume,
        effectiveCliSessionId: lastSpawnEffectiveCliSessionId,
        observedChatId: chatId,
      })) {
        log(`Observed Cursor chatId via pid ${realPid}${realPid === pid ? '' : ` (launcher ${pid})`} (${label}) but kept existing resume target ${lastSpawnEffectiveCliSessionId}`);
        return;
      }
      persistCliSessionId(chatId);
      log(`Observed Cursor chatId via pid ${realPid}${realPid === pid ? '' : ` (launcher ${pid})`} (${label}): ${chatId}`);
      return;
    }
    attempts++;
    if (attempts < maxAttempts) setTimeout(tick, 500);
  };
  setTimeout(tick, 250);
}

/** How long to wait before re-checking whether a submit-not-confirmed message
 *  eventually landed. Cold-start sessions and slow third-party hooks
 *  (UserPromptSubmit, SessionStart — e.g. superpowers' large skill injection)
 *  can defer Claude's jsonl append by 5–15s; a 20s deferred recheck covers
 *  both without being so long that a true failure goes unsurfaced. */
const SUBMIT_DEFERRED_RECHECK_MS = 20_000;

/** Worker-side handler for `submitted: false`. Defers the user-facing
 *  warning and runs the adapter-supplied `recheck` closure first; if the
 *  message has shown up in the transcript by then (slow path, hook delay),
 *  suppresses the warning entirely. Adapters without a recheck still fall
 *  through to the warning after the same delay so the UX is uniform.
 *
 *  `bridgeTurnId` is the BridgeTurnQueue mark created right before the
 *  failing writeInput. When the deferred recheck conclusively fails (= no
 *  jsonl line will ever match this fingerprint), we drop the mark — leaving
 *  it would keep `maybeSwitchBridgeJsonl` doing full-directory scans every
 *  poll tick for a fingerprint that's permanently dead, the 99% CPU bug
 *  this whole patch series is fixing. */
function scheduleSubmitFailureNotify(
  msg: string,
  recheck: (() => SubmitRecheckResult | Promise<SubmitRecheckResult>) | undefined,
  transcriptLabel: string,
  bridgeTurnId?: string,
  failureReason?: string,
  turnSeq = usageLimitTracker.currentTurn(),
): void {
  const preview = msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
  const dropBridgeMark = (): void => {
    if (!bridgeTurnId) return;
    const dropped = bridgeQueue.dropPendingTurn(bridgeTurnId);
    if (dropped) {
      if (dropped.contentFingerprint) bridgeFingerprintScanLastMs.delete(dropped.contentFingerprint);
      log(`Bridge mark dropped after submit failure (turnId=${bridgeTurnId}) — rotation-fallback scan will stop spinning on this fingerprint.`);
    }
  };
  if (failureReason) {
    const action = decideSubmitConfirmationAction({
      failureReason,
      recheckSubmitted: false,
      usageLimitDetected: false,
    });
    dropBridgeMark();
    const reason = action.kind === 'notify-hard-failure' ? action.reason : failureReason;
    log(`writeInput: submit impossible — notifying user immediately. reason="${reason}" preview="${preview}"`);
    send({
      type: 'user_notify',
      turnId: currentBotmuxTurnId,
      message: t('worker.submit_impossible', { cliName: cliName(), reason, preview }),
    });
    return;
  }
  const activityBaselineMs = Date.now();
  log(`writeInput: submit not confirmed after retries — deferred ${SUBMIT_DEFERRED_RECHECK_MS}ms recheck queued. preview="${preview}"`);
  setTimeout(async () => {
    let recheckSubmitted = false;
    let cliSessionId: string | undefined;
    if (recheck) {
      try {
        const recheckResult = await recheck();
        recheckSubmitted = typeof recheckResult === 'boolean'
          ? recheckResult
          : recheckResult.submitted === true;
        cliSessionId = typeof recheckResult === 'object' && recheckResult && typeof recheckResult.cliSessionId === 'string'
          ? recheckResult.cliSessionId
          : undefined;
      } catch (err: any) {
        log(`Deferred recheck threw (${err?.message ?? err}); falling through to warning.`);
      }
    }

    const action = decideSubmitConfirmationAction({
      recheckSubmitted,
      usageLimitDetected: usageLimitTracker.detectedThisTurn(turnSeq),
      activityEvidence: submitActivityEvidenceSince(activityBaselineMs),
    });

    switch (action.kind) {
      case 'suppress-confirmed':
        if (cliSessionId) {
          persistCliSessionId(cliSessionId);
          if (codexBridgeFallbackActive()) codexBridgeNotifyCliSessionId(cliSessionId);
        }
        log(`Deferred recheck found submit in ${transcriptLabel} — suppressing warning. preview="${preview}"`);
        return;
      case 'suppress-usage-limit':
        dropBridgeMark();
        log(`Deferred recheck missing but usage limit was detected for this turn — suppressing submit warning. preview="${preview}"`);
        return;
      case 'suppress-active':
        log(`Deferred recheck missing but later ${action.evidence} shows ${cliName()} is active — suppressing submit warning. preview="${preview}"`);
        return;
      case 'notify-hard-failure':
        // failureReason is handled synchronously above.
        return;
      case 'notify-stuck':
        break;
    }

    dropBridgeMark();
    log(`Deferred recheck still missing — notifying user. preview="${preview}"`);
    send({
      type: 'user_notify',
      turnId: currentBotmuxTurnId,
      message: t('worker.submit_unconfirmed', { cliName: cliName(), secs: Math.round(SUBMIT_DEFERRED_RECHECK_MS / 1000), transcriptLabel, preview }),
    });
  }, SUBMIT_DEFERRED_RECHECK_MS);
}

/**
 * Launch-failure guard. Right before the FIRST prompt is typed, confirm the
 * pane's leaf process is the agent CLI — not a bare interactive shell. The
 * failure this catches: a user's login `$SHELL` (e.g. bash) whose rcfile
 * `exec`-trampolines into another shell (`[ -t 1 ] && exec zsh`). botmux's
 * tmux wrapper launches `<shell> -i -c '… exec /usr/bin/env <cli>'`; the `-i`
 * sources the rcfile, the `exec zsh` replaces the shell BEFORE the `-c` body
 * runs, and the pane is left at a bare shell. Typing the multi-line prompt into
 * it just yields `zsh: parse error near '\n'` and the user is stuck (the exact
 * bug this guards). Instead of typing into the shell we surface ONE actionable
 * diagnostic and latch the session so no further prompt is mis-typed.
 *
 * Why this is the right moment / low false-positive: the first prompt is held
 * until the CLI signals ready OR the 15s/45s first-prompt timeout fires, so by
 * the time we get here a healthy CLI has long since `exec`'d (leaf comm =
 * codex/node/…) — only a trampolined/failed launch is still a bare shell. We
 * skip wrapperCli/adopt (their leaf is legitimately a launcher/observed pane)
 * and the pty/herdr backends (which `exec` the CLI directly — getChildPid is the
 * CLI itself, never a shell).
 *
 * Returns true when a bare-shell launch was detected (caller must NOT flush).
 */
function detectBareShellLaunch(): boolean {
  if (bareShellLaunchBlocked) return true;
  if (lastInitConfig?.adoptMode) return false;       // observing an existing pane, not launching
  if (lastInitConfig?.wrapperCli) return false;      // launcher legitimately wraps the CLI (transient shell shim)
  const pid = backend?.getChildPid?.();
  if (!pid) return false;
  const comm = readComm(pid);
  if (!isBareShellComm(comm)) return false;          // CLI (rust/go/node) is running — healthy launch

  // Bare shell is the pane leaf → the CLI never launched. Tier the message on
  // whether the leaf shell differs from the one botmux launched with: a
  // mismatch is the unmistakable signature of an rcfile `exec`-trampoline.
  const launchShell = (lastInitConfig?.launchShell || process.env.SHELL || '').trim();
  const expectedShell = launchShell ? basename(launchShell) : '';
  const trampolined = bareShellLaunchKind(comm!, expectedShell) === 'trampoline';
  bareShellLaunchBlocked = true;
  log(`Bare-shell launch detected: pane leaf comm=${comm}, expected launch shell=${expectedShell || '?'}, ` +
    `cli=${lastInitConfig?.cliId}; suppressing first-prompt write (${trampolined ? 'rc trampoline' : 'CLI did not start'})`);

  const cli = cliName();
  let message: string;
  if (trampolined) {
    message =
      `⚠️ 会话没能启动：pane 里现在是裸 \`${comm}\`，${cli} 没真正跑起来——所以我没把你的消息打进去（否则会被当 shell 命令执行，报 \`parse error\`）。\n\n` +
      `最可能原因：botmux 用 \`${expectedShell}\` 启动 CLI，但 pane 落到了 \`${comm}\`。通常是 rc 文件（如 \`~/.${expectedShell}rc\`）里有 \`exec ${comm}\` 这类跳转——\`${expectedShell} -i\` 会 source rc，于是 shell 被顶替，CLI 的启动命令没机会跑。\n\n` +
      `两种修法（任选其一，改完重启 daemon 再发一条消息）：\n` +
      `① 给那行加守卫，只在手动开终端时切：\`[ -z "$BASH_EXECUTION_STRING" ] && [ -t 1 ] && exec ${comm}\`（注意 PATH/nvm 等导出放在它之前）\n` +
      `② 给这个 bot 配 \`launchShell: ${comm}\`（dashboard 机器人配置，或 \`/config launchShell ${comm}\`），直接用 \`${comm}\` 启动绕开 \`${expectedShell}\` 的 rc——但要确保 PATH/nvm 在 \`${comm}\` 的 rc 里。`;
  } else {
    message =
      `⚠️ 会话没能启动：pane 里还停在 \`${comm}\`，${cli} 没真正跑起来——我没把消息打进去（否则会被当 shell 命令执行）。\n\n` +
      `可能原因：rc 文件启动过慢/报错，或 \`${cli}\` 的可执行文件不在 PATH 上（CLI 没找到）。\n` +
      `建议：在 web 终端里手动敲一下启动命令看报什么错；确认 CLI 二进制能在 PATH 上找到；或精简 rc 启动逻辑后重启 daemon 再试。`;
  }
  send({ type: 'user_notify', turnId: currentBotmuxTurnId, message });
  return true;
}

/**
 * Drain the pending message queue sequentially.
 * Async with isFlushing mutex: awaits each writeInput, then immediately
 * sends the next message (type-ahead) without waiting for idle detection.
 * Messages pushed during a flush are picked up by the while loop.
 */
async function flushPending(): Promise<void> {
  if (isFlushing) return;  // while loop in active flush will pick up new messages
  if (!backend || !cliAdapter) return;
  if (pendingMessages.length === 0) return;  // nothing to flush — keep isPromptReady
  if (bareShellLaunchBlocked) return;  // launch failed into a bare shell — don't type prompts into it
  // Ready-gate: hold the FIRST prompt until the SessionStart hook fires a true-
  // ready signal. A cjadk-style startup selector's ❯ falsely matches readyPattern
  // and would otherwise eat this message. releaseReadyGate() re-invokes us once
  // the signal (or fallback timeout) lands. No-op for non-armed gates / other CLIs.
  if (readyGate.shouldHold()) {
    log(`Holding ${pendingMessages.length} pending message(s) until SessionStart ready signal`);
    return;
  }
  // Post-signal quiescence settle in progress — hold so the first write lands
  // after Ink's startup render has drained (else paste-burst keeps `\` literal).
  if (isSettlingFirstFlush) {
    log(`Holding ${pendingMessages.length} pending message(s) until ready-gate settle completes`);
    return;
  }
  // Type-ahead adapters flush even while the CLI is busy; others wait for
  // idle. Claude bridge fallback used to also disable type-ahead because
  // BridgeTurnQueue.ingest didn't recognise the `attachment(queued_command)`
  // events Claude writes when it dequeues a queued submit — assistant text
  // for the type-ahead'd turn was either dropped or attributed to the wrong
  // Lark message. Now that the queue handles queued_command identically to
  // role:user (and overrides markTimeMs to the dequeue-time event timestamp
  // so the gate window is correct), Claude bridge can run with type-ahead
  // again.
  //
  // CoCo (0.120.32+) and Codex (0.134.0+) also tolerate type-ahead, but for a
  // different reason than Claude: they park a submit-while-busy message in the
  // TUI's own queue (CoCo: "↑ Press up to edit queued messages"; Codex:
  // "Messages to be submitted after next tool call"). CoCo writes the queued
  // user event only at DEQUEUE time, so its transcript stays strictly
  // interleaved (user1 → asst1 → user2 → asst2). Codex is an active-turn STEER:
  // a tool-running turn pulls the queued input into the SAME turn and emits one
  // merged final (user1 → user2 → assistant_final). CodexBridgeQueue copes with
  // both via HOL-block-drop (see codex-bridge-queue.ts) plus the markTimeMs
  // dequeue-time override — no queued_command upgrade like Claude's. (The
  // submit log history.jsonl, which the adapter's writeInput verification
  // polls, IS written at submit time even for a parked message, so verification
  // doesn't spuriously fail either.) All behaviours verified empirically —
  // Codex on codex-cli 0.134.0.
  const claudeBridgeActive = !!bridgeJsonlPath && !lastInitConfig?.adoptMode;
  const codexBridgeActive = codexBridgeFallbackActive();
  const typeAheadAllowed = cliAdapter.supportsTypeAhead;
  if (!isPromptReady && !typeAheadAllowed) return;

  isFlushing = true;
  if (isPromptReady) {
    isPromptReady = false;
    idleDetector?.reset();
  }

  try {
    // Launch-failure guard, run ONCE per spawn on the first flush, BEFORE startup
    // commands or any user prompt: if the pane leaf is a bare shell (the CLI never
    // launched — e.g. a user rcfile that `exec`-trampolines into another shell, or
    // a reattached persistent pane that has dropped back to a shell), don't type
    // anything into it (it would just be `zsh: parse error`); surface one
    // diagnostic and bail. Gated by its own one-shot (NOT hasRunStartupCommands)
    // so it also covers reattach, where startup commands are intentionally
    // skipped. Must precede runStartupCommands so a bot with startupCommands
    // doesn't get them typed into the bare shell first.
    if (!bareShellChecked) {
      bareShellChecked = true;
      if (detectBareShellLaunch()) {
        return;  // finally{} releases the mutex; pendingMessages stay queued, untouched
      }
    }
    // One-shot per spawn: type the bot's startup commands (e.g. `/effort
    // ultracode`) into the CLI before the first user prompt drains. Both ready
    // paths funnel through flushPending — the ready-gate settle for Claude-family
    // CLIs, markPromptReady for the rest — so this is the single universal
    // "ready, about to send the first prompt" point, for every CLI. Held by the
    // isFlushing mutex so no Lark message can interleave between the commands.
    if (!hasRunStartupCommands) {
      hasRunStartupCommands = true;
      await runStartupCommands();
    }
    while (pendingMessages.length > 0 && backend && cliAdapter) {
      const item = pendingMessages.shift()!;
      // Track as in-flight until the CLI returns to idle (markPromptReady).
      // If the CLI exits first, onExit stashes these for re-queue on respawn.
      inflightInputs.onWrite(item);
      const msg = item.content;
      currentBotmuxTurnId = item.turnId;
      writeCliPidMarker();
      const turnSeq = usageLimitTracker.beginTurn(currentUsageLimitSnapshot());
      // Bridge fallback: mark immediately before writeInput. Doing it here
      // (instead of at enqueue time) means markTimeMs anchors to the
      // moment the message actually starts hitting the PTY — so any
      // `botmux send` whose sentAtMs lands during turn N's processing
      // falls inside [markTimeMs(N), markTimeMs(N+1)). Marking earlier
      // (at IPC arrival) would let a slow-finishing turn N's send leak
      // into turn N+1's window and falsely suppress its emit.
      let bridgeTurnId: string | undefined;
      if (claudeBridgeActive) {
        try { bridgeIngest(); } catch { /* best-effort */ }
        bridgeTurnId = bridgeMarkPendingTurn(msg, item.turnId);
      } else if (codexBridgeActive) {
        // Codex mark works even before the rollout path is known: the
        // queue is path-agnostic, and the late-attach below will start
        // ingest from offset 0 so the user_message that lands shortly
        // after still fingerprint-matches this turn.
        codexBridgeMarkPendingTurn(msg, item.turnId);
      }
      log(`Writing to PTY (flush): "${msg.substring(0, 80)}"`);
      // Defense in depth: TmuxPipeBackend's send methods no longer throw on a
      // dead pane (they fire onExit instead), but writeInput can still throw
      // for other reasons (fs errors while resolving the JSONL, a future
      // backend regression). flushPending is invoked fire-and-forget, so an
      // escaping rejection would become an unhandledRejection and crash the
      // worker — exactly the failure mode this change is closing. Contain it.
      let result: Awaited<ReturnType<typeof cliAdapter.writeInput>> | undefined;
      try {
        result = await cliAdapter.writeInput(backend, msg);
        scheduleBusyPatternIdleProbe(`${cliName()} post-submit`);
      } catch (err: any) {
        log(`writeInput threw: ${err?.message ?? err}`);
        // If the CLI exited mid-write the backend already fired onExit (which
        // nulled `backend` and told the user the CLI exited) — nothing more to
        // do. Otherwise surface it as a submit failure so the message isn't
        // silently lost.
        if (backend) scheduleSubmitFailureNotify(msg, undefined, '会话 JSONL', bridgeTurnId, undefined, turnSeq);
        break;
      }
      // Persist any sessionId the adapter observed via authoritative sources
      // (Claude's pid file, Codex's history). Done independently of submit
      // outcome — the rotation is real even when the current Enter didn't
      // land, and we want next-resume to use the right id.
      if (result?.cliSessionId) {
        persistCliSessionId(result.cliSessionId);
        // First successful Codex submit also reveals the rollout path.
        // Late-attach now so subsequent assistant_final events get
        // attributed to this turn.
        if (codexBridgeActive) codexBridgeNotifyCliSessionId(result.cliSessionId);
      }
      // `&& backend`: if the CLI exited during this write (pane gone → onExit
      // nulled backend) the user already got a "CLI exited" notice; don't also
      // nag that the submit wasn't confirmed.
      if (result && result.submitted === false && backend) {
        scheduleSubmitFailureNotify(msg, result.recheck, '会话 JSONL', bridgeTurnId, result.failureReason, turnSeq);
      }
      // All structured bridges now drain every pending message in one flush:
      // Claude's BridgeTurnQueue handles `attachment(queued_command)` events
      // identically to `role:user`; CoCo parks queued submits in its TUI queue
      // and writes the user event at dequeue time (transcript stays interleaved);
      // Codex parks them too but steers them into the active turn (which can
      // merge into one final), and CodexBridgeQueue's HOL-block-drop attributes
      // that correctly. We WANT them to drain all pending here so the extras
      // land in the TUI queue rather than waiting for the next idle.
    }
  } finally {
    isFlushing = false;
  }
}

function sendToPty(content: string, turnId?: string): void {
  if (!backend || !cliAdapter) return;
  const next = { content, turnId };
  const shouldMergeQueued = !isFlushing && !shouldWriteNow({
    isPromptReady,
    isFlushing,
    supportsTypeAhead: cliAdapter.supportsTypeAhead === true,
    awaitingFirstPrompt,
  }) && cliAdapter.mergeQueuedInput === true;
  const mergedQueued = shouldMergeQueued && mergeQueuedCliInput(pendingMessages, next);
  if (mergedQueued) {
    log(`Merged queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — ${cliName()} ${awaitingFirstPrompt ? 'still booting' : 'is busy'}`);
  } else {
    pendingMessages.push(next);
  }
  // User-override semantics: a fresh Lark message while a TUI prompt is "active"
  // takes precedence over the AI-detected prompt. The screen analyzer can be
  // wrong (false positive on a question that has no rendered options) and a
  // wedged blocking flag silently swallows every subsequent message — without
  // this override the user has no way to recover from Lark. Mirrors the
  // web-terminal text-input path (handleTuiTextInput).
  if (tuiPromptBlocking) {
    log(`User override: incoming Lark message clears tuiPromptBlocking — "${content.substring(0, 80)}"`);
    tuiPromptBlocking = false;
    screenAnalyzer?.notifySelection('lark-input');
    // Tear down the prompt card so the user doesn't see stale options.
    send({ type: 'tui_prompt_resolved', selectedText: 'user-override' });
  }
  // See flushPending: type-ahead adapters flush even while the CLI is busy.
  // Claude attributes `attachment(queued_command)` identically to `role:user`;
  // CoCo parks queued submits and writes the user event at dequeue time; Codex
  // parks them but steers into the active turn — CodexBridgeQueue's
  // HOL-block-drop attributes the (possibly merged) result correctly.
  // Type-ahead lets the message write while the CLI is BUSY — but only once the
  // TUI has booted. During startup / tmux re-attach (awaitingFirstPrompt) even a
  // type-ahead write is dropped (no input box yet) — markPromptReady()'s flush
  // delivers queued messages instead. See input-gate.ts; this fixes dispatch's
  // brief reaching Codex before its first idle and never landing.
  if (shouldWriteNow({ isPromptReady, isFlushing, supportsTypeAhead: cliAdapter.supportsTypeAhead === true, awaitingFirstPrompt })) {
    if (!mergedQueued) log(`Writing to PTY: "${content.substring(0, 80)}"`);
    flushPending();  // fire-and-forget async; no-op if already flushing
  } else {
    if (!mergedQueued) log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — ${cliName()} ${awaitingFirstPrompt ? 'still booting' : 'is busy'}`);
    scheduleBusyPatternIdleProbe(`${cliName()} queued-message`);
  }
}

// ─── Screen Update Timer ─────────────────────────────────────────────────────

function startScreenUpdates(): void {
  // renderCols / renderRows were set by the init handler from cfg, so
  // adopt-mode panes (e.g. 270x57) get an xterm-headless of matching
  // width. With a too-narrow renderer, ANSI meant for the source pane
  // would wrap and the screenshot would show duplicated / stair-stepped
  // content (the live failure that prompted this fix).
  renderer = new TerminalRenderer(renderCols, renderRows);
  let lastSentStatus: string | undefined;
  let lastTextSnapshotHash = '';
  let lastContent = '';
  // PTY-activity watermark of the last tick that actually captured. The screen
  // normally reaches us only through onPtyData (it updates lastPtyActivityAtMs
  // and feeds the renderer in the same place), so when this hasn't advanced the
  // screen is byte-identical to lastContent and a capture is pure waste.
  // Exception: an observe backend that paused its emission poller for a live
  // web-attach (isScreenSelfDriven) keeps changing without bumping the
  // watermark — there we must capture every tick (see shouldCaptureScreen).
  let lastSnapshotPtyActivity = -1;
  screenUpdateTimer = setInterval(() => {
    if (awaitingFirstPrompt) return;
    let status: RuntimeScreenStatus = isPromptReady ? 'idle' : 'working';
    if (screenAnalyzer?.isAnalyzing) status = 'analyzing';

    void (async () => {
      let content = lastContent;
      let changed = false;

      // Capture only when the pane has emitted output since our last snapshot.
      // During idle (the steady state for a parked session) this skips a tmux
      // capture-pane + a throwaway xterm-headless instantiation every tick —
      // the dominant per-session background cost — while the status-transition
      // send below still fires off the cached content. The exception is a
      // self-driven screen (observe backend with a live web-attach): the
      // watermark can't be trusted there, so capture every tick.
      const ptyActivity = lastPtyActivityAtMs;
      if (shouldCaptureScreen({
        ptyActivity,
        lastCapturedPtyActivity: lastSnapshotPtyActivity,
        screenSelfDriven: isScreenSelfDriven(backend),
      })) {
        lastSnapshotPtyActivity = ptyActivity;
        // Preferred path: pipe-pane backends pull a fresh viewport snapshot
        // from tmux every tick. This eliminates the accumulated-buffer drift
        // that produced duplicated/staircase text in 'text' display mode.
        const pipeText = await snapshotToText(backend, renderCols, renderRows, { filter: true });
        if (pipeText) {
          content = pipeText.content;
          const hash = pipeText.ansi;
          changed = hash !== lastTextSnapshotHash;
          lastTextSnapshotHash = hash;
          // Refresh the unfiltered cache that ScreenAnalyzer reads from. Same
          // tmux call would otherwise need to fire twice per tick.
          if (changed) {
            const rawSnap = await snapshotToText(backend, renderCols, renderRows, { filter: false });
            if (rawSnap) lastAnalyzerSnapshot = rawSnap.content;
          }
        } else if (renderer) {
          const snap = renderer.snapshot();
          content = snap.content;
          changed = snap.changed;
        } else {
          return;
        }
        lastContent = content;
      }

      const usageAware = usageLimitTracker.classify(content, status);
      if (changed || usageAware.status !== lastSentStatus) {
        lastSentStatus = usageAware.status;
        send({ type: 'screen_update', content, ...usageAware, turnId: currentBotmuxTurnId });
      }
    })();
  }, SCREEN_UPDATE_INTERVAL_MS);
}

function stopScreenUpdates(): void {
  if (screenUpdateTimer) { clearInterval(screenUpdateTimer); screenUpdateTimer = null; }
  if (renderer) { renderer.dispose(); renderer = null; }
  lastAnalyzerSnapshot = '';
}

// ─── PTY Management ──────────────────────────────────────────────────────────

function setupAdoptTranscriptBridges(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  if (cfg.bridgeJsonlPath) {
    startBridgeWatcher(cfg.bridgeJsonlPath, {
      cliPid: cfg.adoptCliPid,
      cliCwd: cfg.adoptCwd,
    });
  } else if (cfg.cliId === 'codex') {
    const adoptStartMs = Date.now();
    codexAdoptStartMs = adoptStartMs;
    codexBridgeQueue.setLocalTurns(true, adoptStartMs);
    let rolloutPath: string | undefined;
    if (cfg.cliSessionId) rolloutPath = findCodexRolloutBySessionId(cfg.cliSessionId);
    if (!rolloutPath && cfg.adoptCliPid) {
      const probed = findCodexRolloutByPid(cfg.adoptCliPid);
      if (probed) rolloutPath = probed.path;
    }
    if (rolloutPath) {
      codexBridgeAttach(rolloutPath, 'split-live');
    } else {
      if (cfg.cliSessionId) codexBridgePendingSessionId = cfg.cliSessionId;
      codexAdoptPendingPid = cfg.adoptCliPid;
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'traex') {
    // TRAE rollout format is byte-identical to Codex; only the directory
    // layout (and therefore the finder functions) differ.
    const adoptStartMs = Date.now();
    codexAdoptStartMs = adoptStartMs;
    codexBridgeQueue.setLocalTurns(true, adoptStartMs);
    let rolloutPath: string | undefined;
    if (cfg.cliSessionId) rolloutPath = findTraexRolloutBySessionId(cfg.cliSessionId);
    if (!rolloutPath && cfg.adoptCliPid) {
      const probed = findTraexRolloutByPid(cfg.adoptCliPid);
      if (probed) rolloutPath = probed.path;
    }
    if (rolloutPath) {
      codexBridgeAttach(rolloutPath, 'split-live');
    } else {
      if (cfg.cliSessionId) codexBridgePendingSessionId = cfg.cliSessionId;
      codexAdoptPendingPid = cfg.adoptCliPid;
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'coco') {
    const adoptStartMs = Date.now();
    codexAdoptStartMs = adoptStartMs;
    codexBridgeQueue.setLocalTurns(true, adoptStartMs);
    let eventsPath: string | undefined;
    if (cfg.cliSessionId) eventsPath = cocoEventsPathForSession(cfg.cliSessionId);
    if (!eventsPath && cfg.adoptCliPid) {
      const probed = findCocoSessionByPid(cfg.adoptCliPid);
      if (probed) eventsPath = probed.eventsPath;
    }
    if (eventsPath) {
      const sessionDir = dirname(eventsPath);
      if (!existsSync(sessionDir)) {
        send({
          type: 'final_output',
          content: t('worker.coco_session_dir_gone'),
          lastUuid: `coco-adopt-stale-${randomBytes(4).toString('hex')}`,
          turnId: 'coco-adopt-stale',
        });
        log(`CoCo adopt: session dir missing, bridge disabled (${sessionDir})`);
      } else {
        codexBridgeAttach(eventsPath, 'split-live');
      }
    } else {
      codexAdoptPendingPid = cfg.adoptCliPid;
    }
    codexBridgeStartTimer();
  } else if (cfg.cliId === 'mtr') {
    const adoptStartMs = Date.now();
    codexAdoptStartMs = adoptStartMs;
    codexBridgeQueue.setLocalTurns(true, adoptStartMs);
    if (cfg.cliSessionId) codexBridgePendingSessionId = cfg.cliSessionId;
    const source =
      findMtrSessionById(cfg.cliSessionId)
      ?? findLatestMtrSessionByDirectory(cfg.adoptCwd ?? cfg.workingDir);
    if (source) {
      codexBridgePendingSessionId = undefined;
      mtrBridgeAttach(source, 'split-live');
    } else {
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'cursor') {
    const adoptStartMs = Date.now();
    codexAdoptStartMs = adoptStartMs;
    // Cursor JSONL lacks per-event timestamps, but adopt still needs parity
    // with other transcript bridges: direct terminal input should be surfaced
    // as a local-turn card in Lark. Baseline/offset handling above keeps
    // pre-adopt history out of the queue; worst-case mirror replay is a
    // duplicate local-turn message rather than lost local input.
    codexBridgeQueue.setLocalTurns(true, adoptStartMs);
    // Resolve the transcript: cliSessionId (= Cursor chatId) when discovery
    // captured it, else the adopt pid via its open store.db fd. Cursor lacks
    // per-event timestamps, so cursorBridgeAttach baselines by byte offset
    // rather than the timestamp-cutoff split-live the other CLIs use.
    let path: string | undefined;
    if (cfg.cliSessionId) path = findCursorTranscriptByChatId(cfg.cliSessionId);
    if (!path && cfg.adoptCliPid) {
      const probed = findCursorTranscriptByPid(cfg.adoptCliPid);
      if (probed) path = probed.path;
    }
    if (path) {
      cursorBridgeAttach(path);
    } else {
      if (cfg.cliSessionId) codexBridgePendingSessionId = cfg.cliSessionId;
      codexAdoptPendingPid = cfg.adoptCliPid;
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'pi') {
    const adoptStartMs = Date.now();
    codexAdoptStartMs = adoptStartMs;
    codexBridgeQueue.setLocalTurns(true, adoptStartMs);
    let path: string | undefined;
    if (cfg.cliSessionId) path = findPiTranscriptBySessionId(cfg.cliSessionId, cfg.adoptCwd ?? cfg.workingDir);
    if (!path && cfg.adoptCliPid) {
      const probed = findPiTranscriptByPid(cfg.adoptCliPid);
      if (probed) path = probed.path;
    }
    if (path) {
      codexBridgeAttach(path, 'split-live');
    } else {
      if (cfg.cliSessionId) codexBridgePendingSessionId = cfg.cliSessionId;
      codexAdoptPendingPid = cfg.adoptCliPid;
      codexBridgeStartTimer();
    }
  }
}

function adoptIdleAdapter(cfg: Extract<DaemonToWorker, { type: 'init' }>): CliAdapter {
  return cfg.bridgeJsonlPath
    ? createCliAdapterSync('claude-code', undefined)
    : cfg.cliId === 'codex' || cfg.cliId === 'traex' || cfg.cliId === 'coco' || cfg.cliId === 'mtr' || cfg.cliId === 'pi'
      ? createCliAdapterSync(cfg.cliId, undefined)
      : ({ completionPattern: undefined, readyPattern: undefined } as CliAdapter);
}

function setupAdoptInputAdapter(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  if (cfg.cliId === 'codex' || cfg.cliId === 'traex' || cfg.cliId === 'pi') {
    cliAdapter = createCliAdapterSync(cfg.cliId, cfg.cliPathOverride);
  } else if (cfg.cliId === 'mtr') {
    cliAdapter = createCliAdapterSync('mtr', cfg.cliPathOverride);
  }
}

function setupAdoptIdleDetection(cfg: Extract<DaemonToWorker, { type: 'init' }>, label: string): void {
  idleDetector = new IdleDetector(adoptIdleAdapter(cfg));
  idleDetector.onIdle(() => {
    log(`Prompt detected (idle) — ${label} adopt mode`);
    try { bridgeDrainAndMaybeEmit(); } catch (err: any) { log(`Bridge emit error: ${err.message}`); }
    try { codexBridgeDrainAndMaybeEmit(); } catch (err: any) { log(`Codex bridge emit error: ${err.message}`); }
    markPromptReady();
  });
}

function seedBackendScreen(source: string, be: Pick<SessionBackend, 'captureCurrentScreen'>): void {
  try {
    const initial = be.captureCurrentScreen?.() ?? '';
    if (initial.length > 0) onPtyData(initial);
  } catch (err: any) {
    log(`${source} captureCurrentScreen failed: ${err.message}`);
  }
}

function captureBackendScreen(be: Pick<SessionBackend, 'captureCurrentScreen' | 'captureViewport'>): string {
  return be.captureViewport?.() ?? be.captureCurrentScreen?.() ?? '';
}

function busyProbeRegion(content: string): string {
  const lines = content.split(/\r?\n/);
  const tailLineCount = Math.max(12, Math.ceil(lines.length / 3));
  return lines.slice(-tailLineCount).join('\n');
}

function probeBusyPatternIdle(
  source: string,
  be: Pick<SessionBackend, 'captureCurrentScreen' | 'captureViewport'>,
): boolean {
  try {
    const content = captureBackendScreen(be);
    if (!content) return false;
    if (cliAdapter?.busyPattern) {
      if (cliAdapter.busyPattern.test(busyProbeRegion(content))) return false;
      log(`${source} idle probe: busy marker absent, marking prompt ready`);
      markPromptReady();
      return true;
    }
  } catch (err: any) {
    log(`${source} idle probe captureCurrentScreen failed: ${err.message}`);
  }
  return false;
}

function scheduleReattachIdleProbe(source: string, be: Pick<SessionBackend, 'captureCurrentScreen' | 'captureViewport'>): void {
  stopReattachIdleProbe();
  if (!cliAdapter?.busyPattern || (!be.captureCurrentScreen && !be.captureViewport)) return;
  reattachIdleProbeTimer = setTimeout(() => {
    reattachIdleProbeTimer = null;
    if (backend !== be || !awaitingFirstPrompt || isPromptReady) return;
    probeBusyPatternIdle(source, be);
  }, IDLE_PROBE_INTERVAL_MS);
  reattachIdleProbeTimer.unref?.();
}

function stopReattachIdleProbe(): void {
  if (reattachIdleProbeTimer) {
    clearTimeout(reattachIdleProbeTimer);
    reattachIdleProbeTimer = null;
  }
}

function stopBusyPatternIdleProbe(): void {
  if (busyPatternIdleProbeTimer) {
    clearTimeout(busyPatternIdleProbeTimer);
    busyPatternIdleProbeTimer = null;
  }
}

function scheduleBusyPatternIdleProbe(source: string): void {
  stopBusyPatternIdleProbe();
  if (!cliAdapter?.busyPattern || (!backend?.captureCurrentScreen && !backend?.captureViewport)) return;

  let attempts = 0;
  const tick = () => {
    busyPatternIdleProbeTimer = null;
    if (!backend || isPromptReady) return;
    attempts += 1;
    if (probeBusyPatternIdle(source, backend)) return;
    if (attempts < IDLE_PROBE_MAX_ATTEMPTS && !isPromptReady) {
      busyPatternIdleProbeTimer = setTimeout(tick, IDLE_PROBE_INTERVAL_MS);
      busyPatternIdleProbeTimer.unref?.();
    }
  };

  busyPatternIdleProbeTimer = setTimeout(tick, IDLE_PROBE_INTERVAL_MS);
  busyPatternIdleProbeTimer.unref?.();
}

function spawnCli(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  // (startupCommands one-shot is re-armed below, AFTER the reattach-vs-fresh
  // prediction — only a genuinely fresh CLI process replays them; see
  // willReattachPersistent.)
  // Re-deliver inputs that were in-flight when the previous CLI died (see
  // backend.onExit). killCli() already wiped pendingMessages, so these go to
  // the front; the normal flush paths (prompt detect / first-prompt timeout)
  // deliver them once the fresh CLI is ready. Adopt mode observes a CLI we
  // don't own — never replay into it.
  if (!cfg.adoptMode) {
    const carry = inflightInputs.takeCarryOver();
    if (carry.length > 0) {
      pendingMessages.unshift(...carry);
      log(`Re-queued ${carry.length} in-flight message(s) lost to CLI exit`);
    }
  }
  // ── Adopt mode: observe the user's existing terminal backend (no attach) ──
  if (cfg.adoptMode && cfg.adoptSource === 'herdr' && cfg.adoptHerdrSessionName && (cfg.adoptHerdrPaneId || cfg.adoptHerdrTarget)) {
    isTmuxMode = false;
    isPipeMode = true;
    isZellijMode = false;
    const cols = cfg.adoptPaneCols ?? PTY_COLS;
    const rows = cfg.adoptPaneRows ?? PTY_ROWS;
    const target = cfg.adoptHerdrTarget ?? cfg.adoptHerdrPaneId!;
    const herdrBe = new HerdrBackend(cfg.adoptHerdrSessionName, {
      externalTarget: {
        sessionName: cfg.adoptHerdrSessionName,
        target,
        paneId: cfg.adoptHerdrPaneId,
      },
    });
    effectiveBackendType = 'herdr';
    backend = herdrBe;
    herdrBe.spawn('', [], {
      cwd: cfg.workingDir,
      cols,
      rows,
      env: process.env as Record<string, string>,
    });

    seedBackendScreen('herdr adopt', herdrBe);

    setupAdoptTranscriptBridges(cfg);
    setupAdoptInputAdapter(cfg);
    setupAdoptIdleDetection(cfg, 'herdr');

    backend.onData(onPtyData);
    backend.onExit((code, signal) => {
      log(`Adopted herdr stream ended (code: ${code}, signal: ${signal})`);
      backend = null;
      isPromptReady = false;
      stopBridgeWatcher();
      send({ type: 'claude_exit', code, signal });
    });

    awaitingFirstPrompt = false;
    renderer?.markNewTurn();
    log(`Adopt mode (herdr): observing ${cfg.adoptHerdrSessionName}:${target} (${cols}x${rows})`);
    return;
  }

  // ── Adopt mode: pipe-pane the user's existing tmux pane (no attach) ──
  // ── Adopt mode: observe the user's existing pane (no attach / non-invasive) ──
  // tmux: pipe-pane (raw stream). zellij: dump-screen poll + action drive.
  if (cfg.adoptMode && (cfg.adoptTmuxTarget || cfg.adoptZellijPaneId)) {
    // We mark BOTH isTmuxMode and isPipeMode: the former keeps idle/spawn
    // logic on the observe track; the latter tells the WS handler to route
    // updates through the shared scrollback fan-out (because there is no
    // PTY-per-WS — we don't attach to anything).
    isTmuxMode = true;
    isPipeMode = true;
    isZellijMode = !!cfg.adoptZellijPaneId;
    const cols = cfg.adoptPaneCols ?? PTY_COLS;
    const rows = cfg.adoptPaneRows ?? PTY_ROWS;
    const observeBe: ObserveBackend = cfg.adoptZellijPaneId
      ? new ZellijObserveBackend(cfg.adoptZellijSession ?? '', cfg.adoptZellijPaneId, { cliPid: cfg.adoptCliPid })
      : new TmuxPipeBackend(cfg.adoptTmuxTarget!, { cliPid: cfg.adoptCliPid });
    effectiveBackendType = cfg.adoptZellijPaneId ? 'zellij' : 'tmux';
    backend = observeBe;
    observeBe.spawn('', [], {
      cwd: cfg.workingDir,
      cols,
      rows,
      env: process.env as Record<string, string>,
    });

    // Seed the shared scrollback with the pane's current screen so any
    // already-connected (or future) WS clients render meaningful content
    // immediately, instead of waiting for the next observe tick.
    seedBackendScreen(`${effectiveBackendType} adopt`, observeBe);

    setupAdoptTranscriptBridges(cfg);

    setupAdoptIdleDetection(cfg, 'pipe');
    setupAdoptInputAdapter(cfg);

    backend.onData(onPtyData);
    backend.onExit((code, signal) => {
      log(`Adopted pipe-pane stream ended (code: ${code}, signal: ${signal})`);
      backend = null;
      isPromptReady = false;
      stopBridgeWatcher();
      send({ type: 'claude_exit', code, signal });
    });

    awaitingFirstPrompt = false;
    renderer?.markNewTurn();
    const target = cfg.adoptZellijPaneId ? `${cfg.adoptZellijSession}/${cfg.adoptZellijPaneId}` : cfg.adoptTmuxTarget;
    log(`Adopt mode (${effectiveBackendType}): observing ${target} (${cols}x${rows})`);
    return;
  }

  cliAdapter = createCliAdapterSync(cfg.cliId as any, cfg.cliPathOverride);
  // backendType trust-but-verify + HARD GATE (PTY 退役): an explicit per-bot
  // config (or BACKEND_TYPE env override) bypasses config.ts's default, so the
  // worker re-probes the requested persistent backend here. A requested
  // tmux/herdr/zellij backend that isn't functional NO LONGER silently
  // degrades to raw PTY — that silent fallback was the root of the "secretly
  // running on PTY, then hitting all of PTY's problems" bug class. Instead we
  // refuse to spawn and post an actionable card (user_notify) telling the user
  // to install the backend, or to explicitly opt into PTY with BACKEND_TYPE=pty.
  //
  // Existing botmux sessions stay authoritative over the disposable "can we
  // create a new server?" probe: a live session reattaches regardless of a
  // transient probe failure (PR#249), so it's exempt from the gate.
  let effectiveBackend = cfg.backendType;
  {
    let available = true;
    let reason = '';
    let hasExistingSession = false;
    if (effectiveBackend === 'tmux') {
      hasExistingSession = TmuxBackend.hasSession(TmuxBackend.sessionName(cfg.sessionId));
      if (!hasExistingSession) {
        const probe = probeTmuxFunctional();
        available = probe.ok;
        if (!probe.ok) reason = probe.reason;
      }
    } else if (effectiveBackend === 'zellij') {
      // Like tmux, zellij's probe is a disposable background session, so a
      // live named session is more authoritative than a transient probe
      // failure (PR#249 semantics) — check it first so we reattach, not gate.
      hasExistingSession = ZellijBackend.hasSession(ZellijBackend.sessionName(cfg.sessionId));
      if (!hasExistingSession) {
        available = ZellijBackend.isAvailable();
        reason = 'zellij 功能性探针失败（需 zellij >= 0.44）';
      }
    } else if (effectiveBackend === 'herdr') {
      // herdr's isAvailable() is a cheap, non-destructive `herdr --version`
      // (not a disposable session probe), so it has no PR#249 false-negative
      // risk and needs no existing-session exemption.
      available = HerdrBackend.isAvailable();
      reason = 'herdr 功能性探针失败';
    }
    const decision = decideBackendGate({ requested: effectiveBackend, available, hasExistingSession });
    if (decision.action === 'gate') {
      const detail = reason || decision.reason;
      log(`${effectiveBackend} backend unavailable and silent PTY fallback is disabled (set BACKEND_TYPE=pty to opt in): ${detail}`);
      // user_notify is delivered to the Lark thread by the daemon (type:'error'
      // is log-only); send it BEFORE throwing so the card lands. The throw is
      // caught by the init handler, which sends type:'error' and exits — the
      // IPC channel flushes these small messages before exit.
      send({ type: 'user_notify', message: backendGateUserMessage(effectiveBackend, detail), turnId: cfg.turnId });
      throw new Error(`${effectiveBackend} backend unavailable; refusing silent PTY fallback (set BACKEND_TYPE=pty to opt in): ${detail}`);
    }
  }
  effectiveBackendType = effectiveBackend;
  const selectedBackend = selectSessionBackend({ sessionId: cfg.sessionId, backendType: effectiveBackend });
  isTmuxMode = selectedBackend.isTmuxMode;
  isPipeMode = selectedBackend.isPipeMode;
  isZellijMode = selectedBackend.isZellijMode;
  backend = selectedBackend.backend;
  const adapterSessionId = cfg.resume
    ? (cfg.originalSessionId ?? cfg.sessionId)
    : cfg.sessionId;

  // Claude Code appends a line to ~/.claude/projects/<cwd-hash>/<sid>.jsonl each
  // time the user submits. The adapter uses this file to verify paste+Enter
  // actually committed (rather than trusting a fixed sleep), so wire it up now.
  // Codex's adapter uses ~/.codex/history.jsonl (a fixed global path) directly,
  // so it needs no per-session wiring here.
  //
  // `claudeDataDir` is the Claude-family marker: set for claude-code AND its
  // forks (Seed → `.claude-runtime`), undefined for everything else. Every
  // JSONL/pid/bridge gate below keys off it instead of `cliId === 'claude-code'`,
  // so a fork inherits the whole submit-confirm + bridge-fallback machinery.
  let claudeDataDir = cliAdapter.claudeDataDir;
  // When this session will be file-sandboxed, the CLI's session jsonl is written
  // into the overlay's EPHEMERAL home upper (CLAUDE_CONFIG_DIR lives under $HOME),
  // invisible at the real path the bridge normally watches → "Bridge mark expired"
  // and the turn never relays (2026-06-10 incident). Redirect every jsonl/pid/
  // bridge gate below to the upper copy where the sandboxed CLI actually writes.
  const willFileSandbox =
    (cfg.sandbox === true || sandboxEnabled()) &&
    (effectiveBackendType === 'pty' || effectiveBackendType === 'tmux') &&
    !!process.env.SESSION_DATA_DIR;
  if (claudeDataDir && willFileSandbox) {
    const redirected = sandboxedClaudeDataDir(cfg.sessionId, claudeDataDir);
    log(`[sandbox] redirecting Claude bridge dataDir → overlay upper: ${redirected}`);
    claudeDataDir = redirected;
  }
  // v2 read isolation: relocate the CLI's data root into the per-bot BOT_HOME
  // (`<BOTMUX_HOME>/bots/<appId>/{claude,codex}`) so each bot's transcripts/memory
  // land in its OWN (Seatbelt-allowed) dir, NOT the shared/global ~/.claude|~/.codex
  // (which v2 denies wholesale). Decided EARLY — like willFileSandbox above — so
  // every JSONL/bridge/resume path below already targets the per-bot dir. The
  // matching CLAUDE_CONFIG_DIR/CODEX_HOME env, per-bot provisioning and Seatbelt
  // wrapper are applied at spawn time further down. This gate is the SINGLE
  // decision point: configured-but-unenforceable fail-closes HERE (never run a
  // session unisolated that asked for isolation).
  const readIsolationGate = evaluateReadIsolationGate({
    configured: cfg.readIsolation === true,
    adapterSupports: cliAdapter.supportsReadIsolation === true,
    wrapperCliSet: !!cfg.wrapperCli,
    platform: process.platform,
    sessionDataDirSet: !!process.env.SESSION_DATA_DIR,
  });
  if (readIsolationGate.failClosedReason) {
    throw new Error(`[read-isolation] refusing to start session ${cfg.sessionId}: ${readIsolationGate.failClosedReason}`);
  }
  const willReadIsolate = readIsolationGate.enabled;
  // Every bot — isolated OR not — gets its own BOT_HOME dir as a ready-made private-
  // storage slot. An isolated sibling denies this path regardless of whether the owner
  // is isolated (deny uses the full bots.json), so a non-isolated bot can drop private
  // data here without any manual mkdir. Isolated bots additionally provision their CLI
  // config/creds into it below.
  const ownBotHome = process.env.SESSION_DATA_DIR
    ? botHomePath(dirname(process.env.SESSION_DATA_DIR), cfg.larkAppId)
    : undefined;
  if (ownBotHome) {
    try {
      mkdirSync(ownBotHome, { recursive: true });
    } catch (e) {
      log(`[read-isolation] WARN could not create BOT_HOME ${ownBotHome}: ${(e as Error).message}`);
    }
  }
  let isolationBotHome: string | undefined;
  if (willReadIsolate) {
    isolationBotHome = ownBotHome!;
    const isClaudeFam = !!claudeDataDir;
    if (isClaudeFam) claudeDataDir = join(isolationBotHome, 'claude');
    // Provision the per-bot config dir (auth + onboarding/trust seed + hooks for claude;
    // auth/config copy for codex) so the CLI starts fully set up under the Seatbelt wrapper.
    provisionIsolatedBotHome(isolationBotHome, cfg.workingDir, isClaudeFam, cfg.cliId, cliAdapter.hookInstall, log);
  }
  // Predict reattach vs fresh BEFORE the resume pre-flight. On a persistent
  // backend (tmux/herdr/zellij) a daemon restart finds the CLI process still
  // alive in its pane, so the backend will `attach` to the live process and
  // IGNORE the bin/args — there is no spawn, and the live process still holds
  // the full in-memory conversation. In that case the resume-vs-fresh question
  // is moot: we must NOT run the pre-flight fallback (which would drop --resume
  // and post a misleading "started a fresh clean session — context lost" card
  // on EVERY restart, e.g. for a sandboxed session whose transcript lives in
  // an ephemeral overlay upper that the probe can't see). Computed here (not at
  // the spawn site below) so the pre-flight can short-circuit on it.
  const persistentSessionName = effectiveBackendType === 'tmux'
    ? TmuxBackend.sessionName(cfg.sessionId)
    : effectiveBackendType === 'herdr'
      ? HerdrBackend.sessionName(cfg.sessionId)
      : effectiveBackendType === 'zellij'
        ? ZellijBackend.sessionName(cfg.sessionId)
      : undefined;
  // [read-isolation] Before we decide to reattach a persistent pane: a pane can
  // survive a daemon restart still running a CLI that may NOT be isolated (e.g.
  // spawned before isolation was enabled, or by an old build). Isolation is only
  // injectable at spawn time, so reattaching such a pane would silently run
  // unisolated. We stamp a boot-id marker when we spawn an isolated pane; if this
  // isolated bot's existing pane is NOT stamped by THIS daemon lifetime, kill it
  // so the probe below sees no pane and we cold-spawn fresh isolated. A pane from
  // this lifetime (suspend→resume) keeps its marker → reattaches normally (it is
  // still the isolated process). This lets isolated bots use tmux/zellij/herdr.
  if (cfg.readIsolation === true && persistentSessionName && effectiveBackendType !== 'pty') {
    const paneLive = effectiveBackendType === 'tmux'
      ? TmuxBackend.hasSession(persistentSessionName)
      : effectiveBackendType === 'zellij'
        ? ZellijBackend.hasSession(persistentSessionName)
        : HerdrBackend.hasSession(persistentSessionName);
    if (paneLive) {
      let marker: string | null = null;
      try {
        marker = readFileSync(
          join(process.env.SESSION_DATA_DIR ?? '', 'read-isolation', `${cfg.sessionId}.boot`),
          'utf-8',
        );
      } catch { /* no marker → pane was spawned WITHOUT isolation */ }
      if (isolatedPaneReattachSafe(marker)) {
        // Pane was spawned isolated (marker present) → still confined on the running
        // process even across daemon restarts → warm reattach is safe and preserves
        // resume/context + tmux idle-suspend.
        log(`[read-isolation] reattaching isolated persistent pane (${cfg.sessionId})`);
      } else {
        // No marker → pane predates isolation (or an old build) → could be running
        // UNISOLATED → kill it so the probe below cold-spawns fresh isolated.
        log(`[read-isolation] unmarked persistent pane for ${cfg.sessionId} (not spawned isolated) — killing + cold-spawning isolated`);
        try {
          killPersistentSession(effectiveBackendType as PersistentBackendType, persistentSessionName);
        } catch (e) {
          throw new Error(`[read-isolation] refusing to start session ${cfg.sessionId}: could not kill stale persistent pane (${(e as Error).message})`);
        }
      }
    }
  }
  const willReattachPersistent = persistentSessionName
    ? effectiveBackendType === 'tmux'
      ? TmuxBackend.hasSession(persistentSessionName)
      : effectiveBackendType === 'zellij'
        ? ZellijBackend.hasSession(persistentSessionName)
        : HerdrBackend.hasSession(persistentSessionName)
    : false;

  // Re-arm the startup-commands one-shot ONLY for a genuinely fresh CLI process.
  // A reattach to a LIVE persistent pane (daemon-restart recovery) is the SAME
  // CLI with /effort etc. already applied — replaying would re-type them (and
  // /clear,/compact would corrupt the recovered context). hasRun=true ⇒ skip.
  // Fresh spawns (incl. resume that starts a new CLI, where hasSession is false)
  // arm it. spawnCli is synchronous up to backend spawn, so this lands before
  // any flushPending consumes the flag.
  hasRunStartupCommands = !shouldRunStartupCommandsOnSpawn({ willReattachPersistent });
  // Re-arm the bare-shell launch detector for this spawn (fresh OR reattach). It
  // runs once on the first flush and only fires when the pane leaf is actually a
  // bare shell, so a healthy reattach (leaf = the live CLI) self-excludes while a
  // reattach onto a pane that has degraded to a bare shell still gets the
  // diagnostic instead of having the prompt typed into it.
  bareShellLaunchBlocked = false;
  bareShellChecked = false;

  // ── Resume pre-flight check + two-tier fallback ──────────────────────────
  // Tier 1 (adapter probe): adapter.checkResumeTargetExists returns false
  // → skip --resume, spawn FRESH.
  // Tier 2 (restart count): 2nd consecutive in-worker restart → force FRESH,
  // regardless of probe result. This covers adapters without a probe AND
  // probe/spawn races (target vanishes between the check and spawn).
  //
  // Supersedes the claude-family-only inline probe (PR #189) with a
  // general adapter-owned check (cleaner boundary) + a numeric safety net.
  //
  // User impact: losing context is better than a 4× daemon-side crash loop
  // that leaves the bot stuck in "crashed N times" state until the human
  // re-closes the session. Skipped entirely when reattaching to a live
  // persistent pane (no spawn happens, no context is lost).
  let effectiveResume = cfg.resume ?? false;
  let effectiveCliSessionId = cfg.cliSessionId;
  let effectiveAdapterSessionId = adapterSessionId;
  const tier2ForceFresh = effectiveResume && consecutiveInWorkerRestarts >= 2;
  let tier1ProbeFalse = false;
  if (effectiveResume && !tier2ForceFresh && !willReattachPersistent) {
    const probe = cliAdapter.checkResumeTargetExists?.({
      sessionId: effectiveAdapterSessionId,
      cliSessionId: effectiveCliSessionId,
      workingDir: cfg.workingDir,
      dataDir: claudeDataDir,
    });
    if (probe === false) tier1ProbeFalse = true;
  }
  const fallBackToFresh =
    effectiveResume && !willReattachPersistent && (tier1ProbeFalse || tier2ForceFresh);
  if (fallBackToFresh) {
    const reason = tier2ForceFresh
      ? `consecutive restart x${consecutiveInWorkerRestarts} — 2nd failed resume attempt`
      : 'adapter confirmed resume target does not exist on disk';
    log(`Resume fallback: dropping --resume (${reason}) → fresh session ${cfg.sessionId}`);
    effectiveResume = false;
    effectiveCliSessionId = undefined;
    effectiveAdapterSessionId = cfg.sessionId;
    // Recompute the claude-family JSONL path: it now targets the FRESH
    // sessionId (fresh spawn creates <newSid>.jsonl, not the old one).
    if (claudeDataDir) {
      (backend as TmuxBackend | PtyBackend | ZellijBackend).claudeJsonlPath =
        claudeJsonlPathForSession(effectiveAdapterSessionId, cfg.workingDir, claudeDataDir);
    }
    // Single human-visible warning. Spam guard: at most once per worker
    // lifecycle (a 4× crash loop otherwise duplicates the notice).
    if (!resumeFallbackNotified) {
      resumeFallbackNotified = true;
      send({
        type: 'user_notify',
        turnId: currentBotmuxTurnId,
        message:
          `⚠️  历史会话（${(cfg.cliSessionId ?? cfg.originalSessionId ?? cfg.sessionId).substring(0, 16)}…）` +
          `无法恢复，已为你**新起一个干净会话**（原因：${reason}）。\n` +
          `之前的上下文不会带到本轮，需要的话请简述背景。`,
      });
    }
    // Reset the counter so the fresh spawn gets a clean 2-attempt budget in
    // case IT crashes later for an unrelated reason.
    consecutiveInWorkerRestarts = 0;
  } else if (claudeDataDir) {
    // Watch where the spawned CLI will actually write: the resumed conversation
    // when resuming, else the fresh session id (a stale cliSessionId would point
    // the bridge at the gone jsonl).
    const bridgeWatchId = effectiveResume
      ? (effectiveCliSessionId ?? effectiveAdapterSessionId)
      : effectiveAdapterSessionId;
    (backend as TmuxBackend | PtyBackend | ZellijBackend).claudeJsonlPath =
      claudeJsonlPathForSession(bridgeWatchId, cfg.workingDir, claudeDataDir);
  }
  // Publish the resolved resume semantics so any late-attach timer (hermes,
  // cursor, …) driven by codexBridgeStartTimer sees the SAME mode the spawn
  // used. Without this, Tier-1/Tier-2 fresh demotion would still use
  // `lastInitConfig.resume` (= true) and baseline an empty store, swallowing
  // the fresh session's first turn.
  lastSpawnEffectiveResume = effectiveResume;
  lastSpawnEffectiveCliSessionId = effectiveCliSessionId;

  // ttadk 网关：模型走 ttadk 自己的 `-m`（启动期注入到 ttadk 前缀，见下方 wrapperCli
  // 分支），不能再把 cfg.model 透给底层适配器，否则真实 CLI 会再吃一个 --model 重复。
  const ttadkGateway = isTtadkWrapper(cfg.wrapperCli);
  // When a bot has startupCommands AND this CLI bakes the first prompt into
  // launch args (passesInitialPromptViaArgs, e.g. Gemini -i), don't bake it —
  // route it through the input queue instead so startupCommands run first
  // (flushPending's hook can't precede an args-baked prompt). The init handler
  // mirrors this when deciding whether to enqueue the prompt.
  // Also defer on RESUME for adapters whose initial-prompt launch flag is
  // silently ignored when continuing a session (OpenCode `--prompt` + `-s`):
  // baking it into args would drop the message that triggered the resume.
  const deferInitialPrompt = shouldDeferInitialPromptForStartup({
    hasStartupCommands: !!cfg.startupCommands?.length,
    adoptMode: cfg.adoptMode === true,
    passesInitialPromptViaArgs: cliAdapter.passesInitialPromptViaArgs === true,
  }) || (effectiveResume && cliAdapter.initialPromptArgsIgnoredOnResume === true);
  // Per-bot local read isolation: assemble the Seatbelt profile context (the gate
  // already fail-closed above — reaching here with willReadIsolate means it is
  // enforceable). The worker is on the host (NOT sandboxed), so it holds the
  // secret; only the spawned CLI child is confined. A reattach that reaches here
  // is safe: the stale-pane guard above already killed any persistent pane not
  // stamped as isolated, so `willReattachPersistent` can now only be true for a
  // pane spawned isolated (still the confined process).
  let readIsolationCtx: V2IsolationContext | undefined;
  if (willReadIsolate) {
    const sessionDataDir = process.env.SESSION_DATA_DIR!;
    readIsolationCtx = {
      homeDir: homedir(),
      botmuxHome: dirname(sessionDataDir),
      sessionDataDir,
      currentAppId: cfg.larkAppId,
      extraDenyPaths: cfg.readDenyExtraPaths,
    };
    // Write this bot's OWN send-credential into its BOT_HOME (the same per-bot
    // private storage as its CLI data; siblings' BOT_HOMEs are whole-denied).
    // `botmux send` reads the secret from here instead of bots.json — so the
    // secret never travels via env/argv (no cross-bot `ps aux` leak) and the CLI
    // never needs to escape the sandbox.
    try {
      const credPath = sendCredFilePath(sessionDataDir, cfg.larkAppId);
      mkdirSync(dirname(credPath), { recursive: true });
      writeFileSync(
        credPath,
        JSON.stringify({ larkAppId: cfg.larkAppId, larkAppSecret: cfg.larkAppSecret, brand: cfg.brand }),
        { mode: 0o600 },
      );
    } catch (e) {
      log(`[read-isolation] WARN could not write send-cred file: ${(e as Error).message}`);
    }
  }
  const args = cliAdapter.buildArgs({
    sessionId: effectiveAdapterSessionId,
    resume: effectiveResume,
    workingDir: cfg.workingDir,
    resumeSessionId: effectiveCliSessionId,
    initialPrompt: deferInitialPrompt ? undefined : (cfg.prompt || undefined),
    botName: cfg.botName,
    botOpenId: cfg.botOpenId,
    larkAppId: cfg.larkAppId,
    locale: cfg.locale,
    model: ttadkGateway ? undefined : cfg.model,
    disableCliBypass: cfg.disableCliBypass === true,
    skillPluginDir: cfg.skillPluginDir,
    readIsolation: willReadIsolate,
  });

  // Extra args from env (CLI_DISABLE_DEFAULT_ARGS is removed — adapters own their defaults)
  const extra = (process.env.CLI_EXTRA_ARGS ?? '').trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  // Claude Code 在 root/sudo 下会拒绝 --dangerously-skip-permissions 并立即 exit。
  // botmux 必须带这个 flag（话题里没法弹交互式审批），所以为 root 自动注入
  // IS_SANDBOX=1 走 Claude Code 的受控环境逃生舱。Seed 是 Claude Code fork，同样
  // 受此限制 → 按 claude 家族判断。用户显式设了就尊重不覆盖。
  const injectClaudeSandbox =
    !!claudeDataDir &&
    process.getuid?.() === 0 &&
    !process.env.IS_SANDBOX;
  if (injectClaudeSandbox) {
    log('Detected root user — injecting IS_SANDBOX=1 for Claude-family CLI');
  }

  // Claude Code 2.1.x：`--resume` 一个「空闲 >70min 且累计 >10 万 token」的会话会弹
  // 交互式菜单（Resume from summary / full / Don't ask again），botmux 无法导航 →
  // 进程卡死（issue #62）。把 token 阈值顶到极大让触发门永远命中 `tokens < threshold`
  // 而 return null → 菜单不弹、按 full session 原样续（走 summary 会触发 /compact，
  // 破坏 bridge 的会话连续性追踪）。用户显式设了就尊重。注意：该 key 必须同时进
  // BOTMUX_INJECTED_ENV_KEYS 白名单，否则 tmux backend 不会把它透传进 pane。
  // Seed 是 Claude Code fork，同样有 resume-summary 菜单 → 按 claude 家族判断。
  const claudeResumeTokenThreshold =
    claudeDataDir
      ? process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD ?? '2147483647'
      : undefined;

  // Reattach vs fresh was predicted above (see willReattachPersistent) so the
  // resume pre-flight could short-circuit on it; reuse it here so the log line
  // tells the truth. When a bmx-* tmux session is still alive, TmuxBackend.spawn
  // ignores the bin/args and just `tmux attach-session`s — logging
  // `Spawning: <new bin>` in that case is misleading and has cost real
  // debugging time. (CliId-mismatch reattach is now blocked upstream in
  // restoreActiveSessions / killStalePids.)
  if (willReattachPersistent) {
    log(`Re-attaching to existing ${effectiveBackendType} session: ${persistentSessionName} (requested CLI: ${cliAdapter.resolvedBin})`);
  } else {
    log(`Spawning fresh CLI: ${cliAdapter.resolvedBin} ${args.join(' ')} (cwd: ${cfg.workingDir})`);

    // Pre-flight: resolvedBin resolves here (lazy). If resolveCommand fell back
    // to a bare name and it isn't on the worker's PATH either, the spawn would
    // fail repeatedly and surface only as a generic crash-loop ("X crashed N
    // times"), with no hint about WHY. Instead surface ONE clear, reproducible
    // message and stop — the user can fix PATH / install the CLI and retry.
    const wantBin = cliAdapter.resolvedBin;
    if (!locateOnPath(wantBin)) {
      log(`CLI binary not found: ${wantBin} (PATH=${process.env.PATH ?? ''})`);
      const probe = isAbsolute(wantBin) ? `ls -l ${wantBin}` : `which ${wantBin}`;
      send({
        type: 'user_notify',
        turnId: currentBotmuxTurnId,
        message:
          `无法启动 ${cliName()}：找不到可执行文件「${wantBin}」。\n` +
          `请在运行 botmux daemon 的这台机器上确认它已安装并在 PATH 中（自查：${probe}），然后重发消息重试。\n` +
          `当前 daemon PATH=${process.env.PATH ?? '(空)'}`,
      });
      return;
    }
  }

  // Build the child env. redactChildEnv() DELETES the keys that must not leak
  // (the bot's bare LARK_APP_* creds + CLAUDECODE) rather than setting them to
  // `undefined`: node-pty stringifies an `undefined` env value to the literal
  // string "undefined" instead of omitting the key, so `{ ...env, LARK_APP_ID:
  // undefined }` would leave LARK_APP_ID="undefined" visible to the child and
  // any SDK probing `process.env.LARK_APP_ID` would still take the Lark path.
  // The child needs neither bare cred: `botmux send` resolves creds from
  // bots.json on disk (im/lark/client.ts), `botmux ask` routes via the
  // namespaced BOTMUX_LARK_APP_ID injected below; the worker keeps its own
  // bare creds (forkWorker) for lark-upload. See utils/child-env.ts.
  const childEnv = redactChildEnv(process.env);
  // Put the daemon-written wrapper dir (~/.botmux/bin/botmux = THIS build) ahead of any
  // stale npm-global botmux in PATH, so the agent's `botmux` is always this build. Matters
  // most under read isolation: only this build has the send-cred reader — a shadowing stale
  // build can't read bots.json (Seatbelt-denied) → `botmux send` fails "Bot not registered".
  // (The tmux backend re-prepends this in its pane script after rcfile load; this covers the
  // pty/direct-spawn path, whose child inherits childEnv.PATH directly.)
  childEnv.PATH = `${join(homedir(), '.botmux', 'bin')}:${childEnv.PATH ?? ''}`;
  // §5 of botmux ask v0.1.7 — `botmux ask buttons` reads these to find the
  // daemon socket, route the card back to this thread, and resolve the
  // approver allowlist against session.owner. Missing env → exit 2.
  childEnv.BOTMUX_SESSION_ID = cfg.sessionId;
  childEnv.BOTMUX_CHAT_ID = cfg.chatId;
  childEnv.BOTMUX_LARK_APP_ID = cfg.larkAppId;
  childEnv.BOTMUX_ROOT_MESSAGE_ID = cfg.rootMessageId;
  // NOTE: under read isolation `botmux send` gets this bot's secret from the worker-
  // written cred FILE in its BOT_HOME (send-cred.json, see sendCredFilePath) located
  // via the BOTMUX_LARK_APP_ID above — NOT from the env. The secret is deliberately kept OUT
  // of the child env so a sibling bot cannot recover it via `ps eww` / process-info
  // (Seatbelt denies file reads, not process-metadata enumeration). Non-isolated bots
  // read bots.json unchanged (send fallback in cli.ts).
  // Inject an explicit false when disabled so child `botmux bots list` cannot
  // drift from the daemon because of stale rcfile/tmux environment.
  const chatBotDiscovery = resolveChatBotDiscoveryConfig();
  childEnv.BOTMUX_LARK_LIST_BOTS_API_ENABLED = chatBotDiscovery.listBotsApiEnabled ? 'true' : 'false';
  childEnv.BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS = String(chatBotDiscovery.listBotsApiTimeoutMs);
  if (cliAdapter.injectsReadyHook) childEnv.BOTMUX_READY_COMMAND = sessionReadyHookCommand();
  // Initial value only; long-lived panes get the latest turn via the JSON pid marker.
  if (cfg.turnId) childEnv.BOTMUX_TURN_ID = cfg.turnId;
  if (injectClaudeSandbox) childEnv.IS_SANDBOX = '1';
  if (claudeResumeTokenThreshold) childEnv.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = claudeResumeTokenThreshold;
  // Adapter-supplied env: points Claude-family forks at their data root (Seed's
  // CLAUDE_CONFIG_DIR → `.claude-runtime`). Keys here are also in the tmux
  // passthrough whitelist (BOTMUX_INJECTED_ENV_KEYS) so the tmux backend forwards
  // them past the server's global env.
  if (cliAdapter.spawnEnv) Object.assign(childEnv, cliAdapter.spawnEnv);

  // v2 read isolation: point the CLI at its PER-BOT config dir (set AFTER spawnEnv so
  // it overrides any adapter default). claude → CLAUDE_CONFIG_DIR, codex → CODEX_HOME.
  // Both are in BOTMUX_INJECTED_ENV_KEYS so the tmux backend forwards them into the
  // pane; without this the CLI falls back to the global ~/.claude|~/.codex which the
  // Seatbelt wrapper denies → it can't read its own data and won't start.
  if (isolationBotHome) {
    if (claudeDataDir) childEnv.CLAUDE_CONFIG_DIR = claudeDataDir; // = <BOT_HOME>/claude
    else childEnv.CODEX_HOME = join(isolationBotHome, 'codex');
  }

  // Per-bot env (bots.json `env`): extra vars for THIS bot's CLI only — e.g.
  // ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN to run a bot on GLM/a 3rd-party
  // provider, an HTTPS_PROXY, or a CLI feature flag. Passed as injectEnv (NOT
  // merged into childEnv) so the tmux/zellij backends inject it via the per-pane
  // `/usr/bin/env` prefix and never into the shared backing-server global env,
  // keeping it from leaking across bots. Re-sanitized here (crossed IPC).
  const perBotInjectEnv = sanitizePerBotEnv(cfg.env);
  const perBotInjectKeys = Object.keys(perBotInjectEnv);
  if (perBotInjectKeys.length) log(`Injecting ${perBotInjectKeys.length} per-bot env var(s): ${perBotInjectKeys.join(', ')}`);

  // ── File sandbox (oncall): wrap the CLI in bwrap so it can only touch a
  // per-session project copy + de-identified config. The agent's `botmux send`
  // routes through a daemon-side outbox watcher (creds never enter the sandbox).
  // PTY backend only for the spike; falls back to direct spawn on any failure.
  let spawnBin = cliAdapter.resolvedBin;
  let spawnArgs = args;
  let spawnCwd = cfg.workingDir;

  // Read isolation: wrap the whole CLI process in a macOS Seatbelt sandbox that
  // denies reads of the sensitive paths (blocklist). The CLI bypasses its OWN
  // sandbox (see adapter) so the outer wrapper is the sole enforcer. Non-darwin
  // platforms already fail-closed at the gate above (Linux bwrap is a TODO).
  if (readIsolationCtx) {
    // Seatbelt matches CANONICAL paths (it resolves symlinks), so realpath every
    // deny/allow before emitting the profile — otherwise a sensitive root reached
    // through a symlinked prefix (e.g. a symlinked home / SESSION_DATA_DIR) would
    // silently fail-open (the /tmp→/private/tmp class of miss). realpath-if-exists:
    // a non-existent path has nothing to read, so its literal form is harmless.
    // The ROOT dirs are canonicalized FIRST (profileCtx) so the regex patterns —
    // which can't be realpath'd as a result — are built on canonical prefixes too.
    const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };
    // v2 HYBRID model: whole-deny ~/.claude|~/.codex (F1 fix — own CLI data is redirected
    // into BOT_HOME, readable) + surgical-deny only the cross-bot-SENSITIVE parts of the
    // otherwise-readable ~/.botmux + system creds. Per-bot dirs (bots/, .lark-cli-bots/)
    // are denied WHOLESALE and per-bot session files by filename PATTERN, so a newly-
    // added bot is covered without cold-restarting this one and nothing enumerates
    // sibling app ids; the own slice is re-opened via carve-outs — allow subpaths + a
    // file-read-metadata traverse shim so Codex can realpath() its CODEX_HOME through
    // the denied parent. Admin readDenyExtraPaths become FINAL denies (win over the
    // own-allow).
    const profileCtx: V2IsolationContext = {
      ...readIsolationCtx,
      homeDir: canonical(readIsolationCtx.homeDir),
      botmuxHome: canonical(readIsolationCtx.botmuxHome),
      sessionDataDir: canonical(readIsolationCtx.sessionDataDir),
    };
    const denyPaths = buildV2DenyPaths(profileCtx).map(canonical);
    const denyRegexes = buildV2DenyRegexes(profileCtx);
    const carve = buildV2CarveOuts(profileCtx);
    const allowPaths = carve.allowPaths.map(canonical);
    const finalDenyPaths = carve.finalDenyPaths.map(canonical);
    const traverseDirs = carve.traverseDirs.map(canonical);
    if (!locateOnPath('sandbox-exec')) {
      throw new Error(`[read-isolation] refusing to start session ${cfg.sessionId}: sandbox-exec not found`);
    }
    const profileDir = join(process.env.SESSION_DATA_DIR!, 'read-isolation');
    mkdirSync(profileDir, { recursive: true });
    const profilePath = join(profileDir, `${cfg.sessionId}.sb`);
    writeFileSync(profilePath, buildSeatbeltProfile(denyPaths, allowPaths, finalDenyPaths, traverseDirs, denyRegexes), { mode: 0o600 });
    seatbeltProfilePath = profilePath;
    spawnArgs = ['-f', profilePath, spawnBin, ...spawnArgs];
    spawnBin = 'sandbox-exec';
    log(`[read-isolation] wrapping ${cliAdapter.id} in Seatbelt: sandbox-exec -f ${profilePath}`);
  }
  // [read-isolation] Fresh isolated spawn on a persistent backend: stamp the pane
  // with this daemon's boot id so a later suspend→resume reattach can be trusted
  // (see the stale-pane guard above). pty needs no marker (never reattached).
  if (readIsolationCtx && persistentSessionName && !willReattachPersistent) {
    try {
      const markerDir = join(process.env.SESSION_DATA_DIR!, 'read-isolation');
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(join(markerDir, `${cfg.sessionId}.boot`), cfg.daemonBootId ?? '', { mode: 0o600 });
    } catch { /* non-fatal: worst case a same-lifetime reattach cold-spawns instead */ }
  }
  // Sandbox wraps the spawned binary in bwrap. Works for pty (PtyBackend runs
  // bwrap directly) and tmux (the tmux pane's command becomes `bwrap … -- cli`);
  // env is carried via bwrap --setenv (see prepareSandbox), not the backend.
  const sandboxOn = cfg.sandbox === true || sandboxEnabled();
  if (sandboxOn) {
    // FAIL-SAFE (not fail-open): when the sandbox is requested, a missing
    // precondition (no SESSION_DATA_DIR, or a backend we can't wrap) must be a
    // HARD ERROR, never a silent skip — otherwise the CLI would spawn UNSANDBOXED
    // with full host write access and no log, the exact opposite of the
    // oncall-untrusted-agent invariant. In normal operation worker-pool sets
    // SESSION_DATA_DIR and the backend is pty/tmux, so this never trips.
    const dataDir = process.env.SESSION_DATA_DIR;
    if (effectiveBackendType !== 'pty' && effectiveBackendType !== 'tmux') {
      const msg = `Sandbox ENABLED but backend "${effectiveBackendType}" is not sandboxable (only pty/tmux) — aborting spawn to avoid an unsandboxed run`;
      log(msg);
      throw new Error(msg);
    }
    if (!dataDir) {
      const msg = 'Sandbox ENABLED but SESSION_DATA_DIR is unset — aborting spawn to avoid an unsandboxed run';
      log(msg);
      throw new Error(msg);
    }
    try {
      if (willReattachPersistent) {
        // Daemon-restart reattach to a persistent (tmux/herdr/zellij) pane whose
        // bwrap'd CLI is STILL ALIVE. backend.spawn() ignores bin/args here and
        // just re-attaches, and the live CLI is bound to its own namespace-pinned
        // overlay — so we must NOT unmount/remount (prepareSandbox would leave a
        // duplicate host-side overlay the CLI isn't using). We only re-wire the
        // outbox watcher (so the live CLI's `botmux send` keeps being serviced)
        // and the cleanup ref (so close/exit reclaims the residue). No re-prep.
        const att = attachSandboxOutbox({ sessionId: cfg.sessionId, dataDir });
        if (att) {
          if (sandboxStopWatcher) { try { sandboxStopWatcher(); } catch { /* */ } }
          if (sandboxCleanup) { try { sandboxCleanup(); } catch { /* */ } }
          sandboxCleanup = att.cleanup;
          sandboxStopWatcher = startOutboxWatcher(att.outbox, childEnv, cfg.sessionId);
          log(`Sandbox REATTACH (${cfg.cliId}): live pane CLI kept, re-wired outbox=${att.outbox} (no remount)`);
        } else {
          // No sandbox tree on disk for a session we're reattaching to: the
          // pane's CLI may be unsandboxed (sandbox enabled after it spawned). Do
          // NOT remount under a live CLI; just continue the reattach as-is.
          log(`Sandbox REATTACH (${cfg.cliId}): no on-disk sandbox tree — reattaching live pane without re-prep`);
        }
      } else {
        const sbx = prepareSandbox({
          enabled: sandboxOn,
          cliId: cfg.cliId,
          sessionId: cfg.sessionId,
          sourceWorkingDir: cfg.workingDir,
          dataDir,
          cliBin: cliAdapter.resolvedBin,
          cliArgs: args,
          hidePaths: cfg.sandboxHidePaths ?? [],
          authPaths: cliAdapter.authPaths,
          extraExecPaths: cliAdapter.sandboxExtraExecPaths?.(),
          readonlyRoots: cfg.skillReadonlyRoots ?? [],
          userReadonlyPaths: cfg.sandboxReadonlyPaths ?? [],
          net: cfg.sandboxNetwork !== false,
        });
        if (sbx) {
          spawnBin = sbx.bin;
          spawnArgs = sbx.args;
          // In the overlay model the child still chdirs to projectMount (via bwrap
          // --chdir), so spawnCwd stays the real workingDir; the overlay merged dir
          // is bound there. sbx.workDir is the UPPER changeset (for landing), NOT a cwd.
          Object.assign(childEnv, sbx.env);
          if (sandboxStopWatcher) { try { sandboxStopWatcher(); } catch { /* */ } }
          if (sandboxCleanup) { try { sandboxCleanup(); } catch { /* */ } }
          sandboxCleanup = sbx.cleanup;
          // session-id is FORCED here so a relayed send can't target another session.
          sandboxStopWatcher = startOutboxWatcher(sbx.outbox, childEnv, cfg.sessionId);
          log(`Sandbox ON (${cfg.cliId}): upper=${sbx.workDir} outbox=${sbx.outbox}`);
        } else {
          // Sandbox was requested but prepareSandbox returned null (a required
          // overlay mount failed, or non-Linux). Fail safe: do NOT silently run
          // unsandboxed — surface a hard error so the session doesn't leak.
          log(`Sandbox ENABLED but prepare returned null (mount failed / unsupported) — aborting spawn to avoid an unsandboxed run`);
          throw new Error('sandbox requested but could not be established');
        }
      }
    } catch (err: any) {
      log(`Sandbox prepare failed (${err.message}) — aborting (sandbox is a hard requirement when enabled)`);
      throw err;
    }
  }

  // 通用启动前缀（wrapperCli）：把启动命令重写成 `<wrapperCli> <CLI 参数>`（首 token 当
  // bin 走 PATH 解析），无需 wrapper 脚本、跨系统。aiden x claude 形态会剥掉 aiden 拒收的
  // --settings（见 buildWrappedLaunch）。与文件沙盒互斥：沙盒已把命令重写成 bwrap，叠加
  // 前缀会破坏隔离，故 sandboxOn 时跳过并告警（网关 + oncall 沙盒本就不是合理组合）。
  // CJADK_INTERACTIVE is a cjadk-only knob we set on the cjadk wrapper branch
  // below. Strip any value inherited from the daemon's own env first so a
  // daemon launched under `cjadk feishu` (which exports it) can't leak it via
  // the tmux env allowlist into EVERY bot's pane — only the cjadk branch should
  // ever (re)set it. Harmless for non-cjadk CLIs (they don't read it), but this
  // keeps the behaviour intentional rather than ambient. (Codex review note.)
  delete (childEnv as Record<string, string>).CJADK_INTERACTIVE;

  if (cfg.wrapperCli && cfg.wrapperCli.trim()) {
    if (sandboxOn) {
      log(`wrapperCli="${cfg.wrapperCli}" ignored: file sandbox enabled and takes precedence (cannot combine launch prefix with bwrap)`);
    } else {
      const launch = buildWrappedLaunch(cfg.wrapperCli, spawnArgs, (b) => locateOnPath(b) ?? b, {
        ttadkModel: cfg.model,
      });
      if (launch.bin) {
        spawnBin = launch.bin;
        spawnArgs = launch.args;
        log(`Launch prefix: spawning ${spawnBin} ${spawnArgs.slice(0, 2).join(' ')} … (cliId=${cfg.cliId})`);
        // ttadk runs its launched agent through a gateway that pops an interactive
        // model-picker unless `-m <model>` is given. buildWrappedLaunch injects
        // `-m <bot.model || glm-5.1> --skip-check` into the ttadk prefix above
        // (CoCo excluded — it takes no -m). The model is sourced from the bot's
        // `model` config (editable in the dashboard), NOT baked into wrapperCli.
        if (ttadkGateway) {
          log(`ttadk launcher: model=${(cfg.model ?? '').trim() || 'glm-5.1 (default)'} injected as -m, suppressed on underlying ${cfg.cliId}`);
        }
        // cjadk runs its launched agent in an INTERACTIVE wrapper by default —
        // a model/session selector at startup plus terminal quirks that fight
        // botmux's automated input (the selector eats the first prompt; the
        // pre-render lag fragments multi-line messages; follow-ups can stick in
        // the input box). cjadk's own botmux integration (`cjadk feishu`, see its
        // botmux-wrapper-writer) sets CJADK_INTERACTIVE=0 to disable all of that.
        // We mirror it here so a `cjadk <agent>` wrapperCli is driven the way
        // cjadk intends — no selector, clean soft-newline input. Keyed on the
        // wrapper's leading token so only cjadk launches are affected.
        if (parseWrapperCli(cfg.wrapperCli)[0] === 'cjadk') {
          (childEnv as Record<string, string>).CJADK_INTERACTIVE = '0';
          log('cjadk launcher: set CJADK_INTERACTIVE=0 (non-interactive, mirrors cjadk feishu wrapper)');
        }
      }
    }
  }

  backend.spawn(spawnBin, spawnArgs, {
    cwd: spawnCwd,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    env: childEnv as Record<string, string>,
    injectEnv: perBotInjectKeys.length ? perBotInjectEnv : undefined,
    launchShell: lastInitConfig?.launchShell,
  });

  // Write CLI PID marker so agent-facing subcommands (`botmux send`, etc.)
  // can verify they were spawned inside a botmux session by walking the
  // process tree and looking for a matching pid file in this directory.
  const cliPid = backend.getChildPid?.();
  if (cliPid && process.env.SESSION_DATA_DIR) {
    const markersDir = join(process.env.SESSION_DATA_DIR, '.botmux-cli-pids');
    try {
      mkdirSync(markersDir, { recursive: true });
      cliPidMarker = join(markersDir, String(cliPid));
      writeCliPidMarker();
      log(`CLI PID marker written: ${cliPid}`);
    } catch (err: any) {
      log(`Failed to write CLI PID marker: ${err.message}`);
    }
  }

  // wrapperCli launcher (e.g. `aiden x claude`): the pid wired above is the
  // LAUNCHER's, but it forks the real CLI (real Claude Code, Codex, …) as a
  // child — and it's THAT child, not the launcher, that writes
  // ~/.claude/sessions/<pid>.json and owns the transcript jsonl. With the
  // launcher pid, resolveJsonlFromPid / findOpenClaudeSessionIds (both keyed on
  // bridgeCliPid / backend.cliPid) find nothing, so the bridge stays pinned to a
  // path the real CLI never writes — the model's turns never drive working/idle
  // transitions and `botmux send`-less turns aren't forwarded. This resolver
  // BFS-finds the real descendant pid and rewires backend.cliPid + bridgeCliPid;
  // the bridge's 1s pid-follow poller then re-points to the CLI's real jsonl.
  // Invoked from BOTH the synchronous pid path (tmux/pty, below) and the late
  // pid fallback (zellij, where getChildPid() is null at spawn) so every backend
  // is covered. No-op without an effective wrapperCli, and under sandbox (where
  // wrapperCli is ignored, so there is no launcher indirection). session-id
  // MARKER inference is unaffected (the launcher-pid marker is still a valid
  // ancestor of an in-CLI `botmux send`, and the env fallback covers it too).
  const startWrapperRealPidResolve = (launcherPid: number): void => {
    if (!cfg.wrapperCli || !cfg.wrapperCli.trim() || sandboxOn || !claudeDataDir) return;
    const targetCliId = cfg.cliId as CliId;
    scheduleWrapperRealCliPid(launcherPid, {
      findRealPid: (lp) => findLaunchedCliPid(lp, targetCliId),
      getBackend: () => backend,
      getChildPid: () => backend?.getChildPid?.(),
      applyRealPid: (realPid) => {
        log(`wrapperCli "${cfg.wrapperCli}": resolved real CLI pid ${realPid} under launcher ${launcherPid} (cliId=${targetCliId}); rewiring session discovery + bridge`);
        (backend as TmuxBackend | PtyBackend | ZellijBackend).cliPid = realPid;
        // Per-tick maybeFollowSessionRotationViaPid (bridge 1s poller) reads the
        // module-level bridgeCliPid and re-points to the real CLI's jsonl.
        bridgeCliPid = realPid;
      },
      schedule: (fn, ms) => { setTimeout(fn, ms); },
    });
  };
  if (cliPid) startWrapperRealPidResolve(cliPid);
  if (cliPid) observeCursorCliSessionId(cliPid);

  // Wire pid + cwd so the claude-code adapter's writeInput can read
  // ~/.claude/sessions/<pid>.json — the spawn-time pid-state record. Its
  // `sessionId` is set ONCE at process start (Claude Code 2.1.123); a
  // `--resume` lookup will surface here, but in-pane `/clear` won't, so a
  // 'matching sessionId' answer is "no spawn-time rotation observed", not
  // "no rotation at all". The pinned claudeJsonlPath above is still the
  // initial guess; the resolver corrects it on first write when Claude was
  // started with `--resume`.
  if (claudeDataDir && cliPid) {
    (backend as TmuxBackend | PtyBackend | ZellijBackend).cliPid = cliPid;
    (backend as TmuxBackend | PtyBackend | ZellijBackend).cliCwd = cfg.workingDir;
  }

  // Async pid fallback: tmux/pty resolve the CLI pid synchronously above, but
  // zellij's CLI subprocess starts AFTER spawn() returns (the zellij server
  // forks the pane asynchronously), so getChildPid() is null right now. Without
  // the marker, an in-CLI `botmux send` walks ancestor pids, finds no match,
  // and reports "无法推断 session-id". Retry briefly (non-blocking — a sync wait
  // would lose zellij's initial render since node-pty doesn't buffer pre-listener
  // output) until the pid appears, then write the marker + wire claude-family pid.
  if (!cliPid) {
    let attempts = 0;
    const resolveCliPidLate = () => {
      if (!backend) return;
      const pid = backend.getChildPid?.();
      if (pid) {
        if (process.env.SESSION_DATA_DIR && !cliPidMarker) {
          try {
            const markersDir = join(process.env.SESSION_DATA_DIR, '.botmux-cli-pids');
            mkdirSync(markersDir, { recursive: true });
            cliPidMarker = join(markersDir, String(pid));
            writeCliPidMarker();
            log(`CLI PID marker written (async): ${pid}`);
          } catch (err: any) {
            log(`Failed to write CLI PID marker (async): ${err.message}`);
          }
        }
        if (claudeDataDir) {
          (backend as TmuxBackend | PtyBackend | ZellijBackend).cliPid = pid;
          (backend as TmuxBackend | PtyBackend | ZellijBackend).cliCwd = cfg.workingDir;
        }
        // wrapperCli under a late-pid backend (zellij): `pid` here is still the
        // LAUNCHER. Kick the descendant resolver so the bridge gets the real CLI
        // pid too (mirrors the synchronous path above). No-op for non-wrapperCli.
        startWrapperRealPidResolve(pid);
        observeCursorCliSessionId(pid, 'async');
        return;
      }
      if (++attempts < 25) setTimeout(resolveCliPidLate, 120); // ~3s budget
    };
    setTimeout(resolveCliPidLate, 120);
  }

  // Bridge fallback: claude-code only. Tail Claude's transcript JSONL so a
  // turn the model finishes WITHOUT calling `botmux send` still gets its
  // assistant text forwarded to Lark (the gate in emitReadyTurns suppresses
  // the emit when a send did happen). Adopt mode wires this up separately
  // (with baseline-existing); here we use fresh-empty for new sessions so
  // the file Claude creates on first submit isn't absorbed as history,
  // and baseline-existing on resume so prior-run turns ARE absorbed (we
  // don't want to re-emit yesterday's conversation as fresh turns).
  //
  // NOTE: use effectiveResume / effectiveAdapterSessionId / effectiveCliSessionId
  // here, NOT cfg.* — the two-tier fallback above may have flipped
  // resume → FRESH, in which case the baseline mode and session id MUST
  // follow the flip. The same variables also cover Tier-2 (count-based)
  // fallbacks that fire for non-Claude CLIs (below).
  if (claudeDataDir && effectiveAdapterSessionId) {
    const claudeBridgeSessionId = effectiveCliSessionId ?? effectiveAdapterSessionId;
    const claudeJsonl = claudeJsonlPathForSession(claudeBridgeSessionId, cfg.workingDir, claudeDataDir);
    startBridgeWatcher(claudeJsonl, {
      cliPid: cliPid ?? undefined,
      cliCwd: cfg.workingDir,
      mode: effectiveResume ? 'baseline-existing' : 'fresh-empty',
      dataDir: claudeDataDir,
    });
  }

  // (wrapperCli real-CLI-pid resolution is wired earlier — see
  // startWrapperRealPidResolve, invoked from both the synchronous pid path and
  // the zellij late-pid fallback — so the bridge above gets re-pointed to the
  // launcher's real CLI child for every backend type.)

  // Structured transcript bridge fallback: if the model finishes without
  // calling `botmux send`, harvest the final answer from the CLI transcript
  // and post it to Lark. Codex needs late attach because its rollout id is
  // discovered after the first submit; CoCo's events path is deterministic
  // from botmux sessionId. Hermes and MTR use SQLite stores, so baseline the
  // relevant cursor at spawn and poll for rows after each queued prompt flushes.
  //
  // Mode uses effectiveResume: when the resume probe flipped us to FRESH, we
  // must NOT baseline the "restored" cursor against an empty / absent store
  // (would otherwise swallow the fresh session's first turn).
  if (cfg.cliId === 'hermes') {
    hermesBridgeAttach(effectiveResume ? 'baseline-existing' : 'fresh-empty');
  } else if (cfg.cliId === 'codex') {
    if (effectiveCliSessionId) {
      const rolloutPath = findCodexRolloutBySessionId(effectiveCliSessionId);
      if (rolloutPath) {
        codexBridgeAttach(rolloutPath, 'baseline-existing');
      } else {
        codexBridgePendingSessionId = effectiveCliSessionId;
        codexBridgeStartTimer();
      }
    } else {
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'traex') {
    // TRAE: same rollout shape as Codex, different finder path. For a fresh
    // spawn (no cliSessionId yet) we just arm the poller; writeInput will
    // surface the cliSessionId on the first successful submit and trigger
    // codexBridgeNotifyCliSessionId → rollout attach.
    if (effectiveCliSessionId) {
      const rolloutPath = findTraexRolloutBySessionId(effectiveCliSessionId);
      if (rolloutPath) {
        codexBridgeAttach(rolloutPath, 'baseline-existing');
      } else {
        codexBridgePendingSessionId = effectiveCliSessionId;
        codexBridgeStartTimer();
      }
    } else {
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'coco') {
    const eventsPath = cocoEventsPathForSession(effectiveAdapterSessionId);
    codexBridgeAttach(eventsPath, effectiveResume ? 'baseline-existing' : 'fresh-empty');
    codexBridgeStartTimer();
  } else if (cfg.cliId === 'mtr') {
    const mtrSessionId = effectiveCliSessionId ?? mtrSessionIdForBotmuxSession(effectiveAdapterSessionId);
    codexBridgePendingSessionId = mtrSessionId;
    const source = findMtrSessionById(mtrSessionId);
    if (source) {
      mtrBridgeAttach(source, effectiveResume ? 'baseline-existing' : 'fresh-empty');
    } else {
      codexBridgeStartTimer();
    }
  } else if (cfg.cliId === 'pi') {
    const piSessionId = effectiveCliSessionId ?? effectiveAdapterSessionId;
    if (piSessionId) {
      const transcriptPath = findPiTranscriptBySessionId(piSessionId, cfg.workingDir);
      if (transcriptPath) {
        codexBridgeAttach(transcriptPath, effectiveResume ? 'baseline-existing' : 'fresh-empty');
      } else {
        codexBridgePendingSessionId = piSessionId;
        codexBridgeStartTimer();
      }
    } else {
      codexBridgeStartTimer();
    }
  }

  // Arm the ready-gate for FRESH Claude-family spawns (which inject the
  // SessionStart hook via --settings; see claude-code.ts buildArgs). Until
  // `botmux session-ready` fires (daemon → 'session_ready' IPC → releaseReadyGate)
  // we hold the first prompt so a cjadk-style startup selector's ❯ can't eat it.
  // shouldArmReadyGate() excludes adopt (pre-existing pane, no --settings) AND
  // persistent-backend reattach (daemon restart re-attaches an already-running
  // tmux/zellij/herdr Claude WITHOUT re-running its bin/args → no new
  // SessionStart hook → arming would hold the first post-recovery message until
  // the timeout). Fallback: release after READY_SIGNAL_TIMEOUT_MS → readyPattern.
  readyGate = new ReadyGate();
  if (readySignalTimer) { clearTimeout(readySignalTimer); readySignalTimer = null; }
  if (readyFlushSettleTimer) { clearTimeout(readyFlushSettleTimer); readyFlushSettleTimer = null; }
  isSettlingFirstFlush = false;
  // Reset quiescence baseline so the settle measures silence from THIS spawn.
  lastPtyOutputAtMs = Date.now();
  if (shouldArmReadyGate({
    injectsReadyHook: cliAdapter.injectsReadyHook === true,
    adoptMode: cfg.adoptMode === true,
    willReattachPersistent,
  })) {
    readyGate.arm();
    log('Ready gate armed — holding first prompt until SessionStart ready signal');
    readySignalTimer = setTimeout(() => {
      readySignalTimer = null;
      releaseReadyGate('signal timeout fallback');
    }, READY_SIGNAL_TIMEOUT_MS);
    readySignalTimer.unref?.();
  }

  // Set up idle detection
  idleDetector = new IdleDetector(cliAdapter);
  idleDetector.onIdle(async () => {
    log('Prompt detected (idle)');
    // Bridge drain MUST run before markPromptReady() — the latter calls
    // flushPending() which can immediately fire the next queued message
    // (type-ahead adapters), shifting bridgeQueue's notion of "current
    // turn" before we've had a chance to emit the previous one.
    if (bridgeJsonlPath) {
      try { bridgeDrainAndMaybeEmit(); } catch (err: any) { log(`Bridge emit error: ${err.message}`); }
    }
    if (codexBridgeFallbackActive()) {
      try { codexBridgeDrainAndMaybeEmit(); } catch (err: any) { log(`Codex bridge emit error: ${err.message}`); }
    }
    markPromptReady();
  });

  backend.onData(onPtyData);
  backend.onExit((code, signal) => {
    log(`${cliName()} exited (code: ${code}, signal: ${signal})`);
    const logTail = recentTerminalLogTail();
    // Don't park a diagnostic shell here: most exits are immediately
    // auto-restarted by the daemon, so an inline park would just be torn down
    // again (a wasted tmux session + .ansi write on every restart). Instead
    // report whether we COULD park; the daemon asks us to (park_diagnostic) only
    // when it actually gives up restarting (crash loop). Stash the exit reason
    // for that deferred park.
    lastCliExitCode = code;
    lastCliExitSignal = signal;
    const canParkDiagnostic = !lastInitConfig?.adoptMode && effectiveBackendType === 'tmux' && !!sessionId;
    // Inputs written but not yet consumed (no idle since the write) die with
    // the CLI — codex crashing mid-submit never records them, and the fresh
    // respawn comes up empty. Stash them so the next spawnCli re-queues and
    // re-delivers.
    const stashed = inflightInputs.onCliExit();
    if (stashed > 0) {
      log(`CLI exited with ${stashed} in-flight message(s); will re-queue after restart`);
    }
    backend = null;
    isPromptReady = false;
    send({ type: 'claude_exit', code, signal, logTail, canParkDiagnostic });
  });

  if (isPipeMode && backend && 'isReattach' in backend && backend.isReattach) {
    log(`Re-attached to existing ${effectiveBackendType} session via pipe backend: ${persistentSessionName}`);
    seedBackendScreen(`${effectiveBackendType} reattach`, backend);
    scheduleReattachIdleProbe(`${effectiveBackendType} reattach`, backend);
  }

  // Fallback: if the CLI takes too long to show its prompt (e.g. slow plugin
  // init, or a spinner blocks the idle detector), unblock screen updates AND
  // deliver any queued prompts so the first user message isn't stranded until
  // the second message arrives. Some adapters opt into deferring the soft
  // fallback until readyPattern, but still get a hard cap below.
  // markNewTurn() sets a clean baseline at the current cursor position so only
  // content written *after* this point appears in the card.
  const firstPromptBackend = backend;
  const releaseFirstPromptTimeout = (elapsedMs: number, forced: boolean): void => {
    if (!awaitingFirstPrompt || backend !== firstPromptBackend) return;
    if (!shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: cliAdapter?.deferFirstPromptTimeoutUntilReady === true,
      hasReadyPattern: !!cliAdapter?.readyPattern,
      elapsedMs,
      hardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
    })) {
      const hardWaitMs = Math.max(0, FIRST_PROMPT_HARD_TIMEOUT_MS - elapsedMs);
      log(`First prompt timeout — ${cliName()} still waiting for readyPattern before flushing queued messages`);
      const hardTimer = setTimeout(() => releaseFirstPromptTimeout(FIRST_PROMPT_HARD_TIMEOUT_MS, true), hardWaitMs);
      hardTimer.unref?.();
      return;
    }

    awaitingFirstPrompt = false;
    renderer?.markNewTurn();
    log(forced
      ? `WARN First prompt hard timeout — ${cliName()} readyPattern did not arrive; forcing queued message flush`
      : 'First prompt timeout — enabling screen updates and flushing queued messages');
    if (backend && cliAdapter?.busyPattern && probeBusyPatternIdle(`${cliName()} first-prompt-timeout`, backend)) {
      return;
    }
    // For type-ahead adapters (Codex/CoCo/Claude/TraeX) the TUI is usually booted
    // enough to park input even if the idle detector hasn't fired yet. Directly
    // invoking markPromptReady() would claim the CLI is idle while it's still
    // mid-boot, so flushPending() alone is safer — it respects typeAheadAllowed
    // and drains pendingMessages now.
    if (cliAdapter?.supportsTypeAhead) flushPending();
  };
  setTimeout(() => releaseFirstPromptTimeout(FIRST_PROMPT_TIMEOUT_MS, false), FIRST_PROMPT_TIMEOUT_MS);
}

function killCli(): void {
  destroyCrashDiagnosticTerminal('killCli');
  idleDetector?.dispose();
  idleDetector = null;
  stopReattachIdleProbe();
  stopBusyPatternIdleProbe();
  // Cancel any pending ready-gate fallback / settle timers; spawnCli re-arms on respawn.
  if (readySignalTimer) { clearTimeout(readySignalTimer); readySignalTimer = null; }
  if (readyFlushSettleTimer) { clearTimeout(readyFlushSettleTimer); readyFlushSettleTimer = null; }
  isSettlingFirstFlush = false;
  stopScreenAnalyzer();
  stopScreenUpdates();
  backend?.kill();
  backend = null;
  // Tear down the bridge watcher (if any). spawnCli will rebuild it on
  // restart with the proper mode based on the new cfg. Leaving it running
  // would dangle a watcher pinned to a stale jsonl path.
  stopBridgeWatcher();
  stopCodexBridge();
  // Clean up CLI PID marker
  if (cliPidMarker) {
    try { unlinkSync(cliPidMarker); } catch { /* already gone */ }
    cliPidMarker = null;
  }
  // Stop the sandbox outbox watcher, then unmount the overlays + remove the
  // per-session sandbox tree. In the overlay model the upper layer (the
  // changeset) must be landed BEFORE close — `/land` runs while the session is
  // still active, so by cleanup time anything worth keeping is already applied.
  if (sandboxStopWatcher) {
    try { sandboxStopWatcher(); } catch { /* */ }
    sandboxStopWatcher = null;
  }
  if (sandboxCleanup) {
    try { sandboxCleanup(); } catch { /* */ }
    sandboxCleanup = null;
  }
  isPromptReady = false;
  pendingMessages.length = 0;
  scrollback = '';
  altBufferActive = false;
  trustHandled = false;
  codexAppOscPending = '';
}

// ─── HTTP + WebSocket Server ─────────────────────────────────────────────────

function startWebServer(host: string, preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer = createHttpServer((req, res) => {
      const url = parseWorkerRequestUrl(req);
      if (!url) {
        log(`Bad worker HTTP URL rejected: ${JSON.stringify(req.url ?? '')}`);
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      const tokenMatches = url.searchParams.get('token') === writeToken;
      const { hasWrite, platformReadonly } = resolveTerminalWrite(req, tokenMatches);
      const loginHdr = req.headers['x-botmux-login-url'];
      const loginUrl = typeof loginHdr === 'string' && /^https?:\/\/[^"'<>\s]+$/.test(loginHdr) ? loginHdr : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getTerminalHtml(hasWrite, platformReadonly, loginUrl));
    });

    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws, req: IncomingMessage) => {
      wsClients.add(ws);

      // Check token from query string for write access
      const url = parseWorkerRequestUrl(req);
      if (!url) {
        log(`Bad worker WS URL rejected: ${JSON.stringify(req.url ?? '')}`);
        wsClients.delete(ws);
        ws.close(1008, 'Bad Request');
        return;
      }
      const tokenMatches = url.searchParams.get('token') === writeToken;
      const { hasWrite } = resolveTerminalWrite(req, tokenMatches);
      if (hasWrite) authedClients.add(ws);
      log(`WS client connected (total: ${wsClients.size}, write: ${hasWrite})`);

      if (isTmuxMode && !isPipeMode && sessionId) {
        // ── Tmux-attach mode: per-client attach ──
        // Each WS client gets its own `tmux attach-session` PTY.
        // Scrollback is handled natively by tmux (history-limit).
        // In adopt mode, attach to the user's original pane; otherwise use bmx-* session.
        //
        // Spawn is DEFERRED until the client sends its first 'resize'.  If we
        // spawned at a default size (e.g. 80×24) first and then resized, tmux
        // would render at the old size, send those bytes, and then only
        // diff-update the rows that changed.  Rows that happen to match
        // byte-for-byte (empty, separators, etc.) are not retransmitted, so
        // the earlier frame "bleeds through" — visible as a second
        // banner/prompt stacked above the new layout when scrolling up.
        // While a crash diagnostic shell is parked it lives under bmx-diag-<sid>
        // (not the live CLI's bmx-<sid>), so attach there to surface the startup
        // error; otherwise attach the normal backing session.
        const tmuxTarget = lastInitConfig?.adoptTmuxTarget
          ?? (crashDiagnosticTmuxParked
            ? TmuxBackend.diagnosticSessionName(sessionId)
            : TmuxBackend.sessionName(sessionId));
        let cp: pty.IPty | null = null;
        const pendingInput: string[] = [];

        const startAttach = (cols: number, rows: number) => {
          if (cp) return;
          cp = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
            name: 'xterm-256color',
            cols,
            rows,
            env: tmuxEnv() as { [key: string]: string },
          });
          clientPtys.set(ws, cp);

          cp.onData((d: string) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(d);
          });
          cp.onExit(() => {
            clientPtys.delete(ws);
            if (ws.readyState === WebSocket.OPEN) ws.close();
          });

          // Replay any input that arrived during the spawn window.
          for (const data of pendingInput) cp.write(data);
          pendingInput.length = 0;
        };

        // Safety net: if no resize arrives (very old client?), start the
        // attach at a reasonable default after a short delay.
        const spawnTimer = setTimeout(() => startAttach(150, 40), 500);

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
              if (!cp) {
                clearTimeout(spawnTimer);
                startAttach(msg.cols, msg.rows);
              } else {
                cp.resize(msg.cols, msg.rows);
              }
            } else if (msg.type === 'input' && typeof msg.data === 'string') {
              if (!authedClients.has(ws)) {
                // Read-only: allow mouse events through (scroll/click are
                // non-destructive in tmux — just views history / selects text).
                // SGR mouse: \x1b[<...  X10 mouse: \x1b[M...
                if (!/^\x1b\[([<M])/.test(msg.data)) return;
              }
              if (cp) cp.write(msg.data);
              else pendingInput.push(msg.data);
            }
          } catch { /* ignore non-JSON or bad messages */ }
        });

        ws.on('close', () => {
          clearTimeout(spawnTimer);
          wsClients.delete(ws);
          const existing = clientPtys.get(ws);
          if (existing) {
            try { existing.kill(); } catch { /* already dead */ }
            clientPtys.delete(ws);
          }
        });
      } else if (lastInitConfig?.adoptMode && lastInitConfig?.adoptZellijPaneId) {
        // ── Zellij-adopt per-WS attach ──
        // Each WS client gets its own `zellij attach` PTY sized to the browser.
        // zellij sizes the (shared) pane to the SMALLEST attached client, so
        // when the user's terminal is detached the web client governs the size
        // → fully browser-responsive (申晗's insight, verified), never resizing
        // the user's terminal beyond min(theirs, browser). Locked-mode config
        // (cleared keybinds) makes every keystroke reach the codex pane instead
        // of being swallowed as a zellij shortcut. Bonus: raw byte stream — none
        // of the dump-screen snapshot / \r\n / fixed-width machinery the relay
        // needs. (The Lark screenshot card still uses the dump-screen
        // ObserveBackend; unaffected.) Deferred until first resize, same as tmux.
        const zSession = lastInitConfig.adoptZellijSession ?? '';
        const cfgPath = ensureZellijAttachConfig();
        let cp: pty.IPty | null = null;
        const pendingInput: string[] = [];
        // While this attach client is live, silence the ObserveBackend's
        // dump-screen/list-panes pollers: each `zellij action` they run makes the
        // server repaint every attached client, which flickers this client's
        // chrome ~2×/s. Reference-counted across browser tabs by the backend.
        const observeBe = backend instanceof ZellijObserveBackend ? backend : null;
        let attachStarted = false;

        const startAttach = (cols: number, rows: number) => {
          if (cp) return;
          cp = pty.spawn('zellij', ['--config', cfgPath, 'attach', zSession], {
            name: 'xterm-256color',
            cols,
            rows,
            env: zellijEnv() as { [key: string]: string },
          });
          attachStarted = true;
          observeBe?.setLiveAttach(true);
          clientPtys.set(ws, cp);
          cp.onData((d: string) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(d);
          });
          cp.onExit(() => {
            clientPtys.delete(ws);
            if (ws.readyState === WebSocket.OPEN) ws.close();
          });
          for (const data of pendingInput) cp.write(data);
          pendingInput.length = 0;
        };

        const spawnTimer = setTimeout(() => startAttach(150, 40), 500);

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
              if (!cp) { clearTimeout(spawnTimer); startAttach(msg.cols, msg.rows); }
              else cp.resize(msg.cols, msg.rows);
            } else if (msg.type === 'input' && typeof msg.data === 'string') {
              if (!authedClients.has(ws)) {
                // Read-only: only let mouse events (scroll/select) through.
                if (!/^\x1b\[([<M])/.test(msg.data)) return;
              }
              if (cp) cp.write(msg.data);
              else pendingInput.push(msg.data);
            }
          } catch { /* ignore non-JSON or bad messages */ }
        });

        ws.on('close', () => {
          clearTimeout(spawnTimer);
          wsClients.delete(ws);
          if (attachStarted) { observeBe?.setLiveAttach(false); attachStarted = false; }
          const existing = clientPtys.get(ws);
          if (existing) {
            try { existing.kill(); } catch { /* already dead */ }
            clientPtys.delete(ws);
          }
        });
      } else {
        // ── Shared relay (PtyBackend OR tmux pipe mode) ──
        // History seed: prefer tmux's authoritative capture-pane in pipe mode
        // (clean grid + scrollback) over replaying the raw cumulative byte
        // stream, which scrolls stale Ink redraw/spinner frames into scrollback
        // at any size mismatch and produces the stacked-footer history garble.
        // See chooseWebTerminalSeed for the full rationale.
        // Adopt observes a pane we CANNOT resize (tmux adopt has
        // ownsSession=false so resize() is a no-op; zellij drives via
        // dump-screen). The client's FitAddon sizes its xterm to the browser,
        // but the snapshot lines carry the PANE's width — any mismatch wraps the
        // full-width TUI box lines and garbles the layout (the misalignment 申晗
        // saw). Pin the client xterm to the pane's fixed size via a botmux OSC
        // (sent BEFORE the seed so the client resizes before rendering it).
        if (lastInitConfig?.adoptMode && isObserveBackend(backend)) {
          const sz = (backend as ObserveBackend).getPaneSize();
          if (sz && sz.cols > 0 && sz.rows > 0) ws.send(`\x1b]1989;${sz.cols};${sz.rows}\x07`);
        }
        const seed = chooseWebTerminalSeed({
          canCapture: isPipeMode && isObserveBackend(backend),
          capture: () => (backend as ObserveBackend).captureCurrentScreen(),
          scrollback,
          onError: log,
        });
        if (seed.length > 0) {
          ws.send(seed);
        }

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
              backend?.resize(msg.cols, msg.rows);
            } else if (msg.type === 'input' && typeof msg.data === 'string') {
              if (!authedClients.has(ws)) {
                // Read-only: allow ONLY wheel scroll sequences (SGR buttons 64-67).
                // Scrolling the CLI's own view is non-destructive and lets read-only
                // viewers page back through an alt-screen TUI's history (Claude etc.,
                // which has no local scrollback). Everything else is dropped.
                if (!/^(\x1b\[<6[4-7];\d+;\d+M)+$/.test(msg.data)) return;
              }
              backend?.write(msg.data);
            }
          } catch { /* ignore non-JSON or bad messages */ }
        });

        ws.on('close', () => {
          wsClients.delete(ws);
        });
      }
    });

    // Bind + EADDRINUSE→random-port fallback live in a shared helper that also
    // attaches the load-bearing wss 'error' listener: `new WebSocketServer({
    // server })` makes ws proxy the http server's 'error' onto the wss, so a
    // busy port would otherwise emit an UNHANDLED 'error' on the wss and crash
    // the worker before this fallback can run. See web-terminal-listen.ts.
    listenWebTerminalWithFallback({ httpServer: httpServer!, wss: wss!, host, preferredPort, log })
      .then(resolve, reject);
  });
}

function getTerminalHtml(hasWrite: boolean, platformReadonly = false, loginUrl = ''): string {
  const label = sessionId.substring(0, 8);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta id="vp" name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${cliName()} - ${label}</title>
<link rel="icon" type="image/png" href="${TERMINAL_FAVICON_DATA_URI}">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#1a1b26;overflow:hidden;overscroll-behavior:none}
body{display:flex;flex-direction:column}
#toolbar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:100;
  padding:6px 8px calc(6px + env(safe-area-inset-bottom,0px));
  background:rgba(21,22,30,0.92);border-top:1px solid #33467c;
  gap:6px;align-items:center;justify-content:center;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
#toolbar.show{display:flex}
#toolbar button{background:#24283b;color:#a9b1d6;border:1px solid #33467c;
  border-radius:6px;padding:8px 14px;font-size:14px;font-family:monospace;
  white-space:nowrap;cursor:pointer;min-width:44px;min-height:36px;text-align:center;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none}
#toolbar button:active{background:#7aa2f7;color:#1a1b26}
#terminal{flex:1;min-height:0}
#terminal .xterm{height:100%}
/* Real scroll container is xterm's own viewport — kill iOS rubber-band bounce
   and momentum here (not just on body), and reserve gestures for pinch-zoom so
   single-finger drag is driven manually by the touch handler below. */
#terminal .xterm-viewport{overscroll-behavior:none;-webkit-overflow-scrolling:auto;touch-action:pinch-zoom}
/* On touch, glyph cells are selectable text — a finger-drag over text starts
   native text selection (and the long-press callout) instead of scrolling,
   which is why blank areas scroll fine but text areas stall/won't move.
   Kill selection + callout on the rendered content so every drag is a clean
   scroll.  Gated to .touch so desktop keeps mouse text-selection for copy. */
body.touch #terminal .xterm-screen,
body.touch #terminal .xterm-screen *{
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:pinch-zoom}
#status{position:fixed;top:8px;right:12px;z-index:10;font:12px monospace;
  color:#565f89;background:#1a1b26cc;padding:2px 8px;border-radius:4px}
#status.ok{color:#9ece6a}
#status.err{color:#f7768e}
#readonly-banner{display:none;position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:50;
  padding:4px 10px;font:12px monospace;color:#f7768e;white-space:nowrap;cursor:pointer;
  background:rgba(247,118,142,0.12);border:1px solid rgba(247,118,142,0.35);border-radius:4px;
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
#readonly-banner.show{display:inline-block}
#login-banner{display:none;position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:50;
  padding:4px 10px;font:12px monospace;color:#e0af68;white-space:nowrap;text-decoration:none;cursor:pointer;
  background:rgba(224,175,104,0.12);border:1px solid rgba(224,175,104,0.35);border-radius:4px;
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
#login-banner.show{display:inline-block}
</style>
</head>
<body>
<div id="terminal"></div>
<div id="readonly-banner">只读模式 · 无写入权限</div>
${loginUrl ? `<a id="login-banner" href="${loginUrl}" target="_top" rel="noopener">owner 登录后可操作 →</a>` : '<div id="login-banner">owner 登录后可操作</div>'}
<div id="toolbar">
  <button data-k="esc">Esc</button>
  <button data-k="ctrlc">^C</button>
  <button data-k="tab">Tab</button>
  <button data-k="up">\u2191</button>
  <button data-k="down">\u2193</button>
  <button data-k="left">\u2190</button>
  <button data-k="right">\u2192</button>
  <button data-k="enter">\u21B5</button>
</div>
<div id="status" class="err">connecting...</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/lib/addon-web-links.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0/lib/addon-unicode11.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0/lib/addon-webgl.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-canvas@0/lib/addon-canvas.min.js"></script>
<script>
var isTouch='ontouchstart'in window||navigator.maxTouchPoints>0;
if(isTouch){document.getElementById('vp').content='width=1100,viewport-fit=cover';document.body.classList.add('touch');}
var hasToken=${hasWrite};
var platformReadonly=${platformReadonly};
if(!hasToken){
  if(platformReadonly){var _lb=document.getElementById('login-banner');_lb.classList.add('show');}
  else{var _rb=document.getElementById('readonly-banner');_rb.classList.add('show');_rb.addEventListener('click',function(){_rb.classList.remove('show')});}
}

var term=new Terminal({
  theme:{background:'#1a1b26',foreground:'#a9b1d6',cursor:'#c0caf5',
    selectionBackground:'#33467c',black:'#15161e',red:'#f7768e',
    green:'#9ece6a',yellow:'#e0af68',blue:'#7aa2f7',magenta:'#bb9af7',
    cyan:'#7dcfff',white:'#a9b1d6'},
  fontSize:14,fontFamily:"'JetBrains Mono','Fira Code',monospace",
  cursorBlink:!isTouch,scrollback:50000,allowProposedApi:true
});
var fit=new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.loadAddon(new Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion='11';
term.open(document.getElementById('terminal'));
// GPU/canvas renderer.  The default DOM renderer repaints every text span on
// each scroll frame, which is exactly what makes scrolling over text-heavy
// areas janky/stuck on mobile (blank areas are cheap, so they stayed smooth).
// Prefer WebGL, fall back to Canvas, then to the built-in DOM renderer.
try{
  var _webgl=new WebglAddon.WebglAddon();
  _webgl.onContextLoss(function(){try{_webgl.dispose()}catch(_){}});
  term.loadAddon(_webgl);
}catch(_e){
  try{term.loadAddon(new CanvasAddon.CanvasAddon())}catch(_e2){}
}
fit.fit();
// ── OSC 52 clipboard ──
var _clipBuf='';
function _doCopy(text){
  var ta=document.createElement('textarea');ta.value=text;
  ta.style.cssText='position:fixed;left:-9999px';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy')}catch(e){}
  document.body.removeChild(ta);
}
function _showCopied(){
  var d=document.createElement('div');
  d.textContent='Copied!';
  d.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:999;background:#9ece6a;color:#1a1b26;padding:4px 16px;border-radius:4px;font:13px monospace;pointer-events:none;opacity:1;transition:opacity .4s';
  document.body.appendChild(d);
  setTimeout(function(){d.style.opacity='0'},800);
  setTimeout(function(){document.body.removeChild(d)},1200);
}
var _roToastT=0;
function _showReadonlyToast(){
  var now=Date.now();
  if(now-_roToastT<2000)return;
  _roToastT=now;
  var d=document.createElement('div');
  d.textContent='只读模式，无法输入';
  d.style.cssText='position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:999;background:#f7768e;color:#1a1b26;padding:4px 16px;border-radius:4px;font:13px monospace;pointer-events:none;opacity:1;transition:opacity .4s';
  document.body.appendChild(d);
  setTimeout(function(){d.style.opacity='0'},1200);
  setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d)},1600);
}
document.getElementById('terminal').addEventListener('contextmenu',function(e){e.preventDefault()});

// ── WebSocket ──
var ws_=null,el=document.getElementById('status');
term.onData(function(d){
  if(!hasToken){
    // Allow mouse events through (scroll/click) — server accepts these in read-only.
    // Keyboard input triggers the toast instead.
    if(!/^\\x1b\\[[<M]/.test(d)){_showReadonlyToast();return;}
  }
  if(ws_&&ws_.readyState===1)ws_.send(JSON.stringify({type:'input',data:d}));
});
var fixedSize=false,_lastC=0,_lastR=0,_rzT=0;
function sendResize(){
  if(!ws_||ws_.readyState!==1)return;
  // Dedup: a fit that lands on the same grid must NOT re-emit a resize — for a
  // zellij/tmux attach client that would reflow the shared pane for nothing.
  if(term.cols===_lastC&&term.rows===_lastR)return;
  _lastC=term.cols;_lastR=term.rows;
  ws_.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
}
// Debounce viewport resize: mobile fires a burst of window.resize as the address
// bar / on-screen keyboard show & hide, and an un-debounced fit→resize on each
// reflows the (shared) zellij pane every frame — the status bar toggles and the
// text re-wraps, i.e. the flicker 申晗 saw. Coalesce to the settled size.
function onViewportResize(){
  clearTimeout(_rzT);
  _rzT=setTimeout(function(){if(!fixedSize){try{fit.fit()}catch(e){}}sendResize()},250);
}
window.addEventListener('resize',onViewportResize);
(function connect(){
  var t=new URLSearchParams(location.search).get('token')||'';
  // Derive base from the current path so the WS connects to the same prefix the
  // page was served under — works both directly (path '/') and behind the
  // per-daemon reverse proxy ('/s/{sessionId}'). See terminal-proxy.ts.
  var base=location.pathname.replace(/\\/+$/,'');
  var proto=location.protocol==='https:'?'wss':'ws';
  var ws=new WebSocket(proto+'://'+location.host+base+'/?token='+t);
  ws_=ws;ws.binaryType='arraybuffer';
  // Force a resize on every (re)connect: clear the dedup memory first. On
  // reconnect the browser grid is usually unchanged, so without this the
  // dedup in sendResize() would suppress the resize — but a reconnect often
  // means the server respawned the CLI PTY at the default 160x50 (daemon
  // restart). If we never re-send our real grid, the PTY stays 160 while this
  // xterm renders narrower, and Claude's height-relative redraws drift a row
  // (status-line update bleeds into the line below). Always re-assert size.
  ws.onopen=function(){el.textContent='connected';el.className='ok';_lastC=_lastR=0;sendResize()};
  ws.onmessage=function(e){
    var data=typeof e.data==='string'?e.data:new TextDecoder().decode(e.data);
    // botmux OSC 1989: pin the xterm to the adopted pane's fixed size (the pane
    // can't be resized, so FitAddon-to-browser would wrap the snapshot lines).
    var _fs=data.match(/\\x1b\\]1989;(\\d+);(\\d+)\\x07/);
    if(_fs){fixedSize=true;var _c=+_fs[1],_r=+_fs[2];if(_c>0&&_r>0){try{term.resize(_c,_r)}catch(ex){}}data=data.replace(_fs[0],'')}
    // Intercept OSC 52 clipboard sequence from tmux (set-clipboard on)
    var m=data.match(/\\x1b\\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\\x07|\\x1b\\\\)/);
    if(m){try{_clipBuf=new TextDecoder().decode(Uint8Array.from(atob(m[1]),function(c){return c.charCodeAt(0)}));_doCopy(_clipBuf);_showCopied()}catch(ex){}}
    term.write(data);
  };
  ws.onclose=function(){ws_=null;el.textContent='disconnected';el.className='err';setTimeout(connect,2000)};
  ws.onerror=function(){ws.close()};
})();

// ── Wheel / touch scroll handling ──
// Alt-screen + mouse-mode CLIs (e.g. Claude Code) keep NO scrollback in xterm OR
// tmux — their whole transcript is redrawn by the app inside the fixed alt-screen
// grid, so term.scrollLines() reveals nothing. In the alternate buffer we forward
// scrolling as SGR mouse-wheel events so the CLI scrolls its own transcript and
// repaints (works in read-only too: the server only lets wheel sequences through).
// Normal-buffer CLIs keep xterm's native scrollback scroll. Capture-phase +
// stopPropagation pre-empts xterm's own handler. Skipped for pure tmux/zellij
// ATTACH (gate), where the attach client owns scrolling via copy-mode.
//
// Accumulate intended scroll DISTANCE (px) and emit one wheel tick per STEP px —
// decoupled from how many wheel/touch events the browser fires per gesture
// (high-res trackpads fire dozens), so a small gesture stays a small scroll and
// doesn't compound into a whole screen. px<0 = scroll up (toward history). The
// per-call cap stops a single huge delta (page tick / fling) from over-firing.
var _scrollAccum=0;var _SCROLL_STEP=33;
function _fwdScroll(px){
  if(!ws_||ws_.readyState!==1)return;
  _scrollAccum+=px;var data='',n=0;
  while(Math.abs(_scrollAccum)>=_SCROLL_STEP&&n<6){
    var up=_scrollAccum<0; // px<0 → wheel-up (history)
    data+='\\x1b[<'+(up?64:65)+';1;1M';
    _scrollAccum+=up?_SCROLL_STEP:-_SCROLL_STEP;n++;
  }
  if(data)ws_.send(JSON.stringify({type:'input',data:data}));
}
if(!${isTmuxMode && !isPipeMode}){
  document.getElementById('terminal').addEventListener('wheel',function(e){
    if(term.buffer.active.type!=='alternate'){
      // Normal buffer: xterm scrolls its own scrollback natively. In read-only a
      // mouse-mode CLI could swallow the wheel, so drive scrollback directly.
      if(!hasToken){e.preventDefault();e.stopPropagation();term.scrollLines(e.deltaY>0?3:-3);}
      return;
    }
    e.preventDefault();e.stopPropagation();
    // Normalise deltaMode to px: line→~16px, page→~one screen.
    var px=e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*term.rows*16:e.deltaY;
    _fwdScroll(px);
  },{capture:true,passive:false});
}

// ── Touch shortcut toolbar ──
if(isTouch&&hasToken){
  var km={esc:'\\x1b',ctrlc:'\\x03',tab:'\\t',up:'\\x1b[A',down:'\\x1b[B',left:'\\x1b[D',right:'\\x1b[C',enter:'\\r'};
  var tb=document.getElementById('toolbar');
  tb.classList.add('show');
  var btns=tb.getElementsByTagName('button');
  for(var i=0;i<btns.length;i++){(function(btn){
    function fire(e){e.preventDefault();e.stopPropagation();
      if(!ws_||ws_.readyState!==1)return;
      var k=km[btn.getAttribute('data-k')];
      if(k)ws_.send(JSON.stringify({type:'input',data:k}));
    }
    btn.addEventListener('touchend',fire,{passive:false});
    btn.addEventListener('click',fire);
  })(btns[i]);}
  // Keyboard avoidance: move toolbar above virtual keyboard
  if(window.visualViewport){
    function posToolbar(){
      var vv=window.visualViewport;
      var kb=window.innerHeight-vv.height-vv.offsetTop;
      tb.style.bottom=Math.max(0,Math.round(kb))+'px';
    }
    window.visualViewport.addEventListener('resize',posToolbar);
    window.visualViewport.addEventListener('scroll',posToolbar);
  }
}

// Single-finger touch scrolling: normal-buffer CLIs use xterm's own Viewport
// (handleTouchMove → scrollTop) natively. Alt-screen CLIs (Claude) have no xterm
// scrollback, so native touch scroll does nothing — mirror the wheel fix and
// forward the drag to the CLI as SGR wheel events so it scrolls its own
// transcript. Only the alternate buffer is intercepted (capture + stopPropagation);
// the normal buffer falls through to xterm untouched, so no double-drive of
// scrollTop. overscroll-behavior:none (see <style>) kills the iOS rubber-band.
if(!${isTmuxMode && !isPipeMode}){
  var _tTerm=document.getElementById('terminal');
  var _tLastY=null;
  _tTerm.addEventListener('touchstart',function(e){
    if(e.touches.length===1)_tLastY=e.touches[0].clientY;
  },{capture:true,passive:true});
  _tTerm.addEventListener('touchmove',function(e){
    // Normal buffer / multi-touch / no start → let xterm (or the browser) handle it.
    if(term.buffer.active.type!=='alternate'||_tLastY===null||e.touches.length!==1)return;
    e.preventDefault();e.stopPropagation();
    var y=e.touches[0].clientY;
    _fwdScroll(_tLastY-y); // finger drags down (y grows) → px<0 → scroll up (history)
    _tLastY=y;
  },{capture:true,passive:false});
  _tTerm.addEventListener('touchend',function(){_tLastY=null;},{capture:true,passive:true});
}
</script>
</body>
</html>`;
}

// ─── IPC Communication ───────────────────────────────────────────────────────

function send(msg: WorkerToDaemon): void {
  if (isWorkflowWorker() && msg.type === 'final_output') {
    workflowFinalOutputSent = true;
  }
  process.send?.(msg);
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [worker:${sessionId.substring(0, 8) || '??'}] ${msg}\n`);
}

// ─── IPC Message Handler ─────────────────────────────────────────────────────

process.on('message', async (raw: unknown) => {
  const msg = raw as DaemonToWorker;

  switch (msg.type) {
    case 'init': {
      if (lastInitConfig) return;  // already initialized
      lastInitConfig = msg;
      sessionId = msg.sessionId;
      if (msg.ownerOpenId) process.env.__OWNER_OPEN_ID = msg.ownerOpenId;
      // Pin this worker's i18n locale early so every t() call below resolves
      // against the bot's chosen language without each callsite needing to
      // re-thread it.
      if (msg.locale === 'zh' || msg.locale === 'en') {
        setDefaultLocale(msg.locale);
      }
      // Scope session store to this bot's per-bot file.
      // Slice C0: workflow-spawned workers (BOTMUX_WORKFLOW=1) skip this —
      // their `sessionId` is synthetic (`wf-<runId>-<activityId>-...`) and
      // must not be appended to the bot's chat-session registry.  The
      // workflow's own event log is the source of truth for run state.
      if (msg.larkAppId && process.env.BOTMUX_WORKFLOW !== '1') {
        sessionStore.init(msg.larkAppId);
      }
      // Capture credentials for direct image upload from worker
      larkAppIdForUpload = msg.larkAppId;
      larkAppSecretForUpload = msg.larkAppSecret;
      // brand 决定截图上传打哪个域（feishu / larksuite）。缺省 feishu。
      larkBrandForUpload = msg.brand === 'lark' ? 'lark' : 'feishu';
      // Resolve render dimensions BEFORE startScreenUpdates() — the
      // headless xterm and PNG canvas need to know the source pane size
      // up-front. Setting them later (after the renderer was built at
      // 160x50) wouldn't unwrap content xterm has already buffered, so
      // adopt-mode wide-pane content would still come out stair-stepped.
      const dims = resolveRenderDimensions(msg);
      renderCols = dims.cols;
      renderRows = dims.rows;
      log(`Init: session=${sessionId}, cwd=${msg.workingDir}, render=${renderCols}x${renderRows}${msg.adoptMode ? ' (adopt-pane)' : ''}`);

      try {
        if (msg.turnId) {
          currentBotmuxTurnId = msg.turnId;
          writeCliPidMarker();
        }
        let port = 0;
        if (!isWorkflowWorker()) {
          port = await startWebServer(config.web.workerHost, msg.webPort);
          startScreenUpdates();
          startScreenAnalyzer();
        } else {
          // Workflow attempts still expose a read-only web terminal so the
          // workflow dashboard can observe in-flight subagents.  Keep the
          // chat-side features disabled: no screen cards, no analyzer, no
          // sessionStore writes.
          port = await startWebServer(config.web.workerHost, msg.webPort);
          log('Workflow worker mode: web terminal enabled; skipping screen updates and screen analyzer');
        }
        spawnCli(msg);

        // Queue the initial prompt — flushed when CLI shows idle.
        // Adapters with passesInitialPromptViaArgs (e.g. Gemini -i) bake the
        // prompt into CLI args, so we normally skip queuing to avoid double-send.
        // EXCEPTION: when this bot has startupCommands, spawnCli deliberately did
        // NOT bake the prompt (deferInitialPrompt) so the commands can precede it
        // — so we MUST queue it here. shouldDeferInitialPromptForStartup mirrors
        // spawnCli's decision exactly. Bridge mark is deferred to flushPending.
        // lastSpawnEffectiveResume was just written by spawnCli(msg) above, so
        // this mirrors spawnCli's resume-defer condition exactly (incl. the
        // Tier-1/Tier-2 fresh demotion, which clears the flag). Adopt spawns
        // return from spawnCli before that write — exclude them explicitly so
        // the stale module-level value can't leak in.
        const deferInitialPrompt = shouldDeferInitialPromptForStartup({
          hasStartupCommands: !!msg.startupCommands?.length,
          adoptMode: msg.adoptMode === true,
          passesInitialPromptViaArgs: cliAdapter?.passesInitialPromptViaArgs === true,
        }) || (msg.adoptMode !== true && lastSpawnEffectiveResume && cliAdapter?.initialPromptArgsIgnoredOnResume === true);
        if (msg.prompt && cliAdapter?.passesInitialPromptViaArgs && !deferInitialPrompt && codexBridgeFallbackActive()) {
          // Args-baked first prompts (notably Pi) never pass through the normal
          // 'message' IPC path, so the structured bridge would otherwise see the
          // transcript final answer with no pending turn to attribute it to.
          // Mark it here before the CLI starts processing; late-attach is fine
          // because CodexBridgeQueue is path-agnostic until ingest discovers the
          // transcript file.
          codexBridgeMarkPendingTurn(msg.prompt, msg.turnId);
        }
        if (msg.prompt && (!cliAdapter?.passesInitialPromptViaArgs || deferInitialPrompt)) {
          pendingMessages.push({ content: msg.prompt, turnId: msg.turnId });
        }

        send({ type: 'ready', port, token: writeToken, turnId: currentBotmuxTurnId });
      } catch (err: any) {
        send({ type: 'error', message: `init failed: ${err.message}` });
        process.exit(1);
      }
      break;
    }

    case 'message': {
      // Mark new turn baseline so the streaming card only shows this turn's content
      renderer?.markNewTurn();
      const turnSeq = usageLimitTracker.beginTurn(currentUsageLimitSnapshot());
      // Cancel any active tmux copy-mode scroll so user input reaches the CLI.
      if (tmuxScrolledHalfPages > 0) exitTmuxScrollMode();
      const content = msg.content;
      currentBotmuxTurnId = msg.turnId;
      writeCliPidMarker();
      if (!backend && crashDiagnosticStopped && lastInitConfig && !lastInitConfig.adoptMode) {
        log('Message received after crash-loop stop; retrying CLI start');
        destroyCrashDiagnosticTerminal('retry after message');
        stopScreenAnalyzer();
        stopScreenUpdates();
        awaitingFirstPrompt = true;
        startScreenUpdates();
        startScreenAnalyzer();
        spawnCli({ ...lastInitConfig, resume: true, prompt: '' });
      }
      if (lastInitConfig?.adoptMode) {
        // Bridge mode: capture transcript baseline BEFORE writing to the pane,
        // so any assistant uuids appended after this point are attributed to
        // *this* Lark turn (not local user activity in the pane). Mark may
        // return false (baseline not ready) — we still write to the pane;
        // user just won't get a final_output for this message.
        if (bridgeJsonlPath) {
          try { bridgeIngest(); } catch { /* best effort */ }
          bridgeMarkPendingTurn(content, msg.turnId);
        } else if (codexBridgeFallbackActive()) {
          // Codex adopt: same idea, different bridge. ingest first so any
          // in-flight events from a local-typed prior turn close before
          // this Lark turn's fingerprint window opens. Mark works even
          // pre-attach (queue is path-agnostic).
          if (codexBridgeIsCursor()) {
            // Cursor may append the current Lark/user line to its transcript
            // before this IPC message is handled. Mark first so that preexisting
            // current-line can still fingerprint-match instead of being marked
            // seen as an unmatched event.
            codexBridgeMarkPendingTurn(content, msg.turnId);
            try { codexBridgeIngest(); } catch { /* best effort */ }
          } else {
            try { codexBridgeIngest(); } catch { /* best effort */ }
            codexBridgeMarkPendingTurn(content, msg.turnId);
          }
        }
        // Adopt mode write:
        //   - codex routes through cliAdapter.writeInput so the adapter's
        //     paste-detection delay + Enter-retry + history.jsonl verify
        //     loop handles Codex TUI's "\n treated as Enter" submit
        //     behaviour. Without it, Lark messages get stranded in the
        //     input box (user-reported "卡在输入框中").
        //   - everything else keeps the simple raw sendText+Enter — the
        //     claude-code adopt bridge has its own dual-write recovery
        //     path, and the other CLIs' adopt flows haven't surfaced
        //     this submit-detection issue.
        if (backend) {
          if ((lastInitConfig?.cliId === 'codex' || lastInitConfig?.cliId === 'traex') && cliAdapter) {
            // writeInput is async but we're already inside an async
            // message handler. Errors are best-effort logged; the bridge
            // ingest path is unaffected because mark already happened
            // above (codexBridgeMarkPendingTurn / bridgeMarkPendingTurn).
            try {
              const result = await cliAdapter.writeInput(backend as unknown as PtyHandle, content);
              if (result?.cliSessionId) {
                persistCliSessionId(result.cliSessionId);
                codexBridgeNotifyCliSessionId(result.cliSessionId);
              }
              if (result && result.submitted === false) {
                scheduleSubmitFailureNotify(content, result.recheck, 'Codex history', undefined, result.failureReason, turnSeq);
              }
            } catch (err: any) {
              log(`Codex adopt writeInput error: ${err.message}`);
            }
          } else if ('sendText' in backend && 'sendSpecialKeys' in backend) {
            (backend as any).sendText(content);
            // Beat between text and Enter so the adopted CLI's input layer
            // has time to register the typed chars before submit. Without
            // this, Ink-based TUIs (CoCo, Claude Code) flag the rapid
            // input+Enter as paste continuation and treat the trailing
            // Enter as a soft-newline, leaving the message stranded in the
            // input box. 200ms mirrors the per-adapter writeInput delay
            // that fresh-spawn mode goes through and matches the slash-
            // command (raw_input) fix.
            await new Promise(r => setTimeout(r, 200));
            (backend as any).sendSpecialKeys('Enter');
          } else {
            backend.write(content + '\r');
          }
          isPromptReady = false;
          idleDetector?.reset();
        }
      } else {
        // Non-adopt: enqueue only. Bridge mark is deferred to flushPending
        // so markTimeMs anchors to the actual PTY-write moment, not IPC
        // arrival. Marking now would race with a still-running previous
        // turn whose `botmux send` could sneak its sentAtMs past this
        // turn's markTimeMs and falsely suppress its fallback.
        sendToPty(content, msg.turnId);
      }
      break;
    }

    case 'raw_input': {
      // Slash-command passthrough (e.g. /compact, /model, /usage). Write the
      // literal string + Enter without bracketed paste — otherwise Claude Code
      // treats `/…` as pasted prompt text and the slash-command parser never
      // fires. Also skip adapter.writeInput() / pendingMessages queueing so
      // the prompt wrapping (Session ID, mention hints) is not prepended.
      renderer?.markNewTurn();
      usageLimitTracker.beginTurn(currentUsageLimitSnapshot());
      if (tmuxScrolledHalfPages > 0) exitTmuxScrollMode();
      if (backend) {
        // sendRawCommandLine: literal text → 200ms beat (so the CLI's slash-
        // command picker registers the match before submit; without it Codex /
        // other Ink TUIs fire Enter while the picker is still building, dismiss
        // the match, and submit the literal `/clear` as a regular user prompt —
        // visible to the user as "/clear + 换行" stuck in history; the 200ms
        // mirrors the codex adapter's own writeInput paste-detection delay) →
        // Enter. Shared with runStartupCommands so both stay in lockstep.
        await sendRawCommandLine(backend, msg.content);
        isPromptReady = false;
        idleDetector?.reset();
        log(`Passthrough slash command: ${msg.content}`);
        // Follow-up rides on the SAME IPC (see DaemonToWorker.raw_input) so it
        // cannot race the 200ms text→Enter window above. Enqueue only after the
        // Enter landed: sendToPty queues it as the next turn (type-ahead /
        // pendingMessages), exactly like a Lark message arriving while busy.
        if (msg.followUpContent) {
          sendToPty(msg.followUpContent);
          log(`Enqueued follow-up after raw input (${msg.followUpContent.length} chars)`);
        }
      }
      break;
    }

    case 'park_diagnostic': {
      // The daemon gave up auto-restarting (crash loop) and wants the last
      // terminal output preserved. Park the diagnostic shell now — deferred from
      // onExit so transient (auto-restarted) exits never pay for it. Mark the
      // stopped state even if the tmux park fails, so the next message still
      // retries the CLI (no hang) rather than writing into a dead pane.
      parkCrashDiagnosticTerminal(lastCliExitCode, lastCliExitSignal);
      crashDiagnosticStopped = true;
      break;
    }

    case 'restart': {
      if (lastInitConfig?.adoptMode) {
        log('Restart ignored in adopt mode');
        break;
      }
      log('Restart requested');
      // Tier-2 guard: 2nd consecutive in-worker restart forces FRESH.
      // Increment BEFORE spawnCli so the guard trips at count==2 (i.e. the
      // third attempted spawn in a 1-success → 2-failure sequence):
      //   initial spawn (count=0) → fail → claude_exit → daemon sends restart
      //   1st restart (count=1) → resume still fails → restart
      //   2nd restart (count=2) → tier-2 kicks in → FRESH
      // Tier 1 probe (adapter.checkResumeTargetExists) is re-run on each
      // spawn, so even count=1 often short-circuits; tier-2 only catches
      // silent/race failures and adapters that don't implement the probe.
      consecutiveInWorkerRestarts++;
      log(`Restart count: ${consecutiveInWorkerRestarts} (>=2 forces FRESH)`);
      // Must destroySession(), not kill(): for persistent backends (tmux/herdr)
      // kill() only detaches — the backing session + CLI process keep running,
      // so the resume:true spawnCli below would re-attach to the SAME live CLI
      // (selectSessionBackend reattaches whenever hasSession() is true) and the
      // process would never actually restart. destroySession() tears the session
      // down so the respawn starts a fresh CLI. (PTY has no destroySession, so
      // the ?. no-ops and killCli()'s kill() does the teardown.)
      backend?.destroySession?.();
      killCli();
      awaitingFirstPrompt = true;
      setTimeout(() => {
        if (lastInitConfig) {
          startScreenUpdates();
          startScreenAnalyzer();
          spawnCli({ ...lastInitConfig, resume: true, prompt: '' });
        }
      }, 500);
      break;
    }

    case 'tui_keys': {
      handleTuiKeys(msg.keys, msg.isFinal);
      break;
    }

    case 'tui_text_input': {
      handleTuiTextInput(msg.keys, msg.text);
      break;
    }

    case 'coco_drive_picker': {
      void driveCocoPicker(msg.navKeys, msg.needsReviewSubmit, msg.comment);
      break;
    }

    case 'session_ready': {
      // Claude-family SessionStart hook fired (via `botmux session-ready` →
      // daemon). The CLI's input box is genuinely rendered — release the
      // ready-gate and deliver any held first prompt. Idempotent: a later
      // duplicate (clear/compact source) is a no-op.
      log(`SessionStart ready signal received (source=${msg.source ?? '?'})`);
      // 先记下 gate 是否已被 45s fallback 释放：ReadyGate.receive() 是一次性
      // 语义，fallback 抢先后 releaseReadyGate 会整块跳过迟到的真信号。
      const lateAfterFallback = readyGate.isArmed && readyGate.isReceived;
      releaseReadyGate('SessionStart hook', { promptReadyAfterSettle: true });
      // 冷启动超过 READY_SIGNAL_TIMEOUT_MS 的 CLI（Hermes 常态是 2-3 分钟）恰好
      // 总落在 fallback 之后：fallback 只开闸不投递（非 type-ahead 的
      // flushPending 是 no-op），真信号依然是权威就绪，这里直接兑现。仅限首轮
      // （awaitingFirstPrompt）——首条 prompt 交付后 clear/compact 来源的
      // SessionStart 保持原有 no-op 语义，绝不在会话中途误标就绪。
      if (lateAfterFallback && awaitingFirstPrompt && !isPromptReady) {
        log('Late ready signal after timeout fallback — marking prompt ready now');
        markPromptReady();
      }
      break;
    }

    case 'set_display_mode': {
      log(`Display mode → ${msg.mode}`);
      applyDisplayMode(msg.mode);
      break;
    }

    case 'set_locale': {
      // Daemon hot-reloaded the bot's UI locale — re-pin this worker's default
      // so worker-originated user_notify / final_output strings switch language
      // without a session restart.
      setDefaultLocale(msg.locale);
      log(`Locale → ${msg.locale}`);
      break;
    }

    case 'term_action': {
      handleTermAction(msg.key);
      break;
    }

    case 'refresh_screen': {
      if (displayMode !== 'screenshot') break;
      lastShotHash = '';
      if (screenshotTimer) {
        clearInterval(screenshotTimer);
        screenshotTimer = setInterval(() => { void captureAndUpload(); }, SCREENSHOT_INTERVAL_MS);
      }
      void captureAndUpload();
      log('Manual screenshot refresh');
      break;
    }

    case 'close': {
      log('Close requested');
      stopScreenshotLoop();
      // destroySession kills tmux session permanently; kill() only detaches
      backend?.destroySession?.();
      killCli();
      // Bridge marker file outlives a single CLI process (we keep it across
      // restarts so a mid-flight send is still credited), but a real close
      // tears down the session — purge the file so a future re-use of the
      // same sessionId starts clean.
      clearSendMarkers();
      cleanup();
      process.exit(0);
    }

    case 'suspend': {
      log('Suspend requested');
      stopScreenshotLoop();
      stopBridgeWatcher();
      // A parked crash diagnostic shell has backend===null, so the
      // destroySession/kill below is a no-op and would otherwise leak the
      // bmx-diag-<sid> session. Tear it down explicitly. (The session then
      // cold-resumes a FRESH CLI on the next message — bmx-<sid> is absent.)
      destroyCrashDiagnosticTerminal('suspend');
      // Free the CLI's memory, not just the worker's: destroySession kills the
      // backing tmux/herdr/zellij session AND the CLI process inside it (kill()
      // would only detach the pty viewer and leave the CLI running in the
      // background — defeating the whole point of a session cap, since the CLI
      // is the memory hog). On the next message the session cold-resumes via
      // forkWorker(resume=true) → a fresh `new-session --resume <cliSessionId>`
      // that rebuilds context from the on-disk transcript (same path the daemon
      // uses to recover sessions after a reboot kills the tmux server).
      try { (backend?.destroySession ?? backend?.kill)?.call(backend); } catch { /* best-effort */ }
      backend = null;
      isPromptReady = false;
      // Suspend INTENDS to resume later: preserve the sandbox overlay mount + the
      // upper changeset across the suspension (on resume, prepareSandbox re-mounts
      // over the SAME upper). So we stop the outbox watcher (no live CLI to serve)
      // but DO NOT run sandboxCleanup (which would unmount + rm the changeset). We
      // also disarm the exit-time teardown so process.exit(0) below can't reclaim
      // it. (Crash/SIGKILL of a suspended-but-active session is still backstopped
      // by the daemon's periodic sandbox reconciler.)
      if (sandboxStopWatcher) { try { sandboxStopWatcher(); } catch { /* */ } sandboxStopWatcher = null; }
      sandboxCleanup = null;           // drop the ref WITHOUT calling it (keep the mount)
      sandboxTeardownDone = true;      // make the process.on('exit') hook a no-op
      cleanup();
      process.exit(0);
    }
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  for (const [, cp] of clientPtys) {
    try { cp.kill(); } catch { /* already dead */ }
  }
  clientPtys.clear();
  for (const ws of wsClients) ws.close();
  wsClients.clear();
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (workflowPtyLogStream) {
    try { workflowPtyLogStream.end(); } catch { /* already closed */ }
    workflowPtyLogStream = undefined;
  }
}

process.on('SIGTERM', () => { stopScreenshotLoop(); killCli(); cleanup(); process.exit(0); });
process.on('SIGINT', () => { stopScreenshotLoop(); killCli(); cleanup(); process.exit(0); });
// If parent daemon dies, IPC channel closes — clean up
process.on('disconnect', () => { log('Daemon disconnected'); stopScreenshotLoop(); killCli(); cleanup(); process.exit(0); });

// Watchdog: belt-and-braces parent-death detection. SIGTERM and 'disconnect'
// should both reach us when the daemon dies, but if main thread is stuck in
// a sync path V8 silently buffers the signal and we end up as a ppid=1
// orphan forever (we accumulated 841 such orphans before this guard, eating
// ~65GB of RAM). setInterval itself depends on the event loop, so a
// permanently-stuck thread would still orphan — but real-world stuck
// patterns are periodic (e.g. the v2.9.2 bridge scan was 1s-on / 0.x-off),
// so the 30s tick gets many landing windows. `unref()` keeps the timer
// from preventing a normal exit. `getppid()` is the read fd from /proc/self
// — cheap, sync, no allocation. The daemon-side SIGKILL grace window
// (SHUTDOWN_GRACE_MS in daemon.ts) is the harder backstop.
const ORIGINAL_PARENT_PID = process.ppid;
setInterval(() => {
  const currentPpid = process.ppid;
  if (currentPpid !== ORIGINAL_PARENT_PID || currentPpid === 1) {
    log(`Watchdog: parent pid changed (${ORIGINAL_PARENT_PID} → ${currentPpid}) — daemon died, exiting`);
    stopScreenshotLoop();
    try { killCli(); } catch { /* best-effort */ }
    try { cleanup(); } catch { /* best-effort */ }
    process.exit(0);
  }
}, 30_000).unref();

// ─── Sandbox crash-time teardown ─────────────────────────────────────────────
// killCli() (which unmounts the overlays + rm's the per-session tree) only runs
// from the SIGTERM/SIGINT/disconnect/watchdog handlers and the close/suspend IPC
// cases. An UNCAUGHT exception or unhandled rejection kills the process WITHOUT
// any of those firing, so without this hook a crashed sandboxed worker would
// leak BOTH overlay mounts (mount-table growth) + its upper/work dirs (disk leak)
// per crash. We run a minimal, synchronous, best-effort sandbox teardown here so
// the overlay/dir residue is reclaimed even on an abnormal exit. (SIGKILL still
// can't be trapped — the daemon-side sweep + the periodic reconciler below are
// the backstop for that.)
function teardownSandboxBestEffort(): void {
  if (sandboxTeardownDone) return;
  sandboxTeardownDone = true;
  try { sandboxStopWatcher?.(); } catch { /* */ }
  sandboxStopWatcher = null;
  try { sandboxCleanup?.(); } catch { /* */ }
  sandboxCleanup = null;
  if (seatbeltProfilePath) { try { unlinkSync(seatbeltProfilePath); } catch { /* */ } seatbeltProfilePath = null; }
}
// Under pm2 the worker's stdout/stderr are pipes; a broken pipe (e.g. log
// streaming detaches) would otherwise reach the uncaughtException handler below
// and process.exit(1), killing a live session over a dropped log write. Install
// the guard before any further stdout writes (log() writes to process.stdout).
installStdioEpipeGuard();
process.on('exit', () => { teardownSandboxBestEffort(); });
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  // A broken pipe on stdout/stderr (or any socket) must not tear down a live
  // session — the stdio guard handles those it can; this is the backstop.
  if (isIgnorableStreamError(err)) return;
  try { log(`Uncaught exception — tearing down sandbox before exit: ${err?.stack ?? err}`); } catch { /* */ }
  teardownSandboxBestEffort();
  try { cleanup(); } catch { /* */ }
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  if (isIgnorableStreamError(reason)) return;
  try { log(`Unhandled rejection — tearing down sandbox before exit: ${reason?.stack ?? reason}`); } catch { /* */ }
  teardownSandboxBestEffort();
  try { cleanup(); } catch { /* */ }
  process.exit(1);
});

log('Worker started, waiting for init...');
