import { describe, expect, it } from 'vitest';
import { buildWebhookLogSearchParams } from '../src/dashboard/web/webhook-logs-page.js';
import { findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';
import { renderConnectorsLogsPage } from '../src/dashboard/web/connectors-page.js';

describe('webhook invocation log dashboard', () => {
  it('builds server-side filters and paging parameters', () => {
    const params = buildWebhookLogSearchParams({
      connectorId: 'conn_alerts',
      status: 'error',
      timeWindow: '24h',
      query: 'oc_target',
    }, 50);
    expect(params.get('connectorId')).toBe('conn_alerts');
    expect(params.get('status')).toBe('error');
    expect(params.get('q')).toBe('oc_target');
    expect(params.get('limit')).toBe('50');
    expect(params.get('offset')).toBe('50');
    expect(Date.parse(params.get('since') || '')).not.toBeNaN();
  });

  it('routes both the connectors logs tab and the legacy webhook-logs hash to the logs page', async () => {
    // `#/connectors` is a prefix of `#/connectors/logs`; the logs tab must not
    // be swallowed by the connectors list route.
    const tab = findDashboardRoute('#/connectors/logs');
    const legacy = findDashboardRoute('#/webhook-logs');
    expect(tab?.id).toBe('connectors-logs');
    expect(legacy?.id).toBe('webhook-logs');
    expect(findDashboardRoute('#/connectors')?.id).toBe('connectors');
    expect(await tab!.load()).toBe(renderConnectorsLogsPage);
    expect(await legacy!.load()).toBe(renderConnectorsLogsPage);
  });
});
