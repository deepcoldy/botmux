import { useEffect, useRef, useState } from 'react';
import type { GroupChat } from './groups-api.js';
import type { ChatReplyMode } from '../../bot-registry.js';
import { useT } from './react-hooks.js';

/** daemon `getChatReplyModeState` 的投影（GET /api/groups → memberBots[].replyMode）。 */
export interface GroupReplyModeState {
  override: ChatReplyMode | null;
  default: ChatReplyMode;
  effective: ChatReplyMode;
  inherited: boolean;
}

type Choice = 'inherit' | ChatReplyMode;
const MODES: readonly ChatReplyMode[] = ['chat-topic', 'chat', 'shared', 'new-topic'];

const MODE_LABEL_KEY: Record<ChatReplyMode, string> = {
  'chat-topic': 'groups.replyModeChatTopic',
  chat: 'groups.replyModeChat',
  shared: 'groups.replyModeShared',
  'new-topic': 'groups.replyModeNewTopic',
};

type Props = {
  chatId: string;
  appId: string;
  botName: string;
  state?: GroupReplyModeState;
  /** 话题群（含普通群切成话题布局）：只允许清除休眠覆盖，不能设置新模式。 */
  topicGroup?: boolean;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
};

export function GroupReplyModeRow(props: Props) {
  const tr = useT();
  const toChoice = (s?: GroupReplyModeState): Choice => (s?.override ?? 'inherit');
  const [choice, setChoice] = useState<Choice>(toChoice(props.state));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  // PUT 成功返回的完整策略：在下一份群矩阵快照到来前，用它渲染生效模式与来源，
  // 避免「下拉框已是新值、说明仍是旧值」（例如保存成功但刷新失败）。
  const [savedState, setSavedState] = useState<GroupReplyModeState | null>(null);
  const savingRef = useRef(false);
  // 与群管理页其它行（置顶、无交互自动关闭）一致：不在保存中时跟随群矩阵快照；保存中
  // 到达的快照不处理，保存结果以 PUT 返回值为准（失败回滚到保存前的值）。快照与写入
  // 的先后无法在前端判定，由后续统一的服务端快照版本号方案解决（#1922）。
  useEffect(() => {
    if (savingRef.current) return;
    setChoice(toChoice(props.state));
    setSavedState(null);
  }, [props.state]);

  const shown = savedState ?? props.state;
  const modeLabel = (mode: ChatReplyMode) => tr(MODE_LABEL_KEY[mode]);
  const defaultMode = shown?.default;

  async function save(next: Choice) {
    if (savingRef.current || props.disabled) return;
    const previous = choice;
    setChoice(next);
    savingRef.current = true;
    setSaving(true);
    setStatus(tr('groups.serialInputSaving'));
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/reply-mode/${encodeURIComponent(props.appId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: next }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
      const saved = replyModeStateFromPut(body, props.state?.default);
      setChoice(saved ? toChoice(saved) : isMode(body.override) ? body.override : 'inherit');
      setSavedState(saved);
      setStatus(tr('groups.replyModeSaved'));
      try { await props.onSaved(); }
      catch { setStatus(tr('groups.serialInputRefreshFailed')); }
    } catch (error) {
      setChoice(previous);
      const raw = error instanceof Error ? error.message : String(error);
      const known: Record<string, string> = {
        chat_mode_unconfirmed: tr('groups.replyModeChatModeUnconfirmed'),
        regular_group_required: tr('groups.replyModeTopicGroup'),
      };
      setStatus(tr('groups.serialInputFailed', { error: known[raw] ?? raw }));
    } finally { savingRef.current = false; setSaving(false); }
  }

  const source = !shown
    ? ''
    : shown.inherited
      ? tr('groups.replyModeSourceInherited', { mode: modeLabel(shown.effective) })
      : tr('groups.replyModeSourceOverride', { mode: modeLabel(shown.effective), default: modeLabel(shown.default) });
  const id = `reply-mode-${props.chatId}-${props.appId}`;
  // 话题群里只保留「继承」和当前（休眠）覆盖值，用来清除；不提供设置新模式。
  const options: Choice[] = props.topicGroup
    ? ['inherit', ...(shown?.override ? [shown.override] : [])]
    : ['inherit', ...MODES];
  return <div className="group-reply-mode-row" data-group-reply-mode-row={props.appId}>
    <label htmlFor={id}><strong>{props.botName}</strong></label>
    <select id={id} value={choice} disabled={props.disabled || saving || (props.topicGroup && !shown?.override)}
      onChange={event => { void save(event.currentTarget.value as Choice); }}>
      {options.map(option => <option key={option} value={option}>
        {option === 'inherit'
          ? tr('groups.replyModeInherit', { mode: defaultMode ? modeLabel(defaultMode) : '-' })
          : modeLabel(option)}
      </option>)}
    </select>
    <small className="group-reply-mode-source">{source}</small>
    <small role="status" aria-live="polite">{status}</small>
  </div>;
}

const isMode = (v: unknown): v is ChatReplyMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

/**
 * 从 PUT 成功回包（daemon `getChatReplyModeState` 展开）取出完整策略。字段齐全时原样
 * 采用；缺 default/effective 等字段时用已知的 Bot 默认推导；连 Bot 默认也不知道则返回
 * null（交回快照渲染）。
 */
export function replyModeStateFromPut(body: any, fallbackDefault?: ChatReplyMode): GroupReplyModeState | null {
  const override = isMode(body?.override) ? body.override : null;
  const def = isMode(body?.default) ? body.default : fallbackDefault;
  if (!def) return null;
  const effective = isMode(body?.effective) ? body.effective : (override ?? def);
  return { override, default: def, effective, inherited: override === null };
}

/** 单群拓扑：'topic' 含「普通群切成话题布局」；'unknown' = 查询失败/未确认（保守处理）。 */
export type GroupTopology = 'loading' | 'group' | 'topic' | 'unknown';

/**
 * 对话框打开时对当前群查一次单群拓扑。列表接口不返回 group_message_type，
 * 普通群切成话题布局只能经单群详情（daemon getChatModeStrict，自带缓存）识别。
 * 建群即话题群（列表 chat_mode=topic）无需再查。每个对话框（chatId）只请求一次。
 */
export function useGroupTopology(chat: GroupChat, probeAppId: string | undefined): GroupTopology {
  const knownTopic = chat.chatMode === 'topic';
  const [topology, setTopology] = useState<GroupTopology>(knownTopic ? 'topic' : probeAppId ? 'loading' : 'unknown');
  const appIdRef = useRef(probeAppId);
  appIdRef.current = probeAppId;
  useEffect(() => {
    if (knownTopic) { setTopology('topic'); return; }
    const appId = appIdRef.current;
    if (!appId) { setTopology('unknown'); return; }
    let alive = true;
    setTopology('loading');
    void (async () => {
      try {
        const response = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/chat-mode/${encodeURIComponent(appId)}`);
        const body = await response.json();
        const mode = response.ok && body?.ok === true ? body.chatMode : undefined;
        if (alive) setTopology(mode === 'topic' ? 'topic' : mode === 'group' ? 'group' : 'unknown');
      } catch {
        if (alive) setTopology('unknown');
      }
    })();
    return () => { alive = false; };
  }, [chat.chatId, knownTopic]);
  return topology;
}

/** 「群组 → 管理」里的「普通群回复模式」区块。 */
export function GroupReplyModeSection(props: {
  chat: GroupChat;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
}) {
  const tr = useT();
  const inChat = (props.chat.memberBots ?? []).filter(member => member.inChat);
  const topology = useGroupTopology(props.chat, inChat[0]?.larkAppId);
  const topicGroup = topology === 'topic';
  // 查询中/失败：不预判拓扑、文案中性，保存仍由 daemon strict 闸兜底（话题群 409）。
  const help = topicGroup ? 'groups.replyModeTopicGroupHelp'
    : topology === 'group' ? 'groups.replyModeHelp'
    : 'groups.replyModeNeutralHelp';
  return <fieldset data-group-reply-mode data-topology={topology}>
    <legend>{tr('groups.replyMode')}</legend>
    <p><small>{tr(help)}</small></p>
    {inChat.length === 0 ? <p className="empty">{tr('groups.replyModeNoBots')}</p> : inChat.map(member => <GroupReplyModeRow
      key={`${props.chat.chatId}-${member.larkAppId}`}
      chatId={props.chat.chatId} appId={member.larkAppId}
      botName={member.botName ?? member.larkAppId}
      state={member.replyMode} topicGroup={topicGroup} disabled={props.disabled}
      onSaved={props.onSaved}
    />)}
  </fieldset>;
}
