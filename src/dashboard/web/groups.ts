// Groups & Bots page: chat × bot membership matrix + add-bots modal.
// The aggregator at /api/groups fans out to all online daemons and merges chats
// by chatId; the dashboard displays this as a matrix where each cell shows
// whether a bot is a member of a given chat.
import { chatAvatarHtml, escapeHtml, loadingHtml, t } from './ui.js';
import {
  hasExplicitChatRole,
  summarizeGroupProfileMatches,
  type EffectiveRoleValue,
  type RoleProfileEntryLike,
  type RoleProfileSummaryLike,
} from './role-profile-match.js';

let cache: { chats: any[]; bots: any[] } = { chats: [], bots: [] };
const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const roleKey = (larkAppId: string, chatId: string) => `${larkAppId}\u0000${chatId}`;
let roleProfiles: RoleProfileSummaryLike[] = [];
let roleProfileEntriesById = new Map<string, RoleProfileEntryLike[]>();
let groupRoleContentByBot = new Map<string, EffectiveRoleValue>();
let roleProfileContextLoaded = false;

type SaveProfileEntryStatus = 'chat' | 'team' | 'empty' | 'error';
type SaveProfileEntry = {
  larkAppId: string;
  botName?: string;
  content: string;
  status: SaveProfileEntryStatus;
};

function isValidProfileId(profileId: string): boolean {
  return PROFILE_ID_RE.test(profileId) && profileId !== '.' && profileId !== '..';
}

export function suggestRoleProfileIdFromChat(value: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return isValidProfileId(cleaned) ? cleaned : 'profile';
}

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">${t('nav.groups')}</p>
    <h1>${t('groups.title')}</h1>
    <p>${t('groups.subtitle')}</p>
  </div>
</div>
<form id="g-filters" class="filters">
  <input type="search" name="q" placeholder="${t('groups.search')}" />
  <label><input type="checkbox" name="missing"> ${t('groups.missingOnly')}</label>
  <button type="button" id="g-refresh">${t('groups.refresh')}</button>
  <button type="button" id="g-create" class="primary">${t('groups.create')}</button>
</form>
<div id="g-loading">${loadingHtml()}</div>
<div class="table-scroll matrix-scroll" id="g-table-wrap" hidden>
  <table>
    <thead id="g-head"></thead>
    <tbody id="g-body"></tbody>
  </table>
</div>
<dialog id="g-drawer"></dialog>
</section>`;
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

async function loadGroupRoleProfileContext(): Promise<void> {
  const profileResp = await fetch('/api/role-profiles');
  const profileBody = await profileResp.json().catch(() => ({}));
  const nextProfiles = Array.isArray(profileBody.profiles) ? profileBody.profiles as RoleProfileSummaryLike[] : [];

  const detailPairs = await Promise.all(nextProfiles.map(async profile => {
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profile.profileId)}`);
      const body = await r.json().catch(() => ({}));
      return [profile.profileId, Array.isArray(body.entries) ? body.entries as RoleProfileEntryLike[] : []] as const;
    } catch {
      return [profile.profileId, [] as RoleProfileEntryLike[]] as const;
    }
  }));

  const nextGroupRoles = new Map<string, EffectiveRoleValue>();
  const seenRoleKeys = new Set<string>();
  await Promise.all((cache.chats ?? []).flatMap((chat: any) =>
    (chat.memberBots ?? [])
      .filter((bot: any) => bot?.inChat && bot?.larkAppId)
      .map(async (bot: any) => {
        const key = roleKey(bot.larkAppId, chat.chatId);
        if (seenRoleKeys.has(key)) return;
        seenRoleKeys.add(key);
        try {
          const r = await fetch(`/api/roles/${encodeURIComponent(bot.larkAppId)}/${encodeURIComponent(chat.chatId)}`);
          const body = await r.json().catch(() => ({}));
          const hasEffectiveRole = body?.hasEffectiveRole ?? body?.hasRole;
          const effectiveContent = 'effectiveContent' in body ? body.effectiveContent : body.content;
          nextGroupRoles.set(key, {
            content: hasEffectiveRole ? String(effectiveContent ?? '') : null,
            source: body?.effectiveSource ?? (body?.hasRole ? 'chat' : 'none'),
          });
        } catch {
          nextGroupRoles.set(key, null);
        }
      }),
  ));

  roleProfiles = nextProfiles;
  roleProfileEntriesById = new Map(detailPairs);
  groupRoleContentByBot = nextGroupRoles;
}

async function fetchRoleProfileSummaries(): Promise<RoleProfileSummaryLike[]> {
  const r = await fetch('/api/role-profiles');
  const body = await r.json().catch(() => ({}));
  return Array.isArray(body.profiles) ? body.profiles as RoleProfileSummaryLike[] : [];
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

export function renderRoleProfileBootstrapSummary(
  profileId: string,
  messageId?: unknown,
  error?: unknown,
): string {
  const cleanProfileId = String(profileId ?? '').trim();
  if (!cleanProfileId) return '';

  if (error) {
    return `<p class="hint-warn">${escapeHtml(t('groups.roleProfileBootstrapFailed', {
      name: cleanProfileId,
      reason: String(error),
    }))}</p>`;
  }

  const cleanMessageId = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : '';
  if (cleanMessageId) {
    return `<p class="hint-ok">${escapeHtml(t('groups.roleProfileBootstrapSent', {
      name: cleanProfileId,
      messageId: cleanMessageId,
    }))}</p>`;
  }

  return `<p class="hint-ok">${escapeHtml(t('groups.roleProfileBootstrapDone', { name: cleanProfileId }))}</p>`;
}

export async function renderGroupsPage(root: HTMLElement) {
  root.innerHTML = pageHtml();
  const head = root.querySelector<HTMLElement>('#g-head')!;
  const body = root.querySelector<HTMLElement>('#g-body')!;
  const form = root.querySelector<HTMLFormElement>('#g-filters')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#g-refresh')!;
  const drawer = root.querySelector<HTMLDialogElement>('#g-drawer')!;

  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    try {
      await loadGroups();
      rerender();
      void refreshRoleProfileContext();
    } finally { refreshBtn.disabled = false; }
  };

  const createBtn = root.querySelector<HTMLButtonElement>('#g-create')!;
  createBtn.onclick = () => { void openCreateModal(); };

  // /api/groups 要扇出到所有 daemon、逐群查成员，慢——先亮 loading，回来再换表格。
  const loadingEl = root.querySelector<HTMLElement>('#g-loading')!;
  const tableWrap = root.querySelector<HTMLElement>('#g-table-wrap')!;
  try {
    await loadGroups();
  } finally {
    loadingEl.remove();
    tableWrap.hidden = false;
  }

  async function refreshRoleProfileContext(): Promise<void> {
    try {
      await loadGroupRoleProfileContext();
    } catch {
      roleProfiles = [];
      roleProfileEntriesById = new Map();
      groupRoleContentByBot = new Map();
    } finally {
      roleProfileContextLoaded = true;
      rerender();
    }
  }

  async function openCreateModal() {
    const allBots = cache.bots;
    if (allBots.length === 0) {
      alert(t('groups.noBotsOnline'));
      return;
    }
    let roleProfiles: Array<{ profileId: string }> = [];
    try {
      const r = await fetch('/api/role-profiles');
      const data = await r.json();
      roleProfiles = data.profiles ?? [];
    } catch { /* profile selector is optional */ }
    drawer.innerHTML = `
      <article>
        <header><h3>${t('groups.createTitle')}</h3></header>
        <p>${t('groups.createHelp')}</p>
        <form id="g-createform">
          <label class="form-row">
            <span>${t('groups.name')}</span>
            <input type="text" name="name" placeholder="${t('groups.namePlaceholder')}" maxlength="60">
          </label>
          <label class="form-row">
            <span>${t('groups.bindDir')}</span>
            <input type="text" name="bindWorkingDir" placeholder="e.g. ~/projects/botmux">
            <small>${t('groups.bindDirHelp')}</small>
          </label>
          <label class="form-row">
            <span>${t('groups.roleProfile')}</span>
            <select name="roleProfileId">
              <option value="">${t('groups.roleProfileNone')}</option>
              ${roleProfiles.map(p => `<option value="${escapeHtml(p.profileId)}">${escapeHtml(p.profileId)}</option>`).join('')}
            </select>
            <small>${t('groups.roleProfileHelp')}</small>
          </label>
          <fieldset>
            <legend>${t('groups.botPicker')}</legend>
            ${renderBotCheckboxes(allBots)}
          </fieldset>
          <div class="actions">
            <button type="submit" class="primary">${t('groups.createSubmit')}</button>
            <button type="button" id="g-create-cancel">${t('groups.cancel')}</button>
          </div>
        </form>
      </article>`;
    drawer.showModal();

    drawer.querySelector<HTMLButtonElement>('#g-create-cancel')!.onclick = () => drawer.close();

    drawer.querySelector<HTMLFormElement>('#g-createform')!.onsubmit = async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      const name = ((fd.get('name') as string) ?? '').trim();
      const bindWorkingDir = ((fd.get('bindWorkingDir') as string) ?? '').trim();
      const roleProfileId = ((fd.get('roleProfileId') as string) ?? '').trim();
      const ids = fd.getAll('bot') as string[];
      if (ids.length === 0) { alert('Pick at least one bot.'); return; }
      const submitBtn = (ev.target as HTMLFormElement).querySelector<HTMLButtonElement>('button[type=submit]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating...'; }
      try {
        const r = await fetch('/api/groups/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name || undefined,
            larkAppIds: ids,
            bindWorkingDir: bindWorkingDir || undefined,
            roleProfileId: roleProfileId || undefined,
          }),
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
          void refreshRoleProfileContext();
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
          void refreshRoleProfileContext();
          return;
        }
      }
    }
  }

  function renderCreateSuccess(resp: any) {
    const chatId = String(resp.chatId);
    // 优先用服务端返回的 shareLink（由 Lark/飞书建群 API 给出，天然带正确品牌域名）；
    // 仅当缺失（share-link API 失败）时回退到 applink。浏览器侧拿不到 brand，这个
    // 回退默认 feishu host——属极少触发的兜底，不影响 Lark 正常建群（有 shareLink）。
    const appLink = typeof resp.shareLink === 'string' && resp.shareLink
      ? resp.shareLink
      : `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
    const invalidBots = (resp.invalidBotIds ?? []) as string[];
    const invalidUsers = (resp.invalidUserIds ?? []) as string[];
    const auto = resp.autoInvitedOpenId as string | null | undefined;
    const rejected = !!resp.autoInviteRejected;
    const ownerTo = resp.ownerTransferredTo as string | null | undefined;
    const transferErr = resp.transferError as string | null | undefined;
    const notifyMsgId = resp.notifyMessageId as string | null | undefined;
    const notifyErr = resp.notifyError as string | null | undefined;
    const binds = Array.isArray(resp.oncallBindings) ? resp.oncallBindings as any[] : [];
    const bindOk = binds.filter(b => b?.ok).length;
    const bindFailed = binds.filter(b => !b?.ok);
    const bindNote = binds.length > 0
      ? bindFailed.length === 0
        ? `<p class="hint-ok">已绑定目录：<code>${escapeHtml(resp.bindResolvedPath ?? '')}</code>（${bindOk}/${binds.length} bots）</p>`
        : `<p class="hint-warn">目录绑定部分失败：成功 ${bindOk}/${binds.length}。${bindFailed.map(b => `<br><code>${escapeHtml(b.larkAppId ?? '?')}</code>: ${escapeHtml(b.error ?? 'unknown')}`).join('')}</p>`
      : '';
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
    const profileNote = renderRoleProfileBootstrapSummary(
      typeof resp.roleProfileId === 'string' ? resp.roleProfileId : '',
      resp.roleProfileBootstrapMessageId,
      resp.roleProfileBootstrapError,
    );

    drawer.innerHTML = `
      <article>
        <header><h3>${t('groups.successTitle')}</h3></header>
        <p><b>chatId:</b> <code>${escapeHtml(chatId)}</code> <button type="button" data-copy="${escapeHtml(chatId)}">${t('sessions.copy')}</button></p>
        <p><b>创建者:</b> <code>${escapeHtml(resp.creator ?? '?')}</code></p>
        ${inviteNote}
        ${bindNote}
        ${profileNote}
        ${invalidNote ? `<ul>${invalidNote}</ul>` : ''}
        <div class="actions">
          <a class="btn-link primary" href="${appLink}" target="_blank" rel="noopener">${t('groups.openGroup')}</a>
          <button type="button" id="g-create-close">${t('sessions.dismiss')}</button>
        </div>
      </article>`;

    drawer.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.copy ?? '');
        b.textContent = t('sessions.copied');
        setTimeout(() => { b.textContent = t('sessions.copy'); }, 800);
      };
    });
    drawer.querySelector<HTMLButtonElement>('#g-create-close')!.onclick = () => drawer.close();
  }

  function renderGroupProfileStatus(chat: any): string {
    if (!roleProfiles.length || !roleProfileContextLoaded) return '';
    const rolesByBot = new Map<string, EffectiveRoleValue>();
    for (const bot of chat.memberBots ?? []) {
      if (!bot?.inChat) continue;
      rolesByBot.set(bot.larkAppId, groupRoleContentByBot.get(roleKey(bot.larkAppId, chat.chatId)) ?? null);
    }
    if (!hasExplicitChatRole(rolesByBot)) return '';
    const matches = summarizeGroupProfileMatches(chat.memberBots ?? [], roleProfiles, roleProfileEntriesById, rolesByBot);
    const best = matches[0];
    if (!best) {
      return `<div class="g-profile-status muted">${t('groups.profileStatusUnmatched')}</div>`;
    }
    const key = best.kind === 'full' ? 'groups.profileStatusFullChat' : 'groups.profileStatusPartial';
    return `<div class="g-profile-status ${best.kind}">
      ${escapeHtml(t(key, {
        name: best.profileId,
        matched: best.matched,
        total: best.total,
        chat: best.chatMatched,
      }))}
    </div>`;
  }

  function renderHead() {
    head.innerHTML = `<tr>
      <th>${t('groups.chat')}</th>
      ${cache.bots.map(b => `<th>${escapeHtml(b.botName ?? b.larkAppId)}</th>`).join('')}
      <th>${t('groups.actions')}</th>
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
      body.innerHTML = `<tr><td colspan="${cache.bots.length + 2}" class="empty">${t('groups.empty')}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(c => `<tr data-chat="${escapeHtml(c.chatId)}">
      <td>
        <div class="g-chat-cell">
          ${chatAvatarHtml({ chatId: c.chatId, name: c.name, avatarUrl: c.avatar, size: 'sm' })}
          <div class="g-chat-meta">
            <strong>${escapeHtml(c.name ?? c.chatId)}</strong><br>
            <small><code>${escapeHtml(c.chatId)}</code></small>
            ${renderGroupProfileStatus(c)}
          </div>
        </div>
      </td>
      ${cache.bots.map(b => {
        const m = c.memberBots.find((m: any) => m.larkAppId === b.larkAppId);
        const cell = !m ? '?' : m.error ? '!' : m.inChat ? '✓' : '✗';
        const cls = !m ? 'cell-unknown' : m.error ? 'cell-error' : m.inChat ? 'cell-in' : 'cell-out';
        return `<td class="${cls}" title="${escapeHtml(m?.error ?? '')}">${cell}</td>`;
      }).join('')}
      <td>
        <button class="add-bots" type="button">${t('groups.addBots')}</button>
        <button class="save-profile" type="button">${t('groups.saveAsProfile')}</button>
        <button class="manage-chat" type="button">${t('groups.manage')}</button>
      </td>
    </tr>`).join('');
  }
  rerender();
  void refreshRoleProfileContext();

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
        <header><h3>${t('groups.addBots')} · ${escapeHtml(chat.name ?? chat.chatId)}</h3></header>
        <p>${t('groups.createHelp')}</p>
        <form id="g-addform">
          ${renderBotCheckboxes(cache.bots, inChatSet)}
          <div class="actions">
            <button type="submit" class="primary">${t('groups.addBots')}</button>
            <button type="button" id="g-cancel">${t('groups.cancel')}</button>
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
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.save-profile');
    if (!btn) return;
    const tr = btn.closest<HTMLTableRowElement>('tr[data-chat]')!;
    const chatId = tr.dataset.chat!;
    const chat = cache.chats.find(c => c.chatId === chatId);
    if (!chat) return;
    await saveGroupRolesAsProfile(chat, btn);
  });

  async function saveGroupRolesAsProfile(chat: any, btn: HTMLButtonElement): Promise<void> {
    const suggestedByName = suggestRoleProfileIdFromChat(chat.name ?? '');
    const suggested = suggestedByName === 'profile'
      ? suggestRoleProfileIdFromChat(chat.chatId)
      : suggestedByName;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = t('groups.saveProfileSaving');
    try {
      const [entries, profiles] = await Promise.all([
        collectGroupProfileEntries(chat),
        fetchRoleProfileSummaries(),
      ]);
      openSaveProfileDialog(chat, suggested, entries, profiles);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function collectGroupProfileEntries(chat: any): Promise<SaveProfileEntry[]> {
    const inChat = (chat.memberBots ?? []).filter((bot: any) => bot?.inChat && bot?.larkAppId);
    const roleRows = await Promise.all(inChat.map(async (bot: any) => {
      try {
        const r = await fetch(`/api/roles/${encodeURIComponent(bot.larkAppId)}/${encodeURIComponent(chat.chatId)}`);
        const body = await r.json().catch(() => ({}));
        const hasEffectiveRole = body?.hasEffectiveRole ?? body?.hasRole;
        const effectiveContent = 'effectiveContent' in body ? body.effectiveContent : body.content;
        const content = hasEffectiveRole ? String(effectiveContent ?? '').trim() : '';
        const source = body?.effectiveSource === 'chat' || body?.effectiveSource === 'team'
          ? body.effectiveSource as SaveProfileEntryStatus
          : null;
        return {
          larkAppId: bot.larkAppId as string,
          botName: bot.botName,
          content,
          status: content ? (source ?? 'chat') : 'empty',
        };
      } catch {
        return {
          larkAppId: bot.larkAppId as string,
          botName: bot.botName,
          content: '',
          status: 'error' as const,
        };
      }
    }));
    return roleRows;
  }

  function openSaveProfileDialog(
    chat: any,
    suggestedProfileId: string,
    entries: SaveProfileEntry[],
    profiles: RoleProfileSummaryLike[],
  ): void {
    const sortedProfiles = [...profiles].sort((a, b) => a.profileId.localeCompare(b.profileId));
    const profileButtons = sortedProfiles
      .map((profile, index) => `
        <button type="button"
                class="g-save-profile-pick ${index === 0 ? 'selected' : ''}"
                data-profile-id="${escapeHtml(profile.profileId)}"
                aria-pressed="${index === 0 ? 'true' : 'false'}">
          <span>${escapeHtml(profile.profileId)}</span>
          <small>${escapeHtml(t('groups.saveProfileExistingMeta', { count: profile.entryCount ?? 0 }))}</small>
        </button>`)
      .join('');
    const hasExistingProfiles = sortedProfiles.length > 0;
    const emptyCount = entries.filter(entry => entry.status === 'empty').length;
    const failedCount = entries.filter(entry => entry.status === 'error').length;
    const canSubmitSnapshot = entries.length > 0 && failedCount === 0;
    const entryRows = entries.map(entry => `
      <div class="g-save-profile-entry ${entry.status === 'error' ? 'error' : ''}">
        <div>
          <strong>${escapeHtml(entry.botName ?? entry.larkAppId)}</strong>
          <code>${escapeHtml(entry.larkAppId)}</code>
        </div>
        <span class="g-save-profile-entry-status ${entry.status === 'error' ? 'error' : 'ok'}">
          ${t(entry.status === 'error' ? 'groups.saveProfileStatus.error' : 'groups.saveProfileStatus.entry')}
        </span>
      </div>`).join('');
    drawer.innerHTML = `
      <article class="g-save-profile-dialog">
        <header>
          <h3>${t('groups.saveProfileTitle')}</h3>
          <p>${escapeHtml(t('groups.saveProfileIntro', {
            name: chat.name ?? chat.chatId,
            count: entries.length,
          }))}</p>
        </header>
        <form id="g-save-profile-form">
          <section class="g-save-profile-panel">
            <div class="g-save-profile-section-head">
              <span>${t('groups.saveProfileScope')}</span>
              <small>${t('groups.saveProfileScopeHelp')}</small>
            </div>
            <div class="g-save-profile-stats">
              <span>${t('groups.saveProfileBotCount')} <strong>${entries.length}</strong></span>
              ${failedCount ? `<span class="warn">${t('groups.saveProfileLoadFailed')} <strong>${failedCount}</strong></span>` : ''}
            </div>
            <div class="g-save-profile-entry-list">
              ${entryRows || `<div class="g-save-profile-empty">${t('groups.saveProfileNoRoles')}</div>`}
            </div>
          </section>

          <div class="form-row">
            <span>${t('groups.saveProfileMode')}</span>
            <div class="g-save-profile-switch" role="tablist" aria-label="${t('groups.saveProfileMode')}">
              <button type="button" class="active" data-save-profile-mode="new">${t('groups.saveProfileNew')}</button>
              <button type="button" data-save-profile-mode="overwrite" ${hasExistingProfiles ? '' : 'disabled'}>${t('groups.saveProfileOverwrite')}</button>
            </div>
          </div>
          <label class="form-row" data-profile-mode-row="new">
            <span>${t('groups.saveProfileIdLabel')}</span>
            <input type="text" name="profileId" value="${escapeHtml(suggestedProfileId)}" maxlength="64" autocomplete="off">
            <small>${t('groups.saveProfileInvalid')}</small>
          </label>
          <div class="form-row" data-profile-mode-row="overwrite" hidden>
            <span>${t('groups.saveProfileExistingLabel')}</span>
            ${hasExistingProfiles
              ? `<div class="g-save-profile-picker">${profileButtons}</div>`
              : `<div class="g-save-profile-summary warn">${t('groups.saveProfileExistingEmpty')}</div>`}
            <small>${t('groups.saveProfileOverwriteHelp')}</small>
          </div>
          <div class="g-save-profile-target">
            <span>${t('groups.saveProfileTarget')}</span>
            <code data-save-profile-target>${escapeHtml(suggestedProfileId)}</code>
            <small data-save-profile-target-mode>${t('groups.saveProfileTargetNew')}</small>
          </div>
          <div class="g-save-profile-summary ${canSubmitSnapshot ? '' : 'warn'}">
            ${failedCount
              ? escapeHtml(t('groups.saveProfileFailedLoadSummary', { count: failedCount }))
              : entries.length
              ? escapeHtml(emptyCount
                ? t('groups.saveProfileEntrySummaryWithEmpty', { count: entries.length, emptyCount })
                : t('groups.saveProfileEntrySummary', { count: entries.length }))
              : escapeHtml(t('groups.saveProfileNoRoles'))}
          </div>
          <div class="g-save-profile-status" data-save-profile-status></div>
          <div class="actions">
            <button type="submit" class="primary" ${canSubmitSnapshot ? '' : 'disabled'}>${t('groups.saveProfileSubmit')}</button>
            <button type="button" id="g-save-profile-cancel">${t('groups.cancel')}</button>
          </div>
        </form>
      </article>`;
    drawer.showModal();

    const formEl = drawer.querySelector<HTMLFormElement>('#g-save-profile-form')!;
    const modeRows = [...drawer.querySelectorAll<HTMLElement>('[data-profile-mode-row]')];
    const statusEl = drawer.querySelector<HTMLElement>('[data-save-profile-status]')!;
    const submitBtn = formEl.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const modeButtons = [...formEl.querySelectorAll<HTMLButtonElement>('[data-save-profile-mode]')];
    const profilePickButtons = [...formEl.querySelectorAll<HTMLButtonElement>('[data-profile-id]')];
    const profileIdInput = formEl.querySelector<HTMLInputElement>('input[name=profileId]')!;
    const targetEl = formEl.querySelector<HTMLElement>('[data-save-profile-target]')!;
    const targetModeEl = formEl.querySelector<HTMLElement>('[data-save-profile-target-mode]')!;
    let selectedMode: 'new' | 'overwrite' = 'new';
    let selectedExistingProfileId = sortedProfiles[0]?.profileId ?? '';

    function currentProfileId(): string {
      return selectedMode === 'overwrite'
        ? selectedExistingProfileId
        : profileIdInput.value.trim();
    }

    function updateMode(): void {
      for (const row of modeRows) {
        row.hidden = row.dataset.profileModeRow !== selectedMode;
      }
      for (const button of modeButtons) {
        const isActive = button.dataset.saveProfileMode === selectedMode;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
      }
      for (const button of profilePickButtons) {
        const isSelected = button.dataset.profileId === selectedExistingProfileId;
        button.classList.toggle('selected', isSelected);
        button.setAttribute('aria-pressed', String(isSelected));
      }
      submitBtn.textContent = selectedMode === 'overwrite'
        ? t('groups.saveProfileOverwriteSubmit')
        : t('groups.saveProfileSubmit');
      submitBtn.disabled = !canSubmitSnapshot || (selectedMode === 'overwrite' && !selectedExistingProfileId);
      targetEl.textContent = currentProfileId() || '-';
      targetModeEl.textContent = selectedMode === 'overwrite'
        ? t('groups.saveProfileTargetOverwrite')
        : t('groups.saveProfileTargetNew');
      statusEl.textContent = '';
      statusEl.className = 'g-save-profile-status';
    }

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        const mode = button.dataset.saveProfileMode === 'overwrite' ? 'overwrite' : 'new';
        if (mode === 'overwrite' && !hasExistingProfiles) return;
        selectedMode = mode;
        updateMode();
      });
    });
    profilePickButtons.forEach(button => {
      button.addEventListener('click', () => {
        selectedExistingProfileId = button.dataset.profileId ?? '';
        selectedMode = 'overwrite';
        updateMode();
      });
    });
    profileIdInput.addEventListener('input', updateMode);
    updateMode();

    drawer.querySelector<HTMLButtonElement>('#g-save-profile-cancel')!.onclick = () => drawer.close();
    formEl.onsubmit = async ev => {
      ev.preventDefault();
      if (!canSubmitSnapshot) return;
      const profileId = currentProfileId();
      if (!isValidProfileId(profileId)) {
        statusEl.textContent = t('groups.saveProfileInvalid');
        statusEl.className = 'g-save-profile-status error';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = t('groups.saveProfileSaving');
      statusEl.textContent = t('groups.saveProfileSaving');
      statusEl.className = 'g-save-profile-status';
      try {
        const results = await Promise.all(entries.map(async entry => {
          const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(entry.larkAppId)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: entry.content, allowEmpty: true }),
          });
          return r.ok;
        }));
        const saved = results.filter(Boolean).length;
        if (saved !== entries.length) {
          statusEl.textContent = t('groups.saveProfileFailed', { saved, total: entries.length });
          statusEl.className = 'g-save-profile-status error';
          submitBtn.disabled = false;
          submitBtn.textContent = selectedMode === 'overwrite'
            ? t('groups.saveProfileOverwriteSubmit')
            : t('groups.saveProfileSubmit');
          return;
        }
        statusEl.textContent = t('groups.saveProfileDone', { name: profileId, count: saved });
        statusEl.className = 'g-save-profile-status ok';
        await refreshRoleProfileContext();
        setTimeout(() => drawer.close(), 700);
      } catch (err) {
        statusEl.textContent = String(err);
        statusEl.className = 'g-save-profile-status error';
        submitBtn.disabled = false;
        submitBtn.textContent = selectedMode === 'overwrite'
          ? t('groups.saveProfileOverwriteSubmit')
          : t('groups.saveProfileSubmit');
      }
    };
  }

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
        <header><h3>${t('groups.manageTitle', { name: chat.name ?? chat.chatId })}</h3></header>
        <p><b>chatId:</b> <code>${escapeHtml(chat.chatId)}</code></p>
        <p><b>${t('groups.owner')}:</b> <code>${escapeHtml(chat.ownerId ?? t('common.unknown'))}</code></p>

        <fieldset>
          <legend>${t('groups.oncall')}</legend>
          <p><small>${t('groups.oncallHelp')}</small></p>
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
                    <button type="button" data-action="save">${t('groups.save')}</button>
                    <span class="oncall-status" data-status></span>
                  </div>
                </div>
              `;
            }).join('')}
        </fieldset>

        <fieldset>
          <legend>${t('groups.leaveTitle')}</legend>
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
          <button id="g-leave-btn" type="button" ${inChat.length === 0 ? 'disabled' : ''}>${t('groups.leaveSelected')}</button>
          <button id="g-disband-btn" type="button" class="contrast" ${inChat.length === 0 ? 'disabled' : ''}>${t('groups.disband')}</button>
        </div>
        <p class="hint-warn"><small>${t('groups.dangerHint')}</small></p>
        <form method="dialog"><button>${t('sessions.dismiss')}</button></form>
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
          statusEl.textContent = t('groups.needWorkingDir');
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
            try { await loadGroups(); rerender(); void refreshRoleProfileContext(); } catch { /* tolerate */ }
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
        await loadGroups(); rerender(); void refreshRoleProfileContext();
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
            await loadGroups(); rerender(); void refreshRoleProfileContext();
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
