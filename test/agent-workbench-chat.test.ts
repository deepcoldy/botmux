import { describe, expect, it, vi } from 'vitest';
import {
  buildChatAppLink,
  buildWorkbenchLoginUrl,
  buildWorkbenchWebAppLink,
  openWorkbenchChat,
  type FeishuJsApi,
} from '../src/dashboard/web/agent-workbench-chat.js';

describe('Agent Workbench Feishu chat bridge', () => {
  it('uses PC toggleChat first when capability exists', async () => {
    const enterChat = vi.fn();
    const sdk: FeishuJsApi = {
      toggleChat(options) { options.success?.(); },
      enterChat,
    };
    await expect(openWorkbenchChat({ chatId: 'oc_1', preferSplit: true, sdk })).resolves.toEqual({ kind: 'native-split', method: 'toggleChat' });
    expect(enterChat).not.toHaveBeenCalled();
  });

  it('falls back in order to enterChat and then AppLink', async () => {
    const order: string[] = [];
    const sdk: FeishuJsApi = {
      toggleChat(options) { order.push('toggleChat'); options.fail?.({ errno: 1 }); },
      enterChat(options) { order.push('enterChat'); options.fail?.({ errno: 2 }); },
    };
    const opened: string[] = [];
    const result = await openWorkbenchChat({ chatId: 'oc_2', preferSplit: true, sdk, openExternal: url => opened.push(url) });
    expect(order).toEqual(['toggleChat', 'enterChat']);
    expect(result.kind).toBe('applink');
    expect(opened[0]).toContain('openChatId=oc_2');
  });

  it('is safe without a Feishu SDK and builds explicit appCenter/sidebar contracts', async () => {
    const opened: string[] = [];
    await expect(openWorkbenchChat({ chatId: 'oc_browser', preferSplit: true, sdk: null, openExternal: url => opened.push(url) }))
      .resolves.toMatchObject({ kind: 'applink', method: 'AppLink' });
    expect(buildChatAppLink('oc_browser')).toContain('/client/chat/open');
    const main = buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'main', targetOrigin: 'https://dash.example', sessionId: 's/1' });
    const dock = buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'dock', targetOrigin: 'https://dash.example', sessionId: 's/1' });
    expect(main).toContain('mode=appCenter');
    expect(main).toContain('lk_target_url=');
    expect(dock).toContain('mode=sidebar');
    expect(dock).toContain('min_width=350');
    expect(dock).toContain('max_width=520');
    expect(buildWorkbenchLoginUrl('/auth/feishu', 'dock', 's/1')).toContain('returnTo=');
    expect(buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'main', targetOrigin: 'https://[' })).toBeNull();
  });

  it('never follows a session-provided non-Feishu AppLink', async () => {
    const opened: string[] = [];
    const result = await openWorkbenchChat({
      chatId: 'oc_safe',
      appLink: 'javascript:alert(1)',
      preferSplit: false,
      sdk: null,
      openExternal: url => opened.push(url),
    });
    expect(result).toMatchObject({ kind: 'applink', method: 'AppLink' });
    expect(opened[0]).toMatch(/^https:\/\/applink\.feishu\.cn\/client\/chat\/open\?/);
    expect(opened[0]).toContain('openChatId=oc_safe');

    opened.length = 0;
    await openWorkbenchChat({
      chatId: 'oc_safe',
      appLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_other',
      preferSplit: false,
      sdk: null,
      openExternal: url => opened.push(url),
    });
    expect(opened[0]).toContain('openChatId=oc_safe');
    expect(opened[0]).not.toContain('oc_other');
  });
});
