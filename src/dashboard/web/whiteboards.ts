import { escapeHtml } from './ui.js';

interface WhiteboardRow {
  id: string;
  title: string;
  scope: string;
  larkAppId?: string;
  chatId?: string;
  workingDir?: string;
  updatedAt: string;
  path: string;
  preview: string;
  logCount: number;
}

function rel(ts: string): string {
  const t = Date.parse(ts);
  if (!t) return ts || '-';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pageHtml(enabled: boolean, rows: WhiteboardRow[], selected?: { id: string; content: string }): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">Whiteboards</p>
        <h1>本地白板</h1>
        <p>项目级本地上下文与跨 agent 交接记录。开关关闭时仅只读展示历史白板，不注入 prompt、不允许 agent CLI 读写。</p>
      </div>
      <span class="pill ${enabled ? 'ok' : 'warn'}">${enabled ? 'Enabled' : 'Disabled'}</span>
    </div>
    ${enabled ? '' : '<p class="hint-warn">白板能力当前关闭：不会自动创建/绑定白板，也不会注入到 agent prompt。历史白板仅在 dashboard 中只读可见。</p>'}
    <div class="settings-grid">
      <article class="bd-card settings-card">
        <h3 class="bd-section-title">白板列表</h3>
        ${rows.length === 0 ? '<p class="empty">暂无白板。打开能力后，首次需要白板时才会创建默认白板。</p>' : rows.map(r => `
          <a class="wb-row" href="#/whiteboards/${encodeURIComponent(r.id)}" style="display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0;background:var(--surface-2,#fff)">
            <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
              <strong>${escapeHtml(r.title || r.id)}</strong>
              <code>${escapeHtml(r.id)}</code>
            </div>
            <div style="margin-top:6px;color:var(--muted);font-size:12px">${escapeHtml(r.scope)} · ${escapeHtml(r.workingDir || r.chatId || '-')} · ${escapeHtml(rel(r.updatedAt))} · log ${r.logCount}</div>
            ${r.preview ? `<pre style="white-space:pre-wrap;max-height:72px;overflow:hidden;margin:8px 0 0;color:var(--muted);font-size:12px">${escapeHtml(r.preview)}</pre>` : ''}
          </a>`).join('')}
      </article>
      <article class="bd-card settings-card">
        <h3 class="bd-section-title">内容预览</h3>
        ${selected ? `<p><code>${escapeHtml(selected.id)}</code></p><pre style="white-space:pre-wrap;max-height:70vh;overflow:auto">${escapeHtml(selected.content)}</pre>` : '<p class="empty">选择左侧白板查看 board.md。</p>'}
      </article>
    </div>
  </section>`;
}

export async function renderWhiteboardsPage(root: HTMLElement): Promise<void> {
  root.innerHTML = '<p class="empty">Loading whiteboards…</p>';
  const selectedId = decodeURIComponent((location.hash.match(/^#\/whiteboards\/([^/]+)/)?.[1] ?? '').trim());
  try {
    const r = await fetch('/api/whiteboards');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    let selected: { id: string; content: string } | undefined;
    if (selectedId) {
      const sr = await fetch(`/api/whiteboards/${encodeURIComponent(selectedId)}`);
      const sb = await sr.json().catch(() => ({}));
      if (sr.ok) selected = { id: selectedId, content: String(sb.content ?? '') };
    }
    root.innerHTML = pageHtml(body.enabled === true, Array.isArray(body.whiteboards) ? body.whiteboards : [], selected);
  } catch (err: any) {
    root.innerHTML = `<section class="page"><p class="hint-warn">加载白板失败：${escapeHtml(err?.message ?? String(err))}</p></section>`;
  }
}
