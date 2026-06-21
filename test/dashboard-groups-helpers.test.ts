import { describe, it, expect } from 'vitest';
import {
  allExpectedInChat,
  renderBotCheckboxes,
  renderRoleProfileBootstrapSummary,
  suggestRoleProfileIdFromChat,
} from '../src/dashboard/web/groups.js';
import { hasExplicitChatRole, summarizeGroupProfileMatches } from '../src/dashboard/web/role-profile-match.js';

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

describe('renderBotCheckboxes — shared bot picker ordering', () => {
  it('renders in the provided dashboard bot order and filters excluded ids', () => {
    const html = renderBotCheckboxes(
      [
        { larkAppId: 'cli_b', botName: 'Beta' },
        { larkAppId: 'cli_a', botName: 'Alpha' },
        { larkAppId: 'cli_c', botName: 'Gamma' },
      ],
      new Set(['cli_a']),
    );

    expect(html).not.toContain('cli_a');
    expect(html.indexOf('cli_b')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('cli_c')).toBeGreaterThan(html.indexOf('cli_b'));
  });
});

describe('renderRoleProfileBootstrapSummary — create-group profile feedback', () => {
  it('renders a sent bootstrap message summary', () => {
    const html = renderRoleProfileBootstrapSummary('collab-main', 'om_bootstrap', null);

    expect(html).toContain('Profile：collab-main');
    expect(html).toContain('bootstrap 消息已发送：om_bootstrap');
    expect(html).toContain('hint-ok');
  });

  it('renders failure details and escapes interpolated values', () => {
    const html = renderRoleProfileBootstrapSummary(
      '<profile>',
      null,
      '<script>alert(1)</script>',
    );

    expect(html).not.toContain('<profile>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;profile&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('hint-warn');
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
