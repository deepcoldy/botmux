import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ONCALL_SIDEBAR_PATH_PREFIX, parseOncallSidebarPath } from '../core/host-capability-link.js';
import { OncallFormStore } from '../services/oncall-form-store.js';
import type { OncallGroupPolicy } from '../services/oncall-group-policy.js';
import { ensureSelectedOncallQuery, nativeSelectionSourceType, oncallSidebarPage, oncallSidebarSource } from '../services/oncall-sidebar-link.js';
import { readOncallDeploymentEnv } from '../services/oncall-deployment-config.js';

export function handleOncallSidebar(req: IncomingMessage, res: ServerResponse, url: URL, dataDir: string,
  readPolicy: (appId: string) => OncallGroupPolicy | undefined): boolean | Promise<boolean> {
  if (!url.pathname.startsWith(ONCALL_SIDEBAR_PATH_PREFIX)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const configured = readOncallDeploymentEnv().ONCALL_SIDEBAR_LOGIN_ORIGINS?.trim();
  const entry = parseOncallSidebarPath(url.pathname);
  const forms = new OncallFormStore(dataDir);
  if (configured && req.method === 'POST' && req.headers?.['x-oncall-flow']) {
    const flowId = req.headers['x-oncall-flow'];
    const openChatId = req.headers['x-oncall-chat'];
    if (!entry || url.search || typeof flowId !== 'string' || !/^[1-9]\d{0,15}$/.test(flowId)
      || !Number.isSafeInteger(Number(flowId)) || typeof openChatId !== 'string' || !/^oc_[a-zA-Z0-9]{1,100}$/.test(openChatId)) {
      res.writeHead(400).end();
      return true;
    }
    return forms.recordSidebarReceipt(entry.appId, entry.id, entry.token, { flowId, openChatId }, readPolicy)
      .then(saved => { res.writeHead(saved ? 204 : 409).end(); return true; });
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: configured ? 'GET, POST' : 'GET' }).end();
    return true;
  }
  const link = entry && !url.search && forms.readNativeSidebarLink(entry.appId, entry.id, entry.token, readPolicy);
  const page = link && entry && oncallSidebarPage(link, entry.id);
  if (!page) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('表单入口已失效，请从最新的飞书卡片重新打开。');
    return true;
  }

  const channel = nativeSelectionSourceType(page.searchParams.get('bm_form'));
  if (channel) page.searchParams.set('bizFrom', channel);
  ensureSelectedOncallQuery(page);
  if (!configured) {
    res.writeHead(302, { Location: page.href }).end();
    return true;
  }
  const origins = configured.split(/[,\s]+/);
  if (!origins.every(origin => URL.canParse(origin) && new URL(origin).protocol === 'https:' && new URL(origin).origin === origin
    && !origin.includes('*'))) {
    res.writeHead(500).end('Oncall 侧栏登录域名配置无效');
    return true;
  }

  const nonce = randomBytes(16).toString('base64');
  const entryData = JSON.stringify({ href: page.href, origin: page.origin, source: oncallSidebarSource(page) }).replaceAll('<', '\\u003c');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-src ${[page.origin, ...origins].join(' ')}; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
  }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>人工 Oncall</title><style nonce="${nonce}">body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style>
<iframe id="form" title="Oncall 原生表单" referrerpolicy="no-referrer"></iframe>
<script nonce="${nonce}">
const form = document.getElementById('form');
const entry = ${entryData};
window.addEventListener('message', async event => {
  if (event.origin !== entry.origin || event.source !== form.contentWindow) return;
  if (event.data?.eventName === 'getParentUrl') {
    form.contentWindow.postMessage({ url: entry.source }, entry.origin);
    return;
  }
  if (event.data?.eventName !== 'launch-oncall-success') return;
  const result = event.data.data;
  if (!result?.oncallFlowId || !result.openChatId) return;
  const headers = { 'X-Oncall-Flow': String(result.oncallFlowId), 'X-Oncall-Chat': result.openChatId };
  for (const delay of [0, 500, 2000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(location.pathname, { method: 'POST', headers, keepalive: true });
      if (response.ok || response.status < 500) return;
    } catch {}
  }
});
form.src = entry.href;
</script></html>`);
  return true;
}
