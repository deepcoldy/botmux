import { botAvatarHtml, escapeHtml, loadingHtml, t } from './ui.js';

interface SkillRow {
  name: string;
  description?: string;
  tags?: string[];
  source?: Record<string, any>;
  rootDir?: string;
}

interface NativeSkillGroup {
  cliId: string;
  rootDir: string;
  skills: SkillRow[];
  /** Tab label (Claude plugin / marketplace groups set this); falls back to cliId. */
  label?: string;
}

interface BotRow {
  larkAppId: string;
  botName?: string;
  online?: boolean;
  error?: string;
  skills?: SkillPolicy | null;
}

interface SkillPolicy {
  include?: string[];
}

interface DashboardRequestError extends Error {
  status?: number;
  body?: any;
}

interface SkillJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  error?: string;
}

let state: {
  skills: SkillRow[];
  nativeSkillGroups: NativeSkillGroup[];
  bots: BotRow[];
  trustProjectSkills: 'off' | 'all';
  delivery: 'auto' | 'prompt' | 'native';
} = { skills: [], nativeSkillGroups: [], bots: [], trustProjectSkills: 'off', delivery: 'auto' };
let loadError: string | null = null;
const INSTALLED_SKILLS_ROWS_PER_PAGE = 2;
let installedSkillsPage = 0;
let activeDiscoveryGroupKey: string | null = null;

function pageHtml(): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('nav.skills')}</p>
        <h1>${t('skills.title')}</h1>
        <p>${t('skills.subtitle')}</p>
      </div>
      <button type="button" id="skills-refresh">${t('skills.refresh')}</button>
    </div>
    <div id="skills-body"></div>
  </section>`;
}

function sourceLabel(skill: SkillRow): string {
  const source = skill.source ?? {};
  if (source.type === 'github') return `github:${source.owner}/${source.repo}/${source.path ?? ''}`;
  if (source.type === 'git') return `${source.url ?? 'git'}#${source.path ?? ''}`;
  if (source.type === 'local-link') return nativeLibraryLabel(source.path) ?? t('skills.sourceLocalLink');
  if (source.type === 'local-copy') return t('skills.sourceBotmuxCopy');
  return String(source.type ?? 'unknown');
}

function nativeLibraryLabel(path?: string): string | null {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (p.includes('/.codex/skills/')) return t('skills.sourceCodex');
  if (p.includes('/.claude/skills/')) return t('skills.sourceClaude');
  if (p.includes('/.trae/skills/')) return t('skills.sourceTrae');
  if (p.includes('/.cursor/skills/')) return t('skills.sourceCursor');
  if (p.includes('/.gemini/skills/')) return t('skills.sourceGemini');
  if (p.includes('/.config/opencode/skills/')) return t('skills.sourceOpenCode');
  return null;
}

function priorityNames(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter((item) => item.startsWith('skill:'))
    .map((item) => item.slice('skill:'.length));
}

function policyReferenceCount(policy?: SkillPolicy | null): number {
  return priorityNames(policy).length;
}

function policyConfigured(policy?: SkillPolicy | null): boolean {
  return priorityNames(policy).length > 0;
}

function installedSkillNames(): Set<string> {
  return new Set(state.skills.map(skill => skill.name));
}

function discoveryGroupKey(group: NativeSkillGroup): string {
  return `${group.cliId}\n${group.rootDir}`;
}

function discoveryGroups(): NativeSkillGroup[] {
  return state.nativeSkillGroups;
}

function activeDiscoveryGroup(groups: NativeSkillGroup[]): NativeSkillGroup | undefined {
  if (groups.length === 0) return undefined;
  const active = activeDiscoveryGroupKey
    ? groups.find(group => discoveryGroupKey(group) === activeDiscoveryGroupKey)
    : undefined;
  const fallback = active ?? groups.find(group => group.skills.length > 0) ?? groups[0];
  activeDiscoveryGroupKey = discoveryGroupKey(fallback);
  return fallback;
}

function referencingBotLabels(skillName: string): string[] {
  return state.bots
    .filter(bot => priorityNames(bot.skills).includes(skillName))
    .map(bot => bot.botName ?? bot.larkAppId);
}

function renderInstallForm(): string {
  return `<article class="bd-card skills-install-panel">
    <div class="skills-install-title">
      <h3 class="bd-section-title">${t('skills.install')}</h3>
      <span class="skills-help-tip">
        <button type="button" class="skills-help-button" aria-label="${t('skills.installInfoLabel')}">?</button>
        <span class="skills-help-popover" role="tooltip">${t('skills.installInfo')}</span>
      </span>
    </div>
    <div class="skills-install-grid">
      <label class="skills-source-label"><span>${t('skills.source')}</span>
        <div class="skills-source-control">
          <input type="text" data-install="source" placeholder="${t('skills.sourcePlaceholder')}">
          <button type="button" data-action="discover-native-skills">${t('skills.discover')}</button>
        </div>
      </label>
      <div class="bd-section-note skills-install-note">
        <span><strong>${t('skills.sourceHelpRemoteLabel')}</strong>${t('skills.sourceHelpRemote')}</span>
        <span><strong>${t('skills.sourceHelpLocalLabel')}</strong>${t('skills.sourceHelpLocal')}</span>
      </div>
      <label class="skills-install-field-wide"><span>${t('skills.path')}</span>
        <input type="text" data-install="path" placeholder="${t('skills.pathPlaceholder')}">
      </label>
      <label class="skills-install-field-wide"><span>${t('skills.ref')}</span>
        <input type="text" data-install="ref" placeholder="${t('skills.refPlaceholder')}">
      </label>
    </div>
    <div class="actions">
      <button type="button" class="primary" data-action="install">${t('skills.installSubmit')}</button>
      <span class="oncall-status" data-skills-status></span>
    </div>
  </article>`;
}

function renderDiscoveryDialog(): string {
  const installed = installedSkillNames();
  const groups = discoveryGroups();
  const active = activeDiscoveryGroup(groups);
  const content = !active
    ? `<p class="empty">${t('skills.discoverEmpty')}</p>`
    : `<div class="skills-discovery-tabs" role="tablist" aria-label="${t('skills.discoverTitle')}">
        ${groups.map(group => {
          const key = discoveryGroupKey(group);
          const selected = key === discoveryGroupKey(active);
          return `<button type="button" role="tab" data-discovery-tab="${escapeHtml(key)}" class="${selected ? 'selected' : ''}" aria-selected="${selected ? 'true' : 'false'}">
            <strong>${escapeHtml(group.label ?? group.cliId)}</strong>
            <small>${t('skills.skillCount', { count: group.skills.length })}</small>
          </button>`;
        }).join('')}
      </div>
      <div class="skills-discovery-path"><code>${escapeHtml(active.rootDir)}</code></div>
      ${groups.map(group => {
        const key = discoveryGroupKey(group);
        const selected = active && key === discoveryGroupKey(active);
        return `<section class="skills-discovery-group" data-discovery-panel="${escapeHtml(key)}" ${selected ? '' : 'hidden'}>
          ${group.skills.length === 0
            ? `<p class="empty">${t('skills.discoverGroupEmpty')}</p>`
            : `<div class="skills-discovery-list">
              ${group.skills.map(skill => {
                const already = installed.has(skill.name);
                const path = skill.rootDir ?? skill.source?.root ?? '';
                return `<label class="skills-discovery-row${already ? ' installed' : ''}">
                  <input type="checkbox" data-discovered-skill value="${escapeHtml(path)}" ${already ? 'disabled' : ''}>
                  <span>
                    <strong>${escapeHtml(skill.name)}</strong>
                    ${skill.description ? `<small>${escapeHtml(skill.description)}</small>` : ''}
                  </span>
                  ${already ? `<em>${t('skills.discoverRegistered')}</em>` : ''}
                </label>`;
              }).join('')}
            </div>`}
        </section>`;
      }).join('')}`;
  return `<dialog class="skills-discovery-dialog" id="skills-discovery-dialog">
    <article>
      <header>
        <h3>${t('skills.discoverTitle')}</h3>
        <p>${t('skills.discoverHelp')}</p>
      </header>
      <div class="skills-discovery-body">${content}</div>
      <footer class="actions">
        <button type="button" data-action="toggle-discovered-skills">${t('skills.discoverSelectAll')}</button>
        <button type="button" class="primary" data-action="register-discovered-skills">${t('skills.discoverRegister')}</button>
        <button type="button" data-action="close-discovery">${t('skills.discoverClose')}</button>
      </footer>
    </article>
  </dialog>`;
}

function renderInstalledSkills(): string {
  if (state.skills.length === 0) return `<p class="empty">${t('skills.empty')}</p>`;
  clampInstalledSkillsPage();
  const pageSize = installedSkillsPageSize();
  const start = installedSkillsPage * pageSize;
  const visibleSkills = state.skills.slice(start, start + pageSize);
  return `<div class="skills-list">${visibleSkills.map(skill => `
    <article class="skills-row skills-installed-card" data-skill="${escapeHtml(skill.name)}">
      <div class="skills-row-body">
        <strong>${escapeHtml(skill.name)}</strong>
        ${skill.description ? `<p>${escapeHtml(skill.description)}</p>` : ''}
        <small class="skills-source-badge">${escapeHtml(sourceLabel(skill))}</small>
      </div>
      <div class="skills-card-actions">
        <button type="button" data-action="update-skill">${t('skills.update')}</button>
        <button type="button" data-action="remove-skill">${t('skills.remove')}</button>
      </div>
    </article>`).join('')}</div>`;
}

function installedSkillsColumnCount(): number {
  const width = typeof window === 'undefined' ? 1440 : window.innerWidth;
  if (width >= 1600) return 4;
  if (width <= 620) return 1;
  if (width <= 980) return 2;
  return 3;
}

function installedSkillsPageSize(): number {
  return installedSkillsColumnCount() * INSTALLED_SKILLS_ROWS_PER_PAGE;
}

function installedSkillsPageCount(): number {
  return Math.max(1, Math.ceil(state.skills.length / installedSkillsPageSize()));
}

function clampInstalledSkillsPage(): void {
  installedSkillsPage = Math.min(Math.max(0, installedSkillsPage), installedSkillsPageCount() - 1);
}

function renderInstalledToolbar(): string {
  clampInstalledSkillsPage();
  const count = `<span class="skills-count-pill">${t('skills.skillCount', { count: state.skills.length })}</span>`;
  const pageCount = installedSkillsPageCount();
  if (pageCount <= 1) return count;
  return `<div class="skills-installed-toolbar">
    ${count}
    <div class="skills-pager">
      <button type="button" class="skills-pager-button" data-action="page-installed-skills" data-dir="-1" aria-label="${t('skills.prevPage')}" title="${t('skills.prevPage')}" ${installedSkillsPage === 0 ? 'disabled' : ''}>&lsaquo;</button>
      <span>${t('skills.pageStatus', { page: installedSkillsPage + 1, pages: pageCount })}</span>
      <button type="button" class="skills-pager-button" data-action="page-installed-skills" data-dir="1" aria-label="${t('skills.nextPage')}" title="${t('skills.nextPage')}" ${installedSkillsPage >= pageCount - 1 ? 'disabled' : ''}>&rsaquo;</button>
    </div>
  </div>`;
}

function renderGlobalPolicy(): string {
  const deliveryOptions = [
    ['auto', t('skills.deliveryAuto'), t('skills.deliveryAutoHelp')],
    ['prompt', t('skills.deliveryPrompt'), t('skills.deliveryPromptHelp')],
    ['native', t('skills.deliveryNative'), t('skills.deliveryNativeHelp')],
  ];
  return `<article class="bd-card skills-defaults-panel">
    <h3 class="bd-section-title">${t('skills.globalDefaults')}</h3>
    <div class="skills-control-block">
      <span class="skills-control-label">${t('skills.globalProject')}</span>
      <div class="skills-choice-group skills-choice-group-compact skills-project-group">
        ${[
          ['off', t('skills.globalProjectOff'), t('skills.globalProjectOffHelp')],
          ['all', t('skills.globalProjectAll'), t('skills.globalProjectAllHelp')],
        ].map(([value, label, help]) => `<button type="button" class="skills-choice${state.trustProjectSkills === value ? ' selected' : ''}" data-global-project-value="${value}" aria-pressed="${state.trustProjectSkills === value ? 'true' : 'false'}">
          <strong>${label}</strong><small>${help}</small>
        </button>`).join('')}
      </div>
    </div>
    <div class="skills-control-block">
      <span class="skills-control-label">${t('skills.globalDelivery')}</span>
      <div class="skills-choice-group skills-delivery-group">
        ${deliveryOptions.map(([value, label, help]) => `<button type="button" class="skills-choice${state.delivery === value ? ' selected' : ''}" data-global-delivery-value="${value}" aria-pressed="${state.delivery === value ? 'true' : 'false'}">
          <strong>${label}</strong><small>${help}</small>
        </button>`).join('')}
      </div>
    </div>
  </article>`;
}

function renderSkillPicker(bot: BotRow): string {
  const attached = new Set(priorityNames(bot.skills));
  const options = state.skills.filter(skill => !attached.has(skill.name));
  if (options.length === 0) return `<button type="button" disabled>${t('skills.attach')}</button>`;
  return `<select data-attach-picker>
    ${options.map(skill => `<option value="${escapeHtml(skill.name)}">${escapeHtml(skill.name)}</option>`).join('')}
  </select>
  <button type="button" data-action="attach-skill">${t('skills.attach')}</button>`;
}

function renderBotPolicy(bot: BotRow): string {
  if (bot.error) {
    return `<article class="bd-card skills-bot-card" data-appid="${escapeHtml(bot.larkAppId)}">
      <header>${botAvatarHtml({ name: bot.botName ?? bot.larkAppId, larkAppId: bot.larkAppId, size: 'sm' })}
      <strong>${escapeHtml(bot.botName ?? bot.larkAppId)}</strong></header>
      <p class="hint-warn-inline">${escapeHtml(bot.error)}</p>
    </article>`;
  }
  const names = priorityNames(bot.skills);
  const installed = installedSkillNames();
  return `<article class="bd-card skills-bot-card" data-appid="${escapeHtml(bot.larkAppId)}">
    <header class="skills-bot-head">
      ${botAvatarHtml({ name: bot.botName ?? bot.larkAppId, larkAppId: bot.larkAppId, size: 'sm', dot: 'ok' })}
      <div><strong>${escapeHtml(bot.botName ?? bot.larkAppId)}</strong><code>${escapeHtml(bot.larkAppId)}</code></div>
      <span class="skills-count-pill">${t('skills.skillCount', { count: names.length })}</span>
    </header>
    <section class="bd-section">
      <h3 class="bd-section-title">${t('skills.priority')}</h3>
      ${names.length === 0
        ? `<p class="bd-section-note">${t('skills.noPriority')}</p>`
        : `<div class="skills-chip-list">${names.map(name => {
          const dangling = !installed.has(name);
          return `<span class="skills-priority-row${dangling ? ' skills-priority-dangling' : ''}" title="${dangling ? escapeHtml(t('skills.dangling')) : ''}">
            <span class="skills-priority-name">${escapeHtml(name)}${dangling ? `<small>${t('skills.dangling')}</small>` : ''}</span>
            <button type="button" class="skills-priority-remove" data-action="detach-skill" data-name="${escapeHtml(name)}" aria-label="${escapeHtml(t('skills.detachNamed', { skill: name }))}">&times;</button>
          </span>`;
        }).join('')}</div>`}
      <div class="actions skills-attach-row">${renderSkillPicker(bot)}</div>
    </section>
    <span class="oncall-status" data-bot-status></span>
  </article>`;
}

function attachedSkillRefCount(): number {
  return state.bots.reduce((sum, bot) => sum + policyReferenceCount(bot.skills), 0);
}

function configuredBotCount(): number {
  return state.bots.filter(bot => policyConfigured(bot.skills)).length;
}

function renderOverview(): string {
  return `<section class="skills-overview">
    <div class="skills-overview-copy">
      <h2>${t('skills.overviewTitle')}</h2>
      <p>${t('skills.overviewBody')}</p>
    </div>
    <div class="skills-metric-strip">
      <span><small>${t('skills.metricInstalled')}</small><strong>${state.skills.length}</strong></span>
      <span><small>${t('skills.metricBots')}</small><strong>${configuredBotCount()}/${state.bots.length}</strong></span>
      <span><small>${t('skills.metricAttached')}</small><strong>${attachedSkillRefCount()}</strong></span>
    </div>
  </section>`;
}

function renderBotRailActions(): string {
  const count = `<span class="skills-count-pill">${t('skills.botCount', { count: state.bots.length })}</span>`;
  if (state.bots.length <= 3) return count;
  return `<div class="skills-bot-rail-actions">
    <button type="button" class="skills-rail-button" data-action="scroll-bots" data-dir="-1" aria-label="${t('skills.scrollBotsPrev')}" title="${t('skills.scrollBotsPrev')}">&lsaquo;</button>
    ${count}
    <button type="button" class="skills-rail-button" data-action="scroll-bots" data-dir="1" aria-label="${t('skills.scrollBotsNext')}" title="${t('skills.scrollBotsNext')}">&rsaquo;</button>
  </div>`;
}

function renderBody(): string {
  if (loadError) return `<p class="hint-warn">${escapeHtml(loadError)}</p>`;
  return `<div class="skills-page-grid">
    <aside class="skills-side-rail">
      ${renderGlobalPolicy()}
      ${renderInstallForm()}
    </aside>
    <section class="skills-main-panel">
      ${renderOverview()}
      <section class="skills-bots-panel">
        <div class="skills-section-head skills-section-head-row">
          <div>
            <h2>${t('skills.bots')}</h2>
            <p>${t('skills.botsHelp')}</p>
          </div>
          ${renderBotRailActions()}
        </div>
        <div class="skills-bot-grid">${state.bots.map(renderBotPolicy).join('')}</div>
      </section>
      <section class="bd-card skills-installed-panel">
        <div class="skills-section-head skills-section-head-row">
          <div>
            <h2>${t('skills.installed')}</h2>
            <p>${t('skills.installedHelp')}</p>
          </div>
          ${renderInstalledToolbar()}
        </div>
        ${renderInstalledSkills()}
      </section>
    </section>
    ${renderDiscoveryDialog()}
  </div>`;
}

async function loadData(): Promise<void> {
  try {
    const [skillsRes, botsRes] = await Promise.all([
      fetch('/api/skills'),
      fetch('/api/bots'),
    ]);
    const skillsBody = await skillsRes.json().catch(() => ({}));
    const botsBody = await botsRes.json().catch(() => ({}));
    if (!skillsRes.ok) {
      const error = skillsBody?.error ?? `skills HTTP ${skillsRes.status}`;
      throw new Error(error === 'not_found_yet' || error === 'not_found' ? t('skills.apiUnavailable') : error);
    }
    if (!botsRes.ok) throw new Error(botsBody?.error ?? `bots HTTP ${botsRes.status}`);
    state = {
      skills: Array.isArray(skillsBody.skills) ? skillsBody.skills : [],
      nativeSkillGroups: Array.isArray(skillsBody.nativeSkillGroups) ? skillsBody.nativeSkillGroups : [],
      bots: Array.isArray(botsBody.bots) ? botsBody.bots : [],
      trustProjectSkills: skillsBody.trustProjectSkills === 'all' ? 'all' : 'off',
      delivery: skillsBody.delivery === 'prompt' || skillsBody.delivery === 'native' ? skillsBody.delivery : 'auto',
    };
    clampInstalledSkillsPage();
    loadError = null;
  } catch (err: any) {
    loadError = err?.message ?? String(err);
  }
}

async function jsonRequest(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    const err = new Error(body?.error ?? `HTTP ${r.status}`) as DashboardRequestError;
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function renderSkillsPage(root: HTMLElement): Promise<void> {
  root.innerHTML = pageHtml();
  const bodyEl = root.querySelector<HTMLElement>('#skills-body')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#skills-refresh')!;

  async function refresh(): Promise<void> {
    bodyEl.innerHTML = loadingHtml();
    await loadData();
    rerender();
  }

  function status(scope?: HTMLElement | null): HTMLElement | null {
    return scope?.querySelector<HTMLElement>('[data-skills-status], [data-bot-status]') ?? null;
  }

  function showStatus(el: HTMLElement | null, text: string, ok: boolean): void {
    if (!el) return;
    el.textContent = text;
    el.className = `oncall-status ${ok ? 'hint-ok' : 'hint-warn-inline'}`;
  }

  function setChoiceButtonsDisabled(selector: string, disabled: boolean): void {
    bodyEl.querySelectorAll<HTMLButtonElement>(selector).forEach(button => { button.disabled = disabled; });
  }

  function syncChoiceButtons(selector: string, datasetKey: string, selectedValue: string): void {
    bodyEl.querySelectorAll<HTMLButtonElement>(selector).forEach(button => {
      const selected = button.dataset[datasetKey] === selectedValue;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function rerender(): void {
    bodyEl.innerHTML = renderBody();
    wire();
  }

  async function waitForSkillJob(job: SkillJob, statusEl: HTMLElement | null, refreshOnSuccess = true): Promise<void> {
    let current = job;
    showStatus(statusEl, t('skills.jobRunning'), true);
    for (;;) {
      if (current.status === 'succeeded') {
        showStatus(statusEl, t('skills.saved'), true);
        if (refreshOnSuccess) await refresh();
        return;
      }
      if (current.status === 'failed') {
        throw new Error(current.error ?? 'job_failed');
      }
      await sleep(800);
      const body = await jsonRequest(`/api/skills/jobs/${encodeURIComponent(current.id)}`, { method: 'GET' });
      current = body.job as SkillJob;
    }
  }

  function activeDiscoveryPanel(): HTMLElement | null {
    return bodyEl.querySelector<HTMLElement>('[data-discovery-panel]:not([hidden])');
  }

  function updateDiscoveryToggleButton(): void {
    const button = bodyEl.querySelector<HTMLButtonElement>('[data-action="toggle-discovered-skills"]');
    if (!button) return;
    const inputs = [...(activeDiscoveryPanel()?.querySelectorAll<HTMLInputElement>('[data-discovered-skill]:not(:disabled)') ?? [])];
    const hasUnchecked = inputs.some(input => !input.checked);
    button.textContent = inputs.length > 0 && !hasUnchecked ? t('skills.discoverClearSelection') : t('skills.discoverSelectAll');
    button.disabled = inputs.length === 0;
  }

  function wire(): void {
    bodyEl.querySelector<HTMLButtonElement>('[data-action="install"]')?.addEventListener('click', async () => {
      const panel = bodyEl.querySelector<HTMLElement>('.skills-install-panel');
      const statusEl = status(panel);
      const button = bodyEl.querySelector<HTMLButtonElement>('[data-action="install"]');
      const source = bodyEl.querySelector<HTMLInputElement>('[data-install="source"]')?.value.trim() ?? '';
      const path = bodyEl.querySelector<HTMLInputElement>('[data-install="path"]')?.value.trim() ?? '';
      const ref = bodyEl.querySelector<HTMLInputElement>('[data-install="ref"]')?.value.trim() ?? '';
      try {
        if (button) button.disabled = true;
        const body = await jsonRequest('/api/skills/install', {
          method: 'POST',
          body: JSON.stringify({ source, path: path || undefined, ref: ref || undefined }),
        });
        await waitForSkillJob(body.job as SkillJob, statusEl);
      } catch (err: any) {
        showStatus(statusEl, `${t('skills.failed')}: ${err?.message ?? err}`, false);
      } finally {
        if (button) button.disabled = false;
      }
    });

    bodyEl.querySelector<HTMLButtonElement>('[data-action="discover-native-skills"]')?.addEventListener('click', () => {
      bodyEl.querySelector<HTMLDialogElement>('#skills-discovery-dialog')?.showModal();
      updateDiscoveryToggleButton();
    });

    bodyEl.querySelector<HTMLButtonElement>('[data-action="close-discovery"]')?.addEventListener('click', () => {
      bodyEl.querySelector<HTMLDialogElement>('#skills-discovery-dialog')?.close();
    });

    bodyEl.querySelectorAll<HTMLButtonElement>('[data-discovery-tab]').forEach(button => {
      button.addEventListener('click', () => {
        const key = button.dataset.discoveryTab ?? '';
        activeDiscoveryGroupKey = key;
        bodyEl.querySelectorAll<HTMLButtonElement>('[data-discovery-tab]').forEach(tab => {
          const selected = tab.dataset.discoveryTab === key;
          tab.classList.toggle('selected', selected);
          tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        bodyEl.querySelectorAll<HTMLElement>('[data-discovery-panel]').forEach(panel => {
          panel.hidden = panel.dataset.discoveryPanel !== key;
        });
        const group = state.nativeSkillGroups.find(item => discoveryGroupKey(item) === key);
        const pathEl = bodyEl.querySelector<HTMLElement>('.skills-discovery-path code');
        if (pathEl && group) pathEl.textContent = group.rootDir;
        updateDiscoveryToggleButton();
      });
    });

    bodyEl.querySelectorAll<HTMLInputElement>('[data-discovered-skill]').forEach(input => {
      input.addEventListener('change', updateDiscoveryToggleButton);
    });

    bodyEl.querySelector<HTMLButtonElement>('[data-action="toggle-discovered-skills"]')?.addEventListener('click', () => {
      const inputs = [...(activeDiscoveryPanel()?.querySelectorAll<HTMLInputElement>('[data-discovered-skill]:not(:disabled)') ?? [])];
      const next = inputs.some(input => !input.checked);
      inputs.forEach(input => { input.checked = next; });
      updateDiscoveryToggleButton();
    });

    bodyEl.querySelector<HTMLButtonElement>('[data-action="register-discovered-skills"]')?.addEventListener('click', async () => {
      const dialog = bodyEl.querySelector<HTMLDialogElement>('#skills-discovery-dialog');
      const panel = bodyEl.querySelector<HTMLElement>('.skills-install-panel');
      const statusEl = status(panel);
      const selected = [...bodyEl.querySelectorAll<HTMLInputElement>('[data-discovered-skill]:checked:not(:disabled)')]
        .map(input => input.value)
        .filter(Boolean);
      if (selected.length === 0) {
        showStatus(statusEl, t('skills.discoverNothingSelected'), false);
        return;
      }
      const button = bodyEl.querySelector<HTMLButtonElement>('[data-action="register-discovered-skills"]');
      try {
        if (button) button.disabled = true;
        showStatus(statusEl, t('skills.discoverRegisteringBatch', { total: selected.length }), true);
        await jsonRequest('/api/skills/install-local-links', {
          method: 'POST',
          body: JSON.stringify({ sources: selected }),
        });
        dialog?.close();
        await refresh();
      } catch (err: any) {
        showStatus(statusEl, `${t('skills.failed')}: ${err?.message ?? err}`, false);
      } finally {
        if (button) button.disabled = false;
      }
    });

    bodyEl.querySelectorAll<HTMLButtonElement>('[data-global-project-value]').forEach(button => button.addEventListener('click', async () => {
      const next = button.dataset.globalProjectValue === 'all' ? 'all' : 'off';
      if (state.trustProjectSkills === next) return;
      try {
        setChoiceButtonsDisabled('[data-global-project-value]', true);
        const body = await jsonRequest('/api/skills/global', {
          method: 'PUT',
          body: JSON.stringify({ trustProjectSkills: next }),
        });
        state.trustProjectSkills = body.trustProjectSkills === 'all' ? 'all' : next;
        syncChoiceButtons('[data-global-project-value]', 'globalProjectValue', state.trustProjectSkills);
      } catch (err: any) {
        window.alert(`${t('skills.failed')}: ${err?.message ?? err}`);
      } finally {
        setChoiceButtonsDisabled('[data-global-project-value]', false);
      }
    }));

    bodyEl.querySelectorAll<HTMLButtonElement>('[data-global-delivery-value]').forEach(button => button.addEventListener('click', async () => {
      const next = button.dataset.globalDeliveryValue === 'prompt' || button.dataset.globalDeliveryValue === 'native'
        ? button.dataset.globalDeliveryValue
        : 'auto';
      if (state.delivery === next) return;
      try {
        setChoiceButtonsDisabled('[data-global-delivery-value]', true);
        const body = await jsonRequest('/api/skills/global', {
          method: 'PUT',
          body: JSON.stringify({ delivery: next }),
        });
        state.delivery = body.delivery === 'prompt' || body.delivery === 'native' ? body.delivery : next;
        syncChoiceButtons('[data-global-delivery-value]', 'globalDeliveryValue', state.delivery);
      } catch (err: any) {
        window.alert(`${t('skills.failed')}: ${err?.message ?? err}`);
      } finally {
        setChoiceButtonsDisabled('[data-global-delivery-value]', false);
      }
    }));

    bodyEl.querySelectorAll<HTMLButtonElement>('[data-action="scroll-bots"]').forEach(button => button.addEventListener('click', () => {
      const grid = bodyEl.querySelector<HTMLElement>('.skills-bot-grid');
      const card = grid?.querySelector<HTMLElement>('.skills-bot-card');
      if (!grid || !card) return;
      const style = window.getComputedStyle(grid);
      const gap = Number.parseFloat(style.columnGap || style.gap || '0') || 0;
      const dir = button.dataset.dir === '-1' ? -1 : 1;
      grid.scrollBy({ left: dir * (card.getBoundingClientRect().width + gap), behavior: 'smooth' });
    }));

    bodyEl.querySelectorAll<HTMLButtonElement>('[data-action="page-installed-skills"]').forEach(button => button.addEventListener('click', () => {
      const dir = button.dataset.dir === '-1' ? -1 : 1;
      installedSkillsPage += dir;
      clampInstalledSkillsPage();
      rerender();
    }));

    bodyEl.querySelectorAll<HTMLElement>('.skills-row').forEach(row => {
      const name = row.dataset.skill ?? '';
      row.querySelector<HTMLButtonElement>('[data-action="update-skill"]')?.addEventListener('click', async () => {
        const button = row.querySelector<HTMLButtonElement>('[data-action="update-skill"]');
        const panel = bodyEl.querySelector<HTMLElement>('.skills-install-panel');
        const statusEl = status(panel);
        try {
          if (button) button.disabled = true;
          const body = await jsonRequest(`/api/skills/${encodeURIComponent(name)}/update`, { method: 'POST', body: '{}' });
          await waitForSkillJob(body.job as SkillJob, statusEl);
        } catch (err: any) {
          window.alert(`${t('skills.failed')}: ${err?.message ?? err}`);
        } finally {
          if (button) button.disabled = false;
        }
      });
      row.querySelector<HTMLButtonElement>('[data-action="remove-skill"]')?.addEventListener('click', async () => {
        if (!window.confirm(`${t('skills.remove')} ${name}?`)) return;
        try {
          await jsonRequest(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' });
          await refresh();
        } catch (err: any) {
          if (err?.status === 409 && err?.body?.error === 'skill_in_use') {
            const affected = Array.isArray(err.body.affectedBots)
              ? err.body.affectedBots.map((bot: any) => {
                const label = bot?.botName || bot?.larkAppId;
                return label ? `${label}` : '';
              }).filter(Boolean)
              : referencingBotLabels(name);
            const refs = [
              affected.length ? `Bot: ${affected.join(', ')}` : '',
            ].filter(Boolean).join('; ') || '-';
            if (!window.confirm(t('skills.removeInUse', { skill: name, refs }))) return;
            try {
              await jsonRequest(`/api/skills/${encodeURIComponent(name)}?force=1`, { method: 'DELETE', body: '{}' });
              await refresh();
              return;
            } catch (forceErr: any) {
              window.alert(`${t('skills.failed')}: ${forceErr?.message ?? forceErr}`);
              return;
            }
          }
          window.alert(`${t('skills.failed')}: ${err?.message ?? err}`);
        }
      });
    });

    bodyEl.querySelectorAll<HTMLElement>('.skills-bot-card').forEach(card => {
      const appId = card.dataset.appid ?? '';
      const bot = state.bots.find(b => b.larkAppId === appId);
      if (!bot) return;
      card.querySelector<HTMLButtonElement>('[data-action="attach-skill"]')?.addEventListener('click', async () => {
        const name = card.querySelector<HTMLSelectElement>('[data-attach-picker]')?.value;
        if (!name) return;
        try {
          const body = await jsonRequest(`/api/bots/${encodeURIComponent(appId)}/skills`, {
            method: 'PUT',
            body: JSON.stringify({ action: 'attach', name }),
          });
          bot.skills = body.skills ?? null;
          rerender();
        } catch (err: any) {
          showStatus(status(card), `${t('skills.failed')}: ${err?.message ?? err}`, false);
        }
      });
      card.querySelectorAll<HTMLButtonElement>('[data-action="detach-skill"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          if (!name) return;
          try {
            const body = await jsonRequest(`/api/bots/${encodeURIComponent(appId)}/skills`, {
              method: 'PUT',
              body: JSON.stringify({ action: 'detach', name }),
            });
            bot.skills = body.skills ?? null;
            rerender();
          } catch (err: any) {
            showStatus(status(card), `${t('skills.failed')}: ${err?.message ?? err}`, false);
          }
        });
      });
    });
  }

  refreshBtn.onclick = () => { void refresh(); };
  await refresh();
}
