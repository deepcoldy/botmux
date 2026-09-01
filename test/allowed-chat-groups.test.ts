import { describe, it, expect, vi, beforeEach } from 'bun:test';

const mockWarn = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: (...a: any[]) => mockWarn(...a), error: vi.fn() },
}));

import { checkAllowedChatGroupsConfig } from '../src/services/allowed-chat-groups.js';

function makeBot(over: any = {}) {
  return {
    config: {
      larkAppId: 'app_a',
      larkAppSecret: 'secret',
      cliId: 'claude-code' as const,
      ...over,
    },
  } as any;
}

describe('checkAllowedChatGroupsConfig', () => {
  beforeEach(() => mockWarn.mockReset());

  it('warns when allowedChatGroups is set but allowedUsers has no owner', () => {
    checkAllowedChatGroupsConfig(makeBot({ allowedChatGroups: ['oc_team'], allowedUsers: [] }));
    expect(mockWarn).toHaveBeenCalledOnce();
  });

  it('does not warn when an owner exists in allowedUsers', () => {
    checkAllowedChatGroupsConfig(makeBot({ allowedChatGroups: ['oc_team'], allowedUsers: ['ou_admin'] }));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does not warn when allowedChatGroups is empty/absent', () => {
    checkAllowedChatGroupsConfig(makeBot({}));
    checkAllowedChatGroupsConfig(makeBot({ allowedChatGroups: [] }));
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
