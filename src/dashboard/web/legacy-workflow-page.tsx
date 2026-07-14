import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DropdownMenu, LoadingState } from './dashboard-components.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { WorkflowVersionSwitch } from './workflow-version-switch.js';
import {
  LEGACY_WORKFLOW_DETAIL_POLL_MS,
  LEGACY_WORKFLOW_POLL_MS,
  buildAttemptTimeline,
  buildCardDescriptors,
  cancelLegacyWorkflowRun,
  clamp,
  cliRequiresNativeSessionId,
  computeTerminalSurface,
  danglingSummary,
  endLegacyWorkflowResumeSession,
  eventSeqFromId,
  extractEventContext,
  fetchLegacyWorkflowEvents,
  fetchLegacyWorkflowRuns,
  fetchLegacyWorkflowSnapshot,
  fmtUpdated,
  formatClock,
  isOpenHumanGateAttempt,
  isResumeCapableCli,
  isTerminalWorkflowStatus,
  latestAttempt,
  legacyWorkflowStatusFilters,
  maxConcurrency,
  parseLegacyWorkflowHash,
  previewBody,
  previewMetaParts,
  resolveLegacyWorkflowWait,
  short,
  shortText,
  startLegacyWorkflowResumeSession,
  statusLabel,
  terminalMetaParts,
  terminalOpenInTabLabel,
  terminalSurfaceLabel,
  type ActivityState,
  type AttemptState,
  type AttemptTerminal,
  type BlobPreview,
  type CardDescriptor,
  type EventWindow,
  type ResumeSession,
  type RunRow,
  type RunSnapshot,
  type TerminalSurface,
  type WorkflowEvent,
} from './workflows.js';

type EventState = {
  events: WorkflowEvent[];
  oldestSeq: number | null;
  newestSeq: number | null;
  hasOlder: boolean;
  totalCount: number;
};

type ApprovalStatus = { kind: 'ok' | 'error'; text: string };

type ApprovalState = {
  comments: Map<string, string>;
  statuses: Map<string, ApprovalStatus>;
  resolving: Set<string>;
};

type ResumeState = {
  sessions: Map<string, ResumeSession>;
  pending: Set<string>;
  errors: Map<string, string>;
};

type BlockState = {
  openBlocks: Set<string>;
  scrollTops: Map<string, number>;
  setBlockOpen: (key: string, open: boolean) => void;
  setBlockScrollTop: (key: string, top: number) => void;
};

const EMPTY_EVENT_STATE: EventState = {
  events: [],
  oldestSeq: null,
  newestSeq: null,
  hasOlder: false,
  totalCount: 0,
};

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function statusClassToken(status: string): string {
  return status.replace(/[^A-Za-z0-9_-]/g, '-');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ioBlockKey(keyPrefix: string, label: string): string {
  return `${keyPrefix}:${label}`;
}

function StatusBadge(props: { status: string }): JSX.Element {
  const terminal = isTerminalWorkflowStatus(props.status) ? ' terminal' : ' live';
  return (
    <span className={`wf-status${terminal} wf-status-${statusClassToken(props.status)}`}>
      {statusLabel(props.status)}
    </span>
  );
}

function useLegacyWorkflowRuns(status: string): {
  rows: RunRow[];
  lastErr: string | null;
  lastLoadedAt: Date | null;
} {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [lastErr, setLastErr] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  useEffect(() => {
    let disposed = false;
    let inflight = false;
    let timer: number | null = null;

    async function poll(): Promise<void> {
      if (disposed || inflight || isDocumentHidden()) return;
      inflight = true;
      try {
        const nextRows = await fetchLegacyWorkflowRuns(status);
        if (disposed) return;
        setRows(nextRows);
        setLastErr(null);
        setLastLoadedAt(new Date());
      } catch (err) {
        if (disposed) return;
        setRows([]);
        setLastErr(errMessage(err));
        setLastLoadedAt(new Date());
      } finally {
        inflight = false;
      }
    }

    function scheduleNext(): void {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        await poll();
        if (!disposed) scheduleNext();
      }, LEGACY_WORKFLOW_POLL_MS);
    }

    function onVisibility(): void {
      if (document.hidden) return;
      void poll();
    }

    document.addEventListener('visibilitychange', onVisibility);
    void poll().then(() => {
      if (!disposed) scheduleNext();
    });

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [status]);

  return { rows, lastErr, lastLoadedAt };
}

function LegacyWorkflowListPage(): JSX.Element {
  const tr = useT();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const { rows, lastErr, lastLoadedAt } = useLegacyWorkflowRuns(status);
  const statusFilters = legacyWorkflowStatusFilters();
  const statusFilterLabel = statusFilters.find(option => option.value === status)?.label ?? status;

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      row.runId.toLowerCase().includes(q) ||
      row.workflowId.toLowerCase().includes(q) ||
      (row.chatId ?? '').toLowerCase().includes(q),
    );
  }, [query, rows]);

  const loadText = lastErr
    ? tr('workflow.list.error', { error: lastErr })
    : lastLoadedAt
      ? tr('workflow.list.loaded', { count: rows.length, time: lastLoadedAt.toLocaleTimeString() })
      : '';
  const emptyText = lastErr
    ? tr('workflow.list.failedLoad', { error: lastErr })
    : rows.length === 0
      ? tr('workflow.list.noRuns')
      : tr('workflow.list.noFilterMatch');

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.workflows')}</p>
          <h1>{tr('nav.workflows')}</h1>
        </div>
        <div className="page-heading-actions">
          <WorkflowVersionSwitch active="legacy" />
        </div>
      </div>
      <form className="filters dashboard-toolbar" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          name="q"
          value={query}
          placeholder={tr('workflow.searchPlaceholder')}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <DropdownMenu
          id="legacy-workflow-status"
          className="legacy-workflow-status-menu"
          ariaLabel={tr('workflow.table.status')}
          label={statusFilterLabel}
          value={status}
          options={statusFilters}
          onChange={setStatus}
        />
        <span className={`toolbar-status${lastErr ? ' error' : ''}`}>{loadText}</span>
      </form>
      <div className="workflow-runs-table-wrap">
        <table className="data-table workflow-runs-table">
          <thead>
            <tr>
              <th>{tr('workflow.table.run')}</th>
              <th>{tr('workflow.table.workflow')}</th>
              <th>{tr('workflow.table.status')}</th>
              <th>{tr('workflow.table.lastSeq')}</th>
              <th>{tr('workflow.table.dangling')}</th>
              <th>{tr('workflow.table.updated')}</th>
              <th>{tr('workflow.table.chatApp')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length > 0 ? filteredRows.map((row) => (
              <RunListRow key={row.runId} row={row} />
            )) : (
              <tr><td colSpan={7} className="empty">{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RunListRow(props: { row: RunRow }): JSX.Element {
  const row = props.row;
  const dangling = `${row.dEf}/${row.dAct}/${row.dWait}`;
  const danglingClass = row.dEf + row.dAct + row.dWait > 0 ? 'wf-dangling has' : 'wf-dangling none';
  return (
    <tr data-runid={row.runId}>
      <td>
        <a href={`#/legacy-workflow/${encodeURIComponent(row.runId)}`}><code>{row.runId}</code></a>
      </td>
      <td>{row.workflowId}</td>
      <td>
        <StatusBadge status={row.status} />
        {row.failedNodeId ? <span className="muted"> ({row.failedNodeId})</span> : null}
        <RunErrorSummary row={row} />
      </td>
      <td>{row.lastSeq}</td>
      <td className={danglingClass}>{dangling}</td>
      <td title={new Date(row.updatedAt).toISOString()}>{fmtUpdated(row.updatedAt)}</td>
      <td>
        {row.chatId ? row.chatId : null}
        {row.chatId && row.larkAppId ? <br /> : null}
        {row.larkAppId ? <span className="muted">{row.larkAppId}</span> : null}
        {!row.chatId && !row.larkAppId ? '—' : null}
      </td>
    </tr>
  );
}

function RunErrorSummary(props: { row: RunRow }): JSX.Element | null {
  const { row } = props;
  if (!row.errorCode) return null;
  const message = row.errorMessage ? ` - ${shortText(row.errorMessage, 96)}` : '';
  return (
    <div className="wf-run-error">
      <span className="muted error">{row.errorCode}</span>{message}
    </div>
  );
}

function mergeEventWindow(current: EventState, win: EventWindow, direction: 'reset' | 'append' | 'prepend'): EventState {
  const base = direction === 'reset' ? [] : current.events;
  const eventIds = new Set(base.map((event) => event.eventId));
  const fresh = win.events.filter((event) => {
    if (eventIds.has(event.eventId)) return false;
    eventIds.add(event.eventId);
    return true;
  });
  const events = (direction === 'prepend' ? [...fresh, ...base] : [...base, ...fresh])
    .sort((a, b) => eventSeqFromId(a.eventId) - eventSeqFromId(b.eventId));

  if (direction === 'reset') {
    return {
      events,
      oldestSeq: win.oldestSeq,
      newestSeq: win.newestSeq,
      hasOlder: win.hasOlder,
      totalCount: win.totalCount,
    };
  }
  if (direction === 'prepend') {
    return {
      events,
      oldestSeq: win.oldestSeq ?? current.oldestSeq,
      newestSeq: current.newestSeq,
      hasOlder: win.hasOlder,
      totalCount: win.totalCount,
    };
  }
  return {
    events,
    oldestSeq: current.oldestSeq ?? win.oldestSeq,
    newestSeq: win.newestSeq ?? current.newestSeq,
    hasOlder: current.hasOlder,
    totalCount: win.totalCount,
  };
}

function LegacyWorkflowDetailPage(props: { runId: string; focusAttemptId?: string }): JSX.Element {
  const tr = useT();
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const snapshotRef = useRef<RunSnapshot | null>(null);
  const [eventState, setEventState] = useState<EventState>(EMPTY_EVENT_STATE);
  const eventStateRef = useRef<EventState>(EMPTY_EVENT_STATE);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [cancelStatus, setCancelStatus] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusAttemptId, setFocusAttemptId] = useState(props.focusAttemptId);
  const [approvalComments, setApprovalComments] = useState<Map<string, string>>(() => new Map());
  const [approvalStatuses, setApprovalStatuses] = useState<Map<string, ApprovalStatus>>(() => new Map());
  const [resolvingWaits, setResolvingWaits] = useState<Set<string>>(() => new Set());
  const [resumeSessions, setResumeSessions] = useState<Map<string, ResumeSession>>(() => new Map());
  const [resumePending, setResumePending] = useState<Set<string>>(() => new Set());
  const [resumeErrors, setResumeErrors] = useState<Map<string, string>>(() => new Map());
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(() => new Set());
  const scrollTopsRef = useRef<Map<string, number>>(new Map());
  const disposedRef = useRef(false);
  const inflightRef = useRef(false);

  const applyEventWindow = useCallback((win: EventWindow, direction: 'reset' | 'append' | 'prepend') => {
    const next = mergeEventWindow(eventStateRef.current, win, direction);
    eventStateRef.current = next;
    setEventState(next);
  }, []);

  const setSnapshotBoth = useCallback((next: RunSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const poll = useCallback(async (options: { allowHidden?: boolean } = {}) => {
    if (disposedRef.current || inflightRef.current) return;
    if (!options.allowHidden && isDocumentHidden()) return;
    inflightRef.current = true;
    try {
      const nextSnapshot = await fetchLegacyWorkflowSnapshot(props.runId);
      if (disposedRef.current) return;
      setSnapshotBoth(nextSnapshot);
      const currentEvents = eventStateRef.current;
      if (currentEvents.newestSeq !== null) {
        const win = await fetchLegacyWorkflowEvents(
          props.runId,
          new URLSearchParams({ afterSeq: String(currentEvents.newestSeq), limit: '200' }),
        );
        if (!disposedRef.current) applyEventWindow(win, 'append');
      } else {
        const win = await fetchLegacyWorkflowEvents(props.runId, new URLSearchParams({ tail: '1' }));
        if (!disposedRef.current) applyEventWindow(win, 'reset');
      }
      if (!disposedRef.current) {
        setDetailError(null);
        setLoadingFailed(false);
      }
    } catch (err) {
      if (!disposedRef.current) setDetailError(errMessage(err));
    } finally {
      inflightRef.current = false;
    }
  }, [applyEventWindow, props.runId, setSnapshotBoth]);

  const initialLoad = useCallback(async () => {
    const nextSnapshot = await fetchLegacyWorkflowSnapshot(props.runId);
    if (disposedRef.current) return;
    setSnapshotBoth(nextSnapshot);
    const win = await fetchLegacyWorkflowEvents(props.runId, new URLSearchParams({ tail: '100' }));
    if (disposedRef.current) return;
    applyEventWindow(win, 'reset');
  }, [applyEventWindow, props.runId, setSnapshotBoth]);

  useEffect(() => {
    disposedRef.current = false;
    inflightRef.current = false;
    snapshotRef.current = null;
    eventStateRef.current = EMPTY_EVENT_STATE;
    let timer: number | null = null;

    function scheduleNext(): void {
      if (timer !== null) window.clearTimeout(timer);
      if (snapshotRef.current && isTerminalWorkflowStatus(snapshotRef.current.run.status)) {
        timer = null;
        return;
      }
      timer = window.setTimeout(async () => {
        await poll();
        if (!disposedRef.current) scheduleNext();
      }, LEGACY_WORKFLOW_DETAIL_POLL_MS);
    }

    function onVisibility(): void {
      if (document.hidden) return;
      void poll({ allowHidden: true }).then(() => {
        if (!disposedRef.current && timer === null) scheduleNext();
      });
    }

    document.addEventListener('visibilitychange', onVisibility);
    void initialLoad()
      .then(() => {
        if (disposedRef.current) return;
        setDetailError(null);
        setLoadingFailed(false);
        scheduleNext();
      })
      .catch((err) => {
        if (disposedRef.current) return;
        setDetailError(errMessage(err));
        setLoadingFailed(true);
      });

    return () => {
      disposedRef.current = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [initialLoad, poll]);

  useEffect(() => {
    if (snapshot && isTerminalWorkflowStatus(snapshot.run.status)) setCancelStatus(null);
  }, [snapshot]);

  const loadOlderEvents = useCallback(async () => {
    const current = eventStateRef.current;
    if (current.oldestSeq === null || !current.hasOlder || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const win = await fetchLegacyWorkflowEvents(
        props.runId,
        new URLSearchParams({ beforeSeq: String(current.oldestSeq), limit: '100' }),
      );
      if (!disposedRef.current) {
        applyEventWindow(win, 'prepend');
        setDetailError(null);
      }
    } catch (err) {
      if (!disposedRef.current) setDetailError(errMessage(err));
    } finally {
      if (!disposedRef.current) setLoadingOlder(false);
    }
  }, [applyEventWindow, loadingOlder, props.runId]);

  const cancelRun = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current || isTerminalWorkflowStatus(current.run.status) || canceling) return;
    if (!current.chatBinding?.larkAppId) {
      setDetailError(tr('workflow.detail.cancelUnavailable', { runId: props.runId }));
      return;
    }
    const dangling = danglingSummary(current);
    const message = tr('workflow.detail.cancelConfirm', { runId: props.runId, ...dangling });
    if (!window.confirm(message)) return;
    setCanceling(true);
    try {
      const body = await cancelLegacyWorkflowRun(props.runId);
      setCancelStatus(body.pending ? tr('workflow.detail.cancelPending') : null);
      setDetailError(null);
      await poll({ allowHidden: true });
    } catch (err) {
      setDetailError(errMessage(err));
    } finally {
      setCanceling(false);
    }
  }, [canceling, poll, props.runId, tr]);

  const resolveHumanGate = useCallback(async (attemptId: string, action: 'approve' | 'reject') => {
    if (resolvingWaits.has(attemptId)) return;
    setResolvingWaits((prev) => new Set(prev).add(attemptId));
    setApprovalStatuses((prev) => {
      const next = new Map(prev);
      next.delete(attemptId);
      return next;
    });
    try {
      const comment = approvalComments.get(attemptId)?.trim() || undefined;
      const body = await resolveLegacyWorkflowWait(props.runId, action, comment);
      const label = action === 'approve' ? tr('workflow.detail.approved') : tr('workflow.detail.rejected');
      const text = body.alreadyTerminal
        ? tr('workflow.detail.alreadyTerminal', { label })
        : body.pending
          ? tr('workflow.detail.workflowContinue', { label })
          : tr('workflow.detail.workflowRefreshing', { label });
      setApprovalStatuses((prev) => new Map(prev).set(attemptId, { kind: 'ok', text }));
      setDetailError(null);
      await poll({ allowHidden: true });
    } catch (err) {
      const message = errMessage(err);
      setApprovalStatuses((prev) => new Map(prev).set(attemptId, { kind: 'error', text: message }));
      setDetailError(message);
    } finally {
      setResolvingWaits((prev) => {
        const next = new Set(prev);
        next.delete(attemptId);
        return next;
      });
    }
  }, [approvalComments, poll, props.runId, resolvingWaits, tr]);

  const startResumeSession = useCallback(async (attemptId: string, activityId: string) => {
    if (resumePending.has(attemptId)) return;
    setResumePending((prev) => new Set(prev).add(attemptId));
    setResumeErrors((prev) => {
      const next = new Map(prev);
      next.delete(attemptId);
      return next;
    });
    try {
      const session = await startLegacyWorkflowResumeSession(props.runId, activityId, attemptId);
      setResumeSessions((prev) => new Map(prev).set(attemptId, session));
    } catch (err) {
      setResumeErrors((prev) => new Map(prev).set(attemptId, errMessage(err)));
    } finally {
      setResumePending((prev) => {
        const next = new Set(prev);
        next.delete(attemptId);
        return next;
      });
    }
  }, [props.runId, resumePending]);

  const endResumeSession = useCallback(async (attemptId: string, activityId: string) => {
    if (resumePending.has(attemptId)) return;
    setResumePending((prev) => new Set(prev).add(attemptId));
    setResumeErrors((prev) => {
      const next = new Map(prev);
      next.delete(attemptId);
      return next;
    });
    try {
      await endLegacyWorkflowResumeSession(props.runId, activityId, attemptId);
      setResumeSessions((prev) => {
        const next = new Map(prev);
        next.delete(attemptId);
        return next;
      });
    } catch (err) {
      setResumeErrors((prev) => new Map(prev).set(attemptId, errMessage(err)));
    } finally {
      setResumePending((prev) => {
        const next = new Set(prev);
        next.delete(attemptId);
        return next;
      });
    }
  }, [props.runId, resumePending]);

  const blockState = useMemo<BlockState>(() => ({
    openBlocks,
    scrollTops: scrollTopsRef.current,
    setBlockOpen: (key, open) => {
      setOpenBlocks((prev) => {
        const next = new Set(prev);
        if (open) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    // Ref, not state: scrolling an IO preview shouldn't setState → re-render the whole detail
    // page on every scroll tick. The value is only read imperatively to restore preRef.scrollTop.
    setBlockScrollTop: (key, top) => {
      scrollTopsRef.current.set(key, top);
    },
  }), [openBlocks]);

  const approvalState = useMemo<ApprovalState>(() => ({
    comments: approvalComments,
    statuses: approvalStatuses,
    resolving: resolvingWaits,
  }), [approvalComments, approvalStatuses, resolvingWaits]);
  const resumeState = useMemo<ResumeState>(() => ({
    sessions: resumeSessions,
    pending: resumePending,
    errors: resumeErrors,
  }), [resumeErrors, resumePending, resumeSessions]);

  const run = snapshot?.run;
  const isTerminal = run ? isTerminalWorkflowStatus(run.status) : false;
  const canCancelInDashboard = !!snapshot?.chatBinding?.larkAppId;
  const cancelLabel = canCancelInDashboard ? tr('workflow.detail.cancel') : tr('workflow.detail.cliCancelOnly');
  const cancelTitle = canCancelInDashboard
    ? tr('workflow.detail.cancelTitle')
    : tr('workflow.detail.cliCancelTitle', { runId: props.runId });

  return (
    <>
      <div className="page-heading wf-detail-head">
        <div>
          <p className="eyebrow">{tr('nav.workflows')}</p>
          <h1><code>{props.runId}</code></h1>
          <p className="muted">
            {snapshot ? (
              <>{run?.workflowId ?? '?'} · <StatusBadge status={run?.status ?? 'unknown'} /> · lastSeq {snapshot.lastSeq}</>
            ) : loadingFailed ? tr('workflow.detail.loadFailed') : tr('workflow.detail.loading')}
          </p>
        </div>
        <div className="page-heading-actions">
          <span className="toolbar-status">{snapshot ? tr('workflow.detail.refreshed', { time: new Date().toLocaleTimeString() }) : ''}</span>
          <button
            type="button"
            className="contrast"
            hidden={!snapshot || isTerminal}
            disabled={canceling || !canCancelInDashboard}
            title={cancelTitle}
            onClick={() => void cancelRun()}
          >
            {cancelLabel}
          </button>
          <a className="btn-link" href="#/legacy-workflow">{tr('workflow.detail.back')}</a>
          <WorkflowVersionSwitch active="legacy" />
        </div>
      </div>
      {detailError ? <section className="hint-warn">{detailError}</section> : null}
      {cancelStatus ? <section className="hint-ok">{cancelStatus}</section> : null}
      {!snapshot && !loadingFailed && !detailError ? <LoadingState label={tr('workflow.detail.loading')} /> : null}
      {snapshot ? (
        <>
          <SummaryGrid snapshot={snapshot} />
          <DanglingPanel snapshot={snapshot} />
          <ParallelPanel snapshot={snapshot} events={eventState.events} />
          <NodeActivityPanel snapshot={snapshot} />
          <NodeIOPanel
            runId={props.runId}
            snapshot={snapshot}
            approval={approvalState}
            resume={resumeState}
            blockState={blockState}
            focusAttemptId={focusAttemptId}
            onCommentChange={(attemptId, value) => {
              setApprovalComments((prev) => new Map(prev).set(attemptId, value));
            }}
            onResolve={resolveHumanGate}
            onResumeStart={startResumeSession}
            onResumeEnd={endResumeSession}
            onFocusConsumed={() => setFocusAttemptId(undefined)}
          />
          <TimelinePanel
            events={eventState.events}
            totalCount={eventState.totalCount}
            hasOlder={eventState.hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlderEvents}
          />
        </>
      ) : null}
    </>
  );
}

function SummaryGrid(props: { snapshot: RunSnapshot }): JSX.Element {
  const tr = useT();
  const snap = props.snapshot;
  const run = snap.run;
  const items: Array<{ label: string; value: ReactNode }> = [
    { label: tr('workflow.summary.workflow'), value: run.workflowId ?? '?' },
    { label: tr('workflow.summary.status'), value: <StatusBadge status={run.status} /> },
    { label: tr('workflow.summary.lastSeq'), value: snap.lastSeq },
    { label: tr('workflow.summary.updated'), value: new Date(snap.updatedAt).toLocaleString() },
    { label: tr('workflow.summary.revision'), value: short(run.revisionId) },
    { label: tr('workflow.summary.initiator'), value: run.initiator ?? '-' },
  ];
  if (run.failedNodeId) items.push({ label: tr('workflow.summary.failedNode'), value: run.failedNodeId });
  if (run.cancelOriginEventId) items.push({ label: tr('workflow.summary.cancelOrigin'), value: run.cancelOriginEventId });
  if (snap.chatBinding) {
    items.push({ label: tr('workflow.summary.chat'), value: <code>{snap.chatBinding.chatId}</code> });
    items.push({ label: tr('workflow.summary.app'), value: <code>{snap.chatBinding.larkAppId}</code> });
  }

  return (
    <section className="wf-summary-grid">
      {items.map((item) => (
        <div className="wf-summary-item" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </section>
  );
}

function DanglingPanel(props: { snapshot: RunSnapshot }): JSX.Element {
  const tr = useT();
  const d = props.snapshot.dangling;
  const groups: Array<[string, string[]]> = [
    [tr('workflow.dangling.activities'), d.activities],
    [tr('workflow.dangling.effects'), d.effectAttempted],
    [tr('workflow.dangling.waits'), d.waits],
    [tr('workflow.dangling.cancels'), d.cancels],
  ];
  const total = new Set(groups.flatMap(([, items]) => items)).size;
  return (
    <section className={`wf-panel wf-dangling-panel${total > 0 ? ' has' : ''}`}>
      <div className="wf-panel-title">
        <h3>{tr('workflow.detail.dangling')}</h3>
        {total > 0 ? <span className="wf-dangling has">{total}</span> : null}
      </div>
      {total === 0 ? (
        <div className="muted">{tr('workflow.detail.noDangling')}</div>
      ) : (
        <div className="wf-dangling-grid">
          {groups.map(([label, items]) => (
            <div key={label}>
              <strong>{label}</strong>
              {items.length === 0 ? (
                <div className="muted">{tr('workflow.detail.none')}</div>
              ) : (
                <ul>{items.map((item) => <li key={item}><code>{item}</code></li>)}</ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ParallelPanel(props: { snapshot: RunSnapshot; events: WorkflowEvent[] }): JSX.Element {
  const tr = useT();
  const items = useMemo(
    () => buildAttemptTimeline(props.events, props.snapshot),
    [props.events, props.snapshot],
  );
  const now = Date.now();

  if (items.length === 0) {
    return (
      <section className="wf-panel">
        <div className="wf-panel-title">
          <h3>{tr('workflow.detail.parallel')}</h3>
          <span className="muted" />
        </div>
        <div className="empty">{tr('workflow.detail.noParallelData')}</div>
      </section>
    );
  }

  const start = Math.min(...items.map((item) => item.startedAt));
  const end = Math.max(...items.map((item) => item.endedAt ?? now), start + 1000);
  const duration = Math.max(1, end - start);
  const running = items.filter((item) => !item.endedAt && (item.status === 'running' || item.status === 'effectAttempting')).length;
  const meta = tr('workflow.detail.parallelMeta', {
    count: items.length,
    max: maxConcurrency(items, now),
    running,
  });

  return (
    <section className="wf-panel">
      <div className="wf-panel-title">
        <h3>{tr('workflow.detail.parallel')}</h3>
        <span className="muted">{meta}</span>
      </div>
      <div>
        <div className="wf-parallel-axis">
          <span title={new Date(start).toISOString()}>{formatClock(start)}</span>
          <span title={new Date(end).toISOString()}>{formatClock(end)}</span>
        </div>
        <div className="wf-parallel-list">
          {[...items]
            .sort((a, b) => a.startedAt - b.startedAt || a.activityId.localeCompare(b.activityId))
            .map((item) => (
              <ParallelRow key={item.attemptId} item={item} start={start} duration={duration} now={now} />
            ))}
        </div>
      </div>
    </section>
  );
}

function ParallelRow(props: {
  item: ReturnType<typeof buildAttemptTimeline>[number];
  start: number;
  duration: number;
  now: number;
}): JSX.Element {
  const tr = useT();
  const { item } = props;
  const end = item.endedAt ?? props.now;
  const left = clamp(((item.startedAt - props.start) / props.duration) * 100, 0, 100);
  const width = clamp(((Math.max(end, item.startedAt + 1) - item.startedAt) / props.duration) * 100, 0.7, 100 - left);
  const label = item.nodeId ?? item.activityId;
  const attempt = item.attemptNumber !== undefined ? `#${item.attemptNumber}` : short(item.attemptId);
  const title = [
    `${label} ${item.status}`,
    `${new Date(item.startedAt).toISOString()} -> ${item.endedAt ? new Date(item.endedAt).toISOString() : tr('workflow.detail.parallelNow')}`,
    item.endType ? `end: ${item.endType}` : undefined,
  ].filter(Boolean).join('\n');

  return (
    <div className="wf-parallel-row">
      <div className="wf-parallel-label">
        <code>{label}</code>
        <span className="muted">{item.activityId} · {attempt}</span>
      </div>
      <div className="wf-parallel-track">
        <div
          className={`wf-parallel-bar wf-parallel-${statusClassToken(item.status)}`}
          style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }}
          title={title}
        >
          <span>{statusLabel(item.status)}</span>
        </div>
      </div>
    </div>
  );
}

function NodeActivityPanel(props: { snapshot: RunSnapshot }): JSX.Element {
  const tr = useT();
  const rows = useMemo(() => buildNodeActivityRows(props.snapshot), [props.snapshot]);
  return (
    <section className="wf-panel">
      <div className="wf-panel-title">
        <h3>{tr('workflow.detail.nodes')}</h3>
      </div>
      <div className="wf-table-scroll">
        <table>
          <thead>
            <tr>
              <th>{tr('workflow.detail.node')}</th>
              <th>{tr('workflow.detail.nodeStatus')}</th>
              <th>{tr('workflow.detail.activity')}</th>
              <th>{tr('workflow.detail.activityStatus')}</th>
              <th>{tr('workflow.detail.attempts')}</th>
              <th>{tr('workflow.detail.current')}</th>
              <th>{tr('workflow.detail.detail')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length > 0 ? rows.map((row) => (
              <NodeActivityRow key={`${row.node?.nodeId ?? 'activity'}:${row.activity?.activityId ?? 'idle'}`} {...row} />
            )) : (
              <tr><td colSpan={7} className="empty">{tr('workflow.detail.noNodes')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildNodeActivityRows(snap: RunSnapshot): Array<{
  node?: RunSnapshot['nodes'][number];
  activity?: RunSnapshot['activities'][number];
}> {
  const byId = new Map(snap.activities.map((activity) => [activity.activityId, activity]));
  const used = new Set<string>();
  const rows: Array<{ node?: RunSnapshot['nodes'][number]; activity?: RunSnapshot['activities'][number] }> = [];
  for (const node of snap.nodes) {
    const activity =
      (node.activityId ? byId.get(node.activityId) : undefined) ??
      snap.activities.find((candidate) => candidate.ownerNodeId === node.nodeId);
    if (activity) used.add(activity.activityId);
    rows.push({ node, activity });
  }
  for (const activity of snap.activities) {
    if (!used.has(activity.activityId)) rows.push({ activity });
  }
  return rows;
}

function NodeActivityRow(props: {
  node?: RunSnapshot['nodes'][number];
  activity?: RunSnapshot['activities'][number];
}): JSX.Element {
  const tr = useT();
  const latest = latestAttempt(props.activity);
  return (
    <tr>
      <td>{props.node ? <code>{props.node.nodeId}</code> : <span className="muted">-</span>}</td>
      <td>{props.node ? <StatusBadge status={props.node.status} /> : <span className="muted">-</span>}</td>
      <td>{props.activity ? <code>{props.activity.activityId}</code> : <span className="muted">-</span>}</td>
      <td>{props.activity ? <StatusBadge status={props.activity.status} /> : <span className="muted">-</span>}</td>
      <td>{props.activity?.attempts.length ?? 0}</td>
      <td>{latest ? <code>{latest.attemptId}</code> : <span className="muted">-</span>}</td>
      <td>{latest ? <AttemptDetail attempt={latest} /> : <span className="muted">{tr('workflow.detail.idle')}</span>}</td>
    </tr>
  );
}

function AttemptDetail(props: { attempt: AttemptState }): JSX.Element {
  const tr = useT();
  const parts: ReactNode[] = [];
  const attempt = props.attempt;
  if (attempt.effectAttempted) {
    parts.push(<Fragment key="effect">{tr('workflow.detail.effect')} {attempt.effectAttempted.provider}</Fragment>);
  }
  if (attempt.wait) {
    const resolution = attempt.wait.resolution
      ? `${attempt.wait.resolution.kind}${attempt.wait.resolution.resolution ? ':' + attempt.wait.resolution.resolution : ''}`
      : tr('workflow.detail.open');
    parts.push(<Fragment key="wait">{tr('workflow.detail.wait')} {attempt.wait.waitKind} {resolution}</Fragment>);
    if (attempt.wait.deadlineAt !== undefined) {
      parts.push(<Fragment key="deadline">{tr('workflow.detail.deadline')} {formatClock(attempt.wait.deadlineAt)}</Fragment>);
    }
  }
  if (attempt.error) {
    const tag = `${attempt.error.errorCode}${attempt.error.errorClass ? ` · ${attempt.error.errorClass}` : ''}`;
    parts.push(<span key="error-tag" className="muted error">{tag}</span>);
    if (attempt.error.errorMessage) {
      parts.push(<span key="error-message" className="error wf-error-msg">{attempt.error.errorMessage}</span>);
    }
  }
  if (attempt.output) parts.push(<Fragment key="output">{tr('workflow.detail.output')} {short(attempt.output.outputHash)}</Fragment>);
  if (attempt.runningMs !== undefined) parts.push(<Fragment key="running">{attempt.runningMs}ms</Fragment>);
  if (parts.length === 0) return <span className="muted">-</span>;
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{index > 0 ? <br /> : null}{part}</Fragment>
      ))}
    </>
  );
}

function NodeIOPanel(props: {
  runId: string;
  snapshot: RunSnapshot;
  approval: ApprovalState;
  resume: ResumeState;
  blockState: BlockState;
  focusAttemptId?: string;
  onCommentChange: (attemptId: string, value: string) => void;
  onResolve: (attemptId: string, action: 'approve' | 'reject') => Promise<void>;
  onResumeStart: (attemptId: string, activityId: string) => Promise<void>;
  onResumeEnd: (attemptId: string, activityId: string) => Promise<void>;
  onFocusConsumed: () => void;
}): JSX.Element {
  const tr = useT();
  const descriptors = useMemo(() => buildCardDescriptors(props.snapshot), [props.snapshot]);
  return (
    <section className="wf-panel">
      <div className="wf-panel-title">
        <h3>{tr('workflow.detail.nodeIO')}</h3>
      </div>
      <div className="wf-io-list">
        {descriptors.length > 0 ? descriptors.map((desc) => (
          <AttemptIOCard key={desc.key} desc={desc} {...props} />
        )) : (
          <div className="empty">{tr('workflow.detail.noNodeIO')}</div>
        )}
      </div>
    </section>
  );
}

function AttemptIOCard(props: {
  runId: string;
  desc: CardDescriptor;
  approval: ApprovalState;
  resume: ResumeState;
  blockState: BlockState;
  focusAttemptId?: string;
  onCommentChange: (attemptId: string, value: string) => void;
  onResolve: (attemptId: string, action: 'approve' | 'reject') => Promise<void>;
  onResumeStart: (attemptId: string, activityId: string) => Promise<void>;
  onResumeEnd: (attemptId: string, activityId: string) => Promise<void>;
  onFocusConsumed: () => void;
}): JSX.Element {
  const tr = useT();
  const cardRef = useRef<HTMLElement | null>(null);
  const attempt = latestAttempt(props.desc.activity);
  const title = props.desc.node?.nodeId ?? props.desc.activity?.ownerNodeId ?? props.desc.activity?.activityId ?? 'unknown';
  const keyPrefix = attempt?.attemptId ?? props.desc.activity?.activityId ?? props.desc.node?.nodeId ?? 'unknown';
  const focusMatch = !!attempt && attempt.attemptId === props.focusAttemptId;
  const terminalSurface = computeTerminalSurface({
    runId: props.runId,
    activity: props.desc.activity,
    attempt,
    terminal: props.desc.io?.terminal,
    resumeSession: attempt ? props.resume.sessions.get(attempt.attemptId) : undefined,
  });
  const terminalBlockKey = terminalSurface
    ? ioBlockKey(keyPrefix, terminalSurfaceLabel(terminalSurface.kind))
    : null;

  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!focusMatch) {
      scrolledRef.current = false;
      return;
    }
    // Scroll the focused card into view once as soon as it exists — don't wait for the terminal
    // sidecar (it may arrive a detail-poll later, or never for a terminal-less attempt).
    if (!scrolledRef.current) {
      scrolledRef.current = true;
      cardRef.current?.scrollIntoView({ block: 'center' });
    }
    // Expand the terminal block + consume the deep-link focus once the surface is available.
    if (terminalSurface && terminalBlockKey) {
      props.blockState.setBlockOpen(terminalBlockKey, true);
      props.onFocusConsumed();
    }
  }, [focusMatch, props, terminalBlockKey, terminalSurface]);

  return (
    <article
      ref={cardRef}
      className={`wf-io-card${focusMatch ? ' is-focused' : ''}`}
      data-wf-card-key={props.desc.key}
      data-wf-attempt-card={attempt?.attemptId}
    >
      <div className="wf-io-card-head">
        <header>
          <div>
            <strong><code>{title}</code></strong>
            <span className="muted">
              {props.desc.activity ? props.desc.activity.activityId : tr('workflow.detail.notDispatched')}
            </span>
          </div>
          <div>
            {props.desc.node ? <StatusBadge status={props.desc.node.status} /> : null}
            {props.desc.node && props.desc.activity ? ' ' : null}
            {props.desc.activity ? <StatusBadge status={props.desc.activity.status} /> : null}
          </div>
        </header>
        <div className="wf-io-meta">
          {attempt ? <>{tr('workflow.detail.attempt')} <code>{attempt.attemptId}</code></> : tr('workflow.detail.noAttempt')}
        </div>
        <ApprovalControls
          attempt={attempt}
          approval={props.approval}
          onCommentChange={props.onCommentChange}
          onResolve={props.onResolve}
        />
      </div>
      <div className="wf-io-terminal-slot">
        {terminalSurface && props.desc.io?.terminal ? (
          <TerminalBlock
            runId={props.runId}
            keyPrefix={keyPrefix}
            attempt={attempt}
            activity={props.desc.activity}
            terminal={props.desc.io.terminal}
            surface={terminalSurface}
            resume={props.resume}
            blockState={props.blockState}
            onResumeStart={props.onResumeStart}
            onResumeEnd={props.onResumeEnd}
          />
        ) : null}
      </div>
      <div className="wf-io-grid">
        <PreviewBlock keyPrefix={keyPrefix} label={tr('workflow.detail.authoredInput')} preview={props.desc.io?.input} blockState={props.blockState} />
        <PreviewBlock keyPrefix={keyPrefix} label={tr('workflow.detail.resolvedInput')} preview={props.desc.io?.resolvedInput} blockState={props.blockState} />
        <PreviewBlock keyPrefix={keyPrefix} label={tr('workflow.detail.output')} preview={props.desc.io?.output} blockState={props.blockState} />
        <PreviewBlock keyPrefix={keyPrefix} label={tr('workflow.detail.executionLog')} preview={props.desc.io?.log} blockState={props.blockState} />
        {props.desc.io?.waitPrompt ? (
          <PreviewBlock keyPrefix={keyPrefix} label={tr('workflow.detail.waitPrompt')} preview={props.desc.io.waitPrompt} blockState={props.blockState} />
        ) : null}
      </div>
    </article>
  );
}

function ApprovalControls(props: {
  attempt: AttemptState | undefined;
  approval: ApprovalState;
  onCommentChange: (attemptId: string, value: string) => void;
  onResolve: (attemptId: string, action: 'approve' | 'reject') => Promise<void>;
}): JSX.Element | null {
  const tr = useT();
  const attempt = props.attempt;
  if (!isOpenHumanGateAttempt(attempt)) return null;
  const comment = props.approval.comments.get(attempt.attemptId) ?? '';
  const resolving = props.approval.resolving.has(attempt.attemptId);
  const status = props.approval.statuses.get(attempt.attemptId);
  return (
    <div className="wf-approval-box" data-wf-approval={attempt.attemptId}>
      <label>
        <span>{tr('workflow.detail.approvalComment')}</span>
        <textarea
          className="wf-approval-comment"
          rows={2}
          value={comment}
          placeholder={tr('workflow.detail.optionalComment')}
          disabled={resolving}
          onChange={(event) => props.onCommentChange(attempt.attemptId, event.currentTarget.value)}
        />
      </label>
      <div className="wf-approval-actions">
        <button
          type="button"
          className="primary"
          disabled={resolving}
          onClick={() => void props.onResolve(attempt.attemptId, 'approve')}
        >
          {tr('workflow.detail.approve')}
        </button>
        <button
          type="button"
          disabled={resolving}
          onClick={() => void props.onResolve(attempt.attemptId, 'reject')}
        >
          {tr('workflow.detail.reject')}
        </button>
        {resolving ? <span className="muted">{tr('workflow.detail.submitting')}</span> : null}
      </div>
      {status ? (
        <div className={`${status.kind === 'error' ? 'hint-warn' : 'hint-ok'} wf-approval-status`}>
          {status.text}
        </div>
      ) : null}
    </div>
  );
}

function TerminalBlock(props: {
  runId: string;
  keyPrefix: string;
  attempt: AttemptState | undefined;
  activity: ActivityState | undefined;
  terminal: AttemptTerminal;
  surface: TerminalSurface;
  resume: ResumeState;
  blockState: BlockState;
  onResumeStart: (attemptId: string, activityId: string) => Promise<void>;
  onResumeEnd: (attemptId: string, activityId: string) => Promise<void>;
}): JSX.Element {
  const tr = useT();
  const label = terminalSurfaceLabel(props.surface.kind);
  const key = ioBlockKey(props.keyPrefix, label);
  const open = props.blockState.openBlocks.has(key);
  const meta = terminalMetaParts(props.attempt, props.terminal).join(' · ');
  return (
    <details
      className="wf-io-block wf-terminal-block"
      data-io-key={key}
      open={open}
      onToggle={(event) => props.blockState.setBlockOpen(key, event.currentTarget.open)}
    >
      <summary>{label} <span className="muted">{meta}</span></summary>
      <div className="wf-terminal-actions">
        <a className="btn-link" href={props.surface.url} target="_blank" rel="noreferrer">
          {terminalOpenInTabLabel(props.surface.kind)}
        </a>
        {props.surface.kind === 'replay' || props.surface.kind === 'resume' ? (
          <a className="btn-link" href={props.surface.downloadUrl} download>{tr('workflow.detail.downloadFullLog')}</a>
        ) : null}
        <ResumeAction {...props} />
      </div>
      {props.attempt && props.resume.errors.has(props.attempt.attemptId) ? (
        <div className="hint-warn wf-resume-status">
          {props.resume.errors.get(props.attempt.attemptId)}
        </div>
      ) : null}
      <iframe className="wf-terminal-frame" src={props.surface.url} title={label} loading="lazy" />
    </details>
  );
}

function ResumeAction(props: {
  attempt: AttemptState | undefined;
  activity: ActivityState | undefined;
  terminal: AttemptTerminal;
  surface: TerminalSurface;
  resume: ResumeState;
  onResumeStart: (attemptId: string, activityId: string) => Promise<void>;
  onResumeEnd: (attemptId: string, activityId: string) => Promise<void>;
}): JSX.Element | null {
  const tr = useT();
  const { activity, attempt, surface, terminal } = props;
  if (!attempt || !activity || surface.kind === 'live') return null;
  const pending = props.resume.pending.has(attempt.attemptId);
  if (surface.kind === 'resume') {
    return (
      <button
        type="button"
        className="btn-link"
        disabled={pending}
        onClick={() => void props.onResumeEnd(attempt.attemptId, activity.activityId)}
      >
        {pending ? tr('workflow.detail.resumeEnding') : tr('workflow.detail.endResumeSession')}
      </button>
    );
  }
  if (!isResumeCapableCli(terminal.cliId)) {
    return (
      <button
        type="button"
        className="btn-link"
        disabled
        title={tr('workflow.detail.resumeUnsupportedCli', { cliId: terminal.cliId ?? '?' })}
      >
        {tr('workflow.detail.resumeSession')}
      </button>
    );
  }
  if (cliRequiresNativeSessionId(terminal.cliId) && !terminal.cliSessionId) {
    return (
      <button type="button" className="btn-link" disabled title={tr('workflow.detail.resumeMissingCliSession')}>
        {tr('workflow.detail.resumeSession')}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn-link"
      disabled={pending}
      onClick={() => void props.onResumeStart(attempt.attemptId, activity.activityId)}
    >
      {pending ? tr('workflow.detail.resumeStarting') : tr('workflow.detail.resumeSession')}
    </button>
  );
}

function PreviewBlock(props: {
  keyPrefix: string;
  label: string;
  preview: BlobPreview | undefined;
  blockState: BlockState;
}): JSX.Element {
  const key = ioBlockKey(props.keyPrefix, props.label);
  const open = props.blockState.openBlocks.has(key);
  const meta = previewMetaParts(props.preview).join(' · ');
  return (
    <details
      className="wf-io-block"
      data-io-key={key}
      open={open}
      onToggle={(event) => props.blockState.setBlockOpen(key, event.currentTarget.open)}
    >
      <summary>{props.label} <span className="muted">{meta}</span></summary>
      <PreviewContent preview={props.preview} blockKey={key} blockState={props.blockState} />
    </details>
  );
}

function PreviewContent(props: {
  preview: BlobPreview | undefined;
  blockKey: string;
  blockState: BlockState;
}): JSX.Element {
  const tr = useT();
  const preRef = useRef<HTMLPreElement | null>(null);
  const body = previewBody(props.preview);

  useEffect(() => {
    const top = props.blockState.scrollTops.get(props.blockKey);
    if (top !== undefined && preRef.current) preRef.current.scrollTop = top;
  });

  if (!props.preview) return <div className="muted wf-io-empty">{tr('workflow.detail.noData')}</div>;
  return (
    <>
      {props.preview.error ? <div className="muted error">{props.preview.error}</div> : null}
      {body ? (
        <pre
          ref={preRef}
          className="wf-io-pre"
          onScroll={(event) => props.blockState.setBlockScrollTop(props.blockKey, event.currentTarget.scrollTop)}
        >
          {body}
        </pre>
      ) : (
        <div className="muted wf-io-empty">{tr('workflow.detail.noPreview')}</div>
      )}
    </>
  );
}

function TimelinePanel(props: {
  events: WorkflowEvent[];
  totalCount: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
}): JSX.Element {
  const tr = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTopRef.current;
  }, [props.events]);

  return (
    <section className="wf-panel">
      <div className="wf-panel-title">
        <h3>{tr('workflow.detail.timeline')}</h3>
        <button
          type="button"
          hidden={!props.hasOlder}
          disabled={props.loadingOlder}
          onClick={() => void props.onLoadOlder()}
        >
          {tr('workflow.detail.loadOlder')}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="wf-table-scroll wf-timeline-scroll"
        onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop; }}
      >
        <table>
          <thead>
            <tr>
              <th>{tr('workflow.detail.seq')}</th>
              <th>{tr('workflow.detail.event')}</th>
              <th>{tr('workflow.detail.actor')}</th>
              <th>{tr('workflow.detail.node')}</th>
              <th>{tr('workflow.detail.activity')}</th>
              <th>{tr('workflow.detail.error')}</th>
              <th>{tr('workflow.detail.time')}</th>
            </tr>
          </thead>
          <tbody>
            {props.events.length > 0 ? props.events.map((event) => (
              <EventRow key={event.eventId} event={event} />
            )) : (
              <tr><td colSpan={7} className="empty">{tr('workflow.detail.noEvents')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="muted">{tr('workflow.detail.eventsLoaded', { loaded: props.events.length, total: props.totalCount })}</div>
    </section>
  );
}

function EventRow(props: { event: WorkflowEvent }): JSX.Element {
  const ctx = extractEventContext(props.event.payload);
  return (
    <tr>
      <td>{eventSeqFromId(props.event.eventId)}</td>
      <td><code>{props.event.type}</code></td>
      <td>{props.event.actor}</td>
      <td>{ctx.nodeId ? <code>{ctx.nodeId}</code> : '-'}</td>
      <td>{ctx.activityId ? <code>{ctx.activityId}</code> : '-'}</td>
      <td>{ctx.errorCode ? <span className="muted error">{ctx.errorCode}</span> : '-'}</td>
      <td title={new Date(props.event.timestamp).toISOString()}>{formatClock(props.event.timestamp)}</td>
    </tr>
  );
}

function LegacyWorkflowPage(): JSX.Element {
  useT();
  const route = parseLegacyWorkflowHash(location.hash);
  return (
    <section className="page workflows-page legacy-workflow-page">
      {route.kind === 'detail'
        ? <LegacyWorkflowDetailPage runId={route.runId} focusAttemptId={route.focusAttemptId} />
        : <LegacyWorkflowListPage />}
    </section>
  );
}

export function renderLegacyWorkflowPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <LegacyWorkflowPage />);
}
