import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { openBotOnboarding } from './bot-onboarding.js';
import {
  agentSelectionKey,
  cliIdOf,
  createRefreshGate,
  displayCliId,
  fallbackCliOptionsState,
  fetchBotDefaults,
  fetchCliOptions,
  fmtSince,
  modelSuggestionsForOption,
  resolveSubstituteTarget,
  selectedCliOption,
  type BotDefaultsRow,
  type CliRuntimeConfig,
  type CliRuntimeUpdateProvider,
  type BotSubstituteMode,
  type BotSubstituteTarget,
  type CliOptionsState,
  type SubstituteTargetResolution,
} from './bot-defaults.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { store } from './store.js';
import type { RoleInjectMode } from './roles.js';
import {
  CreateActionButton,
  DropdownMenu,
  Html,
  InfoTip as BaseInfoTip,
  LoadingState,
  OverflowText,
  RefreshIconButton,
  dropdownLabel,
} from './dashboard-components.js';
import { botAvatarHtml, larkConsoleUrl, loadNameMaps, overrideBotAvatar, ui } from './ui.js';
import {
  DEFAULT_GRANT_DURATION_MS,
  DEFAULT_GRANT_QUOTA,
  GRANT_DURATION_OPTIONS,
  MAX_GRANT_QUOTA,
} from '../../services/grant-policy.js';

type StatusMessage = { text: string; ok?: boolean } | null;
type PatchBot = (appId: string, patch: Partial<BotDefaultsRow> | ((bot: BotDefaultsRow) => BotDefaultsRow)) => void;
type CardPrefPatch = Record<string, boolean | string>;

type JsonResponse = {
  ok: boolean;
  status: number;
  body: any;
};

type RuntimeMode = 'official' | 'legacy' | 'custom';
type RuntimeDraft = {
  mode: RuntimeMode;
  id: string;
  displayName: string;
  executable: string;
  legacyPath: string;
  updateProvider: CliRuntimeUpdateProvider;
  packageName: string;
};

function runtimeDraftFromBot(bot: Pick<BotDefaultsRow, 'cliRuntime' | 'cliPathOverride'>): RuntimeDraft {
  const runtime = bot.cliRuntime;
  if (!runtime || typeof runtime !== 'object') {
    const legacyPath = typeof bot.cliPathOverride === 'string' ? bot.cliPathOverride.trim() : '';
    return {
      mode: legacyPath ? 'legacy' : 'official',
      id: '',
      displayName: '',
      // Carry the path into the custom form so migrating a legacy entry does
      // not require retyping it; the legacy state itself remains read-only.
      executable: legacyPath,
      legacyPath,
      updateProvider: 'auto',
      packageName: '',
    };
  }
  const provider = runtime.update?.provider;
  const updateProvider: CliRuntimeUpdateProvider = provider === 'self' || provider === 'npm' || provider === 'none'
    ? provider
    : 'auto';
  return {
    mode: 'custom',
    id: typeof runtime.id === 'string' ? runtime.id : '',
    displayName: typeof runtime.displayName === 'string' ? runtime.displayName : '',
    executable: typeof runtime.executable === 'string' ? runtime.executable : '',
    legacyPath: '',
    updateProvider,
    packageName: runtime.update?.provider === 'npm' && typeof runtime.update.packageName === 'string'
      ? runtime.update.packageName
      : '',
  };
}

type BotProfileRoleItem = {
  profileId: string;
  loaded?: boolean;
  loading?: boolean;
  content?: string | null;
  error?: string;
};

type BotProfileRoleState = {
  loaded: boolean;
  loading: boolean;
  error?: string;
  items: BotProfileRoleItem[];
};

export type BotDefaultsTab = 'common' | 'sessions' | 'security' | 'cards' | 'advanced';

export const BOT_DEFAULTS_TABS: readonly BotDefaultsTab[] = [
  'common',
  'sessions',
  'security',
  'cards',
  'advanced',
];

export function BotDefaultsTabs(props: {
  active: BotDefaultsTab;
  onChange(tab: BotDefaultsTab): void;
}) {
  const tr = useT();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const labels: Record<BotDefaultsTab, string> = {
    common: tr('botDefaults.tabCommon'),
    sessions: tr('botDefaults.tabSessions'),
    security: tr('botDefaults.tabSecurity'),
    cards: tr('botDefaults.tabCards'),
    advanced: tr('botDefaults.tabAdvanced'),
  };

  function selectAt(index: number): void {
    const nextIndex = (index + BOT_DEFAULTS_TABS.length) % BOT_DEFAULTS_TABS.length;
    const next = BOT_DEFAULTS_TABS[nextIndex]!;
    props.onChange(next);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <nav className="bd-tab-bar" aria-label={tr('botDefaults.tabNavigation')}>
      <div className="bd-tabs" role="tablist">
        {BOT_DEFAULTS_TABS.map((tab, index) => (
          <button
            ref={node => { tabRefs.current[index] = node; }}
            key={tab}
            id={`bd-tab-${tab}`}
            type="button"
            role="tab"
            className={`bd-tab${props.active === tab ? ' active' : ''}`}
            aria-selected={props.active === tab}
            aria-controls={`bd-panel-${tab}`}
            tabIndex={props.active === tab ? 0 : -1}
            data-bd-tab={tab}
            onClick={() => props.onChange(tab)}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                selectAt(index + 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                selectAt(index - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                selectAt(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                selectAt(BOT_DEFAULTS_TABS.length - 1);
              }
            }}
          >
            {labels[tab]}
          </button>
        ))}
      </div>
      <small className="bd-tab-hint">{tr('botDefaults.tabHint')}</small>
    </nav>
  );
}

// Two-column waterfall (masonry) for the task panels. A plain row-major grid
// locks each row to its tallest tile, stranding a short tile beside a tall one
// with a dead gap below. This lays tiles out by greedily dropping each into the
// currently shortest column and writing back an inline grid-column /
// grid-row-start over the CSS 1px row track. Tiles stay direct grid children —
// never reparented into per-column wrappers — so their unsaved form drafts
// (the whole point of the focused editor) never remount. Degrades to the plain
// auto-fill grid when there is only one column (mobile / narrow) or before the
// first measure.
const BD_GRID_ROW_PX = 1; // must match grid-auto-rows in style.css
const BD_GRID_GAP_PX = 14; // must match .bd-tab-grid gap

export function BdTabGrid(props: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const grid = ref.current;
    if (!grid || typeof window === 'undefined') return undefined;

    const clearPlacement = (tiles: HTMLElement[]) => {
      for (const tile of tiles) {
        tile.style.gridColumn = '';
        tile.style.gridRowStart = '';
        tile.style.gridRowEnd = '';
      }
    };

    const layout = () => {
      const tiles = Array.from(grid.children).filter(
        (n): n is HTMLElement => n instanceof HTMLElement,
      );
      if (!tiles.length) return;

      // A hidden panel (display:none) reports 0 width — skip; the ResizeObserver
      // re-fires with real geometry the moment the tab becomes visible.
      const gridWidth = grid.clientWidth;
      if (gridWidth <= 0) return;

      // Decide the column count from the SAME width the CSS @container rule keys
      // off (the .bd-detail container), instead of parsing
      // getComputedStyle().gridTemplateColumns — that value contains spaces
      // inside minmax(...) and, once we write an inline grid-column, can report a
      // stale/implicit extra track, which previously produced a rogue 3rd column.
      // Reading the container keeps JS placement and the CSS track count in lockstep.
      const container = grid.closest<HTMLElement>('.bd-detail');
      const decideWidth = container?.clientWidth ?? gridWidth;
      const columns = decideWidth >= 1024 ? 2 : 1;

      // Single column (mobile / narrow): normal flow already stacks with no gap.
      if (columns < 2) { clearPlacement(tiles); return; }

      const rowStep = BD_GRID_ROW_PX + BD_GRID_GAP_PX;
      const colBottom = new Array<number>(columns).fill(0); // running bottom, row units

      for (const tile of tiles) {
        const spanRows = Math.max(
          1,
          Math.ceil((tile.getBoundingClientRect().height + BD_GRID_GAP_PX) / rowStep),
        );
        if (tile.classList.contains('bd-tile-wide')) {
          // full-width tile: start below the tallest column, then level every
          // column to its bottom so following tiles pack beneath it evenly.
          const start = Math.max(...colBottom);
          tile.style.gridColumn = '1 / -1';
          tile.style.gridRowStart = String(start + 1);
          tile.style.gridRowEnd = String(start + 1 + spanRows);
          colBottom.fill(start + spanRows);
          continue;
        }
        // drop into the currently shortest column (true waterfall)
        let target = 0;
        for (let c = 1; c < columns; c++) if (colBottom[c]! < colBottom[target]!) target = c;
        const start = colBottom[target]!;
        tile.style.gridColumn = String(target + 1);
        tile.style.gridRowStart = String(start + 1);
        tile.style.gridRowEnd = String(start + 1 + spanRows);
        colBottom[target] = start + spanRows;
      }
    };

    // Measure after paint; re-run on any tile resize (content toggles, textarea
    // growth, async loads, tab becoming visible) and on viewport resize.
    const raf = window.requestAnimationFrame(layout);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
    if (ro) {
      ro.observe(grid);
      for (const child of Array.from(grid.children)) ro.observe(child);
    }
    window.addEventListener('resize', layout);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', layout);
    };
  });

  return (
    <div ref={ref} className={props.className ? `bd-tab-grid ${props.className}` : 'bd-tab-grid'}>
      {props.children}
    </div>
  );
}

/**
 * Normalise an agent-switch close summary out of an (untrusted) JSON body.
 *
 * count and ids are read TOGETHER on purpose. Either one alone is evidence that a
 * remote session survived, and trusting only one is how a malformed payload
 * fails open:
 *  - count>0 with missing/empty ids used to print no id at all;
 *  - ids present with count 0/absent used to print "manual cleanup required" and
 *    still show the green tick.
 * So: any evidence at all ⇒ residual, and a declared residual with no usable id
 * renders as `unknown` rather than vanishing.
 */
/** What a Riff-side agent persist reports back to its own visible status. */
interface CliPersistOutcome {
  ok: boolean;
  /** True when a remote session survived (or the switch aborted). */
  hadProblem: boolean;
  note: string;
}

function parseAgentSwitchSummary(body: unknown): {
  closed: number;
  failed: number;
  residual: number;
  residualIds: string[];
  hasResidual: boolean;
} {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
  const closed = num(record.closedMismatchedSessions);
  const failed = num(record.closedMismatchedFailed);
  const residualCount = num(record.closedMismatchedResidual);
  const rawIds = record.closedMismatchedResidualTaskIds;
  const ids = Array.isArray(rawIds)
    ? rawIds.map(id => (typeof id === 'string' && id.trim() ? id : 'unknown'))
    : [];
  const hasResidual = residualCount > 0 || ids.length > 0;
  // A declared residual with no usable id must still be visible.
  const residualIds = hasResidual && ids.length === 0 ? ['unknown'] : ids;
  return {
    closed,
    failed,
    residual: Math.max(residualCount, residualIds.length),
    residualIds,
    hasResidual,
  };
}

/** Render residual remote ids; empty only when there is genuinely no residual. */
function residualIdText(
  summary: { residualIds: string[] },
  tr: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (summary.residualIds.length === 0) return '';
  return tr('botDefaults.agentResidualIds', { ids: summary.residualIds.join(', ') });
}

function statusClass(status: StatusMessage, extra = ''): string {
  const suffix = status ? ` ${status.ok ? 'hint-ok' : 'hint-warn-inline'}` : '';
  return `oncall-status${extra ? ` ${extra}` : ''}${suffix}`;
}

function StatusSpan(props: { status: StatusMessage; attr?: Record<string, string> }) {
  return <span role="status" aria-live="polite" className={statusClass(props.status)} {...(props.attr ?? {})}>{props.status?.text ?? ''}</span>;
}

function InfoTip(props: { children: ReactNode }) {
  const ariaLabel = typeof props.children === 'string' ? props.children : undefined;
  return <BaseInfoTip className="bd-info-tip" label={ariaLabel}>{props.children}</BaseInfoTip>;
}

function FieldTitle(props: { children: ReactNode; help?: ReactNode }) {
  return (
    <span className="bd-field-title">
      <span className="bd-field-title-text">{props.children}</span>
      {props.help ? <InfoTip>{props.help}</InfoTip> : null}
    </span>
  );
}

type DropdownFieldOption<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
};

function DropdownField<T extends string>(props: {
  dataInput: string;
  value: T;
  options: DropdownFieldOption<T>[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  searchable?: boolean;
  onChange(value: T): void;
}) {
  const tr = useT();
  return (
    <>
      <DropdownMenu
        id={`bd-menu-${props.dataInput}`}
        className={['bd-field-menu', props.className].filter(Boolean).join(' ')}
        ariaLabel={props.ariaLabel}
        disabled={props.disabled}
        label={dropdownLabel(props.options, props.value)}
        value={props.value}
        options={props.options}
        searchable={props.searchable}
        searchPlaceholder={props.searchable ? tr('common.dropdownSearch') : undefined}
        searchEmptyLabel={props.searchable ? tr('common.dropdownSearchEmpty') : undefined}
        onChange={props.onChange}
      />
      <input type="hidden" data-input={props.dataInput} value={props.value} readOnly />
    </>
  );
}

function ToggleRow(props: {
  checked: boolean;
  disabled?: boolean;
  title: ReactNode;
  help: ReactNode;
  description?: ReactNode;
  className?: string;
  dataAction?: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className={props.className ? `toggle-row ${props.className}` : 'toggle-row'}>
      <input
        type="checkbox"
        data-action={props.dataAction}
        checked={props.checked}
        disabled={props.disabled}
        onChange={event => props.onChange(event.currentTarget.checked)}
      />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-tx">
        <strong><FieldTitle help={props.help}>{props.title}</FieldTitle></strong>
        {props.description ? <small>{props.description}</small> : null}
      </span>
    </label>
  );
}

async function sendJson(method: string, url: string, body?: unknown): Promise<JsonResponse> {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await r.json().catch(() => ({}));
  return { ok: r.ok && parsed?.ok !== false, status: r.status, body: parsed };
}

function responseErrorText(res: JsonResponse): string {
  const reason = typeof res.body?.reason === 'string' ? res.body.reason : '';
  const manual = typeof res.body?.manualCommand === 'string' ? res.body.manualCommand : '';
  if (reason && manual) return `${reason}（${manual}）`;
  return String(reason || res.body?.error || res.status);
}

function caughtErrorText(e: any): string {
  return e?.message ?? String(e);
}

function positiveIntegerOrNull(raw: string): number | null | 'invalid' {
  const value = raw.trim();
  if (!value) return null;
  if (!/^[1-9]\d*$/.test(value)) return 'invalid';
  return Number(value);
}

function nonNegativeInteger(raw: string, fallback: number): number | null {
  const value = raw.trim();
  if (value === '') return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  return Number(value);
}

type SubstituteTargetIdField = 'email' | 'openId' | 'userId' | 'unionId';

type SubstituteTargetDraft = {
  key: number;
  idField: SubstituteTargetIdField;
  idValue: string;
  name: string;
  persisted: BotSubstituteTarget;
  originalIdField?: SubstituteTargetIdField;
  resolving?: boolean;
  resolution?: {
    ok: boolean;
    name?: string;
    avatarUrl?: string;
    reason?: SubstituteTargetResolution['reason'];
  };
};

const substituteTargetIdFields: SubstituteTargetIdField[] = ['email', 'openId', 'userId', 'unionId'];

function parseSubstituteChats(text: string): string[] {
  const values = text.split(/[\r\n,，;；]+/).map(s => s.trim()).filter(Boolean);
  return [...new Set(values)];
}

function formatSubstituteChats(chats?: string[]): string {
  return (chats ?? []).join('\n');
}

function substituteTargetIdField(target?: BotSubstituteTarget): SubstituteTargetIdField {
  return substituteTargetIdFields.find(field => target?.[field]?.trim()) ?? 'email';
}

/**
 * Build the substitute target to PUT for one edited row. Returns null when the id value is
 * blank. When the id value/field was edited, every carried-over resolved id is dropped so the
 * server re-resolves the new value — otherwise `persisted` keeps a previously-resolved openId
 * alongside the email and the server (which prefers openId) would substitute the stale person.
 * An unchanged row keeps its resolved ids so the stable id is preserved.
 */
export function buildSubstituteTarget(
  row: Pick<SubstituteTargetDraft, 'idField' | 'idValue' | 'name' | 'persisted' | 'originalIdField'>,
): BotSubstituteTarget | null {
  const idValue = row.idValue.trim();
  if (!idValue) return null;
  const target: BotSubstituteTarget = { ...row.persisted };
  const idEdited = row.persisted[row.idField] !== idValue
    || (row.originalIdField != null && row.originalIdField !== row.idField);
  if (idEdited) {
    for (const field of substituteTargetIdFields) delete target[field];
  }
  target[row.idField] = idValue;
  const name = row.name.trim();
  if (name) target.name = name;
  else delete target.name;
  return target;
}

function brandStateLabel(brand: string | null, tr: ReturnType<typeof useT>): string {
  if (brand == null) return tr('botDefaults.brandStateDefault');
  return brand.trim() === '' ? tr('botDefaults.brandStateOff') : tr('botDefaults.brandStateCustom');
}

const GRANT_DURATION_VALUES = GRANT_DURATION_OPTIONS;

function sessionCapStateLabel(cap: number | null, tr: ReturnType<typeof useT>): string {
  return cap == null
    ? tr('botDefaults.maxLiveWorkersStateDefault')
    : tr('botDefaults.maxLiveWorkersStateOn', { count: cap });
}

function patchCardPrefsFromBody(bot: BotDefaultsRow, body: any): BotDefaultsRow {
  return {
    ...bot,
    usageDisplay: body.usageDisplay,
    disableStreamingCard: body.disableStreamingCard,
    silentTurnReactions: body.silentTurnReactions,
    codexAppCleanInput: body.codexAppCleanInput,
    writableTerminalLinkInCard: body.writableTerminalLinkInCard,
    privateCard: body.privateCard,
    summaryMemory: body.summaryMemory,
    summaryMemoryPath: body.summaryMemoryPath,
    botToBotSameDir: body.botToBotSameDir,
    autoStartOnGroupJoin: body.autoStartOnGroupJoin,
    autoStartOnGroupJoinPrompt: body.autoStartOnGroupJoinPrompt,
    autoStartOnNewTopic: body.autoStartOnNewTopic,
    regularGroupReplyMode: body.regularGroupReplyMode,
    regularGroupMentionMode: body.regularGroupMentionMode,
    docSubscribeDefaultMode: body.docSubscribeDefaultMode,
  };
}

export function BotDefaultsPage() {
  const tr = useT();
  const mountedRef = useRef(true);
  // Latest-wins guard: mount's first refresh() and bots.changed-triggered
  // refresh()es can overlap, so a slow earlier response must not clobber a
  // newer roster ("后发先回"). Only the latest in-flight request commits.
  const refreshGateRef = useRef(createRefreshGate());
  const [bots, setBots] = useState<BotDefaultsRow[]>([]);
  const [cliState, setCliState] = useState<CliOptionsState>(fallbackCliOptionsState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [profileRoleVersion, setProfileRoleVersion] = useState(0);
  const [, setAvatarVersion] = useState(0);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<BotDefaultsTab>('common');

  const refresh = useCallback(async (clearProfileRoles = false) => {
    if (clearProfileRoles) setProfileRoleVersion(version => version + 1);
    const req = refreshGateRef.current.begin();
    setLoading(true);
    try {
      const [nextBots, nextCli] = await Promise.all([fetchBotDefaults(), fetchCliOptions()]);
      // Drop a stale response: a newer refresh() started after us (e.g. a
      // bots.changed fired while this request was in flight) — committing here
      // would overwrite the fresher roster and re-hide the new bot.
      if (!mountedRef.current || !req.commit()) return;
      setBots(nextBots.bots);
      setLoadError(nextBots.error);
      setCliState(nextCli);
    } finally {
      // Only the latest request owns the loading flag — an out-of-order earlier
      // response must not flip loading off while the newest is still pending.
      if (mountedRef.current && req.commit()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    void loadNameMaps().then(() => {
      if (mountedRef.current) setAvatarVersion(value => value + 1);
    });
    // Auto-refresh the roster when a bot is added / removed / renamed on the
    // daemon side (SSE bots.changed), so the list stays live without a manual
    // reload. The bot rows carry their own botName/cliId from /api/bots, so a
    // plain refresh() is enough to surface a freshly-added bot.
    const offBots = store.onBotsChanged(() => {
      if (mountedRef.current) void refresh();
    });
    return () => { mountedRef.current = false; offBots(); };
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bots.filter(bot =>
      !q ||
      (bot.botName ?? '').toLowerCase().includes(q) ||
      (bot.larkAppId ?? '').toLowerCase().includes(q),
    );
  }, [bots, query]);

  useEffect(() => {
    if (loadError || loading) return;
    if (filtered.length === 0) {
      if (selectedAppId !== null) setSelectedAppId(null);
      return;
    }
    if (!selectedAppId || !filtered.some(bot => bot.larkAppId === selectedAppId)) {
      setSelectedAppId(filtered[0].larkAppId);
    }
  }, [filtered, loadError, loading, selectedAppId]);

  const selectedBot = selectedAppId ? filtered.find(bot => bot.larkAppId === selectedAppId) ?? null : null;

  const patchBot = useCallback<PatchBot>((appId, patch) => {
    setBots(rows => rows.map(bot => {
      if (bot.larkAppId !== appId) return bot;
      return typeof patch === 'function' ? patch(bot) : { ...bot, ...patch };
    }));
  }, []);

  const reload = async () => {
    setRefreshing(true);
    try {
      await refresh(true);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  let detail: ReactNode;
  if (loading) {
    detail = <LoadingState label={tr('common.loading')} />;
  } else if (loadError) {
    detail = (
      <p className="hint-warn">
        无法加载 bot 列表：{loadError}<br />
        常见原因：dashboard / daemon 进程还在跑旧代码，执行 <code>botmux restart</code> 后刷新。
      </p>
    );
  } else if (filtered.length === 0) {
    detail = <p className="empty">{tr('botDefaults.empty')}</p>;
  } else if (selectedBot) {
    detail = (
      <BotDefaultsCard
        key={`${selectedBot.larkAppId}:${profileRoleVersion}`}
        bot={selectedBot}
        cliState={cliState}
        patchBot={patchBot}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
    );
  } else {
    detail = null;
  }

  return (
    <section className="page bot-defaults-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.botDefaults')}</p>
          <h1>{tr('botDefaults.title')}</h1>
        </div>
        <div className="page-heading-actions">
          <RefreshIconButton id="bd-refresh" label={tr('botDefaults.refresh')} busy={refreshing} disabled={refreshing} onClick={() => void reload()} />
          {ui.authed ? (
            <CreateActionButton
              className="page-primary-action add-bot-btn"
              disabled={onboardingBusy}
              onClick={() => {
                setOnboardingBusy(true);
                void openBotOnboarding().finally(() => setOnboardingBusy(false));
              }}
            >
              {tr('botOnboarding.add')}
            </CreateActionButton>
          ) : null}
        </div>
      </div>
      <div className="bd-layout">
        <aside id="bd-roster" className="bd-roster">
          <form id="bd-filters" className="filters dashboard-toolbar" onSubmit={event => event.preventDefault()}>
            <input
              type="search"
              name="q"
              placeholder={tr('botDefaults.search')}
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
            />
          </form>
          <div className="bd-roster-meta">
            <span>{tr('botDefaults.rosterCount', { count: filtered.length })}</span>
            {query.trim() && filtered.length !== bots.length ? (
              <span>{tr('botDefaults.rosterFiltered', { total: bots.length })}</span>
            ) : null}
          </div>
          <div className="bd-roster-list">
            {!loadError && filtered.map(bot => (
              <RosterItem
                key={bot.larkAppId}
                bot={bot}
                selected={bot.larkAppId === selectedAppId}
                onSelect={() => setSelectedAppId(bot.larkAppId)}
              />
            ))}
          </div>
        </aside>
        <div id="bd-list" className="bd-detail">{detail}</div>
      </div>
    </section>
  );
}

function RosterItem(props: { bot: BotDefaultsRow; selected: boolean; onSelect(): void }) {
  const { bot } = props;
  const name = bot.botName ?? bot.larkAppId;
  const cli = displayCliId(bot, cliIdOf(bot.larkAppId));
  return (
    <div
      className={`bd-roster-item${props.selected ? ' on' : ''}`}
      data-appid={bot.larkAppId}
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onSelect();
        }
      }}
    >
      <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId, size: 'sm' })} />
      <div className="bd-roster-tx">
        <b><OverflowText text={name} showPopover={false} textClassName="bd-roster-name" /></b>
        <span>{cli || bot.larkAppId.slice(0, 14)}</span>
      </div>
      {bot.defaultOncall?.enabled ? <span className="bd-roster-flag">oncall</span> : null}
    </div>
  );
}

function BotDefaultsCard(props: {
  bot: BotDefaultsRow;
  cliState: CliOptionsState;
  patchBot: PatchBot;
  activeTab: BotDefaultsTab;
  onTabChange(tab: BotDefaultsTab): void;
}) {
  const tr = useT();
  const { bot, cliState, patchBot } = props;
  const name = bot.botName ?? bot.larkAppId;
  const cli = displayCliId(bot, cliIdOf(bot.larkAppId));

  const putCardPref = useCallback(async (patch: CardPrefPatch): Promise<JsonResponse> => {
    const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/card-prefs`, patch);
    if (res.ok) {
      patchBot(bot.larkAppId, current => patchCardPrefsFromBody(current, res.body));
    }
    return res;
  }, [bot.larkAppId, patchBot]);

  if (bot.error) {
    return (
      <article className="bd-card bd-profile" data-appid={bot.larkAppId}>
        <header className="bd-profile-head">
          <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId })} />
          <div className="bd-profile-id">
            <strong>{name}</strong>
            <code>{bot.larkAppId}</code>
          </div>
        </header>
        <p className="hint-warn-inline">查询失败：{bot.error}</p>
      </article>
    );
  }

  const def = bot.defaultOncall ?? { enabled: false, workingDir: '', since: 0 };

  return (
    <article className="bd-card bd-profile" data-appid={bot.larkAppId}>
      <div className="bd-profile-chrome">
        <header className="bd-profile-head">
          <BotAvatarControl bot={bot} name={name} patchBot={patchBot} />
          <div className="bd-profile-main">
            <BotProfileIdentity
              bot={bot}
              cli={cli}
              patchBot={patchBot}
              meta={(
                <>
                  <small className="bd-meta-ok">● {tr('botDefaults.metaOnline')}</small>
                  {(def.since ?? 0) > 0 ? <small data-oncall-since>{tr('botDefaults.lastEnabled')}: {fmtSince(def.since ?? 0)}</small> : null}
                  {(bot.autoboundChatCount ?? 0) > 0 ? <small>{tr('botDefaults.autobound', { count: bot.autoboundChatCount ?? 0 })}</small> : null}
                </>
              )}
            />
          </div>
        </header>
        <BotDefaultsTabs active={props.activeTab} onChange={props.onTabChange} />
      </div>
      <div className="bd-body bd-tab-panels">
        <div
          id="bd-panel-common"
          role="tabpanel"
          aria-labelledby="bd-tab-common"
          className="bd-tab-panel"
          hidden={props.activeTab !== 'common'}
        >
          <BdTabGrid>
            <section className="bd-tile">
              <BotAgentSection bot={bot} sessionFallback={cli} cliState={cliState} patchBot={patchBot} />
            </section>
            <section className="bd-tile">
              <WorkingDirSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} />
            </section>
            <section className="bd-tile"><RoleSection bot={bot} patchBot={patchBot} /></section>
          </BdTabGrid>
        </div>
        <div
          id="bd-panel-sessions"
          role="tabpanel"
          aria-labelledby="bd-tab-sessions"
          className="bd-tab-panel"
          hidden={props.activeTab !== 'sessions'}
        >
          <BdTabGrid>
            <section className="bd-tile"><SessionModeSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} /></section>
            <section className="bd-tile"><SubstituteModeSection bot={bot} patchBot={patchBot} /></section>
            <section className="bd-tile">
              <CrossBotSection bot={bot} putCardPref={putCardPref} />
            </section>
            <section className="bd-tile"><SessionCapSection bot={bot} patchBot={patchBot} /></section>
            <section className="bd-tile"><StartupCommandsSection bot={bot} patchBot={patchBot} /></section>
            <section className="bd-tile"><SummaryTriggerSection bot={bot} patchBot={patchBot} putCardPref={putCardPref} /></section>
          </BdTabGrid>
        </div>
        <div
          id="bd-panel-security"
          role="tabpanel"
          aria-labelledby="bd-tab-security"
          className="bd-tab-panel"
          hidden={props.activeTab !== 'security'}
        >
          <BdTabGrid>
            {/* riff 在远端沙箱执行、本地无 CLI 进程，文件沙盒对它无意义（worker 侧已旁路）。 */}
            {bot.cliId !== 'riff' ? (
              <section className="bd-tile"><SandboxSection bot={bot} patchBot={patchBot} /></section>
            ) : null}
            {bot.cliId !== 'riff' && bot.sandbox === true ? (
              <section className="bd-tile bd-tile-wide"><SandboxPathsSection bot={bot} patchBot={patchBot} /></section>
            ) : null}
            <section className="bd-tile"><GrantSection bot={bot} patchBot={patchBot} /></section>
            <section className="bd-tile"><SlashCommandPermissionsSection bot={bot} patchBot={patchBot} /></section>
          </BdTabGrid>
        </div>
        <div
          id="bd-panel-cards"
          role="tabpanel"
          aria-labelledby="bd-tab-cards"
          className="bd-tab-panel"
          hidden={props.activeTab !== 'cards'}
        >
          <BdTabGrid>
            <section className="bd-tile bd-tile-wide"><CardBehaviorSection bot={bot} putCardPref={putCardPref} /></section>
            <section className="bd-tile"><BrandSection bot={bot} patchBot={patchBot} /></section>
          </BdTabGrid>
        </div>
        <div
          id="bd-panel-advanced"
          role="tabpanel"
          aria-labelledby="bd-tab-advanced"
          className="bd-tab-panel"
          hidden={props.activeTab !== 'advanced'}
        >
          <BdTabGrid>
            {/* riff：backendType 与 CLI 选择 1:1 绑定（spawn 层强制配对），
                手动切 pty/tmux 只会制造坏组合，隐藏该区块。 */}
            {bot.cliId !== 'riff' ? (
              <section className="bd-tile"><BackendTypeSection bot={bot} patchBot={patchBot} /></section>
            ) : null}
            {/* Codex App 历史显示只对 codex-app agent 有意义（其它 CLI 无此渲染通道），
                选了别的 agent 就隐藏，避免无效开关。 */}
            {bot.cliId === 'codex-app' ? (
              <section className="bd-tile"><CodexAppDisplaySection bot={bot} putCardPref={putCardPref} /></section>
            ) : null}
            <section className="bd-tile"><RuntimeEnvironmentSection bot={bot} patchBot={patchBot} /></section>
          </BdTabGrid>
        </div>
      </div>
    </article>
  );
}

function RuntimeEnvironmentSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  return (
    <section className="bd-section bd-runtime-env">
      <h3 className="bd-section-title">{tr('botDefaults.sectionRuntimeEnv')}</h3>
      <LaunchShellSection bot={props.bot} patchBot={props.patchBot} />
      <EnvSection bot={props.bot} patchBot={props.patchBot} />
    </section>
  );
}

/** console 头像上传只实测过 512×512 PNG，前端统一归一化成这一形态再上传。 */
const AVATAR_UPLOAD_SIDE = 512;

/** 任意用户图片 → 512×512 PNG dataURL（短边 cover 裁剪居中）。 */
async function normalizeAvatarImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error('empty image');
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_UPLOAD_SIDE;
    canvas.height = AVATAR_UPLOAD_SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_UPLOAD_SIDE, AVATAR_UPLOAD_SIDE);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

/** 档案头头像：点击选图 → 归一化 → 走开放平台自动化真改飞书应用头像并发版。
 *  与改名同款失败语义：缺飞书 Web 登录态时给扫码入口，登录成功自动重试。 */
function BotAvatarControl(props: { bot: BotDefaultsRow; name: string; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, name, patchBot } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  // 待上传图片留到登录成功后重试；成功/明确失败时清掉。
  const pendingRef = useRef<string | null>(null);

  function avatarFailText(error: string, message?: string): string {
    const known = ['no_session', 'session_expired', 'no_access', 'unsupported_brand'];
    const detail = known.includes(error) ? tr(`botDefaults.avatarWarn.${error}`) : (message || error);
    return tr('botDefaults.avatarFailed', { error: detail });
  }

  const upload = useCallback(async (imageBase64: string) => {
    setBusy(true);
    setStatus({ text: `⏳ ${tr('botDefaults.avatarUploading')}`, ok: true });
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/avatar`, { imageBase64 });
      if (res.ok && res.body.ok) {
        const url = typeof res.body.avatarUrl === 'string' ? res.body.avatarUrl : '';
        if (url) overrideBotAvatar(bot.larkAppId, name, url);
        // 行内容不变，触发一次重绘让 orb 读到覆写后的头像映射。
        patchBot(bot.larkAppId, current => ({ ...current }));
        pendingRef.current = null;
        setLoginVisible(false);
        setStatus({ text: `✓ ${tr('botDefaults.avatarOkFeishu')}`, ok: true });
      } else {
        const err = String(res.body?.error ?? '');
        const message = typeof res.body?.message === 'string' ? res.body.message : undefined;
        setStatus({ text: `✗ ${avatarFailText(err, message ?? responseErrorText(res))}` });
        const needLogin = err === 'no_session' || err === 'session_expired';
        setLoginVisible(needLogin);
        if (!needLogin) pendingRef.current = null;
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${tr('botDefaults.avatarFailed', { error: caughtErrorText(e) })}` });
    } finally {
      setBusy(false);
    }
  }, [bot.larkAppId, name, patchBot, tr]);

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file || busy) return;
    // 归一化阶段就置 busy：canvas 解码大图有可感知耗时，这个窗口里不该还能
    // 再开一次选图/触发并发提交（服务端另有 per-app 串行队列兜底）。
    setBusy(true);
    let dataUrl: string;
    try {
      dataUrl = await normalizeAvatarImage(file);
    } catch {
      setBusy(false);
      setStatus({ text: `✗ ${tr('botDefaults.avatarBadImage')}` });
      return;
    }
    pendingRef.current = dataUrl;
    await upload(dataUrl);
  }

  return (
    <>
    <div className="bd-profile-avatar bd-avatar-editable" data-avatar-control>
      <button
        type="button"
        className="bd-avatar-btn"
        data-action="edit-bot-avatar"
        title={tr('botDefaults.avatarTitle')}
        aria-label={tr('botDefaults.avatarTitle')}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId, dot: 'ok' })} />
        <span className="bd-avatar-edit-badge" aria-hidden="true">{busy ? '⏳' : '✎'}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        data-input="botAvatarFile"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = ''; // 允许再次选择同一文件
          void handleFile(file);
        }}
      />
      {loginOpen ? (
        <FeishuLoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            setLoginVisible(false);
            setLoginOpen(false);
            if (pendingRef.current) void upload(pendingRef.current);
          }}
        />
      ) : null}
    </div>
    {/* Status renders as a full-width in-flow strip on the header's second grid
        row (not absolutely positioned under the avatar), so it never overlaps
        the name-status or the tab bar below. */}
    {status ? (
      <small className={statusClass(status, 'bd-avatar-status')} data-avatar-status>
        {status.text}
        {loginVisible ? (
          <button type="button" className="bd-feishu-login" data-action="feishu-login-avatar" onClick={() => setLoginOpen(true)}>{tr('feishuLogin.entry')}</button>
        ) : null}
      </small>
    ) : null}
    </>
  );
}

function BotProfileIdentity(props: { bot: BotDefaultsRow; cli: string; patchBot: PatchBot; meta?: ReactNode }) {
  const tr = useT();
  const { bot, cli, patchBot } = props;
  const name = bot.botName ?? bot.larkAppId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

  function setEditMode(on: boolean): void {
    setEditing(on);
    if (on) {
      setDraft(name);
      setStatus(null);
      setLoginVisible(false);
    }
  }

  function renameWarningText(warning: string, message?: string): string {
    const known = ['no_session', 'session_expired', 'no_access', 'unsupported_brand'];
    const detail = known.includes(warning)
      ? tr(`botDefaults.renameWarn.${warning}`)
      : (message || warning);
    return tr('botDefaults.renameLocalOnly', { reason: detail });
  }

  const submitRename = useCallback(async () => {
    const nextName = draft.trim();
    if (!nextName) {
      setStatus({ text: `✗ ${tr('botDefaults.renameEmpty')}` });
      return;
    }
    setBusy(true);
    setStatus({ text: `⏳ ${tr('botDefaults.renaming')}`, ok: true });
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/rename`, { name: nextName });
      if (res.ok && res.body.ok) {
        const effective = typeof res.body.botName === 'string' && res.body.botName ? res.body.botName : nextName;
        patchBot(bot.larkAppId, current => ({
          ...current,
          botName: effective,
          larkBotName: res.body.mode === 'feishu' ? nextName : current.larkBotName,
          displayName: res.body.mode === 'feishu' ? null : nextName,
        }));
        setEditMode(false);
        if (res.body.mode === 'feishu') {
          setStatus({ text: `✓ ${tr('botDefaults.renameOkFeishu')}`, ok: true });
          setLoginVisible(false);
        } else {
          setStatus({ text: `⚠ ${renameWarningText(String(res.body.warning ?? ''), res.body.message)}` });
          setLoginVisible(res.body.warning === 'no_session' || res.body.warning === 'session_expired');
        }
      } else {
        setStatus({ text: `✗ ${tr('botDefaults.renameFailed', { error: responseErrorText(res) })}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${tr('botDefaults.renameFailed', { error: caughtErrorText(e) })}` });
    } finally {
      setBusy(false);
    }
  }, [bot.larkAppId, draft, patchBot, tr]);

  return (
    <div className="bd-profile-id">
      {!editing ? (
        <div className="bd-profile-title-row" data-name-row>
          <div className="bd-profile-title-content">
            <strong data-bot-name>{name}</strong>
            {cli ? <span className="mate-role bd-profile-cli-tag">{cli}</span> : null}
            {props.meta ? <span className="bd-profile-meta bd-meta">{props.meta}</span> : null}
          </div>
          <button
            type="button"
            className="bd-name-edit"
            data-action="edit-bot-name"
            title={tr('botDefaults.renameTitle')}
            aria-label={tr('botDefaults.renameTitle')}
            onClick={() => setEditMode(true)}
          >
            {/* Inline pencil SVG instead of a ✎ text glyph: the glyph's ink is
                asymmetric within its em-box so flexbox centering left it visibly
                off-center. An SVG centers by geometry. */}
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z" />
            </svg>
          </button>
        </div>
      ) : (
        <span className="bd-name-editor" data-name-editor>
          <input
            type="text"
            className="bd-name-input"
            data-input="botRename"
            maxLength={64}
            value={draft}
            disabled={busy}
            autoFocus
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitRename();
              } else if (event.key === 'Escape') {
                setEditMode(false);
              }
            }}
          />
          <button type="button" className="primary" data-action="save-bot-name" disabled={busy} onClick={() => void submitRename()}>{tr('botDefaults.renameSave')}</button>
          <button type="button" data-action="cancel-bot-name" disabled={busy} onClick={() => setEditMode(false)}>{tr('botDefaults.renameCancel')}</button>
        </span>
      )}
      <div className="bd-profile-appid-row">
        <code>{bot.larkAppId}</code>
        {larkConsoleUrl(bot.larkAppId, bot.brand) ? (
          <a
            className="bd-console-link"
            href={larkConsoleUrl(bot.larkAppId, bot.brand)!}
            target="_blank"
            rel="noopener noreferrer"
          >
            {tr('botDefaults.openConsole')}
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        ) : null}
      </div>
      <small className={statusClass(status, 'bd-name-status')} data-name-status>{status?.text ?? ''}</small>
      <button type="button" className="bd-feishu-login" data-action="feishu-login" hidden={!loginVisible} onClick={() => setLoginOpen(true)}>{tr('feishuLogin.entry')}</button>
      {loginOpen ? (
        <FeishuLoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            setLoginVisible(false);
            setLoginOpen(false);
            void submitRename();
          }}
        />
      ) : null}
    </div>
  );
}

function FeishuLoginModal(props: { onClose(): void; onSuccess(): void }) {
  const tr = useT();
  const { onClose, onSuccess } = props;
  const timerRef = useRef<number | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const [hint, setHint] = useState(tr('feishuLogin.starting'));
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const renderLogin = useCallback((login: any): 'active' | 'done' => {
    if (!login) return 'active';
    if (login.status === 'awaiting_scan' && login.qrDataUrl) {
      setQrDataUrl(login.qrDataUrl);
      setHint(login.message || tr('feishuLogin.scanHint'));
      setRetry(false);
      return 'active';
    }
    if (login.status === 'starting') {
      setHint(login.message || tr('feishuLogin.starting'));
      setQrDataUrl(null);
      setRetry(false);
      return 'active';
    }
    if (login.status === 'success') {
      stopTimer();
      setQrDataUrl(null);
      setRetry(false);
      setHint(tr('feishuLogin.success'));
      successTimerRef.current = window.setTimeout(() => onSuccess(), 900);
      return 'done';
    }
    stopTimer();
    setQrDataUrl(null);
    setHint(tr('feishuLogin.failed', { reason: login.message || login.reason || '' }));
    setRetry(true);
    return 'done';
  }, [onSuccess, stopTimer, tr]);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/feishu-login/status');
      const body = await r.json().catch(() => ({}));
      renderLogin(body.login);
    } catch {
      // transient; keep polling
    }
  }, [renderLogin]);

  const begin = useCallback(async () => {
    stopTimer();
    setHint(tr('feishuLogin.starting'));
    setQrDataUrl(null);
    setRetry(false);
    let phase: 'active' | 'done' = 'active';
    try {
      const r = await fetch('/api/feishu-login/start', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      phase = renderLogin(body.login);
    } catch (e: any) {
      setHint(tr('feishuLogin.failed', { reason: caughtErrorText(e) }));
      setRetry(true);
      return;
    }
    if (phase === 'active' && timerRef.current === null) {
      timerRef.current = window.setInterval(() => void poll(), 1500);
    }
  }, [poll, renderLogin, stopTimer, tr]);

  useEffect(() => {
    void begin();
    return () => {
      stopTimer();
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    };
  }, [begin, stopTimer]);

  if (typeof document === 'undefined') return null;

  // Portal 到 body:此弹层内联渲染在头像组件(位于 .page 页面容器)的 DOM 里。
  // 祖先 .page 有 `animation: dashboard-page-enter … both`,其关键帧动画 transform
  // (translateY→none);fill-mode:both 下动画结束后持续「填充」,浏览器把 .page 的
  // computed transform 算成 identity matrix(而非关键字 none)——「非 none 的 transform」
  // 会为后代 position:fixed 建立包含块,于是弹层不再相对视口、被约束进 .page 的几何
  // 范围,顶到视口下方,用户得滚动才看得到二维码(与主题无关,light/dark 均复现;
  // 注意不是 .app-shell 的 overflow:hidden——overflow 不建立 fixed 包含块)。挂到
  // body 顶层后逃出任何祖先包含块,与 auth-expired-overlay 一致,稳定居中。
  return createPortal(
    <div
      className="feishu-login-overlay"
      onClick={event => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="feishu-login-modal" role="dialog" aria-modal="true">
        <button type="button" className="feishu-login-close" data-close aria-label={tr('feishuLogin.close')} onClick={onClose}>x</button>
        <h3 className="feishu-login-title">{tr('feishuLogin.title')}</h3>
        <p className="feishu-login-hint" data-hint>{hint}</p>
        <div className="feishu-login-qr" data-qr>
          {qrDataUrl ? <img className="qr-image" src={qrDataUrl} alt={tr('feishuLogin.qrAlt')} /> : null}
        </div>
        <div className="feishu-login-actions">
          <button type="button" className="primary" data-retry hidden={!retry} onClick={() => void begin()}>{tr('feishuLogin.retry')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function BotAgentSection(props: {
  bot: BotDefaultsRow;
  sessionFallback: string;
  cliState: CliOptionsState;
  patchBot: PatchBot;
}) {
  const tr = useT();
  const { bot, cliState, patchBot } = props;
  const initialKey = agentSelectionKey(bot, props.sessionFallback);
  const runtimeConfigKey = JSON.stringify([bot.cliRuntime ?? null, bot.cliPathOverride ?? null]);
  const [cliKey, setCliKey] = useState(initialKey);
  const [cliSelectionTouched, setCliSelectionTouched] = useState(false);
  const [model, setModel] = useState(typeof bot.model === 'string' ? bot.model : '');
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeDraft>(() => runtimeDraftFromBot(bot));
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<StatusMessage>(null);
  const [agentStatus, setAgentStatus] = useState<StatusMessage>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [skillValue, setSkillValue] = useState(skillInjectionResolved(bot));
  const [skillStatus, setSkillStatus] = useState<StatusMessage>(null);
  const [skillBusy, setSkillBusy] = useState(false);

  useEffect(() => {
    setCliKey(agentSelectionKey(bot, props.sessionFallback));
    setCliSelectionTouched(false);
    setModel(typeof bot.model === 'string' ? bot.model : '');
    setRuntimeDraft(runtimeDraftFromBot(bot));
    setRuntimeTouched(false);
    setSkillValue(skillInjectionResolved(bot));
  }, [
    bot.agentSelectionKey,
    bot.cliId,
    bot.larkAppId,
    bot.model,
    runtimeConfigKey,
    bot.wrapperCli,
    bot.skillInjection,
    bot.skillInjectionDefault,
    props.sessionFallback,
  ]);

  const option = selectedCliOption(cliState.options, cliKey);
  const suggestions = modelSuggestionsForOption(option, cliState);
  const modelDisabledByCli = option?.gateway === 'ttadk' && option.acceptsModel === false;
  const modelPlaceholder = modelDisabledByCli
    ? tr('botOnboarding.modelTtadkCocoPlaceholder')
    : option?.gateway === 'ttadk'
      ? tr('botOnboarding.modelTtadkPlaceholder').replace('{model}', cliState.ttadkModelDefault)
      : tr('botDefaults.agentModelPlaceholder');

  function updateCli(nextKey: string): void {
    const previousKey = cliKey;
    setCliKey(nextKey);
    setCliSelectionTouched(true);
    if (nextKey !== previousKey && (nextKey !== 'codex' || previousKey !== 'codex')) {
      setRuntimeDraft(runtimeDraftFromBot({ cliRuntime: null, cliPathOverride: null }));
      // If the user leaves Codex and comes back before saving, the visible
      // Official state is intentional and must clear the old runtime/path.
      setRuntimeTouched(true);
      setRuntimeStatus(null);
    }
    const nextOption = selectedCliOption(cliState.options, nextKey);
    const isTtadk = nextOption?.gateway === 'ttadk';
    const acceptsModel = isTtadk && nextOption.acceptsModel !== false;
    if (isTtadk && !acceptsModel) {
      setModel('');
    } else if (acceptsModel) {
      setModel(current => current.trim() ? current : cliState.ttadkModelDefault);
    } else {
      setModel(current => current.trim() === cliState.ttadkModelDefault ? '' : current);
    }
  }

  function updateRuntimeMode(mode: RuntimeMode): void {
    setRuntimeDraft(current => ({ ...current, mode }));
    setRuntimeTouched(true);
    setRuntimeStatus(null);
    setAgentStatus(null);
  }

  function updateRuntimeDraft(patch: Partial<Omit<RuntimeDraft, 'mode'>>): void {
    setRuntimeDraft(current => ({ ...current, ...patch }));
    setRuntimeTouched(true);
    setRuntimeStatus(null);
    setAgentStatus(null);
  }

  async function saveAgent(): Promise<void> {
    setAgentStatus(null);
    setRuntimeStatus(null);
    let cliRuntime: CliRuntimeConfig | null | undefined;
    if (runtimeTouched) cliRuntime = null;
    if (runtimeTouched && cliKey === 'codex' && runtimeDraft.mode === 'custom') {
      const id = runtimeDraft.id.trim();
      const executable = runtimeDraft.executable.trim();
      const displayName = runtimeDraft.displayName.trim();
      const packageName = runtimeDraft.packageName.trim();
      if (!id || !executable) {
        const text = tr('botDefaults.runtimeRequired');
        setAgentStatus({ text });
        setRuntimeStatus({ text });
        return;
      }
      if (runtimeDraft.updateProvider === 'npm' && !packageName) {
        const text = tr('botDefaults.runtimePackageRequired');
        setAgentStatus({ text });
        setRuntimeStatus({ text });
        return;
      }
      cliRuntime = {
        id,
        ...(displayName ? { displayName } : {}),
        executable,
        update: runtimeDraft.updateProvider === 'npm'
          ? { provider: 'npm', packageName }
          : { provider: runtimeDraft.updateProvider },
      };
    }
    setAgentBusy(true);
    try {
      const body = {
        cliId: cliKey,
        model,
        ...(runtimeTouched ? { cliRuntime } : {}),
      };
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/agent`, body);
      if (res.ok && res.body.ok) {
        const summary = parseAgentSwitchSummary(res.body);
        const closedCount = summary.closed;
        const residualCount = summary.residual;
        const failedCount = summary.failed;
        // Localised, not hardcoded: this component is already tr()-driven, so a
        // raw Chinese string would reach an English dashboard.
        const notes = [
          closedCount > 0 ? tr('botDefaults.agentClosedCount', { count: closedCount }) : '',
          // Closed, but their remote sessions are still running.
          residualCount > 0 ? tr('botDefaults.agentClosedResidual', { count: residualCount }) : '',
          // Not closed at all — the rows are still active.
          failedCount > 0 ? tr('botDefaults.agentCloseFailed', { count: failedCount }) : '',
          // The ids are the ONLY handle for manual cleanup; a count alone is not
          // actionable. Malformed/blank entries render as `unknown` rather than
          // silently disappearing.
          residualIdText(summary, tr),
        ].filter(Boolean);
        const closedText = notes.join(' · ');
        // `hasResidual` (count OR ids), not the count alone — a payload carrying
        // only ids must still lose the green tick.
        const hadProblem = summary.hasResidual || failedCount > 0;
        setAgentStatus(res.body.availabilityWarning
          ? { text: `⚠️ ${res.body.availabilityWarning}${closedText ? ` · ${closedText}` : ''}` }
          : hadProblem
            // Never the green tick when a session is still active or a remote
            // session survived: that is what made this invisible.
            ? { text: `⚠️ ${closedText}` }
            : { text: `✓ ${closedText || tr('botDefaults.agentSaved')}`, ok: true });
        patchBot(bot.larkAppId, {
          cliId: res.body.cliId,
          cliRuntime: res.body.cliRuntime === undefined
            ? runtimeTouched ? cliRuntime ?? null : bot.cliRuntime ?? null
            : res.body.cliRuntime,
          cliPathOverride: res.body.cliPathOverride === undefined
            ? runtimeTouched ? null : bot.cliPathOverride ?? null
            : res.body.cliPathOverride,
          wrapperCli: res.body.wrapperCli ?? null,
          model: res.body.model ?? '',
          agentSelectionKey: res.body.selectionKey ?? cliKey,
        });
        setRuntimeTouched(false);
        if (cliRuntime) {
          const probe = res.body.runtimeProbe;
          if (probe && typeof probe.version === 'string') {
            setRuntimeStatus({
              text: tr('botDefaults.runtimeProbeOk', {
                version: probe.version,
                provider: typeof probe.updateProvider === 'string' ? probe.updateProvider : runtimeDraft.updateProvider,
              }),
              ok: true,
            });
          } else {
            setRuntimeStatus({ text: tr('botDefaults.runtimeProbeMissing') });
          }
        }
      } else {
        // The switch transaction refused: say what actually happened rather than
        // surfacing a bare error code — the config is unchanged, some rows closed,
        // and some remote sessions may need manual cleanup.
        // Both post-close exits: the switch aborted because a close failed, OR the
        // closes ran and the config commit failed. Either way some rows are closed
        // and their remote ids are only reported here.
        const aborted = res.body?.error === 'agent_switch_close_failed'
          || res.body?.error === 'agent_switch_commit_failed';
        const abortSummary = parseAgentSwitchSummary(res.body);
        const detail = aborted
          ? [
            tr('botDefaults.agentSwitchAborted', {
              closed: abortSummary.closed,
              failed: abortSummary.failed,
            }),
            residualIdText(abortSummary, tr),
          ].filter(Boolean).join(' · ')
          : typeof res.body?.message === 'string' && res.body.message
            ? res.body.message
            : responseErrorText(res);
        const text = `✗ ${detail}`;
        setAgentStatus({ text });
        if (cliKey === 'codex' && runtimeDraft.mode === 'custom') setRuntimeStatus({ text });
      }
    } catch (e: any) {
      const text = `✗ ${caughtErrorText(e)}`;
      setAgentStatus({ text });
      if (cliKey === 'codex' && runtimeDraft.mode === 'custom') setRuntimeStatus({ text });
    } finally {
      setAgentBusy(false);
    }
  }

  /**
   * Persist the CLI selection as riff before saving riff config. Selecting
   * riff in the dropdown hides the「保存 Agent」button (model/skill rows are
   * replaced by RiffSection), so without this the cliId change would never
   * reach PUT /agent — the bot would stay on its old CLI and backendType
   * would never auto-flip to riff. Returns false when persisting failed.
   */
  /**
   * Riff's save reuses PUT /agent, so it inherits the SAME close transaction —
   * including a residual (rows closed, remote still running) and an aborted
   * switch. It must return that to the caller instead of a bare boolean:
   * `setAgentStatus` is rendered in the `!isRiff` branch, so anything written
   * there while Riff is selected is invisible.
   */
  async function persistRiffCliSelection(): Promise<CliPersistOutcome> {
    if (bot.cliId === 'riff') return { ok: true, hadProblem: false, note: '' };
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/agent`, { cliId: 'riff', model: '' });
      const summary = parseAgentSwitchSummary(res.body);
      if (res.ok && res.body.ok) {
        patchBot(bot.larkAppId, {
          cliId: res.body.cliId,
          cliRuntime: res.body.cliRuntime ?? null,
          wrapperCli: res.body.wrapperCli ?? null,
          model: res.body.model ?? '',
          agentSelectionKey: res.body.selectionKey ?? 'riff',
        });
        const note = [
          summary.residual > 0 ? tr('botDefaults.agentClosedResidual', { count: summary.residual }) : '',
          residualIdText(summary, tr),
        ].filter(Boolean).join(' · ');
        return { ok: true, hadProblem: summary.hasResidual, note };
      }
      // Aborted switch (close refused, or commit failed after closes ran): the
      // config did NOT change and some remote sessions may need manual cleanup.
      const aborted = res.body?.error === 'agent_switch_close_failed'
        || res.body?.error === 'agent_switch_commit_failed';
      const note = aborted
        ? [
          // Riff-specific wording: by this point the /riff write already
          // succeeded, so "config unchanged" would be false here — only the
          // Agent selection failed to switch.
          tr('botDefaults.riffAgentSwitchAborted', { closed: summary.closed, failed: summary.failed }),
          residualIdText(summary, tr),
        ].filter(Boolean).join(' · ')
        : responseErrorText(res);
      return { ok: false, hadProblem: true, note };
    } catch (e: any) {
      return { ok: false, hadProblem: true, note: caughtErrorText(e) };
    }
  }

  async function saveSkillInjection(next: string): Promise<void> {
    setSkillValue(next);
    setSkillStatus(null);
    setSkillBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/skill-injection`, { skillInjection: next });
      if (res.ok && res.body.ok) {
        setSkillStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
        patchBot(bot.larkAppId, { skillInjection: res.body.skillInjection ?? null });
      } else {
        setSkillStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setSkillStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setSkillBusy(false);
    }
  }

  const siSupport = bot.skillInjectionSupport === 'dynamic' ? 'dynamic' : bot.skillInjectionSupport === 'global' ? 'global' : 'none';
  const isRiff = cliKey === 'riff';
  // Old dashboard payloads can omit agentSelectionKey while still carrying a
  // legacy wrapperCli. Keep the custom-runtime editor hidden until the user
  // explicitly selects bare Codex; structured runtimes and wrappers cannot mix.
  const isBareCodex = cliKey === 'codex' && (!bot.wrapperCli || cliSelectionTouched);
  const usesAlternativeCodexExecutable = isBareCodex && runtimeDraft.mode !== 'official';

  // 与添加机器人弹窗一致：按名称首字母排序，便于在 20+ 个 CLI 里定位。
  const cliOptions = [...cliState.options]
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))
    .map(option => ({
      value: option.id,
      label: option.available === false && !(option.id === 'codex' && usesAlternativeCodexExecutable)
        ? tr('botDefaults.agentMissingOption', { label: option.label, command: option.command ?? option.id })
        : `${option.label}（${option.id}）`,
    }));
  const dynamicSkillOptions = [
    { value: 'dynamic', label: tr('botDefaults.skillInjectionDynamic') },
  ];
  const skillOptions = [
    // Non-selectable cue: dynamic injection isn't available for this CLI (parity with the old UI).
    { value: 'dynamic', label: tr('botDefaults.skillInjectionDynamicUnsupported'), disabled: true },
    { value: 'prompt', label: tr('botDefaults.skillInjectionPrompt') },
    { value: 'global', label: tr('botDefaults.skillInjectionGlobal') },
    { value: 'off', label: tr('botDefaults.skillInjectionOff') },
  ];
  const runtimeProviderOptions: DropdownFieldOption<CliRuntimeUpdateProvider>[] = [
    { value: 'auto', label: tr('botDefaults.runtimeProviderAuto') },
    { value: 'self', label: tr('botDefaults.runtimeProviderSelf') },
    { value: 'npm', label: tr('botDefaults.runtimeProviderNpm') },
    { value: 'none', label: tr('botDefaults.runtimeProviderNone') },
  ];

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionAgent')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <span>{tr('botDefaults.agentCli')}</span>
          <DropdownField
            dataInput="agentCliId"
            ariaLabel={tr('botDefaults.agentCli')}
            value={cliKey}
            disabled={agentBusy}
            options={cliOptions}
            searchable
            onChange={updateCli}
          />
          {option?.available === false && !usesAlternativeCodexExecutable ? (
            <small className="hint-warn">
              {tr('botDefaults.agentMissingHint', { command: option.command ?? cliKey })}
            </small>
          ) : null}
        </div>
      </div>
      {isBareCodex ? (
        <div className="bd-codex-runtime" data-codex-runtime="">
          <div className="bd-runtime-heading">
            <FieldTitle help={tr('botDefaults.runtimeHelp')}>{tr('botDefaults.runtimeTitle')}</FieldTitle>
          </div>
          <div className="bd-runtime-mode" role="group" aria-label={tr('botDefaults.runtimeTitle')}>
            <button
              type="button"
              data-action="runtime-official"
              aria-pressed={runtimeDraft.mode === 'official'}
              disabled={agentBusy}
              onClick={() => updateRuntimeMode('official')}
            >
              {tr('botDefaults.runtimeOfficial')}
            </button>
            <button
              type="button"
              data-action="runtime-custom"
              aria-pressed={runtimeDraft.mode === 'custom'}
              disabled={agentBusy}
              onClick={() => updateRuntimeMode('custom')}
            >
              {tr('botDefaults.runtimeCustom')}
            </button>
          </div>
          <input type="hidden" data-input="agentRuntimeMode" value={runtimeDraft.mode} readOnly />
          <p className="bd-runtime-note">
            {tr(runtimeDraft.mode === 'official'
              ? 'botDefaults.runtimeOfficialNote'
              : runtimeDraft.mode === 'legacy'
                ? 'botDefaults.runtimeLegacyNote'
                : 'botDefaults.runtimeCustomNote')}
          </p>
          {runtimeDraft.mode === 'legacy' ? (
            <div className="bd-runtime-fields" data-runtime-legacy="">
              <label className="bd-runtime-wide">
                <span>{tr('botDefaults.runtimeLegacyPath')}</span>
                <input
                  type="text"
                  value={runtimeDraft.legacyPath}
                  readOnly
                  aria-readonly="true"
                  data-input="agentRuntimeLegacyPath"
                />
              </label>
            </div>
          ) : null}
          {runtimeDraft.mode === 'custom' ? (
            <div className="bd-runtime-fields">
              <label>
                <FieldTitle help={tr('botDefaults.runtimeIdHelp')}>{tr('botDefaults.runtimeId')}</FieldTitle>
                <input
                  type="text"
                  data-input="agentRuntimeId"
                  value={runtimeDraft.id}
                  disabled={agentBusy}
                  autoComplete="off"
                  onChange={event => updateRuntimeDraft({ id: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>{tr('botDefaults.runtimeDisplayName')}</span>
                <input
                  type="text"
                  data-input="agentRuntimeDisplayName"
                  placeholder={tr('botDefaults.runtimeDisplayNamePlaceholder')}
                  value={runtimeDraft.displayName}
                  disabled={agentBusy}
                  autoComplete="off"
                  onChange={event => updateRuntimeDraft({ displayName: event.currentTarget.value })}
                />
              </label>
              <label className="bd-runtime-wide">
                <FieldTitle help={tr('botDefaults.runtimeExecutableHelp')}>{tr('botDefaults.runtimeExecutable')}</FieldTitle>
                <input
                  type="text"
                  data-input="agentRuntimeExecutable"
                  value={runtimeDraft.executable}
                  disabled={agentBusy}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={event => updateRuntimeDraft({ executable: event.currentTarget.value })}
                />
              </label>
              <div className="bd-field">
                <span>{tr('botDefaults.runtimeUpdateProvider')}</span>
                <DropdownField
                  dataInput="agentRuntimeUpdateProvider"
                  ariaLabel={tr('botDefaults.runtimeUpdateProvider')}
                  value={runtimeDraft.updateProvider}
                  disabled={agentBusy}
                  options={runtimeProviderOptions}
                  onChange={updateProvider => updateRuntimeDraft({ updateProvider })}
                />
              </div>
              {runtimeDraft.updateProvider === 'npm' ? (
                <label>
                  <FieldTitle help={tr('botDefaults.runtimePackageHelp')}>{tr('botDefaults.runtimePackageName')}</FieldTitle>
                  <input
                    type="text"
                    data-input="agentRuntimePackageName"
                    value={runtimeDraft.packageName}
                    disabled={agentBusy}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => updateRuntimeDraft({ packageName: event.currentTarget.value })}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          <StatusSpan status={runtimeStatus} attr={{ 'data-runtime-status': '' }} />
        </div>
      ) : null}
      {!isRiff && (
        <div className="bd-row">
          <label>
            <FieldTitle help={tr('botDefaults.agentHelp')}>{tr('botDefaults.agentModel')}</FieldTitle>
            <input
              type="text"
              data-input="agentModel"
              list={`agent-model-suggestions-${bot.larkAppId}`}
              placeholder={modelPlaceholder}
              value={model}
              disabled={agentBusy || modelDisabledByCli}
              onChange={event => setModel(event.currentTarget.value)}
            />
            <datalist id={`agent-model-suggestions-${bot.larkAppId}`}>
              {suggestions.map(item => <option value={item} key={item} />)}
            </datalist>
          </label>
        </div>
      )}
      {isRiff && <RiffSection bot={bot} patchBot={patchBot} persistCliSelection={persistRiffCliSelection} />}
      {!isRiff && siSupport === 'dynamic' ? (
        <div className="bd-row">
          <div className="bd-field">
            <FieldTitle help={tr('botDefaults.skillInjectionHelpDynamic')}>{tr('botDefaults.skillInjection')}</FieldTitle>
            <DropdownField
              dataInput="skillInjection"
              ariaLabel={tr('botDefaults.skillInjection')}
              value="dynamic"
              disabled
              options={dynamicSkillOptions}
              onChange={() => undefined}
            />
          </div>
        </div>
      ) : !isRiff && siSupport === 'global' ? (
        <div className="bd-row">
          <div className="bd-field">
            <FieldTitle help={tr('botDefaults.skillInjectionHelp')}>{tr('botDefaults.skillInjection')}</FieldTitle>
            <DropdownField
              dataInput="skillInjection"
              ariaLabel={tr('botDefaults.skillInjection')}
              value={skillValue}
              disabled={skillBusy}
              options={skillOptions}
              onChange={next => void saveSkillInjection(next)}
            />
          </div>
          <div className="actions">
            <StatusSpan status={skillStatus} attr={{ 'data-skill-injection-status': '' }} />
          </div>
        </div>
      ) : null}
      {!isRiff && (
        <div className="actions bd-section-actions">
          <button type="button" className="primary" data-action="save-agent" disabled={agentBusy} onClick={() => void saveAgent()}>{tr('botDefaults.agentSave')}</button>
          <StatusSpan status={agentStatus} attr={{ 'data-agent-status': '' }} />
        </div>
      )}
    </section>
  );
}

function skillInjectionResolved(bot: BotDefaultsRow): string {
  const override = bot.skillInjection === 'global' || bot.skillInjection === 'prompt' || bot.skillInjection === 'off' ? bot.skillInjection : '';
  const def = bot.skillInjectionDefault === 'global' || bot.skillInjectionDefault === 'off' ? bot.skillInjectionDefault : 'prompt';
  return override || def;
}

function WorkingDirSection(props: {
  bot: BotDefaultsRow;
  patchBot: PatchBot;
  putCardPref(patch: CardPrefPatch): Promise<JsonResponse>;
}) {
  const tr = useT();
  const { bot, patchBot } = props;
  const initial = workingDirState(bot);
  const [mode, setMode] = useState(initial.mode);
  const [workingDir, setWorkingDir] = useState(initial.workingDir);
  const [autoWorktree, setAutoWorktree] = useState(bot.defaultWorkingDirAutoWorktree === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = workingDirState(bot);
    setMode(next.mode);
    setWorkingDir(next.workingDir);
    setAutoWorktree(bot.defaultWorkingDirAutoWorktree === true);
  }, [
    bot.defaultOncall?.enabled,
    bot.defaultOncall?.workingDir,
    bot.defaultWorkingDir,
    bot.defaultWorkingDirAutoWorktree,
  ]);

  async function save(): Promise<void> {
    setStatus(null);
    const dir = workingDir.trim();
    if (mode !== 'off' && !dir) {
      setStatus({ text: tr('botDefaults.required') });
      return;
    }
    const nextAutoWorktree = mode === 'default' && autoWorktree;
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/working-dir-mode`, {
        mode,
        workingDir: dir,
        autoWorktree: nextAutoWorktree,
      });
      if (res.ok && res.body.ok) {
        const resolvedNote = res.body.resolvedPath ? ` → ${res.body.resolvedPath}` : '';
        setStatus({ text: `✓ ${tr('botDefaults.workingDirSaved')}${resolvedNote}`, ok: true });
        patchBot(bot.larkAppId, {
          defaultOncall: res.body.defaultOncall ?? bot.defaultOncall,
          defaultWorkingDir: res.body.defaultWorkingDir ?? null,
          defaultWorkingDirAutoWorktree: res.body.defaultWorkingDirAutoWorktree === true,
        });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const modeOptions: DropdownFieldOption<'off' | 'default' | 'oncall'>[] = [
    { value: 'off', label: tr('botDefaults.workingDirModeOff') },
    { value: 'default', label: tr('botDefaults.workingDirModeDefault') },
    { value: 'oncall', label: tr('botDefaults.workingDirModeOncall') },
  ];

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionWorkingDir')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.workingDirModeHelp')}>{tr('botDefaults.workingDirMode')}</FieldTitle>
          <DropdownField
            dataInput="workingDirMode"
            ariaLabel={tr('botDefaults.workingDirMode')}
            value={mode}
            disabled={busy}
            options={modeOptions}
            onChange={next => setMode(next as 'off' | 'default' | 'oncall')}
          />
        </div>
      </div>
      <div className="bd-row" data-wd-dir-row hidden={mode === 'off'}>
        <label>
          <span>{tr('botDefaults.workingDirField')}</span>
          <input type="text" data-input="workingDir" placeholder="e.g. /root/iserver/botmux" value={workingDir} disabled={busy} onChange={event => setWorkingDir(event.currentTarget.value)} />
        </label>
      </div>
      <label className="toggle-row" data-wd-worktree-row hidden={mode !== 'default'}>
        <input type="checkbox" data-input="autoWorktree" checked={autoWorktree} disabled={busy} onChange={event => setAutoWorktree(event.currentTarget.checked)} />
        <span className="switch" aria-hidden="true" />
        <span className="toggle-tx"><strong><FieldTitle help={tr('botDefaults.autoWorktreeHelp')}>{tr('botDefaults.autoWorktree')}</FieldTitle></strong></span>
      </label>
      <div className="actions">
        <button type="button" className="primary" data-action="save-working-dir" disabled={busy} onClick={() => void save()}>{tr('botDefaults.save')}</button>
        <StatusSpan status={status} attr={{ 'data-status': '' }} />
      </div>
      <AutoStartControls bot={bot} putCardPref={props.putCardPref} />
    </section>
  );
}

function workingDirState(bot: BotDefaultsRow): { mode: 'off' | 'default' | 'oncall'; workingDir: string } {
  const def = bot.defaultOncall ?? { enabled: false, workingDir: '' };
  const mode = def.enabled ? 'oncall' : (bot.defaultWorkingDir ? 'default' : 'off');
  return { mode, workingDir: bot.defaultWorkingDir || def.workingDir || '' };
}

function AutoStartControls(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const { bot, putCardPref } = props;
  const [onJoin, setOnJoin] = useState(bot.autoStartOnGroupJoin === true);
  const [onTopic, setOnTopic] = useState(bot.autoStartOnNewTopic === true);
  const [prompt, setPrompt] = useState(typeof bot.autoStartOnGroupJoinPrompt === 'string' ? bot.autoStartOnGroupJoinPrompt : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setOnJoin(bot.autoStartOnGroupJoin === true);
    setOnTopic(bot.autoStartOnNewTopic === true);
    setPrompt(typeof bot.autoStartOnGroupJoinPrompt === 'string' ? bot.autoStartOnGroupJoinPrompt : '');
  }, [bot.autoStartOnGroupJoin, bot.autoStartOnGroupJoinPrompt, bot.autoStartOnNewTopic]);

  async function savePatch(patch: CardPrefPatch, key: string): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await putCardPref(patch);
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title">{tr('botDefaults.sectionAutoStart')}</h4>
      <ToggleRow
        checked={onJoin}
        disabled={busy === 'join'}
        dataAction="toggle-auto-join"
        title={tr('botDefaults.autoStartJoin')}
        help={tr('botDefaults.autoStartJoinHelp')}
        onChange={checked => {
          setOnJoin(checked);
          void savePatch({ autoStartOnGroupJoin: checked }, 'join');
        }}
      />
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.autoStartJoinPrompt')}</span>
          <textarea data-input="autoJoinPrompt" rows={3} placeholder={tr('botDefaults.autoStartJoinPromptPlaceholder')} value={prompt} onChange={event => setPrompt(event.currentTarget.value)} />
        </label>
      </div>
      <ToggleRow
        checked={onTopic}
        disabled={busy === 'topic'}
        dataAction="toggle-auto-topic"
        title={tr('botDefaults.autoStartTopic')}
        help={tr('botDefaults.autoStartTopicHelp')}
        onChange={checked => {
          setOnTopic(checked);
          void savePatch({ autoStartOnNewTopic: checked }, 'topic');
        }}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-auto-join-prompt" disabled={busy === 'prompt'} onClick={() => void savePatch({ autoStartOnGroupJoinPrompt: prompt }, 'prompt')}>
          {tr('botDefaults.autoStartJoinPromptSave')}
        </button>
        <StatusSpan status={status} attr={{ 'data-auto-start-status': '' }} />
      </div>
    </div>
  );
}

function SandboxSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [enabled, setEnabled] = useState(bot.sandbox === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setEnabled(bot.sandbox === true), [bot.sandbox]);

  async function toggle(next: boolean): Promise<void> {
    setEnabled(next);
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/sandbox`, { enabled: next });
      if (res.ok && res.body.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.sandboxSaved')}`, ok: true });
        patchBot(bot.larkAppId, { sandbox: res.body.sandbox === true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
        setEnabled(!next);
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  }

  // The unified fs-policy always provides deny-by-default file read/write
  // isolation. This capability line is narrower: whether the CLI's global data
  // root can additionally be redirected into this bot's private BOT_HOME
  // (claude/codex, no wrapper), keeping CLI credentials/config/history separate
  // from sibling bots. Keep that distinction explicit in the UI copy.
  const readIsoSupported = bot.readIsolationSupported === true;
  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSandbox')}</h3>
      <ToggleRow
        checked={enabled}
        disabled={busy}
        dataAction="toggle-sandbox"
        title={tr('botDefaults.sandboxToggle')}
        help={tr('botDefaults.sandboxHelp')}
        onChange={checked => void toggle(checked)}
      />
      <p className="bd-section-note" data-read-iso-capability={readIsoSupported ? 'yes' : 'no'}>
        {readIsoSupported ? `＋ ${tr('botDefaults.sandboxReadIsoOn')}` : tr('botDefaults.sandboxReadIsoOff')}
      </p>
      <div className="actions">
        <StatusSpan status={status} attr={{ 'data-sandbox-status': '' }} />
      </div>
    </section>
  );
}

// ── Sandbox paths (three-tier whitelist) ──────────────────────────────────────
type SandboxTier = 'readWrite' | 'readOnly' | 'deny';
type SandboxTiers = { readWrite: string[]; readOnly: string[]; deny: string[] };

/** Restrictiveness ranking — mirrors fs-policy.ts RESTRICTIVENESS so a same-path
 *  cross-tier conflict resolves the SAME way the sandbox will (deny > ro > rw). */
const SBX_RESTRICTIVENESS: Record<SandboxTier, number> = { readWrite: 0, readOnly: 1, deny: 2 };

/** Effective access for `path` under the three tiers: DEEPEST (longest-prefix)
 *  matching rule wins; at equal depth (same path across tiers) the MORE
 *  RESTRICTIVE tier wins — mirrors fs-policy.ts accessForPath + mergeFsRules so
 *  the UI's live labels + path tester agree with what the sandbox enforces.
 *  `home` expands a leading `~` the same way the worker does before matching, so
 *  `~`-relative entries line up with absolute tree nodes. */
export function effectiveAccess(tiers: SandboxTiers, path: string, home: string): { access: SandboxTier | 'none'; rule?: string } {
  const expand = (p: string) => (p === '~' || p.startsWith('~/')) ? home.replace(/\/+$/, '') + p.slice(1) : p;
  const norm = (p: string) => expand(p).replace(/\/+$/, '') || '/';
  const target = norm(path);
  const covers = (parent: string, child: string) => {
    const a = norm(parent), b = norm(child);
    return a === b || b.startsWith(a === '/' ? '/' : a + '/');
  };
  const depth = (p: string) => norm(p) === '/' ? 0 : norm(p).split('/').filter(Boolean).length;
  let best: { access: SandboxTier; ruleDepth: number; rule: string } | undefined;
  const consider = (access: SandboxTier, rule: string) => {
    if (!covers(rule, target)) return;
    const d = depth(rule);
    if (!best || d > best.ruleDepth
      || (d === best.ruleDepth && SBX_RESTRICTIVENESS[access] > SBX_RESTRICTIVENESS[best.access])) {
      best = { access, ruleDepth: d, rule };
    }
  };
  for (const p of tiers.readWrite) consider('readWrite', p);
  for (const p of tiers.readOnly) consider('readOnly', p);
  for (const p of tiers.deny) consider('deny', p);
  return best ? { access: best.access, rule: best.rule } : { access: 'none' };
}

function emptyTiers(): SandboxTiers { return { readWrite: [], readOnly: [], deny: [] }; }
function normTiers(t?: BotDefaultsRow['sandboxPaths']): SandboxTiers {
  if (!t) return emptyTiers();
  return { readWrite: [...(t.readWrite ?? [])], readOnly: [...(t.readOnly ?? [])], deny: [...(t.deny ?? [])] };
}
function tiersEqual(a: SandboxTiers, b: SandboxTiers): boolean {
  const k = (x: string[]) => [...x].sort().join('\n');
  return k(a.readWrite) === k(b.readWrite) && k(a.readOnly) === k(b.readOnly) && k(a.deny) === k(b.deny);
}
/** Serialize tiers to the copy-paste text form (one path per line, tier-tagged). */
function tiersToText(t: SandboxTiers): string {
  const lines: string[] = [];
  for (const p of t.readWrite) lines.push(`rw  ${p}`);
  for (const p of t.readOnly) lines.push(`ro  ${p}`);
  for (const p of t.deny) lines.push(`deny ${p}`);
  return lines.join('\n');
}
/** Parse the copy-paste text form back into tiers. Tolerates `rw`/`readWrite`,
 *  `ro`/`readOnly`, `deny`/`-`; blank lines and `#` comments are ignored. */
function textToTiers(text: string): SandboxTiers {
  const t = emptyTiers();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const path = m[2].trim();
    if (tag === 'rw' || tag === 'readwrite' || tag === 'rw:') t.readWrite.push(path);
    else if (tag === 'ro' || tag === 'readonly' || tag === 'ro:') t.readOnly.push(path);
    else if (tag === 'deny' || tag === '-' || tag === 'deny:') t.deny.push(path);
  }
  return t;
}

function SandboxPathsSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [tiers, setTiers] = useState<SandboxTiers>(() => normTiers(bot.sandboxPaths));
  const [text, setText] = useState<string>(() => tiersToText(normTiers(bot.sandboxPaths)));
  const [textMode, setTextMode] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  const [testPath, setTestPath] = useState('');
  // Lazy directory tree: path → child dir list (undefined = not yet loaded).
  const [children, setChildren] = useState<Record<string, { name: string; path: string }[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([]);
  // Canonical $HOME (first fs-list root) — used to expand `~` in tiers/tester
  // the SAME way the worker does, so `~`-relative entries match absolute tree
  // nodes and effective-access labels are accurate.
  const [homeRoot, setHomeRoot] = useState<string>('~');

  const saved = useMemo(() => normTiers(bot.sandboxPaths), [bot.sandboxPaths]);
  useEffect(() => { setTiers(normTiers(bot.sandboxPaths)); setText(tiersToText(normTiers(bot.sandboxPaths))); }, [bot.sandboxPaths]);
  const dirty = !tiersEqual(tiers, saved);

  const loadDir = useCallback(async (path: string) => {
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : '';
      const r = await fetch(`/api/fs/list${q}`);
      const j = await r.json();
      if (!j.ok) return;
      if (!path) {
        setRoots(j.entries.map((e: any) => ({ name: e.name, path: e.path })));
        // Backend returns canonical $HOME explicitly (realpath'd) so `~` expansion
        // here matches the realpath'd child nodes + the worker's sandbox binds.
        if (typeof j.home === 'string' && j.home.startsWith('/')) setHomeRoot(j.home);
      } else setChildren(prev => ({ ...prev, [path]: j.entries.map((e: any) => ({ name: e.name, path: e.path })) }));
    } catch { /* listing is best-effort; manual/text entry still works */ }
  }, []);
  useEffect(() => { if (!textMode && roots.length === 0) void loadDir(''); }, [textMode, roots.length, loadDir]);

  // The tier a path is EXPLICITLY set to (undefined = inherits from ancestor).
  const explicitTier = useCallback((path: string): SandboxTier | undefined => {
    const n = path.replace(/\/+$/, '') || '/';
    if (tiers.readWrite.some(p => (p.replace(/\/+$/, '') || '/') === n)) return 'readWrite';
    if (tiers.readOnly.some(p => (p.replace(/\/+$/, '') || '/') === n)) return 'readOnly';
    if (tiers.deny.some(p => (p.replace(/\/+$/, '') || '/') === n)) return 'deny';
    return undefined;
  }, [tiers]);

  // Cycle a node: inherit → readWrite → readOnly → deny → inherit.
  const cycleNode = useCallback((path: string) => {
    setStatus(null);
    const n = path.replace(/\/+$/, '') || '/';
    const cur = explicitTier(path);
    const next: SandboxTier | undefined =
      cur === undefined ? 'readWrite' : cur === 'readWrite' ? 'readOnly' : cur === 'readOnly' ? 'deny' : undefined;
    setTiers(prev => {
      const strip = (arr: string[]) => arr.filter(p => (p.replace(/\/+$/, '') || '/') !== n);
      const t: SandboxTiers = { readWrite: strip(prev.readWrite), readOnly: strip(prev.readOnly), deny: strip(prev.deny) };
      if (next) t[next].push(path);
      setText(tiersToText(t));
      return t;
    });
  }, [explicitTier]);

  function syncFromText(next: string) {
    setText(next);
    setTiers(textToTiers(next));
    setStatus(null);
  }

  async function save() {
    setBusy(true); setStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/sandbox-paths`, tiers);
      if (res.ok && res.body.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.sbxPathsSaved')}`, ok: true });
        patchBot(bot.larkAppId, { sandboxPaths: res.body.sandboxPaths ?? { readWrite: [], readOnly: [], deny: [] } });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const tierBadge = (a: SandboxTier | 'none') =>
    a === 'readWrite' ? tr('botDefaults.sbxRw')
    : a === 'readOnly' ? tr('botDefaults.sbxRo')
    : a === 'deny' ? tr('botDefaults.sbxDeny')
    : tr('botDefaults.sbxNone');

  function TreeNode(props: { name: string; path: string; depth: number }): ReactNode {
    const { name, path, depth } = props;
    const isOpen = expanded.has(path);
    const explicit = explicitTier(path);
    const eff = effectiveAccess(tiers, path, homeRoot);
    const kids = children[path];
    return (
      <div className="bd-sbx-node">
        <div className="bd-sbx-row" style={{ paddingLeft: depth * 16 }}>
          <span
            className="bd-sbx-twisty"
            onClick={() => {
              setExpanded(prev => { const s = new Set(prev); s.has(path) ? s.delete(path) : s.add(path); return s; });
              if (!kids) void loadDir(path);
            }}
          >{isOpen ? '▾' : '▸'}</span>
          <span className="bd-sbx-name" title={path}>{name}</span>
          <button
            type="button"
            className={`bd-sbx-state bd-sbx-state-${explicit ?? 'inherit'}`}
            data-action="cycle-sandbox-path"
            data-path={path}
            title={explicit ? undefined : `${tr('botDefaults.sbxInherit')}: ${tierBadge(eff.access)}`}
            onClick={() => cycleNode(path)}
          >
            {explicit ? tierBadge(explicit) : `↳ ${tierBadge(eff.access)}`}
          </button>
        </div>
        {isOpen && (
          <div className="bd-sbx-kids">
            {kids?.map(c => <TreeNode key={c.path} name={c.name} path={c.path} depth={depth + 1} />)}
            {kids && kids.length === 0 && (
              <div className="bd-sbx-empty" style={{ paddingLeft: (depth + 1) * 16 + 20 }}>{tr('botDefaults.sbxNoSubdirs')}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  const testResult = testPath.trim() ? effectiveAccess(tiers, testPath.trim(), homeRoot) : null;

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSandboxPaths')}</h3>
      <p className="bd-section-note">{tr('botDefaults.sbxPathsHelp')}</p>
      <div className="actions" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="bd-btn" onClick={() => setTextMode(m => !m)}>
          {textMode ? tr('botDefaults.sbxPathsTreeMode') : tr('botDefaults.sbxPathsTextMode')}
        </button>
      </div>

      {textMode ? (
        <textarea
          className="bd-sbx-text"
          data-field="sandbox-paths-text"
          rows={8}
          value={text}
          spellCheck={false}
          placeholder={'rw  ~/my-data\nro  ~/reference-repos\ndeny ~/my-data/secrets'}
          onChange={e => syncFromText(e.target.value)}
        />
      ) : (
        <div className="bd-sbx-tree" data-field="sandbox-paths-tree">
          {roots.map(r => <TreeNode key={r.path} name={r.name} path={r.path} depth={0} />)}
        </div>
      )}

      <div className="bd-sbx-tester">
        <input
          className="bd-sbx-test-input"
          data-field="sandbox-path-test"
          placeholder={tr('botDefaults.sbxTestPlaceholder')}
          value={testPath}
          onChange={e => setTestPath(e.target.value)}
        />
        {testResult && (
          <span className={`bd-sbx-test-out bd-sbx-state-${testResult.access}`} data-test-access={testResult.access}>
            {tierBadge(testResult.access)}{testResult.rule ? ` ← ${testResult.rule}` : ''}
          </span>
        )}
      </div>

      <div className="actions">
        <button type="button" className="bd-btn bd-btn-primary" data-action="save-sandbox-paths" disabled={busy || !dirty} onClick={() => void save()}>
          {tr('botDefaults.sbxPathsSave')}
        </button>
        <StatusSpan status={status} attr={{ 'data-sandbox-paths-status': '' }} />
      </div>
    </section>
  );
}

const BACKEND_TYPE_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: '', labelKey: 'botDefaults.backendAuto' },
  { value: 'tmux', labelKey: 'botDefaults.backendTmux' },
  { value: 'herdr', labelKey: 'botDefaults.backendHerdr' },
  { value: 'zellij', labelKey: 'botDefaults.backendZellij' },
  { value: 'zmx', labelKey: 'botDefaults.backendZmx' },
  { value: 'pty', labelKey: 'botDefaults.backendPty' },
];

function BackendTypeSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [value, setValue] = useState(typeof bot.backendType === 'string' ? bot.backendType : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof bot.backendType === 'string' ? bot.backendType : ''), [bot.backendType]);

  const options = useMemo(() => BACKEND_TYPE_OPTIONS.map(o => ({ value: o.value, label: tr(o.labelKey) })), [tr]);

  async function save(next: string): Promise<void> {
    const prev = value;
    setValue(next);
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(bot.larkAppId)}/backend-type`, { backendType: next });
      if (res.ok && res.body.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.backendSaved')}`, ok: true });
        patchBot(bot.larkAppId, { backendType: typeof res.body.backendType === 'string' ? res.body.backendType : null });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
        setValue(prev);  // revert optimistic selection
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
      setValue(prev);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionBackend')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.backendHelp')}>{tr('botDefaults.backendLabel')}</FieldTitle>
          <DropdownField
            dataInput="backendType"
            ariaLabel={tr('botDefaults.backendLabel')}
            value={value}
            disabled={busy}
            options={options}
            onChange={next => void save(next)}
          />
        </div>
        <div className="actions">
          <StatusSpan status={status} attr={{ 'data-backend-status': '' }} />
        </div>
      </div>
    </section>
  );
}

function RoleSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const { bot, patchBot } = props;
  const [loaded, setLoaded] = useState(typeof bot.teamRole === 'string');
  const [role, setRole] = useState(typeof bot.teamRole === 'string' ? bot.teamRole : '');
  const [injectMode, setInjectMode] = useState<RoleInjectMode>('every');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const roleUrl = `/api/team/local-bots/${encodeURIComponent(bot.larkAppId)}/role`;
    if (typeof bot.teamRole === 'string') {
      // Already resolved (incl. right after our own save, which patchBot's teamRole
      // re-fires this effect) — sync the field but DON'T clear status, or the freshly
      // set "✓ 已保存/已删除" toast gets wiped a frame later.
      setLoaded(true);
      setRole(bot.teamRole);
      return () => { active = false; };
    }
    setStatus(null);
    setLoaded(false);
    setRole('');
    void (async () => {
      try {
        const r = await fetch(roleUrl);
        const body = await r.json().catch(() => ({}));
        if (!active) return;
        if (r.ok && body.ok) {
          const next = body.role ?? '';
          setRole(next);
          setInjectMode(body.injectMode === 'once' ? 'once' : 'every');
          setLoaded(true);
          patchBot(bot.larkAppId, { teamRole: next });
        } else {
          setStatus({ text: `✗ ${tr('botDefaults.roleLoadErr')}: ${body.error ?? r.status}` });
        }
      } catch (e: any) {
        if (active) setStatus({ text: `✗ ${tr('botDefaults.roleLoadErr')}: ${caughtErrorText(e)}` });
      }
    })();
    return () => { active = false; };
  }, [bot.larkAppId, bot.teamRole, patchBot, tr]);

  // injectMode isn't cached on the bot row, so when the team role is already
  // resolved (cache hit above skips the GET) fetch just the mode once per bot.
  useEffect(() => {
    let active = true;
    if (typeof bot.teamRole !== 'string') return () => { active = false; };
    void (async () => {
      try {
        const r = await fetch(`/api/team/local-bots/${encodeURIComponent(bot.larkAppId)}/role`);
        const body = await r.json().catch(() => ({}));
        if (active && r.ok && body.ok) setInjectMode(body.injectMode === 'once' ? 'once' : 'every');
      } catch { /* keep default 'every' */ }
    })();
    return () => { active = false; };
  }, [bot.larkAppId]);

  async function putRole(nextRole: string, deleted: boolean, mode: RoleInjectMode = injectMode): Promise<void> {
    if (!loaded) return;
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/team/local-bots/${encodeURIComponent(bot.larkAppId)}/role`, { role: nextRole, injectMode: mode });
      if (res.ok && res.body.ok) {
        const stored = nextRole.trim();
        setRole(stored);
        if (res.body.injectMode === 'once' || res.body.injectMode === 'every') setInjectMode(res.body.injectMode);
        patchBot(bot.larkAppId, { teamRole: stored });
        setStatus({ text: `✓ ${deleted ? tr('botDefaults.roleDeleted') : tr('botDefaults.roleSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const injectOptions: Array<{ value: RoleInjectMode; label: string }> = [
    { value: 'every', label: tr('roles.injectModeEvery') },
    { value: 'once', label: tr('roles.injectModeOnce') },
  ];

  return (
    <section className="bd-section">
      <h3 className="bd-section-title"><FieldTitle help={tr('botDefaults.roleHelp')}>{tr('botDefaults.sectionRole')}</FieldTitle></h3>
      <textarea
        data-input="teamRole"
        rows={6}
        placeholder={tr('botDefaults.rolePlaceholder')}
        disabled={!loaded || busy}
        value={role}
        onChange={event => setRole(event.currentTarget.value)}
      />
      <div className="bd-role-inject">
        <span className="bd-subsection-title"><FieldTitle help={tr('roles.injectModeHint')}>{tr('roles.injectModeLabel')}</FieldTitle></span>
        <DropdownMenu<RoleInjectMode>
          id={`bd-role-inject-${bot.larkAppId}`}
          className="bd-role-inject-menu"
          ariaLabel={tr('roles.injectModeLabel')}
          disabled={!loaded || busy}
          label={dropdownLabel(injectOptions, injectMode)}
          value={injectMode}
          options={injectOptions}
          onChange={mode => { const next = mode === 'once' ? 'once' : 'every'; setInjectMode(next); void putRole(role, role.trim() === '', next); }}
        />
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-role" disabled={!loaded || busy} onClick={() => void putRole(role, role.trim() === '')}>{tr('botDefaults.roleSave')}</button>
        <StatusSpan status={status} attr={{ 'data-role-status': '' }} />
      </div>
      <ProfileRoles appId={bot.larkAppId} />
    </section>
  );
}

function ProfileRoles(props: { appId: string }) {
  const tr = useT();
  const [state, setState] = useState<BotProfileRoleState>({ loaded: false, loading: true, items: [] });

  useEffect(() => {
    let active = true;
    setState({ loaded: false, loading: true, items: [] });
    void (async () => {
      try {
        const r = await fetch('/api/role-profiles');
        const body = await r.json().catch(() => ({}));
        if (!active) return;
        if (!r.ok) throw new Error(body?.error ?? String(r.status));
        const profiles = Array.isArray(body.profiles) ? body.profiles : [];
        const items = profiles
          .filter((profile: any) => (profile.botEntries ?? []).some((entry: any) =>
            entry?.larkAppId === props.appId && entry?.hasEntry,
          ))
          .map((profile: any) => ({ profileId: String(profile.profileId) }));
        setState({
          loaded: true,
          loading: false,
          items,
        });
      } catch (e: any) {
        if (active) setState({ loaded: true, loading: false, error: caughtErrorText(e), items: [] });
      }
    })();
    return () => { active = false; };
  }, [props.appId]);

  async function loadDetail(profileId: string): Promise<void> {
    const item = state.items.find(entry => entry.profileId === profileId);
    if (!item || item.loaded || item.loading) return;
    setState(current => ({
      ...current,
      items: current.items.map(entry => entry.profileId === profileId ? { ...entry, loading: true } : entry),
    }));
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(props.appId)}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? String(r.status));
      setState(current => ({
        ...current,
        items: current.items.map(entry => entry.profileId === profileId
          ? { ...entry, loading: false, loaded: true, content: body?.hasEntry ? String(body.content ?? '') : '' }
          : entry),
      }));
    } catch (e: any) {
      setState(current => ({
        ...current,
        items: current.items.map(entry => entry.profileId === profileId ? { ...entry, loading: false, error: caughtErrorText(e) } : entry),
      }));
    }
  }

  let body: ReactNode;
  if (state.loading) body = <LoadingState label={tr('common.loading')} compact />;
  else if (state.error) body = <p className="hint-warn-inline">{tr('botDefaults.profileRolesLoadFailed', { error: state.error })}</p>;
  else if (state.items.length === 0) body = <p className="empty">{tr('botDefaults.profileRolesEmpty')}</p>;
  else {
    body = state.items.map(item => (
      <details
        className="bd-profile-role-entry"
        data-profile-id={item.profileId}
        key={item.profileId}
        onToggle={event => {
          if (event.currentTarget.open) void loadDetail(item.profileId);
        }}
      >
        <summary><span className="bd-profile-role-id">{item.profileId}</span></summary>
        <div className="bd-profile-role-content" data-profile-role-body={item.profileId}>
          {item.loading ? <LoadingState label={tr('common.loading')} compact /> : item.error ? (
            <p className="hint-warn-inline">{tr('botDefaults.profileRoleDetailLoadFailed', { error: item.error })}</p>
          ) : item.loaded ? (
            <pre>{item.content ?? ''}</pre>
          ) : (
            <p className="empty">{tr('botDefaults.profileRoleClickToLoad')}</p>
          )}
        </div>
      </details>
    ));
  }

  return (
    <div className="bd-profile-roles" data-profile-roles>
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.profileRolesHelp')}>{tr('botDefaults.profileRoles')}</FieldTitle></h4>
      <div className="bd-profile-role-list" data-profile-role-list>{body}</div>
    </div>
  );
}

export function CardBehaviorSection(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const { bot, putCardPref } = props;
  const [usageDisplay, setUsageDisplay] = useState<'streaming' | 'footer' | 'off'>(bot.usageDisplay ?? 'streaming');
  const [disableStreaming, setDisableStreaming] = useState(bot.disableStreamingCard === true);
  const [silentReactions, setSilentReactions] = useState(bot.silentTurnReactions === true);
  const [writableLink, setWritableLink] = useState(bot.writableTerminalLinkInCard === true);
  const [privateCard, setPrivateCard] = useState(bot.privateCard === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setUsageDisplay(bot.usageDisplay ?? 'streaming');
    setDisableStreaming(bot.disableStreamingCard === true);
    setSilentReactions(bot.silentTurnReactions === true);
    setWritableLink(bot.writableTerminalLinkInCard === true);
    setPrivateCard(bot.privateCard === true);
  }, [bot.disableStreamingCard, bot.privateCard, bot.usageDisplay, bot.silentTurnReactions, bot.writableTerminalLinkInCard]);

  async function savePatch(patch: CardPrefPatch, key: string, rollback?: () => void): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await putCardPref(patch);
      if (res.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        rollback?.();
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      rollback?.();
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const usageDisplayOptions: DropdownFieldOption<'streaming' | 'footer' | 'off'>[] = [
    { value: 'streaming', label: tr('botDefaults.usageDisplayStreaming') },
    { value: 'footer', label: tr('botDefaults.usageDisplayFooter') },
    { value: 'off', label: tr('botDefaults.usageDisplayOff') },
  ];
  return (
    <section className="bd-section" aria-busy={busy !== null}>
      <h3 className="bd-section-title">{tr('botDefaults.sectionCard')}</h3>
      <div className="bd-card-settings">
        <section className="bd-card-setting-group" data-card-feedback-group>
          <h4 className="bd-card-setting-heading">{tr('botDefaults.cardFeedbackGroup')}</h4>
          <ToggleRow
            className="bd-card-primary-toggle"
            checked={!disableStreaming}
            disabled={busy !== null}
            dataAction="toggle-disable-streaming"
            title={tr('botDefaults.autoStreaming')}
            description={tr('botDefaults.autoStreamingDescription')}
            help={tr('botDefaults.autoStreamingHelp')}
            onChange={checked => {
              const previous = disableStreaming;
              const nextDisabled = !checked;
              setDisableStreaming(nextDisabled);
              void savePatch({ disableStreamingCard: nextDisabled }, 'streaming', () => setDisableStreaming(previous));
            }}
          />
          <div className="bd-card-dependent" data-card-off-options hidden={!disableStreaming}>
            <ToggleRow
              checked={!silentReactions}
              disabled={busy !== null}
              dataAction="toggle-silent-reactions"
              title={tr('botDefaults.silentTurnReactions')}
              description={tr('botDefaults.silentTurnReactionsDescription')}
              help={tr('botDefaults.silentTurnReactionsHelp')}
              onChange={checked => {
                const previous = silentReactions;
                const nextSilent = !checked;
                setSilentReactions(nextSilent);
                void savePatch({ silentTurnReactions: nextSilent }, 'silent', () => setSilentReactions(previous));
              }}
            />
            <p role="status" data-card-pref-moot className="bd-card-mode-note">{tr('botDefaults.manualCardHint')}</p>
          </div>
        </section>

        <section className="bd-card-setting-group" data-card-content-group>
          <h4 className="bd-card-setting-heading">{tr('botDefaults.cardContentGroup')}</h4>
          {bot.usageSupported === true && (
            <div className="bd-row">
              <div className="bd-field">
                <FieldTitle help={tr('botDefaults.usageDisplayHelp')}>{tr('botDefaults.usageDisplay')}</FieldTitle>
                <DropdownField
                  dataInput="usageDisplay"
                  ariaLabel={tr('botDefaults.usageDisplay')}
                  value={usageDisplay}
                  disabled={busy !== null}
                  options={usageDisplayOptions}
                  onChange={next => {
                    const previous = usageDisplay;
                    setUsageDisplay(next);
                    void savePatch(
                      { usageDisplay: next },
                      'usage',
                      () => setUsageDisplay(previous),
                    );
                  }}
                />
              </div>
            </div>
          )}
          <div className="bd-card-control-list">
            <ToggleRow
              checked={writableLink}
              disabled={busy !== null}
              dataAction="toggle-writable-link"
              title={tr('botDefaults.writableLink')}
              description={tr('botDefaults.writableLinkDescription')}
              help={tr('botDefaults.writableLinkHelp')}
              onChange={checked => {
                const previous = writableLink;
                setWritableLink(checked);
                void savePatch({ writableTerminalLinkInCard: checked }, 'writable', () => setWritableLink(previous));
              }}
            />
          </div>
        </section>

        <section className="bd-card-setting-group" data-card-manual-group>
          <h4 className="bd-card-setting-heading">{tr('botDefaults.cardManualGroup')}</h4>
          <p className="bd-card-setting-copy">{tr('botDefaults.manualCardIntro')}</p>
          <div className="bd-card-control-list">
            <ToggleRow
              checked={privateCard}
              disabled={busy !== null}
              dataAction="toggle-private-card"
              title={tr('botDefaults.privateCard')}
              description={tr('botDefaults.privateCardDescription')}
              help={tr('botDefaults.privateCardHelp')}
              onChange={checked => {
                const previous = privateCard;
                setPrivateCard(checked);
                void savePatch({ privateCard: checked }, 'private', () => setPrivateCard(previous));
              }}
            />
          </div>
        </section>
      </div>
      <div className="actions">
        <StatusSpan status={status} attr={{ 'data-card-pref-status': '' }} />
      </div>
    </section>
  );
}

export function CodexAppDisplaySection(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const [cleanInput, setCleanInput] = useState(props.bot.codexAppCleanInput === true);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCleanInput(props.bot.codexAppCleanInput === true), [props.bot.codexAppCleanInput]);

  async function save(checked: boolean): Promise<void> {
    const previous = cleanInput;
    setCleanInput(checked);
    setBusy(true);
    setStatus(null);
    try {
      const res = await props.putCardPref({ codexAppCleanInput: checked });
      if (res.ok) {
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setCleanInput(previous);
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setCleanInput(previous);
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section" data-codex-app-display>
      <h3 className="bd-section-title">{tr('botDefaults.sectionCodexAppDisplay')}</h3>
      <ToggleRow
        checked={cleanInput}
        disabled={busy}
        dataAction="toggle-codex-app-clean-input"
        title={tr('botDefaults.codexAppCleanInput')}
        help={tr('botDefaults.codexAppCleanInputHelp')}
        onChange={checked => void save(checked)}
      />
      <small className="bd-section-note">{tr('botDefaults.codexAppCleanInputCompat')}</small>
      <div className="actions">
        <StatusSpan status={status} attr={{ 'data-codex-app-clean-input-status': '' }} />
      </div>
    </section>
  );
}

function CrossBotSection(props: { bot: BotDefaultsRow; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const [sameDir, setSameDir] = useState(props.bot.botToBotSameDir !== false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setSameDir(props.bot.botToBotSameDir !== false), [props.bot.botToBotSameDir]);

  async function save(next: boolean): Promise<void> {
    setSameDir(next);
    setBusy(true);
    setStatus(null);
    try {
      const res = await props.putCardPref({ botToBotSameDir: next });
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionCrossBot')}</h3>
      <ToggleRow
        checked={sameDir}
        disabled={busy}
        dataAction="toggle-cross-bot-samedir"
        title={tr('botDefaults.botToBotSameDir')}
        help={tr('botDefaults.botToBotSameDirHelp')}
        onChange={checked => void save(checked)}
      />
      <div className="actions"><StatusSpan status={status} attr={{ 'data-crossbot-status': '' }} /></div>
    </section>
  );
}

function SummaryTriggerSection(props: { bot: BotDefaultsRow; patchBot: PatchBot; putCardPref(patch: CardPrefPatch): Promise<JsonResponse> }) {
  const tr = useT();
  const initial = summaryRange(props.bot);
  const [limit, setLimit] = useState(String(initial.limit));
  const [sinceHours, setSinceHours] = useState(String(initial.sinceHours));
  const [memoryOn, setMemoryOn] = useState(props.bot.summaryMemory === true);
  const [memoryPath, setMemoryPath] = useState(summaryMemoryPath(props.bot));
  const [status, setStatus] = useState<StatusMessage>(null);
  const [memoryStatus, setMemoryStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);

  useEffect(() => {
    const next = summaryRange(props.bot);
    setLimit(String(next.limit));
    setSinceHours(String(next.sinceHours));
    setMemoryOn(props.bot.summaryMemory === true);
    setMemoryPath(summaryMemoryPath(props.bot));
  }, [props.bot.summaryRange?.limit, props.bot.summaryRange?.sinceHours, props.bot.summaryMemory, props.bot.summaryMemoryPath]);

  async function save(): Promise<void> {
    setStatus(null);
    const nextLimit = nonNegativeInteger(limit, 50);
    const nextSinceHours = nonNegativeInteger(sinceHours, 24);
    if (nextLimit == null || nextSinceHours == null) {
      setStatus({ text: `✗ ${tr('botDefaults.summaryNumberInvalid')}` });
      return;
    }
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/summary-range`, {
        limit: nextLimit,
        sinceHours: nextSinceHours,
      });
      if (res.ok && res.body.ok) {
        const next = res.body.summaryRange ?? { limit: nextLimit, sinceHours: nextSinceHours };
        const normalized = summaryRange({ ...props.bot, summaryRange: next });
        setLimit(String(normalized.limit));
        setSinceHours(String(normalized.sinceHours));
        props.patchBot(props.bot.larkAppId, { summaryRange: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function saveMemory(next: boolean, nextPath = memoryPath): Promise<void> {
    const prev = memoryOn;
    const prevPath = memoryPath;
    const normalizedPath = normalizeSummaryMemoryPath(nextPath);
    setMemoryOn(next);
    setMemoryPath(normalizedPath);
    setMemoryStatus(null);
    setMemoryBusy(true);
    try {
      const res = await props.putCardPref({ summaryMemory: next, summaryMemoryPath: normalizedPath });
      if (res.ok && res.body.ok) {
        const saved = res.body.summaryMemory === true;
        const savedPath = summaryMemoryPath({ ...props.bot, summaryMemoryPath: res.body.summaryMemoryPath });
        setMemoryOn(saved);
        setMemoryPath(savedPath);
        props.patchBot(props.bot.larkAppId, { summaryMemory: saved, summaryMemoryPath: savedPath });
        setMemoryStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setMemoryOn(prev);
        setMemoryPath(prevPath);
        setMemoryStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setMemoryOn(prev);
      setMemoryPath(prevPath);
      setMemoryStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setMemoryBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title"><FieldTitle help={tr('botDefaults.summaryLimitHelp')}>{tr('botDefaults.sectionSummaryTrigger')}</FieldTitle></h3>
      <div className="bd-row bd-summary-limits">
        <label>
          <span>{tr('botDefaults.summaryLimit')}</span>
          <input type="number" min={0} step={1} data-input="summaryLimit" value={limit} disabled={busy} onChange={event => setLimit(event.currentTarget.value)} />
        </label>
        <label>
          <span>{tr('botDefaults.summarySinceHours')}</span>
          <input type="number" min={0} step={1} data-input="summarySinceHours" value={sinceHours} disabled={busy} onChange={event => setSinceHours(event.currentTarget.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-summary-trigger" disabled={busy} onClick={() => void save()}>{tr('botDefaults.summarySave')}</button>
        <StatusSpan status={status} attr={{ 'data-summary-trigger-status': '' }} />
      </div>
      <ToggleRow
        checked={memoryOn}
        disabled={memoryBusy}
        title={tr('botDefaults.summaryMemory')}
        help={tr('botDefaults.summaryMemoryHelp')}
        onChange={checked => void saveMemory(checked)}
      />
      <div className="bd-row bd-summary-limits">
        <label>
          <span>{tr('botDefaults.summaryMemoryPath')}</span>
          <input type="text" data-input="summaryMemoryPath" value={memoryPath} disabled={memoryBusy} onChange={event => setMemoryPath(event.currentTarget.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-summary-memory-path" disabled={memoryBusy} onClick={() => void saveMemory(memoryOn, memoryPath)}>{tr('botDefaults.summaryMemoryPathSave')}</button>
      </div>
      <div className="actions"><StatusSpan status={memoryStatus} attr={{ 'data-summary-memory-status': '' }} /></div>
    </section>
  );
}

function normalizeSummaryMemoryPath(raw: string): string {
  const value = raw.trim();
  return value || 'summary.md';
}

function summaryMemoryPath(bot: Pick<BotDefaultsRow, 'summaryMemoryPath'>): string {
  return normalizeSummaryMemoryPath(typeof bot.summaryMemoryPath === 'string' ? bot.summaryMemoryPath : '');
}

function summaryRange(bot: BotDefaultsRow): { limit: number; sinceHours: number } {
  const range = bot.summaryRange ?? { limit: 50, sinceHours: 24 };
  return {
    limit: Number.isInteger(range.limit) && Number(range.limit) >= 0 ? Number(range.limit) : 50,
    sinceHours: Number.isInteger(range.sinceHours) && Number(range.sinceHours) >= 0 ? Number(range.sinceHours) : 24,
  };
}

function SessionModeSection(props: {
  bot: BotDefaultsRow;
  patchBot: PatchBot;
  putCardPref(patch: CardPrefPatch): Promise<JsonResponse>;
}) {
  const tr = useT();
  const [p2p, setP2p] = useState(props.bot.p2pMode === 'thread' ? 'thread' : 'chat');
  const [regular, setRegular] = useState(regularGroupMode(props.bot));
  const [mention, setMention] = useState(mentionMode(props.bot));
  const [docMode, setDocMode] = useState(props.bot.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only');
  const [busy, setBusy] = useState<string | null>(null);
  const [p2pStatus, setP2pStatus] = useState<StatusMessage>(null);
  const [regularStatus, setRegularStatus] = useState<StatusMessage>(null);
  const [mentionStatus, setMentionStatus] = useState<StatusMessage>(null);
  const [docStatus, setDocStatus] = useState<StatusMessage>(null);

  useEffect(() => {
    setP2p(props.bot.p2pMode === 'thread' ? 'thread' : 'chat');
    setRegular(regularGroupMode(props.bot));
    setMention(mentionMode(props.bot));
    setDocMode(props.bot.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only');
  }, [
    props.bot.docSubscribeDefaultMode,
    props.bot.p2pMode,
    props.bot.regularGroupMentionMode,
    props.bot.regularGroupReplyMode,
  ]);

  async function saveP2p(next: string): Promise<void> {
    const mode = next === 'chat' ? 'chat' : 'thread';
    setP2p(mode);
    setBusy('p2p');
    setP2pStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/p2p-mode`, { p2pMode: mode });
      if (res.ok && res.body.ok) {
        props.patchBot(props.bot.larkAppId, { p2pMode: res.body.p2pMode === 'thread' ? 'thread' : 'chat' });
        setP2pStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setP2pStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setP2pStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function saveCardMode(key: string, patch: CardPrefPatch, setStatus: (status: StatusMessage) => void): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await props.putCardPref(patch);
      setStatus(res.ok ? { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true } : { text: `✗ ${responseErrorText(res)}` });
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const p2pOptions: DropdownFieldOption<'thread' | 'chat'>[] = [
    { value: 'thread', label: tr('botDefaults.p2pThread') },
    { value: 'chat', label: tr('botDefaults.p2pChat') },
  ];
  const regularOptions: DropdownFieldOption<string>[] = [
    { value: 'chat', label: tr('botDefaults.regularGroupModeChat') },
    { value: 'chat-topic', label: tr('botDefaults.regularGroupModeChatTopic') },
    { value: 'new-topic', label: tr('botDefaults.regularGroupModeNewTopic') },
    { value: 'shared', label: tr('botDefaults.regularGroupModeShared') },
  ];
  const mentionOptions: DropdownFieldOption<string>[] = [
    { value: 'always', label: tr('botDefaults.mentionModeAlways') },
    { value: 'topic', label: tr('botDefaults.mentionModeTopic') },
    { value: 'never', label: tr('botDefaults.mentionModeNever') },
    { value: 'ambient', label: tr('botDefaults.mentionModeAmbient') },
  ];
  const docOptions: DropdownFieldOption<string>[] = [
    { value: 'mention-only', label: tr('botDefaults.docSubscribeModeMention') },
    { value: 'all', label: tr('botDefaults.docSubscribeModeAll') },
  ];

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSessionMode')}</h3>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.p2pHelp')}>{tr('botDefaults.p2pMode')}</FieldTitle>
          <DropdownField
            dataInput="p2pMode"
            ariaLabel={tr('botDefaults.p2pMode')}
            value={p2p}
            disabled={busy === 'p2p'}
            options={p2pOptions}
            onChange={next => void saveP2p(next)}
          />
        </div>
        <div className="actions"><StatusSpan status={p2pStatus} attr={{ 'data-p2p-status': '' }} /></div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.regularGroupModeHelp')}>{tr('botDefaults.regularGroupMode')}</FieldTitle>
          <DropdownField
            dataInput="regularGroupMode"
            ariaLabel={tr('botDefaults.regularGroupMode')}
            value={regular}
            disabled={busy === 'regular'}
            options={regularOptions}
            onChange={next => {
              setRegular(next);
              void saveCardMode('regular', { regularGroupReplyMode: next }, setRegularStatus);
            }}
          />
        </div>
        <div className="actions"><StatusSpan status={regularStatus} attr={{ 'data-regular-group-status': '' }} /></div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.mentionModeHelp')}>{tr('botDefaults.mentionMode')}</FieldTitle>
          <DropdownField
            dataInput="regularGroupMentionMode"
            ariaLabel={tr('botDefaults.mentionMode')}
            value={mention}
            disabled={busy === 'mention'}
            options={mentionOptions}
            onChange={next => {
              setMention(next);
              void saveCardMode('mention', { regularGroupMentionMode: next }, setMentionStatus);
            }}
          />
        </div>
        <div className="actions"><StatusSpan status={mentionStatus} attr={{ 'data-mention-mode-status': '' }} /></div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.docSubscribeModeHelp')}>{tr('botDefaults.docSubscribeMode')}</FieldTitle>
          <DropdownField
            dataInput="docSubscribeDefaultMode"
            ariaLabel={tr('botDefaults.docSubscribeMode')}
            value={docMode}
            disabled={busy === 'doc'}
            options={docOptions}
            onChange={next => {
              setDocMode(next);
              void saveCardMode('doc', { docSubscribeDefaultMode: next }, setDocStatus);
            }}
          />
        </div>
        <div className="actions"><StatusSpan status={docStatus} attr={{ 'data-doc-subscribe-mode-status': '' }} /></div>
      </div>
    </section>
  );
}

function SubstituteModeSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = props.bot.substituteMode ?? null;
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  function substituteReasonText(reason?: SubstituteTargetResolution['reason']): string {
    switch (reason) {
      case 'cross_app_open_id': return tr('botDefaults.substituteReasonCrossAppOpenId');
      case 'not_visible': return tr('botDefaults.substituteReasonNotVisible');
      case 'resolve_failed': return tr('botDefaults.substituteReasonResolveFailed');
      case 'unresolvable': return tr('botDefaults.substituteReasonUnresolvable');
      default: return tr('botDefaults.substituteUnresolved');
    }
  }
  const [disclosure, setDisclosure] = useState<'prefix' | 'none'>(initial?.disclosure === 'none' ? 'none' : 'prefix');
  const [replyMode, setReplyMode] = useState<'thread' | 'quote'>(initial?.replyMode === 'quote' ? 'quote' : 'thread');
  const [controlCard, setControlCard] = useState(initial?.disableControlCard !== true);
  const [chatsText, setChatsText] = useState(() => formatSubstituteChats(initial?.chats));
  const [excludedChatsText, setExcludedChatsText] = useState(() => formatSubstituteChats(initial?.excludedChats));
  // 话题群相关开关缺省开：只有显式 false 才是关（与 normalize 语义一致）。
  const [topicGroups, setTopicGroups] = useState(initial?.topicGroups !== false);
  const [topicActiveSessionTrigger, setTopicActiveSessionTrigger] = useState(initial?.topicActiveSessionTrigger !== false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  const targetSequence = useRef(0);
  const skipModeSync = useRef(false);

  function makeTargetDraft(target?: BotSubstituteTarget): SubstituteTargetDraft {
    const idField = substituteTargetIdField(target);
    return {
      key: ++targetSequence.current,
      idField,
      idValue: target?.[idField] ?? '',
      name: target?.name ?? '',
      persisted: target ? { ...target } : {},
      originalIdField: target ? idField : undefined,
      resolution: target?.name || target?.avatarUrl
        ? { ok: true, name: target.name, avatarUrl: target.avatarUrl }
        : undefined,
    };
  }

  // Monotonic per-row resolve epoch: two quick blurs create two in-flight
  // requests; only the latest one may apply, or a slow stale response would
  // overwrite the fresh result (last-completion-wins race).
  const resolveEpochs = useRef(new Map<number, number>());

  async function resolveTargetRow(key: number): Promise<void> {
    const epoch = (resolveEpochs.current.get(key) ?? 0) + 1;
    resolveEpochs.current.set(key, epoch);
    const isCurrent = () => resolveEpochs.current.get(key) === epoch;
    setTargetRows(rows => rows.map(row => row.key === key ? { ...row, resolving: true } : row));
    try {
      const row = targetRows.find(r => r.key === key);
      if (!row) return;
      const idValue = row.idValue.trim();
      if (!idValue) {
        setTargetRows(rows => rows.map(r => r.key === key ? { ...r, resolving: false, resolution: undefined } : r));
        return;
      }
      const target: BotSubstituteTarget = { [row.idField]: idValue };
      if (row.name.trim()) target.name = row.name.trim();
      const res = await resolveSubstituteTarget(props.bot.larkAppId, target);
      if (!isCurrent()) return;
      setTargetRows(rows => rows.map(r => {
        if (r.key !== key) return r;
        if (!res.ok) return { ...r, resolving: false, resolution: { ok: false } };
        const entry = res.resolution;
        if (entry?.ok === true) {
          // userId passthrough: nothing was verified (no openId / profile) —
          // keep the editable name input instead of showing a fake chip.
          if (!entry.openId) return { ...r, resolving: false, resolution: undefined };
          const persisted: BotSubstituteTarget = { ...r.persisted };
          persisted.openId = entry.openId;
          if (entry.name) persisted.name = entry.name;
          if (entry.avatarUrl) persisted.avatarUrl = entry.avatarUrl;
          return {
            ...r,
            name: entry.name ?? r.name,
            persisted,
            resolving: false,
            resolution: { ok: true, name: entry.name, avatarUrl: entry.avatarUrl },
          };
        }
        return {
          ...r,
          resolving: false,
          resolution: { ok: false, reason: entry?.reason },
        };
      }));
    } catch {
      if (!isCurrent()) return;
      setTargetRows(rows => rows.map(r => r.key === key ? { ...r, resolving: false, resolution: { ok: false } } : r));
    }
  }

  const [targetRows, setTargetRows] = useState<SubstituteTargetDraft[]>(() => {
    const targets = initial?.targets ?? [];
    return targets.length ? targets.map(target => makeTargetDraft(target)) : [makeTargetDraft()];
  });

  useEffect(() => {
    if (skipModeSync.current) {
      skipModeSync.current = false;
      return;
    }
    const next = props.bot.substituteMode ?? null;
    setEnabled(next?.enabled === true);
    setDisclosure(next?.disclosure === 'none' ? 'none' : 'prefix');
    setReplyMode(next?.replyMode === 'quote' ? 'quote' : 'thread');
    setControlCard(next?.disableControlCard !== true);
    setChatsText(formatSubstituteChats(next?.chats));
    setExcludedChatsText(formatSubstituteChats(next?.excludedChats));
    setTopicGroups(next?.topicGroups !== false);
    setTopicActiveSessionTrigger(next?.topicActiveSessionTrigger !== false);
    const targets = next?.targets ?? [];
    setTargetRows(targets.length ? targets.map(target => makeTargetDraft(target)) : [makeTargetDraft()]);
  }, [props.bot.larkAppId, props.bot.substituteMode]);

  async function save(body: { enabled: boolean; targets: BotSubstituteTarget[]; disclosure?: 'prefix' | 'none'; chats?: string[]; excludedChats?: string[]; replyMode?: 'thread' | 'quote'; disableControlCard?: boolean; topicGroups?: boolean; topicActiveSessionTrigger?: boolean }): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/substitute-mode`, body);
      if (res.ok && res.body.ok) {
        const next = res.body.substituteMode && typeof res.body.substituteMode === 'object'
          ? res.body.substituteMode as BotSubstituteMode
          : null;
        const resolution: SubstituteTargetResolution[] = Array.isArray(res.body?.resolution)
          ? res.body.resolution
          : [];
        const unresolved = resolution
          .filter(entry => entry?.ok === false)
          .map(entry => String(entry.input ?? '').trim())
          .filter(Boolean);
        setEnabled(next?.enabled === true);
        setDisclosure(next?.disclosure === 'none' ? 'none' : 'prefix');
        setReplyMode(next?.replyMode === 'quote' ? 'quote' : 'thread');
        setControlCard(next?.disableControlCard !== true);
        setChatsText(formatSubstituteChats(next?.chats));
        setExcludedChatsText(formatSubstituteChats(next?.excludedChats));
        setTopicGroups(next?.topicGroups !== false);
        setTopicActiveSessionTrigger(next?.topicActiveSessionTrigger !== false);
        if (resolution.length) {
          skipModeSync.current = true;
          setTargetRows(rows => {
            const pending = [...resolution];
            return rows.map(row => {
              const input = row.idValue.trim();
              const index = pending.findIndex(entry => String(entry.input ?? '').trim() === input);
              if (index < 0) return row;
              const entry = pending.splice(index, 1)[0];
              if (entry?.ok === true) {
                const persisted: BotSubstituteTarget = { ...row.persisted };
                if (entry.openId) persisted.openId = entry.openId;
                if (row.idField === 'email') persisted.email = input;
                if (entry.name) persisted.name = entry.name;
                if (entry.avatarUrl) persisted.avatarUrl = entry.avatarUrl;
                return {
                  ...row,
                  name: entry.name ?? row.name,
                  persisted,
                  resolution: { ok: true, name: entry.name, avatarUrl: entry.avatarUrl },
                };
              }
              return {
                ...row,
                resolution: { ok: false, reason: entry?.reason },
              };
            });
          });
        } else {
          const targets = next?.targets ?? [];
          setTargetRows(targets.length ? targets.map(target => makeTargetDraft(target)) : [makeTargetDraft()]);
        }
        props.patchBot(props.bot.larkAppId, { substituteMode: next });
        setStatus(unresolved.length
          ? { text: `✗ ${tr('botDefaults.substituteTargetsInvalid')}: ${unresolved.join(', ')}` }
          : { text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        const unresolved = Array.isArray(res.body?.resolution)
          ? res.body.resolution
            .filter((entry: SubstituteTargetResolution) => entry?.ok === false)
            .map((entry: SubstituteTargetResolution) => String(entry.input ?? '').trim())
            .filter(Boolean)
          : [];
        setStatus({ text: unresolved.length
          ? `✗ ${tr('botDefaults.substituteTargetsInvalid')}: ${unresolved.join(', ')}`
          : `✗ ${responseErrorText(res)}` });
      }
    } catch (error: any) {
      setStatus({ text: `✗ ${caughtErrorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  function saveCurrent(): void {
    const targets: BotSubstituteTarget[] = [];
    let invalid = false;
    for (const row of targetRows) {
      const target = buildSubstituteTarget(row);
      if (!target) {
        invalid ||= Boolean(row.name.trim());
        continue;
      }
      targets.push(target);
    }

    if (invalid || (enabled && targets.length === 0)) {
      setStatus({ text: `✗ ${tr('botDefaults.substituteTargetsInvalid')}` });
      return;
    }
    void save({ enabled, targets, disclosure, chats: parseSubstituteChats(chatsText), excludedChats: parseSubstituteChats(excludedChatsText), replyMode, disableControlCard: !controlCard, topicGroups, topicActiveSessionTrigger });
  }

  const disclosureOptions: DropdownFieldOption<'prefix' | 'none'>[] = [
    { value: 'prefix', label: tr('botDefaults.substituteDisclosurePrefix') },
    { value: 'none', label: tr('botDefaults.substituteDisclosureNone') },
  ];
  const replyModeOptions: DropdownFieldOption<'thread' | 'quote'>[] = [
    { value: 'thread', label: tr('botDefaults.substituteReplyModeThread') },
    { value: 'quote', label: tr('botDefaults.substituteReplyModeQuote') },
  ];

  return (
    <section className="bd-section bd-substitute-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSubstitute')}</h3>
      <ToggleRow
        checked={enabled}
        disabled={busy}
        dataAction="toggle-substitute-mode"
        title={tr('botDefaults.substituteEnabled')}
        help={tr('botDefaults.substituteHelp')}
        onChange={setEnabled}
      />
      <ToggleRow
        checked={topicGroups}
        disabled={busy}
        dataAction="toggle-substitute-topic-groups"
        title={tr('botDefaults.substituteTopicGroups')}
        help={tr('botDefaults.substituteTopicGroupsHelp')}
        onChange={setTopicGroups}
      />
      <ToggleRow
        checked={topicActiveSessionTrigger}
        disabled={busy || !topicGroups}
        dataAction="toggle-substitute-topic-active"
        title={tr('botDefaults.substituteTopicActive')}
        help={tr('botDefaults.substituteTopicActiveHelp')}
        onChange={setTopicActiveSessionTrigger}
      />
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle>{tr('botDefaults.substituteDisclosure')}</FieldTitle>
          <DropdownField<'prefix' | 'none'>
            dataInput="substituteDisclosure"
            ariaLabel={tr('botDefaults.substituteDisclosure')}
            value={disclosure}
            disabled={busy}
            options={disclosureOptions}
            onChange={value => setDisclosure(value)}
          />
        </div>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.substituteReplyModeHelp')}>{tr('botDefaults.substituteReplyMode')}</FieldTitle>
          <DropdownField<'thread' | 'quote'>
            dataInput="substituteReplyMode"
            ariaLabel={tr('botDefaults.substituteReplyMode')}
            value={replyMode}
            disabled={busy}
            options={replyModeOptions}
            onChange={value => setReplyMode(value)}
          />
        </div>
      </div>
      <ToggleRow
        checked={controlCard}
        disabled={busy}
        dataAction="toggle-substitute-control-card"
        title={tr('botDefaults.substituteControlCard')}
        help={tr('botDefaults.substituteControlCardHelp')}
        onChange={setControlCard}
      />
      <div className="bd-row">
        <label>
          <FieldTitle help={tr('botDefaults.substituteChatsHelp')}>{tr('botDefaults.substituteChats')}</FieldTitle>
          <textarea
            data-input="substituteChats"
            rows={3}
            placeholder={tr('botDefaults.substituteChatsPlaceholder')}
            value={chatsText}
            disabled={busy}
            onChange={event => setChatsText(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <FieldTitle help={tr('botDefaults.substituteExcludedChatsHelp')}>{tr('botDefaults.substituteExcludedChats')}</FieldTitle>
          <textarea
            data-input="substituteExcludedChats"
            rows={3}
            placeholder={tr('botDefaults.substituteExcludedChatsPlaceholder')}
            value={excludedChatsText}
            disabled={busy}
            onChange={event => setExcludedChatsText(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="bd-row bd-substitute-targets">
        <FieldTitle help={tr('botDefaults.substituteTargetsHelp')}>{tr('botDefaults.substituteTargets')}</FieldTitle>
        <div className="bd-substitute-target-list" data-input="substituteTargets">
          {targetRows.map((target, index) => (
            <div className="bd-substitute-target-row" key={target.key}>
              <DropdownField<SubstituteTargetIdField>
                dataInput={`substituteTargetType-${target.key}`}
                className="bd-substitute-target-type"
                ariaLabel={`${tr('botDefaults.substituteTargetType')} ${index + 1}`}
                value={target.idField}
                disabled={busy}
                options={substituteTargetIdFields.map(value => ({
                  value,
                  label: tr(`botDefaults.substituteTarget${value[0].toUpperCase()}${value.slice(1)}`),
                }))}
                onChange={idField => {
                  setTargetRows(rows => rows.map(row => row.key === target.key
                    ? { ...row, idField, idValue: row.persisted[idField] ?? '', resolution: undefined }
                    : row));
                }}
              />
              <input
                className="bd-substitute-target-id"
                type="text"
                data-input={`substituteTargetId-${target.key}`}
                aria-label={`${tr('botDefaults.substituteTargetType')} ${index + 1}`}
                placeholder={tr('botDefaults.substituteTargetIdPlaceholder')}
                value={target.idValue}
                disabled={busy}
                onChange={event => {
                  const idValue = event.currentTarget.value;
                  setTargetRows(rows => rows.map(row => row.key === target.key ? { ...row, idValue, resolution: undefined } : row));
                }}
                onBlur={() => {
                  if (target.idValue.trim()) void resolveTargetRow(target.key);
                }}
              />
              <div className="bd-substitute-target-name">
                {target.resolving ? (
                  <span className="bd-substitute-target-resolving">{tr('botDefaults.substituteResolving')}</span>
                ) : target.resolution?.ok === true && (target.name || target.resolution.avatarUrl) ? (
                  <>
                    {target.resolution.avatarUrl ? (
                      <Html html={botAvatarHtml({ name: target.resolution.name, avatarUrl: target.resolution.avatarUrl, size: 'sm' })} />
                    ) : null}
                    <span
                      className="bd-substitute-target-name-chip"
                      data-chip={`substituteTargetName-${target.key}`}
                      aria-label={`${tr('botDefaults.substituteTargetName')} ${index + 1}`}
                    >
                      {target.name}
                    </span>
                  </>
                ) : target.resolution?.ok === false ? (
                  <span className="bd-substitute-target-resolution-badge">{substituteReasonText(target.resolution.reason)}</span>
                ) : (
                  <input
                    type="text"
                    data-input={`substituteTargetName-${target.key}`}
                    aria-label={`${tr('botDefaults.substituteTargetName')} ${index + 1}`}
                    placeholder={tr('botDefaults.substituteTargetNamePlaceholder')}
                    value={target.name}
                    disabled={busy}
                    onChange={event => {
                      const name = event.currentTarget.value;
                      setTargetRows(rows => rows.map(row => row.key === target.key ? { ...row, name } : row));
                    }}
                  />
                )}
              </div>
              <button
                type="button"
                className="bd-substitute-target-remove"
                data-action="remove-substitute-target"
                title={tr('botDefaults.substituteTargetRemove')}
                aria-label={tr('botDefaults.substituteTargetRemove')}
                disabled={busy}
                onClick={() => {
                  setTargetRows(rows => {
                    const remaining = rows.filter(row => row.key !== target.key);
                    return remaining.length ? remaining : [makeTargetDraft()];
                  });
                }}
              >
                <span aria-hidden="true">&times;</span>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="bd-substitute-target-add"
            data-action="add-substitute-target"
            title={tr('botDefaults.substituteTargetAdd')}
            aria-label={tr('botDefaults.substituteTargetAdd')}
            disabled={busy}
            onClick={() => setTargetRows(rows => [...rows, makeTargetDraft()])}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-substitute-mode" disabled={busy} onClick={saveCurrent}>
          {tr('botDefaults.substituteSave')}
        </button>
        <button
          type="button"
          data-action="off-substitute-mode"
          disabled={busy}
          onClick={() => void save({ enabled: false, targets: [] })}
        >
          {tr('botDefaults.substituteOff')}
        </button>
        <StatusSpan status={status} attr={{ 'data-substitute-status': '' }} />
      </div>
    </section>
  );
}

function regularGroupMode(bot: BotDefaultsRow): string {
  return bot.regularGroupReplyMode === 'chat' || bot.regularGroupReplyMode === 'new-topic' || bot.regularGroupReplyMode === 'shared'
    ? bot.regularGroupReplyMode
    : 'chat-topic';
}

function mentionMode(bot: BotDefaultsRow): string {
  return bot.regularGroupMentionMode === 'topic' || bot.regularGroupMentionMode === 'never' || bot.regularGroupMentionMode === 'ambient'
    ? bot.regularGroupMentionMode
    : 'always';
}

function SessionCapSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = typeof props.bot.maxLiveWorkers === 'number' ? props.bot.maxLiveWorkers : null;
  const logical = Number.isFinite(props.bot.logicalSessionCount) ? Number(props.bot.logicalSessionCount) : 0;
  const resident = Number.isFinite(props.bot.residentSessionCount) ? Number(props.bot.residentSessionCount) : 0;
  const dormant = Number.isFinite(props.bot.dormantSessionCount) ? Number(props.bot.dormantSessionCount) : 0;
  const [cap, setCap] = useState<number | null>(initial);
  const effectiveCap = cap ?? 30;
  const [input, setInput] = useState(initial == null ? '' : String(initial));
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = typeof props.bot.maxLiveWorkers === 'number' ? props.bot.maxLiveWorkers : null;
    setCap(next);
    setInput(next == null ? '' : String(next));
  }, [props.bot.maxLiveWorkers]);

  async function save(value: number | null): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/max-live-workers`, { maxLiveWorkers: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.maxLiveWorkers === 'number' ? res.body.maxLiveWorkers : null;
        setCap(next);
        setInput(next == null ? '' : String(next));
        props.patchBot(props.bot.larkAppId, { maxLiveWorkers: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  function saveInput(): void {
    const parsed = positiveIntegerOrNull(input);
    if (parsed === 'invalid') {
      setStatus({ text: `✗ ${tr('botDefaults.maxLiveWorkersInvalid')}` });
      return;
    }
    void save(parsed);
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionSessionCap')}</h3>
      <div className="bd-row bd-quota">
        <label>
          <FieldTitle help={tr('botDefaults.maxLiveWorkersHelp')}>{tr('botDefaults.maxLiveWorkers')}</FieldTitle>
          <input type="number" min={1} step={1} data-input="maxLiveWorkers" placeholder={tr('botDefaults.maxLiveWorkersPlaceholder')} value={input} disabled={busy} onChange={event => setInput(event.currentTarget.value)} />
        </label>
        <small data-session-cap-state>{sessionCapStateLabel(cap, tr)}</small>
        <small className="bd-help bd-session-residency">{tr('botDefaults.maxLiveWorkersUsage', {
          resident,
          cap: effectiveCap,
          dormant,
          logical,
        })}</small>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-session-cap" disabled={busy} onClick={saveInput}>{tr('botDefaults.maxLiveWorkersSave')}</button>
        <button type="button" data-action="off-session-cap" disabled={busy} onClick={() => { setInput(''); void save(null); }}>{tr('botDefaults.maxLiveWorkersOff')}</button>
        <StatusSpan status={status} attr={{ 'data-session-cap-status': '' }} />
      </div>
    </section>
  );
}

function StartupCommandsSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [value, setValue] = useState(typeof props.bot.startupCommands === 'string' ? props.bot.startupCommands : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof props.bot.startupCommands === 'string' ? props.bot.startupCommands : ''), [props.bot.startupCommands]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/startup-commands`, { startupCommands: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.startupCommands === 'string' ? res.body.startupCommands : '';
        setValue(next);
        props.patchBot(props.bot.larkAppId, { startupCommands: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title"><FieldTitle help={tr('botDefaults.startupCommandsHelp')}>{tr('botDefaults.sectionStartupCommands')}</FieldTitle></h3>
      <textarea
        data-input="startupCommands"
        rows={3}
        placeholder={tr('botDefaults.startupCommandsPlaceholder')}
        value={value}
        disabled={busy}
        onChange={event => setValue(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-startup-commands" disabled={busy} onClick={() => void save()}>{tr('botDefaults.startupCommandsSave')}</button>
        <StatusSpan status={status} attr={{ 'data-startup-commands-status': '' }} />
      </div>
    </section>
  );
}

// Slash 命令权限：把 /botconfig 的 customPassthroughCommands（透传给 CLI）与
// canTalkDaemonCommands（daemon 命令降到 canTalk）搬到 Dashboard 可视化编辑。
// 两者都是 stringList immediate 字段，走各自的 PUT 代理路由，空串＝清除回默认。
function SlashCommandPermissionsSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [passthrough, setPassthrough] = useState(typeof props.bot.customPassthroughCommands === 'string' ? props.bot.customPassthroughCommands : '');
  const [canTalk, setCanTalk] = useState(typeof props.bot.canTalkDaemonCommands === 'string' ? props.bot.canTalkDaemonCommands : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setPassthrough(typeof props.bot.customPassthroughCommands === 'string' ? props.bot.customPassthroughCommands : '');
  }, [props.bot.customPassthroughCommands]);
  // 分开两个 effect：只让「被保存的那个字段」的 prop 变化重置对应输入框，否则保存
  // 一个字段触发 patchBot 重渲染会连带把另一个字段的未保存草稿一并清空。
  useEffect(() => {
    setCanTalk(typeof props.bot.canTalkDaemonCommands === 'string' ? props.bot.canTalkDaemonCommands : '');
  }, [props.bot.canTalkDaemonCommands]);

  async function savePassthrough(): Promise<void> {
    setStatus(null);
    setBusy('passthrough');
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/custom-passthrough`, { customPassthroughCommands: passthrough });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.customPassthroughCommands === 'string' ? res.body.customPassthroughCommands : '';
        setPassthrough(next);
        props.patchBot(props.bot.larkAppId, { customPassthroughCommands: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function saveCanTalk(): Promise<void> {
    setStatus(null);
    setBusy('cantalk');
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/cantalk-daemon-commands`, { canTalkDaemonCommands: canTalk });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.canTalkDaemonCommands === 'string' ? res.body.canTalkDaemonCommands : '';
        setCanTalk(next);
        props.patchBot(props.bot.larkAppId, { canTalkDaemonCommands: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title"><FieldTitle help={tr('botDefaults.sectionSlashCommandsHelp')}>{tr('botDefaults.sectionSlashCommands')}</FieldTitle></h3>
      <div className="bd-subsection">
        <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.customPassthroughHelp')}>{tr('botDefaults.customPassthrough')}</FieldTitle></h4>
        <textarea
          data-input="customPassthroughCommands"
          rows={2}
          placeholder={tr('botDefaults.customPassthroughPlaceholder')}
          value={passthrough}
          disabled={busy === 'passthrough'}
          onChange={event => setPassthrough(event.currentTarget.value)}
        />
        <div className="actions">
          <button type="button" className="primary" data-action="save-custom-passthrough" disabled={busy === 'passthrough'} onClick={() => void savePassthrough()}>{tr('botDefaults.customPassthroughSave')}</button>
        </div>
      </div>
      <div className="bd-subsection">
        <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.canTalkDaemonHelp')}>{tr('botDefaults.canTalkDaemon')}</FieldTitle></h4>
        <textarea
          data-input="canTalkDaemonCommands"
          rows={2}
          placeholder={tr('botDefaults.canTalkDaemonPlaceholder')}
          value={canTalk}
          disabled={busy === 'cantalk'}
          onChange={event => setCanTalk(event.currentTarget.value)}
        />
        <div className="actions">
          <button type="button" className="primary" data-action="save-cantalk-daemon" disabled={busy === 'cantalk'} onClick={() => void saveCanTalk()}>{tr('botDefaults.canTalkDaemonSave')}</button>
        </div>
      </div>
      <StatusSpan status={status} attr={{ 'data-slash-commands-status': '' }} />
    </section>
  );
}

function LaunchShellSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [value, setValue] = useState(typeof props.bot.launchShell === 'string' ? props.bot.launchShell : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof props.bot.launchShell === 'string' ? props.bot.launchShell : ''), [props.bot.launchShell]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/launch-shell`, { launchShell: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.launchShell === 'string' ? res.body.launchShell : '';
        setValue(next);
        props.patchBot(props.bot.larkAppId, { launchShell: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.launchShellHelp')}>{tr('botDefaults.sectionLaunchShell')}</FieldTitle></h4>
      <input
        type="text"
        data-input="launchShell"
        placeholder={tr('botDefaults.launchShellPlaceholder')}
        value={value}
        disabled={busy}
        onChange={event => setValue(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-launch-shell" disabled={busy} onClick={() => void save()}>{tr('botDefaults.launchShellSave')}</button>
        <StatusSpan status={status} attr={{ 'data-launch-shell-status': '' }} />
      </div>
    </div>
  );
}

function EnvSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [value, setValue] = useState(typeof props.bot.env === 'string' ? props.bot.env : '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(typeof props.bot.env === 'string' ? props.bot.env : ''), [props.bot.env]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/env`, { env: value });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.env === 'string' ? res.body.env : '';
        setValue(next);
        props.patchBot(props.bot.larkAppId, { env: next });
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.envHelp')}>{tr('botDefaults.sectionEnv')}</FieldTitle></h4>
      <textarea
        data-input="env"
        rows={5}
        placeholder={tr('botDefaults.envPlaceholder')}
        value={value}
        disabled={busy}
        onChange={event => setValue(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" className="primary" data-action="save-env" disabled={busy} onClick={() => void save()}>{tr('botDefaults.envSave')}</button>
        <StatusSpan status={status} attr={{ 'data-env-status': '' }} />
      </div>
    </div>
  );
}

/** riff UI 建议主动选择的模型（服务端另有隐藏降级备胎，不在此列）。 */
const RIFF_MODEL_SUGGESTIONS = ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4', 'gpt-5.4-pro'];
/** codex 思考等级档位（与 riff 服务端对齐）；'' = 跟随 riff 默认（medium）。 */
const RIFF_REASONING_EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh'];
/** riff task-execute 的 sandboxCluster；缺省行为与服务端一致，回落 BOE。 */
const RIFF_SANDBOX_CLUSTER_OPTIONS = ['boe', 'cn'] as const;

function RiffSection(props: { bot: BotDefaultsRow; patchBot: PatchBot; persistCliSelection?: () => Promise<CliPersistOutcome> }) {
  const tr = useT();
  const riff = props.bot.riff && typeof props.bot.riff === 'object' ? props.bot.riff : {};
  const [baseUrl, setBaseUrl] = useState(typeof riff.baseUrl === 'string' ? riff.baseUrl : '');
  const [sandboxCluster, setSandboxCluster] = useState(riff.sandboxCluster === 'cn' ? 'cn' : 'boe');
  const [model, setModel] = useState(typeof riff.model === 'string' ? riff.model : '');
  const [reasoningEffort, setReasoningEffort] = useState(typeof riff.reasoningEffort === 'string' ? riff.reasoningEffort : '');
  const [jwtEnv, setJwtEnv] = useState(typeof riff.jwtEnv === 'string' ? riff.jwtEnv : '');
  const [systemPrompt, setSystemPrompt] = useState(typeof riff.systemPrompt === 'string' ? riff.systemPrompt : '');
  const [setupCommands, setSetupCommands] = useState(
    Array.isArray(riff.setupCommands) ? riff.setupCommands.join('\n') : '',
  );
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const r = props.bot.riff && typeof props.bot.riff === 'object' ? props.bot.riff : {};
    setBaseUrl(typeof r.baseUrl === 'string' ? r.baseUrl : '');
    setSandboxCluster(r.sandboxCluster === 'cn' ? 'cn' : 'boe');
    setModel(typeof r.model === 'string' ? r.model : '');
    setReasoningEffort(typeof r.reasoningEffort === 'string' ? r.reasoningEffort : '');
    setJwtEnv(typeof r.jwtEnv === 'string' ? r.jwtEnv : '');
    setSystemPrompt(typeof r.systemPrompt === 'string' ? r.systemPrompt : '');
    setSetupCommands(Array.isArray(r.setupCommands) ? r.setupCommands.join('\n') : '');
  }, [props.bot.riff]);

  async function save(): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const config: Record<string, unknown> = {};
      if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
      config.sandboxCluster = sandboxCluster;
      if (model.trim()) config.model = model.trim();
      if (reasoningEffort) config.reasoningEffort = reasoningEffort;
      if (jwtEnv.trim()) config.jwtEnv = jwtEnv.trim();
      if (systemPrompt.trim()) config.systemPrompt = systemPrompt.trim();
      if (setupCommands.trim()) {
        config.setupCommands = setupCommands.split('\n').map(s => s.trim()).filter(Boolean);
      }
      const json = Object.keys(config).length ? JSON.stringify(config) : '';
      // Save order matters: riff config FIRST, agent switch AFTER. PUT /agent
      // flips cliId/backendType AND closes CLI-mismatched sessions immediately,
      // so doing it first would leave a half-configured riff bot (and killed
      // sessions) when the /riff write fails. A saved-but-unused riff config
      // from the reverse failure mode is harmless.
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/riff`, { riff: json });
      if (res.ok && res.body.ok) {
        const next = typeof res.body.riff === 'string' && res.body.riff ? JSON.parse(res.body.riff) : null;
        props.patchBot(props.bot.larkAppId, { riff: next });
        const persisted = await props.persistCliSelection?.();
        if (persisted && !persisted.ok) {
          // Show the transaction's own detail (Agent NOT switched + surviving
          // remote ids) in THIS section's visible status, not the generic text.
          setStatus({ text: `✗ ${persisted.note || tr('botDefaults.riffCliPersistFailed')}` });
          return;
        }
        if (persisted?.hadProblem) {
          // Saved, but a remote session survived — never the green tick.
          setStatus({ text: `⚠️ ${persisted.note}` });
          return;
        }
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bd-subsection">
      <h4 className="bd-subsection-title"><FieldTitle help={tr('botDefaults.riffHelp')}>{tr('botDefaults.sectionRiff')}</FieldTitle></h4>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffBaseUrl')}</span>
          <input type="text" data-input="riff-base-url" placeholder={tr('botDefaults.riffBaseUrlPlaceholder')} value={baseUrl} disabled={busy} onChange={e => setBaseUrl(e.currentTarget.value)} />
        </label>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          <span><FieldTitle help={tr('botDefaults.riffSandboxClusterHelp')}>{tr('botDefaults.riffSandboxCluster')}</FieldTitle></span>
          <DropdownField
            dataInput="riff-sandbox-cluster"
            ariaLabel={tr('botDefaults.riffSandboxCluster')}
            value={sandboxCluster}
            disabled={busy}
            options={RIFF_SANDBOX_CLUSTER_OPTIONS.map(value => ({ value, label: value.toUpperCase() }))}
            onChange={next => setSandboxCluster(next)}
          />
        </div>
      </div>
      <div className="bd-row">
        <label>
          <span><FieldTitle help={tr('botDefaults.riffModelHelp')}>{tr('botDefaults.riffModel')}</FieldTitle></span>
          <input type="text" data-input="riff-model" list={`riff-model-suggestions-${props.bot.larkAppId}`} placeholder={tr('botDefaults.riffModelPlaceholder')} value={model} disabled={busy} onChange={e => setModel(e.currentTarget.value)} />
          <datalist id={`riff-model-suggestions-${props.bot.larkAppId}`}>
            {RIFF_MODEL_SUGGESTIONS.map(item => <option value={item} key={item} />)}
          </datalist>
        </label>
      </div>
      <div className="bd-row">
        <div className="bd-field">
          {/* 标题包 <span> 走字段标签样式，与同级 Base URL/模型/JWT 对齐 */}
          <span><FieldTitle help={tr('botDefaults.riffReasoningEffortHelp')}>{tr('botDefaults.riffReasoningEffort')}</FieldTitle></span>
          <DropdownField
            dataInput="riff-reasoning-effort"
            ariaLabel={tr('botDefaults.riffReasoningEffort')}
            value={reasoningEffort}
            disabled={busy}
            options={RIFF_REASONING_EFFORT_OPTIONS.map(v => ({ value: v, label: v === '' ? tr('botDefaults.riffReasoningEffortDefault') : v }))}
            onChange={next => setReasoningEffort(next)}
          />
        </div>
      </div>
      <div className="bd-row">
        <label>
          <span><FieldTitle help={tr('botDefaults.riffJwtEnvHelp')}>{tr('botDefaults.riffJwtEnv')}</FieldTitle></span>
          <input type="text" data-input="riff-jwt-env" placeholder={tr('botDefaults.riffJwtEnvPlaceholder')} value={jwtEnv} disabled={busy} onChange={e => setJwtEnv(e.currentTarget.value)} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffSystemPrompt')}</span>
          <textarea data-input="riff-system-prompt" placeholder={tr('botDefaults.riffSystemPromptPlaceholder')} value={systemPrompt} disabled={busy} onChange={e => setSystemPrompt(e.currentTarget.value)} rows={4} />
        </label>
      </div>
      <div className="bd-row">
        <label>
          <span>{tr('botDefaults.riffSetupCommands')}</span>
          <textarea data-input="riff-setup-commands" placeholder={tr('botDefaults.riffSetupCommandsPlaceholder')} value={setupCommands} disabled={busy} onChange={e => setSetupCommands(e.currentTarget.value)} rows={3} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-riff" disabled={busy} onClick={() => void save()}>{tr('botDefaults.riffSave')}</button>
        <StatusSpan status={status} attr={{ 'data-riff-status': '' }} />
      </div>
    </div>
  );
}

function BrandSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const initial = props.bot.brandLabel ?? null;
  const [brand, setBrand] = useState<string | null>(initial);
  const [input, setInput] = useState(initial ?? '');
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = props.bot.brandLabel ?? null;
    setBrand(next);
    setInput(next ?? '');
  }, [props.bot.brandLabel]);

  async function save(nextBrand: string | null): Promise<void> {
    setStatus(null);
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/brand-label`, { brandLabel: nextBrand });
      if (res.ok && res.body.ok) {
        const next = res.body.brandLabel ?? null;
        setBrand(next);
        setInput(next ?? '');
        props.patchBot(props.bot.larkAppId, { brandLabel: next });
        setStatus({ text: '✓', ok: true });
      } else {
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionBrand')}</h3>
      <div className="bd-row bd-brand">
        <label>
          <FieldTitle help={tr('botDefaults.brandLabelHelp')}>{tr('botDefaults.brandLabel')}</FieldTitle>
          <input type="text" data-input="brandLabel" placeholder={tr('botDefaults.brandLabelPlaceholder')} value={input} disabled={busy} onChange={event => setInput(event.currentTarget.value)} />
        </label>
        <small data-brand-state>{brandStateLabel(brand, tr)}</small>
      </div>
      <div className="actions">
        <button type="button" className="primary" data-action="save-brand" disabled={busy} onClick={() => void save(input)}>{tr('botDefaults.brandSave')}</button>
        <button type="button" data-action="reset-brand" disabled={busy} onClick={() => void save(null)}>{tr('botDefaults.brandReset')}</button>
        <StatusSpan status={status} attr={{ 'data-brand-status': '' }} />
      </div>
    </section>
  );
}

export function GrantSection(props: { bot: BotDefaultsRow; patchBot: PatchBot }) {
  const tr = useT();
  const [autoCard, setAutoCard] = useState(props.bot.autoGrantRequestCards !== false);
  const [restrict, setRestrict] = useState(props.bot.restrictGrantCommands === true);
  const [duration, setDuration] = useState(typeof props.bot.grantDefaultDurationMs === 'number' ? props.bot.grantDefaultDurationMs : null);
  const [durationInput, setDurationInput] = useState(String(props.bot.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS));
  const [quota, setQuota] = useState(typeof props.bot.messageQuotaDefaultLimit === 'number' ? props.bot.messageQuotaDefaultLimit : null);
  const [quotaInput, setQuotaInput] = useState(
    typeof props.bot.messageQuotaDefaultLimit === 'number' ? String(props.bot.messageQuotaDefaultLimit) : '',
  );
  const [status, setStatus] = useState<StatusMessage>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setAutoCard(props.bot.autoGrantRequestCards !== false);
  }, [props.bot.autoGrantRequestCards]);

  useEffect(() => {
    setRestrict(props.bot.restrictGrantCommands === true);
  }, [props.bot.restrictGrantCommands]);

  useEffect(() => {
    const nextDuration = typeof props.bot.grantDefaultDurationMs === 'number' ? props.bot.grantDefaultDurationMs : null;
    setDuration(nextDuration);
    setDurationInput(String(nextDuration ?? DEFAULT_GRANT_DURATION_MS));
  }, [props.bot.grantDefaultDurationMs]);

  useEffect(() => {
    const nextQuota = typeof props.bot.messageQuotaDefaultLimit === 'number' ? props.bot.messageQuotaDefaultLimit : null;
    setQuota(nextQuota);
    setQuotaInput(nextQuota === null ? '' : String(nextQuota));
  }, [props.bot.messageQuotaDefaultLimit]);

  async function savePatch(
    patch: {
      autoGrantRequestCards?: boolean;
      restrictGrantCommands?: boolean;
      grantDefaultDurationMs?: number | null;
      messageQuotaDefaultLimit?: number | null;
    },
    key: string,
    rollback?: () => void,
  ): Promise<void> {
    setBusy(key);
    setStatus(null);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.bot.larkAppId)}/grant-prefs`, patch);
      if (res.ok && res.body.ok) {
        const nextDuration = typeof res.body.grantDefaultDurationMs === 'number' ? res.body.grantDefaultDurationMs : null;
        const nextQuota = typeof res.body.messageQuotaDefaultLimit === 'number' ? res.body.messageQuotaDefaultLimit : null;
        setAutoCard(res.body.autoGrantRequestCards !== false);
        setRestrict(res.body.restrictGrantCommands === true);
        setDuration(nextDuration);
        setQuota(nextQuota);
        if ('grantDefaultDurationMs' in patch) setDurationInput(String(nextDuration ?? DEFAULT_GRANT_DURATION_MS));
        if ('messageQuotaDefaultLimit' in patch) {
          setQuotaInput(nextQuota === null ? '' : String(nextQuota));
        }
        props.patchBot(props.bot.larkAppId, {
          autoGrantRequestCards: res.body.autoGrantRequestCards !== false,
          restrictGrantCommands: res.body.restrictGrantCommands === true,
          grantDefaultDurationMs: nextDuration,
          messageQuotaDefaultLimit: nextQuota,
        });
        if (key === 'defaults') setQuotaError(null);
        setStatus({ text: `✓ ${tr('botDefaults.cardPrefSaved')}`, ok: true });
      } else {
        rollback?.();
        setStatus({ text: `✗ ${responseErrorText(res)}` });
      }
    } catch (e: any) {
      rollback?.();
      setStatus({ text: `✗ ${caughtErrorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  function saveDefaults(): void {
    const parsed = positiveIntegerOrNull(quotaInput);
    const quotaChanged = parsed !== quota;
    setStatus(null);
    if (quotaChanged && (parsed === 'invalid'
      || (typeof parsed === 'number' && parsed > MAX_GRANT_QUOTA))) {
      setQuotaError(tr('botDefaults.quotaInvalid'));
      return;
    }
    setQuotaError(null);
    const durationMs = Number(durationInput);
    if (!GRANT_DURATION_VALUES.includes(durationMs as (typeof GRANT_DURATION_VALUES)[number])) {
      setStatus({ text: `✗ ${tr('botDefaults.grantDurationInvalid')}` });
      return;
    }
    const patch: {
      grantDefaultDurationMs?: number | null;
      messageQuotaDefaultLimit?: number | null;
    } = {};
    if (durationMs !== (duration ?? DEFAULT_GRANT_DURATION_MS)) {
      patch.grantDefaultDurationMs = durationMs === DEFAULT_GRANT_DURATION_MS ? null : durationMs;
    }
    if (quotaChanged) {
      patch.messageQuotaDefaultLimit = parsed;
    }
    if (Object.keys(patch).length > 0) void savePatch(patch, 'defaults');
  }

  const durationOptions: DropdownFieldOption<string>[] = [
    { value: String(DEFAULT_GRANT_DURATION_MS), label: tr('botDefaults.grantDuration1Hour') },
    { value: String(8 * 60 * 60 * 1000), label: tr('botDefaults.grantDuration8Hours') },
    { value: String(24 * 60 * 60 * 1000), label: tr('botDefaults.grantDuration1Day') },
    { value: String(7 * 24 * 60 * 60 * 1000), label: tr('botDefaults.grantDuration7Days') },
  ];
  const currentDuration = duration ?? DEFAULT_GRANT_DURATION_MS;
  const currentDurationLabel = currentDuration === DEFAULT_GRANT_DURATION_MS
    ? tr('botDefaults.grantDuration1HourValue')
    : String(durationOptions.find(option => option.value === String(currentDuration))?.label ?? '');
  const parsedQuotaInput = positiveIntegerOrNull(quotaInput);
  const quotaInputDirty = parsedQuotaInput === 'invalid' || parsedQuotaInput !== quota;
  const defaultsDirty = durationInput !== String(currentDuration) || quotaInputDirty;
  const currentState = quota === null
    ? tr('botDefaults.grantDefaultsCurrentBuiltIn', {
      duration: currentDurationLabel,
      count: DEFAULT_GRANT_QUOTA,
    })
    : quota > MAX_GRANT_QUOTA
      ? tr('botDefaults.grantDefaultsCurrentLegacy', {
        duration: currentDurationLabel,
        cardCount: MAX_GRANT_QUOTA,
        oncallCount: quota,
      })
      : tr('botDefaults.grantDefaultsCurrentCustom', {
        duration: currentDurationLabel,
        count: quota,
      });

  return (
    <section className="bd-section">
      <h3 className="bd-section-title">{tr('botDefaults.sectionGrant')}</h3>
      <div className="bd-toggle-grid bd-grant-toggle-grid">
        <ToggleRow
          checked={autoCard}
          disabled={busy !== null}
          dataAction="toggle-auto-grant-card"
          title={tr('botDefaults.autoGrantCard')}
          help={tr('botDefaults.autoGrantCardHelp')}
          onChange={checked => {
            const previous = autoCard;
            setAutoCard(checked);
            void savePatch({ autoGrantRequestCards: checked }, 'autoGrant', () => setAutoCard(previous));
          }}
        />
        <ToggleRow
          checked={restrict}
          disabled={busy !== null}
          dataAction="toggle-restrict-grant"
          title={tr('botDefaults.restrictGrant')}
          help={tr('botDefaults.restrictGrantHelp')}
          onChange={checked => {
            const previous = restrict;
            setRestrict(checked);
            void savePatch({ restrictGrantCommands: checked }, 'restrict', () => setRestrict(previous));
          }}
        />
      </div>
      <form
        className="bd-grant-defaults"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          saveDefaults();
        }}
      >
        <div className="bd-row bd-grant-duration">
          <div className="bd-field">
            <FieldTitle help={tr('botDefaults.grantDurationHelp')}>{tr('botDefaults.grantDurationDefault')}</FieldTitle>
            <DropdownField
              dataInput="grantDefaultDurationMs"
              value={durationInput}
              options={durationOptions}
              disabled={busy !== null}
              ariaLabel={tr('botDefaults.grantDurationDefault')}
              onChange={value => {
                setDurationInput(value);
                setStatus(null);
              }}
            />
          </div>
        </div>
        <div className="bd-row bd-quota">
          <label>
            <FieldTitle help={tr('botDefaults.quotaHelp')}>{tr('botDefaults.quotaDefault')}</FieldTitle>
            <input
              type="number"
              min={1}
              max={MAX_GRANT_QUOTA}
              step={1}
              data-input="quotaLimit"
              placeholder={tr('botDefaults.quotaPlaceholder')}
              value={quotaInput}
              disabled={busy !== null}
              aria-label={tr('botDefaults.quotaDefault')}
              aria-invalid={quotaError ? true : undefined}
              aria-describedby={quotaError ? 'grant-defaults-state grant-default-quota-error' : 'grant-defaults-state'}
              onChange={event => {
                setQuotaInput(event.currentTarget.value);
                setQuotaError(null);
                setStatus(null);
              }}
            />
          </label>
          {quotaError ? <small id="grant-default-quota-error" className="bd-field-error" role="alert">{quotaError}</small> : null}
          <small id="grant-defaults-state" data-grant-defaults-state>{currentState}</small>
        </div>
        <div className="actions">
          <button type="submit" className="primary" data-action="save-grant-defaults" disabled={busy !== null || !defaultsDirty}>
            {busy === 'defaults' ? tr('botDefaults.grantDefaultsSaving') : tr('botDefaults.grantDefaultsSave')}
          </button>
          <StatusSpan status={status} attr={{ 'data-grant-status': '' }} />
        </div>
      </form>
    </section>
  );
}

export function renderBotDefaultsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <BotDefaultsPage />);
}
