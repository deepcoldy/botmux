import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import type { FeedbackAnalyticsFilters, FeedbackAnalyticsService } from '../services/feedback-analytics.js';

function filters(url: URL): FeedbackAnalyticsFilters {
  const required = (key: string): string => { const value = url.searchParams.get(key); if (!value) throw new Error(`feedback_analytics_missing_${key}`); return value; };
  const result: FeedbackAnalyticsFilters = { from: required('from'), to: required('to') };
  const mapping: Array<[string, keyof FeedbackAnalyticsFilters]> = [['team', 'teamId'], ['bot', 'botAppId'], ['chat', 'chatId'], ['topic', 'topicRootId'], ['semantic', 'semantic'], ['verdict', 'verdictKey'], ['reason', 'reasonKey'], ['model', 'model'], ['cli', 'cliId'], ['cliVersion', 'cliVersion'], ['skill', 'skillName'], ['skillVersion', 'skillVersion'], ['workflow', 'workflowId'], ['task', 'taskId'], ['status', 'status']];
  for (const [query, key] of mapping) { const value = url.searchParams.get(query); if (value) (result as unknown as Record<string, string>)[key] = value; }
  return result;
}

export async function handleFeedbackAnalyticsApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: { service: FeedbackAnalyticsService }): Promise<boolean> {
  if (!url.pathname.startsWith('/api/feedback/analytics/')) return false;
  if (req.method !== 'GET') { jsonRes(res, 405, { error: 'method_not_allowed' }); return true; }
  try {
    const query = filters(url);
    if (url.pathname === '/api/feedback/analytics/summary') jsonRes(res, 200, deps.service.summary(query));
    else if (url.pathname === '/api/feedback/analytics/trend') jsonRes(res, 200, { items: deps.service.trend(query) });
    else if (url.pathname === '/api/feedback/analytics/reasons') jsonRes(res, 200, { items: deps.service.reasons(query) });
    else if (url.pathname === '/api/feedback/analytics/deliveries') jsonRes(res, 200, deps.service.deliveries(query, { limit: Number(url.searchParams.get('limit') ?? 50), ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) }));
    else jsonRes(res, 404, { error: 'not_found' });
  } catch (error) {
    jsonRes(res, 400, { error: error instanceof Error ? error.message : 'feedback_analytics_invalid_request' });
  }
  return true;
}
