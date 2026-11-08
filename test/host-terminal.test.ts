import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { WebSocket } from './helpers/node-ws.js';

// 平台绑定读的是 ~/.botmux/platform.json；测试要能自由开关「已绑定/未绑定」，所以
// 把底层 secure-host-file 打桩。默认返回 null = 未绑定。
const readSecureHostFileSync = vi.fn<(...a: unknown[]) => string | null>(() => null);
vi.mock('../src/platform/secure-host-file.js', () => ({
  readSecureHostFileSync: (...a: unknown[]) => readSecureHostFileSync(...a),
  writeSecureHostFileSync: vi.fn(),
  unlinkSecureHostFileSync: vi.fn(),
  UnsafeHostAuthorityFileError: class extends Error {},
}));

import { createHostTerminalManager, hostLoginEnv, resolveLoginShell, type HostTerminalManager } from '../src/dashboard/host-terminal.js';
import { HOST_TERMINAL_HIGH_WATER } from '../src/dashboard/host-terminal-protocol.js';
import { classifyManagementUpgrade, managementUpgradeOrigin } from '../src/dashboard/control-csrf.js';
import { readPlatformBinding } from '../src/platform/binding.js';
import { resolveDashboardIdentity } from '../src/dashboard/request-identity.js';
import { parseCookie } from '../src/dashboard/auth.js';

// 宿主网页终端（管理 → 终端）：owner-only 可写 shell 的鉴权、干净登录环境、二进制线协议、
// 背压与 tmux attach。node-pty 起真实 shell，Node（vitest）与 Bun（bun test）两条腿都跑。

const TOKEN = 'test-admin-token';
const MACHINE_ID = 'ff27a1b1e45b4504';
const PLATFORM_HOST = 'botmux.example.com';
const COOKIE = `botmux_dashboard_token=${TOKEN}`;
// 登录 shell 固定成 /bin/sh：测的是本模块，不是开发机上那份很重的 zsh rc。
const SHELL = '/bin/sh';

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

type Harness = { server: Server; base: string; wsBase: string; mgr: HostTerminalManager };

/** 与 dashboard.ts 的 `server.on('upgrade')` 同一条判定链：先按 path 分流 authority 档位，
 *  再跑同源门禁，最后才交给 manager。 */
function startHarness(extra: { tmuxArgs?: string[]; describeManagedTmuxSession?: (n: string) => string | undefined } = {}): Promise<Harness> {
  const mgr = createHostTerminalManager({
    getActiveToken: () => TOKEN,
    loginShell: SHELL,
    ...extra,
    isLegacyManagementRequest: (req) => resolveDashboardIdentity({
      legacyCookie: parseCookie(req.headers.cookie),
      activeToken: TOKEN,
      roleHeader: req.headers['x-botmux-role'],
      actorHeader: req.headers['x-botmux-actor'],
      scopesHeader: req.headers['x-botmux-scopes'],
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
    if (route === 'host-terminal' && mgr.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, mgr, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
    });
  });
}

async function request(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function createShell(h: Harness, size?: { cols: number; rows: number }): Promise<string> {
  const r = await request(h.base, 'POST', '/api/host-terminal', { target: { kind: 'shell' }, ...(size ?? {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.terminal.id as string;
}

const wsUrl = (h: Harness, id: string) => `${h.wsBase}/host-terminal/${id}/ws`;

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

/** 已认证的终端客户端：收集文本控制帧与二进制输出，可选自动 ack。 */
class Client {
  readonly ws: InstanceType<typeof WebSocket>;
  controls: any[] = [];
  binaryFrames = 0;
  received = 0;
  private chunks: Buffer[] = [];
  autoAck = true;

  constructor(url: string) {
    this.ws = new WebSocket(url, { headers: { cookie: COOKIE } });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) { this.controls.push(JSON.parse(String(data))); return; }
      this.binaryFrames++;
      this.received += data.length;
      this.chunks.push(Buffer.from(data));
      if (this.autoAck) this.ack(data.length);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      setTimeout(() => reject(new Error('ws open timeout')), 5000);
    });
  }

  text(): string { return Buffer.concat(this.chunks).toString('utf8'); }
  input(s: string): void { this.ws.send(Buffer.from(s, 'utf8'), { binary: true }); }
  control(msg: unknown): void { this.ws.send(JSON.stringify(msg)); }
  ack(bytes: number): void { if (bytes > 0) this.control({ t: 'ack', bytes }); }

  async waitFor(pred: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (!pred()) {
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}; tail: ${JSON.stringify(this.text().slice(-300))}`);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

let harness: Harness | null = null;
const clients: Client[] = [];
function client(url: string): Client {
  const c = new Client(url);
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  harness?.mgr.shutdown();
  harness?.server.close();
  harness = null;
  unbindPlatform();
});

describe('host-terminal HTTP', () => {
  it('creates, lists and closes a login shell', async () => {
    harness = await startHarness();
    const id = await createShell(harness, { cols: 100, rows: 30 });
    const listed = await request(harness.base, 'GET', '/api/host-terminal');
    expect(listed.json.terminals).toEqual([
      expect.objectContaining({ id, target: { kind: 'shell' }, label: 'sh', cols: 100, rows: 30, clients: 0 }),
    ]);
    const closed = await request(harness.base, 'POST', `/api/host-terminal/${id}/close`);
    expect(closed.json.ok).toBe(true);
    expect((await request(harness.base, 'GET', '/api/host-terminal')).json.terminals).toEqual([]);
  });

  it('rejects malformed targets and unknown tmux sessions', async () => {
    harness = await startHarness();
    expect((await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'ssh' } })).status).toBe(400);
    // 以 `-` 开头的名字会被 tmux/herdr 当成选项；控制字符会弄乱日志/界面。
    expect((await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'tmux', session: '-L' } })).status).toBe(400);
    expect((await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'herdr', session: 'a\nb' } })).status).toBe(400);
  });

  it('enforces the concurrent-terminal cap (429 past the limit)', async () => {
    harness = await startHarness();
    const results = await Promise.all(Array.from({ length: 17 }, () =>
      request(harness!.base, 'POST', '/api/host-terminal', { target: { kind: 'shell' } })));
    expect(results.filter(r => r.status === 200)).toHaveLength(16);
    const over = results.filter(r => r.status === 429);
    expect(over).toHaveLength(1);
    expect(over[0].json.error).toBe('too_many_terminals');
  });

  it('lists the login shell as a target', async () => {
    harness = await startHarness();
    const r = await request(harness.base, 'GET', '/api/host-terminal/targets');
    expect(r.json.targets.shell).toEqual({ path: SHELL, name: 'sh' });
    expect(r.json.targets.tmux).toEqual(expect.objectContaining({ available: expect.any(Boolean) }));
    expect(r.json.targets.herdr).toEqual(expect.objectContaining({ available: expect.any(Boolean) }));
  });
});

describe('host-terminal WebSocket auth', () => {
  it('rejects WS without the management cookie, accepts with it', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    expect(await wsOutcome(wsUrl(harness, id), {})).not.toBe('open');
    expect(await wsOutcome(wsUrl(harness, id), { cookie: COOKIE })).toBe('open');
  });

  it('P0: refuses an opaque-origin (Origin: null) handshake even with the management cookie', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    expect(await wsOutcome(wsUrl(harness, id), { cookie: COOKIE, origin: 'null' })).not.toBe('open');
    expect(await wsOutcome(wsUrl(harness, id), { cookie: COOKIE, origin: harness.base })).toBe('open');
  });

  it('WS to an unknown terminal id is refused even with cookie', async () => {
    harness = await startHarness();
    expect(await wsOutcome(wsUrl(harness, 'ghost'), { cookie: COOKIE })).not.toBe('open');
  });
});

/**
 * 独立安全边界：WS 的另一头是宿主 shell，门禁必须和 `/api/host-terminal` 的 HTTP 门禁
 * 一个口径（`legacyAuthed`），而不是「cookie 对上就放行」。中心化平台隧道会剥掉浏览器
 * 自己的 Cookie、注入本机活跃 cookie，再用 `X-Botmux-Role` 表达真实角色——只比 cookie
 * 的话，任何经平台隧道进来的人都能开出宿主 shell。两条腿各自独立、缺一不可：
 *   ① 同源门按 path 分档：宿主终端只认 management 档，平台分享出去的终端子域 `t-` 不算；
 *   ② 身份门：必须解析成 legacy-dashboard 管理身份，带角色头的平台注入身份一律拒。
 *
 * 平台机器 Dashboard（`m-`）反代故意不注入角色头、只带 actor + scopes（平台侧决定：协管者
 * 与机器主人等能力），那里进来的人在本机就是 legacy 管理身份——终端页提示文案按这个现状写，
 * 下面最后一条用例把它钉住。
 */
describe('host-terminal WS 独立安全边界（不吃 t- 子域、不吃平台注入身份）', () => {
  it('t- Origin + 注入的活跃 cookie + platform owner role → 拒绝', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    bindPlatform();
    expect(await wsOutcome(wsUrl(harness, id), {
      origin: `https://t-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: COOKIE,
      'x-botmux-role': 'owner',
    })).not.toBe('open');
  });

  it('腿①单独成立：t- Origin + 活跃 cookie、不带 role，同样被同源门拒', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    bindPlatform();
    expect(await wsOutcome(wsUrl(harness, id), {
      origin: `https://t-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: COOKIE,
    })).not.toBe('open');
  });

  it('腿②单独成立：m- Origin + 活跃 cookie + 任一平台角色仍被身份门拒', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    bindPlatform();
    for (const role of ['owner', 'teammate', 'guest']) {
      expect(await wsOutcome(wsUrl(harness, id), {
        origin: `https://m-${MACHINE_ID}.${PLATFORM_HOST}`,
        cookie: COOKIE,
        'x-botmux-role': role,
      }), role).not.toBe('open');
    }
  });

  it('正例：legacy 管理身份 + m- 机器子域 → 放行', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    bindPlatform();
    expect(await wsOutcome(wsUrl(harness, id), {
      origin: `https://m-${MACHINE_ID}.${PLATFORM_HOST}`,
      cookie: COOKIE,
    })).toBe('open');
  });

  it('现状：平台机器 Dashboard 反代（m- + actor + scopes、无角色头）的机器主人和协管者 → 放行', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    bindPlatform();
    for (const [actor, scopes] of [
      ['on_machine_owner', 'machines:read,sessions:open,terminal:control,dashboard:manage'],
      ['on_co_manager', 'machines:read,sessions:open,terminal:control'],
    ]) {
      expect(await wsOutcome(wsUrl(harness, id), {
        origin: `https://m-${MACHINE_ID}.${PLATFORM_HOST}`,
        cookie: COOKIE,
        'x-botmux-actor': actor,
        'x-botmux-scopes': scopes,
      }), actor).toBe('open');
    }
  });
});

describe('host-terminal login environment', () => {
  it('builds an sshd-style env: identity + TERM + locale passthrough, nothing else', () => {
    const env = hostLoginEnv('/bin/zsh', {
      PATH: '/opt/daemon/bin:/usr/bin',
      LANG: 'zh_CN.UTF-8',
      LC_TIME: 'C',
      TZ: 'Asia/Shanghai',
      TMUX_TMPDIR: '/run/tmux-sockets',
      BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'h5-secret',
      LARK_APP_SECRET: 'lark-secret',
      HTTP_PROXY: 'http://proxy:3128',
      NODE_OPTIONS: '--max-old-space-size=8192',
    });
    expect(Object.keys(env).sort()).toEqual(
      ['COLORTERM', 'HOME', 'LANG', 'LC_TIME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMUX_TMPDIR', 'TZ', 'USER'].sort(),
    );
    expect(env).toEqual(expect.objectContaining({
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'zh_CN.UTF-8',
      TMUX_TMPDIR: '/run/tmux-sockets',
    }));
    // PATH 不继承 daemon 的：交给用户自己的登录 rc 去扩展。
    expect(env.PATH).not.toContain('/opt/daemon/bin');
  });

  it.skipIf(process.platform !== 'linux')('resolves the passwd login shell, not $SHELL (Bun\'s userInfo().shell is just $SHELL)', async () => {
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
    const registered = execFileSync('getent', ['passwd', uid], { encoding: 'utf8' }).trim().split(':')[6];
    expect(await resolveLoginShell({ SHELL: '/definitely/not/a/shell' })).toBe(registered);
  });

  it('passes the XDG / herdr location selectors through so attach finds what discovery listed', () => {
    const env = hostLoginEnv('/bin/sh', { XDG_CONFIG_HOME: '/srv/cfg', XDG_RUNTIME_DIR: '/run/user/0', XDG_FOO: 'no' });
    expect(env.XDG_CONFIG_HOME).toBe('/srv/cfg');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/0');
    expect(env.XDG_FOO).toBeUndefined();
  });

  it('falls back to a UTF-8 locale when the dashboard has none', () => {
    const env = hostLoginEnv('/bin/sh', { PATH: '/usr/bin' });
    expect(env.LANG).toMatch(/UTF-8$/);
  });

  async function readShellVar(name: string): Promise<string> {
    harness = await startHarness();
    const id = await createShell(harness);
    const c = client(wsUrl(harness, id));
    await c.opened();
    // Marker-delimited so the echoed command line itself can't be mistaken for
    // the answer: only the shell's OWN expansion lands between the markers.
    c.input(`printf 'PROBE<%s>END\\n' "\${${name}:-ABSENT}"\r`);
    let value: string | undefined;
    await c.waitFor(() => {
      const m = c.text().match(/PROBE<([^>%]*)>END/);
      if (m) value = m[1];
      return value !== undefined;
    }, `probe ${name}`);
    return value!;
  }

  it('the shell cannot read the Dashboard H5 app secret or any other dashboard env', async () => {
    process.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET = 'h5-secret-must-not-leak';
    process.env.BOTMUX_HOST_TERMINAL_KEEPER = 'not-inherited';
    try {
      expect(await readShellVar('BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET')).toBe('ABSENT');
      harness!.mgr.shutdown();
      expect(await readShellVar('BOTMUX_HOST_TERMINAL_KEEPER')).toBe('ABSENT');
    } finally {
      delete process.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET;
      delete process.env.BOTMUX_HOST_TERMINAL_KEEPER;
    }
  });

  it('keeps IUTF8 on even though output is read as raw bytes (canonical-mode backspace erases whole characters)', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const c = client(wsUrl(harness, id));
    await c.opened();
    c.input('stty -a | tr " " "\\n" | grep -x -- "-\\?iutf8" | sed "s/^/IUTF8=/"\r');
    await c.waitFor(() => /IUTF8=-?iutf8/.test(c.text()), 'stty iutf8 state');
    expect(c.text()).toMatch(/IUTF8=iutf8/);
  });

  it('starts in HOME with the login identity', async () => {
    expect(await readShellVar('PWD')).toBe(homedir());
    harness!.mgr.shutdown();
    expect(await readShellVar('TERM')).toBe('xterm-256color');
  });
});

describe('host-terminal wire protocol', () => {
  it('sends hello as a text frame, then output as binary frames; input is binary', async () => {
    harness = await startHarness();
    const id = await createShell(harness, { cols: 90, rows: 20 });
    const c = client(wsUrl(harness, id));
    await c.opened();
    await c.waitFor(() => c.controls.length > 0, 'hello');
    expect(c.controls[0]).toEqual({ t: 'hello', terminal: expect.objectContaining({ id, cols: 90, rows: 20 }) });
    c.input('printf "%s-%s\\n" bin ary\r');
    await c.waitFor(() => c.text().includes('bin-ary'), 'binary echo');
    // 中文跨帧也不能坏：服务端不解码，原字节下发。
    c.input('printf "\\344\\275\\240\\345\\245\\275\\n"\r');
    await c.waitFor(() => c.text().includes('你好'), 'utf-8 output');
  });

  it('applies resize control messages to the PTY', async () => {
    harness = await startHarness();
    const id = await createShell(harness, { cols: 80, rows: 24 });
    const c = client(wsUrl(harness, id));
    await c.opened();
    c.control({ t: 'resize', cols: 133, rows: 41 });
    await new Promise(r => setTimeout(r, 100));
    c.input('stty size\r');
    await c.waitFor(() => c.text().includes('41 133'), 'stty size');
  });

  it('switches to the alternate screen before painting a replay whose ?1049h was evicted', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const a = client(wsUrl(harness, id));
    await a.opened();
    // 先进备用屏，再在里面刷出比环形缓冲（1MB）还多的内容，然后停在备用屏里。
    a.input('printf "\\033[?1049h"; head -c 1500000 /dev/zero | tr "\\0" x; echo ALT-$((3*3)); sleep 30\r');
    await a.waitFor(() => a.text().includes('ALT-9'), 'alt-screen flood', 20_000);
    const b = client(wsUrl(harness, id));
    await b.opened();
    await b.waitFor(() => b.received > 0, 'replay');
    expect(b.text().startsWith('\x1bc\x1b[?1047h')).toBe(true);
  });

  it('hands the owner role (who answers terminal queries) to the client that types', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const a = client(wsUrl(harness, id));
    await a.opened();
    await a.waitFor(() => a.controls.some(m => m.t === 'role'), 'a role');
    expect(a.controls.filter(m => m.t === 'role').at(-1)).toEqual({ t: 'role', owner: true });
    const b = client(wsUrl(harness, id));
    await b.opened();
    await b.waitFor(() => b.controls.some(m => m.t === 'role'), 'b role');
    expect(b.controls.filter(m => m.t === 'role').at(-1)).toEqual({ t: 'role', owner: false });
    b.input(' ');
    await a.waitFor(() => a.controls.filter(m => m.t === 'role').at(-1)?.owner === false, 'a demoted');
    await b.waitFor(() => b.controls.filter(m => m.t === 'role').at(-1)?.owner === true, 'b promoted');
    // 旧主控补答交接点之前的查询（reply 控制帧）不会把主控抢回去。
    a.control({ t: 'reply', data: '\x1b[?1;2c' });
    await new Promise(r => setTimeout(r, 150));
    expect(b.controls.filter(m => m.t === 'role').at(-1)).toEqual({ t: 'role', owner: true });
    // 主控端断开：交回给剩下的那个。
    b.close();
    await a.waitFor(() => a.controls.filter(m => m.t === 'role').at(-1)?.owner === true, 'a re-promoted');
  });

  it('prefers a visible, still-delivered client when the owner disconnects', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const a = client(wsUrl(harness, id));
    await a.opened();
    const b = client(wsUrl(harness, id));
    await b.opened();
    const c = client(wsUrl(harness, id));
    await c.opened();
    c.control({ t: 'visibility', hidden: true });
    await a.waitFor(() => a.controls.filter(m => m.t === 'role').at(-1)?.owner === true, 'a owner');
    a.close();
    // c 连得最晚但在后台；接任的应该是可见的 b。
    await b.waitFor(() => b.controls.filter(m => m.t === 'role').at(-1)?.owner === true, 'b promoted');
    expect(c.controls.filter(m => m.t === 'role').at(-1)).toEqual({ t: 'role', owner: false });
  });

  it('hands the owner role away when the owner goes to the background', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const a = client(wsUrl(harness, id));
    await a.opened();
    const b = client(wsUrl(harness, id));
    await b.opened();
    await a.waitFor(() => a.controls.filter(m => m.t === 'role').at(-1)?.owner === true, 'a owner');
    a.control({ t: 'visibility', hidden: true });
    await b.waitFor(() => b.controls.filter(m => m.t === 'role').at(-1)?.owner === true, 'b takes over');
  });

  it('broadcasts a resize to the other clients so they follow the active one', async () => {
    harness = await startHarness();
    const id = await createShell(harness, { cols: 80, rows: 24 });
    const a = client(wsUrl(harness, id));
    const b = client(wsUrl(harness, id));
    await Promise.all([a.opened(), b.opened()]);
    a.control({ t: 'resize', cols: 101, rows: 33 });
    await b.waitFor(() => b.controls.some(m => m.t === 'size'), 'size broadcast');
    expect(b.controls.find(m => m.t === 'size')).toEqual({ t: 'size', cols: 101, rows: 33 });
    // 发起方也收到（本地网格只跟 size 事件走）；尺寸不变的 resize 只回给发起方。
    await a.waitFor(() => a.controls.some(m => m.t === 'size'), 'size echo');
    a.control({ t: 'resize', cols: 101, rows: 33 });
    await a.waitFor(() => a.controls.filter(m => m.t === 'size').length === 2, 'unchanged reply');
    await new Promise(r => setTimeout(r, 150));
    expect(b.controls.filter(m => m.t === 'size')).toHaveLength(1);
  });

  it('replays recent output to a second client (RIS first) and reports exit', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const a = client(wsUrl(harness, id));
    await a.opened();
    a.input('echo first-client-marker\r');
    await a.waitFor(() => (a.text().match(/first-client-marker/g) ?? []).length >= 2, 'echo');
    const b = client(wsUrl(harness, id));
    await b.opened();
    await b.waitFor(() => b.text().includes('first-client-marker'), 'replay');
    expect(b.text().startsWith('\x1bc')).toBe(true);
    // 重放帧之前有 `replay` 标记：客户端据此丢弃 xterm 对历史查询的应答；后来者不是主控端。
    expect(b.controls.map(m => m.t)).toEqual(['hello', 'role', 'replay']);
    expect(b.controls[1]).toEqual({ t: 'role', owner: false });
    a.input('exit\r');
    await a.waitFor(() => a.controls.some(m => m.t === 'exit'), 'exit control');
    expect(a.controls.find(m => m.t === 'exit')).toEqual({ t: 'exit', code: 0, signal: null });
  });
});

describe('host-terminal backpressure', () => {
  // 结束标记用算术展开：命令行回显里是 `$((6*7))`，只有真跑完才会出现 FLOOD-42-DONE。
  const FLOOD = 'head -c 6000000 /dev/zero | tr "\\0" x; echo; echo FLOOD-$((6*7))-DONE\r';

  it('pauses the PTY when a visible client stops acking, resumes once it acks', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const c = client(wsUrl(harness, id));
    await c.opened();
    await new Promise(r => setTimeout(r, 200));
    c.autoAck = false;
    c.input(FLOOD);
    await new Promise(r => setTimeout(r, 1500));
    // 没 ack：服务端只会发到高水位 + 一帧上下（外加启动时的重放/回显）。
    const stalledAt = c.received;
    expect(stalledAt).toBeLessThan(HOST_TERMINAL_HIGH_WATER + 512 * 1024);
    await new Promise(r => setTimeout(r, 500));
    expect(c.received).toBe(stalledAt);
    // 一次性把收到的都 ack 掉，之后自动 ack：洪水必须完整走完。
    c.ack(c.received);
    c.autoAck = true;
    await c.waitFor(() => c.text().includes('FLOOD-42-DONE'), 'flood completion', 20_000);
    expect(c.received).toBeGreaterThan(6_000_000);
  });

  it('a hidden client never stalls the PTY and is resynced when visible again', async () => {
    harness = await startHarness();
    const id = await createShell(harness);
    const c = client(wsUrl(harness, id));
    await c.opened();
    await new Promise(r => setTimeout(r, 200));
    c.autoAck = false;
    c.control({ t: 'visibility', hidden: true });
    c.input(FLOOD);
    // 后台标签页不 ack，也不能把洪水卡住：用第二个（可见、正常 ack）客户端确认它跑完了。
    const watcher = client(wsUrl(harness, id));
    await watcher.opened();
    await watcher.waitFor(() => watcher.text().includes('FLOOD-42-DONE'), 'flood completion seen by watcher', 20_000);
    // 隐藏客户端积压封顶，不会被灌进全部 6MB。
    expect(c.received).toBeLessThan(6_000_000);
    const before = c.received;
    c.control({ t: 'visibility', hidden: false });
    await c.waitFor(() => c.text().slice(before).includes('FLOOD-42-DONE'), 'resync after visible');
  });
});

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!hasTmux)('host-terminal tmux attach', () => {
  const socket = `botmux-host-terminal-test-${process.pid}`;
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], {
    env: { ...process.env, TMUX: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  beforeAll(() => {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'demo', '-x', '120', '-y', '30', '/bin/sh');
    tmux('new-session', '-d', '-s', 'bmx-12345678', '-x', '120', '-y', '30', '/bin/sh');
  });
  afterAll(() => {
    try { tmux('kill-server'); } catch { /* already gone */ }
  });

  /** 等 attach 客户端真的挂上 session：连上后服务端先发重放帧，收到字节不代表 tmux 客户端已就位。 */
  async function waitForClient(session: string): Promise<string> {
    const started = Date.now();
    for (;;) {
      const flags = tmux('list-clients', '-t', session, '-F', '#{client_flags}').trim();
      if (flags) return flags;
      if (Date.now() - started > 10_000) throw new Error(`no tmux client attached to ${session}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }

  it('lists user sessions before botmux-managed ones, with managed titles', async () => {
    harness = await startHarness({
      tmuxArgs: ['-L', socket],
      describeManagedTmuxSession: name => (name === 'bmx-12345678' ? 'bot · topic' : undefined),
    });
    const r = await request(harness.base, 'GET', '/api/host-terminal/targets');
    const names = r.json.targets.tmux.sessions.map((s: any) => s.name);
    expect(names).toEqual(['demo', 'bmx-12345678']);
    expect(r.json.targets.tmux.sessions[1]).toEqual(expect.objectContaining({ managed: true, title: 'bot · topic' }));
  });

  it('attaches interactively; managed sessions attach with ignore-size', async () => {
    harness = await startHarness({ tmuxArgs: ['-L', socket] });
    expect((await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'tmux', session: 'nope' } })).status).toBe(404);

    const created = await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'tmux', session: 'demo' }, cols: 100, rows: 28 });
    expect(created.status).toBe(200);
    const c = client(wsUrl(harness, created.json.terminal.id));
    await c.opened();
    c.input('echo inside-tmux-$((6*7))\r');
    await c.waitFor(() => c.text().includes('inside-tmux-42'), 'tmux echo');

    const managed = await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'tmux', session: 'bmx-12345678' } });
    expect(managed.status).toBe(200);
    const m = client(wsUrl(harness, managed.json.terminal.id));
    await m.opened();
    expect(await waitForClient('bmx-12345678')).toContain('ignore-size');
  });

  it('attaches with -E so the clean web client env never rewrites the session environment', async () => {
    tmux('set-environment', '-t', 'demo', 'SSH_AUTH_SOCK', '/tmp/agent.sock');
    harness = await startHarness({ tmuxArgs: ['-L', socket] });
    const created = await request(harness.base, 'POST', '/api/host-terminal', { target: { kind: 'tmux', session: 'demo' } });
    const c = client(wsUrl(harness, created.json.terminal.id));
    await c.opened();
    await waitForClient('demo');
    await new Promise(r => setTimeout(r, 200));
    expect(tmux('show-environment', '-t', 'demo', 'SSH_AUTH_SOCK').trim()).toBe('SSH_AUTH_SOCK=/tmp/agent.sock');
  });
});
