/** Bot session settings for dedicated-group naming and the optional Codex summary model. */
import { useEffect, useState } from 'react';
import { useT } from './react-hooks.js';
import { DropdownField } from './field-controls.js';

type NamingMode = 'ai-summary' | 'session-title' | 'truncate';
type Naming = { mode: NamingMode; model: string };

/** Render a bot-keyed editor; switching bots remounts it to isolate pending saves. */
export function SessionGroupNamingRow(props: { appId: string; cliId?: string }) {
  const tr = useT();
  const [value, setValue] = useState<Naming>({ mode: 'ai-summary', model: '' });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [reload, setReload] = useState(0);
  const path = `/api/bots/${encodeURIComponent(props.appId)}/session-group-naming-config`;

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    void fetch(path, { signal: controller.signal }).then(async response => {
      const body = await response.json() as Naming & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (controller.signal.aborted) return;
      setValue({ mode: body.mode, model: body.model ?? '' });
      setReady(true);
      setFeedback('');
    }).catch((error: unknown) => { if (!controller.signal.aborted) setFeedback(String(error)); });
    return () => controller.abort();
  }, [path, reload]);

  /** Save both fields atomically and display the server-normalized result. */
  async function save(): Promise<void> {
    setBusy(true);
    setFeedback('');
    try {
      const response = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      const body = await response.json() as Naming & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setValue({ mode: body.mode, model: body.model ?? '' });
      setFeedback(tr('roles.saved'));
    } catch (error: unknown) { setFeedback(String(error)); }
    finally { setBusy(false); }
  }

  const codexSummary = props.cliId === 'codex' && value.mode === 'ai-summary';
  return <div className="bd-row bd-sg-naming" data-session-group-naming-row>
    <div className="bd-field">
      <label className="bd-label">{tr('botDefaults.sgNaming')}</label>
      <DropdownField dataInput="sessionGroupNamingMode" ariaLabel={tr('botDefaults.sgNaming')}
        value={value.mode} disabled={!ready || busy}
        options={[
          { value: 'ai-summary', label: tr('botDefaults.sgNamingAi') },
          { value: 'session-title', label: tr('botDefaults.sgNamingReuse') },
          { value: 'truncate', label: tr('botDefaults.sgNamingTruncate') },
        ]} onChange={mode => setValue(current => ({ ...current, mode: mode as NamingMode }))} />
      <p className="bd-help">{tr(value.mode === 'session-title' ? 'botDefaults.sgNamingReuseHelp' : value.mode === 'truncate' ? 'botDefaults.sgNamingTruncateHelp' : 'botDefaults.sgNamingAiHelp')}</p>
      {props.cliId === 'codex' ? <label className="bd-field">
        <span>{tr('botDefaults.sgNamingModel')}</span>
        <input type="text" maxLength={200} data-input="sessionGroupNamingModel" aria-label={tr('botDefaults.sgNamingModel')} value={value.model}
          disabled={!ready || busy || !codexSummary} placeholder={tr('botDefaults.sgNamingModelPlaceholder')}
          onChange={event => { const model = event.currentTarget.value; setValue(current => ({ ...current, model })); }} />
        <small>{tr('botDefaults.sgNamingModelHelp')}</small>
      </label> : null}
      <button type="button" className="primary" disabled={!ready || busy} onClick={() => void save()}>{tr('roles.save')}</button>
      {!ready && feedback ? <button type="button" onClick={() => setReload(current => current + 1)}>{tr('listeners.retry')}</button> : null}
      <span className="bd-sg-naming-status" role="status">{feedback}</span>
    </div>
  </div>;
}
