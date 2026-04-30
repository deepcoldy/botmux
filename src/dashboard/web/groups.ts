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
  <button type="button" id="g-create">+ Create new group</button>
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

  const createBtn = root.querySelector<HTMLButtonElement>('#g-create')!;
  createBtn.onclick = () => openCreateModal();

  await loadGroups();

  function openCreateModal() {
    const allBots = cache.bots;
    if (allBots.length === 0) {
      alert('No bots online. Restart the daemon first.');
      return;
    }
    drawer.innerHTML = `
      <article>
        <header><h3>Create new group</h3></header>
        <p>Pick bots to invite. The dashboard auto-selects an online daemon as the chat creator/owner; the rest are added as members in the same call.</p>
        <form id="g-createform">
          <label class="form-row">
            <span>Group name <small>(optional)</small></span>
            <input type="text" name="name" placeholder="e.g. AI ChangeLog" maxlength="60">
          </label>
          <fieldset>
            <legend>Bots</legend>
            ${allBots.map((b: any) => `
              <label class="checkbox-row">
                <input type="checkbox" name="bot" value="${escapeHtml(b.larkAppId)}">
                ${escapeHtml(b.botName ?? b.larkAppId)} <small>(${escapeHtml(b.larkAppId)})</small>
              </label>
            `).join('')}
          </fieldset>
          <div class="actions">
            <button type="submit">Create</button>
            <button type="button" id="g-create-cancel">Cancel</button>
          </div>
        </form>
      </article>`;
    drawer.showModal();

    drawer.querySelector<HTMLButtonElement>('#g-create-cancel')!.onclick = () => drawer.close();

    drawer.querySelector<HTMLFormElement>('#g-createform')!.onsubmit = async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      const name = ((fd.get('name') as string) ?? '').trim();
      const ids = fd.getAll('bot') as string[];
      if (ids.length === 0) { alert('Pick at least one bot.'); return; }
      const submitBtn = (ev.target as HTMLFormElement).querySelector<HTMLButtonElement>('button[type=submit]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating...'; }
      try {
        const r = await fetch('/api/groups/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name || undefined, larkAppIds: ids }),
        });
        const respBody = await r.json();
        if (respBody.ok && respBody.chatId) {
          renderCreateSuccess(respBody);
          // Refresh matrix in the background so the new chat eventually shows
          // up — won't block the success drawer.
          void loadGroups().then(rerender).catch(() => { /* tolerate */ });
        } else {
          alert(`Failed: ${respBody.error ?? r.status}`);
          drawer.close();
        }
      } catch (e) {
        alert('Network error: ' + e);
        drawer.close();
      }
    };
  }

  function renderCreateSuccess(resp: any) {
    const chatId = String(resp.chatId);
    const appLink = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
    const invalidBots = (resp.invalidBotIds ?? []) as string[];
    const invalidUsers = (resp.invalidUserIds ?? []) as string[];
    const auto = resp.autoInvitedOpenId as string | null | undefined;
    const rejected = !!resp.autoInviteRejected;
    const ownerTo = resp.ownerTransferredTo as string | null | undefined;
    const transferErr = resp.transferError as string | null | undefined;
    let inviteNote: string;
    if (auto) {
      const transferLine = ownerTo
        ? `<br><small>群主已从机器人转让给你。</small>`
        : transferErr
          ? `<br><small class="hint-warn-inline">⚠ 自动转让群主失败（${escapeHtml(transferErr)}），你现在是成员但群主仍是机器人。</small>`
          : '';
      inviteNote = `<p class="hint-ok">已自动邀请你（<code>${escapeHtml(auto)}</code>）作为成员，新群应该会出现在你的飞书侧边栏。${transferLine}</p>`;
    } else if (rejected) {
      inviteNote = `<p class="hint-warn">飞书拒绝了自动邀请（你的 open_id 在创建者 bot 的 scope 下不可用）。<strong>你目前不是新群成员</strong>，需要让群里的某个机器人手动把你加进来。</p>`;
    } else {
      inviteNote = `<p class="hint-warn">没在 dashboard 缓存里找到 ownerOpenId，<strong>没有自动邀请你</strong>。点开下面链接前，先让群里任一机器人手动把你加进去。</p>`;
    }
    const invalidNote = [
      invalidBots.length ? `<li>无效 bot id: <code>${invalidBots.map(escapeHtml).join(', ')}</code></li>` : '',
      invalidUsers.length ? `<li>无效用户 open_id: <code>${invalidUsers.map(escapeHtml).join(', ')}</code></li>` : '',
    ].filter(Boolean).join('');

    drawer.innerHTML = `
      <article>
        <header><h3>群创建成功</h3></header>
        <p><b>chatId:</b> <code>${escapeHtml(chatId)}</code> <button type="button" data-copy="${escapeHtml(chatId)}">copy</button></p>
        <p><b>创建者:</b> <code>${escapeHtml(resp.creator ?? '?')}</code></p>
        ${inviteNote}
        ${invalidNote ? `<ul>${invalidNote}</ul>` : ''}
        <div class="actions">
          <a class="btn-link primary" href="${appLink}" target="_blank" rel="noopener">↗ 打开新群</a>
          <button type="button" id="g-create-close">关闭</button>
        </div>
      </article>`;

    drawer.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.copy ?? '');
        b.textContent = 'copied';
        setTimeout(() => { b.textContent = 'copy'; }, 800);
      };
    });
    drawer.querySelector<HTMLButtonElement>('#g-create-close')!.onclick = () => drawer.close();
  }

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
