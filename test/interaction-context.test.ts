import { describe, expect, it, vi } from 'vitest';
import { observeInteractionContext, type InteractionSession } from '../src/core/interaction-context.js';
import { parseInteractionContextCommand } from '../src/cli/interaction-context.js';
const session: InteractionSession = { sessionId: 's1', larkAppId: 'app1', status: 'active', chatId: 'oc_chat',
  scope: 'thread', rootMessageId: 'om_root', ownerOpenId: 'ou_owner', chatType: 'group' };
const request = { trustedHost: true, daemonAppId: 'app1', sessionId: 's1', body: { larkAppId: 'app1', actorOpenId: 'ou_owner' } };
describe('current host interaction context', () => {
  it('reads authoritative identity and current native talk decision without exposing data paths', () => {
    const talk = vi.fn(() => true);
    const result = observeInteractionContext({ ...request, body: { ...request.body, chatId: 'oc_forged', ownerOpenId: 'ou_forged' } },
      { findActive: () => ({ ...session, workingDir: '/private', token: 'secret' } as InteractionSession), canTalk: talk });
    expect(result.status).toBe(200);
    expect(result.body.context).toMatchObject({ chatId: 'oc_chat', ownerOpenId: 'ou_owner', rootMessageId: 'om_root', canTalk: true });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|forged/);
    expect(talk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'group');
  });
  it('does not let a snapshot grant future access', () => {
    let allowed = true; const deps = { findActive: () => session, canTalk: () => allowed };
    expect(observeInteractionContext(request, deps).body.context).toMatchObject({ canTalk: true });
    allowed = false;
    expect(observeInteractionContext(request, deps).body.context).toMatchObject({ canTalk: false });
  });
  it('requires host authority before lookup or access checks', () => {
    const findActive = vi.fn(); const canTalk = vi.fn();
    expect(observeInteractionContext({ ...request, trustedHost: false }, { findActive, canTalk }).status).toBe(403);
    expect(findActive).not.toHaveBeenCalled(); expect(canTalk).not.toHaveBeenCalled();
  });
  it.each([undefined, { ...session, status: 'closed' }, { ...session, larkAppId: 'other' }, { ...session, sessionId: 'other' }])('rejects missing, closed or misrouted sessions', value => {
    expect(observeInteractionContext(request, { findActive: () => value, canTalk: () => true }).status).toBe(404);
  });
  it.each([{ ...session, ownerOpenId: '' }, { ...session, scope: undefined }, { ...session, rootMessageId: '' },
    { ...session, vcMeetingReceiver: {} }, { ...session, chatType: 'unknown' }])('does not invent missing origins', value => {
    expect(observeInteractionContext(request, { findActive: () => value, canTalk: () => true }).status).toBe(409);
  });
  it.each(['owner', 'on_other', ''])('rejects non-open-id actors', actorOpenId => {
    const findActive = vi.fn();
    expect(observeInteractionContext({ ...request, body: { ...request.body, actorOpenId } }, { findActive, canTalk: () => true }).status).toBe(400);
    expect(findActive).not.toHaveBeenCalled();
  });
  it('defaults to the authoritative owner only when no actor was supplied', () => {
    const talk = vi.fn(() => true);
    const result = observeInteractionContext({ ...request, body: { larkAppId: 'app1' } }, { findActive: () => session, canTalk: talk });
    expect(result.body.context).toMatchObject({ actorOpenId: 'ou_owner' });
    expect(talk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'group');
  });
  it('keeps chat scope root null and uses its p2p policy', () => {
    const talk = vi.fn(() => false);
    const result = observeInteractionContext(request, { findActive: () => ({ ...session, scope: 'chat', chatType: 'p2p' }), canTalk: talk });
    expect(result.body.context).toMatchObject({ rootMessageId: null, canTalk: false });
    expect(talk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'p2p');
  });
  it('requires explicit CLI identities and encodes paths', () => {
    const cmd = parseInteractionContextCommand(['--bot', 'app1', '--session', 'a/b', '--actor', 'ou_owner']);
    expect(cmd.path).toBe('/api/sessions/a%2Fb/interaction-context');
    expect(JSON.parse(cmd.init.body)).toEqual({ larkAppId: 'app1', actorOpenId: 'ou_owner' });
    for (const args of [[], ['--bot', 'app1'], ['--bot', 'app1', '--bot', 'app2'], ['--bot', '--session']]) expect(() => parseInteractionContextCommand(args)).toThrow();
  });
});
