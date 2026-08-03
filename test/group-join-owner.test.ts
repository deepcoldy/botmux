/**
 * autoInviteOwnerOnGroupJoin：bot 进群自动把 owner 拉进群（默认 ON，显式 false 关）。
 * Run: pnpm vitest run test/group-join-owner.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const requestMock = vi.fn(async (_arg: any) => ({ code: 0, data: { items: [], has_more: false } }));
const createMock = vi.fn(async (_arg: any) => ({ code: 0, data: {} }));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    request = requestMock;
    im = { v1: { chatMembers: { create: createMock } } };
    constructor(public opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

import { autoInviteOwnerOnGroupJoin } from '../src/services/groups-store.js';
import { registerBot } from '../src/bot-registry.js';

const OWNER = 'ou_owner';
const CHAT = 'oc_x';

beforeEach(() => {
  requestMock.mockClear();
  createMock.mockClear();
  requestMock.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: false } }));
  createMock.mockImplementation(async () => ({ code: 0, data: {} }));
});
afterEach(() => vi.restoreAllMocks());

function reg(cfg: Record<string, unknown> = {}) {
  return registerBot({ larkAppId: 'b1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER], ...cfg } as any);
}

describe('autoInviteOwnerOnGroupJoin', () => {
  it('default ON: pulls owner with open_id + addMembers.create when not yet in chat', async () => {
    reg();
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('added');
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as any;
    expect(arg.path).toEqual({ chat_id: CHAT });
    expect(arg.params).toEqual({ member_id_type: 'open_id' });
    expect(arg.data).toEqual({ id_list: [OWNER] });
  });

  it('owner already in chat (member pre-check) → already, no create call', async () => {
    reg();
    requestMock.mockImplementation(async (arg: any) => {
      if (String(arg?.url ?? '').includes('/members')) {
        return { code: 0, data: { items: [{ member_id: OWNER }], has_more: false } };
      }
      return { code: 0, data: {} };
    });
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('already');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('member pre-check fails → still tries to add (API is the authority)', async () => {
    reg();
    requestMock.mockRejectedValue(new Error('members boom'));
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('added');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('explicit autoInviteOwnerOnGroupAdd=false → skipped, nothing called', async () => {
    reg({ autoInviteOwnerOnGroupAdd: false });
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('skipped');
    expect(requestMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('operator IS the owner → already, nothing called', async () => {
    reg();
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, OWNER)).toBe('already');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('bot without any owner (no allowedUsers) → skipped', async () => {
    registerBot({ larkAppId: 'b_noowner', larkAppSecret: 's', cliId: 'claude-code' } as any);
    expect(await autoInviteOwnerOnGroupJoin('b_noowner', CHAT)).toBe('skipped');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('Lark rejects the add (code != 0) → failed, never throws', async () => {
    reg();
    createMock.mockImplementation(async () => ({ code: 232024, msg: 'no permission' }));
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('failed');
  });

  it('Lark throws on the add → failed, never throws', async () => {
    reg();
    createMock.mockRejectedValue(new Error('http 500'));
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('failed');
  });

  it('invalid_id_list containing owner → failed', async () => {
    reg();
    createMock.mockImplementation(async () => ({ code: 0, data: { invalid_id_list: [OWNER] } }));
    expect(await autoInviteOwnerOnGroupJoin('b1', CHAT, 'ou_someone_else')).toBe('failed');
  });
});
