import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FieldTitle, Html, LoadingState, RefreshIconButton, SectionHeader } from './dashboard-components.js';
import { botAvatarHtml } from './ui.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { SkillPacksTab } from './skills/skill-packs-tab.js';
import { detectSourceType, SkillLibraryTab } from './skills/skill-library-tab.js';
import { BotAssignmentsTab } from './skills/bot-assignments-tab.js';
import { DeliverySettingsTab } from './skills/delivery-settings-tab.js';
import {
  buildSkillGraph,
  danglingSkillNames,
  discoveryGroupKey,
  mergeBotAssignmentSelectors,
  policyConfigured,
  priorityNames,
  selectInstallCandidates,
  sourceLabel,
} from './skills/shared.js';
import { useSkillsData } from './skills/use-skills-data.js';
import type {
  BotRow,
  DashboardRequestError,
  DeliveryMode,
  InstallSkillCandidate,
  ProjectTrustMode,
  SkillJob,
  SkillRemovalReference,
  SkillRow,
  SkillsNavIntent,
  StatusMessage,
} from './skills/types.js';

const INSTALLED_SKILLS_ROWS_PER_PAGE = 2;

function installedSkillsColumnCount(width: number): number {
  if (width >= 1600) return 4;
  if (width <= 620) return 1;
  if (width <= 980) return 2;
  return 3;
}

async function jsonRequest(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    const err = new Error(body?.error ?? `HTTP ${r.status}`) as DashboardRequestError;
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

function statusClass(status: StatusMessage): string {
  return `oncall-status${status ? ` ${status.ok ? 'hint-ok' : 'hint-warn-inline'}` : ''}`;
}

export function SkillSegmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: ReactNode; help?: ReactNode }>;
  disabled?: boolean;
  onChange(value: T): void;
}): React.JSX.Element {
  const current = props.options.find(option => option.value === props.value);
  return (
    <div className="skills-segmented-control">
      <div className="segmented skills-segmented" role="group">
        {props.options.map(option => (
          <button
            key={option.value}
            type="button"
            className={props.value === option.value ? 'active' : ''}
            aria-pressed={props.value === option.value ? 'true' : 'false'}
            title={typeof option.help === 'string' ? option.help : undefined}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {current?.help ? <span className="skills-setting-hint">{current.help}</span> : null}
    </div>
  );
}

interface SkillsInstallPanelProps {
  showTitle?: boolean;
  installSource: string;
  installPath: string;
  installRef: string;
  installFullDepth: boolean;
  installTargetSkill?: string | null;
  installStatus: StatusMessage;
  installBusy: boolean;
  installDiscovering?: boolean;
  installSelectionOpen?: boolean;
  installCandidates?: InstallSkillCandidate[];
  selectedInstallSkills?: Set<string>;
  onInstallSourceChange: (value: string) => void;
  onInstallPathChange: (value: string) => void;
  onInstallRefChange: (value: string) => void;
  onInstallFullDepthChange: (value: boolean) => void;
  onClearInstallTarget?: () => void;
  onToggleInstallSkill?: (name: string) => void;
  onSelectAllInstallSkills?: (selected: boolean) => void;
  onConfirmInstallSelection?: () => void;
  onCloseInstallSelection?: () => void;
  onInstall: () => void;
  onOpenNativeDiscovery: () => void;
}

export function SkillsInstallPanel(props: SkillsInstallPanelProps) {
  const tr = useT();
  const selectionDialogRef = useRef<HTMLDialogElement | null>(null);
  const candidates = props.installCandidates ?? [];
  const selectedInstallSkills = props.selectedInstallSkills ?? new Set<string>();
  const allSelected = candidates.length > 0 && candidates.every(candidate => selectedInstallSkills.has(candidate.name));
  const busy = props.installBusy || props.installDiscovering;
  const sourceType = detectSourceType(props.installSource);
  const sourceTypeLabel = sourceType === 'github'
    ? tr('skills.sourceDetectedGithub')
    : sourceType === 'git'
      ? tr('skills.sourceDetectedGit')
      : sourceType === 'agentbuddy'
        ? tr('skills.sourceDetectedAgentbuddy')
        : sourceType === 'local'
          ? tr('skills.sourceDetectedLocal')
          : tr('skills.sourceDetectedUnknown');
  const sourcePreflight = sourceType === 'agentbuddy'
    ? tr('skills.sourcePreflightAgentbuddy')
    : sourceType === 'github' || sourceType === 'git'
      ? tr('skills.sourcePreflightGit')
      : sourceType === 'local'
        ? tr('skills.sourcePreflightLocal')
        : tr('skills.sourcePreflightUnknown');
  const diagnostic = sourceType === 'agentbuddy'
    ? tr('skills.installDiagnosticAgentbuddy')
    : sourceType === 'github' || sourceType === 'git'
      ? tr('skills.installDiagnosticGit')
      : sourceType === 'local'
        ? tr('skills.installDiagnosticLocal')
        : tr('skills.installDiagnosticUnknown');

  useEffect(() => {
    const dialog = selectionDialogRef.current;
    if (!dialog) return;
    if (props.installSelectionOpen && !dialog.open) {
      try { dialog.showModal(); } catch { /* dialog may already be opening */ }
    } else if (!props.installSelectionOpen && dialog.open) {
      dialog.close();
    }
  }, [props.installSelectionOpen, candidates.length]);

  return (
    <article className="bd-card skills-install-panel">
      {props.showTitle === false ? null : <div className="skills-install-title">
        <h3 className="bd-section-title">
          <FieldTitle help={tr('skills.installInfo')} helpLabel={tr('skills.installInfoLabel')}>
            {tr('skills.install')}
          </FieldTitle>
        </h3>
      </div>}
      {props.installTargetSkill ? (
        <div className="skills-inline-target" data-install-target={props.installTargetSkill}>
          <span>{tr('skills.installTargetHint', { skill: props.installTargetSkill })}</span>
          <button type="button" data-action="clear-install-target" onClick={() => props.onClearInstallTarget?.()}>
            {tr('skills.clearInstallTarget')}
          </button>
        </div>
      ) : null}
      <div className="skills-install-grid">
        <label className="skills-source-label">
          <FieldTitle
            help={(
              <span className="skills-source-help">
                <span><strong>{tr('skills.sourceHelpRemoteLabel')}</strong>{tr('skills.sourceHelpRemote')}</span>
                <span><strong>{tr('skills.sourceHelpLocalLabel')}</strong>{tr('skills.sourceHelpLocal')}</span>
                <span><strong>{tr('skills.sourceHelpAgentbuddyLabel')}</strong>{tr('skills.sourceHelpAgentbuddy')}</span>
              </span>
            )}
            helpLabel={tr('skills.source')}
          >
            {tr('skills.source')}
          </FieldTitle>
          <div className="skills-source-control">
            <input
              type="text"
              data-install="source"
              aria-label={tr('skills.source')}
              placeholder={tr('skills.sourcePlaceholder')}
              value={props.installSource}
              onChange={e => props.onInstallSourceChange(e.currentTarget.value)}
            />
          </div>
          <div className="skills-source-formats" aria-label={tr('skills.sourceFormats')}>
            <span>{tr('skills.sourceFormats')}</span>
            <code>owner/repo</code>
            <code>https://github.com/owner/repo/tree/main</code>
            <code>agentbuddy … skill add group/skill</code>
            <code>/path/to/skill</code>
          </div>
          {props.installSource.trim() ? (
            <div className={`skills-source-feedback is-${sourceType}`} data-source-hint={sourceType}>
              <strong>{sourceTypeLabel}</strong>
              <span>{sourcePreflight}</span>
            </div>
          ) : null}
        </label>
        <label className="skills-install-field-wide skills-install-path-field"><span>{tr('skills.path')}</span>
          <input
            type="text"
            data-install="path"
            placeholder={tr('skills.pathPlaceholder')}
            value={props.installPath}
            onChange={e => props.onInstallPathChange(e.currentTarget.value)}
          />
          <small>{tr('skills.pathHelpInline')}</small>
        </label>
        <label className="skills-install-field-wide skills-install-ref-field"><span>{tr('skills.ref')}</span>
          <input
            type="text"
            data-install="ref"
            placeholder={tr('skills.refPlaceholder')}
            value={props.installRef}
            onChange={e => props.onInstallRefChange(e.currentTarget.value)}
          />
          <small>{tr('skills.refHelpInline')}</small>
        </label>
        <div className="skills-install-actions">
          <button type="button" data-action="install" disabled={busy || !props.installSource.trim()} onClick={() => props.onInstall()}>
            {props.installDiscovering ? tr('skills.scanning') : props.installBusy ? tr('skills.jobRunning') : tr('skills.installSubmit')}
          </button>
        </div>
        <div className="skills-install-bottom-row">
          <div className="skills-scan-strategy">
            <label className="skills-scan-toggle">
              <input
                type="checkbox"
                data-install="full-depth"
                checked={props.installFullDepth}
                disabled={busy}
                onChange={event => props.onInstallFullDepthChange(event.currentTarget.checked)}
              />
              <span>
                <strong>{tr('skills.deepScan')}</strong>
                <small>{tr('skills.deepScanHelp')}</small>
              </span>
            </label>
            <p>{tr('skills.autoDeepScanHint')}</p>
          </div>
          <div className="skills-local-discovery-panel">
            <div>
              <strong>{tr('skills.localDiscoverTitle')}</strong>
              <span>{tr('skills.localDiscoverHelp')}</span>
            </div>
            <button type="button" data-action="open-native-skill-discovery" onClick={() => props.onOpenNativeDiscovery()}>
              {tr('skills.localDiscover')}
            </button>
          </div>
        </div>
      </div>
      {props.installStatus ? (
        <div className="actions skills-install-status-row">
          <span className={statusClass(props.installStatus)} data-skills-status>{props.installStatus.text}</span>
        </div>
      ) : null}
      {props.installStatus && !props.installStatus.ok ? (
        <div className="skills-install-diagnostic" data-install-diagnostic={sourceType} role="alert">
          <strong>{tr('skills.installDiagnosticTitle')}</strong>
          <span>{diagnostic}</span>
        </div>
      ) : null}
      <dialog
        className="skills-discovery-dialog skills-install-selection-dialog"
        data-install-selection-dialog
        ref={selectionDialogRef}
        onClose={() => props.onCloseInstallSelection?.()}
      >
        <article>
          <header>
            <h3>{tr('skills.installSelectionTitle')}</h3>
            <p>{tr('skills.installSelectionHelp', { count: candidates.length })}</p>
          </header>
          <div className="skills-discovery-body skills-install-selection-body">
            <div className="skills-candidate-list" data-install-candidates>
              <div className="skills-candidate-list-head">
                <span>{tr('skills.scanFound', { count: candidates.length })}</span>
                {props.onSelectAllInstallSkills ? (
                  <button
                    type="button"
                    data-action="toggle-all-source-skills"
                    disabled={props.installBusy}
                    onClick={() => props.onSelectAllInstallSkills?.(!allSelected)}
                  >
                    {allSelected ? tr('skills.discoverClearSelection') : tr('skills.discoverSelectAll')}
                  </button>
                ) : null}
              </div>
              {candidates.map(candidate => (
                <label key={`${candidate.name}:${candidate.path}`} className="skills-candidate-row">
                  <input
                    type="checkbox"
                    checked={selectedInstallSkills.has(candidate.name)}
                    disabled={props.installBusy}
                    onChange={() => props.onToggleInstallSkill?.(candidate.name)}
                  />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>{candidate.path}{candidate.description ? ` · ${candidate.description}` : ''}</small>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <footer className="actions">
            <button type="button" data-action="close-install-selection" disabled={props.installBusy} onClick={() => props.onCloseInstallSelection?.()}>
              {tr('skills.installSelectionCancel')}
            </button>
            <button
              type="button"
              className="primary"
              data-action="confirm-install-selection"
              disabled={props.installBusy || selectedInstallSkills.size === 0}
              onClick={() => props.onConfirmInstallSelection?.()}
            >
              {props.installBusy ? tr('skills.jobRunning') : tr('skills.installSelected')}
            </button>
          </footer>
        </article>
      </dialog>
    </article>
  );
}

export function InstalledSkillsLibrary(props: {
  skills: SkillRow[];
  busySkill: string | null;
  removingNames: Set<string>;
  status: StatusMessage;
  onUpdate(name: string): void;
  onRequestRemove(names: string[]): void;
  /** search prefill arriving from a cross-tab navigation */
  externalQuery?: string | null;
  /** exact-name filter arriving from a cross-tab navigation (clearable) */
  externalFilterNames?: string[] | null;
  /** false = pack data never loaded; pack usage counts are unknown, not 0 */
  packsKnown?: boolean;
  /** open the install wizard prefilled for a filtered-but-missing skill */
  onInstallMissing?: (name: string) => void;
  graph?: import('./skills/shared.js').SkillGraph;
  packNames?: Array<{ id: string; name: string }>;
  onShowSkillPacks?: (name: string) => void;
  onShowSkillBots?: (name: string) => void;
}) {
  const tr = useT();
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const previousSkillNamesRef = useRef(new Set(props.skills.map(skill => skill.name)));
  const queryRef = useRef('');
  const selectionModeRef = useRef(false);
  const escapeQueryRef = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filterNames, setFilterNames] = useState<Set<string> | null>(null);
  const [page, setPage] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1200 : window.innerWidth);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  queryRef.current = query;
  selectionModeRef.current = selectionMode;
  const filteredSkills = useMemo(() => {
    const base = filterNames ? props.skills.filter(skill => filterNames.has(skill.name)) : props.skills;
    if (!normalizedQuery) return base;
    return base.filter(skill => [
      skill.name,
      skill.displayName,
      skill.description,
      ...(skill.tags ?? []),
      sourceLabel(skill, tr),
    ].filter(Boolean).join('\n').toLocaleLowerCase().includes(normalizedQuery));
  }, [filterNames, normalizedQuery, props.skills, tr]);
  // Filter names that aren't installed (typically dangling refs from the
  // overview badge): rendered as actionable install rows, not silently hidden.
  const missingFiltered = useMemo(() => {
    if (!filterNames) return [];
    const installed = new Set(props.skills.map(skill => skill.name));
    return [...filterNames].filter(name => !installed.has(name)).sort();
  }, [filterNames, props.skills]);
  const pageSize = installedSkillsColumnCount(viewportWidth) * INSTALLED_SKILLS_ROWS_PER_PAGE;
  const pageCount = Math.max(1, Math.ceil(filteredSkills.length / pageSize));
  const visibleSkills = filteredSkills.slice(page * pageSize, page * pageSize + pageSize);
  const filteredNames = useMemo(() => new Set(filteredSkills.map(skill => skill.name)), [filteredSkills]);
  const selectedInResults = filteredSkills.filter(skill => selected.has(skill.name)).length;
  const hiddenSelectedCount = Math.max(0, selected.size - selectedInResults);
  const allResultsSelected = filteredSkills.length > 0 && selectedInResults === filteredSkills.length;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Cross-tab arrival: seed the search box / name filter once per incoming
  // intent. The parent consumes the intent right after, so neither re-applies.
  useEffect(() => {
    if (props.externalQuery != null && props.externalQuery !== '') setQuery(props.externalQuery);
  }, [props.externalQuery]);
  useEffect(() => {
    if (props.externalFilterNames && props.externalFilterNames.length > 0) {
      setFilterNames(new Set(props.externalFilterNames));
    }
  }, [props.externalFilterNames]);

  useEffect(() => setPage(0), [normalizedQuery, pageSize, filterNames]);

  useEffect(() => {
    setPage(current => Math.min(Math.max(0, current), pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    const installed = new Set(props.skills.map(skill => skill.name));
    const removed = [...previousSkillNamesRef.current].some(name => !installed.has(name));
    setSelected(current => {
      const next = new Set([...current].filter(name => installed.has(name)));
      return next.size === current.size ? current : next;
    });
    if (removed) {
      setSelectionMode(false);
      setSelected(new Set());
    }
    previousSkillNamesRef.current = installed;
  }, [props.skills]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedInResults > 0 && !allResultsSelected;
    }
  }, [allResultsSelected, selectedInResults]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !selectionModeRef.current) return;
      const preservedQuery = queryRef.current;
      escapeQueryRef.current = preservedQuery;
      event.preventDefault();
      event.stopPropagation();
      setSelectionMode(false);
      setSelected(new Set());
      window.setTimeout(() => {
        setQuery(current => current || preservedQuery);
        escapeQueryRef.current = null;
      }, 50);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeQueryRef.current === null) return;
      const preservedQuery = escapeQueryRef.current;
      escapeQueryRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      setQuery(preservedQuery);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  function toggleSelected(name: string): void {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleAllResults(): void {
    setSelected(current => {
      const next = new Set(current);
      if (allResultsSelected) {
        for (const name of filteredNames) next.delete(name);
      } else {
        for (const name of filteredNames) next.add(name);
      }
      return next;
    });
  }

  function cancelSelection(preserveQuery = false): void {
    const preservedQuery = query;
    setSelectionMode(false);
    setSelected(new Set());
    if (preserveQuery && typeof window !== 'undefined') {
      window.setTimeout(() => setQuery(preservedQuery), 0);
    }
  }

  return (
    <section className="skills-installed-block">
      <SectionHeader title={tr('skills.installed')} count={tr('skills.installedCount', { count: props.skills.length })} hint={tr('skills.installedHelp')}>
        <div className="skills-installed-header-actions">
          {selectionMode ? (
            <button type="button" data-action="cancel-installed-selection" onClick={() => cancelSelection()}>{tr('skills.cancel')}</button>
          ) : (
            <button
              type="button"
              data-action="select-installed-skills"
              disabled={props.skills.length === 0}
              onClick={() => setSelectionMode(true)}
            >{tr('skills.select')}</button>
          )}
        </div>
      </SectionHeader>
      <section className="bd-card skills-installed-panel">
        <div className="skills-library-toolbar">
          <label className="skills-installed-search">
            <span className="sr-only">{tr('skills.searchLabel')}</span>
            <input
              type="text"
              role="searchbox"
              inputMode="search"
              data-action="search-installed-skills"
              placeholder={tr('skills.searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key !== 'Escape' || !selectionMode) return;
                event.preventDefault();
                event.stopPropagation();
                cancelSelection(true);
              }}
            />
            {query ? (
              <button type="button" data-action="clear-installed-search" aria-label={tr('skills.clearSearch')} onClick={() => setQuery('')}>×</button>
            ) : null}
          </label>
          {selectionMode ? (
            <label className="skills-select-all-results">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allResultsSelected}
                disabled={filteredSkills.length === 0 || props.removingNames.size > 0}
                onChange={toggleAllResults}
              />
              <span>{normalizedQuery
                ? tr('skills.selectSearchResults', { count: filteredSkills.length })
                : tr('skills.selectAllSkills', { count: filteredSkills.length })}</span>
            </label>
          ) : null}
          {filterNames ? (
            <button
              type="button"
              className="skills-library-filter-chip"
              data-action="clear-library-filter"
              title={[...filterNames].join(', ')}
              aria-label={tr('skills.clearFilter')}
              onClick={() => setFilterNames(null)}
            >{tr('skills.libraryFilterActive', { count: filterNames.size })} ×</button>
          ) : null}
          {normalizedQuery ? <span className="skills-filter-count">{tr('skills.resultCount', { count: filteredSkills.length })}</span> : null}
          {pageCount > 1 ? (
            <div className="skills-pager">
              <button
                type="button"
                className="skills-pager-button"
                data-action="page-installed-skills"
                data-dir="-1"
                aria-label={tr('skills.prevPage')}
                title={tr('skills.prevPage')}
                disabled={page === 0}
                onClick={() => setPage(current => Math.max(0, current - 1))}
              >&lsaquo;</button>
              <span>{tr('skills.pageStatus', { page: page + 1, pages: pageCount })}</span>
              <button
                type="button"
                className="skills-pager-button"
                data-action="page-installed-skills"
                data-dir="1"
                aria-label={tr('skills.nextPage')}
                title={tr('skills.nextPage')}
                disabled={page >= pageCount - 1}
                onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))}
              >&rsaquo;</button>
            </div>
          ) : null}
        </div>

        <div className="skills-installed-live" role="status" aria-live="polite">
          {props.status ? <span className={statusClass(props.status)}>{props.status.text}</span> : null}
        </div>

        {missingFiltered.length > 0 && (
          <div className="skills-missing-list" data-missing-skills>
            <strong>{tr('skills.missingFilteredTitle')}</strong>
            {missingFiltered.map(name => (
              <div className="skills-missing-row" data-missing-skill={name} key={name}>
                <span className="skills-missing-row-name">{name}</span>
                <small className="muted">{tr('skills.dangling')}</small>
                <button
                  type="button"
                  data-action="install-dangling-skill"
                  disabled={!props.onInstallMissing}
                  onClick={() => props.onInstallMissing?.(name)}
                >{tr('skills.installNow')}</button>
              </div>
            ))}
          </div>
        )}

        {props.skills.length === 0 ? (
          <div className="skills-library-empty">
            <strong>{tr('skills.emptyTitle')}</strong>
            <p>{tr('skills.emptyHelp')}</p>
          </div>
        ) : filteredSkills.length === 0 && missingFiltered.length > 0 ? null : filteredSkills.length === 0 ? (
          <div className="skills-library-empty" data-empty="search">
            <strong>{tr('skills.noResultsTitle', { query: query.trim() })}</strong>
            <p>{tr('skills.noResultsHelp')}</p>
            <button type="button" data-action="clear-installed-search-empty" onClick={() => setQuery('')}>{tr('skills.clearSearch')}</button>
          </div>
        ) : (
          <div className="skills-list">
            {visibleSkills.map(skill => {
              const isSelected = selected.has(skill.name);
              const isRemoving = props.removingNames.has(skill.name);
              return (
                <article
                  className={`skills-row skills-installed-card${selectionMode ? ' is-selectable' : ''}${isSelected ? ' is-selected' : ''}${isRemoving ? ' is-removing' : ''}`}
                  data-skill={skill.name}
                  data-selection-mode={selectionMode ? 'true' : undefined}
                  key={skill.name}
                  aria-busy={isRemoving || undefined}
                  onClick={selectionMode ? () => toggleSelected(skill.name) : undefined}
                >
                  <div className="skills-row-body">
                    <div className="skills-row-title">
                      {selectionMode ? (
                        <input
                          type="checkbox"
                          aria-label={tr('skills.selectNamed', { skill: skill.displayName ?? skill.name })}
                          checked={isSelected}
                          disabled={isRemoving}
                          onClick={event => event.stopPropagation()}
                          onChange={() => toggleSelected(skill.name)}
                        />
                      ) : null}
                      <span>
                        <strong>{skill.displayName ?? skill.name}</strong>
                        {skill.displayName && skill.displayName !== skill.name ? <small className="skills-canonical-name">{skill.name}</small> : null}
                      </span>
                    </div>
                    {skill.description ? <p>{skill.description}</p> : null}
                    <small className="skills-source-badge">{sourceLabel(skill, tr)}</small>
                    {props.graph ? (() => {
                      const node = props.graph.skills.get(skill.name);
                      const packsUnknown = props.packsKnown === false;
                      const packCount = node?.packIds.length ?? 0;
                      const botCount = node ? new Set([...node.directBotIds, ...node.viaPackBotIds]).size : 0;
                      const packTitle = packsUnknown
                        ? tr('skills.healthUnknown')
                        : (node?.packIds ?? [])
                          .map(id => props.packNames?.find(pack => pack.id === id)?.name ?? id)
                          .join(', ');
                      return (
                        <span className="skills-usage-chips">
                          <button
                            type="button"
                            className="skills-usage-chip"
                            data-action="show-skill-packs"
                            disabled={packsUnknown || packCount === 0 || !props.onShowSkillPacks}
                            title={packTitle || undefined}
                            onClick={event => { event.stopPropagation(); props.onShowSkillPacks?.(skill.name); }}
                          >{packsUnknown ? tr('skills.usedInPacksUnknown') : tr('skills.usedInPacks', { count: packCount })}</button>
                          <button
                            type="button"
                            className="skills-usage-chip"
                            data-action="show-skill-bots"
                            disabled={botCount === 0 || !props.onShowSkillBots}
                            onClick={event => { event.stopPropagation(); props.onShowSkillBots?.(skill.name); }}
                          >{tr('skills.usedByBots', { count: botCount })}</button>
                        </span>
                      );
                    })() : null}
                    {isRemoving ? <span className="skills-removing-label">{tr('skills.removing')}</span> : null}
                  </div>
                  {selectionMode ? null : (
                    <div className="skills-card-actions">
                      <button type="button" data-action="update-skill" disabled={props.busySkill === `${skill.name}:update` || isRemoving} onClick={() => props.onUpdate(skill.name)}>
                        {tr('skills.update')}
                      </button>
                      <button type="button" data-action="remove-skill" disabled={isRemoving} onClick={() => props.onRequestRemove([skill.name])}>
                        {tr('skills.remove')}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {selectionMode ? (
        <div className="skills-bulk-action-bar" role="toolbar" aria-label={tr('skills.bulkActions')}>
          <span>
            <strong>{tr('skills.selectedCount', { count: selected.size })}</strong>
            {hiddenSelectedCount > 0 ? <small>{tr('skills.selectedHidden', { count: hiddenSelectedCount })}</small> : null}
          </span>
          <button
            type="button"
            className="danger"
            data-action="remove-selected-skills"
            disabled={selected.size === 0 || props.removingNames.size > 0}
            onClick={() => props.onRequestRemove([...selected])}
          >{tr('skills.removeSelected', { count: selected.size })}</button>
        </div>
      ) : null}
    </section>
  );
}

export function RemoveSkillsDialog(props: {
  names: string[] | null;
  references: SkillRemovalReference[];
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(force: boolean): void;
}): React.JSX.Element {
  const tr = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const names = props.names ?? [];
  const force = props.references.length > 0;
  const visibleNames = names.slice(0, 3);
  const referencedBotCount = new Set(props.references.flatMap(reference => reference.bots)).size;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.names && !dialog.open) {
      try { dialog.showModal(); } catch { /* dialog may already be opening */ }
    } else if (!props.names && dialog.open) {
      dialog.close();
    }
  }, [props.names]);

  return (
    <dialog
      className="skills-remove-dialog"
      data-remove-skills-dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        if (!props.busy) props.onCancel();
      }}
      onClick={event => {
        if (event.target === event.currentTarget && !props.busy) props.onCancel();
      }}
    >
      <article>
        <header>
          <h3>{force
            ? names.length === 1
              ? tr('skills.removeInUseOneTitle', { skill: names[0] })
              : tr('skills.removeInUseManyTitle', { count: names.length })
            : names.length === 1
              ? tr('skills.removeOneTitle', { skill: names[0] })
              : tr('skills.removeManyTitle', { count: names.length })}</h3>
          <p>{force
            ? names.length === 1
              ? tr('skills.removeInUseOneHelp', { count: referencedBotCount })
              : tr('skills.removeInUseManyHelp', { count: referencedBotCount })
            : names.length === 1
              ? tr('skills.removeOnePermanentHelp')
              : tr('skills.removePermanentHelp')}</p>
        </header>
        <div className="skills-remove-dialog-body">
          {names.length > 1 ? (
            <>
              <ul>
                {visibleNames.map(name => <li key={name}>{name}</li>)}
              </ul>
              {names.length > visibleNames.length ? <p>{tr('skills.removeMore', { count: names.length - visibleNames.length })}</p> : null}
            </>
          ) : null}
          {props.references.length > 0 ? (
            <div className="skills-remove-reference-warning" role="alert">
              <strong>{tr('skills.removeReferencesDetail')}</strong>
              <ul>
                {props.references.map(reference => (
                  <li key={reference.name}><strong>{reference.name}</strong><span>{reference.bots.join(', ')}</span></li>
                ))}
              </ul>
            </div>
          ) : null}
          {props.error ? <p className="hint-warn" role="alert">{props.error}</p> : null}
        </div>
        <footer className="actions">
          <button type="button" autoFocus disabled={props.busy} onClick={props.onCancel}>{tr('skills.cancel')}</button>
          <button type="button" className="danger" disabled={props.busy} onClick={() => props.onConfirm(force)}>
            {props.busy
              ? tr('skills.removing')
              : force
                ? tr('skills.removeAnyway')
                : names.length === 1
                  ? tr('skills.removeOneConfirm')
                  : tr('skills.removeSelected', { count: names.length })}
          </button>
        </footer>
      </article>
    </dialog>
  );
}

/** Exported for tests (cross-tab navigation integration). Mounted in the app
 * via renderSkillsPage below. */
export function SkillsPage() {
  const tr = useT();
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<number>>(new Set());
  const discoveryDialogRef = useRef<HTMLDialogElement | null>(null);

  const {
    skills, nativeSkillGroups, bots, packs, trustProjectSkills, delivery,
    loading, loadError, packsError, packsKnown, refresh,
    setSkills, setBots, setTrustProjectSkills, setDelivery,
  } = useSkillsData({ apiUnavailableText: tr('skills.apiUnavailable') });
  const [activeTab, setActiveTab] = useState<'packs' | 'library' | 'bots' | 'delivery'>('library');
  // Cross-tab navigation: a chip click in one table jumps to another tab with
  // context (search prefill / focused entity). The target tab consumes the
  // intent once so it doesn't re-apply on later visits.
  const [navIntent, setNavIntent] = useState<SkillsNavIntent | null>(null);
  // Sticky install target: when a missing skill sends the user to the install
  // wizard, the discovery result preselects just that skill. Prefill only —
  // installing still requires the user to point at a source and confirm.
  const [installTargetSkill, setInstallTargetSkill] = useState<string | null>(null);
  const navigateTo = useCallback((intent: SkillsNavIntent) => {
    setNavIntent(intent);
    setInstallTargetSkill(intent.installTargetSkill ?? null);
    setActiveTab(intent.tab);
  }, []);
  const consumeNavIntent = useCallback(() => setNavIntent(null), []);

  const [installSource, setInstallSource] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [installRef, setInstallRef] = useState('');
  const [installStatus, setInstallStatus] = useState<StatusMessage>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installDiscovering, setInstallDiscovering] = useState(false);
  const [installSelectionOpen, setInstallSelectionOpen] = useState(false);
  const [installCandidates, setInstallCandidates] = useState<InstallSkillCandidate[]>([]);
  /** operator explicitly asked to skip the shallow pass */
  const [installForceFullDepth, setInstallForceFullDepth] = useState(false);
  /** discovery had to fall back to a full-depth scan to find anything */
  const [installDeepScanned, setInstallDeepScanned] = useState(false);
  const [selectedInstallSkills, setSelectedInstallSkills] = useState<Set<string>>(() => new Set());
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [activeDiscoveryKey, setActiveDiscoveryKey] = useState<string | null>(null);
  const [selectedDiscovered, setSelectedDiscovered] = useState<Set<string>>(() => new Set());

  const [globalBusy, setGlobalBusy] = useState<'project' | 'delivery' | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [botBusy, setBotBusy] = useState<string | null>(null);
  const [botStatuses, setBotStatuses] = useState<Record<string, StatusMessage>>({});
  const [installedStatus, setInstalledStatus] = useState<StatusMessage>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string[] | null>(null);
  const [removalDialogOpen, setRemovalDialogOpen] = useState(false);
  const [removalReferences, setRemovalReferences] = useState<SkillRemovalReference[]>([]);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [removingNames, setRemovingNames] = useState<Set<string>>(() => new Set());

  const installedNames = useMemo(() => new Set(skills.map(skill => skill.name)), [skills]);
  const activeDiscoveryGroup = useMemo(() => {
    if (nativeSkillGroups.length === 0) return undefined;
    const active = activeDiscoveryKey ? nativeSkillGroups.find(group => discoveryGroupKey(group) === activeDiscoveryKey) : undefined;
    return active ?? nativeSkillGroups.find(group => group.skills.length > 0) ?? nativeSkillGroups[0];
  }, [activeDiscoveryKey, nativeSkillGroups]);
  const activeKey = activeDiscoveryGroup ? discoveryGroupKey(activeDiscoveryGroup) : '';
  const activeGroupSelectable = useMemo(() => {
    if (!activeDiscoveryGroup) return [];
    return activeDiscoveryGroup.skills
      .filter(skill => !installedNames.has(skill.name))
      .map(skill => skill.rootDir ?? skill.source?.root ?? '')
      .filter(Boolean);
  }, [activeDiscoveryGroup, installedNames]);
  const activeAllSelected = activeGroupSelectable.length > 0 && activeGroupSelectable.every(path => selectedDiscovered.has(path));

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current.clear();
  }, []);

  const delay = useCallback((ms: number) => new Promise<void>(resolve => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      resolve();
    }, ms);
    timersRef.current.add(id);
  }), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  // Drop native-discovery selections that became invalid after a refresh
  // (skill got installed, or its group disappeared).
  useEffect(() => {
    setSelectedDiscovered(selected => {
      const valid = new Set<string>();
      const installed = new Set(skills.map(skill => skill.name));
      for (const group of nativeSkillGroups) {
        for (const skill of group.skills) {
          const path = skill.rootDir ?? skill.source?.root ?? '';
          if (path && !installed.has(skill.name) && selected.has(path)) valid.add(path);
        }
      }
      return valid.size === selected.size ? selected : valid;
    });
  }, [skills, nativeSkillGroups]);

  useEffect(() => {
    if (!installedStatus || removingNames.size > 0) return undefined;
    const id = window.setTimeout(() => {
      if (mountedRef.current) setInstalledStatus(null);
    }, 6_000);
    return () => window.clearTimeout(id);
  }, [installedStatus, removingNames]);

  useEffect(() => {
    const dialog = discoveryDialogRef.current;
    if (!dialog) return;
    if (discoveryOpen && !dialog.open) {
      try { dialog.showModal(); } catch { /* dialog may already be closing */ }
    } else if (!discoveryOpen && dialog.open) {
      dialog.close();
    }
  }, [discoveryOpen, activeKey]);

  async function waitForSkillJob(job: SkillJob, setStatus: (status: StatusMessage) => void, refreshOnSuccess = true): Promise<SkillJob | null> {
    let current = job;
    setStatus({ text: tr('skills.jobRunning'), ok: true });
    for (;;) {
      if (!mountedRef.current) return null;
      if (current.status === 'succeeded') {
        setStatus({ text: tr('skills.saved'), ok: true });
        if (refreshOnSuccess) await refresh();
        return current;
      }
      if (current.status === 'failed') {
        throw new Error(current.error ?? 'job_failed');
      }
      await delay(800);
      if (!mountedRef.current) return null;
      const body = await jsonRequest(`/api/skills/jobs/${encodeURIComponent(current.id)}`, { method: 'GET' });
      if (!mountedRef.current) return null;
      current = body.job as SkillJob;
    }
  }

  function referencingBotLabels(skillName: string): string[] {
    return bots
      .filter(bot => priorityNames(bot.skills).includes(skillName))
      .map(bot => bot.botName ?? bot.larkAppId);
  }

  function clearInstallDiscovery(): void {
    setInstallCandidates([]);
    setSelectedInstallSkills(new Set());
    setInstallSelectionOpen(false);
    setInstallDeepScanned(false);
  }

  function sourceRequestBody(): Record<string, unknown> {
    // The source string is sent verbatim: parseSkillInstallSource() on the
    // daemon is the single authority for classification (GitHub shorthand,
    // git remotes, agentbuddy identifiers/commands, local paths). Rewriting it
    // here previously corrupted sources — `git+` was prepended to every
    // non-github http(s) URL, and client-side guessing diverged from the CLI.
    const source = installSource.trim();
    return {
      source,
      path: installPath.trim() || undefined,
      ref: installRef.trim() || undefined,
      ...(installForceFullDepth ? { fullDepth: true } : {}),
    };
  }

  function installRequestBody(
    skillNames?: string[],
    fullDepth = installForceFullDepth || installDeepScanned,
  ): Record<string, unknown> {
    const selected = skillNames ?? [...selectedInstallSkills];
    return {
      ...sourceRequestBody(),
      skillNames: selected.length > 0 ? selected : undefined,
      // If the candidates only surfaced under the recursive scan, the install
      // must use the same depth or it won't find them again.
      ...(fullDepth ? { fullDepth: true } : {}),
    };
  }

  async function discoverInstallCandidates(): Promise<{
    skills: InstallSkillCandidate[];
    directInstall: boolean;
    fullDepth: boolean;
  }> {
    setInstallDiscovering(true);
    setInstallStatus({ text: tr('skills.scanning'), ok: true });
    try {
      const body = await jsonRequest('/api/skills/discover', {
        method: 'POST',
        body: JSON.stringify(sourceRequestBody()),
      });
      if (!mountedRef.current) return { skills: [], directInstall: false, fullDepth: installForceFullDepth };
      const directInstall = body.discovery?.directInstall === true;
      const skills = Array.isArray(body.discovery?.skills) ? body.discovery.skills as InstallSkillCandidate[] : [];
      const deepScanned = body.discovery?.deepScanned === true;
      setInstallDeepScanned(deepScanned);
      setInstallCandidates(skills);
      // Target semantics: with an install target, only the matching candidate
      // is preselected; if the target isn't in this source, select nothing so
      // a wrong repo can't be accidentally bulk-confirmed.
      setSelectedInstallSkills(selectInstallCandidates(skills, installTargetSkill).selected);
      return { skills, directInstall, fullDepth: installForceFullDepth || deepScanned };
    } finally {
      if (mountedRef.current) setInstallDiscovering(false);
    }
  }

  // Translate the backend's terse install error codes into actionable messages.
  // agentbuddy runs on the deploy host, so its failures (missing CLI, not logged
  // in) need host-side guidance the operator can act on. Git authentication
  // failures get equivalent host-side guidance; other codes fall through.
  function mapInstallError(raw: string): string {
    const msg = raw || '';
    if (msg.startsWith('skill_git_command_failed') && /authentication failed|could not read username|repository not found|unauthor|\b401\b|\b403\b/i.test(msg)) {
      return tr('skills.gitNeedsAuth');
    }
    if (msg.startsWith('agentbuddy_not_found')) return tr('skills.agentbuddyNotFound');
    if (msg.startsWith('agentbuddy_login_required')) return tr('skills.agentbuddyNeedsLogin');
    if (msg.startsWith('agentbuddy_command_failed')) {
      return /login|credential|unauthor|not logged|401|403/i.test(msg)
        ? tr('skills.agentbuddyNeedsLogin')
        : tr('skills.agentbuddyCommandFailed');
    }
    if (msg.startsWith('agentbuddy_clear_telemetry_failed') || msg.startsWith('agentbuddy_telemetry_not_stripped')) return tr('skills.agentbuddyTelemetryFailed');
    if (msg.startsWith('agentbuddy_no_skill_produced')) return tr('skills.agentbuddyNoSkill');
    if (msg.startsWith('invalid_agentbuddy')) return tr('skills.agentbuddyInvalid');
    return msg;
  }

  async function submitSkillInstall(
    skillNames?: string[],
    fullDepth = installForceFullDepth || installDeepScanned,
  ): Promise<string[] | null> {
    setInstallBusy(true);
    try {
      const body = await jsonRequest('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify(installRequestBody(skillNames, fullDepth)),
      });
      if (!mountedRef.current) return null;
      const completed = await waitForSkillJob(body.job as SkillJob, setInstallStatus);
      if (!mountedRef.current || !completed) return null;
      const installed = (completed.skills ?? (completed.skill ? [completed.skill] : []))
        .map(skill => skill.name)
        .filter(Boolean);
      clearInstallDiscovery();
      setInstallTargetSkill(null);
      return [...new Set(installed.length > 0 ? installed : (skillNames ?? []))];
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`, ok: false });
      return null;
    } finally {
      if (mountedRef.current) setInstallBusy(false);
    }
  }

  function toggleInstallCandidate(name: string): void {
    setSelectedInstallSkills(current => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAllInstallCandidates(selected: boolean): void {
    setSelectedInstallSkills(selected ? new Set(installCandidates.map(candidate => candidate.name)) : new Set());
  }

  async function installSkill(): Promise<string[] | null> {
    if (!installSource.trim()) {
      setInstallStatus({ text: tr('skills.sourceRequired'), ok: false });
      return null;
    }
    try {
      setInstallSelectionOpen(false);
      const { skills, directInstall, fullDepth } = await discoverInstallCandidates();
      if (!mountedRef.current) return null;
      // agentbuddy sources — a pasted `agentbuddy:<id>` OR a marketplace URL the
      // backend recognized — resolve their own skill set, so install directly
      // (no candidate selection). The server decides this so the client needn't
      // know the identifier prefix or the configured marketplace hosts.
      if (directInstall) {
        return await submitSkillInstall(undefined, fullDepth);
      }
      if (skills.length === 0) {
        setInstallStatus({ text: tr('skills.scanEmpty'), ok: false });
        return null;
      }
      const { targetMissing } = selectInstallCandidates(skills, installTargetSkill);
      // Single-candidate fast path only when it doesn't contradict the target:
      // if the user came to install a specific skill and this source doesn't
      // have it, fall through to the (empty) selection + warning instead.
      if (skills.length === 1 && !targetMissing) {
        return await submitSkillInstall([skills[0].name], fullDepth);
      }
      setInstallStatus(targetMissing
        ? { text: tr('skills.installTargetNotFound', { skill: installTargetSkill! }), ok: false }
        : { text: tr('skills.scanFound', { count: skills.length }), ok: true });
      setInstallSelectionOpen(true);
      return null;
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`, ok: false });
      return null;
    }
  }

  async function confirmInstallSelection(): Promise<string[] | null> {
    const selected = [...selectedInstallSkills];
    if (selected.length === 0) {
      setInstallStatus({ text: tr('skills.discoverNothingSelected'), ok: false });
      return null;
    }
    return await submitSkillInstall(selected);
  }

  async function createPackFromInstalledSkills(input: { id: string; name: string; skillNames: string[] }): Promise<void> {
    await jsonRequest('/api/skill-packs', {
      method: 'POST',
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        include: input.skillNames.map(skillName => `skill:${skillName}`),
      }),
    });
    if (!mountedRef.current) return;
    await refresh();
    if (mountedRef.current) setActiveTab('packs');
  }

  async function registerDiscoveredSkills(): Promise<void> {
    const selected = [...selectedDiscovered].filter(Boolean);
    if (selected.length === 0) {
      setInstallStatus({ text: tr('skills.discoverNothingSelected'), ok: false });
      return;
    }
    setDiscoveryBusy(true);
    try {
      setInstallStatus({ text: tr('skills.discoverRegisteringBatch', { total: selected.length }), ok: true });
      await jsonRequest('/api/skills/install-local-links', {
        method: 'POST',
        body: JSON.stringify({ sources: selected }),
      });
      if (!mountedRef.current) return;
      setDiscoveryOpen(false);
      await refresh();
      if (mountedRef.current) setInstallStatus({ text: tr('skills.saved'), ok: true });
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`, ok: false });
    } finally {
      if (mountedRef.current) setDiscoveryBusy(false);
    }
  }

  async function updateGlobalProject(next: ProjectTrustMode): Promise<void> {
    if (trustProjectSkills === next) return;
    setGlobalBusy('project');
    try {
      const body = await jsonRequest('/api/skills/global', {
        method: 'PUT',
        body: JSON.stringify({ trustProjectSkills: next }),
      });
      if (!mountedRef.current) return;
      setTrustProjectSkills(body.trustProjectSkills === 'all' ? 'all' : next);
    } catch (err: any) {
      if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`);
    } finally {
      if (mountedRef.current) setGlobalBusy(null);
    }
  }

  async function updateGlobalDelivery(next: DeliveryMode): Promise<void> {
    if (delivery === next) return;
    setGlobalBusy('delivery');
    try {
      const body = await jsonRequest('/api/skills/global', {
        method: 'PUT',
        body: JSON.stringify({ delivery: next }),
      });
      if (!mountedRef.current) return;
      setDelivery(body.delivery === 'prompt' || body.delivery === 'native' ? body.delivery : next);
    } catch (err: any) {
      if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`);
    } finally {
      if (mountedRef.current) setGlobalBusy(null);
    }
  }

  async function updateSkill(name: string): Promise<void> {
    setSkillBusy(`${name}:update`);
    try {
      const body = await jsonRequest(`/api/skills/${encodeURIComponent(name)}/update`, { method: 'POST', body: '{}' });
      if (!mountedRef.current) return;
      await waitForSkillJob(body.job as SkillJob, setInstallStatus);
    } catch (err: any) {
      if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`);
    } finally {
      if (mountedRef.current) setSkillBusy(null);
    }
  }

  function requestSkillRemoval(names: string[]): void {
    const unique = [...new Set(names.filter(name => installedNames.has(name)))];
    if (unique.length === 0) return;
    setPendingRemoval(unique);
    setRemovalDialogOpen(true);
    setRemovalReferences([]);
    setRemovalError(null);
  }

  function cancelSkillRemoval(): void {
    if (removingNames.size > 0) return;
    setRemovalDialogOpen(false);
    setPendingRemoval(null);
    setRemovalReferences([]);
    setRemovalError(null);
  }

  async function confirmSkillRemoval(force: boolean): Promise<void> {
    const names = pendingRemoval ?? [];
    if (names.length === 0) return;
    setRemovingNames(new Set(names));
    setRemovalDialogOpen(false);
    setRemovalError(null);
    setInstalledStatus({ text: tr('skills.removingCount', { count: names.length }), ok: true });
    try {
      const body = await jsonRequest('/api/skills', {
        method: 'DELETE',
        body: JSON.stringify({ names, force }),
      });
      if (!mountedRef.current) return;
      const removed = Array.isArray(body.removed) ? body.removed.filter((name: unknown): name is string => typeof name === 'string') : names;
      const removedNames = new Set(removed);
      setSkills(current => current.filter(skill => !removedNames.has(skill.name)));
      setInstalledStatus({
        text: removed.length === 1
          ? tr('skills.removedOne', { skill: removed[0] })
          : tr('skills.removedMany', { count: removed.length }),
        ok: true,
      });
      setPendingRemoval(null);
      setRemovalReferences([]);
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err?.status === 409 && err?.body?.error === 'skills_in_use') {
        const references = Array.isArray(err.body.affectedSkills)
          ? err.body.affectedSkills.map((item: any): SkillRemovalReference | null => {
            const name = typeof item?.name === 'string' ? item.name : '';
            const bots = Array.isArray(item?.affectedBots)
              ? item.affectedBots.map((bot: any) => bot?.botName || bot?.larkAppId || '').filter(Boolean)
              : referencingBotLabels(name);
            return name ? { name, bots } : null;
          }).filter((item: SkillRemovalReference | null): item is SkillRemovalReference => item !== null)
          : [];
        setRemovalReferences(references);
        setRemovalDialogOpen(true);
        setInstalledStatus(null);
        return;
      }
      const message = tr('skills.removeFailed', { detail: mapInstallError(err?.message ?? String(err)) });
      setRemovalError(message);
      setRemovalDialogOpen(true);
      setInstalledStatus({ text: message, ok: false });
    } finally {
      if (mountedRef.current) setRemovingNames(new Set());
    }
  }

  async function setBotAssignment(appId: string, skillNames: string[], packIdsList: string[]): Promise<void> {
    const busyKey = `${appId}:set`;
    setBotBusy(busyKey);
    setBotStatuses(statuses => ({ ...statuses, [appId]: null }));
    try {
      // Single merge-write: direct skills + packs are saved together to avoid two
      // full-policy PUTs racing and silently overwriting each other. Unknown
      // selectors (e.g. set via CLI) are retained for forward/downgrade compat.
      const currentBot = bots.find(bot => bot.larkAppId === appId);
      const mergedInclude = mergeBotAssignmentSelectors(currentBot?.skills, skillNames, packIdsList);
      const body = await jsonRequest(`/api/bots/${encodeURIComponent(appId)}/skills`, {
        method: 'PUT',
        body: JSON.stringify({
          action: 'set',
          policy: mergedInclude.length > 0 ? { include: mergedInclude } : null,
        }),
      });
      if (!mountedRef.current) return;
      setBots(rows => rows.map(bot => bot.larkAppId === appId ? { ...bot, skills: body.skills ?? null } : bot));
      setBotStatuses(statuses => ({
        ...statuses,
        [appId]: { text: tr('skills.policySaved'), ok: true },
      }));
    } catch (err: any) {
      if (mountedRef.current) {
        setBotStatuses(statuses => ({
          ...statuses,
          [appId]: { text: `${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`, ok: false },
        }));
      }
      throw err;
    } finally {
      if (mountedRef.current) setBotBusy(null);
    }
  }

  async function setBotInjection(appId: string, value: 'global' | 'prompt' | 'off'): Promise<void> {
    setBotStatuses(statuses => ({ ...statuses, [appId]: null }));
    try {
      await jsonRequest(`/api/bots/${encodeURIComponent(appId)}/skill-injection`, {
        method: 'PUT',
        body: JSON.stringify({ skillInjection: value }),
      });
      if (!mountedRef.current) return;
      setBots(rows => rows.map(bot => bot.larkAppId === appId ? { ...bot, skillInjection: value } : bot));
      setBotStatuses(statuses => ({ ...statuses, [appId]: { text: tr('skills.saved'), ok: true } }));
    } catch (err: any) {
      if (mountedRef.current) {
        setBotStatuses(statuses => ({ ...statuses, [appId]: { text: `${tr('skills.failed')}: ${err?.message ?? err}`, ok: false } }));
      }
    }
  }

  const configuredBotCount = bots.filter(bot => policyConfigured(bot.skills)).length;
  // Count every policy selector (skill: AND pack:), not just direct skills —
  // otherwise pack-only bots show 0 despite being configured.
  const attachedSkillRefCount = bots.reduce((sum, bot) => sum + (bot.skills?.include?.length ?? 0), 0);

  // Single relationship model for the whole page: skill ↔ pack ↔ bot edges,
  // including skills that are referenced but not installed.
  const skillGraph = useMemo(
    () => buildSkillGraph(skills, packs, bots, { packsKnown }),
    [skills, packs, bots, packsKnown],
  );
  const danglingSkills = useMemo(() => danglingSkillNames(skillGraph), [skillGraph]);
  const unassignedPackIds = useMemo(
    () => [...skillGraph.packs.values()].filter(pack => pack.botIds.length === 0).map(pack => pack.id),
    [skillGraph],
  );
  const botsWithIssues = useMemo(
    () => [...skillGraph.bots.values()]
      .filter(bot => bot.health === 'missing' || bot.health === 'pack_missing')
      .map(bot => bot.larkAppId),
    [skillGraph],
  );

  const headingActions = (
    <div className="page-heading-actions skills-heading-actions">
      <div className="skills-metric-strip">
        <span><small>{tr('skills.metricInstalled')}</small><strong>{skills.length}</strong></span>
        <span><small>{tr('skills.metricPacks')}</small><strong>{packsKnown ? packs.length : '—'}</strong></span>
        <span><small>{tr('skills.metricBots')}</small><strong>{configuredBotCount}/{bots.length}</strong></span>
        <span><small>{tr('skills.metricAttached')}</small><strong>{attachedSkillRefCount}</strong></span>
      </div>
      <div className="skills-issue-strip" role="group" aria-label={tr('skills.issuesLabel')}>
        {danglingSkills.length > 0 && (
          <button
            type="button"
            className="skills-issue-badge skills-issue-warn"
            data-action="issue-dangling-skills"
            title={danglingSkills.join(', ')}
            onClick={() => navigateTo(danglingSkills.length === 1
              ? {
                tab: 'library',
                librarySearch: danglingSkills[0],
                openInstallWizard: true,
                installTargetSkill: danglingSkills[0],
              }
              : { tab: 'library', libraryFilterSkills: danglingSkills })}
          >{tr('skills.issueDangling', { count: danglingSkills.length })}</button>
        )}
        {unassignedPackIds.length > 0 && (
          <button
            type="button"
            className="skills-issue-badge skills-issue-info"
            data-action="issue-unassigned-packs"
            onClick={() => navigateTo({ tab: 'packs', focusPackIds: unassignedPackIds })}
          >{tr('skills.issueUnassignedPacks', { count: unassignedPackIds.length })}</button>
        )}
        {botsWithIssues.length > 0 && (
          <button
            type="button"
            className="skills-issue-badge skills-issue-warn"
            data-action="issue-bots-missing"
            onClick={() => navigateTo({ tab: 'bots', focusBotIds: botsWithIssues })}
          >{tr('skills.issueBotsMissing', { count: botsWithIssues.length })}</button>
        )}
        {!loading && packsKnown && danglingSkills.length === 0 && unassignedPackIds.length === 0 && botsWithIssues.length === 0 && (
          <span className="skills-issue-badge skills-issue-ok" data-skills-healthy>{tr('skills.issueNone')}</span>
        )}
      </div>
      <RefreshIconButton id="skills-refresh" label={tr('skills.refresh')} busy={loading} disabled={loading} onClick={() => void refresh()} />
    </div>
  );

  const body = (
    <div className="skills-page-stack">
      {loading ? <LoadingState label={tr('common.loading')} /> : loadError ? <p className="hint-warn">{loadError}</p> : (
        <>
          {packsError && (
            <p className="hint-warn" data-packs-error role="alert">
              {tr(packsKnown ? 'skills.packsLoadError' : 'skills.packsLoadErrorFirst', { error: packsError })}
            </p>
          )}
          <div className="skills-tabs" role="tablist">
            <button role="tab" aria-selected={activeTab === 'library'} className={activeTab === 'library' ? 'active' : ''} onClick={() => setActiveTab('library')}>
              {tr('skills.tabLibrary')}
            </button>
            <button role="tab" aria-selected={activeTab === 'packs'} className={activeTab === 'packs' ? 'active' : ''} onClick={() => setActiveTab('packs')}>
              {tr('skills.tabPacks')}
            </button>
            <button role="tab" aria-selected={activeTab === 'bots'} className={activeTab === 'bots' ? 'active' : ''} onClick={() => setActiveTab('bots')}>
              {tr('skills.tabBots')}
            </button>
            <button role="tab" aria-selected={activeTab === 'delivery'} className={activeTab === 'delivery' ? 'active' : ''} onClick={() => setActiveTab('delivery')}>
              {tr('skills.tabDelivery')}
            </button>
          </div>

          {activeTab === 'packs' && (
            <SkillPacksTab
              skills={skills}
              packs={packs}
              packsKnown={packsKnown}
              onRefresh={() => void refresh()}
              focusPackId={navIntent?.tab === 'packs' ? navIntent.focusPackId ?? null : null}
              focusPackIds={navIntent?.tab === 'packs' ? navIntent.focusPackIds ?? null : null}
              onFocusConsumed={consumeNavIntent}
              onOpenBot={botId => navigateTo({ tab: 'bots', focusBotIds: [botId] })}
              onInstallMissingSkill={name => navigateTo({
                tab: 'library',
                librarySearch: name,
                openInstallWizard: true,
                installTargetSkill: name,
              })}
            />
          )}

          {activeTab === 'library' && (
            <SkillLibraryTab
              skills={skills}
              nativeSkillGroups={nativeSkillGroups}
              installSource={installSource}
              installPath={installPath}
              installRef={installRef}
              installFullDepth={installForceFullDepth}
              installStatus={installStatus}
              installBusy={installBusy}
              installDiscovering={installDiscovering}
              installSelectionOpen={installSelectionOpen}
              installCandidates={installCandidates}
              selectedInstallSkills={selectedInstallSkills}
              onInstallSourceChange={(value) => { setInstallSource(value); clearInstallDiscovery(); }}
              onInstallPathChange={(value) => { setInstallPath(value); clearInstallDiscovery(); }}
              onInstallRefChange={(value) => { setInstallRef(value); clearInstallDiscovery(); }}
              onInstallFullDepthChange={(value) => { setInstallForceFullDepth(value); clearInstallDiscovery(); }}
              onToggleInstallSkill={toggleInstallCandidate}
              onSelectAllInstallSkills={selectAllInstallCandidates}
              onConfirmInstallSelection={confirmInstallSelection}
              onCloseInstallSelection={() => setInstallSelectionOpen(false)}
              onInstall={installSkill}
              onOpenNativeDiscovery={() => setDiscoveryOpen(true)}
              onCreatePack={createPackFromInstalledSkills}
              InstallPanel={SkillsInstallPanel}
              InstalledLibrary={InstalledSkillsLibrary}
              RemoveDialog={RemoveSkillsDialog}
              removingNames={removingNames}
              removalDialogOpen={removalDialogOpen}
              pendingRemoval={pendingRemoval}
              removalReferences={removalReferences}
              removalError={removalError}
              skillBusy={skillBusy}
              installedStatus={installedStatus}
              onUpdateSkill={name => void updateSkill(name)}
              onRequestRemove={requestSkillRemoval}
              onCancelRemoval={cancelSkillRemoval}
              onConfirmRemoval={force => void confirmSkillRemoval(force)}
              navIntent={navIntent?.tab === 'library' ? navIntent : null}
              onNavIntentConsumed={consumeNavIntent}
              installTargetSkill={installTargetSkill}
              onClearInstallTarget={() => setInstallTargetSkill(null)}
              packsKnown={packsKnown}
              onInstallMissing={name => navigateTo({
                tab: 'library',
                openInstallWizard: true,
                installTargetSkill: name,
              })}
              graph={skillGraph}
              packNames={packs.map(pack => ({ id: pack.id, name: pack.name }))}
              onShowSkillPacks={name => {
                const packIdsOfSkill = skillGraph.skills.get(name)?.packIds ?? [];
                // One pack → open its editor; several → highlight them all.
                navigateTo(packIdsOfSkill.length === 1
                  ? { tab: 'packs', focusPackId: packIdsOfSkill[0] }
                  : { tab: 'packs', focusPackIds: packIdsOfSkill });
              }}
              onShowSkillBots={name => navigateTo({ tab: 'bots', focusSkill: name })}
            />
          )}

          {activeTab === 'bots' && (
            <BotAssignmentsTab
              bots={bots}
              skills={skills}
              statuses={botStatuses}
              onSave={setBotAssignment}
              packs={packs}
              packsKnown={packsKnown}
              focusBotIds={navIntent?.tab === 'bots' ? navIntent.focusBotIds ?? null : null}
              focusSkill={navIntent?.tab === 'bots' ? navIntent.focusSkill ?? null : null}
              onFocusConsumed={consumeNavIntent}
              onOpenPack={packId => navigateTo({ tab: 'packs', focusPackId: packId })}
              onOpenSkill={name => navigateTo({ tab: 'library', librarySearch: name })}
            />
          )}

          {activeTab === 'delivery' && (
            <DeliverySettingsTab
              trustProjectSkills={trustProjectSkills}
              delivery={delivery}
              globalBusy={globalBusy}
              onUpdateProject={value => void updateGlobalProject(value)}
              onUpdateDelivery={value => void updateGlobalDelivery(value)}
              bots={bots}
              onUpdateBotInjection={setBotInjection}
              botStatuses={botStatuses}
              SkillSegmented={SkillSegmented}
            />
          )}

          <dialog
            className="skills-discovery-dialog"
            id="skills-discovery-dialog"
            ref={discoveryDialogRef}
            onClose={() => setDiscoveryOpen(false)}
            onClick={event => {
              if (event.target === event.currentTarget) setDiscoveryOpen(false);
            }}
          >
            <article>
              <header>
                <h3>{tr('skills.discoverTitle')}</h3>
                <p>{tr('skills.discoverHelp')}</p>
                <button
                  type="button"
                  className="skills-discovery-close"
                  data-action="close-discovery"
                  aria-label={tr('skills.discoverClose')}
                  title={tr('skills.discoverClose')}
                  onClick={() => setDiscoveryOpen(false)}
                />
              </header>
              <div className="skills-discovery-body">
                {!activeDiscoveryGroup ? <p className="empty">{tr('skills.discoverEmpty')}</p> : (
                  <>
                    <div className="skills-discovery-layout">
                      <div className="skills-discovery-tabs" role="tablist" aria-label={tr('skills.discoverTitle')}>
                        {nativeSkillGroups.map(group => {
                          const key = discoveryGroupKey(group);
                          const selected = key === activeKey;
                          return (
                            <button
                              key={key}
                              type="button"
                              role="tab"
                              data-discovery-tab={key}
                              className={selected ? 'selected' : ''}
                              aria-selected={selected ? 'true' : 'false'}
                              onClick={() => setActiveDiscoveryKey(key)}
                            >
                              <strong>{group.label ?? group.cliId}</strong>
                              <small>{tr('skills.skillCount', { count: group.skills.length })}</small>
                            </button>
                          );
                        })}
                      </div>
                      <div className="skills-discovery-main">
                        <div className="skills-discovery-path"><code>{activeDiscoveryGroup.rootDir}</code></div>
                        {nativeSkillGroups.map(group => {
                        const key = discoveryGroupKey(group);
                        const selected = key === activeKey;
                        return (
                          <section className="skills-discovery-group" data-discovery-panel={key} hidden={!selected} key={key}>
                            {group.skills.length === 0 ? <p className="empty">{tr('skills.discoverGroupEmpty')}</p> : (
                              <div className="skills-discovery-list">
                                {group.skills.map(skill => {
                                  const already = installedNames.has(skill.name);
                                  const path = skill.rootDir ?? skill.source?.root ?? '';
                                  return (
                                    <label className={`skills-discovery-row${already ? ' installed' : ''}`} key={`${skill.name}:${path}`}>
                                      <input
                                        type="checkbox"
                                        data-discovered-skill
                                        value={path}
                                        disabled={already}
                                        checked={!already && selectedDiscovered.has(path)}
                                        onChange={e => {
                                          const checked = e.currentTarget.checked;
                                          setSelectedDiscovered(prev => {
                                            const next = new Set(prev);
                                            if (checked) next.add(path);
                                            else next.delete(path);
                                            return next;
                                          });
                                        }}
                                      />
                                      <span>
                                        <strong>{skill.name}</strong>
                                        {skill.description ? <small>{skill.description}</small> : null}
                                      </span>
                                      {already ? <em>{tr('skills.discoverRegistered')}</em> : null}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </section>
                        );
                      })}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <footer className="actions">
                <button
                  type="button"
                  data-action="toggle-discovered-skills"
                  disabled={activeGroupSelectable.length === 0}
                  onClick={() => {
                    setSelectedDiscovered(prev => {
                      const next = new Set(prev);
                      if (activeAllSelected) activeGroupSelectable.forEach(path => next.delete(path));
                      else activeGroupSelectable.forEach(path => next.add(path));
                      return next;
                    });
                  }}
                >
                  {activeAllSelected ? tr('skills.discoverClearSelection') : tr('skills.discoverSelectAll')}
                </button>
                <button type="button" className="primary" data-action="register-discovered-skills" disabled={discoveryBusy} onClick={() => void registerDiscoveredSkills()}>
                  {tr('skills.discoverRegister')}
                </button>
              </footer>
            </article>
          </dialog>
        </>
      )}
    </div>
  );

  return (
    <section className="page skills-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.skills')}</p>
          <h1>{tr('skills.title')}</h1>
        </div>
        {headingActions}
      </div>
      <div id="skills-body">{body}</div>
    </section>
  );
}

function sameSkillSelection(left: Set<string>, right: string[]): boolean {
  return left.size === right.length && right.every(name => left.has(name));
}

export function SkillMultiPicker(props: {
  botId: string;
  names: string[];
  installedNames: Set<string>;
  skills: SkillRow[];
  busy: boolean;
  onSave(names: string[]): Promise<void>;
}): React.JSX.Element {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Set<string>>(() => new Set(props.names));
  const [position, setPosition] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const currentNamesKey = props.names.join('\n');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const options = useMemo(() => {
    const byName = new Map(props.skills.map(skill => [skill.name, skill]));
    for (const name of props.names) {
      if (!byName.has(name)) byName.set(name, { name });
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [props.names, props.skills]);
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter(skill => `${skill.name} ${skill.description || ''}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options]);
  const dirty = !sameSkillSelection(draft, props.names);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const edge = 12;
    const gap = 7;
    const width = Math.min(370, Math.max(260, window.innerWidth - edge * 2));
    const left = Math.min(Math.max(edge, rect.left), Math.max(edge, window.innerWidth - width - edge));
    const spaceAbove = Math.max(0, rect.top - gap - edge);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - edge);
    const placeAbove = spaceAbove > spaceBelow;
    const available = placeAbove ? spaceAbove : spaceBelow;
    const desired = 118 + Math.min(options.length, 5) * 42;
    const height = Math.max(180, Math.min(desired, available));
    setPosition({
      left,
      top: placeAbove ? Math.max(edge, rect.top - gap - height) : rect.bottom + gap,
      width,
      height,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) setDraft(new Set(props.names));
  }, [currentNamesKey, open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node) || popoverRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery('');
      setDraft(new Set(props.names));
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    updatePosition();
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [currentNamesKey, open, updatePosition]);

  function openPicker(): void {
    setDraft(new Set(props.names));
    setQuery('');
    updatePosition();
    setOpen(true);
  }

  function cancel(): void {
    setDraft(new Set(props.names));
    setQuery('');
    setOpen(false);
  }

  function toggle(name: string): void {
    setDraft(current => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function save(): Promise<void> {
    const names = [...draft].sort((left, right) => left.localeCompare(right));
    try {
      await props.onSave(names);
      setQuery('');
      setOpen(false);
    } catch {
      // The card-level status message explains the failure; keep the draft open for retry.
    }
  }

  const triggerLabel = props.names.length === 0
    ? tr('skills.pickerPlaceholder')
    : props.names.length === 1
      ? props.names[0]
      : tr('skills.pickerSelectedCount', { count: props.names.length });

  const popover = open ? (
    <div
      ref={popoverRef}
      className="skills-multi-picker-popover"
      style={position ? { left: position.left, top: position.top, width: position.width, height: position.height } : undefined}
    >
      <div className="skills-multi-picker-head">
        <label className="skills-multi-picker-search">
          <span className="skills-multi-picker-search-icon" aria-hidden="true" />
          <input
            type="search"
            data-action="search-skills"
            autoFocus
            autoComplete="off"
            value={query}
            placeholder={tr('skills.pickerSearchPlaceholder')}
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
            }}
          />
        </label>
        <div className="skills-multi-picker-meta">
          <span>{tr('skills.pickerSelectionMeta', { selected: draft.size, total: options.length })}</span>
          {draft.size > 0 ? (
            <button type="button" className="skills-multi-picker-clear" data-action="clear-skill-selection" onClick={() => setDraft(new Set())}>
              {tr('skills.pickerClear')}
            </button>
          ) : null}
        </div>
      </div>
      <div className="skills-multi-picker-options" role="listbox" aria-label={tr('skills.priority')} aria-multiselectable="true">
        {filteredOptions.map(skill => {
          const selected = draft.has(skill.name);
          const dangling = !props.installedNames.has(skill.name);
          return (
            <button
              type="button"
              className={`skills-multi-picker-option${selected ? ' selected' : ''}${dangling ? ' dangling' : ''}`}
              role="option"
              aria-selected={selected}
              data-skill-name={skill.name}
              key={skill.name}
              onClick={() => toggle(skill.name)}
            >
              <span className="skills-multi-picker-check" aria-hidden="true" />
              <span className="skills-multi-picker-option-copy">
                <span><b>{skill.name}</b>{dangling ? <em>{tr('skills.dangling')}</em> : null}</span>
                {skill.description ? <small>{skill.description}</small> : null}
              </span>
            </button>
          );
        })}
        {filteredOptions.length === 0 ? <p className="skills-multi-picker-empty">{tr('skills.pickerNoResults')}</p> : null}
      </div>
      <footer className="skills-multi-picker-actions">
        <button type="button" className="ghost" data-action="cancel-skill-selection" disabled={props.busy} onClick={cancel}>{tr('skills.cancel')}</button>
        <button type="button" className="primary" data-action="save-skill-selection" disabled={!dirty || props.busy} onClick={() => void save()}>
          {props.busy ? tr('skills.saving') : tr('skills.saveSelection')}
        </button>
      </footer>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`skills-multi-picker${open ? ' open' : ''}`} data-skill-picker={props.botId}>
      <button
        ref={triggerRef}
        type="button"
        className="skills-multi-picker-trigger"
        data-action="open-skill-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => open ? cancel() : openPicker()}
      >
        <span className="skills-multi-picker-trigger-copy">
          <b>{triggerLabel}</b>
          <small>{tr('skills.pickerTriggerHint')}</small>
        </span>
        <span className="skills-multi-picker-chevron" aria-hidden="true" />
      </button>
      {popover && typeof document !== 'undefined' ? createPortal(popover, document.body) : popover}
    </div>
  );
}

export function BotPolicyCard(props: {
  bot: BotRow;
  installedNames: Set<string>;
  skills: SkillRow[];
  status: StatusMessage;
  busyKey: string | null;
  onSave(appId: string, names: string[]): Promise<void>;
}) {
  const tr = useT();
  const { bot, installedNames, skills, status, busyKey, onSave } = props;
  const label = bot.botName ?? bot.larkAppId;
  const names = priorityNames(bot.skills);

  if (bot.error) {
    return (
      <article className="bd-card skills-bot-card" data-appid={bot.larkAppId}>
        <header>
          <Html html={botAvatarHtml({ name: label, larkAppId: bot.larkAppId, size: 'sm' })} />
          <strong>{label}</strong>
        </header>
        <p className="hint-warn-inline">{bot.error}</p>
      </article>
    );
  }

  return (
    <article className="bd-card skills-bot-card" data-appid={bot.larkAppId}>
      <header className="skills-bot-head">
        <Html html={botAvatarHtml({ name: label, larkAppId: bot.larkAppId, size: 'sm', dot: 'ok' })} />
        <div className="skills-bot-title-line">
          <strong>{label}</strong>
          <span className="skills-count-pill">{tr('skills.skillCount', { count: names.length })}</span>
        </div>
      </header>
      <section className="skills-policy-panel">
        <div className="skills-priority-head">
          <h3 className="skills-priority-title">{tr('skills.priority')}</h3>
        </div>
        <SkillMultiPicker
          botId={bot.larkAppId}
          names={names}
          installedNames={installedNames}
          skills={skills}
          busy={busyKey === `${bot.larkAppId}:set`}
          onSave={next => onSave(bot.larkAppId, next)}
        />
      </section>
      <span className={statusClass(status)} data-bot-status>{status?.text ?? ''}</span>
    </article>
  );
}

export function renderSkillsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SkillsPage />);
}
