import { describe, expect, it } from 'vitest';

import {
  buildGroupDetail,
  buildGroupRow,
  buildGroupRows,
  chatIdSuffix,
  filterGroups,
  paginateGroups,
  type GroupsBotInput,
  type GroupsChatInput,
  type GroupsMemberBotInput,
} from '../src/dashboard/groups-card-model.js';

const BOTS: GroupsBotInput[] = [
  { larkAppId: 'cli_claude', botName: 'claude' },
  { larkAppId: 'cli_codex', botName: 'codex' },
  { larkAppId: 'cli_mira', botName: 'mira' },
];

function member(over: Partial<GroupsMemberBotInput> & { larkAppId: string; botName: string }): GroupsMemberBotInput {
  return { inChat: true, oncallChat: null, ...over };
}

function makeChat(overrides: Partial<GroupsChatInput> = {}): GroupsChatInput {
  return {
    chatId: 'oc_default12345',
    name: 'default-room',
    ownerId: 'cli_claude',
    memberBots: BOTS.map(b => member({ larkAppId: b.larkAppId, botName: b.botName })),
    ...overrides,
  };
}

describe('groups-card-model · filterGroups', () => {
  it('query matches name, chatId, or ownerId — case-insensitive', () => {
    const chats: GroupsChatInput[] = [
      makeChat({ chatId: 'oc_alpha111', name: 'Alpha Room', ownerId: 'cli_codex' }),
      makeChat({ chatId: 'oc_beta222', name: 'Beta Room', ownerId: 'cli_mira' }),
      makeChat({ chatId: 'oc_gamma333', name: 'Gamma Room', ownerId: 'cli_claude' }),
    ];
    expect(filterGroups(chats, { query: 'ALPHA' }).map(c => c.chatId)).toEqual(['oc_alpha111']);
    expect(filterGroups(chats, { query: 'beta222' }).map(c => c.chatId)).toEqual(['oc_beta222']);
    expect(filterGroups(chats, { query: 'CLI_CLAUDE' }).map(c => c.chatId)).toEqual(['oc_gamma333']);
  });

  it('missingOnly keeps chats with at least one uncovered bot (M3: inChat=false / absent / unknown / error)', () => {
    const fullyCovered = makeChat({ chatId: 'oc_full' });
    const notInChat = makeChat({
      chatId: 'oc_notInChat',
      memberBots: [
        member({ larkAppId: 'cli_claude', botName: 'claude' }),
        { larkAppId: 'cli_codex', botName: 'codex', inChat: false },
        member({ larkAppId: 'cli_mira', botName: 'mira' }),
      ],
    });
    const absent = makeChat({
      chatId: 'oc_absent',
      memberBots: [
        member({ larkAppId: 'cli_claude', botName: 'claude' }),
        member({ larkAppId: 'cli_codex', botName: 'codex' }),
        // mira intentionally NOT listed — only detectable when the bot universe is passed.
      ],
    });
    const statusUnknown = makeChat({
      chatId: 'oc_unknown',
      memberBots: [
        member({ larkAppId: 'cli_claude', botName: 'claude' }),
        { larkAppId: 'cli_codex', botName: 'codex', status: 'unknown' },
        member({ larkAppId: 'cli_mira', botName: 'mira' }),
      ],
    });
    const statusError = makeChat({
      chatId: 'oc_error',
      memberBots: [
        member({ larkAppId: 'cli_claude', botName: 'claude' }),
        member({ larkAppId: 'cli_codex', botName: 'codex' }),
        { larkAppId: 'cli_mira', botName: 'mira', status: 'error' },
      ],
    });

    const kept = filterGroups(
      [fullyCovered, notInChat, absent, statusUnknown, statusError],
      { missingOnly: true },
      BOTS,
    );
    expect(kept.map(c => c.chatId)).toEqual(['oc_notInChat', 'oc_absent', 'oc_unknown', 'oc_error']);

    // Without the bots universe, the "row absent" case (mira not listed at all)
    // is NOT detectable and `absent` drops out of the missingOnly slice.
    const withoutBotsUniverse = filterGroups(
      [fullyCovered, notInChat, absent, statusUnknown, statusError],
      { missingOnly: true },
    );
    expect(withoutBotsUniverse.map(c => c.chatId)).toEqual(['oc_notInChat', 'oc_unknown', 'oc_error']);
  });
});

describe('groups-card-model · paginateGroups', () => {
  it('out-of-range page clamps to 1, default pageSize is 20, total reflects input length', () => {
    const chats: GroupsChatInput[] = Array.from({ length: 45 }, (_, i) =>
      makeChat({ chatId: `oc_n${i}`, name: `room ${i}` }),
    );
    const negative = paginateGroups(chats, -5, undefined);
    expect(negative.page).toBe(1);
    expect(negative.pageSize).toBe(20);
    expect(negative.total).toBe(45);

    const overshoot = paginateGroups(chats, 99, 20);
    expect(overshoot.page).toBe(3);
  });
});

describe('groups-card-model · buildGroupRow', () => {
  it('coverage follows the bots argument order; statuses map in/out/err/unknown; missing/total are correct', () => {
    const chat: GroupsChatInput = {
      chatId: 'oc_mixed',
      name: 'mixed',
      ownerId: 'cli_claude',
      memberBots: [
        { larkAppId: 'cli_claude', botName: 'claude', inChat: true },
        { larkAppId: 'cli_codex', botName: 'codex', inChat: false },
        { larkAppId: 'cli_mira', botName: 'mira', status: 'error' },
      ],
    };
    const row = buildGroupRow(chat, BOTS);
    expect(row.coverage.map(c => c.larkAppId)).toEqual(['cli_claude', 'cli_codex', 'cli_mira']);
    expect(row.coverage.map(c => c.status)).toEqual(['in', 'out', 'error']);
    expect(row.missingCount).toBe(2);
    expect(row.totalBots).toBe(3);

    // When a bot is configured but absent from memberBots, status='unknown'.
    const partial: GroupsChatInput = {
      chatId: 'oc_partial',
      name: 'partial',
      memberBots: [{ larkAppId: 'cli_claude', botName: 'claude', inChat: true }],
    };
    const partialRow = buildGroupRow(partial, BOTS);
    expect(partialRow.coverage.map(c => c.status)).toEqual(['in', 'unknown', 'unknown']);
    expect(partialRow.missingCount).toBe(2);
  });
});

describe('groups-card-model · buildGroupRows', () => {
  it('composes filter + paginate + buildGroupRow; meta.total is filtered length, not page length', () => {
    const fully = makeChat({ chatId: 'oc_fully' });
    const missing = makeChat({
      chatId: 'oc_missing',
      memberBots: BOTS.map(b => member({ larkAppId: b.larkAppId, botName: b.botName, inChat: b.larkAppId !== 'cli_mira' })),
    });
    const out = buildGroupRows([fully, missing], BOTS, { missingOnly: true }, 1, 10);
    expect(out.rows.map(r => r.chatId)).toEqual(['oc_missing']);
    expect(out.meta.total).toBe(1);
    expect(out.rows.length).toBe(1);
  });
});

describe('groups-card-model · buildGroupDetail', () => {
  it('inChat members get both bind+unbind buttons; non-inChat members get both disabled', () => {
    const chat: GroupsChatInput = {
      chatId: 'oc_detail',
      name: 'detail',
      memberBots: [
        { larkAppId: 'cli_claude', botName: 'claude', inChat: true, oncallChat: null },
        { larkAppId: 'cli_codex', botName: 'codex', inChat: true, oncallChat: { chatId: 'oc_detail', workingDir: '/repo/codex' } },
        { larkAppId: 'cli_mira', botName: 'mira', inChat: false },
      ],
    };
    const detail = buildGroupDetail(chat, BOTS);

    const claude = detail.members[0]!;
    expect(claude.status).toBe('in');
    expect(claude.bind.enabled).toBe(true);
    expect(claude.unbind.enabled).toBe(false); // not bound yet
    expect(claude.oncallChat).toBeNull();
    expect(claude.oncallWorkingDir).toBeNull();

    const codex = detail.members[1]!;
    expect(codex.bind.enabled).toBe(false); // already bound
    expect(codex.unbind.enabled).toBe(true);
    expect(codex.oncallChat).toEqual({ chatId: 'oc_detail', workingDir: '/repo/codex' });
    expect(codex.oncallWorkingDir).toBe('/repo/codex');

    const mira = detail.members[2]!;
    expect(mira.status).toBe('out');
    expect(mira.bind.enabled).toBe(false);
    expect(mira.unbind.enabled).toBe(false);
  });

  it('oncallChat object passes through to detail; { workingDir: "" } still counts as bound', () => {
    const chat: GroupsChatInput = {
      chatId: 'oc_emptyDir',
      name: 'empty-workingdir',
      memberBots: [
        // workingDir is empty string but binding object is present —
        // matches dashboard contract: presence == bound, not workingDir truthiness.
        { larkAppId: 'cli_claude', botName: 'claude', inChat: true, oncallChat: { chatId: 'oc_emptyDir', workingDir: '' } },
      ],
    };
    const detail = buildGroupDetail(chat, [{ larkAppId: 'cli_claude', botName: 'claude' }]);
    const claude = detail.members[0]!;
    expect(claude.oncallChat).toEqual({ chatId: 'oc_emptyDir', workingDir: '' });
    expect(claude.oncallWorkingDir).toBe('');
    expect(claude.bind.enabled).toBe(false);  // already bound (presence-based)
    expect(claude.unbind.enabled).toBe(true);
  });

  it('isOwnerBot reflects chat.ownerId === larkAppId', () => {
    const ownedChat: GroupsChatInput = {
      chatId: 'oc_owned',
      name: 'owned',
      ownerId: 'cli_codex',
      memberBots: BOTS.map(b => member({ larkAppId: b.larkAppId, botName: b.botName })),
    };
    const owned = buildGroupDetail(ownedChat, BOTS);
    expect(owned.members.find(m => m.larkAppId === 'cli_codex')!.isOwnerBot).toBe(true);
    expect(owned.members.find(m => m.larkAppId === 'cli_claude')!.isOwnerBot).toBe(false);
  });
});

describe('groups-card-model · invariants', () => {
  it('filterGroups / paginateGroups do not mutate the input list', () => {
    const chats = [
      makeChat({ chatId: 'oc_a' }),
      makeChat({ chatId: 'oc_b' }),
    ];
    const frozen = Object.freeze(chats.slice());
    const snapshot = frozen.map(c => c.chatId);
    filterGroups(frozen, { query: 'oc', missingOnly: true });
    paginateGroups(frozen, 1, 10);
    expect(frozen.map(c => c.chatId)).toEqual(snapshot);
  });

  it('buildGroupRow / buildGroupDetail outputs are JSON-serialisable round-trip', () => {
    const row = buildGroupRow(makeChat(), BOTS);
    const detail = buildGroupDetail(makeChat({
      memberBots: [{
        larkAppId: 'cli_claude',
        botName: 'claude',
        inChat: true,
        oncallChat: { chatId: 'oc_default12345', workingDir: '/repo' },
      }],
    }), BOTS);
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  it('chatIdSuffix returns the last 4 chars and degrades gracefully on short input', () => {
    expect(chatIdSuffix('oc_abcdef')).toBe('cdef');
    expect(chatIdSuffix('xy')).toBe('xy');
    expect(chatIdSuffix('')).toBe('');
  });
});
