import { store } from './store.js';
import { escapeHtml, t } from './ui.js';

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">${t('nav.schedules')}</p>
    <h1>${t('schedules.title')}</h1>
    <p>${t('schedules.subtitle')}</p>
  </div>
</div>
<form id="sched-filters" class="filters">
  <input type="search" name="q" placeholder="${t('schedules.search')}" />
  <select name="kind">
    <option value="">${t('schedules.anyKind')}</option>
    <option>cron</option>
    <option>interval</option>
    <option>once</option>
  </select>
  <label><input type="checkbox" name="enabled"> ${t('schedules.enabledOnly')}</label>
</form>
<table>
  <thead><tr>
    <th>${t('schedules.name')}</th><th>${t('schedules.bot')}</th><th>${t('schedules.schedule')}</th><th>${t('schedules.delivery')}</th><th>${t('schedules.next')}</th><th>${t('schedules.last')}</th>
    <th>${t('schedules.repeat')}</th><th>${t('schedules.enabled')}</th><th>${t('schedules.actions')}</th>
  </tr></thead>
  <tbody id="schedules-tbody"></tbody>
</table>
</section>`;
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch { return s; }
}

export function renderSchedulesPage(root: HTMLElement) {
  root.innerHTML = pageHtml();
  const tbody = root.querySelector<HTMLElement>('#schedules-tbody')!;
  const form = root.querySelector<HTMLFormElement>('#sched-filters')!;

  function filtered(): any[] {
    const f = new FormData(form);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const kind = f.get('kind') as string;
    const enabledOnly = !!f.get('enabled');
    return [...store.schedules.values()]
      .filter(s => !kind || s.parsed?.kind === kind)
      .filter(s => !enabledOnly || s.enabled)
      .filter(s => !q || JSON.stringify(s).toLowerCase().includes(q))
      .sort((a, b) => {
        // enabled first, then earliest nextRunAt
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const aN = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
        const bN = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
        return aN - bN;
      });
  }

  function rerender() {
    tbody.innerHTML = filtered().map(s => `<tr data-id="${escapeHtml(s.id)}">
      <td>${escapeHtml(s.name ?? s.id)}</td>
      <td>${escapeHtml(s.botName ?? s.larkAppId ?? '-')}</td>
      <td><code>${escapeHtml(s.parsed?.display ?? '?')}</code></td>
      <td>${s.deliver === 'new-topic' ? `🆕 ${t('schedules.deliveryNewTopic')}` : s.deliver === 'local' ? `🔕 ${t('schedules.deliveryLocal')}` : t('schedules.deliveryOrigin')}</td>
      <td>${fmtDate(s.nextRunAt)}</td>
      <td>${fmtDate(s.lastRunAt)} ${s.lastStatus === 'error' ? '⚠️' : ''}</td>
      <td>${s.repeat ? `${s.repeat.completed}/${s.repeat.times ?? '∞'}` : '—'}</td>
      <td>${s.enabled ? '✓' : '✗'}</td>
      <td class="actions-cell">
        <button data-op="run" type="button">${t('schedules.runNow')}</button>
        ${s.enabled
          ? `<button data-op="pause" type="button">${t('schedules.pause')}</button>`
          : `<button data-op="resume" type="button">${t('schedules.resume')}</button>`}
        ${s.deliver === 'local'
          ? ''
          : `<button data-op="delivery" type="button">${s.deliver === 'new-topic' ? t('schedules.useOrigin') : t('schedules.useNewTopic')}</button>`}
      </td>
    </tr>`).join('') || `<tr><td colspan="9" class="empty">${t('schedules.empty')}</td></tr>`;
  }

  tbody.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-op]');
    if (!btn) return;
    const tr = btn.closest<HTMLTableRowElement>('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id!;
    const op = btn.dataset.op!;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '...';
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        alert(`Failed: ${r.status} ${body?.error ?? ''}`.trim());
      }
    } catch (err) {
      alert('Network error: ' + err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  form.addEventListener('input', rerender);
  store.on(rerender);
  rerender();
}
