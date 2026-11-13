import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from '../src/dashboard/web/usage-page.js';
import { usageAnalyticsQuery, usageDateRange } from '../src/dashboard/web/usage-filters.js';
import { emptyUsageTotals } from '../src/services/usage-analytics.js';
import type { UsageReport } from '../src/dashboard/usage-types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const body = (totalTokens = 100): UsageReport => ({ query: { from: '2026-11-01T00:00:00Z', to: '2026-11-14T00:00:00Z', timeZone: 'Asia/Shanghai' },
  generatedAt: '2026-11-13T12:00:00Z', summary: { ...emptyUsageTotals(), totalTokens, records: 1 }, trend: [], bots: [], models: [], sessions: [], sessionCount: 0,
  options: { bots: ['bot-a'], models: ['model-a'] }, coverage: { ledgerMissing: false, filesRead: 1, invalidRecords: 0, duplicateRecords: 0, firstRecordAt: null, lastRecordAt: null } });
const response = (report: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => report, text: async () => 'error' }) as Response;
let renderer: TestRenderer.ReactTestRenderer | undefined;
const requests: { url: URL; signal?: AbortSignal | null }[] = [];
function api(override?: (url: URL) => Promise<Response> | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const url = new URL(path, 'http://localhost'); requests.push({ url, signal: init?.signal });
    if (url.pathname === '/api/bots') return response({ bots: [{ larkAppId: 'bot-a', botName: 'Bot A' }] });
    return override?.(url) ?? response(body(url.searchParams.has('bot') ? 5 : 100));
  }));
}
const total = () => renderer!.root.findByProps({ className: 'usage-metrics' }).findAllByType('strong')[0]!.children.join('');
const change = (id: string, value: string) => act(() => renderer!.root.findByProps({ id }).props.onChange({ target: { value } }));
const submit = () => act(async () => { renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} }); });

describe('token usage page', () => {
  beforeEach(() => { requests.length = 0; vi.stubEnv('TZ', 'Asia/Shanghai'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00+08:00')); });
  afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('queries inclusive calendar days and applies bot/model to all panels in one response', async () => {
    api(); await act(async () => { renderer = TestRenderer.create(React.createElement(UsagePage)); });
    expect(total()).toBe('100'); requests.length = 0;
    change('usage-from', '2026-11-10'); change('usage-to', '2026-11-10'); change('usage-bot', 'bot-a'); change('usage-model', 'model-a');
    expect(requests).toHaveLength(0); await submit();
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({ from: '2026-11-09T16:00:00.000Z', to: '2026-11-10T16:00:00.000Z', timeZone: 'Asia/Shanghai', bot: 'bot-a', model: 'model-a' });
    expect(total()).toBe('5');
  });

  it('ignores an old response after filters change', async () => {
    let resolve!: (response: Response) => void;
    const old = new Promise<Response>(r => { resolve = r; });
    api(url => !url.searchParams.has('bot') ? old : undefined);
    await act(async () => { renderer = TestRenderer.create(React.createElement(UsagePage)); });
    const first = requests.find(r => r.url.pathname === '/api/usage/summary')!;
    change('usage-bot', 'bot-a'); await submit(); expect(first.signal?.aborted).toBe(true); expect(total()).toBe('5');
    await act(async () => resolve(response(body(999)))); expect(total()).toBe('5');
  });

  it('does not replace a failed or missing read with a zero consumption claim', async () => {
    api(() => Promise.resolve(response({ error: 'usage_ledger_unavailable' }, false)));
    await act(async () => { renderer = TestRenderer.create(React.createElement(UsagePage)); });
    expect(total()).toBe('—'); expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    await act(async () => renderer!.unmount());
    const missing = body(0); missing.coverage.ledgerMissing = true;
    await act(async () => { renderer = TestRenderer.create(React.createElement(UsagePage, { initialData: missing })); });
    expect(total()).toBe('—');
  });

  it('validates dates and supports calendar week/month presets', () => {
    expect(usageDateRange('week', new Date('2026-11-13T12:00:00+08:00'))).toEqual({ fromDate: '2026-11-09', toDate: '2026-11-13' });
    expect(usageDateRange('month', new Date('2026-11-13T12:00:00+08:00'))).toEqual({ fromDate: '2026-11-01', toDate: '2026-11-13' });
    expect(() => usageAnalyticsQuery({ fromDate: '2026-02-30', toDate: '2026-11-13', bot: '', model: '' })).toThrow();
    expect(() => usageAnalyticsQuery({ fromDate: '2026-11-14', toDate: '2026-11-13', bot: '', model: '' })).toThrow();
    vi.stubEnv('TZ', 'America/New_York');
    const dst = usageAnalyticsQuery({ fromDate: '2026-11-01', toDate: '2026-11-01', bot: '', model: '' });
    expect(dst.get('from')).toBe('2026-11-01T04:00:00.000Z');
    expect(dst.get('to')).toBe('2026-11-02T05:00:00.000Z');
  });
});
