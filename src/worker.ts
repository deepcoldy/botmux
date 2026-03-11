#!/usr/bin/env node
/**
 * Worker process: manages a single Claude Code PTY session + web terminal.
 * Forked by the daemon, communicates via Node.js IPC.
 *
 * Lifecycle:
 *   1. Daemon forks this process
 *   2. Receives 'init' message with session config
 *   3. Spawns CLI via CliAdapter + PtyBackend (interactive mode)
 *   4. Starts HTTP + WebSocket server for xterm.js
 *   5. Receives 'message' events from daemon, writes to PTY stdin
 *   6. On 'close', kills Claude and exits
 *   7. On 'restart', kills Claude and re-spawns with --resume
 */
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon } from './types.js';
import { TerminalRenderer } from './utils/terminal-renderer.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import type { CliAdapter } from './adapters/cli/types.js';
import { PtyBackend } from './adapters/backend/pty-backend.js';
import type { SessionBackend } from './adapters/backend/types.js';
import { IdleDetector } from './utils/idle-detector.js';

// ─── State ───────────────────────────────────────────────────────────────────

let cliAdapter: CliAdapter | null = null;
let backend: SessionBackend | null = null;
let idleDetector: IdleDetector | null = null;
let httpServer: ReturnType<typeof createHttpServer> | null = null;
let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();
const authedClients = new WeakSet<WebSocket>();
const writeToken = randomBytes(16).toString('hex');

let sessionId = '';
let lastInitConfig: Extract<DaemonToWorker, { type: 'init' }> | null = null;
let isPromptReady = false;
const pendingMessages: string[] = [];
/** Suppress screen updates until first prompt detected (avoids history replay in card on --resume) */
let awaitingFirstPrompt = true;

// ─── PTY Dimensions ──────────────────────────────────────────────────────────
// Wide PTY so Claude Code positions right-aligned TUI overlays (timer, timeout)
// far to the right. The snapshot reader only reads the first 160 columns,
// cleanly excluding overlays without any regex hacking.
const PTY_COLS = 300;
const PTY_ROWS = 50;

// ─── Headless Terminal for Screen Capture ────────────────────────────────────

let renderer: TerminalRenderer | null = null;
let screenUpdateTimer: ReturnType<typeof setInterval> | null = null;
const SCREEN_UPDATE_INTERVAL_MS = 2_000;

// ─── Scrollback Buffer (replay to late-connecting WS clients) ───────────────

const MAX_SCROLLBACK = 100_000; // chars
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

  scrollback += data;
  if (scrollback.length > MAX_SCROLLBACK) {
    scrollback = scrollback.slice(-MAX_SCROLLBACK);
  }

  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
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
    log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}" — Claude is busy`);
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

function spawnClaude(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  cliAdapter = createCliAdapterSync(cfg.cliId as any, cfg.cliPathOverride);
  backend = new PtyBackend();

  const args = cliAdapter.buildArgs({
    sessionId: cfg.sessionId,
    resume: cfg.resume ?? false,
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

  // Set up idle detection
  idleDetector = new IdleDetector(cliAdapter);
  idleDetector.onIdle(() => {
    log('Prompt detected (idle)');
    markPromptReady();
  });

  backend.onData(onPtyData);
  backend.onExit((code, signal) => {
    log(`Claude exited (code: ${code}, signal: ${signal})`);
    backend = null;
    isPromptReady = false;
    send({ type: 'claude_exit', code, signal });
  });
}

function killClaude(): void {
  idleDetector?.dispose();
  idleDetector = null;
  stopScreenUpdates();
  backend?.kill();
  backend = null;
  isPromptReady = false;
  pendingMessages.length = 0;
  scrollback = '';
  trustHandled = false;
}

// ─── HTTP + WebSocket Server ─────────────────────────────────────────────────

function startWebServer(host: string): Promise<number> {
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

      // Replay scrollback buffer so late-connecting clients see existing output
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
    });

    httpServer.listen(0, host, () => {
      const addr = httpServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      log(`HTTP listening on ${host}:${port}`);
      resolve(port);
    });
    httpServer.on('error', reject);
  });
}

function getTerminalHtml(): string {
  const label = sessionId.substring(0, 8);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta id="vp" name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Claude Code - ${label}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#1a1b26;overflow:hidden}
body{display:flex;flex-direction:column}
#input-bar{display:none;padding:3px 6px;background:#15161e;border-bottom:1px solid #33467c;
  gap:6px;align-items:flex-end}
#input-bar.show{display:flex}
#input-bar textarea{flex:1;background:#24283b;color:#a9b1d6;border:1px solid #33467c;
  border-radius:4px;padding:4px 8px;font-size:14px;outline:none;resize:none;
  font-family:-apple-system,sans-serif;line-height:1.3;max-height:72px;overflow-y:auto}
#input-bar textarea:focus{border-color:#7aa2f7}
#input-bar button{background:#7aa2f7;color:#1a1b26;border:none;border-radius:4px;
  padding:5px 12px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
#input-bar button:active{opacity:0.7}
#terminal{flex:1;min-height:0}
#terminal .xterm{height:100%}
#status{position:fixed;top:8px;right:12px;z-index:10;font:12px monospace;
  color:#565f89;background:#1a1b26cc;padding:2px 8px;border-radius:4px}
#status.ok{color:#9ece6a}
#status.err{color:#f7768e}
</style>
</head>
<body>
<div id="input-bar">
  <textarea id="mi" rows="1" placeholder="输入消息..." autocomplete="off" autocorrect="off"></textarea>
  <button id="ms">发送</button>
</div>
<div id="terminal"></div>
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
  cursorBlink:!isTouch,disableStdin:isTouch,scrollback:50000,allowProposedApi:true
});
var fit=new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.loadAddon(new Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion='11';
term.open(document.getElementById('terminal'));
fit.fit();

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

// ── Mobile input bar (top) ──
if(isTouch){
  var bar=document.getElementById('input-bar'),mi=document.getElementById('mi'),ms=document.getElementById('ms');
  bar.classList.add('show');
  function send(){
    var v=mi.value;if(!v||!ws_||ws_.readyState!==1)return;
    ws_.send(JSON.stringify({type:'input',data:v+String.fromCharCode(13)}));
    mi.value='';mi.style.height='auto';
    fit.fit();sendResize();
  }
  mi.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,72)+'px';fit.fit()});
  ms.addEventListener('click',send);
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
      log(`Init: session=${sessionId}, cwd=${msg.workingDir}`);

      try {
        const port = await startWebServer('0.0.0.0');
        startScreenUpdates();
        spawnClaude(msg);

        // Queue the initial prompt — flushed when Claude shows ❯
        if (msg.prompt) {
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
      sendToPty(msg.content);
      break;
    }

    case 'restart': {
      log('Restart requested');
      killClaude();
      awaitingFirstPrompt = true;
      setTimeout(() => {
        if (lastInitConfig) {
          startScreenUpdates();
          spawnClaude({ ...lastInitConfig, resume: true, prompt: '' });
        }
      }, 500);
      break;
    }

    case 'close': {
      log('Close requested');
      killClaude();
      cleanup();
      process.exit(0);
    }
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  for (const ws of wsClients) ws.close();
  wsClients.clear();
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
}

process.on('SIGTERM', () => { killClaude(); cleanup(); process.exit(0); });
process.on('SIGINT', () => { killClaude(); cleanup(); process.exit(0); });
// If parent daemon dies, IPC channel closes — clean up
process.on('disconnect', () => { log('Daemon disconnected'); killClaude(); cleanup(); process.exit(0); });

log('Worker started, waiting for init...');
