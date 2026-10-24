import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Html, LoadingState } from './dashboard-components.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { confirm } from './confirm-modal.js';
import { setLeaveGuard } from './leave-guard.js';
import { toast } from './toast.js';
import { cloneListener, LISTENER_MESSAGE_TYPES, MessageListenerEditor, type FlashState, type ListenerPreviewStatus } from './roles-page.js';
import {
  buildListenerSavePayload, describeListenerWidening, listenerDraftKey, patchListenerContentPolicy, patchListenerMessagePolicy,
  patchListenerSenderPolicy, toggleListenerMsgType, toggleListenerSenderType,
} from './listener-draft.js';
import { botAvatarHtml } from './ui.js';
import {
  loadGroups, loadGroupMemberDisplays, loadMessageListenerRunPreviewStatus, MAX_MESSAGE_LISTENER_PROMPT_BYTES, previewMessageListener,
  runMessageListenerPreview, type DashboardBot, type GroupInfo, type MessageListenerData,
} from './roles.js';
import type { GroupMemberDisplay, MessageListenerRunPreviewResult } from './roles.js';

type Translator = ReturnType<typeof useT>;
type GroupMode = 'inherit' | 'disabled' | 'custom';
type ListenerGroup = { chatId: string; name?: string; mode: GroupMode; listener: MessageListenerData | null };

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

type EditorScope = 'global' | 'group';
// A save result belongs to the editor that produced it; with both editors kept
// mounted behind tabs, it must not also surface in the other one.
type PageFlash = (NonNullable<FlashState> & { scope: EditorScope }) | null;

// Group settings come first: picking how each chat behaves is the everyday
// task, while the global rule is set up once and then inherited.
type ListenerTab = 'groups' | 'global';
const LISTENER_TABS: readonly ListenerTab[] = ['groups', 'global'];

const MODE_LABEL_KEY: Record<GroupMode, string> = {
  inherit: 'listeners.modeInherit',
  disabled: 'listeners.modeDisabled',
  custom: 'listeners.modeCustom',
};

// The custom rule being edited for one group of one Bot, and what it was when
// loaded or last saved. `persisted: false` is a group switched to custom in
// this tab and never saved: until it is, the group list keeps showing the
// group's real (saved) mode.
type CustomEdit = { botId: string; chatId: string; persisted: boolean; base: MessageListenerData; draft: MessageListenerData };

// Whether the group handles messages right now, from what is saved.
function isListening(group: ListenerGroup, savedGlobal: MessageListenerData): boolean {
  if (group.mode === 'disabled') return false;
  if (group.mode === 'custom') return group.listener?.enabled === true;
  return savedGlobal.enabled;
}

// Mirrors the daemon's validateMessageListenerUpdate, so a rule it would
// reject is stopped before the round trip and explained in words.
function listenerProblem(listener: MessageListenerData): string | null {
  // The size limit applies to disabled drafts too; the rest only to enabled rules.
  if (new TextEncoder().encode(listener.prompt.trim()).length > MAX_MESSAGE_LISTENER_PROMPT_BYTES) return 'prompt_too_large';
  if (!listener.enabled) return null;
  if (!listener.prompt.trim()) return 'prompt_required';
  if (listener.senderPolicy?.mode !== 'all_except_excluded' && (listener.senderPolicy?.includeSenderOpenIds?.length ?? 0) === 0) return 'sender_required';
  return null;
}

// Save and preview failures arrive as daemon reason codes.
function listenerErrorText(error: unknown, tr: Translator): string {
  const reason = error instanceof Error ? error.message : String(error);
  switch (reason) {
    case 'prompt_required': return tr('roles.listenerPromptRequired');
    case 'sender_required': return tr('roles.listenerSenderRequired');
    case 'prompt_too_large': return tr('listeners.errorPromptTooLarge', { max: MAX_MESSAGE_LISTENER_PROMPT_BYTES });
    case 'invalid_listener': return tr('listeners.errorInvalid');
    default: return reason;
  }
}

function ListenerTabs(props: {
  active: ListenerTab;
  groupCount: number;
  globalEnabled: boolean;
  globalDirty: boolean;
  onChange(tab: ListenerTab): void;
}) {
  const tr = useT();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectAt = (index: number) => {
    const nextIndex = (index + LISTENER_TABS.length) % LISTENER_TABS.length;
    props.onChange(LISTENER_TABS[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  };
  return (
    <nav className="message-listener-tab-bar" aria-label={tr('listeners.tabsLabel')}>
      <div className="message-listener-tabs" role="tablist">
        {LISTENER_TABS.map((tab, index) => (
          <button
            ref={node => { tabRefs.current[index] = node; }}
            key={tab}
            id={`message-listener-tab-${tab}`}
            type="button"
            role="tab"
            className={`message-listener-tab${props.active === tab ? ' active' : ''}`}
            aria-selected={props.active === tab}
            aria-controls={`message-listener-panel-${tab}`}
            tabIndex={props.active === tab ? 0 : -1}
            data-listener-tab={tab}
            onClick={() => props.onChange(tab)}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') { event.preventDefault(); selectAt(index + 1); }
              else if (event.key === 'ArrowLeft') { event.preventDefault(); selectAt(index - 1); }
              else if (event.key === 'Home') { event.preventDefault(); selectAt(0); }
              else if (event.key === 'End') { event.preventDefault(); selectAt(LISTENER_TABS.length - 1); }
            }}
          >
            {tab === 'groups' ? <>
              <span>{tr('listeners.tabGroups')}</span>
              <span className="message-listener-tab-count">{props.groupCount}</span>
            </> : <>
              <span>{tr('listeners.tabGlobal')}</span>
              <span className={`message-listener-tab-state ${props.globalEnabled ? 'on' : 'off'}`}>{tr(props.globalEnabled ? 'listeners.globalOn' : 'listeners.globalOff')}</span>
              {props.globalDirty ? <span className="message-listener-tab-dirty" title={tr('listeners.unsavedChanges')} aria-label={tr('listeners.unsavedChanges')} /> : null}
            </>}
          </button>
        ))}
      </div>
    </nav>
  );
}

function mergeRunResults(
  previous: MessageListenerRunPreviewResult[] | undefined,
  next: MessageListenerRunPreviewResult[] | undefined,
): MessageListenerRunPreviewResult[] {
  const merged = new Map<string, MessageListenerRunPreviewResult>();
  for (const result of previous ?? []) merged.set(result.messageId, result);
  for (const result of next ?? []) merged.set(result.messageId, { ...merged.get(result.messageId), ...result });
  return [...merged.values()];
}

export function MessageListenersPage() {
  const tr = useT();
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [bots, setBots] = useState<DashboardBot[]>([]);
  const [botId, setBotId] = useState<string>();
  // Which Bot the listener state below belongs to. Until it matches `botId`
  // the workspace shows a loader: a just-switched Bot must never show (and
  // save) the previous Bot's rules.
  const [loadState, setLoadState] = useState<{ botId?: string; error?: string }>({});
  const [global, setGlobal] = useState<MessageListenerData>(() => cloneListener(null));
  // Last persisted global rule. Inherit summaries, the tab badge and new custom
  // drafts describe what groups actually run, never an unsaved global draft.
  const [savedGlobal, setSavedGlobal] = useState<MessageListenerData>(() => cloneListener(null));
  const [tab, setTab] = useState<ListenerTab>('groups');
  const [listenerGroups, setListenerGroups] = useState<ListenerGroup[]>([]);
  const [expanded, setExpanded] = useState<string>();
  const [customEdit, setCustomEdit] = useState<CustomEdit | null>(null);
  const [globalMembers, setGlobalMembers] = useState<GroupMemberDisplay[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMemberDisplay[]>([]);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [groupSaving, setGroupSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<PageFlash>(null);
  const [sampleChatId, setSampleChatId] = useState<string>();
  const [globalPreviewStatus, setGlobalPreviewStatus] = useState<ListenerPreviewStatus>({ kind: 'idle' });
  const [groupPreviewStatus, setGroupPreviewStatus] = useState<ListenerPreviewStatus>({ kind: 'idle' });
  const [globalPreviewLimit, setGlobalPreviewLimit] = useState(5);
  const [groupPreviewLimit, setGroupPreviewLimit] = useState(5);
  const [groupQuery, setGroupQuery] = useState('');
  const [botQuery, setBotQuery] = useState('');
  const refreshGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const globalPreviewGeneration = useRef(0);
  const groupPreviewGeneration = useRef(0);
  const globalRunTimer = useRef<number | undefined>(undefined);
  const groupRunTimer = useRef<number | undefined>(undefined);

  const loadInitial = async () => {
    try {
      const snapshot = await loadGroups();
      const unique = new Map<string, DashboardBot>();
      snapshot.groups.forEach(group => group.memberBots.filter(bot => bot.inChat).forEach(bot => unique.set(bot.larkAppId, { larkAppId: bot.larkAppId, botName: bot.botName })));
      const allBots = [...unique.values()];
      const botWithMostChats = allBots.slice().sort((a, b) => {
        const count = (id: string) => snapshot.groups.filter(group => group.memberBots.some(member => member.inChat && member.larkAppId === id)).length;
        return count(b.larkAppId) - count(a.larkAppId);
      })[0];
      setLoadState({});
      setGroups(snapshot.groups); setBots(allBots); setBotId(botWithMostChats?.larkAppId);
    } catch (error) {
      setLoadState({ error: listenerErrorText(error, tr) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void loadInitial(); }, []);

  // `groupsOnly` re-reads group state without touching the global rule, so
  // saving one group never discards an unsaved global draft in the other tab.
  const refresh = async (id = botId, options: { groupsOnly?: boolean } = {}) => {
    if (!id) return;
    const generation = ++refreshGeneration.current;
    let globalData: any;
    let groupData: any;
    try {
      [globalData, groupData] = await Promise.all([
        options.groupsOnly ? null : api(`/api/global-message-listener/${encodeURIComponent(id)}`),
        api(`/api/group-message-listeners/${encodeURIComponent(id)}`),
      ]);
    } catch (error) {
      if (generation === refreshGeneration.current && !options.groupsOnly) setLoadState({ botId: id, error: listenerErrorText(error, tr) });
      return;
    }
    if (generation !== refreshGeneration.current) return;
    if (globalData) {
      setGlobal(cloneListener(globalData.listener));
      setSavedGlobal(cloneListener(globalData.listener));
    }
    // The dashboard's aggregate groups matrix is the authority for which chats
    // this Bot currently belongs to. The daemon endpoint only supplies each
    // chat's listener state; it must not make a transient Feishu list failure
    // turn the management list empty.
    const modes = new Map<string, ListenerGroup>((groupData.groups ?? []).map((group: ListenerGroup) => [group.chatId, group]));
    const dashboardJoined = groups
      .filter(group => group.memberBots.some(member => member.inChat && member.larkAppId === id))
      .map(group => ({ chatId: group.chatId, name: group.name, mode: modes.get(group.chatId)?.mode ?? 'inherit', listener: modes.get(group.chatId)?.listener ?? null }));
    // Lark's group matrix can lag after invites/restores; retain any directly
    // listed bot chat as well, then enrich it with the Dashboard display name.
    const joinedById = new Map<string, ListenerGroup>(dashboardJoined.map(group => [group.chatId, group]));
    for (const group of modes.values()) {
      if (!joinedById.has(group.chatId)) joinedById.set(group.chatId, group);
    }
    const joined = [...joinedById.values()];
    setListenerGroups(joined);
    setSampleChatId(previous => previous && joined.some(group => group.chatId === previous) ? previous : joined[0]?.chatId);
    if (!options.groupsOnly) setLoadState({ botId: id });
  };
  useEffect(() => { void refresh(); }, [botId, groups]);
  useEffect(() => {
    contextGeneration.current += 1;
    setGlobalSaving(false);
    setGroupSaving(false);
  }, [botId]);
  useEffect(() => {
    // A split workspace without a selected chat has no useful right-hand
    // state. Keep selection valid across refreshes and Bot switches.
    if (listenerGroups.length > 0 && !listenerGroups.some(group => group.chatId === expanded)) {
      setExpanded(listenerGroups[0].chatId);
    }
  }, [expanded, listenerGroups]);

  const ready = !!botId && loadState.botId === botId && !loadState.error;
  const selected = listenerGroups.find(group => group.chatId === expanded);
  const visibleGroups = listenerGroups.filter(group => {
    const query = groupQuery.trim().toLowerCase();
    return !query || (group.name ?? group.chatId).toLowerCase().includes(query) || group.chatId.toLowerCase().includes(query);
  });
  const visibleBots = bots.filter(bot => {
    const query = botQuery.trim().toLowerCase();
    return !query || bot.botName.toLowerCase().includes(query) || bot.larkAppId.toLowerCase().includes(query);
  });
  const groupName = (chatId: string) => listenerGroups.find(group => group.chatId === chatId)?.name ?? chatId;
  // Load the selected group's saved custom rule, but never replace an edit in
  // progress for the same Bot and group (including an unsaved switch to custom).
  useEffect(() => {
    setCustomEdit(current => {
      if (!ready || !botId || !selected) return null;
      if (current && current.botId === botId && current.chatId === selected.chatId && (!current.persisted || selected.mode === 'custom')) return current;
      if (selected.mode !== 'custom') return null;
      const base = cloneListener(selected.listener);
      return { botId, chatId: selected.chatId, persisted: true, base, draft: cloneListener(base) };
    });
  }, [ready, botId, selected?.chatId, selected?.mode]);
  useEffect(() => {
    let active = true;
    if (!botId || !sampleChatId) { setGlobalMembers([]); return () => { active = false; }; }
    void loadGroupMemberDisplays(botId, sampleChatId).then(members => { if (active) setGlobalMembers(members); }).catch(() => { if (active) setGlobalMembers([]); });
    return () => { active = false; };
  }, [botId, sampleChatId]);
  useEffect(() => {
    let active = true;
    if (!botId || !expanded) { setGroupMembers([]); return () => { active = false; }; }
    void loadGroupMemberDisplays(botId, expanded).then(members => { if (active) setGroupMembers(members); }).catch(() => { if (active) setGroupMembers([]); });
    return () => { active = false; };
  }, [botId, expanded]);
  const globalMemberById = useMemo(() => new Map(globalMembers.map(member => [member.openId, member])), [globalMembers]);
  const groupMemberById = useMemo(() => new Map(groupMembers.map(member => [member.openId, member])), [groupMembers]);
  const globalDirty = useMemo(() => listenerDraftKey(global) !== listenerDraftKey(savedGlobal), [global, savedGlobal]);
  const customEdited = useMemo(() => !!customEdit && listenerDraftKey(customEdit.draft) !== listenerDraftKey(customEdit.base), [customEdit]);
  const customDirty = !!customEdit && (!customEdit.persisted || customEdited);
  const modeCounts = useMemo(() => {
    const counts: Record<GroupMode | 'listening', number> = { inherit: 0, disabled: 0, custom: 0, listening: 0 };
    listenerGroups.forEach(group => {
      counts[group.mode] += 1;
      if (isListening(group, savedGlobal)) counts.listening += 1;
    });
    return counts;
  }, [listenerGroups, savedGlobal]);
  const payloadFor = (scope: EditorScope, listener: MessageListenerData) => {
    const memberById = scope === 'global' ? globalMemberById : groupMemberById;
    return buildListenerSavePayload(listener, openId => memberById.get(openId)?.memberType);
  };
  const setCustomDraft: Dispatch<SetStateAction<MessageListenerData>> = action => setCustomEdit(current => current && {
    ...current,
    draft: typeof action === 'function' ? action(current.draft) : action,
  });
  const confirmDiscard = (message: string) => confirm({ title: tr('listeners.discardTitle'), message, confirmLabel: tr('listeners.discardConfirm'), danger: true });

  // Unsaved edits survive tab switches; leaving the page, switching Bot or
  // switching group asks first.
  const dirtyRef = useRef(false);
  dirtyRef.current = ready && (globalDirty || customDirty);
  useEffect(() => setLeaveGuard(() => dirtyRef.current
    ? { title: tr('listeners.discardTitle'), message: tr('listeners.discardLeave'), confirmLabel: tr('listeners.discardConfirm') }
    : null), [tr]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const invalidatePreview = (scope: EditorScope) => {
    const generation = scope === 'global' ? globalPreviewGeneration : groupPreviewGeneration;
    generation.current += 1;
    const timer = scope === 'global' ? globalRunTimer : groupRunTimer;
    if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined; }
    (scope === 'global' ? setGlobalPreviewStatus : setGroupPreviewStatus)({ kind: 'idle' });
  };
  const selectBot = async (id: string) => {
    if (id === botId) return;
    if (dirtyRef.current && !await confirmDiscard(tr('listeners.discardBot'))) return;
    // Invalidate synchronously, rather than waiting for the effect after the
    // render. A just-resolved preview/save promise must not get even one frame
    // to write its old Bot's result into the new Bot's editor.
    contextGeneration.current += 1;
    refreshGeneration.current += 1;
    invalidatePreview('global');
    invalidatePreview('group');
    setGlobalSaving(false);
    setGroupSaving(false);
    setCustomEdit(null);
    setBotId(id);
  };
  const selectSampleChat = (id: string) => {
    invalidatePreview('global');
    setSampleChatId(id);
  };
  const selectGroup = async (id: string) => {
    if (id === expanded) return;
    if (customDirty && customEdit && !await confirmDiscard(tr('listeners.discardGroup', { name: groupName(customEdit.chatId) }))) return;
    invalidatePreview('group');
    setCustomEdit(null);
    setExpanded(id);
  };
  useEffect(() => { invalidatePreview('global'); }, [botId, sampleChatId]);
  useEffect(() => { invalidatePreview('group'); }, [botId, expanded]);
  useEffect(() => () => {
    if (globalRunTimer.current !== undefined) window.clearTimeout(globalRunTimer.current);
    if (groupRunTimer.current !== undefined) window.clearTimeout(groupRunTimer.current);
  }, []);

  const saveGlobal = async () => {
    if (!botId) return;
    const snapshot = global;
    const problem = listenerProblem(snapshot);
    if (problem) { setFlash({ text: listenerErrorText(problem, tr), isError: true, id: Date.now(), scope: 'global' }); return; }
    // The global rule runs in every inheriting group at once: say how far a
    // change that makes it fire more (or reply more visibly) reaches.
    const widening = describeListenerWidening(savedGlobal, snapshot, LISTENER_MESSAGE_TYPES);
    if (modeCounts.inherit > 0 && widening.length > 0 && !await confirm({
      title: tr('listeners.confirmGlobalTitle'),
      message: tr('listeners.confirmGlobal', { count: modeCounts.inherit, changes: widening.map(reason => tr(`listeners.widen.${reason}`)).join(tr('listeners.listSeparator')) }),
      confirmLabel: tr('roles.save'),
    })) return;
    const requestBotId = botId;
    const generation = contextGeneration.current;
    setGlobalSaving(true);
    try {
      await api(`/api/global-message-listener/${encodeURIComponent(requestBotId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payloadFor('global', snapshot)) });
      if (generation === contextGeneration.current) {
        setSavedGlobal(snapshot);
        setFlash({ text: tr('roles.saved'), id: Date.now(), scope: 'global' });
      }
    } catch (error) {
      if (generation === contextGeneration.current) setFlash({ text: tr('listeners.saveFailed', { reason: listenerErrorText(error, tr) }), isError: true, id: Date.now(), scope: 'global' });
    } finally {
      if (generation === contextGeneration.current) setGlobalSaving(false);
    }
  };
  const setMode = async (group: ListenerGroup, mode: GroupMode) => {
    if (!botId) return;
    const pending = customEdit?.chatId === group.chatId && !customEdit.persisted ? customEdit : null;
    if (mode === (pending ? 'custom' : group.mode)) return;
    if (mode === 'custom') {
      // Only a local draft until saved: the group keeps running its saved mode.
      invalidatePreview('group');
      const base = cloneListener(group.listener ?? savedGlobal);
      setCustomEdit({ botId, chatId: group.chatId, persisted: false, base, draft: cloneListener(base) });
      return;
    }
    if (pending) {
      if (customEdited && !await confirmDiscard(tr('listeners.discardGroup', { name: groupName(group.chatId) }))) return;
      invalidatePreview('group');
      setCustomEdit(null);
      // Backing out of an unsaved switch to custom needs no write.
      if (mode === group.mode) return;
    } else if (group.mode === 'custom' && !await confirm({ title: tr('listeners.confirmDeleteCustomTitle'), message: tr('listeners.confirmDeleteCustom'), danger: true })) {
      return;
    }
    const requestBotId = botId;
    const generation = contextGeneration.current;
    const previous = group;
    invalidatePreview('group');
    // Switching policy should feel instantaneous. Persist in the background;
    // only restore the previous state when the write actually fails.
    setListenerGroups(current => current.map(item => item.chatId === group.chatId ? { ...item, mode, listener: null } : item));
    try {
      await api(`/api/group-message-listeners/${encodeURIComponent(requestBotId)}/${encodeURIComponent(group.chatId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    } catch (error) {
      if (generation === contextGeneration.current) {
        setListenerGroups(current => current.map(item => item.chatId === previous.chatId ? previous : item));
        // inherit / disabled render no editor, so there is no inline flash slot.
        toast(tr('listeners.switchFailed', { reason: listenerErrorText(error, tr) }), { kind: 'error' });
      }
    }
  };
  const saveCustom = async () => {
    if (!botId || !customEdit) return;
    const { chatId: requestChatId, draft: snapshot } = customEdit;
    const problem = listenerProblem(snapshot);
    if (problem) { setFlash({ text: listenerErrorText(problem, tr), isError: true, id: Date.now(), scope: 'group' }); return; }
    const requestBotId = botId;
    const generation = contextGeneration.current;
    const payload = payloadFor('group', snapshot);
    setGroupSaving(true);
    try {
      await api(`/api/group-message-listeners/${encodeURIComponent(requestBotId)}/${encodeURIComponent(requestChatId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'custom', listener: payload }) });
      if (generation !== contextGeneration.current) return;
      setCustomEdit(current => current && current.botId === requestBotId && current.chatId === requestChatId ? { ...current, persisted: true, base: snapshot } : current);
      setListenerGroups(current => current.map(item => item.chatId === requestChatId ? { ...item, mode: 'custom', listener: payload } : item));
      setFlash({ text: tr('roles.saved'), id: Date.now(), scope: 'group' });
      // Re-sync from the daemon; the local update above already reflects the save.
      void refresh(requestBotId, { groupsOnly: true });
    } catch (error) {
      if (generation === contextGeneration.current) setFlash({ text: tr('listeners.saveFailed', { reason: listenerErrorText(error, tr) }), isError: true, id: Date.now(), scope: 'group' });
    } finally {
      if (generation === contextGeneration.current) setGroupSaving(false);
    }
  };
  const patch = (scope: EditorScope, setter: Dispatch<SetStateAction<MessageListenerData>>) => (value: Partial<MessageListenerData>) => {
    invalidatePreview(scope);
    setter(current => ({ ...current, ...value }));
  };
  const setTargets = (setter: Dispatch<SetStateAction<MessageListenerData>>, ids: string[], listening: boolean) => setter(current => {
    const mode = current.senderPolicy?.mode === 'all_except_excluded' ? 'all_except_excluded' : 'include_only';
    const key = mode === 'include_only' ? 'includeSenderOpenIds' : 'excludeSenderOpenIds';
    const previous = new Set(current.senderPolicy?.[key] ?? []);
    ids.forEach(id => listening === (mode === 'include_only') ? previous.add(id) : previous.delete(id));
    return { ...current, senderPolicy: { ...current.senderPolicy, [key]: [...previous] } };
  });
  const previewFor = async (scope: EditorScope, run: boolean, listener: MessageListenerData) => {
    const chatId = scope === 'global' ? sampleChatId : expanded;
    const limit = scope === 'global' ? globalPreviewLimit : groupPreviewLimit;
    const generationRef = scope === 'global' ? globalPreviewGeneration : groupPreviewGeneration;
    const setStatus = scope === 'global' ? setGlobalPreviewStatus : setGroupPreviewStatus;
    if (!botId || !chatId) return;
    // Preview always evaluates the rule as enabled.
    const problem = listenerProblem({ ...listener, enabled: true });
    if (problem) { setStatus({ kind: 'error', text: listenerErrorText(problem, tr) }); return; }
    // A test run posts real replies into the group.
    if (run && !await confirm({
      title: tr('listeners.confirmRunTitle'),
      message: tr('listeners.confirmRun', { group: groupName(chatId), count: limit }),
      confirmLabel: tr('listeners.confirmRunLabel'),
    })) return;
    const generation = ++generationRef.current;
    setStatus({ kind: 'loading', mode: run ? 'run' : 'preview' });
    try {
      const payload = payloadFor(scope, listener);
      const response = run ? await runMessageListenerPreview(botId, chatId, payload, limit) : await previewMessageListener(botId, chatId, payload, limit);
      if (generation !== generationRef.current) return;
      setStatus(response.ok ? { kind: 'result', response, mode: run ? 'run' : 'preview' } : { kind: 'error', text: response.error ? listenerErrorText(response.error, tr) : tr('roles.listenerPreviewFailed') });
      if (run && response.ok && response.runId) {
        const timerRef = scope === 'global' ? globalRunTimer : groupRunTimer;
        const poll = async (): Promise<void> => {
          if (generation !== generationRef.current) return;
          try {
            const status = await loadMessageListenerRunPreviewStatus(botId, chatId, response.runId!);
            if (generation !== generationRef.current) return;
            if (!status.ok || !status.results) { timerRef.current = undefined; return; }
            setStatus(previous => previous.kind === 'result' && previous.mode === 'run' && previous.response.runId === response.runId
              ? { ...previous, response: { ...previous.response, results: mergeRunResults(previous.response.results, status.results) } }
              : previous);
            if (status.results.some(result => result.state === 'triggered' || result.state === 'running')) {
              timerRef.current = window.setTimeout(() => void poll(), 1500);
            } else {
              timerRef.current = undefined;
            }
          } catch {
            if (generation === generationRef.current) timerRef.current = window.setTimeout(() => void poll(), 2500);
          }
        };
        timerRef.current = window.setTimeout(() => void poll(), 1500);
      }
    } catch (error) {
      if (generation === generationRef.current) setStatus({ kind: 'error', text: listenerErrorText(error, tr) });
    }
  };
  const editor = (scope: EditorScope, listener: MessageListenerData, setter: Dispatch<SetStateAction<MessageListenerData>>) => {
    const isGlobal = scope === 'global';
    const members = isGlobal ? globalMembers : groupMembers;
    const memberById = isGlobal ? globalMemberById : groupMemberById;
    const previewLimit = isGlobal ? globalPreviewLimit : groupPreviewLimit;
    const previewStatus = isGlobal ? globalPreviewStatus : groupPreviewStatus;
    // Every policy edit goes through a functional update that MERGES into the
    // current draft (see listener-draft.ts): the editor reports partial patches.
    const update = (next: (current: MessageListenerData) => MessageListenerData) => { invalidatePreview(scope); setter(next); };
    const setTargetsForScope = (ids: string[], listening: boolean) => { invalidatePreview(scope); setTargets(setter, ids, listening); };
    const scopedFlash = flash?.scope === scope ? flash : null;
    return <MessageListenerEditor listener={listener} members={members} memberById={memberById} promptByteLen={new TextEncoder().encode(listener.prompt).length} loading={false} membersLoading={false} flash={scopedFlash} tr={tr} previewLimit={previewLimit} previewStatus={previewStatus} previewScope={scope} onPatch={patch(scope, setter)} onSenderPolicyPatch={senderPolicy => update(current => patchListenerSenderPolicy(current, senderPolicy))} onMessagePolicyPatch={messagePolicy => update(current => patchListenerMessagePolicy(current, messagePolicy))} onContentPolicyPatch={contentPolicy => update(current => patchListenerContentPolicy(current, contentPolicy))} onToggleSenderType={(type, checked) => update(current => toggleListenerSenderType(current, type, checked))} onToggleMsgType={(type, checked) => update(current => toggleListenerMsgType(current, type, checked))} onSetTargetPolicy={(id, listening) => setTargetsForScope([id], listening)} onSetTargetsPolicy={setTargetsForScope} onSetSenderMode={mode => update(current => patchListenerSenderPolicy(current, { mode }))} onPreview={() => void previewFor(scope, false, listener)} onRunPreview={() => void previewFor(scope, true, listener)} onPreviewLimitChange={limit => { invalidatePreview(scope); (isGlobal ? setGlobalPreviewLimit : setGroupPreviewLimit)(limit); }} />;
  };

  const selectedPending = !!selected && customEdit?.chatId === selected.chatId && !customEdit.persisted;
  const selectedMode: GroupMode | undefined = selectedPending ? 'custom' : selected?.mode;
  const selectedDescription = !selected ? '' : selectedPending
    ? tr('listeners.descPendingCustom')
    : selected.mode === 'inherit' ? tr('listeners.descInherit')
      : selected.mode === 'disabled' ? tr('listeners.descDisabled')
        : selected.listener?.enabled ? tr('listeners.descCustom') : tr('listeners.descCustomOff');
  const workspace = () => {
    if (loadState.error && loadState.botId === botId) {
      return <div className="roles-empty message-listener-load-error">
        <p>{tr('listeners.loadFailed', { reason: loadState.error })}</p>
        <button type="button" onClick={() => void (botId ? refresh() : loadInitial())}>{tr('listeners.retry')}</button>
      </div>;
    }
    if (!botId) return <div className="roles-empty">{tr('listeners.noBots')}</div>;
    if (!ready) return <LoadingState label={tr('common.loading')} />;
    return <>
      <ListenerTabs active={tab} groupCount={listenerGroups.length} globalEnabled={savedGlobal.enabled} globalDirty={globalDirty} onChange={setTab} />
      <section id="message-listener-panel-groups" role="tabpanel" aria-labelledby="message-listener-tab-groups" className="message-listener-panel message-listener-groups" hidden={tab !== 'groups'}>
        <div className="message-listener-panel-head">
          <p>{tr('listeners.groupsHint')}</p>
          {listenerGroups.length > 0 ? <span className="message-listener-mode-counts">{tr('listeners.groupCounts', { listening: modeCounts.listening, inherit: modeCounts.inherit, custom: modeCounts.custom, disabled: modeCounts.disabled })}</span> : null}
        </div>
        {!savedGlobal.enabled && modeCounts.inherit > 0 ? <div className="message-listener-banner" role="status">
          <span>{tr('listeners.globalOffBanner', { count: modeCounts.inherit })}</span>
          <button type="button" className="message-listener-link" onClick={() => setTab('global')}>{tr('listeners.enableGlobal')} →</button>
        </div> : null}
        {listenerGroups.length === 0 ? <div className="roles-empty">{tr('listeners.noGroups')}</div> : (
          <div className="message-listener-split">
            <nav className="message-listener-group-list" aria-label={tr('listeners.joinedGroups')}>
              <div className="message-listener-list-head"><strong>{tr('listeners.groupsHead')}</strong><span>{listenerGroups.length}</span></div>
              <input className="message-listener-group-search" type="search" value={groupQuery} onChange={event => setGroupQuery(event.currentTarget.value)} placeholder={tr('listeners.searchGroups')} aria-label={tr('listeners.searchGroups')} />
              <div className="message-listener-group-scroll">
              {visibleGroups.map(group => {
                const listening = isListening(group, savedGlobal);
                const unsaved = customDirty && customEdit?.chatId === group.chatId;
                return <button key={group.chatId} className={`message-listener-group-item ${expanded === group.chatId ? 'selected' : ''}`} aria-pressed={expanded === group.chatId} onClick={() => void selectGroup(group.chatId)}>
                  <strong>{group.name ?? group.chatId}</strong>
                  <span className="message-listener-group-meta">
                    <span className={`message-listener-group-status ${group.mode}`}>{tr(MODE_LABEL_KEY[group.mode])}</span>
                    <span className={`message-listener-effective ${listening ? 'on' : 'off'}`}>{tr(listening ? 'listeners.listening' : 'listeners.notListening')}</span>
                    {unsaved ? <span className="message-listener-unsaved-tag">{tr('listeners.unsaved')}</span> : null}
                  </span>
                </button>;
              })}
              {visibleGroups.length === 0 ? <div className="message-listener-no-match">{tr('listeners.noGroupMatch')}</div> : null}
              </div>
            </nav>
            <div className="message-listener-group-detail">
              {selected && selectedMode ? <>
                <div className="message-listener-detail-head">
                  <div><h3>{selected.name ?? selected.chatId}</h3><p>{selectedDescription}</p></div>
                  <div className="message-listener-detail-actions">
                    <span className={`message-listener-mode ${selectedMode}`}>{tr(MODE_LABEL_KEY[selectedMode])}</span>
                    {customDirty ? <span className="message-listener-unsaved">{tr('listeners.unsavedChanges')}</span> : null}
                    {selectedMode === 'custom' ? <button type="button" className="primary" disabled={groupSaving || !customEdit} onClick={() => void saveCustom()}>{groupSaving ? '...' : tr('roles.save')}</button> : null}
                  </div>
                </div>
                <div className="message-listener-detail-body">
                  <div className="segmented message-listener-mode-picker">
                    <button className={selectedMode === 'inherit' ? 'active' : ''} onClick={() => void setMode(selected, 'inherit')}>{tr('listeners.pickInherit')}</button>
                    <button className={selectedMode === 'disabled' ? 'active' : ''} onClick={() => void setMode(selected, 'disabled')}>{tr('listeners.pickDisabled')}</button>
                    <button className={selectedMode === 'custom' ? 'active' : ''} onClick={() => void setMode(selected, 'custom')}>{tr('listeners.pickCustom')}</button>
                  </div>
                  {selectedMode === 'inherit' ? <div className="message-listener-inherit-summary">
                    <div className="message-listener-summary-icon">◎</div>
                    <div>
                      <strong>{tr(savedGlobal.enabled ? 'listeners.inheritOn' : 'listeners.inheritOff')}</strong>
                      <p>{savedGlobal.enabled
                        ? tr('listeners.inheritSummary', {
                          reply: tr(savedGlobal.replyPolicy?.mode === 'chat' ? 'listeners.replyChat' : 'listeners.replyThread'),
                          keywords: savedGlobal.contentPolicy?.includeKeywords?.length
                            ? tr('listeners.keywords', { keywords: savedGlobal.contentPolicy.includeKeywords.join(tr('listeners.listSeparator')) })
                            : tr('listeners.noKeywords'),
                        })
                        : tr('listeners.inheritOffHint')}</p>
                      <button type="button" className="message-listener-link" onClick={() => setTab('global')}>{tr(savedGlobal.enabled ? 'listeners.viewGlobal' : 'listeners.enableGlobal')} →</button>
                    </div>
                  </div> : null}
                  {selectedMode === 'disabled' ? <div className="message-listener-disabled-summary"><strong>{tr('listeners.disabledTitle')}</strong><p>{tr('listeners.disabledHint')}</p></div> : null}
                  {selectedMode === 'custom' && customEdit ? <div className="message-listener-custom-form">{editor('group', customEdit.draft, setCustomDraft)}</div> : null}
                </div>
              </> : null}
            </div>
          </div>
        )}
      </section>
      <section id="message-listener-panel-global" role="tabpanel" aria-labelledby="message-listener-tab-global" className="message-listener-panel message-listener-global" hidden={tab !== 'global'}>
        <div className="message-listener-panel-head">
          <p>{tr('listeners.globalHint', { count: modeCounts.inherit })}</p>
          <div className="message-listener-panel-actions">
            {globalDirty ? <span className="message-listener-unsaved">{tr('listeners.unsavedChanges')}</span> : null}
            <button type="button" className="primary" disabled={globalSaving} onClick={() => void saveGlobal()}>{globalSaving ? '...' : tr('roles.save')}</button>
          </div>
        </div>
        <div className="message-listener-panel-body">
          <label className="roles-listener-field message-listener-sample"><span className="roles-field-label">{tr('listeners.sampleChat')}</span><select disabled={listenerGroups.length === 0} value={sampleChatId ?? ''} onChange={event => selectSampleChat(event.currentTarget.value)}><option value="" disabled>{tr(listenerGroups.length === 0 ? 'listeners.sampleChatNone' : 'listeners.sampleChatPick')}</option>{listenerGroups.map(group => <option key={group.chatId} value={group.chatId}>{group.name ?? group.chatId}</option>)}</select></label>
          <div className="message-listener-global-form">{editor('global', global, setGlobal)}</div>
        </div>
      </section>
    </>;
  };

  if (loading) return <LoadingState label={tr('common.loading')} />;
  return (
    <section className="page roles-page message-listener-page bot-defaults-page">
      <div className="page-heading"><div><p className="eyebrow">{tr('nav.group.workforce')}</p><h1>{tr('nav.messageListeners')}</h1></div></div>
      <div className="roles-layout">
        <aside className="bd-roster message-listener-bot-roster">
          <form id="bd-filters" onSubmit={event => event.preventDefault()}>
            <input type="search" value={botQuery} onChange={event => setBotQuery(event.currentTarget.value)} placeholder={tr('listeners.searchBots')} aria-label={tr('listeners.searchBotsLabel')} />
          </form>
          <div className="bd-roster-meta"><span>{tr('listeners.botCount', { count: visibleBots.length })}</span></div>
          <div className="bd-roster-list">{visibleBots.map(bot => (
          <div key={bot.larkAppId} className={`bd-roster-item ${botId === bot.larkAppId ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => void selectBot(bot.larkAppId)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectBot(bot.larkAppId); }
          }}>
            <Html html={botAvatarHtml({ name: bot.botName, larkAppId: bot.larkAppId, avatarUrl: bot.botAvatarUrl, size: 'sm' })} />
            <div className="bd-roster-tx"><b>{bot.botName}</b><span>{bot.larkAppId}</span></div>
          </div>
          ))}</div>
        </aside>
        <div className="roles-editor-panel message-listener-workspace">{workspace()}</div>
      </div>
    </section>
  );
}

export function renderMessageListenersPage(root: HTMLElement): PageDisposer { return mountReactPage(root, <MessageListenersPage />); }
