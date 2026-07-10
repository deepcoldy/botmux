import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { DropdownMenu, Html, LoadingState, RefreshIconButton } from './dashboard-components.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import {
  hasExplicitChatRole,
  summarizeGroupProfileMatches,
  type EffectiveRoleValue,
} from './role-profile-match.js';
import {
  applyRoleProfile,
  botInChatCount,
  botRoleCount,
  byteLength,
  deleteProfileEntry,
  deleteRole,
  entryForBot,
  filterRoleGroups,
  filterRoleProfiles,
  hashChatId,
  isValidProfileId,
  loadGroups,
  loadProfileEntries,
  loadProfileEntry,
  loadProfiles,
  loadRole,
  loadRoleProfileContext,
  MAX_ROLE_BYTES,
  roleKey,
  ROLE_WARN_BYTES,
  saveInjectMode,
  saveProfileEntry,
  saveRole,
  type DashboardBot,
  type GroupInfo,
  type RoleData,
  type RoleInjectMode,
  type RoleProfileApplyResult,
  type RoleProfileContext,
  type RoleProfileEntry,
  type RoleProfileSummary,
} from './roles.js';
import { botAvatarHtml, loadNameMaps } from './ui.js';

type RolesTab = 'groups' | 'profiles';
type Translator = ReturnType<typeof useT>;

type FlashState = { text: string; isError?: boolean; id: number } | null;
type ApplyStatus =
  | { kind: 'idle' }
  | { kind: 'text'; text: string }
  | { kind: 'results'; preview: boolean; results: RoleProfileApplyResult[] };

function useAliveRef() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

function useTimers() {
  const timers = useRef<Set<number>>(new Set());
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  return useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
    return id;
  }, []);
}

function BotAvatar(props: { bot: { botName?: string; larkAppId?: string; botAvatarUrl?: string } }) {
  return (
    <Html html={botAvatarHtml({
      name: props.bot.botName,
      larkAppId: props.bot.larkAppId,
      avatarUrl: props.bot.botAvatarUrl,
      size: 'sm',
    })} />
  );
}

function RolesPage(props: { tab: RolesTab }) {
  const tr = useT();
  const alive = useAliveRef();
  const scheduleTimer = useTimers();
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [allBots, setAllBots] = useState<DashboardBot[]>([]);
  const [profiles, setProfiles] = useState<RoleProfileSummary[]>([]);
  const [roleContext, setRoleContext] = useState<RoleProfileContext>({
    entriesByProfile: new Map(),
    effectiveRolesByBot: new Map(),
  });
  const [roleContextLoaded, setRoleContextLoaded] = useState(false);
  const [loadingTree, setLoadingTree] = useState(true);
  const [profileListLoading, setProfileListLoading] = useState(true);
  const [groupsFilter, setGroupsFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<RoleData | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingInjectMode, setEditingInjectMode] = useState<RoleInjectMode>('every');
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleDeleting, setRoleDeleting] = useState(false);
  const [injectSaving, setInjectSaving] = useState(false);
  const [roleFlash, setRoleFlash] = useState<FlashState>(null);
  const [injectFlash, setInjectFlash] = useState<FlashState>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedProfileBotId, setSelectedProfileBotId] = useState<string | null>(null);
  const [profileEntries, setProfileEntries] = useState<RoleProfileEntry[]>([]);
  const [profileEditingContent, setProfileEditingContent] = useState('');
  const [selectedApplyGroupId, setSelectedApplyGroupId] = useState<string | null>(null);
  const [applyForce, setApplyForce] = useState(false);
  const [selectedApplyBotIds, setSelectedApplyBotIds] = useState<Set<string>>(() => new Set());
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileDeleting, setProfileDeleting] = useState(false);
  const [profileFlash, setProfileFlash] = useState<FlashState>(null);
  const [applyStatus, setApplyStatus] = useState<ApplyStatus>({ kind: 'idle' });
  const selectSerial = useRef(0);
  const profileSelectSerial = useRef(0);
  const profileIdInputRef = useRef<HTMLInputElement | null>(null);

  const selectedGroup = selectedGroupId ? groups.find(group => group.chatId === selectedGroupId) : undefined;
  const selectedBot = selectedGroup && selectedBotId
    ? selectedGroup.memberBots.find(bot => bot.larkAppId === selectedBotId)
    : undefined;
  const selectedProfileBot = selectedProfileBotId
    ? allBots.find(bot => bot.larkAppId === selectedProfileBotId)
    : undefined;
  const selectedProfileEntry = entryForBot(profileEntries, selectedProfileBotId);
  const selectedApplyGroup = selectedApplyGroupId
    ? groups.find(group => group.chatId === selectedApplyGroupId)
    : undefined;
  const selectedApplyBots = selectedApplyGroup?.memberBots.filter(bot => bot.inChat) ?? [];
  const selectedApplyBotKey = selectedApplyBots.map(bot => bot.larkAppId).join('\u0000');
  const profileEntryKey = profileEntries.map(entry => entry.larkAppId).sort().join('\u0000');

  const filteredGroups = useMemo(
    () => filterRoleGroups(groups, groupsFilter),
    [groups, groupsFilter],
  );
  const filteredProfiles = useMemo(
    () => filterRoleProfiles(profiles, profileFilter),
    [profiles, profileFilter],
  );
  const roleByteLen = byteLength(editingContent);
  const profileByteLen = byteLength(profileEditingContent);

  const flash = useCallback((setter: Dispatch<SetStateAction<FlashState>>, text: string, isError = false) => {
    const id = Date.now() + Math.random();
    setter({ text, isError, id });
    scheduleTimer(() => {
      setter(current => current?.id === id ? null : current);
    }, isError ? 3000 : 2000);
  }, [scheduleTimer]);

  const refreshRoleContext = useCallback(async (nextGroups: GroupInfo[], nextProfiles: RoleProfileSummary[]) => {
    try {
      const context = await loadRoleProfileContext(nextGroups, nextProfiles);
      if (!alive.current) return;
      setRoleContext(context);
      setRoleContextLoaded(true);
    } catch {
      if (!alive.current) return;
      setRoleContext({ entriesByProfile: new Map(), effectiveRolesByBot: new Map() });
      setRoleContextLoaded(true);
    }
  }, [alive]);

  const refreshGroups = useCallback(async () => {
    const snapshot = await loadGroups();
    if (!alive.current) return snapshot;
    setGroups(snapshot.groups);
    setAllBots(snapshot.bots);
    return snapshot;
  }, [alive]);

  const refreshProfiles = useCallback(async () => {
    const nextProfiles = await loadProfiles();
    if (!alive.current) return nextProfiles;
    setProfiles(nextProfiles);
    return nextProfiles;
  }, [alive]);

  const loadInitial = useCallback(async () => {
    setLoadingTree(true);
    setProfileListLoading(true);
    setRoleContextLoaded(false);
    try {
      const snapshot = await refreshGroups();
      if (!alive.current) return;
      const nextProfiles = await refreshProfiles();
      if (!alive.current) return;
      await loadNameMaps();
      if (!alive.current) return;

      setExpandedGroups(new Set(snapshot.groups.filter(group => botRoleCount(group) > 0).map(group => group.chatId)));
      if (props.tab === 'profiles') {
        const requestedChatId = hashChatId();
        setSelectedApplyGroupId(current => {
          if (current) return current;
          if (requestedChatId && snapshot.groups.some(group => group.chatId === requestedChatId)) return requestedChatId;
          return snapshot.groups[0]?.chatId ?? null;
        });
      } else {
        setSelectedApplyGroupId(current => current ?? snapshot.groups[0]?.chatId ?? null);
      }
      setLoadingTree(false);
      setProfileListLoading(false);
      void refreshRoleContext(snapshot.groups, nextProfiles);
    } catch {
      if (!alive.current) return;
      setLoadingTree(false);
      setProfileListLoading(false);
      setRoleContextLoaded(true);
    }
  }, [alive, props.tab, refreshGroups, refreshProfiles, refreshRoleContext]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (selectedApplyGroupId || groups.length === 0) return;
    setSelectedApplyGroupId(groups[0].chatId);
  }, [groups, selectedApplyGroupId]);

  useEffect(() => {
    const defaults = new Set(
      selectedApplyBots
        .filter(bot => !!entryForBot(profileEntries, bot.larkAppId))
        .map(bot => bot.larkAppId),
    );
    setSelectedApplyBotIds(defaults);
    setApplyStatus({ kind: 'idle' });
  }, [profileEntryKey, selectedApplyBotKey]); // Re-default only when available bots/entries change.

  async function handleSelectBot(groupId: string, botId: string): Promise<void> {
    const serial = ++selectSerial.current;
    setSelectedGroupId(groupId);
    setSelectedBotId(botId);
    const role = await loadRole(botId, groupId);
    if (!alive.current || serial !== selectSerial.current) return;
    setSelectedRole(role);
    setEditingContent(role.content ?? '');
    setEditingInjectMode(role.injectMode === 'once' ? 'once' : 'every');
    setRoleFlash(null);
    setInjectFlash(null);
  }

  async function handleGroupRefresh(): Promise<void> {
    const snapshot = await refreshGroups();
    if (!alive.current) return;
    void refreshRoleContext(snapshot.groups, profiles);
    if (selectedGroupId && selectedBotId) {
      const role = await loadRole(selectedBotId, selectedGroupId);
      if (!alive.current) return;
      setSelectedRole(role);
      setEditingContent(role.content ?? '');
      setEditingInjectMode(role.injectMode === 'once' ? 'once' : 'every');
    }
  }

  async function handleSaveRole(): Promise<void> {
    if (!selectedGroupId || !selectedBotId) return;
    setRoleSaving(true);
    try {
      const ok = await saveRole(selectedBotId, selectedGroupId, editingContent, editingInjectMode);
      if (!alive.current) return;
      if (ok) {
        const snapshot = await refreshGroups();
        if (!alive.current) return;
        setSelectedRole(prev => prev ? { ...prev, content: editingContent, hasRole: true, injectMode: editingInjectMode } : prev);
        void refreshRoleContext(snapshot.groups, profiles);
        flash(setRoleFlash, tr('roles.saved'));
      } else {
        flash(setRoleFlash, editingContent.trim().length === 0 ? tr('roles.emptyError') : tr('roles.saveFailed'), true);
      }
    } finally {
      if (alive.current) setRoleSaving(false);
    }
  }

  async function handleDeleteRole(): Promise<void> {
    if (!selectedGroupId || !selectedBotId) return;
    if (!confirm(tr('roles.confirmDelete'))) return;
    setRoleDeleting(true);
    try {
      const ok = await deleteRole(selectedBotId, selectedGroupId);
      if (!alive.current) return;
      if (ok) {
        const snapshot = await refreshGroups();
        if (!alive.current) return;
        setSelectedGroupId(null);
        setSelectedBotId(null);
        setSelectedRole(null);
        setEditingContent('');
        setEditingInjectMode('every');
        void refreshRoleContext(snapshot.groups, profiles);
      }
    } finally {
      if (alive.current) setRoleDeleting(false);
    }
  }

  async function handleInjectModeChange(mode: RoleInjectMode): Promise<void> {
    if (!selectedGroupId || !selectedBotId) return;
    const prev = editingInjectMode;
    setEditingInjectMode(mode);
    setInjectSaving(true);
    try {
      const ok = await saveInjectMode(selectedBotId, selectedGroupId, mode);
      if (!alive.current) return;
      if (!ok) setEditingInjectMode(prev);
      flash(setInjectFlash, ok ? tr('roles.saved') : tr('roles.saveFailed'), !ok);
    } finally {
      if (alive.current) setInjectSaving(false);
    }
  }

  async function handleSelectProfile(profileId: string): Promise<void> {
    const clean = profileId.trim();
    if (!isValidProfileId(clean)) return;
    const serial = ++profileSelectSerial.current;
    setSelectedProfileId(clean);
    setSelectedProfileBotId(null);
    setProfileEditingContent('');
    setApplyStatus({ kind: 'idle' });
    setSelectedApplyGroupId(current => current ?? groups[0]?.chatId ?? null);
    const entries = await loadProfileEntries(clean);
    if (!alive.current || serial !== profileSelectSerial.current) return;
    setProfileEntries(entries);
    setProfileFlash(null);
  }

  async function handleSelectProfileBot(botId: string): Promise<void> {
    if (!selectedProfileId) return;
    const serial = ++profileSelectSerial.current;
    setSelectedProfileBotId(botId);
    const entry = await loadProfileEntry(selectedProfileId, botId);
    if (!alive.current || serial !== profileSelectSerial.current) return;
    setProfileEditingContent(entry.content ?? '');
    const entries = await loadProfileEntries(selectedProfileId);
    if (!alive.current || serial !== profileSelectSerial.current) return;
    setProfileEntries(entries);
    setProfileFlash(null);
  }

  async function handleProfileRefresh(): Promise<void> {
    const snapshot = await refreshGroups();
    if (!alive.current) return;
    const nextProfiles = await refreshProfiles();
    if (!alive.current) return;
    if (selectedProfileId) {
      const entries = await loadProfileEntries(selectedProfileId);
      if (!alive.current) return;
      setProfileEntries(entries);
    }
    void refreshRoleContext(snapshot.groups, nextProfiles);
  }

  async function handleOpenProfile(): Promise<void> {
    const input = profileIdInputRef.current;
    const profileId = input?.value.trim() ?? '';
    if (!profileId) return;
    if (!isValidProfileId(profileId)) {
      input?.setCustomValidity(tr('roles.profileIdInvalid'));
      input?.reportValidity();
      return;
    }
    input?.setCustomValidity('');
    await handleSelectProfile(profileId);
    if (!alive.current) return;
    if (!location.hash.startsWith('#/roles/profile')) {
      location.hash = '#/roles/profile';
    }
  }

  async function handleSaveProfileEntry(): Promise<void> {
    if (!selectedProfileId || !selectedProfileBotId) return;
    setProfileSaving(true);
    try {
      const ok = await saveProfileEntry(selectedProfileId, selectedProfileBotId, profileEditingContent);
      if (!alive.current) return;
      const nextProfiles = await refreshProfiles();
      if (!alive.current) return;
      const entries = await loadProfileEntries(selectedProfileId);
      if (!alive.current) return;
      setProfileEntries(entries);
      void refreshRoleContext(groups, nextProfiles);
      flash(setProfileFlash, ok ? tr('roles.saved') : tr('roles.saveFailed'), !ok);
    } finally {
      if (alive.current) setProfileSaving(false);
    }
  }

  async function handleDeleteProfileEntry(): Promise<void> {
    if (!selectedProfileId || !selectedProfileBotId) return;
    if (!confirm(tr('roles.confirmDeleteProfileEntry'))) return;
    setProfileDeleting(true);
    try {
      await deleteProfileEntry(selectedProfileId, selectedProfileBotId);
      if (!alive.current) return;
      setProfileEditingContent('');
      const nextProfiles = await refreshProfiles();
      if (!alive.current) return;
      const entries = await loadProfileEntries(selectedProfileId);
      if (!alive.current) return;
      setProfileEntries(entries);
      void refreshRoleContext(groups, nextProfiles);
    } finally {
      if (alive.current) setProfileDeleting(false);
    }
  }

  function toggleApplyBot(botId: string, checked: boolean): void {
    setSelectedApplyBotIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(botId);
      else next.delete(botId);
      return next;
    });
  }

  async function runProfileApply(preview: boolean): Promise<void> {
    if (!selectedProfileId) return;
    const groupId = selectedApplyGroupId ?? groups[0]?.chatId;
    if (!groupId) return;
    const selected = [...selectedApplyBotIds];
    if (selected.length === 0) {
      setApplyStatus({ kind: 'text', text: tr('roles.applyPickBots') });
      return;
    }
    setApplyStatus({ kind: 'text', text: '...' });
    const results = await Promise.all(selected.map(larkAppId => applyRoleProfile({
      profileId: selectedProfileId,
      chatId: groupId,
      larkAppId,
      force: applyForce,
      preview,
    })));
    if (!alive.current) return;
    setApplyStatus({ kind: 'results', preview, results });
    if (!preview) {
      const snapshot = await refreshGroups();
      if (!alive.current) return;
      void refreshRoleContext(snapshot.groups, profiles);
    }
  }

  const roleSaveDisabled = roleSaving || roleByteLen > MAX_ROLE_BYTES || editingContent.trim().length === 0;
  const profileSaveDisabled = profileSaving || profileByteLen > MAX_ROLE_BYTES || profileEditingContent.trim().length === 0;
  const isProfiles = props.tab === 'profiles';
  const tabs = (
    <nav className="roles-subnav insight-tabs" role="tablist" aria-label={tr('roles.title')}>
      <a href="#/roles" className={`itab${isProfiles ? '' : ' on'}`} role="tab" aria-selected={!isProfiles}>{tr('roles.tabGroups')}</a>
      <a href="#/roles/profile" className={`itab${isProfiles ? ' on' : ''}`} role="tab" aria-selected={isProfiles}>{tr('roles.tabProfiles')}</a>
    </nav>
  );

  return (
    <section className="page roles-page">
      <div className="page-heading roles-heading">
        <div>
          <p className="eyebrow">{tr('nav.roles')}</p>
          <h1>{tr('roles.title')}</h1>
        </div>
        <div className="page-heading-actions">{tabs}</div>
      </div>

      <div id="roles-by-group-view" className="roles-layout" hidden={isProfiles}>
        <div className="roles-tree-panel">
          <div className="roles-tree-header dashboard-toolbar">
            <input type="search" id="roles-search" placeholder={tr('roles.search')} value={groupsFilter} onChange={ev => setGroupsFilter(ev.target.value)} />
            <RefreshIconButton id="roles-refresh" label={tr('roles.refresh')} onClick={() => void handleGroupRefresh()} />
          </div>
          <div id="roles-tree" className="roles-tree">
            {loadingTree ? <LoadingState label={tr('common.loading')} /> : (
              <GroupsTree
                groups={filteredGroups}
                profiles={profiles}
                context={roleContext}
                contextLoaded={roleContextLoaded}
                expandedGroups={expandedGroups}
                selectedGroupId={selectedGroupId}
                selectedBotId={selectedBotId}
                tr={tr}
                onToggleGroup={groupId => setExpandedGroups(prev => toggleSet(prev, groupId))}
                onSelectBot={(groupId, botId) => void handleSelectBot(groupId, botId)}
              />
            )}
          </div>
        </div>
        <div className="roles-editor-panel">
          {!selectedGroupId || !selectedBotId ? (
            <div id="roles-editor-empty" className="roles-editor-empty">{tr('roles.selectHint')}</div>
          ) : (
            <div id="roles-editor-form" className="roles-editor-form">
              <div className="roles-editor-head">
                <div>
                  <div className="roles-editor-breadcrumb">
                    <span id="roles-editor-group-name">{selectedGroup?.name ?? selectedGroupId}</span>
                    <span className="roles-breadcrumb-sep">›</span>
                    <span id="roles-editor-bot-name">{selectedBot?.botName ?? selectedBotId}</span>
                  </div>
                  <div className="roles-editor-meta">
                    <span id="roles-editor-chat-id" className="roles-editor-meta-line">{selectedGroupId}  ·  {selectedBotId}</span>
                  </div>
                </div>
                <div className="roles-editor-actions roles-editor-head-actions">
                  <button
                    type="button"
                    id="roles-delete"
                    className="danger"
                    style={{ display: selectedRole?.hasRole ? '' : 'none' }}
                    disabled={roleDeleting}
                    onClick={() => void handleDeleteRole()}
                  >
                    {roleDeleting ? '...' : tr('roles.delete')}
                  </button>
                  <button
                    type="button"
                    id="roles-save"
                    className="primary"
                    disabled={roleSaveDisabled}
                    onClick={() => void handleSaveRole()}
                  >
                    {roleSaving ? '...' : tr('roles.save')}
                  </button>
                </div>
              </div>
              <div className="roles-editor-inject">
                <span className="roles-field-label">{tr('roles.injectModeLabel')}</span>
                <DropdownMenu
                  id="roles-editor-inject-mode"
                  className="roles-inline-menu"
                  ariaLabel={tr('roles.injectModeLabel')}
                  disabled={injectSaving}
                  label={editingInjectMode === 'once' ? tr('roles.injectModeOnce') : tr('roles.injectModeEvery')}
                  value={editingInjectMode}
                  options={[
                    { value: 'every', label: tr('roles.injectModeEvery') },
                    { value: 'once', label: tr('roles.injectModeOnce') },
                  ]}
                  onChange={mode => void handleInjectModeChange(mode === 'once' ? 'once' : 'every')}
                />
                <span className="roles-editor-inject-hint">{tr('roles.injectModeHint')}</span>
                <Flash flash={injectFlash} />
              </div>
              <textarea
                id="roles-editor-textarea"
                placeholder={tr('roles.editorPlaceholder')}
                rows={14}
                value={editingContent}
                onChange={ev => setEditingContent(ev.target.value)}
              />
              <div className="roles-editor-footer">
                <span id="roles-editor-bytecount" className={byteCountClass(roleByteLen)}>{roleByteLen} / {MAX_ROLE_BYTES} bytes</span>
                <Flash flash={roleFlash} />
              </div>
              <RolePreview content={editingContent} tr={tr} id="roles-preview" />
            </div>
          )}
        </div>
      </div>

      <div id="roles-profiles-view" className="roles-layout roles-profiles-layout" hidden={!isProfiles}>
        <div className="roles-tree-panel">
          <div className="roles-tree-header roles-profile-create dashboard-toolbar">
            <input
              type="text"
              id="roles-profile-id"
              placeholder={tr('roles.profileIdPlaceholder')}
              maxLength={64}
              ref={profileIdInputRef}
              onChange={ev => ev.currentTarget.setCustomValidity('')}
            />
            <button type="button" id="roles-profile-select" onClick={() => void handleOpenProfile()}>{tr('roles.openProfile')}</button>
          </div>
          <div className="roles-tree-header dashboard-toolbar">
            <input type="search" id="roles-profile-search" placeholder={tr('roles.profileSearch')} value={profileFilter} onChange={ev => setProfileFilter(ev.target.value)} />
            <RefreshIconButton id="roles-profile-refresh" label={tr('roles.refresh')} onClick={() => void handleProfileRefresh()} />
          </div>
          <div id="roles-profile-list" className="roles-tree">
            {profileListLoading ? <LoadingState label={tr('common.loading')} /> : (
              <ProfileList
                profiles={filteredProfiles}
                selectedProfileId={selectedProfileId}
                tr={tr}
                onSelect={profileId => void handleSelectProfile(profileId)}
              />
            )}
          </div>
        </div>
        <div className="roles-editor-panel">
          {!selectedProfileId ? (
            <div id="roles-profile-empty" className="roles-editor-empty">{tr('roles.profileSelectHint')}</div>
          ) : (
            <div id="roles-profile-detail" className="roles-editor-form roles-profile-detail">
              <div className="roles-profile-title">
                <div>
                  <div className="roles-editor-breadcrumb">
                    <span>{selectedProfileId}</span>
                    {selectedProfileBot ? (
                      <>
                        <span className="roles-breadcrumb-sep">›</span>
                        <span>{selectedProfileBot.botName ?? selectedProfileBot.larkAppId}</span>
                      </>
                    ) : null}
                  </div>
                  <div className="roles-editor-meta-line">{tr('roles.profileRuntimeHint')}</div>
                </div>
              </div>
              <div className="roles-profile-grid">
                <div className="roles-profile-bots">
                  <div className="roles-profile-section-title">{tr('roles.profileBots')}</div>
                  <div className="roles-profile-bot-list">
                    {allBots.map(bot => {
                      const hasEntry = !!entryForBot(profileEntries, bot.larkAppId);
                      const selected = selectedProfileBotId === bot.larkAppId;
                      return (
                        <div
                          className={`roles-bot-row roles-profile-bot-row ${selected ? 'selected' : ''}`}
                          data-profile-bot-id={bot.larkAppId}
                          key={bot.larkAppId}
                          onClick={() => void handleSelectProfileBot(bot.larkAppId)}
                        >
                          <BotAvatar bot={bot} />
                          <div className="roles-bot-info">
                            <div className="roles-bot-name">{bot.botName ?? bot.larkAppId}</div>
                            <div className="roles-bot-id">{bot.larkAppId}</div>
                          </div>
                          <span className={`roles-badge ${hasEntry ? 'has-role' : 'no-role'}`}>{hasEntry ? tr('roles.configured') : tr('roles.unconfigured')}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="roles-profile-editor">
                  {selectedProfileBotId ? (
                    <>
                      <div className="roles-profile-editor-head">
                        <span id="roles-profile-bytecount" className={byteCountClass(profileByteLen)}>{profileByteLen} / {MAX_ROLE_BYTES} bytes</span>
                        <div className="roles-editor-actions roles-editor-head-actions">
                          <button
                            type="button"
                            id="roles-profile-delete"
                            className="danger"
                            style={{ display: selectedProfileEntry ? '' : 'none' }}
                            disabled={profileDeleting}
                            onClick={() => void handleDeleteProfileEntry()}
                          >
                            {profileDeleting ? '...' : tr('roles.delete')}
                          </button>
                          <button
                            type="button"
                            id="roles-profile-save"
                            className="primary"
                            disabled={profileSaveDisabled}
                            onClick={() => void handleSaveProfileEntry()}
                          >
                            {profileSaving ? '...' : tr('roles.saveEntry')}
                          </button>
                        </div>
                      </div>
                      <textarea
                        id="roles-profile-textarea"
                        placeholder={tr('roles.profileEditorPlaceholder')}
                        rows={12}
                        value={profileEditingContent}
                        onChange={ev => setProfileEditingContent(ev.target.value)}
                      />
                      <div className="roles-editor-footer">
                        <Flash flash={profileFlash} />
                      </div>
                      <RolePreview content={profileEditingContent} tr={tr} id="roles-profile-preview" />
                    </>
                  ) : (
                    <div className="roles-editor-empty roles-profile-inline-empty">{tr('roles.profileBotSelectHint')}</div>
                  )}
                </div>
              </div>
              <div className="roles-profile-apply">
                <div className="roles-profile-section-title">{tr('roles.applyToGroup')}</div>
                <div className="roles-profile-apply-controls">
                  <DropdownMenu
                    id="roles-profile-apply-group"
                    className="roles-apply-group-menu"
                    ariaLabel={tr('roles.applyToGroup')}
                    disabled={groups.length === 0}
                    label={selectedApplyGroup?.name ?? selectedApplyGroupId ?? tr('roles.noChats')}
                    value={selectedApplyGroupId ?? ''}
                    options={groups.map(group => ({
                      value: group.chatId,
                      label: group.name ?? group.chatId,
                    }))}
                    onChange={groupId => setSelectedApplyGroupId(groupId)}
                  />
                  <label className="roles-profile-force">
                    <input type="checkbox" id="roles-profile-apply-force" checked={applyForce} onChange={ev => setApplyForce(ev.target.checked)} /> {tr('roles.applyForce')}
                  </label>
                </div>
                <div id="roles-profile-apply-bots">
                  {!selectedApplyGroup || selectedApplyBots.length === 0 ? (
                    <div className="roles-empty">{tr('roles.noChats')}</div>
                  ) : selectedApplyBots.map(bot => {
                    const hasEntry = !!entryForBot(profileEntries, bot.larkAppId);
                    return (
                      <label className="checkbox-row roles-profile-apply-bot" key={bot.larkAppId}>
                        <input
                          type="checkbox"
                          name="profile-apply-bot"
                          value={bot.larkAppId}
                          checked={selectedApplyBotIds.has(bot.larkAppId)}
                          onChange={ev => toggleApplyBot(bot.larkAppId, ev.target.checked)}
                        />
                        <span>{bot.botName ?? bot.larkAppId}</span>
                        <small>{hasEntry ? tr('roles.configured') : tr('roles.profileMissing')}</small>
                      </label>
                    );
                  })}
                </div>
                <div className="roles-editor-actions">
                  <button type="button" id="roles-profile-preview-apply" onClick={() => void runProfileApply(true)}>{tr('roles.previewApply')}</button>
                  <button type="button" id="roles-profile-apply" className="primary" onClick={() => void runProfileApply(false)}>{tr('roles.applyProfile')}</button>
                </div>
                <div id="roles-profile-apply-status" className="roles-profile-status">
                  <ApplyStatusView status={applyStatus} bots={allBots} tr={tr} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function toggleSet(prev: Set<string>, value: string): Set<string> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function byteCountClass(len: number): string {
  return `roles-bytecount ${len > ROLE_WARN_BYTES ? 'warn' : ''} ${len > MAX_ROLE_BYTES ? 'over' : ''}`;
}

function Flash(props: { flash: FlashState }) {
  if (!props.flash) return null;
  return (
    <span className={`roles-saved-flash ${props.flash.isError ? 'roles-save-error' : ''}`}>
      {' '}{props.flash.text}
    </span>
  );
}

function GroupsTree(props: {
  groups: GroupInfo[];
  profiles: RoleProfileSummary[];
  context: RoleProfileContext;
  contextLoaded: boolean;
  expandedGroups: Set<string>;
  selectedGroupId: string | null;
  selectedBotId: string | null;
  tr: Translator;
  onToggleGroup(groupId: string): void;
  onSelectBot(groupId: string, botId: string): void;
}) {
  const { tr } = props;
  if (props.groups.length === 0) return <div className="roles-empty">{tr('roles.noChats')}</div>;
  return (
    <>
      {props.groups.map(group => {
        const expanded = props.expandedGroups.has(group.chatId);
        const inChatBots = group.memberBots.filter(bot => bot.inChat);
        const roleCount = botRoleCount(group);
        const totalInChat = botInChatCount(group);
        return (
          <div className="roles-group-section" key={group.chatId}>
            <div
              className={`roles-group-row ${expanded ? 'expanded' : ''} ${props.selectedGroupId === group.chatId && !props.selectedBotId ? 'selected' : ''}`}
              data-group-id={group.chatId}
              onClick={() => props.onToggleGroup(group.chatId)}
            >
              <span className="roles-group-arrow">{expanded ? '▾' : '▸'}</span>
              <span className="roles-group-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16"><circle cx="5.6" cy="5.8" r="2.4" /><path d="M1.8 13.2c.5-2.4 2-3.6 3.8-3.6s3.3 1.2 3.8 3.6" /><circle cx="11" cy="6.8" r="1.9" /><path d="M9.8 12.6c.4-1.7 1.5-2.6 2.8-2.6 1 0 1.9.5 2.4 1.6" /></svg>
              </span>
              <div className="roles-group-info">
                <div className="roles-group-name">{group.name ?? group.chatId}</div>
                <div className="roles-group-meta">{roleCount}/{totalInChat} {tr('roles.botsWithRoles')}</div>
                <GroupProfileStatus
                  group={group}
                  profiles={props.profiles}
                  context={props.context}
                  loaded={props.contextLoaded}
                  tr={tr}
                />
              </div>
              <span className="roles-group-chevron"></span>
            </div>
            <div className="roles-bot-list">
              {expanded ? inChatBots.map(bot => {
                const selected = props.selectedGroupId === group.chatId && props.selectedBotId === bot.larkAppId;
                return (
                  <div
                    className={`roles-bot-row ${selected ? 'selected' : ''}`}
                    data-group-id={group.chatId}
                    data-bot-id={bot.larkAppId}
                    key={bot.larkAppId}
                    onClick={ev => {
                      ev.stopPropagation();
                      props.onSelectBot(group.chatId, bot.larkAppId);
                    }}
                  >
                    <span className="roles-bot-indent"></span>
                    <BotAvatar bot={bot} />
                    <div className="roles-bot-info">
                      <div className="roles-bot-name">{bot.botName}</div>
                      <div className="roles-bot-id">{bot.larkAppId}</div>
                    </div>
                    <span className={`roles-badge ${bot.hasRole ? 'has-role' : 'no-role'}`}>
                      {bot.hasRole ? tr('roles.configured') : tr('roles.unconfigured')}
                    </span>
                  </div>
                );
              }) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

function GroupProfileStatus(props: {
  group: GroupInfo;
  profiles: RoleProfileSummary[];
  context: RoleProfileContext;
  loaded: boolean;
  tr: Translator;
}) {
  const { group, profiles, context, loaded, tr } = props;
  if (!profiles.length || !loaded) return null;
  const rolesByBot = new Map<string, EffectiveRoleValue>();
  for (const bot of group.memberBots) {
    if (!bot.inChat) continue;
    rolesByBot.set(bot.larkAppId, context.effectiveRolesByBot.get(roleKey(bot.larkAppId, group.chatId)) ?? null);
  }
  if (!hasExplicitChatRole(rolesByBot)) return null;
  const best = summarizeGroupProfileMatches(group.memberBots, profiles, context.entriesByProfile, rolesByBot)[0];
  if (!best) return <div className="roles-profile-match muted">{tr('groups.profileStatusUnmatched')}</div>;
  const key = best.kind === 'full' ? 'groups.profileStatusFullChat' : 'groups.profileStatusPartial';
  return (
    <div className={`roles-profile-match ${best.kind}`}>
      {tr(key, {
        name: best.profileId,
        matched: best.matched,
        total: best.total,
        chat: best.chatMatched,
      })}
    </div>
  );
}

function RolePreview(props: { id: string; content: string; tr: Translator }) {
  return (
    <div id={props.id} className="roles-preview">
      {props.content.trim() ? (
        <>
          <strong>{props.tr('roles.preview')}</strong>
          <pre>{props.content}</pre>
        </>
      ) : (
        <small>{props.tr('roles.previewEmpty')}</small>
      )}
    </div>
  );
}

function ProfileList(props: {
  profiles: RoleProfileSummary[];
  selectedProfileId: string | null;
  tr: Translator;
  onSelect(profileId: string): void;
}) {
  const { tr } = props;
  if (props.profiles.length === 0) return <div className="roles-empty">{tr('roles.profileEmpty')}</div>;
  return (
    <>
      {props.profiles.map(profile => {
        const selected = props.selectedProfileId === profile.profileId;
        const hasAnyLocal = (profile.botEntries ?? []).some(entry => entry.hasEntry);
        return (
          <div
            className={`roles-profile-row ${selected ? 'selected' : ''}`}
            data-profile-id={profile.profileId}
            key={profile.profileId}
            onClick={() => props.onSelect(profile.profileId)}
          >
            <div className="roles-profile-row-main">
              <div className="roles-profile-name">{profile.profileId}</div>
              <div className="roles-group-meta">{profile.entryCount} {tr('roles.profileEntries')}</div>
            </div>
            <span className={`roles-badge ${hasAnyLocal ? 'has-role' : 'no-role'}`}>
              {hasAnyLocal ? tr('roles.configured') : tr('roles.profileMissing')}
            </span>
          </div>
        );
      })}
    </>
  );
}

function ApplyStatusView(props: {
  status: ApplyStatus;
  bots: DashboardBot[];
  tr: Translator;
}) {
  const { status, bots, tr } = props;
  if (status.kind === 'idle') return null;
  if (status.kind === 'text') return <>{status.text}</>;
  return (
    <>
      {status.results.map(result => {
        const bot = bots.find(b => b.larkAppId === result.larkAppId);
        const label = bot?.botName ?? result.larkAppId;
        const outcome = result.ok
          ? (status.preview ? (result.wouldRefuse ? tr('roles.applyWouldRefuse') : tr('roles.applyPreviewOk')) : tr('roles.applyOk'))
          : `${tr('roles.applyFailed')}: ${String(result.error ?? `HTTP ${result.status}`)}`;
        return <div key={result.larkAppId}>{label}: {outcome}</div>;
      })}
    </>
  );
}

export function renderRolesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <RolesPage tab="groups" />);
}

export function renderRoleProfilesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <RolesPage tab="profiles" />);
}
