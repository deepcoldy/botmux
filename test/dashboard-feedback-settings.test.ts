import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Bot Defaults feedback settings', () => {
  it('renders an off-by-default toggle and advanced JSON editor with a dedicated save route', () => {
    const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
    const types = readFileSync(new URL('../src/dashboard/web/bot-defaults.ts', import.meta.url), 'utf8');
    const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
    expect(types).toContain('FeedbackPolicyLayer');
    expect(page).toContain('最终回答反馈');
    expect(page).toContain('高级 JSON');
    expect(page).toContain('每聊天覆盖');
    expect(page).toContain('生效预览');
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
