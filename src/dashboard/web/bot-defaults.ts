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
        </section>
        ${renderBrandSection(b)}
        ${renderCardBehaviorSection(b)}
      </div>
    </article>`;
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

      // PUT a partial card-prefs patch; `selfCb` is the checkbox that triggered
      // it (disabled during the request to block double-submit).
      async function putCardPref(patch: Record<string, boolean>, selfCb: HTMLInputElement) {
        if (!cardPrefStatusEl) return;
        cardPrefStatusEl.textContent = '';
        cardPrefStatusEl.className = 'oncall-status';
        selfCb.disabled = true;
        try {
          const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/card-prefs`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const body = await r.json().catch(() => ({}));
          if (r.ok && body.ok) {
            cardPrefStatusEl.textContent = `✓ ${t('botDefaults.cardPrefSaved')}`;
            cardPrefStatusEl.classList.add('hint-ok');
            const cached = cache.bots.find((bb: any) => bb.larkAppId === appId);
            if (cached) {
              cached.disableStreamingCard = body.disableStreamingCard;
              cached.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
              cached.privateCard = body.privateCard;
            }
          } else {
            cardPrefStatusEl.textContent = `✗ ${body.error ?? r.status}`;
            cardPrefStatusEl.classList.add('hint-warn-inline');
          }
        } catch (e: any) {
          cardPrefStatusEl.textContent = `✗ ${e?.message ?? e}`;
          cardPrefStatusEl.classList.add('hint-warn-inline');
        } finally {
          // The writable-link checkbox stays disabled while streaming is off.
          if (selfCb === writableLinkCb) selfCb.disabled = !!disableStreamingCb?.checked;
          else selfCb.disabled = false;
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
    });
  }

  rerender();
  form.addEventListener('input', rerender);
}
