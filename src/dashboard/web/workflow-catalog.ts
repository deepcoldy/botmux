import { t } from './ui.js';

type CatalogEntry = {
  workflowId: string;
  version: number;
  path: string;
  revisionId: string;
  paramCount: number;
  requiredParamCount: number;
  nodeCount: number;
};

type ParamDef = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  format?: string;
};

type WorkflowDefinition = {
  workflowId: string;
  version: number;
  params?: Record<string, ParamDef>;
  nodes: Record<string, unknown>;
};

type CatalogDefinitionResponse = {
  definition: WorkflowDefinition;
  revisionId: string;
  path: string;
};

type TriggerResponse = {
  ok: boolean;
  runId?: string;
  workflowId?: string;
  status?: string;
  lastSeq?: number;
  error?: string;
  hint?: string;
  message?: string;
  // Matches the daemon contract from triggerWorkflowRun: `path` is the
  // dotted-key trail (currently length 0 or 1), so we render `a.b.c` for
  // potential future nesting and `(root)` when empty rather than blank.
  issues?: Array<{ path: string[]; code?: string; message: string }>;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function short(value?: string): string {
  if (!value) return '-';
  return value.length > 18 ? value.slice(0, 10) + '...' + value.slice(-6) : value;
}

export function renderWorkflowCatalogPage(root: HTMLElement): () => void {
  // Catalog lives at `#/workflows/catalog[/<workflowId>]` since the nav
  // refactor.  Legacy `#/workflows-catalog[/<workflowId>]` is honored so
  // pasted URLs keep working.
  const detailMatch = location.hash.match(
    /^#\/(?:workflows\/catalog|workflows-catalog)\/([^/?#]+)$/,
  );
  if (detailMatch) {
    return renderCatalogDetailPage(root, decodeURIComponent(detailMatch[1]!));
  }
  return renderCatalogListPage(root);
}

function renderCatalogListPage(root: HTMLElement): () => void {
  root.innerHTML = `
    <nav class="wf-subnav">
      <a href="#/workflows" data-i18n="workflow.subnav.runs">${escapeHtml(t('workflow.subnav.runs'))}</a>
      <a href="#/workflows/catalog" class="active" data-i18n="workflow.subnav.catalog">${escapeHtml(t('workflow.subnav.catalog'))}</a>
    </nav>
    <section class="catalog-head">
      <div>
        <h2>${escapeHtml(t('catalog.title'))}</h2>
        <p class="muted">${escapeHtml(t('catalog.subtitle'))}</p>
      </div>
      <button id="catalog-refresh" type="button">${escapeHtml(t('catalog.refresh'))}</button>
    </section>
    <form id="catalog-filters" class="filters">
      <input type="search" name="q" placeholder="${escapeHtml(t('catalog.searchPlaceholder'))}" />
      <span id="catalog-status" class="muted"></span>
    </form>
    <div class="wf-table-scroll">
      <table>
        <thead><tr>
          <th>${escapeHtml(t('catalog.table.workflow'))}</th>
          <th>${escapeHtml(t('catalog.table.version'))}</th>
          <th>${escapeHtml(t('catalog.table.params'))}</th>
          <th>${escapeHtml(t('catalog.table.nodes'))}</th>
          <th>${escapeHtml(t('catalog.table.revision'))}</th>
          <th>${escapeHtml(t('catalog.table.path'))}</th>
        </tr></thead>
        <tbody id="catalog-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody = root.querySelector<HTMLElement>('#catalog-tbody')!;
  const status = root.querySelector<HTMLElement>('#catalog-status')!;
  const form = root.querySelector<HTMLFormElement>('#catalog-filters')!;
  const refresh = root.querySelector<HTMLButtonElement>('#catalog-refresh')!;

  let entries: CatalogEntry[] = [];
  let error: string | null = null;
  let disposed = false;

  function filtered(): CatalogEntry[] {
    const q = ((new FormData(form).get('q') as string) ?? '').trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) =>
      entry.workflowId.toLowerCase().includes(q) ||
      entry.path.toLowerCase().includes(q),
    );
  }

  function render(): void {
    if (error) {
      status.textContent = t('catalog.loadFailed', { error });
      status.classList.add('error');
    } else {
      status.textContent = `${entries.length}`;
      status.classList.remove('error');
    }
    const rows = filtered();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${
        entries.length === 0
          ? escapeHtml(t('catalog.noDefinitions'))
          : escapeHtml(t('catalog.noFilterMatch'))
      }</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((entry) => `
      <tr>
        <td><a href="#/workflows/catalog/${encodeURIComponent(entry.workflowId)}"><code>${escapeHtml(entry.workflowId)}</code></a></td>
        <td>${entry.version}</td>
        <td>${escapeHtml(t('catalog.paramSummary', {
          required: entry.requiredParamCount,
          total: entry.paramCount,
        }))}</td>
        <td>${entry.nodeCount}</td>
        <td><code>${escapeHtml(short(entry.revisionId))}</code></td>
        <td><code>${escapeHtml(entry.path)}</code></td>
      </tr>
    `).join('');
  }

  async function load(): Promise<void> {
    refresh.disabled = true;
    status.textContent = t('catalog.loading');
    try {
      const res = await fetch('/api/workflows/definitions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { definitions?: CatalogEntry[] };
      entries = body.definitions ?? [];
      error = null;
    } catch (err: any) {
      error = err?.message ?? String(err);
      entries = [];
    } finally {
      refresh.disabled = false;
      if (!disposed) render();
    }
  }

  form.addEventListener('input', render);
  refresh.addEventListener('click', () => void load());
  void load();

  return () => {
    disposed = true;
  };
}

function renderCatalogDetailPage(root: HTMLElement, workflowId: string): () => void {
  root.innerHTML = `
    <div class="catalog-detail-head">
      <a class="btn-link" href="#/workflows/catalog">${escapeHtml(t('catalog.back'))}</a>
      <div>
        <h2><code>${escapeHtml(workflowId)}</code></h2>
        <div id="catalog-detail-subtitle" class="muted">${escapeHtml(t('workflow.detail.loading'))}</div>
      </div>
    </div>
    <section id="catalog-error" class="hint-warn" hidden></section>
    <section id="catalog-run-status" class="hint-ok" hidden></section>
    <div id="catalog-detail-body"></div>
  `;

  const subtitle = root.querySelector<HTMLElement>('#catalog-detail-subtitle')!;
  const errorEl = root.querySelector<HTMLElement>('#catalog-error')!;
  const runStatusEl = root.querySelector<HTMLElement>('#catalog-run-status')!;
  const bodyEl = root.querySelector<HTMLElement>('#catalog-detail-body')!;

  let detail: CatalogDefinitionResponse | null = null;
  let disposed = false;
  let running = false;

  function setError(message: string | null): void {
    errorEl.hidden = !message;
    errorEl.textContent = message ?? '';
  }

  function setRunStatus(message: string | null): void {
    runStatusEl.hidden = !message;
    runStatusEl.textContent = message ?? '';
  }

  function defaultParams(params?: Record<string, ParamDef>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(params ?? {})) {
      if ('default' in def) out[key] = def.default;
    }
    return out;
  }

  function render(): void {
    if (!detail) return;
    const def = detail.definition;
    subtitle.textContent = `${t('catalog.revision')} ${short(detail.revisionId)} · ${detail.path}`;
    const paramsJson = JSON.stringify(defaultParams(def.params), null, 2);
    bodyEl.innerHTML = `
      <section class="wf-panel">
        <div class="wf-panel-title"><h3>${escapeHtml(t('catalog.summary'))}</h3></div>
        <div class="wf-summary-grid">
          <div class="wf-summary-item"><span>${escapeHtml(t('catalog.table.workflow'))}</span><strong><code>${escapeHtml(def.workflowId)}</code></strong></div>
          <div class="wf-summary-item"><span>${escapeHtml(t('catalog.table.version'))}</span><strong>${def.version}</strong></div>
          <div class="wf-summary-item"><span>${escapeHtml(t('catalog.nodeCount'))}</span><strong>${Object.keys(def.nodes).length}</strong></div>
          <div class="wf-summary-item"><span>${escapeHtml(t('catalog.path'))}</span><strong><code>${escapeHtml(detail.path)}</code></strong></div>
        </div>
      </section>

      <section class="wf-panel">
        <div class="wf-panel-title"><h3>${escapeHtml(t('catalog.runPanel'))}</h3></div>
        <form id="catalog-run-form" class="catalog-run-form">
          <label>
            <span>${escapeHtml(t('catalog.paramsJson'))}</span>
            <textarea id="catalog-params" rows="8" spellcheck="false" placeholder="${escapeHtml(t('catalog.paramsPlaceholder'))}">${escapeHtml(paramsJson)}</textarea>
          </label>
          <div class="catalog-chat-grid">
            <label>
              <span>${escapeHtml(t('catalog.chatId'))}</span>
              <input id="catalog-chat-id" type="text" autocomplete="off" />
            </label>
            <label>
              <span>${escapeHtml(t('catalog.larkAppId'))}</span>
              <input id="catalog-lark-app-id" type="text" autocomplete="off" />
            </label>
          </div>
          <div class="muted">${escapeHtml(t('catalog.chatBindingHint'))}</div>
          <div id="catalog-param-errors" class="catalog-param-errors" hidden></div>
          <button id="catalog-run-btn" type="submit" class="primary">${escapeHtml(t('catalog.run'))}</button>
        </form>
      </section>

      <section class="wf-panel">
        <div class="wf-panel-title"><h3>${escapeHtml(t('catalog.paramsSchema'))}</h3></div>
        ${renderParams(def.params)}
      </section>

      <section class="wf-panel">
        <div class="wf-panel-title"><h3>${escapeHtml(t('catalog.definitionJson'))}</h3></div>
        <pre class="wf-io-pre">${escapeHtml(JSON.stringify(def, null, 2))}</pre>
      </section>
    `;
    attachRunForm();
  }

  async function runWorkflow(): Promise<void> {
    if (!detail || running) return;
    const paramsEl = bodyEl.querySelector<HTMLTextAreaElement>('#catalog-params')!;
    const chatIdEl = bodyEl.querySelector<HTMLInputElement>('#catalog-chat-id')!;
    const appIdEl = bodyEl.querySelector<HTMLInputElement>('#catalog-lark-app-id')!;
    const submit = bodyEl.querySelector<HTMLButtonElement>('#catalog-run-btn')!;
    const issueEl = bodyEl.querySelector<HTMLElement>('#catalog-param-errors')!;
    let params: unknown;
    try {
      params = JSON.parse(paramsEl.value || '{}');
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error(t('catalog.badParamsJson'));
      }
    } catch (err: any) {
      issueEl.hidden = false;
      issueEl.innerHTML = `<div class="muted error">${escapeHtml(err?.message ?? String(err))}</div>`;
      return;
    }

    running = true;
    submit.disabled = true;
    submit.textContent = t('catalog.running');
    issueEl.hidden = true;
    setError(null);
    setRunStatus(null);
    try {
      const res = await fetch(`/api/workflows/definitions/${encodeURIComponent(detail.definition.workflowId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          params,
          chatBinding: {
            chatId: chatIdEl.value.trim(),
            larkAppId: appIdEl.value.trim(),
          },
        }),
      });
      if (res.status === 401) throw new Error(t('catalog.writeAccess'));
      const result = (await res.json().catch(() => ({}))) as TriggerResponse;
      if (!res.ok || !result.ok) {
        if (result.issues?.length) {
          issueEl.hidden = false;
          issueEl.innerHTML = `<strong>${escapeHtml(t('catalog.invalidParams'))}</strong><ul>${
            result.issues.map((issue) => `<li>${escapeHtml(t('catalog.issue', {
              path: issue.path.length ? issue.path.join('.') : '(root)',
              message: issue.message,
            }))}</li>`).join('')
          }</ul>`;
        }
        throw new Error(result.hint ?? result.message ?? result.error ?? t('catalog.runHttp', { status: res.status }));
      }
      setRunStatus(t('catalog.runStarted'));
      if (result.runId) location.hash = `#/workflows/${encodeURIComponent(result.runId)}`;
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      running = false;
      submit.disabled = false;
      submit.textContent = t('catalog.run');
    }
  }

  function attachRunForm(): void {
    const form = bodyEl.querySelector<HTMLFormElement>('#catalog-run-form');
    form?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void runWorkflow();
    });
  }

  async function load(): Promise<void> {
    try {
      const res = await fetch(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`);
      if (res.status === 404) throw new Error('unknown_workflow');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      detail = (await res.json()) as CatalogDefinitionResponse;
      setError(null);
      render();
    } catch (err: any) {
      setError(t('catalog.definitionLoadFailed', { error: err?.message ?? String(err) }));
      subtitle.textContent = t('workflow.detail.loadFailed');
    }
  }

  void load().then(() => {
    if (disposed) return;
  });

  return () => {
    disposed = true;
  };
}

function renderParams(params?: Record<string, ParamDef>): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) {
    return `<div class="muted">${escapeHtml(t('catalog.noParams'))}</div>`;
  }
  return `<div class="catalog-param-list">${entries.map(([name, def]) => `
    <article class="catalog-param">
      <header>
        <code>${escapeHtml(name)}</code>
        <span class="wf-status">${escapeHtml(def.required ? t('catalog.required') : t('catalog.optional'))}</span>
        <span class="muted">${escapeHtml(def.type)}${def.format ? ` · ${escapeHtml(def.format)}` : ''}</span>
      </header>
      ${def.description ? `<div class="muted">${escapeHtml(t('catalog.description'))}: ${escapeHtml(def.description)}</div>` : ''}
      ${'default' in def ? `<pre class="wf-io-pre">${escapeHtml(`${t('catalog.default')}: ${JSON.stringify(def.default, null, 2)}`)}</pre>` : ''}
    </article>
  `).join('')}</div>`;
}
