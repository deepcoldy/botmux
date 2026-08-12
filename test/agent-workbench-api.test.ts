import { describe, expect, it, vi } from 'vitest';
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
