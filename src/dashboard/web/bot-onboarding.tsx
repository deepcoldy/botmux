import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DropdownMenu } from './dashboard-components.js';
import { fetchDetectedModels, mergeModelCandidates, modelSuggestionsForOption } from './bot-defaults.js';
import { ModelPickerField } from './field-controls.js';
import { confirm } from './confirm-modal.js';
import { t } from './ui.js';
import { cliAvailabilityStatus, useCliAvailability } from './cli-availability.js';

export const OPEN_BOT_ONBOARDING_EVENT = 'botmux:open-bot-onboarding';

/** 克隆源 Bot 里会被 cloneBotConfig 带过去、且表单里也有对应项的字段。 */
export type CloneSourceDefaults = {
  cliId?: string;
  cliLaunchMode?: 'forge-traex';
  workingDir?: string;
  dirMode?: 'card' | 'fixed';
  model?: string;
};

let cloneSourceAppId: string | undefined;
let cloneSourceDefaults: CloneSourceDefaults | undefined;

type OnboardingStatus =
  | 'starting'
  | 'waiting_for_scan'
  | 'verifying'
  | 'configuring_permissions'
  | 'waiting_for_platform_scan'
  | 'needs_owner'
  | 'completed'
  | 'failed';

type OnboardingPermission = {
  ok: boolean;
  scopeCount?: number;
  skippedScopeCount?: number;
  versionId?: string;
  scopeWarning?: string;
  eventWarning?: string;
  /** 与 ok 独立：权限/发版全绿也可能没写上 redirect 白名单（见服务端同名字段注释）。 */
  redirectConfigured?: boolean;
  redirectWarning?: string;
  reason?: string;
  message?: string;
};

type RemainingStep = { title: string; url: string };

type OnboardingJob = {
  id: string;
  status: OnboardingStatus;
  qrUrl?: string;
  qrDataUrl?: string;
  platformQrDataUrl?: string;
  permissionStatusMsg?: string;
  appId?: string;
  appName?: string;
  registrationMode?: 'sdk' | 'web' | 'compat';
  cliId?: string;
  workingDir?: string;
  addedBotIndex?: number;
  liveStarted?: boolean;
  liveStartMessage?: string;
  permission?: OnboardingPermission;
  remainingSteps?: RemainingStep[];
  /** needs_owner 时的预填建议（创建应用所用账号的邮箱）。 */
  suggestedOwner?: string;
  error?: string;
  message?: string;
};

type CliOption = {
  id: string;
  label: string;
  gateway?: 'ttadk';
  acceptsModel?: boolean;
  available?: boolean;
  availabilityStatus?: import('../../setup/cli-availability.js').CliAvailabilityStatus;
  command?: string;
  availabilityReason?: string;
  cliLaunchMode?: 'forge-traex';
  /** 静态模型候选（与 bot-defaults.ts 的 CliOption 对齐）。 */
  modelChoices?: readonly string[];
};

type CliOptionsState = {
  options: CliOption[];
  ttadkModelDefault: string;
  ttadkModelSuggestions: string[];
  suggestedAppName: string;

};

type OnboardingFormState = {
  appName: string;
  cliId: string;
  dirMode: 'fixed' | 'card';
  workingDir: string;
  model: string;
};

type ViewState =
  | { kind: 'form'; error?: string }
  | { kind: 'job'; job: OnboardingJob; ownerError?: string };

const DEFAULT_CLI_OPTION: CliOption = { id: 'claude-code', label: 'Claude' };
const DEFAULT_TTADK_MODEL = 'glm-5.1';

function defaultCliOptionsState(): CliOptionsState {
  return {
    options: [DEFAULT_CLI_OPTION],
    ttadkModelDefault: DEFAULT_TTADK_MODEL,
    ttadkModelSuggestions: [],
    suggestedAppName: 'botmux-0',
  };
}

function defaultFormState(): OnboardingFormState {
  return {
    appName: '',
    cliId: DEFAULT_CLI_OPTION.id,
    dirMode: 'fixed',
    workingDir: '~',
    model: '',
  };
}

function caughtErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldStopPolling(job: OnboardingJob): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'needs_owner';
}

function isSessionFailure(error?: string): boolean {
  return error === 'login_failed'
    || error === 'invalid_session'
    || error === 'identity_unavailable'
    || error === 'session_changed';
}

function statusText(job: OnboardingJob): string {
  if (job.status === 'waiting_for_scan') {
    if (job.registrationMode === 'sdk') return t('botOnboarding.waitingSdk', { name: job.appName ?? '' });
    return job.registrationMode === 'compat'
      ? t('botOnboarding.waitingCompat')
      : t('botOnboarding.waiting', { name: job.appName ?? '' });
  }
  if (job.status === 'verifying') return t('botOnboarding.verifying');
  if (job.status === 'configuring_permissions') {
    return job.permissionStatusMsg
      ? `${t('botOnboarding.configuringPermissions')} ${job.permissionStatusMsg}`
      : t('botOnboarding.configuringPermissions');
  }
  if (job.status === 'waiting_for_platform_scan') return t('botOnboarding.platformScanHint');
  if (job.status === 'needs_owner') return t('botOnboarding.needsOwnerTitle');
  if (job.status === 'completed') return t('botOnboarding.completed', { name: job.appName ?? t('botOnboarding.botFallback') });
  if (job.status === 'failed') {
    if (job.appId) return t('botOnboarding.partialFailureTitle');
    if ((job.error === 'qr_expired' || job.error === 'expired')) return t('botOnboarding.qrExpiredTitle');
    if (isSessionFailure(job.error)) return t('botOnboarding.authIncompleteTitle');
    return t('botOnboarding.createFailedTitle');
  }
  return t('botOnboarding.starting');
}

async function fetchCliOptions(): Promise<CliOptionsState> {
  try {
    const res = await fetch('/api/cli-options?probe=none');
    const body = await res.json();
    if (res.ok && Array.isArray(body?.options)) {
      const ttadkModelDefault = typeof body.ttadkModelDefault === 'string' && body.ttadkModelDefault.trim()
        ? body.ttadkModelDefault.trim()
        : DEFAULT_TTADK_MODEL;
      const ttadkModelSuggestions = Array.isArray(body.ttadkModelSuggestions)
        ? body.ttadkModelSuggestions.filter((item: unknown): item is string => typeof item === 'string')
        : [];
      const suggestedAppName = typeof body.suggestedAppName === 'string' && body.suggestedAppName.trim()
        ? body.suggestedAppName.trim()
        : 'botmux-0';
      return {
        options: (body.options as any[]).map((o: any) => ({
          ...o,
          // 容错：缺失/非数组 → []，与 bot-defaults.ts 的 fetchCliOptions 对齐。
          modelChoices: Array.isArray(o?.modelChoices)
            ? o.modelChoices.filter((m: unknown): m is string => typeof m === 'string')
            : [],
        })) as CliOption[],
        ttadkModelDefault,
        ttadkModelSuggestions,
        suggestedAppName,
      };
    }
  } catch { /* fall through to default */ }
  return defaultCliOptionsState();
}

function syncModelForCli(
  form: OnboardingFormState,
  cliId: string,
  cliState: CliOptionsState,
): OnboardingFormState {
  const option = cliState.options.find(item => item.id === cliId);
  const isTtadk = option?.gateway === 'ttadk';
  const acceptsModel = isTtadk && option?.acceptsModel !== false;
  let model = form.model;
  if (isTtadk && !acceptsModel) {
    model = '';
  } else if (acceptsModel && !model.trim()) {
    model = cliState.ttadkModelDefault;
  } else if (!acceptsModel && model.trim() === cliState.ttadkModelDefault) {
    model = '';
  }
  return { ...form, cliId, model };
}

function normalizeFormForOptions(form: OnboardingFormState, cliState: CliOptionsState): OnboardingFormState {
  const cliId = cliState.options.some(item => item.id === form.cliId)
    ? form.cliId
    : cliState.options[0]?.id ?? DEFAULT_CLI_OPTION.id;
  return syncModelForCli({
    ...form,
  }, cliId, cliState);
}

/**
 * 从克隆源 Bot 的配置行推出表单预填值。
 *
 * 目录必须按**源自己的形态**映射，不能一律 fixed：源只有 workingDir 时若按
 * fixed 预填，目标会带上 defaultWorkingDir，而后端取目录是
 * `defaultWorkingDir ?? workingDir` —— 目标那个 '~' 会反过来把源目录遮蔽掉，
 * 新会话直接在 ~ 起，源的仓库目录静默丢失。
 */
export function cloneSourceDefaultsFrom(source: {
  cliId?: string | null;
  agentSelectionKey?: string | null;
  defaultWorkingDir?: string | null;
  workingDir?: string | null;
  model?: string | null;
} | undefined): CloneSourceDefaults | undefined {
  if (!source) return undefined;
  return {
    ...((source.agentSelectionKey || source.cliId) ? { cliId: source.agentSelectionKey || source.cliId! } : {}),
    ...(source.defaultWorkingDir
      ? { workingDir: source.defaultWorkingDir, dirMode: 'fixed' as const }
      : source.workingDir
        ? { workingDir: source.workingDir, dirMode: 'card' as const }
        : {}),
    ...(source.model ? { model: source.model } : {}),
  };
}

/**
 * 把克隆源的配置铺进表单初值。只覆盖源上确实有值的项，其余保持普通新建的默认，
 * 这样表单展示的就是克隆真正会用的配置（cloneBotConfig 之后仍以源为准）。
 */
export function applyCloneDefaults(
  form: OnboardingFormState,
  defaults: CloneSourceDefaults | undefined,
): OnboardingFormState {
  if (!defaults) return form;
  return {
    ...form,
    ...(defaults.cliId ? { cliId: defaults.cliId } : {}),
    ...(defaults.workingDir ? { workingDir: defaults.workingDir } : {}),
    ...(defaults.dirMode ? { dirMode: defaults.dirMode } : {}),
    ...(defaults.model ? { model: defaults.model } : {}),
  };
}

/**
 * 克隆时用源 Bot 的配置预填表单：后端 cloneBotConfig 会用源 Bot 的
 * cliId / 目录 / model 覆盖表单值，所以表单必须显示**真正会被使用的**那份，
 * 否则用户填了却被静默丢弃（看到 claude-code，建出来却是源 Bot 的 codex）。
 */
export async function openBotOnboarding(
  sourceAppId?: string,
  sourceDefaults?: CloneSourceDefaults,
): Promise<void> {
  cloneSourceAppId = sourceAppId;
  cloneSourceDefaults = sourceAppId ? sourceDefaults : undefined;
  window.dispatchEvent(new Event(OPEN_BOT_ONBOARDING_EVENT));
}

/**
 * redirect 白名单没写上时的一条独立告警。
 *
 * 成功时**不加噪音**（回调地址配好本就是默认预期）；失败/未知时必须可见：这一步
 * 不阻断建 bot，但缺了它，群聊模式 / 会话群标签 / `/login` 一点授权就 20029。
 * `redirectConfigured === undefined` 走**旧快照兼容**：老 job 没有这个字段，不该
 * 凭空报警，所以只对显式 false 出提示。
 */
function RedirectWarning(props: { permission: OnboardingPermission }): React.JSX.Element | null {
  const { permission } = props;
  if (permission.redirectConfigured !== false) return null;
  return (
    <p className="hint-warn" data-onboarding-redirect-warn="">
      {permission.redirectWarning
        ? t('botOnboarding.permissionRedirectWarn', { reason: permission.redirectWarning })
        : t('botOnboarding.permissionRedirectWarnNoReason')}
    </p>
  );
}

function PermissionSummary(props: { job: OnboardingJob }): React.JSX.Element | null {
  const { job } = props;
  if ((job.status !== 'completed' && job.status !== 'needs_owner') || !job.permission) return null;
  const permission = job.permission;
  if (permission.ok) {
    const permissionLabel = job.registrationMode === 'sdk'
      ? 'botOnboarding.permissionReadback' : 'botOnboarding.permissionOk';
    const parts = [t(permissionLabel, { count: permission.scopeCount ?? 0 })];
    if (permission.skippedScopeCount && permission.skippedScopeCount > 0) {
      parts.push(t('botOnboarding.permissionSkipped', { count: permission.skippedScopeCount }));
    }
    if (permission.versionId) parts.push(t('botOnboarding.permissionVersion', { version: permission.versionId }));
    return (
      <>
        <p className="hint-ok">{parts.join(' ')}</p>
        {permission.scopeWarning ? <p className="hint-warn">{permission.scopeWarning}</p> : null}
        {permission.eventWarning ? <p className="hint-warn">{permission.eventWarning}</p> : null}
        <RedirectWarning permission={permission} />
      </>
    );
  }
  const steps = job.remainingSteps ?? [];
  return (
    <>
      <p className="hint-warn">
        {t('botOnboarding.permissionManual')}
        {permission.message ? `（${permission.message}）` : ''}
      </p>
      <RedirectWarning permission={permission} />
      {steps.length ? (
        <ol className="onboarding-steps">
          {steps.map(step => (
            <li key={`${step.title}:${step.url}`}>
              <a href={step.url} target="_blank" rel="noopener">{step.title}</a>
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

function OnboardingMeta(props: { job: OnboardingJob }): React.JSX.Element | null {
  const { job } = props;
  if (!job.appId) return null;
  return (
    <p className="onboarding-meta">
      <b>App ID:</b> <code>{job.appId}</code>
      {job.appName ? <><span> / </span><b>{t('botOnboarding.appNameLabel')}:</b> <code>{job.appName}</code></> : null}
      {job.cliId ? <><span> / </span><b>CLI:</b> <code>{job.cliId}</code></> : null}
      {job.workingDir ? <><span> / </span><b>{t('botOnboarding.metaDir')}:</b> <code>{job.workingDir}</code></> : null}
    </p>
  );
}

function RegistrationQr({ link }: { link: string }): React.JSX.Element | null {
  const qr = useMemo(() => {
    try {
      const code = new QRCode(-1, QRErrorCorrectLevel.L);
      code.addData(link);
      code.make();
      const path = code.modules.flatMap((row, y) => row.map((on, x) => on ? `M${x + 4} ${y + 4}h1v1h-1z` : '')).join('');
      return { size: code.getModuleCount() + 8, path };
    } catch {
      return undefined;
    }
  }, [link]);
  if (!qr) return null;
  return (
    <svg className="onboarding-registration-qr" viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges" role="img" aria-label={t('botOnboarding.qrAlt')}>
      <rect width={qr.size} height={qr.size} fill="white" />
      <path d={qr.path} fill="black" />
    </svg>
  );
}

function QrCard(props: { dataUrl?: string; alt: string; link?: string }): React.JSX.Element {
  const [showQr, setShowQr] = useState(false);
  if (!props.link) {
    return <div className="qr-card"><img className="qr-image" src={props.dataUrl} alt={props.alt} /></div>;
  }
  return (
    <div className="qr-card">
      <a className="btn-link primary onboarding-link" href={props.link} target="_blank" rel="noopener noreferrer">
        {t('botOnboarding.openLink')}
      </a>
      <details className="onboarding-qr-option" onToggle={event => setShowQr(event.currentTarget.open)}>
        <summary>{t('botOnboarding.showQr')}</summary>
        {showQr && (props.dataUrl
          ? <img className="qr-image" src={props.dataUrl} alt={props.alt} />
          : <RegistrationQr link={props.link} />)}
      </details>
    </div>
  );
}

function onboardingOptionLabel<T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
): string {
  return options.find(option => option.value === value)?.label ?? value;
}

function OnboardingJobView(props: {
  view: Extract<ViewState, { kind: 'job' }>;
  ownerInput: string;
  ownerIdInput: string;
  onOwnerInputChange(value: string): void;
  onOwnerIdInputChange(value: string): void;
  onSubmitOwner(job: OnboardingJob, owner: string, ownerId: string): void;
  onRetry(mode: 'sdk' | 'compat'): void;
  onClose(): void;
}): React.JSX.Element {
  const { job, ownerError } = props.view;
  return (
    <>
      <p className={`onboarding-status status-${job.status}`}>{statusText(job)}</p>
      {job.status === 'waiting_for_scan' && (job.qrUrl || job.qrDataUrl) ? (
        <QrCard dataUrl={job.qrDataUrl} alt={t('botOnboarding.qrAlt')} link={job.qrUrl} />
      ) : null}
      {job.status === 'waiting_for_platform_scan' && job.platformQrDataUrl ? (
        <QrCard dataUrl={job.platformQrDataUrl} alt={t('botOnboarding.platformQrAlt')} />
      ) : null}
      <OnboardingMeta job={job} />
      <PermissionSummary job={job} />
      {job.status === 'needs_owner' ? (
        <form className="onboarding-form" id="ob-owner-form" onSubmit={event => {
          event.preventDefault();
          props.onSubmitOwner(job, props.ownerInput, props.ownerIdInput);
        }}>
          <label className="onboarding-field">
            <span>{t('botOnboarding.ownerLabel')}</span>
            <input
              id="ob-owner"
              type="text"
              inputMode="email"
              placeholder={t('botOnboarding.ownerPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              value={props.ownerInput}
              onChange={event => props.onOwnerInputChange(event.currentTarget.value)}
            />
          </label>
          <p className="hint-warn">{t('botOnboarding.needsOwnerDescription')}</p>
          <details className="onboarding-technical">
            <summary>{t('botOnboarding.ownerUseId')}</summary>
            <label className="onboarding-field">
              <span>{t('botOnboarding.ownerIdLabel')}</span>
              <input
                id="ob-owner-id"
                type="text"
                placeholder={t('botOnboarding.ownerIdPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                value={props.ownerIdInput}
                onChange={event => props.onOwnerIdInputChange(event.currentTarget.value)}
              />
            </label>
          </details>
          {ownerError ? <p className="form-error">{ownerError}</p> : null}
          <div className="actions onboarding-actions">
            <button type="submit" className="primary onboarding-submit">{t('botOnboarding.ownerSubmit')}</button>
          </div>
        </form>
      ) : null}
      {job.status === 'completed' ? (
        <p className="hint-ok">{job.liveStarted ? t('botOnboarding.liveOk') : t('botOnboarding.restartHint')}</p>
      ) : null}
      {job.status === 'failed' ? (
        <>
          <p className="hint-warn">
            {job.error === 'unconfirmed'
              ? job.message
              : job.appId
                ? t('botOnboarding.partialFailureDescription')
              : (job.error === 'qr_expired' || job.error === 'expired')
                ? t('botOnboarding.qrExpiredDescription')
                : isSessionFailure(job.error)
                  ? t('botOnboarding.authIncompleteDescription')
                  : t('botOnboarding.createFailedDescription')}
          </p>
          <details className="onboarding-technical">
            <summary>{t('botOnboarding.technicalDetails')}</summary>
            <code>{job.message ?? job.error ?? 'unknown'}</code>
          </details>
          <div className="actions onboarding-actions">
            <button type="button" onClick={props.onClose}>{t('botOnboarding.close')}</button>
            {!job.appId && job.error !== 'unconfirmed' ? (
              <>
                <button type="button" onClick={() => props.onRetry('compat')}>{t('botOnboarding.compatibilityMode')}</button>
                <button type="button" className="primary onboarding-submit" onClick={() => props.onRetry('sdk')}>
                  {(job.error === 'qr_expired' || job.error === 'expired')
                    ? t('botOnboarding.generateQr')
                    : isSessionFailure(job.error)
                      ? t('botOnboarding.scanAgain')
                      : t('botOnboarding.retry')}
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      {job.status === 'completed' ? <div className="actions onboarding-actions">
        <button type="button" onClick={props.onClose}>{t('botOnboarding.close')}</button>
      </div> : null}
    </>
  );
}

function OnboardingForm(props: {
  cliState: CliOptionsState;
  form: OnboardingFormState;
  error?: string;
  submitting: boolean;
  onFormChange(form: OnboardingFormState): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onClose(): void;
}): React.JSX.Element {
  const selectedCli = props.cliState.options.find(option => option.id === props.form.cliId);
  const availabilityStatus = useCliAvailability(props.form.cliId, selectedCli);
  const modelDisabled = selectedCli?.gateway === 'ttadk' && selectedCli.acceptsModel === false;
  // live 探测当前 CLI 的可用模型（ttadk 网关项保持现状，只用静态建议列表）。
  const [detectedModels, setDetectedModels] = useState<{ models: string[]; source: 'live' | 'static' } | null>(null);
  const cliId = props.form.cliId;
  useEffect(() => {
    if (selectedCli?.gateway === 'ttadk') {
      setDetectedModels(null);
      return;
    }
    // stale 标志防卸载/竞态：cliId 快速切换时旧响应不得覆盖新 CLI 的候选。
    let stale = false;
    fetchDetectedModels(cliId).then(result => { if (!stale) setDetectedModels(result); });
    return () => { stale = true; };
    // 只按 cliId 重新探测；cliState 刷新的静态候选经 modelSuggestionsForOption 合入。
  }, [cliId]);
  const modelCandidates = mergeModelCandidates(
    modelSuggestionsForOption(selectedCli, props.cliState),
    detectedModels?.models ?? null,
  );
  const detectedLiveCount = detectedModels?.source === 'live' ? detectedModels.models.length : 0;
  const dirLabel = props.form.dirMode === 'card' ? t('botOnboarding.dirLabelCard') : t('botOnboarding.dirLabelFixed');
  const dirPlaceholder = props.form.dirMode === 'card'
    ? t('botOnboarding.dirPlaceholderCard')
    : t('botOnboarding.dirPlaceholderFixed');
  // 按名称首字母排序，方便在 20+ 个 CLI 里定位；排序用原始 label（缺失告警前缀不参与）。
  const cliOptions = [...props.cliState.options]
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))
    .map(option => ({
      value: option.id,
      label: (option.id === props.form.cliId ? availabilityStatus : cliAvailabilityStatus(option)) === 'unavailable'
        ? t('botOnboarding.cliMissingOption', { label: option.label, command: option.command ?? option.id })
        : option.label,
    }));
  const dirModeOptions: Array<{ value: OnboardingFormState['dirMode']; label: string }> = [
    { value: 'fixed', label: t('botOnboarding.dirModeFixed') },
    { value: 'card', label: t('botOnboarding.dirModeCard') },
  ];

  return (
    <form id="onboarding-form" className="onboarding-form" onSubmit={props.onSubmit}>
      <label className="onboarding-field">
        <span>{t('botOnboarding.appNameLabel')}</span>
        <input
          id="ob-app-name"
          type="text"
          maxLength={64}
          value={props.form.appName}
          placeholder={t('botOnboarding.appNamePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={event => props.onFormChange({ ...props.form, appName: event.currentTarget.value })}
        />
        <small className="onboarding-field-hint">{t('botOnboarding.appNameHint', { name: props.cliState.suggestedAppName })}</small>
      </label>
      <div className="onboarding-field">
        <span>{t('botOnboarding.cliLabel')}</span>
        <DropdownMenu
          id="ob-cli"
          className="onboarding-menu"
          ariaLabel={t('botOnboarding.cliLabel')}
          label={onboardingOptionLabel(cliOptions, props.form.cliId)}
          value={props.form.cliId}
          options={cliOptions}
          searchable
          searchPlaceholder={t('common.dropdownSearch')}
          searchEmptyLabel={t('common.dropdownSearchEmpty')}
          onChange={cliId => {
            props.onFormChange(syncModelForCli(props.form, cliId, props.cliState));
          }}
        />
        {availabilityStatus === 'unavailable' ? (
          <small className="hint-warn">
            {t('botOnboarding.cliMissingHint', { command: selectedCli?.command ?? props.form.cliId })}
          </small>
        ) : <small className="onboarding-field-hint">{props.form.cliId}</small>}
      </div>
      <div className="onboarding-field">
        <span>{t('botOnboarding.dirModeLabel')}</span>
        <DropdownMenu
          id="ob-dir-mode"
          className="onboarding-menu"
          ariaLabel={t('botOnboarding.dirModeLabel')}
          label={onboardingOptionLabel(dirModeOptions, props.form.dirMode)}
          value={props.form.dirMode}
          options={dirModeOptions}
          onChange={dirMode => props.onFormChange({ ...props.form, dirMode })}
        />
      </div>
      <label className="onboarding-field">
        <span>{dirLabel}</span>
        <input
          id="ob-dir"
          type="text"
          value={props.form.workingDir}
          placeholder={dirPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={event => props.onFormChange({ ...props.form, workingDir: event.currentTarget.value })}
        />
      </label>
      {!modelDisabled ? (
        <div className="onboarding-field">
          <span>{t('botOnboarding.modelLabel')}</span>
          <ModelPickerField
            key={props.form.cliId}
            value={props.form.model}
            onChange={model => props.onFormChange({ ...props.form, model })}
            options={modelCandidates}
            dataInput="ob-model"
            ariaLabel={t('botOnboarding.modelLabel')}
            defaultLabel={t('botDefaults.modelPickerDefault')}
            customLabel={t('botDefaults.modelPickerCustom')}
            includeDefault
            menuClassName="onboarding-menu"
            detectedCount={detectedLiveCount || undefined}
            detectedLabel={detectedLiveCount > 0
              ? t('botDefaults.modelPickerDetected', { count: detectedLiveCount })
              : undefined}
          />
        </div>
      ) : null}
      {props.error ? <p className="form-error">{props.error}</p> : null}
      <div className="actions onboarding-actions">
        <button type="button" id="ob-cancel" disabled={props.submitting} onClick={props.onClose}>{t('botOnboarding.cancel')}</button>
        <button
          type="submit"
          className="primary onboarding-submit"
          // The option-list probe is intentionally PATH-only so opening the
          // form never blocks the dashboard event loop on shell rc files. It is
          // a useful warning, not an authoritative gate: submit runs the full
          // shell-aware server check and returns cli_not_found when necessary.
          disabled={props.submitting}
        >
          {props.submitting
            ? t('botOnboarding.starting')
            : t('botOnboarding.startScan')}
        </button>
      </div>
    </form>
  );
}

export function BotOnboardingDialog(props: { open: boolean; onClose(): void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);
  const [cliState, setCliState] = useState<CliOptionsState>(() => defaultCliOptionsState());
  const [form, setForm] = useState<OnboardingFormState>(() => defaultFormState());
  const [view, setView] = useState<ViewState>({ kind: 'form' });
  const [submitting, setSubmitting] = useState(false);
  const [ownerInput, setOwnerInput] = useState('');
  const [ownerIdInput, setOwnerIdInput] = useState('');

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    stopPolling();
    cloneSourceAppId = undefined;
    cloneSourceDefaults = undefined;
    props.onClose();
  }, [props, stopPolling]);

  const applyJob = useCallback((job: OnboardingJob) => {
    setView({ kind: 'job', job });
    if (job.status === 'needs_owner') {
      // 预填创建账号的邮箱（后端自动确认失败时给出），用户复核/修改后提交。
      setOwnerInput(job.suggestedOwner ?? '');
      setOwnerIdInput('');
    }
    if (shouldStopPolling(job)) stopPolling();
  }, [stopPolling]);

  const pollJob = useCallback(async (id: string) => {
    const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(id)}`);
    const body = await res.json();
    if (!res.ok || !body?.job) throw new Error(body?.error ?? `http_${res.status}`);
    applyJob(body.job as OnboardingJob);
  }, [applyJob]);

  const startPolling = useCallback((id: string) => {
    stopPolling();
    pollTimerRef.current = window.setInterval(() => {
      void pollJob(id).catch(error => {
        stopPolling();
        setView({ kind: 'job', job: { id, status: 'failed', message: caughtErrorText(error) } });
      });
    }, 1200);
  }, [pollJob, stopPolling]);

  const resetToForm = useCallback(() => {
    stopPolling();
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const initialCliState = defaultCliOptionsState();
    setCliState(initialCliState);
    // 克隆模式下用源 Bot 的值开局，让表单显示真正会生效的配置（后端克隆会用
    // 源 Bot 覆盖这几项）；普通新建仍是原来的默认值。
    setForm(applyCloneDefaults(defaultFormState(), cloneSourceDefaults));
    setView({ kind: 'form' });
    setSubmitting(false);
    setOwnerInput('');
    setOwnerIdInput('');
    void fetchCliOptions().then(next => {
      if (loadSeqRef.current !== seq) return;
      setCliState(next);
      setForm(current => normalizeFormForOptions(current, next));
    });
  }, [stopPolling]);

  useEffect(() => {
    if (props.open) {
      resetToForm();
      return;
    }
    stopPolling();
    loadSeqRef.current += 1;
  }, [props.open, resetToForm, stopPolling]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      try { dialog.showModal(); } catch { /* already opening/unsupported */ }
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  }, [props.open]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startOnboarding = useCallback(async (
    registrationMode: 'sdk' | 'compat',
  ) => {
    stopPolling();
    setSubmitting(true);
    setView({ kind: 'job', job: { id: '', status: 'starting' } });
    try {
      const res = await fetch('/api/bot-onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appName: registrationMode === 'sdk' ? form.appName.trim() || undefined : undefined,
          registrationMode,
          cliId: form.cliId,
          workingDir: form.workingDir.trim(),
          dirMode: form.dirMode,
          model: form.model.trim() || undefined,
          cloneSourceAppId,
        }),
      });
      const body = await res.json();
      if (res.status === 400) {
        setView({ kind: 'form', error: body?.message ?? body?.error ?? 'invalid_input' });
        return;
      }
      if (!res.ok || !body?.job?.id) throw new Error(body?.error ?? `http_${res.status}`);
      const job = body.job as OnboardingJob;
      applyJob(job);
      if (!shouldStopPolling(job)) startPolling(job.id);
    } catch (error) {
      setView({ kind: 'job', job: { id: '', status: 'failed', message: caughtErrorText(error) } });
    } finally {
      setSubmitting(false);
    }
  }, [applyJob, form, startPolling, stopPolling]);

  const submitForm = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void startOnboarding('sdk');
  }, [startOnboarding]);

  const retry = useCallback(async (registrationMode: 'sdk' | 'compat') => {
    if (registrationMode === 'compat') {
      const accepted = await confirm({ title: '兼容性确认', message: t('botOnboarding.compatibilityConfirm'), danger: false });
      if (!accepted) return;
    }
    void startOnboarding(registrationMode);
  }, [startOnboarding]);

  const submitOwner = useCallback(async (job: OnboardingJob, ownerRaw: string, ownerIdRaw: string) => {
    const owner = [ownerRaw.trim(), ownerIdRaw.trim()].filter(Boolean).join(',');
    if (!owner) {
      setView({ kind: 'job', job, ownerError: t('botOnboarding.ownerEmpty') });
      return;
    }
    try {
      const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(job.id)}/owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner }),
      });
      const body = await res.json();
      if (!res.ok) {
        setView({ kind: 'job', job, ownerError: body?.message ?? body?.error ?? t('botOnboarding.ownerInvalid') });
        return;
      }
      if (body?.job) applyJob(body.job as OnboardingJob);
    } catch (error) {
      setView({ kind: 'job', job, ownerError: caughtErrorText(error) });
    }
  }, [applyJob]);

  const body = useMemo(() => {
    // The dialog stays mounted in the shell from the first paint, before the
    // visitor's auth state is known. The form's CLI probes are management reads,
    // so they must not run while the dialog is closed.
    if (!props.open) return null;
    if (view.kind === 'form') {
      return (
        <OnboardingForm
          cliState={cliState}
          form={form}
          error={view.error}
          submitting={submitting}
          onFormChange={setForm}
          onSubmit={submitForm}
          onClose={close}
        />
      );
    }
    return (
      <OnboardingJobView
        view={view}
        ownerInput={ownerInput}
        ownerIdInput={ownerIdInput}
        onOwnerInputChange={setOwnerInput}
        onOwnerIdInputChange={setOwnerIdInput}
        onSubmitOwner={submitOwner}
        onRetry={retry}
        onClose={close}
      />
    );
  }, [cliState, close, form, ownerIdInput, ownerInput, props.open, retry, submitForm, submitOwner, submitting, view]);

  const canClose = view.kind === 'form' || (view.kind === 'job' && (view.job.status === 'completed' || view.job.status === 'failed'));

  return (
    <dialog
      className="onboarding-dialog"
      ref={dialogRef}
      onCancel={event => {
        if (!canClose) event.preventDefault();
      }}
      onClose={() => { if (canClose) close(); }}
      onClick={event => { if (canClose && event.target === event.currentTarget) close(); }}
    >
      <article className="onboarding-card">
        <header className="onboarding-header">
          <h3>{t('botOnboarding.title')}</h3>
          <p>{t('botOnboarding.intro')}</p>
        </header>
        {body}
      </article>
    </dialog>
  );
}
