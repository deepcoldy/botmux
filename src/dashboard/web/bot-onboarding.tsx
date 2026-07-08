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
};

type CliOptionsState = {
  options: CliOption[];
  ttadkModelDefault: string;
  ttadkModelSuggestions: string[];
};

type OnboardingFormState = {
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
  };
}

function defaultFormState(): OnboardingFormState {
  return {
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

function statusText(job: OnboardingJob): string {
  if (job.status === 'waiting_for_scan') return t('botOnboarding.waiting');
  if (job.status === 'verifying') return t('botOnboarding.verifying');
  if (job.status === 'configuring_permissions') {
    return job.permissionStatusMsg
      ? `${t('botOnboarding.configuringPermissions')} ${job.permissionStatusMsg}`
      : t('botOnboarding.configuringPermissions');
  }
  if (job.status === 'waiting_for_platform_scan') return t('botOnboarding.platformScanHint');
  if (job.status === 'needs_owner') return t('botOnboarding.needsOwner');
  if (job.status === 'completed') return t('botOnboarding.completed');
  if (job.status === 'failed') return `${t('botOnboarding.failed')}: ${job.message ?? job.error ?? 'unknown'}`;
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
      return {
        options: body.options as CliOption[],
        ttadkModelDefault,
        ttadkModelSuggestions,
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
  return syncModelForCli(form, cliId, cliState);
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
  onOwnerInputChange(value: string): void;
  onSubmitOwner(job: OnboardingJob, owner: string): void;
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
          props.onSubmitOwner(job, props.ownerInput);
        }}>
          <label className="onboarding-field">
            <span>{t('botOnboarding.ownerLabel')}</span>
            <input
              id="ob-owner"
              type="text"
              placeholder={t('botOnboarding.ownerPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              value={props.ownerInput}
              onChange={event => props.onOwnerInputChange(event.currentTarget.value)}
            />
          </label>
          <p className="hint-warn">{t('botOnboarding.ownerHint')}</p>
          {ownerError ? <p className="form-error">{ownerError}</p> : null}
          <div className="actions onboarding-actions">
            <button type="button" onClick={props.onClose}>{t('botOnboarding.close')}</button>
            <button type="submit" className="primary onboarding-submit">{t('botOnboarding.ownerSubmit')}</button>
          </div>
        </form>
      ) : null}
      {job.status === 'completed' ? (
        <p className="hint-ok">{job.liveStarted ? t('botOnboarding.liveOk') : t('botOnboarding.restartHint')}</p>
      ) : null}
      {job.status !== 'needs_owner' ? <div className="actions onboarding-actions">
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
}): JSX.Element {
  const selectedCli = props.cliState.options.find(option => option.id === props.form.cliId);
  const acceptsModel = selectedCli?.gateway === 'ttadk' && selectedCli.acceptsModel !== false;
  const modelDisabled = selectedCli?.gateway === 'ttadk' && selectedCli.acceptsModel === false;
  const modelPlaceholder = modelDisabled
    ? t('botOnboarding.modelTtadkCocoPlaceholder')
    : acceptsModel
      ? t('botOnboarding.modelTtadkPlaceholder').replace('{model}', props.cliState.ttadkModelDefault)
      : t('botOnboarding.modelPlaceholder');
  const dirLabel = props.form.dirMode === 'card' ? t('botOnboarding.dirLabelCard') : t('botOnboarding.dirLabelFixed');
  const dirPlaceholder = props.form.dirMode === 'card'
    ? t('botOnboarding.dirPlaceholderCard')
    : t('botOnboarding.dirPlaceholderFixed');
  const cliOptions = props.cliState.options.map(option => ({
    value: option.id,
    label: `${option.label}（${option.id}）`,
  }));
  const dirModeOptions: Array<{ value: OnboardingFormState['dirMode']; label: string }> = [
    { value: 'fixed', label: t('botOnboarding.dirModeFixed') },
    { value: 'card', label: t('botOnboarding.dirModeCard') },
  ];

  return (
    <form id="onboarding-form" className="onboarding-form" onSubmit={props.onSubmit}>
      <label className="onboarding-field">
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
      </label>
      <label className="onboarding-field">
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
      </label>
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
      <label className="onboarding-field">
        <span>{t('botOnboarding.modelLabel')}</span>
        <input
          id="ob-model"
          type="text"
          list={acceptsModel ? 'ob-model-suggestions' : undefined}
          placeholder={modelPlaceholder}
          autoComplete="off"
          spellCheck={false}
          disabled={modelDisabled}
          value={props.form.model}
          onChange={event => props.onFormChange({ ...props.form, model: event.currentTarget.value })}
        />
        {acceptsModel ? (
          <datalist id="ob-model-suggestions">
            {props.cliState.ttadkModelSuggestions.map(model => <option value={model} key={model} />)}
          </datalist>
        ) : null}
      </label>
      {props.error ? <p className="form-error">{props.error}</p> : null}
      <div className="actions onboarding-actions">
        <button type="button" id="ob-cancel" disabled={props.submitting} onClick={props.onClose}>{t('botOnboarding.cancel')}</button>
        <button type="submit" className="primary onboarding-submit" disabled={props.submitting}>
          {props.submitting ? t('botOnboarding.starting') : t('botOnboarding.startScan')}
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
  const [view, setView] = useState<ViewState>({ kind: 'form' });
  const [submitting, setSubmitting] = useState(false);
  const [ownerInput, setOwnerInput] = useState('');

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
    if (job.status === 'needs_owner') setOwnerInput('');
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
    setView({ kind: 'form' });
    setSubmitting(false);
    setOwnerInput('');
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

  const submitForm = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    stopPolling();
    setSubmitting(true);
    setView({ kind: 'job', job: { id: '', status: 'starting' } });
    try {
      const res = await fetch('/api/bot-onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
  }, [applyJob, form, startPolling, stopPolling]);

  const submitOwner = useCallback(async (job: OnboardingJob, ownerRaw: string) => {
    if (!ownerRaw.trim()) {
      setView({ kind: 'job', job, ownerError: t('botOnboarding.ownerEmpty') });
      return;
    }
    try {
      const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(job.id)}/owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: ownerRaw.trim() }),
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
        onOwnerInputChange={setOwnerInput}
        onSubmitOwner={submitOwner}
        onClose={close}
      />
    );
  }, [cliState, close, form, ownerInput, submitForm, submitOwner, submitting, view]);

  return (
    <dialog
      className="onboarding-dialog"
      ref={dialogRef}
      onClose={close}
      onClick={event => { if (event.target === event.currentTarget) close(); }}
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
