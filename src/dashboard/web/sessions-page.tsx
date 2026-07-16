import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  IDLE_CLEANUP_HOUR_OPTIONS,
  parseIdleCleanupHours,
  selectIdleCleanupCandidates,
  type IdleCleanupHours,
} from '../session-cleanup.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';
import {
  KANBAN_TEAM_STORAGE_KEY,
  normalizeSessionsViewMode,
  readStoredBoardOrder,
  readStoredCreateKeepOpen,
  readStoredKanbanGroupBy,
  readStoredSessionsShowUnknownChats,
  readStoredSessionsViewMode,
  type KanbanGroupBy,
  type SessionsViewMode,
  writeStoredBoardOrder,
  writeStoredCreateKeepOpen,
  writeStoredKanbanGroupBy,
  writeStoredSessionsShowUnknownChats,
  writeStoredSessionsViewMode,
} from './preferences.js';
import { OPEN_CREATE_SESSION_EVENT, consumePendingCreateSession } from './create-session-entry.js';
import {
  BOARD_COLUMNS,
  CLI_FILTER_OPTIONS,
  ICON,
  SESSION_STATUS_OPTIONS,
  canRestartSession,
  cssToken,
  deriveSessionBoardColumn,
  fetchPickerBots,
  formatTokenCount,
  historySenderKey,
  isUnknownChatSession,
  lockActionLabel,
  openWriteLink,
  repoBasename,
  restartConfirmMessage,
  sessionLocationText,
  sessionLocationTitle,
  sessionRuntimeCounts,
  sessionSearchText,
  sessionStatusText,
  shouldOpenWritableTerminal,
  terminalHref,
  tokenCount,
  type BoardColumnId,
  type PickerBot,
} from './sessions.js';
import { addMonitorRoomSessionIds, monitorRoomUrl } from './monitor-room-store.js';
import { CreateActionButton, DropdownMenu, LoadingState } from './dashboard-components.js';
import { store } from './store.js';
import {
  attentionWaitSince,
  botAvatarHtml,
  botDisplayName,
  chatDisplayTitle,
  loadNameMaps,
  relTime,
  stripMentionPrefix,
  t,
  ui,
} from './ui.js';
import type { SessionKanbanColumn } from './kanban-model.js';
import {
  SessionsKanbanView,
  type SessionsKanbanMove,
  type SessionsKanbanTeam,
  type SessionsKanbanTeamBoardData,
} from './sessions-kanban.js';

type SessionRow = Record<string, any> & { sessionId: string; status: string };

type FiltersState = {
  q: string;
  status: string;
  adopt: string;
  chat: string;
  showUnknownChats: boolean;
  active: boolean;
  cli: Set<string>;
};

type ChatFilterOption = { value: string; label: string };

type ChatBotsMap = Map<string, { botIds: Set<string>; observedNames: Set<string> }>;

type TeamBoardState = {
  data: SessionsKanbanTeamBoardData | null;
  key: string;
  fetchedAt: number;
};

type HistoryState = {
  sessionId: string;
  loading: boolean;
  messages: any[];
  ownerOpenId?: string;
  error?: string;
  stale?: boolean;
};

type TerminalState = {
  sessionId: string;
  url: string | null;
  loading: boolean;
};

type CreateSessionState = {
  bots: PickerBot[];
  loading?: boolean;
  success?: any;
};

type IdleCleanupBarProps = {
  busy: boolean;
  hours: IdleCleanupHours;
  status: string;
  countForHours: (hours: IdleCleanupHours) => number;
  onRun: (hours: IdleCleanupHours) => Promise<void>;
};

type IdleCleanupHoursValue = `${IdleCleanupHours}`;

function idleCleanupHoursLabel(hours: IdleCleanupHours): string {
  return hours === 168 ? '7d' : `${hours}H`;
}

const idleCleanupThresholdOptions = IDLE_CLEANUP_HOUR_OPTIONS.map(hours => ({
  value: String(hours) as IdleCleanupHoursValue,
  label: idleCleanupHoursLabel(hours),
}));

function rawHtml(html: string): { __html: string } {
  return { __html: html };
}

function windowStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function StatusBadge(props: { status: unknown }): JSX.Element {
  const raw = String(props.status ?? 'unknown');
  return <span className={`status status-${cssToken(raw)}`}>{sessionStatusText(raw)}</span>;
}

function LockChip(props: { row: any }): JSX.Element | null {
  if (!props.row.locked) return null;
  return <span className="session-lock-badge" title={t('sessions.locked')}>{t('sessions.locked')}</span>;
}

function IconActionButton(props: {
  action?: string;
  className?: string;
  id?: string;
  label: string;
  icon: string;
  kind?: string;
  disabled?: boolean;
  onClick: (button: HTMLButtonElement) => void;
}): JSX.Element {
  const className = props.className ?? `card-act${props.kind ? ` ${props.kind}` : ''}`;
  return (
    <button
      type="button"
      id={props.id}
      className={className}
      data-action={props.action}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick(event.currentTarget);
      }}
      dangerouslySetInnerHTML={rawHtml(props.icon)}
    />
  );
}

function TerminalControls(props: { row: any; url: string | null }): JSX.Element | null {
  if (!props.url) return null;
  const readOnly = !shouldOpenWritableTerminal();
  return (
    <span className={`term-pill${readOnly ? ' readonly' : ' writable'}`}>
      {readOnly ? (
        <a
          className="term-btn term-open"
          href={props.url}
          target="_blank"
          rel="noopener"
          title={t('sessions.openTerminal')}
          aria-label={t('sessions.openTerminal')}
          onClick={event => event.stopPropagation()}
          dangerouslySetInnerHTML={rawHtml(ICON.terminal)}
        />
      ) : (
        <button
          type="button"
          className="term-btn term-write"
          data-action="write-link"
          title={t('sessions.openTerminal')}
          aria-label={t('sessions.openTerminal')}
          onClick={(event) => {
            event.stopPropagation();
            void openWriteLink(props.row, event.currentTarget);
          }}
          dangerouslySetInnerHTML={rawHtml(ICON.terminal)}
        />
      )}
    </span>
  );
}

function ChatScopeLink(props: { row: any; className?: string }): JSX.Element | null {
  const row = props.row;
  if (row.scope !== 'chat' || !row.feishuChatLink) return null;
  return (
    <a
      className={props.className ?? 'card-act'}
      href={row.feishuChatLink}
      target="_blank"
      rel="noopener"
      title={t('sessions.openChat')}
      aria-label={t('sessions.openChat')}
      onClick={event => event.stopPropagation()}
      dangerouslySetInnerHTML={rawHtml(ICON.feishu)}
    />
  );
}

function SortHeader(props: {
  sort: string;
  label: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  onSort: (key: string) => void;
}): JSX.Element {
  const active = props.sortKey === props.sort;
  return (
    <th
      data-sort={props.sort}
      data-label={props.label}
      className={active ? 'sorted' : undefined}
      aria-sort={active ? (props.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => props.onSort(props.sort)}
    >
      {active ? `${props.label} ${props.sortDir === 'asc' ? '▲' : '▼'}` : props.label}
    </th>
  );
}

function sortValue(s: any, key: string): string | number | boolean {
  if (key === 'spawnedAt' || key === 'lastMessageAt') return Number(s[key] ?? 0);
  if (key === 'tokenIn') return tokenCount(s.tokenUsage?.in) ?? -1;
  if (key === 'tokenOut') return tokenCount(s.tokenUsage?.out) ?? -1;
  if (key === 'adopt') return !!s.adopt;
  if (key === 'chat') return sessionLocationText(s).toLowerCase();
  return String(s[key] ?? '').toLowerCase();
}

function compareRows(a: any, b: any, sortKey: string, sortDir: 'asc' | 'desc'): number {
  const av = sortValue(a, sortKey);
  const bv = sortValue(b, sortKey);
  let cmp = 0;
  if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
  else if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = Number(av) - Number(bv);
  else cmp = String(av).localeCompare(String(bv));
  if (cmp === 0) cmp = Number(a.lastMessageAt ?? 0) - Number(b.lastMessageAt ?? 0);
  return sortDir === 'asc' ? cmp : -cmp;
}

function boardSignalLabel(s: any): string {
  if (s.agentAttention?.reason) return s.agentAttention.reason;
  if (s.agentAttention) return t('sessions.board.signalAgent');
  if (s.pendingRepo) return t('sessions.board.signalRepo');
  if (s.tuiPromptActive) return t('sessions.board.signalPrompt');
  if (s.status === 'limited') return t('sessions.board.signalLimited');
  return '';
}

function compareBoardRows(a: any, b: any, column: BoardColumnId): number {
  const av = column === 'needs-you' ? attentionWaitSince(a) : Number(a.lastMessageAt ?? 0);
  const bv = column === 'needs-you' ? attentionWaitSince(b) : Number(b.lastMessageAt ?? 0);
  if (av !== bv) return column === 'needs-you' ? av - bv : bv - av;
  return String(a.title ?? a.sessionId).localeCompare(String(b.title ?? b.sessionId));
}

function historyTime(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function insightDur(ms?: number): string {
  if (ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function useDialogVisibility(ref: React.RefObject<HTMLDialogElement | null>, open: boolean): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        try { dialog.showModal(); } catch { /* already opening/unsupported */ }
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, ref]);
}

function CopyButton(props: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-copy={props.value}
      onClick={() => {
        void navigator.clipboard.writeText(props.value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 800);
      }}
    >
      {copied ? t('sessions.copied') : t('sessions.copy')}
    </button>
  );
}

function LocateButton(props: { row: any; locateSession: (row: any) => Promise<boolean> }): JSX.Element {
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  return (
    <button
      id="locate-btn"
      type="button"
      disabled={busy || cooldown > 0}
      onClick={async () => {
        setBusy(true);
        const ok = await props.locateSession(props.row);
        setBusy(false);
        if (ok) setCooldown(30);
      }}
    >
      {cooldown > 0 ? t('sessions.cooldown', { seconds: cooldown }) : busy ? t('sessions.locating') : t('sessions.locate')}
    </button>
  );
}

// Icon variant of LocateButton for board/list cards: same React-owned busy+30s
// cooldown, but renders the pin icon via IconActionButton (no imperative DOM writes).
function LocateIconButton(props: { row: any; onLocate: (row: any) => Promise<boolean> }): JSX.Element {
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  return (
    <IconActionButton
      action="locate"
      icon={ICON.pin}
      label={cooldown > 0 ? t('sessions.cooldown', { seconds: cooldown }) : t('sessions.locate')}
      disabled={busy || cooldown > 0}
      onClick={async () => {
        setBusy(true);
        const ok = await props.onLocate(props.row);
        setBusy(false);
        if (ok) setCooldown(30);
      }}
    />
  );
}

export function CliFilterGroup(props: { selected: Set<string>; onToggle: (cli: string, checked: boolean) => void }): JSX.Element {
  const checked = CLI_FILTER_OPTIONS.filter(cli => props.selected.has(cli)).length;
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = () => {
      if (detailsRef.current?.open) detailsRef.current.open = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <details className="filter-cli" ref={detailsRef}>
      <summary>{t('sessions.cli')} · <b id="cli-filter-count" className={checked === CLI_FILTER_OPTIONS.length ? undefined : 'cli-filter-active'}>
        {checked === CLI_FILTER_OPTIONS.length ? t('common.all') : `${checked}/${CLI_FILTER_OPTIONS.length}`}
      </b></summary>
      <div className="filter-cli-pop" role="group" aria-label={t('sessions.cli')}>
        {CLI_FILTER_OPTIONS.map(cli => (
          <label key={cli} className="filter-check">
            <input
              type="checkbox"
              name="cli"
              value={cli}
              checked={props.selected.has(cli)}
              onChange={event => props.onToggle(cli, event.currentTarget.checked)}
            />
            <span>{cli}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function SessionsFilters(props: {
  chatOptions: ChatFilterOption[];
  filters: FiltersState;
  idleCleanup: IdleCleanupBarProps;
  setFilters: (updater: (prev: FiltersState) => FiltersState) => void;
}): JSX.Element {
  const statusOptions = [
    { value: '', label: t('sessions.anyStatus') },
    ...SESSION_STATUS_OPTIONS.map(status => ({ value: status, label: sessionStatusText(status) })),
  ];
  const adoptOptions = [
    { value: '', label: t('sessions.adoptAny') },
    { value: 'yes', label: t('sessions.adoptYes') },
    { value: 'no', label: t('sessions.adoptNo') },
  ];
  const statusLabel = statusOptions.find(option => option.value === props.filters.status)?.label ?? t('sessions.anyStatus');
  const adoptLabel = adoptOptions.find(option => option.value === props.filters.adopt)?.label ?? t('sessions.adoptAny');
  const chatOptions = [
    { value: '', label: t('sessions.chatAny') },
    ...props.chatOptions,
  ];
  const chatLabel = chatOptions.find(option => option.value === props.filters.chat)?.label ?? t('sessions.chatAny');

  return (
    <form id="filters" className="filters dashboard-toolbar sessions-filters" onSubmit={event => event.preventDefault()}>
      <input
        type="search"
        name="q"
        placeholder={t('sessions.search')}
        value={props.filters.q}
        onChange={event => {
          const q = event.currentTarget.value;
          props.setFilters(prev => ({ ...prev, q }));
        }}
      />
      <DropdownMenu
        label={statusLabel}
        value={props.filters.status}
        options={statusOptions}
        onChange={value => props.setFilters(prev => ({ ...prev, status: value }))}
      />
      <DropdownMenu
        label={adoptLabel}
        value={props.filters.adopt}
        options={adoptOptions}
        onChange={value => props.setFilters(prev => ({ ...prev, adopt: value }))}
      />
      <DropdownMenu
        ariaLabel={t('sessions.location')}
        label={chatLabel}
        value={props.filters.chat}
        options={chatOptions}
        onChange={value => props.setFilters(prev => ({ ...prev, chat: value }))}
      />
      <CliFilterGroup
        selected={props.filters.cli}
        onToggle={(cli, checked) => {
          props.setFilters(prev => {
            const next = new Set(prev.cli);
            if (checked) next.add(cli);
            else next.delete(cli);
            return { ...prev, cli: next };
          });
        }}
      />
      <label className="filter-toggle">
        <input
          type="checkbox"
          name="showUnknownChats"
          checked={props.filters.showUnknownChats}
          onChange={event => {
            const checked = event.currentTarget.checked;
            writeStoredSessionsShowUnknownChats(windowStorage(), checked);
            props.setFilters(prev => ({ ...prev, showUnknownChats: checked }));
          }}
        />
        <span className="filter-toggle-label">{t('sessions.showUnknownChats')}</span>
        <span className="filter-toggle-switch" aria-hidden="true" />
      </label>
      <label className="filter-toggle">
        <input
          type="checkbox"
          name="active"
          checked={props.filters.active}
          onChange={event => {
            const active = event.currentTarget.checked;
            props.setFilters(prev => ({ ...prev, active }));
          }}
        />
        <span className="filter-toggle-label">{t('sessions.activeOnly')}</span>
        <span className="filter-toggle-switch" aria-hidden="true" />
      </label>
      <IdleCleanupBar {...props.idleCleanup} />
    </form>
  );
}

function BulkBar(props: {
  selectedCount: number;
  lockDisabled: boolean;
  unlockDisabled: boolean;
  closeProgress: { done: number; total: number } | null;
  lockProgress: { locked: boolean; done: number; total: number } | null;
  monitorRoomText: string | null;
  onClear: () => void;
  onClose: () => void;
  onAddToMonitorRoom: () => void;
  onLock: (locked: boolean) => void;
}): JSX.Element {
  const busy = !!props.closeProgress || !!props.lockProgress;
  const lockText = props.lockProgress?.locked ? `${props.lockProgress.done}/${props.lockProgress.total}` : t('sessions.lockSelected');
  const unlockText = props.lockProgress && !props.lockProgress.locked ? `${props.lockProgress.done}/${props.lockProgress.total}` : t('sessions.unlockSelected');
  return (
    <div id="bulk-bar" className="bulk-bar" hidden={props.selectedCount === 0}>
      <span id="bulk-count">{t('sessions.selectedCount', { count: props.selectedCount })}</span>
      <button type="button" id="bulk-monitor-room" disabled={busy || props.selectedCount === 0} onClick={props.onAddToMonitorRoom}>
        {props.monitorRoomText ?? t('sessions.addToMonitorRoom')}
      </button>
      <button type="button" id="bulk-lock" disabled={busy || props.lockDisabled} onClick={() => props.onLock(true)}>{lockText}</button>
      <button type="button" id="bulk-unlock" disabled={busy || props.unlockDisabled} onClick={() => props.onLock(false)}>{unlockText}</button>
      <button type="button" id="bulk-close" className="contrast" disabled={busy} onClick={props.onClose}>
        {props.closeProgress ? `${props.closeProgress.done}/${props.closeProgress.total}` : t('sessions.closeSelected')}
      </button>
      <button type="button" id="bulk-clear" disabled={busy} onClick={props.onClear}>{t('sessions.clearSelection')}</button>
    </div>
  );
}

function IdleCleanupBar(props: IdleCleanupBarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draftHours, setDraftHours] = useState<IdleCleanupHours>(props.hours);
  const [popStyle, setPopStyle] = useState<CSSProperties | undefined>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const count = props.countForHours(draftHours);

  useEffect(() => {
    if (open) setDraftHours(props.hours);
    else setPopStyle(undefined);
  }, [open, props.hours]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const button = buttonRef.current;
      const pop = popRef.current;
      if (!button || !pop) return;
      const margin = 12;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.max(0, Math.min(292, viewportWidth - margin * 2));
      const buttonRect = button.getBoundingClientRect();
      const height = pop.offsetHeight;
      const maxLeft = Math.max(margin, viewportWidth - width - margin);
      const centeredLeft = buttonRect.left + buttonRect.width / 2 - width / 2;
      const left = Math.min(Math.max(centeredLeft, margin), maxLeft);
      const belowTop = buttonRect.bottom + 8;
      const aboveTop = buttonRect.top - height - 8;
      const top = belowTop + height <= viewportHeight - margin || aboveTop < margin
        ? Math.min(Math.max(belowTop, margin), Math.max(margin, viewportHeight - height - margin))
        : Math.max(margin, aboveTop);
      setPopStyle({ left, top, width });
    };
    const frame = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, props.busy, props.status]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      if (target instanceof Node && popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
    <div
      id="idle-cleanup-bar"
      className={`idle-cleanup-bar${count === 0 ? ' is-empty' : ''}${open ? ' is-open' : ''}`}
      ref={rootRef}
    >
      <button
        ref={buttonRef}
        type="button"
        id="idle-cleanup-run"
        className="contrast idle-cleanup-run"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen(value => !value)}
      >
        <svg className="idle-cleanup-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 6.5h17" />
          <path d="M9 3.5h6" />
          <path d="m6.5 6.5.9 13h9.2l.9-13" />
          <path d="M10 10.5v5M14 10.5v5" />
        </svg>
        <span>{t('sessions.idleCleanupRun')}</span>
      </button>
      {open && typeof document !== 'undefined' ? createPortal((
        <div
          ref={popRef}
          className="idle-cleanup-pop"
          role="dialog"
          aria-label={t('sessions.idleCleanupRun')}
          style={popStyle ?? { visibility: 'hidden' }}
        >
          <div className="idle-cleanup-pop-head">
            <span className="idle-cleanup-pop-title">{t('sessions.idleCleanupRun')}</span>
            <span id="idle-cleanup-count" className="idle-cleanup-count">
              <span className="idle-cleanup-dot" aria-hidden="true" />
              {t('sessions.idleCleanupCount', { count })}
            </span>
          </div>
          <div className="idle-cleanup-pop-field">
            <span className="idle-cleanup-label">{t('sessions.idleCleanupOlderThan')}</span>
            <div
              id="idle-cleanup-threshold"
              className="idle-cleanup-threshold-options"
              role="radiogroup"
              aria-label={t('sessions.idleCleanupThreshold')}
            >
              {idleCleanupThresholdOptions.map(option => {
                const hours = parseIdleCleanupHours(option.value)!;
                const active = hours === draftHours;
                return (
                  <button
                    type="button"
                    key={option.value}
                    className={active ? 'active' : undefined}
                    aria-pressed={active ? 'true' : 'false'}
                    disabled={props.busy}
                    onClick={() => setDraftHours(hours)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          {props.busy && props.status ? (
            <span id="idle-cleanup-status" className="idle-cleanup-status" aria-live="polite">{props.status}</span>
          ) : null}
          <div className="idle-cleanup-pop-actions">
            <button type="button" className="idle-cleanup-cancel" disabled={props.busy} onClick={() => setOpen(false)}>
              {t('sessions.idleCleanupCancel')}
            </button>
            <button
              type="button"
              className="idle-cleanup-confirm"
              disabled={props.busy || count === 0}
              onClick={() => {
                void props.onRun(draftHours).then(() => setOpen(false));
              }}
            >
              {t('sessions.idleCleanupApply')}
            </button>
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}

function SessionsTable(props: {
  rows: any[];
  selected: Set<string>;
  hidden: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  selectAllChecked: boolean;
  selectAllIndeterminate: boolean;
  selectAllDisabled: boolean;
  onOpen: (row: any) => void;
  onSelect: (id: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onSort: (key: string) => void;
}): JSX.Element {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = props.selectAllIndeterminate;
  }, [props.selectAllIndeterminate]);

  const headers = [
    ['botName', t('sessions.bot')],
    ['cliId', t('sessions.cli')],
    ['status', t('sessions.status')],
    ['chat', t('sessions.location')],
    ['tokenIn', t('sessions.tokenIn')],
    ['tokenOut', t('sessions.tokenOut')],
    ['title', t('sessions.titleCol')],
    ['workingDir', t('sessions.workingDir')],
    ['spawnedAt', t('sessions.created')],
    ['lastMessageAt', t('sessions.last')],
    ['adopt', t('sessions.adopt')],
  ] as const;
  const labels = {
    select: t('sessions.selectSession'),
    botName: t('sessions.bot'),
    cliId: t('sessions.cli'),
    status: t('sessions.status'),
    chat: t('sessions.location'),
    tokenIn: t('sessions.tokenIn'),
    tokenOut: t('sessions.tokenOut'),
    title: t('sessions.titleCol'),
    workingDir: t('sessions.workingDir'),
    spawnedAt: t('sessions.created'),
    lastMessageAt: t('sessions.last'),
    adopt: t('sessions.adopt'),
    actions: t('sessions.actions'),
  };

  return (
    <table id="sessions-table" hidden={props.hidden}>
      <thead>
        <tr>
          <th>
            <input
              ref={selectAllRef}
              type="checkbox"
              id="select-all"
              title={t('sessions.activeOnly')}
              checked={props.selectAllChecked}
              disabled={props.selectAllDisabled}
              onChange={event => props.onSelectAll(event.currentTarget.checked)}
            />
          </th>
          {headers.map(([sort, label]) => (
            <SortHeader key={sort} sort={sort} label={label} sortKey={props.sortKey} sortDir={props.sortDir} onSort={props.onSort} />
          ))}
          <th>{t('sessions.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length ? props.rows.map(row => {
          const closed = row.status === 'closed';
          const id = String(row.sessionId);
          return (
            <tr key={id} data-id={id} onClick={() => props.onOpen(row)}>
              <td className="sessions-table-select-cell" data-label={labels.select} onClick={event => event.stopPropagation()}>
                <input
                  type="checkbox"
                  className="row-select"
                  checked={props.selected.has(id)}
                  disabled={closed}
                  onChange={event => props.onSelect(id, event.currentTarget.checked)}
                />
              </td>
              <td data-label={labels.botName}>{botDisplayName(row)}</td>
              <td data-label={labels.cliId}><span className={`badge cli-${cssToken(row.cliId)}`}>{row.cliId ?? 'unknown'}</span></td>
              <td data-label={labels.status}><StatusBadge status={row.status} /><LockChip row={row} /></td>
              <td className="session-location-cell" data-label={labels.chat} title={sessionLocationTitle(row)}>{sessionLocationText(row)}</td>
              <td className="token-cell" data-label={labels.tokenIn}>{formatTokenCount(row.tokenUsage?.in)}</td>
              <td className="token-cell" data-label={labels.tokenOut}>{formatTokenCount(row.tokenUsage?.out)}</td>
              <td className="sessions-table-text-cell" data-label={labels.title} title={String(row.title ?? '')}>{stripMentionPrefix(row.title ?? '').slice(0, 48)}</td>
              <td className="sessions-table-path-cell" data-label={labels.workingDir} title={row.workingDir ?? ''}>{String(row.workingDir ?? '').slice(-34)}</td>
              <td data-label={labels.spawnedAt}>{relTime(row.spawnedAt)}</td>
              <td data-label={labels.lastMessageAt}>{relTime(row.lastMessageAt)}</td>
              <td data-label={labels.adopt}>{row.adopt ? <span className="badge">adopt</span> : null}</td>
              <td className="sessions-table-action-cell" data-label={labels.actions}><button className="open" type="button">{t('sessions.details')}</button></td>
            </tr>
          );
        }) : (
          <tr><td colSpan={13} className="empty">{t('sessions.empty')}</td></tr>
        )}
      </tbody>
    </table>
  );
}

function BoardCard(props: {
  row: any;
  selected: boolean;
  onToggleSelect: (row: any) => void;
  onOpen: (row: any) => void;
  onHistory: (row: any) => void;
  onLocate: (row: any) => Promise<boolean>;
  onRestart: (row: any, button?: HTMLButtonElement) => void;
  onLock: (row: any, locked: boolean, button?: HTMLButtonElement) => void;
  onClose: (row: any, button?: HTMLButtonElement) => void;
}): JSX.Element {
  const row = props.row;
  const title = stripMentionPrefix(row.title) || row.sessionId;
  const botName = botDisplayName(row);
  const chatTitle = chatDisplayTitle(row);
  const term = terminalHref(row);
  const signal = boardSignalLabel(row);
  const repo = repoBasename(row.workingDir);
  const onCardClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, label')) return;
    props.onToggleSelect(row);
  };
  return (
    <article
      className={`session-card${props.selected ? ' selected' : ''}${row.locked ? ' locked' : ''}`}
      data-id={row.sessionId}
      aria-pressed={props.selected}
      onClick={onCardClick}
    >
      <div className="session-card-top">
        <span dangerouslySetInnerHTML={rawHtml(botAvatarHtml({ name: botName, larkAppId: row.larkAppId, size: 'sm' }))} />
        <div className="session-card-title">
          <strong title={String(row.title ?? title)}>{String(title).slice(0, 72)}</strong>
          <span>{botName} · {chatTitle ?? row.cliId ?? 'unknown'}</span>
        </div>
        <span className="session-card-status-group">
          <StatusBadge status={row.status} />
          <LockChip row={row} />
        </span>
      </div>
      {repo !== '-' || row.adopt || signal ? (
        <div className="session-card-meta">
          {repo !== '-' ? <span title={row.workingDir ?? ''}>{repo}</span> : null}
          {row.adopt ? <span className="badge">adopt</span> : null}
          {signal ? <span className="session-signal" title={signal}>{signal}</span> : null}
        </div>
      ) : null}
      <div className="session-card-time">
        <span>{row.agentAttention?.at
          ? `${t('sessions.board.waiting')} ${relTime(attentionWaitSince(row))}`
          : `${t('sessions.last')}: ${relTime(row.lastMessageAt)}`}</span>
      </div>
      <div className="session-card-actions">
        <ChatScopeLink row={row} />
        {!row.feishuChatLink || row.scope !== 'chat' ? (
          <LocateIconButton row={row} onLocate={props.onLocate} />
        ) : null}
        <IconActionButton action="details" icon={ICON.details} label={t('sessions.details')} onClick={() => props.onOpen(row)} />
        {canRestartSession(row) ? (
          <IconActionButton action="restart" icon={ICON.restart} label={t('sessions.restart')} onClick={button => props.onRestart(row, button)} />
        ) : null}
        <TerminalControls row={row} url={term} />
        <IconActionButton
          action="lock"
          icon={row.locked ? ICON.unlock : ICON.lock}
          label={lockActionLabel(row)}
          kind={row.locked ? 'locked' : ''}
          onClick={button => props.onLock(row, !row.locked, button)}
        />
        <IconActionButton action="close" icon={ICON.close} label={t('sessions.close')} kind="danger" onClick={button => props.onClose(row, button)} />
      </div>
    </article>
  );
}

function BoardView(props: {
  rows: any[];
  selected: Set<string>;
  hidden: boolean;
  order: string[];
  animated: boolean;
  dragColId: string | null;
  dragOverCol: string | null;
  onAnimated: () => void;
  onMoveColumn: (id: string, delta: number) => void;
  onMoveColumnTo: (id: string, targetId: string) => void;
  onDragCol: (id: string | null) => void;
  onDragOverCol: (id: string | null) => void;
  onToggleSelect: (row: any) => void;
  onOpen: (row: any) => void;
  onHistory: (row: any) => void;
  onLocate: (row: any) => Promise<boolean>;
  onRestart: (row: any, button?: HTMLButtonElement) => void;
  onLock: (row: any, locked: boolean, button?: HTMLButtonElement) => void;
  onClose: (row: any, button?: HTMLButtonElement) => void;
}): JSX.Element {
  useEffect(() => {
    if (!props.hidden && !props.animated) props.onAnimated();
  }, [props.animated, props.hidden, props.onAnimated]);
  const groups = new Map<BoardColumnId, any[]>(BOARD_COLUMNS.map(column => [column.id, []]));
  for (const row of props.rows) {
    const column = deriveSessionBoardColumn(row);
    if (column) groups.get(column)!.push(row);
  }
  const columns = props.order
    .map(id => BOARD_COLUMNS.find(column => column.id === id))
    .filter((column): column is typeof BOARD_COLUMNS[number] => !!column);
  return (
    <div id="sessions-board" className={`sessions-board${props.animated || props.hidden ? '' : ' board-enter'}`} hidden={props.hidden}>
      {columns.map((column, idx) => {
        const columnRows = (groups.get(column.id) ?? []).sort((a, b) => compareBoardRows(a, b, column.id));
        return (
          <section
            key={column.id}
            className={`session-board-column session-board-${column.id}${props.dragColId === column.id ? ' dragging' : ''}${props.dragOverCol === column.id ? ' drag-over' : ''}`}
            data-col={column.id}
            onDragOver={(event) => {
              if (!props.dragColId) return;
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
              if (props.dragColId !== column.id) props.onDragOverCol(column.id);
            }}
            onDrop={(event) => {
              if (!props.dragColId) return;
              event.preventDefault();
              props.onMoveColumnTo(props.dragColId, column.id);
              props.onDragCol(null);
              props.onDragOverCol(null);
            }}
          >
            <header
              draggable
              title={t('sessions.board.dragHint')}
              onDragStart={(event: DragEvent<HTMLElement>) => {
                props.onDragCol(column.id);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', column.id);
                }
              }}
              onDragEnd={() => {
                props.onDragCol(null);
                props.onDragOverCol(null);
              }}
            >
              <div>
                <h2>{t(column.labelKey)}</h2>
                <p>{t(column.hintKey)}</p>
              </div>
              <span className="session-board-head-right">
                <span className="session-board-move">
                  <button
                    type="button"
                    data-move-col={column.id}
                    data-dir="-1"
                    aria-label={t('sessions.board.moveLeft')}
                    disabled={idx === 0}
                    onClick={() => props.onMoveColumn(column.id, -1)}
                  >‹</button>
                  <button
                    type="button"
                    data-move-col={column.id}
                    data-dir="1"
                    aria-label={t('sessions.board.moveRight')}
                    disabled={idx === columns.length - 1}
                    onClick={() => props.onMoveColumn(column.id, 1)}
                  >›</button>
                </span>
                <span className="session-board-count">{columnRows.length}</span>
              </span>
            </header>
            <div className="session-board-list">
              {columnRows.length ? columnRows.map(row => (
                <BoardCard
                  key={row.sessionId}
                  row={row}
                  selected={props.selected.has(row.sessionId)}
                  onToggleSelect={props.onToggleSelect}
                  onOpen={props.onOpen}
                  onHistory={props.onHistory}
                  onLocate={props.onLocate}
                  onRestart={props.onRestart}
                  onLock={props.onLock}
                  onClose={props.onClose}
                />
              )) : <div className="session-board-empty">{t('sessions.board.emptyColumn')}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function HistoryBubble(props: { message: any; ownerOpenId?: string; groupStart: boolean }): JSX.Element {
  const m = props.message;
  const human = m.senderType === 'user';
  const botSender = m.senderType === 'app' || m.senderType === 'bot';
  const name = human
    ? (m.senderName || (props.ownerOpenId && m.senderId === props.ownerOpenId ? t('sessions.history.owner') : t('sessions.history.user')))
    : (m.senderName || String(m.senderId ?? '').slice(0, 16) || t(botSender ? 'sessions.history.bot' : 'sessions.history.system'));
  const content = String(m.content ?? '').trim() || `[${m.msgType ?? 'message'}]`;
  return (
    <div className={`history-msg${props.groupStart ? ' group-start' : ' continuation'}`}>
      {props.groupStart ? (human ? (
        m.senderAvatar ? (
          <img className="history-avatar-img" src={String(m.senderAvatar)} alt="" decoding="async" referrerPolicy="no-referrer" />
        ) : <span className="history-avatar-user" aria-hidden="true">{String(name).slice(0, 1)}</span>
      ) : <span className="history-avatar-bot" dangerouslySetInnerHTML={rawHtml(botAvatarHtml({ name, larkAppId: m.senderBotAppId, avatarUrl: m.senderAvatar, size: 'sm' }))} />) : <span className="history-avatar-spacer" aria-hidden="true" />}
      <div className="history-msg-main">
        {props.groupStart ? <div className="history-msg-meta"><span>{name}</span><time>{historyTime(m.createTime)}</time></div> : null}
        <div className="history-bubble">{content}</div>
      </div>
    </div>
  );
}

function HistoryModal(props: { state: HistoryState | null; onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useDialogVisibility(dialogRef, !!props.state);
  const row = props.state ? store.sessions.get(props.state.sessionId) : null;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const loaded = !!props.state && !props.state.loading && !props.state.error && props.state.messages.length > 0;
  // Open pinned to the newest message (old imperative code did scrollTop = scrollHeight).
  useEffect(() => {
    if (!loaded) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [loaded, props.state?.sessionId, props.state?.messages.length]);
  return (
    <dialog
      id="history-modal"
      className="history-modal"
      ref={dialogRef}
      onClose={props.onClose}
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      {props.state && row ? (
        <>
          <div className="term-modal-head">
            <span className="term-modal-title">
              <span dangerouslySetInnerHTML={rawHtml(botAvatarHtml({ name: botDisplayName(row), larkAppId: row.larkAppId, size: 'sm' }))} />
              <strong title={String(row.title ?? '')}>{(stripMentionPrefix(row.title) || row.sessionId).slice(0, 60)}</strong>
              <span className="history-scope-tag">{t('sessions.history.title')}</span>
            </span>
            <span className="term-modal-actions">
              <IconActionButton id="history-close" icon={ICON.close} label={t('sessions.dismiss')} onClick={props.onClose} />
            </span>
          </div>
          <div className="history-body" ref={bodyRef}>
            {props.state.loading ? <LoadingState label={t('sessions.history.loading')} className="term-modal-loading" compact /> : null}
            {!props.state.loading && props.state.error ? (
              <div className="history-error">
                {t('sessions.history.fail')}: {props.state.error}
                {props.state.stale ? <><br /><span>{t('sessions.history.staleHint')}</span></> : null}
              </div>
            ) : null}
            {!props.state.loading && !props.state.error && props.state.messages.length === 0 ? (
              <div className="history-error">{t('sessions.history.empty')}</div>
            ) : null}
            {!props.state.loading && !props.state.error && props.state.messages.length > 0 ? (
              <div className="history-list">
                {props.state.messages.map((message, index, messages) => (
                  <HistoryBubble
                    key={message.messageId ?? index}
                    message={message}
                    ownerOpenId={props.state?.ownerOpenId}
                    groupStart={index === 0 || historySenderKey(messages[index - 1]) !== historySenderKey(message)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

function TerminalNameEditor(props: { row: any; onRename: (row: any, title: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const title = stripMentionPrefix(props.row.title) || props.row.sessionId;

  useLayoutEffect(() => {
    if (!editing || !inputRef.current) return;
    const input = inputRef.current;
    input.focus();
    input.select();
    const fit = () => {
      const cs = getComputedStyle(input);
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      span.style.fontSize = cs.fontSize;
      span.style.fontFamily = cs.fontFamily;
      span.style.fontWeight = cs.fontWeight;
      span.style.letterSpacing = cs.letterSpacing;
      span.textContent = input.value || ' ';
      document.body.appendChild(span);
      const max = Math.round(window.innerWidth * 0.6);
      input.style.width = `${Math.min(Math.max(span.offsetWidth + 22, 80), max)}px`;
      span.remove();
    };
    fit();
  }, [editing, value]);

  const finish = (commit: boolean) => {
    const next = value.trim();
    setEditing(false);
    if (commit && next && next !== title) props.onRename(props.row, next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="term-modal-name-input"
        maxLength={200}
        value={value}
        onChange={event => setValue(event.currentTarget.value)}
        onBlur={() => finish(true)}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); finish(true); }
          else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        }}
      />
    );
  }
  return (
    <>
      <strong className="term-modal-name" title={String(props.row.title ?? title)}>{String(title).slice(0, 60)}</strong>
      <IconActionButton
        id="term-modal-edit"
        icon={ICON.edit}
        label={t('sessions.kanban.rename')}
        onClick={() => {
          setValue(stripMentionPrefix(props.row.title) || '');
          setEditing(true);
        }}
      />
    </>
  );
}

function TerminalModal(props: { state: TerminalState | null; onClose: () => void; onRename: (row: any, title: string) => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useDialogVisibility(dialogRef, !!props.state);
  const row = props.state ? store.sessions.get(props.state.sessionId) : null;
  const readonlyUrl = row ? terminalHref(row) : null;
  const url = props.state?.url ?? readonlyUrl ?? '';
  const rowCli = row ? String(row.cliId ?? 'unknown') : '';
  const rowRepo = row ? repoBasename(row.workingDir) : '';
  return (
    <dialog
      id="term-modal"
      className="term-modal"
      ref={dialogRef}
      onClose={props.onClose}
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      {props.state && row ? (
        <>
          <div className="term-modal-head">
            <span className="term-modal-title">
              <span dangerouslySetInnerHTML={rawHtml(botAvatarHtml({ name: botDisplayName(row), larkAppId: row.larkAppId, size: 'sm' }))} />
              <span className="term-modal-title-copy">
                <span className="term-modal-title-main">
                  <TerminalNameEditor row={row} onRename={props.onRename} />
                  <StatusBadge status={row.status} />
                </span>
                <span className="term-modal-subtitle">
                  <span>{botDisplayName(row)}</span>
                  <span>{rowCli}</span>
                  {rowRepo !== '-' ? <span title={row.workingDir ?? ''}>{rowRepo}</span> : null}
                </span>
              </span>
            </span>
            <span className="term-modal-actions">
              {row.feishuChatLink ? (
                <a
                  className="card-act"
                  href={row.feishuChatLink}
                  target="_blank"
                  rel="noopener"
                  title={t('sessions.kanban.openFeishu')}
                  aria-label={t('sessions.kanban.openFeishu')}
                  dangerouslySetInnerHTML={rawHtml(ICON.feishu)}
                />
              ) : null}
              <a
                id="term-modal-tab"
                className="card-act"
                href={url}
                target="_blank"
                rel="noopener"
                title={t('sessions.kanban.openTab')}
                aria-label={t('sessions.kanban.openTab')}
                dangerouslySetInnerHTML={rawHtml(ICON.terminal)}
              />
              <IconActionButton id="term-modal-close" icon={ICON.close} label={t('sessions.dismiss')} onClick={props.onClose} />
            </span>
          </div>
          <div className="term-modal-body">
            <div className="term-modal-frame-shell">
              {props.state.loading ? <LoadingState label={t('sessions.kanban.terminalLoading')} className="term-modal-loading" compact /> : (
                <iframe className="term-modal-frame" src={url} allow="clipboard-read; clipboard-write" />
              )}
            </div>
          </div>
        </>
      ) : null}
    </dialog>
  );
}

function LandPanel(props: { row: any }): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; diff?: any; patch?: string; message?: ReactNode } | null>(null);
  useEffect(() => setState(null), [props.row.sessionId]);
  const load = async () => {
    setState({ loading: true });
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(props.row.sessionId)}/sandbox-diff`);
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { setState({ loading: false, message: <p>{t('sessions.landUnavailable')}: {String(d.error ?? r.status)}</p> }); return; }
      if (d.empty) { setState({ loading: false, message: <p>{t('sessions.landEmpty')}</p> }); return; }
      const full = String(d.patch ?? '');
      setState({
        loading: false,
        diff: d,
        patch: full.slice(0, 20000) + (full.length > 20000 ? '\n...(truncated)' : ''),
      });
    } catch (e) {
      setState({ loading: false, message: <p>{t('sessions.landUnavailable')}: {String(e)}</p> });
    }
  };
  const apply = async () => {
    const rr = await fetch(`/api/sessions/${encodeURIComponent(props.row.sessionId)}/sandbox-land/apply`, { method: 'POST' });
    const res = await rr.json().catch(() => ({}));
    setState({
      loading: false,
      message: res.ok
        ? <p>{t('sessions.landApplied')}: {res.files} files (+{res.insertions}/-{res.deletions}) → <code>{String(res.workingDir ?? '')}</code></p>
        : <p>{t('sessions.landFailed')}: {String(res.error ?? rr.status)}</p>,
    });
  };
  const discard = async () => {
    await fetch(`/api/sessions/${encodeURIComponent(props.row.sessionId)}/sandbox-land/discard`, { method: 'POST' });
    setState({ loading: false, message: <p>{t('sessions.landDiscarded')}</p> });
  };
  return (
    <>
      <button id="land-btn" type="button" disabled={state?.loading} onClick={() => void load()}>{t('sessions.land')}</button>
      <div id="land-area">
        {state?.loading ? <LoadingState label={t('sessions.landLoading')} compact /> : null}
        {state?.message}
        {state?.diff && state.patch !== undefined ? (
          <>
            <p><b>{state.diff.files}</b> files (+{state.diff.insertions}/-{state.diff.deletions}) → <code>{String(state.diff.workingDir ?? '')}</code></p>
            <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{state.patch}</pre>
            <div className="actions">
              <button id="land-apply" type="button" className="primary" onClick={() => void apply()}>{t('sessions.landApply')}</button>
              <button id="land-discard" type="button" className="contrast" onClick={() => void discard()}>{t('sessions.landDiscard')}</button>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function InsightReport(props: { report: any }): JSX.Element {
  const rep = props.report;
  if (!rep || rep.status !== 'ok') {
    const msg = rep?.error?.message ? String(rep.error.message) : String(rep?.status ?? 'error');
    return <p>{t('sessions.insightUnavailable')}: {msg}</p>;
  }
  const a = rep.agg ?? {};
  if (!a.totalSpans) return <p>{t('sessions.insightEmpty')}</p>;
  const metaBits = [
    rep.meta?.asOf ? t('sessions.insightAsOf', { asOf: String(rep.meta.asOf) }) : null,
    rep.meta?.partial ? t('sessions.insightPartial') : null,
  ].filter(Boolean);
  const suggestions = Array.isArray(rep.suggestions) ? rep.suggestions : [];
  const spans = Array.isArray(rep.spans) ? rep.spans : [];
  const suggestionIcon = (sev: string) => (sev === 'bad' ? '!' : sev === 'warn' ? '!' : 'i');
  const spanIcon = (status: string) => (status === 'error' ? '!' : status === 'running' ? '...' : 'ok');
  return (
    <>
      {metaBits.length ? <p style={{ fontSize: 12, color: 'var(--muted,#8f959e)' }}>{metaBits.join(' · ')}</p> : null}
      <p>{t('sessions.insightMetrics', {
        total: String(a.totalSpans ?? 0),
        failed: String(a.failedSpans ?? 0),
        slow: String(a.slowSpans ?? 0),
        rw: (a.readWriteRatio === null || a.readWriteRatio === undefined) ? '-' : String(a.readWriteRatio),
        compactions: String(a.compactions ?? 0),
      })}</p>
      {suggestions.length ? (
        <details open>
          <summary>{t('sessions.insightSuggestions')}</summary>
          <ul style={{ paddingLeft: 18, margin: '6px 0' }}>
            {suggestions.map((sg: any, index: number) => (
              <li key={index}>
                {suggestionIcon(String(sg.severity ?? ''))} <b>{String(sg.title ?? '')}</b> - {String(sg.action ?? '')}
                {Array.isArray(sg.evidence) && sg.evidence.length ? (
                  <><br /><small style={{ color: 'var(--muted,#8f959e)' }}>{sg.evidence.join('; ')}</small></>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {spans.length ? (
        <details>
          <summary>{t('sessions.insightSpans')} ({spans.length})</summary>
          {rep.meta?.capped ? (
            <p style={{ fontSize: 12, color: 'var(--muted,#8f959e)' }}>
              {t('sessions.insightCapped', { shown: String(rep.meta.spansReturned ?? spans.length), total: String(rep.meta.spansTotal ?? spans.length) })}
            </p>
          ) : null}
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12 }}>
              <tbody>
                {[...spans].sort((x: any, y: any) => (x.relStartMs ?? 0) - (y.relStartMs ?? 0)).map((sp: any, index: number) => {
                  const io = [sp.inputSummary, sp.outputSummary].filter(Boolean).map(String).join(' -> ');
                  return (
                    <tr key={index} style={sp.status === 'error' ? { color: 'var(--danger,#d33)' } : undefined}>
                      <td>{spanIcon(String(sp.status ?? ''))}</td>
                      <td><code>{String(sp.tool ?? '')}</code></td>
                      <td>{String(sp.phase ?? '')}</td>
                      <td>{insightDur(sp.durationMs)}</td>
                      <td>#{String(sp.turnIndex ?? 0)}</td>
                      <td>{io}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </>
  );
}

function InsightPanel(props: { row: any }): JSX.Element | null {
  const [state, setState] = useState<{ loading: boolean; report?: any; error?: string } | null>(null);
  useEffect(() => setState(null), [props.row.sessionId]);
  if (!ui.authed) return null;
  const load = async () => {
    setState({ loading: true });
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(props.row.sessionId)}/insight?detail=spans`);
      const d = await r.json().catch(() => ({}));
      if (!d.ok || !d.report) setState({ loading: false, error: String(d.error ?? r.status) });
      else setState({ loading: false, report: d.report });
    } catch (e) {
      setState({ loading: false, error: String(e) });
    }
  };
  return (
    <>
      <button id="insight-btn" type="button" disabled={state?.loading} onClick={() => void load()}>{t('sessions.insight')}</button>
      <div id="insight-area">
        {state?.loading ? <LoadingState label={t('sessions.insightLoading')} compact /> : null}
        {state?.error ? <p>{t('sessions.insightUnavailable')}: {state.error}</p> : null}
        {state?.report ? <InsightReport report={state.report} /> : null}
      </div>
    </>
  );
}

function Drawer(props: {
  row: any | null;
  onClose: () => void;
  locateSession: (row: any) => Promise<boolean>;
  openHistory: (row: any) => void;
  resumeSession: (row: any, button?: HTMLButtonElement) => Promise<boolean>;
  restartSession: (row: any, button?: HTMLButtonElement) => Promise<boolean>;
  closeSession: (row: any, button?: HTMLButtonElement) => Promise<boolean>;
  setSessionLocked: (row: any, locked: boolean, button?: HTMLButtonElement) => Promise<boolean>;
  startSession: (row: any, button?: HTMLButtonElement) => Promise<boolean>;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useDialogVisibility(dialogRef, !!props.row);
  const row = props.row;
  const terminal = row ? terminalHref(row) : null;
  return (
    <dialog
      id="drawer"
      ref={dialogRef}
      onClose={props.onClose}
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      {row ? (
        <article>
          <header>
            <div className="drawer-title-row">
              <h3>{stripMentionPrefix(row.title) || row.sessionId}</h3>
              <IconActionButton id="drawer-close" className="card-act drawer-close-btn" icon={ICON.close} label={t('sessions.dismiss')} onClick={props.onClose} />
            </div>
            <span className="drawer-status-line">
              <StatusBadge status={row.status} />
              <LockChip row={row} />
            </span>
            <p><code>{row.sessionId}</code> <CopyButton value={row.sessionId} /></p>
          </header>
          <p><b>{t('sessions.bot')}:</b> {botDisplayName(row)} · <b>{t('sessions.cli')}:</b> {row.cliId ?? '?'}</p>
          <p><b>{t('sessions.location')}:</b> {sessionLocationText(row)}</p>
          <p><b>chatId:</b> <code>{row.chatId ?? ''}</code> <CopyButton value={row.chatId ?? ''} /></p>
          <p><b>rootMessageId:</b> <code>{row.rootMessageId ?? ''}</code> <CopyButton value={row.rootMessageId ?? ''} /></p>
          {row.threadId ? <p><b>threadId:</b> <code>{row.threadId}</code></p> : null}
          <p><b>{t('sessions.workingDir')}:</b> {row.workingDir ?? '-'}</p>
          <div className="actions">
            <ChatScopeLink row={row} />
            {!row.feishuChatLink || row.scope !== 'chat' ? <LocateButton row={row} locateSession={props.locateSession} /> : null}
            <button id="history-drawer-btn" type="button" onClick={() => props.openHistory(row)}>{t('sessions.history.title')}</button>
            <TerminalControls row={row} url={terminal} />
            {canRestartSession(row) ? (
              <button id="restart-btn" type="button" onClick={async event => { if (await props.restartSession(row, event.currentTarget)) props.onClose(); }}>{t('sessions.restart')}</button>
            ) : null}
            {row.status !== 'closed' ? (
              <button id="lock-btn" type="button" onClick={event => void props.setSessionLocked(row, !row.locked, event.currentTarget)}>{lockActionLabel(row)}</button>
            ) : null}
            {row.queued && row.status !== 'closed' ? (
              <button id="start-btn" type="button" className="primary" onClick={async event => { if (await props.startSession(row, event.currentTarget)) props.onClose(); }}>{t('sessions.create.start')}</button>
            ) : null}
            {row.status === 'closed' ? (
              <button id="resume-btn" type="button" className="primary" onClick={async event => { if (await props.resumeSession(row, event.currentTarget)) props.onClose(); }}>{t('sessions.resume')}</button>
            ) : null}
            {row.status !== 'closed' ? (
              <button id="close-btn" type="button" className="contrast" onClick={async event => { if (await props.closeSession(row, event.currentTarget)) props.onClose(); }}>{t('sessions.close')}</button>
            ) : null}
            <LandPanel row={row} />
            <InsightPanel row={row} />
          </div>
        </article>
      ) : null}
    </dialog>
  );
}

function CreateSessionDialog(props: {
  dialog: HTMLDialogElement;
  state: CreateSessionState | null;
  onClose: () => void;
  onSuccess: (body: any) => void;
}): JSX.Element | null {
  const state = props.state;
  useEffect(() => {
    const dialog = props.dialog;
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [props.dialog]);

  useEffect(() => {
    const dialog = props.dialog;
    if (state) {
      if (!dialog.open) {
        try { dialog.showModal(); } catch { /* already open */ }
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [props.dialog, state]);
  useEffect(() => {
    const dialog = props.dialog;
    const handleClose = () => props.onClose();
    const handleClick = (event: MouseEvent | globalThis.MouseEvent) => {
      if (event.target === dialog) props.onClose();
    };
    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('click', handleClick);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('click', handleClick);
    };
  }, [props]);

  const [content, setContent] = useState('');
  const [selectedBots, setSelectedBots] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'lead' | 'all'>('lead');
  const [lead, setLead] = useState('');
  const [column, setColumn] = useState<'in_progress' | 'backlog'>('in_progress');
  const [name, setName] = useState('');
  const [bindWorkingDir, setBindWorkingDir] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [botQuery, setBotQuery] = useState('');
  const [keepOpen, setKeepOpen] = useState(() => readStoredCreateKeepOpen(windowStorage()));
  const [keptSuccess, setKeptSuccess] = useState<any>(null);

  useEffect(() => {
    if (!state) return;
    setContent('');
    setSelectedBots(new Set());
    setMode('lead');
    setLead('');
    setColumn('in_progress');
    setName('');
    setBindWorkingDir('');
    setAdvancedOpen(false);
    setSubmitting(false);
    setBotQuery('');
    setKeptSuccess(null);
  }, [state]);

  if (!state) return null;
  if (state.success) {
    const body = state.success;
    const link = typeof body.shareLink === 'string' && body.shareLink ? body.shareLink : '';
    const failedN = Array.isArray(body.failed) ? body.failed.length : 0;
    const spawnedN = Array.isArray(body.spawned) ? body.spawned.length : 0;
    const colNote = body.column === 'backlog' ? t('sessions.create.doneBacklog') : t('sessions.create.doneInProgress');
    return (
      <article className="cs-card">
        <header className="cs-header"><h3>{t('sessions.create.doneTitle')}</h3></header>
        <p>{colNote}（{spawnedN}）</p>
        {failedN > 0 ? <p className="cs-warn">{t('sessions.create.partialFail', { n: String(failedN) })}</p> : null}
        {link ? <p><a href={link} target="_blank" rel="noopener">{t('sessions.create.openChat')}</a></p> : null}
        <div className="actions"><button type="button" id="cs-done" className="primary" onClick={props.onClose}>{t('sessions.create.close')}</button></div>
      </article>
    );
  }

  if (state.loading) {
    return (
      <article className="cs-card">
        <header className="cs-header">
          <h3>{t('sessions.create.title')}</h3>
        </header>
        <LoadingState label={t('common.loading')} className="cs-loading" compact />
        <div className="actions cs-actions">
          <button type="button" id="cs-cancel" onClick={props.onClose}>{t('sessions.create.cancel')}</button>
        </div>
      </article>
    );
  }

  const bots = state.bots;
  const checkedIds = [...selectedBots];
  const leadOptions = checkedIds;
  const nameOf = (id: string) => bots.find(bot => bot.larkAppId === id)?.botName ?? id;
  const botQueryNorm = botQuery.trim().toLowerCase();
  const visibleBots = botQueryNorm
    ? bots.filter(bot =>
      bot.botName.toLowerCase().includes(botQueryNorm) || bot.larkAppId.toLowerCase().includes(botQueryNorm))
    : bots;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = content.trim();
    if (!text) { alert(t('sessions.create.errContent')); return; }
    if (checkedIds.length === 0) { alert(t('sessions.create.errNoBot')); return; }
    const leadLarkAppId = lead || checkedIds[0] || '';
    if (mode === 'lead' && (!leadLarkAppId || !checkedIds.includes(leadLarkAppId))) { alert(t('sessions.create.errLead')); return; }
    setSubmitting(true);
    setKeptSuccess(null);
    try {
      const r = await fetch('/api/sessions/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: text,
          larkAppIds: checkedIds,
          mode,
          column,
          leadLarkAppId: mode === 'lead' ? leadLarkAppId : undefined,
          name: name.trim() || undefined,
          bindWorkingDir: bindWorkingDir.trim() || undefined,
        }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok && body?.ok) {
        if (keepOpen) {
          // 连续创建：不切成功页、不关弹窗，保留机器人勾选等配置，清空内容/群名继续下一条
          setKeptSuccess(body);
          setContent('');
          setName('');
        } else {
          props.onSuccess(body);
        }
      } else if (r.status !== 401) alert(`${t('sessions.create.failed')}: ${body?.error ?? r.status}`);
    } catch (e) {
      alert(`${t('sessions.create.failed')}: ${e}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="cs-card">
      <header className="cs-header"><h3>{t('sessions.create.title')}</h3></header>
      <form id="cs-form" onSubmit={submit}>
        <fieldset className="cs-content">
          <legend>{t('sessions.create.content')}</legend>
          <textarea name="content" rows={5} placeholder={t('sessions.create.contentPlaceholder')} required value={content} onChange={event => setContent(event.currentTarget.value)} />
        </fieldset>
        <fieldset className="cs-bots">
          <legend>{t('sessions.create.bots')}</legend>
          {bots.length ? (
            <>
              <input
                className="cs-bot-search"
                type="search"
                name="botSearch"
                placeholder={t('sessions.create.botSearchPlaceholder')}
                aria-label={t('sessions.create.botSearchPlaceholder')}
                value={botQuery}
                onChange={event => setBotQuery(event.currentTarget.value)}
              />
              {visibleBots.length ? (
                <div className="cs-bot-list">
                  {visibleBots.map(bot => (
                    <label key={bot.larkAppId} className="cs-bot">
                      <input
                        type="checkbox"
                        name="bot"
                        value={bot.larkAppId}
                        checked={selectedBots.has(bot.larkAppId)}
                        onChange={event => {
                          const checked = event.currentTarget.checked;
                          setSelectedBots(prev => {
                            const next = new Set(prev);
                            if (checked) next.add(bot.larkAppId);
                            else next.delete(bot.larkAppId);
                            if (!next.has(lead)) setLead(next.values().next().value ?? '');
                            return next;
                          });
                        }}
                      /> <span>{bot.botName}</span>
                    </label>
                  ))}
                </div>
              ) : <p className="cs-empty">{t('sessions.create.noBotMatch')}</p>}
              {checkedIds.length ? <small>{t('sessions.create.selectedCount', { n: String(checkedIds.length) })}</small> : null}
            </>
          ) : <p className="cs-empty">{t('sessions.create.noBots')}</p>}
        </fieldset>
        <fieldset className="cs-mode">
          <legend>{t('sessions.create.mode')}</legend>
          <label><input type="radio" name="mode" value="lead" checked={mode === 'lead'} onChange={() => setMode('lead')} /> {t('sessions.create.modeLead')}</label>
          <label><input type="radio" name="mode" value="all" checked={mode === 'all'} onChange={() => setMode('all')} /> {t('sessions.create.modeAll')}</label>
          <small>{t('sessions.create.modeHelp')}</small>
        </fieldset>
        <fieldset className="cs-lead-row" hidden={mode !== 'lead'}>
          <legend>{t('sessions.create.lead')}</legend>
          <select name="lead" disabled={leadOptions.length === 0} value={leadOptions.includes(lead) ? lead : ''} onChange={event => setLead(event.currentTarget.value)}>
            {leadOptions.length ? leadOptions.map(id => <option key={id} value={id}>{nameOf(id)}</option>) : (
              <option value="" disabled>{t('sessions.create.leadPickFirst')}</option>
            )}
          </select>
          <small>{t('sessions.create.leadHelp')}</small>
        </fieldset>
        <fieldset className="cs-column">
          <legend>{t('sessions.create.column')}</legend>
          <label><input type="radio" name="column" value="in_progress" checked={column === 'in_progress'} onChange={() => setColumn('in_progress')} /> {t('sessions.create.columnInProgress')}</label>
          <label><input type="radio" name="column" value="backlog" checked={column === 'backlog'} onChange={() => setColumn('backlog')} /> {t('sessions.create.columnBacklog')}</label>
          <small>{t('sessions.create.columnHelp')}</small>
        </fieldset>
        <fieldset className={`cs-advanced${advancedOpen ? ' open' : ''}`}>
          <legend>
            <button
              type="button"
              id="cs-advanced-title"
              className="cs-advanced-title"
              aria-expanded={advancedOpen}
              aria-controls="cs-advanced-fields"
              onClick={() => setAdvancedOpen(open => !open)}
            >
              {t('sessions.create.optionalConfig')}
            </button>
          </legend>
          {advancedOpen ? (
          <div id="cs-advanced-fields" className="cs-advanced-fields">
            <label className="cs-advanced-field">
              <span>{t('sessions.create.groupName')}</span>
              <input className="cs-pill-input" type="text" name="name" maxLength={60} placeholder={t('sessions.create.groupNamePlaceholder')} value={name} onChange={event => setName(event.currentTarget.value)} />
            </label>
            <label className="cs-advanced-field">
              <span>{t('sessions.create.workingDir')}</span>
              <input className="cs-pill-input" type="text" name="bindWorkingDir" placeholder="e.g. ~/projects/foo" value={bindWorkingDir} onChange={event => setBindWorkingDir(event.currentTarget.value)} />
              <small>{t('sessions.create.workingDirHelp')}</small>
            </label>
          </div>
          ) : null}
        </fieldset>
        {keptSuccess ? (
          <p className="cs-keep-success" role="status">
            <span>
              {keptSuccess.column === 'backlog' ? t('sessions.create.doneBacklog') : t('sessions.create.doneInProgress')}
              {Array.isArray(keptSuccess.failed) && keptSuccess.failed.length > 0
                ? ` · ${t('sessions.create.partialFail', { n: String(keptSuccess.failed.length) })}`
                : ''}
            </span>
            {typeof keptSuccess.shareLink === 'string' && keptSuccess.shareLink
              ? <a href={keptSuccess.shareLink} target="_blank" rel="noopener">{t('sessions.create.openChat')}</a>
              : null}
          </p>
        ) : null}
        <div className="actions cs-actions">
          <label className="cs-keep-open" title={t('sessions.create.keepOpenHelp')}>
            <input
              type="checkbox"
              name="keepOpen"
              checked={keepOpen}
              onChange={event => {
                const next = event.currentTarget.checked;
                setKeepOpen(next);
                writeStoredCreateKeepOpen(windowStorage(), next);
              }}
            />
            <span>{t('sessions.create.keepOpen')}</span>
          </label>
          <button type="button" id="cs-cancel" onClick={props.onClose}>{t('sessions.create.cancel')}</button>
          <button type="submit" className="cs-submit" disabled={submitting || bots.length === 0}>{submitting ? t('sessions.create.submitting') : t('sessions.create.submit')}</button>
        </div>
      </form>
    </article>
  );
}

function SessionsPage(): JSX.Element {
  useT();
  const storeRows = useStoreSelector(snapshot => [...snapshot.sessions.values()] as SessionRow[]);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const [filters, setFilters] = useState<FiltersState>({
    q: '',
    status: '',
    adopt: '',
    chat: '',
    showUnknownChats: readStoredSessionsShowUnknownChats(windowStorage()),
    active: true,
    cli: new Set(CLI_FILTER_OPTIONS),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState('lastMessageAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [viewMode, setViewMode] = useState<SessionsViewMode>(() => readStoredSessionsViewMode(windowStorage()));
  const [boardOrder, setBoardOrder] = useState<string[]>(() => readStoredBoardOrder(windowStorage()));
  const [boardAnimated, setBoardAnimated] = useState(false);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [kanbanGroupBy, setKanbanGroupBy] = useState<KanbanGroupBy>(() => readStoredKanbanGroupBy(windowStorage()));
  const viewStageSignature = `${viewMode}:${viewMode === 'kanban' ? kanbanGroupBy : '-'}`;
  const viewStageInitialRef = useRef(true);
  const [viewStageAnimKey, setViewStageAnimKey] = useState(0);
  const [kanbanTeams, setKanbanTeams] = useState<SessionsKanbanTeam[]>([]);
  const [kanbanChatBots, setKanbanChatBots] = useState<ChatBotsMap | null>(null);
  const [kanbanTeamsLoaded, setKanbanTeamsLoaded] = useState(false);
  const kanbanTeamsLoadingRef = useRef(false);
  const [kanbanTeamKey, setKanbanTeamKey] = useState(() => {
    try { return window.localStorage.getItem(KANBAN_TEAM_STORAGE_KEY) ?? ''; } catch { return ''; }
  });
  const [teamBoard, setTeamBoard] = useState<TeamBoardState>({ data: null, key: '', fetchedAt: 0 });
  const teamBoardLoadingRef = useRef(false);
  const restartCooldownIds = useRef(new Set<string>());
  const [teamScopeText, setTeamScopeText] = useState('');
  const [bulkCloseProgress, setBulkCloseProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkLockProgress, setBulkLockProgress] = useState<{ locked: boolean; done: number; total: number } | null>(null);
  const [monitorRoomFeedback, setMonitorRoomFeedback] = useState<string | null>(null);
  const [idleCleanupBusy, setIdleCleanupBusy] = useState(false);
  const [idleCleanupHours, setIdleCleanupHours] = useState<IdleCleanupHours>(24);
  const [idleCleanupStatus, setIdleCleanupStatus] = useState('');
  const [drawerSessionId, setDrawerSessionId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<HistoryState | null>(null);
  const [termState, setTermState] = useState<TerminalState | null>(null);
  const [kanbanHost, setKanbanHost] = useState<HTMLElement | null>(null);
  const [createDialogEl, setCreateDialogEl] = useState<HTMLDialogElement | null>(null);
  const [createState, setCreateState] = useState<CreateSessionState | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const createRequestRef = useRef(0);

  useLayoutEffect(() => {
    if (viewStageInitialRef.current) {
      viewStageInitialRef.current = false;
      return;
    }
    setViewStageAnimKey(value => value + 1);
  }, [viewStageSignature]);

  useEffect(() => {
    setCreateDialogEl(document.getElementById('create-session-modal') as HTMLDialogElement | null);
  }, []);

  useEffect(() => {
    void loadNameMaps().then(refresh);
  }, [refresh]);

  const chatOptions = useMemo<ChatFilterOption[]>(() => {
    const options = new Map<string, string>();
    for (const row of storeRows) {
      const chatId = String(row.chatId ?? '').trim();
      if (!chatId) continue;
      if (!filters.showUnknownChats && isUnknownChatSession(row)) continue;
      const label = sessionLocationText(row);
      const existing = options.get(chatId);
      if (!existing || label < existing) options.set(chatId, label);
    }
    return [...options.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [filters.showUnknownChats, revision, storeRows]);

  useEffect(() => {
    if (!filters.chat) return;
    if (chatOptions.some(option => option.value === filters.chat)) return;
    setFilters(prev => ({ ...prev, chat: '' }));
  }, [chatOptions, filters.chat]);

  const rows = useMemo(() => {
    const q = filters.q.toLowerCase();
    const cli = [...filters.cli];
    const cliFilterActive = cli.length > 0 && cli.length < CLI_FILTER_OPTIONS.length;
    const keepClosed = viewMode === 'kanban';
    return storeRows
      .filter(s => !cliFilterActive || cli.includes(s.cliId ?? 'unknown'))
      .filter(s => filters.showUnknownChats || !isUnknownChatSession(s))
      .filter(s => !filters.status || s.status === filters.status)
      .filter(s => !filters.adopt || (filters.adopt === 'yes') === !!s.adopt)
      .filter(s => !filters.chat || String(s.chatId ?? '') === filters.chat)
      .filter(s => !filters.active || keepClosed || s.status !== 'closed')
      .filter(s => !q || sessionSearchText(s).includes(q))
      .sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [filters, revision, sortDir, sortKey, storeRows, viewMode]);
  const runtimeCounts = useMemo(() => sessionRuntimeCounts(storeRows), [storeRows]);

  const rowsById = useMemo(() => new Map(storeRows.map(row => [row.sessionId, row])), [storeRows, revision]);
  const boardRows = useMemo(() => rows.filter(row => row.status !== 'closed'), [rows]);
  const visibleRows = viewMode === 'table' ? rows : boardRows;
  const selectableRows = visibleRows.filter(row => row.status !== 'closed');
  const selectedRows = [...selected]
    .map(id => rowsById.get(id))
    .filter((row): row is SessionRow => !!row && row.status !== 'closed');
  const selectAllChecked = selectableRows.length > 0 && selectableRows.every(row => selected.has(row.sessionId));
  const selectAllIndeterminate = selectableRows.some(row => selected.has(row.sessionId)) && !selectAllChecked;

  useEffect(() => {
    setSelected(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        const row = rowsById.get(id);
        if (row && row.status !== 'closed') next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rowsById]);

  const teamChatIdsFor = useCallback((team: SessionsKanbanTeam | undefined): Set<string> => {
    const teamChats = new Set<string>();
    if (!team) return teamChats;
    for (const chatId of team.groupChats) teamChats.add(chatId);
    if (kanbanChatBots) {
      for (const [chatId, c] of kanbanChatBots) {
        if (teamChats.has(chatId)) continue;
        let hasTeamBot = false;
        for (const id of team.botIds) {
          if (c.botIds.has(id)) { hasTeamBot = true; break; }
        }
        if (!hasTeamBot) continue;
        for (const n of c.observedNames) {
          if (team.botNames.has(n)) { teamChats.add(chatId); break; }
        }
      }
    }
    return teamChats;
  }, [kanbanChatBots]);

  const currentCleanupVisibleRows = useMemo(() => {
    if (viewMode === 'kanban' && kanbanGroupBy === 'team') {
      const team = kanbanTeams.find(tm => tm.key === kanbanTeamKey) ?? kanbanTeams[0];
      const teamChats = teamChatIdsFor(team);
      return rows.filter(row => teamChats.has(String(row.chatId)));
    }
    return rows;
  }, [kanbanGroupBy, kanbanTeamKey, kanbanTeams, rows, teamChatIdsFor, viewMode]);
  const idleCleanupCandidatesFor = useCallback(
    (hours: IdleCleanupHours) => selectIdleCleanupCandidates(currentCleanupVisibleRows, hours),
    [currentCleanupVisibleRows],
  );

  const loadKanbanTeams = useCallback(async (): Promise<void> => {
    if (kanbanTeamsLoadingRef.current || kanbanTeamsLoaded) return;
    kanbanTeamsLoadingRef.current = true;
    try {
      const [hosted, remote, groups] = await Promise.all([
        fetch('/api/team/hosted').then(r => r.json()).catch(() => null),
        fetch('/api/team/remote-roster').then(r => r.json()).catch(() => null),
        fetch('/api/groups').then(r => r.json()).catch(() => null),
      ]);
      if (Array.isArray(groups?.chats)) {
        setKanbanChatBots(new Map(groups.chats.map((c: any) => [
          String(c.chatId),
          {
            botIds: new Set<string>((c.memberBots ?? []).filter((mb: any) => mb.inChat).map((mb: any) => String(mb.larkAppId))),
            observedNames: new Set<string>((c.observedBotNames ?? []).map((n: any) => String(n))),
          },
        ])));
      }
      const rosterBots = (bots: any[]): { ids: Set<string>; names: Set<string> } => ({
        ids: new Set<string>(bots.map((b: any) => String(b.larkAppId))),
        names: new Set<string>(bots.map((b: any) => String(b.name ?? '')).filter(Boolean)),
      });
      const teams: SessionsKanbanTeam[] = [];
      for (const tm of hosted?.teams ?? []) {
        const { ids, names } = rosterBots(tm.bots ?? []);
        teams.push({
          key: `local:${tm.teamId}`,
          label: tm.isDefault ? t('team.myHostedTeam') : String(tm.name ?? tm.teamId),
          botIds: ids,
          botNames: names,
          groupChats: new Set<string>((tm.groupChatIds ?? []).map((c: any) => String(c))),
        });
      }
      for (const m of remote?.memberships ?? []) {
        const { ids, names } = rosterBots(m.roster?.bots ?? []);
        teams.push({
          key: `${m.hubUrl}::${m.teamId}`,
          label: String(m.teamName ?? m.teamId ?? m.hubUrl),
          botIds: ids,
          botNames: names,
          groupChats: new Set<string>(),
        });
      }
      setKanbanTeams(teams);
      setKanbanTeamKey(prev => (teams.length && !teams.some(tm => tm.key === prev)) ? teams[0].key : prev);
    } finally {
      setKanbanTeamsLoaded(true);
      kanbanTeamsLoadingRef.current = false;
    }
  }, [kanbanTeamsLoaded]);

  const persistTeamBoardMove = useCallback(async (
    teamKey: string,
    sessionId: string,
    column: SessionKanbanColumn,
    position: number,
    prevEntry: { column: string; position: number } | undefined,
  ): Promise<void> => {
    try {
      const isLocal = teamKey.startsWith('local:');
      const r = isLocal
        ? await fetch(`/api/team/board/local/${encodeURIComponent(teamKey.slice('local:'.length))}/move`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, column, position }),
          })
        : await fetch('/api/team/remote-board-move', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: teamKey, sessionId, column, position }),
          });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        setTeamBoard(prev => {
          if (!prev.data || prev.key !== teamKey) return prev;
          const board = { ...prev.data.board };
          if (prevEntry) board[sessionId] = prevEntry;
          else delete board[sessionId];
          return { ...prev, data: { ...prev.data, board } };
        });
        if (r.status !== 401) alert(`${t('sessions.kanban.moveFail')}: ${body?.error ?? r.status}`);
      }
    } catch (e) {
      setTeamBoard(prev => {
        if (!prev.data || prev.key !== teamKey) return prev;
        const board = { ...prev.data.board };
        if (prevEntry) board[sessionId] = prevEntry;
        else delete board[sessionId];
        return { ...prev, data: { ...prev.data, board } };
      });
      alert(`${t('sessions.kanban.moveFail')}: ${e}`);
    }
  }, []);

  const ensureTeamBoard = useCallback(async (team: { key: string }): Promise<void> => {
    const fresh = teamBoard.key === team.key && Date.now() - teamBoard.fetchedAt < 30_000;
    if (teamBoardLoadingRef.current || fresh) return;
    teamBoardLoadingRef.current = true;
    try {
      const isLocal = team.key.startsWith('local:');
      const u = isLocal
        ? `/api/team/board/local/${encodeURIComponent(team.key.slice('local:'.length))}`
        : `/api/team/remote-board?key=${encodeURIComponent(team.key)}`;
      const r = await fetch(u);
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) return;
      const myDeploymentId = typeof body.deploymentId === 'string' ? body.deploymentId : null;
      const remoteRows: any[] = [];
      for (const rep of Array.isArray(body.reports) ? body.reports : []) {
        if (myDeploymentId && rep.deploymentId === myDeploymentId) continue;
        for (const s of Array.isArray(rep.sessions) ? rep.sessions : []) {
          remoteRows.push({ ...s, remoteDeployment: rep.deploymentName || rep.deploymentId });
        }
      }
      setTeamBoard({
        key: team.key,
        fetchedAt: Date.now(),
        data: {
          board: body.board && typeof body.board === 'object' ? body.board : {},
          remoteRows,
        },
      });
    } finally {
      teamBoardLoadingRef.current = false;
    }
  }, [teamBoard.fetchedAt, teamBoard.key]);

  useEffect(() => {
    if (viewMode === 'kanban' && kanbanGroupBy === 'team' && !kanbanTeamsLoaded) void loadKanbanTeams();
  }, [kanbanGroupBy, kanbanTeamsLoaded, loadKanbanTeams, viewMode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (viewMode === 'kanban' && kanbanGroupBy === 'team') {
        setTeamBoard(prev => ({ ...prev, fetchedAt: 0 }));
        refresh();
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [kanbanGroupBy, refresh, viewMode]);

  const persistBoardMove = useCallback(async (
    row: any,
    column: SessionKanbanColumn,
    position: number,
    prev: { column: unknown; position: unknown },
  ): Promise<void> => {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ column, position }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        row.kanbanColumn = prev.column;
        row.kanbanPosition = prev.position;
        refresh();
        if (r.status !== 401) alert(`${t('sessions.kanban.moveFail')}: ${body?.error ?? r.status}`);
      }
    } catch (e) {
      row.kanbanColumn = prev.column;
      row.kanbanPosition = prev.position;
      refresh();
      alert(`${t('sessions.kanban.moveFail')}: ${e}`);
    }
  }, [refresh]);

  const handleKanbanMoves = useCallback((moves: SessionsKanbanMove[]): void => {
    let changed = false;
    for (const move of moves) {
      const sessionId = String(move.row.sessionId);
      if (!sessionId) continue;
      if (move.row.status === 'closed' && move.column !== 'done') continue;
      if (kanbanGroupBy === 'team') {
        const team = kanbanTeams.find(tm => tm.key === kanbanTeamKey) ?? kanbanTeams[0];
        if (!team) continue;
        // Compute the prior slot from committed state and persist OUTSIDE the updater —
        // updaters must be pure (a POST inside would double-fire under StrictMode).
        const priorBoard = (teamBoard.key === team.key && teamBoard.data) ? teamBoard.data.board : {};
        const previous = priorBoard[sessionId];
        setTeamBoard(prev => {
          const base = (prev.key === team.key && prev.data) ? prev.data : { board: {}, remoteRows: prev.data?.remoteRows ?? [] };
          const board = { ...base.board, [sessionId]: { column: move.column, position: move.position } };
          return { ...prev, key: team.key, data: { ...base, board } };
        });
        void persistTeamBoardMove(team.key, sessionId, move.column, move.position, previous);
        changed = true;
        continue;
      }
      const row = store.sessions.get(sessionId);
      if (!row) continue;
      const prev = { column: row.kanbanColumn, position: row.kanbanPosition };
      row.kanbanColumn = move.column;
      row.kanbanPosition = move.position;
      void persistBoardMove(row, move.column, move.position, prev);
      changed = true;
    }
    if (changed) refresh();
  }, [kanbanGroupBy, kanbanTeamKey, kanbanTeams, teamBoard, persistBoardMove, persistTeamBoardMove, refresh]);

  const persistRename = useCallback(async (row: any, title: string): Promise<void> => {
    const prevTitle = row.title;
    row.title = title;
    refresh();
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        row.title = prevTitle;
        refresh();
        if (r.status !== 401) alert(`${t('sessions.kanban.renameFail')}: ${body?.error ?? r.status}`);
      }
    } catch (e) {
      row.title = prevTitle;
      refresh();
      alert(`${t('sessions.kanban.renameFail')}: ${e}`);
    }
  }, [refresh]);

  const locateSession = useCallback(async (row: any): Promise<boolean> => {
    // Busy/cooldown UI is owned by the React-state LocateButton / LocateIconButton;
    // do NOT imperatively mutate the button here — the board's locate button renders
    // its icon via dangerouslySetInnerHTML and a textContent write permanently wipes it.
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/locate`, { method: 'POST' });
      const body = await r.json();
      if (body.ok) return true;
      alert(`Locate failed: ${body.error ?? r.status}`);
      return false;
    } catch (e) {
      alert(`Locate error: ${e}`);
      return false;
    }
  }, []);

  const closeSession = useCallback(async (row: any, closeBtn?: HTMLButtonElement): Promise<boolean> => {
    if (!confirm(t('sessions.closeConfirm'))) return false;
    if (closeBtn) closeBtn.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/close`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        if (r.status !== 401) alert(`Close failed: ${body?.error ?? r.status}`);
        return false;
      }
      setSelected(prev => {
        const next = new Set(prev);
        next.delete(row.sessionId);
        return next;
      });
      refresh();
      return true;
    } catch (e) {
      alert(`Close error: ${e}`);
      return false;
    } finally {
      if (closeBtn) closeBtn.disabled = false;
    }
  }, [refresh]);

  const setSessionLocked = useCallback(async (row: any, locked: boolean, btn?: HTMLButtonElement): Promise<boolean> => {
    const prev = !!row.locked;
    if (prev === locked) return true;
    row.locked = locked;
    refresh();
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locked }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        row.locked = prev;
        refresh();
        if (r.status !== 401) alert(`${t('sessions.lockFailed')}: ${body?.error ?? r.status}`);
        return false;
      }
      row.locked = !!body.locked;
      refresh();
      return true;
    } catch (e) {
      row.locked = prev;
      refresh();
      alert(`${t('sessions.lockFailed')}: ${e}`);
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }, [refresh]);

  const restartSession = useCallback(async (row: any, restartBtn?: HTMLButtonElement): Promise<boolean> => {
    if (restartCooldownIds.current.has(row.sessionId)) return false;
    if (!confirm(restartConfirmMessage(row))) return false;
    if (restartBtn) restartBtn.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/restart`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        if (r.status !== 401) alert(`${t('sessions.restartFailed')}: ${body?.error ?? r.status}`);
        return false;
      }
      restartCooldownIds.current.add(row.sessionId);
      window.setTimeout(() => restartCooldownIds.current.delete(row.sessionId), 5000);
      return true;
    } catch (e) {
      alert(`${t('sessions.restartFailed')}: ${e}`);
      return false;
    } finally {
      if (restartBtn) restartBtn.disabled = false;
    }
  }, []);

  const resumeSession = useCallback(async (row: any, button?: HTMLButtonElement): Promise<boolean> => {
    if (button) button.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/resume`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        alert(`${t('sessions.resumeFailed')}: ${body?.error ?? r.status}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`${t('sessions.resumeFailed')}: ${e}`);
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }, []);

  const startSession = useCallback(async (row: any, button?: HTMLButtonElement): Promise<boolean> => {
    if (button) button.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/start`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        if (r.status !== 401) alert(`${t('sessions.create.startFailed')}: ${body?.error ?? r.status}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`${t('sessions.create.startFailed')}: ${e}`);
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }, []);

  const openHistoryModal = useCallback((row: any): void => {
    setHistoryState({ sessionId: row.sessionId, loading: true, messages: [] });
    void (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/history?limit=80`);
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body?.ok === false) {
          const errCode = String(body?.error ?? r.status);
          const stale = errCode === 'not_found_yet' || errCode === 'not_found';
          setHistoryState(prev => prev?.sessionId === row.sessionId ? { sessionId: row.sessionId, loading: false, messages: [], error: errCode, stale } : prev);
          return;
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        setHistoryState(prev => prev?.sessionId === row.sessionId ? { sessionId: row.sessionId, loading: false, messages, ownerOpenId: body.ownerOpenId } : prev);
      } catch (e) {
        setHistoryState(prev => prev?.sessionId === row.sessionId ? { sessionId: row.sessionId, loading: false, messages: [], error: String(e) } : prev);
      }
    })();
  }, []);

  const openTerminalModal = useCallback((row: any): void => {
    const readonlyUrl = terminalHref(row);
    if (!readonlyUrl) {
      setDrawerSessionId(row.sessionId);
      return;
    }
    setTermState({ sessionId: row.sessionId, url: readonlyUrl, loading: true });
    void (async () => {
      let url = readonlyUrl;
      if (shouldOpenWritableTerminal()) {
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/write-link`);
          const body = await r.json().catch(() => ({}));
          if (r.ok && body?.ok !== false && body?.url) url = body.url;
        } catch {
          // fallback to read-only URL
        }
      }
      setTermState(prev => prev?.sessionId === row.sessionId ? { sessionId: row.sessionId, url, loading: false } : prev);
    })();
  }, []);

  const runBulkClose = useCallback(async (): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(t('sessions.closeBulkConfirm', { count: ids.length }))) return;
    setBulkCloseProgress({ done: 0, total: ids.length });
    let done = 0;
    let failed = 0;
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const sid = queue.shift()!;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/close`, { method: 'POST' });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body?.ok === false) failed += 1;
        } catch {
          failed += 1;
        } finally {
          done += 1;
          setBulkCloseProgress({ done, total: ids.length });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => worker()));
    setBulkCloseProgress(null);
    setSelected(new Set());
    refresh();
    if (failed > 0) alert(`Failed: ${failed}/${ids.length}`);
  }, [refresh, selected]);

  const runBulkLock = useCallback(async (locked: boolean): Promise<void> => {
    const targetRows = [...selected]
      .map(id => rowsById.get(id))
      .filter((row): row is SessionRow => !!row && row.status !== 'closed' && !!row.locked !== locked);
    if (targetRows.length === 0) return;
    setBulkLockProgress({ locked, done: 0, total: targetRows.length });
    let done = 0;
    let failed = 0;
    const queue = [...targetRows];
    async function worker() {
      while (queue.length) {
        const row = queue.shift()!;
        const prev = !!row.locked;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/lock`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locked }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body?.ok === false) {
            failed += 1;
            row.locked = prev;
          } else {
            row.locked = !!body.locked;
          }
        } catch {
          failed += 1;
          row.locked = prev;
        } finally {
          done += 1;
          setBulkLockProgress({ locked, done, total: targetRows.length });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, targetRows.length) }, () => worker()));
    setBulkLockProgress(null);
    refresh();
    if (failed > 0) alert(`${t('sessions.lockFailed')}: ${failed}/${targetRows.length}`);
  }, [refresh, rowsById, selected]);

  const addSelectedToMonitorRoom = useCallback((): void => {
    const ids = [...selected].filter(id => !!rowsById.get(id));
    if (ids.length === 0) return;
    const result = addMonitorRoomSessionIds(ids);
    setMonitorRoomFeedback(t('sessions.monitorRoomAdded', { added: result.added, total: result.total }));
    window.setTimeout(() => setMonitorRoomFeedback(null), 1800);
  }, [rowsById, selected]);

  const runIdleCleanup = useCallback(async (hours: IdleCleanupHours): Promise<void> => {
    const nextHours = parseIdleCleanupHours(hours);
    if (!nextHours) return;
    const candidates = idleCleanupCandidatesFor(nextHours);
    if (candidates.length === 0) return;
    setIdleCleanupHours(nextHours);
    setIdleCleanupBusy(true);
    setIdleCleanupStatus(t('sessions.idleCleanupRunning'));
    try {
      const r = await fetch('/api/sessions/cleanup-idle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ olderThanHours: nextHours, sessionIds: candidates.map(c => c.sessionId) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status !== 401) alert(`${t('sessions.idleCleanupFailed')}: ${body?.error ?? r.status}`);
        setIdleCleanupStatus('');
        return;
      }
      setSelected(prev => {
        const next = new Set(prev);
        for (const item of body?.results ?? []) {
          if (item?.ok && item?.sessionId) next.delete(String(item.sessionId));
        }
        return next;
      });
      setIdleCleanupStatus(t('sessions.idleCleanupDone', {
        closed: Number(body?.closed ?? 0),
        failed: Number(body?.failed ?? 0),
      }));
      refresh();
    } catch (e) {
      alert(`${t('sessions.idleCleanupFailed')}: ${e}`);
      setIdleCleanupStatus('');
    } finally {
      setIdleCleanupBusy(false);
    }
  }, [idleCleanupCandidatesFor, refresh]);

  const setView = (nextRaw: string | undefined): void => {
    const next = normalizeSessionsViewMode(nextRaw) ?? 'board';
    if (next === viewMode) return;
    setViewMode(next);
    writeStoredSessionsViewMode(windowStorage(), next);
  };
  const moveColumn = (id: string, delta: number): void => {
    setBoardOrder(prev => {
      const from = prev.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, id);
      writeStoredBoardOrder(windowStorage(), next);
      return next;
    });
  };
  const moveColumnTo = (id: string, targetId: string): void => {
    if (id === targetId) return;
    setBoardOrder(prev => {
      const from = prev.indexOf(id);
      const to = prev.indexOf(targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, id);
      writeStoredBoardOrder(windowStorage(), next);
      return next;
    });
  };

  const kanbanState = useMemo(() => ({
    rows,
    groupBy: kanbanGroupBy,
    teams: kanbanTeams,
    teamsLoaded: kanbanTeamsLoaded,
    teamKey: kanbanTeamKey,
    teamBoardData: teamBoard.data,
    teamBoardKey: teamBoard.key,
  }), [kanbanGroupBy, kanbanTeamKey, kanbanTeams, kanbanTeamsLoaded, rows, teamBoard.data, teamBoard.key]);

  const drawerRow = drawerSessionId ? rowsById.get(drawerSessionId) ?? null : null;
  const kanbanTeamOptions = useMemo(() => {
    if (!kanbanTeamsLoaded) return [{ value: '__loading', label: t('sessions.kanban.teamLoading') }];
    if (!kanbanTeams.length) return [{ value: '', label: t('sessions.kanban.noTeam') }];
    return kanbanTeams.map(team => ({ value: team.key, label: team.label }));
  }, [kanbanTeams, kanbanTeamsLoaded]);
  const kanbanTeamDisabled = !kanbanTeamsLoaded || kanbanTeams.length === 0;
  const kanbanTeamValue = kanbanTeams.some(team => team.key === kanbanTeamKey)
    ? kanbanTeamKey
    : (kanbanTeamOptions[0]?.value ?? '');
  const kanbanTeamLabel = kanbanTeamOptions.find(option => option.value === kanbanTeamValue)?.label
    ?? t('sessions.kanban.groupTeam');

  const closeCreateSession = useCallback(() => {
    createRequestRef.current += 1;
    setCreateLoading(false);
    setCreateState(null);
  }, []);

  const openCreateSession = async (): Promise<void> => {
    const requestId = createRequestRef.current + 1;
    createRequestRef.current = requestId;
    setCreateState({ bots: [], loading: true });
    setCreateLoading(true);
    try {
      const bots = await fetchPickerBots();
      if (createRequestRef.current !== requestId) return;
      setCreateState({ bots });
    } finally {
      if (createRequestRef.current === requestId) setCreateLoading(false);
    }
  };

  // 侧边菜单「创建会话」入口：已在本页时收事件直接打开；跨页跳转时消费挂载前的 pending
  useEffect(() => {
    const maybeOpenFromEntry = () => {
      if (consumePendingCreateSession() && ui.authed) void openCreateSession();
    };
    maybeOpenFromEntry();
    window.addEventListener(OPEN_CREATE_SESSION_EVENT, maybeOpenFromEntry);
    return () => window.removeEventListener(OPEN_CREATE_SESSION_EVENT, maybeOpenFromEntry);
    // openCreateSession 只碰稳定的 ref/setState，取首次渲染的闭包即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page sessions-page">
      <div className="page-heading">
        <div className="sessions-heading-main">
          <p className="eyebrow">{t('nav.sessions')}</p>
          <h1>{t('sessions.title')}</h1>
          <div className="sessions-view-controls">
            <div className="segmented sessions-view-toggle" role="group" aria-label={t('sessions.viewMode')}>
              {([
                ['kanban', t('sessions.viewKanban')],
                ['board', t('sessions.viewBoard')],
                ['table', t('sessions.viewTable')],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-view={value}
                  className={viewMode === value ? 'active' : undefined}
                  aria-pressed={viewMode === value}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className={`segmented kanban-groupby${viewMode === 'kanban' ? ' is-visible' : ' is-collapsed'}`}
              id="kanban-groupby"
              role="group"
              aria-label={t('sessions.kanban.groupBy')}
              aria-hidden={viewMode !== 'kanban'}
            >
              {([
                ['flow', t('sessions.kanban.groupFlow')],
                ['team', t('sessions.kanban.groupTeam')],
                ['bot', t('sessions.kanban.groupBot')],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-groupby={value}
                  className={kanbanGroupBy === value ? 'active' : undefined}
                  aria-pressed={kanbanGroupBy === value}
                  onClick={() => {
                    setKanbanGroupBy(value);
                    writeStoredKanbanGroupBy(windowStorage(), value);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <span id="kanban-team-stats" className="kanban-team-stats" hidden={!(viewMode === 'kanban' && kanbanGroupBy === 'team' && kanbanTeamsLoaded)}>
              {teamScopeText}
            </span>
            <DropdownMenu
              id="kanban-team"
              className="kanban-team-menu"
              ariaLabel={t('sessions.kanban.groupTeam')}
              hidden={!(viewMode === 'kanban' && kanbanGroupBy === 'team')}
              disabled={kanbanTeamDisabled}
              label={kanbanTeamLabel}
              value={kanbanTeamValue}
              options={kanbanTeamOptions}
              onChange={next => {
                if (!kanbanTeams.some(team => team.key === next)) return;
                setKanbanTeamKey(next);
                try { window.localStorage.setItem(KANBAN_TEAM_STORAGE_KEY, next); } catch { /* current page only */ }
              }}
            />
          </div>
        </div>
        <div className="page-heading-actions sessions-page-actions">
          <button type="button" id="monitor-room-open" className="monitor-room-open" onClick={() => { window.location.href = monitorRoomUrl(); }}>
            {t('sessions.monitorRoom')}
          </button>
          {ui.authed ? (
            <CreateActionButton
              className="page-primary-action create-session-btn"
              disabled={createLoading}
              onClick={() => void openCreateSession()}
            >
              {t('sessions.create.button')}
            </CreateActionButton>
          ) : null}
        </div>
      </div>

      <div className="session-runtime-stats" aria-live="polite">
        <span><b>{runtimeCounts.logical}</b>{t('sessions.runtime.logical')}</span>
        <span><b>{runtimeCounts.resident}</b>{t('sessions.runtime.resident')}</span>
        <span><b>{runtimeCounts.dormant}</b>{t('sessions.runtime.dormant')}</span>
      </div>

      <SessionsFilters
        chatOptions={chatOptions}
        filters={filters}
        setFilters={setFilters}
        idleCleanup={{
          busy: idleCleanupBusy,
          hours: idleCleanupHours,
          status: idleCleanupStatus,
          countForHours: hours => idleCleanupCandidatesFor(hours).length,
          onRun: runIdleCleanup,
        }}
      />
      <BulkBar
        selectedCount={selected.size}
        lockDisabled={!selectedRows.some(row => !row.locked)}
        unlockDisabled={!selectedRows.some(row => !!row.locked)}
        closeProgress={bulkCloseProgress}
        lockProgress={bulkLockProgress}
        monitorRoomText={monitorRoomFeedback}
        onClear={() => setSelected(new Set())}
        onClose={() => void runBulkClose()}
        onAddToMonitorRoom={addSelectedToMonitorRoom}
        onLock={locked => void runBulkLock(locked)}
      />

      <div
        key={viewStageAnimKey}
        className={`sessions-view-stage${viewStageAnimKey > 0 ? ' sessions-view-stage-enter' : ''}`}
        data-view={viewMode}
        data-kanban-group={kanbanGroupBy}
      >
        <SessionsTable
          rows={rows}
          selected={selected}
          hidden={viewMode !== 'table'}
          sortKey={sortKey}
          sortDir={sortDir}
          selectAllChecked={selectAllChecked}
          selectAllIndeterminate={selectAllIndeterminate}
          selectAllDisabled={selectableRows.length === 0}
          onOpen={row => setDrawerSessionId(row.sessionId)}
          onSelect={(id, checked) => setSelected(prev => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
          })}
          onSelectAll={checked => setSelected(prev => {
            const next = new Set(prev);
            for (const row of selectableRows) {
              if (checked) next.add(row.sessionId);
              else next.delete(row.sessionId);
            }
            return next;
          })}
          onSort={(key) => {
            if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
            else {
              setSortKey(key);
              setSortDir(key === 'spawnedAt' || key === 'lastMessageAt' ? 'desc' : 'asc');
            }
          }}
        />

        <BoardView
          rows={boardRows}
          selected={selected}
          hidden={viewMode !== 'board'}
          order={boardOrder}
          animated={boardAnimated}
          dragColId={dragColId}
          dragOverCol={dragOverCol}
          onAnimated={() => setBoardAnimated(true)}
          onMoveColumn={moveColumn}
          onMoveColumnTo={moveColumnTo}
          onDragCol={setDragColId}
          onDragOverCol={setDragOverCol}
          onToggleSelect={row => setSelected(prev => {
            const next = new Set(prev);
            if (next.has(row.sessionId)) next.delete(row.sessionId);
            else next.add(row.sessionId);
            return next;
          })}
          onOpen={row => setDrawerSessionId(row.sessionId)}
          onHistory={openHistoryModal}
          onLocate={row => locateSession(row)}
          onRestart={(row, button) => void restartSession(row, button)}
          onLock={(row, locked, button) => void setSessionLocked(row, locked, button)}
          onClose={(row, button) => void closeSession(row, button)}
        />

        <div
          id="sessions-kanban"
          ref={setKanbanHost}
          className={`sessions-kanban${kanbanGroupBy === 'bot' ? ' kanban-mode-bot' : ''}`}
          hidden={viewMode !== 'kanban'}
        >
          {viewMode === 'kanban' ? (
            <SessionsKanbanView
              host={kanbanHost}
              {...kanbanState}
              canRestartSession={canRestartSession}
              getTeamChatIds={teamChatIdsFor}
              icons={{
                details: ICON.details,
                feishu: ICON.feishu,
                history: ICON.history,
                lock: ICON.lock,
                restart: ICON.restart,
                terminal: ICON.terminal,
                unlock: ICON.unlock,
              }}
              lockActionLabel={lockActionLabel}
              sessionStatusText={sessionStatusText}
              onDetails={row => setDrawerSessionId(String(row.sessionId))}
              onHistory={openHistoryModal}
              onMoveRows={handleKanbanMoves}
              onNeedTeamBoard={team => { void ensureTeamBoard(team); }}
              onNeedTeams={() => { void loadKanbanTeams(); }}
              onOpenTerminal={openTerminalModal}
              onRename={(row, title) => { const s = store.sessions.get(String(row.sessionId)); if (s) void persistRename(s, title); }}
              onRestart={(row, button) => { const s = store.sessions.get(String(row.sessionId)); if (s) void restartSession(s, button); }}
              onTeamScope={scope => setTeamScopeText(scope ? t('sessions.kanban.teamScope', { chats: scope.chats, sessions: scope.sessions }) : '')}
              onToggleLock={(row, button) => { const s = store.sessions.get(String(row.sessionId)); if (s) void setSessionLocked(s, !s.locked, button); }}
              onToggleSelect={row => setSelected(prev => {
                const id = String(row.sessionId);
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })}
              selectedSessionIds={selected}
            />
          ) : null}
        </div>
      </div>

      <Drawer
        row={drawerRow}
        onClose={() => setDrawerSessionId(null)}
        locateSession={locateSession}
        openHistory={openHistoryModal}
        resumeSession={resumeSession}
        restartSession={restartSession}
        closeSession={closeSession}
        setSessionLocked={setSessionLocked}
        startSession={startSession}
      />
      <TerminalModal state={termState} onClose={() => setTermState(null)} onRename={persistRename} />
      <HistoryModal state={historyState} onClose={() => setHistoryState(null)} />
      {createDialogEl ? createPortal(
        <CreateSessionDialog
          dialog={createDialogEl}
          state={createState}
          onClose={closeCreateSession}
          onSuccess={body => setCreateState(prev => prev ? { ...prev, success: body } : prev)}
        />,
        createDialogEl,
      ) : null}
    </section>
  );
}

export function renderSessionsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SessionsPage />);
}
