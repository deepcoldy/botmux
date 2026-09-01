import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

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
    expect(dashboardSource).toContain('invalidateStalePreviewTarget(staleSessionId, owner, staleTarget)');
    expect(dashboardSource).toContain('authSessionConnections.closeSessionStreams(sessionId)');
    expect(dashboardSource).toContain('previewInteraction.relockSession(sessionId)');
    expect(dashboardSource).toContain('authSessionConnections.register(authSessionId, close, ctx.sessionId)');
  });

  // P1-1：行为证据在 session-preview（指纹与事件收口判据）与 session-preview-proxy
  // （握手期换靶必须拒）两个套件里；这里只钉「中央 Dashboard 真的把这两件事接上了」。
  it('re-checks the dialed target before registering a stream and converges SSE replays by fingerprint', () => {
    expect(dashboardSource).toContain('const current = resolveDashboardSessionPreview(ctx.sessionId);');
    expect(dashboardSource).toContain('if (!current.ok || !sameSessionPreviewTarget(current.target, ctx.target)) return false;');
    expect(dashboardSource).toContain('previewTeardownForDaemonEvent(ev, lastSeenPreviewFingerprints)');
    // 收口只走这一条判据：不能再有绕过指纹记忆的无条件 teardown 分支。
    expect(dashboardSource).not.toContain('teardownSessionPreview(ev.body.sessionId)');
  });

  // P1-3：失效清理是「作废我判定失效的那一个」，不是「清空当前值」——在途 DELETE 不
  // 得误删这段窗口里刚注册的新目标。行为证据在 ipc-preview-route 套件里。
  it('names the stale registration in the invalidation DELETE instead of clearing unconditionally', () => {
    expect(dashboardSource).toContain('?expectedRegisteredAt=${encodeURIComponent(staleTarget.registeredAt)}');
  });

  it('projects internal targets out of both REST snapshots and SSE events', () => {
    expect(dashboardSource).toContain('projectSessionPreviewsForBrowser(sessions)');
    expect(dashboardSource).toContain('projectSessionPreviewEventForBrowser(ev.type, ev.body)');
    expect(dashboardSource).toContain("url.pathname.match(/^\\/api\\/sessions\\/([^/]+)\\/preview$/)");
  });
});
