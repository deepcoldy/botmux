/**
 * 飞书侧边栏里的工作流页面（设计 2026-11-03 §11.4）：任务消息签名行「工作流 ›」点开就是它。
 *
 * - 数据只来自 `/api/workflow-sidebar/<app>/<run>`：管理员拿到完整 RunView（含终端 / 日志入口），
 *   群成员拿到服务端裁好的精简视图。页面不另做权限判断，只按服务端给的受众渲染。
 * - 复用看板的流程图组件，350–800px 宽度改成竖排；每 2 秒刷新，run 结束后停；点节点展开详情。
 * - 运行中改过流程时，图下方列出流程版本（复用看板的版本面板）：管理员看到的与看板一致；
 *   群成员只有已生效的版本（版本号、时间、角色、摘要、是否经过确认）。
 */
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { workflowSidebarApiPath, type WorkflowSidebarTarget } from '../../core/workflow-sidebar-link.js';
import type { RunNodeView, RunView } from '../../workflows/v3/ops-projection.js';
import type {
  WorkflowSidebarAdminPayload,
  WorkflowSidebarLanding,
  WorkflowSidebarMemberNode,
  WorkflowSidebarMemberPayload,
} from '../workflow-sidebar-view.js';
import {
  DagNode,
  NodeErrorLine,
  NodeExecution,
  RevisionHistory,
  TerminalSlot,
  V3Legend,
} from './v3-components.js';
import {
  V3_DISPLAY_LABEL,
  V3_DISPLAY_STATUS,
  V3_NODE_LABEL,
  V3_POLL_MS,
  buildVerticalGraphLayout,
  graphNodes,
  isTerminalRunStatus,
} from './v3-model.js';

export type WorkflowSidebarPayload = WorkflowSidebarAdminPayload | WorkflowSidebarMemberPayload;

export type WorkflowSidebarFetchResult =
  | { ok: true; payload: WorkflowSidebarPayload }
  | { ok: false; status: number; loginUrl?: string };

export type WorkflowSidebarFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchWorkflowSidebar(
  target: WorkflowSidebarTarget,
  fetcher: WorkflowSidebarFetch = fetch,
): Promise<WorkflowSidebarFetchResult> {
  const response = await fetcher(workflowSidebarApiPath(target), { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) {
    const loginUrl = response.headers.get('x-botmux-login-url') ?? undefined;
    return { ok: false, status: response.status, ...(loginUrl ? { loginUrl } : {}) };
  }
  const body = await response.json() as WorkflowSidebarPayload;
  return { ok: true, payload: body };
}

/**
 * 成员视图节点 → 流程图组件吃的 RunNodeView 形状。补的都是「没有」：没有终端、没有日志、
 * 没有产物、没有错误码。图组件只读状态 / Bot / 时间 / 循环这几样。
 */
export function memberNodeAsRunNode(node: WorkflowSidebarMemberNode): RunNodeView {
  return {
    id: node.id,
    status: node.status,
    depends: node.depends,
    ...(node.goal ? { goal: node.goal } : {}),
    hasPtyLog: false,
    hasManifest: false,
    ...(node.isLoop ? { isLoop: true } : {}),
    ...(node.loop ? { loop: node.loop } : {}),
    ...(node.loopState ? { loopState: { ...node.loopState } } : {}),
    ...(node.bot ? { bot: { ...node.bot } } : {}),
    ...(node.host ? { host: node.host } : {}),
    ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
    ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
    ...(node.gateSince !== undefined ? { gateSince: node.gateSince } : {}),
    attempts: node.attempts.map((attempt, index) => ({
      attemptId: `a${index + 1}`,
      startedAt: attempt.startedAt,
      ...(attempt.endedAt !== undefined ? { endedAt: attempt.endedAt } : {}),
      ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
    })),
  };
}

interface SidebarModel {
  audience: 'admin' | 'member';
  view: RunView;
  landings: Map<string, WorkflowSidebarLanding>;
  title: string;
  mainBotName?: string;
  chatUrl?: string;
}

export function sidebarModel(payload: WorkflowSidebarPayload): SidebarModel {
  const run = payload.run;
  if (payload.audience === 'admin') {
    return {
      audience: 'admin',
      view: payload.view,
      landings: new Map(Object.entries(payload.landings)),
      title: run.title,
      ...(run.mainBot.name ? { mainBotName: run.mainBot.name } : {}),
      ...(run.chatUrl ? { chatUrl: run.chatUrl } : {}),
    };
  }
  const landings = new Map<string, WorkflowSidebarLanding>();
  for (const node of payload.view.nodes) if (node.landing) landings.set(node.id, node.landing);
  const revisions = payload.view.revisions;
  return {
    audience: 'member',
    view: {
      runId: payload.view.runId,
      runStatus: payload.view.runStatus,
      nodes: payload.view.nodes.map(memberNodeAsRunNode),
      // Members only ever get versions that took effect.
      ...(revisions ? {
        revision: {
          current: revisions.current,
          history: revisions.history.map((entry) => ({ ...entry, state: 'applied' as const })),
        },
      } : {}),
      generatedAt: payload.view.generatedAt,
    },
    landings,
    title: run.title,
    ...(run.mainBot.name ? { mainBotName: run.mainBot.name } : {}),
    ...(run.chatUrl ? { chatUrl: run.chatUrl } : {}),
  };
}

type PollState =
  | { kind: 'loading' }
  | { kind: 'ready'; model: SidebarModel }
  | { kind: 'denied'; status: number; loginUrl?: string };

function useSidebarPoll(target: WorkflowSidebarTarget, fetcher?: WorkflowSidebarFetch): PollState {
  const [state, setState] = useState<PollState>({ kind: 'loading' });
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      if (disposed) return;
      let stop = false;
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const result = await fetchWorkflowSidebar(target, fetcher);
          if (disposed) return;
          if (result.ok) {
            const model = sidebarModel(result.payload);
            setState({ kind: 'ready', model });
            stop = isTerminalRunStatus(model.view.runStatus);
          } else if (result.status === 401 || result.status === 403 || result.status === 404) {
            setState({ kind: 'denied', status: result.status, ...(result.loginUrl ? { loginUrl: result.loginUrl } : {}) });
            stop = true;
          }
        } catch { /* transient; next tick retries */ }
      }
      if (!disposed && !stop) timer = setTimeout(() => { void poll(); }, V3_POLL_MS);
    }
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [target.appId, target.runId, fetcher]);
  return state;
}

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function VerticalDag(props: {
  view: RunView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const [ref, width] = useContainerWidth();
  const layout = useMemo(() => buildVerticalGraphLayout(props.view, width), [props.view, width]);
  return (
    <div className="wfs-graph" ref={ref}>
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <defs>
          <marker id="wfs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--faint, #8b98aa)" />
          </marker>
        </defs>
        {layout.edges.map((edge) => (
          <path
            key={`${edge.fromId}->${edge.toId}`}
            className={`v3r-edge${edge.live ? ' live' : ''}${edge.pending ? ' pending' : ''}`}
            d={`M${edge.x1},${edge.y1} C${edge.x1},${edge.my} ${edge.x2},${edge.my} ${edge.x2},${edge.y2}`}
            markerEnd="url(#wfs-arrow)"
          />
        ))}
        {layout.nodes.map((box) => (
          <DagNode
            key={box.node.id}
            box={box}
            generatedAt={props.view.generatedAt}
            selected={box.node.id === props.selectedId}
            onSelect={props.onSelect}
          />
        ))}
      </svg>
    </div>
  );
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function LandingRow(props: { landing: WorkflowSidebarLanding | undefined }): React.JSX.Element | null {
  const landing = props.landing;
  if (!landing) return null;
  return (
    <p className="v3r-exec-row wfs-landing">
      <span>落点</span>
      {landing.placement === 'main' ? '主话题' : '节点话题'}
      {landing.handoffAt !== undefined ? ` · ${formatClock(landing.handoffAt)} 交接` : ''}
      {landing.url ? <> · <a href={landing.url} target="_blank" rel="noopener noreferrer">打开</a></> : null}
    </p>
  );
}

function NodeDetail(props: {
  model: SidebarModel;
  node: RunNodeView;
}): React.JSX.Element {
  const { model, node } = props;
  const status = V3_DISPLAY_STATUS[node.status];
  return (
    <div className="wfs-detail">
      <div className="wfs-detail-head">
        <code className="v3r-nodeid">{node.id}</code>
        <span className={`v3r-pill st-${node.status} ds-${status}`}>
          <i className="dot" />
          {V3_DISPLAY_LABEL[status]}{status === 'needsHuman' ? `（${V3_NODE_LABEL[node.status]}）` : ''}
        </span>
      </div>
      {node.goal ? <p className="v3r-goal">{node.goal}</p> : null}
      <NodeExecution node={node} generatedAt={model.view.generatedAt} />
      <LandingRow landing={model.landings.get(node.id)} />
      {node.depends.length ? (
        <p className="v3r-deps"><span>依赖</span>{node.depends.map((dep) => <span key={dep} className="v3r-dep">{dep}</span>)}</p>
      ) : null}
      {model.audience === 'admin' && node.errorClass ? <NodeErrorLine node={node} /> : null}
      {model.audience === 'admin' ? <TerminalSlot runId={model.view.runId} node={node} /> : null}
    </div>
  );
}

const RUN_STATUS_LABEL: Record<RunView['runStatus'], string> = {
  running: '运行中',
  cancelling: '取消中',
  cancelled: '已取消',
  succeeded: '已完成',
  failed: '失败',
  blocked: '受阻',
};

function DeniedPanel(props: { status: number; loginUrl?: string }): React.JSX.Element {
  const text = props.status === 401
    ? '需要先确认你的飞书身份。'
    : props.status === 404
      ? '找不到这个工作流运行。'
      : '你没有查看这个工作流的权限：只有本群当前成员和 Dashboard 管理员能看。';
  return (
    <div className="wfs-denied" role="alert">
      <p>{text}</p>
      {props.status === 401 && props.loginUrl ? <a className="auth-login-link primary" href={props.loginUrl}>登录</a> : null}
    </div>
  );
}

export function WorkflowSidebarPage(props: { target: WorkflowSidebarTarget; fetcher?: WorkflowSidebarFetch }): React.JSX.Element {
  const state = useSidebarPoll(props.target, props.fetcher);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toggle = useCallback((id: string) => setSelectedId((current) => (current === id ? null : id)), []);
  if (state.kind === 'loading') return <section className="wfs-page"><p className="muted">加载中…</p></section>;
  if (state.kind === 'denied') return <section className="wfs-page"><DeniedPanel status={state.status} loginUrl={state.loginUrl} /></section>;
  const { model } = state;
  const selected = selectedId ? model.view.nodes.find((node) => node.id === selectedId) ?? null : null;
  const visible = graphNodes(model.view);
  return (
    <section className={`wfs-page wfs-${model.audience}`} data-audience={model.audience}>
      <header className="wfs-head">
        <h1 title={model.title}>{model.title}</h1>
        <div className="wfs-sub">
          <span className={`v3r-pill rs-${model.view.runStatus}`}>{RUN_STATUS_LABEL[model.view.runStatus]}</span>
          <span>{visible.filter((node) => node.status === 'done').length} / {visible.length} 节点完成</span>
          {model.mainBotName ? <span>主 Bot：{model.mainBotName}</span> : null}
          {model.chatUrl ? <a href={model.chatUrl} target="_blank" rel="noopener noreferrer">打开群</a> : null}
        </div>
      </header>
      <div className="v3r-graph-card wfs-graph-card">
        <VerticalDag view={model.view} selectedId={selectedId} onSelect={toggle} />
        <V3Legend />
      </div>
      {selected ? <NodeDetail model={model} node={selected} /> : <p className="muted wfs-hint">点一个节点看详情</p>}
      {model.view.revision ? (
        <div className="wfs-revisions"><RevisionHistory revision={model.view.revision} /></div>
      ) : null}
    </section>
  );
}
