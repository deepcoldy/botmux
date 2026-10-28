import { describe, expect, it, vi } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { __testOnly_sessionAgentConfig } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

function parse(cliId: string, model: string, effort: string, autoModels?: string[]) {
  return parseBotConfigsFromText(JSON.stringify([{
    larkAppId: 'shared',
    larkAppSecret: 'secret',
    cliId,
    model,
    reasoningEffort: effort,
    ...(autoModels ? { traexAutoModel: { enabled: true, models: autoModels } } : {}),
  }]))[0]!;
}

describe('handwritten shared TraeX effort', () => {
  it.each(['gpt-6-astra', 'seed-code'])('preserves shared effort with Auto candidate %s', model => {
    const parsed = parse('traex', 'auto', 'ultra', [model]);
    expect(parsed.reasoningEffort).toBe('ultra');
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    try {
      const ds = { larkAppId: 'shared', session: { cliId: 'traex' } } as Parameters<typeof __testOnly_sessionAgentConfig>[0];
      expect(__testOnly_sessionAgentConfig(ds, parsed).reasoningEffort).toBe('ultra');
      expect(ds.session.reasoningEffort).toBe('ultra');
    } finally {
      update.mockRestore();
    }
  });

  it.each([
    { model: 'deepseek-v4-pro', effort: 'xhigh', frozen: false },
    { model: 'deepseek-v4-pro', effort: 'xhigh', frozen: true },
    { model: 'future-traex-model', effort: 'ultra', frozen: false },
    { model: 'future-traex-model', effort: 'ultra', frozen: true },
  ])('preserves $model / $effort on launch (already frozen: $frozen)', ({ model, effort, frozen }) => {
    const parsed = parse('traex', model, effort);
    expect(parsed.reasoningEffort).toBe(effort);
    const ds = {
      larkAppId: 'shared',
      session: {
        cliId: 'traex',
        ...(frozen ? { agentFrozen: true, reasoningEffort: parsed.reasoningEffort } : {}),
      },
    } as Parameters<typeof __testOnly_sessionAgentConfig>[0];
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    try {
      expect(__testOnly_sessionAgentConfig(ds, parsed)).toMatchObject({ model, reasoningEffort: effort });
      expect(ds.session.reasoningEffort).toBe(effort);
    } finally {
      update.mockRestore();
    }
  });

  it('still rejects invalid effort syntax and preserves static capability validation for other CLIs', () => {
    expect(parse('traex', 'deepseek-v4-pro', 'unrecognized').reasoningEffort).toBeUndefined();
    const parsed = parse('codex', 'gpt-5.2', 'ultra');
    expect(parsed.reasoningEffort).toBeUndefined();
    const ds = { larkAppId: 'shared', session: { cliId: 'codex', reasoningEffort: 'ultra' } } as Parameters<typeof __testOnly_sessionAgentConfig>[0];
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    try {
      expect(__testOnly_sessionAgentConfig(ds, parsed).reasoningEffort).toBeUndefined();
      expect(ds.session.reasoningEffort).toBeUndefined();
    } finally {
      update.mockRestore();
    }
  });
});
