// Roles page: group role editor + reusable role profile management.
import { botAvatarHtml, escapeHtml, loadNameMaps, loadingHtml, t } from './ui.js';
import {
  hasExplicitChatRole,
  summarizeGroupProfileMatches,
  type EffectiveRoleValue,
  type RoleProfileEntryLike,
} from './role-profile-match.js';

interface BotInfo {
  larkAppId: string;
  botName: string;
  inChat: boolean;
  hasRole: boolean;
  oncallChat: unknown;
}

interface DashboardBot {
  larkAppId: string;
  botName: string;
  botAvatarUrl?: string;
}

interface GroupInfo {
  chatId: string;
  name?: string;
  memberBots: BotInfo[];
}

type RoleInjectMode = 'every' | 'once';

interface RoleData {
  chatId: string;
  content: string | null;
  byteLength: number;
  hasRole: boolean;
  injectMode?: RoleInjectMode;
  effectiveContent?: string | null;
  effectiveSource?: string;
  hasEffectiveRole?: boolean;
}

interface RoleProfileSummary {
  profileId: string;
  entryCount: number;
  updatedAt: number | null;
  botEntries?: Array<{ larkAppId: string; hasEntry: boolean }>;
}

interface RoleProfileEntry {
  profileId: string;
  larkAppId: string;
  content: string;
  byteLength: number;
  updatedAt: number | null;
}

interface RoleProfileEntryData {
  profileId: string;
  larkAppId: string;
  content: string | null;
  byteLength: number;
  hasEntry: boolean;
}

// Keep in sync with MAX_ROLE_BYTES in core/role-resolver.ts (this is a browser
// bundle, so it can't import the Node module — mirror the value here).
const MAX_ROLE_BYTES = 32768;
const ROLE_WARN_BYTES = Math.floor(MAX_ROLE_BYTES * 0.95);
const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

let cache: GroupInfo[] = [];
let allBots: DashboardBot[] = [];
let profiles: RoleProfileSummary[] = [];
let profileEntries: RoleProfileEntry[] = [];
let groupProfileEntriesById = new Map<string, RoleProfileEntryLike[]>();
let groupEffectiveRolesByBot = new Map<string, EffectiveRoleValue>();
let groupProfileContextLoaded = false;

let activeTab: 'groups' | 'profiles' = 'groups';
let selectedGroupId: string | null = null;
let selectedBotId: string | null = null;
let editingContent = '';
let editingInjectMode: RoleInjectMode = 'every';
let expandedGroups = new Set<string>();

let selectedProfileId: string | null = null;
let selectedProfileBotId: string | null = null;
let profileEditingContent = '';
let selectedApplyGroupId: string | null = null;
let activeRolesGeneration = 0;
let activeRolesTimerState: { generation: number; timers: Set<number> } | null = null;

function isRolesGeneration(generation: number): boolean {
  return activeRolesGeneration === generation;
}

function scheduleRolesTimer(fn: () => void, ms: number): number {
  const state = activeRolesTimerState;
  const generation = state?.generation ?? activeRolesGeneration;
  const id = window.setTimeout(() => {
    state?.timers.delete(id);
    if (isRolesGeneration(generation)) fn();
  }, ms);
  state?.timers.add(id);
  return id;
}

function isValidProfileId(profileId: string): boolean {
  return PROFILE_ID_RE.test(profileId) && profileId !== '.' && profileId !== '..';
}

function hashChatId(): string | null {
  const [, query = ''] = location.hash.split('?');
  const chatId = new URLSearchParams(query).get('chatId')?.trim();
  return chatId || null;
}

async function loadGroups(): Promise<void> {
  const r = await fetch('/api/groups');
  const data = await r.json();
  allBots = (data.bots ?? []).map((b: any) => ({
    larkAppId: b.larkAppId,
    botName: b.botName ?? b.larkAppId,
    botAvatarUrl: b.botAvatarUrl,
  }));
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

async function loadProfiles(): Promise<void> {
  const r = await fetch('/api/role-profiles');
  const data = await r.json();
  profiles = data.profiles ?? [];
}

async function loadProfileEntries(profileId: string): Promise<void> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}`);
  const data = await r.json();
  profileEntries = data.entries ?? [];
}

async function loadRole(larkAppId: string, chatId: string): Promise<RoleData> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`);
  return r.json();
}

function roleKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}\u0000${chatId}`;
}

async function loadGroupProfileContext(generation = activeRolesGeneration): Promise<boolean> {
  const detailPairs = await Promise.all(profiles.map(async profile => {
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profile.profileId)}`);
      const body = await r.json().catch(() => ({}));
      return [profile.profileId, Array.isArray(body.entries) ? body.entries as RoleProfileEntryLike[] : []] as const;
    } catch {
      return [profile.profileId, [] as RoleProfileEntryLike[]] as const;
    }
  }));
  if (!isRolesGeneration(generation)) return false;

  const nextEffectiveRoles = new Map<string, EffectiveRoleValue>();
  const seen = new Set<string>();
  await Promise.all(cache.flatMap(group =>
    group.memberBots
      .filter(bot => bot.inChat)
      .map(async bot => {
        const key = roleKey(bot.larkAppId, group.chatId);
        if (seen.has(key)) return;
        seen.add(key);
        try {
          const role = await loadRole(bot.larkAppId, group.chatId);
          const hasEffectiveRole = role.hasEffectiveRole ?? role.hasRole;
          const effectiveContent = 'effectiveContent' in role ? role.effectiveContent : role.content;
          nextEffectiveRoles.set(key, {
            content: hasEffectiveRole ? String(effectiveContent ?? '') : null,
            source: role.effectiveSource ?? (role.hasRole ? 'chat' : 'none'),
          });
        } catch {
          nextEffectiveRoles.set(key, null);
        }
      }),
  ));
  if (!isRolesGeneration(generation)) return false;

  groupProfileEntriesById = new Map(detailPairs);
  groupEffectiveRolesByBot = nextEffectiveRoles;
  return true;
}

async function refreshGroupProfileContext(generation = activeRolesGeneration): Promise<void> {
  try {
    const ok = await loadGroupProfileContext(generation);
    if (!ok || !isRolesGeneration(generation)) return;
  } catch {
    if (!isRolesGeneration(generation)) return;
    groupProfileEntriesById = new Map();
    groupEffectiveRolesByBot = new Map();
  }
  groupProfileContextLoaded = true;
  renderTree((document.getElementById('roles-search') as HTMLInputElement | null)?.value ?? '');
}

async function saveRole(larkAppId: string, chatId: string, content: string, injectMode: RoleInjectMode): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, injectMode }),
  });
  return r.ok;
}

/** Persist only the injection mode (no content) — used when toggling the mode
 *  select, which can apply even to a chat whose role comes from the team default. */
async function saveInjectMode(larkAppId: string, chatId: string, injectMode: RoleInjectMode): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ injectMode }),
  });
  return r.ok;
}

async function deleteRole(larkAppId: string, chatId: string): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
  return r.ok;
}

async function loadProfileEntry(profileId: string, larkAppId: string): Promise<RoleProfileEntryData> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`);
  return r.json();
}

async function saveProfileEntry(profileId: string, larkAppId: string, content: string): Promise<boolean> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowEmpty: true }),
  });
  return r.ok;
}

async function deleteProfileEntry(profileId: string, larkAppId: string): Promise<boolean> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, { method: 'DELETE' });
  return r.ok;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function botRoleCount(group: GroupInfo): number {
  return group.memberBots.filter(b => b.inChat && b.hasRole).length;
}

function botInChatCount(group: GroupInfo): number {
  return group.memberBots.filter(b => b.inChat).length;
}

function profileHasEntry(profile: RoleProfileSummary, larkAppId: string): boolean {
  return (profile.botEntries ?? []).some(entry => entry.larkAppId === larkAppId && entry.hasEntry);
}

function entryForBot(larkAppId: string): RoleProfileEntry | undefined {
  return profileEntries.find(entry => entry.larkAppId === larkAppId);
}

function switchTab(tab: 'groups' | 'profiles'): void {
  activeTab = tab;
  document.getElementById('roles-by-group-view')?.toggleAttribute('hidden', tab !== 'groups');
  document.getElementById('roles-profiles-view')?.toggleAttribute('hidden', tab !== 'profiles');
}

function renderRolesGroupProfileStatus(group: GroupInfo): string {
  if (!profiles.length || !groupProfileContextLoaded) return '';
  const rolesByBot = new Map<string, EffectiveRoleValue>();
  for (const bot of group.memberBots) {
    if (!bot.inChat) continue;
    rolesByBot.set(bot.larkAppId, groupEffectiveRolesByBot.get(roleKey(bot.larkAppId, group.chatId)) ?? null);
  }
  if (!hasExplicitChatRole(rolesByBot)) return '';
  const best = summarizeGroupProfileMatches(group.memberBots, profiles, groupProfileEntriesById, rolesByBot)[0];
  if (!best) return `<div class="roles-profile-match muted">${t('groups.profileStatusUnmatched')}</div>`;
  const key = best.kind === 'full' ? 'groups.profileStatusFullChat' : 'groups.profileStatusPartial';
  return `<div class="roles-profile-match ${best.kind}">
    ${escapeHtml(t(key, {
      name: best.profileId,
      matched: best.matched,
      total: best.total,
      chat: best.chatMatched,
    }))}
  </div>`;
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
            ${renderRolesGroupProfileStatus(g)}
          </div>
          <span class="roles-group-chevron"></span>
        </div>
        <div class="roles-bot-list">${botRows}</div>
      </div>`;
  }).join('');

  tree.querySelectorAll('.roles-group-row').forEach(row => {
    row.addEventListener('click', () => {
      const gid = (row as HTMLElement).dataset.groupId;
      if (!gid) return;
      if (expandedGroups.has(gid)) expandedGroups.delete(gid);
      else expandedGroups.add(gid);
      renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
    });
  });

  tree.querySelectorAll('.roles-bot-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = (row as HTMLElement).dataset.groupId;
      const bid = (row as HTMLElement).dataset.botId;
      if (gid && bid) selectBot(gid, bid);
    });
  });
}

async function selectBot(groupId: string, botId: string, generation = activeRolesGeneration): Promise<void> {
  selectedGroupId = groupId;
  selectedBotId = botId;

  const role = await loadRole(botId, groupId);
  if (!isRolesGeneration(generation)) return;

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
  editingInjectMode = role.injectMode === 'once' ? 'once' : 'every';
  if (textarea) {
    textarea.value = editingContent;
    textarea.focus();
  }
  const injectSel = document.getElementById('roles-editor-inject-mode') as HTMLSelectElement | null;
  if (injectSel) injectSel.value = editingInjectMode;
  updateByteCount();
  updatePreview();
  renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');

  const delBtn = document.getElementById('roles-delete');
  if (delBtn) delBtn.style.display = role.hasRole ? '' : 'none';
}

function updateByteCount(): void {
  const el = document.getElementById('roles-editor-bytecount');
  if (!el) return;
  const len = byteLength(editingContent);
  el.textContent = `${len} / ${MAX_ROLE_BYTES} bytes`;
  el.className = `roles-bytecount ${len > ROLE_WARN_BYTES ? 'warn' : ''} ${len > MAX_ROLE_BYTES ? 'over' : ''}`;
  updateSaveButton(len);
}

function updateSaveButton(byteLen?: number): void {
  const btn = document.getElementById('roles-save') as HTMLButtonElement | null;
  if (!btn) return;
  const len = byteLen ?? byteLength(editingContent);
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
  editingInjectMode = 'every';

  const empty = document.getElementById('roles-editor-empty');
  const form = document.getElementById('roles-editor-form');
  const textarea = document.getElementById('roles-editor-textarea') as HTMLTextAreaElement;
  const delBtn = document.getElementById('roles-delete');

  if (empty) empty.style.display = '';
  if (form) form.style.display = 'none';
  if (textarea) textarea.value = '';
  if (delBtn) delBtn.style.display = 'none';
}

function renderProfileList(filter: string = ''): void {
  const list = document.getElementById('roles-profile-list');
  if (!list) return;
  const q = filter.toLowerCase();
  const filtered = profiles.filter(p => !q || p.profileId.toLowerCase().includes(q));

  if (filtered.length === 0) {
    list.innerHTML = `<div class="roles-empty">${t('roles.profileEmpty')}</div>`;
    return;
  }

  list.innerHTML = filtered.map(p => {
    const selected = selectedProfileId === p.profileId;
    const hasAnyLocal = (p.botEntries ?? []).some(entry => entry.hasEntry);
    return `
      <div class="roles-profile-row ${selected ? 'selected' : ''}" data-profile-id="${escapeHtml(p.profileId)}">
        <div class="roles-profile-row-main">
          <div class="roles-profile-name">${escapeHtml(p.profileId)}</div>
          <div class="roles-group-meta">${p.entryCount} ${t('roles.profileEntries')}</div>
        </div>
        <span class="roles-badge ${hasAnyLocal ? 'has-role' : 'no-role'}">${hasAnyLocal ? t('roles.configured') : t('roles.profileMissing')}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.roles-profile-row').forEach(row => {
    row.addEventListener('click', () => {
      const profileId = (row as HTMLElement).dataset.profileId;
      if (profileId) void selectProfile(profileId);
    });
  });
}

async function selectProfile(profileId: string, generation = activeRolesGeneration): Promise<void> {
  if (!isValidProfileId(profileId.trim())) return;
  selectedProfileId = profileId.trim();
  selectedProfileBotId = null;
  profileEditingContent = '';
  selectedApplyGroupId = selectedApplyGroupId ?? cache[0]?.chatId ?? null;
  await loadProfileEntries(selectedProfileId);
  if (!isRolesGeneration(generation)) return;
  renderProfileList((document.getElementById('roles-profile-search') as HTMLInputElement)?.value ?? '');
  renderProfileDetail();
}

function renderProfileDetail(): void {
  const empty = document.getElementById('roles-profile-empty');
  const detail = document.getElementById('roles-profile-detail');
  if (!empty || !detail) return;

  if (!selectedProfileId) {
    empty.style.display = '';
    detail.style.display = 'none';
    detail.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  detail.style.display = '';
  const selectedBot = allBots.find(b => b.larkAppId === selectedProfileBotId);
  const entry = selectedProfileBotId ? entryForBot(selectedProfileBotId) : undefined;

  detail.innerHTML = `
    <div class="roles-profile-title">
      <div>
        <div class="roles-editor-breadcrumb">
          <span>${escapeHtml(selectedProfileId)}</span>
          ${selectedBot ? `<span class="roles-breadcrumb-sep">›</span><span>${escapeHtml(selectedBot.botName ?? selectedBot.larkAppId)}</span>` : ''}
        </div>
        <div class="roles-editor-meta-line">${t('roles.profileRuntimeHint')}</div>
      </div>
    </div>
    <div class="roles-profile-grid">
      <div class="roles-profile-bots">
        <div class="roles-profile-section-title">${t('roles.profileBots')}</div>
        <div class="roles-profile-bot-list">
          ${allBots.map(bot => {
            const hasEntry = !!entryForBot(bot.larkAppId);
            const selected = selectedProfileBotId === bot.larkAppId;
            return `
              <div class="roles-bot-row roles-profile-bot-row ${selected ? 'selected' : ''}" data-profile-bot-id="${escapeHtml(bot.larkAppId)}">
                ${botAvatarHtml({ name: bot.botName, larkAppId: bot.larkAppId, size: 'sm' })}
                <div class="roles-bot-info">
                  <div class="roles-bot-name">${escapeHtml(bot.botName ?? bot.larkAppId)}</div>
                  <div class="roles-bot-id">${escapeHtml(bot.larkAppId)}</div>
                </div>
                <span class="roles-badge ${hasEntry ? 'has-role' : 'no-role'}">${hasEntry ? t('roles.configured') : t('roles.unconfigured')}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
      <div class="roles-profile-editor">
        ${selectedProfileBotId ? `
          <textarea id="roles-profile-textarea" placeholder="${t('roles.profileEditorPlaceholder')}" rows="12">${escapeHtml(profileEditingContent || entry?.content || '')}</textarea>
          <div class="roles-editor-footer">
            <span id="roles-profile-bytecount" class="roles-bytecount"></span>
            <div class="roles-editor-actions">
              <button type="button" id="roles-profile-delete" class="danger" ${entry ? '' : 'style="display:none"'}>${t('roles.delete')}</button>
              <button type="button" id="roles-profile-save" class="primary">${t('roles.saveEntry')}</button>
            </div>
          </div>
          <div id="roles-profile-preview" class="roles-preview"></div>
        ` : `<div class="roles-editor-empty roles-profile-inline-empty">${t('roles.profileBotSelectHint')}</div>`}
      </div>
    </div>
    <div class="roles-profile-apply">
      <div class="roles-profile-section-title">${t('roles.applyToGroup')}</div>
      <div class="roles-profile-apply-controls">
        <select id="roles-profile-apply-group">
          ${cache.map(g => `<option value="${escapeHtml(g.chatId)}" ${selectedApplyGroupId === g.chatId ? 'selected' : ''}>${escapeHtml(g.name ?? g.chatId)}</option>`).join('')}
        </select>
        <label class="roles-profile-force"><input type="checkbox" id="roles-profile-apply-force"> ${t('roles.applyForce')}</label>
      </div>
      <div id="roles-profile-apply-bots"></div>
      <div class="roles-editor-actions">
        <button type="button" id="roles-profile-preview-apply">${t('roles.previewApply')}</button>
        <button type="button" id="roles-profile-apply" class="primary">${t('roles.applyProfile')}</button>
      </div>
      <div id="roles-profile-apply-status" class="roles-profile-status"></div>
    </div>
  `;

  detail.querySelectorAll('.roles-profile-bot-row').forEach(row => {
    row.addEventListener('click', () => {
      const botId = (row as HTMLElement).dataset.profileBotId;
      if (botId) void selectProfileBot(botId);
    });
  });
  renderProfileApplyBots();
  bindProfileEditor();
}

async function selectProfileBot(botId: string, generation = activeRolesGeneration): Promise<void> {
  if (!selectedProfileId) return;
  selectedProfileBotId = botId;
  const entry = await loadProfileEntry(selectedProfileId, botId);
  if (!isRolesGeneration(generation)) return;
  profileEditingContent = entry.content ?? '';
  await loadProfileEntries(selectedProfileId);
  if (!isRolesGeneration(generation)) return;
  renderProfileDetail();
}

function bindProfileEditor(): void {
  const generation = activeRolesGeneration;
  const textarea = document.getElementById('roles-profile-textarea') as HTMLTextAreaElement | null;
  if (textarea) {
    profileEditingContent = textarea.value;
    updateProfileByteCount();
    updateProfilePreview();
    textarea.addEventListener('input', (e) => {
      profileEditingContent = (e.target as HTMLTextAreaElement).value;
      updateProfileByteCount();
      updateProfilePreview();
    });
  }

  document.getElementById('roles-profile-save')?.addEventListener('click', async function(this: HTMLButtonElement) {
    if (!selectedProfileId || !selectedProfileBotId) return;
    this.disabled = true;
    this.textContent = '...';
    try {
      const ok = await saveProfileEntry(selectedProfileId, selectedProfileBotId, profileEditingContent);
      if (!isRolesGeneration(generation)) return;
      await loadProfiles();
      if (!isRolesGeneration(generation)) return;
      await loadProfileEntries(selectedProfileId);
      if (!isRolesGeneration(generation)) return;
      renderProfileList((document.getElementById('roles-profile-search') as HTMLInputElement)?.value ?? '');
      void refreshGroupProfileContext(generation);
      renderProfileDetail();
      flashProfileStatus(ok ? t('roles.saved') : t('roles.saveFailed'), !ok);
    } finally {
      if (!isRolesGeneration(generation)) return;
      this.disabled = false;
      this.textContent = t('roles.saveEntry');
    }
  });

  document.getElementById('roles-profile-delete')?.addEventListener('click', async function(this: HTMLButtonElement) {
    if (!selectedProfileId || !selectedProfileBotId) return;
    if (!confirm(t('roles.confirmDeleteProfileEntry'))) return;
    this.disabled = true;
    try {
      await deleteProfileEntry(selectedProfileId, selectedProfileBotId);
      if (!isRolesGeneration(generation)) return;
      profileEditingContent = '';
      await loadProfiles();
      if (!isRolesGeneration(generation)) return;
      await loadProfileEntries(selectedProfileId);
      if (!isRolesGeneration(generation)) return;
      renderProfileList((document.getElementById('roles-profile-search') as HTMLInputElement)?.value ?? '');
      void refreshGroupProfileContext(generation);
      renderProfileDetail();
    } finally {
      if (!isRolesGeneration(generation)) return;
      this.disabled = false;
    }
  });

  document.getElementById('roles-profile-apply-group')?.addEventListener('change', (e) => {
    selectedApplyGroupId = (e.target as HTMLSelectElement).value;
    renderProfileApplyBots();
  });
  document.getElementById('roles-profile-preview-apply')?.addEventListener('click', () => runProfileApply(true, generation));
  document.getElementById('roles-profile-apply')?.addEventListener('click', () => runProfileApply(false, generation));
}

function updateProfileByteCount(): void {
  const el = document.getElementById('roles-profile-bytecount');
  const btn = document.getElementById('roles-profile-save') as HTMLButtonElement | null;
  if (!el) return;
  const len = byteLength(profileEditingContent);
  el.textContent = `${len} / ${MAX_ROLE_BYTES} bytes`;
  el.className = `roles-bytecount ${len > ROLE_WARN_BYTES ? 'warn' : ''} ${len > MAX_ROLE_BYTES ? 'over' : ''}`;
  if (btn) btn.disabled = len > MAX_ROLE_BYTES || profileEditingContent.trim().length === 0;
}

function updateProfilePreview(): void {
  const preview = document.getElementById('roles-profile-preview');
  if (!preview) return;
  preview.innerHTML = profileEditingContent.trim()
    ? `<strong>${t('roles.preview')}</strong><pre>${escapeHtml(profileEditingContent)}</pre>`
    : `<small>${t('roles.previewEmpty')}</small>`;
}

function renderProfileApplyBots(): void {
  const wrap = document.getElementById('roles-profile-apply-bots');
  if (!wrap) return;
  const groupId = selectedApplyGroupId ?? cache[0]?.chatId ?? '';
  const group = cache.find(g => g.chatId === groupId);
  const bots = group?.memberBots.filter(b => b.inChat) ?? [];
  if (!group || bots.length === 0) {
    wrap.innerHTML = `<div class="roles-empty">${t('roles.noChats')}</div>`;
    return;
  }
  wrap.innerHTML = bots.map(bot => {
    const hasEntry = !!entryForBot(bot.larkAppId);
    return `
      <label class="checkbox-row roles-profile-apply-bot">
        <input type="checkbox" name="profile-apply-bot" value="${escapeHtml(bot.larkAppId)}" ${hasEntry ? 'checked' : ''}>
        <span>${escapeHtml(bot.botName ?? bot.larkAppId)}</span>
        <small>${hasEntry ? t('roles.configured') : t('roles.profileMissing')}</small>
      </label>`;
  }).join('');
}

async function runProfileApply(preview: boolean, generation = activeRolesGeneration): Promise<void> {
  const profileId = selectedProfileId;
  if (!profileId) return;
  const groupId = selectedApplyGroupId ?? cache[0]?.chatId;
  if (!groupId) return;
  const force = (document.getElementById('roles-profile-apply-force') as HTMLInputElement | null)?.checked === true;
  const selected = [...document.querySelectorAll<HTMLInputElement>('input[name=profile-apply-bot]:checked')].map(i => i.value);
  const status = document.getElementById('roles-profile-apply-status');
  if (selected.length === 0) {
    if (status) status.textContent = t('roles.applyPickBots');
    return;
  }
  if (status) status.textContent = '...';
  const results = await Promise.all(selected.map(async larkAppId => {
    const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: groupId, larkAppId, force, preview }),
    });
    const body = await r.json().catch(() => ({}));
    return { larkAppId, ok: r.ok && body.ok !== false, status: r.status, error: body.error, wouldRefuse: body.wouldRefuse };
  }));
  if (!isRolesGeneration(generation)) return;
  if (status) {
    status.innerHTML = results.map(r => {
      const bot = allBots.find(b => b.larkAppId === r.larkAppId);
      const label = escapeHtml(bot?.botName ?? r.larkAppId);
      const outcome = r.ok
        ? (preview ? (r.wouldRefuse ? t('roles.applyWouldRefuse') : t('roles.applyPreviewOk')) : t('roles.applyOk'))
        : `${t('roles.applyFailed')}: ${escapeHtml(r.error ?? `HTTP ${r.status}`)}`;
      return `<div>${label}: ${outcome}</div>`;
    }).join('');
  }
  if (!preview) {
    await loadGroups();
    if (!isRolesGeneration(generation)) return;
    renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
    void refreshGroupProfileContext(generation);
  }
}

function flashProfileStatus(text: string, isError = false): void {
  const footer = document.querySelector('#roles-profile-detail .roles-editor-footer');
  if (!footer) return;
  const statusEl = document.createElement('span');
  statusEl.className = `roles-saved-flash ${isError ? 'roles-save-error' : ''}`;
  statusEl.textContent = ` ${text}`;
  footer.appendChild(statusEl);
  scheduleRolesTimer(() => statusEl.remove(), isError ? 3000 : 2000);
}

export function wireRolesSurface(root: HTMLElement, tab: 'groups' | 'profiles'): () => void {
  const generation = activeRolesGeneration + 1;
  activeRolesGeneration = generation;
  const timers = new Set<number>();
  activeRolesTimerState = { generation, timers };
  const cleanups: Array<() => void> = [];
  let disposed = false;
  const isLive = () => !disposed && isRolesGeneration(generation);
  const on = (el: Element | null, type: string, listener: EventListener) => {
    if (!el) return;
    el.addEventListener(type, listener);
    cleanups.push(() => el.removeEventListener(type, listener));
  };

  activeTab = tab;
  expandedGroups.clear();
  groupProfileContextLoaded = false;
  resetEditor();
  switchTab(activeTab);

  const treeEl = root.querySelector<HTMLElement>('#roles-tree');
  const profileListEl = root.querySelector<HTMLElement>('#roles-profile-list');
  if (treeEl) treeEl.innerHTML = loadingHtml();
  if (profileListEl) profileListEl.innerHTML = loadingHtml();

  void (async () => {
    await loadGroups();
    if (!isLive()) return;
    await loadProfiles();
    if (!isLive()) return;
    await loadNameMaps();
    if (!isLive()) return;

    if (tab === 'profiles') {
      const requestedChatId = hashChatId();
      if (requestedChatId && cache.some(g => g.chatId === requestedChatId)) {
        selectedApplyGroupId = requestedChatId;
      }
    }

    for (const g of cache) {
      if (botRoleCount(g) > 0) expandedGroups.add(g.chatId);
    }
    renderTree();
    renderProfileList();
    if (selectedProfileId) await selectProfile(selectedProfileId, generation);
    if (!isLive()) return;
    void refreshGroupProfileContext(generation);
  })();

  on(root.querySelector('#roles-search'), 'input', (e) => {
    if (!isLive()) return;
    renderTree((e.target as HTMLInputElement).value);
  });

  on(root.querySelector('#roles-refresh'), 'click', async () => {
    if (!isLive()) return;
    await loadGroups();
    if (!isLive()) return;
    renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
    void refreshGroupProfileContext(generation);
    if (selectedGroupId && selectedBotId) {
      const role = await loadRole(selectedBotId, selectedGroupId);
      if (!isLive()) return;
      const textarea = document.getElementById('roles-editor-textarea') as HTMLTextAreaElement;
      if (textarea) textarea.value = role.content ?? '';
      editingContent = role.content ?? '';
      editingInjectMode = role.injectMode === 'once' ? 'once' : 'every';
      const injectSel = document.getElementById('roles-editor-inject-mode') as HTMLSelectElement | null;
      if (injectSel) injectSel.value = editingInjectMode;
      updateByteCount();
      updatePreview();
      const delBtn = document.getElementById('roles-delete');
      if (delBtn) delBtn.style.display = role.hasRole ? '' : 'none';
    }
  });

  on(root.querySelector('#roles-save'), 'click', async (e) => {
    if (!selectedGroupId || !selectedBotId) return;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const ok = await saveRole(selectedBotId, selectedGroupId, editingContent, editingInjectMode);
      if (!isLive()) return;
      if (ok) {
        await loadGroups();
        if (!isLive()) return;
        renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
        void refreshGroupProfileContext(generation);
        const delBtn = document.getElementById('roles-delete');
        if (delBtn) delBtn.style.display = '';
        const statusEl = document.createElement('span');
        statusEl.className = 'roles-saved-flash';
        statusEl.textContent = ` ${t('roles.saved')}`;
        const footer = document.querySelector('.roles-editor-footer');
        footer?.appendChild(statusEl);
        scheduleRolesTimer(() => statusEl.remove(), 2000);
      } else {
        const statusEl = document.createElement('span');
        statusEl.className = 'roles-saved-flash roles-save-error';
        statusEl.textContent = editingContent.trim().length === 0
          ? ` ${t('roles.emptyError')}`
          : ` ${t('roles.saveFailed')}`;
        const footer = document.querySelector('.roles-editor-footer');
        footer?.appendChild(statusEl);
        scheduleRolesTimer(() => statusEl.remove(), 3000);
      }
    } finally {
      if (!isLive()) return;
      btn.disabled = false;
      btn.textContent = t('roles.save');
    }
  });

  on(root.querySelector('#roles-delete'), 'click', async (e) => {
    if (!selectedGroupId || !selectedBotId) return;
    if (!confirm(t('roles.confirmDelete'))) return;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const ok = await deleteRole(selectedBotId, selectedGroupId);
      if (!isLive()) return;
      if (ok) {
        await loadGroups();
        if (!isLive()) return;
        resetEditor();
        renderTree((document.getElementById('roles-search') as HTMLInputElement)?.value ?? '');
        void refreshGroupProfileContext(generation);
      }
    } finally {
      if (!isLive()) return;
      btn.disabled = false;
      btn.textContent = t('roles.delete');
    }
  });

  on(root.querySelector('#roles-editor-textarea'), 'input', (e) => {
    if (!isLive()) return;
    editingContent = (e.target as HTMLTextAreaElement).value;
    updateByteCount();
    updatePreview();
  });

  // Injection-mode select auto-saves on change (it can apply even when the chat
  // has no own role and inherits the team default, so it doesn't ride only on
  // the content Save button).
  on(root.querySelector('#roles-editor-inject-mode'), 'change', async (e) => {
    if (!isLive()) return;
    if (!selectedGroupId || !selectedBotId) return;
    const sel = e.target as HTMLSelectElement;
    const mode: RoleInjectMode = sel.value === 'once' ? 'once' : 'every';
    const prev = editingInjectMode;
    editingInjectMode = mode;
    sel.disabled = true;
    try {
      const ok = await saveInjectMode(selectedBotId, selectedGroupId, mode);
      if (!isLive()) return;
      if (!ok) {
        editingInjectMode = prev;
        sel.value = prev;
      }
      const statusEl = document.createElement('span');
      statusEl.className = `roles-saved-flash ${ok ? '' : 'roles-save-error'}`;
      statusEl.textContent = ` ${ok ? t('roles.saved') : t('roles.saveFailed')}`;
      root.querySelector('.roles-editor-inject')?.appendChild(statusEl);
      scheduleRolesTimer(() => statusEl.remove(), ok ? 2000 : 3000);
    } finally {
      if (!isLive()) return;
      sel.disabled = false;
    }
  });

  on(root.querySelector('#roles-profile-search'), 'input', (e) => {
    if (!isLive()) return;
    renderProfileList((e.target as HTMLInputElement).value);
  });
  on(root.querySelector('#roles-profile-refresh'), 'click', async () => {
    if (!isLive()) return;
    await loadGroups();
    if (!isLive()) return;
    await loadProfiles();
    if (!isLive()) return;
    void refreshGroupProfileContext(generation);
    if (selectedProfileId) await loadProfileEntries(selectedProfileId);
    if (!isLive()) return;
    renderProfileList((document.getElementById('roles-profile-search') as HTMLInputElement)?.value ?? '');
    renderProfileDetail();
  });
  on(root.querySelector('#roles-profile-select'), 'click', async () => {
    if (!isLive()) return;
    const input = document.getElementById('roles-profile-id') as HTMLInputElement | null;
    const profileId = input?.value.trim();
    if (!profileId) return;
    if (!isValidProfileId(profileId)) {
      input?.setCustomValidity(t('roles.profileIdInvalid'));
      input?.reportValidity();
      return;
    }
    input?.setCustomValidity('');
    await selectProfile(profileId, generation);
    if (!isLive()) return;
    if (!location.hash.startsWith('#/roles/profile')) {
      location.hash = '#/roles/profile';
    } else {
      switchTab('profiles');
    }
  });
  on(root.querySelector('#roles-profile-id'), 'input', (e) => {
    (e.target as HTMLInputElement).setCustomValidity('');
  });

  return () => {
    disposed = true;
    if (isRolesGeneration(generation)) activeRolesGeneration += 1;
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    if (activeRolesTimerState?.generation === generation) {
      activeRolesTimerState = null;
    }
  };
}
