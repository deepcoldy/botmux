import { describe, it, expect, vi } from 'vitest';

// Regression coverage for the regular-group /summary window builder.
//
// The event-dispatcher tests mock `listChatMessagesUntil` with a fixed array
// and never invoke its `stopAfter` callback, so they cannot catch a bug in the
// stopper itself. Here we provide a FAITHFUL fake that scans a newest -> oldest
// list (as the real Lark Desc paginator does) honoring `stopAfter`, with the
// trigger `/summary` as the newest message — exactly the production shape.

const BOT_OPEN_ID = 'ou_thisbot';

const chatPages: { newestFirst: any[] } = { newestFirst: [] };
vi.mock('../src/im/lark/client.js', () => ({
  listChatMessagesUntil: vi.fn(async (_app: string, _chat: string, opts: any) => {
    const out: any[] = [];
    for (const m of chatPages.newestFirst) {
      out.push(m);
      if (opts?.stopAfter?.(m, out.length)) break;
    }
    return out.reverse();
  }),
  listThreadMessages: vi.fn(async () => []),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotOpenId: () => BOT_OPEN_ID,
}));

const { buildSummaryCommandPrompt } = await import('../src/im/lark/summary-command.js');

function msg(id: string, text: string, createTimeMs: number, extra: any = {}): any {
  return {
    message_id: id,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: 'ou_someone', sender_type: 'user' },
    create_time: String(createTimeMs),
    ...extra,
  };
}

const T = 100 * 60 * 60_000;
const trigger = msg('trigger', '@_bot_a /summary', T, {
  mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: BOT_OPEN_ID } }],
});

const DEFAULT_MATCH_BASE = {
  chatKind: 'regularGroup' as const,
  prompt: 'summarize',
  summaryMemoryPath: 'summary.md',
};

async function run(range = { limit: 0, sinceHours: 0 }) {
  return buildSummaryCommandPrompt({
    larkAppId: 'app',
    chatId: 'chat',
    message: trigger,
    match: { ...DEFAULT_MATCH_BASE, triggerText: '/summary', range, summaryMemory: false },
  });
}

describe('regular-group /summary window (faithful stopper)', () => {
  it('reads real history when there is no prior /summary (trigger must not close the window)', async () => {
    chatPages.newestFirst = [
      trigger,
      msg('realA', '讨论内容A', T - 1 * 60 * 60_000),
      msg('realB', '讨论内容B', T - 2 * 60 * 60_000),
    ];
    const prompt = await run();
    expect(prompt).toContain('讨论内容A');
    expect(prompt).toContain('讨论内容B');
    expect(prompt).toContain('window="configured-range"');
  });

  it('only includes messages after the previous @this-bot /summary', async () => {
    chatPages.newestFirst = [
      trigger,
      msg('after', '本轮新增讨论', T - 1 * 60 * 60_000),
      msg('prev', '@_bot_a /summary', T - 3 * 60 * 60_000, {
        mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: BOT_OPEN_ID } }],
      }),
      msg('before', '上一轮已总结过的内容', T - 4 * 60 * 60_000),
    ];
    const prompt = await run();
    expect(prompt).toContain('window="since-last-summary"');
    expect(prompt).toContain('本轮新增讨论');
    expect(prompt).not.toContain('上一轮已总结过的内容');
  });

  it('respects the configured limit cap', async () => {
    chatPages.newestFirst = [
      trigger,
      msg('m1', 'keep-1', T - 1 * 60 * 60_000),
      msg('m2', 'keep-2', T - 2 * 60 * 60_000),
      msg('m3', 'drop-old', T - 3 * 60 * 60_000),
    ];
    const prompt = await run({ limit: 2, sinceHours: 0 });
    expect(prompt).toContain('keep-1');
    expect(prompt).toContain('keep-2');
    expect(prompt).not.toContain('drop-old');
  });

  it('leaves text after /summary as ordinary focus text when summary memory is off', async () => {
    const focusTrigger = msg('trigger-focus', '@_bot_a /summary 从错误开始', T, {
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: BOT_OPEN_ID } }],
    });
    chatPages.newestFirst = [
      focusTrigger,
      msg('after', '边界后内容', T - 1 * 60 * 60_000),
      msg('boundary', '从错误开始', T - 2 * 60 * 60_000),
      msg('before', '边界前旧内容', T - 3 * 60 * 60_000),
    ];

    const prompt = await buildSummaryCommandPrompt({
      larkAppId: 'app',
      chatId: 'chat',
      message: focusTrigger,
      match: { ...DEFAULT_MATCH_BASE, triggerText: '/summary 从错误开始', range: { limit: 0, sinceHours: 0 }, summaryMemory: false },
    });
    expect(prompt).toContain('summary_memory="false"');
    expect(prompt).not.toContain('<explicit_boundary>');
    expect(prompt).toContain('window="configured-range"');
    expect(prompt).toContain('边界前旧内容');
  });

  it('treats text after /summary as a hard boundary only when summary memory is on', async () => {
    const boundedTrigger = msg('trigger-boundary', '@_bot_a /summary 从错误开始', T, {
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: BOT_OPEN_ID } }],
    });
    chatPages.newestFirst = [
      boundedTrigger,
      msg('after', '边界后内容', T - 1 * 60 * 60_000),
      msg('boundary', '从错误开始', T - 2 * 60 * 60_000),
      msg('before', '边界前旧内容', T - 3 * 60 * 60_000),
    ];

    const bounded = await buildSummaryCommandPrompt({
      larkAppId: 'app',
      chatId: 'chat',
      message: boundedTrigger,
      match: { ...DEFAULT_MATCH_BASE, triggerText: '/summary 从错误开始', range: { limit: 0, sinceHours: 0 }, summaryMemory: true },
    });
    expect(bounded).toContain('window="explicit-boundary"');
    expect(bounded).toContain('从错误开始');
    expect(bounded).toContain('边界后内容');
    expect(bounded).not.toContain('边界前旧内容');

    chatPages.newestFirst = [
      boundedTrigger,
      msg('after', '不能擅自扩展进去的内容', T - 1 * 60 * 60_000),
    ];
    const missing = await buildSummaryCommandPrompt({
      larkAppId: 'app',
      chatId: 'chat',
      message: boundedTrigger,
      match: { ...DEFAULT_MATCH_BASE, triggerText: '/summary 找不到边界', range: { limit: 0, sinceHours: 0 }, summaryMemory: true },
    });
    expect(missing).toContain('explicit boundary not found');
    expect(missing).not.toContain('不能擅自扩展进去的内容');
  });

  it('keeps limit as a hard scan cap when a summary-memory boundary is missing', async () => {
    const boundedTrigger = msg('trigger-boundary-limit', '@_bot_a /summary 找不到边界', T, {
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: BOT_OPEN_ID } }],
    });
    chatPages.newestFirst = [
      boundedTrigger,
      msg('m1', 'scan-1', T - 1 * 60 * 60_000),
      msg('m2', 'scan-2', T - 2 * 60 * 60_000),
      msg('m3', 'scan-3-should-not-be-fetched', T - 3 * 60 * 60_000),
    ];

    const prompt = await buildSummaryCommandPrompt({
      larkAppId: 'app',
      chatId: 'chat',
      message: boundedTrigger,
      match: { ...DEFAULT_MATCH_BASE, triggerText: '/summary 找不到边界', range: { limit: 2, sinceHours: 0 }, summaryMemory: true },
    });
    expect(prompt).toContain('explicit boundary not found');
    expect(prompt).not.toContain('scan-1');
    expect(prompt).not.toContain('scan-2');
    expect(prompt).not.toContain('scan-3-should-not-be-fetched');
  });
});
