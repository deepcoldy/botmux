import { describe, it, expect } from 'vitest';
import { parseBotConfigsFromText, getOwnerOpenId, registerBot } from '../src/bot-registry.js';
import { GRANT_DURATION_OPTIONS } from '../src/services/grant-policy.js';

describe('bot-registry grant additions', () => {
  it('parseBotConfigsFromText preserves & filters chatReplyModes (four-state incl. chat-topic)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'rm1', larkAppSecret: 's',
      chatReplyModes: { oc_1: 'shared', oc_2: 'chat', oc_4: 'new-topic', oc_5: 'topic_alias', oc_6: 'topic', oc_7: 'chat-topic', oc_3: 'bad', '': 'shared' },
    }]));
    expect(cfgs[0].chatReplyModes).toEqual({ oc_1: 'shared', oc_2: 'chat', oc_4: 'new-topic', oc_5: 'shared', oc_6: 'shared', oc_7: 'chat-topic' });
  });

  it('parseBotConfigsFromText leaves chatReplyModes undefined when absent/all-invalid', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rm2', larkAppSecret: 's' }]))[0].chatReplyModes).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rm3', larkAppSecret: 's', chatReplyModes: { oc_1: 'nope' } }]))[0].chatReplyModes).toBeUndefined();
  });

  it('parseBotConfigsFromText preserves & filters chatMentionModes (four-state)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'mm1', larkAppSecret: 's',
      chatMentionModes: {
        oc_1: 'always', oc_2: 'topic', oc_3: 'never', oc_4: 'ambient',
        // Case/padding are normalized; unknown values and blank chat ids are dropped.
        oc_5: '  NEVER  ', oc_6: 'bogus', oc_7: 42, '': 'never', '   ': 'always',
      },
    }]));
    expect(cfgs[0].chatMentionModes).toEqual({
      oc_1: 'always', oc_2: 'topic', oc_3: 'never', oc_4: 'ambient', oc_5: 'never',
    });
  });

  it('parseBotConfigsFromText leaves chatMentionModes undefined when absent/all-invalid/not-an-object', () => {
    const at = (entry: Record<string, unknown>) =>
      parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'mm2', larkAppSecret: 's', ...entry }]))[0].chatMentionModes;
    expect(at({})).toBeUndefined();
    expect(at({ chatMentionModes: { oc_1: 'nope' } })).toBeUndefined();
    // An array is an object in JS — the parser must still reject it.
    expect(at({ chatMentionModes: ['always'] })).toBeUndefined();
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

  it('parseBotConfigsFromText preserves per-bot plugin ids after sanitizing and deduping', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'plg1',
      larkAppSecret: 's',
      plugins: ['agent-chrome', 'bad/id', 'agent-chrome', 'gitlab'],
    }]));
    expect(cfgs[0].plugins).toEqual(['agent-chrome', 'gitlab']);
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

  it('parses usageDisplay as a three-state enum, defaulting to streaming and honoring legacy showUsageInCardFooter', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'usage-default', larkAppSecret: 's' },
      { larkAppId: 'usage-streaming', larkAppSecret: 's', usageDisplay: 'streaming' },
      { larkAppId: 'usage-footer', larkAppSecret: 's', usageDisplay: 'footer' },
      { larkAppId: 'usage-off', larkAppSecret: 's', usageDisplay: 'off' },
      { larkAppId: 'usage-invalid', larkAppSecret: 's', usageDisplay: 'nonsense' },
      { larkAppId: 'usage-legacy-off', larkAppSecret: 's', showUsageInCardFooter: false },
      { larkAppId: 'usage-legacy-on', larkAppSecret: 's', showUsageInCardFooter: true },
    ]));
    // Default (unset) and explicit 'streaming' both persist as undefined (default).
    expect(cfgs[0].usageDisplay).toBeUndefined();
    expect(cfgs[1].usageDisplay).toBeUndefined();
    // Non-default modes persist verbatim.
    expect(cfgs[2].usageDisplay).toBe('footer');
    expect(cfgs[3].usageDisplay).toBe('off');
    // Invalid enum falls back to the default (undefined).
    expect(cfgs[4].usageDisplay).toBeUndefined();
    // Legacy boolean: false → 'off'; true → default streaming (undefined).
    expect(cfgs[5].usageDisplay).toBe('off');
    expect(cfgs[6].usageDisplay).toBeUndefined();
    // Legacy field is never re-emitted.
    expect((cfgs[5] as any).showUsageInCardFooter).toBeUndefined();
  });

  it('parses pinStreamingCard only as strict boolean true', () => {
    expect(parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'pin1', larkAppSecret: 's', pinStreamingCard: true },
    ]))[0].pinStreamingCard).toBe(true);

    for (const bad of [undefined, false, 'true', 1, null]) {
      const [cfg] = parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'pin2', larkAppSecret: 's', pinStreamingCard: bad },
      ]));
      expect(cfg.pinStreamingCard).toBeUndefined();
    }
  });

  it('parses noPinStreamingCardChats as a trimmed, deduplicated string list', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'pin_chat_1',
      larkAppSecret: 's',
      noPinStreamingCardChats: [' oc_chat_a ', 'oc_chat_b', '', '   ', 'oc_chat_a', 1, null],
    }]));
    expect(cfg.noPinStreamingCardChats).toEqual(['oc_chat_a', 'oc_chat_b']);
  });

  it('leaves noPinStreamingCardChats undefined when absent, non-array, or all invalid', () => {
    expect(parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'pin_chat_2', larkAppSecret: 's' },
    ]))[0].noPinStreamingCardChats).toBeUndefined();

    expect(parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'pin_chat_3', larkAppSecret: 's', noPinStreamingCardChats: 'oc_chat_a' },
    ]))[0].noPinStreamingCardChats).toBeUndefined();

    expect(parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'pin_chat_4', larkAppSecret: 's', noPinStreamingCardChats: ['', '  ', 1, null] },
    ]))[0].noPinStreamingCardChats).toBeUndefined();
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

  it('parses grantDefaultDurationMs only from the finite card options', () => {
    for (const durationMs of GRANT_DURATION_OPTIONS) {
      const config = parseBotConfigsFromText(JSON.stringify([{
        larkAppId: `gd${durationMs}`,
        larkAppSecret: 's',
        grantDefaultDurationMs: durationMs,
      }]))[0];
      expect(config.grantDefaultDurationMs).toBe(durationMs);
    }
    for (const bad of [undefined, null, '3600000', 0, -1, 2.5, 2 * 60 * 60 * 1000]) {
      const config = parseBotConfigsFromText(JSON.stringify([{
        larkAppId: 'gd_bad',
        larkAppSecret: 's',
        grantDefaultDurationMs: bad,
      }]))[0];
      expect(config.grantDefaultDurationMs).toBeUndefined();
    }
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

  it('parses autoGrantRequestCards as default-on with explicit false override', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'ag1', larkAppSecret: 's' }]))[0].autoGrantRequestCards).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'ag2', larkAppSecret: 's', autoGrantRequestCards: true }]))[0].autoGrantRequestCards).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'ag3', larkAppSecret: 's', autoGrantRequestCards: false }]))[0].autoGrantRequestCards).toBe(false);
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'ag4', larkAppSecret: 's', autoGrantRequestCards: 'false' }]))[0].autoGrantRequestCards).toBeUndefined();
  });

  it('parses regularGroupReplyMode: keeps chat|new-topic|shared, drops chat-topic/invalid/absent to undefined', () => {
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1', larkAppSecret: 's', regularGroupReplyMode: 'new-topic' }]))[0].regularGroupReplyMode).toBe('new-topic');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1b', larkAppSecret: 's', regularGroupReplyMode: 'shared' }]))[0].regularGroupReplyMode).toBe('shared');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1c', larkAppSecret: 's', regularGroupReplyMode: 'topic_alias' }]))[0].regularGroupReplyMode).toBe('shared');
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1d', larkAppSecret: 's', regularGroupReplyMode: 'topic' }]))[0].regularGroupReplyMode).toBe('shared');
    // 'chat' must SURVIVE the load round-trip — it is now a NON-default explicit
    // opt-out (the per-bot default is 'chat-topic'), so it must persist.
    expect(parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'rg1e', larkAppSecret: 's', regularGroupReplyMode: 'chat' }]))[0].regularGroupReplyMode).toBe('chat');
    // 'chat-topic' is the default → normalized to undefined so bots.json stays clean.
    for (const bad of ['chat-topic', 'chat_topic', 'bad', true, 1, undefined]) {
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

	  it('parses p2pMode only as literal thread (else undefined = chat default)', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'p1', larkAppSecret: 's', p2pMode: 'chat' },
      { larkAppId: 'p2', larkAppSecret: 's', p2pMode: 'thread' },
      { larkAppId: 'p3', larkAppSecret: 's' },
      { larkAppId: 'p4', larkAppSecret: 's', p2pMode: 'invalid' },
    ]));
    expect(cfgs[0].p2pMode).toBeUndefined(); // 'chat' is the default → normalizes to undefined
    expect(cfgs[1].p2pMode).toBe('thread');  // 'thread' is the explicit opt-out → persists
    expect(cfgs[2].p2pMode).toBeUndefined();
    expect(cfgs[3].p2pMode).toBeUndefined();
  });

  it('parses summaryRange and preserves explicit unlimited settings', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'sr1', larkAppSecret: 's', summaryRange: { limit: 0, sinceHours: 0 } },
      { larkAppId: 'sr2', larkAppSecret: 's', summaryRange: { limit: 20, sinceHours: 8 } },
      { larkAppId: 'sr3', larkAppSecret: 's', summaryRange: { limit: -1, sinceHours: 1.5 } },
    ]));

    expect(cfgs[0].summaryRange).toEqual({ limit: 0, sinceHours: 0 });
    expect(cfgs[1].summaryRange).toEqual({ limit: 20, sinceHours: 8 });
    expect(cfgs[2].summaryRange).toBeUndefined();
  });

  it('parses summaryMemory as a default-off boolean', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'sm1', larkAppSecret: 's', summaryMemory: true, summaryMemoryPath: 'docs/summary.md' },
      { larkAppId: 'sm2', larkAppSecret: 's', summaryMemory: false, summaryMemoryPath: '/tmp/botmux-summary.md' },
      { larkAppId: 'sm3', larkAppSecret: 's', summaryMemory: 'true' },
      { larkAppId: 'sm4', larkAppSecret: 's', summaryMemory: true, summaryMemoryPath: '   ' },
      { larkAppId: 'sm5', larkAppSecret: 's', summaryMemory: true, summaryMemoryPath: 123 },
    ]));

    expect(cfgs[0].summaryMemory).toBe(true);
    expect(cfgs[0].summaryMemoryPath).toBe('docs/summary.md');
    expect(cfgs[1].summaryMemory).toBeUndefined();
    expect(cfgs[1].summaryMemoryPath).toBe('/tmp/botmux-summary.md');
    expect(cfgs[2].summaryMemory).toBeUndefined();
    expect(cfgs[2].summaryMemoryPath).toBeUndefined();
    expect(cfgs[3].summaryMemoryPath).toBeUndefined();
    expect(cfgs[4].summaryMemoryPath).toBeUndefined();
  });

  it('parses legacy contentTriggers and preserves explicit unlimited history settings', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'ct1',
      larkAppSecret: 's',
      contentTriggers: [{
        name: 'summary-trigger',
        enabled: true,
        scope: 'both',
        allowBotMessages: true,
        match: { type: 'keyword', pattern: '总结', caseSensitive: false },
        history: {
          topic: { mode: 'current-thread' },
          regularGroup: { mode: 'recent-messages', limit: 0, sinceHours: 0 },
        },
        action: { type: 'start-or-wake-session', prompt: '请总结当前历史。' },
      }],
    }]));

    expect(cfgs[0].contentTriggers).toEqual([{
      name: 'summary-trigger',
      enabled: true,
      scope: 'both',
      allowBotMessages: true,
      match: { type: 'keyword', pattern: '总结', caseSensitive: false },
      history: {
        topic: { mode: 'current-thread' },
        regularGroup: { mode: 'recent-messages', limit: 0, sinceHours: 0 },
      },
      action: { type: 'start-or-wake-session', prompt: '请总结当前历史。' },
    }]);
  });

	  it('drops invalid legacy content trigger regex without failing the whole bot config', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'ct2',
      larkAppSecret: 's',
      contentTriggers: [
        {
          name: 'bad-regex',
          scope: 'both',
          match: { type: 'regex', pattern: '[', caseSensitive: false },
          action: { type: 'start-or-wake-session', prompt: 'bad' },
        },
        {
          name: 'good-regex',
          scope: 'regularGroup',
          match: { type: 'regex', pattern: 'done\\s*$', caseSensitive: true },
          action: { type: 'start-or-wake-session', prompt: 'good' },
        },
      ],
    }]));

    expect(cfgs[0].contentTriggers?.map(t => t.name)).toEqual(['good-regex']);
  });
});
