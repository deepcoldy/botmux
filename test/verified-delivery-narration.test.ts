import { describe, expect, it } from 'vitest';
import { buildGoalNarrationText, emitGoalNarration } from '../src/verified-delivery/narration.js';

describe('verified delivery narration', () => {
  it('renders human-readable lifecycle messages', () => {
    expect(buildGoalNarrationText({
      type: 'accepted',
      key: 'k1',
      taskId: 'task-1',
      title: '写报告',
      mode: '自动对账',
    })).toContain('✅ 已验收 · task-1');

    expect(buildGoalNarrationText({
      type: 'human-decision',
      key: 'k2',
      source: '主群回复中控',
      decisionText: '换方案 B',
    })).toContain('来源：主群回复中控 → 监管者处理中');
  });

  it('dedupes by narration key', async () => {
    const sent: string[] = [];
    const event = {
      type: 'rejected' as const,
      key: `test-narr-dedupe-${Date.now()}`,
      taskId: 'task-2',
      reason: 'check_failed',
    };
    const first = await emitGoalNarration({ larkAppId: 'cli', goalChatId: 'oc_goal', event }, {
      sendMessage: async (_app, _chat, content) => {
        sent.push(content);
        return 'om_1';
      },
    });
    const second = await emitGoalNarration({ larkAppId: 'cli', goalChatId: 'oc_goal', event }, {
      sendMessage: async (_app, _chat, content) => {
        sent.push(content);
        return 'om_2';
      },
    });

    expect(first.sent).toBe(true);
    expect(second.deduped).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

