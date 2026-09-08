import { describe, expect, it, vi } from 'vitest';

import { executeChatRename } from '../src/core/chat-rename-operation.js';
import type { RenameChatResult } from '../src/services/groups-store.js';
import type { Session } from '../src/types.js';

function session(sessionId: string, chatId: string, name: string): Session {
  return {
    sessionId,
    chatId,
    rootMessageId: 'om_root',
    title: 'test',
    status: 'active',
    cliId: 'codex',
    workingDir: '/tmp',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    chatDisplayName: name,
  } as Session;
}

function deps(result: RenameChatResult, sessions: Session[] = []) {
  return {
    renameChat: vi.fn(async () => result),
    activeSessions: () => sessions.map(item => ({ chatId: item.chatId, session: item })),
    persistSession: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('executeChatRename', () => {
  it('updates and persists every active projection for the renamed chat only', async () => {
    const matching = session('s-one', 'oc_target', 'Old');
    const unrelated = session('s-two', 'oc_other', 'Other');
    const operationDeps = deps(
      { ok: true, oldName: 'Old', newName: 'New', changed: true },
      [matching, unrelated],
    );

    const response = await executeChatRename({
      larkAppId: 'cli_app',
      chatId: 'oc_target',
      name: 'New',
      trigger: 'host_api',
    }, operationDeps);

    expect(response).toEqual({
      status: 200,
      body: { ok: true, oldName: 'Old', newName: 'New', changed: true, chatId: 'oc_target' },
    });
    expect(matching.chatDisplayName).toBe('New');
    expect(unrelated.chatDisplayName).toBe('Other');
    expect(operationDeps.persistSession).toHaveBeenCalledExactlyOnceWith(matching);
  });

  it.each([
    ['bot_not_in_chat', 403],
    ['permission_denied', 403],
    ['rate_limited', 429],
    ['lark_api_error', 502],
  ] as const)('maps %s to HTTP %i without mutating projections', async (error, status) => {
    const active = session('s-one', 'oc_target', 'Old');
    const operationDeps = deps({ ok: false, error }, [active]);

    const response = await executeChatRename({
      larkAppId: 'cli_app',
      chatId: 'oc_target',
      name: 'New',
      trigger: 'host_api',
    }, operationDeps);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ ok: false, error });
    expect(active.chatDisplayName).toBe('Old');
    expect(operationDeps.persistSession).not.toHaveBeenCalled();
  });

  it('keeps a successful Lark write successful when one projection cannot persist', async () => {
    const active = session('s-one', 'oc_target', 'Old');
    const operationDeps = deps(
      { ok: true, oldName: 'Old', newName: 'New', changed: true },
      [active],
    );
    operationDeps.persistSession.mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    const response = await executeChatRename({
      larkAppId: 'cli_app',
      chatId: 'oc_target',
      name: 'New',
      trigger: 'host_api',
    }, operationDeps);

    expect(response.status).toBe(200);
    expect(active.chatDisplayName).toBe('New');
    expect(operationDeps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('cache_refresh_failed'));
  });
});
