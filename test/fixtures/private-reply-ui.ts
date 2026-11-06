// Isolated UI fixture: real RolesPage + role-settings IPC, synthetic group roster.
// Run after `bun run build`: bun test/fixtures/private-reply-ui.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const dir = mkdtempSync(join(tmpdir(), 'botmux-private-reply-ui-'));
process.env.SESSION_DATA_DIR = dir;
process.env.BOTS_CONFIG = join(dir, 'bots.json');
const { config } = await import('../../src/config.js');
config.session.dataDir = dir;
const { setLarkAppId, startIpcServer } = await import('../../src/core/dashboard-ipc-server.js');
const appId = 'cli_private_demo';
setLarkAppId(appId);
const ipc = await startIpcServer({ host: '127.0.0.1', port: 0 });
const upstream = `http://127.0.0.1:${ipc.port}`;
const bundle = await build({
  stdin: { contents: "import { renderRolesPage } from './src/dashboard/web/roles-page'; renderRolesPage(document.querySelector('main'));", resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
});
const bot = { larkAppId: appId, botName: '测试机器人' };
const chats = ['a', 'b'].map(id => ({ chatId: `oc_private_demo_${id}`, name: `测试群 ${id.toUpperCase()}`, memberBots: [{ ...bot, inChat: true, hasRole: false }] }));
const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Botmux 群私聊回复测试</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/design-tokens.css"><body><main></main><script type="module" src="/fixture.js"></script></body></html>';
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.UI_PORT || 18792), async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
  if (path === '/fixture.js') return new Response(bundle.outputFiles[0].contents, { headers: { 'content-type': 'text/javascript' } });
  if (['/style.css', '/design-tokens.css'].includes(path)) return new Response(Bun.file(`src/dashboard/web${path}`));
  if (path === '/api/groups') return Response.json({ bots: [bot], chats });
  if (path === '/api/role-profiles') return Response.json({ profiles: [] });
  if (path.endsWith('/members-display')) return Response.json({ members: [] });
  if (path === '/api/roles/batch') {
    const body = await req.json();
    const result = await fetch(`${upstream}/api/roles/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatIds: body.targets.map((t: { chatId: string }) => t.chatId) }) });
    return new Response(await result.text(), { status: result.status, headers: { 'content-type': 'application/json' } });
  }
  const match = path.match(/^\/api\/(roles|message-listeners)\/cli_private_demo\/(oc_private_demo_[ab])$/);
  if (match) {
    const result = await fetch(`${upstream}/api/${match[1]}/${match[2]}`, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'PUT' ? { body: await req.text() } : {}) });
    return new Response(await result.text(), { status: result.status, headers: { 'content-type': 'application/json' } });
  }
  return new Response('Not found', { status: 404 });
} });
console.log(`http://127.0.0.1:${server.port}/#/roles?chatId=oc_private_demo_a&botId=${appId}`);
async function stop() { server.stop(true); await ipc.close(); rmSync(dir, { recursive: true, force: true }); process.exit(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
