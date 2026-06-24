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

    const decision = buildGoalNarrationText({
      type: 'human-decision',
      key: 'k2',
      source: '主群回复中控',
      decisionText: '换方案 B',
    });
    expect(decision).toContain('来源：主群回复中控 → 监管者处理中');
    // F2: neutral title — a reply may be a decision, a question, or a correction.
    expect(decision).toContain('👤 人类回复已送达监管者');
    expect(decision).not.toContain('人类决策已送达');

    // F1: leading @mentions (auto-added when routed through the panel bot) are
    // stripped so the card shows just the human's words.
    const withMention = buildGoalNarrationText({
      type: 'human-decision',
      key: 'k3',
      source: '主群回复中控',
      decisionText: '@loopy-中控 A',
    });
    expect(withMention).toContain('内容：A');
    expect(withMention).not.toContain('@loopy-中控');
  });

  it('dedupes by narration key', async () => {
    const sent: string[] = [];
    const event = {
      type: 'rejected' as const,
      key: `test-narr-dedupe-${Date.now()}`,
      taskId: 'task-2',
      reason: 'check_failed',
    };
    const noopRecord = () => {}; // keep the test off the real session data dir
    const first = await emitGoalNarration({ larkAppId: 'cli', goalChatId: 'oc_goal', event }, {
      sendMessage: async (_app, _chat, content) => {
        sent.push(content);
        return 'om_1';
      },
      recordNarration: noopRecord,
    });
    const second = await emitGoalNarration({ larkAppId: 'cli', goalChatId: 'oc_goal', event }, {
      sendMessage: async (_app, _chat, content) => {
        sent.push(content);
        return 'om_2';
      },
      recordNarration: noopRecord,
    });

    expect(first.sent).toBe(true);
    expect(second.deduped).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

