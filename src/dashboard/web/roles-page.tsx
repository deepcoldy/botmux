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
import {
  applyListenerFilterState,
  filterListenerTargets,
  listenerTargetStateFor,
  resolveExcludeSenderKinds,
} from './listener-filters.js';
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
  deleteMessageListener,
  deleteRole,
  entryForBot,
  filterRoleGroups,
  filterRoleProfiles,
  formatListenerPreviewTime,
  hashChatId,
  isValidProfileId,
  loadGroupMemberDisplays,
  loadGroups,
  loadMessageListenerRunPreviewStatus,
  loadMessageListener,
  loadProfileEntries,
  loadProfileEntry,
  loadProfiles,
  loadRole,
  loadRoleProfileContext,
  MAX_MESSAGE_LISTENER_PROMPT_BYTES,
  MAX_ROLE_BYTES,
  MESSAGE_LISTENER_WARN_BYTES,
  DEFAULT_MESSAGE_LISTENER_PREVIEW_LIMIT,
  MAX_MESSAGE_LISTENER_PREVIEW_LIMIT,
  roleKey,
  ROLE_WARN_BYTES,
  saveInjectMode,
  saveMessageListener,
  saveProfileEntry,
  saveRole,
  previewMessageListener,
  runMessageListenerPreview,
  type DashboardBot,
  type GroupInfo,
  type GroupMemberDisplay,
  type MessageListenerData,
  type MessageListenerPreviewItem,
  type MessageListenerPreviewResponse,
  type MessageListenerRunPreviewResult,
  type MessageListenerRunPreviewState,
  type RoleData,
  type RoleInjectMode,
  type RoleProfileApplyResult,
  type RoleProfileContext,
  type RoleProfileEntry,
  type RoleProfileSummary,
} from './roles.js';
import { botAvatarHtml, loadNameMaps } from './ui.js';

type RolesTab = 'groups' | 'profiles';
type GroupEditorSection = 'role' | 'listener';
type ListenerTargetTab = 'members' | 'bots';
type SenderTypeOption = 'user' | 'bot';
type Translator = ReturnType<typeof useT>;

const LISTENER_MESSAGE_TYPES = ['text', 'post', 'image', 'interactive'] as const;

type FlashState = { text: string; isError?: boolean; id: number } | null;
type ApplyStatus =
  | { kind: 'idle' }
  | { kind: 'text'; text: string }
  | { kind: 'results'; preview: boolean; results: RoleProfileApplyResult[] };
type ListenerPreviewStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; mode: 'preview' | 'run' }
  | { kind: 'result'; response: MessageListenerPreviewResponse; mode: 'preview' | 'run' }
  | { kind: 'error'; text: string };

const DEFAULT_LISTENER: MessageListenerData = {
  enabled: false,
  prompt: '',
  senderPolicy: {
    mode: 'include_only',
    includeSenderTypes: ['user'],
    excludeSelf: true,
  },
  messagePolicy: {
    includeMsgTypes: [...LISTENER_MESSAGE_TYPES],
    scope: 'top_level',
  },
};

function cloneListener(listener: MessageListenerData | null | undefined): MessageListenerData {
  // Mirror the backend storage default: persisted configs OMIT `mode` when it
  // equals 'all_except_excluded' (see message-listener-store sanitize +
  // bot-registry normalize), so an ABSENT mode means all_except_excluded, NOT
  // include_only. DEFAULT_LISTENER sets 'include_only' explicitly, so a
  // brand-new (unsaved) listener still starts on the allow-list. Treating an
  // absent mode as include_only here is what made the toggle snap back to
  // "listen to selected only" after saving "listen to all".
  const mode = listener?.senderPolicy?.mode === 'include_only' ? 'include_only' : 'all_except_excluded';
  return {
    enabled: listener?.enabled === true,
    name: listener?.name ?? '',
    replyCardTitle: listener?.replyCardTitle ?? '',
    workingDir: listener?.workingDir ?? '',
    prompt: listener?.prompt ?? '',
    senderPolicy: {
      mode,
      includeSenderOpenIds: [...(listener?.senderPolicy?.includeSenderOpenIds ?? [])],
      excludeSenderOpenIds: [...(listener?.senderPolicy?.excludeSenderOpenIds ?? [])],
      ...(listener?.senderPolicy?.excludeSenderKinds ? { excludeSenderKinds: { ...listener.senderPolicy.excludeSenderKinds } } : {}),
      includeSenderTypes: [...(listener?.senderPolicy?.includeSenderTypes ?? DEFAULT_LISTENER.senderPolicy?.includeSenderTypes ?? [])],
      excludeSenderTypes: [...(listener?.senderPolicy?.excludeSenderTypes ?? [])],
      excludeSelf: listener?.senderPolicy?.excludeSelf !== false,
    },
    messagePolicy: {
      includeMsgTypes: [...(listener?.messagePolicy?.includeMsgTypes ?? DEFAULT_LISTENER.messagePolicy?.includeMsgTypes ?? [])],
      scope: 'top_level',
    },
  };
}

function listenerHasConfig(listener: MessageListenerData | null): boolean {
  // A persisted listener is worth loading into the editor whenever it carries a
  // prompt — INCLUDING a disabled draft (enabled:false + non-empty prompt). The
  // backend persists such drafts (see messageListenerConfigFromUpdate); gating
  // on enabled here would reset the editor to blank on reload and make the saved
  // draft look lost. Runtime matching still requires enabled===true elsewhere.
  return !!listener && listener.prompt.trim().length > 0;
}

function groupHasAnyRoleOrListener(group: GroupInfo): boolean {
  return group.memberBots.some(bot => bot.inChat && (bot.hasRole || bot.hasMessageListener));
}

function memberDisplayName(member: GroupMemberDisplay | undefined, openId: string): string {
  return member?.name || openId;
}

function mergeListenerRunPreviewResults(
  current: MessageListenerRunPreviewResult[] | undefined,
  next: MessageListenerRunPreviewResult[],
): MessageListenerRunPreviewResult[] {
  const merged = new Map<string, MessageListenerRunPreviewResult>();
  for (const result of current ?? []) merged.set(result.messageId, result);
  for (const result of next) merged.set(result.messageId, { ...merged.get(result.messageId), ...result });
  return [...merged.values()];
}

function listenerRunPreviewStateClass(state: MessageListenerRunPreviewState | undefined, ok: boolean): string {
  if (!ok || state === 'failed') return 'error';
  if (state === 'replied') return 'ok';
  if (state === 'running') return 'running';
  return 'triggered';
}

function listenerForEditor(listener: MessageListenerData | null | undefined, _members: GroupMemberDisplay[] = []): MessageListenerData {
  // Preserve whichever sender mode was persisted (include_only allow-list OR
  // all_except_excluded blacklist). The blacklist mode is the ONLY way to
  // listen to a third-party bot whose sender is reported by app_id and cannot
  // be resolved to an open_id, so we must not silently downgrade it here.
  return cloneListener(listener ?? DEFAULT_LISTENER);
}

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
  const [groupEditorSection, setGroupEditorSection] = useState<GroupEditorSection>('role');
  const [selectedListener, setSelectedListener] = useState<MessageListenerData | null>(null);
  const [editingListener, setEditingListener] = useState<MessageListenerData>(() => cloneListener(DEFAULT_LISTENER));
  const [listenerMembers, setListenerMembers] = useState<GroupMemberDisplay[]>([]);
  const [listenerLoading, setListenerLoading] = useState(false);
  const [listenerMembersLoading, setListenerMembersLoading] = useState(false);
  const [listenerSaving, setListenerSaving] = useState(false);
  const [listenerDeleting, setListenerDeleting] = useState(false);
  const [listenerFlash, setListenerFlash] = useState<FlashState>(null);
  const [listenerPreviewLimit, setListenerPreviewLimit] = useState(DEFAULT_MESSAGE_LISTENER_PREVIEW_LIMIT);
  const [listenerPreviewStatus, setListenerPreviewStatus] = useState<ListenerPreviewStatus>({ kind: 'idle' });
  const listenerRunPollRef = useRef<{ runId: string; token: number } | null>(null);
  const listenerRunPollToken = useRef(0);
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
  const listenerPromptByteLen = byteLength(editingListener.prompt);
  const listenerMemberById = useMemo(() => {
    const map = new Map<string, GroupMemberDisplay>();
    for (const member of listenerMembers) map.set(member.openId, member);
    return map;
  }, [listenerMembers]);

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

  const applyLoadedListener = useCallback((listener: MessageListenerData | null, members: GroupMemberDisplay[] = []) => {
    const next = listenerForEditor(listener ?? DEFAULT_LISTENER, members);
    setSelectedListener(listener);
    setEditingListener(next);
  }, []);

  const loadListenerForSelection = useCallback(async (botId: string, groupId: string, serial: number) => {
    setListenerLoading(true);
    setListenerMembersLoading(true);
    setListenerMembers([]);
    try {
      const [listener, members] = await Promise.all([
        loadMessageListener(botId, groupId).catch(() => cloneListener(DEFAULT_LISTENER)),
        loadGroupMemberDisplays(botId, groupId).catch(() => [] as GroupMemberDisplay[]),
      ]);
      if (!alive.current || serial !== selectSerial.current) return;
      applyLoadedListener(listenerHasConfig(listener) ? listener : null, members);
      setListenerMembers(members);
      setListenerFlash(null);
    } finally {
      if (alive.current && serial === selectSerial.current) {
        setListenerLoading(false);
        setListenerMembersLoading(false);
      }
    }
  }, [alive, applyLoadedListener]);

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

      setExpandedGroups(new Set(snapshot.groups.filter(groupHasAnyRoleOrListener).map(group => group.chatId)));
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

  useEffect(() => () => {
    listenerRunPollToken.current += 1;
    listenerRunPollRef.current = null;
  }, []);

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
    setRoleFlash(null);
    setInjectFlash(null);
    setListenerFlash(null);
    applyLoadedListener(null);
    const role = await loadRole(botId, groupId);
    if (!alive.current || serial !== selectSerial.current) return;
    setSelectedRole(role);
    setEditingContent(role.content ?? '');
    setEditingInjectMode(role.injectMode === 'once' ? 'once' : 'every');
    await loadListenerForSelection(botId, groupId, serial);
  }

  async function handleGroupRefresh(): Promise<void> {
    const snapshot = await refreshGroups();
    if (!alive.current) return;
    void refreshRoleContext(snapshot.groups, profiles);
    if (selectedGroupId && selectedBotId) {
      const serial = ++selectSerial.current;
      const role = await loadRole(selectedBotId, selectedGroupId);
      if (!alive.current || serial !== selectSerial.current) return;
      setSelectedRole(role);
      setEditingContent(role.content ?? '');
      setEditingInjectMode(role.injectMode === 'once' ? 'once' : 'every');
      await loadListenerForSelection(selectedBotId, selectedGroupId, serial);
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

  function updateEditingListener(patch: Partial<MessageListenerData>): void {
    setEditingListener(prev => ({ ...prev, ...patch }));
  }

  function updateListenerSenderPolicy(patch: NonNullable<MessageListenerData['senderPolicy']>): void {
    setEditingListener(prev => ({
      ...prev,
      senderPolicy: {
        ...(prev.senderPolicy ?? {}),
        ...patch,
      },
    }));
  }

  function updateListenerMessagePolicy(patch: NonNullable<MessageListenerData['messagePolicy']>): void {
    setEditingListener(prev => ({
      ...prev,
      messagePolicy: {
        ...(prev.messagePolicy ?? { scope: 'top_level' }),
        ...patch,
        scope: 'top_level',
      },
    }));
  }

  function toggleListenerSenderType(type: SenderTypeOption, checked: boolean): void {
    setEditingListener(prev => {
      const current = new Set(prev.senderPolicy?.includeSenderTypes ?? []);
      if (checked) current.add(type);
      else {
        if (current.size <= 1 && current.has(type)) return prev;
        current.delete(type);
      }
      return {
        ...prev,
        senderPolicy: {
          ...(prev.senderPolicy ?? {}),
          includeSenderTypes: [...current],
        },
      };
    });
  }

  function toggleListenerMsgType(msgType: string, checked: boolean): void {
    setEditingListener(prev => {
      const current = new Set(prev.messagePolicy?.includeMsgTypes ?? []);
      if (checked) current.add(msgType);
      else {
        if (current.size <= 1 && current.has(msgType)) return prev;
        current.delete(msgType);
      }
      return {
        ...prev,
        messagePolicy: {
          ...(prev.messagePolicy ?? { scope: 'top_level' }),
          includeMsgTypes: [...current],
          scope: 'top_level',
        },
      };
    });
  }

  function setListenerTargetsPolicyInternal(openIds: string[], listening: boolean): void {
    setEditingListener(prev => {
      const mode = prev.senderPolicy?.mode === 'all_except_excluded' ? 'all_except_excluded' : 'include_only';
      const next = applyListenerFilterState({
        mode,
        include: prev.senderPolicy?.includeSenderOpenIds ?? [],
        exclude: prev.senderPolicy?.excludeSenderOpenIds ?? [],
        targetIds: openIds,
        listening,
      });
      return {
        ...prev,
        senderPolicy: {
          ...(prev.senderPolicy ?? {}),
          mode,
          includeSenderOpenIds: next.include,
          excludeSenderOpenIds: next.exclude,
        },
      };
    });
  }

  function setListenerTargetPolicy(openId: string, listening: boolean): void {
    setListenerTargetsPolicyInternal([openId], listening);
  }

  function setListenerTargetsPolicy(openIds: string[], listening: boolean): void {
    setListenerTargetsPolicyInternal(openIds, listening);
  }

  // Switch the sender-matching mode without losing the operator's picks:
  //   include_only        → allow-list of open_ids (cannot match app_id-only bots)
  //   all_except_excluded  → listen to everyone (except self + excluded); the
  //                          only mode that can catch third-party alert bots.
  function setListenerSenderMode(mode: 'include_only' | 'all_except_excluded'): void {
    setEditingListener(prev => ({
      ...prev,
      senderPolicy: {
        ...(prev.senderPolicy ?? {}),
        mode,
        includeSenderOpenIds: [...(prev.senderPolicy?.includeSenderOpenIds ?? [])],
        excludeSenderOpenIds: [...(prev.senderPolicy?.excludeSenderOpenIds ?? [])],
      },
    }));
  }

  function listenerSavePayload(): MessageListenerData {
    const senderPolicy = editingListener.senderPolicy ?? {};
    const messagePolicy = editingListener.messagePolicy ?? {};
    const mode = senderPolicy.mode === 'all_except_excluded' ? 'all_except_excluded' : 'include_only';
    const includeSenderOpenIds = [...new Set(senderPolicy.includeSenderOpenIds ?? [])].filter(Boolean);
    const excludeSenderOpenIds = [...new Set(senderPolicy.excludeSenderOpenIds ?? [])].filter(Boolean);
    // Persist the sender KIND (user/bot) of each excluded id so the runtime
    // fail-close decision can tell a muted human from a muted bot without
    // guessing by id prefix (see message-listener senderOpenIdAllowed). Only
    // ids the current roster resolves to a definite user/bot are recorded;
    // 'unknown' stays absent → runtime treats it conservatively as maybe-a-bot.
    // Live roster wins; fall back to the already-persisted kind so a transient
    // members-list failure (loadMembers swallows errors to an empty array, and
    // save is not gated on listenerMembersLoading) can't silently drop a known
    // kind on an unrelated-field save — that would re-fail-close every
    // unverified third-party bot (the exact scenario this PR fixes). See
    // resolveExcludeSenderKinds for the precedence contract + regression test.
    const excludeSenderKinds = resolveExcludeSenderKinds(
      excludeSenderOpenIds,
      openId => listenerMemberById.get(openId)?.memberType,
      senderPolicy.excludeSenderKinds,
    );
    const includeSenderTypes = [...new Set(senderPolicy.includeSenderTypes ?? [])].filter((type): type is SenderTypeOption => type === 'user' || type === 'bot');
    const includeMsgTypes = [...new Set(messagePolicy.includeMsgTypes ?? [])].filter(Boolean);
    return {
      enabled: editingListener.enabled,
      ...(editingListener.name?.trim() ? { name: editingListener.name.trim() } : {}),
      ...(editingListener.replyCardTitle?.trim() ? { replyCardTitle: editingListener.replyCardTitle.trim() } : {}),
      ...(editingListener.workingDir?.trim() ? { workingDir: editingListener.workingDir.trim() } : {}),
      prompt: editingListener.prompt.trim(),
      senderPolicy: {
        mode,
        // Persist ONLY the list relevant to the active mode so a later mode
        // switch never resurrects stale open_ids from the other list.
        ...(mode === 'include_only' && includeSenderOpenIds.length > 0 ? { includeSenderOpenIds } : {}),
        ...(mode === 'all_except_excluded' && excludeSenderOpenIds.length > 0 ? { excludeSenderOpenIds } : {}),
        ...(mode === 'all_except_excluded' && Object.keys(excludeSenderKinds).length > 0 ? { excludeSenderKinds } : {}),
        ...(includeSenderTypes.length > 0 ? { includeSenderTypes } : {}),
        excludeSelf: senderPolicy.excludeSelf !== false,
      },
      messagePolicy: {
        ...(includeMsgTypes.length > 0 ? { includeMsgTypes } : {}),
        scope: 'top_level',
      },
    };
  }

  function validateListenerForPreview(): MessageListenerData | null {
    if (!editingListener.prompt.trim()) {
      flash(setListenerFlash, tr('roles.listenerPromptRequired'), true);
      return null;
    }
    if (editingListener.senderPolicy?.mode !== 'all_except_excluded'
      && (editingListener.senderPolicy?.includeSenderOpenIds?.length ?? 0) === 0) {
      flash(setListenerFlash, tr('roles.listenerSenderRequired'), true);
      return null;
    }
    return {
      ...listenerSavePayload(),
      enabled: true,
    };
  }

  async function handleListenerPreview(run: boolean): Promise<void> {
    if (!selectedGroupId || !selectedBotId) return;
    const payload = validateListenerForPreview();
    if (!payload) return;
    const mode = run ? 'run' : 'preview';
    setListenerPreviewStatus({ kind: 'loading', mode });
    try {
      const response = run
        ? await runMessageListenerPreview(selectedBotId, selectedGroupId, payload, listenerPreviewLimit)
        : await previewMessageListener(selectedBotId, selectedGroupId, payload, listenerPreviewLimit);
      if (!alive.current) return;
      setListenerPreviewStatus(response.ok
        ? { kind: 'result', response, mode }
        : { kind: 'error', text: response.error || tr('roles.listenerPreviewFailed') });
      if (response.ok && run && response.runId) {
        startListenerRunPreviewPolling(response.runId);
      }
    } catch (err) {
      if (!alive.current) return;
      setListenerPreviewStatus({ kind: 'error', text: err instanceof Error ? err.message : tr('roles.listenerPreviewFailed') });
    }
  }

  function startListenerRunPreviewPolling(runId: string): void {
    if (!selectedGroupId || !selectedBotId) return;
    const token = ++listenerRunPollToken.current;
    listenerRunPollRef.current = { runId, token };
    const poll = async () => {
      if (!alive.current) return;
      const current = listenerRunPollRef.current;
      if (!current || current.runId !== runId || current.token !== token || !selectedGroupId || !selectedBotId) return;
      try {
        const status = await loadMessageListenerRunPreviewStatus(selectedBotId, selectedGroupId, runId);
        if (!alive.current) return;
        if (status.ok && status.results) {
          const nextResults = status.results;
          setListenerPreviewStatus(previous => {
            if (previous.kind !== 'result' || previous.mode !== 'run' || previous.response.runId !== runId) return previous;
            return {
              ...previous,
              response: {
                ...previous.response,
                results: mergeListenerRunPreviewResults(previous.response.results, nextResults),
              },
            };
          });
          if (nextResults.some(result => result.state === 'triggered' || result.state === 'running')) {
            scheduleTimer(poll, 1500);
          } else if (listenerRunPollRef.current?.runId === runId) {
            listenerRunPollRef.current = null;
          }
        }
      } catch {
        scheduleTimer(poll, 2500);
      }
    };
    scheduleTimer(poll, 1500);
  }

  async function handleSaveListener(): Promise<void> {
    if (!selectedGroupId || !selectedBotId) return;
    // Disabled + blank prompt = clear the listener entirely (mirrors the backend
    // messageListenerConfigFromUpdate: nothing worth persisting → delete). A
    // disabled draft WITH a prompt falls through and is saved as-is (enabled:false),
    // so turning the toggle off then Save no longer discards the typed content.
    if (!editingListener.enabled && !editingListener.prompt.trim()) {
      await handleDeleteListener(false);
      return;
    }
    // Prompt + sender requirements only gate an ENABLED listener (it will match
    // live messages). A disabled draft never matches at runtime, so an
    // incomplete sender policy is fine to persist and re-editing later can
    // complete it before enabling.
    if (editingListener.enabled) {
      if (!editingListener.prompt.trim()) {
        flash(setListenerFlash, tr('roles.listenerPromptRequired'), true);
        return;
      }
      if (editingListener.senderPolicy?.mode !== 'all_except_excluded'
        && (editingListener.senderPolicy?.includeSenderOpenIds?.length ?? 0) === 0) {
        flash(setListenerFlash, tr('roles.listenerSenderRequired'), true);
        return;
      }
    }
    setListenerSaving(true);
    try {
      const ok = await saveMessageListener(selectedBotId, selectedGroupId, listenerSavePayload());
      if (!alive.current) return;
      if (ok) {
        const snapshot = await refreshGroups();
        if (!alive.current) return;
        const listener = await loadMessageListener(selectedBotId, selectedGroupId);
        if (!alive.current) return;
        applyLoadedListener(listenerHasConfig(listener) ? listener : null);
        void refreshRoleContext(snapshot.groups, profiles);
      }
      flash(setListenerFlash, ok ? tr('roles.saved') : tr('roles.saveFailed'), !ok);
    } finally {
      if (alive.current) setListenerSaving(false);
    }
  }

  async function handleDeleteListener(confirmFirst = true): Promise<void> {
    if (!selectedGroupId || !selectedBotId) return;
    if (confirmFirst && !confirm(tr('roles.listenerConfirmDelete'))) return;
    setListenerDeleting(true);
    try {
      const ok = await deleteMessageListener(selectedBotId, selectedGroupId);
      if (!alive.current) return;
      if (ok) {
        const snapshot = await refreshGroups();
        if (!alive.current) return;
        applyLoadedListener(null);
        void refreshRoleContext(snapshot.groups, profiles);
      }
      flash(setListenerFlash, ok ? tr('roles.saved') : tr('roles.saveFailed'), !ok);
    } finally {
      if (alive.current) setListenerDeleting(false);
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
  const listenerSaveDisabled = listenerSaving
    || listenerDeleting
    || listenerPromptByteLen > MAX_MESSAGE_LISTENER_PROMPT_BYTES
    || (editingListener.enabled && editingListener.prompt.trim().length === 0);
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
                  {groupEditorSection === 'role' ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        id="roles-listener-delete"
                        className="danger"
                        style={{ display: selectedListener ? '' : 'none' }}
                        disabled={listenerDeleting}
                        onClick={() => void handleDeleteListener()}
                      >
                        {listenerDeleting ? '...' : tr('roles.delete')}
                      </button>
                      <button
                        type="button"
                        id="roles-listener-save"
                        className="primary"
                        disabled={listenerSaveDisabled}
                        onClick={() => void handleSaveListener()}
                      >
                        {listenerSaving ? '...' : tr('roles.save')}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="roles-editor-switch segmented" role="tablist" aria-label={tr('roles.editorTabs')}>
                <button
                  type="button"
                  className={groupEditorSection === 'role' ? 'active' : ''}
                  aria-pressed={groupEditorSection === 'role'}
                  onClick={() => setGroupEditorSection('role')}
                >
                  {tr('roles.roleTab')}
                </button>
                <button
                  type="button"
                  className={groupEditorSection === 'listener' ? 'active' : ''}
                  aria-pressed={groupEditorSection === 'listener'}
                  onClick={() => setGroupEditorSection('listener')}
                >
                  {tr('roles.listenerTab')}
                </button>
              </div>
              {groupEditorSection === 'role' ? (
                <>
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
                </>
              ) : (
                <MessageListenerEditor
                  listener={editingListener}
                  members={listenerMembers}
                  memberById={listenerMemberById}
                  promptByteLen={listenerPromptByteLen}
                  loading={listenerLoading}
                  membersLoading={listenerMembersLoading}
                  flash={listenerFlash}
                  tr={tr}
                  onPatch={updateEditingListener}
                  onSenderPolicyPatch={updateListenerSenderPolicy}
                  onMessagePolicyPatch={updateListenerMessagePolicy}
                  onToggleSenderType={toggleListenerSenderType}
                  onToggleMsgType={toggleListenerMsgType}
                  onSetTargetPolicy={setListenerTargetPolicy}
                  onSetTargetsPolicy={setListenerTargetsPolicy}
                  onSetSenderMode={setListenerSenderMode}
                  previewLimit={listenerPreviewLimit}
                  previewStatus={listenerPreviewStatus}
                  onPreviewLimitChange={setListenerPreviewLimit}
                  onPreview={() => void handleListenerPreview(false)}
                  onRunPreview={() => void handleListenerPreview(true)}
                />
              )}
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

function listenerByteCountClass(len: number): string {
  return `roles-bytecount ${len > MESSAGE_LISTENER_WARN_BYTES ? 'warn' : ''} ${len > MAX_MESSAGE_LISTENER_PROMPT_BYTES ? 'over' : ''}`;
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
                    <div className="roles-bot-badges">
                      <span className={`roles-badge ${bot.hasRole ? 'has-role' : 'no-role'}`}>
                        {bot.hasRole ? tr('roles.configured') : tr('roles.unconfigured')}
                      </span>
                      {bot.hasMessageListener ? (
                        <span className="roles-badge has-listener">{tr('roles.listenerBadge')}</span>
                      ) : null}
                    </div>
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

function MessageListenerEditor(props: {
  listener: MessageListenerData;
  members: GroupMemberDisplay[];
  memberById: Map<string, GroupMemberDisplay>;
  promptByteLen: number;
  loading: boolean;
  membersLoading: boolean;
  flash: FlashState;
  previewLimit: number;
  previewStatus: ListenerPreviewStatus;
  tr: Translator;
  onPatch(patch: Partial<MessageListenerData>): void;
  onSenderPolicyPatch(patch: NonNullable<MessageListenerData['senderPolicy']>): void;
  onMessagePolicyPatch(patch: NonNullable<MessageListenerData['messagePolicy']>): void;
  onToggleSenderType(type: SenderTypeOption, checked: boolean): void;
  onToggleMsgType(msgType: string, checked: boolean): void;
  onSetTargetPolicy(openId: string, listening: boolean): void;
  onSetTargetsPolicy(openIds: string[], listening: boolean): void;
  onSetSenderMode(mode: 'include_only' | 'all_except_excluded'): void;
  onPreview(): void;
  onRunPreview(): void;
  onPreviewLimitChange(limit: number): void;
}) {
  const { listener, tr } = props;
  const [targetTab, setTargetTab] = useState<ListenerTargetTab>('members');
  const [targetQuery, setTargetQuery] = useState('');
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(() => new Set());
  const senderTypes = new Set(listener.senderPolicy?.includeSenderTypes ?? []);
  const msgTypes = new Set(listener.messagePolicy?.includeMsgTypes ?? []);
  const senderMode: 'include_only' | 'all_except_excluded' =
    listener.senderPolicy?.mode === 'all_except_excluded' ? 'all_except_excluded' : 'include_only';
  const includeIds = new Set(listener.senderPolicy?.includeSenderOpenIds ?? []);
  const excludeIds = new Set(listener.senderPolicy?.excludeSenderOpenIds ?? []);
  // Show any configured open_id not present in the live member roster (e.g. a
  // left member, or a bot only known by open_id) so the operator can still see
  // and clear it. Which list matters depends on the active mode.
  const configuredUnknownMembers = [
    ...[...(senderMode === 'all_except_excluded' ? excludeIds : includeIds)]
      .filter(openId => !props.memberById.has(openId)),
  ];
  const members = [
    ...props.members.filter(member => member.memberType !== 'bot'),
    ...configuredUnknownMembers.map(openId => ({ openId, name: openId, memberType: 'unknown' as const })),
  ];
  const bots = props.members.filter(member => member.memberType === 'bot');
  const activeTargets = targetTab === 'bots' ? bots : members;
  const filteredTargets = filterListenerTargets(activeTargets, targetQuery);
  const filteredTargetIds = filteredTargets.map(target => target.openId);
  const selectedVisibleIds = filteredTargetIds.filter(id => selectedTargetIds.has(id));
  const allVisibleSelected = filteredTargetIds.length > 0 && selectedVisibleIds.length === filteredTargetIds.length;
  const selectedIds = [...selectedTargetIds].filter(id => activeTargets.some(target => target.openId === id));
  const bulkTargetIds = selectedIds.length > 0 ? selectedIds : filteredTargetIds;
  const bulkState = listenerTargetStateFor({
    mode: senderMode,
    include: [...includeIds],
    exclude: [...excludeIds],
    targetIds: bulkTargetIds,
  });

  useEffect(() => {
    setTargetQuery('');
    setSelectedTargetIds(new Set());
  }, [targetTab]);

  useEffect(() => {
    const activeIds = new Set(activeTargets.map(target => target.openId));
    setSelectedTargetIds(prev => {
      const next = new Set([...prev].filter(id => activeIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [activeTargets]);

  const toggleTargetSelection = (openId: string, checked: boolean): void => {
    setSelectedTargetIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(openId);
      else next.delete(openId);
      return next;
    });
  };

  const toggleAllVisible = (): void => {
    setSelectedTargetIds(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of filteredTargetIds) next.delete(id);
      } else {
        for (const id of filteredTargetIds) next.add(id);
      }
      return next;
    });
  };

  const applyBulkState = (listening: boolean): void => {
    if (bulkTargetIds.length === 0) return;
    props.onSetTargetsPolicy(bulkTargetIds, listening);
  };

  return (
    <div className="roles-listener-editor">
      {props.loading ? <LoadingState label={tr('common.loading')} /> : null}
      <label className="filter-toggle roles-listener-enabled">
        <input
          type="checkbox"
          checked={listener.enabled}
          onChange={ev => props.onPatch({ enabled: ev.currentTarget.checked })}
        />
        <span className="filter-toggle-switch" aria-hidden="true"></span>
        <span className="filter-toggle-label">{tr('roles.listenerEnabled')}</span>
      </label>
      <p className="roles-listener-scope-help">{tr('roles.listenerScopeHelp')}</p>
      <div className="roles-listener-grid">
        <label className="roles-listener-field">
          <span className="roles-field-label">{tr('roles.listenerName')}</span>
          <input
            type="text"
            value={listener.name ?? ''}
            placeholder={tr('roles.listenerNamePlaceholder')}
            onChange={ev => props.onPatch({ name: ev.currentTarget.value })}
          />
        </label>
        <label className="roles-listener-field">
          <span className="roles-field-label">{tr('roles.listenerReplyCardTitle')}</span>
          <input
            type="text"
            value={listener.replyCardTitle ?? ''}
            placeholder={tr('roles.listenerReplyCardTitlePlaceholder')}
            onChange={ev => props.onPatch({ replyCardTitle: ev.currentTarget.value })}
          />
        </label>
        <label className="roles-listener-field">
          <span className="roles-field-label">{tr('roles.listenerWorkingDir')}</span>
          <input
            type="text"
            value={listener.workingDir ?? ''}
            placeholder={tr('roles.listenerWorkingDirPlaceholder')}
            onChange={ev => props.onPatch({ workingDir: ev.currentTarget.value })}
          />
        </label>
      </div>
      <div className="roles-listener-policy-row">
        <div className="roles-listener-policy">
          <div className="roles-field-label">{tr('roles.listenerSenderTypes')}</div>
          <label className="roles-listener-chip">
            <input
              type="checkbox"
              checked={senderTypes.has('user')}
              onChange={ev => props.onToggleSenderType('user', ev.currentTarget.checked)}
            />
            <span>{tr('roles.listenerSenderUser')}</span>
          </label>
          <label className="roles-listener-chip">
            <input
              type="checkbox"
              checked={senderTypes.has('bot')}
              onChange={ev => props.onToggleSenderType('bot', ev.currentTarget.checked)}
            />
            <span>{tr('roles.listenerSenderBot')}</span>
          </label>
        </div>
        <div className="roles-listener-policy">
          <div className="roles-field-label">{tr('roles.listenerMessageTypes')}</div>
          {LISTENER_MESSAGE_TYPES.map(msgType => (
            <label className="roles-listener-chip" key={msgType}>
              <input
                type="checkbox"
                checked={msgTypes.has(msgType)}
                onChange={ev => props.onToggleMsgType(msgType, ev.currentTarget.checked)}
              />
              <span>{msgType}</span>
            </label>
          ))}
        </div>
        <label className="roles-listener-checkbox">
          <input
            type="checkbox"
            checked={listener.senderPolicy?.excludeSelf !== false}
            onChange={ev => props.onSenderPolicyPatch({ excludeSelf: ev.currentTarget.checked })}
          />
          <span>{tr('roles.listenerExcludeSelf')}</span>
        </label>
      </div>
      <div className="roles-listener-policy-row">
        <div className="roles-listener-policy">
          <div className="roles-field-label">{tr('roles.listenerSenderMode')}</div>
          <div className="roles-listener-target-tabs segmented" role="tablist" aria-label={tr('roles.listenerSenderMode')}>
            <button
              type="button"
              className={senderMode === 'include_only' ? 'active' : ''}
              aria-pressed={senderMode === 'include_only'}
              onClick={() => props.onSetSenderMode('include_only')}
            >
              {tr('roles.listenerSenderModeInclude')}
            </button>
            <button
              type="button"
              className={senderMode === 'all_except_excluded' ? 'active' : ''}
              aria-pressed={senderMode === 'all_except_excluded'}
              onClick={() => props.onSetSenderMode('all_except_excluded')}
            >
              {tr('roles.listenerSenderModeAllExcept')}
            </button>
          </div>
          <small className="roles-listener-scope-help">
            {senderMode === 'all_except_excluded'
              ? tr('roles.listenerSenderModeAllExceptHelp')
              : tr('roles.listenerSenderModeIncludeHelp')}
          </small>
        </div>
      </div>
      <label className="roles-listener-field">
        <span className="roles-field-label">{tr('roles.listenerPrompt')}</span>
        <textarea
          id="roles-listener-prompt"
          placeholder={tr('roles.listenerPromptPlaceholder')}
          rows={9}
          value={listener.prompt}
          onChange={ev => props.onPatch({ prompt: ev.currentTarget.value })}
        />
      </label>
      <div className="roles-editor-footer">
        <span id="roles-listener-bytecount" className={listenerByteCountClass(props.promptByteLen)}>
          {props.promptByteLen} / {MAX_MESSAGE_LISTENER_PROMPT_BYTES} bytes
        </span>
        <Flash flash={props.flash} />
      </div>
      <div className="roles-listener-preview-panel">
        <div className="roles-listener-preview-head">
          <div>
            <div className="roles-profile-section-title">{tr('roles.listenerPreviewTitle')}</div>
            <small>{tr('roles.listenerPreviewHint')}</small>
          </div>
          <div className="roles-listener-preview-actions">
            <label>
              <span>{tr('roles.listenerPreviewCount')}</span>
              <select
                value={props.previewLimit}
                onChange={ev => props.onPreviewLimitChange(Number(ev.currentTarget.value))}
              >
                {Array.from({ length: MAX_MESSAGE_LISTENER_PREVIEW_LIMIT }, (_, index) => index + 1).map(count => (
                  <option value={count} key={count}>{count}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={props.onPreview}
              disabled={props.previewStatus.kind === 'loading'}
            >
              {props.previewStatus.kind === 'loading' && props.previewStatus.mode === 'preview' ? '...' : tr('roles.listenerPreviewButton')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={props.onRunPreview}
              disabled={props.previewStatus.kind === 'loading'}
            >
              {props.previewStatus.kind === 'loading' && props.previewStatus.mode === 'run' ? '...' : tr('roles.listenerRunPreviewButton')}
            </button>
          </div>
        </div>
        <ListenerPreviewResult status={props.previewStatus} tr={tr} />
      </div>
      <div className="roles-listener-members">
        <div className="roles-listener-members-head">
          <div className="roles-profile-section-title">{tr('roles.listenerFilters')}</div>
          <small>{props.membersLoading ? tr('common.loading') : tr('roles.listenerMembersHint')}</small>
        </div>
        <div className="roles-listener-target-tabs segmented" role="tablist" aria-label={tr('roles.listenerFilters')}>
          <button
            type="button"
            className={targetTab === 'members' ? 'active' : ''}
            aria-pressed={targetTab === 'members'}
            onClick={() => setTargetTab('members')}
          >
            {tr('roles.listenerMembers')}
          </button>
          <button
            type="button"
            className={targetTab === 'bots' ? 'active' : ''}
            aria-pressed={targetTab === 'bots'}
            onClick={() => setTargetTab('bots')}
          >
            {tr('roles.listenerBots')}
          </button>
        </div>
        <div className="roles-listener-filter-toolbar">
          <input
            type="search"
            value={targetQuery}
            placeholder={tr('roles.listenerSearchPlaceholder')}
            onChange={ev => setTargetQuery(ev.currentTarget.value)}
          />
          {targetQuery ? (
            <button type="button" className="roles-listener-clear-search" onClick={() => setTargetQuery('')} aria-label={tr('roles.listenerClearSearch')}>
              ×
            </button>
          ) : null}
          <button
            type="button"
            className="roles-listener-select-all"
            disabled={filteredTargetIds.length === 0}
            onClick={toggleAllVisible}
          >
            {tr(allVisibleSelected ? 'roles.listenerClearVisible' : 'roles.listenerSelectVisible', { count: filteredTargetIds.length })}
          </button>
        </div>
        <div className="roles-listener-bulkbar">
          <span>
            {selectedIds.length > 0
              ? tr('roles.listenerSelectedCount', { count: selectedIds.length })
              : tr('roles.listenerFilteredCount', { count: filteredTargetIds.length })}
            {bulkState === 'mixed' ? ` · ${tr('roles.listenerMixedMode')}` : ''}
          </span>
          <div className="roles-listener-member-actions" role="group" aria-label={tr('roles.listenerBulkActions')}>
            <button
              type="button"
              className={bulkState === 'listen' ? 'active' : ''}
              aria-pressed={bulkState === 'listen'}
              disabled={bulkTargetIds.length === 0}
              onClick={() => applyBulkState(true)}
            >
              {tr('roles.listenerTargetListen')}
            </button>
            <button
              type="button"
              className={bulkState === 'ignore' ? 'active' : ''}
              aria-pressed={bulkState === 'ignore'}
              disabled={bulkTargetIds.length === 0}
              onClick={() => applyBulkState(false)}
            >
              {tr('roles.listenerTargetIgnore')}
            </button>
          </div>
        </div>
        <div className="roles-listener-member-list">
          {filteredTargets.length === 0 ? (
            <div className="roles-empty">{tr(targetTab === 'bots' ? 'roles.listenerBotsEmpty' : 'roles.listenerMembersEmpty')}</div>
          ) : filteredTargets.map(member => {
            const targetState = listenerTargetStateFor({
              mode: senderMode,
              include: [...includeIds],
              exclude: [...excludeIds],
              targetIds: [member.openId],
            });
            return (
              <div className="roles-listener-member" key={member.openId}>
                <label className="roles-listener-member-select" aria-label={memberDisplayName(member, member.openId)}>
                  <input
                    type="checkbox"
                    checked={selectedTargetIds.has(member.openId)}
                    onChange={ev => toggleTargetSelection(member.openId, ev.currentTarget.checked)}
                  />
                </label>
                <div className="roles-listener-member-main">
                  <strong>{memberDisplayName(member, member.openId)}</strong>
                  <span>{member.openId}</span>
                </div>
                <div className="roles-listener-member-actions" role="group" aria-label={memberDisplayName(member, member.openId)}>
                  <button
                    type="button"
                    className={targetState === 'listen' ? 'active' : ''}
                    aria-pressed={targetState === 'listen'}
                    onClick={() => props.onSetTargetPolicy(member.openId, true)}
                  >
                    {tr('roles.listenerTargetListen')}
                  </button>
                  <button
                    type="button"
                    className={targetState === 'ignore' ? 'active' : ''}
                    aria-pressed={targetState === 'ignore'}
                    onClick={() => props.onSetTargetPolicy(member.openId, false)}
                  >
                    {tr('roles.listenerTargetIgnore')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
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

function ListenerPreviewResult(props: { status: ListenerPreviewStatus; tr: Translator }) {
  const { status, tr } = props;
  if (status.kind === 'idle') return <div className="roles-listener-preview-empty">{tr('roles.listenerPreviewEmpty')}</div>;
  if (status.kind === 'loading') return <LoadingState label={tr('common.loading')} />;
  if (status.kind === 'error') return <div className="roles-listener-preview-error">{status.text}</div>;
  const matches = status.response.matches ?? [];
  const results = status.response.results ?? [];
  const stateCounts = results.reduce((acc, result) => {
    const state = !result.ok ? 'failed' : result.state ?? 'triggered';
    acc[state] = (acc[state] ?? 0) + 1;
    return acc;
  }, {} as Record<MessageListenerRunPreviewState, number>);
  return (
    <div className="roles-listener-preview-results">
      <div className="roles-listener-preview-summary">
        {status.mode === 'run'
          ? tr('roles.listenerRunPreviewSummary', {
              count: matches.length,
              triggered: stateCounts.triggered ?? 0,
              running: stateCounts.running ?? 0,
              replied: stateCounts.replied ?? 0,
              failed: stateCounts.failed ?? 0,
            })
          : tr('roles.listenerPreviewSummary', { count: matches.length })}
      </div>
      {matches.length === 0 ? (
        <div className="roles-listener-preview-empty">{tr('roles.listenerPreviewNoMatches')}</div>
      ) : (
        <div className="roles-listener-preview-list">
          {matches.map(item => (
            <ListenerPreviewItem
              item={item}
              result={status.response.results?.find(result => result.messageId === item.messageId)}
              tr={tr}
              key={item.messageId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ListenerPreviewItem(props: {
  item: MessageListenerPreviewItem;
  result?: MessageListenerRunPreviewResult;
  tr: Translator;
}) {
  const text = props.item.messageText.length > 300
    ? `${props.item.messageText.slice(0, 300)}...`
    : props.item.messageText;
  const senderLabel = props.item.senderName || props.item.senderOpenId || props.item.senderType;
  const sentAt = formatListenerPreviewTime(props.item.createTime);
  return (
    <div className="roles-listener-preview-item">
      <div className="roles-listener-preview-meta">
        <span>{props.item.msgType}</span>
        <span>{props.item.senderType}</span>
        {props.item.senderOpenId ? <span>{props.item.senderOpenId}</span> : null}
        <span>{props.item.messageId}</span>
        {props.result ? (
          <span className={listenerRunPreviewStateClass(props.result.state, props.result.ok)}>
            {props.tr(`roles.listenerRunPreviewState.${!props.result.ok ? 'failed' : props.result.state ?? 'triggered'}`)}
          </span>
        ) : null}
      </div>
      {props.result?.sessionId || props.result?.replyMessageId || props.result?.error ? (
        <div className="roles-listener-preview-run-detail">
          {props.result.sessionId ? <span>{props.result.sessionId}</span> : null}
          {props.result.replyMessageId ? <span>{props.result.replyMessageId}</span> : null}
          {props.result.error ? <strong>{props.result.error}</strong> : null}
        </div>
      ) : null}
      <div className="roles-listener-preview-sender">
        <span>{props.tr('roles.listenerPreviewSender')}</span>
        <strong>{senderLabel}</strong>
      </div>
      {sentAt ? (
        <div className="roles-listener-preview-time">
          <span>{props.tr('roles.listenerPreviewTime')}</span>
          <strong>{sentAt}</strong>
        </div>
      ) : null}
      {props.item.messageTitle ? (
        <div className="roles-listener-preview-title">
          <span>{props.tr('roles.listenerPreviewMessageTitle')}</span>
          <strong>{props.item.messageTitle}</strong>
        </div>
      ) : null}
      <div className="roles-listener-preview-content-label">{props.tr('roles.listenerPreviewContent')}</div>
      <pre>{text}</pre>
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
