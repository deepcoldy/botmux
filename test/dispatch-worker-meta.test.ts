import { describe, expect, it } from 'vitest';
import { normalizeDispatchBotsForSender, resolveDispatchWorkerBotUnionIds, resolveDispatchWorkerMetas } from '../src/core/dispatch-worker-meta.js';

describe('dispatch worker metadata resolver', () => {
  const botConfigs = [
    { larkAppId: 'cli_claude', cliId: 'claude-code' },
    { larkAppId: 'cli_traex', cliId: 'traex' },
    { larkAppId: 'cli_codex', cliId: 'codex' },
  ];
  const botInfoEntries = [
    { larkAppId: 'cli_claude', botName: 'claude-loopy', cliId: 'claude-code' },
    { larkAppId: 'cli_traex', botName: 'traex-loopy', cliId: 'traex' },
    { larkAppId: 'cli_codex', botName: 'codex-loopy', cliId: 'codex' },
  ];

  it('resolves sender-scoped open_id through bot-openids cross-ref first', () => {
    const metas = resolveDispatchWorkerMetas({
      openIds: ['ou_traex_seen_by_claude'],
      bots: [{ openId: 'ou_traex_seen_by_claude' }],
      workerNames: ['ou_traex_seen_by_claude'],
      botConfigs,
      botInfoEntries,
      senderScopedBotOpenIds: {
        'traex-loopy': 'ou_traex_seen_by_claude',
      },
    });

    expect(metas).toEqual([{ larkAppId: 'cli_traex', cliId: 'traex' }]);
  });

  it('falls back to explicit bot name and unique cliId labels', () => {
    expect(resolveDispatchWorkerMetas({
      openIds: ['ou_x'],
      bots: [{ openId: 'ou_x', name: 'codex-loopy' }],
      botConfigs,
      botInfoEntries,
    })).toEqual([{ larkAppId: 'cli_codex', cliId: 'codex' }]);

    expect(resolveDispatchWorkerMetas({
      openIds: ['traex'],
      bots: [{ openId: 'traex' }],
      botConfigs,
      botInfoEntries,
    })).toEqual([{ larkAppId: 'cli_traex', cliId: 'traex' }]);
  });

  it('keeps index-aligned empty metadata when no robust match exists', () => {
    const metas = resolveDispatchWorkerMetas({
      openIds: ['ou_unknown'],
      bots: [{ openId: 'ou_unknown' }],
      botConfigs,
      botInfoEntries,
      senderScopedBotOpenIds: {},
    });

    expect(metas).toEqual([{ larkAppId: '', cliId: '' }]);
  });

  it('normalizes dispatch bot open_ids to the sender app namespace by display name or cliId', () => {
    const byName = normalizeDispatchBotsForSender({
      bots: [{ openId: 'ou_stale', name: 'traex-loopy', role: 'coder' }],
      botInfoEntries,
      senderScopedBotOpenIds: { 'traex-loopy': 'ou_traex_seen_by_l2' },
    });
    expect(byName).toEqual([{ openId: 'ou_traex_seen_by_l2', name: 'traex-loopy', role: 'coder' }]);

    const byCliId = normalizeDispatchBotsForSender({
      bots: [{ openId: 'traex', role: 'coder' }],
      botInfoEntries,
      senderScopedBotOpenIds: { 'traex-loopy': 'ou_traex_seen_by_l2' },
    });
    expect(byCliId).toEqual([{ openId: 'ou_traex_seen_by_l2', role: 'coder' }]);
  });

  it('resolves tenant-stable worker bot union ids from federation roster by lark app, name, or cliId', () => {
    const federationBots = [
      { larkAppId: 'cli_remote_traex', cliId: 'traex', name: 'traex-loopy(d2)', botUnionId: 'on_bot_traex' },
      { larkAppId: 'cli_remote_coco', cliId: 'coco', name: 'coco-loopy(d2)', botUnionId: 'on_bot_coco' },
    ];

    expect(resolveDispatchWorkerBotUnionIds({
      openIds: ['ou_seen_by_l2'],
      bots: [{ openId: 'ou_seen_by_l2', name: 'traex-loopy(d2)' }],
      workerNames: ['traex-loopy(d2)'],
      workerMetas: [{ larkAppId: 'cli_remote_traex', cliId: 'traex' }],
      federationBots,
    })).toEqual(['on_bot_traex']);

    expect(resolveDispatchWorkerBotUnionIds({
      openIds: ['coco'],
      bots: [{ openId: 'coco' }],
      workerNames: ['coco'],
      federationBots,
    })).toEqual(['on_bot_coco']);
  });

  it('prefers authoritative platform team bot union ids before learned or legacy federation sources', () => {
    expect(resolveDispatchWorkerBotUnionIds({
      openIds: ['ou_seen_by_l2'],
      bots: [{ openId: 'ou_seen_by_l2', name: 'traex-loopy' }],
      workerNames: ['traex-loopy'],
      workerMetas: [{ larkAppId: 'cli_traex', cliId: 'traex' }],
      platformTeamBots: [
        { larkAppId: 'cli_traex', cliId: 'traex', name: 'traex-loopy', botUnionId: 'on_platform_traex' },
      ],
      learnedBotUnionIdsByName: { 'traex-loopy': 'on_learned_traex' },
      federationBots: [
        { larkAppId: 'cli_traex', cliId: 'traex', name: 'traex-loopy', botUnionId: 'on_roster_traex' },
      ],
    })).toEqual(['on_platform_traex']);
  });

  it('resolves platform team bot union ids by lark app id even without a stable display name', () => {
    expect(resolveDispatchWorkerBotUnionIds({
      openIds: ['ou_seen_by_l2'],
      bots: [{ openId: 'ou_seen_by_l2' }],
      workerNames: ['ou_seen_by_l2'],
      workerMetas: [{ larkAppId: 'cli_remote_worker', cliId: '' }],
      platformTeamBots: [
        { larkAppId: 'cli_remote_worker', cliId: '', name: 'cli_remote_worker', botUnionId: 'on_platform_remote' },
      ],
      learnedBotUnionIdsByName: {},
      federationBots: [],
    })).toEqual(['on_platform_remote']);
  });

  it('prefers locally learned bot union ids by name before federation roster fallback', () => {
    expect(resolveDispatchWorkerBotUnionIds({
      openIds: ['ou_seen_by_l2'],
      bots: [{ openId: 'ou_seen_by_l2', name: 'traex-loopy' }],
      workerNames: ['traex-loopy'],
      workerMetas: [{ larkAppId: 'cli_traex', cliId: 'traex' }],
      learnedBotUnionIdsByName: { 'traex-loopy': 'on_learned_traex' },
      federationBots: [
        { larkAppId: 'cli_traex', cliId: 'traex', name: 'traex-loopy', botUnionId: 'on_roster_traex' },
      ],
    })).toEqual(['on_learned_traex']);
  });

  it('keeps index-aligned empty worker bot union ids when the federation match is ambiguous or absent', () => {
    expect(resolveDispatchWorkerBotUnionIds({
      openIds: ['codex'],
      bots: [{ openId: 'codex' }],
      federationBots: [
        { larkAppId: 'cli_a', cliId: 'codex', name: 'codex-a', botUnionId: 'on_a' },
        { larkAppId: 'cli_b', cliId: 'codex', name: 'codex-b', botUnionId: 'on_b' },
      ],
    })).toEqual(['']);
  });
});
