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

/** Fetch /api/groups once and return the parsed payload without mutating
 *  `cache` — used by refreshUntilSeen so we can decide whether to commit. */
async function fetchGroups(): Promise<{ chats: any[]; bots: any[] }> {
  const r = await fetch('/api/groups');
  return r.json();
}

/** True iff every expected bot id appears in the row's memberBots with
 *  inChat:true. Used by refreshUntilSeen to defer committing a canonical
 *  snapshot until all invited bots have caught up Lark-side. Exported so
 *  tests can exercise the predicate without spinning up jsdom. */
export function allExpectedInChat(row: any, expectedBotIds: Set<string>): boolean {
  if (expectedBotIds.size === 0) return true;
  const members = (row?.memberBots ?? []) as Array<{ larkAppId: string; inChat: boolean }>;
  for (const id of expectedBotIds) {
    if (!members.some(m => m.larkAppId === id && m.inChat)) return false;
  }
  return true;
}

/** Render the bot-picker checkboxes shared by "Create new group" and
 *  "Add bots". Always iterates `bots` in its given order (the aggregator
 *  hands cache.bots back sorted by botIndex), so both modals show the
 *  same order. `excludeIds` removes bots that are already in the chat
 *  for the Add-bots flow. Exported for tests. */
export function renderBotCheckboxes(
  bots: Array<{ larkAppId: string; botName?: string }>,
  excludeIds?: Set<string>,
): string {
  return bots
    .filter(b => !excludeIds || !excludeIds.has(b.larkAppId))
    .map(b => `
      <label class="checkbox-row">
        <input type="checkbox" name="bot" value="${escapeHtml(b.larkAppId)}">
        ${escapeHtml(b.botName ?? b.larkAppId)} <small>(${escapeHtml(b.larkAppId)})</small>
      </label>
    `).join('');
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
            ${renderBotCheckboxes(allBots)}
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
          // Lark's chat.list has eventual consistency: the chat we just
          // created via /api/groups/create often doesn't appear in the next
          // /api/groups response for a few seconds. Without intervention the
          // background refresh would overwrite cache with a stale snapshot
          // and the new group would silently vanish from the matrix until
          // the user hit Refresh manually.
          //
          // Optimistic insert: render the new group instantly using the
          // creator's larkAppId + the form's selected bot ids minus any
          // invalidBotIds Lark rejected. The refresh poll below keeps
          // re-fetching until Lark confirms ALL expected bots show inChat,
          // then commits the canonical response; until then we keep the
          // optimistic row. Stopping on first sight of just `chatId` would
          // commit a partial-membership snapshot — see Codex review.
          const invalidBotIds: string[] = Array.isArray(respBody.invalidBotIds) ? respBody.invalidBotIds : [];
          const validIds = ids.filter(id => !invalidBotIds.includes(id));
          const expectedBotIds = new Set<string>(validIds);
          if (typeof respBody.creator === 'string' && respBody.creator) expectedBotIds.add(respBody.creator);
          injectOptimisticChat(respBody.chatId, name || respBody.chatId, validIds, respBody.creator);
          rerender();
          void refreshUntilSeen(respBody.chatId, expectedBotIds).catch(() => { /* tolerate */ });
        } else {
          alert(`Failed: ${respBody.error ?? r.status}`);
          drawer.close();
        }
      } catch (e) {
        alert('Network error: ' + e);
        drawer.close();
      }
    };

    function injectOptimisticChat(
      chatId: string,
      displayName: string,
      memberIds: string[],
      creator: string | undefined,
    ): void {
      const inChatSet = new Set(memberIds);
      if (creator) inChatSet.add(creator);
      const memberBots = cache.bots.map((b: any) => ({
        larkAppId: b.larkAppId,
        botName: b.botName,
        inChat: inChatSet.has(b.larkAppId),
        oncallChat: null,
      }));
      const optimistic = {
        chatId,
        name: displayName,
        ownerId: creator ?? null,
        memberBots,
      };
      // Drop any duplicate (defensive — shouldn't fire, but cheap) and
      // prepend so the new row lands at the top of the matrix.
      cache.chats = [optimistic, ...cache.chats.filter((c: any) => c.chatId !== chatId)];
    }

    async function refreshUntilSeen(chatId: string, expectedBotIds: Set<string>): Promise<void> {
      // Total budget ≈ 0.6 + 5*1.2 = ~6.6s. Commit only when the row is
      // present AND every expected bot reports inChat:true — otherwise we'd
      // overwrite our optimistic ✓ marks with a partial canonical snapshot
      // (creator daemon often lags vs. invitee daemons on Lark's side).
      // If the budget runs out the optimistic row stays put; next manual
      // Refresh will reconcile.
      const delays = [600, 1200, 1200, 1200, 1200, 1200];
      for (const d of delays) {
        await new Promise(r => setTimeout(r, d));
        let next: { chats: any[]; bots: any[] };
        try { next = await fetchGroups(); }
        catch { continue; }
        const row = (next.chats ?? []).find((c: any) => c.chatId === chatId);
        if (row && allExpectedInChat(row, expectedBotIds)) {
          cache = next;
          rerender();
          return;
        }
      }
    }
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
    const notifyMsgId = resp.notifyMessageId as string | null | undefined;
    const notifyErr = resp.notifyError as string | null | undefined;
    let inviteNote: string;
    if (auto) {
      const transferLine = ownerTo
        ? `<br><small>群主已从机器人转让给你。</small>`
        : transferErr
          ? `<br><small class="hint-warn-inline">⚠ 自动转让群主失败（${escapeHtml(transferErr)}），你现在是成员但群主仍是机器人。</small>`
          : '';
      const notifyLine = notifyMsgId
        ? `<br><small>机器人已在群里 @ 了你（消息 id <code>${escapeHtml(notifyMsgId)}</code>），看飞书通知就能进群。</small>`
        : notifyErr
          ? `<br><small class="hint-warn-inline">⚠ 自动 @ 通知失败（${escapeHtml(notifyErr)}），新群可能不会主动出现在你侧边栏，建议从下面按钮跳进去。</small>`
          : '';
      inviteNote = `<p class="hint-ok">已自动邀请你（<code>${escapeHtml(auto)}</code>）作为成员。${transferLine}${notifyLine}</p>`;
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
      <td>
        <button class="add-bots" type="button">Add bots</button>
        <button class="manage-chat" type="button">Manage</button>
      </td>
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
    // Iterate cache.bots (botIndex-sorted by the aggregator) so this modal's
    // order matches "Create new group" exactly. memberBots is only used to
    // compute which bots to hide as already-in-chat.
    const inChatSet = new Set<string>(
      chat.memberBots.filter((m: any) => m.inChat).map((m: any) => m.larkAppId),
    );
    const missing = cache.bots.filter((b: any) => !inChatSet.has(b.larkAppId));
    if (!missing.length) {
      alert('All configured bots are already in this chat.');
      return;
    }
    drawer.innerHTML = `
      <article>
        <header><h3>Add bots to ${escapeHtml(chat.name ?? chat.chatId)}</h3></header>
        <p>Select bots to add. The dashboard will pick a bot that's already in the chat as the proxy.</p>
        <form id="g-addform">
          ${renderBotCheckboxes(cache.bots, inChatSet)}
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

  body.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.manage-chat');
    if (!btn) return;
    const tr = btn.closest<HTMLTableRowElement>('tr[data-chat]')!;
    const chatId = tr.dataset.chat!;
    const chat = cache.chats.find(c => c.chatId === chatId);
    if (!chat) return;
    openManageDrawer(chat);
  });

  function openManageDrawer(chat: any) {
    const inChat = chat.memberBots.filter((m: any) => m.inChat) as any[];
    // Lark `owner_id` returns app_id format for bot owners (string match works).
    // For user owners it'll be an open_id which won't match any larkAppId.
    const ownerAppId = typeof chat.ownerId === 'string' ? chat.ownerId : '';
    drawer.innerHTML = `
      <article>
        <header><h3>Manage ${escapeHtml(chat.name ?? chat.chatId)}</h3></header>
        <p><b>chatId:</b> <code>${escapeHtml(chat.chatId)}</code></p>
        <p><b>owner:</b> <code>${escapeHtml(chat.ownerId ?? '(unknown)')}</code></p>

        <fieldset>
          <legend>Oncall 模式</legend>
          <p><small>开启后：群内任何成员都能 @ 机器人提问，新话题直接用绑定目录启动 CLI；仅 allowedUsers 仍可执行 /cd /restart 等命令。</small></p>
          ${inChat.length === 0
            ? `<p class="empty">没有机器人在群里</p>`
            : inChat.map((m: any) => {
              const enabled = !!m.oncallChat;
              const wd = m.oncallChat?.workingDir ?? '';
              return `
                <div class="oncall-row" data-bot="${escapeHtml(m.larkAppId)}">
                  <label class="checkbox-row">
                    <input type="checkbox" data-action="toggle" ${enabled ? 'checked' : ''}>
                    <strong>${escapeHtml(m.botName ?? m.larkAppId)}</strong>
                    <small>(${escapeHtml(m.larkAppId)})</small>
                  </label>
                  <div class="oncall-row-body">
                    <input type="text" data-input="workingDir" placeholder="e.g. /root/iserver/botmux"
                           value="${escapeHtml(wd)}" ${enabled ? '' : 'disabled'}>
                    <button type="button" data-action="save">Save</button>
                    <span class="oncall-status" data-status></span>
                  </div>
                </div>
              `;
            }).join('')}
        </fieldset>

        <fieldset>
          <legend>选择机器人退出群聊</legend>
          ${inChat.length === 0
            ? `<p class="empty">没有机器人在群里</p>`
            : inChat.map((m: any) => `
              <label class="checkbox-row">
                <input type="checkbox" name="leave-bot" value="${escapeHtml(m.larkAppId)}">
                ${escapeHtml(m.botName ?? m.larkAppId)}
                <small>${m.larkAppId === ownerAppId ? '· 群主' : ''}</small>
              </label>
            `).join('')}
        </fieldset>

        <div class="actions">
          <button id="g-leave-btn" type="button" ${inChat.length === 0 ? 'disabled' : ''}>选中机器人退出群聊</button>
          <button id="g-disband-btn" type="button" class="contrast" ${inChat.length === 0 ? 'disabled' : ''}>解散群聊</button>
        </div>
        <p class="hint-warn"><small>解散群聊仅当某个在群机器人是群主时才会成功。否则飞书会返回错误，建议改用「退出群聊」。</small></p>
        <form method="dialog"><button>关闭</button></form>
      </article>`;
    drawer.showModal();

    // Oncall row interactions: toggle enables/disables the input; Save commits.
    drawer.querySelectorAll<HTMLDivElement>('.oncall-row').forEach(row => {
      const appId = row.dataset.bot!;
      const cb = row.querySelector<HTMLInputElement>('input[data-action=toggle]')!;
      const input = row.querySelector<HTMLInputElement>('input[data-input=workingDir]')!;
      const saveBtn = row.querySelector<HTMLButtonElement>('button[data-action=save]')!;
      const statusEl = row.querySelector<HTMLSpanElement>('[data-status]')!;
      cb.addEventListener('change', () => {
        input.disabled = !cb.checked;
        if (cb.checked) input.focus();
      });
      saveBtn.addEventListener('click', async () => {
        statusEl.textContent = '';
        statusEl.className = 'oncall-status';
        const want = cb.checked;
        const wd = input.value.trim();
        if (want && !wd) {
          statusEl.textContent = '请填工作目录';
          statusEl.classList.add('hint-warn-inline');
          return;
        }
        saveBtn.disabled = true;
        try {
          const url = `/api/groups/${encodeURIComponent(chat.chatId)}/oncall/${encodeURIComponent(appId)}`;
          const r = want
            ? await fetch(url, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workingDir: wd }),
              })
            : await fetch(url, { method: 'DELETE' });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            statusEl.textContent = want
              ? `✓ 已绑定 → ${body.resolvedPath ?? wd}`
              : '✓ 已解绑';
            statusEl.classList.add('hint-ok');
            // Refresh aggregator cache + matrix; drawer state stays as-is
            // (current row reflects the just-saved values).
            try { await loadGroups(); rerender(); } catch { /* tolerate */ }
          } else {
            statusEl.textContent = `✗ ${body.error ?? r.status}`;
            statusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          statusEl.textContent = `✗ ${e?.message ?? e}`;
          statusEl.classList.add('hint-warn-inline');
        } finally {
          saveBtn.disabled = false;
        }
      });
    });

    drawer.querySelector<HTMLButtonElement>('#g-leave-btn')!.onclick = async () => {
      const checked = [...drawer.querySelectorAll<HTMLInputElement>('input[name=leave-bot]:checked')]
        .map(i => i.value);
      if (checked.length === 0) { alert('至少选一个机器人'); return; }
      if (!confirm(`确定让 ${checked.length} 个机器人退出群聊？该 bot 在此群的会话会一并关闭。`)) return;
      try {
        const r = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/leave`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ larkAppIds: checked }),
        });
        const respBody = await r.json();
        const lines = (respBody.result ?? []).map((x: any) => {
          if (!x.ok) return `${x.larkAppId}: 失败 (${x.error ?? 'unknown'})`;
          const closed = (x.closedSessions ?? []) as any[];
          const failed = closed.filter(c => !c.ok).length;
          const ok = closed.length - failed;
          const note = closed.length === 0
            ? ''
            : failed === 0 ? `（关闭 ${ok} 个会话）` : `（关闭 ${ok} 个，${failed} 个失败）`;
          return `${x.larkAppId}: OK${note}`;
        }).join('\n');
        alert(lines || `Unexpected: ${JSON.stringify(respBody)}`);
        await loadGroups(); rerender();
      } catch (e) {
        alert('Network error: ' + e);
      } finally {
        drawer.close();
      }
    };

    drawer.querySelector<HTMLButtonElement>('#g-disband-btn')!.onclick = async () => {
      if (inChat.length === 0) return;
      if (!confirm(`确定解散群聊「${chat.name ?? chat.chatId}」？此操作不可恢复，本群所有机器人会话也会一并关闭。`)) return;
      // Try the owner bot first (highest success probability), then fall back
      // to other in-chat bots in case our ownerId match was wrong (e.g. owner
      // is a user, but a creator-bot with operate_as_owner scope is in chat).
      const ordered = [...inChat].sort((a, b) =>
        (b.larkAppId === ownerAppId ? 1 : 0) - (a.larkAppId === ownerAppId ? 1 : 0)
      );
      const errs: string[] = [];
      for (const m of ordered) {
        try {
          const r = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/disband`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ larkAppId: m.larkAppId }),
          });
          const respBody = await r.json();
          if (respBody.ok) {
            const closed = (respBody.closedSessions ?? []) as any[];
            const failed = closed.filter(c => !c.ok).length;
            const ok = closed.length - failed;
            const closedNote = closed.length === 0
              ? ''
              : failed === 0 ? `\n关闭了 ${ok} 个会话。` : `\n关闭了 ${ok} 个会话，${failed} 个会话关闭失败。`;
            alert(`已解散（由 ${m.botName ?? m.larkAppId} 执行）${closedNote}`);
            await loadGroups(); rerender();
            drawer.close();
            return;
          }
          errs.push(`${m.botName ?? m.larkAppId}: ${respBody.error ?? r.status}`);
        } catch (e) {
          errs.push(`${m.botName ?? m.larkAppId}: ${e}`);
        }
      }
      alert(`所有在群机器人均无法解散：\n${errs.join('\n')}\n\n建议改用「退出群聊」。`);
    };
  }

  form.addEventListener('input', rerender);
}
