import type { IncomingMessage, ServerResponse } from 'node:http';
import { ONCALL_SIDEBAR_PATH_PREFIX, parseOncallSidebarPath } from '../core/host-capability-link.js';
import { OncallFormStore } from '../services/oncall-form-store.js';
import type { OncallGroupPolicy } from '../services/oncall-group-policy.js';
import { ensureSelectedOncallQuery, nativeSelectionSourceType, oncallSidebarPage } from '../services/oncall-sidebar-link.js';

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

  // Upgrade already published capabilities too. Keep SSO in the top-level
  // sidebar and preserve all of the platform's original form parameters.
  const channel = nativeSelectionSourceType(page.searchParams.get('bm_form'));
  if (channel) page.searchParams.set('bizFrom', channel);
  ensureSelectedOncallQuery(page);
  res.writeHead(302, { Location: page.href }).end();
  return true;
}
