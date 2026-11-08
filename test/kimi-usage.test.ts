import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeKimiSession, setLastPrompt, toolTurn, wire } from './helpers/kimi-wire-fixture.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';

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
        // A compaction call names its own (secondary) model: not the turn's.
        wire.llmRequest('kimi-code/k3-256k', 'low', 'compaction'),
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

  it('switches to a new Kimi generation of the session at once (`/new`, restart)', async () => {
    makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: prompt('old'), createdAt: Date.now() - 60_000,
      records: [wire.prompt(0, prompt('old')), wire.llmRequest('kimi-code/k3.1-pro-highspeed'), wire.usage(50_000, 5_000, 0), wire.measured(550_000)],
    });
    const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
    expect(getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true }).turnTokens).toEqual({ in: 50_000, out: 5_000 });
    // `/new` indexes the next session at once; its first prompt comes later.
    const b = makeKimiSession(home, { id: 'session_b', workDir: home, records: [] });
    expect(getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true }).turnTokens).toEqual({ in: 50_000, out: 5_000 });
    b.append([wire.prompt(0, prompt('new')), wire.llmRequest('kimi-code/k3.1-pro-highspeed'), wire.usage(700, 70, 0), wire.measured(770)]);
    setLastPrompt(b.dir, prompt('new'));
    const next = getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true });
    expect(next.turnTokens).toEqual({ in: 700, out: 70 });
    expect(next.context).toEqual({ usedTokens: 770, windowTokens: 1_048_576, percentUsed: 0 });
  });

  it('fresh reads re-resolve when a newer sibling session hides our generation from the stamp', async () => {
    const other = randomUUID();
    makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: prompt('old'),
      records: [wire.prompt(0, prompt('old')), wire.llmRequest('kimi-code/k3.1-pro-highspeed'), wire.usage(50_000, 5_000, 0), wire.measured(550_000)],
    });
    const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
    const query = () => getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: home, fresh: true });
    expect(query().turnTokens).toEqual({ in: 50_000, out: 5_000 });
    // Our `/new` session is indexed while still empty…
    const ours = makeKimiSession(home, { id: 'session_c_ours', workDir: home, records: [] });
    // …then a SIBLING conversation creates its session afterwards, becoming
    // the newest index entry the stamp watches.
    const sibling = makeKimiSession(home, { id: 'session_s_sibling', workDir: home, records: [] });
    sibling.append([wire.prompt(0, `<session_id>${other}</session_id>\nsibling`), wire.usage(1, 1, 0), wire.measured(2)]);
    setLastPrompt(sibling.dir, `<session_id>${other}</session_id>\nsibling`);
    // Our new generation is still empty: the lookup correctly keeps the old one.
    expect(query().turnTokens).toEqual({ in: 50_000, out: 5_000 });
    // Our first prompt lands in a session that is no longer the newest index
    // entry, so the stamp cannot see this write. A turn-boundary fresh read
    // must re-run the marker lookup instead of trusting the cached hit.
    ours.append([wire.prompt(0, prompt('new')), wire.llmRequest('kimi-code/k3.1-pro-highspeed'), wire.usage(700, 70, 0), wire.measured(770)]);
    setLastPrompt(ours.dir, prompt('new'));
    expect(query().turnTokens).toEqual({ in: 700, out: 70 });
  });

  it('reads the data dir a bot relocates with KIMI_CODE_HOME in its env', async () => {
    const botHome = mkdtempSync(join(tmpdir(), 'botmux-kimi-bothome-'));
    try {
      delete process.env.KIMI_CODE_HOME;
      writeFileSync(join(botHome, 'config.toml'), '[models."kimi-code/k3-256k"]\nmax_context_size = 262144\n');
      makeKimiSession(botHome, {
        id: 'session_a', workDir: botHome, lastPrompt: prompt('x'),
        records: [wire.prompt(0, prompt('x')), wire.llmRequest('kimi-code/k3-256k'), wire.usage(100, 10, 0), wire.measured(26_214)],
      });
      __testOnly_resetBotRegistry();
      registerBot({
        larkAppId: 'cli_kimi_usage_test', larkAppSecret: '', apiOnly: true, cliId: 'kimi', allowedUsers: [],
        env: { KIMI_CODE_HOME: botHome },
      });
      const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
      const snapshot = getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd: botHome, fresh: true, larkAppId: 'cli_kimi_usage_test' });
      expect(snapshot.tokens).toMatchObject({ inputTokens: 100, outputTokens: 10 });
      expect(snapshot.context).toEqual({ usedTokens: 26_214, windowTokens: 262_144, percentUsed: 10 });
    } finally {
      __testOnly_resetBotRegistry();
      rmSync(botHome, { recursive: true, force: true });
    }
  });
});
