import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPreviewLoopbackHost,
  isPreviewPort,
  probeSessionPreviewTarget,
  safeSessionPreviewTarget,
  sessionPreviewDescriptor,
  sessionPreviewPath,
} from '../src/core/session-preview.js';
import {
  projectSessionPreviewEventForBrowser,
  projectSessionPreviewForBrowser,
  resolveSessionPreviewFromRow,
} from '../src/dashboard/preview-contract.js';
import {
  redactSessionEventForPublic,
  redactSessionsForPublic,
} from '../src/dashboard/public-redact.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

describe('session preview target validation', () => {
  it('accepts only TCP ports and literal loopback addresses', () => {
    expect(isPreviewPort(1)).toBe(true);
    expect(isPreviewPort(65_535)).toBe(true);
    for (const value of [0, 65_536, -1, 1.5, '3000', NaN]) {
      expect(isPreviewPort(value), String(value)).toBe(false);
    }
    expect(isPreviewLoopbackHost('127.0.0.1')).toBe(true);
    expect(isPreviewLoopbackHost('::1')).toBe(true);
    for (const value of ['localhost', '0.0.0.0', '10.0.0.8', '169.254.169.254', 'example.com']) {
      expect(isPreviewLoopbackHost(value), value).toBe(false);
    }
  });

  it('probes a reachable IPv4 loopback service before producing a target', async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const target = await probeSessionPreviewTarget({
      port,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });

    expect(target).toEqual({
      host: '127.0.0.1',
      port,
      registeredAt: '2026-08-11T12:00:00.000Z',
    });
  });

  it('fails closed for an unreachable port', async () => {
    server = createServer();
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;

    await expect(probeSessionPreviewTarget({ port, timeoutMs: 100 })).resolves.toBeUndefined();
  });

  it('rejects malformed/remote persisted targets at the use boundary', () => {
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z', extra: 'ignored',
    })).toEqual({ host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z' });
    expect(safeSessionPreviewTarget({
      host: '169.254.169.254', port: 80, registeredAt: '2026-08-11T12:00:00.000Z',
    })).toBeUndefined();
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 0, registeredAt: '2026-08-11T12:00:00.000Z',
    })).toBeUndefined();
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 3000, registeredAt: 'August 11, 2026',
    })).toBeUndefined();
  });
});

describe('session preview REST/SSE contract', () => {
  const previewTarget = {
    host: '127.0.0.1',
    port: 4173,
    registeredAt: '2026-08-11T12:00:00.000Z',
  } as const;

  it('projects the internal target to a same-origin descriptor with no host, port, or credential', () => {
    const projected = projectSessionPreviewForBrowser({
      sessionId: 'session-a',
      larkAppId: 'app-a',
      previewTarget,
    }) as Record<string, unknown>;

    expect(projected).toEqual({
      sessionId: 'session-a',
      larkAppId: 'app-a',
      preview: {
        path: '/preview/session-a/',
        registeredAt: previewTarget.registeredAt,
      },
    });
    const json = JSON.stringify(projected);
    for (const forbidden of ['127.0.0.1', '4173', 'previewTarget', 'token', 'secret', 'credential']) {
      expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(sessionPreviewPath('session-a')).toBe('/preview/session-a/');
    expect(sessionPreviewDescriptor('session-a', previewTarget)).toEqual(projected.preview);
  });

  it('uses the same projection for spawned/update SSE and clears stale previews with null', () => {
    const spawned = projectSessionPreviewEventForBrowser('session.spawned', {
      session: { sessionId: 's1', previewTarget },
    }) as any;
    expect(spawned.session.preview.path).toBe('/preview/s1/');
    expect(spawned.session).not.toHaveProperty('previewTarget');

    const update = projectSessionPreviewEventForBrowser('session.update', {
      sessionId: 's1', patch: { previewTarget, unrelated: true },
    }) as any;
    expect(update).toEqual({
      sessionId: 's1',
      patch: {
        unrelated: true,
        preview: { path: '/preview/s1/', registeredAt: previewTarget.registeredAt },
      },
    });
    const cleared = projectSessionPreviewEventForBrowser('session.update', {
      sessionId: 's1', patch: { previewTarget: null },
    }) as any;
    expect(cleared.patch).toEqual({ preview: null });

    const injected = projectSessionPreviewEventForBrowser('session.update', {
      sessionId: 's1', patch: { preview: { path: 'javascript:alert(1)' }, unrelated: true },
    }) as any;
    expect(injected.patch).toEqual({ unrelated: true });
  });

  it('removes preview metadata from anonymous REST and SSE', () => {
    const browserRow = projectSessionPreviewForBrowser({ sessionId: 's1', previewTarget }) as any;
    const rest = redactSessionsForPublic([browserRow]) as any[];
    expect(rest[0]).not.toHaveProperty('preview');
    expect(rest[0]).not.toHaveProperty('previewTarget');

    const browserEvent = projectSessionPreviewEventForBrowser('session.update', {
      sessionId: 's1', patch: { previewTarget },
    });
    const sse = redactSessionEventForPublic('session.update', browserEvent) as any;
    expect(sse.patch).not.toHaveProperty('preview');
    expect(JSON.stringify(sse)).not.toContain('4173');
  });
});

describe('session preview ownership resolution', () => {
  const target = { host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z' } as const;

  it('requires exact session and owning daemon identity', () => {
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's1', larkAppId: 'app-a', status: 'idle', previewTarget: target },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toEqual({ ok: true, target });
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's2', larkAppId: 'app-a', status: 'idle', previewTarget: target },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toMatchObject({ ok: false, status: 404, error: 'session_owner_mismatch' });
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's1', larkAppId: 'app-b', status: 'idle', previewTarget: target },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toMatchObject({ ok: false, status: 404, error: 'session_owner_mismatch' });
  });

  it('rejects closed, unregistered, and attacker-shaped remote targets explicitly', () => {
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's1', larkAppId: 'app-a', status: 'closed', previewTarget: target },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toMatchObject({ ok: false, status: 409, error: 'session_not_active' });
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's1', larkAppId: 'app-a', status: 'idle' },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toMatchObject({ ok: false, status: 404, error: 'preview_not_registered' });
    expect(resolveSessionPreviewFromRow({
      row: {
        sessionId: 's1', larkAppId: 'app-a', status: 'idle',
        previewTarget: { host: '169.254.169.254', port: 80, registeredAt: target.registeredAt },
      },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toMatchObject({ ok: false, status: 403, error: 'remote_host_forbidden' });
    expect(resolveSessionPreviewFromRow({
      row: {
        sessionId: 's1', larkAppId: 'app-a', status: 'idle',
        previewTarget: { host: '127.0.0.1', port: 0, registeredAt: target.registeredAt },
      },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toMatchObject({ ok: false, status: 409, error: 'invalid_preview_target' });
  });
});
