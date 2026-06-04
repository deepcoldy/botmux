// Bot Defaults page: per-bot configuration for "default oncall mode on new
// chats". Strictly per-bot (no chat × bot matrix here — that lives in the
// Groups & Bots tab). Saving here only affects NEW group chats first observed
// after the save; existing chats are left alone, and chats already auto-bound
// once stay user-controlled.
import { escapeHtml, t } from './ui.js';

let cache: { bots: any[] } = { bots: [] };
let loadError: string | null = null;

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">${t('nav.botDefaults')}</p>
    <h1>${t('botDefaults.title')}</h1>
    <p>${t('botDefaults.subtitle')}</p>
  </div>
</div>
<form id="bd-filters" class="filters">
  <input type="search" name="q" placeholder="${t('botDefaults.search')}" />
  <button type="button" id="bd-refresh">${t('botDefaults.refresh')}</button>
</form>
<div id="bd-list"></div>
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
  const form = root.querySelector<HTMLFormElement>('#bd-filters')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#bd-refresh')!;

  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    try { await loadBots(); rerender(); } finally { refreshBtn.disabled = false; }
  };

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
      listEl.innerHTML = `<p class="hint-warn">无法加载 bot 列表：${escapeHtml(loadError)}<br>` +
        `常见原因：dashboard / daemon 进程还在跑旧代码，执行 <code>botmux restart</code> 后刷新。</p>`;
      return;
    }
    if (filtered.length === 0) {
      listEl.innerHTML = `<p class="empty">${t('botDefaults.empty')}</p>`;
      return;
    }
    listEl.innerHTML = filtered.map(renderBotCard).join('');
    wireCardHandlers();
  }

  function renderBotCard(b: any): string {
    if (b.error) {
      return `<article class="bd-card" data-appid="${escapeHtml(b.larkAppId)}">
        <header><strong>${escapeHtml(b.botName ?? b.larkAppId)}</strong>
        <small>${escapeHtml(b.larkAppId)}</small></header>
        <p class="hint-warn-inline">查询失败：${escapeHtml(b.error)}</p>
      </article>`;
    }
    const def = b.defaultOncall ?? { enabled: false, workingDir: '', since: 0 };
    const enabled = !!def.enabled;
    return `<article class="bd-card" data-appid="${escapeHtml(b.larkAppId)}">
      <header>
        <strong>${escapeHtml(b.botName ?? b.larkAppId)}</strong>
        <small>${escapeHtml(b.larkAppId)}</small>
      </header>
      <div class="bd-body">
        <section class="bd-section">
          <h3 class="bd-section-title">${t('botDefaults.sectionOncall')}</h3>
          <label class="checkbox-row">
            <input type="checkbox" data-action="toggle" ${enabled ? 'checked' : ''}>
            <strong>${t('botDefaults.defaultOncall')}</strong>
            <small>${t('botDefaults.defaultOncallHelp')}</small>
          </label>
          <div class="bd-row">
            <label>
              <span>${t('botDefaults.workingDir')}</span>
              <input type="text" data-input="workingDir" placeholder="e.g. /root/iserver/botmux"
                value="${escapeHtml(def.workingDir ?? '')}" ${enabled ? '' : 'disabled'}>
            </label>
          </div>
          <p class="bd-section-note">${t('botDefaults.warning')}</p>
          <div class="bd-meta">
            <small>${t('botDefaults.lastEnabled')}: ${escapeHtml(fmtSince(def.since ?? 0))}</small>
            <small>${t('botDefaults.autobound', { count: b.autoboundChatCount ?? 0 })}</small>
          </div>
          <div class="actions">
            <button type="button" data-action="save">${t('botDefaults.save')}</button>
            <span class="oncall-status" data-status></span>
          </div>
          ${renderAutoStartControls(b)}
        </section>
        ${renderRoleSection(b)}
        ${renderBrandSection(b)}
        ${renderCardBehaviorSection(b)}
        ${renderGrantSection(b)}
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
        <button type="button" data-action="save-role"${loaded ? '' : ' disabled'}>${t('botDefaults.roleSave')}</button>
        <button type="button" data-action="delete-role"${loaded ? '' : ' disabled'}>${t('botDefaults.roleDelete')}</button>
        <span class="oncall-status" data-role-status></span>
      </div>
    </section>`;
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
        <small>${t('botDefaults.brandLabelHelp')}</small>
        <div class="actions">
          <button type="button" data-action="save-brand">${t('botDefaults.brandSave')}</button>
          <button type="button" data-action="reset-brand">${t('botDefaults.brandReset')}</button>
          <span class="oncall-status" data-brand-status></span>
        </div>
      </div>
    </section>`;
  }

  // Two per-bot card-behaviour toggles. Both auto-save on change (no explicit
  // save button — each checkbox PUTs immediately). The writable-link toggle is
  // moot while the streaming card is disabled, so we disable it in that state.
  function renderCardBehaviorSection(b: any): string {
    const disableStreaming = b.disableStreamingCard === true;
    const writableLink = b.writableTerminalLinkInCard === true;
    const privateCard = b.privateCard === true;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionCard')}</h3>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-disable-streaming" ${disableStreaming ? 'checked' : ''}>
        <strong>${t('botDefaults.disableStreaming')}</strong>
        <small>${t('botDefaults.disableStreamingHelp')}</small>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-writable-link" ${writableLink ? 'checked' : ''} ${disableStreaming ? 'disabled' : ''}>
        <strong>${t('botDefaults.writableLink')}</strong>
        <small>${t('botDefaults.writableLinkHelp')}</small>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-private-card" ${privateCard ? 'checked' : ''}>
        <strong>${t('botDefaults.privateCard')}</strong>
        <small>${t('botDefaults.privateCardHelp')}</small>
      </label>
      <div class="actions">
        <small data-card-pref-moot class="hint-warn-inline" ${disableStreaming ? '' : 'hidden'}>${t('botDefaults.writableLinkMoot')}</small>
        <span class="oncall-status" data-card-pref-status></span>
      </div>
    </section>`;
  }

  function quotaStateLabel(quota: number | null): string {
    return quota == null
      ? t('botDefaults.quotaStateOff')
      : t('botDefaults.quotaStateOn', { count: quota });
  }

  // 授权（/grant）相关：命令限制开关（auto-save 复选框）+ 默认消息额度（数字输入 + 保存/关闭按钮，
  // 空＝关闭无限）。两者都通过 PUT /api/bots/:appId/grant-prefs 落到 bots.json，daemon 内存同步即时生效。
  function renderGrantSection(b: any): string {
    const restrict = b.restrictGrantCommands === true;
    const quota: number | null = typeof b.messageQuotaDefaultLimit === 'number' ? b.messageQuotaDefaultLimit : null;
    return `<section class="bd-section">
      <h3 class="bd-section-title">${t('botDefaults.sectionGrant')}</h3>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-restrict-grant" ${restrict ? 'checked' : ''}>
        <strong>${t('botDefaults.restrictGrant')}</strong>
        <small>${t('botDefaults.restrictGrantHelp')}</small>
      </label>
      <div class="bd-row bd-quota">
        <label>
          <span>${t('botDefaults.quotaDefault')}</span>
          <input type="number" min="1" step="1" data-input="quotaLimit"
            placeholder="${escapeHtml(t('botDefaults.quotaPlaceholder'))}"
            value="${quota == null ? '' : quota}">
        </label>
        <small data-quota-state>${escapeHtml(quotaStateLabel(quota))}</small>
        <small>${t('botDefaults.quotaHelp')}</small>
        <div class="actions">
          <button type="button" data-action="save-quota">${t('botDefaults.quotaSave')}</button>
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
    const onTopicFromBots = b.autoStartOnNewTopicFromBots === true;
    const joinPrompt: string = typeof b.autoStartOnGroupJoinPrompt === 'string' ? b.autoStartOnGroupJoinPrompt : '';
    return `<div class="bd-subsection">
      <h4 class="bd-subsection-title">${t('botDefaults.sectionAutoStart')}</h4>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-auto-join" ${onJoin ? 'checked' : ''}>
        <strong>${t('botDefaults.autoStartJoin')}</strong>
        <small>${t('botDefaults.autoStartJoinHelp')}</small>
      </label>
      <div class="bd-row">
        <label>
          <span>${t('botDefaults.autoStartJoinPrompt')}</span>
          <textarea data-input="autoJoinPrompt" rows="3"
            placeholder="${escapeHtml(t('botDefaults.autoStartJoinPromptPlaceholder'))}">${escapeHtml(joinPrompt)}</textarea>
        </label>
        <div class="actions">
          <button type="button" data-action="save-auto-join-prompt">${t('botDefaults.autoStartJoinPromptSave')}</button>
        </div>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-auto-topic" ${onTopic ? 'checked' : ''}>
        <strong>${t('botDefaults.autoStartTopic')}</strong>
        <small>${t('botDefaults.autoStartTopicHelp')}</small>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" data-action="toggle-auto-topic-bots" ${onTopicFromBots ? 'checked' : ''} ${onTopic ? '' : 'disabled'}>
        <strong>${t('botDefaults.autoStartTopicBots')}</strong>
        <small>${t('botDefaults.autoStartTopicBotsHelp')}</small>
      </label>
      <div class="actions">
        <span class="oncall-status" data-auto-start-status></span>
      </div>
    </div>`;
  }

  function wireCardHandlers() {
    listEl.querySelectorAll<HTMLElement>('.bd-card').forEach(card => {
      const appId = card.dataset.appid!;
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
            const metaEl = card.querySelector<HTMLElement>('.bd-meta small:first-child');
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
        selfEl: HTMLInputElement | HTMLButtonElement,
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
              cached.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
              cached.privateCard = body.privateCard;
              cached.autoStartOnGroupJoin = body.autoStartOnGroupJoin;
              cached.autoStartOnGroupJoinPrompt = body.autoStartOnGroupJoinPrompt;
              cached.autoStartOnNewTopic = body.autoStartOnNewTopic;
              cached.autoStartOnNewTopicFromBots = body.autoStartOnNewTopicFromBots;
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
          else selfEl.disabled = false;
        }
      }

      if (disableStreamingCb) {
        disableStreamingCb.addEventListener('change', () => {
          const off = disableStreamingCb.checked;
          // Streaming off → the writable-link toggle has nothing to attach to.
          if (writableLinkCb) writableLinkCb.disabled = off;
          if (cardPrefMootEl) cardPrefMootEl.hidden = !off;
          putCardPref({ disableStreamingCard: off }, disableStreamingCb);
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

      // ── 主动开工 toggles + 场景① prompt ───────────────────────────────────
      const autoJoinCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-auto-join]');
      const autoTopicCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-auto-topic]');
      const autoTopicBotsCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-auto-topic-bots]');
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
          if (autoTopicBotsCb) autoTopicBotsCb.disabled = !autoTopicCb.checked;
          putCardPref({ autoStartOnNewTopic: autoTopicCb.checked }, autoTopicCb, autoStartStatusEl);
        });
      }
      if (autoTopicBotsCb) {
        autoTopicBotsCb.addEventListener('change', () => {
          putCardPref({ autoStartOnNewTopicFromBots: autoTopicBotsCb.checked }, autoTopicBotsCb, autoStartStatusEl);
        });
      }
      if (autoJoinPromptEl && autoJoinPromptSaveBtn) {
        autoJoinPromptSaveBtn.addEventListener('click', () => {
          putCardPref({ autoStartOnGroupJoinPrompt: autoJoinPromptEl.value }, autoJoinPromptSaveBtn, autoStartStatusEl);
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

      // ── 授权偏好：命令限制开关 + 默认消息额度 ──────────────────────────
      const restrictCb = card.querySelector<HTMLInputElement>('input[data-action=toggle-restrict-grant]');
      const quotaInput = card.querySelector<HTMLInputElement>('input[data-input=quotaLimit]');
      const quotaSaveBtn = card.querySelector<HTMLButtonElement>('button[data-action=save-quota]');
      const quotaOffBtn = card.querySelector<HTMLButtonElement>('button[data-action=off-quota]');
      const grantStatusEl = card.querySelector<HTMLSpanElement>('[data-grant-status]');
      const quotaStateEl = card.querySelector<HTMLElement>('[data-quota-state]');

      // PUT a partial grant-prefs patch ({ restrictGrantCommands? } and/or
      // { messageQuotaDefaultLimit: number|null }). Mirrors putCardPref.
      async function putGrantPref(
        patch: { restrictGrantCommands?: boolean; messageQuotaDefaultLimit?: number | null },
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
    });
  }

  rerender();
  form.addEventListener('input', rerender);
}
