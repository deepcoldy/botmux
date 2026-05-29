import { describe, it, expect } from 'vitest';
import { parseBotConfigsFromText, getOwnerOpenId, registerBot } from '../src/bot-registry.js';

describe('bot-registry grant additions', () => {
  it('parseBotConfigsFromText preserves & filters chatGrants', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a1', larkAppSecret: 's',
      chatGrants: { oc_1: ['ou_a', 'ou_b', 123], oc_2: 'bad', oc_3: ['ou_c'], oc_4: [] },
    }]));
    expect(cfgs[0].chatGrants).toEqual({ oc_1: ['ou_a', 'ou_b'], oc_3: ['ou_c'] });
  });

  it('parseBotConfigsFromText leaves chatGrants undefined when absent', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'a1b', larkAppSecret: 's' }]));
    expect(cfgs[0].chatGrants).toBeUndefined();
  });

  it('parseBotConfigsFromText preserves & filters globalGrants (open_id strings only)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'gg1', larkAppSecret: 's',
      globalGrants: ['ou_a', 'ou_b', 123, '', '   ', 'ou_c'],
    }]));
    expect(cfgs[0].globalGrants).toEqual(['ou_a', 'ou_b', 'ou_c']);
  });

  it('parseBotConfigsFromText leaves globalGrants undefined when absent / all-invalid / non-array', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gg2', larkAppSecret: 's' }]))[0].globalGrants).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gg3', larkAppSecret: 's', globalGrants: [1, 2, ''] }]))[0].globalGrants).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gg4', larkAppSecret: 's', globalGrants: 'nope' }]))[0].globalGrants).toBeUndefined();
  });

  it('parseBotConfigsFromText preserves brandLabel, distinguishing unset/off/custom', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'b_unset', larkAppSecret: 's' },
      { larkAppId: 'b_off', larkAppSecret: 's', brandLabel: '' },
      { larkAppId: 'b_custom', larkAppSecret: 's', brandLabel: '[Acme](https://acme.test)' },
      { larkAppId: 'b_nonstring', larkAppSecret: 's', brandLabel: 42 },
    ]));
    expect(cfgs[0].brandLabel).toBeUndefined();         // unset → default at render time
    expect(cfgs[1].brandLabel).toBe('');                // '' preserved → off
    expect(cfgs[2].brandLabel).toBe('[Acme](https://acme.test)');
    expect(cfgs[3].brandLabel).toBeUndefined();         // non-string ignored
  });

  it('getOwnerOpenId returns first ou_ in resolvedAllowedUsers', () => {
    registerBot({ larkAppId: 'a2', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['x@y.com', 'ou_owner', 'ou_2'] });
    expect(getOwnerOpenId('a2')).toBe('ou_owner');
  });

  it('getOwnerOpenId undefined when no resolved ou_', () => {
    registerBot({ larkAppId: 'a3', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['x@y.com'] });
    expect(getOwnerOpenId('a3')).toBeUndefined();
  });
});
