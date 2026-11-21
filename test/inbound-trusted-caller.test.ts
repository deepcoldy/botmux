import { describe, expect, it, vi } from 'vitest';
import { trustedCallerFromInbound } from '../src/core/inbound-trusted-caller.js';
import { messageSenderUnionIdFromDetail } from '../src/im/lark/client.js';

describe('inbound trusted caller union-id repair', () => {
  it('attaches a host-verified normalized email only to the exact human sender', async () => {
    const resolveVerifiedUserEmail = vi.fn(async () => 'alice@bytedance.com');
    await expect(trustedCallerFromInbound({
      larkAppId: 'cli_receiver',
      senderOpenId: 'ou_human_sender',
      senderIsBot: false,
      messageId: 'om_inbound_turn',
    }, {
      resolveMessageSenderUnionId: async () => null,
      resolveVerifiedUserEmail,
    })).resolves.toMatchObject({
      requestUserOpenId: 'ou_human_sender',
      verifiedEmail: 'alice@bytedance.com',
      senderType: 'user',
    });
    expect(resolveVerifiedUserEmail).toHaveBeenCalledWith('cli_receiver', 'ou_human_sender');
  });

  it('does not resolve or attach a user email for bot and unknown senders', async () => {
    for (const senderIsBot of [true, undefined]) {
      const resolveVerifiedUserEmail = vi.fn(async () => 'must-not-be-used@bytedance.com');
      const caller = await trustedCallerFromInbound({
        larkAppId: 'cli_receiver',
        senderOpenId: 'ou_non_human',
        senderIsBot,
        messageId: 'om_inbound_turn',
      }, {
        resolveMessageSenderUnionId: async () => null,
        resolveVerifiedUserEmail,
      });
      expect(caller?.verifiedEmail).toBeUndefined();
      expect(resolveVerifiedUserEmail).not.toHaveBeenCalled();
    }
  });

  it('fails closed when verified human email lookup is unavailable', async () => {
    for (const resolveVerifiedUserEmail of [
      async () => undefined,
      async () => { throw new Error('contact unavailable'); },
    ]) {
      const caller = await trustedCallerFromInbound({
        larkAppId: 'cli_receiver',
        senderOpenId: 'ou_human_sender',
        senderIsBot: false,
        messageId: 'om_inbound_turn',
      }, {
        resolveMessageSenderUnionId: async () => null,
        resolveVerifiedUserEmail,
      });
      expect(caller).toMatchObject({ requestUserOpenId: 'ou_human_sender', senderType: 'user' });
      expect(caller?.verifiedEmail).toBeUndefined();
    }
  });

  it('repairs a missing human union_id from the exact message sender', async () => {
    const resolveMessageSenderUnionId = vi.fn(async () => 'on_verified_sender');
    await expect(trustedCallerFromInbound({
      larkAppId: 'cli_receiver',
      senderOpenId: 'ou_human_sender',
      senderIsBot: false,
      messageId: 'om_inbound_turn',
    }, { resolveMessageSenderUnionId })).resolves.toEqual({
      requestLarkAppId: 'cli_receiver',
      requestUserOpenId: 'ou_human_sender',
      requestUserUnionId: 'on_verified_sender',
      senderType: 'user',
    });
    expect(resolveMessageSenderUnionId).toHaveBeenCalledWith('cli_receiver', 'om_inbound_turn');
  });

  it('never repairs a bot or unknown sender through the human lookup', async () => {
    for (const senderIsBot of [true, undefined]) {
      const resolveMessageSenderUnionId = vi.fn(async () => 'on_must_not_be_used');
      const caller = await trustedCallerFromInbound({
        larkAppId: 'cli_receiver',
        senderOpenId: 'ou_non_human',
        senderIsBot,
        messageId: 'om_inbound_turn',
      }, { resolveMessageSenderUnionId });
      expect(caller?.requestUserUnionId).toBeUndefined();
      expect(resolveMessageSenderUnionId).not.toHaveBeenCalled();
    }
  });

  it('fails closed when the message lookup is unavailable or malformed', async () => {
    for (const answer of [null, 'ou_not_a_union', 'not-a-union']) {
      const caller = await trustedCallerFromInbound({
        larkAppId: 'cli_receiver',
        senderOpenId: 'ou_human_sender',
        senderIsBot: false,
        messageId: 'om_inbound_turn',
      }, { resolveMessageSenderUnionId: async () => answer });
      expect(caller).toMatchObject({
        requestUserOpenId: 'ou_human_sender',
        senderType: 'user',
      });
      expect(caller?.requestUserUnionId).toBeUndefined();
    }
  });
});

describe('message sender union-id response parser', () => {
  it('accepts only a human union-id sender', () => {
    expect(messageSenderUnionIdFromDetail({
      items: [{ sender: { sender_type: 'user', id_type: 'union_id', id: 'on_verified_sender' } }],
    })).toBe('on_verified_sender');
  });

  it.each([
    [{ items: [{ sender: { sender_type: 'bot', id_type: 'union_id', id: 'on_bot' } }] }],
    [{ items: [{ sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_user' } }] }],
    [{ items: [{ sender: { sender_type: 'user', id_type: 'union_id', id: 'ou_wrong_kind' } }] }],
    [{ items: [] }],
  ])('rejects an untrusted or malformed response', detail => {
    expect(messageSenderUnionIdFromDetail(detail)).toBeNull();
  });
});
