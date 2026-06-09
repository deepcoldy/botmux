// Connectors (Webhook) page: let external systems (alerts / CI / tickets…)
// trigger a bot via an inbound webhook. Lists connectors + a clean create form.
// All webhook sources are treated uniformly (no source-type). Dashboard-token
// authed (cookie). Backend: handleConnectorApi (/api/connectors*).
import { escapeHtml, t } from './ui.js';

interface Connector {
  id: string; name: string; enabled: boolean;
  verify?: { type: 'token' | 'hmac-sha256' };
  target: { mode: 'dynamic' | 'fixed' | 'new-group'; kind: 'turn' | 'workflow'; botId: string; chatId?: string; allowChats?: string[]; workflowId?: string };
  promptEnvelope: { sourceName: string; instruction?: string };
}
interface BotOpt { larkAppId: string; botName: string; }
interface GroupOpt { chatId: string; name: string; bots: string[] }

async function jget(u: string) { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({} as any)) }; }
async function jsend(method: string, u: string, b?: unknown) {
  const r = await fetch(u, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}
function $(id: string): HTMLElement { return document.getElementById(id)!; }
function val(id: string): string { return (($(id) as HTMLInputElement).value || '').trim(); }

let bots: BotOpt[] = [];
let groups: GroupOpt[] = [];

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">Webhook</p>
    <h1>Webhook</h1>
    <p>${t('connectors.lede')}</p>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">${t('connectors.createTitle')}</h2>
  <div class="cn-form" style="display:grid;grid-template-columns:140px 1fr;gap:10px 14px;align-items:center;max-width:680px">
    <label>${t('connectors.fName')}</label><input id="cn-name" placeholder="${t('connectors.fNamePh')}">
    <label>${t('connectors.fBot')}</label><select id="cn-bot"></select>
    <label>${t('connectors.fKind')}</label>
    <select id="cn-kind"><option value="turn">${t('connectors.kindTurn')}</option><option value="workflow">${t('connectors.kindWorkflow')}</option></select>
    <label class="cn-wf" style="display:none">${t('connectors.fWf')}</label><input class="cn-wf" id="cn-wf" style="display:none" placeholder="workflowId">
    <label>${t('connectors.fMode')}</label>
    <select id="cn-mode">
      <option value="dynamic">${t('connectors.modeDynamic')}</option>
      <option value="fixed">${t('connectors.modeFixed')}</option>
      <option value="new-group">${t('connectors.modeNewGroup')}</option>
    </select>
    <label class="cn-fixed" style="display:none">${t('connectors.fFixedChat')}</label>
    <div class="cn-fixed" style="display:none">
      <select id="cn-chat-sel" style="width:100%;box-sizing:border-box"></select>
      <input id="cn-chat" placeholder="${t('connectors.fChatManualPh')}" style="display:none;width:100%;box-sizing:border-box;margin-top:6px">
      <a href="#" id="cn-chat-manual" style="font-size:12px;display:inline-block;margin-top:4px">${t('connectors.chatManualLink')}</a>
    </div>
    <label class="cn-allow">${t('connectors.fAllow')}<span class="muted" style="font-weight:400">${t('connectors.optional')}</span></label>
    <div class="cn-allow">
      <select id="cn-allow-sel" multiple size="4" style="width:100%;box-sizing:border-box"></select>
      <div class="muted" style="font-size:12px;margin-top:4px">${t('connectors.allowHint')}</div>
    </div>
    <div class="cn-dyn" style="display:none;grid-column:1 / -1">
      <div class="muted" style="font-size:12px;line-height:1.7;background:var(--bg-soft,#f6f7f9);padding:8px 10px;border-radius:6px">
        ${t('connectors.dynamicHint')}
      </div>
    </div>
    <label class="cn-life" style="display:none">${t('connectors.fDedup')}<span class="muted" style="font-weight:400">${t('connectors.optional')}</span></label>
    <div class="cn-life" style="display:none">
      <input id="cn-dedup" placeholder="${t('connectors.fDedupPh')}" style="width:100%;box-sizing:border-box">
      <div class="muted" style="font-size:12px;margin-top:4px">${t('connectors.dedupHint')}</div>
    </div>
    <label style="align-self:start">${t('connectors.fInstruction')}<span class="muted" style="font-weight:400">${t('connectors.optional')}</span></label>
    <textarea id="cn-instruction" rows="3" placeholder="${t('connectors.fInstructionPh')}" style="width:100%;box-sizing:border-box;font-family:inherit;font-size:13px"></textarea>
    <label>${t('connectors.fVerify')}</label>
    <select id="cn-verify">
      <option value="token">${t('connectors.verifyToken')}</option>
      <option value="hmac-sha256">${t('connectors.verifyHmac')}</option>
    </select>
    <label>${t('connectors.fSecret')}</label><input id="cn-secret" placeholder="${t('connectors.fSecretPh')}">
  </div>
  <div style="margin-top:14px"><button id="cn-create" class="primary">${t('connectors.btnCreate')}</button>
    <span class="muted" id="cn-create-out" style="margin-left:10px;font-size:13px"></span></div>
  <div id="cn-created" style="display:none;margin-top:12px"></div>
</div>

<div class="card">
  <h2 style="margin-top:0">${t('connectors.listTitle')} <span class="muted" id="cn-count" style="font-size:13px"></span></h2>
  <div id="cn-list">${t('connectors.loading')}</div>
</div>
</section>`;
}

function syncFormVisibility(): void {
  const kind = ($('cn-kind') as HTMLSelectElement).value;
  const mode = ($('cn-mode') as HTMLSelectElement).value;
  document.querySelectorAll<HTMLElement>('.cn-wf').forEach(e => { e.style.display = kind === 'workflow' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-fixed').forEach(e => { e.style.display = mode === 'fixed' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-allow').forEach(e => { e.style.display = mode === 'fixed' ? 'none' : ''; });
  document.querySelectorAll<HTMLElement>('.cn-dyn').forEach(e => { e.style.display = mode === 'dynamic' ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.cn-life').forEach(e => { e.style.display = mode === 'new-group' ? '' : 'none'; });
}

function webhookUrl(id: string): string { return `${location.origin}/webhook/${encodeURIComponent(id)}`; }

function modeLabel(m: string): string { return m === 'fixed' ? t('connectors.modeLabelFixed') : m === 'new-group' ? t('connectors.modeLabelNewGroup') : t('connectors.modeLabelDynamic'); }
function kindLabel(k: string): string { return k === 'workflow' ? t('connectors.kindLabelWorkflow') : t('connectors.kindLabelTurn'); }

function groupName(chatId: string): string {
  const g = groups.find(x => x.chatId === chatId);
  return g?.name || chatId;
}

function botGroups(botId: string): GroupOpt[] {
  return groups.filter(g => g.bots.includes(botId));
}

// (Re)populate the fixed-group select + allowlist multi-select from the chats
// the currently-selected bot is a member of. Preserves prior selection.
function fillGroupPickers(): void {
  const botId = ($('cn-bot') as HTMLSelectElement).value;
  const gs = botGroups(botId);
  const opt = (g: GroupOpt) => `<option value="${escapeHtml(g.chatId)}">${escapeHtml(g.name || g.chatId)}</option>`;
  const sel = $('cn-chat-sel') as HTMLSelectElement;
  const prev = sel.value;
  sel.innerHTML = gs.length ? gs.map(opt).join('') : `<option value="">${t('connectors.noBotGroups')}</option>`;
  if (prev && gs.some(g => g.chatId === prev)) sel.value = prev;
  const asel = $('cn-allow-sel') as HTMLSelectElement;
  const prevAllow = new Set(Array.from(asel.selectedOptions).map(o => o.value));
  asel.innerHTML = gs.map(opt).join('');
  Array.from(asel.options).forEach(o => { if (prevAllow.has(o.value)) o.selected = true; });
}

function renderList(connectors: Connector[]): void {
  const el = $('cn-list');
  $('cn-count').textContent = connectors.length ? t('connectors.count', { count: connectors.length }) : '';
  if (!connectors.length) { el.innerHTML = `<p class="muted">${t('connectors.empty')}</p>`; return; }
  el.innerHTML = connectors.map(c => {
    const bot = bots.find(b => b.larkAppId === c.target.botId);
    const url = webhookUrl(c.id);
    const isToken = (c.verify?.type ?? 'token') === 'token';
    const verifyBadge = isToken ? t('connectors.badgeToken') : t('connectors.badgeSign');
    const destLabel = c.target.mode === 'fixed' && c.target.chatId
      ? ` · ${t('connectors.dest', { name: escapeHtml(groupName(c.target.chatId)) })}`
      : '';
    return `<div class="card" style="margin:0 0 10px;padding:12px 14px;background:var(--bg-soft,#f6f7f9)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-size:15px">${escapeHtml(c.name)}</b>
        <span class="${c.enabled ? 'ok' : 'muted'}" style="font-size:12px">${c.enabled ? t('connectors.enabled') : t('connectors.disabled')}</span>
        <span class="muted" style="font-size:12px">· ${escapeHtml(bot?.botName || c.target.botId)} · ${kindLabel(c.target.kind)} · ${modeLabel(c.target.mode)}${destLabel} · ${verifyBadge}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="cn-toggle ghost" data-id="${escapeHtml(c.id)}" data-on="${c.enabled}" style="font-size:12px">${c.enabled ? t('connectors.btnDisable') : t('connectors.btnEnable')}</button>
          <button class="cn-del ghost" data-id="${escapeHtml(c.id)}" style="font-size:12px">${t('connectors.btnDel')}</button>
        </span>
      </div>
      <div style="margin-top:6px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="muted">${t('connectors.webhookUrl')}</span><code style="font-size:12px;word-break:break-all">${escapeHtml(url)}${isToken ? '/&lt;token&gt;' : ''}</code>
        <button class="cn-copy ghost" data-url="${escapeHtml(url)}" style="font-size:12px">${t('connectors.copy')}</button>
      </div>${isToken ? `<div class="muted" style="font-size:12px;margin-top:4px">${t('connectors.tokenHint')}</div>` : ''}${c.target.mode === 'dynamic' ? `<div class="muted" style="font-size:12px;margin-top:4px">${t('connectors.dynamicReqHint')}</div>` : ''}${c.promptEnvelope?.instruction ? `<div class="muted" style="font-size:12px;margin-top:4px">${t('connectors.instructionPrefix')}${escapeHtml(c.promptEnvelope.instruction)}</div>` : ''}</div>`;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('.cn-copy').forEach(b => { b.onclick = () => { navigator.clipboard?.writeText(b.dataset.url!); b.textContent = t('connectors.copied'); setTimeout(() => b.textContent = t('connectors.copy'), 1200); }; });
  el.querySelectorAll<HTMLButtonElement>('.cn-toggle').forEach(b => {
    b.onclick = async () => { await jsend('PATCH', '/api/connectors/' + encodeURIComponent(b.dataset.id!), { enabled: b.dataset.on !== 'true' }); load(); };
  });
  el.querySelectorAll<HTMLButtonElement>('.cn-del').forEach(b => {
    b.onclick = async () => { if (!confirm(t('connectors.delConfirm'))) return; await jsend('DELETE', '/api/connectors/' + encodeURIComponent(b.dataset.id!)); load(); };
  });
}

async function load(): Promise<void> {
  const [bl, cl, gl] = await Promise.all([jget('/api/bots'), jget('/api/connectors'), jget('/api/groups')]);
  bots = (bl.body?.bots || []).map((b: any) => ({ larkAppId: b.larkAppId, botName: b.botName || b.larkAppId }));
  groups = (gl.body?.chats || []).map((c: any) => ({
    chatId: c.chatId,
    name: c.name || '',
    bots: (c.memberBots || []).filter((mb: any) => mb.inChat).map((mb: any) => mb.larkAppId),
  }));
  const sel = $('cn-bot') as HTMLSelectElement; const cur = sel.value;
  sel.innerHTML = bots.map(b => `<option value="${escapeHtml(b.larkAppId)}">${escapeHtml(b.botName)}</option>`).join('') || `<option value="">${t('connectors.noOnlineBots')}</option>`;
  if (cur) sel.value = cur;
  fillGroupPickers();
  renderList(cl.body?.connectors || []);
}

export function renderConnectorsPage(root: HTMLElement): void {
  root.innerHTML = pageHtml();
  ($('cn-kind') as HTMLSelectElement).onchange = syncFormVisibility;
  ($('cn-mode') as HTMLSelectElement).onchange = syncFormVisibility;
  ($('cn-bot') as HTMLSelectElement).onchange = fillGroupPickers;
  $('cn-chat-manual').onclick = (e) => {
    e.preventDefault();
    const inp = $('cn-chat') as HTMLInputElement;
    const sel = $('cn-chat-sel') as HTMLSelectElement;
    const showManual = inp.style.display === 'none';
    inp.style.display = showManual ? '' : 'none';
    sel.style.display = showManual ? 'none' : '';
    $('cn-chat-manual').textContent = showManual ? t('connectors.chatListLink') : t('connectors.chatManualLink');
  };
  syncFormVisibility();

  $('cn-create').onclick = async () => {
    const out = $('cn-create-out');
    const name = val('cn-name');
    const botId = ($('cn-bot') as HTMLSelectElement).value;
    if (!name) { out.innerHTML = `<span class="err">${t('connectors.errName')}</span>`; return; }
    if (!botId) { out.innerHTML = `<span class="err">${t('connectors.errBot')}</span>`; return; }
    const kind = ($('cn-kind') as HTMLSelectElement).value;
    const mode = ($('cn-mode') as HTMLSelectElement).value;
    const body: any = {
      name, enabled: true,
      target: { kind, mode, botId },
      promptEnvelope: { sourceName: name },
    };
    const instruction = val('cn-instruction');
    if (instruction) body.promptEnvelope.instruction = instruction;
    if (kind === 'workflow') { if (!val('cn-wf')) { out.innerHTML = `<span class="err">${t('connectors.errWf')}</span>`; return; } body.target.workflowId = val('cn-wf'); }
    if (mode === 'fixed') {
      const manualVisible = ($('cn-chat') as HTMLInputElement).style.display !== 'none';
      const chatId = manualVisible ? val('cn-chat') : ($('cn-chat-sel') as HTMLSelectElement).value;
      if (!chatId) { out.innerHTML = `<span class="err">${t('connectors.errChat')}</span>`; return; }
      body.target.chatId = chatId;
    } else {
      const picked = Array.from(($('cn-allow-sel') as HTMLSelectElement).selectedOptions).map(o => o.value).filter(Boolean);
      if (picked.length) body.target.allowChats = picked;
    }
    if (mode === 'new-group') {
      const dedup = val('cn-dedup');
      body.lifecycleExtractors = dedup ? { dedupKey: dedup } : null;
    }
    body.verify = { type: ($('cn-verify') as HTMLSelectElement).value };
    const secret = val('cn-secret'); if (secret) body.secret = secret;
    out.innerHTML = `<span class="muted">${t('connectors.creating')}</span>`;
    const r = await jsend('POST', '/api/connectors', body);
    if (r.status === 201 && r.body?.ok) {
      out.innerHTML = '';
      const created = $('cn-created'); created.style.display = '';
      const url = r.body.webhookUrl || webhookUrl(r.body.connector.id);
      const sec = r.body.secret;
      const isToken = (r.body.connector?.verify?.type ?? 'token') === 'token';
      const isDynamic = mode === 'dynamic';
      // For dynamic connectors the caller must pass a chat per request — build a
      // concrete example using a chosen allowed group (name shown for clarity).
      const exampleChat = isDynamic ? (body.target.allowChats?.[0] || '<chatId>') : '';
      const callUrl = isDynamic ? `${escapeHtml(url)}?chatId=${escapeHtml(exampleChat)}` : escapeHtml(url);
      let usage: string;
      if (isToken && isDynamic) {
        const gn = exampleChat !== '<chatId>' ? `（${escapeHtml(groupName(body.target.allowChats![0]))}）` : '';
        usage = `<p class="muted" style="font-size:12px;margin:6px 0 0">${t('connectors.usageDynamicLede', { gn })}</p>
        <pre style="margin:6px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-all"><code>curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'</code></pre>
        <p class="muted" style="font-size:12px;margin:6px 0 0">${t('connectors.usageDynamicNote')}</p>`;
      } else if (isToken) {
        usage = `<p class="muted" style="font-size:12px;margin:6px 0 0">${t('connectors.usageTokenLede')}</p>
        <pre style="margin:6px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-all"><code>curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'</code></pre>
        <p class="muted" style="font-size:12px;margin:6px 0 0">${t('connectors.usageTokenNote')}</p>`;
      } else {
        usage = `<p class="muted" style="font-size:12px;margin:6px 0 0">${t('connectors.usageHmac')}${isDynamic ? t('connectors.usageHmacDynamic') : ''}</p>`;
      }
      created.innerHTML = `<div class="card" style="padding:12px 14px;background:var(--bg-soft,#f6f7f9)">
        <p class="ok" style="margin:0 0 6px">${t('connectors.createdPrefix', { name: escapeHtml(name) })}${mode === 'fixed' && body.target.chatId ? `<span class="muted" style="font-weight:400;font-size:13px"> · ${t('connectors.createdDest', { name: escapeHtml(groupName(body.target.chatId)) })}</span>` : ''}</p>
        <p style="margin:4px 0;font-size:13px"><span class="muted">${t('connectors.webhookUrl')}</span><code style="word-break:break-all">${escapeHtml(url)}</code></p>
        ${sec ? `<p style="margin:4px 0;font-size:13px"><span class="muted">${isToken ? t('connectors.tokenLabel') : t('connectors.signLabel')}${t('connectors.secretOnce')}</span><code>${escapeHtml(sec)}</code></p>` : ''}
        ${usage}</div>`;
      (['cn-name', 'cn-wf', 'cn-chat', 'cn-dedup', 'cn-secret', 'cn-instruction'] as const).forEach(id => { ($(id) as HTMLInputElement).value = ''; });
      ($('cn-allow-sel') as HTMLSelectElement).selectedIndex = -1;
      load();
    } else {
      const e = r.body?.error || r.status;
      out.innerHTML = `<span class="err">${t('connectors.createFailed', { error: escapeHtml(String(e)) })}</span>`;
    }
  };

  void load();
}
