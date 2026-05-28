// Connectors (webhook 接入点) page: let external systems (alerts / CI / tickets…)
// trigger a bot via an inbound webhook. Lists connectors + a clean create form.
// All webhook sources are treated uniformly (no source-type). Dashboard-token
// authed (cookie). Backend: handleConnectorApi (/api/connectors*).
import { escapeHtml } from './ui.js';

interface Connector {
  id: string; name: string; enabled: boolean;
  target: { mode: 'dynamic' | 'fixed' | 'new-group'; kind: 'turn' | 'workflow'; botId: string; chatId?: string; allowChats?: string[]; workflowId?: string };
  promptEnvelope: { sourceName: string };
}
interface BotOpt { larkAppId: string; botName: string; }

async function jget(u: string) { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({} as any)) }; }
async function jsend(method: string, u: string, b?: unknown) {
  const r = await fetch(u, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}
function $(id: string): HTMLElement { return document.getElementById(id)!; }
function val(id: string): string { return (($(id) as HTMLInputElement).value || '').trim(); }

let bots: BotOpt[] = [];

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">接入点 · beta</p>
    <h1>接入点（Webhook）<span class="muted" style="font-size:14px;font-weight:400">beta</span></h1>
    <p>让外部系统（监控告警、CI、工单…）通过一个 webhook 触发机器人在群里说话或跑工作流。<span class="muted">（beta：尚未充分测试，欢迎反馈）</span></p>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">新建接入点</h2>
  <div class="cn-form" style="display:grid;grid-template-columns:140px 1fr;gap:10px 14px;align-items:center;max-width:680px">
    <label>名称</label><input id="cn-name" placeholder="如：线上告警">
    <label>触发的机器人</label><select id="cn-bot"></select>
    <label>触发方式</label>
    <select id="cn-kind"><option value="turn">单轮对话（让机器人回应一次）</option><option value="workflow">工作流</option></select>
    <label class="cn-wf" style="display:none">工作流 ID</label><input class="cn-wf" id="cn-wf" style="display:none" placeholder="workflowId">
    <label>投递到哪个群</label>
    <select id="cn-mode">
      <option value="dynamic">由请求指定（群 ID 随请求传入）</option>
      <option value="fixed">固定群</option>
      <option value="new-group">每次新建群</option>
    </select>
    <label class="cn-fixed" style="display:none">群 ID</label><input class="cn-fixed" id="cn-chat" style="display:none" placeholder="oc_…">
    <label class="cn-allow">允许的群<span class="muted" style="font-weight:400">（可选）</span></label>
    <input class="cn-allow" id="cn-allow" placeholder="oc_xxx,oc_yyy（逗号分隔，留空=不限）">
    <label class="cn-life" style="display:none">去重字段</label><input class="cn-life" id="cn-dedup" style="display:none" placeholder="如 payload.alert.id">
    <label class="cn-life" style="display:none">状态字段</label><input class="cn-life" id="cn-status" style="display:none" placeholder="如 payload.status">
    <label>签名密钥</label><input id="cn-secret" placeholder="留空自动生成（只显示一次）">
  </div>
  <div style="margin-top:14px"><button id="cn-create" class="primary">创建</button>
    <span class="muted" id="cn-create-out" style="margin-left:10px;font-size:13px"></span></div>
  <div id="cn-created" style="display:none;margin-top:12px"></div>
</div>

<div class="card">
  <h2 style="margin-top:0">已有接入点 <span class="muted" id="cn-count" style="font-size:13px"></span></h2>
  <div id="cn-list">加载中…</div>
</div>
</section>`;
}

function syncFormVisibility(): void {
  const kind = ($('cn-kind') as HTMLSelectElement).value;
  const mode = ($('cn-mode') as HTMLSelectElement).value;
  document.querySelectorAll<HTMLElement>('.cn-wf').forEach(e => { e.style.display = kind === 'workflow' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-fixed').forEach(e => { e.style.display = mode === 'fixed' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-allow').forEach(e => { e.style.display = mode === 'fixed' ? 'none' : ''; });
  document.querySelectorAll<HTMLElement>('.cn-life').forEach(e => { e.style.display = mode === 'new-group' ? '' : 'none'; });
}

function webhookUrl(id: string): string { return `${location.origin}/webhook/${encodeURIComponent(id)}`; }

function modeLabel(m: string): string { return m === 'fixed' ? '固定群' : m === 'new-group' ? '每次新建群' : '请求指定群'; }
function kindLabel(k: string): string { return k === 'workflow' ? '工作流' : '单轮'; }

function renderList(connectors: Connector[]): void {
  const el = $('cn-list');
  $('cn-count').textContent = connectors.length ? `· ${connectors.length} 个` : '';
  if (!connectors.length) { el.innerHTML = '<p class="muted">还没有接入点。用上面的表单创建一个。</p>'; return; }
  el.innerHTML = connectors.map(c => {
    const bot = bots.find(b => b.larkAppId === c.target.botId);
    const url = webhookUrl(c.id);
    return `<div class="card" style="margin:0 0 10px;padding:12px 14px;background:var(--bg-soft,#f6f7f9)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-size:15px">${escapeHtml(c.name)}</b>
        <span class="${c.enabled ? 'ok' : 'muted'}" style="font-size:12px">${c.enabled ? '已启用' : '已停用'}</span>
        <span class="muted" style="font-size:12px">· ${escapeHtml(bot?.botName || c.target.botId)} · ${kindLabel(c.target.kind)} · ${modeLabel(c.target.mode)}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="cn-toggle ghost" data-id="${escapeHtml(c.id)}" data-on="${c.enabled}" style="font-size:12px">${c.enabled ? '停用' : '启用'}</button>
          <button class="cn-del ghost" data-id="${escapeHtml(c.id)}" style="font-size:12px">删除</button>
        </span>
      </div>
      <div style="margin-top:6px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="muted">Webhook URL：</span><code style="font-size:12px;word-break:break-all">${escapeHtml(url)}</code>
        <button class="cn-copy ghost" data-url="${escapeHtml(url)}" style="font-size:12px">复制</button>
      </div></div>`;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('.cn-copy').forEach(b => { b.onclick = () => { navigator.clipboard?.writeText(b.dataset.url!); b.textContent = '已复制'; setTimeout(() => b.textContent = '复制', 1200); }; });
  el.querySelectorAll<HTMLButtonElement>('.cn-toggle').forEach(b => {
    b.onclick = async () => { await jsend('PATCH', '/api/connectors/' + encodeURIComponent(b.dataset.id!), { enabled: b.dataset.on !== 'true' }); load(); };
  });
  el.querySelectorAll<HTMLButtonElement>('.cn-del').forEach(b => {
    b.onclick = async () => { if (!confirm('删除这个接入点？它的 webhook URL 会立即失效。')) return; await jsend('DELETE', '/api/connectors/' + encodeURIComponent(b.dataset.id!)); load(); };
  });
}

async function load(): Promise<void> {
  const [bl, cl] = await Promise.all([jget('/api/bots'), jget('/api/connectors')]);
  bots = (bl.body?.bots || []).map((b: any) => ({ larkAppId: b.larkAppId, botName: b.botName || b.larkAppId }));
  const sel = $('cn-bot') as HTMLSelectElement; const cur = sel.value;
  sel.innerHTML = bots.map(b => `<option value="${escapeHtml(b.larkAppId)}">${escapeHtml(b.botName)}</option>`).join('') || '<option value="">（没有在线机器人）</option>';
  if (cur) sel.value = cur;
  renderList(cl.body?.connectors || []);
}

export function renderConnectorsPage(root: HTMLElement): void {
  root.innerHTML = pageHtml();
  ($('cn-kind') as HTMLSelectElement).onchange = syncFormVisibility;
  ($('cn-mode') as HTMLSelectElement).onchange = syncFormVisibility;
  syncFormVisibility();

  $('cn-create').onclick = async () => {
    const out = $('cn-create-out');
    const name = val('cn-name');
    const botId = ($('cn-bot') as HTMLSelectElement).value;
    if (!name) { out.innerHTML = '<span class="err">请填名称</span>'; return; }
    if (!botId) { out.innerHTML = '<span class="err">请选机器人</span>'; return; }
    const kind = ($('cn-kind') as HTMLSelectElement).value;
    const mode = ($('cn-mode') as HTMLSelectElement).value;
    const body: any = {
      name, enabled: true,
      target: { kind, mode, botId },
      promptEnvelope: { sourceName: name },
    };
    if (kind === 'workflow') { if (!val('cn-wf')) { out.innerHTML = '<span class="err">请填工作流 ID</span>'; return; } body.target.workflowId = val('cn-wf'); }
    if (mode === 'fixed') { if (!val('cn-chat')) { out.innerHTML = '<span class="err">固定群需要填群 ID</span>'; return; } body.target.chatId = val('cn-chat'); }
    else { const allow = val('cn-allow'); if (allow) body.target.allowChats = allow.split(',').map(s => s.trim()).filter(Boolean); }
    if (mode === 'new-group') {
      if (!val('cn-dedup') || !val('cn-status')) { out.innerHTML = '<span class="err">「每次新建群」需要填去重字段和状态字段</span>'; return; }
      body.lifecycleExtractors = { dedupKey: val('cn-dedup'), status: val('cn-status') };
    }
    const secret = val('cn-secret'); if (secret) body.secret = secret;
    out.innerHTML = '<span class="muted">创建中…</span>';
    const r = await jsend('POST', '/api/connectors', body);
    if (r.status === 201 && r.body?.ok) {
      out.innerHTML = '';
      const created = $('cn-created'); created.style.display = '';
      const url = r.body.webhookUrl || webhookUrl(r.body.connector.id);
      const sec = r.body.secret;
      created.innerHTML = `<div class="card" style="padding:12px 14px;background:var(--bg-soft,#f6f7f9)">
        <p class="ok" style="margin:0 0 6px">已创建「${escapeHtml(name)}」</p>
        <p style="margin:4px 0;font-size:13px"><span class="muted">Webhook URL：</span><code style="word-break:break-all">${escapeHtml(url)}</code></p>
        ${sec ? `<p style="margin:4px 0;font-size:13px"><span class="muted">签名密钥（只显示这一次，请保存）：</span><code>${escapeHtml(sec)}</code></p>` : ''}
        <p class="muted" style="font-size:12px;margin:6px 0 0">外部系统用此 URL + 密钥（HMAC-SHA256 签名）调用即可触发。</p></div>`;
      (['cn-name', 'cn-wf', 'cn-chat', 'cn-allow', 'cn-dedup', 'cn-status', 'cn-secret'] as const).forEach(id => { ($(id) as HTMLInputElement).value = ''; });
      load();
    } else {
      const e = r.body?.error || r.status;
      out.innerHTML = `<span class="err">创建失败：${escapeHtml(String(e))}</span>`;
    }
  };

  void load();
}
