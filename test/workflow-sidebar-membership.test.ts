/**
 * 主 Bot daemon 一侧的群成员核对（设计 2026-11-03 §11.3）：union_id 先换成本应用的 open_id
 * 再与本应用看到的成员名单比对；任何查询失败都是 unavailable（调用方拒绝），身份字段形状
 * 不对的请求直接拒收。
 */

import { describe, expect, it } from 'vitest';

import {
  checkWorkflowViewerChatMembership,
  parseWorkflowSidebarMembershipRequest,
  WORKFLOW_SIDEBAR_MEMBERSHIP_ROUTE,
  workflowSidebarMembershipRoute,
  type WorkflowSidebarMembershipDeps,
} from '../src/core/workflow-sidebar-membership.js';
import { routeHasNarrowUntrustedAuth } from '../src/core/dashboard-ipc-server.js';

function deps(over: Partial<WorkflowSidebarMembershipDeps> = {}) {
  const calls: string[] = [];
  const d: WorkflowSidebarMembershipDeps = {
    resolveOpenIdByUnionId: async (unionId) => { calls.push(`resolve:${unionId}`); return { status: 'resolved', openId: 'ou_in_main_app' }; },
    listChatMemberOpenIds: async (chatId) => { calls.push(`list:${chatId}`); return ['ou_someone', 'ou_in_main_app']; },
    ...over,
  };
  return { d, calls };
}

describe('membership request', () => {
  it('admits exactly one well-formed identity for a chat id', () => {
    expect(parseWorkflowSidebarMembershipRequest({ chatId: 'oc_abc', unionId: 'on_abcdef' }))
      .toEqual({ chatId: 'oc_abc', principal: { unionId: 'on_abcdef' } });
    expect(parseWorkflowSidebarMembershipRequest({ chatId: 'oc_abc', openId: 'ou_abcdef' }))
      .toEqual({ chatId: 'oc_abc', principal: { openId: 'ou_abcdef' } });
    for (const bad of [
      { chatId: 'oc_abc', unionId: 'on_abcdef', openId: 'ou_abcdef' },
      { chatId: 'oc_abc' },
      { chatId: 'oc_abc', unionId: 'ou_abcdef' },
      { chatId: 'oc_abc', openId: 'on_abcdef' },
      { chatId: 'ou_notachat', unionId: 'on_abcdef' },
      null, [], 'x',
    ]) expect(parseWorkflowSidebarMembershipRequest(bad)).toBeNull();
  });
});

describe('membership check', () => {
  it('union_id → this app\'s open_id → in the member list', async () => {
    const { d, calls } = deps();
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { unionId: 'on_u1' } }, d)).toBe('member');
    expect(calls).toEqual(['resolve:on_u1', 'list:oc_c']);
  });

  it('resolved but not listed → not a member', async () => {
    const { d } = deps({ listChatMemberOpenIds: async () => ['ou_someone'] });
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { unionId: 'on_u1' } }, d)).toBe('not_member');
  });

  it('a definitive "no such user in this app" is a verdict; a transient one is not', async () => {
    const definitive = deps({ resolveOpenIdByUnionId: async () => ({ status: 'definitive' }) });
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { unionId: 'on_u1' } }, definitive.d)).toBe('not_member');
    expect(definitive.calls).toEqual([]);
    const transient = deps({ resolveOpenIdByUnionId: async () => ({ status: 'transient' }) });
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { unionId: 'on_u1' } }, transient.d)).toBe('unavailable');
    const thrown = deps({ resolveOpenIdByUnionId: async () => { throw new Error('network'); } });
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { unionId: 'on_u1' } }, thrown.d)).toBe('unavailable');
  });

  it('a member list that cannot be read (or is incomplete and throws) is unavailable, never "not a member"', async () => {
    const { d } = deps({ listChatMemberOpenIds: async () => { throw new Error('more than 2000 members'); } });
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { unionId: 'on_u1' } }, d)).toBe('unavailable');
  });

  it('an open_id the caller vouched for is compared directly, without a contact lookup', async () => {
    const { d, calls } = deps();
    expect(await checkWorkflowViewerChatMembership({ chatId: 'oc_c', principal: { openId: 'ou_in_main_app' } }, d)).toBe('member');
    expect(calls).toEqual(['list:oc_c']);
  });
});

describe('the daemon route', () => {
  it('is not one of the IPC routes a sandboxed session may call without the host secret', () => {
    // Only the Dashboard (holding the host secret) may ask whether someone is in a chat.
    expect(routeHasNarrowUntrustedAuth('POST', WORKFLOW_SIDEBAR_MEMBERSHIP_ROUTE)).toBe(false);
  });

  const body = { chatId: 'oc_c', unionId: 'on_union1' };

  it('answers only a trusted host, and asks Feishu only then', async () => {
    const asked: string[] = [];
    const factory = (app: string) => { asked.push(app); return deps().d; };
    expect(await workflowSidebarMembershipRoute({ trustedHost: false, selfLarkAppId: 'cli_main', body }, factory))
      .toEqual({ status: 403, body: { ok: false, error: 'trusted_host_required' } });
    expect(asked).toEqual([]);
    expect(await workflowSidebarMembershipRoute({ trustedHost: true, selfLarkAppId: 'cli_main', body }, factory))
      .toEqual({ status: 200, body: { ok: true, member: true } });
    expect(asked).toEqual(['cli_main']);
  });

  it('checks in the daemon\'s own app, rejects malformed requests, and answers a failed lookup with 503', async () => {
    expect(await workflowSidebarMembershipRoute({ trustedHost: true, selfLarkAppId: undefined, body }, () => deps().d))
      .toMatchObject({ status: 503 });
    expect(await workflowSidebarMembershipRoute({ trustedHost: true, selfLarkAppId: 'cli_main', body: { chatId: 'oc_c' } }, () => deps().d))
      .toEqual({ status: 400, body: { ok: false, error: 'invalid_request' } });
    const failing = deps({ listChatMemberOpenIds: async () => { throw new Error('rate limited'); } }).d;
    expect(await workflowSidebarMembershipRoute({ trustedHost: true, selfLarkAppId: 'cli_main', body }, () => failing))
      .toEqual({ status: 503, body: { ok: false, error: 'membership_unavailable' } });
    const outsider = deps({ listChatMemberOpenIds: async () => ['ou_someone'] }).d;
    expect(await workflowSidebarMembershipRoute({ trustedHost: true, selfLarkAppId: 'cli_main', body }, () => outsider))
      .toEqual({ status: 200, body: { ok: true, member: false } });
  });
});
