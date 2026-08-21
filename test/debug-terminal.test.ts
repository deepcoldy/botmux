import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

// 平台绑定读的是 ~/.botmux/platform.json；测试要能自由开关「已绑定/未绑定」，所以
// 把底层 secure-host-file 打桩。默认返回 null = 未绑定，既有用例完全不受影响。
const readSecureHostFileSync = vi.fn<(...a: unknown[]) => string | null>(() => null);
vi.mock('../src/platform/secure-host-file.js', () => ({
  readSecureHostFileSync: (...a: unknown[]) => readSecureHostFileSync(...a),
  writeSecureHostFileSync: vi.fn(),
  unlinkSecureHostFileSync: vi.fn(),
  UnsafeHostAuthorityFileError: class extends Error {},
}));

import { createDebugTerminalManager, type DebugTerminalManager } from '../src/dashboard/debug-terminal.js';
import { classifyManagementUpgrade, managementUpgradeOrigin } from '../src/dashboard/control-csrf.js';
import { readPlatformBinding } from '../src/platform/binding.js';
import { resolveDashboardIdentity } from '../src/dashboard/request-identity.js';
import { parseCookie } from '../src/dashboard/auth.js';

// Dashboard 调试终端：owner-only 可写 shell 的鉴权 + 生命周期（codex review 补测）。
// 用真实 http server 承载 manager，node-pty 起真实 /bin/bash（Linux daemon 环境有）。

const TOKEN = 'test-admin-token';
const MACHINE_ID = 'ff27a1b1e45b4504';
const PLATFORM_HOST = 'botmux.example.com';

function bindPlatform(): void {
  readSecureHostFileSync.mockReturnValue(JSON.stringify({
    platformUrl: `https://${PLATFORM_HOST}`,
    machineId: MACHINE_ID,
    machineToken: 'tkn',
  }));
}
function unbindPlatform(): void {
  readSecureHostFileSync.mockReturnValue(null);
}

/**
 * 与 dashboard.ts 的 `server.on('upgrade')` 同一条判定链：先按 path 分流出 authority
 * 档位，再跑同源门禁，最后才交给 manager。分流函数与生产用的是同一个
 * {@link classifyManagementUpgrade}，所以这里验的是真实口径而不是复刻品。
 */
function startHarness(): Promise<{ server: Server; base: string; wsBase: string; mgr: DebugTerminalManager }> {
  const mgr = createDebugTerminalManager({
    getActiveToken: () => TOKEN,
    defaultWorkingDirs: () => ['/tmp'],
    // 与 dashboard.ts 同一条身份口径：只有 legacy 管理身份能开裸 bash。
    isLegacyManagementRequest: (req) => resolveDashboardIdentity({
      legacyCookie: parseCookie(req.headers.cookie),
      activeToken: TOKEN,
      roleHeader: req.headers['x-botmux-role'],
      platformMachineId: readPlatformBinding()?.machineId ?? null,
      platformActorScope: (machineId) => `scope-${machineId}`,
      legacyAuthSessionId: () => 'legacy-auth-session',
      h5: null,
    })?.kind === 'legacy-dashboard',
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (mgr.handleHttp(req, res, url)) return;
    res.writeHead(404); res.end('nf');
  });
  server.on('upgrade', (req, socket, head) => {
    const { route, surface } = classifyManagementUpgrade(req.url ?? '/');
    if (!managementUpgradeOrigin(req.headers, surface).ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    if (route === 'debug-terminal' && mgr.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, mgr, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
    });
  });
}

/** 连一条 WS，返回它最终是 open 还是被拒（error/close/timeout）。 */
function wsOutcome(url: string, headers: Record<string, string>): Promise<string> {
  const ws = new WebSocket(url, { headers });
  return new Promise<string>((resolve) => {
    const done = (r: string) => { try { ws.close(); } catch { /* ignore */ } resolve(r); };
    ws.on('open', () => done('open'));
    ws.on('error', () => resolve('error'));
    ws.on('close', () => resolve('close'));
    setTimeout(() => done('timeout'), 3000);
  });
}

async function post(base: string, path: string, cookie?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

let harness: Awaited<ReturnType<typeof startHarness>> | null = null;
afterEach(() => {
  harness?.mgr.shutdown();
  harness?.server.close();
  harness = null;
  unbindPlatform();
});

describe('debug-terminal HTTP auth', () => {
  it('create requires the management cookie; unauth cannot reach the page', async () => {
    harness = await startHarness();
    // 创建本身不在这层 gate（dashboard.ts 的 auth gate 已挡），但页面/WS 有独立校验。
    const created = await post(harness.base, '/api/debug-terminal', undefined, { workingDir: '/tmp' });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    const id = created.json.id as string;

    // 页面 GET 本身由 dashboard auth gate 保护（此 harness 未挂 gate，仅验 200 渲染）。
    const page = await fetch(`${harness.base}/debug-terminal/${id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('xterm');
  });

  it('unknown id page → 404', async () => {
    harness = await startHarness();
    const page = await fetch(`${harness.base}/debug-terminal/nope`);
    expect(page.status).toBe(404);
  });
});

describe('debug-terminal WebSocket auth', () => {
  it('rejects WS without the management cookie, accepts with it', async () => {
    harness = await startHarness();
    const { id } = (await post(harness.base, '/api/debug-terminal', undefined, {})).json;

    // 无 cookie → upgrade 被 destroy，客户端收到 error/close 而非 open。
    const noAuth = new WebSocket(`${harness.wsBase}/debug-terminal/${id}/ws`);
    const noAuthResult = await new Promise<string>((resolve) => {
      noAuth.on('open', () => resolve('open'));
      noAuth.on('error', () => resolve('error'));
      noAuth.on('close', () => resolve('close'));
    });
    expect(noAuthResult).not.toBe('open');

    // 带管理 cookie → open。
    const authed = new WebSocket(`${harness.wsBase}/debug-terminal/${id}/ws`, {
      headers: { cookie: `botmux_dashboard_token=${TOKEN}` },
    });
    const opened = await new Promise<boolean>((resolve) => {
      authed.on('open', () => resolve(true));
      authed.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    expect(opened).toBe(true);
    authed.close();
  });

  it('P0: refuses an opaque-origin (Origin: null) handshake even with the management cookie', async () => {
    harness = await startHarness();
    const { id } = (await post(harness.base, '/api/debug-terminal', undefined, {})).json;

    // `Origin: null` 只可能来自 opaque origin 文档——沙箱化的网页预览就是这么一个
    // 来源。它是「预览页 → 宿主裸 bash」这条链的最后一跳，即使 cookie 也一起带上，
    // 也必须拒死；调试终端页面永远带自己的真实 origin，不受影响。
    const opaque = new WebSocket(`${harness.wsBase}/debug-terminal/${id}/ws`, {
      headers: { cookie: `botmux_dashboard_token=${TOKEN}`, origin: 'null' },
    });
    const opaqueResult = await new Promise<string>((resolve) => {
      opaque.on('open', () => resolve('open'));
      opaque.on('error', () => resolve('error'));
      opaque.on('close', () => resolve('close'));
      setTimeout(() => resolve('timeout'), 2000);
    });
    expect(opaqueResult).not.toBe('open');

    // 同一个终端、同一个 cookie，带真实 origin 仍然连得上——只封 opaque origin。
    const realOrigin = new WebSocket(`${harness.wsBase}/debug-terminal/${id}/ws`, {
      headers: { cookie: `botmux_dashboard_token=${TOKEN}`, origin: harness.base },
    });
    const opened = await new Promise<boolean>((resolve) => {
      realOrigin.on('open', () => resolve(true));
      realOrigin.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    expect(opened).toBe(true);
    realOrigin.close();
  });

  it('WS to unknown terminal id is refused even with cookie', async () => {
    harness = await startHarness();
    const ws = new WebSocket(`${harness.wsBase}/debug-terminal/ghost/ws`, {
      headers: { cookie: `botmux_dashboard_token=${TOKEN}` },
    });
    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
      ws.on('close', () => resolve('close'));
    });
    expect(result).not.toBe('open');
  });
});

/**
 * 独立安全边界：调试终端 WS 的另一头是宿主的**裸 bash**，所以它的门禁必须和
 * `/api/debug-terminal` 的 HTTP 门禁一个口径（`legacyAuthed`），而不是「cookie 对上
 * 就放行」。中心化平台的隧道会**剥掉浏览器自己的 Cookie、注入本机活跃 cookie**，再用
 * `X-Botmux-Role` 表达真实用户角色——只比 cookie 的话，任何经平台隧道进来的人（含
 * teammate/guest，甚至 owner 这种本不该有裸 shell 的平台身份）都能开出宿主 shell。
 *
 * 两条腿各自独立、缺一不可，下面的用例分别把它们钉死：
 *   ① 同源门按 path 分档：调试终端只认 management 档，平台分享出去的终端子域 `t-` 不算；
 *   ② 身份门：必须解析成 legacy-dashboard 管理身份，平台注入身份一律拒。
 */
describe('debug-terminal WS 独立安全边界（不吃 t- 子域、不吃平台注入身份）', () => {
  const debugWs = (id: string) => `${harness!.wsBase}/debug-terminal/${id}/ws`;

  async function createTerminal(): Promise<string> {
    return (await post(harness!.base, '/api/debug-terminal', undefined, { workingDir: '/tmp' })).json.id as string;
  }

  it('复审点名组合：t- Origin + 注入的活跃 cookie + platform owner role → 拒绝', async () => {
    harness = await startHarness();
    const id = await createTerminal();
    bindPlatform();
    // 平台隧道过来的真实形状：Host 已改写成回环、无 XFH、cookie 是平台注入的本机活跃
    // 值、角色在 X-Botmux-Role 里，页面本身住在分享用的 `t-` 终端子域。
    expect(await wsOutcome(debugWs(id), {
      origin: `https://t-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: `botmux_dashboard_token=${TOKEN}`,
      'x-botmux-role': 'owner',
    })).not.toBe('open');
  });

  it('腿①单独成立：t- Origin + 活跃 cookie、连 role 头都不带，同样被同源门拒', async () => {
    harness = await startHarness();
    const id = await createTerminal();
    bindPlatform();
    // 不带 role → 身份门会把它判成 legacy-dashboard（腿②放行），此时唯一挡住它的
    // 就是「调试终端不认 t-」这条分档。这条转绿即证明腿①不是摆设。
    expect(await wsOutcome(debugWs(id), {
      origin: `https://t-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: `botmux_dashboard_token=${TOKEN}`,
    })).not.toBe('open');
  });

  it('腿②单独成立：m- Origin（同源门放行）+ 活跃 cookie + platform owner role 仍被身份门拒', async () => {
    harness = await startHarness();
    const id = await createTerminal();
    bindPlatform();
    // `m-` 在 management 档里，腿①放行；拦下它的只能是「必须是 legacy 管理身份」。
    expect(await wsOutcome(debugWs(id), {
      origin: `https://m-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: `botmux_dashboard_token=${TOKEN}`,
      'x-botmux-role': 'owner',
    })).not.toBe('open');
  });

  it('teammate / guest 平台角色同样拒（不是只挡 owner 一个值）', async () => {
    harness = await startHarness();
    const id = await createTerminal();
    bindPlatform();
    for (const role of ['teammate', 'guest']) {
      expect(await wsOutcome(debugWs(id), {
        origin: `https://m-${MACHINE_ID}.${PLATFORM_HOST}`,
        cookie: `botmux_dashboard_token=${TOKEN}`,
        'x-botmux-role': role,
      })).not.toBe('open');
    }
  });

  it('正例：legacy 管理身份 + m- 机器子域 → 放行（管理壳页这条路不能被改坏）', async () => {
    harness = await startHarness();
    const id = await createTerminal();
    bindPlatform();
    expect(await wsOutcome(debugWs(id), {
      origin: `https://m-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: `botmux_dashboard_token=${TOKEN}`,
    })).toBe('open');
  });

  it('正例：本机直连（Origin 就是自己的 host）+ 管理 cookie → 放行', async () => {
    harness = await startHarness();
    const id = await createTerminal();
    expect(await wsOutcome(debugWs(id), {
      origin: harness.base,
      cookie: `botmux_dashboard_token=${TOKEN}`,
    })).toBe('open');
  });

  it('/s 终端 WS 的 t- 通路不受影响：同一 Origin 在 /s 档下判同源（#960 不回退）', () => {
    bindPlatform();
    const headers = {
      origin: `https://t-${MACHINE_ID}.${PLATFORM_HOST}`,
      host: '127.0.0.1:7891',
    };
    expect(managementUpgradeOrigin(headers, classifyManagementUpgrade('/s/s1').surface)).toEqual({ ok: true });
    expect(managementUpgradeOrigin(headers, classifyManagementUpgrade('/debug-terminal/x/ws').surface))
      .toEqual({ ok: false, error: 'upgrade_origin_forbidden' });
  });
});

describe('debug-terminal lifecycle', () => {
  it('close endpoint destroys the terminal (page then 404)', async () => {
    harness = await startHarness();
    const { id } = (await post(harness.base, '/api/debug-terminal', undefined, {})).json;
    expect((await fetch(`${harness.base}/debug-terminal/${id}`)).status).toBe(200);
    const closed = await post(harness.base, `/api/debug-terminal/${id}/close`);
    expect(closed.json.ok).toBe(true);
    expect((await fetch(`${harness.base}/debug-terminal/${id}`)).status).toBe(404);
  });

  it('enforces the concurrent-terminal cap (429 past the limit)', async () => {
    harness = await startHarness();
    // MAX_TERMINALS = 8：连开 8 个成功，第 9 个 429。
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await post(harness.base, '/api/debug-terminal', undefined, {});
      expect(r.status).toBe(200);
      ids.push(r.json.id);
    }
    const over = await post(harness.base, '/api/debug-terminal', undefined, {});
    expect(over.status).toBe(429);
    expect(over.json.error).toBe('too_many_terminals');
  });

  it('shutdown destroys all terminals', async () => {
    harness = await startHarness();
    const { id } = (await post(harness.base, '/api/debug-terminal', undefined, {})).json;
    harness.mgr.shutdown();
    expect((await fetch(`${harness.base}/debug-terminal/${id}`)).status).toBe(404);
  });
});

describe('debug-terminal shell environment', () => {
  /**
   * The debug shell runs INSIDE the dashboard process, which is the machine's
   * only legitimate holder of the Feishu H5 login family
   * (BOTMUX_DASHBOARD_FEISHU_H5_*, APP_SECRET included — it can mint
   * app_access_token for the Dashboard's login app). It used to inherit
   * process.env verbatim, so a single `env` in this terminal printed the
   * secret, and so did every process started from it. The shell must get the
   * same redacted env a session's CLI child gets.
   *
   * Real bash over the real WS transport: assert on what the shell can
   * actually read, not on how the env object was built.
   */
  async function readShellVar(name: string): Promise<string> {
    harness = await startHarness();
    const { id } = (await post(harness!.base, '/api/debug-terminal', undefined, { workingDir: '/tmp' })).json;
    const ws = new WebSocket(`${harness!.wsBase}/debug-terminal/${id}/ws`, {
      headers: { cookie: `botmux_dashboard_token=${TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws open timeout')), 5000);
    });
    // Marker-delimited so the echoed command line itself can't be mistaken for
    // the answer: only the shell's OWN expansion lands between the markers.
    const probe = `printf 'PROBE<%s>END\\n' "\${${name}:-ABSENT}"\r`;
    return await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`no probe output; saw: ${buf.slice(-200)}`)), 15_000);
      ws.on('message', (data) => {
        buf += String(data);
        // Skip the terminal echo of the command (it contains "PROBE<%s>END").
        const m = buf.match(/PROBE<([^>]*)>END/g)?.filter(s => !s.includes('%s'));
        if (m?.length) {
          clearTimeout(timer);
          ws.close();
          resolve(m[0].replace(/^PROBE</, '').replace(/>END$/, ''));
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      // 与前端同协议：{type:'input', data}
      setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: probe })), 400);
    });
  }

  it('the bash session cannot read the Dashboard H5 app secret', async () => {
    process.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET = 'h5-secret-must-not-leak';
    try {
      expect(await readShellVar('BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET')).toBe('ABSENT');
    } finally {
      delete process.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET;
    }
  });

  it('the bash session cannot read the bot IM app secret either', async () => {
    // Same boundary, different family: the debug shell is a repro環境 for a
    // session's CLI command, so it must see what that CLI would see.
    process.env.LARK_APP_SECRET = 'lark-secret-must-not-leak';
    try {
      expect(await readShellVar('LARK_APP_SECRET')).toBe('ABSENT');
    } finally {
      delete process.env.LARK_APP_SECRET;
    }
  });

  it('still inherits the ordinary environment — redaction removes only the deny list', async () => {
    // Redaction must not gut the shell: the whole point of this terminal is
    // running `botmux` / CLI repro commands. (PATH itself is not asserted here
    // — `bash -l` re-sources the login profiles and rebuilds it.)
    process.env.BOTMUX_DEBUG_TERMINAL_KEEPER = 'inherited-ok';
    try {
      expect(await readShellVar('BOTMUX_DEBUG_TERMINAL_KEEPER')).toBe('inherited-ok');
      expect(await readShellVar('BOTMUX_DEBUG_TERMINAL')).toBe('1');
    } finally {
      delete process.env.BOTMUX_DEBUG_TERMINAL_KEEPER;
    }
  });
});
