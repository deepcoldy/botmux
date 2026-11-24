import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestReplyDeliveryForRespawn } from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import type { DaemonSession } from '../src/core/types.js';

// Daemon-side carrier for `/restart`: the restart IPC brings the replyDelivery
// resolved from today's config, so the respawned CLI's prompt and the worker
// gate follow an edit made since the worker was forked.
describe('latestReplyDeliveryForRespawn (daemon-side carrier)', () => {
  afterEach(() => vi.restoreAllMocks());
  const makeSession = (cliId?: string): DaemonSession => ({
    larkAppId: 'cli_test',
    session: { sessionId: 's1', ...(cliId ? { cliId } : {}) },
  } as unknown as DaemonSession);
  const bot = (config: Record<string, unknown>) => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', ...config } } as any);
    vi.spyOn(botRegistry, 'resolveReplyDelivery').mockReturnValue(config.replyDelivery as any);
  };

  it('follows the per-CLI default when unconfigured (send except doubao), and an explicit transcript once set', () => {
    bot({ cliId: 'claude-code' });
    expect(latestReplyDeliveryForRespawn(makeSession())).toBe('send');
    bot({ cliId: 'claude-code', replyDelivery: 'transcript' });
    expect(latestReplyDeliveryForRespawn(makeSession())).toBe('transcript');
    bot({ cliId: 'doubao' });
    expect(latestReplyDeliveryForRespawn(makeSession())).toBe('transcript');
  });

  it('resolves for the CLI frozen on the session, not the bot default CLI', () => {
    bot({ cliId: 'claude-code', replyDelivery: 'transcript' });
    expect(latestReplyDeliveryForRespawn(makeSession('antigravity'))).toBe('send');
  });

  it('returns undefined when the bot lookup throws (worker keeps its snapshot)', () => {
    vi.spyOn(botRegistry, 'getBot').mockImplementation(() => { throw new Error('bot_not_found'); });
    expect(latestReplyDeliveryForRespawn(makeSession())).toBeUndefined();
  });
});
