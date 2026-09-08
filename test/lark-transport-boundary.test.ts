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
  cardkit: {
    v1: {
      card: {
        idConvert: vi.fn(async () => ({ code: 0, data: { card_id: 'card_x' } })),
        settings: vi.fn(async () => ({ code: 0 })),
      },
      cardElement: {
        content: vi.fn(async () => ({ code: 0 })),
        patch: vi.fn(async () => ({ code: 0 })),
      },
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
  resolveCardKitId, updateCardStreamingSettings, updateCardStreamElementContent, patchCardStreamElement,
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
    await expect(resolveCardKitId(APIONLY, 'om')).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(updateCardStreamingSettings(APIONLY, 'card', {
      streamingMode: true, sequence: 1, uuid: 'u',
    })).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(updateCardStreamElementContent(
      APIONLY, 'card', 'main', 'text', 2, 'u2',
    )).rejects.toBeInstanceOf(LarkTransportDisabledError);
    await expect(patchCardStreamElement(
      APIONLY, 'card', 'loader', { img_key: 'img_x' }, 3, 'u3',
    )).rejects.toBeInstanceOf(LarkTransportDisabledError);
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
    await expect(resolveCardKitId(NORMAL, 'om')).resolves.toBe('card_x');
    await expect(updateCardStreamingSettings(NORMAL, 'card_x', {
      streamingMode: true,
      sequence: 1,
      uuid: 'u1',
      print: { frequencyMs: 70, step: 1, strategy: 'fast' },
    })).resolves.toBeUndefined();
    await expect(updateCardStreamElementContent(
      NORMAL, 'card_x', 'main', 'text', 2, 'u2',
    )).resolves.toBeUndefined();
    await expect(patchCardStreamElement(
      NORMAL, 'card_x', 'loader', { img_key: 'img_x' }, 3, 'u3',
    )).resolves.toBeUndefined();
    expect(fakeClient.im.v1.message.create).toHaveBeenCalled();
    expect(fakeClient.im.v1.message.patch).toHaveBeenCalled();
    expect(fakeClient.cardkit.v1.card.idConvert).toHaveBeenCalledWith({ data: { message_id: 'om' } });
    expect(fakeClient.cardkit.v1.card.settings).toHaveBeenCalledWith({
      path: { card_id: 'card_x' },
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: 70 },
              print_step: { default: 1 },
              print_strategy: 'fast',
            },
          },
        }),
        sequence: 1,
        uuid: 'u1',
      },
    });
    expect(fakeClient.cardkit.v1.cardElement.content).toHaveBeenCalledWith({
      path: { card_id: 'card_x', element_id: 'main' },
      data: { content: 'text', sequence: 2, uuid: 'u2' },
    });
    expect(fakeClient.cardkit.v1.cardElement.patch).toHaveBeenCalledWith({
      path: { card_id: 'card_x', element_id: 'loader' },
      data: { partial_element: JSON.stringify({ img_key: 'img_x' }), sequence: 3, uuid: 'u3' },
    });
  });
});
