import React, { useEffect, useState } from 'react';
import { t } from './ui.js';
import { controlCsrfHeaders } from './control-csrf.js';

type Target = {
  backend: 'sqlite' | 'postgresql';
  postgres?: { host: string; port: number; database: string; user: string; schema: string;
    connectTimeoutMs: number; tls: { mode: 'verify-full' | 'disable'; hasCa?: boolean }; hasPassword?: boolean;
    bytepg?: { computeId: string; hasToken?: boolean; doas?: { psm: string; environment: string } } };
};
type StorageStatus = { generation: number; active: Target; candidate?: Target; migrations: Array<{ migrationId: string; phase: string; blockers: string[] }> };
type RecoveryItem = { kind: 'webhook' | 'send'; id: string; fingerprint: string; status: string; live: boolean; acknowledged: boolean; eventId?: string; destinationId?: string; marker?: string };
const defaults: NonNullable<Target['postgres']> = {
  host: 'localhost', port: 5432, database: 'botmux', user: 'botmux', schema: 'botmux_feedback',
  connectTimeoutMs: 5000, tls: { mode: 'verify-full' },
};

export function FeedbackStoragePanel(): React.JSX.Element | null {
  const [status, setStatus] = useState<StorageStatus>();
  const [backend, setBackend] = useState<Target['backend']>('sqlite');
  const [postgres, setPostgres] = useState(defaults);
  const [password, setPassword] = useState('');
  const [authentication, setAuthentication] = useState<'password' | 'bytepg'>('password');
  const [computeId, setComputeId] = useState('');
  const [token, setToken] = useState('');
  const [tokenSource, setTokenSource] = useState<'reference' | 'doas'>('reference');
  const [doasPsm, setDoasPsm] = useState('');
  const [doasEnvironment, setDoasEnvironment] = useState('boe');
  const [ca, setCa] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [requestId, setRequestId] = useState<string>();
  const [recovery, setRecovery] = useState<RecoveryItem[]>([]);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  async function reload(initial = false) {
    const response = await fetch('/api/feedback/storage');
    if (response.status === 403) { setForbidden(true); return; }
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'feedback_storage_operation_failed');
    if (!body.active) return;
    setStatus(body);
    if (initial) {
      const selected = body.candidate ?? body.active;
      setBackend(selected.backend);
      if (selected.postgres) {
        const { hasPassword: _password, bytepg, tls, ...values } = selected.postgres;
        setAuthentication(bytepg ? 'bytepg' : 'password');
        setComputeId(bytepg?.computeId ?? '');
        setTokenSource(bytepg?.doas ? 'doas' : 'reference');
        setDoasPsm(bytepg?.doas?.psm ?? '');
        setDoasEnvironment(bytepg?.doas?.environment ?? 'boe');
        setPostgres({ ...values, user: values.user ?? '', tls: { mode: tls.mode } });
      }
    }
  }
  useEffect(() => {
    let live = true;
    void reload(true).catch(error => { if (live) setMessage(error.message); });
    const timer = setInterval(() => { void reload().catch(() => {}); }, 2500);
    return () => { live = false; clearInterval(timer); };
  }, []);
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/feedback/storage/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...controlCsrfHeaders() }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'feedback_storage_operation_failed');
      setMessage(t('feedback.storage.success'));
      if (path === 'configure') { setPassword(''); setToken(''); setCa(''); setRequestId(undefined); }
      // A cancelled job is terminal: the panel must mint a fresh requestId for
      // the next migration attempt, or prepareFeedbackMigration would keep
      // returning the old cancelled job (its resume is a permanent no-op).
      if (path.endsWith('/cancel')) setRequestId(undefined);
      await reload();
      if (path.startsWith('recovery/')) await loadRecovery();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'feedback_storage_operation_failed'); }
    finally { setBusy(false); }
  }
  async function loadRecovery() {
    const response = await fetch('/api/feedback/storage/recovery');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'feedback_storage_operation_failed');
    setRecovery(body.items ?? []);
  }
  if (forbidden || !status) return null;
  const latest = status.migrations.find(job => !['complete', 'cancelled'].includes(job.phase)) ?? status.migrations.at(-1);
  const migrating = latest && !['complete', 'cancelled'].includes(latest.phase);
  return <details className="panel feedback-storage-panel">
    <summary>{t('feedback.storage.title')} · {status.active.backend === 'sqlite' ? 'SQLite' : 'PostgreSQL'}</summary>
    <p>{t('feedback.storage.help')}</p>
    <div className="feedback-filter-fields" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
      <label>{t('feedback.storage.backend')}
        <select id="feedback-storage-backend" value={backend} disabled={busy || !!migrating}
          onChange={event => setBackend(event.target.value as Target['backend'])}>
          <option value="sqlite">SQLite</option><option value="postgresql">PostgreSQL</option>
        </select>
      </label>
      {backend === 'postgresql' && <>
        <label>{t('feedback.storage.authentication')}
          <select id="feedback-storage-authentication" value={authentication} disabled={busy || !!migrating}
            onChange={event => { setAuthentication(event.target.value as 'password' | 'bytepg'); setPassword(''); setToken(''); }}>
            <option value="password">{t('feedback.storage.passwordAuth')}</option>
            <option value="bytepg">{t('feedback.storage.bytepgAuth')}</option>
          </select>
        </label>
        {(['host', 'port', 'database', 'user', 'schema'] as const).map(field => <label key={field}>
          {t(`feedback.storage.${field}`)}
          <input value={postgres[field]} type={field === 'port' ? 'number' : 'text'} disabled={busy || !!migrating}
            onChange={event => setPostgres(current => ({ ...current, [field]: field === 'port' ? Number(event.target.value) : event.target.value }))} />
        </label>)}
        {authentication === 'password'
          ? <label>{t('feedback.storage.password')}<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={t('feedback.storage.keepPassword')} /></label>
          : <>
            <label>{t('feedback.storage.computeId')}<input id="feedback-storage-compute-id" value={computeId} onChange={event => setComputeId(event.target.value)} /></label>
            <label>{t('feedback.storage.tokenSource')}<select id="feedback-storage-token-source" value={tokenSource} onChange={event => { setTokenSource(event.target.value as 'reference' | 'doas'); setToken(''); }}>
              <option value="reference">{t('feedback.storage.staticToken')}</option><option value="doas">{t('feedback.storage.doasToken')}</option>
            </select></label>
            {tokenSource === 'reference'
              ? <label>{t('feedback.storage.token')}<input id="feedback-storage-token" type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder={t('feedback.storage.keepToken')} /></label>
              : <>
                <label>PSM<input id="feedback-storage-doas-psm" value={doasPsm} onChange={event => setDoasPsm(event.target.value)} /></label>
                <label>{t('feedback.storage.doasEnvironment')}<select value={doasEnvironment} onChange={event => setDoasEnvironment(event.target.value)}>
                  {['boe', 'cn', 'row', 'nontt', 'euttp', 'usttp'].map(value => <option key={value} value={value}>{value}</option>)}
                </select></label>
                <p>{t('feedback.storage.doasHelp')}</p>
              </>}
          </>}
        <label>TLS<select value={postgres.tls.mode} onChange={event => setPostgres(current => ({ ...current, tls: { mode: event.target.value as 'verify-full' | 'disable' } }))}>
          <option value="verify-full">{t('feedback.storage.verifyTls')}</option><option value="disable">{t('feedback.storage.disableTls')}</option>
        </select></label>
        <label>{t('feedback.storage.ca')}<textarea value={ca} onChange={event => setCa(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></label>
      </>}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button id="feedback-storage-save" disabled={busy || !!migrating} onClick={() => {
        const candidate = backend === 'sqlite' ? { backend } : { backend, postgres: {
          ...postgres, ...(authentication === 'bytepg' ? { user: postgres.user || undefined, bytepg: { computeId,
            ...(tokenSource === 'doas' ? { doas: { psm: doasPsm, environment: doasEnvironment } } : { tokenRef: '' }) } } : {}),
        } };
        void action('configure', { expectedGeneration: status.generation, candidate,
          ...(authentication === 'password' && password ? { password } : {}),
          ...(authentication === 'bytepg' && tokenSource === 'reference' && token ? { token } : {}), ...(ca ? { ca } : {}) });
      }}>{t('feedback.storage.save')}</button>
      <button disabled={busy} onClick={() => void action('test')}>{t('feedback.storage.test')}</button>
    </div>
    <p>{t('feedback.storage.current')}: {status.active.backend}; {t('feedback.storage.candidate')}: {status.candidate?.backend ?? '—'}</p>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {t('feedback.storage.confirm')}</label>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button id="feedback-storage-migrate" disabled={busy || !confirmed || !status.candidate || !!migrating} onClick={() => {
        const identity = requestId ?? crypto.randomUUID();
        setRequestId(identity);
        void action('migrate', { requestId: identity, expectedGeneration: status.generation, maintenanceConfirmed: true });
      }}>{t('feedback.storage.migrate')}</button>
      <button disabled={busy || !confirmed || !status.candidate || !!migrating} onClick={() => void action('enable-empty', { expectedGeneration: status.generation, confirmed: true })}>{t('feedback.storage.empty')}</button>
      {latest?.phase === 'blocked' && <button disabled={busy || !confirmed} onClick={() => void action(`migrations/${latest.migrationId}/resume`)}>{t('feedback.storage.resume')}</button>}
    </div>
    <details style={{ marginTop: 16 }}>
      <summary>{t('feedback.storage.recovery')}</summary>
      <p>{t('feedback.storage.recoveryHelp')}</p>
      <label>{t('feedback.storage.reason')}<input id="feedback-recovery-reason" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label>{t('feedback.storage.evidence')}<input id="feedback-recovery-evidence" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      {migrating && <button id="feedback-storage-cancel" disabled={busy || !confirmed || !reason.trim() || !evidence.trim()} onClick={() =>
        void action(`migrations/${latest.migrationId}/cancel`, { confirmed, reason, evidence })}>{t('feedback.storage.cancel')}</button>}
      <button onClick={() => void loadRecovery().catch(error => setMessage(error.message))}>{t('feedback.storage.inspectRecovery')}</button>
      {recovery.map(item => <div key={`${item.kind}:${item.id}`} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
        <strong>{item.kind}: {item.id}</strong>
        <p>{item.status} {item.eventId} {item.destinationId} {item.marker}</p>
        <button disabled={busy || item.live || item.acknowledged || !confirmed || !reason.trim() || !evidence.trim()}
          onClick={() => void action('recovery/acknowledge', { kind: item.kind, id: item.id, fingerprint: item.fingerprint, confirmed, reason, evidence })}>
          {item.acknowledged ? t('feedback.storage.acknowledged') : t('feedback.storage.acknowledge')}
        </button>
      </div>)}
    </details>
    {latest && <p role="status">{latest.migrationId}: {latest.phase} {latest.blockers?.join(', ')}</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}
