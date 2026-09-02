import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Cron } from 'croner';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';
import {
  CreateActionButton,
  DropdownMenu,
  FieldTitle,
  LoadingState,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverviewListTail,
  RefreshIconButton,
} from './dashboard-components.js';
import { store } from './store.js';
import { chatDisplayTitle, loadNameMaps, ui } from './ui.js';
import { confirm } from './confirm-modal.js';
import { toast } from './toast.js';
import { fetchGroupsSnapshot, type GroupChat } from './groups-api.js';

type ScheduleRow = Record<string, any> & {
  id: string;
  chatId?: string;
  chatIds?: string[];
  hasPrecondition?: boolean;
  preconditionEnabled?: boolean;
  preconditionSource?: 'inline' | 'file';
  preconditionScript?: string;
  preconditionFilePath?: string;
};
type ScheduleBotOption = {
  larkAppId: string;
  botName?: string;
  scheduleWorkingDir?: string | null;
};
type ScheduleAction = 'run' | 'pause' | 'resume';
type ActionFeedback = 'success' | 'error';
type ScheduleRunOutcome = 'model_dispatched' | 'precondition_skipped' | 'error';
type ScheduleTargetRunResult = {
  chatId: string;
  outcome: 'model_dispatched' | 'error';
  error?: string;
};
type ScheduleRunLogEntry = {
  id: string;
  taskId: string;
  trigger: 'scheduler' | 'dashboard';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: ScheduleRunOutcome;
  precondition: 'none' | 'disabled' | 'passed' | 'skipped' | 'error';
  additionalPrompt: boolean;
  errorCode?: string;
  error?: string;
  targetResults?: ScheduleTargetRunResult[];
};
type ScheduleRunHistoryPreview = {
  logs: ScheduleRunLogEntry[];
  total: number;
};
type ScheduleRunLogPage = {
  logs: ScheduleRunLogEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};
export type PreconditionEditMode = 'keep' | 'inline' | 'file';
type PreconditionHelpSource = 'inline' | 'file';
const RUN_ACTION_MIN_PENDING_MS = 1000;
const SCHEDULE_RUN_LOG_PAGE_SIZE = 50;
const SCHEDULE_RUN_HISTORY_PREVIEW_LIMIT = 50;
const PRECONDITION_SCRIPT_EXAMPLE = String.raw`if test -f .ready; then
  printf '1\n'
else
  printf '0\n'
fi`;
const PRECONDITION_PROMPT_EXAMPLE = String.raw`if test -f .ready; then
  printf '1\n'
  cat >&3 <<'PROMPT'
The readiness check passed. Include that context in this run.
PROMPT
else
  printf '0\n'
fi`;

export type SchedulePreconditionFormError =
  | 'source_required'
  | 'script_required'
  | 'file_required'
  | 'file_nul'
  | 'file_tilde';

export type SchedulePreconditionFormFields = {
  preconditionEnabled?: boolean;
  preconditionScript?: string | null;
  preconditionFilePath?: string;
};

export type SchedulePreconditionEditorInitialState = {
  hasExisting: boolean;
  enabled: boolean;
  mode: PreconditionEditMode;
  script: string;
  filePath: string;
};

/** Prefer the authenticated source projection when it is complete. `keep` is
 *  retained only as a fail-safe for an older service or a damaged projection. */
export function schedulePreconditionEditorInitialState(input: {
  hasPrecondition?: boolean;
  preconditionEnabled?: boolean;
  preconditionSource?: 'inline' | 'file';
  preconditionScript?: string;
  preconditionFilePath?: string;
} | null): SchedulePreconditionEditorInitialState {
  const hasExisting = input?.hasPrecondition === true;
  const enabled = hasExisting && input?.preconditionEnabled !== false;
  if (!hasExisting) {
    return { hasExisting: false, enabled: false, mode: 'inline', script: '', filePath: '' };
  }
  if (
    input.preconditionSource === 'inline'
    && typeof input.preconditionScript === 'string'
    && input.preconditionScript.trim().length > 0
  ) {
    return {
      hasExisting: true,
      enabled,
      mode: 'inline',
      script: input.preconditionScript,
      filePath: '',
    };
  }
  if (
    input.preconditionSource === 'file'
    && typeof input.preconditionFilePath === 'string'
    && input.preconditionFilePath.trim().length > 0
  ) {
    return {
      hasExisting: true,
      enabled,
      mode: 'file',
      script: '',
      filePath: input.preconditionFilePath,
    };
  }
  return { hasExisting: true, enabled, mode: 'keep', script: '', filePath: '' };
}

export function schedulePreconditionPathExample(
  workingDir: string,
  relativePath: string,
): string {
  if (!workingDir) return relativePath;
  return `${workingDir.endsWith('/') ? workingDir : `${workingDir}/`}${relativePath}`;
}

function SchedulePreconditionProtocolHelp(props: {
  tr: ReturnType<typeof useT>;
  onUseSimple?: () => void;
  onUsePrompt?: () => void;
}) {
  const { tr, onUseSimple, onUsePrompt } = props;
  return (
    <>
      <p><strong>{tr('schedules.form.preconditionRule')}</strong></p>
      <div className="schedule-precondition-example-header">
        <span>{tr('schedules.form.preconditionExampleTitle')}</span>
        {onUseSimple ? (
          <button type="button" onClick={onUseSimple}>
            {tr('schedules.form.preconditionUseExample')}
          </button>
        ) : null}
      </div>
      <pre aria-label={tr('schedules.form.preconditionExampleTitle')}><code>{PRECONDITION_SCRIPT_EXAMPLE}</code></pre>
      <p>{tr('schedules.form.preconditionPromptHelp')}</p>
      <div className="schedule-precondition-example-header">
        <span>{tr('schedules.form.preconditionPromptExampleTitle')}</span>
        {onUsePrompt ? (
          <button type="button" onClick={onUsePrompt}>
            {tr('schedules.form.preconditionUsePromptExample')}
          </button>
        ) : null}
      </div>
      <pre aria-label={tr('schedules.form.preconditionPromptExampleTitle')}><code>{PRECONDITION_PROMPT_EXAMPLE}</code></pre>
      <p><strong>{tr('schedules.form.preconditionPromptPrivacy')}</strong></p>
    </>
  );
}

function SchedulePreconditionSourceHelp(props: {
  source: PreconditionHelpSource;
  workingDir: string;
  tr: ReturnType<typeof useT>;
}) {
  const { source, workingDir, tr } = props;
  const relativeFileExample = workingDir
    ? schedulePreconditionPathExample(workingDir, 'scripts/check-ready.sh')
    : '';
  const relativeScriptExample = workingDir
    ? schedulePreconditionPathExample(workingDir, '.ready')
    : '';

  return (
    <section className="schedule-precondition-source-help" aria-labelledby="schedule-precondition-source-help-title">
      <h3 id="schedule-precondition-source-help-title">
        {source === 'inline'
          ? tr('schedules.form.preconditionSourceInline')
          : tr('schedules.form.preconditionSourceFile')}
      </h3>
      {source === 'inline' ? (
        <p>{tr('schedules.form.preconditionHelp')}</p>
      ) : (
        <>
          <p>{tr('schedules.form.preconditionFileHelp')}</p>
          <dl className="schedule-precondition-path-context">
            <div>
              <dt>{tr('schedules.form.preconditionWorkingDir')}</dt>
              <dd aria-live="polite">
                {workingDir ? (
                  <code>{workingDir}</code>
                ) : (
                  tr('schedules.form.preconditionWorkingDirUnavailable')
                )}
              </dd>
            </div>
            <div>
              <dt>{tr('schedules.form.preconditionRelativePath')}</dt>
              <dd>
                {workingDir ? (
                  <><code>scripts/check-ready.sh</code> → <code>{relativeFileExample}</code></>
                ) : (
                  tr('schedules.form.preconditionRelativePathUnavailable')
                )}
              </dd>
            </div>
            <div>
              <dt>{tr('schedules.form.preconditionAbsolutePath')}</dt>
              <dd><code>/opt/botmux/check-ready.sh</code> — {tr('schedules.form.preconditionAbsolutePathHelp')}</dd>
            </div>
            <div>
              <dt>{tr('schedules.form.preconditionScriptWorkingDir')}</dt>
              <dd>
                {tr('schedules.form.preconditionScriptWorkingDirHelp')}
                {relativeScriptExample ? (
                  <> {tr('schedules.form.preconditionScriptWorkingDirExample')} <code>.ready</code> → <code>{relativeScriptExample}</code></>
                ) : null}
              </dd>
            </div>
          </dl>
          <p>{tr('schedules.form.preconditionFileRequirements')}</p>
        </>
      )}
    </section>
  );
}

function SchedulePreconditionHelpDialog(props: {
  open: boolean;
  mode: PreconditionEditMode;
  source: PreconditionHelpSource;
  workingDir: string;
  tr: ReturnType<typeof useT>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onUseSimple(): void;
  onUsePrompt(): void;
}) {
  const { open, mode, source, tr } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const canApplyExample = mode === 'inline' && source === 'inline';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try {
        dialog.showModal();
        closeButtonRef.current?.focus();
      } catch (error) {
        console.error('Failed to open Bash precondition help dialog', error);
        props.onClose();
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function closeDialog(): void {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else props.onClose();
  }

  function finishClose(): void {
    props.onClose();
    props.returnFocusRef.current?.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      id="schedule-precondition-help-dialog"
      className="schedule-precondition-help-dialog"
      aria-labelledby="schedule-precondition-help-title"
      aria-describedby="schedule-precondition-help-intro"
      onClose={finishClose}
      onCancel={e => {
        e.preventDefault();
        closeDialog();
      }}
      onClick={e => { if (e.target === dialogRef.current) closeDialog(); }}
    >
      <article>
        <header>
          <div>
            <h2 id="schedule-precondition-help-title">
              {tr('schedules.form.preconditionHelpTitle')}
            </h2>
            <p id="schedule-precondition-help-intro">
              {tr('schedules.form.preconditionHelpIntro')}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="schedule-precondition-help-close"
            aria-label={tr('schedules.form.preconditionHelpClose')}
            title={tr('schedules.form.preconditionHelpClose')}
            onClick={closeDialog}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="schedule-precondition-help-body">
          {canApplyExample ? (
            <p className="schedule-precondition-help-apply-note" role="note">
              {tr('schedules.form.preconditionHelpApplyNote')}
            </p>
          ) : (
            <p className="schedule-precondition-help-view-only" role="note">
              {tr('schedules.form.preconditionHelpViewOnly')}
            </p>
          )}
          <SchedulePreconditionSourceHelp
            source={source}
            workingDir={props.workingDir}
            tr={tr}
          />
          <SchedulePreconditionProtocolHelp
            tr={tr}
            onUseSimple={canApplyExample ? () => {
              props.onUseSimple();
              closeDialog();
            } : undefined}
            onUsePrompt={canApplyExample ? () => {
              props.onUsePrompt();
              closeDialog();
            } : undefined}
          />
        </div>
      </article>
    </dialog>
  );
}

/** Convert the visible precondition editor state into the minimal API DTO.
 *  An unchanged revealed definition is intentionally omitted so ordinary task
 *  edits do not rewrite its protected sidecar record. */
export function buildSchedulePreconditionFormFields(input: {
  hasExisting: boolean;
  initialEnabled: boolean;
  initialMode: PreconditionEditMode;
  initialScript: string;
  initialFilePath: string;
  enabled: boolean;
  remove: boolean;
  mode: PreconditionEditMode;
  script: string;
  filePath: string;
}): { ok: true; fields: SchedulePreconditionFormFields } | { ok: false; error: SchedulePreconditionFormError } {
  if (input.remove) return { ok: true, fields: { preconditionScript: null } };
  if (!input.hasExisting && !input.enabled) return { ok: true, fields: {} };

  const fields: SchedulePreconditionFormFields = {};
  if (!input.hasExisting || input.enabled !== input.initialEnabled) {
    fields.preconditionEnabled = input.enabled;
  }
  if (input.mode === 'keep') {
    return input.hasExisting
      ? { ok: true, fields }
      : { ok: false, error: 'source_required' };
  }
  if (input.mode === 'inline') {
    if (!input.script.trim()) return { ok: false, error: 'script_required' };
    const sourceChanged = !input.hasExisting
      || input.initialMode !== 'inline'
      || input.script !== input.initialScript;
    if (sourceChanged) fields.preconditionScript = input.script;
    return { ok: true, fields };
  }
  const path = input.filePath.trim();
  if (!path) return { ok: false, error: 'file_required' };
  if (path.includes('\0')) return { ok: false, error: 'file_nul' };
  if (path.startsWith('~')) return { ok: false, error: 'file_tilde' };
  const sourceChanged = !input.hasExisting
    || input.initialMode !== 'file'
    || path !== input.initialFilePath.trim();
  if (sourceChanged) fields.preconditionFilePath = path;
  return { ok: true, fields };
}

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

export function formatScheduleRepeat(
  repeat?: { times: number | null; completed: number },
): string | null {
  if (!repeat) return null;
  return `${repeat.completed}/${repeat.times ?? '∞'}`;
}

export function scheduleRunHistoryForBackdrop<T extends { outcome: ScheduleRunOutcome }>(
  newestFirst: readonly T[],
): T[] {
  return newestFirst.slice(0, SCHEDULE_RUN_HISTORY_PREVIEW_LIMIT).reverse();
}

export function countScheduleRunHistory(
  logs: readonly { outcome: ScheduleRunOutcome }[],
): Record<ScheduleRunOutcome, number> {
  const counts: Record<ScheduleRunOutcome, number> = {
    model_dispatched: 0,
    precondition_skipped: 0,
    error: 0,
  };
  for (const log of logs) counts[log.outcome] += 1;
  return counts;
}

export function scheduleTargetChatIds(
  schedule: { chatIds?: unknown; chatId?: unknown } | null | undefined,
): string[] {
  const source = Array.isArray(schedule?.chatIds)
    ? schedule.chatIds
    : [schedule?.chatId];
  const seen = new Set<string>();
  const chatIds: string[] = [];
  for (const value of source) {
    if (typeof value !== 'string') continue;
    const chatId = value.trim();
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    chatIds.push(chatId);
  }
  return chatIds;
}

export function parseScheduleChatIds(value: string): string[] {
  return scheduleTargetChatIds({ chatIds: value.split(/[\s,;]+/) });
}

export function scheduleRunTargetResults(value: unknown): ScheduleTargetRunResult[] {
  if (!value || typeof value !== 'object') return [];
  const targetResults = (value as { targetResults?: unknown }).targetResults;
  if (!Array.isArray(targetResults)) return [];
  const parsed: ScheduleTargetRunResult[] = [];
  for (const result of targetResults) {
    if (!result || typeof result !== 'object') continue;
    const chatId = typeof (result as { chatId?: unknown }).chatId === 'string'
      ? (result as { chatId: string }).chatId.trim()
      : '';
    const outcome = (result as { outcome?: unknown }).outcome;
    if (!chatId || (outcome !== 'model_dispatched' && outcome !== 'error')) continue;
    const error = typeof (result as { error?: unknown }).error === 'string'
      ? (result as { error: string }).error
      : undefined;
    parsed.push({ chatId, outcome, ...(error ? { error } : {}) });
  }
  return parsed;
}

function isScheduleRunOutcome(value: unknown): value is ScheduleRunOutcome {
  return value === 'model_dispatched' || value === 'precondition_skipped' || value === 'error';
}

async function fetchScheduleRunHistoryPreview(
  taskId: string,
  signal: AbortSignal,
): Promise<ScheduleRunHistoryPreview> {
  const response = await fetch(
    `/api/schedules/${encodeURIComponent(taskId)}/logs?limit=${SCHEDULE_RUN_HISTORY_PREVIEW_LIMIT}&offset=0`,
    { signal },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`invalid_response: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body
      ? String((body as { error?: unknown }).error ?? response.status)
      : String(response.status);
    throw new Error(error);
  }
  if (
    !body
    || typeof body !== 'object'
    || !Array.isArray((body as { logs?: unknown }).logs)
    || typeof (body as { total?: unknown }).total !== 'number'
  ) {
    throw new Error('invalid_response');
  }
  const rawLogs = (body as { logs: unknown[] }).logs;
  if (rawLogs.some(log => (
    !log
    || typeof log !== 'object'
    || typeof (log as { id?: unknown }).id !== 'string'
    || !isScheduleRunOutcome((log as { outcome?: unknown }).outcome)
  ))) {
    throw new Error('invalid_response');
  }
  return {
    logs: rawLogs as ScheduleRunLogEntry[],
    total: Math.max(0, Math.floor((body as { total: number }).total)),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export function formatScheduleRunDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

function ScheduleRunLogDialog(props: {
  open: boolean;
  schedule: ScheduleRow | null;
  scheduleTimeZone?: string;
  tr: ReturnType<typeof useT>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const { open, schedule, scheduleTimeZone, tr } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const [logs, setLogs] = useState<ScheduleRunLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && schedule && !dialog.open) {
      try {
        dialog.showModal();
        closeButtonRef.current?.focus();
        setLogs([]);
        setTotal(0);
        setHasMore(false);
        setSelectedId(null);
        setError(null);
        void loadLogs('initial');
      } catch (openError) {
        console.error('Failed to open schedule run log dialog', openError);
        props.onClose();
      }
    } else if ((!open || !schedule) && dialog.open) {
      activeRequestRef.current?.abort();
      dialog.close();
    }
    return () => {
      if (!open) activeRequestRef.current?.abort();
    };
  }, [open, schedule?.id]);

  async function loadLogs(mode: 'initial' | 'refresh' | 'more'): Promise<void> {
    if (!schedule) return;
    const offset = mode === 'more' ? logs.length : 0;
    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;
    setError(null);
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    if (mode === 'more') setLoadingMore(true);

    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(schedule.id)}/logs?limit=${SCHEDULE_RUN_LOG_PAGE_SIZE}&offset=${offset}`,
        { signal: controller.signal },
      );
      const body = await response.json().catch(() => null) as (ScheduleRunLogPage & { error?: string }) | null;
      if (!response.ok) {
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      if (!body || !Array.isArray(body.logs)) {
        throw new Error(tr('schedules.logs.invalidResponse'));
      }
      if (activeRequestRef.current !== controller) return;

      const nextLogs = body.logs;
      const nextTotal = Number.isFinite(body.total) ? body.total : offset + nextLogs.length;
      const nextHasMore = typeof body.hasMore === 'boolean'
        ? body.hasMore
        : offset + nextLogs.length < nextTotal;
      if (mode === 'more') {
        setLogs(current => {
          const existing = new Set(current.map(entry => entry.id));
          return [...current, ...nextLogs.filter(entry => !existing.has(entry.id))];
        });
      } else {
        setLogs(nextLogs);
        setSelectedId(nextLogs[0]?.id ?? null);
      }
      setTotal(nextTotal);
      setHasMore(nextHasMore);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (activeRequestRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (activeRequestRef.current === controller) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }

  function closeDialog(): void {
    activeRequestRef.current?.abort();
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else props.onClose();
  }

  function finishClose(): void {
    activeRequestRef.current?.abort();
    props.onClose();
    props.returnFocusRef.current?.focus();
  }

  const selected = logs.find(entry => entry.id === selectedId) ?? logs[0] ?? null;
  const selectedTargetResults = scheduleRunTargetResults(selected);
  const dispatchedTargetCount = selectedTargetResults.filter(
    result => result.outcome === 'model_dispatched',
  ).length;

  function outcomeLabel(outcome: ScheduleRunLogEntry['outcome']): string {
    if (outcome === 'model_dispatched') return tr('schedules.logs.outcomeDispatched');
    if (outcome === 'precondition_skipped') return tr('schedules.logs.outcomeSkipped');
    return tr('schedules.logs.outcomeError');
  }

  function preconditionLabel(precondition: ScheduleRunLogEntry['precondition']): string {
    if (precondition === 'none') return tr('schedules.logs.preconditionNone');
    if (precondition === 'disabled') return tr('schedules.logs.preconditionDisabled');
    if (precondition === 'passed') return tr('schedules.logs.preconditionPassed');
    if (precondition === 'skipped') return tr('schedules.logs.preconditionSkipped');
    return tr('schedules.logs.preconditionError');
  }

  return (
    <dialog
      ref={dialogRef}
      id="schedule-run-log-dialog"
      className="schedule-run-log-dialog"
      aria-labelledby="schedule-run-log-title"
      aria-describedby="schedule-run-log-intro"
      onClose={finishClose}
      onCancel={event => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={event => { if (event.target === dialogRef.current) closeDialog(); }}
    >
      <article>
        <header className="schedule-run-log-header">
          <div>
            <p className="eyebrow">{tr('schedules.logs.eyebrow')}</p>
            <h2 id="schedule-run-log-title">
              {tr('schedules.logs.title')} · <span>{schedule?.name ?? schedule?.id ?? '—'}</span>
            </h2>
            <p id="schedule-run-log-intro">{tr('schedules.logs.intro')}</p>
          </div>
          <div className="schedule-run-log-header-actions">
            <RefreshIconButton
              className="schedule-run-log-refresh"
              label={tr('schedules.logs.refresh')}
              busy={refreshing}
              disabled={loading || refreshing || loadingMore}
              onClick={() => void loadLogs('refresh')}
            />
            <button
              ref={closeButtonRef}
              type="button"
              className="schedule-run-log-close"
              aria-label={tr('schedules.logs.close')}
              title={tr('schedules.logs.close')}
              onClick={closeDialog}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div className="schedule-run-log-body">
          {error ? (
            <div className="schedule-run-log-alert" role="alert">
              <div>
                <strong>{tr('schedules.logs.loadFailed')}</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => void loadLogs(logs.length ? 'refresh' : 'initial')}>
                {tr('schedules.logs.retry')}
              </button>
            </div>
          ) : null}

          {loading ? (
            <LoadingState compact label={tr('schedules.logs.loading')} />
          ) : logs.length === 0 ? (
            error ? null : (
              <div className="schedule-run-log-empty">
                <span aria-hidden="true">◎</span>
                <strong>{tr('schedules.logs.emptyTitle')}</strong>
                <p>{tr('schedules.logs.emptyHint')}</p>
              </div>
            )
          ) : (
            <div className="schedule-run-log-workspace">
              <section className="schedule-run-log-list-panel" aria-labelledby="schedule-run-log-history-title">
                <header>
                  <h3 id="schedule-run-log-history-title">{tr('schedules.logs.history')}</h3>
                  <span>{total}</span>
                </header>
                <ol className="schedule-run-log-list">
                  {logs.map(entry => {
                    const active = selected?.id === entry.id;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className={`schedule-run-log-row outcome-${entry.outcome}${active ? ' is-active' : ''}`}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => setSelectedId(entry.id)}
                        >
                          <span className="schedule-run-log-row-main">
                            <strong>{outcomeLabel(entry.outcome)}</strong>
                            <time dateTime={entry.startedAt}>{fmtScheduleDate(entry.startedAt, scheduleTimeZone)}</time>
                          </span>
                          <span className="schedule-run-log-row-duration">
                            {formatScheduleRunDuration(entry.durationMs)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                {hasMore ? (
                  <button
                    type="button"
                    className="schedule-run-log-more"
                    disabled={loadingMore}
                    onClick={() => void loadLogs('more')}
                  >
                    {loadingMore ? tr('schedules.logs.loadingMore') : tr('schedules.logs.loadMore')}
                  </button>
                ) : null}
              </section>

              <section className="schedule-run-log-detail-panel" aria-labelledby="schedule-run-log-detail-title">
                {selected ? (
                  <>
                    <header>
                      <div>
                        <p id="schedule-run-log-detail-title">{tr('schedules.logs.details')}</p>
                        <time dateTime={selected.startedAt}>{fmtScheduleDate(selected.startedAt, scheduleTimeZone)}</time>
                      </div>
                      <strong className={`schedule-run-log-outcome outcome-${selected.outcome}`}>
                        {outcomeLabel(selected.outcome)}
                      </strong>
                    </header>
                    <dl className="schedule-run-log-facts">
                      <div>
                        <dt>{tr('schedules.logs.trigger')}</dt>
                        <dd>{selected.trigger === 'dashboard'
                          ? tr('schedules.logs.triggerDashboard')
                          : tr('schedules.logs.triggerScheduler')}</dd>
                      </div>
                      <div>
                        <dt>{tr('schedules.logs.duration')}</dt>
                        <dd>{formatScheduleRunDuration(selected.durationMs)}</dd>
                      </div>
                      <div>
                        <dt>{tr('schedules.logs.startedAt')}</dt>
                        <dd><time dateTime={selected.startedAt}>{fmtScheduleDate(selected.startedAt, scheduleTimeZone)}</time></dd>
                      </div>
                      <div>
                        <dt>{tr('schedules.logs.finishedAt')}</dt>
                        <dd><time dateTime={selected.finishedAt}>{fmtScheduleDate(selected.finishedAt, scheduleTimeZone)}</time></dd>
                      </div>
                      <div>
                        <dt>{tr('schedules.logs.precondition')}</dt>
                        <dd>{preconditionLabel(selected.precondition)}</dd>
                      </div>
                      <div>
                        <dt>
                          <FieldTitle
                            help={tr('schedules.logs.boundary')}
                            helpLabel={tr('schedules.logs.boundary')}
                          >
                            {tr('schedules.logs.modelInvocation')}
                          </FieldTitle>
                        </dt>
                        <dd>{selectedTargetResults.length > 0
                          ? tr('schedules.logs.modelInvocationTargets', {
                              submitted: dispatchedTargetCount,
                              total: selectedTargetResults.length,
                            })
                          : selected.outcome === 'model_dispatched'
                            ? tr('schedules.logs.yes')
                            : tr('schedules.logs.no')}</dd>
                      </div>
                      <div>
                        <dt>{tr('schedules.logs.additionalPrompt')}</dt>
                        <dd>{selected.additionalPrompt
                          ? tr('schedules.logs.yes')
                          : tr('schedules.logs.no')}</dd>
                      </div>
                    </dl>
                    {selectedTargetResults.length > 0 ? (
                      <section className="schedule-run-log-targets" aria-labelledby="schedule-run-log-targets-title">
                        <h3 id="schedule-run-log-targets-title">{tr('schedules.logs.targetResults')}</h3>
                        <ul>
                          {selectedTargetResults.map((result, index) => {
                            const targetTitle = chatDisplayTitle({ chatId: result.chatId });
                            return (
                              <li key={`${result.chatId}:${index}`} className={`outcome-${result.outcome}`}>
                                <div>
                                  <strong>{targetTitle ?? result.chatId}</strong>
                                  {targetTitle ? <code>{result.chatId}</code> : null}
                                </div>
                                <span>{result.outcome === 'model_dispatched'
                                  ? tr('schedules.logs.targetDispatched')
                                  : tr('schedules.logs.targetError')}</span>
                                {result.error ? <p>{result.error}</p> : null}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ) : null}
                    {selected.errorCode || selected.error ? (
                      <div className="schedule-run-log-error-detail">
                        {selected.errorCode ? (
                          <p><span>{tr('schedules.logs.errorCode')}</span><code>{selected.errorCode}</code></p>
                        ) : null}
                        {selected.error ? (
                          <p><span>{tr('schedules.logs.errorMessage')}</span><strong>{selected.error}</strong></p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            </div>
          )}
        </div>
      </article>
    </dialog>
  );
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

function scheduleRunHistoryLabel(
  preview: ScheduleRunHistoryPreview | null,
  tr: ReturnType<typeof useT>,
): string | undefined {
  if (!preview) return undefined;
  const displayed = scheduleRunHistoryForBackdrop(preview.logs);
  if (displayed.length === 0) return tr('schedules.logs.emptyTitle');
  const counts = countScheduleRunHistory(displayed);
  return tr('schedules.logs.backgroundSummary', {
    shown: displayed.length,
    total: preview.total,
    dispatched: counts.model_dispatched,
    skipped: counts.precondition_skipped,
    failed: counts.error,
  });
}

function scheduleChatPresentation(
  schedule: ScheduleRow,
  tr: ReturnType<typeof useT>,
): { summary: string; title: string } | null {
  const chatIds = scheduleTargetChatIds(schedule);
  if (chatIds.length === 0) return null;
  const labels = chatIds.map(chatId => chatDisplayTitle({
    chatId,
    chatDisplayName: schedule.chatId === chatId ? schedule.chatDisplayName : undefined,
  }) ?? chatId);
  const summary = labels.length === 1
    ? labels[0]!
    : labels.length === 2
      ? tr('schedules.chatSummaryTwo', { first: labels[0]!, second: labels[1]! })
      : tr('schedules.chatSummaryMany', {
          first: labels[0]!,
          second: labels[1]!,
          count: labels.length,
          remaining: labels.length - 2,
        });
  const title = chatIds.map((chatId, index) => (
    labels[index] === chatId ? chatId : `${labels[index]} · ${chatId}`
  )).join('\n');
  return { summary, title };
}

function ScheduleRowCard(props: {
  schedule: ScheduleRow;
  scheduleTimeZone?: string;
  pending: string | null;
  feedback: Record<string, ActionFeedback>;
  tr: ReturnType<typeof useT>;
  onAction(id: string, op: ScheduleAction): void;
  onOpenLogs(schedule: ScheduleRow, trigger: HTMLButtonElement): void;
  onEdit(schedule: ScheduleRow): void;
  onDelete(schedule: ScheduleRow): void;
}) {
  const { schedule: s, scheduleTimeZone, tr } = props;
  const chatPresentation = scheduleChatPresentation(s, tr);
  const kind = String(s.parsed?.kind ?? 'unknown');
  const toggleOp: ScheduleAction = s.enabled ? 'pause' : 'resume';
  const toggleKey = `${s.id}:${toggleOp}`;
  const runKey = `${s.id}:run`;
  const repeat = formatScheduleRepeat(s.repeat);
  const [runHistory, setRunHistory] = useState<ScheduleRunHistoryPreview | null>(null);
  const displayedRunHistory = runHistory
    ? scheduleRunHistoryForBackdrop(runHistory.logs)
    : [];
  const runHistoryLabel = scheduleRunHistoryLabel(runHistory, tr);
  const openLogsLabel = runHistoryLabel
    ? `${tr('schedules.logs.open')} · ${runHistoryLabel}`
    : tr('schedules.logs.open');

  useEffect(() => {
    if (!ui.authed) {
      setRunHistory(null);
      return;
    }
    let activeController: AbortController | null = null;
    let disposed = false;
    const loadHistory = async (): Promise<void> => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const preview = await fetchScheduleRunHistoryPreview(s.id, controller.signal);
        if (!disposed && !controller.signal.aborted) setRunHistory(preview);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        console.warn(
          `[schedule-run-history] Failed to load task ${s.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    void loadHistory();
    const unsubscribe = store.onScheduleRunLogsChanged(taskId => {
      if (taskId === undefined || taskId === s.id) void loadHistory();
    });
    return () => {
      disposed = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [s.id]);

  return (
    <OverviewListItem
      kind="schedule"
      className="schedule-list-row"
      data-id={s.id}
      title={runHistoryLabel}
    >
      {displayedRunHistory.length > 0 ? (
        <span className="schedule-run-log-fill" aria-hidden="true">
          {displayedRunHistory.map(entry => (
            <i key={entry.id} className={`outcome-${entry.outcome}`} />
          ))}
        </span>
      ) : null}
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
          {chatPresentation ? (
            <span
              className="schedule-chat-chip"
              title={chatPresentation.title}
            >
              {tr('schedules.form.chat')}: {chatPresentation.summary}
            </span>
          ) : null}
          <span>{tr('schedules.delivery')}: {placementLabel(s, tr)}</span>
          {s.silent ? <span>🔇 {tr('schedules.silent')}</span> : null}
          {s.hasPrecondition ? (
            <span className={`schedule-precondition-chip${s.preconditionEnabled === false ? ' is-paused' : ''}`}>
              <i className="schedule-precondition-chip-icon" aria-hidden="true">⌘</i>
              {s.preconditionEnabled === false
                ? tr('schedules.preconditionPaused')
                : tr('schedules.precondition')}
            </span>
          ) : null}
          <span>{tr('schedules.next')}: {fmtScheduleDate(s.nextRunAt, scheduleTimeZone)}</span>
          <span>{tr('schedules.last')}: {fmtScheduleDate(s.lastRunAt, scheduleTimeZone)}</span>
          {repeat !== null ? <span>{tr('schedules.repeat')}: {repeat}</span> : null}
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
          <button
            type="button"
            className="schedule-action-button schedule-log-button"
            aria-haspopup="dialog"
            aria-controls="schedule-run-log-dialog"
            onClick={event => props.onOpenLogs(s, event.currentTarget)}
            aria-label={openLogsLabel}
            title={openLogsLabel}
          >
            <span className="schedule-action-label">{tr('schedules.logs.open')}</span>
          </button>
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
  const [bots, setBots] = useState<ScheduleBotOption[]>([]);
  const [, setNameMapsVersion] = useState(0);
  const [logSchedule, setLogSchedule] = useState<ScheduleRow | null>(null);
  const logTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  function openLogs(s: ScheduleRow, trigger: HTMLButtonElement): void {
    logTriggerRef.current = trigger;
    setLogSchedule(s);
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
    preconditionEnabled?: boolean;
    preconditionScript?: string | null;
    preconditionFilePath?: string;
    silent: boolean;
    executionPosition: 'top-level' | 'topic' | 'new-topic';
    rootMessageId: string;
    topicTitle: string;
    updateExecutionPosition: boolean;
    chatIds: string[]; larkAppId: string;
  }): Promise<void> {
    setFormError(null);
    try {
      const url = editing ? `/api/schedules/${encodeURIComponent(editing.id)}` : '/api/schedules';
      const method = editing ? 'PATCH' : 'POST';
      // The owning bot remains immutable after creation. Target groups are
      // editable and are always submitted as an array, including single-group
      // tasks, so the server can preserve one consistent update path.
      const payload = editing
        ? {
            name: data.name,
            schedule: data.schedule,
            prompt: data.prompt,
            silent: data.silent,
            ...(data.preconditionEnabled !== undefined
              ? { preconditionEnabled: data.preconditionEnabled }
              : {}),
            ...(data.preconditionScript !== undefined
              ? { preconditionScript: data.preconditionScript }
              : {}),
            ...(data.preconditionFilePath !== undefined
              ? { preconditionFilePath: data.preconditionFilePath }
              : {}),
            ...(data.updateExecutionPosition ? {
              executionPosition: data.executionPosition,
              rootMessageId: data.rootMessageId,
              topicTitle: data.topicTitle,
              chatIds: data.chatIds,
            } : {}),
          }
        : {
            name: data.name,
            schedule: data.schedule,
            prompt: data.prompt,
            silent: data.silent,
            ...(data.preconditionEnabled !== undefined
              ? { preconditionEnabled: data.preconditionEnabled }
              : {}),
            ...(data.preconditionScript !== undefined
              ? { preconditionScript: data.preconditionScript }
              : {}),
            ...(data.preconditionFilePath !== undefined
              ? { preconditionFilePath: data.preconditionFilePath }
              : {}),
            executionPosition: data.executionPosition,
            rootMessageId: data.rootMessageId,
            topicTitle: data.topicTitle,
            chatIds: data.chatIds,
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
                  onOpenLogs={openLogs}
                  onEdit={openEdit}
                  onDelete={s => void handleDelete(s)}
                />
              ))}
            </OverviewList>
          )}
        </div>
      </section>
      <ScheduleRunLogDialog
        open={logSchedule !== null}
        schedule={logSchedule}
        scheduleTimeZone={scheduleTimeZone}
        tr={tr}
        returnFocusRef={logTriggerRef}
        onClose={() => setLogSchedule(null)}
      />
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
  /** Changed definition controls only. Script null explicitly removes it. */
  preconditionEnabled?: boolean;
  preconditionScript?: string | null;
  preconditionFilePath?: string;
  silent: boolean;
  executionPosition: 'top-level' | 'topic' | 'new-topic';
  rootMessageId: string;
  topicTitle: string;
  updateExecutionPosition: boolean;
  chatIds: string[];
  larkAppId: string;
}

function ScheduleFormModal(props: {
  open: boolean;
  editing: ScheduleRow | null;
  error: string | null;
  bots: ScheduleBotOption[];
  scheduleTimeZone?: string;
  tr: ReturnType<typeof useT>;
  onClose(): void;
  onSubmit(data: ScheduleFormData): void;
}) {
  const { editing, tr, bots, open, scheduleTimeZone } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const preconditionHelpReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [preconditionHelpSource, setPreconditionHelpSource] = useState<PreconditionHelpSource | null>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [schedule, setSchedule] = useState(editing?.schedule ?? '');
  const [prompt, setPrompt] = useState(editing?.prompt ?? '');
  const initialPrecondition = schedulePreconditionEditorInitialState(editing);
  const hasExistingPrecondition = initialPrecondition.hasExisting;
  const initialPreconditionEnabled = initialPrecondition.enabled;
  const [preconditionEnabled, setPreconditionEnabled] = useState(
    initialPreconditionEnabled,
  );
  const [preconditionMode, setPreconditionMode] = useState<PreconditionEditMode>(
    initialPrecondition.mode,
  );
  const [preconditionScript, setPreconditionScript] = useState(initialPrecondition.script);
  const [preconditionFilePath, setPreconditionFilePath] = useState(initialPrecondition.filePath);
  const [removePrecondition, setRemovePrecondition] = useState(false);
  const [preconditionError, setPreconditionError] = useState<SchedulePreconditionFormError | null>(null);
  const [silent, setSilent] = useState(editing?.silent === true);
  const [executionPosition, setExecutionPosition] = useState<'top-level' | 'topic' | 'new-topic'>(
    editing && scheduleExecutionPlacement(editing) === 'thread'
      ? 'topic'
      : editing && scheduleExecutionPlacement(editing) === 'new-topic' ? 'new-topic' : 'top-level',
  );
  const initialChatIds = scheduleTargetChatIds(editing);
  const initialTopicChatId = editing && scheduleExecutionPlacement(editing) === 'thread'
    ? initialChatIds[0] ?? ''
    : '';
  const [rootMessageId, setRootMessageId] = useState(editing?.rootMessageId ?? '');
  const [topicTitle, setTopicTitle] = useState(editing?.topicTitle ?? '');
  const [chatIds, setChatIds] = useState(initialChatIds);
  const [larkAppId, setLarkAppId] = useState(editing?.larkAppId ?? bots[0]?.larkAppId ?? '');
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [chatManual, setChatManual] = useState(false);
  const [chatManualValue, setChatManualValue] = useState(initialChatIds.join('\n'));
  const [chatQuery, setChatQuery] = useState('');
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

  // 创建和编辑都拉取群列表（30s 缓存，与 Groups 等入口共享），这样编辑时
  // 可以改选同一 Bot 已加入的其它群；Bot 本身仍保持不可变。
  useEffect(() => {
    if (!open || localDelivery) return;
    let cancelled = false;
    fetchGroupsSnapshot({ cacheMs: 30_000 })
      .then(snap => { if (!cancelled) setGroups(snap.chats); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, localDelivery]);

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

  // 只列出选中 Bot 已加入的群；编辑任务里不在当前 roster 的既有目标会在
  // selectorOptions 中单独补回，而不会把其它未加入的群误当作可选项。
  const groupOptions = useMemo(() => {
    const filtered = larkAppId
      ? groups.filter(g => g.memberBots?.some(b => b.larkAppId === larkAppId && b.inChat))
      : [];
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

  const groupsHaveMembership = groups.some(g => g.memberBots?.length > 0);

  // 创建时切换 Bot 后只保留新 Bot 已加入的群。编辑时 Bot 不可变，并且任务
  // 的既有未知目标必须保留，避免 roster 暂时缺失导致一次普通保存意外删群。
  useEffect(() => {
    if (editing || !larkAppId || !groupsHaveMembership || chatIds.length === 0) return;
    const allowed = new Set(groupOptions.map(group => group.chatId));
    const nextChatIds = chatIds.filter(chatId => allowed.has(chatId));
    if (nextChatIds.length !== chatIds.length) updateChatSelection(nextChatIds);
  }, [editing, larkAppId, groupsHaveMembership, groupOptions, chatIds]);

  const selectedUnknownChatIds = chatIds.filter(
    chatId => !groupOptions.some(group => group.chatId === chatId),
  );
  const selectorOptions: Array<GroupChat & { retained?: boolean }> = [
    ...groupOptions,
    ...selectedUnknownChatIds.map(chatId => ({ chatId, memberBots: [], retained: true })),
  ];
  const normalizedChatQuery = chatQuery.trim().toLocaleLowerCase();
  const visibleSelectorOptions = normalizedChatQuery
    ? selectorOptions.filter(group => (
        group.chatId.toLocaleLowerCase().includes(normalizedChatQuery)
        || (group.name ?? chatDisplayTitle({
          chatId: group.chatId,
          chatDisplayName: editing?.chatId === group.chatId ? editing.chatDisplayName : undefined,
        }) ?? '')
          .toLocaleLowerCase()
          .includes(normalizedChatQuery)
      ))
    : selectorOptions;

  const showGroupSelect = !localDelivery
    && !chatManual
    && (selectorOptions.length > 0 || groups.length > 0);
  const scheduleInvalid = scheduleTouched && check !== null && !check.ok;
  const schedulePreview = check?.ok ? check.preview : undefined;
  const nameMissing = touched && !name.trim();
  const promptMissing = touched && !prompt.trim();
  const chatMissing = touched && !localDelivery && chatIds.length === 0;
  const topicChatCountInvalid = !localDelivery
    && executionPosition === 'topic'
    && chatIds.length > 1;
  const rootMissing = touched
    && !localDelivery
    && executionPosition === 'topic'
    && chatIds.length === 1
    && !rootMessageId.trim();
  const selectedBot = bots.find(bot => bot.larkAppId === larkAppId);
  const rawPreconditionWorkingDir = editing
    ? editing.workingDir
    : selectedBot?.scheduleWorkingDir;
  const preconditionWorkingDir = typeof rawPreconditionWorkingDir === 'string'
    && rawPreconditionWorkingDir.length > 0
    ? rawPreconditionWorkingDir
    : '';
  const preconditionErrorText = preconditionError === 'source_required'
    ? tr('schedules.form.preconditionErrSource')
    : preconditionError === 'script_required'
      ? tr('schedules.form.preconditionErrScript')
      : preconditionError === 'file_required'
        ? tr('schedules.form.preconditionErrFile')
        : preconditionError === 'file_nul'
          ? tr('schedules.form.preconditionErrFileNul')
          : preconditionError === 'file_tilde'
            ? tr('schedules.form.preconditionErrFileTilde')
            : null;

  function updateChatSelection(nextValues: readonly string[], syncManualValue = true): void {
    const nextChatIds = scheduleTargetChatIds({ chatIds: nextValues });
    if (
      initialTopicChatId
      && (nextChatIds.length !== 1 || nextChatIds[0] !== initialTopicChatId)
    ) {
      setRootMessageId('');
    }
    setChatIds(nextChatIds);
    if (syncManualValue) setChatManualValue(nextChatIds.join('\n'));
  }

  function toggleChat(chatId: string, checked: boolean): void {
    if (checked && executionPosition === 'topic') {
      updateChatSelection([chatId]);
      return;
    }
    updateChatSelection(checked
      ? [...chatIds, chatId]
      : chatIds.filter(value => value !== chatId));
  }

  function updateExecutionPosition(next: 'top-level' | 'topic' | 'new-topic'): void {
    setExecutionPosition(next);
    if (
      next === 'topic'
      && rootMessageId
      && (chatIds.length !== 1 || chatIds[0] !== initialTopicChatId)
    ) {
      setRootMessageId('');
    }
    if (next === 'new-topic') setSilent(false);
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setTouched(true);
    setScheduleTouched(true);
    // 必填内联校验：不静默 return，每个缺字段都有可见红提示
    if (!editing && !larkAppId) return;
    if (!name.trim() || !prompt.trim()) return;
    if (!localDelivery && chatIds.length === 0) return;
    if (!localDelivery && executionPosition === 'topic' && chatIds.length !== 1) return;
    if (!localDelivery && executionPosition === 'topic' && !rootMessageId.trim()) return;
    if (!canSubmitSchedule(schedule, editing?.schedule, tr, scheduleTimeZone)) return;
    const precondition = buildSchedulePreconditionFormFields({
      hasExisting: hasExistingPrecondition,
      initialEnabled: initialPreconditionEnabled,
      initialMode: initialPrecondition.mode,
      initialScript: initialPrecondition.script,
      initialFilePath: initialPrecondition.filePath,
      enabled: preconditionEnabled,
      remove: removePrecondition,
      mode: preconditionMode,
      script: preconditionScript,
      filePath: preconditionFilePath,
    });
    if (!precondition.ok) {
      setPreconditionError(precondition.error);
      return;
    }
    setPreconditionError(null);
    props.onSubmit({
      name: name.trim(),
      schedule: schedule.trim(),
      prompt,
      ...precondition.fields,
      silent,
      executionPosition,
      rootMessageId: rootMessageId.trim(),
      topicTitle: topicTitle.trim(),
      updateExecutionPosition: !localDelivery,
      chatIds,
      larkAppId,
    });
  }

  return (
    <>
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
        ) : (
          <div className="schedule-form-field">
            <span className="schedule-form-label">{tr('schedules.form.bot')}</span>
            <div className="schedule-form-readonly">
              <strong>{bots.find(bot => bot.larkAppId === larkAppId)?.botName
                ?? editing.botName
                ?? larkAppId}</strong>
              <code>{larkAppId}</code>
            </div>
            <small className="schedule-form-help">{tr('schedules.form.botImmutableHelp')}</small>
          </div>
        )}
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
        <div className="schedule-form-field schedule-precondition-field">
          <span id="schedule-precondition-label" className="schedule-form-label">
            {tr('schedules.form.precondition')}
          </span>
          <label className="toggle-row schedule-precondition-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={preconditionEnabled}
              disabled={removePrecondition}
              aria-labelledby="schedule-precondition-label schedule-precondition-toggle-title"
              aria-describedby="schedule-precondition-toggle-help"
              aria-controls="schedule-precondition-panel"
              onChange={e => {
                setPreconditionEnabled(e.currentTarget.checked);
                setPreconditionError(null);
              }}
            />
            <span className="switch" aria-hidden="true" />
            <span className="toggle-tx">
              <strong id="schedule-precondition-toggle-title">{tr('schedules.form.preconditionEnable')}</strong>
              <small id="schedule-precondition-toggle-help">
                {tr('schedules.form.preconditionEnableHelp')}
              </small>
            </span>
          </label>

          {hasExistingPrecondition && !removePrecondition ? (
            <p className={`schedule-precondition-status${preconditionEnabled ? '' : ' is-paused'}`} role="status">
              {initialPrecondition.mode === 'keep'
                ? tr('schedules.form.preconditionUnavailableHelp')
                : preconditionEnabled
                  ? tr('schedules.form.preconditionConfiguredHelp')
                  : tr('schedules.form.preconditionPausedHelp')}
            </p>
          ) : null}

          {(preconditionEnabled || hasExistingPrecondition) && !removePrecondition ? (
            <div id="schedule-precondition-panel" className="schedule-precondition-panel">
              <fieldset className="schedule-precondition-source">
                <legend>{tr('schedules.form.preconditionSource')}</legend>
                <div className="schedule-form-radio-group">
                  {initialPrecondition.mode === 'keep' ? (
                    <label>
                      <input
                        type="radio"
                        name="preconditionSource"
                        value="keep"
                        checked={preconditionMode === 'keep'}
                        onChange={() => { setPreconditionMode('keep'); setPreconditionError(null); }}
                      />
                      {tr('schedules.form.preconditionSourceKeep')}
                    </label>
                  ) : null}
                  <span className="schedule-precondition-source-option">
                    <label>
                      <input
                        type="radio"
                        name="preconditionSource"
                        value="inline"
                        checked={preconditionMode === 'inline'}
                        onChange={() => { setPreconditionMode('inline'); setPreconditionError(null); }}
                      />
                      {tr('schedules.form.preconditionSourceInline')}
                    </label>
                    <button
                      type="button"
                      className="schedule-precondition-help-trigger"
                      aria-label={tr('schedules.form.preconditionInlineHelpOpen')}
                      title={tr('schedules.form.preconditionInlineHelpOpen')}
                      aria-haspopup="dialog"
                      aria-controls="schedule-precondition-help-dialog"
                      aria-expanded={preconditionHelpSource === 'inline'}
                      onClick={e => {
                        preconditionHelpReturnFocusRef.current = e.currentTarget;
                        setPreconditionHelpSource('inline');
                      }}
                    >
                      <span aria-hidden="true">?</span>
                    </button>
                  </span>
                  <span className="schedule-precondition-source-option">
                    <label>
                      <input
                        type="radio"
                        name="preconditionSource"
                        value="file"
                        checked={preconditionMode === 'file'}
                        onChange={() => { setPreconditionMode('file'); setPreconditionError(null); }}
                      />
                      {tr('schedules.form.preconditionSourceFile')}
                    </label>
                    <button
                      type="button"
                      className="schedule-precondition-help-trigger"
                      aria-label={tr('schedules.form.preconditionFileHelpOpen')}
                      title={tr('schedules.form.preconditionFileHelpOpen')}
                      aria-haspopup="dialog"
                      aria-controls="schedule-precondition-help-dialog"
                      aria-expanded={preconditionHelpSource === 'file'}
                      onClick={e => {
                        preconditionHelpReturnFocusRef.current = e.currentTarget;
                        setPreconditionHelpSource('file');
                      }}
                    >
                      <span aria-hidden="true">?</span>
                    </button>
                  </span>
                </div>
              </fieldset>

              {preconditionMode === 'keep' ? (
                <p className="schedule-form-help" role="note">
                  {tr('schedules.form.preconditionKeepHelp')}
                </p>
              ) : preconditionMode === 'inline' ? (
                <div className="schedule-form-field">
                  <label className="schedule-form-label" htmlFor="schedule-precondition-script">
                    {tr('schedules.form.preconditionInline')}
                  </label>
                  <textarea
                    id="schedule-precondition-script"
                    className="schedule-precondition-editor"
                    value={preconditionScript}
                    onChange={e => { setPreconditionScript(e.target.value); setPreconditionError(null); }}
                    rows={5}
                    spellCheck={false}
                    aria-invalid={preconditionError === 'script_required' || undefined}
                    aria-describedby={preconditionError ? 'schedule-precondition-error' : undefined}
                    placeholder={tr('schedules.form.preconditionPlaceholder')}
                  />
                </div>
              ) : (
                <div className="schedule-form-field">
                  <label className="schedule-form-label" htmlFor="schedule-precondition-file-path">
                    {tr('schedules.form.preconditionFilePath')}
                  </label>
                  <input
                    id="schedule-precondition-file-path"
                    className="schedule-precondition-file-path"
                    type="text"
                    value={preconditionFilePath}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={preconditionError?.startsWith('file_') || undefined}
                    aria-describedby={preconditionError ? 'schedule-precondition-error' : undefined}
                    placeholder={tr('schedules.form.preconditionFilePlaceholder')}
                    onChange={e => { setPreconditionFilePath(e.currentTarget.value); setPreconditionError(null); }}
                  />
                </div>
              )}
            </div>
          ) : null}

          {preconditionErrorText ? (
            <small id="schedule-precondition-error" className="schedule-form-error-inline" role="alert">
              {preconditionErrorText}
            </small>
          ) : null}

          {hasExistingPrecondition ? (
            <label className="schedule-precondition-remove">
              <input
                type="checkbox"
                checked={removePrecondition}
                onChange={e => { setRemovePrecondition(e.target.checked); setPreconditionError(null); }}
              />
              <span>{tr('schedules.form.preconditionRemove')}</span>
            </label>
          ) : null}
          {removePrecondition ? (
            <small className="schedule-form-error-inline" role="status">
              {tr('schedules.form.preconditionRemoveHelp')}
            </small>
          ) : null}
        </div>
        {!localDelivery ? (
          <div className="schedule-form-field">
            <span className="schedule-form-label">
              <FieldTitle
                help={tr('schedules.form.chatBindingHelp')}
                helpLabel={tr('schedules.form.chatBindingHelp')}
              >
                {tr('schedules.form.chatBinding')}
              </FieldTitle>{' '}
              <i className="req" aria-hidden="true">*</i>
            </span>
            {showGroupSelect ? (
              <>
                <input
                  className="schedule-chat-search"
                  type="search"
                  value={chatQuery}
                  onChange={event => setChatQuery(event.currentTarget.value)}
                  placeholder={tr('schedules.form.chatSearchPlaceholder')}
                  aria-label={tr('schedules.form.chatSearchLabel')}
                />
                <div
                  className="schedule-chat-selector"
                  role="group"
                  aria-label={tr('schedules.form.chatBinding')}
                  aria-invalid={chatMissing || topicChatCountInvalid || undefined}
                >
                  {visibleSelectorOptions.length > 0 ? visibleSelectorOptions.map(group => {
                    const displayName = group.name ?? chatDisplayTitle({
                      chatId: group.chatId,
                      chatDisplayName: editing?.chatId === group.chatId
                        ? editing.chatDisplayName
                        : undefined,
                    });
                    return (
                      <label
                        key={group.chatId}
                        className={`schedule-chat-option${group.retained ? ' is-retained' : ''}`}
                        title={displayName ? `${displayName} · ${group.chatId}` : group.chatId}
                      >
                        <input
                          type="checkbox"
                          checked={chatIds.includes(group.chatId)}
                          onChange={event => toggleChat(group.chatId, event.currentTarget.checked)}
                        />
                        <span>
                          <strong>{displayName ?? group.chatId}</strong>
                          {displayName ? <code>{group.chatId}</code> : null}
                          {group.retained ? <small>{tr('schedules.form.chatRetained')}</small> : null}
                        </span>
                      </label>
                    );
                  }) : (
                    <p className="schedule-chat-selector-empty">
                      {selectorOptions.length > 0
                        ? tr('schedules.form.chatNoMatch')
                        : tr('schedules.form.chatEmpty')}
                    </p>
                  )}
                </div>
                <small className="schedule-form-help">
                  {tr('schedules.form.chatSelectedCount', { count: chatIds.length })}
                </small>
                <button
                  type="button"
                  className="schedule-form-link"
                  onClick={() => {
                    setChatManualValue(chatIds.join('\n'));
                    setChatManual(true);
                  }}
                >
                  {tr('schedules.form.chatManual')}
                </button>
              </>
            ) : (
              <>
                <textarea
                  className="schedule-chat-manual-input"
                  value={chatManualValue}
                  onChange={event => {
                    const value = event.currentTarget.value;
                    setChatManualValue(value);
                    updateChatSelection(parseScheduleChatIds(value), false);
                  }}
                  rows={3}
                  placeholder={tr('schedules.form.chatManualPlaceholder')}
                  required
                  aria-invalid={chatMissing || topicChatCountInvalid || undefined}
                />
                <small className="schedule-form-help">{tr('schedules.form.chatManualHelp')}</small>
                {selectorOptions.length > 0 || groups.length > 0 ? (
                  <button
                    type="button"
                    className="schedule-form-link"
                    onClick={() => setChatManual(false)}
                  >
                    {tr('schedules.form.chatBackToSelect')}
                  </button>
                ) : null}
              </>
            )}
            {chatMissing ? (
              <small className="schedule-form-error-inline">{tr('schedules.form.errChatRequired')}</small>
            ) : topicChatCountInvalid ? (
              <small className="schedule-form-error-inline">{tr('schedules.form.errTopicSingleChat')}</small>
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
                  onChange={() => updateExecutionPosition('top-level')}
                />
                {tr('schedules.deliveryTopLevel')}
              </label>
              <label>
                <input
                  type="radio"
                  name="executionPosition"
                  value="topic"
                  checked={executionPosition === 'topic'}
                  onChange={() => updateExecutionPosition('topic')}
                />
                {tr('schedules.deliveryThread')}
              </label>
              <label>
                <input
                  type="radio"
                  name="executionPosition"
                  value="new-topic"
                  checked={executionPosition === 'new-topic'}
                  onChange={() => updateExecutionPosition('new-topic')}
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
    <SchedulePreconditionHelpDialog
      open={open && preconditionHelpSource !== null}
      mode={preconditionMode}
      source={preconditionHelpSource ?? 'inline'}
      workingDir={preconditionWorkingDir}
      tr={tr}
      returnFocusRef={preconditionHelpReturnFocusRef}
      onClose={() => setPreconditionHelpSource(null)}
      onUseSimple={() => {
        setPreconditionScript(PRECONDITION_SCRIPT_EXAMPLE);
        setPreconditionError(null);
      }}
      onUsePrompt={() => {
        setPreconditionScript(PRECONDITION_PROMPT_EXAMPLE);
        setPreconditionError(null);
      }}
    />
    </>
  );
}
