import { describe, expect, it, vi } from 'vitest';
import { createDashboardSummaryEndpoint } from '../src/dashboard/dashboard-summary-endpoint.js';
import type { DashboardSummary } from '../src/dashboard/dashboard-summary.js';

const SUMMARY: DashboardSummary = {
  schemaVersion: 1,
  generatedAt: '2026-08-09T00:00:00.000Z',
  service: { status: 'healthy' },
  bots: { online: 1 },
  sessions: { active: 0, attention: 0 },
  schedules: { enabled: 0, nextRunAt: null },
  dashboard: { href: '/' },
};

describe('dashboard summary endpoint', () => {
  it('rejects the sixth anonymous request before loading another fleet snapshot', async () => {
    const load = vi.fn(async () => SUMMARY);
    const endpoint = createDashboardSummaryEndpoint({ load, now: () => 0 });

    for (let request = 0; request < 5; request += 1) {
      await expect(endpoint.get({ authenticated: false })).resolves.toEqual({
        status: 200,
        headers: { 'cache-control': 'no-store' },
        body: SUMMARY,
      });
    }

    await expect(endpoint.get({ authenticated: false })).resolves.toEqual({
      status: 429,
      headers: {
        'cache-control': 'no-store',
        'retry-after': '10',
      },
      body: { error: 'rate_limited', retryAfterSeconds: 10 },
    });
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('admits a new anonymous request when the oldest attempt leaves the rolling window', async () => {
    let now = 0;
    const load = vi.fn(async () => SUMMARY);
    const endpoint = createDashboardSummaryEndpoint({ load, now: () => now });
    for (let request = 0; request < 5; request += 1) {
      await endpoint.get({ authenticated: false });
    }

    now = 9_999;
    await expect(endpoint.get({ authenticated: false })).resolves.toMatchObject({
      status: 429,
      headers: { 'retry-after': '1' },
      body: { retryAfterSeconds: 1 },
    });

    now = 10_000;
    await expect(endpoint.get({ authenticated: false })).resolves.toMatchObject({
      status: 200,
      body: SUMMARY,
    });
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('lets authenticated callers bypass an exhausted anonymous budget', async () => {
    const load = vi.fn(async () => SUMMARY);
    const endpoint = createDashboardSummaryEndpoint({ load, now: () => 0 });
    for (let request = 0; request < 5; request += 1) {
      await endpoint.get({ authenticated: false });
    }

    await expect(endpoint.get({ authenticated: true })).resolves.toMatchObject({
      status: 200,
      body: SUMMARY,
    });
    await expect(endpoint.get({ authenticated: false })).resolves.toMatchObject({ status: 429 });
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('returns the unavailable contract and reports a fleet snapshot failure', async () => {
    const failure = new Error('daemon_snapshot_http_error');
    const onError = vi.fn();
    const endpoint = createDashboardSummaryEndpoint({
      load: vi.fn(async () => { throw failure; }),
      now: () => Date.parse('2026-08-09T01:02:03.000Z'),
      onError,
    });

    await expect(endpoint.get({ authenticated: false })).resolves.toEqual({
      status: 503,
      headers: { 'cache-control': 'no-store' },
      body: {
        schemaVersion: 1,
        generatedAt: '2026-08-09T01:02:03.000Z',
        service: { status: 'degraded' },
      },
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
