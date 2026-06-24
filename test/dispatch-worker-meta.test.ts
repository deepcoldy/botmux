import { describe, expect, it } from 'vitest';
import { resolveDispatchWorkerMetas } from '../src/core/dispatch-worker-meta.js';

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
});
