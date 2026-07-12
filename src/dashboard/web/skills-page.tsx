import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FieldTitle, Html, LoadingState, RefreshIconButton, SectionHeader } from './dashboard-components.js';
import { botAvatarHtml } from './ui.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';

interface SkillRow {
  name: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  source?: Record<string, any>;
  rootDir?: string;
}

interface NativeSkillGroup {
  cliId: string;
  rootDir: string;
  skills: SkillRow[];
  label?: string;
}

interface BotRow {
  larkAppId: string;
  botName?: string;
  online?: boolean;
  error?: string;
  skills?: SkillPolicy | null;
}

interface SkillPolicy {
  include?: string[];
}

interface DashboardRequestError extends Error {
  status?: number;
  body?: any;
}

interface SkillJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  error?: string;
}

interface InstallSkillCandidate {
  name: string;
  path: string;
  description?: string;
}

type StatusMessage = { text: string; ok: boolean } | null;
type DeliveryMode = 'auto' | 'prompt' | 'native';
type ProjectTrustMode = 'off' | 'all';

const INSTALLED_SKILLS_ROWS_PER_PAGE = 2;

interface SkillRemovalReference {
  name: string;
  bots: string[];
}

function nativeLibraryLabel(path: string | undefined, tr: ReturnType<typeof useT>): string | null {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (p.includes('/.codex/skills/')) return tr('skills.sourceCodex');
  if (p.includes('/.claude/skills/')) return tr('skills.sourceClaude');
  if (p.includes('/.trae/skills/')) return tr('skills.sourceTrae');
  if (p.includes('/.cursor/skills/')) return tr('skills.sourceCursor');
  if (p.includes('/.gemini/skills/')) return tr('skills.sourceGemini');
  if (p.includes('/.config/opencode/skills/')) return tr('skills.sourceOpenCode');
  return null;
}

function sourceLabel(skill: SkillRow, tr: ReturnType<typeof useT>): string {
  const source = skill.source ?? {};
  if (source.type === 'github') return `github:${source.owner}/${source.repo}/${source.path ?? ''}`;
  if (source.type === 'git') return `${source.url ?? 'git'}#${source.path ?? ''}`;
  if (source.type === 'local-link') return nativeLibraryLabel(source.path, tr) ?? tr('skills.sourceLocalLink');
  if (source.type === 'local-copy') return tr('skills.sourceBotmuxCopy');
  return String(source.type ?? 'unknown');
}

function priorityNames(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter(item => item.startsWith('skill:'))
    .map(item => item.slice('skill:'.length));
}

function policyReferenceCount(policy?: SkillPolicy | null): number {
  return priorityNames(policy).length;
}

function policyConfigured(policy?: SkillPolicy | null): boolean {
  return priorityNames(policy).length > 0;
}

function discoveryGroupKey(group: NativeSkillGroup): string {
  return `${group.cliId}\n${group.rootDir}`;
}

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

function SkillSegmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: ReactNode; help?: ReactNode }>;
  disabled?: boolean;
  onChange(value: T): void;
}): JSX.Element {
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
  installStatus: StatusMessage;
  installBusy: boolean;
  installDiscovering?: boolean;
  installSelectionOpen?: boolean;
  installCandidates?: InstallSkillCandidate[];
  selectedInstallSkills?: Set<string>;
  onInstallSourceChange: (value: string) => void;
  onInstallPathChange: (value: string) => void;
  onInstallRefChange: (value: string) => void;
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
        </label>
        <label className="skills-install-field-wide skills-install-path-field"><span>{tr('skills.path')}</span>
          <input
            type="text"
            data-install="path"
            placeholder={tr('skills.pathPlaceholder')}
            value={props.installPath}
            onChange={e => props.onInstallPathChange(e.currentTarget.value)}
          />
        </label>
        <label className="skills-install-field-wide skills-install-ref-field"><span>{tr('skills.ref')}</span>
          <input
            type="text"
            data-install="ref"
            placeholder={tr('skills.refPlaceholder')}
            value={props.installRef}
            onChange={e => props.onInstallRefChange(e.currentTarget.value)}
          />
        </label>
        <div className="skills-install-actions">
          <button type="button" data-action="install" disabled={busy} onClick={() => props.onInstall()}>
            {props.installDiscovering ? tr('skills.scanning') : props.installBusy ? tr('skills.jobRunning') : tr('skills.installSubmit')}
          </button>
        </div>
        <div className="skills-install-bottom-row">
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
  const [page, setPage] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1200 : window.innerWidth);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  queryRef.current = query;
  selectionModeRef.current = selectionMode;
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return props.skills;
    return props.skills.filter(skill => [
      skill.name,
      skill.displayName,
      skill.description,
      ...(skill.tags ?? []),
      sourceLabel(skill, tr),
    ].filter(Boolean).join('\n').toLocaleLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, props.skills, tr]);
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

  useEffect(() => setPage(0), [normalizedQuery, pageSize]);

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

        {props.skills.length === 0 ? (
          <div className="skills-library-empty">
            <strong>{tr('skills.emptyTitle')}</strong>
            <p>{tr('skills.emptyHelp')}</p>
          </div>
        ) : filteredSkills.length === 0 ? (
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
}): JSX.Element {
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

function SkillsPage() {
  const tr = useT();
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<number>>(new Set());
  const discoveryDialogRef = useRef<HTMLDialogElement | null>(null);

  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [nativeSkillGroups, setNativeSkillGroups] = useState<NativeSkillGroup[]>([]);
  const [bots, setBots] = useState<BotRow[]>([]);
  const [trustProjectSkills, setTrustProjectSkills] = useState<ProjectTrustMode>('off');
  const [delivery, setDelivery] = useState<DeliveryMode>('auto');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [installSource, setInstallSource] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [installRef, setInstallRef] = useState('');
  const [installStatus, setInstallStatus] = useState<StatusMessage>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installDiscovering, setInstallDiscovering] = useState(false);
  const [installSelectionOpen, setInstallSelectionOpen] = useState(false);
  const [installCandidates, setInstallCandidates] = useState<InstallSkillCandidate[]>([]);
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

  const fetchData = useCallback(async () => {
    const [skillsRes, botsRes] = await Promise.all([
      fetch('/api/skills'),
      fetch('/api/bots'),
    ]);
    const skillsBody = await skillsRes.json().catch(() => ({}));
    const botsBody = await botsRes.json().catch(() => ({}));
    if (!skillsRes.ok) {
      const error = skillsBody?.error ?? `skills HTTP ${skillsRes.status}`;
      throw new Error(error === 'not_found_yet' || error === 'not_found' ? tr('skills.apiUnavailable') : error);
    }
    if (!botsRes.ok) throw new Error(botsBody?.error ?? `bots HTTP ${botsRes.status}`);
    return {
      skills: Array.isArray(skillsBody.skills) ? skillsBody.skills as SkillRow[] : [],
      nativeSkillGroups: Array.isArray(skillsBody.nativeSkillGroups) ? skillsBody.nativeSkillGroups as NativeSkillGroup[] : [],
      bots: Array.isArray(botsBody.bots) ? botsBody.bots as BotRow[] : [],
      trustProjectSkills: skillsBody.trustProjectSkills === 'all' ? 'all' as const : 'off' as const,
      delivery: (skillsBody.delivery === 'prompt' || skillsBody.delivery === 'native' ? skillsBody.delivery : 'auto') as DeliveryMode,
    };
  }, [tr]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchData();
      if (!mountedRef.current) return;
      setSkills(next.skills);
      setNativeSkillGroups(next.nativeSkillGroups);
      setBots(next.bots);
      setTrustProjectSkills(next.trustProjectSkills);
      setDelivery(next.delivery);
      setLoadError(null);
      setSelectedDiscovered(selected => {
        const valid = new Set<string>();
        const installed = new Set(next.skills.map(skill => skill.name));
        for (const group of next.nativeSkillGroups) {
          for (const skill of group.skills) {
            const path = skill.rootDir ?? skill.source?.root ?? '';
            if (path && !installed.has(skill.name) && selected.has(path)) valid.add(path);
          }
        }
        return valid;
      });
    } catch (err: any) {
      if (!mountedRef.current) return;
      setLoadError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      clearTimers();
    };
  }, [clearTimers, refresh]);

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

  async function waitForSkillJob(job: SkillJob, setStatus: (status: StatusMessage) => void, refreshOnSuccess = true): Promise<void> {
    let current = job;
    setStatus({ text: tr('skills.jobRunning'), ok: true });
    for (;;) {
      if (!mountedRef.current) return;
      if (current.status === 'succeeded') {
        setStatus({ text: tr('skills.saved'), ok: true });
        if (refreshOnSuccess) await refresh();
        return;
      }
      if (current.status === 'failed') {
        throw new Error(current.error ?? 'job_failed');
      }
      await delay(800);
      if (!mountedRef.current) return;
      const body = await jsonRequest(`/api/skills/jobs/${encodeURIComponent(current.id)}`, { method: 'GET' });
      if (!mountedRef.current) return;
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
  }

  function sourceRequestBody(): Record<string, unknown> {
    return {
      source: installSource.trim(),
      path: installPath.trim() || undefined,
      ref: installRef.trim() || undefined,
    };
  }

  function installRequestBody(skillNames?: string[]): Record<string, unknown> {
    const selected = skillNames ?? [...selectedInstallSkills];
    return {
      ...sourceRequestBody(),
      skillNames: selected.length > 0 ? selected : undefined,
    };
  }

  async function discoverInstallCandidates(): Promise<{ skills: InstallSkillCandidate[]; directInstall: boolean }> {
    setInstallDiscovering(true);
    setInstallStatus({ text: tr('skills.scanning'), ok: true });
    try {
      const body = await jsonRequest('/api/skills/discover', {
        method: 'POST',
        body: JSON.stringify(sourceRequestBody()),
      });
      if (!mountedRef.current) return { skills: [], directInstall: false };
      const directInstall = body.discovery?.directInstall === true;
      const skills = Array.isArray(body.discovery?.skills) ? body.discovery.skills as InstallSkillCandidate[] : [];
      setInstallCandidates(skills);
      setSelectedInstallSkills(new Set(skills.map(skill => skill.name)));
      return { skills, directInstall };
    } finally {
      if (mountedRef.current) setInstallDiscovering(false);
    }
  }

  // Translate the backend's terse install error codes into actionable messages.
  // agentbuddy runs on the deploy host, so its failures (missing CLI, not logged
  // in) need host-side guidance the operator can act on. Non-agentbuddy codes
  // fall through unchanged.
  function mapInstallError(raw: string): string {
    const msg = raw || '';
    if (msg.startsWith('agentbuddy_not_found')) return tr('skills.agentbuddyNotFound');
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

  async function submitSkillInstall(skillNames?: string[]): Promise<void> {
    setInstallBusy(true);
    try {
      const body = await jsonRequest('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify(installRequestBody(skillNames)),
      });
      if (!mountedRef.current) return;
      await waitForSkillJob(body.job as SkillJob, setInstallStatus);
      if (mountedRef.current) clearInstallDiscovery();
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`, ok: false });
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

  async function installSkill(): Promise<void> {
    if (!installSource.trim()) {
      setInstallStatus({ text: tr('skills.sourceRequired'), ok: false });
      return;
    }
    try {
      setInstallSelectionOpen(false);
      const { skills, directInstall } = await discoverInstallCandidates();
      if (!mountedRef.current) return;
      // agentbuddy sources — a pasted `agentbuddy:<id>` OR a marketplace URL the
      // backend recognized — resolve their own skill set, so install directly
      // (no candidate selection). The server decides this so the client needn't
      // know the identifier prefix or the configured marketplace hosts.
      if (directInstall) {
        await submitSkillInstall();
        return;
      }
      if (skills.length === 0) {
        setInstallStatus({ text: tr('skills.scanEmpty'), ok: false });
        return;
      }
      if (skills.length === 1) {
        await submitSkillInstall([skills[0].name]);
        return;
      }
      setInstallStatus({ text: tr('skills.scanFound', { count: skills.length }), ok: true });
      setInstallSelectionOpen(true);
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${mapInstallError(err?.message ?? String(err))}`, ok: false });
    }
  }

  async function confirmInstallSelection(): Promise<void> {
    const selected = [...selectedInstallSkills];
    if (selected.length === 0) {
      setInstallStatus({ text: tr('skills.discoverNothingSelected'), ok: false });
      return;
    }
    await submitSkillInstall(selected);
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

  async function setBotSkills(appId: string, names: string[]): Promise<void> {
    const busyKey = `${appId}:set`;
    setBotBusy(busyKey);
    setBotStatuses(statuses => ({ ...statuses, [appId]: null }));
    try {
      const body = await jsonRequest(`/api/bots/${encodeURIComponent(appId)}/skills`, {
        method: 'PUT',
        body: JSON.stringify({
          action: 'set',
          policy: names.length > 0 ? { include: names.map(name => `skill:${name}`) } : null,
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

  const configuredBotCount = bots.filter(bot => policyConfigured(bot.skills)).length;
  const attachedSkillRefCount = bots.reduce((sum, bot) => sum + policyReferenceCount(bot.skills), 0);

  const headingActions = (
    <div className="page-heading-actions skills-heading-actions">
      <div className="skills-metric-strip">
        <span><small>{tr('skills.metricInstalled')}</small><strong>{skills.length}</strong></span>
        <span><small>{tr('skills.metricBots')}</small><strong>{configuredBotCount}/{bots.length}</strong></span>
        <span><small>{tr('skills.metricAttached')}</small><strong>{attachedSkillRefCount}</strong></span>
      </div>
      <RefreshIconButton id="skills-refresh" label={tr('skills.refresh')} busy={loading} disabled={loading} onClick={() => void refresh()} />
    </div>
  );

  const body = (
    <div className="skills-page-stack">
      {loading ? <LoadingState label={tr('common.loading')} /> : loadError ? <p className="hint-warn">{loadError}</p> : (
        <>
          <div className="skills-config-row">
            <section className="skills-config-block">
              <SectionHeader title={tr('skills.globalDefaults')} />
              <article className="bd-card skills-defaults-panel skills-config-card">
                <div className="skills-control-block">
                  <span className="skills-control-label">{tr('skills.globalProject')}</span>
                  <SkillSegmented
                    value={trustProjectSkills}
                    disabled={globalBusy === 'project'}
                    options={[
                      { value: 'off', label: tr('skills.globalProjectOff'), help: tr('skills.globalProjectOffHelp') },
                      { value: 'all', label: tr('skills.globalProjectAll'), help: tr('skills.globalProjectAllHelp') },
                    ]}
                    onChange={value => void updateGlobalProject(value)}
                  />
                </div>
                <div className="skills-control-block">
                  <span className="skills-control-label">{tr('skills.globalDelivery')}</span>
                  <SkillSegmented
                    value={delivery}
                    disabled={globalBusy === 'delivery'}
                    options={[
                      { value: 'auto', label: tr('skills.deliveryAuto'), help: tr('skills.deliveryAutoHelp') },
                      { value: 'prompt', label: tr('skills.deliveryPrompt'), help: tr('skills.deliveryPromptHelp') },
                      { value: 'native', label: tr('skills.deliveryNative'), help: tr('skills.deliveryNativeHelp') },
                    ]}
                    onChange={value => void updateGlobalDelivery(value)}
                  />
                </div>
              </article>
            </section>

            <section className="skills-config-block">
              <SectionHeader
                title={<FieldTitle help={tr('skills.installInfo')} helpLabel={tr('skills.installInfoLabel')}>{tr('skills.install')}</FieldTitle>}
              />
              <SkillsInstallPanel
                showTitle={false}
                installSource={installSource}
                installPath={installPath}
                installRef={installRef}
                installStatus={installStatus}
                installBusy={installBusy}
                installDiscovering={installDiscovering}
                installSelectionOpen={installSelectionOpen}
                installCandidates={installCandidates}
                selectedInstallSkills={selectedInstallSkills}
                onInstallSourceChange={(value) => {
                  setInstallSource(value);
                  clearInstallDiscovery();
                }}
                onInstallPathChange={(value) => {
                  setInstallPath(value);
                  clearInstallDiscovery();
                }}
                onInstallRefChange={(value) => {
                  setInstallRef(value);
                  clearInstallDiscovery();
                }}
                onToggleInstallSkill={toggleInstallCandidate}
                onSelectAllInstallSkills={selectAllInstallCandidates}
                onConfirmInstallSelection={() => void confirmInstallSelection()}
                onCloseInstallSelection={() => setInstallSelectionOpen(false)}
                onInstall={() => void installSkill()}
                onOpenNativeDiscovery={() => setDiscoveryOpen(true)}
              />
            </section>

            <section className="skills-config-block">
              <SectionHeader title={tr('skills.bots')} count={tr('skills.botCount', { count: bots.length })} hint={tr('skills.botsHelp')} />
              <section className="bd-card skills-bots-panel skills-config-card">
                <div className="skills-bot-grid">
                  {bots.map(bot => (
                    <BotPolicyCard
                      key={bot.larkAppId}
                      bot={bot}
                      installedNames={installedNames}
                      skills={skills}
                      status={botStatuses[bot.larkAppId] ?? null}
                      busyKey={botBusy}
                      onSave={setBotSkills}
                    />
                  ))}
                </div>
              </section>
            </section>
          </div>

          <InstalledSkillsLibrary
            skills={skills}
            busySkill={skillBusy}
            removingNames={removingNames}
            status={installedStatus}
            onUpdate={name => void updateSkill(name)}
            onRequestRemove={requestSkillRemoval}
          />

          <RemoveSkillsDialog
            names={removalDialogOpen ? pendingRemoval : null}
            references={removalReferences}
            busy={removingNames.size > 0}
            error={removalError}
            onCancel={cancelSkillRemoval}
            onConfirm={force => void confirmSkillRemoval(force)}
          />

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
}): JSX.Element {
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
