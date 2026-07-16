import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openBotOnboarding } from './bot-onboarding.js';
import {
  agentSelectionKey,
  cliIdOf,
  displayCliId,
  fallbackCliOptionsState,
  fetchBotDefaults,
  fetchCliOptions,
  fmtSince,
  modelSuggestionsForOption,
  selectedCliOption,
  type BotDefaultsRow,
  type BotSubstituteMode,
  type BotSubstituteTarget,
  type CliOptionsState,
} from './bot-defaults.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import {
  CreateActionButton,
  DropdownMenu,
  Html,
  InfoTip as BaseInfoTip,
  LoadingState,
  RefreshIconButton,
  dropdownLabel,
} from './dashboard-components.js';
import { botAvatarHtml, loadNameMaps, ui } from './ui.js';

type StatusMessage = { text: string; ok?: boolean } | null;
type PatchBot = (appId: string, patch: Partial<BotDefaultsRow> | ((bot: BotDefaultsRow) => BotDefaultsRow)) => void;
type CardPrefPatch = Record<string, boolean | string>;

type JsonResponse = {
  ok: boolean;
  status: number;
  body: any;
};

type BotProfileRoleItem = {
  profileId: string;
  loaded?: boolean;
  loading?: boolean;
  content?: string | null;
  error?: string;
};

type BotProfileRoleState = {
  loaded: boolean;
  loading: boolean;
  error?: string;
  items: BotProfileRoleItem[];
};

function statusClass(status: StatusMessage, extra = ''): string {
  const suffix = status ? ` ${status.ok ? 'hint-ok' : 'hint-warn-inline'}` : '';
  return `oncall-status${extra ? ` ${extra}` : ''}${suffix}`;
}

function StatusSpan(props: { status: StatusMessage; attr?: Record<string, string> }) {
  return <span className={statusClass(props.status)} {...(props.attr ?? {})}>{props.status?.text ?? ''}</span>;
}

function InfoTip(props: { children: ReactNode }) {
  const ariaLabel = typeof props.children === 'string' ? props.children : undefined;
  return <BaseInfoTip className="bd-info-tip" label={ariaLabel}>{props.children}</BaseInfoTip>;
}

function FieldTitle(props: { children: ReactNode; help?: ReactNode }) {
  return (
    <span className="bd-field-title">
      <span className="bd-field-title-text">{props.children}</span>
      {props.help ? <InfoTip>{props.help}</InfoTip> : null}
    </span>
  );
}

type DropdownFieldOption<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
};

function DropdownField<T extends string>(props: {
  dataInput: string;
  value: T;
  options: DropdownFieldOption<T>[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  onChange(value: T): void;
}) {
  return (
    <>
      <DropdownMenu
        id={`bd-menu-${props.dataInput}`}
        className={['bd-field-menu', props.className].filter(Boolean).join(' ')}
        ariaLabel={props.ariaLabel}
        disabled={props.disabled}
        label={dropdownLabel(props.options, props.value)}
        value={props.value}
        options={props.options}
        onChange={props.onChange}
      />
      <input type="hidden" data-input={props.dataInput} value={props.value} readOnly />
    </>
  );
}

function ToggleRow(props: {
  checked: boolean;
  disabled?: boolean;
  title: ReactNode;
  help: ReactNode;
  dataAction?: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        data-action={props.dataAction}
        checked={props.checked}
        disabled={props.disabled}
        onChange={event => props.onChange(event.currentTarget.checked)}
      />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-tx">
        <strong><FieldTitle help={props.help}>{props.title}</FieldTitle></strong>
      </span>
    </label>
  );
}

async function sendJson(method: string, url: string, body?: unknown): Promise<JsonResponse> {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await r.json().catch(() => ({}));
  return { ok: r.ok && parsed?.ok !== false, status: r.status, body: parsed };
}

function responseErrorText(res: JsonResponse): string {
  const reason = typeof res.body?.reason === 'string' ? res.body.reason : '';
  const manual = typeof res.body?.manualCommand === 'string' ? res.body.manualCommand : '';
  if (reason && manual) return `${reason}（${manual}）`;
  return String(reason || res.body?.error || res.status);
}

function caughtErrorText(e: any): string {
  return e?.message ?? String(e);
}

function positiveIntegerOrNull(raw: string): number | null | 'invalid' {
  const value = raw.trim();
  if (!value) return null;
  if (!/^[1-9]\d*$/.test(value)) return 'invalid';
  return Number(value);
}

function nonNegativeInteger(raw: string, fallback: number): number | null {
  const value = raw.trim();
  if (value === '') return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  return Number(value);
}

type SubstituteTargetIdField = 'email' | 'openId' | 'userId' | 'unionId';

type SubstituteTargetResolution = {
  input?: string;
  ok?: boolean;
  openId?: string;
  name?: string;
};

type SubstituteTargetDraft = {
  key: number;
  idField: SubstituteTargetIdField;
  idValue: string;
  name: string;
  persisted: BotSubstituteTarget;
  originalIdField?: SubstituteTargetIdField;
};

const substituteTargetIdFields: SubstituteTargetIdField[] = ['email', 'openId', 'userId', 'unionId'];

function substituteTargetIdField(target?: BotSubstituteTarget): SubstituteTargetIdField {
  return substituteTargetIdFields.find(field => target?.[field]?.trim()) ?? 'email';
}

/**
 * Build the substitute target to PUT for one edited row. Returns null when the id value is
 * blank. When the id value/field was edited, every carried-over resolved id is dropped so the
 * server re-resolves the new value — otherwise `persisted` keeps a previously-resolved openId
 * alongside the email and the server (which prefers openId) would substitute the stale person.
 * An unchanged row keeps its resolved ids so the stable id is preserved.
 */
export function buildSubstituteTarget(
  row: Pick<SubstituteTargetDraft, 'idField' | 'idValue' | 'name' | 'persisted' | 'originalIdField'>,
): BotSubstituteTarget | null {
  const idValue = row.idValue.trim();
  if (!idValue) return null;
  const target: BotSubstituteTarget = { ...row.persisted };
  const idEdited = row.persisted[row.idField] !== idValue
    || (row.originalIdField != null && row.originalIdField !== row.idField);
  if (idEdited) {
    for (const field of substituteTargetIdFields) delete target[field];
  }
  target[row.idField] = idValue;
  const name = row.name.trim();
  if (name) target.name = name;
  else delete target.name;
  return target;
}

function brandStateLabel(brand: string | null, tr: ReturnType<typeof useT>): string {
  if (brand == null) return tr('botDefaults.brandStateDefault');
  return brand.trim() === '' ? tr('botDefaults.brandStateOff') : tr('botDefaults.brandStateCustom');
}

function quotaStateLabel(quota: number | null, tr: ReturnType<typeof useT>): string {
  return quota == null
    ? tr('botDefaults.quotaStateOff')
    : tr('botDefaults.quotaStateOn', { count: quota });
}

function sessionCapStateLabel(cap: number | null, tr: ReturnType<typeof useT>): string {
  return cap == null
    ? tr('botDefaults.maxLiveWorkersStateDefault')
    : tr('botDefaults.maxLiveWorkersStateOn', { count: cap });
}

function patchCardPrefsFromBody(bot: BotDefaultsRow, body: any): BotDefaultsRow {
  return {
    ...bot,
    disableStreamingCard: body.disableStreamingCard,
    silentTurnReactions: body.silentTurnReactions,
    codexAppCleanInput: body.codexAppCleanInput,
    writableTerminalLinkInCard: body.writableTerminalLinkInCard,
    privateCard: body.privateCard,
    botToBotSameDir: body.botToBotSameDir,
    autoStartOnGroupJoin: body.autoStartOnGroupJoin,
    autoStartOnGroupJoinPrompt: body.autoStartOnGroupJoinPrompt,
    autoStartOnNewTopic: body.autoStartOnNewTopic,
    regularGroupReplyMode: body.regularGroupReplyMode,
    regularGroupMentionMode: body.regularGroupMentionMode,
    docSubscribeDefaultMode: body.docSubscribeDefaultMode,
  };
}

function BotDefaultsPage() {
  const tr = useT();
  const mountedRef = useRef(true);
  const [bots, setBots] = useState<BotDefaultsRow[]>([]);
  const [cliState, setCliState] = useState<CliOptionsState>(fallbackCliOptionsState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [profileRoleVersion, setProfileRoleVersion] = useState(0);
  const [, setAvatarVersion] = useState(0);
  const [onboardingBusy, setOnboardingBusy] = useState(false);

  const refresh = useCallback(async (clearProfileRoles = false) => {
    if (clearProfileRoles) setProfileRoleVersion(version => version + 1);
    setLoading(true);
    try {
      const [nextBots, nextCli] = await Promise.all([fetchBotDefaults(), fetchCliOptions()]);
      if (!mountedRef.current) return;
      setBots(nextBots.bots);
      setLoadError(nextBots.error);
      setCliState(nextCli);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    void loadNameMaps().then(() => {
      if (mountedRef.current) setAvatarVersion(value => value + 1);
    });
    return () => { mountedRef.current = false; };
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bots.filter(bot =>
      !q ||
      (bot.botName ?? '').toLowerCase().includes(q) ||
      (bot.larkAppId ?? '').toLowerCase().includes(q),
    );
  }, [bots, query]);

  useEffect(() => {
    if (loadError || loading) return;
    if (filtered.length === 0) {
      if (selectedAppId !== null) setSelectedAppId(null);
      return;
    }
    if (!selectedAppId || !filtered.some(bot => bot.larkAppId === selectedAppId)) {
      setSelectedAppId(filtered[0].larkAppId);
    }
  }, [filtered, loadError, loading, selectedAppId]);

  const selectedBot = selectedAppId ? filtered.find(bot => bot.larkAppId === selectedAppId) ?? null : null;

  const patchBot = useCallback<PatchBot>((appId, patch) => {
    setBots(rows => rows.map(bot => {
      if (bot.larkAppId !== appId) return bot;
      return typeof patch === 'function' ? patch(bot) : { ...bot, ...patch };
    }));
  }, []);

  const reload = async () => {
    setRefreshing(true);
    try {
      await refresh(true);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  let detail: ReactNode;
  if (loading) {
    detail = <LoadingState label={tr('common.loading')} />;
  } else if (loadError) {
    detail = (
      <p className="hint-warn">
        无法加载 bot 列表：{loadError}<br />
        常见原因：dashboard / daemon 进程还在跑旧代码，执行 <code>botmux restart</code> 后刷新。
      </p>
    );
  } else if (filtered.length === 0) {
    detail = <p className="empty">{tr('botDefaults.empty')}</p>;
  } else if (selectedBot) {
    detail = (
      <BotDefaultsCard
        key={`${selectedBot.larkAppId}:${profileRoleVersion}`}
        bot={selectedBot}
        cliState={cliState}
        patchBot={patchBot}
      />
    );
  } else {
    detail = null;
  }

  return (
    <section className="page bot-defaults-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.botDefaults')}</p>
          <h1>{tr('botDefaults.title')}</h1>
        </div>
        <div className="page-heading-actions">
          <RefreshIconButton id="bd-refresh" label={tr('botDefaults.refresh')} busy={refreshing} disabled={refreshing} onClick={() => void reload()} />
          {ui.authed ? (
            <CreateActionButton
              className="page-primary-action add-bot-btn"
              disabled={onboardingBusy}
              onClick={() => {
                setOnboardingBusy(true);
                void openBotOnboarding().finally(() => setOnboardingBusy(false));
              }}
            >
              {tr('botOnboarding.add')}
            </CreateActionButton>
          ) : null}
        </div>
      </div>
      <div className="bd-layout">
        <aside id="bd-roster" className="bd-roster">
          <form id="bd-filters" className="filters dashboard-toolbar" onSubmit={event => event.preventDefault()}>
            <input
              type="search"
              name="q"
              placeholder={tr('botDefaults.search')}
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
            />
          </form>
          <div className="bd-roster-list">
            {!loadError && filtered.map(bot => (
              <RosterItem
                key={bot.larkAppId}
                bot={bot}
                selected={bot.larkAppId === selectedAppId}
                onSelect={() => setSelectedAppId(bot.larkAppId)}
              />
            ))}
          </div>
        </aside>
        <div id="bd-list" className="bd-detail">{detail}</div>
      </div>
    </section>
  );
}

function RosterItem(props: { bot: BotDefaultsRow; selected: boolean; onSelect(): void }) {
  const { bot } = props;
  const name = bot.botName ?? bot.larkAppId;
  const cli = displayCliId(bot, cliIdOf(bot.larkAppId));
  return (
    <div
      className={`bd-roster-item${props.selected ? ' on' : ''}`}
      data-appid={bot.larkAppId}
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onSelect();
        }
      }}
    >
      <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId, size: 'sm' })} />
      <div className="bd-roster-tx">
        <b>{name}</b>
        <span>{cli || bot.larkAppId.slice(0, 14)}</span>
      </div>
      {bot.defaultOncall?.enabled ? <span className="bd-roster-flag">oncall</span> : null}
    </div>
  );
}

function BotDefaultsCard(props: { bot: BotDefaultsRow; cliState: CliOptionsState; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, cliState, patchBot } = props;
  const name = bot.botName ?? bot.larkAppId;
  const cli = displayCliId(bot, cliIdOf(bot.larkAppId));

  const putCardPref = useCallback(async (patch: CardPrefPatch): Promise<JsonResponse> => {
    const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/card-prefs`, patch);
    if (res.ok) {
      patchBot(bot.larkAppId, current => patchCardPrefsFromBody(current, res.body));
    }
    return res;
  }, [bot.larkAppId, patchBot]);

  if (bot.error) {
    return (
      <article className="bd-card bd-profile" data-appid={bot.larkAppId}>
        <header className="bd-profile-head">
          <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId })} />
          <div className="bd-profile-id">
            <strong>{name}</strong>
            <code>{bot.larkAppId}</code>
          </div>
        </header>
        <p className="hint-warn-inline">查询失败：{bot.error}</p>
      </article>
    );
  }

  const def = bot.defaultOncall ?? { enabled: false, workingDir: '', since: 0 };

  return (
    <article className="bd-card bd-profile" data-appid={bot.larkAppId}>
      <header className="bd-profile-head">
        <div className="bd-profile-avatar">
          <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId, dot: 'ok' })} />
        </div>
        <div className="bd-profile-main">
          <BotProfileIdentity
            bot={bot}
            cli={cli}
            patchBot={patchBot}
            meta={(
              <>
                <small className="bd-meta-ok">● {tr('botDefaults.metaOnline')}</small>
                <small data-oncall-since>{tr('botDefaults.lastEnabled')}: {fmtSince(def.since ?? 0)}</small>
                <small>{tr('botDefaults.autobound', { count: bot.autoboundChatCount ?? 0 })}</small>
              </>
            )}
          />
        </div>
      </header>
      <div className="bd-body bd-grid">
        <div className="bd-column">
          <section className="bd-tile">
            <BotAgentSection bot={bot} sessionFallback={cli} cliState={cliState} patchBot={patchBot} />
            <WorkingDirSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
            {/* riff 在远端沙箱执行、本地无 CLI 进程，文件沙盒对它无意义（worker 侧已旁路）。 */}
            {bot.cliId !== 'riff' && <SandboxSection bot={bot} patchBot={patchBot} />}
            {/* riff：backendType 与 CLI 选择 1:1 绑定（spawn 层强制配对），
                手动切 pty/tmux 只会制造坏组合，隐藏该区块。 */}
            {bot.cliId !== 'riff' && <BackendTypeSection bot={bot} patchBot={patchBot} />}
          </section>
          <section className="bd-tile">
            <RuntimeEnvironmentSection bot={bot} patchBot={patchBot} />
          </section>
          <section className="bd-tile"><GrantSection bot={bot} patchBot={patchBot} /></section>
        </div>
        <div className="bd-column">
          <section className="bd-tile">
            <SessionModeSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
            <SubstituteModeSection bot={bot} patchBot={patchBot} />
            <CrossBotSection bot={bot} putCardPref={putCardPref} />
            <SessionCapSection bot={bot} patchBot={patchBot} />
          </section>
          <section className="bd-tile">
            <CardBehaviorSection bot={bot} putCardPref={putCardPref} />
            <CodexAppDisplaySection bot={bot} putCardPref={putCardPref} />
            <SummaryTriggerSection bot={bot} patchBot={patchBot} />
            <BrandSection bot={bot} patchBot={patchBot} />
          </section>
          <section className="bd-tile"><RoleSection bot={bot} patchBot={patchBot} /></section>
        </div>
      </div>
    </article>
  );
}

function RuntimeEnvironmentSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  return (
    <section className="bd-section bd-runtime-env">
      <h3 className="bd-section-title">{tr('botDefaults.sectionRuntimeEnv')}</h3>
      <StartupCommandsSection bot={props.bot} patchBot={props.patchBot} />
      <LaunchShellSection bot={props.bot} patchBot={props.patchBot} />
      <EnvSection bot={props.bot} patchBot={props.patchBot} />
    </section>
  );
}

function BotProfileIdentity(props: { bot: BotDefaultsRow; cli: string; patchBot: PatchBot; meta?: ReactNode }) {
  const tr = useT();
  const { bot, cli, patchBot } = props;
  const name = bot.botName ?? bot.larkAppId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

  function setEditMode(on: boolean): void {
    setEditing(on);
    if (on) {
      setDraft(name);
      setStatus(null);
      setLoginVisible(false);
    }
  }

  function renameWarningText(warning: string, message?: string): string {
    const known = ['no_session', 'session_expired', 'no_access', 'unsupported_brand'];
    const detail = known.includes(warning)
      ? tr(`botDefaults.renameWarn.${warning}`)
      : (message || warning);
    return tr('botDefaults.renameLocalOnly', { reason: detail });
  }

  const submitRename = useCallback(async () => {
    const nextName = draft.trim();
    if (!nextName) {
      setStatus({ text: `✗ ${tr('botDefaults.renameEmpty')}` });
      return;
    }
    setBusy(true);
    setStatus({ text: `⏳ ${tr('botDefaults.renaming')}`, ok: true });
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/rename`, { name: nextName });
      if (res.ok && res.body.ok) {
        const effective = typeof res.body.botName === 'string' && res.body.botName ? res.body.botName : nextName;
        patchBot(bot.larkAppId, current => ({
          ...current,
          botName: effective,
          larkBotName: res.body.mode === 'feishu' ? nextName : current.larkBotName,
          displayName: res.body.mode === 'feishu' ? null : nextName,
        }));
        setEditMode(false);
        if (res.body.mode === 'feishu') {
          setStatus({ text: `✓ ${tr('botDefaults.renameOkFeishu')}`, ok: true });
          setLoginVisible(false);
        } else {
          setStatus({ text: `⚠ ${renameWarningText(String(res.body.warning ?? ''), res.body.message)}` });
          setLoginVisible(res.body.warning === 'no_session' || res.body.warning === 'session_expired');
        }
      } else {
        setStatus({ text: `✗ ${tr('botDefaults.renameFailed', { error: responseErrorText(res) })}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${tr('botDefaults.renameFailed', { error: caughtErrorText(e) })}` });
    } finally {
      setBusy(false);
    }
  }, [bot.larkAppId, draft, patchBot, tr]);

  return (
    <div className="bd-profile-id">
      {!editing ? (
        <div className="bd-profile-title-row" data-name-row>
          <div className="bd-profile-title-content">
            <strong data-bot-name>{name}</strong>
            {cli ? <span className="mate-role bd-profile-cli-tag">{cli}</span> : null}
            {props.meta ? <span className="bd-profile-meta bd-meta">{props.meta}</span> : null}
          </div>
          <button
            type="button"
            className="bd-name-edit"
            data-action="edit-bot-name"
            title={tr('botDefaults.renameTitle')}
            aria-label={tr('botDefaults.renameTitle')}
            onClick={() => setEditMode(true)}
          >
            {tr('botDefaults.renameAction')}
          </button>
        </div>
      ) : (
        <span className="bd-name-editor" data-name-editor>
          <input
            type="text"
            className="bd-name-input"
            data-input="botRename"
            maxLength={64}
            value={draft}
            disabled={busy}
            autoFocus
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitRename();
              } else if (event.key === 'Escape') {
                setEditMode(false);
              }
            }}
          />
          <button type="button" className="primary" data-action="save-bot-name" disabled={busy} onClick={() => void submitRename()}>{tr('botDefaults.renameSave')}</button>
          <button type="button" data-action="cancel-bot-name" disabled={busy} onClick={() => setEditMode(false)}>{tr('botDefaults.renameCancel')}</button>
        </span>
      )}
      <code>{bot.larkAppId}</code>
      <small className={statusClass(status, 'bd-name-status')} data-name-status>{status?.text ?? ''}</small>
      <button type="button" className="bd-feishu-login" data-action="feishu-login" hidden={!loginVisible} onClick={() => setLoginOpen(true)}>{tr('feishuLogin.entry')}</button>
      {loginOpen ? (
        <FeishuLoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            setLoginVisible(false);
            setLoginOpen(false);
            void submitRename();
          }}
        />
      ) : null}
    </div>
  );
}

function FeishuLoginModal(props: { onClose(): void; onSuccess(): void }) {
  const tr = useT();
  const { onClose, onSuccess } = props;
  const timerRef = useRef<number | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const [hint, setHint] = useState(tr('feishuLogin.starting'));
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const renderLogin = useCallback((login: any): 'active' | 'done' => {
    if (!login) return 'active';
    if (login.status === 'awaiting_scan' && login.qrDataUrl) {
      setQrDataUrl(login.qrDataUrl);
      setHint(login.message || tr('feishuLogin.scanHint'));
      setRetry(false);
      return 'active';
    }
    if (login.status === 'starting') {
      setHint(login.message || tr('feishuLogin.starting'));
      setQrDataUrl(null);
      setRetry(false);
      return 'active';
    }
    if (login.status === 'success') {
      stopTimer();
      setQrDataUrl(null);
      setRetry(false);
      setHint(tr('feishuLogin.success'));
      successTimerRef.current = window.setTimeout(() => onSuccess(), 900);
      return 'done';
    }
    stopTimer();
    setQrDataUrl(null);
    setHint(tr('feishuLogin.failed', { reason: login.message || login.reason || '' }));
    setRetry(true);
    return 'done';
  }, [onSuccess, stopTimer, tr]);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/feishu-login/status');
      const body = await r.json().catch(() => ({}));
      renderLogin(body.login);
    } catch {
      // transient; keep polling
    }
  }, [renderLogin]);

  const begin = useCallback(async () => {
    stopTimer();
    setHint(tr('feishuLogin.starting'));
    setQrDataUrl(null);
    setRetry(false);
    let phase: 'active' | 'done' = 'active';
    try {
      const r = await fetch('/api/feishu-login/start', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      phase = renderLogin(body.login);
    } catch (e: any) {
      setHint(tr('feishuLogin.failed', { reason: caughtErrorText(e) }));
      setRetry(true);
      return;
    }
    if (phase === 'active' && timerRef.current === null) {
      timerRef.current = window.setInterval(() => void poll(), 1500);
    }
  }, [poll, renderLogin, stopTimer, tr]);

  useEffect(() => {
    void begin();
    return () => {
      stopTimer();
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    };
  }, [begin, stopTimer]);

  return (
    <div
      className="feishu-login-overlay"
      onClick={event => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="feishu-login-modal" role="dialog" aria-modal="true">
        <button type="button" className="feishu-login-close" data-close aria-label={tr('feishuLogin.close')} onClick={onClose}>x</button>
        <h3 className="feishu-login-title">{tr('feishuLogin.title')}</h3>
        <p className="feishu-login-hint" data-hint>{hint}</p>
        <div className="feishu-login-qr" data-qr>
          {qrDataUrl ? <img className="qr-image" src={qrDataUrl} alt={tr('feishuLogin.qrAlt')} /> : null}
        </div>
        <div className="feishu-login-actions">
          <button type="button" className="primary" data-retry hidden={!retry} onClick={() => void begin()}>{tr('feishuLogin.retry')}</button>
        </div>
      </div>
    </div>
  );
}

export function BotAgentSection(props: {
  bot: BotDefaultsRow;
  sessionFallback: string;
  cliState: CliOptionsState;
  patchBot: PatchBot;
}) {
  const tr = useT();
  const { bot, cliState, patchBot } = props;
  const initialKey = agentSelectionKey(bot, props.sessionFallback);
  const [cliKey, setCliKey] = useState(initialKey);
  const [model, setModel] = useState(typeof bot.model === 'string' ? bot.model : '');
  const [agentStatus, setAgentStatus] = useState<StatusMessage>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [skillValue, setSkillValue] = useState(skillInjectionResolved(bot));
  const [skillStatus, setSkillStatus] = useState<StatusMessage>(null);
  const [skillBusy, setSkillBusy] = useState(false);

  useEffect(() => {
    setCliKey(agentSelectionKey(bot, props.sessionFallback));
    setModel(typeof bot.model === 'string' ? bot.model : '');
    setSkillValue(skillInjectionResolved(bot));
  }, [
    bot.agentSelectionKey,
    bot.cliId,
    bot.larkAppId,
    bot.model,
    bot.skillInjection,
    bot.skillInjectionDefault,
    props.sessionFallback,
  ]);

  const option = selectedCliOption(cliState.options, cliKey);
  const suggestions = modelSuggestionsForOption(option, cliState);
  const modelDisabledByCli = option?.gateway === 'ttadk' && option.acceptsModel === false;
  const modelPlaceholder = modelDisabledByCli
    ? tr('botOnboarding.modelTtadkCocoPlaceholder')
    : option?.gateway === 'ttadk'
      ? tr('botOnboarding.modelTtadkPlaceholder').replace('{model}', cliState.ttadkModelDefault)
      : tr('botDefaults.agentModelPlaceholder');

  function updateCli(nextKey: string): void {
    setCliKey(nextKey);
    const nextOption = selectedCliOption(cliState.options, nextKey);
    const isTtadk = nextOption?.gateway === 'ttadk';
    const acceptsModel = isTtadk && nextOption.acceptsModel !== false;
    if (isTtadk && !acceptsModel) {
      setModel('');
    } else if (acceptsModel) {
      setModel(current => current.trim() ? current : cliState.ttadkModelDefault);
    } else {
      setModel(current => current.trim() === cliState.ttadkModelDefault ? '' : current);
    }
  }

  async function saveAgent(): Promise<void> {
    setAgentStatus(null);
    setAgentBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/agent`, { cliId: cliKey, model });
      if (res.ok && res.body.ok) {
        setAgentStatus(res.body.availabilityWarning
          ? { text: `⚠️ ${res.body.availabilityWarning}` }
          : { text: `✓ ${tr('botDefaults.agentSaved')}`, ok: true });
        patchBot(bot.larkAppId, {
          cliId: res.body.cliId,
          wrapperCli: res.body.wrapperCli ?? null,
          model: res.body.model ?? '',
          agentSelectionKey: res.body.selectionKey ?? cliKey,
        });
      } else {
        setAgentStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setAgentStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setAgentBusy(false);
    }
  }

  /**
   * Persist the CLI selection as riff before saving riff config. Selecting
   * riff in the dropdown hides the「保存 Agent」button (model/skill rows are
   * replaced by RiffSection), so without this the cliId change would never
   * reach PUT /agent — the bot would stay on its old CLI and backendType
   * would never auto-flip to riff. Returns false when persisting failed.
   */
  async function persistRiffCliSelection(): Promise<boolean> {
    if (bot.cliId === 'riff') return true; // already persisted
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/agent`, { cliId: 'riff', model: '' });
      if (res.ok && res.body.ok) {
        patchBot(bot.larkAppId, {
          cliId: res.body.cliId,
          wrapperCli: res.body.wrapperCli ?? null,
          model: res.body.model ?? '',
          agentSelectionKey: res.body.selectionKey ?? 'riff',
        });
        return true;
      }
      setAgentStatus({ text: `✗ ${responseErrorText(res)}` });
      return false;
    } catch (e: any) {
      setAgentStatus({ text: `✗ ${caughtErrorText(e)}` });
      return false;
    }
  }

  async function saveSkillInjection(next: string): Promise<void> {
    setSkillValue(next);
    setSkillStatus(null);
    setSkillBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/skill-injection`, { skillInjection: next });
      if (res.ok && res.body.ok) {
        setSkillStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
        patchBot(bot.larkAppId, { skillInjection: res.body.skillInjection ?? null });
      } else {
        setSkillStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setSkillStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setSkillBusy(false);
    }
  }

  const siSupport = bot.skillInjectionSupport === 'dynamic' ? 'dynamic' : bot.skillInjectionSupport === 'global' ? 'global' : 'none';
  const cliOptions = cliState.options.map(option => ({
    value: option.id,
    label: option.available === false
      ? tr('botDefaults.agentMissingOption', { label: option.label, command: option.command ?? option.id })
      : `${option.label}（${option.id}）`,
  }));
  const dynamicSkillOptions = [
    { value: 'dynamic', label: tr('botDefaults.skillInjectionDynamic') },
  ];
  const skillOptions = [
    // Non-selectable cue: dynamic injection isn't available for this CLI (parity with the old UI).
    { value: 'dynamic', label: tr('botDefaults.skillInjectionDynamicUnsupported'), disabled: true },
    { value: 'prompt', label: tr('botDefaults.skillInjectionPrompt') },
    { value: 'global', label: tr('botDefaults.skillInjectionGlobal') },
    { value: 'off', label: tr('botDefaults.skillInjectionOff') },
  ];

  const isRiff = cliKey === 'riff';

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionAgent')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <span>{tr('botDefaults.agentCli')}</span>
          <DropdownField
            dataInput="agentCliId"
            ariaLabel={tr('botDefaults.agentCli')}
            value={cliKey}
            disabled={agentBusy}
            options={cliOptions}
            onChange={updateCli}
          />
          {option?.available === false ? (
            <small className="hint-warn">
              {tr('botDefaults.agentMissingHint', { command: option.command ?? cliKey })}
            </small>
          ) : null}
        </div>
      </div>
      {!isRiff && (
        <div className="bd-row">
          <label>
            <FieldTitle help={tr('botDefaults.agentHelp')}>{tr('botDefaults.agentModel')}</FieldTitle>
            <input
              type="text"
              data-input="agentModel"
              list={`agent-model-suggestions-${bot.larkAppId}`}
              placeholder={modelPlaceholder}
              value={model}
              disabled={agentBusy || modelDisabledByCli}
              onChange={event => setModel(event.currentTarget.value)}
            />
            <datalist id={`agent-model-suggestions-${bot.larkAppId}`}>
              {suggestions.map(item => <option value={item} key={item} />)}
            </datalist>
          </label>
        </div>
      )}
      {isRiff && <RiffSection bot={bot} patchBot={patchBot} persistCliSelection={persistRiffCliSelection} />}
      {!isRiff && siSupport === 'dynamic' ? (
        <div className="bd-row">
          <div className="bd-field">
            <FieldTitle help={tr('botDefaults.skillInjectionHelpDynamic')}>{tr('botDefaults.skillInjection')}</FieldTitle>
            <DropdownField
              dataInput="skillInjection"
              ariaLabel={tr('botDefaults.skillInjection')}
              value="dynamic"
              disabled
              options={dynamicSkillOptions}
              onChange={() => undefined}
            />
          </div>
        </div>
      ) : !isRiff && siSupport === 'global' ? (
        <div className="bd-row">
          <div className="bd-field">
            <FieldTitle help={tr('botDefaults.skillInjectionHelp')}>{tr('botDefaults.skillInjection')}</FieldTitle>
            <DropdownField
              dataInput="skillInjection"
              ariaLabel={tr('botDefaults.skillInjection')}
              value={skillValue}
              disabled={skillBusy}
              options={skillOptions}
              onChange={next => void saveSkillInjection(next)}
            />
          </div>
          <div className="actions">
            <StatusSpan status={skillStatus} attr={{ 'data-skill-injection-status': '' }} />
          </div>
        </div>
      ) : null}
      {!isRiff && (
        <div className="actions bd-section-actions">
          <button type="button" className="primary" data-action="save-agent" disabled={agentBusy} onClick={() => void saveAgent()}>{tr('botDefaults.agentSave')}</button>
          <StatusSpan status={agentStatus} attr={{ 'data-agent-status': '' }} />
        </div>
      )}
    </section>
  );
}

function skillInjectionResolved(bot: BotDefaultsRow): string {
  const override = bot.skillInjection === 'global' || bot.skillInjection === 'prompt' || bot.skillInjection === 'off' ? bot.skillInjection : '';
  const def = bot.skillInjectionDefault === 'global' || bot.skillInjectionDefault === 'off' ? bot.skillInjectionDefault : 'prompt';
  return override || def;
}

function WorkingDirSection(props: {
  bot: BotDefaultsRow;
  patchBot: PatchBot;
  putCardPref(patch: CardPrefPatch): Promise<JsonResponse>;
}) {
  const tr = useT();
  const { bot, patchBot } = props;
  const initial = workingDirState(bot);
  const [mode, setMode] = useState(initial.mode);
  const [workingDir, setWorkingDir] = useState(initial.workingDir);
  const [autoWorktree, setAutoWorktree] = useState(bot.defaultWorkingDirAutoWorktree === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = workingDirState(bot);
    setMode(next.mode);
    setWorkingDir(next.workingDir);
    setAutoWorktree(bot.defaultWorkingDirAutoWorktree === true);
  }, [
    bot.defaultOncall?.enabled,
    bot.defaultOncall?.workingDir,
    bot.defaultWorkingDir,
    bot.defaultWorkingDirAutoWorktree,
  ]);

  async function save(): Promise<void> {
    setStatus(null);
    const dir = workingDir.trim();
    if (mode !== 'off' && !dir) {
      setStatus({ text: tr('botDefaults.required') });
      return;
    }
    const nextAutoWorktree = mode === 'default' && autoWorktree;
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/working-dir-mode`, {
        mode,
        workingDir: dir,
        autoWorktree: nextAutoWorktree,
      });
      if (res.ok && res.body.ok) {
        const resolvedNote = res.body.resolvedPath ? ` → ${res.body.resolvedPath}` : '';
        setStatus({ text: `✓ ${tr('botDefaults.workingDirSaved')}${resolvedNote}`, ok: true });
        patchBot(bot.larkAppId, {
          defaultOncall: res.body.defaultOncall ?? bot.defaultOncall,
          defaultWorkingDir: res.body.defaultWorkingDir ?? null,
          defaultWorkingDirAutoWorktree: res.body.defaultWorkingDirAutoWorktree === true,
        });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const modeOptions: DropdownFieldOption<'off' | 'default' | 'oncall'>[] = [
    { value: 'off', label: tr('botDefaults.workingDirModeOff') },
    { value: 'default', label: tr('botDefaults.workingDirModeDefault') },
    { value: 'oncall', label: tr('botDefaults.workingDirModeOncall') },
  ];

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionWorkingDir')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.workingDirModeHelp')}>{tr('botDefaults.workingDirMode')}</FieldTitle>
          <DropdownField
            dataInput="workingDirMode"
            ariaLabel={tr('botDefaults.workingDirMode')}
            value={mode}
            disabled={busy}
            options={modeOptions}
            onChange={next => setMode(next as 'off' | 'default' | 'oncall')}
          />
        </div>
      </div>
      <div className="bd-row" data-wd-dir-row hidden={mode === 'off'}>
        <label>
          <span>{tr('botDefaults.workingDirField')}</span>
          <input type="text" data-input="workingDir" placeholder="e.g. /root/iserver/botmux" value={workingDir} disabled={busy} onChange={event => setWorkingDir(event.currentTarget.value)} />
        </label>
      </div>
      <label className="toggle-row" data-wd-worktree-row hidden={mode !== 'default'}>
        <input type="checkbox" data-input="autoWorktree" checked={autoWorktree} disabled={busy} onChange={event => setAutoWorktree(event.currentTarget.checked)} />
        <span className="switch" aria-hidden="true" />
        <span className="toggle-tx"><strong><FieldTitle help={tr('botDefaults.autoWorktreeHelp')}>{tr('botDefaults.autoWorktree')}</FieldTitle></strong></span>
      </label>
      <div className="actions">
        <button type="button" className="primary" data-action="save-working-dir" disabled={busy} onClick={() => void save()}>{tr('botDefaults.save')}</button>
        <StatusSpan status={status} attr={{ 'data-status': '' }} />
      </div>
      <AutoStartControls bot={bot} putCardPref={props.putCardPref} />
    </section>
  );
}

function workingDirState(bot: BotDefaultsRow): { mode: 'off' | 'default' | 'oncall'; workingDir: string } {
  const def = bot.defaultOncall ?? { enabled: false, workingDir: '' };
  const mode = def.enabled ? 'oncall' : (bot.defaultWorkingDir ? 'default' : 'off');
  return { mode, workingDir: bot.defaultWorkingDir || def.workingDir || '' };
}

function AutoStartControls(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const { bot, putCardPref } = props;
  const [onJoin, setOnJoin] = useState(bot.autoStartOnGroupJoin === true);
  const [onTopic, setOnTopic] = useState(bot.autoStartOnNewTopic === true);
  const [prompt, setPrompt] = useState(typeof bot.autoStartOnGroupJoinPrompt === 'string' ? bot.autoStartOnGroupJoinPrompt : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setOnJoin(bot.autoStartOnGroupJoin === true);
    setOnTopic(bot.autoStartOnNewTopic === true);
    setPrompt(typeof bot.autoStartOnGroupJoinPrompt === 'string' ? bot.autoStartOnGroupJoinPrompt : '');
  }, [bot.autoStartOnGroupJoin, bot.autoStartOnGroupJoinPrompt, bot.autoStartOnNewTopic]);

  async function savePatch(patch: CardPrefPatch, key: string): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await putCardPref(patch);
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title">{tr('botDefaults.sectionAutoStart')}</h4>
      <ToggleRow
        checked={onJoin}
        disabled={busy === 'join'}
        dataAction="toggle-auto-join"
        title={tr('botDefaults.autoStartJoin')}
        help={tr('botDefaults.autoStartJoinHelp')}
        onChange={checked => {
          setOnJoin(checked);
          void savePatch({ autoStartOnGroupJoin: checked }, 'join');
        }}
      />
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.autoStartJoinPrompt')}</span>
          <textarea data-input="autoJoinPrompt" rows={3} placeholder={tr('botDefaults.autoStartJoinPromptPlaceholder')} value={prompt} onChange={event => setPrompt(event.currentTarget.value)} />
        </label>
      </div>
      <ToggleRow
        checked={onTopic}
        disabled={busy === 'topic'}
        dataAction="toggle-auto-topic"
        title={tr('botDefaults.autoStartTopic')}
        help={tr('botDefaults.autoStartTopicHelp')}
        onChange={checked => {
          setOnTopic(checked);
          void savePatch({ autoStartOnNewTopic: checked }, 'topic');
        }}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-auto-join-prompt" disabled={busy === 'prompt'} onClick={() => void savePatch({ autoStartOnGroupJoinPrompt: prompt }, 'prompt')}>
          {tr('botDefaults.autoStartJoinPromptSave')}
        </button>
        <StatusSpan status={status} attr={{ 'data-auto-start-status': '' }} />
      </div>
    </div>
  );
}

function SandboxSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [enabled, setEnabled] = useState(bot.sandbox === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setEnabled(bot.sandbox === true), [bot.sandbox]);

  async function toggle(next: boolean): Promise<void> {
    setEnabled(next);
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/sandbox`, { enabled: next });
      if (res.ok && res.body.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.sandboxSaved')}`, ok: true });
        patchBot(bot.larkAppId, { sandbox: res.body.sandbox === true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
        setEnabled(!next);
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  }

  // Read isolation rides the SAME toggle: it applies additionally wherever the
  // CLI + platform can enforce it (claude/codex on macOS/Linux, no wrapper). Show a
  // capability line so the owner sees whether THIS bot's sandbox also read-isolates
  // (the "labelled separately" requirement) — best-effort: write protection always
  // applies; read isolation only where supported.
  const readIsoSupported = bot.readIsolationSupported === true;
  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSandbox')}</h3>
      <ToggleRow
        checked={enabled}
        disabled={busy}
        dataAction="toggle-sandbox"
        title={tr('botDefaults.sandboxToggle')}
        help={tr('botDefaults.sandboxHelp')}
        onChange={checked => void toggle(checked)}
      />
      <p className="bd-section-note" data-read-iso-capability={readIsoSupported ? 'yes' : 'no'}>
        {readIsoSupported ? `＋ ${tr('botDefaults.sandboxReadIsoOn')}` : tr('botDefaults.sandboxReadIsoOff')}
      </p>
      <div className="actions">
        <StatusSpan status={status} attr={{ 'data-sandbox-status': '' }} />
      </div>
    </section>
  );
}

const BACKEND_TYPE_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: '', labelKey: 'botDefaults.backendAuto' },
  { value: 'tmux', labelKey: 'botDefaults.backendTmux' },
  { value: 'herdr', labelKey: 'botDefaults.backendHerdr' },
  { value: 'zellij', labelKey: 'botDefaults.backendZellij' },
  { value: 'pty', labelKey: 'botDefaults.backendPty' },
];

function BackendTypeSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [value, setValue] = useState(typeof bot.backendType === 'string' ? bot.backendType : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof bot.backendType === 'string' ? bot.backendType : ''), [bot.backendType]);

  const options = useMemo(() => BACKEND_TYPE_OPTIONS.map(o => ({ value: o.value, label: tr(o.labelKey) })), [tr]);

  async function save(next: string): Promise<void> {
    const prev = value;
    setValue(next);
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/backend-type`, { backendType: next });
      if (res.ok && res.body.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.backendSaved')}`, ok: true });
        patchBot(bot.larkAppId, { backendType: typeof res.body.backendType === 'string' ? res.body.backendType : null });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
        setValue(prev);  // revert optimistic selection
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
      setValue(prev);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionBackend')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.backendHelp')}>{tr('botDefaults.backendLabel')}</FieldTitle>
          <DropdownField
            dataInput="backendType"
            ariaLabel={tr('botDefaults.backendLabel')}
            value={value}
            disabled={busy}
            options={options}
            onChange={next => void save(next)}
          />
        </div>
        <div className="actions">
          <StatusSpan status={status} attr={{ 'data-backend-status': '' }} />
        </div>
      </div>
    </section>
  );
}

function RoleSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [loaded, setLoaded] = useState(typeof bot.teamRole === 'string');
  const [role, setRole] = useState(typeof bot.teamRole === 'string' ? bot.teamRole : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const roleUrl = `/api/team/local-bots/${encodeURIComponent(bot.larkAppId)}/role`;
    if (typeof bot.teamRole === 'string') {
      // Already resolved (incl. right after our own save, which patchBot's teamRole
      // re-fires this effect) — sync the field but DON'T clear status, or the freshly
      // set "✓ 已保存/已删除" toast gets wiped a frame later.
      setLoaded(true);
      setRole(bot.teamRole);
      return () => { active = false; };
    }
    setStatus(null);
    setLoaded(false);
    setRole('');
    void (async () => {
      try {
        const r = await fetch(roleUrl);
        const body = await r.json().catch(() => ({}));
        if (!active) return;
        if (r.ok && body.ok) {
          const next = body.role ?? '';
          setRole(next);
          setLoaded(true);
          patchBot(bot.larkAppId, { teamRole: next });
        } else {
          setStatus({ text: `✗ ${tr('botDefaults.roleLoadErr')}: ${body.error ?? r.status}` });
        }
      } catch (e: any) {
        if (active) setStatus({ text: `✗ ${tr('botDefaults.roleLoadErr')}: ${caughtErrorText(e)}` });
      }
    })();
    return () => { active = false; };
  }, [bot.larkAppId, bot.teamRole, patchBot, tr]);

  async function putRole(nextRole: string, deleted: boolean): Promise<void> {
    if (!loaded) return;
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/team/local-bots/${encodeURIComponent(bot.larkAppId)}/role`, { role: nextRole });
      if (res.ok && res.body.ok) {
        const stored = nextRole.trim();
        setRole(stored);
        patchBot(bot.larkAppId, { teamRole: stored });
        setStatus({ text: `✓ ${deleted ? tr('botDefaults.roleDeleted') : tr('botDefaults.roleSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title"><FieldTitle help={tr('botDefaults.roleHelp')}>{tr('botDefaults.sectionRole')}</FieldTitle></h3>
      <textarea
        data-input="teamRole"
        rows={6}
        placeholder={tr('botDefaults.rolePlaceholder')}
        disabled={!loaded || busy}
        value={role}
        onChange={event => setRole(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-role" disabled={!loaded || busy} onClick={() => void putRole(role, role.trim() === '')}>{tr('botDefaults.roleSave')}</button>
        <StatusSpan status={status} attr={{ 'data-role-status': '' }} />
      </div>
      <ProfileRoles appId={bot.larkAppId} />
    </section>
  );
}

function ProfileRoles(props: { appId: string }) {
  const tr = useT();
  const [state, setState] = useState<BotProfileRoleState>({ loaded: false, loading: true, items: [] });

  useEffect(() => {
    let active = true;
    setState({ loaded: false, loading: true, items: [] });
    void (async () => {
      try {
        const r = await fetch('/api/role-profiles');
        const body = await r.json().catch(() => ({}));
        if (!active) return;
        if (!r.ok) throw new Error(body?.error ?? String(r.status));
        const profiles = Array.isArray(body.profiles) ? body.profiles : [];
        const items = profiles
          .filter((profile: any) => (profile.botEntries ?? []).some((entry: any) =>
            entry?.larkAppId === props.appId && entry?.hasEntry,
          ))
          .map((profile: any) => ({ profileId: String(profile.profileId) }));
        setState({
          loaded: true,
          loading: false,
          items,
        });
      } catch (e: any) {
        if (active) setState({ loaded: true, loading: false, error: caughtErrorText(e), items: [] });
      }
    })();
    return () => { active = false; };
  }, [props.appId]);

  async function loadDetail(profileId: string): Promise<void> {
    const item = state.items.find(entry => entry.profileId === profileId);
    if (!item || item.loaded || item.loading) return;
    setState(current => ({
      ...current,
      items: current.items.map(entry => entry.profileId === profileId ? { ...entry, loading: true } : entry),
    }));
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(props.appId)}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? String(r.status));
      setState(current => ({
        ...current,
        items: current.items.map(entry => entry.profileId === profileId
          ? { ...entry, loading: false, loaded: true, content: body?.hasEntry ? String(body.content ?? '') : '' }
          : entry),
      }));
    } catch (e: any) {
      setState(current => ({
        ...current,
        items: current.items.map(entry => entry.profileId === profileId ? { ...entry, loading: false, error: caughtErrorText(e) } : entry),
      }));
    }
  }

  let body: ReactNode;
  if (state.loading) body = <LoadingState label={tr('common.loading')} compact />;
  else if (state.error) body = <p className="hint-warn-inline">{tr('botDefaults.profileRolesLoadFailed', { error: state.error })}</p>;
  else if (state.items.length === 0) body = <p className="empty">{tr('botDefaults.profileRolesEmpty')}</p>;
  else {
    body = state.items.map(item => (
      <details
        className="bd-profile-role-entry"
        data-profile-id={item.profileId}
        key={item.profileId}
        onToggle={event => {
          if (event.currentTarget.open) void loadDetail(item.profileId);
        }}
      >
        <summary><span className="bd-profile-role-id">{item.profileId}</span></summary>
        <div className="bd-profile-role-content" data-profile-role-body={item.profileId}>
          {item.loading ? <LoadingState label={tr('common.loading')} compact /> : item.error ? (
            <p className="hint-warn-inline">{tr('botDefaults.profileRoleDetailLoadFailed', { error: item.error })}</p>
          ) : item.loaded ? (
            <pre>{item.content ?? ''}</pre>
          ) : (
            <p className="empty">{tr('botDefaults.profileRoleClickToLoad')}</p>
          )}
        </div>
      </details>
    ));
  }

  return (
    <div className="bd-profile-roles" data-profile-roles>
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.profileRolesHelp')}>{tr('botDefaults.profileRoles')}</FieldTitle></h4>
      <div className="bd-profile-role-list" data-profile-role-list>{body}</div>
    </div>
  );
}

function CardBehaviorSection(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const { bot, putCardPref } = props;
  const [disableStreaming, setDisableStreaming] = useState(bot.disableStreamingCard === true);
  const [silentReactions, setSilentReactions] = useState(bot.silentTurnReactions === true);
  const [writableLink, setWritableLink] = useState(bot.writableTerminalLinkInCard === true);
  const [privateCard, setPrivateCard] = useState(bot.privateCard === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setDisableStreaming(bot.disableStreamingCard === true);
    setSilentReactions(bot.silentTurnReactions === true);
    setWritableLink(bot.writableTerminalLinkInCard === true);
    setPrivateCard(bot.privateCard === true);
  }, [bot.disableStreamingCard, bot.privateCard, bot.silentTurnReactions, bot.writableTerminalLinkInCard]);

  async function savePatch(patch: CardPrefPatch, key: string): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await putCardPref(patch);
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionCard')}</h3>
      <div className="bd-toggle-grid bd-card-behavior-grid">
        <ToggleRow
          checked={disableStreaming}
          disabled={busy === 'streaming'}
          dataAction="toggle-disable-streaming"
          title={tr('botDefaults.disableStreaming')}
          help={tr('botDefaults.disableStreamingHelp')}
          onChange={checked => {
            setDisableStreaming(checked);
            void savePatch({ disableStreamingCard: checked }, 'streaming');
          }}
        />
        <ToggleRow
          checked={silentReactions}
          disabled={!disableStreaming || busy === 'silent'}
          dataAction="toggle-silent-reactions"
          title={tr('botDefaults.silentTurnReactions')}
          help={tr('botDefaults.silentTurnReactionsHelp')}
          onChange={checked => {
            setSilentReactions(checked);
            void savePatch({ silentTurnReactions: checked }, 'silent');
          }}
        />
        <ToggleRow
          checked={writableLink}
          disabled={disableStreaming || busy === 'writable'}
          dataAction="toggle-writable-link"
          title={tr('botDefaults.writableLink')}
          help={tr('botDefaults.writableLinkHelp')}
          onChange={checked => {
            setWritableLink(checked);
            void savePatch({ writableTerminalLinkInCard: checked }, 'writable');
          }}
        />
        <ToggleRow
          checked={privateCard}
          disabled={busy === 'private'}
          dataAction="toggle-private-card"
          title={tr('botDefaults.privateCard')}
          help={tr('botDefaults.privateCardHelp')}
          onChange={checked => {
            setPrivateCard(checked);
            void savePatch({ privateCard: checked }, 'private');
          }}
        />
      </div>
      <div className="actions">
        <small data-card-pref-moot className="hint-warn-inline" hidden={!disableStreaming}>{tr('botDefaults.writableLinkMoot')}</small>
        <StatusSpan status={status} attr={{ 'data-card-pref-status': '' }} />
      </div>
    </section>
  );
}

export function CodexAppDisplaySection(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const [cleanInput, setCleanInput] = useState(props.bot.codexAppCleanInput === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCleanInput(props.bot.codexAppCleanInput === true), [props.bot.codexAppCleanInput]);

  async function save(checked: boolean): Promise<void> {
    const previous = cleanInput;
    setCleanInput(checked);
    setBusy(true);
    setStatus(null);
    try {
      const res = await props.putCardPref({ codexAppCleanInput: checked });
      if (res.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setCleanInput(previous);
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setCleanInput(previous);
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section" data-codex-app-display>
      <h3 className="bd-section-title">{tr('botDefaults.sectionCodexAppDisplay')}</h3>
      <ToggleRow
        checked={cleanInput}
        disabled={busy}
        dataAction="toggle-codex-app-clean-input"
        title={tr('botDefaults.codexAppCleanInput')}
        help={tr('botDefaults.codexAppCleanInputHelp')}
        onChange={checked => void save(checked)}
      />
      <small className="bd-section-note">{tr('botDefaults.codexAppCleanInputCompat')}</small>
      <div className="actions">
        <StatusSpan status={status} attr={{ 'data-codex-app-clean-input-status': '' }} />
      </div>
    </section>
  );
}

function CrossBotSection(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const [sameDir, setSameDir] = useState(props.bot.botToBotSameDir !== false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setSameDir(props.bot.botToBotSameDir !== false), [props.bot.botToBotSameDir]);

  async function save(next: boolean): Promise<void> {
    setSameDir(next);
    setBusy(true);
    setStatus(null);
    try {
      const res = await props.putCardPref({ botToBotSameDir: next });
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionCrossBot')}</h3>
      <ToggleRow
        checked={sameDir}
        disabled={busy}
        dataAction="toggle-cross-bot-samedir"
        title={tr('botDefaults.botToBotSameDir')}
        help={tr('botDefaults.botToBotSameDirHelp')}
        onChange={checked => void save(checked)}
      />
      <div className="actions"><StatusSpan status={status} attr={{ 'data-crossbot-status': '' }} /></div>
    </section>
  );
}

function SummaryTriggerSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = summaryRange(props.bot);
  const [limit, setLimit] = useState(String(initial.limit));
  const [sinceHours, setSinceHours] = useState(String(initial.sinceHours));
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = summaryRange(props.bot);
    setLimit(String(next.limit));
    setSinceHours(String(next.sinceHours));
  }, [props.bot.summaryRange?.limit, props.bot.summaryRange?.sinceHours]);

  async function save(): Promise<void> {
    setStatus(null);
    const nextLimit = nonNegativeInteger(limit, 50);
    const nextSinceHours = nonNegativeInteger(sinceHours, 24);
    if (nextLimit == null || nextSinceHours == null) {
      setStatus({ text: `✗ ${tr('botDefaults.summaryNumberInvalid')}` });
      return;
    }
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/summary-range`, {
        limit: nextLimit,
        sinceHours: nextSinceHours,
      });
      if (res.ok && res.body.ok) {
        const next = res.body.summaryRange ?? { limit: nextLimit, sinceHours: nextSinceHours };
        const normalized = summaryRange({ ...props.bot, summaryRange: next });
        setLimit(String(normalized.limit));
        setSinceHours(String(normalized.sinceHours));
        props.patchBot(props.bot.larkAppId, { summaryRange: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title"><FieldTitle help={tr('botDefaults.summaryLimitHelp')}>{tr('botDefaults.sectionSummaryTrigger')}</FieldTitle></h3>
      <div className="bd-row bd-summary-limits">
        <label>
          <span>{tr('botDefaults.summaryLimit')}</span>
          <input type="number" min={0} step={1} data-input="summaryLimit" value={limit} disabled={busy} onChange={event => setLimit(event.currentTarget.value)} />
        </label>
        <label>
          <span>{tr('botDefaults.summarySinceHours')}</span>
          <input type="number" min={0} step={1} data-input="summarySinceHours" value={sinceHours} disabled={busy} onChange={event => setSinceHours(event.currentTarget.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-summary-trigger" disabled={busy} onClick={() => void save()}>{tr('botDefaults.summarySave')}</button>
        <StatusSpan status={status} attr={{ 'data-summary-trigger-status': '' }} />
      </div>
    </section>
  );
}

function summaryRange(bot: BotDefaultsRow): { limit: number; sinceHours: number } {
  const range = bot.summaryRange ?? { limit: 50, sinceHours: 24 };
  return {
    limit: Number.isInteger(range.limit) && Number(range.limit) >= 0 ? Number(range.limit) : 50,
    sinceHours: Number.isInteger(range.sinceHours) && Number(range.sinceHours) >= 0 ? Number(range.sinceHours) : 24,
  };
}

function SessionModeSection(props: {
  bot: BotDefaultsRow;
  patchBot: PatchBot;
  putCardPref(patch: CardPrefPatch): Promise<JsonResponse>;
}) {
  const tr = useT();
  const [p2p, setP2p] = useState(props.bot.p2pMode === 'chat' ? 'chat' : 'thread');
  const [regular, setRegular] = useState(regularGroupMode(props.bot));
  const [mention, setMention] = useState(mentionMode(props.bot));
  const [docMode, setDocMode] = useState(props.bot.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only');
  const [busy, setBusy] = useState<string | null>(null);
  const [p2pStatus, setP2pStatus] = useState<StatusMessage>(null);
  const [regularStatus, setRegularStatus] = useState<StatusMessage>(null);
  const [mentionStatus, setMentionStatus] = useState<StatusMessage>(null);
  const [docStatus, setDocStatus] = useState<StatusMessage>(null);

  useEffect(() => {
    setP2p(props.bot.p2pMode === 'chat' ? 'chat' : 'thread');
    setRegular(regularGroupMode(props.bot));
    setMention(mentionMode(props.bot));
    setDocMode(props.bot.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only');
  }, [
    props.bot.docSubscribeDefaultMode,
    props.bot.p2pMode,
    props.bot.regularGroupMentionMode,
    props.bot.regularGroupReplyMode,
  ]);

  async function saveP2p(next: string): Promise<void> {
    const mode = next === 'chat' ? 'chat' : 'thread';
    setP2p(mode);
    setBusy('p2p');
    setP2pStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/p2p-mode`, { p2pMode: mode });
      if (res.ok && res.body.ok) {
        props.patchBot(props.bot.larkAppId, { p2pMode: res.body.p2pMode === 'chat' ? 'chat' : 'thread' });
        setP2pStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setP2pStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setP2pStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function saveCardMode(key: string, patch: CardPrefPatch, setStatus: (status: StatusMessage) => void): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await props.putCardPref(patch);
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const p2pOptions: DropdownFieldOption<'thread' | 'chat'>[] = [
    { value: 'thread', label: tr('botDefaults.p2pThread') },
    { value: 'chat', label: tr('botDefaults.p2pChat') },
  ];
  const regularOptions: DropdownFieldOption<string>[] = [
    { value: 'chat', label: tr('botDefaults.regularGroupModeChat') },
    { value: 'chat-topic', label: tr('botDefaults.regularGroupModeChatTopic') },
    { value: 'new-topic', label: tr('botDefaults.regularGroupModeNewTopic') },
    { value: 'shared', label: tr('botDefaults.regularGroupModeShared') },
  ];
  const mentionOptions: DropdownFieldOption<string>[] = [
    { value: 'always', label: tr('botDefaults.mentionModeAlways') },
    { value: 'topic', label: tr('botDefaults.mentionModeTopic') },
    { value: 'never', label: tr('botDefaults.mentionModeNever') },
    { value: 'ambient', label: tr('botDefaults.mentionModeAmbient') },
  ];
  const docOptions: DropdownFieldOption<string>[] = [
    { value: 'mention-only', label: tr('botDefaults.docSubscribeModeMention') },
    { value: 'all', label: tr('botDefaults.docSubscribeModeAll') },
  ];

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSessionMode')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.p2pHelp')}>{tr('botDefaults.p2pMode')}</FieldTitle>
          <DropdownField
            dataInput="p2pMode"
            ariaLabel={tr('botDefaults.p2pMode')}
            value={p2p}
            disabled={busy === 'p2p'}
            options={p2pOptions}
            onChange={next => void saveP2p(next)}
          />
        </div>
        <div className="actions"><StatusSpan status={p2pStatus} attr={{ 'data-p2p-status': '' }} /></div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.regularGroupModeHelp')}>{tr('botDefaults.regularGroupMode')}</FieldTitle>
          <DropdownField
            dataInput="regularGroupMode"
            ariaLabel={tr('botDefaults.regularGroupMode')}
            value={regular}
            disabled={busy === 'regular'}
            options={regularOptions}
            onChange={next => {
              setRegular(next);
              void saveCardMode('regular', { regularGroupReplyMode: next }, setRegularStatus);
            }}
          />
        </div>
        <div className="actions"><StatusSpan status={regularStatus} attr={{ 'data-regular-group-status': '' }} /></div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.mentionModeHelp')}>{tr('botDefaults.mentionMode')}</FieldTitle>
          <DropdownField
            dataInput="regularGroupMentionMode"
            ariaLabel={tr('botDefaults.mentionMode')}
            value={mention}
            disabled={busy === 'mention'}
            options={mentionOptions}
            onChange={next => {
              setMention(next);
              void saveCardMode('mention', { regularGroupMentionMode: next }, setMentionStatus);
            }}
          />
        </div>
        <div className="actions"><StatusSpan status={mentionStatus} attr={{ 'data-mention-mode-status': '' }} /></div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.docSubscribeModeHelp')}>{tr('botDefaults.docSubscribeMode')}</FieldTitle>
          <DropdownField
            dataInput="docSubscribeDefaultMode"
            ariaLabel={tr('botDefaults.docSubscribeMode')}
            value={docMode}
            disabled={busy === 'doc'}
            options={docOptions}
            onChange={next => {
              setDocMode(next);
              void saveCardMode('doc', { docSubscribeDefaultMode: next }, setDocStatus);
            }}
          />
        </div>
        <div className="actions"><StatusSpan status={docStatus} attr={{ 'data-doc-subscribe-mode-status': '' }} /></div>
      </div>
    </section>
  );
}

function SubstituteModeSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = props.bot.substituteMode ?? null;
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [disclosure, setDisclosure] = useState<'prefix' | 'none'>(initial?.disclosure === 'none' ? 'none' : 'prefix');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  const targetSequence = useRef(0);
  const skipModeSync = useRef(false);

  function makeTargetDraft(target?: BotSubstituteTarget): SubstituteTargetDraft {
    const idField = substituteTargetIdField(target);
    return {
      key: ++targetSequence.current,
      idField,
      idValue: target?.[idField] ?? '',
      name: target?.name ?? '',
      persisted: target ? { ...target } : {},
      originalIdField: target ? idField : undefined,
    };
  }

  const [targetRows, setTargetRows] = useState<SubstituteTargetDraft[]>(() => {
    const targets = initial?.targets ?? [];
    return targets.length ? targets.map(target => makeTargetDraft(target)) : [makeTargetDraft()];
  });

  useEffect(() => {
    if (skipModeSync.current) {
      skipModeSync.current = false;
      return;
    }
    const next = props.bot.substituteMode ?? null;
    setEnabled(next?.enabled === true);
    setDisclosure(next?.disclosure === 'none' ? 'none' : 'prefix');
    const targets = next?.targets ?? [];
    setTargetRows(targets.length ? targets.map(target => makeTargetDraft(target)) : [makeTargetDraft()]);
  }, [props.bot.larkAppId, props.bot.substituteMode]);

  async function save(body: { enabled: boolean; targets: BotSubstituteTarget[]; disclosure?: 'prefix' | 'none' }): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/substitute-mode`, body);
      if (res.ok && res.body.ok) {
        const next = res.body.substituteMode && typeof res.body.substituteMode === 'object'
          ? res.body.substituteMode as BotSubstituteMode
          : null;
        const resolution: SubstituteTargetResolution[] = Array.isArray(res.body?.resolution)
          ? res.body.resolution
          : [];
        const unresolved = resolution
          .filter(entry => entry?.ok === false)
          .map(entry => String(entry.input ?? '').trim())
          .filter(Boolean);
        setEnabled(next?.enabled === true);
        setDisclosure(next?.disclosure === 'none' ? 'none' : 'prefix');
        if (resolution.length) {
          skipModeSync.current = true;
          setTargetRows(rows => {
            const pending = [...resolution];
            return rows.map(row => {
              const input = row.idValue.trim();
              const index = pending.findIndex(entry => String(entry.input ?? '').trim() === input);
              if (index < 0) return row;
              const entry = pending.splice(index, 1)[0];
              if (entry?.ok !== true) return row;
              const persisted: BotSubstituteTarget = { ...row.persisted };
              if (entry.openId) persisted.openId = entry.openId;
              if (row.idField === 'email') persisted.email = input;
              if (entry.name) persisted.name = entry.name;
              return { ...row, name: entry.name ?? row.name, persisted };
            });
          });
        } else {
          const targets = next?.targets ?? [];
          setTargetRows(targets.length ? targets.map(target => makeTargetDraft(target)) : [makeTargetDraft()]);
        }
        props.patchBot(props.bot.larkAppId, { substituteMode: next });
        setStatus(unresolved.length
          ? { text: `✗ ${tr('botDefaults.substituteTargetsInvalid')}: ${unresolved.join(', ')}` }
          : { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        const unresolved = Array.isArray(res.body?.resolution)
          ? res.body.resolution
            .filter((entry: SubstituteTargetResolution) => entry?.ok === false)
            .map((entry: SubstituteTargetResolution) => String(entry.input ?? '').trim())
            .filter(Boolean)
          : [];
        setStatus({ text: unresolved.length
          ? `✗ ${tr('botDefaults.substituteTargetsInvalid')}: ${unresolved.join(', ')}`
          : `✗ ${responseErrorText(res)}` });
      }
    } catch (error: any) {
      setStatus({ text: `✗ ${caughtErrorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  function saveCurrent(): void {
    const targets: BotSubstituteTarget[] = [];
    let invalid = false;
    for (const row of targetRows) {
      const target = buildSubstituteTarget(row);
      if (!target) {
        invalid ||= Boolean(row.name.trim());
        continue;
      }
      targets.push(target);
    }

    if (invalid || (enabled && targets.length === 0)) {
      setStatus({ text: `✗ ${tr('botDefaults.substituteTargetsInvalid')}` });
      return;
    }
    void save({ enabled, targets, disclosure });
  }

  const disclosureOptions: DropdownFieldOption<'prefix' | 'none'>[] = [
    { value: 'prefix', label: tr('botDefaults.substituteDisclosurePrefix') },
    { value: 'none', label: tr('botDefaults.substituteDisclosureNone') },
  ];

  return (
    <section className="bd-section bd-substitute-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSubstitute')}</h3>
      <ToggleRow
        checked={enabled}
        disabled={busy}
        dataAction="toggle-substitute-mode"
        title={tr('botDefaults.substituteEnabled')}
        help={tr('botDefaults.substituteHelp')}
        onChange={setEnabled}
      />
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle>{tr('botDefaults.substituteDisclosure')}</FieldTitle>
          <DropdownField<'prefix' | 'none'>
            dataInput="substituteDisclosure"
            ariaLabel={tr('botDefaults.substituteDisclosure')}
            value={disclosure}
            disabled={busy}
            options={disclosureOptions}
            onChange={value => setDisclosure(value)}
          />
        </div>
      </div>
      <div className="bd-row bd-substitute-targets">
        <FieldTitle help={tr('botDefaults.substituteTargetsHelp')}>{tr('botDefaults.substituteTargets')}</FieldTitle>
        <div className="bd-substitute-target-list" data-input="substituteTargets">
          {targetRows.map((target, index) => (
            <div className="bd-substitute-target-row" key={target.key}>
              <DropdownField<SubstituteTargetIdField>
                dataInput={`substituteTargetType-${target.key}`}
                className="bd-substitute-target-type"
                ariaLabel={`${tr('botDefaults.substituteTargetType')} ${index + 1}`}
                value={target.idField}
                disabled={busy}
                options={substituteTargetIdFields.map(value => ({
                  value,
                  label: tr(`botDefaults.substituteTarget${value[0].toUpperCase()}${value.slice(1)}`),
                }))}
                onChange={idField => {
                  setTargetRows(rows => rows.map(row => row.key === target.key
                    ? { ...row, idField, idValue: row.persisted[idField] ?? '' }
                    : row));
                }}
              />
              <input
                className="bd-substitute-target-id"
                type="text"
                data-input={`substituteTargetId-${target.key}`}
                aria-label={`${tr('botDefaults.substituteTargetType')} ${index + 1}`}
                placeholder={tr('botDefaults.substituteTargetIdPlaceholder')}
                value={target.idValue}
                disabled={busy}
                onChange={event => {
                  const idValue = event.currentTarget.value;
                  setTargetRows(rows => rows.map(row => row.key === target.key ? { ...row, idValue } : row));
                }}
              />
              <input
                className="bd-substitute-target-name"
                type="text"
                data-input={`substituteTargetName-${target.key}`}
                aria-label={`${tr('botDefaults.substituteTargetName')} ${index + 1}`}
                placeholder={tr('botDefaults.substituteTargetNamePlaceholder')}
                value={target.name}
                disabled={busy}
                onChange={event => {
                  const name = event.currentTarget.value;
                  setTargetRows(rows => rows.map(row => row.key === target.key ? { ...row, name } : row));
                }}
              />
              <button
                type="button"
                className="bd-substitute-target-remove"
                data-action="remove-substitute-target"
                title={tr('botDefaults.substituteTargetRemove')}
                aria-label={tr('botDefaults.substituteTargetRemove')}
                disabled={busy}
                onClick={() => {
                  setTargetRows(rows => {
                    const remaining = rows.filter(row => row.key !== target.key);
                    return remaining.length ? remaining : [makeTargetDraft()];
                  });
                }}
              >
                <span aria-hidden="true">&times;</span>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="bd-substitute-target-add"
            data-action="add-substitute-target"
            title={tr('botDefaults.substituteTargetAdd')}
            aria-label={tr('botDefaults.substituteTargetAdd')}
            disabled={busy}
            onClick={() => setTargetRows(rows => [...rows, makeTargetDraft()])}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-substitute-mode" disabled={busy} onClick={saveCurrent}>
          {tr('botDefaults.substituteSave')}
        </button>
        <button
          type="button"
          data-action="off-substitute-mode"
          disabled={busy}
          onClick={() => void save({ enabled: false, targets: [] })}
        >
          {tr('botDefaults.substituteOff')}
        </button>
        <StatusSpan status={status} attr={{ 'data-substitute-status': '' }} />
      </div>
    </section>
  );
}

function regularGroupMode(bot: BotDefaultsRow): string {
  return bot.regularGroupReplyMode === 'new-topic' || bot.regularGroupReplyMode === 'shared' || bot.regularGroupReplyMode === 'chat-topic'
    ? bot.regularGroupReplyMode
    : 'chat';
}

function mentionMode(bot: BotDefaultsRow): string {
  return bot.regularGroupMentionMode === 'topic' || bot.regularGroupMentionMode === 'never' || bot.regularGroupMentionMode === 'ambient'
    ? bot.regularGroupMentionMode
    : 'always';
}

function SessionCapSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = typeof props.bot.maxLiveWorkers === 'number' ? props.bot.maxLiveWorkers : null;
  const logical = Number.isFinite(props.bot.logicalSessionCount) ? Number(props.bot.logicalSessionCount) : 0;
  const resident = Number.isFinite(props.bot.residentSessionCount) ? Number(props.bot.residentSessionCount) : 0;
  const dormant = Number.isFinite(props.bot.dormantSessionCount) ? Number(props.bot.dormantSessionCount) : 0;
  const [cap, setCap] = useState<number | null>(initial);
  const effectiveCap = cap ?? 30;
  const [input, setInput] = useState(initial == null ? '' : String(initial));
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = typeof props.bot.maxLiveWorkers === 'number' ? props.bot.maxLiveWorkers : null;
    setCap(next);
    setInput(next == null ? '' : String(next));
  }, [props.bot.maxLiveWorkers]);

  async function save(value: number | null): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/max-live-workers`, { maxLiveWorkers: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.maxLiveWorkers === 'number' ? res.body.maxLiveWorkers : null;
        setCap(next);
        setInput(next == null ? '' : String(next));
        props.patchBot(props.bot.larkAppId, { maxLiveWorkers: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  function saveInput(): void {
    const parsed = positiveIntegerOrNull(input);
    if (parsed === 'invalid') {
      setStatus({ text: `✗ ${tr('botDefaults.maxLiveWorkersInvalid')}` });
      return;
    }
    void save(parsed);
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title">{tr('botDefaults.sectionSessionCap')}</h4>
      <div className="bd-row bd-quota">
        <label>
          <FieldTitle help={tr('botDefaults.maxLiveWorkersHelp')}>{tr('botDefaults.maxLiveWorkers')}</FieldTitle>
          <input type="number" min={1} step={1} data-input="maxLiveWorkers" placeholder={tr('botDefaults.maxLiveWorkersPlaceholder')} value={input} disabled={busy} onChange={event => setInput(event.currentTarget.value)} />
        </label>
        <small data-session-cap-state>{sessionCapStateLabel(cap, tr)}</small>
        <small className="bd-help bd-session-residency">{tr('botDefaults.maxLiveWorkersUsage', {
          resident,
          cap: effectiveCap,
          dormant,
          logical,
        })}</small>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-session-cap" disabled={busy} onClick={saveInput}>{tr('botDefaults.maxLiveWorkersSave')}</button>
        <button type="button" data-action="off-session-cap" disabled={busy} onClick={() => { setInput(''); void save(null); }}>{tr('botDefaults.maxLiveWorkersOff')}</button>
        <StatusSpan status={status} attr={{ 'data-session-cap-status': '' }} />
      </div>
    </div>
  );
}

function StartupCommandsSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [value, setValue] = useState(typeof props.bot.startupCommands === 'string' ? props.bot.startupCommands : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof props.bot.startupCommands === 'string' ? props.bot.startupCommands : ''), [props.bot.startupCommands]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/startup-commands`, { startupCommands: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.startupCommands === 'string' ? res.body.startupCommands : '';
        setValue(next);
        props.patchBot(props.bot.larkAppId, { startupCommands: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.startupCommandsHelp')}>{tr('botDefaults.sectionStartupCommands')}</FieldTitle></h4>
      <textarea
        data-input="startupCommands"
        rows={3}
        placeholder={tr('botDefaults.startupCommandsPlaceholder')}
        value={value}
        disabled={busy}
        onChange={event => setValue(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-startup-commands" disabled={busy} onClick={() => void save()}>{tr('botDefaults.startupCommandsSave')}</button>
        <StatusSpan status={status} attr={{ 'data-startup-commands-status': '' }} />
      </div>
    </div>
  );
}

function LaunchShellSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [value, setValue] = useState(typeof props.bot.launchShell === 'string' ? props.bot.launchShell : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof props.bot.launchShell === 'string' ? props.bot.launchShell : ''), [props.bot.launchShell]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/launch-shell`, { launchShell: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.launchShell === 'string' ? res.body.launchShell : '';
        setValue(next);
        props.patchBot(props.bot.larkAppId, { launchShell: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.launchShellHelp')}>{tr('botDefaults.sectionLaunchShell')}</FieldTitle></h4>
      <input
        type="text"
        data-input="launchShell"
        placeholder={tr('botDefaults.launchShellPlaceholder')}
        value={value}
        disabled={busy}
        onChange={event => setValue(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-launch-shell" disabled={busy} onClick={() => void save()}>{tr('botDefaults.launchShellSave')}</button>
        <StatusSpan status={status} attr={{ 'data-launch-shell-status': '' }} />
      </div>
    </div>
  );
}

function EnvSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [value, setValue] = useState(typeof props.bot.env === 'string' ? props.bot.env : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof props.bot.env === 'string' ? props.bot.env : ''), [props.bot.env]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/env`, { env: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.env === 'string' ? res.body.env : '';
        setValue(next);
        props.patchBot(props.bot.larkAppId, { env: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.envHelp')}>{tr('botDefaults.sectionEnv')}</FieldTitle></h4>
      <textarea
        data-input="env"
        rows={5}
        placeholder={tr('botDefaults.envPlaceholder')}
        value={value}
        disabled={busy}
        onChange={event => setValue(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-env" disabled={busy} onClick={() => void save()}>{tr('botDefaults.envSave')}</button>
        <StatusSpan status={status} attr={{ 'data-env-status': '' }} />
      </div>
    </div>
  );
}

/** Agents supported by the riff runner (free text still allowed for new ones). */
const RIFF_AGENT_SUGGESTIONS = ['aiden', 'aiden-claude', 'codex', 'opencode'];

function RiffSection(props: { bot: BotDefaultsRow; patchBot: PatchBot; persistCliSelection?: () => Promise<boolean> }) {
  const tr = useT();
  const riff = props.bot.riff && typeof props.bot.riff === 'object' ? props.bot.riff : {};
  const [baseUrl, setBaseUrl] = useState(typeof riff.baseUrl === 'string' ? riff.baseUrl : '');
  const [agent, setAgent] = useState(typeof riff.agent === 'string' ? riff.agent : '');
  const [model, setModel] = useState(typeof riff.model === 'string' ? riff.model : '');
  const [jwtEnv, setJwtEnv] = useState(typeof riff.jwtEnv === 'string' ? riff.jwtEnv : '');
  const [sandboxCluster, setSandboxCluster] = useState(typeof riff.sandboxCluster === 'string' ? riff.sandboxCluster : '');
  const [injectStatusLines, setInjectStatusLines] = useState(riff.injectStatusLines !== false);
  const [systemPrompt, setSystemPrompt] = useState(typeof riff.systemPrompt === 'string' ? riff.systemPrompt : '');
  const [setupCommands, setSetupCommands] = useState(
    Array.isArray(riff.setupCommands) ? riff.setupCommands.join('\n') : '',
  );
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const r = props.bot.riff && typeof props.bot.riff === 'object' ? props.bot.riff : {};
    setBaseUrl(typeof r.baseUrl === 'string' ? r.baseUrl : '');
    setAgent(typeof r.agent === 'string' ? r.agent : '');
    setModel(typeof r.model === 'string' ? r.model : '');
    setJwtEnv(typeof r.jwtEnv === 'string' ? r.jwtEnv : '');
    setSandboxCluster(typeof r.sandboxCluster === 'string' ? r.sandboxCluster : '');
    setInjectStatusLines(r.injectStatusLines !== false);
    setSystemPrompt(typeof r.systemPrompt === 'string' ? r.systemPrompt : '');
    setSetupCommands(Array.isArray(r.setupCommands) ? r.setupCommands.join('\n') : '');
  }, [props.bot.riff]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const config: Record<string, unknown> = {};
      if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
      if (agent.trim()) config.agent = agent.trim();
      if (model.trim()) config.model = model.trim();
      if (jwtEnv.trim()) config.jwtEnv = jwtEnv.trim();
      if (sandboxCluster.trim()) config.sandboxCluster = sandboxCluster.trim();
      // 显式持久化布尔——省略字段时后端按“开启”解释（!== false），
      // 只存 true 会导致该开关永远关不掉。
      config.injectStatusLines = injectStatusLines;
      if (systemPrompt.trim()) config.systemPrompt = systemPrompt.trim();
      if (setupCommands.trim()) {
        config.setupCommands = setupCommands.split('\n').map(s => s.trim()).filter(Boolean);
      }
      const json = Object.keys(config).length ? JSON.stringify(config) : '';
      // Save order matters: riff config FIRST, agent switch AFTER. PUT /agent
      // flips cliId/backendType AND closes CLI-mismatched sessions immediately,
      // so doing it first would leave a half-configured riff bot (and killed
      // sessions) when the /riff write fails. A saved-but-unused riff config
      // from the reverse failure mode is harmless.
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/riff`, { riff: json });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.riff === 'string' && res.body.riff ? JSON.parse(res.body.riff) : null;
        props.patchBot(props.bot.larkAppId, { riff: next });
        if (props.persistCliSelection && !(await props.persistCliSelection())) {
          setStatus({ text: `✗ ${tr('botDefaults.riffCliPersistFailed')}` });
          return;
        }
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.riffHelp')}>{tr('botDefaults.sectionRiff')}</FieldTitle></h4>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffBaseUrl')}</span>
          <input type="text" data-input="riff-base-url" placeholder={tr('botDefaults.riffBaseUrlPlaceholder')} value={baseUrl} disabled={busy} onChange={e => setBaseUrl(e.currentTarget.value)} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span><FieldTitle help={tr('botDefaults.riffAgentHelp')}>{tr('botDefaults.riffAgent')}</FieldTitle></span>
          <input type="text" data-input="riff-agent" list={`riff-agent-suggestions-${props.bot.larkAppId}`} placeholder={tr('botDefaults.riffAgentPlaceholder')} value={agent} disabled={busy} onChange={e => setAgent(e.currentTarget.value)} />
          <datalist id={`riff-agent-suggestions-${props.bot.larkAppId}`}>
            {RIFF_AGENT_SUGGESTIONS.map(item => <option value={item} key={item} />)}
          </datalist>
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span><FieldTitle help={tr('botDefaults.riffModelHelp')}>{tr('botDefaults.riffModel')}</FieldTitle></span>
          <input type="text" data-input="riff-model" placeholder={tr('botDefaults.riffModelPlaceholder')} value={model} disabled={busy} onChange={e => setModel(e.currentTarget.value)} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span><FieldTitle help={tr('botDefaults.riffJwtEnvHelp')}>{tr('botDefaults.riffJwtEnv')}</FieldTitle></span>
          <input type="text" data-input="riff-jwt-env" placeholder={tr('botDefaults.riffJwtEnvPlaceholder')} value={jwtEnv} disabled={busy} onChange={e => setJwtEnv(e.currentTarget.value)} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffSandboxCluster')}</span>
          <input type="text" data-input="riff-sandbox-cluster" placeholder={tr('botDefaults.riffSandboxClusterPlaceholder')} value={sandboxCluster} disabled={busy} onChange={e => setSandboxCluster(e.currentTarget.value)} />
        </label>
      </div>
      <label className="toggle-row">
        <input type="checkbox" data-input="riff-inject-status-lines" checked={injectStatusLines} disabled={busy} onChange={e => setInjectStatusLines(e.currentTarget.checked)} />
        <span className="switch" aria-hidden="true" />
        <span className="toggle-tx"><strong><FieldTitle help={tr('botDefaults.riffInjectStatusLinesHelp')}>{tr('botDefaults.riffInjectStatusLines')}</FieldTitle></strong></span>
      </label>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffSystemPrompt')}</span>
          <textarea data-input="riff-system-prompt" placeholder={tr('botDefaults.riffSystemPromptPlaceholder')} value={systemPrompt} disabled={busy} onChange={e => setSystemPrompt(e.currentTarget.value)} rows={4} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffSetupCommands')}</span>
          <textarea data-input="riff-setup-commands" placeholder={tr('botDefaults.riffSetupCommandsPlaceholder')} value={setupCommands} disabled={busy} onChange={e => setSetupCommands(e.currentTarget.value)} rows={3} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-riff" disabled={busy} onClick={() => void save()}>{tr('botDefaults.riffSave')}</button>
        <StatusSpan status={status} attr={{ 'data-riff-status': '' }} />
      </div>
    </div>
  );
}

function BrandSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = props.bot.brandLabel ?? null;
  const [brand, setBrand] = useState<string | null>(initial);
  const [input, setInput] = useState(initial ?? '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = props.bot.brandLabel ?? null;
    setBrand(next);
    setInput(next ?? '');
  }, [props.bot.brandLabel]);

  async function save(nextBrand: string | null): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/brand-label`, { brandLabel: nextBrand });
      if (res.ok && res.body.ok) {
        const next = res.body.brandLabel ?? null;
        setBrand(next);
        setInput(next ?? '');
        props.patchBot(props.bot.larkAppId, { brandLabel: next });
        setStatus({ text: '✓', ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionBrand')}</h3>
      <div className="bd-row bd-brand">
        <label>
          <FieldTitle help={tr('botDefaults.brandLabelHelp')}>{tr('botDefaults.brandLabel')}</FieldTitle>
          <input type="text" data-input="brandLabel" placeholder={tr('botDefaults.brandLabelPlaceholder')} value={input} disabled={busy} onChange={event => setInput(event.currentTarget.value)} />
        </label>
        <small data-brand-state>{brandStateLabel(brand, tr)}</small>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-brand" disabled={busy} onClick={() => void save(input)}>{tr('botDefaults.brandSave')}</button>
        <button type="button" data-action="reset-brand" disabled={busy} onClick={() => void save(null)}>{tr('botDefaults.brandReset')}</button>
        <StatusSpan status={status} attr={{ 'data-brand-status': '' }} />
      </div>
    </section>
  );
}

function GrantSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [autoCard, setAutoCard] = useState(props.bot.autoGrantRequestCards !== false);
  const [restrict, setRestrict] = useState(props.bot.restrictGrantCommands === true);
  const [quota, setQuota] = useState(typeof props.bot.messageQuotaDefaultLimit === 'number' ? props.bot.messageQuotaDefaultLimit : null);
  const [quotaInput, setQuotaInput] = useState(typeof props.bot.messageQuotaDefaultLimit === 'number' ? String(props.bot.messageQuotaDefaultLimit) : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setAutoCard(props.bot.autoGrantRequestCards !== false);
    setRestrict(props.bot.restrictGrantCommands === true);
    const next = typeof props.bot.messageQuotaDefaultLimit === 'number' ? props.bot.messageQuotaDefaultLimit : null;
    setQuota(next);
    setQuotaInput(next == null ? '' : String(next));
  }, [props.bot.autoGrantRequestCards, props.bot.messageQuotaDefaultLimit, props.bot.restrictGrantCommands]);

  async function savePatch(
    patch: { autoGrantRequestCards?: boolean; restrictGrantCommands?: boolean; messageQuotaDefaultLimit?: number | null },
    key: string,
  ): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/grant-prefs`, patch);
      if (res.ok && res.body.ok) {
        const nextQuota = typeof res.body.messageQuotaDefaultLimit === 'number' ? res.body.messageQuotaDefaultLimit : null;
        setAutoCard(res.body.autoGrantRequestCards !== false);
        setRestrict(res.body.restrictGrantCommands === true);
        setQuota(nextQuota);
        if ('messageQuotaDefaultLimit' in patch) setQuotaInput(nextQuota == null ? '' : String(nextQuota));
        props.patchBot(props.bot.larkAppId, {
          autoGrantRequestCards: res.body.autoGrantRequestCards !== false,
          restrictGrantCommands: res.body.restrictGrantCommands === true,
          messageQuotaDefaultLimit: nextQuota,
        });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  function saveQuota(): void {
    const parsed = positiveIntegerOrNull(quotaInput);
    if (parsed === 'invalid') {
      setStatus({ text: `✗ ${tr('botDefaults.quotaInvalid')}` });
      return;
    }
    void savePatch({ messageQuotaDefaultLimit: parsed }, 'quota');
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionGrant')}</h3>
      <div className="bd-toggle-grid bd-grant-toggle-grid">
        <ToggleRow
          checked={autoCard}
          disabled={busy === 'autoGrant'}
          dataAction="toggle-auto-grant-card"
          title={tr('botDefaults.autoGrantCard')}
          help={tr('botDefaults.autoGrantCardHelp')}
          onChange={checked => {
            setAutoCard(checked);
            void savePatch({ autoGrantRequestCards: checked }, 'autoGrant');
          }}
        />
        <ToggleRow
          checked={restrict}
          disabled={busy === 'restrict'}
          dataAction="toggle-restrict-grant"
          title={tr('botDefaults.restrictGrant')}
          help={tr('botDefaults.restrictGrantHelp')}
          onChange={checked => {
            setRestrict(checked);
            void savePatch({ restrictGrantCommands: checked }, 'restrict');
          }}
        />
      </div>
      <div className="bd-row bd-quota">
        <label>
          <FieldTitle help={tr('botDefaults.quotaHelp')}>{tr('botDefaults.quotaDefault')}</FieldTitle>
          <input type="number" min={1} step={1} data-input="quotaLimit" placeholder={tr('botDefaults.quotaPlaceholder')} value={quotaInput} disabled={busy === 'quota'} onChange={event => setQuotaInput(event.currentTarget.value)} />
        </label>
        <small data-quota-state>{quotaStateLabel(quota, tr)}</small>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-quota" disabled={busy === 'quota'} onClick={saveQuota}>{tr('botDefaults.quotaSave')}</button>
        <StatusSpan status={status} attr={{ 'data-grant-status': '' }} />
      </div>
    </section>
  );
}

export function renderBotDefaultsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <BotDefaultsPage />);
}
