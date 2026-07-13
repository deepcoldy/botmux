import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  allExpectedInChat,
  availableBotsForPicker,
  loadGroupRoleProfileContext,
  paginateGroupRows,
  roleProfileBootstrapStatus,
  summarizeAddBotsResult,
  suggestRoleProfileIdFromChat,
} from '../src/dashboard/web/groups.js';
import { hasExplicitChatRole, summarizeGroupProfileMatches } from '../src/dashboard/web/role-profile-match.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('allExpectedInChat — refreshUntilSeen commit predicate', () => {
  it('empty expected set → true (degenerate case, nothing to wait for)', () => {
    expect(allExpectedInChat({ memberBots: [] }, new Set())).toBe(true);
  });

  it('all expected bots show inChat:true → true (commit canonical snapshot)', () => {
    const row = {
      memberBots: [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
        { larkAppId: 'botC', inChat: false },
      ],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(true);
  });

  it('partial: one expected bot still inChat:false → false (keep optimistic, retry)', () => {
    const row = {
      memberBots: [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: false },
      ],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(false);
  });

  it('expected bot missing from memberBots entirely → false', () => {
    const row = {
      memberBots: [{ larkAppId: 'botA', inChat: true }],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(false);
  });

  it('null/undefined row → false unless expected is empty', () => {
    expect(allExpectedInChat(undefined, new Set(['botA']))).toBe(false);
    expect(allExpectedInChat(null, new Set(['botA']))).toBe(false);
    expect(allExpectedInChat(undefined, new Set())).toBe(true);
  });
});

describe('availableBotsForPicker — shared bot picker ordering', () => {
  it('keeps the provided dashboard bot order and filters excluded ids', () => {
    const bots = availableBotsForPicker(
      [
        { larkAppId: 'cli_b', botName: 'Beta' },
        { larkAppId: 'cli_a', botName: 'Alpha' },
        { larkAppId: 'cli_c', botName: 'Gamma' },
      ],
      new Set(['cli_a']),
    );

    expect(bots.map(bot => bot.larkAppId)).toEqual(['cli_b', 'cli_c']);
  });
});

describe('paginateGroupRows — bounded dashboard DOM', () => {
  const rows = Array.from({ length: 65 }, (_, index) => `group-${index + 1}`);

  it('renders at most the default 30 heavy group rows per page', () => {
    const window = paginateGroupRows(rows, 1);
    expect(window.rows).toHaveLength(30);
    expect(window.rows[0]).toBe('group-1');
    expect(window.rows[29]).toBe('group-30');
    expect(window).toMatchObject({ page: 1, totalPages: 3, from: 1, to: 30, total: 65 });
  });

  it('clamps stale pages after filtering and reports the final partial range', () => {
    const window = paginateGroupRows(rows, 99);
    expect(window.rows).toEqual(['group-61', 'group-62', 'group-63', 'group-64', 'group-65']);
    expect(window).toMatchObject({ page: 3, totalPages: 3, from: 61, to: 65, total: 65 });
  });

  it('returns a stable empty window', () => {
    expect(paginateGroupRows([], 4)).toEqual({
      rows: [], page: 1, totalPages: 1, from: 0, to: 0, total: 0,
    });
  });
});

describe('roleProfileBootstrapStatus — create-group profile feedback', () => {
  it('summarizes a sent bootstrap message', () => {
    const status = roleProfileBootstrapStatus('collab-main', 'om_bootstrap', null);

    expect(status).toEqual({
      kind: 'ok',
      text: 'Profile：collab-main；bootstrap 消息已发送：om_bootstrap',
    });
  });

  it('summarizes failure details without dropping interpolated values', () => {
    const status = roleProfileBootstrapStatus(
      '<profile>',
      null,
      '<script>alert(1)</script>',
    );

    expect(status?.kind).toBe('warn');
    expect(status?.text).toContain('<profile>');
    expect(status?.text).toContain('<script>alert(1)</script>');
  });
});

describe('summarizeAddBotsResult — add-bots inline feedback', () => {
  it('summarizes a clean add-bots result as success', () => {
    const summary = summarizeAddBotsResult([
      { id: 'cli_a', ok: true },
      { id: 'cli_b', ok: true },
    ]);

    expect(summary.okCount).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.rows.map(row => row.id)).toEqual(['cli_a', 'cli_b']);
  });

  it('summarizes partial failures and keeps row details', () => {
    const summary = summarizeAddBotsResult([
      { id: 'cli_ok', ok: true },
      { id: '<bad>', ok: false, error: '<script>alert(1)</script>' },
    ]);

    expect(summary.okCount).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.rows[1]).toMatchObject({
      id: '<bad>',
      ok: false,
      error: '<script>alert(1)</script>',
    });
  });
});

describe('summarizeGroupProfileMatches — group role/profile status', () => {
  const profiles = [
    { profileId: 'main' },
    { profileId: 'partial' },
    { profileId: 'unused' },
  ];
  const entries = new Map([
    ['main', [
      { profileId: 'main', larkAppId: 'botA', content: 'role A' },
      { profileId: 'main', larkAppId: 'botB', content: 'role B' },
      { profileId: 'main', larkAppId: 'botD', content: '' },
    ]],
    ['partial', [
      { profileId: 'partial', larkAppId: 'botA', content: 'role A' },
      { profileId: 'partial', larkAppId: 'botB', content: 'different B' },
    ]],
    ['unused', [
      { profileId: 'unused', larkAppId: 'botC', content: 'role C' },
    ]],
  ]);

  it('reports matches from explicit group roles only', () => {
    const matches = summarizeGroupProfileMatches(
      [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
        { larkAppId: 'botC', inChat: false },
        { larkAppId: 'botD', inChat: true },
      ],
      profiles,
      entries,
      new Map([
        ['botA', { content: 'role A', source: 'chat' }],
        ['botB', { content: 'role B', source: 'team' }],
      ]),
    );

    expect(matches).toEqual([
      {
        profileId: 'main',
        matched: 1,
        total: 2,
        chatMatched: 1,
        kind: 'partial',
      },
      {
        profileId: 'partial',
        matched: 1,
        total: 2,
        chatMatched: 1,
        kind: 'partial',
      },
    ]);
    expect(matches.map(m => m.profileId)).not.toContain('unused');
  });

  it('does not treat fallback/default role content as a displayed profile match', () => {
    const roles = new Map([
      ['botA', { content: 'role A', source: 'team' }],
      ['botB', { content: 'role B', source: 'team' }],
    ]);

    expect(hasExplicitChatRole(roles)).toBe(false);
    expect(summarizeGroupProfileMatches(
      [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
      ],
      profiles,
      entries,
      roles,
    )).toEqual([]);
  });

  it('returns no match when no profile entry content equals current group roles', () => {
    const matches = summarizeGroupProfileMatches(
      [{ larkAppId: 'botA', inChat: true }],
      profiles,
      entries,
      new Map([['botA', 'other']]),
    );

    expect(matches).toEqual([]);
  });
});

describe('suggestRoleProfileIdFromChat — prompt default', () => {
  it('keeps only backend-valid profile id characters', () => {
    expect(suggestRoleProfileIdFromChat('AI ChangeLog / Prod 群')).toBe('ai-changelog-prod');
  });

  it('falls back to a safe id when the group name has no valid ascii token', () => {
    expect(suggestRoleProfileIdFromChat('项目群')).toBe('profile');
  });
});

describe('loadGroupRoleProfileContext — bounded role requests', () => {
  it('loads explicit chat roles in one batch and skips unconfigured memberships', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/role-profiles') {
        return { ok: true, status: 200, json: async () => ({ profiles: [{ profileId: 'main' }] }) } as Response;
      }
      if (url === '/api/role-profiles/main') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ entries: [{ profileId: 'main', larkAppId: 'botA', content: 'role A' }] }),
        } as Response;
      }
      if (url === '/api/roles/batch') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          targets: [{ larkAppId: 'botA', chatId: 'oc_team' }],
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            roles: [{
              larkAppId: 'botA',
              chatId: 'oc_team',
              content: 'role A',
              hasRole: true,
              effectiveContent: 'role A',
              effectiveSource: 'chat',
              hasEffectiveRole: true,
            }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const context = await loadGroupRoleProfileContext({
      bots: [],
      chats: [{
        chatId: 'oc_team',
        memberBots: [
          { larkAppId: 'botA', inChat: true, hasRole: true },
          { larkAppId: 'botB', inChat: true, hasRole: false },
          { larkAppId: 'botC', inChat: false, hasRole: true },
        ],
      }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith('/api/roles/')))
      .toEqual(['/api/roles/batch']);
    expect(context.groupRoleContentByBot.get('botA\u0000oc_team')).toEqual({
      content: 'role A',
      source: 'chat',
    });
    expect(context.groupRoleContentByBot.has('botB\u0000oc_team')).toBe(false);
  });
});
