// Groups & Bots page: chat × bot membership matrix + add-bots modal.
// The aggregator at /api/groups fans out to all online daemons and merges chats
// by chatId; the dashboard displays this as a matrix where each cell shows
// whether a bot is a member of a given chat.

let cache: { chats: any[]; bots: any[] } = { chats: [], bots: [] };

const PAGE_HTML = `
<form id="g-filters" class="filters">
  <input type="search" name="q" placeholder="search chat name / id / owner" />
  <label><input type="checkbox" name="missing"> missing-bot only</label>
  <button type="button" id="g-refresh">Refresh</button>
</form>
<table>
  <thead id="g-head"></thead>
  <tbody id="g-body"></tbody>
</table>
<dialog id="g-drawer"></dialog>
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

async function loadGroups(): Promise<void> {
  const r = await fetch('/api/groups');
  cache = await r.json();
}

export async function renderGroupsPage(root: HTMLElement) {
  root.innerHTML = PAGE_HTML;
  const head = root.querySelector<HTMLElement>('#g-head')!;
  const body = root.querySelector<HTMLElement>('#g-body')!;
  const form = root.querySelector<HTMLFormElement>('#g-filters')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#g-refresh')!;
  const drawer = root.querySelector<HTMLDialogElement>('#g-drawer')!;

  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    try { await loadGroups(); rerender(); } finally { refreshBtn.disabled = false; }
  };

  await loadGroups();

  function renderHead() {
    head.innerHTML = `<tr>
      <th>chat</th>
      ${cache.bots.map(b => `<th>${escapeHtml(b.botName ?? b.larkAppId)}</th>`).join('')}
      <th>actions</th>
    </tr>`;
  }

  function rerender() {
    renderHead();
    const f = new FormData(form);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const onlyMissing = !!f.get('missing');

    const filtered = cache.chats
      .filter(c => !q ||
        (c.name ?? '').toLowerCase().includes(q) ||
        c.chatId.toLowerCase().includes(q) ||
        (c.ownerId ?? '').toLowerCase().includes(q)
      )
      .filter(c => !onlyMissing || c.memberBots.some((m: any) => !m.inChat));

    if (filtered.length === 0) {
      body.innerHTML = `<tr><td colspan="${cache.bots.length + 2}" class="empty">No chats match the filter.</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(c => `<tr data-chat="${escapeHtml(c.chatId)}">
      <td>
        <strong>${escapeHtml(c.name ?? c.chatId)}</strong><br>
        <small><code>${escapeHtml(c.chatId)}</code></small>
      </td>
      ${cache.bots.map(b => {
        const m = c.memberBots.find((m: any) => m.larkAppId === b.larkAppId);
        const cell = !m ? '?' : m.error ? '!' : m.inChat ? '✓' : '✗';
        const cls = !m ? 'cell-unknown' : m.error ? 'cell-error' : m.inChat ? 'cell-in' : 'cell-out';
        return `<td class="${cls}" title="${escapeHtml(m?.error ?? '')}">${cell}</td>`;
      }).join('')}
      <td><button class="add-bots" type="button">Add bots</button></td>
    </tr>`).join('');
  }
  rerender();

  body.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.add-bots');
    if (!btn) return;
    const tr = btn.closest<HTMLTableRowElement>('tr[data-chat]')!;
    const chatId = tr.dataset.chat!;
    const chat = cache.chats.find(c => c.chatId === chatId);
    if (!chat) return;
    const missing = chat.memberBots.filter((m: any) => !m.inChat);
    if (!missing.length) {
      alert('All configured bots are already in this chat.');
      return;
    }
    drawer.innerHTML = `
      <article>
        <header><h3>Add bots to ${escapeHtml(chat.name ?? chat.chatId)}</h3></header>
        <p>Select bots to add. The dashboard will pick a bot that's already in the chat as the proxy.</p>
        <form id="g-addform">
          ${missing.map((m: any) => `
            <label class="checkbox-row">
              <input type="checkbox" name="bot" value="${escapeHtml(m.larkAppId)}">
              ${escapeHtml(m.botName ?? m.larkAppId)} <small>(${escapeHtml(m.larkAppId)})</small>
            </label>
          `).join('')}
          <div class="actions">
            <button type="submit">Confirm add</button>
            <button type="button" id="g-cancel">Cancel</button>
          </div>
        </form>
      </article>`;
    drawer.showModal();

    drawer.querySelector<HTMLButtonElement>('#g-cancel')!.onclick = () => drawer.close();

    drawer.querySelector<HTMLFormElement>('#g-addform')!.onsubmit = async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      const ids = fd.getAll('bot') as string[];
      if (ids.length === 0) { alert('Pick at least one bot.'); return; }
      try {
        const r = await fetch(`/api/groups/${encodeURIComponent(chatId)}/add-bots`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ larkAppIds: ids }),
        });
        const respBody = await r.json();
        if (respBody.error === 'no_proxy_bot') {
          alert('No bot is currently in this chat — add one manually in Feishu first, then retry.');
        } else if (respBody.result) {
          const lines = respBody.result.map((x: any) =>
            `${x.id}: ${x.ok ? 'OK' : `failed (${x.error ?? 'unknown'})`}`
          ).join('\n');
          alert(lines);
          // Refresh after change
          await loadGroups();
          rerender();
        } else {
          alert(`Unexpected response: ${JSON.stringify(respBody)}`);
        }
      } catch (e) {
        alert('Network error: ' + e);
      } finally {
        drawer.close();
      }
    };
  });

  form.addEventListener('input', rerender);
}
