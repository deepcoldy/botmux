/**
 * 任务分配总览页（#/assign）：
 * - 全局状态、语义裁判与全局派活原则概览；
 * - 各 Bot 实时状态与画像卡片（可用候选池 + 被排除/未参与列表及原因）；
 * - 无副作用试算推荐（Dry-Run）；
 * - 最近分配记录与兜底换人链路（支持按 Bot / 结果筛选）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu, LoadingState, dropdownLabel } from './dashboard-components.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { botDefaultsHref } from './bot-defaults.js';
import { settingsHref, sessionDetailHref } from './command-palette-sources.js';
import type {
  CandidateEvaluation,
  TaskRoutingDecision,
  TaskRoutingOutcome,
  TaskRoutingRecord,
} from '../../core/task-routing/model.js';
import {
  fetchTaskRoutingHistory,
  fetchTaskRoutingStatus,
  requestTaskRoutingRecommend,
} from './task-routing-api.js';
import {
  attemptOutcomeLabelKey,
  attemptOutcomeTone,
  buildBotRuntimePills,
  callerKindLabelKey,
  confidenceLabelKey,
  costTierLabelKey,
  costTierTone,
  exclusionCodeLabelKey,
  filterTaskRoutingRecords,
  formatRoutingTime,
  hasFallbackSwitch,
  matcherKindLabelKey,
  outcomeLabelKey,
  outcomeTone,
  sortExcludedCandidates,
  summarizeTaskRoutingPool,
  type TaskRoutingHistoryResponse,
  type TaskRoutingStatusResponse,
} from './task-routing-model.js';

const OUTCOME_FILTERS: ReadonlyArray<TaskRoutingOutcome | 'all'> = [
  'all',
  'dispatched',
  'fallback_dispatched',
  'failed',
  'pending',
];

function Badge(props: { tone: string; children: string; title?: string }) {
  return (
    <span className={`tr-badge is-${props.tone}`} title={props.title}>
      {props.children}
    </span>
  );
}

function CandidateCard(props: {
  candidate: CandidateEvaluation;
  rank?: number;
}) {
  const tr = useT();
  const { candidate, rank } = props;
  const pills = useMemo(() => buildBotRuntimePills(candidate, tr), [candidate, tr]);
  const editHref = botDefaultsHref({ bot: candidate.larkAppId, section: 'task-routing' });
  const isExcluded = !candidate.eligible;

  return (
    <article
      className={`tr-bot-card${isExcluded ? ' is-excluded' : ' is-eligible'}${!candidate.participating ? ' is-unopted' : ''}`}
      data-bot-card={candidate.larkAppId}
      data-eligible={candidate.eligible ? 'true' : 'false'}
    >
      <div className="tr-bot-card-head">
        <div className="tr-bot-identity">
          <div className="tr-bot-title-row">
            {rank !== undefined ? <span className="tr-rank">#{rank}</span> : null}
            <strong className="tr-bot-name">{candidate.name}</strong>
          </div>
          <span className="tr-bot-sub">
            {candidate.cliId}
            {candidate.model ? ` · ${candidate.model}` : ''}
          </span>
        </div>
        <div className="tr-bot-head-badges">
          <Badge tone={costTierTone(candidate.costTier)}>{tr(costTierLabelKey(candidate.costTier))}</Badge>
          {candidate.exclusionCode ? (
            <Badge tone={candidate.participating ? 'danger' : 'muted'}>
              {tr(exclusionCodeLabelKey(candidate.exclusionCode))}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="tr-pill-row">
        {pills.map(pill => (
          <span key={pill.id} className={`tr-pill is-${pill.tone}`}>{pill.label}</span>
        ))}
      </div>

      {candidate.exclusionReason ? (
        <p className={`tr-exclusion-reason${candidate.participating ? ' is-warn' : ''}`} data-exclusion-reason>
          {candidate.exclusionReason}
        </p>
      ) : null}

      <div className="tr-profile-body">
        {candidate.strengths ? (
          <div className="tr-profile-line">
            <span className="tr-profile-tag">{tr('taskRouting.strengthsLabel')}</span>
            <p>{candidate.strengths}</p>
          </div>
        ) : null}
        {candidate.limitations ? (
          <div className="tr-profile-line">
            <span className="tr-profile-tag is-limit">{tr('taskRouting.limitationsLabel')}</span>
            <p>{candidate.limitations}</p>
          </div>
        ) : null}
        {!candidate.strengths && !candidate.limitations ? (
          <p className="tr-profile-empty">{tr('taskRouting.noProfileHint')}</p>
        ) : null}
      </div>

      <div className="tr-bot-card-foot">
        <code className="tr-app-id">{candidate.larkAppId}</code>
        <a className="tr-edit-link" href={editHref}>
          {candidate.participating ? tr('taskRouting.editProfile') : tr('taskRouting.configureProfile')} →
        </a>
      </div>
    </article>
  );
}

function RecordCard(props: { record: TaskRoutingRecord; nowMs: number }) {
  const tr = useT();
  const { record, nowMs } = props;
  const fallbackSwitched = hasFallbackSwitch(record);
  const modeLabel = record.mode === 'topic' ? tr('taskRouting.modeTopic') : tr('taskRouting.modeGroup');

  return (
    <article
      className={`tr-record-card${fallbackSwitched ? ' has-fallback' : ''}`}
      data-record-id={record.id}
      data-outcome={record.outcome}
    >
      <div className="tr-record-head">
        <div className="tr-record-badges">
          <Badge tone={outcomeTone(record.outcome)}>{tr(outcomeLabelKey(record.outcome))}</Badge>
          <Badge tone="muted">{modeLabel}</Badge>
          <Badge tone="info">
            {`${tr(matcherKindLabelKey(record.matcherKind))} · ${tr(confidenceLabelKey(record.confidence))}`}
          </Badge>
          <span className="tr-record-caller">{tr(callerKindLabelKey(record.callerKind))}</span>
        </div>
        <time className="tr-record-time" title={new Date(record.createdAt).toLocaleString()}>
          {formatRoutingTime(record.createdAt, nowMs, tr)}
        </time>
      </div>

      <p className="tr-record-task">{record.taskSummary}</p>

      <div className="tr-record-meta">
        {record.selectedName || record.selectedAppId ? (
          <span className="tr-record-selected">
            <strong>{record.selectedName ?? record.selectedAppId}</strong>
          </span>
        ) : null}
        <span className="tr-record-reason">
          <strong>{tr('taskRouting.reasonLabel')}：</strong>
          {record.reason}
        </span>
      </div>

      {record.fallbackFromMatcher ? (
        <p className="tr-record-note">
          {tr('taskRouting.matcherFallbackNote', { detail: record.fallbackFromMatcher })}
        </p>
      ) : null}

      {record.attempts.length > 0 ? (
        <div className="tr-attempts" data-attempts>
          <span className="tr-attempts-label">{tr('taskRouting.attemptsTitle')}</span>
          <ol className="tr-attempt-chain">
            {record.attempts.map((attempt, index) => (
              <li
                key={`${attempt.appId}:${index}`}
                className={`tr-attempt-step is-${attemptOutcomeTone(attempt.outcome)}`}
              >
                <span className="tr-attempt-index">{index + 1}</span>
                <div className="tr-attempt-body">
                  <div className="tr-attempt-top">
                    <strong>{attempt.name || attempt.appId}</strong>
                    <Badge tone={attemptOutcomeTone(attempt.outcome)}>
                      {tr(attemptOutcomeLabelKey(attempt.outcome))}
                    </Badge>
                  </div>
                  <span className="tr-attempt-reason">{attempt.reason}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {record.error ? (
        <p className="tr-record-error">
          <strong>{tr('taskRouting.errorLabel')}：</strong>
          {record.error}
        </p>
      ) : null}

      <div className="tr-record-foot">
        <div className="tr-record-links">
          {record.targetSessionId ? (
            <a className="tr-edit-link" href={sessionDetailHref(record.targetSessionId)}>
              {tr('taskRouting.openSession')} →
            </a>
          ) : null}
          {record.targetChatId ? (
            <span className="tr-record-chat">{tr('taskRouting.targetChat', { chatId: record.targetChatId })}</span>
          ) : null}
        </div>
        {record.excluded.length > 0 ? (
          <details className="tr-excluded-details">
            <summary>{tr('taskRouting.excludedSnapshot', { count: record.excluded.length })}</summary>
            <ul className="tr-excluded-list">
              {record.excluded.map(ex => (
                <li key={ex.larkAppId}>
                  <strong>{ex.name}</strong>
                  {ex.exclusionCode ? (
                    <Badge tone={ex.participating ? 'danger' : 'muted'}>
                      {tr(exclusionCodeLabelKey(ex.exclusionCode))}
                    </Badge>
                  ) : null}
                  <span>{ex.exclusionReason ?? ex.runtimeSummary}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function TaskRoutingPage(props: {
  initialStatus?: TaskRoutingStatusResponse;
  initialHistory?: TaskRoutingHistoryResponse;
  nowMs?: number;
}) {
  const tr = useT();
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<TaskRoutingStatusResponse | null>(props.initialStatus ?? null);
  const [records, setRecords] = useState<TaskRoutingRecord[]>(props.initialHistory?.records ?? []);
  const [loading, setLoading] = useState(!props.initialStatus);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [botFilter, setBotFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<TaskRoutingOutcome | 'all'>('all');

  const [dryRunTask, setDryRunTask] = useState('');
  const [dryRunPrefer, setDryRunPrefer] = useState('');
  const [dryRunExclude, setDryRunExclude] = useState('');
  const [dryRunRuleOnly, setDryRunRuleOnly] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunDecision, setDryRunDecision] = useState<TaskRoutingDecision | null>(null);

  const loadAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);
    try {
      const [statusRes, historyRes] = await Promise.all([
        fetchTaskRoutingStatus(),
        fetchTaskRoutingHistory({ limit: 50 }),
      ]);
      if (!mountedRef.current) return;
      setStatus(statusRes);
      setRecords(historyRes.records);
    } catch (err) {
      if (!mountedRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!props.initialStatus) void loadAll(false);
    return () => { mountedRef.current = false; };
  }, [loadAll, props.initialStatus]);

  const nowMs = props.nowMs ?? Date.now();
  const poolSummary = useMemo(
    () => (status ? summarizeTaskRoutingPool(status) : null),
    [status],
  );
  const sortedExcluded = useMemo(
    () => (status ? sortExcludedCandidates(status.excluded) : []),
    [status],
  );

  const allBots = useMemo(() => {
    const map = new Map<string, string>();
    if (status) {
      for (const c of [...status.eligible, ...status.excluded]) map.set(c.larkAppId, c.name);
    }
    for (const r of records) {
      if (r.selectedAppId && !map.has(r.selectedAppId)) map.set(r.selectedAppId, r.selectedName ?? r.selectedAppId);
      for (const a of r.attempts) {
        if (!map.has(a.appId)) map.set(a.appId, a.name || a.appId);
      }
    }
    return [...map.entries()].map(([larkAppId, name]) => ({ larkAppId, name }));
  }, [records, status]);

  const botFilterOptions = useMemo(() => [
    { value: '', label: tr('taskRouting.filterBotAll') },
    ...allBots.map(bot => ({ value: bot.larkAppId, label: bot.name })),
  ], [allBots, tr]);

  const preferOptions = useMemo(() => [
    { value: '', label: tr('taskRouting.dryRunPreferAny') },
    ...(status?.eligible ?? []).map(bot => ({ value: bot.larkAppId, label: bot.name })),
  ], [status, tr]);

  const excludeOptions = useMemo(() => [
    { value: '', label: tr('taskRouting.dryRunExcludeNone') },
    ...(status?.eligible ?? []).map(bot => ({ value: bot.larkAppId, label: bot.name })),
  ], [status, tr]);

  const filteredRecords = useMemo(
    () => filterTaskRoutingRecords(records, { botAppId: botFilter, outcome: outcomeFilter }),
    [botFilter, outcomeFilter, records],
  );

  const fallbackCount = useMemo(
    () => records.filter(r => r.outcome === 'fallback_dispatched').length,
    [records],
  );
  const failedCount = useMemo(
    () => records.filter(r => r.outcome === 'failed').length,
    [records],
  );

  const nameLookup = useMemo(() => new Map(allBots.map(b => [b.larkAppId, b.name])), [allBots]);

  async function runDryRun(): Promise<void> {
    const task = dryRunTask.trim();
    if (!task || dryRunBusy) return;
    setDryRunBusy(true);
    setDryRunError(null);
    try {
      const res = await requestTaskRoutingRecommend({
        task,
        ...(dryRunPrefer ? { prefer: dryRunPrefer } : {}),
        ...(dryRunExclude ? { exclude: [dryRunExclude] } : {}),
        noLlm: dryRunRuleOnly,
      });
      if (!mountedRef.current) return;
      setDryRunDecision(res.decision);
    } catch (err) {
      if (!mountedRef.current) return;
      setDryRunDecision(null);
      setDryRunError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setDryRunBusy(false);
    }
  }

  const settingsUrl = settingsHref('settings-task-routing');

  if (loading) {
    return (
      <section className="page tr-page">
        <LoadingState label={tr('taskRouting.refreshing')} />
      </section>
    );
  }

  return (
    <section className="page tr-page" data-task-routing-page>
      <header className="tr-header">
        <div className="tr-header-copy">
          <h1>{tr('taskRouting.title')}</h1>
          <p>{tr('taskRouting.subtitle')}</p>
        </div>
        <div className="tr-header-actions">
          <button
            type="button"
            className="secondary"
            disabled={refreshing}
            onClick={() => { void loadAll(true); }}
          >
            {refreshing ? tr('taskRouting.refreshing') : tr('taskRouting.refresh')}
          </button>
          <a className="tr-settings-btn" href={settingsUrl}>{tr('taskRouting.openSettings')}</a>
        </div>
      </header>

      {loadError ? (
        <div className="tr-banner is-error" role="alert">
          {tr('taskRouting.loadError', { error: loadError })}
        </div>
      ) : null}

      {status && !status.enabled ? (
        <section className="panel tr-disabled-panel" data-task-routing-disabled>
          <h2>{tr('taskRouting.disabledTitle')}</h2>
          <p>{tr('taskRouting.disabledBody')}</p>
          <a className="tr-primary-link" href={settingsUrl}>{tr('taskRouting.disabledAction')} →</a>
        </section>
      ) : null}

      {status && status.enabled && poolSummary ? (
        <>
          <div className="tr-kpi-grid">
            <div className="panel tr-kpi-card">
              <span className="tr-kpi-label">{tr('taskRouting.kpiEligible')}</span>
              <strong className="tr-kpi-value">{poolSummary.eligibleCount}</strong>
              <small>{tr('taskRouting.kpiEligibleSub', { idle: poolSummary.idleCount, busy: poolSummary.busyCount })}</small>
            </div>
            <div className="panel tr-kpi-card">
              <span className="tr-kpi-label">{tr('taskRouting.kpiExcluded')}</span>
              <strong className="tr-kpi-value">{poolSummary.excludedCount}</strong>
              <small>{tr('taskRouting.kpiExcludedSub', { participating: poolSummary.participatingExcludedCount, unopted: poolSummary.nonParticipatingCount })}</small>
            </div>
            <div className="panel tr-kpi-card">
              <span className="tr-kpi-label">{tr('taskRouting.kpiMatcher')}</span>
              <strong className="tr-kpi-value tr-kpi-value-sm">
                {status.matcherMode === 'bot' ? tr('taskRouting.kpiMatcherBot') : tr('taskRouting.kpiMatcherRule')}
              </strong>
              <small>
                {status.matcherMode === 'bot'
                  ? `${status.matcherBotName || status.matcherBotAppId || '—'} · ${tr('taskRouting.kpiMatcherTimeout', { sec: Math.round(status.matcherTimeoutMs / 1_000) })}`
                  : tr('settings.taskRoutingMatcherModeRule')}
              </small>
            </div>
            <div className="panel tr-kpi-card">
              <span className="tr-kpi-label">{tr('taskRouting.kpiHistory')}</span>
              <strong className="tr-kpi-value">{records.length}</strong>
              <small>{tr('taskRouting.kpiHistorySub', { fallback: fallbackCount, failed: failedCount })}</small>
            </div>
          </div>

          {status.policy ? (
            <div className="tr-policy-banner" data-policy-banner>
              <strong>{tr('taskRouting.policyBannerTitle')}</strong>
              <p>{status.policy}</p>
            </div>
          ) : null}

          <section className="panel tr-section" data-bots-section>
            <div className="tr-section-head">
              <h2>{tr('taskRouting.sectionBots')}</h2>
            </div>

            <div className="tr-subsection">
              <h3>{tr('taskRouting.eligibleGroupTitle')}</h3>
              {status.eligible.length === 0 ? (
                <p className="tr-empty">{tr('taskRouting.eligibleEmpty')}</p>
              ) : (
                <div className="tr-bot-grid">
                  {status.eligible.map((candidate, index) => (
                    <CandidateCard key={candidate.larkAppId} candidate={candidate} rank={index + 1} />
                  ))}
                </div>
              )}
            </div>

            <div className="tr-subsection">
              <h3>{tr('taskRouting.excludedGroupTitle')}</h3>
              {sortedExcluded.length === 0 ? (
                <p className="tr-empty">{tr('taskRouting.excludedEmpty')}</p>
              ) : (
                <div className="tr-bot-grid">
                  {sortedExcluded.map(candidate => (
                    <CandidateCard key={candidate.larkAppId} candidate={candidate} />
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="panel tr-section" data-history-section>
            <div className="tr-section-head tr-history-head">
              <h2>{tr('taskRouting.sectionHistory')}</h2>
              <div className="tr-history-filters">
                <DropdownMenu
                  ariaLabel={tr('taskRouting.filterBotAll')}
                  value={botFilter}
                  label={dropdownLabel(botFilterOptions, botFilter)}
                  options={botFilterOptions}
                  onChange={setBotFilter}
                />
                <div className="tr-filter-pills" role="group" aria-label={tr('taskRouting.filterOutcomeAll')}>
                  {OUTCOME_FILTERS.map(outcome => (
                    <button
                      key={outcome}
                      type="button"
                      data-outcome-filter={outcome}
                      className={`tr-filter-pill${outcomeFilter === outcome ? ' is-active' : ''}`}
                      onClick={() => setOutcomeFilter(outcome)}
                    >
                      {outcome === 'all' ? tr('taskRouting.filterOutcomeAll') : tr(outcomeLabelKey(outcome))}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {records.length === 0 ? (
              <p className="tr-empty">{tr('taskRouting.historyEmpty')}</p>
            ) : filteredRecords.length === 0 ? (
              <p className="tr-empty">{tr('taskRouting.historyFilterEmpty')}</p>
            ) : (
              <div className="tr-record-list">
                {filteredRecords.map(record => (
                  <RecordCard key={record.id} record={record} nowMs={nowMs} />
                ))}
              </div>
            )}
          </section>

          <section className="panel tr-section" data-dry-run-section>
            <div className="tr-section-head">
              <h2>{tr('taskRouting.sectionDryRun')}</h2>
              <span className="tr-section-hint">{tr('taskRouting.dryRunHint')}</span>
            </div>
            <div className="tr-dryrun-form">
              <textarea
                className="tr-dryrun-input"
                data-input="dry-run-task"
                rows={2}
                value={dryRunTask}
                placeholder={tr('taskRouting.dryRunTaskPlaceholder')}
                onChange={e => setDryRunTask(e.currentTarget.value)}
              />
              <div className="tr-dryrun-controls">
                <div className="tr-dryrun-field">
                  <span>{tr('taskRouting.dryRunPrefer')}</span>
                  <DropdownMenu
                    ariaLabel={tr('taskRouting.dryRunPrefer')}
                    value={dryRunPrefer}
                    label={dropdownLabel(preferOptions, dryRunPrefer)}
                    options={preferOptions}
                    onChange={setDryRunPrefer}
                  />
                </div>
                <div className="tr-dryrun-field">
                  <span>{tr('taskRouting.dryRunExclude')}</span>
                  <DropdownMenu
                    ariaLabel={tr('taskRouting.dryRunExclude')}
                    value={dryRunExclude}
                    label={dropdownLabel(excludeOptions, dryRunExclude)}
                    options={excludeOptions}
                    onChange={setDryRunExclude}
                  />
                </div>
                <label className="tr-dryrun-check">
                  <input
                    type="checkbox"
                    checked={dryRunRuleOnly}
                    onChange={e => setDryRunRuleOnly(e.currentTarget.checked)}
                  />
                  <span>{tr('taskRouting.dryRunRuleOnly')}</span>
                </label>
                <button
                  type="button"
                  className="primary"
                  data-action="dry-run-submit"
                  disabled={dryRunBusy || !dryRunTask.trim()}
                  onClick={() => { void runDryRun(); }}
                >
                  {dryRunBusy ? tr('taskRouting.dryRunRunning') : tr('taskRouting.dryRunSubmit')}
                </button>
              </div>
            </div>

            {dryRunError ? <p className="tr-record-error">{dryRunError}</p> : null}

            {dryRunDecision ? (
              <div className="tr-dryrun-result" data-dry-run-result>
                <div className="tr-dryrun-result-head">
                  <strong>
                    {dryRunDecision.selectedAppId
                      ? `${tr('taskRouting.dryRunSelected')}：${dryRunDecision.selectedName ?? dryRunDecision.selectedAppId}`
                      : tr('taskRouting.dryRunNone')}
                  </strong>
                  <Badge tone="info">
                    {`${tr(matcherKindLabelKey(dryRunDecision.matcherKind))} · ${tr(confidenceLabelKey(dryRunDecision.confidence))}`}
                  </Badge>
                </div>
                <p className="tr-dryrun-reason">{dryRunDecision.reason}</p>
                {dryRunDecision.fallbackOrder.length > 0 ? (
                  <p className="tr-dryrun-chain">
                    <span>{tr('taskRouting.dryRunFallbackChain')}：</span>
                    {dryRunDecision.fallbackOrder
                      .map((appId, idx) => `#${idx + 1} ${nameLookup.get(appId) ?? appId}`)
                      .join(' → ')}
                  </p>
                ) : null}
                {dryRunDecision.excluded.length > 0 ? (
                  <p className="tr-dryrun-excluded-summary">
                    {tr('taskRouting.dryRunExcludedCount', { count: dryRunDecision.excluded.length })}：
                    {dryRunDecision.excluded
                      .map(ex => `${ex.name}（${ex.exclusionCode ? tr(exclusionCodeLabelKey(ex.exclusionCode)) : ex.exclusionReason ?? ''}）`)
                      .join('、')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  );
}

export function renderTaskRoutingPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <TaskRoutingPage />);
}
