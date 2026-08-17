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
  /**
   * P1-11：给这张壳现签一枚绑定当前认证会话的 CSRF 票据。壳自己会 POST
   * unlock/activity/lock，是控制类端点的合法调用方之一，必须带票据；返回 null
   * 时壳照常渲染（预览只读可用），解锁按钮会被服务端 403 挡住。
   */
  mintCsrfToken?(req: IncomingMessage): string | null;
  /**
   * P2（readonly 解锁按钮）：这个身份到底能不能解锁交互。必填，调用方必须显式
   * 用与工作台按钮同一份能力投影（`projectWorkbenchOperationCapabilities` 的
   * `canInteract`）回答，不给隐式默认值——漏接就编译不过，而不是悄悄把按钮画给
   * 只读身份。
   */
  canInteract(req: IncomingMessage): boolean;
}

export interface PreviewGuardRenderOptions {
  /** 渲染时刻（毫秒），只用于算 capability 续期倒计时。默认 `Date.now()`。 */
  now?: number;
  /** P1-11：本壳自己 POST 控制端点时带的一次性 CSRF 票据。 */
  csrfToken?: string | null;
  /**
   * P2：该身份能否解锁交互。false（平台 teammate/guest 这类 readonly 身份）时
   * 壳里根本不渲染解锁/锁定按钮——那两个 POST 只会被服务端 403，画出来是把
   * 「点了才知道没权限」当交互；同时壳内部把交互态钉死在关闭状态，任何
   * `mode: 'interactive'` 的状态响应都掀不开蒙层。渲染按钮不等于放大权限，
   * 不渲染也不等于额外收紧：服务端门禁始终是唯一权威。
   */
  canInteract: boolean;
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

function csrfToken(options: PreviewGuardRenderOptions): string {
  return options.csrfToken ?? '';
}

export function previewGuardHtml(
  sessionId: string,
  capability: { token: string; expiresAt: number },
  options: PreviewGuardRenderOptions,
): string {
  const now = options.now ?? Date.now();
  const canInteract = options.canInteract;
  const encoded = encodeURIComponent(sessionId);
  const contentPath = sessionPreviewContentPath(sessionId, capability.token);
  const statePath = `/api/sessions/${encoded}/preview-interaction`;
  const defaultLabel = escapeJsonForScript(PREVIEW_DEFAULT_MODE_LABEL);
  const notice = escapeJsonForScript(PREVIEW_OVERLAY_SECURITY_NOTICE);
  // P1-11：票据只进本壳自己的 fetch 头，不落 DOM 属性、不进 URL。
  const csrf = escapeJsonForScript(csrfToken(options));
  // P2：只读身份看不到解锁入口，也看不到「返回预览模式」——它同样是只会 403 的
  // POST。蒙层照常渲染，预览内容照常可看。
  const unlockControl = canInteract
    ? '<button id="unlock" type="button">解锁交互（15 分钟无操作后回锁）</button>'
    : '<p class="readonly" id="readonly-note">你在这个会话上是只读身份，不能解锁交互；预览保持锁定，页面内容可以照常查看。</p>';
  const lockControl = canInteract
    ? '<button class="lock hidden" id="lock" type="button">返回预览模式</button>'
    : '';
  const introCopy = canInteract
    ? '当前蒙层用于避免误触。需要操作应用时，请显式解锁交互。'
    : '当前蒙层用于避免误触，并且你的身份没有交互权限。';
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
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111827;font:14px/1.5 system-ui;color:#f8fafc}.shell{position:relative;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100%;background:#fff}.bar{position:absolute;z-index:4;top:12px;left:12px;right:12px;display:flex;align-items:center;gap:8px;pointer-events:none}.badge,.lock{border:1px solid #94a3b8;border-radius:2px;background:#0f172ee8;color:#fff;padding:7px 12px}.lock{pointer-events:auto;cursor:pointer}.overlay{position:absolute;z-index:3;inset:0;display:grid;place-items:center;background:#0f172e30}.panel{max-width:520px;margin:24px;padding:22px;border:1px solid #cbd5e1;border-radius:4px;background:#0f172eee;text-align:center}.panel h1{margin:0 0 8px;font-size:20px}.panel p{margin:8px 0;color:#dbe4f0}.panel .notice{font-size:12px;color:#fbbf24}.panel .readonly{margin-top:10px;font-size:13px;color:#cbd5e1}.panel button{margin-top:10px;border:1px solid #60a5fa;border-radius:2px;background:#172554;color:#dbeafe;padding:9px 18px;cursor:pointer}.hidden{display:none}</style></head>
<body><main class="shell"><iframe id="app" src="${contentPath}" title="Web 应用预览" sandbox="${PREVIEW_SANDBOX_TOKENS}" allow="clipboard-read; clipboard-write"></iframe>
<div class="bar"><span class="badge" id="badge">${PREVIEW_DEFAULT_MODE_LABEL}</span>${lockControl}</div>
<div class="overlay" id="overlay" data-can-interact="${canInteract ? 'true' : 'false'}"><section class="panel"><h1>${PREVIEW_DEFAULT_MODE_LABEL}</h1><p>${introCopy}</p><p class="notice">${PREVIEW_OVERLAY_SECURITY_NOTICE}</p>${unlockControl}</section></div></main>
<script>(function(){
var api=${escapeJsonForScript(statePath)},labelDefault=${defaultLabel},securityNotice=${notice},csrf=${csrf},canInteract=${canInteract ? 'true' : 'false'};
var frame=document.getElementById('app'),overlay=document.getElementById('overlay'),badge=document.getElementById('badge'),unlock=document.getElementById('unlock'),lock=document.getElementById('lock');
var deadlineTimer=0,statePollTimer=0,lastActivitySent=0,interactive=false;
// P1-16：每个状态请求领一张带 generation 的票，只有最新一代的响应能动蒙层。
// 显式 lock/unlock 会 abort 掉在途的轮询/activity 并作废它们的代号，所以「点锁定
// 之前发出、点完之后才回来」的旧响应（典型是 activity 回的 interactive）会被直接
// 丢弃，而不是把用户刚锁上的蒙层重新掀开、留一个直到下一轮 15s 轮询才自愈的窗口。
var generation=0,pending=null;
function begin(mutating){if(pending&&pending.controller){try{pending.controller.abort()}catch(e){}}pending={gen:++generation,mutating:!!mutating,controller:typeof AbortController==='function'?new AbortController():null};return pending}
function settle(ticket){if(pending===ticket)pending=null;return ticket.gen===generation}
function send(path,method,mutating){
// 显式解锁/锁定在途时，观察类请求（轮询 GET、activity）让路：它们的响应只会
// 反映点击之前的状态，抢在后面落地就是又一次「旧响应推翻新决定」。
if(!mutating&&pending&&pending.mutating)return;
var ticket=begin(mutating),h={'accept':'application/json'},init={method:method||'GET',credentials:'same-origin',headers:h};
if(csrf)h['x-botmux-csrf']=csrf;
if(ticket.controller)init.signal=ticket.controller.signal;
fetch(api+(path||''),init).then(function(r){if(!r.ok)throw new Error('state');return r.json()}).then(function(state){if(settle(ticket))apply(state)},function(){if(settle(ticket))failClosed()})}
function schedule(deadline){clearTimeout(deadlineTimer);if(!deadline)return;deadlineTimer=setTimeout(function(){send('', 'GET')},Math.max(0,deadline-Date.now())+25)}
// canInteract=false 的身份永远停在锁定态：解锁 POST 只会 403，任何说 interactive
// 的状态响应都不该在这张壳上掀开蒙层。
function apply(state){interactive=canInteract&&state.mode==='interactive';overlay.classList.toggle('hidden',interactive);if(lock)lock.classList.toggle('hidden',!interactive);badge.textContent=state.label||labelDefault;schedule(interactive?state.idleExpiresAt:0)}
function failClosed(){interactive=false;overlay.classList.remove('hidden');if(lock)lock.classList.add('hidden');badge.textContent=labelDefault;clearTimeout(deadlineTimer)}
function activity(){if(!interactive)return;var now=Date.now();if(now-lastActivitySent<20000)return;lastActivitySent=now;send('/activity','POST')}
// The framed document is an opaque origin, so its DOM is unreachable from here
// by design. Idle refresh therefore rides on the host-observable signal that
// focus moved into the preview — which also means the app can no longer
// manufacture activity events to hold an interactive lease open forever.
window.addEventListener('blur',function(){if(document.activeElement===frame)activity()});
document.addEventListener('pointerdown',activity,{capture:true,passive:true});
if(unlock)unlock.addEventListener('click',function(){send('/unlock','POST',true)});
// 锁定先落地再发请求：这一步只会更严，请求卡住或失败都不该让蒙层继续开着。
if(lock)lock.addEventListener('click',function(){failClosed();send('/lock','POST',true)});
document.addEventListener('visibilitychange',function(){if(!document.hidden)send('', 'GET')});
// Keep the limitation available to accessibility/debug tooling without ever
// placing a credential in DOM state.
overlay.setAttribute('data-security-notice',securityNotice);
statePollTimer=setInterval(function(){if(!document.hidden)send('', 'GET')},15000);
// The sandboxed frame authenticates by the capability embedded in its path, so
// the shell must re-mint before that capability expires.
if(${reloadInMs}>0)setTimeout(function(){location.reload()},${reloadInMs});
send('', 'GET');
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
      const html = previewGuardHtml(sessionId, capability, {
        now: Date.now(),
        csrfToken: options.mintCsrfToken?.(req) ?? null,
        // P2：与工作台按钮同一份能力投影。只读身份拿到的壳里没有解锁入口。
        canInteract: options.canInteract(req),
      });
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
