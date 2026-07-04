import { t, escapeHtml } from './ui.js';

type OnboardingStatus =
  | 'starting'
  | 'waiting_for_scan'
  | 'verifying'
  | 'configuring_permissions'
  | 'waiting_for_platform_scan'
  | 'needs_owner'
  | 'completed'
  | 'failed';

type OnboardingPermission = {
  ok: boolean;
  scopeCount?: number;
  skippedScopeCount?: number;
  versionId?: string;
  scopeWarning?: string;
  reason?: string;
  message?: string;
};

type RemainingStep = { title: string; url: string };

type OnboardingJob = {
  id: string;
  status: OnboardingStatus;
  qrUrl?: string;
  qrDataUrl?: string;
  platformQrDataUrl?: string;
  permissionStatusMsg?: string;
  appId?: string;
  cliId?: string;
  workingDir?: string;
  addedBotIndex?: number;
  liveStarted?: boolean;
  liveStartMessage?: string;
  permission?: OnboardingPermission;
  remainingSteps?: RemainingStep[];
  error?: string;
  message?: string;
};

type CliOption = {
  id: string;
  label: string;
  // ttadk 网关项 (后端 /api/cli-options 标注): 选中时模型框默认成 ttadk 默认模型 + 挂候选.
  gateway?: 'ttadk';
  acceptsModel?: boolean; // ttadk 子命令是否接受 -m (CoCo 为 false)
};

let dialog: HTMLDialogElement | null = null;
let pollTimer: number | null = null;
// ttadk 模型默认值 + 候选 (随 /api/cli-options 一起拉取, 单一事实源在 cli-selection).
let ttadkModelDefault = 'glm-5.1';
let ttadkModelSuggestions: string[] = [];

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'onboarding-dialog';
  document.body.appendChild(dialog);
  dialog.addEventListener('close', stopPolling);
  return dialog;
}

function statusText(job: OnboardingJob): string {
  if (job.status === 'waiting_for_scan') return t('botOnboarding.waiting');
  if (job.status === 'verifying') return t('botOnboarding.verifying');
  if (job.status === 'configuring_permissions') {
    return job.permissionStatusMsg
      ? `${t('botOnboarding.configuringPermissions')} ${job.permissionStatusMsg}`
      : t('botOnboarding.configuringPermissions');
  }
  if (job.status === 'waiting_for_platform_scan') return t('botOnboarding.platformScanHint');
  if (job.status === 'needs_owner') return t('botOnboarding.needsOwner');
  if (job.status === 'completed') return t('botOnboarding.completed');
  if (job.status === 'failed') return `${t('botOnboarding.failed')}: ${escapeHtml(job.message ?? job.error ?? 'unknown')}`;
  return t('botOnboarding.starting');
}

/** 完成页 / 待填 owner 页的权限摘要 / 手动兜底步骤. */
function permissionBlock(job: OnboardingJob): string {
  if ((job.status !== 'completed' && job.status !== 'needs_owner') || !job.permission) return '';
  const p = job.permission;
  if (p.ok) {
    const parts = [t('botOnboarding.permissionOk', { count: p.scopeCount ?? 0 })];
    if (p.skippedScopeCount && p.skippedScopeCount > 0) {
      parts.push(t('botOnboarding.permissionSkipped', { count: p.skippedScopeCount }));
    }
    if (p.versionId) parts.push(t('botOnboarding.permissionVersion', { version: escapeHtml(p.versionId) }));
    let html = `<p class="hint-ok">✅ ${parts.join(' ')}</p>`;
    if (p.scopeWarning) html += `<p class="hint-warn">⚠️ ${escapeHtml(p.scopeWarning)}</p>`;
    return html;
  }
  // 自动配置失败 → 手动步骤深链
  const steps = (job.remainingSteps ?? [])
    .map(s => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></li>`)
    .join('');
  return `<p class="hint-warn">⚠️ ${t('botOnboarding.permissionManual')}${p.message ? `（${escapeHtml(p.message)}）` : ''}</p>`
    + (steps ? `<ol class="onboarding-steps">${steps}</ol>` : '');
}

/** needs_owner：扫码人身份验证不了, 让用户手动填 owner (带内联报错). */
function ownerBlock(job: OnboardingJob, ownerError?: string): string {
  if (job.status !== 'needs_owner') return '';
  const errorHtml = ownerError ? `<p class="form-error">${escapeHtml(ownerError)}</p>` : '';
  return `<form id="ob-owner-form" class="onboarding-form">
      <label class="onboarding-field">
        <span>${t('botOnboarding.ownerLabel')}</span>
        <input id="ob-owner" type="text" placeholder="${t('botOnboarding.ownerPlaceholder')}" autocomplete="off" spellcheck="false">
      </label>
      <p class="hint-warn">${t('botOnboarding.ownerHint')}</p>
      ${errorHtml}
      <menu class="onboarding-actions">
        <button type="submit" class="primary">${t('botOnboarding.ownerSubmit')}</button>
      </menu>
    </form>`;
}

function renderJob(job: OnboardingJob, ownerError?: string): void {
  const d = ensureDialog();
  // 第 1 个二维码: 扫码建应用
  const appQr = job.status === 'waiting_for_scan' && job.qrDataUrl
    ? `<div class="qr-card">
        <img class="qr-image" src="${job.qrDataUrl}" alt="${t('botOnboarding.qrAlt')}">
        ${job.qrUrl ? `<a class="onboarding-link" href="${escapeHtml(job.qrUrl)}" target="_blank" rel="noopener">${t('botOnboarding.openLink')}</a>` : ''}
      </div>`
    : '';
  // 第 2 个二维码: 扫码登录开放平台 (自动配权限用; 它是 payload, 没有可点链接)
  const platformQr = job.status === 'waiting_for_platform_scan' && job.platformQrDataUrl
    ? `<div class="qr-card">
        <img class="qr-image" src="${job.platformQrDataUrl}" alt="${t('botOnboarding.platformQrAlt')}">
      </div>`
    : '';
  const metaLine = job.appId
    ? `<p><b>App ID:</b> <code>${escapeHtml(job.appId)}</code>`
      + (job.cliId ? ` ｜ <b>CLI:</b> <code>${escapeHtml(job.cliId)}</code>` : '')
      + (job.workingDir ? ` ｜ <b>${t('botOnboarding.metaDir')}:</b> <code>${escapeHtml(job.workingDir)}</code>` : '')
      + `</p>`
    : '';
  // 落盘完成后：新 bot 已自动上线（start-bot 成功）→ 「无需重启」；否则回退到重启提示。
  const restartHint = job.status === 'completed'
    ? (job.liveStarted
        ? `<p class="hint-ok">${t('botOnboarding.liveOk')}</p>`
        : `<p class="hint-ok">${t('botOnboarding.restartHint')}</p>`)
    : '';
  d.innerHTML = `<article>
    <header>
      <h3>${t('botOnboarding.title')}</h3>
      <p>${t('botOnboarding.intro')}</p>
    </header>
    <p class="onboarding-status status-${job.status}">${statusText(job)}</p>
    ${appQr}
    ${platformQr}
    ${metaLine}
    ${permissionBlock(job)}
    ${ownerBlock(job, ownerError)}
    ${restartHint}
    <form method="dialog"><button>${t('botOnboarding.close')}</button></form>
  </article>`;

  // needs_owner：把提交挂上去 (走 /owner 端点, 通过校验后转 completed)。
  if (job.status === 'needs_owner') {
    const ownerForm = d.querySelector<HTMLFormElement>('#ob-owner-form');
    ownerForm?.addEventListener('submit', ev => {
      ev.preventDefault();
      const owner = d.querySelector<HTMLInputElement>('#ob-owner')?.value ?? '';
      void submitOwner(job, owner);
    });
  }
}

async function submitOwner(job: OnboardingJob, ownerRaw: string): Promise<void> {
  if (!ownerRaw.trim()) {
    renderJob(job, t('botOnboarding.ownerEmpty'));
    return;
  }
  try {
    const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(job.id)}/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: ownerRaw.trim() }),
    });
    const body = await res.json();
    if (!res.ok) {
      // 校验失败 (格式 / 不可用): 留在 needs_owner 内联报错, 不丢已填值的语义。
      renderJob(job, body?.message ?? body?.error ?? t('botOnboarding.ownerInvalid'));
      return;
    }
    if (body?.job) renderJob(body.job);
  } catch (err) {
    renderJob(job, err instanceof Error ? err.message : String(err));
  }
}

async function fetchCliOptions(): Promise<CliOption[]> {
  try {
    const res = await fetch('/api/cli-options');
    const body = await res.json();
    if (res.ok && Array.isArray(body?.options)) {
      if (typeof body.ttadkModelDefault === 'string' && body.ttadkModelDefault.trim()) {
        ttadkModelDefault = body.ttadkModelDefault.trim();
      }
      if (Array.isArray(body.ttadkModelSuggestions)) {
        ttadkModelSuggestions = body.ttadkModelSuggestions.filter((s: unknown): s is string => typeof s === 'string');
      }
      return body.options as CliOption[];
    }
  } catch { /* fall through to default */ }
  return [{ id: 'claude-code', label: 'Claude' }];
}

/**
 * 根据当前选中的 CLI 调整模型输入框：
 *   - ttadk 网关 (接受 -m): 候选下拉 + 默认值 (空框时回填 ttadk 默认模型)
 *   - ttadk CoCo (不接受 -m): 禁用并提示无需模型
 *   - 其它 CLI: 普通占位, 留空走 CLI 默认模型
 * 仅在切换到「之前不是同类」时回填默认值, 不覆盖用户已手填的内容。
 */
function syncModelFieldForCli(opts: CliOption[]): void {
  const d = dialog;
  if (!d) return;
  const cli = d.querySelector<HTMLSelectElement>('#ob-cli');
  const model = d.querySelector<HTMLInputElement>('#ob-model');
  const list = d.querySelector<HTMLDataListElement>('#ob-model-suggestions');
  if (!cli || !model) return;
  const opt = opts.find(o => o.id === cli.value);
  const isTtadk = opt?.gateway === 'ttadk';
  const acceptsModel = isTtadk && opt?.acceptsModel !== false;

  if (isTtadk && !acceptsModel) {
    // CoCo: ttadk 不接受 -m
    model.value = '';
    model.disabled = true;
    model.placeholder = t('botOnboarding.modelTtadkCocoPlaceholder');
    return;
  }
  model.disabled = false;
  if (acceptsModel) {
    if (list) list.innerHTML = ttadkModelSuggestions.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
    model.placeholder = t('botOnboarding.modelTtadkPlaceholder').replace('{model}', ttadkModelDefault);
    // 切到 ttadk 且用户没手填 → 回填默认模型, 让「不写 wrapper、开箱即用」成立.
    if (!model.value.trim()) model.value = ttadkModelDefault;
  } else {
    if (list) list.innerHTML = '';
    model.placeholder = t('botOnboarding.modelPlaceholder');
    // 从 ttadk 切回普通 CLI: 清掉之前回填的 ttadk 默认模型, 避免误带.
    if (model.value.trim() === ttadkModelDefault) model.value = '';
  }
}

function renderForm(options: CliOption[], errorMsg?: string): void {
  const d = ensureDialog();
  const optionHtml = options
    .map(o => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}（${escapeHtml(o.id)}）</option>`)
    .join('');
  const errorHtml = errorMsg ? `<p class="form-error">${escapeHtml(errorMsg)}</p>` : '';
  d.innerHTML = `<article>
    <header>
      <h3>${t('botOnboarding.title')}</h3>
      <p>${t('botOnboarding.intro')}</p>
    </header>
    <form id="onboarding-form" class="onboarding-form">
      <label class="onboarding-field">
        <span>${t('botOnboarding.cliLabel')}</span>
        <select id="ob-cli">${optionHtml}</select>
      </label>
      <label class="onboarding-field">
        <span>${t('botOnboarding.dirModeLabel')}</span>
        <select id="ob-dir-mode">
          <option value="fixed">${t('botOnboarding.dirModeFixed')}</option>
          <option value="card">${t('botOnboarding.dirModeCard')}</option>
        </select>
      </label>
      <label class="onboarding-field">
        <span id="ob-dir-label">${t('botOnboarding.dirLabelFixed')}</span>
        <input id="ob-dir" type="text" value="~" placeholder="${t('botOnboarding.dirPlaceholderFixed')}" autocomplete="off" spellcheck="false">
      </label>
      <label class="onboarding-field">
        <span>${t('botOnboarding.modelLabel')}</span>
        <input id="ob-model" type="text" list="ob-model-suggestions" placeholder="${t('botOnboarding.modelPlaceholder')}" autocomplete="off" spellcheck="false">
        <datalist id="ob-model-suggestions"></datalist>
      </label>
      ${errorHtml}
      <menu class="onboarding-actions">
        <button type="button" id="ob-cancel">${t('botOnboarding.cancel')}</button>
        <button type="submit" class="primary">${t('botOnboarding.startScan')}</button>
      </menu>
    </form>
  </article>`;

  const form = d.querySelector<HTMLFormElement>('#onboarding-form');
  const cancel = d.querySelector<HTMLButtonElement>('#ob-cancel');
  cancel?.addEventListener('click', () => d.close());
  // ttadk 网关项: 选中时把模型框默认成 ttadk 默认模型 + 挂候选 (CoCo 禁用).
  const cliSelect = d.querySelector<HTMLSelectElement>('#ob-cli');
  cliSelect?.addEventListener('change', () => syncModelFieldForCli(options));
  syncModelFieldForCli(options);
  // 目录模式切换时同步目录框的标签/占位文案（fixed=固定默认目录 / card=扫描根）。
  const dirModeSelect = d.querySelector<HTMLSelectElement>('#ob-dir-mode');
  const syncDirField = () => {
    const mode = dirModeSelect?.value === 'card' ? 'card' : 'fixed';
    const label = d.querySelector<HTMLSpanElement>('#ob-dir-label');
    const dirInput = d.querySelector<HTMLInputElement>('#ob-dir');
    if (label) label.textContent = mode === 'card' ? t('botOnboarding.dirLabelCard') : t('botOnboarding.dirLabelFixed');
    if (dirInput) dirInput.placeholder = mode === 'card' ? t('botOnboarding.dirPlaceholderCard') : t('botOnboarding.dirPlaceholderFixed');
  };
  dirModeSelect?.addEventListener('change', syncDirField);
  form?.addEventListener('submit', ev => {
    ev.preventDefault();
    const cliId = d.querySelector<HTMLSelectElement>('#ob-cli')?.value ?? '';
    const workingDir = d.querySelector<HTMLInputElement>('#ob-dir')?.value ?? '';
    const dirMode = d.querySelector<HTMLSelectElement>('#ob-dir-mode')?.value === 'card' ? 'card' : 'fixed';
    const model = d.querySelector<HTMLInputElement>('#ob-model')?.value ?? '';
    void startOnboarding({ cliId, workingDir, dirMode, model }, options);
  });
}

async function startOnboarding(
  input: { cliId: string; workingDir: string; dirMode: 'fixed' | 'card'; model: string },
  options: CliOption[],
): Promise<void> {
  stopPolling();
  renderJob({ id: '', status: 'starting' });
  try {
    const res = await fetch('/api/bot-onboarding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cliId: input.cliId,
        workingDir: input.workingDir.trim(),
        dirMode: input.dirMode,
        model: input.model.trim() || undefined,
      }),
    });
    const body = await res.json();
    // 校验类错误 (目录不存在 / CLI 非法): 回到表单内联报错, 不丢用户已填的值.
    if (res.status === 400) {
      renderForm(options, body?.message ?? body?.error ?? 'invalid_input');
      return;
    }
    if (!res.ok || !body?.job?.id) throw new Error(body?.error ?? `http_${res.status}`);
    renderJob(body.job);
    pollTimer = window.setInterval(() => {
      void pollJob(body.job.id).catch(err => {
        stopPolling();
        renderJob({ id: body.job.id, status: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    }, 1200);
  } catch (err) {
    renderJob({ id: '', status: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

async function pollJob(id: string): Promise<void> {
  const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(id)}`);
  const body = await res.json();
  if (!res.ok || !body?.job) throw new Error(body?.error ?? `http_${res.status}`);
  renderJob(body.job);
  // needs_owner 也停轮询：它是等用户操作的状态, 继续轮询会周期性重渲染、清掉用户
  // 正在输入的 owner。后续由 owner 提交流程驱动渲染。
  if (body.job.status === 'completed' || body.job.status === 'failed' || body.job.status === 'needs_owner') {
    stopPolling();
  }
}

async function openBotOnboarding(): Promise<void> {
  stopPolling();
  const d = ensureDialog();
  // 先出表单 (含 CLI 下拉占位), 再异步填充选项——避免空白等待.
  renderForm([{ id: 'claude-code', label: 'Claude' }]);
  if (!d.open) d.showModal();
  const options = await fetchCliOptions();
  // 用户可能在 fetch 期间已经提交/关闭; 仅当仍停留在表单时刷新选项.
  if (d.open && d.querySelector('#onboarding-form')) renderForm(options);
}

export function wireBotOnboardingButton(): void {
  const btn = document.getElementById('add-bot-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = () => { void openBotOnboarding(); };
}
