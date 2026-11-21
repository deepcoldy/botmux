import { describe, expect, it, vi } from 'vitest';
import { handleFeedbackAnalyticsApi } from '../src/dashboard/feedback-analytics-api.js';

describe('feedback analytics dashboard API', () => {
  it('waits for asynchronous storage before returning the summary', async () => {
    let resolveSummary!: (value: { delivered: number }) => void;
    const summary = new Promise<{ delivered: number }>(resolve => { resolveSummary = resolve; });
    const body: unknown[] = [];
    const service = { summary: () => summary };
    const res = { writeHead: vi.fn(), end: (value: string) => body.push(JSON.parse(value)) } as any;
    const pending = handleFeedbackAnalyticsApi(
      { method: 'GET' } as any, res,
      new URL('http://localhost/api/feedback/analytics/summary?from=2026-08-10T00:00:00Z&to=2026-08-11T00:00:00Z'),
      { service: service as any },
    );
    await Promise.resolve();
    expect(body).toEqual([]);
    resolveSummary({ delivered: 7 });
    await pending;
    expect(body).toEqual([{ delivered: 7 }]);
  });
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
