// 安全集成测试：用【真实】botmux bind + 真实 tunnel-client.js 打通【真实】平台。
// 隔离：HOME=临时目录（绝不碰真实 ~/.botmux / 线上 daemon），dashboard 用 mock。
// 用法：node scripts/platform-itest.mjs   （需先把 platform 与本仓都 build 过）
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';

const PLATFORM_DIR = process.env.PLATFORM_DIR || path.resolve('..', 'platform');
const PORT = 8124;
const DASH_PORT = 7992;
const SECRET = 'itest-secret';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('  ✗', m); } else console.log('  ✓', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req({ path: p, method = 'GET', host = 'localhost', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host, ...headers } }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, setCookies: res.headers['set-cookie'] || [], body: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const cval = (sc, n) => { for (const c of sc) { const m = c.match(new RegExp('^' + n + '=([^;]*)')); if (m) return m[1]; } return null; };

async function main() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'botmux-itest-'));
  fs.mkdirSync(path.join(tmpHome, '.botmux'), { recursive: true });
  // 让本进程(含稍后 import 的 tunnel-client)都用隔离 HOME，绝不碰真实 ~/.botmux
  process.env.HOME = tmpHome;

  // mock dashboard
  const dash = http.createServer((rq, rs) => { rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<html>REAL_TUNNEL_OK ' + rq.url + '</html>'); });
  new WebSocketServer({ server: dash, path: '/term' }).on('connection', (ws) => ws.on('message', (d) => ws.send('echo:' + d)));
  await new Promise((r) => dash.listen(DASH_PORT, r));

  // 平台
  const platform = spawn('node', ['dist/index.js'], {
    cwd: PLATFORM_DIR,
    env: { ...process.env, PORT: String(PORT), SIGNING_SECRET: SECRET, PUBLIC_BASE_URL: `http://localhost:${PORT}`, NODE_ENV: 'development', DEV_LOGIN: 'true' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await sleep(800);

  let tunnel = null;
  try {
    // 登录 + 拿绑定码
    const login = await req({ path: '/auth/login' });
    const cookie = `botmux_platform_session=${cval(login.setCookies, 'botmux_platform_session')}`;
    const bc = JSON.parse((await req({ path: '/api/bind-code', method: 'POST', headers: { cookie } })).body);
    ok(!!bc.code, '平台发放绑定码');

    // 真实 botmux bind（HOME 隔离）
    const bind = spawn('node', ['dist/cli.js', 'bind', bc.code, '--platform', `http://localhost:${PORT}`], {
      env: { ...process.env, HOME: tmpHome }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const bindExit = await new Promise((r) => bind.on('exit', r));
    ok(bindExit === 0, 'botmux bind 退出码 0');
    const binding = JSON.parse(fs.readFileSync(path.join(tmpHome, '.botmux', 'platform.json'), 'utf8'));
    ok(!!binding.machineToken && !!binding.machineId, 'platform.json 写入 machineToken');

    // 真实 tunnel-client.js 起隧道（指向 mock dashboard）
    const mod = await import('file://' + path.resolve('dist/platform/tunnel-client.js'));
    tunnel = mod.startPlatformTunnelClient({
      binding,
      getDashboardPort: () => DASH_PORT,
      getDashboardToken: () => 'itest-dash-token',
      getVersion: () => '9.9.9',
      getMemberships: () => [],
      log: (m, e) => console.log('    [tunnel]', m, e || ''),
    });
    await sleep(700);

    // 平台看到机器
    const ml = JSON.parse((await req({ path: '/api/machines', headers: { cookie } })).body);
    ok(ml.machines.length === 1 && ml.machines[0].botmuxVersion === '9.9.9', '平台看到真实隧道机器(版本上报)');
    const mid = ml.machines[0].machineId;
    ok(mid === binding.machineId, 'machineId 一致');

    // 打开 + 反代
    const open = JSON.parse((await req({ path: `/api/machines/${mid}/open`, method: 'POST', headers: { cookie } })).body);
    const ticket = new URL(open.openUrl).searchParams.get('ticket');
    const subHost = `m-${mid}.localhost`;
    const opened = await req({ path: `/__open?ticket=${encodeURIComponent(ticket)}`, host: subHost });
    const pcookie = `botmux_proxy_session=${cval(opened.setCookies, 'botmux_proxy_session')}`;
    const proxied = await req({ path: '/x', host: subHost, headers: { cookie: pcookie } });
    ok(proxied.body.includes('REAL_TUNNEL_OK'), '经真实隧道反代到 dashboard');

    // 团队：平台创建 → 真实 tunnel-client 收 join-team 落盘+上报 → 名册
    const team = JSON.parse((await req({ path: '/api/teams', method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '集成队' }) })).body);
    ok(team.delivered >= 1, '创建团队下发到真实 daemon');
    await sleep(500);
    const roster = JSON.parse((await req({ path: `/api/teams/${team.teamId}/roster`, headers: { cookie } })).body);
    ok(roster.members.length === 1, '真实 daemon 上报团队成员关系→名册');
    const pj = JSON.parse(fs.readFileSync(path.join(tmpHome, '.botmux', 'platform.json'), 'utf8'));
    ok(Array.isArray(pj.teams) && pj.teams.some((t) => t.teamId === team.teamId), 'join-team 落盘到 platform.json');
  } catch (e) {
    fails++; console.error('异常', e);
  } finally {
    try { tunnel?.stop(); } catch {}
    platform.kill('SIGKILL');
    dash.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  console.log(fails ? `\n集成测试失败：${fails} 项` : '\n集成测试全过 ✅');
  process.exit(fails ? 1 : 0);
}
main();
