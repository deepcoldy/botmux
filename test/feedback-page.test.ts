import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPage } from '../src/dashboard/web/feedback-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Request = { url: URL; signal?: AbortSignal | null };
const requests: Request[] = [];
const response = (body: unknown, ok = true) => ({ ok, json: async () => body, text: async () => 'unavailable' }) as Response;
const summary = (delivered: number) => ({ delivered, ratedDeliveries: 1, ratings: 1, positive: 1, negative: 0, ratingCoverage: 1 / delivered, positiveRate: 1, deliveryFailures: 0, outboxFailures: 0 });

function mockApi(intercept?: (request: Request) => Promise<Response> | Response | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const request = { url: new URL(input, 'http://localhost'), signal: init?.signal };
    requests.push(request);
    const override = intercept?.(request);
    if (override) return override;
    const url = request.url;
    if (url.pathname === '/api/bots') return response({ bots: [{ larkAppId: 'app-a', botName: 'Bot A' }, { larkAppId: 'app-b', botName: 'Bot B' }] });
    if (url.pathname.endsWith('/summary')) return response(summary(url.searchParams.get('bot') ? 2 : 6));
    if (url.pathname.endsWith('/deliveries')) return response({ items: [{ deliveryId: (url.searchParams.get('bot') || 'all') + (url.searchParams.has('cursor') ? '-next' : '-first'), createdAt: '2026-10-27T10:00:00.000Z' }], nextCursor: url.searchParams.has('cursor') ? undefined : 'page-2' });
    return response({ items: [] });
  }));
}

let renderer: TestRenderer.ReactTestRenderer | undefined;
async function render() { await act(async () => { renderer = TestRenderer.create(React.createElement(FeedbackPage)); }); return renderer!.root; }
const change = (id: string, value: string) => act(() => renderer!.root.findByProps({ id }).props.onChange({ target: { value } }));
const submit = () => act(async () => { renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
const analytics = () => requests.filter(request => request.url.pathname.startsWith('/api/feedback/analytics/'));
const deliveryIds = () => renderer!.root.findAllByType('code').map(node => node.children.join(''));
const delivered = () => renderer!.root.findByProps({ className: 'feedback-kpis' }).findAllByType('strong')[0]!.children.join('');
const more = () => renderer!.root.findByProps({ className: 'btn-link feedback-more' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('feedback page filtering', () => {
  beforeEach(() => {
    requests.length = 0;
    vi.stubEnv('TZ', 'Asia/Shanghai');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T12:00:00+08:00'));
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('applies one date/bot snapshot to every panel and resets old pages', async () => {
    mockApi();
    await render();
    expect(delivered()).toBe('6');
    expect(deliveryIds()).toEqual(['all-first']);
    await act(async () => more().props.onClick());
    expect(deliveryIds()).toEqual(['all-first', 'all-next']);
    requests.length = 0;
    change('feedback-from', '2026-10-27');
    change('feedback-to', '2026-10-27');
    change('feedback-bot', 'app-a');
    expect(analytics()).toHaveLength(0);
    await submit();
    expect(analytics()).toHaveLength(4);
    for (const { url } of analytics()) {
      expect(url.searchParams.get('from')).toBe('2026-10-26T16:00:00.000Z');
      expect(url.searchParams.get('to')).toBe('2026-10-27T16:00:00.000Z');
      expect(url.searchParams.get('bot')).toBe('app-a');
      expect(url.searchParams.has('cursor')).toBe(false);
    }
    expect(delivered()).toBe('2');
    expect(deliveryIds()).toEqual(['app-a-first']);

    // Unsaved edits and a midnight rollover must not change the next page's cohort.
    requests.length = 0;
    change('feedback-from', '2026-10-01');
    vi.setSystemTime(new Date('2026-10-28T01:00:00+08:00'));
    await act(async () => more().props.onClick());
    expect(analytics()).toHaveLength(1);
    expect(analytics()[0]!.url.searchParams.get('from')).toBe('2026-10-26T16:00:00.000Z');
    expect(analytics()[0]!.url.searchParams.get('cursor')).toBe('page-2');
    expect(deliveryIds()).toEqual(['app-a-first', 'app-a-next']);
  });

  it('ignores a late initial response after applying another bot', async () => {
    const old = deferred<Response>();
    mockApi(({ url }) => url.pathname.endsWith('/summary') && !url.searchParams.has('bot') ? old.promise : undefined);
    await render();
    const first = analytics()[0]!;
    change('feedback-bot', 'app-a');
    await submit();
    expect(first.signal?.aborted).toBe(true);
    expect(delivered()).toBe('2');
    await act(async () => old.resolve(response(summary(999))));
    expect(delivered()).toBe('2');
    expect(deliveryIds()).toEqual(['app-a-first']);
  });

  it('ignores an old in-flight page when filters change', async () => {
    const oldPage = deferred<Response>();
    mockApi(({ url }) => url.searchParams.has('cursor') ? oldPage.promise : undefined);
    await render();
    await act(async () => { void more().props.onClick(); });
    expect(more().props.disabled).toBe(true);
    change('feedback-bot', 'app-b');
    await submit();
    await act(async () => oldPage.resolve(response({ items: [{ deliveryId: 'stale-page' }] })));
    expect(deliveryIds()).toEqual(['app-b-first']);
  });

  it('rejects invalid ranges without requesting or relabeling the loaded result', async () => {
    mockApi();
    await render();
    requests.length = 0;
    change('feedback-from', '2026-10-28');
    await submit();
    expect(analytics()).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    expect(delivered()).toBe('6');
    change('feedback-from', '2024-01-01');
    await submit();
    expect(analytics()).toHaveLength(0);
  });

  it('applies quick ranges immediately while keeping the selected bot', async () => {
    mockApi();
    const root = await render();
    change('feedback-bot', 'app-a');
    const presets = root.findByProps({ className: 'feedback-presets' }).findAllByType('button');
    for (const [index, from] of ['2026-10-26T16:00:00.000Z', '2026-10-20T16:00:00.000Z', '2026-09-27T16:00:00.000Z'].entries()) {
      requests.length = 0;
      await act(async () => presets[index]!.props.onClick());
      expect(analytics()).toHaveLength(4);
      expect(analytics()[0]!.url.searchParams.get('from')).toBe(from);
      expect(analytics()[0]!.url.searchParams.get('bot')).toBe('app-a');
    }
  });

  it('keeps the last page on a pagination error and allows a retry', async () => {
    let fail = true;
    mockApi(({ url }) => url.searchParams.has('cursor') && fail ? response({}, false) : undefined);
    await render();
    await act(async () => more().props.onClick());
    expect(deliveryIds()).toEqual(['all-first']);
    expect(more().props.disabled).toBe(false);
    expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    fail = false;
    await act(async () => more().props.onClick());
    expect(deliveryIds()).toEqual(['all-first', 'all-next']);
  });

  it('clears stale statistics if a new query fails and can query again', async () => {
    let fail = true;
    mockApi(({ url }) => url.searchParams.has('bot') && fail ? response({}, false) : undefined);
    await render();
    change('feedback-bot', 'app-a');
    await submit();
    expect(deliveryIds()).toEqual([]);
    expect(delivered()).toBe('—');
    expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    fail = false;
    await submit();
    expect(delivered()).toBe('2');
  });

  it('loads all-bot statistics even if the bot roster fails', async () => {
    mockApi(({ url }) => url.pathname === '/api/bots' ? response({}, false) : undefined);
    await render();
    expect(delivered()).toBe('6');
    expect(renderer!.root.findAllByProps({ role: 'status' })).toHaveLength(1);
  });
});
