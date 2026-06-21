// 工作台首页：AI 团队（数字员工卡）→ 需要你处理 → 活跃会话 / 此刻概览。
// 第一屏顺序固定（codex 产品护栏）：团队状态做品牌，attention 做主任务入口。
import { store } from './store.js';
import {
  attentionReason,
  attentionWaitSince,
  botAvatarHtml,
  botDisplayName,
  botNameForAppId,
  chatDisplayTitle,
  escapeHtml,
  loadNameMaps,
  relTime,
  stripMentionPrefix,
  t,
} from './ui.js';

let groupsSnapshot: { chats: any[]; bots: any[] } = { chats: [], bots: [] };

export function __setGroupsSnapshotForTest(snapshot: { chats: any[]; bots: any[] }): void {
  groupsSnapshot = snapshot;
}

async function loadGroupsSnapshot(): Promise<void> {
  try {
    const r = await fetch('/api/groups');
    if (!r.ok) return;
    groupsSnapshot = await r.json();
  } catch {
    // Overview stays useful even when Lark group APIs are unavailable.
  }
}

type BotCard = {
  botName: string;
  larkAppId?: string;
  botAvatarUrl?: string;
  cliId: string;
  online: boolean;
  sessions: any[];
  active: any[];
  busy: any[];
  attention: any[];
  lastActiveAt: number;
};

const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);

/** 把会话按 bot 聚合成"数字员工"卡片数据；在线 bot 没会话也要出现（待命）。
 *  以 larkAppId 为身份键（部分会话缺 botName，按名字聚会裂成两张卡）；
 *  显示名优先 daemon 注册表，其次会话上的 botName。只剩历史 closed 会话、
 *  又不在注册表里的 bot 不出卡（避免一排灰色离线噪音）。 */
export function buildBotCards(sessions: any[]): BotCard[] {
  const byKey = new Map<string, BotCard>();
  const ensure = (key: string): BotCard => {
    let card = byKey.get(key);
    if (!card) {
      card = {
        botName: key, larkAppId: key, cliId: 'unknown', online: false,
        sessions: [], active: [], busy: [], attention: [], lastActiveAt: 0,
      };
      byKey.set(key, card);
    }
    return card;
  };
  for (const b of groupsSnapshot.bots ?? []) {
    const card = ensure(b.larkAppId ?? b.botName ?? '-');
    card.online = true;
    if (b.botName) card.botName = b.botName;
    if (b.botAvatarUrl) card.botAvatarUrl = b.botAvatarUrl;
    if (b.cliId) card.cliId = b.cliId;
  }
  // 两遍：先 active 建卡，再让 closed 会话只补充已有卡（不为其单独出卡）
  const ordered = [...sessions].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed'));
  for (const s of ordered) {
    const key = s.larkAppId ?? s.botName ?? '-';
    if (s.status === 'closed' && !byKey.has(key)) continue;
    const card = ensure(key);
    if (s.botName && (card.botName === card.larkAppId || !card.botName)) card.botName = s.botName;
    card.sessions.push(s);
    if (s.cliId && card.cliId === 'unknown') card.cliId = s.cliId;
    card.lastActiveAt = Math.max(card.lastActiveAt, Number(s.lastMessageAt ?? 0));
    if (s.status !== 'closed') {
      card.active.push(s);
      if (BUSY_STATUSES.has(s.status)) card.busy.push(s);
      if (attentionReason(s)) card.attention.push(s);
    }
  }
  for (const card of byKey.values()) {
    // 首屏 /api/groups 还没回来时 botName 只能是 larkAppId（cli_xxx）——
    // 用 localStorage 回灌的名字缓存先把人话名字顶上，避免每次刷新闪 id。
    if (card.botName === card.larkAppId) {
      const cached = botNameForAppId(card.larkAppId);
      if (cached) card.botName = cached;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    // 等你的排最前，其次干活中，再按最近活跃
    const rank = (c: BotCard) => (c.attention.length ? 0 : c.busy.length ? 1 : c.online || c.active.length ? 2 : 3);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.lastActiveAt - a.lastActiveAt;
  });
}

// AI 团队折叠态：bot 一多整屏都是卡片，默认只露两整行重点（attention/busy 在前），
// 展开偏好记进 localStorage 跨刷新保留。
const TEAM_EXPAND_KEY = 'botmux.overview.teamExpanded';
// 与 .team-grid 的 repeat(auto-fill, minmax(230px, 1fr)) / gap:13px 保持同步——
// 按容器实际宽度算出每行列数，折叠时正好露满整行，不留半行尾巴。
const TEAM_CARD_MIN_W = 230;
const TEAM_GRID_GAP = 13;
const TEAM_COLLAPSED_ROWS = 2;

function collapsedCardCount(gridEl: HTMLElement): number {
  const width = gridEl.clientWidth;
  if (!width) return TEAM_COLLAPSED_ROWS * 3; // 首帧尚未布局时的兜底
  const cols = Math.max(1, Math.floor((width + TEAM_GRID_GAP) / (TEAM_CARD_MIN_W + TEAM_GRID_GAP)));
  return cols * TEAM_COLLAPSED_ROWS;
}

function readTeamExpanded(): boolean {
  try { return window.localStorage.getItem(TEAM_EXPAND_KEY) === '1'; } catch { return false; }
}

function persistTeamExpanded(v: boolean): void {
  try { window.localStorage.setItem(TEAM_EXPAND_KEY, v ? '1' : '0'); } catch { /* 静默 */ }
}

function mateCardHtml(card: BotCard): string {
  const offline = !card.online && card.active.length === 0;
  const needsYou = card.attention.length > 0;
  const busy = card.busy.length > 0;
  const dotClass = needsYou ? 'warn' : busy ? 'busy' : offline ? 'off' : 'ok';
  let taskHtml: string;
  if (needsYou) {
    const a = [...card.attention].sort((x, y) => attentionWaitSince(x) - attentionWaitSince(y))[0];
    taskHtml = `<b>${escapeHtml((stripMentionPrefix(a.title) || a.sessionId).slice(0, 60))}</b> · ${escapeHtml(attentionReason(a) ?? '')}`;
  } else if (busy) {
    const w = [...card.busy].sort((x, y) => Number(y.lastMessageAt ?? 0) - Number(x.lastMessageAt ?? 0))[0];
    taskHtml = `<b>${escapeHtml((stripMentionPrefix(w.title) || w.sessionId).slice(0, 60))}</b>`;
  } else if (offline) {
    taskHtml = escapeHtml(t('overview.botOffline'));
  } else {
    taskHtml = escapeHtml(t('overview.botIdle'));
  }
  const tag = needsYou
    ? `<span class="tag tag-warn">${escapeHtml(t('overview.botNeedsYou'))}</span>`
    : busy
      ? `<span class="tag tag-run">${escapeHtml(t('overview.botBusy', { count: card.busy.length }))}</span>`
      : offline
        ? `<span class="tag tag-off">${escapeHtml(t('overview.botOff'))}</span>`
        : `<span class="tag tag-ok">${escapeHtml(t('overview.botReady'))}</span>`;
  return `<article class="mate${needsYou ? ' mate-attn' : ''}${offline ? ' mate-off' : ''}">
    <div class="mate-top">
      ${botAvatarHtml({ name: card.botName, larkAppId: card.larkAppId, avatarUrl: card.botAvatarUrl, dot: dotClass })}
      <div class="mate-id">
        <b>${escapeHtml(card.botName)}</b>
        <span class="mate-role">${escapeHtml(card.cliId)}</span>
      </div>
    </div>
    <div class="mate-task">${taskHtml}</div>
    <div class="mate-foot">
      ${tag}
      <span>${card.lastActiveAt ? escapeHtml(t('overview.lastActive', { time: relTime(card.lastActiveAt) })) : escapeHtml(t('common.never'))}</span>
    </div>
  </article>`;
}

function attentionCardHtml(s: any): string {
  const botName = botDisplayName(s);
  return `<article class="qcard" data-id="${escapeHtml(s.sessionId)}">
    ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
    <div class="qcard-tx">
      <b>${escapeHtml(botName)} · ${escapeHtml((stripMentionPrefix(s.title) || s.sessionId).slice(0, 56))}</b>
      <span>${escapeHtml(attentionReason(s) ?? '')} · ${relTime(attentionWaitSince(s))}</span>
    </div>
    <a class="qcard-go" href="#/sessions">${escapeHtml(t('strip.handle'))}</a>
  </article>`;
}

function activeSessionHtml(s: any): string {
  const botName = botDisplayName(s);
  return `<li class="sess-row">
    ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
    <div class="sess-tx">
      <b>${escapeHtml((stripMentionPrefix(s.title) || s.sessionId).slice(0, 64))}</b>
      <span>${escapeHtml(botName)} · ${escapeHtml(chatDisplayTitle(s) ?? s.cliId ?? 'unknown')} · ${relTime(s.lastMessageAt)}</span>
    </div>
    <span class="status status-${escapeHtml(s.status ?? 'unknown')}">${escapeHtml(s.status ?? 'unknown')}</span>
  </li>`;
}

function renderScheduleMini(s: any): string {
  const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '-';
  return `<li class="overview-list-row">
    <div>
      <strong>${escapeHtml(s.name ?? s.id)}</strong>
      <span>${escapeHtml(botDisplayName(s))} · ${escapeHtml(s.parsed?.display ?? '')}</span>
    </div>
    <span>${escapeHtml(next)}</span>
  </li>`;
}

/** 此刻概览圆环：working / needs-you / idle 三段 conic-gradient。 */
function donutHtml(workingN: number, attnN: number, idleN: number): string {
  const total = workingN + attnN + idleN;
  if (total === 0) {
    return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(var(--border) 0 360deg)"></div>
      <div class="donut-center"><b>0</b><span>${escapeHtml(t('overview.openSessions'))}</span></div></div>`;
  }
  const wDeg = (workingN / total) * 360;
  const aDeg = wDeg + (attnN / total) * 360;
  return `<div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(var(--accent) 0 ${wDeg}deg, var(--warning) ${wDeg}deg ${aDeg}deg, var(--success) ${aDeg}deg 360deg)"></div>
    <div class="donut-center"><b>${total}</b><span>${escapeHtml(t('overview.openSessions'))}</span></div>
  </div>`;
}

export async function renderOverviewPage(root: HTMLElement) {
  root.innerHTML = `<section class="page hero-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('app.subtitle')}</p>
        <h1>${t('overview.title')}</h1>
        <p id="overview-sub">${t('overview.subtitle')}</p>
      </div>
      <div class="hero-pills" id="overview-pills"></div>
    </div>

    <div class="sect-head">
      <h2>${t('overview.team')}</h2><span>${t('overview.teamHint')}</span>
      <a href="#/bot-defaults">${t('overview.viewAll')}</a>
    </div>
    <div class="team-grid" id="team-grid"></div>
    <button type="button" class="team-toggle" id="team-toggle" hidden></button>

    <div class="sect-head" id="attention-head">
      <h2>${t('overview.attention')}</h2><span>${t('overview.attentionHint')}</span>
    </div>
    <div class="qgrid" id="attention-list"></div>

    <div class="overview-cols">
      <section class="panel">
        <header class="panel-header">
          <div>
            <h2>${t('overview.activeSessions')}</h2>
            <p>${t('overview.activeSessionsHint')}</p>
          </div>
          <a class="btn-link" href="#/sessions">${t('overview.viewAll')}</a>
        </header>
        <ul class="overview-list" id="recent-sessions"></ul>
      </section>
      <div class="overview-side">
        <section class="panel">
          <header class="panel-header">
            <div>
              <h2>${t('overview.today')}</h2>
              <p>${t('overview.todayHint')}</p>
            </div>
          </header>
          <div class="donut-row" id="today-donut"></div>
        </section>
        <section class="panel">
          <header class="panel-header">
            <div>
              <h2>${t('overview.nextSchedules')}</h2>
              <p>${t('schedules.subtitle')}</p>
            </div>
            <a class="btn-link" href="#/schedules">${t('overview.viewAll')}</a>
          </header>
          <ul class="overview-list" id="next-schedules"></ul>
        </section>
      </div>
    </div>
  </section>`;

  const pillsEl = root.querySelector<HTMLElement>('#overview-pills')!;
  const teamEl = root.querySelector<HTMLElement>('#team-grid')!;
  const teamToggleEl = root.querySelector<HTMLButtonElement>('#team-toggle')!;
  let teamExpanded = readTeamExpanded();
  teamToggleEl.onclick = () => {
    teamExpanded = !teamExpanded;
    persistTeamExpanded(teamExpanded);
    rerender();
  };
  const attentionEl = root.querySelector<HTMLElement>('#attention-list')!;
  const sessionsEl = root.querySelector<HTMLElement>('#recent-sessions')!;
  const donutEl = root.querySelector<HTMLElement>('#today-donut')!;
  const schedulesEl = root.querySelector<HTMLElement>('#next-schedules')!;

  function rerender() {
    const sessions = [...store.sessions.values()];
    const active = sessions.filter(s => s.status !== 'closed');
    const attention = active
      .filter(s => attentionReason(s))
      .sort((a, b) => attentionWaitSince(a) - attentionWaitSince(b));
    const busy = active.filter(s => BUSY_STATUSES.has(s.status) && !attentionReason(s));
    const idle = active.length - attention.length - busy.length;

    // 顶部胶囊：执行中 / 需要你 / 在线 bot
    const cards = buildBotCards(sessions);
    const onlineBots = cards.filter(c => c.online || c.active.length > 0).length;
    pillsEl.innerHTML = `
      <span class="pill">${escapeHtml(t('overview.workingSessions'))} <b>${busy.length}</b></span>
      <span class="pill${attention.length ? ' pill-hot' : ''}">${escapeHtml(t('overview.attention'))} <b>${attention.length}</b></span>
      <span class="pill">${escapeHtml(t('overview.onlineBots'))} <b>${onlineBots}</b></span>`;

    const collapsedN = collapsedCardCount(teamEl);
    const visibleCards = teamExpanded ? cards : cards.slice(0, collapsedN);
    teamEl.innerHTML = visibleCards.length
      ? visibleCards.map(mateCardHtml).join('')
      : `<div class="empty">${t('overview.noSessions')}</div>`;
    if (cards.length > collapsedN) {
      teamToggleEl.hidden = false;
      teamToggleEl.textContent = teamExpanded
        ? t('overview.teamCollapse')
        : t('overview.teamExpand', { count: cards.length });
    } else {
      teamToggleEl.hidden = true;
    }

    attentionEl.innerHTML = attention.length
      ? attention.map(attentionCardHtml).join('')
      : `<div class="qcard qcard-empty">${t('overview.noAttention')}</div>`;

    const recent = active
      .filter(s => BUSY_STATUSES.has(s.status) || s.status === 'idle')
      .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0))
      .slice(0, 7);
    sessionsEl.innerHTML = recent.length
      ? recent.map(activeSessionHtml).join('')
      : `<li class="empty">${t('overview.noSessions')}</li>`;

    donutEl.innerHTML = `${donutHtml(busy.length, attention.length, Math.max(0, idle))}
      <div class="donut-legend">
        <span><i style="background:var(--accent)"></i>${escapeHtml(t('overview.workingSessions'))} ${busy.length}</span>
        <span><i style="background:var(--warning)"></i>${escapeHtml(t('overview.attention'))} ${attention.length}</span>
        <span><i style="background:var(--success)"></i>${escapeHtml(t('sessions.board.idle'))} ${Math.max(0, idle)}</span>
      </div>`;

    const upcoming = [...store.schedules.values()]
      .filter(s => s.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
      .slice(0, 5);
    schedulesEl.innerHTML = upcoming.length
      ? upcoming.map(renderScheduleMini).join('')
      : `<li class="empty">${t('overview.noSchedules')}</li>`;
  }

  // 窗口宽度变了每行列数会变，折叠态要跟着补/裁到整行；页面切走后自动解绑。
  const onResize = () => {
    if (!document.body.contains(teamEl)) { window.removeEventListener('resize', onResize); return; }
    if (!teamExpanded) rerender();
  };
  window.addEventListener('resize', onResize);

  store.on(rerender);
  rerender();
  void loadGroupsSnapshot().then(rerender);
  // 共享名字映射（bot 友好名 / 群聊标题）就绪后再补一次重绘
  void loadNameMaps().then(rerender);
}
