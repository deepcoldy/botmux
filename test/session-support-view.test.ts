import { describe, it, expect } from 'vitest';
import { sessionDisplayTitle, sessionLastActivityAt, sessionSupportReason } from '../src/dashboard/web/sessions.js';

const bootstrap = '你是本群的 oncall 协同助手。入群后先阅读群内可见的最近消息、卡片和转发内容，只做只读总结。首';
describe('support session list metadata', () => {
  it('uses the group name for an old initial bootstrap title without rewriting the row', () => {
    const row = { title: bootstrap, titleSource: 'initial', chatDisplayName: '规则支持群', chatId: 'oc_example', chatType: 'group' };
    expect(sessionDisplayTitle(row)).toBe('规则支持群');
    expect(row.title).toBe(bootstrap);
  });
  it('keeps explicitly named and meaningful titles', () => {
    expect(sessionDisplayTitle({ title: bootstrap, titleSource: 'user', chatDisplayName: 'group' })).toBe(bootstrap);
    expect(sessionDisplayTitle({ title: 'rule 123 failed', chatDisplayName: 'group' })).toBe('rule 123 failed');
  });
  it('uses known latest activity and leaves unavailable timestamps unknown', () => {
    expect(sessionLastActivityAt({ lastActivityAt: 2000, lastMessageAt: 1000 })).toBe(2000);
    expect(sessionLastActivityAt({ lastActivityAt: 'unknown', lastMessageAt: 1000 })).toBe(1000);
    expect(sessionLastActivityAt({ lastActivityAt: null })).toBeUndefined();
  });
  it('shows actual attention reasons and does not promote unknown flags to blockers', () => {
    expect(sessionSupportReason({ agentAttention: { reason: '需要补充实例 ID' } })).toBe('需要补充实例 ID');
    expect(sessionSupportReason({ pendingRepo: 'unknown', tuiPromptActive: 'unknown' })).toBe('');
  });
  it('translates raised-hand and TUI prompt signals through dictionary keys instead of showing raw keys', () => {
    expect(sessionSupportReason({ agentAttention: { kind: 'help', at: 1 } })).toBe('待人工处理');
    expect(sessionSupportReason({ tuiPromptActive: true })).toBe('待你选择');
  });
});
