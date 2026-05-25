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
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, "PingFang SC", sans-serif; margin: 0; background: #f6f7f9; color: #1f2329; }
  header { padding: 14px 20px; background: #1f2329; color: #fff; display: flex; justify-content: space-between; align-items: center; }
  header b { font-size: 16px; }
  main { max-width: 920px; margin: 0 auto; padding: 20px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: #4e5969; }
  .code { font: 28px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 4px; background: #f2f3f5; padding: 12px 16px; border-radius: 8px; display: inline-block; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #d0d3d9; background: #fff; cursor: pointer; }
  button.primary { background: #3370ff; color: #fff; border-color: #3370ff; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0f1f3; }
  th { color: #86909c; font-weight: 500; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #e8f3ff; color: #3370ff; }
  .muted { color: #86909c; }
  .ok { color: #00b42a; } .err { color: #f53f3f; }
  .hide { display: none; }
  .hint { color: #86909c; font-size: 13px; margin-top: 8px; }
  input.capedit { font: inherit; width: 92%; padding: 4px 8px; border: 1px solid #e5e6eb; border-radius: 6px; }
  input.capedit:focus { border-color: #3370ff; outline: none; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
  /* .overlay sets display:flex; this compound selector must win over it so a
     hidden overlay stays hidden (plain .hide has equal specificity and loses
     to the later .overlay rule). */
  .overlay.hide { display: none; }
  .modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: min(560px, 92vw); }
  .modal textarea { width: 100%; min-height: 200px; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 10px; border: 1px solid #e5e6eb; border-radius: 8px; box-sizing: border-box; }
  .modal .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
</head>
<body>
<header><b>botmux 团队平台</b><span id="who"></span></header>
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
      <table><thead><tr><th></th><th>机器人</th><th>CLI</th><th>能力标签</th><th>团队角色</th></tr></thead>
        <tbody id="roster"></tbody></table>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="grp-name" placeholder="群名（如：支付排障）" style="font:inherit;padding:6px 10px;border:1px solid #d0d3d9;border-radius:8px">
        <button class="primary" id="btn-group">把勾选的机器人拉一个群</button>
        <span class="hint">勾选上方机器人 → 自动建群并把你也拉进去</span>
      </div>
      <div id="grp-out" class="hide" style="margin-top:8px"></div>
    </section>
    <section class="card">
      <h2>团队成员 <span class="muted" id="members-meta"></span>
        <button class="primary" id="btn-invite" style="float:right;font-size:13px;padding:4px 12px">邀请成员</button></h2>
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
async function jget(u){ const r = await fetch(u); return { status:r.status, body: await r.json().catch(()=>({})) }; }
async function jpost(u, b){ const r = await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined}); return { status:r.status, body: await r.json().catch(()=>({})) }; }
async function jput(u, b){ const r = await fetch(u,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}); return { status:r.status, body: await r.json().catch(()=>({})) }; }

let pollTimer = null;

async function showApp(){
  $('login').classList.add('hide'); $('app').classList.remove('hide');
  const me = await jget('/api/team/me');
  $('who').textContent = me.body?.user?.name ? me.body.user.name + ' · 退出' : '退出';
  $('who').style.cursor = 'pointer';
  $('who').onclick = async () => { await jpost('/api/team/logout'); location.reload(); };

  const r = await jget('/api/team/roster');
  const t = r.body || {};
  $('team-meta').textContent = (t.team?.name || '') + ' · ' + (t.team?.memberCount ?? 0) + ' 名成员';
  $('roster').innerHTML = (t.bots||[]).map(b => {
    const app = esc(b.larkAppId || '');
    return '<tr><td>'+(app?'<input type="checkbox" class="botpick" data-app="'+app+'">':'')+'</td><td>'+esc(b.name)+'</td><td class="muted">'+esc(b.cliId)+'</td>'
      + '<td><input class="capedit" data-app="'+app+'" value="'+esc(b.capability||'')+'" placeholder="能力标签…"></td>'
      + '<td><button class="roleedit" data-app="'+app+'" data-name="'+esc(b.name)+'">'+(b.hasTeamRole?'已设·改':'设置')+'</button></td></tr>';
  }).join('') || '<tr><td colspan=5 class=muted>暂无机器人</td></tr>';
  document.querySelectorAll('.capedit').forEach(inp => {
    inp.onchange = async () => { await jput('/api/team/bots/'+encodeURIComponent(inp.dataset.app)+'/capability', { capability: inp.value }); };
  });
  document.querySelectorAll('.roleedit').forEach(btn => {
    btn.onclick = () => openRoleModal(btn.dataset.app, btn.dataset.name);
  });

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
      await fetch('/api/team/members', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ unionId: btn.dataset.uid, openId: btn.dataset.oid }) });
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
$('btn-group').onclick = async () => {
  const apps = Array.from(document.querySelectorAll('.botpick')).filter(cb => cb.checked).map(cb => cb.dataset.app);
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
