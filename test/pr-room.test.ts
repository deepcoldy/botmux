import { describe, expect, it } from 'vitest';

import {
  buildPrRoomKickoff,
  isAmbiguousGroupCreateFailure,
  parsePullRequestRef,
  resolveReviewerMentionOpenIds,
  resolveRosterBotRef,
} from '../src/cli/pr-room.js';
import type { AggregatedRosterBot } from '../src/services/federation-roster.js';

function bot(
  larkAppId: string,
  name: string,
  cliId: string,
  local = false,
): AggregatedRosterBot {
  return {
    larkAppId,
    name,
    cliId,
    capability: null,
    hasTeamRole: false,
    deployment: {
      id: local ? 'local' : 'remote',
      name: local ? 'Local' : 'Remote',
      local,
      stale: false,
    },
  };
}

describe('pr-room', () => {
  it('canonicalizes a GitHub pull request URL into a stable room key', () => {
    expect(parsePullRequestRef('https://github.com/DeepColdy/botmux/pull/570/files')).toEqual({
      url: 'https://github.com/DeepColdy/botmux/pull/570',
      host: 'github.com',
      owner: 'DeepColdy',
      repo: 'botmux',
      number: 570,
      key: 'github.com/deepcoldy/botmux#570',
    });
  });

  it('rejects issue and repository URLs so unrelated work cannot share a room', () => {
    expect(() => parsePullRequestRef('https://github.com/deepcoldy/botmux/issues/570')).toThrow(
      '当前仅支持',
    );
    expect(() => parsePullRequestRef('https://github.com/deepcoldy/botmux')).toThrow(
      '当前仅支持',
    );
  });

  it('keeps SCM ports in the room key', () => {
    expect(parsePullRequestRef('https://scm.example:8443/acme/service/pull/7').key)
      .toBe('scm.example:8443/acme/service#7');
    expect(parsePullRequestRef('https://scm.example:9443/acme/service/pull/7').key)
      .toBe('scm.example:9443/acme/service#7');
  });

  it('resolves an exact app id or unique display name and rejects ambiguous cli ids', () => {
    const bots = [
      bot('cli_author', '呀哈哈', 'coco', true),
      bot('cli_owner_codex', 'Botmux开发者(Codex)', 'codex'),
      bot('cli_other_codex', 'LastResort(Codex)', 'codex'),
    ];
    expect(resolveRosterBotRef(bots, 'cli_owner_codex').name).toBe('Botmux开发者(Codex)');
    expect(resolveRosterBotRef(bots, '呀哈哈').larkAppId).toBe('cli_author');
    expect(() => resolveRosterBotRef(bots, 'codex')).toThrow('不唯一');
  });

  it('builds a kickoff that assigns independent reviewer and author responsibilities', () => {
    const pr = parsePullRequestRef('https://github.com/deepcoldy/botmux/pull/570');
    const text = buildPrRoomKickoff(pr, ['<at user_id="ou_reviewer"></at>']);
    expect(text).toContain('<at user_id="ou_reviewer"></at>');
    expect(text).toContain(pr.url);
    expect(text).toContain('Reviewer agent');
    expect(text).toContain('Author agent');
    expect(text).toContain('botmux pr-room finish');
  });

  it('resolves local reviewers by app id and federated reviewers by display name', () => {
    expect(resolveReviewerMentionOpenIds(
      [
        {
          larkAppId: 'cli_local',
          openId: 'ou_local',
          name: 'codex',
          displayName: 'Local Reviewer',
          mentionable: true,
        },
        {
          larkAppId: '',
          openId: 'ou_remote',
          name: 'Remote Reviewer',
          displayName: 'Remote Reviewer',
          mentionable: true,
        },
      ],
      [
        { larkAppId: 'cli_local', name: 'Local Reviewer' },
        { larkAppId: 'cli_remote', name: 'Remote Reviewer' },
      ],
    )).toEqual({ openIds: ['ou_local', 'ou_remote'], missing: [] });
  });

  it('fails closed when a reviewer display name is ambiguous or not mentionable', () => {
    expect(resolveReviewerMentionOpenIds(
      [
        {
          larkAppId: '',
          openId: 'ou_one',
          name: 'Reviewer',
          displayName: 'Reviewer',
          mentionable: true,
        },
        {
          larkAppId: '',
          openId: 'ou_two',
          name: 'Reviewer',
          displayName: 'Reviewer',
          mentionable: true,
        },
        {
          larkAppId: 'cli_hidden',
          openId: 'ou_hidden',
          name: 'Hidden',
          displayName: 'Hidden',
          mentionable: false,
        },
      ],
      [
        { larkAppId: 'cli_remote', name: 'Reviewer' },
        { larkAppId: 'cli_hidden', name: 'Hidden' },
      ],
    )).toEqual({ openIds: [], missing: ['Reviewer', 'Hidden'] });
  });

  it('only classifies timeout or explicit local transport ambiguity as maybe-created', () => {
    expect(isAmbiguousGroupCreateFailure(504, 'delegation_timeout')).toBe(true);
    expect(isAmbiguousGroupCreateFailure(408, 'request_timeout')).toBe(true);
    expect(isAmbiguousGroupCreateFailure(502, 'group_create_indeterminate:socket hang up')).toBe(true);
    expect(isAmbiguousGroupCreateFailure(502, 'hub_unreachable')).toBe(false);
    expect(isAmbiguousGroupCreateFailure(502, 'no_creator_available')).toBe(false);
  });
});
