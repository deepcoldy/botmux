// node --import tsx test/fixtures/auto-start-exclusions/serve.mjs
// Isolated browser fixture: real component/CSS and real IPC persistence, no Lark connection.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'botmux-exclusions-ui-'));
process.env.BOTS_CONFIG = join(scratch, 'bots.json');
process.env.SESSION_DATA_DIR = join(scratch, 'sessions');
writeFileSync(process.env.BOTS_CONFIG, JSON.stringify([{ larkAppId: 'app_visual_test', larkAppSecret: 'test-only', cliId: 'claude-code', autoStartOnGroupJoin: true, autoStartOnNewTopic: true, autoInviteOwnerOnGroupAdd: false }]));
const { loadBotConfigs, registerBot } = await import('../../../src/bot-registry.ts');
const { setLarkAppId, startIpcServer } = await import('../../../src/core/dashboard-ipc-server.ts');
loadBotConfigs().forEach(registerBot);
setLarkAppId('app_visual_test');
const ipc = await startIpcServer({ host: '127.0.0.1', port: 0 });
const bundle = await build({ entryPoints: [join(root, 'test/fixtures/auto-start-exclusions/page.tsx')], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic' });
const assets = {
  '/app.js': ['text/javascript', bundle.outputFiles[0].contents],
  '/style.css': ['text/css', readFileSync(join(root, 'src/dashboard/web/style.css'))],
  '/design-tokens.css': ['text/css', readFileSync(join(root, 'src/dashboard/web/design-tokens.css'))],
};
createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const upstream = request({ host: '127.0.0.1', port: ipc.port, path: req.url, method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream); return;
  }
  const asset = assets[req.url];
  res.setHeader('content-type', asset?.[0] ?? 'text/html; charset=utf-8');
  res.end(asset?.[1] ?? '<!doctype html><html lang="zh" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Botmux auto-start UI test</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/design-tokens.css"><div id="app-root"></div><script type="module" src="/app.js"></script></html>');
}).listen(18791, '127.0.0.1', () => console.log(`UI fixture: http://127.0.0.1:18791; config: ${process.env.BOTS_CONFIG}`));
