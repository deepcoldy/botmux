/**
 * 拉群开始的根卡片认回（design 2026-11-03 workflow-dashboard-orchestration
 * §4.5，D4）：生产实现按主 Bot 自己发的、首次尝试之后的顶层卡片逐条取原卡
 * 正文（user_card_content）匹配签名行里的 runId，整词匹配、翻页有上限。
 * 飞书接口用替身；卡片用真实的根卡片构建函数生成。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lark = vi.hoisted(() => ({
  messages: [] as any[],
  details: new Map<string, string>(),
  scanned: 0,
}));
vi.mock('../src/im/lark/client.js', async (orig) => ({
  ...(await orig() as any),
  listChatMessagesUntil: vi.fn(async (_app: string, _chat: string, options: { stopAfter?: (m: any, n: number) => boolean }) => {
    const newestFirst = [...lark.messages].reverse();
    const out: any[] = [];
    for (const message of newestFirst) {
      out.push(message);
      lark.scanned = out.length;
      if (options.stopAfter?.(message, out.length)) break;
    }
    return out.reverse();
  }),
  getMessageDetail: vi.fn(async (_app: string, id: string, options: { userCardContent?: boolean }) => {
    expect(options.userCardContent).toBe(true);
    return { items: [{ message_id: id, msg_type: 'interactive', body: { content: lark.details.get(id) ?? '{}' } }] };
  }),
}));
vi.mock('../src/bot-registry.js', async (orig) => ({ ...(await orig() as any), getBotOpenId: () => 'ou_main_self' }));
const grantIpc = vi.hoisted(() => ({ calls: [] as any[], answer: {} as Record<string, unknown> }));
vi.mock('../src/cli/exact-chat-grant-client.js', async (orig) => ({
  ...(await orig() as any),
  requestExactChatGrant: vi.fn(async (input: any) => { grantIpc.calls.push(input); return grantIpc.answer; }),
}));
vi.mock('../src/utils/daemon-discovery.js', async (orig) => ({
  ...(await orig() as any),
  findOnlineDaemon: (larkAppId: string) => ({ larkAppId, ipcPort: 1 }),
}));
vi.mock('../src/core/daemon-ipc-auth.js', async (orig) => ({ ...(await orig() as any), loadDaemonIpcSecret: () => 'secret' }));

import { createProductionDraftLaunchDeps } from '../src/core/workflow-draft-daemon.js';
import { buildV3LaunchRootCard, isLaunchRootCardOf } from '../src/im/lark/v3-launch-card.js';

const RUN = 'run-261105-1000-abcdef12';
const SINCE = '2026-11-05T10:00:00.000Z';
const T0 = Date.parse(SINCE);
const deps = () => createProductionDraftLaunchDeps({ appId: 'cli_main', startRun: async () => ({ ok: true }), bindSession: async () => ({ ok: true }) });
const PLACEHOLDER = JSON.stringify({ title: '', elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]] });
const card = (id: string, at: number, extra: any = {}) => ({
  message_id: id, msg_type: 'interactive', create_time: String(at),
  sender: { id: 'cli_main', id_type: 'app_id', sender_type: 'app' }, body: { content: PLACEHOLDER }, ...extra,
});
const rootOf = (runId: string) => buildV3LaunchRootCard({ runId, title: 't', initiatorOpenId: 'ou_x', nodeCount: 2 });

beforeEach(() => { lark.messages = []; lark.details = new Map(); lark.scanned = 0; });

describe('isLaunchRootCardOf', () => {
  it('matches the real root card of exactly this run, not a run id that only starts with it', () => {
    expect(isLaunchRootCardOf(rootOf(RUN), RUN)).toBe(true);
    expect(isLaunchRootCardOf(rootOf(`${RUN}9`), RUN)).toBe(false);
    expect(isLaunchRootCardOf(JSON.stringify({ text: `see ${RUN}` }), RUN)).toBe(false);
    expect(isLaunchRootCardOf(PLACEHOLDER, RUN)).toBe(false);
    expect(isLaunchRootCardOf('not json', RUN)).toBe(false);
  });
});

describe('production findRootCards', () => {
  it('reads the full card of each candidate (the list only has a placeholder), past 60 later replies', async () => {
    lark.messages = [
      card('om_root', T0 + 1_000),
      ...Array.from({ length: 60 }, (_, i) => ({ message_id: `om_r${i}`, msg_type: 'text', create_time: String(T0 + 2_000 + i), sender: { sender_type: 'user', id: 'ou_u' }, root_id: 'om_root', parent_id: 'om_root' })),
    ];
    lark.details.set('om_root', rootOf(RUN));
    expect(await deps().findRootCards('oc_x', RUN, SINCE)).toEqual(['om_root']);
  });

  it('only the main bot\'s own top-level cards since the first try; another run\'s card or a longer run id does not count', async () => {
    lark.messages = [
      card('om_old', T0 - 10 * 60_000),
      card('om_other_bot', T0 + 1_000, { sender: { id: 'cli_doc', sender_type: 'app' } }),
      card('om_reply', T0 + 2_000, { root_id: 'om_x', parent_id: 'om_x' }),
      card('om_longer', T0 + 3_000),
      card('om_mine', T0 + 4_000, { sender: { id: 'ou_main_self', sender_type: 'app' } }),
    ];
    for (const id of ['om_old', 'om_other_bot', 'om_reply', 'om_mine']) lark.details.set(id, rootOf(RUN));
    lark.details.set('om_longer', rootOf(`${RUN}9`));
    expect(await deps().findRootCards('oc_x', RUN, SINCE)).toEqual(['om_mine']);
  });

  it('stops paging once older than the first try', async () => {
    lark.messages = [
      ...Array.from({ length: 300 }, (_, i) => card(`om_old${i}`, T0 - 3_600_000 + i)),
      card('om_root', T0 + 1_000),
    ];
    lark.details.set('om_root', rootOf(RUN));
    expect(await deps().findRootCards('oc_x', RUN, SINCE)).toEqual(['om_root']);
    expect(lark.scanned).toBeLessThan(10);
  });
});

describe('production findRootCards: inconclusive is not "not there"', () => {
  it('more than 500 messages since the first try: throws (inconclusive)', async () => {
    lark.messages = [card('om_root', T0 + 1_000), ...Array.from({ length: 500 }, (_, i) => ({ message_id: `om_t${i}`, msg_type: 'text', create_time: String(T0 + 2_000 + i), sender: { sender_type: 'user', id: 'ou_u' } }))];
    lark.details.set('om_root', rootOf(RUN));
    await expect(deps().findRootCards('oc_x', RUN, SINCE)).rejects.toThrow(/inconclusive/);
  });

  it('a long chat that reaches back past the first try within the cap is conclusive', async () => {
    lark.messages = [card('om_old', T0 - 3_600_000), ...Array.from({ length: 400 }, (_, i) => ({ message_id: `om_t${i}`, msg_type: 'text', create_time: String(T0 + 2_000 + i), sender: { sender_type: 'user', id: 'ou_u' } }))];
    expect(await deps().findRootCards('oc_x', RUN, SINCE)).toEqual([]);
  });

  it('more than 30 candidate cards: throws, no card is dropped silently', async () => {
    lark.messages = [card('om_root', T0 + 1_000), ...Array.from({ length: 30 }, (_, i) => card(`om_c${i}`, T0 + 2_000 + i))];
    lark.details.set('om_root', rootOf(RUN));
    await expect(deps().findRootCards('oc_x', RUN, SINCE)).rejects.toThrow(/inconclusive/);
  });

  it('a create_time that is missing or in seconds: throws', async () => {
    lark.messages = [card('om_root', Math.floor((T0 + 1_000) / 1000))];
    lark.details.set('om_root', rootOf(RUN));
    await expect(deps().findRootCards('oc_x', RUN, SINCE)).rejects.toThrow(/inconclusive/);
    lark.messages = [card('om_root', T0 + 1_000, { create_time: undefined })];
    await expect(deps().findRootCards('oc_x', RUN, SINCE)).rejects.toThrow(/inconclusive/);
  });

  it('M16: a withdrawn card does not count', async () => {
    lark.messages = [card('om_gone', T0 + 1_000, { deleted: true }), card('om_root', T0 + 2_000)];
    lark.details.set('om_gone', rootOf(RUN));
    lark.details.set('om_root', rootOf(RUN));
    expect(await deps().findRootCards('oc_x', RUN, SINCE)).toEqual(['om_root']);
  });
});

describe('production resolveSubject', () => {
  it('M14: asks the receiver\'s daemon to resolve (read only) and takes the mapping of exactly that app', async () => {
    grantIpc.calls = [];
    grantIpc.answer = { ok: true, subjectMappings: [{ larkAppId: 'cli_other', subjectOpenId: 'ou_wrong' }, { larkAppId: 'cli_doc', subjectOpenId: 'ou_doc_seen_by_main' }] };
    expect(await deps().resolveSubject('oc_x', 'cli_main', 'cli_doc')).toBe('ou_doc_seen_by_main');
    expect(grantIpc.calls).toEqual([expect.objectContaining({ operation: 'resolve', receiverLarkAppId: 'cli_main', chatId: 'oc_x', subjectLarkAppIds: ['cli_doc'] })]);
    grantIpc.answer = { ok: true, subjectMappings: [{ larkAppId: 'cli_other', subjectOpenId: 'ou_wrong' }] };
    await expect(deps().resolveSubject('oc_x', 'cli_main', 'cli_doc')).rejects.toThrow();
  });
});
