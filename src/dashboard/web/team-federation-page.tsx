import { useEffect, useRef } from 'react';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { wireTeamFederationPage, wireTeamManagePage } from './team-federation.js';

type TeamTab = 'home' | 'manage';

function TeamSubNav(props: { active: TeamTab }) {
  const tr = useT();
  const tabStyle = (on: boolean) => ({
    padding: '6px 14px',
    borderRadius: '8px',
    textDecoration: 'none',
    fontSize: '14px',
    fontWeight: 600,
    background: on ? 'var(--accent)' : 'var(--surface-muted)',
    color: on ? 'var(--on-accent)' : 'var(--muted)',
  });
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
      <a href="#/team" style={tabStyle(props.active === 'home')}>{tr('team.navHome')}</a>
      <a href="#/team/manage" style={tabStyle(props.active === 'manage')}>{tr('team.navManage')}</a>
    </div>
  );
}

// Render-once scaffold: React owns the translated route shell, while the
// federation controller owns roster rendering and async action flows.
function TeamHomePage() {
  const tr = useT();
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireTeamFederationPage(rootRef.current);
  }, []);

  return (
    <section className="page" ref={rootRef}>
      <div className="page-heading"><div>
        <p className="eyebrow">{tr('team.eyebrow')}</p>
        <h1>{tr('team.homeTitle')}</h1>
        <p className="tf-lede">{tr('team.homeLede')}</p>
      </div></div>
      <TeamSubNav active="home" />
      <div className="card" style={{ marginBottom: '16px' }}>
        <h2 style={{ marginTop: 0 }}>{tr('team.localDeployTitle')}</h2>
        <p>
          {tr('team.myIdentity')}<b id="tf-owner">{tr('team.unbound')}</b>
          <button type="button" id="tf-autobind" className="primary" style={{ marginLeft: '8px' }}>{tr('team.bindBtn')}</button>
          <span className="muted" style={{ fontSize: '13px' }}>{tr('team.bindHint')}</span>
        </p>
        <div id="tf-bind-out" style={{ display: 'none', marginTop: '6px' }} />
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{tr('team.myTeams')} <span className="muted" id="tf-count" style={{ fontSize: '13px' }} /></h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px', fontSize: '13px' }}>
          <input id="tf-search" placeholder={tr('team.searchPh')} style={{ padding: '5px 9px', minWidth: '180px' }} />
          <select id="tf-cli" style={{ padding: '5px' }}><option value="">{tr('team.allCli')}</option></select>
          <label><input type="checkbox" id="tf-fcap" /> {tr('team.hasCap')}</label>
          <label><input type="checkbox" id="tf-frole" /> {tr('team.hasRole')}</label>
        </div>
        <p className="muted" style={{ fontSize: '13px', margin: '0 0 4px' }}>{tr('team.teamsHint')}</p>
        <div id="tf-teams">{tr('team.loading')}</div>
      </div>
      <div id="tf-modal" style={{ display: 'none', position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
        <div style={{ background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '18px 20px', width: 'min(560px,92vw)' }}>
          <h2 id="tf-modal-title" style={{ marginTop: 0 }}>{tr('team.roleModalTitle')}</h2>
          <p className="muted" style={{ fontSize: '13px' }}>{tr('team.roleModalHint')}</p>
          <textarea id="tf-modal-text" readOnly style={{ width: '100%', minHeight: '200px', font: '13px/1.5 ui-monospace,Menlo,monospace', padding: '10px', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
            <button type="button" id="tf-modal-cancel">{tr('team.close')}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function TeamManagePage() {
  const tr = useT();
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireTeamManagePage(rootRef.current);
  }, []);

  return (
    <section className="page" ref={rootRef}>
      <div className="page-heading"><div>
        <p className="eyebrow">{tr('team.eyebrow')}</p>
        <h1>{tr('team.manageTitle')}</h1>
        <p className="tf-lede">{tr('team.manageLede')}</p>
      </div></div>
      <TeamSubNav active="manage" />
      <div className="card" style={{ marginBottom: '16px' }}>
        <h2 style={{ marginTop: 0 }}>{tr('team.hostedTitle')}</h2>
        <p style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '6px' }}>
          <input id="tm-newname" placeholder={tr('team.newTeamPh')} style={{ minWidth: '200px' }} />
          <button type="button" id="tm-create" className="primary">{tr('team.createTeamBtn')}</button>
          <span className="muted tm-cout" style={{ fontSize: '13px' }} />
        </p>
        <div id="tm-list">{tr('team.loading')}</div>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{tr('team.joinTitle')}</h2>
        <p style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input id="tm-hub" placeholder={tr('team.hubPh')} style={{ flex: 1, minWidth: '240px' }} />
          <input id="tm-code" placeholder={tr('team.codePh')} style={{ minWidth: '160px' }} />
          <button type="button" id="tm-join" className="primary">{tr('team.joinBtn')}</button>
        </p>
        <div id="tm-join-out" style={{ display: 'none', marginTop: '6px' }} />
      </div>
    </section>
  );
}

export function renderTeamFederationPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <TeamHomePage />);
}

export function renderTeamManagePage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <TeamManagePage />);
}
