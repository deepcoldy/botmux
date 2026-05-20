// Dashboard workflow Run List / Detail pages.
//
// Polls /api/workflows/runs every 5s while visible.  Each row links to
// #/workflows/<runId> — the Run Detail page (B path) hooks into the
// same hash route.

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

type AttemptState = {
  attemptId: string;
  attemptNumber: number;
  status: string;
  effectAttempted?: { provider: string; idempotencyKey: string };
  wait?: {
    waitKind: string;
    prompt?: string;
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

const PAGE_HTML = `
<form id="wf-filters" class="filters">
  <input type="search" name="q" placeholder="search runId / workflowId / chatId" />
  <select name="status">
    <option value="">non-terminal</option>
    <option value="all">all</option>
    <option value="pending">pending</option>
    <option value="running">running</option>
    <option value="waiting">waiting</option>
    <option value="succeeded">succeeded</option>
    <option value="failed">failed</option>
    <option value="cancelled">cancelled</option>
  </select>
  <span id="wf-last-load" class="muted"></span>
</form>
<table>
  <thead><tr>
    <th>run</th><th>workflow</th><th>status</th>
    <th>lastSeq</th><th>dEf/dAct/dWait</th><th>updated</th>
    <th>chat / app</th>
  </tr></thead>
  <tbody id="wf-tbody"></tbody>
</table>
`;

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
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function statusBadge(status: string): string {
  const cls = TERMINAL.has(status) ? 'wf-status terminal' : 'wf-status live';
  return `<span class="${cls} wf-status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function renderWorkflowsPage(root: HTMLElement): () => void {
  const detailMatch = location.hash.match(/^#\/workflows\/([^/?#]+)$/);
  if (detailMatch) {
    return renderWorkflowDetailPage(root, decodeURIComponent(detailMatch[1]!));
  }
  return renderWorkflowListPage(root);
}

function renderWorkflowListPage(root: HTMLElement): () => void {
  root.innerHTML = PAGE_HTML;
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
          ? `Failed to load: ${escapeHtml(lastErr)}`
          : cache.length === 0
            ? 'No runs match.'
            : 'No runs match this filter.'
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
        return `<tr data-runid="${escapeHtml(r.runId)}">
          <td><a href="#/workflows/${encodeURIComponent(r.runId)}"><code>${escapeHtml(r.runId)}</code></a></td>
          <td>${escapeHtml(r.workflowId)}</td>
          <td>${statusBadge(r.status)}${
            r.failedNodeId ? ` <span class="muted">(${escapeHtml(r.failedNodeId)})</span>` : ''
          }</td>
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
      lastLoadEl.textContent = `error: ${lastErr}`;
      lastLoadEl.classList.add('error');
    } else {
      lastLoadEl.textContent = `${cache.length} runs · refreshed ${new Date().toLocaleTimeString()}`;
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

function renderWorkflowDetailPage(root: HTMLElement, runId: string): () => void {
  root.innerHTML = `
    <div class="wf-detail-head">
      <a class="btn-link" href="#/workflows">Back</a>
      <div>
        <h2><code>${escapeHtml(runId)}</code></h2>
        <div id="wf-detail-subtitle" class="muted">Loading...</div>
      </div>
      <button id="wf-cancel-run" type="button" class="contrast" hidden>Cancel</button>
      <span id="wf-detail-refresh" class="muted"></span>
    </div>
    <section id="wf-detail-error" class="hint-warn" hidden></section>
    <section id="wf-cancel-status" class="hint-ok" hidden></section>
    <section id="wf-summary" class="wf-summary-grid"></section>
    <section id="wf-dangling-panel"></section>
    <section class="wf-panel">
      <div class="wf-panel-title">
        <h3>Nodes / Activities</h3>
      </div>
      <div class="wf-table-scroll">
        <table>
          <thead><tr>
            <th>node</th><th>node status</th><th>activity</th><th>activity status</th>
            <th>attempts</th><th>current</th><th>detail</th>
          </tr></thead>
          <tbody id="wf-node-tbody"></tbody>
        </table>
      </div>
    </section>
    <section class="wf-panel">
      <div class="wf-panel-title">
        <h3>Timeline</h3>
        <button id="wf-load-older" type="button" hidden>Load older</button>
      </div>
      <div class="wf-table-scroll wf-timeline-scroll">
        <table>
          <thead><tr>
            <th>seq</th><th>event</th><th>actor</th><th>node</th><th>activity</th><th>error</th><th>time</th>
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
  const nodeTbody = root.querySelector<HTMLElement>('#wf-node-tbody')!;
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
      throw new Error('unknown run');
    }
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    snapshot = (await res.json()) as RunSnapshot;
  }

  async function fetchEvents(params: URLSearchParams): Promise<EventWindow> {
    const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/events?${params}`);
    if (res.status === 404) throw new Error('unknown run');
    if (!res.ok) throw new Error(`events HTTP ${res.status}`);
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
      setError(`cancel unavailable: use botmux workflow cancel ${runId}`);
      return;
    }
    const dangling = danglingSummary(snapshot);
    const message = `Cancel workflow run ${runId}?\n\n` +
      `${dangling.total} dangling item(s) will be handled by cancel-driven recovery.\n` +
      `effects=${dangling.effects}, activities=${dangling.activities}, waits=${dangling.waits}, cancels=${dangling.cancels}`;
    if (!window.confirm(message)) return;
    canceling = true;
    cancelBtn.disabled = true;
    try {
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'cancelled via dashboard' }),
      });
      const body = (await res.json().catch(() => ({}))) as CancelRunResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.hint ?? body.error ?? `cancel HTTP ${res.status}`);
      }
      setCancelStatus(body.pending ? 'cancel pending; waiting for running activity to drain' : null);
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

  function rerender(): void {
    if (!snapshot) return;
    const run = snapshot.run;
    if (TERMINAL.has(run.status)) setCancelStatus(null);
    subtitle.innerHTML = `${escapeHtml(run.workflowId ?? '?')} · ${statusBadge(run.status)} · lastSeq ${snapshot.lastSeq}`;
    refresh.textContent = `refreshed ${new Date().toLocaleTimeString()}`;
    cancelBtn.hidden = TERMINAL.has(run.status);
    cancelBtn.disabled = canceling || !snapshot.chatBinding?.larkAppId;
    cancelBtn.textContent = snapshot.chatBinding?.larkAppId ? 'Cancel' : 'CLI cancel only';
    cancelBtn.title = snapshot.chatBinding?.larkAppId
      ? 'Cancel this workflow run'
      : `Cancel unavailable: use botmux workflow cancel ${runId}`;
    renderSummary(summaryEl, snapshot);
    renderDangling(danglingEl, snapshot);
    renderNodeActivityRows(nodeTbody, snapshot);
    renderEvents(eventTbody, events);
    loadOlder.hidden = !hasOlder;
    eventMeta.textContent = `${events.length}/${totalCount} events loaded`;
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
      subtitle.textContent = 'Load failed';
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
    ['workflow', escapeHtml(r.workflowId ?? '?')],
    ['status', statusBadge(r.status)],
    ['lastSeq', String(snap.lastSeq)],
    ['updated', escapeHtml(new Date(snap.updatedAt).toLocaleString())],
    ['revision', escapeHtml(short(r.revisionId))],
    ['initiator', escapeHtml(r.initiator ?? '-')],
  ];
  if (r.failedNodeId) items.push(['failedNode', escapeHtml(r.failedNodeId)]);
  if (r.cancelOriginEventId) items.push(['cancelOrigin', escapeHtml(r.cancelOriginEventId)]);
  if (snap.chatBinding) {
    items.push(['chat', `<code>${escapeHtml(snap.chatBinding.chatId)}</code>`]);
    items.push(['app', `<code>${escapeHtml(snap.chatBinding.larkAppId)}</code>`]);
  }
  el.innerHTML = items
    .map(([label, value]) => `<div class="wf-summary-item"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');
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
    ['activities', d.activities],
    ['effects', d.effectAttempted],
    ['waits', d.waits],
    ['cancels', d.cancels],
  ];
  const total = new Set(groups.flatMap(([, xs]) => xs)).size;
  el.className = total > 0 ? 'wf-panel wf-dangling-panel has' : 'wf-panel wf-dangling-panel';
  if (total === 0) {
    el.innerHTML = `<div class="wf-panel-title"><h3>Dangling</h3></div><div class="muted">No dangling work.</div>`;
    return;
  }
  el.innerHTML = `<div class="wf-panel-title"><h3>Dangling</h3><span class="wf-dangling has">${total}</span></div>
    <div class="wf-dangling-grid">
      ${groups
        .map(
          ([name, xs]) => `<div><strong>${name}</strong>${
            xs.length === 0
              ? '<div class="muted">none</div>'
              : `<ul>${xs.map((x) => `<li><code>${escapeHtml(x)}</code></li>`).join('')}</ul>`
          }</div>`,
        )
        .join('')}
    </div>`;
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

  tbody.innerHTML = rows.length > 0 ? rows.join('') : '<tr><td colspan="7" class="empty">No nodes yet.</td></tr>';
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
    <td>${latest ? renderAttemptDetail(latest) : '<span class="muted">idle</span>'}</td>
  </tr>`;
}

function renderAttemptDetail(at: AttemptState): string {
  const parts: string[] = [];
  if (at.effectAttempted) parts.push(`effect ${escapeHtml(at.effectAttempted.provider)}`);
  if (at.wait) {
    const res = at.wait.resolution
      ? `${at.wait.resolution.kind}${at.wait.resolution.resolution ? ':' + at.wait.resolution.resolution : ''}`
      : 'open';
    parts.push(`wait ${escapeHtml(at.wait.waitKind)} ${escapeHtml(res)}`);
    if (at.wait.deadlineAt !== undefined) {
      parts.push(`deadline ${escapeHtml(formatClock(at.wait.deadlineAt))}`);
    }
  }
  if (at.error) parts.push(`<span class="muted error">${escapeHtml(at.error.errorCode)}</span>`);
  if (at.output) parts.push(`output ${escapeHtml(short(at.output.outputHash))}`);
  if (at.runningMs !== undefined) parts.push(`${at.runningMs}ms`);
  return parts.length > 0 ? parts.join('<br/>') : '<span class="muted">-</span>';
}

function renderEvents(tbody: HTMLElement, events: WorkflowEvent[]): void {
  tbody.innerHTML =
    events.length > 0
      ? events.map(renderEventRow).join('')
      : '<tr><td colspan="7" class="empty">No events.</td></tr>';
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

function short(value?: string): string {
  if (!value) return '-';
  return value.length > 18 ? value.slice(0, 10) + '...' + value.slice(-6) : value;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
