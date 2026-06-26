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

interface GroupRow { chatId?: string; name?: string }
interface SelectedBoard { id: string; content: string; row?: WhiteboardRow }

type GroupNameMap = Map<string, string>;

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

function groupKey(r: WhiteboardRow): string {
  return r.chatId?.trim() || '__local__';
}

function groupLabel(chatId: string, names: GroupNameMap): string {
  if (chatId === '__local__') return '未绑定群 / 本地白板';
  const name = names.get(chatId);
  return name && name !== chatId ? `${name} (${chatId})` : chatId;
}

function groupedRows(rows: WhiteboardRow[], names: GroupNameMap): Array<{ chatId: string; label: string; rows: WhiteboardRow[] }> {
  const map = new Map<string, WhiteboardRow[]>();
  for (const r of rows) {
    const key = groupKey(r);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([chatId, list]) => ({
      chatId,
      label: groupLabel(chatId, names),
      rows: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function itemStyle(active: boolean): string {
  return `display:block;text-decoration:none;color:inherit;border:1px solid ${active ? 'rgba(14,165,233,.75)' : 'var(--border)'};border-radius:14px;padding:13px 14px;margin:10px 0 10px 18px;background:${active ? 'linear-gradient(135deg, rgba(14,165,233,.16), rgba(59,130,246,.08))' : 'var(--surface-raised)'};box-shadow:${active ? '0 10px 24px rgba(14,165,233,.13)' : '0 4px 14px rgba(15,23,42,.04)'}`;
}

function boardItem(r: WhiteboardRow, selectedId?: string): string {
  const active = r.id === selectedId;
  return `<a class="wb-item${active ? ' active' : ''}" data-whiteboard-id="${escapeHtml(r.id)}" href="#/whiteboards/${encodeURIComponent(r.id)}" style="${itemStyle(active)}">
    <div style="display:flex;gap:8px;align-items:flex-start;justify-content:space-between">
      <div style="min-width:0">
        <strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.title || r.id)}</strong>
        <span style="display:inline-block;margin-top:4px;font-size:11px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(r.id)}</span>
      </div>
      <span style="font-size:11px;border:1px solid var(--border);border-radius:999px;padding:2px 7px;color:var(--muted);white-space:nowrap">${escapeHtml(r.scope)}</span>
    </div>
    <div style="margin-top:9px;display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px"><span>${escapeHtml(rel(r.updatedAt))}</span><span>·</span><span>log ${r.logCount}</span></div>
  </a>`;
}

function deleteModalHtml(selected: SelectedBoard): string {
  const title = selected.row?.title || selected.id;
  return `<div class="wb-delete-backdrop" data-delete-modal style="position:fixed;inset:0;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px">
    <div role="dialog" aria-modal="true" aria-labelledby="wb-delete-title" style="width:min(520px,92vw);background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.35);padding:22px 24px">
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div aria-hidden="true" style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:rgba(220,38,38,.14);color:#dc2626;font-weight:800">!</div>
        <div style="min-width:0;flex:1">
          <h3 id="wb-delete-title" style="margin:0 0 8px;font-size:18px">删除白板？</h3>
          <p style="margin:0;color:var(--muted);line-height:1.6">将删除 <strong>${escapeHtml(title)}</strong>（<code>${escapeHtml(selected.id)}</code>）的 board、log、meta，并清理默认绑定和会话引用。此操作不可恢复。</p>
        </div>
      </div>
      <div class="actions" style="display:flex;justify-content:flex-end;gap:10px;margin-top:22px">
        <button type="button" data-delete-cancel>取消</button>
        <button type="button" class="danger" data-delete-confirm>确认删除</button>
      </div>
    </div>
  </div>`;
}

function metaCard(label: string, value: string): string {
  return `<div style="border:1px solid var(--border);border-radius:12px;padding:10px 12px;background:var(--surface-raised);min-width:0">
    <div style="font-size:11px;color:var(--muted);margin-bottom:5px">${escapeHtml(label)}</div>
    <div style="font-size:13px;word-break:break-all">${escapeHtml(value || '-')}</div>
  </div>`;
}

function detailHtml(selected: SelectedBoard | undefined, groupNames: GroupNameMap): string {
  const selectedRow = selected?.row;
  const selectedChat = selectedRow?.chatId ? groupLabel(selectedRow.chatId, groupNames) : '未绑定群 / 本地白板';
  return selected ? `
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px">
      <div style="min-width:0">
        <p class="eyebrow" style="margin:0 0 6px">WHITEBOARD</p>
        <h2 style="margin:0;font-size:22px;line-height:1.25">${escapeHtml(selectedRow?.title || selected.id)}</h2>
        <div style="margin-top:8px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${escapeHtml(selected.id)}</div>
      </div>
      <button type="button" class="danger" data-delete-whiteboard>删除白板</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:18px">
      ${metaCard('所属群', selectedChat)}
      ${metaCard('范围', selectedRow?.scope ?? '-')}
      ${metaCard('最近更新', selectedRow?.updatedAt ? rel(selectedRow.updatedAt) : '-')}
      ${metaCard('来源目录', selectedRow?.workingDir ?? '-')}
    </div>
    <details style="margin-bottom:18px;color:var(--muted)">
      <summary style="cursor:pointer">管理信息 / 文件路径</summary>
      <code style="display:block;margin-top:8px;white-space:pre-wrap;word-break:break-all">${escapeHtml(selectedRow?.path ?? '')}</code>
    </details>
    <section style="border:1px solid var(--border);border-radius:14px;background:var(--surface-raised);overflow:hidden">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <strong>当前状态 board.md</strong><span style="color:var(--muted);font-size:12px">read / update</span>
      </div>
      <pre style="white-space:pre-wrap;max-height:70vh;overflow:auto;margin:0;padding:16px;line-height:1.65;background:transparent">${escapeHtml(selected.content || '（暂无内容）')}</pre>
    </section>` : '<p class="empty">选择左侧白板查看 meta 和 board.md。</p>';
}

function pageHtml(enabled: boolean, rows: WhiteboardRow[], groupNames: GroupNameMap, selected?: SelectedBoard): string {
  const groups = groupedRows(rows, groupNames);
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">Whiteboards</p>
        <h1>本地白板</h1>
        <p>按群共享的本地最新状态白板。开关关闭时仅只读展示历史白板，不注入 prompt、不允许 agent CLI 读写。</p>
      </div>
      <span class="pill ${enabled ? 'ok' : 'warn'}">${enabled ? 'Enabled' : 'Disabled'}</span>
    </div>
    ${enabled ? '' : '<p class="hint-warn">白板能力当前关闭：不会自动创建/绑定白板，也不会注入到 agent prompt。历史白板仅在 dashboard 中只读可见，可在此清理。</p>'}
    <div class="wb-split" style="display:grid;grid-template-columns:minmax(300px,400px) minmax(0,1fr);gap:18px;align-items:start">
      <article class="bd-card settings-card" style="padding:18px">
        <h3 class="bd-section-title" style="margin-bottom:12px">群组 / 白板</h3>
        ${groups.length === 0 ? '<p class="empty">暂无白板。打开能力后，每个群首次需要白板时才会创建默认白板。</p>' : groups.map(g => `
          <details class="wb-group" open style="margin-bottom:14px">
            <summary style="cursor:pointer;font-weight:700;margin:12px 0 8px;display:flex;justify-content:space-between;gap:8px;align-items:center">
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(g.label)}</span><small style="border:1px solid var(--border);border-radius:999px;padding:1px 7px;color:var(--muted)">${g.rows.length}</small>
            </summary>
            ${g.rows.map(r => boardItem(r, selected?.id)).join('')}
          </details>`).join('')}
      </article>
      <article class="bd-card settings-card" id="whiteboard-detail" style="padding:20px 22px">
        ${detailHtml(selected, groupNames)}
      </article>
    </div>
  </section>`;
}

export async function renderWhiteboardsPage(root: HTMLElement): Promise<void> {
  // 同步渲染一个稳定的宿主容器，三次 fetch 落地后只往这个「捕获到的子节点」里
  // 写，绝不回写共享的 #root。这与其它异步页（overview/settings/skills）一致：
  // 若用户在 fetch 期间切走，路由会用下一个页面替换 #root，本 host 随之脱离文档
  // 树，迟到的写入落在已脱离的节点上（不可见），不会把白板的最终渲染状态盖到当前
  // 页面上。快速「白板→他页→白板」也安全：每次渲染各自捕获一个 host，只有最新
  // 那次的 host 仍挂在文档里，旧渲染只会写进自己那个已脱离的 host。
  root.innerHTML = '<div data-whiteboards-host><p class="empty">Loading whiteboards…</p></div>';
  const host = root.querySelector<HTMLElement>('[data-whiteboards-host]');
  if (!host) return;
  const selectedId = decodeURIComponent((location.hash.match(/^#\/whiteboards\/([^/]+)/)?.[1] ?? '').trim());
  try {
    const [whiteboardsRes, groupsRes] = await Promise.all([
      fetch('/api/whiteboards'),
      fetch('/api/groups').catch(() => null),
    ]);
    const body = await whiteboardsRes.json().catch(() => ({}));
    if (!whiteboardsRes.ok) throw new Error(body?.error ?? `HTTP ${whiteboardsRes.status}`);
    const groupNames = await loadGroupNames(groupsRes);
    const rows: WhiteboardRow[] = Array.isArray(body.whiteboards) ? body.whiteboards : [];
    const selected = selectedId ? await loadSelectedBoard(selectedId, rows) : undefined;
    host.innerHTML = pageHtml(body.enabled === true, rows, groupNames, selected);
    wireBoardSelection(host, rows, groupNames);
    wireDelete(host, selectedId);
  } catch (err: any) {
    host.innerHTML = `<section class="page"><p class="hint-warn">加载白板失败：${escapeHtml(err?.message ?? String(err))}</p></section>`;
  }
}

async function loadSelectedBoard(id: string, rows: WhiteboardRow[]): Promise<SelectedBoard | undefined> {
  const sr = await fetch(`/api/whiteboards/${encodeURIComponent(id)}`);
  const sb = await sr.json().catch(() => ({}));
  if (!sr.ok) return undefined;
  return { id, content: String(sb.content ?? ''), row: rows.find(r => r.id === id) };
}

async function loadGroupNames(res: Response | null): Promise<GroupNameMap> {
  const map = new Map<string, string>();
  if (!res?.ok) return map;
  const body = await res.json().catch(() => ({}));
  const chats: GroupRow[] = Array.isArray(body.chats) ? body.chats : [];
  for (const c of chats) {
    if (c.chatId) map.set(String(c.chatId), String(c.name || c.chatId));
  }
  return map;
}

function wireBoardSelection(root: HTMLElement, rows: WhiteboardRow[], groupNames: GroupNameMap): void {
  root.querySelectorAll<HTMLAnchorElement>('.wb-item[data-whiteboard-id]').forEach(a => {
    a.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const id = a.dataset.whiteboardId;
      if (!id) return;
      const selected = await loadSelectedBoard(id, rows);
      if (!selected) return;
      for (const item of root.querySelectorAll<HTMLAnchorElement>('.wb-item[data-whiteboard-id]')) {
        const active = item.dataset.whiteboardId === id;
        item.classList.toggle('active', active);
        item.setAttribute('style', itemStyle(active));
      }
      const detail = root.querySelector<HTMLElement>('#whiteboard-detail');
      if (detail) detail.innerHTML = detailHtml(selected, groupNames);
      window.history.replaceState(null, '', `#/whiteboards/${encodeURIComponent(id)}`);
      wireDelete(root, id);
    });
  });
}

function removeDeletedBoard(root: HTMLElement, selectedId: string): void {
  const item = root.querySelector<HTMLElement>(`.wb-item[data-whiteboard-id="${CSS.escape(selectedId)}"]`);
  const group = item?.closest('details.wb-group') as HTMLDetailsElement | null;
  item?.remove();
  if (group) {
    const remaining = group.querySelectorAll('.wb-item[data-whiteboard-id]').length;
    const count = group.querySelector('summary small');
    if (count) count.textContent = String(remaining);
    if (remaining === 0) group.remove();
  }
  const detail = root.querySelector<HTMLElement>('#whiteboard-detail');
  if (detail) detail.innerHTML = detailHtml(undefined, new Map());
  const anyLeft = root.querySelector('.wb-item[data-whiteboard-id]');
  if (!anyLeft) {
    const list = root.querySelector<HTMLElement>('.wb-split article.bd-card');
    if (list) list.innerHTML = '<h3 class="bd-section-title" style="margin-bottom:12px">群组 / 白板</h3><p class="empty">暂无白板。打开能力后，每个群首次需要白板时才会创建默认白板。</p>';
  }
}

function wireDelete(root: HTMLElement, selectedId: string): void {
  const btn = root.querySelector<HTMLButtonElement>('[data-delete-whiteboard]');
  if (!btn || !selectedId) return;
  btn.addEventListener('click', async () => {
    const row = root.querySelector<HTMLAnchorElement>(`.wb-item[data-whiteboard-id="${CSS.escape(selectedId)}"]`);
    const selected: SelectedBoard = { id: selectedId, content: '', row: row ? { id: selectedId, title: row.querySelector('strong')?.textContent || selectedId, scope: '', updatedAt: '', path: '', preview: '', logCount: 0 } : undefined };
    await confirmDelete(root, selectedId, selected);
  });
}

async function confirmDelete(root: HTMLElement, selectedId: string, selected: SelectedBoard): Promise<void> {
  root.querySelector('[data-delete-modal]')?.remove();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = deleteModalHtml(selected);
  const modal = wrapper.firstElementChild as HTMLElement;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector<HTMLElement>('[data-delete-cancel]')?.addEventListener('click', close);
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  modal.querySelector<HTMLButtonElement>('[data-delete-confirm]')?.addEventListener('click', async () => {
    const confirmBtn = modal.querySelector<HTMLButtonElement>('[data-delete-confirm]');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '删除中…'; }
    try {
      const r = await fetch(`/api/whiteboards/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      close();
      removeDeletedBoard(root, selectedId);
      window.history.replaceState(null, '', '#/whiteboards');
    } catch (err: any) {
      close();
      alert(`删除失败：${err?.message ?? String(err)}`);
    }
  });
}
