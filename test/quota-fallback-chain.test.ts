import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBotConfigs } from '../src/bot-registry.js';
import {
  buildQuotaFallbackPrompt,
  nextQuotaFallbackStep,
  normalizeQuotaFallbackChainConfig,
  quotaFallbackAgentLabel,
} from '../src/services/quota-fallback-chain.js';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';

const CLAUDE_BOT = { cliId: 'claude-code' as const, model: 'claude-opus-5-5' };

describe('quotaFallbackChain config', () => {
  it('normalizes a Claude → TraeX → TraeX chain with both limit kinds by default', () => {
    expect(normalizeQuotaFallbackChainConfig({
      enabled: true,
      steps: [{ cliId: 'traex', model: ' GPT-6.1-Sol ' }, { cliId: 'traex', model: 'DeepSeek-V4.1-Flash' }],
    }, CLAUDE_BOT)).toEqual({
      config: {
        enabled: true,
        kinds: ['usage', 'rate'],
        steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'traex', model: 'DeepSeek-V4.1-Flash' }],
      },
    });
  });

  it('keeps a blank model as the CLI default and ignores a disabled block', () => {
    expect(normalizeQuotaFallbackChainConfig({ enabled: true, kinds: ['usage'], steps: [{ cliId: 'codex', model: '' }] }, CLAUDE_BOT))
      .toEqual({ config: { enabled: true, kinds: ['usage'], steps: [{ cliId: 'codex' }] } });
    expect(normalizeQuotaFallbackChainConfig({ enabled: false, steps: 'draft' }, CLAUDE_BOT)).toEqual({});
    expect(normalizeQuotaFallbackChainConfig(undefined, CLAUDE_BOT)).toEqual({});
  });

  it.each([
    ['returns to a CLI it left', [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'claude-code', model: 'sonnet' }], /returns to claude-code/],
    ['repeats the bot default', [{ cliId: 'claude-code', model: 'claude-opus-5-5' }], /repeats the previous/],
    ['repeats the previous step', [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'traex', model: 'GPT-6.1-Sol' }], /repeats the previous/],
    ['names an unknown CLI', [{ cliId: 'not-a-cli' }], /supported CLI id/],
    ['names a retired CLI', [{ cliId: 'gemini' }], /supported CLI id/],
    ['names a remote CLI', [{ cliId: 'riff' }], /run locally/],
    ['uses the virtual auto model', [{ cliId: 'traex', model: 'auto' }], /concrete model id/],
    ['has no steps', [], /at least one step/],
    ['stays on a CLI without naming a model', [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'traex' }], /model is required/],
  ])('rejects a chain that %s', (_name, steps, error) => {
    const result = normalizeQuotaFallbackChainConfig({ enabled: true, steps }, CLAUDE_BOT);
    expect(result.config).toBeUndefined();
    expect(result.error).toMatch(error);
  });

  it('loads a valid chain from bots.json and disables an invalid one as a unit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-chain-load-'));
    const path = join(dir, 'bots.json');
    const previous = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = path;
      writeFileSync(path, JSON.stringify([
        { larkAppId: 'cli_chainok', larkAppSecret: 'fixture', cliId: 'claude-code',
          quotaFallbackChain: { enabled: true, steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }] } },
        { larkAppId: 'cli_chainbad', larkAppSecret: 'fixture', cliId: 'claude-code',
          quotaFallbackChain: { enabled: true, steps: [{ cliId: 'traex' }, { cliId: 'claude-code' }] } },
      ]));
      expect(loadBotConfigs().map(bot => bot.quotaFallbackChain)).toEqual([
        { enabled: true, kinds: ['usage', 'rate'], steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }] },
        undefined,
      ]);
    } finally {
      if (previous === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the bot-level launch constraints of a per-session CLI choice', () => {
    expect(normalizeQuotaFallbackChainConfig({ enabled: true, steps: [{ cliId: 'claude-code' }] },
      { cliId: 'codex', codexRpcInput: true }).error).toMatch(/codexRpcInput/);
    expect(normalizeQuotaFallbackChainConfig({ enabled: true, steps: [{ cliId: 'traex' }] },
      { cliId: 'codex', codexRpcInput: true }).config).toBeDefined();
    expect(normalizeQuotaFallbackChainConfig({ enabled: true, steps: [{ cliId: 'traex' }] },
      { cliId: 'claude-code', backendType: 'riff' }).error).toMatch(/remote backends/);
  });
});

describe('quotaFallbackChain progression', () => {
  const config = normalizeQuotaFallbackChainConfig({
    enabled: true,
    kinds: ['usage'],
    steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'traex', model: 'DeepSeek-V4.1-Flash' }],
  }, CLAUDE_BOT).config!;

  it('moves forward one step per limit and stops at the end of the chain', () => {
    const first = nextQuotaFallbackStep(config, undefined, 'usage');
    expect(first?.state).toEqual({ step: 1, cliId: 'traex', model: 'GPT-6.1-Sol' });
    const second = nextQuotaFallbackStep(config, first!.state, 'usage');
    expect(second?.state).toEqual({ step: 2, cliId: 'traex', model: 'DeepSeek-V4.1-Flash' });
    expect(nextQuotaFallbackStep(config, second!.state, 'usage')).toBeUndefined();
  });

  it('only reacts to the configured limit kinds', () => {
    expect(nextQuotaFallbackStep(config, undefined, 'rate')).toBeUndefined();
    expect(nextQuotaFallbackStep(undefined, undefined, 'usage')).toBeUndefined();
  });

  it('launches the step model on its CLI, including the CLI default and the bot CLI', () => {
    const bot = { cliId: 'claude-code' as const, model: 'claude-opus-5-5' };
    const session = (quotaFallback: any, cliId = 'claude-code') => ({ session: { cliId, quotaFallback } } as any);
    expect(resolveSessionLaunchModel(session({ step: 1, cliId: 'claude-code', model: 'sonnet' }), bot)).toBe('sonnet');
    expect(resolveSessionLaunchModel(session({ step: 1, cliId: 'traex' }, 'traex'), bot)).toBeUndefined();
    expect(resolveSessionLaunchModel(session({ step: 1, cliId: 'traex', model: 'GPT-6.1-Sol' }, 'traex'), bot)).toBe('GPT-6.1-Sol');
    expect(resolveSessionLaunchModel(session(undefined), bot)).toBe('claude-opus-5-5');
  });
});

describe('quotaFallbackChain handoff prompt', () => {
  const base = {
    from: quotaFallbackAgentLabel('claude-code', 'claude-opus-5-5'),
    to: quotaFallbackAgentLabel('traex', 'GPT-6.1-Sol'),
    userPrompt: '把登录页的报错修掉',
    locale: 'zh' as const,
  };

  it('points a fresh CLI at the topic history, the previous transcript and the workspace', () => {
    const prompt = buildQuotaFallbackPrompt({ ...base, freshCli: true, transcriptPath: '/tmp/claude/s.jsonl' });
    expect(prompt).toContain('Claude · claude-opus-5-5');
    expect(prompt).toContain('TRAE · GPT-6.1-Sol');
    expect(prompt).toContain('botmux history');
    expect(prompt).toContain('/tmp/claude/s.jsonl');
    expect(prompt).toContain('git status');
    expect(prompt.endsWith('把登录页的报错修掉')).toBe(true);
  });

  it('falls back to the topic history when the previous session file is unknown', () => {
    const prompt = buildQuotaFallbackPrompt({ ...base, freshCli: true });
    expect(prompt).toContain('会话记录没找到');
    expect(prompt).toContain('botmux history');
  });

  it('asks a resumed conversation only to continue the interrupted request', () => {
    const prompt = buildQuotaFallbackPrompt({ ...base, freshCli: false });
    expect(prompt).not.toContain('botmux history');
    expect(prompt.endsWith('把登录页的报错修掉')).toBe(true);
  });
});
