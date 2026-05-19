// Sessions page: filter bar, table, detail drawer with locate (30s cooldown) + close.
import { store } from './store.js';

const PAGE_HTML = `
<form id="filters" class="filters">
  <input type="search" name="q" placeholder="search workingDir / title / ids" />
  <select name="cli" multiple size="4">
    <option value="claude-code">claude-code</option>
    <option value="codex">codex</option>
    <option value="cursor">cursor</option>
    <option value="gemini">gemini</option>
    <option value="opencode">opencode</option>
    <option value="aiden">aiden</option>
    <option value="coco">coco</option>
    <option value="unknown">unknown</option>
  </select>
  <select name="status">
    <option value="">any status</option>
    <option>starting</option><option>working</option>
    <option>idle</option><option>analyzing</option><option>closed</option>
  </select>
  <select name="adopt">
    <option value="">adopt: any</option>
    <option value="yes">adopt: yes</option>
    <option value="no">adopt: no</option>
  </select>
  <label><input type="checkbox" name="active" checked> active only</label>
</form>
<div id="bulk-bar" class="bulk-bar" hidden>
  <span id="bulk-count"></span>
  <button type="button" id="bulk-close" class="contrast">关闭选中</button>
  <button type="button" id="bulk-clear">取消</button>
</div>
<table id="sessions-table">
  <thead><tr>
    <th><input type="checkbox" id="select-all" title="全选当前过滤结果"></th>
    <th data-sort="botName">bot</th><th data-sort="cliId">cli</th><th data-sort="status">status</th><th data-sort="title">title</th><th data-sort="workingDir">workingDir</th>
    <th data-sort="spawnedAt">created</th><th data-sort="lastMessageAt">last</th><th data-sort="adopt">adopt</th><th></th>
  </tr></thead>
  <tbody></tbody>
</table>
<dialog id="drawer"></dialog>
`;

function relTime(ms: number): string {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  return Math.floor(diff / 86_400_000) + 'd';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

const ICON_MIRROR = '\u{1FA9E}';
const ICON_PIN = '\u{1F4CD}';
const ICON_SCREEN = '\u{1F5A5}️';

export function renderSessionsPage(root: HTMLElement) {
  root.innerHTML = PAGE_HTML;
  const tbody = root.querySelector<HTMLElement>('#sessions-table tbody')!;
  const filtersForm = root.querySelector<HTMLFormElement>('#filters')!;
  const drawer = root.querySelector<HTMLDialogElement>('#drawer')!;
  const selectAllBox = root.querySelector<HTMLInputElement>('#select-all')!;
  const bulkBar = root.querySelector<HTMLElement>('#bulk-bar')!;
  const bulkCountSpan = root.querySelector<HTMLElement>('#bulk-count')!;
  const bulkCloseBtn = root.querySelector<HTMLButtonElement>('#bulk-close')!;
  const bulkClearBtn = root.querySelector<HTMLButtonElement>('#bulk-clear')!;
  const table = root.querySelector<HTMLTableElement>('#sessions-table')!;

  // Selection set persists across rerenders (filter changes, SSE updates).
  // Closed/missing sessions get pruned lazily during rerender so the count
  // never overstates active selections.
  const selected = new Set<string>();
  let sortKey = 'lastMessageAt';
  let sortDir: 'asc' | 'desc' = 'desc';

  function rowHtml(s: any) {
    const closed = s.status === 'closed';
    const checked = selected.has(s.sessionId) ? 'checked' : '';
    return `<tr data-id="${escapeHtml(s.sessionId)}">
      <td><input type="checkbox" class="row-select" ${checked} ${closed ? 'disabled' : ''}></td>
      <td>${escapeHtml(s.botName ?? '')}</td>
      <td><span class="badge cli-${escapeHtml(s.cliId ?? 'unknown')}">${escapeHtml(s.cliId ?? 'unknown')}</span></td>
      <td><span class="status status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></td>
      <td>${escapeHtml((s.title ?? '').slice(0, 40))}</td>
      <td title="${escapeHtml(s.workingDir ?? '')}">${escapeHtml((s.workingDir ?? '').slice(-30))}</td>
      <td>${relTime(s.spawnedAt)}</td>
      <td>${relTime(s.lastMessageAt)}</td>
      <td>${s.adopt ? ICON_MIRROR : ''}</td>
      <td><button class="open">⋯</button></td>
    </tr>`;
  }

  function filtered(): any[] {
    const f = new FormData(filtersForm);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const cli = f.getAll('cli') as string[];
    const status = f.get('status') as string;
    const adopt = f.get('adopt') as string;
    const active = !!f.get('active');
    const rows = [...store.sessions.values()]
      .filter(s => !cli.length || cli.includes(s.cliId ?? 'unknown'))
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
    if (cmp === 0) cmp = (Number(a.lastMessageAt ?? 0) - Number(b.lastMessageAt ?? 0));
    return sortDir === 'asc' ? cmp : -cmp;
  }

  function paintSortHeaders() {
    table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach(th => {
      const active = th.dataset.sort === sortKey;
      th.classList.toggle('sorted', active);
      th.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      const label = th.textContent?.replace(/ [▲▼]$/, '').trim() ?? '';
      th.textContent = active ? `${label} ${sortDir === 'asc' ? '▲' : '▼'}` : label;
    });
  }

  function rerender() {
    const rows = filtered();
    // Prune selections whose sessions are no longer present OR are now closed
    // (closed rows are uncheckable; keeping them in `selected` would yield a
    // misleading bulk-bar count that the user can't act on).
    for (const sid of [...selected]) {
      const s = store.sessions.get(sid);
      if (!s || s.status === 'closed') selected.delete(sid);
    }
    tbody.innerHTML = rows.map(rowHtml).join('');
    paintSortHeaders();
    syncBulkUi(rows);
  }

  function syncBulkUi(rows: any[]) {
    const count = selected.size;
    bulkBar.hidden = count === 0;
    bulkCountSpan.textContent = `已选 ${count} 个会话`;
    // header checkbox tri-state: checked when ALL selectable rows in the
    // current filter are selected; indeterminate when partial; unchecked when
    // none. "Selectable" excludes closed rows.
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

  function openDrawer(s: any) {
    const closed = s.status === 'closed';
    drawer.innerHTML = `
      <article>
        <header>
          <h3>${escapeHtml(s.title ?? s.sessionId)}</h3>
          <code>${escapeHtml(s.sessionId)}</code> <button data-copy="${escapeHtml(s.sessionId)}">copy</button>
        </header>
        <p><b>bot:</b> ${escapeHtml(s.botName ?? '-')} · <b>cli:</b> ${escapeHtml(s.cliId ?? '?')} · <b>status:</b> ${escapeHtml(s.status)}</p>
        <p><b>chatId:</b> <code>${escapeHtml(s.chatId)}</code> <button data-copy="${escapeHtml(s.chatId)}">copy</button></p>
        <p><b>rootMessageId:</b> <code>${escapeHtml(s.rootMessageId ?? '')}</code> <button data-copy="${escapeHtml(s.rootMessageId ?? '')}">copy</button></p>
        ${s.threadId ? `<p><b>threadId:</b> <code>${escapeHtml(s.threadId)}</code></p>` : ''}
        <p><b>workingDir:</b> ${escapeHtml(s.workingDir ?? '-')}</p>
        <div class="actions">
          <button id="locate-btn" type="button">${ICON_PIN} 定位到飞书话题</button>
          ${s.webPort ? `<a class="btn-link" href="http://${escapeHtml(location.hostname)}:${s.webPort}" target="_blank">${ICON_SCREEN} 打开 xterm</a>` : ''}
          ${!closed ? `<button id="close-btn" type="button" class="contrast">关闭会话</button>` : ''}
        </div>
        <form method="dialog"><button>关闭</button></form>
      </article>`;

    drawer.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.copy ?? '');
        b.textContent = 'copied';
        setTimeout(() => { b.textContent = 'copy'; }, 800);
      };
    });

    const locateBtn = drawer.querySelector<HTMLButtonElement>('#locate-btn');
    if (locateBtn) {
      locateBtn.onclick = async () => {
        locateBtn.disabled = true;
        locateBtn.textContent = `${ICON_PIN} 发送中...`;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/locate`, { method: 'POST' });
          const body = await r.json();
          if (body.ok) {
            // Daemon posted the @mention into the original thread. The
            // notification is what the user navigates from — no AppLink
            // redirect (the previous "open chat in new tab" behavior was
            // explicitly removed by the user as intrusive).
            let left = 30;
            locateBtn.textContent = `${ICON_PIN} (冷却 ${left}s)`;
            const tick = setInterval(() => {
              left -= 1;
              if (left <= 0) {
                clearInterval(tick);
                locateBtn.disabled = false;
                locateBtn.textContent = `${ICON_PIN} 定位到飞书话题`;
              } else {
                locateBtn.textContent = `${ICON_PIN} (冷却 ${left}s)`;
              }
            }, 1000);
          } else {
            const reason = body.error ?? r.status;
            alert('Locate failed: ' + reason);
            locateBtn.disabled = false;
            locateBtn.textContent = `${ICON_PIN} 定位到飞书话题`;
          }
        } catch (e) {
          alert('Locate error: ' + e);
          locateBtn.disabled = false;
          locateBtn.textContent = `${ICON_PIN} 定位到飞书话题`;
        }
      };
    }

    const closeBtn = drawer.querySelector<HTMLButtonElement>('#close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        if (!confirm('关闭这个会话?')) return;
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
    // Checkbox clicks toggle selection; don't open the drawer.
    if (target.classList.contains('row-select')) {
      const tr = target.closest<HTMLTableRowElement>('tr[data-id]');
      if (!tr) return;
      const sid = tr.dataset.id!;
      const cb = target as HTMLInputElement;
      if (cb.checked) selected.add(sid); else selected.delete(sid);
      syncBulkUi(filtered());
      return;
    }
    // Clicks on the checkbox cell (around the input, not the input itself)
    // shouldn't open the drawer either — that's a fat-finger nuisance.
    const td = target.closest<HTMLTableCellElement>('td');
    if (td && td.querySelector('.row-select')) return;
    const tr = target.closest<HTMLTableRowElement>('tr[data-id]');
    if (!tr) return;
    const sid = tr.dataset.id!;
    const s = store.sessions.get(sid);
    if (s) openDrawer(s);
  });

  selectAllBox.addEventListener('change', () => {
    const rows = filtered().filter(r => r.status !== 'closed');
    if (selectAllBox.checked) {
      for (const r of rows) selected.add(r.sessionId);
    } else {
      for (const r of rows) selected.delete(r.sessionId);
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
    if (!confirm(`关闭选中的 ${ids.length} 个会话？`)) return;
    bulkCloseBtn.disabled = true;
    bulkClearBtn.disabled = true;
    const orig = bulkCloseBtn.textContent;
    let done = 0;
    let failed = 0;
    const failures: string[] = [];
    bulkCloseBtn.textContent = `关闭中 0/${ids.length}...`;
    // Concurrency cap: 6 in flight at once. Daemon close is cheap but we don't
    // want to overwhelm the dashboard or hit per-bot Lark rate limits.
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const sid = queue.shift()!;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/close`, { method: 'POST' });
          // closeSession always returns { ok: true } today, but treat
          // non-ok-body as failure too so future server changes that surface
          // partial errors via 200 + { ok: false } are accounted for.
          let body: any = null;
          try { body = await r.json(); } catch { /* tolerate non-JSON */ }
          if (!r.ok || body?.ok === false) {
            failed += 1;
            const reason = body?.error ?? `HTTP ${r.status}`;
            failures.push(`${sid.slice(0, 12)}…: ${reason}`);
          }
        } catch (e: any) {
          failed += 1;
          failures.push(`${sid.slice(0, 12)}…: ${e?.message ?? e}`);
        } finally {
          done += 1;
          bulkCloseBtn.textContent = `关闭中 ${done}/${ids.length}...`;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => worker()));
    bulkCloseBtn.textContent = orig;
    bulkCloseBtn.disabled = false;
    bulkClearBtn.disabled = false;
    selected.clear();
    rerender();
    if (failed > 0) {
      const head = failures.slice(0, 3).join('\n');
      const more = failures.length > 3 ? `\n... +${failures.length - 3} 个` : '';
      alert(`关闭完成：成功 ${ids.length - failed} / 失败 ${failed}\n${head}${more}`);
    }
  });

  table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort!;
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
