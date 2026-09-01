import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  isPreviewLoopbackHost,
  isPreviewPort,
  probeSessionPreviewTarget,
  safeSessionPreviewTarget,
  sameSessionPreviewTarget,
  sessionPreviewDescriptor,
  sessionPreviewFingerprint,
  sessionPreviewPath,
} from '../src/core/session-preview.js';
import {
  previewDescriptorFromRow,
  previewTeardownForDaemonEvent,
  projectSessionPreviewEventForBrowser,
  projectSessionPreviewForBrowser,
  projectSessionDetailForBrowser,
  resolveSessionPreviewFromRow,
} from '../src/dashboard/preview-contract.js';
import { workbenchPreviewHref } from '../src/dashboard/web/agent-workbench-model.js';
import {
  projectSessionEventForAudience,
  projectSessionsForAudience,
  redactSessionEventForPublic,
  redactSessionsForPublic,
} from '../src/dashboard/public-redact.js';

let server: Server | null = null;
let outsider: ChildProcess | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (outsider) { try { outsider.kill('SIGKILL'); } catch { /* gone */ } }
  outsider = null;
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

  it.skipIf(process.platform !== 'linux')('probes a reachable IPv4 loopback service before producing a target', async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    // 真实归属：监听 socket 就是本进程开的，所以本进程 pid 作血缘根必须验得过。
    const probe = await probeSessionPreviewTarget({
      port,
      ownerPids: [process.pid],
      workerGeneration: 4,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.target).toMatchObject({
      host: '127.0.0.1',
      port,
      registeredAt: '2026-08-11T12:00:00.000Z',
      workerGeneration: 4,
    });
    expect(probe.target.owner.pid).toBe(process.pid);
    expect(probe.target.owner.inode).toMatch(/^\d+$/);
    expect(probe.target.owner.procStart).toMatch(/^\d+$/);
  });

  it.skipIf(process.platform !== 'linux')(
    'P1-12: refuses a reachable port held outside the session lineage',
    async () => {
      server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      // 一个活着的、但与监听者毫无血缘关系的进程，充当「本会话的 worker」。
      outsider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

      // 端口完全可达（上面那台服务器还开着），但持有它的不是本会话血缘里的进程：
      // 这正是 agent 注册 Docker API / 别人 dev server 的形状——必须 fail closed，
      // 且与「不可达」区分开。
      const probe = await probeSessionPreviewTarget({
        port,
        ownerPids: [outsider.pid],
        workerGeneration: 1,
      });

      expect(probe).toEqual({ ok: false, error: 'preview_owner_unverified', reason: 'owner_unknown' });

      // init 也不能当血缘根：那等于「本机任何进程都算数」，形同没有证明。
      await expect(probeSessionPreviewTarget({ port, ownerPids: [1], workerGeneration: 1 }))
        .resolves.toMatchObject({ ok: false, error: 'preview_owner_unverified' });
    },
  );

  it.skipIf(process.platform !== 'linux')('fails closed for an unreachable port', async () => {
    server = createServer();
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;

    await expect(probeSessionPreviewTarget({
      port, timeoutMs: 100, ownerPids: [process.pid], workerGeneration: 1,
    })).resolves.toEqual({ ok: false, error: 'preview_unreachable' });
  });

  it('rejects malformed/remote/unproven persisted targets at the use boundary', () => {
    const owner = { pid: 4242, procStart: '918273', inode: '556677' };
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1',
      port: 3000,
      registeredAt: '2026-08-11T12:00:00.000Z',
      owner,
      workerGeneration: 2,
      extra: 'ignored',
    })).toEqual({
      host: '127.0.0.1',
      port: 3000,
      registeredAt: '2026-08-11T12:00:00.000Z',
      owner,
      workerGeneration: 2,
    });
    expect(safeSessionPreviewTarget({
      host: '169.254.169.254', port: 80, registeredAt: '2026-08-11T12:00:00.000Z', owner, workerGeneration: 2,
    })).toBeUndefined();
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 0, registeredAt: '2026-08-11T12:00:00.000Z', owner, workerGeneration: 2,
    })).toBeUndefined();
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 3000, registeredAt: 'August 11, 2026', owner, workerGeneration: 2,
    })).toBeUndefined();
    // P1-12：老版本（或攻击者）写下的、没有持有证明的 target 一律归零 —— 代理不能
    // 凭「曾经 connect 通过」把用户导进一个无法再核验的端口。
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z', workerGeneration: 2,
    })).toBeUndefined();
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1',
      port: 3000,
      registeredAt: '2026-08-11T12:00:00.000Z',
      owner: { pid: 4242, procStart: 'not-a-number', inode: '556677' },
      workerGeneration: 2,
    })).toBeUndefined();
    expect(safeSessionPreviewTarget({
      host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z', owner,
    })).toBeUndefined();
  });
});

describe('session preview REST/SSE contract', () => {
  const previewTarget = {
    host: '127.0.0.1',
    port: 4173,
    registeredAt: '2026-08-11T12:00:00.000Z',
    owner: { pid: 4242, procStart: '918273', inode: '556677' },
    workerGeneration: 3,
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

  it('projects single-session daemon envelopes without leaking the loopback target', () => {
    const projected = projectSessionDetailForBrowser({
      session: { sessionId: 's1', title: 'one', previewTarget },
    }) as any;
    expect(projected.session.preview.path).toBe('/preview/s1/');
    expect(projected.session).not.toHaveProperty('previewTarget');
    expect(JSON.stringify(projected)).not.toContain('127.0.0.1');
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

  it('delivers the descriptor (and never the loopback target) to an authenticated Workbench identity', () => {
    // Full `/api/sessions` pipeline: loopback target → same-origin descriptor →
    // audience projection. An H5/platform identity holds preview.view, so the
    // descriptor must survive the second hop — it used to be deleted by the
    // anonymous projection, which is what made the Dock show 「无网页预览」.
    const browserRow = projectSessionPreviewForBrowser({ sessionId: 's1', previewTarget }) as any;
    const [rest] = projectSessionsForAudience([browserRow], 'workbench') as any[];
    expect(rest.preview).toEqual({ path: '/preview/s1/', registeredAt: previewTarget.registeredAt });
    // The proxy-only loopback host/port still never leaves the daemon.
    expect(rest).not.toHaveProperty('previewTarget');
    expect(JSON.stringify(rest)).not.toContain('127.0.0.1');
    expect(JSON.stringify(rest)).not.toContain('4173');

    const browserEvent = projectSessionPreviewEventForBrowser('session.update', {
      sessionId: 's1', patch: { previewTarget },
    });
    const sse = projectSessionEventForAudience('session.update', browserEvent, 'workbench') as any;
    expect(sse.patch.preview).toEqual({ path: '/preview/s1/', registeredAt: previewTarget.registeredAt });
    expect(JSON.stringify(sse)).not.toContain('127.0.0.1');
  });
});

describe('session preview ownership resolution', () => {
  const target = {
    host: '127.0.0.1',
    port: 3000,
    registeredAt: '2026-08-11T12:00:00.000Z',
    owner: { pid: 4242, procStart: '918273', inode: '556677' },
    workerGeneration: 3,
  } as const;

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

  it('Riff 矩阵: remote sandbox sessions are unsupported, local backends still resolve', () => {
    // riff 的 Web 服务在远端主机上，daemon 的 loopback 上永远不会有它的监听。回
    // preview_unsupported（501），而不是把它混进「不可达」让用户以为是偶发故障。
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's1', larkAppId: 'app-a', status: 'idle', backendType: 'riff', previewTarget: target },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toEqual({ ok: false, status: 501, error: 'preview_unsupported' });
    // 没注册过预览的 riff 会话同样是「不支持」，不是「未注册」。
    expect(resolveSessionPreviewFromRow({
      row: { sessionId: 's1', larkAppId: 'app-a', status: 'idle', backendType: 'riff' },
      sessionId: 's1', ownerLarkAppId: 'app-a',
    })).toEqual({ ok: false, status: 501, error: 'preview_unsupported' });
    for (const backendType of ['pty', 'tmux', 'zellij', 'herdr', 'zmx', undefined]) {
      expect(resolveSessionPreviewFromRow({
        row: { sessionId: 's1', larkAppId: 'app-a', status: 'idle', backendType, previewTarget: target },
        sessionId: 's1', ownerLarkAppId: 'app-a',
      }), String(backendType)).toEqual({ ok: true, target });
    }
  });

  it('Riff 矩阵: the browser never gets a preview entry for a remote-backend session', () => {
    const riffRow = projectSessionPreviewForBrowser({
      sessionId: 's1', backendType: 'riff', previewTarget: target,
    }) as any;
    expect(riffRow).not.toHaveProperty('preview');
    expect(riffRow).not.toHaveProperty('previewTarget');
    expect(previewDescriptorFromRow({ sessionId: 's1', backendType: 'riff', previewTarget: target }))
      .toBeUndefined();

    // 入口隐藏是真实的：Workbench 用同一个 href 判定要不要显示「网页」面。
    expect(workbenchPreviewHref(riffRow)).toBeNull();

    for (const backendType of ['pty', 'tmux']) {
      const localRow = projectSessionPreviewForBrowser({
        sessionId: 's1', backendType, previewTarget: target,
      }) as any;
      expect(localRow.preview, backendType).toEqual({
        path: '/preview/s1/', registeredAt: target.registeredAt,
      });
      expect(previewDescriptorFromRow({ sessionId: 's1', backendType, previewTarget: target }), backendType)
        .toEqual({ path: '/preview/s1/', registeredAt: target.registeredAt });
      expect(workbenchPreviewHref(localRow), backendType).toBe('/preview/s1/');
    }
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

// ─── P1-1：换靶复核与 SSE 重放收敛 ───────────────────────────────────────────
//
// 代理的授权与目标解析都发生在**拨号之前**，而 dev server 的握手最长可以拖 45 秒。
// 这段窗口里换代 / 切 CLI / 端口易主换来的新目标，旧流握完手照样能拿到 200/101，还会
// 被重新登记进索引（换靶那一刻的 teardown 扫的是索引，扫不到一条还没入索引的流）。
// 复核靠的是「这是不是同一次注册」——host:port 不够，端口回收后重注册会给出同一个
// host:port，但那是另一个进程。
describe('P1-1 preview target 指纹与 daemon 事件收口', () => {
  const target = {
    host: '127.0.0.1',
    port: 3000,
    registeredAt: '2026-08-11T12:00:00.000Z',
    owner: { pid: 4242, procStart: '918273', inode: '556677' },
    workerGeneration: 3,
  } as const;

  function withTarget(patch: Record<string, unknown>): Record<string, unknown> {
    return { ...target, owner: { ...target.owner }, ...patch };
  }

  it('只有同一次注册才算同一个 target', () => {
    expect(sameSessionPreviewTarget(target, withTarget({}) as never)).toBe(true);
    // host:port 一样但换了一次注册的每一种形态，都必须判为不同。
    const variants: Array<[string, Record<string, unknown>]> = [
      ['换端口', { port: 4000 }],
      ['重注册（registeredAt 变）', { registeredAt: '2026-08-11T12:00:01.000Z' }],
      ['worker 换代', { workerGeneration: 4 }],
      ['端口易主（pid 变）', { owner: { ...target.owner, pid: 4243 } }],
      ['pid 复用（procStart 变）', { owner: { ...target.owner, procStart: '918274' } }],
      ['监听 socket 换了（inode 变）', { owner: { ...target.owner, inode: '556678' } }],
    ];
    for (const [label, patch] of variants) {
      expect(sameSessionPreviewTarget(target, withTarget(patch) as never), label).toBe(false);
    }
  });

  it('非法/缺失的 target 指纹归零，绝不与任何一次真实注册相等', () => {
    expect(sessionPreviewFingerprint(undefined)).toBe('');
    expect(sessionPreviewFingerprint(null)).toBe('');
    expect(sessionPreviewFingerprint({ host: '169.254.169.254', port: 80 })).toBe('');
    expect(sessionPreviewFingerprint(target)).not.toBe('');
  });

  it('SSE 重连重放同一份 target 时不收口，指纹变了才收口', () => {
    const seen = new Map<string, string>();
    const spawned = (previewTarget: unknown): { type: string; body: unknown } =>
      ({ type: 'session.spawned', body: { session: { sessionId: 's1', previewTarget } } });

    // 第一次见到（dashboard 启动 / 会话新建）不算换靶。
    expect(previewTeardownForDaemonEvent(spawned(target), seen)).toBeUndefined();
    // daemon 的 /api/events 每次被连上都重放全部会话——重放不得误杀预览长连接。
    expect(previewTeardownForDaemonEvent(spawned(target), seen)).toBeUndefined();
    expect(previewTeardownForDaemonEvent(spawned(withTarget({})), seen)).toBeUndefined();

    // daemon 重启期间广播的 preview:null 丢了，重连后只以 spawned 形式补齐：要收口。
    expect(previewTeardownForDaemonEvent(spawned(undefined), seen)).toBe('s1');
    // 收口后记忆同步更新，同一份重放不会反复收口。
    expect(previewTeardownForDaemonEvent(spawned(undefined), seen)).toBeUndefined();
    // 换代后在新端口重注册：再收口一次。
    expect(previewTeardownForDaemonEvent(spawned(withTarget({ port: 4000 })), seen)).toBe('s1');
  });

  it('previewTarget 补丁与会话结束照旧收口，无关事件一律不动', () => {
    const seen = new Map<string, string>();
    seen.set('s1', sessionPreviewFingerprint(target));

    expect(previewTeardownForDaemonEvent(
      { type: 'session.update', body: { sessionId: 's1', patch: { status: 'idle' } } },
      seen,
    )).toBeUndefined();
    expect(previewTeardownForDaemonEvent(
      { type: 'schedule.updated', body: { id: 'x', patch: { previewTarget: null } } },
      seen,
    )).toBeUndefined();

    expect(previewTeardownForDaemonEvent(
      { type: 'session.update', body: { sessionId: 's1', patch: { previewTarget: null } } },
      seen,
    )).toBe('s1');
    // 补丁处理完就把记忆刷成新值，紧随其后的 SSE 重放不会再收口一次。
    expect(seen.get('s1')).toBe('');
    expect(previewTeardownForDaemonEvent(
      { type: 'session.spawned', body: { session: { sessionId: 's1' } } },
      seen,
    )).toBeUndefined();

    expect(previewTeardownForDaemonEvent(
      { type: 'session.exited', body: { sessionId: 's1' } },
      seen,
    )).toBe('s1');
    expect(seen.has('s1')).toBe(false);
  });
});
