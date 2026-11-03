import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardAuthIdentity } from './h5-auth.js';
import type { DashboardRequestIdentity } from './request-identity.js';

import {
  PluginResultArtifactStore,
  type PluginResultArtifactManifest,
} from '../core/plugins/mcp/result-artifact-store.js';

const TOKEN_ROUTE = /^\/plugin-result-access\/([A-Za-z0-9_-]{20,256})$/;
const VIEW_ROUTE = /^\/plugin-results\/([A-Za-z0-9_-]{20,256})$/;
const FILE_ROUTE = /^\/plugin-results\/([A-Za-z0-9_-]{20,256})\/files\/(\d{1,4})$/;

export interface PluginResultViewerIdentity {
  principalUnionId?: string;
}

/** One identity projection shared by the production Dashboard wiring and tests. */
export function resolvePluginResultViewerIdentity(
  dashboardIdentity: DashboardRequestIdentity | null,
  h5Identity: DashboardAuthIdentity | null,
): PluginResultViewerIdentity | null {
  if (dashboardIdentity?.principalUnionId) return { principalUnionId: dashboardIdentity.principalUnionId };
  return h5Identity?.unionId ? { principalUnionId: h5Identity.unionId } : null;
}

export interface PluginResultAccessDependencies {
  store: PluginResultArtifactStore;
  identity(req: IncomingMessage): PluginResultViewerIdentity | null;
  loginUrl?(returnTo: string): string | undefined;
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function deny(res: ServerResponse, status = 403): void {
  res.writeHead(status, securityHeaders('text/html; charset=utf-8'));
  res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>无法访问</title><p>结果不可用、已过期，或当前账号无权查看。</p>');
}

function requireViewer(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PluginResultAccessDependencies,
): string | null {
  const identity = deps.identity(req);
  if (identity?.principalUnionId) return identity.principalUnionId;
  if (!identity) {
    const login = deps.loginUrl?.(url.pathname);
    if (login) {
      res.writeHead(302, { location: login, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
      return null;
    }
    deny(res, 401);
    return null;
  }
  deny(res);
  return null;
}

function renderResultPage(store: PluginResultArtifactStore, manifest: PluginResultArtifactManifest): string {
  const summary = store.readSummary(manifest);
  const files = manifest.files.map((file, index) => (
    `<li><a href="/plugin-results/${encodeURIComponent(manifest.viewId)}/files/${index}">${escapeHtml(file.name)}</a> <small>${file.size} bytes</small></li>`
  )).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>查询结果</title><style>body{max-width:960px;margin:32px auto;padding:0 20px;font:15px/1.6 system-ui;color:#1f2329}main{border:1px solid #dfe1e5;border-radius:12px;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f8fa;padding:16px;border-radius:8px}a{color:#245bdb}</style></head><body><main><h1>查询结果</h1>${summary ? `<pre>${escapeHtml(summary)}</pre>` : ''}${files ? `<h2>下载文件</h2><ul>${files}</ul>` : ''}<p><small>有效期至 ${escapeHtml(new Date(manifest.expiresAt).toLocaleString('zh-CN', { hour12: false }))}</small></p></main></body></html>`;
}

export async function handlePluginResultAccess(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PluginResultAccessDependencies,
): Promise<boolean> {
  const tokenMatch = TOKEN_ROUTE.exec(url.pathname);
  const fileMatch = FILE_ROUTE.exec(url.pathname);
  const viewMatch = VIEW_ROUTE.exec(url.pathname);
  if (!tokenMatch && !fileMatch && !viewMatch) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  // Link unfurlers commonly probe with HEAD. Do not redirect previews into a
  // viewer-bound result route; only an authenticated user GET may enter it.
  if (tokenMatch && req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  const viewerUnionId = requireViewer(req, res, url, deps);
  if (!viewerUnionId) return true;
  try {
    if (tokenMatch) {
      const manifest = deps.store.redeem(tokenMatch[1], viewerUnionId);
      res.writeHead(303, {
        location: `/plugin-results/${encodeURIComponent(manifest.viewId)}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end();
      return true;
    }
    const viewId = (fileMatch ?? viewMatch)![1];
    const manifest = deps.store.resolveView(viewId, viewerUnionId);
    if (fileMatch) {
      const file = deps.store.filePath(manifest, Number(fileMatch[2]));
      res.writeHead(200, {
        ...securityHeaders('application/octet-stream'),
        'content-length': String(file.size),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file.path).pipe(res);
      return true;
    }
    const body = renderResultPage(deps.store, manifest);
    res.writeHead(200, securityHeaders('text/html; charset=utf-8'));
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    deny(res);
    return true;
  }
}
