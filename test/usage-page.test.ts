import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from '../src/dashboard/web/usage-page.js';
import { usageAnalyticsQuery, usageDateRange } from '../src/dashboard/web/usage-filters.js';
import { emptyUsageTotals } from '../src/services/usage-analytics.js';
import { emptyUsageMetrics } from '../src/services/usage-metrics.js';
import { usageMetricNumber, usageMetricShare } from '../src/dashboard/web/usage-format.js';
import type { UsageReport } from '../src/dashboard/usage-types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const body = (totalTokens = 100): UsageReport => ({ query: { from: '2026-11-01T00:00:00Z', to: '2026-11-14T00:00:00Z', timeZone: 'Asia/Shanghai' },
  generatedAt: '2026-11-13T12:00:00Z', summary: { ...emptyUsageTotals(), totalTokens, records: 1 }, metrics: { ...emptyUsageMetrics('2026-11-13T12:00:00Z'), averageTpm: totalTokens / 2 }, trend: [], bots: [], models: [], sessions: [], sessionCount: 0,
  options: { bots: ['bot-a'], models: ['model-a'] }, coverage: { ledgerMissing: false, filesRead: 1, invalidRecords: 0, duplicateRecords: 0, futureRecords: 0, firstRecordAt: null, lastRecordAt: null } });
// 直接 createElement(UsagePage, { initialData }) 在 tsc 下报 TS2769（本文件不在 typecheck 范围，运行时不受影响）；显式标注 props 类型。
const page = (initialData: UsageReport) => React.createElement(UsagePage as React.FC<{ initialData?: UsageReport }>, { initialData });
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
    expect(renderer!.root.findByProps({ 'data-usage-metric': 'average-tpm' }).findByType('strong').children.join('')).toBe('2.5');
  });

  it('ignores an old response after filters change', async () => {
    let resolve!: (response: Response) => void;
    const old = new Promise<Response>(r => { resolve = r; });
    api(url => !url.searchParams.has('bot') ? old : undefined);
    await act(async () => { renderer = TestRenderer.create(React.createElement(UsagePage)); });
    const first = requests.find(r => r.url.pathname === '/api/usage/summary')!;
    change('usage-bot', 'bot-a'); await submit(); expect(first.signal?.aborted).toBe(true); expect(total()).toBe('5');
    await act(async () => resolve(response(body(999)))); expect(total()).toBe('5');
    expect(renderer!.root.findByProps({ 'data-usage-metric': 'average-tpm' }).findByType('strong').children.join('')).toBe('2.5');
  });

  it('does not replace a failed or missing read with a zero consumption claim', async () => {
    api(() => Promise.resolve(response({ error: 'usage_ledger_unavailable' }, false)));
    await act(async () => { renderer = TestRenderer.create(React.createElement(UsagePage)); });
    expect(total()).toBe('—'); expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    await act(async () => renderer!.unmount());
    const missing = body(0); missing.coverage.ledgerMissing = true;
    await act(async () => { renderer = TestRenderer.create(page(missing)); });
    expect(total()).toBe('—');
    expect(renderer!.root.findByProps({ 'data-usage-metric': 'average-tpm' }).findByType('strong').children.join('')).toBe('—');
  });

  it('keeps small positive rates visible and does not cap output/input ratios at 100%', async () => {
    const report = body(); report.metrics.averageTpm = .0001;
    report.metrics.cacheReadShare = .9; report.metrics.outputInputRatio = 1.5;
    await act(async () => { renderer = TestRenderer.create(page(report)); });
    const value = (id: string) => renderer!.root.findByProps({ 'data-usage-metric': id }).findByType('strong').children.join('');
    expect(value('average-tpm')).toBe('<0.01'); expect(value('cache-share')).toBe('90%'); expect(value('output-input')).toBe('150%');
    expect(usageMetricNumber(0)).toBe('0'); expect(usageMetricShare(null)).toBe('—'); expect(usageMetricShare(NaN)).toBe('—');
  });

  it('discloses excluded future records and renders unit cost, per-group rates and the peak minute in the queried zone', async () => {
    const report = body(); report.query.timeZone = 'UTC'; report.coverage.futureRecords = 2;
    Object.assign(report.metrics, { costPerMillionTokens: 4000, pricedTokenShare: .5, peakMinuteTpm: 150, peakMinuteAt: '2026-11-10T00:00:00.000Z' });
    report.bots = [{ id: 'bot-a', ...emptyUsageTotals(), totalTokens: 100, records: 1, averageTpm: 75, cacheReadShare: .4 }];
    await act(async () => { renderer = TestRenderer.create(page(report)); });
    const text = (node: TestRenderer.ReactTestInstance): string => node.children.map(c => typeof c === 'string' ? c : text(c)).join('');
    // 排除的未来记录必须有可见提示，不能静默从总量里消失。
    const notices = renderer!.root.findAll(n => n.props.className === 'usage-notice');
    expect(notices).toHaveLength(1); expect(text(notices[0]!)).toContain('2');
    const costCard = renderer!.root.findByProps({ className: 'usage-metrics' }).findAllByType('article').at(-1)!;
    const unitCost = text(costCard.findAllByType('small').at(-1)!);
    expect(unitCost).toContain(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CNY' }).format(4000)); expect(unitCost).toContain('50%');
    const botCells = renderer!.root.findAll(n => n.props.className === 'usage-table')[0]!.findByType('tbody').findAllByType('td').map(text);
    expect(botCells.slice(4, 6)).toEqual(['75', '40%']);
    // 峰值分钟按查询时区（UTC）显示，而不是浏览器时区（Asia/Shanghai）。
    const peakAt = new Date('2026-11-10T00:00:00.000Z');
    const peakHint = text(renderer!.root.findByProps({ 'data-usage-metric': 'peak-tpm' }).findByType('small'));
    expect(peakHint).toBe(peakAt.toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'shortOffset' }));
    expect(peakHint).not.toBe(peakAt.toLocaleString(undefined, { timeZone: 'Asia/Shanghai', timeZoneName: 'shortOffset' }));
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
