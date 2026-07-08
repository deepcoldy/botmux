import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  botMatchesTeamFilters,
  mapHostedTeams,
  mapRemoteTeams,
  teamCliOptions,
  updateTeamBotCapability,
  type RosterBot,
  type Team,
} from '../src/dashboard/web/team-federation.js';
import {
  applyRoleProfile,
  botInChatCount,
  botRoleCount,
  byteLength,
  entryForBot,
  filterRoleGroups,
  filterRoleProfiles,
  hashChatId,
  isValidProfileId,
  saveInjectMode,
  type GroupInfo,
} from '../src/dashboard/web/roles.js';

const tr = (key: string, params?: Record<string, string | number>) => {
  if (params) return `${key}:${JSON.stringify(params)}`;
  return key;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('team federation helpers', () => {
  const bot: RosterBot = {
    larkAppId: 'cli_a',
    name: 'Alpha Bot',
    cliId: 'codex',
    capability: 'code review',
    hasTeamRole: true,
    deployment: { id: 'dep1', name: 'local', local: true, stale: false },
  };

  it('filters roster bots by search, cli, capability, and role flags', () => {
    expect(botMatchesTeamFilters(bot, { query: 'review', cliId: '', hasCapability: false, hasRole: false })).toBe(true);
    expect(botMatchesTeamFilters(bot, { query: 'missing', cliId: '', hasCapability: false, hasRole: false })).toBe(false);
    expect(botMatchesTeamFilters(bot, { query: '', cliId: 'codex', hasCapability: true, hasRole: true })).toBe(true);
    expect(botMatchesTeamFilters({ ...bot, capability: null }, { query: '', cliId: '', hasCapability: true, hasRole: false })).toBe(false);
    expect(botMatchesTeamFilters({ ...bot, hasTeamRole: false }, { query: '', cliId: '', hasCapability: false, hasRole: true })).toBe(false);
  });

  it('maps hosted and remote teams while preserving route/API identity keys', () => {
    const hosted = mapHostedTeams({
      teams: [
        { teamId: 'default', isDefault: true, deployments: [], bots: [bot] },
        { teamId: 'ops', name: 'Ops', deployments: [], bots: [] },
      ],
    }, tr);
    expect(hosted.map(team => [team.key, team.label])).toEqual([
      ['local:default', 'team.myHostedTeam'],
      ['local:ops', 'Ops'],
    ]);

    const remote = mapRemoteTeams({
      memberships: [{
        hubUrl: 'https://hub.example',
        teamId: 'team-r',
        roster: { deployments: [{ id: 'hub', name: 'Hub Deploy', local: true, stale: false }], bots: [] },
      }],
    }, tr);
    expect(remote[0]).toMatchObject({
      kind: 'remote',
      key: 'https://hub.example::team-r',
      label: 'team.remoteTeamLabel:{"name":"Hub Deploy"}',
      hubUrl: 'https://hub.example',
    });
  });

  it('deduplicates cli options and trims capability updates', () => {
    const teams: Team[] = [
      { kind: 'local', key: 'a', teamId: 'a', label: 'A', sub: '', ok: true, deployments: [], bots: [bot] },
      { kind: 'remote', key: 'b', teamId: 'b', label: 'B', sub: '', ok: true, deployments: [], bots: [{ ...bot, larkAppId: 'cli_b', cliId: 'claude' }] },
    ];
    expect(teamCliOptions(teams)).toEqual(['claude', 'codex']);
    expect(updateTeamBotCapability(teams, 'cli_a', '  docs  ')[0].bots[0].capability).toBe('docs');
    expect(updateTeamBotCapability(teams, 'cli_a', '   ')[0].bots[0].capability).toBeNull();
  });
});

describe('roles helpers', () => {
  const groups: GroupInfo[] = [{
    chatId: 'oc_chat_a',
    name: 'Prod Review',
    memberBots: [
      { larkAppId: 'cli_a', botName: 'Alpha', inChat: true, hasRole: true, oncallChat: null },
      { larkAppId: 'cli_b', botName: 'Beta', inChat: false, hasRole: true, oncallChat: null },
      { larkAppId: 'cli_c', botName: 'Gamma', inChat: true, hasRole: false, oncallChat: null },
    ],
  }];

  it('validates profile ids and parses roles profile hash query state', () => {
    expect(isValidProfileId('collab-main_1.2')).toBe(true);
    expect(isValidProfileId('.')).toBe(false);
    expect(isValidProfileId('..')).toBe(false);
    expect(isValidProfileId('bad space')).toBe(false);
    expect(hashChatId('#/roles/profile?chatId=oc_chat_a')).toBe('oc_chat_a');
    expect(hashChatId('#/roles/profile?chatId=')).toBeNull();
  });

  it('filters groups/profiles and counts only bots currently in chat', () => {
    expect(filterRoleGroups(groups, 'alpha')).toHaveLength(1);
    expect(filterRoleGroups(groups, 'missing')).toHaveLength(0);
    expect(botRoleCount(groups[0])).toBe(1);
    expect(botInChatCount(groups[0])).toBe(2);
    expect(filterRoleProfiles([
      { profileId: 'main', entryCount: 1, updatedAt: null },
      { profileId: 'ops', entryCount: 0, updatedAt: null },
    ], 'ma').map(profile => profile.profileId)).toEqual(['main']);
  });

  it('computes byte length and finds profile entries by bot id', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('你好')).toBe(6);
    expect(entryForBot([
      { profileId: 'main', larkAppId: 'cli_a', content: 'role', byteLength: 4, updatedAt: null },
    ], 'cli_a')?.content).toBe('role');
    expect(entryForBot([], 'cli_a')).toBeUndefined();
    expect(entryForBot([], null)).toBeUndefined();
  });

  it('keeps role write APIs on the existing endpoints and request bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveInjectMode('cli_a', 'oc_chat_a', 'once')).resolves.toBe(true);
    await expect(applyRoleProfile({
      profileId: 'main',
      chatId: 'oc_chat_a',
      larkAppId: 'cli_a',
      force: true,
      preview: false,
    })).resolves.toMatchObject({ larkAppId: 'cli_a', ok: true, status: 200 });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/roles/cli_a/oc_chat_a');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ injectMode: 'once' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/role-profiles/main/apply');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      chatId: 'oc_chat_a',
      larkAppId: 'cli_a',
      force: true,
      preview: false,
    });
  });
});
