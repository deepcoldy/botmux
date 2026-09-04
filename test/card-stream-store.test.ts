import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CardStreamStore,
  CardStreamStoreError,
  type CardStreamBinding,
} from '../src/services/card-stream-store.js';

const binding: CardStreamBinding = {
  sessionId: 'sid_1',
  larkAppId: 'cli_app',
  chatId: 'oc_chat',
  messageId: 'om_card',
};

function withStore(run: (store: CardStreamStore, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-card-stream-'));
  return run(new CardStreamStore(dir), dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('CardStreamStore', () => {
  it('opens deterministically and persists an app/session/chat binding', async () => withStore(async (store, dir) => {
    const enable = vi.fn(async () => undefined);
    const first = await store.open(binding, 'card_1', enable);
    const second = await store.open(binding, 'card_1', enable);

    expect(first.alreadyOpen).toBe(false);
    expect(second.alreadyOpen).toBe(true);
    expect(second.record.streamId).toBe(CardStreamStore.streamIdFor(binding));
    expect(second.record).toMatchObject({ ...binding, cardId: 'card_1', status: 'open', sequence: 1 });
    expect(enable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'card_1', sequence: 1 }));

    const persisted = JSON.parse(readFileSync(
      join(dir, 'card-streams', `${second.record.streamId}.json`),
      'utf-8',
    ));
    expect(persisted).toMatchObject({ ...binding, status: 'open', sequence: 1 });
  }));

  it('reserves strictly increasing sequences for writes and finish', async () => withStore(async store => {
    const opened = await store.open(binding, 'card_1', async () => undefined);
    const seen: number[] = [];
    const firstWrite = await store.write(opened.record.streamId, binding, async lease => {
      seen.push(lease.sequence);
    });
    const secondWrite = await store.write(opened.record.streamId, binding, async lease => {
      seen.push(lease.sequence);
    });
    const finished = await store.finish(opened.record.streamId, binding, async lease => {
      seen.push(lease.sequence);
    });

    expect(seen).toEqual([2, 3, 4]);
    expect(firstWrite.sequence).toBe(2);
    expect(secondWrite.sequence).toBe(3);
    expect(finished.record).toMatchObject({ status: 'finished', sequence: 4 });
  }));

  it('consumes a sequence when a provider write fails so it is never reused', async () => withStore(async store => {
    const opened = await store.open(binding, 'card_1', async () => undefined);
    await expect(store.write(opened.record.streamId, binding, async lease => {
      expect(lease.sequence).toBe(2);
      throw new Error('network lost');
    })).rejects.toThrow('network lost');

    const recovered = await store.write(opened.record.streamId, binding, async lease => {
      expect(lease.sequence).toBe(3);
    });
    expect(recovered.sequence).toBe(3);
  }));

  it('serializes concurrent writes so provider calls cannot arrive out of order', async () => withStore(async store => {
    const opened = await store.open(binding, 'card_1', async () => undefined);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = store.write(opened.record.streamId, binding, async lease => {
      order.push(`start-${lease.sequence}`);
      await firstGate;
      order.push(`end-${lease.sequence}`);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    const second = store.write(opened.record.streamId, binding, async lease => {
      order.push(`start-${lease.sequence}`);
      order.push(`end-${lease.sequence}`);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(order).toEqual(['start-2']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['start-2', 'end-2', 'start-3', 'end-3']);
  }));

  it('rejects cross-session, cross-bot, and cross-chat access', async () => withStore(async store => {
    const opened = await store.open(binding, 'card_1', async () => undefined);
    for (const authority of [
      { ...binding, sessionId: 'sid_other' },
      { ...binding, larkAppId: 'cli_other' },
      { ...binding, chatId: 'oc_other' },
    ]) {
      await expect(store.write(opened.record.streamId, authority, async () => undefined))
        .rejects.toBeInstanceOf(CardStreamStoreError);
    }
  }));

  it('makes finish idempotent and rejects writes after finish', async () => withStore(async store => {
    const opened = await store.open(binding, 'card_1', async () => undefined);
    const disable = vi.fn(async () => undefined);
    const first = await store.finish(opened.record.streamId, binding, disable);
    const second = await store.finish(opened.record.streamId, binding, disable);
    expect(first.alreadyFinished).toBe(false);
    expect(second.alreadyFinished).toBe(true);
    expect(disable).toHaveBeenCalledTimes(1);
    await expect(store.write(opened.record.streamId, binding, async () => undefined))
      .rejects.toThrow('已经结束');
  }));

  it('reanchors to a new message before fencing every late write to the old stream', async () => withStore(async store => {
    const opened = await store.open({ ...binding, anchorTurnId: 'turn_1' }, 'card_1', async () => undefined);
    const nextBinding = { ...binding, messageId: 'om_card_2', anchorTurnId: 'turn_2' };
    const enabled: number[] = [];
    const moved = await store.reanchor(
      opened.record.streamId,
      binding,
      nextBinding,
      'card_2',
      async lease => { enabled.push(lease.sequence); },
    );

    expect(enabled).toEqual([1]);
    expect(moved.previous).toMatchObject({
      streamId: opened.record.streamId,
      status: 'superseded',
      supersededByStreamId: moved.current.streamId,
    });
    expect(moved.current).toMatchObject({
      ...nextBinding,
      cardId: 'card_2',
      status: 'open',
      sequence: 1,
    });
    await expect(store.write(opened.record.streamId, binding, async () => undefined))
      .rejects.toThrow('已经迁移');
    expect((await store.write(moved.current.streamId, binding, async () => undefined)).sequence).toBe(2);
  }));

  it('rejects reanchor to the same message and cross-authority targets', async () => withStore(async store => {
    const opened = await store.open(binding, 'card_1', async () => undefined);
    await expect(store.reanchor(
      opened.record.streamId,
      binding,
      binding,
      'card_1',
      async () => undefined,
    )).rejects.toThrow('新的消息');
    await expect(store.reanchor(
      opened.record.streamId,
      binding,
      { ...binding, messageId: 'om_other', chatId: 'oc_other' },
      'card_2',
      async () => undefined,
    )).rejects.toThrow('同一会话');
  }));

  it('rejects path traversal and missing stream ids before touching provider state', async () => withStore(async store => {
    await expect(store.write('../escape', binding, async () => undefined)).rejects.toThrow('格式无效');
    await expect(store.write('cs_00000000000000000000000000000000', binding, async () => undefined))
      .rejects.toThrow('未找到卡片流');
  }));
});
