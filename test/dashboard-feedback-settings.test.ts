import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('Bot Defaults feedback settings', () => {
  it('keeps advanced feedback settings compact until the user expands them', () => {
    const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    const types = readFileSync(new URL('../src/dashboard/web/bot-defaults.ts', import.meta.url), 'utf8');
    const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
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
    expect(dashboard).toContain('/feedback$/');
    expect(dashboard).toContain('/chats\\/([^/]+)\\/feedback');
    expect(dashboard).toContain('feedback\\/effective');
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
