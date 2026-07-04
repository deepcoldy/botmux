/**
 * Phase 0 keystone — `botmux dispatch` pure core.
 *
 * The orchestrator dispatches a sub-project to a small group of bots (often a
 * coder + a reviewer) by seeding a fresh Lark thread and @-mentioning them so
 * each spawns its own thread-scoped session. These tests pin the message
 * construction: the right bots get @-ed (so they actually trigger), the brief
 * reaches the thread, and per-bot roles are surfaced.
 *
 * Run: pnpm vitest run test/dispatch.test.ts
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAncestorSessionContext } from '../src/core/session-marker.js';
import {
  parseDispatchBotSpec,
  buildDispatchMessages,
  buildRepoPrimeText,
  buildReportContent,
  findSubBotTopic,
  eligibleAutoMentionAliases,
  offTopicSubBotTopic,
  resolveReportTarget,
  resolveSendTarget,
} from '../src/core/dispatch.js';

describe('parseDispatchBotSpec', () => {
  it('parses a bare open_id', () => {
    expect(parseDispatchBotSpec('ou_123')).toEqual({ openId: 'ou_123' });
  });
  it('parses open_id:name', () => {
    expect(parseDispatchBotSpec('ou_123:Alice')).toEqual({ openId: 'ou_123', name: 'Alice' });
  });
  it('parses open_id:name:role', () => {
    expect(parseDispatchBotSpec('ou_123:Alice:coder')).toEqual({
      openId: 'ou_123',
      name: 'Alice',
      role: 'coder',
    });
  });
  it('throws on an empty spec', () => {
    expect(() => parseDispatchBotSpec('   ')).toThrow();
  });
});

describe('buildDispatchMessages', () => {
  const bots = [
    { openId: 'ou_a', name: 'Alice', role: 'coder' },
    { openId: 'ou_b', name: 'Bob', role: 'reviewer' },
  ];

  const flatNodes = (content: Array<Array<{ tag: string; text?: string; user_id?: string }>>) =>
    content.flat();
  const allText = (content: Array<Array<{ tag: string; text?: string; user_id?: string }>>) =>
    flatNodes(content)
      .filter(n => n.tag === 'text')
      .map(n => n.text)
      .join('\n');

  it('seed message carries the sub-project title', () => {
    const r = buildDispatchMessages({ title: '实现登录模块', brief: 'x', bots });
    expect(r.seedText).toContain('实现登录模块');
  });

  it('@-mentions every assigned bot so they get triggered', () => {
    const r = buildDispatchMessages({ title: 't', brief: 'b', bots });
    expect(r.mentionedOpenIds).toEqual(['ou_a', 'ou_b']);
    const ats = flatNodes(r.threadContent)
      .filter(n => n.tag === 'at')
      .map(n => n.user_id);
    expect(ats).toEqual(['ou_a', 'ou_b']);
  });

  it('includes the brief text in the thread kickoff', () => {
    const r = buildDispatchMessages({ title: 't', brief: '把登录接口写完并自测', bots });
    expect(allText(r.threadContent)).toContain('把登录接口写完并自测');
  });

  it('surfaces each bot role for the coder+reviewer pattern', () => {
    const r = buildDispatchMessages({ title: 't', brief: 'b', bots });
    const text = allText(r.threadContent);
    expect(text).toContain('coder');
    expect(text).toContain('reviewer');
  });

  it('throws when no bots are assigned', () => {
    expect(() => buildDispatchMessages({ title: 't', brief: 'b', bots: [] })).toThrow();
  });

  it('throws on an empty title', () => {
    expect(() => buildDispatchMessages({ title: '   ', brief: 'b', bots })).toThrow();
  });
});

describe('buildRepoPrimeText', () => {
  const bots = [
    { openId: 'ou_a', name: 'Alice', role: 'coder' },
    { openId: 'ou_b', name: 'Bob', role: 'reviewer' },
  ];

  // The prime must be a TEXT message (with inline <at> tags), exactly like a
  // human typing "@bot /repo <path>". A structured `post` loses the path in the
  // live event (renderPostNode path); text goes through resolveMentions cleanly.
  it('@-mentions every bot via <at> tags so the text prime triggers each session', () => {
    const r = buildRepoPrimeText({ path: '/root/iserver/botmux', bots });
    expect(r.mentionedOpenIds).toEqual(['ou_a', 'ou_b']);
    expect(r.text).toContain('<at user_id="ou_a">');
    expect(r.text).toContain('<at user_id="ou_b">');
  });

  it('emits `/repo <path>` after the mentions (parses like a human-typed @bot /repo)', () => {
    const r = buildRepoPrimeText({ path: '/root/iserver/botmux', bots });
    expect(r.text).toContain('/repo /root/iserver/botmux');
    // /repo must come after the last <at> so that, post mention-strip, the
    // receiving daemon sees "/repo <path>" as the command.
    expect(r.text.indexOf('/repo')).toBeGreaterThan(r.text.lastIndexOf('</at>'));
  });

  it('throws on an empty path', () => {
    expect(() => buildRepoPrimeText({ path: '   ', bots })).toThrow();
  });

  it('throws when no bots are given', () => {
    expect(() => buildRepoPrimeText({ path: '/x', bots: [] })).toThrow();
  });
});

describe('buildReportContent', () => {
  it('@-mentions the orchestrator then carries the report on the first line', () => {
    const paras = buildReportContent({ orchOpenId: 'ou_orch', content: '子项目X 完成' });
    expect(paras).toHaveLength(1);
    expect(paras[0]).toEqual([
      { tag: 'at', user_id: 'ou_orch' },
      { tag: 'text', text: ' ' },
      { tag: 'text', text: '子项目X 完成' },
    ]);
  });

  it('keeps the @ on the first line and puts later lines in their own paragraphs', () => {
    const paras = buildReportContent({ orchOpenId: 'ou_orch', content: '完成\n产出在 /tmp/out' });
    expect(paras).toHaveLength(2);
    expect(paras[0][0]).toEqual({ tag: 'at', user_id: 'ou_orch' });
    expect(paras[0][2]).toEqual({ tag: 'text', text: '完成' });
    expect(paras[1]).toEqual([{ tag: 'text', text: '产出在 /tmp/out' }]);
  });

  it('throws on empty content', () => {
    expect(() => buildReportContent({ orchOpenId: 'ou_orch', content: '   ' })).toThrow();
  });

  it('throws on empty orchestrator open_id', () => {
    expect(() => buildReportContent({ orchOpenId: '  ', content: 'x' })).toThrow();
  });
});

describe('findSubBotTopic', () => {
  const registry = {
    'om_seedA': { orchChatId: 'oc_main', bots: ['ou_coder', 'ou_reviewer'] },
    'om_seedB': { orchChatId: 'oc_main', bots: ['ou_other'] },
    'om_seedC': { orchChatId: 'oc_else', bots: ['ou_coder'] },
  };
  const activeSeeds = new Set(['om_seedA', 'om_seedC']); // seedB's topic finished

  it('returns the topic seed when @-ing a dispatched sub-bot in an active topic of this chat', () => {
    expect(findSubBotTopic({ mentionOpenId: 'ou_coder', chatId: 'oc_main', registry, activeSeeds })).toBe('om_seedA');
  });

  it('returns null for a bot not dispatched anywhere', () => {
    expect(findSubBotTopic({ mentionOpenId: 'ou_stranger', chatId: 'oc_main', registry, activeSeeds })).toBeNull();
  });

  it('returns null when the dispatched topic is no longer active (stale registry entry)', () => {
    expect(findSubBotTopic({ mentionOpenId: 'ou_other', chatId: 'oc_main', registry, activeSeeds })).toBeNull();
  });

  it('prefers the most-recently dispatched active topic for the same bot', () => {
    const reg = {
      'om_old': { orchChatId: 'oc_main', bots: ['ou_coder'] },
      'om_new': { orchChatId: 'oc_main', bots: ['ou_coder'] },
    };
    const active = new Set(['om_old', 'om_new']);
    expect(findSubBotTopic({ mentionOpenId: 'ou_coder', chatId: 'oc_main', registry: reg, activeSeeds: active })).toBe('om_new');
  });

  it('does not fire across a different chat', () => {
    // ou_coder is also in seedC, but that topic is in oc_else, not oc_main
    expect(findSubBotTopic({ mentionOpenId: 'ou_coder', chatId: 'oc_zzz', registry, activeSeeds })).toBeNull();
  });
});

describe('eligibleAutoMentionAliases', () => {
  const selfAliases = new Set<string>(['claude', 'claude-code']);
  const convo = new Set<string>(['cli_reviewer_in_topic']);

  it('always includes the unique botName (supports first-time @-invite)', () => {
    const r = eligibleAutoMentionAliases({ botName: 'CoCo', cliId: 'coco', larkAppId: 'cli_not_in_convo', selfAliases, convoBotAppIds: convo });
    expect(r).toContain('CoCo');
  });

  it('includes the type-generic cliId ONLY when the bot is in the conversation', () => {
    const inTopic = eligibleAutoMentionAliases({ botName: 'Codex分身', cliId: 'codex', larkAppId: 'cli_reviewer_in_topic', selfAliases, convoBotAppIds: convo });
    expect(inTopic).toEqual(['Codex分身', 'codex']);
  });

  it('THE FIX: drops the cliId alias for a same-type bot NOT in the conversation (no fan-out)', () => {
    const elsewhere = eligibleAutoMentionAliases({ botName: 'Codex二号分身', cliId: 'codex', larkAppId: 'cli_other_codex', selfAliases, convoBotAppIds: convo });
    // botName still allowed (unique), but the shared "codex" cliId is NOT — so
    // "@Codex" (matching cliId) won't pull this off-topic codex bot in.
    expect(elsewhere).toEqual(['Codex二号分身']);
  });

  it('excludes self aliases entirely', () => {
    const r = eligibleAutoMentionAliases({ botName: 'Claude', cliId: 'claude-code', larkAppId: 'cli_reviewer_in_topic', selfAliases, convoBotAppIds: convo });
    expect(r).toEqual([]);
  });
});

describe('offTopicSubBotTopic', () => {
  const registry = { 'om_topicA': { orchChatId: 'oc_main', bots: ['ou_subbot', 'ou_reviewer'] } };
  const activeSeeds = new Set(['om_topicA']);

  it('returns the seed for an off-topic dispatched sub-bot (→ block/drop)', () => {
    expect(offTopicSubBotTopic({ mentionOpenId: 'ou_subbot', quoteTargetSenderOpenId: 'ou_human', chatId: 'oc_main', registry, activeSeeds })).toBe('om_topicA');
  });

  it('allows the current interlocutor (quoteTargetSender) even if it is a dispatched sub-bot', () => {
    expect(offTopicSubBotTopic({ mentionOpenId: 'ou_subbot', quoteTargetSenderOpenId: 'ou_subbot', chatId: 'oc_main', registry, activeSeeds })).toBeNull();
  });

  it('allows a bot that is not a dispatched sub-bot', () => {
    expect(offTopicSubBotTopic({ mentionOpenId: 'ou_stranger', quoteTargetSenderOpenId: 'ou_human', chatId: 'oc_main', registry, activeSeeds })).toBeNull();
  });

  it('allows when there is no dispatch registry', () => {
    expect(offTopicSubBotTopic({ mentionOpenId: 'ou_subbot', quoteTargetSenderOpenId: 'ou_human', chatId: 'oc_main', registry: {}, activeSeeds: new Set() })).toBeNull();
  });
});

describe('resolveReportTarget', () => {
  it('uses the registry entry when present (same-machine, precise thread routing)', () => {
    const r = resolveReportTarget({
      registryEntry: { orchChatId: 'oc_orch', orchScope: 'thread', orchRoot: 'om_root' },
      sessionChatId: 'oc_sub', creatorOpenId: 'ou_orch',
    });
    expect(r).toEqual({ orchChatId: 'oc_orch', orchScope: 'thread', orchRoot: 'om_root', orchOpenId: 'ou_orch' });
  });

  it('CROSS-MACHINE: with no registry entry, derives from the session (chatId + chat-scope)', () => {
    const r = resolveReportTarget({ registryEntry: undefined, sessionChatId: 'oc_sub', creatorOpenId: 'ou_orch' });
    expect(r).toEqual({ orchChatId: 'oc_sub', orchScope: 'chat', orchRoot: '', orchOpenId: 'ou_orch' });
  });

  it('orchOpenId prefers creatorOpenId, then ownerOpenId, then quoteTargetSenderOpenId', () => {
    expect(resolveReportTarget({ creatorOpenId: 'c', ownerOpenId: 'o', quoteTargetSenderOpenId: 'q' }).orchOpenId).toBe('c');
    expect(resolveReportTarget({ ownerOpenId: 'o', quoteTargetSenderOpenId: 'q' }).orchOpenId).toBe('o');
    expect(resolveReportTarget({ quoteTargetSenderOpenId: 'q' }).orchOpenId).toBe('q');
  });
});

describe('resolveSendTarget — destination routing', () => {
  const base = { topLevel: false, chatScope: false, chatId: 'oc_chat', rootMessageId: 'om_root' };
  it('defaults to replying in the session thread (thread scope, no flags)', () => {
    expect(resolveSendTarget(base)).toEqual({ mode: 'thread', rootMessageId: 'om_root' });
  });
  it('chat-scope session posts plain at the chat top', () => {
    expect(resolveSendTarget({ ...base, chatScope: true })).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });
  it('--top-level posts plain at the chat top even from a thread session', () => {
    expect(resolveSendTarget({ ...base, topLevel: true })).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });
  it('--into <root> replies into that topic (overrides everything)', () => {
    expect(resolveSendTarget({ ...base, into: 'om_topic' })).toEqual({ mode: 'thread', rootMessageId: 'om_topic' });
    expect(resolveSendTarget({ ...base, into: 'om_topic', topLevel: true, chatScope: true })).toEqual({ mode: 'thread', rootMessageId: 'om_topic' });
  });
  it('chat-scope topic alias replies into the current alias thread only when turn ids match', () => {
    expect(resolveSendTarget({ ...base, chatScope: true, replyTargetRootId: 'om_alias', replyTargetTurnId: 'turn-a', currentTurnId: 'turn-a' })).toEqual({ mode: 'thread', rootMessageId: 'om_alias' });
    expect(resolveSendTarget({ ...base, chatScope: true, replyTargetRootId: 'om_alias', replyTargetTurnId: 'turn-a', currentTurnId: 'turn-b' })).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });
  it('--top-level overrides a chat-scope topic alias target', () => {
    expect(resolveSendTarget({ ...base, chatScope: true, topLevel: true, replyTargetRootId: 'om_alias', replyTargetTurnId: 'turn-a', currentTurnId: 'turn-a' })).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });
});

describe('botmux send turn marker context', () => {
  it('uses the latest JSON pid marker turnId for a long-lived CLI process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-marker-'));
    const pid = 424242;
    try {
      mkdirSync(join(dir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dir, '.botmux-cli-pids', String(pid)), JSON.stringify({ sessionId: 'sid-1', turnId: 'turn-a' }));
      expect(findAncestorSessionContext(dir, pid)).toEqual({ sessionId: 'sid-1', turnId: 'turn-a' });

      writeFileSync(join(dir, '.botmux-cli-pids', String(pid)), JSON.stringify({ sessionId: 'sid-1', turnId: 'turn-b' }));
      expect(findAncestorSessionContext(dir, pid)).toEqual({ sessionId: 'sid-1', turnId: 'turn-b' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
