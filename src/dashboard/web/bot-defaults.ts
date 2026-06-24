// Bot Defaults page: per-bot configuration for "default oncall mode on new
// chats". Strictly per-bot (no chat × bot matrix here — that lives in the
// Groups & Bots tab). Saving here only affects NEW group chats first observed
// after the save; existing chats are left alone, and chats already auto-bound
// once stay user-controlled.
import { store } from './store.js';
import { botAvatarHtml, escapeHtml, loadNameMaps, loadingHtml, t } from './ui.js';

let cache: { bots: any[] } = { bots: [] };
let loadError: string | null = null;
// master-detail：左侧员工名册选中谁，右侧就渲染谁的档案
let selectedAppId: string | null = null;

export function displayCliId(bot: any, sessionFallback: string): string {
  return typeof bot?.cliId === 'string' && bot.cliId ? bot.cliId : sessionFallback;
}

type BotProfileRoleItem = {
  profileId: string;
  loaded?: boolean;
  loading?: boolean;
  content?: string | null;
  error?: string;
};
type BotProfileRoleState = {
  loaded: boolean;
  loading: boolean;
  error?: string;
  items: BotProfileRoleItem[];
};
const botProfileRoleCache = new Map<string, BotProfileRoleState>();

/** Fallback for old /api/bots payloads: infer from the bot's recent sessions. */
function cliIdOf(appId: string): string {
  let best: any = null;
  for (const s of store.sessions.values()) {
    if (s.larkAppId !== appId || !s.cliId) continue;
    if (!best || Number(s.lastMessageAt ?? 0) > Number(best.lastMessageAt ?? 0)) best = s;
  }
  return best?.cliId ?? '';
}

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">${t('nav.botDefaults')}</p>
    <h1>${t('botDefaults.title')}</h1>
    <p>${t('botDefaults.subtitle')}</p>
  </div>
</div>
<form id="bd-filters" class="filters sessions-filters">
  <input type="search" name="q" placeholder="${t('botDefaults.search')}" />
  <button type="button" id="bd-refresh">${t('botDefaults.refresh')}</button>
</form>
<div class="bd-layout">
  <aside id="bd-roster" class="bd-roster"></aside>
  <div id="bd-list" class="bd-detail"></div>
</div>
</section>`;
}

async function loadBots(): Promise<void> {
  try {
    const r = await fetch('/api/bots');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Common case: backend was upgraded on disk but the dashboard process
      // hasn't been restarted, so /api/bots isn't registered yet. Surface
      // that instead of throwing — the empty list area is what the user
      // sees as "blank page".
      loadError = body?.error
        ? `HTTP ${r.status}: ${body.error}${body.path ? ` (${body.path})` : ''}`
        : `HTTP ${r.status}`;
      cache = { bots: [] };
      return;
    }
    if (!body || !Array.isArray(body.bots)) {
      loadError = 'unexpected response shape (no `bots` array)';
      cache = { bots: [] };
      return;
    }
    loadError = null;
    cache = body;
  } catch (e: any) {
    loadError = e?.message ?? String(e);
    cache = { bots: [] };
  }
}

function fmtSince(since: number): string {
  if (!since) return '—';
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export async function renderBotDefaultsPage(root: HTMLElement) {
  root.innerHTML = pageHtml();
  const listEl = root.querySelector<HTMLElement>('#bd-list')!;
  const rosterEl = root.querySelector<HTMLElement>('#bd-roster')!;
  const form = root.querySelector<HTMLFormElement>('#bd-filters')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#bd-refresh')!;

  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    try {
      botProfileRoleCache.clear();
      await loadBots();
      rerender();
    } finally { refreshBtn.disabled = false; }
  };

  // 帮助文字默认折叠成一行；点说明文字本身展开/收起（preventDefault 拦掉
  // label 默认行为，避免一点说明就把开关也切了）。只绑一次，委托不随 rerender 重建。
  listEl.addEventListener('click', e => {
    const sm = (e.target as HTMLElement).closest<HTMLElement>('.toggle-tx small, small.bd-help');
    if (sm) {
      e.preventDefault();
      sm.classList.toggle('open');
    }
  });

  // /api/bots 要逐 daemon 探活，慢——先亮 loading 占住右侧详情区。
  listEl.innerHTML = loadingHtml();
  await loadBots();

  function rerender() {
    const f = new FormData(form);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const filtered = cache.bots.filter((b: any) =>
      !q ||
      (b.botName ?? '').toLowerCase().includes(q) ||
      (b.larkAppId ?? '').toLowerCase().includes(q),
    );
    if (loadError) {
      rosterEl.innerHTML = '';
      listEl.innerHTML = `<p class="hint-warn">无法加载 bot 列表：${escapeHtml(loadError)}<br>` +
        `常见原因：dashboard / daemon 进程还在跑旧代码，执行 <code>botmux restart</code> 后刷新。</p>`;
      return;
    }
    if (filtered.length === 0) {
      rosterEl.innerHTML = '';
      listEl.innerHTML = `<p class="empty">${t('botDefaults.empty')}</p>`;
      return;
    }
    if (!selectedAppId || !filtered.some((b: any) => b.larkAppId === selectedAppId)) {
      selectedAppId = filtered[0].larkAppId;
    }
    rosterEl.innerHTML = filtered.map(renderRosterItem).join('');
    rosterEl.querySelectorAll<HTMLElement>('.bd-roster-item').forEach(el => {
      el.onclick = () => {
        selectedAppId = el.dataset.appid!;
        rerender();
      };
    });
    const sel = filtered.find((b: any) => b.larkAppId === selectedAppId)!;
    listEl.innerHTML = renderBotCard(sel);
    wireCardHandlers();
  }

  function renderRosterItem(b: any): string {
    const name = b.botName ?? b.larkAppId;
    const cli = displayCliId(b, cliIdOf(b.larkAppId));
    const flag = b.defaultOncall?.enabled
      ? `<span class="bd-roster-flag">oncall</span>`
      : '';
    return `<div class="bd-roster-item${b.larkAppId === selectedAppId ? ' on' : ''}" data-appid="${escapeHtml(b.larkAppId)}" role="button" tabindex="0">
      ${botAvatarHtml({ name, larkAppId: b.larkAppId, size: 'sm' })}
      <div class="bd-roster-tx">
        <b>${escapeHtml(name)}</b>
        <span>${escapeHtml(cli || b.larkAppId.slice(0, 14))}</span>
      </div>
      ${flag}
    </div>`;
  }

  function renderBotCard(b: any): string {
    if (b.error) {
      return `<article class="bd-card bd-profile" data-appid="${escapeHtml(b.larkAppId)}">
        <header class="bd-profile-head">
          ${botAvatarHtml({ name: b.botName ?? b.larkAppId, larkAppId: b.larkAppId })}
          <div class="bd-profile-id"><strong>${escapeHtml(b.botName ?? b.larkAppId)}</strong>
          <code>${escapeHtml(b.larkAppId)}</code></div>
        </header>
        <p class="hint-warn-inline">查询失败：${escapeHtml(b.error)}</p>
      </article>`;
    }
    const def = b.defaultOncall ?? { enabled: false, workingDir: '', since: 0 };
    const enabled = !!def.enabled;
    const name = b.botName ?? b.larkAppId;
    const cli = displayCliId(b, cliIdOf(b.larkAppId));
    return `<article class="bd-card bd-profile" data-appid="${escapeHtml(b.larkAppId)}">
      <header class="bd-profile-head">
        ${botAvatarHtml({ name, larkAppId: b.larkAppId, dot: 'ok' })}
        <div class="bd-profile-id">
          <strong>${escapeHtml(name)}</strong>
          ${cli ? `<span class="mate-role">${escapeHtml(cli)}</span>` : ''}
          <code>${escapeHtml(b.larkAppId)}</code>
        </div>
        <div class="bd-profile-meta bd-meta">
          <small class="bd-meta-ok">● ${t('botDefaults.metaOnline')}</small>
          <small data-oncall-since>${t('botDefaults.lastEnabled')}: ${escapeHtml(fmtSince(def.since ?? 0))}</small>
          <small>${t('botDefaults.autobound', { count: b.autoboundChatCount ?? 0 })}</small>
        </div>
      </header>
      <div class="bd-body bd-grid">
        <section class="bd-tile">
          <section class="bd-section">
            <h3 class="bd-section-title">${t('botDefaults.sectionOncall')}</h3>
            <label class="toggle-row">
              <input type="checkbox" data-action="toggle" ${enabled ? 'checked' : ''}>
              <span class="switch" aria-hidden="true"></span>
              <span class="toggle-tx"><strong>${t('botDefaults.defaultOncall')}</strong>
              <small>${t('botDefaults.defaultOncallHelp')}。${t('botDefaults.warning')}</small></span>
            </label>
            <div class="bd-row">
              <label>
                <span>${t('botDefaults.workingDir')}</span>
                <input type="text" data-input="workingDir" placeholder="e.g. /root/iserver/botmux"
                  value="${escapeHtml(def.workingDir ?? '')}" ${enabled ? '' : 'disabled'}>
              </label>
            </div>
            <div class="actions">
              <button type="button" class="primary" data-action="save">${t('botDefaults.save')}</button>
              <span class="oncall-status" data-status></span>
            </div>
            ${renderAutoStartControls(b)}
          </section>
          ${renderSandboxSection(b)}
        </section>
        <section class="bd-tile">${renderRoleSection(b)}</section>
        <section class="bd-tile">${renderSessionModeSection(b)}${renderSessionCapSection(b)}${renderStartupCommandsSection(b)}${renderEnvSection(b)}</section>
        <section class="bd-tile">${renderCardBehaviorSection(b)}${renderBrandSection(b)}</section>
        <section class="bd-tile">${renderGrantSection(b)}</section>
      </div>
    </article>`;
  }

  // Team-level role editor (one role per bot, cross-chat). This is the
  // canonical place to EDIT the team role — the Team page only shows it
  // read-only. The role isn't part of the /api/bots payload, so it's fetched
  // once per bot via GET /api/team/local-bots/{app}/role and cached onto the
  // bot snapshot (b.teamRole) — the page re-renders on every search keystroke,
  // so caching avoids a fetch-per-keystroke storm. undefined = not loaded yet
  // (render disabled + lazy-load); string = loaded (render it directly).
  function renderRoleSection(b: any): string {
    const loaded = typeof b.teamRole === 'string';
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionRole')}</h3>
      <p class="bd-section-note">${t('botDefaults.roleHelp')}</p>
      <textarea data-input="teamRole" rows="6"
        placeholder="${escapeHtml(t('botDefaults.rolePlaceholder'))}"
        style="width:100%;box-sizing:border-box;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px"${loaded ? '' : ' disabled'}>${loaded ? escapeHtml(b.teamRole) : ''}</textarea>
      <div class="actions">
        <button type="button" class="primary" data-action="save-role"${loaded ? '' : ' disabled'}>${t('botDefaults.roleSave')}</button>
        <button type="button" data-action="delete-role"${loaded ? '' : ' disabled'}>${t('botDefaults.roleDelete')}</button>
        <span class="oncall-status" data-role-status></span>
      </div>
      <div class="bd-profile-roles" data-profile-roles>
        <h4 class="bd-subsection-title">${t('botDefaults.profileRoles')}</h4>
        <p class="bd-section-note">${t('botDefaults.profileRolesHelp')}</p>
        <div class="bd-profile-role-list" data-profile-role-list>${renderProfileRoleList(b.larkAppId)}</div>
      </div>
    </section>`;
  }

  function renderProfileRoleList(appId: string): string {
    const state = botProfileRoleCache.get(appId);
    if (!state || state.loading) return loadingHtml();
    if (state.error) return `<p class="hint-warn-inline">${escapeHtml(t('botDefaults.profileRolesLoadFailed', { error: state.error }))}</p>`;
    if (state.items.length === 0) return `<p class="empty">${t('botDefaults.profileRolesEmpty')}</p>`;
    return state.items.map(item => `
      <details class="bd-profile-role-entry" data-profile-id="${escapeHtml(item.profileId)}">
        <summary><code>${escapeHtml(item.profileId)}</code></summary>
        <div class="bd-profile-role-content" data-profile-role-body="${escapeHtml(item.profileId)}">
          ${renderProfileRoleContent(item)}
        </div>
      </details>
    `).join('');
  }

  function renderProfileRoleContent(item: BotProfileRoleItem): string {
    if (item.loading) return loadingHtml();
    if (item.error) return `<p class="hint-warn-inline">${escapeHtml(t('botDefaults.profileRoleDetailLoadFailed', { error: item.error }))}</p>`;
    if (!item.loaded) return `<p class="empty">${t('botDefaults.profileRoleClickToLoad')}</p>`;
    return `<pre>${escapeHtml(item.content ?? '')}</pre>`;
  }

  // brandLabel is null when unset (→ default botmux), '' when off, else custom.
  // The input shows the configured string ('' for both unset and off); a small
  // state line disambiguates which of the three the bot is currently in.
  function brandStateLabel(brand: string | null): string {
    if (brand == null) return t('botDefaults.brandStateDefault');
    return brand.trim() === '' ? t('botDefaults.brandStateOff') : t('botDefaults.brandStateCustom');
  }

  function renderBrandSection(b: any): string {
    const brand: string | null = b.brandLabel ?? null;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionBrand')}</h3>
      <div class="bd-row bd-brand">
        <label>
          <span>${t('botDefaults.brandLabel')}</span>
          <input type="text" data-input="brandLabel"
            placeholder="${escapeHtml(t('botDefaults.brandLabelPlaceholder'))}"
            value="${escapeHtml(brand ?? '')}">
        </label>
        <small data-brand-state>${escapeHtml(brandStateLabel(brand))}</small>
        <small class="bd-help">${t('botDefaults.brandLabelHelp')}</small>
        <div class="actions">
          <button type="button" class="primary" data-action="save-brand">${t('botDefaults.brandSave')}</button>
          <button type="button" data-action="reset-brand">${t('botDefaults.brandReset')}</button>
          <span class="oncall-status" data-brand-status></span>
        </div>
      </div>
    </section>`;
  }

  // Per-bot card-behaviour toggles. Each auto-saves on change (no explicit save
  // button — each checkbox PUTs immediately). Two are gated on the streaming-card
  // state: the writable-link toggle is moot WHILE the card is disabled; the
  // status-reactions toggle only matters WHILE the card is disabled (the ✋→✅
  // reactions only appear in card-off sessions), so it's editable only then.
  function renderCardBehaviorSection(b: any): string {
    const disableStreaming = b.disableStreamingCard === true;
    const silentReactions = b.silentTurnReactions === true;
    const writableLink = b.writableTerminalLinkInCard === true;
    const privateCard = b.privateCard === true;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionCard')}</h3>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-disable-streaming" ${disableStreaming ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.disableStreaming')}</strong>
        <small>${t('botDefaults.disableStreamingHelp')}</small></span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-silent-reactions" ${silentReactions ? 'checked' : ''} ${disableStreaming ? '' : 'disabled'}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.silentTurnReactions')}</strong>
        <small>${t('botDefaults.silentTurnReactionsHelp')}</small></span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-writable-link" ${writableLink ? 'checked' : ''} ${disableStreaming ? 'disabled' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.writableLink')}</strong>
        <small>${t('botDefaults.writableLinkHelp')}</small></span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-private-card" ${privateCard ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.privateCard')}</strong>
        <small>${t('botDefaults.privateCardHelp')}</small></span>
      </label>
      <div class="actions">
        <small data-card-pref-moot class="hint-warn-inline" ${disableStreaming ? '' : 'hidden'}>${t('botDefaults.writableLinkMoot')}</small>
        <span class="oncall-status" data-card-pref-status></span>
      </div>
    </section>`;
  }

  // 会话模式：私聊（p2pMode）+ 普通群（regularGroupReplyMode）两个默认会话方式
  // 放在同一板块，各自一个下拉、一改即保存。
  //   • p2pMode             → PUT /api/bots/:appId/p2p-mode（走 applyConfigField，与 /botconfig 同路径）
  //   • 普通群默认模式 mode  → PUT /api/bots/:appId/card-prefs 的 regularGroupReplyMode
  //                           （chat | new-topic | shared，默认 chat）
  // per-chat 的 /reply-mode 可覆盖此 per-bot 默认。
  function renderSessionModeSection(b: any): string {
    const p2p: string = b.p2pMode === 'chat' ? 'chat' : 'thread';
    const regular: string = (b.regularGroupReplyMode === 'new-topic' || b.regularGroupReplyMode === 'shared')
      ? b.regularGroupReplyMode : 'chat';
    const mention: string = (b.regularGroupMentionMode === 'topic' || b.regularGroupMentionMode === 'never')
      ? b.regularGroupMentionMode : 'always';
    const docMode: string = b.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only';
    const opt = (v: string, label: string) =>
      `<option value="${v}" ${regular === v ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const mopt = (v: string, label: string) =>
      `<option value="${v}" ${mention === v ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const dopt = (v: string, label: string) =>
      `<option value="${v}" ${docMode === v ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionSessionMode')}</h3>
      <div class="bd-row">
        <label>
          <span>${t('botDefaults.p2pMode')}</span>
          <select data-input="p2pMode">
            <option value="thread" ${p2p === 'chat' ? '' : 'selected'}>${escapeHtml(t('botDefaults.p2pThread'))}</option>
            <option value="chat" ${p2p === 'chat' ? 'selected' : ''}>${escapeHtml(t('botDefaults.p2pChat'))}</option>
          </select>
        </label>
        <small class="bd-help">${t('botDefaults.p2pHelp')}</small>
        <div class="actions">
          <span class="oncall-status" data-p2p-status></span>
        </div>
      </div>
      <div class="bd-row">
        <label>
          <span>${t('botDefaults.regularGroupMode')}</span>
          <select data-input="regularGroupMode">
            ${opt('chat', t('botDefaults.regularGroupModeChat'))}
            ${opt('new-topic', t('botDefaults.regularGroupModeNewTopic'))}
            ${opt('shared', t('botDefaults.regularGroupModeShared'))}
          </select>
        </label>
        <small class="bd-help">${t('botDefaults.regularGroupModeHelp')}</small>
        <div class="actions">
          <span class="oncall-status" data-regular-group-status></span>
        </div>
      </div>
      <div class="bd-row">
        <label>
          <span>${t('botDefaults.mentionMode')}</span>
          <select data-input="regularGroupMentionMode">
            ${mopt('always', t('botDefaults.mentionModeAlways'))}
            ${mopt('topic', t('botDefaults.mentionModeTopic'))}
            ${mopt('never', t('botDefaults.mentionModeNever'))}
          </select>
        </label>
        <small class="bd-help">${t('botDefaults.mentionModeHelp')}</small>
        <div class="actions">
          <span class="oncall-status" data-mention-mode-status></span>
        </div>
      </div>
      <div class="bd-row">
        <label>
          <span>${t('botDefaults.docSubscribeMode')}</span>
          <select data-input="docSubscribeDefaultMode">
            ${dopt('mention-only', t('botDefaults.docSubscribeModeMention'))}
            ${dopt('all', t('botDefaults.docSubscribeModeAll'))}
          </select>
        </label>
        <small class="bd-help">${t('botDefaults.docSubscribeModeHelp')}</small>
        <div class="actions">
          <span class="oncall-status" data-doc-subscribe-mode-status></span>
        </div>
      </div>
    </section>`;
  }

  function sessionCapStateLabel(cap: number | null): string {
    return cap == null
      ? t('botDefaults.maxLiveWorkersStateDefault')
      : t('botDefaults.maxLiveWorkersStateOn', { count: cap });
  }

  // 最大同时活跃会话数（maxLiveWorkers）：数字输入 + 保存/恢复默认按钮（空＝用默认 30）。
  // 超过上限时最久未用的会话自动休眠（worker+CLI 一起杀回收内存），下条消息冷恢复。
  // PUT /api/bots/:appId/max-live-workers 落 bots.json，daemon 每分钟读实时值即时生效。
  function renderSessionCapSection(b: any): string {
    const cap: number | null = typeof b.maxLiveWorkers === 'number' ? b.maxLiveWorkers : null;
    return `<div class="bd-subsection">
      <h4 class="bd-subsection-title">${t('botDefaults.sectionSessionCap')}</h4>
      <div class="bd-row bd-quota">
        <label>
          <span>${t('botDefaults.maxLiveWorkers')}</span>
          <input type="number" min="1" step="1" data-input="maxLiveWorkers"
            placeholder="${escapeHtml(t('botDefaults.maxLiveWorkersPlaceholder'))}"
            value="${cap == null ? '' : cap}">
        </label>
        <small data-session-cap-state>${escapeHtml(sessionCapStateLabel(cap))}</small>
        <small class="bd-help">${t('botDefaults.maxLiveWorkersHelp')}</small>
        <div class="actions">
          <button type="button" class="primary" data-action="save-session-cap">${t('botDefaults.maxLiveWorkersSave')}</button>
          <button type="button" data-action="off-session-cap">${t('botDefaults.maxLiveWorkersOff')}</button>
          <span class="oncall-status" data-session-cap-status></span>
        </div>
      </div>
    </div>`;
  }

  // 启动命令 startupCommands：开会话后、首条消息前自动按序发给 CLI 的 slash 命令（可带
  // 参数，如 /effort ultracode）。文本域，逗号/换行分隔，每行一条；空＝不发。next-session
  // 生效（含 resume，每次新会话重放）。PUT /api/bots/:appId/startup-commands 落 bots.json。
  function renderStartupCommandsSection(b: any): string {
    const val: string = typeof b.startupCommands === 'string' ? b.startupCommands : '';
    return `<div class="bd-subsection">
      <h4 class="bd-subsection-title">${t('botDefaults.sectionStartupCommands')}</h4>
      <p class="bd-section-note">${t('botDefaults.startupCommandsHelp')}</p>
      <textarea data-input="startupCommands" rows="3"
        placeholder="${escapeHtml(t('botDefaults.startupCommandsPlaceholder'))}"
        style="width:100%;box-sizing:border-box;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px">${escapeHtml(val)}</textarea>
      <div class="actions">
        <button type="button" class="primary" data-action="save-startup-commands">${t('botDefaults.startupCommandsSave')}</button>
        <span class="oncall-status" data-startup-commands-status></span>
      </div>
    </div>`;
  }

  // 环境变量 env：注入到本 bot CLI 进程的环境变量（JSON 对象），如让某个 bot 走 GLM/
  // 第三方服务商（ANTHROPIC_BASE_URL+ANTHROPIC_AUTH_TOKEN）或设 HTTPS_PROXY。next-session
  // 生效（下个新会话起注入）。PUT /api/bots/:appId/env 落 bots.json，跨后端按会话注入
  // （不进共享 tmux server 全局 env，不会串到别的 bot）。
  function renderEnvSection(b: any): string {
    const val: string = typeof b.env === 'string' ? b.env : '';
    return `<div class="bd-subsection">
      <h4 class="bd-subsection-title">${t('botDefaults.sectionEnv')}</h4>
      <p class="bd-section-note">${t('botDefaults.envHelp')}</p>
      <textarea data-input="env" rows="5"
        placeholder="${escapeHtml(t('botDefaults.envPlaceholder'))}"
        style="width:100%;box-sizing:border-box;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px">${escapeHtml(val)}</textarea>
      <div class="actions">
        <button type="button" class="primary" data-action="save-env">${t('botDefaults.envSave')}</button>
        <span class="oncall-status" data-env-status></span>
      </div>
    </div>`;
  }

  // File sandbox (oncall): a per-bot toggle. ON → this bot's sessions run inside
  // a per-session bwrap file sandbox (Linux). Auto-saves on change.
  function renderSandboxSection(b: any): string {
    const on = b.sandbox === true;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionSandbox')}</h3>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-sandbox" ${on ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.sandboxToggle')}</strong>
        <small>${t('botDefaults.sandboxHelp')}</small></span>
      </label>
      <div class="actions">
        <span class="oncall-status" data-sandbox-status></span>
      </div>
    </section>`;
  }

  function quotaStateLabel(quota: number | null): string {
    return quota == null
      ? t('botDefaults.quotaStateOff')
      : t('botDefaults.quotaStateOn', { count: quota });
  }

  // 授权（/grant）相关：自动申请卡、命令限制开关 + 默认消息额度。都通过
  // PUT /api/bots/:appId/grant-prefs 落到 bots.json，daemon 内存同步即时生效。
  function renderGrantSection(b: any): string {
    const restrict = b.restrictGrantCommands === true;
    const autoCard = b.autoGrantRequestCards !== false;
    const quota: number | null = typeof b.messageQuotaDefaultLimit === 'number' ? b.messageQuotaDefaultLimit : null;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionGrant')}</h3>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-auto-grant-card" ${autoCard ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.autoGrantCard')}</strong>
        <small>${t('botDefaults.autoGrantCardHelp')}</small></span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-restrict-grant" ${restrict ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.restrictGrant')}</strong>
        <small>${t('botDefaults.restrictGrantHelp')}</small></span>
      </label>
      <div class="bd-row bd-quota">
        <label>
          <span>${t('botDefaults.quotaDefault')}</span>
          <input type="number" min="1" step="1" data-input="quotaLimit"
            placeholder="${escapeHtml(t('botDefaults.quotaPlaceholder'))}"
            value="${quota == null ? '' : quota}">
        </label>
        <small data-quota-state>${escapeHtml(quotaStateLabel(quota))}</small>
        <small class="bd-help">${t('botDefaults.quotaHelp')}</small>
        <div class="actions">
          <button type="button" class="primary" data-action="save-quota">${t('botDefaults.quotaSave')}</button>
          <button type="button" data-action="off-quota">${t('botDefaults.quotaOff')}</button>
          <span class="oncall-status" data-grant-status></span>
        </div>
      </div>
    </section>`;
  }

  // 主动开工 — rendered as a sub-block INSIDE the 新群 Oncall section (it's part
  // of the same "proactively engage" config family). The two checkboxes auto-save
  // on change; the 场景① prompt has its own save button (a textarea shouldn't PUT
  // per keystroke). Data-action hooks are unchanged → wireCardHandlers still finds them.
  function renderAutoStartControls(b: any): string {
    const onJoin = b.autoStartOnGroupJoin === true;
    const onTopic = b.autoStartOnNewTopic === true;
    const joinPrompt: string = typeof b.autoStartOnGroupJoinPrompt === 'string' ? b.autoStartOnGroupJoinPrompt : '';
    return `<div class="bd-subsection">
      <h4 class="bd-subsection-title">${t('botDefaults.sectionAutoStart')}</h4>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-auto-join" ${onJoin ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.autoStartJoin')}</strong>
        <small>${t('botDefaults.autoStartJoinHelp')}</small></span>
      </label>
      <div class="bd-row">
        <label>
          <span>${t('botDefaults.autoStartJoinPrompt')}</span>
          <textarea data-input="autoJoinPrompt" rows="3"
            placeholder="${escapeHtml(t('botDefaults.autoStartJoinPromptPlaceholder'))}">${escapeHtml(joinPrompt)}</textarea>
        </label>
        <div class="actions">
          <button type="button" class="primary" data-action="save-auto-join-prompt">${t('botDefaults.autoStartJoinPromptSave')}</button>
        </div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" data-action="toggle-auto-topic" ${onTopic ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-tx"><strong>${t('botDefaults.autoStartTopic')}</strong>
        <small>${t('botDefaults.autoStartTopicHelp')}</small></span>
      </label>
      <div class="actions">
        <span class="oncall-status" data-auto-start-status></span>
      </div>
    </div>`;
  }

  function liveCard(appId: string): HTMLElement | null {
    return listEl.querySelector<HTMLElement>(`.bd-card[data-appid="${CSS.escape(appId)}"]`);
  }

  function renderProfileRolesInto(card: HTMLElement | null, appId: string): void {
    const target = card?.querySelector<HTMLElement>('[data-profile-role-list]');
    if (!target) return;
    target.innerHTML = renderProfileRoleList(appId);
    wireProfileRoleDetails(card!, appId);
  }

  async function ensureProfileRolesLoaded(appId: string, card: HTMLElement): Promise<void> {
    let state = botProfileRoleCache.get(appId);
    if (state?.loaded || state?.loading) {
      renderProfileRolesInto(card, appId);
      return;
    }

    state = { loaded: false, loading: true, items: [] };
    botProfileRoleCache.set(appId, state);
    renderProfileRolesInto(card, appId);
    try {
      const r = await fetch('/api/role-profiles');
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? String(r.status));
      const profiles = Array.isArray(body.profiles) ? body.profiles : [];
      state.items = profiles
        .filter((profile: any) => (profile.botEntries ?? []).some((entry: any) =>
          entry?.larkAppId === appId && entry?.hasEntry,
        ))
        .map((profile: any) => ({ profileId: String(profile.profileId) }));
      state.loaded = true;
    } catch (e: any) {
      state.error = e?.message ?? String(e);
      state.loaded = true;
    } finally {
      state.loading = false;
      renderProfileRolesInto(liveCard(appId), appId);
    }
  }

  function wireProfileRoleDetails(card: HTMLElement, appId: string): void {
    card.querySelectorAll<HTMLDetailsElement>('details.bd-profile-role-entry[data-profile-id]').forEach(detail => {
      detail.addEventListener('toggle', () => {
        if (!detail.open) return;
        const profileId = detail.dataset.profileId;
        if (profileId) void ensureProfileRoleDetailLoaded(appId, profileId);
      });
    });
  }

  async function ensureProfileRoleDetailLoaded(appId: string, profileId: string): Promise<void> {
    const state = botProfileRoleCache.get(appId);
    const item = state?.items.find(i => i.profileId === profileId);
    if (!item || item.loaded || item.loading) return;
    item.loading = true;
    renderProfileRoleBody(appId, profileId);
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(appId)}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? String(r.status));
      item.content = body?.hasEntry ? String(body.content ?? '') : '';
      item.loaded = true;
    } catch (e: any) {
      item.error = e?.message ?? String(e);
    } finally {
      item.loading = false;
      renderProfileRoleBody(appId, profileId);
    }
  }

  function renderProfileRoleBody(appId: string, profileId: string): void {
    const state = botProfileRoleCache.get(appId);
    const item = state?.items.find(i => i.profileId === profileId);
    if (!item) return;
    const body = liveCard(appId)?.querySelector<HTMLElement>(
      `[data-profile-role-body="${CSS.escape(profileId)}"]`,
    );
    if (body) body.innerHTML = renderProfileRoleContent(item);
  }

  function wireCardHandlers() {
    listEl.querySelectorAll<HTMLElement>('.bd-card').forEach(card => {
      const appId = card.dataset.appid!;
      void ensureProfileRolesLoaded(appId, card);
      const toggle = card.querySelector<HTMLInputElement>('input[data-action=toggle]');
      const input = card.querySelector<HTMLInputElement>('input[data-input=workingDir]');
      const saveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save]');
      const statusEl = card.querySelector<HTMLSpanElement>('[data-status]');
      if (!toggle || !input || !saveBtn || !statusEl) return; // error card

      toggle.addEventListener('change', () => {
        input.disabled = !toggle.checked;
        if (toggle.checked) input.focus();
      });

      saveBtn.addEventListener('click', async () => {
        statusEl.textContent = '';
        statusEl.className = 'oncall-status';
        const enabled = toggle.checked;
        const workingDir = input.value.trim();
        if (enabled && !workingDir) {
          statusEl.textContent = t('botDefaults.required');
          statusEl.classList.add('hint-warn-inline');
          return;
        }
        saveBtn.disabled = true;
        try {
          const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/default-oncall`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled, workingDir }),
          });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            const resolvedNote = body.resolvedPath ? ` → ${body.resolvedPath}` : '';
            statusEl.textContent = enabled
              ? `✓ 已开启${resolvedNote}（未绑定的群下次开话题自动 oncall）`
              : '✓ 已关闭（已绑定的群不动）';
            statusEl.classList.add('hint-ok');
            // Patch in-cache snapshot so the next manual Refresh / filter
            // rerender shows the new since/workingDir. We deliberately don't
            // call rerender() here — that would rebuild the card and wipe the
            // success toast the user just saw.
            const cached = cache.bots.find((b: any) => b.larkAppId === appId);
            if (cached && body.defaultOncall) cached.defaultOncall = body.defaultOncall;
            // Update the visible "上次启用时间" line in-place so the user
            // sees the timestamp jump without losing the toast.
            const metaEl = card.querySelector<HTMLElement>('[data-oncall-since]');
            if (metaEl && body.defaultOncall?.since != null) {
              metaEl.textContent = `上次启用时间：${fmtSince(body.defaultOncall.since)}`;
            }
          } else {
            statusEl.textContent = `✗ ${body.error ?? r.status}`;
            statusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          statusEl.textContent = `✗ ${e?.message ?? e}`;
          statusEl.classList.add('hint-warn-inline');
        } finally {
          saveBtn.disabled = false;
        }
      });

      // ── Brand label (independent of oncall save) ──────────────────────────
      const brandInput = card.querySelector<HTMLInputElement>('input[data-input=brandLabel]');
      const brandSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-brand]');
      const brandResetBtn = card.querySelector<HTMLButtonElement>('button[data-action=reset-brand]');
      const brandStatusEl = card.querySelector<HTMLSpanElement>('[data-brand-status]');
      const brandStateEl = card.querySelector<HTMLElement>('[data-brand-state]');

      // PUT the given brandLabel (string '' = off, null = revert to default),
      // then reflect the new state inline without a full rerender.
      async function putBrand(brandLabel: string | null, btn: HTMLButtonElement) {
        if (!brandStatusEl) return;
        brandStatusEl.textContent = '';
        brandStatusEl.className = 'oncall-status';
        btn.disabled = true;
        try {
          const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/brand-label`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brandLabel }),
          });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            const next: string | null = body.brandLabel ?? null;
            brandStatusEl.textContent = '✓';
            brandStatusEl.classList.add('hint-ok');
            if (brandInput) brandInput.value = next ?? '';
            if (brandStateEl) brandStateEl.textContent = brandStateLabel(next);
            const cached = cache.bots.find((b: any) => b.larkAppId === appId);
            if (cached) cached.brandLabel = next;
          } else {
            brandStatusEl.textContent = `✗ ${body.error ?? r.status}`;
            brandStatusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          brandStatusEl.textContent = `✗ ${e?.message ?? e}`;
          brandStatusEl.classList.add('hint-warn-inline');
        } finally {
          btn.disabled = false;
        }
      }

      if (brandInput && brandSaveBtn) {
        // Empty input saved as '' = brand off (per "配置为空就可以关").
        brandSaveBtn.addEventListener('click', () => putBrand(brandInput.value, brandSaveBtn));
      }
      if (brandResetBtn) {
        brandResetBtn.addEventListener('click', () => putBrand(null, brandResetBtn));
      }

      // ── Card behaviour toggles (auto-save on change) ──────────────────────
      const disableStreamingCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-disable-streaming]');
      const silentReactionsCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-silent-reactions]');
      const writableLinkCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-writable-link]');
      const privateCardCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-private-card]');
      const cardPrefStatusEl = card.querySelector<HTMLSpanElement>('[data-card-pref-status]');
      const cardPrefMootEl = card.querySelector<HTMLElement>('[data-card-pref-moot]');

      // PUT a partial card-prefs patch (booleans and/or the auto-start prompt
      // string). `selfEl` is the control that triggered it (disabled during the
      // request to block double-submit); `statusEl` is where the result toast
      // lands (defaults to the card-behaviour status line).
      async function putCardPref(
        patch: Record<string, boolean | string>,
        selfEl: HTMLInputElement | HTMLButtonElement | HTMLSelectElement,
        statusEl: HTMLElement | null = cardPrefStatusEl,
      ) {
        if (!statusEl) return;
        statusEl.textContent = '';
        statusEl.className = 'oncall-status';
        selfEl.disabled = true;
        try {
          const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/card-prefs`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            statusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
            statusEl.classList.add('hint-ok');
            const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
            if (cached) {
              cached.disableStreamingCard = body.disableStreamingCard;
              cached.silentTurnReactions = body.silentTurnReactions;
              cached.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
              cached.privateCard = body.privateCard;
              cached.autoStartOnGroupJoin = body.autoStartOnGroupJoin;
              cached.autoStartOnGroupJoinPrompt = body.autoStartOnGroupJoinPrompt;
              cached.autoStartOnNewTopic = body.autoStartOnNewTopic;
              cached.regularGroupReplyMode = body.regularGroupReplyMode;
              cached.regularGroupMentionMode = body.regularGroupMentionMode;
              cached.docSubscribeDefaultMode = body.docSubscribeDefaultMode;
            }
          } else {
            statusEl.textContent = `✗ ${body.error ?? r.status}`;
            statusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          statusEl.textContent = `✗ ${e?.message ?? e}`;
          statusEl.classList.add('hint-warn-inline');
        } finally {
          // The writable-link checkbox stays disabled while streaming is off.
          if (selfEl === writableLinkCb) selfEl.disabled = !!disableStreamingCb?.checked;
          // The status-reactions checkbox is only editable while streaming is off.
          else if (selfEl === silentReactionsCb) selfEl.disabled = !disableStreamingCb?.checked;
          else selfEl.disabled = false;
        }
      }

      if (disableStreamingCb) {
        disableStreamingCb.addEventListener('change', () => {
          const off = disableStreamingCb.checked;
          // Streaming off → the writable-link toggle has nothing to attach to.
          if (writableLinkCb) writableLinkCb.disabled = off;
          // Status reactions only exist in card-off sessions, so this toggle is
          // editable only while streaming is off.
          if (silentReactionsCb) silentReactionsCb.disabled = !off;
          if (cardPrefMootEl) cardPrefMootEl.hidden = !off;
          putCardPref({ disableStreamingCard: off }, disableStreamingCb);
        });
      }
      if (silentReactionsCb) {
        silentReactionsCb.addEventListener('change', () => {
          putCardPref({ silentTurnReactions: silentReactionsCb.checked }, silentReactionsCb);
        });
      }
      if (writableLinkCb) {
        writableLinkCb.addEventListener('change', () => {
          putCardPref({ writableTerminalLinkInCard: writableLinkCb.checked }, writableLinkCb);
        });
      }
      if (privateCardCb) {
        privateCardCb.addEventListener('change', () => {
          putCardPref({ privateCard: privateCardCb.checked }, privateCardCb);
        });
      }

      // ── File sandbox toggle (auto-save on change) ─────────────────────────
      const sandboxCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-sandbox]');
      const sandboxStatusEl = card.querySelector<HTMLSpanElement>('[data-sandbox-status]');
      if (sandboxCb) {
        sandboxCb.addEventListener('change', async () => {
          const enabled = sandboxCb.checked;
          if (sandboxStatusEl) { sandboxStatusEl.textContent = ''; sandboxStatusEl.className = 'oncall-status'; }
          sandboxCb.disabled = true;
          try {
            const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/sandbox`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled }),
            });
            const body = await r.json().catch(() => ({}));
            if (r.ok && body.ok) {
              if (sandboxStatusEl) { sandboxStatusEl.textContent = `✓ ${t('botDefaults.sandboxSaved')}`; sandboxStatusEl.classList.add('hint-ok'); }
              const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
              if (cached) cached.sandbox = body.sandbox === true;
            } else {
              if (sandboxStatusEl) { sandboxStatusEl.textContent = `✗ ${body.error ?? r.status}`; sandboxStatusEl.classList.add('hint-warn-inline'); }
              sandboxCb.checked = !enabled;  // revert on failure
            }
          } catch (e: any) {
            if (sandboxStatusEl) { sandboxStatusEl.textContent = `✗ ${e?.message ?? e}`; sandboxStatusEl.classList.add('hint-warn-inline'); }
            sandboxCb.checked = !enabled;
          } finally {
            sandboxCb.disabled = false;
          }
        });
      }

      // ── 主动开工 toggles + 场景① prompt ───────────────────────────────────
      const autoJoinCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-auto-join]');
      const autoTopicCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-auto-topic]');
      const autoJoinPromptEl = card.querySelector<HTMLTextAreaElement>('textarea[data-input=autoJoinPrompt]');
      const autoJoinPromptSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-auto-join-prompt]');
      const autoStartStatusEl = card.querySelector<HTMLSpanElement>('[data-auto-start-status]');
      if (autoJoinCb) {
        autoJoinCb.addEventListener('change', () => {
          putCardPref({ autoStartOnGroupJoin: autoJoinCb.checked }, autoJoinCb, autoStartStatusEl);
        });
      }
      if (autoTopicCb) {
        autoTopicCb.addEventListener('change', () => {
          putCardPref({ autoStartOnNewTopic: autoTopicCb.checked }, autoTopicCb, autoStartStatusEl);
        });
      }
      if (autoJoinPromptEl && autoJoinPromptSaveBtn) {
        autoJoinPromptSaveBtn.addEventListener('click', () => {
          putCardPref({ autoStartOnGroupJoinPrompt: autoJoinPromptEl.value }, autoJoinPromptSaveBtn, autoStartStatusEl);
        });
      }

      // ── 私聊单聊模式 p2pMode select ───────────────────────────────────────
      const p2pModeSel = card.querySelector<HTMLSelectElement>('select[data-input=p2pMode]');
      const p2pStatusEl = card.querySelector<HTMLSpanElement>('[data-p2p-status]');
      if (p2pModeSel && p2pStatusEl) {
        p2pModeSel.addEventListener('change', async () => {
          const mode = p2pModeSel.value === 'chat' ? 'chat' : 'thread';
          p2pStatusEl.textContent = '';
          p2pStatusEl.className = 'oncall-status';
          p2pModeSel.disabled = true;
          try {
            const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/p2p-mode`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ p2pMode: mode }),
            });
            const body = await r.json().catch(() => ({}));
            if (r.ok && body.ok) {
              p2pStatusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
              p2pStatusEl.classList.add('hint-ok');
              const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
              if (cached) cached.p2pMode = body.p2pMode === 'chat' ? 'chat' : 'thread';
            } else {
              p2pStatusEl.textContent = `✗ ${body.error ?? r.status}`;
              p2pStatusEl.classList.add('hint-warn-inline');
            }
          } catch (e: any) {
            p2pStatusEl.textContent = `✗ ${e?.message ?? e}`;
            p2pStatusEl.classList.add('hint-warn-inline');
          } finally {
            p2pModeSel.disabled = false;
          }
        });
      }

      // ── 普通群默认会话模式 regularGroupReplyMode select ─────────────────────
      // chat = 整群一个连续会话（默认）；new-topic = 每条顶层 @ 开独立话题；
      // shared = 话题模式但复用同一个 session。走 card-prefs 路径。
      const regularGroupModeSel = card.querySelector<HTMLSelectElement>('select[data-input=regularGroupMode]');
      const regularGroupStatusEl = card.querySelector<HTMLSpanElement>('[data-regular-group-status]');
      if (regularGroupModeSel) {
        regularGroupModeSel.addEventListener('change', () => {
          putCardPref(
            { regularGroupReplyMode: regularGroupModeSel.value },
            regularGroupModeSel,
            regularGroupStatusEl,
          );
        });
      }

      // ── 群聊 @ 策略三档（bot-global）──────────────────────────────────────
      // always = 都需要 @（默认）；topic = 仅 shared 话题内免 @；never = 都不需要 @。
      const mentionModeSel = card.querySelector<HTMLSelectElement>('select[data-input=regularGroupMentionMode]');
      const mentionModeStatusEl = card.querySelector<HTMLSpanElement>('[data-mention-mode-status]');
      if (mentionModeSel) {
        mentionModeSel.addEventListener('change', () => {
          putCardPref(
            { regularGroupMentionMode: mentionModeSel.value },
            mentionModeSel,
            mentionModeStatusEl,
          );
        });
      }

      // ── 文档订阅默认触发范围（bot-global）─────────────────────────────────
      // mention-only = 仅评论 @ 我才触发（默认）；all = 所有新评论都触发。
      const docModeSel = card.querySelector<HTMLSelectElement>('select[data-input=docSubscribeDefaultMode]');
      const docModeStatusEl = card.querySelector<HTMLSpanElement>('[data-doc-subscribe-mode-status]');
      if (docModeSel) {
        docModeSel.addEventListener('change', () => {
          putCardPref(
            { docSubscribeDefaultMode: docModeSel.value },
            docModeSel,
            docModeStatusEl,
          );
        });
      }

      // ── Team role (one role per bot, cross-chat) ──────────────────────────
      const roleTextarea = card.querySelector<HTMLTextAreaElement>('textarea[data-input=teamRole]');
      const roleSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-role]');
      const roleDeleteBtn = card.querySelector<HTMLButtonElement>('button[data-action=delete-role]');
      const roleStatusEl = card.querySelector<HTMLSpanElement>('[data-role-status]');

      if (roleTextarea && roleSaveBtn && roleDeleteBtn && roleStatusEl) {
        const roleUrl = `/api/team/local-bots/${encodeURIComponent(appId)}/role`;
        const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);

        // Until the role is loaded, the textarea AND both buttons render
        // disabled. This is load-bearing: an empty not-yet-loaded textarea
        // saved as "" is treated as a DELETE by the server (federation-spoke-api
        // role PUT), so a mis-click during a slow load would silently wipe an
        // existing role. We only enable the editor once GET has returned.
        function enableLiveEditor(value: string) {
          const live = listEl.querySelector<HTMLElement>(`.bd-card[data-appid="${CSS.escape(appId)}"]`);
          if (!live) return; // filtered out by search — next render draws it enabled from cache
          const ta = live.querySelector<HTMLTextAreaElement>('textarea[data-input=teamRole]');
          const sv = live.querySelector<HTMLButtonElement>('button[data-action=save-role]');
          const dl = live.querySelector<HTMLButtonElement>('button[data-action=delete-role]');
          if (ta) { ta.value = value; ta.disabled = false; }
          if (sv) sv.disabled = false;
          if (dl) dl.disabled = false;
        }

        // Lazily load the role ONCE per bot, then stash it onto the snapshot
        // (cached.teamRole) so later re-renders — one per search keystroke —
        // render from cache instead of re-fetching. The teamRoleLoading sentinel
        // guards against a re-render firing a second concurrent GET while the
        // first is still in flight. enableLiveEditor re-queries the *current*
        // DOM so a mid-load re-render doesn't leave a stale (detached) textarea
        // stuck disabled.
        if (cached && typeof cached.teamRole !== 'string' && !cached.teamRoleLoading) {
          cached.teamRoleLoading = true;
          (async () => {
            try {
              const r = await fetch(roleUrl);
              const body = await r.json().catch(() => ({}));
              if (r.ok && body.ok) {
                cached.teamRole = body.role ?? '';
                enableLiveEditor(cached.teamRole);
              } else {
                roleStatusEl.textContent = `✗ ${t('botDefaults.roleLoadErr')}: ${body.error ?? r.status}`;
                roleStatusEl.classList.add('hint-warn-inline');
              }
            } catch (e: any) {
              roleStatusEl.textContent = `✗ ${t('botDefaults.roleLoadErr')}: ${e?.message ?? e}`;
              roleStatusEl.classList.add('hint-warn-inline');
            } finally {
              cached.teamRoleLoading = false;
            }
          })();
        }

        // PUT the role ('' = delete on the server). `deleted` picks the success
        // toast; both buttons share this path. Server trims + deletes on empty,
        // so we mirror the stored value into the cache for consistent re-renders.
        async function putRole(role: string, btn: HTMLButtonElement, deleted: boolean) {
          if (!roleStatusEl) return;
          // Defense-in-depth: never PUT before the role is loaded (would risk a
          // ""-as-delete). The buttons render disabled until then, but guard the
          // entry too in case of a stale handler firing.
          if (!cached || typeof cached.teamRole !== 'string') return;
          roleStatusEl.textContent = '';
          roleStatusEl.className = 'oncall-status';
          roleSaveBtn!.disabled = true;
          roleDeleteBtn!.disabled = true;
          try {
            const r = await fetch(roleUrl, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ role }),
            });
            const body = await r.json().catch(() => ({}));
            if (r.ok && body.ok) {
              if (cached) cached.teamRole = role.trim();
              roleStatusEl.textContent = `✓ ${deleted ? t('botDefaults.roleDeleted') : t('botDefaults.roleSaved')}`;
              roleStatusEl.classList.add('hint-ok');
            } else {
              roleStatusEl.textContent = `✗ ${body.error ?? r.status}`;
              roleStatusEl.classList.add('hint-warn-inline');
            }
          } catch (e: any) {
            roleStatusEl.textContent = `✗ ${e?.message ?? e}`;
            roleStatusEl.classList.add('hint-warn-inline');
          } finally {
            roleSaveBtn!.disabled = false;
            roleDeleteBtn!.disabled = false;
          }
        }

        roleSaveBtn.addEventListener('click', () => putRole(roleTextarea.value, roleSaveBtn, false));
        roleDeleteBtn.addEventListener('click', () => {
          roleTextarea.value = '';
          putRole('', roleDeleteBtn, true);
        });
      }

      // ── 授权偏好：自动申请卡 + 命令限制开关 + 默认消息额度 ──────────────
      const autoGrantCardCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-auto-grant-card]');
      const restrictCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-restrict-grant]');
      const quotaInput = card.querySelector<HTMLInputElement>('input[data-input=quotaLimit]');
      const quotaSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-quota]');
      const quotaOffBtn = card.querySelector<HTMLButtonElement>('button[data-action=off-quota]');
      const grantStatusEl = card.querySelector<HTMLSpanElement>('[data-grant-status]');
      const quotaStateEl = card.querySelector<HTMLElement>('[data-quota-state]');

      // PUT a partial grant-prefs patch ({ autoGrantRequestCards? },
      // { restrictGrantCommands? } and/or { messageQuotaDefaultLimit: number|null }).
      // Mirrors putCardPref.
      async function putGrantPref(
        patch: { autoGrantRequestCards?: boolean; restrictGrantCommands?: boolean; messageQuotaDefaultLimit?: number | null },
        selfEl: HTMLInputElement | HTMLButtonElement,
      ) {
        if (!grantStatusEl) return;
        grantStatusEl.textContent = '';
        grantStatusEl.className = 'oncall-status';
        selfEl.disabled = true;
        try {
          const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/grant-prefs`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            grantStatusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
            grantStatusEl.classList.add('hint-ok');
            const next: number | null = typeof body.messageQuotaDefaultLimit === 'number' ? body.messageQuotaDefaultLimit : null;
            const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
            if (cached) {
              cached.autoGrantRequestCards = body.autoGrantRequestCards !== false;
              cached.restrictGrantCommands = body.restrictGrantCommands === true;
              cached.messageQuotaDefaultLimit = next;
            }
            if (quotaStateEl) quotaStateEl.textContent = quotaStateLabel(next);
            if (quotaInput && 'messageQuotaDefaultLimit' in patch) {
              quotaInput.value = next == null ? '' : String(next);
            }
          } else {
            grantStatusEl.textContent = `✗ ${body.error ?? r.status}`;
            grantStatusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          grantStatusEl.textContent = `✗ ${e?.message ?? e}`;
          grantStatusEl.classList.add('hint-warn-inline');
        } finally {
          selfEl.disabled = false;
        }
      }

      if (autoGrantCardCb) {
        autoGrantCardCb.addEventListener('change', () => {
          putGrantPref({ autoGrantRequestCards: autoGrantCardCb.checked }, autoGrantCardCb);
        });
      }
      if (restrictCb) {
        restrictCb.addEventListener('change', () => {
          putGrantPref({ restrictGrantCommands: restrictCb.checked }, restrictCb);
        });
      }
      if (quotaInput && quotaSaveBtn) {
        quotaSaveBtn.addEventListener('click', () => {
          const raw = quotaInput.value.trim();
          if (raw === '') { putGrantPref({ messageQuotaDefaultLimit: null }, quotaSaveBtn); return; } // 空＝关闭
          // 只认纯正整数 token（拒 1e2 / 1.0 / 01），与 /grant @x N 的数字语义一致。
          if (!/^[1-9]\d*$/.test(raw)) {
            if (grantStatusEl) {
              grantStatusEl.textContent = `✗ ${t('botDefaults.quotaInvalid')}`;
              grantStatusEl.className = 'oncall-status hint-warn-inline';
            }
            return;
          }
          putGrantPref({ messageQuotaDefaultLimit: Number(raw) }, quotaSaveBtn);
        });
      }
      if (quotaInput && quotaOffBtn) {
        quotaOffBtn.addEventListener('click', () => {
          quotaInput.value = '';
          putGrantPref({ messageQuotaDefaultLimit: null }, quotaOffBtn);
        });
      }

      // ── 最大同时活跃会话数 maxLiveWorkers（空＝回落默认 30） ──────────────────
      const capInput = card.querySelector<HTMLInputElement>('input[data-input=maxLiveWorkers]');
      const capSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-session-cap]');
      const capOffBtn = card.querySelector<HTMLButtonElement>('button[data-action=off-session-cap]');
      const capStatusEl = card.querySelector<HTMLSpanElement>('[data-session-cap-status]');
      const capStateEl = card.querySelector<HTMLElement>('[data-session-cap-state]');

      // PUT { maxLiveWorkers: number | null } to the bot's daemon (via the
      // dashboard proxy). null = unlimited. Mirrors putGrantPref.
      async function putMaxLiveWorkers(value: number | null, selfEl: HTMLInputElement | HTMLButtonElement) {
        if (!capStatusEl) return;
        capStatusEl.textContent = '';
        capStatusEl.className = 'oncall-status';
        selfEl.disabled = true;
        try {
          const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/max-live-workers`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ maxLiveWorkers: value }),
          });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            capStatusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
            capStatusEl.classList.add('hint-ok');
            const next: number | null = typeof body.maxLiveWorkers === 'number' ? body.maxLiveWorkers : null;
            const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
            if (cached) cached.maxLiveWorkers = next;
            if (capStateEl) capStateEl.textContent = sessionCapStateLabel(next);
            if (capInput) capInput.value = next == null ? '' : String(next);
          } else {
            capStatusEl.textContent = `✗ ${body.error ?? r.status}`;
            capStatusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          capStatusEl.textContent = `✗ ${e?.message ?? e}`;
          capStatusEl.classList.add('hint-warn-inline');
        } finally {
          selfEl.disabled = false;
        }
      }

      if (capInput && capSaveBtn) {
        capSaveBtn.addEventListener('click', () => {
          const raw = capInput.value.trim();
          if (raw === '') { putMaxLiveWorkers(null, capSaveBtn); return; } // 空＝清回默认 30
          // 只认纯正整数 token（拒 1e2 / 1.0 / 01），与额度输入同口径。
          if (!/^[1-9]\d*$/.test(raw)) {
            if (capStatusEl) {
              capStatusEl.textContent = `✗ ${t('botDefaults.maxLiveWorkersInvalid')}`;
              capStatusEl.className = 'oncall-status hint-warn-inline';
            }
            return;
          }
          putMaxLiveWorkers(Number(raw), capSaveBtn);
        });
      }
      if (capInput && capOffBtn) {
        capOffBtn.addEventListener('click', () => {
          capInput.value = '';
          putMaxLiveWorkers(null, capOffBtn);
        });
      }

      // ── 启动命令 startupCommands（逗号/换行分隔；空＝清除，不发任何命令） ──────────
      const startupEl = card.querySelector<HTMLTextAreaElement>('textarea[data-input=startupCommands]');
      const startupSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-startup-commands]');
      const startupStatusEl = card.querySelector<HTMLSpanElement>('[data-startup-commands-status]');
      if (startupEl && startupSaveBtn) {
        startupSaveBtn.addEventListener('click', async () => {
          if (!startupStatusEl) return;
          startupStatusEl.textContent = '';
          startupStatusEl.className = 'oncall-status';
          startupSaveBtn.disabled = true;
          try {
            const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/startup-commands`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ startupCommands: startupEl.value }),
            });
            const body = await r.json().catch(() => ({}));
            if (r.ok && body.ok) {
              startupStatusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
              startupStatusEl.classList.add('hint-ok');
              // Server returns the normalized, newline-joined list — reflect it
              // back so the textarea shows exactly what was persisted.
              const next: string = typeof body.startupCommands === 'string' ? body.startupCommands : '';
              startupEl.value = next;
              const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
              if (cached) cached.startupCommands = next;
            } else {
              startupStatusEl.textContent = `✗ ${body.error ?? r.status}`;
              startupStatusEl.classList.add('hint-warn-inline');
            }
          } catch (e: any) {
            startupStatusEl.textContent = `✗ ${e?.message ?? e}`;
            startupStatusEl.classList.add('hint-warn-inline');
          } finally {
            startupSaveBtn.disabled = false;
          }
        });
      }

      // ── 环境变量 env（JSON 对象；空＝清除） ──────────────────────────────
      const envEl = card.querySelector<HTMLTextAreaElement>('textarea[data-input=env]');
      const envSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-env]');
      const envStatusEl = card.querySelector<HTMLSpanElement>('[data-env-status]');
      if (envEl && envSaveBtn) {
        envSaveBtn.addEventListener('click', async () => {
          if (!envStatusEl) return;
          envStatusEl.textContent = '';
          envStatusEl.className = 'oncall-status';
          envSaveBtn.disabled = true;
          try {
            const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/env`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ env: envEl.value }),
            });
            const body = await r.json().catch(() => ({}));
            if (r.ok && body.ok) {
              envStatusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
              envStatusEl.classList.add('hint-ok');
              // Server returns the sanitized, pretty-printed JSON — reflect it
              // back so the textarea shows exactly what was persisted.
              const next: string = typeof body.env === 'string' ? body.env : '';
              envEl.value = next;
              const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
              if (cached) cached.env = next;
            } else {
              envStatusEl.textContent = `✗ ${body.error ?? r.status}`;
              envStatusEl.classList.add('hint-warn-inline');
            }
          } catch (e: any) {
            envStatusEl.textContent = `✗ ${e?.message ?? e}`;
            envStatusEl.classList.add('hint-warn-inline');
          } finally {
            envSaveBtn.disabled = false;
          }
        });
      }
    });
  }

  rerender();
  void loadNameMaps().then(rerender); // 头像表就绪后重绘，让 /api/bots 这边也出真实头像
  form.addEventListener('input', rerender);
}
