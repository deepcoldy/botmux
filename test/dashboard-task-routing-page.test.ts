import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { TaskRoutingSettingsEditor } from '../src/dashboard/web/settings-page.js';
import { TaskRoutingSection } from '../src/dashboard/web/bot-defaults-page.js';
import { TaskRoutingPage } from '../src/dashboard/web/task-routing-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';
import type { CandidateEvaluation, TaskRoutingRecord } from '../src/core/task-routing/model.js';
import {
  buildBotRuntimePills,
  filterTaskRoutingRecords,
  sortExcludedCandidates,
  summarizeTaskRoutingPool,
  type TaskRoutingHistoryResponse,
  type TaskRoutingStatusResponse,
} from '../src/dashboard/web/task-routing-model.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); });

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => (typeof child === 'string' ? child : nodeText(child))).join('');
}

function makeCandidate(overrides: Partial<CandidateEvaluation>): CandidateEvaluation {
  return {
    larkAppId: overrides.larkAppId ?? 'cli_a',
    name: overrides.name ?? 'BotA',
    cliId: overrides.cliId ?? 'claude-code',
    model: overrides.model,
    costTier: overrides.costTier ?? 'low',
    participating: overrides.participating ?? true,
    eligible: overrides.eligible ?? true,
    exclusionCode: overrides.exclusionCode,
    exclusionReason: overrides.exclusionReason,
    runtimeSummary: overrides.runtimeSummary ?? '空闲',
    strengths: overrides.strengths,
    limitations: overrides.limitations,
    runtime: overrides.runtime ?? {
      online: true,
      probeStatus: 'ok',
      larkConnected: true,
      workingCount: 0,
      queuedCount: 0,
      residentCount: 1,
      maxLiveWorkers: 8,
      limitedCount: 0,
    },
  };
}

function sampleStatus(): TaskRoutingStatusResponse {
  return {
    ok: true,
    enabled: true,
    matcherMode: 'bot',
    matcherBotAppId: 'cli_econ',
    matcherBotName: 'EconomyBot',
    matcherTimeoutMs: 15_000,
    policy: '简单修改用经济档，复杂重构用旗舰档，拿不准优先便宜空闲的。',
    eligible: [
      makeCandidate({
        larkAppId: 'cli_econ',
        name: 'EconomyBot',
        model: 'kimi-k2',
        costTier: 'low',
        strengths: '日常改文案、小修 bug、补单测，速度快',
        limitations: '不适合跨模块深度重构',
      }),
      makeCandidate({
        larkAppId: 'cli_flagship',
        name: 'FlagshipBot',
        model: 'claude-opus',
        costTier: 'high',
        strengths: '复杂架构重构与根因定位',
        limitations: '成本高，非必要不用于琐碎改动',
        runtime: {
          online: true,
          probeStatus: 'ok',
          larkConnected: true,
          workingCount: 1,
          queuedCount: 0,
          residentCount: 2,
          maxLiveWorkers: 6,
          limitedCount: 0,
          budget: { monthlyCny: 2000, spentCny: 640, percent: 32, hardStop: false, exceeded: false },
        },
      }),
    ],
    excluded: [
      makeCandidate({
        larkAppId: 'cli_steward',
        name: 'StewardBot',
        costTier: 'medium',
        participating: false,
        eligible: false,
        exclusionCode: 'steward_bot',
        exclusionReason: '管家 Bot 不参与自动任务分配',
      }),
      makeCandidate({
        larkAppId: 'cli_agy',
        name: 'AgyWorker',
        cliId: 'antigravity',
        costTier: 'medium',
        participating: true,
        eligible: false,
        exclusionCode: 'quota_exhausted',
        exclusionReason: 'agy 多账号额度已全部耗尽（0/3 可用，预计 25分钟后恢复）',
        runtime: {
          online: true,
          probeStatus: 'ok',
          larkConnected: true,
          workingCount: 0,
          queuedCount: 0,
          residentCount: 0,
          maxLiveWorkers: 6,
          limitedCount: 0,
          agyAccounts: { managed: true, availableCount: 0, enabledCount: 3, earliestRecoveryMs: 1_500_000 },
        },
      }),
    ],
  };
}

function sampleHistory(): TaskRoutingHistoryResponse {
  const rec1: TaskRoutingRecord = {
    id: 'tr_1',
    createdAt: 1_760_000_100_000,
    updatedAt: 1_760_000_105_000,
    mode: 'group',
    taskSummary: '重构鉴权链路并补全集成测试',
    callerKind: 'steward_session',
    constraints: {},
    selectedAppId: 'cli_flagship',
    selectedName: 'FlagshipBot',
    matcherKind: 'bot',
    confidence: 'high',
    reason: '涉及多模块安全边界改造，首选 AgyWorker 额度耗尽，自动兜底到 FlagshipBot',
    candidates: [],
    excluded: [
      makeCandidate({
        larkAppId: 'cli_agy',
        name: 'AgyWorker',
        eligible: false,
        participating: true,
        exclusionCode: 'quota_exhausted',
        exclusionReason: 'agy 账号 0/3 可用',
      }),
    ],
    attempts: [
      { appId: 'cli_agy', name: 'AgyWorker', outcome: 'skipped', reason: '派发前复检跳过：额度耗尽（0/3 可用）', at: 1_760_000_101_000 },
      { appId: 'cli_flagship', name: 'FlagshipBot', outcome: 'dispatched', reason: '已建任务群并投递任务', at: 1_760_000_104_000, chatId: 'oc_group_1', sessionId: 'sess_flag_1' },
    ],
    outcome: 'fallback_dispatched',
    targetChatId: 'oc_group_1',
    targetSessionId: 'sess_flag_1',
  };
  const rec2: TaskRoutingRecord = {
    id: 'tr_2',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_002_000,
    mode: 'group',
    taskSummary: '修复登录页按钮错别字',
    callerKind: 'host_cli',
    constraints: {},
    selectedAppId: 'cli_econ',
    selectedName: 'EconomyBot',
    matcherKind: 'rule',
    confidence: 'high',
    reason: '简单文案改动，经济档且当前空闲',
    candidates: [],
    excluded: [],
    attempts: [
      { appId: 'cli_econ', name: 'EconomyBot', outcome: 'dispatched', reason: '已建任务群并投递任务', at: 1_760_000_001_000, chatId: 'oc_group_2', sessionId: 'sess_econ_2' },
    ],
    outcome: 'dispatched',
    targetChatId: 'oc_group_2',
    targetSessionId: 'sess_econ_2',
  };
  return { ok: true, enabled: true, records: [rec1, rec2] };
}

describe('TaskRoutingSettingsEditor', () => {
  it('edits policy, offers only rule/bot matchers (never http/apiKey), and commits bot matcher + timeout', async () => {
    const onSave = vi.fn();
    let view!: TestRenderer.ReactTestRenderer;
    act(() => {
      view = TestRenderer.create(React.createElement(TaskRoutingSettingsEditor, {
        value: {
          enabled: true,
          policy: '旧原则',
          matcher: { mode: 'rule' },
          botOptions: [
            { larkAppId: 'cli_judge', botName: 'JudgeBot', cliId: 'claude-code', online: true, oneShotAllowed: true },
            { larkAppId: 'cli_sandboxed', botName: 'SandboxedBot', cliId: 'codex', online: true, oneShotAllowed: false },
          ],
        },
        disabled: false,
        saving: false,
        onSave,
      }));
    });

    // Policy save
    const policyInput = view.root.findByProps({ 'data-input': 'task-routing-policy' });
    const savePolicyBtn = view.root.findByProps({ 'data-action': 'save-task-routing-policy' });
    expect(savePolicyBtn.props.disabled).toBe(true);
    act(() => { policyInput.props.onChange({ currentTarget: { value: '简单活走经济档' } }); });
    expect(view.root.findByProps({ 'data-action': 'save-task-routing-policy' }).props.disabled).toBe(false);
    act(() => { view.root.findByProps({ 'data-action': 'save-task-routing-policy' }).props.onClick(); });
    expect(onSave).toHaveBeenCalledWith({ policy: '简单活走经济档' }, expect.any(Function));

    // Matcher mode menu strictly allows only rule and bot (no http, no apiKey)
    const zh = createDashboardTranslator('zh');
    const modeMenu = view.root.findByProps({ ariaLabel: zh('settings.taskRoutingMatcherMode') });
    expect(modeMenu.props.options.map((o: any) => o.value)).toEqual(['rule', 'bot']);

    // Switching to bot mode opens bot picker + timeout input; picking bot persists matcher config
    act(() => { modeMenu.props.onChange('bot'); });
    const botMenu = view.root.findByProps({ ariaLabel: zh('settings.taskRoutingMatcherBot') });
    act(() => { botMenu.props.onChange('cli_judge'); });
    expect(onSave).toHaveBeenLastCalledWith(
      { matcher: { mode: 'bot', botAppId: 'cli_judge', timeoutMs: 15_000 } },
      expect.any(Function),
    );

    // Adjusting timeout commits integer seconds * 1000
    const timeoutInput = view.root.findByProps({ 'data-input': 'task-routing-timeout' });
    act(() => { timeoutInput.props.onChange({ currentTarget: { value: '25' } }); });
    act(() => { view.root.findByProps({ 'data-input': 'task-routing-timeout' }).props.onBlur(); });
    expect(onSave).toHaveBeenLastCalledWith(
      { matcher: { mode: 'bot', botAppId: 'cli_judge', timeoutMs: 25_000 } },
      expect.any(Function),
    );

    // Clearing the bot is a real rule-mode save, not a draft-only fake fallback.
    act(() => { botMenu.props.onChange(''); });
    expect(onSave).toHaveBeenLastCalledWith(
      { matcher: { mode: 'rule' } },
      expect.any(Function),
    );
    const [, optimisticClear] = onSave.mock.calls.at(-1)! as unknown as [
      unknown,
      (current: { enabled: boolean; matcher: unknown }) => { enabled: boolean; matcher: unknown },
    ];
    expect(optimisticClear({
      enabled: true,
      matcher: { mode: 'bot', botAppId: 'cli_judge', timeoutMs: 25_000 },
    }).matcher).toEqual({ mode: 'rule' });
    expect(modeMenu.props.value).toBe('rule');
    expect(view.root.findAllByProps({ ariaLabel: zh('settings.taskRoutingMatcherBot') })).toHaveLength(0);

    act(() => view.unmount());
  });
});

describe('Bot Config TaskRoutingSection profile editor', () => {
  it('saves costTier, strengths, and limitations without disturbing toggle semantics', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        taskRouting: {
          enabled: true,
          costTier: 'high',
          strengths: '复杂架构设计',
          limitations: '成本偏高',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const patchBot = vi.fn();
    let view!: TestRenderer.ReactTestRenderer;
    const row = {
      larkAppId: 'cli_worker',
      taskRouting: { enabled: true, costTier: 'low' as const, strengths: '小修' },
    } as BotDefaultsRow;

    act(() => {
      view = TestRenderer.create(React.createElement(TaskRoutingSection, { bot: row, patchBot }));
    });

    expect(view.root.findByProps({ 'data-action': 'save-task-routing-profile' }).props.disabled).toBe(true);
    act(() => { view.root.findByProps({ 'data-tier': 'high' }).props.onClick(); });
    act(() => { view.root.findByProps({ 'data-input': 'task-routing-strengths' }).props.onChange({ currentTarget: { value: '复杂架构设计' } }); });
    act(() => { view.root.findByProps({ 'data-input': 'task-routing-limitations' }).props.onChange({ currentTarget: { value: '成本偏高' } }); });

    await act(async () => {
      view.root.findByProps({ 'data-action': 'save-task-routing-profile' }).props.onClick();
    });

    expect(fetcher).toHaveBeenCalledWith('/api/bots/cli_worker/task-routing', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        taskRouting: {
          enabled: true,
          costTier: 'high',
          strengths: '复杂架构设计',
          limitations: '成本偏高',
        },
      }),
    }));
    expect(patchBot).toHaveBeenCalledWith('cli_worker', {
      taskRouting: {
        enabled: true,
        costTier: 'high',
        strengths: '复杂架构设计',
        limitations: '成本偏高',
      },
    });
    act(() => view.unmount());
  });

  it('hides profile controls for steward and apiOnly bots', () => {
    for (const bot of [{ apiOnly: true }, { steward: { enabled: true } }]) {
      let view!: TestRenderer.ReactTestRenderer;
      act(() => {
        view = TestRenderer.create(React.createElement(TaskRoutingSection, {
          bot: { larkAppId: 'cli_x', ...bot } as BotDefaultsRow,
          patchBot: vi.fn(),
        }));
      });
      expect(view.root.findAllByProps({ 'data-action': 'save-task-routing-profile' })).toHaveLength(0);
      act(() => view.unmount());
    }
  });
});

describe('TaskRoutingPage (#/assign) and view-model', () => {
  it('renders disabled notice when globally OFF and hides bot pool & history', () => {
    let view!: TestRenderer.ReactTestRenderer;
    act(() => {
      view = TestRenderer.create(React.createElement(TaskRoutingPage, {
        initialStatus: {
          ok: true,
          enabled: false,
          matcherMode: 'rule',
          matcherBotAppId: null,
          matcherTimeoutMs: 15_000,
          policy: '',
          eligible: [],
          excluded: [],
        },
        initialHistory: { ok: true, enabled: false, records: [] },
      }));
    });
    expect(view.root.findAllByProps({ 'data-task-routing-disabled': true })).toHaveLength(1);
    expect(view.root.findAllByProps({ 'data-bots-section': true })).toHaveLength(0);
    expect(view.root.findAllByProps({ 'data-history-section': true })).toHaveLength(0);
    act(() => view.unmount());
  });

  it('renders eligible/excluded cards, fallback attempt chain, outcome filtering, and dry-run result', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/task-routing/recommend') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            constraints: {},
            decision: {
              selectedAppId: 'cli_flagship',
              selectedName: 'FlagshipBot',
              fallbackOrder: ['cli_flagship', 'cli_econ'],
              matcherKind: 'bot',
              confidence: 'high',
              reason: '需要深度跨模块重构，FlagshipBot 更稳妥',
              candidates: sampleStatus().eligible,
              excluded: sampleStatus().excluded,
            },
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    let view!: TestRenderer.ReactTestRenderer;
    act(() => {
      view = TestRenderer.create(React.createElement(TaskRoutingPage, {
        initialStatus: sampleStatus(),
        initialHistory: sampleHistory(),
        nowMs: 1_760_000_200_000,
      }));
    });

    // Eligible + excluded cards rendered with explicit exclusion reasons
    expect(view.root.findByProps({ 'data-bot-card': 'cli_econ' }).props['data-eligible']).toBe('true');
    const agyCard = view.root.findByProps({ 'data-bot-card': 'cli_agy' });
    expect(agyCard.props['data-eligible']).toBe('false');
    expect(nodeText(agyCard.findByProps({ 'data-exclusion-reason': true }))).toContain('0/3');

    // Participating-but-unavailable bots appear ahead of opted-out bots
    const excludedOrder = sortExcludedCandidates(sampleStatus().excluded).map(c => c.larkAppId);
    expect(excludedOrder).toEqual(['cli_agy', 'cli_steward']);

    // History shows both records and multi-step fallback attempt timeline
    expect(view.root.findAll(n => typeof n.props['data-record-id'] === 'string')).toHaveLength(2);
    const fallbackRec = view.root.findByProps({ 'data-record-id': 'tr_1' });
    expect(fallbackRec.findByProps({ 'data-attempts': true }).findAllByType('li')).toHaveLength(2);

    // Filter by fallback_dispatched narrows to tr_1 only
    act(() => { view.root.findByProps({ 'data-outcome-filter': 'fallback_dispatched' }).props.onClick(); });
    expect(view.root.findAll(n => typeof n.props['data-record-id'] === 'string').map(n => n.props['data-record-id'])).toEqual(['tr_1']);

    // Dry-run recommend calls POST /api/task-routing/recommend and displays decision
    act(() => { view.root.findByProps({ 'data-input': 'dry-run-task' }).props.onChange({ currentTarget: { value: '重构核心状态机' } }); });
    await act(async () => {
      view.root.findByProps({ 'data-action': 'dry-run-submit' }).props.onClick();
    });
    const resultBox = view.root.findByProps({ 'data-dry-run-result': true });
    expect(nodeText(resultBox)).toContain('FlagshipBot');
    expect(nodeText(resultBox)).toContain('深度跨模块重构');

    act(() => view.unmount());
  });

  it('summarizes pool metrics, builds runtime pills, filters records, and translates all keys in zh & en', () => {
    const status = sampleStatus();
    const summary = summarizeTaskRoutingPool(status);
    expect(summary).toEqual({
      eligibleCount: 2,
      idleCount: 1,
      busyCount: 1,
      excludedCount: 2,
      participatingExcludedCount: 1,
      nonParticipatingCount: 1,
    });

    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');
    const agyPills = buildBotRuntimePills(status.excluded[1]!, zh);
    expect(agyPills.some(p => p.id === 'agy' && p.tone === 'danger')).toBe(true);

    const filtered = filterTaskRoutingRecords(sampleHistory().records, { botAppId: 'cli_agy' });
    expect(filtered.map(r => r.id)).toEqual(['tr_1']);

    const requiredKeys = [
      'nav.taskRouting',
      'settings.sectionTaskRouting',
      'settings.taskRoutingEnable',
      'settings.taskRoutingPolicy',
      'settings.taskRoutingMatcherMode',
      'settings.taskRoutingMatcherBot',
      'settings.taskRoutingMatcherTimeout',
      'botDefaults.sectionTaskRouting',
      'botDefaults.taskRoutingEnabled',
      'botDefaults.taskRoutingCostTier',
      'botDefaults.taskRoutingStrengths',
      'botDefaults.taskRoutingLimitations',
      'taskRouting.title',
      'taskRouting.disabledTitle',
      'taskRouting.exQuotaExhausted',
      'taskRouting.outcomeFallback',
    ];
    for (const key of requiredKeys) {
      expect(zh(key), `zh missing ${key}`).not.toBe(key);
      expect(en(key), `en missing ${key}`).not.toBe(key);
    }
  });
});
