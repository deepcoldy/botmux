import { escapeHtml } from './ui.js';

interface DashboardPluginEntry {
  pluginId: string;
  id: string;
  route: string;
  url: string;
  displayName?: string;
}

async function fetchPluginEntries(): Promise<DashboardPluginEntry[]> {
  const res = await fetch('/api/plugins/dashboard');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.plugins) ? body.plugins : [];
}

export async function renderPluginPage(root: HTMLElement): Promise<void> {
  const hash = location.hash || '#/plugins';
  root.innerHTML = `<section class="page"><div class="empty">Loading plugin...</div></section>`;
  const entries = await fetchPluginEntries();
  const entry = entries.find(item => hash === item.route || hash.startsWith(`${item.route}/`) || hash.startsWith(`${item.route}?`));
  if (!entry) {
    root.innerHTML = `<section class="page"><div class="empty">Plugin page not found: ${escapeHtml(hash)}</div></section>`;
    return;
  }
  const title = entry.displayName || entry.pluginId;
  root.innerHTML = `
    <section class="page plugin-page">
      <div class="page-head">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(entry.pluginId)} / ${escapeHtml(entry.id)}</p>
        </div>
      </div>
      <iframe
        title="${escapeHtml(title)}"
        src="${escapeHtml(entry.url)}"
        style="width:100%;height:calc(100vh - 180px);min-height:520px;border:1px solid var(--border);border-radius:8px;background:var(--surface);"
      ></iframe>
    </section>
  `;
}
