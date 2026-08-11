import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  attentionSummary,
  computeVirtualWindow,
  flattenWorkbenchGroups,
  formatWorkbenchRelativeTime,
  groupWorkbenchSessions,
  sessionActivityAt,
  workbenchListItemHeight,
  workbenchSessionTitle,
  type WorkbenchListItem,
  type WorkbenchSessionGroup,
  type WorkbenchSessionRow,
} from './agent-workbench-model.js';

const GROUP_COPY: Record<WorkbenchSessionGroup, { label: string; icon: string }> = {
  'needs-you': { label: 'NEEDS YOU', icon: '!' },
  active: { label: 'ACTIVE', icon: '●' },
  recent: { label: 'RECENT', icon: '↺' },
};

export interface WorkbenchSessionListProps {
  sessions: readonly WorkbenchSessionRow[];
  selectedSessionId: string | null;
  collapsed?: boolean;
  locale?: string;
  now?: number;
  onSelect(sessionId: string): void;
  onToggleCollapsed?(): void;
}

function useViewportHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(560);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => setHeight(Math.max(120, node.clientHeight || 560));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

function sessionOptionId(sessionId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `wb-session-${(hash >>> 0).toString(36)}`;
}

function sessionSecondary(session: WorkbenchSessionRow): string {
  return [session.botName, session.cliId, session.repoName].filter(Boolean).join(' · ') || session.sessionId;
}

function groupCount(items: readonly WorkbenchListItem[], group: WorkbenchSessionGroup): number {
  return items.filter(item => item.kind === 'session' && item.group === group).length;
}

export function WorkbenchSessionList(props: WorkbenchSessionListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const viewportHeight = useViewportHeight(scrollerRef);
  const groups = useMemo(() => groupWorkbenchSessions(props.sessions, query), [props.sessions, query]);
  const items = useMemo(() => flattenWorkbenchGroups(groups), [groups]);
  const visible = useMemo(
    () => computeVirtualWindow(items, scrollTop, viewportHeight),
    [items, scrollTop, viewportHeight],
  );
  const sessionItems = useMemo(
    () => items.filter((item): item is Extract<WorkbenchListItem, { kind: 'session' }> => item.kind === 'session'),
    [items],
  );

  useEffect(() => {
    if (!props.selectedSessionId || !sessionItems.some(item => item.session.sessionId === props.selectedSessionId)) return;
    const index = items.findIndex(item => item.kind === 'session' && item.session.sessionId === props.selectedSessionId);
    const top = visible.positions[index] ?? 0;
    const bottom = top + workbenchListItemHeight(items[index]);
    const node = scrollerRef.current;
    if (!node || (top >= node.scrollTop && bottom <= node.scrollTop + node.clientHeight)) return;
    node.scrollTop = Math.max(0, top - Math.round(node.clientHeight / 3));
  }, [items, props.selectedSessionId, sessionItems, visible.positions]);

  const moveSelection = (delta: -1 | 1) => {
    if (sessionItems.length === 0) return;
    const current = sessionItems.findIndex(item => item.session.sessionId === props.selectedSessionId);
    const next = current < 0
      ? (delta > 0 ? 0 : sessionItems.length - 1)
      : Math.max(0, Math.min(sessionItems.length - 1, current + delta));
    props.onSelect(sessionItems[next].session.sessionId);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Enter' && props.selectedSessionId) {
      event.preventDefault();
      props.onSelect(props.selectedSessionId);
    }
  };

  if (props.collapsed) {
    const collapsedLabel = (
      <>
        <span aria-hidden="true">»</span>
        <span className="wb-rail-vertical-label">SESSIONS</span>
      </>
    );
    return (
      <aside className="wb-session-rail is-collapsed" aria-label="Session rail, collapsed">
        {props.onToggleCollapsed ? (
          <button
            type="button"
            className="wb-rail-expand"
            aria-label="Expand session rail"
            title="Expand session rail"
            onClick={props.onToggleCollapsed}
          >{collapsedLabel}</button>
        ) : <div className="wb-rail-expand" aria-label="Session rail collapsed for this viewport">{collapsedLabel}</div>}
        <span className="wb-rail-count" aria-label={`${groupCount(items, 'needs-you')} sessions need you`}>
          {groupCount(items, 'needs-you')}
        </span>
      </aside>
    );
  }

  return (
    <aside className="wb-session-rail" aria-label="Sessions">
      <div className="wb-rail-heading">
        <div>
          <strong>SESSIONS</strong>
          <span>{props.sessions.length}</span>
        </div>
        {props.onToggleCollapsed ? (
          <button type="button" aria-label="Collapse session rail" title="Collapse session rail" onClick={props.onToggleCollapsed}>«</button>
        ) : null}
      </div>
      <label className="wb-session-search">
        <span className="wb-visually-hidden">Search sessions</span>
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          placeholder="Search title, bot, repo…"
          value={query}
          onChange={event => changeQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              scrollerRef.current?.focus();
              moveSelection(1);
            }
          }}
        />
        {query ? <button type="button" aria-label="Clear search" onClick={() => changeQuery('')}>×</button> : null}
      </label>
      <div className="wb-rail-key-hint" aria-hidden="true"><kbd>j</kbd><kbd>k</kbd> move <kbd>↵</kbd> open</div>
      <div
        ref={scrollerRef}
        className="wb-session-list"
        role="listbox"
        tabIndex={0}
        aria-label="Workbench sessions"
        aria-activedescendant={props.selectedSessionId ? sessionOptionId(props.selectedSessionId) : undefined}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onListKeyDown}
      >
        <div className="wb-session-list-space" style={{ height: visible.totalHeight }}>
          {items.slice(visible.start, visible.end).map((item, sliceIndex) => {
            const index = visible.start + sliceIndex;
            const style = { top: visible.positions[index], height: workbenchListItemHeight(item) };
            if (item.kind === 'header') {
              const copy = GROUP_COPY[item.group];
              return (
                <div key={item.key} className={`wb-session-group wb-session-group-${item.group}`} style={style} role="presentation">
                  <span aria-hidden="true">{copy.icon}</span>
                  <strong>{copy.label}</strong>
                  <span>{item.count}</span>
                </div>
              );
            }
            const session = item.session;
            const title = workbenchSessionTitle(session);
            const reason = attentionSummary(session);
            const selected = session.sessionId === props.selectedSessionId;
            const statusText = item.group === 'needs-you' ? 'Needs you' : item.group === 'active' ? session.status : 'Recent';
            return (
              <button
                key={item.key}
                id={sessionOptionId(session.sessionId)}
                type="button"
                className={`wb-session-row wb-session-row-${item.group}${selected ? ' is-selected' : ''}`}
                role="option"
                aria-selected={selected}
                aria-label={`${title}. ${statusText}${reason ? `. ${reason}` : ''}`}
                style={style}
                onClick={() => props.onSelect(session.sessionId)}
              >
                <span className="wb-session-state-mark" aria-hidden="true">{GROUP_COPY[item.group].icon}</span>
                <span className="wb-session-copy">
                  <span className="wb-session-title" title={title}>{title}</span>
                  <span className="wb-session-meta" title={sessionSecondary(session)}>
                    {reason ? <span className="wb-session-reason">{reason}</span> : <span>{sessionSecondary(session)}</span>}
                    <time dateTime={new Date(sessionActivityAt(session)).toISOString()}>
                      {formatWorkbenchRelativeTime(sessionActivityAt(session), props.now, props.locale)}
                    </time>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {sessionItems.length === 0 ? <p className="wb-session-empty">No matching sessions</p> : null}
      </div>
    </aside>
  );
}
