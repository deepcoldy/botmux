import { describe, expect, it } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

describe('Codex per-Bot reasoning effort', () => {
  it('preserves every supported startup effort and drops invalid values', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh'] as const;
    const configs = parseBotConfigsFromText(JSON.stringify([
      ...efforts.map((reasoningEffort, index) => ({
        larkAppId: `cli_effort_${index}`,
        larkAppSecret: 'secret',
        cliId: 'codex',
        reasoningEffort,
      })),
      { larkAppId: 'codex-max', larkAppSecret: 'secret', cliId: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
      { larkAppId: 'codex-ultra', larkAppSecret: 'secret', cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
      { larkAppId: 'codex-invalid-pair', larkAppSecret: 'secret', cliId: 'codex', model: 'gpt-5.4', reasoningEffort: 'ultra' },
      {
        larkAppId: 'cli_effort_invalid',
        larkAppSecret: 'secret',
        cliId: 'codex',
        reasoningEffort: 'extreme',
      },
    ]));

    expect(configs.slice(0, efforts.length).map(config => config.reasoningEffort)).toEqual(efforts);
    expect(configs.find(config => config.larkAppId === 'codex-max')?.reasoningEffort).toBe('max');
    expect(configs.find(config => config.larkAppId === 'codex-ultra')?.reasoningEffort).toBe('ultra');
    expect(configs.find(config => config.larkAppId === 'codex-invalid-pair')?.reasoningEffort).toBeUndefined();
    expect(configs.at(-1)?.reasoningEffort).toBeUndefined();
  });

  it('drops reasoning effort from non-Codex bot configs', () => {
    const [config] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_non_codex_effort',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      reasoningEffort: 'high',
    }]));
    expect(config?.reasoningEffort).toBeUndefined();
  });
});
