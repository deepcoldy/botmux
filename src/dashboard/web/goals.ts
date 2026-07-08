// Goal board (P1 #6) — a grid-first delivery observation console (claude×codex
// design). Three zones: a left rail of goals (operational summary rows), a center
// task grid where each row is a subtask and the columns are the delivery lifecycle
// (派发→报告→核验→验收), and a right detail panel that shows the selected task's
// verification trail. Data: GET /api/goals (buildGoalBoard read-model). Self-
// contained fetch + 10s poll; the returned dispose clears the timer.
//
// Aesthetic: borrows the v3 "flight recorder" language — mono-LED task ids, status
// LEDs, staged reveal — but stays inside the dashboard's CSS variables + themes.
// No DAG: subtasks are flat (no deps); the lifecycle pipeline IS the progress
// model. The "核验" stage lights amber while a report awaits verification — exactly
// the gap the goal-watchdog fills, made visible.
import { escapeHtml, relTime, loadNameMaps, botNameForOpenId, botNameForAppId, chatNameForId } from './ui.js';

interface AcceptanceCheck { type: 'exists' | 'contains'; text?: string }
interface AcceptanceArtifact { path: string; kind?: string; checks: AcceptanceCheck[] }
interface AcceptanceCommand { cmd: string; cwd?: string; expectExitCode?: number; timeoutMs?: number }
interface AcceptanceCriteria { version: number; artifacts?: AcceptanceArtifact[]; commands?: AcceptanceCommand[] }
interface BoardEvidence { kind: 'path' | 'inline' | 'url'; label: string; preview?: string; bytes?: number }
interface BoardAttempt { reportId: string; ts?: number; verdict?: 'accepted' | 'rejected'; reason?: string; summary: string; workerOpenId?: string; verdictVia?: 'reconcile' }
interface BoardTask {
  taskId: string; title?: string; status: string;
  workerOpenIds?: string[]; workerNames?: string[]; latestReportId?: string; reportCount: number;
  acceptanceCriteria?: AcceptanceCriteria; acceptanceHint?: string;
  latestVerdict?: 'accepted' | 'rejected'; rejectReason?: string; autoReconciled?: boolean;
  dispatchedAt?: number; latestReportedAt?: number; latestVerdictAt?: number; acceptedAt?: number; rejectedAt?: number;
  checkedBy?: string; evidenceChecked?: string[]; ranCommands?: string[]; evidence?: BoardEvidence[];
  attempts: BoardAttempt[];
  help?: { blocker: string; kind?: string; workerOpenId?: string };
  escalation?: { reason: string; by?: string; retryBrief?: string };
}
interface BoardNarration { goalChatId: string; type: string; taskId?: string; text: string; ts: number }
interface GoalNotificationRetryRecord {
  id: string; ownerLarkAppId: string; kind: 'human-attention' | 'completion-confirm'; status?: 'pending' | 'dead';
  goalChatId: string; goalTitle?: string; taskId?: string; taskTitle?: string; summary: string; attentionKind?: string; attentionReason?: string;
  attempts: number; nextAttemptAt: number; lastError?: string; deadAt?: number; deadReason?: string; createdAt: number; updatedAt: number;
}
interface BoardGoal {
  goalChatId: string; title?: string; hasCharter: boolean;
  charterUpdatedAt?: string; charterContent?: string; lastActivityAt?: number;
  counts: { dispatched: number; reported: number; accepted: number; rejected: number; blocked: number; escalated: number; total: number };
  tasks: BoardTask[];
  narrations?: BoardNarration[];
}
interface GoalBoard { goals: BoardGoal[] }
interface RetryBoard { records: GoalNotificationRetryRecord[] }

// ── Operator View attention band — cross-goal "what needs me now" rollup ──────
// Consumed from GET /api/goals/attention (verified-delivery/attention.ts
// buildGoalAttentionBoard + daemon IPC live-health enrichment). The browser hits
// ONLY this endpoint. Live-probe risk (supervisor/worker liveness) is appended
// into systemRisk and tagged source:'live'; ledger/store-derived risk is
// source:'ledger' — so the band renders one list yet distinguishes provenance
// ("现场探测，可能瞬时" vs "账本事实"). perGoal carries the existing GoalBoard for
// the unchanged drill-down below.
interface AttnDisposition { bucket: string; reason: string; next: string }
interface AttnEvidence { checkedBy?: string; evidenceChecked?: string[]; ranCommands?: string[]; latestSummary?: string }
interface AttnTask {
  // taskId is normally always set, but the wire format omits it for malformed
  // tasks (an escalation materialized without one) — keep it optional and guard.
  goalChatId: string; goalTitle?: string; taskId?: string; title?: string;
  workerNames?: string[]; disposition: AttnDisposition; lastActivityAt?: number;
  recentEvidence?: AttnEvidence;
  // present only on live-probe systemRisk rows (IPC enrichment, not a ledger fact):
  source?: 'ledger' | 'live'; liveKind?: string; liveDetail?: string; sessionId?: string; larkAppId?: string;
}
interface AttentionBoard {
  needsHuman: AttnTask[]; blocked: AttnTask[]; systemRisk: AttnTask[];
  inProgress: AttnTask[]; readyToVerify: AttnTask[]; recentlyCompleted: AttnTask[];
  counts: { needsHuman: number; blocked: number; systemRisk: number; inProgress: number; readyToVerify: number; completed: number };
  perGoal: BoardGoal[];
}

const STATUS_LABEL: Record<string, string> = {
  dispatched: '待交付', reported: '已提交', accepted: '已验收', rejected: '已驳回',
  blocked: '求助中', escalated: '已升级人工',
};
const HELP_KIND_LABEL: Record<string, string> = {
  access: '缺权限', ambiguous: '需求歧义', impossible: '做不到', repeated_failure: '反复失败', other: '其它',
};

// ── lifecycle stages ────────────────────────────────────────────────────────
type StageState = 'done' | 'active' | 'fail' | 'pending';
const STAGES: Array<{ key: string; label: string }> = [
  { key: 'dispatch', label: '派发' },
  { key: 'report', label: '提交' },
  { key: 'check', label: '核验' },
  { key: 'verdict', label: '验收' },
];
function stageState(t: BoardTask, key: string): StageState {
  const reported = t.reportCount > 0;
  const verdict = t.latestVerdict;
  switch (key) {
    case 'dispatch': return 'done';
    case 'report': return reported ? 'done' : 'pending';
    case 'check': return verdict ? 'done' : reported ? 'active' : 'pending';
    case 'verdict':
      if (verdict === 'accepted') return 'done';
      if (verdict === 'rejected') return 'fail';
      return 'pending';
    default: return 'pending';
  }
}

// ── formatters ──────────────────────────────────────────────────────────────
function shortId(s: string): string { return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s; }
function tailId(s: string): string { return s.length > 4 ? s.slice(-4) : s; }
/** Charters default to a "Goal charter: <id>" title — strip that noise for display. */
function cleanTitle(s: string): string { return s.replace(/^Goal charter:\s*/, '').trim() || s; }
function customGoalTitle(title?: string): string {
  return title && !/^Goal charter:/.test(title) ? cleanTitle(title) : '';
}
/** A goal's human name: custom charter title → real Feishu group name → short id. */
function goalName(g: BoardGoal): string {
  return displayGoalName(g.goalChatId, g.title);
}
function displayGoalName(goalChatId: string, title?: string): string {
  const custom = customGoalTitle(title);
  return custom || chatNameForId(goalChatId) || `目标 ${tailId(goalChatId)}`;
}
/** Resolve an actor field (checkedBy/worker) to a friendly agent name. checkedBy
 *  may be an open_id, a larkAppId (cli_…), or already a plain label (e.g.
 *  "goal-watchdog" / "claude-loopy-L2"): try the registry by open_id then by
 *  app_id, else show the label as-is, else short id. */
function botName(v?: string): string {
  if (!v) return '—';
  return botNameForOpenId(v) || botNameForAppId(v)
    || (v.startsWith('ou_') ? `成员 ${tailId(v)}` : v.startsWith('cli_') ? `Bot ${tailId(v)}` : v);
}
function displayWorkerName(v?: string): string {
  if (!v?.trim()) return '';
  return botName(v.trim());
}
function displayWorkerNames(values?: string[]): string[] {
  return (values ?? []).map(displayWorkerName).filter(Boolean);
}
/** A 'supervisor 代办' accept: the worker never filed a genuine report, so L2
 *  bridged the gap — filed a self-report + accept after independent verification.
 *  The orchestrate skill marks the report/accept with this prefix; we surface it
 *  so the board never reads as if the worker delivered it themselves. */
const SUPERVISOR_BRIDGE_MARK = 'supervisor 代办';
function supervisorBridged(t: BoardTask): boolean {
  if (t.status !== 'accepted' || t.autoReconciled) return false;
  const acc = t.attempts.find((a) => a.verdict === 'accepted') ?? t.attempts[t.attempts.length - 1];
  return !!acc?.summary?.includes(SUPERVISOR_BRIDGE_MARK);
}
function fmtDur(ms?: number): string {
  if (ms === undefined || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
function fmtTs(ms?: number): string {
  if (ms === undefined) return '—';
  return relTime(ms);
}
function rejectCount(t: BoardTask): number { return t.attempts.filter(a => a.verdict === 'rejected').length; }

// ── left rail: goals as operational summary rows ──────────────────────────────
function goalRow(g: BoardGoal, selected: boolean): string {
  const c = g.counts;
  const pct = c.total ? Math.round((c.accepted / c.total) * 100) : 0;
  const segs = (['accepted', 'reported', 'dispatched', 'blocked', 'escalated', 'rejected'] as const)
    .map(k => c[k] ? `<span class="gb-seg gb-seg-${k}" style="flex:${c[k]}"></span>` : '')
    .join('');
  const badges = [
    c.escalated > 0 ? `<span class="gb-mini gb-mini-esc">${c.escalated} 待你拍</span>` : '',
    c.blocked > 0 ? `<span class="gb-mini gb-mini-blk">${c.blocked} 求助</span>` : '',
    c.dispatched + c.reported > 0 ? `<span class="gb-mini gb-mini-active">${c.dispatched + c.reported} 在跑</span>` : '',
    c.rejected > 0 ? `<span class="gb-mini gb-mini-rej">${c.rejected} 驳回</span>` : '',
  ].join('');
  const name = escapeHtml(goalName(g));
  return `<button class="gb-goal${selected ? ' sel' : ''}" data-goal="${escapeHtml(g.goalChatId)}">
    <div class="gb-goal-top">
      <span class="gb-goal-name" title="${name}">${name}</span>
      <span class="gb-goal-frac">${c.accepted}/${c.total}</span>
    </div>
    <div class="gb-bar" title="${pct}% 已验收">${segs || '<span class="gb-seg gb-seg-empty" style="flex:1"></span>'}</div>
    <div class="gb-goal-foot">
      <span class="gb-badges">${badges || '<span class="gb-mini gb-mini-quiet">无在跑</span>'}</span>
      <span class="gb-goal-time">${g.lastActivityAt ? fmtTs(g.lastActivityAt) : (g.hasCharter ? '仅 charter' : '')}</span>
    </div>
  </button>`;
}

// ── center: task grid (rows=task, columns=lifecycle stages) ───────────────────
function stageCell(t: BoardTask, key: string): string {
  const st = stageState(t, key);
  let glyph = '';
  if (st === 'done') glyph = key === 'verdict' ? '✓' : '●';
  else if (st === 'fail') glyph = '✗';
  else if (st === 'active') glyph = '◌';
  else glyph = '○';
  const rc = key === 'verdict' && st === 'fail' && rejectCount(t) > 1 ? `<sub>×${rejectCount(t)}</sub>` : '';
  return `<td class="gb-cell gb-st-${st}"><span class="gb-led">${glyph}</span>${rc}</td>`;
}
function taskRow(t: BoardTask, selected: boolean): string {
  const verdictTag = t.status === 'rejected' && t.rejectReason
    ? `<span class="gb-reason">${escapeHtml(t.rejectReason)}</span>` : '';
  const provTag = t.status !== 'accepted' ? ''
    : t.autoReconciled
      ? '<span class="gb-via gb-via-auto" title="系统自动核验：执行者已提交，自动按验收标准核对后裁定">🤖 自动核验</span>'
      : supervisorBridged(t)
        ? '<span class="gb-via gb-via-bridge" title="执行者未主动提交，监管者独立核验后代办提交并验收">🤝 监管者代办</span>'
        : '<span class="gb-via gb-via-agent" title="监管者自主核验后裁定">🧠 自主验收</span>';
  const helpTag = t.status === 'blocked' && t.help
    ? `<span class="gb-via gb-via-blocked" title="${escapeHtml(t.help.blocker)}">🚧 ${escapeHtml(HELP_KIND_LABEL[t.help.kind ?? 'other'] ?? '求助')}</span>`
    : t.status === 'escalated' && t.escalation
      ? `<span class="gb-via gb-via-escalated" title="${escapeHtml(t.escalation.reason)}">🙋 等人拍板</span>`
      : '';
  const accTag = t.acceptanceCriteria ? '<span class="gb-acc-dot" title="结构化验收标准">◆</span>'
    : t.acceptanceHint ? '<span class="gb-acc-dot gb-acc-legacy" title="自由文本验收口径">◇</span>' : '';
  const primary = t.title
    ? `<span class="gb-task-title">${escapeHtml(t.title)}</span><span class="gb-led-id gb-led-id-sm">${escapeHtml(shortId(t.taskId || ''))}</span>`
    : `<span class="gb-led-id">${escapeHtml(shortId(t.taskId || ''))}</span>`;
  return `<tr class="gb-trow${selected ? ' sel' : ''}" data-task="${escapeHtml(t.taskId || '')}" title="${escapeHtml(t.taskId || '')}">
    <td class="gb-task-id">${primary}${accTag}</td>
    ${STAGES.map(s => stageCell(t, s.key)).join('')}
    <td class="gb-task-status"><span class="gb-pill gb-pill-${t.status}">${STATUS_LABEL[t.status] ?? escapeHtml(t.status)}</span>${provTag}${helpTag}${verdictTag}</td>
  </tr>`;
}
function gridHtml(g: BoardGoal, selTask: string | null): string {
  if (!g.tasks.length) return '<p class="gb-empty">该目标下暂无子任务</p>';
  return `<table class="gb-grid">
    <thead><tr><th class="gb-task-id">子任务</th>${STAGES.map(s => `<th class="gb-cell">${s.label}</th>`).join('')}<th class="gb-task-status">状态</th></tr></thead>
    <tbody>${g.tasks.map(t => taskRow(t, t.taskId === selTask)).join('')}</tbody>
  </table>`;
}

// ── right: detail panel for the selected task ─────────────────────────────────
function acceptanceHtml(t: BoardTask): string {
  if (t.acceptanceCriteria) {
    const c = t.acceptanceCriteria;
    const items: string[] = [];
    for (const a of c.artifacts ?? []) {
      const checks = (a.checks ?? []).map(ck => ck.type === 'exists' ? '存在' : `含"${escapeHtml(ck.text ?? '')}"`).join(' + ');
      items.push(`<li><code>${escapeHtml(a.path)}</code> — ${checks}</li>`);
    }
    for (const cmd of c.commands ?? []) {
      items.push(`<li><code>${escapeHtml(cmd.cmd)}</code>${cmd.cwd ? ` @${escapeHtml(cmd.cwd)}` : ''} → exit ${cmd.expectExitCode ?? 0}</li>`);
    }
    return `<ul class="gb-checklist">${items.join('') || '<li class="gb-muted">—</li>'}</ul>`;
  }
  if (t.acceptanceHint) return `<p class="gb-hint-legacy">${escapeHtml(t.acceptanceHint)}</p>`;
  return '<p class="gb-muted">无验收标准（不可机器核验）</p>';
}
function timelineHtml(t: BoardTask): string {
  const steps: Array<[string, number | undefined]> = [
    ['派发', t.dispatchedAt], ['提交', t.latestReportedAt],
    [t.latestVerdict === 'rejected' ? '驳回' : '验收', t.latestVerdictAt],
  ];
  const dispatched = t.dispatchedAt;
  return `<div class="gb-timeline">${steps.filter(([, ts]) => ts !== undefined).map(([label, ts]) => {
    const delta = (dispatched !== undefined && ts !== undefined && ts > dispatched) ? `+${fmtDur(ts - dispatched)}` : '';
    return `<div class="gb-tl-step"><span class="gb-tl-dot"></span><span class="gb-tl-label">${label}</span>
      <span class="gb-tl-time">${fmtTs(ts)}</span>${delta ? `<span class="gb-tl-delta">${delta}</span>` : ''}</div>`;
  }).join('')}</div>`;
}
function trailHtml(t: BoardTask): string {
  if (!t.checkedBy && !t.evidenceChecked?.length && !t.ranCommands?.length && !t.evidence?.length) {
    return t.reportCount ? '<p class="gb-muted">尚未验收</p>' : '<p class="gb-muted">执行者尚未提交结果</p>';
  }
  const parts: string[] = [];
  if (t.checkedBy) {
    const prov = t.autoReconciled
      ? ' <span class="gb-via gb-via-auto" title="系统自动核对交付证据后裁定">🤖 自动核验</span>'
      : supervisorBridged(t)
        ? ' <span class="gb-via gb-via-bridge" title="执行者未主动提交，监管者独立核验后代办提交并验收">🤝 监管者代办</span>'
        : ' <span class="gb-via gb-via-agent" title="监管者自主核验">🧠 自主验收</span>';
    parts.push(`<div class="gb-kv"><span>核验人</span>${escapeHtml(botName(t.checkedBy))}${prov}</div>`);
  }
  if (t.evidenceChecked?.length) parts.push(`<div class="gb-kv"><span>核验了</span><ul>${t.evidenceChecked.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`);
  if (t.ranCommands?.length) parts.push(`<div class="gb-kv"><span>跑了命令</span><ul>${t.ranCommands.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul></div>`);
  if (t.evidence?.length) parts.push(`<div class="gb-kv"><span>产物证据</span><ul>${t.evidence.map(e =>
    `<li>${e.kind === 'path'
      ? `<code>${escapeHtml(e.label)}</code>`
      : e.kind === 'url'
        ? `🔗 <a href="${escapeHtml(e.label)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.label)}</a>`
        : `📎 ${escapeHtml(e.label)}${e.preview ? ` <span class="gb-muted">${escapeHtml(e.preview.slice(0, 48))}</span>` : ''}`}</li>`).join('')}</ul></div>`);
  return parts.join('');
}
function attemptsHtml(t: BoardTask): string {
  if (!t.attempts.length) return '<p class="gb-muted">无提交记录</p>';
  return `<ol class="gb-attempts">${t.attempts.map((a, i) => {
    const v = a.verdict === 'accepted' ? '<span class="gb-pill gb-pill-accepted">已验收</span>'
      : a.verdict === 'rejected' ? '<span class="gb-pill gb-pill-rejected">已驳回</span>'
        : '<span class="gb-pill gb-pill-reported">待核验</span>';
    const via = a.verdictVia === 'reconcile' ? '<span class="gb-via gb-via-auto" title="系统自动核对">🤖</span>'
      : a.verdict ? '<span class="gb-via gb-via-agent" title="监管者自主核验">🧠</span>' : '';
    return `<li><div class="gb-att-head"><span class="gb-att-n">#${i + 1}</span>${v}${via}<span class="gb-att-time">${fmtTs(a.ts)}</span></div>
      <div class="gb-att-sum">${escapeHtml(a.summary)}</div>
      ${a.reason ? `<div class="gb-att-reason">原因：${escapeHtml(a.reason)}</div>` : ''}</li>`;
  }).join('')}</ol>`;
}
function helpHtml(t: BoardTask): string {
  const parts: string[] = [];
  if (t.help) {
    const kind = t.help.kind ? `<span class="gb-help-kind">${escapeHtml(HELP_KIND_LABEL[t.help.kind] ?? t.help.kind)}</span> ` : '';
    const who = t.help.workerOpenId ? ` <span class="gb-muted">— ${escapeHtml(botName(t.help.workerOpenId))}</span>` : '';
    parts.push(`<div class="gb-kv"><span>🚧 执行者求助</span><div>${kind}${escapeHtml(t.help.blocker)}${who}</div></div>`);
  }
  if (t.escalation) {
    const by = t.escalation.by ? ` <span class="gb-muted">— ${escapeHtml(botName(t.escalation.by))}</span>` : '';
    const brief = t.escalation.retryBrief ? `<div class="gb-att-reason">待你拍：${escapeHtml(t.escalation.retryBrief)}</div>` : '';
    parts.push(`<div class="gb-kv"><span>🙋 升级人工</span><div>${escapeHtml(t.escalation.reason)}${by}${brief}</div></div>`);
  }
  return parts.join('');
}
/** Human-in-the-loop decision box — the dashboard counterpart of replying in the
 *  Feishu goal group. The human types an instruction / supplied info and it is
 *  injected into the goal's L2 supervisor turn (POST /api/goals/:goalChatId/
 *  decision), which then guides the worker / 代办 / 重派 / closes the escalation.
 *  Shown for the states that actually need a human call (升级人工 / worker 求助);
 *  the ledger stays the truth — this only feeds L2 a decision, never writes a verdict. */
function decisionHtml(t: BoardTask, goalChatId: string): string {
  if (!(t.escalation || t.status === 'blocked')) return '';
  const cue = t.escalation ? '这条已升级到你，拍个方向给监管者' : '执行者在求助，给监管者一个处置指示';
  return `<div class="gb-sec gb-sec-decide" data-goal="${escapeHtml(goalChatId)}" data-task="${escapeHtml(t.taskId)}">
    <h3>下发决策 → 监管者</h3>
    <p class="gb-decide-hint">${cue}。监管者会去引导执行者、代办、重派或关闭升级；最终状态以交付记录为准。</p>
    <textarea class="gb-decide-input" rows="3" placeholder="例如：权限我已开通，让执行者重试；或：改用方案 B 重派；或：这条放弃，标记不做…"></textarea>
    <div class="gb-decide-row">
      <button type="button" class="gb-decide-send">下发给监管者</button>
      <span class="gb-decide-status" aria-live="polite"></span>
    </div>
  </div>`;
}
// Event stream — the same clean human-readable narration the goal chat shows
// (人类决策到达 / 监管者关键动作). Mirrors chat ⇄ dashboard so a human watching
// the board follows the loop without reading L2's terminal cards. n.text already
// carries the emoji + body; we just lay it out with a relative timestamp.
function narrationsHtml(g: BoardGoal): string {
  const ns = g.narrations ?? [];
  if (!ns.length) return '';
  return `<div class="gb-narr">
    <div class="gb-narr-head">📣 事件流 <span class="gb-narr-sub">人类决策 / 监管动作 · 与群内一致</span></div>
    <ul class="gb-narr-list">${ns.map(n => `<li class="gb-narr-item gb-narr-${escapeHtml(n.type)}">
        <span class="gb-narr-text">${escapeHtml(n.text).replace(/\n/g, '<br>')}</span>
        <time class="gb-narr-ts" title="${n.ts ? escapeHtml(new Date(n.ts).toLocaleString()) : ''}">${n.ts ? relTime(n.ts) : ''}</time>
      </li>`).join('')}</ul>
  </div>`;
}

function notificationRetriesHtml(records: GoalNotificationRetryRecord[]): string {
  const visible = records.filter(r => (r.status === 'dead') || r.attempts > 0 || r.lastError);
  if (!visible.length) return '';
  return `<div class="gb-retries">
    <div class="gb-retries-head">⚠️ 关键通知投递异常 <span>${visible.length} 条</span></div>
    <div class="gb-retries-list">${visible.map(r => {
      const dead = r.status === 'dead';
      const title = displayGoalName(r.goalChatId, r.goalTitle);
      const taskLabel = r.taskTitle?.trim() || (r.taskId ? `任务号 ${shortId(r.taskId)}` : '');
      const label = r.kind === 'completion-confirm' ? '完成确认卡' : '升级/需要人拍板';
      const status = dead ? `已停止自动重试 · ${r.deadReason ?? 'dead-letter'}` : `下次重试 ${fmtTs(r.nextAttemptAt)}`;
      return `<div class="gb-retry ${dead ? 'dead' : ''}" data-retry-id="${escapeHtml(r.id)}">
        <div class="gb-retry-main">
          <strong>${dead ? '需人工处理' : '重试中'} · ${label}</strong>
          <span>${escapeHtml(title)}${taskLabel ? ` · ${escapeHtml(taskLabel)}` : ''}</span>
          <small>${escapeHtml(status)} · attempts=${r.attempts}${r.lastError ? ` · ${escapeHtml(r.lastError)}` : ''}</small>
        </div>
        <div class="gb-retry-actions">
          <button type="button" class="gb-retry-retry">手动重试</button>
          <button type="button" class="gb-retry-clear">清除</button>
        </div>
      </div>`;
    }).join('')}</div>
  </div>`;
}
/** 验收印 — the signature element: a verified delivery wears a stamp naming WHO
 *  checked it and HOW MUCH proof they inspected (the anti-Goodhart trail, promoted
 *  from a muted badge to the page's memorable mark). Only accepted tasks earn it. */
function sealHtml(t: BoardTask): string {
  if (t.status !== 'accepted') return '';
  const by = botName(t.checkedBy);
  const kind = t.autoReconciled ? '自动核验' : supervisorBridged(t) ? '监管代办' : '自主核验';
  const checks = t.evidenceChecked?.length ?? 0;
  const cmds = t.ranCommands?.length ?? 0;
  const bits = [checks ? `核验 ${checks} 项证据` : '', cmds ? `跑 ${cmds} 条命令` : ''].filter(Boolean).join(' · ');
  return `<div class="gb-seal" title="验收印 · ${escapeHtml(kind)}">
    <div class="gb-seal-mark">✓</div>
    <div class="gb-seal-body">
      <div class="gb-seal-title">已核验交付<span class="gb-seal-kind">${escapeHtml(kind)}</span></div>
      <div class="gb-seal-meta">核验人 ${escapeHtml(by)}${bits ? ` · ${bits}` : ' · 无核验痕迹'}</div>
    </div>
  </div>`;
}
function detailHtml(t: BoardTask | null, goalChatId: string | null): string {
  if (!t) return '<div class="gb-detail-empty"><p>选择一个子任务<br>查看验收痕迹</p></div>';
  const heading = t.title?.trim() || '未命名任务';
  return `<div class="gb-detail-head">
      <div class="gb-detail-title-main">${escapeHtml(heading)}</div>
      <span class="gb-pill gb-pill-${t.status}">${STATUS_LABEL[t.status] ?? escapeHtml(t.status)}</span>
    </div>
    <p class="gb-detail-title">任务号：<span class="gb-debug-id" title="${escapeHtml(t.taskId)}">${escapeHtml(shortId(t.taskId))}</span></p>
    ${t.workerOpenIds?.length ? `<p class="gb-detail-worker">执行者：${t.workerOpenIds.map((w, i) => {
      const nm = t.workerNames?.[i]?.trim();
      return `<span class="gb-who">${escapeHtml(nm || botName(w))}</span>`;
    }).join('、')}</p>` : ''}
    ${sealHtml(t)}
    ${(t.help || t.escalation) ? `<div class="gb-sec gb-sec-help"><h3>求助 / 升级</h3>${helpHtml(t)}</div>` : ''}
    ${goalChatId ? decisionHtml(t, goalChatId) : ''}
    <div class="gb-sec"><h3>生命周期</h3>${timelineHtml(t)}</div>
    <div class="gb-sec"><h3>验收标准</h3>${acceptanceHtml(t)}</div>
    <div class="gb-sec"><h3>验收痕迹</h3>${trailHtml(t)}</div>
    <div class="gb-sec"><h3>提交历史 (${t.attempts.length})</h3>${attemptsHtml(t)}</div>`;
}

// ── Operator View attention band (cross-goal first screen) ────────────────────
function attnRow(t: AttnTask): string {
  const goal = escapeHtml(displayGoalName(t.goalChatId, t.goalTitle));
  const workers = displayWorkerNames(t.workerNames);
  const who = workers.length ? `<span class="attn-who">${escapeHtml(workers.join('、'))}</span>` : '';
  const src = t.disposition.bucket === 'systemRisk'
    ? (t.source === 'live'
        ? `<span class="attn-src attn-src-live" title="${escapeHtml(t.liveDetail ?? '现场探测，可能瞬时')}">🔴 实时</span>`
        : '<span class="attn-src attn-src-ledger" title="交付记录/存储派生，稳态事实">📒 记录</span>')
    : '';
  const sum = t.recentEvidence?.latestSummary;
  const ev = sum ? `<span class="attn-ev" title="${escapeHtml(sum)}">${escapeHtml(sum.length > 56 ? sum.slice(0, 56) + '…' : sum)}</span>` : '';
  const task = t.taskId
    ? `<span class="attn-task">${escapeHtml(t.title || shortId(t.taskId))}</span>`
    : '<span class="attn-task attn-task-none">—</span>';
  const title = [t.disposition.next, t.title || t.taskId, displayGoalName(t.goalChatId, t.goalTitle)]
    .filter(Boolean)
    .join(' · ');
  const canWake = !['needsHuman', 'completed'].includes(t.disposition.bucket);
  const actionLabel = t.disposition.bucket === 'readyToVerify' ? '通知验收' : '通知监管者';
  const wake = canWake
    ? `<button type="button" class="attn-action attn-wake" data-goal="${escapeHtml(t.goalChatId)}" data-task="${escapeHtml(t.taskId ?? '')}">${actionLabel}</button>`
    : '';
  // 一键动作（真动作，区别于轻量唤醒）：走既有「下发决策」通道注入 [panel-action v1]，
  // 由监管者查交付记录后执行真命令并留痕——dashboard 不直接写账、不直接派活。
  const panelActs: Array<[string, string]> = !t.taskId ? []
    : t.disposition.bucket === 'systemRisk' ? [['reassign-worker', '重派'], ['escalate-human', '升级给人']]
    : t.disposition.bucket === 'blocked' ? [['resolve-help', '处理求助'], ['escalate-human', '升级给人']]
    : [];
  const acts = panelActs.map(([act, label]) =>
    `<button type="button" class="attn-action attn-panel-act" data-act="${act}" data-goal="${escapeHtml(t.goalChatId)}" data-task="${escapeHtml(t.taskId ?? '')}" data-reason="${escapeHtml(t.disposition.reason)}">${label}</button>`).join('');
  const action = acts + wake;
  return `<div class="attn-row-wrap attn-${escapeHtml(t.disposition.bucket)}">
  <button type="button" class="attn-row" data-goal="${escapeHtml(t.goalChatId)}" data-task="${escapeHtml(t.taskId ?? '')}" title="${escapeHtml(title)}">
    <span class="attn-next">${escapeHtml(t.disposition.next)}</span>
    ${task}<span class="attn-goal">${goal}</span>${who}${src}${ev}
    <span class="attn-age">${t.lastActivityAt ? fmtTs(t.lastActivityAt) : ''}</span>
  </button>${action}</div>`;
}
function attnSection(label: string, rows: AttnTask[]): string {
  if (!rows.length) return '';
  return `<div class="attn-sec"><div class="attn-sec-head">${label} <span class="attn-sec-n">${rows.length}</span></div>${rows.map(attnRow).join('')}</div>`;
}
function attentionBandHtml(a: AttentionBoard): string {
  const c = a.counts;
  const urgent = c.needsHuman + c.blocked + c.systemRisk + c.readyToVerify;
  if (!urgent && !c.inProgress && !c.completed) return '<div class="attn-band attn-quiet">✅ 暂无需要你处理的事</div>';
  const summary = `拍板 ${c.needsHuman} · 卡住 ${c.blocked} · 风险 ${c.systemRisk} · 待验收 ${c.readyToVerify} · 进行中 ${c.inProgress}`;
  // priority order (codex): 需要你拍板 → 卡住/风险 → 待验收 → (进行中/最近完成 折叠)
  const top = attnSection('🙋 需要你拍板', a.needsHuman)
    + attnSection('🚧 卡住 / 风险', [...a.blocked, ...a.systemRisk])
    + attnSection('🔍 待验收', a.readyToVerify);
  return `<div class="attn-band">
    <div class="attn-band-head"><span class="attn-band-title">需要你处理</span><span class="attn-summary">${summary}</span></div>
    ${top || '<div class="attn-quiet-inline">✅ 没有需要你拍板 / 卡住 / 待验收的事</div>'}
    ${(c.inProgress || c.completed) ? `<details class="attn-more"><summary>进行中 ${c.inProgress} · 最近完成 ${c.completed}</summary>${attnSection('⏳ 进行中', a.inProgress)}${attnSection('✅ 最近完成', a.recentlyCompleted)}</details>` : ''}
  </div>`;
}

// ── page shell + wiring ───────────────────────────────────────────────────────
function shell(): string {
  return `<section class="page goalboard">
<div class="page-heading">
  <div><p class="eyebrow">交付验收</p><h1>目标看板</h1>
  <p>每个目标下子任务的交付流程：派发 → 提交 → 核验 → 验收。交付记录是最终依据。</p></div>
  <div><button type="button" id="gb-refresh" class="gb-refresh-btn">↻ 刷新</button></div>
</div>
<div id="gb-attn"></div>
<div id="gb-retries"></div>
<div class="gb-layout">
  <aside class="gb-rail" id="gb-rail"></aside>
  <main class="gb-main" id="gb-main"></main>
  <aside class="gb-detail" id="gb-detail"></aside>
</div>
</section>`;
}

export function renderGoalsPage(root: HTMLElement): () => void {
  root.innerHTML = shell();
  const railEl = root.querySelector<HTMLElement>('#gb-rail')!;
  const mainEl = root.querySelector<HTMLElement>('#gb-main')!;
  const detailEl = root.querySelector<HTMLElement>('#gb-detail')!;
  const retriesEl = root.querySelector<HTMLElement>('#gb-retries')!;
  const gbAttnEl = root.querySelector<HTMLElement>('#gb-attn')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#gb-refresh')!;

  let board: GoalBoard = { goals: [] };
  let retries: RetryBoard = { records: [] };
  let attn: AttentionBoard | null = null;
  let selGoal: string | null = null;
  let selTask: string | null = null;
  let disposed = false;
  let lastJson = ''; // skip re-render when a poll returns identical data (no flicker)

  const goalOf = (id: string | null) => board.goals.find(g => g.goalChatId === id) ?? null;

  function renderRail(): void {
    railEl.innerHTML = board.goals.length
      ? board.goals.map(g => goalRow(g, g.goalChatId === selGoal)).join('')
      : '<p class="gb-empty">还没有任何目标 / 交付任务</p>';
  }
  function renderMain(): void {
    const g = goalOf(selGoal);
    if (!g) { mainEl.innerHTML = '<div class="gb-main-empty"><p>选择左侧一个目标查看子任务</p></div>'; return; }
    mainEl.innerHTML = `<div class="gb-main-head">
        <span class="gb-main-title" title="${escapeHtml(goalName(g))}">${escapeHtml(goalName(g))}</span>
        <span class="gb-main-counts">已验收 ${g.counts.accepted} · 共 ${g.counts.total}${g.counts.rejected ? ` · 驳回 ${g.counts.rejected}` : ''}</span>
      </div>${gridHtml(g, selTask)}${narrationsHtml(g)}`;
  }
  const decideDraft: Record<string, string> = {}; // preserve an in-progress decision across poll repaints
  function renderDetail(): void {
    const g = goalOf(selGoal);
    detailEl.innerHTML = detailHtml(g?.tasks.find(t => t.taskId === selTask) ?? null, selGoal);
    const ta = detailEl.querySelector<HTMLTextAreaElement>('.gb-decide-input');
    if (ta && selTask && decideDraft[selTask]) ta.value = decideDraft[selTask];
  }
  function renderAttn(): void { gbAttnEl.innerHTML = attn ? attentionBandHtml(attn) : ''; }
  function renderAll(): void { renderAttn(); renderRail(); renderMain(); renderDetail(); }
  function renderRetries(): void { retriesEl.innerHTML = notificationRetriesHtml(retries.records); }

  async function sendDecision(btn: HTMLButtonElement): Promise<void> {
    const sec = btn.closest<HTMLElement>('.gb-sec-decide');
    if (!sec) return;
    const goal = sec.dataset.goal ?? '';
    const task = sec.dataset.task ?? '';
    const ta = sec.querySelector<HTMLTextAreaElement>('.gb-decide-input');
    const statusEl = sec.querySelector<HTMLElement>('.gb-decide-status');
    const setStatus = (msg: string, cls = '') => { if (statusEl) { statusEl.textContent = msg; statusEl.className = `gb-decide-status${cls ? ' ' + cls : ''}`; } };
    const text = (ta?.value ?? '').trim();
    if (!text) { setStatus('先写点指示再下发'); return; }
    btn.disabled = true;
    setStatus('下发中…');
    try {
      const res = await fetch(`/api/goals/${encodeURIComponent(goal)}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: task, text }),
      });
      if (!res.ok) {
        let code = '';
        try { code = (await res.json())?.error ?? ''; } catch { /* non-json */ }
        throw new Error(
          code === 'no_supervisor' ? '该目标当前没有在线监管者，无法下发（会话可能已关）'
          : code === 'missing_text' ? '指示不能为空'
          : `下发失败：${code || 'HTTP ' + res.status}`,
        );
      }
      if (ta) ta.value = '';
      delete decideDraft[task];
      setStatus('✓ 已下发给监管者', 'gb-decide-ok');
    } catch (err) {
      setStatus((err as Error).message, 'gb-decide-err');
    } finally {
      btn.disabled = false;
    }
  }

  async function triggerWatchdog(btn: HTMLButtonElement): Promise<void> {
    const goal = btn.dataset.goal ?? '';
    const task = btn.dataset.task || undefined;
    if (!goal) return;
    const oldText = btn.textContent ?? '通知监管者';
    btn.disabled = true;
    btn.textContent = '处理中…';
    try {
      const res = await fetch(`/api/goals/${encodeURIComponent(goal)}/watchdog`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: task }),
      });
      const json = await res.json().catch(() => null) as { injected?: number; reconciled?: number; revived?: number; reassigned?: number; rateLimited?: number; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const acted = (json?.injected ?? 0) + (json?.reconciled ?? 0) + (json?.revived ?? 0) + (json?.reassigned ?? 0);
      btn.textContent = acted > 0 ? '已通知' : (json?.rateLimited ? '冷却中' : '已检查');
      setTimeout(() => { void load(); }, 600);
    } catch (err) {
      btn.textContent = '失败';
      btn.title = (err as Error).message;
      setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 1800);
      return;
    }
    setTimeout(() => { btn.disabled = false; }, 1200);
  }

  // One-click REAL actions ([panel-action v1]): inject a structured instruction
  // into the goal's supervisor via the existing decision channel. The supervisor
  // re-checks the ledger, runs the real command (dispatch/escalate) and leaves
  // attribution — the dashboard never writes the ledger or dispatches directly.
  const PANEL_ACT_META: Record<string, { instruction: string }> = {
    'reassign-worker': { instruction: '请先核对交付记录与执行者状态；确认原执行者不可用或反复失败后，用同一任务号重新派发；拿不准就升级给人。' },
    'switch-worker': { instruction: '请换一个可用执行者重新派发，并在交付记录里写清原因。' },
    'escalate-human': { instruction: '请走正式「升级给人」流程（delivery escalate），附清楚背景；能预判方向就带上推荐选项。' },
    'resolve-help': { instruction: '请处理该执行者的求助：能定的直接给处置指示，不能定的再升级给人。' },
  };
  async function sendPanelAction(btn: HTMLButtonElement): Promise<void> {
    const goal = btn.dataset.goal ?? '';
    const task = btn.dataset.task ?? '';
    const act = btn.dataset.act ?? '';
    const meta = PANEL_ACT_META[act];
    if (!goal || !task || !meta) return;
    const text = [
      '[panel-action v1]',
      `action: ${act}`,
      `taskId: ${task}`,
      `reason: ${btn.dataset.reason || '看板一键动作'}`,
      `instruction: ${meta.instruction}`,
    ].join('\n');
    const oldText = btn.textContent ?? '';
    btn.disabled = true;
    btn.textContent = '下发中…';
    try {
      const res = await fetch(`/api/goals/${encodeURIComponent(goal)}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: task, text }),
      });
      if (!res.ok) {
        let code = '';
        try { code = ((await res.json()) as { error?: string })?.error ?? ''; } catch { /* non-json */ }
        throw new Error(code === 'no_supervisor' ? '目标当前没有在线监管者（会话可能已关）' : code || `HTTP ${res.status}`);
      }
      btn.textContent = '已下发 ✓';
      btn.title = '已注入监管者，由它核对交付记录后执行并留痕';
      setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2600);
    } catch (err) {
      btn.textContent = '失败';
      btn.title = (err as Error).message;
      setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2200);
    }
  }

  // attention band: clicking a row drills into that goal+task, reusing the grid
  // and detail panel below (needsHuman/blocked rows land on the existing decision box).
  gbAttnEl.addEventListener('click', (e) => {
    const panelAct = (e.target as HTMLElement).closest<HTMLButtonElement>('.attn-panel-act');
    if (panelAct) { void sendPanelAction(panelAct); return; }
    const wake = (e.target as HTMLElement).closest<HTMLButtonElement>('.attn-wake');
    if (wake) { void triggerWatchdog(wake); return; }
    const row = (e.target as HTMLElement).closest<HTMLElement>('.attn-row');
    if (!row) return;
    const goal = row.dataset.goal || null;
    if (!goal || !goalOf(goal)) return; // a live-only row with no board goal: nothing to drill into
    selGoal = goal;
    const g = goalOf(selGoal);
    const task = row.dataset.task || '';
    selTask = (task && g?.tasks.some(t => t.taskId === task)) ? task : (g?.tasks[0]?.taskId ?? null);
    renderAll();
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // delegation on the persistent containers (only their innerHTML is replaced)
  railEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.gb-goal');
    if (!btn) return;
    selGoal = btn.dataset.goal ?? null;
    const g = goalOf(selGoal);
    selTask = g?.tasks[0]?.taskId ?? null; // auto-select first task
    renderAll();
  });
  mainEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.gb-trow');
    if (!row) return;
    selTask = row.dataset.task ?? null;
    renderMain(); renderDetail();
  });
  // decision box (escalated / 求助 tasks): persist the draft, send on click or Ctrl/⌘+Enter
  detailEl.addEventListener('input', (e) => {
    const ta = (e.target as HTMLElement).closest<HTMLTextAreaElement>('.gb-decide-input');
    if (ta && selTask) decideDraft[selTask] = ta.value;
  });
  detailEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.gb-decide-send');
    if (btn) void sendDecision(btn);
  });
  detailEl.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (!(ke.ctrlKey || ke.metaKey) || ke.key !== 'Enter') return;
    const ta = (ke.target as HTMLElement).closest<HTMLElement>('.gb-decide-input');
    ta?.closest<HTMLElement>('.gb-sec-decide')?.querySelector<HTMLButtonElement>('.gb-decide-send')?.click();
  });
  refreshBtn.onclick = () => { void load(); };
  retriesEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    const row = (e.target as HTMLElement).closest<HTMLElement>('.gb-retry');
    if (!btn || !row) return;
    const id = row.dataset.retryId ?? '';
    const action = btn.classList.contains('gb-retry-retry') ? 'retry' : btn.classList.contains('gb-retry-clear') ? 'clear' : '';
    if (!id || !action) return;
    btn.disabled = true;
    void fetch(`/api/goal-notification-retries/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        lastJson = '';
        return load();
      })
      .catch((err) => {
        btn.disabled = false;
        btn.textContent = (err as Error).message;
      });
  });

  async function load(): Promise<void> {
    try {
      const [res, retryRes] = await Promise.all([
        fetch('/api/goals/attention'),
        fetch('/api/goal-notification-retries'),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!retryRes.ok) throw new Error(`retry HTTP ${retryRes.status}`);
      const [text, retryText] = await Promise.all([res.text(), retryRes.text()]);
      const combinedText = `${text}\n${retryText}`;
      if (disposed) return;
      if (combinedText === lastJson) return; // unchanged → don't repaint (kills 10s poll flicker)
      lastJson = combinedText;
      attn = JSON.parse(text) as AttentionBoard;
      board = { goals: attn.perGoal ?? [] }; // perGoal feeds the existing drill-down (browser hits only /api/goals/attention)
      retries = JSON.parse(retryText) as RetryBoard;
      // keep selection if still present; else default to first goal / first task
      if (!goalOf(selGoal)) { selGoal = board.goals[0]?.goalChatId ?? null; selTask = null; }
      const g = goalOf(selGoal);
      if (g && !g.tasks.some(t => t.taskId === selTask)) selTask = g.tasks[0]?.taskId ?? null;
      // don't yank the caret out of the decision box if a poll repaint lands mid-typing
      const typing = (document.activeElement as HTMLElement | null)?.classList.contains('gb-decide-input')
        && detailEl.contains(document.activeElement);
      if (typing) { renderAttn(); renderRail(); renderMain(); renderRetries(); } else { renderAll(); renderRetries(); }
    } catch (e) {
      if (disposed) return;
      railEl.innerHTML = `<p class="gb-empty">加载失败：${escapeHtml((e as Error).message)}</p>`;
    }
  }

  // resolve open_ids / chatIds → real names, then repaint (memoized globally)
  void loadNameMaps().then(() => { if (!disposed) renderAll(); });
  void load();
  const timer = window.setInterval(() => { void load(); }, 10_000);
  return () => { disposed = true; window.clearInterval(timer); };
}
