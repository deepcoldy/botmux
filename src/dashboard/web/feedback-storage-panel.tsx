import React, { useEffect, useState } from 'react';
import { t } from './ui.js';
import { controlCsrfHeaders } from './control-csrf.js';

type Target = {
  backend: 'sqlite' | 'postgresql';
  postgres?: { host: string; port: number; database: string; user: string; schema: string;
    connectTimeoutMs: number; tls: { mode: 'verify-full' | 'disable'; hasCa?: boolean }; hasPassword?: boolean };
};
type StorageStatus = { generation: number; active: Target; candidate?: Target; migrations: Array<{ migrationId: string; phase: string; blockers: string[] }> };
const defaults: NonNullable<Target['postgres']> = {
  host: 'localhost', port: 5432, database: 'botmux', user: 'botmux', schema: 'botmux_feedback',
  connectTimeoutMs: 5000, tls: { mode: 'verify-full' },
};

export function FeedbackStoragePanel(): React.JSX.Element | null {
  const [status, setStatus] = useState<StorageStatus>();
  const [backend, setBackend] = useState<Target['backend']>('sqlite');
  const [postgres, setPostgres] = useState(defaults);
  const [password, setPassword] = useState('');
  const [ca, setCa] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [requestId, setRequestId] = useState<string>();
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
        const { hasPassword: _password, tls, ...values } = selected.postgres;
        setPostgres({ ...values, tls: { mode: tls.mode } });
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
      if (path === 'configure') { setPassword(''); setCa(''); setRequestId(undefined); }
      await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'feedback_storage_operation_failed'); }
    finally { setBusy(false); }
  }
  if (forbidden || !status) return null;
  const latest = status.migrations.at(-1);
  const migrating = latest && latest.phase !== 'complete';
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
        {(['host', 'port', 'database', 'user', 'schema'] as const).map(field => <label key={field}>
          {t(`feedback.storage.${field}`)}
          <input value={postgres[field]} type={field === 'port' ? 'number' : 'text'} disabled={busy || !!migrating}
            onChange={event => setPostgres(current => ({ ...current, [field]: field === 'port' ? Number(event.target.value) : event.target.value }))} />
        </label>)}
        <label>{t('feedback.storage.password')}<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={t('feedback.storage.keepPassword')} /></label>
        <label>TLS<select value={postgres.tls.mode} onChange={event => setPostgres(current => ({ ...current, tls: { mode: event.target.value as 'verify-full' | 'disable' } }))}>
          <option value="verify-full">{t('feedback.storage.verifyTls')}</option><option value="disable">{t('feedback.storage.disableTls')}</option>
        </select></label>
        <label>{t('feedback.storage.ca')}<textarea value={ca} onChange={event => setCa(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></label>
      </>}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button id="feedback-storage-save" disabled={busy || !!migrating} onClick={() => {
        const candidate = backend === 'sqlite' ? { backend } : { backend, postgres };
        void action('configure', { expectedGeneration: status.generation, candidate, ...(password ? { password } : {}), ...(ca ? { ca } : {}) });
      }}>{t('feedback.storage.save')}</button>
      <button disabled={busy} onClick={() => void action('test')}>{t('feedback.storage.test')}</button>
    </div>
    <p>{t('feedback.storage.current')}: {status.active.backend}; {t('feedback.storage.candidate')}: {status.candidate?.backend ?? '—'}</p>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {t('feedback.storage.confirm')}</label>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button disabled={busy || !confirmed || !status.candidate || !!migrating} onClick={() => {
        const identity = requestId ?? crypto.randomUUID();
        setRequestId(identity);
        void action('migrate', { requestId: identity, expectedGeneration: status.generation, maintenanceConfirmed: true });
      }}>{t('feedback.storage.migrate')}</button>
      <button disabled={busy || !confirmed || !status.candidate || !!migrating} onClick={() => void action('enable-empty', { expectedGeneration: status.generation, confirmed: true })}>{t('feedback.storage.empty')}</button>
      {latest?.phase === 'blocked' && <button disabled={busy || !confirmed} onClick={() => void action(`migrations/${latest.migrationId}/resume`)}>{t('feedback.storage.resume')}</button>}
    </div>
    {latest && <p role="status">{latest.migrationId}: {latest.phase} {latest.blockers?.join(', ')}</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}
