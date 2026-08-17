import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `/workbench-doctor` — 手机自助诊断页。
 *
 * 背景：工作台终端在某台 iPhone 上持续空白，而桌面浏览器、Chromium 的移动端模拟
 * 全都正常。真机与开发机之间差的是网络（办公网只放行 dashboard 端口）、Cookie
 * 携带策略（iOS WebView 的第三方/跨站 Cookie）、以及客户端缓存的旧 bundle——这三
 * 类差异隔着屏幕都看不见，只能让真机自己说。
 *
 * 于是这一页刻意做成**零依赖**：不加载 SPA bundle、不引任何外部资源，整页 HTML +
 * 内联 JS 一次发完。SPA 自己挂掉时它照样能开，这正是需要它的场景。用户在手机上打
 * 开、等它自己跑完、截一张图发回来即可定位。
 *
 * 安全口径（与静态壳同级放行，无需登录）：
 *  - 只探测「当前访问者自己」的可达性，不代表任何人做事，也不读服务端状态；
 *  - 全程不回显任何 token / secret：Cookie 只报有无（连值都不取），view-link 只
 *    报 origin 与 pathname，查询串里的 viewToken 一律以「已隐藏」占位；
 *  - 所有网络调用带 credentials: 'include'——诊断的就是「这台设备的登录态带没带上」。
 */

export const WORKBENCH_DOCTOR_PATH = '/workbench-doctor';

/** 页面标题，同时是测试用的标志字符串。 */
export const WORKBENCH_DOCTOR_TITLE = 'workbench-doctor';

/** 页尾提示。用户看到这行就知道下一步该干什么。 */
export const WORKBENCH_DOCTOR_FOOTER = '截图本页发给机器人即可';

/** 每项检查的独立超时。手机上被网关静默丢包时，卡死的那一项不能拖住后面。 */
export const WORKBENCH_DOCTOR_STEP_TIMEOUT_MS = 8_000;

/**
 * 整页 HTML。纯静态、无插值——页面上出现的每一个动态值都是访问者浏览器自己在运行
 * 时算出来的，服务端不往里塞任何东西，也就不存在把密钥渲染进页面的可能。
 *
 * 内联 JS 刻意写成不含反引号、不含 `${`、不含正则字面量的朴素 ES5 风格：前两者会
 * 和外层模板字符串打架，正则里的反斜杠则会被模板字符串吃掉一层（`\/` 变成 `/`，
 * 正则当场破相）。用 slice/split/trim 代替正则，问题从根上消失。
 */
export function workbenchDoctorHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>${WORKBENCH_DOCTOR_TITLE}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:#05080e;color:#e9f0f9}
body{padding:16px 14px 36px;font:400 17px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
h1{margin:0 0 2px;font-size:25px;letter-spacing:.4px}
.sub{margin:0 0 6px;color:#8ba0bd;font-size:13px}
#stat{margin:0 0 14px;font-size:16px;font-weight:600;color:#7dd3fc}
.row{display:flex;gap:9px;align-items:baseline;padding:10px 12px;margin-bottom:8px;border:1px solid #1b2838;border-radius:10px;background:#0a111b;overflow-wrap:anywhere;word-break:break-word}
.ico{flex:0 0 auto;font-size:19px}
.txt{min-width:0;flex:1 1 auto;font-size:19px;font-weight:600;color:#f4f8ff}
.lbl{font-weight:500;color:#93a8c4}
.val{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px}
.note{display:block;margin-top:3px;font-family:inherit;font-size:14px;font-weight:400;color:#8ba0bd}
footer{margin-top:20px;text-align:center;color:#7e93af;font-size:13px}
button{display:block;margin:16px auto 0;padding:11px 22px;border:1px solid #2b4160;border-radius:9px;background:#12203a;color:#cfe4ff;font-size:16px}
</style>
</head>
<body>
<h1>${WORKBENCH_DOCTOR_TITLE}</h1>
<p class="sub">工作台自助诊断 · 打开后自动逐项检测</p>
<p id="stat">检测中…</p>
<main id="out"></main>
<button id="again" type="button">重新检测</button>
<footer>${WORKBENCH_DOCTOR_FOOTER}</footer>
<script>
(function(){
'use strict';
var TIMEOUT = ${WORKBENCH_DOCTOR_STEP_TIMEOUT_MS};
var out = document.getElementById('out');
var stat = document.getElementById('stat');
var startedAt = Date.now();

// 全部走 textContent 落地：这一页不拼接任何 HTML 字符串，远端回来的内容永远只是文本。
function line(icon, label, value, note){
  var row = document.createElement('div');
  row.className = 'row';
  var i = document.createElement('span');
  i.className = 'ico';
  i.textContent = icon;
  var t = document.createElement('span');
  t.className = 'txt';
  var l = document.createElement('span');
  l.className = 'lbl';
  l.textContent = label + '：';
  var v = document.createElement('span');
  v.className = 'val';
  v.textContent = value === undefined || value === null ? '' : String(value);
  t.appendChild(l);
  t.appendChild(v);
  if (note) {
    var n = document.createElement('span');
    n.className = 'note';
    n.textContent = String(note);
    t.appendChild(n);
  }
  row.appendChild(i);
  row.appendChild(t);
  out.appendChild(row);
}

function msg(e){
  if (!e) return '未知错误';
  var m = e && e.message ? e.message : String(e);
  return String(m).slice(0, 120);
}

// 每次请求都带上登录态：这一页要回答的正是「这台设备的 Cookie 到底带没带上」。
function timedFetch(input, init){
  var opts = { credentials: 'include', cache: 'no-store' };
  if (init) {
    for (var k in init) {
      if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
    }
  }
  var ctrl = null;
  try { ctrl = new AbortController(); opts.signal = ctrl.signal; } catch (e) { ctrl = null; }
  var timer = setTimeout(function(){
    if (ctrl) { try { ctrl.abort(); } catch (e2) {} }
  }, TIMEOUT);
  return fetch(input, opts).then(function(r){
    clearTimeout(timer);
    return r;
  }, function(err){
    clearTimeout(timer);
    throw err;
  });
}

// 只取 Cookie 的**名字**，值一次都不读进变量，自然也没法被渲染出去。
function cookieNames(){
  var raw = '';
  try { raw = document.cookie || ''; } catch (e) { return []; }
  var names = [];
  var parts = raw.split(';');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    names.push((eq >= 0 ? parts[i].slice(0, eq) : parts[i]).trim());
  }
  return names;
}

function shortEtag(raw){
  var s = String(raw);
  if (s.slice(0, 2) === 'W/') s = s.slice(2);
  s = s.split('"').join('');
  return s.slice(0, 12);
}

// 终端页的 WebSocket 地址：路径去掉结尾斜杠再补一个，然后原样跟上查询串——与
// worker 里终端页自己的拼法逐字一致，探的才是同一条链路。
function wsUrlOf(pathname, search){
  var base = String(pathname);
  while (base.length && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + base + '/' + (search || '');
}

function probeWs(label, wsUrl, shown){
  return new Promise(function(resolve){
    if (typeof WebSocket === 'undefined') {
      line('❌', label, '本浏览器没有 WebSocket', shown);
      resolve();
      return;
    }
    var settled = false;
    var began = Date.now();
    var ws = null;
    function finish(icon, value){
      if (settled) return;
      settled = true;
      line(icon, label, value + '，耗时 ' + (Date.now() - began) + 'ms', shown);
      try { if (ws) ws.close(); } catch (e) {}
      resolve();
    }
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      finish('❌', '构造失败 ' + msg(e));
      return;
    }
    ws.onopen = function(){ finish('✅', 'open 握手成功'); };
    ws.onerror = function(){ finish('❌', 'error 握手失败（多半被网关或代理拦了）'); };
    ws.onclose = function(ev){
      var code = ev && typeof ev.code === 'number' ? ev.code : '?';
      var reason = String((ev && ev.reason) || '').slice(0, 60);
      finish('❌', 'close code=' + code + (reason ? ' reason=' + reason : ''));
    };
  });
}

// ── 各项检查 ───────────────────────────────────────────────────────────────
// 每个 run(ctx) 自己渲染若干行；抛错或超时由 runner 兜底，绝不影响后面的项。

function stepBasics(ctx){
  var ua = '';
  try { ua = String(navigator.userAgent || ''); } catch (e) { ua = '读取失败'; }
  line('✅', 'UA 前 80 字', ua.slice(0, 80));
  // 只报 origin。location.href 里可能挂着携带登录 token 的查询参数，一个字都不能上屏。
  line('✅', '页面 origin', location.origin);
  var now = new Date();
  line('✅', '设备当前时间', now.toLocaleString(), 'UTC ' + now.toISOString());
  ctx.ok = true;
}

function stepVersion(){
  return timedFetch('/__cli/ping', { method: 'GET' }).then(function(r){
    if (r.status === 200) {
      return r.text().then(function(body){
        line('✅', '服务版本 /__cli/ping', 'HTTP 200 ' + String(body).slice(0, 60));
      });
    }
    line('⚠️', '/__cli/ping', 'HTTP ' + r.status + '，本服务没有这个端点', '改用 HEAD / 读 etag');
    return headEtag();
  }, function(err){
    line('⚠️', '/__cli/ping', '请求失败 ' + msg(err), '改用 HEAD / 读 etag');
    return headEtag();
  });
}

function headEtag(){
  return timedFetch('/', { method: 'HEAD' }).then(function(r){
    var raw = r.headers.get('etag');
    if (!raw) {
      line('❌', '服务版本 etag', 'HTTP ' + r.status + '，响应里没有 etag 头');
      return;
    }
    // etag = 首页文件大小+mtime。手机拿到的这一串和电脑上不一样，就说明手机吃的
    // 是旧缓存，前面几轮修复自然一次都没落到它身上。
    line('✅', '服务版本 etag', shortEtag(raw), 'HTTP ' + r.status + '；与电脑上不一致即为手机吃了旧缓存');
  }, function(err){
    line('❌', '服务版本 etag', '请求失败 ' + msg(err));
  });
}

function stepCookie(ctx){
  var names = cookieNames();
  var hasToken = names.indexOf('botmux_dashboard_token') >= 0;
  var hasSession = names.indexOf('botmux_dashboard_session') >= 0;
  // 两个 Cookie 都是 HttpOnly，JS 本来就读不到——「无」是正常现象，不是故障。
  // 真正说明问题的是下面 /api/sessions 的状态码。
  line(hasToken ? '✅' : '⚠️', 'Cookie botmux_dashboard_token', hasToken ? '有' : '无',
    hasToken ? '' : '该 Cookie 是 HttpOnly，JS 本就读不到，「无」属正常；以下状态码才作数');
  line(hasSession ? '✅' : '⚠️', 'Cookie botmux_dashboard_session', hasSession ? '有' : '无',
    hasSession ? '' : '同为 HttpOnly');
  return timedFetch('/api/sessions', { method: 'GET' }).then(function(r){
    ctx.sessionsStatus = r.status;
    if (r.status !== 200) {
      line('❌', 'GET /api/sessions', 'HTTP ' + r.status, '登录态没带上，后面几项无从谈起');
      return;
    }
    return r.json().then(function(body){
      var list = (body && body.sessions) || [];
      ctx.sessions = list;
      line('✅', 'GET /api/sessions', 'HTTP 200，会话数 ' + list.length);
    }, function(err){
      line('⚠️', 'GET /api/sessions', 'HTTP 200 但响应解析失败 ' + msg(err));
    });
  }, function(err){
    line('❌', 'GET /api/sessions', '请求失败 ' + msg(err));
  });
}

function stepViewLink(ctx){
  if (ctx.sessionsStatus !== 200) {
    line('⚠️', 'view-link', '跳过', '上一步没拿到会话列表');
    return;
  }
  var list = ctx.sessions || [];
  var live = null;
  var fallback = null;
  for (var i = 0; i < list.length; i++) {
    var s = list[i] || {};
    var st = String(s.status || '');
    var id = s.sessionId || s.id;
    if (!id) continue;
    if (!live && (st === 'active' || st === 'working' || st === 'idle')) live = s;
    if (!fallback && st !== 'closed') fallback = s;
  }
  var picked = live || fallback;
  if (!picked) {
    line('⚠️', 'view-link', '跳过', '列表里没有可用（非 closed）会话');
    return;
  }
  if (!live) {
    line('⚠️', '会话挑选', 'status=' + String(picked.status || '?'), '没有 active/working/idle，退而用这个');
  }
  var sid = String(picked.sessionId || picked.id);
  ctx.sessionId = sid;
  line('✅', '选中会话', sid.slice(0, 48), 'status=' + String(picked.status || '?'));
  return timedFetch('/api/sessions/' + encodeURIComponent(sid) + '/view-link', { method: 'GET' }).then(function(r){
    if (r.status !== 200) {
      line('❌', 'GET view-link', 'HTTP ' + r.status);
      return;
    }
    return r.json().then(function(body){
      var raw = body && body.url;
      if (typeof raw !== 'string' || !raw) {
        line('❌', 'view-link', 'HTTP 200 但响应里没有 url');
        return;
      }
      var u;
      try { u = new URL(raw); } catch (e) {
        line('❌', 'view-link', 'HTTP 200 但 url 解析不了');
        return;
      }
      // 同源改写在前端 api 层做，服务端这里返回的仍是反代自身端口的绝对地址。
      // 两种情况都不算故障，但「服务端给的是哪个 origin」正是要看的东西。
      var same = u.origin === location.origin;
      line(same ? '✅' : '⚠️', 'view-link origin',
        same ? '与页面同源' : u.origin,
        same ? '服务端直接给的就是同源地址' : '服务端给的是跨端口地址，前端会改写成同源；下面按同源地址继续探');
      line('✅', 'view-link 路径', u.pathname, u.search ? '带查询参数（viewToken 凭证已隐藏）' : '无查询参数');
      ctx.termPath = u.pathname;
      ctx.termSearch = u.search;
      try {
        ctx.termUrl = new URL(u.pathname + u.search, location.origin).toString();
      } catch (e) {
        line('❌', '同源化终端地址', '拼接失败 ' + msg(e));
      }
    }, function(err){
      line('❌', 'view-link', 'HTTP 200 但响应解析失败 ' + msg(err));
    });
  }, function(err){
    line('❌', 'GET view-link', '请求失败 ' + msg(err));
  });
}

function stepTerminalHttp(ctx){
  if (!ctx.termUrl) {
    line('⚠️', '终端页 HTTP 探测', '跳过', '上一步没拿到终端地址');
    return;
  }
  return timedFetch(ctx.termUrl, { method: 'GET' }).then(function(r){
    line(r.status === 200 ? '✅' : '❌', '终端页 HTTP 探测', 'HTTP ' + r.status,
      '同源地址 ' + location.origin + ctx.termPath);
  }, function(err){
    line('❌', '终端页 HTTP 探测', '请求失败 ' + msg(err), '同源地址整个不可达');
  });
}

function stepWsViewToken(ctx){
  if (!ctx.termPath) {
    line('⚠️', 'WS 探测 A（viewToken 链路）', '跳过', '没拿到终端地址');
    return;
  }
  return probeWs('WS 探测 A（viewToken 链路）',
    wsUrlOf(ctx.termPath, ctx.termSearch),
    'ws ' + ctx.termPath + '/' + (ctx.termSearch ? '?viewToken 已隐藏' : ''));
}

function stepWsCookie(ctx){
  if (!ctx.sessionId) {
    line('⚠️', 'WS 探测 B（Cookie 链路）', '跳过', '没选中会话');
    return;
  }
  // 不带任何查询参数：能不能连上，完全取决于这台设备升级 WebSocket 时带没带 Cookie。
  var path = '/s/' + encodeURIComponent(ctx.sessionId);
  return probeWs('WS 探测 B（Cookie 链路）', wsUrlOf(path, ''), 'ws ' + path + '/（无查询参数）');
}

var STEPS = [
  { name: '基本信息', run: stepBasics },
  { name: '服务版本', run: stepVersion },
  { name: 'Cookie 登录态', run: stepCookie },
  { name: '终端只读链接 view-link', run: stepViewLink },
  { name: '终端页 HTTP 探测', run: stepTerminalHttp },
  { name: 'WS 探测 A（viewToken 链路）', run: stepWsViewToken },
  { name: 'WS 探测 B（Cookie 链路）', run: stepWsCookie }
];

// 顺序跑。每项一个独立 8 秒闸门 + 独立 try/catch：任一项超时或抛错都只记一行，
// 立刻走下一项，绝不让整页停在半路。
function runStep(i, ctx){
  if (i >= STEPS.length) {
    stat.textContent = '检测完成，共 ' + STEPS.length + ' 项，用时 '
      + ((Date.now() - startedAt) / 1000).toFixed(1) + ' 秒';
    return;
  }
  var step = STEPS[i];
  stat.textContent = '检测中… ' + (i + 1) + '/' + STEPS.length + '　' + step.name;
  var moved = false;
  var timer = null;
  function next(){
    if (moved) return;
    moved = true;
    if (timer) clearTimeout(timer);
    setTimeout(function(){ runStep(i + 1, ctx); }, 0);
  }
  timer = setTimeout(function(){
    if (moved) return;
    line('⚠️', step.name, '超时', TIMEOUT / 1000 + ' 秒未返回，跳到下一项');
    next();
  }, TIMEOUT);
  var pending;
  try {
    pending = step.run(ctx);
  } catch (e) {
    line('❌', step.name, '异常 ' + msg(e));
    next();
    return;
  }
  Promise.resolve(pending).then(next, function(err){
    line('❌', step.name, '异常 ' + msg(err));
    next();
  });
}

document.getElementById('again').addEventListener('click', function(){
  location.reload();
});

runStep(0, {});
})();
</script>
</body>
</html>`;
}

/**
 * 挂在 dashboard 的 `/workbench-doctor`。与静态壳同级放行（见 dashboard/auth.ts 的
 * `isStaticShell`）：这一页只探测访问者自己的可达性，不读服务端状态、不回显任何凭证，
 * 而**恰恰是登录态坏掉的时候最需要它能打开**。
 */
export function handleWorkbenchDoctor(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname !== WORKBENCH_DOCTOR_PATH) return false;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // 诊断页被中间缓存住就废了：手机每次拿到的必须是当前这版服务的页面。
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // 页面自身不加载任何外部资源。ws:/wss: 显式列出——部分 Safari 版本不把
    // 同源 WebSocket 算进 connect-src 的 'self'，而 WS 探测正是这一页的核心。
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://*.feishu.cn https://*.larksuite.com",
  });
  if (req.method === 'HEAD') res.end();
  else res.end(workbenchDoctorHtml());
  return true;
}
