import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_CONTENT_QUERY } from '../src/core/session-preview.js';
import {
  createPreviewGuardPage,
  previewGuardHtml,
} from '../src/dashboard/preview-guard-page.js';
import {
  PREVIEW_DEFAULT_MODE_LABEL,
  PREVIEW_OVERLAY_SECURITY_NOTICE,
} from '../src/dashboard/preview-interaction.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function start(authenticated: boolean): Promise<string> {
  const guard = createPreviewGuardPage({
    authenticated: () => authenticated,
    resolve: sessionId => sessionId === 's1'
      ? { ok: true, target: { host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z' } }
      : { ok: false, status: 404, error: 'unknown_session' },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    if (!guard.handle(req, res, url)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('guarded web preview shell', () => {
  it('renders the app in visibly labelled preview mode with explicit unlock and exact safety copy', () => {
    const html = previewGuardHtml('s1');
    expect(html).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect(html).toContain(PREVIEW_OVERLAY_SECURITY_NOTICE);
    expect(html).toContain('解锁交互（15 分钟无操作后回锁）');
    expect(html).toContain(`/preview/s1/?${PREVIEW_CONTENT_QUERY}=1`);
    expect(html).toContain('/api/sessions/s1/preview-interaction');
    expect(html).toContain("request('/unlock','POST')");
    expect(html).toContain("request('/activity','POST')");
    expect(html).toContain("request('/lock','POST')");
    expect(html).toContain("setInterval(function(){if(!document.hidden)request('', 'GET')");
    expect(html).toContain('activityDocument===doc');
    expect(html).not.toMatch(/[?&](?:t|token|viewToken)=/);
  });

  it('serves only an authenticated exact descriptor root; unauthorized users get no app shell', async () => {
    const deniedBase = await start(false);
    const denied = await fetch(`${deniedBase}/preview/s1/`);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ ok: false, error: 'authentication_required' });
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;

    const allowedBase = await start(true);
    const allowed = await fetch(`${allowedBase}/preview/s1/`);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-security-policy')).toContain('https://*.feishu.cn');
    expect(allowed.headers.get('content-security-policy')).toContain('https://*.larksuite.com');
    expect(await allowed.text()).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    const noSlash = await fetch(`${allowedBase}/preview/s1`);
    expect(noSlash.status).toBe(200);
    expect(await noSlash.text()).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect((await fetch(`${allowedBase}/preview/unknown/`)).status).toBe(404);
    // Reserved iframe content requests deliberately bypass the shell and are
    // left for the hardened preview proxy mounted immediately afterwards.
    expect((await fetch(`${allowedBase}/preview/s1/?${PREVIEW_CONTENT_QUERY}=1`)).status).toBe(404);
  });
});
