import type React from 'react';
import { useId, useState } from 'react';
import { ModalDialog } from './modal-dialog.js';
import type { NavItem } from './nav-items.js';
import {
  CAPABILITY_CATALOG,
  WORKSPACE_PRESETS,
  detectActivePreset,
  filterCatalogCapabilities,
  resolveEffectivePinnedIds,
  type CapabilityCategoryId,
  type WorkspaceMode,
  type WorkspacePersonalizationState,
  type WorkspacePresetId,
} from './workspace-personalization.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;
export type AutoActiveInfo = ReadonlyMap<string, { active: true; count?: number }>;

const categories: readonly CapabilityCategoryId[] = ['automation', 'collaboration', 'extensions', 'observability'];

function capabilityLabel(item: NavItem, tr: Translate): string {
  return tr(item.labelKey ?? `workspace.cap.${item.id}.name`);
}

function capabilityIcon(item: NavItem): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true">{item.icon}</svg>;
}

interface FeatureCatalogModalProps {
  state: WorkspacePersonalizationState;
  permittedItems: readonly NavItem[];
  autoActiveInfo: AutoActiveInfo;
  visibleCount: number;
  shortcut: string;
  tr: Translate;
  onClose(): void;
  onMode(mode: WorkspaceMode): void;
  onPreset(preset: WorkspacePresetId): void;
  onTogglePin(id: string): void;
  onNavigate(href: string): void;
}

export function FeatureCatalogModal({
  state, permittedItems, autoActiveInfo, visibleCount, shortcut, tr,
  onClose, onMode, onPreset, onTogglePin, onNavigate,
}: FeatureCatalogModalProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const titleId = useId();
  const subtitleId = useId();
  const byId = new Map(permittedItems.filter(item => !item.plugin).map(item => [item.id, item]));
  const availableIds = new Set(byId.keys());
  const matches = filterCatalogCapabilities(CAPABILITY_CATALOG, availableIds, query, tr);
  const activePreset = detectActivePreset(state);
  const effectivePins = resolveEffectivePinnedIds(state, autoActiveInfo.keys());

  return (
    <ModalDialog
      open
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={subtitleId}
      className="workspace-catalog"
      onRequestClose={onClose}
      onClose={onClose}
    >
      <div className="wc-shell">
        <header className="wc-header">
          <div className="wc-heading">
            <h2 id={titleId}>{tr('workspace.catalog.title')}</h2>
            <p id={subtitleId}>{tr('workspace.catalog.subtitle')}</p>
          </div>
          <div className="wc-mode" role="group" aria-label={tr('workspace.mode.label')}>
            {(['focused', 'all'] as const).map(mode => (
              <button key={mode} type="button" aria-pressed={state.mode === mode} onClick={() => onMode(mode)}>
                {tr(`workspace.mode.${mode}`)}
              </button>
            ))}
          </div>
          <button type="button" className="wc-close" aria-label={tr('workspace.close')} onClick={onClose}>×</button>
        </header>
        <div className="wc-body">
          <div className="wc-preset-grid">
            {WORKSPACE_PRESETS.map(preset => {
              const active = preset.id === activePreset;
              const count = preset.pinnedIds.filter(id => availableIds.has(id)).length;
              return (
                <button
                  type="button"
                  key={preset.id}
                  className={active ? 'is-active' : undefined}
                  aria-pressed={active}
                  data-preset-id={preset.id}
                  onClick={() => onPreset(preset.id)}
                >
                  <span className="wc-preset-name">
                    <strong>{tr(preset.labelKey)}</strong>
                    {active && <span aria-hidden="true">✓</span>}
                  </span>
                  <span className="wc-preset-desc">{tr(preset.descKey)}</span>
                  <span className="wc-preset-count">{tr('workspace.preset.count', { count })}</span>
                </button>
              );
            })}
          </div>
          <label className="wc-search">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.3 10.3 3 3" /></svg>
            <input
              id="workspace-catalog-search"
              type="search"
              data-input="workspaceCatalogSearch"
              aria-label={tr('workspace.search.label')}
              placeholder={tr('workspace.search.placeholder')}
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
            />
          </label>
          <div className="wc-category-list">
            {categories.map(category => {
              const cards = matches.filter(cap => cap.category === category);
              if (cards.length === 0) return null;
              return (
                <section key={category} className="wc-category">
                  <h3>{tr(`workspace.category.${category}`)}</h3>
                  <div className="wc-card-grid">
                    {cards.map(cap => {
                      const item = byId.get(cap.id)!;
                      const active = autoActiveInfo.get(cap.id);
                      const pinned = state.mode === 'focused' && effectivePins.has(cap.id);
                      return (
                        <div key={cap.id} className="wc-card" data-capability-id={cap.id}>
                          <div className="wc-card-heading">
                            <span className="wc-card-icon">{capabilityIcon(item)}</span>
                            <h4>{capabilityLabel(item, tr)}</h4>
                            {active ? (
                              <span className="wc-badge is-active">
                                {active.count === undefined
                                  ? tr('workspace.badge.active')
                                  : tr('workspace.badge.activeCount', { count: active.count })}
                              </span>
                            ) : pinned ? (
                              <span className="wc-badge is-pinned">{tr('workspace.badge.pinned')}</span>
                            ) : state.mode === 'all' ? (
                              <span className="wc-badge">{tr('workspace.badge.all')}</span>
                            ) : null}
                          </div>
                          <p>{tr(cap.summaryKey)}</p>
                          <div className="wc-card-actions">
                            <button
                              type="button"
                              className="wc-pin"
                              data-action="toggle-pin-capability"
                              aria-pressed={pinned}
                              title={state.mode === 'all' ? tr('workspace.action.pinFromAll') : undefined}
                              onClick={() => onTogglePin(cap.id)}
                            >
                              {tr(pinned ? 'workspace.action.pinned' : 'workspace.action.pin')}
                            </button>
                            <button
                              type="button"
                              className="wc-open"
                              data-action="open-capability"
                              onClick={() => { onClose(); onNavigate(item.href); }}
                            >
                              {tr('workspace.action.open')}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {matches.length === 0 && <p className="wc-empty" role="status">{tr('workspace.search.empty')}</p>}
          </div>
        </div>
        <footer className="wc-footer">
          <p>{tr('workspace.footer.count', { visible: visibleCount, total: permittedItems.length })}<br />
            {tr('workspace.footer.search', { shortcut })}</p>
          <div className="wc-footer-actions">
            <button type="button" className="wc-reset" data-action="workspace-reset-minimal" onClick={() => onPreset('minimal')}>
              {tr('workspace.action.reset')}
            </button>
            <button type="button" className="primary wc-done" onClick={onClose}>{tr('workspace.action.done')}</button>
          </div>
        </footer>
      </div>
    </ModalDialog>
  );
}

interface WorkspaceGuideBannerProps {
  item: NavItem | undefined;
  state: WorkspacePersonalizationState;
  isPinned: boolean;
  tr: Translate;
  onPin(id: string): void;
  onDismiss(id: string): void;
}

export function WorkspaceGuideBanner({
  item, state, isPinned, tr, onPin, onDismiss,
}: WorkspaceGuideBannerProps): React.JSX.Element | null {
  if (state.mode !== 'focused' || !item || item.plugin || state.dismissedGuideIds.includes(item.id)) return null;
  const cap = CAPABILITY_CATALOG.find(entry => entry.id === item.id);
  if (!cap) return null;

  return (
    <div className="workspace-guide-banner" data-guide-id={cap.id}>
      <span className="wc-guide-icon">{capabilityIcon(item)}</span>
      <span className="wc-guide-text">{tr(cap.guideKey)}</span>
      <div className="wc-guide-actions">
        {!isPinned && (
          <button type="button" className="wc-pin" data-action="pin-guide-capability" onClick={() => onPin(cap.id)}>
            {tr('workspace.guide.pin')}
          </button>
        )}
        {cap.guideActionHref && cap.guideActionLabelKey && (
          <a className="wc-open" href={cap.guideActionHref}>{tr(cap.guideActionLabelKey)}</a>
        )}
      </div>
      <button type="button" className="wc-close" aria-label={tr('workspace.guide.dismiss')} onClick={() => onDismiss(cap.id)}>×</button>
    </div>
  );
}
