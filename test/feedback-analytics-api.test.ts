import { describe, expect, it, vi } from 'vitest';
import { handleFeedbackAnalyticsApi } from '../src/dashboard/feedback-analytics-api.js';

describe('feedback analytics dashboard API', () => {
  it('parses typed filters and cursor pagination without exposing implementation data', async () => {
    const service = {
      summary: vi.fn(() => ({ delivered: 1 })), trend: vi.fn(), reasons: vi.fn(), deliveries: vi.fn(() => ({ items: [] })), close: vi.fn(),
    };
    const body: unknown[] = [];
    const res = { writeHead: vi.fn(), end: vi.fn(value => body.push(JSON.parse(String(value)))) } as any;
    const handled = await handleFeedbackAnalyticsApi({ method: 'GET' } as any, res, new URL('http://localhost/api/feedback/analytics/deliveries?from=2026-08-10T00%3A00%3A00.000Z&to=2026-08-11T00%3A00%3A00.000Z&bot=app-a&chat=chat-a&limit=25&cursor=abc'), { service: service as any });
    expect(handled).toBe(true);
    expect(service.deliveries).toHaveBeenCalledWith(expect.objectContaining({ botAppId: 'app-a', chatId: 'chat-a' }), { limit: 25, cursor: 'abc' });
    expect(body).toEqual([{ items: [] }]);
  });
});
