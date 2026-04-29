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
import { mkdirSync, writeFileSync, unlinkSync, existsSync, statSync, readdirSync, readlinkSync, readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { drainTranscript, joinAssistantText, findJsonlContainingFingerprint, findLatestJsonl, extractLastAssistantTurn, stringifyUserContent, type TranscriptEvent } from './services/claude-transcript.js';
import { BridgeTurnQueue, makeFingerprint } from './services/bridge-turn-queue.js';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from './services/bridge-fallback-gate.js';
import { dirname } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon, DisplayMode, TermActionKey } from './types.js';
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
import { createCliAdapterSync } from './adapters/cli/registry.js';
import { claudeJsonlPathForSession, resolveJsonlFromPid } from './adapters/cli/claude-code.js';
import type { CliAdapter } from './adapters/cli/types.js';
import { PtyBackend } from './adapters/backend/pty-backend.js';
import { TmuxBackend } from './adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from './adapters/backend/tmux-pipe-backend.js';
import type { SessionBackend } from './adapters/backend/types.js';
import { IdleDetector } from './utils/idle-detector.js';
import { ScreenAnalyzer } from './utils/screen-analyzer.js';
import { captureToPng } from './utils/screenshot-renderer.js';
import { uploadImageBuffer } from './utils/lark-upload.js';
import { config } from './config.js';
import * as sessionStore from './services/session-store.js';
import * as pty from 'node-pty';
import { createHash } from 'node:crypto';

// ─── State ───────────────────────────────────────────────────────────────────

let cliAdapter: CliAdapter | null = null;
let backend: SessionBackend | null = null;
let cliPidMarker: string | null = null;  // path to .botmux-cli-pids/<pid>
let idleDetector: IdleDetector | null = null;
let isTmuxMode = false;
/** Adopt-bridge mode using TmuxPipeBackend: not a tmux attach client, all
 *  web-terminal updates flow through the shared scrollback fan-out instead
 *  of per-WS attach-session PTYs. Set in spawnCli's adopt branch. */
let isPipeMode = false;
let httpServer: ReturnType<typeof createHttpServer> | null = null;
let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();
const authedClients = new WeakSet<WebSocket>();
/** Per-WS-client tmux attach PTYs (tmux mode only). */
const clientPtys = new Map<WebSocket, pty.IPty>();
const writeToken = randomBytes(16).toString('hex');

let sessionId = '';
let lastInitConfig: Extract<DaemonToWorker, { type: 'init' }> | null = null;
const CLI_DISPLAY_NAMES: Record<string, string> = { 'claude-code': 'Claude', aiden: 'Aiden', coco: 'CoCo', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' };
function cliName(): string { return CLI_DISPLAY_NAMES[lastInitConfig?.cliId ?? ''] ?? 'CLI'; }
let isPromptReady = false;
/** Mutex for async flushPending — prevents concurrent flush loops. */
let isFlushing = false;
const pendingMessages: string[] = [];

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
 *  ~/.claude/sessions/<pid>.json — Claude's own authoritative record of the
 *  current sessionId — and switch the watched jsonl when Claude rotates
 *  (via /clear, /resume, --resume etc.) without waiting for a Lark message
 *  to land in the new file. */
let bridgeCliPid: number | undefined;
let bridgeCliCwd: string | undefined;
/** Last sessionId we observed via the pid resolver — used to detect
 *  rotations cheaply (string compare instead of stat()ing every jsonl). */
let bridgeObservedCliSessionId: string | undefined;
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
/** True once we successfully baselined the transcript file. Until then,
 *  any data we see is treated as history — absorbed into the queue's seen
 *  set without being attributed to a pending Lark turn. This protects the
 *  first Lark turn from inheriting historical lines if Claude Code creates
 *  the JSONL file *after* attach. */
let bridgeBaselineDone = false;
/** Once-per-attach flag so a re-baseline after fs.watch lazy-fire doesn't
 *  re-send the preamble. Reset only when the bridge teardown happens. */
let bridgePreambleSent = false;

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

/** Compose a `final_output` payload for a turn synthesised from a user
 *  prompt the human typed directly into the adopted pane. Shows both the
 *  user text and assistant text so the Lark thread doesn't see an orphan
 *  reply with no context. Returns `null` when neither side has anything
 *  visible — the worker should suppress the emit in that case. */
function formatLocalTurnContent(userText: string, assistantText: string): string | null {
  const u = truncatePreambleText(userText.trim(), LOCAL_TURN_USER_MAX);
  const a = truncatePreambleText(assistantText.trim(), LOCAL_TURN_ASSISTANT_MAX);
  if (!u && !a) return null;
  return [
    '🖥️ 终端本地对话（在 adopted pane 中直接输入，已同步至飞书）',
    '',
    '👤 你：',
    u || '(空)',
    '',
    `🤖 ${cliName()}：`,
    a || '(空)',
  ].join('\n');
}

// ─── Bridge fallback marker (non-adopt) ────────────────────────────────────
//
// `botmux send` (cli.ts cmdSend) appends a line `{sentAtMs, messageId}\n` to
// `<DATA_DIR>/turn-sends/<sid>.jsonl` every time the model successfully posts
// a reply to its OWN session thread. The worker reads these markers at idle
// and suppresses transcript-driven final_output for any turn whose time
// window already contains a send — i.e. the model didn't forget, no fallback
// needed. Append-only over a shared file (instead of a per-turn marker) is
// type-ahead safe: type-ahead'd turns each have their own [markTimeMs,
// nextTurn.markTimeMs) window, and a stray send only fills its own bucket.
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
  if (bridgePreambleSent) return;
  const turn = extractLastAssistantTurn(events);
  if (!turn) return;
  bridgePreambleSent = true;
  send({
    type: 'adopt_preamble',
    userText: truncatePreambleText(turn.userText, PREAMBLE_USER_MAX),
    assistantText: truncatePreambleText(turn.assistantText, PREAMBLE_ASSISTANT_MAX),
  });
  log('Bridge adopt preamble emitted (last completed turn from baseline)');
}

function bridgeAbsorbBaseline(): void {
  if (!bridgeJsonlPath) return;
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

/** Detect /clear / /resume: when Claude Code starts a new session in the
 *  user's pane it writes to a brand-new sessionId.jsonl. We *cannot* use
 *  "latest-mtime jsonl in the project dir" as the switch trigger — that
 *  hijacks our watcher whenever a sibling Claude pane in the same cwd
 *  writes anything. Instead, switch only when:
 *
 *    1. We have an unstarted pending Lark turn (otherwise no signal to
 *       chase, and switching would risk grabbing another pane's reply).
 *    2. The pending turn's content fingerprint shows up in a candidate
 *       jsonl other than our current one — that's the user's current
 *       session because they JUST typed our pane-write into it.
 *
 *  Pending turns are preserved across the switch so the next ingest can
 *  match the fingerprint and start the turn in the new file. */
function maybeSwitchBridgeJsonl(): boolean {
  if (!bridgeJsonlDir) return false;
  const pending = bridgeQueue.peek();
  const candidate = pending.find(t => !t.started && !!t.contentFingerprint);
  if (!candidate || !candidate.contentFingerprint) return false;

  // Bound the search to events written after the turn was marked. Short
  // fingerprints ("hello", "test") would otherwise match old user lines
  // in unrelated sibling jsonls. 5s skew absorbs clock drift between the
  // mark and Claude's transcript write.
  const minEventTimestampMs = candidate.markTimeMs !== undefined
    ? candidate.markTimeMs - 5_000
    : undefined;

  const matched = findJsonlContainingFingerprint(
    bridgeJsonlDir,
    candidate.contentFingerprint,
    {
      excludePath: bridgeJsonlPath,
      includeQueueOperations: true,
      minEventTimestampMs,
    },
  );
  if (!matched) return false;

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

  log(`Bridge transcript switched: ${bridgeJsonlPath} → ${matched} (Lark fingerprint observed in new jsonl — user likely ran /clear or /resume)`);
  if (bridgeWatcher) {
    try { bridgeWatcher.close(); } catch { /* ignore */ }
    bridgeWatcher = null;
  }
  // Critically: do NOT clear pending turns. The switch was triggered by
  // the fingerprint of the FIRST pending turn already living in `matched`,
  // so the immediate next ingest from offset 0 will find that user event
  // and start the turn. Clearing here would race-drop exactly the message
  // we're trying to deliver.
  bridgeJsonlPath = matched;
  bridgeOffset = 0;
  bridgePendingTail = '';
  // baselineDone=false would absorb the new file's existing content
  // (including the pending turn's user event) as history — defeating the
  // switch. Skip baseline; fall straight into ingest from offset 0 so
  // BridgeTurnQueue.ingest() can attribute the matching user/assistant.
  bridgeBaselineDone = true;
  try {
    bridgeWatcher = fsWatch(matched, { persistent: false }, () => {
      try { bridgeIngest(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable on new target (${err.message}); relying on fallback poller`);
  }
  return true;
}

/** /clear or /resume in the user's adopted pane creates (or touches) a new
 *  jsonl in the same Claude project directory. Neither pid-resolver nor
 *  fingerprint switch will fire when the rotation happened mid-process AND
 *  there's no pending Lark turn to anchor on (pure local-terminal use), so
 *  this fallback owns that case.
 *
 *  Detection priority:
 *    1. Linux first-class: read `/proc/<pid>/fd` and pick the .jsonl the
 *       adopted Claude process actually has open. This is bound to the real
 *       PID — a sibling Claude pane in the same cwd has a different PID and
 *       therefore cannot hijack the result.
 *    2. Cross-platform fallback: directory-level mtime heuristic, gated on
 *       (a) our current jsonl quiet ≥ QUIET_ROTATION_MS, (b) candidate
 *       newer by ≥ QUIET_ROTATION_MS, (c) adopted Claude pid alive. Less
 *       robust than fd lookup but the best available without /proc.
 *
 *  When a rotation is detected, the new jsonl is drained from offset 0 and
 *  events are split by timestamp against `rotationCutoffMs` (the old
 *  jsonl's last-write time): events before the cutoff are *history*
 *  (absorbed into the seen-set, not emitted), events after are *live*
 *  (ingested → local-turn synthesis runs). This is what lets /resume to a
 *  long-history jsonl NOT replay the entire past as one giant local turn,
 *  while /clear's first new turn still gets forwarded.
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
  const history: TranscriptEvent[] = [];
  const live: TranscriptEvent[] = [];
  for (const ev of result.events) {
    let evMs = Number.NaN;
    if (typeof ev.timestamp === 'string') evMs = Date.parse(ev.timestamp);
    if (Number.isFinite(evMs) && evMs <= cutoffMs) history.push(ev);
    else live.push(ev);
  }
  bridgeQueue.absorb(history);
  if (live.length > 0) bridgeQueue.ingest(live, newPath);
  bridgeBaselineDone = true;
  log(`Bridge rotation split: ${history.length} historical events absorbed, ${live.length} live events ingested`);

  try {
    bridgeWatcher = fsWatch(newPath, { persistent: false }, () => {
      try { bridgeIngest(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
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
    const newest = newestPath(opened);
    if (newest && newest !== bridgeJsonlPath) {
      performRotationSwitch(newest, currentStat.mtimeMs, `pid fd → ${bridgeCliPid}`);
    }
    // fd lookup succeeded — even if it confirmed the current path, the
    // mtime fallback below would only add risk. Stop here.
    return;
  }

  // Path 2: non-Linux fallback (or /proc unavailable). Directory-mtime
  // heuristic with three guards. Less robust than fd lookup; sibling
  // panes could in principle race the conditions, but the QUIET windows
  // make it unlikely in practice.
  const now = Date.now();
  if (now - currentStat.mtimeMs < QUIET_ROTATION_MS) return;
  const latest = findLatestJsonl(bridgeJsonlDir);
  if (!latest || latest === bridgeJsonlPath) return;
  const latestStat = statSafe(latest);
  if (!latestStat) return;
  if (latestStat.mtimeMs - currentStat.mtimeMs < QUIET_ROTATION_MS) return;
  performRotationSwitch(latest, currentStat.mtimeMs, `quiet mtime fallback (${Math.round((now - currentStat.mtimeMs) / 1000)}s quiet)`);
}

/** Authoritative rotation follow: re-read ~/.claude/sessions/<cliPid>.json
 *  and switch bridgeJsonlPath whenever Claude's recorded sessionId differs
 *  from what we're watching. Same source as the writeInput pid resolver,
 *  with the same cwd + procStart validation. Returns true on switch.
 *
 *  This replaces the original mtime-based "latest jsonl" hack and runs
 *  *before* the fingerprint-based fallback (`maybeSwitchBridgeJsonl`),
 *  because the pid file is updated on every Claude state change so it
 *  catches /clear / /resume / Claude restart cases that have no Lark
 *  fingerprint to match against. */
/** Tri-state result so callers can distinguish "pid file unreadable, fall
 *  back to fingerprint heuristic" from "pid file confirmed current path"
 *  vs "pid file said rotate to a new path". The fingerprint fallback must
 *  only run on `unavailable` — when pid resolver gave us an answer we
 *  trust it as the source of truth, otherwise short Lark fingerprints
 *  (e.g. "hello") can hijack the watcher to an unrelated sibling jsonl. */
type PidFollowResult = 'unavailable' | 'same' | 'switched';

function maybeFollowSessionRotationViaPid(): PidFollowResult {
  if (!bridgeCliPid || !bridgeCliCwd) return 'unavailable';
  const resolved = resolveJsonlFromPid(bridgeCliPid, bridgeCliCwd);
  if (!resolved) return 'unavailable';
  if (bridgeObservedCliSessionId !== resolved.cliSessionId) {
    bridgeObservedCliSessionId = resolved.cliSessionId;
  }
  if (resolved.path === bridgeJsonlPath) return 'same';

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
      try { bridgeIngest(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable on rotated target (${err.message}); relying on fallback poller`);
  }
  return 'switched';
}

function bridgeIngest(): void {
  // Drain secondary paths first so any trailing assistant text on an old
  // jsonl reaches the queue before the rotation check considers retiring
  // the path. Strictly read-only on the polling rotation; never triggers
  // a rotate or shifts the primary path.
  drainSecondaryPaths();
  // Pid-resolver: catches *spawn-time* rotations (new Claude PID → new
  // pid file → new sessionId), e.g. daemon restart that re-issues
  // `--resume <id>` and Claude rotates the internal id.
  const pidFollow = maybeFollowSessionRotationViaPid();
  // Fingerprint fallback: catches *in-process* rotations Claude makes
  // via /clear or /resume from the user's pane. Claude's pid file has
  // its sessionId field set ONCE at process start (see binary persistence
  // schema) and is NOT rewritten on /clear, so pid resolver returning
  // 'same' is NOT proof that no rotation happened. We skip the
  // fingerprint scan only when pid resolver actively switched the path
  // — in that case the authoritative source already moved us, and
  // running fingerprint on top would risk a redundant flip.
  let switched = pidFollow === 'switched';
  if (!switched) {
    switched = maybeSwitchBridgeJsonl();
  }
  // Quiet-rotation fallback: catches /clear or /resume in pure-local
  // sessions (no pending Lark turn → no fingerprint to match against).
  // Without this, a user who hits /clear in the adopted pane and then
  // continues in the terminal would never get those replies forwarded
  // to Lark — the watcher stays stuck on the old, frozen jsonl.
  if (!switched) {
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
  bridgeQueue.ingest(result.events, bridgeJsonlPath);
}

function startBridgeWatcher(jsonlPath: string, opts?: { cliPid?: number; cliCwd?: string; mode?: 'baseline-existing' | 'fresh-empty' }): void {
  bridgeJsonlPath = jsonlPath;
  bridgeJsonlDir = dirname(jsonlPath);
  bridgeCliPid = opts?.cliPid;
  bridgeCliCwd = opts?.cliCwd;
  const mode = opts?.mode ?? 'baseline-existing';
  // Authoritative: prefer Claude's own pid-state record over the path the
  // adopt scan computed. If Claude has already rotated since adopt fired
  // (e.g. user ran /clear before any Lark message arrived), this swaps the
  // initial path before baseline so we don't waste a baseline on a frozen
  // file.
  if (bridgeCliPid && bridgeCliCwd) {
    const resolved = resolveJsonlFromPid(bridgeCliPid, bridgeCliCwd);
    if (resolved) {
      bridgeObservedCliSessionId = resolved.cliSessionId;
      if (resolved.path !== bridgeJsonlPath) {
        log(`Bridge transcript adjusted at start (pid resolver): ${bridgeJsonlPath} → ${resolved.path}`);
        bridgeJsonlPath = resolved.path;
        bridgeJsonlDir = dirname(resolved.path);
      }
    }
  }
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
      try { bridgeIngest(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
    });
  } catch (err: any) {
    log(`Bridge fs.watch unavailable (${err.message}); relying on fallback poller`);
  }
  bridgeFallbackTimer = setInterval(() => {
    try { bridgeIngest(); } catch (err: any) { log(`Bridge ingest error: ${err.message}`); }
  }, 1000);
}

function stopBridgeWatcher(): void {
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
  bridgeSecondaryPaths.clear();
  bridgePreambleSent = false;
}

/**
 * Push a pending turn for the next Lark message.
 *
 * Returns true on success, false if bridge-final-output isn't available for
 * this message (transcript not yet baselined). On false, the worker still
 * raw-writes the message into the pane — the user just won't get a
 * transcript-driven final_output reply for it. This keeps the v3 promise:
 * if we can't attribute correctly, we don't attribute at all.
 *
 * `messageText` is the raw Lark message body — we derive a short content
 * fingerprint from it so the next *matching* user event in the transcript
 * (and only that one) starts this turn. Local-terminal input that races
 * with the pane-write will not match the fingerprint and won't hijack the
 * Lark turn.
 */
function bridgeMarkPendingTurn(messageText: string): boolean {
  if (!bridgeJsonlPath) return false;
  if (!bridgeBaselineDone) {
    log('Bridge baseline not ready — this turn will not have transcript-driven final_output');
    return false;
  }
  const fingerprint = makeFingerprint(messageText);
  bridgeQueue.mark(randomBytes(8).toString('hex'), fingerprint);
  return true;
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
    if (shouldSuppressBridgeEmit({ markTimeMs: turn.markTimeMs, isLocal: turn.isLocal }, nextBoundaryMs, markers, adoptMode)) {
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
    const assistantText = joinAssistantText(matched);
    if (assistantText.length === 0) continue;
    const lastUuid = turn.assistantUuids[turn.assistantUuids.length - 1];

    if (turn.isLocal) {
      // Local turn (adopt mode only): also surface the user prompt so the
      // Lark thread shows both sides of the exchange. User text comes from
      // the same drained transcript via the userUuid stamped at start time.
      const userEv = turn.userUuid
        ? drained.events.find(e => e.uuid === turn.userUuid)
        : undefined;
      const userText = userEv ? stringifyUserContent(userEv.message?.content) : '';
      const content = formatLocalTurnContent(userText, assistantText);
      if (!content) continue;
      send({ type: 'final_output', content, lastUuid, turnId: turn.turnId });
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
let screenUpdateTimer: ReturnType<typeof setInterval> | null = null;
const SCREEN_UPDATE_INTERVAL_MS = 2_000;

// ─── Scrollback Buffer (replay to late-connecting WS clients) ───────────────

const MAX_SCROLLBACK = 1_000_000; // chars (~1MB)
let scrollback = '';
/** Tracks whether the CLI is currently in the alt screen buffer. Updated by
 *  scanning PTY output for DECSET 1049/47/1047 toggles. Used when trimming
 *  scrollback at cap so replay always starts with the correct buffer mode —
 *  otherwise a cap-time slice can drop the alt-buffer-enter and every
 *  subsequent TUI redraw lands in the *normal* buffer, producing the
 *  "scrolling up shows several duplicated screens" bug. */
let altBufferActive = false;
const ALT_ENTER_RE = /\x1b\[\?(1049|1047|47)h/g;
const ALT_EXIT_RE = /\x1b\[\?(1049|1047|47)l/g;

// ─── Screen Analyzer (AI-based TUI prompt detection) ────────────────────────

let screenAnalyzer: ScreenAnalyzer | null = null;
/** When true, user messages are queued because a TUI prompt is active */
let tuiPromptBlocking = false;

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
      getSnapshot: () => renderer?.rawSnapshot() ?? '',
      onAnalyzing: () => { /* no-op: only block when prompt is actually detected */ },
      onTuiPrompt: (description, options, multiSelect) => {
        tuiPromptBlocking = true;
        send({ type: 'tui_prompt', description, options, multiSelect });
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

function startScreenshotLoop(): void {
  stopScreenshotLoop();
  screenshotTimer = setInterval(() => { void captureAndUpload(); }, SCREENSHOT_INTERVAL_MS);
  // Capture immediately so the user gets a first frame fast
  void captureAndUpload();
}

function stopScreenshotLoop(): void {
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  if (pendingShotTimer) { clearTimeout(pendingShotTimer); pendingShotTimer = null; }
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
  if (displayMode !== 'screenshot') return;
  if (awaitingFirstPrompt) return;
  if (!renderer) return;
  if (!larkAppIdForUpload || !larkAppSecretForUpload) return;

  const term = renderer.xterm;
  const startY = term.buffer.active.baseY;

  // Hash dedup — same content → skip upload
  const snap = renderer.rawSnapshot();
  const hash = createHash('md5').update(snap).digest('hex');
  if (hash === lastShotHash) return;
  lastShotHash = hash;

  let png: Buffer;
  try {
    const shotCols = clamp(term.cols, MIN_RENDER_COLS, MAX_RENDER_COLS);
    const shotRows = clamp(term.rows, MIN_RENDER_ROWS, MAX_RENDER_ROWS);
    png = captureToPng(term, { cols: shotCols, rows: shotRows, startY });
  } catch (err: any) {
    log(`Screenshot render failed: ${err.message}`);
    return;
  }

  let imageKey: string;
  try {
    imageKey = await uploadImageBuffer(larkAppIdForUpload, larkAppSecretForUpload, png);
  } catch (err: any) {
    log(`Screenshot upload failed: ${err.message}`);
    return;
  }

  let status: 'working' | 'idle' | 'analyzing' = isPromptReady ? 'idle' : 'working';
  if (screenAnalyzer?.isAnalyzing) status = 'analyzing';
  send({ type: 'screenshot_uploaded', imageKey, status });
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

// ─── Trust Dialog Detection ──────────────────────────────────────────────────

// Claude Code: "Yes, I trust this folder"
// Codex:       "› 1. Yes, continue  2. No, quit" (ANSI cursor codes strip spaces from
//               longer phrases like "Do you trust…", but "Yes, continue" survives intact
//               in a single PTY chunk)
const TRUST_DIALOG_PATTERN = /Yes, I trust this folder|Yes, continue/;
let trustHandled = false;

// ─── Prompt Detection ────────────────────────────────────────────────────────

function onPtyData(data: string): void {
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

  // Delegate idle detection to IdleDetector
  idleDetector?.feed(data);
}

function markPromptReady(): void {
  if (isPromptReady) return;  // guard against duplicate calls
  isPromptReady = true;
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
    send({ type: 'screen_update', content, status: 'idle' });
  }
  flushPending();
}

function persistCliSessionId(cliSessionId: string): void {
  if (!cliSessionId || !sessionId) return;
  if (lastInitConfig) lastInitConfig.cliSessionId = cliSessionId;
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
  // Type-ahead adapters flush even while the CLI is busy; others wait for idle.
  // Bridge fallback (non-adopt) disables type-ahead: queued submits land
  // in jsonl as `attachment(queued_command)` events, NOT `role:user` lines,
  // so BridgeTurnQueue.ingest never starts the pending turn for them and
  // the assistant text would be dropped on the floor. Serialise instead —
  // worker holds messages in pendingMessages until the CLI reaches idle.
  const typeAheadAllowed = cliAdapter.supportsTypeAhead && !(bridgeJsonlPath && !lastInitConfig?.adoptMode);
  if (!isPromptReady && !typeAheadAllowed) return;

  const bridgeFallbackActive = !!bridgeJsonlPath && !lastInitConfig?.adoptMode;

  isFlushing = true;
  if (isPromptReady) {
    isPromptReady = false;
    idleDetector?.reset();
  }

  try {
    while (pendingMessages.length > 0 && backend && cliAdapter) {
      const msg = pendingMessages.shift()!;
      // Bridge fallback: mark immediately before writeInput. Doing it here
      // (instead of at enqueue time) means markTimeMs anchors to the
      // moment the message actually starts hitting the PTY — so any
      // `botmux send` whose sentAtMs lands during turn N's processing
      // falls inside [markTimeMs(N), markTimeMs(N+1)). Marking earlier
      // (at IPC arrival) would let a slow-finishing turn N's send leak
      // into turn N+1's window and falsely suppress its emit.
      if (bridgeFallbackActive) {
        try { bridgeIngest(); } catch { /* best-effort */ }
        bridgeMarkPendingTurn(msg);
      }
      log(`Writing to PTY (flush): "${msg.substring(0, 80)}"`);
      const result = await cliAdapter.writeInput(backend, msg);
      // Persist any sessionId the adapter observed via authoritative sources
      // (Claude's pid file, Codex's history). Done independently of submit
      // outcome — the rotation is real even when the current Enter didn't
      // land, and we want next-resume to use the right id.
      if (result?.cliSessionId) persistCliSessionId(result.cliSessionId);
      if (result && result.submitted === false) {
        const preview = msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
        log(`writeInput: submit not confirmed after retries — notifying user. preview="${preview}"`);
        send({
          type: 'user_notify',
          message: `⚠️ 刚才那条消息发给 ${cliName()} 后没能确认提交（重试 Enter 3 次仍未在会话 JSONL 中看到新记录）。可能卡在输入框里——请去 Web 终端看一下，手动按 Enter 或重发。\n开头：${preview}`,
        });
      }
      // Bridge fallback: stop after one writeInput. Subsequent submits
      // would be type-ahead'd into Claude's queue, which jsonl records as
      // queued_command attachments (not role:user lines) — BridgeTurnQueue
      // can't attribute those, so the fallback would silently drop them.
      // We resume on the next idle, by which point Claude has finished
      // and the next message can be a normal role:user submit. Scoped to
      // bridgeFallbackActive so non-bridge CLIs (codex/gemini/...) keep
      // the original "one idle drains all pending" behaviour.
      if (bridgeFallbackActive && pendingMessages.length > 0) break;
    }
  } finally {
    isFlushing = false;
  }
}

function sendToPty(content: string): void {
  if (!backend || !cliAdapter) return;
  pendingMessages.push(content);
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
  // See flushPending: bridge fallback gates type-ahead off.
  const typeAheadAllowed = cliAdapter.supportsTypeAhead && !(bridgeJsonlPath && !lastInitConfig?.adoptMode);
  if (isPromptReady || isFlushing || typeAheadAllowed) {
    log(`Writing to PTY: "${content.substring(0, 80)}"`);
    flushPending();  // fire-and-forget async; no-op if already flushing
  } else {
    log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — ${cliName()} is busy`);
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
  screenUpdateTimer = setInterval(() => {
    if (!renderer || awaitingFirstPrompt) return;
    const { content, changed } = renderer.snapshot();
    let status: 'working' | 'idle' | 'analyzing' = isPromptReady ? 'idle' : 'working';
    if (screenAnalyzer?.isAnalyzing) status = 'analyzing';
    // Send update when content changed OR status changed (e.g. idle → analyzing)
    if (changed || status !== lastSentStatus) {
      lastSentStatus = status;
      send({ type: 'screen_update', content, status });
    }
  }, SCREEN_UPDATE_INTERVAL_MS);
}

function stopScreenUpdates(): void {
  if (screenUpdateTimer) { clearInterval(screenUpdateTimer); screenUpdateTimer = null; }
  if (renderer) { renderer.dispose(); renderer = null; }
}

// ─── PTY Management ──────────────────────────────────────────────────────────

function spawnCli(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  // ── Adopt mode: pipe-pane the user's existing tmux pane (no attach) ──
  if (cfg.adoptMode && cfg.adoptTmuxTarget) {
    // We mark BOTH isTmuxMode and isPipeMode: the former keeps idle/spawn
    // logic on the tmux track; the latter tells the WS handler to route
    // updates through the shared scrollback fan-out (because there is no
    // PTY-per-WS — we don't attach to anything).
    isTmuxMode = true;
    isPipeMode = true;
    const cols = cfg.adoptPaneCols ?? PTY_COLS;
    const rows = cfg.adoptPaneRows ?? PTY_ROWS;
    const pipeBe = new TmuxPipeBackend(cfg.adoptTmuxTarget);
    backend = pipeBe;
    pipeBe.spawn('', [], {
      cwd: cfg.workingDir,
      cols,
      rows,
      env: process.env as Record<string, string>,
    });

    // Seed the shared scrollback with the pane's current screen so any
    // already-connected (or future) WS clients render meaningful content
    // immediately, instead of waiting for the next byte tmux pipes through.
    try {
      const initial = pipeBe.captureCurrentScreen();
      if (initial.length > 0) onPtyData(initial);
    } catch (err: any) {
      log(`captureCurrentScreen failed: ${err.message}`);
    }

    // Bridge mode: tail Claude Code's transcript JSONL to harvest assistant
    // turns out-of-band. Only enabled when the daemon supplied a path
    // (claude-code adopt with a known sessionId).
    if (cfg.bridgeJsonlPath) {
      startBridgeWatcher(cfg.bridgeJsonlPath, {
        cliPid: cfg.adoptCliPid,
        cliCwd: cfg.adoptCwd,
      });
    }

    // Idle detection. In bridge mode we use Claude Code's real
    // completion/ready patterns (e.g. "Worked for Xs") so tool-execution
    // pauses don't trigger a premature emit. Other adopt cases keep the
    // minimal output-quiescence-only detector.
    const idleAdapter = cfg.bridgeJsonlPath
      ? createCliAdapterSync('claude-code', undefined)
      : ({ completionPattern: undefined, readyPattern: undefined } as any);
    idleDetector = new IdleDetector(idleAdapter);
    idleDetector.onIdle(() => {
      log('Prompt detected (idle) — adopt mode');
      try { bridgeDrainAndMaybeEmit(); } catch (err: any) { log(`Bridge emit error: ${err.message}`); }
      markPromptReady();
    });

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
    log(`Adopt mode (pipe): observing ${cfg.adoptTmuxTarget} (${cols}x${rows})`);
    return;
  }

  cliAdapter = createCliAdapterSync(cfg.cliId as any, cfg.cliPathOverride);
  const useTmux = cfg.backendType === 'tmux';
  isTmuxMode = useTmux;
  const tmuxBe = useTmux ? new TmuxBackend(TmuxBackend.sessionName(cfg.sessionId)) : null;
  backend = tmuxBe ?? new PtyBackend();

  // Claude Code appends a line to ~/.claude/projects/<cwd-hash>/<sid>.jsonl each
  // time the user submits. The adapter uses this file to verify paste+Enter
  // actually committed (rather than trusting a fixed sleep), so wire it up now.
  // Codex's adapter uses ~/.codex/history.jsonl (a fixed global path) directly,
  // so it needs no per-session wiring here.
  if (cfg.cliId === 'claude-code') {
    (backend as TmuxBackend | PtyBackend).claudeJsonlPath =
      claudeJsonlPathForSession(cfg.sessionId, cfg.workingDir);
  }

  const args = cliAdapter.buildArgs({
    sessionId: cfg.sessionId,
    resume: cfg.resume ?? false,
    resumeSessionId: cfg.cliSessionId,
    initialPrompt: cfg.prompt || undefined,
    botName: cfg.botName,
    botOpenId: cfg.botOpenId,
  });

  // Extra args from env (CLI_DISABLE_DEFAULT_ARGS is removed — adapters own their defaults)
  const extra = (process.env.CLI_EXTRA_ARGS ?? '').trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  // Claude Code 在 root/sudo 下会拒绝 --dangerously-skip-permissions 并立即 exit。
  // botmux 必须带这个 flag（话题里没法弹交互式审批），所以为 root 自动注入
  // IS_SANDBOX=1 走 Claude Code 的受控环境逃生舱。用户显式设了就尊重不覆盖。
  const injectClaudeSandbox =
    cfg.cliId === 'claude-code' &&
    process.getuid?.() === 0 &&
    !process.env.IS_SANDBOX;
  if (injectClaudeSandbox) {
    log('Detected root user — injecting IS_SANDBOX=1 for Claude Code');
  }

  log(`Spawning: ${cliAdapter.resolvedBin} ${args.join(' ')} (cwd: ${cfg.workingDir})`);

  backend.spawn(cliAdapter.resolvedBin, args, {
    cwd: cfg.workingDir,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      ...(injectClaudeSandbox ? { IS_SANDBOX: '1' } : {}),
    } as unknown as Record<string, string>,
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
      writeFileSync(cliPidMarker, cfg.sessionId);
      log(`CLI PID marker written: ${cliPid}`);
    } catch (err: any) {
      log(`Failed to write CLI PID marker: ${err.message}`);
    }
  }

  // Wire pid + cwd so the claude-code adapter's writeInput can read
  // ~/.claude/sessions/<pid>.json — Claude's authoritative current sessionId.
  // The pinned claudeJsonlPath above is still used as the initial guess; the
  // resolver corrects it on first write when Claude has rotated under us.
  if (cfg.cliId === 'claude-code' && cliPid) {
    (backend as TmuxBackend | PtyBackend).cliPid = cliPid;
    (backend as TmuxBackend | PtyBackend).cliCwd = cfg.workingDir;
  }

  // On tmux re-attach, keep awaitingFirstPrompt = true so screen updates are
  // suppressed until the idle detector fires markNewTurn() — this prevents the
  // full tmux scrollback history from leaking into the streaming card.
  if (tmuxBe?.isReattach) {
    log('Re-attached to existing tmux session');
  }

  // Bridge fallback: claude-code only. Tail Claude's transcript JSONL so a
  // turn the model finishes WITHOUT calling `botmux send` still gets its
  // assistant text forwarded to Lark (the gate in emitReadyTurns suppresses
  // the emit when a send did happen). Adopt mode wires this up separately
  // (with baseline-existing); here we use fresh-empty for new sessions so
  // the file Claude creates on first submit isn't absorbed as history,
  // and baseline-existing on resume so prior-run turns ARE absorbed (we
  // don't want to re-emit yesterday's conversation as fresh turns).
  if (cfg.cliId === 'claude-code' && cfg.sessionId) {
    const claudeJsonl = claudeJsonlPathForSession(cfg.sessionId, cfg.workingDir);
    startBridgeWatcher(claudeJsonl, {
      cliPid: cliPid ?? undefined,
      cliCwd: cfg.workingDir,
      mode: cfg.resume ? 'baseline-existing' : 'fresh-empty',
    });
  }

  // Set up idle detection
  idleDetector = new IdleDetector(cliAdapter);
  idleDetector.onIdle(() => {
    log('Prompt detected (idle)');
    // Bridge drain MUST run before markPromptReady() — the latter calls
    // flushPending() which can immediately fire the next queued message
    // (type-ahead adapters), shifting bridgeQueue's notion of "current
    // turn" before we've had a chance to emit the previous one.
    if (bridgeJsonlPath) {
      try { bridgeDrainAndMaybeEmit(); } catch (err: any) { log(`Bridge emit error: ${err.message}`); }
    }
    markPromptReady();
  });

  backend.onData(onPtyData);
  backend.onExit((code, signal) => {
    log(`${cliName()} exited (code: ${code}, signal: ${signal})`);
    backend = null;
    isPromptReady = false;
    send({ type: 'claude_exit', code, signal });
  });

  // Fallback: if the CLI takes too long to show its prompt (e.g. slow
  // plugin init), unblock screen updates so the card doesn't stay at
  // "启动中" forever.  markNewTurn() sets a clean baseline at the current
  // cursor position so only content written *after* this point appears in
  // the card.
  setTimeout(() => {
    if (awaitingFirstPrompt) {
      awaitingFirstPrompt = false;
      renderer?.markNewTurn();
      log('First prompt timeout — enabling screen updates');
    }
  }, 15_000);
}

function killCli(): void {
  idleDetector?.dispose();
  idleDetector = null;
  stopScreenAnalyzer();
  stopScreenUpdates();
  backend?.kill();
  backend = null;
  // Tear down the bridge watcher (if any). spawnCli will rebuild it on
  // restart with the proper mode based on the new cfg. Leaving it running
  // would dangle a watcher pinned to a stale jsonl path.
  stopBridgeWatcher();
  // Clean up CLI PID marker
  if (cliPidMarker) {
    try { unlinkSync(cliPidMarker); } catch { /* already gone */ }
    cliPidMarker = null;
  }
  isPromptReady = false;
  pendingMessages.length = 0;
  scrollback = '';
  altBufferActive = false;
  trustHandled = false;
}

// ─── HTTP + WebSocket Server ─────────────────────────────────────────────────

function startWebServer(host: string, preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const hasWrite = url.searchParams.get('token') === writeToken;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getTerminalHtml(hasWrite));
    });

    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws, req: IncomingMessage) => {
      wsClients.add(ws);

      // Check token from query string for write access
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const hasWrite = url.searchParams.get('token') === writeToken;
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
        const tmuxTarget = lastInitConfig?.adoptTmuxTarget ?? TmuxBackend.sessionName(sessionId);
        let cp: pty.IPty | null = null;
        const pendingInput: string[] = [];

        const startAttach = (cols: number, rows: number) => {
          if (cp) return;
          cp = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
            name: 'xterm-256color',
            cols,
            rows,
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
      } else {
        // ── Non-tmux mode: shared scrollback relay ──
        if (scrollback.length > 0) {
          ws.send(scrollback);
        }

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
              backend?.resize(msg.cols, msg.rows);
            } else if (msg.type === 'input' && typeof msg.data === 'string') {
              if (!authedClients.has(ws)) return; // read-only
              backend?.write(msg.data);
            }
          } catch { /* ignore non-JSON or bad messages */ }
        });

        ws.on('close', () => {
          wsClients.delete(ws);
        });
      }
    });

    const listenPort = preferredPort ?? 0;
    httpServer.listen(listenPort, host, () => {
      const addr = httpServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      log(`HTTP listening on ${host}:${port}`);
      resolve(port);
    });
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (preferredPort && err.code === 'EADDRINUSE') {
        // Preferred port in use — fall back to random
        log(`Preferred port ${preferredPort} in use, falling back to random`);
        httpServer!.listen(0, host, () => {
          const addr = httpServer!.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          log(`HTTP listening on ${host}:${port} (fallback)`);
          resolve(port);
        });
      } else {
        reject(err);
      }
    });
  });
}

function getTerminalHtml(hasWrite: boolean): string {
  const label = sessionId.substring(0, 8);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta id="vp" name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${cliName()} - ${label}</title>
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
#status{position:fixed;top:8px;right:12px;z-index:10;font:12px monospace;
  color:#565f89;background:#1a1b26cc;padding:2px 8px;border-radius:4px}
#status.ok{color:#9ece6a}
#status.err{color:#f7768e}
#readonly-banner{display:none;position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:50;
  padding:4px 10px;font:12px monospace;color:#f7768e;white-space:nowrap;cursor:pointer;
  background:rgba(247,118,142,0.12);border:1px solid rgba(247,118,142,0.35);border-radius:4px;
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
#readonly-banner.show{display:inline-block}
</style>
</head>
<body>
<div id="terminal"></div>
<div id="readonly-banner">只读模式 · 无写入权限</div>
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
<script src="https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js"></script>
<script>
var isTouch='ontouchstart'in window||navigator.maxTouchPoints>0;
if(isTouch)document.getElementById('vp').content='width=1100,viewport-fit=cover';
var hasToken=${hasWrite};
if(!hasToken){var _rb=document.getElementById('readonly-banner');_rb.classList.add('show');_rb.addEventListener('click',function(){_rb.classList.remove('show')});}

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
function sendResize(){if(ws_&&ws_.readyState===1)ws_.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}
window.addEventListener('resize',function(){fit.fit();sendResize()});
(function connect(){
  var t=new URLSearchParams(location.search).get('token')||'';
  var ws=new WebSocket('ws://'+location.host+'/?token='+t);
  ws_=ws;ws.binaryType='arraybuffer';
  ws.onopen=function(){el.textContent='connected';el.className='ok';sendResize()};
  ws.onmessage=function(e){
    var data=typeof e.data==='string'?e.data:new TextDecoder().decode(e.data);
    // Intercept OSC 52 clipboard sequence from tmux (set-clipboard on)
    var m=data.match(/\\x1b\\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\\x07|\\x1b\\\\)/);
    if(m){try{_clipBuf=new TextDecoder().decode(Uint8Array.from(atob(m[1]),function(c){return c.charCodeAt(0)}));_doCopy(_clipBuf);_showCopied()}catch(ex){}}
    term.write(data);
  };
  ws.onclose=function(){ws_=null;el.textContent='disconnected';el.className='err';setTimeout(connect,2000)};
  ws.onerror=function(){ws.close()};
})();

// ── Read-only scroll handling ──
if(!hasToken&&!${isTmuxMode && !isPipeMode}){
  // Non-tmux read-only: CLI mouse mode blocks local scroll, override with scrollLines
  document.getElementById('terminal').addEventListener('wheel',function(e){
    e.preventDefault();term.scrollLines(e.deltaY>0?3:-3);
  },{passive:false});
}

// ── Scroll helper (shared by toolbar buttons & two-finger touch) ──
function _sendScroll(up,n){
  n=n||3;
  if(${isTmuxMode && !isPipeMode}){
    // SGR mouse wheel: 64=up 65=down — tmux enters copy-mode and scrolls
    var seq='\\x1b[<'+(up?64:65)+';1;1M';
    for(var i=0;i<n;i++){if(ws_&&ws_.readyState===1)ws_.send(JSON.stringify({type:'input',data:seq}))}
  }else{
    term.scrollLines(up?-n:n);
  }
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

// ── Two-finger touch scroll via Hammer.js (mobile) ──
// Hammer distinguishes Pan (parallel drag) from Pinch (spread/squeeze)
// internally.  Pan with pointers:2 only fires for genuine two-finger scroll.
if(isTouch&&typeof Hammer!=='undefined'){
  var mc=new Hammer.Manager(document.getElementById('terminal'),{touchAction:'auto',inputClass:Hammer.TouchInput});
  var pinch=new Hammer.Pinch();
  var pan=new Hammer.Pan({pointers:2,direction:Hammer.DIRECTION_VERTICAL,threshold:4});
  pinch.recognizeWith(pan);
  mc.add([pinch,pan]);
  var _panPrevY=0,_panAcc=0;
  mc.on('panstart',function(ev){_panPrevY=ev.center.y;_panAcc=0});
  mc.on('panmove',function(ev){
    var d=ev.center.y-_panPrevY;
    _panPrevY=ev.center.y;
    // Accumulate sub-pixel deltas; fire 1 wheel event per ~85px
    // (tmux scrolls ~5 lines per wheel, line height ~17px)
    _panAcc+=d;
    var step=85;
    while(Math.abs(_panAcc)>=step){
      _sendScroll(_panAcc>0,1);
      _panAcc-=(_panAcc>0?step:-step);
    }
  });
}
</script>
</body>
</html>`;
}

// ─── IPC Communication ───────────────────────────────────────────────────────

function send(msg: WorkerToDaemon): void {
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
      // Scope session store to this bot's per-bot file
      if (msg.larkAppId) sessionStore.init(msg.larkAppId);
      // Capture credentials for direct image upload from worker
      larkAppIdForUpload = msg.larkAppId;
      larkAppSecretForUpload = msg.larkAppSecret;
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
        const port = await startWebServer('0.0.0.0', msg.webPort);
        startScreenUpdates();
        startScreenAnalyzer();
        spawnCli(msg);

        // Queue the initial prompt — flushed when CLI shows idle.
        // Adapters with passesInitialPromptViaArgs (e.g. Gemini -i) bake the
        // prompt into CLI args, so we skip queuing to avoid double-send.
        // Bridge mark is deferred to flushPending — see flushPending
        // comment for why marking at enqueue is wrong.
        if (msg.prompt && !cliAdapter?.passesInitialPromptViaArgs) {
          pendingMessages.push(msg.prompt);
        }

        send({ type: 'ready', port, token: writeToken });
      } catch (err: any) {
        send({ type: 'error', message: `init failed: ${err.message}` });
        process.exit(1);
      }
      break;
    }

    case 'message': {
      // Mark new turn baseline so the streaming card only shows this turn's content
      renderer?.markNewTurn();
      // Cancel any active tmux copy-mode scroll so user input reaches the CLI.
      if (tmuxScrolledHalfPages > 0) exitTmuxScrollMode();
      const content = msg.content;
      if (lastInitConfig?.adoptMode) {
        // Bridge mode: capture transcript baseline BEFORE writing to the pane,
        // so any assistant uuids appended after this point are attributed to
        // *this* Lark turn (not local user activity in the pane). Mark may
        // return false (baseline not ready) — we still write to the pane;
        // user just won't get a final_output for this message.
        if (bridgeJsonlPath) {
          try { bridgeIngest(); } catch { /* best effort */ }
          bridgeMarkPendingTurn(content);
        }
        // Adopt mode: raw write to PTY (no adapter writeInput)
        if (backend) {
          if ('sendText' in backend && 'sendSpecialKeys' in backend) {
            (backend as any).sendText(content);
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
        sendToPty(content);
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
      if (tmuxScrolledHalfPages > 0) exitTmuxScrollMode();
      if (backend) {
        if ('sendText' in backend && 'sendSpecialKeys' in backend) {
          (backend as any).sendText(msg.content);
          (backend as any).sendSpecialKeys('Enter');
        } else {
          backend.write(msg.content + '\r');
        }
        isPromptReady = false;
        idleDetector?.reset();
        log(`Passthrough slash command: ${msg.content}`);
      }
      break;
    }

    case 'restart': {
      if (lastInitConfig?.adoptMode) {
        log('Restart ignored in adopt mode');
        break;
      }
      log('Restart requested');
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

    case 'set_display_mode': {
      log(`Display mode → ${msg.mode}`);
      applyDisplayMode(msg.mode);
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
}

process.on('SIGTERM', () => { stopScreenshotLoop(); killCli(); cleanup(); process.exit(0); });
process.on('SIGINT', () => { stopScreenshotLoop(); killCli(); cleanup(); process.exit(0); });
// If parent daemon dies, IPC channel closes — clean up
process.on('disconnect', () => { log('Daemon disconnected'); stopScreenshotLoop(); killCli(); cleanup(); process.exit(0); });

log('Worker started, waiting for init...');
