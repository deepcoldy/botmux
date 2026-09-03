/**
 * Bot-level Lark transport boundary (codex round-3 fix).
 *
 * assertLarkTransport is the authoritative gate at the shared getBotClient base
 * of every outbound Feishu primitive: an apiOnly bot's send/reply/update/
 * reaction/DM must throw LarkTransportDisabledError regardless of caller, so no
 * path (sessionReply, direct updateMessage, `botmux send`, v3 distillation,
 * overload DM) can reach Feishu. A normal bot is unaffected.
 *
 * Run:  pnpm vitest run test/lark-transport-boundary.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBotMock = vi.fn();
// A fake Lark client whose calls would resolve — so if the gate DIDN'T fire, the
// primitive would "succeed" and the test's rejects.toThrow would fail.
const fakeClient = {
  im: {
    v1: {
      message: { create: vi.fn(async () => ({ code: 0, data: { message_id: 'om_x' } })), patch: vi.fn(async () => ({ code: 0 })) },
      pin: { create: vi.fn(async () => ({ code: 0 })), delete: vi.fn(async () => ({ code: 0 })) },
      messageReaction: { create: vi.fn(async () => ({ code: 0, data: { reaction_id: 'r' } })), delete: vi.fn(async () => ({ code: 0 })) },
    },
  },
};
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: (...a: any[]) => getBotMock(...a),
    getAllBots: vi.fn(() => []),
    formatLarkError: (e: any) => String(e),
    // Mirror the real getBotClient gate against the mocked getBot: apiOnly →
    // throw the (real) LarkTransportDisabledError; otherwise hand back the fake.
    getBotClient: (larkAppId: string) => {
      if (getBotMock(larkAppId)?.config?.apiOnly === true) {
        throw new actual.LarkTransportDisabledError(larkAppId, 'getBotClient');
      }
      return fakeClient;
    },
  };
});

import {
  sendMessage, replyMessage, updateMessage, deleteMessage,
  pinMessage, unpinMessage,
  addReaction, removeReaction, sendUserMessage, sendEphemeralCard,
  deleteEphemeralCard, uploadImage, uploadFile,
  LarkTransportDisabledError,
} from '../src/im/lark/client.js';

const APIONLY = 'local_riff';
const NORMAL = 'app_normal';

function bot(apiOnly: boolean) {
  return { config: { larkAppId: apiOnly ? APIONLY : NORMAL, larkAppSecret: apiOnly ? '' : 's', cliId: 'codex-app', apiOnly }, resolvedAllowedUsers: [], botOpenId: 'ou_x' };
}

describe('assertLarkTransport — bot-level outbound gate', () => {
  beforeEach(() => getBotMock.mockReset());

  it('every outbound write primitive throws LarkTransportDisabledError for an apiOnly bot', async () => {
    getBotMock.mockReturnValue(bot(true));
    await expect(sendMessage(APIONLY, 'oc', 'hi')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(replyMessage(APIONLY, 'om', 'hi')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(updateMessage(APIONLY, 'om', '{}')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(deleteMessage(APIONLY, 'om')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(pinMessage(APIONLY, 'om')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(unpinMessage(APIONLY, 'om')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    expect(fakeClient.im.v1.pin.create).not.toHaveBeenCalled();
    expect(fakeClient.im.v1.pin.delete).not.toHaveBeenCalled();
    await expect(addReaction(APIONLY, 'om', 'THUMBSUP')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(removeReaction(APIONLY, 'om', 'r')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(sendUserMessage(APIONLY, 'ou', 'hi')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(sendEphemeralCard(APIONLY, 'oc', 'ou', '{}')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(deleteEphemeralCard(APIONLY, 'om')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(uploadImage(APIONLY, '/tmp/none.png')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(uploadFile(APIONLY, '/tmp/none.bin')).rejects.toBeInstanceOf(LarkTransportDisabledError);
  });

  it('a normal bot is unaffected — sendMessage/updateMessage proceed to the client', async () => {
    getBotMock.mockReturnValue(bot(false));
    await expect(sendMessage(NORMAL, 'oc', 'hi')).resolves.toBeDefined();
    await expect(updateMessage(NORMAL, 'om', '{}')).resolves.toBeUndefined();
    expect(fakeClient.im.v1.message.create).toHaveBeenCalled();
    expect(fakeClient.im.v1.message.patch).toHaveBeenCalled();
  });
});
