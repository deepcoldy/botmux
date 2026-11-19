import { describe, expect, it } from 'vitest';
import { readTraexEffortComposer, validateTraexTopicEffortRestart } from '../src/utils/traex-session-effort.js';
import { resolveTopicReasoningEffort } from '../src/core/session-model.js';

const rule = '─'.repeat(80);
const screen = (effort = 'high', mode = '') => `${rule}\n❯ Explain this codebase\n${rule}\n  GPT-6.1-Sol${mode} ${effort} · /tmp/example · Context 97% left\n  ? for shortcuts`;
const request = { model: 'GPT-6.1-Sol', effort: 'medium' as const, nativeSessionId: 'native1' };
const cfg = { cliId: 'traex', cliSessionId: 'native1' };

describe('TraeX topic effort reload preflight', () => {
  it('reads an initialized empty composer and preserves standard context', () => {
    expect(readTraexEffortComposer(screen())).toEqual({ model: 'GPT-6.1-Sol', effort: 'high', variant: 'standard' });
    expect(validateTraexTopicEffortRestart(cfg, request, screen())).toEqual({ model: request.model, effort: 'high', variant: 'standard' });
  });
  it('keeps MAX distinct from the model identity', () => {
    expect(validateTraexTopicEffortRestart(cfg, request, screen('high', ' (MAX)'))?.variant).toBe('max');
  });
  it.each([
    ['draft', screen().replace('Explain this codebase', 'unsent user question')],
    ['menu', `${rule}\n  Select Model and Effort\n❯ 1. GPT-6.1-Sol\n  enter confirm | esc go back`],
    ['busy', `✧ Working… (1s • esc to interrupt)\n${screen()}`],
    ['other model', screen().replace('GPT-6.1-Sol', 'Gemini-3.1-Pro-Preview')],
  ])('refuses %s', (_name, value) => {
    expect(validateTraexTopicEffortRestart(cfg, request, value)).toBeUndefined();
  });
  it.each([
    { cliId: 'codex', cliSessionId: 'native1' },
    { ...cfg, cliSessionId: 'other-native' },
    { ...cfg, wrapperCli: 'ttadk traex' },
    { ...cfg, adoptMode: true },
    { ...cfg, workflowNodeSession: true },
    { ...cfg, traexAutoModel: { enabled: true } },
  ])('refuses an unsupported or replaced launch', value => {
    expect(validateTraexTopicEffortRestart(value, request, screen())).toBeUndefined();
  });
  it('refuses an effort the current model does not accept', () => {
    expect(validateTraexTopicEffortRestart(cfg, { ...request, effort: 'ultra' }, screen())).toBeUndefined();
  });
});

describe('model-bound topic preference on cold resume', () => {
  const session = { topicReasoningEffort: { model: 'GPT-6.1-Sol', effort: 'medium' as const } };
  it('uses the saved topic effort for the same model without changing the base preference', () => {
    expect(resolveTopicReasoningEffort(session, 'traex', 'GPT-6.1-Sol', 'high')).toBe('medium');
    expect(session.topicReasoningEffort.effort).toBe('medium');
  });
  it('keeps the base preference for a different model or CLI', () => {
    expect(resolveTopicReasoningEffort(session, 'traex', 'DeepSeek-V4-Pro', 'high')).toBe('high');
    expect(resolveTopicReasoningEffort(session, 'codex', 'GPT-6.1-Sol', 'high')).toBe('high');
  });
  it('ignores an invalid stored level instead of sending it at launch', () => {
    expect(resolveTopicReasoningEffort({ topicReasoningEffort: { model: 'GPT-6.1-Sol', effort: 'ultra' } }, 'traex', 'GPT-6.1-Sol', 'high')).toBe('high');
  });
});
