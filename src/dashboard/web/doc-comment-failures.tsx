import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from './react-hooks.js';
import { ui } from './ui.js';
import { docWatchUrl, failedDocWatches, loadDocWatchResults, outcomeMeta, relTime, type DocWatchBotResult } from './doc-watches.js';

/** Show admission failures alongside sessions without counting them as sessions. */
export function DocCommentFailures() {
  const tr = useT();
  const authed = useSyncExternalStore(listener => ui.on(listener), () => ui.authed, () => false);
  const [results, setResults] = useState<DocWatchBotResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authed) return;
    let disposed = false;
    let loading = false;
    const reload = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await loadDocWatchResults();
        if (!disposed) { setResults(next); setError(null); }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally { loading = false; }
    };
    void reload();
    const timer = window.setInterval(() => { void reload(); }, 60_000);
    window.addEventListener('focus', reload);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [authed]);

  if (!authed) return null;
  const failures = failedDocWatches(results);
  const unavailable = results.filter(result => result.error).length;
  if (!failures.length && !error && !unavailable) return null;
  return (
    <details className="doc-comment-failures">
      <summary>{failures.length ? tr('docFailures.title', { count: failures.length }) : tr('docFailures.unavailable')}</summary>
      <p>{tr('docFailures.hint')} <a href="#/doc-watches">{tr('nav.docWatches')}</a></p>
      {error || unavailable ? <p role="status">{tr('docFailures.unavailable')} {error}</p> : null}
      <ul>
        {failures.map(row => {
          const href = docWatchUrl(row);
          const title = row.docTitle?.trim() || row.fileToken;
          return (
            <li key={`${row.larkAppId}:${row.fileToken}`}>
              <b>{row.botName}</b>{' · '}
              {href ? <a href={href} target="_blank" rel="noreferrer">{title}</a> : title}
              {' · '}{outcomeMeta(row.lastOutcome).label}{' · '}{relTime(row.lastActivityAt)}
              <p>{row.lastError || outcomeMeta(row.lastOutcome).hint}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
