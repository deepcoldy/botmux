import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/bot-registry.js')>()),
  resolveUsageDisplay: () => 'streaming',
}));

const { getDaemonStreamingCardUsageSnapshot } = await import('../src/core/worker-pool.js');

function remoteSession(generation = 2): DaemonSession {
  return {
    larkAppId: 'cli_remote_usage',
    session: {
      sessionId: 'remote-usage-session',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      model: 'configured-model',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
      },
      remoteRunnerUsage: {
        generation,
        snapshot: {
          context: { usedTokens: 7274, windowTokens: 258400, percentUsed: 2.815 },
          tokens: { in: 7230, out: 44 },
          turnTokens: { in: 7230, out: 44 },
          model: 'GPT-5.4',
          reasoningEffort: 'high',
        },
      },
    },
  } as unknown as DaemonSession;
}

describe('remote runner card usage', () => {
  it('uses the provider-native snapshot and observed runtime identity', () => {
    expect(getDaemonStreamingCardUsageSnapshot(remoteSession(), 'remote-runner'))
      .toMatchObject({
        context: { usedTokens: 7274, windowTokens: 258400, percentUsed: 2.815 },
        tokens: { in: 7230, out: 44 },
        turnTokens: { in: 7230, out: 44 },
        model: 'GPT-5.4',
        reasoningEffort: 'high',
      });
  });

  it('ignores a snapshot from a stale remote generation', () => {
    const snapshot = getDaemonStreamingCardUsageSnapshot(remoteSession(1), 'remote-runner');
    expect(snapshot.context).toBeNull();
    expect(snapshot.tokens).toBeNull();
    expect(snapshot.model).toBe('configured-model');
  });
});
