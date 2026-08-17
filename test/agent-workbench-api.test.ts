import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkbenchApiError,
  createWorkbenchApi,
} from '../src/dashboard/web/agent-workbench-api.js';

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

  it('把跨端口的 view-link 改写成同源地址，pathname 与 viewToken 原样保留', async () => {
    // 上游给的是「终端反代自身端口」的绝对地址。手机所在办公网只放行 dashboard 端口、
    // 对 8801 完全不可达，直接挂这条地址 iframe 加载不出来、终端一片空白。
    setPageOrigin('https://board.example');
    const api = createWorkbenchApi(async () => jsonResponse({
      ok: true,
      url: 'http://10.37.228.130:8801/s/session-0?viewToken=view-cap-abc',
    }));

    const link = await api.getTerminalViewLink('session-0');
    expect(link).toBe('https://board.example/s/session-0?viewToken=view-cap-abc');
    // 端口/主机/协议全部换成当前页面的，路径与凭证一个字都不能动。
    const parsed = new URL(link!);
    expect(parsed.origin).toBe('https://board.example');
    expect(parsed.pathname).toBe('/s/session-0');
    expect(parsed.searchParams.get('viewToken')).toBe('view-cap-abc');
  });

  it('同源改写发生在协议与凭证校验之后，非法链接照旧拒绝', async () => {
    setPageOrigin('https://board.example');

    // javascript: 之类的非 http(s) 协议不能进 DOM，更不能被改写「洗」成同源地址。
    const hostileProtocol = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: 'javascript:alert(1)//board.example/s/session-0?viewToken=t',
    }));
    await expect(hostileProtocol.getTerminalViewLink('session-0')).resolves.toBeNull();

    // 内嵌凭证同理：先判掉，不给它借同源改写落地的机会。
    const embeddedCredentials = createWorkbenchApi(async () => jsonResponse({
      ok: true, url: 'https://user:pass@evil.example/s/session-0?viewToken=t',
    }));
    await expect(embeddedCredentials.getTerminalViewLink('session-0')).resolves.toBeNull();

    const notAUrl = createWorkbenchApi(async () => jsonResponse({ ok: true, url: 'not a url' }));
    await expect(notAUrl.getTerminalViewLink('session-0')).resolves.toBeNull();
  });

  it('拿不到页面 origin 时回退原地址，不把链接改丢', async () => {
    // SSR / 注入 fetchImpl 的测试环境没有 window；改写是可达性优化，缺条件就别动。
    const upstream = 'http://10.37.228.130:8801/s/session-0?viewToken=view-cap-abc';
    const noWindow = createWorkbenchApi(async () => jsonResponse({ ok: true, url: upstream }));
    await expect(noWindow.getTerminalViewLink('session-0')).resolves.toBe(upstream);

    // 沙箱 iframe 的不透明 origin 是字符串 "null"，拼不出合法地址，同样回退。
    setPageOrigin('null');
    const opaqueOrigin = createWorkbenchApi(async () => jsonResponse({ ok: true, url: upstream }));
    await expect(opaqueOrigin.getTerminalViewLink('session-0')).resolves.toBe(upstream);
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
