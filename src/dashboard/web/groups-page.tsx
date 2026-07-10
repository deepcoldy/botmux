import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { botOrbStyle, chatAvatarUrlFor } from './ui.js';
import {
  CreateActionButton,
  DropdownMenu,
  LoadingState,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverviewListTail,
  RefreshIconButton,
} from './dashboard-components.js';
import {
  hasExplicitChatRole,
  summarizeGroupProfileMatches,
  type EffectiveRoleValue,
  type RoleProfileSummaryLike,
} from './role-profile-match.js';
import {
  allExpectedInChat,
  availableBotsForPicker,
  collectGroupProfileEntries,
  emptyGroupsSnapshot,
  fetchGroupsSnapshot,
  fetchRoleProfileSummaries,
  filterGroupChats,
  injectOptimisticChat,
  isValidProfileId,
  loadGroupRoleProfileContext,
  roleKey,
  roleProfileBootstrapStatus,
  summarizeAddBotsResult,
  suggestRoleProfileIdFromChat,
  type AddBotsSummary,
  type GroupBot,
  type GroupChat,
  type GroupFilters,
  type GroupsSnapshot,
  type RoleProfileContext,
  type SaveProfileEntry,
} from './groups.js';

type Translator = ReturnType<typeof useT>;

type DialogState =
  | { type: 'create'; roleProfiles: RoleProfileSummaryLike[] }
  | { type: 'add-bots'; chat: GroupChat }
  | { type: 'save-profile'; chat: GroupChat; suggestedProfileId: string }
  | { type: 'manage'; chat: GroupChat };

type DialogErrorState = { title: string; reason: unknown };

function emptyRoleContext(): RoleProfileContext {
  return {
    profiles: [],
    entriesById: new Map(),
    groupRoleContentByBot: new Map(),
    loaded: false,
  };
}

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

function DialogError(props: DialogErrorState) {
  return (
    <p className="hint-warn">
      <strong>{props.title}</strong>
      <br />
      <small>{String(props.reason ?? 'unknown')}</small>
    </p>
  );
}

function BotCheckboxes(props: { bots: GroupBot[]; excludeIds?: Set<string> }) {
  return (
    <>
      {availableBotsForPicker(props.bots, props.excludeIds).map(bot => (
        <label className="checkbox-row" key={bot.larkAppId}>
          <input type="checkbox" name="bot" value={bot.larkAppId} />
          <span className="checkbox-row-main">
            <strong>{bot.botName ?? bot.larkAppId}</strong>
            <small>({bot.larkAppId})</small>
          </span>
        </label>
      ))}
    </>
  );
}

function AddBotsResult(props: { summary: AddBotsSummary }) {
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
          return (
            <li key={`${id}-${index}`}>
              <code>{id}</code>: {row?.ok ? 'OK' : `failed (${String(row?.error ?? 'unknown')})`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GroupProfileStatus(props: {
  chat: GroupChat;
  context: RoleProfileContext;
  tr: Translator;
}) {
  const { chat, context, tr } = props;
  if (!context.profiles.length || !context.loaded) return null;

  const rolesByBot = new Map<string, EffectiveRoleValue>();
  for (const bot of chat.memberBots ?? []) {
    if (!bot?.inChat) continue;
    rolesByBot.set(bot.larkAppId, context.groupRoleContentByBot.get(roleKey(bot.larkAppId, chat.chatId)) ?? null);
  }
  if (!hasExplicitChatRole(rolesByBot)) return null;

  const matches = summarizeGroupProfileMatches(
    chat.memberBots ?? [],
    context.profiles,
    context.entriesById,
    rolesByBot,
  );
  const best = matches[0];
  if (!best) {
    return <div className="g-profile-status muted">{tr('groups.profileStatusUnmatched')}</div>;
  }
  const key = best.kind === 'full' ? 'groups.profileStatusFullChat' : 'groups.profileStatusPartial';
  return (
    <div className={`g-profile-status ${best.kind}`}>
      {tr(key, {
        name: best.profileId,
        matched: best.matched,
        total: best.total,
        chat: best.chatMatched,
      })}
    </div>
  );
}

function groupBotStatus(member: GroupChat['memberBots'][number] | undefined): 'in' | 'out' | 'error' | 'unknown' {
  if (!member) return 'unknown';
  if (member.error) return 'error';
  return member.inChat ? 'in' : 'out';
}

function groupBotStatusLabel(status: ReturnType<typeof groupBotStatus>, tr: Translator): string {
  switch (status) {
    case 'in': return tr('groups.botStatusIn');
    case 'out': return tr('groups.botStatusOut');
    case 'error': return tr('groups.botStatusError');
    case 'unknown':
    default:
      return tr('groups.botStatusUnknown');
  }
}

function GroupBotCoverage(props: { chat: GroupChat; bots: GroupBot[]; tr: Translator }) {
  const members = new Map((props.chat.memberBots ?? []).map(member => [member.larkAppId, member]));
  return (
    <div className="groups-bot-strip" aria-label={props.tr('groups.botCoverage')}>
      {props.bots.map(bot => {
        const member = members.get(bot.larkAppId);
        const status = groupBotStatus(member);
        const label = groupBotStatusLabel(status, props.tr);
        const name = bot.botName ?? bot.larkAppId;
        return (
          <span
            className={`groups-bot-pill groups-bot-${status}`}
            title={`${name}: ${label}${member?.error ? ` (${String(member.error)})` : ''}`}
            key={bot.larkAppId}
          >
            <i aria-hidden="true" />
            <span className="groups-bot-name">{name}</span>
            <span className="groups-bot-state">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

function GroupListRow(props: {
  chat: GroupChat;
  bots: GroupBot[];
  roleContext: RoleProfileContext;
  tr: Translator;
  onAddBots(chat: GroupChat): void;
  onSaveProfile(chat: GroupChat): void;
  onManage(chat: GroupChat): void;
}) {
  const { chat, tr } = props;
  const members = chat.memberBots ?? [];
  const inCount = members.filter(member => member.inChat).length;
  return (
    <OverviewListItem kind="group" className="groups-list-row" data-chat={chat.chatId}>
      <ChatAvatar chat={chat} />
      <OverviewListMain>
        <div className="groups-row-head">
          <b>{chat.name ?? chat.chatId}</b>
          <span className="groups-row-meta">
            <span className="groups-row-tag"><code>{chat.chatId}</code></span>
            {chat.ownerId ? (
              <span className="groups-row-tag groups-row-owner-tag">
                <span>{tr('groups.owner')}</span>
                <code>{chat.ownerId}</code>
              </span>
            ) : null}
          </span>
        </div>
        <GroupProfileStatus chat={chat} context={props.roleContext} tr={tr} />
      </OverviewListMain>
      <span className="groups-row-count">{tr('groups.memberSummary', { count: inCount, total: props.bots.length })}</span>
      <div className="groups-row-lower">
        <GroupBotCoverage chat={chat} bots={props.bots} tr={tr} />
        <OverviewListTail>
          <CreateActionButton className="add-bots" onClick={() => props.onAddBots(chat)}>{tr('groups.addBots')}</CreateActionButton>
          <button
            className="save-profile"
            type="button"
            onClick={() => props.onSaveProfile(chat)}
          >
            {tr('groups.saveAsProfile')}
          </button>
          <button className="manage-chat" type="button" onClick={() => props.onManage(chat)}>{tr('groups.manage')}</button>
        </OverviewListTail>
      </div>
    </OverviewListItem>
  );
}

function CreateDialog(props: {
  bots: GroupBot[];
  roleProfiles: RoleProfileSummaryLike[];
  tr: Translator;
  onClose(): void;
  onCreated(resp: any, selectedIds: string[], name: string): void;
  setTimer(fn: () => void, ms: number): number;
}) {
  const { tr } = props;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DialogErrorState | null>(null);
  const [success, setSuccess] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const [roleProfileId, setRoleProfileId] = useState('');

  async function submit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const name = String(fd.get('name') ?? '').trim();
    const bindWorkingDir = String(fd.get('bindWorkingDir') ?? '').trim();
    const roleProfileId = String(fd.get('roleProfileId') ?? '').trim();
    const ids = fd.getAll('bot') as string[];
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
          roleProfileId: roleProfileId || undefined,
        }),
      });
      const respBody = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (respBody.ok && respBody.chatId) {
        setSuccess(respBody);
        props.onCreated(respBody, ids, name);
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
      : `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
    const invalidBots = (success.invalidBotIds ?? []) as string[];
    const invalidUsers = (success.invalidUserIds ?? []) as string[];
    const binds = Array.isArray(success.oncallBindings) ? success.oncallBindings as any[] : [];
    const bindOk = binds.filter(b => b?.ok).length;
    const bindFailed = binds.filter(b => !b?.ok);
    const profileStatus = roleProfileBootstrapStatus(
      typeof success.roleProfileId === 'string' ? success.roleProfileId : '',
      success.roleProfileBootstrapMessageId,
      success.roleProfileBootstrapError,
    );

    return (
      <article className="g-create-dialog g-create-success">
        <header><h3>{tr('groups.successTitle')}</h3></header>
        <p>
          <b>chatId:</b> <code>{chatId}</code>{' '}
          <button
            type="button"
            data-copy={chatId}
            onClick={() => {
              void navigator.clipboard.writeText(chatId);
              setCopied(true);
              props.setTimer(() => setCopied(false), 800);
            }}
          >
            {copied ? tr('sessions.copied') : tr('sessions.copy')}
          </button>
        </p>
        <p><b>创建者:</b> <code>{String(success.creator ?? '?')}</code></p>
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
        {profileStatus ? <p className={profileStatus.kind === 'ok' ? 'hint-ok' : 'hint-warn'}>{profileStatus.text}</p> : null}
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
        <h3>{tr('groups.createTitle')}</h3>
        <p>{tr('groups.createHelp')}</p>
      </header>
      <form id="g-createform" className="g-create-form" onSubmit={ev => void submit(ev)}>
        <fieldset className="g-modal-field g-create-bots">
          <legend>{tr('groups.botPicker')}</legend>
          <div className="g-bot-picker">
            <BotCheckboxes bots={props.bots} />
          </div>
        </fieldset>

        <div className="g-create-fields">
          <fieldset className="g-modal-field">
            <legend>{tr('groups.name')}</legend>
            <input type="text" name="name" placeholder={tr('groups.namePlaceholder')} maxLength={60} />
          </fieldset>
          <fieldset className="g-modal-field">
            <legend>{tr('groups.bindDir')}</legend>
            <input type="text" name="bindWorkingDir" placeholder="e.g. ~/projects/botmux" />
            <small>{tr('groups.bindDirHelp')}</small>
          </fieldset>
          <fieldset className="g-modal-field g-profile-field">
            <legend>{tr('groups.roleProfile')}</legend>
            <input type="hidden" name="roleProfileId" value={roleProfileId} />
            <DropdownMenu
              className="g-profile-menu"
              ariaLabel={tr('groups.roleProfile')}
              label={roleProfileId || tr('groups.roleProfileNone')}
              value={roleProfileId}
              options={[
                { value: '', label: tr('groups.roleProfileNone') },
                ...props.roleProfiles.map(profile => ({ value: profile.profileId, label: profile.profileId })),
              ]}
              onChange={setRoleProfileId}
            />
            <small>{tr('groups.roleProfileHelp')}</small>
          </fieldset>
        </div>

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

function AddBotsDialog(props: {
  chat: GroupChat;
  bots: GroupBot[];
  tr: Translator;
  onClose(): void;
  onReloadGroups(options?: { force?: boolean }): Promise<GroupsSnapshot>;
}) {
  const { chat, tr } = props;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DialogErrorState | null>(null);
  const [summary, setSummary] = useState<{ result: AddBotsSummary; refreshError?: unknown } | null>(null);
  const inChatSet = useMemo(
    () => new Set((chat.memberBots ?? []).filter(member => member.inChat).map(member => member.larkAppId)),
    [chat],
  );

  async function submit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const ids = fd.getAll('bot') as string[];
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
        try {
          await props.onReloadGroups({ force: true });
          setSummary({ result });
        } catch (err) {
          setSummary({ result, refreshError: `添加结果已返回，但刷新群组列表失败：${err}` });
        }
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
        <BotCheckboxes bots={props.bots} excludeIds={inChatSet} />
        <div data-add-status aria-live="polite">
          {error ? <DialogError {...error} /> : null}
          {summary ? (
            <>
              <AddBotsResult summary={summary.result} />
              {summary.refreshError ? <DialogError title="刷新失败" reason={summary.refreshError} /> : null}
            </>
          ) : null}
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

function SaveProfileDialog(props: {
  chat: GroupChat;
  suggestedProfileId: string;
  tr: Translator;
  onClose(): void;
  onRefreshRoleContext(): Promise<void>;
  setTimer(fn: () => void, ms: number): number;
}) {
  const { tr } = props;
  const [entries, setEntries] = useState<SaveProfileEntry[]>([]);
  const [profiles, setProfiles] = useState<RoleProfileSummaryLike[]>([]);
  const [loadingSnapshot, setLoadingSnapshot] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sortedProfiles = useMemo(
    () => [...profiles].sort((a, b) => a.profileId.localeCompare(b.profileId)),
    [profiles],
  );
  const hasExistingProfiles = sortedProfiles.length > 0;
  const emptyCount = entries.filter(entry => entry.status === 'empty').length;
  const failedCount = entries.filter(entry => entry.status === 'error').length;
  const canSubmitSnapshot = !loadingSnapshot && !loadError && entries.length > 0 && failedCount === 0;
  const [selectedMode, setSelectedMode] = useState<'new' | 'overwrite'>('new');
  const [profileId, setProfileId] = useState(props.suggestedProfileId);
  const [selectedExistingProfileId, setSelectedExistingProfileId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ text: string; className?: 'ok' | 'error' } | null>(null);

  const currentProfileId = selectedMode === 'overwrite' ? selectedExistingProfileId : profileId.trim();
  const submitText = selectedMode === 'overwrite'
    ? tr('groups.saveProfileOverwriteSubmit')
    : tr('groups.saveProfileSubmit');
  const snapshotSummary = loadError
    ? loadError
    : loadingSnapshot
      ? tr('groups.saveProfilePreparing')
      : failedCount
        ? tr('groups.saveProfileFailedLoadSummary', { count: failedCount })
        : entries.length
          ? emptyCount
            ? tr('groups.saveProfileEntrySummaryWithEmpty', { count: entries.length, emptyCount })
            : tr('groups.saveProfileEntrySummary', { count: entries.length })
          : tr('groups.saveProfileNoRoles');

  useEffect(() => {
    let alive = true;
    setLoadingSnapshot(true);
    setLoadError(null);
    setStatus(null);
    void (async () => {
      try {
        const [nextEntries, nextProfiles] = await Promise.all([
          collectGroupProfileEntries(props.chat),
          fetchRoleProfileSummaries().catch(() => [] as RoleProfileSummaryLike[]),
        ]);
        if (!alive) return;
        const sortedNextProfiles = [...nextProfiles].sort((a, b) => a.profileId.localeCompare(b.profileId));
        setEntries(nextEntries);
        setProfiles(nextProfiles);
        setSelectedExistingProfileId(cur =>
          sortedNextProfiles.some(profile => profile.profileId === cur)
            ? cur
            : sortedNextProfiles[0]?.profileId ?? '',
        );
      } catch (err) {
        if (!alive) return;
        setEntries([]);
        setProfiles([]);
        setSelectedExistingProfileId('');
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoadingSnapshot(false);
      }
    })();
    return () => { alive = false; };
  }, [props.chat]);

  async function submit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    if (!canSubmitSnapshot) return;
    if (!isValidProfileId(currentProfileId)) {
      setStatus({ text: tr('groups.saveProfileInvalid'), className: 'error' });
      return;
    }

    setSubmitting(true);
    setStatus({ text: tr('groups.saveProfileSaving') });
    try {
      const results = await Promise.all(entries.map(async entry => {
        const r = await fetch(`/api/role-profiles/${encodeURIComponent(currentProfileId)}/${encodeURIComponent(entry.larkAppId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: entry.content, allowEmpty: true }),
        });
        return r.ok;
      }));
      const saved = results.filter(Boolean).length;
      if (saved !== entries.length) {
        setStatus({
          text: tr('groups.saveProfileFailed', { saved, total: entries.length }),
          className: 'error',
        });
        setSubmitting(false);
        return;
      }
      setStatus({
        text: tr('groups.saveProfileDone', { name: currentProfileId, count: saved }),
        className: 'ok',
      });
      await props.onRefreshRoleContext();
      props.setTimer(props.onClose, 700);
    } catch (err) {
      setStatus({ text: String(err), className: 'error' });
      setSubmitting(false);
    }
  }

  function pickMode(mode: 'new' | 'overwrite'): void {
    if (mode === 'overwrite' && !hasExistingProfiles) return;
    setSelectedMode(mode);
    setStatus(null);
  }

  return (
    <article className="g-save-profile-dialog">
      <header>
        <h3>{tr('groups.saveProfileTitle')}</h3>
        <p>{tr('groups.saveProfileIntro', {
          name: props.chat.name ?? props.chat.chatId,
          count: loadingSnapshot ? '-' : entries.length,
        })}</p>
      </header>
      <form id="g-save-profile-form" onSubmit={ev => void submit(ev)}>
        <section className="g-save-profile-panel">
          <div className="g-save-profile-section-head">
            <span>{tr('groups.saveProfileScope')}</span>
            <small>{tr('groups.saveProfileScopeHelp')}</small>
          </div>
          <div className="g-save-profile-stats">
            <span>{tr('groups.saveProfileBotCount')} <strong>{loadingSnapshot ? '-' : entries.length}</strong></span>
            {failedCount ? <span className="warn">{tr('groups.saveProfileLoadFailed')} <strong>{failedCount}</strong></span> : null}
          </div>
          <div className="g-save-profile-entry-list">
            {loadingSnapshot ? (
              <div className="g-save-profile-loading"><LoadingState label={tr('common.loading')} /></div>
            ) : loadError ? (
              <div className="g-save-profile-empty">{loadError}</div>
            ) : entries.length ? entries.map(entry => (
              <div className={`g-save-profile-entry ${entry.status === 'error' ? 'error' : ''}`} key={entry.larkAppId}>
                <div>
                  <strong>{entry.botName ?? entry.larkAppId}</strong>
                  <code>{entry.larkAppId}</code>
                </div>
                <span className={`g-save-profile-entry-status ${entry.status === 'error' ? 'error' : 'ok'}`}>
                  {tr(entry.status === 'error' ? 'groups.saveProfileStatus.error' : 'groups.saveProfileStatus.entry')}
                </span>
              </div>
            )) : <div className="g-save-profile-empty">{tr('groups.saveProfileNoRoles')}</div>}
          </div>
        </section>

        <div className="form-row">
          <span>{tr('groups.saveProfileMode')}</span>
          <div className="g-save-profile-switch" role="tablist" aria-label={tr('groups.saveProfileMode')}>
            <button
              type="button"
              className={selectedMode === 'new' ? 'active' : ''}
              data-save-profile-mode="new"
              aria-pressed={selectedMode === 'new'}
              onClick={() => pickMode('new')}
            >
              {tr('groups.saveProfileNew')}
            </button>
            <button
              type="button"
              className={selectedMode === 'overwrite' ? 'active' : ''}
              data-save-profile-mode="overwrite"
              aria-pressed={selectedMode === 'overwrite'}
              disabled={!hasExistingProfiles}
              onClick={() => pickMode('overwrite')}
            >
              {tr('groups.saveProfileOverwrite')}
            </button>
          </div>
        </div>
        <label className="form-row" data-profile-mode-row="new" hidden={selectedMode !== 'new'}>
          <span>{tr('groups.saveProfileIdLabel')}</span>
          <input
            type="text"
            name="profileId"
            value={profileId}
            maxLength={64}
            autoComplete="off"
            onChange={ev => {
              setProfileId(ev.currentTarget.value);
              setStatus(null);
            }}
          />
          <small>{tr('groups.saveProfileInvalid')}</small>
        </label>
        <div className="form-row" data-profile-mode-row="overwrite" hidden={selectedMode !== 'overwrite'}>
          <span>{tr('groups.saveProfileExistingLabel')}</span>
          {hasExistingProfiles ? (
            <div className="g-save-profile-picker">
              {sortedProfiles.map(profile => (
                <button
                  type="button"
                  className={`g-save-profile-pick ${profile.profileId === selectedExistingProfileId ? 'selected' : ''}`}
                  data-profile-id={profile.profileId}
                  aria-pressed={profile.profileId === selectedExistingProfileId}
                  key={profile.profileId}
                  onClick={() => {
                    setSelectedExistingProfileId(profile.profileId);
                    setSelectedMode('overwrite');
                    setStatus(null);
                  }}
                >
                  <span>{profile.profileId}</span>
                  <small>{tr('groups.saveProfileExistingMeta', { count: profile.entryCount ?? 0 })}</small>
                </button>
              ))}
            </div>
          ) : <div className="g-save-profile-summary warn">{tr('groups.saveProfileExistingEmpty')}</div>}
          <small>{tr('groups.saveProfileOverwriteHelp')}</small>
        </div>
        <div className="g-save-profile-target">
          <span>{tr('groups.saveProfileTarget')}</span>
          <code data-save-profile-target>{currentProfileId || '-'}</code>
          <small data-save-profile-target-mode>
            {selectedMode === 'overwrite' ? tr('groups.saveProfileTargetOverwrite') : tr('groups.saveProfileTargetNew')}
          </small>
        </div>
        <div className={`g-save-profile-summary ${canSubmitSnapshot ? '' : 'warn'}`}>
          {snapshotSummary}
        </div>
        <div className={`g-save-profile-status ${status?.className ?? ''}`} data-save-profile-status>
          {status?.text ?? ''}
        </div>
        <div className="actions">
          <button type="button" id="g-save-profile-cancel" onClick={props.onClose}>{tr('groups.cancel')}</button>
          <button
            type="submit"
            className="primary"
            disabled={!canSubmitSnapshot || submitting || (selectedMode === 'overwrite' && !selectedExistingProfileId)}
          >
            {submitting ? tr('groups.saveProfileSaving') : submitText}
          </button>
        </div>
      </form>
    </article>
  );
}

function OncallRow(props: {
  chat: GroupChat;
  member: GroupBot & { oncallChat?: { workingDir?: string } | null };
  tr: Translator;
  onSaved(): Promise<void>;
}) {
  const { member, tr } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [enabled, setEnabled] = useState(!!member.oncallChat);
  const [workingDir, setWorkingDir] = useState(member.oncallChat?.workingDir ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; className?: string } | null>(null);

  async function save(): Promise<void> {
    setStatus(null);
    const wd = workingDir.trim();
    if (enabled && !wd) {
      setStatus({ text: tr('groups.needWorkingDir'), className: 'hint-warn-inline' });
      return;
    }

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
        try { await props.onSaved(); } catch { /* tolerate */ }
      } else {
        setStatus({ text: `✗ ${body.error ?? r.status}`, className: 'hint-warn-inline' });
      }
    } catch (err: any) {
      setStatus({ text: `✗ ${err?.message ?? err}`, className: 'hint-warn-inline' });
    } finally {
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
          onChange={ev => {
            setEnabled(ev.currentTarget.checked);
            if (ev.currentTarget.checked) window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
        <strong>{member.botName ?? member.larkAppId}</strong>
        <small>({member.larkAppId})</small>
      </label>
      <div className="oncall-row-body">
        <input
          ref={inputRef}
          type="text"
          data-input="workingDir"
          placeholder="e.g. /root/iserver/botmux"
          value={workingDir}
          disabled={!enabled}
          onChange={ev => setWorkingDir(ev.currentTarget.value)}
        />
        <button type="button" data-action="save" disabled={saving} onClick={() => void save()}>{tr('groups.save')}</button>
        <span className={`oncall-status ${status?.className ?? ''}`} data-status>{status?.text ?? ''}</span>
      </div>
    </div>
  );
}

function ManageDialog(props: {
  chat: GroupChat;
  tr: Translator;
  onClose(): void;
  onReloadGroups(options?: { force?: boolean }): Promise<GroupsSnapshot>;
}) {
  const { chat, tr } = props;
  const inChat = (chat.memberBots ?? []).filter(member => member.inChat);
  const ownerAppId = typeof chat.ownerId === 'string' ? chat.ownerId : '';
  const [leaveSelection, setLeaveSelection] = useState<Set<string>>(() => new Set());

  function toggleLeave(appId: string, checked: boolean): void {
    setLeaveSelection(cur => {
      const next = new Set(cur);
      if (checked) next.add(appId);
      else next.delete(appId);
      return next;
    });
  }

  async function leaveSelected(): Promise<void> {
    const checked = [...leaveSelection];
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
      await props.onReloadGroups({ force: true });
    } catch (err) {
      alert('Network error: ' + err);
    } finally {
      props.onClose();
    }
  }

  async function disband(): Promise<void> {
    if (inChat.length === 0) return;
    if (!confirm(`确定解散群聊「${chat.name ?? chat.chatId}」？此操作不可恢复，本群所有机器人会话也会一并关闭。`)) return;
    const ordered = [...inChat].sort((a, b) =>
      (b.larkAppId === ownerAppId ? 1 : 0) - (a.larkAppId === ownerAppId ? 1 : 0),
    );
    const errs: string[] = [];
    for (const member of ordered) {
      try {
        const r = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/disband`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ larkAppId: member.larkAppId }),
        });
        const respBody = await r.json();
        if (respBody.ok) {
          const closed = (respBody.closedSessions ?? []) as any[];
          const failed = closed.filter(c => !c.ok).length;
          const ok = closed.length - failed;
          const closedNote = closed.length === 0
            ? ''
            : failed === 0 ? `\n关闭了 ${ok} 个会话。` : `\n关闭了 ${ok} 个会话，${failed} 个会话关闭失败。`;
          alert(`已解散（由 ${member.botName ?? member.larkAppId} 执行）${closedNote}`);
          await props.onReloadGroups({ force: true });
          props.onClose();
          return;
        }
        errs.push(`${member.botName ?? member.larkAppId}: ${respBody.error ?? r.status}`);
      } catch (err) {
        errs.push(`${member.botName ?? member.larkAppId}: ${err}`);
      }
    }
    alert(`所有在群机器人均无法解散：\n${errs.join('\n')}\n\n建议改用「退出群聊」。`);
  }

  return (
    <article className="g-manage-dialog">
      <header><h3>{tr('groups.manageTitle', { name: chat.name ?? chat.chatId })}</h3></header>
      <div className="g-manage-meta">
        <span><b>chatId</b><code>{chat.chatId}</code></span>
        <span><b>{tr('groups.owner')}</b><code>{chat.ownerId ?? tr('common.unknown')}</code></span>
      </div>

      <fieldset>
        <legend>{tr('groups.oncall')}</legend>
        <p><small>{tr('groups.oncallHelp')}</small></p>
        {inChat.length === 0 ? (
          <p className="empty">没有机器人在群里</p>
        ) : inChat.map(member => (
          <OncallRow
            key={member.larkAppId}
            chat={chat}
            member={member}
            tr={tr}
            onSaved={async () => { await props.onReloadGroups({ force: true }); }}
          />
        ))}
      </fieldset>

      <fieldset>
        <legend>{tr('groups.leaveTitle')}</legend>
        {inChat.length === 0 ? (
          <p className="empty">没有机器人在群里</p>
        ) : (
          <div className="g-leave-picker">
            {inChat.map(member => (
              <label className="checkbox-row" key={member.larkAppId}>
                <input
                  type="checkbox"
                  name="leave-bot"
                  value={member.larkAppId}
                  checked={leaveSelection.has(member.larkAppId)}
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
      </fieldset>

      <p className="g-manage-danger-hint">{tr('groups.dangerHint')}</p>
      <div className="actions">
        <button type="button" onClick={props.onClose}>{tr('sessions.dismiss')}</button>
        <button id="g-leave-btn" type="button" disabled={inChat.length === 0} onClick={() => void leaveSelected()}>{tr('groups.leaveSelected')}</button>
        <button id="g-disband-btn" type="button" className="contrast" disabled={inChat.length === 0} onClick={() => void disband()}>{tr('groups.disband')}</button>
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
  onRefreshRoleContext(): Promise<void>;
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
        bots={props.snapshot.bots}
        roleProfiles={props.dialog.roleProfiles}
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
        onReloadGroups={props.onReloadGroups}
      />
    );
  } else if (props.dialog?.type === 'save-profile') {
    content = (
      <SaveProfileDialog
        chat={props.dialog.chat}
        suggestedProfileId={props.dialog.suggestedProfileId}
        tr={props.tr}
        onClose={props.onClose}
        onRefreshRoleContext={props.onRefreshRoleContext}
        setTimer={props.setTimer}
      />
    );
  } else if (props.dialog?.type === 'manage') {
    content = (
      <ManageDialog
        chat={props.dialog.chat}
        tr={props.tr}
        onClose={props.onClose}
        onReloadGroups={props.onReloadGroups}
      />
    );
  }

  const className = props.dialog?.type === 'create' ? 'groups-create-modal' : undefined;
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
  const roleContextRunRef = useRef(0);
  const [snapshot, setSnapshotState] = useState<GroupsSnapshot>(emptyGroupsSnapshot);
  const [roleContext, setRoleContext] = useState<RoleProfileContext>(() => emptyRoleContext());
  const [filters, setFilters] = useState<GroupFilters>({ q: '', missingOnly: false });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const setSnapshot = useCallback((next: GroupsSnapshot | ((cur: GroupsSnapshot) => GroupsSnapshot)) => {
    setSnapshotState(cur => {
      const resolved = typeof next === 'function' ? next(cur) : next;
      snapshotRef.current = resolved;
      return resolved;
    });
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

  const refreshRoleProfileContext = useCallback(async (source?: GroupsSnapshot): Promise<void> => {
    const runId = ++roleContextRunRef.current;
    try {
      const context = await loadGroupRoleProfileContext(source ?? snapshotRef.current);
      if (mountedRef.current && runId === roleContextRunRef.current) setRoleContext(context);
    } catch {
      if (mountedRef.current && runId === roleContextRunRef.current) {
        setRoleContext({ ...emptyRoleContext(), loaded: true });
      }
    }
  }, []);

  const reloadGroups = useCallback(async (options?: { force?: boolean }): Promise<GroupsSnapshot> => {
    const next = await fetchGroupsSnapshot({ force: options?.force });
    if (!mountedRef.current) return next;
    setSnapshot(next);
    setLoadError(null);
    void refreshRoleProfileContext(next);
    return next;
  }, [refreshRoleProfileContext, setSnapshot]);

  const refreshUntilSeen = useCallback(async (chatId: string, expectedBotIds: Set<string>): Promise<void> => {
    const delays = [600, 1200, 1200, 1200, 1200, 1200];
    for (const ms of delays) {
      await delay(ms);
      if (!mountedRef.current) return;
      let next: GroupsSnapshot;
      try { next = await fetchGroupsSnapshot({ force: true }); }
      catch { continue; }
      if (!mountedRef.current) return;
      const row = (next.chats ?? []).find(chat => chat.chatId === chatId);
      if (row && allExpectedInChat(row, expectedBotIds)) {
        setSnapshot(next);
        void refreshRoleProfileContext(next);
        return;
      }
    }
  }, [delay, refreshRoleProfileContext, setSnapshot]);

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
          void refreshRoleProfileContext(emptyGroupsSnapshot);
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      mountedRef.current = false;
      roleContextRunRef.current += 1;
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current.clear();
      for (const resolve of delayResolversRef.current.values()) resolve();
      delayResolversRef.current.clear();
    };
  }, [reloadGroups]);

  const rows = useMemo(
    () => filterGroupChats(snapshot.chats, filters),
    [snapshot.chats, filters],
  );

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

  async function openCreateDialog(): Promise<void> {
    if (snapshotRef.current.bots.length === 0) {
      alert(tr('groups.noBotsOnline'));
      return;
    }
    let roleProfiles: RoleProfileSummaryLike[] = [];
    try { roleProfiles = await fetchRoleProfileSummaries(); }
    catch { /* profile selector is optional */ }
    if (mountedRef.current) setDialog({ type: 'create', roleProfiles });
  }

  function handleCreated(resp: any, selectedIds: string[], name: string): void {
    const chatId = String(resp.chatId);
    const invalidBotIds: string[] = Array.isArray(resp.invalidBotIds) ? resp.invalidBotIds : [];
    const validIds = selectedIds.filter(id => !invalidBotIds.includes(id));
    const expectedBotIds = new Set<string>(validIds);
    if (typeof resp.creator === 'string' && resp.creator) expectedBotIds.add(resp.creator);
    // Compute the optimistic snapshot from committed state (setSnapshot keeps snapshotRef in
    // sync) so the profile-context refresh always sees it — not a null from a deferred updater.
    const optimistic = injectOptimisticChat(snapshotRef.current, chatId, name || chatId, validIds, resp.creator);
    setSnapshot(optimistic);
    void refreshRoleProfileContext(optimistic);
    void refreshUntilSeen(chatId, expectedBotIds).catch(() => { /* tolerate */ });
  }

  function openAddBotsDialog(chat: GroupChat): void {
    const inChatSet = new Set((chat.memberBots ?? []).filter(member => member.inChat).map(member => member.larkAppId));
    const missing = snapshotRef.current.bots.filter(bot => !inChatSet.has(bot.larkAppId));
    if (!missing.length) {
      alert('All configured bots are already in this chat.');
      return;
    }
    setDialog({ type: 'add-bots', chat });
  }

  function openSaveProfileDialog(chat: GroupChat): void {
    const suggestedByName = suggestRoleProfileIdFromChat(chat.name ?? '');
    const suggestedProfileId = suggestedByName === 'profile'
      ? suggestRoleProfileIdFromChat(chat.chatId)
      : suggestedByName;
    setDialog({ type: 'save-profile', chat, suggestedProfileId });
  }

  return (
    <section className="page groups-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.groups')}</p>
          <h1>{tr('groups.title')}</h1>
        </div>
        <div className="page-heading-actions">
          <CreateActionButton id="g-create" className="page-primary-action" onClick={() => void openCreateDialog()}>{tr('groups.create')}</CreateActionButton>
        </div>
      </div>
      <form id="g-filters" className="filters dashboard-toolbar groups-toolbar" onSubmit={ev => ev.preventDefault()}>
        <input
          type="search"
          name="q"
          placeholder={tr('groups.search')}
          value={filters.q}
          onChange={ev => {
            const q = ev.currentTarget.value;
            setFilters(cur => ({ ...cur, q }));
          }}
        />
        <label className="filter-toggle">
          <input
            type="checkbox"
            name="missing"
            checked={filters.missingOnly}
            onChange={ev => {
              const missingOnly = ev.currentTarget.checked;
              setFilters(cur => ({ ...cur, missingOnly }));
            }}
          />
          <span className="filter-toggle-label">{tr('groups.missingOnly')}</span>
          <span className="filter-toggle-switch" aria-hidden="true" />
        </label>
        <span className="groups-toolbar-spacer" aria-hidden="true" />
        <span className="groups-toolbar-count">
          {tr('groups.matrixTitle')} {loading ? '-/-' : `${rows.length}/${snapshot.chats.length}`}
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
              <div className="empty groups-list-empty" id="g-body">{tr('groups.empty')}</div>
            ) : (
              <OverviewList id="g-body" className="groups-list">
                {rows.map(chat => (
                  <GroupListRow
                    chat={chat}
                    bots={snapshot.bots}
                    roleContext={roleContext}
                    tr={tr}
                    key={chat.chatId}
                    onAddBots={openAddBotsDialog}
                    onSaveProfile={openSaveProfileDialog}
                    onManage={chat => setDialog({ type: 'manage', chat })}
                  />
                ))}
              </OverviewList>
            )}
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
        onRefreshRoleContext={() => refreshRoleProfileContext()}
        setTimer={setTimer}
      />
    </section>
  );
}

export function renderGroupsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <GroupsPage />);
}
