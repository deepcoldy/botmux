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

  it('parses messageQuota.defaultLimit only when a positive integer', () => {
    const ok = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'mq1', larkAppSecret: 's', messageQuota: { defaultLimit: 20 } }]));
    expect(ok[0].messageQuota).toEqual({ defaultLimit: 20 });
    for (const bad of [0, -3, 2.5, '20', null]) {
      const c = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'mqb', larkAppSecret: 's', messageQuota: { defaultLimit: bad } }]));
      expect(c[0].messageQuota).toBeUndefined();
    }
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'mq2', larkAppSecret: 's' }]))[0].messageQuota).toBeUndefined();
  });

  it('parses & sanitizes quotaState (scope-aware keys + positive int limit, used>=0)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'qs1', larkAppSecret: 's',
      quotaState: {
        'chat:oc_1:ou_a': { limit: 5, used: 2 },
        'global:ou_b': { limit: 3, used: 0 },
        'boguskey': { limit: 5, used: 0 },              // bad key shape
        'chat:oc_2:ou_c': { limit: 0, used: 0 },        // non-positive limit
        'global:ou_d': { limit: 4, used: -1 },          // negative used
        'global:ou_e': { limit: 2.5, used: 0 },         // non-integer
      },
    }]));
    expect(cfgs[0].quotaState).toEqual({
      'chat:oc_1:ou_a': { limit: 5, used: 2 },
      'global:ou_b': { limit: 3, used: 0 },
    });
  });

  it('leaves quotaState undefined when absent / all-invalid', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'qs2', larkAppSecret: 's' }]))[0].quotaState).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'qs3', larkAppSecret: 's', quotaState: { bad: 1 } }]))[0].quotaState).toBeUndefined();
  });

  it('parses restrictGrantCommands only as strict boolean true (else undefined)', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rc1', larkAppSecret: 's', restrictGrantCommands: true }]))[0].restrictGrantCommands).toBe(true);
    for (const bad of [false, 'true', 1, undefined]) {
      const c = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rc2', larkAppSecret: 's', restrictGrantCommands: bad }]));
      expect(c[0].restrictGrantCommands).toBeUndefined();
    }
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rc3', larkAppSecret: 's' }]))[0].restrictGrantCommands).toBeUndefined();
  });
});
