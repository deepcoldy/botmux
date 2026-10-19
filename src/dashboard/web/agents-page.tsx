import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { store } from './store.js';
import { botAvatarHtml, botOrbStyle, ui } from './ui.js';
import {
  CreateActionButton,
  FieldTitle,
  Html,
  LoadingState,
  OverflowText,
  RefreshIconButton,
  ToggleRow,
} from './dashboard-components.js';
import { DropdownField, ModelPickerField } from './field-controls.js';
import { ModalDialog } from './modal-dialog.js';
import { BotMultiSelect } from './bot-multi-select.js';
import { confirm } from './confirm-modal.js';
import { toast } from './toast.js';
import {
  createRefreshGate,
  fallbackCliOptionsState,
  fetchBotDefaults,
  fetchCliOptions,
  fetchDetectedModels,
  mergeModelCandidates,
  modelSuggestionsForOption,
  selectedCliOption,
  type BotDefaultsRow,
  type CliOptionsState,
} from './bot-defaults.js';
import { lookupCliSelection } from '../../setup/cli-selection.js';
import { cliSupportsConfigDir } from '../../core/cli-config-dir.js';
import { BackendTypeField, BdTabGrid, SandboxModeFields, WorkingDirModeFields } from './bot-defaults-page.js';
import { reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import {
  AGENT_SANDBOX_MODES,
  AGENT_SECTIONS,
  agentBotDrift,
  agentLinkedBots,
  botSectionValues,
  diffAgentSections,
  parseStartupCommands,
  type AgentBackendConfig,
  type AgentDiffField,
  type AgentFieldDiff,
  type AgentLinkStatus,
  type AgentProfile,
  type AgentPromptInjectionMode,
  type AgentSection,
  type AgentSectionsConfig,
  type AgentWorkspaceMode,
} from '../agent-profiles-model.js';
import {
  createAgent,
  deleteAgent,
  fetchAgents,
  linkAgent,
  syncAgentToBot,
  syncAgentToBots,
  unlinkAgent,
  updateAgent,
  type AgentInput,
  type AgentsSnapshot,
  type BotSyncResult,
} from './agents-api.js';
import { DEFAULT_AGENT_GRAPH_METRICS, agentPortOffset, edgePath, layoutAgentGraph } from './agents-graph-layout.js';
import { hashQueryParam } from './dashboard-routes.js';

type Translate = ReturnType<typeof useT>;
type View = 'graph' | 'list';
type LinkTarget = { appId: string; agentId: string | null };

// ─── 展示辅助 ────────────────────────────────────────────────────────────────

function botName(bot: BotDefaultsRow | undefined, fallback = ''): string {
  return bot?.displayName || bot?.botName || bot?.larkAppId || fallback;
}

function cliLabel(cliState: CliOptionsState, key: string): string {
  return selectedCliOption(cliState.options, key)?.label ?? key;
}

function realCliId(key: string): string {
  return lookupCliSelection(key)?.cliId ?? key;
}

/** botOrbStyle 返回 `--c1:…;--c2:…`，转成 React style 对象复用同一套色板。 */
function orbStyle(seed: string): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const part of botOrbStyle(seed).split(';')) {
    const [key, value] = part.split(':');
    if (key && value) style[key.trim()] = value.trim();
  }
  return style as React.CSSProperties;
}

function cliInitials(label: string): string {
  const words = label.split(/[\s×x·/_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map(word => word[0]) : [label.slice(0, 2)];
  return letters.join('').toUpperCase() || '?';
}

function CliBadge(props: { cliKey: string | undefined; cliState: CliOptionsState; size?: 'sm' | 'md' }) {
  const key = props.cliKey ?? '';
  const label = key ? cliLabel(props.cliState, key) : '—';
  return (
    <span className={`ag-cli-badge${props.size === 'sm' ? ' ag-cli-badge-sm' : ''}`} style={orbStyle(key || 'none')} aria-hidden="true">
      {key ? cliInitials(label) : '·'}
    </span>
  );
}

function effortLabel(tr: Translate, value: string): string {
  if (!value) return tr('agents.valueDefault');
  return tr(`botDefaults.agentReasoningEffort${value === 'xhigh' ? 'Xhigh' : value[0]!.toUpperCase() + value.slice(1)}`);
}

function workspaceModeLabel(tr: Translate, mode: string): string {
  if (mode === 'default') return tr('botDefaults.optWdDefaultName');
  if (mode === 'oncall') return tr('botDefaults.optWdOncallName');
  return tr('botDefaults.optWdOffName');
}

function sandboxModeLabel(tr: Translate, mode: string): string {
  if (mode === 'oncall') return tr('botDefaults.sandboxModeOncall');
  if (mode === 'scratch') return tr('botDefaults.sandboxModeScratch');
  return tr('botDefaults.sandboxModeOff');
}

function backendLabel(tr: Translate, value: string): string {
  return value ? value : tr('botDefaults.backendAuto');
}

function sectionLabel(tr: Translate, section: AgentSection): string {
  return tr(`agents.section.${section}`);
}

function fieldLabel(tr: Translate, field: AgentDiffField): string {
  return tr(`agents.field.${field}`);
}

function diffValue(tr: Translate, cliState: CliOptionsState, field: AgentDiffField, value: string): string {
  switch (field) {
    case 'cliId': return value ? cliLabel(cliState, value) : tr('agents.valueDefault');
    case 'reasoningEffort': return effortLabel(tr, value);
    case 'workspaceMode': return workspaceModeLabel(tr, value);
    case 'sandboxMode': return sandboxModeLabel(tr, value);
    case 'backendType': return backendLabel(tr, value);
    case 'autoWorktree': return value === 'true' ? tr('agents.valueOn') : tr('agents.valueOff');
    case 'startupCommands': return value ? value.split('\n').join(' / ') : tr('agents.valueNone');
    case 'promptInjection': return value === 'none' ? tr('agents.valueOn') : tr('agents.valueOff');
    default: return value || tr('agents.valueDefault');
  }
}

function agentExecSummary(tr: Translate, cliState: CliOptionsState, agent: AgentSectionsConfig): string {
  if (!agent.exec) return tr('agents.execUnset');
  return [
    cliLabel(cliState, agent.exec.cliId),
    agent.exec.model || null,
    agent.exec.reasoningEffort ? effortLabel(tr, agent.exec.reasoningEffort) : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Agent 的副标题：有描述时以描述为准（同名 Agent 靠它区分），没有时回落到「CLI · 模型 · 强度」。
 * `withRun` 用于空间充裕处，两者都显示。
 */
function agentSubtitle(tr: Translate, cliState: CliOptionsState, agent: AgentProfile, withRun = false): string {
  const run = agentExecSummary(tr, cliState, agent);
  if (!agent.description) return run;
  return withRun ? `${agent.description} · ${run}` : agent.description;
}

function linkStatusText(tr: Translate, status: AgentLinkStatus): string {
  if (status.state === 'offline') return tr('agents.stateOffline');
  if (status.state === 'drift') {
    return tr('agents.stateDrift', {
      count: status.diffs.length,
      sections: status.sections.map(section => sectionLabel(tr, section)).join(tr('agents.listSep')),
    });
  }
  return tr('agents.stateSynced');
}

function summarizeSync(tr: Translate, results: readonly BotSyncResult[], bots: readonly BotDefaultsRow[]): { text: string; ok: boolean } {
  const failed = results.filter(result => result.failures.length > 0);
  const closed = results.reduce((sum, result) => sum + result.closedSessions, 0);
  const residual = results.reduce((sum, result) => sum + result.residualSessions, 0);
  const parts: string[] = [];
  if (failed.length === 0) parts.push(tr('agents.syncAllOk', { count: results.length }));
  else {
    const first = failed[0]!;
    const name = botName(bots.find(bot => bot.larkAppId === first.larkAppId), first.larkAppId);
    const error = first.failures[0]!.error;
    const reason = error === 'offline' ? tr('agents.stateOffline')
      : error === 'zero_prompt_unsupported' ? tr('agents.syncZeroPromptUnsupported')
        : error;
    parts.push(tr('agents.syncSomeFailed', { failed: failed.length, total: results.length, name, reason }));
  }
  if (closed > 0) parts.push(tr('botDefaults.agentClosedCount', { count: closed }));
  if (residual > 0) parts.push(tr('botDefaults.agentClosedResidual', { count: residual }));
  for (const warning of new Set(results.flatMap(result => result.warnings))) parts.push(warning);
  return { text: parts.join('；'), ok: failed.length === 0 && residual === 0 };
}

function computeStatuses(snapshot: AgentsSnapshot, bots: readonly BotDefaultsRow[]): Map<string, AgentLinkStatus> {
  const byId = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const out = new Map<string, AgentLinkStatus>();
  for (const bot of bots) {
    const agent = byId.get(snapshot.links[bot.larkAppId] ?? '');
    if (agent) out.set(bot.larkAppId, agentBotDrift(agent, bot));
  }
  return out;
}

/** 关联后会切换 CLI 的 Bot：daemon 会关闭其上使用旧 CLI 的活跃会话，需提前告知。 */
function botsSwitchingCli(agent: AgentSectionsConfig, bots: readonly BotDefaultsRow[]): BotDefaultsRow[] {
  return bots.filter(bot => bot.online !== false && diffAgentSections(agent, bot).some(diff => diff.field === 'cliId'));
}

// ─── 页面 ────────────────────────────────────────────────────────────────────

export function AgentsPage() {
  const tr = useT();
  const mountedRef = useRef(true);
  const gateRef = useRef(createRefreshGate());
  const [snapshot, setSnapshot] = useState<AgentsSnapshot>({ agents: [], links: {} });
  const [bots, setBots] = useState<BotDefaultsRow[]>([]);
  const [cliState, setCliState] = useState<CliOptionsState>(fallbackCliOptionsState);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `#/agents?agent=<id>`（Bot 配置页提示条入口）直接打开该 Agent 的配置视图。
  const deepLinkAgent = useMemo(() => hashQueryParam('agent'), []);
  const [view, setView] = useState<View>(deepLinkAgent ? 'list' : 'graph');
  const [selectedId, setSelectedId] = useState<string | null>(deepLinkAgent);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // 与 Bot 配置页同口径：只看 ui.authed（publicReadOnly 是「对访客开放只读」的站点策略，
  // 不代表当前用户只读）；写接口另有服务端 canManageHost 兜底。
  const canEdit = ui.authed;

  const refresh = useCallback(async () => {
    const req = gateRef.current.begin();
    try {
      const [agents, botsResult, cli] = await Promise.all([fetchAgents(), fetchBotDefaults(), fetchCliOptions()]);
      if (!mountedRef.current || !req.commit()) return;
      setSnapshot(agents);
      setBots(botsResult.bots);
      setCliState(cli);
      setLoadError(botsResult.error);
    } catch (error) {
      if (mountedRef.current && req.commit()) setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && req.commit()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const off = store.onBotsChanged(() => { if (mountedRef.current) void refresh(); });
    return () => { mountedRef.current = false; off(); };
  }, [refresh]);

  const statuses = useMemo(() => computeStatuses(snapshot, bots), [snapshot, bots]);

  useEffect(() => {
    // 首屏数据回来之前不校验，否则深链带进来的 agent id 会被空列表清掉。
    if (loading) return;
    if (selectedId && !snapshot.agents.some(agent => agent.id === selectedId)) setSelectedId(null);
    else if (!selectedId && snapshot.agents.length) setSelectedId(snapshot.agents[0]!.id);
  }, [loading, snapshot.agents, selectedId]);

  const openAgent = (id: string) => { setSelectedId(id); setView('list'); };

  /** Agent 定义变化后：落新快照，再把它下发到给定 Bot（只推有偏差的分组）。 */
  const applySnapshotAndSync = useCallback(async (next: AgentsSnapshot, agent: AgentSectionsConfig | null, targets: readonly BotDefaultsRow[]) => {
    setSnapshot(next);
    if (!agent || targets.length === 0) return;
    const pending = targets.filter(bot => agentBotDrift(agent, bot).state !== 'synced');
    if (pending.length === 0) return;
    const results = await syncAgentToBots(agent, pending);
    const summary = summarizeSync(tr, results, bots);
    toast(summary.text, { kind: summary.ok ? 'success' : 'error', duration: summary.ok ? 3000 : 8000 });
    await refresh();
  }, [bots, refresh, tr]);

  let body: React.ReactNode;
  if (loading) body = <LoadingState label={tr('agents.loading')} />;
  else if (loadError && bots.length === 0) body = <div className="ag-empty">{loadError}</div>;
  else if (view === 'graph') {
    body = (
      <AgentGraphView
        agents={snapshot.agents}
        bots={bots}
        links={snapshot.links}
        statuses={statuses}
        cliState={cliState}
        canEdit={canEdit}
        onOpenAgent={openAgent}
        onOpenLink={(appId, agentId) => setLinkTarget({ appId, agentId })}
        onCreate={() => setCreateOpen(true)}
      />
    );
  } else {
    body = (
      <AgentListView
        snapshot={snapshot}
        bots={bots}
        statuses={statuses}
        cliState={cliState}
        canEdit={canEdit}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={() => setCreateOpen(true)}
        onOpenLink={(appId, agentId) => setLinkTarget({ appId, agentId })}
        onSaved={applySnapshotAndSync}
        onDeleted={next => setSnapshot(next)}
        onSynced={refresh}
        onLinked={async next => {
          setSnapshot(next);
          await refresh();
        }}
      />
    );
  }

  return (
    <section className="page agents-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.agents')}</p>
          <h1>{tr('agents.title')}</h1>
          <p>{tr('agents.subtitle')}</p>
        </div>
        <div className="page-heading-actions">
          <div className="insight-tabs ag-view-tabs" role="tablist" aria-label={tr('agents.title')}>
            {(['graph', 'list'] as const).map(key => (
              <button
                key={key}
                type="button"
                role="tab"
                className={`itab${view === key ? ' on' : ''}`}
                aria-selected={view === key}
                onClick={() => setView(key)}
              >
                {tr(key === 'graph' ? 'agents.viewGraph' : 'agents.viewList')}
              </button>
            ))}
          </div>
          <RefreshIconButton
            label={tr('agents.refresh')}
            busy={refreshing}
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void refresh().finally(() => setRefreshing(false));
            }}
          />
          {canEdit ? (
            <CreateActionButton className="page-primary-action" onClick={() => setCreateOpen(true)}>
              {tr('agents.create')}
            </CreateActionButton>
          ) : null}
        </div>
      </div>
      {body}
      <LinkDialog
        target={linkTarget}
        snapshot={snapshot}
        bots={bots}
        cliState={cliState}
        onClose={() => setLinkTarget(null)}
        onDone={async next => {
          setLinkTarget(null);
          setSnapshot(next);
          await refresh();
        }}
      />
      <CreateAgentDialog
        open={createOpen}
        bots={bots}
        cliState={cliState}
        onClose={() => setCreateOpen(false)}
        onCreated={(agent, next) => {
          setCreateOpen(false);
          setSnapshot(next);
          setSelectedId(agent.id);
          setView('list');
        }}
      />
    </section>
  );
}

export function renderAgentsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <AgentsPage />);
}

// ─── 关联图 ──────────────────────────────────────────────────────────────────

type DragState = { agentId: string; y1: number; x: number; y: number; overBot: string | null };

function AgentGraphView(props: {
  agents: AgentProfile[];
  bots: BotDefaultsRow[];
  links: Record<string, string>;
  statuses: Map<string, AgentLinkStatus>;
  cliState: CliOptionsState;
  canEdit: boolean;
  onOpenAgent(id: string): void;
  onOpenLink(appId: string, agentId: string | null): void;
  onCreate(): void;
}) {
  const tr = useT();
  const { agents, bots, links, statuses, cliState } = props;
  const metrics = DEFAULT_AGENT_GRAPH_METRICS;
  const layout = useMemo(() => layoutAgentGraph(agents, bots, links, metrics), [agents, bots, links, metrics]);
  const botById = useMemo(() => new Map(bots.map(bot => [bot.larkAppId, bot])), [bots]);
  const agentById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ kind: 'agent' | 'bot'; id: string } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const focusAgent = hover?.kind === 'agent' ? hover.id
    : hover?.kind === 'bot' ? (layout.bots.find(node => node.id === hover.id)?.agentId ?? null)
    : drag?.agentId ?? null;
  const focusBot = hover?.kind === 'bot' ? hover.id : null;
  const anyFocus = focusAgent !== null || focusBot !== null;
  const edgeLit = (agentId: string, botId: string) => (focusBot ? botId === focusBot : agentId === focusAgent);

  function pointerToGraph(event: React.PointerEvent): { x: number; y: number; overBot: string | null } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const overBot = target?.closest<HTMLElement>('[data-ag-bot]')?.dataset.agBot ?? null;
    if (overBot) {
      const node = layout.bots.find(entry => entry.id === overBot);
      if (node) return { x: 100, y: node.y + node.height / 2, overBot };
    }
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    return { x, y: event.clientY - rect.top, overBot: null };
  }

  if (agents.length === 0 && bots.length === 0) {
    return <div className="ag-empty">{tr('agents.emptyNoBots')}</div>;
  }

  return (
    <div className={`ag-graph${drag ? ' is-dragging' : ''}`}>
      <div className="ag-graph-heads">
        <span>{tr('agents.colAgents', { count: agents.length })}</span>
        <span className="ag-graph-hint">{props.canEdit && agents.length ? tr('agents.dragHint') : ''}</span>
        <span>{tr('agents.colBots', { count: bots.length })}</span>
      </div>
      <div className="ag-graph-body" style={{ height: Math.max(layout.height, metrics.agentHeight) }}>
        <div className="ag-col ag-col-agents">
          {agents.length === 0 ? (
            <div className="ag-agent-empty" style={{ height: metrics.agentHeight }}>
              <p>{tr('agents.emptyAgents')}</p>
              {props.canEdit ? (
                <button type="button" className="ag-link-btn" onClick={props.onCreate}>{tr('agents.createFirst')}</button>
              ) : null}
            </div>
          ) : null}
          {layout.agents.map(node => {
            const agent = agentById.get(node.id)!;
            const linked = layout.bots.filter(bot => bot.agentId === node.id);
            const drifted = linked.filter(bot => statuses.get(bot.id)?.state === 'drift').length;
            const dim = anyFocus && focusAgent !== node.id;
            return (
              <div
                key={node.id}
                className={`ag-node ag-agent${dim ? ' dim' : ''}${focusAgent === node.id ? ' lit' : ''}`}
                style={{ top: node.y, height: node.height }}
                role="button"
                tabIndex={0}
                data-ag-agent={node.id}
                onClick={() => props.onOpenAgent(node.id)}
                onKeyDown={event => { if (event.key === 'Enter') props.onOpenAgent(node.id); }}
                onPointerEnter={() => !drag && setHover({ kind: 'agent', id: node.id })}
                onPointerLeave={() => setHover(current => (current?.kind === 'agent' && current.id === node.id ? null : current))}
              >
                <div className="ag-node-head">
                  <CliBadge cliKey={agent.exec?.cliId} cliState={cliState} />
                  <div className="ag-node-title">
                    <b><OverflowText text={agent.name} showPopover={false} /></b>
                    <span className="ag-node-sub">{agentSubtitle(tr, cliState, agent)}</span>
                  </div>
                </div>
                <div className="ag-node-meta">
                  <span className="ag-node-dir">
                    {agent.description ? `${agentExecSummary(tr, cliState, agent)} · ` : null}
                    {agent.workspace && agent.workspace.mode !== 'off'
                      ? <code>{agent.workspace.workingDir}</code>
                      : <span className="ag-muted">{agent.workspace ? workspaceModeLabel(tr, 'off') : tr('agents.workspaceUnset')}</span>}
                  </span>
                </div>
                <div className="ag-node-foot">
                  <span className={`ag-tag ${linked.length ? 'ag-tag-ok' : 'ag-tag-muted'}`}>
                    {linked.length ? tr('agents.tagLinked') : tr('agents.tagUnlinked')}
                  </span>
                  {drifted > 0 ? <span className="ag-tag ag-tag-warn">{tr('agents.tagDriftBots', { count: drifted })}</span> : null}
                  <span className="ag-node-count">{tr('agents.linkedCount', { count: linked.length })}</span>
                </div>
                {props.canEdit ? (
                  <span
                    className="ag-port"
                    style={{ top: agentPortOffset(metrics) }}
                    title={tr('agents.dragHint')}
                    onClick={event => event.stopPropagation()}
                    onPointerDown={event => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setHover(null);
                      const y1 = node.y + agentPortOffset(metrics);
                      setDrag({ agentId: node.id, y1, x: 0, y: y1, overBot: null });
                    }}
                    onPointerMove={event => {
                      if (!drag) return;
                      const point = pointerToGraph(event);
                      if (point) setDrag({ ...drag, ...point });
                    }}
                    onPointerUp={event => {
                      if (!drag) return;
                      const point = pointerToGraph(event);
                      setDrag(null);
                      if (point?.overBot) props.onOpenLink(point.overBot, drag.agentId);
                    }}
                    onPointerCancel={() => setDrag(null)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        <svg
          ref={svgRef}
          className="ag-edges"
          viewBox={`0 0 100 ${Math.max(1, layout.height)}`}
          preserveAspectRatio="none"
          style={{ height: layout.height }}
          aria-hidden="true"
        >
          {layout.edges.map(edge => {
            const state = statuses.get(edge.botId)?.state ?? 'synced';
            const lit = anyFocus && edgeLit(edge.agentId, edge.botId);
            const dim = anyFocus && !lit;
            return (
              <path
                key={edge.botId}
                className={`ag-edge ag-edge-${state}${lit ? ' lit' : ''}${dim ? ' dim' : ''}`}
                d={edgePath(edge.y1, edge.y2)}
              />
            );
          })}
          {drag ? <path className="ag-edge ag-edge-draft" d={edgePath(drag.y1, drag.y, drag.x)} /> : null}
        </svg>
        <div className="ag-col ag-col-bots">
          {layout.unlinkedTop !== null ? (
            <div className="ag-unlinked-head" style={{ top: layout.unlinkedTop, height: metrics.unlinkedHeaderHeight }}>
              <span>{tr('agents.unlinkedHead', { count: layout.bots.filter(node => node.agentId === null).length })}</span>
              <span className="ag-muted">{tr('agents.unlinkedHint')}</span>
            </div>
          ) : null}
          {layout.bots.map(node => {
            const bot = botById.get(node.id)!;
            const status = statuses.get(node.id);
            const name = botName(bot);
            const dim = anyFocus && !(focusBot === node.id || (node.agentId !== null && node.agentId === focusAgent));
            const sub = status
              ? linkStatusText(tr, status)
              : tr('agents.standalone', { cli: bot.agentSelectionKey ? cliLabel(cliState, bot.agentSelectionKey) : (bot.cliId ?? '—') });
            return (
              <div
                key={node.id}
                className={[
                  'ag-node ag-bot',
                  node.agentId ? '' : 'ag-bot-standalone',
                  status ? `ag-bot-${status.state}` : '',
                  dim ? 'dim' : '',
                  drag?.overBot === node.id ? 'is-drop' : '',
                ].filter(Boolean).join(' ')}
                style={{ top: node.y, height: node.height }}
                role="button"
                tabIndex={props.canEdit ? 0 : -1}
                data-ag-bot={node.id}
                aria-label={`${name} · ${sub}`}
                onClick={() => props.canEdit && props.onOpenLink(node.id, node.agentId)}
                onKeyDown={event => { if (props.canEdit && event.key === 'Enter') props.onOpenLink(node.id, node.agentId); }}
                onPointerEnter={() => !drag && setHover({ kind: 'bot', id: node.id })}
                onPointerLeave={() => setHover(current => (current?.kind === 'bot' && current.id === node.id ? null : current))}
              >
                <span className="ag-socket" aria-hidden="true" />
                <Html html={botAvatarHtml({ name, larkAppId: node.id, size: 'sm', dot: bot.online === false ? 'off' : undefined })} />
                <div className="ag-node-title">
                  <b><OverflowText text={name} showPopover={false} /></b>
                  <span className="ag-node-sub">{sub}</span>
                </div>
                {status?.state === 'drift' ? <span className="ag-tag ag-tag-warn">{tr('agents.tagDrift', { count: status.diffs.length })}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="ag-legend" aria-hidden="true">
        <span><i className="ag-legend-line ag-edge-synced" />{tr('agents.stateSynced')}</span>
        <span><i className="ag-legend-line ag-edge-drift" />{tr('agents.legendDrift')}</span>
        <span><i className="ag-legend-line ag-edge-offline" />{tr('agents.stateOffline')}</span>
      </div>
    </div>
  );
}

// ─── 列表 + 编辑 ─────────────────────────────────────────────────────────────

function AgentListView(props: {
  snapshot: AgentsSnapshot;
  bots: BotDefaultsRow[];
  statuses: Map<string, AgentLinkStatus>;
  cliState: CliOptionsState;
  canEdit: boolean;
  selectedId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  onOpenLink(appId: string, agentId: string | null): void;
  onSaved(next: AgentsSnapshot, agent: AgentSectionsConfig | null, targets: readonly BotDefaultsRow[]): Promise<void>;
  onDeleted(next: AgentsSnapshot): void;
  onSynced(): Promise<void>;
  onLinked(next: AgentsSnapshot): Promise<void>;
}) {
  const tr = useT();
  const { snapshot, cliState } = props;
  const selected = snapshot.agents.find(agent => agent.id === props.selectedId) ?? null;
  return (
    <div className="ag-layout">
      <aside className="bd-roster ag-roster">
        {snapshot.agents.length === 0 ? (
          <div className="ag-roster-empty">
            <p>{tr('agents.emptyAgents')}</p>
            {props.canEdit ? <button type="button" className="ag-link-btn" onClick={props.onCreate}>{tr('agents.createFirst')}</button> : null}
          </div>
        ) : snapshot.agents.map(agent => {
          const linked = agentLinkedBots(snapshot, agent.id).length;
          return (
            <div
              key={agent.id}
              className={`bd-roster-item${agent.id === props.selectedId ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => props.onSelect(agent.id)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelect(agent.id); } }}
            >
              <CliBadge cliKey={agent.exec?.cliId} cliState={cliState} size="sm" />
              <div className="bd-roster-tx">
                <b><OverflowText text={agent.name} showPopover={false} textClassName="bd-roster-name" /></b>
                <span title={agentExecSummary(tr, cliState, agent)}>{agentSubtitle(tr, cliState, agent)}</span>
              </div>
              <span className="ag-roster-count" title={tr('agents.linkedCount', { count: linked })}>{linked}</span>
            </div>
          );
        })}
      </aside>
      <div className="ag-detail">
        {selected ? (
          <AgentEditor
            key={selected.id}
            agent={selected}
            snapshot={snapshot}
            bots={props.bots}
            statuses={props.statuses}
            cliState={cliState}
            canEdit={props.canEdit}
            onOpenLink={props.onOpenLink}
            onSaved={props.onSaved}
            onDeleted={props.onDeleted}
            onSynced={props.onSynced}
            onLinked={props.onLinked}
          />
        ) : (
          <div className="ag-empty">{tr('agents.selectHint')}</div>
        )}
      </div>
    </div>
  );
}

type Draft = {
  name: string;
  description: string;
  exec: { on: boolean; cliId: string; model: string; reasoningEffort: string; configDir: string };
  workspace: { on: boolean; mode: AgentWorkspaceMode; workingDir: string; autoWorktree: boolean };
  sandbox: { on: boolean; mode: (typeof AGENT_SANDBOX_MODES)[number] };
  backend: { on: boolean; backendType: string };
  startup: { on: boolean; text: string };
  promptInjection: { on: boolean; mode: AgentPromptInjectionMode };
};

function draftFromAgent(agent: AgentProfile): Draft {
  return {
    name: agent.name,
    description: agent.description,
    exec: {
      on: !!agent.exec,
      cliId: agent.exec?.cliId ?? 'claude-code',
      model: agent.exec?.model ?? '',
      reasoningEffort: agent.exec?.reasoningEffort ?? '',
      configDir: agent.exec?.configDir ?? '',
    },
    workspace: {
      on: !!agent.workspace,
      mode: agent.workspace?.mode ?? 'default',
      workingDir: agent.workspace?.workingDir ?? '',
      autoWorktree: agent.workspace?.autoWorktree ?? false,
    },
    sandbox: { on: !!agent.sandbox, mode: agent.sandbox?.mode ?? 'off' },
    backend: { on: !!agent.backend, backendType: agent.backend?.backendType ?? '' },
    startup: { on: !!agent.startup, text: (agent.startup?.commands ?? []).join('\n') },
    promptInjection: { on: !!agent.promptInjection, mode: agent.promptInjection?.mode ?? 'none' },
  };
}

function inputFromDraft(draft: Draft): AgentInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    ...(draft.exec.on ? {
      exec: {
        cliId: draft.exec.cliId,
        model: draft.exec.model.trim(),
        reasoningEffort: draft.exec.reasoningEffort,
        configDir: cliSupportsConfigDir(realCliId(draft.exec.cliId)) ? draft.exec.configDir.trim() : '',
      },
    } : {}),
    ...(draft.workspace.on ? {
      workspace: {
        mode: draft.workspace.mode,
        workingDir: draft.workspace.mode === 'off' ? '' : draft.workspace.workingDir.trim(),
        autoWorktree: draft.workspace.mode === 'default' && draft.workspace.autoWorktree,
      },
    } : {}),
    ...(draft.sandbox.on ? { sandbox: { mode: draft.sandbox.mode } } : {}),
    ...(draft.backend.on ? { backend: { backendType: draft.backend.backendType as AgentBackendConfig['backendType'] } } : {}),
    ...(draft.startup.on ? { startup: { commands: parseStartupCommands(draft.startup.text) } } : {}),
    ...(draft.promptInjection.on ? { promptInjection: { mode: draft.promptInjection.mode } } : {}),
  };
}

function AgentEditor(props: {
  agent: AgentProfile;
  snapshot: AgentsSnapshot;
  bots: BotDefaultsRow[];
  statuses: Map<string, AgentLinkStatus>;
  cliState: CliOptionsState;
  canEdit: boolean;
  onOpenLink(appId: string, agentId: string | null): void;
  onSaved(next: AgentsSnapshot, agent: AgentSectionsConfig | null, targets: readonly BotDefaultsRow[]): Promise<void>;
  onDeleted(next: AgentsSnapshot): void;
  onSynced(): Promise<void>;
  onLinked(next: AgentsSnapshot): Promise<void>;
}) {
  const tr = useT();
  const { agent, cliState, canEdit } = props;
  const initial = useMemo(() => draftFromAgent(agent), [agent]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncingBot, setSyncingBot] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { setDraft(initial); setError(null); }, [initial]);

  const dirty = JSON.stringify(inputFromDraft(draft)) !== JSON.stringify(inputFromDraft(initial));
  const linkedIds = agentLinkedBots(props.snapshot, agent.id);
  const linkedBots = props.bots.filter(bot => linkedIds.includes(bot.larkAppId));
  const otherBots = props.bots.filter(bot => !linkedIds.includes(bot.larkAppId));
  const disabled = !canEdit || busy;
  const patch = <K extends 'exec' | 'workspace' | 'sandbox' | 'backend' | 'startup' | 'promptInjection'>(key: K, value: Partial<Draft[K]>) => {
    setDraft(current => ({ ...current, [key]: { ...current[key], ...value } }));
  };

  async function save() {
    const input = inputFromDraft(draft);
    if (!input.name) { setError(tr('agents.errorNameRequired')); return; }
    if (input.workspace && input.workspace.mode !== 'off' && !input.workspace.workingDir) {
      setError(tr('agents.errorDirRequired'));
      return;
    }
    const switching = botsSwitchingCli(input, linkedBots);
    if (switching.length > 0) {
      const ok = await confirm({
        title: tr('agents.confirmCliSwitchTitle'),
        message: tr('agents.confirmCliSwitchBody', { count: switching.length, names: switching.map(bot => botName(bot)).join(tr('agents.listSep')) }),
        confirmLabel: tr('agents.saveAndSync', { count: linkedBots.length }),
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await updateAgent(agent.id, input);
      await props.onSaved(result.snapshot, result.agent, linkedBots);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: tr('agents.confirmDeleteTitle', { name: agent.name }),
      message: tr('agents.confirmDeleteBody', { count: linkedBots.length }),
      danger: true,
      confirmLabel: tr('agents.delete'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      props.onDeleted(await deleteAgent(agent.id));
      toast(tr('agents.deleted', { name: agent.name }), { kind: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function syncOne(bot: BotDefaultsRow) {
    setSyncingBot(bot.larkAppId);
    try {
      const result = await syncAgentToBot(agent, bot);
      const summary = summarizeSync(tr, [result], props.bots);
      toast(summary.text, { kind: summary.ok ? 'success' : 'error', duration: summary.ok ? 3000 : 8000 });
      await props.onSynced();
    } finally {
      setSyncingBot(null);
    }
  }

  return (
    // Bot 配置页的表单组件（工作目录模式卡片、沙盒分段、后端下拉、bd-tile 卡片网格）
    // 的样式都挂在 `.bot-defaults-page` 作用域下；在同一作用域里渲染，直接复用那边的
    // 组件，两页外观与交互保持一致。
    <div className="bot-defaults-page bd-body ag-editor">
      <header className="bd-tile ag-editor-head">
        <CliBadge cliKey={draft.exec.on ? draft.exec.cliId : undefined} cliState={cliState} />
        <div className="ag-editor-ident">
          <input
            className="ag-name-input"
            value={draft.name}
            maxLength={64}
            disabled={disabled}
            aria-label={tr('agents.name')}
            placeholder={tr('agents.namePlaceholder')}
            onChange={event => { const name = event.currentTarget.value; setDraft(current => ({ ...current, name })); }}
          />
          <input
            className="ag-desc-input"
            value={draft.description}
            maxLength={2000}
            disabled={disabled}
            aria-label={tr('agents.description')}
            placeholder={tr('agents.descriptionPlaceholder')}
            onChange={event => { const description = event.currentTarget.value; setDraft(current => ({ ...current, description })); }}
          />
        </div>
        {canEdit ? (
          <button type="button" className="ag-danger-btn" disabled={busy} onClick={() => void remove()}>{tr('agents.delete')}</button>
        ) : null}
      </header>

      <BdTabGrid>
        <section className="bd-tile">
          <EditorSection
            title={tr('agents.section.exec')}
            help={tr('agents.section.execHelp')}
            on={draft.exec.on}
            disabled={disabled}
            onToggle={on => patch('exec', { on })}
          >
            <ExecFields draft={draft.exec} cliState={cliState} disabled={disabled} onChange={value => patch('exec', value)} />
          </EditorSection>
        </section>

        <section className="bd-tile">
          <EditorSection
            title={tr('agents.section.workspace')}
            help={tr('agents.section.workspaceHelp')}
            on={draft.workspace.on}
            disabled={disabled}
            onToggle={on => patch('workspace', { on })}
          >
            <WorkingDirModeFields
              mode={draft.workspace.mode}
              workingDir={draft.workspace.workingDir}
              autoWorktree={draft.workspace.autoWorktree}
              disabled={disabled}
              onChange={value => patch('workspace', value)}
            />
          </EditorSection>
        </section>

        <section className="bd-tile">
          <EditorSection
            title={tr('agents.section.sandbox')}
            on={draft.sandbox.on}
            disabled={disabled}
            onToggle={on => patch('sandbox', { on })}
          >
            <SandboxModeFields mode={draft.sandbox.mode} disabled={disabled} onSelect={mode => patch('sandbox', { mode })} />
          </EditorSection>
          <EditorSection
            title={tr('agents.section.backend')}
            on={draft.backend.on}
            disabled={disabled}
            onToggle={on => patch('backend', { on })}
          >
            <div className="bd-row">
              <BackendTypeField value={draft.backend.backendType} disabled={disabled} onChange={backendType => patch('backend', { backendType })} />
            </div>
          </EditorSection>
        </section>

        <section className="bd-tile">
          <EditorSection
            title={tr('agents.section.promptInjection')}
            help={tr('agents.section.promptInjectionHelp')}
            on={draft.promptInjection.on}
            disabled={disabled}
            onToggle={on => patch('promptInjection', { on })}
          >
            <ToggleRow
              checked={draft.promptInjection.mode === 'none'}
              disabled={disabled}
              dataAction="agent-prompt-injection"
              title={tr('agents.promptInjectionZero')}
              onChange={checked => patch('promptInjection', { mode: checked ? 'none' : 'default' })}
            />
            <p className="bd-section-note">{tr('agents.promptInjectionNote')}</p>
          </EditorSection>
        </section>

        <section className="bd-tile">
          <EditorSection
            title={tr('agents.section.startup')}
            help={tr('botDefaults.startupCommandsHelp')}
            on={draft.startup.on}
            disabled={disabled}
            onToggle={on => patch('startup', { on })}
          >
            <textarea
              rows={3}
              value={draft.startup.text}
              disabled={disabled}
              placeholder={tr('botDefaults.startupCommandsPlaceholder')}
              spellCheck={false}
              onChange={event => patch('startup', { text: event.currentTarget.value })}
            />
          </EditorSection>
        </section>

        <section className="bd-tile bd-tile-wide">
          <section className="bd-section">
            <div className="ag-section-head">
              <h3 className="bd-section-title">{tr('agents.linkedBots')}<span className="ag-count">{linkedBots.length}</span></h3>
              {canEdit && otherBots.length > 0 ? (
                <button
                  type="button"
                  className="ag-text-btn ag-accent"
                  disabled={busy || dirty}
                  title={dirty ? tr('agents.saveFirst') : undefined}
                  onClick={() => setAddOpen(true)}
                >
                  ＋ {tr('agents.addBot')}
                </button>
              ) : null}
            </div>
            {linkedBots.length === 0 ? <p className="bd-section-note">{tr('agents.noLinkedBots')}</p> : (
              <ul className="ag-linked-list">
                {linkedBots.map(bot => {
                  const status = props.statuses.get(bot.larkAppId) ?? agentBotDrift(agent, bot);
                  const name = botName(bot);
                  return (
                    <li key={bot.larkAppId} className={`ag-linked-item ag-bot-${status.state}`}>
                      <Html html={botAvatarHtml({ name, larkAppId: bot.larkAppId, size: 'sm', dot: bot.online === false ? 'off' : undefined })} />
                      <div className="ag-node-title">
                        <b><OverflowText text={name} showPopover={false} /></b>
                        <span className="ag-node-sub">{linkStatusText(tr, status)}</span>
                      </div>
                      <a className="ag-text-btn" href={`#/bot-defaults?bot=${encodeURIComponent(bot.larkAppId)}`}>{tr('agents.openBot')}</a>
                      {canEdit && status.state === 'drift' ? (
                        <button type="button" className="ag-text-btn ag-accent" disabled={syncingBot !== null || dirty} title={dirty ? tr('agents.saveFirst') : undefined} onClick={() => void syncOne(bot)}>
                          {syncingBot === bot.larkAppId ? tr('agents.syncing') : tr('agents.sync')}
                        </button>
                      ) : null}
                      {canEdit ? (
                        <button type="button" className="ag-text-btn" disabled={busy} onClick={() => props.onOpenLink(bot.larkAppId, null)}>{tr('agents.unlink')}</button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </section>
      </BdTabGrid>

      <AddBotsDialog
        open={addOpen}
        agent={agent}
        snapshot={props.snapshot}
        candidates={otherBots}
        allBots={props.bots}
        onClose={() => setAddOpen(false)}
        onDone={async next => {
          setAddOpen(false);
          await props.onLinked(next);
        }}
      />

      {canEdit && (dirty || error) ? (
        <div className="ag-savebar">
          <span className={error ? 'ag-error' : 'ag-muted'}>
            {error ?? (linkedBots.length ? tr('agents.dirtyWithBots', { count: linkedBots.length }) : tr('agents.dirty'))}
          </span>
          <button type="button" disabled={!dirty || busy} onClick={() => { setDraft(initial); setError(null); }}>{tr('agents.discard')}</button>
          <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? tr('agents.saving') : linkedBots.length ? tr('agents.saveAndSync', { count: linkedBots.length }) : tr('agents.save')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 一个 Agent 分组：标题行右侧是「由 Agent 统一 / 不设置」开关；不设置时只留说明。 */
function EditorSection(props: {
  title: string;
  help?: string;
  on: boolean;
  disabled: boolean;
  onToggle(on: boolean): void;
  children: React.ReactNode;
}) {
  const tr = useT();
  return (
    <section className={`bd-section ag-section${props.on ? '' : ' is-off'}`}>
      <div className="ag-section-head">
        <h3 className="bd-section-title"><FieldTitle help={props.help}>{props.title}</FieldTitle></h3>
        <label className="ag-manage-toggle">
          <input type="checkbox" checked={props.on} disabled={props.disabled} onChange={event => props.onToggle(event.currentTarget.checked)} />
          <span className="switch" aria-hidden="true" />
          <span>{props.on ? tr('agents.managed') : tr('agents.unmanaged')}</span>
        </label>
      </div>
      {props.on ? props.children : <p className="bd-section-note">{tr('agents.unmanagedNote')}</p>}
    </section>
  );
}

/** 执行分组：与 Bot 配置页「Agent 配置」同一套控件（CLI / 模型 / 思考强度 / 配置目录）。 */
function ExecFields(props: {
  draft: Draft['exec'];
  cliState: CliOptionsState;
  disabled: boolean;
  onChange(value: Partial<Draft['exec']>): void;
}) {
  const tr = useT();
  const { draft, cliState } = props;
  const [detected, setDetected] = useState<{ key: string; models: string[]; live: number } | null>(null);
  useEffect(() => {
    let stale = false;
    void fetchDetectedModels(draft.cliId).then(result => {
      if (!stale) setDetected({ key: draft.cliId, models: result?.models ?? [], live: result?.source === 'live' ? result.models.length : 0 });
    });
    return () => { stale = true; };
  }, [draft.cliId]);
  const option = selectedCliOption(cliState.options, draft.cliId);
  const candidates = mergeModelCandidates(
    modelSuggestionsForOption(option, cliState),
    detected?.key === draft.cliId ? detected.models : null,
  );
  const cliId = realCliId(draft.cliId);
  const efforts = reasoningEffortsForCliModel(cliId, draft.model || undefined);
  const cliOptions = [...cliState.options]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(item => ({
      value: item.id,
      label: item.label,
      hint: item.available === false ? item.availabilityReason ?? tr('agents.cliUnavailable') : undefined,
    }));
  if (!cliOptions.some(item => item.value === draft.cliId)) cliOptions.unshift({ value: draft.cliId, label: draft.cliId, hint: undefined });
  return (
    <>
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle>{tr('botDefaults.agentCli')}</FieldTitle>
          <DropdownField
            dataInput="agentExecCli"
            ariaLabel={tr('botDefaults.agentCli')}
            value={draft.cliId}
            searchable
            disabled={props.disabled}
            options={cliOptions}
            onChange={key => {
              const allowed = reasoningEffortsForCliModel(realCliId(key), undefined);
              props.onChange({
                cliId: key,
                model: '',
                reasoningEffort: allowed.includes(draft.reasoningEffort as never) ? draft.reasoningEffort : '',
              });
            }}
          />
        </div>
      </div>
      <div className="bd-row">
        <label>
          <FieldTitle>{tr('botDefaults.agentModel')}</FieldTitle>
          <ModelPickerField
            key={draft.cliId}
            value={draft.model}
            options={candidates}
            disabled={props.disabled || (option?.gateway === 'ttadk' && option.acceptsModel === false)}
            busy={detected?.key !== draft.cliId}
            dataInput="agentExecModel"
            ariaLabel={tr('botDefaults.agentModel')}
            defaultLabel={tr('botDefaults.modelPickerDefault')}
            customLabel={tr('botDefaults.modelPickerCustom')}
            includeDefault
            menuClassName="bd-field-menu"
            detectedCount={detected?.live || undefined}
            detectedLabel={detected?.live ? tr('botDefaults.modelPickerDetected', { count: detected.live }) : undefined}
            onChange={model => {
              const allowed = reasoningEffortsForCliModel(cliId, model || undefined);
              props.onChange({ model, reasoningEffort: allowed.includes(draft.reasoningEffort as never) ? draft.reasoningEffort : '' });
            }}
          />
        </label>
      </div>
      {cliSupportsConfigDir(cliId) ? (
        <div className="bd-row">
          <label>
            <FieldTitle help={tr('botDefaults.cliConfigDirHelp')}>{tr('botDefaults.cliConfigDir')}</FieldTitle>
            <input
              type="text"
              value={draft.configDir}
              disabled={props.disabled}
              placeholder={tr('botDefaults.cliConfigDirPlaceholder')}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              onChange={event => props.onChange({ configDir: event.currentTarget.value })}
            />
          </label>
        </div>
      ) : null}
      <div className="bd-row">
        <div className="bd-field">
          <FieldTitle help={tr('botDefaults.agentReasoningEffortHelp')}>{tr('botDefaults.agentReasoningEffort')}</FieldTitle>
          <DropdownField
            dataInput="agentExecEffort"
            ariaLabel={tr('botDefaults.agentReasoningEffort')}
            value={draft.reasoningEffort}
            disabled={props.disabled || efforts.length === 0}
            options={[
              { value: '', label: efforts.length ? tr('botDefaults.agentReasoningEffortDefault') : tr('agents.effortUnsupported') },
              ...efforts.map(value => ({ value, label: effortLabel(tr, value) })),
            ]}
            onChange={reasoningEffort => props.onChange({ reasoningEffort })}
          />
        </div>
      </div>
    </>
  );
}

// ─── 关联确认 ────────────────────────────────────────────────────────────────

function DiffTable(props: { diffs: AgentFieldDiff[]; cliState: CliOptionsState; nextLabel: string }) {
  const tr = useT();
  return (
    <table className="ag-diff">
      <thead>
        <tr><th>{tr('agents.diffField')}</th><th>{tr('agents.diffCurrent')}</th><th>{props.nextLabel}</th></tr>
      </thead>
      <tbody>
        {props.diffs.map(diff => (
          <tr key={diff.field}>
            <td>{sectionLabel(tr, diff.section)} · {fieldLabel(tr, diff.field)}</td>
            <td className="ag-diff-old">{diffValue(tr, props.cliState, diff.field, diff.bot)}</td>
            <td className="ag-diff-new">{diffValue(tr, props.cliState, diff.field, diff.agent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LinkDialog(props: {
  target: LinkTarget | null;
  snapshot: AgentsSnapshot;
  bots: BotDefaultsRow[];
  cliState: CliOptionsState;
  onClose(): void;
  onDone(next: AgentsSnapshot): Promise<void>;
}) {
  const tr = useT();
  const { target, snapshot } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChosen(target?.agentId ?? null);
    setError(null);
  }, [target]);

  const bot = target ? props.bots.find(entry => entry.larkAppId === target.appId) : undefined;
  const current = target ? snapshot.links[target.appId] ?? null : null;
  const chosenAgent = chosen ? snapshot.agents.find(agent => agent.id === chosen) ?? null : null;
  const offline = bot?.online === false || !!bot?.error;
  const diffs = chosenAgent && bot && !offline ? diffAgentSections(chosenAgent, bot) : [];
  const switchesCli = diffs.some(diff => diff.field === 'cliId');
  const currentAgent = current ? snapshot.agents.find(agent => agent.id === current) ?? null : null;

  let action: 'none' | 'unlink' | 'sync' | 'link' = 'none';
  if (chosen === null) action = current ? 'unlink' : 'none';
  else if (chosen === current) action = diffs.length ? 'sync' : 'none';
  else action = 'link';

  async function run() {
    if (!target || !bot || action === 'none') return;
    setBusy(true);
    setError(null);
    try {
      let next = snapshot;
      if (action === 'unlink' && current) next = await unlinkAgent(current, target.appId);
      if (action === 'link' && chosen) next = await linkAgent(chosen, target.appId);
      if (chosenAgent && (action === 'link' || action === 'sync') && diffs.length) {
        const result = await syncAgentToBot(chosenAgent, bot);
        const summary = summarizeSync(tr, [result], props.bots);
        toast(summary.text, { kind: summary.ok ? 'success' : 'error', duration: summary.ok ? 3000 : 8000 });
      } else if (action === 'unlink') {
        toast(tr('agents.unlinked', { name: botName(bot) }), { kind: 'success' });
      } else if (action === 'link') {
        toast(offline ? tr('agents.linkedOffline', { name: botName(bot) }) : tr('agents.linkedNoChange', { name: botName(bot) }), { kind: 'success' });
      }
      await props.onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const confirmLabel = action === 'unlink' ? tr('agents.unlink')
    : action === 'sync' ? tr('agents.syncCount', { count: diffs.length })
    : action === 'link' ? (diffs.length ? tr('agents.linkAndSync', { count: diffs.length }) : tr('agents.link'))
    : tr('agents.noChange');

  return (
    <ModalDialog
      // 目标 Bot 在刷新后消失（被删除）时不弹空框。
      open={!!target && !!bot}
      className="confirm-modal-dialog ag-link-dialog"
      aria-labelledby="ag-link-title"
      onRequestClose={() => { if (!busy) props.onClose(); }}
    >
      {target && bot ? (
        <div className="confirm-modal-card">
          <h3 id="ag-link-title" className="confirm-modal-title">{tr('agents.linkTitle', { name: botName(bot) })}</h3>
          <p className="confirm-modal-message">
            {currentAgent ? tr('agents.linkCurrent', { name: currentAgent.name }) : tr('agents.linkCurrentStandalone')}
          </p>
          <div className="ag-choice-list" role="radiogroup" aria-label={tr('agents.linkChoose')}>
            {snapshot.agents.map(agent => (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={chosen === agent.id}
                className={`ag-choice${chosen === agent.id ? ' on' : ''}`}
                disabled={busy}
                onClick={() => setChosen(agent.id)}
              >
                <CliBadge cliKey={agent.exec?.cliId} cliState={props.cliState} size="sm" />
                <span className="ag-choice-tx">
                  <b>{agent.name}{agent.id === current ? <em>{tr('agents.currentMark')}</em> : null}</b>
                  <span>{agentSubtitle(tr, props.cliState, agent, true)}</span>
                </span>
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={chosen === null}
              className={`ag-choice ag-choice-standalone${chosen === null ? ' on' : ''}`}
              disabled={busy}
              onClick={() => setChosen(null)}
            >
              <span className="ag-cli-badge ag-cli-badge-sm ag-cli-badge-blank" aria-hidden="true">—</span>
              <span className="ag-choice-tx">
                <b>{tr('agents.standaloneShort')}{current === null ? <em>{tr('agents.currentMark')}</em> : null}</b>
                <span>{tr('agents.standaloneHint')}</span>
              </span>
            </button>
          </div>
          <div className="ag-link-preview">
            {action === 'unlink' ? <p className="ag-note">{tr('agents.unlinkNote')}</p> : null}
            {chosenAgent && offline ? <p className="ag-warn">{tr('agents.linkOfflineNote')}</p> : null}
            {chosenAgent && !offline && diffs.length === 0 ? <p className="ag-note">{tr('agents.linkNoDiff')}</p> : null}
            {diffs.length ? (
              <>
                <p className="ag-note">
                  {tr(action === 'sync' ? 'agents.syncDiffIntro' : 'agents.linkDiffIntro', { count: diffs.length })}
                </p>
                <DiffTable
                  diffs={diffs}
                  cliState={props.cliState}
                  nextLabel={tr(action === 'sync' ? 'agents.diffNextSync' : 'agents.diffNext')}
                />
              </>
            ) : null}
            {switchesCli ? <p className="ag-warn">{tr('agents.cliSwitchWarn')}</p> : null}
            {error ? <p className="ag-error">{error}</p> : null}
          </div>
          <div className="confirm-modal-footer">
            <button type="button" className="btn-cancel" disabled={busy} onClick={props.onClose}>{tr('agents.cancel')}</button>
            <button
              type="button"
              className={action === 'unlink' ? 'btn-danger' : 'btn-primary'}
              disabled={busy || action === 'none'}
              onClick={() => void run()}
            >
              {busy ? tr('agents.saving') : confirmLabel}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}

// ─── 批量添加 Bot ─────────────────────────────────────────────────────────────

/**
 * 「已连接的 Bot」的批量添加：多选候选 Bot，每行预览选中后会发生什么（当前关联、
 * 将改变几项 / 配置一致 / 离线），确认后逐个写关联，再把有偏差的在线 Bot 一次性同步。
 * 比较与下发都针对已保存的 Agent 定义（编辑中的草稿需先保存）。
 */
function AddBotsDialog(props: {
  open: boolean;
  agent: AgentProfile;
  snapshot: AgentsSnapshot;
  candidates: BotDefaultsRow[];
  allBots: BotDefaultsRow[];
  onClose(): void;
  onDone(next: AgentsSnapshot): Promise<void>;
}) {
  const tr = useT();
  const { agent, snapshot } = props;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!props.open) return;
    setSelected(new Set());
    setError(null);
  }, [props.open]);

  const plans = useMemo(
    () => props.candidates.map(bot => ({ bot, status: agentBotDrift(agent, bot) })),
    [agent, props.candidates],
  );
  const options = plans.map(({ bot, status }) => {
    const currentId = snapshot.links[bot.larkAppId];
    const current = currentId
      ? tr('agents.addBotFrom', { name: snapshot.agents.find(entry => entry.id === currentId)?.name ?? '' })
      : tr('agents.standaloneShort');
    const change = status.state === 'offline'
      ? tr('agents.stateOffline')
      : status.state === 'drift' ? tr('agents.hintChanges', { count: status.diffs.length }) : tr('agents.hintSame');
    return { larkAppId: bot.larkAppId, botName: botName(bot), hint: `${current} · ${change}` };
  });
  const chosen = plans.filter(plan => selected.has(plan.bot.larkAppId));
  const toSync = chosen.filter(plan => plan.status.state === 'drift');
  const offline = chosen.filter(plan => plan.status.state === 'offline');
  const switching = chosen.filter(plan => plan.status.diffs.some(diff => diff.field === 'cliId'));

  async function run() {
    setBusy(true);
    setError(null);
    let next = snapshot;
    try {
      // 关联逐个写（agents.json 走文件锁，串行最稳）；任何一步失败都停下并如实报告。
      for (const plan of chosen) next = await linkAgent(agent.id, plan.bot.larkAppId);
      if (toSync.length) {
        const results = await syncAgentToBots(agent, toSync.map(plan => plan.bot));
        const summary = summarizeSync(tr, results, props.allBots);
        toast(`${tr('agents.addBotsDone', { count: chosen.length })}；${summary.text}`, {
          kind: summary.ok ? 'success' : 'error',
          duration: summary.ok ? 4000 : 8000,
        });
      } else {
        toast(tr('agents.addBotsDone', { count: chosen.length }), { kind: 'success' });
      }
      await props.onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 已经写成功的关联要反映到页面上，避免用户以为全部失败而重复操作。
      if (next !== snapshot) await props.onDone(next).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open={props.open}
      className="confirm-modal-dialog ag-link-dialog"
      aria-labelledby="ag-add-bots-title"
      backdropClose={!busy}
      onRequestClose={() => { if (!busy) props.onClose(); }}
    >
      {props.open ? (
        <div className="confirm-modal-card">
          <h3 id="ag-add-bots-title" className="confirm-modal-title">{tr('agents.addBotsTitle', { name: agent.name })}</h3>
          <p className="confirm-modal-message">{tr('agents.addBotsIntro')}</p>
          <div className="ag-link-preview">
            <BotMultiSelect
              bots={options}
              selected={selected}
              onToggle={(appId, checked) => setSelected(current => {
                const nextSet = new Set(current);
                if (checked) nextSet.add(appId);
                else nextSet.delete(appId);
                return nextSet;
              })}
              searchPlaceholder={tr('agents.addBotsSearch')}
              noMatchLabel={tr('agents.addBotsNoMatch')}
              emptyLabel={tr('agents.addBotsEmpty')}
              selectedCountLabel={count => tr('agents.addBotsSelected', { count })}
            />
            {chosen.length ? (
              <p className="ag-note">
                {tr('agents.addBotsPlan', {
                  count: chosen.length,
                  sync: toSync.length,
                  same: chosen.length - toSync.length - offline.length,
                  offline: offline.length,
                })}
              </p>
            ) : null}
            {switching.length ? (
              <p className="ag-warn">
                {tr('agents.addBotsCliSwitch', { names: switching.map(plan => botName(plan.bot)).join(tr('agents.listSep')) })}
              </p>
            ) : null}
            {error ? <p className="ag-error">{error}</p> : null}
          </div>
          <div className="confirm-modal-footer">
            <button type="button" className="btn-cancel" disabled={busy} onClick={props.onClose}>{tr('agents.cancel')}</button>
            <button type="button" className="btn-primary" disabled={busy || chosen.length === 0} onClick={() => void run()}>
              {busy ? tr('agents.saving') : tr('agents.addBotsSubmit', { count: chosen.length })}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}

// ─── 新建 ────────────────────────────────────────────────────────────────────

/**
 * 从 Bot 生成 Agent：执行与工作区两组总是带上；沙箱 / 后端 / 启动命令只在 Bot 有
 * 非默认值时带上，避免新 Agent 关联到其它 Bot 时顺手把它们的这几项清掉。
 */
export function agentInputFromBot(name: string, bot: BotDefaultsRow): AgentInput {
  const values = botSectionValues(bot);
  return {
    name,
    description: '',
    exec: values.exec,
    workspace: values.workspace,
    ...(values.sandbox.mode !== 'off' ? { sandbox: values.sandbox } : {}),
    ...(values.backend.backendType ? { backend: values.backend } : {}),
    ...(values.startup.commands.length ? { startup: values.startup } : {}),
    ...(values.promptInjection.mode === 'none' ? { promptInjection: values.promptInjection } : {}),
  };
}

function CreateAgentDialog(props: {
  open: boolean;
  bots: BotDefaultsRow[];
  cliState: CliOptionsState;
  onClose(): void;
  onCreated(agent: AgentProfile, next: AgentsSnapshot): void;
}) {
  const tr = useT();
  const onlineBots = props.bots.filter(bot => bot.online !== false && !bot.error);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'bot' | 'blank'>('bot');
  const [botId, setBotId] = useState('');
  const [linkSource, setLinkSource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!props.open) return;
    setName('');
    setSource(onlineBots.length ? 'bot' : 'blank');
    setBotId(onlineBots[0]?.larkAppId ?? '');
    setLinkSource(true);
    setError(null);
    // 只在打开时重置；bots 列表刷新不应清掉用户正在填的表单。
  }, [props.open]);

  const sourceBot = onlineBots.find(bot => bot.larkAppId === botId);

  async function submit() {
    const finalName = name.trim() || (source === 'bot' && sourceBot ? tr('agents.nameFromBot', { name: botName(sourceBot) }) : '');
    if (!finalName) { setError(tr('agents.errorNameRequired')); return; }
    const defaultCli = props.cliState.options.find(option => option.id === 'claude-code')?.id ?? props.cliState.options[0]?.id ?? 'claude-code';
    const input: AgentInput = source === 'bot' && sourceBot
      ? agentInputFromBot(finalName, sourceBot)
      : { name: finalName, description: '', exec: { cliId: defaultCli, model: '', reasoningEffort: '', configDir: '' } };
    setBusy(true);
    setError(null);
    try {
      const result = await createAgent(input, source === 'bot' && sourceBot && linkSource ? [sourceBot.larkAppId] : []);
      toast(tr('agents.created', { name: result.agent.name }), { kind: 'success' });
      props.onCreated(result.agent, result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open={props.open}
      className="confirm-modal-dialog ag-create-dialog"
      aria-labelledby="ag-create-title"
      backdropClose={false}
      onRequestClose={() => { if (!busy) props.onClose(); }}
    >
      {props.open ? (
        <div className="confirm-modal-card">
          <h3 id="ag-create-title" className="confirm-modal-title">{tr('agents.createTitle')}</h3>
          <label className="ag-field">
            <FieldTitle>{tr('agents.name')}</FieldTitle>
            <input
              type="text"
              value={name}
              maxLength={64}
              disabled={busy}
              placeholder={source === 'bot' && sourceBot ? tr('agents.nameFromBot', { name: botName(sourceBot) }) : tr('agents.namePlaceholder')}
              onChange={event => setName(event.currentTarget.value)}
            />
          </label>
          <div className="ag-seg" role="radiogroup" aria-label={tr('agents.createSource')}>
            <button type="button" role="radio" aria-checked={source === 'bot'} className={source === 'bot' ? 'on' : ''} disabled={busy || onlineBots.length === 0} onClick={() => setSource('bot')}>
              {tr('agents.sourceBot')}
            </button>
            <button type="button" role="radio" aria-checked={source === 'blank'} className={source === 'blank' ? 'on' : ''} disabled={busy} onClick={() => setSource('blank')}>
              {tr('agents.sourceBlank')}
            </button>
          </div>
          {source === 'bot' ? (
            <>
              <div className="ag-field">
                <FieldTitle>{tr('agents.sourceBotPick')}</FieldTitle>
                <DropdownField
                  dataInput="agentSourceBot"
                  ariaLabel={tr('agents.sourceBotPick')}
                  value={botId}
                  searchable
                  disabled={busy}
                  options={onlineBots.map(bot => ({
                    value: bot.larkAppId,
                    label: botName(bot),
                    hint: bot.agentSelectionKey ? cliLabel(props.cliState, bot.agentSelectionKey) : bot.cliId,
                  }))}
                  onChange={setBotId}
                />
              </div>
              {sourceBot ? (
                <p className="ag-note">
                  {agentExecSummary(tr, props.cliState, agentInputFromBot('', sourceBot))}
                  {' · '}
                  {AGENT_SECTIONS.filter(section => agentInputFromBot('', sourceBot)[section]).map(section => sectionLabel(tr, section)).join(tr('agents.listSep'))}
                </p>
              ) : null}
              <ToggleRow
                checked={linkSource}
                disabled={busy}
                title={tr('agents.linkSource')}
                description={tr('agents.linkSourceHint')}
                onChange={setLinkSource}
              />
            </>
          ) : <p className="ag-note">{tr('agents.sourceBlankHint')}</p>}
          {error ? <p className="ag-error">{error}</p> : null}
          <div className="confirm-modal-footer">
            <button type="button" className="btn-cancel" disabled={busy} onClick={props.onClose}>{tr('agents.cancel')}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? tr('agents.saving') : tr('agents.createSubmit')}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
