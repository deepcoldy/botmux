import { describe, expect, it, vi } from 'vitest';
import {
  ensureBotChatGrantMatrix,
  ExactChatGrantClientError,
} from '../src/cli/exact-chat-grant-client.js';

describe('ensureBotChatGrantMatrix', () => {
  it('writes one receiver-scoped grant batch per participant', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const result = await ensureBotChatGrantMatrix('oc_room', ['cli_pm', 'cli_repo'], {
      secret: 'test-secret',
      findDaemon: larkAppId => ({ larkAppId, ipcPort: larkAppId === 'cli_pm' ? 4101 : 4102 }),
      request,
      retryDelaysMs: [],
    });

    expect(result.receivers).toEqual([
      { receiverLarkAppId: 'cli_pm', subjectLarkAppIds: ['cli_repo'] },
      { receiverLarkAppId: 'cli_repo', subjectLarkAppIds: ['cli_pm'] },
    ]);
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      receiverLarkAppId: 'cli_pm',
      subjectLarkAppIds: ['cli_repo'],
      chatId: 'oc_room',
    }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      receiverLarkAppId: 'cli_repo',
      subjectLarkAppIds: ['cli_pm'],
      chatId: 'oc_room',
    }));
  });

  it('fails closed before later receivers when one daemon is offline', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    await expect(ensureBotChatGrantMatrix('oc_room', ['cli_pm', 'cli_repo'], {
      secret: 'test-secret',
      findDaemon: larkAppId => larkAppId === 'cli_pm' ? { larkAppId, ipcPort: 4101 } : null,
      request,
      retryDelaysMs: [],
    })).rejects.toThrow('receiver daemon offline: cli_repo');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries idempotent membership propagation failures and then succeeds', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ExactChatGrantClientError('membership not ready', 409))
      .mockResolvedValue({ ok: true });
    await expect(ensureBotChatGrantMatrix('oc_room', ['cli_pm', 'cli_repo'], {
      secret: 'test-secret',
      findDaemon: larkAppId => ({ larkAppId, ipcPort: 4101 }),
      request,
      retryDelaysMs: [0],
    })).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('deduplicates participants and treats a solo participant as a no-op', async () => {
    const request = vi.fn();
    await expect(ensureBotChatGrantMatrix('oc_room', ['cli_pm', 'cli_pm', ''], {
      secret: 'test-secret',
      findDaemon: () => null,
      request,
    })).resolves.toEqual({ ok: true, chatId: 'oc_room', participants: ['cli_pm'], receivers: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
