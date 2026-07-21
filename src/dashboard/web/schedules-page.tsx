import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';
import {
  CreateActionButton,
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
  onEdit(schedule: ScheduleRow): void;
  onDelete(schedule: ScheduleRow): void;
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
          {s.silent ? <span>🔇 {tr('schedules.silent')}</span> : null}
          {s.freshContext ? <span>🆕 {tr('schedules.freshContext')}</span> : null}
          <span>{tr('schedules.next')}: {fmtScheduleDate(s.nextRunAt, scheduleTimeZone)}</span>
          <span>{tr('schedules.last')}: {fmtScheduleDate(s.lastRunAt, scheduleTimeZone)}</span>
          {s.lastStatus === 'error' ? (
            <span
              className="schedule-error-chip"
              title={typeof s.lastError === 'string' ? s.lastError : undefined}
            >
              ⚠ {tr('schedules.error')}: {typeof s.lastError === 'string' && s.lastError.length > 60 ? s.lastError.slice(0, 60) + '…' : (s.lastError ?? tr('schedules.errorUnknown'))}
            </span>
          ) : null}
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
          {/* silent tasks can't switch to new-topic (needs a first message) — hide like 'local' */}
          {s.deliver === 'local' || s.silent ? null : (
            <ActionButton
              op="delivery"
              label={s.deliver === 'new-topic' ? tr('schedules.useOrigin') : tr('schedules.useNewTopic')}
              pending={props.pending === deliveryKey}
              feedback={props.feedback[deliveryKey] ?? null}
              onClick={() => props.onAction(s.id, 'delivery')}
            />
          )}
          <button
            type="button"
            className="schedule-action-button schedule-edit-button"
            onClick={() => props.onEdit(s)}
            title={tr('schedules.edit')}
          >
            <span className="schedule-action-label">{tr('schedules.edit')}</span>
          </button>
          <button
            type="button"
            className="schedule-action-button schedule-delete-button"
            onClick={() => props.onDelete(s)}
            title={tr('schedules.delete')}
          >
            <span className="schedule-action-label">{tr('schedules.delete')}</span>
          </button>
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
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [bots, setBots] = useState<Array<{ larkAppId: string; botName?: string }>>([]);

  useEffect(() => {
    fetch('/api/bots')
      .then(r => r.json())
      .then(b => {
        if (Array.isArray(b?.bots)) setBots(b.bots);
      })
      .catch(() => undefined);
  }, []);

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

  function openCreate(): void {
    setEditing(null);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(s: ScheduleRow): void {
    setEditing(s);
    setFormError(null);
    setFormOpen(true);
  }

  async function handleDelete(s: ScheduleRow): Promise<void> {
    if (!window.confirm(tr('schedules.deleteConfirm'))) return;
    const key = `${s.id}:delete`;
    setPending(key);
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      showFeedback(key, 'success');
    } catch {
      showFeedback(key, 'error');
    } finally {
      setPending(cur => cur === key ? null : cur);
    }
  }

  async function handleSubmit(data: {
    name: string; schedule: string; prompt: string;
    deliver: 'origin' | 'new-topic'; deliverTouched: boolean; silent: boolean;
    freshContext: boolean;
    chatId: string; larkAppId: string;
  }): Promise<void> {
    setFormError(null);
    try {
      const url = editing ? `/api/schedules/${encodeURIComponent(editing.id)}` : '/api/schedules';
      const method = editing ? 'PATCH' : 'POST';
      // When editing, chatId/larkAppId are immutable (PATCH ignores them);
      // when creating, larkAppId selects the owning bot/daemon.
      // Only include `deliver` in the PATCH when the user explicitly changed it,
      // so legacy 'local' tasks aren't silently rewritten to 'origin'.
      const payload = editing
        ? { name: data.name, schedule: data.schedule, prompt: data.prompt, silent: data.silent, freshContext: data.freshContext, ...(data.deliverTouched ? { deliver: data.deliver } : {}) }
        : data;
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      setFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="page schedules-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.schedules')}</p>
          <h1>{tr('schedules.title')}</h1>
        </div>
        <CreateActionButton onClick={openCreate} disabled={bots.length === 0}>{tr('schedules.create')}</CreateActionButton>
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
            onChange={event => {
              const enabledOnly = event.currentTarget.checked;
              setFilters(f => ({ ...f, enabledOnly }));
            }}
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
                  onEdit={openEdit}
                  onDelete={s => void handleDelete(s)}
                />
              ))}
            </OverviewList>
          )}
        </div>
      </section>
      {formOpen ? (
        <ScheduleFormModal
          editing={editing}
          error={formError}
          bots={bots}
          tr={tr}
          onClose={() => setFormOpen(false)}
          onSubmit={data => void handleSubmit(data)}
        />
      ) : null}
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

interface ScheduleFormData {
  name: string;
  schedule: string;
  prompt: string;
  deliver: 'origin' | 'new-topic';
  /** Whether the user explicitly changed the deliver radio. When false (e.g.
   *  editing a legacy 'local' task), deliver is omitted from the PATCH so we
   *  don't silently rewrite the task's delivery mode. */
  deliverTouched: boolean;
  silent: boolean;
  freshContext: boolean;
  chatId: string;
  larkAppId: string;
}

function ScheduleFormModal(props: {
  editing: ScheduleRow | null;
  error: string | null;
  bots: Array<{ larkAppId: string; botName?: string }>;
  tr: ReturnType<typeof useT>;
  onClose(): void;
  onSubmit(data: ScheduleFormData): void;
}) {
  const { editing, tr, bots } = props;
  const [name, setName] = useState(editing?.name ?? '');
  const [schedule, setSchedule] = useState(editing?.schedule ?? '');
  const [prompt, setPrompt] = useState(editing?.prompt ?? '');
  const [deliver, setDeliver] = useState<'origin' | 'new-topic'>(
    editing?.deliver === 'new-topic' ? 'new-topic' : 'origin',
  );
  const [deliverTouched, setDeliverTouched] = useState(false);
  const [silent, setSilent] = useState(editing?.silent === true);
  const [freshContext, setFreshContext] = useState(editing?.freshContext === true);
  const [chatId, setChatId] = useState(editing?.chatId ?? '');
  const [larkAppId, setLarkAppId] = useState(editing?.larkAppId ?? bots[0]?.larkAppId ?? '');

  // If the modal opened before /api/bots resolved, default to the first bot
  // once it arrives so the submit button doesn't stay permanently disabled.
  useEffect(() => {
    if (!editing && !larkAppId && bots.length > 0) {
      setLarkAppId(bots[0].larkAppId);
    }
  }, [editing, larkAppId, bots]);

  // silent + new-topic are mutually exclusive
  const silentNewTopicConflict = silent && deliver === 'new-topic';

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (silentNewTopicConflict) return;
    if (!editing && !larkAppId) return;
    props.onSubmit({ name, schedule, prompt, deliver, deliverTouched, silent, freshContext, chatId, larkAppId });
  }

  return (
    <div className="schedule-form-overlay" onClick={props.onClose}>
      <div
        className="schedule-form-dialog"
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <h2>{editing ? tr('schedules.edit') : tr('schedules.create')}</h2>
        <form onSubmit={handleSubmit} className="schedule-form">
          {!editing ? (
            <label className="schedule-form-field">
              <span className="schedule-form-label">{tr('schedules.form.bot')}</span>
              <select
                value={larkAppId}
                onChange={e => setLarkAppId(e.target.value)}
                required
              >
                {bots.map(b => (
                  <option key={b.larkAppId} value={b.larkAppId}>
                    {b.botName ?? b.larkAppId}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.name')}</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.schedule')}</span>
            <input
              type="text"
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              placeholder={tr('schedules.form.scheduleHelp')}
              required
            />
            <small className="schedule-form-help">{tr('schedules.form.scheduleHelp')}</small>
          </label>
          <label className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.prompt')}</span>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              required
            />
            <small className="schedule-form-help">{tr('schedules.form.promptHelp')}</small>
          </label>
          {!editing ? (
            <label className="schedule-form-field">
              <span className="schedule-form-label">{tr('schedules.form.chat')}</span>
              <input
                type="text"
                value={chatId}
                onChange={e => setChatId(e.target.value)}
                placeholder="oc_..."
                required
              />
            </label>
          ) : null}
          <div className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.deliver')}</span>
            <div className="schedule-form-radio-group">
              <label>
                <input
                  type="radio"
                  name="deliver"
                  value="origin"
                  checked={deliver === 'origin'}
                  onChange={() => { setDeliver('origin'); setDeliverTouched(true); }}
                />
                {tr('schedules.deliveryOrigin')}
              </label>
              <label>
                <input
                  type="radio"
                  name="deliver"
                  value="new-topic"
                  checked={deliver === 'new-topic'}
                  onChange={() => { setDeliver('new-topic'); setDeliverTouched(true); }}
                  disabled={silent}
                />
                {tr('schedules.deliveryNewTopic')}
              </label>
            </div>
          </div>
          <label className="schedule-form-field schedule-form-toggle">
            <input
              type="checkbox"
              checked={silent}
              onChange={e => {
                setSilent(e.target.checked);
                // silent + new-topic are mutually exclusive: auto-switch to origin
                // and mark deliver as touched so the PATCH includes it (otherwise
                // the backend still sees new-topic and rejects silent:true).
                if (e.target.checked && deliver === 'new-topic') {
                  setDeliver('origin');
                  setDeliverTouched(true);
                }
                // fresh-context requires silent: unchecking silent also unchecks
                // fresh-context so the submitted data stays consistent.
                if (!e.target.checked && freshContext) {
                  setFreshContext(false);
                }
              }}
            />
            <span>
              {tr('schedules.form.silent')}
              <small className="schedule-form-help">{tr('schedules.form.silentHelp')}</small>
            </span>
          </label>
          {silent ? (
            <label className="schedule-form-field schedule-form-toggle">
              <input
                type="checkbox"
                checked={freshContext}
                onChange={e => setFreshContext(e.target.checked)}
              />
              <span>
                {tr('schedules.form.freshContext')}
                <small className="schedule-form-help">{tr('schedules.form.freshContextHelp')}</small>
              </span>
            </label>
          ) : null}
          {silentNewTopicConflict ? (
            <p className="schedule-form-error">{tr('schedules.form.silentNewTopicConflict')}</p>
          ) : null}
          {props.error ? (
            <p className="schedule-form-error">{props.error}</p>
          ) : null}
          <div className="schedule-form-actions">
            <button type="button" className="schedule-form-cancel" onClick={props.onClose}>
              {tr('schedules.form.cancel')}
            </button>
            <button
              type="submit"
              className="schedule-form-submit"
              disabled={silentNewTopicConflict || (!editing && !larkAppId)}
            >
              {editing ? tr('schedules.form.save') : tr('schedules.form.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
