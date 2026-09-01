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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAncestorSessionContext } from '../src/core/session-marker.js';
import {
  acceptedDispatchBotAppIds,
  activeConversationBotOpenIds,
  appendDispatchCompletionProtocol,
  appendDispatchReportProtocol,
  appendLegacyDispatchReportProtocol,
  buildDispatchCompletionBrief,
  parseDispatchBotSpec,
  buildDispatchMessages,
  buildRepoPrimeText,
  buildReportContent,
  findDispatchRegistryEntry,
  buildReportText,
  findSubBotTopic,
  eligibleAutoMentionAliases,
  offTopicSubBotTopic,
  foldableChatSessionAppIds,
  recordDispatchInputCommit,
  resolveReportPlacement,
  resolveReportRecipient,
  resolveReportTarget,
  resolveSendTarget,
  threadRootForReachability,
} from '../src/core/dispatch.js';
import { parseDispatchRepoRequirement } from '../src/core/repo-requirement.js';

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

  it('appends repo preflight metadata after human task content', () => {
    const r = buildDispatchMessages({
      title: 't',
      brief: '完成任务',
      bots,
      repoRequirement: { taskId: 'task-1', repo: 'https://github.com/acme/project.git' },
    });
    const text = allText(r.threadContent);
    const parsed = parseDispatchRepoRequirement(text);
    expect(parsed).toMatchObject({
      taskId: 'task-1',
      repo: 'https://github.com/acme/project.git',
    });
    expect(parsed?.content).toContain('完成任务');
    expect(parsed?.content).toContain('Alice：coder');
    expect(parsed?.content).not.toContain('[botmux-dispatch v1]');
    expect(r.kickoffText).toContain('<at user_id="ou_a"></at>（coder）');
    expect(r.kickoffText).toContain('完成任务');
  });

  it('builds a plain-text kickoff that survives receiver preflight', () => {
    const r = buildDispatchMessages({
      title: 't',
      brief: '跨设备任务',
      bots,
      repoRequirement: { taskId: 'task-post-1', repo: 'git@git.example.com:team/repo.git' },
    });
    expect(r.kickoffText).toContain('<at user_id="ou_a"></at>');
    expect(r.kickoffText).toContain('<at user_id="ou_b"></at>');
    expect(parseDispatchRepoRequirement(r.kickoffText)).toMatchObject({
      taskId: 'task-post-1',
      repo: 'git@git.example.com:team/repo.git',
      content: expect.stringContaining('跨设备任务'),
    });
  });
});

describe('dispatch completion switch wiring', () => {
  it('keeps both existing report protocols available for the default path', () => {
    expect(appendDispatchReportProtocol('本机任务', 'om_seed_exact'))
      .toContain('botmux report --dispatch-root om_seed_exact');
    expect(appendLegacyDispatchReportProtocol('兼容任务'))
      .toContain('botmux report "子项目完成 + 产出位置/摘要"');
    expect(() => appendDispatchReportProtocol('错误目标', 'oc_chat'))
      .toThrow('valid om_ root id');
  });

  it('adds a same-topic botmux send copy after the report protocol', () => {
    const plain = buildDispatchMessages({
      title: '任务',
      brief: '完成实现并自测',
      bots: [{ openId: 'ou_assignee' }],
    });
    expect(plain.threadContent.flat().map(node => node.tag === 'text' ? node.text : '').join('\n'))
      .not.toContain('botmux send');

    const completion = appendDispatchCompletionProtocol(
      appendDispatchReportProtocol('完成实现并自测', 'om_seed_exact'),
    );
    expect(completion).toContain('botmux report --dispatch-root om_seed_exact');
    expect(completion).toContain('botmux send --no-mention');
    expect(completion).toContain('除上述 botmux report 回报外');
    expect(completion).toContain('不要 @ 主 bot，不要新开话题');
  });

  it.each([
    { exact: false, send: false, exactReport: false, sameTopicSend: false },
    { exact: false, send: true, exactReport: false, sameTopicSend: true },
    { exact: true, send: false, exactReport: true, sameTopicSend: false },
    { exact: true, send: true, exactReport: true, sameTopicSend: true },
  ])('combines report and same-topic send protocols: %o', ({ exact, send, exactReport, sameTopicSend }) => {
    const result = buildDispatchCompletionBrief({
      brief: '完成实现并自测',
      dispatchRootId: 'om_seed_exact',
      exactReportRootEnabled: exact,
      sameTopicSendEnabled: send,
    });

    expect(result.includes('botmux report --dispatch-root om_seed_exact')).toBe(exactReport);
    expect(result.includes('botmux report "子项目完成 + 产出位置/摘要"')).toBe(!exactReport);
    expect(result.includes('botmux send --no-mention')).toBe(sameTopicSend);
  });

  it('authenticates the exact report callback through daemon IPC', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function cmdReport');
    const end = source.indexOf('\nasync function ', start + 1);
    const report = source.slice(start, end);

    expect(report).toContain('postCurrentSessionDaemonRoute({');
    expect(report).toContain('path: REPORT_SESSION_RELAY_ROUTE');
    expect(report).not.toContain("orchestrate-dispatch.json");
  });

  it('renders dispatch save feedback inside its own dashboard setting row', () => {
    const source = readFileSync(new URL('../src/dashboard/web/roles-page.tsx', import.meta.url), 'utf8');
    const injectStart = source.indexOf("tr('roles.injectModeLabel')");
    const completionStart = source.indexOf("tr('roles.dispatchCompletionLabel')", injectStart);
    const textareaStart = source.indexOf('<textarea', completionStart);
    const injectRow = source.slice(injectStart, completionStart);
    const completionRow = source.slice(completionStart, textareaStart);

    expect(injectRow).toContain('<Flash flash={injectFlash} />');
    expect(injectRow).not.toContain('dispatchCompletionFlash');
    expect(completionRow).toContain('<Flash flash={dispatchCompletionFlash} />');
  });

  it('trails the marker so older cross-machine receivers keep the positional report text', () => {
    const legacy = appendLegacyDispatchReportProtocol('跨机器任务');
    expect(legacy).toContain('botmux report "子项目完成 + 产出位置/摘要" --legacy-dispatch');
    expect(legacy).not.toContain('--dispatch-root');
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

  it('keeps a delivery envelope at the first meaningful line', () => {
    const envelope = [
      '[botmux-report v1]',
      'taskId: task-1',
      'summary: 完成',
      'evidence:',
      '- inline: name=result PASS',
    ].join('\n');
    const paras = buildReportContent({
      orchOpenId: 'ou_orch',
      content: '远端项目命中并完成只读自检',
      deliveryEnvelope: envelope,
    });

    expect(paras[0]).toEqual([
      { tag: 'at', user_id: 'ou_orch' },
      { tag: 'text', text: ' ' },
      { tag: 'text', text: '[botmux-report v1]' },
    ]);
    expect(paras.flat().map((node) => node.tag === 'text' ? node.text : '').join('\n'))
      .not.toContain('远端项目命中并完成只读自检');
  });

  it('throws on empty content', () => {
    expect(() => buildReportContent({ orchOpenId: 'ou_orch', content: '   ' })).toThrow();
  });

  it('throws on empty orchestrator open_id', () => {
    expect(() => buildReportContent({ orchOpenId: '  ', content: 'x' })).toThrow();
  });
});

describe('buildReportText', () => {
  it('puts the native mention before the whole-message envelope', () => {
    expect(buildReportText({
      orchOpenId: 'ou_orch',
      content: '[botmux-report v1]\ntaskId: task-1',
    })).toBe('<at user_id="ou_orch"></at>\n[botmux-report v1]\ntaskId: task-1');
  });

  it('rejects empty content or orchestrator ids', () => {
    expect(() => buildReportText({ orchOpenId: '', content: 'x' })).toThrow();
    expect(() => buildReportText({ orchOpenId: 'ou_orch', content: ' ' })).toThrow();
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

describe('activeConversationBotOpenIds', () => {
  const botEntries = [
    { larkAppId: 'cli_orchestrator', botName: 'AI Bear' },
    { larkAppId: 'cli_reviewer', botName: 'TraeX' },
  ];
  const crossRef = {
    'AI Bear': 'ou_orchestrator',
    'TraeX': 'ou_reviewer',
  };

  it('finds a peer active in the current topic and excludes the same peer in another topic', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_reviewer' },
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_old', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set(['ou_reviewer']));
  });

  it('does not trust a leftover chat session after the bot stops using a foldable mode', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'chat', chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      foldableChatAppIds: new Set(),
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set());
  });

  it('does not treat a peer active only in another topic as reachable here', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_old', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set());
  });

  it('treats a same-chat chat-scope peer as reachable from a thread sender', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'chat', chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_reviewer' },
        { status: 'active', scope: 'chat', chatId: 'oc_else', rootMessageId: 'oc_else', larkAppId: 'cli_orchestrator' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      foldableChatAppIds: new Set(['cli_reviewer']),
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set(['ou_reviewer']));
  });

  it('treats a same-root thread peer as reachable from a chat-scope reply into that topic', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set(['ou_reviewer']));
  });

  it('does not treat a thread peer as reachable from a plain chat send', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set());
  });

  it('does not treat a quoted root as entering a thread peer session', () => {
    const quoteTarget = { mode: 'quote' as const, rootMessageId: 'om_current' };
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: threadRootForReachability(quoteTarget),
      botEntries,
      crossRef,
    });
    expect(result).toEqual(new Set());
  });

  it('fails closed when multiple bot apps share the same display name', () => {
    const result = activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_same_1' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      botEntries: [
        { larkAppId: 'cli_same_1', botName: 'Same' },
        { larkAppId: 'cli_same_2', botName: 'Same' },
      ],
      crossRef: { Same: 'ou_same_2' },
    });
    expect(result).toEqual(new Set());
  });

  it('treats a non-array bot identity payload as empty instead of throwing', () => {
    expect(activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      botEntries: {} as any,
      crossRef,
    })).toEqual(new Set());
  });

  it('ignores malformed elements inside a bot identity array', () => {
    expect(activeConversationBotOpenIds({
      sessions: [
        { status: 'active', scope: 'thread', chatId: 'oc_main', rootMessageId: 'om_current', larkAppId: 'cli_reviewer' },
      ],
      targetChatId: 'oc_main',
      outboundRootMessageId: 'om_current',
      botEntries: [null, 1, {}, ...botEntries] as any,
      crossRef,
    })).toEqual(new Set(['ou_reviewer']));
  });
});

describe('send-target reachability helpers', () => {
  it('only exposes a root for a real thread send, not quote/plain delivery', () => {
    expect(threadRootForReachability({ mode: 'thread', rootMessageId: 'om_thread' })).toBe('om_thread');
    expect(threadRootForReachability({ mode: 'quote', rootMessageId: 'om_quote' })).toBeUndefined();
    expect(threadRootForReachability({ mode: 'plain', chatId: 'oc_chat' })).toBeUndefined();
  });

  it('accepts only currently foldable ordinary-group chat sessions in the target chat', async () => {
    const sessions = [
      { status: 'active' as const, scope: 'chat' as const, chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_chat' },
      { status: 'active' as const, scope: 'chat' as const, chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_new_topic' },
      { status: 'active' as const, scope: 'chat' as const, chatId: 'oc_else', rootMessageId: 'oc_else', larkAppId: 'cli_elsewhere' },
    ];
    const modes = new Map([
      ['cli_chat', 'chat' as const],
      ['cli_new_topic', 'new-topic' as const],
      ['cli_elsewhere', 'shared' as const],
    ]);
    expect(await foldableChatSessionAppIds({
      sessions,
      targetChatId: 'oc_main',
      outboundMode: 'thread',
      resolveMode: appId => modes.get(appId),
      resolveChatMode: async () => 'group',
    })).toEqual(new Set(['cli_chat']));
  });

  it('keeps chat-topic chat sessions reachable only for top-level-like delivery', async () => {
    const sessions = [
      { status: 'active' as const, scope: 'chat' as const, chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_chat_topic' },
    ];
    const resolveMode = () => 'chat-topic' as const;
    expect(await foldableChatSessionAppIds({
      sessions,
      targetChatId: 'oc_main',
      outboundMode: 'plain',
      resolveMode,
      resolveChatMode: async () => 'group',
    })).toEqual(new Set(['cli_chat_topic']));
    expect(await foldableChatSessionAppIds({
      sessions,
      targetChatId: 'oc_main',
      outboundMode: 'quote',
      resolveMode,
      resolveChatMode: async () => 'group',
    })).toEqual(new Set(['cli_chat_topic']));
    expect(await foldableChatSessionAppIds({
      sessions,
      targetChatId: 'oc_main',
      outboundMode: 'thread',
      resolveMode,
      resolveChatMode: async () => 'group',
    })).toEqual(new Set());
  });

  it('excludes isolated deferred schedule-run chat sessions from the ordinary routing slot', async () => {
    expect(await foldableChatSessionAppIds({
      sessions: [
        {
          status: 'active',
          scope: 'chat',
          chatId: 'oc_main',
          rootMessageId: 'om_deferred',
          larkAppId: 'cli_deferred',
          deferredScheduleRun: { routingAnchor: 'schedule-run:1' },
        },
      ],
      targetChatId: 'oc_main',
      outboundMode: 'plain',
      resolveMode: () => 'chat',
      resolveChatMode: async () => 'group',
    })).toEqual(new Set());
  });

  it('Plan B: a VC meeting-agent chat session IS foldable via the ordinary slot', async () => {
    // Under Plan B the meeting agent is an ordinary chat-scope session, so a
    // mention in its listener group must fold back into it like any other
    // chat-scope peer — the vcMeetingReceiver marker is delivery metadata and
    // no longer excludes the session from the foldable set.
    expect(await foldableChatSessionAppIds({
      sessions: [
        {
          status: 'active',
          scope: 'chat',
          chatId: 'oc_main',
          rootMessageId: 'om_vc',
          larkAppId: 'cli_vc',
          vcMeetingReceiver: { meetingId: 'meeting-1' },
        },
      ],
      targetChatId: 'oc_main',
      outboundMode: 'plain',
      resolveMode: () => 'chat',
      resolveChatMode: async () => 'group',
    })).toEqual(new Set(['cli_vc']));
  });

  it('fails closed after a regular group becomes a topic chat', async () => {
    expect(await foldableChatSessionAppIds({
      sessions: [
        { status: 'active', scope: 'chat', chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_stale' },
      ],
      targetChatId: 'oc_main',
      outboundMode: 'plain',
      resolveMode: () => 'chat',
      resolveChatMode: async () => 'topic',
    })).toEqual(new Set());
  });

  it('fails closed when the target bot reply mode or chat topology cannot be resolved', async () => {
    expect(await foldableChatSessionAppIds({
      sessions: [
        { status: 'active', scope: 'chat', chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_unknown' },
      ],
      targetChatId: 'oc_main',
      outboundMode: 'plain',
      resolveMode: () => { throw new Error('unknown bot'); },
      resolveChatMode: async () => 'group',
    })).toEqual(new Set());
    expect(await foldableChatSessionAppIds({
      sessions: [
        { status: 'active', scope: 'chat', chatId: 'oc_main', rootMessageId: 'oc_main', larkAppId: 'cli_unknown' },
      ],
      targetChatId: 'oc_main',
      outboundMode: 'plain',
      resolveMode: () => 'chat',
      resolveChatMode: async () => 'unknown',
    })).toEqual(new Set());
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

  it('does not recommend an old dispatch topic when the bot is already active here', () => {
    expect(offTopicSubBotTopic({
      mentionOpenId: 'ou_subbot',
      quoteTargetSenderOpenId: 'ou_human',
      reachableOpenIds: new Set(['ou_subbot']),
      chatId: 'oc_main',
      registry,
      activeSeeds,
    })).toBeNull();
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

  it('keeps the legacy no-registry coordinate fallback for compatibility callers', () => {
    const r = resolveReportTarget({ registryEntry: undefined, sessionChatId: 'oc_sub', creatorOpenId: 'ou_orch' });
    expect(r).toEqual({ orchChatId: 'oc_sub', orchScope: 'chat', orchRoot: '', orchOpenId: 'ou_orch' });
  });

  it('orchOpenId prefers creatorOpenId, then ownerOpenId, then quoteTargetSenderOpenId', () => {
    expect(resolveReportTarget({ creatorOpenId: 'c', ownerOpenId: 'o', quoteTargetSenderOpenId: 'q' }).orchOpenId).toBe('c');
    expect(resolveReportTarget({ ownerOpenId: 'o', quoteTargetSenderOpenId: 'q' }).orchOpenId).toBe('o');
    expect(resolveReportTarget({ quoteTargetSenderOpenId: 'q' }).orchOpenId).toBe('q');
  });
});

describe('resolveReportRecipient', () => {
  it('keeps the stable creator as recipient regardless of message placement', () => {
    expect(resolveReportRecipient({
      creatorOpenId: 'ou_reviewer',
      ownerOpenId: 'ou_owner',
      quoteTargetSenderOpenId: 'ou_latest_sender',
    })).toBe('ou_reviewer');
  });

  it('skips empty legacy identity fields', () => {
    expect(resolveReportRecipient({
      creatorOpenId: '  ',
      ownerOpenId: 'ou_owner',
      quoteTargetSenderOpenId: 'ou_latest_sender',
    })).toBe('ou_owner');
  });
});

describe('resolveReportPlacement', () => {
  const base = {
    chatScope: true,
    chatId: 'oc_task',
    rootMessageId: 'oc_task',
    currentTurnId: 'om_turn_current',
  };
  const registryTarget = { mode: 'thread' as const, rootMessageId: 'om_orchestrator_topic' };

  it('inherits a group-top-level turn as group top level', () => {
    expect(resolveReportPlacement(base)).toEqual({
      target: { mode: 'plain', chatId: 'oc_task' },
      source: 'current-turn',
    });
  });

  it('inherits the matching current turn topic', () => {
    expect(resolveReportPlacement({
      ...base,
      replyTargetRootId: 'om_review_topic',
      replyTargetTurnId: 'om_turn_current',
    })).toEqual({
      target: { mode: 'thread', rootMessageId: 'om_review_topic' },
      source: 'current-turn',
    });
  });

  it('preserves a matching quote-only turn target', () => {
    expect(resolveReportPlacement({
      ...base,
      replyTargetRootId: 'om_quoted_message',
      replyTargetTurnId: 'om_turn_current',
      replyTargetQuoteOnly: true,
    })).toEqual({
      target: { mode: 'quote', rootMessageId: 'om_quoted_message' },
      source: 'current-turn',
    });
  });

  it('ignores a stale topic target from a different turn', () => {
    expect(resolveReportPlacement({
      ...base,
      replyTargetRootId: 'om_stale_topic',
      replyTargetTurnId: 'om_turn_old',
    })).toEqual({
      target: { mode: 'plain', chatId: 'oc_task' },
      source: 'current-turn',
    });
  });

  it('--into overrides a dispatch registry placement', () => {
    expect(resolveReportPlacement({
      ...base,
      into: 'om_explicit_topic',
      registryTarget,
      legacyDispatch: true,
    })).toEqual({
      target: { mode: 'thread', rootMessageId: 'om_explicit_topic' },
      source: 'explicit-into',
    });
  });

  it('--top-level overrides a dispatch registry placement', () => {
    expect(resolveReportPlacement({
      ...base,
      topLevel: true,
      registryTarget,
      legacyDispatch: true,
    })).toEqual({
      target: { mode: 'plain', chatId: 'oc_task' },
      source: 'explicit-top-level',
    });
  });

  it('preserves a dispatch registry placement when there is no explicit override', () => {
    expect(resolveReportPlacement({
      ...base,
      registryTarget,
    })).toEqual({
      target: registryTarget,
      source: 'dispatch-registry',
    });
  });

  it('keeps same-machine legacy dispatch on its registry-backed orchestrator route', () => {
    expect(resolveReportPlacement({
      ...base,
      legacyDispatch: true,
      registryTarget,
    })).toEqual({
      target: registryTarget,
      source: 'dispatch-registry',
    });
  });

  it('keeps cross-machine legacy dispatch without a registry on the top-level fallback', () => {
    expect(resolveReportPlacement({
      ...base,
      legacyDispatch: true,
      replyTargetRootId: 'om_legacy_subtopic',
      replyTargetTurnId: 'om_turn_current',
    })).toEqual({
      target: { mode: 'plain', chatId: 'oc_task' },
      source: 'legacy-dispatch-fallback',
    });
  });

  it('uses the durable session location only when there is no current turn position', () => {
    expect(resolveReportPlacement({
      chatScope: false,
      chatId: 'oc_task',
      rootMessageId: 'om_session_topic',
    })).toEqual({
      target: { mode: 'thread', rootMessageId: 'om_session_topic' },
      source: 'session-default',
    });
  });
});

describe('findDispatchRegistryEntry', () => {
  const registry = {
    om_seed_old: { orchRoot: 'om_orch_old', orchSessionId: 's_old' },
    om_seed_new: { orchRoot: 'om_orch_new', orchSessionId: 's_new' },
  };

  it('uses the thread root for a normal thread-scoped dispatched session', () => {
    expect(findDispatchRegistryEntry({
      registry,
      sessionScope: 'thread',
      rootMessageId: 'om_seed_new',
    })).toEqual({
      key: 'om_seed_new',
      entry: registry.om_seed_new,
    });
  });

  it('uses currentReplyTarget for a chat-scope session folded from a dispatch topic', () => {
    expect(findDispatchRegistryEntry({
      registry,
      sessionScope: 'chat',
      rootMessageId: 'oc_group',
      currentReplyTargetRootId: 'om_seed_new',
      currentReplyTargetTurnId: 'om_turn_current',
      currentTurnId: 'om_turn_current',
    })).toEqual({ key: 'om_seed_new', entry: registry.om_seed_new });
  });

  it('prefers the immutable turn root when the chat-scope session has advanced to a newer dispatch', () => {
    expect(findDispatchRegistryEntry({
      registry,
      dispatchRootId: 'om_seed_old',
      sessionScope: 'chat',
      rootMessageId: 'oc_group',
      currentReplyTargetRootId: 'om_seed_new',
      currentReplyTargetTurnId: 'om_turn_new',
      currentTurnId: 'om_turn_new',
    })).toEqual({ key: 'om_seed_old', entry: registry.om_seed_old });
  });

  it('fails closed when an explicit turn root is absent instead of falling through to the latest alias', () => {
    expect(findDispatchRegistryEntry({
      registry,
      dispatchRootId: 'om_seed_missing',
      sessionScope: 'chat',
      rootMessageId: 'oc_group',
      currentReplyTargetRootId: 'om_seed_new',
      currentReplyTargetTurnId: 'om_turn_current',
      currentTurnId: 'om_turn_current',
    })).toBeUndefined();
  });

  it('ignores a stale currentReplyTarget whose turn id does not match', () => {
    expect(findDispatchRegistryEntry({
      registry,
      sessionScope: 'chat',
      rootMessageId: 'oc_group',
      currentReplyTargetRootId: 'om_seed_old',
      currentReplyTargetTurnId: 'om_turn_old',
      currentTurnId: 'om_turn_new',
    })).toBeUndefined();
  });

  it('does not treat a chat-scope trace root as a dispatch route', () => {
    expect(findDispatchRegistryEntry({
      registry,
      sessionScope: 'chat',
      rootMessageId: 'om_seed_old',
      currentTurnId: 'om_turn_new',
    })).toBeUndefined();
  });
});

describe('acceptedDispatchBotAppIds', () => {
  const sentAt = Date.parse('2026-07-14T09:00:00.000Z');
  const turnId = 'om_kickoff_current';
  const workerPid = 12345;
  const workerGeneration = 7;
  const isWorkerAlive = (pid: number) => pid === workerPid;

  it('accepts only exact current-turn input commits for thread and chat-scope sessions', () => {
    expect(acceptedDispatchBotAppIds({
      sessions: [
        {
          larkAppId: 'cli_thread', chatId: 'oc_target', rootMessageId: 'om_seed',
          status: 'active', pid: workerPid, workerGeneration,
          dispatchInputReceipts: {
            [turnId]: {
              rootMessageId: 'om_seed',
              committedAt: '2026-07-14T09:00:01.000Z',
              workerGeneration,
            },
          },
        },
        {
          larkAppId: 'cli_chat', chatId: 'oc_target', rootMessageId: 'oc_target',
          status: 'active', pid: workerPid, workerGeneration,
          dispatchInputReceipts: {
            [turnId]: {
              rootMessageId: 'om_seed',
              committedAt: '2026-07-14T09:00:02.000Z',
              workerGeneration,
            },
          },
        },
      ],
      targetAppIds: ['cli_thread', 'cli_chat'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual(['cli_thread', 'cli_chat']);
  });

  it('rejects stale, closed, wrong-chat, unrelated-root, and wrong-turn receipts', () => {
    expect(acceptedDispatchBotAppIds({
      sessions: [
        { larkAppId: 'cli_stale', chatId: 'oc_target', status: 'active', pid: workerPid, workerGeneration, dispatchInputReceipts: { [turnId]: { rootMessageId: 'om_seed', committedAt: '2026-07-14T08:00:00.000Z', workerGeneration } } },
        { larkAppId: 'cli_closed', chatId: 'oc_target', status: 'closed', pid: workerPid, workerGeneration, dispatchInputReceipts: { [turnId]: { rootMessageId: 'om_seed', committedAt: '2026-07-14T09:00:01.000Z', workerGeneration } } },
        { larkAppId: 'cli_wrong_chat', chatId: 'oc_other', status: 'active', pid: workerPid, workerGeneration, dispatchInputReceipts: { [turnId]: { rootMessageId: 'om_seed', committedAt: '2026-07-14T09:00:01.000Z', workerGeneration } } },
        { larkAppId: 'cli_wrong_root', chatId: 'oc_target', status: 'active', pid: workerPid, workerGeneration, dispatchInputReceipts: { [turnId]: { rootMessageId: 'om_other', committedAt: '2026-07-14T09:00:01.000Z', workerGeneration } } },
        { larkAppId: 'cli_wrong_turn', chatId: 'oc_target', status: 'active', pid: workerPid, workerGeneration, dispatchInputReceipts: { om_old: { rootMessageId: 'om_seed', committedAt: '2026-07-14T09:00:01.000Z', workerGeneration } } },
      ],
      targetAppIds: ['cli_stale', 'cli_closed', 'cli_wrong_chat', 'cli_wrong_root', 'cli_wrong_turn'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual([]);
  });

  it('deduplicates requested app ids while preserving request order', () => {
    expect(acceptedDispatchBotAppIds({
      sessions: [{
        larkAppId: 'cli_repo', chatId: 'oc_target', rootMessageId: 'om_seed',
        status: 'active', pid: workerPid, workerGeneration,
        dispatchInputReceipts: {
          [turnId]: {
            rootMessageId: 'om_seed',
            committedAt: '2026-07-14T09:00:00.000Z',
            workerGeneration,
          },
        },
      }],
      targetAppIds: ['cli_repo', 'cli_repo'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual(['cli_repo']);
  });

  it('does not combine an old lastCliInput with a fresh alias when the current enqueue failed', () => {
    expect(acceptedDispatchBotAppIds({
      sessions: [{
        larkAppId: 'cli_repo', chatId: 'oc_target', rootMessageId: 'oc_target',
        status: 'active', lastCliInput: 'old task', pid: workerPid, workerGeneration,
        currentReplyTarget: {
          rootMessageId: 'om_seed',
          turnId,
          updatedAt: '2026-07-14T09:00:01.000Z',
        },
      }],
      targetAppIds: ['cli_repo'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual([]);
  });

  it('accepts only after the current turn is committed and rejects an unbound commit', () => {
    const session = {
      larkAppId: 'cli_repo',
      chatId: 'oc_target',
      rootMessageId: 'oc_target',
      scope: 'chat' as const,
      status: 'active',
      pid: workerPid,
      workerGeneration,
      replyTargets: {
        [turnId]: { rootMessageId: 'om_seed', updatedAt: '2026-07-14T09:00:01.000Z' },
      },
    };
    expect(recordDispatchInputCommit(
      session,
      'om_unbound',
      workerGeneration,
      '2026-07-14T09:00:01.000Z',
    )).toBe(false);
    expect(acceptedDispatchBotAppIds({
      sessions: [session],
      targetAppIds: ['cli_repo'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual([]);

    expect(recordDispatchInputCommit(
      session,
      turnId,
      workerGeneration,
      '2026-07-14T09:00:01.000Z',
    )).toBe(true);
    expect(acceptedDispatchBotAppIds({
      sessions: [session],
      targetAppIds: ['cli_repo'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual(['cli_repo']);
  });

  it('rejects a receipt from the previous worker generation after replacement', () => {
    const session = {
      larkAppId: 'cli_repo',
      chatId: 'oc_target',
      rootMessageId: 'om_seed',
      status: 'active',
      pid: workerPid,
      workerGeneration: 8,
      dispatchInputReceipts: {
        [turnId]: {
          rootMessageId: 'om_seed',
          committedAt: '2026-07-14T09:00:01.000Z',
          workerGeneration: 7,
        },
      },
    };
    expect(acceptedDispatchBotAppIds({
      sessions: [session],
      targetAppIds: ['cli_repo'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive,
    })).toEqual([]);
  });

  it('rejects an otherwise exact receipt after the persisted worker has exited', () => {
    expect(acceptedDispatchBotAppIds({
      sessions: [{
        larkAppId: 'cli_repo',
        chatId: 'oc_target',
        status: 'active',
        pid: workerPid,
        workerGeneration,
        dispatchInputReceipts: {
          [turnId]: {
            rootMessageId: 'om_seed',
            committedAt: '2026-07-14T09:00:01.000Z',
            workerGeneration,
          },
        },
      }],
      targetAppIds: ['cli_repo'],
      chatId: 'oc_target',
      threadRootId: 'om_seed',
      turnId,
      notBeforeMs: sentAt,
      isWorkerAlive: () => false,
    })).toEqual([]);
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
