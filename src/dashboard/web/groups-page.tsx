import { GroupIdleCloseRow } from './group-idle-close.js';
import { GroupCardModeRow } from './group-card-mode.js';
import { GroupReplyModeRow, useGroupTopology } from './group-reply-mode.js';
import { GroupSerialInputRow } from './group-serial-input.js';
import { GroupDefaultModelsRow } from './group-default-models.js';
import { describeCloseResidual } from '../../core/close-residual.js';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import {
  defaultProjectProgressCardConfig,
  saveGroupCollaborationMode,
  setGroupPinStreamingCard,
  type ProjectGroupRuntimeSummary,
  type ProjectProgressCardConfig,
  type ProjectProgressCardSectionId,
  type ProjectProgressCardTemplateId,
} from './groups-api.js';
import { StreamingCardPinToggle } from './streaming-card-pin-toggle.js';
import { MemberAccessSection } from './member-access-section.js';
import { botAvatarHtml, botOrbStyle, chatAvatarUrlFor } from './ui.js';
import { copyText } from './clipboard.js';
import { toast } from './toast.js';
import { confirm } from './confirm-modal.js';
import { FeedGroupPicker } from './feed-group-picker.js';
import { FeedGroupAuthOverlay, FeedGroupAuthPrompt, useFeedGroups } from './feed-groups.js';
import { BotMultiSelect } from './bot-multi-select.js';
import {
  CreateActionButton,
  DropdownMenu,
  Html,
  LoadingState,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverviewListTail,
  RefreshIconButton,
} from './dashboard-components.js';
import { BOT_SETTING_COLUMNS, summarizeBotSettings } from './group-settings-summary.js';
import {
  allExpectedInChat,
  availableBotsForPicker,
  botNameById,
  chatHasAddableBots,
  copyChatRoles,
  createAddBotsReconciler,
  createReconciledChatCommitter,
  emptyGroupsSnapshot,
  fetchGroupsSnapshot,
  filterGroupChats,
  formatSessionGroupTime,
  groupCloneTemplate,
  inChatMembers,
  injectOptimisticChat,
  markBotsInChat,
  paginateGroupRows,
  planAddBotsFollowup,
  isGroupView,
  sortSessionGroups,
  stewardJoinNotes,
  summarizeAddBotsResult,
  type AddBotsSummary,
  type CopyChatRolesResult,
  type GroupBot,
  type GroupChat,
  type GroupCloneTemplate,
  type GroupFilters,
  type GroupView,
  type GroupsSnapshot,
  type SessionGroupSort,
} from './groups.js';
import { hashQueryParam, setHashQueryParam } from './dashboard-routes.js';

type Translator = ReturnType<typeof useT>;

type ManageTab = 'overview' | 'bots' | 'collab' | 'access' | 'danger';

type DialogState =
  | { type: 'create'; template?: GroupCloneTemplate }
  | { type: 'add-bots'; chat: GroupChat }
  | { type: 'manage'; chat: GroupChat; botId?: string };

type DialogErrorState = { title: string; reason: unknown };

/** 列表行里最多直接列出的在群 bot 数，其余折成「+N」。 */
const ROW_BOT_CHIP_LIMIT = 8;

function orbVars(name: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const part of botOrbStyle(name).split(';')) {
    if (!part) continue;
    const i = part.indexOf(':');
    if (i <= 0) continue;
    style[part.slice(0, i)] = part.slice(i + 1);
  }
  return style as CSSProperties;
}

/** 会话页详情抽屉的深链（会话页读 `?session=`）。 */
function sessionDetailHref(sessionId: string): string {
  return `#/sessions?session=${encodeURIComponent(sessionId)}`;
}

function chatOpenLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

function ChatAvatar(props: { chat: GroupChat }) {
  const chat = props.chat;
  const url = chat.avatar ?? chatAvatarUrlFor(chat.chatId);
  const [broken, setBroken] = useState(false);

  useEffect(() => { setBroken(false); }, [url]);

  const name = chat.name ?? chat.chatId;
  const hasImage = !!url && !broken;
  return (
    <span
      className={`orb-avatar orb-square orb-avatar-sm${hasImage ? ' orb-has-img' : ''}`}
      style={orbVars(name)}
      aria-hidden="true"
    >
      {hasImage ? (
        <img
          className="orb-img"
          src={url}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : null}
    </span>
  );
}

/**
 * 群矩阵里每个群的 memberBots 只带名字和设置，头像 URL 只在顶层 roster（snapshot.bots）上。
 * 页面把 roster 的头像按 appId 放进 context，群行 / 管理抽屉里的 bot 头像都从这里取。
 */
const BotAvatarUrlContext = createContext<ReadonlyMap<string, string>>(new Map());

function botAvatarUrlMap(bots: GroupBot[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const bot of bots) if (bot.botAvatarUrl) map.set(bot.larkAppId, bot.botAvatarUrl);
  return map;
}

function BotAvatar(props: { bot: GroupBot }) {
  const rosterAvatars = useContext(BotAvatarUrlContext);
  return (
    <Html html={botAvatarHtml({
      name: props.bot.botName,
      larkAppId: props.bot.larkAppId,
      avatarUrl: props.bot.botAvatarUrl ?? rosterAvatars.get(props.bot.larkAppId),
      size: 'sm',
    })} />
  );
}

function DialogError(props: DialogErrorState) {
  return (
    <p className="hint-warn">
      <strong>{props.title}</strong>
      <br />
      <small>{String(props.reason ?? 'unknown')}</small>
    </p>
  );
}

function BotCheckboxes(props: {
  bots: GroupBot[];
  excludeIds?: Set<string>;
  tr: Translator;
  selected: Set<string>;
  onToggle(larkAppId: string, checked: boolean): void;
}) {
  const options = availableBotsForPicker(props.bots, props.excludeIds);
  const tr = props.tr;
  return (
    <BotMultiSelect
      bots={options}
      selected={props.selected}
      onToggle={props.onToggle}
      searchPlaceholder={tr('botPicker.searchPlaceholder')}
      noMatchLabel={tr('botPicker.noMatch')}
      emptyLabel={tr('botPicker.empty')}
      selectedCountLabel={n => tr('botPicker.selectedCount', { n: String(n) })}
    />
  );
}

function AddBotsResult(props: { summary: AddBotsSummary; bots: GroupBot[] }) {
  const summary = props.summary;
  if (!summary.rows.length) {
    return <p className="hint-warn">没有返回添加结果。</p>;
  }
  return (
    <div className={summary.failed ? 'hint-warn' : 'hint-ok'}>
      <strong>添加结果：成功 {summary.okCount}/{summary.rows.length}{summary.failed ? `，失败 ${summary.failed}` : ''}</strong>
      <ul>
        {summary.rows.map((row, index) => {
          const id = String(row?.id ?? '?');
          const name = botNameById(id, props.bots);
          return (
            <li key={`${id}-${index}`}>
              <span className="g-add-bots-result-main">
                <strong>{name}</strong>
                <small>({id})</small>
              </span>
              {row?.ok ? ' : OK' : ` : failed (${String(row?.error ?? 'unknown')})`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 列表行只列「在群」的 bot：几十个 roster bot 逐个标「缺失」信息量为零，
 * 真正要回答的是「这个群里有谁」。点某个 bot 直接打开它在本群的设置。
 */
function GroupMemberChips(props: {
  chat: GroupChat;
  tr: Translator;
  onOpenBot(botId: string): void;
}) {
  const { chat, tr } = props;
  const members = inChatMembers(chat);
  const errors = (chat.memberBots ?? []).filter(member => member.error);
  if (members.length === 0 && errors.length === 0) {
    return <span className="groups-row-empty-bots">{tr('groups.noBotsInChat')}</span>;
  }
  const shown = members.slice(0, ROW_BOT_CHIP_LIMIT);
  const hidden = members.slice(ROW_BOT_CHIP_LIMIT);
  return (
    <div className="groups-row-bots" aria-label={tr('groups.botCount', { n: members.length })}>
      {shown.map(member => {
        const name = member.botName ?? member.larkAppId;
        return (
          <button
            type="button"
            className="groups-bot-chip"
            key={member.larkAppId}
            title={tr('groups.openBotSettings', { bot: name })}
            data-bot={member.larkAppId}
            onClick={() => props.onOpenBot(member.larkAppId)}
          >
            <BotAvatar bot={member} />
            <span>{name}</span>
          </button>
        );
      })}
      {hidden.length ? (
        <span
          className="groups-bot-chip groups-bot-chip-more"
          title={hidden.map(member => member.botName ?? member.larkAppId).join('\n')}
        >
          {tr('groups.moreBots', { n: hidden.length })}
        </span>
      ) : null}
      {errors.length ? (
        <span
          className="groups-bot-chip groups-bot-chip-error"
          title={errors.map(member => `${member.botName ?? member.larkAppId}: ${String(member.error)}`).join('\n')}
        >
          {tr('groups.memberErrors', { n: errors.length })}
        </span>
      ) : null}
    </div>
  );
}

export const GroupListRow = memo(function GroupListRow(props: {
  chat: GroupChat;
  bots: GroupBot[];
  tr: Translator;
  onAddBots(chat: GroupChat): void;
  onClone(chat: GroupChat): void;
  onManage(chat: GroupChat, botId?: string): void;
}) {
  const { chat, tr } = props;
  const inCount = inChatMembers(chat).length;
  // Grey out "添加 bot" when every roster bot is already in this chat — there is
  // nothing to add, so opening the dialog would only show an empty picker. Derived
  // from the snapshot, so it re-enables automatically once membership/roster shifts.
  const hasAddableBots = chatHasAddableBots(chat, props.bots);
  // An empty roster is NOT "every bot is already in this chat" — it means no bot is
  // configured/online right now (the opposite of full coverage), so the disabled
  // tooltip must distinguish the two instead of claiming every bot is already present.
  const disabledTitle = props.bots.length === 0
    ? tr('groups.noBotsOnline')
    : tr('groups.addBotsAllInChat');
  // 整行可点进管理；行内按钮/链接各有自己的动作，不冒泡成「打开管理」。
  const onRowClick = (event: MouseEvent<HTMLLIElement>) => {
    const target = event.target as Element | null;
    if (target?.closest?.('button, a, input, label')) return;
    props.onManage(chat);
  };
  return (
    <OverviewListItem kind="group" className="groups-list-row" data-chat={chat.chatId} onClick={onRowClick}>
      <ChatAvatar chat={chat} />
      <OverviewListMain>
        <div className="groups-row-head">
          <button type="button" className="groups-row-title" onClick={() => props.onManage(chat)}>
            {chat.name ?? chat.chatId}
          </button>
          {chat.collaborationMode === 'project' ? (
            <span className="groups-row-tag groups-row-project-tag">{tr('groups.projectModeBadge')}</span>
          ) : null}
          <span className="groups-row-count">{tr('groups.botCount', { n: inCount })}</span>
        </div>
        <GroupMemberChips chat={chat} tr={tr} onOpenBot={botId => props.onManage(chat, botId)} />
      </OverviewListMain>
      <OverviewListTail>
        <CreateActionButton
          className="add-bots"
          onClick={() => props.onAddBots(chat)}
          disabled={!hasAddableBots}
          title={hasAddableBots ? undefined : disabledTitle}
        >{tr('groups.addBots')}</CreateActionButton>
        <button
          className="clone-chat"
          type="button"
          title={tr('groups.cloneHint')}
          onClick={() => props.onClone(chat)}
        >
          {tr('groups.clone')}
        </button>
        <button className="manage-chat" type="button" onClick={() => props.onManage(chat)}>{tr('groups.manage')}</button>
      </OverviewListTail>
    </OverviewListItem>
  );
});

/**
 * 会话群一行：私聊里自动创建的一人一 bot 群，要回答的是「哪个会话、在不在进行、
 * 多久没动」。没有「添加 bot」「复制为新群」——一次性的会话群用不上。
 */
export const SessionGroupRow = memo(function SessionGroupRow(props: {
  chat: GroupChat;
  now: number;
  tr: Translator;
  onManage(chat: GroupChat, botId?: string): void;
}) {
  const { chat, tr } = props;
  const meta = chat.sessionGroupMeta;
  const members = inChatMembers(chat);
  const onRowClick = (event: MouseEvent<HTMLLIElement>) => {
    const target = event.target as Element | null;
    if (target?.closest?.('button, a, input, label')) return;
    props.onManage(chat);
  };
  return (
    <OverviewListItem kind="group" className="groups-list-row groups-session-row" data-chat={chat.chatId} onClick={onRowClick}>
      <ChatAvatar chat={chat} />
      <OverviewListMain>
        <div className="groups-row-head">
          <button type="button" className="groups-row-title" onClick={() => props.onManage(chat)}>
            {chat.name ?? chat.chatId}
          </button>
          {meta?.sessionStatus ? (
            <span className={`groups-session-state groups-session-state-${meta.sessionStatus}`} data-session-state={meta.sessionStatus}>
              {tr(meta.sessionStatus === 'active' ? 'groups.sessionStatusActive' : 'groups.sessionStatusClosed')}
            </span>
          ) : null}
        </div>
        <div className="groups-session-meta">
          {members.length ? members.map(member => (
            <button
              type="button"
              className="groups-session-bot"
              key={member.larkAppId}
              data-bot={member.larkAppId}
              title={tr('groups.openBotSettings', { bot: member.botName ?? member.larkAppId })}
              onClick={() => props.onManage(chat, member.larkAppId)}
            >
              <BotAvatar bot={member} />
              <span>{member.botName ?? member.larkAppId}</span>
            </button>
          )) : <span className="groups-row-empty-bots">{tr('groups.noBotsInChat')}</span>}
          {meta ? (
            <>
              <span data-session-active-at>{tr('groups.sessionLastActive', { time: formatSessionGroupTime(meta.lastActiveAt, props.now, tr) })}</span>
              <span>{tr('groups.sessionCreated', { time: formatSessionGroupTime(meta.createdAt, props.now, tr) })}</span>
            </>
          ) : null}
        </div>
      </OverviewListMain>
      <OverviewListTail>
        <a className="btn-link open-chat" href={chatOpenLink(chat.chatId)} target="_blank" rel="noopener">{tr('groups.openInLark')}</a>
        {meta?.sessionId ? (
          <a className="btn-link open-session" href={sessionDetailHref(meta.sessionId)}>{tr('groups.openSession')}</a>
        ) : null}
        <button className="manage-chat" type="button" onClick={() => props.onManage(chat)}>{tr('groups.manage')}</button>
      </OverviewListTail>
    </OverviewListItem>
  );
});

function RoleCopyNote(props: { result: CopyChatRolesResult; bots: GroupBot[]; tr: Translator }) {
  const { result, tr } = props;
  if (result.failed.length === 0) {
    return result.copied.length
      ? <p className="hint-ok">{tr('groups.cloneRolesDone', { n: result.copied.length })}</p>
      : null;
  }
  return (
    <p className="hint-warn">
      {tr('groups.cloneRolesFailed', { n: result.failed.length, ok: result.copied.length })}
      {result.failed.map(item => (
        <span key={item.larkAppId}>
          <br /><code>{botNameById(item.larkAppId, props.bots)}</code>: {item.error}
        </span>
      ))}
    </p>
  );
}

export function CreateDialog(props: {
  bots: GroupBot[];
  template?: GroupCloneTemplate;
  tr: Translator;
  onClose(): void;
  onCreated(resp: any, selectedIds: string[], name: string): void;
  setTimer(fn: () => void, ms: number): number;
}) {
  const { tr, template } = props;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DialogErrorState | null>(null);
  const [success, setSuccess] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedBots, setSelectedBots] = useState<Set<string>>(() => new Set(template?.botIds ?? []));
  const [copyRoles, setCopyRoles] = useState(true);
  const feed = useFeedGroups({
    onAuthError: (kind, reason) => setError({
      title: kind === 'open' ? '无法发起标签授权' : '标签授权失败',
      reason,
    }),
  });
  // 只复制仍被选中的 bot 的群角色；用户在弹窗里取消勾选的 bot 不再写角色。
  const roleBotIds = (template?.roleBotIds ?? []).filter(id => selectedBots.has(id));

  async function submit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const name = String(fd.get('name') ?? '').trim();
    const bindWorkingDir = String(fd.get('bindWorkingDir') ?? '').trim();
    const ids = [...selectedBots];
    if (ids.length === 0) {
      setError({ title: '请选择 bot', reason: '至少选择一个 bot 后再创建群聊。' });
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/groups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name || undefined,
          larkAppIds: ids,
          bindWorkingDir: bindWorkingDir || undefined,
          feedGroupId: feed.selectedId || undefined,
          newFeedGroupName: feed.newName || undefined,
          feedGroupAppId: (feed.selectedId || feed.newName) ? feed.appId : undefined,
        }),
      });
      const respBody = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (respBody.ok && respBody.chatId) {
        props.onCreated(respBody, ids, name);
        let roleCopy: CopyChatRolesResult | null = null;
        if (template && copyRoles && roleBotIds.length > 0) {
          const invalid = new Set<string>(Array.isArray(respBody.invalidBotIds) ? respBody.invalidBotIds : []);
          roleCopy = await copyChatRoles(
            template.sourceChatId,
            String(respBody.chatId),
            roleBotIds.filter(id => !invalid.has(id)),
          );
        }
        setSuccess({ ...respBody, roleCopy });
      } else {
        setError({ title: '创建失败', reason: respBody.error ?? `HTTP ${r.status}` });
        setSubmitting(false);
      }
    } catch (err) {
      setError({ title: '网络错误', reason: err });
      setSubmitting(false);
    }
  }

  if (success) {
    const chatId = String(success.chatId);
    const appLink = typeof success.shareLink === 'string' && success.shareLink
      ? success.shareLink
      : chatOpenLink(chatId);
    const invalidBots = (success.invalidBotIds ?? []) as string[];
    const invalidUsers = (success.invalidUserIds ?? []) as string[];
    const binds = Array.isArray(success.oncallBindings) ? success.oncallBindings as any[] : [];
    const stewardNotes = stewardJoinNotes(success.stewardJoins, props.bots);
    const bindOk = binds.filter(b => b?.ok).length;
    const bindFailed = binds.filter(b => !b?.ok);

    return (
      <article className="g-create-dialog g-create-success">
        <header><h3>{tr('groups.successTitle')}</h3></header>
        <p>
          <b>chatId:</b> <code>{chatId}</code>{' '}
          <button
            type="button"
            data-copy={chatId}
            onClick={() => {
              void copyText(chatId, tr('sessions.copy')).then(didCopy => {
                if (!didCopy) return;
                setCopied(true);
                props.setTimer(() => setCopied(false), 800);
              });
            }}
          >
            {copied ? tr('sessions.copied') : tr('sessions.copy')}
          </button>
        </p>
        <p><b>创建者:</b> <code>{String(success.creator ?? '?')}</code></p>
        {success.feedGroupId ? <p className="hint-ok">已加入飞书标签{success.feedGroupName ? `「${String(success.feedGroupName)}」` : ''}。</p> : null}
        {success.feedGroupError ? <p className="hint-warn">群聊已创建，但标签设置失败：{String(success.feedGroupError)}</p> : null}
        <CreateInviteNote resp={success} />
        {binds.length > 0 ? (
          bindFailed.length === 0 ? (
            <p className="hint-ok">已绑定目录：<code>{String(success.bindResolvedPath ?? '')}</code>（{bindOk}/{binds.length} bots）</p>
          ) : (
            <p className="hint-warn">
              目录绑定部分失败：成功 {bindOk}/{binds.length}。
              {bindFailed.map((b, index) => (
                <span key={`${b?.larkAppId ?? '?'}-${index}`}>
                  <br /><code>{String(b?.larkAppId ?? '?')}</code>: {String(b?.error ?? 'unknown')}
                </span>
              ))}
            </p>
          )
        ) : null}
        {success.roleCopy ? <RoleCopyNote result={success.roleCopy} bots={props.bots} tr={tr} /> : null}
        {stewardNotes.map(note => <p key={note.larkAppId} className={note.kind === 'ok' ? 'hint-ok' : 'hint-warn'}>{note.text}</p>)}
        {invalidBots.length || invalidUsers.length ? (
          <ul>
            {invalidBots.length ? <li>无效 bot id: <code>{invalidBots.join(', ')}</code></li> : null}
            {invalidUsers.length ? <li>无效用户 open_id: <code>{invalidUsers.join(', ')}</code></li> : null}
          </ul>
        ) : null}
        <div className="actions">
          <button type="button" id="g-create-close" onClick={props.onClose}>{tr('sessions.dismiss')}</button>
          <a className="btn-link primary" href={appLink} target="_blank" rel="noopener">{tr('groups.openGroup')}</a>
        </div>
      </article>
    );
  }

  return (
    <article className="g-create-dialog">
      <header className="g-create-head">
        <h3>{template ? tr('groups.cloneTitle', { name: template.sourceName }) : tr('groups.createTitle')}</h3>
        <p>{template ? tr('groups.cloneHelp') : tr('groups.createHelp')}</p>
      </header>
      <form id="g-createform" className="g-create-form" onSubmit={ev => void submit(ev)}>
        <fieldset className="g-modal-field g-create-bots">
          <legend>{tr('groups.botPicker')}</legend>
          <div className="g-bot-picker">
            <BotCheckboxes
              bots={props.bots}
              tr={tr}
              selected={selectedBots}
              onToggle={(id, checked) => setSelectedBots(prev => {
                const next = new Set(prev);
                if (checked) next.add(id); else next.delete(id);
                return next;
              })}
            />
          </div>
        </fieldset>

        <div className="g-create-fields">
          <fieldset className="g-modal-field">
            <legend>{tr('groups.name')}</legend>
            <input
              type="text"
              name="name"
              placeholder={tr('groups.namePlaceholder')}
              defaultValue={template ? tr('groups.cloneName', { name: template.sourceName }).slice(0, 60) : undefined}
              maxLength={60}
            />
          </fieldset>
          <fieldset className="g-modal-field">
            <legend>{tr('groups.bindDir')}</legend>
            <input
              type="text"
              name="bindWorkingDir"
              placeholder="e.g. ~/projects/botmux"
              defaultValue={template?.workingDir || undefined}
            />
            <small>{tr('groups.bindDirHelp')}</small>
          </fieldset>
          {template && template.roleBotIds.length > 0 ? (
            <fieldset className="g-modal-field g-clone-roles-field">
              <legend>{tr('groups.cloneRolesLegend')}</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="copyRoles"
                  checked={copyRoles && roleBotIds.length > 0}
                  disabled={roleBotIds.length === 0}
                  onChange={ev => setCopyRoles(ev.currentTarget.checked)}
                />
                <span className="checkbox-row-main">
                  <strong>{tr('groups.cloneRoles', { n: roleBotIds.length })}</strong>
                  <small>{tr('groups.cloneRolesHelp')}</small>
                </span>
              </label>
            </fieldset>
          ) : null}
          <fieldset className="g-modal-field g-feed-group-field">
            <legend>飞书标签（可选）</legend>
            <input type="hidden" name="feedGroupId" value={feed.selectedId} />
            <FeedGroupPicker
              groups={feed.groups}
              selectedId={feed.selectedId}
              newName={feed.newName}
              disabled={feed.loading || !!feed.error}
              onChange={feed.select}
            />
            <small>展开后可在第一行输入新标签名称，或选择下方已有标签。</small>
            {feed.loading ? <small>正在读取飞书标签…</small> : null}
            <FeedGroupAuthPrompt feed={feed} className="hint-warn-inline" />
            {!feed.loading && !feed.error && feed.groups.length === 0 ? <small>当前没有标签，可直接创建一个。</small> : null}
          </fieldset>
        </div>

        <FeedGroupAuthOverlay feed={feed} titleId="feed-group-auth-title" />

        <div className="g-create-status" data-create-status aria-live="polite">{error ? <DialogError {...error} /> : null}</div>
        <div className="actions g-create-actions">
          <button type="button" id="g-create-cancel" onClick={props.onClose}>{tr('groups.cancel')}</button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? <><i className="button-spinner" aria-hidden="true" />{tr('groups.createSubmitting')}</> : tr('groups.createSubmit')}
          </button>
        </div>
      </form>
    </article>
  );
}

function CreateInviteNote(props: { resp: any }) {
  const resp = props.resp;
  const auto = resp.autoInvitedOpenId as string | null | undefined;
  const rejected = !!resp.autoInviteRejected;
  const ownerTo = resp.ownerTransferredTo as string | null | undefined;
  const transferErr = resp.transferError as string | null | undefined;
  const notifyMsgId = resp.notifyMessageId as string | null | undefined;
  const notifyErr = resp.notifyError as string | null | undefined;

  if (auto) {
    return (
      <p className="hint-ok">
        已自动邀请你（<code>{auto}</code>）作为成员。
        {ownerTo ? <><br /><small>群主已从机器人转让给你。</small></> : null}
        {transferErr ? <><br /><small className="hint-warn-inline">⚠ 自动转让群主失败（{transferErr}），你现在是成员但群主仍是机器人。</small></> : null}
        {notifyMsgId ? <><br /><small>机器人已在群里 @ 了你（消息 id <code>{notifyMsgId}</code>），看飞书通知就能进群。</small></> : null}
        {notifyErr ? <><br /><small className="hint-warn-inline">⚠ 自动 @ 通知失败（{notifyErr}），新群可能不会主动出现在你侧边栏，建议从下面按钮跳进去。</small></> : null}
      </p>
    );
  }
  if (rejected) {
    return (
      <p className="hint-warn">
        飞书拒绝了自动邀请（你的 open_id 在创建者 bot 的 scope 下不可用）。<strong>你目前不是新群成员</strong>，需要让群里的某个机器人手动把你加进来。
      </p>
    );
  }
  return (
    <p className="hint-warn">
      没在 dashboard 缓存里找到 ownerOpenId，<strong>没有自动邀请你</strong>。点开下面链接前，先让群里任一机器人手动把你加进去。
    </p>
  );
}

export function AddBotsDialog(props: {
  chat: GroupChat;
  bots: GroupBot[];
  tr: Translator;
  onClose(): void;
  onBotsAdded(chatId: string, okIds: string[]): void;
}) {
  const { chat, tr } = props;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DialogErrorState | null>(null);
  const [summary, setSummary] = useState<{ result: AddBotsSummary } | null>(null);
  const [selectedBots, setSelectedBots] = useState<Set<string>>(new Set());
  // Bots added optimistically in this dialog session. Kept locally because the
  // parent's snapshot converges via a Lark-side-delayed reconciliation poll — the
  // picker must drop them immediately, not wait for that round-trip.
  const [locallyAdded, setLocallyAdded] = useState<Set<string>>(new Set());
  const inChatSet = useMemo(
    () => new Set((chat.memberBots ?? []).filter(member => member.inChat).map(member => member.larkAppId)),
    [chat],
  );
  const effectiveExclude = useMemo(
    () => new Set([...inChatSet, ...locallyAdded]),
    [inChatSet, locallyAdded],
  );

  async function submit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    const ids = [...selectedBots];
    if (ids.length === 0) {
      setError({ title: '请选择 bot', reason: '至少选择一个 bot 后再添加。' });
      setSummary(null);
      return;
    }

    setSubmitting(true);
    setError(null);
    setSummary(null);
    try {
      const r = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/add-bots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppIds: ids }),
      });
      const respBody = await r.json();
      if (respBody.error === 'no_proxy_bot') {
        setError({
          title: '无法添加 bot',
          reason: '当前群里没有可代理操作的 bot。请先在飞书里手动拉入一个 bot，然后重试。',
        });
      } else if (respBody.result) {
        const result = summarizeAddBotsResult(respBody.result);
        const followup = planAddBotsFollowup(result, props.bots, effectiveExclude);
        if (followup.okIds.length > 0) {
          setSelectedBots(prev => {
            const next = new Set(prev);
            for (const id of followup.okIds) next.delete(id);
            return next;
          });
          setLocallyAdded(prev => new Set([...prev, ...followup.okIds]));
          // Parent optimistically flips inChat + reconciles server-side.
          props.onBotsAdded(chat.chatId, followup.okIds);
        }
        if (followup.shouldClose) {
          toast(tr('groups.addBotsDone', { n: String(followup.okIds.length) }), { kind: 'success' });
          props.onClose();
          return;
        }
        setSummary({ result });
      } else {
        setError({ title: '响应异常', reason: JSON.stringify(respBody) });
      }
    } catch (err) {
      setError({ title: '网络错误', reason: err });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="g-add-bots-dialog">
      <header><h3>{tr('groups.addBots')} · {chat.name ?? chat.chatId}</h3></header>
      <p>{tr('groups.createHelp')}</p>
      <form id="g-addform" onSubmit={ev => void submit(ev)}>
        <BotCheckboxes
          bots={props.bots}
          excludeIds={effectiveExclude}
          tr={tr}
          selected={selectedBots}
          onToggle={(id, checked) => setSelectedBots(prev => {
            const next = new Set(prev);
            if (checked) next.add(id); else next.delete(id);
            return next;
          })}
        />
        <div data-add-status aria-live="polite">
          {error ? <DialogError {...error} /> : null}
          {summary ? <AddBotsResult summary={summary.result} bots={props.bots} /> : null}
        </div>
        <div className="actions">
          <button type="button" id="g-cancel" onClick={props.onClose}>{tr('groups.cancel')}</button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? 'Adding...' : tr('groups.addBots')}
          </button>
        </div>
      </form>
    </article>
  );
}

function OncallRow(props: {
  chat: GroupChat;
  member: GroupBot & { oncallChat?: { workingDir?: string } | null };
  /** 可见标题；缺省显示 bot 名 + appId。 */
  label?: string;
  disabled?: boolean;
  tr: Translator;
  onSaved(): Promise<GroupsSnapshot>;
}) {
  const { member, tr } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [enabled, setEnabled] = useState(!!member.oncallChat);
  const [workingDir, setWorkingDir] = useState(member.oncallChat?.workingDir ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; className?: string } | null>(null);
  const dirtyRef = useRef(false);
  const disabledRef = useRef(!!props.disabled);
  const savingRef = useRef(false);
  disabledRef.current = !!props.disabled;

  useEffect(() => {
    if (dirtyRef.current) return;
    setEnabled(!!member.oncallChat);
    setWorkingDir(member.oncallChat?.workingDir ?? '');
  }, [member]);

  async function save(): Promise<void> {
    if (disabledRef.current || savingRef.current) return;
    setStatus(null);
    const wd = workingDir.trim();
    if (enabled && !wd) {
      setStatus({ text: tr('groups.needWorkingDir'), className: 'hint-warn-inline' });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const url = `/api/groups/${encodeURIComponent(props.chat.chatId)}/oncall/${encodeURIComponent(member.larkAppId)}`;
      const r = enabled
        ? await fetch(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workingDir: wd }),
          })
        : await fetch(url, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.ok) {
        setStatus({
          text: enabled ? `✓ 已绑定 → ${body.resolvedPath ?? wd}` : '✓ 已解绑',
          className: 'hint-ok',
        });
        try {
          const snapshot = await props.onSaved();
          const refreshedMember = snapshot.chats
            .find(chat => chat.chatId === props.chat.chatId)
            ?.memberBots
            .find(member => member.larkAppId === props.member.larkAppId);
          if (refreshedMember) {
            dirtyRef.current = false;
            setEnabled(!!refreshedMember.oncallChat);
            setWorkingDir(refreshedMember.oncallChat?.workingDir ?? '');
          }
        } catch (error) {
          dirtyRef.current = true;
          const message = error instanceof Error ? error.message : String(error);
          setStatus({
            text: `${enabled ? `✓ 已绑定 → ${body.resolvedPath ?? wd}` : '✓ 已解绑'}；刷新失败：${message}`,
            className: 'hint-warn-inline',
          });
        }
      } else {
        setStatus({ text: `✗ ${body.error ?? r.status}`, className: 'hint-warn-inline' });
      }
    } catch (err: any) {
      setStatus({ text: `✗ ${err?.message ?? err}`, className: 'hint-warn-inline' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="oncall-row" data-bot={member.larkAppId}>
      <label className="checkbox-row">
        <input
          type="checkbox"
          data-action="toggle"
          checked={enabled}
          disabled={props.disabled || saving}
          onChange={ev => {
            if (disabledRef.current || savingRef.current) return;
            dirtyRef.current = true;
            setEnabled(ev.currentTarget.checked);
            if (ev.currentTarget.checked) window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
        {props.label ? <strong>{props.label}</strong> : <>
          <strong>{member.botName ?? member.larkAppId}</strong>
          <small>({member.larkAppId})</small>
        </>}
      </label>
      <div className="oncall-row-body">
        <input
          ref={inputRef}
          type="text"
          data-input="workingDir"
          placeholder="e.g. /root/iserver/botmux"
          value={workingDir}
          disabled={props.disabled || saving || !enabled}
          onChange={ev => {
            if (disabledRef.current || savingRef.current) return;
            dirtyRef.current = true;
            setWorkingDir(ev.currentTarget.value);
          }}
        />
        <button type="button" data-action="save" disabled={props.disabled || saving} onClick={() => void save()}>{tr('groups.save')}</button>
        <span className={`oncall-status ${status?.className ?? ''}`} data-status>{status?.text ?? ''}</span>
      </div>
    </div>
  );
}

function responseErrorText(res: { status: number; body: any }): string {
  const reason = typeof res.body?.reason === 'string' ? res.body.reason : '';
  return String(reason || res.body?.error || res.status);
}

function GroupPinStreamingCardRow(props: {
  chat: GroupChat;
  member: GroupChat['memberBots'][number];
  /** 按 bot 分栏展示时不再重复 bot 名头部。 */
  hideHead?: boolean;
  disabled?: boolean;
  tr: Translator;
  onSaved(): Promise<GroupsSnapshot>;
}) {
  const { chat, member, tr } = props;
  const initialChecked = member.pinStreamingCardChatEnabled === true;
  const [checked, setChecked] = useState(initialChecked);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<'ok' | 'warn' | 'muted'>('muted');
  const lastAppliedMemberRef = useRef(member);
  const latestMemberRef = useRef(member);
  const disabledRef = useRef(!!props.disabled);
  const savingRef = useRef(false);
  latestMemberRef.current = member;
  disabledRef.current = !!props.disabled;

  useEffect(() => {
    if (saving || lastAppliedMemberRef.current === member) return;
    lastAppliedMemberRef.current = member;
    setChecked(member.pinStreamingCardChatEnabled === true);
  }, [member, saving]);

  const masterEnabled = member.pinStreamingCardMasterEnabled === true;
  const effectiveEnabled = member.pinStreamingCardEffectiveEnabled === true;
  const detail = !masterEnabled
    ? tr('groups.pinStreamingCardMasterOff')
    : effectiveEnabled
      ? tr('groups.pinStreamingCardEnabled')
      : tr('groups.pinStreamingCardDisabled');
  const detailTone = !masterEnabled ? 'warn' : effectiveEnabled ? 'ok' : 'muted';

  async function save(nextChecked: boolean): Promise<void> {
    if (disabledRef.current || savingRef.current) return;
    const previous = checked;
    setChecked(nextChecked);
    savingRef.current = true;
    setSaving(true);
    setStatus(tr('groups.pinStreamingCardSaving'));
    setStatusTone('warn');
    try {
      const res = await setGroupPinStreamingCard(chat.chatId, member.larkAppId, nextChecked);
      if (!res.ok) {
        setChecked(previous);
        setStatus(tr('groups.pinStreamingCardSaveFailed', { error: responseErrorText(res) }));
        setStatusTone('warn');
        return;
      }
      setStatus(tr('groups.pinStreamingCardSaved'));
      setStatusTone('ok');
      const memberBeforeReload = latestMemberRef.current;
      try {
        await props.onSaved();
        const refreshedMember = latestMemberRef.current;
        if (refreshedMember !== memberBeforeReload) {
          setChecked(refreshedMember.pinStreamingCardChatEnabled === true);
        }
        lastAppliedMemberRef.current = refreshedMember;
      } catch (error) {
        lastAppliedMemberRef.current = latestMemberRef.current;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(tr('groups.pinStreamingCardRefreshFailed', { error: message }));
        setStatusTone('warn');
      }
    } catch (error) {
      setChecked(previous);
      const message = error instanceof Error ? error.message : String(error);
      setStatus(tr('groups.pinStreamingCardSaveFailed', { error: message }));
      setStatusTone('warn');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="g-pin-row" data-bot={member.larkAppId}>
      {props.hideHead ? null : (
        <div className="g-pin-row-head">
          <strong>{member.botName ?? member.larkAppId}</strong>
          <small>{member.larkAppId}</small>
        </div>
      )}
      <StreamingCardPinToggle
        scope="group-manage"
        checked={checked}
        disabled={props.disabled || saving}
        title={tr('groups.pinStreamingCard')}
        description={tr('groups.pinStreamingCardDescription')}
        detail={detail}
        detailTone={detailTone}
        detailAttrs={{ 'data-pin-master-state': masterEnabled ? 'on' : 'off' }}
        status={status}
        statusTone={statusTone}
        statusAttrs={{ 'data-pin-status': member.larkAppId }}
        dataAction="toggle-pin-streaming-card-group"
        dataAppId={member.larkAppId}
        onChange={nextChecked => void save(nextChecked)}
      />
    </div>
  );
}

function collaborationModeSignature(
  mode: 'standard' | 'project',
  coordinatorAppId: string,
  workerAppIds: Iterable<string>,
  autoEnrollWorkers: boolean,
  progressCard: ProjectProgressCardConfig,
): string {
  return JSON.stringify({
    mode,
    coordinatorAppId: mode === 'project' ? coordinatorAppId : '',
    workerAppIds: mode === 'project' ? [...workerAppIds].sort() : [],
    autoEnrollWorkers: mode === 'project' ? autoEnrollWorkers : false,
    progressCard: mode === 'project' ? progressCard : null,
  });
}

const PROJECT_CARD_SECTION_OPTIONS: Array<{
  id: ProjectProgressCardSectionId;
  labelKey: string;
}> = [
  { id: 'goal', labelKey: 'groups.projectCardSectionGoal' },
  { id: 'blockers', labelKey: 'groups.projectCardSectionBlockers' },
  { id: 'workstreams', labelKey: 'groups.projectCardSectionWorkstreams' },
  { id: 'milestones', labelKey: 'groups.projectCardSectionMilestones' },
];

export function ProjectGroupModeSection(props: {
  chat: GroupChat;
  members: GroupChat['memberBots'];
  disabled?: boolean;
  tr: Translator;
  onSaved(): Promise<GroupsSnapshot>;
}) {
  const { chat, members, tr } = props;
  const memberIds = useMemo(() => members.map(member => member.larkAppId), [members]);
  const initialCoordinator = chat.projectCoordinatorAppId ?? memberIds[0] ?? '';
  const initialWorkers = chat.projectWorkerAppIds
    ?? memberIds.filter(appId => appId !== initialCoordinator);
  const [mode, setMode] = useState<'standard' | 'project'>(chat.collaborationMode ?? 'standard');
  const [coordinatorAppId, setCoordinatorAppId] = useState(initialCoordinator);
  const [workerAppIds, setWorkerAppIds] = useState<Set<string>>(() => new Set(initialWorkers));
  const [autoEnrollWorkers, setAutoEnrollWorkers] = useState(
    chat.collaborationMode === 'project' ? chat.projectAutoEnrollWorkers === true : true,
  );
  const [progressCard, setProgressCard] = useState<ProjectProgressCardConfig>(
    () => chat.projectProgressCard ?? defaultProjectProgressCardConfig(),
  );
  const [runtime, setRuntime] = useState<ProjectGroupRuntimeSummary | null>(chat.projectRuntime ?? null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const savedSignatureRef = useRef(collaborationModeSignature(
    mode, coordinatorAppId, workerAppIds, autoEnrollWorkers, progressCard,
  ));

  const signature = collaborationModeSignature(mode, coordinatorAppId, workerAppIds, autoEnrollWorkers, progressCard);
  const dirty = signature !== savedSignatureRef.current;

  function selectMode(nextMode: 'standard' | 'project'): void {
    setMode(nextMode);
    setStatus(null);
    if (nextMode !== 'project') return;
    const coordinator = coordinatorAppId || memberIds[0] || '';
    setCoordinatorAppId(coordinator);
    if (workerAppIds.size === 0) setWorkerAppIds(new Set(memberIds.filter(appId => appId !== coordinator)));
  }

  function selectCoordinator(nextCoordinator: string): void {
    setCoordinatorAppId(nextCoordinator);
    setWorkerAppIds(current => {
      const next = new Set(current);
      next.delete(nextCoordinator);
      return next;
    });
    setStatus(null);
  }

  function selectCardTemplate(templateId: ProjectProgressCardTemplateId): void {
    setProgressCard(current => ({ ...current, templateId }));
    setStatus(null);
  }

  function toggleCardSection(section: ProjectProgressCardSectionId, enabled: boolean): void {
    setProgressCard(current => ({
      ...current,
      sections: enabled
        ? current.sections.includes(section) ? current.sections : [...current.sections, section]
        : current.sections.filter(currentSection => currentSection !== section),
    }));
    setStatus(null);
  }

  async function save(): Promise<void> {
    if (props.disabled || saving || !dirty) return;
    if (mode === 'project' && !coordinatorAppId) {
      setStatus({ text: tr('groups.projectModeNeedCoordinator'), tone: 'warn' });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const response = await saveGroupCollaborationMode(
        chat.chatId,
        mode === 'standard'
          ? { mode }
          : { mode, coordinatorAppId, workerAppIds: [...workerAppIds], autoEnrollWorkers, progressCard },
      );
      const nextCoordinator = response.config.coordinatorAppId ?? coordinatorAppId;
      const nextWorkers = response.config.workerAppIds ?? [];
      const nextAutoEnrollWorkers = response.config.autoEnrollWorkers === true;
      const nextProgressCard = response.config.progressCard ?? progressCard;
      setAutoEnrollWorkers(nextAutoEnrollWorkers);
      setProgressCard(nextProgressCard);
      savedSignatureRef.current = collaborationModeSignature(
        response.config.mode, nextCoordinator, nextWorkers, nextAutoEnrollWorkers, nextProgressCard,
      );
      setRuntime(response.project);
      setStatus(response.cardRefresh === 'deferred'
        ? { text: tr('groups.projectModeSavedCardDeferred'), tone: 'warn' }
        : { text: tr('groups.projectModeSaved'), tone: 'ok' });
      try {
        await props.onSaved();
      } catch (error) {
        setStatus({ text: tr('groups.projectModeRefreshFailed', { error: error instanceof Error ? error.message : String(error) }), tone: 'warn' });
      }
    } catch (error) {
      setStatus({ text: tr('groups.projectModeSaveFailed', { error: error instanceof Error ? error.message : String(error) }), tone: 'warn' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="g-collaboration-mode" aria-label={tr('groups.collaborationMode')}>
      <p><small>{tr('groups.collaborationModeHelp')}</small></p>
      <div className="g-mode-rail" role="radiogroup" aria-label={tr('groups.collaborationMode')}>
        <label className={`g-mode-option${mode === 'standard' ? ' selected' : ''}`}>
          <input
            type="radio"
            name={`group-mode-${chat.chatId}`}
            value="standard"
            checked={mode === 'standard'}
            disabled={props.disabled || saving}
            onChange={() => selectMode('standard')}
          />
          <span><strong>{tr('groups.standardMode')}</strong><small>{tr('groups.standardModeHelp')}</small></span>
        </label>
        <label className={`g-mode-option project${mode === 'project' ? ' selected' : ''}`}>
          <input
            type="radio"
            name={`group-mode-${chat.chatId}`}
            value="project"
            checked={mode === 'project'}
            disabled={props.disabled || saving}
            onChange={() => selectMode('project')}
          />
          <span><strong>{tr('groups.projectMode')}</strong><small>{tr('groups.projectModeHelp')}</small></span>
        </label>
      </div>

      {mode === 'project' ? (
        <div className="g-project-policy">
          <label className="g-project-coordinator">
            <span>{tr('groups.projectCoordinator')}</span>
            <select
              value={coordinatorAppId}
              disabled={props.disabled || saving}
              onChange={event => selectCoordinator(event.currentTarget.value)}
            >
              {members.map(member => (
                <option key={member.larkAppId} value={member.larkAppId}>{member.botName ?? member.larkAppId}</option>
              ))}
            </select>
          </label>
          <div className="g-project-workers">
            <span>{tr('groups.projectWorkers')}</span>
            <div className="g-project-worker-grid">
              {members.filter(member => member.larkAppId !== coordinatorAppId).map(member => (
                <label className="checkbox-row" key={member.larkAppId}>
                  <input
                    type="checkbox"
                    checked={workerAppIds.has(member.larkAppId)}
                    disabled={props.disabled || saving}
                    onChange={event => {
                      const checked = event.currentTarget.checked;
                      setWorkerAppIds(current => {
                        const next = new Set(current);
                        if (checked) next.add(member.larkAppId); else next.delete(member.larkAppId);
                        return next;
                      });
                      setStatus(null);
                    }}
                  />
                  <span className="checkbox-row-main"><strong>{member.botName ?? member.larkAppId}</strong></span>
                </label>
              ))}
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                data-project-auto-enroll-workers={chat.chatId}
                checked={autoEnrollWorkers}
                disabled={props.disabled || saving}
                onChange={event => {
                  setAutoEnrollWorkers(event.currentTarget.checked);
                  setStatus(null);
                }}
              />
              <span className="checkbox-row-main">
                <strong>{tr('groups.projectAutoEnrollWorkers')}</strong>
                <small>{tr('groups.projectAutoEnrollWorkersHelp')}</small>
              </span>
            </label>
          </div>
          <section className="g-project-role-config" aria-labelledby={`project-role-config-${chat.chatId}`}>
            <header>
              <strong id={`project-role-config-${chat.chatId}`}>{tr('groups.projectRoleConfig')}</strong>
              <small>{tr('groups.projectRoleConfigHelp')}</small>
            </header>
            <div className="g-project-role-grid">
              {members
                .filter(member => member.larkAppId === coordinatorAppId || workerAppIds.has(member.larkAppId))
                .map(member => {
                  const isCoordinator = member.larkAppId === coordinatorAppId;
                  const href = `#/roles?chatId=${encodeURIComponent(chat.chatId)}&botId=${encodeURIComponent(member.larkAppId)}`;
                  return (
                    <a className="g-project-role-link" href={href} key={`project-role-${member.larkAppId}`}>
                      <span>
                        <strong>{member.botName ?? member.larkAppId}</strong>
                        <small>{tr(isCoordinator ? 'groups.projectRoleCoordinator' : 'groups.projectRoleWorker')}</small>
                      </span>
                      <em className={member.hasRole ? 'configured' : ''}>
                        {tr(member.hasRole ? 'groups.projectRoleConfigured' : 'groups.projectRoleInherited')}
                      </em>
                    </a>
                  );
                })}
            </div>
          </section>
          <div className="g-project-protocol" aria-label={tr('groups.projectProtocol')}>
            <span><b>01</b>{tr('groups.projectProtocolDispatch')}</span>
            <span><b>02</b>{tr('groups.projectProtocolReport')}</span>
            <span><b>03</b>{tr('groups.projectProtocolCard')}</span>
          </div>
          <section className="g-project-card-config" aria-labelledby={`project-card-config-${chat.chatId}`}>
            <header>
              <strong id={`project-card-config-${chat.chatId}`}>{tr('groups.projectCardConfig')}</strong>
              <small>{tr('groups.projectCardConfigHelp')}</small>
            </header>
            <div className="g-card-template-rail" role="radiogroup" aria-label={tr('groups.projectCardTemplate')}>
              {([
                ['status-dashboard', 'groups.projectCardTemplateDashboard', 'groups.projectCardTemplateDashboardHelp'],
                ['compact-list', 'groups.projectCardTemplateCompact', 'groups.projectCardTemplateCompactHelp'],
              ] as Array<[ProjectProgressCardTemplateId, string, string]>).map(([templateId, labelKey, helpKey]) => (
                <label className={`g-card-template-option${progressCard.templateId === templateId ? ' selected' : ''}`} key={templateId}>
                  <input
                    type="radio"
                    name={`project-card-template-${chat.chatId}`}
                    value={templateId}
                    checked={progressCard.templateId === templateId}
                    disabled={props.disabled || saving}
                    onChange={() => selectCardTemplate(templateId)}
                  />
                  <span><strong>{tr(labelKey)}</strong><small>{tr(helpKey)}</small></span>
                </label>
              ))}
            </div>
            <div className="g-card-section-config">
              <span>{tr('groups.projectCardSections')}</span>
              <div className="g-card-section-grid">
                {PROJECT_CARD_SECTION_OPTIONS.map(option => (
                  <label className="checkbox-row" key={option.id}>
                    <input
                      type="checkbox"
                      checked={progressCard.sections.includes(option.id)}
                      disabled={props.disabled || saving}
                      onChange={event => toggleCardSection(option.id, event.currentTarget.checked)}
                    />
                    <span className="checkbox-row-main"><strong>{tr(option.labelKey)}</strong></span>
                  </label>
                ))}
              </div>
            </div>
            <label className="checkbox-row g-card-milestone-default">
              <input
                type="checkbox"
                checked={progressCard.milestonesExpanded}
                disabled={props.disabled || saving || !progressCard.sections.includes('milestones')}
                onChange={event => {
                  const checked = event.currentTarget.checked;
                  setProgressCard(current => ({ ...current, milestonesExpanded: checked }));
                  setStatus(null);
                }}
              />
              <span className="checkbox-row-main"><strong>{tr('groups.projectCardMilestonesExpanded')}</strong></span>
            </label>
          </section>
        </div>
      ) : null}

      <div className="g-project-runtime" data-project-runtime={runtime ? runtime.status : 'empty'}>
        <div>
          <strong>{tr('groups.projectRuntime')}</strong>
          {runtime ? (
            <small>{tr('groups.projectRuntimeSummary', {
              status: runtime.status,
              completed: runtime.completedWorkstreamCount,
              total: runtime.workstreamCount,
            })}</small>
          ) : <small>{tr('groups.projectRuntimeEmpty')}</small>}
        </div>
        {runtime ? <span className={runtime.blockerCount > 0 ? 'warn' : ''}>{runtime.phase}</span> : null}
      </div>

      <div className="g-project-mode-actions">
        <span className={status?.tone === 'ok' ? 'hint-ok' : status ? 'hint-warn-inline' : ''}>{status?.text ?? ''}</span>
        <button
          type="button"
          className="primary"
          disabled={props.disabled || saving || !dirty}
          onClick={() => void save()}
        >{saving ? tr('groups.projectModeSaving') : tr('groups.projectModeSave')}</button>
      </div>
    </fieldset>
  );
}

const MANAGE_TABS: Array<{ id: ManageTab; labelKey: string }> = [
  { id: 'overview', labelKey: 'groups.tabOverview' },
  { id: 'bots', labelKey: 'groups.tabBots' },
  { id: 'collab', labelKey: 'groups.tabCollab' },
  { id: 'access', labelKey: 'groups.tabAccess' },
  { id: 'danger', labelKey: 'groups.tabDanger' },
];

const SETTING_COLUMN_LABEL: Record<typeof BOT_SETTING_COLUMNS[number], string> = {
  role: 'groups.col.role',
  replyMode: 'groups.col.replyMode',
  oncall: 'groups.col.oncall',
  model: 'groups.col.model',
  serialInput: 'groups.col.serialInput',
  idleClose: 'groups.col.idleClose',
  cardMode: 'groups.col.cardMode',
  pin: 'groups.col.pin',
};

/** 一项设置的标题 + 说明 + 控件。说明很长，默认收成两行，悬停看全文。 */
function SettingBlock(props: { title: string; help?: string; children: ReactNode; attrs?: Record<string, string> }) {
  return (
    <section className="g-setting-block" {...props.attrs}>
      <header>
        <strong>{props.title}</strong>
        {props.help ? <small title={props.help}>{props.help}</small> : null}
      </header>
      <div className="g-setting-body">{props.children}</div>
    </section>
  );
}

/**
 * 概览：本群每个 bot × 每项设置一张表，取代旧弹窗「按设置分段、每段把所有 bot
 * 再列一遍」的长滚动——看一个 bot 的全貌不必翻 8 段。点一行进入该 bot 的设置。
 */
function BotSettingsMatrix(props: {
  chat: GroupChat;
  members: GroupChat['memberBots'];
  tr: Translator;
  onOpenBot(botId: string): void;
}) {
  const { tr } = props;
  const columns = BOT_SETTING_COLUMNS.filter(column => column !== 'replyMode' || !props.chat.sessionGroup);
  if (props.members.length === 0) return <p className="empty">{tr('groups.noBotsInChat')}</p>;
  return (
    <div className="g-matrix-wrap">
      <table className="g-matrix">
        <thead>
          <tr>
            <th scope="col">{tr('groups.col.bot')}</th>
            {columns.map(column => <th scope="col" key={column}>{tr(SETTING_COLUMN_LABEL[column])}</th>)}
          </tr>
        </thead>
        <tbody>
          {props.members.map(member => {
            const cells = summarizeBotSettings(member, tr);
            return (
              <tr key={member.larkAppId} data-bot={member.larkAppId} onClick={() => props.onOpenBot(member.larkAppId)}>
                <th scope="row">
                  <button
                    type="button"
                    className="g-matrix-bot"
                    title={tr('groups.openBotSettings', { bot: member.botName ?? member.larkAppId })}
                    onClick={event => { event.stopPropagation(); props.onOpenBot(member.larkAppId); }}
                  >
                    <BotAvatar bot={member} />
                    <strong>{member.botName ?? member.larkAppId}</strong>
                  </button>
                </th>
                {columns.map(column => (
                  <td key={column} className={`g-cell-${cells[column].tone}`} title={cells[column].detail ?? cells[column].text}>
                    {cells[column].text}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 单个 bot 在本群的全部设置，按「最常改 → 最少改」排列。 */
function BotSettingsPane(props: {
  chat: GroupChat;
  member: GroupChat['memberBots'][number];
  topology: string;
  replyModeHelp: string;
  disabled: boolean;
  tr: Translator;
  onSaved(): Promise<GroupsSnapshot>;
}) {
  const { chat, member, tr } = props;
  const botName = member.botName ?? member.larkAppId;
  const roleHref = `#/roles?chatId=${encodeURIComponent(chat.chatId)}&botId=${encodeURIComponent(member.larkAppId)}`;
  return (
    <div className="g-bot-settings" data-bot={member.larkAppId}>
      <SettingBlock title={tr('groups.col.role')} help={tr('groups.roleHelp')}>
        <div className="g-role-line">
          <span className={member.hasRole ? 'g-cell-on' : 'g-cell-off'}>
            {tr(member.hasRole ? 'groups.projectRoleConfigured' : 'groups.projectRoleInherited')}
          </span>
          <a className="btn-link" href={roleHref}>{tr('groups.roleEdit')}</a>
        </div>
      </SettingBlock>
      {chat.sessionGroup ? null : (
        <SettingBlock title={tr('groups.replyMode')} help={props.replyModeHelp} attrs={{ 'data-group-reply-mode': '', 'data-topology': props.topology }}>
          <GroupReplyModeRow
            chatId={chat.chatId} appId={member.larkAppId} botName={botName}
            label={tr('groups.col.replyMode')}
            state={member.replyMode} topicGroup={props.topology === 'topic'} disabled={props.disabled}
            onSaved={props.onSaved}
          />
        </SettingBlock>
      )}
      <SettingBlock title={tr('groups.oncall')} help={tr('groups.oncallHelp')}>
        <OncallRow chat={chat} member={member} label={tr('groups.enable')} disabled={props.disabled} tr={tr} onSaved={props.onSaved} />
      </SettingBlock>
      <SettingBlock title={tr('groups.defaultModels')} help={tr('groups.defaultModelsHelp')}>
        <GroupDefaultModelsRow
          chatId={chat.chatId} appId={member.larkAppId} botName={botName}
          cliId={member.agentCliId} botModel={member.agentModel} botEffort={member.agentReasoningEffort}
          models={member.defaultModels} disabled={props.disabled}
          onSaved={props.onSaved}
        />
      </SettingBlock>
      <SettingBlock title={tr('groups.serialInput')} help={tr('groups.serialInputHelp')}>
        <GroupSerialInputRow
          chatId={chat.chatId} appId={member.larkAppId} botName={botName} label={tr('groups.enable')}
          enabled={member.serialInput === true} disabled={props.disabled}
          onSaved={props.onSaved}
        />
      </SettingBlock>
      <SettingBlock title={tr('groups.idleClose')} help={tr('groups.idleCloseHelp')} attrs={{ 'data-group-idle-close': '' }}>
        <GroupIdleCloseRow
          chatId={chat.chatId} appId={member.larkAppId} botName={botName} label={tr('groups.enable')}
          settings={member.idleClose} disabled={props.disabled}
          onSaved={props.onSaved}
        />
      </SettingBlock>
      <SettingBlock title={tr('groups.cardMode')} help={tr('groups.cardModeHelp')} attrs={{ 'data-group-card-mode': '' }}>
        <GroupCardModeRow
          chatId={chat.chatId} appId={member.larkAppId} botName={botName} label={tr('groups.cardModeShow')}
          chatEnabled={member.streamingCardChatEnabled !== false}
          masterEnabled={member.streamingCardMasterEnabled !== false}
          disabled={props.disabled}
          onSaved={props.onSaved}
        />
      </SettingBlock>
      <SettingBlock title={tr('groups.pinStreamingCardSection')} help={tr('groups.pinStreamingCardBotHint')}>
        <GroupPinStreamingCardRow chat={chat} member={member} hideHead disabled={props.disabled} tr={tr} onSaved={props.onSaved} />
      </SettingBlock>
    </div>
  );
}

export function ManageDialog(props: {
  chat: GroupChat;
  available?: boolean;
  initialBotId?: string;
  tr: Translator;
  onClose(): void;
  onReloadGroups(options?: { force?: boolean }): Promise<GroupsSnapshot>;
}) {
  const { chat, tr } = props;
  const available = props.available !== false;
  const inChat = inChatMembers(chat);
  const ownerAppId = typeof chat.ownerId === 'string' ? chat.ownerId : '';
  const ownerBot = inChat.find(member => member.larkAppId === ownerAppId);
  const [tab, setTabState] = useState<ManageTab>(props.initialBotId ? 'bots' : 'overview');
  // 「成员权限」一挂载就按在群 bot 拉成员列表 / 黑名单 / 授权回读，只在第一次切过去时挂载；
  // 之后和其它页签一样常驻、只切 hidden，来回切不丢已加载的状态。
  const [accessVisited, setAccessVisited] = useState(false);
  const setTab = useCallback((next: ManageTab) => {
    setTabState(next);
    if (next === 'access') setAccessVisited(true);
  }, []);
  const [selectedBotId, setSelectedBotId] = useState(props.initialBotId ?? inChat[0]?.larkAppId ?? '');
  const [chatIdCopied, setChatIdCopied] = useState(false);
  const [leaveSelection, setLeaveSelection] = useState<Set<string>>(() => new Set());
  const inChatIdsRef = useRef(new Set(inChat.map(member => member.larkAppId)));
  inChatIdsRef.current = new Set(inChat.map(member => member.larkAppId));
  const availableRef = useRef(available);
  availableRef.current = available;
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  const isMounted = useCallback(() => mountedRef.current, []);
  const isAlive = useCallback(() => mountedRef.current && availableRef.current, []);
  // 会话群不展示回复模式，也就不必探测群拓扑。
  const topology = useGroupTopology(chat, chat.sessionGroup ? undefined : inChat[0]?.larkAppId);
  const replyModeHelp = tr(topology === 'topic' ? 'groups.replyModeTopicGroupHelp'
    : topology === 'group' ? 'groups.replyModeHelp'
    : 'groups.replyModeNeutralHelp');
  const reload = useCallback(() => props.onReloadGroups({ force: true }), [props.onReloadGroups]);
  // 选中的 bot 退群后落回第一个在群 bot，避免右侧空白。
  const selectedMember = inChat.find(member => member.larkAppId === selectedBotId) ?? inChat[0];

  useEffect(() => {
    setLeaveSelection(current => {
      const next = new Set([...current].filter(appId => inChatIdsRef.current.has(appId)));
      return next.size === current.size ? current : next;
    });
  }, [chat.chatId, chat.memberBots]);

  function openBot(botId: string): void {
    setSelectedBotId(botId);
    setTab('bots');
  }

  function toggleLeave(appId: string, checked: boolean): void {
    if (!availableRef.current) return;
    setLeaveSelection(cur => {
      const next = new Set(cur);
      if (checked) next.add(appId);
      else next.delete(appId);
      return next;
    });
  }

  async function leaveSelected(): Promise<void> {
    if (!isAlive()) return;
    const selected = [...leaveSelection];
    if (selected.length === 0) { toast('至少选一个机器人', { kind: 'warning' }); return; }
    const confirmed = await confirm({ title: '退出群聊', message: `确定让 ${selected.length} 个机器人退出群聊？该 bot 在此群的会话会一并关闭。`, danger: true });
    if (!isAlive() || !confirmed) return;
    const checked = selected.filter(appId => inChatIdsRef.current.has(appId));
    if (checked.length === 0) return;
    try {
      const r = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/leave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppIds: checked }),
      });
      if (!isMounted()) return;
      const respBody = await r.json();
      if (!isMounted()) return;
      const lines = (respBody.result ?? []).map((x: any) => {
        if (!x.ok) return `${x.larkAppId}: 失败 (${x.error ?? 'unknown'})`;
        const closed = (x.closedSessions ?? []) as any[];
        const failed = closed.filter(c => !c.ok).length;
        const ok = closed.length - failed;
        // Closed locally but the remote session survived: not a failure, but it
        // must not disappear into the plain "closed N" tally.
        const residuals = closed.filter(c => c.ok && c.residual)
          .map(c => describeCloseResidual(c.residual));
        const note = closed.length === 0
          ? ''
          : `（关闭 ${ok} 个会话${failed ? `，${failed} 个失败` : ''}`
            + `${residuals.length ? `，${residuals.length} 个有残留需人工清理：${residuals.join(', ')}` : ''}）`;
        return `${x.larkAppId}: OK${note}`;
      }).join('\n');
      toast(lines || `Unexpected: ${JSON.stringify(respBody)}`, { kind: 'success' });
      await props.onReloadGroups({ force: true });
      if (!isMounted()) return;
    } catch (err) {
      if (!isMounted()) return;
      toast('Network error: ' + err, { kind: 'error' });
    } finally {
      if (isMounted()) props.onClose();
    }
  }

  async function disband(): Promise<void> {
    if (!isAlive() || inChat.length === 0) return;
    const confirmed = await confirm({ title: '解散群聊', message: `确定解散群聊「${chat.name ?? chat.chatId}」？此操作不可恢复，本群所有机器人会话也会一并关闭。`, danger: true });
    if (!isAlive() || !confirmed) return;
    const ordered = [...inChat].sort((a, b) =>
      (b.larkAppId === ownerAppId ? 1 : 0) - (a.larkAppId === ownerAppId ? 1 : 0),
    );
    const errs: string[] = [];
    for (const member of ordered) {
      if (!isAlive()) return;
      try {
        const r = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/disband`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ larkAppId: member.larkAppId }),
        });
        if (!isMounted()) return;
        const respBody = await r.json();
        if (!isMounted()) return;
        if (respBody.ok) {
          const closed = (respBody.closedSessions ?? []) as any[];
          const failed = closed.filter(c => !c.ok).length;
          const ok = closed.length - failed;
          const residuals = closed.filter(c => c.ok && c.residual)
            .map(c => describeCloseResidual(c.residual));
          const closedNote = closed.length === 0
            ? ''
            : `\n关闭了 ${ok} 个会话${failed ? `，${failed} 个会话关闭失败` : ''}`
              + `${residuals.length ? `\n⚠️ ${residuals.length} 个有残留需人工清理：${residuals.join(', ')}` : ''}。`;
          toast(`已解散（由 ${member.botName ?? member.larkAppId} 执行）${closedNote}`, { kind: 'success' });
          await props.onReloadGroups({ force: true });
          if (!isMounted()) return;
          props.onClose();
          return;
        }
        errs.push(`${member.botName ?? member.larkAppId}: ${respBody.error ?? r.status}`);
      } catch (err) {
        if (!isAlive()) return;
        errs.push(`${member.botName ?? member.larkAppId}: ${err}`);
      }
    }
    if (!isAlive()) return;
    toast(`所有在群机器人均无法解散：\n${errs.join('\n')}\n\n建议改用「退出群聊」。`, { kind: 'error' });
  }

  // 所有标签页常驻挂载、只切 hidden：切标签不丢未保存的输入，也不重复发起各行的首屏请求。
  return (
    <article className="g-manage-dialog">
      <header className="g-manage-head">
        <ChatAvatar chat={chat} />
        <div className="g-manage-title">
          <h3>{chat.name ?? chat.chatId}</h3>
          <div className="g-manage-facts">
            {chat.collaborationMode === 'project' ? (
              <span className="groups-row-tag groups-row-project-tag">{tr('groups.projectModeBadge')}</span>
            ) : null}
            <span>{tr('groups.botCount', { n: inChat.length })}</span>
            <span>
              {tr('groups.owner')}
              {' '}
              {ownerBot ? <b>{ownerBot.botName ?? ownerBot.larkAppId}</b> : <code>{chat.ownerId ?? tr('common.unknown')}</code>}
            </span>
            <button
              type="button"
              className="g-manage-chatid"
              title={tr('groups.copyChatId')}
              onClick={() => {
                void copyText(chat.chatId, tr('sessions.copy')).then(didCopy => {
                  if (!didCopy || !mountedRef.current) return;
                  setChatIdCopied(true);
                  window.setTimeout(() => { if (mountedRef.current) setChatIdCopied(false); }, 900);
                });
              }}
            >
              <code>{chat.chatId}</code>
              <span>{chatIdCopied ? tr('sessions.copied') : tr('sessions.copy')}</span>
            </button>
          </div>
        </div>
        <div className="g-manage-head-actions">
          <a className="btn-link" href={chatOpenLink(chat.chatId)} target="_blank" rel="noopener">{tr('groups.openInLark')}</a>
          <button type="button" className="g-manage-close" aria-label={tr('sessions.dismiss')} onClick={props.onClose}>×</button>
        </div>
      </header>
      {!available ? (
        <p className="hint-warn" data-chat-unavailable>该群聊已不在最新列表中，管理操作已禁用。</p>
      ) : null}

      <nav className="g-manage-tabs" role="tablist" aria-label={tr('groups.manage')}>
        {MANAGE_TABS.map(item => (
          <button
            type="button"
            role="tab"
            key={item.id}
            id={`g-manage-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`g-manage-panel-${item.id}`}
            className={`${tab === item.id ? 'active' : ''}${item.id === 'danger' ? ' danger' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {tr(item.labelKey)}
          </button>
        ))}
      </nav>

      <div className="g-manage-body">
        <section role="tabpanel" id="g-manage-panel-overview" aria-labelledby="g-manage-tab-overview" hidden={tab !== 'overview'}>
          <p className="g-panel-help">{tr('groups.overviewHelp')}</p>
          <BotSettingsMatrix chat={chat} members={inChat} tr={tr} onOpenBot={openBot} />
        </section>

        <section role="tabpanel" id="g-manage-panel-bots" aria-labelledby="g-manage-tab-bots" hidden={tab !== 'bots'} className="g-bots-panel">
          {inChat.length === 0 ? <p className="empty">{tr('groups.noBotsInChat')}</p> : (
            <>
              <div className="g-bot-picker-rail" role="listbox" aria-label={tr('groups.tabBots')}>
                {inChat.map(member => (
                  <button
                    type="button"
                    role="option"
                    key={member.larkAppId}
                    aria-selected={member.larkAppId === selectedMember?.larkAppId}
                    className={member.larkAppId === selectedMember?.larkAppId ? 'active' : ''}
                    data-bot={member.larkAppId}
                    onClick={() => setSelectedBotId(member.larkAppId)}
                  >
                    <BotAvatar bot={member} />
                    <span>{member.botName ?? member.larkAppId}</span>
                    {member.larkAppId === ownerAppId ? <small>{tr('groups.owner')}</small> : null}
                  </button>
                ))}
              </div>
              <div className="g-bot-settings-host">
                {inChat.map(member => (
                  <div key={member.larkAppId} hidden={member.larkAppId !== selectedMember?.larkAppId}>
                    <BotSettingsPane
                      chat={chat}
                      member={member}
                      topology={topology}
                      replyModeHelp={replyModeHelp}
                      disabled={!available}
                      tr={tr}
                      onSaved={reload}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section role="tabpanel" id="g-manage-panel-collab" aria-labelledby="g-manage-tab-collab" hidden={tab !== 'collab'}>
          <ProjectGroupModeSection
            chat={chat}
            members={inChat}
            disabled={!available}
            tr={tr}
            onSaved={reload}
          />
        </section>

        <section role="tabpanel" id="g-manage-panel-access" aria-labelledby="g-manage-tab-access" hidden={tab !== 'access'}>
          {accessVisited ? <MemberAccessSection chat={chat} members={inChat} disabled={!available} tr={tr} /> : null}
        </section>

        <section role="tabpanel" id="g-manage-panel-danger" aria-labelledby="g-manage-tab-danger" hidden={tab !== 'danger'}>
          <fieldset>
            <legend>{tr('groups.leaveTitle')}</legend>
            {inChat.length === 0 ? (
              <p className="empty">{tr('groups.noBotsInChat')}</p>
            ) : (
              <div className="g-leave-picker">
                {inChat.map(member => (
                  <label className="checkbox-row" key={member.larkAppId}>
                    <input
                      type="checkbox"
                      name="leave-bot"
                      value={member.larkAppId}
                      checked={leaveSelection.has(member.larkAppId)}
                      disabled={!available}
                      onChange={ev => toggleLeave(member.larkAppId, ev.currentTarget.checked)}
                    />
                    <span className="checkbox-row-main">
                      <strong>{member.botName ?? member.larkAppId}</strong>
                      {member.larkAppId === ownerAppId ? <small>· 群主</small> : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="actions">
              <button id="g-leave-btn" type="button" disabled={!available || inChat.length === 0} onClick={() => void leaveSelected()}>{tr('groups.leaveSelected')}</button>
            </div>
          </fieldset>
          <fieldset className="g-disband-field">
            <legend>{tr('groups.disband')}</legend>
            <p className="g-manage-danger-hint">{tr('groups.dangerHint')}</p>
            <div className="actions">
              <button id="g-disband-btn" type="button" className="contrast" disabled={!available || inChat.length === 0} onClick={() => void disband()}>{tr('groups.disband')}</button>
            </div>
          </fieldset>
        </section>
      </div>
    </article>
  );
}

function DialogHost(props: {
  dialog: DialogState | null;
  snapshot: GroupsSnapshot;
  tr: Translator;
  onClose(): void;
  onCreated(resp: any, selectedIds: string[], name: string): void;
  onReloadGroups(options?: { force?: boolean }): Promise<GroupsSnapshot>;
  onBotsAdded(chatId: string, okIds: string[]): void;
  setTimer(fn: () => void, ms: number): number;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const onClose = () => props.onClose();
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, [props.onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.dialog && !dialog.open) dialog.showModal();
    if (!props.dialog && dialog.open) dialog.close();
  }, [props.dialog]);

  let content: ReactNode = null;
  if (props.dialog?.type === 'create') {
    content = (
      <CreateDialog
        key={props.dialog.template?.sourceChatId ?? 'new'}
        bots={props.snapshot.bots}
        template={props.dialog.template}
        tr={props.tr}
        onClose={props.onClose}
        onCreated={props.onCreated}
        setTimer={props.setTimer}
      />
    );
  } else if (props.dialog?.type === 'add-bots') {
    content = (
      <AddBotsDialog
        chat={props.dialog.chat}
        bots={props.snapshot.bots}
        tr={props.tr}
        onClose={props.onClose}
        onBotsAdded={props.onBotsAdded}
      />
    );
  } else if (props.dialog?.type === 'manage') {
    const capturedChat = props.dialog.chat;
    const currentChat = props.snapshot.chats.find(chat => chat.chatId === capturedChat.chatId);
    const chat = currentChat ?? capturedChat;
    content = (
      <ManageDialog
        key={capturedChat.chatId}
        chat={chat}
        available={!!currentChat}
        initialBotId={props.dialog.botId}
        tr={props.tr}
        onClose={props.onClose}
        onReloadGroups={props.onReloadGroups}
      />
    );
  }

  const className = props.dialog?.type === 'create'
    ? 'groups-create-modal'
    : props.dialog?.type === 'manage' ? 'groups-manage-drawer' : undefined;
  return (
    <dialog
      id="g-drawer"
      className={className}
      ref={dialogRef}
      onMouseDown={event => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      {content}
    </dialog>
  );
}

function GroupsPage() {
  const tr = useT();
  const mountedRef = useRef(false);
  const snapshotRef = useRef<GroupsSnapshot>(emptyGroupsSnapshot);
  const timersRef = useRef<Set<number>>(new Set());
  const delayResolversRef = useRef<Map<number, () => void>>(new Map());
  const snapshotRequestRunRef = useRef(0);
  const snapshotSuccessRunRef = useRef(0);
  const [snapshot, setSnapshotState] = useState<GroupsSnapshot>(emptyGroupsSnapshot);
  // 普通群 / 会话群两个视图各自记着搜索、机器人筛选和页码，切过去再切回来不丢。
  // 当前视图写进地址（`#/groups?view=session`），刷新和分享都能还原。
  const [view, setViewState] = useState<GroupView>(() => {
    const fromHash = hashQueryParam('view');
    return isGroupView(fromHash) ? fromHash : 'standard';
  });
  const [filtersByView, setFiltersByView] = useState<Record<GroupView, GroupFilters>>({
    standard: { q: '', botId: '' },
    session: { q: '', botId: '' },
  });
  const [pageByView, setPageByView] = useState<Record<GroupView, number>>({ standard: 1, session: 1 });
  const [sessionSort, setSessionSort] = useState<SessionGroupSort>('active');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const filters = filtersByView[view];
  const page = pageByView[view];

  // Single source of truth for snapshot writes: update the synchronous `snapshotRef`
  // BEFORE enqueuing the React state update, and always enqueue an absolute value (never
  // an updater). This keeps `snapshotRef.current` the immediate truth for every read path
  // — critical for the add-bots reconciler, whose read→merge→write commits can interleave
  // with other snapshot writes in one React batch. If the ref were updated *inside* a
  // deferred state updater (the old shape), a stale updater flushing later could clobber a
  // committer's already-synced ref, leaving state canonical but ref stale (and the next
  // reconcile would then recompute from the stale ref). Functional `next` resolves against
  // the live ref so it also composes correctly within a batch.
  const setSnapshot = useCallback((next: GroupsSnapshot | ((cur: GroupsSnapshot) => GroupsSnapshot)): GroupsSnapshot => {
    const resolved = typeof next === 'function' ? next(snapshotRef.current) : next;
    snapshotRef.current = resolved;
    setSnapshotState(resolved);
    return resolved;
  }, []);

  const setTimer = useCallback((fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      if (mountedRef.current) fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  const delay = useCallback((ms: number): Promise<void> => new Promise(resolve => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      delayResolversRef.current.delete(id);
      resolve();
    }, ms);
    timersRef.current.add(id);
    delayResolversRef.current.set(id, resolve);
  }), []);

  const reloadGroups = useCallback(async (options?: { force?: boolean }): Promise<GroupsSnapshot> => {
    const runId = ++snapshotRequestRunRef.current;
    try {
      const next = await fetchGroupsSnapshot({ force: options?.force });
      if (!mountedRef.current || runId < snapshotSuccessRunRef.current) return snapshotRef.current;
      snapshotSuccessRunRef.current = runId;
      setSnapshot(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (!mountedRef.current || runId !== snapshotRequestRunRef.current) return snapshotRef.current;
      throw error;
    }
  }, [setSnapshot]);

  const refreshUntilSeen = useCallback(async (chatId: string, expectedBotIds: Set<string>): Promise<void> => {
    const runId = ++snapshotRequestRunRef.current;
    const delays = [600, 1200, 1200, 1200, 1200, 1200];
    for (const ms of delays) {
      await delay(ms);
      if (!mountedRef.current || runId < snapshotSuccessRunRef.current) return;
      let next: GroupsSnapshot;
      try { next = await fetchGroupsSnapshot({ force: true }); }
      catch { continue; }
      if (!mountedRef.current || runId < snapshotSuccessRunRef.current) return;
      const row = (next.chats ?? []).find(chat => chat.chatId === chatId);
      if (row && allExpectedInChat(row, expectedBotIds)) {
        snapshotSuccessRunRef.current = runId;
        setSnapshot(next);
        setLoadError(null);
        return;
      }
    }
  }, [delay, setSnapshot]);

  // Add-bots reconciliation. Batches on the same chat can overlap (the dialog lets the
  // user submit batch B while batch A is still catching up Lark-side), so the pure
  // `createAddBotsReconciler` guards against an older poll committing a server snapshot
  // that still lacks B and rolling B's optimistic membership back — via a per-chat
  // generation id plus a per-chat union of pending okIds. Kept in a ref so the guard
  // state survives re-renders. Commit is scoped to the reconciled chat via
  // `mergeReconciledChat`: a server snapshot fetched while reconciling chat-X still carries
  // chat-Y's not-yet-propagated (missing) membership, so replacing the whole snapshot would
  // roll Y back. `createReconciledChatCommitter` does read→merge→write atomically; it reuses
  // the shared `setSnapshot` (sync ref-first) for the write so there is exactly ONE snapshot
  // entry point — a stale updater cannot later clobber the committer's ref, and a second chat
  // commit in the same React batch reads the first commit's canonical merge (both stay canonical).
  const reconcilerRef = useRef<ReturnType<typeof createAddBotsReconciler> | null>(null);
  if (!reconcilerRef.current) {
    reconcilerRef.current = createAddBotsReconciler({
      fetchSnapshot: () => fetchGroupsSnapshot({ force: true }),
      delay: ms => delay(ms),
      isMounted: () => mountedRef.current,
      commit: createReconciledChatCommitter({
        getSnapshot: () => snapshotRef.current,
        applySnapshot: merged => { setSnapshot(merged); },
      }),
    });
  }
  const reconcileAddedBots = useCallback(
    (chatId: string, okIds: string[]) => reconcilerRef.current!.reconcile(chatId, okIds),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      setLoading(true);
      try {
        await reloadGroups();
      } catch (err) {
        if (mountedRef.current) {
          setSnapshot(emptyGroupsSnapshot);
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      mountedRef.current = false;
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current.clear();
      for (const resolve of delayResolversRef.current.values()) resolve();
      delayResolversRef.current.clear();
    };
  }, [reloadGroups]);

  // 会话群（p2pMode=group 自动创建，session-groups-store 分型标记）与常驻群
  // 分两个视图：会话群由 bot 自动创建/命名/管理，数量随会话增长，混排会淹没
  // 真正需要人工管理的常驻群。两个视图共用同一个限高滚动列表 + 分页。
  const standardChats = useMemo(() => snapshot.chats.filter(c => !c.sessionGroup), [snapshot.chats]);
  const sessionChats = useMemo(() => snapshot.chats.filter(c => c.sessionGroup), [snapshot.chats]);
  const rows = useMemo(() => {
    if (view === 'standard') return filterGroupChats(standardChats, filters);
    return sortSessionGroups(filterGroupChats(sessionChats, filters), sessionSort);
  }, [view, standardChats, sessionChats, filters, sessionSort]);
  // 「最近活跃 N 分钟前」按快照到达的时刻算，不必每分钟重渲染整页。
  const now = useMemo(() => Date.now(), [snapshot]);
  const pageWindow = useMemo(
    () => paginateGroupRows(rows, page),
    [rows, page],
  );
  const avatarUrls = useMemo(() => botAvatarUrlMap(snapshot.bots), [snapshot.bots]);
  const botFilterOptions = useMemo(() => [
    { value: '', label: tr('groups.botFilterAll') },
    ...snapshot.bots.map(bot => ({ value: bot.larkAppId, label: bot.botName ?? bot.larkAppId })),
  ], [snapshot.bots, tr]);
  const botFilterLabel = botFilterOptions.find(option => option.value === filters.botId)?.label
    ?? tr('groups.botFilterAll');

  const setPage = useCallback((next: number) => {
    setPageByView(cur => (cur[view] === next ? cur : { ...cur, [view]: next }));
  }, [view]);
  const updateFilters = useCallback((patch: Partial<GroupFilters>) => {
    setFiltersByView(cur => ({ ...cur, [view]: { ...cur[view], ...patch } }));
    setPageByView(cur => (cur[view] === 1 ? cur : { ...cur, [view]: 1 }));
  }, [view]);
  const switchView = useCallback((next: GroupView) => {
    setViewState(next);
    setHashQueryParam('view', next === 'session' ? 'session' : null);
    const list = document.getElementById('g-body');
    if (list) list.scrollTop = 0;
  }, []);

  useEffect(() => {
    if (page !== pageWindow.page) setPage(pageWindow.page);
  }, [page, pageWindow.page, setPage]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await reloadGroups({ force: true });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }

  function openCreateDialog(): void {
    if (snapshotRef.current.bots.length === 0) {
      toast(tr('groups.noBotsOnline'), { kind: 'warning' });
      return;
    }
    setDialog({ type: 'create' });
  }

  const openCloneDialog = useCallback((chat: GroupChat): void => {
    if (snapshotRef.current.bots.length === 0) {
      toast(tr('groups.noBotsOnline'), { kind: 'warning' });
      return;
    }
    setDialog({ type: 'create', template: groupCloneTemplate(chat, snapshotRef.current.bots) });
  }, [tr]);

  function handleCreated(resp: any, selectedIds: string[], name: string): void {
    const chatId = String(resp.chatId);
    const invalidBotIds: string[] = Array.isArray(resp.invalidBotIds) ? resp.invalidBotIds : [];
    const validIds = selectedIds.filter(id => !invalidBotIds.includes(id));
    const expectedBotIds = new Set<string>(validIds);
    if (typeof resp.creator === 'string' && resp.creator) expectedBotIds.add(resp.creator);
    setSnapshot(injectOptimisticChat(snapshotRef.current, chatId, name || chatId, validIds, resp.creator));
    // 新群总是普通群；在会话群视图里建的群，切回普通群视图才看得到。
    if (view !== 'standard') switchView('standard');
    void refreshUntilSeen(chatId, expectedBotIds).catch(() => { /* tolerate */ });
  }

  // Mirrors handleCreated: the dialog reports which bots were actually added, we flip
  // their `inChat` optimistically so the outer list updates without waiting for the
  // Lark-side membership snapshot, then converge to the server truth. Reconciliation
  // goes through `reconcileAddedBots` (not `refreshUntilSeen`) because overlapping
  // batches on the same chat must not let an older poll roll a newer batch back.
  function handleBotsAdded(chatId: string, okIds: string[]): void {
    if (okIds.length === 0) return;
    setSnapshot(markBotsInChat(snapshotRef.current, chatId, okIds));
    void reconcileAddedBots(chatId, okIds).catch(() => { /* tolerate */ });
  }

  const openAddBotsDialog = useCallback((chat: GroupChat): void => {
    // The "添加 bot" button is disabled when nothing is addable, so this is the
    // normal open path. Guard defensively against a stale snapshot (button
    // enabled but roster already full) by silently ignoring — no toast, since the
    // greyed-out button already communicates "nothing to add".
    if (!chatHasAddableBots(chat, snapshotRef.current.bots)) return;
    setDialog({ type: 'add-bots', chat });
  }, []);

  const openManageDialog = useCallback((chat: GroupChat, botId?: string): void => {
    setDialog({ type: 'manage', chat, botId });
  }, []);

  function goToPage(nextPage: number): void {
    const list = document.getElementById('g-body');
    if (list) list.scrollTop = 0;
    setPage(nextPage);
  }

  const renderRow = (chat: GroupChat) => (view === 'session' ? (
    <SessionGroupRow chat={chat} now={now} tr={tr} key={chat.chatId} onManage={openManageDialog} />
  ) : (
    <GroupListRow
      chat={chat}
      bots={snapshot.bots}
      tr={tr}
      key={chat.chatId}
      onAddBots={openAddBotsDialog}
      onClone={openCloneDialog}
      onManage={openManageDialog}
    />
  ));
  const sessionSortOptions: Array<{ value: SessionGroupSort; label: string }> = [
    { value: 'active', label: tr('groups.sessionSortActive') },
    { value: 'created', label: tr('groups.sessionSortCreated') },
  ];

  return (
    <BotAvatarUrlContext.Provider value={avatarUrls}>
    <section className="page groups-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.groups')}</p>
          <h1>{tr('groups.title')}</h1>
        </div>
        <div className="page-heading-actions">
          <CreateActionButton id="g-create" className="page-primary-action" onClick={openCreateDialog}>{tr('groups.create')}</CreateActionButton>
        </div>
      </div>
      <form id="g-filters" className="filters dashboard-toolbar groups-toolbar" onSubmit={ev => ev.preventDefault()}>
        <div className="groups-view-switch" role="group" aria-label={tr('groups.viewSwitch')}>
          {([
            ['standard', 'groups.viewStandard', standardChats.length],
            ['session', 'groups.viewSession', sessionChats.length],
          ] as Array<[GroupView, string, number]>).map(([id, labelKey, count]) => (
            <button
              type="button"
              key={id}
              data-group-view={id}
              aria-pressed={view === id}
              className={view === id ? 'active' : ''}
              title={id === 'session' ? tr('groups.viewSessionHint') : undefined}
              onClick={() => switchView(id)}
            >
              {tr(labelKey)}
              <small>{loading ? '-' : count}</small>
            </button>
          ))}
        </div>
        <input
          type="search"
          name="q"
          placeholder={tr('groups.search')}
          value={filters.q}
          onChange={ev => updateFilters({ q: ev.currentTarget.value })}
        />
        <DropdownMenu
          className="groups-bot-filter"
          ariaLabel={tr('groups.botFilterLabel')}
          label={botFilterLabel}
          value={filters.botId}
          options={botFilterOptions}
          searchable
          searchPlaceholder={tr('botPicker.searchPlaceholder')}
          searchEmptyLabel={tr('botPicker.noMatch')}
          onChange={botId => updateFilters({ botId })}
        />
        {view === 'session' ? (
          <DropdownMenu
            className="groups-session-sort"
            ariaLabel={tr('groups.sessionSortLabel')}
            label={sessionSortOptions.find(option => option.value === sessionSort)?.label ?? ''}
            value={sessionSort}
            options={sessionSortOptions}
            onChange={next => {
              setSessionSort(next);
              setPage(1);
            }}
          />
        ) : null}
        <span className="groups-toolbar-spacer" aria-hidden="true" />
        <span className="groups-toolbar-count">
          {loading ? '-' : tr(view === 'session' ? 'groups.sessionListCount' : 'groups.listCount', { n: rows.length })}
        </span>
        <RefreshIconButton id="g-refresh" label={tr('groups.refresh')} busy={refreshing} disabled={refreshing} onClick={() => void refresh()} />
      </form>
      {loadError ? <p className="hint-warn">加载群组失败：{loadError}</p> : null}
      <section className="overview-block groups-matrix-section">
        {loading ? (
          <div id="g-loading"><LoadingState label={tr('common.loading')} /></div>
        ) : (
          <div className="groups-list-wrap" id="g-table-wrap">
            {rows.length === 0 ? (
              <div className="empty groups-list-empty" id="g-body">{tr(view === 'session' ? 'groups.sessionEmpty' : 'groups.empty')}</div>
            ) : (
              <OverviewList id="g-body" className="groups-list">
                {pageWindow.rows.map(renderRow)}
              </OverviewList>
            )}
            {rows.length > 0 && pageWindow.totalPages > 1 ? (
              <nav className="groups-pagination" aria-label={tr('groups.paginationLabel')}>
                <span className="groups-pagination-status" aria-live="polite">
                  {tr('groups.pageStatus', {
                    page: pageWindow.page,
                    pages: pageWindow.totalPages,
                    from: pageWindow.from,
                    to: pageWindow.to,
                    total: pageWindow.total,
                  })}
                </span>
                <div className="groups-pagination-actions">
                  <button
                    type="button"
                    disabled={pageWindow.page <= 1}
                    onClick={() => goToPage(pageWindow.page - 1)}
                  >{tr('groups.prevPage')}</button>
                  <button
                    type="button"
                    disabled={pageWindow.page >= pageWindow.totalPages}
                    onClick={() => goToPage(pageWindow.page + 1)}
                  >{tr('groups.nextPage')}</button>
                </div>
              </nav>
            ) : null}
          </div>
        )}
      </section>
      <DialogHost
        dialog={dialog}
        snapshot={snapshot}
        tr={tr}
        onClose={() => setDialog(null)}
        onCreated={handleCreated}
        onReloadGroups={reloadGroups}
        onBotsAdded={handleBotsAdded}
        setTimer={setTimer}
      />
    </section>
    </BotAvatarUrlContext.Provider>
  );
}

export function renderGroupsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <GroupsPage />);
}
