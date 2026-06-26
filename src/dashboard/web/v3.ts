/**
 * v3 workflow runs dashboard page — a DAG graph of a run's nodes (colored by
 * status) with a per-node detail panel that hosts the terminal slot.
 *
 * Read-only: fetches `/api/v3/runs` (list) and `/api/v3/runs/:id` (a RunView —
 * see ops-projection.ts).  The RunView carries NO write token / no raw fs path
 * (codex security review); the per-node terminal component (`v3-terminal.ts`,
 * codex) only needs `(runId, node)`.
 *
 * Visual language ("flight recorder"): mono-led ids & round numbers, status
 * conveyed through theme tokens (`--v3r-*` in style.css — works in light/dark/
 * skins), composite loop nodes drawn as dashed capsules with an iteration-dot
 * budget row, and a per-round timeline in the panel (instances + verdict per
 * round, granted rounds marked).  All motion is CSS-only (spin / marching-ants
 * edges / breathe) and honors prefers-reduced-motion.
 *
 * Vanilla DOM + poll loop, mirroring `workflows.ts` (disposer clears the timer;
 * skip polling while the tab is hidden; stop once the run is terminal).
 */
import { renderNodeTerminal } from './v3-terminal.js';
import { legacyWorkflowDetailHash } from './legacy-workflow-link.js';
import type { RunView, RunNodeView } from '../../workflows/v3/ops-projection.js';

const POLL_MS = 2000;

/** Single source of truth for "stop polling": only succeeded/failed are terminal.
 *  `running` and `blocked` (awaiting human retry/grant) can still change, so the
 *  detail page keeps polling. Used by both poll() and loop() so the stop/re-arm
 *  decisions can't drift apart. */
function isTerminalRunStatus(status: RunView['runStatus'] | undefined): boolean {
  return status === 'succeeded' || status === 'failed';
}

const NODE_LABEL: Record<RunNodeView['status'], string> = {
  pending: '待机',
  gateWaiting: '等审批',
  running: '运行中',
  done: '完成',
  skipped: '已跳过', // edge-activation: 分支未选中的中性终态（非失败）
  cancelled: '已取消', // early-release loser：已无关并被收尸的中性终态
  blocked: '受阻',
  superseded: '已刷新', // 跨节点回溯把该 instance 刷新了，节点会重跑出新 instance
  failed: '失败',
};
const DECISION_LABEL: Record<string, string> = {
  exit: '✓ 通过',
  continue: '↻ 继续返工',
  exhausted: '⛔ 轮数耗尽',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Signature of a node's terminal-relevant inputs.  The panel remounts the
 *  terminal slot only when this changes (live→closed, webPort appears, pty log
 *  shows up) — so a stable live iframe survives the 2s poll loop. */
function termSig(node: RunNodeView): string {
  const wt = node.webTerminal;
  return `${wt?.status ?? '-'}|${wt?.webPort ?? '-'}|${node.hasPtyLog ? '1' : '0'}`;
}

export function renderV3RunsPage(root: HTMLElement): () => void {
  const m = location.hash.match(/^#\/workflows\/([^?#]+)/);
  if (m) return renderV3DetailPage(root, decodeURIComponent(m[1]!));
  return renderV3ListPage(root);
}

// ─── List ───────────────────────────────────────────────────────────────────

function renderV3ListPage(root: HTMLElement): () => void {
  root.innerHTML = `
    <div class="page-head">
      <h1>工作流</h1>
      <p class="muted">LLM 编排的 workflow 运行 — DAG 图 + 每节点终端</p>
    </div>
    <table class="data-table">
      <thead><tr><th>Run</th><th>状态</th><th>节点数</th></tr></thead>
      <tbody id="v3-tbody"></tbody>
    </table>
    <div id="v3-empty" class="muted" hidden style="padding:1rem">暂无工作流运行（用 <code>/workflow new</code> 发起一个）</div>`;
  const tbody = root.querySelector<HTMLElement>('#v3-tbody')!;
  const empty = root.querySelector<HTMLElement>('#v3-empty')!;
  let timer: number | null = null;
  let disposed = false;

  async function poll(): Promise<void> {
    if (disposed || document.hidden) return;
    try {
      const r = await fetch('/api/v3/runs');
      const body = r.ok ? ((await r.json()) as { runs: Array<{ runId: string; runStatus: string; nodeCount: number }> }) : { runs: [] };
      if (disposed) return;
      const runs = body.runs ?? [];
      empty.hidden = runs.length > 0;
      tbody.innerHTML = runs
        .map(
          (rn) => `<tr>
            <td><a class="v3r-runid" href="#/workflows/${encodeURIComponent(rn.runId)}">${esc(rn.runId)}</a></td>
            <td><span class="v3r-pill rs-${esc(rn.runStatus)}">${esc(rn.runStatus)}</span></td>
            <td>${rn.nodeCount}</td>
          </tr>`,
        )
        .join('');
    } catch {
      /* transient fetch error — next tick retries */
    }
  }

  function loop(): void {
    if (disposed) return;
    void poll().then(() => { if (!disposed) timer = window.setTimeout(loop, POLL_MS); });
  }
  loop();
  return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
}

// ─── Detail (DAG graph + node panel) ─────────────────────────────────────────

/** Geometry: loop capsules are taller than plain nodes (budget-dot row). */
const NW = 168;
const PLAIN_H = 48;
const LOOP_H = 70;
const COL = 226;
const VGAP = 30;
const PAD = 26;
/** Budget-dot row caps at this many slots — beyond it the text fraction is the
 *  honest display (a 20-dot row would not fit the capsule anyway). */
const MAX_DOTS = 8;

function nodeH(n: RunNodeView): number {
  return n.isLoop ? LOOP_H : PLAIN_H;
}

function renderV3DetailPage(root: HTMLElement, runId: string): () => void {
  root.innerHTML = `
    <div class="page-head">
      <a href="#/workflows" class="btn-link">← 工作流</a>
      <h1 class="v3r-title">${esc(runId)}</h1>
      <span id="v3-runstatus" class="v3r-pill"></span>
    </div>
    <div class="v3r-wrap">
      <div class="v3r-graph-card">
        <div id="v3-graph" class="v3r-graph"></div>
        <div class="v3r-legend">
          <span class="lg st-pending">待机</span>
          <span class="lg st-running">运行中</span>
          <span class="lg st-gateWaiting">等审批</span>
          <span class="lg st-done">完成</span>
          <span class="lg st-skipped">已跳过</span>
          <span class="lg st-cancelled">已取消</span>
          <span class="lg st-blocked">受阻</span>
          <span class="lg st-failed">失败</span>
          <span class="lg lg-loop">⟳ 循环容器</span>
        </div>
      </div>
      <div id="v3-node-panel" class="v3r-panel">
        <p class="muted">点一个节点看详情与终端</p>
      </div>
    </div>`;
  const graphEl = root.querySelector<HTMLElement>('#v3-graph')!;
  const panelEl = root.querySelector<HTMLElement>('#v3-node-panel')!;
  const runStatusEl = root.querySelector<HTMLElement>('#v3-runstatus')!;

  let timer: number | null = null;
  let disposed = false;
  // One-shot guard for the legacy v2 fallback probe (see poll()'s 404 branch):
  // already-sent v2 cards / bookmarks point at #/workflows/<v2-id>, which now
  // belongs to v3; probe the v2 backend once and bounce them to #/legacy-workflow.
  let triedV2Fallback = false;
  let selected: string | null = null;
  let lastView: RunView | null = null;
  // Which node the panel SHELL is built for, and the signature of the terminal
  // currently mounted in the slot.  Both gate re-renders so a live iframe is
  // NOT rebuilt on every 2s poll (codex caveat — only remount when the node
  // selection or the terminal's own inputs actually change).
  let panelSelected: string | null = null;
  let renderedTermSig: string | null = null;
  // Loop sub-selection: which body INSTANCE's terminal shows under the round
  // timeline (the timeline itself stays visible — selecting an instance must
  // not lose the loop context).  Auto-follows the live frontier until the user
  // pins a specific instance by clicking it.
  let instSel: string | null = null;
  let instPinned = false;

  function select(id: string | null): void {
    selected = id;
    instSel = null;
    instPinned = false;
    if (lastView) renderGraph(lastView);
    renderPanel();
  }

  function selectInstance(id: string): void {
    instSel = id;
    instPinned = true;
    renderPanel();
  }

  /** The instance whose terminal the loop panel shows: the pinned one if the
   *  user clicked, else the live frontier (a running instance, falling back to
   *  the most recently dispatched one). */
  function resolveInstSel(insts: RunNodeView[]): RunNodeView | null {
    if (instPinned && instSel) {
      const pinned = insts.find((x) => x.id === instSel);
      if (pinned) return pinned;
    }
    const running = insts.filter((x) => x.status === 'running');
    return running[running.length - 1] ?? insts[insts.length - 1] ?? null;
  }

  /** Compact mini-dag for ONE round: the loop's body template gives the shape
   *  (so undispatched slots show as pending ghosts); dispatched instances fill
   *  in live status + click-to-view-terminal. */
  function roundMiniDagSvg(
    tpl: Array<{ id: string; depends: string[] }>,
    instOf: Map<string, RunNodeView>,
    activeInstId: string | null,
  ): string {
    const W2 = 104, H2 = 30, COL2 = 138, ROW2 = 42, PAD2 = 6;
    // Depth layout over the TEMPLATE (authored body ids, body-internal deps).
    const memo = new Map<string, number>();
    const depth = (id: string): number => {
      if (memo.has(id)) return memo.get(id)!;
      memo.set(id, 0); // defensive against malformed cycles
      const deps = tpl.find((t) => t.id === id)?.depends.filter((d) => tpl.some((t) => t.id === d)) ?? [];
      const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
      memo.set(id, d);
      return d;
    };
    const rows = new Map<number, number>();
    const pos = new Map<string, { x: number; y: number }>();
    let maxRow = 0;
    for (const t of tpl) {
      const d = depth(t.id);
      const r = rows.get(d) ?? 0;
      rows.set(d, r + 1);
      maxRow = Math.max(maxRow, r);
      pos.set(t.id, { x: PAD2 + d * COL2, y: PAD2 + r * ROW2 });
    }
    const width = PAD2 * 2 + (memo.size ? Math.max(...memo.values()) * COL2 + W2 : 0);
    const height = PAD2 * 2 + maxRow * ROW2 + H2;

    const edges: string[] = [];
    for (const t of tpl) {
      const to = pos.get(t.id)!;
      for (const dep of t.depends) {
        const from = pos.get(dep);
        if (!from) continue;
        const x1 = from.x + W2, y1 = from.y + H2 / 2, x2 = to.x, y2 = to.y + H2 / 2;
        const mx = (x1 + x2) / 2;
        const live = instOf.get(t.id)?.status === 'running' ? ' live' : '';
        edges.push(`<path class="v3r-edge${live}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#v3arrow-mini)"/>`);
      }
    }
    const boxes = tpl.map((t) => {
      const p = pos.get(t.id)!;
      const inst = instOf.get(t.id);
      const status = inst?.status ?? 'pending';
      const ghost = inst ? '' : ' ghost';
      const sel = inst && inst.id === activeInstId ? ' sel' : '';
      const dataSel = inst ? ` data-sel="${esc(inst.id)}"` : '';
      return `<g class="v3r-node v3r-mini st-${status}${sel}${ghost}"${dataSel}${inst ? ` style="cursor:pointer"` : ''}>
        <rect class="v3r-box" x="${p.x}" y="${p.y}" width="${W2}" height="${H2}" rx="8"/>
        <circle class="v3r-mini-dot" cx="${p.x + 13}" cy="${p.y + H2 / 2}" r="3.4"/>
        <text class="v3r-nid" x="${p.x + 24}" y="${p.y + H2 / 2 + 4}">${esc(trunc(t.id, 12))}</text>
      </g>`;
    });
    return `<svg class="v3r-mini-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><marker id="v3arrow-mini" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--faint, #8b98aa)"/></marker></defs>
      ${edges.join('')}${boxes.join('')}
    </svg>`;
  }

  /** Round timeline for a loop node: rounds stack vertically (a flight-recorder
   *  log, newest last), each round drawn as a real mini-dag of its body
   *  instances.  Rounds past the authored maxIterations are tagged as
   *  human-granted.  Selecting an instance keeps this timeline on screen — the
   *  terminal mounts BELOW it. */
  function loopTimelineHtml(node: RunNodeView, activeInstId: string | null): string {
    const ls = node.loopState;
    if (!ls) return '<p class="muted">loop 未开始</p>';
    const maxIt = ls.maxIterations;
    const budget = maxIt !== undefined ? maxIt + ls.granted : undefined;
    const verdictOf = new Map(ls.decisions.map((d) => [d.iteration, d.decision]));

    const insts = (lastView?.nodes ?? []).filter((x) => x.loop?.loopId === node.id);
    const byIter = new Map<number, RunNodeView[]>();
    for (const inst of insts) {
      const k = inst.loop!.iteration;
      (byIter.get(k) ?? byIter.set(k, []).get(k)!).push(inst);
    }

    const rounds = [...byIter.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([iter, ns]) => {
        const verdict = verdictOf.get(iter);
        const isCur = iter === ls.iteration;
        const granted = maxIt !== undefined && iter > maxIt;
        const verdictChip = verdict
          ? `<span class="v3r-verdict vd-${verdict}">${DECISION_LABEL[verdict]}</span>`
          : isCur && node.status === 'running'
            ? '<span class="v3r-verdict vd-live">▶ 进行中</span>'
            : '';
        const instOf = new Map(ns.map((x) => [x.loop!.bodyNodeId, x]));
        return `<div class="v3r-round${isCur ? ' cur' : ''}${verdict ? ` vd-${verdict}` : ''}">
          <div class="v3r-round-head">
            <span class="rn">R${iter}</span>
            ${granted ? '<span class="v3r-granted-tag">➕ 追加轮</span>' : ''}
            ${verdictChip}
          </div>
          ${roundMiniDagSvg(ls.bodyTemplate, instOf, activeInstId)}
        </div>`;
      })
      .join('');

    const meter = `<div class="v3r-loop-meter">
      <span class="num">第 <b>${ls.iteration}</b>${budget !== undefined ? ` / <b>${budget}</b>` : ''} 轮</span>
      ${ls.granted > 0 ? `<span class="v3r-granted-tag">含人工追加 +${ls.granted}</span>` : ''}
      ${ls.lastDecision === 'exit' ? '<span class="v3r-verdict vd-exit">✓ 已收敛</span>' : ''}
    </div>`;

    const cta = node.status === 'blocked'
      ? `<div class="v3r-cta">⚠ 轮数耗尽，等人追加 — 飞书卡片点「➕ 追加 1 轮」，或 <code>botmux workflow grant ${esc(runId)}</code></div>`
      : '';

    return `<div class="v3r-loop-sec">${meter}<div class="v3r-rounds">${rounds}</div>${cta}</div>`;
  }

  function renderPanel(): void {
    const node = lastView?.nodes.find((n) => n.id === selected) ?? null;
    if (!node) {
      panelEl.innerHTML = '<p class="muted">点一个节点看详情与终端</p>';
      panelSelected = null;
      renderedTermSig = null;
      return;
    }
    // (Re)build the shell only when the selected node changes — keeps the
    // terminal slot's DOM (and any live iframe) alive across polls.
    if (panelSelected !== node.id) {
      panelEl.innerHTML = `
        <div id="v3-node-meta"></div>
        <div id="v3-inst-strip"></div>
        <div id="v3-term-slot" class="v3r-term-slot"></div>`;
      panelSelected = node.id;
      renderedTermSig = null; // force a terminal (re)mount for the new selection
    }
    // The terminal target: the node itself, or — for a loop — the selected /
    // live-frontier body instance (timeline stays visible above it).
    let termNode: RunNodeView | null = node;
    let activeInstId: string | null = null;
    if (node.isLoop) {
      const insts = (lastView?.nodes ?? []).filter((x) => x.loop?.loopId === node.id);
      const inst = resolveInstSel(insts);
      termNode = inst;
      activeInstId = inst?.id ?? null;
      instSel = activeInstId;
    }
    // Cheap meta updates in place every poll (no iframe involved).
    const head = `<div class="v3r-panel-head">
      ${node.isLoop ? '<span class="v3r-loop-mark">⟳</span>' : ''}
      <span class="v3r-nodeid">${esc(node.id)}</span>
      <span class="v3r-pill st-${node.status}"><i class="dot"></i>${NODE_LABEL[node.status]}</span>
    </div>`;
    const errLine = node.errorClass
      ? `<p class="v3r-err">原因：${esc(node.errorClass)}${node.errorCode ? ` (${esc(node.errorCode)})` : ''}${
          node.status === 'blocked' && !node.isLoop ? ' — 飞书卡片或 <code>botmux workflow retry</code> 可重试' : ''
        }</p>`
      : '';
    panelEl.querySelector<HTMLElement>('#v3-node-meta')!.innerHTML = `
      ${head}
      ${node.goal ? `<p class="v3r-goal">${esc(node.goal)}</p>` : ''}
      ${node.depends.length ? `<p class="v3r-deps">依赖 ${node.depends.map((d) => `<span class="v3r-dep">${esc(d)}</span>`).join('')}</p>` : ''}
      ${errLine}${node.isLoop ? loopTimelineHtml(node, activeInstId) : ''}`;
    // Instance strip: which body instance the terminal below belongs to.
    panelEl.querySelector<HTMLElement>('#v3-inst-strip')!.innerHTML =
      node.isLoop && termNode
        ? `<div class="v3r-inst-strip">
            <span class="lbl">实例终端</span>
            <span class="v3r-nodeid sm">${esc(termNode.id)}</span>
            <span class="v3r-pill st-${termNode.status}"><i class="dot"></i>${NODE_LABEL[termNode.status]}</span>
            <span class="muted">第 ${termNode.loop!.iteration} 轮 · ${esc(termNode.loop!.bodyNodeId)}${instPinned ? '' : ' · 自动跟随'}</span>
          </div>`
        : '';
    for (const el of panelEl.querySelectorAll<HTMLElement>('#v3-node-meta [data-sel]')) {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectInstance(el.getAttribute('data-sel')!);
      });
    }
    // Only (re)mount the terminal when its target or inputs changed (instance
    // switch / status / webPort / hasPtyLog) — otherwise leave codex's live
    // iframe untouched (no flicker).
    const slot = panelEl.querySelector<HTMLElement>('#v3-term-slot')!;
    if (!termNode) {
      slot.innerHTML = '';
      renderedTermSig = null;
      return;
    }
    const sig = `${termNode.id}|${termSig(termNode)}`;
    if (sig !== renderedTermSig) {
      renderNodeTerminal(slot, runId, termNode);
      renderedTermSig = sig;
    }
  }

  /** SVG for one composite loop capsule (dashed outer frame + budget dots). */
  function loopBoxSvg(n: RunNodeView, x: number, y: number, sel: boolean): string {
    const ls = n.loopState;
    const maxIt = ls?.maxIterations;
    const budget = ls && maxIt !== undefined ? maxIt + ls.granted : undefined;
    const statusLine = ls
      ? `${NODE_LABEL[n.status]} · 第${ls.iteration}${budget !== undefined ? `/${budget}` : ''}轮`
      : `${NODE_LABEL[n.status]} · loop`;
    // Budget dots: ● done round / ◉ current (pulses while running) / ○ todo;
    // slots past the authored maxIterations render in accent (granted).
    let dots = '';
    if (ls && budget !== undefined && budget <= MAX_DOTS) {
      const cy = y + LOOP_H - 13;
      for (let k = 1; k <= budget; k++) {
        const cx = x + 14 + (k - 1) * 15;
        const cls =
          k < ls.iteration ? 'v3r-dot done'
          : k === ls.iteration ? `v3r-dot cur${n.status === 'running' ? ' live' : ''}`
          : 'v3r-dot todo';
        const grant = maxIt !== undefined && k > maxIt ? ' grant' : '';
        dots += `<circle class="${cls}${grant}" cx="${cx}" cy="${cy}" r="3.6"/>`;
      }
      if (ls.lastDecision === 'exit') {
        dots += `<text class="v3r-dots-verdict ok" x="${x + 14 + budget * 15 + 4}" y="${cy + 4}">✓</text>`;
      } else if (ls.lastDecision === 'exhausted' && n.status === 'blocked') {
        dots += `<text class="v3r-dots-verdict warn" x="${x + 14 + budget * 15 + 4}" y="${cy + 4}">⚠</text>`;
      }
    }
    return `<g class="v3r-node v3r-loopnode st-${n.status}${sel ? ' sel' : ''}" data-node="${esc(n.id)}">
      <rect class="v3r-cap" x="${x - 4}" y="${y - 4}" width="${NW + 8}" height="${LOOP_H + 8}" rx="14"/>
      <rect class="v3r-box" x="${x}" y="${y}" width="${NW}" height="${LOOP_H}" rx="10"/>
      <text class="v3r-spin" x="${x + 14}" y="${y + 21}">⟳</text>
      <text class="v3r-nid" x="${x + 30}" y="${y + 21}">${esc(trunc(n.id, 16))}</text>
      <text class="v3r-nstatus" x="${x + 14}" y="${y + 39}">${esc(statusLine)}</text>
      ${dots}
    </g>`;
  }

  function renderGraph(view: RunView): void {
    // Loop body INSTANCES stay out of the graph (the loop node represents
    // them; the panel's iteration timeline reaches them).  Group by the
    // structured `loop` ref — never by parsing the id.
    const graphNodes = view.nodes.filter((n) => !n.loop);
    const depthOf = computeDepth(graphNodes);
    const byDepth = new Map<number, RunNodeView[]>();
    for (const n of graphNodes) {
      const d = depthOf.get(n.id) ?? 0;
      (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(n);
    }
    // Columns stack top-aligned; rows have per-node heights (loops are taller).
    const pos = new Map<string, { x: number; y: number }>();
    let height = 0;
    for (const [d, ns] of byDepth) {
      let y = PAD;
      for (const n of ns) {
        pos.set(n.id, { x: PAD + d * COL, y });
        y += nodeH(n) + VGAP;
      }
      height = Math.max(height, y - VGAP + PAD);
    }
    const width = PAD * 2 + (byDepth.size === 0 ? 0 : Math.max(...byDepth.keys()) * COL + NW);

    const byId = new Map(graphNodes.map((n) => [n.id, n]));
    const edges: string[] = [];
    for (const n of graphNodes) {
      const to = pos.get(n.id);
      if (!to) continue;
      for (const dep of n.depends) {
        const from = pos.get(dep);
        const fromNode = byId.get(dep);
        if (!from || !fromNode) continue;
        const x1 = from.x + NW, y1 = from.y + nodeH(fromNode) / 2;
        const x2 = to.x, y2 = to.y + nodeH(n) / 2;
        const mx = (x1 + x2) / 2;
        // Edges INTO a live node animate (marching ants) — the eye finds the
        // active frontier of the dag instantly.
        const live = n.status === 'running' ? ' live' : '';
        edges.push(`<path class="v3r-edge${live}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#v3arrow)"/>`);
      }
    }
    const boxes = graphNodes.map((n) => {
      const p = pos.get(n.id)!;
      const sel = n.id === selected;
      if (n.isLoop) return loopBoxSvg(n, p.x, p.y, sel);
      return `<g class="v3r-node st-${n.status}${sel ? ' sel' : ''}" data-node="${esc(n.id)}">
        <rect class="v3r-box" x="${p.x}" y="${p.y}" width="${NW}" height="${PLAIN_H}" rx="10"/>
        <rect class="v3r-bar" x="${p.x}" y="${p.y + 8}" width="3" height="${PLAIN_H - 16}" rx="1.5"/>
        <text class="v3r-nid" x="${p.x + 14}" y="${p.y + 20}">${esc(trunc(n.id, 18))}</text>
        <text class="v3r-nstatus" x="${p.x + 14}" y="${p.y + 37}">${NODE_LABEL[n.status]}</text>
      </g>`;
    });

    graphEl.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
      <defs><marker id="v3arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--faint, #8b98aa)"/></marker></defs>
      ${edges.join('')}${boxes.join('')}
    </svg>`;
    for (const g of graphEl.querySelectorAll<SVGGElement>('[data-node]')) {
      g.addEventListener('click', () => select(g.getAttribute('data-node')));
    }
  }

  async function poll(): Promise<void> {
    if (disposed || document.hidden) return;
    try {
      const r = await fetch(`/api/v3/runs/${encodeURIComponent(runId)}`);
      if (!r.ok) {
        // Legacy fallback: old v2 detail links are #/workflows/<v2-run-id>, a URL
        // that now routes to v3 detail. If this id is actually a v2 run, bounce to
        // the legacy page so already-sent cards/bookmarks still open. Probe once.
        if (r.status === 404 && !triedV2Fallback) {
          triedV2Fallback = true;
          try {
            const v2 = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshot`);
            if (v2.ok && !disposed) {
              window.location.replace(legacyWorkflowDetailHash(runId, location.hash.split('?')[1]));
              return;
            }
          } catch { /* fall through to not-found */ }
        }
        if (!disposed) runStatusEl.textContent = r.status === 404 ? 'not found' : `HTTP ${r.status}`;
        return;
      }
      const view = (await r.json()) as RunView;
      if (disposed) return;
      lastView = view;
      runStatusEl.textContent = view.runStatus;
      runStatusEl.className = `v3r-pill rs-${view.runStatus}`;
      if (selected === null && view.nodes.length) selected = view.nodes[0]!.id;
      renderGraph(view);
      renderPanel();
      // Stop polling once the run is terminal (one final render already done).
      if (isTerminalRunStatus(view.runStatus)) { if (timer !== null) window.clearTimeout(timer); timer = null; return; }
    } catch {
      /* transient — next tick retries */
    }
  }

  function loop(): void {
    if (disposed) return;
    void poll().then(() => { if (!disposed && !isTerminalRunStatus(lastView?.runStatus)) timer = window.setTimeout(loop, POLL_MS); });
  }
  loop();
  return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
}

/** Longest-path depth from a root (no-deps node) — the node's graph column. */
function computeDepth(nodes: RunNodeView[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // defensive: dag is acyclic, but never loop
    visiting.add(id);
    const n = byId.get(id);
    const deps = (n?.depends ?? []).filter((d) => byId.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  }
  for (const n of nodes) depth(n.id);
  return memo;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
