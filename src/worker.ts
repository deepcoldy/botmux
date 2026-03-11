#!/usr/bin/env node
/**
 * Worker process: manages a single Claude Code PTY session + web terminal.
 * Forked by the daemon, communicates via Node.js IPC.
 *
 * Lifecycle:
 *   1. Daemon forks this process
 *   2. Receives 'init' message with session config
 *   3. Spawns Claude Code in node-pty (interactive mode)
 *   4. Starts HTTP + WebSocket server for xterm.js
 *   5. Receives 'message' events from daemon, writes to PTY stdin
 *   6. On 'close', kills Claude and exits
 *   7. On 'restart', kills Claude and re-spawns with --resume
 */
import * as pty from 'node-pty';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon } from './types.js';
import { TerminalRenderer } from './utils/terminal-renderer.js';

// ─── State ───────────────────────────────────────────────────────────────────

let ptyProcess: pty.IPty | null = null;
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

// ─── Prompt & Trust Dialog Detection ────────────────────────────────────────

// Claude Code / Aiden TUI idle detection.
// Detection strategies (in priority order):
//   1. Completion marker ("✻ Worked for ...") → idle after 500ms
//   2. PTY silence + no recent spinner → idle after QUIESCENCE_MS
const TRUST_DIALOG_PATTERN = /Yes, I trust this folder/;
/** Claude Code spinner frames — these animate while Claude is actively working */
const SPINNER_CHARS_RE = /[·✢✳✶✻✽]/;
/**
 * Claude Code TUI completion marker: "✻ Worked for 1m 2s", "✻ Crunched for 30s", etc.
 * The verb is randomly chosen from: Worked, Crunched, Cogitated, Cooked, Churned, Sautéed.
 * Must include ✻ prefix + time unit to avoid false positives from model output.
 */
const COMPLETION_RE = /✻\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed) for \d+[smh]/;
const QUIESCENCE_MS = 2_000;
let outputTail = '';
let trustHandled = false;
let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
/** Timestamp of last spinner character seen — used to prevent premature idle detection */
let lastSpinnerAt = 0;
/** Whether the CLI is Aiden (multi-line paste needs extra Enter to confirm) */
let useAiden = false;

function writeToPty(content: string): void {
  if (!ptyProcess) return;
  if (useAiden) {
    // Aiden TUI treats a single write("content\r") as a paste where \r is just
    // a newline.  To actually submit, we must send \r as a separate write after
    // a short delay so it's interpreted as the Enter key.
    ptyProcess.write(content);
    setTimeout(() => {
      ptyProcess?.write('\r');
      // Multi-line pastes show "[Pasted text]" and need an extra Enter to confirm.
      if (content.includes('\n')) {
        setTimeout(() => { ptyProcess?.write('\r'); }, 200);
      }
    }, 200);
  } else {
    ptyProcess.write(content + '\r');
  }
}

function markPromptReady(): void {
  if (isPromptReady) return;
  isPromptReady = true;
  outputTail = '';
  if (quiescenceTimer) { clearTimeout(quiescenceTimer); quiescenceTimer = null; }

  // On first prompt after spawn/resume: reset the renderer baseline so history
  // output (from --resume replay) is excluded from subsequent snapshots.
  if (awaitingFirstPrompt) {
    awaitingFirstPrompt = false;
    renderer?.markNewTurn();
  }

  send({ type: 'prompt_ready' });
  // Send a final screen snapshot so the card updates to "idle" immediately
  if (renderer) {
    const { content } = renderer.snapshot();
    send({ type: 'screen_update', content, status: 'idle' });
  }
  flushPending();
}

function onPtyData(data: string): void {
  // Feed data to headless terminal for screen capture
  renderer?.write(data);

  // Buffer for late-connecting WS clients
  scrollback += data;
  if (scrollback.length > MAX_SCROLLBACK) {
    scrollback = scrollback.slice(-MAX_SCROLLBACK);
  }

  // Broadcast to all connected WebSocket clients
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }

  // Track the tail of output for prompt/dialog detection.
  // We strip ANSI escape codes for reliable matching.
  const stripped = stripAnsi(data);
  outputTail = (outputTail + stripped).slice(-500);

  // Track spinner animation — spinner chars mean Claude is actively working.
  // But "✻ Worked for Xm Ys" is a static completion marker, not animation.
  if (SPINNER_CHARS_RE.test(stripped) && !COMPLETION_RE.test(outputTail)) {
    lastSpinnerAt = Date.now();
  }

  // Auto-accept "trust this folder" dialog by sending Enter
  if (!trustHandled && TRUST_DIALOG_PATTERN.test(outputTail)) {
    trustHandled = true;
    log('Trust dialog detected, auto-accepting...');
    if (ptyProcess) ptyProcess.write('\r');
    return;
  }

  // Strategy 1 — "✻ Worked for Xm Ys" completion marker.
  // Check outputTail (not stripped) because PTY data arrives in arbitrary chunks.
  if (!isPromptReady && COMPLETION_RE.test(outputTail)) {
    if (quiescenceTimer) clearTimeout(quiescenceTimer);
    quiescenceTimer = setTimeout(() => {
      quiescenceTimer = null;
      if (!isPromptReady) {
        log('Prompt detected (completion marker)');
        markPromptReady();
      }
    }, 500);
    return;
  }

  // Strategy 2 — quiescence: PTY goes silent and no spinner activity.
  // In TUI mode both Claude Code and Aiden render the prompt via cursor
  // positioning, so we can't rely on seeing a specific prompt char at line end.
  // Instead, once PTY is silent for QUIESCENCE_MS and no spinner was seen
  // recently (3s guard), we assume the CLI is waiting for input.
  if (quiescenceTimer) clearTimeout(quiescenceTimer);
  if (!isPromptReady) {
    quiescenceTimer = setTimeout(function quiescenceCheck() {
      quiescenceTimer = null;
      if (isPromptReady) return;
      // If spinner was seen within the last 3s, CLI is still working —
      // reschedule to check again after the guard expires (don't get stuck)
      const sinceSpinner = Date.now() - lastSpinnerAt;
      if (sinceSpinner < 3_000) {
        quiescenceTimer = setTimeout(quiescenceCheck, 3_000 - sinceSpinner + 200);
        return;
      }
      log('Prompt detected (quiescence)');
      markPromptReady();
    }, QUIESCENCE_MS);
  }
}

function stripAnsi(str: string): string {
  // Replace cursor-forward (CSI <n> C) with spaces so word boundaries are preserved,
  // then strip remaining ANSI escape sequences.
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlmsuJ]/g, '');
}

function flushPending(): void {
  log(`flushPending: ${pendingMessages.length} pending, promptReady=${isPromptReady}, hasPty=${!!ptyProcess}`);
  while (pendingMessages.length > 0 && isPromptReady && ptyProcess) {
    const msg = pendingMessages.shift()!;
    isPromptReady = false;
    outputTail = '';
    lastSpinnerAt = Date.now();
    log(`Writing to PTY (flush): "${msg.substring(0, 80)}"`);
    writeToPty(msg);
  }
}

function sendToPty(content: string): void {
  if (!ptyProcess) return;

  if (isPromptReady) {
    isPromptReady = false;
    outputTail = '';
    lastSpinnerAt = Date.now(); // Assume working immediately after sending input
    log(`Writing to PTY: "${content.substring(0, 80)}"`);
    writeToPty(content);
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

function isAidenCli(claudePath: string): boolean {
  return /\baiden\b/.test(claudePath);
}

function spawnClaude(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  const args: string[] = [];
  const aiden = isAidenCli(cfg.claudePath);
  useAiden = aiden;

  if (cfg.resume) {
    args.push('--resume', cfg.sessionId);
  } else if (!aiden) {
    // Claude Code supports --session-id for new sessions; Aiden auto-generates
    args.push('--session-id', cfg.sessionId);
  }

  if (aiden) {
    args.push('--permission-mode', 'agentFull');
  } else {
    args.push('--dangerously-skip-permissions');
  }

  log(`Spawning: ${cfg.claudePath} ${args.join(' ')} (cwd: ${cfg.workingDir})`);

  ptyProcess = pty.spawn(cfg.claudePath, args, {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: cfg.workingDir,
    env: { ...process.env, CLAUDECODE: undefined } as unknown as Record<string, string>,
  });

  ptyProcess.onData(onPtyData);

  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`Claude exited (code: ${exitCode}, signal: ${signal}), last output: ${JSON.stringify(outputTail.slice(-200))}`);
    ptyProcess = null;
    isPromptReady = false;
    send({ type: 'claude_exit', code: exitCode, signal: signal !== undefined ? String(signal) : null });
  });
}

function killClaude(): void {
  if (quiescenceTimer) { clearTimeout(quiescenceTimer); quiescenceTimer = null; }
  stopScreenUpdates();
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch { /* already dead */ }
    ptyProcess = null;
  }
  isPromptReady = false;
  pendingMessages.length = 0;
  outputTail = '';
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
            if (ptyProcess) {
              ptyProcess.resize(msg.cols, msg.rows);
            }
          } else if (msg.type === 'input' && typeof msg.data === 'string') {
            if (!authedClients.has(ws)) return; // read-only
            if (ptyProcess) {
              ptyProcess.write(msg.data);
            }
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
      awaitingFirstPrompt = true; // suppress history during --resume replay
      // Brief delay for PTY cleanup, then re-spawn with --resume
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
