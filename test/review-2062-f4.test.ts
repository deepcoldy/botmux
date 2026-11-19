/**
 * #2062 复审 —— 消息 lane 的「live worker 拒收」重投没有边界（P2，本 PR 必修）
 *
 * ⚠️ 编号说明：文件名里的 `f4` 是**骨架序号**（第 4 个骨架文件），不是维护者复审
 * 清单里的 F4。复审清单中：
 *   · **F4 = 跨 Pod 能力边界**（workbench cookie 流 403 / 写能力结构上不可用），文档项；
 *   · **本文件 = 清单 F7**（message lane 无界重投）。
 * 读代码时以本节标题为准，别按文件名对号。
 *
 * 背景：`daemon.ts` 在「live worker 没接受输入」出口新增了
 *   `retryDurablePrimaryIngress(ctx, 'live worker did not accept input')`
 * → `event-dispatcher` 的 `primaryResult` 把它转成 `{ kind: 'retry' }`
 * → `durable-inbox-primary-consumer` 的显式 retry 分支。
 *
 * 问题：**显式 `retry` 刻意绕过 `maxAttempts`**（`maxAttempts` 只出现在 catch 分支；
 * 既有单测把 `attempts: 999` + `maxAttempts: 1` 钉成「必须继续重投」，因为 busy /
 * unfinished-turn 是**等外部状态变化**的 wait-state）。但「live worker 拒收」不等于
 * wait-state：worker 未 killed 而 IPC 恒 false 时，状态不会自己变好。
 * 结果是这条消息每 `retryDelayMs`（默认 5s）重投一次、永不结束，而同 partition
 * 严格 FIFO ⇒ **整个 chat 的后续消息全部饿死**。
 *
 * 修法边界（两条都可接受，**但都不要全局给显式 retry 加 maxAttempts**）：
 *   ① 进展信号：两次重投之间 worker 代次 / `ds.worker` 身份没变化 ⇒ 降级为
 *      `ignored` + 用户可见提示；
 *   ② 只给「live worker 拒收」这一路单独设上限。
 * 本文件第 2 个用例专门守「别把 busy / unfinished-turn 也一起截断」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DURABLE_INBOX_LANE_LARK_MESSAGE } from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  startDurableInboxPrimaryConsumer,
  type DurableInboxPrimaryDispatchResult,
} from '../src/services/durable-inbox-primary-consumer.js';
import type { DurableJson } from '../src/services/durable-coordination.js';

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PARTITION = 'lark-message-routing:cli_test:oc_chat';

function humanMessage(messageId: string, partitionKey = PARTITION) {
  return {
    eventId: `im.message.receive_v1:cli_test:${messageId}`,
    lane: DURABLE_INBOX_LANE_LARK_MESSAGE,
    partitionKey,
    payload: {
      version: 1,
      type: 'lark.im.message.receive_v1',
      larkAppId: 'cli_test',
      event: { message: { message_id: messageId } },
    } as DurableJson,
    visibleAt: 1,
    createdAt: 1,
  };
}

/** 用真 store + 真 consumer 跑 `rounds` 轮；每轮推进时钟并让出事件循环。 */
async function runRounds(
  options: {
    /**
     * 返回值就是 dispatch 的接收回执。
     *
     * 如果你选的是「进展信号」修法：把进展标记放进 `progressToken`（worker 代次 /
     * `ds.worker` 身份都行，只要「状态没变」时它不变）。本夹具会让它**跨轮保持不变**，
     * 也就是模拟生产里那个真实现场：worker 未换代、IPC 恒拒。字段名可自选，改这里即可。
     */
    dispatch: (messageId: string) => DurableInboxPrimaryDispatchResult | {
      kind: 'retry';
      reason: string;
      progressToken?: string;
    };
    payloads: Array<[string, string?]>;
    rounds: number;
    retryDelayMs: number;
    maxAttempts: number;
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'review-2062-f4-'));
  tempDirs.push(dir);
  let clock = 1_000;
  const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => clock });
  for (const [messageId, partitionKey] of options.payloads) {
    await store.enqueueInbox(humanMessage(messageId, partitionKey));
  }
  const dispatched: string[] = [];
  const consumer = startDurableInboxPrimaryConsumer({
    store,
    workerId: 'primary-boot',
    concurrency: 1,
    intervalMs: 10,
    retryDelayMs: options.retryDelayMs,
    maxAttempts: options.maxAttempts,
    now: () => clock,
    dispatch: async message => {
      dispatched.push(message.messageId);
      const receipt = options.dispatch(message.messageId);
      // 「live worker 拒收」这一路：状态在两次重投之间没有任何变化。
      return receipt.kind === 'retry' && receipt.reason === 'live worker did not accept input'
        ? { ...receipt, progressToken: 'worker-generation-1' }
        : receipt;
    },
    onError: () => {},
  });
  await consumer.ready;
  for (let round = 0; round < options.rounds; round += 1) {
    clock += options.retryDelayMs;
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  consumer.terminate();
  await consumer.stop(0);
  await store.close();
  return dispatched;
}

describe('F4 — 「live worker 拒收」的重投必须有边界', () => {
  it('毒消息不得饿死同 partition 的后续消息，且自身重投次数有界', async () => {
    const rounds = 40;
    const dispatched = await runRounds({
      payloads: [['om_poison'], ['om_normal']],
      rounds,
      retryDelayMs: 100,
      // 明确的（且很小的）上限：修好之后毒消息不该因为这条路绕过它而跑满 40 轮
      maxAttempts: 2,
      dispatch: messageId => (messageId === 'om_poison'
        // 生产里这个 reason 就来自 daemon 新增的那个出口
        ? { kind: 'retry', reason: 'live worker did not accept input' }
        : { kind: 'ignored', reason: 'not addressed to this bot' }),
    });

    const poison = dispatched.filter(id => id === 'om_poison').length;
    const normal = dispatched.filter(id => id === 'om_normal').length;

    // ① 后续正常消息必须最终跑起来（这是「分区没被饿死」的行为证据）
    expect(normal).toBeGreaterThanOrEqual(1);
    // ② 毒消息的重投次数必须有界。无界实现会跑满 ~rounds 次（实测 21~25）。
    expect(poison).toBeLessThanOrEqual(10);
    // ③ 不能靠「把两条一起丢掉」蒙过去：正常消息只该跑一次
    expect(normal).toBe(1);
  });

  it('既有 wait-state（busy / unfinished turn）必须继续无限等，不许被一起截断', async () => {
    // 守「别全局给显式 retry 加 maxAttempts」这个错误修法：
    // 既有的 busy / unfinished-turn 语义依赖「不计 attempts、一直重投」。
    const rounds = 30;
    const dispatched = await runRounds({
      payloads: [['om_busy']],
      rounds,
      retryDelayMs: 100,
      maxAttempts: 2,
      dispatch: () => ({ kind: 'retry', reason: 'session has an unfinished turn' }),
    });
    expect(dispatched.filter(id => id === 'om_busy').length).toBeGreaterThanOrEqual(10);
  });

  it('a refusal that comes from a new worker generation gets a fresh budget', async () => {
    // Progress is the token changing: a respawned worker may accept the input,
    // so only consecutive retries with the SAME token count against the budget.
    let generation = 0;
    const dir = mkdtempSync(join(tmpdir(), 'review-2062-f4-progress-'));
    tempDirs.push(dir);
    let clock = 1_000;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => clock });
    await store.enqueueInbox(humanMessage('om_flapping'));
    let dispatched = 0;
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 10,
      retryDelayMs: 100,
      maxAttempts: 2,
      now: () => clock,
      dispatch: async () => {
        dispatched += 1;
        generation += 1;
        return { kind: 'retry', reason: 'live worker did not accept input', progressToken: `gen-${generation}` };
      },
      onError: () => {},
    });
    await consumer.ready;
    for (let round = 0; round < 20; round += 1) {
      clock += 100;
      await new Promise(resolve => setTimeout(resolve, 12));
    }
    consumer.terminate();
    await consumer.stop(0);
    await store.close();
    expect(dispatched).toBeGreaterThanOrEqual(10);
  });
});
