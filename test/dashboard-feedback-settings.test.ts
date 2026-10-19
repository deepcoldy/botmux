import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { proxyRouteFor, resolveUpstream } from './helpers/daemon-proxy-harness.js';

describe('Bot Defaults feedback settings', () => {
  it('keeps advanced feedback settings compact until the user expands them', () => {
    const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    const types = readFileSync(new URL('../src/dashboard/web/bot-defaults.ts', import.meta.url), 'utf8');
    expect(types).toContain('FeedbackPolicyLayer');
    expect(page).toContain('最终回答反馈');
    expect(page).toContain('高级 JSON');
    expect(page).toContain('每聊天覆盖');
    expect(page).toContain('生效预览');
    expect(page).toContain('<details className="bd-feedback-advanced">');
    expect(page).toContain('高级配置（JSON 与聊天覆盖）');
    expect(page).toContain('最终回答卡片会显示“结论可用 / 有效推进 / 结论有误”等反馈按钮');
    expect(page).toContain('不了解 JSON 配置时保持默认即可');
    expect(page).toContain('聊天配置优先于 bot 默认配置');
    expect(page).toContain('在最终回答卡片中收集用户评价。');
    expect(page).toContain('rows={6}');
    expect(page).toContain('{chatId.trim() ? (');
    expect(css).toContain('.bd-tile textarea.bd-feedback-json');
    expect(css).toContain('max-height: 320px');
    expect(page).toContain('fetchGroupsSnapshot');
    expect(page).toContain('<select value={chatId}');
    expect(page).not.toContain('聊天 ID（从群组页选择/复制）');
    expect(page).toContain('/feedback`');
    // 前端调用的三条路径在 Dashboard 代理表里都有对应条目，且指向 daemon 的同名 IPC。
    const botFeedback = proxyRouteFor('PUT', '/api/bots/cli_a/feedback');
    expect(resolveUpstream(botFeedback!, '/api/bots/cli_a/feedback')).toBe('/api/bot-feedback');
    const chatFeedback = proxyRouteFor('PUT', '/api/bots/cli_a/chats/oc_1/feedback');
    expect(resolveUpstream(chatFeedback!, '/api/bots/cli_a/chats/oc_1/feedback')).toBe('/api/chat-feedback/oc_1');
    const effective = proxyRouteFor('GET', '/api/bots/cli_a/feedback/effective');
    expect(resolveUpstream(effective!, '/api/bots/cli_a/feedback/effective', '?chatId=oc_1'))
      .toBe('/api/feedback-effective?chatId=oc_1');
  });

  it('renders a local hosted-team feedback editor without a remote-team write path', () => {
    const page = readFileSync(new URL('../src/dashboard/web/team-federation-page.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/dashboard/web/team-federation.ts', import.meta.url), 'utf8');
    expect(page).toContain('HostedTeamFeedbackEditor');
    expect(api).toContain('updateHostedTeamFeedback');
    expect(api).toContain('/feedback`');
    expect(api).not.toContain('remote-feedback');
  });
});
