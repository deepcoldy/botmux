import { describe, expect, it } from 'vitest';
import {
  buildGoalStartBrief,
  buildGoalStartRetryCommand,
  resolveGoalStartInvitee,
  resolveGoalStartSelection,
  type GoalStartBot,
  type GoalStartTeam,
} from '../src/cli/goal-start.js';
import { parseDispatchBotSpec } from '../src/core/dispatch.js';

const codex: GoalStartBot = { larkAppId: 'cli_codex', name: 'codex-loopy', cliId: 'codex', local: true };
const traex: GoalStartBot = { larkAppId: 'cli_traex', name: 'traex-loopy', cliId: 'traex', local: true };
const relay: GoalStartBot = { larkAppId: 'cli_relay', name: 'relay-loopy(d2)', local: false };
const seed: GoalStartBot = { larkAppId: 'cli_seed', name: 'seed-loopy-work(d2)', local: false };
const team: GoalStartTeam = {
  teamId: 'team_a2a',
  teamName: 'a2a 跨设备测试',
  bots: [codex, traex, relay, seed],
  memberUnionIds: ['on_owner'],
};

describe('resolveGoalStartInvitee', () => {
  it('invites the latest human caller and does not also invite an old owner union id', () => {
    expect(resolveGoalStartInvitee({
      lastCallerOpenId: 'ou_latest',
      ownerOpenId: 'ou_owner',
      ownerUnionId: 'on_owner',
    })).toEqual({ openId: 'ou_latest' });
  });

  it('does not pass a bot caller as a user and falls back to the owner union id', () => {
    expect(resolveGoalStartInvitee({
      lastCallerOpenId: 'ou_bot',
      ownerOpenId: 'ou_owner',
      ownerUnionId: 'on_owner',
      callerIsBot: true,
    })).toEqual({ unionId: 'on_owner' });
  });
});

describe('buildGoalStartRetryCommand', () => {
  it('quotes user input safely and preserves the readiness override', () => {
    const command = buildGoalStartRetryCommand({
      chatId: 'oc_test',
      title: "修复 user's flow",
      teamId: 'team a2a',
      workers: [{ name: 'relay loopy', larkAppId: 'cli_relay' }],
      brief: '第一行\n第二行',
      sessionId: 'session-1',
      skipReadinessCheck: true,
    });
    expect(command).toContain("--title '修复 user'\"'\"'s flow'");
    expect(command).toContain("--brief '第一行\n第二行'");
    expect(command).toContain("--worker 'cli_relay'");
    expect(command).toContain('--skip-readiness-check');
  });
});

describe('resolveGoalStartSelection', () => {
  it('keeps local-only goals independent from platform teams', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      workerRefs: ['traex-loopy'],
      localBots: [codex, traex],
      teams: [team],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { supervisor: codex, workers: [traex] },
    });
    if (result.ok) expect(result.value.team).toBeUndefined();
  });

  it('resolves an explicit platform team and remote workers', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      teamRef: 'a2a 跨设备测试',
      supervisorRef: 'codex-loopy',
      workerRefs: ['relay-loopy(d2)', 'cli_seed'],
      localBots: [codex, traex],
      teams: [team],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { team, supervisor: codex, workers: [relay, seed] },
    });
  });

  it('auto-selects the only team containing all requested remote workers', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      workerRefs: ['relay-loopy(d2)', 'seed-loopy-work(d2)'],
      localBots: [codex, traex],
      teams: [team],
    });
    expect(result).toMatchObject({ ok: true, value: { team, workers: [relay, seed] } });
    if (result.ok) expect(result.warnings[0]).toContain('自动选择');
  });

  it('requires --team when several teams contain the requested workers', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      workerRefs: ['relay-loopy(d2)'],
      localBots: [codex],
      teams: [team, { ...team, teamId: 'team_other', teamName: 'Other' }],
    });
    expect(result).toEqual({
      ok: false,
      error: '多个平台团队都包含这些执行者，请用 --team 指定：a2a 跨设备测试 (team_a2a)；Other (team_other)',
    });
  });

  it('explains when workers match a team but the current supervisor does not', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      workerRefs: ['relay-loopy(d2)'],
      localBots: [codex],
      teams: [{ ...team, teamId: 'team_remote', bots: [relay] }],
    });
    expect(result).toEqual({
      ok: false,
      error: '执行者在这些团队中，但当前监管者不在：a2a 跨设备测试 (team_remote)',
    });
  });

  it('rejects a supervisor from another local daemon', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      supervisorRef: 'traex-loopy',
      workerRefs: ['relay-loopy(d2)'],
      teamRef: team.teamId,
      localBots: [codex, traex],
      teams: [team],
    });
    expect(result).toEqual({ ok: false, error: '监管者必须是当前主控会话所属的本机机器人，才能可靠回报进展' });
  });

  it('rejects a team that does not contain the supervisor', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      workerRefs: ['relay-loopy(d2)'],
      teamRef: 'team_remote',
      localBots: [codex],
      teams: [{ ...team, teamId: 'team_remote', bots: [relay] }],
    });
    expect(result).toEqual({ ok: false, error: '监管者 codex-loopy 不在团队 a2a 跨设备测试 中' });
  });

  it('deduplicates workers and removes the supervisor', () => {
    const result = resolveGoalStartSelection({
      parentLarkAppId: codex.larkAppId,
      workerRefs: ['codex-loopy', 'traex-loopy', 'cli_traex'],
      localBots: [codex, traex],
      teams: [],
    });
    expect(result).toMatchObject({ ok: true, value: { workers: [traex] } });
    if (result.ok) expect(result.warnings[0]).toContain('移除监管者');
  });
});

describe('buildGoalStartBrief', () => {
  it('adds a compact roster and cross-device project rule', () => {
    const brief = buildGoalStartBrief({
      brief: '修复支付回归并补测试。',
      teamName: team.teamName,
      supervisorName: codex.name,
      workers: [
        { name: traex.name, larkAppId: traex.larkAppId, local: true },
        { name: relay.name, larkAppId: relay.larkAppId, mentionOpenId: 'ou_relay_seen_by_codex', local: false },
      ],
      localWorkingDir: '/workspace/project',
      requiredRepo: 'github.com/acme/project',
    });
    expect(brief).toContain('修复支付回归并补测试。');
    expect(brief).toContain('团队：a2a 跨设备测试');
    expect(brief).toContain('traex-loopy（本机）');
    expect(brief).toContain('relay-loopy(d2)（远端）');
    expect(brief).toContain('--bot ou_relay_seen_by_codex:relay-loopy(d2):执行者');
    const relaySpec = brief.split('\n').find((line) => line.includes('--bot ou_relay_seen_by_codex'))?.trim().replace(/^--bot\s+/, '');
    expect(parseDispatchBotSpec(relaySpec ?? '')).toEqual({
      openId: 'ou_relay_seen_by_codex',
      name: 'relay-loopy(d2)',
      role: '执行者',
    });
    expect(brief).toContain('--needs-repo "github.com/acme/project"');
    expect(brief).not.toContain('L2');
  });

  it('warns the supervisor not to dispatch remote code work without a project', () => {
    const brief = buildGoalStartBrief({
      supervisorName: codex.name,
      workers: [{ name: relay.name, larkAppId: relay.larkAppId, local: false }],
    });
    expect(brief).toContain('项目仓库：未指定');
    expect(brief).toContain('不要直接派发远端代码任务');
  });
});
