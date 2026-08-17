import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_CONTENT_SEGMENT } from '../src/core/session-preview.js';
import {
  createPreviewGuardPage,
  previewGuardHtml,
} from '../src/dashboard/preview-guard-page.js';
import { PREVIEW_SANDBOX_TOKENS } from '../src/dashboard/preview-proxy.js';
import {
  PREVIEW_DEFAULT_MODE_LABEL,
  PREVIEW_OVERLAY_SECURITY_NOTICE,
} from '../src/dashboard/preview-interaction.js';

const CAPABILITY = 'bmxpv1.capability-payload.capability-signature';
let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function start(authenticated: boolean, mintable = true): Promise<string> {
  const guard = createPreviewGuardPage({
    authenticated: () => authenticated,
    resolve: sessionId => sessionId === 's1'
      ? { ok: true, target: { host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z' } }
      : { ok: false, status: 404, error: 'unknown_session' },
    mintContentCapability: () => (mintable
      ? { token: CAPABILITY, expiresAt: Date.now() + 60_000 }
      : null),
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
    const html = previewGuardHtml('s1', { token: CAPABILITY, expiresAt: Date.now() + 60_000 });
    expect(html).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect(html).toContain(PREVIEW_OVERLAY_SECURITY_NOTICE);
    expect(html).toContain('解锁交互（15 分钟无操作后回锁）');
    expect(html).toContain(`/preview/s1/${PREVIEW_CONTENT_SEGMENT}/${CAPABILITY}/`);
    expect(html).toContain('/api/sessions/s1/preview-interaction');
    expect(html).toContain("request('/unlock','POST')");
    expect(html).toContain("request('/activity','POST')");
    expect(html).toContain("request('/lock','POST')");
    expect(html).toContain("setInterval(function(){if(!document.hidden)request('', 'GET')");
    expect(html).not.toMatch(/[?&](?:t|token|viewToken)=/);
  });

  it('P0: frames the agent app as an opaque origin and never reaches into its document', () => {
    const html = previewGuardHtml('s1', { token: CAPABILITY, expiresAt: Date.now() + 60_000 });
    const iframe = html.match(/<iframe[^>]*id="app"[^>]*>/)?.[0] ?? '';
    expect(iframe).toContain(`sandbox="${PREVIEW_SANDBOX_TOKENS}"`);
    // The single flag that would undo the whole boundary: with it the framed
    // agent page is back on the dashboard origin and can read the DOM, call
    // /api/* with the owner cookie and open a debug terminal.
    expect(iframe).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX_TOKENS.split(' ')).not.toContain('allow-same-origin');
    // No shell code may depend on same-origin access to the frame.
    expect(html).not.toContain('contentWindow');
    expect(html).not.toContain('contentDocument');
    // Idle refresh now rides on a host-side focus signal instead.
    expect(html).toContain("window.addEventListener('blur'");
    expect(html).toContain('document.activeElement===frame');
  });

  it('re-mints before the content capability expires instead of dying silently', () => {
    const now = 1_760_000_000_000;
    const html = previewGuardHtml('s1', { token: CAPABILITY, expiresAt: now + 600_000 }, now);
    expect(html).toContain('if(570000>0)setTimeout(function(){location.reload()},570000)');

    const expiring = previewGuardHtml('s1', { token: CAPABILITY, expiresAt: now + 1_000 }, now);
    expect(expiring).toContain('if(0>0)');
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
    const body = await allowed.text();
    expect(body).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect(body).toContain(`sandbox="${PREVIEW_SANDBOX_TOKENS}"`);
    const noSlash = await fetch(`${allowedBase}/preview/s1`);
    expect(noSlash.status).toBe(200);
    expect(await noSlash.text()).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect((await fetch(`${allowedBase}/preview/unknown/`)).status).toBe(404);
    // The sandboxed content stream lives under the reserved segment and is
    // left entirely to the hardened preview proxy mounted immediately after.
    expect((await fetch(`${allowedBase}/preview/s1/${PREVIEW_CONTENT_SEGMENT}/${CAPABILITY}/`)).status).toBe(404);
  });

  it('fails closed when no content capability can be minted', async () => {
    const base = await start(true, false);
    const response = await fetch(`${base}/preview/s1/`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'preview_capability_unavailable' });
  });
});
