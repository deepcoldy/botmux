import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCompatManifest, handleDesktopCompat } from '../../src/dashboard/compat.js';

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = null;
});

describe('dashboard desktop compat manifest', () => {
  it('builds the stable v1 manifest shape', () => {
    expect(buildCompatManifest({ runtimeVersion: '2.95.0' })).toEqual({
      schemaVersion: 1,
      product: 'botmux',
      runtimeVersion: '2.95.0',
      dashboardProtocolVersion: 1,
      desktopShell: { supported: true },
      features: ['desktop-shell', 'dashboard-protocol-v1'],
      routes: ['#/', '#/sessions', '#/workflows', '#/groups', '#/schedules', '#/settings'],
    });
  });

  it('serves GET /__desktop/compat as read-only JSON', async () => {
    const started = await startCompatServer();

    const compat = await fetch(`${started.baseUrl}/__desktop/compat`);
    expect(compat.status).toBe(200);
    expect(compat.headers.get('content-type')).toContain('application/json');
    expect(await compat.json()).toMatchObject({
      schemaVersion: 1,
      product: 'botmux',
      dashboardProtocolVersion: 1,
      desktopShell: { supported: true },
    });

    const post = await fetch(`${started.baseUrl}/__desktop/compat`, { method: 'POST' });
    expect(post.status).toBe(404);
  });

  it('uses the shared dashboard HTTP helper instead of the removed workflow module', () => {
    const compatSource = readFileSync(new URL('../../src/dashboard/compat.ts', import.meta.url), 'utf8');
    expect(compatSource).toContain("from './http.js'");
    expect(compatSource).not.toContain('./workflow-api.js');
  });
});

async function startCompatServer(): Promise<{ baseUrl: string }> {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (handleDesktopCompat(req, res, url)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('server did not bind');
  return { baseUrl: `http://127.0.0.1:${addr.port}` };
}
