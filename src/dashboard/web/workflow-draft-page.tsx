/**
 * Dashboard 工作流编排页面（design 2026-11-03 workflow-dashboard-orchestration
 * §4.1–4.4、§4.6，D3）：新建（选编排 Bot、填目标）、草稿页（澄清对话、spec 与
 * 第一道确认、流程图选 Bot 与第二道确认）、工作流页上的草稿分组。
 *
 * 页面上的禁用只是展示：每个写操作都由编排 Bot 的 daemon 再校验发起人（§7.2）。
 * 刷新按运行详情页的方式轮询（E14），不新增 /events 类型。
 */
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SectionHeader } from './dashboard-components.js';
import { confirm } from './confirm-modal.js';
import { useT } from './react-hooks.js';
import { DagGraph } from './v3-components.js';
import { V3_POLL_MS, formatV3Duration } from './v3-model.js';
import {
  createDraft,
  fetchDraft,
  fetchDrafts,
  fetchInitiator,
  fetchOrchestratorBots,
  fetchWorkflowSwitches,
  postDraftAction,
  type DraftAction,
  type DraftApiResult,
} from './workflow-draft-api.js';
import {
  DRAFT_PHASE_KEY,
  activeQuestion,
  assignableRows,
  autoFinalizeCandidate,
  canChat,
  copyHasConversation,
  canStartDraft,
  draftErrorKey,
  draftGraphView,
  draftRowActions,
  draftSections,
  executorBotChoices,
  flowConfirmState,
  flowSummarySections,
  formatDraftTime,
  initiatorSourceKey,
  currentLaunchProblems,
  launchControls,
  launchErrorKey,
  launchStepRows,
  needsContinue,
  parseLaunchMembersInput,
  startedRunHref,
  orchestratorOptionStates,
  sameDraftInitiator,
  specEditorText,
  specPreview,
  turnDisplayText,
  workflowDraftHref,
  workflowEntryMode,
  type InitiatorCheck,
  type SpecPreview,
  type WorkflowEntryMode,
  type WorkflowSwitches,
} from './workflow-draft-model.js';
import type { WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { WorkflowDraftSummary } from '../../workflows/v3/draft-store.js';
import type { WorkflowOrchestratorBotOption } from '../workflow-drafts-api.js';
import { SaveTemplateDialog, TEMPLATE_GROUP_SETUP_KEY, TemplateRunInfo } from './workflow-library-page.js';
import { CopyInfoPanel, CopyNodeTextEditor } from './workflow-copy.js';

type Translate = ReturnType<typeof useT>;

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

/** 错误码 → 本地化文案；不认识的码带上服务端的 message。 */
export function describeError(tr: Translate, result: { error: string; message?: string }): string {
  const key = draftErrorKey(result.error);
  if (key) {
    const text = tr(key);
    return result.message && !['not_initiator', 'cannot_operate'].includes(result.error) ? `${text}（${result.message}）` : text;
  }
  return result.message ?? result.error;
}

// ─── 开关 ────────────────────────────────────────────────────────────────

/** 工作流开关；没拿到之前按关处理（不出新入口，现有页面不变）。 */
export function useWorkflowSwitches(): WorkflowSwitches | null {
  const [switches, setSwitches] = useState<WorkflowSwitches | null>(null);
  useEffect(() => {
    let disposed = false;
    void fetchWorkflowSwitches().then((next) => { if (!disposed) setSwitches(next); });
    return () => { disposed = true; };
  }, []);
  return switches;
}

/** 当前登录在各编排 Bot 视角下的发起人（按需查，查过的缓存）。 */
export function useInitiatorChecks(): [Map<string, InitiatorCheck>, (larkAppId: string, force?: boolean) => void] {
  const [checks, setChecks] = useState<Map<string, InitiatorCheck>>(() => new Map());
  const inflight = useRef(new Set<string>());
  const known = useRef(new Map<string, InitiatorCheck>());
  const check = useCallback((larkAppId: string, force = false) => {
    if (!larkAppId || inflight.current.has(larkAppId)) return;
    const prior = known.current.get(larkAppId);
    if (!force && prior && (prior.state === 'ok' || (prior.state === 'failed' && !prior.retryable))) return;
    inflight.current.add(larkAppId);
    const set = (value: InitiatorCheck) => {
      known.current.set(larkAppId, value);
      setChecks(new Map(known.current));
    };
    set({ state: 'checking' });
    void fetchInitiator(larkAppId).then((result) => {
      inflight.current.delete(larkAppId);
      set(result.ok
        ? { state: 'ok', initiator: result.initiator }
        : { state: 'failed', error: result.error, retryable: result.retryable });
    });
  }, []);
  return [checks, check];
}

// ─── 工作流页标题区入口 + 草稿分组 ──────────────────────────────────────

/** 「新建工作流」按钮（§4.1）。只开总开关时点了只给提示，不进入编排。 */
export function NewWorkflowEntry(props: { mode: WorkflowEntryMode }): React.JSX.Element | null {
  const tr = useT();
  const [hint, setHint] = useState(false);
  if (props.mode === 'hidden') return null;
  if (props.mode === 'ready') {
    return <a className="btn-link wfd-new-button" href="#/workflows/new">{tr('workflow.draft.new')}</a>;
  }
  return (
    <span className="wfd-new-entry">
      <button type="button" className="wfd-new-button" aria-describedby={hint ? 'wfd-new-hint' : undefined} onClick={() => setHint(true)}>
        {tr('workflow.draft.new')}
      </button>
      {hint ? <span id="wfd-new-hint" className="wfd-new-hint" role="status">{tr('workflow.draft.needsBotExecutor')}</span> : null}
    </span>
  );
}

/** 工作流页的「草稿」分组（§4.6）。 */
export function WorkflowDraftsSection(): React.JSX.Element {
  const tr = useT();
  const [drafts, setDrafts] = useState<WorkflowDraftSummary[] | null>(null);
  const [bots, setBots] = useState<WorkflowOrchestratorBotOption[]>([]);
  const [checks, check] = useInitiatorChecks();
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    async function poll(): Promise<void> {
      if (disposed) return;
      if (!isDocumentHidden()) {
        const result = await fetchDrafts();
        if (disposed) return;
        if (result.ok) setDrafts(result.drafts);
      }
      if (!disposed) timer = window.setTimeout(() => { void poll(); }, V3_POLL_MS);
    }
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [tick]);

  useEffect(() => {
    void fetchOrchestratorBots().then((result) => { if (result.ok) setBots(result.bots); });
  }, []);

  // 每个出现过的编排 Bot 查一次「我是谁」，用来判断哪些草稿是自己的。
  const orchestrators = useMemo(() => [...new Set((drafts ?? []).map((draft) => draft.orchestratorAppId))], [drafts]);
  useEffect(() => { for (const appId of orchestrators) check(appId); }, [check, orchestrators]);

  const nameOf = (appId: string) => bots.find((bot) => bot.larkAppId === appId)?.name ?? appId;

  const remove = async (draft: WorkflowDraftSummary) => {
    if (!await confirm({ title: tr('workflow.draft.delete'), message: tr('workflow.draft.deleteConfirm', { title: draft.title }), danger: true })) return;
    const result = await postDraftAction(draft.runId, { kind: 'delete' });
    setNotice(result.ok ? tr('workflow.draft.deleted') : describeError(tr, result));
    setTick((value) => value + 1);
  };

  return (
    <section className="overview-block wfd-drafts-section" aria-labelledby="wfd-drafts-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-drafts-title">{tr('workflow.draft.drafts')}</h2>
        {drafts?.length ? <span className="sect-head-count">{drafts.length}</span> : null}
      </div>
      {notice ? <p className="wfd-notice" role="status">{notice}</p> : null}
      {drafts === null ? null : drafts.length === 0 ? (
        <div className="empty v3r-empty">{tr('workflow.draft.noDrafts')}</div>
      ) : (
        <div className="wfd-draft-table-wrap">
          <table className="wfd-draft-table">
            <thead>
              <tr>
                <th scope="col">{tr('workflow.draft.colTitle')}</th>
                <th scope="col">{tr('workflow.draft.colBot')}</th>
                <th scope="col">{tr('workflow.draft.colInitiator')}</th>
                <th scope="col">{tr('workflow.draft.colStatus')}</th>
                <th scope="col">{tr('workflow.draft.colUpdated')}</th>
                <th scope="col"><span className="wfd-sr-only">{tr('workflow.draft.colActions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => {
                const me = checks.get(draft.orchestratorAppId);
                const mine = me?.state === 'ok' && sameDraftInitiator(me.initiator, draft.initiator);
                const actions = draftRowActions(draft, mine);
                return (
                  <tr key={draft.runId} className={actions.dimmed ? 'wfd-stale' : undefined}>
                    <td>
                      <a href={workflowDraftHref(draft.runId)}>{draft.title}</a>
                      {actions.dimmed ? <small className="wfd-stale-tag">{tr('workflow.draft.stale')}</small> : null}
                    </td>
                    <td>{nameOf(draft.orchestratorAppId)}</td>
                    <td>
                      {tr(initiatorSourceKey(draft.initiator))}
                      {mine ? <small className="wfd-me">{tr('workflow.draft.you')}</small> : null}
                    </td>
                    <td><span className={`v3r-pill wfd-phase wfd-phase-${draft.phase}`}>{tr(DRAFT_PHASE_KEY[draft.phase])}</span></td>
                    <td><time dateTime={draft.updatedAt}>{formatDraftTime(draft.updatedAt)}</time></td>
                    <td>
                      {actions.canDelete ? (
                        <button type="button" className="danger wfd-small" onClick={() => { void remove(draft); }}
                          aria-label={tr('workflow.draft.deleteNamed', { title: draft.title })}>
                          {tr('workflow.draft.delete')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── 新建（§4.1）────────────────────────────────────────────────────────

function InitiatorLine(props: { check: InitiatorCheck | undefined }): React.JSX.Element | null {
  const tr = useT();
  const check = props.check;
  if (!check) return null;
  if (check.state === 'checking') return <p className="wfd-initiator muted" role="status">{tr('workflow.draft.checkingInitiator')}</p>;
  if (check.state === 'failed') {
    return <p className="wfd-initiator wfd-error" role="alert">{describeError(tr, check)}</p>;
  }
  return (
    <p className="wfd-initiator" role="status">
      <span className="wfd-label">{tr('workflow.draft.initiator')}</span>
      {tr(initiatorSourceKey(check.initiator))}
    </p>
  );
}

export function WorkflowNewPage(): React.JSX.Element {
  const tr = useT();
  const switches = useWorkflowSwitches();
  const mode = workflowEntryMode(switches);
  const [bots, setBots] = useState<WorkflowOrchestratorBotOption[] | null>(null);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, check] = useInitiatorChecks();

  useEffect(() => {
    if (mode !== 'ready') return;
    void fetchOrchestratorBots().then((result) => {
      if (result.ok) setBots(result.bots);
      else setBotsError(describeError(tr, result));
    });
  }, [mode, tr]);

  const options = useMemo(() => orchestratorOptionStates(bots ?? [], checks), [bots, checks]);
  const bot = bots?.find((candidate) => candidate.larkAppId === selected);
  const currentCheck = selected ? checks.get(selected) : undefined;

  const choose = (larkAppId: string) => {
    setSelected(larkAppId);
    setError(null);
    if (larkAppId) check(larkAppId);
  };

  const start = async () => {
    if (!bot || !canStartDraft({ goal, bot, check: currentCheck, busy })) return;
    setBusy(true);
    setError(null);
    const result = await createDraft({ larkAppId: bot.larkAppId, goal: goal.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(describeError(tr, result));
      return;
    }
    window.location.hash = workflowDraftHref(result.draft.runId);
  };

  return (
    <>
      <div className="page-heading">
        <div className="v3r-title-row">
          <p className="eyebrow">{tr('nav.workflows')}</p>
          <a href="#/workflows" className="btn-link v3r-back-link">← {tr('nav.workflows')}</a>
          <h1>{tr('workflow.draft.new')}</h1>
        </div>
      </div>
      {switches === null ? null : mode !== 'ready' ? (
        <section className="overview-block wfd-panel">
          <p className="wfd-notice" role="status">{mode === 'hidden' ? tr('workflow.draft.featureOff') : tr('workflow.draft.needsBotExecutor')}</p>
        </section>
      ) : (
        <section className="overview-block wfd-panel wfd-new-form">
          <SectionHeader title={tr('workflow.draft.startTitle')} hint={tr('workflow.draft.startHint')} />
          <label className="wfd-field" htmlFor="wfd-bot">
            <span className="wfd-label">{tr('workflow.draft.orchestrator')}</span>
            <select id="wfd-bot" value={selected} onChange={(event) => choose(event.target.value)} disabled={!bots} aria-describedby="wfd-bot-help">
              <option value="">{bots ? tr('workflow.draft.pickBot') : tr('workflow.draft.loading')}</option>
              {options.map((option) => (
                <option key={option.larkAppId} value={option.larkAppId} disabled={!!option.disabledReason}>
                  {option.disabledReason
                    ? `${option.label} — ${localized(tr, option.disabledReason.key, option.disabledReason.fallback)}`
                    : option.label}
                </option>
              ))}
            </select>
          </label>
          <p id="wfd-bot-help" className="wfd-help">{tr('workflow.draft.orchestratorHelp')}</p>
          {options.some((option) => option.disabledReason) ? (
            <details className="wfd-unavailable">
              <summary>{tr('workflow.draft.unavailableList', { count: options.filter((option) => option.disabledReason).length })}</summary>
              <ul>
                {options.filter((option) => option.disabledReason).map((option) => (
                  <li key={option.larkAppId}>{option.label}：{localized(tr, option.disabledReason!.key, option.disabledReason!.fallback)}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {botsError ? <p className="wfd-error" role="alert">{botsError}</p> : null}
          <InitiatorLine check={currentCheck} />
          {currentCheck?.state === 'failed' && currentCheck.retryable ? (
            <button type="button" className="wfd-small" onClick={() => check(selected, true)}>{tr('workflow.draft.retry')}</button>
          ) : null}
          <label className="wfd-field" htmlFor="wfd-goal">
            <span className="wfd-label">{tr('workflow.draft.goal')}</span>
            <textarea id="wfd-goal" rows={5} value={goal} placeholder={tr('workflow.draft.goalPlaceholder')} onChange={(event) => setGoal(event.target.value)} />
          </label>
          {error ? <p className="wfd-error" role="alert">{error}</p> : null}
          <div className="wfd-actions">
            <button type="button" className="primary" disabled={!canStartDraft({ goal, bot, check: currentCheck, busy })} onClick={() => { void start(); }}>
              {busy ? tr('workflow.draft.starting') : tr('workflow.draft.start')}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

/** 文案键存在就翻译，否则用服务端给的原文。 */
function localized(tr: Translate, key: string, fallback: string): string {
  const text = tr(key);
  return text === key ? fallback : text;
}

// ─── 草稿页 ──────────────────────────────────────────────────────────────

function useDraft(runId: string): {
  view: WorkflowDraftView | null;
  missing: boolean;
  setView: (view: WorkflowDraftView) => void;
  refresh: () => void;
  fetchedAt: number;
} {
  const [view, setViewState] = useState<WorkflowDraftView | null>(null);
  const [missing, setMissing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const setView = useCallback((next: WorkflowDraftView) => {
    setViewState(next);
    setFetchedAt(Date.now());
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    async function poll(): Promise<void> {
      if (disposed) return;
      let stop = false;
      if (!isDocumentHidden()) {
        const result = await fetchDraft(runId);
        if (disposed) return;
        if (result.ok) {
          setView(result.draft);
          setMissing(false);
        } else if (result.status === 404) {
          setMissing(true);
          stop = true;
        }
      }
      if (!disposed && !stop) timer = window.setTimeout(() => { void poll(); }, V3_POLL_MS);
    }
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [runId, setView, tick]);

  return { view, missing, setView, refresh: () => setTick((value) => value + 1), fetchedAt };
}

export function WorkflowDraftPage(props: { runId: string }): React.JSX.Element {
  const tr = useT();
  const { view, missing, setView, refresh, fetchedAt } = useDraft(props.runId);
  const [checks, check] = useInitiatorChecks();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [specProblems, setSpecProblems] = useState<string[] | null>(null);
  const attempted = useRef(new Set<string>());
  const autoFailures = useRef(0);
  const [botNames, setBotNames] = useState<Map<string, string>>(() => new Map());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void fetchOrchestratorBots().then((result) => {
      if (result.ok) setBotNames(new Map(result.bots.map((bot) => [bot.larkAppId, bot.name])));
    });
  }, []);

  useEffect(() => { if (view) check(view.orchestratorAppId); }, [check, view?.orchestratorAppId]);
  const me = view ? checks.get(view.orchestratorAppId) : undefined;
  const isInitiator = !!view && me?.state === 'ok' && sameDraftInitiator(me.initiator, view.initiator);

  /** One write; the page shows the draft the daemon answers with. */
  const act = useCallback(async (action: DraftAction, label: string, opts: { pin?: boolean } = {}): Promise<DraftApiResult<{ draft?: WorkflowDraftView; problems?: string[] }> | null> => {
    if (!view) return null;
    setBusy(label);
    setNotice(null);
    const result = await postDraftAction(props.runId, action, opts.pin === false ? undefined : view.version);
    setBusy(null);
    const answered = (result.ok ? result.draft : (result.body.draft as WorkflowDraftView | undefined));
    if (answered && typeof answered === 'object') setView(answered);
    if (!result.ok) {
      if (result.error === 'spec_invalid') return result;
      setNotice({ text: describeError(tr, result), error: true });
      if (result.error === 'version_conflict' || result.error === 'flow_changed' || result.error === 'state_conflict') refresh();
    }
    return result;
  }, [props.runId, refresh, setView, tr, view]);

  const finalize = useCallback(async (specMarkdown: string | undefined, relay: boolean) => {
    const result = await act({ kind: 'spec', ...(specMarkdown !== undefined ? { specMarkdown } : {}), relayProblems: relay }, 'spec');
    if (!result) return false;
    if (result.ok) {
      setSpecProblems(null);
      autoFailures.current = 0;
      return true;
    }
    if (result.error === 'spec_invalid') setSpecProblems((result.body.problems as string[] | undefined) ?? []);
    return false;
  }, [act]);

  // 模型给出新的 spec：自动校验一次，不过的问题发回给模型（§4.3）。
  useEffect(() => {
    if (!view || !isInitiator || busy) return;
    const triggerId = autoFinalizeCandidate(view, attempted.current, autoFailures.current);
    if (!triggerId) return;
    attempted.current.add(triggerId);
    void finalize(undefined, true).then((ok) => { if (!ok) autoFailures.current += 1; });
  }, [busy, finalize, isInitiator, view]);

  if (missing) {
    return (
      <>
        <DraftHeading title={props.runId} />
        <section className="overview-block wfd-panel"><p className="wfd-notice">{tr('workflow.draft.notFound')}</p></section>
      </>
    );
  }
  if (!view) return <DraftHeading title={props.runId} />;

  const sections = draftSections(view);
  const readOnly = !isInitiator;
  const ended = view.phase === 'abandoned' || view.phase === 'committed' || view.phase === 'started';
  // A running launch step or a written run.json: only 「继续」 (the daemon refuses abandon).
  const abandonable = !ended && !view.launch?.running && !view.launch?.commit;

  const abandon = async () => {
    const message = view.launch?.chat ? tr('workflow.draft.launch.abandonConfirm') : tr('workflow.draft.abandonConfirm');
    if (!await confirm({ title: tr('workflow.draft.abandon'), message, danger: true })) return;
    await act(view.launch ? { kind: 'launch-abandon' } : { kind: 'abandon' }, 'abandon', { pin: false });
  };
  const remove = async () => {
    if (!await confirm({ title: tr('workflow.draft.delete'), message: tr('workflow.draft.deleteConfirm', { title: view.title }), danger: true })) return;
    const result = await act({ kind: 'delete' }, 'delete', { pin: false });
    if (result?.ok) window.location.hash = '#/workflows';
  };
  const approveSpec = async () => {
    const result = await act({ kind: 'approve-spec' }, 'approve-spec');
    // 确认需求后直接开始编排（Architect 在编排 Bot 的 daemon 后台跑）。
    if (result?.ok && result.draft?.phase === 'awaiting_architect') {
      await postDraftAction(props.runId, { kind: 'architect' }, result.draft.version).then((next) => {
        if (next.ok && next.draft) setView(next.draft);
        else if (!next.ok) setNotice({ text: describeError(tr, next), error: true });
      });
    }
  };

  return (
    <>
      <DraftHeading
        title={view.title}
        phase={view.phase}
        actions={isInitiator ? (
          <>
            {abandonable ? <button type="button" className="danger" disabled={!!busy} onClick={() => { void abandon(); }}>{tr('workflow.draft.abandon')}</button> : null}
            {view.phase === 'abandoned' || view.stale
              ? <button type="button" className="danger" disabled={!!busy} onClick={() => { void remove(); }}>{tr('workflow.draft.delete')}</button>
              : null}
          </>
        ) : null}
      />
      <div className="wfd-meta">
        <span><span className="wfd-label">{tr('workflow.draft.orchestrator')}</span>{botNames.get(view.orchestratorAppId) ?? <code>{view.orchestratorAppId}</code>}</span>
        <span><span className="wfd-label">{tr('workflow.draft.initiator')}</span>{tr(initiatorSourceKey(view.initiator))}{isInitiator ? <small className="wfd-me">{tr('workflow.draft.you')}</small> : null}</span>
        <span><span className="wfd-label">{tr('workflow.draft.colUpdated')}</span><time dateTime={view.updatedAt}>{formatDraftTime(view.updatedAt)}</time></span>
      </div>
      {me?.state === 'ok' && readOnly ? <p className="wfd-notice" role="status">{tr('workflow.draft.readOnly')}</p> : null}
      {me?.state === 'failed' ? <p className="wfd-notice" role="status">{tr('workflow.draft.readOnly')}（{describeError(tr, me)}）</p> : null}
      {notice ? <p className={`wfd-notice${notice.error ? ' wfd-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p> : null}
      {sections.copy ? <CopyInfoPanel view={view} canWrite={isInitiator} busy={busy} act={act} botNames={botNames} /> : null}
      {sections.template && view.template ? <TemplateRunInfo template={view.template} isOwner={me?.state === 'ok' && me.initiator.openId === view.template.ownerOpenId} /> : null}
      {sections.chat || sections.spec ? <div className={`wfd-layout${sections.spec && sections.chat ? ' wfd-two' : ''}`}>
        {sections.chat ? <ChatPanel view={view} canWrite={isInitiator} busy={busy} act={act} /> : null}
        {sections.spec ? (
          <SpecPanel
            view={view}
            canWrite={isInitiator}
            busy={busy}
            problems={specProblems}
            onValidate={(text) => { void finalize(text, false); }}
            onApprove={() => { void approveSpec(); }}
            onRevise={() => { void act({ kind: 'revise-spec' }, 'revise-spec'); }}
          />
        ) : null}
      </div> : null}
      {sections.architect ? <ArchitectPanel view={view} fetchedAt={fetchedAt} canWrite={isInitiator} busy={busy} act={act} /> : null}
      {sections.flow && view.flow ? <FlowPanel view={view} canWrite={isInitiator} busy={busy} act={act} /> : null}
      {sections.flow && !view.flow && view.flowError ? <p className="wfd-notice wfd-error" role="alert">{tr('workflow.draft.flowError', { error: view.flowError })}</p> : null}
      {sections.saveTemplate && isInitiator && !saving ? (
        <div className="wfd-actions wfl-save-entry">
          <button type="button" disabled={!!busy} onClick={() => setSaving(true)}>{tr('workflow.library.saveFromDraft')}</button>
          <span className="muted">{tr('workflow.library.saveFromDraftHint')}</span>
        </div>
      ) : null}
      {saving ? <SaveTemplateDialog source={{ kind: 'draft', runId: view.runId }} botNames={botNames} onClose={() => setSaving(false)} /> : null}
      {sections.groupSetup ? <GroupSetupPanel view={view} canWrite={isInitiator} busy={busy} act={act} /> : null}
      {sections.launch ? <LaunchPanel view={view} canWrite={isInitiator} busy={busy} act={act} botNames={botNames} /> : null}
    </>
  );
}

function DraftHeading(props: { title: string; phase?: WorkflowDraftView['phase']; actions?: React.ReactNode }): React.JSX.Element {
  const tr = useT();
  return (
    <div className="page-heading v3r-detail-heading wfd-heading">
      <div className="v3r-title-row">
        <p className="eyebrow">{tr('workflow.draft.draft')}</p>
        <a href="#/workflows" className="btn-link v3r-back-link">← {tr('nav.workflows')}</a>
        <h1>{props.title}</h1>
        {props.phase ? <span className={`v3r-pill wfd-phase wfd-phase-${props.phase}`}>{tr(DRAFT_PHASE_KEY[props.phase])}</span> : null}
      </div>
      {props.actions ? <div className="page-heading-actions">{props.actions}</div> : null}
    </div>
  );
}

type Act = (action: DraftAction, label: string, opts?: { pin?: boolean }) => Promise<unknown>;

// ─── 澄清（§4.2）────────────────────────────────────────────────────────

function ChatPanel(props: { view: WorkflowDraftView; canWrite: boolean; busy: string | null; act: Act }): React.JSX.Element {
  const tr = useT();
  const { view } = props;
  const [text, setText] = useState('');
  const listRef = useRef<HTMLOListElement | null>(null);
  const writable = canChat(view, props.canWrite) && !props.busy;
  const question = activeQuestion(view.clarify.turns);
  const turnCount = view.clarify.turns.length;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turnCount, view.clarify.pending]);

  const send = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !writable) return;
    const result = await props.act({ kind: 'message', text: trimmed }, 'message') as { ok?: boolean } | null;
    if (result?.ok) setText('');
  };

  return (
    <section className="overview-block wfd-panel wfd-chat" aria-labelledby="wfd-chat-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-chat-title">{tr('workflow.draft.clarifyTitle')}</h2>
        <span className="sect-head-hint">{tr('workflow.draft.clarifyHint')}</span>
      </div>
      <ol className="wfd-turns" ref={listRef} aria-live="polite">
        {view.clarify.turns.map((turn, index) => (
          <li key={`${turn.at}-${index}`} className={`wfd-turn wfd-turn-${turn.role}`}>
            <span className="wfd-turn-who">
              {turn.role === 'user' ? tr('workflow.draft.roleUser') : turn.role === 'assistant' ? tr('workflow.draft.roleBot') : tr('workflow.draft.roleSystem')}
            </span>
            <div className="wfd-turn-text">{turnDisplayText(turn, tr('workflow.draft.specInPanel'))}</div>
            {turn.question ? (
              <div className="wfd-question">
                <p className="wfd-question-text">{turn.question.question}</p>
                {question?.index === index && turn.question.options.length > 0 ? (
                  <div className="wfd-options" role="group" aria-label={tr('workflow.draft.options')}>
                    {turn.question.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={option === turn.question!.recommended ? 'primary wfd-option' : 'wfd-option'}
                        disabled={!writable}
                        onClick={() => { void send(option); }}
                      >
                        {option}
                        {option === turn.question!.recommended ? <small className="wfd-recommended">{tr('workflow.draft.recommended')}</small> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
        {view.clarify.pending ? (
          <li className="wfd-turn wfd-turn-assistant wfd-pending" role="status">
            <span className="wfd-turn-who">{tr('workflow.draft.roleBot')}</span>
            <div className="wfd-turn-text">{tr('workflow.draft.replying')}</div>
          </li>
        ) : null}
      </ol>
      {needsContinue(view) ? (
        <div className="wfd-disconnected" role="status">
          <span>{view.copy && !copyHasConversation(view.clarify) ? tr('workflow.copy.noSession') : tr('workflow.draft.disconnected')}</span>
          <button type="button" className="primary" disabled={!props.canWrite || !!props.busy}
            onClick={() => { void props.act({ kind: 'continue' }, 'continue'); }}>
            {tr('workflow.draft.continue')}
          </button>
        </div>
      ) : view.clarify.error ? <p className="wfd-error" role="alert">{view.clarify.error}</p> : null}
      <form className="wfd-composer" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
        <label htmlFor="wfd-message" className="wfd-sr-only">{tr('workflow.draft.message')}</label>
        <textarea
          id="wfd-message"
          rows={2}
          value={text}
          disabled={!writable}
          placeholder={writable ? tr('workflow.draft.messagePlaceholder') : ''}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="submit" className="primary" disabled={!writable || !text.trim()}>{tr('workflow.draft.send')}</button>
      </form>
    </section>
  );
}

// ─── spec 与第一道确认（§4.3）────────────────────────────────────────────

function SpecPreviewBlock(props: { preview: SpecPreview }): React.JSX.Element {
  const tr = useT();
  const { preview } = props;
  return (
    <div className="wfd-spec-preview">
      <h3>{preview.title || '—'}</h3>
      <dl className="wfd-dl">
        <dt>{tr('workflow.draft.specRequirement')}</dt><dd>{preview.requirement || '—'}</dd>
        {preview.acceptance ? <><dt>{tr('workflow.draft.specAcceptance')}</dt><dd>{preview.acceptance}</dd></> : null}
        {preview.nonGoals.length ? <><dt>{tr('workflow.draft.specNonGoals')}</dt><dd>{preview.nonGoals.join('；')}</dd></> : null}
      </dl>
      <ol className="wfd-spec-nodes">
        {preview.nodes.map((node) => (
          <li key={node.sketchId} className="wfd-spec-node">
            <p className="wfd-spec-node-head"><code>{node.sketchId}</code>{node.riskGate ? <span className="wfd-tag wfd-tag-gate">{tr('workflow.draft.riskGate')}</span> : null}{node.assignee ? <span className="wfd-tag">{tr('workflow.draft.assignee', { bot: node.assignee })}</span> : null}</p>
            <p>{node.goal}</p>
            <dl className="wfd-dl wfd-dl-compact">
              <dt>{tr('workflow.draft.specInputs')}</dt><dd>{node.inputNeeds.length ? node.inputNeeds.join('；') : '—'}</dd>
              <dt>{tr('workflow.draft.specOutputs')}</dt><dd>{node.expectedOutputs.length ? node.expectedOutputs.join('、') : '—'}</dd>
              <dt>{tr('workflow.draft.specNodeAcceptance')}</dt><dd>{node.acceptance || '—'}</dd>
              {node.unknowns.length ? <><dt>{tr('workflow.draft.specUnknowns')}</dt><dd className="wfd-unknowns">{node.unknowns.join('；')}</dd></> : null}
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SpecPanel(props: {
  view: WorkflowDraftView;
  canWrite: boolean;
  busy: string | null;
  problems: string[] | null;
  onValidate: (text: string) => void;
  onApprove: () => void;
  onRevise: () => void;
}): React.JSX.Element {
  const tr = useT();
  const { view } = props;
  const serverText = specEditorText(view);
  const [text, setText] = useState(serverText);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setText(serverText); }, [dirty, serverText]);
  const finalized = view.phase !== 'clarifying';
  const preview = finalized && view.spec?.json ? specPreview({ json: view.spec.json }) : specPreview({ markdown: text });
  const problems = props.problems ?? (view.phase === 'clarifying' ? view.problems : undefined);
  const canEdit = props.canWrite && (view.phase === 'clarifying' || view.phase === 'spec_ready') && !props.busy;

  return (
    <section className="overview-block wfd-panel wfd-spec" aria-labelledby="wfd-spec-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-spec-title">{tr('workflow.draft.specTitle')}</h2>
        <span className="sect-head-hint">{finalized ? tr('workflow.draft.specValidated') : tr('workflow.draft.specCandidate')}</span>
      </div>
      {preview ? <SpecPreviewBlock preview={preview} /> : <p className="muted">{tr('workflow.draft.specUnreadable')}</p>}
      {problems?.length ? (
        <div className="wfd-problems" role="alert">
          <p>{tr('workflow.draft.specProblems')}</p>
          <ul>{problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>
        </div>
      ) : null}
      <details className="wfd-spec-edit">
        <summary>{tr('workflow.draft.specEdit')}</summary>
        <label htmlFor="wfd-spec-text" className="wfd-sr-only">{tr('workflow.draft.specEdit')}</label>
        <textarea id="wfd-spec-text" rows={14} value={text} disabled={!canEdit}
          onChange={(event) => { setText(event.target.value); setDirty(true); }} />
        <div className="wfd-actions">
          <button type="button" disabled={!canEdit || !text.trim()} onClick={() => { setDirty(false); props.onValidate(text); }}>
            {props.busy === 'spec' ? tr('workflow.draft.validating') : tr('workflow.draft.revalidate')}
          </button>
          {dirty ? <button type="button" className="btn-link" onClick={() => { setDirty(false); setText(serverText); }}>{tr('workflow.draft.discardEdit')}</button> : null}
        </div>
      </details>
      {view.phase === 'spec_ready' ? (
        <div className="wfd-actions wfd-gate">
          <button type="button" className="primary" disabled={!props.canWrite || !!props.busy} onClick={props.onApprove}
            title={props.canWrite ? undefined : tr('workflow.draft.onlyInitiator')}>
            {tr('workflow.draft.approveSpec')}
          </button>
          <button type="button" disabled={!props.canWrite || !!props.busy} onClick={props.onRevise}>{tr('workflow.draft.backToChat')}</button>
        </div>
      ) : null}
      {view.specConfirmation ? (
        <p className="wfd-confirmed">{tr('workflow.draft.specConfirmed', { at: formatDraftTime(view.specConfirmation.confirmedAt) })}</p>
      ) : null}
    </section>
  );
}

// ─── 编排（§4.4）────────────────────────────────────────────────────────

function ArchitectPanel(props: { view: WorkflowDraftView; fetchedAt: number; canWrite: boolean; busy: string | null; act: Act }): React.JSX.Element {
  const tr = useT();
  const { view } = props;
  const running = view.phase === 'architect_running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = (view.architect?.elapsedMs ?? 0) + (running ? Math.max(0, now - props.fetchedAt) : 0);
  const failed = view.architect && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(view.architect.state);

  return (
    <section className="overview-block wfd-panel wfd-architect" aria-labelledby="wfd-architect-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-architect-title">{tr('workflow.draft.architectTitle')}</h2>
      </div>
      {running ? (
        <div className="wfd-running" role="status">
          <span className="wfd-spinner" aria-hidden="true" />
          <span>{tr('workflow.draft.architectRunning', { elapsed: formatV3Duration(elapsed) })}</span>
          <button type="button" className="danger" disabled={!props.canWrite || !!props.busy}
            onClick={() => { void props.act({ kind: 'architect-cancel' }, 'architect-cancel', { pin: false }); }}>
            {tr('workflow.draft.cancelArchitect')}
          </button>
        </div>
      ) : view.phase === 'awaiting_architect' ? (
        <>
          {failed ? (
            <div className="wfd-problems" role="alert">
              <p>{tr(`workflow.draft.architect.${view.architect!.state}`)}</p>
              {view.architect!.problems?.length ? <ul>{view.architect!.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul> : null}
            </div>
          ) : null}
          <div className="wfd-actions">
            <button type="button" className="primary" disabled={!props.canWrite || !!props.busy}
              onClick={() => { void props.act({ kind: 'architect' }, 'architect'); }}>
              {failed ? tr('workflow.draft.rerunArchitect') : tr('workflow.draft.startArchitect')}
            </button>
            <button type="button" disabled={!props.canWrite || !!props.busy}
              onClick={() => { void props.act({ kind: 'revise-spec' }, 'revise-spec'); }}>
              {tr('workflow.draft.backToSpec')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

// ─── 流程图与第二道确认（§4.4）──────────────────────────────────────────

function FlowPanel(props: { view: WorkflowDraftView; canWrite: boolean; busy: string | null; act: Act }): React.JSX.Element {
  const tr = useT();
  const flow = props.view.flow!;
  const graph = useMemo(() => draftGraphView(flow.dag, flow.plan.rows), [flow.dag, flow.plan.rows]);
  const rowOf = useMemo(() => new Map(flow.plan.rows.map((row) => [row.nodeId, row])), [flow.plan.rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    setSelectedId((current) => current && flow.dag.nodes.some((node) => node.id === current) ? current : flow.dag.nodes[0]?.id ?? null);
  }, [flow.dag.nodes]);
  const selected = flow.dag.nodes.find((node) => node.id === selectedId);
  const rows = selected ? assignableRows(selected.id, flow.plan.rows, flow.dag) : [];
  const choices = executorBotChoices(flow.roster, tr('workflow.draft.orchestratorSuffix'));
  const summary = flowSummarySections(flow);
  const seenConfirmed = useRef(false);
  if (props.view.flowConfirmation?.valid) seenConfirmed.current = true;
  const confirmState = flowConfirmState(props.view, seenConfirmed.current);
  // A fresh confirmation clears the "void" notice.
  if (confirmState === 'confirmed') seenConfirmed.current = true;
  // After the second confirmation a bot can still be changed: that voids it (E5).
  // During 拉群中 only while it is stopped at the live check (§4.5 第 5 步).
  const launchSwap = launchControls(props.view, props.canWrite).canSwapBots;
  const editable = props.canWrite && (props.view.phase === 'dag_ready' || props.view.phase === 'flow_confirmed' || launchSwap)
    && !props.view.launch?.running && !props.view.launch?.commit;
  const disabled = !editable || !!props.busy;
  // A template with parameters keeps its bots (the daemon refuses a swap: 复制 is D6).
  const swapDisabled = disabled || !!props.view.template?.hasInputs;
  // Once the group exists the requirement stage is closed (the daemon refuses).
  const launched = !!props.view.launch;

  const statusLineOf = (node: { id: string; isLoop?: boolean; host?: unknown }) => {
    if (node.host) return tr('workflow.draft.hostNode');
    // A copied node whose bot cannot run it (D6): swap before 「确认流程」.
    if (props.view.copy?.needsBot?.some((item) => item.nodeId === node.id && !item.resolved)) return `⚠️ ${tr('workflow.copy.needsBotNode')}`;
    if (node.isLoop) return tr('workflow.draft.loopNode', { count: assignableRows(node.id, flow.plan.rows, flow.dag).length });
    const row = rowOf.get(node.id);
    if (row?.missedAssignee) return `⚠️ ${tr('workflow.draft.assigneeMissed', { bot: row.missedAssignee.assignee })}`;
    return row?.reason ?? (row?.main ? tr('workflow.draft.mainBot') : '');
  };

  return (
    <section className="overview-block wfd-panel wfd-flow" aria-labelledby="wfd-flow-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-flow-title">{tr('workflow.draft.flowTitle')}</h2>
        <span className="sect-head-hint">
          {tr('workflow.draft.flowHint', { count: flow.plan.rows.length })}
          {props.view.architect ? ` · ${tr('workflow.draft.architectDone', { elapsed: formatV3Duration(props.view.architect.elapsedMs), attempt: props.view.architect.attempt })}` : ''}
        </span>
      </div>
      <div className="wfd-flow-grid">
        <div className="v3r-graph-card wfd-graph-card">
          <DagGraph
            view={graph}
            selectedId={selectedId}
            onSelect={setSelectedId}
            statusLineOf={statusLineOf}
            interactive
            nodeLabelOf={(node) => `${node.id}${node.bot?.name ? ` · ${node.bot.name}` : ''}`}
          />
        </div>
        <div className="v3r-panel wfd-node-panel" aria-live="polite">
          {selected ? (
            <>
              <p className="wfd-node-title"><code>{selected.id}</code>{selected.humanGate ? <span className="wfd-tag wfd-tag-gate">{tr('workflow.draft.gate')}</span> : null}</p>
              {selected.goal ? <p className="v3r-goal">{selected.goal}</p> : null}
              {props.view.copy && selected.type !== 'host' && selected.type !== 'loop'
                ? <CopyNodeTextEditor view={props.view} nodeId={selected.id} canWrite={props.canWrite} busy={props.busy} act={props.act} />
                : null}
              {selected.type === 'host' ? <p className="muted">{tr('workflow.draft.hostNodeHelp', { executor: selected.executor ?? '' })}</p> : null}
              {rows.map((row) => {
                const selectId = `wfd-node-bot-${row.nodeId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
                return (
                  <div key={row.nodeId} className="wfd-node-bot">
                    <label htmlFor={selectId} className="wfd-label">
                      {rows.length > 1 || row.nodeId !== selected.id ? tr('workflow.draft.botFor', { node: row.nodeId }) : tr('workflow.draft.executor')}
                    </label>
                    <select
                      id={selectId}
                      value={row.larkAppId}
                      disabled={swapDisabled}
                      onChange={(event) => {
                        const larkAppId = event.target.value;
                        if (larkAppId && larkAppId !== row.larkAppId) {
                          void props.act({ kind: 'node-bot', nodeId: row.nodeId, larkAppId }, 'node-bot');
                        }
                      }}
                    >
                      {choices.some((choice) => choice.larkAppId === row.larkAppId) ? null : <option value={row.larkAppId}>{row.name}</option>}
                      {choices.map((choice) => (
                        <option key={choice.larkAppId} value={choice.larkAppId} disabled={!!choice.disabledWhy}>
                          {choice.disabledWhy ? `${choice.label}：${choice.disabledWhy}` : choice.label}
                        </option>
                      ))}
                    </select>
                    {row.reason ? <p className="wfd-reason"><span className="wfd-label">{tr('workflow.draft.reason')}</span>{row.reason}</p> : null}
                    {row.missedAssignee ? (
                      <p className="wfd-warning">⚠️ {tr('workflow.draft.assigneeMissed', { bot: row.missedAssignee.assignee })}{row.missedAssignee.why ? `（${row.missedAssignee.why}）` : ''}</p>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : <p className="muted">{tr('workflow.draft.pickNode')}</p>}
        </div>
      </div>

      {flow.planProblems.length ? (
        <div className="wfd-problems" role="alert">
          <p>{tr('workflow.draft.planProblems')}</p>
          <ul>{flow.planProblems.map((problem, index) => <li key={index}>{problem.nodeId ? `${problem.nodeId}：` : ''}{problem.why}</li>)}</ul>
        </div>
      ) : null}

      <div className="wfd-summary" aria-labelledby="wfd-summary-title">
        <h3 id="wfd-summary-title">{tr('workflow.draft.summaryTitle')}</h3>
        <div className="wfd-summary-grid">
          <div>
            <h4>{tr('workflow.draft.summaryNodes')}</h4>
            <ul className="wfd-summary-list">
              {summary.nodes.map((row) => (
                <li key={row.nodeId}>
                  <code>{row.nodeId}</code> → <b>{row.bot}</b>{row.cli ? `（${row.cli}）` : ''}
                  {row.reason ? <span className="wfd-summary-reason">：{row.reason}</span> : null}
                  {row.warning ? <span className="wfd-warning"> ⚠️ {tr('workflow.draft.assigneeMissed', { bot: row.warning })}</span> : null}
                </li>
              ))}
              {summary.unplaced.map((line) => <li key={line} className="wfd-warning">⚠️ {line}</li>)}
            </ul>
          </div>
          <div>
            <h4>{tr('workflow.draft.summarySideEffects')}</h4>
            {summary.sideEffects.length ? (
              <ul className="wfd-summary-list">
                {summary.sideEffects.map((item) => <li key={`${item.nodeId}:${item.kind}`}><code>{item.nodeId}</code>：{localized(tr, `workflow.draft.sideEffect.${item.kind}`, item.kind)}</li>)}
              </ul>
            ) : <p className="muted">{tr('workflow.draft.none')}</p>}
          </div>
          <div>
            <h4>{tr('workflow.draft.summaryGates')}</h4>
            {summary.gates.length ? (
              <ul className="wfd-summary-list">
                {summary.gates.map((gate) => (
                  <li key={gate.nodeId}>
                    <code>{gate.nodeId}</code>：{gate.approverCount ? tr('workflow.draft.gateApprovers', { count: gate.approverCount }) : tr('workflow.draft.gateAnyOperator')}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{tr('workflow.draft.none')}</p>}
          </div>
        </div>
      </div>

      {confirmState === 'void' ? <p className="wfd-warning wfd-void" role="alert">{tr('workflow.draft.confirmationVoid')}</p> : null}
      {confirmState === 'confirmed' ? (
        <p className="wfd-confirmed" role="status">{tr('workflow.draft.flowConfirmed', { at: formatDraftTime(props.view.flowConfirmation!.confirmedAt) })}</p>
      ) : null}

      <div className="wfd-actions wfd-gate">
        {props.view.template && !props.view.template.needsConfirmation ? (
          <p className="muted">{tr('workflow.library.runNoConfirm')}</p>
        ) : confirmState !== 'confirmed' ? (
          <button type="button" className="primary" disabled={disabled}
            title={props.canWrite ? undefined : tr('workflow.draft.onlyInitiator')}
            onClick={() => { void props.act({ kind: 'approve-flow', flowSummarySha256: flow.flowSummarySha256 }, 'approve-flow'); }}>
            {tr('workflow.draft.approveFlow')}
          </button>
        ) : null}
        {launched || props.view.template ? null : (
          <>
            <label htmlFor="wfd-architect-note" className="wfd-sr-only">{tr('workflow.draft.rearchitectNote')}</label>
            <input id="wfd-architect-note" type="text" className="wfd-note" value={note} disabled={disabled}
              placeholder={tr('workflow.draft.rearchitectNote')} onChange={(event) => setNote(event.target.value)} />
            <button type="button" disabled={disabled}
              onClick={() => { void props.act({ kind: 'architect', ...(note.trim() ? { note: note.trim() } : {}) }, 'architect'); setNote(''); }}>
              {tr('workflow.draft.rearchitect')}
            </button>
            <button type="button" disabled={disabled} onClick={() => { void props.act({ kind: 'revise-spec' }, 'revise-spec'); }}>
              {tr('workflow.draft.backToSpec')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

// ─── 拉群开始（§4.5，D4）────────────────────────────────────────────────

/** 群设置：群名（默认工作流标题，daemon 在末尾补标记）、额外成员（邮箱 / union_id）。 */
function GroupSetupPanel(props: { view: WorkflowDraftView; canWrite: boolean; busy: string | null; act: Act }): React.JSX.Element {
  const tr = useT();
  // A template run's form (D5) already asked for these: carried over once.
  const carried = useMemo(() => {
    try {
      const raw = sessionStorage.getItem(`${TEMPLATE_GROUP_SETUP_KEY}:${props.view.runId}`);
      return raw ? JSON.parse(raw) as { groupName?: string; members?: string } : undefined;
    } catch { return undefined; }
  }, [props.view.runId]);
  const [name, setName] = useState(carried?.groupName || props.view.title);
  const [members, setMembers] = useState(carried?.members ?? '');
  const parsed = parseLaunchMembersInput(members);
  const nameOk = name.trim().length > 0 && Array.from(name.trim()).length <= 100;
  const membersOk = parsed.invalid.length === 0 && parsed.openIds.length === 0;
  const disabled = !props.canWrite || !!props.busy;
  const start = () => {
    if (!nameOk || !membersOk) return;
    void props.act({
      kind: 'launch',
      ...(name.trim() !== props.view.title ? { groupName: name.trim() } : {}),
      ...(parsed.members.length ? { extraMembers: parsed.members } : {}),
    }, 'launch');
  };
  return (
    <section className="overview-block wfd-panel wfd-group" aria-labelledby="wfd-group-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-group-title">{tr('workflow.draft.groupTitle')}</h2>
        <span className="sect-head-hint">{tr('workflow.draft.launch.setupHint')}</span>
      </div>
      <div className="wfd-form">
        <label htmlFor="wfd-group-name" className="wfd-label">{tr('workflow.draft.launch.groupName')}</label>
        <input id="wfd-group-name" type="text" value={name} disabled={disabled} maxLength={100}
          aria-describedby="wfd-group-name-help" aria-invalid={!nameOk}
          onChange={(event) => setName(event.target.value)} />
        <p id="wfd-group-name-help" className="wfd-help">{tr('workflow.draft.launch.groupNameHelp')}</p>
        <label htmlFor="wfd-group-members" className="wfd-label">{tr('workflow.draft.launch.extraMembers')}</label>
        <textarea id="wfd-group-members" rows={2} value={members} disabled={disabled}
          placeholder={tr('workflow.draft.launch.extraMembersPlaceholder')}
          aria-describedby="wfd-group-members-help" aria-invalid={!membersOk}
          onChange={(event) => setMembers(event.target.value)} />
        <p id="wfd-group-members-help" className="wfd-help">{tr('workflow.draft.launch.extraMembersHelp')}</p>
        {parsed.openIds.length ? <p className="wfd-error" role="alert">{tr('workflow.draft.launch.openIdRefused', { ids: parsed.openIds.join('、') })}</p> : null}
        {parsed.invalid.length ? <p className="wfd-error" role="alert">{tr('workflow.draft.launch.memberInvalid', { items: parsed.invalid.join('、') })}</p> : null}
      </div>
      <p className="muted">{tr('workflow.draft.launch.whoJoins')}</p>
      <div className="wfd-actions">
        <button type="button" className="primary" disabled={disabled || !nameOk || !membersOk}
          title={props.canWrite ? undefined : tr('workflow.draft.onlyInitiator')}
          onClick={start}>
          {tr('workflow.draft.startGroup')}
        </button>
      </div>
    </section>
  );
}

const STEP_STATUS_ICON: Record<string, string> = { done: '✅', running: '⏳', failed: '⚠️', waiting: '⏸', pending: '·' };

/** 拉群进度：8 步、停住的原因与「继续」、第 5 步逐节点原因与就地换 Bot、孤儿群、群链接、放弃。 */
function LaunchPanel(props: {
  view: WorkflowDraftView; canWrite: boolean; busy: string | null; act: Act; botNames: Map<string, string>;
}): React.JSX.Element {
  const tr = useT();
  const { view } = props;
  const launch = view.launch!;
  const rows = launchStepRows(launch);
  const controls = launchControls(view, props.canWrite);
  const disabled = !!props.busy;
  const nameOf = (appId: string) => props.botNames.get(appId) ?? appId;
  const choices = view.flow ? executorBotChoices(view.flow.roster, tr('workflow.draft.orchestratorSuffix')) : [];
  const rowOf = new Map((view.flow?.plan.rows ?? []).map((row) => [row.nodeId, row]));

  // 已启动：去运行详情页（一次）。
  const redirected = useRef(false);
  useEffect(() => {
    if (view.phase === 'started' && !redirected.current) {
      redirected.current = true;
      window.location.hash = startedRunHref(view.runId);
    }
  }, [view.phase, view.runId]);

  const errorText = launch.error
    ? (() => {
      const key = launchErrorKey(launch.error.code);
      return key ? tr(key) : launch.error.message;
    })()
    : undefined;
  const problems = currentLaunchProblems(view);
  /** 人工确认后重发：确认框写明「如果群里其实已有，会出现两条」。 */
  const resend = async (what: 'root' | 'summary') => {
    const ok = await confirm({
      title: tr(what === 'root' ? 'workflow.draft.launch.resendRoot' : 'workflow.draft.launch.resendSummary'),
      message: tr(what === 'root' ? 'workflow.draft.launch.resendRootConfirm' : 'workflow.draft.launch.resendSummaryConfirm'),
      danger: true,
    });
    if (!ok) return;
    await props.act(what === 'root' ? { kind: 'launch-resend-root' } : { kind: 'launch-resend-summary' }, `resend-${what}`);
  };

  return (
    <section className="overview-block wfd-panel wfd-launch" aria-labelledby="wfd-launch-title">
      <div className="sect-head overview-panel-head">
        <h2 id="wfd-launch-title">{tr('workflow.draft.launch.title')}</h2>
        <span className="sect-head-hint">
          <code>{launch.groupName}</code>
          {launch.attempt > 1 ? ` · ${tr('workflow.draft.launch.attempt', { attempt: launch.attempt })}` : ''}
        </span>
      </div>

      <ol className="wfd-launch-steps" aria-label={tr('workflow.draft.launch.stepsLabel')} aria-live="polite">
        {rows.map((row, index) => (
          <li key={row.key} className={`wfd-launch-step wfd-step-${row.status}`} aria-current={row.status === 'running' || row.status === 'failed' ? 'step' : undefined}>
            <span aria-hidden="true" className="wfd-step-icon">{STEP_STATUS_ICON[row.status]}</span>
            <span className="wfd-step-name">{index + 1}. {tr(`workflow.draft.launch.step.${row.key}`)}</span>
            <span className="wfd-sr-only">{tr(`workflow.draft.launch.status.${row.status}`)}</span>
            {row.noteKey ? <small className="wfd-help">{tr(row.noteKey)}</small> : null}
          </li>
        ))}
      </ol>

      {launch.state === 'abandoned' ? <p className="wfd-notice" role="status">{tr('workflow.draft.launch.abandoned')}</p> : null}
      {launch.state === 'started' ? (
        <p className="wfd-confirmed" role="status">
          {tr('workflow.draft.launch.started')} <a href={startedRunHref(view.runId)}>{tr('workflow.draft.launch.openRun')}</a>
        </p>
      ) : null}
      {launch.running ? <p className="wfd-notice" role="status">{tr('workflow.draft.launch.running')}</p> : null}

      {errorText && !launch.running && launch.state !== 'abandoned' ? (
        <div className="wfd-problems" role="alert">
          <p>{tr('workflow.draft.launch.stoppedAt', { step: tr(`workflow.draft.launch.step.${rows.find((r) => r.status === 'failed')?.key ?? 'intent'}`) })}{errorText}</p>
          {launchErrorKey(launch.error!.code) && launch.error!.message ? <p className="wfd-help">{launch.error!.message}</p> : null}
        </div>
      ) : null}

      {problems.length ? (
        <div className="wfd-launch-problems">
          <h3>{tr('workflow.draft.launch.checkTitle')}</h3>
          <ul>
            {problems.map((problem) => {
              const selectId = `wfd-launch-bot-${problem.nodeId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
              const current = rowOf.get(problem.nodeId)?.larkAppId ?? problem.larkAppId;
              return (
                <li key={`${problem.nodeId}:${problem.code}`} className="wfd-launch-problem">
                  <p><code>{problem.nodeId}</code> → <b>{nameOf(problem.larkAppId)}</b>：{localized(tr, `workflow.draft.botProblem.${problem.code}`, problem.why)}{problem.detail ? `（${problem.detail}）` : ''}</p>
                  {problem.code !== 'DIRECTORY_OUTPUT' && rowOf.has(problem.nodeId) ? (
                    <>
                      <label htmlFor={selectId} className="wfd-label">{tr('workflow.draft.launch.swapBot')}</label>
                      <select id={selectId} value={current} disabled={!controls.canSwapBots || disabled}
                        aria-describedby="wfd-launch-swap-help"
                        onChange={(event) => {
                          const larkAppId = event.target.value;
                          if (larkAppId && larkAppId !== current) void props.act({ kind: 'node-bot', nodeId: problem.nodeId, larkAppId }, 'node-bot');
                        }}>
                        {choices.some((choice) => choice.larkAppId === current) ? null : <option value={current}>{nameOf(current)}</option>}
                        {choices.map((choice) => (
                          <option key={choice.larkAppId} value={choice.larkAppId} disabled={!!choice.disabledWhy}>
                            {choice.disabledWhy ? `${choice.label}：${choice.disabledWhy}` : choice.label}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p id="wfd-launch-swap-help" className="wfd-help">{tr('workflow.draft.launch.swapHelp')}</p>
        </div>
      ) : null}

      {controls.needsReconfirm ? <p className="wfd-warning" role="alert">{tr('workflow.draft.launch.reconfirm')}</p> : null}

      {launch.chat ? (
        <div className="wfd-launch-chat">
          <p>
            <span className="wfd-label">{tr('workflow.draft.launch.group')}</span>
            {launch.chat.shareLink
              ? <a href={launch.chat.shareLink} target="_blank" rel="noreferrer noopener">{tr('workflow.draft.launch.openGroup')}</a>
              : <code>{launch.chat.chatId}</code>}
          </p>
          {launch.chat.ownerTransferError ? (
            <p className="wfd-warning" role="status">{tr('workflow.draft.launch.ownerTransferFailed', { error: launch.chat.ownerTransferError })}</p>
          ) : null}
          {launch.chat.warnings?.map((warning) => <p key={warning} className="wfd-warning">⚠️ {warning}</p>)}
        </div>
      ) : null}

      {launch.orphanSuspects?.length ? (
        <div className="wfd-launch-orphans">
          <h3>{tr('workflow.draft.launch.orphansTitle')}</h3>
          <p className="wfd-help">{tr('workflow.draft.launch.orphansHelp', { marker: launch.marker })}</p>
          <ul>
            {launch.orphanSuspects.map((orphan, index) => (
              <li key={`${orphan.chatId ?? orphan.attemptAt ?? ''}-${index}`}>
                {orphan.chatId ? <code>{orphan.chatId}</code> : null}
                {orphan.name ? ` ${orphan.name}` : ''}
                {orphan.attemptAt ? <> <time dateTime={orphan.attemptAt}>{formatDraftTime(orphan.attemptAt)}</time></> : null}
                {' · '}{orphan.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {launch.migrate?.summaryUnverified && !launch.migrate.summaryMessageId ? (
        <p className="wfd-warning" role="status">{tr('workflow.draft.launch.summaryUnverified')}</p>
      ) : null}
      {launch.rootManualResends?.length ? (
        <p className="wfd-help">{tr('workflow.draft.launch.rootResent', { count: launch.rootManualResends.length })}</p>
      ) : null}

      <div className="wfd-actions">
        {controls.canResendRoot ? (
          <button type="button" disabled={disabled} onClick={() => { void resend('root'); }}>
            {tr('workflow.draft.launch.resendRoot')}
          </button>
        ) : null}
        {controls.canResendSummary ? (
          <button type="button" disabled={disabled} onClick={() => { void resend('summary'); }}>
            {tr('workflow.draft.launch.resendSummary')}
          </button>
        ) : null}
        {controls.canContinue ? (
          <button type="button" className="primary" disabled={disabled} onClick={() => { void props.act({ kind: 'launch-continue' }, 'launch-continue'); }}>
            {tr('workflow.draft.launch.continue')}
          </button>
        ) : null}
        {!props.canWrite && launch.state !== 'started' && launch.state !== 'abandoned'
          ? <span className="wfd-help">{tr('workflow.draft.onlyInitiator')}</span>
          : null}
      </div>
    </section>
  );
}
