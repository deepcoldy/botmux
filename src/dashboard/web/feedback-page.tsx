import React, { useCallback, useEffect, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { t } from './ui.js';
import { feedbackAnalyticsQuery, feedbackDateRange, type FeedbackPageFilters } from './feedback-filters.js';

type Summary = { delivered: number; ratedDeliveries: number; ratings: number; positive: number; negative: number; ratingCoverage: number; positiveRate: number; deliveryFailures: number; outboxFailures: number };
type Trend = { bucket: string; positive: number; negative: number; ratings: number };
type Reason = { reasonKey: string; count: number };
type Delivery = { deliveryId: string; createdAt: string; status?: string; botAppId?: string; chatId?: string; topicRootId?: string; model?: string; cliId?: string; skillName?: string; semantic?: string; reasonKey?: string };
type DeliveryPage = { items: Delivery[]; nextCursor?: string };
type Analytics = { summary: Summary; trend: Trend[]; reasons: Reason[]; deliveries: Delivery[]; cursor?: string };
type Bot = { larkAppId: string; botName?: string; name?: string };

async function get<T>(path: string, query: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch(query.size ? path + '?' + query : path, { signal });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export function FeedbackPage(): React.JSX.Element {
  const [draft, setDraft] = useState<FeedbackPageFilters>(() => ({ ...feedbackDateRange(30), botAppId: '' }));
  const [query, setQuery] = useState(() => feedbackAnalyticsQuery(draft).toString());
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsError, setBotsError] = useState(false);
  const [data, setData] = useState<Analytics>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void get<{ bots: Bot[] }>('/api/bots', new URLSearchParams(), controller.signal)
      .then(body => { if (!controller.signal.aborted) setBots(body.bots); })
      .catch(() => { if (!controller.signal.aborted) setBotsError(true); });
    return () => controller.abort();
  }, []);

  const load = useCallback(async (snapshot: string, next?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    if (!next) setData(undefined);
    const q = new URLSearchParams(snapshot);
    const pageQuery = new URLSearchParams(q);
    pageQuery.set('limit', '25');
    if (next) pageQuery.set('cursor', next);
    try {
      if (next) {
        const page = await get<DeliveryPage>('/api/feedback/analytics/deliveries', pageQuery, controller.signal);
        if (!controller.signal.aborted) setData(old => old && { ...old, deliveries: [...old.deliveries, ...page.items], cursor: page.nextCursor });
      } else {
        const [summary, trend, reasons, page] = await Promise.all([
          get<Summary>('/api/feedback/analytics/summary', q, controller.signal),
          get<{ items: Trend[] }>('/api/feedback/analytics/trend', q, controller.signal),
          get<{ items: Reason[] }>('/api/feedback/analytics/reasons', q, controller.signal),
          get<DeliveryPage>('/api/feedback/analytics/deliveries', pageQuery, controller.signal),
        ]);
        if (!controller.signal.aborted) setData({ summary, trend: trend.items, reasons: reasons.items, deliveries: page.items, cursor: page.nextCursor });
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(query);
    return () => request.current?.abort();
  }, [load, query]);

  const apply = (filters: FeedbackPageFilters) => {
    setDraft(filters);
    try {
      const next = feedbackAnalyticsQuery(filters).toString();
      setValidation('');
      if (next === query) void load(next);
      else setQuery(next);
    } catch (e) {
      setValidation(t(e instanceof Error ? e.message : 'feedback.invalidRange'));
    }
  };
  const preset = (days: 1 | 7 | 30) => apply({ ...draft, ...feedbackDateRange(days) });
  const summary = data?.summary;
  const trend = data?.trend ?? [];
  const reasons = data?.reasons ?? [];
  const maxTrend = Math.max(1, ...trend.map(row => row.ratings));
  const maxReason = Math.max(1, ...reasons.map(row => row.count));
  return <div className="page feedback-page" aria-busy={loading}>
    <header className="sect-header"><div><h1>{t('feedback.title')}</h1><p>{t('feedback.subtitle')}</p></div></header>
    <form className="panel feedback-filters" onSubmit={event => { event.preventDefault(); apply(draft); }}>
      <div className="feedback-filter-fields">
        <label htmlFor="feedback-from">{t('feedback.from')}<input id="feedback-from" type="date" required value={draft.fromDate} onChange={event => setDraft(old => ({ ...old, fromDate: event.target.value }))} /></label>
        <label htmlFor="feedback-to">{t('feedback.to')}<input id="feedback-to" type="date" required value={draft.toDate} onChange={event => setDraft(old => ({ ...old, toDate: event.target.value }))} /></label>
        <label htmlFor="feedback-bot">{t('feedback.bot')}<select id="feedback-bot" value={draft.botAppId} onChange={event => setDraft(old => ({ ...old, botAppId: event.target.value }))}>
          <option value="">{t('feedback.allBots')}</option>
          {bots.map(bot => <option key={bot.larkAppId} value={bot.larkAppId}>{bot.botName || bot.name || bot.larkAppId}</option>)}
        </select></label>
        <button type="submit" className="primary">{t('feedback.apply')}</button>
        <div className="feedback-presets">
          {([1, 7, 30] as const).map(days => <button key={days} type="button" onClick={() => preset(days)}>{t(days === 1 ? 'feedback.today' : 'feedback.lastDays', { days })}</button>)}
        </div>
      </div>
      <p className="feedback-filter-hint">{t('feedback.timeHint', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>
      {botsError && <p role="status">{t('feedback.botsError')}</p>}
      {validation && <p className="error-banner" role="alert">{validation}</p>}
    </form>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {loading && <p role="status">{t('feedback.loading')}</p>}
    <section className="feedback-kpis">{[['feedback.delivered', summary?.delivered], ['feedback.rated', summary?.ratedDeliveries], ['feedback.coverage', summary ? Math.round(summary.ratingCoverage * 100) + '%' : undefined], ['feedback.positiveRate', summary ? Math.round(summary.positiveRate * 100) + '%' : undefined], ['feedback.deliveryFailures', summary?.deliveryFailures], ['feedback.outboxFailures', summary?.outboxFailures]].map(([label, value]) => <article key={String(label)}><span>{t(String(label))}</span><strong>{value ?? '—'}</strong></article>)}</section>
    <div className="feedback-grid"><section className="panel"><h2>{t('feedback.trend')} <small>UTC</small></h2>{trend.map(row => <div className="feedback-bar" key={row.bucket}><span>{row.bucket}</span><i style={{ width: row.ratings / maxTrend * 100 + '%' }} /><b>{row.positive}/{row.ratings}</b></div>)}</section><section className="panel"><h2>{t('feedback.reasons')}</h2>{reasons.map(row => <div className="feedback-bar negative" key={row.reasonKey}><span>{row.reasonKey}</span><i style={{ width: row.count / maxReason * 100 + '%' }} /><b>{row.count}</b></div>)}</section></div>
    <section className="panel"><h2>{t('feedback.deliveries')}</h2><div className="feedback-deliveries">{data?.deliveries.map(item => <div key={item.deliveryId}><code>{item.deliveryId}</code><span>{item.createdAt}</span><span>{item.botAppId ?? '—'} · {item.model ?? item.cliId ?? '—'}</span><b>{item.semantic ?? item.status ?? 'unrated'}</b></div>)}</div>{data && !data.deliveries.length && <p>{t('feedback.empty')}</p>}{data?.cursor && <button className="btn-link feedback-more" disabled={loading} onClick={() => void load(query, data.cursor)}>{t('feedback.loadMore')}</button>}</section>
  </div>;
}

export function renderFeedbackPage(root: HTMLElement): PageDisposer { return mountReactPage(root, <FeedbackPage />); }
