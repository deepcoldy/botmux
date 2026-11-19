import { describe, expect, it, vi } from 'vitest';
import { handleUsageAnalyticsApi } from '../src/dashboard/usage-analytics-api.js';
import { resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import { UsageQueryError } from '../src/services/usage-analytics.js';

const url = new URL('http://localhost/api/usage/summary?from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z&timeZone=Asia/Shanghai&bot=a');
function response() { return { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() } as any; }
describe('usage dashboard access', () => {
  it('does not expose host usage through anonymous public read access', async () => {
    const gate = resolveDashboardRequestGate({ method: 'GET', pathname: url.pathname, hasTokenParam: false,
      identity: null, activeToken: 'management-token', publicReadOnly: true });
    expect(gate.decision.kind).toBe('deny401');
    const query = vi.fn(), res = response();
    await handleUsageAnalyticsApi({ method: 'GET' } as any, res, url, { canManageHost: false, query });
    expect(query).not.toHaveBeenCalled(); expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
  });
  it('only handles GET and forwards a fixed set of filters', async () => {
    const query = vi.fn().mockResolvedValue({ summary: { totalTokens: 123 } });
    const res = response();
    await handleUsageAnalyticsApi({ method: 'POST' } as any, res, url, { canManageHost: true, query });
    expect(query).not.toHaveBeenCalled(); expect(res.writeHead).toHaveBeenCalledWith(405, expect.anything());
    await handleUsageAnalyticsApi({ method: 'GET' } as any, res, url, { canManageHost: true, query });
    expect(query).toHaveBeenCalledWith({ from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timeZone: 'Asia/Shanghai', bot: 'a' });
    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
    expect(JSON.parse(res.end.mock.calls.at(-1)[0])).toEqual({ summary: { totalTokens: 123 } });
  });
  it('returns a useful validation error without leaking file paths', async () => {
    const res = response();
    await handleUsageAnalyticsApi({ method: 'GET' } as any, res, url, { canManageHost: true,
      query: async () => { throw new UsageQueryError('usage_invalid_range'); } });
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'usage_invalid_range' }));
  });
});
