import { useCallback, useEffect, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { requestJson } from './dashboard-api.js';
import { usageAnalyticsQuery, usageDateRange, type UsagePageFilters, type UsagePreset } from './usage-filters.js';
import type { UsageGroup, UsageReport } from '../usage-types.js';

type Bot = { larkAppId: string; botName?: string; name?: string };
const buckets = ['inputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'outputTokens'] as const;
const bucketLabels = ['usage.input', 'usage.cacheRead', 'usage.cacheCreate', 'usage.output'] as const;
const count = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
const exact = (value: number) => new Intl.NumberFormat().format(value);
const money = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CNY' }).format(value);

function GroupTable({ rows, label }: { rows: UsageGroup[]; label: (id: string) => string }): React.JSX.Element {
  const t = useT();
  return <div className="usage-table-scroll"><table className="usage-table">
    <thead><tr><th>{t('usage.name')}</th><th>{t('usage.prompt')}</th><th>{t('usage.output')}</th><th>{t('usage.cacheRead')}</th><th>{t('usage.total')}</th><th>{t('usage.cost')}</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>
      <th scope="row" title={row.id}>{label(row.id)}</th>
      <td title={exact(row.inputTokens + row.cacheReadTokens + row.cacheCreateTokens)}>{count(row.inputTokens + row.cacheReadTokens + row.cacheCreateTokens)}</td>
      <td title={exact(row.outputTokens)}>{count(row.outputTokens)}</td><td title={exact(row.cacheReadTokens)}>{count(row.cacheReadTokens)}</td>
      <td title={exact(row.totalTokens)}><strong>{count(row.totalTokens)}</strong></td><td>{money(row.costCny)}</td>
    </tr>)}</tbody>
  </table>{!rows.length && <p className="usage-empty">{t('usage.empty')}</p>}</div>;
}

export function UsagePage({ initialData, initialBots = [] }: { initialData?: UsageReport; initialBots?: Bot[] } = {}): React.JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState<UsagePageFilters>(() => ({ ...usageDateRange('7d'), bot: '', model: '' }));
  const [query, setQuery] = useState(() => usageAnalyticsQuery(draft).toString());
  const [bots, setBots] = useState(initialBots);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const request = useRef<AbortController | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const botName = (id: string) => bots.find(bot => bot.larkAppId === id)?.botName || bots.find(bot => bot.larkAppId === id)?.name || id || t('usage.unknownBot');

  useEffect(() => {
    if (initialData) return;
    const controller = new AbortController();
    void requestJson<{ bots: Bot[] }>('/api/bots', { signal: controller.signal })
      .then(body => { if (!controller.signal.aborted) setBots(body.bots); }).catch(() => {});
    return () => controller.abort();
  }, [initialData]);

  const load = useCallback(async (snapshot: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); setData(undefined);
    try {
      const report = await requestJson<UsageReport>(`/api/usage/summary?${snapshot}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(report);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'usage_ledger_unavailable');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!initialData) void load(query);
    return () => request.current?.abort();
  }, [load, query, initialData]);

  const apply = (next: UsagePageFilters) => {
    setDraft(next);
    try {
      const snapshot = usageAnalyticsQuery(next).toString(); setValidation('');
      if (snapshot === query || initialData) void load(snapshot);
      else setQuery(snapshot);
    } catch (e) { setValidation(e instanceof Error ? e.message : 'usage.invalidRange'); }
  };
  const summary = data?.summary;
  const allBots = [...new Set([...bots.map(bot => bot.larkAppId), ...(data?.options.bots ?? []), ...(draft.bot ? [draft.bot] : [])])];
  const allModels = [...new Set([...(data?.options.models ?? []), ...(draft.model ? [draft.model] : [])])];
  const max = Math.max(1, ...(data?.trend.map(row => row.totalTokens) ?? []));
  const metrics = [
    { label: 'usage.total', value: summary?.totalTokens }, { label: 'usage.input', value: summary?.inputTokens },
    { label: 'usage.output', value: summary?.outputTokens }, { label: 'usage.cacheRead', value: summary?.cacheReadTokens },
    { label: 'usage.cacheCreate', value: summary?.cacheCreateTokens },
  ];
  const errorKey = ({ usage_invalid_range: 'usage.invalidRange', usage_range_too_large: 'usage.rangeTooLarge',
    usage_ledger_too_large: 'usage.tooLarge', usage_invalid_timezone: 'usage.invalidTimezone',
    host_admin_required: 'usage.adminRequired' } as Record<string, string>)[error] ?? 'usage.loadError';

  return <div className="page usage-page" aria-busy={loading}>
    <header className="sect-header"><div><h1>{t('usage.title')}</h1><p>{t('usage.subtitle')}</p></div>
      <button type="button" disabled={loading} onClick={() => void load(query)}>{t('usage.refresh')}</button></header>
    <form className="panel usage-filters" onSubmit={event => { event.preventDefault(); apply(draft); }}>
      <div className="usage-filter-fields">
        <label htmlFor="usage-from">{t('usage.from')}<input id="usage-from" type="date" required value={draft.fromDate} onChange={e => setDraft(old => ({ ...old, fromDate: e.target.value }))} /></label>
        <label htmlFor="usage-to">{t('usage.to')}<input id="usage-to" type="date" required value={draft.toDate} onChange={e => setDraft(old => ({ ...old, toDate: e.target.value }))} /></label>
        <label htmlFor="usage-bot">{t('usage.bot')}<select id="usage-bot" value={draft.bot} onChange={e => setDraft(old => ({ ...old, bot: e.target.value }))}>
          <option value="">{t('usage.allBots')}</option>{allBots.map(id => <option key={id} value={id}>{botName(id)}</option>)}</select></label>
        <label htmlFor="usage-model">{t('usage.model')}<select id="usage-model" value={draft.model} onChange={e => setDraft(old => ({ ...old, model: e.target.value }))}>
          <option value="">{t('usage.allModels')}</option>{allModels.map(id => <option key={id}>{id}</option>)}</select></label>
        <button type="submit" className="primary">{t('usage.apply')}</button>
      </div>
      <div className="usage-presets">{(['today', '7d', '30d', 'week', 'month'] as UsagePreset[]).map(preset => <button key={preset} type="button" onClick={() => apply({ ...draft, ...usageDateRange(preset) })}>{t(`usage.preset.${preset}`)}</button>)}</div>
      <p className="usage-hint">{t('usage.timeHint', { timeZone })}</p>
      {validation && <p className="error-banner" role="alert">{t(validation)}</p>}
    </form>
    {error && <p className="error-banner" role="alert">{t(errorKey)}</p>}
    {loading && <p role="status">{t('usage.loading')}</p>}
    {data?.coverage.ledgerMissing && <p role="status" className="usage-notice">{t('usage.noLedger')}</p>}
    {data && data.coverage.invalidRecords > 0 && <p role="status" className="usage-notice">{t('usage.skipped', { count: data.coverage.invalidRecords })}</p>}
    {data && <p className="usage-hint">{t('usage.appliedRange', {
      from: new Date(data.query.from).toLocaleDateString(undefined, { timeZone: data.query.timeZone }),
      to: new Date(Date.parse(data.query.to) - 1).toLocaleDateString(undefined, { timeZone: data.query.timeZone }),
    })}</p>}
    <section className="usage-metrics">{metrics.map(metric => <article className="metric-card" key={metric.label}>
      <span>{t(metric.label)}</span><strong title={metric.value === undefined ? undefined : exact(metric.value)}>{metric.value === undefined || data?.coverage.ledgerMissing ? '—' : count(metric.value)}</strong>
    </article>)}<article className="metric-card"><span>{t('usage.cost')}</span><strong>{money(summary?.costCny ?? null)}</strong>
      <small>{summary ? t('usage.costCoverage', { priced: summary.pricedRecords, count: summary.records }) : t('usage.costHint')}</small></article></section>
    <section className="panel usage-trend"><h2>{t('usage.trend')}</h2>
      <div className="usage-legend">{buckets.map((bucket, i) => <span key={bucket}><i className={`usage-color-${bucket}`} />{t(bucketLabels[i]!)}</span>)}</div>
      {data && summary?.records ? <div className="usage-chart-scroll"><div className="usage-chart" style={{ minWidth: Math.max(480, data.trend.length * 24) }}>
        {data.trend.map((row, i) => <div className="usage-chart-day" key={row.id} tabIndex={0} aria-label={`${row.id}: ${exact(row.totalTokens)} tokens`} title={`${row.id}\n${buckets.map((bucket, j) => `${t(bucketLabels[j]!)}: ${exact(row[bucket])}`).join('\n')}`}>
          <div className="usage-chart-stack">{buckets.map(bucket => <i key={bucket} className={`usage-color-${bucket}`} style={{ height: `${row[bucket] / max * 100}%` }} />)}</div>
          <small>{i % Math.max(1, Math.ceil(data.trend.length / 15)) === 0 ? row.id.slice(5) : '\u00a0'}</small>
        </div>)}
      </div></div> : <p className="usage-empty">{loading ? t('usage.loading') : error ? t('usage.loadError') : t('usage.empty')}</p>}
    </section>
    {data && <><div className="usage-breakdowns"><section className="panel"><h2>{t('usage.byBot')}</h2><GroupTable rows={data.bots} label={botName} /></section>
      <section className="panel"><h2>{t('usage.byModel')}</h2><GroupTable rows={data.models} label={id => id || t('usage.unknownModel')} /></section></div>
      <section className="panel"><h2>{t('usage.sessions')}</h2><p className="usage-hint">{t('usage.sessionHint', { shown: data.sessions.length, count: data.sessionCount })}</p>
        <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>{t('usage.session')}</th><th>{t('usage.bot')}</th><th>{t('usage.total')}</th><th>{t('usage.records')}</th></tr></thead>
          <tbody>{data.sessions.map(row => <tr key={`${row.bot}:${row.id}`}><th scope="row" title={row.id}>{row.title || row.id}</th><td>{botName(row.bot)}</td><td title={exact(row.totalTokens)}>{count(row.totalTokens)}</td><td>{row.records}</td></tr>)}</tbody></table>
          {!data.sessions.length && <p className="usage-empty">{t('usage.empty')}</p>}</div></section>
      <p className="usage-hint">{t('usage.recordHint')}</p><p className="usage-hint">{t('usage.updated', { time: new Date(data.generatedAt).toLocaleString() })}</p>
    </>}
  </div>;
}

export function renderUsagePage(root: HTMLElement): PageDisposer { return mountReactPage(root, <UsagePage />); }
