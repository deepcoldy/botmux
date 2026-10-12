import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_GROUP_IDLE_CLOSE, parseGroupIdleClose, type GroupIdleCloseSettings } from '../../core/group-idle-close.js';
import { useT } from './react-hooks.js';

type Props = {
  chatId: string;
  appId: string;
  botName: string;
  settings?: GroupIdleCloseSettings;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
};

export function GroupIdleCloseRow(props: Props) {
  const tr = useT();
  const initial = props.settings ?? DEFAULT_GROUP_IDLE_CLOSE;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [duration, setDuration] = useState(String(initial.duration));
  const [unit, setUnit] = useState(initial.unit);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const dirty = useRef(false);
  const savingRef = useRef(false);
  useEffect(() => {
    if (dirty.current || savingRef.current) return;
    const settings = props.settings ?? DEFAULT_GROUP_IDLE_CLOSE;
    setEnabled(settings.enabled);
    setDuration(String(settings.duration));
    setUnit(settings.unit);
  }, [props.settings]);

  let valid = /^\d+$/.test(duration);
  try { parseGroupIdleClose({ enabled, duration: Number(duration), unit }); }
  catch { valid = false; }
  function markDirty() {
    dirty.current = true;
    setStatus(tr('groups.idleCloseUnsaved'));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || props.disabled || (enabled && !valid)) return;
    // Turning the feature off must still work while the duration is being edited.
    const settings = enabled || valid
      ? { enabled, duration: Number(duration), unit }
      : { ...(props.settings ?? DEFAULT_GROUP_IDLE_CLOSE), enabled: false };
    savingRef.current = true;
    setSaving(true);
    setStatus(tr('groups.serialInputSaving'));
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/idle-close/${encodeURIComponent(props.appId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
      const saved = parseGroupIdleClose(body.settings);
      setEnabled(saved.enabled);
      setDuration(String(saved.duration));
      setUnit(saved.unit);
      dirty.current = false;
      setStatus(tr('groups.idleCloseSaved'));
      try { await props.onSaved(); }
      catch { setStatus(tr('groups.serialInputRefreshFailed')); }
    } catch (error) {
      setStatus(tr('groups.serialInputFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally { savingRef.current = false; setSaving(false); }
  }

  const disabled = props.disabled || saving;
  const id = `idle-close-${props.chatId}-${props.appId}`;
  return <form className="group-idle-close-row" onSubmit={save} noValidate>
    <label className="toggle-row">
      <input type="checkbox" role="switch" checked={enabled} disabled={disabled}
        onChange={event => { setEnabled(event.currentTarget.checked); markDirty(); }} />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-tx"><strong>{props.botName}</strong></span>
    </label>
    <div className="group-idle-close-controls">
      <label htmlFor={`${id}-duration`}>{tr('groups.idleCloseDuration')}</label>
      <input id={`${id}-duration`} type="number" inputMode="numeric" min="1" step="1"
        value={duration} disabled={disabled || !enabled} aria-invalid={enabled && !valid}
        aria-describedby={enabled && !valid ? `${id}-error` : undefined}
        onKeyDown={event => {
          if (!event.ctrlKey && !event.metaKey && ['.', ',', '-', '+', 'e', 'E'].includes(event.key)) event.preventDefault();
        }}
        onChange={event => {
          const next = event.currentTarget.value;
          if (!/^\d*$/.test(next)) return;
          setDuration(next); markDirty();
        }} />
      <select aria-label={tr('groups.idleCloseUnit')} value={unit} disabled={disabled || !enabled}
        onChange={event => { setUnit(event.currentTarget.value as GroupIdleCloseSettings['unit']); markDirty(); }}>
        <option value="days">{tr('groups.idleCloseDays')}</option>
        <option value="hours">{tr('groups.idleCloseHours')}</option>
      </select>
      <button type="submit" disabled={disabled || (enabled && !valid)}>{tr('groups.idleCloseSave')}</button>
    </div>
    {enabled && !valid ? <small id={`${id}-error`} className="hint-warn-inline">{tr('groups.idleCloseInvalid')}</small> : null}
    <small role="status" aria-live="polite">{status}</small>
  </form>;
}
