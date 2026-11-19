import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import ts from 'typescript';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCardActionAckTimeoutMs } from '../src/core/card-action-ack.js';

const mocks = vi.hoisted(() => ({
  config: { session: { dataDir: '' } },
  bot: { config: { brand: 'feishu', oncallGroup: { enabled: false, chatIds: ['oc_source'] } } },
  invite: vi.fn(), patch: vi.fn(), reply: vi.fn(), sender: vi.fn(), warn: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
vi.mock('../src/im/lark/client.js', () => ({
  getChatInviteLink: mocks.invite, updateMessage: mocks.patch, replyMessage: mocks.reply, getMessageDetail: vi.fn(),
}));
import { handleOncallGroupAction, retryPendingOncallHandoffs } from '../src/im/lark/oncall-group.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';

const inviteLink = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=synthetic';
const originalCard = JSON.stringify({ schema: '2.0', body: { elements: [] } });
let dir: string;
let groups: OncallGroupStore;
let source: OncallGroupSource;
let order: string[];
let visibleCard: string;
let handlerSettled: boolean;
let dispatcher: (data: any, appId: string, handlers: any) => Promise<any>;

// 非文本断言：执行真实 dispatcher ACK 函数，隔离整个事件模块启动；不检查源码措辞或位置。
function loadAckDispatcher(): typeof dispatcher {
  const parsed = ts.createSourceFile('event-dispatcher.ts', readFileSync(join(process.cwd(), 'src/im/lark/event-dispatcher.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['handleCardActionAckSafe', 'shapeCardActionResult', 'patchTimedOutCardActionResult', 'serializeRawCardForPatch', 'cardActionMessageId'];
  const printer = ts.createPrinter();
  const declarations = names.map(name => {
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing dispatcher seam: ${name}`);
    return printer.printNode(ts.EmitHint.Unspecified, declaration, parsed);
  });
  const code = ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const scope: Record<string, unknown> = {
    getBot: () => mocks.bot,
    logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
    resolveCardActionAckTimeoutMs,
    cardActionInFlight: new Set<string>(),
    CARD_ACTION_TIMEOUT: Symbol('timeout'),
    eventIdForKey: () => undefined,
    cardActionKey: () => 'synthetic-click',
    claimEventOnce: () => true,
    localeForBot: () => 'zh-CN',
    t: (key: string) => key,
    updateMessage: mocks.patch,
  };
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
  });
  return new Function('scope', `with (scope) { ${code}; return handleCardActionAckSafe; }`)(proxy);
}
async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 200 && !predicate(); count++) await new Promise(resolve => realSetTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
function click(): any {
  return { operator: { open_id: 'ou_other' }, context: { open_chat_id: source.chatId, open_message_id: source.messageId }, action: { value: { action: 'oncall_group_join' } } };
}
function dispatch(): Promise<any> {
  return dispatcher(click(), 'app', { handleCardAction: async (data: any, appId: string) => {
    const result = await handleOncallGroupAction(data, appId);
    handlerSettled = true;
    return result;
  } }).then(result => {
    // Simulate Lark completing the original click view when its callback is ACKed.
    order.push('ACK');
    visibleCard = originalCard;
    return result;
  });
}
function seed(options: { savedInvite?: boolean; legacyWithoutCard?: boolean } = {}): void {
  if (options.legacyWithoutCard) source = { ...source, sessionId: undefined, cardJson: undefined };
  groups.recordSource(source);
  groups.claim(source, 'ou_owner', { messageIds: [], cutoffMs: Date.now() - 25 * 60 * 60_000, forwardMode: 'none' });
  groups.finish(source, { status: 'succeeded', openChatId: 'oc_created', ...(options.savedInvite ? { inviteLink } : {}) }, groups.getRequest(source)!.attemptId);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'oncall-join-ack-'));
  mocks.config.session.dataDir = dir;
  groups = new OncallGroupStore(dir);
  source = { appId: 'app', sessionId: 'session', chatId: 'oc_source', messageId: 'om_reply', questionId: 'om_question', answer: 'fixture', cardJson: originalCard };
  order = []; visibleCard = originalCard; handlerSettled = false;
  mocks.invite.mockReset().mockResolvedValue(inviteLink);
  mocks.patch.mockReset().mockImplementation(async (_app: string, _message: string, card: string) => { order.push('PATCH'); visibleCard = card; });
  mocks.reply.mockReset().mockImplementation(async () => { order.push('REPLY'); return 'om_synthetic'; });
  dispatcher = loadAckDispatcher();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('Oncall join callback ACK ordering', () => {
  it('patches a fast existing invitation after ACK so callback completion cannot restore the old button', async () => {
    seed({ savedInvite: true });
    const result = await dispatch();
    expect(result.toast.type).toBe('success');
    expect(order).toEqual(['ACK']);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => order.includes('PATCH'));
    expect(order).toEqual(['ACK', 'PATCH']);
    expect(visibleCard).toContain(inviteLink);
    expect(groups.getRequest(source)?.cardRefreshPending).toBe(false);
    expect(mocks.invite).not.toHaveBeenCalled();
  });
  it('sends the legacy invitation reply after ACK when no card snapshot exists', async () => {
    seed({ savedInvite: true, legacyWithoutCard: true });
    await dispatch();
    expect(order).toEqual(['ACK']);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => order.includes('REPLY'));
    expect(order).toEqual(['ACK', 'REPLY']);
    expect(mocks.reply).toHaveBeenCalledWith('app', source.messageId, expect.stringContaining(inviteLink), 'text', true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('keeps the patch after ACK when invite preparation exceeds the callback deadline', async () => {
    seed();
    let release!: (value: string) => void;
    mocks.invite.mockReturnValueOnce(new Promise<string>(resolve => { release = resolve; }));
    const result = dispatch();
    await until(() => mocks.invite.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(resolveCardActionAckTimeoutMs(undefined));
    await result;
    expect(order).toEqual(['ACK']);
    release(inviteLink);
    await until(() => handlerSettled);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => order.includes('PATCH'));
    expect(order).toEqual(['ACK', 'PATCH']);
    expect(groups.getRequest(source)?.inviteLink).toBe(inviteLink);
  });
  it('retains pending card repair after a post-ACK patch failure and retries the existing group', async () => {
    seed({ savedInvite: true });
    mocks.patch.mockImplementationOnce(async () => { order.push('PATCH'); throw Error('PATCH unavailable'); });
    await dispatch();
    expect(order).toEqual(['ACK']);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => mocks.warn.mock.calls.length > 0);
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', inviteLink, cardRefreshPending: true });
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)?.cardRefreshPending).toBe(false);
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(mocks.invite).not.toHaveBeenCalled();
    expect(groups.claim(source)).toBe(false);
  });
});
