import { describe, expect, it } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

describe('Codex per-Bot reasoning effort', () => {
  it('preserves every supported startup effort and drops invalid values', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
    const configs = parseBotConfigsFromText(JSON.stringify([
      ...efforts.map((reasoningEffort, index) => ({
        larkAppId: `cli_effort_${index}`,
        larkAppSecret: 'secret',
        cliId: 'codex',
        reasoningEffort,
      })),
      {
        larkAppId: 'cli_effort_invalid',
        larkAppSecret: 'secret',
        cliId: 'codex',
        reasoningEffort: 'extreme',
      },
    ]));

    expect(configs.slice(0, efforts.length).map(config => config.reasoningEffort)).toEqual(efforts);
    expect(configs.at(-1)?.reasoningEffort).toBeUndefined();
  });
});
