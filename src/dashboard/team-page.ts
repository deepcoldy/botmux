/**
 * Team platform single-page UI, embedded as a string so it ships in dist with
 * no extra build step. Vanilla JS, no framework. Talks to /api/pairing/* and
 * /api/team/* (see team-routes.ts). Served at GET /team (pre-auth; the page
 * self-authenticates via the pairing flow → bmx_session cookie).
 */
export const TEAM_PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>botmux 团队平台</title>
<style>
  html { color-scheme: light; }
  html[data-theme="dark"] { color-scheme: dark; }
  :root {
    --bg:#f6f7f9; --card:#fff; --text:#1f2329; --heading:#4e5969; --muted:#86909c;
    --border:#e5e6eb; --border2:#f0f1f3; --input-bg:#fff; --input-border:#d0d3d9;
    --code-bg:#f2f3f5; --grp-bg:#f6f7f9; --header-bg:#1f2329; --tag-bg:#e8f3ff;
  }
  html[data-theme="dark"] {
    --bg:#17171a; --card:#212127; --text:#e8e9eb; --heading:#c9ccd1; --muted:#9298a0;
    --border:#34353c; --border2:#2b2c32; --input-bg:#2a2b31; --input-border:#3a3b43;
    --code-bg:#2a2b31; --grp-bg:#2a2b31; --header-bg:#0e0e11; --tag-bg:#16335a;
  }
  body { font: 15px/1.5 -apple-system, system-ui, "PingFang SC", sans-serif; margin: 0; background: var(--bg); color: var(--text); }
  header { padding: 14px 20px; background: var(--header-bg); color: #fff; display: flex; justify-content: space-between; align-items: center; }
  header b { font-size: 16px; }
  .topbar-r { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  header select, header button { background: transparent; border: 1px solid rgba(255,255,255,.3); color: #fff; padding: 4px 10px; border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer; }
  header select option { color: #1f2329; }
  main { max-width: 920px; margin: 0 auto; padding: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: var(--heading); }
  .code { font: 28px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 4px; background: var(--code-bg); color: var(--text); padding: 12px 16px; border-radius: 8px; display: inline-block; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--text); cursor: pointer; }
  button.primary { background: #3370ff; color: #fff; border-color: #3370ff; }
  input, select, textarea { background: var(--input-bg); color: var(--text); border: 1px solid var(--input-border); border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border2); }
  th { color: var(--muted); font-weight: 500; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--tag-bg); color: #3370ff; }
  .muted { color: var(--muted); }
  .ok { color: #00b42a; } .err { color: #f53f3f; }
  .hide { display: none; }
  .hint { color: var(--muted); font-size: 13px; margin-top: 8px; }
  input.capedit { font: inherit; width: 92%; padding: 4px 8px; }
  input.capedit:focus { border-color: #3370ff; outline: none; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
  /* .overlay sets display:flex; this compound selector must win over it so a
     hidden overlay stays hidden (plain .hide has equal specificity and loses
     to the later .overlay rule). */
  .overlay.hide { display: none; }
  .modal { background: var(--card); color: var(--text); border-radius: 10px; padding: 18px 20px; width: min(560px, 92vw); }
  .modal textarea { width: 100%; min-height: 200px; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 10px; box-sizing: border-box; }
  .modal .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
</head>
<body>
<header><b>botmux 团队平台</b><div class="topbar-r"><select id="team-switcher" title="切换团队" class="hide"></select><button id="btn-newteam" class="hide">＋ 团队</button><button id="btn-jointeam" class="hide">加入团队</button><button id="theme-toggle">🌙 暗色</button><span id="who"></span></div></header>
<main>
  <!-- Login -->
  <section id="login" class="card hide">
    <h2>登录</h2>
    <div id="login-start">
      <p><input id="invite-code" placeholder="邀请码（首次加入团队需要，团队成员可生成）" style="font:inherit;padding:8px 10px;border:1px solid #d0d3d9;border-radius:8px;width:min(360px,70vw)"></p>
      <button class="primary" id="btn-start">开始登录</button>
      <p class="hint">登录走飞书身份配对，不需要密码。已是团队成员可不填邀请码。</p></div>
    <div id="login-code" class="hide">
      <p>在飞书里给任意一个本团队机器人发送：</p>
      <p><span class="code" id="pair-cmd"></span></p>
      <p class="hint" id="pair-status">等待你在飞书里确认…</p>
    </div>
    <div id="login-err" class="hint err"></div>
  </section>

  <!-- App -->
  <section id="app" class="hide">
    <section class="card">
      <h2>团队花名册 <span class="muted" id="team-meta"></span></h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:13px">
        <input id="rf-search" placeholder="搜索 名称/能力/CLI…" style="font:inherit;padding:5px 9px;border:1px solid #d0d3d9;border-radius:8px">
        <select id="rf-cli" style="font:inherit;padding:5px"><option value="">全部 CLI</option></select>
        <label><input type="checkbox" id="rf-cap"> 有能力标签</label>
        <label><input type="checkbox" id="rf-role"> 有团队角色</label>
        <span class="muted" id="rf-count"></span>
      </div>
      <table><thead><tr><th></th><th>机器人</th><th>CLI</th><th>能力标签</th><th>团队角色</th></tr></thead>
        <tbody id="roster"></tbody></table>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="grp-name" placeholder="群名（如：支付排障）" style="font:inherit;padding:6px 10px;border:1px solid #d0d3d9;border-radius:8px">
        <button class="primary" id="btn-group">把勾选的机器人拉一个群</button>
        <button id="btn-claim">把勾选的归到我名下</button>
        <span class="hint">勾选上方机器人 → 拉群协作 / 归到自己名下</span>
      </div>
      <div id="grp-out" class="hide" style="margin-top:8px"></div>
    </section>
    <section class="card">
      <h2>团队成员 <span class="muted" id="members-meta"></span>
        <button class="primary" id="btn-invite" style="float:right;font-size:13px;padding:4px 12px">邀请成员</button>
        <button id="btn-delteam" class="hide" style="float:right;font-size:13px;padding:4px 12px;margin-right:8px;color:#f53f3f">删除团队</button></h2>
      <div id="invite-out" class="hide"></div>
      <table><thead><tr><th>成员</th><th>open_id</th><th></th></tr></thead><tbody id="members"></tbody></table>
    </section>
    <section class="card">
      <h2>接入点（connectors）<button class="primary" id="btn-newconn" style="float:right;font-size:13px;padding:4px 12px">创建接入点</button></h2>
      <div id="conn-out" class="hide"></div>
      <table><thead><tr><th>名称</th><th>来源</th><th>模式</th><th>启用</th><th>操作</th></tr></thead>
        <tbody id="connectors"></tbody></table>
    </section>
    <section class="card">
      <h2>最近触发</h2>
      <table><thead><tr><th>时间</th><th>connector</th><th>结果</th><th>错误</th></tr></thead>
        <tbody id="logs"></tbody></table>
    </section>
  </section>

  <!-- Team-role edit modal -->
  <div id="modal" class="overlay hide"><div class="modal">
    <h2 id="modal-title">团队角色</h2>
    <p class="hint">团队级角色（该机器人跨群的默认人设）。留空并保存即删除。本群 /role 仍可覆盖。</p>
    <textarea id="modal-text" placeholder="# 角色\n用 Markdown 描述这个机器人的职责/风格…"></textarea>
    <div class="row"><button id="modal-cancel">取消</button><button class="primary" id="modal-save">保存</button></div>
  </div></div>

  <!-- Connector create modal -->
  <div id="connmodal" class="overlay hide"><div class="modal" style="width:min(620px,94vw)">
    <h2>创建接入点（webhook connector）</h2>
    <div style="display:grid;gap:8px;font-size:14px">
      <label>名称<br><input id="cn-name" style="width:100%"></label>
      <label>来源类型<br><select id="cn-source"><option>generic</option><option>argos</option><option>meego</option><option>prometheus</option><option>github</option></select></label>
      <label>目标类型<br><select id="cn-kind"><option value="turn">turn（触发单个机器人一轮）</option><option value="workflow">workflow（跑工作流）</option></select></label>
      <label>投递模式<br><select id="cn-mode"><option value="dynamic">dynamic（群随请求传入）</option><option value="fixed">fixed（固定群）</option><option value="new-group">new-group（自动建群）</option></select></label>
      <label>机器人<br><select id="cn-bot"></select></label>
      <label id="cn-chat-l">chatId（fixed 用）<br><input id="cn-chat" style="width:100%"></label>
      <label id="cn-allow-l">allowChats（dynamic，逗号分隔，留空=any）<br><input id="cn-allow" style="width:100%"></label>
      <label id="cn-wf-l">workflowId<br><input id="cn-wf" style="width:100%"></label>
      <label id="cn-dedup-l">dedupKey JSONPath（new-group）<br><input id="cn-dedup" placeholder="$.alert.fingerprint" style="width:100%"></label>
      <label id="cn-status-l">status JSONPath（new-group）<br><input id="cn-status" placeholder="$.status" style="width:100%"></label>
      <label>secret（留空自动生成，只显示一次）<br><input id="cn-secret" style="width:100%"></label>
    </div>
    <div id="connmodal-err" class="hint err"></div>
    <div class="row"><button id="connmodal-cancel">取消</button><button class="primary" id="connmodal-save">创建</button></div>
  </div></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// Theme: explicit choice persisted to localStorage, else follow OS preference.
// data-theme on <html> drives both our CSS vars and color-scheme (so UA-rendered
// form controls match the cards instead of staying dark on a light page).
const THEME_KEY = 'bmx-team-theme';
function applyTheme(t){
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : '';
  const btn = $('theme-toggle');
  if (btn) btn.textContent = t === 'dark' ? '☀ 亮色' : '🌙 暗色';
}
(function initTheme(){
  let t = localStorage.getItem(THEME_KEY);
  if (t !== 'dark' && t !== 'light') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
})();
$('theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
};
async function jget(u){ const r = await fetch(u); return { status:r.status, body: await r.json().catch(()=>({})) }; }
async function jpost(u, b){ const r = await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined}); return { status:r.status, body: await r.json().catch(()=>({})) }; }
async function jput(u, b){ const r = await fetch(u,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}); return { status:r.status, body: await r.json().catch(()=>({})) }; }

// Roster state + client-side filtering. Selection (for 拉群) lives in a Set;
// filtering removes now-hidden bots from it, so a hidden row is never submitted.
let rosterBots = [];
const picked = new Set();
function rosterMatch(b){
  const q = ($('rf-search').value || '').trim().toLowerCase();
  if (q && !((b.name||'') + ' ' + (b.cliId||'') + ' ' + (b.capability||'')).toLowerCase().includes(q)) return false;
  const cli = $('rf-cli').value; if (cli && b.cliId !== cli) return false;
  if ($('rf-cap').checked && !b.capability) return false;
  if ($('rf-role').checked && !b.hasTeamRole) return false;
  return true;
}
function updateRosterCount(visibleCount){
  $('rf-count').textContent = '共 ' + visibleCount + ' / ' + rosterBots.length + ' 个 · 已选 ' + picked.size + '（均可见）';
}
function botRow(b, gid){
  const app = esc(b.larkAppId || '');
  const ck = app && picked.has(b.larkAppId) ? ' checked' : '';
  return '<tr data-rowg="'+gid+'"><td>'+(app?'<input type="checkbox" class="botpick" data-app="'+app+'"'+ck+'>':'')+'</td><td>'+esc(b.name)+'</td><td class="muted">'+esc(b.cliId)+'</td>'
    + '<td><input class="capedit" data-app="'+app+'" value="'+esc(b.capability||'')+'" placeholder="能力标签…"></td>'
    + '<td><button class="roleedit" data-app="'+app+'" data-name="'+esc(b.name)+'">'+(b.hasTeamRole?'已设·改':'设置')+'</button></td></tr>';
}
function renderRoster(){
  const f = rosterBots.filter(rosterMatch);
  const visible = new Set(f.map(b => b.larkAppId).filter(Boolean));
  [...picked].forEach(a => { if (!visible.has(a)) picked.delete(a); }); // hidden ⇒ deselected
  // group by owner (unionId/openId key); 未归属 last
  const groups = new Map();
  for (const b of f) {
    const o = b.owner;
    const key = (o && (o.unionId || o.openId)) || '__none__';
    const label = o ? (o.name || o.unionId || o.openId) : '未归属';
    if (!groups.has(key)) groups.set(key, { label, bots: [] });
    groups.get(key).bots.push(b);
  }
  const ordered = [...groups.entries()].sort((a, b2) => (a[0] === '__none__' ? 1 : b2[0] === '__none__' ? -1 : 0));
  let html = '', gi = 0;
  for (const [, g] of ordered) {
    const gid = 'g' + (gi++);
    html += '<tr class="grp" data-g="'+gid+'" style="cursor:pointer"><td colspan="5" style="background:var(--grp-bg)"><b>▾ '+esc(g.label)+'</b> <span class="muted">('+g.bots.length+')</span></td></tr>';
    html += g.bots.map(b => botRow(b, gid)).join('');
  }
  $('roster').innerHTML = html || '<tr><td colspan=5 class=muted>没有符合条件的机器人</td></tr>';
  updateRosterCount(f.length);
  document.querySelectorAll('.botpick').forEach(cb => {
    cb.onchange = () => { if (cb.checked) picked.add(cb.dataset.app); else picked.delete(cb.dataset.app); updateRosterCount(f.length); };
  });
  document.querySelectorAll('.capedit').forEach(inp => {
    inp.onchange = async () => {
      const app = inp.dataset.app, val = inp.value;
      await jput('/api/team/bots/'+encodeURIComponent(app)+'/capability', { capability: val });
      const bot = rosterBots.find(b => b.larkAppId === app); if (bot) bot.capability = val.trim();
      renderRoster();
    };
  });
  document.querySelectorAll('.roleedit').forEach(btn => { btn.onclick = () => openRoleModal(btn.dataset.app, btn.dataset.name); });
  document.querySelectorAll('tr.grp').forEach(tr => {
    tr.onclick = () => {
      const gid = tr.dataset.g, collapsed = tr.dataset.collapsed === '1';
      const rows = document.querySelectorAll('tr[data-rowg="'+gid+'"]');
      rows.forEach(r => { r.style.display = collapsed ? '' : 'none'; });
      if (!collapsed) {
        // collapsing hides rows → deselect them (hidden ⇒ never submitted, same rule as filtering)
        rows.forEach(r => { const cb = r.querySelector('.botpick'); if (cb) { if (cb.checked) picked.delete(cb.dataset.app); cb.checked = false; } });
        updateRosterCount(f.length);
      }
      tr.dataset.collapsed = collapsed ? '' : '1';
      const bEl = tr.querySelector('b'); bEl.textContent = (collapsed ? '▾ ' : '▸ ') + bEl.textContent.slice(2);
    };
  });
}
['rf-search','rf-cli','rf-cap','rf-role'].forEach(id => { const el = $(id); if (el) { el.oninput = renderRoster; el.onchange = renderRoster; } });

let pollTimer = null;

async function showApp(){
  $('login').classList.add('hide'); $('app').classList.remove('hide');
  const me = await jget('/api/team/me');
  $('who').textContent = me.body?.user?.name ? me.body.user.name + ' · 退出' : '退出';
  $('who').style.cursor = 'pointer';
  $('who').onclick = async () => { await jpost('/api/team/logout'); location.reload(); };

  // Multi-team switcher: list my teams, switch active, create, join-by-invite.
  const teams = me.body?.teams || [], curTeam = me.body?.teamId;
  const sw = $('team-switcher');
  sw.classList.remove('hide'); $('btn-newteam').classList.remove('hide'); $('btn-jointeam').classList.remove('hide');
  sw.innerHTML = teams.length
    ? teams.map(t => '<option value="'+esc(t.id)+'"'+(t.id===curTeam?' selected':'')+'>'+esc(t.name)+' ('+t.memberCount+')</option>').join('')
    : '<option>（无团队）</option>';
  sw.onchange = async () => {
    const r = await jpost('/api/team/switch', { teamId: sw.value });
    if (r.body?.ok) showApp(); else { alert('切换失败：' + esc(r.body?.error || r.status)); showApp(); }
  };
  $('btn-newteam').onclick = async () => {
    const name = prompt('新团队名称：'); if (!name || !name.trim()) return;
    const r = await jpost('/api/team/create', { name: name.trim() });
    if (r.body?.ok) showApp(); else alert('创建失败：' + esc(r.body?.error || r.status));
  };
  $('btn-jointeam').onclick = async () => {
    const code = prompt('输入团队邀请码：'); if (!code || !code.trim()) return;
    const r = await jpost('/api/team/join', { code: code.trim() });
    if (r.body?.ok) showApp(); else alert('加入失败：' + esc(r.body?.error || r.status));
  };

  // Kicked from the active team but still in others → hop to one automatically.
  if (me.body?.currentTeamValid === false && teams.length > 0) {
    await jpost('/api/team/switch', { teamId: teams[0].id });
    return showApp();
  }
  // In no team at all: show only the account-level controls + a notice. Skip the
  // resource fetches (they'd 403 on an invalid active team).
  if (teams.length === 0) {
    $('team-meta').textContent = '你当前不属于任何团队 — 创建一个团队，或用邀请码加入。';
    ['roster','connectors','logs','members'].forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
    $('rf-count').textContent = ''; rosterBots = []; picked.clear();
    $('btn-delteam').classList.add('hide');
    return;
  }
  // Valid current team → expose 删除团队 (drops members/invites; bots unaffected).
  $('btn-delteam').classList.remove('hide');
  $('btn-delteam').onclick = async () => {
    const tn = me.body?.teamName || '当前团队';
    if (!confirm('删除团队「' + tn + '」？\\n该团队的成员关系和邀请将被清除；机器人、接入点不受影响，无法撤销。')) return;
    const resp = await fetch('/api/team', { method: 'DELETE' });
    const j = await resp.json().catch(() => ({}));
    if (resp.ok && j.ok) showApp(); else alert('删除失败：' + (j.error || resp.status));
  };

  const r = await jget('/api/team/roster');
  const t = r.body || {};
  $('team-meta').textContent = (t.team?.name || '') + ' · ' + (t.team?.memberCount ?? 0) + ' 名成员';
  rosterBots = t.bots || [];
  const clis = Array.from(new Set(rosterBots.map(b => b.cliId).filter(Boolean))).sort();
  $('rf-cli').innerHTML = '<option value="">全部 CLI</option>' + clis.map(c => '<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');
  renderRoster();

  const c = await jget('/api/team/connectors');
  $('connectors').innerHTML = (c.body?.connectors||[]).map(x =>
    '<tr><td>'+esc(x.name)+'</td><td class="muted">'+esc(x.source?.type||x.source||'')+'</td><td>'+esc(x.target?.mode||'')+'</td><td>'+(x.enabled?'<span class=ok>开</span>':'<span class=muted>关</span>')+'</td>'
    +'<td><button class="conn-act" data-id="'+esc(x.id)+'" data-act="toggle" data-en="'+(x.enabled?'1':'0')+'">'+(x.enabled?'停用':'启用')+'</button> '
    +'<button class="conn-act" data-id="'+esc(x.id)+'" data-act="rotate">旋转密钥</button> '
    +'<button class="conn-act" data-id="'+esc(x.id)+'" data-act="del">删除</button></td></tr>'
  ).join('') || '<tr><td colspan=5 class=muted>还没有接入点</td></tr>';
  document.querySelectorAll('.conn-act').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id, act = btn.dataset.act;
      if (act === 'toggle') {
        await fetch('/api/team/connectors/'+encodeURIComponent(id), { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({ enabled: btn.dataset.en !== '1' }) });
      } else if (act === 'rotate') {
        const r = await jput('/api/team/connectors/'+encodeURIComponent(id), { rotateSecret: true });
        if (r.body?.secret) { $('conn-out').classList.remove('hide'); $('conn-out').innerHTML = '<p class="hint">新 Secret（只显示这一次）：</p><p><span class="code" style="font-size:13px;word-break:break-all">'+esc(r.body.secret)+'</span></p>'; }
      } else if (act === 'del') {
        if (!confirm('删除该接入点?')) return;
        await fetch('/api/team/connectors/'+encodeURIComponent(id), { method:'DELETE' });
      }
      showApp();
    };
  });

  const l = await jget('/api/team/trigger-logs?limit=20');
  $('logs').innerHTML = (l.body?.logs||[]).map(x =>
    '<tr><td class="muted">'+esc((x.createdAt||'').replace('T',' ').slice(0,19))+'</td><td>'+esc(x.connectorId||'—')+'</td><td class="'+(x.status==='ok'?'ok':'err')+'">'+esc(x.action||x.status)+'</td><td class="err">'+esc(x.errorCode||'')+'</td></tr>'
  ).join('') || '<tr><td colspan=4 class=muted>暂无触发记录</td></tr>';

  const m = await jget('/api/team/members');
  const members = m.body?.members || [];
  $('members-meta').textContent = '· ' + members.length + ' 人';
  $('members').innerHTML = members.map(x =>
    '<tr><td>'+esc(x.name||'(未知)')+'</td><td class="muted">'+esc(x.openId||'')+'</td><td><button class="rmmember" data-uid="'+esc(x.unionId||'')+'" data-oid="'+esc(x.openId||'')+'">移除</button></td></tr>'
  ).join('') || '<tr><td colspan=3 class=muted>暂无成员</td></tr>';
  document.querySelectorAll('.rmmember').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('从团队移除该成员?')) return;
      const r = await fetch('/api/team/members', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ unionId: btn.dataset.uid, openId: btn.dataset.oid }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const msg = ({ cannot_delete_self: '不能移除自己。若你是唯一成员、想解散团队，请用右上角「删除团队」。', cannot_delete_last: '这是团队最后一名成员，不能移除；如需解散请用「删除团队」。' })[j.error] || ('移除失败：' + (j.error || r.status));
        alert(msg); return;
      }
      showApp();
    };
  });
  $('btn-invite').onclick = async () => {
    const r = await jpost('/api/team/invite');
    if (r.body?.code) {
      const url = location.origin + '/team?invite=' + encodeURIComponent(r.body.code);
      $('invite-out').classList.remove('hide');
      $('invite-out').innerHTML = '<p class="hint">把邀请码或链接发给对方(24 小时内、单次有效):</p><p><span class="code" style="font-size:18px">'+esc(r.body.code)+'</span></p><p class="hint" style="word-break:break-all">链接: '+esc(url)+'</p>';
    }
  };
}

function showLogin(){ $('app').classList.add('hide'); $('login').classList.remove('hide'); }

async function openRoleModal(app, name){
  if (!app) { alert('该机器人无 app id，无法设置团队角色'); return; }
  const r = await jget('/api/team/bots/' + encodeURIComponent(app) + '/role');
  $('modal-title').textContent = '团队角色 · ' + name;
  $('modal-text').value = r.body?.role || '';
  $('modal').dataset.app = app;
  $('modal').classList.remove('hide');
}
$('modal-cancel').onclick = () => $('modal').classList.add('hide');
$('modal-save').onclick = async () => {
  const app = $('modal').dataset.app;
  await jput('/api/team/bots/' + encodeURIComponent(app) + '/role', { role: $('modal-text').value });
  $('modal').classList.add('hide');
  showApp();
};

function syncConnFields(){
  const mode = $('cn-mode').value, kind = $('cn-kind').value;
  $('cn-chat-l').style.display = mode === 'fixed' ? '' : 'none';
  $('cn-allow-l').style.display = mode === 'dynamic' ? '' : 'none';
  $('cn-wf-l').style.display = kind === 'workflow' ? '' : 'none';
  $('cn-dedup-l').style.display = $('cn-status-l').style.display = mode === 'new-group' ? '' : 'none';
}
async function openConnModal(){
  const r = await jget('/api/team/roster');
  $('cn-bot').innerHTML = (r.body?.bots||[]).map(b => '<option value="'+esc(b.larkAppId)+'">'+esc(b.name)+'</option>').join('');
  $('connmodal-err').textContent = ''; syncConnFields(); $('connmodal').classList.remove('hide');
}
$('cn-mode').onchange = syncConnFields; $('cn-kind').onchange = syncConnFields;
$('btn-newconn').onclick = openConnModal;
$('btn-claim').onclick = async () => {
  const apps = [...picked];
  $('grp-out').classList.remove('hide');
  if (apps.length === 0) { $('grp-out').innerHTML = '<span class="err">请先勾选要归到自己名下的机器人</span>'; return; }
  let fail = 0;
  for (const app of apps) { const r = await fetch('/api/team/bots/' + encodeURIComponent(app) + '/owner', { method: 'POST' }); if (!r.ok) fail++; }
  picked.clear();
  $('grp-out').innerHTML = fail
    ? '<span class="err">' + (apps.length - fail) + ' 个成功，' + fail + ' 个失败（可能会话过期，请刷新重登）</span>'
    : '<span class="ok">已把 ' + apps.length + ' 个机器人归到你名下</span>';
  await showApp(); // refetch → re-group by owner
};
$('btn-group').onclick = async () => {
  const apps = [...picked]; // only currently-visible selected bots (hidden rows pruned from the Set)
  $('grp-out').classList.remove('hide');
  if (apps.length === 0) { $('grp-out').innerHTML = '<span class="err">请先在上方勾选至少一个机器人</span>'; return; }
  const name = $('grp-name').value.trim() || '协作群';
  $('grp-out').innerHTML = '<span class="muted">建群中…</span>';
  const r = await jpost('/api/team/group', { name, larkAppIds: apps });
  if (r.body?.ok && r.body.chatId) {
    const applink = 'https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(r.body.chatId);
    const inv = [];
    if ((r.body.invalidBotIds||[]).length) inv.push('未能加入的机器人: ' + r.body.invalidBotIds.join(', '));
    if ((r.body.invalidUserIds||[]).length) inv.push('未能加入的用户: ' + r.body.invalidUserIds.join(', '));
    const selfNote = r.body.autoInviteUnavailable ? '<p class="hint err">你未被自动拉入（你配对的机器人不在所选机器人里或不在线）。请让群内的机器人或成员把你拉进去。</p>' : '';
    $('grp-out').innerHTML = '<span class="ok">群已创建</span> · <a href="' + applink + '" target="_blank">在飞书打开</a> <span class="muted">(' + esc(r.body.chatId) + ')</span>' + selfNote + (inv.length ? '<p class="hint err">' + esc(inv.join('；')) + '</p>' : '');
  } else {
    $('grp-out').innerHTML = '<span class="err">建群失败：' + esc(r.body?.error || r.status) + '</span>';
  }
};
$('connmodal-cancel').onclick = () => $('connmodal').classList.add('hide');
$('connmodal-save').onclick = async () => {
  const mode = $('cn-mode').value, kind = $('cn-kind').value, name = $('cn-name').value.trim();
  if (!name) { $('connmodal-err').textContent = '请填名称'; return; }
  const target = { kind, mode, botId: $('cn-bot').value };
  if (mode === 'fixed') target.chatId = $('cn-chat').value.trim();
  if (mode === 'dynamic' && $('cn-allow').value.trim()) target.allowChats = $('cn-allow').value.split(',').map(s=>s.trim()).filter(Boolean);
  if (kind === 'workflow') target.workflowId = $('cn-wf').value.trim();
  const body = { name, source: { type: $('cn-source').value }, target, promptEnvelope: { sourceName: name },
    lifecycleExtractors: mode === 'new-group' ? { dedupKey: $('cn-dedup').value.trim(), status: $('cn-status').value.trim() } : null };
  if ($('cn-secret').value.trim()) body.secret = $('cn-secret').value.trim();
  const r = await jpost('/api/team/connectors', body);
  if (r.status === 201 || r.body?.ok) {
    const id = r.body?.connector?.id; const wurl = r.body?.webhookUrl || (location.origin + '/webhook/' + id);
    $('connmodal').classList.add('hide'); $('conn-out').classList.remove('hide');
    $('conn-out').innerHTML = '<p class="hint">接入点已创建。Webhook URL：</p><p><span class="code" style="font-size:13px;word-break:break-all">'+esc(wurl)+'</span></p>'
      + (r.body?.secret ? '<p class="hint">Secret（只显示这一次，务必保存）：</p><p><span class="code" style="font-size:13px;word-break:break-all">'+esc(r.body.secret)+'</span></p>' : '');
    showApp();
  } else { $('connmodal-err').textContent = '创建失败：' + esc(r.body?.error || r.status); }
};

$('btn-start').onclick = async () => {
  $('login-err').textContent = '';
  const r = await jpost('/api/pairing/start');
  if (!r.body?.code) { $('login-err').textContent = '发起登录失败，请重试。'; return; }
  const pairingId = r.body.pairingId, code = r.body.code;
  $('pair-cmd').textContent = '/pair ' + code;
  $('login-start').classList.add('hide'); $('login-code').classList.remove('hide');
  pollTimer = setInterval(async () => {
    const s = await jget('/api/pairing/status?pairingId=' + encodeURIComponent(pairingId));
    if (s.body?.status === 'claimed') {
      $('pair-status').textContent = '已确认（' + esc(s.body.name||'') + '），正在登录…';
      clearInterval(pollTimer);
      const inviteCode = (($('invite-code')||{}).value || new URLSearchParams(location.search).get('invite') || '').trim();
      const c = await jpost('/api/pairing/consume', { pairingId, inviteCode });
      if (c.status === 200) showApp();
      else if (c.body?.reason === 'not_a_member') { $('login-code').classList.add('hide'); $('login-start').classList.remove('hide'); $('login-err').textContent = '你不在该团队中，请联系团队成员把你加入。'; }
      else { $('login-code').classList.add('hide'); $('login-start').classList.remove('hide'); $('login-err').textContent = '登录失败（' + esc(c.body?.reason||'') + '），请重试。'; }
    } else if (s.body?.status === 'not_found') {
      clearInterval(pollTimer); $('login-code').classList.add('hide'); $('login-start').classList.remove('hide'); $('login-err').textContent = '配对码已过期，请重新开始。';
    }
  }, 2000);
};

(async () => {
  const qi = new URLSearchParams(location.search).get('invite');
  if (qi && $('invite-code')) $('invite-code').value = qi;
  const me = await jget('/api/team/me');
  if (me.status === 200 && me.body?.ok) showApp(); else showLogin();
})();
</script>
</body>
</html>`;
