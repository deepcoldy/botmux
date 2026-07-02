import { useMemo, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';

type ScheduleRow = Record<string, any> & { id: string };
type ScheduleAction = 'run' | 'pause' | 'resume' | 'delivery';

export interface ScheduleFilters {
  q: string;
  kind: string;
  enabledOnly: boolean;
}

export function fmtScheduleDate(s?: string): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString();
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
  if (s.deliver === 'new-topic') return `🆕 ${tr('schedules.deliveryNewTopic')}`;
  if (s.deliver === 'local') return `🔕 ${tr('schedules.deliveryLocal')}`;
  return tr('schedules.deliveryOrigin');
}

function repeatLabel(s: ScheduleRow): string {
  if (!s.repeat) return '—';
  return `${s.repeat.completed}/${s.repeat.times ?? '∞'}`;
}

function SchedulesPage() {
  const tr = useT();
  const scheduleRows = useStoreSelector(snapshot => [...snapshot.schedules.values()] as ScheduleRow[]);
  const [filters, setFilters] = useState<ScheduleFilters>({ q: '', kind: '', enabledOnly: false });
  const [pending, setPending] = useState<string | null>(null);
  const labels = {
    name: tr('schedules.name'),
    bot: tr('schedules.bot'),
    schedule: tr('schedules.schedule'),
    delivery: tr('schedules.delivery'),
    next: tr('schedules.next'),
    last: tr('schedules.last'),
    repeat: tr('schedules.repeat'),
    enabled: tr('schedules.enabled'),
    actions: tr('schedules.actions'),
  };

  const rows = useMemo(
    () => filterSchedules(scheduleRows, filters),
    [scheduleRows, filters],
  );

  async function runAction(id: string, op: ScheduleAction): Promise<void> {
    const key = `${id}:${op}`;
    setPending(key);
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        alert(`Failed: ${r.status} ${body?.error ?? ''}`.trim());
      }
    } catch (err) {
      alert('Network error: ' + err);
    } finally {
      setPending(cur => cur === key ? null : cur);
    }
  }

  return (
    <section className="page schedules-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.schedules')}</p>
          <h1>{tr('schedules.title')}</h1>
          <p>{tr('schedules.subtitle')}</p>
        </div>
      </div>
      <form id="sched-filters" className="filters">
        <input
          type="search"
          name="q"
          placeholder={tr('schedules.search')}
          value={filters.q}
          onChange={e => setFilters(f => ({ ...f, q: e.currentTarget.value }))}
        />
        <select
          name="kind"
          value={filters.kind}
          onChange={e => setFilters(f => ({ ...f, kind: e.currentTarget.value }))}
        >
          <option value="">{tr('schedules.anyKind')}</option>
          <option value="cron">cron</option>
          <option value="interval">interval</option>
          <option value="once">once</option>
        </select>
        <label>
          <input
            type="checkbox"
            name="enabled"
            checked={filters.enabledOnly}
            onChange={e => setFilters(f => ({ ...f, enabledOnly: e.currentTarget.checked }))}
          />{' '}
          {tr('schedules.enabledOnly')}
        </label>
      </form>
      <table className="schedules-table">
        <thead>
          <tr>
            <th>{labels.name}</th>
            <th>{labels.bot}</th>
            <th>{labels.schedule}</th>
            <th>{labels.delivery}</th>
            <th>{labels.next}</th>
            <th>{labels.last}</th>
            <th>{labels.repeat}</th>
            <th>{labels.enabled}</th>
            <th>{labels.actions}</th>
          </tr>
        </thead>
        <tbody id="schedules-tbody">
          {rows.length === 0 ? (
            <tr className="schedule-empty-row"><td colSpan={9} className="empty">{tr('schedules.empty')}</td></tr>
          ) : rows.map(s => (
            <tr key={s.id} data-id={s.id}>
              <td data-label={labels.name}>{s.name ?? s.id}</td>
              <td data-label={labels.bot}>{s.botName ?? s.larkAppId ?? '-'}</td>
              <td data-label={labels.schedule}><code>{s.parsed?.display ?? '?'}</code></td>
              <td data-label={labels.delivery}>{deliveryLabel(s, tr)}</td>
              <td data-label={labels.next}>{fmtScheduleDate(s.nextRunAt)}</td>
              <td data-label={labels.last}>{fmtScheduleDate(s.lastRunAt)} {s.lastStatus === 'error' ? '⚠️' : ''}</td>
              <td data-label={labels.repeat}>{repeatLabel(s)}</td>
              <td data-label={labels.enabled}>{s.enabled ? '✓' : '✗'}</td>
              <td className="actions-cell" data-label={labels.actions}>
                <div className="schedule-actions">
                  <ActionButton
                    op="run"
                    label={tr('schedules.runNow')}
                    pending={pending === `${s.id}:run`}
                    onClick={() => void runAction(s.id, 'run')}
                  />
                  {s.enabled ? (
                    <ActionButton
                      op="pause"
                      label={tr('schedules.pause')}
                      pending={pending === `${s.id}:pause`}
                      onClick={() => void runAction(s.id, 'pause')}
                    />
                  ) : (
                    <ActionButton
                      op="resume"
                      label={tr('schedules.resume')}
                      pending={pending === `${s.id}:resume`}
                      onClick={() => void runAction(s.id, 'resume')}
                    />
                  )}
                  {s.deliver === 'local' ? null : (
                    <ActionButton
                      op="delivery"
                      label={s.deliver === 'new-topic' ? tr('schedules.useOrigin') : tr('schedules.useNewTopic')}
                      pending={pending === `${s.id}:delivery`}
                      onClick={() => void runAction(s.id, 'delivery')}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ActionButton(props: { op: ScheduleAction; label: string; pending: boolean; onClick: () => void }) {
  return (
    <button type="button" data-op={props.op} disabled={props.pending} onClick={props.onClick}>
      {props.pending ? '...' : props.label}
    </button>
  );
}

export function renderSchedulesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SchedulesPage />);
}
