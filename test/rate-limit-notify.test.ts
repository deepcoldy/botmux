/**
 * 限流主动通知（daemon 侧 screen_update limited 边沿）。
 *
 * 背景：限流检测本身完备（Claude 结构化 error:"rate_limit"、Codex
 * codex_rate_limited、屏幕扫描三路都发 status:'limited' 的 screen_update），
 * 缺口在通知侧——limited 只走卡片 PATCH（无未读/无 @ 提醒），card-off 会话更是
 * 直接 break 零信号；working→limited 边沿还误调 finishTurnReactions 把 ✋ 翻成
 * ✅，让用户以为任务完成。本测试钉住修复约定：
 *   - working/其它→limited 边沿主动发一条新消息到原话题（scopedReply），
 *     正文 <at owner> + 限流原因 + 重试引导；owner 为空时不 @
 *   - 同一次限流（usageLimitStateKey 相同）只发一次；clearUsageLimitState
 *     复位后下一次限流会再发
 *   - card-off 会话也发（PATCH 无未读，新消息才有）
 *   - working→limited 不再误翻 ✋→✅（working→idle 正常完成仍翻，见 turn-reactions）
 *
 * Run: pnpm vitest run test/rate-limit-notify.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    addReaction: mocks.addReaction,
    removeReaction: mocks.removeReaction,
    updateMessage: mocks.updateMessage,
    deleteMessage: mocks.deleteMessage,
  };
});

import { registerBot } from '../src/bot-registry.js';
import { noteTurnReceived } from '../src/daemon.js';
import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  clearUsageLimitState,
} from '../src/core/worker-pool.js';
import { usageLimitStateKey, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import type { DaemonSession } from '../src/core/types.js';

const APP_CARD_OFF = 'ratelimit_cardoff_app';
const APP_CARD_ON = 'ratelimit_cardon_app';
const OWNER = 'ou_owner_1';

function makeDs(over: Partial<DaemonSession> = {}, app = APP_CARD_OFF): DaemonSession {
  // status:'active' 是 screen_update 处理器 ownsLifecycleMutation 守卫的要求；
  // workerPort 让 workerHasInitialized 通过（与 usage-limit-sticky-recovery 测试同型）。
  const session: any = {
    sessionId: 'sess-' + Math.random().toString(36).slice(2),
    chatId: 'oc_x',
    rootMessageId: 'om_root',
    status: 'active',
    ownerOpenId: OWNER,
  };
  return { session, larkAppId: app, chatId: 'oc_x', scope: 'chat', ...over } as unknown as DaemonSession;
}

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function rateLimitState(over: Partial<CliUsageLimitState> = {}): CliUsageLimitState {
  return {
    limited: true,
    kind: 'rate',
    retryAtMs: Date.now() + 60_000,
    retryLabel: '5-10 min',
    retryReady: false,
    ...over,
  };
}

function setupPool(sessionReply: ReturnType<typeof vi.fn>): void {
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
}

/** 取 sessionReply mock 调用里的文本消息（msgType==='text'）正文。 */
function textReplies(sessionReply: ReturnType<typeof vi.fn>): string[] {
  return sessionReply.mock.calls
    .filter(c => c[2] === 'text')
    .map(c => String(c[1]));
}

describe('rate-limit proactive notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-ratelimit-'));
    registerBot({
      larkAppId: APP_CARD_OFF,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_o'],
      disableStreamingCard: true,
    });
    registerBot({
      larkAppId: APP_CARD_ON,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_o'],
    });
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
    mocks.updateMessage.mockResolvedValue('ok');
    mocks.deleteMessage.mockResolvedValue('ok');
  });

  it('working→limited 边沿主动发通知：正文 @ owner + 限流原因 + 重试引导', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    await flush();
    worker.emit('message', {
      type: 'screen_update',
      content: '429 Too Many Requests',
      status: 'limited',
      usageLimit: limit,
    });
    await flush();

    const texts = textReplies(sessionReply);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`<at id=${OWNER}>`);
    expect(texts[0]).toContain('限流');
    expect(texts[0]).toContain('5-10 min');
    // latch 记录本次 episode 的 key
    expect(ds.rateLimitNotifiedKey).toBe(usageLimitStateKey(limit));
  });

  it('usage 类限额通知正文区分「使用限额」', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: 'usage limit reached',
      status: 'limited',
      usageLimit: rateLimitState({ kind: 'usage', retryLabel: '10:40 PM' }),
    });
    await flush();

    const texts = textReplies(sessionReply);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('使用限额');
    expect(texts[0]).toContain('10:40 PM');
  });

  it('同 key 去重：连续 limited 帧只发一次通知', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();
    // 同一 episode 的重复帧（status 已 limited，key 相同）
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();

    expect(textReplies(sessionReply)).toHaveLength(1);
  });

  it('latch 独立兜底：status 被重投影为 working 后同一 key 再 limited 仍不重复通知', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();
    expect(textReplies(sessionReply)).toHaveLength(1);

    // 模拟不经过 clearUsageLimitState 的状态重投影（episode 未结束、key 未变）：
    // 边沿再次出现，但 latch 必须挡住重复通知。
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();

    expect(textReplies(sessionReply)).toHaveLength(1);
    expect(ds.rateLimitNotifiedKey).toBe(usageLimitStateKey(limit));
  });

  it('clearUsageLimitState 复位 latch 后，同一 key 再次 limited 会重新通知', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();
    expect(textReplies(sessionReply)).toHaveLength(1);

    // episode 结束（self-heal / turn 结束路径都会调 clearUsageLimitState）
    clearUsageLimitState(ds);
    expect(ds.usageLimit).toBeUndefined();
    expect(ds.rateLimitNotifiedKey).toBeUndefined();

    // 生产中 clearUsageLimitState 伴随 status 离开 limited（working 帧 self-heal），
    // 这里显式重投影以模拟下一帧的边沿。
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();

    expect(textReplies(sessionReply)).toHaveLength(2);
  });

  it('self-heal 集成路径：limited→working（自愈清状态）→limited 重新通知', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();
    expect(textReplies(sessionReply)).toHaveLength(1);

    // CLI 恢复工作：working 帧无新鲜 usageLimit → resolveUsageAwareScreenStatus
    // 内部调 clearUsageLimitState 自愈（latch 一并复位）。
    worker.emit('message', { type: 'screen_update', content: 'working output continues', status: 'working' });
    await flush();
    expect(ds.usageLimit).toBeUndefined();
    expect(ds.rateLimitNotifiedKey).toBeUndefined();

    // 再次命中限流（即使 key 与上次相同）→ 新 episode，重新通知。
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();
    expect(textReplies(sessionReply)).toHaveLength(2);
  });

  it('card-off 会话也收到通知（disableStreamingCard 不再吞掉 limited 信号）', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    // APP_CARD_OFF 注册了 disableStreamingCard:true
    const ds = makeDs({ worker, workerPort: 9999 }, APP_CARD_OFF);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: '429 Too Many Requests',
      status: 'limited',
      usageLimit: rateLimitState(),
    });
    await flush();

    expect(textReplies(sessionReply)).toHaveLength(1);
    expect(textReplies(sessionReply)[0]).toContain(`<at id=${OWNER}>`);
  });

  it('card-on 会话也发通知（PATCH 无未读，新消息才有）', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 }, APP_CARD_ON);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: '429 Too Many Requests',
      status: 'limited',
      usageLimit: rateLimitState(),
    });
    await flush();

    // 通知是独立的 text 新消息；卡片 POST 走 interactive，不计入。
    const texts = textReplies(sessionReply);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`<at id=${OWNER}>`);
    const interactiveCalls = sessionReply.mock.calls.filter(c => c[2] === 'interactive');
    expect(interactiveCalls.length).toBeGreaterThan(0);
  });

  it('owner 为空时不 @，直接发正文', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    ds.session.ownerOpenId = undefined;
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: '429 Too Many Requests',
      status: 'limited',
      usageLimit: rateLimitState(),
    });
    await flush();

    const texts = textReplies(sessionReply);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain('<at');
    expect(texts[0]).toContain('限流');
  });

  it('working→limited 不再误翻 ✋→✅（限流是阻塞，不是任务完成）', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);
    await noteTurnReceived(ds, 'om_a');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();

    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    await flush();
    worker.emit('message', {
      type: 'screen_update',
      content: '429 Too Many Requests',
      status: 'limited',
      usageLimit: rateLimitState(),
    });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP_CARD_OFF, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });

  it('回归：working→idle 正常完成仍翻 ✋→✅（limited 修复不影响 idle 路径）', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);
    await noteTurnReceived(ds, 'om_a');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();

    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    await flush();
    worker.emit('message', { type: 'screen_update', content: 'done', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP_CARD_OFF, 'om_a', 'rid_om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP_CARD_OFF, 'om_a', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('回归：重启静默窗口内的「假边沿」不发限流通知、不写 latch（CLI 在 daemon 宕机期间被限流）', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setupPool(sessionReply);
    const worker = makeFakeWorker();
    // 模拟 tmux/adopt restore：usageLimit 未持久化 → lastScreenStatus 留空，
    // 首个 limited 帧是 empty→limited 的假边沿；此时仍处重启静默窗口。
    const ds = makeDs({ worker, workerPort: 9999, suppressRecoveryCard: true });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();

    // 不发通知（owner 已收到重启恢复 DM 摘要），也不写 latch。
    expect(textReplies(sessionReply)).toHaveLength(0);
    expect(ds.rateLimitNotifiedKey).toBeUndefined();

    // 首个真人 turn 清掉静默窗口后，真正的 limited 边沿仍能正常通知——
    // 闸门挂在 suppressRecoveryCard 上，不是永久静音。
    ds.suppressRecoveryCard = false;
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit });
    await flush();

    const texts = textReplies(sessionReply);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`<at id=${OWNER}>`);
    expect(ds.rateLimitNotifiedKey).toBe(usageLimitStateKey(limit));
  });
});
