/**
 * handleCardAction 分发表与敏感动作元数据（src/im/lark/card-action-routes.ts）。
 *
 * 这些表替换了 card-handler.ts 里逐字同构的 if 块，行为必须与原 if 链一致：
 * - 前缀路由：命中即转交，参数形态 (data, larkAppId, { createClient, locale }) 不变；
 *   缺 larkAppId 不命中；前缀互不为前缀（所以顺序无关）。
 * - v3 路由：谓词按固定顺序试；deps 未接线静默返回 undefined。
 * - 敏感动作：清单逐项钉死（漏登记 = 任何人都能点），拒绝 toast 与 pendingRepo 例外各自成表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_PREFIX_ROUTES,
  SENSITIVE_CARD_ACTIONS,
  V3_CARD_ROUTES,
  findCardPrefixRoute,
  findV3CardRoute,
  sensitiveCardActionMeta,
} from '../src/im/lark/card-action-routes.js';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  sessions: vi.fn(),
  groupSessions: vi.fn(),
  schedules: vi.fn(),
  groups: vi.fn(),
  overview: vi.fn(),
  issue: vi.fn(),
  issueDeps: { marker: 'issue-deps' },
  createDaemonClientFor: vi.fn((appId: string) => ({ client: appId })),
  v3: {
    gate: vi.fn(), blocked: vi.fn(), revisit: vi.fn(), loop: vi.fn(), runSave: vi.fn(), distill: vi.fn(),
  },
}));

vi.mock('../src/im/lark/settings-card.js', async (orig) => ({ ...(await orig<object>()), handleSettingsCardAction: mocks.settings }));
vi.mock('../src/im/lark/sessions-card.js', async (orig) => ({ ...(await orig<object>()), handleSessionsCardAction: mocks.sessions }));
vi.mock('../src/im/lark/group-sessions-card.js', async (orig) => ({ ...(await orig<object>()), handleGroupSessionsCardAction: mocks.groupSessions }));
vi.mock('../src/im/lark/schedules-card.js', async (orig) => ({ ...(await orig<object>()), handleSchedulesCardAction: mocks.schedules }));
vi.mock('../src/im/lark/groups-card.js', async (orig) => ({ ...(await orig<object>()), handleGroupsCardAction: mocks.groups }));
vi.mock('../src/im/lark/overview-card.js', async (orig) => ({ ...(await orig<object>()), handleOverviewCardAction: mocks.overview }));
vi.mock('../src/im/lark/issue-command.js', async (orig) => ({ ...(await orig<object>()), handleIssueCardAction: mocks.issue }));
vi.mock('../src/im/lark/issue-command-deps.js', async (orig) => ({ ...(await orig<object>()), buildIssueCommandDeps: () => mocks.issueDeps }));
vi.mock('../src/daemon-internal-client-wrapper.js', async (orig) => ({ ...(await orig<object>()), createDaemonClientFor: mocks.createDaemonClientFor }));
vi.mock('../src/im/lark/v3-gate-card-handler.js', async (orig) => ({ ...(await orig<object>()), handleV3GateAction: mocks.v3.gate }));
vi.mock('../src/im/lark/v3-blocked-card-handler.js', async (orig) => ({ ...(await orig<object>()), handleV3BlockedAction: mocks.v3.blocked }));
vi.mock('../src/im/lark/v3-revisit-grant-card-handler.js', async (orig) => ({ ...(await orig<object>()), handleV3RevisitGrantAction: mocks.v3.revisit }));
vi.mock('../src/im/lark/v3-loop-grant-card-handler.js', async (orig) => ({ ...(await orig<object>()), handleV3LoopGrantAction: mocks.v3.loop }));
vi.mock('../src/im/lark/v3-run-save-card-handler.js', async (orig) => ({ ...(await orig<object>()), handleV3RunSaveAction: mocks.v3.runSave }));
vi.mock('../src/im/lark/v3-distillation-card-handler.js', async (orig) => ({ ...(await orig<object>()), handleV3DistillationAction: mocks.v3.distill }));

import { handleCardAction } from '../src/im/lark/card-handler.js';

const baseDeps = (extra: Record<string, unknown> = {}): any => ({
  activeSessions: new Map(),
  sessionReply: vi.fn(async () => 'mid'),
  lastRepoScan: new Map(),
  ...extra,
});
const clickData = (action: string, extra: Record<string, unknown> = {}): any => ({
  operator: { open_id: 'ou_x' },
  open_message_id: 'om_card',
  action: { value: { action }, form_value: { f: 1 }, ...extra },
});

beforeEach(() => {
  for (const m of [mocks.settings, mocks.sessions, mocks.groupSessions, mocks.schedules, mocks.groups, mocks.overview, mocks.issue,
    ...Object.values(mocks.v3), mocks.createDaemonClientFor]) m.mockClear();
});

describe('前缀路由表', () => {
  it('表序与前缀逐项钉死', () => {
    expect(CARD_PREFIX_ROUTES.map(r => r.prefix)).toEqual([
      'dash_settings_', 'dash_sessions_', 'group_sessions_', 'dash_schedules_', 'dash_groups_', 'issue_', 'dash_overview_',
    ]);
  });

  it('前缀两两互不为前缀——「先匹配先处理」与表序无关', () => {
    for (const a of CARD_PREFIX_ROUTES) {
      for (const b of CARD_PREFIX_ROUTES) {
        if (a !== b) expect(b.prefix.startsWith(a.prefix), `${a.prefix} 是 ${b.prefix} 的前缀`).toBe(false);
      }
    }
  });

  it('findCardPrefixRoute：缺 larkAppId / 非字符串 action 一律不命中', () => {
    expect(findCardPrefixRoute('dash_settings_open', undefined)).toBeUndefined();
    expect(findCardPrefixRoute('dash_settings_open', '')).toBeUndefined();
    expect(findCardPrefixRoute(undefined, 'cli_a')).toBeUndefined();
    expect(findCardPrefixRoute(42, 'cli_a')).toBeUndefined();
    expect(findCardPrefixRoute('dash_unknown_x', 'cli_a')).toBeUndefined();
    expect(findCardPrefixRoute('dash_settings', 'cli_a')).toBeUndefined(); // 缺尾下划线
    expect(findCardPrefixRoute('dash_settings_open', 'cli_a')?.prefix).toBe('dash_settings_');
  });

  const dashCases: Array<[string, () => ReturnType<typeof vi.fn>]> = [
    ['dash_settings_open', () => mocks.settings],
    ['dash_sessions_page', () => mocks.sessions],
    ['group_sessions_page', () => mocks.groupSessions],
    ['dash_schedules_toggle', () => mocks.schedules],
    ['dash_groups_page', () => mocks.groups],
    ['dash_overview_goto', () => mocks.overview],
  ];
  it.each(dashCases)('%s → 对应 handler，参数为 (data, larkAppId, { createClient, locale })，返回值原样透传', async (action, pick) => {
    const handler = pick();
    handler.mockResolvedValueOnce({ card: { ok: action } });
    const data = clickData(action);
    const out = await handleCardAction(data, baseDeps(), 'cli_app');
    expect(out).toEqual({ card: { ok: action } });
    expect(handler).toHaveBeenCalledTimes(1);
    const [gotData, gotAppId, gotDeps] = handler.mock.calls[0]!;
    expect(gotData).toBe(data);
    expect(gotAppId).toBe('cli_app');
    expect(Object.keys(gotDeps).sort()).toEqual(['createClient', 'locale']);
    expect(typeof gotDeps.locale).toBe('string');
    expect(gotDeps.createClient('cli_other')).toEqual({ client: 'cli_other' });
    expect(mocks.createDaemonClientFor).toHaveBeenCalledWith('cli_other');
    // 其余 handler 一个都不该被碰
    for (const [, other] of dashCases) if (other() !== handler) expect(other()).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('issue_ → handleIssueCardAction(data, larkAppId, buildIssueCommandDeps())', async () => {
    mocks.issue.mockResolvedValueOnce({ toast: 'issue' });
    const data = clickData('issue_refresh');
    expect(await handleCardAction(data, baseDeps(), 'cli_app')).toEqual({ toast: 'issue' });
    expect(mocks.issue).toHaveBeenCalledWith(data, 'cli_app', mocks.issueDeps);
  });

  it.each(['dash_settings_open', 'dash_overview_goto', 'issue_refresh'])('%s 缺 larkAppId 时不转交（落空继续往下走）', async (action) => {
    await handleCardAction(clickData(action), baseDeps(), undefined).catch(() => undefined);
    for (const m of [mocks.settings, mocks.overview, mocks.issue]) expect(m).not.toHaveBeenCalled();
  });
});

describe('v3 路由表', () => {
  it('表序钉死：gate → blocked → revisitGrant → loopGrant → runSave → distillation', () => {
    expect(V3_CARD_ROUTES.map(r => r.name)).toEqual(['gate', 'blocked', 'revisitGrant', 'loopGrant', 'runSave', 'distillation']);
  });

  const v3Cases: Array<[string, string, () => ReturnType<typeof vi.fn>, string]> = [
    ['gate', 'v3_gate_approve', () => mocks.v3.gate, 'v3GateDeps'],
    ['blocked', 'v3_blocked_retry', () => mocks.v3.blocked, 'v3BlockedDeps'],
    ['blocked', 'v3_blocked_ask_answer', () => mocks.v3.blocked, 'v3BlockedDeps'],
    ['revisitGrant', 'v3_revisit_grant', () => mocks.v3.revisit, 'v3RevisitGrantDeps'],
    ['loopGrant', 'v3_loop_grant', () => mocks.v3.loop, 'v3LoopGrantDeps'],
    ['runSave', 'v3_run_save', () => mocks.v3.runSave, 'v3RunSaveDeps'],
    ['distillation', 'v3_distill_accept', () => mocks.v3.distill, 'v3DistillationDeps'],
  ];

  it.each(v3Cases)('%s: %s 命中对应路由', (name, action) => {
    expect(findV3CardRoute(action)?.name).toBe(name);
  });

  it('非 v3 action / 非字符串 / 空不命中', () => {
    for (const a of ['restart', 'v3_nope', '', undefined, null, 7]) expect(findV3CardRoute(a)).toBeUndefined();
  });

  it.each(v3Cases)('%s/%s：deps 已接线 → 按原参数形态调用并透传返回值', async (name, action, pick, depsKey) => {
    const handler = pick();
    handler.mockResolvedValueOnce({ toast: name });
    const deps = baseDeps({ [depsKey]: { marker: depsKey } });
    const data = clickData(action);
    const out = await handleCardAction(data, deps, 'cli_app');
    expect(out).toEqual({ toast: name });
    expect(handler).toHaveBeenCalledTimes(1);
    const args = handler.mock.calls[0]!;
    expect(args[0]).toEqual({ action });                 // value 原样
    expect(args[1]).toBe('ou_x');                        // operatorOpenId
    switch (name) {
      case 'blocked':
        expect(args[2]).toBe(deps[depsKey]);
        expect(args[3]).toEqual({ f: 1 });               // form_value
        break;
      case 'runSave':
        expect(args[2]).toBe('cli_app');
        expect(args[3]).toBe(deps[depsKey]);
        break;
      case 'distillation':
        expect(args[2]).toBe('cli_app');
        expect(args[3]).toBe('om_card');                 // cardMessageId
        expect(args[4]).toBe(deps[depsKey]);
        break;
      default:
        expect(args[2]).toBe(deps[depsKey]);
    }
  });

  it.each(v3Cases)('%s/%s：deps 未接线 → 静默 undefined，handler 不被调用', async (_name, action, pick) => {
    const out = await handleCardAction(clickData(action), baseDeps(), 'cli_app');
    expect(out).toBeUndefined();
    expect(pick()).not.toHaveBeenCalled();
  });
});

describe('敏感动作清单', () => {
  // 逐项钉死：漏登记 = 该动作绕过 canOperate、任何人都能点。新增 / 删除必须同步改这里。
  const EXPECTED = [
    'close', 'compact_session', 'disconnect', 'export_text', 'get_write_link', 'open_local_cli', 'open_local_terminal',
    'quote_confirm', 'refresh_screenshot', 'repo_manual_submit', 'repo_worktree_submit', 'restart', 'resume',
    'retry_last_task', 'retry_turn', 'set_reasoning_effort', 'skip_repo', 'stop_turn', 'takeover', 'term_action',
    'toggle_display', 'toggle_stream', 'tui_keys', 'tui_text_input', 'wf_approve', 'wf_cancel', 'wf_reject',
    'worktree_toggle_mode',
  ];

  it('清单与重构前的手写数组逐项一致（28 项）', () => {
    expect([...SENSITIVE_CARD_ACTIONS.keys()].sort()).toEqual(EXPECTED);
  });

  it('wf_approve / wf_reject / wf_cancel 仍过权限门（墓碑排在这道门之后）', () => {
    for (const a of ['wf_approve', 'wf_reject', 'wf_cancel']) expect(sensitiveCardActionMeta(a)).toBeDefined();
  });

  it('retry_turn / stop_turn / compact_session / quote_confirm 在册（原 test 的源码文本锁，改为查表）', () => {
    for (const a of ['retry_turn', 'stop_turn', 'compact_session', 'quote_confirm']) {
      expect(sensitiveCardActionMeta(a), a).toBeDefined();
    }
  });

  it('拒绝时给 toast 的只有三个「取权 / 打开」类动作，key 与原实现一致', () => {
    const withToast = [...SENSITIVE_CARD_ACTIONS].filter(([, m]) => m.denyToastKey).map(([a, m]) => [a, m.denyToastKey]);
    expect(withToast.sort()).toEqual([
      ['get_write_link', 'card.action.write_link_no_permission'],
      ['open_local_cli', 'card.action.local_cli_no_permission'],
      ['open_local_terminal', 'card.action.local_terminal_no_permission'],
    ]);
  });

  it('pendingRepo 发起人例外只给 skip_repo / repo_manual_submit / repo_worktree_submit；worktree_toggle_mode 明确不享受', () => {
    const exempt = [...SENSITIVE_CARD_ACTIONS].filter(([, m]) => m.pendingRepoOwnerException).map(([a]) => a).sort();
    expect(exempt).toEqual(['repo_manual_submit', 'repo_worktree_submit', 'skip_repo']);
    expect(sensitiveCardActionMeta('worktree_toggle_mode')?.pendingRepoOwnerException).toBeUndefined();
  });

  it('未登记 / 非字符串 → undefined（不过门）', () => {
    for (const a of ['nope', '', 'RESTART', undefined, null, 5, {}, ['restart']]) {
      expect(sensitiveCardActionMeta(a), String(a)).toBeUndefined();
    }
  });
});
