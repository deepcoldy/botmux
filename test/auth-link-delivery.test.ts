import { describe, expect, it, vi } from 'vitest';
import { deliverAuthLink } from '../src/core/auth-link-delivery.js';
import { t } from '../src/i18n/index.js';

const LINK = 'https://accounts.example/device/verify?user_code=ABCD';

function harness(dm: () => Promise<unknown> = async () => 'om_dm') {
  const inPlace: string[] = [];
  const direct: Array<[string, string]> = [];
  return {
    inPlace, direct,
    replyInPlace: async (text: string) => { inPlace.push(text); },
    sendDirect: vi.fn(async (openId: string, text: string) => { direct.push([openId, text]); return dm(); }),
  };
}

describe('deliverAuthLink', () => {
  it('1:1 chat: replies in place with the link', async () => {
    const h = harness();
    expect(await deliverAuthLink({ privateChat: true, openId: 'ou_a', text: LINK, ...h, locale: 'zh' })).toBe('inline');
    expect(h.inPlace).toEqual([LINK]);
    expect(h.direct).toEqual([]);
  });

  it('group: DMs the initiator, the group only hears that it was sent', async () => {
    const h = harness();
    expect(await deliverAuthLink({ privateChat: false, openId: 'ou_a', text: LINK, ...h, locale: 'zh' })).toBe('dm');
    expect(h.direct).toEqual([['ou_a', LINK]]);
    expect(h.inPlace).toEqual([t('auth_link.sent_privately', undefined, 'zh')]);
  });

  it('group, DM fails: asks for a private /login and never posts the link', async () => {
    const h = harness(async () => { throw new Error('230013'); });
    expect(await deliverAuthLink({
      privateChat: false, openId: 'ou_a', text: LINK, ...h, locale: 'zh', privateCommand: '/login bytedcli',
    })).toBe('dm_failed');
    expect(h.inPlace).toEqual([t('auth_link.dm_failed', { command: '/login bytedcli' }, 'zh')]);
    expect(h.inPlace.join('')).not.toContain(LINK);
  });

  it('group, DM delivered but the group notice fails: still reported as delivered, no "could not message you"', async () => {
    const direct: string[] = [];
    const inPlace: string[] = [];
    const outcome = await deliverAuthLink({
      privateChat: false, openId: 'ou_a', text: LINK, locale: 'zh',
      sendDirect: async (_o, text) => { direct.push(text); },
      replyInPlace: async text => { inPlace.push(text); throw new Error('group send failed'); },
    });
    expect(outcome).toBe('dm');
    expect(direct).toEqual([LINK]);
    expect(inPlace).toEqual([t('auth_link.sent_privately', undefined, 'zh')]);
  });

  it('group without a usable initiator: no DM to anyone, no link in the group', async () => {
    const h = harness();
    expect(await deliverAuthLink({ privateChat: false, openId: undefined, text: LINK, ...h, locale: 'zh' })).toBe('dm_failed');
    expect(h.sendDirect).not.toHaveBeenCalled();
    expect(h.inPlace.join('')).not.toContain(LINK);
  });
});
