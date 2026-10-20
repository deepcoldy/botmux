import { expect, it, vi } from 'vitest';
import { observeInteractionActor } from '../../src/core/interaction-actor.js';
import { parseInteractionActorCommand } from '../../src/cli/interaction-actor.js';
const request = { trustedHost: true, daemonAppId: 'appB', body: {
  larkAppId: 'appB', chatId: 'oc_group', principal: { kind: 'union', unionId: 'on_person' },
} };
function fixture() {
  return { resolveOpenId: vi.fn(async () => ({ status: 'resolved', openId: 'ou_in_B' })),
    resolveUnionId: vi.fn(async () => 'on_person'), members: vi.fn(async () => ['ou_in_B']), canTalk: vi.fn(() => true) };
}
it('resolves the same human in the receiving App and checks its current native permission', async () => {
  const deps=fixture();
  expect((await observeInteractionActor(request,deps)).body).toMatchObject({ok:true,actor:{openId:'ou_in_B',canTalk:true}});
  expect(deps.canTalk).toHaveBeenCalledWith('appB','oc_group','ou_in_B','group');
  deps.canTalk.mockReturnValue(false);
  expect((await observeInteractionActor(request,deps)).body).toMatchObject({actor:{canTalk:false}});
  deps.members.mockResolvedValue([]);deps.canTalk.mockClear();
  expect((await observeInteractionActor(request,deps)).body).toMatchObject({actor:{member:false,canTalk:false}});
  expect(deps.canTalk).not.toHaveBeenCalled();
});
it('never accepts a foreign App open_id or a non-host caller', async () => {
  const deps=fixture();
  expect((await observeInteractionActor({...request,trustedHost:false},deps)).status).toBe(403);
  expect((await observeInteractionActor({...request,body:{...request.body,principal:{kind:'app_open',larkAppId:'appA',openId:'ou_in_A'}}},deps)).status).toBe(400);
  expect(deps.resolveOpenId).not.toHaveBeenCalled();expect(deps.members).not.toHaveBeenCalled();
});
it('keeps unresolvable cross-App identities unknown without falling back to another user', async () => {
  const deps=fixture();deps.resolveOpenId.mockResolvedValue({status:'transient',openId:''});
  expect((await observeInteractionActor(request,deps)).status).toBe(503);
  deps.resolveOpenId.mockResolvedValue({status:'definitive',openId:''});
  expect((await observeInteractionActor(request,deps)).status).toBe(409);
  expect(deps.members).not.toHaveBeenCalled();
});
it('retains a scoped identity when the original App cannot prove a union identity', async () => {
  const deps={...fixture(),resolveUnionId:async()=>null};
  const principal={kind:'app_open',larkAppId:'appB',openId:'ou_in_B'};
  expect((await observeInteractionActor({...request,body:{...request.body,principal}},deps)).body).toMatchObject({actor:{principal}});
});
it('CLI preserves the exact principal and rejects ambiguous selectors', () => {
  const command=parseInteractionActorCommand(['--bot','appB','--chat','oc_group','--union','on_person']);
  expect(JSON.parse(command.init.body)).toEqual(request.body);
  expect(()=>parseInteractionActorCommand(['--bot','appB','--chat','oc_group','--union','on_person','--open','ou_in_A'])).toThrow();
});
