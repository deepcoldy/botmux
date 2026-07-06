import { useEffect, useRef } from 'react';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { wireRolesSurface } from './roles.js';

type RolesTab = 'groups' | 'profiles';

// Render-once scaffold: React owns the translated shell, while wireRolesSurface
// owns the role tree/editor subtrees with delegated events and innerHTML. Keep
// ui-change rerenders as full remounts until the controller is split further.
function RolesPage(props: { tab: RolesTab }) {
  const tr = useT();
  const rootRef = useRef<HTMLElement | null>(null);
  const isProfiles = props.tab === 'profiles';

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireRolesSurface(rootRef.current, props.tab);
  }, [props.tab]);

  return (
    <section className="page roles-page" ref={rootRef}>
      <div className="page-heading roles-heading">
        <div>
          <p className="eyebrow">{tr('nav.roles')}</p>
          <h1>{tr('roles.title')}</h1>
          <p>{tr('roles.subtitle')}</p>
        </div>
      </div>
      <nav className="wf-subnav roles-subnav">
        <a href="#/roles" className={isProfiles ? undefined : 'active'}>{tr('roles.tabGroups')}</a>
        <a href="#/roles/profile" className={isProfiles ? 'active' : undefined}>{tr('roles.tabProfiles')}</a>
      </nav>

      <div id="roles-by-group-view" className="roles-layout" hidden={isProfiles}>
        <div className="roles-tree-panel">
          <div className="roles-tree-header">
            <input type="search" id="roles-search" placeholder={tr('roles.search')} />
            <button type="button" id="roles-refresh">{tr('roles.refresh')}</button>
          </div>
          <div id="roles-tree" className="roles-tree" />
        </div>
        <div className="roles-editor-panel">
          <div id="roles-editor-empty" className="roles-editor-empty">{tr('roles.selectHint')}</div>
          <div id="roles-editor-form" className="roles-editor-form" style={{ display: 'none' }}>
            <div className="roles-editor-breadcrumb">
              <span id="roles-editor-group-name" />
              <span className="roles-breadcrumb-sep">›</span>
              <span id="roles-editor-bot-name" />
            </div>
            <div className="roles-editor-meta">
              <span id="roles-editor-chat-id" className="roles-editor-meta-line" />
            </div>
            <div className="roles-editor-inject">
              <label htmlFor="roles-editor-inject-mode">{tr('roles.injectModeLabel')}</label>
              <select id="roles-editor-inject-mode">
                <option value="every">{tr('roles.injectModeEvery')}</option>
                <option value="once">{tr('roles.injectModeOnce')}</option>
              </select>
              <span className="roles-editor-inject-hint">{tr('roles.injectModeHint')}</span>
            </div>
            <textarea id="roles-editor-textarea" placeholder={tr('roles.editorPlaceholder')} rows={14} />
            <div className="roles-editor-footer">
              <span id="roles-editor-bytecount" className="roles-bytecount" />
              <div className="roles-editor-actions">
                <button type="button" id="roles-delete" className="danger">{tr('roles.delete')}</button>
                <button type="button" id="roles-save" className="primary">{tr('roles.save')}</button>
              </div>
            </div>
            <div id="roles-preview" className="roles-preview" />
          </div>
        </div>
      </div>

      <div id="roles-profiles-view" className="roles-layout roles-profiles-layout" hidden={!isProfiles}>
        <div className="roles-tree-panel">
          <div className="roles-tree-header roles-profile-create">
            <input type="text" id="roles-profile-id" placeholder={tr('roles.profileIdPlaceholder')} maxLength={64} />
            <button type="button" id="roles-profile-select">{tr('roles.openProfile')}</button>
          </div>
          <div className="roles-tree-header">
            <input type="search" id="roles-profile-search" placeholder={tr('roles.profileSearch')} />
            <button type="button" id="roles-profile-refresh">{tr('roles.refresh')}</button>
          </div>
          <div id="roles-profile-list" className="roles-tree" />
        </div>
        <div className="roles-editor-panel">
          <div id="roles-profile-empty" className="roles-editor-empty">{tr('roles.profileSelectHint')}</div>
          <div id="roles-profile-detail" className="roles-editor-form roles-profile-detail" style={{ display: 'none' }} />
        </div>
      </div>
    </section>
  );
}

export function renderRolesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <RolesPage tab="groups" />);
}

export function renderRoleProfilesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <RolesPage tab="profiles" />);
}
