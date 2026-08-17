/**
 * `/workbench-doctor` —— 手机自助诊断页的端点契约。
 *
 * 这一页存在的前提就是「登录态或 SPA 已经坏了」，所以它必须在无 token 时也能打开、
 * 每次都拿到当前这版服务（no-store），并且——恰恰因为它无需登录——正文里一个凭证
 * 字面量都不能有。
 *
 * Run: pnpm vitest run test/workbench-doctor-page.test.ts
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKBENCH_DOCTOR_FOOTER,
  WORKBENCH_DOCTOR_PATH,
  WORKBENCH_DOCTOR_STEP_TIMEOUT_MS,
  WORKBENCH_DOCTOR_TITLE,
  WORKBENCH_DOCTOR_WS_TIMEOUT_MS,
  doctorProbeWs,
  handleWorkbenchDoctor,
  pickDoctorSession,
  workbenchDoctorHtml,
  type DoctorWsEnv,
  type DoctorWsGate,
  type DoctorWsLike,
} from '../src/dashboard/workbench-doctor.js';
import {
  buildSetCookie,
  decideDashboardAuth,
  decideWorkbenchH5Auth,
  loadOrCreatePersistedToken,
} from '../src/dashboard/auth.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function start(): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    if (!handleWorkbenchDoctor(req, res, url)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('GET /workbench-doctor', () => {
  it('serves an uncacheable self-contained HTML page carrying its own marker', async () => {
    const base = await start();
    const res = await fetch(`${base}${WORKBENCH_DOCTOR_PATH}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // 被中间缓存住的诊断页会一直报告上一版服务的状况，那比没有还糟。
    expect(res.headers.get('cache-control')).toBe('no-store');

    const html = await res.text();
    expect(html).toContain(WORKBENCH_DOCTOR_TITLE);
    expect(html).toContain(WORKBENCH_DOCTOR_FOOTER);
    // 零依赖：没有 SPA bundle，也没有任何外链资源，SPA 挂掉时它照样能开。
    expect(html).not.toContain('/assets/');
    expect(html).not.toMatch(/<(?:script|link|img)[^>]*\s(?:src|href)=/i);
    // 七项检查都在页面里，而且都渲染成带状态前缀的一行。
    for (const step of ['UA', '服务版本', 'Cookie botmux_dashboard_token', 'view-link', '终端页 HTTP 探测', 'WS 探测 A（viewToken 链路）', 'WS 探测 B（Cookie 链路）']) {
      expect(html, step).toContain(step);
    }
    for (const icon of ['✅', '❌', '⚠️']) expect(html, icon).toContain(icon);

    // 其它路径与写方法一概不接管，交给 dashboard 原有路由。
    expect((await fetch(`${base}/workbench`)).status).toBe(404);
    expect((await fetch(`${base}${WORKBENCH_DOCTOR_PATH}`, { method: 'POST' })).status).toBe(404);
  });

  it('never echoes a credential — not the active dashboard token, not a cookie value', async () => {
    // 假 token 环境：单测的 SESSION_DATA_DIR 已被隔离到临时目录，这里落一个真实
    // 格式的 .dashboard-token,再对照整页正文。
    const token = loadOrCreatePersistedToken(join(process.env.SESSION_DATA_DIR!, '.dashboard-token'));
    expect(token.length).toBeGreaterThan(8);
    expect(buildSetCookie(token)).toContain(token); // 该 token 确实是会被下发的那个

    const base = await start();
    const html = await (await fetch(`${base}${WORKBENCH_DOCTOR_PATH}`)).text();

    expect(html).not.toContain(token);
    // 页面整个渲染链路只用 textContent,没有任何 HTML 拼装入口。
    expect(html).not.toContain('innerHTML');
    // Cookie 只报有无：document.cookie 全页仅一处引用，且只用于取**名字**。
    expect(html.match(/document\.cookie/g) ?? []).toHaveLength(1);
    expect(html).toContain("names.push((eq >= 0 ? parts[i].slice(0, eq) : parts[i]).trim())");
    expect(html).toContain("names.indexOf('botmux_dashboard_token') >= 0");
    // 源码里不出现任何 `xxxToken=<值>` 形态的字面量；运行时的 viewToken 只以占位符上屏。
    expect(html).not.toMatch(/[?&](?:t|token|viewToken)=/);
    expect(html).toContain('viewToken 已隐藏');
  });

  it('runs every probe with credentials and an independent 8s timeout', async () => {
    const html = workbenchDoctorHtml();
    // 诊断的就是「这台设备的登录态带没带上」，漏一个 credentials 就白测。所有请求都
    // 收口在 timedFetch 里，所以裸 fetch( 全页只该出现一次——就是它自己那一处。
    expect(html).toContain("credentials: 'include'");
    expect(html.match(/(?<![A-Za-z])fetch\(/g) ?? []).toHaveLength(1);
    expect(html).toContain('var TIMEOUT = 8000;');
    // 超时/异常都只记一行就走下一项，不能把整页停在半路。
    expect(html).toContain("line('⚠️', step.name, '超时'");
    expect(html).toContain("line('❌', step.name, '异常 '");
    expect(html).toContain('runStep(i + 1, ctx)');
  });
});

describe('pickDoctorSession — 会话挑选', () => {
  // 评审场景原样复刻：列表最前面是「看起来最活跃」但根本探不了的会话——riff 外部
  // 后端、没有终端端口的行——旧逻辑按 status 挑第一个就会拿它们去探，全是误诊。
  const rows = [
    { sessionId: 'riff-live', status: 'active', cliId: 'riff', webPort: 7101, proxyPort: 7201 },
    { sessionId: 'portless-live', status: 'active', cliId: 'claude-code' },
    { sessionId: 'closed-full', status: 'closed', cliId: 'claude-code', webPort: 7102, proxyPort: 7202 },
    { sessionId: 'probeable-idle', status: 'idle', cliId: 'claude-code', webPort: 7103, proxyPort: 7203 },
  ];

  it('自动挑选偏好「可探测」的本机 worker 会话，越过更靠前的 riff/无端口活跃行', () => {
    expect(pickDoctorSession(rows, '')).toMatchObject({
      kind: 'picked',
      sessionId: 'probeable-idle',
      status: 'idle',
      fallback: false,
    });
  });

  it('一个可探测会话都没有时明确说「没有」，绝不拿第一个凑数', () => {
    const pick = pickDoctorSession(rows.slice(0, 3), '');
    expect(pick.kind).toBe('none');
    expect(pick.sessionId).toBe('');
    expect(pick.reason).toContain('3 个');
  });

  it('没有 active/working/idle 的可探测会话时退而用其它状态，并标 fallback', () => {
    const pick = pickDoctorSession([
      { sessionId: 'riff-live', status: 'active', cliId: 'riff', webPort: 1, proxyPort: 2 },
      { sessionId: 'starting-1', status: 'starting', cliId: 'claude-code', webPort: 3, proxyPort: 4 },
    ], '');
    expect(pick).toMatchObject({ kind: 'picked', sessionId: 'starting-1', status: 'starting', fallback: true });
  });

  it('?session 点名时只认点名的那个，并校验存在性与可探测性', () => {
    const two = [
      { sessionId: 'auto-pick', status: 'active', cliId: 'claude-code', webPort: 1, proxyPort: 2 },
      { sessionId: 'named-pick', status: 'idle', cliId: 'claude-code', webPort: 3, proxyPort: 4 },
    ];
    // 自动会挑第一个；点名能改挑第二个。
    expect(pickDoctorSession(two, '').sessionId).toBe('auto-pick');
    expect(pickDoctorSession(two, 'named-pick')).toMatchObject({ kind: 'picked', sessionId: 'named-pick' });
    // id 不存在 → missing，且原因里带列表规模，方便用户核对。
    expect(pickDoctorSession(two, 'ghost')).toMatchObject({ kind: 'missing', sessionId: 'ghost' });
    expect(pickDoctorSession(two, 'ghost').reason).toContain('2 个');
    // 点名的会话存在但不可探测 → unprobeable，原因指名缺什么，而不是拿去硬探。
    expect(pickDoctorSession(rows, 'portless-live')).toMatchObject({ kind: 'unprobeable', status: 'active' });
    expect(pickDoctorSession(rows, 'portless-live').reason).toContain('webPort');
    expect(pickDoctorSession(rows, 'riff-live').reason).toContain('riff');
  });

  it('挑选逻辑、?session 解析与顶部「诊断对象」都内联进了页面', () => {
    const html = workbenchDoctorHtml();
    // 三个共享函数以源码形式进页面（单测 import 的正是同一份实现）。
    expect(html).toContain('function doctorProbeableWhy(');
    expect(html).toContain('function pickDoctorSession(');
    expect(html).toContain('function doctorProbeWs(');
    // ?session 只取这一个参数；点名对象亮在页面顶部。
    expect(html).toContain('function sessionParam');
    expect(html).toContain("if (key !== 'session') continue;");
    expect(html).toContain('诊断对象');
    // 挑不到与点名失败的文案（不再默默用第一个）。
    expect(html).toContain('没有可探测的会话');
    expect(html).toContain('该会话不可探测');
  });
});

describe('doctorProbeWs — WS 探针超时与迟到写入', () => {
  class FakeWs implements DoctorWsLike {
    closeCalls = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((ev?: { code?: unknown; reason?: unknown }) => void) | null = null;
    constructor(readonly url: string) {}
    close(): void { this.closeCalls += 1; }
  }

  function makeEnv(timeoutMs = WORKBENCH_DOCTOR_WS_TIMEOUT_MS) {
    const timers: Array<{ id: number; ms: number; fn: () => void; cleared: boolean }> = [];
    const lines: string[] = [];
    const sockets: FakeWs[] = [];
    const env: DoctorWsEnv = {
      makeWs: (url: string) => { const ws = new FakeWs(url); sockets.push(ws); return ws; },
      line: (icon, label, value, note) => { lines.push([icon, label, value, note ?? ''].join(' | ')); },
      timeoutMs,
      setTimeout: (fn, ms) => {
        const t = { id: timers.length + 1, ms, fn, cleared: false };
        timers.push(t);
        return t.id;
      },
      clearTimeout: (id) => {
        const t = timers.find(x => x.id === id);
        if (t) t.cleared = true;
      },
      now: () => 1_000,
    };
    return { env, timers, lines, sockets };
  }

  it('自带超时到点：写一行超时、必 close socket，之后迟到的握手事件一个字都写不进来', async () => {
    const { env, timers, lines, sockets } = makeEnv();
    const done = doctorProbeWs(env, 'WS 探测 A', 'ws://h/s/x/', 'shown', null);
    expect(sockets).toHaveLength(1);
    const own = timers.find(t => t.ms === WORKBENCH_DOCTOR_WS_TIMEOUT_MS);
    expect(own).toBeDefined();
    own!.fn(); // 到点：没有任何握手事件
    await done;
    expect(sockets[0].closeCalls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('超时');
    // 旧 socket 的迟到回调（settled 后）不再产生任何行。
    sockets[0].onopen?.();
    sockets[0].onclose?.({ code: 1006, reason: 'late' });
    expect(lines).toHaveLength(1);
  });

  it('握手成功同样必 close socket，并回收自己的兜底计时器', async () => {
    const { env, timers, lines, sockets } = makeEnv();
    const done = doctorProbeWs(env, 'WS 探测 A', 'ws://h/', 'shown', null);
    sockets[0].onopen!();
    await done;
    expect(sockets[0].closeCalls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('open 握手成功');
    expect(timers[0].cleared).toBe(true);
  });

  it('外层闸门合上（runStep 判超时）后：cancel 钩子关掉旧 socket，迟到写入被拒', async () => {
    const { env, lines, sockets } = makeEnv();
    const gate: DoctorWsGate = { closed: false, cancel: [] };
    const done = doctorProbeWs(env, 'WS 探测 B', 'ws://h/', 'shown', gate);
    expect(gate.cancel).toHaveLength(1);
    // 复刻页面 runStep 超时翻篇时 seal() 的动作：合闸 + 触发 cancel 钩子。
    gate.closed = true;
    for (const fn of gate.cancel.splice(0)) fn();
    await done; // cancel 直接放行 Promise，外层不会吊死
    expect(sockets[0].closeCalls).toBe(1); // 超时同时主动 close
    expect(lines).toHaveLength(0); // 静默收尾：超时行由 runner 记，这里一行不写
    sockets[0].onopen?.();
    sockets[0].onerror?.();
    sockets[0].onclose?.({ code: 1000 });
    expect(lines).toHaveLength(0); // 迟到回调彻底被拒
  });

  it('WS 探针预算不长于外层步骤预算，页面按常量内联并把 gate 接进了 runner', () => {
    expect(WORKBENCH_DOCTOR_WS_TIMEOUT_MS).toBeLessThanOrEqual(WORKBENCH_DOCTOR_STEP_TIMEOUT_MS);
    const html = workbenchDoctorHtml();
    expect(html).toContain(`var WS_TIMEOUT = ${WORKBENCH_DOCTOR_WS_TIMEOUT_MS};`);
    // runner 每步建独立闸门，翻篇时 seal() 合闸并触发 cancel 钩子；WS 两步把
    // ctx.gate 传给 probeWs——迟到的旧 socket 由此被封死。
    expect(html).toContain('var gate = { closed: false, cancel: [] };');
    expect(html).toContain('function seal()');
    expect(html.match(/ctx\.gate\)/g) ?? []).toHaveLength(2);
  });
});

describe('/workbench-doctor wiring', () => {
  it('is mounted on the dashboard beside the fragment-free Workbench entries', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(dashboard).toContain('handleWorkbenchDoctor');
    // 挂在 /workbench 无片段入口之后、静态壳之前——同一段路由区。
    const doctorAt = dashboard.indexOf('if (handleWorkbenchDoctor(req, res, url)) return;');
    expect(doctorAt).toBeGreaterThan(dashboard.indexOf("url.pathname === '/workbench/dock'"));
    expect(doctorAt).toBeLessThan(dashboard.indexOf("url.pathname === '/workbench.webmanifest'"));
  });
});

describe('/workbench-doctor auth', () => {
  const anonymous = {
    hasTokenParam: false,
    presentedToken: undefined,
    activeToken: 'the-active-token',
  } as const;

  it('opens to a tokenless visitor exactly like the static shell', () => {
    // 它要在登录态坏掉时可用，token 门后面的诊断页等于没有。
    expect(decideDashboardAuth({ method: 'GET', pathname: WORKBENCH_DOCTOR_PATH, ...anonymous }).kind).toBe('allow');
    expect(decideDashboardAuth({ method: 'HEAD', pathname: WORKBENCH_DOCTOR_PATH, ...anonymous }).kind).toBe('allow');
    // H5 / 平台身份走的是更窄的能力表，但静态壳同级的读仍旧放行。
    expect(decideWorkbenchH5Auth({ method: 'GET', pathname: WORKBENCH_DOCTOR_PATH }).kind).toBe('allow');
  });

  it('widens nothing else — writes and neighbouring paths stay gated', () => {
    expect(decideDashboardAuth({ method: 'POST', pathname: WORKBENCH_DOCTOR_PATH, ...anonymous }).kind).toBe('deny401');
    expect(decideDashboardAuth({ method: 'GET', pathname: '/workbench-doctor/x', ...anonymous }).kind).toBe('deny401');
    expect(decideDashboardAuth({ method: 'GET', pathname: '/workbench', ...anonymous }).kind).toBe('deny401');
    // 页面自己会去打的那些接口一个都没被顺带放开——诊断结果里的 401 必须是真的 401。
    expect(decideDashboardAuth({ method: 'GET', pathname: '/api/sessions', ...anonymous }).kind).toBe('deny401');
    expect(decideDashboardAuth({ method: 'GET', pathname: '/api/sessions/s1/view-link', ...anonymous }).kind).toBe('deny401');
  });
});
