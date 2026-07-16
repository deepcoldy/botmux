import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DropdownMenu } from './dashboard-components.js';
import { t } from './ui.js';

export const OPEN_BOT_ONBOARDING_EVENT = 'botmux:open-bot-onboarding';

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
  registrationMode?: 'web' | 'compat';
  cliId?: string;
  workingDir?: string;
  addedBotIndex?: number;
  liveStarted?: boolean;
  liveStartMessage?: string;
  permission?: OnboardingPermission;
  remainingSteps?: RemainingStep[];
  error?: string;
  message?: string;
};

type CliOption = {
  id: string;
  label: string;
  gateway?: 'ttadk';
  acceptsModel?: boolean;
  available?: boolean;
  command?: string;
  availabilityReason?: string;
};

type CliOptionsState = {
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
    webSession: { status: 'checking' },
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

export function isOnboardingSubmitDisabled(
  submitting: boolean,
  sessionMode: 'checking' | 'reuse' | 'qr',
): boolean {
  return submitting || sessionMode === 'checking';
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
    if (job.error === 'qr_expired') return t('botOnboarding.qrExpiredTitle');
    if (isSessionFailure(job.error)) return t('botOnboarding.authIncompleteTitle');
    return t('botOnboarding.createFailedTitle');
  }
  return t('botOnboarding.starting');
}

async function fetchCliOptions(): Promise<CliOptionsState> {
  try {
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
        options: body.options as CliOption[],
        ttadkModelDefault,
        ttadkModelSuggestions,
        suggestedAppName,
        webSession,
      };
    }
  } catch { /* fall through to default */ }
  return { ...defaultCliOptionsState(), webSession: { status: 'scan_required' } };
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

export async function openBotOnboarding(): Promise<void> {
  window.dispatchEvent(new Event(OPEN_BOT_ONBOARDING_EVENT));
}

function PermissionSummary(props: { job: OnboardingJob }): JSX.Element | null {
  const { job } = props;
  if ((job.status !== 'completed' && job.status !== 'needs_owner') || !job.permission) return null;
  const permission = job.permission;
  if (permission.ok) {
    const parts = [t('botOnboarding.permissionOk', { count: permission.scopeCount ?? 0 })];
    if (permission.skippedScopeCount && permission.skippedScopeCount > 0) {
      parts.push(t('botOnboarding.permissionSkipped', { count: permission.skippedScopeCount }));
    }
    if (permission.versionId) parts.push(t('botOnboarding.permissionVersion', { version: permission.versionId }));
    return (
      <>
        <p className="hint-ok">{parts.join(' ')}</p>
        {permission.scopeWarning ? <p className="hint-warn">{permission.scopeWarning}</p> : null}
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

function OnboardingMeta(props: { job: OnboardingJob }): JSX.Element | null {
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

function QrCard(props: { dataUrl: string; alt: string; link?: string }): JSX.Element {
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

function OnboardingJobView(props: {
  view: Extract<ViewState, { kind: 'job' }>;
  ownerInput: string;
  ownerIdInput: string;
  onOwnerInputChange(value: string): void;
  onOwnerIdInputChange(value: string): void;
  onSubmitOwner(job: OnboardingJob, owner: string, ownerId: string): void;
  onRetry(mode: 'web' | 'compat'): void;
  onClose(): void;
}): JSX.Element {
  const { job, ownerError } = props.view;
  return (
    <>
      <p className={`onboarding-status status-${job.status}`}>{statusText(job)}</p>
      {job.status === 'waiting_for_scan' && job.qrDataUrl ? (
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
              type="email"
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
            {job.appId
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
            {!job.appId ? (
              <>
                <button type="button" onClick={() => props.onRetry('compat')}>{t('botOnboarding.compatibilityMode')}</button>
                <button type="button" className="primary onboarding-submit" onClick={() => props.onRetry('web')}>
                  {job.error === 'qr_expired'
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
  sessionMode: 'checking' | 'reuse' | 'qr';
  error?: string;
  submitting: boolean;
  onFormChange(form: OnboardingFormState): void;
  onSessionModeChange(mode: 'reuse' | 'qr'): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onClose(): void;
}): JSX.Element {
  const selectedCli = props.cliState.options.find(option => option.id === props.form.cliId);
  const acceptsModel = selectedCli?.gateway === 'ttadk' && selectedCli.acceptsModel !== false;
  const modelDisabled = selectedCli?.gateway === 'ttadk' && selectedCli.acceptsModel === false;
  const modelPlaceholder = acceptsModel
      ? t('botOnboarding.modelTtadkPlaceholder').replace('{model}', props.cliState.ttadkModelDefault)
      : t('botOnboarding.modelPlaceholder');
  const dirLabel = props.form.dirMode === 'card' ? t('botOnboarding.dirLabelCard') : t('botOnboarding.dirLabelFixed');
  const dirPlaceholder = props.form.dirMode === 'card'
    ? t('botOnboarding.dirPlaceholderCard')
    : t('botOnboarding.dirPlaceholderFixed');
  const cliOptions = props.cliState.options.map(option => ({
    value: option.id,
    label: option.available === false
      ? t('botOnboarding.cliMissingOption', { label: option.label, command: option.command ?? option.id })
      : option.label,
  }));
  const dirModeOptions: Array<{ value: OnboardingFormState['dirMode']; label: string }> = [
    { value: 'fixed', label: t('botOnboarding.dirModeFixed') },
    { value: 'card', label: t('botOnboarding.dirModeCard') },
  ];

  return (
    <form id="onboarding-form" className="onboarding-form" onSubmit={props.onSubmit}>
      <div className="onboarding-session" aria-live="polite">
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
      </div>
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
          onChange={cliId => {
            props.onFormChange(syncModelForCli(props.form, cliId, props.cliState));
          }}
        />
        {selectedCli?.available === false ? (
          <small className="hint-warn">
            {t('botOnboarding.cliMissingHint', { command: selectedCli.command ?? props.form.cliId })}
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
      {!modelDisabled ? <label className="onboarding-field">
        <span>{t('botOnboarding.modelLabel')}</span>
        <input
          id="ob-model"
          type="text"
          list={acceptsModel ? 'ob-model-suggestions' : undefined}
          placeholder={modelPlaceholder}
          autoComplete="off"
          spellCheck={false}
          value={props.form.model}
          onChange={event => props.onFormChange({ ...props.form, model: event.currentTarget.value })}
        />
        {acceptsModel ? (
          <datalist id="ob-model-suggestions">
            {props.cliState.ttadkModelSuggestions.map(model => <option value={model} key={model} />)}
          </datalist>
        ) : null}
      </label> : null}
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
          disabled={isOnboardingSubmitDisabled(props.submitting, props.sessionMode)}
        >
          {props.submitting
            ? t('botOnboarding.starting')
            : props.sessionMode === 'reuse'
              ? t('botOnboarding.confirmReuse')
              : t('botOnboarding.startScan')}
        </button>
      </div>
    </form>
  );
}

export function BotOnboardingDialog(props: { open: boolean; onClose(): void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);
  const [cliState, setCliState] = useState<CliOptionsState>(() => defaultCliOptionsState());
  const [form, setForm] = useState<OnboardingFormState>(() => defaultFormState());
  const [sessionMode, setSessionMode] = useState<'checking' | 'reuse' | 'qr'>('checking');
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
    props.onClose();
  }, [props, stopPolling]);

  const applyJob = useCallback((job: OnboardingJob) => {
    setView({ kind: 'job', job });
    if (job.status === 'needs_owner') {
      setOwnerInput('');
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
    setForm(defaultFormState());
    setSessionMode('checking');
    setView({ kind: 'form' });
    setSubmitting(false);
    setOwnerInput('');
    setOwnerIdInput('');
    void fetchCliOptions().then(next => {
      if (loadSeqRef.current !== seq) return;
      setCliState(next);
      setForm(current => normalizeFormForOptions(current, next));
      setSessionMode(next.webSession.status === 'ready' ? 'reuse' : 'qr');
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
    registrationMode: 'web' | 'compat',
    sessionModeOverride?: 'reuse' | 'qr',
  ) => {
    stopPolling();
    setSubmitting(true);
    setView({ kind: 'job', job: { id: '', status: 'starting' } });
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
          appName: registrationMode === 'web' ? form.appName.trim() || undefined : undefined,
          registrationMode,
          ...(registrationMode === 'web' ? { sessionMode: effectiveSessionMode, expectedIdentity } : {}),
          cliId: form.cliId,
          workingDir: form.workingDir.trim(),
          dirMode: form.dirMode,
          model: form.model.trim() || undefined,
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
  }, [applyJob, cliState.webSession, form, sessionMode, startPolling, stopPolling]);

  const submitForm = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void startOnboarding('web');
  }, [startOnboarding]);

  const retry = useCallback((registrationMode: 'web' | 'compat') => {
    if (registrationMode === 'compat') {
      const accepted = window.confirm(t('botOnboarding.compatibilityConfirm'));
      if (!accepted) return;
    }
    const requiresFreshLogin = registrationMode === 'web'
      && view.kind === 'job'
      && isSessionFailure(view.job.error);
    if (requiresFreshLogin) setSessionMode('qr');
    void startOnboarding(registrationMode, requiresFreshLogin ? 'qr' : undefined);
  }, [startOnboarding, view]);

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
    if (view.kind === 'form') {
      return (
        <OnboardingForm
          cliState={cliState}
          form={form}
          sessionMode={sessionMode}
          error={view.error}
          submitting={submitting}
          onFormChange={setForm}
          onSessionModeChange={setSessionMode}
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
  }, [cliState, close, form, ownerIdInput, ownerInput, retry, sessionMode, submitForm, submitOwner, submitting, view]);

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
