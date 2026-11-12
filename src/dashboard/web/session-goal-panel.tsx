import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { GoalAction, GoalControlView } from '../../core/native-goal-control.js';
import { useT } from './react-hooks.js';
import { controlCsrfHeaders } from './control-csrf.js';
import { confirm } from './confirm-modal.js';

export function SessionGoalPanel(props: { sessionId: string; terminalUrl?: string | null }): React.JSX.Element {
  const t = useT();
  const id = useId();
  const [view, setView] = useState<GoalControlView | null>(null);
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const endpoint = `/api/sessions/${encodeURIComponent(props.sessionId)}/goal`;
  const reason = (code: string): string => t(`sessions.goal.error.${code}`) === `sessions.goal.error.${code}`
    ? t('sessions.goal.failed') : t(`sessions.goal.error.${code}`);
  useEffect(() => {
    let alive = true;
    setView(null); setObjective(''); setMessage(''); setError(''); setBusy(false);
    void fetch(endpoint).then(async response => {
      const body = await response.json();
      if (!alive) return;
      if (!response.ok || body.ok !== true || !Array.isArray(body.actions)) {
        setError(reason(body.error ?? 'goal_control_unavailable')); return;
      }
      setView(body);
    }).catch(() => { if (alive) setError(t('sessions.goal.failed')); });
    return () => { alive = false; };
  }, [endpoint]);

  async function act(action: GoalAction): Promise<void> {
    if (pending.current || !view || view.blockedReason || !view.actions.includes(action)) return;
    pending.current = true;
    setBusy(true); setMessage(''); setError('');
    try {
      if (action === 'clear' && !await confirm({ title: t('sessions.goal.clear'), message: t('sessions.goal.clearConfirm'), danger: true })) return;
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', ...controlCsrfHeaders() },
        body: JSON.stringify({ action, ...(action === 'start' ? { objective } : {}) }),
      });
      const body = await response.json();
      if (!response.ok || body.accepted !== true) setError(reason(body.error ?? 'goal_control_unavailable'));
      else setMessage(t('sessions.goal.accepted'));
    } catch { setError(t('sessions.goal.failed')); }
    finally { pending.current = false; setBusy(false); }
  }
  const disabled = busy || !view || !!view.blockedReason;
  return (
    <section className="session-goal-panel" aria-labelledby={`${id}-title`} data-session-goal="">
      <h4 id={`${id}-title`}>{t('sessions.goal.title')}</h4>
      <p className="session-goal-help">{t('sessions.goal.help')}</p>
      {view?.blockedReason ? <p role="status">{reason(view.blockedReason)}</p> : null}
      {!view && !error ? <p role="status">{t('sessions.goal.loading')}</p> : null}
      <form onSubmit={event => { event.preventDefault(); void act('start'); }}>
        <label htmlFor={`${id}-objective`}>{t('sessions.goal.objective')}</label>
        <textarea id={`${id}-objective`} rows={3} maxLength={16_000} value={objective}
          placeholder={t('sessions.goal.placeholder')} disabled={disabled}
          onChange={event => setObjective(event.target.value)} />
        <div className="session-goal-actions">
          <button type="submit" className="primary" disabled={disabled || !objective.trim() || !view?.actions.includes('start')}
            data-goal-action="start">{t('sessions.goal.start')}</button>
          {view?.actions.filter(action => action !== 'start').map(action => (
            <button type="button" key={action} disabled={disabled} data-goal-action={action}
              onClick={() => void act(action)}>{t(`sessions.goal.${action}`)}</button>
          ))}
        </div>
      </form>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {props.terminalUrl ? <a href={props.terminalUrl} target="_blank" rel="noopener noreferrer">{t('sessions.goal.openTerminal')}</a> : null}
    </section>
  );
}
