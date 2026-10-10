import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Html, LoadingState } from './dashboard-components.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { confirm } from './confirm-modal.js';
import { cloneListener, MessageListenerEditor, type FlashState, type ListenerPreviewStatus } from './roles-page.js';
import { botAvatarHtml } from './ui.js';
import {
  loadGroups, loadGroupMemberDisplays, loadMessageListenerRunPreviewStatus, previewMessageListener, runMessageListenerPreview,
  type DashboardBot, type GroupInfo, type MessageListenerData,
} from './roles.js';
import type { GroupMemberDisplay, MessageListenerRunPreviewResult } from './roles.js';

type GroupMode = 'inherit' | 'disabled' | 'custom';
type ListenerGroup = { chatId: string; name?: string; mode: GroupMode; listener: MessageListenerData | null };

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

type EditorScope = 'global' | 'group';

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
  const [global, setGlobal] = useState<MessageListenerData>(() => cloneListener(null));
  const [listenerGroups, setListenerGroups] = useState<ListenerGroup[]>([]);
  const [expanded, setExpanded] = useState<string>();
  const [customDraft, setCustomDraft] = useState<MessageListenerData>(() => cloneListener(null));
  const [globalMembers, setGlobalMembers] = useState<GroupMemberDisplay[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMemberDisplay[]>([]);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [groupSaving, setGroupSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<FlashState>(null);
  const [sampleChatId, setSampleChatId] = useState<string>();
  const [globalPreviewStatus, setGlobalPreviewStatus] = useState<ListenerPreviewStatus>({ kind: 'idle' });
  const [groupPreviewStatus, setGroupPreviewStatus] = useState<ListenerPreviewStatus>({ kind: 'idle' });
  const [globalPreviewLimit, setGlobalPreviewLimit] = useState(5);
  const [groupPreviewLimit, setGroupPreviewLimit] = useState(5);
  const [globalExpanded, setGlobalExpanded] = useState(true);
  const [groupsExpanded, setGroupsExpanded] = useState(true);
  const [groupQuery, setGroupQuery] = useState('');
  const [botQuery, setBotQuery] = useState('');
  const refreshGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const globalPreviewGeneration = useRef(0);
  const groupPreviewGeneration = useRef(0);
  const globalRunTimer = useRef<number | undefined>(undefined);
  const groupRunTimer = useRef<number | undefined>(undefined);

  useEffect(() => { void (async () => {
    const snapshot = await loadGroups();
    const unique = new Map<string, DashboardBot>();
    snapshot.groups.forEach(group => group.memberBots.filter(bot => bot.inChat).forEach(bot => unique.set(bot.larkAppId, { larkAppId: bot.larkAppId, botName: bot.botName })));
    const allBots = [...unique.values()];
    const botWithMostChats = allBots.slice().sort((a, b) => {
      const count = (id: string) => snapshot.groups.filter(group => group.memberBots.some(member => member.inChat && member.larkAppId === id)).length;
      return count(b.larkAppId) - count(a.larkAppId);
    })[0];
    setGroups(snapshot.groups); setBots(allBots); setBotId(botWithMostChats?.larkAppId); setLoading(false);
  })().catch(error => { setFlash({ text: String(error), isError: true, id: Date.now() }); setLoading(false); }); }, []);

  const refresh = async (id = botId) => {
    if (!id) return;
    const generation = ++refreshGeneration.current;
    const [globalData, groupData] = await Promise.all([api(`/api/global-message-listener/${encodeURIComponent(id)}`), api(`/api/group-message-listeners/${encodeURIComponent(id)}`)]);
    if (generation !== refreshGeneration.current) return;
    setGlobal(cloneListener(globalData.listener));
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
  };
  useEffect(() => { void refresh().catch(error => setFlash({ text: String(error), isError: true, id: Date.now() })); }, [botId, groups]);
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

  const selected = listenerGroups.find(group => group.chatId === expanded);
  const visibleGroups = listenerGroups.filter(group => {
    const query = groupQuery.trim().toLowerCase();
    return !query || (group.name ?? group.chatId).toLowerCase().includes(query) || group.chatId.toLowerCase().includes(query);
  });
  const visibleBots = bots.filter(bot => {
    const query = botQuery.trim().toLowerCase();
    return !query || bot.botName.toLowerCase().includes(query) || bot.larkAppId.toLowerCase().includes(query);
  });
  useEffect(() => { if (selected?.mode === 'custom') setCustomDraft(cloneListener(selected.listener)); }, [expanded, selected?.mode]);
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

  const invalidatePreview = (scope: EditorScope) => {
    const generation = scope === 'global' ? globalPreviewGeneration : groupPreviewGeneration;
    generation.current += 1;
    const timer = scope === 'global' ? globalRunTimer : groupRunTimer;
    if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined; }
    (scope === 'global' ? setGlobalPreviewStatus : setGroupPreviewStatus)({ kind: 'idle' });
  };
  const selectBot = (id: string) => {
    // Invalidate synchronously, rather than waiting for the effect after the
    // render. A just-resolved preview/save promise must not get even one frame
    // to write its old Bot's result into the new Bot's editor.
    contextGeneration.current += 1;
    refreshGeneration.current += 1;
    invalidatePreview('global');
    invalidatePreview('group');
    setGlobalSaving(false);
    setGroupSaving(false);
    setBotId(id);
  };
  const selectSampleChat = (id: string) => {
    invalidatePreview('global');
    setSampleChatId(id);
  };
  const selectGroup = (id: string) => {
    invalidatePreview('group');
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
    const requestBotId = botId;
    const generation = contextGeneration.current;
    setGlobalSaving(true);
    try {
      await api(`/api/global-message-listener/${encodeURIComponent(requestBotId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(global) });
      if (generation === contextGeneration.current) setFlash({ text: tr('roles.saved'), id: Date.now() });
    } catch (error) {
      if (generation === contextGeneration.current) setFlash({ text: String(error), isError: true, id: Date.now() });
    } finally {
      if (generation === contextGeneration.current) setGlobalSaving(false);
    }
  };
  const setMode = async (group: ListenerGroup, mode: GroupMode) => {
    if (!botId) return;
    const requestBotId = botId;
    const generation = contextGeneration.current;
    if (group.mode === 'custom' && mode !== 'custom' && !await confirm({ title: '切换消息监听设置', message: '切换后将删除此群的自定义监听设置。', danger: true })) return;
    if (mode === 'custom') {
      invalidatePreview('group');
      const draft = cloneListener(group.listener ?? global);
      setListenerGroups(current => current.map(item => item.chatId === group.chatId ? { ...item, mode: 'custom', listener: draft } : item));
      setExpanded(group.chatId);
      setCustomDraft(draft);
      return;
    }
    const previous = group;
    invalidatePreview('group');
    // Switching policy should feel instantaneous. Persist in the background;
    // only restore the previous state when the write actually fails.
    setListenerGroups(current => current.map(item => item.chatId === group.chatId
      ? (mode === 'inherit' ? { ...item, mode: 'inherit', listener: null } : { ...item, mode: 'disabled', listener: null })
      : item));
    try {
      await api(`/api/group-message-listeners/${encodeURIComponent(requestBotId)}/${encodeURIComponent(group.chatId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    } catch (error) {
      if (generation === contextGeneration.current) {
        setListenerGroups(current => current.map(item => item.chatId === previous.chatId ? previous : item));
        setFlash({ text: String(error), isError: true, id: Date.now() });
      }
    }
  };
  const saveCustom = async () => {
    if (!botId || !expanded) return;
    const requestBotId = botId;
    const requestChatId = expanded;
    const generation = contextGeneration.current;
    setGroupSaving(true);
    try {
      await api(`/api/group-message-listeners/${encodeURIComponent(requestBotId)}/${encodeURIComponent(requestChatId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'custom', listener: customDraft }) });
      if (generation !== contextGeneration.current) return;
      await refresh(requestBotId);
      if (generation === contextGeneration.current) setFlash({ text: tr('roles.saved'), id: Date.now() });
    } catch (error) {
      if (generation === contextGeneration.current) setFlash({ text: String(error), isError: true, id: Date.now() });
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
    const generation = ++generationRef.current;
    setStatus({ kind: 'loading', mode: run ? 'run' : 'preview' });
    try {
      const response = run ? await runMessageListenerPreview(botId, chatId, listener, limit) : await previewMessageListener(botId, chatId, listener, limit);
      if (generation !== generationRef.current) return;
      setStatus(response.ok ? { kind: 'result', response, mode: run ? 'run' : 'preview' } : { kind: 'error', text: response.error || tr('roles.listenerPreviewFailed') });
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
      if (generation === generationRef.current) setStatus({ kind: 'error', text: error instanceof Error ? error.message : tr('roles.listenerPreviewFailed') });
    }
  };
  const editor = (scope: EditorScope, listener: MessageListenerData, setter: Dispatch<SetStateAction<MessageListenerData>>) => {
    const isGlobal = scope === 'global';
    const members = isGlobal ? globalMembers : groupMembers;
    const memberById = isGlobal ? globalMemberById : groupMemberById;
    const previewLimit = isGlobal ? globalPreviewLimit : groupPreviewLimit;
    const previewStatus = isGlobal ? globalPreviewStatus : groupPreviewStatus;
    const setPolicy = (value: Partial<MessageListenerData>) => patch(scope, setter)(value);
    const setTargetsForScope = (ids: string[], listening: boolean) => { invalidatePreview(scope); setTargets(setter, ids, listening); };
    return <MessageListenerEditor listener={listener} members={members} memberById={memberById} promptByteLen={new TextEncoder().encode(listener.prompt).length} loading={false} membersLoading={false} flash={flash} tr={tr} previewLimit={previewLimit} previewStatus={previewStatus} previewScope={scope} onPatch={patch(scope, setter)} onSenderPolicyPatch={senderPolicy => setPolicy({ senderPolicy })} onMessagePolicyPatch={messagePolicy => setPolicy({ messagePolicy })} onContentPolicyPatch={contentPolicy => setPolicy({ contentPolicy })} onToggleSenderType={(type, checked) => setPolicy({ senderPolicy: { ...listener.senderPolicy, includeSenderTypes: checked ? [...new Set([...(listener.senderPolicy?.includeSenderTypes ?? []), type])] : (listener.senderPolicy?.includeSenderTypes ?? []).filter((value: string) => value !== type) } })} onToggleMsgType={(type, checked) => setPolicy({ messagePolicy: { ...listener.messagePolicy, includeMsgTypes: checked ? [...new Set([...(listener.messagePolicy?.includeMsgTypes ?? []), type])] : (listener.messagePolicy?.includeMsgTypes ?? []).filter((value: string) => value !== type) } })} onSetTargetPolicy={(id, listening) => setTargetsForScope([id], listening)} onSetTargetsPolicy={setTargetsForScope} onSetSenderMode={mode => setPolicy({ senderPolicy: { ...listener.senderPolicy, mode } })} onPreview={() => void previewFor(scope, false, listener)} onRunPreview={() => void previewFor(scope, true, listener)} onPreviewLimitChange={limit => { invalidatePreview(scope); (isGlobal ? setGlobalPreviewLimit : setGroupPreviewLimit)(limit); }} />;
  };

  if (loading) return <LoadingState label={tr('common.loading')} />;
  return (
    <section className="page roles-page message-listener-page bot-defaults-page">
      <div className="page-heading"><div><p className="eyebrow">数字员工</p><h1>消息监听</h1></div></div>
      <div className="roles-layout">
        <aside className="bd-roster message-listener-bot-roster">
          <form id="bd-filters" onSubmit={event => event.preventDefault()}>
            <input type="search" value={botQuery} onChange={event => setBotQuery(event.currentTarget.value)} placeholder="搜索 bot 名 / app id" aria-label="搜索 Bot" />
          </form>
          <div className="bd-roster-meta"><span>{visibleBots.length} 个机器人</span></div>
          <div className="bd-roster-list">{visibleBots.map(bot => (
          <div key={bot.larkAppId} className={`bd-roster-item ${botId === bot.larkAppId ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => selectBot(bot.larkAppId)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectBot(bot.larkAppId); }
          }}>
            <Html html={botAvatarHtml({ name: bot.botName, larkAppId: bot.larkAppId, avatarUrl: bot.botAvatarUrl, size: 'sm' })} />
            <div className="bd-roster-tx"><b>{bot.botName}</b><span>{bot.larkAppId}</span></div>
          </div>
          ))}</div>
        </aside>
        <main className="roles-editor-panel message-listener-workspace">
          <section className={`message-listener-global ${globalExpanded ? 'open' : ''}`}>
            <button type="button" className="message-listener-drawer-head" aria-expanded={globalExpanded} onClick={() => setGlobalExpanded(!globalExpanded)}>
              <span className="message-listener-drawer-icon" aria-hidden="true">›</span>
              <span><strong>全局监听设置</strong><small>默认应用到该 Bot 已加入的所有群</small></span>
            </button>
            {globalExpanded ? <>
              <label className="roles-listener-field message-listener-sample"><span className="roles-field-label">预览样本群</span><select disabled={listenerGroups.length === 0} value={sampleChatId ?? ''} onChange={event => selectSampleChat(event.currentTarget.value)}><option value="" disabled>{listenerGroups.length === 0 ? '暂无已加入的群' : '选择群聊'}</option>{listenerGroups.map(group => <option key={group.chatId} value={group.chatId}>{group.name ?? group.chatId}</option>)}</select></label>
              <div className="message-listener-global-form"><button className="primary message-listener-floating-save" disabled={globalSaving} onClick={() => void saveGlobal()}>{tr('roles.save')}</button>{editor('global', global, setGlobal)}</div>
            </> : null}
          </section>
          <section className="message-listener-groups">
            <button type="button" className="message-listener-drawer-head" aria-expanded={groupsExpanded} onClick={() => setGroupsExpanded(!groupsExpanded)}>
              <span className="message-listener-drawer-icon" aria-hidden="true">›</span>
              <span><strong>群聊监听设置</strong><small>选择群聊，在右侧调整是否继承全局规则。</small></span>
            </button>
            {groupsExpanded && (listenerGroups.length === 0 ? <div className="roles-empty">该 Bot 当前没有已加入的群</div> : (
              <div className="message-listener-split">
                <nav className="message-listener-group-list" aria-label="已加入的群">
                  <div className="message-listener-list-head"><strong>群聊</strong><span>{listenerGroups.length}</span></div>
                  <input className="message-listener-group-search" type="search" value={groupQuery} onChange={event => setGroupQuery(event.currentTarget.value)} placeholder="搜索群聊" aria-label="搜索群聊" />
                  <div className="message-listener-group-scroll">
                  {visibleGroups.map(group => <button key={group.chatId} className={`message-listener-group-item ${expanded === group.chatId ? 'selected' : ''}`} aria-pressed={expanded === group.chatId} onClick={() => selectGroup(group.chatId)}>
                    <strong>{group.name ?? group.chatId}</strong><span className={`message-listener-group-status ${group.mode}`}>{group.mode === 'inherit' ? '使用全局' : group.mode === 'disabled' ? '已关闭' : '自定义'}</span>
                  </button>)}
                  {visibleGroups.length === 0 ? <div className="message-listener-no-match">未找到匹配群聊</div> : null}
                  </div>
                </nav>
                <div className="message-listener-group-detail">
                  {selected ? <>
                    <div className="message-listener-detail-head"><div><h3>{selected.name ?? selected.chatId}</h3><p>{selected.mode === 'inherit' ? '此群随全局设置自动更新。' : selected.mode === 'disabled' ? '此群不会处理任何监听消息。' : '此群使用独立规则，不受全局更新影响。'}</p></div><span className={`message-listener-mode ${selected.mode}`}>{selected.mode === 'inherit' ? '使用全局' : selected.mode === 'disabled' ? '已关闭' : '自定义'}</span></div>
                    <div className="segmented message-listener-mode-picker"><button className={selected.mode === 'inherit' ? 'active' : ''} onClick={() => void setMode(selected, 'inherit')}>使用全局设置</button><button className={selected.mode === 'disabled' ? 'active' : ''} onClick={() => void setMode(selected, 'disabled')}>关闭消息监听</button><button className={selected.mode === 'custom' ? 'active' : ''} onClick={() => void setMode(selected, 'custom')}>自定义消息设置</button></div>
                    {selected.mode === 'inherit' ? <div className="message-listener-inherit-summary">
                      <div className="message-listener-summary-icon">◎</div>
                      <div><strong>{global.enabled ? '正在使用全局监听规则' : '全局监听当前未启用'}</strong><p>{global.enabled ? `回复位置：${global.replyPolicy?.mode === 'chat' ? '直接发送到群聊' : '在原消息下新开话题'} · ${global.contentPolicy?.includeKeywords?.length ? `关键词 ${global.contentPolicy.includeKeywords.join('、')}` : '未设置关键词过滤'}` : '启用全局监听后，此群将自动按全局规则工作；也可为该群设置独立规则。'}</p></div>
                    </div> : null}
                    {selected.mode === 'disabled' ? <div className="message-listener-disabled-summary"><strong>此群已暂停自动监听</strong><p>群内消息不会触发自动回复。随时切换为“使用全局设置”或“自定义消息设置”即可恢复。</p></div> : null}
                    {selected.mode === 'custom' ? <div className="message-listener-custom-form"><button className="primary message-listener-floating-save" disabled={groupSaving} onClick={() => void saveCustom()}>{tr('roles.save')}</button>{editor('group', customDraft, setCustomDraft)}</div> : null}
                  </> : null}
                </div>
              </div>
            ))}
          </section>
        </main>
      </div>
    </section>
  );
}

export function renderMessageListenersPage(root: HTMLElement): PageDisposer { return mountReactPage(root, <MessageListenersPage />); }
