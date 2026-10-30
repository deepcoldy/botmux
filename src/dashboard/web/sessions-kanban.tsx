import type React from 'react';
import {
  memo,
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
import { createPortal } from 'react-dom';
import {
  computeDropPosition,
  deriveKanbanColumn,
  effectiveKanbanPosition,
  paginateColumnEntries,
  type SessionKanbanColumn,
} from './kanban-model.js';
import {
  botDisplayName,
  chatAvatarHtml,
  chatDisplayTitle,
  relTime,
  stripMentionPrefix,
  t,
} from './ui.js';
import { deriveSessionBoardColumn, sessionExchangePreview } from './sessions.js';
import { previewMarkdownHtml } from './preview-markdown.js';
import { SandboxDriftChip } from './session-sandbox-drift-chip.js';
import { useT } from './react-hooks.js';

export interface SessionsKanbanIcons {
  feishu: string;
  history: string;
  lock: string;
  restart: string;
  close: string;
  terminal: string;
  unlock: string;
}

export interface SessionsKanbanMove {
  row: any;
  column: SessionKanbanColumn;
  position: number;
}

export interface SessionsKanbanState {
  rows: any[];
}

export interface SessionsKanbanCallbacks {
  canRestartSession: (row: any) => boolean;
  icons: SessionsKanbanIcons;
  lockActionLabel: (row: any) => string;
  sessionStatusText: (status: unknown) => string;
  onClose?: (row: any, button?: HTMLButtonElement) => void;
  onDetails: (row: any) => void;
  onHistory: (row: any) => void;
  onMoveRows: (moves: SessionsKanbanMove[]) => void;
  /** 卡片唯一的「终端」入口：页面侧按身份决定开可操作终端还是只读终端。 */
  onOpenTerminal?: (row: any, button: HTMLButtonElement) => void;
  onRename: (row: any, title: string) => void;
  onRestart: (row: any, button: HTMLButtonElement) => void;
  onToggleLock: (row: any, button: HTMLButtonElement) => void;
  onToggleSelect: (row: any) => void;
  selectedSessionIds: ReadonlySet<string>;
  /** 名字表（botDisplayName/chatDisplayTitle 读的模块级 Map）解析完成后自增。
   *  卡片被 memo 且行对象引用不变，没有这个判据名字表回来后卡片会停在 cli_xxx。 */
  namesVersion?: number;
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

type FlowModel = {
  columns: FlowColumnModel[];
  groups: Map<SessionKanbanColumn, any[]>;
  rowById: Map<string, any>;
};

const KANBAN_COLUMNS: Array<{ id: SessionKanbanColumn; labelKey: string }> = [
  { id: 'backlog', labelKey: 'sessions.kanban.backlog' },
  { id: 'todo', labelKey: 'sessions.kanban.todo' },
  { id: 'in_progress', labelKey: 'sessions.kanban.inProgress' },
  { id: 'in_review', labelKey: 'sessions.kanban.inReview' },
  { id: 'done', labelKey: 'sessions.kanban.done' },
];

export const KANBAN_DONE_CAP = 50;
/** 每列首屏最多渲染多少个卡片/群簇，其余点「显示更多」再按同样步长展开。
 *  看板是唯一按会话数量线性长 DOM 的视图，不设上限时几千张卡片会让每次点选都卡顿。 */
export const KANBAN_COLUMN_PAGE = 60;

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
  if (s.status === 'stalled') return t('sessions.board.signalStalled');
  return '';
}

/** 看板列 → 状态色点：与卡片左侧状态条同一套语义（需要你/进行中/待办/空闲）。 */
function kanbanColumnDotClass(id: SessionKanbanColumn): string {
  switch (id) {
    case 'backlog': return 'kanban-col-dot-idle';
    case 'todo': return 'kanban-col-dot-todo';
    case 'in_progress': return 'kanban-col-dot-work';
    case 'in_review': return 'kanban-col-dot-need';
    case 'done': return 'kanban-col-dot-done';
    default: return 'kanban-col-dot-idle';
  }
}

function rawHtml(html: string): { __html: string } {
  return { __html: html };
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

function buildFlowModel(rows: any[]): FlowModel {
  const { columns, groups } = buildFlowColumns(rows);
  return { columns, groups, rowById: new Map(rows.map(row => [String(row.sessionId), row])) };
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

type CardMenuItem = {
  key: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Render as an external link instead of a button. */
  href?: string;
  onSelect?: (button: HTMLButtonElement | HTMLAnchorElement) => void;
};

/**
 * 卡片「⋯」菜单：卡片本身 overflow:hidden（状态条/文本截断依赖它），菜单弹层
 * 只能 portal 到 body 定位，否则会被卡片裁掉。打开时按触发按钮位置算坐标，
 * 视口不够就向上弹；外部 pointerdown / Esc 关闭（与 IdleCleanupBar 同一套模式）。
 */
function CardMenu(props: { items: CardMenuItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = 190;
    const margin = 8;
    const height = props.items.length * 34 + 10;
    const left = Math.min(Math.max(rect.right - width, margin), window.innerWidth - width - margin);
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const placement = spaceBelow >= height || spaceBelow > spaceAbove ? 'bottom' : 'top';
    const top = placement === 'bottom' ? rect.bottom + 6 : rect.top - height - 6;
    setPos({ top: Math.max(margin, top), left, placement });
  }, [props.items.length]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(place);
    const onReposition = () => place();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (btnRef.current?.contains(target) || popRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`kanban-card-more${open ? ' is-open' : ''}`}
        data-action="more"
        data-menu-items={props.items.map(item => item.key).join(',')}
        aria-label={t('sessions.cardMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.2" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.8" r="1.3" fill="currentColor"/></svg>
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popRef}
          className={`card-menu-pop card-menu-${pos?.placement ?? 'bottom'}`}
          role="menu"
          aria-label={t('sessions.cardMenu')}
          style={{ top: `${pos?.top ?? -10000}px`, left: `${pos?.left ?? -10000}px`, visibility: pos ? 'visible' : 'hidden' }}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
        >
          {props.items.map(item => (
            item.href ? (
              <a
                key={item.key}
                role="menuitem"
                className={`card-menu-item${item.danger ? ' danger' : ''}`}
                href={item.href}
                target="_blank"
                rel="noopener"
                onClick={() => setOpen(false)}
              >
                {item.icon ? <span className="card-menu-icon" dangerouslySetInnerHTML={rawHtml(item.icon)} /> : null}
                <span className="card-menu-label">{item.label}</span>
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`card-menu-item${item.danger ? ' danger' : ''}`}
                onClick={(event) => {
                  setOpen(false);
                  item.onSelect?.(event.currentTarget);
                }}
              >
                {item.icon ? <span className="card-menu-icon" dangerouslySetInnerHTML={rawHtml(item.icon)} /> : null}
                <span className="card-menu-label">{item.label}</span>
              </button>
            )
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

type ExchangePreview = ReturnType<typeof sessionExchangePreview>;

/**
 * 卡片上的最近一轮对话摘要 + 悬停弹层。弹层按 Markdown 渲染完整原文（previewMarkdownHtml
 * 已做链接白名单、图片降级为不发请求的占位），代替原生 title——那只能显示一坨未渲染的
 * Markdown 源码。弹层 portal 到 body，逃出卡片的 overflow:hidden。
 */
function CardPreview(props: { exchange: ExchangePreview }): React.JSX.Element | null {
  const { exchange } = props;
  const text = exchange.botText || exchange.userText;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLParagraphElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const scheduleOpen = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => setOpen(true), 350);
  }, [clearTimer]);
  const scheduleClose = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setOpen(false);
      setPos(null);
    }, 150);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = triggerRef.current;
      const pop = popRef.current;
      if (!trigger || !pop) return;
      const r = trigger.getBoundingClientRect();
      const margin = 12;
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      // 优先放在卡片下方，放不下就放上方；横向贴着卡片左缘，不出视口。
      const below = r.bottom + 8 + h <= window.innerHeight - margin || r.top - 8 - h < margin;
      const top = below ? Math.min(r.bottom + 8, window.innerHeight - h - margin) : r.top - 8 - h;
      const left = Math.min(Math.max(r.left, margin), window.innerWidth - w - margin);
      setPos({ top: Math.max(margin, top), left });
    };
    place();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); setPos(null); }
    };
    // 弹层里内容长了要能滚着看：弹层自身的滚动不算「离开」；外面（看板列、页面）滚动时
    // 跟着卡片重新定位，而不是直接关掉。
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popRef.current?.contains(event.target)) return;
      place();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  if (!text) return null;
  return (
    <>
      <p
        ref={triggerRef}
        className="kanban-card-preview"
        onPointerEnter={event => { if (event.pointerType !== 'touch') scheduleOpen(); }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') scheduleClose(); }}
      >
        {text}
      </p>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popRef}
          className="session-card-exchange-tooltip"
          role="tooltip"
          style={{ top: pos?.top ?? -10_000, left: pos?.left ?? -10_000, visibility: pos ? 'visible' : 'hidden' }}
          onPointerEnter={clearTimer}
          onPointerLeave={scheduleClose}
        >
          <div className="session-card-exchange-tooltip-scroll">
            {exchange.userFullText ? (
              <div className="session-card-exchange-tooltip-line">
                <span>{t('sessions.history.user')}</span>
                <div className="session-card-exchange-md" dangerouslySetInnerHTML={rawHtml(previewMarkdownHtml(exchange.userFullText))} />
              </div>
            ) : null}
            {exchange.botFullText ? (
              <div className="session-card-exchange-tooltip-line bot">
                <span>{t('sessions.history.bot')}</span>
                <div className="session-card-exchange-md" dangerouslySetInnerHTML={rawHtml(previewMarkdownHtml(exchange.botFullText))} />
              </div>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function RenameInput(props: {
  row: any;
  onCancel: () => void;
  onCommit: (row: any, title: string) => void;
}): React.JSX.Element {
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

function KanbanCardBase(props: {
  row: any;
  dragId: string | null;
  dropBeforeId: string | null;
  editingId: string | null;
  callbacks: SessionsKanbanCallbacks;
  cancelOpen: () => void;
  onBeginEdit: (row: any) => void;
  onCardClick: (row: any, event: MouseEvent<HTMLElement>) => void;
  onCardKeyDown: (row: any, event: KeyboardEvent<HTMLElement>) => void;
  onDragStartCard: (row: any, event: DragEvent<HTMLElement>) => void;
  onEditDone: () => void;
}): React.JSX.Element {
  // 卡片被 memo 且比较器不看 locale，必须自己订阅，否则切语言时文案停在旧语言。
  useT();
  const { callbacks, row } = props;
  const title = rowTitle(row);
  const botName = botDisplayName(row);
  const chatTitle = chatDisplayTitle(row);
  const repo = repoBasename(row.workingDir);
  const signal = boardSignalLabel(row);
  // 状态色条：需要你 / 进行中 / 待办 / 空闲（deriveSessionBoardColumn）；已关闭单独一色。
  const boardCol = deriveSessionBoardColumn(row);
  const signalKind = boardCol ?? (row.status === 'closed' ? 'closed' : 'idle');
  const exchange = sessionExchangePreview(row);
  const meta = [botName, chatTitle].filter(Boolean).join(' · ');
  const status = String(row.status ?? 'unknown');
  const isEditing = props.editingId === row.sessionId;
  const selected = callbacks.selectedSessionIds.has(String(row.sessionId));
  const className = [
    'kanban-card',
    selected ? 'selected' : '',
    row.locked ? 'locked' : '',
    props.dragId === row.sessionId ? 'dragging' : '',
    props.dropBeforeId === row.sessionId ? 'drop-before' : '',
  ].filter(Boolean).join(' ');

  const menuItems: CardMenuItem[] = [];
  // 「详情」不放菜单里：单击卡片就是打开详情。
  menuItems.push({
    key: 'history',
    label: t('sessions.history.title'),
    icon: callbacks.icons.history,
    onSelect: () => callbacks.onHistory(row),
  });
  if (row.feishuChatLink) {
    menuItems.push({
      key: 'feishu',
      label: t('sessions.kanban.openFeishu'),
      icon: callbacks.icons.feishu,
      href: row.feishuChatLink,
    });
  }
  if (callbacks.canRestartSession(row)) {
    menuItems.push({
      key: 'restart',
      label: t('sessions.restart'),
      icon: callbacks.icons.restart,
      onSelect: button => callbacks.onRestart(row, button as HTMLButtonElement),
    });
  }
  menuItems.push({
    key: 'lock',
    label: callbacks.lockActionLabel(row),
    icon: row.locked ? callbacks.icons.unlock : callbacks.icons.lock,
    onSelect: button => callbacks.onToggleLock(row, button as HTMLButtonElement),
  });
  if (row.status !== 'closed' && callbacks.onClose) {
    menuItems.push({
      key: 'close',
      label: t('sessions.close'),
      icon: callbacks.icons.close,
      danger: true,
      onSelect: button => callbacks.onClose?.(row, button as HTMLButtonElement),
    });
  }

  return (
    <article
      className={className}
      data-id={row.sessionId}
      data-signal={signalKind}
      tabIndex={0}
      role="button"
      aria-label={String(title)}
      draggable
      onClick={event => props.onCardClick(row, event)}
      onKeyDown={event => props.onCardKeyDown(row, event)}
      onDragStart={event => props.onDragStartCard(row, event)}
    >
      <div className="kanban-card-head">
        <input
          type="checkbox"
          className="kanban-card-check"
          checked={selected}
          disabled={row.status === 'closed'}
          aria-label={t('sessions.selectSession')}
          onClick={event => event.stopPropagation()}
          onChange={() => callbacks.onToggleSelect(row)}
        />
        <span className={`badge cli-${cssToken(row.cliId)}`}>{row.cliId ?? 'unknown'}</span>
        {row.adopt ? <span className="badge">adopt</span> : null}
        {row.locked ? <span className="session-lock-badge" title={t('sessions.locked')}>{t('sessions.locked')}</span> : null}
        <SandboxDriftChip row={row} />
        {menuItems.length ? <CardMenu items={menuItems} /> : null}
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
              props.onBeginEdit(row);
            }}
          >
            {String(title).slice(0, 140)}
          </p>
        )}
      </div>
      {/* 「需要你」的原因单独一行、允许换行：塞在卡片头里和 CLI 徽标抢宽度时只剩几个字。 */}
      {signal ? <p className="session-signal kanban-card-reason" title={signal}>{signal}</p> : null}
      {meta ? (
        <p className="kanban-card-meta" title={repo !== '-' ? `${meta} · ${repo}` : meta}>
          {meta}
        </p>
      ) : null}
      <CardPreview exchange={exchange} />
      <div className="kanban-card-foot">
        <span className="kanban-card-updated">
          {t('sessions.kanban.updated', { time: relTime(row.lastMessageAt) })}
          <span
            className="kanban-card-dot"
            data-status={cssToken(status)}
            title={callbacks.sessionStatusText(status)}
          />
        </span>
        {row.webPort && callbacks.onOpenTerminal ? (
          <button
            type="button"
            className="kanban-card-term"
            data-action="terminal"
            onClick={(event) => {
              event.stopPropagation();
              callbacks.onOpenTerminal?.(row, event.currentTarget);
            }}
          >
            <span dangerouslySetInnerHTML={rawHtml(callbacks.icons.terminal)} />
            {t('sessions.terminal')}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * 卡片是看板里唯一按会话数量线性增长的东西（bot 分组下实测 1406 张），而每张卡片
 * 渲染一次要跑 rowTitle/botDisplayName/chatDisplayTitle/sessionExchangePreview/
 * deriveSessionBoardColumn + 一串 t()。选中一张卡片只改一个 id，却会让所有卡片
 * 重算一遍——实测单次点选主线程阻塞约 2s。
 *
 * 这里按「这张卡片会不会长得不一样」做等价判断：只有它自己的 row、它自己的选中
 * 态、以及真正作用到它身上的拖拽/重命名标记变化时才重渲染。dragId/dropBeforeId/
 * editingId 都先折叠成布尔再比，于是拖动或改名时只有相关的那一两张卡片重渲染，
 * 而不是整列。
 */
const KanbanCard = memo(KanbanCardBase, (prev, next) => {
  if (prev.row !== next.row) return false;
  const id = next.row.sessionId;
  // callbacks 是整个 props 对象：selectedSessionIds 每次选中都是新 Set，onXxx 现在已在
  // 页面侧固定。所以不能拿它的引用当判据（那等于 memo 永不命中），要逐个比卡片真正
  // 渲染时读到的字段。
  const a = prev.callbacks;
  const b = next.callbacks;
  if (a.namesVersion !== b.namesVersion) return false;
  if (a.icons !== b.icons
    || a.canRestartSession !== b.canRestartSession
    || a.lockActionLabel !== b.lockActionLabel
    || a.sessionStatusText !== b.sessionStatusText
    || a.onClose !== b.onClose
    || a.onDetails !== b.onDetails
    || a.onToggleSelect !== b.onToggleSelect
    || a.onHistory !== b.onHistory
    || a.onOpenTerminal !== b.onOpenTerminal
    || a.onRename !== b.onRename
    || a.onRestart !== b.onRestart
    || a.onToggleLock !== b.onToggleLock) return false;
  if ((prev.dragId === prev.row.sessionId) !== (next.dragId === id)) return false;
  if ((prev.dropBeforeId === prev.row.sessionId) !== (next.dropBeforeId === id)) return false;
  if ((prev.editingId === prev.row.sessionId) !== (next.editingId === id)) return false;
  if (a.selectedSessionIds.has(String(id)) !== b.selectedSessionIds.has(String(id))) return false;
  return prev.cancelOpen === next.cancelOpen
    && prev.onBeginEdit === next.onBeginEdit
    && prev.onCardClick === next.onCardClick
    && prev.onCardKeyDown === next.onCardKeyDown
    && prev.onDragStartCard === next.onDragStartCard
    && prev.onEditDone === next.onEditDone;
});

function ClusterViewBase(props: {
  item: ClusterItem;
  columnId?: SessionKanbanColumn;
  dragCluster: { chatId: string; col: SessionKanbanColumn } | null;
  cardProps: Omit<Parameters<typeof KanbanCard>[0], 'row'>;
  expandKey: string;
  expanded: boolean;
  /** 展开态下该簇最多渲染的成员卡数（列分页预算截断）；折叠态忽略。 */
  memberCap: number;
  onToggleExpanded: (key: string) => void;
  onDragStartCluster: (chatId: string, col: SessionKanbanColumn, event: DragEvent<HTMLElement>) => void;
}): React.JSX.Element {
  const item = props.item;
  if (item.type === 'card') return <KanbanCard {...props.cardProps} row={item.row} />;
  const title = chatDisplayTitle(item.rows[0]) ?? item.chatId;
  const dragging = props.dragCluster?.chatId === item.chatId && props.dragCluster.col === props.columnId;
  const visibleRows = props.expanded
    ? (props.memberCap >= 0 ? item.rows.slice(0, props.memberCap) : item.rows)
    : [];
  return (
    <div className={`kanban-cluster${props.expanded ? ' expanded' : ' collapsed'}${dragging ? ' dragging' : ''}`} data-chat={item.chatId}>
      <header
        draggable
        title={`${title} · ${t('sessions.kanban.clusterDragHint')}`}
        onDragStart={event => {
          if (props.columnId) props.onDragStartCluster(item.chatId, props.columnId, event);
        }}
      >
        <span className="kanban-cluster-avatar" dangerouslySetInnerHTML={rawHtml(chatAvatarHtml({ chatId: item.chatId, name: title, size: 'sm' }))} />
        <span className="kanban-cluster-name">{title}</span>
        <span className="kanban-cluster-count">{item.rows.length}</span>
        <button
          type="button"
          className="kanban-cluster-toggle"
          aria-expanded={props.expanded}
          title={t(props.expanded ? 'sessions.kanban.clusterCollapse' : 'sessions.kanban.clusterExpand')}
          aria-label={t(props.expanded ? 'sessions.kanban.clusterCollapse' : 'sessions.kanban.clusterExpand')}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleExpanded(props.expandKey);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 6.5 2.5 2.5 2.5-2.5" /></svg>
        </button>
      </header>
      {visibleRows.map(row => <KanbanCard key={row.sessionId} {...props.cardProps} row={row} />)}
    </div>
  );
}

const ClusterView = memo(ClusterViewBase);

export function SessionsKanbanView(props: SessionsKanbanProps): React.JSX.Element {
  const [display, setDisplay] = useState<SessionsKanbanProps>(props);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: 'card'; id: string } | { kind: 'cluster'; chatId: string; col: SessionKanbanColumn } | null>(null);
  const [dragOverCol, setDragOverCol] = useState<SessionKanbanColumn | string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(() => new Set());
  // 每列已展开到第几页（缺省 1 页 = KANBAN_COLUMN_PAGE 个卡片/群簇）。
  const [columnPages, setColumnPages] = useState<Partial<Record<SessionKanbanColumn, number>>>({});
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

  const model = useMemo(() => buildFlowModel(display.rows), [display.rows]);

  useLayoutEffect(() => {
    groupsRef.current = model.groups;
    rowByIdRef.current = model.rowById;
  }, [model]);

  const clearDrag = useCallback(() => {
    setDrag(null);
    setDragOverCol(null);
    setDropBeforeId(null);
  }, []);

  const toggleExpandedCluster = useCallback((key: string) => {
    setExpandedClusters(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onBeginEdit = useCallback((row: any) => {
    cancelOpen();
    setEditingId(row.sessionId);
  }, [cancelOpen]);

  // 只依赖 onToggleSelect / onDetails，不依赖整个 display：display 每次更新都是新对象，
  // 挂在它上面会让这两个回调（进而每张卡片的 props）跟着换引用。
  const onToggleSelect = display.onToggleSelect;
  const onDetails = display.onDetails;
  // 单击打开详情；Shift / ⌘ / Ctrl + 单击（或卡片左上角的勾选框）才是选中。
  // 打开详情延后 220ms，好让双击改名能把它取消掉。
  const onCardClick = useCallback((row: any, event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, label')) return;
    cancelOpen();
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      onToggleSelect(row);
      return;
    }
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      onDetails(row);
    }, 220);
  }, [cancelOpen, onDetails, onToggleSelect]);

  // 键盘：Enter 打开详情，空格切换选中。
  const onCardKeyDown = useCallback((row: any, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (event.key === 'Enter') onDetails(row);
    else onToggleSelect(row);
  }, [onDetails, onToggleSelect]);

  const onDragStartCard = useCallback((row: any, event: DragEvent<HTMLElement>) => {
    cancelOpen();
    setDrag({ kind: 'card', id: String(row.sessionId) });
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(row.sessionId));
    }
  }, [cancelOpen]);

  const onDragStartCluster = useCallback((chatId: string, col: SessionKanbanColumn, event: DragEvent<HTMLElement>) => {
    cancelOpen();
    setDrag({ kind: 'cluster', chatId, col });
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `cluster:${chatId}`);
    }
  }, [cancelOpen]);

  const onColumnDragOver = useCallback((columnId: SessionKanbanColumn | string, event: DragEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDragOverCol(columnId);
    setDropBeforeId(insertBeforeCard(event.currentTarget, event.clientY)?.dataset.id ?? null);
  }, []);

  const onColumnDrop = useCallback((columnId: SessionKanbanColumn, event: DragEvent<HTMLElement>) => {
    const currentDrag = dragRef.current;
    if (!currentDrag) return;
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

  // 卡片 memo 只在 props 引用不变时才生效，所以这里必须是稳定引用：以前它是渲染
  // 体里的字面量 + 内联箭头函数（onEditDone），每次渲染都全新，等于 memo 永远命不中。
  const onEditDone = useCallback(() => setEditingId(null), []);
  const cardProps = useMemo(() => ({
    dragId: drag?.kind === 'card' ? drag.id : null,
    dropBeforeId,
    editingId,
    callbacks: display,
    cancelOpen,
    onBeginEdit,
    onCardClick,
    onCardKeyDown,
    onDragStartCard,
    onEditDone,
  }), [
    cancelOpen, display, dropBeforeId, drag, editingId,
    onBeginEdit, onCardClick, onCardKeyDown, onDragStartCard, onEditDone,
  ]);

  // 分页按「成员卡」计数而不是按群簇：群簇只是折叠 UI，一个热闹群可能有几百个成员，
  // 按簇切页会出现「按钮说还有 5 张、点开只有一个折叠标题」与「展开即渲染全部成员」
  // 两种绕过渲染上限的形态。预算、成员截断与剩余数统一由 paginateColumnEntries 给出。
  const columnPaging = (column: FlowColumnModel) => {
    const budget = (columnPages[column.id] ?? 1) * KANBAN_COLUMN_PAGE;
    return paginateColumnEntries(
      column.clusters.map(item => ({
        size: item.type === 'card' ? 1 : item.rows.length,
        expanded: item.type === 'cluster' && expandedClusters.has(`${column.id}:${item.chatId}`),
      })),
      budget,
    );
  };

  return (
    <>
      {model.columns.map(column => {
        const paging = columnPaging(column);
        const visibleItems = column.clusters.slice(0, paging.visibleCount);
        return (
        <section
          key={column.id}
          className={`kanban-column kanban-${column.id}${dragOverCol === column.id ? ' drag-over' : ''}`}
          data-col={column.id}
          onDragOver={event => onColumnDragOver(column.id, event)}
          onDrop={event => onColumnDrop(column.id, event)}
          onDragEnd={clearDrag}
        >
          <header>
            <span className={`kanban-col-dot ${kanbanColumnDotClass(column.id)}`} aria-hidden="true" />
            <h2>{t(column.labelKey)}</h2>
            <span className="kanban-col-count">{column.rows.length + column.hiddenCount}</span>
          </header>
          <div className="kanban-col-list">
            {column.rows.length ? (
              visibleItems.map((item, index) => {
                const expandKey = item.type === 'cluster' ? `${column.id}:${item.chatId}` : '';
                return (
                  <ClusterView
                    key={item.type === 'card' ? item.row.sessionId : item.chatId}
                    item={item}
                    columnId={column.id}
                    dragCluster={drag?.kind === 'cluster' ? drag : null}
                    cardProps={cardProps}
                    expandKey={expandKey}
                    expanded={!!expandKey && expandedClusters.has(expandKey)}
                    memberCap={paging.memberCaps[index] ?? -1}
                    onToggleExpanded={toggleExpandedCluster}
                    onDragStartCluster={onDragStartCluster}
                  />
                );
              })
            ) : (
              <div className="kanban-col-empty">{t('sessions.board.emptyColumn')}</div>
            )}
            {paging.hiddenUnits > 0 ? (
              <button
                type="button"
                className="kanban-col-more kanban-col-show-more"
                onClick={() => setColumnPages(prev => ({ ...prev, [column.id]: (prev[column.id] ?? 1) + 1 }))}
              >
                {t('sessions.kanban.showMore', { count: paging.hiddenUnits })}
              </button>
            ) : null}
            {column.hiddenCount ? (
              <div className="kanban-col-more">{t('sessions.kanban.moreHidden', { count: column.hiddenCount })}</div>
            ) : null}
          </div>
        </section>
        );
      })}
    </>
  );
}
