import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Grok native usage snapshot', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const cwd = '/workspace/grok-usage-test';
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-grok-usage-'));
    process.env.GROK_HOME = root;
  });

  afterEach(() => {
    delete process.env.GROK_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  it('reads context from signals.json and cumulative tokens from turn_completed', async () => {
    const sessionDir = join(root, 'sessions', encodeURIComponent(cwd), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const terminal = (
      inputTokens: number,
      outputTokens: number,
      cachedReadTokens: number,
      cacheCreationTokens: number,
      model: string,
    ) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'turn_completed',
          usage: {
            inputTokens,
            outputTokens,
            cachedReadTokens,
            cacheCreationTokens,
            modelUsage: { [model]: { inputTokens, outputTokens } },
          },
        },
      },
    });
    writeFileSync(join(sessionDir, 'updates.jsonl'), `${[
      { params: { update: { sessionUpdate: 'user_message_chunk', _meta: { totalTokens: 50, modelId: 'grok-4.6' } } } },
      terminal(100, 10, 40, 10, 'grok-4.6-build'),
      terminal(200, 20, 100, 20, 'grok-4.6-build'),
    ].map(value => JSON.stringify(value)).join('\n')}\n`);
    writeFileSync(join(sessionDir, 'signals.json'), JSON.stringify({
      contextTokensUsed: 28_872,
      contextWindowTokens: 500_000,
      contextWindowUsage: 5,
      primaryModelId: 'grok-4.6',
    }));
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({
      reasoning_effort: 'high',
    }));

    const { getSessionUsageSnapshot, __resetSessionUsageCachesForTest } = await import('../src/core/cost-calculator.js');
    const { cliSupportsNativeUsage } = await import('../src/services/transcript-resolver.js');
    __resetSessionUsageCachesForTest();

    expect(cliSupportsNativeUsage('grok')).toBe(true);
    const snapshot = getSessionUsageSnapshot({ cliId: 'grok', sessionId, cwd, fresh: true });
    expect(snapshot.context).toEqual({
      usedTokens: 28_872,
      windowTokens: 500_000,
      percentUsed: 5,
    });
    expect(snapshot.tokens?.in).toBe(300);
    expect(snapshot.tokens?.out).toBe(30);
    expect(snapshot.tokens?.inputTokens).toBe(130);
    expect(snapshot.tokens?.cacheReadTokens).toBe(140);
    expect(snapshot.tokens?.cacheCreateTokens).toBe(30);
    expect(snapshot.tokens?.turns).toBe(2);
    expect(snapshot.turnTokens).toEqual({ in: 200, out: 20 });
    expect(snapshot.model).toBe('grok-4.6');
    expect(snapshot.reasoningEffort).toBe('high');

    writeFileSync(join(sessionDir, 'signals.json'), JSON.stringify({
      contextTokensUsed: 100_000,
      contextWindowTokens: 256_000,
      contextWindowUsage: 39,
      primaryModelId: 'grok-experimental',
    }));
    const refreshed = getSessionUsageSnapshot({ cliId: 'grok', sessionId, cwd });
    expect(refreshed.context).toEqual({
      usedTokens: 100_000,
      windowTokens: 256_000,
      percentUsed: 39,
    });
    expect(refreshed.model).toBe('grok-experimental');
    expect(refreshed.reasoningEffort).toBe('high');
  });

  it('reads first-turn model from update._meta even when params._meta has no modelId', async () => {
    const sessionDir = join(root, 'sessions', encodeURIComponent(cwd), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'updates.jsonl'), `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        _meta: { eventId: `${sessionId}-3`, agentTimestampMs: 1 },
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
          _meta: { modelId: 'grok-4.6', promptIndex: 0 },
        },
      },
    })}\n${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        _meta: { totalTokens: 22_098, eventId: `${sessionId}-61` },
        update: { sessionUpdate: 'tool_call_update', status: 'completed' },
      },
    })}\n`);
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({
      current_model_id: 'grok-4.6',
      reasoning_effort: 'high',
    }));

    const { getSessionUsageSnapshot, __resetSessionUsageCachesForTest } = await import('../src/core/cost-calculator.js');
    __resetSessionUsageCachesForTest();

    const snapshot = getSessionUsageSnapshot({ cliId: 'grok', sessionId, cwd, fresh: true });
    expect(snapshot.context).toEqual({ usedTokens: 22_098 });
    expect(snapshot.tokens).toBeNull();
    expect(snapshot.turnTokens).toBeNull();
    expect(snapshot.model).toBe('grok-4.6');
    expect(snapshot.reasoningEffort).toBe('high');
  });

  it('falls back to summary.current_model_id when signals.json is still missing', async () => {
    const sessionDir = join(root, 'sessions', encodeURIComponent(cwd), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'updates.jsonl'), `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        _meta: { totalTokens: 10_500, eventId: `${sessionId}-30` },
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      },
    })}\n`);
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({
      current_model_id: 'grok-4.6',
      reasoning_effort: 'high',
    }));

    const { getSessionUsageSnapshot, __resetSessionUsageCachesForTest } = await import('../src/core/cost-calculator.js');
    __resetSessionUsageCachesForTest();

    const snapshot = getSessionUsageSnapshot({ cliId: 'grok', sessionId, cwd, fresh: true });
    expect(snapshot.context).toEqual({ usedTokens: 10_500 });
    expect(snapshot.model).toBe('grok-4.6');
    expect(snapshot.reasoningEffort).toBe('high');
  });
});
