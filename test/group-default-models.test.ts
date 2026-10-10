import { describe, expect, it } from 'vitest';
import { parseGroupDefaultModels, normalizeGroupDefaultModels } from '../src/core/group-default-models.js';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';

describe('new-topic default models', () => {
  it('normalizes supported CLIs and clears empty overrides', () => {
    expect(parseGroupDefaultModels({ codex: ' custom-model ', 'claude-code': ' ' })).toEqual({ codex: 'custom-model' });
    expect(parseGroupDefaultModels({})).toEqual({});
    expect(normalizeGroupDefaultModels({ oc_a: { codex: 'a' }, oc_b: { 'claude-code': 'sonnet' }, oc_bad: null }))
      .toEqual({ oc_a: { codex: 'a' }, oc_b: { 'claude-code': 'sonnet' } });
  });
  for (const raw of [null, [], { gemini: 'flash' }, { codex: 2 }, { codex: 'x\nflag' }, { codex: 'x'.repeat(201) }]) {
    it(`rejects invalid config ${JSON.stringify(raw)}`, () => {
      expect(() => parseGroupDefaultModels(raw)).toThrow();
    });
  }
  it('uses the creation snapshot ahead of live bot defaults and honors explicit triggers', () => {
    const session = { cliId: 'codex', groupDefaultModels: { codex: 'group-model', 'claude-code': 'sonnet' } };
    expect(resolveSessionLaunchModel({ session }, { cliId: 'codex', model: 'bot-model' })).toBe('group-model');
    expect(resolveSessionLaunchModel({ session }, { cliId: 'claude-code', model: 'opus' })).toBe('group-model');
    expect(resolveSessionLaunchModel({ session, spawnModelOverride: 'trigger-model' }, { model: 'bot-model' })).toBe('trigger-model');
    expect(resolveSessionLaunchModel({ session: { ...session, cliId: 'claude-code' } }, { cliId: 'codex' })).toBe('sonnet');
  });
  it('preserves fallback and other CLIs including Codex App', () => {
    for (const cliId of ['codex', 'claude-code', 'gemini', 'codex-app']) {
      expect(resolveSessionLaunchModel({ session: { cliId } }, { cliId, model: 'bot' })).toBe('bot');
    }
    expect(resolveSessionLaunchModel({ session: { cliId: 'gemini', groupDefaultModels: { codex: 'codex-only' } } }, { cliId: 'gemini', model: 'flash' })).toBe('flash');
  });
});

it('does not apply topic defaults to chat-scoped, direct, or adopted sessions', () => {
  for (const extra of [{ scope: 'chat' as const }, { chatType: 'p2p' as const }, { adoptedFrom: { source: 'tmux' } }]) {
    expect(resolveSessionLaunchModel({ session: { cliId: 'codex', groupDefaultModels: { codex: 'topic' }, ...extra } }, { cliId: 'codex', model: 'bot' })).toBe('bot');
  }
});


it('accepts model and effort overrides while preserving legacy model strings', () => {
  expect(parseGroupDefaultModels({codex:{model:' gpt-5.6-sol ',reasoningEffort:'ultra'},'claude-code':'sonnet'}))
    .toEqual({codex:{model:'gpt-5.6-sol',reasoningEffort:'ultra'},'claude-code':'sonnet'});
  expect(parseGroupDefaultModels({codex:{model:'',reasoningEffort:''}})).toEqual({});
  expect(()=>parseGroupDefaultModels({codex:{reasoningEffort:'invalid'}})).toThrow();
  expect(()=>parseGroupDefaultModels({codex:{model:42}})).toThrow();
  expect(resolveSessionLaunchModel({session:{cliId:'codex',groupDefaultModels:{codex:{model:'group',reasoningEffort:'high'}}}}, {cliId:'codex',model:'global'})).toBe('group');
});
