import { beforeEach, describe, expect, it, vi } from 'vitest';
const { readBackground } = vi.hoisted(() => ({ readBackground: vi.fn() }));
vi.mock('../src/services/group-context-prompt.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/group-context-prompt.js')>()),
  groupContextForPrompt: readBackground,
}));
import { buildNewTopicCliInput, buildFollowUpCliInput, buildGroupContextBridgeInput } from '../src/core/session-manager.js';

const background = '<shared_group_context trust="untrusted"><message sender_type="user">保留瀑布，取消蒸汽火车</message></shared_group_context>';
beforeEach(() => {
  readBackground.mockReset();
  readBackground.mockReturnValue({ body: background, attachments: [{ type: 'image', name: 'earlier.png', path: '/tmp/earlier.png' }] });
});
const options = { larkAppId: 'cli_group', chatId: 'oc_room', turnId: 'om_next' };

describe('shared group history reaches native inputs', () => {
  it('omits both legacy history markup and Codex App history entries for an empty incremental turn', () => {
    readBackground.mockReturnValue({ body: '', attachments: [], nativeInputSeqs: [12] });
    const legacy = buildFollowUpCliInput('继续', 'sid', { ...options, cliId: 'codex' });
    expect(legacy.content).not.toContain('shared_group_context');
    const app = buildFollowUpCliInput('继续', 'sid', { ...options, cliId: 'codex-app' });
    expect(app.codexAppInput?.text).toBe('继续');
    expect(Object.keys(app.codexAppInput?.additionalContext ?? {}).some(key => key.startsWith('botmux_group_history'))).toBe(false);
    expect(app.codexAppInput?.localImages).toBeUndefined();
  });
  it('places history before the current request in a legacy opener', () => {
    const built = buildNewTopicCliInput('最终计划？', 'sid', 'codex', undefined, undefined, undefined, undefined, undefined, undefined, 'zh', undefined, options);
    expect(built.content).toContain(background);
    expect(built.content.indexOf(background)).toBeLessThan(built.content.indexOf('<user_message>'));
    expect(built.content).toContain('/tmp/earlier.png');
  });
  it('keeps peer history out of Codex App user text but includes it as untrusted context and native images', () => {
    const built = buildNewTopicCliInput('最终计划？', 'sid', 'codex-app', undefined, undefined, undefined, undefined, undefined, undefined, 'zh', undefined, options);
    expect(built.codexAppInput?.text).toBe('最终计划？');
    const parts = Object.entries(built.codexAppInput?.additionalContext ?? {}).filter(([key]) => key.startsWith('botmux_group_history'));
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every(([, value]) => value.kind === 'untrusted')).toBe(true);
    expect(parts.map(([, value]) => value.value).join('')).toContain(background);
    expect(built.codexAppInput?.localImages).toContainEqual({ path: '/tmp/earlier.png', detail: 'original' });
  });
  it('includes the same background on subsequent turns', () => {
    const built = buildFollowUpCliInput('继续', 'sid', { ...options, cliId: 'codex-app' });
    expect(built.content).toContain(background);
    expect(JSON.stringify(built.codexAppInput?.additionalContext)).toContain('保留瀑布');
    expect(built.codexAppInput?.text).toBe('继续');
  });
  it('keeps zero-injection, absent turn identity, and API-only traffic unchanged', () => {
    const built = buildFollowUpCliInput('raw', 'sid', { ...options, cliId: 'codex', promptInjection: 'none' });
    expect(built.content).toBe('raw');
    expect(readBackground).not.toHaveBeenCalled();
    const missingTurn = buildFollowUpCliInput('raw', 'sid', { larkAppId: options.larkAppId, chatId: options.chatId, cliId: 'codex' });
    expect(missingTurn.content).not.toContain('shared_group_context');
    const api = buildFollowUpCliInput('raw', 'sid', { ...options, chatId: 'http_async_x', cliId: 'codex' });
    expect(api.content).not.toContain('shared_group_context');
  });
  it('preserves the raw bridge contract while attaching opted-in background', () => {
    const built = buildGroupContextBridgeInput('继续', 'sid', { ...options, cliId: 'codex' });
    expect(built).toContain(background);
    expect(built).toContain('继续');
    expect(built).not.toContain('botmux_reminder');
    expect(built).not.toContain('botmux send');
    expect(buildGroupContextBridgeInput('/compact', 'sid', { ...options, cliId: 'codex' })).toBe('/compact');
  });
});
