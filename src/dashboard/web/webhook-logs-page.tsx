import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, LoadingState, dropdownLabel } from './dashboard-components.js';
import { jget } from './dashboard-api.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';

type LogStatus = '' | 'ok' | 'error';
type TimeWindow = '24h' | '7d' | '30d' | 'all';

interface Connector {
  id: string;
  name: string;
  enabled: boolean;
}

interface TriggerLogRequest {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
  bodyBytes?: number;
  payload?: unknown;
  payloadStored?: boolean;
  payloadOmittedReason?: 'disabled' | 'too_large' | 'not_available';
}

interface TriggerLogEntry {
  triggerId: string;
  connectorId?: string;
  requestId?: string;
  action: string;
  status: 'ok' | 'error';
  error?: string;
  errorCode?: string;
  createdAt: string;
  request?: TriggerLogRequest;
  target?: {
    kind?: string;
    mode?: string;
    botId?: string;
    chatId?: string;
    sessionId?: string;
    rootMessageId?: string;
    workflowId?: string;
  };
  response?: {
    httpStatus: number;
    durationMs: number;
    sessionId?: string;
    workflowRunId?: string;
    chatId?: string;
  };
}

interface TriggerLogSummary {
  total: number;
  ok: number;
  error: number;
  successRate: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  lastTriggeredAt?: string;
}

interface Filters {
  connectorId: string;
  status: LogStatus;
  timeWindow: TimeWindow;
  query: string;
}

const PAGE_SIZE = 50;
const EMPTY_SUMMARY: TriggerLogSummary = { total: 0, ok: 0, error: 0, successRate: 0 };

function sinceForWindow(value: TimeWindow, now = Date.now()): string | undefined {
  if (value === 'all') return undefined;
  const hours = value === '24h' ? 24 : value === '7d' ? 24 * 7 : 24 * 30;
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

export function buildWebhookLogSearchParams(filters: Filters, offset = 0): URLSearchParams {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (filters.connectorId) params.set('connectorId', filters.connectorId);
  if (filters.status) params.set('status', filters.status);
  const since = sinceForWindow(filters.timeWindow);
  if (since) params.set('since', since);
  if (filters.query.trim()) params.set('q', filters.query.trim());
  return params;
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function JsonBlock(props: { value: unknown; empty: string; fullHeight?: boolean }): JSX.Element {
  if (props.value === undefined || props.value === null) return <p className="webhook-log-detail-empty">{props.empty}</p>;
  if (typeof props.value === 'object' && !Array.isArray(props.value) && Object.keys(props.value as object).length === 0) {
    return <p className="webhook-log-detail-empty">{props.empty}</p>;
  }
  return <pre className={`webhook-log-json${props.fullHeight ? ' full-height' : ''}`}><code>{JSON.stringify(props.value, null, 2)}</code></pre>;
}

function TargetFacts(props: { value: TriggerLogEntry['target'] }): JSX.Element {
  const items = [
    ['kind', props.value?.kind],
    ['mode', props.value?.mode],
    ['botId', props.value?.botId],
    ['chatId', props.value?.chatId],
    ['sessionId', props.value?.sessionId],
    ['rootMessageId', props.value?.rootMessageId],
    ['workflowId', props.value?.workflowId],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!items.length) return <p className="webhook-log-detail-empty">{'—'}</p>;
  return (
    <dl className="webhook-log-target-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><code>{String(value)}</code></dd>
        </div>
      ))}
    </dl>
  );
}

function LogFilterMenu<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange(value: T): void;
}): JSX.Element {
  return (
    <DropdownMenu
      id={props.id}
      className="webhook-log-filter-menu"
      ariaLabel={props.label}
      style={{ width: '100%', minWidth: 0 }}
      value={props.value}
      label={dropdownLabel(props.options, props.value)}
      options={props.options}
      onChange={props.onChange}
    />
  );
}

function MetricCard(props: { label: string; value: string | number; tone?: 'ok' | 'error'; hint?: string }): JSX.Element {
  return (
    <article className={`card webhook-log-metric${props.tone ? ` ${props.tone}` : ''}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.hint || '\u00a0'}</small>
    </article>
  );
}

export function WebhookLogsContent(props: { embedded?: boolean } = {}): JSX.Element {
  const tr = useT();
  const mountedRef = useRef(false);
  const logsRef = useRef<TriggerLogEntry[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [logs, setLogs] = useState<TriggerLogEntry[]>([]);
  const [summary, setSummary] = useState<TriggerLogSummary>(EMPTY_SUMMARY);
  const [filters, setFilters] = useState<Filters>({ connectorId: '', status: '', timeWindow: '7d', query: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const connectorNames = useMemo(() => new Map(connectors.map(connector => [connector.id, connector.name])), [connectors]);
  const selected = useMemo(() => logs.find(log => log.triggerId === selectedId) ?? logs[0] ?? null, [logs, selectedId]);
  const connectorOptions = useMemo(() => [
    { value: '', label: tr('webhookLogs.allConnectors') },
    ...connectors.map(connector => ({ value: connector.id, label: connector.name })),
  ], [connectors, tr]);
  const statusOptions = useMemo(() => [
    { value: '' as LogStatus, label: tr('webhookLogs.allStatuses') },
    { value: 'ok' as LogStatus, label: tr('webhookLogs.success') },
    { value: 'error' as LogStatus, label: tr('webhookLogs.failed') },
  ], [tr]);
  const timeOptions = useMemo(() => [
    { value: '24h' as TimeWindow, label: tr('webhookLogs.last24h') },
    { value: '7d' as TimeWindow, label: tr('webhookLogs.last7d') },
    { value: '30d' as TimeWindow, label: tr('webhookLogs.last30d') },
    { value: 'all' as TimeWindow, label: tr('webhookLogs.allTime') },
  ], [tr]);

  const load = useCallback(async (append = false, quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError('');
    const offset = append ? logsRef.current.length : 0;
    const params = buildWebhookLogSearchParams(filters, offset);
    const summaryParams = new URLSearchParams(params);
    summaryParams.delete('limit');
    summaryParams.delete('offset');
    try {
      const [logResult, summaryResult] = await Promise.all([
        jget(`/api/trigger-logs?${params}`),
        append ? Promise.resolve(null) : jget(`/api/trigger-logs/summary?${summaryParams}`),
      ]);
      if (!mountedRef.current) return;
      if (logResult.status !== 200) throw new Error(String(logResult.body?.error || logResult.status));
      const next = Array.isArray(logResult.body?.logs) ? logResult.body.logs as TriggerLogEntry[] : [];
      const merged = append ? [...logsRef.current, ...next] : next;
      logsRef.current = merged;
      setLogs(merged);
      setTotal(Number(logResult.body?.total ?? next.length));
      setHasMore(logResult.body?.hasMore === true);
      if (!append) {
        setSummary(summaryResult?.status === 200 ? summaryResult.body?.summary ?? EMPTY_SUMMARY : EMPTY_SUMMARY);
        setSelectedId(current => next.some(log => log.triggerId === current) ? current : (next[0]?.triggerId ?? null));
      }
    } catch (cause: any) {
      if (mountedRef.current) setError(cause?.message || tr('webhookLogs.loadFailed'));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [filters, tr]);

  useEffect(() => {
    mountedRef.current = true;
    void jget('/api/connectors').then(result => {
      if (mountedRef.current && result.status === 200) setConnectors(Array.isArray(result.body?.connectors) ? result.body.connectors : []);
    });
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(false), filters.query ? 260 : 0);
    return () => clearTimeout(timer);
  }, [filters, load]);

  useEffect(() => {
    const timer = setInterval(() => void load(false, true), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function copySelected(): Promise<void> {
    if (!selected) return;
    await navigator.clipboard?.writeText(JSON.stringify(selected, null, 2));
    setCopied(true);
    setTimeout(() => mountedRef.current && setCopied(false), 1200);
  }

  const payloadMessage = selected?.request?.payloadOmittedReason === 'disabled'
    ? tr('webhookLogs.payloadDisabled')
    : selected?.request?.payloadOmittedReason === 'too_large'
      ? tr('webhookLogs.payloadTooLarge')
      : tr('webhookLogs.payloadUnavailable');

  const body = (
    <>
      {!props.embedded ? (
        <div className="page-heading">
          <div>
            <p className="eyebrow">{tr('nav.connectors')}</p>
            <h1>{tr('nav.webhookLogs')}</h1>
            <p className="webhook-log-heading-copy">{tr('webhookLogs.subtitle')}</p>
          </div>
          <div className="page-heading-actions">
            <span className={`webhook-log-live${refreshing ? ' refreshing' : ''}`}><i />{tr('webhookLogs.autoRefresh')}</span>
            <a className="button page-primary-action" href="#/connectors">{tr('webhookLogs.manage')}</a>
          </div>
        </div>
      ) : null}

      <section className="webhook-log-metrics" aria-label={tr('webhookLogs.summary')}>
        <MetricCard label={tr('webhookLogs.total')} value={summary.total} hint={tr('webhookLogs.filteredRange')} />
        <MetricCard label={tr('webhookLogs.successRate')} value={`${summary.successRate.toFixed(summary.successRate % 1 ? 1 : 0)}%`} tone="ok" hint={`${summary.ok} ${tr('webhookLogs.calls')}`} />
        <MetricCard label={tr('webhookLogs.failures')} value={summary.error} tone={summary.error ? 'error' : undefined} hint={summary.error ? tr('webhookLogs.needsReview') : tr('webhookLogs.noFailures')} />
        <MetricCard label={tr('webhookLogs.p95')} value={formatDuration(summary.p95DurationMs)} hint={`${tr('webhookLogs.average')} ${formatDuration(summary.avgDurationMs)}`} />
      </section>

      <form className="filters dashboard-toolbar webhook-log-toolbar" onSubmit={event => event.preventDefault()}>
        <input
          type="search"
          name="q"
          aria-label={tr('webhookLogs.search')}
          placeholder={tr('webhookLogs.searchPlaceholder')}
          value={filters.query}
          onChange={event => {
            // React may defer the functional updater until after the synthetic
            // event has cleared currentTarget. Snapshot the DOM value first.
            const query = event.currentTarget.value;
            setFilters(current => ({ ...current, query }));
          }}
        />
        <LogFilterMenu id="webhook-log-connector" label={tr('webhookLogs.connector')} value={filters.connectorId} options={connectorOptions} onChange={connectorId => setFilters(current => ({ ...current, connectorId }))} />
        <LogFilterMenu id="webhook-log-status" label={tr('webhookLogs.status')} value={filters.status} options={statusOptions} onChange={status => setFilters(current => ({ ...current, status }))} />
        <LogFilterMenu id="webhook-log-window" label={tr('webhookLogs.timeRange')} value={filters.timeWindow} options={timeOptions} onChange={timeWindow => setFilters(current => ({ ...current, timeWindow }))} />
        <button type="button" className="ghost webhook-log-refresh" disabled={refreshing} onClick={() => void load(false, true)}>{tr('webhookLogs.refresh')}</button>
      </form>

      {error ? <p className="err webhook-log-error">{tr('webhookLogs.loadFailed')}: {error}</p> : null}
      <section className="webhook-log-workspace">
        <article className="card webhook-log-list-panel">
          <header className="webhook-log-panel-head">
            <div><strong>{tr('webhookLogs.records')}</strong><span>{tr('webhookLogs.matching', { count: total })}</span></div>
          </header>
          {loading && !logs.length ? <LoadingState label={tr('webhookLogs.loading')} compact /> : null}
          {!loading && !logs.length ? (
            <div className="webhook-log-empty"><span aria-hidden="true">◎</span><strong>{tr('webhookLogs.empty')}</strong><p>{tr('webhookLogs.emptyHint')}</p></div>
          ) : null}
          <div className="webhook-log-list" role="listbox" aria-label={tr('webhookLogs.records')}>
            {logs.map(log => {
              const active = selected?.triggerId === log.triggerId;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`webhook-log-row${active ? ' active' : ''}`}
                  key={`${log.triggerId}-${log.createdAt}`}
                  onClick={() => setSelectedId(log.triggerId)}
                >
                  <span className={`webhook-log-status-dot ${log.status}`} aria-hidden="true" />
                  <span className="webhook-log-row-main">
                    <span className="webhook-log-row-title"><strong>{connectorNames.get(log.connectorId || '') || log.connectorId || tr('webhookLogs.unknownConnector')}</strong><code>{log.request?.method || 'POST'}</code></span>
                    <span className="webhook-log-row-meta"><span>{formatDate(log.createdAt)}</span><span>{log.errorCode || log.action}</span></span>
                  </span>
                  <span className="webhook-log-row-result">
                    <b className={log.status}>{log.response?.httpStatus ?? (log.status === 'ok' ? '2xx' : 'ERR')}</b>
                    <small>{formatDuration(log.response?.durationMs)}</small>
                  </span>
                </button>
              );
            })}
          </div>
          {hasMore ? <button type="button" className="ghost webhook-log-more" disabled={loading} onClick={() => void load(true)}>{tr('webhookLogs.loadMore')}</button> : null}
        </article>

        <article className="card webhook-log-detail-panel">
          {!selected ? <div className="webhook-log-empty"><strong>{tr('webhookLogs.selectRecord')}</strong></div> : (
            <>
              <header className="webhook-log-detail-head">
                <div>
                  <span className={`webhook-log-result-pill ${selected.status}`}>{selected.status === 'ok' ? tr('webhookLogs.success') : tr('webhookLogs.failed')}</span>
                  <h2>{connectorNames.get(selected.connectorId || '') || selected.connectorId || tr('webhookLogs.unknownConnector')}</h2>
                  <p>{formatDate(selected.createdAt)} · {selected.request?.method || 'POST'} {selected.request?.path || '/webhook/…'}</p>
                </div>
                <button type="button" className="ghost" onClick={() => void copySelected()}>{copied ? tr('webhookLogs.copied') : tr('webhookLogs.copyJson')}</button>
              </header>

              {selected.error ? <div className="webhook-log-failure"><strong>{selected.errorCode || tr('webhookLogs.failureReason')}</strong><span>{selected.error}</span></div> : null}

              <section className="webhook-log-detail-section">
                <h3>{tr('webhookLogs.overview')}</h3>
                <dl className="webhook-log-facts">
                  <div><dt>{tr('webhookLogs.httpStatus')}</dt><dd>{selected.response?.httpStatus ?? '—'}</dd></div>
                  <div><dt>{tr('webhookLogs.duration')}</dt><dd>{formatDuration(selected.response?.durationMs)}</dd></div>
                  <div><dt>{tr('webhookLogs.action')}</dt><dd>{selected.action}</dd></div>
                  <div><dt>{tr('webhookLogs.bodySize')}</dt><dd>{formatBytes(selected.request?.bodyBytes)}</dd></div>
                  <div><dt>Trigger ID</dt><dd><code>{selected.triggerId}</code></dd></div>
                  <div><dt>Request ID</dt><dd><code>{selected.requestId || '—'}</code></dd></div>
                  <div><dt>{tr('webhookLogs.remoteAddress')}</dt><dd><code>{selected.request?.remoteAddress || '—'}</code></dd></div>
                  <div><dt>{tr('webhookLogs.target')}</dt><dd><code>{selected.target?.chatId || selected.target?.sessionId || selected.response?.chatId || '—'}</code></dd></div>
                </dl>
              </section>

              <section className="webhook-log-detail-section">
                <h3>{tr('webhookLogs.queryParams')}</h3>
                <JsonBlock value={selected.request?.query} empty={tr('webhookLogs.none')} />
              </section>
              <section className="webhook-log-detail-section">
                <h3>{tr('webhookLogs.headers')}<small>{tr('webhookLogs.redacted')}</small></h3>
                <JsonBlock value={selected.request?.headers} empty={tr('webhookLogs.headersNotStored')} />
              </section>
              <section className="webhook-log-detail-section">
                <h3>{tr('webhookLogs.payload')}<small>{tr('webhookLogs.redacted')}</small></h3>
                {selected.request?.payloadStored ? <JsonBlock value={selected.request.payload} empty={tr('webhookLogs.none')} /> : <p className="webhook-log-detail-empty">{payloadMessage}</p>}
              </section>
              <section className="webhook-log-detail-section">
                <h3>{tr('webhookLogs.routeTarget')}</h3>
                <TargetFacts value={selected.target} />
              </section>
            </>
          )}
        </article>
      </section>
    </>
  );
  return props.embedded
    ? <section className="webhook-logs-content webhook-logs-panel">{body}</section>
    : <section className="page webhook-logs-content webhook-logs-page">{body}</section>;
}

export function renderWebhookLogsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <WebhookLogsContent />);
}
