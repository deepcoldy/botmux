import { useEffect, useRef } from 'react';
import { IDLE_CLEANUP_HOUR_OPTIONS } from '../session-cleanup.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { renderCliFilterGroup, SESSION_STATUS_OPTIONS, sessionStatusText, wireSessionsPage } from './sessions.js';
import { useT } from './react-hooks.js';

function SortHeader(props: { sort: string; label: string }) {
  return <th data-sort={props.sort} data-label={props.label}>{props.label}</th>;
}

// Render-once scaffold: after mount, wireSessionsPage owns this subtree with
// delegated events and innerHTML updates. Do not add useState/useStoreSelector
// here until the corresponding controller sections are migrated to React; the
// route intentionally full-remounts on ui changes so first-frame translations
// refresh without a partial React render fighting the imperative controller.
function SessionsPage() {
  const tr = useT();
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return undefined;
    return wireSessionsPage(hostRef.current);
  }, []);

  return (
    <section className="page" ref={hostRef}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.sessions')}</p>
          <h1>{tr('sessions.title')}</h1>
          <p>{tr('sessions.subtitle')}</p>
        </div>
        <div className="sessions-view-controls">
          <button type="button" id="create-session-btn" className="primary create-session-btn">
            {'+ '}{tr('sessions.create.button')}
          </button>
          <span id="kanban-team-stats" className="kanban-team-stats" hidden />
          <select id="kanban-team" className="kanban-team-select" aria-label={tr('sessions.kanban.groupTeam')} hidden />
          <div className="segmented kanban-groupby" id="kanban-groupby" role="group" aria-label={tr('sessions.kanban.groupBy')} hidden>
            <button type="button" data-groupby="flow">{tr('sessions.kanban.groupFlow')}</button>
            <button type="button" data-groupby="team">{tr('sessions.kanban.groupTeam')}</button>
            <button type="button" data-groupby="bot">{tr('sessions.kanban.groupBot')}</button>
          </div>
          <div className="segmented sessions-view-toggle" role="group" aria-label={tr('sessions.viewMode')}>
            <button type="button" data-view="kanban">{tr('sessions.viewKanban')}</button>
            <button type="button" data-view="board">{tr('sessions.viewBoard')}</button>
            <button type="button" data-view="table">{tr('sessions.viewTable')}</button>
          </div>
        </div>
      </div>
      <form id="filters" className="filters sessions-filters">
        <input type="search" name="q" placeholder={tr('sessions.search')} />
        <select name="status">
          <option value="">{tr('sessions.anyStatus')}</option>
          {SESSION_STATUS_OPTIONS.map(status => (
            <option key={status} value={status}>{sessionStatusText(status)}</option>
          ))}
        </select>
        <select name="adopt">
          <option value="">{tr('sessions.adoptAny')}</option>
          <option value="yes">{tr('sessions.adoptYes')}</option>
          <option value="no">{tr('sessions.adoptNo')}</option>
        </select>
        <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: renderCliFilterGroup() }} />
        <label className="filter-toggle">
          <input type="checkbox" name="active" defaultChecked /> <span>{tr('sessions.activeOnly')}</span>
        </label>
      </form>
      <div id="idle-cleanup-bar" className="idle-cleanup-bar">
        <div className="idle-cleanup-summary">
          <span className="idle-cleanup-dot" aria-hidden="true" />
          <span id="idle-cleanup-count" className="idle-cleanup-count" />
        </div>
        <div className="idle-cleanup-controls">
          <span className="idle-cleanup-label">{tr('sessions.idleCleanupOlderThan')}</span>
          <div id="idle-cleanup-threshold" className="idle-cleanup-thresholds" role="group" aria-label={tr('sessions.idleCleanupThreshold')}>
            {IDLE_CLEANUP_HOUR_OPTIONS.map(hours => (
              <button type="button" key={hours} data-hours={hours} aria-pressed={hours === 24 ? 'true' : 'false'}>
                {hours === 168 ? '7d' : `${hours}H`}
              </button>
            ))}
          </div>
          <button type="button" id="idle-cleanup-run" className="contrast idle-cleanup-run">{tr('sessions.idleCleanupRun')}</button>
        </div>
        <span id="idle-cleanup-status" className="idle-cleanup-status" aria-live="polite" />
      </div>
      <div id="bulk-bar" className="bulk-bar" hidden>
        <span id="bulk-count" />
        <button type="button" id="bulk-lock">{tr('sessions.lockSelected')}</button>
        <button type="button" id="bulk-unlock">{tr('sessions.unlockSelected')}</button>
        <button type="button" id="bulk-close" className="contrast">{tr('sessions.closeSelected')}</button>
        <button type="button" id="bulk-clear">{tr('sessions.clearSelection')}</button>
      </div>
      <table id="sessions-table">
        <thead>
          <tr>
            <th><input type="checkbox" id="select-all" title={tr('sessions.activeOnly')} /></th>
            <SortHeader sort="botName" label={tr('sessions.bot')} />
            <SortHeader sort="cliId" label={tr('sessions.cli')} />
            <SortHeader sort="status" label={tr('sessions.status')} />
            <SortHeader sort="tokenIn" label={tr('sessions.tokenIn')} />
            <SortHeader sort="tokenOut" label={tr('sessions.tokenOut')} />
            <SortHeader sort="title" label={tr('sessions.titleCol')} />
            <SortHeader sort="workingDir" label={tr('sessions.workingDir')} />
            <SortHeader sort="spawnedAt" label={tr('sessions.created')} />
            <SortHeader sort="lastMessageAt" label={tr('sessions.last')} />
            <SortHeader sort="adopt" label={tr('sessions.adopt')} />
            <th>{tr('sessions.actions')}</th>
          </tr>
        </thead>
        <tbody />
      </table>
      <div id="sessions-board" className="sessions-board" hidden />
      <div id="sessions-kanban" className="sessions-kanban" hidden />
      <dialog id="drawer" />
      <dialog id="term-modal" className="term-modal" />
      <dialog id="history-modal" className="history-modal" />
      <dialog id="create-session-modal" className="create-session-modal" />
    </section>
  );
}

export function renderSessionsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SessionsPage />);
}
