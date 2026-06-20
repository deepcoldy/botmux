// Team (federation) page: manage this deployment's team membership across
// deployments. Two sub-routes (workflow-style sub-nav):
//   #/team        — My team: identity bind + every team I'm in (hosted + joined),
//                   each a collapsible block (deployments → bots) with group-pull.
//   #/team/manage — Team management: create multiple hosted teams, per-team invite
//                   codes, delete teams, join others' teams.
// All dashboard-token authed (cookie). See docs/federation-design.md.
import { escapeHtml, t } from './ui.js';

interface RosterBot {
  larkAppId: string; name: string; cliId: string; capability: string | null;
  hasTeamRole: boolean; deployment: { id: string; name: string; local: boolean; stale: boolean };
}
interface RosterDeployment { id: string; name: string; local: boolean; botCount: number; stale: boolean; }

interface Team {
  kind: 'local' | 'remote';
  key: string;            // 'local:<teamId>' or `${hubUrl}::${teamId}`
  teamId: string;
  label: string;
  sub: string;            // hubUrl (remote)
  ok: boolean;
  error?: string;
  hubUrl?: string;
  deployments: RosterDeployment[];
  bots: RosterBot[];
}

async function jget(u: string) { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({} as any)) }; }
async function jsend(method: string, u: string, b?: unknown) {
  const r = await fetch(u, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}
const jpost = (u: string, b?: unknown) => jsend('POST', u, b);
const jput = (u: string, b: unknown) => jsend('PUT', u, b);

let localTeams: Team[] = [];   // teams THIS deployment hosts (default + created)
let remoteTeams: Team[] = [];  // teams this deployment joined
let myDeploymentId = '';
let suggestedHubUrl = '';
const pickedByTeam = new Map<string, Set<string>>();
const gnameByTeam = new Map<string, string>(); // group-name draft per team — survives renderTeams() re-render
const expandedTeams = new Set<string>(); // default empty → all teams collapsed; click a team header to expand
const expandedDeps = new Set<string>(); // `${team.key}::${dep.id}` — default empty → deployment groups collapsed too

function $(id: string): HTMLElement { return document.getElementById(id)!; }
function allTeams(): Team[] { return [...localTeams, ...remoteTeams]; }
function pickedSet(key: string): Set<string> { let s = pickedByTeam.get(key); if (!s) { s = new Set(); pickedByTeam.set(key, s); } return s; }
function teamByKey(key: string): Team | undefined { return allTeams().find(t => t.key === key); }

function subNav(active: 'home' | 'manage'): string {
  const tab = (href: string, label: string, on: boolean) =>
    `<a href="${href}" style="padding:6px 14px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;${on ? 'background:var(--accent);color:var(--on-accent)' : 'color:var(--muted);background:var(--surface-muted)'}">${label}</a>`;
  return `<div style="display:flex;gap:8px;margin-bottom:14px">${tab('#/team', t('team.navHome'), active === 'home')}${tab('#/team/manage', t('team.navManage'), active === 'manage')}</div>`;
}

// ─────────────────────────── #/team (my team) ───────────────────────────

function homeHtml(): string {
  return `<section class="page">
<div class="page-heading"><div>
  <p class="eyebrow">${t('team.eyebrow')}</p><h1>${t('team.homeTitle')}</h1>
  <p class="tf-lede">${t('team.homeLede')}</p>
</div></div>
${subNav('home')}
<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">${t('team.localDeployTitle')}</h2>
  <p>${t('team.myIdentity')}<b id="tf-owner">${t('team.unbound')}</b>
    <button id="tf-autobind" class="primary" style="margin-left:8px">${t('team.bindBtn')}</button>
    <span class="muted" style="font-size:13px">${t('team.bindHint')}</span></p>
  <div id="tf-bind-out" style="display:none;margin-top:6px"></div>
</div>
<div class="card">
  <h2 style="margin-top:0">${t('team.myTeams')} <span class="muted" id="tf-count" style="font-size:13px"></span></h2>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:13px">
    <input id="tf-search" placeholder="${t('team.searchPh')}" style="padding:5px 9px;min-width:180px">
    <select id="tf-cli" style="padding:5px"><option value="">${t('team.allCli')}</option></select>
    <label><input type="checkbox" id="tf-fcap"> ${t('team.hasCap')}</label>
    <label><input type="checkbox" id="tf-frole"> ${t('team.hasRole')}</label>
  </div>
  <p class="muted" style="font-size:13px;margin:0 0 4px">${t('team.teamsHint')}</p>
  <div id="tf-teams">${t('team.loading')}</div>
</div>
<div id="tf-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:50">
  <div style="background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:10px;padding:18px 20px;width:min(560px,92vw)">
    <h2 id="tf-modal-title" style="margin-top:0">${t('team.roleModalTitle')}</h2>
    <p class="muted" style="font-size:13px">${t('team.roleModalHint')}</p>
    <textarea id="tf-modal-text" readonly style="width:100%;min-height:200px;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px;box-sizing:border-box"></textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
      <button id="tf-modal-cancel">${t('team.close')}</button>
    </div>
  </div>
</div>
</section>`;
}

function botMatch(b: RosterBot): boolean {
  const q = ((($('tf-search') as HTMLInputElement).value) || '').trim().toLowerCase();
  if (q && !((b.name || '') + ' ' + (b.cliId || '') + ' ' + (b.capability || '')).toLowerCase().includes(q)) return false;
  const cli = ($('tf-cli') as HTMLInputElement).value; if (cli && b.cliId !== cli) return false;
  if (($('tf-fcap') as HTMLInputElement).checked && !b.capability) return false;
  if (($('tf-frole') as HTMLInputElement).checked && !b.hasTeamRole) return false;
  return true;
}

function renderTeamBody(t2: Team, filtered: RosterBot[]): string {
  const ordered = [...t2.deployments].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
  let h = '';
  for (const dep of ordered) {
    const depBots = filtered.filter(x => x.deployment.id === dep.id);
    if (!depBots.length) continue;
    const mine = dep.id === myDeploymentId;
    const tag = mine ? t('team.tagLocal') : (dep.stale ? t('team.tagRemoteStale') : t('team.tagRemote'));
    // In a team I host, I can remove a joined member deployment (not myself).
    const rm = (t2.kind === 'local' && !mine)
      ? ` <button class="tf-rmmember ghost" data-team="${escapeHtml(t2.teamId)}" data-dep="${escapeHtml(dep.id)}" data-name="${escapeHtml(dep.name)}" style="font-size:12px">${t('team.removeMember')}</button>`
      : '';
    const depKey = `${t2.key}::${dep.id}`;
    const depOpen = expandedDeps.has(depKey);
    const npick = depBots.filter(b => pickedSet(t2.key).has(b.larkAppId)).length;
    h += `<div class="tf-dep-h" data-dk="${escapeHtml(depKey)}" style="cursor:pointer;margin:10px 0 2px"><b>${depOpen ? '▾' : '▸'} ${escapeHtml(dep.name)}</b> <span class="muted" style="font-size:12px">${t('team.depTag', { tag })} · ${t('team.depCount', { count: depBots.length })}${npick ? t('team.depSelected', { n: npick }) : ''}</span>${rm}</div>`;
    if (!depOpen) continue; // collapsed: header only (picks persist)
    h += '<table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>';
    for (const b of depBots) {
      const app = escapeHtml(b.larkAppId);
      const ck = pickedSet(t2.key).has(b.larkAppId) ? ' checked' : '';
      const dim = b.deployment.stale ? 'opacity:.55' : '';
      const capCell = mine
        ? `<input class="tf-cap" data-app="${app}" value="${escapeHtml(b.capability || '')}" placeholder="${t('team.capPh')}" style="width:92%;padding:3px 6px">`
        : (b.capability ? escapeHtml(b.capability) : '<span class="muted">—</span>');
      // Role is edited on the Bot Defaults page now; here we only offer a
      // read-only view entry for this deployment's own bots that have one.
      const roleCell = b.hasTeamRole
        ? (mine
          ? `<button class="tf-role" data-app="${app}" data-name="${escapeHtml(b.name)}">${t('team.viewRole')}</button>`
          : t('team.hasRoleShort'))
        : '<span class="muted">—</span>';
      h += `<tr style="${dim}"><td style="padding:4px 8px"><input type="checkbox" class="tf-pick" data-tk="${escapeHtml(t2.key)}" data-app="${app}"${ck}></td>`
        + `<td style="padding:4px 8px">${escapeHtml(b.name)}</td><td style="padding:4px 8px" class="muted">${escapeHtml(b.cliId)}</td>`
        + `<td style="padding:4px 8px">${capCell}</td><td style="padding:4px 8px">${roleCell}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  if (!h) h = `<p class="muted" style="margin:8px 0 0">${t('team.noMatch')}</p>`;
  h += `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
    + `<input class="tf-gname" data-tk="${escapeHtml(t2.key)}" value="${escapeHtml(gnameByTeam.get(t2.key) || '')}" placeholder="${t('team.gnamePh')}" style="min-width:200px">`
    + `<button class="tf-grp primary" data-tk="${escapeHtml(t2.key)}">${t('team.pullGroupBtn')}</button>`
    + `<span class="muted" style="font-size:13px">${t('team.pullGroupHint')}</span>`
    + `<span class="tf-gout" data-tk="${escapeHtml(t2.key)}" style="font-size:13px;display:block;flex-basis:100%"></span></div>`;
  return h;
}

function renderTeams(): void {
  const el = $('tf-teams');
  const teams = allTeams();
  if (!teams.length) { el.innerHTML = `<p class="muted">${t('team.noTeams')}</p>`; $('tf-count').textContent = ''; return; }
  let html = '';
  const shownIds = new Set<string>(), totalIds = new Set<string>();
  for (const t2 of teams) {
    const filtered = t2.bots.filter(botMatch);
    filtered.forEach(b => shownIds.add(b.larkAppId)); t2.bots.forEach(b => totalIds.add(b.larkAppId));
    const visible = new Set(filtered.map(b => b.larkAppId));
    [...pickedSet(t2.key)].forEach(a => { if (!visible.has(a)) pickedSet(t2.key).delete(a); });
    const col = !expandedTeams.has(t2.key); // collapsed unless explicitly expanded
    const conn = t2.kind === 'remote'
      ? (t2.ok ? ` <span class="ok" style="font-size:12px">${t('team.connected')}</span>` : ` <span class="err" style="font-size:12px">${t('team.connectFail', { error: escapeHtml(t2.error || '') })}</span>`)
      : ` <span class="muted" style="font-size:12px">${t('team.iHost')}</span>`;
    html += `<div class="card" style="margin:0 0 12px;padding:12px 14px;background:var(--bg-soft,#f6f7f9)">`
      + `<div class="tf-team-h" data-tk="${escapeHtml(t2.key)}" style="cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
      + `<b style="font-size:15px">${col ? '▸' : '▾'} ${escapeHtml(t2.label)}</b>`
      + (t2.sub ? ` <span class="muted" style="font-size:12px">${escapeHtml(t2.sub)}</span>` : '')
      + conn
      + ` <span class="muted" style="font-size:12px">· ${t('team.teamMeta', { deps: t2.deployments.length, bots: t2.bots.length })}</span></div>`;
    if (!col) html += (t2.kind === 'remote' && !t2.ok) ? `<p class="muted" style="margin:8px 0 0">${t('team.rosterFail')}</p>` : renderTeamBody(t2, filtered);
    html += '</div>';
  }
  el.innerHTML = html;
  const acrossTeams = teams.length > 1 ? t('team.acrossTeams', { n: teams.length }) : '';
  const numStr = shownIds.size === totalIds.size ? `${totalIds.size}` : `${shownIds.size} / ${totalIds.size}`;
  $('tf-count').textContent = `· ${numStr} ${t('team.botsWord')}${acrossTeams}`;
  wireTeams();
}

function wireTeams(): void {
  const el = $('tf-teams');
  el.querySelectorAll<HTMLElement>('.tf-team-h').forEach(h => {
    h.onclick = () => { const k = h.dataset.tk!; if (expandedTeams.has(k)) expandedTeams.delete(k); else expandedTeams.add(k); renderTeams(); };
  });
  el.querySelectorAll<HTMLElement>('.tf-dep-h').forEach(h => {
    h.onclick = () => { const k = h.dataset.dk!; if (expandedDeps.has(k)) expandedDeps.delete(k); else expandedDeps.add(k); renderTeams(); };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-pick').forEach(cb => {
    cb.onchange = () => { const s = pickedSet(cb.dataset.tk!); if (cb.checked) s.add(cb.dataset.app!); else s.delete(cb.dataset.app!); };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-gname').forEach(inp => {
    inp.oninput = () => { gnameByTeam.set(inp.dataset.tk!, inp.value); };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-cap').forEach(inp => {
    inp.onchange = async () => {
      const app = inp.dataset.app!, valv = inp.value;
      await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/capability', { capability: valv });
      allTeams().forEach(t2 => { const bb = t2.bots.find(b => b.larkAppId === app); if (bb) bb.capability = valv.trim() || null; });
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-role').forEach(btn => { btn.onclick = () => openRoleModal(btn.dataset.app!, btn.dataset.name || ''); });
  el.querySelectorAll<HTMLButtonElement>('.tf-rmmember').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // inside the clickable dep header — don't toggle collapse
      if (!confirm(t('team.removeMemberConfirm', { name: btn.dataset.name || '' }))) return;
      await jsend('DELETE', `/api/team/hosted/${encodeURIComponent(btn.dataset.team!)}/members/${encodeURIComponent(btn.dataset.dep!)}`);
      loadLocal();
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-grp').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.tk!; const t2 = teamByKey(k); if (!t2) return;
      const apps = [...pickedSet(k)];
      const out = el.querySelector<HTMLElement>(`.tf-gout[data-tk="${CSS.escape(k)}"]`)!;
      if (!apps.length) { out.innerHTML = `<span class="err">${t('team.errPickBot')}</span>`; return; }
      const name = (el.querySelector<HTMLInputElement>(`.tf-gname[data-tk="${CSS.escape(k)}"]`)?.value || '').trim() || t('team.defaultGroupName');
      out.innerHTML = `<span class="muted">${t('team.creatingGroup')}</span>`;
      const r = t2.kind === 'local'
        ? await jpost('/api/team/federated-group', { name, larkAppIds: apps, teamId: t2.teamId })
        : await jpost('/api/team/remote-group', { hubUrl: t2.hubUrl, teamId: t2.teamId, name, larkAppIds: apps });
      renderGroupResult(out, r.body as any, r.status);
      if ((r.body as any)?.ok) {
        pickedSet(k).clear(); gnameByTeam.delete(k);
        // Re-render so the form (group name + checkboxes) clears consistently for both
        // local & remote, then restore the success message/link a plain re-render would wipe.
        const resultHtml = out.innerHTML;
        const restore = () => { const o = el.querySelector<HTMLElement>(`.tf-gout[data-tk="${CSS.escape(k)}"]`); if (o) o.innerHTML = resultHtml; };
        if (t2.kind === 'local') void loadLocal().then(restore); else { renderTeams(); restore(); }
      }
    };
  });
}

function renderGroupResult(out: HTMLElement, b: any, status: number): void {
  if (b?.ok && b.chatId) {
    const link = b.shareLink || ('https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(b.chatId));
    const invalid = (b.invalidBotIds || []).length ? ` <span class="err"> · ${t('team.invalidBots', { ids: escapeHtml((b.invalidBotIds || []).join(', ')) })}</span>` : '';
    const invOwners = (b.invalidOwnerUnionIds || []).length ? `<span class="err"> · ${t('team.invalidOwners', { n: (b.invalidOwnerUnionIds || []).length })}</span>` : '';
    const miss = b.missingOperatorIdentity ? `<span class="err"> · ${t('team.missingIdentity')}</span>` : '';
    const skipped = (b.skippedNoOwner || []).length ? `<span class="err"> · ${t('team.skippedNoOwner', { n: (b.skippedNoOwner || []).length })}</span>` : '';
    const by = b.delegatedTo ? t('team.delegatedBy', { name: escapeHtml(b.delegatedTo) }) : '';
    out.innerHTML = `<span class="ok">${t('team.groupCreated')}</span>${by} · <a href="${escapeHtml(link)}" target="_blank">${t('team.openInLark')}</a>${invalid}${invOwners}${miss}${skipped}`;
  } else {
    const e = b?.error || status;
    const msg = e === 'no_local_online_bot' ? t('team.errNoLocalBot')
      : e === 'all_bots_skipped_no_owner' ? t('team.errAllSkipped')
      : e === 'no_creator_available' ? t('team.errNoCreator')
      : e === 'delegation_timeout' ? t('team.errDelegationTimeout')
      : t('team.errGroupCreate', { error: String(e) });
    out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
  }
}

async function openRoleModal(app: string, name: string): Promise<void> {
  const r = await jget('/api/team/local-bots/' + encodeURIComponent(app) + '/role');
  $('tf-modal-title').textContent = t('team.roleModalTitleName', { name });
  ($('tf-modal-text') as HTMLTextAreaElement).value = (r.body as any)?.role || '';
  $('tf-modal').dataset.app = app;
  $('tf-modal').style.display = 'flex';
}

function refreshCliOptions(): void {
  const clis = Array.from(new Set(allTeams().flatMap(t2 => t2.bots.map(x => x.cliId)).filter(Boolean))).sort();
  const sel = $('tf-cli') as HTMLSelectElement; const cur = sel.value;
  sel.innerHTML = `<option value="">${t('team.allCli')}</option>` + clis.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = cur;
}

async function loadLocal(): Promise<void> {
  const r = await jget('/api/team/hosted');
  const b = r.body as any;
  if (!b?.ok) { localTeams = []; renderTeams(); return; }
  myDeploymentId = b.deployment.deploymentId;
  suggestedHubUrl = b.suggestedHubUrl || '';
  $('tf-owner').textContent = b.deployment.ownerName || (b.deployment.ownerUnionId ? t('team.bound') : t('team.unbound'));
  localTeams = (b.teams || []).map((t2: any) => ({
    kind: 'local' as const, key: `local:${t2.teamId}`, teamId: t2.teamId,
    label: t2.isDefault ? t('team.myHostedTeam') : t2.name, sub: '', ok: true,
    deployments: t2.deployments || [], bots: t2.bots || [],
  }));
  refreshCliOptions();
  renderTeams();
}

async function loadRemote(): Promise<void> {
  const r = await jget('/api/team/remote-roster');
  const list = (r.body as any)?.memberships || [];
  remoteTeams = list.map((m: any) => {
    const deployments: RosterDeployment[] = m.roster?.deployments || [];
    const hub = deployments.find(d => d.local);
    const label = hub?.name ? t('team.remoteTeamLabel', { name: hub.name }) : (m.teamName || m.teamId);
    return {
      kind: 'remote' as const, key: `${m.hubUrl}::${m.teamId}`, teamId: m.teamId, label, sub: m.hubUrl,
      ok: !!m.ok, error: m.error, hubUrl: m.hubUrl, deployments, bots: m.roster?.bots || [],
    };
  });
  refreshCliOptions();
  renderTeams();
}

export function renderTeamFederationPage(root: HTMLElement): void {
  root.innerHTML = homeHtml();
  pickedByTeam.clear(); gnameByTeam.clear(); expandedTeams.clear(); expandedDeps.clear();
  ['tf-search', 'tf-cli', 'tf-fcap', 'tf-frole'].forEach(id => { const el = $(id); el.oninput = renderTeams; el.onchange = renderTeams; });
  $('tf-modal-cancel').onclick = () => { $('tf-modal').style.display = 'none'; };
  wireBind();
  void loadLocal();
  void loadRemote();
}

// ───────────────────────── #/team/manage (team management) ─────────────────────────

function manageHtml(): string {
  return `<section class="page">
<div class="page-heading"><div>
  <p class="eyebrow">${t('team.eyebrow')}</p><h1>${t('team.manageTitle')}</h1>
  <p class="tf-lede">${t('team.manageLede')}</p>
</div></div>
${subNav('manage')}
<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">${t('team.hostedTitle')}</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
    <input id="tm-newname" placeholder="${t('team.newTeamPh')}" style="min-width:200px">
    <button id="tm-create" class="primary">${t('team.createTeamBtn')}</button>
    <span class="muted tm-cout" style="font-size:13px"></span>
  </p>
  <div id="tm-list">${t('team.loading')}</div>
</div>
<div class="card">
  <h2 style="margin-top:0">${t('team.joinTitle')}</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="tm-hub" placeholder="${t('team.hubPh')}" style="flex:1;min-width:240px">
    <input id="tm-code" placeholder="${t('team.codePh')}" style="min-width:160px">
    <button id="tm-join" class="primary">${t('team.joinBtn')}</button>
  </p>
  <div id="tm-join-out" style="display:none;margin-top:6px"></div>
</div>
</section>`;
}

async function loadManageList(): Promise<void> {
  const r = await jget('/api/team/hosted');
  const b = r.body as any;
  const el = $('tm-list');
  suggestedHubUrl = b?.suggestedHubUrl || suggestedHubUrl;
  const teams = b?.teams || [];
  if (!teams.length) { el.innerHTML = `<p class="muted">${t('team.noTeamsShort')}</p>`; return; }
  el.innerHTML = teams.map((t2: any) => {
    const remote = (t2.deployments || []).filter((d: any) => !d.local).length;
    return `<div class="card" style="margin:0 0 8px;padding:10px 14px;background:var(--bg-soft,#f6f7f9)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b>${escapeHtml(t2.name)}</b>${t2.isDefault ? ` <span class="muted" style="font-size:12px">${t('team.default')}</span>` : ''}
        <span class="muted" style="font-size:12px">· ${t('team.manageMetaDeps', { count: (t2.deployments || []).length })}${remote ? t('team.manageMetaRemote', { r: remote }) : ''} · ${t('team.manageMetaBots', { count: (t2.bots || []).length })}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="tm-invite ghost" data-team="${escapeHtml(t2.teamId)}" style="font-size:12px">${t('team.genInvite')}</button>
          ${t2.isDefault ? '' : `<button class="tm-del ghost" data-team="${escapeHtml(t2.teamId)}" data-name="${escapeHtml(t2.name)}" style="font-size:12px">${t('team.delBtn')}</button>`}
        </span>
      </div>
      <div class="tm-inv-out" data-team="${escapeHtml(t2.teamId)}" style="display:none;margin-top:6px;font-size:13px"></div></div>`;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('.tm-invite').forEach(btn => {
    btn.onclick = async () => {
      const team = btn.dataset.team!;
      const out = el.querySelector<HTMLElement>(`.tm-inv-out[data-team="${CSS.escape(team)}"]`)!;
      out.style.display = ''; out.innerHTML = `<span class="muted">${t('team.generating')}</span>`;
      const r2 = await jpost('/api/team/local-invite', { teamId: team });
      if ((r2.body as any)?.code) {
        out.innerHTML = `${t('team.inviteResultLede')}<br>${t('team.inviteHub')}<code>${escapeHtml(suggestedHubUrl)}</code><br>${t('team.inviteCode')}<code style="font-size:15px">${escapeHtml((r2.body as any).code)}</code>`;
      } else { out.innerHTML = `<span class="err">${t('team.genFail')}</span>`; }
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tm-del').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm(t('team.delConfirm', { name: btn.dataset.name || '' }))) return;
      await jsend('DELETE', '/api/team/hosted/' + encodeURIComponent(btn.dataset.team!));
      loadManageList();
    };
  });
}

export function renderTeamManagePage(root: HTMLElement): void {
  root.innerHTML = manageHtml();
  $('tm-create').onclick = async () => {
    const name = ($('tm-newname') as HTMLInputElement).value.trim();
    const out = root.querySelector<HTMLElement>('.tm-cout')!;
    if (!name) { out.innerHTML = `<span class="err">${t('team.errName')}</span>`; return; }
    out.innerHTML = `<span class="muted">${t('team.creating')}</span>`;
    const r = await jpost('/api/team/hosted', { name });
    if ((r.body as any)?.ok) { out.innerHTML = `<span class="ok">${t('team.created')}</span>`; ($('tm-newname') as HTMLInputElement).value = ''; loadManageList(); }
    else { out.innerHTML = `<span class="err">${t('team.createFail', { error: escapeHtml(String((r.body as any)?.error || r.status)) })}</span>`; }
  };
  $('tm-join').onclick = async () => {
    const hubUrl = ($('tm-hub') as HTMLInputElement).value.trim();
    const inviteCode = ($('tm-code') as HTMLInputElement).value.trim();
    const out = $('tm-join-out'); out.style.display = '';
    if (!hubUrl || !inviteCode) { out.innerHTML = `<span class="err">${t('team.errHubCode')}</span>`; return; }
    out.innerHTML = `<span class="muted">${t('team.joining')}</span>`;
    const r = await jpost('/api/team/join-remote', { hubUrl, inviteCode });
    if ((r.body as any)?.ok) { out.innerHTML = `<span class="ok">${t('team.joined', { name: escapeHtml((r.body as any).teamName || '') })}</span>`; ($('tm-code') as HTMLInputElement).value = ''; }
    else {
      const e = (r.body as any)?.error || r.status;
      const msg = e === 'cannot_join_self' ? t('team.joinErrSelf') : e === 'deployment_already_joined' ? t('team.joinErrAlready') : e === 'hub_unreachable' ? t('team.joinErrUnreachable') : e === 'hub_timeout' ? t('team.joinErrTimeout') : t('team.joinErrGeneric', { error: String(e) });
      out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
    }
  };
  void loadManageList();
}

// ───────────────────────────── identity bind ─────────────────────────────

function wireBind(): void {
  $('tf-autobind').onclick = async () => {
    const out = $('tf-bind-out'); out.style.display = ''; out.innerHTML = `<span class="muted">${t('team.identifying')}</span>`;
    const r = await jpost('/api/team/identity/auto-bind');
    const b: any = r.body;
    if (b?.ok && b.owner) { out.innerHTML = `<span class="ok">${t('team.bound2', { name: escapeHtml(b.owner.name || b.owner.unionId) })}</span>`; loadLocal(); return; }
    if (b?.ok && b.needChoice && Array.isArray(b.candidates)) {
      const opts = b.candidates.map((c: any) => `<button class="tf-pickowner ghost" data-union="${escapeHtml(c.unionId)}" style="margin:2px">${escapeHtml(c.name || c.unionId)}</button>`).join(' ');
      out.innerHTML = `${t('team.multiCandidate')}<br>${opts}`;
      out.querySelectorAll<HTMLButtonElement>('.tf-pickowner').forEach(btn => {
        btn.onclick = async () => {
          out.innerHTML = `<span class="muted">${t('team.binding')}</span>`;
          const r2 = await jpost('/api/team/identity/auto-bind', { unionId: btn.dataset.union });
          const b2: any = r2.body;
          if (b2?.ok && b2.owner) { out.innerHTML = `<span class="ok">${t('team.bound2', { name: escapeHtml(b2.owner.name || b2.owner.unionId) })}</span>`; loadLocal(); }
          else { out.innerHTML = `<span class="err">${t('team.bindFail', { error: escapeHtml(String(b2?.error || 'unknown')) })}</span>`; }
        };
      });
      return;
    }
    if (b?.error === 'no_candidates') { out.innerHTML = `<span class="err">${t('team.noCandidates')}</span>`; return; }
    out.innerHTML = `<span class="err">${t('team.bindFail', { error: escapeHtml(String(b?.error || 'unknown')) })}</span>`;
  };
}
