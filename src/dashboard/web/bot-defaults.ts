// Bot Defaults page: per-bot configuration for "default oncall mode on new
// chats". Strictly per-bot (no chat × bot matrix here — that lives in the
// Groups & Bots tab). Saving here only affects NEW group chats first observed
// after the save; existing chats are left alone, and chats already auto-bound
// once stay user-controlled.

let cache: { bots: any[] } = { bots: [] };
let loadError: string | null = null;

const PAGE_HTML = `
<form id="bd-filters" class="filters">
  <input type="search" name="q" placeholder="search bot name / app id" />
  <button type="button" id="bd-refresh">Refresh</button>
</form>
<p class="hint-warn" style="max-width:760px">
  开关 ON 后，<strong>所有没有 oncall binding 的群</strong>（包括老群）下一次开新话题会自动绑到下面填的目录；
  Groups &amp; Bots 里已经手动绑过的群不动；通过 <code>/oncall unbind</code> 解过绑的群永远不再被自动覆盖。
</p>
<div id="bd-list"></div>
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
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
  root.innerHTML = PAGE_HTML;
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
      listEl.innerHTML = `<p class="empty">没有在线的 bot。先 \`botmux restart\` 让 daemon 上线。</p>`;
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
        <label class="checkbox-row">
          <input type="checkbox" data-action="toggle" ${enabled ? 'checked' : ''}>
          <strong>默认进 oncall 模式</strong>
          <small>（所有未绑定的群下次开话题自动绑）</small>
        </label>
        <div class="bd-row">
          <label>
            <span>默认工作目录</span>
            <input type="text" data-input="workingDir" placeholder="e.g. /root/iserver/botmux"
              value="${escapeHtml(def.workingDir ?? '')}" ${enabled ? '' : 'disabled'}>
          </label>
        </div>
        <div class="bd-meta">
          <small>上次启用时间：${escapeHtml(fmtSince(def.since ?? 0))}</small>
          <small>已自动绑定 ${b.autoboundChatCount ?? 0} 个群</small>
        </div>
        <div class="actions">
          <button type="button" data-action="save">Save</button>
          <span class="oncall-status" data-status></span>
        </div>
      </div>
    </article>`;
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
          statusEl.textContent = '开启时必须填工作目录';
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
    });
  }

  rerender();
  form.addEventListener('input', rerender);
}
