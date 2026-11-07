import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeKimiSession, toolTurn, wire } from './helpers/kimi-wire-fixture.js';

describe('Kimi native usage snapshot', () => {
  let home: string;
  let sessionId: string;
  const prompt = (text: string) => `<session_id>${sessionId}</session_id>\n${text}`;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-kimi-usage-'));
    process.env.KIMI_CODE_HOME = home;
    sessionId = randomUUID();
    writeFileSync(join(home, 'config.toml'), '[models."kimi-code/k3.1-pro-highspeed"]\nmax_context_size = 1048576\n');
    const { __resetSessionUsageCachesForTest } = await import('../src/core/cost-calculator.js');
    __resetSessionUsageCachesForTest();
  });

  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('sums usage.record once per model call and reports this turn, context, window and model', async () => {
    makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: prompt('second'),
      records: [
        wire.metadata(),
        ...toolTurn(0, prompt('first')),
        // Turn 1: a compaction call (usageScope "session") and a sub-agent's
        // own usage line, then one normal step.
        wire.turnStarted(1),
        wire.prompt(1, prompt('second')),
        wire.usage(30_000, 1_000, 2_000, 0, { scope: 'session' }),
        wire.rebased(9_000),
        wire.usage(999_999, 999_999, 0, 0, { agentId: 'agent-0' }),
        wire.measured(999_999, 'agent-0'),
        wire.llmRequest('kimi-code/k3.1-pro-highspeed', 'high'),
        wire.usage(400, 60, 8_000, 0),
        wire.measured(9_460),
        wire.stepEnd('end_turn', { inputOther: 400, output: 60, inputCacheRead: 8_000, inputCacheCreation: 0 }),
        wire.agentTurnEnded(1, 'done'),
      ],
    });
    const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
    const { cliSupportsNativeUsage } = await import('../src/services/transcript-resolver.js');
    expect(cliSupportsNativeUsage('kimi')).toBe(true);

    const snapshot = getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true });
    // Turn 0: 1000+300 / 200+50 / cache 5000+6200 / create 100. Turn 1: compaction + one step.
    const inputTokens = 1_000 + 300 + 30_000 + 400;
    const cacheRead = 5_000 + 6_200 + 2_000 + 8_000;
    const cacheCreate = 100;
    expect(snapshot.tokens).toMatchObject({
      inputTokens,
      outputTokens: 200 + 50 + 1_000 + 60,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
      in: inputTokens + cacheRead + cacheCreate,
      out: 200 + 50 + 1_000 + 60,
      turns: 4,
    });
    // "This turn" = turn 1 only; prompt side excludes cache reads (Claude convention).
    expect(snapshot.turnTokens).toEqual({ in: 30_000 + 400, out: 1_000 + 60 });
    expect(snapshot.context).toEqual({ usedTokens: 9_460, windowTokens: 1_048_576, percentUsed: 1 });
    expect(snapshot.model).toBe('kimi-code/k3.1-pro-highspeed');
    expect(snapshot.reasoningEffort).toBe('high');
  });

  it('reports nothing for a session without the botmux marker', async () => {
    makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: 'local', records: toolTurn(0, 'local') });
    const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
    const snapshot = getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true });
    expect(snapshot.tokens).toBeNull();
    expect(snapshot.context).toBeNull();
  });

  it('omits the window when the model is not configured', async () => {
    makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: prompt('x'),
      records: [wire.prompt(0, prompt('x')), wire.llmRequest('kimi-code/unknown'), wire.usage(10, 1, 0), wire.measured(11)],
    });
    const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
    const snapshot = getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true });
    expect(snapshot.context).toEqual({ usedTokens: 11 });
  });
});
