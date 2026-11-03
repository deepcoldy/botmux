/**
 * 决策看板写群关联前的核实：先管家 bot，查不到再分批试本机其他 bot；单次超时与总时长上限；
 * 报错只带 appId 与飞书错误码 / 原因（不带请求配置里的凭据）；其他 bot 的客户端按凭据指纹缓存。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatChatLookupFailure, lookupChatAcrossBots, type ChatProbe } from '../src/core/decision-board/chat-lookup.js';
import { createBoardChatProbes, sameOwnerAs, siblingChatProbeConfigs } from '../src/services/board-chat-probes.js';

type Reply = { code?: unknown; msg?: unknown; data?: { name?: unknown } };

function probe(appId: string, reply: (chatId: string, signal: AbortSignal) => Promise<Reply>, calls: string[]): ChatProbe {
  return { appId, fetchChat: (chatId, signal) => { calls.push(appId); return reply(chatId, signal); } };
}

const found = (name: string) => async () => ({ code: 0, data: { name } });
const notInChat = async () => ({ code: 232011, msg: 'Operator can NOT be out of the chat.' });

afterEach(() => { vi.useRealTimers(); });

describe('lookupChatAcrossBots', () => {
  it('管家 bot 查到就用它，不再动用其他 bot 的凭据', async () => {
    const calls: string[] = [];
    const res = await lookupChatAcrossBots('oc_x', [probe('cli_steward', found('任务群'), calls), probe('cli_b', found('别的'), calls)]);
    expect(res).toEqual({ ok: true, chatId: 'oc_x', appId: 'cli_steward', name: '任务群' });
    expect(calls).toEqual(['cli_steward']);
  });

  it('管家查不到：其余 bot 分批并发试，同一批里按顺序取第一个查到的，查到后不再试下一批', async () => {
    const calls: string[] = [];
    let releaseLate!: () => void;
    const late = new Promise<void>(r => { releaseLate = r; });
    const probes = [
      probe('cli_steward', notInChat, calls),
      // 同一批里 cli_b 先查到但排在后面的 cli_c 之后才 resolve 的是 cli_a：应取 cli_a（顺序优先，不是先到先得）。
      probe('cli_a', async () => { await late; return { code: 0, data: { name: 'A 看到的名字' } }; }, calls),
      probe('cli_b', async () => { releaseLate(); return { code: 0, data: { name: 'B 看到的名字' } }; }, calls),
      probe('cli_c', notInChat, calls),
      probe('cli_d', found('不该轮到'), calls),
    ];
    const res = await lookupChatAcrossBots('oc_x', probes, { batchSize: 3 });
    expect(res).toEqual({ ok: true, chatId: 'oc_x', appId: 'cli_a', name: 'A 看到的名字' });
    expect(calls).toEqual(['cli_steward', 'cli_a', 'cli_b', 'cli_c']);
  });

  it('都查不到：逐个记下原因；SDK 抛的 HTTP 错误只取响应体里的 code / msg，不带请求配置', async () => {
    const calls: string[] = [];
    const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
      config: { headers: { Authorization: 'Bearer t-SECRET-TOKEN' }, data: '{"app_secret":"SECRET-VALUE"}' },
      response: { status: 400, data: { code: 232006, msg: 'invalid chat_id' } },
    });
    const res = await lookupChatAcrossBots('oc_bad', [
      probe('cli_steward', notInChat, calls),
      probe('cli_a', async () => { throw axiosLike; }, calls),
      probe('cli_b', async () => { throw new Error('socket hang up\n    at stack line'); }, calls),
    ]);
    expect(res).toEqual({ ok: false, chatId: 'oc_bad', timedOut: false, failures: [
      { appId: 'cli_steward', code: 232011, reason: 'Operator can NOT be out of the chat.' },
      { appId: 'cli_a', code: 232006, reason: 'invalid chat_id' },
      { appId: 'cli_b', reason: 'socket hang up' },
    ] });
    const text = formatChatLookupFailure(res as Extract<typeof res, { ok: false }>, 'cli_steward');
    expect(text).not.toMatch(/SECRET|Bearer|app_secret|stack line/);
    expect(text).toContain('oc_bad');
    expect(text).toContain('管家 bot cli_steward：232011');
    expect(text).toContain('--allow-unverified-chat');
  });

  it('单次请求超时会中止请求并记为 timeout；总时长到点就不再试后面的 bot', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const aborted: string[] = [];
    const hang = (appId: string) => (_chatId: string, signal: AbortSignal) => new Promise<Reply>(() => {
      signal.addEventListener('abort', () => aborted.push(appId));
    });
    const pending = lookupChatAcrossBots('oc_x', [
      probe('cli_steward', hang('cli_steward'), calls),
      probe('cli_a', hang('cli_a'), calls),
      probe('cli_b', found('轮不到'), calls),
    ], { batchSize: 1, perCallTimeoutMs: 1_000, totalTimeoutMs: 1_500 });
    await vi.advanceTimersByTimeAsync(1_000);
    // 管家超时后只剩 500ms：cli_a 的单次超时被压到剩余时长。
    await vi.advanceTimersByTimeAsync(500);
    const res = await pending;
    expect(res).toEqual({ ok: false, chatId: 'oc_x', timedOut: true, failures: [
      { appId: 'cli_steward', reason: 'timeout' }, { appId: 'cli_a', reason: 'timeout' },
    ] });
    expect(aborted).toEqual(['cli_steward', 'cli_a']);
    expect(calls).toEqual(['cli_steward', 'cli_a']);
    expect(formatChatLookupFailure(res as Extract<typeof res, { ok: false }>, 'cli_steward')).toContain('核实超时');
  });

  it('飞书的长错误说明只留第一句并限长（真实的 99992356 原文带示例值和文档指引）', async () => {
    const msg = 'The request you send is not a valid {open_chat_id} or not exists, and the example value is {oc_da5****************dfe}. '
      + 'Invalid ids: [oc_placeholder] . Please see field_violations for details and refer to API documentation to correct accordingly and resubmit';
    const res = await lookupChatAcrossBots('oc_placeholder', [probe('cli_steward', async () => ({ code: 99992356, msg }), [])]);
    expect(res).toMatchObject({ ok: false, failures: [{ appId: 'cli_steward', code: 99992356 }] });
    const reason = (res as Extract<typeof res, { ok: false }>).failures[0]!.reason;
    expect(reason.startsWith('The request you send is not a valid {open_chat_id} or not exists')).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(101);
    expect(reason).not.toContain('field_violations');
  });

  it('同一批里排在前面的查到了就立即返回，并中止同批其余还挂着的请求，不等它们超时', async () => {
    const aborted: string[] = [];
    const hang = (appId: string) => (_chatId: string, signal: AbortSignal) => new Promise<Reply>(() => {
      signal.addEventListener('abort', () => aborted.push(appId));
    });
    const lookup = lookupChatAcrossBots('oc_x', [
      probe('cli_steward', notInChat, []),
      probe('cli_a', found('任务群'), []),
      probe('cli_b', hang('cli_b'), []),
      probe('cli_c', hang('cli_c'), []),
    ], { batchSize: 3, perCallTimeoutMs: 60_000 });
    const res = await Promise.race([lookup, new Promise(r => setTimeout(() => r('还在等同批其余 bot'), 1_000))]);
    expect(res).toEqual({ ok: true, chatId: 'oc_x', appId: 'cli_a', name: '任务群' });
    expect(aborted.sort()).toEqual(['cli_b', 'cli_c']);
  });

  it('「群不存在」的码不短路：管家和同批前面的 bot 报 232006，后面的 bot 查到了，整体算查到', async () => {
    const calls: string[] = [];
    const invalid = async () => ({ code: 232006, msg: 'invalid chat_id' });
    const res = await lookupChatAcrossBots('oc_x', [
      probe('cli_steward', invalid, calls),
      probe('cli_a', invalid, calls),
      probe('cli_b', found('任务群'), calls),
    ], { batchSize: 3 });
    expect(res).toEqual({ ok: true, chatId: 'oc_x', appId: 'cli_b', name: '任务群' });
    expect(calls).toEqual(['cli_steward', 'cli_a', 'cli_b']);
  });

  it('外部截止时间已经过了：一个 bot 都不试，直接按超时返回', async () => {
    const calls: string[] = [];
    const res = await lookupChatAcrossBots('oc_x', [probe('cli_steward', found('群'), calls)], { deadline: Date.now() - 1 });
    expect(res).toEqual({ ok: false, chatId: 'oc_x', failures: [], timedOut: true });
    expect(calls).toEqual([]);
  });

  it('同批里排在前面的还没回来时，不抢先用后面查到的（顺序优先）', async () => {
    let releaseA!: () => void;
    const lookup = lookupChatAcrossBots('oc_x', [
      probe('cli_steward', notInChat, []),
      probe('cli_a', async () => { await new Promise<void>(r => { releaseA = r; }); return { code: 0, data: { name: 'A 看到的' } }; }, []),
      probe('cli_b', found('B 看到的'), []),
    ], { batchSize: 3, perCallTimeoutMs: 60_000 });
    let settled: unknown;
    void lookup.then(r => { settled = r; });
    await new Promise(r => setTimeout(r, 30));
    expect(settled).toBeUndefined();
    releaseA();
    expect(await lookup).toMatchObject({ ok: true, appId: 'cli_a', name: 'A 看到的' });
  });

  it('查到但群名为空（如单聊）也算查到，只是没有群名', async () => {
    const res = await lookupChatAcrossBots('oc_p2p', [probe('cli_steward', async () => ({ code: 0, data: { name: '  ' } }), [])]);
    expect(res).toEqual({ ok: true, chatId: 'oc_p2p', appId: 'cli_steward' });
  });

  it('暂态失败（超时、网络、飞书频控码）的报错不叫管家去核对群 ID；有确定性错误码时才叫', () => {
    const transient = formatChatLookupFailure({ ok: false, chatId: 'oc_x', timedOut: false, failures: [
      { appId: 'cli_steward', code: 99991400, reason: 'frequency limit' }, { appId: 'cli_a', reason: 'timeout' }] }, 'cli_steward');
    expect(transient).toContain('查群暂时失败');
    expect(transient).not.toContain('先核对群 ID');
    const definitive = formatChatLookupFailure({ ok: false, chatId: 'oc_x', timedOut: true, failures: [
      { appId: 'cli_steward', code: 232006, reason: 'invalid chat_id' }, { appId: 'cli_a', reason: 'timeout' }] }, 'cli_steward');
    expect(definitive).toContain('先核对群 ID');
    expect(definitive).not.toContain('查群暂时失败');
  });

  it('其他 bot 的失败按原因归并计数，几十个 bot 也只占一行', () => {
    const failures = [{ appId: 'cli_steward', code: 232011, reason: 'out of chat' },
      ...Array.from({ length: 40 }, (_, i) => ({ appId: `cli_${i}`, code: 232011, reason: 'out of chat' })),
      { appId: 'cli_t', reason: 'timeout' }];
    const text = formatChatLookupFailure({ ok: false, chatId: 'oc_x', failures, timedOut: false }, 'cli_steward');
    expect(text).toContain('本机其他 41 个 bot：232011 out of chat ×40；timeout ×1');
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('board-chat-probes', () => {
  const cfg = (larkAppId: string, extra: Record<string, unknown> = {}) => ({ larkAppId, larkAppSecret: `secret-${larkAppId}`, ...extra });

  const anyOwner = () => true;

  it('管家之后只试同品牌、有凭据、同 owner 的其他 bot，按 bots.json 顺序去重', () => {
    const picked = siblingChatProbeConfigs({ larkAppId: 'cli_steward' }, [
      cfg('cli_steward'), cfg('cli_a'), cfg('cli_lark', { brand: 'lark' }), cfg('cli_core', { apiOnly: true }),
      cfg('cli_nosecret', { larkAppSecret: '' }), cfg('cli_b', { brand: 'feishu' }), cfg('cli_a'), cfg('cli_others'),
    ], c => c.larkAppId !== 'cli_others');
    expect(picked.map(c => c.larkAppId)).toEqual(['cli_a', 'cli_b']);
    expect(siblingChatProbeConfigs({ larkAppId: 'cli_steward', brand: 'lark' }, [cfg('cli_a'), cfg('cli_lark', { brand: 'lark' })], anyOwner)
      .map(c => c.larkAppId)).toEqual(['cli_lark']);
  });

  it('同 owner：对方发布的管理员是精确快照、非空，且都在管家的管理员里；任何一边判不出来都不算', () => {
    const snaps: Record<string, { admins: Set<string>; exact: boolean } | undefined> = {
      cli_steward: { admins: new Set(['on_owner', 'on_co']), exact: true },
      cli_same: { admins: new Set(['on_owner']), exact: true },
      cli_other: { admins: new Set(['on_owner', 'on_stranger']), exact: true },
      cli_inexact: { admins: new Set(['on_owner']), exact: false },
      cli_empty: { admins: new Set(), exact: true },
      cli_unpublished: undefined,
    };
    const reads: Array<[string, readonly string[] | undefined]> = [];
    const same = sameOwnerAs({ larkAppId: 'cli_steward', allowedUsers: ['ou_me'] }, (app, allowed) => { reads.push([app, allowed]); return snaps[app]; });
    const verdict = (app: string) => same({ larkAppId: app, allowedUsers: [`ou_${app}`] });
    expect(['cli_same', 'cli_other', 'cli_inexact', 'cli_empty', 'cli_unpublished'].map(verdict)).toEqual([true, false, false, false, false]);
    // 按各自此刻的 allowedUsers 读快照（对不上指纹的快照由 store 判为过期）。
    expect(reads).toContainEqual(['cli_steward', ['ou_me']]);
    expect(reads).toContainEqual(['cli_same', ['ou_cli_same']]);
    // 管家自己的快照读不到：谁都不借。
    snaps.cli_steward = undefined;
    expect(verdict('cli_same')).toBe(false);
    // 管家关了「信任同 owner 的同机 Bot」：快照对得上也不借。
    snaps.cli_steward = { admins: new Set(['on_owner', 'on_co']), exact: true };
    const distrust = sameOwnerAs({ larkAppId: 'cli_steward', allowedUsers: ['ou_me'], trustSameOwnerBots: false }, app => snaps[app]);
    expect(distrust({ larkAppId: 'cli_same', allowedUsers: ['ou_cli_same'] })).toBe(false);
    expect(sameOwnerAs({ larkAppId: 'cli_steward', allowedUsers: ['ou_me'], trustSameOwnerBots: true }, app => snaps[app])({ larkAppId: 'cli_same', allowedUsers: ['ou_x'] })).toBe(true);
  });

  it('管家用自己的客户端；其他 bot 的客户端用到才建、按凭据缓存，换了 secret 重建；bots.json 读不到只用管家', async () => {
    const requests: Array<{ client: string; url: string }> = [];
    const fakeClient = (name: string) => ({ request: async (opts: { url: string }) => { requests.push({ client: name, url: opts.url }); return { code: 0, data: { name } }; } });
    let configs: Array<Record<string, unknown>> = [cfg('cli_steward'), cfg('cli_a')];
    let broken = false;
    const created: string[] = [];
    const probes = createBoardChatProbes({
      self: { larkAppId: 'cli_steward' },
      ownClient: () => fakeClient('own') as never,
      configs: () => { if (broken) throw new Error('bots.json unreadable'); return configs as never; },
      sameOwner: anyOwner,
      createClient: c => { created.push(`${c.larkAppId}:${c.larkAppSecret}`); return fakeClient(c.larkAppId) as never; },
    });
    let list = probes();
    expect(list.map(p => p.appId)).toEqual(['cli_steward', 'cli_a']);
    expect(created).toEqual([]);
    await list[0]!.fetchChat('oc_1', new AbortController().signal);
    expect(requests).toEqual([{ client: 'own', url: '/open-apis/im/v1/chats/oc_1' }]);
    await list[1]!.fetchChat('oc_1', new AbortController().signal);
    await probes()[1]!.fetchChat('oc_2', new AbortController().signal);
    expect(created).toEqual(['cli_a:secret-cli_a']);
    configs = [cfg('cli_steward'), cfg('cli_a', { larkAppSecret: 'rotated' })];
    await probes()[1]!.fetchChat('oc_3', new AbortController().signal);
    expect(created).toEqual(['cli_a:secret-cli_a', 'cli_a:rotated']);
    broken = true;
    list = probes();
    expect(list.map(p => p.appId)).toEqual(['cli_steward']);
  });
});
