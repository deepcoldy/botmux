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

  // 行为证据在 session-preview-ownership / -lifecycle / -close 三个套件里；这里只钉
  // 「中央 Dashboard 确实把生产依赖接到了那些函数上」这一件源码事实。
  it('re-checks listener ownership on every hop and tears the session down when it changes', () => {
    expect(dashboardSource).toContain('resolveSessionPreviewForProxy({');
    expect(dashboardSource).toContain('isTargetOwned: target => sessionPreviewTargetStillOwned(target)');
    expect(dashboardSource).toContain('onStaleTarget: staleSessionId => invalidateStalePreviewTarget(staleSessionId, owner)');
    expect(dashboardSource).toContain('authSessionConnections.closeSessionStreams(sessionId)');
    expect(dashboardSource).toContain('previewInteraction.relockSession(sessionId)');
    expect(dashboardSource).toContain('authSessionConnections.register(authSessionId, close, ctx.sessionId)');
  });

  it('projects internal targets out of both REST snapshots and SSE events', () => {
    expect(dashboardSource).toContain('projectSessionPreviewsForBrowser(sessions)');
    expect(dashboardSource).toContain('projectSessionPreviewEventForBrowser(ev.type, ev.body)');
    expect(dashboardSource).toContain("url.pathname.match(/^\\/api\\/sessions\\/([^/]+)\\/preview$/)");
  });
});
