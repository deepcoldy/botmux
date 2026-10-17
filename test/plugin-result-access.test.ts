import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginResultArtifactStore } from '../src/core/plugins/mcp/result-artifact-store.js';
import { handlePluginResultAccess } from '../src/dashboard/plugin-result-access.js';
import { resolvePluginResultViewerIdentity } from '../src/dashboard/plugin-result-access.js';
import { DashboardSessionStore } from '../src/dashboard/h5-auth.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('controlled plugin result page', () => {
  it('drops query parameters from unauthenticated login return paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-result-login-return-'));
    roots.push(root);
    const store = new PluginResultArtifactStore({ dataDir: root });
    let returnTo = '';
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handlePluginResultAccess(req, res, url, {
        store,
        identity: () => null,
        loginUrl: value => {
          returnTo = value;
          return `/login?next=${encodeURIComponent(value)}`;
        },
      })) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/plugin-result-access/${'a'.repeat(20)}?x=1`,
        { redirect: 'manual' },
      );
      expect(response.status).toBe(302);
      expect(returnTo).toBe(`/plugin-result-access/${'a'.repeat(20)}`);
      expect(response.headers.get('location')).not.toContain('x%3D1');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('retains the cross-app stable principal in an H5 session', () => {
    const sessions = new DashboardSessionStore({ randomToken: () => 'a'.repeat(43) });
    const created = sessions.create('ou_requester', 'on_owner123');
    expect(sessions.resolveToken(created.token)?.unionId).toBe('on_owner123');
  });

  it('uses the actual H5 union id in the Dashboard wiring for both owner access and cross-user denial', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-result-h5-wiring-'));
    roots.push(root);
    const store = new PluginResultArtifactStore({ dataDir: root });
    const artifact = store.create({
      pluginId: 'reference-reporter',
      delivery: { schemaVersion: 1, deliveryId: 'delivery_h5_wiring_20261016', markdown: 'PRIVATE_SENTINEL' },
      ownerUnionId: 'on_owner123', larkAppId: 'cli_fixture', sessionId: 'session_fixture', turnId: 'om_fixture',
    });
    const tokens = ['b'.repeat(43), 'c'.repeat(43)];
    const sessions = new DashboardSessionStore({ randomToken: () => tokens.shift()! });
    const owner = sessions.create('ou_owner', 'on_owner123', true);
    const other = sessions.create('ou_other', 'on_other123', true);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handlePluginResultAccess(req, res, url, {
        store,
        identity: request => resolvePluginResultViewerIdentity(
          null,
          sessions.resolveToken(String(request.headers['x-test-h5-token'] ?? '')),
        ),
      })) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    try {
      const origin = `http://127.0.0.1:${address.port}`;
      const redeemed = await fetch(`${origin}/plugin-result-access/${artifact.viewToken}`, {
        headers: { 'x-test-h5-token': owner.token }, redirect: 'manual',
      });
      expect(redeemed.status).toBe(303);
      expect(redeemed.headers.get('location')).toBe(`/plugin-results/${artifact.viewId}`);

      const page = await fetch(`${origin}/plugin-results/${artifact.viewId}`, {
        headers: { 'x-test-h5-token': owner.token },
      });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('PRIVATE_SENTINEL');

      const crossUser = await fetch(`${origin}/plugin-result-access/${artifact.viewToken}`, {
        headers: { 'x-test-h5-token': other.token }, redirect: 'manual',
      });
      expect(crossUser.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }

    const dashboardSource = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(dashboardSource).toContain(`return resolvePluginResultViewerIdentity(
          dashboardRequestIdentity(req),
          dashboardH5Auth.resolve(req),
        );`);
  });

  it('requires the bound principal, permits owner revisits, and keeps result bytes out of redirects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-result-page-'));
    roots.push(root);
    const store = new PluginResultArtifactStore({ dataDir: root });
    const artifact = store.create({
      pluginId: 'reference-reporter',
      delivery: { schemaVersion: 1, deliveryId: 'delivery_reference_20261016', markdown: 'PRIVATE_SENTINEL' },
      ownerUnionId: 'on_owner123', larkAppId: 'cli_fixture', sessionId: 'session_fixture', turnId: 'om_fixture',
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handlePluginResultAccess(req, res, url, {
        store,
        identity: request => ({ principalUnionId: String(request.headers['x-test-union-id'] ?? '') || undefined }),
      })) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const preview = await fetch(`${origin}/plugin-result-access/${artifact.viewToken}`, {
        method: 'HEAD', headers: { 'x-test-union-id': 'on_owner123' }, redirect: 'manual',
      });
      expect(preview.status).toBe(405);

      const forwarded = await fetch(`${origin}/plugin-result-access/${artifact.viewToken}`, {
        headers: { 'x-test-union-id': 'on_other123' }, redirect: 'manual',
      });
      expect(forwarded.status).toBe(403);

      const redeemed = await fetch(`${origin}/plugin-result-access/${artifact.viewToken}`, {
        headers: { 'x-test-union-id': 'on_owner123' }, redirect: 'manual',
      });
      expect(redeemed.status).toBe(303);
      expect(redeemed.headers.get('location')).toBe(`/plugin-results/${artifact.viewId}`);
      expect(redeemed.headers.get('location')).not.toContain('PRIVATE_SENTINEL');

      const revisit = await fetch(`${origin}/plugin-result-access/${artifact.viewToken}`, {
        headers: { 'x-test-union-id': 'on_owner123' }, redirect: 'manual',
      });
      expect(revisit.status).toBe(303);
      expect(revisit.headers.get('location')).toBe(`/plugin-results/${artifact.viewId}`);

      const page = await fetch(`${origin}/plugin-results/${artifact.viewId}`, {
        headers: { 'x-test-union-id': 'on_owner123' },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await page.text()).toContain('PRIVATE_SENTINEL');

      const crossUserPage = await fetch(`${origin}/plugin-results/${artifact.viewId}`, {
        headers: { 'x-test-union-id': 'on_other123' },
      });
      expect(crossUserPage.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
