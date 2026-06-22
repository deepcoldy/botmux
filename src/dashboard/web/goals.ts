// Goal board page (P1 #6): a read-only projection of the verified-delivery ledger
// grouped by goal group, plus each goal's charter. Data comes from `GET /api/goals`
// (served by buildGoalBoard() in the daemon). Self-contained fetch + 10s poll so
// the board stays live while open; the returned dispose clears the timer.
import { escapeHtml } from './ui.js';

interface AcceptanceCheck { type: 'exists' | 'contains'; text?: string }
interface AcceptanceArtifact { path: string; kind?: string; checks: AcceptanceCheck[] }
interface AcceptanceCommand { cmd: string; cwd?: string; expectExitCode?: number; timeoutMs?: number }
interface AcceptanceCriteria { version: number; artifacts?: AcceptanceArtifact[]; commands?: AcceptanceCommand[] }
interface BoardTask {
  taskId: string; title?: string; status: string;
  workerOpenIds?: string[]; latestReportId?: string; reportCount: number;
  acceptanceCriteria?: AcceptanceCriteria; acceptanceHint?: string;
  latestVerdict?: string; rejectReason?: string;
}
interface BoardGoal {
  goalChatId: string; title?: string; hasCharter: boolean;
  charterUpdatedAt?: string; charterContent?: string;
  counts: { dispatched: number; reported: number; accepted: number; rejected: number; total: number };
  tasks: BoardTask[];
}
interface GoalBoard { goals: BoardGoal[] }

const STATUS_LABEL: Record<string, string> = {
  dispatched: '⏳ 待交付', reported: '📨 已报告', accepted: '✅ 已验收', rejected: '❌ 已驳回',
};

function fmtDate(s?: string): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function fmtAcceptance(t: BoardTask): string {
  if (t.acceptanceCriteria) {
    const c = t.acceptanceCriteria;
    const parts: string[] = [];
    for (const a of c.artifacts ?? []) {
      const checks = (a.checks ?? []).map(ck => ck.type === 'exists' ? '存在' : `含"${ck.text}"`).join(' + ');
      parts.push(`📄 ${a.path}: ${checks}`);
    }
    for (const cmd of c.commands ?? []) {
      parts.push(`▶ ${cmd.cmd}${cmd.cwd ? ` @${cmd.cwd}` : ''} (exit ${cmd.expectExitCode ?? 0})`);
    }
    if (!parts.length) return '<span class="muted">—</span>';
    return parts.map(p => `<div class="goal-accept">${escapeHtml(p)}</div>`).join('');
  }
  if (t.acceptanceHint) return `<div class="goal-accept goal-accept-legacy" title="legacy 自由文本">${escapeHtml(t.acceptanceHint)}</div>`;
  return '<span class="muted">—</span>';
}

function countsChips(c: BoardGoal['counts']): string {
  const chip = (n: number, label: string) => n > 0 ? `<span class="goal-chip">${label} ${n}</span>` : '';
  return [
    chip(c.dispatched, '⏳'), chip(c.reported, '📨'), chip(c.accepted, '✅'), chip(c.rejected, '❌'),
  ].join('') + `<span class="goal-chip goal-chip-total">共 ${c.total}</span>`;
}

function taskRow(t: BoardTask): string {
  const worker = (t.workerOpenIds ?? []).map(w => `<code>${escapeHtml(w.slice(0, 12))}…</code>`).join(' ') || '—';
  const verdict = t.status === 'rejected' && t.rejectReason
    ? `<span class="goal-reject">${escapeHtml(t.rejectReason)}</span>` : '';
  return `<tr>
    <td><code>${escapeHtml(t.taskId)}</code></td>
    <td>${escapeHtml(t.title ?? '—')}</td>
    <td>${STATUS_LABEL[t.status] ?? escapeHtml(t.status)} ${verdict}</td>
    <td>${worker}</td>
    <td>${t.reportCount}</td>
    <td class="goal-accept-cell">${fmtAcceptance(t)}</td>
  </tr>`;
}

function goalCard(g: BoardGoal): string {
  const heading = g.title ? escapeHtml(g.title) : `<code>${escapeHtml(g.goalChatId)}</code>`;
  const charterTag = g.hasCharter
    ? `<span class="goal-charter-tag" title="${escapeHtml(g.charterContent ?? '')}">📋 charter · ${fmtDate(g.charterUpdatedAt)}</span>`
    : '<span class="muted">无 charter</span>';
  const body = g.tasks.length
    ? `<table class="goal-task-table">
        <thead><tr><th>taskId</th><th>标题</th><th>状态</th><th>worker</th><th>报告数</th><th>验收标准</th></tr></thead>
        <tbody>${g.tasks.map(taskRow).join('')}</tbody>
       </table>`
    : '<p class="empty">该 goal 下暂无子任务</p>';
  return `<section class="goal-card">
    <div class="goal-card-head">
      <h2>${heading}</h2>
      <div class="goal-card-meta">${charterTag}</div>
    </div>
    <div class="goal-counts">${countsChips(g.counts)}</div>
    ${body}
  </section>`;
}

function pageShell(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">可信交付</p>
    <h1>目标看板</h1>
    <p>verified-delivery 账本按 goal 群聚合的实时投影：每个目标的 charter + 子任务交付状态。</p>
  </div>
  <div><button type="button" id="goals-refresh">刷新</button></div>
</div>
<div id="goals-body"><p class="empty">加载中…</p></div>
</section>`;
}

export function renderGoalsPage(root: HTMLElement): () => void {
  root.innerHTML = pageShell();
  const body = root.querySelector<HTMLElement>('#goals-body')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#goals-refresh')!;
  let disposed = false;

  async function load(): Promise<void> {
    try {
      const res = await fetch('/api/goals');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const board = await res.json() as GoalBoard;
      if (disposed) return;
      body.innerHTML = board.goals.length
        ? board.goals.map(goalCard).join('')
        : '<p class="empty">还没有任何 goal / 交付任务。</p>';
    } catch (e) {
      if (disposed) return;
      body.innerHTML = `<p class="empty">加载失败：${escapeHtml((e as Error).message)}</p>`;
    }
  }

  refreshBtn.onclick = () => { void load(); };
  void load();
  const timer = window.setInterval(() => { void load(); }, 10_000);

  return () => { disposed = true; window.clearInterval(timer); };
}
