import { describe, it, expect } from 'vitest';
import { parseBotConfigsFromText, getOwnerOpenId, registerBot } from '../src/bot-registry.js';

describe('bot-registry grant additions', () => {
  it('parseBotConfigsFromText preserves & filters chatReplyModes (tri-state)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'rm1', larkAppSecret: 's',
      chatReplyModes: { oc_1: 'shared', oc_2: 'chat', oc_4: 'new-topic', oc_5: 'topic_alias', oc_6: 'topic', oc_3: 'bad', '': 'shared' },
    }]));
    expect(cfgs[0].chatReplyModes).toEqual({ oc_1: 'shared', oc_2: 'chat', oc_4: 'new-topic', oc_5: 'shared', oc_6: 'shared' });
  });

  it('parseBotConfigsFromText leaves chatReplyModes undefined when absent/all-invalid', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rm2', larkAppSecret: 's' }]))[0].chatReplyModes).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rm3', larkAppSecret: 's', chatReplyModes: { oc_1: 'nope' } }]))[0].chatReplyModes).toBeUndefined();
  });

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

  it('parses regularGroupReplyMode: keeps new-topic|shared, drops chat/invalid/absent to undefined', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1', larkAppSecret: 's', regularGroupReplyMode: 'new-topic' }]))[0].regularGroupReplyMode).toBe('new-topic');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1b', larkAppSecret: 's', regularGroupReplyMode: 'shared' }]))[0].regularGroupReplyMode).toBe('shared');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1c', larkAppSecret: 's', regularGroupReplyMode: 'topic_alias' }]))[0].regularGroupReplyMode).toBe('shared');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1d', larkAppSecret: 's', regularGroupReplyMode: 'topic' }]))[0].regularGroupReplyMode).toBe('shared');
    // 'chat' is the default → normalized to undefined so bots.json stays clean.
    for (const bad of ['chat', 'bad', true, 1, undefined]) {
      const c = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg2', larkAppSecret: 's', regularGroupReplyMode: bad }]));
      expect(c[0].regularGroupReplyMode).toBeUndefined();
    }
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg3', larkAppSecret: 's' }]))[0].regularGroupReplyMode).toBeUndefined();
  });

  it('parses regularGroupMentionMode: keeps topic|never, drops always/invalid/absent to undefined', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gm1', larkAppSecret: 's', regularGroupMentionMode: 'topic' }]))[0].regularGroupMentionMode).toBe('topic');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gm1b', larkAppSecret: 's', regularGroupMentionMode: 'never' }]))[0].regularGroupMentionMode).toBe('never');
    // 'always' is the default → normalized to undefined so bots.json stays clean.
    for (const bad of ['always', 'bad', true, 1, undefined]) {
      const c = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gm2', larkAppSecret: 's', regularGroupMentionMode: bad }]));
      expect(c[0].regularGroupMentionMode).toBeUndefined();
    }
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'gm3', larkAppSecret: 's' }]))[0].regularGroupMentionMode).toBeUndefined();
  });

  it('does not parse repoPickerMode from bots.json because it is global config', () => {
    const cfg = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rpm1', larkAppSecret: 's', repoPickerMode: 'repos' }]))[0] as any;
    expect(cfg.repoPickerMode).toBeUndefined();
  });

  it('parses p2pMode only as literal chat (else undefined = thread default)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'p1', larkAppSecret: 's', p2pMode: 'chat' },
      { larkAppId: 'p2', larkAppSecret: 's', p2pMode: 'thread' },
      { larkAppId: 'p3', larkAppSecret: 's' },
      { larkAppId: 'p4', larkAppSecret: 's', p2pMode: 'invalid' },
    ]));
    expect(cfgs[0].p2pMode).toBe('chat');
    expect(cfgs[1].p2pMode).toBeUndefined(); // 'thread' normalizes to undefined
    expect(cfgs[2].p2pMode).toBeUndefined();
    expect(cfgs[3].p2pMode).toBeUndefined();
  });
});
