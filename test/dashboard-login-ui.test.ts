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
