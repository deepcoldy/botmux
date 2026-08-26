import { useEffect, useMemo, useRef, useState } from 'react';
import { Cron } from 'croner';
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
import { chatDisplayTitle, loadNameMaps } from './ui.js';
import { confirm } from './confirm-modal.js';
import { toast } from './toast.js';
import { fetchGroupsSnapshot, type GroupChat } from './groups-api.js';

type ScheduleRow = Record<string, any> & { id: string };
type ScheduleAction = 'run' | 'pause' | 'resume';
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

type SchedulePlacement = 'chat' | 'thread' | 'new-topic' | 'local';

export function scheduleExecutionPlacement(s: ScheduleRow): SchedulePlacement {
  if (s.deliver === 'local') return 'local';
  if (s.executionPosition === 'new-topic') return 'new-topic';
  if (s.executionPosition === 'topic') return s.rootMessageId ? 'thread' : 'chat';
  if (s.executionPosition === 'top-level') return 'chat';
  if (s.deliver === 'new-topic') return 'new-topic';
  if (s.scope === 'chat') return 'chat';
  return s.rootMessageId ? 'thread' : 'chat';
}

function placementLabel(s: ScheduleRow, tr: ReturnType<typeof useT>): string {
  const placement = scheduleExecutionPlacement(s);
  if (placement === 'local') return tr('schedules.deliveryLocal');
  if (placement === 'new-topic') return tr('schedules.deliveryNewTopic');
  return placement === 'thread'
    ? tr('schedules.deliveryThread')
    : tr('schedules.deliveryTopLevel');
}

function repeatLabel(s: ScheduleRow): string {
  if (!s.repeat) return '—';
  return `${s.repeat.completed}/${s.repeat.times ?? '∞'}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

// ── 调度规则内联校验 ─────────────────────────────────────────────────────────
// 镜像服务端 parseSchedule 可识别的格式族；cron 走 croner 全量校验并给出
// 「下次执行」预览，其余格式做模式识别，无法识别才红——避免误杀服务端能解析的
// 中文自然语言。服务端仍是最终校验者。

type ScheduleCheck =
  | { ok: true; preview?: string }
  | { ok: false; error: string };

const CRON_TEMPLATES: Array<{ label: string; expr: string }> = [
  { label: '工作日 09:00', expr: '0 9 * * 1-5' },
  { label: '每日 09:00', expr: '0 9 * * *' },
  { label: '每周一 09:00', expr: '0 9 * * 1' },
  { label: '每小时', expr: '0 * * * *' },
];

const DURATION_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function checkSchedule(
  input: string,
  tr: ReturnType<typeof useT>,
  timeZone?: string,
): ScheduleCheck {
  const s = input.trim();
  if (!s) return { ok: false, error: tr('schedules.form.errEmpty') };

  // 5 字段 cron：croner 全量校验 + 下次执行预览（在调度器时区计算，避免浏览器时区偏差）
  const parts = s.split(/\s+/);
  if (parts.length === 5 && parts.every(p => /^[\d*\-,/]+$/.test(p))) {
    try {
      const next = new Cron(s, timeZone ? { timezone: timeZone } : undefined).nextRun();
      if (!next) return { ok: false, error: tr('schedules.form.errCron') };
      return { ok: true, preview: fmtScheduleDate(next.toISOString(), timeZone) };
    } catch {
      return { ok: false, error: tr('schedules.form.errCron') };
    }
  }

  // every N(m|h|d) — interval
  let m = s.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (m) return { ok: true };

  // N(m|h|d) — one-shot
  m = s.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (m) {
    const ms = parseInt(m[1], 10) * (DURATION_UNIT_MS[m[2][0].toLowerCase()] ?? 60_000);
    return { ok: true, preview: fmtScheduleDate(new Date(Date.now() + ms).toISOString(), timeZone) };
  }

  // ISO 时间戳 — one-shot
  if (/^\d{4}-\d{2}-\d{2}(T| |$)/.test(s)) {
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      return { ok: true, preview: fmtScheduleDate(dt.toISOString(), timeZone) };
    }
  }

  // 中文自然语言（对齐服务端 parseChineseSchedule 的前缀族，含工作日变体）。
  // `每天` 是早期版本和 /schedule 一直支持的存量写法，不能只接受 `每日`。
  if (/^(每[天日]|每周[一二三四五六日天]|每月\d{1,2}[号日]|每\d+小时|每小时|每\d+分钟|\d+\s*分钟后|\d+\s*小时后|明天|每个?工作日|工作日每[天日])/.test(s)) {
    return { ok: true };
  }

  return { ok: false, error: tr('schedules.form.errFormat') };
}

export function canSubmitSchedule(
  input: string,
  original: string | undefined,
  tr: ReturnType<typeof useT>,
  timeZone?: string,
): boolean {
  const normalized = input.trim();
  if (!normalized) return false;
  // Existing tasks may contain syntax authored by an older release. The
  // server only re-parses schedule when it changes, so an unchanged legacy
  // value must not prevent edits to the task's other fields.
  if (original !== undefined && normalized === original.trim()) return true;
  return checkSchedule(normalized, tr, timeZone).ok;
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
  const chatTitle = chatDisplayTitle(s);
  const kind = String(s.parsed?.kind ?? 'unknown');
  const toggleOp: ScheduleAction = s.enabled ? 'pause' : 'resume';
  const toggleKey = `${s.id}:${toggleOp}`;
  const runKey = `${s.id}:run`;
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
          {s.chatId ? (
            <span
              className="schedule-chat-chip"
              title={chatTitle ? `${chatTitle} · ${String(s.chatId)}` : String(s.chatId)}
            >
              {tr('schedules.form.chat')}: {chatTitle ?? s.chatId}
            </span>
          ) : null}
          <span>{tr('schedules.delivery')}: {placementLabel(s, tr)}</span>
          {s.silent ? <span>🔇 {tr('schedules.silent')}</span> : null}
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
  // 每次打开表单时递增，强制 ScheduleFormModal 重挂载以重置全部表单状态
  const [formNonce, setFormNonce] = useState(0);
  const [bots, setBots] = useState<Array<{ larkAppId: string; botName?: string }>>([]);
  const [, setNameMapsVersion] = useState(0);

  useEffect(() => {
    fetch('/api/bots')
      .then(r => r.json())
      .then(b => {
        if (Array.isArray(b?.bots)) setBots(b.bots);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadNameMaps().then(() => setNameMapsVersion(version => version + 1));
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
    setFormNonce(n => n + 1);
    setFormOpen(true);
  }

  function openEdit(s: ScheduleRow): void {
    setEditing(s);
    setFormError(null);
    setFormNonce(n => n + 1);
    setFormOpen(true);
  }

  async function handleDelete(s: ScheduleRow): Promise<void> {
    const ok = await confirm({
      title: tr('schedules.delete'),
      message: tr('schedules.deleteConfirm'),
      danger: true,
      confirmLabel: tr('schedules.delete'),
    });
    if (!ok) return;
    const key = `${s.id}:delete`;
    setPending(key);
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      toast(tr('schedules.deleteDone'), { kind: 'success' });
    } catch {
      toast(tr('schedules.deleteFailed'), { kind: 'error' });
    } finally {
      setPending(cur => cur === key ? null : cur);
    }
  }

  async function handleSubmit(data: {
    name: string; schedule: string; prompt: string;
    silent: boolean;
    executionPosition: 'top-level' | 'topic' | 'new-topic';
    rootMessageId: string;
    topicTitle: string;
    updateExecutionPosition: boolean;
    chatId: string; larkAppId: string;
  }): Promise<void> {
    setFormError(null);
    try {
      const url = editing ? `/api/schedules/${encodeURIComponent(editing.id)}` : '/api/schedules';
      const method = editing ? 'PATCH' : 'POST';
      // When editing, chatId/larkAppId are immutable (PATCH ignores them);
      // when creating, larkAppId selects the owning bot/daemon.
      const payload = editing
        ? {
            name: data.name,
            schedule: data.schedule,
            prompt: data.prompt,
            silent: data.silent,
            ...(data.updateExecutionPosition ? {
              executionPosition: data.executionPosition,
              rootMessageId: data.rootMessageId,
              topicTitle: data.topicTitle,
            } : {}),
          }
        : {
            name: data.name,
            schedule: data.schedule,
            prompt: data.prompt,
            silent: data.silent,
            executionPosition: data.executionPosition,
            rootMessageId: data.rootMessageId,
            topicTitle: data.topicTitle,
            chatId: data.chatId,
            larkAppId: data.larkAppId,
          };
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
      toast(
        editing ? tr('schedules.saved') : tr('schedules.createDone'),
        { kind: 'success' },
      );
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
      <ScheduleFormModal
        key={`${editing?.id ?? 'new'}-${formNonce}`}
        open={formOpen}
        editing={editing}
        error={formError}
        bots={bots}
        scheduleTimeZone={scheduleTimeZone}
        tr={tr}
        onClose={() => setFormOpen(false)}
        onSubmit={data => void handleSubmit(data)}
      />
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
  silent: boolean;
  executionPosition: 'top-level' | 'topic' | 'new-topic';
  rootMessageId: string;
  topicTitle: string;
  updateExecutionPosition: boolean;
  chatId: string;
  larkAppId: string;
}

function ScheduleFormModal(props: {
  open: boolean;
  editing: ScheduleRow | null;
  error: string | null;
  bots: Array<{ larkAppId: string; botName?: string }>;
  scheduleTimeZone?: string;
  tr: ReturnType<typeof useT>;
  onClose(): void;
  onSubmit(data: ScheduleFormData): void;
}) {
  const { editing, tr, bots, open, scheduleTimeZone } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [schedule, setSchedule] = useState(editing?.schedule ?? '');
  const [prompt, setPrompt] = useState(editing?.prompt ?? '');
  const [silent, setSilent] = useState(editing?.silent === true);
  const [executionPosition, setExecutionPosition] = useState<'top-level' | 'topic' | 'new-topic'>(
    editing && scheduleExecutionPlacement(editing) === 'thread'
      ? 'topic'
      : editing && scheduleExecutionPlacement(editing) === 'new-topic' ? 'new-topic' : 'top-level',
  );
  const [rootMessageId, setRootMessageId] = useState(editing?.rootMessageId ?? '');
  const [topicTitle, setTopicTitle] = useState(editing?.topicTitle ?? '');
  const [chatId, setChatId] = useState(editing?.chatId ?? '');
  const [larkAppId, setLarkAppId] = useState(editing?.larkAppId ?? bots[0]?.larkAppId ?? '');
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [chatManual, setChatManual] = useState(false);
  const [touched, setTouched] = useState(false);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const localDelivery = editing?.deliver === 'local';

  // open 时 showModal + 聚焦首个输入；关闭时 close()（Esc/遮罩点击走 onClose）
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      dlg.querySelector<HTMLElement>('input[name="name"]')?.focus();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // 创建模式下拉取群列表（30s 缓存，与 Groups 等入口共享）
  useEffect(() => {
    if (!open || editing) return;
    let cancelled = false;
    fetchGroupsSnapshot({ cacheMs: 30_000 })
      .then(snap => { if (!cancelled) setGroups(snap.chats); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, editing]);

  // If the modal opened before /api/bots resolved, default to the first bot
  // once it arrives so the submit button doesn't stay permanently disabled.
  useEffect(() => {
    if (!editing && !larkAppId && bots.length > 0) {
      setLarkAppId(bots[0].larkAppId);
    }
  }, [editing, larkAppId, bots]);

  const check = useMemo(
    () => schedule.trim() ? checkSchedule(schedule, tr, scheduleTimeZone) : null,
    [schedule, tr, scheduleTimeZone],
  );

  // 只列出选中 bot 已在群的群（memberBots 有 inChat 记录时才过滤；
  // 成员信息缺失时 fail-open 显示全部，避免阻塞创建）
  const groupOptions = useMemo(() => {
    const hasMembership = groups.some(g => g.memberBots?.length > 0);
    const filtered = hasMembership && larkAppId
      ? groups.filter(g => g.memberBots?.some(b => b.larkAppId === larkAppId && b.inChat))
      : groups;
    // 有名群按名称排序，无名群（仅 oc_ ID）排最后
    return [...filtered].sort((a, b) => {
      const an = a.name ?? '';
      const bn = b.name ?? '';
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return an.localeCompare(bn, 'zh-CN');
    });
  }, [groups, larkAppId]);

  // bot 变更时，若当前 chatId 不在新 bot 的群列表中则清除，避免给不在群的 bot 投递
  useEffect(() => {
    if (!chatId || !larkAppId || groupOptions.length === 0) return;
    if (!groupOptions.some(g => g.chatId === chatId)) setChatId('');
  }, [larkAppId, groupOptions, chatId]);

  const showGroupSelect = !editing && !localDelivery && !chatManual && groupOptions.length > 0;
  const scheduleInvalid = scheduleTouched && check !== null && !check.ok;
  const schedulePreview = check?.ok ? check.preview : undefined;
  const nameMissing = touched && !name.trim();
  const promptMissing = touched && !prompt.trim();
  const chatMissing = touched && !editing && !localDelivery && !chatId.trim();
  const rootMissing = touched && !localDelivery && executionPosition === 'topic' && !rootMessageId.trim();

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setTouched(true);
    setScheduleTouched(true);
    // 必填内联校验：不静默 return，每个缺字段都有可见红提示
    if (!editing && !larkAppId) return;
    if (!name.trim() || !prompt.trim()) return;
    if (!localDelivery && !chatId.trim()) return;
    if (!localDelivery && executionPosition === 'topic' && !rootMessageId.trim()) return;
    if (!canSubmitSchedule(schedule, editing?.schedule, tr, scheduleTimeZone)) return;
    props.onSubmit({
      name: name.trim(),
      schedule: schedule.trim(),
      prompt,
      silent,
      executionPosition,
      rootMessageId: rootMessageId.trim(),
      topicTitle: topicTitle.trim(),
      updateExecutionPosition: !localDelivery,
      chatId: chatId.trim(),
      larkAppId,
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className="schedule-form-dialog"
      onClose={props.onClose}
      onClick={e => { if (e.target === dialogRef.current) props.onClose(); }}
    >
      <h2>{editing ? tr('schedules.edit') : tr('schedules.create')}</h2>
      <form onSubmit={handleSubmit} className="schedule-form" noValidate>
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
            name="name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            autoFocus
            aria-invalid={nameMissing || undefined}
          />
          {nameMissing ? (
            <small className="schedule-form-error-inline">{tr('schedules.form.errNameRequired')}</small>
          ) : null}
        </label>
        <div className="schedule-form-field">
          <span className="schedule-form-label">{tr('schedules.form.schedule')}</span>
          <div className="schedule-templates" role="group" aria-label={tr('schedules.form.templates')}>
            {CRON_TEMPLATES.map(t => (
              <button
                key={t.expr}
                type="button"
                className={`schedule-template-chip${schedule === t.expr ? ' is-active' : ''}`}
                onClick={() => { setSchedule(t.expr); setScheduleTouched(true); }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={schedule}
            onChange={e => { setSchedule(e.target.value); setScheduleTouched(true); }}
            placeholder={tr('schedules.form.scheduleHelp')}
            required
            aria-invalid={scheduleInvalid || undefined}
          />
          {scheduleInvalid && check && !check.ok ? (
            <small className="schedule-form-error-inline">{check.error}</small>
          ) : schedulePreview ? (
            <small className="schedule-form-preview">✓ {tr('schedules.form.nextRun')}：{schedulePreview}</small>
          ) : (
            <small className="schedule-form-help">{tr('schedules.form.scheduleHelp')}</small>
          )}
        </div>
        <label className="schedule-form-field">
          <span className="schedule-form-label">{tr('schedules.form.prompt')} <i className="req" aria-hidden="true">*</i></span>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={4}
            required
            aria-invalid={promptMissing || undefined}
          />
          {promptMissing ? (
            <small className="schedule-form-error-inline">{tr('schedules.form.errPromptRequired')}</small>
          ) : (
            <small className="schedule-form-help">{tr('schedules.form.promptHelp')}</small>
          )}
        </label>
        {editing ? (
          <div className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.chat')}</span>
            <code title={chatId}>{chatDisplayTitle(editing) ?? chatId}</code>
          </div>
        ) : !localDelivery ? (
          <div className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.chat')} <i className="req" aria-hidden="true">*</i></span>
            {showGroupSelect ? (
              <>
                <select
                  value={chatId}
                  onChange={e => setChatId(e.target.value)}
                  required
                  aria-invalid={chatMissing || undefined}
                >
                  <option value="" disabled>{tr('schedules.form.chatPlaceholder')}</option>
                  {groupOptions.map(g => {
                    const inChat = g.memberBots?.filter(b => b.inChat).length ?? 0;
                    return (
                      <option key={g.chatId} value={g.chatId}>
                        {g.name ?? g.chatId}{inChat > 0 ? ` · ${inChat} bots` : ''}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  className="schedule-form-link"
                  onClick={() => setChatManual(true)}
                >
                  {tr('schedules.form.chatManual')}
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={chatId}
                  onChange={e => setChatId(e.target.value)}
                  placeholder="oc_..."
                  required
                  aria-invalid={chatMissing || undefined}
                />
                {groupOptions.length > 0 ? (
                  <button
                    type="button"
                    className="schedule-form-link"
                    onClick={() => { setChatManual(false); setChatId(''); }}
                  >
                    {tr('schedules.form.chatBackToSelect')}
                  </button>
                ) : null}
              </>
            )}
            {chatMissing ? (
              <small className="schedule-form-error-inline">{tr('schedules.form.errChatRequired')}</small>
            ) : null}
          </div>
        ) : null}
        {localDelivery ? (
          <div className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.deliver')}</span>
            <div className="schedule-form-placement">
              <strong>{tr('schedules.deliveryLocal')}</strong>
              <small className="schedule-form-help">{tr('schedules.form.localHelp')}</small>
            </div>
          </div>
        ) : (
          <div className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.deliver')}</span>
            <div className="schedule-form-radio-group">
              <label>
                <input
                  type="radio"
                  name="executionPosition"
                  value="top-level"
                  checked={executionPosition === 'top-level'}
                  onChange={() => setExecutionPosition('top-level')}
                />
                {tr('schedules.deliveryTopLevel')}
              </label>
              <label>
                <input
                  type="radio"
                  name="executionPosition"
                  value="topic"
                  checked={executionPosition === 'topic'}
                  onChange={() => setExecutionPosition('topic')}
                />
                {tr('schedules.deliveryThread')}
              </label>
              <label>
                <input
                  type="radio"
                  name="executionPosition"
                  value="new-topic"
                  checked={executionPosition === 'new-topic'}
                  onChange={() => {
                    setExecutionPosition('new-topic');
                    setSilent(false);
                  }}
                />
                {tr('schedules.deliveryNewTopic')}
              </label>
            </div>
            <small className="schedule-form-help">
              {executionPosition === 'top-level'
                ? tr('schedules.form.topLevelHelp')
                : executionPosition === 'topic'
                  ? tr('schedules.form.topicHelp')
                  : tr('schedules.form.newTopicHelp')}
            </small>
          </div>
        )}
        {!localDelivery && executionPosition === 'topic' ? (
          <label className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.topicRoot')}</span>
            <input
              type="text"
              value={rootMessageId}
              onChange={e => setRootMessageId(e.target.value)}
              placeholder="om_..."
              required
              aria-invalid={rootMissing || undefined}
            />
            {rootMissing ? (
              <small className="schedule-form-error-inline">{tr('schedules.form.errRootRequired')}</small>
            ) : (
              <small className="schedule-form-help">{tr('schedules.form.topicRootHelp')}</small>
            )}
          </label>
        ) : null}
        {!localDelivery && executionPosition === 'new-topic' ? (
          <label className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.topicTitle')}</span>
            <input
              type="text"
              value={topicTitle}
              onChange={e => setTopicTitle(e.target.value)}
              placeholder={tr('schedules.form.topicTitlePlaceholder')}
              maxLength={200}
            />
            <small className="schedule-form-help schedule-form-help-with-count">
              {tr('schedules.form.topicTitleHelp')}
              <span>{Array.from(topicTitle).length}/200</span>
            </small>
          </label>
        ) : null}
        <label className="schedule-form-field schedule-form-toggle">
          <input
            type="checkbox"
            checked={silent}
            onChange={e => setSilent(e.target.checked)}
          />
          <span>
            {tr('schedules.form.silent')}
            <small className="schedule-form-help">{tr('schedules.form.silentHelp')}</small>
          </span>
        </label>
        {executionPosition === 'new-topic' && silent ? (
          <p className="schedule-form-help">{tr('schedules.form.silentNewTopicConflict')}</p>
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
          >
            {editing ? tr('schedules.form.save') : tr('schedules.form.create')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
