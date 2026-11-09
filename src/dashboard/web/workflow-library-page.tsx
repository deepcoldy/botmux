/**
 * Dashboard 工作流模板页面（design 2026-11-03 workflow-dashboard-orchestration
 * §5，D5）：模板列表（`#/workflows/library`）、详情（流程图、参数、版本历史）、
 * 「运行」（参数表单 + 群设置 + 拉群开始），以及运行详情页 / 草稿页共用的
 * 「保存为模板」确认框。
 *
 * 页面上的禁用只是展示：保存只限自己的运行 / 草稿 / 模板，运行要对模板所属
 * 编排 Bot 有操作权限，都由那个 Bot 的 daemon 再校验（§7.2）。
 */
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './react-hooks.js';
import { DagGraph } from './v3-components.js';
import { CopyWorkflowButton, CopyWorkflowDialog } from './workflow-copy.js';
import { fetchOrchestratorBots, postDraftAction } from './workflow-draft-api.js';
import {
  draftGraphView,
  formatDraftTime,
  parseLaunchMembersInput,
  projectChoicesStale,
  projectForRequest,
  workflowDraftHref,
} from './workflow-draft-model.js';
import { ProjectField, describeError, useInitiatorChecks, useProjectOptions } from './workflow-draft-page.js';
import {
  fetchTemplate,
  fetchTemplates,
  previewTemplateSave,
  runTemplate,
  saveTemplate,
  type TemplateSavePreview,
  type TemplateSaveSource,
} from './workflow-library-api.js';
import {
  buildParamEdit,
  collectTemplateRunParams,
  filterTemplates,
  gateWarningLines,
  personLabelKey,
  newTemplateRequestKey,
  paramEditTargets,
  templateParamFields,
  templateRunState,
  versionSourceKey,
  workflowTemplateHref,
  type ParamEditDraft,
} from './workflow-library-model.js';
import type { SavedWorkflowCatalogEntry, SavedWorkflowDetailView } from '../../workflows/v3/library-catalog.js';
import type { SavedWorkflowParamEdit } from '../../workflows/v3/library-params.js';
import type { V3Dag } from '../../workflows/v3/dag.js';
import type { V3Gate2BotPlanRow } from '../../workflows/v3/bot-assignment.js';

type Translate = ReturnType<typeof useT>;

/** 模板跑起来以后要用的群设置：草稿页（需要先确认流程时）接着用。 */
export const TEMPLATE_GROUP_SETUP_KEY = 'botmux.workflow.templateGroupSetup';

function useBotNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    void fetchOrchestratorBots().then((result) => {
      if (result.ok) setNames(new Map(result.bots.map((bot) => [bot.larkAppId, bot.name])));
    });
  }, []);
  return names;
}

function scopeLabel(tr: Translate, scope: SavedWorkflowCatalogEntry['scope']): string {
  return scope.kind === 'global' ? tr('workflow.library.scopeGlobal') : tr('workflow.library.scopeChat');
}


/** 工作流页标题区的「模板」入口。 */
export function WorkflowLibraryEntry(): React.JSX.Element {
  const tr = useT();
  return <a className="btn-link wfl-entry" href="#/workflows/library">{tr('workflow.library.title')}</a>;
}

// ─── 列表（§5.3）─────────────────────────────────────────────────────────

export function WorkflowLibraryPage(): React.JSX.Element {
  const tr = useT();
  const names = useBotNames();
  const [templates, setTemplates] = useState<SavedWorkflowCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bot, setBot] = useState('');
  const [keyword, setKeyword] = useState('');
  const [checks, check] = useInitiatorChecks();

  useEffect(() => {
    void fetchTemplates().then((result) => {
      if (result.ok) setTemplates(result.templates);
      else setError(describeError(tr, result));
    });
  }, [tr]);
  const bots = useMemo(() => [...new Set((templates ?? []).map((entry) => entry.orchestratorAppId))], [templates]);
  useEffect(() => { for (const appId of bots) check(appId); }, [bots, check]);
  const shown = filterTemplates(templates ?? [], { bot, keyword });
  const nameOf = (appId: string) => names.get(appId) ?? appId;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.workflows')}</p>
          <a href="#/workflows" className="btn-link v3r-back-link">← {tr('nav.workflows')}</a>
          <h1>{tr('workflow.library.title')}</h1>
        </div>
      </div>
      <section className="overview-block wfl-section" aria-labelledby="wfl-list-title">
        <div className="sect-head overview-panel-head">
          <h2 id="wfl-list-title">{tr('workflow.library.listTitle')}</h2>
          {templates ? <span className="sect-head-count">{shown.length}</span> : null}
        </div>
        <div className="wfl-filters">
          <label htmlFor="wfl-filter-bot" className="wfd-label">{tr('workflow.library.filterBot')}</label>
          <select id="wfl-filter-bot" value={bot} onChange={(event) => setBot(event.target.value)}>
            <option value="">{tr('workflow.library.allBots')}</option>
            {bots.map((appId) => <option key={appId} value={appId}>{nameOf(appId)}</option>)}
          </select>
          <label htmlFor="wfl-filter-keyword" className="wfd-label">{tr('workflow.library.filterKeyword')}</label>
          <input id="wfl-filter-keyword" type="search" value={keyword} placeholder={tr('workflow.library.keywordPlaceholder')}
            onChange={(event) => setKeyword(event.target.value)} />
        </div>
        {error ? <p className="wfd-notice wfd-error" role="alert">{error}</p> : null}
        {templates === null ? null : shown.length === 0 ? (
          <div className="empty v3r-empty">{templates.length ? tr('workflow.library.noMatch') : tr('workflow.library.empty')}</div>
        ) : (
          <div className="wfd-draft-table-wrap">
            <table className="wfd-draft-table wfl-table">
              <thead>
                <tr>
                  <th scope="col">{tr('workflow.library.colName')}</th>
                  <th scope="col">{tr('workflow.library.colBot')}</th>
                  <th scope="col">{tr('workflow.library.colLatest')}</th>
                  <th scope="col">{tr('workflow.library.colOwner')}</th>
                  <th scope="col" className="wfl-num">{tr('workflow.library.colParams')}</th>
                  <th scope="col" className="wfl-num">{tr('workflow.library.colNodes')}</th>
                  <th scope="col" className="wfl-num">{tr('workflow.library.colGates')}</th>
                  <th scope="col">{tr('workflow.library.colScope')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((entry) => {
                  const me = checks.get(entry.orchestratorAppId);
                  const meOpenId = me?.state === 'ok' ? me.initiator.openId : undefined;
                  const runState = templateRunState(entry);
                  return (
                    <tr key={entry.workflowId}>
                      <td>
                        <a href={workflowTemplateHref(entry.workflowId)}>{entry.displayName}</a>
                        {entry.savedFromDraft ? <small className="wfd-tag">{tr('workflow.library.savedFromDraftTag')}</small> : null}
                      </td>
                      <td>{nameOf(entry.orchestratorAppId)}</td>
                      <td><time dateTime={entry.latestAt}>{formatDraftTime(entry.latestAt)}</time> <small className="muted">v{entry.latestHumanVersion}</small></td>
                      <td>{tr(personLabelKey(entry.ownerOpenId, meOpenId))}</td>
                      <td className="wfl-num">{entry.paramCount}</td>
                      <td className="wfl-num">{entry.nodeCount}</td>
                      <td className="wfl-num">{entry.gateCount}</td>
                      <td>
                        <span className={`v3r-pill wfl-scope wfl-scope-${entry.scope.kind}`}>{scopeLabel(tr, entry.scope)}</span>
                        {runState === 'unpublished' ? <small className="muted"> {tr('workflow.library.unpublished')}</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ─── 详情（§5.3）─────────────────────────────────────────────────────────

function templateGraphRows(detail: SavedWorkflowDetailView, nameOf: (appId: string) => string): V3Gate2BotPlanRow[] {
  const rows: V3Gate2BotPlanRow[] = [];
  const visit = (nodes: SavedWorkflowDetailView['current']['dagTemplate']['nodes'], prefix: string, inherited?: string) => {
    for (const node of nodes) {
      const id = prefix ? `${prefix}.${node.id}` : node.id;
      const bot = node.bot ?? inherited;
      if (node.type === 'loop' && node.body) visit(node.body.nodes, id, bot);
      else if (node.type !== 'host' && bot) rows.push({ nodeId: id, larkAppId: bot, name: nameOf(bot), main: bot === detail.entry.orchestratorAppId });
    }
  };
  visit(detail.current.dagTemplate.nodes, '');
  return rows;
}

export function WorkflowTemplatePage(props: { workflowId: string }): React.JSX.Element {
  const tr = useT();
  const names = useBotNames();
  const nameOf = useCallback((appId: string) => names.get(appId) ?? appId, [names]);
  const [detail, setDetail] = useState<SavedWorkflowDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, check] = useInitiatorChecks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyRevision, setCopyRevision] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setCopyRevision(null);
    void fetchTemplate(props.workflowId).then((result) => {
      if (result.ok) setDetail(result.template);
      else setError(describeError(tr, result));
    });
  }, [props.workflowId, tr]);
  useEffect(() => { if (detail) check(detail.entry.orchestratorAppId); }, [check, detail]);

  const graph = useMemo(() => detail
    ? draftGraphView({ runId: detail.entry.workflowId, nodes: detail.current.dagTemplate.nodes } as V3Dag, templateGraphRows(detail, nameOf))
    : null, [detail, nameOf]);

  if (!detail) {
    return (
      <>
        <div className="page-heading"><div><p className="eyebrow">{tr('workflow.library.title')}</p><h1>{props.workflowId}</h1></div></div>
        {error ? <section className="overview-block wfd-panel"><p className="wfd-notice wfd-error" role="alert">{error}</p></section> : null}
      </>
    );
  }
  const { entry, current } = detail;
  const me = checks.get(entry.orchestratorAppId);
  const meOpenId = me?.state === 'ok' ? me.initiator.openId : undefined;
  const who = (openId: string) => tr(personLabelKey(openId, meOpenId));
  const selected = current.dagTemplate.nodes.find((node) => node.id === selectedId);
  const fields = templateParamFields(current.inputs);

  return (
    <>
      <div className="page-heading v3r-detail-heading">
        <div className="v3r-title-row">
          <p className="eyebrow">{tr('workflow.library.title')}</p>
          <a href="#/workflows/library" className="btn-link v3r-back-link">← {tr('workflow.library.title')}</a>
          <h1>{entry.displayName}</h1>
          <span className={`v3r-pill wfl-scope wfl-scope-${entry.scope.kind}`}>{scopeLabel(tr, entry.scope)}</span>
        </div>
        <div className="page-heading-actions">
          {/* 「复制为新工作流」(D6): the version shown; older ones from the history below. */}
          <CopyWorkflowButton active={copyRevision === current.revisionId} onOpen={() => setCopyRevision(current.revisionId)} />
        </div>
      </div>
      <div className="wfd-meta">
        <span><span className="wfd-label">{tr('workflow.draft.orchestrator')}</span>{nameOf(entry.orchestratorAppId)}</span>
        <span><span className="wfd-label">{tr('workflow.library.owner')}</span>{who(entry.ownerOpenId)}</span>
        <span><span className="wfd-label">{tr('workflow.library.currentVersion')}</span>v{current.humanVersion}{current.published ? '' : `（${tr('workflow.library.unpublished')}）`}</span>
      </div>
      {copyRevision ? (
        <CopyWorkflowDialog
          key={copyRevision}
          source={{ kind: 'template', workflowId: entry.workflowId, revisionId: copyRevision }}
          sourceOrchestratorAppId={entry.orchestratorAppId}
          versionLabel={`v${detail.versions.find((version) => version.revisionId === copyRevision)?.humanVersion ?? current.humanVersion}`}
          sourceName={entry.displayName}
          onClose={() => setCopyRevision(null)}
        />
      ) : null}
      <p className="muted wfl-owner-note">{tr('workflow.library.ownerVsInitiator')}</p>
      <section className="overview-block wfd-panel" aria-labelledby="wfl-flow-title">
        <div className="sect-head overview-panel-head">
          <h2 id="wfl-flow-title">{tr('workflow.draft.flowTitle')}</h2>
          <span className="sect-head-hint">{tr('workflow.library.flowHint', { nodes: entry.nodeCount, gates: entry.gateCount })}</span>
        </div>
        <div className="wfd-flow-grid">
          <div className="v3r-graph-card wfd-graph-card">
            {graph ? (
              <DagGraph view={graph} selectedId={selectedId} onSelect={setSelectedId} interactive
                statusLineOf={(node) => (node.host ? tr('workflow.draft.hostNode') : '')}
                nodeLabelOf={(node) => `${node.id}${node.bot?.name ? ` · ${node.bot.name}` : ''}`} />
            ) : null}
          </div>
          <div className="v3r-panel wfd-node-panel" aria-live="polite">
            {selected ? (
              <>
                <p className="wfd-node-title"><code>{selected.id}</code>{selected.humanGate ? <span className="wfd-tag wfd-tag-gate">{tr('workflow.draft.gate')}</span> : null}</p>
                {selected.goal ? <p className="v3r-goal">{selected.goal}</p> : null}
              </>
            ) : <p className="muted">{tr('workflow.library.pickNode')}</p>}
          </div>
        </div>
      </section>

      <section className="overview-block wfd-panel" aria-labelledby="wfl-params-title">
        <div className="sect-head overview-panel-head"><h2 id="wfl-params-title">{tr('workflow.library.paramsTitle')}</h2></div>
        {fields.length ? (
          <table className="wfd-draft-table wfl-table">
            <thead><tr>
              <th scope="col">{tr('workflow.library.paramName')}</th>
              <th scope="col">{tr('workflow.library.paramType')}</th>
              <th scope="col">{tr('workflow.library.paramDefault')}</th>
              <th scope="col">{tr('workflow.library.paramDescription')}</th>
            </tr></thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.name}>
                  <td><code>{field.name}</code>{field.required ? <small className="wfd-tag">{tr('workflow.library.required')}</small> : null}</td>
                  <td>{tr(`workflow.library.type.${field.type}`)}</td>
                  <td>{field.defaultText ?? '—'}</td>
                  <td>{field.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">{tr('workflow.library.noParams')}</p>}
      </section>

      <TemplateRunPanel detail={detail} />

      <section className="overview-block wfd-panel" aria-labelledby="wfl-versions-title">
        <div className="sect-head overview-panel-head"><h2 id="wfl-versions-title">{tr('workflow.library.versionsTitle')}</h2></div>
        <ol className="wfl-versions">
          {detail.versions.map((version) => {
            return (
              <li key={version.revisionId} className="wfl-version">
                <div className="wfl-version-head">
                  <b>v{version.humanVersion}</b>
                  {version.published ? <span className="v3r-pill wfl-published">{tr('workflow.library.published')}</span> : null}
                  <span className="wfd-tag">{tr(versionSourceKey(version))}</span>
                  <time dateTime={version.createdAt}>{formatDraftTime(version.createdAt)}</time>
                  <small className="muted">{tr('workflow.library.savedBy', { who: who(version.createdByOpenId) })}</small>
                  {version.revisionId !== current.revisionId ? (
                    <CopyWorkflowButton small label={tr('workflow.copy.versionAction')} active={copyRevision === version.revisionId}
                      onOpen={() => { setCopyRevision(version.revisionId); if (typeof document !== 'undefined') document.querySelector('.page-heading')?.scrollIntoView?.(); }} />
                  ) : null}
                </div>
                <GateWarnings comparisons={version.gateComparisons} role="note" />
                {version.botChanges?.length ? (
                  <p className="muted">{tr('workflow.library.botChangesLine', { nodes: version.botChanges.map((c) => c.nodeId).join('、') })}</p>
                ) : null}
                {version.confirmation ? (
                  <p className="muted">{tr('workflow.library.confirmedLine', { who: who(version.confirmation.confirmedByOpenId), at: formatDraftTime(version.confirmation.confirmedAt) })}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

/** The gate changes against each compared version, each line naming it. */
function GateWarnings(props: { comparisons: Parameters<typeof gateWarningLines>[0]; role: 'note' | 'alert' }): React.JSX.Element | null {
  const tr = useT();
  const lines = gateWarningLines(props.comparisons);
  if (!lines.length) return null;
  return (
    <>
      {lines.map((line) => {
        const text = `${tr(line.base.kind === 'published' ? 'workflow.library.gate.vsPublished' : 'workflow.library.gate.vsPrevious', { version: line.base.humanVersion })}${tr(line.message.key, line.message.params)}`;
        return line.severe
          ? <p key={line.key} className="wfd-warning wfl-fewer" role={props.role}>⚠️ {text}</p>
          : <p key={line.key} className="muted">{text}</p>;
      })}
    </>
  );
}

// ─── 运行（§5.3、I13）────────────────────────────────────────────────────

function TemplateRunPanel(props: { detail: SavedWorkflowDetailView }): React.JSX.Element {
  const tr = useT();
  const { entry, current } = props.detail;
  const fields = useMemo(() => templateParamFields(current.inputs), [current.inputs]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [groupName, setGroupName] = useState(entry.displayName);
  const [members, setMembers] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(() => new Set());
  const runnable = templateRunState(entry) === 'runnable';
  const projectTarget = useMemo(() => (runnable ? { larkAppId: entry.orchestratorAppId } : null), [runnable, entry.orchestratorAppId]);
  const [projectCheck, retryProjects] = useProjectOptions(projectTarget);
  const [pickedProject, setPickedProject] = useState('');
  const project = projectForRequest(projectCheck, pickedProject);
  // Editing a field clears its own error (and the form-level notice).
  const setValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => {
      if (!current.has(name)) return current;
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setNotice(null);
  };
  const runState = templateRunState(entry);
  if (runState !== 'runnable') {
    return (
      <section className="overview-block wfd-panel" aria-labelledby="wfl-run-title">
        <div className="sect-head overview-panel-head"><h2 id="wfl-run-title">{tr('workflow.library.runTitle')}</h2></div>
        <p className="wfd-notice" role="status">{runState === 'chat_scope' ? tr('workflow.library.chatScopeOnly') : tr('workflow.library.notRunnable')}</p>
      </section>
    );
  }
  const parsed = parseLaunchMembersInput(members);
  const membersOk = parsed.invalid.length === 0 && parsed.openIds.length === 0;
  const nameOk = groupName.trim().length > 0 && Array.from(groupName.trim()).length <= 100;
  const unsupported = fields.filter((field) => field.unsupported);

  const start = async () => {
    const collected = collectTemplateRunParams(fields, values);
    const bad = new Set([...collected.missing, ...collected.invalid]);
    setFieldErrors(bad);
    if (bad.size || !membersOk || !nameOk || project === null) {
      setNotice({ text: tr(project === null ? 'workflow.draft.project.pickFirst' : 'workflow.library.fixParams'), error: true });
      return;
    }
    setBusy(true);
    setNotice(null);
    const created = await runTemplate(entry.workflowId, { params: collected.params, expectedRevisionId: current.revisionId, project });
    if (!created.ok) {
      setBusy(false);
      const issues = (created.body.issues as Array<{ name?: string }> | undefined) ?? [];
      setFieldErrors(new Set(issues.map((issue) => issue.name ?? '').filter(Boolean)));
      setNotice({ text: describeError(tr, created), error: true });
      if (projectChoicesStale(created.error)) { setPickedProject(''); retryProjects(); }
      return;
    }
    const draft = created.draft;
    const setup = {
      ...(groupName.trim() !== draft.title ? { groupName: groupName.trim() } : {}),
      ...(parsed.members.length ? { extraMembers: parsed.members } : {}),
    };
    if (draft.phase === 'flow_confirmed') {
      // 来源是已结束的运行：不经确认，直接按 4.5 拉群（I13）。
      const launched = await postDraftAction(draft.runId, { kind: 'launch', ...setup }, draft.version);
      if (!launched.ok) setNotice({ text: describeError(tr, launched), error: true });
    } else {
      // 需要先「确认流程」：群设置留给草稿页接着用。
      try { sessionStorage.setItem(`${TEMPLATE_GROUP_SETUP_KEY}:${draft.runId}`, JSON.stringify({ groupName: groupName.trim(), members })); } catch { /* private mode */ }
    }
    setBusy(false);
    window.location.hash = workflowDraftHref(draft.runId);
  };

  return (
    <section className="overview-block wfd-panel wfl-run" aria-labelledby="wfl-run-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfl-run-title">{tr('workflow.library.runTitle')}</h2>
        <span className="sect-head-hint">{tr('workflow.library.runHint', { version: current.humanVersion })}</span>
      </div>
      <p className="muted">{entry.savedFromDraft ? tr('workflow.library.runFromDraftVersion') : tr('workflow.library.runNoConfirm')}</p>
      <ProjectField id="wfl-project" check={projectCheck} picked={pickedProject} onPick={setPickedProject} onRetry={retryProjects} />
      <div className="wfd-form wfl-param-form">
        {fields.map((field) => {
          const id = `wfl-param-${field.name}`;
          const invalid = fieldErrors.has(field.name);
          return (
            <div key={field.name} className="wfl-param-row">
              <label htmlFor={id} className="wfd-label">
                {field.name}{field.required ? <span aria-hidden="true"> *</span> : null}
                <small className="muted"> {tr(`workflow.library.type.${field.type}`)}</small>
              </label>
              {field.type === 'boolean' ? (
                <select id={id} value={values[field.name] ?? ''} aria-invalid={invalid} disabled={busy}
                  onChange={(event) => setValue(field.name, event.target.value)}>
                  <option value="">{field.defaultText !== undefined ? tr('workflow.library.useDefault', { value: field.defaultText }) : '—'}</option>
                  <option value="true">{tr('workflow.library.yes')}</option>
                  <option value="false">{tr('workflow.library.no')}</option>
                </select>
              ) : (
                <input id={id} type={field.type === 'number' ? 'text' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined}
                  value={values[field.name] ?? ''} disabled={busy || field.unsupported} aria-invalid={invalid} required={field.required}
                  aria-describedby={field.description ? `${id}-help` : undefined}
                  placeholder={field.defaultText !== undefined ? tr('workflow.library.useDefault', { value: field.defaultText }) : ''}
                  onChange={(event) => setValue(field.name, event.target.value)} />
              )}
              {field.description ? <p id={`${id}-help`} className="wfd-help">{field.description}</p> : null}
              {invalid ? <p className="wfd-error" role="alert">{field.type === 'number' ? tr('workflow.library.needNumber') : tr('workflow.library.needValue')}</p> : null}
            </div>
          );
        })}
        {unsupported.length ? <p className="wfd-warning">{tr('workflow.library.unsupportedParams', { names: unsupported.map((f) => f.name).join('、') })}</p> : null}
        <label htmlFor="wfl-group-name" className="wfd-label">{tr('workflow.draft.launch.groupName')}</label>
        <input id="wfl-group-name" type="text" value={groupName} maxLength={100} disabled={busy} aria-invalid={!nameOk}
          aria-describedby="wfl-group-name-help" onChange={(event) => setGroupName(event.target.value)} />
        <p id="wfl-group-name-help" className="wfd-help">{tr('workflow.draft.launch.groupNameHelp')}</p>
        <label htmlFor="wfl-group-members" className="wfd-label">{tr('workflow.draft.launch.extraMembers')}</label>
        <textarea id="wfl-group-members" rows={2} value={members} disabled={busy} aria-invalid={!membersOk}
          placeholder={tr('workflow.draft.launch.extraMembersPlaceholder')} onChange={(event) => setMembers(event.target.value)} />
        {parsed.openIds.length ? <p className="wfd-error" role="alert">{tr('workflow.draft.launch.openIdRefused', { ids: parsed.openIds.join('、') })}</p> : null}
        {parsed.invalid.length ? <p className="wfd-error" role="alert">{tr('workflow.draft.launch.memberInvalid', { items: parsed.invalid.join('、') })}</p> : null}
      </div>
      <p className="muted">{tr('workflow.library.runInitiatorNote')}</p>
      {notice ? <p className={`wfd-notice${notice.error ? ' wfd-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p> : null}
      <div className="wfd-actions">
        <button type="button" className="primary" disabled={busy || project === null} onClick={() => { void start(); }}>
          {tr('workflow.draft.startGroup')}
        </button>
      </div>
    </section>
  );
}

// ─── 「保存为模板」确认框（§5.1–5.2）───────────────────────────────────

const EMPTY_PARAM: ParamEditDraft = { name: '', type: 'string', defaultText: '', description: '' };

export function SaveTemplateDialog(props: {
  source: TemplateSaveSource;
  botNames: Map<string, string>;
  onClose: () => void;
  /** Fixed for the snapshot test seam; default random. */
  requestKey?: string;
}): React.JSX.Element {
  const tr = useT();
  const [preview, setPreview] = useState<TemplateSavePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>('');
  const [name, setName] = useState('');
  const [edits, setEdits] = useState<SavedWorkflowParamEdit[]>([]);
  const [allowDraft, setAllowDraft] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ workflowId: string; humanVersion: number } | null>(null);
  const [requestKey] = useState(() => props.requestKey ?? newTemplateRequestKey());
  const [fieldKey, setFieldKey] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [param, setParam] = useState<ParamEditDraft>(EMPTY_PARAM);
  const [paramError, setParamError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(async (next: { workflowId?: string; edits: SavedWorkflowParamEdit[]; allowDraft: boolean }) => {
    setBusy(true);
    const result = await previewTemplateSave(props.source, {
      ...(next.workflowId ? { workflowId: next.workflowId } : {}),
      paramEdits: next.edits,
      allowDraft: next.allowDraft,
    });
    setBusy(false);
    if (result.ok) {
      setPreview(result.preview);
      setError(null);
      setName((current) => current || result.preview.displayName);
      return true;
    }
    if (result.body.needsDraft === true && !next.allowDraft) {
      setAllowDraft(true);
      return load({ ...next, allowDraft: true });
    }
    setError(describeError(tr, result));
    return false;
  }, [props.source, tr]);
  useEffect(() => { void load({ edits: [], allowDraft: false }); }, [load]);

  const nameOf = (appId: string) => props.botNames.get(appId) ?? appId;
  const targets = useMemo(() => preview ? paramEditTargets(preview.dagNodes) : [], [preview]);
  const field = targets.find((candidate) => candidate.key === fieldKey);

  const addParam = async () => {
    if (!field) return;
    // The textarea's own selection at click time (onSelect does not fire for
    // every way a selection is made).
    const area = textRef.current;
    const chosen = area && area.selectionEnd > area.selectionStart ? { start: area.selectionStart, end: area.selectionEnd } : selection;
    const built = buildParamEdit(field, chosen, param);
    if (!built.ok) { setParamError(tr(built.reason)); return; }
    const next = [...edits, built.edit];
    if (await load({ ...(target ? { workflowId: target } : {}), edits: next, allowDraft })) {
      setEdits(next);
      setParam(EMPTY_PARAM);
      setParamError(null);
      setSelection({ start: 0, end: 0 });
    }
  };
  const chooseTarget = (workflowId: string) => {
    setTarget(workflowId);
    void load({ ...(workflowId ? { workflowId } : {}), edits, allowDraft });
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await saveTemplate(props.source, {
      ...(target ? { workflowId: target, expectedLatestRevision: preview.target?.latestRevision } : { displayName: name.trim() || preview.displayName }),
      requestKey,
      paramEdits: edits,
      flowSummarySha256: preview.flowSummarySha256,
      allowDraft,
      acknowledgeUnsafeLiterals: ack,
    });
    setBusy(false);
    if (result.ok) setSaved({ workflowId: result.saved.workflowId, humanVersion: result.saved.humanVersion });
    else setError(describeError(tr, result));
  };

  const needsAck = (preview?.lintWarnings.length ?? 0) > 0;
  return (
    <section className="overview-block wfd-panel wfl-save" role="dialog" aria-modal="false" aria-labelledby="wfl-save-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfl-save-title">{tr('workflow.library.saveTitle')}</h2>
        <button type="button" className="wfd-small" onClick={props.onClose}>{tr('workflow.library.close')}</button>
      </div>
      {error ? <p className="wfd-notice wfd-error" role="alert">{error}</p> : null}
      {saved ? (
        <p className="wfd-confirmed" role="status">
          {tr('workflow.library.savedAs', { version: saved.humanVersion })} <a href={workflowTemplateHref(saved.workflowId)}>{tr('workflow.library.openTemplate')}</a>
        </p>
      ) : null}
      {preview && !saved ? (
        <>
          <fieldset className="wfl-target">
            <legend className="wfd-label">{tr('workflow.library.saveTarget')}</legend>
            <label><input type="radio" name="wfl-target" checked={!target} disabled={busy} onChange={() => chooseTarget('')} /> {tr('workflow.library.newTemplate')}</label>
            {!target ? (
              <div className="wfl-inline">
                <label htmlFor="wfl-save-name" className="wfd-label">{tr('workflow.library.templateName')}</label>
                <input id="wfl-save-name" type="text" value={name} maxLength={128} disabled={busy} onChange={(event) => setName(event.target.value)} />
                <p className="wfd-help">{tr('workflow.library.globalNote')}</p>
              </div>
            ) : null}
            {preview.appendCandidates.length ? (
              <label>
                <input type="radio" name="wfl-target" checked={!!target} disabled={busy} onChange={() => chooseTarget(preview.appendCandidates[0]!.workflowId)} /> {tr('workflow.library.appendTo')}
                {target ? (
                  <select aria-label={tr('workflow.library.appendTo')} value={target} disabled={busy} onChange={(event) => chooseTarget(event.target.value)}>
                    {preview.appendCandidates.map((candidate) => <option key={candidate.workflowId} value={candidate.workflowId}>{candidate.displayName}</option>)}
                  </select>
                ) : null}
              </label>
            ) : null}
          </fieldset>
          <GateWarnings comparisons={preview.target?.gateComparisons} role="alert" />

          <h3>{tr('workflow.draft.summaryTitle')}</h3>
          <ul className="wfd-summary-list">
            {preview.flowSummary.nodes.map((row) => (
              <li key={row.nodeId}><code>{row.nodeId}</code> → <b>{nameOf(row.larkAppId)}</b>{row.cli ? `（${row.cli}）` : ''}</li>
            ))}
          </ul>
          <p className="muted">{tr('workflow.library.summaryCounts', { gates: preview.gateCount, effects: preview.flowSummary.sideEffects.length, nodes: preview.nodeCount })}</p>
          {preview.botChanges?.length ? (
            <div className="wfd-problems" role="note">
              <p>{tr('workflow.library.botChangesTitle')}</p>
              <ul>{preview.botChanges.map((c) => (
                <li key={c.nodeId}><code>{c.nodeId}</code>：{c.approvedLarkAppId ? nameOf(c.approvedLarkAppId) : '—'} → {c.savedLarkAppId ? nameOf(c.savedLarkAppId) : '—'}（{tr(`workflow.library.botChange.${c.cause}`)}）</li>
              ))}</ul>
            </div>
          ) : null}
          {preview.runtimeRevisions ? <p className="muted">{tr('workflow.library.runtimeRevisions', { count: preview.runtimeRevisions })}</p> : null}
          {allowDraft ? <p className="wfd-warning">{tr('workflow.library.draftOnly')}</p> : null}

          <h3>{tr('workflow.library.paramsTitle')}</h3>
          {Object.keys(preview.inputs).length ? (
            <ul className="wfd-summary-list">
              {Object.entries(preview.inputs).map(([key, def]) => <li key={key}><code>{'${params.'}{key}{'}'}</code>：{tr(`workflow.library.type.${def.type}`)}{def.default !== undefined ? ` · ${tr('workflow.library.paramDefault')} ${String(def.default)}` : ` · ${tr('workflow.library.required')}`}{def.description ? ` · ${def.description}` : ''}</li>)}
            </ul>
          ) : <p className="muted">{tr('workflow.library.noParams')}</p>}
          <div className="wfl-param-editor">
            <label htmlFor="wfl-param-field" className="wfd-label">{tr('workflow.library.param.field')}</label>
            <select id="wfl-param-field" value={fieldKey} disabled={busy} onChange={(event) => { setFieldKey(event.target.value); setSelection({ start: 0, end: 0 }); }}>
              <option value="">—</option>
              {targets.map((candidate) => <option key={candidate.key} value={candidate.key}>{tr(`workflow.library.param.kind.${candidate.field}`, { node: candidate.label })}</option>)}
            </select>
            {field ? (
              <>
                <label htmlFor="wfl-param-text" className="wfd-label">{tr('workflow.library.param.select')}</label>
                <textarea id="wfl-param-text" ref={textRef} readOnly rows={3} value={field.text}
                  onMouseUp={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
                  onKeyUp={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
                  onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} />
                <p className="wfd-help">{selection.end > selection.start ? tr('workflow.library.param.selected', { text: field.text.slice(selection.start, selection.end) }) : tr('workflow.library.param.selectFirst')}</p>
                <div className="wfl-param-grid">
                  <label htmlFor="wfl-param-name" className="wfd-label">{tr('workflow.library.paramName')}</label>
                  <input id="wfl-param-name" type="text" value={param.name} onChange={(event) => setParam({ ...param, name: event.target.value })} />
                  <label htmlFor="wfl-param-type" className="wfd-label">{tr('workflow.library.paramType')}</label>
                  <select id="wfl-param-type" value={param.type} onChange={(event) => setParam({ ...param, type: event.target.value as ParamEditDraft['type'], defaultText: '' })}>
                    <option value="string">{tr('workflow.library.type.string')}</option>
                    <option value="number">{tr('workflow.library.type.number')}</option>
                    <option value="boolean">{tr('workflow.library.type.boolean')}</option>
                  </select>
                  <label htmlFor="wfl-param-default" className="wfd-label">{tr('workflow.library.paramDefault')}</label>
                  {param.type === 'boolean' ? (
                    <select id="wfl-param-default" value={param.defaultText} onChange={(event) => setParam({ ...param, defaultText: event.target.value })}>
                      <option value="">{tr('workflow.library.noDefault')}</option>
                      <option value="true">{tr('workflow.library.yes')}</option>
                      <option value="false">{tr('workflow.library.no')}</option>
                    </select>
                  ) : (
                    <input id="wfl-param-default" type="text" value={param.defaultText} placeholder={tr('workflow.library.noDefault')} onChange={(event) => setParam({ ...param, defaultText: event.target.value })} />
                  )}
                  <label htmlFor="wfl-param-description" className="wfd-label">{tr('workflow.library.paramDescription')}</label>
                  <input id="wfl-param-description" type="text" value={param.description} maxLength={500} onChange={(event) => setParam({ ...param, description: event.target.value })} />
                </div>
                {paramError ? <p className="wfd-error" role="alert">{paramError}</p> : null}
                <button type="button" disabled={busy} onClick={() => { void addParam(); }}>{tr('workflow.library.param.apply')}</button>
              </>
            ) : <p className="wfd-help">{tr('workflow.library.param.where')}</p>}
            {edits.length ? <button type="button" className="wfd-small" disabled={busy} onClick={() => { setEdits([]); void load({ ...(target ? { workflowId: target } : {}), edits: [], allowDraft }); }}>{tr('workflow.library.param.clear')}</button> : null}
          </div>

          {needsAck ? (
            <div className="wfd-problems" role="alert">
              <p>{tr('workflow.library.lintTitle')}</p>
              <ul>{preview.lintWarnings.map((line) => <li key={line}>{line}</li>)}</ul>
              <label><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> {tr('workflow.library.lintAck')}</label>
            </div>
          ) : null}
          <div className="wfd-actions">
            <button type="button" className="primary" disabled={busy || (needsAck && !ack) || (!target && !name.trim())} onClick={() => { void save(); }}>
              {target ? tr('workflow.library.saveAppend') : tr('workflow.library.saveNew')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The draft page's 「从模板运行」 panel: where it comes from, what was filled in. */
export function TemplateRunInfo(props: {
  template: NonNullable<import('../../workflows/v3/draft-service.js').WorkflowDraftView['template']>;
  isOwner: boolean;
}): React.JSX.Element {
  const tr = useT();
  const { template } = props;
  const params = Object.entries(template.params);
  return (
    <section className="overview-block wfd-panel wfl-template-run" aria-labelledby="wfl-template-run-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfl-template-run-title">{tr('workflow.library.fromTemplate')}</h2>
        <a className="sect-head-hint" href={workflowTemplateHref(template.workflowId)}>{template.displayName} · v{template.humanVersion}</a>
      </div>
      <div className="wfd-meta">
        <span><span className="wfd-label">{tr('workflow.library.owner')}</span>{props.isOwner ? tr('workflow.library.you') : tr('workflow.library.otherAdmin')}</span>
      </div>
      {params.length ? (
        <ul className="wfd-summary-list">{params.map(([key, value]) => <li key={key}><code>{key}</code> = {value}</li>)}</ul>
      ) : <p className="muted">{tr('workflow.library.noParamsFilled')}</p>}
      {template.newerPublished ? (
        <p className="wfd-warning" role="note">{tr('workflow.library.newerPublished', { newer: template.newerPublished.humanVersion, version: template.humanVersion })}</p>
      ) : null}
      {template.swapped ? <p className="wfd-warning" role="note">{tr('workflow.library.swappedNote')}</p>
        : <p className="muted">{tr('workflow.library.runNoConfirm')}</p>}
    </section>
  );
}

