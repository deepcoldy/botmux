// Sessions page: filter bar, table, detail drawer with locate/resume/close.
import { store } from './store.js';
import { escapeHtml, relTime, t } from './ui.js';

function th(sort: string, label: string): string {
  return `<th data-sort="${sort}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</th>`;
}

const CLI_FILTER_OPTIONS = [
  'claude-code',
  'codex',
  'codex-app',
  'cursor',
  'gemini',
  'opencode',
  'mtr',
  'hermes',
  'mira',
  'aiden',
  'coco',
  'unknown',
];

export function renderCliFilterGroup(): string {
  return `<div class="filter-check-group" role="group" aria-label="${t('sessions.cli')}">
    <span class="filter-check-label">${t('sessions.cli')}</span>
    ${CLI_FILTER_OPTIONS.map(cli => `
      <label class="filter-check">
        <input type="checkbox" name="cli" value="${escapeHtml(cli)}" checked>
        <span>${escapeHtml(cli)}</span>
      </label>
    `).join('')}
  </div>`;
}

function pageHtml(): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('nav.sessions')}</p>
        <h1>${t('sessions.title')}</h1>
        <p>${t('sessions.subtitle')}</p>
      </div>
    </div>
    <form id="filters" class="filters sessions-filters">
      <input type="search" name="q" placeholder="${t('sessions.search')}" />
      <select name="status">
        <option value="">${t('sessions.anyStatus')}</option>
        <option>starting</option><option>working</option><option>idle</option>
        <option>analyzing</option><option>active</option><option>closed</option>
      </select>
      <select name="adopt">
        <option value="">${t('sessions.adoptAny')}</option>
        <option value="yes">${t('sessions.adoptYes')}</option>
        <option value="no">${t('sessions.adoptNo')}</option>
      </select>
      <label class="filter-toggle"><input type="checkbox" name="active" checked> ${t('sessions.activeOnly')}</label>
      ${renderCliFilterGroup()}
    </form>
    <div id="bulk-bar" class="bulk-bar" hidden>
      <span id="bulk-count"></span>
      <button type="button" id="bulk-close" class="contrast">${t('sessions.closeSelected')}</button>
      <button type="button" id="bulk-clear">${t('sessions.clearSelection')}</button>
    </div>
    <table id="sessions-table">
      <thead><tr>
        <th><input type="checkbox" id="select-all" title="${t('sessions.activeOnly')}"></th>
        ${th('botName', t('sessions.bot'))}
        ${th('cliId', t('sessions.cli'))}
        ${th('status', t('sessions.status'))}
        ${th('title', t('sessions.titleCol'))}
        ${th('workingDir', t('sessions.workingDir'))}
        ${th('spawnedAt', t('sessions.created'))}
        ${th('lastMessageAt', t('sessions.last'))}
        ${th('adopt', t('sessions.adopt'))}
        <th>${t('sessions.actions')}</th>
      </tr></thead>
      <tbody></tbody>
    </table>
    <dialog id="drawer"></dialog>
  </section>`;
}

export function renderSessionsPage(root: HTMLElement) {
  root.innerHTML = pageHtml();
  const tbody = root.querySelector<HTMLElement>('#sessions-table tbody')!;
  const filtersForm = root.querySelector<HTMLFormElement>('#filters')!;
  const drawer = root.querySelector<HTMLDialogElement>('#drawer')!;
  const selectAllBox = root.querySelector<HTMLInputElement>('#select-all')!;
  const bulkBar = root.querySelector<HTMLElement>('#bulk-bar')!;
  const bulkCountSpan = root.querySelector<HTMLElement>('#bulk-count')!;
  const bulkCloseBtn = root.querySelector<HTMLButtonElement>('#bulk-close')!;
  const bulkClearBtn = root.querySelector<HTMLButtonElement>('#bulk-clear')!;
  const table = root.querySelector<HTMLTableElement>('#sessions-table')!;

  const selected = new Set<string>();
  let sortKey = 'lastMessageAt';
  let sortDir: 'asc' | 'desc' = 'desc';

  function rowHtml(s: any): string {
    const closed = s.status === 'closed';
    const checked = selected.has(s.sessionId) ? 'checked' : '';
    return `<tr data-id="${escapeHtml(s.sessionId)}">
      <td><input type="checkbox" class="row-select" ${checked} ${closed ? 'disabled' : ''}></td>
      <td>${escapeHtml(s.botName ?? '')}</td>
      <td><span class="badge cli-${escapeHtml(s.cliId ?? 'unknown')}">${escapeHtml(s.cliId ?? 'unknown')}</span></td>
      <td><span class="status status-${escapeHtml(s.status ?? 'unknown')}">${escapeHtml(s.status ?? 'unknown')}</span></td>
      <td>${escapeHtml((s.title ?? '').slice(0, 48))}</td>
      <td title="${escapeHtml(s.workingDir ?? '')}">${escapeHtml((s.workingDir ?? '').slice(-34))}</td>
      <td>${relTime(s.spawnedAt)}</td>
      <td>${relTime(s.lastMessageAt)}</td>
      <td>${s.adopt ? '<span class="badge">adopt</span>' : ''}</td>
      <td><button class="open" type="button">${t('sessions.details')}</button></td>
    </tr>`;
  }

  function filtered(): any[] {
    const f = new FormData(filtersForm);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const cli = f.getAll('cli') as string[];
    const cliFilterActive = cli.length > 0 && cli.length < CLI_FILTER_OPTIONS.length;
    const status = f.get('status') as string;
    const adopt = f.get('adopt') as string;
    const active = !!f.get('active');
    const rows = [...store.sessions.values()]
      .filter(s => !cliFilterActive || cli.includes(s.cliId ?? 'unknown'))
      .filter(s => !status || s.status === status)
      .filter(s => !adopt || (adopt === 'yes') === !!s.adopt)
      .filter(s => !active || s.status !== 'closed')
      .filter(s => !q || JSON.stringify(s).toLowerCase().includes(q));
    rows.sort(compareRows);
    return rows;
  }

  function sortValue(s: any, key: string): string | number | boolean {
    if (key === 'spawnedAt' || key === 'lastMessageAt') return Number(s[key] ?? 0);
    if (key === 'adopt') return !!s.adopt;
    return String(s[key] ?? '').toLowerCase();
  }

  function compareRows(a: any, b: any): number {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = Number(av) - Number(bv);
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = Number(a.lastMessageAt ?? 0) - Number(b.lastMessageAt ?? 0);
    return sortDir === 'asc' ? cmp : -cmp;
  }

  function paintSortHeaders(): void {
    table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach(header => {
      const active = header.dataset.sort === sortKey;
      header.classList.toggle('sorted', active);
      header.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      const label = header.dataset.label ?? header.textContent?.trim() ?? '';
      header.textContent = active ? `${label} ${sortDir === 'asc' ? '▲' : '▼'}` : label;
    });
  }

  function syncBulkUi(rows: any[]): void {
    bulkBar.hidden = selected.size === 0;
    bulkCountSpan.textContent = t('sessions.selectedCount', { count: selected.size });
    const selectable = rows.filter(r => r.status !== 'closed');
    if (selectable.length === 0) {
      selectAllBox.checked = false;
      selectAllBox.indeterminate = false;
      selectAllBox.disabled = true;
      return;
    }
    selectAllBox.disabled = false;
    const selectedInView = selectable.filter(r => selected.has(r.sessionId)).length;
    selectAllBox.checked = selectedInView === selectable.length;
    selectAllBox.indeterminate = selectedInView > 0 && selectedInView < selectable.length;
  }

  function rerender(): void {
    const rows = filtered();
    for (const sid of [...selected]) {
      const s = store.sessions.get(sid);
      if (!s || s.status === 'closed') selected.delete(sid);
    }
    tbody.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : `<tr><td colspan="10" class="empty">${t('sessions.empty')}</td></tr>`;
    paintSortHeaders();
    syncBulkUi(rows);
  }

  function openDrawer(s: any): void {
    const closed = s.status === 'closed';
    drawer.innerHTML = `<article>
      <header>
        <h3>${escapeHtml(s.title ?? s.sessionId)}</h3>
        <span class="status status-${escapeHtml(s.status ?? 'unknown')}">${escapeHtml(s.status ?? 'unknown')}</span>
        <p><code>${escapeHtml(s.sessionId)}</code> <button data-copy="${escapeHtml(s.sessionId)}">${t('sessions.copy')}</button></p>
      </header>
      <p><b>${t('sessions.bot')}:</b> ${escapeHtml(s.botName ?? '-')} · <b>${t('sessions.cli')}:</b> ${escapeHtml(s.cliId ?? '?')}</p>
      <p><b>chatId:</b> <code>${escapeHtml(s.chatId ?? '')}</code> <button data-copy="${escapeHtml(s.chatId ?? '')}">${t('sessions.copy')}</button></p>
      <p><b>rootMessageId:</b> <code>${escapeHtml(s.rootMessageId ?? '')}</code> <button data-copy="${escapeHtml(s.rootMessageId ?? '')}">${t('sessions.copy')}</button></p>
      ${s.threadId ? `<p><b>threadId:</b> <code>${escapeHtml(s.threadId)}</code></p>` : ''}
      <p><b>${t('sessions.workingDir')}:</b> ${escapeHtml(s.workingDir ?? '-')}</p>
      <div class="actions">
        <button id="locate-btn" type="button">${t('sessions.locate')}</button>
        ${s.webPort ? `<a class="btn-link primary" href="http://${escapeHtml(location.hostname)}:${s.proxyPort ?? s.webPort}${s.proxyPort ? `/s/${encodeURIComponent(s.sessionId)}` : ''}" target="_blank" rel="noopener">${t('sessions.openTerminal')}</a>` : ''}
        ${closed ? `<button id="resume-btn" type="button" class="primary">${t('sessions.resume')}</button>` : ''}
        ${!closed ? `<button id="close-btn" type="button" class="contrast">${t('sessions.close')}</button>` : ''}
      </div>
      <form method="dialog"><button>${t('sessions.dismiss')}</button></form>
    </article>`;

    drawer.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(btn => {
      btn.onclick = () => {
        navigator.clipboard.writeText(btn.dataset.copy ?? '');
        btn.textContent = t('sessions.copied');
        setTimeout(() => { btn.textContent = t('sessions.copy'); }, 800);
      };
    });

    const locateBtn = drawer.querySelector<HTMLButtonElement>('#locate-btn');
    if (locateBtn) {
      locateBtn.onclick = async () => {
        locateBtn.disabled = true;
        locateBtn.textContent = t('sessions.locating');
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/locate`, { method: 'POST' });
          const body = await r.json();
          if (body.ok) {
            let left = 30;
            locateBtn.textContent = t('sessions.cooldown', { seconds: left });
            const tick = setInterval(() => {
              left -= 1;
              if (left <= 0) {
                clearInterval(tick);
                locateBtn.disabled = false;
                locateBtn.textContent = t('sessions.locate');
              } else {
                locateBtn.textContent = t('sessions.cooldown', { seconds: left });
              }
            }, 1000);
          } else {
            alert(`Locate failed: ${body.error ?? r.status}`);
            locateBtn.disabled = false;
            locateBtn.textContent = t('sessions.locate');
          }
        } catch (e) {
          alert(`Locate error: ${e}`);
          locateBtn.disabled = false;
          locateBtn.textContent = t('sessions.locate');
        }
      };
    }

    const resumeBtn = drawer.querySelector<HTMLButtonElement>('#resume-btn');
    if (resumeBtn) {
      resumeBtn.onclick = async () => {
        resumeBtn.disabled = true;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/resume`, { method: 'POST' });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body.ok === false) {
            alert(`${t('sessions.resumeFailed')}: ${body?.error ?? r.status}`);
            resumeBtn.disabled = false;
            return;
          }
          drawer.close();
        } catch (e) {
          alert(`${t('sessions.resumeFailed')}: ${e}`);
          resumeBtn.disabled = false;
        }
      };
    }

    const closeBtn = drawer.querySelector<HTMLButtonElement>('#close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        if (!confirm(t('sessions.closeConfirm'))) return;
        closeBtn.disabled = true;
        try {
          await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/close`, { method: 'POST' });
        } finally {
          drawer.close();
        }
      };
    }

    drawer.showModal();
  }

  tbody.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('row-select')) {
      const tr = target.closest<HTMLTableRowElement>('tr[data-id]');
      if (!tr) return;
      const cb = target as HTMLInputElement;
      if (cb.checked) selected.add(tr.dataset.id!);
      else selected.delete(tr.dataset.id!);
      syncBulkUi(filtered());
      return;
    }
    const td = target.closest<HTMLTableCellElement>('td');
    if (td && td.querySelector('.row-select')) return;
    const tr = target.closest<HTMLTableRowElement>('tr[data-id]');
    if (!tr) return;
    const s = store.sessions.get(tr.dataset.id!);
    if (s) openDrawer(s);
  });

  selectAllBox.addEventListener('change', () => {
    const rows = filtered().filter(r => r.status !== 'closed');
    for (const row of rows) {
      if (selectAllBox.checked) selected.add(row.sessionId);
      else selected.delete(row.sessionId);
    }
    rerender();
  });

  bulkClearBtn.addEventListener('click', () => {
    selected.clear();
    rerender();
  });

  bulkCloseBtn.addEventListener('click', async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(t('sessions.closeBulkConfirm', { count: ids.length }))) return;
    bulkCloseBtn.disabled = true;
    bulkClearBtn.disabled = true;
    const original = bulkCloseBtn.textContent;
    let done = 0;
    let failed = 0;
    const queue = [...ids];
    bulkCloseBtn.textContent = `0/${ids.length}`;
    async function worker() {
      while (queue.length) {
        const sid = queue.shift()!;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/close`, { method: 'POST' });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body?.ok === false) failed += 1;
        } catch {
          failed += 1;
        } finally {
          done += 1;
          bulkCloseBtn.textContent = `${done}/${ids.length}`;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => worker()));
    bulkCloseBtn.textContent = original;
    bulkCloseBtn.disabled = false;
    bulkClearBtn.disabled = false;
    selected.clear();
    rerender();
    if (failed > 0) alert(`Failed: ${failed}/${ids.length}`);
  });

  table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      const key = header.dataset.sort!;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else {
        sortKey = key;
        sortDir = key === 'spawnedAt' || key === 'lastMessageAt' ? 'desc' : 'asc';
      }
      rerender();
    });
  });

  filtersForm.addEventListener('input', rerender);
  store.on(rerender);
  rerender();
}
