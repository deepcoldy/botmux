import { describe, expect, it } from 'vitest';
import { buildSessionControlPendingCard } from '../src/im/lark/session-control-pending-card.js';

describe('session control pending card', () => {
  it.each([
    ['close', '正在关闭会话'],
    ['resume', '正在恢复会话'],
  ] as const)('renders a button-free %s progress card', (action, title) => {
    const card = JSON.parse(buildSessionControlPendingCard(action, 'zh'));

    expect(card).toMatchObject({
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { content: expect.stringContaining(title) } },
      elements: [{ tag: 'markdown' }],
    });
    expect(card.schema).toBeUndefined();
    expect(card.body).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('"tag":"button"');
    expect(JSON.stringify(card)).toContain('无需重复点击');
  });
});
