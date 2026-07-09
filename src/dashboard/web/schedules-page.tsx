import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';
import {
  DropdownMenu,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverviewListTail,
} from './dashboard-components.js';

type ScheduleRow = Record<string, any> & { id: string };
type ScheduleAction = 'run' | 'pause' | 'resume' | 'delivery';
type ActionFeedback = 'success' | 'error';
const RUN_ACTION_MIN_PENDING_MS = 1000;

export interface ScheduleFilters {
  q: string;
  kind: string;
  enabledOnly: boolean;
}

export function fmtScheduleDate(s?: string, timeZone?: string): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString(undefined, timeZone ? { timeZone, timeZoneName: 'short' } : undefined);
  } catch { return s; }
}

export function filterSchedules(rows: ScheduleRow[], filters: ScheduleFilters): ScheduleRow[] {
  const q = filters.q.toLowerCase();
  return rows
    .filter(s => !filters.kind || s.parsed?.kind === filters.kind)
    .filter(s => !filters.enabledOnly || s.enabled)
    .filter(s => !q || JSON.stringify(s).toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const aN = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
      const bN = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
      return aN - bN;
    });
}

function deliveryLabel(s: ScheduleRow, tr: ReturnType<typeof useT>): string {
  if (s.deliver === 'new-topic') return tr('schedules.deliveryNewTopic');
  if (s.deliver === 'local') return tr('schedules.deliveryLocal');
  return tr('schedules.deliveryOrigin');
}

function repeatLabel(s: ScheduleRow): string {
  if (!s.repeat) return '—';
  return `${s.repeat.completed}/${s.repeat.times ?? '∞'}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function ScheduleRowCard(props: {
  schedule: ScheduleRow;
  scheduleTimeZone?: string;
  pending: string | null;
  feedback: Record<string, ActionFeedback>;
  tr: ReturnType<typeof useT>;
  onAction(id: string, op: ScheduleAction): void;
}) {
  const { schedule: s, scheduleTimeZone, tr } = props;
  const kind = String(s.parsed?.kind ?? 'unknown');
  const toggleOp: ScheduleAction = s.enabled ? 'pause' : 'resume';
  const toggleKey = `${s.id}:${toggleOp}`;
  const runKey = `${s.id}:run`;
  const deliveryKey = `${s.id}:delivery`;
  return (
    <OverviewListItem kind="schedule" className="schedule-list-row" data-id={s.id}>
      <OverviewListMain>
        <div className="schedule-row-head">
          <b>{s.name ?? s.id}</b>
          <span className={`schedule-state ${s.enabled ? 'enabled' : 'paused'}`}>
            {s.enabled ? tr('schedules.enabled') : tr('schedules.paused')}
          </span>
        </div>
        <div className="schedule-row-meta">
          <span>{s.botName ?? s.larkAppId ?? '-'}</span>
          <span>·</span>
          <code>{s.parsed?.display ?? '?'}</code>
        </div>
        <div className="schedule-chip-strip">
          <span>{kind}</span>
          <span>{tr('schedules.delivery')}: {deliveryLabel(s, tr)}</span>
          <span>{tr('schedules.next')}: {fmtScheduleDate(s.nextRunAt, scheduleTimeZone)}</span>
          <span>{tr('schedules.last')}: {fmtScheduleDate(s.lastRunAt, scheduleTimeZone)}{s.lastStatus === 'error' ? ' · error' : ''}</span>
          <span>{tr('schedules.repeat')}: {repeatLabel(s)}</span>
        </div>
      </OverviewListMain>
      <OverviewListTail>
        <div className="schedule-actions">
          <ActionButton
            op="run"
            label={tr('schedules.runNow')}
            pending={props.pending === runKey}
            feedback={props.feedback[runKey] ?? null}
            onClick={() => props.onAction(s.id, 'run')}
          />
          <ScheduleEnabledSwitch
            checked={Boolean(s.enabled)}
            pending={props.pending === toggleKey}
            feedback={props.feedback[toggleKey] ?? null}
            tr={tr}
            onClick={() => props.onAction(s.id, toggleOp)}
          />
          {s.deliver === 'local' ? null : (
            <ActionButton
              op="delivery"
              label={s.deliver === 'new-topic' ? tr('schedules.useOrigin') : tr('schedules.useNewTopic')}
              pending={props.pending === deliveryKey}
              feedback={props.feedback[deliveryKey] ?? null}
              onClick={() => props.onAction(s.id, 'delivery')}
            />
          )}
        </div>
      </OverviewListTail>
    </OverviewListItem>
  );
}

function SchedulesPage() {
  const tr = useT();
  const { scheduleRows, scheduleTimeZone } = useStoreSelector(snapshot => ({
    scheduleRows: [...snapshot.schedules.values()] as ScheduleRow[],
    scheduleTimeZone: snapshot.scheduleTimeZone,
  }));
  const [filters, setFilters] = useState<ScheduleFilters>({ q: '', kind: '', enabledOnly: false });
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, ActionFeedback>>({});
  const feedbackTimers = useRef(new Map<string, number>());

  const rows = useMemo(
    () => filterSchedules(scheduleRows, filters),
    [scheduleRows, filters],
  );

  useEffect(() => () => {
    feedbackTimers.current.forEach(timer => window.clearTimeout(timer));
    feedbackTimers.current.clear();
  }, []);

  function showFeedback(key: string, nextFeedback: ActionFeedback): void {
    setFeedback(current => ({ ...current, [key]: nextFeedback }));
    const previous = feedbackTimers.current.get(key);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      setFeedback(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      feedbackTimers.current.delete(key);
    }, nextFeedback === 'success' ? 1600 : 2200);
    feedbackTimers.current.set(key, timer);
  }

  async function runAction(id: string, op: ScheduleAction): Promise<void> {
    const key = `${id}:${op}`;
    const startedAt = performance.now();
    let nextFeedback: ActionFeedback = 'success';
    setPending(key);
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        throw new Error(`Failed: ${r.status} ${body?.error ?? ''}`.trim());
      }
    } catch (err) {
      nextFeedback = 'error';
    } finally {
      if (op === 'run') {
        const remaining = RUN_ACTION_MIN_PENDING_MS - (performance.now() - startedAt);
        if (remaining > 0) await delay(remaining);
      }
      showFeedback(key, nextFeedback);
      setPending(cur => cur === key ? null : cur);
    }
  }

  return (
    <section className="page schedules-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.schedules')}</p>
          <h1>{tr('schedules.title')}</h1>
        </div>
      </div>
      <form id="sched-filters" className="filters dashboard-toolbar">
        <input
          type="search"
          name="q"
          placeholder={tr('schedules.search')}
          value={filters.q}
          onChange={event => {
            const q = event.currentTarget.value;
            setFilters(f => ({ ...f, q }));
          }}
        />
        <DropdownMenu
          id="sched-kind-menu"
          ariaLabel={tr('schedules.anyKind')}
          label={filters.kind || tr('schedules.anyKind')}
          value={filters.kind}
          options={[
            { value: '', label: tr('schedules.anyKind') },
            { value: 'cron', label: 'cron' },
            { value: 'interval', label: 'interval' },
            { value: 'once', label: 'once' },
          ]}
          onChange={kind => setFilters(f => ({ ...f, kind }))}
        />
        <label className="filter-toggle">
          <input
            type="checkbox"
            name="enabled"
            checked={filters.enabledOnly}
            onChange={e => setFilters(f => ({ ...f, enabledOnly: e.currentTarget.checked }))}
          />
          <span className="filter-toggle-label">{tr('schedules.enabledOnly')}</span>
          <span className="filter-toggle-switch" aria-hidden="true" />
        </label>
        <span className="schedules-toolbar-spacer" aria-hidden="true" />
        <span className="schedules-toolbar-count">{rows.length}/{scheduleRows.length}</span>
      </form>
      <section className="overview-block schedules-list-section">
        <div className="schedules-list-wrap">
          {rows.length === 0 ? (
            <div id="schedules-tbody" className="empty schedules-list-empty">{tr('schedules.empty')}</div>
          ) : (
            <OverviewList id="schedules-tbody" className="schedules-list">
              {rows.map(s => (
                <ScheduleRowCard
                  key={s.id}
                  schedule={s}
                  scheduleTimeZone={scheduleTimeZone}
                  pending={pending}
                  feedback={feedback}
                  tr={tr}
                  onAction={(id, op) => void runAction(id, op)}
                />
              ))}
            </OverviewList>
          )}
        </div>
      </section>
    </section>
  );
}

function actionLabel(
  op: ScheduleAction,
  label: string,
  pending: boolean,
  feedback: ActionFeedback | null,
  tr: ReturnType<typeof useT>,
): string {
  if (pending) return op === 'run' ? tr('schedules.running') : tr('schedules.saving');
  if (feedback === 'success') return op === 'run' ? tr('schedules.runDone') : tr('schedules.saved');
  if (feedback === 'error') return tr('schedules.failed');
  return label;
}

function ActionButton(props: {
  op: ScheduleAction;
  label: string;
  pending: boolean;
  feedback: ActionFeedback | null;
  onClick: () => void;
}) {
  const tr = useT();
  const feedbackClass = props.feedback ? ` is-${props.feedback}` : '';
  return (
    <button
      type="button"
      className={`schedule-action-button${props.pending ? ' is-pending' : ''}${feedbackClass}`}
      data-op={props.op}
      disabled={props.pending}
      onClick={props.onClick}
    >
      <span className="schedule-action-label">{actionLabel(props.op, props.label, props.pending, props.feedback, tr)}</span>
    </button>
  );
}

function ScheduleEnabledSwitch(props: {
  checked: boolean;
  pending: boolean;
  feedback: ActionFeedback | null;
  tr: ReturnType<typeof useT>;
  onClick: () => void;
}) {
  const label = props.feedback === 'error'
    ? props.tr('schedules.failed')
    : props.checked
      ? props.tr('schedules.enabled')
      : props.tr('schedules.paused');
  return (
    <button
      type="button"
      className={`schedule-enabled-switch${props.checked ? ' is-on' : ''}${props.pending ? ' is-pending' : ''}${props.feedback ? ` is-${props.feedback}` : ''}`}
      aria-pressed={props.checked}
      disabled={props.pending}
      onClick={props.onClick}
    >
      <span className="schedule-enabled-switch-label">{label}</span>
      <span className="schedule-enabled-switch-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

export function renderSchedulesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SchedulesPage />);
}
