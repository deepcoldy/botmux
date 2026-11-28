// 企业微信机器人的配置卡：页签、名字行、运行状态和企业微信专属格子在这里；
// 与飞书卡共用的区块组件由 bot-defaults-page 经 `shared` 交进来（见 BotProfileSharedParts）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WecomConnectionAction, WecomConnectionDto } from '../../im/wecom/contract/dashboard-dto.js';
import { isRemoteCliId } from '../../core/remote-cli-ids.js';
import { selectionKeyForBot } from '../../setup/cli-selection.js';
import type { BotProfileSharedParts, CardPrefPatch, PatchBot } from './bot-defaults-page.js';
import {
  botDefaultsSectionDomId,
  findBotDefaultsSection,
  fmtSince,
  WECOM_TALK_COMMANDS_SECTION_ID,
  wecomNativeSectionId,
  type BotDefaultsRow,
  type BotDefaultsTab,
  type CliOptionsState,
} from './bot-defaults.js';
import type { StatusMessage } from './bot-defaults-save.js';
import { BotProfileIdentityFields, BotProfileLayout, BotSettingActions, BotSettingSection } from './bot-profile-ui.js';
import { sendJson } from './dashboard-api.js';
import { Html, LoadingState } from './dashboard-components.js';
import {
  botProfileCapabilities,
  botProfileSectionProps,
  botProfileSectionSupported,
  botProfileTabs,
} from './providers/profile.js';
import type { BotProfileCapabilities } from './providers/types.js';
import { useT } from './react-hooks.js';
import { SessionEnvEditor } from './session-env-editor.js';
import { botAvatarHtml } from './ui.js';
import {
  BotProfileRequestContext,
  useWecomBotConfiguration,
  wecomProfilePatch,
  type WecomBotConfiguration,
  type WecomBotConfigurationPatch,
} from './wecom-bot-config.js';
import { WecomNativeCoreSection, WecomTalkCommandsSection } from './wecom-native-core-section.js';
import { WecomNativePlatformSection } from './wecom-native-platform-section.js';

/** 企业微信管理后台的通用入口（需登录，不按机器人推算详情深链）。 */
const WECOM_CONSOLE_URL = 'https://work.weixin.qq.com/wework_admin/';

/** 区块格子是否出现：问能力表（与 ⌘K 命令面板同一张），id 不在 BOT_DEFAULTS_SECTIONS 里的一律不出现。 */
function botProfileShowsSection(caps: BotProfileCapabilities, id: string): boolean {
  const section = findBotDefaultsSection(id);
  return section !== null && botProfileSectionSupported(caps, section);
}

export interface WecomBotDefaultsCardProps {
  /** 与飞书卡共用的区块组件；bot-defaults-page 传 BOT_PROFILE_SHARED_PARTS。 */
  shared: BotProfileSharedParts;
  onConfigurationReady?(): void;
  /** 配置读取失败（卡片只剩报错）：带 provider=wecom 的深链据此不再等待，见 BotDefaultsPage。 */
  onConfigurationFailed?(): void;
  connection: WecomConnectionDto;
  cliState: CliOptionsState;
  activeTab: BotDefaultsTab;
  onTabChange(tab: BotDefaultsTab): void;
  onRefresh(): void;
  onAction(id: string, action: WecomConnectionAction): void;
  pending?: boolean;
  error?: string;
}

/** The provider adapter supplies data/mutations; profile, fields and actions
 * below are the same presentation primitives used by the legacy controller. */
export function WecomBotDefaultsCard(props: WecomBotDefaultsCardProps) {
  const {
    BdTabGrid,
    BotDefaultsTabs,
    BotRuntimeStatus,
    herdrConfigVisible,
    BotAgentSection,
    WorkingDirSection,
    RoleSection,
    SessionModeSection,
    CommandTriggerSection,
    SessionCapSection,
    CodexArchiveSection,
    PromptCacheSection,
    StartupCommandsSection,
    SandboxSection,
    NetworkPolicySection,
    CodexAuthSection,
    SandboxPathsSection,
    SlashCommandPermissionsSection,
    CardBehaviorSection,
    FeedbackSettingsSection,
    LongTaskReminderSection,
    LocalAddressSection,
    BrandSection,
    BackendTypeSection,
    HerdrConfigSection,
    CodexAppDisplaySection,
    PromptInjectionSection,
    SessionOwnerReminderSection,
    SenderTagSection,
    RuntimeEnvironmentSection,
  } = props.shared;
  const tr = useT();
  const connection = props.connection;
  const { config, error, save, getSnapshot } = useWecomBotConfiguration(connection.id, props.onRefresh);
  useEffect(() => {
    if (config) props.onConfigurationReady?.();
  }, [config?.revision, config?.editable, props.onConfigurationReady]);
  useEffect(() => {
    if (error) props.onConfigurationFailed?.();
  }, [error, props.onConfigurationFailed]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(connection.label);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameStatus, setNameStatus] = useState<StatusMessage>(null);
  const name = config?.displayName || connection.label;
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);
  const editable = config?.editable !== false && Boolean(config);
  // 启停按钮只出现在交给 fleet 运行（或尚无人运行）的连接上；终端前台、旧版 Dashboard 拉起的网关不接管。
  const lifecycle = connection.configuration === 'ready'
    && (connection.ownership === 'fleet' || connection.ownership === 'none');
  const caps = botProfileCapabilities('wecom', { editable, lifecycle });
  const tabs = botProfileTabs(caps);
  const tab = tabs.includes(props.activeTab) ? props.activeTab : tabs[0] ?? 'common';
  // 区块格子与共享区块的能力 props 都从能力表来（⌘K 命令面板读同一张表）。
  const sectionProps = botProfileSectionProps(caps);
  const shows = (id: string) => botProfileShowsSection(caps, id);
  const bot: BotDefaultsRow = {
    ...(config?.botConfig ?? {}),
    ...(config?.runtime ?? {}),
    larkAppId: '',
    provider: 'wecom',
    providerBotId: connection.id,
    providerSessionMode: config?.sessionMode,
    botName: config?.displayName,
    cliId: config?.cli,
    model: config?.model,
    backendType: config?.backend,
    agentSelectionKey: selectionKeyForBot(
      config?.cli ?? 'codex',
      config?.botConfig?.wrapperCli as string | undefined,
      config?.botConfig?.cliLaunchMode as any,
    ),
    defaultWorkingDir: config?.workingDirectory,
    codexBrowser: (config?.botConfig?.codexBrowser as any)?.enabled === true,
    codexBrowserAutoApproveOrigins: (config?.botConfig?.codexBrowser as any)?.autoApproveOrigins === true,
    teamRole: config?.role?.content ?? '',
    startupCommands: Array.isArray(config?.botConfig?.startupCommands)
      ? config.botConfig.startupCommands.join('\n')
      : '',
    customPassthroughCommands: Array.isArray(config?.botConfig?.customPassthroughCommands)
      ? config.botConfig.customPassthroughCommands.join(' ')
      : '',
    sandbox: config?.botConfig?.sandbox === true || config?.botConfig?.sandbox === 'oncall',
    sandboxMode: (
      typeof config?.botConfig?.sandbox === 'string'
        ? config.botConfig.sandbox
        : config?.botConfig?.sandbox ? 'oncall' : 'off'
    ) as 'off' | 'oncall' | 'scratch',
  } as BotDefaultsRow;
  const patchBot: PatchBot = () => {}; // The revision-aware adapter refreshes the canonical profile after every save.
  const request: typeof sendJson = async (method, url, body) => {
    if (method === 'GET' && url.endsWith('/role')) {
      return {
        ok: true,
        status: 200,
        body: { ok: true, role: config?.role?.content ?? '', injectMode: config?.role?.injectMode ?? 'every' },
      } as any;
    }
    try {
      const patch = wecomProfilePatch(url.split('/').pop() ?? '', body, getSnapshot());
      await save(patch);
      const next = getSnapshot()!;
      const settings = next.botConfig ?? {};
      const mode = typeof settings.sandbox === 'string' ? settings.sandbox : settings.sandbox ? 'oncall' : 'off';
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          ...settings,
          startupCommands: Array.isArray(settings.startupCommands) ? settings.startupCommands.join('\n') : '',
          customPassthroughCommands: Array.isArray(settings.customPassthroughCommands)
            ? settings.customPassthroughCommands.join(' ')
            : '',
          cliId: next.cli,
          model: next.model,
          backendType: next.backend,
          defaultWorkingDir: next.workingDirectory,
          sandbox: mode !== 'off',
          mode,
          ...(settings.herdr ? { herdr: JSON.stringify(settings.herdr) } : {}),
          ...(settings.riff ? { riff: JSON.stringify(settings.riff) } : {}),
        },
      } as any;
    } catch (e) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: e instanceof Error ? e.message : tr('botDefaults.wecom.saveFailed') },
      } as any;
    }
  };
  const putCardPref = async (patch: CardPrefPatch) => request('PUT', `/api/bots/${encodeURIComponent(connection.id)}/card-prefs`, patch);
  async function persist(
    patch: WecomBotConfigurationPatch,
    busy: (value: boolean) => void,
    status: (value: StatusMessage) => void,
    nextSession = true,
  ) {
    busy(true);
    status(null);
    try {
      await save(patch);
      // 与飞书同款：保存即生效，用于下个新会话（运行中的连接自动把新设置交给 core，不需要重启）。
      const savedText = nextSession
        ? `✓ ${tr('botDefaults.agentSaved')}`
        : `✓ ${tr('botDefaults.renameSave')}`;
      status({ ok: true, text: savedText });
      return true;
    } catch (error) {
      status({ text: error instanceof Error ? error.message : tr('botDefaults.wecom.saveFailedRetry') });
      return false;
    } finally {
      busy(false);
    }
  }
  const meta = wecomCardMeta(connection, tr);
  // 状态文件写入失败的网关仍连着企业微信，但不再处理消息：运行状态里也不说「已连接」。
  const connected = meta.online;
  const runtimeNotes = wecomRuntimeNotes(connection, tr);
  // 服务端说明（例如「终端启动的网关」）不由状态文件写入失败那一条翻译，两者同时出现。
  const notesExplainMessage = runtimeNotes.length > (connection.stateWriteFailure ? 1 : 0);
  const identity = (
    <BotProfileIdentityFields
      name={name}
      cli={config?.cli ?? ''}
      canRename={caps.rename}
      meta={<small className={meta.online ? 'bd-meta-ok' : undefined}>● {meta.text}</small>}
      editing={editing}
      draft={draft}
      busy={nameBusy || !editable}
      onEdit={setEditing}
      onDraft={setDraft}
      onSave={() => {
        if (!draft.trim()) {
          setNameStatus({ text: tr('botDefaults.renameEmpty') });
          return;
        }
        void persist({ displayName: draft.trim() }, setNameBusy, setNameStatus, false).then(ok => {
          if (ok) setEditing(false);
        });
      }}
      status={nameStatus}
      identity={(
        <>
          <code>{connection.botIdHint}</code>
          {/* 与飞书卡同一处、同一个能力开关（caps.console）；企业微信只有一个固定的管理后台入口。 */}
          {caps.console ? (
            <a className="bd-console-link" href={WECOM_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
              {tr('botDefaults.wecom.platform.openConsole')}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            </a>
          ) : null}
        </>
      )}
    />
  );
  // 分类页签各挂企业微信专属格子；每一格出不出现和别的格子一样问 shows（⌘K 读同一张能力表，
  // 配置只读时一格都不出现）。
  const nativeTiles = (panel: BotDefaultsTab) => (
    <WecomNativeTiles
      tab={panel}
      shows={shows}
      connectionId={connection.id}
      config={config}
      save={save}
      getSnapshot={getSnapshot}
    />
  );
  return (
    <BotProfileLayout
      avatar={<Html html={botAvatarHtml({ name })} />}
      identity={identity}
      tabs={<BotDefaultsTabs active={tab} tabs={tabs} onChange={props.onTabChange} />}
    >
      <BotProfileRequestContext.Provider value={request}>
        <div className="bd-body bd-tab-panels">
          {!config && !error ? <LoadingState label={tr('common.loading')} /> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div id="bd-panel-common" role="tabpanel" aria-labelledby="bd-tab-common" className="bd-tab-panel" hidden={tab !== 'common'}>
            <BdTabGrid>
              {nativeTiles('common')}
              {shows('agent') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('agent')}>
                  <BotAgentSection {...sectionProps.agent} bot={bot} sessionFallback={config?.cli ?? ''} cliState={props.cliState} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('working-dir') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('working-dir')}>
                  <WorkingDirSection capabilities={caps} bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
                </section>
              ) : null}
              {shows('role') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('role')}>
                  <RoleSection {...sectionProps.role} bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
            </BdTabGrid>
          </div>
          <div id="bd-panel-sessions" role="tabpanel" aria-labelledby="bd-tab-sessions" className="bd-tab-panel" hidden={tab !== 'sessions'}>
            <BdTabGrid>
              {nativeTiles('sessions')}
              {shows('session-mode') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('session-mode')}>
                  <SessionModeSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
                </section>
              ) : null}
              {shows('command-trigger') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('command-trigger')}>
                  <CommandTriggerSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('session-cap') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('session-cap')}>
                  <SessionCapSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('codex-archive') && bot.cliId === 'codex' ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('codex-archive')}>
                  <CodexArchiveSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('prompt-cache') && bot.cliId === 'claude-code' ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('prompt-cache')}>
                  <PromptCacheSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('startup-commands') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('startup-commands')}>
                  <StartupCommandsSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
            </BdTabGrid>
          </div>
          <div id="bd-panel-security" role="tabpanel" aria-labelledby="bd-tab-security" className="bd-tab-panel" hidden={tab !== 'security'}>
            <BdTabGrid>
              {nativeTiles('security')}
              {shows('sandbox') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('sandbox')}>
                  <SandboxSection bot={bot} patchBot={patchBot} />
                  <NetworkPolicySection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('codex-auth') && bot.cliId === 'codex' ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('codex-auth')}>
                  <CodexAuthSection {...sectionProps.codexAuth} bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('sandbox-paths') && bot.sandboxMode === 'oncall' ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('sandbox-paths')}>
                  <SandboxPathsSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('slash-commands') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('slash-commands')}>
                  <SlashCommandPermissionsSection {...sectionProps.slashCommands} bot={bot} patchBot={patchBot} />
                  {/* 对话权限用户可用的命令：企业微信专属区块，合放在这一格（登记表里 tile 指向 slash-commands）。 */}
                  {shows(WECOM_TALK_COMMANDS_SECTION_ID) ? (
                    <WecomTalkCommandsSection
                      value={config?.native}
                      save={patch => save({ native: { ...getSnapshot()?.native, ...patch.native } })}
                    />
                  ) : null}
                </section>
              ) : null}
              {shows('blocked-users') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('blocked-users')}>
                  <WecomAccessSettings config={config} save={save} />
                </section>
              ) : null}
            </BdTabGrid>
          </div>
          <div id="bd-panel-cards" role="tabpanel" aria-labelledby="bd-tab-cards" className="bd-tab-panel" hidden={tab !== 'cards'}>
            {/* 整行格子放在最前：瀑布流里整行格子从最高那一栏下面开始，排在单栏格子后面会在矮的那一栏留下大块空白。 */}
            <BdTabGrid>
              {shows('card-behavior') ? (
                <section className="bd-tile bd-tile-wide" id={botDefaultsSectionDomId('card-behavior')}>
                  <CardBehaviorSection bot={bot} putCardPref={putCardPref} {...sectionProps.cardBehavior} />
                </section>
              ) : null}
              {shows('feedback') ? (
                <section className="bd-tile bd-tile-wide" id={botDefaultsSectionDomId('feedback')}>
                  <FeedbackSettingsSection bot={bot} patchBot={patchBot} active={tab === 'cards'} {...sectionProps.feedback} />
                </section>
              ) : null}
              {nativeTiles('cards')}
              {shows('long-task-reminder') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('long-task-reminder')}>
                  <LongTaskReminderSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('local-address') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('local-address')}>
                  <LocalAddressSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
                </section>
              ) : null}
              {shows('brand') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('brand')}>
                  <BrandSection bot={bot} patchBot={patchBot} brandEnabled />
                </section>
              ) : null}
            </BdTabGrid>
          </div>
          <div id="bd-panel-advanced" role="tabpanel" aria-labelledby="bd-tab-advanced" className="bd-tab-panel" hidden={tab !== 'advanced'}>
            {/* 同上：整行的启动环境格子放在最前，企业微信专属格子和其余单栏格子排在它下面。 */}
            <BdTabGrid>
              {shows('runtime-env') ? (
                <section className="bd-tile bd-tile-wide" id={botDefaultsSectionDomId('runtime-env')}>
                  <RuntimeEnvironmentSection
                    bot={bot}
                    patchBot={patchBot}
                    environmentEditor={<WecomEnvironmentSettings id={connection.id} config={config} save={save} />}
                  />
                </section>
              ) : null}
              {nativeTiles('advanced')}
              {shows('backend') && !isRemoteCliId(bot.cliId) ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('backend')}>
                  <BackendTypeSection {...sectionProps.backend} bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('herdr') && herdrConfigVisible(bot) ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('herdr')}>
                  <HerdrConfigSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('codex-app-display') && (bot.cliId === 'codex' || bot.cliId === 'codex-app') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('codex-app-display')}>
                  <CodexAppDisplaySection bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
                </section>
              ) : null}
              {shows('prompt-injection') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('prompt-injection')}>
                  <PromptInjectionSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('owner-reminder') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('owner-reminder')}>
                  <SessionOwnerReminderSection bot={bot} patchBot={patchBot} />
                </section>
              ) : null}
              {shows('sender-tag') ? (
                <section className="bd-tile" id={botDefaultsSectionDomId('sender-tag')}>
                  <SenderTagSection {...sectionProps.senderTag} bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
                </section>
              ) : null}
              {caps.runtimeStatus ? (
                <section className="bd-tile" data-runtime-status>
                  <BotSettingSection title={tr('botDefaults.wecom.runtimeStatusTitle')}>
                    <BotRuntimeStatus
                      state={connection.gateway}
                      connected={connected}
                      diagnostics={connection.diagnostics}
                      notes={runtimeNotes}
                      // 服务端说明只在没有结构化说明时显示（停止原因等已由上面的说明逐条翻译）。
                      message={props.error ?? (notesExplainMessage ? undefined : connection.message)}
                      busy={props.pending}
                      supportsLifecycle={caps.lifecycle}
                      canStart={connection.canStart}
                      canStop={connection.canStop}
                      canRestart={connection.canRestart}
                      onStart={() => props.onAction(connection.id, 'start')}
                      onRestart={() => props.onAction(connection.id, 'restart')}
                      onStop={() => props.onAction(connection.id, 'stop')}
                    />
                  </BotSettingSection>
                </section>
              ) : null}
            </BdTabGrid>
          </div>
        </div>
      </BotProfileRequestContext.Provider>
    </BotProfileLayout>
  );
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

type StateWriteFailureCause = NonNullable<WecomConnectionDto['stateWriteFailure']>['cause'];

/** 状态文件写入失败时说明里的「原因」，按服务端给出的类别取（类别表见 im/wecom/contract/state-write-failure.ts）。 */
export const WECOM_STATE_WRITE_REASON_KEYS: Record<StateWriteFailureCause, string> = {
  disk_full: 'botDefaults.wecom.stateWriteReasonDiskFull',
  quota_exceeded: 'botDefaults.wecom.stateWriteReasonQuotaExceeded',
  permission_denied: 'botDefaults.wecom.stateWriteReasonPermissionDenied',
  read_only: 'botDefaults.wecom.stateWriteReasonReadOnly',
  io_error: 'botDefaults.wecom.stateWriteReasonIoError',
  path_unusable: 'botDefaults.wecom.stateWriteReasonPathUnusable',
  too_many_open_files: 'botDefaults.wecom.stateWriteReasonTooManyOpenFiles',
  other: 'botDefaults.wecom.stateWriteReasonOther',
  unknown: 'botDefaults.wecom.stateWriteReasonUnknown',
};

/** 同上，说明里的「处理办法」。 */
export const WECOM_STATE_WRITE_ACTION_KEYS: Record<StateWriteFailureCause, string> = {
  disk_full: 'botDefaults.wecom.stateWriteActionDiskFull',
  quota_exceeded: 'botDefaults.wecom.stateWriteActionQuotaExceeded',
  permission_denied: 'botDefaults.wecom.stateWriteActionPermissionDenied',
  read_only: 'botDefaults.wecom.stateWriteActionReadOnly',
  io_error: 'botDefaults.wecom.stateWriteActionIoError',
  path_unusable: 'botDefaults.wecom.stateWriteActionPathUnusable',
  too_many_open_files: 'botDefaults.wecom.stateWriteActionTooManyOpenFiles',
  other: 'botDefaults.wecom.stateWriteActionOther',
  unknown: 'botDefaults.wecom.stateWriteActionUnknown',
};

/**
 * 卡片头部名字旁的状态：在线（带绿色）、连接中或未启动。状态文件写入失败的网关仍连着企业微信，
 * 但已不再处理消息，显示为「已停止处理消息」，不带绿色。
 */
export function wecomCardMeta(connection: WecomConnectionDto, tr: Translate): { text: string; online: boolean } {
  if (connection.stateWriteFailure) {
    return { text: tr('botDefaults.wecom.metaStateWriteFailed'), online: false };
  }
  if (connection.connection === 'connected') {
    return { text: tr('botDefaults.metaOnline'), online: true };
  }
  return {
    text: connection.gateway === 'running' ? tr('botDefaults.wecom.connecting') : tr('botDefaults.metaOffline'),
    online: false,
  };
}

/** 状态文件写入失败的说明：错误码与原因、从何时起停止处理、怎么办、状态目录。 */
function stateWriteFailureNote(failure: NonNullable<WecomConnectionDto['stateWriteFailure']>, tr: Translate): string {
  const cause: StateWriteFailureCause = Object.hasOwn(WECOM_STATE_WRITE_REASON_KEYS, failure.cause) ? failure.cause : 'unknown';
  return tr('botDefaults.wecom.stateWriteFailed', {
    // 「其它」类别的原因里已经有错误码，开头不再重复。
    code: failure.code && cause !== 'other' ? tr('botDefaults.wecom.stateWriteCode', { code: failure.code }) : '',
    reason: tr(WECOM_STATE_WRITE_REASON_KEYS[cause], { code: failure.code ?? '' }),
    time: fmtSince(failure.at),
    action: tr(WECOM_STATE_WRITE_ACTION_KEYS[cause]),
    directory: failure.directory,
  });
}

/**
 * 运行状态下方的说明，逐条翻译：状态文件写入失败（排在最前：网关看似在线、其实已不再处理消息）、
 * 进行中的操作、「已记为运行但当前未运行」及原因、网关自停的原因、
 * 「配置已更改，重启后生效」（只在确实要重启时）、新设置尚未交给 core（正在重试）、迁移 / 文件不可读等提示、
 * 上一次没有完成的操作。没有这些时返回空数组，
 * 由调用方显示服务端的说明（外部实例、无法核验等）。
 */
export function wecomRuntimeNotes(connection: WecomConnectionDto, tr: Translate): string[] {
  const notes: string[] = [];
  if (connection.stateWriteFailure) notes.push(stateWriteFailureNote(connection.stateWriteFailure, tr));
  const operation = connection.operation?.action;
  if (operation === 'start') notes.push(tr('botDefaults.wecom.operationStart'));
  if (operation === 'stop') notes.push(tr('botDefaults.wecom.operationStop'));
  if (operation === 'restart') notes.push(tr('botDefaults.wecom.operationRestart'));
  const notRunning = connection.notRunning;
  if (notRunning) {
    const exit = { exitCode: notRunning.exitCode ?? '?', restarts: notRunning.restarts ?? 0 };
    const causes: Record<NonNullable<WecomConnectionDto['notRunning']>['cause'], string> = {
      fleet_down: tr('botDefaults.wecom.notRunningFleetDown'),
      fleet_unknown: tr('botDefaults.wecom.notRunningFleetUnknown'),
      not_in_fleet: tr('botDefaults.wecom.notRunningNotInFleet'),
      restarting: tr('botDefaults.wecom.notRunningRestarting', exit),
      errored: tr('botDefaults.wecom.notRunningErrored', exit),
      stopped: tr('botDefaults.wecom.notRunningStopped'),
      exited: tr('botDefaults.wecom.notRunningExited'),
    };
    notes.push(tr('botDefaults.wecom.notRunning', { cause: causes[notRunning.cause] }));
  }
  if (connection.stopReason) {
    // Only the variable's name ever reaches the page, never its value.
    const credentialEnvMissing = connection.credentialEnv
      ? tr('botDefaults.wecom.stopReasonCredentialEnvMissingNamed', { name: connection.credentialEnv })
      : tr('botDefaults.wecom.stopReasonCredentialEnvMissing');
    const reasons: Record<NonNullable<WecomConnectionDto['stopReason']>, string> = {
      replaced: tr('botDefaults.wecom.stopReasonReplaced'),
      authentication_failed: tr('botDefaults.wecom.stopReasonAuthenticationFailed'),
      invalid_configuration: tr('botDefaults.wecom.stopReasonInvalidConfiguration'),
      credential_env_missing: credentialEnvMissing,
      not_configured: tr('botDefaults.wecom.stopReasonNotConfigured'),
      instance_busy: tr('botDefaults.wecom.stopReasonInstanceBusy'),
    };
    notes.push(tr('botDefaults.wecom.stoppedBecause', { reason: reasons[connection.stopReason] }));
  }
  if (connection.restartRequired) notes.push(tr('botDefaults.wecom.restartRequired'));
  if (connection.configApplyRetrying) notes.push(tr('botDefaults.wecom.configApplyRetrying'));
  const notice = connection.notice;
  if (notice === 'legacy_gateway') notes.push(tr('botDefaults.wecom.noticeLegacyGateway'));
  if (notice === 'legacy_leftover') notes.push(tr('botDefaults.wecom.noticeLegacyLeftover'));
  if (notice === 'desired_state_unavailable') notes.push(tr('botDefaults.wecom.noticeDesiredStateUnavailable'));
  if (notice === 'registry_unavailable') notes.push(tr('botDefaults.wecom.noticeRegistryUnavailable'));
  if (notice === 'stop_pending') notes.push(tr('botDefaults.wecom.noticeStopPending'));
  if (notice === 'no_connection_evidence') notes.push(tr('botDefaults.wecom.noticeNoConnectionEvidence'));
  const failure = connection.lastFailure;
  if (failure) {
    const detail = { reason: failure.reason, message: failure.message };
    if (failure.action === 'start') notes.push(tr('botDefaults.wecom.lastFailureStart', detail));
    if (failure.action === 'stop') notes.push(tr('botDefaults.wecom.lastFailureStop', detail));
    if (failure.action === 'restart') notes.push(tr('botDefaults.wecom.lastFailureRestart', detail));
  }
  return notes;
}

/**
 * 一个分类页签里的企业微信专属格子：本地核心策略（安全页「授权与额度」、卡片页的可操作终端开关、高级页
 * 「额度耗尽交接」）与原生平台设置（会话页「/summary 总结范围」）。每一格都登记在 BOT_DEFAULTS_SECTIONS 里
 * （id 见 wecomNativeSectionId），出不出现问 `shows`：登记表里没有的格子不出现。
 */
function WecomNativeTiles(props: {
  tab: BotDefaultsTab;
  shows(id: string): boolean;
  connectionId: string;
  config?: WecomBotConfiguration;
  save(patch: WecomBotConfigurationPatch): Promise<void>;
  getSnapshot(): WecomBotConfiguration | undefined;
}) {
  const { tab, shows, connectionId, config, save, getSnapshot } = props;
  const coreId = wecomNativeSectionId('core', tab);
  const platformId = wecomNativeSectionId('platform', tab);
  return (
    <>
      {shows(coreId) ? (
        <WecomNativeCoreSection
          id={botDefaultsSectionDomId(coreId)}
          connectionId={connectionId}
          value={config?.native}
          save={patch => save({ native: { ...getSnapshot()?.native, ...patch.native } })}
          tab={tab}
        />
      ) : null}
      {shows(platformId) ? (
        <WecomNativePlatformSection
          id={botDefaultsSectionDomId(platformId)}
          value={config?.native}
          save={patch => save({ native: { ...getSnapshot()?.native, ...patch.native } })}
        />
      ) : null}
    </>
  );
}

function WecomAccessSettings({ config, save }: { config?: WecomBotConfiguration; save(patch: WecomBotConfigurationPatch): Promise<void> }) {
  const tr = useT();
  const [allowed, setAllowed] = useState((config?.allowedUsers ?? []).join('\n'));
  const [blocked, setBlocked] = useState((config?.blockedUsers ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const parse = (value: string) => value.split(/[\s,]+/).filter(Boolean);
  const onSave = () => {
    setBusy(true);
    void save({ allowedUsers: parse(allowed), blockedUsers: parse(blocked) })
      .then(() => setStatus({ ok: true, text: tr('botDefaults.wecom.accessSaved') }))
      .catch(error => setStatus({ text: error.message }))
      .finally(() => setBusy(false));
  };
  // 这个格子登记为 blocked-users 区块（⌘K 落点不变）；企业微信同时管允许名单，标题用企业微信专属变体。
  return (
    <BotSettingSection title={tr('botDefaults.wecom.accessTitle')}>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.wecom.allowedUsersLabel')}</span>
          <textarea aria-label={tr('botDefaults.wecom.allowedUsersAria')} value={allowed} onChange={event => setAllowed(event.target.value)} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.wecom.blockedUsersLabel')}</span>
          <textarea aria-label={tr('botDefaults.wecom.blockedUsersLabel')} value={blocked} onChange={event => setBlocked(event.target.value)} />
        </label>
      </div>
      <BotSettingActions action="save-access" label={tr('botDefaults.save')} busy={busy} status={status} onSave={onSave} />
    </BotSettingSection>
  );
}

function WecomEnvironmentSettings({ id, config, save }: {
  id: string;
  config?: WecomBotConfiguration;
  save(patch: WecomBotConfigurationPatch): Promise<void>;
}) {
  const tr = useT();
  const [machineOpen, setMachineOpen] = useState(false);
  const profile = useRef(config);
  profile.current = config;
  const request = useCallback<typeof sendJson>(async (method, url, body) => {
    try {
      const current = profile.current;
      const botConfig = current?.botConfig ?? {};
      const env = { ...(botConfig.env as Record<string, string> ?? {}) };
      const unset = new Set(botConfig.envUnset as string[] ?? []);
      let policy = botConfig.envPolicy ?? { mode: 'inherit' };
      if (method === 'PUT') {
        if (url.endsWith('/env-policy')) {
          policy = (body as any).envPolicy;
          await save({ botConfig: { envPolicy: policy } });
        } else {
          for (const op of (body as any).ops) {
            delete env[op.key];
            unset.delete(op.key);
            if (op.op === 'set') env[op.key] = op.value;
            if (op.op === 'unset') unset.add(op.key);
          }
          await save({ botConfig: { env, envUnset: [...unset] } });
        }
      }
      const response = await sendJson('GET', `/api/wecom/connections/${encodeURIComponent(id)}/environment`);
      if (!response.ok || !Array.isArray(response.body.rows) || !Array.isArray(response.body.conflicts)) {
        throw new Error(tr('botDefaults.wecom.environmentReadFailed'));
      }
      return response;
    } catch (e) {
      return { ok: false, status: 400, body: { error: e instanceof Error ? e.message : tr('botDefaults.wecom.saveFailed') } } as any;
    }
  }, [save, id, tr]);
  return (
    <>
      <BotProfileRequestContext.Provider value={request}>
        <SessionEnvEditor scope={{ kind: 'bot', provider: 'wecom', larkAppId: '', profileKey: config?.revision }} />
      </BotProfileRequestContext.Provider>
      <details onToggle={event => setMachineOpen(event.currentTarget.open)}>
        <summary>{tr('botDefaults.wecom.machineEnvSummary')}</summary>
        <p>{tr('botDefaults.wecom.machineEnvHint')}</p>
        {machineOpen ? (
          <BotProfileRequestContext.Provider value={sendJson}>
            <SessionEnvEditor scope={{ kind: 'global' }} />
          </BotProfileRequestContext.Provider>
        ) : null}
      </details>
    </>
  );
}
