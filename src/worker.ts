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
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon, DisplayMode, TermActionKey } from './types.js';
import { TerminalRenderer } from './utils/terminal-renderer.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import type { CliAdapter } from './adapters/cli/types.js';
import { PtyBackend } from './adapters/backend/pty-backend.js';
import { TmuxBackend } from './adapters/backend/tmux-backend.js';
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
/** Suppress screen updates until first prompt detected (avoids history replay in card on --resume) */
let awaitingFirstPrompt = true;

// ─── PTY Dimensions ──────────────────────────────────────────────────────────
// Wide PTY so CLI positions right-aligned TUI overlays (timer, timeout)
// far to the right. The snapshot reader only reads the first 160 columns,
// cleanly excluding overlays without any regex hacking.
const PTY_COLS = 300;
const PTY_ROWS = 50;

// ─── Headless Terminal for Screen Capture ────────────────────────────────────

let renderer: TerminalRenderer | null = null;
let screenUpdateTimer: ReturnType<typeof setInterval> | null = null;
const SCREEN_UPDATE_INTERVAL_MS = 2_000;

// ─── Scrollback Buffer (replay to late-connecting WS clients) ───────────────

const MAX_SCROLLBACK = 1_000_000; // chars (~1MB)
let scrollback = '';

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
const SHOT_COLS = 160;
const SHOT_ROWS = 50;

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
    png = captureToPng(term, { cols: SHOT_COLS, rows: SHOT_ROWS, startY });
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

  // In tmux mode, web clients have their own tmux attach — no relay needed.
  // In non-tmux mode, broadcast to all WS clients via shared scrollback.
  if (!isTmuxMode) {
    scrollback += data;
    if (scrollback.length > MAX_SCROLLBACK) {
      scrollback = scrollback.slice(-MAX_SCROLLBACK);
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
  if (!isPromptReady && !cliAdapter.supportsTypeAhead) return;

  isFlushing = true;
  if (isPromptReady) {
    isPromptReady = false;
    idleDetector?.reset();
  }

  try {
    while (pendingMessages.length > 0 && backend && cliAdapter) {
      const msg = pendingMessages.shift()!;
      log(`Writing to PTY (flush): "${msg.substring(0, 80)}"`);
      await cliAdapter.writeInput(backend, msg);
    }
  } finally {
    isFlushing = false;
  }
}

function sendToPty(content: string): void {
  if (!backend || !cliAdapter) return;
  pendingMessages.push(content);
  if (tuiPromptBlocking) {
    log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — TUI prompt active`);
    return;
  }
  if (isPromptReady || isFlushing || cliAdapter.supportsTypeAhead) {
    log(`Writing to PTY: "${content.substring(0, 80)}"`);
    flushPending();  // fire-and-forget async; no-op if already flushing
  } else {
    log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — ${cliName()} is busy`);
  }
}

// ─── Screen Update Timer ─────────────────────────────────────────────────────

function startScreenUpdates(): void {
  renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
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
  // ── Adopt mode: attach to an existing tmux pane (no CLI spawn) ──
  if (cfg.adoptMode && cfg.adoptTmuxTarget) {
    isTmuxMode = true;
    const cols = cfg.adoptPaneCols ?? PTY_COLS;
    const rows = cfg.adoptPaneRows ?? PTY_ROWS;
    const tmuxBe = new TmuxBackend('adopt-' + cfg.sessionId.slice(0, 8), { ownsSession: false });
    backend = tmuxBe;
    tmuxBe.attachToExisting(cfg.adoptTmuxTarget, {
      cwd: cfg.workingDir,
      cols,
      rows,
      env: process.env as Record<string, string>,
    });

    // Minimal idle detection (output quiescence only)
    idleDetector = new IdleDetector({ completionPattern: undefined, readyPattern: undefined } as any);
    idleDetector.onIdle(() => {
      log('Prompt detected (idle) — adopt mode');
      markPromptReady();
    });

    backend.onData(onPtyData);
    backend.onExit((code, signal) => {
      log(`Adopted session exited (code: ${code}, signal: ${signal})`);
      backend = null;
      isPromptReady = false;
      send({ type: 'claude_exit', code, signal });
    });

    // CLI is already running — unblock screen updates immediately
    awaitingFirstPrompt = false;
    renderer?.markNewTurn();
    log(`Adopt mode: attached to ${cfg.adoptTmuxTarget} (${cols}x${rows})`);
    return;
  }

  cliAdapter = createCliAdapterSync(cfg.cliId as any, cfg.cliPathOverride);
  const useTmux = cfg.backendType === 'tmux';
  isTmuxMode = useTmux;
  const tmuxBe = useTmux ? new TmuxBackend(TmuxBackend.sessionName(cfg.sessionId)) : null;
  backend = tmuxBe ?? new PtyBackend();

  const args = cliAdapter.buildArgs({
    sessionId: cfg.sessionId,
    resume: cfg.resume ?? false,
    initialPrompt: cfg.prompt || undefined,
  });

  // Extra args from env (CLI_DISABLE_DEFAULT_ARGS is removed — adapters own their defaults)
  const extra = (process.env.CLI_EXTRA_ARGS ?? '').trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  log(`Spawning: ${cliAdapter.resolvedBin} ${args.join(' ')} (cwd: ${cfg.workingDir})`);

  backend.spawn(cliAdapter.resolvedBin, args, {
    cwd: cfg.workingDir,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    env: { ...process.env, CLAUDECODE: undefined } as unknown as Record<string, string>,
  });

  // Write CLI PID marker so the MCP server can verify it was spawned by botmux.
  // The MCP server checks if process.ppid has a marker in this directory.
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

  // On tmux re-attach, keep awaitingFirstPrompt = true so screen updates are
  // suppressed until the idle detector fires markNewTurn() — this prevents the
  // full tmux scrollback history from leaking into the streaming card.
  if (tmuxBe?.isReattach) {
    log('Re-attached to existing tmux session');
  }

  // Set up idle detection
  idleDetector = new IdleDetector(cliAdapter);
  idleDetector.onIdle(() => {
    log('Prompt detected (idle)');
    markPromptReady();
  });

  backend.onData(onPtyData);
  backend.onExit((code, signal) => {
    log(`${cliName()} exited (code: ${code}, signal: ${signal})`);
    backend = null;
    isPromptReady = false;
    send({ type: 'claude_exit', code, signal });
  });

  // Fallback: if the CLI takes too long to show its prompt (e.g. slow MCP
  // server init), unblock screen updates so the card doesn't stay at "启动中"
  // forever.  markNewTurn() sets a clean baseline at the current cursor
  // position so only content written *after* this point appears in the card.
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
  // Clean up CLI PID marker
  if (cliPidMarker) {
    try { unlinkSync(cliPidMarker); } catch { /* already gone */ }
    cliPidMarker = null;
  }
  isPromptReady = false;
  pendingMessages.length = 0;
  scrollback = '';
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

      if (isTmuxMode && sessionId) {
        // ── Tmux mode: per-client attach ──
        // Each WS client gets its own `tmux attach-session` PTY.
        // Scrollback is handled natively by tmux (history-limit).
        // In adopt mode, attach to the user's original pane; otherwise use bmx-* session.
        const tmuxTarget = lastInitConfig?.adoptTmuxTarget ?? TmuxBackend.sessionName(sessionId);
        const cp = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
        });
        clientPtys.set(ws, cp);

        cp.onData((d: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(d);
        });
        cp.onExit(() => {
          clientPtys.delete(ws);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
              cp.resize(msg.cols, msg.rows);
            } else if (msg.type === 'input' && typeof msg.data === 'string') {
              if (!authedClients.has(ws)) {
                // Read-only: allow mouse events through (scroll/click are
                // non-destructive in tmux — just views history / selects text).
                // SGR mouse: \x1b[<...  X10 mouse: \x1b[M...
                if (!/^\x1b\[([<M])/.test(msg.data)) return;
              }
              cp.write(msg.data);
            }
          } catch { /* ignore non-JSON or bad messages */ }
        });

        ws.on('close', () => {
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
#readonly-banner{display:none;position:fixed;top:0;left:0;right:0;z-index:50;
  padding:6px 12px;text-align:center;font:12px monospace;color:#f7768e;
  background:rgba(247,118,142,0.12);border-bottom:1px solid rgba(247,118,142,0.35);
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);pointer-events:none}
#readonly-banner.show{display:block}
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
if(!hasToken)document.getElementById('readonly-banner').classList.add('show');

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
  if(!hasToken){_showReadonlyToast();return;}
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
if(!hasToken&&!${isTmuxMode}){
  // Non-tmux read-only: CLI mouse mode blocks local scroll, override with scrollLines
  document.getElementById('terminal').addEventListener('wheel',function(e){
    e.preventDefault();term.scrollLines(e.deltaY>0?3:-3);
  },{passive:false});
}

// ── Scroll helper (shared by toolbar buttons & two-finger touch) ──
function _sendScroll(up,n){
  n=n||3;
  if(${isTmuxMode}){
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
      log(`Init: session=${sessionId}, cwd=${msg.workingDir}`);

      try {
        const port = await startWebServer('0.0.0.0', msg.webPort);
        startScreenUpdates();
        startScreenAnalyzer();
        spawnCli(msg);

        // Queue the initial prompt — flushed when CLI shows idle.
        // Adapters with passesInitialPromptViaArgs (e.g. Gemini -i) bake the
        // prompt into CLI args, so we skip queuing to avoid double-send.
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
        sendToPty(content);
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

    case 'set_display_mode': {
      log(`Display mode → ${msg.mode}`);
      applyDisplayMode(msg.mode);
      break;
    }

    case 'term_action': {
      handleTermAction(msg.key);
      break;
    }

    case 'close': {
      log('Close requested');
      stopScreenshotLoop();
      // destroySession kills tmux session permanently; kill() only detaches
      backend?.destroySession?.();
      killCli();
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
