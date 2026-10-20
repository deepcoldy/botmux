import { useEffect, useRef, useState } from 'react';
import { useT } from './react-hooks.js';

type Props = {
  chatId: string;
  appId: string;
  botName: string;
  /** Chat override: false == in-chat `/card off`; true inherits the bot-level setting. */
  chatEnabled: boolean;
  /** Bot-level run-process card switch (`!disableStreamingCard`). */
  masterEnabled: boolean;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
};

/**
 * Per-(chat × bot) run-process card switch. Shares the `noCardChats` state with
 * the in-chat `/card off` / `/card on`, but saves silently (nothing is posted
 * into the chat). "On" clears the chat override and inherits the bot setting,
 * so a bot-level off (incl. final-only reply mode) still wins.
 */
export function GroupCardModeRow(props: Props) {
  const tr = useT();
  const [enabled, setEnabled] = useState(props.chatEnabled);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const savingRef = useRef(false);
  // Latest chat state from the snapshot, plus whether one arrived mid-save (an
  // in-chat `/card on|off` or another Dashboard). The effect defers it while
  // saving; the save re-syncs to it once settled, so it is never lost.
  const latestChatEnabledRef = useRef(props.chatEnabled);
  const externalDuringSaveRef = useRef(false);
  latestChatEnabledRef.current = props.chatEnabled;
  useEffect(() => {
    if (savingRef.current) { externalDuringSaveRef.current = true; return; }
    setEnabled(props.chatEnabled);
  }, [props.chatEnabled]);

  async function save(next: boolean) {
    if (savingRef.current || props.disabled) return;
    const previous = enabled;
    savingRef.current = true;
    externalDuringSaveRef.current = false;
    setSaving(true);
    setEnabled(next);
    setStatus(tr('groups.cardModeSaving'));
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/card-mode/${encodeURIComponent(props.appId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
      setEnabled(body.enabled === true);
      setStatus(tr('groups.cardModeSaved'));
      try { await props.onSaved(); }
      catch { setStatus(tr('groups.cardModeRefreshFailed')); }
    } catch (error) {
      setEnabled(previous);
      setStatus(tr('groups.cardModeFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      // Success or failure: a snapshot update deferred during the save wins over
      // both the saved value and the pre-save rollback.
      if (externalDuringSaveRef.current) setEnabled(latestChatEnabledRef.current);
      externalDuringSaveRef.current = false;
      savingRef.current = false;
      setSaving(false);
    }
  }

  const state = !enabled ? 'chat-off' : props.masterEnabled ? 'inherit-on' : 'inherit-off';
  const detail = state === 'chat-off'
    ? tr('groups.cardModeChatOff')
    : state === 'inherit-on' ? tr('groups.cardModeInheritOn') : tr('groups.cardModeInheritOff');
  return <div className="group-card-mode-row" data-bot={props.appId}>
    <label className="toggle-row">
      <input type="checkbox" role="switch" checked={enabled} disabled={props.disabled || saving}
        aria-label={tr('groups.cardModeToggle', { bot: props.botName })}
        onChange={event => { void save(event.currentTarget.checked); }} />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-tx"><strong>{props.botName}</strong></span>
    </label>
    <small className={state === 'inherit-off' ? 'hint-warn-inline' : undefined} data-card-mode-state={state}>{detail}</small>
    <small role="status" aria-live="polite">{status}</small>
  </div>;
}
