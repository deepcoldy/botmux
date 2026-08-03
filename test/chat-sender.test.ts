import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendMessage = vi.fn();
const mockBuildMarkdownCard = vi.fn();

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

vi.mock('../src/im/lark/md-card.js', () => ({
  buildMarkdownCard: (...args: unknown[]) => mockBuildMarkdownCard(...args),
}));

import { sendBotMarkdownToChat } from '../src/services/chat-sender.js';

describe('sendBotMarkdownToChat', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockBuildMarkdownCard.mockReset();
  });

  it('sends an interactive markdown card through the selected bot identity', async () => {
    mockBuildMarkdownCard.mockReturnValue('{"schema":"2.0"}');
    mockSendMessage.mockResolvedValue('om_welcome');

    await expect(sendBotMarkdownToChat({
      larkAppId: 'cli_claude',
      chatId: 'oc_work_group',
      markdown: '# Welcome',
      idempotencyKey: 'welcome-123',
      brand: 'Claude',
    })).resolves.toEqual({ messageId: 'om_welcome' });

    expect(mockBuildMarkdownCard).toHaveBeenCalledWith('# Welcome', undefined, 'Claude');
    expect(mockSendMessage).toHaveBeenCalledWith(
      'cli_claude',
      'oc_work_group',
      '{"schema":"2.0"}',
      'interactive',
      'welcome-123',
    );
  });
});
