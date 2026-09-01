import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildCompatManifest,
  compatMachineIdForAuthenticatedRequest,
  handleDesktopCompat,
} from '../../src/dashboard/compat.js';

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = null;
});

describe('dashboard desktop compat manifest', () => {
  it('builds the v2 manifest while retaining the v1 compatibility fields', () => {
    const manifest = buildCompatManifest({
      runtimeVersion: '2.95.0',
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: 'botmux',
      runtimeVersion: '2.95.0',
      dashboardProtocolVersion: 2,
      desktopShell: { supported: true },
      features: expect.arrayContaining([
        'desktop-shell',
        'dashboard-protocol-v1',
        'dashboard-protocol-v2',
        'dashboard-modules',
        'dashboard-capabilities',
      ]),
      routes: expect.arrayContaining(['#/', '#/sessions', '#/groups', '#/schedules', '#/settings']),
    });
    expect(manifest.runtimeIdentity).toBeUndefined();
  });

  it('advertises granular dashboard modules and excludes workflow', () => {
    const manifest = buildCompatManifest({ runtimeVersion: '2.95.0', machineId: null });

    expect(manifest.modules).toMatchObject({
      overview: { supported: true, route: '#/' },
      sessions: { supported: true, route: '#/sessions' },
      monitoring: { supported: true, route: '#/monitoring' },
      insights: { supported: true, route: '#/insights' },
      bots: { supported: true, route: '#/bot-defaults' },
      schedules: { supported: true, route: '#/schedules' },
      settings: { supported: true, route: '#/settings' },
      workflow: { supported: false },
    });
    expect(manifest.capabilities).toMatchObject({
      'overview.read': true,
      'sessions.read': true,
      'sessions.manage': true,
      'asks.answer': true,
      'monitoring.read': true,
      'bots.configure': true,
      'schedules.manage': true,
      'settings.manage': true,
      'workflow.read': false,
      'workflow.manage': false,
    });
    expect(manifest.routes).not.toContain('#/workflows');
    expect(manifest.routes).toEqual(
      Object.values(manifest.modules)
        .filter(module => module.supported && module.route)
        .map(module => module.route),
    );
  });

  it('only exposes a machine identity when a reliable id is supplied', () => {
    expect(buildCompatManifest({
      runtimeVersion: '2.95.0',
      machineId: '  machine-123  ',
    }).runtimeIdentity).toEqual({
      source: 'platform-binding',
      machineId: 'machine-123',
    });

    expect(buildCompatManifest({
      runtimeVersion: '2.95.0',
      machineId: '   ',
    }).runtimeIdentity).toBeUndefined();
  });

  it('only releases the bound machine identity to the active dashboard token', () => {
    expect(compatMachineIdForAuthenticatedRequest(
      'active-token',
      'active-token',
      ' machine-123 ',
    )).toBe('machine-123');
    expect(compatMachineIdForAuthenticatedRequest(
      undefined,
      'active-token',
      'machine-123',
    )).toBeNull();
    expect(compatMachineIdForAuthenticatedRequest(
      'stale-token',
      'active-token',
      'machine-123',
    )).toBeNull();
    expect(compatMachineIdForAuthenticatedRequest(
      'active-token',
      undefined,
      'machine-123',
    )).toBeNull();
  });

  it('serves GET /__desktop/compat as read-only JSON', async () => {
    const started = await startCompatServer();

    const compat = await fetch(`${started.baseUrl}/__desktop/compat`);
    expect(compat.status).toBe(200);
    expect(compat.headers.get('content-type')).toContain('application/json');
    expect(await compat.json()).toMatchObject({
      schemaVersion: 1,
      product: 'botmux',
      dashboardProtocolVersion: 2,
      desktopShell: { supported: true },
      modules: {
        workflow: { supported: false },
      },
      capabilities: {
        'workflow.read': false,
        'workflow.manage': false,
      },
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
