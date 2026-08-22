import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkbenchApiError,
  createWorkbenchApi,
  newTerminalAcquisitionId,
} from '../src/dashboard/web/agent-workbench-api.js';
import { isTerminalAcquisitionId } from '../src/dashboard/terminal-control.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** unit 项目跑在 node 环境，默认没有 window。同源改写读的是 `window.location.origin`，
 *  所以要伪装出一个「工作台页面」的 origin 才能验到改写行为。 */
const REAL_WINDOW = (globalThis as Record<string, unknown>).window;

function setPageOrigin(origin: string): void {
  (globalThis as Record<string, unknown>).window = { location: { origin } };
}

afterEach(() => {
  if (REAL_WINDOW === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = REAL_WINDOW;
});

describe('Agent Workbench API integration contract', () => {
  it('carries the client-minted acquisition on takeover and the CAS condition on release', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if (String(input).includes('/takeover')) {
        return jsonResponse({
          ok: true, mode: 'controlled', owned: true, expiresAt: 10_000, acquisition: 'acq-from-server',
        });
      }
      return jsonResponse({ ok: true, mode: 'readonly', owned: false, released: true });
    }) as typeof fetch;
    const api = createWorkbenchApi(fetchImpl);

    await expect(api.takeoverTerminal('s1', undefined, 'acq-mine-000001')).resolves.toEqual({
      mode: 'controlled', owned: true, expiresAt: 10_000, acquisition: 'acq-from-server',
    });
    await api.releaseTerminal('s1', undefined, 'acq-mine-000001');
    // 两个参数都只是不透明等值串，不是凭证；服务端只拿它们做等值比较。
    expect(calls).toEqual([
      'POST /api/sessions/s1/control/takeover?acq=acq-mine-000001',
      'POST /api/sessions/s1/control/release?expect=acq-mine-000001',
    ]);
  });

  it('rejects an acquisition the server echoes in a shape the CAS could not use', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true, mode: 'controlled', owned: true, expiresAt: 10_000, acquisition: 42,
    })) as unknown as typeof fetch;
    await expect(createWorkbenchApi(fetchImpl).takeoverTerminal('s1')).rejects.toMatchObject({
      code: 'invalid_control_response',
    });
  });

  it('mints acquisition ids the server is willing to bind', () => {
    // 前后端各有一份判据（客户端生成、服务端校验）。生成的形状进不了服务端那道正则，
    // 接管就会 400，而用户看到的只是「接管失败」——所以两边必须在测试里对上。
    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = newTerminalAcquisitionId();
      expect(isTerminalAcquisitionId(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it('keeps takeover/release ownership explicit and encodes the exact session id', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? 'GET' });
      if (path.endsWith('/takeover')) {
        return jsonResponse({ ok: true, mode: 'controlled', owned: true, expiresAt: 10_000, reused: false });
      }
      if (path.endsWith('/release')) {
        return jsonResponse({ ok: true, mode: 'readonly', owned: false, released: true });
      }
      return jsonResponse({ ok: true, mode: 'readonly', owned: false });
    }) as typeof fetch;
    const api = createWorkbenchApi(fetchImpl);

    await expect(api.getTerminalControl('session/one')).resolves.toEqual({ mode: 'readonly', owned: false });
    await expect(api.takeoverTerminal('session/one')).resolves.toEqual({
      mode: 'controlled', owned: true, expiresAt: 10_000, reused: false,
    });
    await expect(api.releaseTerminal('session/one')).resolves.toEqual({ mode: 'readonly', owned: false });
    expect(calls).toEqual([
      { path: '/api/sessions/session%2Fone/control', method: 'GET' },
      { path: '/api/sessions/session%2Fone/control/takeover', method: 'POST' },
      { path: '/api/sessions/session%2Fone/control/release', method: 'POST' },
    ]);
  });

  it('accepts the backend securityNotice field and rejects the stale warning-only shape', async () => {
    const good = createWorkbenchApi(async () => jsonResponse({
      ok: true,
      mode: 'interactive',
      label: '交互模式',
      securityNotice: '交互蒙层不是应用级强只读安全边界。',
      idleExpiresAt: 900_000,
    }));
    await expect(good.getPreviewInteraction('s1')).resolves.toEqual({
      mode: 'interactive',
      label: '交互模式',
      securityNotice: '交互蒙层不是应用级强只读安全边界。',
      idleExpiresAt: 900_000,
    });

    const stale = createWorkbenchApi(async () => jsonResponse({
      ok: true,
      mode: 'preview',
      label: 'PREVIEW',
      warning: 'old UI-only field',
    }));
    await expect(stale.getPreviewInteraction('s1')).rejects.toMatchObject({
      name: 'WorkbenchApiError',
      status: 502,
      code: 'invalid_preview_interaction_response',
    } satisfies Partial<WorkbenchApiError>);
  });

  it('accepts a fixed writable platform-owner role without inventing a lease expiry', async () => {
    const api = createWorkbenchApi(async () => jsonResponse({
      ok: true, mode: 'controlled', owned: true, fixed: true,
    }));
    await expect(api.getTerminalControl('s1')).resolves.toEqual({
      mode: 'controlled', owned: true, fixed: true,
    });
  });

  it('fails closed on malformed metadata while preserving stable server errors', async () => {
    const malformed = createWorkbenchApi(async () => jsonResponse({
      ok: true,
      h5: { enabled: true, appId: 'cli_x', brand: 'invalid', entryPath: 'relative' },
    }));
    await expect(malformed.getH5Context()).resolves.toBeNull();

    const denied = createWorkbenchApi(async () => jsonResponse({
      ok: false,
      error: 'authentication_required',
    }, 401));
    await expect(denied.getTerminalControl('s1')).rejects.toMatchObject({
      status: 401,
      code: 'authentication_required',
    });
  });

  it('把服务端给的同源相对路径拼成本页地址，pathname 与 viewToken 原样保留', async () => {
    // P1-5 起服务端只回同源相对路径。它同时解决两件事：手机所在办公网只放行 dashboard
    // 端口（对反代 8801 完全不可达，绝对地址 iframe 一片空白），以及只读凭证绝不能被
    // 指到 daemon/worker 端口上——那两个 origin 看不见 dashboard 的登出状态。
    setPageOrigin('https://board.example');
    const api = createWorkbenchApi(async () => jsonResponse({
      ok: true,
      url: '/s/session-0/?viewToken=view-cap-abc',
      expiresAt: 1_755_000_000_000,
    }));

    const link = await api.getTerminalViewLink('session-0');
    expect(link!.url).toBe('https://board.example/s/session-0/?viewToken=view-cap-abc');
    // 短时能力的到期时间原样透传，供面板在到期前主动换链。
    expect(link!.expiresAt).toBe(1_755_000_000_000);
    // origin 只可能是当前页面的，路径与凭证一个字都不能动。
    const parsed = new URL(link!.url);
    expect(parsed.origin).toBe('https://board.example');
    expect(parsed.pathname).toBe('/s/session-0/');
    expect(parsed.searchParams.get('viewToken')).toBe('view-cap-abc');
  });

  it('expiresAt 缺失或畸形时降级为 null，不整条拒掉链接', async () => {
    setPageOrigin('https://board.example');
    for (const expiresAt of [undefined, 'soon', -5, 1.5]) {
      const api = createWorkbenchApi(async () => jsonResponse({
        ok: true,
        url: '/s/session-0/?viewToken=view-cap-abc',
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }));
      await expect(api.getTerminalViewLink('session-0')).resolves.toMatchObject({ expiresAt: null });
    }
  });

  it('P1-5：任何跨源写法都拒收，绝不「改写洗白」成同源地址', async () => {
    setPageOrigin('https://board.example');

    // 关键一格：daemon/worker 自身端口的绝对地址。以前这里会被剥掉 origin 洗成同源，
    // 于是没人发现服务端本可以把凭证指向一个不做吊销检查的入口。现在直接拒。
    const daemonOrigin = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: 'http://10.37.228.130:8801/s/session-0?viewToken=view-cap-abc',
    }));
    await expect(daemonOrigin.getTerminalViewLink('session-0')).resolves.toBeNull();

    // 协议相对写法 `//host/...` 也是绝对地址，浏览器会当跨源加载。
    const protocolRelative = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: '//evil.example/s/session-0?viewToken=t',
    }));
    await expect(protocolRelative.getTerminalViewLink('session-0')).resolves.toBeNull();
    const backslash = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: '/\\evil.example/s/session-0?viewToken=t',
    }));
    await expect(backslash.getTerminalViewLink('session-0')).resolves.toBeNull();

    // javascript: 之类的非 http(s) 协议不能进 DOM。
    const hostileProtocol = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: 'javascript:alert(1)//board.example/s/session-0?viewToken=t',
    }));
    await expect(hostileProtocol.getTerminalViewLink('session-0')).resolves.toBeNull();

    // 内嵌凭证同理。
    const embeddedCredentials = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: 'https://user:pass@evil.example/s/session-0?viewToken=t',
    }));
    await expect(embeddedCredentials.getTerminalViewLink('session-0')).resolves.toBeNull();

    const notAUrl = createWorkbenchApi(async () => jsonResponse({ ok: true, url: 'not a url' }));
    await expect(notAUrl.getTerminalViewLink('session-0')).resolves.toBeNull();
    // 非终端路径也不收：这个接口只该产出 /s/<id> 形态。
    const wrongPath = createWorkbenchApi(async () => jsonResponse({ ok: true, url: '/api/whatever?viewToken=t' }));
    await expect(wrongPath.getTerminalViewLink('session-0')).resolves.toBeNull();
  });

  it('拿不到页面 origin 时保留相对路径，不把链接改丢', async () => {
    // SSR / 注入 fetchImpl 的测试环境没有 window；相对地址本来就只会打到当前源。
    const upstream = '/s/session-0/?viewToken=view-cap-abc';
    const noWindow = createWorkbenchApi(async () => jsonResponse({ ok: true, url: upstream }));
    await expect(noWindow.getTerminalViewLink('session-0')).resolves.toEqual({ url: upstream, expiresAt: null });

    // 沙箱 iframe 的不透明 origin 是字符串 "null"，拼不出合法地址，同样保留相对路径。
    setPageOrigin('null');
    const opaqueOrigin = createWorkbenchApi(async () => jsonResponse({ ok: true, url: upstream }));
    await expect(opaqueOrigin.getTerminalViewLink('session-0')).resolves.toEqual({ url: upstream, expiresAt: null });
  });

  it('rejects semantically contradictory control and interaction states', async () => {
    const badReadonly = createWorkbenchApi(async () => jsonResponse({
      ok: true, mode: 'readonly', owned: true,
    }));
    await expect(badReadonly.getTerminalControl('s1')).rejects.toMatchObject({
      status: 502, code: 'invalid_control_response',
    });

    const missingControlDeadline = createWorkbenchApi(async () => jsonResponse({
      ok: true, mode: 'controlled', owned: true,
    }));
    await expect(missingControlDeadline.getTerminalControl('s1')).rejects.toMatchObject({
      status: 502, code: 'invalid_control_response',
    });

    const missingInteractionDeadline = createWorkbenchApi(async () => jsonResponse({
      ok: true,
      mode: 'interactive',
      label: 'INTERACTIVE',
      securityNotice: 'not a security boundary',
    }));
    await expect(missingInteractionDeadline.getPreviewInteraction('s1')).rejects.toMatchObject({
      status: 502, code: 'invalid_preview_interaction_response',
    });
  });
});
