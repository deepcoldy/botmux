import React, { useEffect, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { t } from './ui.js';

type Summary = { delivered: number; ratedDeliveries: number; ratings: number; positive: number; negative: number; ratingCoverage: number; positiveRate: number; deliveryFailures: number; outboxFailures: number };
type Trend = { bucket: string; positive: number; negative: number; ratings: number };
type Reason = { reasonKey: string; count: number };
type Delivery = { deliveryId: string; createdAt: string; status?: string; botAppId?: string; chatId?: string; topicRootId?: string; model?: string; cliId?: string; skillName?: string; semantic?: string; reasonKey?: string };

function range(): URLSearchParams { const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000); return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }); }
async function get<T>(path: string, query: URLSearchParams): Promise<T> { const response = await fetch(`${path}?${query}`); if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<T>; }

function FeedbackPage(): React.JSX.Element {
  const [summary, setSummary] = useState<Summary>(); const [trend, setTrend] = useState<Trend[]>([]); const [reasons, setReasons] = useState<Reason[]>([]); const [deliveries, setDeliveries] = useState<Delivery[]>([]); const [cursor, setCursor] = useState<string>(); const [error, setError] = useState('');
  const load = async (next?: string) => { try { setError(''); const q = range(); const [s, tr, rs, ds] = await Promise.all([get<Summary>('/api/feedback/analytics/summary', q), get<{ items: Trend[] }>('/api/feedback/analytics/trend', q), get<{ items: Reason[] }>('/api/feedback/analytics/reasons', q), get<{ items: Delivery[]; nextCursor?: string }>('/api/feedback/analytics/deliveries', new URLSearchParams([...q, ['limit', '25'], ...(next ? [['cursor', next] as [string, string]] : [])]))]); setSummary(s); setTrend(tr.items); setReasons(rs.items); setDeliveries(old => next ? [...old, ...ds.items] : ds.items); setCursor(ds.nextCursor); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { void load(); }, []);
  const maxTrend = Math.max(1, ...trend.map(row => row.ratings)); const maxReason = Math.max(1, ...reasons.map(row => row.count));
  return <div className="page feedback-page"><header className="sect-header"><div><h1>{t('feedback.title')}</h1><p>{t('feedback.subtitle')}</p></div></header>{error && <p className="error-banner">{error}</p>}
    <section className="feedback-kpis">{[['feedback.delivered', summary?.delivered], ['feedback.rated', summary?.ratedDeliveries], ['feedback.coverage', summary ? `${Math.round(summary.ratingCoverage * 100)}%` : undefined], ['feedback.positiveRate', summary ? `${Math.round(summary.positiveRate * 100)}%` : undefined], ['feedback.deliveryFailures', summary?.deliveryFailures], ['feedback.outboxFailures', summary?.outboxFailures]].map(([label, value]) => <article key={String(label)}><span>{t(String(label))}</span><strong>{value ?? '—'}</strong></article>)}</section>
    <div className="feedback-grid"><section className="panel"><h2>{t('feedback.trend')}</h2>{trend.map(row => <div className="feedback-bar" key={row.bucket}><span>{row.bucket}</span><i style={{ width: `${row.ratings / maxTrend * 100}%` }} /><b>{row.positive}/{row.ratings}</b></div>)}</section><section className="panel"><h2>{t('feedback.reasons')}</h2>{reasons.map(row => <div className="feedback-bar negative" key={row.reasonKey}><span>{row.reasonKey}</span><i style={{ width: `${row.count / maxReason * 100}%` }} /><b>{row.count}</b></div>)}</section></div>
    <section className="panel"><h2>{t('feedback.deliveries')}</h2><div className="feedback-deliveries">{deliveries.map(item => <div key={item.deliveryId}><code>{item.deliveryId}</code><span>{item.createdAt}</span><span>{item.botAppId ?? '—'} · {item.model ?? item.cliId ?? '—'}</span><b>{item.semantic ?? item.status ?? 'unrated'}</b></div>)}</div>{cursor && <button className="btn-link feedback-more" onClick={() => void load(cursor)}>{t('feedback.loadMore')}</button>}</section>
  </div>;
}

export function renderFeedbackPage(root: HTMLElement): PageDisposer { return mountReactPage(root, <FeedbackPage />); }
