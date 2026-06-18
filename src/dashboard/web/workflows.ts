// Dashboard workflow Run List / Detail pages.
//
// Polls /api/workflows/runs every 5s while visible.  Each row links to
// #/workflows/<runId> — the Run Detail page (B path) hooks into the
// same hash route.
import { t } from './ui.js';

type RunRow = {
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
  dEf: number;
  dAct: number;
  dWait: number;
  updatedAt: number;
  failedNodeId?: string;
  errorCode?: string;
  errorClass?: string;
  errorMessage?: string;
  chatId?: string;
  larkAppId?: string;
};

type OutputRef = {
  outputHash: string;
  outputBytes: number;
  outputSchemaVersion: number;
  outputPath?: string;
  contentType?: string;
};

type BlobPreview = {
  outputHash?: string;
  outputBytes?: number;
  contentType?: string;
  truncated?: boolean;
  value?: unknown;
  text?: string;
  error?: string;
};

type AttemptIO = {
  input?: BlobPreview;
  resolvedInput?: BlobPreview;
  output?: BlobPreview;
  log?: BlobPreview;
  terminal?: AttemptTerminal;
  waitPrompt?: BlobPreview;
};

type AttemptTerminal = {
  sessionId: string;
  cliSessionId?: string;
  webPort: number;
  status: 'live' | 'closed';
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  workingDir?: string;
  logPath?: string;
  startedAt: number;
  updatedAt: number;
  closedAt?: number;
  error?: string;
  hasPtyLog?: boolean;
};

type AttemptState = {
  attemptId: string;
  attemptNumber: number;
  status: string;
  effectAttempted?: { provider: string; idempotencyKey: string };
  wait?: {
    waitKind: string;
    prompt?: string;
    promptPreview?: string;
    deadlineAt?: number;
    resolution?: { kind: string; resolution?: string; by?: string; eventId: string };
  };
  output?: OutputRef;
  error?: { errorCode: string; errorClass: string; errorMessage?: string };
  runningMs?: number;
};

type ActivityState = {
  activityId: string;
  attempts: AttemptState[];
  status: string;
  currentAttemptId?: string;
  ownerNodeId?: string;
};

type NodeState = {
  nodeId: string;
  status: string;
  activityId?: string;
  retryCount: number;
  nextAttemptAt?: number;
  errorClass?: string;
};

type RunSnapshot = {
  runId: string;
  run: {
    runId: string;
    status: string;
    workflowId?: string;
    revisionId?: string;
    initiator?: string;
    failedNodeId?: string;
    rootCauseEventId?: string;
    cancelOriginEventId?: string;
  };
  lastSeq: number;
  nodes: NodeState[];
  activities: ActivityState[];
  dangling: {
    activities: string[];
    effectAttempted: string[];
    waits: string[];
    cancels: string[];
  };
  outputs: Record<string, OutputRef>;
  attemptIO?: Record<string, AttemptIO>;
  chatBinding?: { chatId: string; larkAppId: string };
  updatedAt: number;
};

type WorkflowEvent = {
  eventId: string;
  runId: string;
  type: string;
  actor: string;
  timestamp: number;
  payload?: unknown;
};

type EventWindow = {
  events: WorkflowEvent[];
  oldestSeq: number | null;
  newestSeq: number | null;
  totalCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

type CancelRunResponse = {
  ok: boolean;
  error?: string;
  hint?: string;
  status?: string;
  alreadyTerminal?: boolean;
  pending?: boolean;
  lastSeq?: number;
};

type ResolveWaitResponse = {
  ok: boolean;
  error?: string;
  hint?: string;
  message?: string;
  runId?: string;
  resolution?: 'approved' | 'rejected';
  activityId?: string;
  attemptId?: string;
  resolvedAt?: number;
  lastSeq?: number;
  alreadyTerminal?: boolean;
  pending?: boolean;
};

function pageHtml(): string {
  const statusOptions: Array<[string, string]> = [
    ['', t('workflow.filter.nonTerminal')],
    ['all', t('workflow.filter.all')],
    ['pending', statusLabel('pending')],
    ['running', statusLabel('running')],
    ['waiting', statusLabel('waiting')],
    ['succeeded', statusLabel('succeeded')],
    ['failed', statusLabel('failed')],
    ['cancelled', statusLabel('cancelled')],
  ];
  return `
<nav class="wf-subnav">
  <a href="#/workflows" class="active" data-i18n="workflow.subnav.runs">${escapeHtml(t('workflow.subnav.runs'))}</a>
  <a href="#/workflows/catalog" data-i18n="workflow.subnav.catalog">${escapeHtml(t('workflow.subnav.catalog'))}</a>
</nav>
<form id="wf-filters" class="filters">
  <input type="search" name="q" placeholder="${escapeHtml(t('workflow.searchPlaceholder'))}" />
  <select name="status">
    ${statusOptions.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}
  </select>
  <span id="wf-last-load" class="muted"></span>
</form>
<table>
  <thead><tr>
    <th>${escapeHtml(t('workflow.table.run'))}</th><th>${escapeHtml(t('workflow.table.workflow'))}</th><th>${escapeHtml(t('workflow.table.status'))}</th>
    <th>${escapeHtml(t('workflow.table.lastSeq'))}</th><th>${escapeHtml(t('workflow.table.dangling'))}</th><th>${escapeHtml(t('workflow.table.updated'))}</th>
    <th>${escapeHtml(t('workflow.table.chatApp'))}</th>
  </tr></thead>
  <tbody id="wf-tbody"></tbody>
</table>
`;
}

const POLL_MS = 5000;
const DETAIL_POLL_MS = 2000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function fmtUpdated(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return t('time.secondsAgo', { value: Math.max(1, Math.floor(diff / 1000)) });
  if (diff < 3_600_000) return t('time.minutesAgo', { value: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { value: Math.floor(diff / 3_600_000) });
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function statusBadge(status: string): string {
  const cls = TERMINAL.has(status) ? 'wf-status terminal' : 'wf-status live';
  return `<span class="${cls} wf-status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function statusLabel(status: string): string {
  const key = `workflow.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

export function renderWorkflowsPage(root: HTMLElement): () => void {
  const detailMatch = location.hash.match(/^#\/workflows\/([^?#]+)(?:\?([^#]*))?$/);
  if (detailMatch) {
    const params = new URLSearchParams(detailMatch[2] ?? '');
    return renderWorkflowDetailPage(root, decodeURIComponent(detailMatch[1]!), {
      focusAttemptId: params.get('attempt') ?? undefined,
    });
  }
  return renderWorkflowListPage(root);
}

function renderWorkflowListPage(root: HTMLElement): () => void {
  root.innerHTML = pageHtml();
  const tbody = root.querySelector<HTMLElement>('#wf-tbody')!;
  const form = root.querySelector<HTMLFormElement>('#wf-filters')!;
  const lastLoadEl = root.querySelector<HTMLElement>('#wf-last-load')!;

  let cache: RunRow[] = [];
  let timer: number | null = null;
  let inflight = false;
  let lastErr: string | null = null;
  let disposed = false;

  function applyFilters(rows: RunRow[]): RunRow[] {
    const f = new FormData(form);
    const q = ((f.get('q') as string) ?? '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.runId.toLowerCase().includes(q) ||
        r.workflowId.toLowerCase().includes(q) ||
        (r.chatId ?? '').toLowerCase().includes(q),
    );
  }

  function rerender(): void {
    const rows = applyFilters(cache);
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${
        lastErr
          ? escapeHtml(t('workflow.list.failedLoad', { error: lastErr }))
          : cache.length === 0
            ? escapeHtml(t('workflow.list.noRuns'))
            : escapeHtml(t('workflow.list.noFilterMatch'))
      }</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const dangling = `${r.dEf}/${r.dAct}/${r.dWait}`;
        const danglingCls = r.dEf + r.dAct + r.dWait > 0 ? 'wf-dangling has' : 'wf-dangling none';
        const chatBits: string[] = [];
        if (r.chatId) chatBits.push(escapeHtml(r.chatId));
        if (r.larkAppId) chatBits.push(`<span class="muted">${escapeHtml(r.larkAppId)}</span>`);
        const chatCell = chatBits.length > 0 ? chatBits.join('<br/>') : '—';
        const errorSummary = renderRunErrorSummary(r);
        return `<tr data-runid="${escapeHtml(r.runId)}">
          <td><a href="#/workflows/${encodeURIComponent(r.runId)}"><code>${escapeHtml(r.runId)}</code></a></td>
          <td>${escapeHtml(r.workflowId)}</td>
          <td>${statusBadge(r.status)}${
            r.failedNodeId ? ` <span class="muted">(${escapeHtml(r.failedNodeId)})</span>` : ''
          }${errorSummary}</td>
          <td>${r.lastSeq}</td>
          <td class="${danglingCls}">${dangling}</td>
          <td title="${escapeHtml(new Date(r.updatedAt).toISOString())}">${fmtUpdated(r.updatedAt)}</td>
          <td>${chatCell}</td>
        </tr>`;
      })
      .join('');
  }

  function setStatusLine(): void {
    if (lastErr) {
      lastLoadEl.textContent = t('workflow.list.error', { error: lastErr });
      lastLoadEl.classList.add('error');
    } else {
      lastLoadEl.textContent = t('workflow.list.loaded', {
        count: cache.length,
        time: new Date().toLocaleTimeString(),
      });
      lastLoadEl.classList.remove('error');
    }
  }

  async function poll(): Promise<void> {
    if (disposed || inflight) return;
    if (document.hidden) return;
    inflight = true;
    try {
      const status = (form.elements.namedItem('status') as HTMLSelectElement | null)?.value ?? '';
      const params = new URLSearchParams();
      if (status === 'all') params.set('all', '1');
      else if (status) params.set('status', status);
      const url = '/api/workflows/runs' + (params.toString() ? `?${params}` : '');
      const r = await fetch(url);
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        cache = [];
      } else {
        const body = (await r.json()) as { runs: RunRow[] };
        cache = body.runs ?? [];
        lastErr = null;
      }
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      cache = [];
    } finally {
      inflight = false;
      if (!disposed) {
        rerender();
        setStatusLine();
      }
    }
  }

  function scheduleNext(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      await poll();
      if (!disposed) scheduleNext();
    }, POLL_MS);
  }

  function onVisibility(): void {
    if (document.hidden) return;
    void poll();
  }

  form.addEventListener('input', () => {
    rerender();
    // Re-fetch immediately when status filter changes so the server-side
    // filter applies; client-side `q` is row-local and doesn't need network.
  });
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).getAttribute('name') === 'status') {
      void poll();
    }
  });
  document.addEventListener('visibilitychange', onVisibility);

  // initial fetch + loop
  void poll().then(() => {
    if (!disposed) scheduleNext();
  });

  // Cleanup hook — caller can dispose when navigating away.
  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

function renderWorkflowDetailPage(
  root: HTMLElement,
  runId: string,
  opts: { focusAttemptId?: string } = {},
): () => void {
  root.innerHTML = `
    <div class="wf-detail-head">
      <a class="btn-link" href="#/workflows">${escapeHtml(t('workflow.detail.back'))}</a>
      <div>
        <h2><code>${escapeHtml(runId)}</code></h2>
        <div id="wf-detail-subtitle" class="muted">${escapeHtml(t('workflow.detail.loading'))}</div>
      </div>
      <button id="wf-cancel-run" type="button" class="contrast" hidden>${escapeHtml(t('workflow.detail.cancel'))}</button>
      <span id="wf-detail-refresh" class="muted"></span>
    </div>
    <section id="wf-detail-error" class="hint-warn" hidden></section>
    <section id="wf-cancel-status" class="hint-ok" hidden></section>
    <section id="wf-summary" class="wf-summary-grid"></section>
    <section id="wf-dangling-panel"></section>
    <section class="wf-panel">
      <div class="wf-panel-title">
        <h3>${escapeHtml(t('workflow.detail.parallel'))}</h3>
        <span id="wf-parallel-meta" class="muted"></span>
      </div>
      <div id="wf-parallel-view"></div>
    </section>
    <section class="wf-panel">
      <div class="wf-panel-title">
        <h3>${escapeHtml(t('workflow.detail.nodes'))}</h3>
      </div>
      <div class="wf-table-scroll">
        <table>
          <thead><tr>
            <th>${escapeHtml(t('workflow.detail.node'))}</th><th>${escapeHtml(t('workflow.detail.nodeStatus'))}</th><th>${escapeHtml(t('workflow.detail.activity'))}</th><th>${escapeHtml(t('workflow.detail.activityStatus'))}</th>
            <th>${escapeHtml(t('workflow.detail.attempts'))}</th><th>${escapeHtml(t('workflow.detail.current'))}</th><th>${escapeHtml(t('workflow.detail.detail'))}</th>
          </tr></thead>
          <tbody id="wf-node-tbody"></tbody>
        </table>
      </div>
    </section>
    <section class="wf-panel">
      <div class="wf-panel-title">
        <h3>${escapeHtml(t('workflow.detail.nodeIO'))}</h3>
      </div>
      <div id="wf-io-list" class="wf-io-list"></div>
    </section>
    <section class="wf-panel">
      <div class="wf-panel-title">
        <h3>${escapeHtml(t('workflow.detail.timeline'))}</h3>
        <button id="wf-load-older" type="button" hidden>${escapeHtml(t('workflow.detail.loadOlder'))}</button>
      </div>
      <div class="wf-table-scroll wf-timeline-scroll">
        <table>
          <thead><tr>
            <th>${escapeHtml(t('workflow.detail.seq'))}</th><th>${escapeHtml(t('workflow.detail.event'))}</th><th>${escapeHtml(t('workflow.detail.actor'))}</th><th>${escapeHtml(t('workflow.detail.node'))}</th><th>${escapeHtml(t('workflow.detail.activity'))}</th><th>${escapeHtml(t('workflow.detail.error'))}</th><th>${escapeHtml(t('workflow.detail.time'))}</th>
          </tr></thead>
          <tbody id="wf-event-tbody"></tbody>
        </table>
      </div>
      <div id="wf-event-meta" class="muted"></div>
    </section>
  `;

  const subtitle = root.querySelector<HTMLElement>('#wf-detail-subtitle')!;
  const refresh = root.querySelector<HTMLElement>('#wf-detail-refresh')!;
  const errorEl = root.querySelector<HTMLElement>('#wf-detail-error')!;
  const cancelStatusEl = root.querySelector<HTMLElement>('#wf-cancel-status')!;
  const summaryEl = root.querySelector<HTMLElement>('#wf-summary')!;
  const danglingEl = root.querySelector<HTMLElement>('#wf-dangling-panel')!;
  const parallelEl = root.querySelector<HTMLElement>('#wf-parallel-view')!;
  const parallelMeta = root.querySelector<HTMLElement>('#wf-parallel-meta')!;
  const nodeTbody = root.querySelector<HTMLElement>('#wf-node-tbody')!;
  const ioList = root.querySelector<HTMLElement>('#wf-io-list')!;
  const timelineScroll = root.querySelector<HTMLElement>('.wf-timeline-scroll')!;
  const eventTbody = root.querySelector<HTMLElement>('#wf-event-tbody')!;
  const eventMeta = root.querySelector<HTMLElement>('#wf-event-meta')!;
  const cancelBtn = root.querySelector<HTMLButtonElement>('#wf-cancel-run')!;
  const loadOlder = root.querySelector<HTMLButtonElement>('#wf-load-older')!;

  let snapshot: RunSnapshot | null = null;
  let events: WorkflowEvent[] = [];
  let eventIds = new Set<string>();
  let oldestSeq: number | null = null;
  let newestSeq: number | null = null;
  let hasOlder = false;
  let totalCount = 0;
  let timer: number | null = null;
  let disposed = false;
  let inflight = false;
  let canceling = false;
  const openIOBlocks = new Set<string>();
  const ioScrollTops = new Map<string, number>();
  const approvalComments = new Map<string, string>();
  const approvalStatuses = new Map<string, { kind: 'ok' | 'error'; text: string }>();
  const resolvingWaits = new Set<string>();
  const resumeSessions = new Map<string, { resumeId: string; url: string }>();
  const resumePending = new Set<string>();
  const resumeErrors = new Map<string, string>();
  // Per-card surgical update state.  innerHTML-wiping the whole IO
  // list every 2s polls causes terminal iframes inside to be torn off
  // the document — the browser then discards the iframe's browsing
  // context, and the next render reloads its src, which the user sees
  // as flicker.  Instead we keep each <article> stable across polls
  // and only innerHTML-wipe the head/grid sub-containers; the
  // terminal slot (with its iframe) is never detached.  Keyed by
  // activityId or nodeId so retries don't recreate the card.
  const cardElements = new Map<string, CardEntry>();
  let timelineScrollTop = 0;
  let focusAttemptId = opts.focusAttemptId;

  function setError(message: string | null): void {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function setCancelStatus(message: string | null): void {
    if (!message) {
      cancelStatusEl.hidden = true;
      cancelStatusEl.textContent = '';
      return;
    }
    cancelStatusEl.hidden = false;
    cancelStatusEl.textContent = message;
  }

  async function fetchSnapshot(): Promise<void> {
    const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshot`);
    if (res.status === 404) {
      throw new Error(t('workflow.detail.unknownRun'));
    }
    if (!res.ok) throw new Error(t('workflow.detail.snapshotHttp', { status: res.status }));
    snapshot = (await res.json()) as RunSnapshot;
  }

  async function fetchEvents(params: URLSearchParams): Promise<EventWindow> {
    const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/events?${params}`);
    if (res.status === 404) throw new Error(t('workflow.detail.unknownRun'));
    if (!res.ok) throw new Error(t('workflow.detail.eventsHttp', { status: res.status }));
    return (await res.json()) as EventWindow;
  }

  function mergeEvents(incoming: WorkflowEvent[], direction: 'append' | 'prepend'): void {
    const fresh = incoming.filter((ev) => {
      if (eventIds.has(ev.eventId)) return false;
      eventIds.add(ev.eventId);
      return true;
    });
    if (fresh.length === 0) return;
    events = direction === 'prepend' ? [...fresh, ...events] : [...events, ...fresh];
    events.sort((a, b) => eventSeqFromId(a.eventId) - eventSeqFromId(b.eventId));
  }

  async function initialLoad(): Promise<void> {
    await fetchSnapshot();
    const win = await fetchEvents(new URLSearchParams({ tail: '100' }));
    events = [];
    eventIds = new Set();
    mergeEvents(win.events, 'append');
    oldestSeq = win.oldestSeq;
    newestSeq = win.newestSeq;
    hasOlder = win.hasOlder;
    totalCount = win.totalCount;
    rerender();
  }

  async function poll(): Promise<void> {
    if (disposed || inflight || document.hidden) return;
    inflight = true;
    try {
      await fetchSnapshot();
      if (newestSeq !== null) {
        const win = await fetchEvents(new URLSearchParams({ afterSeq: String(newestSeq), limit: '200' }));
        mergeEvents(win.events, 'append');
        if (win.newestSeq !== null) newestSeq = win.newestSeq;
        if (oldestSeq === null && win.oldestSeq !== null) oldestSeq = win.oldestSeq;
        totalCount = win.totalCount;
      } else {
        const win = await fetchEvents(new URLSearchParams({ tail: '1' }));
        mergeEvents(win.events, 'append');
        oldestSeq = win.oldestSeq;
        newestSeq = win.newestSeq;
        hasOlder = win.hasOlder;
        totalCount = win.totalCount;
      }
      setError(null);
      rerender();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      inflight = false;
    }
  }

  async function loadOlderEvents(): Promise<void> {
    if (oldestSeq === null || !hasOlder) return;
    loadOlder.disabled = true;
    try {
      const win = await fetchEvents(new URLSearchParams({ beforeSeq: String(oldestSeq), limit: '100' }));
      mergeEvents(win.events, 'prepend');
      if (win.oldestSeq !== null) oldestSeq = win.oldestSeq;
      hasOlder = win.hasOlder;
      totalCount = win.totalCount;
      setError(null);
      rerender();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      loadOlder.disabled = false;
    }
  }

  async function cancelRun(): Promise<void> {
    if (!snapshot || TERMINAL.has(snapshot.run.status) || canceling) return;
    if (!snapshot.chatBinding?.larkAppId) {
      setError(t('workflow.detail.cancelUnavailable', { runId }));
      return;
    }
    const dangling = danglingSummary(snapshot);
    const message = t('workflow.detail.cancelConfirm', { runId, ...dangling });
    if (!window.confirm(message)) return;
    canceling = true;
    cancelBtn.disabled = true;
    try {
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'cancelled via dashboard' }),
      });
      if (res.status === 401) {
        throw new Error(t('workflow.detail.writeAccessCancel'));
      }
      const body = (await res.json().catch(() => ({}))) as CancelRunResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.hint ?? body.error ?? t('workflow.detail.cancelHttp', { status: res.status }));
      }
      setCancelStatus(body.pending ? t('workflow.detail.cancelPending') : null);
      setError(null);
      await poll();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      canceling = false;
      cancelBtn.disabled = false;
      rerender();
    }
  }

  async function startResumeSession(
    attemptId: string,
    activityId: string,
  ): Promise<void> {
    if (resumePending.has(attemptId)) return;
    resumePending.add(attemptId);
    resumeErrors.delete(attemptId);
    rerender();
    try {
      const res = await fetch(
        `/api/workflows/runs/${encodeURIComponent(runId)}` +
          `/attempts/${encodeURIComponent(activityId)}` +
          `/${encodeURIComponent(attemptId)}/resume`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (res.status === 401) {
        throw new Error(t('workflow.detail.writeAccessResume'));
      }
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        resumeId?: string;
        url?: string;
        error?: string;
        hint?: string;
        message?: string;
      };
      if (!res.ok || !body.ok || !body.resumeId || !body.url) {
        throw new Error(
          body.hint ?? body.message ?? body.error ?? t('workflow.detail.resumeStartFailed', { status: res.status }),
        );
      }
      resumeSessions.set(attemptId, { resumeId: body.resumeId, url: body.url });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      resumeErrors.set(attemptId, message);
    } finally {
      resumePending.delete(attemptId);
      rerender();
    }
  }

  async function endResumeSession(
    attemptId: string,
    activityId: string,
  ): Promise<void> {
    if (resumePending.has(attemptId)) return;
    resumePending.add(attemptId);
    resumeErrors.delete(attemptId);
    rerender();
    try {
      const res = await fetch(
        `/api/workflows/runs/${encodeURIComponent(runId)}` +
          `/attempts/${encodeURIComponent(activityId)}` +
          `/${encodeURIComponent(attemptId)}/resume/end`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'ended_by_dashboard' }),
        },
      );
      if (res.status === 401) {
        throw new Error(t('workflow.detail.writeAccessResume'));
      }
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        hint?: string;
        message?: string;
      };
      if (!res.ok || !body.ok) {
        // `resume_not_running` after a manual server-side end is benign —
        // drop the local session so the iframe reverts to replay.
        if (body.error === 'resume_not_running') {
          resumeSessions.delete(attemptId);
        } else {
          throw new Error(
            body.hint ?? body.message ?? body.error ?? t('workflow.detail.resumeEndFailed', { status: res.status }),
          );
        }
      } else {
        resumeSessions.delete(attemptId);
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      resumeErrors.set(attemptId, message);
    } finally {
      resumePending.delete(attemptId);
      rerender();
    }
  }

  async function resolveHumanGate(
    attemptId: string,
    action: 'approve' | 'reject',
  ): Promise<void> {
    if (resolvingWaits.has(attemptId)) return;
    resolvingWaits.add(attemptId);
    approvalStatuses.delete(attemptId);
    rerender();
    try {
      const comment = approvalComments.get(attemptId)?.trim() || undefined;
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
      if (res.status === 401) {
        throw new Error(t('workflow.detail.writeAccessApproval'));
      }
      const body = (await res.json().catch(() => ({}))) as ResolveWaitResponse;
      if (!res.ok || !body.ok) {
        throw new Error(
          body.hint ?? body.message ?? body.error ?? t('workflow.detail.actionHttp', { action, status: res.status }),
        );
      }
      const label = action === 'approve' ? t('workflow.detail.approved') : t('workflow.detail.rejected');
      approvalStatuses.set(attemptId, {
        kind: 'ok',
        text: body.alreadyTerminal
          ? t('workflow.detail.alreadyTerminal', { label })
          : body.pending
            ? t('workflow.detail.workflowContinue', { label })
            : t('workflow.detail.workflowRefreshing', { label }),
      });
      setError(null);
      await poll();
    } catch (err: any) {
      const message = err?.message ?? String(err);
      approvalStatuses.set(attemptId, { kind: 'error', text: message });
      setError(message);
    } finally {
      resolvingWaits.delete(attemptId);
      rerender();
    }
  }

  function rerender(): void {
    if (!snapshot) return;
    timelineScrollTop = timelineScroll.scrollTop;
    const run = snapshot.run;
    if (TERMINAL.has(run.status)) setCancelStatus(null);
    subtitle.innerHTML = `${escapeHtml(run.workflowId ?? '?')} · ${statusBadge(run.status)} · lastSeq ${snapshot.lastSeq}`;
    refresh.textContent = t('workflow.detail.refreshed', { time: new Date().toLocaleTimeString() });
    cancelBtn.hidden = TERMINAL.has(run.status);
    cancelBtn.disabled = canceling || !snapshot.chatBinding?.larkAppId;
    cancelBtn.textContent = snapshot.chatBinding?.larkAppId
      ? t('workflow.detail.cancel')
      : t('workflow.detail.cliCancelOnly');
    cancelBtn.title = snapshot.chatBinding?.larkAppId
      ? t('workflow.detail.cancelTitle')
      : t('workflow.detail.cliCancelTitle', { runId });
    renderSummary(summaryEl, snapshot);
    renderDangling(danglingEl, snapshot);
    renderParallelTimeline(parallelEl, parallelMeta, snapshot, events);
    renderNodeActivityRows(nodeTbody, snapshot);
    const focusConsumed = renderNodeIO(
      ioList,
      snapshot,
      openIOBlocks,
      ioScrollTops,
      {
        comments: approvalComments,
        statuses: approvalStatuses,
        resolving: resolvingWaits,
        onResolve: resolveHumanGate,
      },
      {
        sessions: resumeSessions,
        pending: resumePending,
        errors: resumeErrors,
        onStart: startResumeSession,
        onEnd: endResumeSession,
      },
      focusAttemptId,
      cardElements,
    );
    if (focusConsumed) focusAttemptId = undefined;
    renderEvents(eventTbody, events);
    timelineScroll.scrollTop = timelineScrollTop;
    loadOlder.hidden = !hasOlder;
    eventMeta.textContent = t('workflow.detail.eventsLoaded', { loaded: events.length, total: totalCount });
  }

  function scheduleNext(): void {
    if (timer !== null) window.clearTimeout(timer);
    if (snapshot && TERMINAL.has(snapshot.run.status)) {
      timer = null;
      return;
    }
    timer = window.setTimeout(async () => {
      await poll();
      if (!disposed) scheduleNext();
    }, DETAIL_POLL_MS);
  }

  function onVisibility(): void {
    if (document.hidden) return;
    void poll().then(() => {
      if (!disposed && timer === null) scheduleNext();
    });
  }

  loadOlder.addEventListener('click', () => void loadOlderEvents());
  cancelBtn.addEventListener('click', () => void cancelRun());
  document.addEventListener('visibilitychange', onVisibility);

  void initialLoad()
    .then(() => {
      setError(null);
      if (!disposed) scheduleNext();
    })
    .catch((err: any) => {
      setError(err?.message ?? String(err));
      subtitle.textContent = t('workflow.detail.loadFailed');
    });

  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

function renderSummary(el: HTMLElement, snap: RunSnapshot): void {
  const r = snap.run;
  const items: Array<[string, string]> = [
    [t('workflow.summary.workflow'), escapeHtml(r.workflowId ?? '?')],
    [t('workflow.summary.status'), statusBadge(r.status)],
    [t('workflow.summary.lastSeq'), String(snap.lastSeq)],
    [t('workflow.summary.updated'), escapeHtml(new Date(snap.updatedAt).toLocaleString())],
    [t('workflow.summary.revision'), escapeHtml(short(r.revisionId))],
    [t('workflow.summary.initiator'), escapeHtml(r.initiator ?? '-')],
  ];
  if (r.failedNodeId) items.push([t('workflow.summary.failedNode'), escapeHtml(r.failedNodeId)]);
  if (r.cancelOriginEventId) items.push([t('workflow.summary.cancelOrigin'), escapeHtml(r.cancelOriginEventId)]);
  if (snap.chatBinding) {
    items.push([t('workflow.summary.chat'), `<code>${escapeHtml(snap.chatBinding.chatId)}</code>`]);
    items.push([t('workflow.summary.app'), `<code>${escapeHtml(snap.chatBinding.larkAppId)}</code>`]);
  }
  el.innerHTML = items
    .map(([label, value]) => `<div class="wf-summary-item"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');
}

function renderRunErrorSummary(run: RunRow): string {
  if (!run.errorCode) return '';
  const message = run.errorMessage ? ` — ${shortText(run.errorMessage, 96)}` : '';
  return `<div class="wf-run-error">
    <span class="muted error">${escapeHtml(run.errorCode)}</span>${escapeHtml(message)}
  </div>`;
}

function danglingSummary(snap: RunSnapshot): {
  total: number;
  effects: number;
  activities: number;
  waits: number;
  cancels: number;
} {
  const d = snap.dangling;
  return {
    total: new Set([
      ...d.activities,
      ...d.effectAttempted,
      ...d.waits,
      ...d.cancels,
    ]).size,
    effects: d.effectAttempted.length,
    activities: d.activities.length,
    waits: d.waits.length,
    cancels: d.cancels.length,
  };
}

function renderDangling(el: HTMLElement, snap: RunSnapshot): void {
  const d = snap.dangling;
  const groups: Array<[string, string[]]> = [
    [t('workflow.dangling.activities'), d.activities],
    [t('workflow.dangling.effects'), d.effectAttempted],
    [t('workflow.dangling.waits'), d.waits],
    [t('workflow.dangling.cancels'), d.cancels],
  ];
  const total = new Set(groups.flatMap(([, xs]) => xs)).size;
  el.className = total > 0 ? 'wf-panel wf-dangling-panel has' : 'wf-panel wf-dangling-panel';
  if (total === 0) {
    el.innerHTML = `<div class="wf-panel-title"><h3>${escapeHtml(t('workflow.detail.dangling'))}</h3></div><div class="muted">${escapeHtml(t('workflow.detail.noDangling'))}</div>`;
    return;
  }
  el.innerHTML = `<div class="wf-panel-title"><h3>${escapeHtml(t('workflow.detail.dangling'))}</h3><span class="wf-dangling has">${total}</span></div>
    <div class="wf-dangling-grid">
      ${groups
        .map(
          ([name, xs]) => `<div><strong>${name}</strong>${
            xs.length === 0
              ? `<div class="muted">${escapeHtml(t('workflow.detail.none'))}</div>`
              : `<ul>${xs.map((x) => `<li><code>${escapeHtml(x)}</code></li>`).join('')}</ul>`
          }</div>`,
        )
        .join('')}
    </div>`;
}

type AttemptTimelineItem = {
  nodeId?: string;
  activityId: string;
  attemptId: string;
  attemptNumber?: number;
  status: string;
  startedAt: number;
  runningAt?: number;
  endedAt?: number;
  endType?: string;
};

function renderParallelTimeline(
  el: HTMLElement,
  metaEl: HTMLElement,
  snap: RunSnapshot,
  events: WorkflowEvent[],
): void {
  const items = buildAttemptTimeline(events, snap);
  if (items.length === 0) {
    metaEl.textContent = '';
    el.innerHTML = `<div class="empty">${escapeHtml(t('workflow.detail.noParallelData'))}</div>`;
    return;
  }

  const now = Date.now();
  const start = Math.min(...items.map((item) => item.startedAt));
  const end = Math.max(...items.map((item) => item.endedAt ?? now), start + 1000);
  const duration = Math.max(1, end - start);
  const maxParallel = maxConcurrency(items, now);
  const running = items.filter((item) => !item.endedAt && (item.status === 'running' || item.status === 'effectAttempting')).length;
  metaEl.textContent = t('workflow.detail.parallelMeta', {
    count: items.length,
    max: maxParallel,
    running,
  });

  const rows = items
    .sort((a, b) => a.startedAt - b.startedAt || a.activityId.localeCompare(b.activityId))
    .map((item) => renderParallelRow(item, start, duration, now))
    .join('');

  el.innerHTML = `<div class="wf-parallel-axis">
      <span title="${escapeHtml(new Date(start).toISOString())}">${escapeHtml(formatClock(start))}</span>
      <span title="${escapeHtml(new Date(end).toISOString())}">${escapeHtml(formatClock(end))}</span>
    </div>
    <div class="wf-parallel-list">${rows}</div>`;
}

function buildAttemptTimeline(events: WorkflowEvent[], snap: RunSnapshot): AttemptTimelineItem[] {
  const byAttempt = new Map<string, AttemptTimelineItem>();
  const activityOwner = new Map(snap.activities.map((activity) => [activity.activityId, activity.ownerNodeId]));

  for (const event of [...events].sort((a, b) => eventSeqFromId(a.eventId) - eventSeqFromId(b.eventId))) {
    const payload = payloadRecord(event);
    if (!payload) continue;
    const activityId = typeof payload.activityId === 'string' ? payload.activityId : undefined;
    const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : undefined;
    if (!activityId || !attemptId) continue;

    let item = byAttempt.get(attemptId);
    if (event.type === 'attemptCreated') {
      const attemptNumber = typeof payload.attemptNumber === 'number' ? payload.attemptNumber : undefined;
      const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : activityOwner.get(activityId);
      item = {
        nodeId,
        activityId,
        attemptId,
        attemptNumber,
        status: 'pending',
        startedAt: event.timestamp,
      };
      byAttempt.set(attemptId, item);
      continue;
    }
    if (!item) {
      item = {
        nodeId: activityOwner.get(activityId),
        activityId,
        attemptId,
        status: 'pending',
        startedAt: event.timestamp,
      };
      byAttempt.set(attemptId, item);
    }

    if (event.type === 'activityRunning') {
      item.status = 'running';
      item.runningAt = event.timestamp;
    } else if (event.type === 'effectAttempted') {
      item.status = 'effectAttempting';
    } else if (event.type === 'activityWaiting' || event.type === 'waitCreated') {
      item.status = 'waiting';
    } else if (isTerminalActivityEvent(event.type)) {
      item.status = terminalStatusForEvent(event.type);
      item.endedAt = event.timestamp;
      item.endType = event.type;
    }
  }

  return [...byAttempt.values()];
}

function renderParallelRow(item: AttemptTimelineItem, start: number, duration: number, now: number): string {
  const end = item.endedAt ?? now;
  const left = clamp(((item.startedAt - start) / duration) * 100, 0, 100);
  const width = clamp(((Math.max(end, item.startedAt + 1) - item.startedAt) / duration) * 100, 0.7, 100 - left);
  const label = item.nodeId ?? item.activityId;
  const attempt = item.attemptNumber !== undefined ? `#${item.attemptNumber}` : short(item.attemptId);
  const title = [
    `${label} ${item.status}`,
    `${new Date(item.startedAt).toISOString()} → ${item.endedAt ? new Date(item.endedAt).toISOString() : t('workflow.detail.parallelNow')}`,
    item.endType ? `end: ${item.endType}` : undefined,
  ].filter(Boolean).join('\n');
  return `<div class="wf-parallel-row">
    <div class="wf-parallel-label">
      <code>${escapeHtml(label)}</code>
      <span class="muted">${escapeHtml(item.activityId)} · ${escapeHtml(attempt)}</span>
    </div>
    <div class="wf-parallel-track">
      <div class="wf-parallel-bar wf-parallel-${escapeHtml(item.status)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;" title="${escapeHtml(title)}">
        <span>${escapeHtml(statusLabel(item.status))}</span>
      </div>
    </div>
  </div>`;
}

function maxConcurrency(items: AttemptTimelineItem[], now: number): number {
  const points: Array<{ time: number; delta: number }> = [];
  for (const item of items) {
    points.push({ time: item.startedAt, delta: 1 });
    points.push({ time: item.endedAt ?? now, delta: -1 });
  }
  points.sort((a, b) => a.time - b.time || b.delta - a.delta);
  let current = 0;
  let max = 0;
  for (const point of points) {
    current += point.delta;
    max = Math.max(max, current);
  }
  return max;
}

function isTerminalActivityEvent(type: string): boolean {
  return type === 'activitySucceeded' ||
    type === 'activityFailed' ||
    type === 'activityTimedOut' ||
    type === 'activityCanceled';
}

function terminalStatusForEvent(type: string): string {
  if (type === 'activitySucceeded') return 'succeeded';
  if (type === 'activityCanceled') return 'cancelled';
  if (type === 'activityTimedOut') return 'timedOut';
  return 'failed';
}

function renderNodeActivityRows(tbody: HTMLElement, snap: RunSnapshot): void {
  const byId = new Map(snap.activities.map((a) => [a.activityId, a]));
  const used = new Set<string>();
  const rows: string[] = [];

  for (const node of snap.nodes) {
    const activity =
      (node.activityId ? byId.get(node.activityId) : undefined) ??
      snap.activities.find((a) => a.ownerNodeId === node.nodeId);
    if (activity) used.add(activity.activityId);
    rows.push(renderNodeActivityRow(node, activity));
  }

  for (const activity of snap.activities) {
    if (used.has(activity.activityId)) continue;
    rows.push(renderNodeActivityRow(undefined, activity));
  }

  tbody.innerHTML = rows.length > 0
    ? rows.join('')
    : `<tr><td colspan="7" class="empty">${escapeHtml(t('workflow.detail.noNodes'))}</td></tr>`;
}

function renderNodeActivityRow(node?: NodeState, activity?: ActivityState): string {
  const latest = activity?.attempts[activity.attempts.length - 1];
  return `<tr>
    <td>${node ? `<code>${escapeHtml(node.nodeId)}</code>` : '<span class="muted">-</span>'}</td>
    <td>${node ? statusBadge(node.status) : '<span class="muted">-</span>'}</td>
    <td>${activity ? `<code>${escapeHtml(activity.activityId)}</code>` : '<span class="muted">-</span>'}</td>
    <td>${activity ? statusBadge(activity.status) : '<span class="muted">-</span>'}</td>
    <td>${activity?.attempts.length ?? 0}</td>
    <td>${latest ? `<code>${escapeHtml(latest.attemptId)}</code>` : '<span class="muted">-</span>'}</td>
    <td>${latest ? renderAttemptDetail(latest) : `<span class="muted">${escapeHtml(t('workflow.detail.idle'))}</span>`}</td>
  </tr>`;
}

type CardEntry = {
  article: HTMLElement;
  head: HTMLElement;
  terminalSlot: HTMLElement;
  grid: HTMLElement;
  currentTerminalUrl: string | null;
};

function renderNodeIO(
  el: HTMLElement,
  snap: RunSnapshot,
  openBlocks: Set<string>,
  scrollTops: Map<string, number>,
  approval: ApprovalRenderState,
  resume: ResumeRenderState,
  focusAttemptId?: string,
  cardElements?: Map<string, CardEntry>,
): boolean {
  syncIOBlockState(el, openBlocks, scrollTops);
  syncApprovalComments(el, approval.comments);
  const focusHasTerminal = !!(focusAttemptId && snap.attemptIO?.[focusAttemptId]?.terminal);
  if (focusHasTerminal && focusAttemptId) {
    openBlocks.add(ioBlockKey(focusAttemptId, t('workflow.detail.liveTerminal')));
  }
  // Per-card surgical update — we never `innerHTML=`-wipe the parent
  // `el` because doing so detaches every terminal iframe from the
  // document, which in all major browsers discards the iframe's
  // browsing context (the WebSocket included) and the next paint
  // reloads the iframe → terminal flickers.  Instead we keep each
  // <article> stable across polls and only innerHTML-wipe the
  // per-card head/grid sub-containers; the terminal-slot div (whose
  // iframe holds the live WebSocket) is never detached.
  const descriptors = buildCardDescriptors(snap);
  const seenKeys = new Set<string>();
  if (cardElements) {
    for (const desc of descriptors) {
      seenKeys.add(desc.key);
      let entry = cardElements.get(desc.key);
      if (!entry) {
        entry = createCardEntry(desc.key);
        cardElements.set(desc.key, entry);
        el.appendChild(entry.article);
      }
      updateCardEntry(entry, desc, openBlocks, approval, resume, focusAttemptId);
    }
    for (const [key, entry] of Array.from(cardElements)) {
      if (seenKeys.has(key)) continue;
      entry.article.remove();
      cardElements.delete(key);
    }
    if (descriptors.length === 0) {
      // Empty-state placeholder.  Use a sentinel child rather than
      // wiping innerHTML so any (hypothetically lingering) terminal
      // iframe wouldn't be detached.  Cards are already cleared via
      // the loop above, so it's safe to add the placeholder here.
      if (!el.querySelector('.wf-io-empty-placeholder')) {
        const empty = document.createElement('div');
        empty.className = 'empty wf-io-empty-placeholder';
        empty.textContent = t('workflow.detail.noNodeIO');
        el.appendChild(empty);
      }
    } else {
      el.querySelector('.wf-io-empty-placeholder')?.remove();
    }
  } else {
    // No cache provided (unit tests etc.): fall back to bulk innerHTML.
    const cards: string[] = [];
    for (const desc of descriptors) {
      cards.push(renderIOCardHtml(desc, openBlocks, approval, resume, focusAttemptId));
    }
    el.innerHTML = cards.length > 0
      ? cards.join('')
      : `<div class="empty">${escapeHtml(t('workflow.detail.noNodeIO'))}</div>`;
  }
  restoreIOBlockScroll(el, scrollTops);
  const focusVisible = scrollFocusedAttemptIntoView(el, focusAttemptId);
  attachIOBlockToggleTracking(el, openBlocks);
  attachIOBlockScrollTracking(el, scrollTops);
  attachApprovalControls(el, approval);
  attachResumeControls(el, resume);
  // Keep the deeplink focus active until terminal.json is visible.  The
  // progress card link can appear at activityRunning, a little before the
  // worker emits ready and writes the terminal sidecar; a later poll should
  // still auto-open the terminal block when it arrives.
  return focusVisible && focusHasTerminal;
}

type CardDescriptor = {
  key: string;
  node?: NodeState;
  activity?: ActivityState;
  io?: AttemptIO;
};

function buildCardDescriptors(snap: RunSnapshot): CardDescriptor[] {
  const byId = new Map(snap.activities.map((a) => [a.activityId, a]));
  const used = new Set<string>();
  const out: CardDescriptor[] = [];
  for (const node of snap.nodes) {
    const activity =
      (node.activityId ? byId.get(node.activityId) : undefined) ??
      snap.activities.find((a) => a.ownerNodeId === node.nodeId);
    if (!activity) {
      out.push({ key: `node:${node.nodeId}`, node });
      continue;
    }
    used.add(activity.activityId);
    out.push({
      key: `activity:${activity.activityId}`,
      node,
      activity,
      io: snap.attemptIO?.[latestAttempt(activity)?.attemptId ?? ''],
    });
  }
  for (const activity of snap.activities) {
    if (used.has(activity.activityId)) continue;
    out.push({
      key: `activity:${activity.activityId}`,
      activity,
      io: snap.attemptIO?.[latestAttempt(activity)?.attemptId ?? ''],
    });
  }
  return out;
}

function createCardEntry(key: string): CardEntry {
  const article = document.createElement('article');
  article.className = 'wf-io-card';
  article.dataset.wfCardKey = key;
  const head = document.createElement('div');
  head.className = 'wf-io-card-head';
  const terminalSlot = document.createElement('div');
  terminalSlot.className = 'wf-io-terminal-slot';
  const grid = document.createElement('div');
  grid.className = 'wf-io-grid';
  article.appendChild(head);
  article.appendChild(terminalSlot);
  article.appendChild(grid);
  return { article, head, terminalSlot, grid, currentTerminalUrl: null };
}

function updateCardEntry(
  entry: CardEntry,
  desc: CardDescriptor,
  openBlocks: Set<string>,
  approval: ApprovalRenderState,
  resume: ResumeRenderState,
  focusAttemptId: string | undefined,
): void {
  const attempt = latestAttempt(desc.activity);
  const title = desc.node?.nodeId ?? desc.activity?.ownerNodeId ?? desc.activity?.activityId ?? 'unknown';
  const focusMatch = !!(attempt && attempt.attemptId === focusAttemptId);
  entry.article.classList.toggle('is-focused', focusMatch);
  if (attempt) {
    entry.article.dataset.wfAttemptCard = attempt.attemptId;
  } else {
    delete entry.article.dataset.wfAttemptCard;
  }
  // Head: header (title + status badges) + meta (attemptId) + approval controls.
  // These all re-render every poll; no live state survives in them.
  const controls = renderApprovalControls(attempt, approval);
  entry.head.innerHTML = `
    <header>
      <div>
        <strong><code>${escapeHtml(title)}</code></strong>
        <span class="muted">${desc.activity ? escapeHtml(desc.activity.activityId) : escapeHtml(t('workflow.detail.notDispatched'))}</span>
      </div>
      <div>${desc.node ? statusBadge(desc.node.status) : ''} ${desc.activity ? statusBadge(desc.activity.status) : ''}</div>
    </header>
    <div class="wf-io-meta">
      ${attempt ? `${escapeHtml(t('workflow.detail.attempt'))} <code>${escapeHtml(attempt.attemptId)}</code>` : escapeHtml(t('workflow.detail.noAttempt'))}
    </div>
    ${controls}
  `;
  // Terminal slot: only re-render when the URL changes (worker
  // restart / attempt-id flip / live → replay handoff / resume start
  // or end).  The iframe DOM node stays live through every same-URL
  // poll so its WebSocket (live / resume) / streaming xterm parser
  // (replay) isn't torn down.
  const desiredSurface = computeTerminalUrl(attempt, desc.activity, desc.io?.terminal, resume);
  const desiredUrl = desiredSurface?.url ?? null;
  if (desiredUrl !== entry.currentTerminalUrl) {
    if (desiredSurface === null) {
      entry.terminalSlot.innerHTML = '';
    } else {
      entry.terminalSlot.innerHTML = renderTerminalBlockHtml(
        desc.key,
        attempt,
        desc.activity,
        desc.io?.terminal,
        desiredSurface,
        openBlocks,
        resume,
      );
    }
    entry.currentTerminalUrl = desiredUrl;
  } else if (desiredSurface !== null && desc.io?.terminal) {
    // Same URL — refresh only the summary meta (status badge text)
    // and resume action button state (pending / error) inline.  The
    // iframe itself is left alone to preserve its browsing context.
    const summary = entry.terminalSlot.querySelector<HTMLElement>('details.wf-terminal-block > summary');
    if (summary) {
      const label = terminalSurfaceLabel(desiredSurface.kind);
      summary.innerHTML = `${escapeHtml(label)} ${terminalMeta(attempt, desc.io.terminal)}`;
    }
    if (attempt) {
      refreshResumeActions(entry.terminalSlot, attempt, desc.activity, desc.io.terminal, desiredSurface, resume);
    }
  }
  // Grid: previews other than terminal.  Wipe + rebuild — no live
  // resources here so flicker doesn't matter.
  const keyPrefix = attempt?.attemptId ?? desc.activity?.activityId ?? desc.node?.nodeId ?? 'unknown';
  entry.grid.innerHTML = `
    ${renderPreviewBlock(keyPrefix, t('workflow.detail.authoredInput'), desc.io?.input, openBlocks)}
    ${renderPreviewBlock(keyPrefix, t('workflow.detail.resolvedInput'), desc.io?.resolvedInput, openBlocks)}
    ${renderPreviewBlock(keyPrefix, t('workflow.detail.output'), desc.io?.output, openBlocks)}
    ${renderPreviewBlock(keyPrefix, t('workflow.detail.executionLog'), desc.io?.log, openBlocks)}
    ${desc.io?.waitPrompt ? renderPreviewBlock(keyPrefix, t('workflow.detail.waitPrompt'), desc.io.waitPrompt, openBlocks) : ''}
  `;
}

type TerminalSurface =
  | { kind: 'live'; url: string }
  | { kind: 'replay'; url: string; downloadUrl: string }
  | { kind: 'resume'; url: string; resumeId: string; downloadUrl: string };

function computeTerminalUrl(
  attempt: AttemptState | undefined,
  activity: ActivityState | undefined,
  terminal: AttemptTerminal | undefined,
  resume?: ResumeRenderState,
): TerminalSurface | null {
  if (!terminal) return null;
  if (terminal.error) return null;
  if (isLiveTerminal(attempt, terminal)) {
    return { kind: 'live', url: terminalReadOnlyUrl(terminal) };
  }
  if (!attempt || !activity) return null;
  if (!isReplayableTerminal(attempt, terminal)) return null;
  const runId = currentRunIdFromHash();
  if (!runId) return null;
  // Active resume session for this attempt swaps the iframe to the
  // resume worker's write-token PTY URL — keep the download link
  // pointing at the original terminal.log so users can still grab the
  // pre-resume transcript.
  const active = resume?.sessions.get(attempt.attemptId);
  if (active) {
    return {
      kind: 'resume',
      url: active.url,
      resumeId: active.resumeId,
      downloadUrl: terminalLogDownloadUrl(runId, activity.activityId, attempt.attemptId),
    };
  }
  return {
    kind: 'replay',
    url: terminalReplayPageUrl(runId, activity.activityId, attempt.attemptId, !!terminal.hasPtyLog),
    downloadUrl: terminalLogDownloadUrl(runId, activity.activityId, attempt.attemptId),
  };
}

function renderTerminalBlockHtml(
  keyPrefix: string,
  attempt: AttemptState | undefined,
  activity: ActivityState | undefined,
  terminal: AttemptTerminal | undefined,
  surface: TerminalSurface,
  openBlocks: Set<string>,
  resume?: ResumeRenderState,
): string {
  if (!terminal) return '';
  const label = terminalSurfaceLabel(surface.kind);
  const key = ioBlockKey(keyPrefix, label);
  const meta = terminalMeta(attempt, terminal);
  const openInTabLabel = terminalOpenInTabLabel(surface.kind);
  const downloadAction = (surface.kind === 'replay' || surface.kind === 'resume')
    ? `<a class="btn-link" href="${escapeHtml(surface.downloadUrl)}" download>${escapeHtml(t('workflow.detail.downloadFullLog'))}</a>`
    : '';
  const resumeAction = attempt
    ? renderResumeButtonHtml(attempt, activity, terminal, surface, resume)
    : '';
  const resumeStatus = attempt ? renderResumeStatusHtml(attempt.attemptId, resume) : '';
  return `<details class="wf-io-block wf-terminal-block" data-io-key="${escapeHtml(key)}"${openBlocks.has(key) ? ' open' : ''}>
    <summary>${escapeHtml(label)} ${meta}</summary>
    <div class="wf-terminal-actions">
      <a class="btn-link" href="${escapeHtml(surface.url)}" target="_blank" rel="noreferrer">${escapeHtml(openInTabLabel)}</a>
      ${downloadAction}
      ${resumeAction}
    </div>
    ${resumeStatus}
    <iframe class="wf-terminal-frame" src="${escapeHtml(surface.url)}" title="${escapeHtml(label)}" loading="lazy"></iframe>
  </details>`;
}

function terminalSurfaceLabel(kind: TerminalSurface['kind']): string {
  if (kind === 'live') return t('workflow.detail.liveTerminal');
  if (kind === 'resume') return t('workflow.detail.terminalResume');
  return t('workflow.detail.terminalReplay');
}

function terminalOpenInTabLabel(kind: TerminalSurface['kind']): string {
  if (kind === 'live') return t('workflow.detail.openTerminalNewTab');
  if (kind === 'resume') return t('workflow.detail.openResumeNewTab');
  return t('workflow.detail.openReplayNewTab');
}

/**
 * CLI capability split — mirrors `src/workflows/attempt-resume.ts`:
 *  - REQUIRES native cliSessionId: adapter has no botmux-sessionId fallback,
 *    so resume can't proceed unless `cli_session_id` IPC was captured.
 *  - USES botmux sessionId: adapter resumes by the original attempt sessionId
 *    (now passed through as `originalSessionId` in worker init by codex's
 *    server-side fix).  cliSessionId is consumed when present but optional.
 *  - Anything else (opencode / gemini / ...) is `resume_unsupported_cli`
 *    server-side.
 */
const RESUME_REQUIRES_CLI_SESSION_ID = new Set<string>(['antigravity', 'codex-app', 'cursor', 'mira']);
const RESUME_USES_SESSION_ID = new Set<string>(['aiden', 'coco', 'claude-code', 'seed', 'relay', 'codex', 'mtr', 'hermes', 'pi', 'mir']);
function isResumeCapableCli(cliId: string | undefined): boolean {
  return !!cliId && (RESUME_USES_SESSION_ID.has(cliId) || RESUME_REQUIRES_CLI_SESSION_ID.has(cliId));
}
function cliRequiresNativeSessionId(cliId: string | undefined): boolean {
  return !!cliId && RESUME_REQUIRES_CLI_SESSION_ID.has(cliId);
}

function renderResumeButtonHtml(
  attempt: AttemptState,
  activity: ActivityState | undefined,
  terminal: AttemptTerminal,
  surface: TerminalSurface,
  resume: ResumeRenderState | undefined,
): string {
  if (!resume) return '';
  if (surface.kind === 'live') return '';
  if (!activity) return '';
  const active = surface.kind === 'resume';
  const pending = resume.pending.has(attempt.attemptId);
  const dataAttrs =
    `data-wf-resume-attempt="${escapeHtml(attempt.attemptId)}" ` +
    `data-wf-resume-activity="${escapeHtml(activity.activityId)}"`;
  // data-wf-resume-button is the stable marker used by refreshResumeActions
  // to locate any prior resume button in-place — including disabled variants
  // that don't carry attempt/activity ids — so re-renders replace instead of
  // appending and creating duplicates each poll.
  if (active) {
    return `<button type="button" class="btn-link" data-wf-resume-button="1" data-wf-resume-action="end" ${dataAttrs}${pending ? ' disabled' : ''}>${escapeHtml(pending ? t('workflow.detail.resumeEnding') : t('workflow.detail.endResumeSession'))}</button>`;
  }
  if (!isResumeCapableCli(terminal.cliId)) {
    return `<button type="button" class="btn-link" data-wf-resume-button="1" disabled title="${escapeHtml(t('workflow.detail.resumeUnsupportedCli', { cliId: terminal.cliId ?? '?' }))}">${escapeHtml(t('workflow.detail.resumeSession'))}</button>`;
  }
  // Only CLIs that have NO botmux-sessionId fallback (antigravity, cursor)
  // hard-require cliSessionId — aiden / coco / claude-code / codex / mtr / hermes resume
  // through the original attempt sessionId on the server side now.
  if (cliRequiresNativeSessionId(terminal.cliId) && !terminal.cliSessionId) {
    return `<button type="button" class="btn-link" data-wf-resume-button="1" disabled title="${escapeHtml(t('workflow.detail.resumeMissingCliSession'))}">${escapeHtml(t('workflow.detail.resumeSession'))}</button>`;
  }
  return `<button type="button" class="btn-link" data-wf-resume-button="1" data-wf-resume-action="start" ${dataAttrs}${pending ? ' disabled' : ''}>${escapeHtml(pending ? t('workflow.detail.resumeStarting') : t('workflow.detail.resumeSession'))}</button>`;
}

function renderResumeStatusHtml(
  attemptId: string,
  resume: ResumeRenderState | undefined,
): string {
  if (!resume) return '';
  const err = resume.errors.get(attemptId);
  if (err) {
    return `<div class="hint-warn wf-resume-status" data-wf-resume-status="${escapeHtml(attemptId)}">${escapeHtml(err)}</div>`;
  }
  return '';
}

/**
 * Legacy bulk renderer kept for the no-cache fallback path (tests).
 * The live dashboard always goes through the surgical update path.
 */
function renderIOCardHtml(
  desc: CardDescriptor,
  openBlocks: Set<string>,
  approval: ApprovalRenderState,
  resume: ResumeRenderState,
  focusAttemptId: string | undefined,
): string {
  const attempt = latestAttempt(desc.activity);
  const title = desc.node?.nodeId ?? desc.activity?.ownerNodeId ?? desc.activity?.activityId ?? 'unknown';
  const keyPrefix = attempt?.attemptId ?? desc.activity?.activityId ?? desc.node?.nodeId ?? 'unknown';
  const controls = renderApprovalControls(attempt, approval);
  const focusClass = attempt?.attemptId === focusAttemptId ? ' is-focused' : '';
  const attemptAttr = attempt ? ` data-wf-attempt-card="${escapeHtml(attempt.attemptId)}"` : '';
  const terminalSurface = computeTerminalUrl(attempt, desc.activity, desc.io?.terminal, resume);
  const terminalHtml = terminalSurface
    ? renderTerminalBlockHtml(keyPrefix, attempt, desc.activity, desc.io?.terminal, terminalSurface, openBlocks, resume)
    : '';
  return `<article class="wf-io-card${focusClass}" data-wf-card-key="${escapeHtml(desc.key)}"${attemptAttr}>
    <div class="wf-io-card-head">
      <header>
        <div>
          <strong><code>${escapeHtml(title)}</code></strong>
          <span class="muted">${desc.activity ? escapeHtml(desc.activity.activityId) : escapeHtml(t('workflow.detail.notDispatched'))}</span>
        </div>
        <div>${desc.node ? statusBadge(desc.node.status) : ''} ${desc.activity ? statusBadge(desc.activity.status) : ''}</div>
      </header>
      <div class="wf-io-meta">
        ${attempt ? `${escapeHtml(t('workflow.detail.attempt'))} <code>${escapeHtml(attempt.attemptId)}</code>` : escapeHtml(t('workflow.detail.noAttempt'))}
      </div>
      ${controls}
    </div>
    <div class="wf-io-terminal-slot">${terminalHtml}</div>
    <div class="wf-io-grid">
      ${renderPreviewBlock(keyPrefix, t('workflow.detail.authoredInput'), desc.io?.input, openBlocks)}
      ${renderPreviewBlock(keyPrefix, t('workflow.detail.resolvedInput'), desc.io?.resolvedInput, openBlocks)}
      ${renderPreviewBlock(keyPrefix, t('workflow.detail.output'), desc.io?.output, openBlocks)}
      ${renderPreviewBlock(keyPrefix, t('workflow.detail.executionLog'), desc.io?.log, openBlocks)}
      ${desc.io?.waitPrompt ? renderPreviewBlock(keyPrefix, t('workflow.detail.waitPrompt'), desc.io.waitPrompt, openBlocks) : ''}
    </div>
  </article>`;
}

type ApprovalRenderState = {
  comments: Map<string, string>;
  statuses: Map<string, { kind: 'ok' | 'error'; text: string }>;
  resolving: Set<string>;
  onResolve: (attemptId: string, action: 'approve' | 'reject') => Promise<void>;
};

type ResumeRenderState = {
  sessions: Map<string, { resumeId: string; url: string }>;
  pending: Set<string>;
  errors: Map<string, string>;
  onStart: (attemptId: string, activityId: string) => Promise<void>;
  onEnd: (attemptId: string, activityId: string) => Promise<void>;
};

function latestAttempt(activity?: ActivityState): AttemptState | undefined {
  return activity?.attempts[activity.attempts.length - 1];
}

function terminalMeta(attempt: AttemptState | undefined, terminal: AttemptTerminal): string {
  const bits: string[] = [];
  if (terminal.error) bits.push(t('workflow.detail.error'));
  else bits.push(terminal.status === 'live' ? t('workflow.detail.terminalLive') : t('workflow.detail.terminalClosedShort'));
  if (attempt?.status) bits.push(attempt.status);
  if (terminal.webPort > 0) bits.push(`:${terminal.webPort}`);
  return `<span class="muted">${escapeHtml(bits.join(' · '))}</span>`;
}

function isLiveTerminal(attempt: AttemptState | undefined, terminal: AttemptTerminal): boolean {
  return terminal.status === 'live' &&
    terminal.webPort > 0 &&
    (attempt?.status === 'pending' || attempt?.status === 'running' || attempt?.status === 'effectAttempting');
}

/**
 * Replay-eligibility: attempt has reached a terminal state and a worker
 * actually started (sessionId / startedAt non-empty) — meaning a
 * `terminal.log` file likely exists on disk for the replay HTML to fetch.
 * The replay page itself handles a 404 gracefully, but gating here keeps
 * us from rendering an iframe that's guaranteed to show "no log".
 */
function isReplayableTerminal(attempt: AttemptState, terminal: AttemptTerminal): boolean {
  const isAttemptTerminal =
    attempt.status === 'succeeded' ||
    attempt.status === 'failed' ||
    attempt.status === 'cancelled' ||
    attempt.status === 'timedOut';
  if (!isAttemptTerminal) return false;
  const hadWorker = !!(terminal.sessionId || terminal.startedAt);
  return hadWorker;
}

function terminalReadOnlyUrl(terminal: AttemptTerminal): string {
  const host = window.location.hostname || '127.0.0.1';
  return `http://${host}:${terminal.webPort}`;
}

function terminalReplayPageUrl(
  runId: string,
  activityId: string,
  attemptId: string,
  hasPtyLog: boolean,
): string {
  const qs = new URLSearchParams({ runId, activityId, attemptId });
  if (hasPtyLog) qs.set('hasPtyLog', '1');
  return `/assets/terminal-replay.html?${qs.toString()}`;
}

function terminalLogDownloadUrl(
  runId: string,
  activityId: string,
  attemptId: string,
): string {
  return (
    `/api/workflows/runs/${encodeURIComponent(runId)}` +
    `/attempts/${encodeURIComponent(activityId)}` +
    `/${encodeURIComponent(attemptId)}/terminal-log/raw?download=1`
  );
}

function currentRunIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/workflows\/([^/?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function renderApprovalControls(
  attempt: AttemptState | undefined,
  approval: ApprovalRenderState,
): string {
  if (!isOpenHumanGateAttempt(attempt)) return '';
  const attemptId = attempt.attemptId;
  const comment = approval.comments.get(attemptId) ?? '';
  const resolving = approval.resolving.has(attemptId);
  const status = approval.statuses.get(attemptId);
  const statusClass = status?.kind === 'error' ? 'hint-warn' : 'hint-ok';
  return `<div class="wf-approval-box" data-wf-approval="${escapeHtml(attemptId)}">
    <label>
      <span>${escapeHtml(t('workflow.detail.approvalComment'))}</span>
      <textarea class="wf-approval-comment" data-wf-approval-comment="${escapeHtml(attemptId)}" rows="2" placeholder="${escapeHtml(t('workflow.detail.optionalComment'))}"${resolving ? ' disabled' : ''}>${escapeHtml(comment)}</textarea>
    </label>
    <div class="wf-approval-actions">
      <button type="button" class="primary" data-wf-approval-action="approve" data-wf-attempt-id="${escapeHtml(attemptId)}"${resolving ? ' disabled' : ''}>${escapeHtml(t('workflow.detail.approve'))}</button>
      <button type="button" data-wf-approval-action="reject" data-wf-attempt-id="${escapeHtml(attemptId)}"${resolving ? ' disabled' : ''}>${escapeHtml(t('workflow.detail.reject'))}</button>
      ${resolving ? `<span class="muted">${escapeHtml(t('workflow.detail.submitting'))}</span>` : ''}
    </div>
    ${status ? `<div class="${statusClass} wf-approval-status">${escapeHtml(status.text)}</div>` : ''}
  </div>`;
}

function isOpenHumanGateAttempt(attempt: AttemptState | undefined): attempt is AttemptState {
  return !!attempt &&
    attempt.status === 'waiting' &&
    attempt.wait?.waitKind === 'human-gate' &&
    !attempt.wait.resolution;
}

function syncApprovalComments(root: HTMLElement, comments: Map<string, string>): void {
  root.querySelectorAll<HTMLTextAreaElement>('textarea[data-wf-approval-comment]').forEach((el) => {
    const key = el.dataset.wfApprovalComment;
    if (!key) return;
    comments.set(key, el.value);
  });
}

function attachResumeControls(root: HTMLElement, resume: ResumeRenderState): void {
  root.querySelectorAll<HTMLButtonElement>(
    'button[data-wf-resume-action][data-wf-resume-attempt][data-wf-resume-activity]',
  ).forEach((button) => {
    if (button.dataset.wfResumeBound === '1') return;
    button.dataset.wfResumeBound = '1';
    button.addEventListener('click', () => {
      const attemptId = button.dataset.wfResumeAttempt;
      const activityId = button.dataset.wfResumeActivity;
      const action = button.dataset.wfResumeAction;
      if (!attemptId || !activityId) return;
      if (action === 'start') void resume.onStart(attemptId, activityId);
      else if (action === 'end') void resume.onEnd(attemptId, activityId);
    });
  });
}

function refreshResumeActions(
  slot: HTMLElement,
  attempt: AttemptState,
  activity: ActivityState | undefined,
  terminal: AttemptTerminal,
  surface: TerminalSurface,
  resume: ResumeRenderState,
): void {
  const actions = slot.querySelector<HTMLElement>('.wf-terminal-actions');
  if (!actions) return;
  // Re-render the resume button area in-place so the surrounding
  // anchors (open-in-tab + download) stay stable.  We tag-select the
  // existing button (if any) and replace its outerHTML so the new
  // listener pickup goes through the same data-wf-resume-bound gate.
  const existingButton = actions.querySelector<HTMLButtonElement>('button[data-wf-resume-button="1"]');
  const html = renderResumeButtonHtml(attempt, activity, terminal, surface, resume);
  if (existingButton) {
    existingButton.outerHTML = html;
  } else if (html) {
    actions.insertAdjacentHTML('beforeend', html);
  }
  // Update / clear inline error hint.
  const details = slot.querySelector<HTMLElement>('details.wf-terminal-block');
  if (details) {
    const existingStatus = details.querySelector<HTMLElement>('.wf-resume-status');
    const statusHtml = renderResumeStatusHtml(attempt.attemptId, resume);
    if (existingStatus) {
      existingStatus.outerHTML = statusHtml;
    } else if (statusHtml) {
      actions.insertAdjacentHTML('afterend', statusHtml);
    }
  }
  attachResumeControls(slot, resume);
}

function attachApprovalControls(root: HTMLElement, approval: ApprovalRenderState): void {
  root.querySelectorAll<HTMLTextAreaElement>('textarea[data-wf-approval-comment]').forEach((el) => {
    const key = el.dataset.wfApprovalComment;
    if (!key) return;
    el.addEventListener('input', () => {
      approval.comments.set(key, el.value);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-wf-approval-action][data-wf-attempt-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const attemptId = button.dataset.wfAttemptId;
      const action = button.dataset.wfApprovalAction;
      if (!attemptId || (action !== 'approve' && action !== 'reject')) return;
      void approval.onResolve(attemptId, action);
    });
  });
}

function renderPreviewBlock(
  keyPrefix: string,
  label: string,
  preview: BlobPreview | undefined,
  openBlocks: Set<string>,
): string {
  const key = ioBlockKey(keyPrefix, label);
  return `<details class="wf-io-block" data-io-key="${escapeHtml(key)}"${openBlocks.has(key) ? ' open' : ''}>
    <summary>${escapeHtml(label)} ${previewMeta(preview)}</summary>
    ${renderPreview(preview)}
  </details>`;
}

function ioBlockKey(keyPrefix: string, label: string): string {
  return `${keyPrefix}:${label}`;
}

function scrollFocusedAttemptIntoView(root: HTMLElement, focusAttemptId?: string): boolean {
  if (!focusAttemptId) return false;
  for (const card of root.querySelectorAll<HTMLElement>('[data-wf-attempt-card]')) {
    if (card.dataset.wfAttemptCard !== focusAttemptId) continue;
    card.scrollIntoView({ block: 'center' });
    return true;
  }
  return false;
}

function syncIOBlockState(
  root: HTMLElement,
  openBlocks: Set<string>,
  scrollTops: Map<string, number>,
): void {
  root.querySelectorAll<HTMLDetailsElement>('details.wf-io-block[data-io-key]').forEach((el) => {
    const key = el.dataset.ioKey;
    if (!key) return;
    if (el.open) openBlocks.add(key);
    else openBlocks.delete(key);
    const pre = el.querySelector<HTMLElement>('.wf-io-pre');
    if (pre) scrollTops.set(key, pre.scrollTop);
  });
}

function attachIOBlockToggleTracking(root: HTMLElement, openBlocks: Set<string>): void {
  root.querySelectorAll<HTMLDetailsElement>('details.wf-io-block[data-io-key]').forEach((el) => {
    if (el.dataset.ioToggleBound === '1') return;
    el.dataset.ioToggleBound = '1';
    el.addEventListener('toggle', () => {
      const key = el.dataset.ioKey;
      if (!key) return;
      if (el.open) openBlocks.add(key);
      else openBlocks.delete(key);
    });
  });
}

function restoreIOBlockScroll(root: HTMLElement, scrollTops: Map<string, number>): void {
  root.querySelectorAll<HTMLDetailsElement>('details.wf-io-block[data-io-key]').forEach((el) => {
    const key = el.dataset.ioKey;
    if (!key) return;
    const top = scrollTops.get(key);
    if (top === undefined) return;
    const pre = el.querySelector<HTMLElement>('.wf-io-pre');
    if (pre) pre.scrollTop = top;
  });
}

function attachIOBlockScrollTracking(root: HTMLElement, scrollTops: Map<string, number>): void {
  root.querySelectorAll<HTMLDetailsElement>('details.wf-io-block[data-io-key]').forEach((el) => {
    const key = el.dataset.ioKey;
    if (!key) return;
    const pre = el.querySelector<HTMLElement>('.wf-io-pre');
    if (!pre) return;
    if (pre.dataset.ioScrollBound === '1') return;
    pre.dataset.ioScrollBound = '1';
    pre.addEventListener('scroll', () => {
      scrollTops.set(key, pre.scrollTop);
    });
  });
}

function previewMeta(preview?: BlobPreview): string {
  if (!preview) return `<span class="muted">${escapeHtml(t('workflow.detail.empty'))}</span>`;
  const bits: string[] = [];
  if (preview.outputBytes !== undefined) bits.push(`${preview.outputBytes}B`);
  if (preview.truncated) bits.push(t('workflow.detail.truncated'));
  if (preview.error) bits.push(t('workflow.detail.error'));
  if (preview.outputHash) bits.push(short(preview.outputHash));
  return bits.length ? `<span class="muted">${escapeHtml(bits.join(' · '))}</span>` : '';
}

function renderPreview(preview?: BlobPreview): string {
  if (!preview) return `<div class="muted wf-io-empty">${escapeHtml(t('workflow.detail.noData'))}</div>`;
  const body =
    preview.value !== undefined
      ? JSON.stringify(preview.value, null, 2)
      : preview.text ?? '';
  const error = preview.error ? `<div class="muted error">${escapeHtml(preview.error)}</div>` : '';
  if (!body) return `${error}<div class="muted wf-io-empty">${escapeHtml(t('workflow.detail.noPreview'))}</div>`;
  return `${error}<pre class="wf-io-pre">${escapeHtml(body)}</pre>`;
}

function renderAttemptDetail(at: AttemptState): string {
  const parts: string[] = [];
  if (at.effectAttempted) parts.push(`${escapeHtml(t('workflow.detail.effect'))} ${escapeHtml(at.effectAttempted.provider)}`);
  if (at.wait) {
    const res = at.wait.resolution
      ? `${at.wait.resolution.kind}${at.wait.resolution.resolution ? ':' + at.wait.resolution.resolution : ''}`
      : t('workflow.detail.open');
    parts.push(`${escapeHtml(t('workflow.detail.wait'))} ${escapeHtml(at.wait.waitKind)} ${escapeHtml(res)}`);
    if (at.wait.deadlineAt !== undefined) {
      parts.push(`${escapeHtml(t('workflow.detail.deadline'))} ${escapeHtml(formatClock(at.wait.deadlineAt))}`);
    }
  }
  if (at.error) {
    const tag = `${at.error.errorCode}${at.error.errorClass ? ` · ${at.error.errorClass}` : ''}`;
    parts.push(`<span class="muted error">${escapeHtml(tag)}</span>`);
    if (at.error.errorMessage) {
      parts.push(`<span class="error wf-error-msg">${escapeHtml(at.error.errorMessage)}</span>`);
    }
  }
  if (at.output) parts.push(`${escapeHtml(t('workflow.detail.output'))} ${escapeHtml(short(at.output.outputHash))}`);
  if (at.runningMs !== undefined) parts.push(`${at.runningMs}ms`);
  return parts.length > 0 ? parts.join('<br/>') : '<span class="muted">-</span>';
}

function renderEvents(tbody: HTMLElement, events: WorkflowEvent[]): void {
  tbody.innerHTML =
    events.length > 0
      ? events.map(renderEventRow).join('')
      : `<tr><td colspan="7" class="empty">${escapeHtml(t('workflow.detail.noEvents'))}</td></tr>`;
}

function renderEventRow(ev: WorkflowEvent): string {
  const ctx = extractEventContext(ev.payload);
  return `<tr>
    <td>${eventSeqFromId(ev.eventId)}</td>
    <td><code>${escapeHtml(ev.type)}</code></td>
    <td>${escapeHtml(ev.actor)}</td>
    <td>${ctx.nodeId ? `<code>${escapeHtml(ctx.nodeId)}</code>` : '-'}</td>
    <td>${ctx.activityId ? `<code>${escapeHtml(ctx.activityId)}</code>` : '-'}</td>
    <td>${ctx.errorCode ? `<span class="muted error">${escapeHtml(ctx.errorCode)}</span>` : '-'}</td>
    <td title="${escapeHtml(new Date(ev.timestamp).toISOString())}">${escapeHtml(formatClock(ev.timestamp))}</td>
  </tr>`;
}

// Browser-side copies of ops-projection helpers.  Keep these tiny to avoid
// pulling the Node/Zod projection module into the dashboard bundle.
function eventSeqFromId(eventId: string): number {
  const dash = eventId.lastIndexOf('-');
  if (dash < 0) return 0;
  const n = Number(eventId.slice(dash + 1));
  return Number.isFinite(n) ? n : 0;
}

function extractEventContext(
  payload: unknown,
): { nodeId?: string; activityId?: string; errorCode?: string } {
  if (!payload || typeof payload !== 'object' || 'ref' in (payload as object)) return {};
  const p = payload as Record<string, unknown>;
  const out: { nodeId?: string; activityId?: string; errorCode?: string } = {};
  if (typeof p.nodeId === 'string') out.nodeId = p.nodeId;
  if (typeof p.activityId === 'string') out.activityId = p.activityId;
  if (typeof p.failedNodeId === 'string') out.nodeId = p.failedNodeId;
  const err = p.error;
  if (err && typeof err === 'object' && 'errorCode' in err) {
    out.errorCode = String((err as { errorCode: unknown }).errorCode);
  }
  return out;
}

function payloadRecord(ev: WorkflowEvent): Record<string, unknown> | null {
  if (!ev.payload || typeof ev.payload !== 'object' || 'ref' in (ev.payload as object)) return null;
  return ev.payload as Record<string, unknown>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function short(value?: string): string {
  if (!value) return '-';
  return value.length > 18 ? value.slice(0, 10) + '...' + value.slice(-6) : value;
}

function shortText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
