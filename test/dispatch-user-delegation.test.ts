import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityForDispatch, deliverDispatchWithUser, dispatchUserStorePath,
  resolveDispatchUser, signDispatchUser, verifyDispatchUser,
  type DispatchUserPayload } from '../src/core/dispatch-user-delegation.js';

const secret = 'host-only-secret';
const authority = { appId: 'cli_source', openId: 'ou_alice_source', unionId: 'on_alice', tools: ['bytedcli'] as const };
const payload = (): DispatchUserPayload => ({
  domain: 'botmux.dispatch-user.v1', deliveryId: '3dca9d8a-278f-4cdb-8036-ed0a8a9ad13e',
  sourceAppId: 'cli_source', sourceSessionId: 'source-session', sourceTurnId: 'om_human',
  rootId: 'om_root', chatId: 'oc_chat', targetAppIds: ['cli_target'],
  authority: { ...authority, tools: ['bytedcli'] }, issuedAt: Date.now(), messageId: 'om_kickoff',
});
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'dispatch-user-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });
const resolve = (extra: Partial<Parameters<typeof resolveDispatchUser>[0]> = {}) => resolveDispatchUser({
  dataDir, secret, appId: 'cli_target', chatId: 'oc_chat', rootId: 'om_root', turnId: 'om_kickoff', waitMs: 0, ...extra,
});
const deliver = (messageId = 'om_kickoff', who = 'alice') => deliverDispatchWithUser({
  dataDir, secret, payload: { ...payload(), authority: {
    ...payload().authority, openId: `ou_${who}_source`, unionId: `on_${who}`,
  } }, send: async () => messageId,
});

describe('daemon-derived dispatch authority', () => {
  it('resolves a human through its issuing app; never assumes source open_id is global', async () => {
    const resolveUnionId = vi.fn(async () => 'on_alice');
    expect(await authorityForDispatch({ sourceAppId: 'cli_source', tools: ['bytedcli'],
      caller: { senderType: 'user', requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_alice_source' }, resolveUnionId,
    })).toEqual(authority);
    expect(resolveUnionId).toHaveBeenCalledExactlyOnceWith('cli_source', 'ou_alice_source');
  });
  it.each(['bot', undefined] as const)('does not originate authority from %s senders or owner hints', async senderType => {
    expect(await authorityForDispatch({ sourceAppId: 'cli_source', tools: ['bytedcli'],
      caller: { senderType, requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_alice_source', requestUserUnionId: 'on_alice' },
      resolveUnionId: async () => 'on_alice',
    })).toBeUndefined();
  });
  it('rejects missing cross-app identity rather than copying open_id', async () => {
    await expect(authorityForDispatch({ sourceAppId: 'cli_source', tools: ['bytedcli'],
      caller: { senderType: 'user', requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_alice_source' },
      resolveUnionId: async () => null,
    })).rejects.toThrow('dispatch_user_identity_unresolved');
  });
  it('keeps the original human on nested dispatch and can only narrow tools', async () => {
    expect(await authorityForDispatch({ sourceAppId: 'cli_middle', tools: ['bytedcli', 'lark-cli'],
      inherited: payload().authority, resolveUnionId: async () => { throw new Error('must not resolve peer as human'); },
    })).toEqual(authority);
    expect(await authorityForDispatch({ sourceAppId: 'cli_middle', tools: ['lark-cli'],
      inherited: payload().authority, resolveUnionId: async () => null,
    })).toBeUndefined();
  });
});

describe('message-bound signed delegation', () => {
  it('rejects edits to every identity and routing field and a different key', () => {
    const value = payload();
    const signed = signDispatchUser(secret, value);
    expect(verifyDispatchUser(secret, signed)).toEqual(value);
    for (const field of ['sourceAppId', 'sourceSessionId', 'sourceTurnId', 'rootId', 'chatId', 'targetAppIds', 'authority', 'messageId']) {
      expect(verifyDispatchUser(secret, { ...signed, payload: { ...signed.payload, [field]: 'forged' } })).toBeUndefined();
    }
    expect(verifyDispatchUser('wrong', signed)).toBeUndefined();
    expect(verifyDispatchUser(secret, { ...signed, payload: { ...signed.payload, extra: 'uncovered' } })).toBeUndefined();
  });
  it('persists across daemon reconstruction and retries, with no session-wide inheritance', async () => {
    await deliver();
    expect((await resolve())?.authority).toEqual(authority);
    expect((await resolve())?.authority).toEqual(authority);
    for (const extra of [{ turnId: 'om_other_human' }, { turnId: 'om_peer_reply' }, { rootId: 'om_other' },
      { chatId: 'oc_other' }, { appId: 'cli_other' }, { rootId: undefined }]) {
      expect(await resolve(extra)).toBeUndefined();
    }
  });
  it('concurrent dispatches preserve two users in the same target topic', async () => {
    await Promise.all([deliver('om_alice', 'alice'), deliver('om_bob', 'bob')]);
    expect((await resolve({ turnId: 'om_alice' }))?.authority.openId).toBe('ou_alice_source');
    expect((await resolve({ turnId: 'om_bob' }))?.authority.openId).toBe('ou_bob_source');
  });
  it('does not trust a signed record copied under a different message id', async () => {
    await deliver();
    const path = dispatchUserStorePath(dataDir);
    const store = JSON.parse(readFileSync(path, 'utf8'));
    store.om_copied = store.om_kickoff;
    writeFileSync(path, JSON.stringify(store));
    expect(await resolve({ turnId: 'om_copied' })).toBeUndefined();
  });
  it('waits for send completion when the target receives the event first', async () => {
    let finish!: () => void;
    let observed!: Promise<DispatchUserPayload | undefined>;
    const sent = deliverDispatchWithUser({ dataDir, secret, payload: payload(), send: async () => {
      observed = resolve({ waitMs: 500 });
      await new Promise<void>(done => { finish = done; });
      return 'om_kickoff';
    } });
    while (!finish) await new Promise(done => setTimeout(done, 1));
    expect(await resolve()).toBeUndefined(); // pending itself grants nothing
    finish();
    await sent;
    expect((await observed)?.authority).toEqual(authority);
  });
  it('send failure cleans pending state and never grants access', async () => {
    await expect(deliverDispatchWithUser({ dataDir, secret, payload: payload(),
      send: async () => { throw new Error('transport failure'); },
    })).rejects.toThrow('transport failure');
    expect(await resolve()).toBeUndefined();
    expect(JSON.parse(readFileSync(dispatchUserStorePath(dataDir), 'utf8'))).toEqual({});
  });
});
