import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PREVIEW_ROUTE_PREFIX,
  sessionPreviewContentPath,
} from '../core/session-preview.js';
import { PREVIEW_SANDBOX_TOKENS, type PreviewProxyResolution } from './preview-proxy.js';
import {
  PREVIEW_DEFAULT_MODE_LABEL,
  PREVIEW_OVERLAY_SECURITY_NOTICE,
} from './preview-interaction.js';

/** Reload the shell this long before the content capability dies, so a pane
 *  left open for hours re-mints instead of silently 401-ing its subresources. */
const CAPABILITY_REFRESH_LEAD_MS = 30_000;

export interface PreviewGuardPageOptions {
  authenticated(req: IncomingMessage): boolean;
  resolve(sessionId: string): PreviewProxyResolution;
  /** Mint the path-scoped capability for this request's identity. Null fails
   *  the page closed rather than falling back to a cookie-authenticated
   *  (and therefore same-origin-usable) content URL. */
  mintContentCapability(
    req: IncomingMessage,
    sessionId: string,
  ): { token: string; expiresAt: number } | null;
}

function exactRootSessionId(url: URL): string | undefined {
  if (url.search || !url.pathname.startsWith(`${PREVIEW_ROUTE_PREFIX}/`)) {
    return undefined;
  }
  const afterPrefix = url.pathname.slice(PREVIEW_ROUTE_PREFIX.length + 1);
  const raw = afterPrefix.endsWith('/') ? afterPrefix.slice(0, -1) : afterPrefix;
  if (!raw || raw.includes('/')) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  return decoded && decoded.length <= 512 && !/[\\/\0]/.test(decoded) ? decoded : undefined;
}

function escapeJsonForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function previewGuardHtml(
  sessionId: string,
  capability: { token: string; expiresAt: number },
  now = Date.now(),
): string {
  const encoded = encodeURIComponent(sessionId);
  const contentPath = sessionPreviewContentPath(sessionId, capability.token);
  const statePath = `/api/sessions/${encoded}/preview-interaction`;
  const defaultLabel = escapeJsonForScript(PREVIEW_DEFAULT_MODE_LABEL);
  const notice = escapeJsonForScript(PREVIEW_OVERLAY_SECURITY_NOTICE);
  // Relative deadline, not an absolute timestamp: the browser clock may be
  // skewed against the dashboard's and a wrong sign would mean either an
  // instant reload loop or an expired frame.
  const reloadInMs = Math.max(
    0,
    Math.min(capability.expiresAt - now - CAPABILITY_REFRESH_LEAD_MS, 2_147_483_000),
  );
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>Botmux Web 预览</title>
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111827;font:14px/1.5 system-ui;color:#f8fafc}.shell{position:relative;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100%;background:#fff}.bar{position:absolute;z-index:4;top:12px;left:12px;right:12px;display:flex;align-items:center;gap:8px;pointer-events:none}.badge,.lock{border:1px solid #94a3b8;border-radius:2px;background:#0f172ee8;color:#fff;padding:7px 12px}.lock{pointer-events:auto;cursor:pointer}.overlay{position:absolute;z-index:3;inset:0;display:grid;place-items:center;background:#0f172e30}.panel{max-width:520px;margin:24px;padding:22px;border:1px solid #cbd5e1;border-radius:4px;background:#0f172eee;text-align:center}.panel h1{margin:0 0 8px;font-size:20px}.panel p{margin:8px 0;color:#dbe4f0}.panel .notice{font-size:12px;color:#fbbf24}.panel button{margin-top:10px;border:1px solid #60a5fa;border-radius:2px;background:#172554;color:#dbeafe;padding:9px 18px;cursor:pointer}.hidden{display:none}</style></head>
<body><main class="shell"><iframe id="app" src="${contentPath}" title="Web 应用预览" sandbox="${PREVIEW_SANDBOX_TOKENS}" allow="clipboard-read; clipboard-write"></iframe>
<div class="bar"><span class="badge" id="badge">${PREVIEW_DEFAULT_MODE_LABEL}</span><button class="lock hidden" id="lock" type="button">返回预览模式</button></div>
<div class="overlay" id="overlay"><section class="panel"><h1>${PREVIEW_DEFAULT_MODE_LABEL}</h1><p>当前蒙层用于避免误触。需要操作应用时，请显式解锁交互。</p><p class="notice">${PREVIEW_OVERLAY_SECURITY_NOTICE}</p><button id="unlock" type="button">解锁交互（15 分钟无操作后回锁）</button></section></div></main>
<script>(function(){
var api=${escapeJsonForScript(statePath)},labelDefault=${defaultLabel},securityNotice=${notice};
var frame=document.getElementById('app'),overlay=document.getElementById('overlay'),badge=document.getElementById('badge'),unlock=document.getElementById('unlock'),lock=document.getElementById('lock');
var deadlineTimer=0,statePollTimer=0,lastActivitySent=0,interactive=false;
function request(path,method){return fetch(api+(path||''),{method:method||'GET',credentials:'same-origin',headers:{'accept':'application/json'}}).then(function(r){if(!r.ok)throw new Error('state');return r.json()})}
function schedule(deadline){clearTimeout(deadlineTimer);if(!deadline)return;deadlineTimer=setTimeout(function(){request('', 'GET').then(apply).catch(failClosed)},Math.max(0,deadline-Date.now())+25)}
function apply(state){interactive=state.mode==='interactive';overlay.classList.toggle('hidden',interactive);lock.classList.toggle('hidden',!interactive);badge.textContent=state.label||labelDefault;schedule(state.idleExpiresAt)}
function failClosed(){interactive=false;overlay.classList.remove('hidden');lock.classList.add('hidden');badge.textContent=labelDefault;clearTimeout(deadlineTimer)}
function activity(){if(!interactive)return;var now=Date.now();if(now-lastActivitySent<20000)return;lastActivitySent=now;request('/activity','POST').then(apply).catch(failClosed)}
// The framed document is an opaque origin, so its DOM is unreachable from here
// by design. Idle refresh therefore rides on the host-observable signal that
// focus moved into the preview — which also means the app can no longer
// manufacture activity events to hold an interactive lease open forever.
window.addEventListener('blur',function(){if(document.activeElement===frame)activity()});
document.addEventListener('pointerdown',activity,{capture:true,passive:true});
unlock.addEventListener('click',function(){request('/unlock','POST').then(apply).catch(failClosed)});
lock.addEventListener('click',function(){request('/lock','POST').then(apply).catch(failClosed)});
document.addEventListener('visibilitychange',function(){if(!document.hidden)request('', 'GET').then(apply).catch(failClosed)});
// Keep the limitation available to accessibility/debug tooling without ever
// placing a credential in DOM state.
overlay.setAttribute('data-security-notice',securityNotice);
statePollTimer=setInterval(function(){if(!document.hidden)request('', 'GET').then(apply).catch(failClosed)},15000);
// The sandboxed frame authenticates by the capability embedded in its path, so
// the shell must re-mint before that capability expires.
if(${reloadInMs}>0)setTimeout(function(){location.reload()},${reloadInMs});
request('', 'GET').then(apply).catch(failClosed);
})();</script></body></html>`;
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ ok: false, error }));
}

/**
 * Serve only the descriptor root. All subpaths and the reserved iframe content
 * request continue through the hardened preview proxy unchanged.
 */
export function createPreviewGuardPage(options: PreviewGuardPageOptions): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
} {
  return {
    handle(req, res, url): boolean {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const sessionId = exactRootSessionId(url);
      if (!sessionId) return false;
      if (!options.authenticated(req)) {
        jsonError(res, 401, 'authentication_required');
        return true;
      }
      const resolution = options.resolve(sessionId);
      if (!resolution.ok) {
        jsonError(res, resolution.status, resolution.error);
        return true;
      }
      const capability = options.mintContentCapability(req, sessionId);
      if (!capability) {
        jsonError(res, 503, 'preview_capability_unavailable');
        return true;
      }
      const html = previewGuardHtml(sessionId, capability);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self' https://*.feishu.cn https://*.larksuite.com",
      });
      if (req.method === 'HEAD') res.end(); else res.end(html);
      return true;
    },
  };
}
