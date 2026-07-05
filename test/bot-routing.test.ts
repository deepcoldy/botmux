/**
 * Unit tests for `botmux send` same-name bot disambiguation.
 *
 * Regression: bots-info.json can hold multiple entries with the same
 * `botName` (multi-tenant deployments running two apps under the same
 * display name). Cross-ref reverse lookup used `Array.find` on botName,
 * which silently routed to whichever entry sorted first — typically not
 * the one bound to the outbound chat. `pickBotEntryByName` now prefers
 * the entry whose `oncallChats` includes the outbound `chatId`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFooterAddressing,
  hasKnownBotMention,
  orderedFooterRecipients,
  pickBotEntryByName,
  stripCodeSpans,
} from '../src/utils/bot-routing.js';

type Entry = { larkAppId: string; botName: string | null };

const ENTRY_COCO_UNBOUND: Entry = { larkAppId: 'cli_coco_unbound', botName: 'CoCo' };
const ENTRY_COCO_BOUND: Entry = { larkAppId: 'cli_coco_bound', botName: 'CoCo' };
const ENTRY_CLAUDE: Entry = { larkAppId: 'cli_claude', botName: 'Claude' };
const TARGET_CHAT = 'oc_target_chat';

describe('pickBotEntryByName', () => {
  it('returns undefined when no entry matches the name', () => {
    const result = pickBotEntryByName(
      [ENTRY_CLAUDE],
      'CoCo',
      TARGET_CHAT,
      new Map(),
    );
    expect(result).toBeUndefined();
  });

  it('returns the sole match when only one entry has the name', () => {
    const result = pickBotEntryByName(
      [ENTRY_CLAUDE, ENTRY_COCO_UNBOUND],
      'CoCo',
      TARGET_CHAT,
      new Map(),
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });

  it('prefers the same-named bot bound to the outbound chat over the first match', () => {
    // bots-info.json order: unbound CoCo first, bound CoCo second.
    // Without oncall preference, Array.find would silently return unbound.
    const oncallChatsByApp = new Map([
      [ENTRY_COCO_BOUND.larkAppId, new Set([TARGET_CHAT])],
    ]);
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND, ENTRY_COCO_BOUND],
      'CoCo',
      TARGET_CHAT,
      oncallChatsByApp,
    );
    expect(result).toEqual(ENTRY_COCO_BOUND);
  });

  it('falls back to the first match when no candidate is bound to the chat', () => {
    // None bound — preserve old behavior (route to whichever bots-info.json
    // sorts first) so single-instance deployments keep working unchanged.
    const oncallChatsByApp = new Map([
      [ENTRY_COCO_BOUND.larkAppId, new Set(['oc_some_other_chat'])],
    ]);
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND, ENTRY_COCO_BOUND],
      'CoCo',
      TARGET_CHAT,
      oncallChatsByApp,
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });

  it('falls back to the first match when targetChatId is missing', () => {
    // Top-level publish (no specific chat) — no preference to apply.
    const oncallChatsByApp = new Map([
      [ENTRY_COCO_BOUND.larkAppId, new Set([TARGET_CHAT])],
    ]);
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND, ENTRY_COCO_BOUND],
      'CoCo',
      undefined,
      oncallChatsByApp,
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });

  it('matches case-insensitively', () => {
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND],
      'coco',
      TARGET_CHAT,
      new Map(),
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });
});

describe('hasKnownBotMention', () => {
  const entries = [
    { larkAppId: 'cli_self', botName: 'Ayla', cliId: 'aiden' },
    { larkAppId: 'cli_claude', botName: 'Claude', cliId: 'claude-code' },
    { larkAppId: 'cli_codex', botName: 'Codex', cliId: 'codex' },
  ];
  const crossRef = {
    Claude: 'ou_claude_seen_by_self',
    Codex: 'ou_codex_seen_by_self',
  };

  it('does not treat explanatory @BotName text as an actual handoff', () => {
    expect(hasKnownBotMention('没有 @Codex 被误唤醒', [], entries, crossRef, 'cli_self')).toBe(false);
  });

  it('detects an explicit --mention target by sender-scoped open_id', () => {
    expect(hasKnownBotMention('请 review', [
      { open_id: 'ou_codex_seen_by_self', name: '' },
    ], entries, crossRef, 'cli_self')).toBe(true);
  });

  it('does not treat a human mention as a bot target', () => {
    expect(hasKnownBotMention('请看看', [
      { open_id: 'ou_human', name: 'Alice' },
    ], entries, crossRef, 'cli_self')).toBe(false);
  });

  it('detects an actual bot mention by known display name', () => {
    expect(hasKnownBotMention('请 review', [
      { open_id: 'ou_unknown_to_test', name: 'Claude' },
    ], entries, crossRef, 'cli_self')).toBe(true);
  });
});

describe('buildFooterAddressing', () => {
  const knownBotOpenIds = new Set(['ou_claude_bot', 'ou_codex_bot']);

  it('addresses the owner outside oncall chats', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_owner', lastCallerOpenId: 'ou_caller' },
      { isOncall: false, knownBotOpenIds },
    )).toEqual({ sendTo: 'ou_owner', cc: [] });
  });

  it('uses the last caller in oncall chats when the caller is human', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_owner', lastCallerOpenId: 'ou_human_caller' },
      { isOncall: true, knownBotOpenIds },
    )).toEqual({ sendTo: 'ou_human_caller', cc: [] });
  });

  it('suppresses owner addressing in oncall when the body explicitly targets a bot', () => {
    // Handoff to another bot: the default owner-courtesy ping is redundant noise
    // and is dropped. A human is looped in only via explicit --mention-back.
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_owner', lastCallerOpenId: 'ou_claude_bot' },
      { isOncall: true, hasExplicitBotMention: true, knownBotOpenIds },
    )).toEqual({ sendTo: undefined, cc: [] });
  });

  it('suppresses owner addressing outside oncall when explicitly targeting a bot', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_owner', lastCallerOpenId: 'ou_human_caller' },
      { isOncall: false, hasExplicitBotMention: true, knownBotOpenIds },
    )).toEqual({ sendTo: undefined, cc: [] });
  });

  it('drops explicit-bot addressing when the owner is also a bot', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_codex_bot', lastCallerOpenId: 'ou_claude_bot' },
      { isOncall: true, hasExplicitBotMention: true, knownBotOpenIds },
    )).toEqual({ sendTo: undefined, cc: [] });
  });

  it('falls back to the human owner when last caller is a bot', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_owner', lastCallerOpenId: 'ou_claude_bot' },
      { isOncall: true, knownBotOpenIds },
    )).toEqual({ sendTo: 'ou_owner', cc: [] });
  });

  it('drops addressing when the resolved recipient would be a bot', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_codex_bot', lastCallerOpenId: 'ou_claude_bot' },
      { isOncall: true, knownBotOpenIds },
    )).toEqual({ sendTo: undefined, cc: [] });
  });

  it('drops non-oncall addressing when the owner is a bot', () => {
    expect(buildFooterAddressing(
      { ownerOpenId: 'ou_codex_bot' },
      { isOncall: false, knownBotOpenIds },
    )).toEqual({ sendTo: undefined, cc: [] });
  });
});

describe('orderedFooterRecipients', () => {
  it('puts the human addressee first, then explicit mention targets', () => {
    expect(orderedFooterRecipients({
      sendTo: 'ou_human',
      mentionIds: ['ou_bot_a', 'ou_bot_b'],
    })).toEqual(['ou_human', 'ou_bot_a', 'ou_bot_b']);
  });

  it('de-dupes when a mention target equals the human addressee', () => {
    // --mention-back @ 了触发者，footer 又指向同一个 owner/caller
    expect(orderedFooterRecipients({
      sendTo: 'ou_human',
      mentionIds: ['ou_human', 'ou_bot_a'],
    })).toEqual(['ou_human', 'ou_bot_a']);
  });

  it('skips ids already inlined in the body prose', () => {
    expect(orderedFooterRecipients({
      sendTo: 'ou_human',
      mentionIds: ['ou_bot_a', 'ou_bot_b'],
      inlinedIds: new Set(['ou_bot_a']),
    })).toEqual(['ou_human', 'ou_bot_b']);
  });

  it('omits the human addressee when there is none (e.g. --top-level)', () => {
    expect(orderedFooterRecipients({
      mentionIds: ['ou_bot_a'],
    })).toEqual(['ou_bot_a']);
  });

  it('appends cc after mention targets, de-duped', () => {
    expect(orderedFooterRecipients({
      sendTo: 'ou_human',
      mentionIds: ['ou_bot_a'],
      cc: ['ou_bot_a', 'ou_cc'],
    })).toEqual(['ou_human', 'ou_bot_a', 'ou_cc']);
  });

  it('returns empty when nothing to address', () => {
    expect(orderedFooterRecipients({})).toEqual([]);
  });
});

describe('stripCodeSpans', () => {
  // The prose `@Bot` auto-injection scans this stripped copy: a bot name inside
  // code must NOT survive (else it wakes a bot the model only quoted), while a
  // name in real prose must survive so a genuine handoff still fires.
  const hasAt = (s: string, name: string) =>
    new RegExp(`@${name}(?![\\p{L}\\p{N}_])`, 'u').test(stripCodeSpans(s));

  it('blanks an inline single-backtick code span', () => {
    expect(hasAt('示例：`botmux send --mention @Codex …`', 'Codex')).toBe(false);
  });

  it('blanks a double-backtick code span', () => {
    expect(hasAt('写成 ``@Codex`` 只是举例', 'Codex')).toBe(false);
  });

  it('blanks a fenced code block', () => {
    expect(hasAt('```\nbotmux send --mention @Codex\n```', 'Codex')).toBe(false);
  });

  it('blanks a tilde-fenced code block', () => {
    expect(hasAt('~~~\nbotmux send --mention @Codex\n~~~', 'Codex')).toBe(false);
  });

  it('keeps @Bot inside ~~strikethrough~~ (not a fence)', () => {
    expect(hasAt('~~@Codex~~ 还是要 @', 'Codex')).toBe(true);
  });

  it('keeps a real prose @Bot so genuine handoffs still match', () => {
    expect(hasAt('@Codex 你接手一下', 'Codex')).toBe(true);
  });

  it('keeps prose @Bot even when the same name is also quoted in code', () => {
    // real handoff in prose + an incidental code mention → still detected
    expect(hasAt('@Codex 看这条 `--mention @Codex`', 'Codex')).toBe(true);
  });

  it('leaves an unbalanced stray backtick harmless (name still in prose)', () => {
    expect(hasAt('这里有个 ` 未闭合，@Codex 仍要 @', 'Codex')).toBe(true);
  });
});
