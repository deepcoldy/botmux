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
 * WS 探针自带的握手超时，须不长于外层步骤预算：正常情况下由它先到点收尾（关
 * socket、写一行超时），外层 8 秒只是兜底闸门。
 */
export const WORKBENCH_DOCTOR_WS_TIMEOUT_MS = 7_500;

/* ────────────────────────────────────────────────────────────────────────────
 * 页面与单测共用的诊断逻辑。
 *
 * 下面三个函数的**源码**会被 `Function.prototype.toString()` 原样内联进诊断页
 * （见 workbenchDoctorHtml），单测则直接 import 同一份——测的就是页面里跑的那份
 * 代码。因此它们必须遵守与内联脚本相同的约束：
 *  - 不含反引号、不含 `${`、不含正则字面量（会和外层模板字符串打架）；
 *  - 只用 var / function 的朴素写法，兼容老 iOS Safari；
 *  - 函数名即页面里的调用名（构建是纯 tsc，不做改名压缩），不要重命名。
 * ──────────────────────────────────────────────────────────────────────────── */

/** `/api/sessions` 行里与「终端可探测」判定相关的字段子集。 */
export interface DoctorSessionRow {
  sessionId?: unknown;
  id?: unknown;
  status?: unknown;
  cliId?: unknown;
  webPort?: unknown;
  proxyPort?: unknown;
}

/**
 * 会话不可探测的原因；空串表示可探测。「可探测」= 终端真的走本机 worker：webPort
 * 是 worker 终端页、proxyPort 是 dashboard 的 /s/ 反代，两个都在 view-link 链路
 * 才通。riff 等外部后端的终端在沙箱侧，从这条链路探出来的失败不是故障，是误诊。
 */
export function doctorProbeableWhy(s: DoctorSessionRow | null | undefined): string {
  if (!s || typeof s !== 'object') return '记录为空';
  if (String(s.status || '') === 'closed') return '会话已关闭';
  if (String(s.cliId || '') === 'riff') return 'riff 外部后端，终端不在本机 worker 上';
  if (typeof s.webPort !== 'number' || !(s.webPort > 0)) return '缺本机终端端口 webPort';
  if (typeof s.proxyPort !== 'number' || !(s.proxyPort > 0)) return '缺终端反代端口 proxyPort';
  return '';
}

export interface DoctorSessionPick {
  /**
   * picked = 选中可探测会话；missing = ?session 点名的 id 不在列表；
   * unprobeable = 点名的会话存在但探不了（reason 给原因）；
   * none = 自动挑选时一个可探测会话都没有（reason 给统计），绝不拿第一个凑数。
   */
  kind: 'picked' | 'missing' | 'unprobeable' | 'none';
  sessionId: string;
  status: string;
  reason: string;
  /** picked 且 status 不是 active/working/idle：页面提示「退而用这个」。 */
  fallback: boolean;
}

/**
 * 从会话列表挑诊断对象。wanted 非空时只认点名的那个（存在性与可探测性都校验）；
 * 自动挑选只在可探测会话里挑，优先 active/working/idle。
 */
export function pickDoctorSession(list: DoctorSessionRow[] | null | undefined, wanted: string): DoctorSessionPick {
  var rows = list || [];
  var res: DoctorSessionPick = { kind: 'none', sessionId: '', status: '', reason: '', fallback: false };
  function idOf(s: DoctorSessionRow): string {
    return String((s && (s.sessionId || s.id)) || '');
  }
  if (wanted) {
    var hit: DoctorSessionRow | null = null;
    for (var i = 0; i < rows.length; i++) {
      if (idOf(rows[i] || {}) === wanted) { hit = rows[i] || {}; break; }
    }
    if (!hit) {
      res.kind = 'missing';
      res.sessionId = wanted;
      res.reason = '列表共 ' + rows.length + ' 个会话，没有一个叫这个 id';
      return res;
    }
    res.sessionId = wanted;
    res.status = String(hit.status || '?');
    var whyWanted = doctorProbeableWhy(hit);
    if (whyWanted) {
      res.kind = 'unprobeable';
      res.reason = whyWanted;
      return res;
    }
    res.kind = 'picked';
    return res;
  }
  var live: DoctorSessionRow | null = null;
  var probeable: DoctorSessionRow | null = null;
  var total = 0;
  for (var j = 0; j < rows.length; j++) {
    var s = rows[j] || {};
    if (!idOf(s)) continue;
    total++;
    if (doctorProbeableWhy(s)) continue;
    var st = String(s.status || '');
    if (!live && (st === 'active' || st === 'working' || st === 'idle')) live = s;
    if (!probeable) probeable = s;
  }
  var picked = live || probeable;
  if (!picked) {
    res.kind = 'none';
    res.reason = '共 ' + total + ' 个会话，没有一个可探测的本机终端会话（riff 外部后端 / 缺 webPort、proxyPort / 已关闭）';
    return res;
  }
  res.kind = 'picked';
  res.sessionId = idOf(picked);
  res.status = String(picked.status || '?');
  res.fallback = !live;
  return res;
}

/** runStep 每一步的闸门：外层判超时后 closed 置真并触发 cancel 钩子。 */
export interface DoctorWsGate {
  closed: boolean;
  cancel: Array<() => void>;
}

/** probeWs 关心的 WebSocket 最小面；单测注入假实现，不起真服务。 */
export interface DoctorWsLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev?: { code?: unknown; reason?: unknown }) => void) | null;
  close(): void;
}

/** probeWs 的全部外部依赖，页面喂真的，单测喂假的。 */
export interface DoctorWsEnv {
  /** WebSocket 工厂；宿主没有 WebSocket 时传 undefined，记一行后直接放行。 */
  makeWs: ((url: string) => DoctorWsLike) | undefined;
  line: (icon: string, label: string, value: string, note?: string) => void;
  timeoutMs: number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  now: () => number;
}

/**
 * WS 握手探针。三条硬规矩（对应上一版的泄漏与误诊）：
 *  1. 自带 timeoutMs 兜底：到点自己收尾，不等外层 8 秒闸门；
 *  2. 无论成败必 close socket——half-open socket 一直挂着就是 WS 泄漏；
 *  3. 外层闸门（gate.closed）合上之后一行都不再写：迟到的握手结果只会串到后面
 *     检查项下面造成误读。cancel 钩子由外层超时触发，负责关 socket 并放行 Promise。
 */
export function doctorProbeWs(
  env: DoctorWsEnv,
  label: string,
  wsUrl: string,
  shown: string,
  gate: DoctorWsGate | null,
): Promise<void> {
  return new Promise(function (resolve) {
    if (!env.makeWs) {
      env.line('❌', label, '本浏览器没有 WebSocket', shown);
      resolve();
      return;
    }
    var settled = false;
    var began = env.now();
    var ws: DoctorWsLike | null = null;
    var timer: unknown = null;
    function shutdown(): void {
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      try { if (ws) ws.close(); } catch (e) { /* close 失败也不追究 */ }
    }
    function finish(icon: string, value: string): void {
      if (settled) return;
      settled = true;
      shutdown();
      if (!gate || !gate.closed) {
        env.line(icon, label, value + '，耗时 ' + (env.now() - began) + 'ms', shown);
      }
      resolve();
    }
    if (gate) {
      gate.cancel.push(function () {
        if (settled) return;
        settled = true;
        shutdown();
        resolve();
      });
    }
    timer = env.setTimeout(function () {
      finish('⚠️', '超时（' + Math.round(env.timeoutMs / 1000) + ' 秒无握手结果）');
    }, env.timeoutMs);
    try {
      ws = env.makeWs(wsUrl);
    } catch (e) {
      var m = e && (e as { message?: unknown }).message ? String((e as { message?: unknown }).message) : String(e);
      finish('❌', '构造失败 ' + m.slice(0, 120));
      return;
    }
    ws.onopen = function () { finish('✅', 'open 握手成功'); };
    ws.onerror = function () { finish('❌', 'error 握手失败（多半被网关或代理拦了）'); };
    ws.onclose = function (ev) {
      var code = ev && typeof ev.code === 'number' ? ev.code : '?';
      var reason = String((ev && ev.reason) || '').slice(0, 60);
      finish('❌', 'close code=' + code + (reason ? ' reason=' + reason : ''));
    };
  });
}

/**
 * 整页 HTML。模板只内联**构建期常量与上面共享函数的源码**，不含任何请求期数据——
 * 页面上出现的每一个动态值都是访问者浏览器自己在运行时算出来的，服务端不往里塞任
 * 何东西，也就不存在把密钥渲染进页面的可能。
 *
 * 内联 JS（含被内联的共享函数）刻意写成不含反引号、不含 `${`、不含正则字面量的朴
 * 素 ES5 风格：前两者会和外层模板字符串打架，正则里的反斜杠则会被模板字符串吃掉一
 * 层（`\/` 变成 `/`，正则当场破相）。用 slice/split/trim 代替正则，问题从根上消失。
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
var WS_TIMEOUT = ${WORKBENCH_DOCTOR_WS_TIMEOUT_MS};
var out = document.getElementById('out');
var stat = document.getElementById('stat');
var startedAt = Date.now();

// ?session=<会话id>：允许点名要诊断的会话。只取这一个参数的值；查询串里的其余
// 参数（可能携带凭证）既不读进变量也不上屏。
function sessionParam(){
  var raw = '';
  try { raw = String(location.search || ''); } catch (e) { return ''; }
  if (raw.charAt(0) === '?') raw = raw.slice(1);
  var parts = raw.split('&');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    var key = (eq >= 0 ? parts[i].slice(0, eq) : parts[i]).trim();
    if (key !== 'session') continue;
    var val = eq >= 0 ? parts[i].slice(eq + 1) : '';
    try { val = decodeURIComponent(val); } catch (e2) {}
    return String(val).slice(0, 128).trim();
  }
  return '';
}
var WANTED_SESSION = sessionParam();

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

// —— 与服务端 TS 同源的共享逻辑（构建期原样内联；单测 import 的是同一份源码）——
${doctorProbeableWhy.toString()}
${pickDoctorSession.toString()}
${doctorProbeWs.toString()}

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

// 真正的探测逻辑在 doctorProbeWs（与服务端 TS、单测共用同一份源码）；这里只负责
// 把浏览器真实的 WebSocket 与计时器喂进去。
function probeWs(label, wsUrl, shown, gate){
  return doctorProbeWs({
    makeWs: typeof WebSocket === 'undefined' ? undefined : function(u){ return new WebSocket(u); },
    line: line,
    timeoutMs: WS_TIMEOUT,
    setTimeout: function(fn, ms){ return setTimeout(fn, ms); },
    clearTimeout: function(t){ clearTimeout(t); },
    now: function(){ return Date.now(); }
  }, label, wsUrl, shown, gate || null);
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
  // 点名了诊断对象就亮在页面最上面，截图第一眼就知道诊断的是谁。
  if (WANTED_SESSION) {
    line('✅', '诊断对象', WANTED_SESSION.slice(0, 48), '来自 ?session 查询参数：只诊断这个会话');
  }
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
  // 只在「可探测」的本机 worker 会话里挑（或按 ?session 点名）。挑不到就明说，
  // 绝不拿列表第一个凑数——拿 riff/无端口会话探出来的失败全是误诊。
  var pick = pickDoctorSession(ctx.sessions || [], WANTED_SESSION);
  if (pick.kind === 'missing') {
    line('❌', '指定会话', WANTED_SESSION.slice(0, 48), '?session 指定的会话不存在：' + pick.reason + '。确认 id 后重试；终端各项跳过');
    return;
  }
  if (pick.kind === 'unprobeable') {
    line('⚠️', '指定会话', WANTED_SESSION.slice(0, 48), '该会话不可探测：' + pick.reason + '（status=' + pick.status + '）；终端各项跳过');
    return;
  }
  if (pick.kind === 'none') {
    line('⚠️', '会话挑选', '没有可探测的会话', pick.reason + '。可在地址后加 ?session=<会话id> 指定；终端各项跳过');
    return;
  }
  if (pick.fallback) {
    line('⚠️', '会话挑选', 'status=' + pick.status, '没有 active/working/idle 的可探测会话，退而用这个');
  }
  var sid = pick.sessionId;
  ctx.sessionId = sid;
  line('✅', '选中会话', sid.slice(0, 48),
    (WANTED_SESSION ? '?session 指定' : '自动挑选：可探测（webPort/proxyPort 齐备）') + '，status=' + pick.status);
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
      try { u = new URL(raw, location.origin); } catch (e) {
        line('❌', 'view-link', 'HTTP 200 但 url 解析不了');
        return;
      }
      // P1-5 起服务端只回同源相对路径：跨端口/跨域地址会把只读凭证指到看不见登出状态的
      // daemon/worker 端口上，中央吊销就白做了。这里如实报「服务端给的是哪个 origin」。
      var same = raw.charAt(0) === '/' && u.origin === location.origin;
      line(same ? '✅' : '❌', 'view-link origin',
        same ? '与页面同源' : u.origin,
        same ? '服务端给的是同源相对路径（只有中央前门能消费）'
          : '服务端给了跨源地址：绕开中央前门的吊销检查，按缺陷处理');
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
    'ws ' + ctx.termPath + '/' + (ctx.termSearch ? '?viewToken 已隐藏' : ''), ctx.gate);
}

function stepWsCookie(ctx){
  if (!ctx.sessionId) {
    line('⚠️', 'WS 探测 B（Cookie 链路）', '跳过', '没选中会话');
    return;
  }
  // 不带任何查询参数：能不能连上，完全取决于这台设备升级 WebSocket 时带没带 Cookie。
  var path = '/s/' + encodeURIComponent(ctx.sessionId);
  return probeWs('WS 探测 B（Cookie 链路）', wsUrlOf(path, ''), 'ws ' + path + '/（无查询参数）', ctx.gate);
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
// 立刻走下一项，绝不让整页停在半路。翻篇时合上本步的 gate 并触发 cancel 钩子——
// probeWs 把「关 socket + 不再写行」注册在钩子里，旧 socket 的迟到回调从此写不进结果区。
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
  var gate = { closed: false, cancel: [] };
  ctx.gate = gate;
  function seal(){
    gate.closed = true;
    var fns = gate.cancel.splice(0);
    for (var j = 0; j < fns.length; j++) { try { fns[j](); } catch (e) {} }
  }
  function next(){
    if (moved) return;
    moved = true;
    if (timer) clearTimeout(timer);
    seal();
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
