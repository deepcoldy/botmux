// Team (federation) page: manage this deployment's team membership across
// deployments. Two sub-routes (workflow-style sub-nav):
//   #/team        — 我的团队: identity bind + every team I'm in (hosted + joined),
//                   each a collapsible block (deployments → bots) with 拉群.
//   #/team/manage — 团队管理: create multiple hosted teams, per-team invite codes,
//                   delete teams, join others' teams.
// All dashboard-token authed (cookie). See docs/federation-design.md.
import { escapeHtml } from './ui.js';

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
const expandedTeams = new Set<string>(); // default empty → all teams collapsed; click a team header to expand
const expandedDeps = new Set<string>(); // `${team.key}::${dep.id}` — default empty → deployment groups collapsed too

function $(id: string): HTMLElement { return document.getElementById(id)!; }
function allTeams(): Team[] { return [...localTeams, ...remoteTeams]; }
function pickedSet(key: string): Set<string> { let s = pickedByTeam.get(key); if (!s) { s = new Set(); pickedByTeam.set(key, s); } return s; }
function teamByKey(key: string): Team | undefined { return allTeams().find(t => t.key === key); }

function subNav(active: 'home' | 'manage'): string {
  const tab = (href: string, label: string, on: boolean) =>
    `<a href="${href}" style="padding:6px 14px;border-radius:8px;text-decoration:none;font-size:14px;${on ? 'background:var(--accent,#3370ff);color:#fff' : 'color:var(--text,#1f2329)'}">${label}</a>`;
  return `<div style="display:flex;gap:8px;margin-bottom:14px">${tab('#/team', '我的团队', active === 'home')}${tab('#/team/manage', '团队管理', active === 'manage')}</div>`;
}

// ─────────────────────────── #/team (我的团队) ───────────────────────────

function homeHtml(): string {
  return `<section class="page">
<div class="page-heading"><div>
  <p class="eyebrow">团队</p><h1>团队协作（跨部署）</h1>
  <p>把别的部署（同事自己跑的 botmux）邀请进同一个团队，互相发现机器人、协作拉群。</p>
</div></div>
${subNav('home')}
<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">本部署</h2>
  <p>我的飞书身份：<b id="tf-owner">未绑定</b>
    <button id="tf-autobind" class="primary" style="margin-left:8px">绑定</button>
    <span class="muted" style="font-size:13px">（用机器人凭证自动识别你；绑定后拉群会把你拉进群、机器人也归到你名下）</span></p>
  <div id="tf-bind-out" style="display:none;margin-top:6px"></div>
</div>
<div class="card">
  <h2 style="margin-top:0">我的团队 <span class="muted" id="tf-count" style="font-size:13px"></span></h2>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:13px">
    <input id="tf-search" placeholder="搜索 名称/能力/CLI…" style="padding:5px 9px;min-width:180px">
    <select id="tf-cli" style="padding:5px"><option value="">全部 CLI</option></select>
    <label><input type="checkbox" id="tf-fcap"> 有能力标签</label>
    <label><input type="checkbox" id="tf-frole"> 有团队角色</label>
  </div>
  <p class="muted" style="font-size:13px;margin:0 0 4px">每个团队里勾选机器人即可单独拉群（自动带上各自负责人）。要新建团队 / 生成邀请码 / 加入别人的团队，去「团队管理」。</p>
  <div id="tf-teams">加载中…</div>
</div>
<div id="tf-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:50">
  <div style="background:var(--card,#fff);color:var(--text,#1f2329);border-radius:10px;padding:18px 20px;width:min(560px,92vw)">
    <h2 id="tf-modal-title" style="margin-top:0">团队角色</h2>
    <p class="muted" style="font-size:13px">团队级角色（该机器人跨群的默认人设）。留空保存即删除。仅本部署的机器人可编辑。</p>
    <textarea id="tf-modal-text" style="width:100%;min-height:200px;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px;box-sizing:border-box"></textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
      <button id="tf-modal-cancel">取消</button><button id="tf-modal-save" class="primary">保存</button>
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

function renderTeamBody(t: Team, filtered: RosterBot[]): string {
  const ordered = [...t.deployments].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
  let h = '';
  for (const dep of ordered) {
    const depBots = filtered.filter(x => x.deployment.id === dep.id);
    if (!depBots.length) continue;
    const mine = dep.id === myDeploymentId;
    const tag = mine ? '本部署' : (dep.stale ? '远端·离线？' : '远端');
    // In a team I host, I can remove a joined member deployment (not myself).
    const rm = (t.kind === 'local' && !mine)
      ? ` <button class="tf-rmmember ghost" data-team="${escapeHtml(t.teamId)}" data-dep="${escapeHtml(dep.id)}" data-name="${escapeHtml(dep.name)}" style="font-size:12px">移除</button>`
      : '';
    const depKey = `${t.key}::${dep.id}`;
    const depOpen = expandedDeps.has(depKey);
    const npick = depBots.filter(b => pickedSet(t.key).has(b.larkAppId)).length;
    h += `<div class="tf-dep-h" data-dk="${escapeHtml(depKey)}" style="cursor:pointer;margin:10px 0 2px"><b>${depOpen ? '▾' : '▸'} ${escapeHtml(dep.name)}</b> <span class="muted" style="font-size:12px">（${tag}）· ${depBots.length} 个${npick ? `，已选 ${npick}` : ''}</span>${rm}</div>`;
    if (!depOpen) continue; // collapsed: header only (picks persist)
    h += '<table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>';
    for (const b of depBots) {
      const app = escapeHtml(b.larkAppId);
      const ck = pickedSet(t.key).has(b.larkAppId) ? ' checked' : '';
      const dim = b.deployment.stale ? 'opacity:.55' : '';
      const capCell = mine
        ? `<input class="tf-cap" data-app="${app}" value="${escapeHtml(b.capability || '')}" placeholder="能力标签…" style="width:92%;padding:3px 6px">`
        : (b.capability ? escapeHtml(b.capability) : '<span class="muted">—</span>');
      const roleCell = mine
        ? `<button class="tf-role" data-app="${app}" data-name="${escapeHtml(b.name)}">${b.hasTeamRole ? '已设·改' : '设置'}</button>`
        : (b.hasTeamRole ? '有角色' : '<span class="muted">—</span>');
      h += `<tr style="${dim}"><td style="padding:4px 8px"><input type="checkbox" class="tf-pick" data-tk="${escapeHtml(t.key)}" data-app="${app}"${ck}></td>`
        + `<td style="padding:4px 8px">${escapeHtml(b.name)}</td><td style="padding:4px 8px" class="muted">${escapeHtml(b.cliId)}</td>`
        + `<td style="padding:4px 8px">${capCell}</td><td style="padding:4px 8px">${roleCell}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  if (!h) h = '<p class="muted" style="margin:8px 0 0">没有符合条件的机器人。</p>';
  h += `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
    + `<input class="tf-gname" data-tk="${escapeHtml(t.key)}" placeholder="群名（如：跨团队排障）" style="min-width:200px">`
    + `<button class="tf-grp primary" data-tk="${escapeHtml(t.key)}">把勾选的机器人拉一个群</button>`
    + `<span class="muted" style="font-size:13px">勾选机器人 → 拉到一个飞书群（自动含 owner）</span>`
    + `<span class="tf-gout" data-tk="${escapeHtml(t.key)}" style="font-size:13px;display:block;flex-basis:100%"></span></div>`;
  return h;
}

function renderTeams(): void {
  const el = $('tf-teams');
  const teams = allTeams();
  if (!teams.length) { el.innerHTML = '<p class="muted">还没有团队。去「团队管理」生成邀请码让别人加入你，或加入别人的团队。</p>'; $('tf-count').textContent = ''; return; }
  let html = '';
  const shownIds = new Set<string>(), totalIds = new Set<string>();
  for (const t of teams) {
    const filtered = t.bots.filter(botMatch);
    filtered.forEach(b => shownIds.add(b.larkAppId)); t.bots.forEach(b => totalIds.add(b.larkAppId));
    const visible = new Set(filtered.map(b => b.larkAppId));
    [...pickedSet(t.key)].forEach(a => { if (!visible.has(a)) pickedSet(t.key).delete(a); });
    const col = !expandedTeams.has(t.key); // collapsed unless explicitly expanded
    const conn = t.kind === 'remote'
      ? (t.ok ? ' <span class="ok" style="font-size:12px">已连接</span>' : ` <span class="err" style="font-size:12px">连接失败：${escapeHtml(t.error || '')}</span>`)
      : ' <span class="muted" style="font-size:12px">我托管</span>';
    html += `<div class="card" style="margin:0 0 12px;padding:12px 14px;background:var(--bg-soft,#f6f7f9)">`
      + `<div class="tf-team-h" data-tk="${escapeHtml(t.key)}" style="cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
      + `<b style="font-size:15px">${col ? '▸' : '▾'} ${escapeHtml(t.label)}</b>`
      + (t.sub ? ` <span class="muted" style="font-size:12px">${escapeHtml(t.sub)}</span>` : '')
      + conn
      + ` <span class="muted" style="font-size:12px">· ${t.deployments.length} 个部署 · ${t.bots.length} 个机器人</span></div>`;
    if (!col) html += (t.kind === 'remote' && !t.ok) ? '<p class="muted" style="margin:8px 0 0">无法获取该团队花名册。</p>' : renderTeamBody(t, filtered);
    html += '</div>';
  }
  el.innerHTML = html;
  const acrossTeams = teams.length > 1 ? `（跨 ${teams.length} 个团队，去重）` : '';
  $('tf-count').textContent = `· ${shownIds.size === totalIds.size ? `${totalIds.size}` : `${shownIds.size} / ${totalIds.size}`} 个机器人${acrossTeams}`;
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
  el.querySelectorAll<HTMLInputElement>('.tf-cap').forEach(inp => {
    inp.onchange = async () => {
      const app = inp.dataset.app!, valv = inp.value;
      await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/capability', { capability: valv });
      allTeams().forEach(t => { const bb = t.bots.find(b => b.larkAppId === app); if (bb) bb.capability = valv.trim() || null; });
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-role').forEach(btn => { btn.onclick = () => openRoleModal(btn.dataset.app!, btn.dataset.name || ''); });
  el.querySelectorAll<HTMLButtonElement>('.tf-rmmember').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // inside the clickable dep header — don't toggle collapse
      if (!confirm(`把「${btn.dataset.name}」移出这个团队？它的机器人将从本团队花名册消失（不影响对方自己的部署）。`)) return;
      await jsend('DELETE', `/api/team/hosted/${encodeURIComponent(btn.dataset.team!)}/members/${encodeURIComponent(btn.dataset.dep!)}`);
      loadLocal();
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-grp').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.tk!; const t = teamByKey(k); if (!t) return;
      const apps = [...pickedSet(k)];
      const out = el.querySelector<HTMLElement>(`.tf-gout[data-tk="${CSS.escape(k)}"]`)!;
      if (!apps.length) { out.innerHTML = '<span class="err">请先勾选至少一个机器人</span>'; return; }
      const name = (el.querySelector<HTMLInputElement>(`.tf-gname[data-tk="${CSS.escape(k)}"]`)?.value || '').trim() || '协作群';
      out.innerHTML = '<span class="muted">建群中…</span>';
      const r = t.kind === 'local'
        ? await jpost('/api/team/federated-group', { name, larkAppIds: apps, teamId: t.teamId })
        : await jpost('/api/team/remote-group', { hubUrl: t.hubUrl, teamId: t.teamId, name, larkAppIds: apps });
      renderGroupResult(out, r.body as any, r.status);
      if ((r.body as any)?.ok) { pickedSet(k).clear(); if (t.kind === 'local') loadLocal(); }
    };
  });
}

function renderGroupResult(out: HTMLElement, b: any, status: number): void {
  if (b?.ok && b.chatId) {
    const link = b.shareLink || ('https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(b.chatId));
    const invalid = (b.invalidBotIds || []).length ? `<span class="err"> · 未加入的机器人：${escapeHtml((b.invalidBotIds || []).join(', '))}</span>` : '';
    const invOwners = (b.invalidOwnerUnionIds || []).length ? `<span class="err"> · ${(b.invalidOwnerUnionIds || []).length} 个 owner 未能拉进</span>` : '';
    const miss = b.missingOperatorIdentity ? `<span class="err"> · 你未绑定飞书身份，没把你自己拉进群（去「我的团队」绑定）</span>` : '';
    const skipped = (b.skippedNoOwner || []).length ? `<span class="err"> · ${(b.skippedNoOwner || []).length} 个机器人因负责人未绑定身份被跳过（未加入群）</span>` : '';
    const by = b.delegatedTo ? `（由「${escapeHtml(b.delegatedTo)}」建群）` : '';
    out.innerHTML = `<span class="ok">群已创建</span>${by} · <a href="${escapeHtml(link)}" target="_blank">在飞书打开</a>${invalid}${invOwners}${miss}${skipped}`;
  } else {
    const e = b?.error || status;
    const msg = e === 'no_local_online_bot' ? '请至少勾选一个你自己（本部署）的在线机器人——群要由它创建并把你（发起人）拉进群。'
      : e === 'all_bots_skipped_no_owner' ? '所选机器人的负责人都没绑定身份，无法拉群（机器人不能进一个 owner 不在的群）。请让对应部署先绑定身份。'
      : e === 'no_creator_available' ? '没有可用的建群发起方（相关部署都没有在线机器人，或不可达）'
      : e === 'delegation_timeout' ? '委托对方部署建群超时（可能已建，去飞书确认，勿重复点）'
      : `建群失败：${e}`;
    out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
  }
}

async function openRoleModal(app: string, name: string): Promise<void> {
  const r = await jget('/api/team/local-bots/' + encodeURIComponent(app) + '/role');
  $('tf-modal-title').textContent = '团队角色 · ' + name;
  ($('tf-modal-text') as HTMLTextAreaElement).value = (r.body as any)?.role || '';
  $('tf-modal').dataset.app = app;
  $('tf-modal').style.display = 'flex';
}

function refreshCliOptions(): void {
  const clis = Array.from(new Set(allTeams().flatMap(t => t.bots.map(x => x.cliId)).filter(Boolean))).sort();
  const sel = $('tf-cli') as HTMLSelectElement; const cur = sel.value;
  sel.innerHTML = '<option value="">全部 CLI</option>' + clis.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = cur;
}

async function loadLocal(): Promise<void> {
  const r = await jget('/api/team/hosted');
  const b = r.body as any;
  if (!b?.ok) { localTeams = []; renderTeams(); return; }
  myDeploymentId = b.deployment.deploymentId;
  suggestedHubUrl = b.suggestedHubUrl || '';
  $('tf-owner').textContent = b.deployment.ownerName || (b.deployment.ownerUnionId ? '已绑定' : '未绑定');
  localTeams = (b.teams || []).map((t: any) => ({
    kind: 'local' as const, key: `local:${t.teamId}`, teamId: t.teamId,
    label: t.isDefault ? '我托管的团队' : t.name, sub: '', ok: true,
    deployments: t.deployments || [], bots: t.bots || [],
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
    const label = hub?.name ? `${hub.name} 的团队` : (m.teamName || m.teamId);
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
  pickedByTeam.clear(); expandedTeams.clear(); expandedDeps.clear();
  ['tf-search', 'tf-cli', 'tf-fcap', 'tf-frole'].forEach(id => { const el = $(id); el.oninput = renderTeams; el.onchange = renderTeams; });
  $('tf-modal-cancel').onclick = () => { $('tf-modal').style.display = 'none'; };
  $('tf-modal-save').onclick = async () => {
    const app = $('tf-modal').dataset.app!;
    await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/role', { role: ($('tf-modal-text') as HTMLTextAreaElement).value });
    $('tf-modal').style.display = 'none';
    loadLocal();
  };
  wireBind();
  void loadLocal();
  void loadRemote();
}

// ───────────────────────── #/team/manage (团队管理) ─────────────────────────

function manageHtml(): string {
  return `<section class="page">
<div class="page-heading"><div>
  <p class="eyebrow">团队</p><h1>团队管理</h1>
  <p>创建多个团队、给每个团队生成邀请码、或加入别人的团队。一个团队 = 你本部署的机器人 + 加入该团队的其它部署。</p>
</div></div>
${subNav('manage')}
<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">我托管的团队</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
    <input id="tm-newname" placeholder="新团队名称" style="min-width:200px">
    <button id="tm-create" class="primary">创建团队</button>
    <span class="muted tm-cout" style="font-size:13px"></span>
  </p>
  <div id="tm-list">加载中…</div>
</div>
<div class="card">
  <h2 style="margin-top:0">加入别人的团队</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="tm-hub" placeholder="Hub 地址，如 http://10.0.0.5:7891" style="flex:1;min-width:240px">
    <input id="tm-code" placeholder="邀请码" style="min-width:160px">
    <button id="tm-join" class="primary">加入</button>
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
  if (!teams.length) { el.innerHTML = '<p class="muted">还没有团队。</p>'; return; }
  el.innerHTML = teams.map((t: any) => {
    const remote = (t.deployments || []).filter((d: any) => !d.local).length;
    return `<div class="card" style="margin:0 0 8px;padding:10px 14px;background:var(--bg-soft,#f6f7f9)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b>${escapeHtml(t.name)}</b>${t.isDefault ? ' <span class="muted" style="font-size:12px">默认</span>' : ''}
        <span class="muted" style="font-size:12px">· ${(t.deployments || []).length} 个部署${remote ? `（含 ${remote} 远端）` : ''} · ${(t.bots || []).length} 个机器人</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="tm-invite ghost" data-team="${escapeHtml(t.teamId)}" style="font-size:12px">生成邀请码</button>
          ${t.isDefault ? '' : `<button class="tm-del ghost" data-team="${escapeHtml(t.teamId)}" data-name="${escapeHtml(t.name)}" style="font-size:12px">删除</button>`}
        </span>
      </div>
      <div class="tm-inv-out" data-team="${escapeHtml(t.teamId)}" style="display:none;margin-top:6px;font-size:13px"></div></div>`;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('.tm-invite').forEach(btn => {
    btn.onclick = async () => {
      const team = btn.dataset.team!;
      const out = el.querySelector<HTMLElement>(`.tm-inv-out[data-team="${CSS.escape(team)}"]`)!;
      out.style.display = ''; out.innerHTML = '<span class="muted">生成中…</span>';
      const r2 = await jpost('/api/team/local-invite', { teamId: team });
      if ((r2.body as any)?.code) {
        out.innerHTML = `把下面两项发给<b>别的部署</b>的人（24 小时内、单次有效）：<br>Hub 地址：<code>${escapeHtml(suggestedHubUrl)}</code><br>邀请码：<code style="font-size:15px">${escapeHtml((r2.body as any).code)}</code>`;
      } else { out.innerHTML = '<span class="err">生成失败。</span>'; }
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tm-del').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm(`删除团队「${btn.dataset.name}」？已加入它的部署会被移除（不影响他们自己的部署）。`)) return;
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
    if (!name) { out.innerHTML = '<span class="err">请填团队名称</span>'; return; }
    out.innerHTML = '<span class="muted">创建中…</span>';
    const r = await jpost('/api/team/hosted', { name });
    if ((r.body as any)?.ok) { out.innerHTML = '<span class="ok">已创建</span>'; ($('tm-newname') as HTMLInputElement).value = ''; loadManageList(); }
    else { out.innerHTML = `<span class="err">创建失败：${escapeHtml(String((r.body as any)?.error || r.status))}</span>`; }
  };
  $('tm-join').onclick = async () => {
    const hubUrl = ($('tm-hub') as HTMLInputElement).value.trim();
    const inviteCode = ($('tm-code') as HTMLInputElement).value.trim();
    const out = $('tm-join-out'); out.style.display = '';
    if (!hubUrl || !inviteCode) { out.innerHTML = '<span class="err">请填 Hub 地址和邀请码。</span>'; return; }
    out.innerHTML = '<span class="muted">加入中…</span>';
    const r = await jpost('/api/team/join-remote', { hubUrl, inviteCode });
    if ((r.body as any)?.ok) { out.innerHTML = `<span class="ok">已加入「${escapeHtml((r.body as any).teamName || '')}」，去「我的团队」查看。</span>`; ($('tm-code') as HTMLInputElement).value = ''; }
    else {
      const e = (r.body as any)?.error || r.status;
      const msg = e === 'cannot_join_self' ? '这是你自己的部署，不能加入自己（邀请码要发给别的部署的人用）' : e === 'deployment_already_joined' ? '你的部署已经加入过这个团队了' : e === 'hub_unreachable' ? '连不上对方 Hub（检查地址/网络）' : e === 'hub_timeout' ? '对方 Hub 响应超时' : `加入失败：${e}`;
      out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
    }
  };
  void loadManageList();
}

// ───────────────────────────── identity bind ─────────────────────────────

function wireBind(): void {
  $('tf-autobind').onclick = async () => {
    const out = $('tf-bind-out'); out.style.display = ''; out.innerHTML = '<span class="muted">识别中…</span>';
    const r = await jpost('/api/team/identity/auto-bind');
    const b: any = r.body;
    if (b?.ok && b.owner) { out.innerHTML = `<span class="ok">已绑定：${escapeHtml(b.owner.name || b.owner.unionId)}</span>`; loadLocal(); return; }
    if (b?.ok && b.needChoice && Array.isArray(b.candidates)) {
      const opts = b.candidates.map((c: any) => `<button class="tf-pickowner ghost" data-union="${escapeHtml(c.unionId)}" style="margin:2px">${escapeHtml(c.name || c.unionId)}</button>`).join(' ');
      out.innerHTML = `识别到多个候选，点你自己：<br>${opts}`;
      out.querySelectorAll<HTMLButtonElement>('.tf-pickowner').forEach(btn => {
        btn.onclick = async () => {
          out.innerHTML = '<span class="muted">绑定中…</span>';
          const r2 = await jpost('/api/team/identity/auto-bind', { unionId: btn.dataset.union });
          const b2: any = r2.body;
          if (b2?.ok && b2.owner) { out.innerHTML = `<span class="ok">已绑定：${escapeHtml(b2.owner.name || b2.owner.unionId)}</span>`; loadLocal(); }
          else { out.innerHTML = `<span class="err">绑定失败：${escapeHtml(String(b2?.error || 'unknown'))}</span>`; }
        };
      });
      return;
    }
    if (b?.error === 'no_candidates') { out.innerHTML = '<span class="err">没识别到身份：请确认机器人配置了 allowedUsers（允许使用者），且机器人有通讯录权限。</span>'; return; }
    out.innerHTML = `<span class="err">绑定失败：${escapeHtml(String(b?.error || 'unknown'))}</span>`;
  };
}
