import { beforeEach, describe, expect, it, vi } from 'bun:test';

const larkGet = vi.fn();
const getBotClient = vi.fn(() => ({ marker: true }));

vi.mock('../src/bot-registry.js', () => ({ getBotClient }));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/tmp/botmux-test' } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/im/lark/client.js', () => ({
  larkGet,
  getMessageDetail: vi.fn(),
}));

describe('resolveVerifiedUserIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always reads the exact current open_id from the contact API', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          name: 'Current User',
          email: 'personal@example.com',
          enterprise_email: 'current.user@bytedance.com',
        },
      },
    });
    const { resolveVerifiedUserIdentity } = await import('../src/im/lark/identity-cache.js');

    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toEqual({
      openId: 'ou_current',
      type: 'user',
      name: 'Current User',
      email: 'current.user@bytedance.com',
    });
    expect(larkGet).toHaveBeenCalledWith(
      { marker: true },
      '/open-apis/contact/v3/users/ou_current',
      { user_id_type: 'open_id' },
    );
  });

  it('fails closed on a missing or failed contact result', async () => {
    larkGet.mockResolvedValue({ code: 41050 });
    const { resolveVerifiedUserIdentity } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toBeUndefined();

    larkGet.mockRejectedValueOnce(new Error('network'));
    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toBeUndefined();
  });
});
