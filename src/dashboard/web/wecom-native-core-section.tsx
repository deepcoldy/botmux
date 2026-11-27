import { cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { WecomNativeCoreConfig } from '../../im/wecom/config/native-core-config.js';
import type { StatusMessage } from './bot-defaults-save.js';
import { BotFieldTitle, BotSettingActions } from './bot-profile-ui.js';
import { jget } from './dashboard-api.js';
import { ToggleRow } from './dashboard-components.js';
import { DropdownField } from './field-controls.js';
import { useT } from './react-hooks.js';

// 企业微信专属格子的表单件：和飞书卡共用区块用同一套页面件与类名（输入行、开关行、下拉框、
// 说明、保存按钮与状态），两张卡上同类控件长得一样。单行输入框要写明 type="text"：格子里的输入框
// 样式只认 text / number。

/** 带标题的输入行（单行输入框、多行文本框）：标题即控件的无障碍名称。 */
export function NativeField({ label, children }: { label: string; children: ReactNode }) {
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label })
    : children;
  return (
    <div className="bd-row">
      <label className="bd-field">
        <span>{label}</span>
        {control}
      </label>
    </div>
  );
}

/** 开关行：共享 ToggleRow，标题用本页 bd-* 样式的 BotFieldTitle（与飞书卡的开关行同一件）。 */
export function NativeToggle({ label, description, checked, onChange }: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return <ToggleRow checked={checked} title={label} description={description} TitleComponent={BotFieldTitle} onChange={onChange} />;
}

/**
 * 带标题的下拉框：页面的 DropdownField（与飞书卡的下拉项同一件）。外层是 div 而不是 label——label 会把
 * 整行的点击转给菜单触发器。`dataInput` 在整张卡里要唯一（五个分类面板同时挂着，菜单 id 由它拼出）。
 */
export function NativeSelect({ label, dataInput, value, choices, onChange }: {
  label: string;
  dataInput: string;
  value: string;
  choices: ReadonlyArray<readonly [value: string, label: string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="bd-row">
      <div className="bd-field">
        <span>{label}</span>
        <DropdownField
          dataInput={dataInput}
          ariaLabel={label}
          value={value}
          options={choices.map(([choice, title]) => ({ value: choice, label: title }))}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

/**
 * 一组勾选框（与飞书「额度耗尽交接」的触发类型同一套 bd-subsection / bd-owner-reminder-states）。
 * 没有 `title` 时由外层区块的标题说明这组勾选框。
 */
export function NativeChecks({ title, items }: {
  title?: string;
  items: ReadonlyArray<{ key: string; label: string; checked: boolean; onChange: (value: boolean) => void }>;
}) {
  return (
    <div className="bd-subsection">
      {title ? <h4 className="bd-subsection-title">{title}</h4> : null}
      <div className="bd-owner-reminder-states">
        {items.map(item => (
          <label key={item.key}>
            <input type="checkbox" checked={item.checked} onChange={event => item.onChange(event.currentTarget.checked)} />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** 一个区块（格子里带 h3 标题的那一段）。 */
export function NativeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bd-section">
      <h3 className="bd-section-title">{title}</h3>
      {children}
    </div>
  );
}

/** 说明文字：页面统一的 bd-section-note。 */
export function NativeNote({ children }: { children: ReactNode }) {
  return <p className="bd-section-note">{children}</p>;
}

/** 保存按钮与保存状态：共享 BotSettingActions（主按钮 + 成功 / 失败着色的状态）。 */
export function NativeSaveActions({ action, label, savingLabel, busy, status, onSave }: {
  action: string;
  label: string;
  savingLabel: string;
  busy: boolean;
  status?: StatusMessage;
  onSave: () => void;
}) {
  return <BotSettingActions action={action} label={busy ? savingLabel : label} busy={busy} status={status} onSave={onSave} />;
}

/** 默认授权时长的四档（与飞书「默认授权时长」同一组）；未配置时按 1 小时。 */
const HOUR = 3600000;
const GRANT_DURATIONS: ReadonlyArray<readonly [ms: number, key: string]> = [
  [HOUR, 'botDefaults.wecom.core.duration1Hour'],
  [8 * HOUR, 'botDefaults.wecom.core.duration8Hours'],
  [24 * HOUR, 'botDefaults.wecom.core.duration1Day'],
  [7 * 24 * HOUR, 'botDefaults.wecom.core.duration7Days'],
];

/** 每次授权的任务额度：新填的值 1–1000（网关同一上限）；未配置时按 100。 */
const QUOTA_MAX = 1000;
const QUOTA_DEFAULT = 100;

/** 对话权限用户可用的命令（网关只认这三个），未配置时按 /status、/stop。 */
const TALK_COMMANDS = ['/status', '/stop', '/restart'] as const;
const DEFAULT_TALK_COMMANDS: readonly string[] = ['/status', '/stop'];

/** 每个页签只提交自己那几项，别的页签里没保存的草稿不会被顺带写进去。 */
const TAB_KEYS: Record<string, Array<keyof WecomNativeCoreConfig>> = {
  security: [
    'p2pOpen',
    'autoGrantRequestCards',
    'grantRequestToOwnerDm',
    'grantDefaultDurationMs',
    'messageQuotaDefaultLimit',
    'trustSameOwnerBots',
    'botToBotSameDir',
  ],
  cards: ['writableTerminalLinkInCard'],
  advanced: ['quotaFallbackBot'],
};

interface FallbackPeers {
  peers: Array<{ id: string; name?: string }>;
  current?: { id: string; name?: string; accepted: boolean };
  trusting: boolean;
}

/**
 * 企业微信本地核心策略：安全页「授权与额度」、卡片页的可操作终端开关、高级页「额度耗尽交接」各一格。
 * Native policies are host-admin configuration; IM users never receive this form.
 */
export function WecomNativeCoreSection({ id, connectionId, value, save, tab }: {
  /** 格子的 DOM id（企业微信卡按登记表给出，⌘K 深链落到这里）。 */
  id?: string;
  /** 高级页向服务端取备用 Bot 下拉的数据。 */
  connectionId: string;
  value?: WecomNativeCoreConfig;
  save(patch: { native: WecomNativeCoreConfig }): Promise<void>;
  tab: string;
}) {
  const tr = useT();
  const [draft, setDraft] = useState(value ?? {});
  const [quotaText, setQuotaText] = useState(value?.messageQuotaDefaultLimit === undefined ? '' : String(value.messageQuotaDefaultLimit));
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(value ?? {});
    setQuotaText(value?.messageQuotaDefaultLimit === undefined ? '' : String(value.messageQuotaDefaultLimit));
  }, [value]);
  const field = (key: keyof WecomNativeCoreConfig, v: unknown) => setDraft(x => ({ ...x, [key]: v }));
  async function submit() {
    setStatus(null);
    const own: WecomNativeCoreConfig = { ...draft };
    if (tab === 'security') {
      // 留空 = 内置默认；新值 1–1000；超过上限的旧值原样保留（网关按上限执行）。
      const text = quotaText.trim();
      const quota = text === '' ? undefined : Number(text);
      if (quota !== undefined
        && !(Number.isInteger(quota) && quota >= 1 && (quota <= QUOTA_MAX || quota === value?.messageQuotaDefaultLimit))) {
        setStatus({ text: tr('botDefaults.wecom.core.messageQuotaInvalid') });
        return;
      }
      if (quota === undefined) {
        delete own.messageQuotaDefaultLimit;
      } else {
        own.messageQuotaDefaultLimit = quota;
      }
    }
    if (tab === 'advanced' && own.quotaFallbackBot?.enabled) {
      if (!own.quotaFallbackBot.peerId) {
        setStatus({ text: tr('botDefaults.wecom.core.quotaFallbackTargetRequired') });
        return;
      }
      if (!own.quotaFallbackBot.kinds.length) {
        setStatus({ text: tr('botDefaults.wecom.core.quotaFallbackKindsRequired') });
        return;
      }
    }
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of TAB_KEYS[tab] ?? []) if (key in own) patch[key] = own[key];
      // 清空的额度要真的从配置里去掉：整份 native 以当前快照为底合并，缺省的键会沿用旧值。
      if (tab === 'security' && !('messageQuotaDefaultLimit' in own)) patch.messageQuotaDefaultLimit = undefined;
      await save({ native: patch });
      setStatus({ ok: true, text: tr('botDefaults.wecom.core.saved') });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : tr('botDefaults.wecom.saveFailed') });
    } finally {
      setBusy(false);
    }
  }
  const title = tab === 'security'
    ? tr('botDefaults.wecom.core.securityTitle')
    : tab === 'cards'
      ? tr('botDefaults.wecom.core.cardsTitle')
      : tr('botDefaults.wecom.core.advancedTitle');
  return (
    <section className="bd-tile" id={id} aria-label={tr('botDefaults.wecom.core.aria')} data-provider-only="wecom">
      <NativeGroup title={title}>
        {tab === 'security' && (
          <WecomGrantFields draft={draft} quotaText={quotaText} legacyQuota={value?.messageQuotaDefaultLimit} field={field} onQuota={setQuotaText} />
        )}
        {tab === 'cards' && (
          <NativeToggle
            label={tr('botDefaults.wecom.core.writableTerminalLink')}
            description={tr('botDefaults.wecom.core.cardsNote')}
            checked={draft.writableTerminalLinkInCard === true}
            onChange={v => field('writableTerminalLinkInCard', v)}
          />
        )}
        {tab === 'advanced' && (
          <WecomQuotaFallbackFields connectionId={connectionId} draft={draft} field={field} />
        )}
        <NativeSaveActions
          action={`save-wecom-core-${tab}`}
          label={tr('botDefaults.wecom.core.save')}
          savingLabel={tr('botDefaults.wecom.saving')}
          busy={busy}
          status={status}
          onSave={() => void submit()}
        />
      </NativeGroup>
    </section>
  );
}

/** 「授权与额度」的七项（名字与飞书同一格对应项一致）。 */
function WecomGrantFields({ draft, quotaText, legacyQuota, field, onQuota }: {
  draft: WecomNativeCoreConfig;
  quotaText: string;
  /** 配置里现有的额度（可能是超过上限的旧值）。 */
  legacyQuota?: number;
  field: (key: keyof WecomNativeCoreConfig, v: unknown) => void;
  onQuota: (text: string) => void;
}) {
  const tr = useT();
  const duration = draft.grantDefaultDurationMs ?? HOUR;
  // 不在四档里的现有值如实列出并选中；打开页面不改写它，只有另选一档才会变。
  const durationChoices: Array<[string, string]> = GRANT_DURATIONS.map(([ms, key]) => [String(ms), tr(key)]);
  if (!GRANT_DURATIONS.some(([ms]) => ms === duration)) {
    durationChoices.push([String(duration), tr('botDefaults.wecom.core.durationCurrent', { hours: Math.round(duration / HOUR * 100) / 100 })]);
  }
  return (
    <>
      <NativeToggle label={tr('botDefaults.wecom.core.p2pOpen')} checked={draft.p2pOpen === true} onChange={v => field('p2pOpen', v)} />
      <NativeToggle
        label={tr('botDefaults.wecom.core.autoGrantRequestCards')}
        checked={draft.autoGrantRequestCards === true}
        onChange={v => field('autoGrantRequestCards', v)}
      />
      <NativeToggle
        label={tr('botDefaults.wecom.core.grantRequestToOwnerDm')}
        description={tr('botDefaults.wecom.core.grantRequestToOwnerDmNote')}
        checked={draft.grantRequestToOwnerDm === true}
        onChange={v => field('grantRequestToOwnerDm', v)}
      />
      <NativeSelect
        label={tr('botDefaults.wecom.core.grantDefaultDuration')}
        dataInput="wecomGrantDefaultDuration"
        value={String(duration)}
        choices={durationChoices}
        onChange={v => field('grantDefaultDurationMs', Number(v))}
      />
      <NativeField label={tr('botDefaults.wecom.core.messageQuotaDefaultLimit')}>
        <input
          type="number"
          min="1"
          max={String(QUOTA_MAX)}
          placeholder={tr('botDefaults.wecom.core.messageQuotaPlaceholder', { count: QUOTA_DEFAULT })}
          value={quotaText}
          onChange={e => onQuota(e.target.value)}
        />
      </NativeField>
      {legacyQuota !== undefined && legacyQuota > QUOTA_MAX && quotaText.trim() === String(legacyQuota) ? (
        <NativeNote>{tr('botDefaults.wecom.core.messageQuotaLegacy', { configured: legacyQuota, limit: QUOTA_MAX })}</NativeNote>
      ) : null}
      <NativeToggle
        label={tr('botDefaults.wecom.core.trustSameOwnerBots')}
        description={tr('botDefaults.wecom.core.trustSameOwnerBotsNote')}
        checked={draft.trustSameOwnerBots !== false}
        onChange={v => field('trustSameOwnerBots', v)}
      />
      <NativeToggle
        label={tr('botDefaults.wecom.core.botToBotSameDir')}
        description={tr('botDefaults.wecom.core.botToBotSameDirNote')}
        checked={draft.botToBotSameDir !== false}
        onChange={v => field('botToBotSameDir', v)}
      />
      <NativeNote>{tr('botDefaults.wecom.core.securityNote')}</NativeNote>
    </>
  );
}

/**
 * 对话权限用户可用的命令：三个勾选框。企业微信卡把它挂在共用的「Slash 命令」格里、「额外透传命令」下面
 * （登记表里是合放在那一格的企业微信专属区块）；值存在连接配置的 native 里，飞书那一格的表单不经手它。
 */
export function WecomTalkCommandsSection({ value, save }: {
  value?: WecomNativeCoreConfig;
  save(patch: { native: WecomNativeCoreConfig }): Promise<void>;
}) {
  const tr = useT();
  const [talk, setTalk] = useState<readonly string[]>(value?.canTalkDaemonCommands ?? DEFAULT_TALK_COMMANDS);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTalk(value?.canTalkDaemonCommands ?? DEFAULT_TALK_COMMANDS);
  }, [value?.canTalkDaemonCommands]);
  async function submit() {
    setBusy(true);
    setStatus(null);
    try {
      await save({ native: { canTalkDaemonCommands: TALK_COMMANDS.filter(command => talk.includes(command)) } });
      setStatus({ ok: true, text: tr('botDefaults.wecom.core.saved') });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : tr('botDefaults.wecom.saveFailed') });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={tr('botDefaults.wecom.core.aria')} data-provider-only="wecom">
      <NativeGroup title={tr('botDefaults.wecom.core.canTalkDaemonCommands')}>
        <NativeChecks
          items={TALK_COMMANDS.map(command => ({
            key: command,
            label: command,
            checked: talk.includes(command),
            onChange: (checked: boolean) => setTalk(TALK_COMMANDS.filter(c => c === command ? checked : talk.includes(c))),
          }))}
        />
        <NativeNote>{tr('botDefaults.wecom.core.canTalkDaemonCommandsNote')}</NativeNote>
        <NativeSaveActions
          action="save-wecom-core-talk-commands"
          label={tr('botDefaults.wecom.core.save')}
          savingLabel={tr('botDefaults.wecom.saving')}
          busy={busy}
          status={status}
          onSave={() => void submit()}
        />
      </NativeGroup>
    </section>
  );
}

/**
 * 「额度耗尽交接」：启用开关、备用 Bot 下拉、两种触发类型、交接文案（布局仿飞书同一格）。下拉只列服务端
 * 判定会接受本连接的本机企业微信连接（只给 id 与名字）；已配置的目标现在不满足条件时如实列出并提示。
 */
function WecomQuotaFallbackFields({ connectionId, draft, field }: {
  connectionId: string;
  draft: WecomNativeCoreConfig;
  field: (key: keyof WecomNativeCoreConfig, v: unknown) => void;
}) {
  const tr = useT();
  const [peers, setPeers] = useState<FallbackPeers>();
  const [peersFailed, setPeersFailed] = useState(false);
  useEffect(() => {
    let valid = true;
    void jget<FallbackPeers>(`/api/wecom/connections/${encodeURIComponent(connectionId)}/fallback-peers`)
      .then(response => {
        if (!valid) return;
        if (response.status !== 200 || !Array.isArray(response.body?.peers)) throw new Error();
        setPeers(response.body);
        setPeersFailed(false);
      })
      .catch(() => {
        if (valid) setPeersFailed(true);
      });
    return () => {
      valid = false;
    };
  }, [connectionId]);
  const q = draft.quotaFallbackBot ?? { enabled: false, kinds: ['usage', 'rate'] as ('usage' | 'rate')[] };
  const update = (next: Partial<NonNullable<WecomNativeCoreConfig['quotaFallbackBot']>>) =>
    field('quotaFallbackBot', { ...q, ...next });
  const name = (peer: { id: string; name?: string }) =>
    peer.name || tr('botDefaults.wecom.core.quotaFallbackUnnamed', { id: peer.id.slice(0, 8) });
  const choices: Array<[string, string]> = [['', tr('botDefaults.wecom.core.quotaFallbackPeerPlaceholder')]];
  for (const peer of peers?.peers ?? []) choices.push([peer.id, name(peer)]);
  const configured = q.peerId;
  const notAccepted = !!configured && !!peers && !peers.peers.some(peer => peer.id === configured);
  if (configured && !choices.some(([choice]) => choice === configured)) {
    const known = peers?.current?.id === configured ? peers.current : { id: configured };
    choices.push([configured, name(known)]);
  }
  return (
    <>
      <NativeToggle
        label={tr('botDefaults.wecom.core.quotaFallback')}
        checked={q.enabled === true}
        onChange={enabled => update({ enabled })}
      />
      <NativeSelect
        label={tr('botDefaults.wecom.core.quotaFallbackPeer')}
        dataInput="wecomQuotaFallbackPeer"
        value={configured ?? ''}
        choices={choices}
        onChange={v => update({ peerId: v || undefined })}
      />
      {peersFailed ? <NativeNote>{tr('botDefaults.wecom.core.quotaFallbackPeersFailed')}</NativeNote> : null}
      {notAccepted ? <p className="bd-section-note" role="status" data-wecom-fallback-untrusted>{tr('botDefaults.wecom.core.quotaFallbackNotAccepted')}</p> : null}
      {peers && !peers.trusting ? <NativeNote>{tr('botDefaults.wecom.core.quotaFallbackNotTrusting')}</NativeNote> : null}
      <NativeChecks
        title={tr('botDefaults.wecom.core.quotaKinds')}
        items={(['usage', 'rate'] as const).map(kind => ({
          key: kind,
          label: kind === 'usage' ? tr('botDefaults.wecom.core.quotaKindUsage') : tr('botDefaults.wecom.core.quotaKindRate'),
          checked: q.kinds.includes(kind),
          onChange: (checked: boolean) => update({
            kinds: checked ? [...new Set([...q.kinds, kind])] : q.kinds.filter(k => k !== kind),
          }),
        }))}
      />
      <NativeField label={tr('botDefaults.wecom.core.quotaFallbackMessage')}>
        <textarea
          rows={3}
          maxLength={2000}
          placeholder={tr('botDefaults.wecom.core.quotaFallbackMessagePlaceholder')}
          value={q.message ?? ''}
          onChange={e => update({ message: e.target.value || undefined })}
        />
      </NativeField>
      <NativeNote>{tr('botDefaults.wecom.core.advancedNote')}</NativeNote>
    </>
  );
}
