import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ONCALL_SIDEBAR_PATH_PREFIX, parseOncallSidebarPath } from '../core/host-capability-link.js';
import { OncallFormStore } from '../services/oncall-form-store.js';
import type { OncallGroupPolicy } from '../services/oncall-group-policy.js';
import { oncallSidebarPage, oncallSidebarSource } from '../services/oncall-sidebar-link.js';

export function handleOncallSidebar(req: IncomingMessage, res: ServerResponse, url: URL, dataDir: string,
  readPolicy: (appId: string) => OncallGroupPolicy | undefined): boolean {
  if (!url.pathname.startsWith(ONCALL_SIDEBAR_PATH_PREFIX)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' }).end();
    return true;
  }
  const entry = parseOncallSidebarPath(url.pathname);
  const link = entry && !url.search && new OncallFormStore(dataDir).readNativeSidebarLink(entry.appId, entry.id, entry.token, readPolicy);
  const page = link && entry && oncallSidebarPage(link, entry.id);
  if (!page) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('表单入口已失效，请从最新的飞书卡片重新打开。');
    return true;
  }

  // Oncall prefers the parent's reply and truncates the source address. Send
  // only the URL components used by reconciliation, without the question text.
  const nonce = randomBytes(16).toString('base64');
  const payload = JSON.stringify({ frameUrl: page.href, origin: page.origin, source: oncallSidebarSource(page) }).replaceAll('<', '\\u003c');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-src ${page.origin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
  }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>人工 Oncall</title>
<style nonce="${nonce}">body{margin:0}iframe{display:block;border:0;width:100%;height:100vh}</style>
<iframe title="Oncall 原生表单" id="oncall-form" referrerpolicy="no-referrer"></iframe>
<script nonce="${nonce}">
const entry = ${payload};
const frame = document.getElementById('oncall-form');
window.addEventListener('message', event => {
  if (event.origin === entry.origin && event.source === frame.contentWindow && event.data?.eventName === 'getParentUrl') {
    frame.contentWindow.postMessage({ url: entry.source }, entry.origin);
  }
});
frame.src = entry.frameUrl;
</script></html>`);
  return true;
}
