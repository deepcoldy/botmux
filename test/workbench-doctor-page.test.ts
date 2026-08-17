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
  WORKBENCH_DOCTOR_TITLE,
  handleWorkbenchDoctor,
  workbenchDoctorHtml,
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
