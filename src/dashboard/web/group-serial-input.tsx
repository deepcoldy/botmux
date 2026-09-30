import React, { useEffect, useRef, useState } from 'react';
import { useT } from './react-hooks.js';

type Props = {
  chatId: string;
  appId: string;
  botName: string;
  enabled: boolean;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
};

export function GroupSerialInputRow(props: Props) {
  const tr = useT();
  const [enabled, setEnabled] = useState(props.enabled);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const savingRef = useRef(false);
  useEffect(() => { if (!savingRef.current) setEnabled(props.enabled); }, [props.enabled]);
  async function save(enabled: boolean) {
    if (savingRef.current || props.disabled) return;
    savingRef.current = true;
    setSaving(true);
    setStatus(tr('groups.serialInputSaving'));
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/serial-input/${encodeURIComponent(props.appId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
      setEnabled(body.enabled === true);
      setStatus(tr('groups.serialInputSaved'));
      try { await props.onSaved(); }
      catch { setStatus(tr('groups.serialInputRefreshFailed')); }
    } catch (error) {
      setStatus(tr('groups.serialInputFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally { savingRef.current = false; setSaving(false); }
  }
  return <div className="group-serial-input-row">
    <label><input type="checkbox" checked={enabled} disabled={props.disabled || saving}
      onChange={event => { void save(event.target.checked); }} /> {props.botName}</label>
    <small role="status">{status}</small>
  </div>;
}
