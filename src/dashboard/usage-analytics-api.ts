import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import { UsageQueryError } from '../services/usage-analytics.js';
import type { UsageQuery, UsageReport } from './usage-types.js';

export async function handleUsageAnalyticsApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  canManageHost: boolean;
  query: (query: UsageQuery) => Promise<UsageReport>;
}): Promise<boolean> {
  if (url.pathname !== '/api/usage/summary') return false;
  res.setHeader('cache-control', 'no-store');
  if (!deps.canManageHost) { jsonRes(res, 403, { error: 'host_admin_required' }); return true; }
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); jsonRes(res, 405, { error: 'method_not_allowed' }); return true; }
  try {
    const p = url.searchParams;
    const report = await deps.query({ from: p.get('from') ?? '', to: p.get('to') ?? '', timeZone: p.get('timeZone') ?? 'UTC',
      ...(p.get('bot') ? { bot: p.get('bot')! } : {}), ...(p.get('model') ? { model: p.get('model')! } : {}) });
    jsonRes(res, 200, report);
  } catch (error) {
    jsonRes(res, error instanceof UsageQueryError ? error.status : 503,
      { error: error instanceof UsageQueryError ? error.code : 'usage_ledger_unavailable' });
  }
  return true;
}
