// Roles page: hierarchical group → bot role editor.
// Displays groups as collapsible sections with bots nested inside.
// Each bot has its own per-group role definition selectable for editing.
import { botAvatarHtml, escapeHtml, loadNameMaps, loadingHtml, t } from './ui.js';

interface BotInfo {
  larkAppId: string;
  botName: string;
  inChat: boolean;
  hasRole: boolean;
  oncallChat: unknown;
}

interface GroupInfo {
  chatId: string;
  name?: string;
  memberBots: BotInfo[];
}

interface RoleData {
  chatId: string;
  content: string | null;
  byteLength: number;
  hasRole: boolean;
}

const MAX_ROLE_BYTES = 4096;

let cache: GroupInfo[] = [];
let selectedGroupId: string | null = null;
let selectedBotId: string | null = null;
let editingContent = '';
let expandedGroups = new Set<string>();

function pageHtml(): string {
  return `<section class="page roles-page">
<div class="page-heading">
  <div>
    <p class="eyebrow">${t('nav.roles')}</p>
    <h1>${t('roles.title')}</h1>
    <p>${t('roles.subtitle')}</p>
  </div>
</div>
<div class="roles-layout">
  <div class="roles-tree-panel">
    <div class="roles-tree-header">
      <input type="search" id="roles-search" placeholder="${t('roles.search')}" />
      <button type="button" id="roles-refresh">${t('roles.refresh')}</button>
    </div>
    <div id="roles-tree" class="roles-tree"></div>
  </div>
  <div class="roles-editor-panel">
    <div id="roles-editor-empty" class="roles-editor-empty">${t('roles.selectHint')}</div>
    <div id="roles-editor-form" class="roles-editor-form" style="display:none">
      <div class="roles-editor-breadcrumb">
        <span id="roles-editor-group-name"></span>
        <span class="roles-breadcrumb-sep">›</span>
        <span id="roles-editor-bot-name"></span>
      </div>
      <div class="roles-editor-meta">
        <span id="roles-editor-chat-id" class="roles-editor-meta-line"></span>
      </div>
      <textarea id="roles-editor-textarea" placeholder="${t('roles.editorPlaceholder')}" rows="14"></textarea>
      <div class="roles-editor-footer">
        <span id="roles-editor-bytecount" class="roles-bytecount"></span>
        <div class="roles-editor-actions">
          <button type="button" id="roles-delete" class="danger">${t('roles.delete')}</button>
          <button type="button" id="roles-save" class="primary">${t('roles.save')}</button>
        </div>
      </div>
      <div id="roles-preview" class="roles-preview"></div>
    </div>
  </div>
</div>
</section>`;
}

async function loadGroups(): Promise<void> {
  const r = await fetch('/api/groups');
  const data = await r.json();
  cache = (data.chats ?? []).map((c: any) => ({
    chatId: c.chatId,
    name: c.name ?? c.chatId,
    memberBots: (c.memberBots ?? []).map((m: any) => ({
      larkAppId: m.larkAppId,
      botName: m.botName ?? m.larkAppId,
      inChat: m.inChat ?? false,
      hasRole: m.hasRole ?? false,
      oncallChat: m.oncallChat ?? null,
    })),
  }));
}

async function loadRole(larkAppId: string, chatId: string): Promise<RoleData> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`);
  return r.json();
}

async function saveRole(larkAppId: string, chatId: string, content: string): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return r.ok;
}

async function deleteRole(larkAppId: string, chatId: string): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
  return r.ok;
}

function botRoleCount(group: GroupInfo): number {
  return group.memberBots.filter(b => b.inChat && b.hasRole).length;
}

function botInChatCount(group: GroupInfo): number {
  return group.memberBots.filter(b => b.inChat).length;
}

function renderTree(filter: string = ''): void {
  const tree = document.getElementById('roles-tree');
  if (!tree) return;

  const q = filter.toLowerCase();
  const filtered = cache.filter(g => {
    if (!q) return true;
    const matchGroup = g.chatId.toLowerCase().includes(q) || (g.name ?? '').toLowerCase().includes(q);
    const matchBot = g.memberBots.some(b =>
      b.larkAppId.toLowerCase().includes(q) || (b.botName ?? '').toLowerCase().includes(q),
    );
    return matchGroup || matchBot;
  });

  if (filtered.length === 0) {
    tree.innerHTML = `<div class="roles-empty">${t('roles.noChats')}</div>`;
    return;
  }

  tree.innerHTML = filtered.map(g => {
    const expanded = expandedGroups.has(g.chatId);
    const inChatBots = g.memberBots.filter(b => b.inChat);
    const arrow = expanded ? '▾' : '▸';
    const roleCount = botRoleCount(g);
    const totalInChat = botInChatCount(g);

    const botRows = expanded
      ? inChatBots.map(b => {
          const isSelected = selectedGroupId === g.chatId && selectedBotId === b.larkAppId;
          return `
            <div class="roles-bot-row ${isSelected ? 'selected' : ''}"
                 data-group-id="${escapeHtml(g.chatId)}"
                 data-bot-id="${escapeHtml(b.larkAppId)}">
              <span class="roles-bot-indent"></span>
              ${botAvatarHtml({ name: b.botName, larkAppId: b.larkAppId, size: 'sm' })}
              <div class="roles-bot-info">
                <div class="roles-bot-name">${escapeHtml(b.botName)}</div>
                <div class="roles-bot-id">${escapeHtml(b.larkAppId)}</div>
              </div>
              <span class="roles-badge ${b.hasRole ? 'has-role' : 'no-role'}">
                ${b.hasRole ? t('roles.configured') : t('roles.unconfigured')}
              </span>
            </div>`;
        }).join('')
      : '';

    return `
      <div class="roles-group-section">
        <div class="roles-group-row ${expanded ? 'expanded' : ''} ${selectedGroupId === g.chatId && !selectedBotId ? 'selected' : ''}"
             data-group-id="${escapeHtml(g.chatId)}">
          <span class="roles-group-arrow">${arrow}</span>
          <span class="roles-group-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="5.6" cy="5.8" r="2.4"/><path d="M1.8 13.2c.5-2.4 2-3.6 3.8-3.6s3.3 1.2 3.8 3.6"/><circle cx="11" cy="6.8" r="1.9"/><path d="M9.8 12.6c.4-1.7 1.5-2.6 2.8-2.6 1 0 1.9.5 2.4 1.6"/></svg></span>
          <div class="roles-group-info">
            <div class="roles-group-name">${escapeHtml(g.name ?? g.chatId)}</div>
            <div class="roles-group-meta">
              ${roleCount}/${totalInChat} ${t('roles.botsWithRoles')}
            </div>
          </div>
          <span class="roles-group-chevron"></span>
        </div>
        <div class="roles-bot-list">${botRows}</div>
      </div>`;
  }).join('');

  // Group row click → toggle expand
  tree.querySelectorAll('.roles-group-row').forEach(row => {
    row.addEventListener('click', () => {
      const gid = (row as HTMLElement).dataset.groupId;
      if (!gid) return;
      if (expandedGroups.has(gid)) {
        expandedGroups.delete(gid);
      } else {
        expandedGroups.add(gid);
      }
      renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
    });
  });

  // Bot row click → select for editing
  tree.querySelectorAll('.roles-bot-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = (row as HTMLElement).dataset.groupId;
      const bid = (row as HTMLElement).dataset.botId;
      if (gid && bid) selectBot(gid, bid);
    });
  });
}

async function selectBot(groupId: string, botId: string): Promise<void> {
  selectedGroupId = groupId;
  selectedBotId = botId;

  const role = await loadRole(botId, groupId);

  const empty = document.getElementById('roles-editor-empty');
  const form = document.getElementById('roles-editor-form');
  const textarea = document.getElementById('roles-editor-textarea') as HTMLTextAreaElement;
  const groupName = document.getElementById('roles-editor-group-name');
  const botName = document.getElementById('roles-editor-bot-name');
  const chatIdEl = document.getElementById('roles-editor-chat-id');

  if (empty) empty.style.display = 'none';
  if (form) form.style.display = '';

  const group = cache.find(g => g.chatId === groupId);
  const bot = group?.memberBots.find(b => b.larkAppId === botId);

  if (groupName) groupName.textContent = group?.name ?? groupId;
  if (botName) botName.textContent = bot?.botName ?? botId;
  if (chatIdEl) chatIdEl.textContent = `${groupId}  ·  ${botId}`;

  editingContent = role.content ?? '';
  if (textarea) {
    textarea.value = editingContent;
    textarea.focus();
  }
  updateByteCount();
  updatePreview();
  renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');

  const delBtn = document.getElementById('roles-delete');
  if (delBtn) delBtn.style.display = role.hasRole ? '' : 'none';
}

function updateByteCount(): void {
  const el = document.getElementById('roles-editor-bytecount');
  if (!el) return;
  const len = new TextEncoder().encode(editingContent).length;
  el.textContent = `${len} / ${MAX_ROLE_BYTES} bytes`;
  el.className = `roles-bytecount ${len > 3800 ? 'warn' : ''} ${len > MAX_ROLE_BYTES ? 'over' : ''}`;
  updateSaveButton(len);
}

function updateSaveButton(byteLen?: number): void {
  const btn = document.getElementById('roles-save') as HTMLButtonElement | null;
  if (!btn) return;
  const len = byteLen ?? new TextEncoder().encode(editingContent).length;
  btn.disabled = len > MAX_ROLE_BYTES || editingContent.trim().length === 0;
}

function updatePreview(): void {
  const preview = document.getElementById('roles-preview');
  if (!preview) return;
  if (!editingContent.trim()) {
    preview.innerHTML = `<small>${t('roles.previewEmpty')}</small>`;
  } else {
    preview.innerHTML = `<strong>${t('roles.preview')}</strong><pre>${escapeHtml(editingContent)}</pre>`;
  }
}

function resetEditor(): void {
  selectedGroupId = null;
  selectedBotId = null;
  editingContent = '';

  const empty = document.getElementById('roles-editor-empty');
  const form = document.getElementById('roles-editor-form');
  const textarea = document.getElementById('roles-editor-textarea') as HTMLTextAreaElement;
  const delBtn = document.getElementById('roles-delete');

  if (empty) empty.style.display = '';
  if (form) form.style.display = 'none';
  if (textarea) textarea.value = '';
  if (delBtn) delBtn.style.display = 'none';
}

export async function renderRolesPage(root: HTMLElement): Promise<void> {
  root.innerHTML = pageHtml();
  expandedGroups.clear();
  resetEditor();

  // /api/groups 慢——树区域先亮 loading，避免左栏长时间空白像挂了。
  const treeEl = document.getElementById('roles-tree');
  if (treeEl) treeEl.innerHTML = loadingHtml();
  await loadGroups();
  await loadNameMaps(); // 预热共享头像表，让角色树首屏就能出真实头像
  // Auto-expand groups that have at least one bot with a role
  for (const g of cache) {
    if (botRoleCount(g) > 0) expandedGroups.add(g.chatId);
  }
  renderTree();

  // Search
  document.getElementById('roles-search')?.addEventListener('input', (e) => {
    renderTree((e.target as HTMLInputElement).value);
  });

  // Refresh
  document.getElementById('roles-refresh')?.addEventListener('click', async () => {
    await loadGroups();
    renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
    // Re-fetch current selection if any
    if (selectedGroupId && selectedBotId) {
      const role = await loadRole(selectedBotId, selectedGroupId);
      const textarea = document.getElementById('roles-editor-textarea') as HTMLTextAreaElement;
      if (textarea) textarea.value = role.content ?? '';
      editingContent = role.content ?? '';
      updateByteCount();
      updatePreview();
      const delBtn = document.getElementById('roles-delete');
      if (delBtn) delBtn.style.display = role.hasRole ? '' : 'none';
    }
  });

  // Save
  document.getElementById('roles-save')?.addEventListener('click', async function(this: HTMLButtonElement) {
    if (!selectedGroupId || !selectedBotId) return;
    this.disabled = true;
    this.textContent = '...';
    try {
      const ok = await saveRole(selectedBotId, selectedGroupId, editingContent);
      if (ok) {
        await loadGroups();
        renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
        const delBtn = document.getElementById('roles-delete');
        if (delBtn) delBtn.style.display = '';
        // Brief saved indicator
        const statusEl = document.createElement('span');
        statusEl.className = 'roles-saved-flash';
        statusEl.textContent = ` ${t('roles.saved')}`;
        const footer = document.querySelector('.roles-editor-footer');
        footer?.appendChild(statusEl);
        setTimeout(() => statusEl.remove(), 2000);
      } else {
        // Show error feedback
        const statusEl = document.createElement('span');
        statusEl.className = 'roles-saved-flash roles-save-error';
        statusEl.textContent = editingContent.trim().length === 0
          ? ` ${t('roles.emptyError')}`
          : ` ${t('roles.saveFailed')}`;
        const footer = document.querySelector('.roles-editor-footer');
        footer?.appendChild(statusEl);
        setTimeout(() => statusEl.remove(), 3000);
      }
    } finally {
      this.disabled = false;
      this.textContent = t('roles.save');
    }
  });

  // Delete
  document.getElementById('roles-delete')?.addEventListener('click', async function(this: HTMLButtonElement) {
    if (!selectedGroupId || !selectedBotId) return;
    if (!confirm(t('roles.confirmDelete'))) return;
    this.disabled = true;
    this.textContent = '...';
    try {
      const ok = await deleteRole(selectedBotId, selectedGroupId);
      if (ok) {
        await loadGroups();
        resetEditor();
        renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
      }
    } finally {
      this.disabled = false;
      this.textContent = t('roles.delete');
    }
  });

  // Live edit
  document.getElementById('roles-editor-textarea')?.addEventListener('input', (e) => {
    editingContent = (e.target as HTMLTextAreaElement).value;
    updateByteCount();
    updatePreview();
  });
}
