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

async function run(range = { limit: 0, sinceHours: 0 }) {
  return buildSummaryCommandPrompt({
    larkAppId: 'app',
    chatId: 'chat',
    message: trigger,
    match: { chatKind: 'regularGroup', triggerText: '/summary', range, prompt: 'summarize' },
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
});
