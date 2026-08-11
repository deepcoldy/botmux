import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

describe('central dashboard preview wiring', () => {
  it('mounts the shared HTTP/WS proxy and reuses positive owner resolution', () => {
    expect(dashboardSource).toContain('createSessionPreviewProxy({');
    expect(dashboardSource).toContain('resolve: resolveDashboardSessionPreview');
    expect(dashboardSource).toContain('await sessionPreviewProxy.handleHttp(req, res, url)');
    expect(dashboardSource).toContain('sessionPreviewProxy.handleUpgrade(req, clientSocket, head)');
  });

  it('projects internal targets out of both REST snapshots and SSE events', () => {
    expect(dashboardSource).toContain('projectSessionPreviewsForBrowser(sessions)');
    expect(dashboardSource).toContain('projectSessionPreviewEventForBrowser(ev.type, ev.body)');
    expect(dashboardSource).toContain("url.pathname.match(/^\\/api\\/sessions\\/([^/]+)\\/preview$/)");
  });
});
