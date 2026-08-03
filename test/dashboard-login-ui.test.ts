import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { dashboardLoginHref } from '../src/dashboard/web/auth-login.js';

describe('dashboardLoginHref', () => {
  it('preserves the current workflow hash in the platform SSO jump', () => {
    expect(dashboardLoginHref(
      'https://platform.example/open/m-1?next=%2F%23%2F',
      '#/workflows/run-1',
    )).toBe(
      'https://platform.example/open/m-1?next=%2F%23%2Fworkflows%2Frun-1',
    );
  });

  it('falls back to the dashboard root for malformed or missing hashes', () => {
    const base = 'https://platform.example/open/m-1?next=%2F%23%2F';
    expect(dashboardLoginHref(base, '')).toBe(base);
    expect(dashboardLoginHref(base, '#evil')).toBe(base);
  });

  it('rejects missing, non-http, and malformed platform login URLs', () => {
    expect(dashboardLoginHref(undefined, '#/workflows/run-1')).toBeUndefined();
    expect(dashboardLoginHref('javascript:alert(1)', '#/workflows/run-1')).toBeUndefined();
    expect(dashboardLoginHref('not a url', '#/workflows/run-1')).toBeUndefined();
  });
});

describe('Dashboard one-click login wiring', () => {
  it('advertises the token-free login URL on 401 and renders it in the existing overlay', () => {
    const server = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf8');
    expect(server).toContain("'x-botmux-login-url': loginUrl");
    expect(server).toContain("'cache-control': 'no-store'");
    expect(app).toContain("res.headers.get('x-botmux-login-url')");
    expect(app).toContain('id="dashboard-one-click-login"');
    expect(app).toContain('一键登录');
  });
});
