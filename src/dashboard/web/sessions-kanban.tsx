import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { LoadingState } from './dashboard-components.js';
import type { KanbanGroupBy } from './preferences.js';
import {
  computeDropPosition,
  deriveKanbanColumn,
  effectiveKanbanPosition,
  type SessionKanbanColumn,
} from './kanban-model.js';
import {
  botAvatarHtml,
  botDisplayName,
  chatAvatarHtml,
  chatDisplayTitle,
  escapeHtml,
  relTime,
  stripMentionPrefix,
  t,
} from './ui.js';

export interface SessionsKanbanTeam {
  key: string;
  label: string;
  botIds: Set<string>;
  botNames: Set<string>;
  groupChats: Set<string>;
}

export interface SessionsKanbanTeamBoardData {
  board: Record<string, { column: string; position: number }>;
  remoteRows: any[];
}

export interface SessionsKanbanIcons {
  details: string;
  feishu: string;
  history: string;
  lock: string;
  restart: string;
  unlock: string;
}

export interface SessionsKanbanMove {
  row: any;
  column: SessionKanbanColumn;
  position: number;
}

export interface SessionsKanbanState {
  rows: any[];
  groupBy: KanbanGroupBy;
  teams: SessionsKanbanTeam[];
  teamsLoaded: boolean;
  teamKey: string;
  teamBoardData: SessionsKanbanTeamBoardData | null;
  teamBoardKey: string;
}

export interface SessionsKanbanCallbacks {
  canRestartSession: (row: any) => boolean;
  getTeamChatIds: (team: SessionsKanbanTeam | undefined) => Set<string>;
  icons: SessionsKanbanIcons;
  lockActionLabel: (row: any) => string;
  sessionStatusText: (status: unknown) => string;
  onDetails: (row: any) => void;
  onHistory: (row: any) => void;
  onMoveRows: (moves: SessionsKanbanMove[]) => void;
  onNeedTeamBoard: (team: SessionsKanbanTeam) => void;
  onNeedTeams: () => void;
  onOpenTerminal: (row: any) => void;
  onRename: (row: any, title: string) => void;
  onRestart: (row: any, button: HTMLButtonElement) => void;
  onTeamScope: (scope: { chats: number; sessions: number } | null) => void;
  onToggleLock: (row: any, button: HTMLButtonElement) => void;
}

export type SessionsKanbanProps = SessionsKanbanState & SessionsKanbanCallbacks & {
  host: HTMLElement | null;
};

type ClusterItem =
  | { type: 'card'; row: any }
  | { type: 'cluster'; chatId: string; rows: any[] };

type FlowColumnModel = {
  id: SessionKanbanColumn;
  labelKey: string;
  rows: any[];
  clusters: ClusterItem[];
  hiddenCount: number;
};

type BotColumnModel = {
  key: string;
  name: string;
  larkAppId: string;
  rows: any[];
  clusters: ClusterItem[];
};

type RenderModel =
  | { mode: 'loading'; groups: Map<SessionKanbanColumn, any[]>; rowById: Map<string, any>; team: null; scope: null }
  | { mode: 'flow'; columns: FlowColumnModel[]; groups: Map<SessionKanbanColumn, any[]>; rowById: Map<string, any>; team: SessionsKanbanTeam | null; scope: { chats: number; sessions: number } | null }
  | { mode: 'bot'; columns: BotColumnModel[]; groups: Map<SessionKanbanColumn, any[]>; rowById: Map<string, any>; team: null; scope: null };

const KANBAN_COLUMNS: Array<{ id: SessionKanbanColumn; labelKey: string }> = [
  { id: 'backlog', labelKey: 'sessions.kanban.backlog' },
  { id: 'todo', labelKey: 'sessions.kanban.todo' },
  { id: 'in_progress', labelKey: 'sessions.kanban.inProgress' },
  { id: 'in_review', labelKey: 'sessions.kanban.inReview' },
  { id: 'done', labelKey: 'sessions.kanban.done' },
];

export const KANBAN_DONE_CAP = 50;

function cssToken(value: unknown): string {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function repoBasename(workingDir: unknown): string {
  const value = String(workingDir ?? '').trim();
  if (!value) return '-';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}

function boardSignalLabel(s: any): string {
  if (s.agentAttention?.reason) return s.agentAttention.reason;
  if (s.agentAttention) return t('sessions.board.signalAgent');
  if (s.pendingRepo) return t('sessions.board.signalRepo');
  if (s.tuiPromptActive) return t('sessions.board.signalPrompt');
  if (s.status === 'limited') return t('sessions.board.signalLimited');
  return '';
}

function kanbanStatusIcon(id: SessionKanbanColumn): string {
  const ring = (extra = '') =>
    `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"${extra}/>`;
  switch (id) {
    case 'backlog':
      return `${ring(' stroke-dasharray="1.6 2.1"')}</svg>`;
    case 'in_progress':
      return `${ring()}<path d="M7,7 L7,3.6 A3.4,3.4 0 0 1 7,10.4 Z" fill="currentColor"/></svg>`;
    case 'in_review':
      return `${ring()}<path d="M7,7 L7,3.6 A3.4,3.4 0 1 1 3.6,7 Z" fill="currentColor"/></svg>`;
    case 'done':
      return '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.2" fill="currentColor"/><path d="M4.4 7.2 6.2 9 9.7 5.4" fill="none" stroke="var(--surface)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'todo':
    default:
      return `${ring()}</svg>`;
  }
}

function rawHtml(html: string): { __html: string } {
  return { __html: html };
}

function isRemoteRow(row: any): boolean {
  return typeof row.remoteDeployment === 'string' && row.remoteDeployment.length > 0;
}

function rowTitle(row: any): string {
  return stripMentionPrefix(row.title) || row.sessionId;
}

function clusterRows(columnRows: any[]): { clusters: ClusterItem[]; flat: any[] } {
  const order: Array<{ chatId: string; rows: any[] }> = [];
  const byChat = new Map<string, { chatId: string; rows: any[] }>();
  for (const row of columnRows) {
    const key = String(row.chatId ?? row.sessionId);
    let group = byChat.get(key);
    if (!group) {
      group = { chatId: key, rows: [] };
      byChat.set(key, group);
      order.push(group);
    }
    group.rows.push(row);
  }
  const flat: any[] = [];
  const clusters = order.map<ClusterItem>(group => {
    flat.push(...group.rows);
    if (group.rows.length < 2) return { type: 'card', row: group.rows[0] };
    return { type: 'cluster', chatId: group.chatId, rows: group.rows };
  });
  return { clusters, flat };
}

function buildFlowColumns(rows: any[]): { columns: FlowColumnModel[]; groups: Map<SessionKanbanColumn, any[]> } {
  const groups = new Map<SessionKanbanColumn, any[]>(KANBAN_COLUMNS.map(column => [column.id, []]));
  for (const row of rows) groups.get(deriveKanbanColumn(row))!.push(row);
  const columns = KANBAN_COLUMNS.map(column => {
    let columnRows = (groups.get(column.id) ?? [])
      .sort((a, b) => effectiveKanbanPosition(a) - effectiveKanbanPosition(b));
    let hiddenCount = 0;
    if (column.id === 'done' && columnRows.length > KANBAN_DONE_CAP) {
      hiddenCount = columnRows.length - KANBAN_DONE_CAP;
      columnRows = columnRows.slice(0, KANBAN_DONE_CAP);
    }
    const { clusters, flat } = clusterRows(columnRows);
    groups.set(column.id, flat);
    return { id: column.id, labelKey: column.labelKey, rows: columnRows, clusters, hiddenCount };
  });
  return { columns, groups };
}

function buildBotColumns(rows: any[]): BotColumnModel[] {
  const bots = new Map<string, { name: string; larkAppId: string; rows: any[] }>();
  for (const row of rows) {
    if (row.status === 'closed') continue;
    const key = String(row.larkAppId || row.botName || 'unknown');
    let bot = bots.get(key);
    if (!bot) {
      bot = { name: botDisplayName(row), larkAppId: row.larkAppId, rows: [] };
      bots.set(key, bot);
    }
    bot.rows.push(row);
  }
  return [...bots.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(bot => {
      const rowsSorted = bot.rows.sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0));
      const { clusters } = clusterRows(rowsSorted);
      return { key: String(bot.larkAppId ?? bot.name), name: bot.name, larkAppId: bot.larkAppId, rows: rowsSorted, clusters };
    });
}

function mapRowsById(rows: any[]): Map<string, any> {
  return new Map(rows.map(row => [String(row.sessionId), row]));
}

function buildRenderModel(props: SessionsKanbanState & Pick<SessionsKanbanCallbacks, 'getTeamChatIds'>): RenderModel {
  if (props.groupBy === 'bot') {
    const rows = props.rows.filter(row => !isRemoteRow(row));
    return {
      mode: 'bot',
      columns: buildBotColumns(rows),
      groups: new Map(),
      rowById: mapRowsById(rows),
      team: null,
      scope: null,
    };
  }
  if (props.groupBy === 'team') {
    if (!props.teamsLoaded) {
      return { mode: 'loading', groups: new Map(), rowById: new Map(), team: null, scope: null };
    }
    const team = props.teams.find(tm => tm.key === props.teamKey) ?? props.teams[0] ?? null;
    const teamChats = props.getTeamChatIds(team ?? undefined);
    const teamRows = team ? props.rows.filter(row => teamChats.has(String(row.chatId))) : [];
    const board = (props.teamBoardKey === team?.key ? props.teamBoardData?.board : null) ?? {};
    const remoteRows = (props.teamBoardKey === team?.key ? props.teamBoardData?.remoteRows : null) ?? [];
    const merged = [...teamRows, ...remoteRows].map(row => {
      const entry = board[String(row.sessionId)];
      return entry ? { ...row, kanbanColumn: entry.column, kanbanPosition: entry.position } : row;
    });
    const { columns, groups } = buildFlowColumns(merged);
    return {
      mode: 'flow',
      columns,
      groups,
      rowById: mapRowsById(merged),
      team,
      scope: { chats: teamChats.size, sessions: merged.length },
    };
  }
  const { columns, groups } = buildFlowColumns(props.rows);
  return {
    mode: 'flow',
    columns,
    groups,
    rowById: mapRowsById(props.rows),
    team: null,
    scope: null,
  };
}

function snapshotScrollTops(host: HTMLElement | null): Map<string, number> {
  const out = new Map<string, number>();
  host?.querySelectorAll<HTMLElement>('.kanban-col-list').forEach(el => {
    const col = el.closest<HTMLElement>('.kanban-column')?.dataset.col;
    if (col && el.scrollTop) out.set(col, el.scrollTop);
  });
  return out;
}

function restoreScrollTops(host: HTMLElement | null, scrollTops: Map<string, number> | null): void {
  if (!scrollTops?.size) return;
  host?.querySelectorAll<HTMLElement>('.kanban-col-list').forEach(el => {
    const col = el.closest<HTMLElement>('.kanban-column')?.dataset.col;
    const top = col ? scrollTops.get(col) : undefined;
    if (top) el.scrollTop = top;
  });
}

function insertBeforeCard(column: HTMLElement, clientY: number): HTMLElement | null {
  for (const card of column.querySelectorAll<HTMLElement>('.kanban-card:not(.dragging)')) {
    if (card.closest('.kanban-cluster.dragging')) continue;
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return card;
  }
  return null;
}

function CardActButton(props: {
  action: string;
  className?: string;
  icon: string;
  label: string;
  onClick: (button: HTMLButtonElement) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`card-act kanban-card-act${props.className ? ` ${props.className}` : ''}`}
      data-action={props.action}
      title={props.label}
      aria-label={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick(event.currentTarget);
      }}
      dangerouslySetInnerHTML={rawHtml(props.icon)}
    />
  );
}

function RenameInput(props: {
  row: any;
  onCancel: () => void;
  onCommit: (row: any, title: string) => void;
}): JSX.Element {
  const initial = stripMentionPrefix(props.row.title) || '';
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = useCallback((commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) {
      props.onCommit(props.row, next);
    }
    props.onCancel();
  }, [initial, props, value]);

  return (
    <input
      ref={inputRef}
      type="text"
      className="kanban-rename-input"
      maxLength={200}
      value={value}
      onChange={event => setValue(event.currentTarget.value)}
      onClick={event => event.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

function KanbanCard(props: {
  row: any;
  dragId: string | null;
  dropBeforeId: string | null;
  editingId: string | null;
  groupBy: KanbanGroupBy;
  callbacks: SessionsKanbanCallbacks;
  cancelOpen: () => void;
  onBeginEdit: (row: any) => void;
  onCardClick: (row: any, event: MouseEvent<HTMLElement>) => void;
  onCardKeyDown: (row: any, event: KeyboardEvent<HTMLElement>) => void;
  onDragStartCard: (row: any, event: DragEvent<HTMLElement>) => void;
  onEditDone: () => void;
}): JSX.Element {
  const { callbacks, row } = props;
  const title = rowTitle(row);
  const botName = botDisplayName(row);
  const chatTitle = chatDisplayTitle(row);
  const repo = repoBasename(row.workingDir);
  const signal = boardSignalLabel(row);
  const desc = [chatTitle, repo !== '-' ? repo : null].filter(Boolean).join(' · ');
  const status = String(row.status ?? 'unknown');
  const remote = typeof row.remoteDeployment === 'string' ? row.remoteDeployment : '';
  const isEditing = props.editingId === row.sessionId;
  const className = [
    'kanban-card',
    remote ? 'kanban-card-remote' : '',
    row.locked ? 'locked' : '',
    props.dragId === row.sessionId ? 'dragging' : '',
    props.dropBeforeId === row.sessionId ? 'drop-before' : '',
  ].filter(Boolean).join(' ');
  const actionRail = remote ? null : (
    <span className="kanban-card-actions-rail">
      <CardActButton
        action="history"
        icon={callbacks.icons.history}
        label={t('sessions.history.title')}
        onClick={() => callbacks.onHistory(row)}
      />
      {row.feishuChatLink ? (
        <a
          className="card-act kanban-card-act"
          href={row.feishuChatLink}
          target="_blank"
          rel="noopener"
          title={t('sessions.kanban.openFeishu')}
          aria-label={t('sessions.kanban.openFeishu')}
          onClick={event => event.stopPropagation()}
          dangerouslySetInnerHTML={rawHtml(callbacks.icons.feishu)}
        />
      ) : null}
      <CardActButton
        action="lock"
        className={row.locked ? 'locked' : ''}
        icon={row.locked ? callbacks.icons.unlock : callbacks.icons.lock}
        label={callbacks.lockActionLabel(row)}
        onClick={button => callbacks.onToggleLock(row, button)}
      />
      <CardActButton
        action="details"
        icon={callbacks.icons.details}
        label={t('sessions.details')}
        onClick={() => callbacks.onDetails(row)}
      />
      {callbacks.canRestartSession(row) ? (
        <CardActButton
          action="restart"
          icon={callbacks.icons.restart}
          label={t('sessions.restart')}
          onClick={button => callbacks.onRestart(row, button)}
        />
      ) : null}
    </span>
  );

  return (
    <article
      className={className}
      data-id={row.sessionId}
      tabIndex={0}
      role="button"
      draggable
      onClick={event => props.onCardClick(row, event)}
      onKeyDown={event => props.onCardKeyDown(row, event)}
      onDragStart={event => props.onDragStartCard(row, event)}
    >
      <div className="kanban-card-top">
        <span className={`badge cli-${cssToken(row.cliId)}`}>{row.cliId ?? 'unknown'}</span>
        {row.adopt ? <span className="badge">adopt</span> : null}
        {row.locked ? <span className="session-lock-badge" title={t('sessions.locked')}>{t('sessions.locked')}</span> : null}
        {remote ? (
          <span className="badge kanban-remote-badge" title={t('sessions.kanban.remoteHint', { name: remote })}>
            {remote}
          </span>
        ) : null}
        {actionRail}
      </div>
      <div className="kanban-card-title-row">
        {isEditing ? (
          <RenameInput row={row} onCancel={props.onEditDone} onCommit={callbacks.onRename} />
        ) : (
          <p
            className="kanban-card-title"
            title={String(row.title ?? title)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              props.cancelOpen();
              if (!remote) props.onBeginEdit(row);
            }}
          >
            {String(title).slice(0, 140)}
          </p>
        )}
      </div>
      {desc || signal ? (
        <div className="kanban-card-meta-row">
          {desc ? (
            <p className="kanban-card-desc" title={desc}>{desc}</p>
          ) : (
            <span className="kanban-card-desc kanban-card-desc-empty" aria-hidden="true" />
          )}
          {signal ? <span className="session-signal" title={signal}>{signal}</span> : null}
        </div>
      ) : null}
      <div className="kanban-card-foot">
        <span
          className="kanban-card-owner"
          dangerouslySetInnerHTML={rawHtml(
            `${botAvatarHtml({ name: botName, larkAppId: row.larkAppId, size: 'sm' })}<span>${escapeHtml(botName)}</span>`,
          )}
        />
        <span className="kanban-card-updated">
          {t('sessions.kanban.updated', { time: relTime(row.lastMessageAt) })}
          <span
            className="kanban-card-dot"
            data-status={cssToken(status)}
            title={callbacks.sessionStatusText(status)}
          />
        </span>
      </div>
    </article>
  );
}

function ClusterView(props: {
  item: ClusterItem;
  columnId?: SessionKanbanColumn;
  dragCluster: { chatId: string; col: SessionKanbanColumn } | null;
  cardProps: Omit<Parameters<typeof KanbanCard>[0], 'row'>;
  onDragStartCluster: (chatId: string, col: SessionKanbanColumn, event: DragEvent<HTMLElement>) => void;
}): JSX.Element {
  const item = props.item;
  if (item.type === 'card') return <KanbanCard {...props.cardProps} row={item.row} />;
  const title = chatDisplayTitle(item.rows[0]) ?? item.chatId;
  const dragging = props.dragCluster?.chatId === item.chatId && props.dragCluster.col === props.columnId;
  return (
    <div className={`kanban-cluster${dragging ? ' dragging' : ''}`} data-chat={item.chatId}>
      <header
        draggable
        title={`${title} · ${t('sessions.kanban.clusterDragHint')}`}
        onDragStart={event => {
          if (props.columnId) props.onDragStartCluster(item.chatId, props.columnId, event);
        }}
        dangerouslySetInnerHTML={rawHtml(
          `${chatAvatarHtml({ chatId: item.chatId, name: title, size: 'sm' })}`
          + `<span class="kanban-cluster-name">${escapeHtml(title)}</span>`
          + `<span class="kanban-cluster-count">${item.rows.length}</span>`,
        )}
      />
      {item.rows.map(row => <KanbanCard key={row.sessionId} {...props.cardProps} row={row} />)}
    </div>
  );
}

export function SessionsKanbanView(props: SessionsKanbanProps): JSX.Element {
  const [display, setDisplay] = useState<SessionsKanbanProps>(props);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: 'card'; id: string } | { kind: 'cluster'; chatId: string; col: SessionKanbanColumn } | null>(null);
  const [dragOverCol, setDragOverCol] = useState<SessionKanbanColumn | string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const pendingPropsRef = useRef<SessionsKanbanProps | null>(null);
  const pendingScrollRef = useRef<Map<string, number> | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupsRef = useRef<Map<SessionKanbanColumn, any[]>>(new Map());
  const rowByIdRef = useRef<Map<string, any>>(new Map());
  const dragRef = useRef<typeof drag>(drag);
  const frozen = !!editingId || !!drag;

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const applyDisplay = useCallback((next: SessionsKanbanProps) => {
    pendingScrollRef.current = snapshotScrollTops(props.host);
    setDisplay(next);
  }, [props.host]);

  useEffect(() => {
    if (frozen) {
      pendingPropsRef.current = props;
      return;
    }
    applyDisplay(props);
  }, [applyDisplay, frozen, props]);

  useEffect(() => {
    if (frozen || !pendingPropsRef.current) return;
    const next = pendingPropsRef.current;
    pendingPropsRef.current = null;
    applyDisplay(next);
  }, [applyDisplay, frozen]);

  useLayoutEffect(() => {
    restoreScrollTops(props.host, pendingScrollRef.current);
    pendingScrollRef.current = null;
  }, [display, props.host]);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  useEffect(() => () => cancelOpen(), [cancelOpen]);

  const model = useMemo(() => buildRenderModel(display), [display]);

  useLayoutEffect(() => {
    groupsRef.current = model.groups;
    rowByIdRef.current = model.rowById;
  }, [model]);

  useEffect(() => {
    if (display.groupBy === 'team' && !display.teamsLoaded) display.onNeedTeams();
  }, [display]);

  useEffect(() => {
    if (display.groupBy === 'team' && model.mode === 'flow' && model.team) {
      display.onNeedTeamBoard(model.team);
    }
  }, [display, model]);

  useEffect(() => {
    display.onTeamScope(model.mode === 'flow' ? model.scope : null);
  }, [display, model]);

  const clearDrag = useCallback(() => {
    setDrag(null);
    setDragOverCol(null);
    setDropBeforeId(null);
  }, []);

  const onBeginEdit = useCallback((row: any) => {
    cancelOpen();
    if (isRemoteRow(row)) return;
    setEditingId(row.sessionId);
  }, [cancelOpen]);

  const onCardClick = useCallback((row: any, event: MouseEvent<HTMLElement>) => {
    if (isRemoteRow(row)) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, label')) return;
    cancelOpen();
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      display.onOpenTerminal(row);
    }, 220);
  }, [cancelOpen, display]);

  const onCardKeyDown = useCallback((row: any, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget || isRemoteRow(row)) return;
    event.preventDefault();
    display.onOpenTerminal(row);
  }, [display]);

  const onDragStartCard = useCallback((row: any, event: DragEvent<HTMLElement>) => {
    if (display.groupBy === 'bot') return;
    cancelOpen();
    setDrag({ kind: 'card', id: String(row.sessionId) });
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(row.sessionId));
    }
  }, [cancelOpen, display.groupBy]);

  const onDragStartCluster = useCallback((chatId: string, col: SessionKanbanColumn, event: DragEvent<HTMLElement>) => {
    if (display.groupBy === 'bot') return;
    cancelOpen();
    setDrag({ kind: 'cluster', chatId, col });
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `cluster:${chatId}`);
    }
  }, [cancelOpen, display.groupBy]);

  const onColumnDragOver = useCallback((columnId: SessionKanbanColumn | string, event: DragEvent<HTMLElement>) => {
    if (!dragRef.current || display.groupBy === 'bot') return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDragOverCol(columnId);
    setDropBeforeId(insertBeforeCard(event.currentTarget, event.clientY)?.dataset.id ?? null);
  }, [display.groupBy]);

  const onColumnDrop = useCallback((columnId: SessionKanbanColumn, event: DragEvent<HTMLElement>) => {
    const currentDrag = dragRef.current;
    if (!currentDrag || display.groupBy === 'bot') return;
    event.preventDefault();
    const beforeCard = insertBeforeCard(event.currentTarget, event.clientY);
    clearDrag();
    const groups = groupsRef.current;
    const targetCol = columnId;
    if (currentDrag.kind === 'cluster') {
      const members = (groups.get(currentDrag.col) ?? [])
        .filter((row: any) => String(row.chatId) === currentDrag.chatId)
        .filter((row: any) => !(row.status === 'closed' && targetCol !== 'done'));
      if (!members.length) return;
      const memberIds = new Set(members.map((row: any) => row.sessionId));
      const colRows = (groups.get(targetCol) ?? []).filter((row: any) => !memberIds.has(row.sessionId));
      let index = beforeCard ? colRows.findIndex((row: any) => row.sessionId === beforeCard.dataset.id) : colRows.length;
      if (index < 0) index = colRows.length;
      const prevRow = index > 0 ? colRows[index - 1] : null;
      const nextRow = index < colRows.length ? colRows[index] : null;
      const base = computeDropPosition(
        prevRow ? effectiveKanbanPosition(prevRow) : null,
        nextRow ? effectiveKanbanPosition(nextRow) : null,
      );
      display.onMoveRows(members.map((row: any, i: number) => ({ row, column: targetCol, position: base + i * 0.001 })));
      return;
    }

    const row = rowByIdRef.current.get(currentDrag.id);
    if (!row) return;
    if (row.status === 'closed' && targetCol !== 'done') return;
    const colRows = (groups.get(targetCol) ?? []).filter((candidate: any) => candidate.sessionId !== currentDrag.id);
    let index = beforeCard ? colRows.findIndex((candidate: any) => candidate.sessionId === beforeCard.dataset.id) : colRows.length;
    if (index < 0) index = colRows.length;
    const prevRow = index > 0 ? colRows[index - 1] : null;
    const nextRow = index < colRows.length ? colRows[index] : null;
    const position = computeDropPosition(
      prevRow ? effectiveKanbanPosition(prevRow) : null,
      nextRow ? effectiveKanbanPosition(nextRow) : null,
    );
    display.onMoveRows([{ row, column: targetCol, position }]);
  }, [clearDrag, display]);

  const cardProps = {
    dragId: drag?.kind === 'card' ? drag.id : null,
    dropBeforeId,
    editingId,
    groupBy: display.groupBy,
    callbacks: display,
    cancelOpen,
    onBeginEdit,
    onCardClick,
    onCardKeyDown,
    onDragStartCard,
    onEditDone: () => setEditingId(null),
  };

  if (model.mode === 'loading') {
    return <LoadingState label={t('sessions.kanban.teamLoading')} className="kanban-loading-state" />;
  }

  if (model.mode === 'bot') {
    if (!model.columns.length) return <div className="kanban-col-empty">{t('sessions.board.emptyColumn')}</div>;
    return (
      <>
        {model.columns.map(column => (
          <section key={column.key} className="kanban-column kanban-bot-col" data-bot={column.key}>
            <header>
              <span className="kanban-col-avatar" dangerouslySetInnerHTML={rawHtml(botAvatarHtml({ name: column.name, larkAppId: column.larkAppId, size: 'sm' }))} />
              <h2>{column.name}</h2>
              <span className="kanban-col-count">{column.rows.length}</span>
            </header>
            <div
              className="kanban-col-list"
              onDragOver={event => onColumnDragOver(column.key, event)}
              onDragEnd={clearDrag}
            >
              {column.clusters.map(item => (
                <ClusterView
                  key={item.type === 'card' ? item.row.sessionId : item.chatId}
                  item={item}
                  dragCluster={drag?.kind === 'cluster' ? drag : null}
                  cardProps={cardProps}
                  onDragStartCluster={onDragStartCluster}
                />
              ))}
            </div>
          </section>
        ))}
      </>
    );
  }

  return (
    <>
      {model.columns.map(column => (
        <section
          key={column.id}
          className={`kanban-column kanban-${column.id}${dragOverCol === column.id ? ' drag-over' : ''}`}
          data-col={column.id}
          onDragOver={event => onColumnDragOver(column.id, event)}
          onDrop={event => onColumnDrop(column.id, event)}
          onDragEnd={clearDrag}
        >
          <header>
            <span className="kanban-col-icon" dangerouslySetInnerHTML={rawHtml(kanbanStatusIcon(column.id))} />
            <h2>{t(column.labelKey)}</h2>
            <span className="kanban-col-count">{column.rows.length + column.hiddenCount}</span>
          </header>
          <div className="kanban-col-list">
            {column.rows.length ? (
              column.clusters.map(item => (
                <ClusterView
                  key={item.type === 'card' ? item.row.sessionId : item.chatId}
                  item={item}
                  columnId={column.id}
                  dragCluster={drag?.kind === 'cluster' ? drag : null}
                  cardProps={cardProps}
                  onDragStartCluster={onDragStartCluster}
                />
              ))
            ) : (
              <div className="kanban-col-empty">{t('sessions.board.emptyColumn')}</div>
            )}
            {column.hiddenCount ? (
              <div className="kanban-col-more">{t('sessions.kanban.moreHidden', { count: column.hiddenCount })}</div>
            ) : null}
          </div>
        </section>
      ))}
    </>
  );
}
