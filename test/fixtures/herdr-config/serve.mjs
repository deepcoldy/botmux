// node --import tsx test/fixtures/herdr-config/serve.mjs
// Isolated browser fixture: real HerdrConfigSection/CSS and real IPC persistence, no Lark connection.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'botmux-herdr-ui-'));
process.env.BOTS_CONFIG = join(scratch, 'bots.json');
process.env.SESSION_DATA_DIR = join(scratch, 'sessions');
writeFileSync(process.env.BOTS_CONFIG, JSON.stringify([{
  larkAppId: 'cli_synthetic_demo',
  larkAppSecret: 'synthetic-secret',
  cliId: 'claude-code',
  displayName: '示例机器人',
  backendType: 'herdr',
  herdr: { sessionName: 'default', placement: 'split', workspace: '', tab: '3 评审', splitDirection: 'right', chatTypes: ['group'] },
}], null, 2));
const { loadBotConfigs, registerBot } = await import('../../../src/bot-registry.ts');
const { setLarkAppId, startIpcServer } = await import('../../../src/core/dashboard-ipc-server.ts');
loadBotConfigs().forEach(registerBot);
setLarkAppId('cli_synthetic_demo');
const ipc = await startIpcServer({ host: '127.0.0.1', port: 0 });
const bundle = await build({ entryPoints: [join(root, 'test/fixtures/herdr-config/page.tsx')], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic' });
const assets = {
  '/app.js': ['text/javascript', bundle.outputFiles[0].contents],
  '/style.css': ['text/css', readFileSync(join(root, 'src/dashboard/web/style.css'))],
  '/design-tokens.css': ['text/css', readFileSync(join(root, 'src/dashboard/web/design-tokens.css'))],
};
createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    // 静态服务器同时充当 dashboard 的 daemon-proxy：把 /api/bots/:appId/<segment>
    // 改写成 daemon 的 /api/bot-<segment>（与 daemon-proxy-routes putBotConfig 同形），
    // 只处理末段单段路由，子资源（如 chats/:id/feedback）路径保持原样。
    let path = req.url;
    const m = req.method === 'PUT' ? path.match(/^(\/api\/bots\/)[^/]+\/([^/?]+)(\?.*)?$/) : null;
    if (m) path = `/api/bot-${m[2]}${m[3] ?? ''}`;
    const upstream = request({ host: '127.0.0.1', port: ipc.port, path, method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream); return;
  }
  const theme = req.url.startsWith('/?theme=light') ? 'light' : 'dark';
  const asset = assets[req.url.split('?')[0]];
  res.setHeader('content-type', asset?.[0] ?? 'text/html; charset=utf-8');
  res.end(asset?.[1] ?? `<!doctype html><html lang="zh" data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Botmux herdr UI test</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/design-tokens.css"><div id="app-root"></div><script type="module" src="/app.js"></script></html>`);
}).listen(18792, '127.0.0.1', () => console.log(`UI fixture: http://127.0.0.1:18792 (dark) / ?theme=light; config: ${process.env.BOTS_CONFIG}`));
