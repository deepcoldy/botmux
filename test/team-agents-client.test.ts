/**
 * 团队维度 Agent 互查 / 拉群的 machine-auth 客户端。
 * Run: pnpm vitest run test/team-agents-client.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  fetchTeamAgents,
  fetchTeams,
  createTeamGroup,
  addTeamGroupMembers,
  isRetriable,
  describeTeamAgentsFailure,
  rateLimitRetryHint,
  shouldTryAutoAddPlatformBot,
  type TeamAgentsClientOptions,
} from '../src/platform/team-agents-client.js';

const BINDING = {
  platformUrl: 'https://platform.example',
  machineToken: 'mt-secret',
  machineId: 'm-1',
};

function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
  let i = 0;
  const next = () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
  return {
    calls,
    http: {
      get: ((url: string, opts: any) => { calls.push({ method: 'GET', url, headers: opts?.headers }); return next(); }) as any,
      post: ((url: string, body: unknown, opts: any) => { calls.push({ method: 'POST', url, body, headers: opts?.headers }); return next(); }) as any,
    },
  };
}

function opts(responses: Array<{ status: number; json: unknown } | Error>): {
  o: TeamAgentsClientOptions;
  calls: ReturnType<typeof fakeHttp>['calls'];
} {
  const f = fakeHttp(responses);
  return { o: { binding: BINDING, http: f.http }, calls: f.calls };
}

describe('fetchTeams（端点1）', () => {
  it('带 Bearer，正常解析 teams', async () => {
    const { o, calls } = opts([{ status: 200, json: { teams: [{ teamId: 't1', teamName: 'One' }, { teamId: 't2', teamName: 'Two' }] } }]);
    const r = await fetchTeams(o);
    expect(r).toEqual({ ok: true, value: [{ teamId: 't1', teamName: 'One' }, { teamId: 't2', teamName: 'Two' }] });
    expect(calls[0].url).toBe('https://platform.example/v1/machine/teams');
    expect(calls[0].headers?.authorization).toBe('Bearer mt-secret');
  });

  it('丢弃无 teamId 的脏项，teamName 缺省回落到 teamId', async () => {
    const { o } = opts([{ status: 200, json: { teams: [{ teamName: '没id' }, { teamId: 't3' }] } }]);
    const r = await fetchTeams(o);
    expect(r).toEqual({ ok: true, value: [{ teamId: 't3', teamName: 't3' }] });
  });

  it('unbound 时不发请求', async () => {
    const f = fakeHttp([{ status: 200, json: {} }]);
    const r = await fetchTeams({ binding: null, http: f.http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('describeTeamAgentsFailure', () => {
  it('每种 reason 都给一句人话', () => {
    expect(describeTeamAgentsFailure({ ok: false, reason: 'unbound' })).toContain('未绑定');
    expect(describeTeamAgentsFailure({ ok: false, reason: 'rate_limited', status: 429, error: 'rate_limited' })).toContain('限流');
    expect(describeTeamAgentsFailure({ ok: false, reason: 'forbidden', status: 401, error: 'x' })).toContain('bind');
    expect(describeTeamAgentsFailure({ ok: false, reason: 'client', status: 403, error: 'not_in_team_bots' })).toContain('not_in_team_bots');
  });
});

describe('未绑定平台', () => {
  it('所有调用直接 unbound，不发任何请求', async () => {
    const f = fakeHttp([{ status: 200, json: {} }]);
    const r = await fetchTeamAgents('t1', { binding: null, http: f.http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('fetchTeamAgents（端点2）', () => {
  it('带 Bearer + teamId query，normalize agent 字段', async () => {
    const { o, calls } = opts([{
      status: 200,
      json: {
        teamId: 't1', teamName: 'Team One',
        agents: [{
          appId: 'cli_a', openId: 'ou_a', unionId: 'on_a', name: 'A',
          specialties: ['backend', 'pr-review'], mentionable: true, online: true,
          owner: { unionId: 'on_owner', name: 'Owner' }, machineId: 'm-2', machineName: 'box2',
        }],
      },
    }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0].url).toBe('https://platform.example/v1/machine/agents?teamId=t1');
    expect(calls[0].headers?.authorization).toBe('Bearer mt-secret');
    expect(r.value.teamName).toBe('Team One');
    expect(r.value.agents[0]).toMatchObject({
      appId: 'cli_a', name: 'A', specialties: ['backend', 'pr-review'],
      mentionable: true, online: true, owner: { unionId: 'on_owner', name: 'Owner' },
    });
  });

  it('空 agents 是正常态，不报错', async () => {
    const { o } = opts([{ status: 200, json: { teamId: 't1', teamName: 'T', agents: [] } }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r).toEqual({ ok: true, value: { teamId: 't1', teamName: 'T', agents: [] } });
  });

  it('丢弃无 appId 的脏 agent，坏 specialties → 空数组', async () => {
    const { o } = opts([{
      status: 200,
      json: {
        teamId: 't1', teamName: 'T',
        agents: [
          { name: '没有 appId' },                                    // 丢弃
          { appId: 'cli_b', name: 'B', specialties: 'not-array' },   // specialties → []
          { appId: 'cli_c', name: 'C', specialties: ['x', 'x', 42, ''] }, // 去重去脏
        ],
      },
    }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.agents.map(a => a.appId)).toEqual(['cli_b', 'cli_c']);
    expect(r.value.agents[0].specialties).toEqual([]);
    expect(r.value.agents[1].specialties).toEqual(['x']);
  });

  it('mentionable/online 缺省保守为 false', async () => {
    const { o } = opts([{ status: 200, json: { teamId: 't1', teamName: 'T', agents: [{ appId: 'cli_a', name: 'A' }] } }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.agents[0].mentionable).toBe(false);
    expect(r.value.agents[0].online).toBe(false);
    expect(r.value.agents[0].specialties).toEqual([]);
  });

  it('404 非成员/团队不存在（业务态，带 JSON error）→ client（不重试）', async () => {
    const { o } = opts([{ status: 404, json: { error: 'not_found' } }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 404, error: 'not_found' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('404 纯文本兜底（无 error，路由未部署）→ not_deployed，与"非成员"区分', async () => {
    // getJson/postJson 对纯文本响应返回 {} → 无 .error → 端点未部署。
    const { o } = opts([{ status: 404, json: {} }]);
    const r = await fetchTeamAgents('t1', o);
    expect(r).toMatchObject({ ok: false, reason: 'not_deployed', status: 404 });
    expect(isRetriable(r as any)).toBe(false);
  });
});

describe('createTeamGroup（端点3）', () => {
  it('POST body 带 teamId+appIds(+name)，回 chatId/shareLink/invalid*', async () => {
    const { o, calls } = opts([{
      status: 200,
      json: { ok: true, chatId: 'oc_1', shareLink: 'https://l/x', invalidBotIds: ['cli_z'], invalidOwnerUnionIds: [] },
    }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a', 'cli_b'], name: '小群' }, o);
    expect(r).toEqual({
      ok: true,
      value: { ok: true, chatId: 'oc_1', shareLink: 'https://l/x', invalidBotIds: ['cli_z'], invalidOwnerUnionIds: [] },
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://platform.example/v1/machine/groups');
    expect(calls[0].body).toEqual({ teamId: 't1', appIds: ['cli_a', 'cli_b'], name: '小群' });
  });

  it('不传 name 时 body 不含 name 键', async () => {
    const { o, calls } = opts([{ status: 200, json: { ok: true, chatId: 'oc_1' } }]);
    await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(calls[0].body).toEqual({ teamId: 't1', appIds: ['cli_a'] });
  });

  it('403 not_in_team_bots（带 error 体）→ client，不重试', async () => {
    const { o } = opts([{ status: 403, json: { error: 'not_in_team_bots' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'not_in_team_bots' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('403 not_in_team_bots 带 appIds → 透传到 failure.appIds（review P2 优化）', async () => {
    const { o } = opts([{ status: 403, json: { error: 'not_in_team_bots', appIds: ['cli_x', 'cli_y'] } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_x', 'cli_y', 'cli_z'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, appIds: ['cli_x', 'cli_y'] });
  });

  it('403 machine_ownership_mismatch → forbidden（凭证问题，非 client）（review P1）', async () => {
    // 机器 RETIRED / 换绑 owner 时平台发这个 403。它是凭证/归属问题（该 rebind），不能像
    // not_in_team_bots 那样归 client 并提示「确认 bot 已加入团队」——那会误导排查方向。
    const { o } = opts([{ status: 403, json: { error: 'machine_ownership_mismatch' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'forbidden', status: 403, error: 'machine_ownership_mismatch' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('429 rate_limited（同机 30s 一次）→ 单独分型且可重试', async () => {
    const { o } = opts([{ status: 429, json: { error: 'rate_limited' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited', status: 429 });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('429 带 retryAfterMs → 解析进 failure，rateLimitRetryHint 用它给秒数', async () => {
    const { o } = opts([{ status: 429, json: { error: 'rate_limited', retryAfterMs: 12000 } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited', retryAfterMs: 12000 });
    if (r.ok) return;
    if (r.reason !== 'rate_limited') return;
    expect(rateLimitRetryHint(r)).toContain('12 秒');
  });

  it('429 无 retryAfterMs → hint 回落中性文案（不写死 30s）', async () => {
    const { o } = opts([{ status: 429, json: { error: 'rate_limited' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    if (r.ok || r.reason !== 'rate_limited') { expect.fail('expected rate_limited'); return; }
    expect(r.retryAfterMs).toBeUndefined();
    expect(rateLimitRetryHint(r)).toBe('请稍后重试');
  });

  it('分型只看当次 status：一个非 opt-in 请求也可能拿 429（不是恒定 403）', async () => {
    // 平台端点3 检查顺序 404→429→403，限流器只在真正建群那步 arm。合法请求 arm 了 30s 窗后，
    // 紧接着的非 opt-in 请求会先撞 429、而非 403。所以「非法请求恒 403」不成立——分型按当次
    // status 判即可。这条守住不把「同参数重发结果恒定」写进逻辑。
    const first = opts([{ status: 200, json: { ok: true, chatId: 'oc_1' } }]);
    expect((await createTeamGroup({ teamId: 't1', appIds: ['cli_ok'] }, first.o)).ok).toBe(true);
    // 同一个非 opt-in 参数，平台这次因限流回 429（而非 403）——客户端如实分型成 rate_limited。
    const second = opts([{ status: 429, json: { error: 'rate_limited' } }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_not_optin'] }, second.o);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited', status: 429 });
  });

  it('503 → server，可重试', async () => {
    const { o } = opts([{ status: 503, json: {} }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'server', status: 503 });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('纯 401 → forbidden，停手不重试', async () => {
    const { o } = opts([{ status: 401, json: {} }]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'forbidden', status: 401 });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('网络异常 → network，可重试', async () => {
    const { o } = opts([new Error('ECONNREFUSED')]);
    const r = await createTeamGroup({ teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(isRetriable(r as any)).toBe(true);
  });
});

describe('addTeamGroupMembers（端点4 / B：往现有群补人）', () => {
  it('POST 到 /groups/:chatId/members，body 带 teamId+appIds（补人恒带 owner，无 includeOwners）', async () => {
    const { o, calls } = opts([{ status: 200, json: { ok: true, chatId: 'oc_1', invalidBotIds: [], invalidOwnerUnionIds: [] } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_1', teamId: 't1', appIds: ['cli_a', 'cli_b'] }, o);
    expect(r).toEqual({ ok: true, value: { ok: true, invalidBotIds: [], invalidOwnerUnionIds: [] } });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://platform.example/v1/machine/groups/oc_1/members');
    expect(calls[0].body).toEqual({ teamId: 't1', appIds: ['cli_a', 'cli_b'] });
  });

  it('chatId 进 path 时被 URL 编码', async () => {
    const { o, calls } = opts([{ status: 200, json: { ok: true } }]);
    await addTeamGroupMembers({ chatId: 'oc/weird id', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(calls[0].url).toBe('https://platform.example/v1/machine/groups/oc%2Fweird%20id/members');
  });

  it('403 platform_bot_not_in_chat（平台 bot 不在目标群）→ client', async () => {
    const { o } = opts([{ status: 403, json: { error: 'platform_bot_not_in_chat' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_x', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'platform_bot_not_in_chat' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('403 platform_bot_not_in_chat 带 platformAppId(+name) → 透传到 failure（自动拉平台 app 用）', async () => {
    const { o } = opts([{ status: 403, json: { error: 'platform_bot_not_in_chat', platformAppId: 'cli_plat', platformAppName: '平台应用' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_x', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'platform_bot_not_in_chat', platformAppId: 'cli_plat', platformAppName: '平台应用' });
  });

  it('403 requester_not_in_chat（发起方 owner 本人不在该群）→ client', async () => {
    const { o } = opts([{ status: 403, json: { error: 'requester_not_in_chat' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_x', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'requester_not_in_chat' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('403 chat_is_hall（机器人大厅不允许补人）→ client', async () => {
    const { o } = opts([{ status: 403, json: { error: 'chat_is_hall' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_hall', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'chat_is_hall' });
  });

  it('403 machine_ownership_mismatch → forbidden（凭证问题，非 client）', async () => {
    const { o } = opts([{ status: 403, json: { error: 'machine_ownership_mismatch' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_x', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'forbidden', status: 403 });
  });

  it('403 chat_not_in_team（旧码，端点未升级前兼容）→ 仍 client', async () => {
    const { o } = opts([{ status: 403, json: { error: 'chat_not_in_team' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_x', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 403, error: 'chat_not_in_team' });
  });

  it('200 带 invalid* → 如实透传', async () => {
    const { o } = opts([{ status: 200, json: { ok: true, chatId: 'oc_1', invalidBotIds: ['cli_z'], invalidOwnerUnionIds: ['on_w'] } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_1', teamId: 't1', appIds: ['cli_a', 'cli_z'] }, o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invalidBotIds).toEqual(['cli_z']);
    expect(r.value.invalidOwnerUnionIds).toEqual(['on_w']);
  });

  it('502 feishu_unavailable → server，可重试', async () => {
    const { o } = opts([{ status: 502, json: { error: 'feishu_unavailable' } }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_1', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'server', status: 502 });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('404 路由未部署（纯文本）→ not_deployed', async () => {
    const { o } = opts([{ status: 404, json: {} }]);
    const r = await addTeamGroupMembers({ chatId: 'oc_1', teamId: 't1', appIds: ['cli_a'] }, o);
    expect(r).toMatchObject({ ok: false, reason: 'not_deployed', status: 404 });
  });
});

describe('shouldTryAutoAddPlatformBot（自动拉平台 app 的触发条件 + 单次性）', () => {
  const base = { ok: false as const, reason: 'client' as const, status: 403 };

  it('platform_bot_not_in_chat + platformAppId → true', () => {
    expect(shouldTryAutoAddPlatformBot({ ...base, error: 'platform_bot_not_in_chat', platformAppId: 'cli_plat' })).toBe(true);
  });

  it('platform_bot_not_in_chat 但无 platformAppId（旧端点未回传）→ false（不拉未知 id 的 app）', () => {
    expect(shouldTryAutoAddPlatformBot({ ...base, error: 'platform_bot_not_in_chat' })).toBe(false);
  });

  it('成功结果 → false', () => {
    expect(shouldTryAutoAddPlatformBot({ ok: true, value: {} })).toBe(false);
  });

  it('其它 403（requester_not_in_chat / chat_is_hall / not_in_team_bots）→ false', () => {
    for (const error of ['requester_not_in_chat', 'chat_is_hall', 'not_in_team_bots']) {
      expect(shouldTryAutoAddPlatformBot({ ...base, error })).toBe(false);
    }
  });

  it('非 403（如 429 / forbidden / server）→ false', () => {
    expect(shouldTryAutoAddPlatformBot({ ok: false, reason: 'rate_limited', status: 429, error: 'x' })).toBe(false);
    expect(shouldTryAutoAddPlatformBot({ ok: false, reason: 'forbidden', status: 403, error: 'x' })).toBe(false);
    expect(shouldTryAutoAddPlatformBot({ ok: false, reason: 'server', status: 502, error: 'x' })).toBe(false);
  });

  it('单次性：重试后即便仍是 platform_bot_not_in_chat，也由调用方「只喂首个结果」保证不再触发——本函数是纯判定，多次调用同输入结果稳定', () => {
    // 编排层的终止性 = 调用方拉一次+重试一次、重试结果不回喂本函数（见 cmdBotsInvite）。
    // 这里锁住「同一个仍撞 platform_bot_not_in_chat 的结果，本函数依旧返回 true」——若未来有人
    // 把重试结果错误地回喂进来，会立刻在评审/测试中暴露成潜在二次触发点。
    const retryStillFail = { ...base, error: 'platform_bot_not_in_chat', platformAppId: 'cli_plat' };
    expect(shouldTryAutoAddPlatformBot(retryStillFail)).toBe(true);
    expect(shouldTryAutoAddPlatformBot(retryStillFail)).toBe(true); // 幂等、无副作用
  });
});
