import { describe, expect, it, vi } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { __testOnly_sessionAgentConfig } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';


describe('handwritten shared TraeX effort', () => {
  it.each(['gpt-6-astra', 'seed-code'])('preserves a syntactically valid shared effort for %s even when the static table lags', model => {
    const parsed = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'shared', larkAppSecret: 'secret', cliId: 'traex',
      model: 'auto', reasoningEffort: 'ultra', traexAutoModel: { enabled: true, models: [model] } }]))[0]!;
    expect(parsed.reasoningEffort).toBe('ultra');
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    try {
      expect(__testOnly_sessionAgentConfig({ larkAppId: 'shared', session: { cliId: 'traex', reasoningEffort: parsed.reasoningEffort } } as any, parsed).reasoningEffort).toBe('ultra');
    } finally { update.mockRestore(); }
  });

  it('still rejects invalid effort syntax and preserves static capability validation for other CLIs', () => {
    const parse = (cliId: string, effort: string) => parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'shared', larkAppSecret: 'secret', cliId, model: 'gpt-5.2', reasoningEffort: effort },
    ]))[0]!;
    expect(parse('traex', 'unrecognized').reasoningEffort).toBeUndefined();
    expect(parse('codex', 'ultra').reasoningEffort).toBeUndefined();
  });
});
