import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStreamStore, type CardStreamBinding } from '../src/services/card-stream-store.js';
import { CardRuntimeStatusBridge } from '../src/services/card-runtime-status-bridge.js';

const binding: CardStreamBinding = {
  sessionId: 'sid_runtime',
  larkAppId: 'cli_app',
  chatId: 'oc_chat',
  messageId: 'om_card',
};

async function harness(run: (input: {
  bridge: CardRuntimeStatusBridge;
  streamId: string;
  updates: any[];
  patches: any[];
  updateContent: ReturnType<typeof vi.fn>;
  patchElement: ReturnType<typeof vi.fn>;
  streams: CardStreamStore;
  dir: string;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-card-runtime-'));
  try {
    const streams = new CardStreamStore(dir);
    const opened = await streams.open(binding, 'card_1', async () => undefined);
    const updates: any[] = [];
    const patches: any[] = [];
    const updateContent = vi.fn(async input => { updates.push(input); });
    const patchElement = vi.fn(async input => { patches.push(input); });
    const bridge = new CardRuntimeStatusBridge(dir, streams, {
      updateContent,
      patchElement,
    });
    await run({ bridge, streamId: opened.record.streamId, updates, patches, updateContent, patchElement, streams, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CardRuntimeStatusBridge', () => {
  it('drives text + animated/static image from real runtime status and deduplicates repeats', async () => harness(async ({ bridge, streamId, updates, patches }) => {
    await bridge.bind({
      streamId,
      authority: binding,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
      labels: { working: '正在执行', stalled: '可能卡住' },
    });

    expect(await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'working' })).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      elementId: 'status_badge',
      content: "<text_tag color='blue'>正在执行</text_tag>",
      sequence: 2,
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      elementId: 'loader_img',
      partialElement: { img_key: 'img_active_12345678' },
      sequence: 3,
    });

    expect(await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'working' })).toBe(false);
    expect(updates).toHaveLength(1);
    expect(patches).toHaveLength(1);

    expect(await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'stalled' })).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      content: "<text_tag color='orange'>可能卡住</text_tag>",
      sequence: 4,
    });
    expect(patches.at(-1)).toMatchObject({
      partialElement: { img_key: 'img_inactive_12345678' },
      sequence: 5,
    });
  }));

  it('stops the loader and removes the binding so later screen updates are inert', async () => harness(async ({ bridge, streamId, updates, patches }) => {
    await bridge.bind({
      streamId,
      authority: binding,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
    });
    expect(await bridge.unbind(streamId, binding)).toBe(true);
    expect(patches.at(-1)).toMatchObject({ partialElement: { img_key: 'img_inactive_12345678' } });
    expect(await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'working' })).toBe(false);
    expect(updates).toHaveLength(0);
  }));

  it('removes a stale runtime binding even when the provider rejects the final inactive image patch', async () => harness(async ({ bridge, streamId, updates, patchElement }) => {
    await bridge.bind({
      streamId,
      authority: binding,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
    });
    await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'working' });
    patchElement.mockRejectedValueOnce(new Error('card streaming timeout'));
    await expect(bridge.unbind(streamId, binding)).rejects.toThrow('card streaming timeout');
    expect(await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'idle' })).toBe(false);
    expect(updates).toHaveLength(1);
  }));

  it('coalesces a burst and publishes only the first and newest queued statuses', async () => harness(async ({
    bridge,
    streamId,
    updates,
    updateContent,
  }) => {
    await bridge.bind({
      streamId,
      authority: binding,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
    });
    let markFirstEntered!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { markFirstEntered = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    updateContent.mockImplementationOnce(async input => {
      updates.push(input);
      markFirstEntered();
      await firstGate;
    });

    const first = bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'working' });
    await firstEntered;
    const second = bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'analyzing' });
    const third = bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'limited' });
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(updates.map(update => update.content)).toEqual([
      "<text_tag color='blue'>执行中</text_tag>",
      "<text_tag color='orange'>等待额度</text_tag>",
    ]);
  }));

  it('deletes a stale runtime binding after the stream reaches a terminal state', async () => harness(async ({
    bridge,
    streamId,
    updates,
    streams,
    dir,
  }) => {
    await bridge.bind({
      streamId,
      authority: binding,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
    });
    await streams.finish(streamId, binding, async () => undefined);

    expect(await bridge.publish({
      sessionId: binding.sessionId,
      larkAppId: binding.larkAppId,
      status: 'working',
    })).toBe(false);
    expect(readdirSync(join(dir, 'card-runtime-status')).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(updates).toHaveLength(0);
  }));

  it('moves an existing runtime binding to the replacement stream', async () => harness(async ({ bridge, streamId, updates, streams }) => {
    await bridge.bind({
      streamId,
      authority: binding,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
    });
    const moved = await streams.reanchor(
      streamId,
      binding,
      { ...binding, messageId: 'om_card_2', anchorTurnId: 'turn_2' },
      'card_2',
      async () => undefined,
    );
    expect(await bridge.reanchor(streamId, moved.current.streamId, binding)).toBe(true);
    expect(await bridge.publish({ sessionId: binding.sessionId, larkAppId: binding.larkAppId, status: 'working' })).toBe(true);
    expect(updates.at(-1)).toMatchObject({ cardId: 'card_2', elementId: 'status_badge' });
  }));
});
