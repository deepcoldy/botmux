import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SectionHeader } from './dashboard-components.js';
import { useT } from './react-hooks.js';
import { ui } from './ui.js';
import { cancelV3Run, fetchV3RunDetail, fetchV3Runs } from './v3-api.js';
import {
  V3_DECISION_LABEL,
  V3_GRAPH,
  V3_NODE_LABEL,
  V3_POLL_MS,
  buildGraphLayout,
  buildRoundMiniDagLayout,
  graphNodes,
  isTerminalRunStatus,
  loopBudget,
  loopInstances,
  loopRounds,
  resolveLoopTerminalNode,
  trunc,
  v3RunIdFromHash,
} from './v3-model.js';
import { nodeTerminalSignature, renderNodeTerminal } from './v3-terminal.js';
import type { RunNodeView, RunSummary, RunView } from '../../workflows/v3/ops-projection.js';

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function useV3RunsList(): RunSummary[] {
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const schedule = () => {
      timer = window.setTimeout(() => { void poll(); }, V3_POLL_MS);
    };

    async function poll(): Promise<void> {
      if (disposed) return;
      if (!isDocumentHidden()) {
        try {
          const next = await fetchV3Runs();
          if (!disposed) setRuns(next);
        } catch {
          /* transient fetch error; next tick retries */
        }
      }
      if (!disposed) schedule();
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return runs;
}

interface DetailPollState {
  view: RunView | null;
  statusText: string;
}

function useV3RunDetail(runId: string): DetailPollState {
  const [view, setView] = useState<RunView | null>(null);
  const [statusText, setStatusText] = useState('');

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const schedule = () => {
      timer = window.setTimeout(() => { void poll(); }, V3_POLL_MS);
    };

    async function poll(): Promise<void> {
      if (disposed) return;
      let stop = false;
      if (!isDocumentHidden()) {
        try {
          const result = await fetchV3RunDetail(runId);
          if (disposed) return;
          if (!result.ok) {
            setStatusText(result.status === 404 ? 'not found' : `HTTP ${result.status}`);
          } else {
            setView(result.view);
            setStatusText(result.view.runStatus);
            stop = isTerminalRunStatus(result.view.runStatus);
          }
        } catch {
          /* transient fetch error; next tick retries */
        }
      }
      if (!disposed && !stop) schedule();
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [runId]);

  return { view, statusText };
}

function V3ListPage(): JSX.Element {
  const tr = useT();
  const runs = useV3RunsList();
  const headingActions = (
    <div className="page-heading-actions v3r-run-toolbar">
      <span className="v3r-run-count">{runs.length}</span>
    </div>
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.workflows')}</p>
          <h1>{tr('nav.workflows')}</h1>
        </div>
        {headingActions}
      </div>
      <section className="overview-block v3r-runs-section">
        <div className="v3r-run-list">
          {runs.length ? runs.map((run) => (
            <a key={run.runId} className="v3r-run-card" href={`#/workflows/${encodeURIComponent(run.runId)}`}>
              <span className="v3r-run-main">
                <code className="v3r-runid">{run.runId}</code>
                <small>节点 {run.nodeCount}</small>
              </span>
              <span className={`v3r-pill rs-${run.runStatus}`}>{run.runStatus}</span>
            </a>
          )) : (
            <div className="empty v3r-empty">
              暂无工作流运行（用 <code>/workflow new</code> 发起一个）
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function V3DetailPage(props: { runId: string }): JSX.Element {
  const tr = useT();
  const { view, statusText } = useV3RunDetail(props.runId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [instancePinned, setInstancePinned] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelSubmitted, setCancelSubmitted] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
    setInstanceId(null);
    setInstancePinned(false);
    setCancelBusy(false);
    setCancelSubmitted(false);
    setCancelNotice(null);
  }, [props.runId]);

  useEffect(() => {
    if (view?.runStatus === 'cancelling') {
      setCancelSubmitted(true);
      setCancelNotice(tr('workflow.v3.cancelPending'));
    } else if (view?.runStatus === 'cancelled') {
      setCancelSubmitted(false);
      setCancelNotice(tr('workflow.v3.cancelled'));
    } else if (isTerminalRunStatus(view?.runStatus)) {
      setCancelSubmitted(false);
    }
  }, [tr, view?.runStatus]);

  useEffect(() => {
    if (!view) return;
    setSelectedId((current) => {
      if (current && view.nodes.some((node) => node.id === current)) return current;
      return graphNodes(view)[0]?.id ?? view.nodes[0]?.id ?? null;
    });
  }, [view]);

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    setInstanceId(null);
    setInstancePinned(false);
  }, []);

  const selectInstance = useCallback((id: string) => {
    setInstanceId(id);
    setInstancePinned(true);
  }, []);

  const selectedNode = view?.nodes.find((node) => node.id === selectedId) ?? null;
  const statusClass = view ? `v3r-pill rs-${view.runStatus}` : 'v3r-pill';
  const terminal = isTerminalRunStatus(view?.runStatus);
  const cancelling = cancelBusy || cancelSubmitted || view?.runStatus === 'cancelling';

  const cancelRun = useCallback(async () => {
    if (!view || terminal || cancelling) return;
    if (!window.confirm(tr('workflow.v3.cancelConfirm', { runId: props.runId }))) return;
    setCancelBusy(true);
    setCancelNotice(null);
    try {
      const result = await cancelV3Run(props.runId);
      if (!result.ok) {
        setCancelNotice(result.status === 401
          ? tr('workflow.v3.cancelAuthRequired')
          : tr('workflow.v3.cancelFailed', { error: result.error }));
        return;
      }
      setCancelNotice(
        result.runStatus === 'cancelled'
          ? tr('workflow.v3.cancelled')
          : result.alreadyTerminal
            ? tr('workflow.v3.cancelAlreadyTerminal')
            : tr('workflow.v3.cancelPending'),
      );
      setCancelSubmitted(result.runStatus !== 'cancelled' && result.alreadyTerminal !== true);
    } catch {
      setCancelNotice(tr('workflow.v3.cancelFailed', { error: 'network_error' }));
    } finally {
      setCancelBusy(false);
    }
  }, [cancelling, props.runId, terminal, tr, view]);

  return (
    <>
      <div className="page-heading v3r-detail-heading">
        <div className="v3r-title-row">
          <p className="eyebrow">{tr('nav.workflows')}</p>
          <a href="#/workflows" className="btn-link v3r-back-link">← {tr('nav.workflows')}</a>
          <h1>{props.runId}</h1>
          <span className={`${statusClass} v3r-run-status-pill`}>{statusText}</span>
        </div>
        <div className="page-heading-actions">
          <V3CancelButton
            runStatus={view?.runStatus}
            busy={cancelBusy || cancelSubmitted}
            onCancel={() => { void cancelRun(); }}
          />
        </div>
      </div>
      {cancelNotice ? (
        <div className={`v3r-cancel-notice${view?.runStatus === 'cancelled' ? ' done' : ''}`} role="status">
          {cancelNotice}
        </div>
      ) : null}
      <div className="v3r-wrap">
        <section className="overview-block v3r-graph-section">
          <SectionHeader
            title="运行拓扑"
            hint={view ? `${view.nodes.length} 个节点` : statusText}
          />
          <div className="v3r-graph-card">
            <DagGraph view={view} selectedId={selectedId} onSelect={selectNode} />
            <V3Legend />
          </div>
        </section>
        <section className="overview-block v3r-node-section">
          <SectionHeader
            title="节点详情"
            hint={selectedNode ? (
              <span className={`v3r-pill v3r-node-status-pill st-${selectedNode.status}`}>
                <i className="dot" />
                {V3_NODE_LABEL[selectedNode.status]}
              </span>
            ) : '选择一个节点'}
          />
          <NodePanel
            runId={props.runId}
            view={view}
            node={selectedNode}
            instanceId={instanceId}
            instancePinned={instancePinned}
            onInstanceSelect={selectInstance}
          />
        </section>
      </div>
    </>
  );
}

export function V3CancelButton(props: {
  runStatus: RunView['runStatus'] | undefined;
  busy: boolean;
  onCancel: () => void;
}): JSX.Element | null {
  const tr = useT();
  if (!ui.authed) return null;
  const terminal = isTerminalRunStatus(props.runStatus);
  const cancelling = props.busy || props.runStatus === 'cancelling';
  return (
    <button
      type="button"
      className="danger v3r-cancel-button"
      disabled={!props.runStatus || terminal || cancelling}
      title={terminal ? tr('workflow.v3.cancelTerminal') : tr('workflow.v3.cancelTitle')}
      onClick={props.onCancel}
    >
      {cancelling
        ? tr('workflow.v3.cancelling')
        : terminal
          ? tr('workflow.v3.cancelTerminal')
          : tr('workflow.v3.cancel')}
    </button>
  );
}

function V3Legend(): JSX.Element {
  return (
    <div className="v3r-legend">
      <span className="lg st-pending">待机</span>
      <span className="lg st-running">运行中</span>
      <span className="lg st-gateWaiting">等审批</span>
      <span className="lg st-done">完成</span>
      <span className="lg st-skipped">已跳过</span>
      <span className="lg st-cancelled">已取消</span>
      <span className="lg st-blocked">受阻</span>
      <span className="lg st-failed">失败</span>
      <span className="lg lg-loop">⟳ 循环容器</span>
    </div>
  );
}

function DagGraph(props: {
  view: RunView | null;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}): JSX.Element {
  const layout = useMemo(() => props.view ? buildGraphLayout(props.view) : null, [props.view]);
  const topologyKey = layout
    ? `${layout.width}:${layout.height}:${layout.nodes.map(box => box.node.id).join('\u0000')}`
    : '';
  const graphRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph || !topologyKey) return undefined;

    let frame = 0;
    const centerGraph = () => {
      frame = 0;
      graph.scrollLeft = Math.max(0, (graph.scrollWidth - graph.clientWidth) / 2);
      graph.scrollTop = Math.max(0, (graph.scrollHeight - graph.clientHeight) / 2);
    };
    const scheduleCenter = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(centerGraph);
    };

    scheduleCenter();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleCenter);
    observer?.observe(graph);
    const stage = graph.querySelector('.v3r-graph-stage');
    if (stage) observer?.observe(stage);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [topologyKey]);

  return (
    <div id="v3-graph" className="v3r-graph" ref={graphRef}>
      {layout ? (
        <div className="v3r-graph-stage">
          <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
            <defs>
              <marker id="v3arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--faint, #8b98aa)" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <path
                key={`${edge.fromId}->${edge.toId}`}
                className={`v3r-edge${edge.live ? ' live' : ''}`}
                d={`M${edge.x1},${edge.y1} C${edge.mx},${edge.y1} ${edge.mx},${edge.y2} ${edge.x2},${edge.y2}`}
                markerEnd="url(#v3arrow)"
              />
            ))}
            {layout.nodes.map((box) => (
              <DagNode
                key={box.node.id}
                box={box}
                selected={box.node.id === props.selectedId}
                onSelect={props.onSelect}
              />
            ))}
          </svg>
        </div>
      ) : null}
    </div>
  );
}

function DagNode(props: {
  box: ReturnType<typeof buildGraphLayout>['nodes'][number];
  selected: boolean;
  onSelect: (nodeId: string) => void;
}): JSX.Element {
  const { box, selected } = props;
  const node = box.node;
  if (node.isLoop) {
    return <LoopGraphNode box={box} selected={selected} onSelect={props.onSelect} />;
  }
  return (
    <g
      className={`v3r-node st-${node.status}${selected ? ' sel' : ''}`}
      data-node={node.id}
      onClick={() => props.onSelect(node.id)}
    >
      <rect className="v3r-box" x={box.x} y={box.y} width={V3_GRAPH.nodeWidth} height={V3_GRAPH.plainHeight} rx="10" />
      <text className="v3r-nid" x={box.x + 14} y={box.y + 20}>{trunc(node.id, 18)}</text>
      <text className="v3r-nstatus" x={box.x + 14} y={box.y + 37}>{V3_NODE_LABEL[node.status]}</text>
    </g>
  );
}

function LoopGraphNode(props: {
  box: ReturnType<typeof buildGraphLayout>['nodes'][number];
  selected: boolean;
  onSelect: (nodeId: string) => void;
}): JSX.Element {
  const { box, selected } = props;
  const node = box.node;
  const ls = node.loopState;
  const budget = loopBudget(node);
  const statusLine = ls
    ? `${V3_NODE_LABEL[node.status]} · 第${ls.iteration}${budget !== undefined ? `/${budget}` : ''}轮`
    : `${V3_NODE_LABEL[node.status]} · loop`;
  const maxIterations = ls?.maxIterations;

  return (
    <g
      className={`v3r-node v3r-loopnode st-${node.status}${selected ? ' sel' : ''}`}
      data-node={node.id}
      onClick={() => props.onSelect(node.id)}
    >
      <rect className="v3r-cap" x={box.x - 4} y={box.y - 4} width={V3_GRAPH.nodeWidth + 8} height={V3_GRAPH.loopHeight + 8} rx="14" />
      <rect className="v3r-box" x={box.x} y={box.y} width={V3_GRAPH.nodeWidth} height={V3_GRAPH.loopHeight} rx="10" />
      <text className="v3r-spin" x={box.x + 14} y={box.y + 21}>⟳</text>
      <text className="v3r-nid" x={box.x + 30} y={box.y + 21}>{trunc(node.id, 16)}</text>
      <text className="v3r-nstatus" x={box.x + 14} y={box.y + 39}>{statusLine}</text>
      {ls && budget !== undefined && budget <= V3_GRAPH.maxDots ? (
        <LoopBudgetDots node={node} x={box.x} y={box.y} budget={budget} maxIterations={maxIterations} />
      ) : null}
    </g>
  );
}

function LoopBudgetDots(props: {
  node: RunNodeView;
  x: number;
  y: number;
  budget: number;
  maxIterations: number | undefined;
}): JSX.Element {
  const ls = props.node.loopState!;
  const cy = props.y + V3_GRAPH.loopHeight - 13;
  const dots = Array.from({ length: props.budget }, (_, idx) => idx + 1);

  return (
    <>
      {dots.map((k) => {
        const cls = k < ls.iteration
          ? 'v3r-dot done'
          : k === ls.iteration
            ? `v3r-dot cur${props.node.status === 'running' ? ' live' : ''}`
            : 'v3r-dot todo';
        const grant = props.maxIterations !== undefined && k > props.maxIterations ? ' grant' : '';
        return <circle key={k} className={`${cls}${grant}`} cx={props.x + 14 + (k - 1) * 15} cy={cy} r="3.6" />;
      })}
      {ls.lastDecision === 'exit' ? (
        <text className="v3r-dots-verdict ok" x={props.x + 14 + props.budget * 15 + 4} y={cy + 4}>✓</text>
      ) : null}
      {ls.lastDecision === 'exhausted' && props.node.status === 'blocked' ? (
        <text className="v3r-dots-verdict warn" x={props.x + 14 + props.budget * 15 + 4} y={cy + 4}>⚠</text>
      ) : null}
    </>
  );
}

function NodePanel(props: {
  runId: string;
  view: RunView | null;
  node: RunNodeView | null;
  instanceId: string | null;
  instancePinned: boolean;
  onInstanceSelect: (nodeId: string) => void;
}): JSX.Element {
  const node = props.node;
  const instances = useMemo(
    () => node?.isLoop ? loopInstances(props.view, node.id) : [],
    [node, props.view],
  );
  const termNode = node?.isLoop
    ? resolveLoopTerminalNode(instances, props.instanceId, props.instancePinned)
    : node;
  const activeInstanceId = node?.isLoop ? termNode?.id ?? null : null;

  if (!node) {
    return (
      <div id="v3-node-panel" className="v3r-panel">
        <p className="muted">点一个节点看详情与终端</p>
      </div>
    );
  }

  return (
    <div id="v3-node-panel" className="v3r-panel">
      <div id="v3-node-meta">
        {node.goal ? <p className="v3r-goal">{node.goal}</p> : null}
        {node.depends.length ? (
          <p className="v3r-deps">
            <span>依赖</span>
            {node.depends.map((dep) => <span key={dep} className="v3r-dep">{dep}</span>)}
          </p>
        ) : null}
        {node.errorClass ? <NodeErrorLine node={node} /> : null}
        {node.isLoop ? (
          <LoopTimeline
            runId={props.runId}
            node={node}
            instances={instances}
            activeInstanceId={activeInstanceId}
            onInstanceSelect={props.onInstanceSelect}
          />
        ) : null}
      </div>
      <div id="v3-inst-strip">
        {node.isLoop && termNode ? (
          <InstanceStrip node={termNode} auto={!props.instancePinned} />
        ) : null}
      </div>
      <TerminalSlot runId={props.runId} node={termNode} />
    </div>
  );
}

function NodeErrorLine(props: { node: RunNodeView }): JSX.Element {
  const node = props.node;
  return (
    <p className="v3r-err">
      原因：{node.errorClass}{node.errorCode ? ` (${node.errorCode})` : ''}
      {node.status === 'blocked' && !node.isLoop ? (
        <> — 飞书卡片或 <code>botmux workflow retry</code> 可重试</>
      ) : null}
    </p>
  );
}

function InstanceStrip(props: { node: RunNodeView; auto: boolean }): JSX.Element {
  const loop = props.node.loop!;
  return (
    <div className="v3r-inst-strip">
      <span className="lbl">实例终端</span>
      <span className="v3r-nodeid sm">{props.node.id}</span>
      <span className={`v3r-pill st-${props.node.status}`}><i className="dot" />{V3_NODE_LABEL[props.node.status]}</span>
      <span className="muted">第 {loop.iteration} 轮 · {loop.bodyNodeId}{props.auto ? ' · 自动跟随' : ''}</span>
    </div>
  );
}

function LoopTimeline(props: {
  runId: string;
  node: RunNodeView;
  instances: RunNodeView[];
  activeInstanceId: string | null;
  onInstanceSelect: (nodeId: string) => void;
}): JSX.Element {
  const ls = props.node.loopState;
  if (!ls) return <p className="muted">loop 未开始</p>;

  const budget = loopBudget(props.node);
  const verdictOf = new Map(ls.decisions.map((decision) => [decision.iteration, decision.decision]));
  const rounds = loopRounds(props.instances);

  return (
    <div className="v3r-loop-sec">
      <div className="v3r-loop-meter">
        <span className="num">第 <b>{ls.iteration}</b>{budget !== undefined ? <> / <b>{budget}</b></> : null} 轮</span>
        {ls.granted > 0 ? <span className="v3r-granted-tag">含人工追加 +{ls.granted}</span> : null}
        {ls.lastDecision === 'exit' ? <span className="v3r-verdict vd-exit">✓ 已收敛</span> : null}
      </div>
      <div className="v3r-rounds">
        {rounds.map((round) => {
          const verdict = verdictOf.get(round.iteration);
          const isCurrent = round.iteration === ls.iteration;
          const granted = ls.maxIterations !== undefined && round.iteration > ls.maxIterations;
          return (
            <div key={round.iteration} className={`v3r-round${isCurrent ? ' cur' : ''}${verdict ? ` vd-${verdict}` : ''}`}>
              <div className="v3r-round-head">
                <span className="rn">R{round.iteration}</span>
                {granted ? <span className="v3r-granted-tag">➕ 追加轮</span> : null}
                {verdict ? (
                  <span className={`v3r-verdict vd-${verdict}`}>{V3_DECISION_LABEL[verdict]}</span>
                ) : isCurrent && props.node.status === 'running' ? (
                  <span className="v3r-verdict vd-live">▶ 进行中</span>
                ) : null}
              </div>
              <RoundMiniDag
                template={ls.bodyTemplate}
                instances={round.instances}
                activeInstanceId={props.activeInstanceId}
                onInstanceSelect={props.onInstanceSelect}
              />
            </div>
          );
        })}
      </div>
      {props.node.status === 'blocked' ? (
        <div className="v3r-cta">
          ⚠ 轮数耗尽，等人追加 — 飞书卡片点「➕ 追加 1 轮」，或 <code>botmux workflow grant {props.runId}</code>
        </div>
      ) : null}
    </div>
  );
}

function RoundMiniDag(props: {
  template: Array<{ id: string; depends: string[] }>;
  instances: RunNodeView[];
  activeInstanceId: string | null;
  onInstanceSelect: (nodeId: string) => void;
}): JSX.Element {
  const instanceByBodyId = useMemo(
    () => new Map(props.instances.map((instance) => [instance.loop!.bodyNodeId, instance])),
    [props.instances],
  );
  const layout = useMemo(
    () => buildRoundMiniDagLayout(props.template, instanceByBodyId),
    [props.template, instanceByBodyId],
  );

  return (
    <svg className="v3r-mini-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
      <defs>
        <marker id="v3arrow-mini" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--faint, #8b98aa)" />
        </marker>
      </defs>
      {layout.edges.map((edge) => (
        <path
          key={`${edge.fromId}->${edge.toId}`}
          className={`v3r-edge${edge.live ? ' live' : ''}`}
          d={`M${edge.x1},${edge.y1} C${edge.mx},${edge.y1} ${edge.mx},${edge.y2} ${edge.x2},${edge.y2}`}
          markerEnd="url(#v3arrow-mini)"
        />
      ))}
      {layout.nodes.map((box) => {
        const node = box.node;
        const status = node?.status ?? 'pending';
        const selected = node?.id === props.activeInstanceId;
        return (
          <g
            key={box.templateId}
            className={`v3r-node v3r-mini st-${status}${selected ? ' sel' : ''}${node ? '' : ' ghost'}`}
            data-sel={node?.id}
            style={node ? { cursor: 'pointer' } : undefined}
            onClick={(event) => {
              if (!node) return;
              event.stopPropagation();
              props.onInstanceSelect(node.id);
            }}
          >
            <rect className="v3r-box" x={box.x} y={box.y} width={box.width} height={box.height} rx="8" />
            <circle className="v3r-mini-dot" cx={box.x + 13} cy={box.y + box.height / 2} r="3.4" />
            <text className="v3r-nid" x={box.x + 24} y={box.y + box.height / 2 + 4}>{trunc(box.templateId, 12)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function TerminalSlot(props: { runId: string; node: RunNodeView | null }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const renderedSignatureRef = useRef<string | null>(null);
  const signature = props.node ? `${props.runId}|${props.node.id}|${nodeTerminalSignature(props.node)}` : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!props.node || !signature) {
      el.innerHTML = '';
      renderedSignatureRef.current = null;
      return;
    }
    if (renderedSignatureRef.current === signature) return;
    renderNodeTerminal(el, props.runId, props.node);
    renderedSignatureRef.current = signature;
  }, [props.runId, props.node, signature]);

  return <div id="v3-term-slot" className="v3r-term-slot" ref={ref} />;
}

export function V3RunsPage(): JSX.Element {
  const runId = v3RunIdFromHash();
  return (
    <section className="page workflows-page v3-page">
      {runId ? <V3DetailPage runId={runId} /> : <V3ListPage />}
    </section>
  );
}
