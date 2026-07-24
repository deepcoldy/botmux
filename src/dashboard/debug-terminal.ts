// src/dashboard/debug-terminal.ts
//
// 调试终端（Debug terminal）：dashboard 进程内起一个**不绑定任何飞书话题**的临时
// bash PTY，供 owner 在浏览器里粘贴/编辑某个 session 的 CLI 复现命令（见
// dashboard「复制复现命令」）后直接跑，排查线上问题。用完即关。
//
// 为什么放在 dashboard 进程、而不是复用 worker 的会话终端：
//  - worker 侧 `/s/<sessionId>` 终端与 spawnCli / 凭证隔离 / 多 CLI 适配器强耦合，
//    在那里塞一条 bash 分支会波及 20+ CLI × 多后端的共用路径（见根 CLAUDE.md 影响面
//    评估）。调试终端只是一个裸 shell，独立成模块 → 改动面收敛在本文件 + 少量挂载。
//  - dashboard 是 aggregator 前门，本身就跑 HTTP + upgrade，node-pty / ws 依赖都在。
//
// 安全边界（与 write-link 同级）：这是一个**可写 shell**，能任意执行命令、落在真实
// 文件系统。所有入口都要求 dashboard 管理 token（owner / 平台属主）——HTTP 路由挂在
// auth gate 之后，WS upgrade 在本模块内显式校验 cookie。匿名 / 只读视图一律拒绝。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { parseCookie } from './auth.js';

/** 单个 dashboard 最多同时存在的调试终端数——挡住失控泄漏 PTY。 */
const MAX_TERMINALS = 8;
/** 无 WS 连接后多久回收 PTY（ms）。留窗口给刷新/重连。 */
const IDLE_GRACE_MS = 3 * 60_000;
/** 单个调试终端最长存活（ms），无论是否有人连着——兜底防长期占用。 */
const MAX_LIFETIME_MS = 2 * 60 * 60_000;

interface DebugTerminal {
  id: string;
  proc: pty.IPty;
  cwd: string;
  createdAt: number;
  /** 环形 scrollback：新连接/刷新时回放，避免白屏。 */
  scrollback: string[];
  clients: Set<WebSocket>;
  idleTimer: NodeJS.Timeout | null;
  lifetimeTimer: NodeJS.Timeout;
  exited: boolean;
}

const SCROLLBACK_MAX = 2000; // 行

export interface DebugTerminalManager {
  /** 处理 HTTP 请求；返回 true 表示已接管（调用方 return）。假定调用方已过 auth gate。 */
  handleHttp: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  /** 处理 WS upgrade；返回 true 表示已接管。本模块内部自校验 token。 */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** 关掉所有终端（dashboard 退出时）。 */
  shutdown: () => void;
}

export interface DebugTerminalDeps {
  /** 返回当前有效的管理 token，用于 WS upgrade 的 cookie 校验。 */
  getActiveToken: () => string | null;
  /** 默认工作目录候选（bot 配置的工作目录等）；取第一个存在的，否则 homedir。 */
  defaultWorkingDirs?: () => string[];
}

function pickDefaultCwd(deps: DebugTerminalDeps): string {
  for (const d of deps.defaultWorkingDirs?.() ?? []) {
    try {
      if (d && existsSync(d) && statSync(d).isDirectory()) return d;
    } catch { /* skip */ }
  }
  return homedir();
}

/** bash 的运行环境：继承 dashboard 进程 env，并把 ~/.botmux/bin 前置进 PATH，
 *  这样 `botmux`、被 wrapper 的 CLI 等复现命令里的 bin 都能直接找到（与 worker
 *  childEnv.PATH 处理保持一致）。 */
function debugShellEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') base[k] = v;
  base.PATH = `${join(homedir(), '.botmux', 'bin')}:${base.PATH ?? ''}`;
  base.BOTMUX_DEBUG_TERMINAL = '1';
  base.TERM = 'xterm-256color';
  return base;
}

export function createDebugTerminalManager(deps: DebugTerminalDeps): DebugTerminalManager {
  const terminals = new Map<string, DebugTerminal>();

  function destroy(term: DebugTerminal, reason: string): void {
    if (term.exited) return;
    term.exited = true;
    if (term.idleTimer) clearTimeout(term.idleTimer);
    clearTimeout(term.lifetimeTimer);
    try { term.proc.kill(); } catch { /* already gone */ }
    for (const ws of term.clients) {
      try { ws.close(1000, reason); } catch { /* ignore */ }
    }
    term.clients.clear();
    terminals.delete(term.id);
    logger.info(`[debug-terminal] destroyed ${term.id} (${reason})`);
  }

  function armIdleTimer(term: DebugTerminal): void {
    if (term.idleTimer) clearTimeout(term.idleTimer);
    term.idleTimer = setTimeout(() => {
      if (term.clients.size === 0) destroy(term, 'idle');
    }, IDLE_GRACE_MS);
    term.idleTimer.unref?.();
  }

  function create(cwd: string): DebugTerminal | { error: string } {
    if (terminals.size >= MAX_TERMINALS) return { error: 'too_many_terminals' };
    const id = randomBytes(9).toString('base64url');
    let proc: pty.IPty;
    try {
      proc = pty.spawn('/bin/bash', ['-l'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: debugShellEnv() as { [key: string]: string },
      });
    } catch (err: any) {
      return { error: `spawn_failed: ${err?.message ?? err}` };
    }
    const term: DebugTerminal = {
      id,
      proc,
      cwd,
      createdAt: Date.now(),
      scrollback: [],
      clients: new Set(),
      idleTimer: null,
      lifetimeTimer: setTimeout(() => destroy(term, 'max_lifetime'), MAX_LIFETIME_MS),
      exited: false,
    };
    term.lifetimeTimer.unref?.();
    proc.onData((d: string) => {
      term.scrollback.push(d);
      if (term.scrollback.length > SCROLLBACK_MAX) {
        term.scrollback.splice(0, term.scrollback.length - SCROLLBACK_MAX);
      }
      for (const ws of term.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(d);
      }
    });
    proc.onExit(() => destroy(term, 'shell_exited'));
    terminals.set(id, term);
    armIdleTimer(term);
    logger.info(`[debug-terminal] created ${id} in ${cwd} (total ${terminals.size})`);
    return term;
  }

  function isAuthed(req: IncomingMessage): boolean {
    const active = deps.getActiveToken();
    if (!active) return false;
    // Same credential as the management dashboard: cookie set by the `?t=` gate.
    const cookieTok = parseCookie(req.headers.cookie);
    return !!cookieTok && cookieTok === active;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const handleHttp: DebugTerminalManager['handleHttp'] = (req, res, url) => {
    const p = url.pathname;

    // 创建：POST /api/debug-terminal { workingDir? }
    if (req.method === 'POST' && p === '/api/debug-terminal') {
      void (async () => {
        let body: any = {};
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch { body = {}; }
        let cwd = typeof body.workingDir === 'string' && body.workingDir.trim()
          ? body.workingDir.trim()
          : pickDefaultCwd(deps);
        // 目录不存在就退回默认，避免 pty.spawn 直接抛。
        try {
          if (!existsSync(cwd) || !statSync(cwd).isDirectory()) cwd = pickDefaultCwd(deps);
        } catch { cwd = pickDefaultCwd(deps); }
        const r = create(cwd);
        if ('error' in r) {
          res.writeHead(r.error === 'too_many_terminals' ? 429 : 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: r.id, url: `/debug-terminal/${r.id}`, cwd: r.cwd }));
      })();
      return true;
    }

    // 关闭：POST /api/debug-terminal/<id>/close
    let m = p.match(/^\/api\/debug-terminal\/([^/]+)\/close$/);
    if (req.method === 'POST' && m) {
      const term = terminals.get(m[1]);
      if (term) destroy(term, 'closed_by_user');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    // 页面：GET /debug-terminal/<id>
    m = p.match(/^\/debug-terminal\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const term = terminals.get(m[1]);
      if (!term) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>调试终端不存在或已关闭</h1>');
        return true;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(debugTerminalHtml(term.id, term.cwd));
      return true;
    }

    return false;
  };

  // ── WebSocket ───────────────────────────────────────────────────────────────
  // ws 只做协议升级，不绑定 http server（我们手动 handleUpgrade），因为 dashboard
  // 的 upgrade 事件是全局共享的。
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade: DebugTerminalManager['handleUpgrade'] = (req, socket, head) => {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split(/[?#]/)[0];
    const m = pathname.match(/^\/debug-terminal\/([^/]+)\/ws$/);
    if (!m) return false;
    // WS 绕过 HTTP auth gate——在此显式校验管理 token。
    if (!isAuthed(req)) { try { socket.destroy(); } catch { /* ignore */ } return true; }
    const term = terminals.get(m[1]);
    if (!term || term.exited) { try { socket.destroy(); } catch { /* ignore */ } return true; }
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      term.clients.add(ws);
      if (term.idleTimer) { clearTimeout(term.idleTimer); term.idleTimer = null; }
      // 回放 scrollback，让刷新/新窗口不至于白屏。
      for (const chunk of term.scrollback) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'input' && typeof msg.data === 'string') {
            term.proc.write(msg.data);
          } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
            try { term.proc.resize(msg.cols, msg.rows); } catch { /* pty gone */ }
          }
        } catch { /* ignore malformed frame */ }
      });
      ws.on('close', () => {
        term.clients.delete(ws);
        if (term.clients.size === 0 && !term.exited) armIdleTimer(term);
      });
      ws.on('error', () => {
        term.clients.delete(ws);
        if (term.clients.size === 0 && !term.exited) armIdleTimer(term);
      });
    });
    return true;
  };

  const shutdown: DebugTerminalManager['shutdown'] = () => {
    for (const term of [...terminals.values()]) destroy(term, 'dashboard_shutdown');
  };

  return { handleHttp, handleUpgrade, shutdown };
}

// xterm.js 页面。刻意精简（无移动端工具栏），复用 CDN 资源与 worker 终端一致的深色主题。
function debugTerminalHtml(id: string, cwd: string): string {
  const safeCwd = cwd.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>调试终端 · ${id.slice(0, 6)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#1a1b26;overflow:hidden}
body{display:flex;flex-direction:column;height:100vh;height:100dvh}
#bar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 12px;
  background:rgba(21,22,30,0.92);color:#a9b1d6;font:12px/1.4 monospace;
  border-bottom:1px solid rgba(122,162,247,0.24)}
#bar .cwd{color:#7aa2f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
#bar .st{color:#565f89}
#bar .st.ok{color:#9ece6a}#bar .st.err{color:#f7768e}
#terminal{flex:1;min-height:0;width:100%}
#terminal .xterm{height:100%}
</style>
</head>
<body>
<div id="bar">
  <span>🐚 调试终端</span>
  <span class="cwd" title="${safeCwd}">${safeCwd}</span>
  <span class="st" id="st">连接中…</span>
</div>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script>
(function(){
  var term = new Terminal({ cursorBlink:true, fontFamily:'monospace', fontSize:13,
    theme:{ background:'#1a1b26', foreground:'#c0caf5', cursor:'#c0caf5' } });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch(e){}
  term.open(document.getElementById('terminal'));
  fit.fit();
  var st = document.getElementById('st');
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var ws = new WebSocket(proto + '://' + location.host + '/debug-terminal/${id}/ws');
  ws.onopen = function(){
    st.textContent = '已连接'; st.className = 'st ok';
    sendResize();
    term.focus();
  };
  ws.onclose = function(){ st.textContent = '已断开'; st.className = 'st err'; };
  ws.onerror = function(){ st.textContent = '连接错误'; st.className = 'st err'; };
  ws.onmessage = function(ev){ term.write(ev.data); };
  term.onData(function(d){ if (ws.readyState === 1) ws.send(JSON.stringify({ type:'input', data:d })); });
  function sendResize(){
    fit.fit();
    if (ws.readyState === 1) ws.send(JSON.stringify({ type:'resize', cols:term.cols, rows:term.rows }));
  }
  window.addEventListener('resize', sendResize);
})();
</script>
</body>
</html>`;
}
