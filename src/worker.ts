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
import type { DaemonToWorker, WorkerToDaemon } from './types.js';
import { TerminalRenderer } from './utils/terminal-renderer.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import type { CliAdapter } from './adapters/cli/types.js';
import { PtyBackend } from './adapters/backend/pty-backend.js';
import { TmuxBackend } from './adapters/backend/tmux-backend.js';
import type { SessionBackend } from './adapters/backend/types.js';
import { IdleDetector } from './utils/idle-detector.js';
import * as sessionStore from './services/session-store.js';
import * as pty from 'node-pty';

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
      backend?.write('\r');
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
  // Send immediate idle snapshot so Lark card reflects idle status
  if (renderer) {
    const { content } = renderer.snapshot();
    send({ type: 'screen_update', content, status: 'idle' });
  }
  flushPending();
}

function flushPending(): void {
  log(`flushPending: ${pendingMessages.length} pending, promptReady=${isPromptReady}, hasPty=${!!backend}`);
  while (pendingMessages.length > 0 && isPromptReady && backend && cliAdapter) {
    const msg = pendingMessages.shift()!;
    isPromptReady = false;
    idleDetector?.reset();
    log(`Writing to PTY (flush): "${msg.substring(0, 80)}"`);
    // Fire-and-forget: Aiden's delayed writes are internal to the adapter.
    // Idle detector re-arms on next PTY output, not on write completion.
    cliAdapter.writeInput(backend, msg);
  }
}

function sendToPty(content: string): void {
  if (!backend || !cliAdapter) return;
  if (isPromptReady) {
    isPromptReady = false;
    idleDetector?.reset();
    log(`Writing to PTY: "${content.substring(0, 80)}"`);
    cliAdapter.writeInput(backend, content);
  } else {
    pendingMessages.push(content);
    log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — ${cliName()} is busy`);
  }
}

// ─── Screen Update Timer ─────────────────────────────────────────────────────

function startScreenUpdates(): void {
  renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
  screenUpdateTimer = setInterval(() => {
    if (!renderer || awaitingFirstPrompt) return;
    const { content, changed } = renderer.snapshot();
    if (changed) {
      send({ type: 'screen_update', content, status: isPromptReady ? 'idle' : 'working' });
    }
  }, SCREEN_UPDATE_INTERVAL_MS);
}

function stopScreenUpdates(): void {
  if (screenUpdateTimer) { clearInterval(screenUpdateTimer); screenUpdateTimer = null; }
  if (renderer) { renderer.dispose(); renderer = null; }
}

// ─── PTY Management ──────────────────────────────────────────────────────────

function spawnCli(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
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
      writeFileSync(cliPidMarker, '');
      log(`CLI PID marker written: ${cliPid}`);
    } catch (err: any) {
      log(`Failed to write CLI PID marker: ${err.message}`);
    }
  }

  // On tmux re-attach, CLI is already running — don't suppress first prompt
  if (tmuxBe?.isReattach) {
    awaitingFirstPrompt = false;
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
}

function killCli(): void {
  idleDetector?.dispose();
  idleDetector = null;
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
    httpServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getTerminalHtml());
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
        const tmuxName = TmuxBackend.sessionName(sessionId);
        const cp = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
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

function getTerminalHtml(): string {
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
html,body{height:100%;background:#1a1b26;overflow:hidden}
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
</style>
</head>
<body>
<div id="terminal"></div>
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
<script>
var isTouch='ontouchstart'in window||navigator.maxTouchPoints>0;
if(isTouch)document.getElementById('vp').content='width=1100,viewport-fit=cover';

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
document.getElementById('terminal').addEventListener('contextmenu',function(e){e.preventDefault()});

// ── WebSocket ──
var ws_=null,el=document.getElementById('status');
term.onData(function(d){if(ws_&&ws_.readyState===1)ws_.send(JSON.stringify({type:'input',data:d}))});
function sendResize(){if(ws_&&ws_.readyState===1)ws_.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}
window.addEventListener('resize',function(){fit.fit();sendResize()});
(function connect(){
  var t=new URLSearchParams(location.search).get('token')||'';
  var ws=new WebSocket('ws://'+location.host+'/?token='+t);
  ws_=ws;ws.binaryType='arraybuffer';
  ws.onopen=function(){el.textContent='connected';el.className='ok';sendResize()};
  ws.onmessage=function(e){term.write(typeof e.data==='string'?e.data:new TextDecoder().decode(e.data))};
  ws.onclose=function(){ws_=null;el.textContent='disconnected';el.className='err';setTimeout(connect,2000)};
  ws.onerror=function(){ws.close()};
})();

// ── Read-only scroll handling ──
var hasToken=!!new URLSearchParams(location.search).get('token');
if(!hasToken&&!${isTmuxMode}){
  // Non-tmux read-only: CLI mouse mode blocks local scroll, override with scrollLines
  document.getElementById('terminal').addEventListener('wheel',function(e){
    e.preventDefault();term.scrollLines(e.deltaY>0?3:-3);
  },{passive:false});
}

// ── Touch shortcut toolbar ──
if(isTouch&&hasToken){
  var km={esc:'\\x1b',ctrlc:'\\x03',tab:'\\t',up:'\\x1b[A',down:'\\x1b[B',left:'\\x1b[D',right:'\\x1b[C',enter:'\\r'};
  var tb=document.getElementById('toolbar');
  tb.classList.add('show');
  // Use direct listeners per button — more reliable on mobile than event delegation
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
      log(`Init: session=${sessionId}, cwd=${msg.workingDir}`);

      try {
        const port = await startWebServer('0.0.0.0', msg.webPort);
        startScreenUpdates();
        spawnCli(msg);

        // Queue the initial prompt — flushed when CLI shows idle.
        // Adapters with passesInitialPromptViaArgs (e.g. Gemini -i) bake the
        // prompt into CLI args, so we skip queuing to avoid double-send.
        if (msg.prompt && !cliAdapter?.passesInitialPromptViaArgs) {
          pendingMessages.push(msg.prompt);
        }

        // Queue follow-up messages (buffered while waiting for repo selection)
        if (msg.followUps && msg.followUps.length > 0) {
          for (const fu of msg.followUps) {
            pendingMessages.push(fu);
          }
          log(`Queued ${msg.followUps.length} follow-up message(s)`);
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
      sendToPty(msg.content);
      break;
    }

    case 'restart': {
      log('Restart requested');
      backend?.destroySession?.();
      killCli();
      awaitingFirstPrompt = true;
      setTimeout(() => {
        if (lastInitConfig) {
          startScreenUpdates();
          spawnCli({ ...lastInitConfig, resume: true, prompt: '' });
        }
      }, 500);
      break;
    }

    case 'close': {
      log('Close requested');
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

process.on('SIGTERM', () => { killCli(); cleanup(); process.exit(0); });
process.on('SIGINT', () => { killCli(); cleanup(); process.exit(0); });
// If parent daemon dies, IPC channel closes — clean up
process.on('disconnect', () => { log('Daemon disconnected'); killCli(); cleanup(); process.exit(0); });

log('Worker started, waiting for init...');
