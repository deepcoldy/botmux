import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DropdownMenu } from './dashboard-components.js';
import { cliSearchTerms, fetchDetectedModels, mergeModelCandidates, modelSuggestionsForOption } from './bot-defaults.js';
import { ModelPickerField } from './field-controls.js';
import { confirm } from './confirm-modal.js';
import { t } from './ui.js';
import { controlCsrfHeaders } from './control-csrf.js';
import type { WecomOnboardingSnapshot } from '../../im/wecom/contract/dashboard-dto.js';
import { cliAvailabilityStatus, useCliAvailability } from './cli-availability.js';
import type { ProviderId } from './providers/types.js';

import {OPEN_BOT_ONBOARDING_EVENT, BOT_ONBOARDING_COMPLETED_EVENT} from './bot-onboarding-events.js';
export {OPEN_BOT_ONBOARDING_EVENT, BOT_ONBOARDING_COMPLETED_EVENT};

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

type DeferredApprovalScopeView = {
  bucket: 'tenant' | 'user';
  name: string;
  desc?: string;
  isolation: 'exact' | 'group' | 'all_level4';
  group: string;
};

type OnboardingPermission = {
  ok: boolean;
  scopeCount?: number;
  skippedScopeCount?: number;
  versionId?: string;
  /** 提交后回读仍是草稿或状态未知；有值时不能显示已发布/已可使用。 */
  versionWarning?: string;
  scopeWarning?: string;
  /** 与 ok 独立：权限/发版全绿也可能没写上 redirect 白名单（见服务端同名字段注释）。 */
  redirectConfigured?: boolean;
  redirectWarning?: string;
  /** 版本已提交但停在「审核中」等企业管理员审批（见服务端同名字段注释）。 */
  versionPendingReview?: boolean;
  pendingReviewAppVersion?: string;
  approvalHumanApprovers?: string[];
  approvalDeferredScopes?: DeferredApprovalScopeView[];
  approvalDisabledRefreshToken?: boolean;
  approvalInitialApprovers?: string[];
  approvalConsoleUrl?: string;
  reason?: string;
  message?: string;
};

type RemainingStep = { title: string; url: string };

type OnboardingJob = {
  platform?: 'lark';
  id: string;
  status: OnboardingStatus;
  qrUrl?: string;
  qrDataUrl?: string;
  platformQrDataUrl?: string;
  permissionStatusMsg?: string;
  appId?: string;
  appName?: string;
  brand?: 'feishu' | 'lark';
  registrationMode?: 'web' | 'compat' | 'local' | 'manual';
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
  /** Launch commands and short aliases from the CLI registry, used only for search. */
  searchTerms?: readonly string[];
  availabilityReason?: string;
  cliLaunchMode?: 'forge-traex';
  /** 静态模型候选（与 bot-defaults.ts 的 CliOption 对齐）。 */
  modelChoices?: readonly string[];
};

type CliOptionsState = {
  canCreateWecomBot: boolean;
  loadFailed?: boolean;
  options: CliOption[];
  ttadkModelDefault: string;
  ttadkModelSuggestions: string[];
  suggestedAppName: string;
  webSession:
    | { status: 'checking' }
    | { status: 'scan_required'; reason?: string }
    | {
        status: 'ready';
        source: string;
        identity: {
          userId: string;
          userName: string;
          email?: string;
          tenantId: string;
          tenantName: string;
        };
      };
};

type OnboardingFormState = {
  connection: 'feishu' | 'manual' | 'local';
  brand: 'feishu' | 'lark';
  appId: string;
  appSecret: string;
  owner: string;
  appName: string;
  cliId: string;
  dirMode: 'fixed' | 'card';
  workingDir: string;
  model: string;
  autoAvoidApproval: boolean;
};

type ViewState =
  | { kind: 'form'; error?: string }
  | { kind: 'job'; job: OnboardingJob; ownerError?: string; cancelError?: string }
  | { kind: 'wecom-job'; job: WecomOnboardingSnapshot; actionError?: string };

const DEFAULT_CLI_OPTION: CliOption = { id: 'claude-code', label: 'Claude' };
const DEFAULT_TTADK_MODEL = 'glm-5.1';

function defaultCliOptionsState(): CliOptionsState {
  return {
    canCreateWecomBot: false,
    options: [DEFAULT_CLI_OPTION],
    ttadkModelDefault: DEFAULT_TTADK_MODEL,
    ttadkModelSuggestions: [],
    suggestedAppName: 'botmux-0',
    webSession: { status: 'checking' },
  };
}

function defaultFormState(): OnboardingFormState {
  return {
    connection: 'feishu',
    brand: 'feishu',
    appId: '',
    appSecret: '',
    owner: '',
    appName: '',
    cliId: DEFAULT_CLI_OPTION.id,
    dirMode: 'fixed',
    workingDir: '~',
    model: '',
    autoAvoidApproval: true,
  };
}

export function isOnboardingSubmitDisabled(
  submitting: boolean,
  sessionMode: 'checking' | 'reuse' | 'qr',
  connection: 'feishu' | 'manual' | 'local' = 'feishu',
): boolean {
  if (submitting) return true;
  if (connection === 'local' || connection === 'manual') return false;
  return sessionMode === 'checking';
}

/**
 * Pick an initial AI CLI option for fresh setups:
 * - Keep `currentCliId` when it is present and available.
 * - Otherwise auto-select the first detected local CLI executable (`Boolean(option.command)`),
 *   so users with e.g. Codex installed (without Claude) are not blocked on `claude-code`,
 *   while API-only entries without a local binary (`mira`/`riff`) are never silently chosen.
 * - If no local CLI is installed yet, stay on `currentCliId` so the install hint is shown.
 */
export function selectDefaultOnboardingCliId(
  currentCliId: string,
  options: readonly Pick<CliOption, 'id' | 'available' | 'availabilityStatus' | 'command'>[],
): string {
  const isAvailable = (opt: Pick<CliOption, 'available' | 'availabilityStatus'>) => (
    opt.availabilityStatus === 'available' || opt.available === true
  );
  const current = options.find(item => item.id === currentCliId);
  if (current && isAvailable(current)) return current.id;
  const detectedLocal = options.find(item => isAvailable(item) && Boolean(item.command));
  if (detectedLocal) return detectedLocal.id;
  if (current) return current.id;
  return options[0]?.id ?? DEFAULT_CLI_OPTION.id;
}

function caughtErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldStopPolling(job: OnboardingJob): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'needs_owner';
}

/** 企业微信接入轮询连续失败时的重试间隔：从 2.4s 起逐次翻倍，封顶 30s。 */
const WECOM_POLL_RETRY_BASE_MS = 2_400;
const WECOM_POLL_RETRY_MAX_MS = 30_000;

/**
 * 企业微信接入任务轮询失败后的下一次检查间隔：保留当前任务视图并显示错误，按指数退避继续检查
 * （飞书的轮询失败照旧停在带「重试 / 兼容模式」的失败视图，见 BotOnboardingDialog 的 startPolling）。
 */
function wecomPollRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(WECOM_POLL_RETRY_MAX_MS, WECOM_POLL_RETRY_BASE_MS * 2 ** exponent);
}

/** 企业微信接入任务到了终态就不再轮询。 */
function wecomJobTerminal(job: WecomOnboardingSnapshot): boolean {
  return ['completed', 'failed', 'cancelled'].includes(job.status);
}

function isSessionFailure(error?: string): boolean {
  return error === 'login_failed'
    || error === 'invalid_session'
    || error === 'identity_unavailable'
    || error === 'session_changed';
}

export function statusText(job: OnboardingJob): string {
  if (job.status === 'waiting_for_scan') {
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
  if (job.status === 'completed') {
    if (job.registrationMode === 'local') {
      return t('botOnboarding.completedLocal', { name: job.appName ?? t('botOnboarding.botFallback') });
    }
    if (job.registrationMode === 'manual') {
      return t('botOnboarding.completedManual', { name: job.appName ?? t('botOnboarding.botFallback') });
    }
    // 审核中、或复查发现仍是草稿/状态未知时，都不能说「已可使用」。
    if (waitingForEnterpriseReview(job.permission)) {
      return t('botOnboarding.completedReviewPending', { name: job.appName ?? t('botOnboarding.botFallback') });
    }
    if (job.permission?.ok && job.permission.versionWarning) {
      return t('botOnboarding.completedVersionWarning', { name: job.appName ?? t('botOnboarding.botFallback') });
    }
    return t('botOnboarding.completed', { name: job.appName ?? t('botOnboarding.botFallback') });
  }
  if (job.status === 'failed') {
    if (job.registrationMode === 'manual') return t('botOnboarding.createFailedTitle');
    if (job.appId) return t('botOnboarding.partialFailureTitle');
    if (job.error === 'qr_expired') return t('botOnboarding.qrExpiredTitle');
    if (isSessionFailure(job.error)) return t('botOnboarding.authIncompleteTitle');
    return t('botOnboarding.createFailedTitle');
  }
  if (job.registrationMode === 'local') return t('botOnboarding.startingLocal');
  if (job.registrationMode === 'manual') return t('botOnboarding.startingManual');
  return t('botOnboarding.starting');
}

async function fetchCliOptions(): Promise<CliOptionsState> {
  try {
    // 裸端点保留「探测登录态」的旧语义，本弹窗正是要那个 webSession（决定
    // sessionMode 走 reuse 还是 qr，并展示"将使用 …"的账号），所以不带任何
    // probe 参数。反过来 Bot 配置页显式带 `?probe=none` 跳过探测。
    // 为什么是 opt-out 而非 opt-in：见 dashboard.ts /api/cli-options 的注释
    // （immutable chunk 长缓存 + stale-chunk 自愈只覆盖 import 失败）。
    const res = await fetch('/api/cli-options');
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
      const identity = body?.webSession?.identity;
      const webSession: CliOptionsState['webSession'] = body?.webSession?.status === 'ready'
        && typeof identity?.userId === 'string'
        && typeof identity?.userName === 'string'
        && typeof identity?.tenantId === 'string'
        && typeof identity?.tenantName === 'string'
        ? {
            status: 'ready',
            source: typeof body.webSession.source === 'string' ? body.webSession.source : 'botmux_cache',
            identity: {
              userId: identity.userId,
              userName: identity.userName,
              ...(typeof identity.email === 'string' ? { email: identity.email } : {}),
              tenantId: identity.tenantId,
              tenantName: identity.tenantName,
            },
          }
        : { status: 'scan_required', ...(typeof body?.webSession?.reason === 'string' ? { reason: body.webSession.reason } : {}) };
      return {
        canCreateWecomBot: body.canCreateWecomBot === true,
        options: (body.options as any[]).map((o: any) => ({
          ...o,
          // 容错：缺失/非数组 → []；空数组由 cliSearchTerms 回退到 command。
          searchTerms: Array.isArray(o?.searchTerms)
            ? o.searchTerms.filter((term: unknown): term is string => typeof term === 'string')
            : [],
          // 容错：缺失/非数组 → []，与 bot-defaults.ts 的 fetchCliOptions 对齐。
          modelChoices: Array.isArray(o?.modelChoices)
            ? o.modelChoices.filter((m: unknown): m is string => typeof m === 'string')
            : [],
        })) as CliOption[],
        ttadkModelDefault,
        ttadkModelSuggestions,
        suggestedAppName,
        webSession,
      };
    }
  } catch { /* fall through to default */ }
  return { ...defaultCliOptionsState(), loadFailed: true, webSession: { status: 'scan_required' } };
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

function normalizeFormForOptions(
  form: OnboardingFormState,
  cliState: CliOptionsState,
  autoSelectAvailableCli = false,
): OnboardingFormState {
  const cliId = autoSelectAvailableCli
    ? selectDefaultOnboardingCliId(form.cliId, cliState.options)
    : cliState.options.some(item => item.id === form.cliId)
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

/** Shared entry for every deployment roster, including no bots and WeCom-only. */
export function BotOnboardingCreateButton(props: {className?: string; children?: React.ReactNode}): React.JSX.Element {
  return (
    <button type="button" className={props.className} onClick={() => void openBotOnboarding()}>
      {props.children ?? t('nav.createBot')}
    </button>
  );
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

/**
 * 权限/版本卡在企业管理员审核：要么本次提交的版本停在审核中，要么应用已有版本在审核、
 * 开放平台把配置写锁了（`app_under_review`）。两种都不是 botmux 卡住，也都不是重试能解决的。
 */
function waitingForEnterpriseReview(permission: OnboardingPermission | undefined): boolean {
  if (!permission) return false;
  return permission.ok ? permission.versionPendingReview === true : permission.reason === 'app_under_review';
}

function reviewPendingText(permission: OnboardingPermission): string {
  const approvers = permission.approvalHumanApprovers?.length
    ? t('botOnboarding.permissionReviewApprovers', {
        names: permission.approvalHumanApprovers.join(t('botOnboarding.listSeparator')),
      })
    : '';
  const stuckHint = t('botOnboarding.reviewStuckHint');
  return permission.pendingReviewAppVersion
    ? t('botOnboarding.permissionReviewPending', { version: permission.pendingReviewAppVersion, approvers, stuckHint })
    : t('botOnboarding.permissionReviewPendingNoVersion', { approvers, stuckHint });
}

function ApprovalDeferredNotice(props: { permission: OnboardingPermission }): React.JSX.Element | null {
  const { permission } = props;
  const deferred = permission.approvalDeferredScopes ?? [];
  const disabledRefresh = permission.approvalDisabledRefreshToken === true;
  if (deferred.length === 0 && !disabledRefresh) return null;
  const approvers = permission.approvalInitialApprovers?.length
    ? t('botOnboarding.approvalDeferredApprovers', { approvers: permission.approvalInitialApprovers.join('、') })
    : '';
  const inlineLimit = 8;
  const previewItems = deferred.slice(0, inlineLimit);
  const hasMore = deferred.length > inlineLimit;
  const renderItem = (scope: DeferredApprovalScopeView) => (
    <li key={`${scope.bucket}:${scope.name}`}>
      <code>{scope.name}</code>
      {' '}
      <small>({scope.bucket === 'tenant' ? t('botOnboarding.scopeBucketTenant') : t('botOnboarding.scopeBucketUser')})</small>
      {scope.desc ? <> — {scope.desc}</> : null}
    </li>
  );
  return (
    <div className="onboarding-approval-deferred" data-onboarding-approval-deferred="">
      {deferred.length > 0 ? (
        <p className="hint-warn">
          {t('botOnboarding.approvalDeferredSummary', { count: deferred.length, approvers })}
        </p>
      ) : null}
      {disabledRefresh ? (
        <p className="hint-warn">{t('botOnboarding.approvalDisabledRefreshToken')}</p>
      ) : null}
      {deferred.length > 0 ? (
        hasMore ? (
          <details className="onboarding-technical">
            <summary>{t('botOnboarding.approvalDeferredExpand', { count: deferred.length })}</summary>
            <ul className="onboarding-steps">{deferred.map(renderItem)}</ul>
          </details>
        ) : (
          <ul className="onboarding-steps">{previewItems.map(renderItem)}</ul>
        )
      ) : null}
      {permission.approvalConsoleUrl ? (
        <p className="hint-warn">
          <a href={permission.approvalConsoleUrl} target="_blank" rel="noopener">
            {t('botOnboarding.approvalDeferredOpenConsole')}
          </a>
        </p>
      ) : null}
    </div>
  );
}

export function PermissionSummary(props: { job: OnboardingJob }): React.JSX.Element | null {
  const { job } = props;
  if ((job.status !== 'completed' && job.status !== 'needs_owner') || !job.permission) return null;
  const permission = job.permission;
  if (permission.ok) {
    const parts = [t('botOnboarding.permissionOk', { count: permission.scopeCount ?? 0 })];
    if (permission.skippedScopeCount && permission.skippedScopeCount > 0) {
      parts.push(t('botOnboarding.permissionSkipped', { count: permission.skippedScopeCount }));
    }
    // 「已提交发布版本 x」在等审核时会被读成「已经生效」，改由下面那条审核提示说清楚。
    if (permission.versionId && !permission.versionPendingReview && !permission.versionWarning) {
      parts.push(t('botOnboarding.permissionVersion', { version: permission.versionId }));
    }
    return (
      <>
        <p className="hint-ok">{parts.join(' ')}</p>
        {permission.versionPendingReview ? (
          <p className="hint-warn" data-onboarding-review-pending="">{reviewPendingText(permission)}</p>
        ) : null}
        {permission.versionWarning ? (
          <p className="hint-warn" data-onboarding-version-warning="">{permission.versionWarning}</p>
        ) : null}
        {permission.scopeWarning ? <p className="hint-warn">{permission.scopeWarning}</p> : null}
        <ApprovalDeferredNotice permission={permission} />
        <RedirectWarning permission={permission} />
      </>
    );
  }
  const steps = job.remainingSteps ?? [];
  return (
    <>
      {waitingForEnterpriseReview(permission) ? (
        // 审核锁：开放平台此刻什么都改不了，「请手动完成」是做不到的建议；只说明在等审核、
        // 卡住时该怎么查怎么改，不把 automation 那段长说明原样贴出来。
        <p className="hint-warn" data-onboarding-review-pending="">
          {t('botOnboarding.permissionUnderReview', { stuckHint: t('botOnboarding.reviewStuckHint') })}
        </p>
      ) : (
        <p className="hint-warn">
          {t('botOnboarding.permissionManual')}
          {permission.message ? `（${permission.message}）` : ''}
        </p>
      )}
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

function QrCard(props: { dataUrl: string; alt: string; link?: string }): React.JSX.Element {
  return (
    <div className="qr-card">
      <img className="qr-image" src={props.dataUrl} alt={props.alt} />
      {props.link ? (
        <a className="onboarding-link" href={props.link} target="_blank" rel="noopener">
          {t('botOnboarding.openLink')}
        </a>
      ) : null}
    </div>
  );
}

function onboardingOptionLabel<T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
): string {
  return options.find(option => option.value === value)?.label ?? value;
}

export function onboardingRetryMode(job: {
  registrationMode?: 'web' | 'compat' | 'local' | 'manual';
}): 'web' | 'local' | 'manual' {
  if (job.registrationMode === 'local') return 'local';
  if (job.registrationMode === 'manual') return 'manual';
  return 'web';
}

function OnboardingJobView(props: {
  view: Extract<ViewState, { kind: 'job' }>;
  allowManual: boolean;
  cancelling: boolean;
  ownerInput: string;
  ownerIdInput: string;
  onOwnerInputChange(value: string): void;
  onOwnerIdInputChange(value: string): void;
  onSubmitOwner(job: OnboardingJob, owner: string, ownerId: string): void;
  onRetry(mode: 'web' | 'compat' | 'local'): void;
  onBackToManualForm(prefill?: { appId?: string; brand?: 'feishu' | 'lark' }): void;
  onClose(): void;
}): React.JSX.Element {
  const { job, ownerError, cancelError } = props.view;
  const manualSteps = job.status === 'completed' && job.registrationMode === 'manual'
    ? (job.remainingSteps ?? [])
    : [];
  return (
    <>
      <p className={`onboarding-status status-${job.status}`}>{statusText(job)}</p>
      {job.status === 'waiting_for_scan' && job.qrDataUrl ? (
        <QrCard dataUrl={job.qrDataUrl} alt={t('botOnboarding.qrAlt')} link={job.qrUrl} />
      ) : null}
      {cancelError ? <p className="form-error">{cancelError}</p> : null}
      {job.status === 'waiting_for_scan' ? (
        <div className="actions onboarding-actions">
          <button type="button" disabled={props.cancelling} onClick={props.onClose}>
            {t('botOnboarding.cancel')}
          </button>
          {props.allowManual ? (
            <button type="button" disabled={props.cancelling} onClick={() => props.onBackToManualForm()}>
              {t('botOnboarding.switchToManual')}
            </button>
          ) : null}
        </div>
      ) : null}
      {job.status === 'waiting_for_platform_scan' && job.platformQrDataUrl ? (
        <QrCard dataUrl={job.platformQrDataUrl} alt={t('botOnboarding.platformQrAlt')} />
      ) : null}
      <OnboardingMeta job={job} />
      <PermissionSummary job={job} />
      {manualSteps.length > 0 ? (
        <>
          <p className="hint-warn">{t('botOnboarding.manualStepsHint')}</p>
          <ol className="onboarding-steps">
            {manualSteps.map(step => (
              <li key={`${step.title}:${step.url}`}>
                <a href={step.url} target="_blank" rel="noopener">{step.title}</a>
              </li>
            ))}
          </ol>
        </>
      ) : null}
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
        job.liveStarted === false ? (
          <>
            <p className="hint-warn">
              {job.registrationMode === 'local' ? t('botOnboarding.restartHintLocal') : t('botOnboarding.restartHint')}
            </p>
            {job.liveStartMessage ? <p className="hint-warn">{job.liveStartMessage}</p> : null}
          </>
        ) : (
          <p className="hint-ok">{job.registrationMode === 'local'
            ? (job.liveStarted ? t('botOnboarding.liveOkLocal') : t('botOnboarding.restartHintLocal'))
            : (job.liveStarted ? t('botOnboarding.liveOk') : t('botOnboarding.restartHint'))}</p>
        )
      ) : null}
      {job.status === 'failed' ? (
        <>
          <p className="hint-warn">
            {job.registrationMode === 'manual'
              ? (job.message ?? t('botOnboarding.createFailedDescription'))
              : job.appId
                ? t('botOnboarding.partialFailureDescription')
                : job.error === 'qr_expired'
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
            {job.registrationMode === 'manual' ? (
              <button
                type="button"
                className="primary onboarding-submit"
                onClick={() => props.onBackToManualForm({ appId: job.appId, brand: job.brand })}
              >
                {t('botOnboarding.backToForm')}
              </button>
            ) : !job.appId ? (
              onboardingRetryMode(job) === 'local' ? (
                <button type="button" className="primary onboarding-submit" onClick={() => props.onRetry('local')}>
                  {t('botOnboarding.retry')}
                </button>
              ) : (
                <>
                  {props.allowManual ? (
                    <button type="button" onClick={() => props.onBackToManualForm()}>
                      {t('botOnboarding.switchToManual')}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => props.onRetry('compat')}>{t('botOnboarding.compatibilityMode')}</button>
                  <button type="button" className="primary onboarding-submit" onClick={() => props.onRetry('web')}>
                    {job.error === 'qr_expired'
                      ? t('botOnboarding.generateQr')
                      : isSessionFailure(job.error)
                        ? t('botOnboarding.scanAgain')
                        : t('botOnboarding.retry')}
                  </button>
                </>
              )
            ) : props.allowManual ? (
              <button
                type="button"
                className="primary onboarding-submit"
                onClick={() => props.onBackToManualForm({ appId: job.appId, brand: job.brand })}
              >
                {t('botOnboarding.switchToManual')}
              </button>
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
  platform: ProviderId;
  wecomMode: 'qr' | 'manual';
  backend: 'pty' | 'tmux';
  botId: string;
  secret: string;
  onWecomModeChange(mode: 'qr' | 'manual'): void;
  onBackendChange(backend: 'pty' | 'tmux'): void;
  onBotIdChange(value: string): void;
  onSecretChange(value: string): void;
  cliState: CliOptionsState;
  form: OnboardingFormState;
  allowLocal: boolean;
  allowManual: boolean;
  cliRecheckSeq: number;
  sessionMode: 'checking' | 'reuse' | 'qr';
  error?: string;
  submitting: boolean;
  onFormChange(form: OnboardingFormState): void;
  onCliChange(cliId: string): void;
  onRecheckCli(): void;
  onSessionModeChange(mode: 'reuse' | 'qr'): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onClose(): void;
}): React.JSX.Element {
  const [showSecret, setShowSecret] = useState(false);
  const selectedCli = props.cliState.options.find(option => option.id === props.form.cliId);
  const availabilityStatus = useCliAvailability(
    props.form.cliId,
    selectedCli,
    undefined,
    String(props.cliRecheckSeq),
    props.cliRecheckSeq > 0 ? { refresh: true } : undefined,
  );
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
      searchTerms: cliSearchTerms(option),
      label: (option.id === props.form.cliId ? availabilityStatus : cliAvailabilityStatus(option)) === 'unavailable'
        ? t('botOnboarding.cliMissingOption', { label: option.label, command: option.command ?? option.id })
        : option.label,
    }));
  const dirModeOptions: Array<{ value: OnboardingFormState['dirMode']; label: string }> = [
    { value: 'fixed', label: t('botOnboarding.dirModeFixed') },
    { value: 'card', label: t('botOnboarding.dirModeCard') },
  ];
  const connectionOptions: Array<{ value: OnboardingFormState['connection']; label: string }> = [
    { value: 'feishu', label: t('botOnboarding.connectionFeishu') },
    ...(props.allowManual ? [{ value: 'manual' as const, label: t('botOnboarding.connectionManual') }] : []),
    ...(props.allowLocal ? [{ value: 'local' as const, label: t('botOnboarding.connectionLocal') }] : []),
  ];
  const brandOptions: Array<{ value: OnboardingFormState['brand']; label: string }> = [
    { value: 'feishu', label: t('botOnboarding.brandFeishu') },
    { value: 'lark', label: t('botOnboarding.brandLark') },
  ];
  // 企业微信流程不用飞书的接入方式：本地 / 手动都按「否」算，下面飞书专属的字段都不出现。
  const wecom = props.platform === 'wecom';
  const local = !wecom && props.form.connection === 'local' && props.allowLocal;
  const manual = !wecom && props.form.connection === 'manual' && props.allowManual;
  const effectiveConnection: OnboardingFormState['connection'] = local ? 'local' : manual ? 'manual' : 'feishu';

  return (
    <form id="onboarding-form" className="onboarding-form" onSubmit={props.onSubmit}>
      {!wecom ? <div className="onboarding-field">
        <span>{t('botOnboarding.connectionLabel')}</span>
        <DropdownMenu
          id="ob-connection"
          className="onboarding-menu"
          ariaLabel={t('botOnboarding.connectionLabel')}
          label={onboardingOptionLabel(connectionOptions, effectiveConnection)}
          value={effectiveConnection}
          options={connectionOptions}
          onChange={connection => props.onFormChange({ ...props.form, connection })}
        />
        <small className="onboarding-field-hint">{local
          ? t('botOnboarding.connectionLocalHint')
          : manual
            ? t('botOnboarding.connectionManualHint')
            : t('botOnboarding.connectionFeishuHint')}</small>
      </div> : null}
      {effectiveConnection === 'feishu' ? <div className="onboarding-session" aria-live="polite" hidden={wecom}>
        {props.sessionMode === 'checking' ? (
          <p>{t('botOnboarding.sessionChecking')}</p>
        ) : props.cliState.webSession.status === 'ready' ? (
          props.sessionMode === 'reuse' ? (
            <>
              <div>
                <strong>{t('botOnboarding.sessionReady', {
                  user: props.cliState.webSession.identity.userName,
                  tenant: props.cliState.webSession.identity.tenantName,
                })}</strong>
                {props.cliState.webSession.identity.email
                  ? <small>{props.cliState.webSession.identity.email}</small>
                  : null}
              </div>
              <button type="button" className="onboarding-session-action" onClick={() => props.onSessionModeChange('qr')}>
                {t('botOnboarding.switchAccount')}
              </button>
            </>
          ) : (
            <>
              <div>
                <strong>{t('botOnboarding.sessionSwitching')}</strong>
                <small>{t('botOnboarding.sessionSwitchingHint')}</small>
              </div>
              <button type="button" className="onboarding-session-action" onClick={() => props.onSessionModeChange('reuse')}>
                {t('botOnboarding.reuseCurrentAccount')}
              </button>
            </>
          )
        ) : (
          <div>
            <strong>{t('botOnboarding.sessionScanRequired')}</strong>
            <small>{t('botOnboarding.sessionScanRequiredHint')}</small>
          </div>
        )}
      </div> : null}
      {manual ? (
        <>
          <div className="onboarding-field">
            <span>{t('botOnboarding.brandLabel')}</span>
            <DropdownMenu
              id="ob-brand"
              className="onboarding-menu"
              ariaLabel={t('botOnboarding.brandLabel')}
              label={onboardingOptionLabel(brandOptions, props.form.brand)}
              value={props.form.brand}
              options={brandOptions}
              onChange={brand => props.onFormChange({ ...props.form, brand })}
            />
          </div>
          <label className="onboarding-field">
            <span>{t('botOnboarding.manualAppIdLabel')}</span>
            <input
              id="ob-app-id"
              type="text"
              maxLength={68}
              value={props.form.appId}
              placeholder={t('botOnboarding.manualAppIdPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={event => props.onFormChange({ ...props.form, appId: event.currentTarget.value })}
            />
          </label>
          <label className="onboarding-field">
            <span>{t('botOnboarding.manualAppSecretLabel')}</span>
            <div className="onboarding-secret-wrap">
              <input
                id="ob-app-secret"
                type={showSecret ? 'text' : 'password'}
                maxLength={256}
                value={props.form.appSecret}
                placeholder={t('botOnboarding.manualAppSecretPlaceholder')}
                autoComplete="new-password"
                spellCheck={false}
                onChange={event => props.onFormChange({ ...props.form, appSecret: event.currentTarget.value })}
              />
              <button
                type="button"
                className="onboarding-secret-toggle"
                onClick={() => setShowSecret(v => !v)}
              >
                {showSecret ? t('botOnboarding.manualHideSecret') : t('botOnboarding.manualShowSecret')}
              </button>
            </div>
          </label>
          <label className="onboarding-field">
            <span>{t('botOnboarding.manualOwnerLabel')}</span>
            <input
              id="ob-manual-owner"
              type="text"
              inputMode="email"
              value={props.form.owner}
              placeholder={t('botOnboarding.manualOwnerPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={event => props.onFormChange({ ...props.form, owner: event.currentTarget.value })}
            />
            <small className="onboarding-field-hint">{t('botOnboarding.manualOwnerHint')}</small>
          </label>
        </>
      ) : null}
      <label className="onboarding-field">
        <span>{wecom ? t('botOnboarding.wecom.displayNameLabel') : local ? t('botOnboarding.localNameLabel') : t('botOnboarding.appNameLabel')}</span>
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
        <small className="onboarding-field-hint">{wecom
          ? t('botOnboarding.wecom.displayNameHint')
          : local
          ? t('botOnboarding.localNameHint')
          : t('botOnboarding.appNameHint', { name: props.cliState.suggestedAppName })}</small>
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
          onChange={cliId => props.onCliChange(cliId)}
        />
        {availabilityStatus === 'unavailable' ? (
          <div className="onboarding-cli-missing-row">
            <small className="hint-warn">
              {t('botOnboarding.cliMissingHint', { command: selectedCli?.command ?? props.form.cliId })}
            </small>
            <button type="button" className="onboarding-session-action" onClick={props.onRecheckCli}>
              {t('botOnboarding.cliRecheck')}
            </button>
          </div>
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
      {effectiveConnection === 'feishu' && !wecom ? (
        <label className="onboarding-field onboarding-checkbox">
          <span className="onboarding-checkbox-row">
            <input
              id="ob-auto-avoid-approval"
              type="checkbox"
              checked={props.form.autoAvoidApproval}
              onChange={event => props.onFormChange({ ...props.form, autoAvoidApproval: event.currentTarget.checked })}
            />
            <span>{t('botOnboarding.autoAvoidApprovalLabel')}</span>
          </span>
          <small className="onboarding-field-hint">{t('botOnboarding.autoAvoidApprovalHint')}</small>
        </label>
      ) : null}
      {wecom ? (
        <>
          <div className="onboarding-field">
            <span>{t('botOnboarding.wecom.backendLabel')}</span>
            <DropdownMenu
              id="ob-backend"
              ariaLabel={t('botOnboarding.wecom.backendLabel')}
              className="onboarding-menu"
              label={props.backend === 'pty' ? 'PTY' : 'tmux'}
              value={props.backend}
              options={[{ value: 'pty', label: 'PTY' }, { value: 'tmux', label: 'tmux' }]}
              onChange={props.onBackendChange}
            />
          </div>
          <fieldset className="onboarding-provider">
            <legend>{t('botOnboarding.wecom.modeLegend')}</legend>
            <label>
              <input type="radio" name="wecom-mode" value="qr" checked={props.wecomMode === 'qr'} onChange={() => props.onWecomModeChange('qr')} />
              {' '}{t('botOnboarding.wecom.modeQr')}
            </label>
            <label>
              <input type="radio" name="wecom-mode" value="manual" checked={props.wecomMode === 'manual'} onChange={() => props.onWecomModeChange('manual')} />
              {' '}{t('botOnboarding.wecom.modeManual')}
            </label>
          </fieldset>
          {props.wecomMode === 'manual' ? (
            <>
              <label className="onboarding-field">
                <span>BotID</span>
                <input id="ob-wecom-bot-id" type="text" required autoComplete="off" spellCheck={false} value={props.botId} onChange={event => props.onBotIdChange(event.currentTarget.value)} />
              </label>
              <label className="onboarding-field">
                <span>Secret</span>
                <input id="ob-wecom-secret" type="password" required autoComplete="new-password" value={props.secret} onChange={event => props.onSecretChange(event.currentTarget.value)} />
                <small className="onboarding-field-hint">{t('botOnboarding.wecom.secretHint')}</small>
              </label>
            </>
          ) : null}
          <p className="onboarding-field-hint">{t('botOnboarding.wecom.formHint')}</p>
        </>
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
          disabled={isOnboardingSubmitDisabled(props.submitting, wecom ? 'qr' : props.sessionMode, effectiveConnection)}
        >
          {props.submitting
            ? (local
              ? t('botOnboarding.startingLocal')
              : manual
                ? t('botOnboarding.startingManual')
                : t('botOnboarding.starting'))
            : wecom
              ? (props.wecomMode === 'qr' ? t('botOnboarding.wecom.submitQr') : t('botOnboarding.wecom.submitManual'))
            : local
              ? t('botOnboarding.createLocal')
              : manual
                ? t('botOnboarding.createManual')
                : props.sessionMode === 'reuse'
                  ? t('botOnboarding.confirmReuse')
                  : t('botOnboarding.startScan')}
        </button>
      </div>
    </form>
  );
}

/**
 * 企业微信创建完成时的名称说明。扫码创建协议不带名称，向导里填的名字只用作 botmux 的本地显示名，
 * 企业微信客户端里仍是平台默认名称和头像；没填显示名时换一句不带名字的说法。
 */
export function wecomCompletedNameNote(appName: string | undefined): string {
  const name = appName?.trim();
  return name
    ? t('botOnboarding.wecom.completedNameNote', { name })
    : t('botOnboarding.wecom.completedNameNoteUnnamed');
}

function WecomOnboardingJobView(props: {
  job: WecomOnboardingSnapshot; busy: boolean; error?: string;
  onAction(action: 'refresh' | 'retry'): void; onClose(): void;
}): React.JSX.Element {
  const {job} = props;
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => setCopyStatus(''), [job.pairingCode]);
  const copyPairingCode = async () => {
    if (!job.pairingCode) return;
    try {
      await navigator.clipboard.writeText(job.pairingCode);
      setCopyStatus(t('botOnboarding.wecom.pairingCopied'));
    } catch {
      setCopyStatus(t('botOnboarding.wecom.pairingCopyFailed'));
    }
  };
  const title = job.status === 'waiting_for_scan' ? t('botOnboarding.wecom.statusWaitingForScan')
    : job.status === 'needs_pairing' ? t('botOnboarding.wecom.statusNeedsPairing')
    : job.status === 'completed' ? t('botOnboarding.wecom.statusCompleted')
    : job.status === 'failed' ? t('botOnboarding.wecom.statusFailed')
    : job.status === 'cancelled' ? t('botOnboarding.wecom.statusCancelled')
    : job.status === 'starting_bot' ? t('botOnboarding.wecom.statusStartingBot')
    : job.status === 'verifying' ? t('botOnboarding.wecom.statusVerifying')
    : t('botOnboarding.wecom.statusChecking');
  const failureText = job.error === 'wecom_onboarding_expired' ? t('botOnboarding.wecom.failedExpired')
    : job.saved ? t('botOnboarding.wecom.failedSaved')
    : job.externalBotCreated ? t('botOnboarding.wecom.failedCreated')
    : job.retryable ? t('botOnboarding.wecom.failedRetryable')
    : t('botOnboarding.wecom.failedQr');
  const closeLabel = job.status === 'completed' ? t('botOnboarding.wecom.viewBots')
    : ['failed', 'cancelled'].includes(job.status) ? t('botOnboarding.close')
    : t('botOnboarding.wecom.cancelJob');
  const steps = [t('botOnboarding.wecom.stepConnect'), t('botOnboarding.wecom.stepPair'), t('botOnboarding.wecom.stepStart')];
  const currentStep = job.status === 'needs_pairing' ? 1 : ['starting_bot', 'completed'].includes(job.status) ? 2 : 0;
  const canRefresh = job.error !== 'wecom_onboarding_expired' && !job.externalBotCreated && !job.saved && (job.status === 'waiting_for_scan' || (['failed','cancelled'].includes(job.status) && !job.retryable));
  return <div data-wecom-onboarding-status={job.status}>
    <ol className="onboarding-progress" aria-label={t('botOnboarding.wecom.progressLabel')}>
      {steps.map((step, index) => <li key={step} aria-current={index === currentStep ? 'step' : undefined}>{step}</li>)}
    </ol>
    <p className={`onboarding-status status-${job.status}`} role="status">{title}</p>
    {job.status === 'waiting_for_scan' && job.qrDataUrl ? <QrCard dataUrl={job.qrDataUrl} alt={t('botOnboarding.wecom.qrAlt')} link={job.qrUrl} /> : null}
    {job.status === 'waiting_for_scan' ? (
      <p className="onboarding-field-hint">
        {t('botOnboarding.wecom.scanHint')}
        {job.expireAt ? t('botOnboarding.wecom.qrExpiresAt', { time: new Date(job.expireAt).toLocaleTimeString() }) : ''}
      </p>
    ) : null}
    {job.status === 'needs_pairing' ? <div className="onboarding-pairing">
      <p>{t('botOnboarding.wecom.pairingIntro')}</p>
      <code className="onboarding-pairing-code">{job.pairingCode}</code>
      <button type="button" onClick={() => void copyPairingCode()}>{t('botOnboarding.wecom.copyPairingCode')}</button>
      {copyStatus ? <p role="status" className="onboarding-field-hint">{copyStatus}</p> : null}
      <p className="onboarding-field-hint">{t('botOnboarding.wecom.pairingHint')}</p>
    </div> : null}
    {job.status === 'completed' ? <p className="hint-ok">{t('botOnboarding.wecom.completedHint')}</p> : null}
    {job.status === 'completed' ? <p className="onboarding-field-hint" data-wecom-name-note>{wecomCompletedNameNote(job.appName)}</p> : null}
    {job.status === 'failed' ? <>
      <p className="hint-warn">{failureText}</p>
      <details className="onboarding-technical">
        <summary>{t('botOnboarding.wecom.details')}</summary>
        <code>{job.message ?? job.error ?? t('botOnboarding.wecom.unfinished')}</code>
      </details>
    </> : null}
    {job.externalBotCreated && !['completed','failed','cancelled'].includes(job.status) ? <p className="onboarding-field-hint">{t('botOnboarding.wecom.cancelKeepsBot')}</p> : null}
    {props.error ? <p className="form-error" role="alert">{props.error}</p> : null}
    <div className="actions onboarding-actions">
      <button type="button" onClick={props.onClose}>{closeLabel}</button>
      {canRefresh ? <button type="button" disabled={props.busy} onClick={() => props.onAction('refresh')}>{t('botOnboarding.wecom.refreshQr')}</button> : null}
      {['failed','cancelled'].includes(job.status) && job.retryable ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction('retry')}>{t('botOnboarding.wecom.resumeSameBot')}</button> : null}
    </div>
  </div>;
}

export function BotOnboardingDialog(props: { open: boolean; onClose(): void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollSeqRef = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);
  const startSeqRef = useRef(0);
  const cliTouchedRef = useRef(false);
  const completedNotifiedJobIdRef = useRef<string | null>(null);
  const cancellingRef = useRef(false);
  // 企业微信流程（旁路入口）自己的轮询计时器、请求代号与忙标记；飞书流程的那几个在上面，互不复用。
  const wecomPollTimerRef = useRef<number | null>(null);
  const wecomSeqRef = useRef(0);
  const activeWecomJobRef = useRef<string | undefined>(undefined);
  const wecomBusyRef = useRef(false);
  const wecomAllowedRef = useRef(false);
  // 企业微信是旁路入口：只有服务端在 cli-options 里声明 canCreateWecomBot 时才露出。
  const [wecomCreatable, setWecomCreatable] = useState(false);
  // 打开即飞书流程（与企微接入前一致）；企业微信只能经旁路入口切换进来。
  const [platform, setPlatform] = useState<ProviderId>('lark');
  const [wecomMode, setWecomMode] = useState<'qr' | 'manual'>('qr');
  const [backend, setBackend] = useState<'pty' | 'tmux'>('pty');
  const [botId, setBotId] = useState('');
  const [secret, setSecret] = useState('');
  const [cliState, setCliState] = useState<CliOptionsState>(() => defaultCliOptionsState());
  const [form, setForm] = useState<OnboardingFormState>(() => defaultFormState());
  const [cliRecheckSeq, setCliRecheckSeq] = useState(0);
  const [sessionMode, setSessionMode] = useState<'checking' | 'reuse' | 'qr'>('checking');
  const [view, setView] = useState<ViewState>({ kind: 'form' });
  const viewRef = useRef<ViewState>(view);
  viewRef.current = view;
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [ownerInput, setOwnerInput] = useState('');
  const [ownerIdInput, setOwnerIdInput] = useState('');

  const stopPolling = useCallback(() => {
    pollSeqRef.current += 1;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const stopWecomPolling = useCallback(() => {
    if (wecomPollTimerRef.current !== null) window.clearTimeout(wecomPollTimerRef.current);
    wecomPollTimerRef.current = null;
  }, []);
  const cancelWecomJob = useCallback((id: string) => {
    void fetch(`/api/bot-onboarding/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', credentials: 'same-origin', headers: controlCsrfHeaders(),
    }).catch(() => { /* closing still invalidates local responses */ });
  }, []);
  // 放下当前的企业微信接入任务：作废还在路上的响应和下一次轮询，并取消服务端那条还没结束的任务。
  const releaseWecomJob = useCallback(() => {
    const id = activeWecomJobRef.current;
    activeWecomJobRef.current = undefined;
    wecomSeqRef.current += 1;
    stopWecomPolling();
    wecomBusyRef.current = false;
    setSecret('');
    if (id) cancelWecomJob(id);
  }, [cancelWecomJob, stopWecomPolling]);

  const finishClose = useCallback(() => {
    startSeqRef.current += 1;
    stopPolling();
    releaseWecomJob();
    cloneSourceAppId = undefined;
    cloneSourceDefaults = undefined;
    setForm(current => (current.appSecret ? { ...current, appSecret: '' } : current));
    const closing = viewRef.current;
    if (closing.kind === 'wecom-job' && closing.job.status === 'completed') window.location.hash = `#/bot-defaults?provider=wecom${closing.job.connectionId ? `&bot=${encodeURIComponent(closing.job.connectionId)}` : ''}`;
    props.onClose();
  }, [props, stopPolling, releaseWecomJob]);

  const applyJob = useCallback((job: OnboardingJob) => {
    setView({ kind: 'job', job });
    if (job.status === 'needs_owner') {
      // 预填创建账号的邮箱（后端自动确认失败时给出），用户复核/修改后提交。
      setOwnerInput(job.suggestedOwner ?? '');
      setOwnerIdInput('');
    }
    if (job.status === 'completed') {
      setForm(current => (current.appSecret ? { ...current, appSecret: '' } : current));
      if (job.id && completedNotifiedJobIdRef.current !== job.id) {
        completedNotifiedJobIdRef.current = job.id;
        window.dispatchEvent(new CustomEvent(BOT_ONBOARDING_COMPLETED_EVENT, {
          detail: { appId: job.appId, registrationMode: job.registrationMode },
        }));
      }
    }
    if (shouldStopPolling(job)) stopPolling();
  }, [stopPolling]);

  const applyWecomJob = useCallback((job: WecomOnboardingSnapshot) => {
    activeWecomJobRef.current = ['completed', 'cancelled'].includes(job.status) ? undefined : job.id;
    setView({ kind: 'wecom-job', job });
    if (job.status === 'completed' && job.connectionId) window.dispatchEvent(new CustomEvent(BOT_ONBOARDING_COMPLETED_EVENT, {detail:{platform:'wecom',connectionId:job.connectionId}}));
  }, []);

  const pollJob = useCallback(async (id: string, seq: number, signal?: AbortSignal) => {
    const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
    if (pollSeqRef.current !== seq) return;
    const body = await res.json();
    if (pollSeqRef.current !== seq) return;
    if (!res.ok || !body?.job) throw new Error(body?.error ?? `http_${res.status}`);
    applyJob(body.job as OnboardingJob);
  }, [applyJob]);

  const startPolling = useCallback((id: string, registrationMode?: OnboardingJob['registrationMode']) => {
    stopPolling();
    const seq = pollSeqRef.current;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    pollAbortRef.current = controller;
    pollTimerRef.current = window.setInterval(() => {
      void pollJob(id, seq, controller?.signal).catch(error => {
        if (pollSeqRef.current !== seq) return;
        stopPolling();
        setView({ kind: 'job', job: { id, status: 'failed', message: caughtErrorText(error), registrationMode } });
      });
    }, 1200);
  }, [pollJob, stopPolling]);

  // 企业微信：每代只有一个在途轮询。关闭、切换平台或刷新都会先作废在途请求和下一次计时，再动状态。
  const startWecomPolling = useCallback((id: string, seq: number) => {
    stopWecomPolling();
    let failures = 0;
    const poll = async () => {
      if (wecomSeqRef.current !== seq) return;
      try {
        const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(id)}`, {credentials: 'same-origin'});
        const body = await res.json();
        if (wecomSeqRef.current !== seq) return;
        if (!res.ok || !body?.job) throw new Error(body?.message ?? body?.error ?? `http_${res.status}`);
        failures = 0;
        const job = body.job as WecomOnboardingSnapshot;
        applyWecomJob(job);
        if (!wecomJobTerminal(job)) wecomPollTimerRef.current = window.setTimeout(poll, 1200);
      } catch (error) {
        if (wecomSeqRef.current !== seq) return;
        failures += 1;
        // 平台侧机器人可能已经建好：保留最近一次持久化的 job 和它的恢复操作，把错误显示出来，
        // 按退避间隔继续检查，而不是假装平台创建本身失败了。
        setView(current => current.kind === 'wecom-job'
          ? {...current, actionError: caughtErrorText(error)}
          : current);
        wecomPollTimerRef.current = window.setTimeout(poll, wecomPollRetryDelayMs(failures));
      }
    };
    wecomPollTimerRef.current = window.setTimeout(poll, 1200);
  }, [applyWecomJob, stopWecomPolling]);

  const refreshCliOptions = useCallback((autoSelectCli: boolean) => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    void fetchCliOptions().then(next => {
      if (loadSeqRef.current !== seq) return;
      setCliState(next);
      const wecomCreatableNow = !next.loadFailed && next.canCreateWecomBot;
      wecomAllowedRef.current = wecomCreatableNow;
      setWecomCreatable(wecomCreatableNow);
      setForm(current => normalizeFormForOptions(
        current,
        next,
        autoSelectCli && !cliTouchedRef.current && !cloneSourceDefaults?.cliId,
      ));
      setSessionMode(prev => (prev === 'checking'
        ? (next.webSession.status === 'ready' ? 'reuse' : 'qr')
        : prev));
    });
  }, []);

  const resetToForm = useCallback(() => {
    stopPolling();
    // 每次打开都从干净的飞书表单开局；企业微信入口等 cli-options 回来、按服务端声明再露出。
    releaseWecomJob();
    wecomAllowedRef.current = false;
    setWecomCreatable(false);
    setPlatform('lark');
    setWecomMode('qr');
    setBotId('');
    cliTouchedRef.current = false;
    completedNotifiedJobIdRef.current = null;
    const initialCliState = defaultCliOptionsState();
    setCliState(initialCliState);
    // 克隆模式下用源 Bot 的值开局，让表单显示真正会生效的配置（后端克隆会用
    // 源 Bot 覆盖这几项）；普通新建仍是原来的默认值。
    setForm(applyCloneDefaults(defaultFormState(), cloneSourceDefaults));
    setCliRecheckSeq(0);
    setSessionMode('checking');
    setView({ kind: 'form' });
    setSubmitting(false);
    setOwnerInput('');
    setOwnerIdInput('');
    refreshCliOptions(true);
  }, [refreshCliOptions, stopPolling, releaseWecomJob]);

  useEffect(() => {
    if (props.open) {
      resetToForm();
      return;
    }
    stopPolling();
    releaseWecomJob();
    loadSeqRef.current += 1;
  }, [props.open, resetToForm, stopPolling, releaseWecomJob]);

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
  useEffect(() => () => {
    wecomSeqRef.current += 1;
    stopWecomPolling();
    if (activeWecomJobRef.current) cancelWecomJob(activeWecomJobRef.current);
  }, [stopWecomPolling, cancelWecomJob]);

  const startOnboarding = useCallback(async (
    registrationMode: 'web' | 'compat' | 'local' | 'manual',
    sessionModeOverride?: 'reuse' | 'qr',
  ) => {
    stopPolling();
    const startSeq = ++startSeqRef.current;
    setSubmitting(true);
    setView({ kind: 'job', job: { id: '', status: 'starting', registrationMode } });
    try {
      const effectiveSessionMode = sessionModeOverride ?? (sessionMode === 'reuse' ? 'reuse' : 'qr');
      const expectedIdentity = registrationMode === 'web'
        && effectiveSessionMode === 'reuse'
        && cliState.webSession.status === 'ready'
        ? {
            userId: cliState.webSession.identity.userId,
            tenantId: cliState.webSession.identity.tenantId,
          }
        : undefined;
      const res = await fetch('/api/bot-onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appName: registrationMode === 'compat' ? undefined : form.appName.trim() || undefined,
          registrationMode,
          ...(registrationMode === 'web' ? { sessionMode: effectiveSessionMode, expectedIdentity } : {}),
          ...(registrationMode === 'manual' ? {
            brand: form.brand,
            appId: form.appId.trim(),
            appSecret: form.appSecret.trim(),
            owner: form.owner.trim(),
          } : {}),
          cliId: form.cliId,
          workingDir: form.workingDir.trim(),
          dirMode: form.dirMode,
          model: form.model.trim() || undefined,
          ...(registrationMode === 'local' || registrationMode === 'manual'
            ? {}
            : { cloneSourceAppId, autoAvoidApproval: form.autoAvoidApproval }),
        }),
      });
      const body = await res.json();
      if (startSeqRef.current !== startSeq) {
        if (res.ok && body?.job?.id) {
          void fetch(`/api/bot-onboarding/${encodeURIComponent(String(body.job.id))}/cancel`, { method: 'POST' }).catch(() => {});
        }
        return;
      }
      if (res.status === 400 || res.status === 409) {
        setView({ kind: 'form', error: body?.message ?? body?.error ?? 'invalid_input' });
        return;
      }
      if (!res.ok || !body?.job?.id) throw new Error(body?.error ?? `http_${res.status}`);
      const job = body.job as OnboardingJob;
      applyJob(job);
      if (!shouldStopPolling(job)) startPolling(job.id, job.registrationMode);
    } catch (error) {
      if (startSeqRef.current !== startSeq) return;
      setView({ kind: 'job', job: { id: '', status: 'failed', message: caughtErrorText(error), registrationMode } });
    } finally {
      if (startSeqRef.current === startSeq) setSubmitting(false);
    }
  }, [applyJob, cliState.webSession, form, sessionMode, startPolling, stopPolling]);

  const startWecomOnboarding = useCallback(async () => {
    if (wecomBusyRef.current) return;
    wecomBusyRef.current = true;
    stopWecomPolling();
    const seq = ++wecomSeqRef.current;
    setSubmitting(true);
    try {
      const requestBody = JSON.stringify({
        platform: 'wecom',
        appName: form.appName.trim() || undefined,
        mode: wecomMode, backend, ...(wecomMode === 'manual' ? {botId: botId.trim(), secret} : {}),
        cliId: form.cliId, workingDir: form.workingDir.trim(), dirMode: form.dirMode, model: form.model.trim() || undefined,
      });
      setSecret('');
      const res = await fetch('/api/bot-onboarding/start', {
        method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', ...controlCsrfHeaders()}, body: requestBody,
      });
      const body = await res.json();
      if (wecomSeqRef.current !== seq) {
        if (body?.job?.platform === 'wecom' && body.job.id) cancelWecomJob(body.job.id);
        return;
      }
      if (!res.ok || !body?.job?.id) {
        setView({kind: 'form', error: body?.message ?? body?.error ?? `http_${res.status}`});
        return;
      }
      const job = body.job as WecomOnboardingSnapshot;
      applyWecomJob(job);
      if (!wecomJobTerminal(job)) startWecomPolling(job.id, seq);
    } catch (error) {
      if (wecomSeqRef.current !== seq) return;
      setView({kind: 'form', error: caughtErrorText(error)});
    } finally {
      if (wecomSeqRef.current === seq) {wecomBusyRef.current = false; setSubmitting(false);}
    }
  }, [applyWecomJob, backend, botId, cancelWecomJob, form, secret, startWecomPolling, stopWecomPolling, wecomMode]);

  const ensureActiveJobCancelled = useCallback(async (): Promise<boolean> => {
    if (cancellingRef.current) return false;
    const currentView = viewRef.current;
    if (currentView.kind !== 'job' || !currentView.job.id || shouldStopPolling(currentView.job)) {
      stopPolling();
      return true;
    }
    const activeJob = currentView.job;
    cancellingRef.current = true;
    setCancelling(true);
    stopPolling();
    try {
      const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(activeJob.id)}/cancel`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok || res.status === 404) {
        return true;
      }
      if (res.status === 409 && body?.job) {
        const latestJob = body.job as OnboardingJob;
        applyJob(latestJob);
        if (!shouldStopPolling(latestJob)) startPolling(latestJob.id, latestJob.registrationMode);
        return false;
      }
      setView({
        kind: 'job',
        job: activeJob,
        cancelError: body?.message ?? body?.error ?? `http_${res.status}`,
      });
      startPolling(activeJob.id, activeJob.registrationMode);
      return false;
    } catch (error) {
      setView({
        kind: 'job',
        job: activeJob,
        cancelError: caughtErrorText(error),
      });
      startPolling(activeJob.id, activeJob.registrationMode);
      return false;
    } finally {
      cancellingRef.current = false;
      setCancelling(false);
    }
  }, [applyJob, startPolling, stopPolling]);

  const close = useCallback(() => {
    void ensureActiveJobCancelled().then(cancelled => {
      if (cancelled) finishClose();
    });
  }, [ensureActiveJobCancelled, finishClose]);

  const submitForm = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (platform === 'wecom') {
      void startWecomOnboarding();
      return;
    }
    const isClone = cloneSourceAppId !== undefined;
    const mode = !isClone && form.connection === 'local'
      ? 'local'
      : !isClone && form.connection === 'manual'
        ? 'manual'
        : 'web';
    void startOnboarding(mode);
  }, [form.connection, platform, startOnboarding, startWecomOnboarding]);

  const switchToManualForm = useCallback((prefill?: { appId?: string; brand?: 'feishu' | 'lark' }) => {
    void ensureActiveJobCancelled().then(cancelled => {
      if (!cancelled) return;
      startSeqRef.current += 1;
      setForm(current => ({
        ...current,
        connection: 'manual',
        ...(prefill?.appId ? { appId: prefill.appId } : {}),
        ...(prefill?.brand ? { brand: prefill.brand } : {}),
      }));
      setView({ kind: 'form' });
    });
  }, [ensureActiveJobCancelled]);

  const retry = useCallback(async (registrationMode: 'web' | 'compat' | 'local') => {
    if (registrationMode === 'compat') {
      const accepted = await confirm({ title: '兼容性确认', message: t('botOnboarding.compatibilityConfirm'), danger: false });
      if (!accepted) return;
    }
    const requiresFreshLogin = registrationMode === 'web'
      && view.kind === 'job'
      && isSessionFailure(view.job.error);
    if (requiresFreshLogin) setSessionMode('qr');
    void startOnboarding(registrationMode, requiresFreshLogin ? 'qr' : undefined);
  }, [startOnboarding, view]);

  const handleCliChange = useCallback((cliId: string) => {
    cliTouchedRef.current = true;
    setCliRecheckSeq(0);
    setForm(current => syncModelForCli(current, cliId, cliState));
  }, [cliState]);

  const handleRecheckCli = useCallback(() => {
    setCliRecheckSeq(seq => seq + 1);
    refreshCliOptions(false);
  }, [refreshCliOptions]);

  // 在飞书表单与企业微信流程之间切换：放下当前的企业微信任务，回到所选平台的表单。
  // 切到企业微信时（recover）先找回本账号还没结束、或可以续接的企业微信任务。
  const selectPlatform = useCallback((next: ProviderId, recover = true) => {
    if (next === 'wecom' && !wecomAllowedRef.current) return;
    releaseWecomJob();
    setSubmitting(false);
    setPlatform(next);
    setView({ kind: 'form' });
    setBotId('');
    setWecomMode('qr');
    if (next !== 'wecom' || !recover) return;
    const seq = wecomSeqRef.current;
    void fetch('/api/bot-onboarding/wecom-jobs', {credentials: 'same-origin'})
      .then(async response => response.ok ? response.json() : undefined)
      .then(body => {
        if (seq !== wecomSeqRef.current) return;
        const job = body?.jobs?.find((item: WecomOnboardingSnapshot) => item.platform === 'wecom' && (item.retryable || !['failed','cancelled','completed'].includes(item.status)));
        if (!job) return;
        applyWecomJob(job);
        if (!wecomJobTerminal(job)) startWecomPolling(job.id, seq);
      }).catch(() => { /* New creation remains available when no receipt is accessible. */ });
  }, [applyWecomJob, releaseWecomJob, startWecomPolling]);

  const wecomAction = useCallback(async (action: 'retry' | 'refresh') => {
    if (wecomBusyRef.current || view.kind !== 'wecom-job') return;
    wecomBusyRef.current = true;
    setSubmitting(true);
    stopWecomPolling();
    const seq = ++wecomSeqRef.current;
    const job = view.job;
    try {
      const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(job.id)}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: controlCsrfHeaders(),
      });
      const body = await res.json();
      if (wecomSeqRef.current !== seq) return;
      if (!res.ok || !body?.job) throw new Error(body?.message ?? body?.error ?? `http_${res.status}`);
      applyWecomJob(body.job);
      if (!wecomJobTerminal(body.job)) startWecomPolling(body.job.id, seq);
    } catch (error) {
      if (wecomSeqRef.current === seq) {
        setView({kind: 'wecom-job', job, actionError: caughtErrorText(error)});
        if (!wecomJobTerminal(job)) startWecomPolling(job.id, seq);
      }
    } finally {
      if (wecomSeqRef.current === seq) {wecomBusyRef.current = false; setSubmitting(false);}
    }
  }, [applyWecomJob, startWecomPolling, stopWecomPolling, view]);

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
          platform={platform}
          wecomMode={wecomMode}
          backend={backend}
          botId={botId}
          secret={secret}
          onWecomModeChange={mode => { setWecomMode(mode); setSecret(''); }}
          onBackendChange={setBackend}
          onBotIdChange={setBotId}
          onSecretChange={setSecret}
          cliState={cliState}
          form={form}
          allowLocal={cloneSourceAppId === undefined}
          allowManual={cloneSourceAppId === undefined}
          cliRecheckSeq={cliRecheckSeq}
          sessionMode={sessionMode}
          error={view.error}
          submitting={submitting}
          onFormChange={setForm}
          onCliChange={handleCliChange}
          onRecheckCli={handleRecheckCli}
          onSessionModeChange={setSessionMode}
          onSubmit={submitForm}
          onClose={close}
        />
      );
    }
    if (view.kind === 'wecom-job') {
      const finished = ['failed', 'cancelled', 'completed'].includes(view.job.status);
      const expired = view.job.error === 'wecom_onboarding_expired';
      return (
        <>
          <WecomOnboardingJobView job={view.job} busy={submitting} error={view.actionError} onAction={wecomAction} onClose={close} />
          {finished ? (
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                selectPlatform('wecom', false);
                if (expired) setWecomMode('manual');
              }}
            >
              {expired ? t('botOnboarding.wecom.reconnectExisting') : t('botOnboarding.wecom.createAnother')}
            </button>
          ) : null}
        </>
      );
    }
    return (
      <OnboardingJobView
        view={view}
        allowManual={cloneSourceAppId === undefined}
        cancelling={cancelling}
        ownerInput={ownerInput}
        ownerIdInput={ownerIdInput}
        onOwnerInputChange={setOwnerInput}
        onOwnerIdInputChange={setOwnerIdInput}
        onSubmitOwner={submitOwner}
        onRetry={retry}
        onBackToManualForm={switchToManualForm}
        onClose={close}
      />
    );
  }, [backend, botId, cancelling, cliRecheckSeq, cliState, close, form, handleCliChange, handleRecheckCli, ownerIdInput, ownerInput, platform, props.open, retry, secret, selectPlatform, sessionMode, submitForm, submitOwner, submitting, switchToManualForm, view, wecomAction, wecomMode]);

  const canClose = platform !== 'lark' || (!cancelling && (view.kind === 'form' || (view.kind === 'job' && (view.job.status === 'completed' || view.job.status === 'failed' || view.job.status === 'waiting_for_scan'))));

  // 企业微信是旁路入口，不占飞书流程的步骤：飞书表单首屏最下方一条次要链接，只在服务端声明
  // 可创建企业微信机器人时出现（克隆是飞书概念，克隆模式下不出现）。放在表单之后，打开弹窗时的
  // 默认焦点仍落在飞书表单上。进入企业微信流程后，同一位置换成切回飞书的链接。
  let platformSwitch: React.ReactNode = null;
  if (props.open && platform === 'wecom') {
    platformSwitch = (
      <OnboardingPlatformSwitch label={t('botOnboarding.switchToLark')} onClick={() => selectPlatform('lark')} />
    );
  } else if (props.open && view.kind === 'form' && wecomCreatable && !cloneSourceAppId) {
    platformSwitch = (
      <OnboardingPlatformSwitch label={t('botOnboarding.switchToWecom')} onClick={() => selectPlatform('wecom')} />
    );
  }

  return (
    <dialog
      className="onboarding-dialog"
      ref={dialogRef}
      onCancel={event => {
        // Always prevent synchronous native dialog dismissal so Escape awaits
        // POST /api/bot-onboarding/:id/cancel before closing.
        event.preventDefault();
        if (canClose) close();
      }}
      onClose={() => { if (props.open && canClose) close(); }}
      onClick={event => { if (canClose && event.target === event.currentTarget) close(); }}
    >
      <article className="onboarding-card">
        <header className="onboarding-header">
          <h3>{t('botOnboarding.title')}</h3>
          <p>{platform === 'wecom' ? t('botOnboarding.wecom.intro') : t('botOnboarding.intro')}</p>
        </header>
        {body}
        {platformSwitch}
      </article>
    </dialog>
  );
}

function OnboardingPlatformSwitch(props: { label: string; onClick(): void }): React.JSX.Element {
  return (
    <div className="onboarding-platform-switch">
      <button type="button" className="onboarding-session-action" data-onboarding-platform-switch="" onClick={props.onClick}>
        {props.label}
      </button>
    </div>
  );
}
