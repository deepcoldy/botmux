/**
 * 基于历史创建（design 2026-11-03 workflow-dashboard-orchestration §6，D6）：
 * 运行详情页 / 模板详情页的「复制为新工作流」，草稿页上的「复制自 …」、
 * 改目标的两个选项、复制来的流程预览与改节点文字。
 *
 * 复制只要 Dashboard 管理员；复制者成为新草稿的发起人，且要对所选编排 Bot
 * 有操作权限（I1）——都由那个 Bot 的 daemon 校验，页面只展示结果。
 */
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useT } from './react-hooks.js';
import { DagGraph } from './v3-components.js';
import { copyAsNewWorkflow, fetchOrchestratorBots, type CopySource, type DraftAction } from './workflow-draft-api.js';
import { draftGraphView, projectChoicesStale, projectForRequest, workflowDraftHref } from './workflow-draft-model.js';
import { ProjectField, describeError, useProjectOptions } from './workflow-draft-page.js';
import { BotSearchPicker } from './bot-search-picker.js';
import type { BotSearchOption } from './bot-search-model.js';
import { recentFailureHint } from './workflow-draft-model.js';
import {
  canEditCopyGoal,
  canEditCopyNodes,
  copyGoalMode,
  copyGraphRows,
  copyNodeCount,
  copyNodeText,
  copySourceLine,
  copyUnresolvedNames,
  type CopyGoalChoice,
} from './workflow-copy-model.js';
import type { WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { WorkflowOrchestratorBotOption } from '../workflow-drafts-api.js';

type Act = (action: DraftAction, label: string, opts?: { pin?: boolean }) => Promise<unknown>;

// ─── 入口：复制为新工作流 ────────────────────────────────────────────────

/** The entry button; the page renders {@link CopyWorkflowDialog} below its
 *  heading while `onOpen`'s state is set (like 「保存为模板」). */
export function CopyWorkflowButton(props: { label?: string; small?: boolean; active?: boolean; onOpen: () => void }): React.JSX.Element {
  const tr = useT();
  return (
    <button type="button" className={props.small ? 'wfd-small' : undefined} aria-expanded={!!props.active} onClick={props.onOpen}>
      {props.label ?? tr('workflow.copy.action')}
    </button>
  );
}

export function CopyWorkflowDialog(props: {
  source: CopySource;
  sourceOrchestratorAppId?: string;
  /** Template sources: what the dialog names (`v3`, the template's name). */
  versionLabel?: string;
  sourceName?: string;
  onClose: () => void;
  /** Where to go once the draft exists (default: its page). */
  onCopied?: (view: WorkflowDraftView) => void;
}): React.JSX.Element {
  const tr = useT();
  const [bots, setBots] = useState<WorkflowOrchestratorBotOption[]>([]);
  const [bot, setBot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; problems: string[] } | null>(null);
  useEffect(() => {
    void fetchOrchestratorBots().then((result) => { if (result.ok) setBots(result.bots); });
  }, []);
  const nameOf = (appId: string) => bots.find((item) => item.larkAppId === appId)?.name ?? appId;
  const sameAsSourceLabel = props.sourceOrchestratorAppId
    ? tr('workflow.copy.sameAsSource', { name: nameOf(props.sourceOrchestratorAppId) })
    : tr('workflow.copy.sameAsSourcePlain');
  const projectBot = bot || props.sourceOrchestratorAppId || '';
  const sourceRunId = props.source.kind === 'run' ? props.source.runId : '';
  const projectTarget = useMemo(
    () => (projectBot ? { larkAppId: projectBot } : sourceRunId ? { runId: sourceRunId } : null),
    [projectBot, sourceRunId],
  );
  const [projectCheck, retryProjects] = useProjectOptions(projectTarget);
  const [pickedProject, setPickedProject] = useState('');
  const project = projectForRequest(projectCheck, pickedProject);
  const chooseBot = (larkAppId: string) => {
    setBot(larkAppId);
    setPickedProject('');
  };

  const copy = async () => {
    if (project === null) return;
    setBusy(true);
    setError(null);
    const result = await copyAsNewWorkflow(props.source, bot || undefined, project);
    setBusy(false);
    if (result.ok) {
      if (props.onCopied) props.onCopied(result.draft);
      else window.location.hash = workflowDraftHref(result.draft.runId);
      return;
    }
    const problems = Array.isArray(result.body.problems) ? (result.body.problems as unknown[]).map(String) : [];
    setError({ text: describeError(tr, result), problems });
    if (projectChoicesStale(result.error)) { setPickedProject(''); retryProjects(); }
  };

  return (
    <section className="overview-block wfd-panel wfc-dialog" role="dialog" aria-modal="false" aria-labelledby="wfc-dialog-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfc-dialog-title">{tr('workflow.copy.dialogTitle')}</h2>
        <button type="button" className="wfd-small" onClick={props.onClose}>{tr('workflow.copy.cancel')}</button>
      </div>
      <p className="muted">{tr('workflow.copy.dialogHint')}</p>
      <p className="wfc-source">
        {props.source.kind === 'run'
          ? tr('workflow.copy.sourceRun', { runId: props.source.runId })
          : tr('workflow.copy.sourceTemplate', { name: props.sourceName ?? '', version: (props.versionLabel ?? '').replace(/^v/, '') })}
      </p>
      <div className="wfl-inline">
        <span className="wfd-label">{tr('workflow.copy.orchestrator')}</span>
        <BotSearchPicker
          id="wfc-bot"
          label={tr('workflow.copy.orchestrator')}
          options={bots.map((item): BotSearchOption => {
            const hint = recentFailureHint(item.recentFailure);
            const why = item.unavailable ? tr(`workflow.draft.unavailable.${item.unavailable.code}`) : undefined;
            return {
              larkAppId: item.larkAppId,
              name: item.larkAppId === props.sourceOrchestratorAppId ? tr('workflow.copy.sameAsSource', { name: item.name }) : item.name,
              cliId: item.cliId,
              ...(item.unavailable ? { disabledWhy: why && why !== `workflow.draft.unavailable.${item.unavailable.code}` ? why : item.unavailable.why } : {}),
              ...(hint ? { hint: tr('workflow.draft.recentFailure', { reason: tr(hint.key), at: hint.at }) } : {}),
            };
          })}
          // 空值 = 与来源相同（不带 larkAppId，Dashboard 读盘取来源的编排 Bot）。
          value={bot || props.sourceOrchestratorAppId || ''}
          disabled={busy}
          // 来源的编排 Bot 不在列表里（已删、未配置）时触发器照样说「与来源相同」。
          {...(!bot && props.sourceOrchestratorAppId ? { valueLabel: sameAsSourceLabel } : {})}
          placeholder={sameAsSourceLabel}
          searchPlaceholder={tr('workflow.draft.botSearch.placeholder')}
          emptyLabel={tr('workflow.draft.botSearch.empty')}
          onChange={(larkAppId) => chooseBot(larkAppId === props.sourceOrchestratorAppId ? '' : larkAppId)}
        />
        {/* 选过别的 Bot 后总能回到默认：来源的 Bot 不可选或不在列表里时，列表里点不回去。 */}
        {bot ? (
          <button type="button" className="btn-link wfd-small" disabled={busy} onClick={() => chooseBot('')}>{sameAsSourceLabel}</button>
        ) : null}
      </div>
      <ProjectField id="wfc-project" check={projectCheck} picked={pickedProject} onPick={setPickedProject} onRetry={retryProjects} />
      {error ? (
        <div className="wfd-problems" role="alert">
          <p>{error.problems.length ? tr('workflow.copy.problems') : error.text}</p>
          {error.problems.length ? <ul>{error.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul> : null}
        </div>
      ) : null}
      <div className="wfd-actions">
        <button type="button" className="primary" disabled={busy || project === null} onClick={() => { void copy(); }}>
          {busy ? tr('workflow.copy.copying') : tr('workflow.copy.confirm')}
        </button>
      </div>
    </section>
  );
}

// ─── 草稿页：复制自 …、改目标、预填的流程 ────────────────────────────────

export function CopyInfoPanel(props: {
  view: WorkflowDraftView;
  canWrite: boolean;
  busy: string | null;
  act: Act;
  botNames: Map<string, string>;
}): React.JSX.Element | null {
  const tr = useT();
  const { view } = props;
  const copy = view.copy;
  const [goal, setGoal] = useState(view.goal);
  const [choice, setChoice] = useState<CopyGoalChoice>({ kind: 'text_only' });
  useEffect(() => { setGoal(view.goal); }, [view.goal]);
  // The requirement changed since the copy: there is no copied flow left to keep.
  const stale = !!copy?.prefillStale;
  useEffect(() => { if (stale) setChoice((current) => (current.kind === 'text_only' ? { kind: 'reorchestrate', reclarify: true } : current)); }, [stale]);
  const nameOf = (appId: string) => props.botNames.get(appId) ?? appId;
  const graph = useMemo(() => copy?.prefillDag
    ? draftGraphView(copy.prefillDag, copyGraphRows(copy.prefillDag, view.orchestratorAppId, (appId) => props.botNames.get(appId) ?? appId))
    : null, [copy?.prefillDag, props.botNames, view.orchestratorAppId]);
  if (!copy) return null;
  const line = copySourceLine(copy);
  const params = Object.keys(copy.inputs ?? {});
  const unresolved = copyUnresolvedNames(copy);
  // Shown until every one is swapped (the list stays readable meanwhile).
  const pendingBots = copy.needsBot?.some((item) => !item.resolved) ? copy.needsBot! : [];
  const editable = canEditCopyGoal(view, props.canWrite) && !props.busy;
  const changed = goal.trim() && goal.trim() !== view.goal;

  return (
    <section className="overview-block wfd-panel wfc-info" aria-labelledby="wfc-info-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfc-info-title">
          {copy.source.kind === 'template'
            ? <a href={`#/workflows/library/${encodeURIComponent(copy.source.workflowId)}`}>{tr(line.key, line.params)}</a>
            : <a href={`#/workflows/${encodeURIComponent(copy.source.runId)}`}>{tr(line.key, line.params)}</a>}
        </h2>
        {copy.source.kind === 'run' && copy.source.runtimeRevisions > 0
          ? <span className="sect-head-hint">{tr('workflow.copy.runtimeRevisions', { count: copy.source.runtimeRevisions })}</span>
          : null}
      </div>
      {copy.source.kind === 'run' && copy.source.unfinished
        ? <p className="wfd-warning wfc-unfinished" role="note">⚠️ {tr('workflow.copy.unfinished')}</p>
        : null}
      {params.length ? <p className="muted">{tr('workflow.copy.paramsKept', { names: params.join('、') })}</p> : null}
      {unresolved.length ? <p className="wfd-warning" role="note">⚠️ {tr('workflow.copy.unresolved', { names: unresolved.join('、') })}</p> : null}
      {copy.goalEditedAt && copy.prefilled ? <p className="wfd-confirmed">{tr('workflow.copy.goalEdited')}</p> : null}
      {copy.prefillStale ? <p className="wfd-warning wfc-stale" role="note">⚠️ {tr('workflow.copy.prefillStale')}</p> : null}
      {pendingBots.length ? (
        <div className="wfd-warning wfc-needs-bot" role="note">
          <p>⚠️ {tr('workflow.copy.needsBotTitle')}</p>
          <ul>
            {copy.needsBot!.map((item) => (
              <li key={item.nodeId}>
                <code>{item.nodeId}</code>：{nameOf(item.larkAppId)}（{item.why}{item.placeholder ? `，${tr('workflow.copy.needsBotPlaceholder')}` : ''}）
                {item.resolved ? <span className="wfd-confirmed"> {tr('workflow.copy.needsBotResolved')}</span> : null}
              </li>
            ))}
          </ul>
          {view.flow ? <p className="muted">{tr('workflow.copy.needsBotFlowHint')}</p> : null}
        </div>
      ) : null}

      {canEditCopyGoal(view, props.canWrite) || (view.phase === 'spec_ready' && !props.canWrite) ? (
        <fieldset className="wfc-goal" disabled={!editable}>
          <legend className="wfd-label">{tr('workflow.copy.goalTitle')}</legend>
          <label htmlFor="wfc-goal-text" className="wfd-sr-only">{tr('workflow.copy.goalLabel')}</label>
          <textarea id="wfc-goal-text" rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} />
          <div className="wfc-modes" role="radiogroup" aria-label={tr('workflow.copy.goalTitle')}>
            <label className="wfc-mode">
              <input type="radio" name="wfc-mode" checked={choice.kind === 'text_only'} disabled={stale} onChange={() => setChoice({ kind: 'text_only' })} />
              <span><b>{tr('workflow.copy.modeTextOnly')}</b><small className="muted">{tr('workflow.copy.modeTextOnlyHint')}</small></span>
            </label>
            <label className="wfc-mode">
              <input type="radio" name="wfc-mode" checked={choice.kind === 'reorchestrate'} onChange={() => setChoice({ kind: 'reorchestrate', reclarify: true })} />
              <span><b>{tr('workflow.copy.modeReorchestrate')}</b><small className="muted">{tr('workflow.copy.modeReorchestrateHint')}</small></span>
            </label>
            {choice.kind === 'reorchestrate' ? (
              <div className="wfc-submodes">
                <label><input type="radio" name="wfc-sub" checked={choice.reclarify} onChange={() => setChoice({ kind: 'reorchestrate', reclarify: true })} /> {tr('workflow.copy.reclarify')}</label>
                <label><input type="radio" name="wfc-sub" checked={!choice.reclarify} onChange={() => setChoice({ kind: 'reorchestrate', reclarify: false })} /> {tr('workflow.copy.rearchitect')}</label>
              </div>
            ) : null}
          </div>
          <div className="wfd-actions">
            <button type="button" disabled={!editable || !goal.trim() || (choice.kind === 'text_only' && !changed)}
              onClick={() => { void props.act({ kind: 'copy-goal', goal: goal.trim(), mode: copyGoalMode(choice) }, 'copy-goal'); }}>
              {tr('workflow.copy.applyGoal')}
            </button>
          </div>
        </fieldset>
      ) : null}

      {copy.prefilled && copy.prefillDag && graph ? (
        <div className="wfc-prefill">
          <h3>{tr('workflow.copy.prefillTitle')}</h3>
          <p className="muted">{tr('workflow.copy.prefilledHint', { count: copyNodeCount(copy.prefillDag.nodes) })}</p>
          <div className="v3r-graph-card wfd-graph-card">
            <DagGraph view={graph} selectedId={null} onSelect={() => {}}
              statusLineOf={(node) => (node.host ? tr('workflow.draft.hostNode') : '')}
              nodeLabelOf={(node) => `${node.id}${node.bot?.name ? ` · ${node.bot.name}` : ''}`} />
          </div>
          <ul className="wfc-prefill-bots">
            {copyGraphRows(copy.prefillDag, view.orchestratorAppId, nameOf).map((row) => (
              <li key={row.nodeId}><code>{row.nodeId}</code> → <b>{row.name}</b></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ─── 流程图节点面板：改节点目标 / 完成标准 ───────────────────────────────

export function CopyNodeTextEditor(props: { view: WorkflowDraftView; nodeId: string; canWrite: boolean; busy: string | null; act: Act }): React.JSX.Element | null {
  const tr = useT();
  const current = props.view.flow ? copyNodeText(props.view.flow.dag, props.nodeId) : undefined;
  const [goal, setGoal] = useState(current?.goal ?? '');
  const [completion, setCompletion] = useState(current?.completion ?? '');
  useEffect(() => {
    setGoal(current?.goal ?? '');
    setCompletion(current?.completion ?? '');
  }, [current?.goal, current?.completion, props.nodeId]);
  if (!current || !canEditCopyNodes(props.view, props.canWrite)) return null;
  const dirty = goal.trim() !== current.goal || completion.trim() !== current.completion;
  const safeId = props.nodeId.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    <details className="wfc-node-edit">
      <summary>{tr('workflow.copy.nodeEdit')}</summary>
      <label htmlFor={`wfc-node-goal-${safeId}`} className="wfd-label">{tr('workflow.copy.nodeGoal')}</label>
      <textarea id={`wfc-node-goal-${safeId}`} rows={3} value={goal} disabled={!!props.busy} onChange={(event) => setGoal(event.target.value)} />
      <label htmlFor={`wfc-node-completion-${safeId}`} className="wfd-label">{tr('workflow.copy.nodeCompletion')}</label>
      <textarea id={`wfc-node-completion-${safeId}`} rows={3} value={completion} disabled={!!props.busy} onChange={(event) => setCompletion(event.target.value)} />
      <p className="muted">{tr('workflow.copy.nodeEditHint')}</p>
      <div className="wfd-actions">
        <button type="button" disabled={!!props.busy || !dirty || !goal.trim()}
          onClick={() => {
            void props.act({
              kind: 'node-text',
              nodeId: props.nodeId,
              ...(goal.trim() !== current.goal ? { goal: goal.trim() } : {}),
              ...(completion.trim() !== current.completion ? { completion: completion.trim() } : {}),
            }, 'node-text');
          }}>
          {tr('workflow.copy.nodeSave')}
        </button>
      </div>
    </details>
  );
}
