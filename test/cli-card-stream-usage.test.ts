import { describe, expect, it, vi } from 'vitest';
import { readCardStreamUsageSnapshot } from '../src/cli/card-stream-usage.js';

describe('readCardStreamUsageSnapshot', () => {
  it('returns four native buckets for an explicit custom stream without built-in card display gating', () => {
    const reader = vi.fn(() => ({
      context: null,
      turnTokens: null,
      tokens: {
        in: 160,
        out: 20,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheCreateTokens: 10,
        model: 'test',
        turns: 1,
      },
    }));
    const usage = readCardStreamUsageSnapshot({
      sessionId: 'sid_1',
      cliId: 'codex',
      cliSessionId: 'native_1',
      workingDir: '/repo',
    }, 'cli_app', reader);

    expect(reader).toHaveBeenCalledWith({
      cliId: 'codex',
      sessionId: 'sid_1',
      cliSessionId: 'native_1',
      cwd: '/repo',
      larkAppId: 'cli_app',
      fresh: true,
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheCreateTokens: 10,
      totalTokens: 180,
    });
  });

  it('returns null when the native reader has no usage instead of estimating', () => {
    expect(readCardStreamUsageSnapshot({ sessionId: 'sid_1' }, 'cli_app', () => ({
      context: null,
      tokens: null,
      turnTokens: null,
    }))).toBeNull();
  });
});
