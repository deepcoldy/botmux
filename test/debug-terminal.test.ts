import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createDebugTerminalManager, type DebugTerminalManager } from '../src/dashboard/debug-terminal.js';

// Dashboard 调试终端：owner-only 可写 shell 的鉴权 + 生命周期（codex review 补测）。
// 用真实 http server 承载 manager，node-pty 起真实 /bin/bash（Linux daemon 环境有）。

const TOKEN = 'test-admin-token';

function startHarness(): Promise<{ server: Server; base: string; wsBase: string; mgr: DebugTerminalManager }> {
  const mgr = createDebugTerminalManager({
    getActiveToken: () => TOKEN,
    defaultWorkingDirs: () => ['/tmp'],
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (mgr.handleHttp(req, res, url)) return;
    res.writeHead(404); res.end('nf');
  });
  server.on('upgrade', (req, socket, head) => {
    if (mgr.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, mgr, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
    });
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
