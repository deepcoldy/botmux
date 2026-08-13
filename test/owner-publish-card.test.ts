import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return { ...actual, getOwnerOpenId: vi.fn(() => 'ou_owner') };
});

import {
  OWNER_PUBLISH_ACTION,
  buildOwnerPublishEphemeralCard,
  buildOwnerPublishPublicCard,
  handleOwnerPublishAction,
} from '../src/im/lark/owner-publish-card.js';
import {
  _ownerPublishCountForTest,
  _resetOwnerPublishForTest,
  claimOwnerPublish,
  registerOwnerPublish,
} from '../src/im/lark/owner-publish-pending.js';

const APP = 'cli_a';
const CHAT = 'oc_group';
const ELEMENTS = [{ tag: 'markdown', content: '答案：xxx' }];

function register(nonce: string): void {
  registerOwnerPublish(nonce, {
    ownerOpenId: 'ou_owner',
    chatId: CHAT,
    publishCardJson: buildOwnerPublishPublicCard(ELEMENTS),
  });
}

beforeEach(() => {
  _resetOwnerPublishForTest();
});

describe('owner-publish card', () => {
  it('ephemeral card carries the 采纳 button with action+nonce; public card has neither button nor 「仅对你可见」', () => {
    const ephemeral = JSON.parse(buildOwnerPublishEphemeralCard(ELEMENTS, 'n1'));
    const buttons = ephemeral.elements.flatMap((e: any) => e.actions ?? []);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].value).toEqual({ action: OWNER_PUBLISH_ACTION, nonce: 'n1' });

    const pub = JSON.parse(buildOwnerPublishPublicCard(ELEMENTS));
    expect(pub.elements.some((e: any) => e.actions)).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('仅对你可见');
  });

  it('non-owner click is blocked (never publishes, nonce stays live)', async () => {
    register('n1');
    const sendMessage = vi.fn(async () => 'om_pub');
    const deleteEphemeralCard = vi.fn(async () => true);
    const res = await handleOwnerPublishAction(
      { action: OWNER_PUBLISH_ACTION, nonce: 'n1' },
      'ou_intruder', 'om_eph', APP,
      { sendMessage, deleteEphemeralCard },
    );
    expect(res.toast.type).toBe('error');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(_ownerPublishCountForTest()).toBe(1); // still claimable
  });

  it('owner click publishes to the group then deletes the ephemeral card', async () => {
    register('n1');
    const sendMessage = vi.fn(async () => 'om_pub');
    const deleteEphemeralCard = vi.fn(async () => true);
    const res = await handleOwnerPublishAction(
      { action: OWNER_PUBLISH_ACTION, nonce: 'n1' },
      'ou_owner', 'om_eph', APP,
      { sendMessage, deleteEphemeralCard },
    );
    expect(res.toast.type).toBe('success');
    expect(sendMessage).toHaveBeenCalledWith(APP, CHAT, buildOwnerPublishPublicCard(ELEMENTS), 'interactive');
    expect(deleteEphemeralCard).toHaveBeenCalledWith(APP, 'om_eph');
    expect(_ownerPublishCountForTest()).toBe(0); // burned
  });

  it('double-tap does not publish twice (nonce is one-shot)', async () => {
    register('n1');
    const sendMessage = vi.fn(async () => 'om_pub');
    const deleteEphemeralCard = vi.fn(async () => true);
    const deps = { sendMessage, deleteEphemeralCard };
    await handleOwnerPublishAction({ action: OWNER_PUBLISH_ACTION, nonce: 'n1' }, 'ou_owner', 'om_eph', APP, deps);
    const second = await handleOwnerPublishAction({ action: OWNER_PUBLISH_ACTION, nonce: 'n1' }, 'ou_owner', 'om_eph', APP, deps);
    expect(second.toast.type).toBe('info');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('unknown / missing nonce → stale-ish toast, no publish', async () => {
    const sendMessage = vi.fn(async () => 'om_pub');
    const deleteEphemeralCard = vi.fn(async () => true);
    const missing = await handleOwnerPublishAction({ action: OWNER_PUBLISH_ACTION }, 'ou_owner', 'om_eph', APP, { sendMessage, deleteEphemeralCard });
    expect(missing.toast.type).toBe('warning');
    const unknown = await handleOwnerPublishAction({ action: OWNER_PUBLISH_ACTION, nonce: 'nope' }, 'ou_owner', 'om_eph', APP, { sendMessage, deleteEphemeralCard });
    expect(unknown.toast.type).toBe('info');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('publish failure rolls back the nonce so the owner can retry; ephemeral card is kept', async () => {
    register('n1');
    const sendMessage = vi.fn(async () => { throw new Error('network'); });
    const deleteEphemeralCard = vi.fn(async () => true);
    const res = await handleOwnerPublishAction(
      { action: OWNER_PUBLISH_ACTION, nonce: 'n1' },
      'ou_owner', 'om_eph', APP,
      { sendMessage, deleteEphemeralCard },
    );
    expect(res.toast.type).toBe('error');
    expect(deleteEphemeralCard).not.toHaveBeenCalled(); // ephemeral stays so owner still sees it
    expect(_ownerPublishCountForTest()).toBe(1); // rolled back → retryable
  });

  it('claimOwnerPublish returns the payload exactly once', () => {
    register('n1');
    expect(claimOwnerPublish('n1')?.chatId).toBe(CHAT);
    expect(claimOwnerPublish('n1')).toBeNull();
  });
});
