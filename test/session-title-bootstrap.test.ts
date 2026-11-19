import { describe, it, expect } from 'vitest';
import { sessionTitleInput, applyAutomaticSessionTitle, hasManualSessionTitle } from '../src/core/session-title-content.js';
import { extractBotmuxLarkNativeSessionTitlePrompt, buildBotmuxLarkNativeSessionTitle, captureTitleBootstrap } from '../src/core/session-title.js';

const bootstrap = '你是本群的 oncall 协同助手。入群后先阅读群内可见的最近消息、卡片和转发内容，只做只读总结。';

describe('bootstrap-aware session titles', () => {
  it('defers configured group-join instructions, including wrapped inputs and mentions', () => {
    const raw = `<botmux_formatting>formatting only</botmux_formatting><user_message>@Assistant ${bootstrap}</user_message>`;
    expect(sessionTitleInput(raw, [{ name: 'Assistant' }], [bootstrap])).toEqual({ text: '', bootstrapOnly: true });
    expect(extractBotmuxLarkNativeSessionTitlePrompt(raw, [{ name: 'Assistant' }], [bootstrap])).toBeUndefined();
    expect(buildBotmuxLarkNativeSessionTitle(undefined, undefined, '监控支持群')).toContain('监控支持群');
  });
  it('uses the real question appended after a known bootstrap, even beyond the title limit', () => {
    const long = bootstrap.repeat(100);
    expect(extractBotmuxLarkNativeSessionTitlePrompt(long + '\n排查 application_123 队列拒绝', undefined, [long])).toBe('排查 application_123 队列拒绝');
  });
  it('does not suppress an unrelated role instruction or a real anchored question', () => {
    const question = '你是值班助手，请排查 rule 123 的执行失败';
    expect(extractBotmuxLarkNativeSessionTitlePrompt(question, undefined, [bootstrap])).toBe(question);
  });
  it('recognizes an already persisted bootstrap after the configured prompt changes', () => {
    const old = captureTitleBootstrap(bootstrap);
    expect(extractBotmuxLarkNativeSessionTitlePrompt(bootstrap, undefined, ['new configuration'], old)).toBeUndefined();
    expect(extractBotmuxLarkNativeSessionTitlePrompt(bootstrap + '\n排查 rule 123', undefined, ['new configuration'], old)).toBe('排查 rule 123');
  });
  it('updates canonical automatic titles without turning them into manual titles', () => {
    const state = { title: bootstrap, nativeSessionTitleUserDefined: false, titleSource: 'initial', titleUpdatedAt: '' };
    expect(applyAutomaticSessionTitle(state, '[BotMux·Lark] 监控支持群', 'initial', '2026-11-14T00:00:00Z')).toBe(true);
    expect(state.title).toBe('监控支持群');
    expect(state.nativeSessionTitleUserDefined).toBe(false);
    expect(applyAutomaticSessionTitle(state, '[BotMux·Lark] rule 123 队列拒绝', 'cli', '2026-11-14T01:00:00Z')).toBe(true);
    expect(state.title).toBe('rule 123 队列拒绝');
    expect(applyAutomaticSessionTitle(state, state.title, 'cli', '2026-11-14T02:00:00Z')).toBe(false);
  });
  it.each(['user', 'dashboard', 'agent'])('preserves a manual %s title against a late semantic result', titleSource => {
    const state = { title: '用户指定标题', titleSource };
    expect(hasManualSessionTitle(state)).toBe(true);
    expect(applyAutomaticSessionTitle(state, '迟到结果', 'cli', '2026-11-14T00:00:00Z')).toBe(false);
    expect(state.title).toBe('用户指定标题');
  });
  it('honors the existing manual flag independently of its source label', () => {
    const state = { title: 'Pinned title', titleSource: 'initial', nativeSessionTitleUserDefined: true };
    expect(applyAutomaticSessionTitle(state, 'new', 'cli', '2026-11-14T00:00:00Z')).toBe(false);
  });
});
