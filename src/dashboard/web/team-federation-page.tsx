import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateActionButton, DropdownMenu, SectionHeader, dropdownLabel } from './dashboard-components.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import {
  autoBindIdentity,
  botMatchesTeamFilters,
  createFederatedGroup,
  createHostedTeam,
  createRemoteGroup,
  deleteHostedTeam,
  fetchHostedTeams,
  fetchLocalBotRole,
  fetchRemoteRoster,
  generateLocalInvite,
  joinRemoteTeam,
  mapHostedTeams,
  mapRemoteTeams,
  removeHostedTeamMember,
  teamCliOptions,
  updateLocalBotCapability,
  updateTeamBotCapability,
  type AutoBindCandidate,
  type HostedTeamsResponse,
  type RosterBot,
  type RosterDeployment,
  type Team,
  type TeamFilters,
} from './team-federation.js';

type TeamTab = 'home' | 'manage';
type Translator = ReturnType<typeof useT>;

type BindState =
  | { kind: 'hidden' }
  | { kind: 'loading'; key: 'team.identifying' | 'team.binding' }
  | { kind: 'ok'; name: string }
  | { kind: 'choice'; candidates: AutoBindCandidate[] }
  | { kind: 'err'; key: 'team.noCandidates' }
  | { kind: 'bind-fail'; error: string };

type TeamOutput =
  | { kind: 'muted'; key: 'team.creatingGroup' }
  | { kind: 'err'; key: 'team.errPickBot' }
  | { kind: 'group-result'; body: any; status: number };

type RoleModalState = {
  app: string;
  name: string;
  content: string;
} | null;

type ManageStatus =
  | { kind: 'none' }
  | { kind: 'muted'; key: 'team.creating' | 'team.generating' | 'team.joining' }
  | { kind: 'ok'; key: 'team.created' }
  | { kind: 'err'; key: 'team.errName' | 'team.errHubCode' | 'team.genFail' }
  | { kind: 'create-fail'; error: string }
  | { kind: 'invite'; code: string }
  | { kind: 'joined'; name: string }
  | { kind: 'join-fail'; error: string | number };

function useAliveRef() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

function TeamSubNav(props: { active: TeamTab }) {
  const tr = useT();
  const isHome = props.active === 'home';
  const isManage = props.active === 'manage';
  return (
    <nav className="team-subnav insight-tabs" role="tablist" aria-label={tr('team.eyebrow')}>
      <a href="#/team" className={`itab${isHome ? ' on' : ''}`} role="tab" aria-selected={isHome}>{tr('team.navHome')}</a>
      <a href="#/team/manage" className={`itab${isManage ? ' on' : ''}`} role="tab" aria-selected={isManage}>{tr('team.navManage')}</a>
    </nav>
  );
}

function getPicked(map: Map<string, Set<string>>, key: string): Set<string> {
  return map.get(key) ?? new Set();
}

function TeamHomePage() {
  const tr = useT();
  const alive = useAliveRef();
  const [localTeams, setLocalTeams] = useState<Team[]>([]);
  const [remoteTeams, setRemoteTeams] = useState<Team[]>([]);
  const [myDeploymentId, setMyDeploymentId] = useState('');
  const [ownerLabel, setOwnerLabel] = useState(tr('team.unbound'));
  const [filters, setFilters] = useState<TeamFilters>({ query: '', cliId: '', hasCapability: false, hasRole: false });
  const [pickedByTeam, setPickedByTeam] = useState<Map<string, Set<string>>>(() => new Map());
  const [gnameByTeam, setGnameByTeam] = useState<Map<string, string>>(() => new Map());
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set());
  const [expandedDeps, setExpandedDeps] = useState<Set<string>>(() => new Set());
  const [bindState, setBindState] = useState<BindState>({ kind: 'hidden' });
  const [groupOutputs, setGroupOutputs] = useState<Map<string, TeamOutput>>(() => new Map());
  const [roleModal, setRoleModal] = useState<RoleModalState>(null);

  const teams = useMemo(() => [...localTeams, ...remoteTeams], [localTeams, remoteTeams]);
  const cliOptions = useMemo(() => teamCliOptions(teams), [teams]);
  const cliFilterOptions = useMemo(
    () => [{ value: '', label: tr('team.allCli') }, ...cliOptions.map(cli => ({ value: cli, label: cli }))],
    [cliOptions, tr],
  );

  const loadLocal = useCallback(async () => {
    const r = await fetchHostedTeams();
    if (!alive.current) return;
    const body = r.body as HostedTeamsResponse;
    if (!body?.ok) {
      setLocalTeams([]);
      return;
    }
    setMyDeploymentId(body.deployment?.deploymentId ?? '');
    setOwnerLabel(body.deployment?.ownerName || (body.deployment?.ownerUnionId ? tr('team.bound') : tr('team.unbound')));
    setLocalTeams(mapHostedTeams(body, tr));
  }, [alive, tr]);

  const loadRemote = useCallback(async () => {
    const r = await fetchRemoteRoster();
    if (!alive.current) return;
    setRemoteTeams(mapRemoteTeams(r.body, tr));
  }, [alive, tr]);

  useEffect(() => {
    setPickedByTeam(new Map());
    setGnameByTeam(new Map());
    setExpandedTeams(new Set());
    setExpandedDeps(new Set());
    void loadLocal();
    void loadRemote();
  }, [loadLocal, loadRemote]);

  useEffect(() => {
    setOwnerLabel(label => (label === '未绑定' || label === 'Unbound') ? tr('team.unbound') : label);
  }, [tr]);

  useEffect(() => {
    const visibleByTeam = new Map<string, Set<string>>();
    for (const team of teams) {
      visibleByTeam.set(team.key, new Set(team.bots.filter(bot => botMatchesTeamFilters(bot, filters)).map(bot => bot.larkAppId)));
    }
    setPickedByTeam(prev => {
      let changed = false;
      const next = new Map<string, Set<string>>();
      for (const [key, picks] of prev) {
        const visible = visibleByTeam.get(key);
        const filtered = new Set([...picks].filter(app => visible?.has(app)));
        if (filtered.size !== picks.size) changed = true;
        if (filtered.size) next.set(key, filtered);
      }
      return changed ? next : prev;
    });
  }, [filters, teams]);

  const countLabel = useMemo(() => {
    if (!teams.length) return '';
    const shownIds = new Set<string>();
    const totalIds = new Set<string>();
    for (const team of teams) {
      const filtered = team.bots.filter(bot => botMatchesTeamFilters(bot, filters));
      filtered.forEach(bot => shownIds.add(bot.larkAppId));
      team.bots.forEach(bot => totalIds.add(bot.larkAppId));
    }
    const acrossTeams = teams.length > 1 ? tr('team.acrossTeams', { n: teams.length }) : '';
    const numStr = shownIds.size === totalIds.size ? `${totalIds.size}` : `${shownIds.size} / ${totalIds.size}`;
    return `· ${numStr} ${tr('team.botsWord')}${acrossTeams}`;
  }, [filters, teams, tr]);

  function setTeamOutput(teamKey: string, output: TeamOutput): void {
    setGroupOutputs(prev => {
      const next = new Map(prev);
      next.set(teamKey, output);
      return next;
    });
  }

  function updatePicked(teamKey: string, larkAppId: string, checked: boolean): void {
    setPickedByTeam(prev => {
      const next = new Map(prev);
      const picked = new Set(next.get(teamKey) ?? []);
      if (checked) picked.add(larkAppId);
      else picked.delete(larkAppId);
      if (picked.size) next.set(teamKey, picked);
      else next.delete(teamKey);
      return next;
    });
  }

  function updateGroupName(teamKey: string, value: string): void {
    setGnameByTeam(prev => {
      const next = new Map(prev);
      if (value) next.set(teamKey, value);
      else next.delete(teamKey);
      return next;
    });
  }

  async function handleCapabilityChange(larkAppId: string, value: string): Promise<void> {
    await updateLocalBotCapability(larkAppId, value);
    if (!alive.current) return;
    setLocalTeams(prev => updateTeamBotCapability(prev, larkAppId, value));
    setRemoteTeams(prev => updateTeamBotCapability(prev, larkAppId, value));
  }

  async function openRoleModal(app: string, name: string): Promise<void> {
    const r = await fetchLocalBotRole(app);
    if (!alive.current) return;
    setRoleModal({ app, name, content: r.body?.role || '' });
  }

  async function handleRemoveMember(teamId: string, deploymentId: string, name: string): Promise<void> {
    if (!confirm(tr('team.removeMemberConfirm', { name }))) return;
    await removeHostedTeamMember(teamId, deploymentId);
    if (!alive.current) return;
    void loadLocal();
  }

  async function handlePullGroup(team: Team): Promise<void> {
    const apps = [...getPicked(pickedByTeam, team.key)];
    if (!apps.length) {
      setTeamOutput(team.key, { kind: 'err', key: 'team.errPickBot' });
      return;
    }
    const name = (gnameByTeam.get(team.key) || '').trim() || tr('team.defaultGroupName');
    setTeamOutput(team.key, { kind: 'muted', key: 'team.creatingGroup' });
    const r = team.kind === 'local'
      ? await createFederatedGroup(team.teamId, name, apps)
      : await createRemoteGroup(team.hubUrl, team.teamId, name, apps);
    if (!alive.current) return;
    setTeamOutput(team.key, { kind: 'group-result', body: r.body, status: r.status });
    if ((r.body as any)?.ok) {
      setPickedByTeam(prev => {
        const next = new Map(prev);
        next.delete(team.key);
        return next;
      });
      setGnameByTeam(prev => {
        const next = new Map(prev);
        next.delete(team.key);
        return next;
      });
      if (team.kind === 'local') void loadLocal();
    }
  }

  async function handleAutoBind(unionId?: string): Promise<void> {
    setBindState({ kind: 'loading', key: unionId ? 'team.binding' : 'team.identifying' });
    const r = await autoBindIdentity(unionId);
    if (!alive.current) return;
    const body = r.body;
    if (body?.ok && body.owner) {
      setBindState({ kind: 'ok', name: body.owner.name || body.owner.unionId || '' });
      void loadLocal();
      return;
    }
    if (body?.ok && body.needChoice && Array.isArray(body.candidates)) {
      setBindState({ kind: 'choice', candidates: body.candidates });
      return;
    }
    if (body?.error === 'no_candidates') {
      setBindState({ kind: 'err', key: 'team.noCandidates' });
      return;
    }
    setBindState({ kind: 'bind-fail', error: String(body?.error || 'unknown') });
  }

  return (
    <section className="page team-page team-home-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('team.eyebrow')}</p>
          <h1>{tr('team.homeTitle')}</h1>
        </div>
        <div className="page-heading-actions"><TeamSubNav active="home" /></div>
      </div>
      <section className="overview-block team-identity-section">
        <SectionHeader title={tr('team.localDeployTitle')} hint={tr('team.bindHint')} />
        <div className="card team-card team-identity-card">
          <p className="team-identity-row">
            <span className="team-identity-label">{tr('team.myIdentity')}</span><b id="tf-owner">{ownerLabel}</b>
            <button type="button" id="tf-autobind" className="page-primary-action" onClick={() => void handleAutoBind()}>{tr('team.bindBtn')}</button>
            <span id="tf-bind-out" className="team-bind-status" hidden={bindState.kind === 'hidden'}>
              <BindOutput state={bindState} tr={tr} onPick={unionId => void handleAutoBind(unionId)} />
            </span>
          </p>
        </div>
      </section>
      <section className="overview-block team-roster-section">
        <SectionHeader
          title={tr('team.myTeams')}
          count={countLabel ? countLabel.replace(/^·\s*/, '') : undefined}
          hint={tr('team.teamsHint')}
        />
        <div className="card team-card team-roster-card">
          <form className="team-filters dashboard-toolbar" onSubmit={event => event.preventDefault()}>
            <input id="tf-search" type="search" placeholder={tr('team.searchPh')} value={filters.query} onChange={ev => setFilters(f => ({ ...f, query: ev.target.value }))} />
            <DropdownMenu
              id="tf-cli"
              className="team-cli-menu"
              ariaLabel={tr('team.allCli')}
              value={filters.cliId}
              label={dropdownLabel(cliFilterOptions, filters.cliId)}
              options={cliFilterOptions}
              onChange={value => setFilters(f => ({ ...f, cliId: value }))}
            />
            <label className="filter-toggle">
              <input type="checkbox" id="tf-fcap" checked={filters.hasCapability} onChange={ev => setFilters(f => ({ ...f, hasCapability: ev.target.checked }))} />
              <span className="filter-toggle-switch" aria-hidden="true" />
              <span className="filter-toggle-label">{tr('team.hasCap')}</span>
            </label>
            <label className="filter-toggle">
              <input type="checkbox" id="tf-frole" checked={filters.hasRole} onChange={ev => setFilters(f => ({ ...f, hasRole: ev.target.checked }))} />
              <span className="filter-toggle-switch" aria-hidden="true" />
              <span className="filter-toggle-label">{tr('team.hasRole')}</span>
            </label>
          </form>
          <div id="tf-teams">
            <TeamsList
              teams={teams}
              filters={filters}
              pickedByTeam={pickedByTeam}
              gnameByTeam={gnameByTeam}
              expandedTeams={expandedTeams}
              expandedDeps={expandedDeps}
              groupOutputs={groupOutputs}
              myDeploymentId={myDeploymentId}
              tr={tr}
              onToggleTeam={key => setExpandedTeams(prev => toggleSet(prev, key))}
              onToggleDep={key => setExpandedDeps(prev => toggleSet(prev, key))}
              onPick={updatePicked}
              onGroupNameChange={updateGroupName}
              onCapabilityChange={(app, value) => void handleCapabilityChange(app, value)}
              onOpenRole={(app, name) => void openRoleModal(app, name)}
              onRemoveMember={(teamId, depId, name) => void handleRemoveMember(teamId, depId, name)}
              onPullGroup={team => void handlePullGroup(team)}
            />
          </div>
        </div>
      </section>
      <RoleModal state={roleModal} tr={tr} onClose={() => setRoleModal(null)} />
    </section>
  );
}

function toggleSet(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function BindOutput(props: { state: BindState; tr: Translator; onPick(unionId: string): void }) {
  const { state, tr } = props;
  if (state.kind === 'hidden') return null;
  if (state.kind === 'loading') return <span className="team-bind-loading">{tr(state.key)}</span>;
  if (state.kind === 'ok') return <span className="ok">{tr('team.bound2', { name: state.name })}</span>;
  if (state.kind === 'choice') {
    return (
      <>
        {tr('team.multiCandidate')}<br />
        {state.candidates.map(candidate => (
          <button
            type="button"
            className="tf-pickowner ghost"
            data-union={candidate.unionId}
            style={{ margin: '2px' }}
            key={candidate.unionId}
            onClick={() => props.onPick(candidate.unionId)}
          >
            {candidate.name || candidate.unionId}
          </button>
        ))}
      </>
    );
  }
  if (state.kind === 'err') return <span className="err">{tr(state.key)}</span>;
  return <span className="err">{tr('team.bindFail', { error: state.error })}</span>;
}

function TeamsList(props: {
  teams: Team[];
  filters: TeamFilters;
  pickedByTeam: Map<string, Set<string>>;
  gnameByTeam: Map<string, string>;
  expandedTeams: Set<string>;
  expandedDeps: Set<string>;
  groupOutputs: Map<string, TeamOutput>;
  myDeploymentId: string;
  tr: Translator;
  onToggleTeam(key: string): void;
  onToggleDep(key: string): void;
  onPick(teamKey: string, appId: string, checked: boolean): void;
  onGroupNameChange(teamKey: string, value: string): void;
  onCapabilityChange(appId: string, value: string): void;
  onOpenRole(appId: string, name: string): void;
  onRemoveMember(teamId: string, deploymentId: string, name: string): void;
  onPullGroup(team: Team): void;
}) {
  const { tr } = props;
  if (!props.teams.length) return <p className="muted">{tr('team.noTeams')}</p>;

  return (
    <>
      {props.teams.map(team => {
        const filtered = team.bots.filter(bot => botMatchesTeamFilters(bot, props.filters));
        const collapsed = !props.expandedTeams.has(team.key);
        const conn = team.kind === 'remote'
          ? (team.ok
            ? <span className="team-status-pill ok">{tr('team.connected')}</span>
            : <span className="team-status-pill err">{tr('team.connectFail', { error: team.error || '' })}</span>)
          : <span className="team-status-pill muted">{tr('team.iHost')}</span>;
        return (
          <article className="card team-list-card" key={team.key}>
            <button type="button" className="tf-team-h" data-tk={team.key} aria-expanded={!collapsed} onClick={() => props.onToggleTeam(team.key)}>
              <span className="team-chevron" aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
              <b>{team.label}</b>
              {team.sub ? <span className="muted">{team.sub}</span> : null}
              {conn}
              <span className="team-meta-pill">{tr('team.teamMeta', { deps: team.deployments.length, bots: team.bots.length })}</span>
            </button>
            {!collapsed ? (
              team.kind === 'remote' && !team.ok
                ? <p className="muted" style={{ margin: '8px 0 0' }}>{tr('team.rosterFail')}</p>
                : <TeamBody {...props} team={team} filtered={filtered} />
            ) : null}
          </article>
        );
      })}
    </>
  );
}

function TeamBody(props: Parameters<typeof TeamsList>[0] & { team: Team; filtered: RosterBot[] }) {
  const { team, tr } = props;
  const ordered = [...team.deployments].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
  const hasRows = ordered.some(dep => props.filtered.some(bot => bot.deployment.id === dep.id));
  return (
    <>
      {ordered.map(dep => (
        <DeploymentBlock {...props} deployment={dep} key={dep.id} />
      ))}
      {!hasRows ? <p className="muted" style={{ margin: '8px 0 0' }}>{tr('team.noMatch')}</p> : null}
      <div className="team-pull-row">
        <label className="team-pill-field team-group-name-field">
          <span>{tr('team.gnameLabel')}</span>
          <input
            className="tf-gname"
            data-tk={team.key}
            value={props.gnameByTeam.get(team.key) || ''}
            placeholder={tr('team.gnamePlaceholder')}
            onChange={ev => props.onGroupNameChange(team.key, ev.target.value)}
          />
        </label>
        <button className="tf-grp page-primary-action" data-tk={team.key} onClick={() => props.onPullGroup(team)}>{tr('team.pullGroupBtn')}</button>
        <span className="muted team-pull-hint">{tr('team.pullGroupHint')}</span>
        <span className="tf-gout" data-tk={team.key}>
          <TeamGroupOutput output={props.groupOutputs.get(team.key)} tr={tr} />
        </span>
      </div>
    </>
  );
}

function DeploymentBlock(props: Parameters<typeof TeamsList>[0] & { team: Team; filtered: RosterBot[]; deployment: RosterDeployment }) {
  const { team, deployment, tr } = props;
  const depBots = props.filtered.filter(bot => bot.deployment.id === deployment.id);
  if (!depBots.length) return null;
  const mine = deployment.id === props.myDeploymentId;
  const tag = mine ? tr('team.tagLocal') : (deployment.stale ? tr('team.tagRemoteStale') : tr('team.tagRemote'));
  const depKey = `${team.key}::${deployment.id}`;
  const depOpen = props.expandedDeps.has(depKey);
  const npick = depBots.filter(bot => getPicked(props.pickedByTeam, team.key).has(bot.larkAppId)).length;
  return (
    <section className="team-deployment-block">
      <div
        className="tf-dep-h"
        data-dk={depKey}
        aria-expanded={depOpen}
        role="button"
        tabIndex={0}
        onClick={() => props.onToggleDep(depKey)}
        onKeyDown={ev => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          props.onToggleDep(depKey);
        }}
      >
        <span className="team-chevron" aria-hidden="true">{depOpen ? '⌄' : '›'}</span>
        <b>{deployment.name}</b>
        <span className="muted">
          {tr('team.depTag', { tag })} · {tr('team.depCount', { count: depBots.length })}{npick ? tr('team.depSelected', { n: npick }) : ''}
        </span>
        {team.kind === 'local' && !mine ? (
          <button
            type="button"
            className="tf-rmmember ghost"
            data-team={team.teamId}
            data-dep={deployment.id}
            data-name={deployment.name}
            onClick={ev => {
              ev.stopPropagation();
              props.onRemoveMember(team.teamId, deployment.id, deployment.name);
            }}
          >
            {tr('team.removeMember')}
          </button>
        ) : null}
      </div>
      {depOpen ? (
        <div className="team-roster-list">
            {depBots.map(bot => (
              <RosterBotRow
                bot={bot}
                mine={mine}
                picked={getPicked(props.pickedByTeam, team.key).has(bot.larkAppId)}
                teamKey={team.key}
                tr={tr}
                onPick={props.onPick}
                onCapabilityChange={props.onCapabilityChange}
                onOpenRole={props.onOpenRole}
                key={bot.larkAppId}
              />
            ))}
        </div>
      ) : null}
    </section>
  );
}

function RosterBotRow(props: {
  bot: RosterBot;
  mine: boolean;
  picked: boolean;
  teamKey: string;
  tr: Translator;
  onPick(teamKey: string, appId: string, checked: boolean): void;
  onCapabilityChange(appId: string, value: string): void;
  onOpenRole(appId: string, name: string): void;
}) {
  const { bot, tr } = props;
  const dim = bot.deployment.stale ? { opacity: .55 } : undefined;
  const togglePicked = () => props.onPick(props.teamKey, bot.larkAppId, !props.picked);
  return (
    <article
      className={`team-bot-row${props.picked ? ' selected' : ''}`}
      style={dim}
      role="checkbox"
      aria-checked={props.picked}
      tabIndex={0}
      onClick={ev => {
        if (isTeamRowInteractiveTarget(ev.target)) return;
        togglePicked();
      }}
      onKeyDown={ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (isTeamRowInteractiveTarget(ev.target)) return;
        ev.preventDefault();
        togglePicked();
      }}
    >
      <label className={`team-check-pill${props.picked ? ' selected' : ''}`} onClick={ev => ev.stopPropagation()}>
        <input
          type="checkbox"
          className="tf-pick"
          data-tk={props.teamKey}
          data-app={bot.larkAppId}
          checked={props.picked}
          onChange={ev => props.onPick(props.teamKey, bot.larkAppId, ev.target.checked)}
        />
        <span className="team-check-dot" aria-hidden="true" />
      </label>
      <div className="team-bot-main">
        <strong>{bot.name}</strong>
        <span>{bot.larkAppId}</span>
      </div>
      <span className="team-meta-pill">{bot.cliId}</span>
      <div className="team-capability-cell">
        {props.mine ? (
          <label className="team-pill-field team-cap-field">
            <span>{tr('team.capLabel')}</span>
            <input
              className="tf-cap"
              data-app={bot.larkAppId}
              defaultValue={bot.capability || ''}
              placeholder={tr('team.capPh')}
              onBlur={ev => {
                // Commit once on blur (old native onchange semantics), not per keystroke —
                // a PUT per character can persist a truncated prefix under network reordering.
                const next = ev.target.value;
                if (next === (bot.capability || '')) return;
                props.onCapabilityChange(bot.larkAppId, next);
              }}
              onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); } }}
            />
          </label>
        ) : (
          bot.capability || null
        )}
      </div>
      <div className="team-role-cell">
        {bot.hasTeamRole ? (
          props.mine
            ? <button className="tf-role" data-app={bot.larkAppId} data-name={bot.name} onClick={() => props.onOpenRole(bot.larkAppId, bot.name)}>{tr('team.viewRole')}</button>
            : tr('team.hasRoleShort')
        ) : <span className="muted">—</span>}
      </div>
    </article>
  );
}

function isTeamRowInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, input, textarea, select, a, label, [contenteditable="true"]'));
}

function TeamGroupOutput(props: { output?: TeamOutput; tr: Translator }) {
  const { output, tr } = props;
  if (!output) return null;
  if (output.kind === 'muted') return <span className="muted">{tr(output.key)}</span>;
  if (output.kind === 'err') return <span className="err">{tr(output.key)}</span>;
  return <GroupResult body={output.body} status={output.status} tr={tr} />;
}

function GroupResult(props: { body: any; status: number; tr: Translator }) {
  const { body, status, tr } = props;
  if (body?.ok && body.chatId) {
    const link = body.shareLink || ('https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(body.chatId));
    return (
      <>
        <span className="ok">{tr('team.groupCreated')}</span>
        {body.delegatedTo ? tr('team.delegatedBy', { name: String(body.delegatedTo) }) : ''} · <a href={link} target="_blank" rel="noreferrer">{tr('team.openInLark')}</a>
        {(body.invalidBotIds || []).length ? <span className="err"> · {tr('team.invalidBots', { ids: (body.invalidBotIds || []).join(', ') })}</span> : null}
        {(body.invalidOwnerUnionIds || []).length ? <span className="err"> · {tr('team.invalidOwners', { n: (body.invalidOwnerUnionIds || []).length })}</span> : null}
        {body.missingOperatorIdentity ? <span className="err"> · {tr('team.missingIdentity')}</span> : null}
        {(body.skippedNoOwner || []).length ? <span className="err"> · {tr('team.skippedNoOwner', { n: (body.skippedNoOwner || []).length })}</span> : null}
      </>
    );
  }

  const e = body?.error || status;
  const msg = e === 'no_local_online_bot' ? tr('team.errNoLocalBot')
    : e === 'all_bots_skipped_no_owner' ? tr('team.errAllSkipped')
    : e === 'no_creator_available' ? tr('team.errNoCreator')
    : e === 'delegation_timeout' ? tr('team.errDelegationTimeout')
    : tr('team.errGroupCreate', { error: String(e) });
  return <span className="err">{msg}</span>;
}

function RoleModal(props: { state: RoleModalState; tr: Translator; onClose(): void }) {
  const { state, tr } = props;
  return (
    <div id="tf-modal" className="team-role-modal" data-app={state?.app} hidden={!state}>
      <div className="team-role-dialog">
        <h2 id="tf-modal-title">{state ? tr('team.roleModalTitleName', { name: state.name }) : tr('team.roleModalTitle')}</h2>
        <p className="muted" style={{ fontSize: '13px' }}>{tr('team.roleModalHint')}</p>
        <textarea id="tf-modal-text" readOnly value={state?.content ?? ''} />
        <div className="team-role-actions">
          <button type="button" id="tf-modal-cancel" onClick={props.onClose}>{tr('team.close')}</button>
        </div>
      </div>
    </div>
  );
}

function TeamManagePage() {
  const tr = useT();
  const alive = useAliveRef();
  const [teams, setTeams] = useState<any[]>([]);
  const [suggestedHubUrl, setSuggestedHubUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [createStatus, setCreateStatus] = useState<ManageStatus>({ kind: 'none' });
  const [inviteStatuses, setInviteStatuses] = useState<Map<string, ManageStatus>>(() => new Map());
  const [hubUrl, setHubUrl] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [joinStatus, setJoinStatus] = useState<ManageStatus>({ kind: 'none' });

  const loadManageList = useCallback(async () => {
    const r = await fetchHostedTeams();
    if (!alive.current) return;
    const body = r.body;
    setSuggestedHubUrl(current => body?.suggestedHubUrl || current);
    setTeams(body?.teams || []);
  }, [alive]);

  useEffect(() => {
    void loadManageList();
  }, [loadManageList]);

  async function handleCreateTeam(): Promise<void> {
    const name = newName.trim();
    if (!name) {
      setCreateStatus({ kind: 'err', key: 'team.errName' });
      return;
    }
    setCreateStatus({ kind: 'muted', key: 'team.creating' });
    const r = await createHostedTeam(name);
    if (!alive.current) return;
    if ((r.body as any)?.ok) {
      setCreateStatus({ kind: 'ok', key: 'team.created' });
      setNewName('');
      void loadManageList();
    } else {
      setCreateStatus({ kind: 'create-fail', error: String((r.body as any)?.error || r.status) });
    }
  }

  async function handleInvite(teamId: string): Promise<void> {
    setInviteStatuses(prev => {
      const next = new Map(prev);
      next.set(teamId, { kind: 'muted', key: 'team.generating' });
      return next;
    });
    const r = await generateLocalInvite(teamId);
    if (!alive.current) return;
    setInviteStatuses(prev => {
      const next = new Map(prev);
      next.set(teamId, r.body?.code ? { kind: 'invite', code: r.body.code } : { kind: 'err', key: 'team.genFail' });
      return next;
    });
  }

  async function handleDelete(teamId: string, name: string): Promise<void> {
    if (!confirm(tr('team.delConfirm', { name }))) return;
    await deleteHostedTeam(teamId);
    if (!alive.current) return;
    void loadManageList();
  }

  async function handleJoin(): Promise<void> {
    const cleanHub = hubUrl.trim();
    const cleanCode = inviteCode.trim();
    setJoinStatus({ kind: 'muted', key: 'team.joining' });
    if (!cleanHub || !cleanCode) {
      setJoinStatus({ kind: 'err', key: 'team.errHubCode' });
      return;
    }
    const r = await joinRemoteTeam(cleanHub, cleanCode);
    if (!alive.current) return;
    if ((r.body as any)?.ok) {
      setJoinStatus({ kind: 'joined', name: String((r.body as any).teamName || '') });
      setInviteCode('');
    } else {
      setJoinStatus({ kind: 'join-fail', error: (r.body as any)?.error || r.status });
    }
  }

  return (
    <section className="page team-page team-manage-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('team.eyebrow')}</p>
          <h1>{tr('team.manageTitle')}</h1>
        </div>
        <div className="page-heading-actions"><TeamSubNav active="manage" /></div>
      </div>
      <div className="card team-card">
        <div className="team-card-head">
          <h2>{tr('team.hostedTitle')}</h2>
        </div>
        <form className="team-inline-form dashboard-toolbar" onSubmit={event => { event.preventDefault(); void handleCreateTeam(); }}>
          <input id="tm-newname" type="text" placeholder={tr('team.newTeamPh')} value={newName} onChange={ev => setNewName(ev.target.value)} />
          <CreateActionButton id="tm-create" className="page-primary-action" onClick={() => void handleCreateTeam()}>{tr('team.createTeamBtn')}</CreateActionButton>
          <span className="toolbar-status tm-cout"><ManageInlineStatus status={createStatus} tr={tr} /></span>
        </form>
        <div id="tm-list">
          <ManageTeamsList
            teams={teams}
            suggestedHubUrl={suggestedHubUrl}
            inviteStatuses={inviteStatuses}
            tr={tr}
            onInvite={teamId => void handleInvite(teamId)}
            onDelete={(teamId, name) => void handleDelete(teamId, name)}
          />
        </div>
      </div>
      <div className="card team-card">
        <div className="team-card-head">
          <h2>{tr('team.joinTitle')}</h2>
        </div>
        <form className="team-inline-form dashboard-toolbar team-join-form" onSubmit={event => { event.preventDefault(); void handleJoin(); }}>
          <input id="tm-hub" type="text" placeholder={tr('team.hubPh')} value={hubUrl} onChange={ev => setHubUrl(ev.target.value)} />
          <input id="tm-code" type="text" placeholder={tr('team.codePh')} value={inviteCode} onChange={ev => setInviteCode(ev.target.value)} />
          <button type="button" id="tm-join" className="page-primary-action" onClick={() => void handleJoin()}>{tr('team.joinBtn')}</button>
        </form>
        <div id="tm-join-out" className="team-inline-output" hidden={joinStatus.kind === 'none'}>
          <ManageInlineStatus status={joinStatus} tr={tr} />
        </div>
      </div>
    </section>
  );
}

function ManageTeamsList(props: {
  teams: any[];
  suggestedHubUrl: string;
  inviteStatuses: Map<string, ManageStatus>;
  tr: Translator;
  onInvite(teamId: string): void;
  onDelete(teamId: string, name: string): void;
}) {
  const { teams, tr } = props;
  if (!teams.length) return <p className="muted">{tr('team.noTeamsShort')}</p>;
  return (
    <>
      {teams.map(team => {
        const remote = (team.deployments || []).filter((deployment: any) => !deployment.local).length;
        const status = props.inviteStatuses.get(team.teamId) ?? { kind: 'none' as const };
        return (
          <div className="card team-list-card team-manage-card" key={team.teamId}>
            <div className="team-manage-head">
              <b>{team.name}</b>{team.isDefault ? <span className="team-status-pill muted">{tr('team.default')}</span> : null}
              <span className="team-meta-pill">
                {tr('team.manageMetaDeps', { count: (team.deployments || []).length })}{remote ? tr('team.manageMetaRemote', { r: remote }) : ''} · {tr('team.manageMetaBots', { count: (team.bots || []).length })}
              </span>
              <span className="team-manage-actions">
                <button className="tm-invite ghost" data-team={team.teamId} onClick={() => props.onInvite(team.teamId)}>{tr('team.genInvite')}</button>
                {team.isDefault ? null : <button className="tm-del ghost" data-team={team.teamId} data-name={team.name} onClick={() => props.onDelete(team.teamId, team.name)}>{tr('team.delBtn')}</button>}
              </span>
            </div>
            <div className="tm-inv-out team-inline-output" data-team={team.teamId} hidden={status.kind === 'none'}>
              <ManageInlineStatus status={status} tr={tr} suggestedHubUrl={props.suggestedHubUrl} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function ManageInlineStatus(props: { status: ManageStatus; tr: Translator; suggestedHubUrl?: string }) {
  const { status, tr } = props;
  if (status.kind === 'none') return null;
  if (status.kind === 'muted') return <span className="muted">{tr(status.key)}</span>;
  if (status.kind === 'ok') return <span className="ok">{tr(status.key)}</span>;
  if (status.kind === 'err') return <span className="err">{tr(status.key)}</span>;
  if (status.kind === 'create-fail') return <span className="err">{tr('team.createFail', { error: status.error })}</span>;
  if (status.kind === 'invite') {
    return (
      <>
        {tr('team.inviteResultLede')}<br />
        {tr('team.inviteHub')}<code>{props.suggestedHubUrl || ''}</code><br />
        {tr('team.inviteCode')}<code className="team-invite-code">{status.code}</code>
      </>
    );
  }
  if (status.kind === 'joined') return <span className="ok">{tr('team.joined', { name: status.name })}</span>;
  const e = status.error;
  const msg = e === 'cannot_join_self' ? tr('team.joinErrSelf')
    : e === 'deployment_already_joined' ? tr('team.joinErrAlready')
    : e === 'hub_unreachable' ? tr('team.joinErrUnreachable')
    : e === 'hub_timeout' ? tr('team.joinErrTimeout')
    : tr('team.joinErrGeneric', { error: String(e) });
  return <span className="err">{msg}</span>;
}

export function renderTeamFederationPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <TeamHomePage />);
}

export function renderTeamManagePage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <TeamManagePage />);
}
