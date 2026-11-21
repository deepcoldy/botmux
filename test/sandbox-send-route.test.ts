import { describe, expect, it } from 'vitest';
import {
  authorizeSandboxSendRoute,
  handleSandboxSendRouteRequest,
  type SandboxSendRouteDeps,
} from '../src/core/sandbox-send-route.js';

// A small Lark world: which chats exist, who is in them, who may talk there.
interface World {
  chats: Record<string, { external?: boolean; mode?: 'group' | 'p2p'; botIn?: boolean; members?: string[]; talk?: string[] }>;
  messages?: Record<string, string>;
  failing?: Set<string>;
}

function deps(world: World): SandboxSendRouteDeps & { calls: string[] } {
  const calls: string[] = [];
  const chat = (id: string) => {
    if (world.failing?.has(id)) throw new Error('provider unavailable');
    const c = world.chats[id];
    if (!c) throw new Error('chat not found');
    return c;
  };
  return {
    calls,
    async lookupMessageChatId(id) {
      calls.push(`message:${id}`);
      if (world.failing?.has(id)) throw new Error('provider unavailable');
      return world.messages?.[id] ?? null;
    },
    async getChatInfo(id) {
      calls.push(`chat:${id}`);
      const c = chat(id);
      return { external: c.external ?? false, mode: c.mode ?? 'group' };
    },
    async isBotInChat(id) { calls.push(`botIn:${id}`); return chat(id).botIn ?? true; },
    async listMemberOpenIds(id) { calls.push(`members:${id}`); return chat(id).members ?? []; },
    canTalk(id, openId) { calls.push(`talk:${id}:${openId}`); return chat(id).talk?.includes(openId) ?? false; },
  };
}

const base = { sessionChatId: 'oc_self', turnCallerOpenId: 'ou_alice', sessionOwnerOpenId: 'ou_owner' };

describe('authorizeSandboxSendRoute', () => {
  it('allows the session chat itself without consulting Lark (own-chat --top-level / --chat-id)', async () => {
    const d = deps({ chats: {} });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_self' }, d))
      .toEqual({ ok: true, chatId: 'oc_self', reason: 'own_chat' });
    expect(d.calls).toEqual([]);
  });

  it('allows a cross-chat send to a group where the bot is and the caller is an authorized member', async () => {
    const d = deps({ chats: { oc_team: { members: ['ou_alice', 'ou_bob'], talk: ['ou_alice'] } } });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_team' }, d))
      .toEqual({ ok: true, chatId: 'oc_team', principal: 'ou_alice', reason: 'authorized' });
  });

  it('rejects a forged chat id where the caller has no talk authorization', async () => {
    const d = deps({ chats: { oc_secret: { members: ['ou_alice'], talk: ['ou_mallory'] } } });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_secret' }, d))
      .toMatchObject({ ok: false, error: 'principal_not_authorized', chatId: 'oc_secret' });
  });

  it('rejects a chat the caller is not a member of, even when the chat is talk-open', async () => {
    const d = deps({ chats: { oc_open: { members: ['ou_bob'], talk: ['ou_alice'] } } });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_open' }, d))
      .toMatchObject({ ok: false, error: 'principal_not_member' });
  });

  it('rejects chats the bot is not in, external chats and DMs', async () => {
    const authorized = { members: ['ou_alice'], talk: ['ou_alice'] };
    const d = deps({ chats: {
      oc_gone: { ...authorized, botIn: false },
      oc_ext: { ...authorized, external: true },
      oc_dm: { ...authorized, mode: 'p2p' },
    } });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_gone' }, d)).toMatchObject({ ok: false, error: 'bot_not_in_chat' });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_ext' }, d)).toMatchObject({ ok: false, error: 'external_chat' });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_dm' }, d)).toMatchObject({ ok: false, error: 'not_group_chat' });
  });

  it('resolves --into to the root message\'s real chat; a disagreeing --chat-id never wins', async () => {
    const world: World = {
      chats: { oc_team: { members: ['ou_alice'], talk: ['ou_alice'] }, oc_secret: {} },
      messages: { om_root_team: 'oc_team', om_root_self: 'oc_self' },
    };
    expect(await authorizeSandboxSendRoute({ ...base, into: 'om_root_team' }, deps(world)))
      .toMatchObject({ ok: true, chatId: 'oc_team' });
    expect(await authorizeSandboxSendRoute({ ...base, into: 'om_root_self' }, deps(world)))
      .toMatchObject({ ok: true, chatId: 'oc_self', reason: 'own_chat' });
    // Forged pairing: a reachable chat id next to a thread elsewhere.
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_self', into: 'om_root_team' }, deps(world)))
      .toMatchObject({ ok: false, error: 'into_chat_mismatch', chatId: 'oc_team' });
    expect(await authorizeSandboxSendRoute({ ...base, into: 'om_unknown' }, deps(world)))
      .toMatchObject({ ok: false, error: 'into_lookup_failed' });
  });

  it('requires an explicit --quote to sit in the target chat (a reply lands in the quoted message\'s chat)', async () => {
    const world: World = {
      chats: { oc_team: { members: ['ou_alice'], talk: ['ou_alice'] } },
      messages: { om_in_self: 'oc_self', om_in_team: 'oc_team', om_victim: 'oc_victim' },
    };
    expect(await authorizeSandboxSendRoute({ ...base, quote: 'om_in_self' }, deps(world)))
      .toMatchObject({ ok: true, chatId: 'oc_self', reason: 'own_chat' });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_team', quote: 'om_in_team' }, deps(world)))
      .toMatchObject({ ok: true, chatId: 'oc_team' });
    expect(await authorizeSandboxSendRoute({ ...base, quote: 'om_victim' }, deps(world)))
      .toMatchObject({ ok: false, error: 'quote_chat_mismatch', chatId: 'oc_victim' });
    // An authorized --chat-id cannot launder a quote that points elsewhere.
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_team', quote: 'om_victim' }, deps(world)))
      .toMatchObject({ ok: false, error: 'quote_chat_mismatch' });
    expect(await authorizeSandboxSendRoute({ ...base, quote: 'om_unknown' }, deps(world)))
      .toMatchObject({ ok: false, error: 'quote_lookup_failed' });
  });

  it('uses the session owner only when the turn has no human caller', async () => {
    const world: World = { chats: { oc_team: { members: ['ou_alice', 'ou_owner'], talk: ['ou_owner'] } } };
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_team' }, deps(world)))
      .toMatchObject({ ok: false, error: 'principal_not_authorized', principal: 'ou_alice' });
    expect(await authorizeSandboxSendRoute({ sessionChatId: 'oc_self', sessionOwnerOpenId: 'ou_owner', chatId: 'oc_team' }, deps(world)))
      .toMatchObject({ ok: true, principal: 'ou_owner' });
    expect(await authorizeSandboxSendRoute({ sessionChatId: 'oc_self', chatId: 'oc_team' }, deps(world)))
      .toMatchObject({ ok: false, error: 'no_principal' });
  });

  it('fails closed when Lark evidence is unavailable, and rejects malformed ids before any lookup', async () => {
    const d = deps({ chats: {}, failing: new Set(['oc_flaky', 'om_flaky']) });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_flaky' }, d)).toMatchObject({ ok: false, error: 'chat_lookup_failed' });
    expect(await authorizeSandboxSendRoute({ ...base, into: 'om_flaky' }, d)).toMatchObject({ ok: false, error: 'into_lookup_failed' });
    const strict = deps({ chats: {} });
    expect(await authorizeSandboxSendRoute({ ...base, chatId: 'oc_x/../y' }, strict)).toMatchObject({ ok: false, error: 'bad_chat_id' });
    expect(await authorizeSandboxSendRoute({ ...base, into: 'oc_not_a_message' }, strict)).toMatchObject({ ok: false, error: 'bad_into' });
    expect(strict.calls).toEqual([]);
  });
});

describe('handleSandboxSendRouteRequest', () => {
  const world: World = { chats: { oc_team: { members: ['ou_t0', 'ou_t1'], talk: ['ou_t0'] } } };
  // T0's caller may reach oc_team; T1's caller may not.
  const ctx = (liveTurnId: string | undefined) => {
    const audit: string[] = [];
    return {
      audit,
      ctx: {
        session: {
          sessionId: 's1', chatId: 'oc_self', liveTurnId,
          callerForTurn: (turn: string) => ({ T0: 'ou_t0', T1: 'ou_t1' } as Record<string, string>)[turn],
        },
        deps: deps(world),
        audit: (line: string) => { audit.push(line); },
      },
    };
  };

  it('binds the decision to the live turn: a request from an older or unnamed turn gets 409 and no verdict', async () => {
    const live = ctx('T1');
    expect(await handleSandboxSendRouteRequest({ chatId: 'oc_team', turnId: 'T0' }, live.ctx))
      .toEqual({ status: 409, body: { ok: false, error: 'turn_changed' } });
    expect(await handleSandboxSendRouteRequest({ chatId: 'oc_team' }, live.ctx))
      .toEqual({ status: 409, body: { ok: false, error: 'turn_changed' } });
    expect(live.audit).toEqual([]);
    // The live turn's own caller decides — T1 has no talk grant in oc_team.
    expect(await handleSandboxSendRouteRequest({ chatId: 'oc_team', turnId: 'T1' }, live.ctx))
      .toMatchObject({ status: 403, body: { ok: false, error: 'principal_not_authorized', principal: 'ou_t1' } });
    expect(await handleSandboxSendRouteRequest({ chatId: 'oc_team', turnId: 'T0' }, ctx('T0').ctx))
      .toMatchObject({ status: 200, body: { ok: true, chatId: 'oc_team', principal: 'ou_t0' } });
  });

  it('rejects malformed bodies and unknown sessions, and audits every decision it makes', async () => {
    const live = ctx('T0');
    expect(await handleSandboxSendRouteRequest({ chatId: 42, turnId: 'T0' }, live.ctx)).toMatchObject({ status: 400 });
    expect(await handleSandboxSendRouteRequest({ chatId: '', turnId: 'T0' }, live.ctx)).toMatchObject({ status: 400 });
    expect(await handleSandboxSendRouteRequest({ turnId: 'T0' }, { ...live.ctx, session: undefined }))
      .toEqual({ status: 404, body: { ok: false, error: 'session_not_found' } });
    await handleSandboxSendRouteRequest({ chatId: 'oc_team', turnId: 'T0' }, live.ctx);
    expect(live.audit).toEqual([
      'session=s1 turn=T0 requested=oc_team/-/- target=oc_team principal=ou_t0 decision=authorized',
    ]);
  });
});
