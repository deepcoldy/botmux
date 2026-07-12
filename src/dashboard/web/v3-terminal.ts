/**
 * Per-node terminal panel for the v3 dashboard.
 *
 * Input contract is deliberately small and safe:
 *   - no worker write token
 *   - no raw filesystem path
 *   - replay fetches the cookie-auth `/api/v3/.../pty-log` endpoint
 */
import type { RunNodeView } from '../../workflows/v3/ops-projection.js';

export type NodeTerminalRenderKind = 'live' | 'replay' | 'empty';

export interface NodeTerminalRender {
  kind: NodeTerminalRenderKind;
  signature: string;
  html: string;
}

/** Signature of a node's terminal-relevant inputs. React keeps the iframe DOM
 *  mounted across polling ticks unless this value, prefixed by node id, changes. */
export function nodeTerminalSignature(node: RunNodeView): string {
  const wt = node.webTerminal;
  return `${wt?.status ?? '-'}|${wt?.sessionId ?? '-'}|${wt?.webPort ?? '-'}|${node.hasPtyLog ? '1' : '0'}`;
}

export function renderNodeTerminal(container: HTMLElement, runId: string, node: RunNodeView): void {
  container.setAttribute('data-run-id', runId);
  container.setAttribute('data-node-id', node.id);
  container.innerHTML = buildNodeTerminalRender(runId, node).html;
}

export function buildNodeTerminalRender(
  runId: string,
  node: RunNodeView,
  options: { host?: string } = {},
): NodeTerminalRender {
  const signature = nodeTerminalSignature(node);

  const wt = node.webTerminal;
  if (wt?.status === 'live' && wt.webPort && wt.webPort > 0) {
    return { kind: 'live', signature, html: liveTerminalHtml(wt.webPort, wt.sessionId, options.host) };
  }

  if (node.hasPtyLog) {
    return { kind: 'replay', signature, html: replayTerminalHtml(runId, node.id, wt?.status === 'closed') };
  }

  const message = wt?.status === 'live' ? '终端正在启动，稍后刷新' : '暂无终端记录';
  return { kind: 'empty', signature, html: emptyTerminalHtml(message) };
}

function liveTerminalHtml(webPort: number, sessionId: string, host?: string): string {
  const url = liveTerminalUrl(webPort, host, sessionId);
  return `<div class="v3-terminal-panel">
    <div class="v3-terminal-head">
      <span class="v3-terminal-dot live"></span>
      <span>实时终端（只读）</span>
      <span class="muted">:${webPort}</span>
      <a class="btn-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">新窗口打开</a>
    </div>
    <iframe class="wf-terminal-frame v3-terminal-frame" src="${escapeAttr(url)}" title="v3 live terminal" loading="lazy"></iframe>
  </div>`;
}

function replayTerminalHtml(runId: string, nodeId: string, closed: boolean): string {
  const endpoint = `/api/v3/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/pty-log`;
  const srcdoc = buildReplayTerminalSrcdoc(endpoint, `${runId} / ${nodeId}`);
  return `<div class="v3-terminal-panel">
    <div class="v3-terminal-head">
      <span class="v3-terminal-dot ${closed ? 'closed' : 'replay'}"></span>
      <span>${closed ? '终端回放' : '终端记录'}</span>
      <span class="muted">PTY log</span>
      <a class="btn-link" href="${escapeAttr(endpoint)}" target="_blank" rel="noopener">下载/打开原始日志</a>
    </div>
    <iframe class="wf-terminal-frame v3-terminal-frame" srcdoc="${escapeAttr(srcdoc)}" title="v3 terminal replay" loading="lazy"></iframe>
  </div>`;
}

function emptyTerminalHtml(message: string): string {
  return `<div class="v3-terminal-empty muted">${escapeHtml(message)}</div>`;
}

export function liveTerminalUrl(webPort: number, host?: string, sessionId?: string): string {
  if (sessionId && typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return `${window.location.origin}/s/${encodeURIComponent(sessionId)}`;
  }
  return `http://${host ?? browserHost()}:${webPort}/`;
}

function browserHost(): string {
  return typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname || '127.0.0.1';
}

export function buildReplayTerminalSrcdoc(endpoint: string, title: string): string {
  const endpointJson = JSON.stringify(endpoint);
  const titleText = escapeHtml(title);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
  <style>
    html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
    #bar{height:31px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#161b22;border-bottom:1px solid #30363d;box-sizing:border-box}
    #status{margin-left:auto;color:#8b949e;white-space:nowrap}
    #term{height:calc(100% - 31px);padding:4px;box-sizing:border-box;overflow:auto}
    a{color:#58a6ff;text-decoration:none}
  </style>
</head>
<body>
  <div id="bar"><span>${titleText}</span><span id="status">loading...</span></div>
  <div id="term"></div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"><\/script>
  <script>
  (function(){
    var endpoint=${endpointJson};
    // v3 ephemeral workers spawn their PTY at DEFAULT_RENDER_COLS (=160, see
    // worker.ts) and never adopt, so the captured stream's TUI / box-drawing
    // is exactly 160 cols wide.  Fitting it into a narrower (or oddly-measured)
    // grid re-wraps those fixed-width lines into a stair-stepped mess and
    // wastes the panel.  So we render at the capture width and let FitAddon
    // only size the ROW count to the iframe height (cols pinned back to 160).
    var COLS=160;
    var status=document.getElementById('status');
    var termEl=document.getElementById('term');
    if(!window.Terminal){status.textContent='xterm.js failed to load';return;}
    var term=new Terminal({
      cols:COLS,
      convertEol:false,
      scrollback:100000,
      fontSize:13,
      disableStdin:true,
      theme:{background:'#0d1117',foreground:'#c9d1d9',cursor:'#c9d1d9'}
    });
    var fit=null;
    if(window.FitAddon){fit=new window.FitAddon.FitAddon();term.loadAddon(fit);}
    term.open(termEl);
    function doFit(){
      try{if(fit)fit.fit()}catch(_){}
      if(term.cols!==COLS)term.resize(COLS,term.rows||24);
    }
    doFit(); window.addEventListener('resize',doFit);
    fetch(endpoint,{credentials:'include'}).then(function(res){
      if(!res.ok){
        if(res.status===401){status.textContent='需要登录 dashboard 后查看回放';}
        else if(res.status===404){status.textContent='没有 PTY 日志';}
        else{status.textContent='加载失败 HTTP '+res.status;}
        return null;
      }
      var total=Number(res.headers.get('x-botmux-log-bytes')||0);
      var served=Number(res.headers.get('x-botmux-served-bytes')||0);
      var truncated=res.headers.get('x-botmux-truncated')==='1';
      status.textContent=truncated
        ? 'showing tail '+formatBytes(served)+' / '+formatBytes(total)
        : 'loaded '+formatBytes(total);
      return res.arrayBuffer();
    }).then(function(buf){
      if(!buf)return;
      term.write(new TextDecoder().decode(buf));
      setTimeout(doFit,0);
    }).catch(function(err){
      status.textContent='加载失败: '+(err&&err.message?err.message:String(err));
    });
    function formatBytes(n){
      if(!Number.isFinite(n)||n<=0)return '0 B';
      var u=['B','KiB','MiB','GiB'];var i=0;
      while(n>=1024&&i<u.length-1){n/=1024;i++;}
      return (i===0?String(n):n.toFixed(1))+' '+u[i];
    }
  })();
  <\/script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, '&#96;');
}
